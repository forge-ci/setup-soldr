// setup-soldr post-job entry point. Owned by Agent 2.
//
// Runs in the post-job phase via action.yml's `post: dist/post.js`. This is
// the architectural fix for zackees/setup-soldr#70 — it lets us tar+zstd
// the build-cache (and optionally cargo-registry) directories BEFORE
// @actions/cache's post-save uploads them, so the wire format is zstd on
// every platform (including Windows-x64 where actions/cache@v5 still
// falls back to gzip).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as core from "@actions/core";
import { verdictPost } from "./lib/verdict-setup.js";
import * as cache from "@actions/cache";
import { compressCache, type CachePayloadProfile } from "./lib/cache-compress.js";
import {
  deleteCorruptSoloCacheEntries,
  saveSoloCache,
  soloCacheEntryExistsForRef,
  soloCacheArchivePath,
  stageDiffForSave,
  type RootMap as SoloRootMap,
} from "./lib/solo-toolchain-cache.js";
import type { SnapshotDiff } from "./lib/toolchain-snapshot.js";
import { saveCookCache, saveLayeredCookCache } from "./lib/cook-cache.js";
import { saveMiniCache } from "./lib/soldr-mini-cache.js";
// Static import — the dynamic `await import("./lib/soldr-load-shim.js")`
// form ncc compiled in #265 produced a side-chunk (`<id>.index.js`)
// under `dist-post/`. Static keeps this in the main bundle (zero new
// chunk file). `bundle-entrypoint.mjs` now also copies any *transitive*
// chunk files (e.g. @actions/artifact → @azure/identity inner chunks)
// into `dist/` so they resolve at runtime — but converting our own
// dynamic import to static is the cleaner shape regardless.
import {
  cargoRegistryPayloadCensus,
  saveCargoRegistryArchive,
} from "./lib/cargo-registry-archive.js";
import { createLogger } from "./lib/log-utils.js";
import { shutdownCacheDaemons } from "./lib/shutdown-cache.js";
import { StatsCollector } from "./lib/stats-collector.js";
import {
  aggregateSessions,
  collectArchivedSessionStats,
  decideBuildCacheSave,
  decideTargetCacheSave,
  detectCookReuseMismatch,
  parseMinCompiles,
  parseVerifyCompileCacheMode,
  renderInsights,
  renderMultiSessionRollup,
  verifyCompileCacheActivity,
  type MultiSessionRollup,
} from "./lib/compile-cache-stats.js";
import { captureProcessSnapshot, dumpDiagnostics, loggingEnabled } from "./lib/diagnostics.js";
import { readRawInputs } from "./lib/raw-inputs.js";
import { CLEAN_SAVE_MARKER, type CleanSaveProof } from "./lib/ancestor-cache-github.js";
import { parseAncestorKey } from "./lib/ancestor-cache.js";
import { cacheProfileDefault, isLocalRunner, resolveCacheProfileInput } from "./lib/local-profile.js";
import { allowCacheSave, gatedSaveCache } from "./lib/save-policy.js";
import {
  deleteCacheEntriesByKeys,
  evictIfOverBudget,
  type CacheEvictionPolicy,
} from "./lib/cache-eviction.js";
import { auditDependencyYanks, readYankAuditResult, resolveYankAuditResult, type YankAuditWorkerConfig } from "./lib/yank-audit.js";
import {
  snapshotSourceMtimes,
  writeSnapshotFile,
  SNAPSHOT_FILENAME,
} from "./lib/source-mtime-snapshot.js";
import type {
  CachePayloadCensus,
  CompileCacheStatsMode,
  RawInputs,
  ResolveResult,
  StatsMode,
} from "./lib/types.js";
import { publishBundleToolCache } from "./lib/bundle-tool-cache.js";
import { FAILED_JOB_SKIP_STATUS, readBuildOutputSaveGate } from "./lib/failed-job-save.js";

type RestoreStatus = "disabled" | "exact-hit" | "restore-key-hit" | "miss";
type SaveStatus =
  | "disabled"
  | "not-managed-in-post"
  | "exact-hit-skip"
  | "missing-dir-skip"
  | "oversize-skip"
  | "race-skip"
  | "tiny-delta-skip"
  | "policy-skip"
  | typeof FAILED_JOB_SKIP_STATUS
  | "saved"
  | "failed";

interface CacheSavePhaseTimings {
  compressMs?: number;
  uploadMs?: number;
}

interface CacheSaveResult {
  status: SaveStatus;
  cache_dir?: string;
  archive_path?: string;
  saved_paths?: string[];
  cache_id?: number;
  error?: string;
  archiveBytes?: number | null;
  inflatedBytes?: number | null;
  fileCount?: number | null;
  payload?: CachePayloadCensus | null;
  /** Per-phase save timing (issue #214). */
  phaseTimings?: CacheSavePhaseTimings;
  /** Reason text for a gated skip (e.g. tiny-delta). */
  skip_reason?: string;
}

interface CacheLayerSummary {
  enabled: boolean;
  key: string;
  matched_key: string;
  exact_hit: boolean;
  restore_status: RestoreStatus;
  save: CacheSaveResult;
}

interface ZccacheSessionSummary {
  stats_path: string;
  present: boolean;
  status: string;
  stats?: Record<string, unknown>;
  error?: string;
}

/**
 * Output of `soldr cache report --json`. Always present in the post-step
 * payload even when the soldr binary is missing or returns an error - the
 * `status` field tells consumers which fields are populated.
 *
 * Status values:
 *  - "ok": `report` is set; soldr returned a parseable envelope.
 *  - "missing-binary": SOLDR_BINARY env var was not set or pointed at a
 *    nonexistent path. Older setup-soldr versions or shimming oddities.
 *  - "unsupported": the installed soldr does not have the `cache report`
 *    subcommand (i.e. < 0.7.22). The `error` field carries soldr's exit
 *    line so callers can tell user vs version-skew failures apart.
 *  - "error": soldr exited non-zero or returned unparseable JSON.
 */
interface SoldrCacheReportSummary {
  status: "ok" | "missing-binary" | "unsupported" | "error";
  soldr_version?: string;
  managed_zccache_version?: string;
  error?: string;
  /** Verbatim copy of `soldr cache report --json` stdout, parsed. */
  report?: Record<string, unknown>;
}

export interface FinalCacheSummary {
  schema_version: 1;
  setup_cache: CacheLayerSummary;
  target_cache: CacheLayerSummary;
  build_cache: CacheLayerSummary;
  cargo_registry_cache: CacheLayerSummary;
  zccache_session: ZccacheSessionSummary;
  /** Added in setup-soldr#98. Populated by post-step from `soldr cache report --json`. */
  compile_cache_report: SoldrCacheReportSummary;
  /**
   * Added in setup-soldr#98 PR4. Roll-up over every per-invocation session
   * archived under `<build-cache>/logs/archive/<session-id>/` via
   * `soldr cache shutdown --archive-logs` (soldr#379). Present unconditionally
   * but `sessionCount` is 0 on jobs where no archive directory was created
   * (e.g. soldr too old, or only one cargo command ran with no archival).
   */
  multi_session_rollup: MultiSessionRollup;
}

interface RestoreState {
  setupCacheEnabled: boolean;
  setupCacheExactHit: boolean;
  setupCacheMatchedKey: string;
  targetCacheEnabled: boolean;
  targetCacheExactHit: boolean;
  targetCacheMatchedKey: string;
  buildCacheEnabled: boolean;
  buildCacheExactHit: boolean;
  buildCacheMatchedKey: string;
  cargoRegistryCacheEnabled: boolean;
  cargoRegistryCacheExactHit: boolean;
  cargoRegistryCacheMatchedKey: string;
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function cachePathExists(p: string): boolean {
  try {
    if (!p.includes("*")) return fs.existsSync(p);
    const firstStar = p.indexOf("*");
    const slash = Math.max(p.lastIndexOf(path.sep, firstStar), p.lastIndexOf("/", firstStar), p.lastIndexOf("\\", firstStar));
    const dir = slash >= 0 ? p.slice(0, slash) : ".";
    const prefix = p.slice(slash + 1, firstStar);
    return fs.readdirSync(dir).some((entry) => entry.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * setup-soldr#538: the success marker written by `soldr dylint`/
 * `soldr cargo dylint` (crates/soldr-cli/src/dylint_toolchain.rs
 * `write_success_marker`) always records the channel Soldr's own
 * `prepare_resolved` -> `qualify_toolchain_name` resolved it to, which is the
 * host-qualified rustup toolchain directory name
 * (`<channel>-<host-triple>`, e.g. `nightly-2026-05-28-x86_64-unknown-linux-gnu`)
 * -- not the short requested channel. `resolve-setup.ts`'s `dylintCacheIdentity`
 * is always built from the short channel (the same value it exports as
 * `SOLDR_DYLINT_CONFIGURED_TOOLCHAIN`), so a bare string comparison against
 * the marker never matches and every successful Dylint run skips both
 * `dylint-cache` and `dylint-output-cache` saves.
 *
 * Accept either spelling of the channel segment (bare or host-qualified);
 * the compiler release and full 40-char commit hash must still match
 * exactly, since those two alone already pin the exact compiler that ran.
 */
export function dylintMarkerIdentityMatches(
  markerContent: string,
  cacheIdentity: string,
  hostTriple: string,
): boolean {
  const marker = markerContent.trim();
  const expected = cacheIdentity.trim();
  if (marker.length === 0 || expected.length === 0) return false;
  if (marker === expected) return true;
  const markerParts = marker.split("|");
  const expectedParts = expected.split("|");
  if (markerParts.length !== 3 || expectedParts.length !== 3) return false;
  const [markerChannel, markerRelease, markerCommit] = markerParts as [string, string, string];
  const [expectedChannel, expectedRelease, expectedCommit] = expectedParts as [
    string,
    string,
    string,
  ];
  if (markerRelease !== expectedRelease || markerCommit !== expectedCommit) return false;
  if (!hostTriple) return false;
  return markerChannel === `${expectedChannel}-${hostTriple}`;
}

function stateBool(name: string, fallback = false): boolean {
  const value = core.getState(name).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/**
 * Decide whether the post-phase diagnostic dump includes the verbatim
 * per-rustc-invocation JSONL stream. The raw stream is large (thousands
 * of records / 20-30 MB on the demo warm build) and dominates Post Setup
 * Soldr wall-clock when emitted. Default: mirror debug mode (preserves
 * pre-existing behavior for workflows that already opted into debug).
 * Explicit values "true"/"false"/"on"/"off"/"yes"/"no"/"1"/"0" override.
 */
export function resolveJournalPrintRaw(rawValue: string, debugMode: boolean): boolean {
  const v = (rawValue ?? "").trim().toLowerCase();
  if (v === "") return debugMode;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return debugMode;
}

function readRestoreState(): RestoreState {
  return {
    setupCacheEnabled: stateBool("setupCacheEnabled"),
    setupCacheExactHit: stateBool("setupCacheExactHit"),
    setupCacheMatchedKey: core.getState("setupCacheMatchedKey"),
    targetCacheEnabled: stateBool("targetCacheEnabled"),
    targetCacheExactHit: stateBool("targetCacheExactHit"),
    targetCacheMatchedKey: core.getState("targetCacheMatchedKey"),
    buildCacheEnabled: stateBool("buildCacheEnabled"),
    buildCacheExactHit: stateBool("buildCacheExactHit"),
    buildCacheMatchedKey: core.getState("buildCacheMatchedKey"),
    cargoRegistryCacheEnabled: stateBool("cargoRegistryCacheEnabled"),
    cargoRegistryCacheExactHit: stateBool("cargoRegistryCacheExactHit"),
    cargoRegistryCacheMatchedKey: core.getState("cargoRegistryCacheMatchedKey"),
  };
}

function disabledSave(): CacheSaveResult {
  return { status: "disabled" };
}

// setup-cache is intentionally restore-only. Its restore is kept so the
// action's `cache-hit` output (wired from setupCacheExactHit in main.ts)
// retains its public contract for downstream workflows, but the save path
// is permanently inert: the soldr binary moved to soldr-mini-cache (#142)
// and the rustup toolchain state moved to solo-toolchain-cache (#139),
// both of which are content-addressable and coarser-keyed. Wiring a save
// here would re-introduce a duplicate path and defeat those layers' LRU
// access pattern. See setup-soldr#151 for the full decision rationale.
function notManagedSave(): CacheSaveResult {
  return { status: "not-managed-in-post" };
}

function restoreStatus(enabled: boolean, exactHit: boolean, matchedKey: string): RestoreStatus {
  if (!enabled) return "disabled";
  if (exactHit) return "exact-hit";
  if (matchedKey.trim()) return "restore-key-hit";
  return "miss";
}

interface CachePayloadPolicy {
  warnBytes: number | null;
  maxBytes: number | null;
  oversizeAction: "skip" | "fail";
  topN: number;
}

function parseByteCount(raw: string, inputName: string, log: (msg: string) => void): number | null {
  const value = (raw ?? "").trim();
  if (!value || value === "0") return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?|b)?$/i.exec(value);
  if (!match) {
    core.warning(`setup-soldr: ignoring invalid ${inputName} value '${value}'`);
    return null;
  }
  const amountText = match[1];
  if (amountText === undefined) return null;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount < 0) {
    core.warning(`setup-soldr: ignoring invalid ${inputName} value '${value}'`);
    return null;
  }
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier =
    unit === "k" || unit === "kb" || unit === "kib"
      ? 1024
      : unit === "m" || unit === "mb" || unit === "mib"
        ? 1024 ** 2
        : unit === "g" || unit === "gb" || unit === "gib"
          ? 1024 ** 3
          : unit === "t" || unit === "tb" || unit === "tib"
            ? 1024 ** 4
            : 1;
  const parsed = Math.floor(amount * multiplier);
  if (parsed <= 0) return null;
  log(`cache-payload-policy: ${inputName}=${parsed} bytes`);
  return parsed;
}

function parseTopN(raw: string, log: (msg: string) => void): number {
  const value = (raw ?? "").trim();
  if (!value) return 10;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    core.warning(`setup-soldr: ignoring invalid cache-payload-top-n value '${value}'`);
    return 10;
  }
  const topN = Math.max(0, Math.min(50, Math.floor(parsed)));
  log(`cache-payload-policy: cache-payload-top-n=${topN}`);
  return topN;
}

export function resolveCachePayloadPolicy(
  inputs: RawInputs,
  log: (msg: string) => void,
  env: Record<string, string | undefined> = process.env,
): CachePayloadPolicy {
  // Empty input -> runner profile default (zackees/ci.yml#227): GitHub
  // 512MiB notice / 6GiB cap, local runner (ACT) 4GiB notice / no cap.
  const localRunner = isLocalRunner(env);
  const action = (inputs.cachePayloadOversizeAction || "skip").trim().toLowerCase();
  let oversizeAction: "skip" | "fail" = "skip";
  if (action === "fail") {
    oversizeAction = "fail";
  } else if (action && action !== "skip") {
    core.warning(
      `setup-soldr: ignoring invalid cache-payload-oversize-action value '${inputs.cachePayloadOversizeAction}'`,
    );
  }
  return {
    warnBytes: parseByteCount(
      resolveCacheProfileInput("cache-payload-warn-bytes", inputs.cachePayloadWarnBytes, localRunner),
      "cache-payload-warn-bytes",
      log,
    ),
    maxBytes: parseByteCount(
      resolveCacheProfileInput("cache-payload-max-bytes", inputs.cachePayloadMaxBytes, localRunner),
      "cache-payload-max-bytes",
      log,
    ),
    oversizeAction,
    topN: parseTopN(inputs.cachePayloadTopN, log),
  };
}

export function applyCachePayloadOversizeAction(
  action: "skip" | "fail",
  message: string,
  setFailed: (message: string) => void = core.setFailed,
): "oversize-skip" | "failed" {
  if (action === "fail") {
    setFailed(message);
    return "failed";
  }
  return "oversize-skip";
}

export async function classifyCacheSaveReservation(
  id: number,
  key: string,
  probeExactKey: () => Promise<string | undefined>,
): Promise<"saved" | "race-skip" | "failed"> {
  if (id > 0) return "saved";
  try {
    return (await probeExactKey()) === key ? "race-skip" : "failed";
  } catch {
    return "failed";
  }
}

type CacheSaveResultWithStats = CacheSaveResult & {
  archiveBytes: number | null;
  inflatedBytes: number | null;
  fileCount: number | null;
  payload: CachePayloadCensus | null;
};

async function saveOne(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
  key: string;
  matchedKey: string;
  label: string;
  debug: boolean;
  log: (msg: string) => void;
  /**
   * Optional sibling basenames bundled into the same archive as `cacheDir`.
   * Used by the cargo-registry layer to ship `.global-cache` and `git/` next
   * to `registry/` without a new cache layer — setup-soldr#102.
   */
  extraBasenames?: string[];
  payloadProfile?: CachePayloadProfile;
  payloadPolicy: CachePayloadPolicy;
}): Promise<CacheSaveResultWithStats> {
  const { cacheDir, codec, level, key, matchedKey, label, debug, log, extraBasenames, payloadProfile, payloadPolicy } = opts;
  const withStats = (r: CacheSaveResult): CacheSaveResultWithStats =>
    Object.assign(r, {
      archiveBytes: null,
      inflatedBytes: null,
      fileCount: null,
      payload: null,
    });
  // #527: shared save policy (save-cache input / pull_request event).
  if (!allowCacheSave(label, (m) => core.info(m))) {
    return withStats({ status: "policy-skip", cache_dir: cacheDir });
  }
  if (!dirExists(cacheDir)) {
    log(`${label}: cache dir ${cacheDir} does not exist, skipping save`);
    return withStats({ status: "missing-dir-skip", cache_dir: cacheDir });
  }
  if (matchedKey === key) {
    log(`${label}: exact cache hit on ${key}, skipping save`);
    return withStats({ status: "exact-hit-skip", cache_dir: cacheDir });
  }
  let archiveBytes: number | null = null;
  let archivePath: string | null = null;
  let inflatedBytes: number | null = null;
  let fileCount: number | null = null;
  let payload: CachePayloadCensus | null = null;
  // Per-phase save timing (#214): separate the archive+compress phase from the
  // cache reservation+upload phase so a slow Windows post step is diagnosable.
  let compressMs = 0;
  let uploadMs = 0;
  const compressStart = Date.now();
  let skippedReason: "payload-too-large" | undefined;
  try {
    if (archivePath === null) {
      const result = await compressCache({
        cacheDir,
        codec,
        level,
        debug,
        log,
        extraBasenames,
        payloadWarnBytes: payloadPolicy.warnBytes,
        payloadMaxBytes: payloadPolicy.maxBytes,
        payloadOversizeAction: payloadPolicy.oversizeAction,
        payloadTopN: payloadPolicy.topN,
        payloadProfile,
        label,
        cacheKey: key,
      });
      archivePath = result.archivePath;
      archiveBytes = result.archiveBytes || null;
      inflatedBytes = result.inflatedBytes;
      fileCount = result.fileCount;
      payload = result.payload;
      skippedReason = result.skippedReason;
      compressMs = Date.now() - compressStart;
    }
    if (skippedReason === "payload-too-large") {
      log(`${label}: payload exceeded cache-payload-max-bytes, skipping save`);
      return {
        status: "oversize-skip",
        cache_dir: cacheDir,
        archiveBytes,
        inflatedBytes,
        fileCount,
        payload,
        phaseTimings: { compressMs },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      payloadPolicy.oversizeAction === "fail" &&
      message.includes("exceeding cache-payload-max-bytes")
    ) {
      applyCachePayloadOversizeAction("fail", message);
    }
    log(`${label}: compression failed: ${message}`);
    return withStats({ status: "failed", cache_dir: cacheDir, error: message });
  }
  const pathsToSave = archivePath ? [archivePath] : [cacheDir];
  try {
    const uploadStart = Date.now();
    const id = await gatedSaveCache(label, pathsToSave, key, (m) => core.info(m));
    uploadMs = Date.now() - uploadStart;
    log(
      `${label}: saved cache id=${id} key=${key} via ${archivePath ? "tar.zst" : "default"} ` +
        `(compress=${compressMs}ms upload=${uploadMs}ms)`,
    );
    return {
      status: "saved",
      cache_dir: cacheDir,
      archive_path: archivePath ?? undefined,
      saved_paths: pathsToSave,
      cache_id: id,
      archiveBytes,
      inflatedBytes,
      fileCount,
      payload,
      phaseTimings: { compressMs, uploadMs },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: save failed: ${message}`);
    return {
      status: "failed",
      cache_dir: cacheDir,
      archive_path: archivePath ?? undefined,
      saved_paths: pathsToSave,
      error: message,
      archiveBytes,
      inflatedBytes,
      fileCount,
      payload,
      phaseTimings: { compressMs, uploadMs },
    };
  }
}

function cacheLayerSummary(opts: {
  enabled: boolean;
  key: string;
  exactHit: boolean;
  matchedKey: string;
  save: CacheSaveResult;
}): CacheLayerSummary {
  const matchedKey = opts.matchedKey.trim();
  return {
    enabled: opts.enabled,
    key: opts.key,
    matched_key: matchedKey,
    exact_hit: opts.enabled ? opts.exactHit : false,
    restore_status: restoreStatus(opts.enabled, opts.exactHit, matchedKey),
    save: opts.save,
  };
}

function readSoldrCacheReport(
  soldrBinary: string | undefined,
  passthrough: boolean,
): SoldrCacheReportSummary {
  if (passthrough) {
    // Short-circuit when the main step installed a passthrough stub
    // (enable=false). Skips spawning a .cmd on Windows (where
    // child_process.spawnSync can't launch shell scripts directly) and
    // documents the passthrough state in the post-step summary.
    return {
      status: "ok",
      soldr_version: "passthrough",
      report: {
        notes: ["setup-soldr enable=false: soldr passthrough stub"],
        last_session: null,
        rollups: null,
      },
    };
  }
  if (!soldrBinary || !fileExists(soldrBinary)) {
    return {
      status: "missing-binary",
      error:
        soldrBinary === undefined
          ? "SOLDR_BINARY env var not set"
          : `soldr binary at ${soldrBinary} does not exist`,
    };
  }
  // Use spawnSync so the post step has no async dependencies. The
  // report subcommand is fast (sub-100ms) — never worth pulling in
  // @actions/exec just for one shell-out.
  const child = spawnSync(soldrBinary, ["cache", "report", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.error) {
    return {
      status: "error",
      error: `failed to spawn soldr: ${child.error.message}`,
    };
  }
  const stdout = (child.stdout || "").trim();
  const stderr = (child.stderr || "").trim();
  if (child.status !== 0) {
    const combined = `${stderr}\n${stdout}`;
    if (
      /unrecognized subcommand|invalid value for|unknown sub[- ]?command/i.test(combined) &&
      /\breport\b/.test(combined)
    ) {
      return {
        status: "unsupported",
        error: stderr || stdout || `soldr exited ${child.status}`,
      };
    }
    return {
      status: "error",
      error: stderr || stdout || `soldr exited ${child.status}`,
    };
  }
  let report: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "error",
        error: "soldr cache report --json returned a non-object payload",
      };
    }
    report = parsed as Record<string, unknown>;
  } catch (err) {
    return {
      status: "error",
      error: `failed to parse soldr cache report JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const soldrVersion = typeof report["soldr_version"] === "string" ? (report["soldr_version"] as string) : undefined;
  const zccacheVersion =
    typeof report["managed_zccache_version"] === "string"
      ? (report["managed_zccache_version"] as string)
      : undefined;
  return {
    status: "ok",
    soldr_version: soldrVersion,
    managed_zccache_version: zccacheVersion,
    report,
  };
}

function readZccacheSessionSummary(buildCachePath: string): ZccacheSessionSummary {
  const statsPath = resolveZccacheSessionStatsPath(buildCachePath);
  if (!fileExists(statsPath)) {
    return { stats_path: statsPath, present: false, status: "missing" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        stats_path: statsPath,
        present: true,
        status: "invalid",
        error: "stats JSON was not an object",
      };
    }
    const stats = parsed as Record<string, unknown>;
    const status = typeof stats["status"] === "string" ? stats["status"] : "unknown";
    return { stats_path: statsPath, present: true, status, stats };
  } catch (err) {
    return {
      stats_path: statsPath,
      present: true,
      status: "invalid",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Wall clock main recorded after the build-cache restore (setup-soldr#573). */
function readBuildCacheBaselineMs(): number | undefined {
  const raw = core.getState("buildCacheBaselineMs").trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Job-wide new-compile count for the delta-aware save gates (#230/#214,
 * fix for setup-soldr#543). A job with multiple cargo invocations
 * (build+test, workspace splits, …) runs one zccache session per
 * invocation; `shutdownCacheDaemons`'s `--archive-logs` files each
 * session's stats under `<build-cache>/logs/archive/<session-id>/` as it
 * ends, INCLUDING the final session. `readZccacheSessionSummary` only
 * resolves a single most-recent-mtime file, so on a multi-session job it
 * reported just the last invocation's misses — undercounting a large
 * fresh compile that happened in an earlier step and making the gate
 * skip a save it should have made (setup-soldr#543: a run that compiled
 * ~130 crates was reported as "0 new compile(s)").
 *
 * Sums `misses` across every archived session for this job when any were
 * archived, and falls back to the single most-recent session's misses
 * only when the archive is empty (older soldr without `--archive-logs`
 * support, or archiving unavailable) so single-invocation jobs keep
 * working unchanged.
 */
export function computeJobNewCompiles(buildCachePath: string, sinceMs?: number): number | null {
  const archiveDir = path.join(buildCachePath, "logs", "archive");
  const rollup = aggregateSessions(collectArchivedSessionStats(archiveDir));
  const history = aggregateSessions(collectFreshHistorySessionStats(buildCachePath, sinceMs));
  if (rollup.sessionCount > 0 || history.sessionCount > 0) {
    // setup-soldr#573: the archive holds only the daemon sessions shut down
    // by this action, so a cargo run nested in another tool (uv -> PEP 517
    // backend -> `soldr cargo build`) is missing from it. Every soldr front
    // door also files its stats under `<build-cache>/history/<id>/`. The two
    // sources overlap, so take the larger total instead of summing them.
    return Math.max(rollup.totalMisses, history.totalMisses);
  }
  return numberStat(readZccacheSessionSummary(buildCachePath).stats, "misses") ?? null;
}

/**
 * Stats of every soldr front-door build recorded under
 * `<build-cache>/history/<id>/last-session-stats.json` after `sinceMs` (the
 * moment main finished restoring the build cache). History restored from the
 * cache keeps its old mtimes and is excluded. Without a baseline nothing is
 * returned, so restored history is never counted as new work.
 */
export function collectFreshHistorySessionStats(
  buildCachePath: string,
  sinceMs: number | undefined,
): Array<Record<string, unknown>> {
  if (sinceMs === undefined || !Number.isFinite(sinceMs)) return [];
  const historyDir = path.join(buildCachePath, "history");
  return collectArchivedSessionStats(historyDir, (statsPath) => {
    try {
      return fs.statSync(statsPath).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve a per-session zccache log file (e.g. `last-session-stats.json` or
 * `last-session.jsonl`) across the layouts soldr may use. soldr's private
 * daemon sessions write under `<cache>/private/<session-id>/logs/`, NOT the
 * bare `<cache>/logs/` — so a path built with just `<cache>/logs/<file>` is
 * silently empty under the default layout (setup-soldr#247). Probe, in order:
 *   1. `<cache>/logs/<file>` (legacy / non-private layout)
 *   2. `<cache>/private/<id>/logs/<file>` and `<cache>/private/<id>/<file>`
 *   3. `<cache>/logs/archive/<session>/logs/<file>` and `.../<file>`
 * most-recent-mtime wins; falls back to the legacy default path.
 */
function resolveZccacheSessionFilePath(buildCachePath: string, filename: string): string {
  const defaultPath = path.join(buildCachePath, "logs", filename);
  if (fileExists(defaultPath)) return defaultPath;

  const candidates = [
    ...collectSessionFileCandidates(path.join(buildCachePath, "private"), filename),
    ...collectSessionFileCandidates(path.join(buildCachePath, "logs", "archive"), filename),
  ];
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return candidates[0]?.path ?? defaultPath;
}

function resolveZccacheSessionStatsPath(buildCachePath: string): string {
  return resolveZccacheSessionFilePath(buildCachePath, "last-session-stats.json");
}

export function resolveZccacheSessionJournalPath(buildCachePath: string): string {
  return resolveZccacheSessionFilePath(buildCachePath, "last-session.jsonl");
}

function collectSessionFileCandidates(
  root: string,
  filename: string,
): Array<{ path: string; mtimeMs: number }> {
  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(root).isDirectory()) return [];
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const candidate = path.join(root, ent.name, "logs", filename);
    const archiveCandidate = path.join(root, ent.name, filename);
    for (const filePath of [candidate, archiveCandidate]) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          out.push({ path: filePath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // Candidate shape not present; try the next known layout.
      }
    }
  }
  return out;
}

export function buildFinalCacheSummary(
  result: ResolveResult,
  state: RestoreState,
  saves: {
    buildCache: CacheSaveResult;
    cargoRegistryCache: CacheSaveResult;
    targetCache: CacheSaveResult;
  },
  passthrough = false,
): FinalCacheSummary {
  return {
    schema_version: 1,
    setup_cache: cacheLayerSummary({
      enabled: state.setupCacheEnabled,
      key: result.setupCache.key,
      exactHit: state.setupCacheExactHit,
      matchedKey: state.setupCacheMatchedKey,
      save: notManagedSave(),
    }),
    target_cache: cacheLayerSummary({
      enabled: state.targetCacheEnabled,
      key: result.targetCache.key,
      exactHit: state.targetCacheExactHit,
      matchedKey: state.targetCacheMatchedKey,
      save: saves.targetCache,
    }),
    build_cache: cacheLayerSummary({
      enabled: state.buildCacheEnabled,
      key: result.buildCache.key,
      exactHit: state.buildCacheExactHit,
      matchedKey: state.buildCacheMatchedKey,
      save: saves.buildCache,
    }),
    cargo_registry_cache: cacheLayerSummary({
      enabled: state.cargoRegistryCacheEnabled,
      key: result.cargoRegistryCache.key,
      exactHit: state.cargoRegistryCacheExactHit,
      matchedKey: state.cargoRegistryCacheMatchedKey,
      save: saves.cargoRegistryCache,
    }),
    zccache_session: readZccacheSessionSummary(result.buildCache.path),
    compile_cache_report: readSoldrCacheReport(process.env["SOLDR_BINARY"]?.trim(), passthrough),
    // PR4 — walk the per-session archive that soldr#379's
    // `cache shutdown --archive-logs` populates between cargo invocations
    // and roll the per-session stats up into a single job-wide aggregate.
    // Empty archive (no archival happened, or only one session ran) leaves
    // `sessionCount=0`, which makes the renderer / outputs no-op.
    multi_session_rollup: aggregateSessions(
      collectArchivedSessionStats(path.join(result.buildCache.path, "logs", "archive")),
    ),
  };
}

function numberStat(stats: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = stats?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function zccacheOneLine(summary: ZccacheSessionSummary): string {
  if (!summary.present) return `missing (${summary.stats_path})`;
  if (summary.status !== "ok") {
    return summary.error ? `${summary.status} (${summary.error})` : summary.status;
  }
  const hits = numberStat(summary.stats, "hits") ?? 0;
  const misses = numberStat(summary.stats, "misses") ?? 0;
  const compilations = numberStat(summary.stats, "compilations") ?? hits + misses;
  const nonCacheable = numberStat(summary.stats, "non_cacheable") ?? 0;
  const errors = numberStat(summary.stats, "errors") ?? 0;
  const hitRate = numberStat(summary.stats, "hit_rate");
  const hitRateText = hitRate === undefined ? "n/a" : `${(hitRate * 100).toFixed(1)}%`;
  return `hits=${hits} misses=${misses} compilations=${compilations} non_cacheable=${nonCacheable} errors=${errors} hit_rate=${hitRateText}`;
}

function restoreText(layer: CacheLayerSummary): string {
  if (!layer.enabled) return "disabled";
  if (layer.restore_status === "exact-hit") return "exact hit";
  if (layer.restore_status === "restore-key-hit") return "restore-key hit";
  return "miss";
}

function saveText(save: CacheSaveResult): string {
  switch (save.status) {
    case "saved":
      return save.cache_id === undefined ? "saved" : `saved id=${save.cache_id}`;
    case "exact-hit-skip":
      return "skipped exact hit";
    case "missing-dir-skip":
      return "skipped missing dir";
    case "oversize-skip":
      return "skipped oversize payload";
    case "race-skip":
      return "skipped cache reservation race";
    case "tiny-delta-skip":
      return save.skip_reason ? `skipped tiny delta (${save.skip_reason})` : "skipped tiny delta";
    case "policy-skip":
      return "skipped by save-cache policy";
    case FAILED_JOB_SKIP_STATUS:
      return save.skip_reason ? `skipped: ${save.skip_reason}` : "skipped: the job did not succeed";
    case "failed":
      return save.error ? `failed: ${save.error}` : "failed";
    case "disabled":
      return "disabled";
    case "not-managed-in-post":
      return "not managed in post";
  }
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tableRow(label: string, layer: CacheLayerSummary): string {
  return [
    label,
    restoreText(layer),
    layer.key,
    layer.matched_key || "",
    saveText(layer.save),
  ]
    .map(markdownCell)
    .join(" | ");
}

function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtOptionalBytes(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? fmtBytes(n) : "";
}

function skipSummaryText(payload: CachePayloadCensus): string {
  if (payload.skipped.length === 0) return "none";
  return payload.skipped.map((entry) => `${entry.reason}: ${entry.count}`).join(", ");
}

function payloadEntryLines(entries: readonly { path: string; bytes: number }[]): string[] {
  if (entries.length === 0) return ["- none"];
  return entries.map((entry) => `- \`${entry.path}\` - ${fmtBytes(entry.bytes)}`);
}

function payloadSubtreeLines(entries: CachePayloadCensus["topSubtrees"]): string[] {
  if (entries.length === 0) return ["- none"];
  return entries.map((entry) => `- \`${entry.path}\` - ${fmtBytes(entry.bytes)} across ${entry.files} files`);
}

function payloadSkipLines(payload: CachePayloadCensus): string[] {
  if (payload.skipped.length === 0) return ["- none"];
  const lines: string[] = [];
  for (const skipped of payload.skipped) {
    const samples = skipped.samples.length > 0 ? `; samples: ${skipped.samples.map((s) => `\`${s}\``).join(", ")}` : "";
    lines.push(`- ${skipped.reason}: ${skipped.count}${samples}`);
  }
  return lines;
}

function cachePayloadAuditSection(summary: FinalCacheSummary): string[] {
  const rows: Array<[string, CacheSaveResult]> = [];
  for (const [label, save] of [
    ["target cache", summary.target_cache.save],
    ["build cache", summary.build_cache.save],
    ["cargo registry cache", summary.cargo_registry_cache.save],
  ] as Array<[string, CacheSaveResult]>) {
    if (save.payload) rows.push([label, save]);
  }

  if (rows.length === 0) return [];

  const lines = [
    "",
    "### cache payload audit",
    "",
    "| Layer | Payload | Files | Symlinks | Archive | Skipped |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const [label, save] of rows) {
    const payload = save.payload;
    if (!payload) continue;
    lines.push(
      `| ${markdownCell(label)} | ${fmtBytes(payload.bytes)} | ${payload.files} | ${payload.symlinks} | ` +
        `${fmtOptionalBytes(save.archiveBytes)} | ${markdownCell(skipSummaryText(payload))} |`,
    );
  }

  for (const [label, save] of rows) {
    const payload = save.payload;
    if (!payload) continue;
    lines.push(
      "",
      `<details><summary>${label} largest payload entries</summary>`,
      "",
      "Largest subtrees:",
      "",
      ...payloadSubtreeLines(payload.topSubtrees),
      "",
      "Largest files:",
      "",
      ...payloadEntryLines(payload.topFiles),
      "",
      "Largest directories:",
      "",
      ...payloadEntryLines(payload.topDirectories),
      "",
      "Skipped tar inputs:",
      "",
      ...payloadSkipLines(payload),
      "",
      "</details>",
    );
  }

  return lines;
}

function setCompileCacheOutputs(report: SoldrCacheReportSummary, mode: CompileCacheStatsMode): void {
  core.setOutput("compile-cache-session-status", report.status);
  if (report.status !== "ok" || !report.report) return;
  core.setOutput("compile-cache-summary-json", JSON.stringify(report.report));
  const lastSession = report.report["last_session"] as Record<string, unknown> | null;
  if (lastSession) {
    const hits = numberStat(lastSession, "hits") ?? 0;
    const misses = numberStat(lastSession, "misses") ?? 0;
    const compilations = numberStat(lastSession, "compilations") ?? hits + misses;
    const hitRate = numberStat(lastSession, "hit_rate");
    const timeSavedMs = numberStat(lastSession, "time_saved_ms");
    const bytesRead = numberStat(lastSession, "bytes_read");
    const bytesWritten = numberStat(lastSession, "bytes_written");
    core.setOutput("compile-cache-hits", String(hits));
    core.setOutput("compile-cache-misses", String(misses));
    core.setOutput("compile-cache-compilations", String(compilations));
    if (hitRate !== undefined) core.setOutput("compile-cache-hit-rate", String(hitRate));
    if (timeSavedMs !== undefined) core.setOutput("compile-cache-time-saved-ms", String(timeSavedMs));
    if (bytesRead !== undefined) core.setOutput("compile-cache-bytes-read", String(bytesRead));
    if (bytesWritten !== undefined) core.setOutput("compile-cache-bytes-written", String(bytesWritten));
  }
  if (mode === "detailed") {
    const rollups = report.report["rollups"];
    if (rollups) core.setOutput("compile-cache-rollups-json", JSON.stringify(rollups));
  }
}

function compileCacheReportSection(report: SoldrCacheReportSummary, mode: CompileCacheStatsMode): string[] {
  if (mode === "none") return [];
  // Insights mode is a superset of summarize — render the per-session table
  // first so workflows don't lose the baseline metrics, then append the
  // diagnoses block underneath. The detailed roll-up tables stay
  // detailed-only (they're already noisy enough on their own).
  const summaryMode: CompileCacheStatsMode = mode === "insights" ? "summarize" : mode;
  const lines: string[] = ["", "### Compile cache (zccache)", ""];
  if (report.status !== "ok" || !report.report) {
    lines.push(`| Status | ${markdownCell(report.status)} |`);
    if (report.error) lines.push(`| Detail | ${markdownCell(report.error)} |`);
    return lines;
  }
  const body = report.report;
  const lastSession = (body["last_session"] as Record<string, unknown> | null) ?? null;
  const rollups = (body["rollups"] as Record<string, unknown> | null) ?? null;
  if (lastSession) {
    const hits = numberStat(lastSession, "hits") ?? 0;
    const misses = numberStat(lastSession, "misses") ?? 0;
    const compilations = numberStat(lastSession, "compilations") ?? hits + misses;
    const rate = numberStat(lastSession, "hit_rate");
    const rateText = rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
    const saved = numberStat(lastSession, "time_saved_ms");
    const bytesRead = numberStat(lastSession, "bytes_read");
    const bytesWritten = numberStat(lastSession, "bytes_written");
    lines.push("| Metric | Value |", "| --- | --- |");
    lines.push(`| Compilations | ${compilations} |`);
    lines.push(`| Hits | ${hits} |`);
    lines.push(`| Misses | ${misses} |`);
    lines.push(`| Hit rate | ${rateText} |`);
    if (saved !== undefined) lines.push(`| Time saved (est.) | ${(saved / 1000).toFixed(1)}s |`);
    if (bytesRead !== undefined) lines.push(`| Bytes read | ${fmtBytes(bytesRead)} |`);
    if (bytesWritten !== undefined) lines.push(`| Bytes written | ${fmtBytes(bytesWritten)} |`);
    if (report.soldr_version) lines.push(`| soldr | ${markdownCell(report.soldr_version)} |`);
    if (report.managed_zccache_version) lines.push(`| zccache | ${markdownCell(report.managed_zccache_version)} |`);
  } else {
    lines.push("_(no last\\_session yet — run a cache-enabled build first)_");
  }
  if (mode === "detailed" && rollups) {
    const byExt = rollups["by_extension"];
    if (byExt && typeof byExt === "object" && !Array.isArray(byExt)) {
      const rows = Object.entries(byExt as Record<string, unknown>);
      if (rows.length > 0) {
        lines.push("", "#### By output extension", "");
        lines.push("| Extension | Hits | Misses | Total ms |", "| --- | --- | --- | --- |");
        for (const [ext, bucket] of rows) {
          const b = (bucket as Record<string, unknown>) ?? {};
          const h = numberStat(b, "hits") ?? 0;
          const m = numberStat(b, "misses") ?? 0;
          const t = numberStat(b, "total_ms") ?? 0;
          lines.push(`| ${markdownCell(ext)} | ${h} | ${m} | ${t} |`);
        }
      }
    }
    const byTool = rollups["by_tool_total_ms"];
    if (byTool && typeof byTool === "object" && !Array.isArray(byTool)) {
      const rows = Object.entries(byTool as Record<string, unknown>)
        .map(([tool, ms]) => [tool, typeof ms === "number" ? ms : 0] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      if (rows.length > 0) {
        lines.push("", "#### By tool (wall-clock)", "");
        lines.push("| Tool | ms |", "| --- | --- |");
        for (const [tool, ms] of rows) {
          lines.push(`| ${markdownCell(tool)} | ${ms} |`);
        }
      }
    }
  }
  // PR3 — insights mode appends per-diagnosis <details> blocks below the
  // per-session table. Each diagnosis renders its evidence (miss reasons
  // table + slowest misses list + wasted_ms) plus a blockquoted
  // suggested_fix line. Annotations are not emitted from this pure
  // renderer — the run() loop separately forwards them to core.warning /
  // core.notice so they show up pinned in the PR Files view.
  if (mode === "insights") {
    const insights = renderInsights(body);
    if (insights.markdown.length > 0) {
      lines.push("", "### Compile cache insights", "");
      lines.push(insights.markdown);
    }
  }
  const notes = body["notes"];
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push("", "<details><summary>Notes from soldr</summary>", "");
    for (const note of notes) {
      if (typeof note === "string") lines.push(`- ${markdownCell(note)}`);
    }
    lines.push("", "</details>");
  }
  // Silence the "unused variable" warning — summaryMode is reserved for a
  // future split where insights includes/excludes the detailed-rollup
  // tables. Today the rollup gate is still keyed on `mode`.
  void summaryMode;
  return lines;
}

export function formatFinalCacheSummaryMarkdown(
  summary: FinalCacheSummary,
  compileCacheStats: CompileCacheStatsMode = "summarize",
): string {
  // PR4 — multi-step roll-up. Renders only when >1 sessions were
  // archived AND the user didn't opt out via compile-cache-stats=none.
  // The block sits between the layer table and the per-session compile
  // cache section so the high-level "what happened across the whole job"
  // signal lands first, with the per-invocation breakdown beneath.
  const multiStepBlock =
    compileCacheStats !== "none"
      ? renderMultiSessionRollup(summary.multi_session_rollup)
      : "";
  const multiStepLines = multiStepBlock.length > 0 ? ["", multiStepBlock] : [];
  const lines = [
    "## setup-soldr final cache summary",
    "",
    "| Layer | Restore | Primary key | Matched key | Save |",
    "| --- | --- | --- | --- | --- |",
    `| ${tableRow("setup cache", summary.setup_cache)} |`,
    `| ${tableRow("target cache", summary.target_cache)} |`,
    `| ${tableRow("build cache", summary.build_cache)} |`,
    `| ${tableRow("cargo registry cache", summary.cargo_registry_cache)} |`,
    ...cachePayloadAuditSection(summary),
    ...multiStepLines,
    "",
    "### zccache session",
    "",
    `- Stats: ${zccacheOneLine(summary.zccache_session)}`,
    `- Stats file: ${summary.zccache_session.stats_path}`,
    ...compileCacheReportSection(summary.compile_cache_report, compileCacheStats),
    "",
    "<details><summary>Final cache summary JSON</summary>",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "</details>",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * PR4 — emit the multi-step roll-up's scalar outputs. Skipped when
 * `sessionCount <= 1` so single-session jobs don't surface a misleading
 * roll-up to downstream workflow steps. Exported so the post-step `run()`
 * function and the contract tests can drive it the same way.
 */
export function setMultiSessionOutputs(rollup: {
  sessionCount: number;
  overallHitRate: number | null;
}): void {
  if (rollup.sessionCount <= 1) return;
  core.setOutput("compile-cache-sessions-total", String(rollup.sessionCount));
  if (rollup.overallHitRate !== null && Number.isFinite(rollup.overallHitRate)) {
    core.setOutput("compile-cache-overall-hit-rate", String(rollup.overallHitRate));
  }
}

function logFinalCacheSummary(summary: FinalCacheSummary, log: (msg: string) => void): void {
  log(
    `final cache summary: setup=${restoreText(summary.setup_cache)} target=${restoreText(summary.target_cache)} ` +
      `build=${restoreText(summary.build_cache)}/${saveText(summary.build_cache.save)} ` +
      `cargo-registry=${restoreText(summary.cargo_registry_cache)}/${saveText(summary.cargo_registry_cache.save)}`,
  );
  log(`final zccache session stats: ${zccacheOneLine(summary.zccache_session)}`);
  log(`compile cache report: ${compileCacheReportOneLine(summary.compile_cache_report)}`);
}

function compileCacheReportOneLine(report: SoldrCacheReportSummary): string {
  if (report.status !== "ok" || !report.report) {
    return report.error ? `${report.status} (${report.error})` : report.status;
  }
  const lastSession = report.report["last_session"] as Record<string, unknown> | null;
  if (!lastSession) {
    return `ok (no last_session yet, soldr ${report.soldr_version ?? "?"})`;
  }
  const hits = numberStat(lastSession, "hits") ?? 0;
  const misses = numberStat(lastSession, "misses") ?? 0;
  const rate = numberStat(lastSession, "hit_rate");
  const rateText = rate === undefined ? "n/a" : `${(rate * 100).toFixed(1)}%`;
  return `ok hits=${hits} misses=${misses} hit_rate=${rateText} soldr=${report.soldr_version ?? "?"}`;
}

function writeCompileCacheReportFile(
  report: SoldrCacheReportSummary,
  runnerTemp: string,
  log: (msg: string) => void,
): string | undefined {
  if (!runnerTemp) return undefined;
  const outPath = path.join(runnerTemp, "setup-soldr-compile-cache-report.json");
  try {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    return outPath;
  } catch (err) {
    log(`post: failed to write compile-cache-report.json: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function writeStepSummary(markdown: string, log: (msg: string) => void): void {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"]?.trim();
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, markdown, "utf8");
  } catch (err) {
    log(`post: failed to write GitHub step summary: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * PR3 — Emit insights-mode side effects:
 *   - Forward each `renderInsights` annotation line to core.warning /
 *     core.notice so it shows up pinned in the PR Files-Changed view.
 *   - Best-effort: ask soldr to write a chrome-trace JSON (a developer
 *     debugger trace file consumable by chrome://tracing or Perfetto)
 *     and upload it as a workflow artifact. Silently skipped when soldr
 *     doesn't support the `--chrome-trace` flag — keeps the action green
 *     on older soldr versions that don't have the subcommand yet.
 */
async function emitInsightsAnnotationsAndTrace(opts: {
  report: SoldrCacheReportSummary;
  soldrBinary: string | undefined;
  runnerTemp: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { report, soldrBinary, runnerTemp, log } = opts;
  if (report.status === "ok" && report.report) {
    try {
      const out = renderInsights(report.report);
      for (const line of out.annotations) {
        // Echo to stdout exactly as GitHub Actions expects — the runner
        // ingests `::warning::` / `::notice::` workflow-command lines
        // from stdout regardless of which library wrote them. Avoid the
        // @actions/core helpers because they re-encode the message and
        // we want the file= pin we computed in renderInsights to land
        // verbatim.
        process.stdout.write(`${line}\n`);
      }
      log(`compile-cache-stats: emitted ${out.annotations.length} insights annotations`);
    } catch (err) {
      log(
        `compile-cache-stats: failed to emit insights annotations: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Chrome-trace upload. Skipped when no SOLDR_BINARY is on disk, or
  // when soldr's `cache report --chrome-trace <path>` exits with an
  // "unknown subcommand"/"unrecognized flag" error (i.e. the user is on
  // a soldr build that predates the trace flag).
  if (!soldrBinary || !fileExists(soldrBinary) || !runnerTemp) return;
  const runId = process.env["GITHUB_RUN_ID"]?.trim() || "local";
  const tracePath = path.join(runnerTemp, `setup-soldr-trace-${runId}.json`);
  let traced = false;
  try {
    const child = spawnSync(soldrBinary, ["cache", "report", "--chrome-trace", tracePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.error) {
      log(`compile-cache-stats: chrome-trace spawn failed: ${child.error.message}`);
      return;
    }
    if (child.status !== 0) {
      const combined = `${child.stderr || ""}\n${child.stdout || ""}`;
      if (/unrecognized|unknown|invalid/i.test(combined) && /chrome[-_ ]?trace/i.test(combined)) {
        log("compile-cache-stats: chrome-trace flag not supported by this soldr — skipping upload");
        return;
      }
      log(`compile-cache-stats: chrome-trace generation failed (exit ${child.status})`);
      return;
    }
    traced = fileExists(tracePath);
  } catch (err) {
    log(
      `compile-cache-stats: chrome-trace generation threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!traced) {
    log(`compile-cache-stats: chrome-trace file not present at ${tracePath} — skipping upload`);
    return;
  }
  try {
    // Lazy require so the action stays loadable even when
    // @actions/artifact's runtime requirements aren't met (e.g. running
    // outside of a GitHub-hosted runner, which is the case for every
    // unit test in this repo). Any failure is logged-not-thrown.
    // `bundle-entrypoint.mjs` copies the resulting side-chunks into
    // `dist/` so the runtime require resolves.
    const artifact = await import("@actions/artifact");
    const client = new artifact.DefaultArtifactClient();
    const artifactName = `setup-soldr-trace-${runId}.json`;
    await client.uploadArtifact(artifactName, [tracePath], path.dirname(tracePath));
    log(`compile-cache-stats: uploaded chrome-trace artifact ${artifactName}`);
  } catch (err) {
    log(
      `compile-cache-stats: chrome-trace artifact upload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function run(): Promise<void> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const state = core.getState("resolveResult");
  if (!state) {
    log("post: no resolve state available, exiting");
    return;
  }
  let result: ResolveResult;
  try {
    result = JSON.parse(state) as ResolveResult;
  } catch (err) {
    log(`post: failed to parse resolve state: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // setup-soldr#594: a lazy job restored no build layers, so it has none to
  // save; publishing its verdicts and manifest is the whole post step.
  const verdictTemp = process.env["RUNNER_TEMP"] || os.tmpdir();
  if (core.getState("verdictLazy") === "true") {
    await verdictPost({ runnerTemp: verdictTemp, log });
    return;
  }

  // #557: publish soldr tool bundles (LLVM, ...) this job installed to
  // RUNNER_TOOL_CACHE, so the next run on this runner links them instead.
  if (result.enabled && core.getState("cacheUmbrellaEnabled") === "true") {
    publishBundleToolCache({
      env: process.env,
      soldrBinDir: result.soldrBinCachePath,
      crossPrepareTarget: result.blessedPrepareCache.target,
      logger: { log, warn: (msg) => core.warning(msg), debug: () => undefined },
    });
  }

  const buildCacheMatched = core.getState("buildCacheMatchedKey");
  const registryMatched = core.getState("cargoRegistryCacheMatchedKey");
  const passthrough = stateBool("setupSoldrPassthrough");
  const restoreState = readRestoreState();
  const statsMode = (core.getState("statsMode") || "summarize") as StatsMode;
  const compileCacheStats = (core.getState("compileCacheStats") || "summarize") as CompileCacheStatsMode;
  const runnerTemp = core.getState("runnerTemp") || "";
  const debugMode = result.debugMode ?? false;
  const debugLog = debugMode ? log : (): void => undefined;
  const postCollector = new StatsCollector();
  const rawInputs = readRawInputs(process.env);
  const payloadPolicy = resolveCachePayloadPolicy(rawInputs, log);

  // Always stop long-running cache daemons before packing the build
  // cache so file locks release and the tarball reflects a quiescent
  // on-disk view. Best-effort; failures are logged, not raised.
  //
  // Wire `--archive-logs <build-cache>/logs/archive` through so soldr
  // (post-#379) stashes the just-ended session's logs into a
  // per-session subdirectory before we render this post step's roll-up.
  // The tar payload planner filters the build-cache logs/ subtree out of
  // cache saves: raw session journals are diagnostics, not reusable cache
  // content, and can be tens of MB per invocation.
  const logsArchiveDir = restoreState.buildCacheEnabled
    ? path.join(result.buildCache.path, "logs", "archive")
    : undefined;
  await shutdownCacheDaemons({
    soldrPath: process.env["SOLDR_BINARY"]?.trim() || undefined,
    logsArchiveDir,
    log,
  });

  // #476: main launched this audit after the final dependency-bearing
  // restore, so it ran concurrently with the consumer's build. Join before
  // any save: a poisoned restored closure must never be republished under a
  // new exact key or allowed to produce a successful job.
  if (core.getState("yankAuditStarted") === "true") {
    const auditPath = core.getState("yankAuditResultPath");
    let cacheKeys: string[] = [];
    try {
      const parsed = JSON.parse(core.getState("yankAuditCacheKeys")) as unknown;
      if (Array.isArray(parsed)) {
        cacheKeys = [...new Set(parsed.filter((key): key is string => typeof key === "string" && key.length > 0))];
      }
    } catch {
      // The result below will still be surfaced as not checked if state was
      // damaged; never convert malformed state into a clean verdict.
    }
    const configPath = core.getState("yankAuditConfigPath");
    const startedAtMs = Number(core.getState("yankAuditStartedAtMs"));
    const audit = auditPath
      ? await resolveYankAuditResult(auditPath, async () => {
          if (!configPath) throw new Error("audit worker config path is missing");
          const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as YankAuditWorkerConfig;
          const workerPid = readYankAuditResult(auditPath)?.workerPid;
          log(`yank-audit: background result missing after its deadline (ready_pid=${workerPid ?? "not-reported"}); running bounded foreground recheck`);
          return auditDependencyYanks(config.dependencies, {
            requestTimeoutMs: config.requestTimeoutMs,
            overallTimeoutMs: config.overallTimeoutMs,
          });
        }, { startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : undefined })
      : { status: "not-checked" as const, errors: ["audit result path is missing"] };
    if (audit.status === "not-checked") {
      const stderrPath = core.getState("yankAuditStderrPath");
      let workerStderr = "";
      if (stderrPath) {
        try { workerStderr = fs.readFileSync(stderrPath, "utf8").slice(-4_096).trim(); } catch { /* no worker diagnostic */ }
      }
      core.setFailed(
        `yank-audit: not checked: ${(audit.errors ?? ["unknown registry error"]).join("; ")}. ` +
          `${workerStderr ? `Worker stderr: ${workerStderr}. ` : ""}` +
          `Refusing to save caches or report success without a completed audit.`,
      );
      return;
    } else if (audit.status === "clean") {
      log(
        `yank-audit: clean checked=${audit.checkedCount ?? 0}/${audit.dependencyCount ?? 0} ` +
          `cache_keys=${cacheKeys.length}`,
      );
    } else if (audit.status === "yanked") {
      const yanked = audit.yanked ?? [];
      const crates = yanked.map((dependency) => `${dependency.name} ${dependency.version}`).join(", ");
      const githubRepository = (process.env["GITHUB_REPOSITORY"] ?? "").trim();
      const [owner, repo] = githubRepository.split("/");
      const token = (process.env["GITHUB_TOKEN"] ?? "").trim() ||
        (process.env["INPUT_TOKEN"] ?? "").trim();
      const deletion = await deleteCacheEntriesByKeys({
        owner: owner ?? "",
        repo: repo ?? "",
        token,
        keys: cacheKeys,
        log,
      });
      const deletionComplete = deletion.failed === 0 && deletion.deleted === deletion.found;
      const repair = deletionComplete
        ? `poisoned entries deleted=${deletion.deleted}/${deletion.found}; rerun to rebuild from a clean cache miss`
        : `automatic deletion incomplete (deleted=${deletion.deleted}/${deletion.found}, failures=${deletion.failed}); ` +
          `grant the workflow actions: write permission or manually delete these exact cache keys before retrying`;
      core.setFailed(
        `yank-audit: restored dependency closure contains yanked crate(s): ${crates}; ` +
          `cache key(s): ${cacheKeys.join(", ") || "unknown"}; ` +
          `${repair}. This run is aborted.`,
      );
      return;
    }
  }

  // Source-mtime snapshot (preserve-source-mtimes opt-in). Walk tracked
  // sources, capture each (mtime, size, content-hash), and drop the JSON
  // INSIDE the build-cache directory so it gets bundled into the same
  // tar.zst the build-cache save will upload. main.ts replays the
  // mtimes on warm after the build-cache decompresses, gated on each
  // file's content matching what we snapshotted here.
  const preserveSourceMtimes = core.getState("preserveSourceMtimes") === "true";
  if (preserveSourceMtimes && restoreState.buildCacheEnabled) {
    const t0 = Date.now();
    // The "project root" — where the Cargo workspace being built actually
    // lives — is the parent of the resolved target-dir, NOT result.workspace
    // (which is GITHUB_WORKSPACE — usually the outer checkout containing
    // the action itself plus one or more sub-repos). For the demo,
    // result.workspace=/home/runner/work/setup-soldr/setup-soldr but the
    // zccache project being built is at .../setup-soldr/zccache.
    const projectRoot = path.dirname(result.targetCache.targetPath);
    try {
      const r = await snapshotSourceMtimes({ workspace: projectRoot, log });
      const out = path.join(result.buildCache.path, SNAPSHOT_FILENAME);
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        writeSnapshotFile(r.snapshot, out);
        log(
          `source-mtime-snapshot: wrote ${out} scanned=${r.scanned} hashed=${r.hashed} skipped=${r.skipped} elapsed_ms=${Date.now() - t0}`,
        );
      } catch (err) {
        log(
          `source-mtime-snapshot: failed to write ${out}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      log(
        `source-mtime-snapshot: scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Build cache. A delta-aware gate (#230/#214) skips the expensive
  // archive+upload when the session compiled nothing new AND a cache was
  // already restored — the restored entry already holds everything, so
  // re-saving under a fallback key just uploads a duplicate multi-GiB payload.
  // #559: a job that failed or was cancelled saves no build outputs; its
  // store may be partial, and an exact-hit key is never re-saved.
  const buildOutputGate = readBuildOutputSaveGate(process.env);
  const buildSaveStart = Date.now();
  const buildCacheRestored = buildCacheMatched.trim().length > 0;
  const buildDeltaMisses = restoreState.buildCacheEnabled
    ? computeJobNewCompiles(result.buildCache.path, readBuildCacheBaselineMs())
    : null;
  const buildSaveGate = decideBuildCacheSave({
    restored: buildCacheRestored,
    newCompiles: buildDeltaMisses,
    minCompiles: parseMinCompiles(rawInputs.buildCacheSaveMinCompiles),
  });
  let buildSave: CacheSaveResultWithStats;
  if (!restoreState.buildCacheEnabled) {
    buildSave = Object.assign(disabledSave(), {
      archiveBytes: null,
      inflatedBytes: null,
      fileCount: null,
      payload: null,
    });
  } else if (!buildOutputGate.save) {
    log(`build-cache: skipping save — ${buildOutputGate.reason}`);
    buildSave = Object.assign(
      {
        status: FAILED_JOB_SKIP_STATUS,
        cache_dir: result.buildCache.path,
        skip_reason: buildOutputGate.reason,
      },
      { archiveBytes: null, inflatedBytes: null, fileCount: null, payload: null },
    );
  } else if (buildSaveGate.skip) {
    log(`build-cache: skipping save — ${buildSaveGate.reason} (set build-cache-save-min-compiles: 0 to force-save)`);
    buildSave = Object.assign(
      {
        status: "tiny-delta-skip" as const,
        cache_dir: result.buildCache.path,
        skip_reason: buildSaveGate.reason,
      },
      { archiveBytes: null, inflatedBytes: null, fileCount: null, payload: null },
    );
  } else {
    buildSave = await saveOne({
      cacheDir: result.buildCache.path,
      codec: result.targetCacheCompress,
      level: result.targetCacheCompressLevel,
      key: result.buildCache.key,
      matchedKey: buildCacheMatched,
      label: "build-cache",
      debug: debugMode,
      log: debugLog,
      payloadProfile: "zccache-build-cache",
      payloadPolicy,
    });
  }
  // Publish provenance only after the real upload has a positive cache ID
  // and the existing failed-job, dependency-yank, and payload gates passed.
  // The next run also requires GitHub's completed successful donor attempt.
  const ancestorWriterState = core.getState("ancestorBuildWriter");
  const ancestorKey = parseAncestorKey(result.buildCache.key);
  if (ancestorWriterState && ancestorKey && buildOutputGate.save &&
      buildSave.status === "saved" && (buildSave.cache_id ?? 0) > 0) {
    try {
      const writer = JSON.parse(ancestorWriterState) as { sha?: string; runId?: number; attempt?: number; ref?: string };
      if (writer.sha === ancestorKey.sha && writer.runId === ancestorKey.runId &&
          writer.attempt === ancestorKey.attempt && typeof writer.ref === "string") {
        const proof: CleanSaveProof = { cacheId: buildSave.cache_id!, key: result.buildCache.key,
          ref: writer.ref, sha: ancestorKey.sha, runId: ancestorKey.runId, attempt: ancestorKey.attempt, clean: true };
        log(`${CLEAN_SAVE_MARKER}${JSON.stringify(proof)}`);
      }
    } catch { /* Malformed state never creates save provenance. */ }
  }
  // #287 follow-up: record EVERY outcome (incl. tiny-delta-skip,
  // exact-hit-skip, missing-dir-skip, failed) so the post-step save
  // table shows every layer, not just saved/oversize-skip. archive/
  // inflated/file fields stay null for non-saved statuses so totals
  // only count actual uploads.
  postCollector.record({
    label: "build-cache", operation: "save", hit: false,
    key: result.buildCache.key, matchedKey: buildCacheMatched, restoreKeys: [],
    status: buildSave.status,
    archiveBytes: buildSave.status === "saved" || buildSave.status === "oversize-skip" ? buildSave.archiveBytes : null,
    inflatedBytes: buildSave.status === "saved" || buildSave.status === "oversize-skip" ? buildSave.inflatedBytes : null,
    fileCount: buildSave.status === "saved" || buildSave.status === "oversize-skip" ? buildSave.fileCount : null,
    payload: buildSave.status === "saved" || buildSave.status === "oversize-skip" ? buildSave.payload : null,
    durationMs: Date.now() - buildSaveStart,
    // #360 extension: build-cache's saveCacheLayer (line 387-493)
    // already captures compress/upload phase split via #214's
    // CacheSavePhaseTimings. Surface them to the stats collector
    // so the per-layer save table shows the split for build-cache
    // too (was previously only populated for cook-cache).
    compressMs: buildSave.phaseTimings?.compressMs,
    uploadMs: buildSave.phaseTimings?.uploadMs,
    timestamp: new Date().toISOString(),
  });

  // Target cache. Previously slotted as `notManagedSave()` in the
  // finalSummary — i.e. restored in main.ts but never saved here. That
  // meant every commit cold-rebuilt `target/` (or the rust-plan bundle)
  // because no entry was ever written for the restore-key prefix to
  // fall back to. This block fixes the gap.
  //
  // Behavior:
  // - Skip when target-cache layer is disabled (`target-cache: false`
  //   or umbrella `cache: false`).
  // - Skip on exact-hit (re-saving the same content under the same key
  //   wastes time and triggers @actions/cache's "reservation already
  //   exists" path).
  // - Use `cache.saveCache` directly with the multi-path array (one
  //   path in `thin`/`once` modes, two in `full`). @actions/cache will
  //   tar+compress with its default codec — we don't route through
  //   compressCache because target-cache may legitimately carry
  //   multiple roots and compressCache is single-dir-shaped.
  // - Paths array must match the one passed to restoreCache in main.ts
  //   (the @actions/cache "version" hash depends on it — same gotcha
  //   that bit cook-cache in #141).
  let targetCacheSave: CacheSaveResult & { archiveBytes: number | null } = Object.assign(
    disabledSave(),
    { archiveBytes: null as number | null },
  );
  if (restoreState.targetCacheEnabled) {
    const targetPaths = result.targetCache.paths
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const targetKey = result.targetCache.key;
    const targetMatched = restoreState.targetCacheMatchedKey;
    if (targetPaths.length === 0) {
      log("target-cache: no paths configured, skipping save");
      targetCacheSave = Object.assign(
        { status: "missing-dir-skip" as const, cache_dir: "(no paths)" },
        { archiveBytes: null as number | null },
      );
    } else if (!buildOutputGate.save) {
      log(`target-cache: skipping save — ${buildOutputGate.reason}`);
      targetCacheSave = Object.assign(
        {
          status: FAILED_JOB_SKIP_STATUS,
          cache_dir: targetPaths.join(","),
          skip_reason: buildOutputGate.reason,
        },
        { archiveBytes: null as number | null },
      );
    } else if (!allowCacheSave("target-cache", log)) {
      targetCacheSave = Object.assign(
        { status: "policy-skip" as const, cache_dir: targetPaths.join(",") },
        { archiveBytes: null as number | null },
      );
    } else if (restoreState.targetCacheExactHit) {
      log(`target-cache: exact cache hit on ${targetKey}, skipping save`);
      targetCacheSave = Object.assign(
        { status: "exact-hit-skip" as const, cache_dir: targetPaths.join(",") },
        { archiveBytes: null as number | null },
      );
    } else {
      const existingPaths = targetPaths.filter((p) => fs.existsSync(p));
      if (existingPaths.length === 0) {
        log(`target-cache: none of the configured paths exist on disk (${targetPaths.join(", ")}), skipping save`);
        targetCacheSave = Object.assign(
          { status: "missing-dir-skip" as const, cache_dir: targetPaths.join(",") },
          { archiveBytes: null as number | null },
        );
      } else {
        // Delta-aware target-cache save gate (#255). Mirrors the build-cache
        // gate at line ~1278: when target-cache was restored from a fallback
        // key and the session recorded fewer than N new compiles, the
        // restored entry already holds everything — re-saving under a new
        // key just re-uploads a duplicate multi-GiB payload. Reuses the
        // build-cache session's delta count (a single zccache session backs
        // both layers); when build-cache is disabled the count is null and
        // the gate is a no-op.
        const targetCacheRestored = targetMatched.trim().length > 0;
        const targetSaveGate = decideTargetCacheSave({
          restored: targetCacheRestored,
          newCompiles: buildDeltaMisses,
          minCompiles: parseMinCompiles(rawInputs.targetCacheSaveMinCompiles),
        });
        if (targetSaveGate.skip) {
          log(
            `target-cache: skipping save — ${targetSaveGate.reason} ` +
              `(set target-cache-save-min-compiles: 0 to force-save)`,
          );
          targetCacheSave = Object.assign(
            {
              status: "tiny-delta-skip" as const,
              cache_dir: existingPaths.join(","),
              skip_reason: targetSaveGate.reason,
            },
            { archiveBytes: null as number | null },
          );
        } else {
        const targetSaveStart = Date.now();
        try {
          const id = await gatedSaveCache("target-cache", existingPaths, targetKey, log);
          if (id <= 0) {
            log(
              `target-cache: save did not reserve a new entry (id=${id}) — likely a parallel ` +
                `job already saved key=${targetKey}`,
            );
            targetCacheSave = Object.assign(
              {
                status: "failed" as const,
                cache_dir: existingPaths.join(","),
                saved_paths: existingPaths,
                error: `saveCache returned id=${id} (reserve failed; race or quota)`,
              },
              { archiveBytes: null as number | null },
            );
          } else {
            log(`target-cache: saved cache id=${id} key=${targetKey} paths=${existingPaths.join(",")}`);
            targetCacheSave = Object.assign(
              {
                status: "saved" as const,
                cache_dir: existingPaths.join(","),
                saved_paths: existingPaths,
                cache_id: id,
              },
              { archiveBytes: null as number | null },
            );
            postCollector.record({
              label: "target-cache",
              operation: "save",
              hit: false,
              key: targetKey,
              matchedKey: targetMatched,
              restoreKeys: [],
              archiveBytes: null,
              inflatedBytes: null,
              fileCount: null,
              durationMs: Date.now() - targetSaveStart,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`target-cache: save failed: ${message}`);
          targetCacheSave = Object.assign(
            {
              status: "failed" as const,
              cache_dir: existingPaths.join(","),
              saved_paths: existingPaths,
              error: message,
            },
            { archiveBytes: null as number | null },
          );
        }
        } // close: delta-gate else (save path) — #255
      }
    }
  }

  // Cargo registry cache (only when enabled). Legacy-v1 bundles registry plus
  // optional siblings into one tarball. Soldr-v2 owns registry in a Soldr
  // archive and keeps only `.global-cache`/`git` in the companion tarball.
  let cargoRegistrySave: CacheSaveResultWithStats = Object.assign(disabledSave(), {
    archiveBytes: null as number | null,
    inflatedBytes: null as number | null,
    fileCount: null as number | null,
    payload: null as CachePayloadCensus | null,
  });
  if (result.cargoRegistryCache.enabled) {
    const regSaveStart = Date.now();
    if (!allowCacheSave("cargo-registry-cache", log)) {
      cargoRegistrySave = Object.assign(
        { status: "policy-skip" as const, cache_dir: result.cargoRegistryCache.path },
        { archiveBytes: null, inflatedBytes: null, fileCount: null, payload: null },
      );
    } else if (registryMatched === result.cargoRegistryCache.key) {
      cargoRegistrySave = Object.assign(
        { status: "exact-hit-skip" as const, cache_dir: result.cargoRegistryCache.path },
        { archiveBytes: null, inflatedBytes: null, fileCount: null, payload: null },
      );
    } else if (result.cargoRegistryCache.archive.format === "soldr-v2") {
      const compressStart = Date.now();
      const payload = await cargoRegistryPayloadCensus(result.cargoHome, payloadPolicy.topN);
      if (payloadPolicy.warnBytes !== null && payload.bytes > payloadPolicy.warnBytes) {
        const largest = payload.topFiles
          .slice(0, 5)
          .map((entry) => `${entry.path} (${fmtBytes(entry.bytes)})`)
          .join(", ");
        core.notice(
          `setup-soldr: cargo-registry-cache payload is ${fmtBytes(payload.bytes)} before compression ` +
            `(>${fmtBytes(payloadPolicy.warnBytes)}). Largest files: ${largest || "none"}`,
        );
      }
      if (payloadPolicy.maxBytes !== null && payload.bytes > payloadPolicy.maxBytes) {
        const message =
          `setup-soldr: cargo-registry-cache payload is ${fmtBytes(payload.bytes)} before compression, ` +
          `exceeding cache-payload-max-bytes=${fmtBytes(payloadPolicy.maxBytes)}`;
        const status: SaveStatus = applyCachePayloadOversizeAction(
          payloadPolicy.oversizeAction,
          message,
        );
        log(`${message}; ${status === "failed" ? "failing" : "skipping"} v2 save`);
        cargoRegistrySave = Object.assign(
          {
            status,
            cache_dir: result.cargoRegistryCache.path,
            ...(status === "failed" ? { error: message } : {}),
          },
          {
            archiveBytes: null,
            inflatedBytes: payload.bytes,
            fileCount: payload.files,
            payload,
            phaseTimings: { compressMs: Date.now() - compressStart },
          },
        );
      } else {
        try {
          const archiveResult = await saveCargoRegistryArchive({
            plan: result.cargoRegistryCache.archive,
            cargoHome: result.cargoHome,
            soldrPath: result.soldrPath || process.env["SOLDR_BINARY"]?.trim() || "",
            soldrVersion: core.getState("soldrRuntimeVersion") || result.soldrVersionResolved,
            debug: debugMode,
            log: debugLog,
          });
          if (!archiveResult.used) {
            throw new Error(`cargo-registry soldr-v2 save unavailable: ${archiveResult.codecPath}`);
          }
          const compressMs = Date.now() - compressStart;
          const uploadStart = Date.now();
          try {
            const id = await gatedSaveCache(
              "cargo-registry-cache",
              result.cargoRegistryCache.archive.restorePaths,
              result.cargoRegistryCache.key,
              log,
            );
            const uploadMs = Date.now() - uploadStart;
            const status = await classifyCacheSaveReservation(
              id,
              result.cargoRegistryCache.key,
              () =>
                cache.restoreCache(
                  result.cargoRegistryCache.archive.restorePaths,
                  result.cargoRegistryCache.key,
                  [],
                  { lookupOnly: true },
                ),
            );
            if (status === "race-skip") {
              log(
                `cargo-registry-cache: save returned id=${id}, and an exact-key probe confirmed ` +
                  `a parallel job saved key=${result.cargoRegistryCache.key}`,
              );
            } else if (status === "failed") {
              log(
                `cargo-registry-cache: save returned id=${id}, but no exact-key entry exists; ` +
                  "reporting the save as failed",
              );
            }
            cargoRegistrySave = Object.assign(
              {
                status,
                cache_dir: result.cargoRegistryCache.path,
                cache_id: id,
                saved_paths: result.cargoRegistryCache.archive.restorePaths,
                ...(status === "failed"
                  ? { error: `saveCache returned id=${id} and exact-key verification missed` }
                  : {}),
              },
              {
                archiveBytes: archiveResult.archiveBytes,
                inflatedBytes: archiveResult.restoredBytes,
                fileCount: archiveResult.restoredFiles,
                payload,
                phaseTimings: { compressMs, uploadMs },
              },
            );
          } catch (err) {
            const uploadMs = Date.now() - uploadStart;
            const message = err instanceof Error ? err.message : String(err);
            log(`cargo-registry-cache: v2 save failed: ${message}`);
            cargoRegistrySave = Object.assign(
              {
                status: "failed" as const,
                cache_dir: result.cargoRegistryCache.path,
                saved_paths: result.cargoRegistryCache.archive.restorePaths,
                error: message,
              },
              {
                archiveBytes: archiveResult.archiveBytes,
                inflatedBytes: archiveResult.restoredBytes,
                fileCount: archiveResult.restoredFiles,
                payload,
                phaseTimings: { compressMs, uploadMs },
              },
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const compressMs = Date.now() - compressStart;
          log(`cargo-registry-cache: v2 archive creation failed: ${message}`);
          cargoRegistrySave = Object.assign(
            {
              status: "failed" as const,
              cache_dir: result.cargoRegistryCache.path,
              error: message,
            },
            {
              archiveBytes: null,
              inflatedBytes: payload.bytes,
              fileCount: payload.files,
              payload,
              phaseTimings: { compressMs },
            },
          );
        }
      }
    } else {
      cargoRegistrySave = await saveOne({
        cacheDir: result.cargoRegistryCache.path,
        codec: result.targetCacheCompress,
        level: result.targetCacheCompressLevel,
        key: result.cargoRegistryCache.key,
        matchedKey: registryMatched,
        label: "cargo-registry-cache",
        debug: debugMode,
        log: debugLog,
        extraBasenames: result.cargoRegistryCache.extraBasenames,
        payloadPolicy,
      });
    }
    // #287 follow-up: record EVERY outcome so the post-step save
    // table shows the layer no matter what its disposition.
    postCollector.record({
      label: "cargo-registry", operation: "save", hit: false,
      key: result.cargoRegistryCache.key, matchedKey: registryMatched, restoreKeys: [],
      status: cargoRegistrySave.status,
      archiveBytes: ["saved", "oversize-skip", "race-skip"].includes(cargoRegistrySave.status) ? cargoRegistrySave.archiveBytes : null,
      inflatedBytes: ["saved", "oversize-skip", "race-skip"].includes(cargoRegistrySave.status) ? cargoRegistrySave.inflatedBytes : null,
      fileCount: ["saved", "oversize-skip", "race-skip"].includes(cargoRegistrySave.status) ? cargoRegistrySave.fileCount : null,
      payload: ["saved", "oversize-skip", "race-skip"].includes(cargoRegistrySave.status) ? cargoRegistrySave.payload : null,
      durationMs: Date.now() - regSaveStart,
      compressMs: cargoRegistrySave.phaseTimings?.compressMs,
      uploadMs: cargoRegistrySave.phaseTimings?.uploadMs,
      timestamp: new Date().toISOString(),
    });
  }

  // Solo toolchain cache save. Opt-in via the `solo-toolchain-cache`
  // input. Skip the save when the install delta is empty (the common
  // case on hosted runners that already provide the requested
  // toolchain) — per CLAUDE.md "Default-stable workflows should
  // produce zero cache writes."
  const soloEnabled = core.getState("soloToolchainEnabled") === "true";
  if (soloEnabled) {
    const soloExactKey = core.getState("soloToolchainExactKey");
    const soloMatchedKey = core.getState("soloToolchainMatchedKey");
    const soloExactHit = core.getState("soloToolchainExactHit") === "true";
    const soloIncrementalEmpty = core.getState("soloToolchainIncrementalEmpty") === "true";
    const soloRestoreInvalid = core.getState("soloToolchainRestoreInvalid") === "true";
    const soloInvalidMatchedKey = core.getState("soloToolchainInvalidMatchedKey");
    const soloSaveDiffPath = core.getState("soloToolchainSaveDiffPath");
    const soloLevel = core.getState("soloToolchainLevel") || "9"; // #310
    log(
      `solo-toolchain-cache: post-step exactKey=${soloExactKey} matched=${soloMatchedKey} ` +
        `exactHit=${soloExactHit} restoreInvalid=${soloRestoreInvalid} ` +
        `incrementalEmpty=${soloIncrementalEmpty} saveDiffPath=${soloSaveDiffPath}`,
    );
    const [soloRepoOwner, soloRepoName] = (process.env["GITHUB_REPOSITORY"] ?? "").trim().split("/");
    const soloCacheToken = (process.env["GITHUB_TOKEN"] ?? "").trim() ||
      (process.env["INPUT_TOKEN"] ?? "").trim();
    const soloCacheRef = (process.env["GITHUB_REF"] ?? "").trim();
    let repairDeletionComplete = false;
    if (soloRestoreInvalid) {
      const deletion = await deleteCorruptSoloCacheEntries({
        owner: soloRepoOwner ?? "",
        repo: soloRepoName ?? "",
        token: soloCacheToken,
        key: soloInvalidMatchedKey,
        ref: soloCacheRef,
        log,
      });
      repairDeletionComplete = deletion.failed === 0 && deletion.deleted === deletion.found;
      if (deletion.failed > 0 || deletion.deleted < deletion.found) {
        core.warning(
          `solo-toolchain-cache: could not fully delete poisoned key=${soloInvalidMatchedKey}; ` +
          `found=${deletion.found} deleted=${deletion.deleted} failed=${deletion.failed}. ` +
          `The workflow token needs actions: write permission for automatic repair (#473).`,
        );
      }
    }
    // #313: pre-save lookupOnly probe. When several parallel jobs in
    // the same workflow all enable solo-toolchain-cache with the SAME
    // key (rustc × components × targets × soldr-version), each one
    // compresses + uploads ~140-175 MB only for GitHub Actions Cache
    // to reject all-but-one with id=-1. The wasted uploads dominate
    // the post-step (~100 s × N parallel jobs).
    let raceSkipped = false;
    if (!soloRestoreInvalid && !(soloExactHit && soloIncrementalEmpty) && soloSaveDiffPath && fs.existsSync(soloSaveDiffPath)) {
      try {
        const probeStart = Date.now();
        // #316: probe MUST use the same paths array that the actual
        // save/restore use — @actions/cache hashes paths into the
        // cache version. The canonical archive path is provided by
        // soloCacheArchivePath. The file does not need to exist for
        // lookupOnly (the library only hashes the path string).
        const probeArchivePath = soloCacheArchivePath(runnerTemp);
        const existing = await cache.restoreCache(
          [probeArchivePath],
          soloExactKey,
          [],
          { lookupOnly: true },
        );
        if (existing) {
          raceSkipped = true;
          log(
            `solo-toolchain-cache: pre-save lookupOnly probe found existing key=${existing} ` +
              `(probe ${Date.now() - probeStart}ms) — skipping stage+compress+upload (#313)`,
          );
          postCollector.record({
            label: "solo-toolchain-cache",
            operation: "save",
            status: "race-precheck-skipped",
            hit: false,
            key: soloExactKey,
            matchedKey: soloMatchedKey,
            restoreKeys: [],
            archiveBytes: null,
            inflatedBytes: null,
            fileCount: null,
            durationMs: Date.now() - probeStart,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        log(
          `solo-toolchain-cache: lookupOnly probe failed (will attempt save anyway): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (raceSkipped) {
      // probe found an existing entry; nothing more to do for this layer
    } else if (soloExactHit && soloIncrementalEmpty) {
      log("solo-toolchain-cache: exact hit and no install delta — skipping save");
    } else if (!soloSaveDiffPath || !fs.existsSync(soloSaveDiffPath)) {
      log("solo-toolchain-cache: no save-diff manifest available, skipping save");
      if (soloRestoreInvalid) {
        core.setFailed("solo-toolchain-cache: repaired a poisoned restore but has no replacement manifest (#473)");
      }
    } else {
      try {
        const manifest = JSON.parse(fs.readFileSync(soloSaveDiffPath, "utf8")) as {
          added?: SnapshotDiff["added"];
          changed?: SnapshotDiff["changed"];
        };
        const added = Array.isArray(manifest.added) ? manifest.added : [];
        const changed = Array.isArray(manifest.changed) ? manifest.changed : [];
        if (added.length === 0 && changed.length === 0) {
          log("solo-toolchain-cache: empty save-diff manifest, skipping save");
          if (soloRestoreInvalid) {
            core.setFailed("solo-toolchain-cache: repaired a poisoned restore but replacement manifest is empty (#473)");
          }
        } else {
          const soloRootMap: SoloRootMap = {
            "rustup-toolchains": path.join(result.rustupHome, "toolchains"),
            "cargo-bin": path.join(result.cargoHome, "bin"),
          };
          // #316 follow-up: the tar archive's top-level directory is
          // `basename(stagingDir)`. restoreSoloCache extracts into
          // `<stagingOut-parent>/` expecting the top-level entry name
          // to match the basename it uses (`staged`). Save MUST use
          // the same basename, or restore's `readdir(staged/)` returns
          // empty and the cache hit looks like a miss.
          const stagingDir = path.join(runnerTemp, "setup-soldr-solo-cache", "staged");
          const soloSaveStart = Date.now();
          const staged = await stageDiffForSave(
            { added, removed: [], changed },
            soloRootMap,
            stagingDir,
          );
          log(
            `solo-toolchain-cache: staged ${staged.stagedFiles} files and ${staged.stagedSymlinks} symlinks (missing=${staged.missingFiles})`,
          );
          if (soloRestoreInvalid && (staged.missingFiles > 0 || staged.stagedFiles + staged.stagedSymlinks === 0)) {
            core.setFailed(
              `solo-toolchain-cache: refusing incomplete repaired replacement for poisoned key=${soloInvalidMatchedKey}: ` +
                `files=${staged.stagedFiles} symlinks=${staged.stagedSymlinks} missing=${staged.missingFiles}`,
            );
            throw new Error("repaired solo-toolchain staging was incomplete");
          }
          const saveResult = await saveSoloCache({
            stagingDir,
            key: soloExactKey,
            level: soloLevel,
            debug: debugMode,
            log,
            // #316 follow-up: canonical archive path MUST match restore.
            // soloCacheArchivePath(runnerTemp) returns the same path
            // restoreSoloCache uses, ensuring @actions/cache version
            // hash agrees and restore can find the entry.
            cacheArchivePath: soloCacheArchivePath(runnerTemp),
            skipExistingProbe: soloRestoreInvalid,
            lookupExactKey: soloRestoreInvalid && repairDeletionComplete
              ? async () => (await soloCacheEntryExistsForRef({
                owner: soloRepoOwner ?? "",
                repo: soloRepoName ?? "",
                token: soloCacheToken,
                key: soloExactKey,
                ref: soloCacheRef,
                log,
              })) ? soloExactKey : undefined
              : undefined,
          });
          // #269: always record so the post-step save table shows
          // skipped/race-precheck/etc layers too, not just saved ones.
          postCollector.record({
            label: "solo-toolchain-cache",
            operation: "save",
            status: saveResult.status,
            hit: false,
            key: soloExactKey,
            matchedKey: soloMatchedKey,
            restoreKeys: [],
            archiveBytes: saveResult.status === "saved" ? (saveResult.archiveBytes ?? null) : null,
            inflatedBytes: saveResult.status === "saved" ? (saveResult.inflatedBytes ?? null) : null,
            fileCount: saveResult.status === "saved" ? (saveResult.fileCount ?? null) : null,
            durationMs: Date.now() - soloSaveStart,
            timestamp: new Date().toISOString(),
          });
          const repairRaceWonElsewhere = soloRestoreInvalid &&
            saveResult.status === "race-precheck-skipped" && repairDeletionComplete;
          if (saveResult.status === "policy-skip") {
            // #527: skip line already logged by the save-policy gate.
          } else if (saveResult.status !== "saved" && !repairRaceWonElsewhere) {
            log(`solo-toolchain-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
            if (soloRestoreInvalid) {
              core.setFailed(
                `solo-toolchain-cache: failed to publish repaired replacement for poisoned key=${soloInvalidMatchedKey}: ` +
                  `${saveResult.status}${saveResult.error ? ` (${saveResult.error})` : ""}`,
              );
            }
          }
        }
      } catch (err) {
        log(
          `solo-toolchain-cache: save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (soloRestoreInvalid) {
          core.setFailed(
            `solo-toolchain-cache: failed to publish repaired replacement for poisoned key=${soloInvalidMatchedKey}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // Cook cache save. Default-on layer; skipped when cook didn't run
  // (cache hit, gate disabled, or run failed). --long=27 per CLAUDE.md
  // "Compression" + the cook simulation findings; the level (GitHub -9,
  // local runner -1, see #268/#358 and zackees/ci.yml#227) comes from the
  // state main saved.
  const cookEnabled = core.getState("cookEnabled") === "true";
  if (cookEnabled) {
    const cookLayered = core.getState("cookLayered") === "true";
    const cookHit = core.getState("cookHit") === "true";
    const cookRan = core.getState("cookRan") === "true";
    const cookTargetDir = core.getState("cookTargetDir");
    if (cookLayered) {
      const cookSaveLayer = core.getState("cookSaveLayer") || "none";
      const cookProjectRoot = core.getState("cookProjectRoot");
      const cookBaseKey = core.getState("cookBaseExactKey");
      const cookDeltaKey = core.getState("cookDeltaExactKey");
      const cookBaseArchive = core.getState("cookBaseArchive");
      const cookDeltaArchive = core.getState("cookDeltaArchive");
      const cookBaseManifest = core.getState("cookBaseManifest");
      const soldrBinary =
        core.getState("cookSoldrBinary") || process.env["SOLDR_BINARY"]?.trim() || "soldr";
      log(
        `cook-cache: post-step layered save_layer=${cookSaveLayer} hit=${cookHit} ` +
          `ran=${cookRan} target=${cookTargetDir}`,
      );
      if (!cookRan || cookSaveLayer === "none") {
        log("cook-cache: layered cache warm or cook did not run successfully - skipping save");
      } else if (!cookTargetDir || !fs.existsSync(cookTargetDir)) {
        log(`cook-cache: target dir ${cookTargetDir} missing - skipping save`);
      } else if (!cookProjectRoot || !fs.existsSync(cookProjectRoot)) {
        log(`cook-cache: project root ${cookProjectRoot} missing - skipping save`);
      } else {
        const saveKey = cookSaveLayer === "delta" ? cookDeltaKey : cookBaseKey;
        const archivePath = cookSaveLayer === "delta" ? cookDeltaArchive : cookBaseArchive;
        const level =
          cookSaveLayer === "delta"
            ? core.getState("cookDeltaCompressLevel") || "3"
            : core.getState("cookCompressLevel") || "9";
        const cookSaveStart = Date.now();
        try {
          const saveResult = await saveLayeredCookCache({
            soldrBinary,
            projectRoot: cookProjectRoot,
            targetDir: cookTargetDir,
            exactKey: saveKey,
            archivePath,
            layer: cookSaveLayer === "delta" ? "delta" : "base",
            zstdLevel: level,
            baseManifestPath: cookBaseManifest,
            log,
          });
          // #269: always record so the save table includes skipped/
          // race-precheck/oversize layers, not only saved ones.
          postCollector.record({
            label: `cook-cache-${cookSaveLayer}`,
            operation: "save",
            status: saveResult.status,
            hit: false,
            key: saveKey,
            matchedKey: "",
            restoreKeys: [],
            archiveBytes: saveResult.status === "saved" ? (saveResult.archiveBytes ?? null) : null,
            inflatedBytes: saveResult.status === "saved" ? (saveResult.inflatedBytes ?? null) : null,
            fileCount: saveResult.status === "saved" ? (saveResult.fileCount ?? null) : null,
            durationMs: Date.now() - cookSaveStart,
            compressMs: saveResult.compressMs,
            uploadMs: saveResult.uploadMs,
            timestamp: new Date().toISOString(),
          });
          if (saveResult.status !== "saved") {
            log(`cook-cache-${cookSaveLayer}: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
          }
        } catch (err) {
          log(`cook-cache-${cookSaveLayer}: save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      const cookExactKey = core.getState("cookExactKey");
      const cookLongWindow = parseInt(core.getState("cookLongWindow") || "27", 10);
      const cookLevel = core.getState("cookCompressLevel") || "9";
      log(
        `cook-cache: post-step key=${cookExactKey} hit=${cookHit} ran=${cookRan} target=${cookTargetDir}`,
      );
      if (cookHit) {
        log("cook-cache: exact hit - skipping save");
      } else if (!cookRan) {
        log("cook-cache: cook did not run successfully - skipping save");
      } else if (!cookTargetDir || !fs.existsSync(cookTargetDir)) {
        log(`cook-cache: target dir ${cookTargetDir} missing - skipping save`);
      } else {
        const cookSaveStart = Date.now();
        try {
          const saveResult = await saveCookCache({
            targetDir: cookTargetDir,
            exactKey: cookExactKey,
            level: cookLevel,
            longWindow: cookLongWindow,
            debug: debugMode,
            log,
          });
          // #269: always record (skipped layers too).
          postCollector.record({
            label: "cook-cache",
            operation: "save",
            status: saveResult.status,
            hit: false,
            key: cookExactKey,
            matchedKey: "",
            restoreKeys: [],
            archiveBytes: saveResult.status === "saved" ? (saveResult.archiveBytes ?? null) : null,
            inflatedBytes: saveResult.status === "saved" ? (saveResult.inflatedBytes ?? null) : null,
            fileCount: saveResult.status === "saved" ? (saveResult.fileCount ?? null) : null,
            durationMs: Date.now() - cookSaveStart,
            compressMs: saveResult.compressMs,
            uploadMs: saveResult.uploadMs,
            timestamp: new Date().toISOString(),
          });
          if (saveResult.status !== "saved") {
            log(`cook-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
          }
        } catch (err) {
          log(`cook-cache: save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // Soldr-mini-cache save. Default-on; skipped when restore already hit
  // (binary is byte-identical, no point re-saving), when disabled, or
  // when running in passthrough mode.
  const soldrMiniEnabled = core.getState("soldrMiniEnabled") === "true";
  if (soldrMiniEnabled && !passthrough) {
    const miniHit = core.getState("soldrMiniHit") === "true";
    const miniExactKey = core.getState("soldrMiniExactKey");
    const miniInstallDir = core.getState("soldrMiniInstallDir");
    const miniArchive = core.getState("soldrMiniArchive");
    log(
      `soldr-mini-cache: post-step key=${miniExactKey} hit=${miniHit} installDir=${miniInstallDir}`,
    );
    if (miniHit) {
      log("soldr-mini-cache: exact hit — skipping save");
    } else if (!miniExactKey) {
      log("soldr-mini-cache: no key (ineligible at main-time) — skipping save");
    } else if (!miniInstallDir || !fs.existsSync(miniInstallDir)) {
      log(`soldr-mini-cache: install dir ${miniInstallDir} missing — skipping save`);
    } else {
      const miniSaveStart = Date.now();
      try {
        const saveResult = await saveMiniCache({
          installDir: miniInstallDir,
          archivePath: miniArchive,
          exactKey: miniExactKey,
          // Runner profile: GitHub -19, local runner (ACT) -1. Keep
          // --long=27 at every level: restore needs the window.
          level: cacheProfileDefault("soldr-mini-zstd-level", isLocalRunner(process.env)),
          longWindow: 27,
          debug: debugMode,
          log,
        });
        // #269: always record (skipped layers too).
        postCollector.record({
          label: "soldr-mini-cache",
          operation: "save",
          status: saveResult.status,
          hit: false,
          key: miniExactKey,
          matchedKey: "",
          restoreKeys: [],
          archiveBytes: saveResult.status === "saved" ? (saveResult.archiveBytes ?? null) : null,
          inflatedBytes: saveResult.status === "saved" ? (saveResult.inflatedBytes ?? null) : null,
          fileCount: saveResult.status === "saved" ? (saveResult.fileCount ?? null) : null,
          durationMs: Date.now() - miniSaveStart,
          timestamp: new Date().toISOString(),
        });
        if (saveResult.status !== "saved") {
          log(
            `soldr-mini-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`,
          );
        }
      } catch (err) {
        log(`soldr-mini-cache: save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /* retired per-lane cache save removed; Soldr owns this state */
  /*
  // ---- retired per-lane cache save ----
  // Wave 2.1 of zackees/soldr#514. Save each lane whose restore missed and
  // whose `paths` actually exist on disk after executeCrossBootstrap ran.
  // Skipping exact hits avoids re-uploading identical content; skipping
  // missing paths avoids cache-API failures on unsupported lanes.
  try {
    const lanePlansRaw = core.getState("retiredLaneCachePlans");
    const restoresRaw = core.getState("retiredLaneCacheRestores");
    if (lanePlansRaw) {
      const lanePlans = JSON.parse(lanePlansRaw) as Array<{
        host: string;
        target: string;
        key: string;
        paths: string[];
      }>;
      const restores = restoresRaw
        ? (JSON.parse(restoresRaw) as Record<string, { hit: boolean; matchedKey: string }>)
        : {};
      for (const lane of lanePlans) {
        if (!lane.paths || lane.paths.length === 0) {
          continue; // unsupported lane, nothing to save
        }
        const restore = restores[lane.target];
        if (restore?.hit) {
          log(`cross-tool-cache: lane=${lane.target} exact hit — skipping save`);
          continue;
        }
        // Only save when at least one of the lane's paths exists. The cache
        // API will error on a fully-missing path list, and there's no
        // point uploading nothing.
        const existing = lane.paths.filter((p) => {
          try {
            return fs.existsSync(p);
          } catch {
            return false;
          }
        });
        if (existing.length === 0) {
          log(`cross-tool-cache: lane=${lane.target} no paths exist on disk — skipping save`);
          continue;
        }
        const t0 = Date.now();
        try {
          const id = await gatedSaveCache(`cross-tool-cache:${lane.target}`, existing, lane.key, log);
          if (id > 0) {
            log(`cross-tool-cache: lane=${lane.target} saved id=${id} key=${lane.key}`);
            postCollector.record({
              label: `cross-tool-cache:${lane.target}`,
              operation: "save",
              hit: false,
              key: lane.key,
              matchedKey: "",
              restoreKeys: [],
              archiveBytes: null,
              inflatedBytes: null,
              fileCount: null,
              durationMs: Date.now() - t0,
              timestamp: new Date().toISOString(),
            });
          } else {
            log(
              `cross-tool-cache: lane=${lane.target} save skipped (id=${id}) — likely concurrent save by another job`,
            );
          }
        } catch (err) {
          log(
            `cross-tool-cache: lane=${lane.target} save failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  } catch (err) {
    log(`cross-tool-cache: post-step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  */
  // ---- blessed Soldr prepare archive save ----
  try {
    const planRaw = core.getState("blessedPrepareCacheEnabled");
    const exactHit = core.getState("blessedPrepareCacheExactHit") === "true";
    const complete = core.getState("blessedPrepareComplete") === "true";
    const plan = result.blessedPrepareCache;
    const archivesReady = plan.archivePaths.length > 0
      && plan.archivePaths.every((archivePath) => fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0);
    if (planRaw === "true" && !allowCacheSave("blessed-prepare-cache", log)) {
      // #527: skip line logged by the save-policy gate.
    } else if (planRaw === "true" && !exactHit && complete && archivesReady) {
      const t0 = Date.now();
      try {
        const id = await gatedSaveCache("blessed-prepare-cache", plan.archivePaths, plan.key, log);
        log(`blessed-prepare-cache: ${id > 0 ? "saved" : "save skipped"} key=${plan.key}`);
        postCollector.record({ label: "blessed-prepare-cache", operation: "save", hit: false, key: plan.key, matchedKey: "", restoreKeys: [], archiveBytes: null, inflatedBytes: null, fileCount: null, durationMs: Date.now() - t0, timestamp: new Date().toISOString() });
      } catch (err) {
        log(`blessed-prepare-cache: save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (planRaw === "true") {
      log("blessed-prepare-cache: save skipped (exact hit, incomplete, missing, or empty archive)");
    }
  } catch (err) {
    log(`blessed-prepare-cache: post-step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- Dylint tool/driver cache save (setup-soldr#221) ----
  // Exact-key only and opt-in. Cold jobs keep their existing install/build
  // steps; warm jobs restore cargo-dylint/dylint-link plus the compatible
  // driver directory before those steps run.
  try {
    if (result.dylintCache.enabled && result.dylintCache.paths.length > 0) {
      const exactHit = core.getState("dylintCacheExactHit") === "true";
      if (!allowCacheSave("dylint-cache", log)) {
        // #527: skip line logged by the save-policy gate.
      } else if (exactHit) {
        log("dylint-cache: exact hit - skipping save");
      } else {
        const markerValid =
          !result.dylintCache.successMarker ||
          (() => {
            try {
              return dylintMarkerIdentityMatches(
                fs.readFileSync(result.dylintCache.successMarker, "utf8"),
                result.dylintCache.cacheIdentity,
                result.dylintCache.hostTriple,
              );
            } catch {
              return false;
            }
          })();
        const existing = result.dylintCache.paths.some(
          (p) => p !== result.dylintCache.successMarker && cachePathExists(p),
        );
        if (!markerValid) {
          log("dylint-cache: no matching successful Dylint marker - skipping save");
        } else if (!existing) {
          log("dylint-cache: no foundation payload exists on disk - skipping save");
        } else {
          const t0 = Date.now();
          try {
            const id = await gatedSaveCache("dylint-cache", result.dylintCache.paths, result.dylintCache.key, log);
            if (id > 0) {
              log(`dylint-cache: saved id=${id} key=${result.dylintCache.key}`);
              postCollector.record({
                label: "dylint-cache",
                operation: "save",
                hit: false,
                key: result.dylintCache.key,
                matchedKey: "",
                restoreKeys: [],
                archiveBytes: null,
                inflatedBytes: null,
                fileCount: null,
                durationMs: Date.now() - t0,
                timestamp: new Date().toISOString(),
              });
            } else {
              log(`dylint-cache: save skipped (id=${id}) - likely concurrent save by another job`);
            }
          } catch (err) {
            log(`dylint-cache: save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  } catch (err) {
    log(`dylint-cache: post-step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Project outputs are deliberately separate from the long-lived nightly
  // foundation. Save only after Soldr records a successful outer Dylint run;
  // a restored foundation marker is never sufficient because this marker is
  // not part of either cache payload.
  try {
    if (
      result.dylintCache.outputCacheEnabled &&
      result.dylintCache.outputPaths.length > 0
    ) {
      const exactHit = core.getState("dylintOutputCacheExactHit") === "true";
      if (!allowCacheSave("dylint-output-cache", log)) {
        // #527: skip line logged by the save-policy gate.
      } else if (exactHit) {
        log("dylint-output-cache: exact hit - skipping save");
      } else {
        let markerValid = false;
        try {
          markerValid = dylintMarkerIdentityMatches(
            fs.readFileSync(result.dylintCache.successMarker, "utf8"),
            result.dylintCache.cacheIdentity,
            result.dylintCache.hostTriple,
          );
        } catch {
          markerValid = false;
        }
        const existing = result.dylintCache.outputPaths.some((p) => cachePathExists(p));
        if (!markerValid) {
          log("dylint-output-cache: Dylint did not complete successfully - skipping save");
        } else if (!existing) {
          log("dylint-output-cache: no Dylint output paths exist - skipping save");
        } else {
          const t0 = Date.now();
          try {
            const id = await gatedSaveCache(
              "dylint-output-cache",
              result.dylintCache.outputPaths,
              result.dylintCache.outputKey,
              log,
            );
            if (id > 0) {
              log(
                `dylint-output-cache: saved id=${id} key=${result.dylintCache.outputKey}`,
              );
              postCollector.record({
                label: "dylint-output-cache",
                operation: "save",
                hit: false,
                key: result.dylintCache.outputKey,
                matchedKey: "",
                restoreKeys: [],
                archiveBytes: null,
                inflatedBytes: null,
                fileCount: null,
                durationMs: Date.now() - t0,
                timestamp: new Date().toISOString(),
              });
            } else {
              log(
                `dylint-output-cache: save skipped (id=${id}) - likely concurrent save`,
              );
            }
          } catch (err) {
            log(
              `dylint-output-cache: save failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  } catch (err) {
    log(
      `dylint-output-cache: post-step failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const finalSummary = buildFinalCacheSummary(
    result,
    restoreState,
    {
      buildCache: buildSave,
      cargoRegistryCache: cargoRegistrySave,
      targetCache: targetCacheSave,
    },
    passthrough,
  );
  logFinalCacheSummary(finalSummary, log);
  // #269: post-step save-aggregate visibility.
  //
  // Two views, both pulled from the existing StatsCollector records
  // — no new instrumentation:
  //
  //   1. Per-layer table (`saveSummaryText`): one row per save op
  //      showing label, status, archive bytes, file count, wall_ms.
  //      Footer rolls up the totals. Shows WHICH layer ate the budget.
  //   2. One-line aggregate (`saveSummaryOneLine`): the rolled-up
  //      number at a glance for skim-readers.
  //
  // Logged in that order so an operator scanning bottom-up sees the
  // one-liner first, then drops into the table if they want detail.
  const saveTable = postCollector.saveSummaryText();
  if (saveTable) log(saveTable);
  const saveTotals = postCollector.saveSummaryOneLine();
  if (saveTotals) log(saveTotals);

  // setup-soldr#593: this run's verdicts and job manifest.
  try {
    await verdictPost({ runnerTemp: verdictTemp, log });
  } catch (err) {
    log(`verdict: post failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // #347: repo-level Actions Cache eviction. Runs AFTER all save
  // activity so it doesn't evict what this run just wrote. No-op
  // unless policy is set + usage > trigger threshold. Foundation
  // prefixes (solo-toolchain, cargo-registry, soldr-mini,
  // setup-cache) are never touched.
  try {
    const policyRaw = (rawInputs.cacheEvictionPolicy ?? "").trim().toLowerCase();
    const policyMap: Record<string, CacheEvictionPolicy> = {
      "": "disabled",
      "disabled": "disabled",
      "off": "disabled",
      "false": "disabled",
      "protect-foundations": "protect-foundations",
      "aggressive": "aggressive",
    };
    const policy = policyMap[policyRaw] ?? "disabled";
    if (policy !== "disabled") {
      const githubRepository = (process.env["GITHUB_REPOSITORY"] ?? "").trim();
      const [owner, repo] = githubRepository.split("/");
      const token = (process.env["GITHUB_TOKEN"] ?? "").trim() ||
        (process.env["INPUT_TOKEN"] ?? "").trim();
      if (!owner || !repo) {
        log("cache-eviction: GITHUB_REPOSITORY not set or malformed — skipping");
      } else if (!token) {
        log("cache-eviction: no GitHub token available — skipping");
      } else {
        await evictIfOverBudget(policy, { owner, repo, token, log });
      }
    }
  } catch (err) {
    log(`cache-eviction: best-effort run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (compileCacheStats !== "none") {
    setCompileCacheOutputs(finalSummary.compile_cache_report, compileCacheStats);
    // PR4 — surface the two job-wide scalar outputs alongside the
    // existing per-session outputs. The setter no-ops when the archive
    // walker didn't find >1 sessions, so single-session jobs see no
    // change in behavior.
    setMultiSessionOutputs(finalSummary.multi_session_rollup);
  }
  writeStepSummary(formatFinalCacheSummaryMarkdown(finalSummary, compileCacheStats), log);

  // Job-wide compile-cache hit/miss counts, read post-hoc from the
  // multi-session rollup (preferred) or the last-session report. Shared by
  // the cook reuse-mismatch notice (#235) and the zero-count guard (#227).
  let jobHits: number | null = null;
  let jobMisses: number | null = null;
  {
    const rollup = finalSummary.multi_session_rollup;
    if (rollup && rollup.sessionCount > 0) {
      jobHits = rollup.totalHits;
      jobMisses = rollup.totalMisses;
    } else if (
      finalSummary.compile_cache_report.status === "ok" &&
      finalSummary.compile_cache_report.report
    ) {
      const last = finalSummary.compile_cache_report.report["last_session"] as
        | Record<string, unknown>
        | null;
      if (last) {
        jobHits = numberStat(last, "hits") ?? null;
        jobMisses = numberStat(last, "misses") ?? null;
      }
    }
  }

  // Cook reuse-mismatch notice (issue #235). Post-hoc only: setup-soldr
  // can't know the consumer's downstream cargo profile/toolchain at cook
  // time, so the "cook ran but nothing reused it" fingerprint is only
  // observable here, after the job's compiles have been recorded.
  {
    const cookSignal = detectCookReuseMismatch({
      cookEnabled: core.getState("cookEnabled") === "true",
      cookProducedDeps:
        core.getState("cookHit") === "true" || core.getState("cookRan") === "true",
      hits: jobHits,
      misses: jobMisses,
      cookFlags: rawInputs.prebuildDepsFlags,
    });
    if (cookSignal.mismatch) core.notice(cookSignal.message);
  }

  // Compile-cache activity verification (issue #227). Opt-in via
  // verify-compile-cache. When a job that is expected to exercise zccache
  // reports hits+misses==0, the build bypassed the cache (or the measurement
  // is invalid) — fail or warn instead of laundering it into warm-cache
  // evidence. Every legitimate bypass (passthrough, build-cache off, no
  // stats) is reported as a quiet skip.
  {
    const verify = verifyCompileCacheActivity({
      mode: parseVerifyCompileCacheMode(rawInputs.verifyCompileCache),
      enabled: !passthrough,
      buildCacheEnabled: restoreState.buildCacheEnabled,
      reportStatus: finalSummary.compile_cache_report.status,
      hits: jobHits,
      misses: jobMisses,
      env: {
        rustcWrapper: process.env["RUSTC_WRAPPER"],
        soldrCacheDir: process.env["SOLDR_CACHE_DIR"],
        zccacheCacheDir: process.env["ZCCACHE_CACHE_DIR"],
        shimsDir: process.env["SETUP_SOLDR_SHIMS_DIR"],
        statsPath:
          finalSummary.compile_cache_report.status === "ok"
            ? resolveZccacheSessionStatsPath(result.buildCache.path)
            : undefined,
      },
    });
    core.setOutput("compile-cache-verification", verify.status);
    if (verify.fail) {
      core.setFailed(verify.message);
    } else if (verify.status === "invalid-measurement") {
      core.warning(verify.message);
    } else if (verify.message && loggingEnabled(rawInputs.logging)) {
      log(verify.message);
    }
  }

  // PR3 — insights mode side-effects: emit GH annotations + optional
  // chrome-trace artifact upload. These run only when the user explicitly
  // opted into `insights`; the markdown insights block already landed in
  // the step summary above via formatFinalCacheSummaryMarkdown.
  if (compileCacheStats === "insights") {
    await emitInsightsAnnotationsAndTrace({
      report: finalSummary.compile_cache_report,
      soldrBinary: process.env["SOLDR_BINARY"]?.trim(),
      runnerTemp,
      log,
    });
  }
  const reportPath = writeCompileCacheReportFile(finalSummary.compile_cache_report, runnerTemp, log);
  if (reportPath) {
    log(`compile-cache-report.json written to ${reportPath}`);
  }

  // Note: setup-soldr-cache-keys.txt is written in main.ts (right after
  // resolveSetup) so workflow steps that run between main and post —
  // notably actions/upload-artifact — can read it. Re-write it here
  // anyway as a safety net in case main.ts crashed before writing.
  if (runnerTemp) {
    writeCacheKeysManifestFromSummary(finalSummary, runnerTemp, log);
  }

  // Append save ops to detailed session log if requested
  if (statsMode === "detailed" && runnerTemp) {
    try {
      await postCollector.appendSavesToSessionLog(runnerTemp);
    } catch (err) {
      log(`post: stats log append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Optional verbose diagnostic dump. Gated on `logging: true` which
  // main.ts persists into action state.
  const loggingState = core.getState("logging");
  if (loggingEnabled(loggingState)) {
    // zccache writes its per-rustc-invocation JSONL journal under the
    // build-cache directory (which == ZCCACHE_CACHE_DIR per
    // resolve-setup.ts's env exports). When `logging: true` is on we
    // surface its contents so the reader can answer "warm reported 0
    // hits — why did each lookup miss" without another build.
    // Resolve the journal the same private-dir-aware way as the stats file —
    // soldr's private daemon sessions write it under
    // `<cache>/private/<id>/logs/`, not the bare `<cache>/logs/` (#247).
    const journalPath = resolveZccacheSessionJournalPath(result.buildCache.path);
    // Forward the verbatim `report` field from `soldr cache report --json`
    // so dumpDiagnostics can format its `rollups` (per-extension /
    // per-crate / slowest_entries) breakdown.
    const cacheReport = finalSummary.compile_cache_report.report;
    // Capture a process snapshot only when debug mode is on — `ps` /
    // `tasklist` are cheap but the output is large and only useful when
    // you're investigating cache-state weirdness (e.g. orphan daemons).
    const processSnapshot = debugMode ? captureProcessSnapshot() ?? undefined : undefined;
    dumpDiagnostics({
      phase: "post",
      env: process.env,
      rawInputs,
      result,
      cacheOutcomes: postCollector.snapshot(),
      finalSummary: finalSummary as unknown as Record<string, unknown>,
      journalPath,
      // Raw JSONL stream — one record per rustc invocation, often
      // thousands of lines / 20-30 MB of stdout per warm build. Default
      // gate is `debug:true` (backwards compat with #134 era), but a
      // workflow can explicitly opt out via `journal-print-raw: false`
      // when it already uploads the JSONL as an artifact and doesn't
      // want to pay the post-step log-writer cost (~30-50 s on the
      // hosted ubuntu demo).
      journalPrintRaw: resolveJournalPrintRaw(rawInputs.journalPrintRaw, debugMode),
      cacheReport,
      processSnapshot,
      logger,
      stepSummaryPath: process.env["GITHUB_STEP_SUMMARY"]?.trim() || undefined,
    });
  }
}

function writeCacheKeysManifestFromSummary(
  summary: FinalCacheSummary,
  runnerTemp: string,
  log: (msg: string) => void,
): void {
  const keys = [
    summary.setup_cache.key,
    summary.build_cache.key,
    summary.target_cache.key,
    summary.cargo_registry_cache.key,
  ].filter((k) => Boolean(k));
  if (keys.length === 0) return;
  const outPath = path.join(runnerTemp, "setup-soldr-cache-keys.txt");
  try {
    fs.writeFileSync(outPath, keys.join("\n") + "\n", "utf8");
    log(`cache-keys manifest written to ${outPath} (${keys.length} keys)`);
  } catch (err) {
    log(`post: failed to write cache-keys manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// See main.ts for the rationale behind the test-import escape hatch.
if (
  typeof process !== "undefined" &&
  !process.env["SETUP_SOLDR_TEST_IMPORT"]
) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    core.warning(`setup-soldr post-job step failed: ${message}`);
  });
}
