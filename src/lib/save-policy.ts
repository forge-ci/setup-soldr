/**
 * Shared durable-cache save policy (setup-soldr#527).
 *
 * GitHub scopes a cache entry saved from a `pull_request` run to
 * `refs/pull/N/merge`: no other ref can restore it, yet it counts against
 * the repository's 10 GB budget and evicts the default branch's entries.
 * Every durable Actions-cache write in `src/` therefore goes through this
 * module, which decides from the `save-cache` input (`auto | true | false`)
 * and `GITHUB_EVENT_NAME` whether an upload may happen.
 *
 * - `auto` (default): save unless the triggering event is `pull_request` on
 *   GitHub, or the run's ref is not the repository's default branch (a
 *   dispatch or push on a branch, a tag): those entries are ref-scoped too
 *   (setup-soldr#587). On a local runner (act or act2, which always export `ACT=true`,
 *   e.g. under bosn) `auto` saves fully: act's cache server has no ref scoping
 *   and no repository budget, and local runs are `pull_request` on purpose so
 *   PR labels select jobs, so skipping there left every local run cold
 *   (setup-soldr#537, zackees/ci.yml#216).
 * - `true`: always save (subject to each layer's own gates).
 * - `false`: never save.
 *
 * Restores and cooking are never gated here; only uploads are.
 *
 * `__tests__/save-policy.test.ts` enumerates every raw save call site in
 * `src/` and fails when one bypasses this gate.
 */
import * as fs from "node:fs";
import * as cache from "@actions/cache";
// The local-runner signal lives with the cache profile it also drives;
// re-exported so existing callers keep importing it from here.
import { isLocalRunner } from "./local-profile.js";
import { readDependencyLayerSaveGate } from "./failed-job-save.js";
export { isLocalRunner };

export type SaveCacheMode = "auto" | "true" | "false";

export interface SaveDecision {
  save: boolean;
  mode: SaveCacheMode;
  /** Human-readable reason, used in the skip log line. */
  reason: string;
}

/** Status string layers report when the policy suppressed an upload. */
export const POLICY_SKIP_STATUS = "policy-skip" as const;

/**
 * Parse a `save-cache` input value. Empty means `defaultMode`; boolean
 * aliases keep the cook action's historical `true`/`false` spelling valid.
 */
export function parseSaveCacheMode(raw: string | undefined, defaultMode: SaveCacheMode = "auto"): SaveCacheMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return defaultMode;
  if (value === "auto") return "auto";
  if (["1", "true", "yes", "on"].includes(value)) return "true";
  if (["0", "false", "no", "off"].includes(value)) return "false";
  throw new Error(`save-cache must be one of auto, true, false (got '${raw}')`);
}

/** The run's ref and the repository's default branch, when known. */
export interface RefScope {
  ref?: string;
  defaultBranch?: string;
}

/** Pure decision: no I/O, platform independent (RUNNER_OS is irrelevant). */
export function decideCacheSave(
  mode: SaveCacheMode,
  eventName: string | undefined,
  localRunner = false,
  remoteMode: SaveCacheMode = "auto",
  refScope: RefScope = {},
): SaveDecision {
  if (mode === "false") return { save: false, mode, reason: "save-cache=false" };
  // A planner's remote write permission is not a local cache disable.
  // Explicit save-cache=false above still disables every backend.
  if (!localRunner && remoteMode !== "auto") {
    return { save: remoteMode === "true", mode, reason: `save-cache-remote=${remoteMode}` };
  }
  if (mode === "true") return { save: true, mode, reason: "save-cache=true" };
  const event = (eventName ?? "").trim();
  if (localRunner) {
    return { save: true, mode, reason: `local runner (act): no ref scoping (save-cache=auto)` };
  }
  if (event === "pull_request") {
    return { save: false, mode, reason: "pull_request event (save-cache=auto)" };
  }
  const { ref, defaultBranch } = refScope;
  if (ref && defaultBranch && ref !== `refs/heads/${defaultBranch}`) {
    return { save: false, mode, reason: `ref ${ref} is not the default branch ${defaultBranch} (save-cache=auto)` };
  }
  return { save: true, mode, reason: `${event || "unknown"} event (save-cache=auto)` };
}

/**
 * Resolve the policy from the process environment. Both the main action
 * and the `cook/` action expose the input as `save-cache`, which the runner
 * passes to main and post steps as `INPUT_SAVE-CACHE`.
 */
export function currentSaveDecision(env: NodeJS.ProcessEnv = process.env, modeOverride?: SaveCacheMode): SaveDecision {
  let mode: SaveCacheMode;
  try {
    mode = modeOverride ?? parseSaveCacheMode(env["INPUT_SAVE-CACHE"], "auto");
  } catch {
    mode = "auto";
  }
  let remoteMode: SaveCacheMode;
  try {
    remoteMode = parseSaveCacheMode(env["INPUT_SAVE-CACHE-REMOTE"], "auto");
  } catch {
    return { save: false, mode, reason: "invalid save-cache-remote" };
  }
  return decideCacheSave(mode, env["GITHUB_EVENT_NAME"], isLocalRunner(env), remoteMode, {
    ref: env["GITHUB_REF"],
    defaultBranch: defaultBranchFromEvent(env["GITHUB_EVENT_PATH"]),
  });
}

/** `repository.default_branch` from the event payload, or undefined. */
function defaultBranchFromEvent(eventPath: string | undefined): string | undefined {
  if (!eventPath) return undefined;
  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8")) as { repository?: { default_branch?: unknown } };
    const branch = payload.repository?.default_branch;
    return typeof branch === "string" && branch ? branch : undefined;
  } catch {
    return undefined;
  }
}

const loggedSkips = new Set<string>();

/** Test hook: forget which layers already logged a skip line. */
export function resetSavePolicyLogForTest(): void {
  loggedSkips.clear();
}

/**
 * THE save gate. Returns true when `layer` may upload. When it may not,
 * logs one line per layer: `<layer>: save skipped: <reason>`.
 */
export function allowCacheSave(layer: string, log: (msg: string) => void = console.log): boolean {
  let decision: SaveDecision = currentSaveDecision();
  // #626: a cancelled job saves no layer at all (the dependency phase may
  // have been interrupted). A failed job still passes here; output layers
  // apply their own stricter #559 gate in the post step.
  if (decision.save) {
    let jobGate: { save: boolean; reason: string };
    try {
      jobGate = readDependencyLayerSaveGate(process.env);
    } catch (err) {
      jobGate = { save: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (jobGate.save) return true;
    decision = { save: false, mode: decision.mode, reason: jobGate.reason };
  }
  if (!loggedSkips.has(layer)) {
    loggedSkips.add(layer);
    log(`${layer}: save skipped: ${decision.reason}`);
  }
  return false;
}

type SaveCacheFn = (paths: string[], key: string) => Promise<number>;
let saveBackend: SaveCacheFn = (paths, key) => cache.saveCache(paths, key);

/** Test hook: replace the `@actions/cache.saveCache` backend. */
export function setSaveCacheBackendForTest(fn: SaveCacheFn | null): void {
  saveBackend = fn ?? ((paths, key) => cache.saveCache(paths, key));
}

/**
 * Policy-gated replacement for `@actions/cache.saveCache`. Returns -1
 * (the same "not saved" sentinel @actions/cache uses) when the policy
 * forbids the upload. Callers should still gate early with
 * `allowCacheSave` so they skip archive production and report a clean
 * `policy-skip` status; this is the backstop.
 */
export async function gatedSaveCache(
  layer: string,
  paths: string[],
  key: string,
  log?: (msg: string) => void,
  backend?: SaveCacheFn,
): Promise<number> {
  if (!allowCacheSave(layer, log)) return -1;
  return (backend ?? saveBackend)(paths, key);
}

/**
 * The verdict ledger's gate (setup-soldr#597). `save-cache` governs build
 * output layers; a lint-only job sets it to `false` precisely so it never
 * uploads a build cache, and those are the jobs the ledger exists for.
 * Verdicts (~230 B) therefore follow only the trust policy: `auto` on this
 * run's event and ref, with `save-cache-remote` still honoured.
 */
export function allowVerdictSave(log: (msg: string) => void = console.log): boolean {
  const decision = currentSaveDecision(process.env, "auto");
  if (decision.save) return true;
  if (!loggedSkips.has("verdict")) {
    loggedSkips.add("verdict");
    log(`verdict: save skipped: ${decision.reason}`);
  }
  return false;
}

/** `gatedSaveCache` for the verdict ledger, gated by `allowVerdictSave`. */
export async function gatedVerdictSave(
  paths: string[],
  key: string,
  log?: (msg: string) => void,
  backend?: SaveCacheFn,
): Promise<number> {
  if (!allowVerdictSave(log)) return -1;
  return (backend ?? saveBackend)(paths, key);
}
