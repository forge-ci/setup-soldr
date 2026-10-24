// Tests for src/lib/diagnostics.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { captureProcessSnapshot, dumpDiagnostics, loggingEnabled } from "../src/lib/diagnostics.js";
import type { Logger, RawInputs } from "../src/lib/types.js";

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const noop = (): void => undefined;
  const logger: Logger = {
    info: (msg) => lines.push(msg),
    notice: noop,
    warning: noop,
    error: noop,
    debug: noop,
    log: (msg) => lines.push(msg),
  };
  return { logger, lines };
}

function fixtureRawInputs(): RawInputs {
  return {
    enable: "true",
    version: "0.7.35",
    repo: "zackees/soldr",
    ref: "",
    sourcePath: "",
    cache: "true",
    cacheDir: "",
    cacheKeySuffix: "zccache-demo",
    cachePreset: "",
    toolchain: "",
    toolchainFile: "rust-toolchain.toml",
    trustMode: "",
    linker: "",
    compilePriority: "high",
    timestamps: "true",
    timestampFormat: "",
    lockfile: "Cargo.lock",
    buildCache: "true",
    buildCacheMode: "",
    zccacheSeedStrict: "",
    targetCache: "true",
    targetCacheMode: "",
    targetDir: "target",
    targetCacheProfile: "thin-v1",
    targetCacheStripDebuginfo: "",
    targetCacheIncludeIncremental: "",
    targetCacheIncludeBuildScriptBinaries: "",
    targetCacheCompress: "auto",
    targetCacheCompressLevel: "",
    cachePayloadWarnBytes: "1GiB",
    cachePayloadMaxBytes: "",
    cachePayloadOversizeAction: "skip",
    cachePayloadTopN: "10",
    cacheEncryptKey: "",
    cacheEncryptOnFailure: "",
    sourceMtimeNormalize: "",
    cargoRegistryCache: "true",
    compileCacheStats: "summarize",
    shims: "false",
    stats: "summarize",
    debugMode: "false",
    cacheShutdownOnIdle: "",
    rustBacktrace: "1",
    logging: "true",
    preserveSourceMtimes: "false",
    soloToolchainCache: "",
    soloToolchainCacheLevel: "",
    cacheEvictionPolicy: "",
    prebuildDeps: "soldr-cook",
    prebuildDepsFlags: "--release",
    prebuildDepsDeltaCache: "true",
    cookDelta: "false",
    soldrMiniCache: "true",
    verdicts: "",
    ciTests: "",
    dylint: "",
    dylintFoundationCache: "",
    dylintOutputCache: "",
    dylintCache: "",
    dylintToolchain: "",
    dylintDriverRev: "",
    cargoDylintVersion: "",
    dylintLinkVersion: "",
    dylintCachePaths: "",
    dylintTargets: "",
    journalPrintRaw: "",
    crossTargets: "",
    verifyCompileCache: "off",
    seedIsolatedBuildCache: "",
    buildCacheSaveMinCompiles: "1",
    targetCacheSaveMinCompiles: "1",
    jobStatus: "",
    saveOnFailure: "",
  };
}

test("loggingEnabled accepts truthy aliases", () => {
  assert.equal(loggingEnabled("true"), true);
  assert.equal(loggingEnabled("TRUE"), true);
  assert.equal(loggingEnabled("1"), true);
  assert.equal(loggingEnabled("yes"), true);
  assert.equal(loggingEnabled("on"), true);
  assert.equal(loggingEnabled(" true "), true);
});

test("loggingEnabled rejects falsy and unset", () => {
  assert.equal(loggingEnabled(""), false);
  assert.equal(loggingEnabled(undefined), false);
  assert.equal(loggingEnabled("false"), false);
  assert.equal(loggingEnabled("0"), false);
  assert.equal(loggingEnabled("no"), false);
  assert.equal(loggingEnabled("off"), false);
  assert.equal(loggingEnabled("random"), false);
});

test("dumpDiagnostics emits header, footer, and INPUT_ env vars", () => {
  const { logger, lines } = captureLogger();
  dumpDiagnostics({
    phase: "main",
    env: {
      "INPUT_CACHE-KEY-SUFFIX": "zccache-demo",
      INPUT_DEBUG: "true",
      UNRELATED_VAR: "should-not-appear",
    },
    rawInputs: fixtureRawInputs(),
    logger,
  });
  const body = lines.join("\n");
  assert.match(body, /=== DIAGNOSTIC DUMP \(phase=main\) ===/);
  assert.match(body, /=== END DIAGNOSTIC DUMP ===/);
  assert.match(body, /INPUT_CACHE-KEY-SUFFIX=zccache-demo/);
  assert.match(body, /INPUT_DEBUG=true/);
  assert.doesNotMatch(body, /UNRELATED_VAR/);
});

test("dumpDiagnostics includes parsed RawInputs", () => {
  const { logger, lines } = captureLogger();
  dumpDiagnostics({
    phase: "main",
    env: {},
    rawInputs: fixtureRawInputs(),
    logger,
  });
  const body = lines.join("\n");
  assert.match(body, /\[raw_inputs/);
  assert.match(body, /cacheKeySuffix="zccache-demo"/);
  assert.match(body, /version="0\.7\.35"/);
});

test("dumpDiagnostics redacts token-shaped env values", () => {
  const { logger, lines } = captureLogger();
  dumpDiagnostics({
    phase: "main",
    env: {
      GITHUB_TOKEN: "ghs_abc123",
      INPUT_TOKEN: "secretvalue",
      INPUT_CACHE_KEY_SUFFIX: "demo", // looks like _KEY but is allowlisted
      SOLDR_TEST_PASSWORD: "shouldhide",
    },
    logger,
  });
  const body = lines.join("\n");
  assert.match(body, /GITHUB_TOKEN=<redacted>/);
  assert.match(body, /INPUT_TOKEN=<redacted>/);
  assert.match(body, /SOLDR_TEST_PASSWORD=<redacted>/);
  // cache-key-suffix should NOT be redacted
  assert.match(body, /INPUT_CACHE_KEY_SUFFIX=demo/);
  // None of the redacted secrets should appear in plaintext.
  assert.doesNotMatch(body, /ghs_abc123/);
  assert.doesNotMatch(body, /secretvalue/);
  assert.doesNotMatch(body, /shouldhide/);
});

test("dumpDiagnostics works without optional fields", () => {
  const { logger, lines } = captureLogger();
  dumpDiagnostics({
    phase: "post",
    env: { INPUT_DEBUG: "true" },
    logger,
  });
  const body = lines.join("\n");
  assert.match(body, /=== DIAGNOSTIC DUMP \(phase=post\) ===/);
  assert.match(body, /INPUT_DEBUG=true/);
  // No raw_inputs section when rawInputs unset
  assert.doesNotMatch(body, /\[raw_inputs/);
});

test("dumpDiagnostics includes cache_outcomes when provided", () => {
  const { logger, lines } = captureLogger();
  dumpDiagnostics({
    phase: "post",
    env: {},
    logger,
    cacheOutcomes: [
      {
        label: "build-cache",
        operation: "save",
        hit: false,
        key: "setup-soldr-buildcache-v2-x-y-z",
        matchedKey: "",
        restoreKeys: [],
        archiveBytes: 12345,
        inflatedBytes: 67890,
        fileCount: 42,
        durationMs: 1500,
        timestamp: "2026-05-20T00:00:00.000Z",
      },
    ],
  });
  const body = lines.join("\n");
  assert.match(body, /\[cache_outcomes/);
  assert.match(body, /\[save\] build-cache/);
  assert.match(body, /archive_bytes=12345/);
});

test("dumpDiagnostics includes the [processes] section when processSnapshot is set", () => {
  const { logger, lines } = captureLogger();
  dumpDiagnostics({
    phase: "post",
    env: {},
    logger,
    processSnapshot: {
      cmd: "ps -eo pid,ppid,user,stat,comm,args",
      stdout: "  PID  PPID USER     STAT COMMAND COMMAND\n 1234     1 runner   S    bash    /bin/bash\n 5678     1 runner   S    zccache zccache-daemon.42\n",
      stderr: "",
      exitCode: 0,
    },
  });
  const body = lines.join("\n");
  assert.match(body, /\[processes: snapshot via `ps/);
  assert.match(body, /zccache-daemon\.42/);
});

test("captureProcessSnapshot returns a snapshot or null on this platform", () => {
  const snap = captureProcessSnapshot();
  // Either we got a real snapshot (the common case on any normal dev machine
  // or CI runner), or we got null because ps/tasklist failed to launch.
  // Both are valid; the contract is "never throw."
  if (snap === null) return;
  assert.ok(typeof snap.cmd === "string" && snap.cmd.length > 0, "cmd field populated");
  assert.ok(typeof snap.stdout === "string", "stdout field populated");
  assert.ok(typeof snap.stderr === "string", "stderr field populated");
});
