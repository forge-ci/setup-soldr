// Pure mapping from process.env → RawInputs. Split out of
// resolve-setup.ts so the orchestrator stays focused on cache-key
// derivation and side-effecting work. Each entry corresponds to one
// row in action.yml's `inputs:` block.

import type { RawInputs } from "./types.js";

export function readRawInputs(env: Record<string, string | undefined>): RawInputs {
  // The runner sets `INPUT_<NAME>` where <NAME> is the input name with spaces
  // replaced by `_` and uppercased — **dashes are NOT converted**. So
  // `cache-key-suffix` lands as `INPUT_CACHE-KEY-SUFFIX`. This matches
  // @actions/core.getInput()'s lookup convention. We also accept the
  // underscored form (`INPUT_CACHE_KEY_SUFFIX`) as a fallback so older tests
  // and any callers that pre-set the underscored env keep working.
  const get = (kebab: string): string => {
    const upper = kebab.replace(/ /g, "_").toUpperCase();
    return env[`INPUT_${upper}`] ?? env[`INPUT_${upper.replace(/-/g, "_")}`] ?? "";
  };
  return {
    enable: get("enable"),
    version: get("version"),
    repo: get("repo"),
    ref: get("ref"),
    sourcePath: get("source-path"),
    cache: get("cache"),
    cacheDir: get("cache-dir"),
    cacheKeySuffix: get("cache-key-suffix"),
    key: get("key"),
    autoKey: get("auto-key"),
    autoKeyTrustedWriters: get("auto-key-trusted-writers"),
    cachePreset: get("cache-preset"),
    toolchain: get("toolchain"),
    toolchainFile: get("toolchain-file"),
    trustMode: get("trust-mode"),
    linker: get("linker"),
    compilePriority: get("compile-priority"),
    timestamps: get("timestamps"),
    timestampFormat: get("timestamp-format"),
    lockfile: get("lockfile"),
    buildCache: get("build-cache"),
    buildCacheMode: get("build-cache-mode"),
    zccacheSeedStrict: get("zccache-seed-strict"),
    targetCache: get("target-cache"),
    targetCacheMode: get("target-cache-mode"),
    targetDir: get("target-dir"),
    targetCacheProfile: get("target-cache-profile"),
    targetCacheStripDebuginfo: get("target-cache-strip-debuginfo"),
    targetCacheIncludeIncremental: get("target-cache-include-incremental"),
    targetCacheIncludeBuildScriptBinaries: get("target-cache-include-build-script-binaries"),
    targetCacheCompress: get("target-cache-compress"),
    targetCacheCompressLevel: get("target-cache-compress-level"),
    cachePayloadWarnBytes: get("cache-payload-warn-bytes"),
    cachePayloadMaxBytes: get("cache-payload-max-bytes"),
    cachePayloadOversizeAction: get("cache-payload-oversize-action"),
    cachePayloadTopN: get("cache-payload-top-n"),
    cacheEncryptKey: get("cache-encrypt-key"),
    cacheEncryptOnFailure: get("cache-encrypt-on-failure"),
    sourceMtimeNormalize: get("source-mtime-normalize"),
    cargoRegistryCache: get("cargo-registry-cache"),
    compileCacheStats: get("compile-cache-stats"),
    shims: get("shims"),
    stats: get("stats"),
    debugMode: get("debug"),
    cacheShutdownOnIdle: get("cache-shutdown-on-idle"),
    rustBacktrace: get("rust-backtrace"),
    logging: get("logging"),
    preserveSourceMtimes: get("preserve-source-mtimes"),
    soloToolchainCache: get("solo-toolchain-cache"),
    soloToolchainCacheLevel: get("solo-toolchain-cache-level"),
    cacheEvictionPolicy: get("cache-eviction-policy"),
    prebuildDeps: get("prebuild-deps"),
    prebuildDepsFlags: get("prebuild-deps-flags"),
    prebuildDepsDeltaCache: get("prebuild-deps-delta-cache"),
    cookDelta: get("cook-delta"),
    soldrMiniCache: get("soldr-mini-cache"),
    verdicts: get("verdicts"),
    ciTests: get("ci-tests"),
    dylint: get("dylint"),
    dylintFoundationCache: get("dylint-foundation-cache"),
    dylintOutputCache: get("dylint-output-cache"),
    dylintCache: get("dylint-cache"),
    dylintToolchain: get("dylint-toolchain"),
    dylintDriverRev: get("dylint-driver-rev"),
    cargoDylintVersion: get("cargo-dylint-version"),
    dylintLinkVersion: get("dylint-link-version"),
    dylintCachePaths: get("dylint-cache-paths"),
    dylintTargets: get("dylint-targets"),
    journalPrintRaw: get("journal-print-raw"),
    crossTargets: get("cross-targets"),
    verifyCompileCache: get("verify-compile-cache"),
    seedIsolatedBuildCache: get("seed-isolated-build-cache"),
    buildCacheSaveMinCompiles: get("build-cache-save-min-compiles"),
    targetCacheSaveMinCompiles: get("target-cache-save-min-compiles"),
    jobStatus: get("job-status"),
    saveOnFailure: get("save-on-failure"),
  };
}
