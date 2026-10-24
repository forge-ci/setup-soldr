/**
 * Orchestration for the verdict ledger tier (setup-soldr#593/#594). The pure
 * pieces live in `verdict-cache.ts`; this module wires them to the Actions
 * cache, soldr and the action's state.
 */
import * as fs from "node:fs";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import {
  type SoldrRunner,
  type VerdictPaths,
  type CacheEntry,
  MANIFEST_PREFIX,
  janitorPlan,
  isLazy,
  manifestKey,
  manifestScope,
  manifestStagingFile,
  predict,
  publishManifest,
  publishVerdicts,
  resetSeen,
  restoreVerdicts,
  verdictPaths,
} from "./verdict-cache.js";
import { allowVerdictSave, gatedVerdictSave } from "./save-policy.js";
import { ensureShims } from "./ensure-shims.js";
import { verifySoldr } from "./verify-soldr.js";
import type { ResolveResult } from "./types.js";

export type VerdictsMode = "auto" | "restore" | "off";

export function parseVerdictsInput(raw: string | undefined): VerdictsMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(value)) return "off";
  if (value === "restore") return "restore";
  return "auto";
}

export function soldrRunner(soldrPath: string): SoldrRunner {
  return async (args, cwd) => {
    const out = await exec.getExecOutput(soldrPath, args, {
      cwd,
      ignoreReturnCode: true,
      silent: true,
      env: { ...process.env, SOLDR_VERDICTS: "off" } as Record<string, string>,
    });
    return { code: out.exitCode, stdout: out.stdout };
  };
}

export interface VerdictPreflight {
  lazy: boolean;
  paths: VerdictPaths | null;
}

/**
 * Restore the previous trusted run's job manifest; when there is one,
 * install soldr now, re-derive its keys and restore those verdicts.
 */
export async function verdictPreflight(opts: {
  mode: VerdictsMode;
  enabled: boolean;
  shimsEnabled: boolean;
  workspace: string;
  soldrPath: string;
  runnerTemp: string;
  installSoldr: () => Promise<void>;
  log: (msg: string) => void;
}): Promise<VerdictPreflight> {
  core.saveState("verdictMode", opts.enabled ? opts.mode : "off");
  if (!opts.enabled || opts.mode === "off") return { lazy: false, paths: null };
  const scope = manifestScope(process.env);
  const staging = manifestStagingFile(opts.runnerTemp);
  let manifest: string | undefined;
  try {
    manifest = await cache.restoreCache([staging], `${MANIFEST_PREFIX}${scope}-`, [`${MANIFEST_PREFIX}${scope}-`]);
  } catch (err) {
    opts.log(`verdict: manifest restore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!manifest || !fs.existsSync(staging)) {
    opts.log(`verdict: no job manifest for scope ${scope} yet`);
    return { lazy: false, paths: null };
  }
  await opts.installSoldr();
  const run = soldrRunner(opts.soldrPath);
  const paths = await verdictPaths(run, opts.workspace);
  if (!paths) {
    opts.log("verdict: this soldr has no verdict ledger; skipping");
    return { lazy: false, paths: null };
  }
  const prediction = await predict(run, staging, opts.workspace);
  resetSeen(paths);
  core.saveState("verdictPaths", JSON.stringify(paths));
  if (!prediction) return { lazy: false, paths };
  const restored = await restoreVerdicts(prediction.keys, paths, (p, k) => cache.restoreCache(p, k));
  const lazy = opts.mode === "auto" && opts.shimsEnabled && isLazy(prediction, restored);
  opts.log(
    `verdict: manifest ${manifest} predicts ${prediction.keys.length} check(s); ` +
      `${restored.length} verdict(s) restored; ` +
      `${prediction.ungated ? "job also builds; " : ""}${lazy ? "LAZY: skipping toolchain and build caches" : "full setup"}`,
  );
  core.saveState("verdictLazy", lazy ? "true" : "false");
  return { lazy, paths };
}

/** After a normal install: locate the store and start this job's log. */
export async function verdictAfterInstall(
  preflight: VerdictPreflight,
  opts: { soldrPath: string; workspace: string },
): Promise<void> {
  if (preflight.paths || core.getState("verdictMode") === "off" || core.getState("verdictMode") === "") return;
  const paths = await verdictPaths(soldrRunner(opts.soldrPath), opts.workspace);
  if (!paths) return;
  resetSeen(paths);
  core.saveState("verdictPaths", JSON.stringify(paths));
}

/** Lazy tail: everything a later step needs from setup-soldr except caches. */
export async function finishLazySetup(opts: {
  result: ResolveResult;
  logger: { log: (msg: string) => void };
}): Promise<void> {
  const { result } = opts;
  core.exportVariable("SOLDR_BINARY", result.soldrPath);
  core.saveState("setupSoldrPassthrough", "false");
  if (result.shimsEnabled) {
    await ensureShims({
      shimsDir: result.shimsDir,
      soldrPath: result.soldrPath,
      isWindows: process.platform === "win32",
      log: (msg) => opts.logger.log(msg),
    });
  }
  const verify = await verifySoldr({
    soldrPath: result.soldrPath,
    buildCacheMode: result.buildCache.mode,
    requireRustPlan: false,
  });
  core.setOutput("soldr-version", verify.soldrVersion);
  core.setOutput("soldr_version", verify.soldrVersion);
  core.setOutput("verdict-lazy", "true");
  core.saveState("soldrRuntimeVersion", verify.soldrVersion);
  opts.logger.log(
    "setup-soldr: lazy verdict mode — every check this job ran last time already passed with these inputs; " +
      "toolchain and build caches were not restored (soldr provisions on demand if a check misses).",
  );
}

/** Post step: publish this run's verdicts and job manifest. */
export async function verdictPost(opts: { runnerTemp: string; log: (msg: string) => void }): Promise<void> {
  const mode = core.getState("verdictMode");
  const raw = core.getState("verdictPaths");
  if (!raw || mode === "off" || mode === "") return;
  let paths: VerdictPaths;
  try {
    paths = JSON.parse(raw) as VerdictPaths;
  } catch {
    return;
  }
  if (!allowVerdictSave(opts.log)) return;
  const save = (p: string[], k: string): Promise<number> => gatedVerdictSave(p, k, opts.log);
  const saved = await publishVerdicts(paths, save, opts.log);
  const key = manifestKey(
    manifestScope(process.env),
    process.env["GITHUB_RUN_ID"] ?? "",
    process.env["GITHUB_RUN_ATTEMPT"] ?? "",
  );
  let manifestSaved = false;
  try {
    manifestSaved = await publishManifest(paths, manifestStagingFile(opts.runnerTemp), key, save);
  } catch (err) {
    opts.log(`verdict: manifest not saved: ${err instanceof Error ? err.message : String(err)}`);
  }
  opts.log(`verdict: published ${saved} verdict(s)${manifestSaved ? ` and manifest ${key}` : ""}`);
  await verdictJanitor(opts.log);
}

/**
 * Keep the verdict family tiny and fresh: delete verdicts beyond the newest
 * MAX_VERDICT_ENTRIES and manifests superseded within their scope. Needs a
 * token with `actions: write`; best effort.
 */
export async function verdictJanitor(log: (msg: string) => void): Promise<void> {
  const [owner, repo] = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  const token = (process.env["GITHUB_TOKEN"] ?? "").trim() || (process.env["INPUT_TOKEN"] ?? "").trim();
  if (!owner || !repo || !token) return;
  const octokit = github.getOctokit(token);
  try {
    const entries: CacheEntry[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await octokit.rest.actions.getActionsCacheList({
        owner,
        repo,
        key: "soldr-verdict-",
        per_page: 100,
        page,
      });
      const items = response.data.actions_caches ?? [];
      for (const item of items) {
        if (item.id != null && item.key) {
          entries.push({
            id: item.id,
            key: item.key,
            last_accessed_at: item.last_accessed_at ?? undefined,
            created_at: item.created_at ?? undefined,
          });
        }
      }
      if (items.length < 100) break;
    }
    const doomed = janitorPlan(entries);
    for (const entry of doomed) {
      try {
        await octokit.rest.actions.deleteActionsCacheById({ owner, repo, cache_id: entry.id });
      } catch {
        // 404 (a sibling job deleted it) and 403 (no actions: write) are fine.
      }
    }
    if (doomed.length > 0) log(`verdict: janitor removed ${doomed.length} superseded entr(ies)`);
  } catch (err) {
    log(`verdict: janitor skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
