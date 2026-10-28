// Shared types for setup-soldr.
//
// This module defines the API surface that the three parallel implementation
// agents share. It is the contract — every exported function in src/lib/*
// uses these types, and src/main.ts wires them together.
//
// Mirror of the GitHub Actions inputs/outputs declared in action.yml.

export type Bool = "true" | "false";
export type CompressCodec = "auto" | "zstd" | "none";
export type BuildCacheMode = "" | "once" | "thin" | "full";
export type TargetCacheMode = "" | "thin" | "full" | "off" | "hot";
export type TargetCacheProfile = "thin-v1" | "thin-v2" | "thin-v3";
export type StatsMode = "none" | "summarize" | "detailed";
export type CompileCacheStatsMode = "none" | "summarize" | "detailed" | "insights";

export interface CachePayloadEntry {
  path: string;
  bytes: number;
}

export interface CachePayloadSubtree {
  path: string;
  bytes: number;
  files: number;
}

export interface CachePayloadSkipSummary {
  reason: string;
  count: number;
  samples: string[];
}

export interface CachePayloadCensus {
  bytes: number;
  files: number;
  symlinks: number;
  directories: number;
  inputs: string[];
  topFiles: CachePayloadEntry[];
  topDirectories: CachePayloadEntry[];
  topSubtrees: CachePayloadSubtree[];
  skipped: CachePayloadSkipSummary[];
}

export interface CacheOpStats {
  label: string;
  operation: "restore" | "save";
  status?: string;
  hit: boolean;
  key: string;
  matchedKey: string;
  restoreKeys: string[];
  archiveBytes: number | null;
  inflatedBytes: number | null;
  fileCount: number | null;
  payload?: CachePayloadCensus | null;
  durationMs: number;
  /**
   * #360: split timing — `compressMs` covers the codec (zstd) wall-clock,
   * `uploadMs` covers the Actions Cache `saveCache` API call. When both
   * are set, `compressMs + uploadMs` approximates `durationMs` (plus a
   * small bookkeeping delta). Optional — only cook-cache surfaces these
   * today; other layers leave them undefined.
   */
  compressMs?: number;
  uploadMs?: number;
  timestamp: string;
}

/**
 * Raw INPUT_* env vars read at process start. Mirrors `inputs:` in action.yml.
 * Values are strings (GitHub Actions inputs are always strings); normalize
 * inside the resolve layer.
 */
export interface RawInputs {
  enable: string;
  version: string;
  repo: string;
  ref: string;
  sourcePath: string;
  cache: string;
  cacheDir: string;
  cacheKeySuffix: string;
  key?: string;
  autoKey?: string;
  autoKeyTrustedWriters?: string;
  cachePreset: string;
  toolchain: string;
  toolchainFile: string;
  trustMode: string;
  linker: string;
  compilePriority: string;
  timestamps: string;
  timestampFormat: string;
  lockfile: string;
  buildCache: string;
  buildCacheMode: string;
  zccacheSeedStrict: string;
  targetCache: string;
  targetCacheMode: string;
  targetDir: string;
  targetCacheProfile: string;
  targetCacheStripDebuginfo: string;
  targetCacheIncludeIncremental: string;
  targetCacheIncludeBuildScriptBinaries: string;
  targetCacheCompress: string;
  targetCacheCompressLevel: string;
  cachePayloadWarnBytes: string;
  cachePayloadMaxBytes: string;
  cachePayloadOversizeAction: string;
  cachePayloadTopN: string;
  cacheEncryptKey: string;
  cacheEncryptOnFailure: string;
  sourceMtimeNormalize: string;
  cargoRegistryCache: string;
  compileCacheStats: string;
  shims: string;
  stats: string;
  debugMode: string;
  cacheShutdownOnIdle: string;
  rustBacktrace: string;
  logging: string;
  preserveSourceMtimes: string;
  soloToolchainCache: string;
  soloToolchainCacheLevel: string;
  cacheEvictionPolicy: string;
  prebuildDeps: string;
  prebuildDepsFlags: string;
  prebuildDepsDeltaCache: string;
  cookDelta: string;
  soldrMiniCache: string;
  verdicts: string;
  ciTests: string;
  dylint: string;
  dylintFoundationCache: string;
  dylintOutputCache: string;
  dylintCache: string;
  dylintToolchain: string;
  dylintDriverRev: string;
  cargoDylintVersion: string;
  dylintLinkVersion: string;
  dylintCachePaths: string;
  dylintTargets: string;
  journalPrintRaw: string;
  crossTargets: string;
  verifyCompileCache: string;
  seedIsolatedBuildCache: string;
  buildCacheSaveMinCompiles: string;
  /** `${{ job.status }}` by default; re-evaluated for the post step (#559). */
  jobStatus: string;
  /** "true" saves build outputs even when the job failed (#559). */
  saveOnFailure: string;
  targetCacheSaveMinCompiles: string;
}

/**
 * Toolchain spec resolved from rust-toolchain.toml (or input override).
 * Equivalent of resolve_setup.load_toolchain_spec() in Python.
 */
export interface ToolchainSpec {
  channel: string;
  cacheChannel: string;
  profile: string;
  components: string[];
  targets: string[];
  source: string;
  fileHash: string;
}

/**
 * Setup-cache key plan (the action-owned cache holding soldr binary + rustup state).
 */
export interface SetupCachePlan {
  key: string;
  restorePrefix: string;
  paths: string[];
  setupCachePath: string;
  layout: "bin+soldr-bin" | "bin+soldr-bin+rustup";
}

/**
 * Build-cache key plan (zccache compilation cache).
 */
export interface BuildCachePlan {
  enabled: boolean;
  key: string;
  restoreKeyParent: string;
  restoreKeyToolchain: string;
  restoreKeyOsArch: string;
  path: string;
  mode: "once" | "thin" | "full";
}

/**
 * Target-cache key plan (zccache rust-plan bundle + optional full target/ tree).
 */
export interface TargetCachePlan {
  enabled: boolean;
  key: string;
  restoreKeyParent: string;
  restoreKeyLock: string;
  restoreKeyLockfile: string;
  paths: string;
  bundlePath: string;
  targetPath: string;
  effectiveMode: "once" | "thin" | "full" | "off";
  profile: TargetCacheProfile;
  budgetBytes: string;
  budgetFiles: string;
  lockfilePath: string;
  lockfileHash: string;
}

/**
 * Cargo-registry cache plan (payload C of issue #70).
 *
 * `path` is the primary cache dir (`$CARGO_HOME/registry`) and the host
 * of the tarball — the archive is written as `${path}.tar.zst` so the
 * existing on-disk shape, restore key, and cache key are unchanged.
 *
 * `extraBasenames` are sibling directories under `dirname(path)` that
 * ride inside the same archive without a new actions/cache layer or a
 * cache-key change — see setup-soldr#102. Today these are:
 *   - `.global-cache` — cargo's RFC-3413 GC database; without it every
 *     job's `cargo gc` sees fresh access times and conservatively keeps
 *     everything. setup-soldr persists it, soldr reads it (zackees/soldr#323).
 *   - `git`           — `$CARGO_HOME/git/{db,checkouts}/`, the bare git
 *     mirrors plus checked-out source trees for git-source crate deps.
 * Missing siblings are silently skipped on save so a cold checkout (no
 * `git/` deps cloned yet) still produces a valid archive.
 */
export type CargoRegistryArchiveFormat = "legacy-v1" | "soldr-v2";

export interface CargoRegistryArchivePlan {
  format: CargoRegistryArchiveFormat;
  registryArchivePath: string;
  extrasArchivePath: string;
  restorePaths: string[];
}

export interface CargoRegistryCachePlan {
  enabled: boolean;
  key: string;
  restorePrefix: string;
  path: string;
  extraBasenames: string[];
  archive: CargoRegistryArchivePlan;
}

/**
 * Dylint mode and legacy tool/driver cache plan (setup-soldr#221).
 *
 * `dylint: true` asks Soldr to prepare its catalogued binaries and compatible
 * prebuilt driver on cold runs. `dylint-cache: true` without Dylint mode keeps
 * the original cache-only contract for workflows that own installation.
 */
export interface DylintCachePlan {
  enabled: boolean;
  outputCacheEnabled: boolean;
  outputKey: string;
  /**
   * setup-soldr#540 / ci.yml#1: `actions/cache` restore-keys fallback for
   * `outputKey`, dropping ONLY the Cargo.lock component so a dependency
   * bump still restores the newest prior generation (same toolchain +
   * lint-library identity) instead of cooking fully cold. Never crosses a
   * toolchain or workspace/lint-library manifest change. Empty when the
   * output cache is disabled.
   */
  outputRestoreKeys: string[];
  outputPaths: string[];
  key: string;
  paths: string[];
  driverPath: string;
  hostTriple: string;
  toolchain: string;
  rustcRelease: string;
  rustcCommitHash: string;
  cacheIdentity: string;
  successMarker: string;
  driverRev: string;
  cargoDylintVersion: string;
  dylintLinkVersion: string;
  /** ci.yml#9: additional cross targets prepared/checked alongside the host. */
  crossTargets: string[];
  /** hostTriple + crossTargets, deduped and sorted; drives the cache identity. */
  allTargets: string[];
}

/**
 * Full resolved state from resolve-setup. Drives every downstream step.
 *
 * This is the single source of truth produced by resolveSetup() and consumed
 * by the orchestrator + every helper. Mirrors the output set written to
 * $GITHUB_OUTPUT by Python's resolve_setup.py.
 */
export interface ResolveResult {
  // Enabled flag. When false, ensureSoldr/verifySoldr are skipped and a
  // passthrough stub is written at soldrPath instead.
  enabled: boolean;

  // Roots
  workspace: string;
  cacheRoot: string;
  soldrRoot: string;
  binDir: string;
  cargoHome: string;
  rustupHome: string;
  soldrPath: string;
  soldrBinCachePath: string;

  // Toolchain
  toolchain: ToolchainSpec;
  rustupStrategy: "managed" | "system" | "explicit";

  // Soldr
  soldrRepo: string;
  soldrRef: string;
  soldrSourcePath: string;
  soldrSourceIdentity: string;
  soldrVersionRequested: string;
  soldrVersionResolved: string;

  // Cache plans
  setupCache: SetupCachePlan;
  buildCache: BuildCachePlan;
  targetCache: TargetCachePlan;
  cargoRegistryCache: CargoRegistryCachePlan;
  dylintCache: DylintCachePlan;
  blessedPrepareCache: import("./blessed-cross-prepare.js").BlessedPrepareCachePlan;
  targetContract?: import("./target-lifecycle.js").TargetLifecycleContract;

  // Compression
  targetCacheCompress: CompressCodec;
  targetCacheCompressLevel: string;

  // Env exports (written to $GITHUB_ENV by the orchestrator)
  envExports: Record<string, string>;

  // PATH additions (written to $GITHUB_PATH by the orchestrator)
  pathAdditions: string[];

  // Timing
  logStartEpoch: string;
  timestamps: string;
  timestampFormat: "mmss" | "seconds";

  // Shims
  shimsEnabled: boolean;
  shimsDir: string;

  // Compile-cache observability
  compileCacheStats: CompileCacheStatsMode;

  // Stats and debug
  stats: StatsMode;
  debugMode: boolean;

  // Daemon idle-timeout override in seconds, or null when unset.
  // When set, exported as ZCCACHE_IDLE_TIMEOUT / SCCACHE_IDLE_TIMEOUT
  // so the cache daemon self-exits after the given idle window.
  cacheShutdownOnIdleSeconds: number | null;

  // Resolved `cache-preset` umbrella value ("minimal" | "foundation" |
  // "full"), or "" when no preset was set. Surfaced via the
  // `cache-preset-effective` output. (#251)
  cachePresetEffective: "" | "minimal" | "foundation" | "full";
}

/**
 * Cache restore result. Returned by @actions/cache restore wrappers.
 */
export interface CacheRestoreResult {
  cacheHit: boolean;
  matchedKey: string;
}

/**
 * Phase timing record. Persisted via env var SETUP_SOLDR_PHASE_{NAME}_START_MS.
 */
export interface PhaseMark {
  phase: string;
  startMs: number;
}

/**
 * Phase timing finish result.
 */
export interface PhaseDuration {
  phase: string;
  seconds: number;
}

/**
 * Logger interface. Helpers receive an instance so they can be tested without
 * touching @actions/core directly.
 */
export interface Logger {
  info(msg: string): void;
  notice(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  log(msg: string): void; // setup-soldr's timestamped "log" — equivalent to Python's log()
}

/**
 * Action-runtime context. Injected into every helper for testability.
 * In production, fields default to wrappers around @actions/* modules and process.env.
 */
export interface ActionContext {
  env: Record<string, string | undefined>;
  workspace: string;
  runnerTemp: string;
  /** Verified bootstrap binary for compiler probes before final installation. */
  bootstrapSoldr?: string;
  getBootstrapSoldr?: () => Promise<string>;
  runnerOs: string;
  runnerArch: string;
  githubSha: string;
  githubToken: string;
  parentSha: string;
  logger: Logger;
}
