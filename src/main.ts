// setup-soldr entry point. Owned by Agent 2.
//
// Replaces the composite action's main-phase steps with a single JS
// orchestrator. Calls the helpers in src/lib/* in the same order the
// composite's steps fire.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import { createLogger } from "./lib/log-utils.js";
import { autoKeyEnabled } from "./lib/ancestor-cache.js";
import { ancestorTelemetry, publishBuildCachePlan, type AncestorTelemetry } from "./lib/ancestor-cache-telemetry.js";
import { planAncestorRestore, planLocalAncestorRestore } from "./lib/ancestor-cache-github.js";
import { cargoConfigHash, shortJsonHash, targetEnvHash, workspaceManifestHash } from "./lib/cache-keys.js";
import { readRawInputs, resolveSetup, applyResolveResult, setupEnabled } from "./lib/resolve-setup.js";
import { bootstrapAssetFor, ensureBootstrap } from "./lib/bootstrap-soldr.js";
import {
  cacheProfileDefault,
  describeCacheProfile,
  isLocalRunner,
  resolveCacheProfileInput,
} from "./lib/local-profile.js";
import {
  markPhase,
  finishPhase,
  setupPhaseSummaryOneLine,
  timeSubPhase,
} from "./lib/phase-timing.js";
import { ensureRustToolchain } from "./lib/ensure-rust-toolchain.js";
import { ensureSoldr } from "./lib/ensure-soldr.js";
import {
  finishLazySetup,
  parseVerdictsInput,
  verdictAfterInstall,
  verdictPreflight,
} from "./lib/verdict-setup.js";
import { verifySoldr } from "./lib/verify-soldr.js";
import { prepareDylint } from "./lib/prepare-dylint.js";
import { installPassthrough } from "./lib/install-passthrough.js";
import { normalizeSourceMtime } from "./lib/normalize-source-mtime.js";
import { detectSharedTargetWarning } from "./lib/detect-shared-target-warning.js";
import { ensureShims } from "./lib/ensure-shims.js";
import { seedZccache } from "./lib/zccache-seed.js";
import { detectCompressMagic, decompressCache } from "./lib/cache-compress.js";
import { restoreCargoRegistryArchive } from "./lib/cargo-registry-archive.js";
import { parseIsolatedSeedTargets, seedIsolatedBuildCache } from "./lib/seed-isolated-cache.js";
import {
  decideSyslibToolCache,
  linkSyslibToolCache,
  SYSLIB_STORE_ENV,
} from "./lib/syslib-tool-cache.js";
import { adoptBundleToolCache } from "./lib/bundle-tool-cache.js";
import { adoptRustupToolCache, publishRustupToolCache, rustupStoreOffReason } from "./lib/rustup-tool-cache.js";
import { StatsCollector } from "./lib/stats-collector.js";
import {
  walkSnapshot,
  diffSnapshots,
  diffStats,
  serializeManifest,
} from "./lib/toolchain-snapshot.js";
import {
  buildSoloCacheKeys,
  detectLibc,
  hashStringArray,
  restoreSoloCache,
  soloCacheArchivePath,
  verifyRestoredToolchain,
  type RootMap as SoloRootMap,
} from "./lib/solo-toolchain-cache.js";
import {
  buildCookBaseCacheKey,
  buildCookCacheKey,
  buildCookDeltaCacheKey,
  buildCookDeltaCacheRestorePrefix,
  decideCookGate,
  hashCookBuildShape,
  hashCookFlags,
  canonicalizeCookFlags,
  loadLayeredCookCache,
  layeredCookBaseReady,
  layeredCookDeltaReady,
  parseCookFlags,
  restoreCookCache,
  restoreLayeredCookCacheArchives,
  selectCookSaveLayer,
  runCook,
  supportsLayeredCookCache,
} from "./lib/cook-cache.js";
import {
  buildMiniCacheKey,
  isEligibleForMiniCache,
  restoreMiniCache,
} from "./lib/soldr-mini-cache.js";
import { dumpDiagnostics, loggingEnabled } from "./lib/diagnostics.js";
import { diagnoseShimBypass } from "./lib/shim-bypass-check.js";
import {
  assertMinimumSoldrVersion,
  decideBlessedPrepareCacheUse,
  executeBlessedPrepare,
  prepareTargetsFor,
  validateBlessedPrepareRestore,
} from "./lib/blessed-cross-prepare.js";
import {
  type TargetLifecycleContract,
  assertTargetOperationSupported,
  buildTargetOperationOutputs,
  buildUniversal2TargetContract,
  mergeTargetEnvironment,
  normalizeTargetPlan,
} from "./lib/target-lifecycle.js";
import {
  replaySourceMtimes,
  readSnapshotFile,
  SNAPSHOT_FILENAME,
} from "./lib/source-mtime-snapshot.js";
import type {
  ActionContext,
  CargoRegistryArchiveFormat,
  ResolveResult,
} from "./lib/types.js";
import {
  YANK_AUDIT_WORKER_ARG,
  readRegistryDependencies,
  runYankAuditWorker,
  writeYankAuditResult,
  type YankAuditWorkerConfig,
} from "./lib/yank-audit.js";

/**
 * Map (hit, matchedKey) → workflow-visible restore-status string.
 * Mirrors post.ts's `RestoreStatus` so both phases emit the same vocabulary
 * for the `<layer>-cache-restore-status` outputs declared in action.yml.
 */
function deriveRestoreStatus(hit: boolean, matchedKey: string): "exact-hit" | "restore-key-hit" | "miss" {
  if (hit) return "exact-hit";
  if (matchedKey.trim()) return "restore-key-hit";
  return "miss";
}

export function shouldSkipCargoRegistryExtractionError(
  err: unknown,
  format: CargoRegistryArchiveFormat,
  onFailure: string | undefined,
): boolean {
  if (format !== "legacy-v1" || onFailure?.trim().toLowerCase() !== "skip") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EAUTHFAIL" || code === "EENCNOKEY";
}

function writeCacheKeysManifest(
  result: ResolveResult,
  runnerTemp: string,
  log: (msg: string) => void,
): void {
  if (!runnerTemp) return;
  const keys = [
    result.setupCache.key,
    result.buildCache.key,
    result.targetCache.key,
    result.cargoRegistryCache.key,
  ].filter((k) => Boolean(k));
  if (keys.length === 0) return;
  const outPath = path.join(runnerTemp, "setup-soldr-cache-keys.txt");
  try {
    fs.writeFileSync(outPath, keys.join("\n") + "\n", "utf8");
    log(`cache-keys manifest written to ${outPath} (${keys.length} keys)`);
  } catch (err) {
    log(`cache-keys manifest write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function isTruthy(value: string | undefined): boolean {
  return TRUTHY.has(((value ?? "").trim().toLowerCase()));
}
function isFalsy(value: string | undefined): boolean {
  return FALSY.has(((value ?? "").trim().toLowerCase()));
}

export function resolveRuntimeCacheFlags(
  cacheInput: string,
  plannedBuildEnabled: boolean,
  miniInput: string,
  soloInput: string,
): { setup: boolean; build: boolean; mini: boolean; solo: boolean } {
  const setup = !isFalsy(cacheInput.trim() || "true");
  return {
    setup,
    build: setup && plannedBuildEnabled,
    mini: setup && !isFalsy(miniInput.trim() || "true"),
    solo: setup && isTruthy(soloInput),
  };
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function queryTargetPlan(
  soldrPath: string,
  target: string,
  log: (message: string) => void,
): Promise<unknown | null> {
  const output = await exec.getExecOutput(soldrPath, ["env", "--target", target, "--json"], {
    silent: true,
    ignoreReturnCode: true,
  });
  if (output.exitCode !== 0) {
    log(`target-plan: soldr env failed with exit ${output.exitCode}`);
    return null;
  }
  const line = output.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    log("target-plan: soldr env returned non-JSON output");
    return null;
  }
}

function publishTargetContract(
  result: ResolveResult,
  contract: TargetLifecycleContract,
  logger: { log: (message: string) => void },
): void {
  const target = result.blessedPrepareCache.target;
  if (!target) return;
  if (!contract.cacheIdentity) throw new Error(`Soldr target plan for ${target} has no cache identity`);
  assertTargetOperationSupported(contract, "prepare");
  result.targetContract = contract;
  const mergedEnvironment = mergeTargetEnvironment(process.env, contract.environment);
  for (const key of Object.keys(contract.environment)) {
    core.exportVariable(key, mergedEnvironment[key] ?? contract.environment[key]);
  }
  const outputs = buildTargetOperationOutputs(result.workspace, contract);
  core.setOutput("target-plan-json", JSON.stringify(contract));
  core.setOutput("target-capabilities-json", JSON.stringify({
    schemaVersion: contract.schemaVersion,
    canonicalTarget: contract.canonicalTarget,
    cacheIdentity: contract.cacheIdentity,
    supportedOperations: contract.supportedOperations,
    toolchain: contract.toolchain,
    platform: contract.platform,
  }));
  core.setOutput("target-env-json", JSON.stringify(contract.environment));
  core.setOutput("target-cache-identity", contract.cacheIdentity);
  core.setOutput("target-artifact-dir", outputs.artifactDirectory);
  core.setOutput("target-build-hook", outputs.build);
  core.setOutput("target-clippy-hook", outputs.clippy);
  core.setOutput("target-test-hook", outputs.testNoRun);
  core.setOutput("target-wheel-hook", outputs.pep517Wheel);
  core.setOutput("target-sdist-hook", outputs.pep517Sdist);
  core.saveState("targetPlanJson", JSON.stringify(contract));
  logger.log(`target-plan: canonical=${contract.canonicalTarget} cache=${contract.cacheIdentity} operations=${contract.supportedOperations.join(",")}`);
}

function dirHasContent(p: string): boolean {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

async function runGitCapture(
  workspace: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await exec.exec("git", ["-C", workspace, ...args], {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => { stdout += data.toString("utf8"); },
      stderr: (data: Buffer) => { stderr += data.toString("utf8"); },
    },
  });
  return { code, stdout, stderr };
}

async function deriveParentSha(
  workspace: string,
  githubSha: string,
  logger: ReturnType<typeof createLogger>,
): Promise<string> {
  // #365: derive parent SHA so cook-cache-delta + target-cache +
  // cargo-registry can fall back to the prior commit's saved
  // entry. Returns "" on any error (no regression from prior
  // behavior — caller treats "" as "no fallback").
  //
  // Strategy: try `git log -1 --format=%P HEAD` first. On a
  // shallow clone (actions/checkout default fetch-depth=1) this
  // returns empty for grafted root commits — fall back to
  // `git cat-file -p HEAD` and parse the `parent` header lines
  // from the raw commit object, which are preserved even when
  // the parent commit object isn't present in the local repo.

  // Pass 1: git log %P (works on full-depth checkouts).
  try {
    const { code, stdout, stderr } = await runGitCapture(workspace, [
      "log", "-1", "--format=%P", "HEAD",
    ]);
    if (code === 0) {
      const first = stdout.trim().split(/\s+/)[0] ?? "";
      if (/^[0-9a-f]{7,40}$/i.test(first)) {
        if (first === githubSha) return "";
        logger.log(`parent-sha: derived ${first.slice(0, 12)} from git log (#365)`);
        return first;
      }
      // empty / unparseable → fall through to cat-file
    } else {
      logger.log(`parent-sha: git log exit=${code} stderr=${stderr.trim().slice(0, 120)}; trying cat-file`);
    }
  } catch (err) {
    logger.log(`parent-sha: git log threw (${err instanceof Error ? err.message : String(err)}); trying cat-file`);
  }

  // Pass 2: git cat-file -p HEAD (works on shallow clones — the
  // commit object's `parent` header is preserved even when the
  // parent commit isn't fetched).
  try {
    const { code, stdout, stderr } = await runGitCapture(workspace, [
      "cat-file", "-p", "HEAD",
    ]);
    if (code !== 0) {
      logger.log(`parent-sha: cat-file exit=${code} stderr=${stderr.trim().slice(0, 120)}; leaving empty`);
      return "";
    }
    // Raw commit object format:
    //   tree <sha>
    //   parent <sha>      ← first parent (mainline)
    //   parent <sha>      ← second parent (only for merges)
    //   author ...
    //   committer ...
    //
    //   <message>
    for (const line of stdout.split("\n")) {
      if (line.startsWith("parent ")) {
        const sha = line.slice("parent ".length).trim();
        if (/^[0-9a-f]{7,40}$/i.test(sha) && sha !== githubSha) {
          logger.log(`parent-sha: derived ${sha.slice(0, 12)} from cat-file (#365, shallow-safe)`);
          return sha;
        }
      }
      if (line === "") break; // header section ended
    }
    logger.log(`parent-sha: cat-file produced no usable parent (root commit?); leaving empty`);
    return "";
  } catch (err) {
    logger.log(`parent-sha: cat-file threw (${err instanceof Error ? err.message : String(err)}); leaving empty`);
    return "";
  }
}

async function buildActionContext(): Promise<ActionContext> {
  const env = process.env;
  const logger = createLogger(env);
  const workspace = env["ACTION_WORKSPACE"]?.trim() || env["GITHUB_WORKSPACE"]?.trim() || process.cwd();
  const runnerTemp = env["RUNNER_TEMP"]?.trim() || path.join(os.tmpdir(), "setup-soldr-runner");
  const runnerOs = env["ACTION_OS"]?.trim() || env["RUNNER_OS"]?.trim() || process.platform;
  const runnerArch = env["ACTION_ARCH"]?.trim() || env["RUNNER_ARCH"]?.trim() || process.arch;
  const githubSha = env["GITHUB_SHA"]?.trim() || "";
  const githubToken = env["GITHUB_TOKEN"]?.trim() || env["INPUT_TOKEN"]?.trim() || "";
  // #365: parentSha enables cook-cache-delta + target-cache + cargo-
  // registry to share entries across consecutive commits. The env
  // override (ACTION_PARENT_SHA) lets a workflow set it explicitly;
  // otherwise we derive it from `git log -1 --format=%P HEAD` so the
  // fallback works out of the box for any repo with non-shallow
  // checkout. Without this, every push-event run had the delta key
  // mismatch the prior save (0% hit rate observed on zccache).
  let parentSha = env["ACTION_PARENT_SHA"]?.trim() || "";
  if (!parentSha && githubSha) {
    parentSha = await deriveParentSha(workspace, githubSha, logger);
  }
  return {
    env: { ...env },
    workspace,
    runnerTemp,
    runnerOs,
    runnerArch,
    githubSha,
    githubToken,
    parentSha,
    logger,
  };
}

function actionRoot(): string {
  const explicit = process.env["GITHUB_ACTION_PATH"]?.trim() || process.env["SETUP_SOLDR_ACTION_ROOT"]?.trim();
  if (explicit) return path.resolve(explicit);
  const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
  return path.resolve(moduleDir, "..");
}

async function restoreCacheSafe(
  paths: string[],
  key: string,
  restoreKeys: string[],
  logger: { log: (msg: string) => void },
): Promise<{ hit: boolean; matchedKey: string }> {
  if (paths.length === 0 || !key) {
    return { hit: false, matchedKey: "" };
  }
  try {
    const matched = await cache.restoreCache(paths, key, restoreKeys);
    return { hit: matched === key, matchedKey: matched ?? "" };
  } catch (err) {
    logger.log(`cache restore failed for key ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "" };
  }
}

export async function run(): Promise<void> {
  const ctx = await buildActionContext();
  const logger = ctx.logger;

  await markPhase("action");

  // ---- resolve ----
  await markPhase("resolve");
  const inputs = readRawInputs(process.env);
  if (setupEnabled(inputs.enable)) {
    let bootstrap: Promise<string> | undefined;
    ctx.getBootstrapSoldr = () => {
      const toolCache = ctx.env["RUNNER_TOOL_CACHE"]?.trim() || path.join(os.homedir(), ".cache", "setup-soldr");
      bootstrap ??= ensureBootstrap(ctx.runnerTemp, bootstrapAssetFor(process.platform, process.arch, detectLibc()), undefined, path.join(toolCache, "bootstrap"), ctx.env["SETUP_SOLDR_BOOTSTRAP_ARCHIVE"]?.trim());
      return bootstrap;
    };
  }
  const result = await resolveSetup(ctx, inputs);
  await applyResolveResult(result);
  await finishPhase("resolve");

  // zackees/ci.yml#227: ACT=true selects the local-runner cache profile
  // (no payload cap, fast zstd). One line so users can see which applied.
  {
    const localRunner = isLocalRunner(process.env);
    logger.log(describeCacheProfile(localRunner, {
      payloadMaxBytes: resolveCacheProfileInput("cache-payload-max-bytes", inputs.cachePayloadMaxBytes, localRunner),
      zstdLevels: {
        target: result.targetCacheCompressLevel,
        toolchain: resolveCacheProfileInput("solo-toolchain-cache-level", inputs.soloToolchainCacheLevel, localRunner),
        cook: cacheProfileDefault("cook-base-zstd-level", localRunner),
      },
    }));
  }

  // Always emit the cache-keys manifest right after resolve so workflow
  // steps that run between main and post (e.g. actions/upload-artifact)
  // can read it. The four keys are fully determined by resolveSetup and
  // never change later in the run.
  writeCacheKeysManifest(result, ctx.runnerTemp, (msg) => logger.log(msg));

  const logging = loggingEnabled(inputs.logging);
  if (logging) {
    dumpDiagnostics({
      phase: "main",
      env: process.env,
      rawInputs: inputs,
      result,
      logger,
      stepSummaryPath: process.env["GITHUB_STEP_SUMMARY"]?.trim() || undefined,
    });
  }

  const dryRun = TRUTHY.has((process.env["SETUP_SOLDR_DRY_RUN"] ?? "").trim().toLowerCase());
  if (dryRun) {
    logger.log("DRY RUN: setup-soldr dry run — skipping cache, install, and verify");
    await finishPhase("action");
    return;
  }

  // Persist resolve state for the post-job step.
  core.saveState("resolveResult", JSON.stringify(result));
  core.saveState("buildCacheMode", result.buildCache.mode);
  core.saveState("logging", logging ? "true" : "false");
  core.saveState("preserveSourceMtimes", isTruthy(inputs.preserveSourceMtimes) ? "true" : "false");

  const statsMode = result.stats;
  const debugMode = result.debugMode;
  const debugLog = debugMode ? (msg: string): void => logger.log(msg) : (): void => undefined;
  const statsCollector = new StatsCollector();
  const dependencyCacheMatchedKeys: string[] = [];

  // ---- source-mtime-normalize ----
  if (isTruthy(inputs.sourceMtimeNormalize)) {
    await normalizeSourceMtime({ workspace: ctx.workspace, enabled: true });
  }

  const cacheFlags = resolveRuntimeCacheFlags(
    inputs.cache, result.buildCache.enabled, inputs.soldrMiniCache, inputs.soloToolchainCache,
  );
  const cacheEnabled = cacheFlags.setup;
  const buildCacheEnabled = cacheFlags.build;
  core.saveState("cacheUmbrellaEnabled", cacheEnabled ? "true" : "false");
  core.saveState("setupCacheEnabled", cacheEnabled && result.setupCache.paths.length > 0 ? "true" : "false");
  core.saveState("setupCacheExactHit", "false");
  core.saveState("setupCacheMatchedKey", "");
  core.saveState("targetCacheEnabled", result.targetCache.enabled ? "true" : "false");
  core.saveState("targetCacheExactHit", "false");
  core.saveState("targetCacheMatchedKey", "");
  core.saveState("buildCacheEnabled", buildCacheEnabled ? "true" : "false");
  core.saveState("buildCacheExactHit", "false");
  core.saveState("buildCacheMatchedKey", "");
  core.saveState("cargoRegistryCacheEnabled", result.cargoRegistryCache.enabled ? "true" : "false");
  core.saveState("cargoRegistryCacheExactHit", "false");
  core.saveState("cargoRegistryCacheMatchedKey", "");
  core.saveState("dylintCacheEnabled", result.dylintCache.enabled ? "true" : "false");
  core.saveState("dylintCacheExactHit", "false");
  core.saveState("dylintCacheMatchedKey", "");
  core.saveState("dylintOutputCacheEnabled", result.dylintCache.outputCacheEnabled ? "true" : "false");
  core.saveState("dylintOutputCacheExactHit", "false");
  core.saveState("dylintOutputCacheMatchedKey", "");
  core.saveState("blessedPrepareCacheEnabled", result.blessedPrepareCache.enabled ? "true" : "false");
  core.saveState("blessedPrepareCacheExactHit", "false");
  core.saveState("blessedPrepareCacheMatchedKey", "");
  core.saveState("blessedPrepareComplete", "false");

  // Plan soldr-mini-cache restore now, but perform the extract inside the
  // install phase. Restoring this layer in the background can rewrite the
  // install dir while later phases spawn PATH tools, which surfaced as Linux
  // ETXTBSY on the warm demo after soldr-cook started invoking soldr earlier.
  const miniEnabled = cacheFlags.mini;
  const miniInstallDir = path.dirname(result.soldrPath);
  const miniArchive = `${miniInstallDir}.tar.zst`;
  let miniHit = false;
  let miniKey = "";
  let miniSkipReason = "";
  let miniRestoreEligible = false;
  if (miniEnabled) {
    const eligibility = isEligibleForMiniCache({
      hasRef: Boolean(result.soldrRef.trim()),
      enable: result.enabled,
      resolvedVersion: result.soldrVersionResolved || result.soldrVersionRequested,
    });
    if (eligibility.eligible) {
      const version = result.soldrVersionResolved.trim() || result.soldrVersionRequested.trim();
      miniKey = buildMiniCacheKey({
        runnerOs: ctx.runnerOs.toLowerCase() || process.platform,
        runnerArch: ctx.runnerArch.toLowerCase() || process.arch,
        libc: detectLibc(),
        soldrVersion: version,
      });
      miniRestoreEligible = true;
      logger.log(`soldr-mini-cache: key=${miniKey} installDir=${miniInstallDir}`);
    } else {
      miniSkipReason = eligibility.reason;
    }
  }

  // The install runs once: in the install phase, or earlier when the
  // verdict preflight needs soldr before the restores (setup-soldr#594).
  let soldrInstalled = false;
  const installSoldr = async (): Promise<void> => {
    if (soldrInstalled) return;
    soldrInstalled = true;
    if (miniRestoreEligible) {
      const miniT0 = Date.now();
      const restore = await restoreMiniCache({
        exactKey: miniKey,
        installDir: miniInstallDir,
        archivePath: miniArchive,
        longWindow: 27,
        debug: debugMode,
        log: (msg) => logger.log(msg),
        warn: (msg) => logger.warning(msg),
        binaryPath: result.soldrPath,
        expectedVersion: result.soldrVersionResolved || result.soldrVersionRequested,
      });
      miniHit = restore.hit;
      statsCollector.record({
        label: "soldr-mini-cache",
        operation: "restore",
        hit: restore.hit,
        key: miniKey,
        matchedKey: restore.matchedKey,
        restoreKeys: [],
        archiveBytes: restore.archiveBytes || null,
        inflatedBytes: null,
        fileCount: null,
        durationMs: Date.now() - miniT0,
        timestamp: new Date().toISOString(),
      });
    } else if (miniSkipReason) {
      logger.log(`soldr-mini-cache: skipped — ${miniSkipReason}`);
    } else if (!miniEnabled) {
      logger.log("soldr-mini-cache: disabled via soldr-mini-cache=false");
    }
    core.saveState("soldrMiniEnabled", miniEnabled ? "true" : "false");
    core.saveState("soldrMiniExactKey", miniKey);
    core.saveState("soldrMiniHit", miniHit ? "true" : "false");
    core.saveState("soldrMiniInstallDir", miniInstallDir);
    core.saveState("soldrMiniArchive", miniArchive);
    if (result.enabled) {
      // On mini-cache hit, ensureSoldr's installedVersion() check sees the
      // restored binary at the expected path with the expected version and
      // short-circuits — no GH fetch.
      await ensureSoldr({ resolveResult: result, githubToken: ctx.githubToken, getBootstrapSoldr: ctx.getBootstrapSoldr });
    } else {
      installPassthrough({
        soldrPath: result.soldrPath,
        isWindows: process.platform === "win32",
        log: (msg) => logger.log(msg),
      });
      logger.warning(
        "setup-soldr: enable=false — installed a passthrough stub at " +
          `${result.soldrPath}. \`soldr <tool> <args>\` will run \`<tool> <args>\` ` +
          "verbatim, and soldr-aware caching/observability is disabled.",
      );
    }
  };

  // ---- verdict preflight (setup-soldr#593/#594, soldr#3894) ----
  await markPhase("verdict-preflight");
  const verdict = await verdictPreflight({
    mode: parseVerdictsInput(inputs.verdicts),
    enabled: result.enabled && cacheEnabled,
    shimsEnabled: result.shimsEnabled,
    workspace: result.workspace,
    soldrPath: result.soldrPath,
    runnerTemp: ctx.runnerTemp,
    installSoldr,
    log: (msg) => logger.log(msg),
  });
  await finishPhase("verdict-preflight");
  if (verdict.lazy) {
    await finishLazySetup({ result, logger });
    await finishPhase("action");
    return;
  }

  // ---- parallel restores ----
  // setup-cache, target-cache, build-cache, and cargo-registry write to
  // disjoint paths and have no inter-dependencies, so they run concurrently.
  // Sequential previously: ~18s on warm runs (setup 0.2s + target 7.7s +
  // build 5s + cargo-registry 5s). Parallel: ~max(those) ≈ 8s. Saves ~10s.
  //
  // Layers that must stay sequential (wired below): solo-toolchain (writes
  // RUSTUP_HOME, must precede ensureRustToolchain), soldr-mini (writes
  // install dir, must precede ensureSoldr), cook (writes target/ and needs
  // the soldr binary). Cargo-registry was previously after-cook — it's been
  // moved into this parallel block because nothing the soldr install path
  // touches depends on its hydrated cargo registry state.
  await markPhase("parallel-restore");
  let setupCacheExactHit = false;
  // Capture target-cache match status so we can skip the redundant cook restore.
  // target-cache (full prior build, ~1.5 GB) contains compiled deps; cook-cache
  // (~2.5 GB inflated) also contains compiled deps. When target-cache matched
  // at the lockfile/shape/toolchain level (exact OR parent-SHA OR lock-prefix
  // fallback), we have target/deps/ already populated with identical content —
  // cook restore would just overwrite. Skipping saves ~5–10 s per warm run.
  // A looser restoreKeyLockfile-only match (different shape) is NOT enough to
  // skip cook, since cook output may differ across shapes.
  let targetCacheMatchedKey = "";

  const setupRestorePromise = (async (): Promise<void> => {
    if (!(cacheEnabled && result.setupCache.paths.length > 0)) return;
    const t0 = Date.now();
    const restore = await restoreCacheSafe(
      result.setupCache.paths,
      result.setupCache.key,
      [result.setupCache.restorePrefix],
      logger,
    );
    setupCacheExactHit = restore.hit;
    core.setOutput("cache-hit", restore.hit ? "true" : "false");
    core.setOutput("cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
    core.setOutput("setup_cache_hit", restore.hit ? "true" : "false");
    core.setOutput("setup_cache_matched_key", restore.matchedKey);
    core.saveState("setupCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("setupCacheMatchedKey", restore.matchedKey);
    // Expose for ensure_rust_toolchain to read via env. Must be visible by
    // the time toolchain phase runs — guaranteed by the Promise.all below.
    process.env["SETUP_SOLDR_SETUP_CACHE_EXACT_HIT"] = restore.hit ? "true" : "false";
    statsCollector.record({
      label: "setup-cache", operation: "restore", hit: restore.hit,
      key: result.setupCache.key, matchedKey: restore.matchedKey,
      restoreKeys: [result.setupCache.restorePrefix],
      archiveBytes: null, inflatedBytes: null, fileCount: null,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });
    if (debugMode) debugLog(`[debug] setup-cache: hit=${restore.hit} matched=${restore.matchedKey || "(none)"}`);
  })();

  const targetRestorePromise = (async (): Promise<void> => {
    if (!result.targetCache.enabled) return;
    const targetPaths = result.targetCache.paths
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (targetPaths.length === 0) return;
    const restoreKeys: string[] = [];
    if (result.targetCache.restoreKeyParent) restoreKeys.push(result.targetCache.restoreKeyParent);
    if (result.targetCache.restoreKeyLock) restoreKeys.push(result.targetCache.restoreKeyLock);
    if (result.targetCache.restoreKeyLockfile) restoreKeys.push(result.targetCache.restoreKeyLockfile);
    const t0 = Date.now();
    const restore = await restoreCacheSafe(targetPaths, result.targetCache.key, restoreKeys, logger);
    core.setOutput("target-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("target-cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
    core.setOutput("target_cache_hit", restore.hit ? "true" : "false");
    core.setOutput("target_cache_matched_key", restore.matchedKey);
    core.saveState("targetCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("targetCacheMatchedKey", restore.matchedKey);
    targetCacheMatchedKey = restore.matchedKey;
    if (restore.matchedKey) dependencyCacheMatchedKeys.push(restore.matchedKey);
    statsCollector.record({
      label: "target-cache", operation: "restore", hit: restore.hit,
      key: result.targetCache.key, matchedKey: restore.matchedKey, restoreKeys,
      archiveBytes: null, inflatedBytes: null, fileCount: null,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });
    if (debugMode) debugLog(`[debug] target-cache: hit=${restore.hit} matched=${restore.matchedKey || "(none)"}`);
  })();

  const buildRestorePromise = (async (): Promise<void> => {
    if (!buildCacheEnabled) return;
    const buildCachePath = result.buildCache.path;
    const archivePath = `${buildCachePath}.tar.zst`;
    const restoreKeys: string[] = [];
    if (result.buildCache.restoreKeyParent) restoreKeys.push(result.buildCache.restoreKeyParent);
    if (result.buildCache.restoreKeyToolchain) restoreKeys.push(result.buildCache.restoreKeyToolchain);
    if (result.buildCache.restoreKeyOsArch) restoreKeys.push(result.buildCache.restoreKeyOsArch);
    const explicitKey = (inputs.key ?? "").trim();
    if (explicitKey && explicitKey !== "auto") {
      if (explicitKey.length > 512 || explicitKey.includes(",")) throw new Error("invalid build-cache key override");
      result.buildCache.key = explicitKey;
      restoreKeys.length = 0;
      core.saveState("resolveResult", JSON.stringify(result));
    }
    const legacyKey = result.buildCache.key;
    let selectedKey = "";
    let localAncestorKey = false;
    let selectionTelemetry: AncestorTelemetry | null = null;
    if (autoKeyEnabled(inputs.key, inputs.autoKey)) {
      try {
        const fine = shortJsonHash({
          legacyKey, mode: result.buildCache.mode,
          profile: result.targetCache.profile, lock: result.targetCache.lockfileHash,
          config: await cargoConfigHash(result.workspace),
          manifests: await workspaceManifestHash(result.workspace),
          targetEnv: targetEnvHash(process.env),
        });
        const local = isLocalRunner(process.env);
        // setup-soldr#575: on a local runner a Cargo.lock change (a version
        // bump) used to leave nothing to restore. Prefix the identity with a
        // lockfile-free family so the newest same-family store is the fallback.
        const family = local ? shortJsonHash({
          jobPrefix: result.buildCache.restoreKeyToolchain, mode: result.buildCache.mode,
          profile: result.targetCache.profile, targetEnv: targetEnvHash(process.env),
        }) : undefined;
        const identity = family === undefined ? fine : `${family}${fine}`;
        const plan = local
          ? await planLocalAncestorRestore({ workspace: result.workspace, identity, family, env: process.env })
          : await planAncestorRestore({ workspace: result.workspace, identity,
            token: ctx.githubToken, env: process.env, trustedWriters: inputs.autoKeyTrustedWriters });
        if (plan.restorePrefix) {
          restoreKeys.unshift(...(plan.familyPrefix ? [plan.restorePrefix, plan.familyPrefix] : [plan.restorePrefix]));
          localAncestorKey = true;
        }
        selectedKey = plan.selection.entry?.key ?? "";
        selectionTelemetry = ancestorTelemetry(identity, plan);
        result.buildCache.key = plan.writeKey;
        core.saveState("resolveResult", JSON.stringify(result));
        core.saveState("ancestorBuildWriter", JSON.stringify({ ...plan.writer, ref: plan.ref }));
        logger.log(`build-cache ancestor: ${plan.selection.reason} key=${selectedKey || "legacy"} cache_id=${plan.selection.entry?.id ?? "none"} identity=${identity} distance=${plan.selection.distance ?? "unknown"} scan_ms=${plan.elapsedMs} api_ms=${plan.apiMs} requests=${plan.requests} rate_limit_remaining=${plan.rateLimitRemaining ?? "unknown"}`);
        await core.summary.addHeading("Build-cache ancestor pilot", 3).addTable([
          ["Choice", "Distance", "Scan ms", "GET requests"],
          [selectedKey || plan.selection.reason, String(plan.selection.distance ?? "unknown"), String(plan.elapsedMs), String(plan.requests)],
        ]).write();
      } catch (error) {
        logger.warning(`build-cache ancestor: legacy fallback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    publishBuildCachePlan(result.buildCache.key, selectionTelemetry, core.setOutput);
    const t0 = Date.now();
    // @actions/cache hashes the `paths` array into a "version" key — save and
    // restore MUST pass the same array or the lookup misses even when the
    // entry exists. post.ts saves `[archivePath]` (just the .tar.zst), so
    // restore must use the same single-path array. The decompression below
    // unpacks archivePath → buildCachePath afterwards.
    let restore = await restoreCacheSafe(
      [archivePath],
      selectedKey || (localAncestorKey ? result.buildCache.key : legacyKey),
      selectedKey ? [] : restoreKeys,
      logger,
    );
    if (selectedKey && restore.matchedKey !== selectedKey) {
      restore = await restoreCacheSafe([archivePath], legacyKey, restoreKeys, logger);
    }
    // A donor hit is a starting point; only this source's exact write key may
    // suppress a post-phase save under the existing delta/CACHE-008 gates.
    restore.hit = restore.matchedKey === result.buildCache.key;
    let buildArchiveBytes: number | null = null;
    let buildInflatedBytes: number | null = null;
    let buildFileCount: number | null = null;
    if (restore.matchedKey) {
      try {
        buildArchiveBytes = fs.statSync(archivePath).size;
      } catch {
        buildArchiveBytes = 0;
      }
      if (buildArchiveBytes === 0) {
        logger.warning(
          `build-cache: matched key ${restore.matchedKey} produced an unusable payload: ` +
          `archive=0B; treating as miss`,
        );
        restore = { hit: false, matchedKey: "" };
      }
    }
    if (restore.matchedKey && fileExists(archivePath)) {
      const magic = await detectCompressMagic(archivePath);
      const haveEncryptKey = (process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] ?? "").trim().length > 0;
      if (magic === "zstd" || magic === "gzip" || haveEncryptKey) {
        try {
          const dr = await decompressCache({
            archivePath,
            targetDir: buildCachePath,
            debug: debugMode,
            log: debugLog,
            cacheKey: restore.matchedKey || result.buildCache.key,
          });
          buildArchiveBytes = dr.archiveBytes;
          buildInflatedBytes = dr.inflatedBytes;
          buildFileCount = dr.fileCount;
          if (dr.fileCount === 0) {
            logger.warning(
              `build-cache: matched key ${restore.matchedKey} produced an unusable payload: ` +
              `archive=${dr.archiveBytes}B extracted_files=0 extracted_bytes=${dr.inflatedBytes}; treating as miss`,
            );
            restore = { hit: false, matchedKey: "" };
          }
        } catch (err) {
          logger.warning(
            `build-cache: matched key ${restore.matchedKey} produced an unusable payload: ` +
            `archive=${buildArchiveBytes ?? 0}B decompress failed: ${err instanceof Error ? err.message : String(err)}; treating as miss`,
          );
          restore = { hit: false, matchedKey: "" };
        }
      } else {
        logger.warning(
          `build-cache: matched key ${restore.matchedKey} produced an unusable payload: ` +
          `archive=${buildArchiveBytes ?? 0}B codec=unknown; treating as miss`,
        );
        restore = { hit: false, matchedKey: "" };
      }
    }
    core.setOutput("build-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("build-cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
    core.setOutput("build_cache_hit", restore.hit ? "true" : "false");
    core.setOutput("build_cache_matched_key", restore.matchedKey);
    core.setOutput("build-cache-matched-key", restore.matchedKey);
    core.saveState("buildCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("buildCacheMatchedKey", restore.matchedKey);
    // setup-soldr#573: post counts front-door history written after this.
    core.saveState("buildCacheBaselineMs", String(Date.now()));
    if (restore.matchedKey) dependencyCacheMatchedKeys.push(restore.matchedKey);
    // Source-mtime replay (preserve-source-mtimes opt-in). post.ts dropped
    // a `setup-soldr-source-mtimes.json` sidecar inside the build-cache
    // dir on the cold side; if it's present after decompress, walk it and
    // set each matching source file's mtime to what cold saw. The replay
    // is gated by (size, content-hash) match so we never overwrite a
    // genuinely modified file's mtime — that would underbuild.
    if (isTruthy(inputs.preserveSourceMtimes) && restore.hit) {
      const snapshotPath = path.join(buildCachePath, SNAPSHOT_FILENAME);
      const snapshot = readSnapshotFile(snapshotPath);
      if (snapshot) {
        const rt0 = Date.now();
        try {
          // Match the project-root selection that post.ts uses when
          // writing the snapshot — the parent of the resolved target-dir,
          // not the (outer) GITHUB_WORKSPACE.
          const projectRoot = path.dirname(result.targetCache.targetPath);
          const rr = await replaySourceMtimes({
            workspace: projectRoot,
            snapshot,
            log: (msg) => logger.log(msg),
          });
          logger.log(
            `source-mtime-replay: applied=${rr.applied} skipped_missing=${rr.skipped_missing} ` +
              `skipped_modified=${rr.skipped_modified} skipped_size_mismatch=${rr.skipped_size_mismatch} ` +
              `total=${rr.total} elapsed_ms=${Date.now() - rt0}`,
          );
        } catch (err) {
          logger.log(
            `source-mtime-replay: failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        logger.log(`source-mtime-replay: snapshot file not found at ${snapshotPath}, skipping`);
      }
    }
    statsCollector.record({
      label: "build-cache", operation: "restore", hit: restore.hit,
      key: result.buildCache.key, matchedKey: restore.matchedKey, restoreKeys,
      archiveBytes: buildArchiveBytes, inflatedBytes: buildInflatedBytes, fileCount: buildFileCount,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });

    // Seed an isolated SOLDR_CACHE_DIR from the just-restored build-cache
    // artifact store (issue #240). Opt-in: only fires when the consumer
    // declares the isolated root(s) it switches its self-test phase to, so a
    // daemon-isolated coverage/integration phase starts warm instead of cold.
    const seedTargets = parseIsolatedSeedTargets(inputs.seedIsolatedBuildCache);
    if (seedTargets.length > 0) {
      try {
        seedIsolatedBuildCache({
          sourceZccacheDir: buildCachePath,
          targetSoldrRoots: seedTargets,
          log: (msg) => logger.log(msg),
        });
      } catch (err) {
        logger.log(
          `seed-isolated-build-cache: failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  })();

  let cargoRegistryDownload: {
    hit: boolean;
    matchedKey: string;
    startedMs: number;
  } | null = null;
  // Download only. Archive extraction is deliberately deferred until after
  // ensureSoldr() + runtime verification because soldr-v2 needs the installed
  // binary and must never race its setup-cache/mini-cache restore.
  const cargoRegistryRestorePromise = (async (): Promise<void> => {
    if (!result.cargoRegistryCache.enabled) return;
    const t0 = Date.now();
    const restore = await restoreCacheSafe(
      result.cargoRegistryCache.archive.restorePaths,
      result.cargoRegistryCache.key,
      [result.cargoRegistryCache.restorePrefix],
      logger,
    );
    core.setOutput("cargo-registry-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("cargo_registry_cache_hit", restore.hit ? "true" : "false");
    core.saveState("cargoRegistryCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("cargoRegistryCacheMatchedKey", restore.matchedKey);
    cargoRegistryDownload = { hit: restore.hit, matchedKey: restore.matchedKey, startedMs: t0 };
  })();

  const blessedPrepareRestorePromise = (async (): Promise<void> => {
    const plan = result.blessedPrepareCache;
    if (!plan.enabled) return;
    const t0 = Date.now();
    const restored = await restoreCacheSafe(plan.archivePaths, plan.key, plan.restoreKeys, logger);
    const restore = validateBlessedPrepareRestore({
      ...restored,
      archivePaths: plan.archivePaths,
      warn: (message) => logger.warning(message),
    });
    core.saveState("blessedPrepareCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("blessedPrepareCacheMatchedKey", restore.matchedKey);
    core.setOutput("blessed-prepare-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("blessed-prepare-cache-key", plan.key);
    statsCollector.record({
      label: "blessed-prepare-cache", operation: "restore", hit: restore.hit,
      key: plan.key, matchedKey: restore.matchedKey, restoreKeys: plan.restoreKeys,
      archiveBytes: restore.archiveBytes, inflatedBytes: null, fileCount: null,
      durationMs: Date.now() - t0, timestamp: new Date().toISOString(),
    });
  })();

  const dylintRestorePromise = (async (): Promise<void> => {
    if (!result.dylintCache.enabled) return;
    const t0 = Date.now();
    const restore = await restoreCacheSafe(
      result.dylintCache.paths,
      result.dylintCache.key,
      [],
      logger,
    );
    core.setOutput("dylint-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("dylint-cache-restore-status", deriveRestoreStatus(restore.hit, restore.matchedKey));
    core.setOutput("dylint_cache_hit", restore.hit ? "true" : "false");
    core.setOutput("dylint_cache_matched_key", restore.matchedKey);
    core.exportVariable("SETUP_SOLDR_DYLINT_CACHE_HIT", restore.hit ? "true" : "false");
    core.exportVariable("SETUP_SOLDR_DYLINT_CACHE_MATCHED_KEY", restore.matchedKey);
    core.saveState("dylintCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("dylintCacheMatchedKey", restore.matchedKey);
    statsCollector.record({
      label: "dylint-cache",
      operation: "restore",
      hit: restore.hit,
      key: result.dylintCache.key,
      matchedKey: restore.matchedKey,
      restoreKeys: [],
      archiveBytes: null,
      inflatedBytes: null,
      fileCount: null,
      durationMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
    logger.log(
      `dylint-cache: key=${result.dylintCache.key} hit=${restore.hit} matched=${restore.matchedKey || "(none)"}`,
    );
  })();

  const dylintOutputRestorePromise = (async (): Promise<void> => {
    if (!result.dylintCache.outputCacheEnabled || result.dylintCache.outputPaths.length === 0) {
      return;
    }
    const t0 = Date.now();
    // setup-soldr#540 / ci.yml#1: restore via the exact (per-Cargo.lock-
    // generation) key first, falling back to `outputRestoreKeys` (same
    // toolchain + lint-library identity, any prior Cargo.lock generation)
    // on a miss. `restore.hit` is only true on an EXACT match (see
    // `restoreCacheSafe`), so a restore-keys fallback still leaves
    // `dylintOutputCacheExactHit=false` and the post step still saves a
    // fresh entry under the new exact key.
    const restore = await restoreCacheSafe(
      result.dylintCache.outputPaths,
      result.dylintCache.outputKey,
      result.dylintCache.outputRestoreKeys,
      logger,
    );
    core.setOutput("dylint-output-cache-hit", restore.hit ? "true" : "false");
    core.setOutput(
      "dylint-output-cache-restore-status",
      deriveRestoreStatus(restore.hit, restore.matchedKey),
    );
    core.saveState("dylintOutputCacheExactHit", restore.hit ? "true" : "false");
    core.saveState("dylintOutputCacheMatchedKey", restore.matchedKey);
    statsCollector.record({
      label: "dylint-output-cache",
      operation: "restore",
      hit: restore.hit,
      key: result.dylintCache.outputKey,
      matchedKey: restore.matchedKey,
      restoreKeys: result.dylintCache.outputRestoreKeys,
      archiveBytes: null,
      inflatedBytes: null,
      fileCount: null,
      durationMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
    logger.log(
      `dylint-output-cache: key=${result.dylintCache.outputKey} hit=${restore.hit} matched=${restore.matchedKey || "(none)"}`,
    );
  })();

  // Promise.all — each IIFE wraps its own errors via restoreCacheSafe and
  // try/catches, so this should only see rejections for genuine programming
  // bugs.
  await Promise.all([
    setupRestorePromise,
    targetRestorePromise,
    buildRestorePromise,
    cargoRegistryRestorePromise,
    blessedPrepareRestorePromise,
    dylintRestorePromise,
    dylintOutputRestorePromise,
  ]);
  await finishPhase("parallel-restore");

  // ---- syslib store in RUNNER_TOOL_CACHE (#553) ----
  // After setup-cache restore (which may bring back a real bin/syslib dir,
  // kept as-is) and before any soldr spawn that could install a syslib.
  if (result.enabled && cacheEnabled) {
    const syslibDecision = decideSyslibToolCache({
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      crossPrepareTarget: result.blessedPrepareCache.target,
    });
    if (syslibDecision.enabled) {
      try {
        const linked = linkSyslibToolCache({
          soldrBinDir: result.soldrBinCachePath,
          store: syslibDecision.store,
        });
        if (linked.status !== "kept-existing-dir") {
          core.exportVariable(SYSLIB_STORE_ENV, linked.store);
        }
        logger.log(
          `syslib-tool-cache: ${linked.status} ${linked.syslibDir} -> ${linked.store} (${syslibDecision.reason})`,
        );
      } catch (err) {
        // Best-effort: without the link soldr downloads into RUNNER_TEMP as before.
        core.warning(`syslib-tool-cache: could not link ${syslibDecision.store}: ${(err as Error).message}`);
      }
    } else if (debugMode) {
      debugLog(`[debug] syslib-tool-cache: off (${syslibDecision.reason})`);
    }
  }

  // ---- soldr tool bundles in RUNNER_TOOL_CACHE (#557) ----
  // Link stamped installs (LLVM, ...) a previous run published, before the
  // verify step's first `soldr cargo` would fetch LLVM again. post.ts
  // publishes what this job installed.
  const storeLogger = {
    log: (msg: string) => logger.log(msg),
    warn: (msg: string) => core.warning(msg),
    debug: (msg: string) => debugLog(`[debug] ${msg}`),
  };
  if (result.enabled && cacheEnabled) {
    adoptBundleToolCache({
      env: process.env,
      soldrBinDir: result.soldrBinCachePath,
      crossPrepareTarget: result.blessedPrepareCache.target,
      logger: storeLogger,
    });
  }

  // ---- target-tree-cache (full mode) ----
  // The bundle path is included in target-cache restore paths above when full
  // mode is requested, so there's no separate restore here. We keep the phase
  // marker for parity with the composite step ordering.
  await markPhase("target-tree");
  await finishPhase("target-tree");

  // Kick off cook restore in the background. It overlaps with the
  // sequential toolchain + soldr install + shims + verify steps that
  // follow. By the time the cook phase runs, the restore is done — we
  // just await the promise. Saves ~5–7 s of warm-build wall clock.
  //
  // Why this is safe (vs the disastrous PR #145 which added cook to the
  // BIG parallel block): cook now races with SMALL ops (rust install
  // ~1–2 s, soldr install ~2–3 s, shims/verify ~1–2 s). Those don't
  // contend on disk write bandwidth the way target/build/cargo-registry
  // restores did. Cook's 2.5 GB tar write becomes the long pole and
  // hides behind the small ops.
  //
  // SAFETY: when target-cache writes to target/ (build-cache-mode: full),
  // cook restore would race with target-cache restore on the same dir.
  // The parallel-restore block above already finished target-cache, but
  // we still want a runtime gate just in case the mode changes.
  const cookGate = decideCookGate({
    prebuildDeps: inputs.prebuildDeps,
    cacheUmbrella: cacheEnabled,
    lockfilePath: result.targetCache.lockfilePath,
  });
  const cookActive = cookGate.enabled && result.enabled;
  let cookFlags: string[] = [];
  let cookKey = "";
  let cookBaseKey = "";
  let cookDeltaKey = "";
  let cookDeltaParentKey = "";
  let cookDeltaRestoreKeys: string[] = [];
  let cookProjectRoot = "";
  let cookTargetDir = "";
  let cookArchive = "";
  let cookBaseArchive = "";
  let cookDeltaArchive = "";
  let cookBaseManifest = "";
  let cookLayered = false;
  let cookDeltaEnabled = false;
  core.setOutput("cook-cache-hit", "false");
  core.setOutput("cook-cache-base-hit", "false");
  core.setOutput("cook-cache-delta-hit", "false");
  core.setOutput("cook-cache-status", cookActive ? "miss" : "disabled");
  core.setOutput("cook-cache-load-report-json", "{}");
  let cookRestoreT0 = Date.now();
  let cookRestorePromise: Promise<{ hit: boolean; matchedKey: string; archiveBytes: number }> | null = null;
  let cookLayeredRestorePromise: ReturnType<typeof restoreLayeredCookCacheArchives> | null = null;
  // Skip cook restore when target-cache matched at the lockfile/shape level.
  // restoreKeyLock = `${prefix}-${targetInputsHash}-${suffix}-` where
  // targetInputsHash = sha256(toolchain, lockfile, manifest, shape). A
  // matchedKey starting with restoreKeyLock means the cached entry was built
  // with the same toolchain + lockfile + shape — its target/deps/ matches
  // what cook would restore. Covers:
  //   - exact hit  (matchedKey === current key, also startsWith restoreKeyLock)
  //   - parent-SHA hit (matchedKey === restoreKeyParent, also startsWith)
  //   - lock-prefix fallback (any saved entry with same lockfile+shape)
  // Does NOT cover restoreKeyLockfile fallback (shorter prefix that drops
  // shape) — different shape may mean different cook output, so cook still
  // runs there as the safety net.
  const targetCacheLockMatch =
    !!targetCacheMatchedKey &&
    !!result.targetCache.restoreKeyLock &&
    targetCacheMatchedKey.startsWith(result.targetCache.restoreKeyLock);
  const cookSkippedDueToTargetHit = cookActive && targetCacheLockMatch;
  if (cookActive && !cookSkippedDueToTargetHit) {
    cookFlags = canonicalizeCookFlags(parseCookFlags(inputs.prebuildDepsFlags));
    const flagsHash = hashCookFlags(cookFlags);
    const lockHash = result.targetCache.lockfileHash || "no-lock";
    const cookKeyParts = {
      runnerOs: ctx.runnerOs.toLowerCase() || process.platform,
      runnerArch: ctx.runnerArch.toLowerCase() || process.arch,
      libc: detectLibc(),
      rustcRelease: result.toolchain.cacheChannel.trim() || result.toolchain.channel.trim(),
      flagsHash,
      lockHash,
      soldrVersion:
        result.soldrSourceIdentity.trim() ||
        result.soldrVersionResolved.trim() ||
        result.soldrVersionRequested.trim() ||
        "unset",
      keySuffix: inputs.cacheKeySuffix.trim(),
    };
    cookProjectRoot = path.dirname(result.targetCache.targetPath);
    cookTargetDir = result.targetCache.targetPath;
    cookRestoreT0 = Date.now();
    const deltaInput = inputs.prebuildDepsDeltaCache.trim() || "true";
    const deltaRequested = !isFalsy(deltaInput);
    const soldrVersionForCook =
      result.soldrVersionResolved.trim() || result.soldrVersionRequested.trim();
    cookLayered = deltaRequested && supportsLayeredCookCache(soldrVersionForCook);
    // #528: the delta layer is opt-in; the base layer is unaffected.
    cookDeltaEnabled = isTruthy(inputs.cookDelta.trim() || "false");
    if (cookLayered) {
      const shapeHash = hashCookBuildShape(result.targetCache.restoreKeyLock || result.targetCache.key);
      cookBaseKey = buildCookBaseCacheKey(cookKeyParts);
      cookDeltaKey = buildCookDeltaCacheKey({
        ...cookKeyParts,
        buildShapeHash: shapeHash,
        githubSha: ctx.githubSha || "nosha",
      });
      if (ctx.parentSha && ctx.parentSha !== ctx.githubSha) {
        cookDeltaParentKey = buildCookDeltaCacheKey({
          ...cookKeyParts,
          buildShapeHash: shapeHash,
          githubSha: ctx.parentSha,
        });
      }
      cookDeltaRestoreKeys = cookDeltaParentKey ? [cookDeltaParentKey] : [];
      cookDeltaRestoreKeys.push(
        buildCookDeltaCacheRestorePrefix({
          ...cookKeyParts,
          buildShapeHash: shapeHash,
        }),
      );
      cookBaseArchive = `${cookTargetDir}.soldr-base.tar.zst`;
      cookDeltaArchive = `${cookTargetDir}.soldr-delta.tar.zst`;
      cookBaseManifest = `${cookTargetDir}.soldr-base-manifest.pb`;
      logger.log(
        `cook: layered keys base=${cookBaseKey} delta=${cookDeltaKey}` +
          (cookDeltaParentKey ? ` delta-fallback=${cookDeltaParentKey}` : ` (no parent-fallback — parentSha unavailable, #365)`) +
          ` delta-prefix=${cookDeltaRestoreKeys.at(-1)}` +
          ` cook-delta=${cookDeltaEnabled ? "true" : "false"}` +
          ` starting archive restore concurrent with install`,
      );
      cookLayeredRestorePromise = restoreLayeredCookCacheArchives({
        baseKey: cookBaseKey,
        deltaKey: cookDeltaKey,
        deltaRestoreKeys: cookDeltaRestoreKeys,
        baseArchivePath: cookBaseArchive,
        deltaArchivePath: cookDeltaArchive,
        deltaEnabled: cookDeltaEnabled,
        log: (msg) => logger.log(msg),
        warn: (msg) => logger.warning(msg),
      });
    } else {
      if (deltaRequested) {
        logger.log(
          `cook: layered cache requires soldr >=0.7.38; ` +
            `version=${soldrVersionForCook || "unknown"} falling back to legacy cook cache`,
        );
      } else {
        logger.log("cook: layered cache disabled via prebuild-deps-delta-cache=false");
      }
      cookKey = buildCookCacheKey(cookKeyParts);
      cookArchive = `${cookTargetDir}.tar.zst`;
      logger.log(`cook: key=${cookKey} starting background restore concurrent with install`);
      cookRestorePromise = restoreCookCache({
        exactKey: cookKey,
        archivePath: cookArchive,
        targetDir: cookTargetDir,
        longWindow: 27,
        debug: debugMode,
        log: (msg) => logger.log(msg),
        warn: (msg) => logger.warning(msg),
      });
    }
  }

  // ---- toolchain ----
  // When solo-toolchain-cache is on, snapshot $RUSTUP_HOME/toolchains/ +
  // $CARGO_HOME/bin/ around the toolchain install so we can see which
  // inodes setup-soldr added on top of the runner image. A third
  // snapshot is taken *before* the cache restore so the saved tarball
  // captures the full above-runner state — not just the post-restore
  // delta. See CLAUDE.md "Detect-then-cache" + "Cache-lifetime axis".
  // With the cache off nothing reads the snapshots, so none are taken
  // and nothing is written: on images with a populated RUSTUP_HOME each
  // walk costs 5-16 s (#525 T8/E7).
  await markPhase("toolchain");
  const snapshotRoots = [
    path.join(result.rustupHome, "toolchains"),
    path.join(result.cargoHome, "bin"),
  ];
  const soloRootMap: SoloRootMap = {
    "rustup-toolchains": snapshotRoots[0] as string,
    "cargo-bin": snapshotRoots[1] as string,
  };
  const soloEnabled = cacheFlags.solo;
  // #310: default-changed from "19" → "9". Measured first-save cost
  // dropped from ~104s → ~12s on 140 MB toolchain delta; restore stays
  // bandwidth-bound either way.
  // Empty input -> runner profile default (GitHub 9, local/ACT 1).
  const soloLevel = resolveCacheProfileInput(
    "solo-toolchain-cache-level",
    inputs.soloToolchainCacheLevel,
    isLocalRunner(process.env),
  );
  let soloKeys: ReturnType<typeof buildSoloCacheKeys> | null = null;
  let soloMatchedKey = "";
  let soloExactHit = false;
  let forceToolchainRepair = false;
  let soloRestoreInvalid = false;
  let soloRestoredBytes = 0;
  // Pre-restore snapshot — only needed when solo cache is enabled, so
  // we can compute the full save-diff (post-install vs runner-image,
  // not vs post-restore baseline). (#302: timed as sub-phase.)
  const preRestoreSnapshot = soloEnabled
    ? await timeSubPhase("toolchain", "snapshot-pre", () => walkSnapshot(snapshotRoots))
    : null;
  if (soloEnabled) {
    soloKeys = buildSoloCacheKeys({
      runnerOs: ctx.runnerOs.toLowerCase() || process.platform,
      runnerArch: ctx.runnerArch.toLowerCase() || process.arch,
      libc: detectLibc(),
      rustcRelease: result.toolchain.cacheChannel.trim() || result.toolchain.channel.trim(),
      componentsHash: hashStringArray(result.toolchain.components),
      targetsHash: hashStringArray(result.toolchain.targets),
      soldrVersion: result.soldrVersionResolved.trim() || result.soldrVersionRequested.trim() || "unset",
    });
    logger.log(`solo-toolchain-cache: key=${soloKeys.exact}`);
    const restoreT0 = Date.now();
    const stagingDir = path.join(ctx.runnerTemp, "setup-soldr-solo-cache");
    const restored = await timeSubPhase("toolchain", "solo-restore", () =>
      restoreSoloCache({
        keys: soloKeys!,
        rootMap: soloRootMap,
        stagingDir,
        log: (msg) => logger.log(msg),
        // #316 follow-up: pass canonical archive path explicitly so
        // save and restore agree regardless of stagingDir layout.
        cacheArchivePath: soloCacheArchivePath(ctx.runnerTemp),
      }),
    );
    soloMatchedKey = restored.matchedKey;
    soloRestoredBytes = restored.restoredBytes;
    let verifiedMatch = true;
    if (restored.verified && restored.matchedKey) {
      const expected = result.toolchain.cacheChannel.trim();
      // The rustup home is set up so `rustc` will resolve through the
      // restored toolchain dir. Use `rustc` from PATH (rustup shim) or
      // the cargo bin one.
      const rustcCmd = process.platform === "win32" ? "rustc.exe" : "rustc";
      const verify = await verifyRestoredToolchain({
        expectedRelease: expected,
        expectedTargets: result.toolchain.targets,
        expectedComponents: result.toolchain.components,
        channel: result.toolchain.channel,
        rustupCommand: process.platform === "win32" ? "rustup.exe" : "rustup",
        bootstrapSoldr: await ctx.getBootstrapSoldr?.(),
        allowUnmanagedProbe: !result.enabled,
        log: (msg) => logger.log(msg),
      });
      verifiedMatch = verify.match;
    }
    soloRestoreInvalid = Boolean(restored.matchedKey) && (!restored.verified || !verifiedMatch);
    forceToolchainRepair = soloRestoreInvalid;
    if (soloRestoreInvalid) {
      core.warning(
        `solo-toolchain-cache: restored entry failed validation; key=${restored.matchedKey} ` +
          `archive=${restored.restoredBytes}B. The requested toolchain and targets will be repaired, ` +
          `then the poisoned cache entry will be deleted and replaced (#473).`,
      );
    }
    soloExactHit = restored.hit && restored.verified && verifiedMatch;
    core.saveState("soloToolchainEnabled", "true");
    core.saveState("soloToolchainExactKey", soloKeys.exact);
    core.saveState("soloToolchainMatchedKey", soloMatchedKey);
    core.saveState("soloToolchainExactHit", soloExactHit ? "true" : "false");
    core.saveState("soloToolchainRestoreInvalid", soloRestoreInvalid ? "true" : "false");
    core.saveState("soloToolchainInvalidMatchedKey", soloRestoreInvalid ? soloMatchedKey : "");
    core.saveState("soloToolchainRestoredBytes", String(soloRestoredBytes));
    core.saveState("soloToolchainLevel", soloLevel);
    statsCollector.record({
      label: "solo-toolchain-cache",
      operation: "restore",
      hit: soloExactHit,
      key: soloKeys.exact,
      matchedKey: soloMatchedKey,
      restoreKeys: soloKeys.fallbacks,
      archiveBytes: restored.restoredBytes || null,
      inflatedBytes: null,
      fileCount: null,
      durationMs: Date.now() - restoreT0,
      timestamp: new Date().toISOString(),
    });
  } else {
    core.saveState("soloToolchainEnabled", "false");
    core.saveState("soloToolchainRestoreInvalid", "false");
  }
  const baselineSnapshot = soloEnabled
    ? await timeSubPhase("toolchain", "snapshot-base", () => walkSnapshot(snapshotRoots))
    : null;
  // #323: when solo-cache exact-hit AND verifyRestoredToolchain
  // passed, the requested toolchain is already on disk from the
  // restore. `rustup toolchain install` would be a no-op but still
  // costs ~8s on hosted runners (self-update check, metadata fetch,
  // profile diff). Skip the install entirely on the verified
  // exact-hit path. The snapshot still runs so cache-save logic
  // downstream sees an unchanged tree (install-delta empty).
  if (soloExactHit) {
    logger.log(
      "toolchain: solo-cache exact-hit + verified — skipping rustup install (#323)",
    );
    // The restored tree is already valid, but the skipped installer is also
    // where ensureRustToolchain normally exports the selected channel. Keep
    // cache-hit jobs explicit so rustup proxies used by later probes never
    // depend on a runner-global default toolchain.
    core.exportVariable("RUSTUP_TOOLCHAIN", result.toolchain.channel);
    process.env["RUSTUP_TOOLCHAIN"] = result.toolchain.channel;
  } else {
    // #557: on act/self-hosted runners, reuse the toolchain a previous run
    // kept in RUNNER_TOOL_CACHE instead of reinstalling it every job.
    const rustupStore = cacheEnabled ? adoptRustupToolCache({
      env: process.env,
      rustupHome: result.rustupHome,
      request: {
        channel: result.toolchain.channel.trim(),
        profile: result.toolchain.profile.trim() || "minimal",
        components: result.toolchain.components,
        targets: result.toolchain.targets,
      },
      offReason: rustupStoreOffReason({
        strategy: result.rustupStrategy,
        soloToolchainCache: soloEnabled,
        dylint: result.dylintCache.cacheIdentity !== "",
        channel: result.toolchain.channel,
      }),
      logger: storeLogger,
    }) : null;
    await timeSubPhase("toolchain", "rustup-install", async () =>
      ensureRustToolchain({
        resolveResult: result,
        setupCacheExactHit,
        bootstrapSoldr: await ctx.getBootstrapSoldr?.(),
        forceRepair: forceToolchainRepair,
      }),
    );
    if (rustupStore) publishRustupToolCache({ rustupHome: result.rustupHome, plan: rustupStore, logger: storeLogger });
    if (forceToolchainRepair) {
      const repaired = await verifyRestoredToolchain({
        expectedRelease: result.toolchain.cacheChannel.trim(),
        expectedTargets: result.toolchain.targets,
        expectedComponents: result.toolchain.components,
        channel: result.toolchain.channel,
        rustupCommand: process.platform === "win32" ? "rustup.exe" : "rustup",
        bootstrapSoldr: await ctx.getBootstrapSoldr?.(),
        allowUnmanagedProbe: !result.enabled,
        log: (msg) => logger.log(msg),
      });
      if (!repaired.match) {
        throw new Error(
          `solo-toolchain-cache: repair did not restore the requested toolchain and targets for key=${soloMatchedKey}`,
        );
      }
      logger.log(`solo-toolchain-cache: repaired toolchain and requested targets verified for key=${soloMatchedKey}`);
    }
  }
  if (soloEnabled && preRestoreSnapshot && baselineSnapshot) {
    const postInstallSnapshot = await timeSubPhase("toolchain", "snapshot-post", () =>
      walkSnapshot(snapshotRoots),
    );
    const toolchainDiff = diffSnapshots(baselineSnapshot, postInstallSnapshot);
    const toolchainDiffStats = diffStats(toolchainDiff);
    // Also compute the save-diff (post-install vs pre-restore) so post.ts
    // has the full above-runner manifest to tar.
    if (ctx.runnerTemp) {
      const saveDiff = diffSnapshots(preRestoreSnapshot, postInstallSnapshot);
      const saveDiffStats = diffStats(saveDiff);
      const saveDiffPath = path.join(ctx.runnerTemp, "setup-soldr-solo-save-diff.json");
      try {
        await fs.promises.writeFile(
          saveDiffPath,
          serializeManifest(saveDiff, saveDiffStats),
          "utf8",
        );
        core.saveState("soloToolchainSaveDiffPath", saveDiffPath);
        core.saveState("soloToolchainIncrementalEmpty", toolchainDiff.added.length === 0 ? "true" : "false");
        logger.log(
          `solo-toolchain-cache: save-diff added=${saveDiffStats.addedFiles} files (${
            saveDiffStats.addedBytes < 1024 * 1024
              ? `${(saveDiffStats.addedBytes / 1024).toFixed(1)}KB`
              : `${(saveDiffStats.addedBytes / 1024 / 1024).toFixed(1)}MB`
          }) ` +
            `incremental-empty=${toolchainDiff.added.length === 0}`,
        );
      } catch (err) {
        logger.log(
          `solo-toolchain-cache: save-diff write failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const fmtMB = (bytes: number): string =>
      bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    logger.log(
      `toolchain-snapshot: added=${toolchainDiffStats.addedFiles} files (${fmtMB(toolchainDiffStats.addedBytes)}) ` +
        `changed=${toolchainDiffStats.changedFiles} removed=${toolchainDiffStats.removedFiles}`,
    );
    if (ctx.runnerTemp) {
      const manifestPath = path.join(ctx.runnerTemp, "setup-soldr-toolchain-diff.json");
      try {
        await fs.promises.writeFile(
          manifestPath,
          serializeManifest(toolchainDiff, toolchainDiffStats),
          "utf8",
        );
        logger.log(`toolchain-snapshot: manifest at ${manifestPath}`);
      } catch (err) {
        logger.log(
          `toolchain-snapshot: manifest write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    logger.log("toolchain: solo-toolchain-cache off — skipping toolchain snapshots (#525)");
  }
  await finishPhase("toolchain");

  // ---- install soldr ----
  // Restore soldr-mini-cache synchronously so the install dir is quiescent
  // before ensureSoldr's installedVersion() check or any later soldr spawn.
  await markPhase("install");
  await installSoldr();
  await verdictAfterInstall(verdict, { soldrPath: result.soldrPath, workspace: result.workspace, log: (m) => logger.log(m) });
  await finishPhase("install");

  // ---- zccache-seed ----
  // Pin setup-soldr's zccache before user workflow steps. The pinned
  // install is home-anchored inside soldr, so later self-tests can isolate
  // SOLDR_CACHE_DIR without repeating release lookup or cargo-install fallback.
  await markPhase("zccache-seed");
  await seedZccache({
    soldrPath: result.soldrPath,
    actionRoot: actionRoot(),
    enabled: result.enabled,
    strict: isTruthy(inputs.zccacheSeedStrict),
    log: (msg) => logger.log(msg),
    warn: (msg) => logger.warning(msg),
  });
  await finishPhase("zccache-seed");

  // Export SOLDR_BINARY so shims can exec it directly
  core.exportVariable("SOLDR_BINARY", result.soldrPath);
  core.saveState("setupSoldrPassthrough", result.enabled ? "false" : "true");

  // ---- shims ----
  if (result.shimsEnabled) {
    await ensureShims({
      shimsDir: result.shimsDir,
      soldrPath: result.soldrPath,
      isWindows: process.platform === "win32",
      log: (msg) => logger.log(msg),
    });
  }

  // ---- verify ----
  await markPhase("verify");
  let soldrRuntimeVersion = "passthrough";
  if (result.enabled) {
    const verify = await verifySoldr({
      soldrPath: result.soldrPath,
      buildCacheMode: result.buildCache.mode,
      requireRustPlan: result.targetCache.enabled,
      minimumVersion: result.blessedPrepareCache.target ? "0.8.43" : undefined,
    });
    core.setOutput("soldr-version", verify.soldrVersion);
    core.setOutput("soldr_version", verify.soldrVersion);
    soldrRuntimeVersion = verify.soldrVersion;
    core.saveState("soldrRuntimeVersion", verify.soldrVersion);
  } else {
    core.setOutput("soldr-version", "passthrough");
    core.setOutput("soldr_version", "passthrough");
  }
  await finishPhase("verify");

  // ---- Dylint foundation ----
  // Dylint mode is a complete setup contract: Soldr fetches and verifies its
  // pinned command binaries, dated nightly/components, and matching driver.
  // Direct Dylint UI tests also need the managed linker directory on PATH.
  await markPhase("dylint-prepare");
  await prepareDylint({
    // cacheIdentity exists for Dylint mode even when every cache layer is
    // disabled; preparation is functionality, not a cache side effect.
    enabled: result.dylintCache.cacheIdentity !== "",
    soldrPath: result.soldrPath,
    soldrRoot: result.soldrRoot,
    workspace: result.workspace,
    cargoDylintVersion: result.dylintCache.cargoDylintVersion,
    dylintLinkVersion: result.dylintCache.dylintLinkVersion,
    crossTargets: result.dylintCache.crossTargets,
    addPath: (directory) => core.addPath(directory),
  });
  await finishPhase("dylint-prepare");

  // ---- cargo-registry extraction ----
  // Network download overlapped other layers in parallel-restore. Extraction
  // starts only after the Soldr binary has been installed and runtime-verified.
  await markPhase("cargo-registry-extract");
  const registryDownload = cargoRegistryDownload as {
    hit: boolean;
    matchedKey: string;
    startedMs: number;
  } | null;
  if (registryDownload) {
    let archiveBytes: number | null = null;
    let restoredBytes: number | null = null;
    let restoredFiles: number | null = null;
    let restoredHit = registryDownload.hit;
    let matched = registryDownload.matchedKey;
    const markRegistryMiss = (): void => {
      restoredHit = false;
      matched = "";
      core.setOutput("cargo-registry-cache-hit", "false");
      core.setOutput("cargo_registry_cache_hit", "false");
      core.saveState("cargoRegistryCacheExactHit", "false");
      core.saveState("cargoRegistryCacheMatchedKey", "");
    };
    if (matched) {
      try {
        const archiveResult = await restoreCargoRegistryArchive({
          plan: result.cargoRegistryCache.archive,
          cargoHome: result.cargoHome,
          soldrPath: result.soldrPath,
          soldrVersion: soldrRuntimeVersion,
          cacheKey: matched,
          autoDefenderExclude: process.platform === "win32",
          debug: debugMode,
          log: debugLog,
        });
        if (!archiveResult.used) {
          logger.log(
            `cargo-registry: ${archiveResult.codecPath} unavailable for runtime Soldr ${soldrRuntimeVersion}; treating restored entry as a miss`,
          );
          markRegistryMiss();
        } else {
          archiveBytes = archiveResult.archiveBytes;
          restoredBytes = archiveResult.restoredBytes;
          restoredFiles = archiveResult.restoredFiles;
          if (archiveBytes === 0 || restoredFiles === 0) {
            logger.warning(
              `cargo-registry: matched key ${matched} produced an unusable payload: ` +
              `archive=${archiveBytes}B extracted_files=${restoredFiles} ` +
              `extracted_bytes=${restoredBytes}; treating as miss`,
            );
            markRegistryMiss();
          } else {
            dependencyCacheMatchedKeys.push(matched);
            logger.log(
              `cargo-registry: extracted format=${archiveResult.codecPath} archive_bytes=${archiveBytes} restored_bytes=${restoredBytes} files=${restoredFiles} duration_ms=${archiveResult.durationMs}`,
            );
          }
        }
      } catch (err) {
        const errorCode = (err as NodeJS.ErrnoException | undefined)?.code;
        const encryptionFailure = errorCode === "EAUTHFAIL" || errorCode === "EENCNOKEY";
        const skipEncryptionFailure = shouldSkipCargoRegistryExtractionError(
          err,
          result.cargoRegistryCache.archive.format,
          process.env["SETUP_SOLDR_CACHE_ENCRYPT_ON_FAILURE"],
        );
        if (skipEncryptionFailure) {
          core.warning(
            `cargo-registry encrypted archive could not be restored; cache-encrypt-on-failure=skip treats it as a cold miss: ${err instanceof Error ? err.message : String(err)}`,
          );
          markRegistryMiss();
        } else if (encryptionFailure) {
          throw new Error(
            `cargo-registry archive extraction failed for ${registryDownload.hit ? "exact-hit" : "fallback-hit"} ${matched}: ${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          logger.warning(
            `cargo-registry: matched key ${matched} produced an unusable payload: ` +
            `${err instanceof Error ? err.message : String(err)}; treating as miss`,
          );
          markRegistryMiss();
        }
      }
    }
    statsCollector.record({
      label: `cargo-registry-${result.cargoRegistryCache.archive.format}`,
      operation: "restore",
      hit: restoredHit,
      key: result.cargoRegistryCache.key,
      matchedKey: matched,
      restoreKeys: [result.cargoRegistryCache.restorePrefix],
      archiveBytes,
      inflatedBytes: restoredBytes,
      fileCount: restoredFiles,
      durationMs: Date.now() - registryDownload.startedMs,
      timestamp: new Date().toISOString(),
    });
  }
  await finishPhase("cargo-registry-extract");

  // ---- cross-prepare ----
  await markPhase("cross-prepare");
  const preparePlan = result.blessedPrepareCache;
  if (preparePlan.target) {
    if (!result.enabled) throw new Error("cross-targets requires enable: true");
    const installedVersion = result.soldrVersionResolved || result.soldrVersionRequested;
    assertMinimumSoldrVersion(installedVersion);
    const exactHit = core.getState("blessedPrepareCacheExactHit") === "true";
    const matchedKey = core.getState("blessedPrepareCacheMatchedKey");
    const prepareTargets = prepareTargetsFor(preparePlan.target);
    const archivesExist = preparePlan.archivePaths.length === prepareTargets.length
      && preparePlan.archivePaths.every(
        (archivePath) => fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0,
      );
    const cacheUse = decideBlessedPrepareCacheUse({
      enabled: preparePlan.enabled,
      exactHit,
      matchedKey,
      archivesExist,
    });
    const { effectiveExactHit, fallbackHit } = cacheUse;
    if (exactHit && !archivesExist) {
      logger.log("cross-prepare: exact cache key restored without every prepared archive; reseeding");
      core.saveState("blessedPrepareCacheExactHit", "false");
      core.setOutput("blessed-prepare-cache-hit", "false");
    }
    logger.log(`cross-prepare: target=${preparePlan.target} cache=${preparePlan.enabled ? (effectiveExactHit ? "hit" : fallbackHit ? "fallback-hit" : "miss") : "disabled"}`);
    const contracts: TargetLifecycleContract[] = [];
    for (const [index, target] of prepareTargets.entries()) {
      await executeBlessedPrepare({
        soldrPath: result.soldrPath,
        target,
        githubEnv: process.env["GITHUB_ENV"],
        archivePath: preparePlan.archivePaths[index],
        // Fallback archives are intentionally replayed across Soldr releases.
        // Soldr always validates expected versioned paths after restore and
        // downloads only missing/current assets before saving the exact key.
        restore: cacheUse.restore,
        save: cacheUse.save,
      });
      const targetPlan = await queryTargetPlan(result.soldrPath, target, (message) => logger.log(message));
      if (!targetPlan) {
        throw new Error(`Soldr did not report a machine-readable target plan for ${target}; target capability is unavailable`);
      }
      contracts.push(normalizeTargetPlan(target, targetPlan));
    }
    const contract = preparePlan.target === "universal2-apple-darwin"
      ? buildUniversal2TargetContract(contracts)
      : contracts[0]!;
    publishTargetContract(result, contract, logger);
    core.saveState("blessedPrepareComplete", "true");
  }
  await finishPhase("cross-prepare");

  // ---- cook (prebuild-deps via soldr-cook) ----
  // The RESTORE was kicked off as a background promise right after the
  // parallel-restore block above — we just await its result here. The
  // RUN (`soldr cook`) still happens in this phase if
  // the restore missed.
  // Failures here are logged but never fail the action — the user's
  // own cargo build will still work without the cooked deps.
  await markPhase("cook");
  if (cookActive && cookLayeredRestorePromise) {
    const restore = await cookLayeredRestorePromise;
    const loaded = await loadLayeredCookCache({
      soldrBinary: result.soldrPath,
      projectRoot: cookProjectRoot,
      targetDir: cookTargetDir,
      baseArchivePath: cookBaseArchive,
      deltaArchivePath: cookDeltaArchive,
      baseManifestPath: cookBaseManifest,
      restore,
      log: (msg) => logger.log(msg),
      warn: (msg) => logger.warning(msg),
    });
    const baseReady = layeredCookBaseReady(restore, loaded);
    const deltaReady = layeredCookDeltaReady(restore, loaded);
    if (baseReady && restore.base.matchedKey) {
      dependencyCacheMatchedKeys.push(restore.base.matchedKey);
    }
    if (deltaReady && restore.delta.matchedKey) {
      dependencyCacheMatchedKeys.push(restore.delta.matchedKey);
    }
    core.setOutput("cook-cache-base-hit", baseReady ? "true" : "false");
    core.setOutput("cook-cache-delta-hit", deltaReady ? "true" : "false");
    core.setOutput("cook-cache-hit", baseReady ? "true" : "false");
    core.setOutput("cook-cache-status", deltaReady ? "hit" : baseReady ? "base-hit" : "miss");
    core.setOutput("cook-cache-load-report-json", JSON.stringify({
      base: loaded.baseReport,
      delta: loaded.deltaReport,
    }));
    statsCollector.record({
      label: "cook-cache-base",
      operation: "restore",
      hit: baseReady,
      key: cookBaseKey,
      matchedKey: restore.base.matchedKey,
      restoreKeys: [],
      archiveBytes: restore.base.archiveBytes || null,
      inflatedBytes: null,
      fileCount: loaded.baseReport?.cacheFilesRestored ?? null,
      durationMs: Date.now() - cookRestoreT0,
      timestamp: new Date().toISOString(),
    });
    if (cookDeltaEnabled) statsCollector.record({
      label: "cook-cache-delta",
      operation: "restore",
      hit: deltaReady,
      key: cookDeltaKey,
      matchedKey: restore.delta.matchedKey,
      restoreKeys: cookDeltaRestoreKeys,
      archiveBytes: restore.delta.archiveBytes || null,
      inflatedBytes: null,
      fileCount: loaded.deltaReport?.cacheFilesRestored ?? null,
      durationMs: Date.now() - cookRestoreT0,
      timestamp: new Date().toISOString(),
    });
    let cookRan = false;
    if (!deltaReady) {
      const runRes = await runCook({
        soldrBinary: result.soldrPath,
        projectRoot: cookProjectRoot,
        flags: cookFlags,
        log: (msg) => logger.log(msg),
      });
      cookRan = runRes.exitCode === 0;
    } else {
      logger.log("cook: base+delta cache hit - skipping cook run, target/deps already warm");
    }
    const cookSaveLayer = selectCookSaveLayer(cookRan, baseReady, cookDeltaEnabled);
    core.saveState("cookEnabled", "true");
    core.saveState("cookLayered", "true");
    core.saveState("cookBaseExactKey", cookBaseKey);
    core.saveState("cookDeltaExactKey", cookDeltaKey);
    core.saveState("cookBaseMatchedKey", restore.base.matchedKey);
    core.saveState("cookDeltaMatchedKey", restore.delta.matchedKey);
    core.saveState("cookBaseHit", baseReady ? "true" : "false");
    core.saveState("cookDeltaHit", deltaReady ? "true" : "false");
    core.saveState("cookHit", deltaReady ? "true" : "false");
    core.saveState("cookRan", cookRan ? "true" : "false");
    core.saveState("cookSaveLayer", cookSaveLayer);
    core.saveState("cookProjectRoot", cookProjectRoot);
    core.saveState("cookTargetDir", cookTargetDir);
    core.saveState("cookBaseArchive", cookBaseArchive);
    core.saveState("cookDeltaArchive", cookDeltaArchive);
    core.saveState("cookBaseManifest", cookBaseManifest);
    core.saveState("cookSoldrBinary", result.soldrPath);
    // #268/#358: cook-cache-base previously used zstd-level 19, but
    // production observation showed 165s of compress wall-clock per
    // matrix job for ~224 MB output. In a 5-way matrix where 1 job
    // wins the cache reservation and 4 lose the race, that's 660s
    // of post-step CPU wasted per CI cycle. Lowering to -9 cuts the
    // compress wall-clock ~4× (target ~40s) at the cost of ~25%
    // larger archive (~280 MB) and ~1s extra upload wall-clock per
    // save. zstd decompression speed is level-independent, so warm
    // restores are unaffected. Net: ~125s win per save-attempt, big
    // multiplier on race-loss scenarios.
    //
    // zackees/ci.yml#227: those are the GitHub levels; a local runner
    // (ACT=true) has no cache budget and compresses at -1.
    core.saveState("cookCompressLevel", cacheProfileDefault("cook-base-zstd-level", isLocalRunner(process.env)));
    core.saveState("cookDeltaCompressLevel", cacheProfileDefault("cook-delta-zstd-level", isLocalRunner(process.env)));
  } else if (cookActive && cookRestorePromise) {
    const restore = await cookRestorePromise;
    core.setOutput("cook-cache-hit", restore.hit ? "true" : "false");
    core.setOutput("cook-cache-status", restore.hit ? "hit" : "miss");
    statsCollector.record({
      label: "cook-cache",
      operation: "restore",
      hit: restore.hit,
      key: cookKey,
      matchedKey: restore.matchedKey,
      restoreKeys: [],
      archiveBytes: restore.archiveBytes || null,
      inflatedBytes: null,
      fileCount: null,
      durationMs: Date.now() - cookRestoreT0,
      timestamp: new Date().toISOString(),
    });
    let cookRan = false;
    if (!restore.hit) {
      const runRes = await runCook({
        soldrBinary: result.soldrPath,
        projectRoot: cookProjectRoot,
        flags: cookFlags,
        log: (msg) => logger.log(msg),
      });
      cookRan = runRes.exitCode === 0;
    } else {
      logger.log("cook: cache hit - skipping cook run, target/deps already warm");
    }
    core.saveState("cookEnabled", "true");
    core.saveState("cookLayered", "false");
    core.saveState("cookExactKey", cookKey);
    core.saveState("cookMatchedKey", restore.matchedKey);
    if (restore.hit && restore.matchedKey) dependencyCacheMatchedKeys.push(restore.matchedKey);
    core.saveState("cookHit", restore.hit ? "true" : "false");
    core.saveState("cookRan", cookRan ? "true" : "false");
    core.saveState("cookTargetDir", cookTargetDir);
    core.saveState("cookLongWindow", "27");
    // #268/#358: see the layered cookCompressLevel saveState above for
    // rationale on lowering from -19. Same logic applies to the
    // non-layered path, including the local-runner -1. --long=27 is kept
    // at every level because restore needs the window.
    core.saveState("cookCompressLevel", cacheProfileDefault("cook-base-zstd-level", isLocalRunner(process.env)));
  } else if (cookSkippedDueToTargetHit) {
    core.setOutput("cook-cache-status", "covered-by-target-cache");
    logger.log(
      `cook: skipped - target-cache matched at lockfile/shape level (matched=${targetCacheMatchedKey}); cook output would be redundant`,
    );
    core.saveState("cookEnabled", "false");
    core.saveState("cookLayered", "false");
  } else {
    logger.log(`cook: skipped - ${cookGate.reason}`);
    core.saveState("cookEnabled", "false");
    core.saveState("cookLayered", "false");
  }
  await finishPhase("cook");

  // #476: content-addressed keys cannot observe a later registry yank. Start
  // the network check only after every dependency-bearing restore has been
  // validated, then let it run concurrently with the consumer's build. The
  // post action joins this result before any cache save can report success.
  const poisonedCandidates = [...new Set(dependencyCacheMatchedKeys.filter(Boolean))];
  core.saveState("yankAuditStarted", "false");
  if (poisonedCandidates.length > 0) {
    const resultPath = path.join(ctx.runnerTemp, "setup-soldr-yank-audit", "result.json");
    const configPath = path.join(ctx.runnerTemp, "setup-soldr-yank-audit", "config.json");
    try {
      if (!result.targetCache.lockfilePath) {
        throw new Error("restored dependency cache has no Cargo.lock path");
      }
      const lockfilePath = path.isAbsolute(result.targetCache.lockfilePath)
        ? result.targetCache.lockfilePath
        : path.resolve(ctx.workspace, result.targetCache.lockfilePath);
      const dependencies = readRegistryDependencies(lockfilePath);
      const config: YankAuditWorkerConfig = {
        dependencies,
        requestTimeoutMs: 30_000,
        // Finish before post's 60s join ceiling even if every registry
        // request stalls. The worker aborts all in-flight requests together.
        overallTimeoutMs: 45_000,
      };
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
      writeYankAuditResult(resultPath, { status: "pending" });
      core.saveState("yankAuditStarted", "true");
      core.saveState("yankAuditResultPath", resultPath);
      core.saveState("yankAuditConfigPath", configPath);
      core.saveState("yankAuditStartedAtMs", String(Date.now()));
      core.saveState("yankAuditCacheKeys", JSON.stringify(poisonedCandidates));
      if (dependencies.length === 0) {
        writeYankAuditResult(resultPath, {
          status: "clean",
          checkedAt: new Date().toISOString(),
          dependencyCount: 0,
          checkedCount: 0,
          yanked: [],
          errors: [],
        });
      } else {
        const entrypoint = process.argv[1];
        if (!entrypoint) throw new Error("Node action entrypoint is unavailable");
        const stderrPath = path.join(path.dirname(resultPath), "worker-stderr.log");
        const stderrFd = fs.openSync(stderrPath, "w");
        let child;
        try {
          child = spawn(
            process.execPath,
            [entrypoint, YANK_AUDIT_WORKER_ARG, configPath, resultPath],
            { detached: true, stdio: ["ignore", "ignore", stderrFd], windowsHide: true },
          );
        } finally {
          fs.closeSync(stderrFd);
        }
        core.saveState("yankAuditStderrPath", stderrPath);
        child.unref();
        logger.log(
          `yank-audit: started pid=${child.pid ?? "unknown"} dependencies=${dependencies.length} ` +
            `cache_keys=${poisonedCandidates.length}`,
        );
      }
    } catch (err) {
      writeYankAuditResult(resultPath, {
        status: "not-checked",
        checkedAt: new Date().toISOString(),
        errors: [err instanceof Error ? err.message : String(err)],
      });
      core.saveState("yankAuditStarted", "true");
      core.saveState("yankAuditResultPath", resultPath);
      core.saveState("yankAuditConfigPath", configPath);
      core.saveState("yankAuditCacheKeys", JSON.stringify(poisonedCandidates));
      logger.warning(
        `yank-audit: not checked: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- shared-target warning ----
  await detectSharedTargetWarning({
    buildCacheEnabled,
    effectiveTargetCacheEnabled: result.targetCache.enabled,
    buildCacheMode: result.buildCache.mode,
    targetDir: result.targetCache.targetPath,
    soldrPath: result.soldrPath,
  });

  // ---- shim-bypass diagnostic ----
  // Issue #160: when shims: true is requested but the effective environment
  // (PATH ordering, CARGO/RUSTC/RUSTC_WRAPPER overrides) would bypass them,
  // caching looks configured but compile work runs through plain cargo.
  // Emit advisory warnings naming each offender. Runs at the very end so it
  // sees the final state of process.env after every prior phase.
  if (result.shimsEnabled) {
    const bypassWarnings = diagnoseShimBypass({
      shimsEnabled: true,
      shimDir: result.shimsDir,
      path: process.env["PATH"] ?? "",
      cargoEnv: process.env["CARGO"],
      rustcEnv: process.env["RUSTC"],
      rustcWrapperEnv: process.env["RUSTC_WRAPPER"],
      soldrBinary: result.soldrPath,
    });
    for (const msg of bypassWarnings) {
      core.warning(msg);
    }
    if (bypassWarnings.length === 0) {
      logger.log(
        `shim-bypass check clean: shim dir ${result.shimsDir} at PATH front, no competing CARGO/RUSTC/RUSTC_WRAPPER overrides`,
      );
    }
  }

  // ---- stats report ----
  statsCollector.report(statsMode, (msg) => logger.log(msg));
  if (statsMode === "detailed") {
    try {
      await statsCollector.writeFiles(ctx.runnerTemp);
      statsCollector.setGithubOutputs();
    } catch (err) {
      logger.log(`stats: failed to write files: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  core.saveState("statsCollector", statsCollector.serialize());
  core.saveState("statsMode", statsMode);
  core.saveState("compileCacheStats", result.compileCacheStats);
  core.saveState("runnerTemp", ctx.runnerTemp);

  if (logging) {
    dumpDiagnostics({
      phase: "main",
      env: process.env,
      rawInputs: inputs,
      result,
      cacheOutcomes: statsCollector.snapshot(),
      logger,
    });
  }

  // #269-companion (setup side): one-line aggregate of where each
  // setup phase's wall-clock went, before we finish the `action`
  // phase. Mirrors the post-step `cache save totals:` line that
  // ships from `StatsCollector.saveSummaryOneLine()`. Operators see
  // the pre-build budget at a glance without scrolling raw
  // SETUP_SOLDR_PHASE_*_START_MS env vars or hunting through the
  // timeline. Phases in declared serial order:
  const setupPhaseSummary = setupPhaseSummaryOneLine([
    "resolve",
    "parallel-restore",
    "target-tree",
    "toolchain",
    "install",
    "zccache-seed",
    "verify",
    "cargo-registry-extract",
    "cross-prepare",
    "cook",
  ]);
  if (setupPhaseSummary) core.info(setupPhaseSummary);

  await finishPhase("action");

  // dirHasContent is exported for tests; suppress unused warning here.
  void dirHasContent;
}

// Auto-invoke only when this module is run as the main entry point. This lets
// tests import `run` (and helpers) without triggering the side-effectful
// orchestration. The dist/main.js produced by ncc is invoked directly by the
// Actions runtime so the check trips and the action executes normally.
if (
  typeof process !== "undefined" &&
  process.env["SETUP_SOLDR_SKIP_AUTOSTART"] !== "1" &&
  // import.meta.url is the file URL of this module; argv[1] is the runner
  // entrypoint. ncc bundles into dist/main.js so the bundled path won't equal
  // the dev path — we rely on the env-var opt-out for tests instead.
  !process.env["SETUP_SOLDR_TEST_IMPORT"]
) {
  if (process.argv[2] === YANK_AUDIT_WORKER_ARG) {
    const configPath = process.argv[3];
    const resultPath = process.argv[4];
    if (!configPath || !resultPath) {
      process.exitCode = 2;
    } else {
      runYankAuditWorker(configPath, resultPath).catch(() => {
        process.exitCode = 1;
      });
    }
  } else {
    // Exit as soon as setup is done (setup-soldr#589). A daemon the cook
    // started, or a kept-alive socket, can otherwise hold the event loop and
    // leave the step idle for minutes after its summary. Nothing outlives
    // run() on purpose: the yank-audit worker is detached and unref'd, and
    // deferred saves run in the separate post step.
    run()
      .catch((err: unknown) => {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        core.setFailed(`setup-soldr failed: ${message}`);
      })
      .finally(() => {
        process.exit();
      });
  }
}
