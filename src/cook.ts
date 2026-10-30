import * as core from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadLayeredCookCache,
  layeredCookBaseReady,
  layeredCookDeltaReady,
  restoreCookCache,
  restoreLayeredCookCacheArchives,
  runCook,
} from "./lib/cook-cache.js";
import {
  buildDeferredCookPlan,
  parseBooleanInput,
  selectDeferredCookSaveLayer,
} from "./lib/deferred-cook.js";
import { parseVersionJsonOutput } from "./lib/verify-soldr.js";
import { captureCookCommand as capture, resolveCookRustcRelease } from "./lib/cook-rustc.js";
import { decideCacheSave, isLocalRunner, parseSaveCacheMode } from "./lib/save-policy.js";

async function soldrVersion(soldrPath: string): Promise<string> {
  const result = await capture(soldrPath, ["version", "--json"]);
  if (result.code !== 0) {
    core.warning(`cook: soldr version probe failed with exit ${result.code}: ${result.stderr.trim()}`);
    return "unresolved";
  }
  try {
    const payload = parseVersionJsonOutput(result.stdout);
    return String(payload["soldr_version"] ?? "").trim() || "unresolved";
  } catch (err) {
    core.warning(`cook: soldr version probe produced unusable JSON: ${err instanceof Error ? err.message : String(err)}`);
    return "unresolved";
  }
}

async function deriveParentSha(workspace: string, githubSha: string): Promise<string> {
  if (!githubSha) return "";
  for (const args of [
    ["-C", workspace, "log", "-1", "--format=%P", "HEAD"],
    ["-C", workspace, "cat-file", "-p", "HEAD"],
  ]) {
    const result = await capture("git", args);
    if (result.code !== 0) continue;
    if (args.includes("cat-file")) {
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line === "") break;
        if (!line.startsWith("parent ")) continue;
        const sha = line.slice("parent ".length).trim();
        if (/^[0-9a-f]{7,40}$/i.test(sha) && sha !== githubSha) return sha;
      }
      continue;
    }
    const first = result.stdout.trim().split(/\s+/)[0] ?? "";
    if (/^[0-9a-f]{7,40}$/i.test(first) && first !== githubSha) return first;
  }
  return "";
}

function saveCookState(name: string, value: string | boolean): void {
  core.saveState(`deferredCook${name}`, typeof value === "boolean" ? (value ? "true" : "false") : value);
}

async function main(): Promise<void> {
  const env = process.env;
  const workspace = core.getInput("workspace").trim() ||
    env["ACTION_WORKSPACE"]?.trim() ||
    env["GITHUB_WORKSPACE"]?.trim() ||
    process.cwd();
  const runnerTemp = env["RUNNER_TEMP"]?.trim() || path.join(os.tmpdir(), "setup-soldr-runner");
  const soldrPath = core.getInput("soldr-path").trim() || env["SOLDR_BINARY"]?.trim() || "soldr";
  const cache = parseBooleanInput("cache", core.getInput("cache"), true);
  // #527/#537: same save policy as the main action. `auto` (default) skips
  // the durable upload on GitHub pull_request events and saves on a local
  // runner; `true`/`false` override.
  const saveDecision = decideCacheSave(
    parseSaveCacheMode(core.getInput("save-cache"), "auto"),
    env["GITHUB_EVENT_NAME"],
    isLocalRunner(env),
    parseSaveCacheMode(core.getInput("save-cache-remote"), "auto"),
  );
  const saveCache = saveDecision.save;
  if (!saveCache) core.info(`cook-cache: save skipped: ${saveDecision.reason}`);
  const deltaCache = parseBooleanInput("delta-cache", core.getInput("delta-cache"), true);
  // #528: the delta layer on top of the base is off by default. The base
  // cook archive is still restored and saved; only the delta is skipped.
  const cookDelta = parseBooleanInput("cook-delta", core.getInput("cook-delta"), false);
  const failOnError = parseBooleanInput("fail-on-error", core.getInput("fail-on-error"), false);
  const debug = parseBooleanInput("debug", core.getInput("debug"), false);
  const githubSha = env["GITHUB_SHA"]?.trim() || "nosha";
  const parentSha = core.getInput("parent-sha").trim() ||
    env["ACTION_PARENT_SHA"]?.trim() ||
    await deriveParentSha(workspace, githubSha);
  const plan = await buildDeferredCookPlan({
    workspace,
    runnerOs: env["ACTION_OS"]?.trim() || env["RUNNER_OS"]?.trim() || process.platform,
    runnerArch: env["ACTION_ARCH"]?.trim() || env["RUNNER_ARCH"]?.trim() || process.arch,
    githubSha,
    parentSha,
    targetDir: core.getInput("target-dir"),
    lockfile: core.getInput("lockfile"),
    flags: core.getInput("flags"),
    cache,
    deltaCache,
    rustcRelease: core.getInput("rustc-release").trim() || await resolveCookRustcRelease(soldrPath, path.resolve(workspace), capture, (message) => core.warning(message)),
    soldrVersion: core.getInput("soldr-version").trim() || await soldrVersion(soldrPath),
    buildShape: core.getInput("build-shape"),
    env,
  });

  if (!plan.enabled) {
    core.info(`cook: skipped - ${plan.reason}`);
    saveCookState("Enabled", false);
    core.setOutput("cache-hit", "false");
    core.setOutput("ran", "false");
    return;
  }

  fs.mkdirSync(plan.targetDir, { recursive: true });
  core.info(`cook: target=${plan.targetDir} layered=${plan.layered ? "true" : "false"} cook-delta=${cookDelta ? "true" : "false"}`);
  let cookRan = false;
  let cacheHit = false;
  let saveLayer = "none";

  if (plan.layered) {
    const restore = await restoreLayeredCookCacheArchives({
      baseKey: plan.baseKey,
      baseRestoreKeys: plan.baseRestoreKeys,
      deltaKey: plan.deltaKey,
      deltaRestoreKeys: plan.deltaRestoreKeys,
      baseArchivePath: plan.baseArchivePath,
      deltaArchivePath: plan.deltaArchivePath,
      deltaEnabled: cookDelta,
      log: (msg) => core.info(msg),
      warn: (msg) => core.warning(msg),
    });
    const loaded = await loadLayeredCookCache({
      soldrBinary: soldrPath,
      projectRoot: plan.projectRoot,
      targetDir: plan.targetDir,
      baseArchivePath: plan.baseArchivePath,
      deltaArchivePath: plan.deltaArchivePath,
      baseManifestPath: plan.baseManifestPath,
      restore,
      log: (msg) => core.info(msg),
      warn: (msg) => core.warning(msg),
    });
    const baseReady = layeredCookBaseReady(restore, loaded);
    const deltaReady = layeredCookDeltaReady(restore, loaded);
    cacheHit = deltaReady;
    if (!deltaReady) {
      const runRes = await runCook({
        soldrBinary: soldrPath,
        projectRoot: plan.projectRoot,
        flags: plan.flags,
        log: (msg) => core.info(msg),
      });
      cookRan = runRes.exitCode === 0;
      if (runRes.exitCode !== 0 && failOnError) {
        throw new Error(`soldr cook failed with exit ${runRes.exitCode}`);
      }
    } else {
      core.info("cook: base+delta cache hit - skipping cook run");
    }
    saveLayer = selectDeferredCookSaveLayer(cookRan, baseReady, saveCache, cookDelta);
    saveCookState("Layered", true);
    saveCookState("BaseExactKey", plan.baseKey);
    saveCookState("DeltaExactKey", plan.deltaKey);
    saveCookState("BaseArchive", plan.baseArchivePath);
    saveCookState("DeltaArchive", plan.deltaArchivePath);
    saveCookState("BaseManifest", plan.baseManifestPath);
    saveCookState("SaveLayer", saveLayer);
    saveCookState("BaseCompressLevel", core.getInput("zstd-level").trim() || plan.baseZstdLevel);
    saveCookState("DeltaCompressLevel", core.getInput("delta-zstd-level").trim() || plan.deltaZstdLevel);
  } else {
    const archivePath = path.join(runnerTemp, "setup-soldr-cook.tar.zst");
    const restore = await restoreCookCache({
      exactKey: plan.legacyKey,
      archivePath,
      targetDir: plan.targetDir,
      longWindow: 27,
      debug,
      log: (msg) => core.info(msg),
      warn: (msg) => core.warning(msg),
    });
    cacheHit = restore.hit;
    if (!restore.hit) {
      const runRes = await runCook({
        soldrBinary: soldrPath,
        projectRoot: plan.projectRoot,
        flags: plan.flags,
        log: (msg) => core.info(msg),
      });
      cookRan = runRes.exitCode === 0;
      if (runRes.exitCode !== 0 && failOnError) {
        throw new Error(`soldr cook failed with exit ${runRes.exitCode}`);
      }
    } else {
      core.info("cook: cache hit - skipping cook run");
    }
    saveCookState("Layered", false);
    saveCookState("ExactKey", plan.legacyKey);
    saveCookState("CompressLevel", core.getInput("zstd-level").trim() || plan.baseZstdLevel);
    saveCookState("Debug", debug);
  }

  saveCookState("Enabled", true);
  saveCookState("SaveCache", saveCache);
  saveCookState("Ran", cookRan);
  saveCookState("Hit", cacheHit);
  saveCookState("TargetDir", plan.targetDir);
  saveCookState("ProjectRoot", plan.projectRoot);
  saveCookState("SoldrBinary", soldrPath);
  saveCookState("FailOnError", failOnError);
  core.setOutput("cache-hit", cacheHit ? "true" : "false");
  core.setOutput("ran", cookRan ? "true" : "false");
  core.setOutput("save-layer", saveLayer);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const failOnError = parseBooleanInput("fail-on-error", core.getInput("fail-on-error"), false);
  if (failOnError) {
    core.setFailed(message);
  } else {
    core.warning(`cook: ${message}`);
  }
});
