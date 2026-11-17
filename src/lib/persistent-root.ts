/**
 * `persistent-root`: keep setup-soldr's state on a self-hosted runner's own
 * storage instead of round-tripping it through the GitHub Actions cache
 * (obs-rust/obs-studio#4954, proposal P4).
 *
 * On a self-hosted runner with a persistent (or RAM-backed) directory, every
 * Actions-cache restore and save is pure overhead: the files the cache would
 * restore are already on the runner. With a persistent root:
 *
 * - `cache-dir` (soldr binary, managed state), soldr's zccache directory,
 *   `RUSTUP_HOME` and `CARGO_HOME` all live under the root;
 * - every GitHub Actions cache restore and save is skipped (setup, solo
 *   toolchain, soldr-mini, cargo-registry, build, target, cook, dylint,
 *   blessed prepare, verdicts), as is the optional S3 tier and the ancestor
 *   lookup, so the job makes no cache round trip at all;
 * - the root is crash safe. A session is opened at the start of a job and
 *   closed only after the post step has stopped the cache daemons and synced
 *   the filesystem. A root whose last session never closed (power loss, a
 *   killed runner) is quarantined and rebuilt cold: a cold start costs a
 *   toolchain download, a truncated rustc costs a false failure.
 *
 * The input is `persistent-root`:
 *
 * - `""` or `auto` (default): use the host's descriptor when one exists, else
 *   behave exactly as before;
 * - `off` / `false` / `none`: never;
 * - a path: use that directory.
 *
 * It applies only on self-hosted runners (`RUNNER_ENVIRONMENT=self-hosted`).
 * An explicit path on a GitHub-hosted runner is ignored with a warning, and
 * `SETUP_SOLDR_PROFILE=hosted` (a repository variable, no commit needed) turns
 * it off everywhere.
 *
 * Host descriptor. The first existing file among
 * `SETUP_SOLDR_PERSISTENT_DESCRIPTOR` or the defaults below. It is either the
 * JSON host-store descriptor (`{"schema": 1, "store": "/abs/path", ...}`) or a
 * plain marker file such as obs-runner's `.persistent-cache`, in which case
 * the store is the marker's directory. The root is the runner's own slot:
 * `<store>/slots/<RUNNER_NAME>/setup-soldr/<os>-<arch>-u<uid>`. One runner
 * runs one job at a time, so a slot has one writer; the uid keeps container
 * jobs (root) and host jobs (the runner user) from sharing files they could
 * not overwrite.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** Exported by main for every later step (and the post step) of the job. */
export const PERSISTENT_ROOT_ENV = "SETUP_SOLDR_PERSISTENT_ROOT";
/** Overrides the descriptor search list (tests, unusual hosts). */
export const PERSISTENT_DESCRIPTOR_ENV = "SETUP_SOLDR_PERSISTENT_DESCRIPTOR";

export const DEFAULT_DESCRIPTOR_PATHS: readonly string[] = [
  "/var/cache/soldr-store/descriptor.json",
  "/var/cache/obs-runner/.persistent-cache",
];

/** Marker that exists exactly while the root is consistent (no job in it). */
export const CLEAN_MARKER = ".clean";
/** setup-soldr's own bookkeeping inside the root. */
export const STATE_DIR = ".setup-soldr";
const SESSION_FILE = "session.json";
const LEDGER_FILE = "ledger.json";
/** A session older than this is stale even if another runner owns it (7 h > any job). */
const STALE_SESSION_MS = 7 * 3600 * 1000;
const LEDGER_HISTORY_LIMIT = 200;

const TRUTHY_OFF = new Set(["off", "false", "0", "no", "none", "disabled"]);

export type PersistentRootSource = "input" | "descriptor";

export interface PersistentRootChoice {
  /** Absolute root, or null when the persistent profile does not apply. */
  root: string | null;
  source: PersistentRootSource | null;
  /** Why it is off, or where it came from. Logged once. */
  reason: string;
  /** Set when the caller asked for it but it cannot apply: surface as a warning. */
  warning?: string;
}

export interface ChoosePersistentRootOptions {
  input: string;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
  uid?: number;
  descriptorPaths?: readonly string[];
  readFile?: (p: string) => string | null;
}

function defaultReadFile(p: string): string | null {
  try {
    if (!fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The store directory a descriptor file names, or null if unusable. */
export function storeFromDescriptor(descriptorPath: string, content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { schema?: unknown; store?: unknown };
      if (parsed.schema !== 1) return null;
      if (typeof parsed.store !== "string" || !path.isAbsolute(parsed.store)) return null;
      return path.resolve(parsed.store);
    } catch {
      return null;
    }
  }
  // Plain marker (obs-runner's `.persistent-cache` holds the host name).
  return path.dirname(path.resolve(descriptorPath));
}

/** Per-runner, per-platform, per-uid slot under a host store. */
export function slotRoot(store: string, runnerName: string, platform: string, arch: string, uid: number): string {
  const safeRunner = runnerName.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(store, "slots", safeRunner, "setup-soldr", `${platform}-${arch}-u${uid}`);
}

/**
 * Pure decision (no writes): which persistent root applies to this job.
 * Filesystem reads go through `readFile` so tests stay hermetic.
 */
export function choosePersistentRoot(opts: ChoosePersistentRootOptions): PersistentRootChoice {
  const { env } = opts;
  const raw = (opts.input ?? "").trim();
  const lowered = raw.toLowerCase();
  const off = (reason: string, warning?: string): PersistentRootChoice => ({ root: null, source: null, reason, ...(warning ? { warning } : {}) });

  if (TRUTHY_OFF.has(lowered)) return off(`persistent-root=${raw}`);
  if ((env["SETUP_SOLDR_PROFILE"] ?? "").trim().toLowerCase() === "hosted") {
    return off("SETUP_SOLDR_PROFILE=hosted");
  }
  const explicit = raw !== "" && lowered !== "auto";
  const selfHosted = (env["RUNNER_ENVIRONMENT"] ?? "").trim().toLowerCase() === "self-hosted";
  if (!selfHosted) {
    return explicit
      ? off("not a self-hosted runner", `setup-soldr: persistent-root=${raw} ignored: RUNNER_ENVIRONMENT is not self-hosted; using the GitHub Actions cache`)
      : off("not a self-hosted runner");
  }
  if (explicit) {
    const home = env["HOME"] || env["USERPROFILE"] || os.homedir();
    const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded)) {
      return off("relative path", `setup-soldr: persistent-root must be an absolute path (got '${raw}'); using the GitHub Actions cache`);
    }
    return { root: path.resolve(expanded), source: "input", reason: "persistent-root input" };
  }

  const read = opts.readFile ?? defaultReadFile;
  const override = (env[PERSISTENT_DESCRIPTOR_ENV] ?? "").trim();
  const candidates = override ? [override] : (opts.descriptorPaths ?? DEFAULT_DESCRIPTOR_PATHS);
  for (const candidate of candidates) {
    const content = read(candidate);
    if (content === null) continue;
    const store = storeFromDescriptor(candidate, content);
    if (!store) return off(`unusable descriptor ${candidate}`, `setup-soldr: host descriptor ${candidate} is not schema 1 with an absolute store; using the GitHub Actions cache`);
    const runner = (env["RUNNER_NAME"] ?? "").trim();
    if (!runner) return off(`descriptor ${candidate} but no RUNNER_NAME`);
    const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    return {
      root: slotRoot(store, runner, opts.platform ?? process.platform, opts.arch ?? process.arch, uid),
      source: "descriptor",
      reason: `host descriptor ${candidate}`,
    };
  }
  return off("no host descriptor");
}

// ---------------------------------------------------------------------------
// Crash safety
// ---------------------------------------------------------------------------

/** Write `content` to `file` so a reader sees the old or the new bytes, never a mix. */
export function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w", 0o644);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some filesystems refuse fsync on a directory; the rename is still atomic.
  }
}

function unlinkDurable(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fsyncDir(path.dirname(file));
}

/** Flush the filesystem holding `dir` (syncfs), so a later marker cannot outrun the data. */
export function syncFilesystem(dir: string): void {
  if (process.platform === "win32") return;
  const result = spawnSync("sync", ["-f", dir], { stdio: "ignore", timeout: 120_000 });
  if (result.status !== 0) spawnSync("sync", [], { stdio: "ignore", timeout: 120_000 });
}

export interface SessionIdentity {
  runner: string;
  runId: string;
  runAttempt: string;
  job: string;
}

export function sessionIdentity(env: Record<string, string | undefined>): SessionIdentity {
  return {
    runner: (env["RUNNER_NAME"] ?? "").trim(),
    runId: (env["GITHUB_RUN_ID"] ?? "").trim(),
    runAttempt: (env["GITHUB_RUN_ATTEMPT"] ?? "").trim(),
    job: (env["GITHUB_JOB"] ?? "").trim(),
  };
}

interface SessionRecord extends SessionIdentity {
  schema: 1;
  pid: number;
  openedAt: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export type OpenOutcome =
  /** Root was empty or brand new. */
  | "fresh"
  /** Root was closed cleanly by the previous job: reuse everything. */
  | "clean"
  /** A second setup-soldr step in the same job: the session is already ours. */
  | "reentrant"
  /** The previous session never closed: its content was quarantined and removed. */
  | "recovered"
  /** Another live runner holds the root: do not touch it, fall back to hosted. */
  | "busy";

export interface OpenResult {
  outcome: OpenOutcome;
  detail: string;
  /** Entries moved aside and deleted on recovery. */
  quarantined: string[];
}

function rootEntries(root: string): string[] {
  try {
    return fs.readdirSync(root).filter((name) => name !== STATE_DIR && name !== CLEAN_MARKER);
  } catch {
    return [];
  }
}

function sameJob(a: SessionIdentity, b: SessionIdentity): boolean {
  return Boolean(a.runId) && a.runner === b.runner && a.runId === b.runId && a.runAttempt === b.runAttempt && a.job === b.job;
}

/**
 * Open a session on `root`. Removes the clean marker (durably) before any
 * content is touched, so a crash from here on leaves the root marked unclean.
 */
export function openPersistentSession(
  root: string,
  identity: SessionIdentity,
  opts: { now?: () => number } = {},
): OpenResult {
  const now = opts.now ?? Date.now;
  fs.mkdirSync(root, { recursive: true });
  fs.accessSync(root, fs.constants.W_OK);
  const stateDir = path.join(root, STATE_DIR);
  const sessionPath = path.join(stateDir, SESSION_FILE);
  const cleanPath = path.join(root, CLEAN_MARKER);
  const previous = readJson<SessionRecord>(sessionPath);
  const wasClean = fs.existsSync(cleanPath);
  const entries = rootEntries(root);

  let outcome: OpenOutcome;
  let detail: string;
  const quarantined: string[] = [];
  if (wasClean) {
    outcome = entries.length === 0 ? "fresh" : "clean";
    detail = previous ? `last closed by ${previous.runner || "?"} run ${previous.runId || "?"}` : "clean marker present";
  } else if (entries.length === 0) {
    outcome = "fresh";
    detail = "empty root";
  } else if (previous && sameJob(previous, identity)) {
    return { outcome: "reentrant", detail: "session already open in this job", quarantined };
  } else if (
    previous &&
    previous.runner &&
    identity.runner &&
    previous.runner !== identity.runner &&
    now() - Date.parse(previous.openedAt) < STALE_SESSION_MS
  ) {
    return { outcome: "busy", detail: `open session held by runner ${previous.runner} run ${previous.runId}`, quarantined };
  } else {
    outcome = "recovered";
    detail = previous
      ? `session of ${previous.runner || "?"} run ${previous.runId || "?"} (opened ${previous.openedAt}) never closed`
      : "content without a clean marker";
    const quarantine = path.join(stateDir, `quarantine-${now()}-${process.pid}`);
    fs.mkdirSync(quarantine, { recursive: true });
    for (const name of entries) {
      fs.renameSync(path.join(root, name), path.join(quarantine, name));
      quarantined.push(name);
    }
    fsyncDir(root);
    fs.rmSync(quarantine, { recursive: true, force: true });
  }

  // Remove leftovers of quarantines that a crash interrupted.
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (name.startsWith("quarantine-")) fs.rmSync(path.join(stateDir, name), { recursive: true, force: true });
    }
  } catch {
    // stateDir may not exist yet.
  }
  const record: SessionRecord = { schema: 1, ...identity, pid: process.pid, openedAt: new Date(now()).toISOString() };
  writeFileAtomic(sessionPath, `${JSON.stringify(record)}\n`);
  unlinkDurable(cleanPath);
  return { outcome, detail, quarantined };
}

/**
 * Close the session: flush the filesystem, then write the clean marker
 * atomically. Call only after every writer into the root (cache daemons
 * included) has stopped, and only when the setup completed.
 */
export function closePersistentSession(root: string, opts: { sync?: (dir: string) => void; now?: () => number } = {}): void {
  (opts.sync ?? syncFilesystem)(root);
  const marker = { schema: 1, closedAt: new Date((opts.now ?? Date.now)()).toISOString() };
  writeFileAtomic(path.join(root, CLEAN_MARKER), `${JSON.stringify(marker)}\n`);
}

// ---------------------------------------------------------------------------
// Gates read by every cache layer
// ---------------------------------------------------------------------------

/** The active persistent root for this job, or "" (read from the exported env). */
export function activePersistentRoot(env: Record<string, string | undefined> = process.env): string {
  return (env[PERSISTENT_ROOT_ENV] ?? "").trim();
}

const loggedBypass = new Set<string>();

/**
 * THE restore gate. True when `layer` must not touch the GitHub Actions
 * cache (or S3) because its files persist on this runner. Logs one line per
 * layer.
 */
export function remoteCacheBypassed(
  layer: string,
  log: (msg: string) => void = console.log,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const root = activePersistentRoot(env);
  if (!root) return false;
  if (!loggedBypass.has(layer)) {
    loggedBypass.add(layer);
    log(`${layer}: GitHub Actions cache skipped: persistent-root ${root}`);
  }
  return true;
}

/** Test hook. */
export function resetPersistentRootLogForTest(): void {
  loggedBypass.clear();
}

/** Where each piece of state lives under a persistent root. */
export interface PersistentLayout {
  cacheDir: string;
  rustupHome: string;
  cargoHome: string;
}

export function persistentLayout(root: string): PersistentLayout {
  return {
    cacheDir: path.join(root, "setup-soldr"),
    rustupHome: path.join(root, "rustup"),
    cargoHome: path.join(root, "cargo"),
  };
}

// ---------------------------------------------------------------------------
// Ledger history: lets a hit report the time its last miss cost
// ---------------------------------------------------------------------------

export interface LedgerHistoryEntry {
  at: string;
  runId: string;
  layers: Array<{ layer: string; status: string; durationMs: number | null }>;
}

export function readLedgerHistory(root: string): LedgerHistoryEntry[] {
  const parsed = readJson<{ entries?: LedgerHistoryEntry[] }>(path.join(root, STATE_DIR, LEDGER_FILE));
  return Array.isArray(parsed?.entries) ? parsed!.entries : [];
}

export function appendLedgerHistory(root: string, entry: LedgerHistoryEntry): void {
  const entries = [...readLedgerHistory(root), entry].slice(-LEDGER_HISTORY_LIMIT);
  writeFileAtomic(path.join(root, STATE_DIR, LEDGER_FILE), `${JSON.stringify({ schema: 1, entries })}\n`);
}

/** Duration of the most recent miss of `layer`, the cost a hit avoided. */
export function lastMissDurationMs(history: readonly LedgerHistoryEntry[], layer: string): number | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const hit = history[i]!.layers.find((l) => l.layer === layer && l.status === "miss" && typeof l.durationMs === "number");
    if (hit) return hit.durationMs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Job entry point used by main
// ---------------------------------------------------------------------------

export interface PreparedPersistentRoot {
  root: string | null;
  choice: PersistentRootChoice;
  session: OpenResult | null;
}

/**
 * Resolve the input and open the session. Every failure degrades to the
 * hosted profile with a warning: a persistent root is an optimization and
 * must never fail a job.
 */
export function preparePersistentRoot(opts: {
  input: string;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  choose?: (o: ChoosePersistentRootOptions) => PersistentRootChoice;
}): PreparedPersistentRoot {
  const choice = (opts.choose ?? choosePersistentRoot)({ input: opts.input, env: opts.env });
  if (!choice.root) {
    if (choice.warning) opts.warn(choice.warning);
    else if ((opts.input ?? "").trim()) opts.log(`persistent-root: off (${choice.reason})`);
    return { root: null, choice, session: null };
  }
  if (opts.dryRun) return { root: choice.root, choice, session: null };
  let session: OpenResult;
  try {
    session = openPersistentSession(choice.root, sessionIdentity(opts.env));
  } catch (err) {
    opts.warn(`setup-soldr: persistent-root ${choice.root} unusable (${err instanceof Error ? err.message : String(err)}); using the GitHub Actions cache`);
    return { root: null, choice, session: null };
  }
  if (session.outcome === "busy") {
    opts.warn(`setup-soldr: persistent-root ${choice.root} is in use (${session.detail}); using the GitHub Actions cache for this job`);
    return { root: null, choice, session };
  }
  if (session.outcome === "recovered") {
    opts.warn(`setup-soldr: persistent-root ${choice.root}: ${session.detail}; removed ${session.quarantined.join(", ")} and starting cold`);
  }
  opts.log(`persistent-root: ${choice.root} from ${choice.reason}; session ${session.outcome} (${session.detail})`);
  return { root: choice.root, choice, session };
}
