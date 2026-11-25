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
 *   lookup, so a warm root makes no cache round trip at all. Two exceptions
 *   read but never write: the cook base layer on a local miss (#675), and a
 *   cold zccache or cargo-registry layer, seeded once from the Actions
 *   cache (#691);
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
 *
 * A JSON descriptor may also carry `root` (an absolute path). The root is then
 * `<root>/<os>-<arch>-u<uid>`, with no RUNNER_NAME component. Such a
 * descriptor is per runner container (one runner owns it), so elastic pools
 * get the same in-container paths on every runner and host and their
 * compile-cache keys match. The `.clean`, quarantine and session-lock rules
 * are unchanged.
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
const BOOT_MARKER = "clean-for-boot.json";
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

export interface HostDescriptor {
  /** Host store directory. */
  store: string;
  /**
   * Fixed root base from the JSON descriptor's optional `root` field, or null.
   * When set, the persistent root is `<root>/<os>-<arch>-u<uid>` with no
   * RUNNER_NAME component: the descriptor is per runner container, so the
   * paths inside the job (CARGO_HOME, RUSTUP_HOME, the zccache dir) are the
   * same on every runner and host, and compile-cache keys match across them.
   */
  root: string | null;
}

/** Parse a descriptor file, or null if unusable. */
export function parseDescriptor(descriptorPath: string, content: string): HostDescriptor | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { schema?: unknown; store?: unknown; root?: unknown };
      if (parsed.schema !== 1) return null;
      if (typeof parsed.store !== "string" || !path.isAbsolute(parsed.store)) return null;
      let root: string | null = null;
      if (parsed.root !== undefined) {
        if (typeof parsed.root !== "string" || !path.isAbsolute(parsed.root)) return null;
        root = path.resolve(parsed.root);
      }
      return { store: path.resolve(parsed.store), root };
    } catch {
      return null;
    }
  }
  // Plain marker (obs-runner's `.persistent-cache` holds the host name).
  return { store: path.dirname(path.resolve(descriptorPath)), root: null };
}

/** The store directory a descriptor file names, or null if unusable. */
export function storeFromDescriptor(descriptorPath: string, content: string): string | null {
  return parseDescriptor(descriptorPath, content)?.store ?? null;
}

/** Fixed (runner-independent) per-platform, per-uid root under a descriptor's `root`. */
export function fixedRoot(base: string, platform: string, arch: string, uid: number): string {
  return path.join(base, `${platform}-${arch}-u${uid}`);
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
    const descriptor = parseDescriptor(candidate, content);
    if (!descriptor) {
      return off(
        `unusable descriptor ${candidate}`,
        `setup-soldr: host descriptor ${candidate} is not schema 1 with an absolute store (and, if set, an absolute root); using the GitHub Actions cache`,
      );
    }
    const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    if (descriptor.root) {
      return {
        root: fixedRoot(descriptor.root, platform, arch, uid),
        source: "descriptor",
        reason: `host descriptor ${candidate} (fixed root)`,
      };
    }
    const runner = (env["RUNNER_NAME"] ?? "").trim();
    if (!runner) return off(`descriptor ${candidate} but no RUNNER_NAME`);
    return {
      root: slotRoot(descriptor.store, runner, platform, arch, uid),
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

/** Boot-scoped checkpoints never trust a cache across a kernel restart. */
function checkpointBootId(): string {
  if (process.platform !== "linux" || process.env["SETUP_SOLDR_PERSISTENT_CHECKPOINT"] !== "boot") return "";
  try {
    const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return /^[0-9a-f-]{36}$/.test(id) ? id : "";
  } catch {
    return "";
  }
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
  opts: { now?: () => number; bootId?: () => string } = {},
): OpenResult {
  const now = opts.now ?? Date.now;
  fs.mkdirSync(root, { recursive: true });
  fs.accessSync(root, fs.constants.W_OK);
  const stateDir = path.join(root, STATE_DIR);
  const sessionPath = path.join(stateDir, SESSION_FILE);
  const cleanPath = path.join(root, CLEAN_MARKER);
  const previous = readJson<SessionRecord>(sessionPath);
  const bootMarkerPath = path.join(stateDir, BOOT_MARKER);
  const bootId = (opts.bootId ?? checkpointBootId)();
  const bootMarker = readJson<{ schema: number; bootId: string; openedAt: string; pid: number }>(bootMarkerPath);
  const sessionClosed = previous && bootMarker?.schema === 1
    && bootMarker.openedAt === previous.openedAt && bootMarker.pid === previous.pid;
  const wasClean = fs.existsSync(cleanPath) || (bootId !== "" && sessionClosed && bootMarker.bootId === bootId);
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
  } else if (previous && !sessionClosed && sameJob(previous, identity)) {
    return { outcome: "reentrant", detail: "session already open in this job", quarantined };
  } else if (
    previous &&
    !sessionClosed &&
    previous.runner &&
    identity.runner &&
    previous.runner !== identity.runner &&
    now() - Date.parse(previous.openedAt) < STALE_SESSION_MS
  ) {
    return { outcome: "busy", detail: `open session held by runner ${previous.runner} run ${previous.runId}`, quarantined };
  } else {
    outcome = "recovered";
    if (sessionClosed) {
      detail = "previous boot checkpoint is ineligible";
    } else {
      detail = previous
        ? `session of ${previous.runner || "?"} run ${previous.runId || "?"} (opened ${previous.openedAt}) never closed`
        : "content without a clean marker";
    }
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
  unlinkDurable(cleanPath);
  unlinkDurable(bootMarkerPath);
  writeFileAtomic(sessionPath, `${JSON.stringify(record)}\n`);
  return { outcome, detail, quarantined };
}

/**
 * Close the session after all writers have stopped and setup has completed.
 * A boot-scoped checkpoint deliberately becomes invalid after a reboot.
 */
export function closePersistentSession(
  root: string,
  opts: { sync?: (dir: string) => void; now?: () => number; bootId?: () => string } = {},
): void {
  const bootId = (opts.bootId ?? checkpointBootId)();
  const marker = { schema: 1, closedAt: new Date((opts.now ?? Date.now)()).toISOString() };
  if (bootId) {
    const stateDir = path.join(root, STATE_DIR);
    const session = readJson<SessionRecord>(path.join(stateDir, SESSION_FILE));
    if (!session) throw new Error("persistent session record is missing");
    const checkpoint = { ...marker, bootId, openedAt: session.openedAt, pid: session.pid };
    writeFileAtomic(path.join(stateDir, BOOT_MARKER), `${JSON.stringify(checkpoint)}\n`);
    return;
  }
  (opts.sync ?? syncFilesystem)(root);
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
  opts: { seedFromActions?: boolean } = {},
): boolean {
  const root = activePersistentRoot(env);
  if (!root) return false;
  if (opts.seedFromActions) {
    // #691: the layer is cold on this root (new, evicted or quarantined), so
    // read it once from the Actions cache, the way the cook base layer does
    // (#675). Read-only: allowCacheSave still refuses every save on a root.
    if (!loggedBypass.has(`seed:${layer}`)) {
      loggedBypass.add(`seed:${layer}`);
      log(`${layer}: persistent-root ${root} is cold; seeding read-only from the GitHub Actions cache (#691)`);
    }
    return false;
  }
  if (!loggedBypass.has(layer)) {
    loggedBypass.add(layer);
    log(`${layer}: GitHub Actions cache skipped: persistent-root ${root}`);
  }
  return true;
}

/**
 * #691: a persistent layer is cold when its directory is missing or empty:
 * a new root, an evicted one, or one whose content was quarantined because
 * its last session never closed (no `.clean`). A cold layer may be seeded
 * read-only from the Actions cache; a warm one never leaves the runner.
 */
export function persistentLayerCold(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/** Entries of a zccache dir that are bookkeeping, not compiled artifacts. */
const ZCCACHE_TOP_BOOKKEEPING = new Set(["logs", "history"]);
const ZCCACHE_FILE_BOOKKEEPING = new Set(["image-source", ".writer.lock", ".last-active"]);

/**
 * #691 / gh-runner#75: the zccache layer of a root is cold when it holds no
 * artifact, not merely when its directory is empty. A store the soldr
 * broker swept after its daemon exited leaves `logs/`, `history/` and
 * `daemon-state/<route>/image-source` behind; read as "non-empty", that
 * root was warm forever and never seeded, while every compile missed.
 * Stops at the first artifact, so a warm store costs one short walk.
 */
export function zccacheStoreCold(dir: string): boolean {
  const walk = (current: string, top: boolean): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (top && ZCCACHE_TOP_BOOKKEEPING.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (walk(path.join(current, entry.name), false)) return true;
      } else if (!ZCCACHE_FILE_BOOKKEEPING.has(entry.name)) {
        return true;
      }
    }
    return false;
  };
  return !walk(dir, true);
}

/**
 * gh-runner#75: opt-in for seeding a cold root's zccache store from a hosted
 * run's entry. A zccache hit needs the same daemon route and the same
 * absolute workspace and CARGO_HOME paths as the run that wrote the store;
 * only a host that runs jobs at hosted-identical paths should set it.
 */
export const ZCCACHE_SEED_ENV = "SETUP_SOLDR_ZCCACHE_SEED";

export function zccacheSeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env[ZCCACHE_SEED_ENV] ?? "").trim().toLowerCase());
}

/** RUNNER_TEMP of a GitHub-hosted runner of this OS. */
export function hostedRunnerTemp(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "D:\\a\\_temp";
  if (platform === "darwin") return "/Users/runner/work/_temp";
  return "/home/runner/work/_temp";
}

export interface HostedSeedPaths {
  /** The path a GitHub-hosted run saved: it keys the cache entry's version. */
  versionPath: string;
  /** Where that entry's archive extracts on this runner. */
  landingPath: string;
}

/**
 * #691 / gh-runner#75: `@actions/cache` hashes the literal `paths` into the
 * entry version, so a cold root asking for its own archive path
 * (`<root>/setup-soldr-soldr/cache/zccache.tar.zst`) never matched the
 * entry a hosted run saved as `<RUNNER_TEMP>/setup-soldr-soldr/...`, even
 * with the exact key ("no match"). A root lays out its state under the root
 * as a hosted run does under RUNNER_TEMP, so the hosted path is the same
 * relative path under the hosted RUNNER_TEMP. The archive's members are
 * relative to the hosted GITHUB_WORKSPACE (`<work>/<repo>/<repo>`) and
 * extract relative to this runner's workspace. Null when `archivePath` is
 * not under the root or the repository is unknown.
 */
export function hostedSeedPaths(opts: {
  archivePath: string;
  persistentRoot: string;
  workspace: string;
  repository: string;
  platform?: NodeJS.Platform;
}): HostedSeedPaths | null {
  const rel = path.relative(opts.persistentRoot, opts.archivePath);
  const repo = opts.repository.split("/").pop() ?? "";
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !repo || !opts.workspace) return null;
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const temp = hostedRunnerTemp(platform);
  const versionPath = p.join(temp, ...rel.split(path.sep));
  const hostedWorkspace = p.join(p.dirname(temp), repo, repo);
  const member = p.relative(hostedWorkspace, versionPath);
  return { versionPath, landingPath: path.resolve(opts.workspace, ...member.split(p.sep)) };
}

/** Move a seeded archive into place; the two may sit on different mounts. */
export function moveSeededArchive(from: string, to: string): void {
  if (path.resolve(from) === path.resolve(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
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
