// Cook cache layer — long-lived deps tarball keyed by Cargo.lock content.
//
// Per CLAUDE.md "Cache-lifetime axis" + the cook simulation findings:
// the base cook cache is long-lived/large and keyed by Cargo.lock content.
// It must NOT include SHA in the key (causes catastrophic eviction churn).
// Content-addressable keying gives parent-to-branch sharing automatically:
// same Cargo.lock = same key, regardless of branch or commit. The delta
// layer is intentionally short-lived and includes commit/build shape so
// normal code-only changes upload a small secondary archive.
//
// Save path: snapshot `target/` immediately after cook completes, before
// the user's `cargo build` adds project artifacts. The legacy path keeps
// the historical tar+zstd-19/long-window archive; the layered path delegates
// protobuf manifest and archive construction to `soldr save`.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as core from "@actions/core";
import { ToolRunner } from "@actions/exec/lib/toolrunner.js";
import * as cache from "@actions/cache";
import { compressCache, decompressCache, detectCompressMagic } from "./cache-compress.js";
import { formatLogLine } from "./log-utils.js";
import { isReservationConflict, saveReservedCache } from "./two-phase-actions-cache.js";
import { allowCacheSave, gatedSaveCache } from "./save-policy.js";

export interface CookCacheKeyParts {
  runnerOs: string;
  runnerArch: string;
  libc: string;
  rustcRelease: string;
  /** Hash of canonical-form cook flags (--release, --target, --workspace, --profile). */
  flagsHash: string;
  /** Hash of the project's Cargo.lock file (short hex). */
  lockHash: string;
  /** soldr version included so a cook output produced by a buggy soldr
   * doesn't survive across soldr upgrades. */
  soldrVersion: string;
  /** Optional user namespace used to isolate explicit validation generations. */
  keySuffix?: string;
}

export interface CookDeltaCacheKeyParts extends CookCacheKeyParts {
  /** Hash/fingerprint of the target/build shape this delta applies to. */
  buildShapeHash: string;
  /** Current Git commit SHA. Delta layers are intentionally short-lived. */
  githubSha: string;
}

export type CookDeltaCacheRestorePrefixParts = Omit<CookDeltaCacheKeyParts, "githubSha">;

/** Cook gating decision. */
export interface CookGate {
  enabled: boolean;
  reason: string;
}

export interface CookRunOpts {
  soldrBinary: string;
  projectRoot: string;
  flags: string[];
  log: (msg: string) => void;
}

export interface CookRunResult {
  exitCode: number;
  ranSeconds: number;
}

export interface CookRestoreOpts {
  exactKey: string;
  archivePath: string;
  targetDir: string;
  longWindow: number;
  debug: boolean;
  log: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Test seams for exercising corrupted cache payloads without the cache service. */
  restoreCache?: typeof cache.restoreCache;
  decompress?: typeof decompressCache;
}

export interface CookRestoreResult {
  hit: boolean;
  matchedKey: string;
  archiveBytes: number;
}

export interface CookLayerRestoreInfo {
  hit: boolean;
  matchedKey: string;
  archivePath: string;
  archiveBytes: number;
}

export interface CookLayeredRestoreOpts {
  baseKey: string;
  deltaKey: string;
  deltaRestoreKeys?: string[];
  baseArchivePath: string;
  deltaArchivePath: string;
  log: (msg: string) => void;
  warn?: (msg: string) => void;
  /**
   * #528: when false, only the base layer is restored; the delta layer is
   * never looked up. Defaults to true for library callers; the actions pass
   * their `cook-delta` input (default false).
   */
  deltaEnabled?: boolean;
  /** Test seam for exercising corrupted cache payloads without the cache service. */
  restoreCache?: typeof cache.restoreCache;
}

export interface CookLayeredRestoreResult {
  base: CookLayerRestoreInfo;
  delta: CookLayerRestoreInfo;
}

export interface CookLayerLoadReport {
  cacheFilesRestored: number | null;
  sourceFilesInManifest: number | null;
  mtimesApplied: number | null;
  mtimesSkippedMissing: number | null;
  mtimesSkippedSizeMismatch: number | null;
  mtimesSkippedModified: number | null;
}

export interface CookLayeredLoadResult {
  baseLoaded: boolean;
  deltaLoaded: boolean;
  baseReport: CookLayerLoadReport | null;
  deltaReport: CookLayerLoadReport | null;
}

export interface CookLayeredLoadOpts {
  soldrBinary: string;
  projectRoot: string;
  targetDir: string;
  baseArchivePath: string;
  deltaArchivePath: string;
  baseManifestPath: string;
  restore: CookLayeredRestoreResult;
  log: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Test seam for validating Soldr load reports without spawning a binary. */
  runSoldrJson?: typeof runSoldrJson;
}

export function layeredCookBaseReady(
  restore: CookLayeredRestoreResult,
  loaded: CookLayeredLoadResult,
): boolean {
  return restore.base.hit && loaded.baseLoaded;
}

export function layeredCookDeltaReady(
  restore: CookLayeredRestoreResult,
  loaded: CookLayeredLoadResult,
): boolean {
  return layeredCookBaseReady(restore, loaded) &&
    Boolean(restore.delta.matchedKey) &&
    loaded.deltaLoaded;
}

/**
 * Picks which layered cook archive the post step saves (#528).
 *
 * - cook did not run: nothing new to save.
 * - base missed: save the long-lived base layer.
 * - base hit: save a delta on top only when the delta layer is enabled.
 */
export function selectCookSaveLayer(
  cookRan: boolean,
  baseReady: boolean,
  deltaEnabled: boolean,
): "base" | "delta" | "none" {
  if (!cookRan) return "none";
  if (!baseReady) return "base";
  return deltaEnabled ? "delta" : "none";
}

export interface CookSaveOpts {
  targetDir: string;
  exactKey: string;
  level: string;
  longWindow: number;
  debug: boolean;
  log: (msg: string) => void;
}

export interface CookSaveResult {
  status:
    | "saved"
    | "skipped-race"
    /**
     * Pre-compress probe via `cache.restoreCache({lookupOnly: true})`
     * found an entry already at the exact key — likely a sibling job
     * won the race. We bail out BEFORE compressing so we don't burn
     * 19+ minutes on a soon-to-be-discarded archive. (#268 Fix A)
     */
    | "skipped-race-precheck"
    | "skipped-missing-target"
    | "skipped-missing-manifest"
    | "skipped-empty"
    /** #527: the shared save policy (save-cache input / event) forbade the upload. */
    | "policy-skip"
    | "failed";
  cacheId?: number;
  archiveBytes?: number;
  inflatedBytes?: number;
  fileCount?: number;
  sourceFiles?: number;
  deletedCacheFiles?: number;
  archivePath?: string;
  /**
   * #360: split timing — `compressMs` is the wall-clock spent in
   * compressCache/`soldr save`; `uploadMs` is the wall-clock spent in
   * the `@actions/cache` saveCache API call. Both present on a
   * successful save; only `compressMs` is present on skipped-race
   * (we burned compress wall-clock then lost the reservation race).
   * Neither is present on probe-bailout paths.
   */
  compressMs?: number;
  uploadMs?: number;
  reserveMs?: number;
  error?: string;
}

export interface CookLayeredSaveOpts {
  soldrBinary: string;
  projectRoot: string;
  targetDir: string;
  exactKey: string;
  archivePath: string;
  layer: "base" | "delta";
  zstdLevel: string;
  baseManifestPath?: string;
  log: (msg: string) => void;
  /** Test seam for producing a Soldr archive without spawning a binary. */
  runSoldrJson?: typeof runSoldrJson;
  /** Test seam for observing whether a produced archive reaches upload preparation. */
  saveReservedCache?: typeof saveReservedCache;
}

const COOK_KEY_PREFIX = "cook";
const COOK_BASE_KEY_PREFIX = "cook-base-v2";
const COOK_DELTA_KEY_PREFIX = "cook-delta-v2";
export const LAYERED_COOK_MIN_SOLDR_VERSION = "0.7.38";
const COOK_MODE = "soldr-cook";
const LEGACY_COOK_MODE = "cargo-chef";

/**
 * Compute the canonical flag fingerprint. Sorts and lowercases so flag
 * order doesn't perturb the key, and so `--release` vs `--RELEASE`
 * collapse. Only flags that affect cook output structure should be
 * here; cosmetic flags must be filtered upstream.
 */
export function hashCookFlags(flags: string[]): string {
  const sorted = [...flags.map((s) => s.trim()).filter((s) => s.length > 0)].sort();
  if (sorted.length === 0) return "none";
  const h = createHash("sha256");
  for (const s of sorted) {
    h.update(s);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

export function buildCookCacheKey(parts: CookCacheKeyParts): string {
  const release = parts.rustcRelease.trim() || "unresolved";
  const segments = [
    COOK_KEY_PREFIX,
    parts.runnerOs,
    parts.runnerArch,
    parts.libc,
    `rustc${release}`,
    `f${parts.flagsHash}`,
    `l${parts.lockHash}`,
    `soldr${parts.soldrVersion}`,
  ];
  if (parts.keySuffix?.trim()) segments.push(`x${keyFragment(parts.keySuffix, "none")}`);
  return segments.join("-");
}

function keyFragment(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "_");
  return cleaned || fallback;
}

function shortHash(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12);
}

function cookKeyParts(parts: CookCacheKeyParts): string[] {
  const release = keyFragment(parts.rustcRelease, "unresolved");
  const segments = [
    keyFragment(parts.runnerOs, "unknown-os"),
    keyFragment(parts.runnerArch, "unknown-arch"),
    keyFragment(parts.libc, "unknown-libc"),
    `rustc${release}`,
    `f${keyFragment(parts.flagsHash, "none")}`,
    `l${keyFragment(parts.lockHash, "no-lock")}`,
    `soldr${keyFragment(parts.soldrVersion, "unset")}`,
  ];
  if (parts.keySuffix?.trim()) segments.push(`x${keyFragment(parts.keySuffix, "none")}`);
  return segments;
}

export function buildCookBaseCacheKey(parts: CookCacheKeyParts): string {
  return [COOK_BASE_KEY_PREFIX, ...cookKeyParts(parts)].join("-");
}

export function hashCookBuildShape(value: string): string {
  return shortHash(value, "no-shape");
}

export function buildCookDeltaCacheKey(parts: CookDeltaCacheKeyParts): string {
  const sha = keyFragment(parts.githubSha || "nosha", "nosha").slice(0, 16);
  const shape = keyFragment(parts.buildShapeHash, "no-shape");
  return [
    COOK_DELTA_KEY_PREFIX,
    ...cookKeyParts(parts),
    `s${shape}`,
    `g${sha}`,
  ].join("-");
}

export function buildCookDeltaCacheRestorePrefix(parts: CookDeltaCacheRestorePrefixParts): string {
  const shape = keyFragment(parts.buildShapeHash, "no-shape");
  return [
    COOK_DELTA_KEY_PREFIX,
    ...cookKeyParts(parts),
    `s${shape}`,
  ].join("-") + "-";
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | null {
  const cleaned = value.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[.+-].*)?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1] ?? NaN),
    minor: Number(match[2] ?? NaN),
    patch: Number(match[3] ?? NaN),
  };
}

export function supportsLayeredCookCache(soldrVersion: string): boolean {
  const parsed = parseVersion(soldrVersion);
  if (!parsed) return false;
  const min = parseVersion(LAYERED_COOK_MIN_SOLDR_VERSION)!;
  if (parsed.major !== min.major) return parsed.major > min.major;
  if (parsed.minor !== min.minor) return parsed.minor > min.minor;
  return parsed.patch >= min.patch;
}

export function isCookMode(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return normalized === COOK_MODE || normalized === LEGACY_COOK_MODE;
}

/**
 * Decide whether to run cook based on the runtime environment. Returns a
 * reason string for diagnostic logging in both branches.
 */
export function decideCookGate(opts: {
  prebuildDeps: string;
  cacheUmbrella: boolean;
  lockfilePath: string;
}): CookGate {
  const mode = opts.prebuildDeps.trim().toLowerCase();
  if (mode === "" || mode === "none" || mode === "off" || mode === "false") {
    return { enabled: false, reason: `prebuild-deps=${opts.prebuildDeps || "(empty)"} - cook disabled` };
  }
  if (!isCookMode(mode)) {
    return {
      enabled: false,
      reason:
        `prebuild-deps=${opts.prebuildDeps} - unknown strategy, ` +
        `only "${COOK_MODE}" supported ("${LEGACY_COOK_MODE}" remains an alias)`,
    };
  }
  if (!opts.cacheUmbrella) {
    return { enabled: false, reason: "cache: false - cook produces no value without caching" };
  }
  if (!opts.lockfilePath) {
    return { enabled: false, reason: "no Cargo.lock found - cook needs a lockfile to derive recipe" };
  }
  if (!fs.existsSync(opts.lockfilePath)) {
    return { enabled: false, reason: `Cargo.lock path ${opts.lockfilePath} does not exist` };
  }
  return { enabled: true, reason: `${COOK_MODE} enabled` };
}

/**
 * Environment for setup-soldr's `soldr cook`: skip the shared cook-index
 * pack (soldr#3499, setup-soldr#584). On a hosted runner that index starts
 * empty and is discarded with the VM, so the 100-240 s pack is never reused;
 * the durable cook cache is the `soldr save` archive of the target dir. An
 * explicit `SOLDR_COOK_INDEX` from the workflow wins, and soldr releases that
 * predate the variable ignore it.
 */
export function cookEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) out[name] = value;
  }
  out["SOLDR_COOK_INDEX"] ??= "0";
  return out;
}

/**
 * Run `soldr cook` in the project directory. The soldr-cook mode emits
 * the recipe and runs the dependency compile. We tolerate failure: cook
 * is an optimization, not a correctness primitive, so any non-zero exit
 * is logged and the action proceeds. The user's normal `cargo build`
 * step will work fine without a cooked target.
 */
export async function runCook(opts: CookRunOpts): Promise<CookRunResult> {
  const { soldrBinary, projectRoot, flags, log } = opts;
  log(`cook: running '${soldrBinary} cook ${flags.join(" ")}' in ${projectRoot}`);
  const t0 = Date.now();
  let exitCode = 0;
  try {
    // #359: prepend MM:SS timestamps to each line of cook output (cargo's
    // Compiling/Downloading lines) so forensic analysis of slow cook
    // phases can pinpoint the bottleneck crate from the log alone.
    // ANSI color escape sequences in cargo's output pass through
    // unchanged — we only modify the line prefix, not the line body.
    // Color forcing (CARGO_TERM_COLOR/FORCE_COLOR/CLICOLOR_FORCE) is
    // already injected by resolve-setup.ts when timestamps are enabled.
    exitCode = await new ToolRunner(soldrBinary, ["cook", ...flags], {
      cwd: projectRoot,
      env: cookEnv(process.env),
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdline: (line: string): void => {
          process.stdout.write(`${formatLogLine(process.env, line)}\n`);
        },
        errline: (line: string): void => {
          process.stderr.write(`${formatLogLine(process.env, line)}\n`);
        },
      },
    }).exec();
  } catch (err) {
    log(`cook: exec threw: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }
  const ranSeconds = (Date.now() - t0) / 1000;
  if (exitCode !== 0) {
    log(`cook: failed with exit ${exitCode} after ${ranSeconds.toFixed(1)}s; continuing without cooked deps`);
  } else {
    log(`cook: completed in ${ranSeconds.toFixed(1)}s`);
  }
  return { exitCode, ranSeconds };
}

/**
 * Attempt to restore a cooked target directory from the actions cache.
 * Single exact key — no fallback ladder; cook is content-addressable so
 * a fallback would either be redundant or wrong.
 */
export async function restoreCookCache(opts: CookRestoreOpts): Promise<CookRestoreResult> {
  const { exactKey, archivePath, targetDir, longWindow, log } = opts;
  const warn = opts.warn ?? log;
  const restore = opts.restoreCache ?? cache.restoreCache;
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rm(archivePath, { force: true });
  let matched: string | undefined;
  try {
    matched = await restore([archivePath], exactKey);
  } catch (err) {
    log(`cook-cache: restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  if (!matched) {
    log(`cook-cache: no entry for key ${exactKey}`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  let archiveBytes = 0;
  try {
    archiveBytes = (await fsp.stat(archivePath)).size;
  } catch {
    warn(`cook-cache: matched key ${matched} produced an unusable payload: archive=0B (missing); treating as miss`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  if (archiveBytes === 0) {
    warn(`cook-cache: matched key ${matched} produced an unusable payload: archive=0B; treating as miss`);
    return { hit: false, matchedKey: "", archiveBytes: 0 };
  }
  // SOLDRENC-framed (encrypted) archives appear as magic="unknown" here;
  // delegate the detection to decompressCache when a cache-encrypt-key is set.
  const magic = await detectCompressMagic(archivePath);
  const haveEncryptKey = (process.env["SETUP_SOLDR_CACHE_ENCRYPT_KEY"] ?? "").trim().length > 0;
  if (magic !== "zstd" && magic !== "gzip" && !haveEncryptKey) {
    warn(
      `cook-cache: matched key ${matched} produced an unusable payload: ` +
      `archive=${archiveBytes}B codec=unknown; treating as miss`,
    );
    return { hit: false, matchedKey: matched, archiveBytes };
  }
  await fsp.mkdir(targetDir, { recursive: true });
  try {
    const decompressed = await (opts.decompress ?? decompressCache)({
      archivePath,
      targetDir,
      longWindow,
      log,
      debug: opts.debug,
      cacheKey: exactKey,
    });
    if (decompressed.fileCount === 0) {
      warn(
        `cook-cache: matched key ${matched} produced an unusable payload: ` +
        `archive=${archiveBytes}B extracted_files=${decompressed.fileCount} ` +
        `extracted_bytes=${decompressed.inflatedBytes}; treating as miss`,
      );
      return { hit: false, matchedKey: "", archiveBytes };
    }
  } catch (err) {
    warn(
      `cook-cache: matched key ${matched} produced an unusable payload: ` +
      `archive=${archiveBytes}B decompress failed: ${err instanceof Error ? err.message : String(err)}; treating as miss`,
    );
    return { hit: false, matchedKey: matched, archiveBytes };
  }
  log(`cook-cache: restored matched=${matched} archive=${archiveBytes}B target=${targetDir}`);
  return { hit: true, matchedKey: matched, archiveBytes };
}

async function archiveSize(archivePath: string): Promise<number> {
  try {
    return (await fsp.stat(archivePath)).size;
  } catch {
    return 0;
  }
}

async function restoreOneLayer(
  label: string,
  key: string,
  archivePath: string,
  restoreKeys: string[] | undefined,
  log: (msg: string) => void,
  warn: (msg: string) => void,
  restore: typeof cache.restoreCache,
): Promise<CookLayerRestoreInfo> {
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rm(archivePath, { force: true });
  let matched: string | undefined;
  try {
    matched = await restore([archivePath], key, restoreKeys ?? []);
  } catch (err) {
    log(`${label}: restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return { hit: false, matchedKey: "", archivePath, archiveBytes: 0 };
  }
  if (!matched) {
    log(`${label}: no entry for key ${key}`);
    return { hit: false, matchedKey: "", archivePath, archiveBytes: 0 };
  }
  const bytes = await archiveSize(archivePath);
  if (bytes === 0) {
    warn(`${label}: matched key ${matched} produced an unusable payload: archive=0B; treating as miss`);
    return { hit: false, matchedKey: "", archivePath, archiveBytes: 0 };
  }
  const hit = matched === key;
  log(`${label}: restored matched=${matched} exact=${hit} archive=${bytes}B`);
  return { hit, matchedKey: matched, archivePath, archiveBytes: bytes };
}

export async function restoreLayeredCookCacheArchives(
  opts: CookLayeredRestoreOpts,
): Promise<CookLayeredRestoreResult> {
  const restore = opts.restoreCache ?? cache.restoreCache;
  const warn = opts.warn ?? opts.log;
  // #295: parallel-restore base + delta instead of the previous serial
  // `await base; if (base.matchedKey) await delta` shape. The delta
  // key is independently computed (includes everything the base key
  // does + source/git fingerprint) so the two restores have no data
  // dependency. Serializing them spent ~11s wall clock per warm run
  // for zero correctness benefit — the delta restore on a base-MISS
  // was always going to be skipped on the cook side anyway (cook
  // never reads a delta archive when base wasn't restored). Cost when
  // base misses: one extra HEAD round-trip, paid in parallel anyway
  // and bounded by the larger restore. Saves up to ~11s in the
  // typical warm-cache case (zackees/setup-soldr#295 measurement on
  // Integration v0.9.30 rerun).
  const deltaMiss: CookLayerRestoreInfo = {
    hit: false,
    matchedKey: "",
    archivePath: opts.deltaArchivePath,
    archiveBytes: 0,
  };
  if (opts.deltaEnabled === false) {
    opts.log("cook-cache-delta: disabled (cook-delta=false); restoring base layer only");
    const base = await restoreOneLayer(
      "cook-cache-base", opts.baseKey, opts.baseArchivePath, [], opts.log, warn, restore,
    );
    return { base, delta: deltaMiss };
  }
  const [base, delta] = await Promise.all([
    restoreOneLayer("cook-cache-base", opts.baseKey, opts.baseArchivePath, [], opts.log, warn, restore),
    restoreOneLayer(
      "cook-cache-delta",
      opts.deltaKey,
      opts.deltaArchivePath,
      opts.deltaRestoreKeys ?? [],
      opts.log,
      warn,
      restore,
    ),
  ]);
  // Preserve the pre-#295 contract: when base missed, the delta is
  // semantically invalid even if it happened to restore (no base to
  // overlay onto). Discard the delta archive in that case so callers
  // can rely on `base.matchedKey === "" ⇒ delta.hit === false`.
  if (!base.matchedKey) {
    return {
      base,
      delta: { hit: false, matchedKey: "", archivePath: opts.deltaArchivePath, archiveBytes: 0 },
    };
  }
  return { base, delta };
}

interface SoldrJsonRun {
  code: number;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
}

async function runSoldrJson(
  soldrBinary: string,
  args: string[],
  cwd: string,
  log: (msg: string) => void,
): Promise<SoldrJsonRun> {
  let stdout = "";
  let stderr = "";
  log(`cook-cache: running '${soldrBinary} ${args.join(" ")}' in ${cwd}`);
  let code = 1;
  try {
    code = await new ToolRunner(soldrBinary, args, {
      cwd,
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString("utf8");
        },
        stderr: (data: Buffer) => {
          stderr += data.toString("utf8");
        },
      },
    }).exec();
  } catch (err) {
    stderr += err instanceof Error ? err.message : String(err);
  }
  let payload: Record<string, unknown> | null = null;
  const lastLine = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .at(-1);
  if (lastLine) {
    try {
      const parsed = JSON.parse(lastLine) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Best-effort diagnostics only; non-JSON output is still surfaced below.
    }
  }
  if (stdout.trim()) log(`cook-cache: stdout: ${stdout.trim()}`);
  if (stderr.trim()) log(`cook-cache: stderr: ${stderr.trim()}`);
  return { code, stdout, stderr, payload };
}

function numField(payload: Record<string, unknown> | null, name: string): number | null {
  const value = payload?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function loadReport(payload: Record<string, unknown> | null): CookLayerLoadReport {
  return {
    cacheFilesRestored: numField(payload, "cache_files_restored"),
    sourceFilesInManifest: numField(payload, "source_files_in_manifest"),
    mtimesApplied: numField(payload, "mtimes_applied"),
    mtimesSkippedMissing: numField(payload, "mtimes_skipped_missing"),
    mtimesSkippedSizeMismatch: numField(payload, "mtimes_skipped_size_mismatch"),
    mtimesSkippedModified: numField(payload, "mtimes_skipped_modified"),
  };
}

async function loadOneLayer(opts: {
  label: string;
  soldrBinary: string;
  projectRoot: string;
  targetDir: string;
  archivePath: string;
  manifestOut?: string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  run: typeof runSoldrJson;
}): Promise<{ loaded: boolean; report: CookLayerLoadReport | null }> {
  const args = [
    "load",
    "--archive",
    opts.archivePath,
    "--cache-dir",
    opts.targetDir,
    "--workspace",
    opts.projectRoot,
    "--json",
  ];
  if (opts.manifestOut) {
    args.push("--manifest-out", opts.manifestOut);
  }
  const result = await opts.run(opts.soldrBinary, args, opts.projectRoot, opts.log);
  if (result.code !== 0) {
    opts.warn(`${opts.label}: matched archive is unusable: soldr load failed with exit ${result.code}; treating as miss`);
    return { loaded: false, report: null };
  }
  const report = loadReport(result.payload);
  if (report.cacheFilesRestored === null || report.cacheFilesRestored <= 0) {
    opts.warn(
      `${opts.label}: matched archive is unusable: soldr load reported ` +
      `cache_files_restored=${report.cacheFilesRestored ?? "missing"}; treating as miss`,
    );
    return { loaded: false, report };
  }
  opts.log(
    `${opts.label}: loaded cache_files=${report.cacheFilesRestored ?? "?"} ` +
      `mtimes_applied=${report.mtimesApplied ?? "?"}`,
  );
  return { loaded: true, report };
}

export async function loadLayeredCookCache(
  opts: CookLayeredLoadOpts,
): Promise<CookLayeredLoadResult> {
  const warn = opts.warn ?? opts.log;
  const run = opts.runSoldrJson ?? runSoldrJson;
  if (!opts.restore.base.matchedKey) {
    return { baseLoaded: false, deltaLoaded: false, baseReport: null, deltaReport: null };
  }
  const base = await loadOneLayer({
    label: "cook-cache-base",
    soldrBinary: opts.soldrBinary,
    projectRoot: opts.projectRoot,
    targetDir: opts.targetDir,
    archivePath: opts.baseArchivePath,
    manifestOut: opts.baseManifestPath,
    log: opts.log,
    warn,
    run,
  });
  if (!base.loaded) {
    return {
      baseLoaded: false,
      deltaLoaded: false,
      baseReport: base.report,
      deltaReport: null,
    };
  }
  if (!opts.restore.delta.matchedKey) {
    return {
      baseLoaded: true,
      deltaLoaded: false,
      baseReport: base.report,
      deltaReport: null,
    };
  }
  const delta = await loadOneLayer({
    label: "cook-cache-delta",
    soldrBinary: opts.soldrBinary,
    projectRoot: opts.projectRoot,
    targetDir: opts.targetDir,
    archivePath: opts.deltaArchivePath,
    log: opts.log,
    warn,
    run,
  });
  return {
    baseLoaded: true,
    deltaLoaded: delta.loaded,
    baseReport: base.report,
    deltaReport: delta.report,
  };
}

/**
 * Tar+zstd the post-cook target directory and upload via actions cache.
 * Caller passes the same `longWindow` as the restore side so the archive
 * is readable on subsequent runs.
 */
export async function saveCookCache(opts: CookSaveOpts): Promise<CookSaveResult> {
  const { targetDir, exactKey, level, longWindow, debug, log } = opts;
  if (!allowCacheSave("cook-cache", log)) return { status: "policy-skip" };
  if (!fs.existsSync(targetDir)) return { status: "skipped-missing-target" };
  try {
    if ((await fsp.readdir(targetDir)).length === 0) return { status: "skipped-empty" };
  } catch {
    return { status: "skipped-missing-target" };
  }
  const archivePath = `${targetDir}.tar.zst`;
  const reserveStart = Date.now();
  const result = await saveReservedCache({
    paths: [archivePath],
    key: exactKey,
    layer: "cook-cache",
    log,
    produce: async () => {
      const compressStart = Date.now();
      const compressed = await compressCache({
        cacheDir: targetDir,
        codec: "zstd",
        level,
        longWindow,
        debug,
        log,
        cacheKey: exactKey,
      });
      if (!compressed.archivePath) throw new Error("compressCache returned null archive (zstd unavailable?)");
      return {
        archivePath: compressed.archivePath,
        archiveBytes: compressed.archiveBytes,
        inflatedBytes: compressed.inflatedBytes ?? undefined,
        fileCount: compressed.fileCount ?? undefined,
        compressMs: Date.now() - compressStart,
      };
    },
  });
  const reserveMs = Date.now() - reserveStart;
  if (isReservationConflict(result)) return { status: "skipped-race-precheck", reserveMs };
  if (result.status === "failed") return { status: "failed", error: result.error, reserveMs };
  const archive = result.archive!;
  return {
    status: "saved",
    cacheId: result.cacheId,
    archiveBytes: archive.archiveBytes,
    inflatedBytes: archive.inflatedBytes,
    fileCount: archive.fileCount,
    archivePath: archive.archivePath,
    compressMs: archive.compressMs,
    reserveMs,
  };
}

async function saveCookCacheLegacy(opts: CookSaveOpts): Promise<CookSaveResult> {
  const { targetDir, exactKey, level, longWindow, debug, log } = opts;
  if (!fs.existsSync(targetDir)) {
    return { status: "skipped-missing-target" };
  }
  // Bail if the directory is effectively empty — cook should have produced
  // *something*; an empty target dir indicates cook failed silently or the
  // gate let us through when it shouldn't have.
  let entryCount = 0;
  try {
    entryCount = (await fsp.readdir(targetDir)).length;
  } catch { /* */ }
  if (entryCount === 0) {
    return { status: "skipped-empty" };
  }
  // #268 Fix A: pre-compress key-existence probe. `@actions/cache`'s
  // `restoreCache(paths, key, _, { lookupOnly: true })` issues a
  // HEAD-like call that returns the matched key (if any) without
  // downloading anything. When it returns truthy, a parallel job has
  // already saved this exact key — we'd lose the reservation race
  // after a 19-min `--zstd-level 19` compress anyway, so we skip the
  // compress entirely and avoid the wasted wall-clock. Restore-side
  // benefits because the sibling job's entry is now the durable
  // record. (See zccache PR #480 — 19m 5s burned for this exact race.)
  //
  // `paths` must match what `saveCache([archivePath], exactKey)` will
  // pass later — `cacheUtils.getCacheVersion` hashes the path list
  // into the cache version, so a mismatch returns null even on hit.
  // `compressCache` derives archivePath as `${cacheDir}.tar.zst`
  // (cache-compress.ts:743), so we can predict it without compressing.
  const probeArchivePath = `${targetDir}.tar.zst`;
  try {
    const existing = await cache.restoreCache(
      [probeArchivePath],
      exactKey,
      [],
      { lookupOnly: true },
    );
    if (existing) {
      log(
        `cook-cache: pre-compress probe found existing entry for key=${exactKey} — ` +
          `skipping compress + save to avoid the reservation-race wall-clock waste ` +
          `(setup-soldr#268 Fix A)`,
      );
      return { status: "skipped-race-precheck" };
    }
  } catch (err) {
    // Probe failure is non-fatal — proceed to the legacy compress+save
    // path so we don't regress reliability.
    if (debug) {
      log(
        `cook-cache: pre-compress key probe threw (${err instanceof Error ? err.message : String(err)}) — falling back to compress+save`,
      );
    }
  }
  let archivePath: string | null = null;
  let archiveBytes: number | undefined;
  let inflatedBytes: number | undefined;
  let fileCount: number | undefined;
  // #268 Fix B: capture compress wall-clock so a race-loss after a long
  // compress is loud, not silent. Operators reading the log shouldn't
  // have to scroll to spot 19 wasted minutes.
  const compressStart = Date.now();
  try {
    const compress = await compressCache({
      cacheDir: targetDir,
      codec: "zstd",
      level,
      longWindow,
      debug,
      log,
      cacheKey: exactKey,
    });
    archivePath = compress.archivePath;
    archiveBytes = compress.archiveBytes;
    if (compress.inflatedBytes !== null) inflatedBytes = compress.inflatedBytes;
    if (compress.fileCount !== null) fileCount = compress.fileCount;
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (!archivePath) {
    return { status: "failed", error: "compressCache returned null archive (zstd unavailable?)" };
  }
  const compressMs = Date.now() - compressStart;
  const uploadStart = Date.now();
  try {
    const id = await gatedSaveCache("cook-cache", [archivePath], exactKey, log);
    const uploadMs = Date.now() - uploadStart;
    if (id <= 0) {
      // @actions/cache returns -1 when reserveCache fails — typically
      // because the key already exists (parallel job got there first)
      // or the cache budget is exhausted. Not an error: future runs
      // will hit the entry the other job saved.
      log(
        `cook-cache: save did not reserve a new entry (id=${id}) — likely a parallel ` +
          `job already saved key=${exactKey} or repo cache budget is exhausted`,
      );
      // #268 Fix B: when the compress was meaningfully expensive
      // (>30s) and we end up discarding the upload, surface a top-
      // level warning so it shows up in the job's annotations panel.
      // Fix A (reserve key BEFORE compressing) is the real fix but
      // requires plumbing two-phase cache APIs; this raises the
      // visibility of the symptom in the meantime.
      const COMPRESS_WASTE_WARN_MS = 30_000;
      if (compressMs >= COMPRESS_WASTE_WARN_MS) {
        const seconds = (compressMs / 1000).toFixed(0);
        const archiveDisplay = archiveBytes
          ? `${(archiveBytes / (1024 * 1024)).toFixed(1)} MiB`
          : "unknown size";
        core.warning(
          `setup-soldr: cook-cache spent ${seconds}s compressing a ${archiveDisplay} ` +
            `archive then lost the cache reservation race for key=${exactKey}. ` +
            `That wall-clock was burned — see setup-soldr#268 for the fix-A (reserve ` +
            `key BEFORE compressing) tracking issue.`,
        );
      }
      return {
        status: "skipped-race",
        cacheId: id,
        archiveBytes,
        inflatedBytes,
        fileCount,
        archivePath,
        compressMs,
        uploadMs,
      };
    }
    log(`cook-cache: saved id=${id} key=${exactKey} archive=${archivePath}`);
    return {
      status: "saved",
      cacheId: id,
      archiveBytes,
      inflatedBytes,
      fileCount,
      archivePath,
      compressMs,
      uploadMs,
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      archivePath,
    };
  }
}

function saveReport(payload: Record<string, unknown> | null): {
  sourceFiles: number | null;
  cacheFiles: number | null;
  deletedCacheFiles: number | null;
  archiveBytes: number | null;
} {
  return {
    sourceFiles: numField(payload, "source_files"),
    cacheFiles: numField(payload, "cache_files"),
    deletedCacheFiles: numField(payload, "deleted_cache_files"),
    archiveBytes: numField(payload, "archive_bytes"),
  };
}

export async function saveLayeredCookCache(opts: CookLayeredSaveOpts): Promise<CookSaveResult> {
  const { soldrBinary, projectRoot, targetDir, exactKey, archivePath, layer, zstdLevel, log } = opts;
  if (!allowCacheSave(`cook-cache-${layer}`, log)) return { status: "policy-skip" };
  if (!fs.existsSync(targetDir)) return { status: "skipped-missing-target" };
  try {
    if ((await fsp.readdir(targetDir)).length === 0) return { status: "skipped-empty" };
  } catch {
    return { status: "skipped-missing-target" };
  }
  if (layer === "delta" && (!opts.baseManifestPath || !fs.existsSync(opts.baseManifestPath))) {
    return { status: "skipped-missing-manifest" };
  }
  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rm(archivePath, { force: true });
  const args = ["save", "--cache-dir", targetDir, "--workspace", projectRoot, "--out", archivePath, "--zstd-level", zstdLevel, "--json"];
  if (layer === "delta") args.push("--delta-from-manifest", opts.baseManifestPath as string);
  const reserveStart = Date.now();
  const saveReserved = opts.saveReservedCache ?? saveReservedCache;
  const run = opts.runSoldrJson ?? runSoldrJson;
  const result = await saveReserved({
    paths: [archivePath],
    key: exactKey,
    layer: `cook-cache-${layer}`,
    log,
    produce: async () => {
      const compressStart = Date.now();
      const soldrSave = await run(soldrBinary, args, projectRoot, log);
      if (soldrSave.code !== 0) throw new Error(`soldr save ${layer} exited ${soldrSave.code}`);
      const report = saveReport(soldrSave.payload);
      // A successful Soldr exit and a non-empty Actions-cache wrapper do not
      // prove that the inner archive is usable. Validate the serialized file
      // itself before upload so an immutable exact key cannot be poisoned.
      let archiveBytes: number;
      try {
        archiveBytes = (await fsp.stat(archivePath)).size;
      } catch {
        throw new Error(
          `cook-cache-${layer}: refusing to upload archive that does not exist for ` +
            `key=${exactKey} path=${archivePath}; immutable cache entries cannot be repaired in place`,
        );
      }
      if (archiveBytes === 0) {
        throw new Error(
          `cook-cache-${layer}: refusing to upload archive with zero bytes for ` +
            `key=${exactKey} path=${archivePath}; immutable cache entries cannot be repaired in place`,
        );
      }
      return {
        archivePath,
        archiveBytes,
        fileCount: report.cacheFiles ?? undefined,
        sourceFiles: report.sourceFiles ?? undefined,
        deletedCacheFiles: report.deletedCacheFiles ?? undefined,
        compressMs: Date.now() - compressStart,
      };
    },
  });
  const reserveMs = Date.now() - reserveStart;
  if (isReservationConflict(result)) return { status: "skipped-race-precheck", archivePath, reserveMs };
  if (result.status === "failed") return { status: "failed", archivePath, error: result.error, reserveMs };
  const archive = result.archive!;
  return {
    status: "saved",
    cacheId: result.cacheId,
    archiveBytes: archive.archiveBytes,
    fileCount: archive.fileCount,
    sourceFiles: archive.sourceFiles,
    deletedCacheFiles: archive.deletedCacheFiles,
    archivePath,
    compressMs: archive.compressMs,
    reserveMs,
  };
}

async function saveLayeredCookCacheLegacy(opts: CookLayeredSaveOpts): Promise<CookSaveResult> {
  const { soldrBinary, projectRoot, targetDir, exactKey, archivePath, layer, zstdLevel, log } = opts;
  if (!fs.existsSync(targetDir)) {
    return { status: "skipped-missing-target" };
  }
  let entryCount = 0;
  try {
    entryCount = (await fsp.readdir(targetDir)).length;
  } catch { /* */ }
  if (entryCount === 0) {
    return { status: "skipped-empty" };
  }
  if (layer === "delta") {
    const manifest = opts.baseManifestPath ?? "";
    if (!manifest || !fs.existsSync(manifest)) {
      return { status: "skipped-missing-manifest" };
    }
  }

  await fsp.mkdir(path.dirname(archivePath), { recursive: true });
  await fsp.rm(archivePath, { force: true });

  const args = [
    "save",
    "--cache-dir",
    targetDir,
    "--workspace",
    projectRoot,
    "--out",
    archivePath,
    "--zstd-level",
    zstdLevel,
    "--json",
  ];
  if (layer === "delta") {
    args.push("--delta-from-manifest", opts.baseManifestPath as string);
  }

  // #268 Fix A: pre-compress probe — bail out if a sibling job already
  // saved this exact key. The layered path uses `soldr save
  // --zstd-level 19` which is the dominant 19-minute wall-clock burner
  // on the cook-base archive (zccache PR #480). Probe is a HEAD-like
  // call costing ~100-1000 ms; far cheaper than the full compress.
  // `paths` must match the later `saveCache([archivePath], exactKey)`
  // — the version hash includes the path list (cacheUtils.getCacheVersion).
  try {
    const existing = await cache.restoreCache(
      [archivePath],
      exactKey,
      [],
      { lookupOnly: true },
    );
    if (existing) {
      log(
        `cook-cache-${layer}: pre-compress probe found existing entry for key=${exactKey} ` +
          `— skipping compress + save (setup-soldr#268 Fix A)`,
      );
      return { status: "skipped-race-precheck", archivePath };
    }
  } catch (err) {
    // Probe failure is non-fatal — fall through to legacy compress+save.
    log(
      `cook-cache-${layer}: pre-compress key probe threw (${err instanceof Error ? err.message : String(err)}) — falling back to compress+save`,
    );
  }

  // #268 Fix B: capture compress wall-clock so a race-loss after a long
  // compress is loud, not silent (mirrors the non-layered path above).
  const compressStart = Date.now();
  const run = await runSoldrJson(soldrBinary, args, projectRoot, log);
  if (run.code !== 0) {
    return {
      status: "failed",
      error: `soldr save ${layer} exited ${run.code}`,
      archivePath,
    };
  }
  const compressMs = Date.now() - compressStart;

  const report = saveReport(run.payload);
  const archiveBytes = report.archiveBytes ?? await archiveSize(archivePath);
  const uploadStart = Date.now();
  try {
    const id = await gatedSaveCache(`cook-cache-${layer}`, [archivePath], exactKey, log);
    const uploadMs = Date.now() - uploadStart;
    if (id <= 0) {
      log(
        `cook-cache-${layer}: save did not reserve a new entry (id=${id}) ` +
          `for key=${exactKey}`,
      );
      // #268 Fix B: same surface-as-warning treatment as the non-
      // layered path. The layered path uses `soldr save --zstd-level
      // 19` which is the dominant wall-clock burner (zccache PR #480
      // observed 19m 5s before losing the race).
      const COMPRESS_WASTE_WARN_MS = 30_000;
      if (compressMs >= COMPRESS_WASTE_WARN_MS) {
        const seconds = (compressMs / 1000).toFixed(0);
        const archiveDisplay = archiveBytes
          ? `${(archiveBytes / (1024 * 1024)).toFixed(1)} MiB`
          : "unknown size";
        core.warning(
          `setup-soldr: cook-cache-${layer} spent ${seconds}s compressing a ` +
            `${archiveDisplay} archive then lost the cache reservation race for ` +
            `key=${exactKey}. That wall-clock was burned — see setup-soldr#268 ` +
            `for the fix-A (reserve key BEFORE compressing) tracking issue.`,
        );
      }
      return {
        status: "skipped-race",
        cacheId: id,
        archiveBytes,
        fileCount: report.cacheFiles ?? undefined,
        sourceFiles: report.sourceFiles ?? undefined,
        deletedCacheFiles: report.deletedCacheFiles ?? undefined,
        archivePath,
        compressMs,
        uploadMs,
      };
    }
    log(`cook-cache-${layer}: saved id=${id} key=${exactKey} archive=${archivePath}`);
    return {
      status: "saved",
      cacheId: id,
      archiveBytes,
      fileCount: report.cacheFiles ?? undefined,
      sourceFiles: report.sourceFiles ?? undefined,
      deletedCacheFiles: report.deletedCacheFiles ?? undefined,
      archivePath,
      compressMs,
      uploadMs,
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      archiveBytes,
      fileCount: report.cacheFiles ?? undefined,
      sourceFiles: report.sourceFiles ?? undefined,
      deletedCacheFiles: report.deletedCacheFiles ?? undefined,
      archivePath,
    };
  }
}

/** Tokenize a free-form flags string into a flags array. Whitespace-split. */
export function parseCookFlags(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * From a flags array, extract only the tokens that materially affect cook
 * output structure for hashing. Excludes verbosity / colour flags.
 *
 * Conservative: keep anything that isn't on a known-cosmetic list. This
 * over-keys (extra misses on cosmetic-only changes) rather than under-keys
 * (serving stale cooked artifacts under a key that doesn't reflect them).
 */
export function canonicalizeCookFlags(flags: string[]): string[] {
  const COSMETIC = new Set([
    "--verbose", "-v", "-vv", "--quiet", "-q",
    "--color=auto", "--color=always", "--color=never",
    "--no-default-features", // affects output; KEEP — moved out below
  ]);
  COSMETIC.delete("--no-default-features"); // safety net for the comment above
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i] as string;
    if (COSMETIC.has(f)) continue;
    if (f === "--color" || f === "--message-format") {
      i += 1; // skip the value
      continue;
    }
    out.push(f);
  }
  return out;
}
