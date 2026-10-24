/**
 * Verdict ledger remote tier (setup-soldr#593, #594; soldr#3894).
 *
 * soldr keeps a local verdict store: a passing `soldr cargo clippy` /
 * `fmt --check` / `dylint` / `test --doc` / ... writes a few-hundred-byte
 * record keyed on its exact inputs, and the next identical invocation
 * replays it instead of running. This module carries that store across CI
 * runs with no consumer YAML:
 *
 * - main: restore the previous trusted run's *job manifest* (the job's
 *   gated invocations, `seen.jsonl`), ask soldr to re-derive their keys
 *   against this checkout (`soldr verdict rekey`), and restore exactly
 *   those records. When every predicted check already has a verdict and
 *   the job did nothing else, the job is *lazy*: the toolchain install and
 *   the build-cache layers are skipped because nothing will compile.
 * - post: publish the records soldr spooled this run and the job
 *   manifest, through the shared save policy (trusted refs write, pull
 *   requests only read).
 *
 * Keys are soldr's own (`soldr-verdict-v1-<tool>-<scope>-<digest>`), one
 * Actions-cache entry per verdict. Manifests are
 * `soldr-verdict-manifest-v1-<scope>-<run>-<attempt>`, restored by prefix.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const VERDICT_PREFIX = "soldr-verdict-v1-";
export const MANIFEST_PREFIX = "soldr-verdict-manifest-v1-";
/** Verdicts kept repository-wide by the post-step janitor. */
export const MAX_VERDICT_ENTRIES = 256;
/** Manifests kept per job scope. */
export const MAX_MANIFESTS_PER_SCOPE = 2;

export interface VerdictPaths {
  root: string;
  records: string;
  spool: string;
  seen: string;
}

/** Runs soldr and returns its exit code and stdout. */
export type SoldrRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
/** `@actions/cache.restoreCache` shape: matched key or undefined. */
export type RestoreFn = (paths: string[], key: string, restoreKeys?: string[]) => Promise<string | undefined>;
/** Policy-gated save: entry id, or -1 when not saved. */
export type SaveFn = (paths: string[], key: string) => Promise<number>;

/** `soldr verdict paths --json`; null when this soldr predates the ledger. */
export async function verdictPaths(run: SoldrRunner, cwd: string): Promise<VerdictPaths | null> {
  try {
    const { code, stdout } = await run(["verdict", "paths", "--json"], cwd);
    if (code !== 0) return null;
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Partial<VerdictPaths>;
    if (!parsed.root || !parsed.records || !parsed.spool || !parsed.seen) return null;
    return parsed as VerdictPaths;
  } catch {
    return null;
  }
}

/**
 * One job's identity across runs: the workflow file (not its ref), the job
 * id, the runner platform and every action input (a matrix leg normally
 * differs in at least one input, such as the target).
 */
export function manifestScope(env: NodeJS.ProcessEnv): string {
  const workflow = (env["GITHUB_WORKFLOW_REF"] ?? env["GITHUB_WORKFLOW"] ?? "").replace(/@.*$/, "");
  const inputs = Object.keys(env)
    // Tokens change every run; hashing them would give every run a new scope.
    .filter((name) => name.startsWith("INPUT_") && !/TOKEN|SECRET|PASSWORD/.test(name))
    .sort()
    .map((name) => `${name}=${env[name] ?? ""}`);
  const material = [workflow, env["GITHUB_JOB"] ?? "", env["RUNNER_OS"] ?? "", env["RUNNER_ARCH"] ?? "", ...inputs]
    .join("\n");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function manifestKey(scope: string, runId: string, attempt: string): string {
  return `${MANIFEST_PREFIX}${scope}-${runId || "0"}-${attempt || "1"}`;
}

/** Where the manifest lives while it is restored or saved. */
export function manifestStagingFile(runnerTemp: string): string {
  return path.join(runnerTemp, "soldr-verdict-manifest", "seen.jsonl");
}

/** What a previous run's manifest predicts for this checkout. */
export interface Prediction {
  /** Keys of the gated checks, re-derived for this checkout. */
  keys: string[];
  /** Gated checks soldr could not key here (they will run). */
  unkeyable: number;
  /** The job also ran work the ledger does not gate (builds, cooks). */
  ungated: boolean;
}

interface RekeyRow {
  key?: string | null;
  ungated?: boolean;
}

/** Parse `soldr verdict rekey --json` output. */
export function parseRekey(stdout: string): Prediction {
  const prediction: Prediction = { keys: [], unkeyable: 0, ungated: false };
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let row: RekeyRow;
    try {
      row = JSON.parse(line) as RekeyRow;
    } catch {
      continue;
    }
    if (row.ungated) prediction.ungated = true;
    else if (row.key) prediction.keys.push(row.key);
    else prediction.unkeyable += 1;
  }
  prediction.keys = [...new Set(prediction.keys)];
  return prediction;
}

/** Re-derive a manifest's keys against `workspace`. */
export async function predict(run: SoldrRunner, manifestFile: string, workspace: string): Promise<Prediction | null> {
  try {
    const { code, stdout } = await run(["verdict", "rekey", "--json", manifestFile], workspace);
    return code === 0 ? parseRekey(stdout) : null;
  } catch {
    return null;
  }
}

export function recordPath(paths: VerdictPaths, key: string): string {
  return path.join(paths.records, `${key}.json`);
}

/** Restore each predicted verdict; returns the keys that were found. */
export async function restoreVerdicts(keys: string[], paths: VerdictPaths, restore: RestoreFn): Promise<string[]> {
  fs.mkdirSync(paths.records, { recursive: true });
  const found = await Promise.all(
    keys.map(async (key) => {
      try {
        return (await restore([recordPath(paths, key)], key)) === key ? key : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((key): key is string => key !== null);
}

/**
 * Lazy when the previous run of this job did nothing but gated checks,
 * every one of them keys here, and every key already has a verdict.
 */
export function isLazy(prediction: Prediction | null, restored: string[]): boolean {
  if (!prediction || prediction.ungated || prediction.unkeyable > 0 || prediction.keys.length === 0) return false;
  const have = new Set(restored);
  return prediction.keys.every((key) => have.has(key));
}

/** Verdict keys soldr spooled this run. */
export function spooledKeys(paths: VerdictPaths): string[] {
  try {
    return fs
      .readdirSync(paths.spool)
      .filter((name) => name.endsWith(".json") && name.startsWith(VERDICT_PREFIX))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/** Publish spooled verdicts; returns how many were saved. */
export async function publishVerdicts(paths: VerdictPaths, save: SaveFn, log: (msg: string) => void): Promise<number> {
  let saved = 0;
  for (const key of spooledKeys(paths)) {
    const record = recordPath(paths, key);
    if (!fs.existsSync(record)) continue;
    try {
      if ((await save([record], key)) !== -1) saved += 1;
    } catch (err) {
      // An entry that already exists is the common, harmless case.
      log(`verdict: ${key} not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return saved;
}

/** Copy this job's `seen.jsonl` to the staging path and publish it. */
export async function publishManifest(
  paths: VerdictPaths,
  stagingFile: string,
  key: string,
  save: SaveFn,
): Promise<boolean> {
  if (!fs.existsSync(paths.seen) || fs.statSync(paths.seen).size === 0) return false;
  fs.mkdirSync(path.dirname(stagingFile), { recursive: true });
  fs.copyFileSync(paths.seen, stagingFile);
  return (await save([stagingFile], key)) !== -1;
}

/** Start this job's invocation log empty so its manifest is this job only. */
export function resetSeen(paths: VerdictPaths): void {
  try {
    fs.rmSync(paths.seen, { force: true });
    fs.rmSync(paths.spool, { recursive: true, force: true });
  } catch {
    // Best effort: a stale line only makes the next prediction wider.
  }
}

export interface CacheEntry {
  id: number;
  key: string;
  last_accessed_at?: string;
  created_at?: string;
}

/**
 * Janitor plan: entries to delete so verdicts stay a tiny, fresh family.
 * Keeps the newest `MAX_VERDICT_ENTRIES` verdicts and the newest
 * `MAX_MANIFESTS_PER_SCOPE` manifests of each scope; a superseded
 * manifest has no reader.
 */
export function janitorPlan(entries: CacheEntry[]): CacheEntry[] {
  const newest = (a: CacheEntry, b: CacheEntry): number =>
    Date.parse(b.last_accessed_at ?? b.created_at ?? "") - Date.parse(a.last_accessed_at ?? a.created_at ?? "");
  const verdicts = entries.filter((e) => e.key.startsWith(VERDICT_PREFIX)).sort(newest);
  const doomed = verdicts.slice(MAX_VERDICT_ENTRIES);
  const byScope = new Map<string, CacheEntry[]>();
  for (const entry of entries.filter((e) => e.key.startsWith(MANIFEST_PREFIX))) {
    const scope = entry.key.slice(MANIFEST_PREFIX.length).split("-")[0] ?? "";
    byScope.set(scope, [...(byScope.get(scope) ?? []), entry]);
  }
  for (const group of byScope.values()) doomed.push(...group.sort(newest).slice(MAX_MANIFESTS_PER_SCOPE));
  return doomed;
}
