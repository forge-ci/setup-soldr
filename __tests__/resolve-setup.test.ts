import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildOutputs,
  detectCiTestsTargetTreeRefusal,
  detectMuslCcEnv,
  detectUserLinkerEnv,
  detectZccachePrivateOverlap,
  detectZccacheTestBinOptIn,
  readRawInputs,
  resolveLocalSourceIdentity,
  resolveManifestWorkspace,
  resolveSetup,
} from "../src/lib/resolve-setup.js";
import { createLogger } from "../src/lib/log-utils.js";
import { supportsLayeredCookCache } from "../src/lib/cook-cache.js";
import type { ActionContext, RawInputs, ResolveResult } from "../src/lib/types.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitSource(sourcePath: string): void {
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(
    path.join(sourcePath, "Cargo.toml"),
    "[workspace]\n[workspace.package]\nversion = \"0.9.2\"\n",
    "utf8",
  );
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", sourcePath, ...args], { stdio: "ignore", windowsHide: true });
  };
  git("init");
  git("config", "user.name", "setup-soldr tests");
  git("config", "user.email", "setup-soldr-tests@example.invalid");
  git("add", "Cargo.toml");
  git("commit", "-m", "seed local source");
}

function makeWorkspace(opts: {
  withLockfile?: boolean;
  lockfileContents?: string;
  files?: Record<string, string>;
} = {}): { root: string; workspace: string; runnerTemp: string } {
  const root = mkTmp("setup-soldr-tests-");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });
  if (opts.withLockfile !== false) {
    fs.writeFileSync(
      path.join(workspace, "Cargo.lock"),
      opts.lockfileContents ?? "# test lockfile\n",
      "utf8",
    );
  }
  for (const [relative, contents] of Object.entries(opts.files ?? {})) {
    const filePath = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
  }
  return { root, workspace, runnerTemp };
}

function makeContext(root: string, workspace: string, runnerTemp: string): ActionContext {
  const env: Record<string, string | undefined> = {
    ACTION_WORKSPACE: workspace,
    ACTION_OS: "Linux",
    ACTION_ARCH: "X64",
    RUNNER_TEMP: runnerTemp,
    GITHUB_SHA: "0123456789abcdef",
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    CARGO_HOME: path.join(root, "cargo-home"),
    RUSTUP_HOME: path.join(root, "rustup-home"),
    INPUT_VERSION: "0.7.11",
    INPUT_TIMESTAMPS: "false",
    INPUT_TOOLCHAIN_FILE: "",
  };
  return {
    env,
    workspace,
    runnerTemp,
    runnerOs: "Linux",
    runnerArch: "X64",
    githubSha: "0123456789abcdef",
    githubToken: "",
    parentSha: "",
    logger: createLogger(env),
  };
}

function withInputs(env: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string | undefined> {
  return { ...env, ...extra };
}

async function run(
  rootOpts: Parameters<typeof makeWorkspace>[0] = {},
  extraEnv: Record<string, string> = {},
  override?: () => Promise<boolean>,
  resolveNightly?: (requested: string) => Promise<{
    channel: string;
    rustVersion: string;
    rustcRelease: string;
    rustcCommitHash: string;
  }>,
): Promise<{ result: ResolveResult; outputs: Record<string, string>; inputs: RawInputs }> {
  const { root, workspace, runnerTemp } = makeWorkspace(rootOpts);
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env = withInputs(ctx.env, extraEnv);
  const inputs: RawInputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: override ?? (async () => false),
    ...(resolveNightly ? { resolveDylintNightly: resolveNightly } : {}),
  });
  return { result, outputs: buildOutputs(result), inputs };
}

// --- pruning inputs ---

test("defaults do not export pruning env vars", async () => {
  const { result } = await run();
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], undefined);
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"], undefined);
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"], undefined);
});

test("empty pruning inputs do not export env vars", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "",
    INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL: "",
    INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES: "",
  });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], undefined);
});

test("pruning inputs true normalize to literal 'true'", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "true",
    INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL: "yes",
    INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES: "1",
  });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], "true");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"], "true");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"], "true");
});

test("pruning inputs false normalize to literal 'false'", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "false",
    INPUT_TARGET_CACHE_INCLUDE_INCREMENTAL: "0",
    INPUT_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES: "off",
  });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_STRIP_DEBUGINFO"], "false");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL"], "false");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES"], "false");
});

test("invalid pruning value rejects with clear error", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "maybe" }),
    /invalid target-cache-strip-debuginfo/,
  );
});

// --- compression ---

test("default compression codec is zstd", async () => {
  const { result, outputs } = await run();
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_COMPRESS"], "zstd");
  assert.equal(outputs["target_cache_compress"], "zstd");
});

test("default compression level is 3", async () => {
  const { result, outputs } = await run();
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_COMPRESS_LEVEL"], "3");
  assert.equal(outputs["target_cache_compress_level"], "3");
});

test("local runner (ACT=true) defaults the compression level to 1", async () => {
  const { result, outputs } = await run({}, { ACT: "true" });
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_COMPRESS_LEVEL"], "1");
  assert.equal(outputs["target_cache_compress_level"], "1");
});

test("explicit compression level wins under ACT=true and on GitHub", async () => {
  for (const extra of [{}, { ACT: "true" }] as Array<Record<string, string>>) {
    const { result } = await run({}, { ...extra, INPUT_TARGET_CACHE_COMPRESS_LEVEL: "7" });
    assert.equal(result.envExports["SOLDR_TARGET_CACHE_COMPRESS_LEVEL"], "7");
  }
});

test("explicit codec propagates", async () => {
  for (const codec of ["auto", "zstd", "none"]) {
    const { outputs } = await run({}, { INPUT_TARGET_CACHE_COMPRESS: codec });
    assert.equal(outputs["target_cache_compress"], codec);
  }
});

test("invalid codec rejected", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_COMPRESS: "lz4" }),
    /invalid target-cache-compress/,
  );
});

test("invalid compress level rejected", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_COMPRESS_LEVEL: "fast" }),
    /invalid target-cache-compress-level/,
  );
});

test("dylint cache is opt-in and exports driver path plus exact-key material", async () => {
  // Deliberately synthetic overrides: this covers cache-key compatibility,
  // not active Dylint pins or a real dylint-driver revision.
  const fixtureDriverRev = "0123456789abcdef0123456789abcdef01234567";
  const { result, outputs } = await run({}, {
    "INPUT_DYLINT-CACHE": "true",
    "INPUT_DYLINT-TOOLCHAIN": "nightly-2026-03-26",
    "INPUT_DYLINT-DRIVER-REV": fixtureDriverRev,
    "INPUT_CARGO-DYLINT-VERSION": "99.98.97",
    "INPUT_DYLINT-LINK-VERSION": "97.98.99",
  });

  assert.equal(result.dylintCache.enabled, true);
  assert.equal(result.dylintCache.hostTriple, "x86_64-unknown-linux-gnu");
  assert.equal(result.dylintCache.toolchain, "nightly-2026-03-26");
  assert.equal(result.dylintCache.driverRev, fixtureDriverRev);
  assert.match(result.dylintCache.key, /^setup-soldr-dylint-v1-linux-x64-x86_64-unknown-linux-gnu-/);
  assert.ok(result.dylintCache.paths.some((p) => p.includes("cargo-dylint*")));
  assert.ok(result.dylintCache.paths.some((p) => p.includes("dylint-drivers")));
  assert.equal(result.envExports["DYLINT_DRIVER_PATH"], result.dylintCache.driverPath);
  assert.equal(outputs["dylint-cache-key"], result.dylintCache.key);
  assert.equal(outputs["dylint-driver-path"], result.dylintCache.driverPath);
});

test("dylint cache key changes when driver revision changes", async () => {
  const first = await run({}, {
    "INPUT_DYLINT-CACHE": "true",
    "INPUT_DYLINT-TOOLCHAIN": "nightly-2026-03-26",
    "INPUT_DYLINT-DRIVER-REV": "rev-a",
  });
  const second = await run({}, {
    "INPUT_DYLINT-CACHE": "true",
    "INPUT_DYLINT-TOOLCHAIN": "nightly-2026-03-26",
    "INPUT_DYLINT-DRIVER-REV": "rev-b",
  });
  assert.notEqual(first.result.dylintCache.key, second.result.dylintCache.key);
});

test("dylint mode is false by default and performs no nightly lookup", async () => {
  let called = false;
  const { result } = await run({}, {}, undefined, async () => {
    called = true;
    throw new Error("must not resolve");
  });
  assert.equal(called, false);
  assert.equal(result.dylintCache.outputCacheEnabled, false);
  assert.equal(result.envExports["SOLDR_DYLINT_TOOLCHAIN"], undefined);
  assert.equal(result.envExports["SOLDR_DYLINT_CONFIGURED_TOOLCHAIN"], undefined);
});

test("ci-tests bounds test threads only, not compiler admission", async () => {
  const { result, inputs } = await run(
    {},
    { "INPUT_CI-TESTS": "true", INPUT_TOOLCHAIN: "1.94.1" },
    undefined,
    async () => ({
      channel: "nightly-2026-01-18",
      rustVersion: "1.94",
      rustcRelease: "1.94.0-nightly",
      rustcCommitHash: "1111111111111111111111111111111111111111",
    }),
  );
  assert.equal(result.dylintCache.enabled, false);
  assert.equal(inputs.prebuildDeps, "");
  // soldr#3138: no default compile-concurrency cap. These two size the shared
  // ceiling that both Cargo's producer queue and the embedded zccache
  // admission gate draw from, so exporting "1" serialized every compiler
  // child in the job. The amalgamation units that motivated the cap now get
  // *exclusive* admission from the service instead (zccache >= 1.13.11), which
  // protects the one huge unit without serializing the small ones. Left unset,
  // soldr resolves its own topology-aware default.
  assert.ok(
    !("CARGO_BUILD_JOBS" in result.envExports),
    "ci-tests must not export a default CARGO_BUILD_JOBS",
  );
  assert.ok(
    !("SOLDR_JOBS" in result.envExports),
    "ci-tests must not export a default SOLDR_JOBS",
  );
  // Test-process concurrency is a different resource from compiler admission,
  // and this half of soldr's ci-test contract is deliberate: "only
  // NEXTEST_TEST_THREADS defaults to one".
  assert.equal(result.envExports["NEXTEST_TEST_THREADS"], "1");
  assert.equal(result.envExports["SETUP_SOLDR_CI_TESTS"], "true");
});

test("ci-tests preserves explicit workflow concurrency limits", async () => {
  const { result } = await run(
    {},
    {
      "INPUT_CI-TESTS": "true",
      CARGO_BUILD_JOBS: "4",
      SOLDR_JOBS: "3",
      NEXTEST_TEST_THREADS: "2",
    },
    undefined,
    async () => ({
      channel: "nightly-2026-01-18",
      rustVersion: "1.94",
      rustcRelease: "1.94.0-nightly",
      rustcCommitHash: "1111111111111111111111111111111111111111",
    }),
  );
  assert.equal(result.envExports["CARGO_BUILD_JOBS"], "4");
  assert.equal(result.envExports["SOLDR_JOBS"], "3");
  assert.equal(result.envExports["NEXTEST_TEST_THREADS"], "2");
});

// ============================================================================
// soldr#2931 / setup-soldr#496 — ci-tests cache-ownership contract.
// A ci-test lane's entire product is linked test binaries, so it may not
// persist a bulk target/ snapshot. build-cache-mode=full + target caching is
// the only configuration that takes one, so ci-tests degrades it to thin.
// ============================================================================

interface CachePolicySignal {
  schema: number;
  layers: string[];
  target_tree_snapshot: boolean;
  test_products: string;
  ci_tests: boolean;
  ci_tests_target_tree_refused: boolean;
}

function cachePolicy(result: ResolveResult): CachePolicySignal {
  const raw = result.envExports["SETUP_SOLDR_CACHE_POLICY_JSON"];
  assert.ok(raw, "SETUP_SOLDR_CACHE_POLICY_JSON must always be exported");
  return JSON.parse(raw!) as CachePolicySignal;
}

test("ci-tests refuses a bulk target/ snapshot and degrades full to thin (soldr#2931)", async () => {
  const { result } = await run({}, {
    "INPUT_CI-TESTS": "true",
    INPUT_TARGET_CACHE: "true",
    INPUT_BUILD_CACHE_MODE: "full",
  });
  assert.equal(result.buildCache.mode, "thin", "ci-tests degrades full to thin");
  assert.equal(result.envExports["SETUP_SOLDR_BUILD_CACHE_MODE"], "thin");
  assert.equal(result.envExports["SOLDR_BUILD_CACHE_MODE"], "thin");
  assert.equal(result.targetCache.enabled, true, "the bounded bundle still carries the lane");
  assert.equal(result.targetCache.effectiveMode, "thin");
  assert.equal(
    result.targetCache.paths,
    result.targetCache.bundlePath,
    "only the bounded bundle is persisted — never the whole target/ tree",
  );
  assert.ok(
    !result.targetCache.paths.includes(result.targetCache.targetPath),
    "target/ must not appear in the saved paths on a ci-tests lane",
  );
  const policy = cachePolicy(result);
  assert.equal(policy.ci_tests, true);
  assert.equal(policy.ci_tests_target_tree_refused, true);
  assert.equal(policy.target_tree_snapshot, false);
  assert.ok(policy.layers.includes("target-bundle"));
  assert.ok(!policy.layers.includes("target-tree"));
});

test("ci-tests with default cache settings is unchanged (soldr#2931)", async () => {
  const { result } = await run({}, { "INPUT_CI-TESTS": "true" });
  // Nothing to refuse: target caching is default-off, so no bulk snapshot was
  // ever on the table and the historical resolution is untouched.
  assert.equal(result.targetCache.enabled, false);
  assert.equal(result.buildCache.enabled, true);
  assert.equal(result.envExports["SETUP_SOLDR_CI_TESTS"], "true");
  const policy = cachePolicy(result);
  assert.equal(policy.ci_tests, true);
  assert.equal(policy.ci_tests_target_tree_refused, false);
  assert.equal(policy.target_tree_snapshot, false);
  assert.deepEqual(policy.layers, ["toolchain", "zccache-unit"]);
});

test("non-ci-tests lanes keep build-cache-mode=full and the target tree (soldr#2931)", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE: "true",
    INPUT_BUILD_CACHE_MODE: "full",
  });
  assert.equal(result.buildCache.mode, "full", "the refusal must not leak onto ordinary lanes");
  assert.equal(result.targetCache.effectiveMode, "full");
  assert.ok(
    result.targetCache.paths.includes(result.targetCache.targetPath),
    "full mode on a non-ci-tests lane still snapshots the whole target/ tree",
  );
  const policy = cachePolicy(result);
  assert.equal(policy.ci_tests, false);
  assert.equal(policy.ci_tests_target_tree_refused, false);
  assert.equal(policy.target_tree_snapshot, true);
  assert.ok(policy.layers.includes("target-tree"));
});

test("cache policy is exported on every lane and never permits test products (soldr#2931)", async () => {
  const { result } = await run({});
  const policy = cachePolicy(result);
  assert.equal(policy.schema, 1);
  assert.equal(policy.test_products, "never");
  assert.equal(policy.ci_tests, false);
  assert.deepEqual(policy.layers, ["toolchain", "zccache-unit"]);
});

test("cache policy lists cook and cargo-registry in stability order (soldr#2931)", async () => {
  const { result } = await run({}, { INPUT_PREBUILD_DEPS: "soldr-cook" });
  const policy = cachePolicy(result);
  assert.deepEqual(policy.layers, ["toolchain", "cargo-registry", "cook", "zccache-unit"]);
});

test("setup-soldr never sets ZCCACHE_CACHE_TEST_BINS itself (soldr#2931)", async () => {
  const { result } = await run({}, { "INPUT_CI-TESTS": "true" });
  assert.equal(
    result.envExports["ZCCACHE_CACHE_TEST_BINS"],
    undefined,
    "zccache's default test-binary exclusion must stand — not even a '0' override",
  );
});

test("detectZccacheTestBinOptIn flags only a truthy job-level opt-in (soldr#2931)", () => {
  assert.equal(detectZccacheTestBinOptIn({}), null);
  assert.equal(detectZccacheTestBinOptIn({ ZCCACHE_CACHE_TEST_BINS: "0" }), null);
  assert.equal(detectZccacheTestBinOptIn({ ZCCACHE_CACHE_TEST_BINS: "off" }), null);
  const warning = detectZccacheTestBinOptIn({ ZCCACHE_CACHE_TEST_BINS: "1" });
  assert.ok(warning, "a truthy opt-in must produce a warning");
  assert.match(warning!, /ZCCACHE_CACHE_TEST_BINS/);
  assert.match(warning!, /soldr\/issues\/2931/);
});

test("detectCiTestsTargetTreeRefusal fires only on the bulk-snapshot combination", () => {
  const base = {
    ciTestsEnabled: true,
    buildCacheEnabled: true,
    targetCacheRequested: true,
    buildCacheMode: "full",
  };
  const warning = detectCiTestsTargetTreeRefusal(base);
  assert.ok(warning, "the bulk-snapshot combination must produce a warning");
  assert.match(warning!, /refusing build-cache-mode=full on a ci-tests lane/);
  assert.match(warning!, /soldr\/issues\/2931/);
  assert.match(warning!, /setup-soldr\/issues\/496/);
  assert.equal(detectCiTestsTargetTreeRefusal({ ...base, ciTestsEnabled: false }), null);
  assert.equal(detectCiTestsTargetTreeRefusal({ ...base, buildCacheMode: "thin" }), null);
  assert.equal(detectCiTestsTargetTreeRefusal({ ...base, buildCacheMode: "once" }), null);
  assert.equal(detectCiTestsTargetTreeRefusal({ ...base, buildCacheEnabled: false }), null);
  assert.equal(detectCiTestsTargetTreeRefusal({ ...base, targetCacheRequested: false }), null);
});

test("dylint mode resolves newest nightly identity and keys the foundation cache", async () => {
  let requested = "";
  const { result, outputs, inputs } = await run(
    {},
    { INPUT_DYLINT: "true", INPUT_TOOLCHAIN: "1.94.1" },
    undefined,
    async (value) => {
      requested = value;
      return {
        channel: "nightly-2026-01-18",
        rustVersion: "1.94",
        rustcRelease: "1.94.0-nightly",
        rustcCommitHash: "1111111111111111111111111111111111111111",
      };
    },
  );
  assert.equal(requested, "1.94.1");
  assert.equal(result.dylintCache.enabled, true);
  assert.equal(result.dylintCache.outputCacheEnabled, true);
  assert.match(result.dylintCache.outputKey, /^setup-soldr-dylint-output-v2-/);
  assert.equal(result.dylintCache.outputPaths.length, 2);
  // setup-soldr#538: cargo-dylint checks against (and writes its
  // check-shaped target state under) the HOST-QUALIFIED toolchain
  // directory name, not the short requested channel -- confirmed on
  // zackees/template-python-rust-cmd run 36497556959. outputPaths must
  // name the qualified directory or dylint-output-cache never finds
  // anything to save.
  assert.ok(
    result.dylintCache.outputPaths.every((p) =>
      p.includes(`nightly-2026-01-18-${result.dylintCache.hostTriple}`),
    ),
    `outputPaths must be host-qualified: ${JSON.stringify(result.dylintCache.outputPaths)}`,
  );
  assert.ok(
    result.dylintCache.outputPaths.every((p) => !p.includes(path.sep + "nightly-2026-01-18" + path.sep)),
    "outputPaths must not use the bare (unqualified) channel as a path segment",
  );
  assert.equal(result.dylintCache.toolchain, "nightly-2026-01-18");
  assert.equal(result.dylintCache.rustcRelease, "1.94.0-nightly");
  assert.equal(result.dylintCache.rustcCommitHash.length, 40);
  assert.equal(result.dylintCache.cargoDylintVersion, "6.2.0");
  assert.equal(result.dylintCache.dylintLinkVersion, "6.2.0");
  assert.equal(result.envExports["SOLDR_TOOLCHAIN_ORIGIN"], undefined);
  assert.match(result.dylintCache.key, /^setup-soldr-dylint-v2-/);
  assert.ok(result.dylintCache.paths.some((p) => p.includes("nightly-2026-01-18")));
  assert.equal(
    result.envExports["SOLDR_DYLINT_CONFIGURED_TOOLCHAIN"],
    "nightly-2026-01-18",
  );
  assert.equal(result.envExports["SOLDR_DYLINT_TOOLCHAIN"], undefined);
  assert.equal(
    result.envExports["SOLDR_DYLINT_CONFIGURED_RUSTC_COMMIT_HASH"],
    "1111111111111111111111111111111111111111",
  );
  assert.equal(outputs["dylint-rustc-commit-hash"], result.dylintCache.rustcCommitHash);
  assert.equal(outputs["dylint-output-cache-key"], result.dylintCache.outputKey);
  assert.equal(result.cargoRegistryCache.enabled, true);
  assert.equal(inputs.prebuildDeps, "none");
  assert.equal(
    result.setupCache.paths.some(
      (candidate) =>
        candidate === path.join(result.rustupHome, "toolchains") ||
        candidate === path.join(result.rustupHome, "update-hashes"),
    ),
    false,
  );
});

test("dylint mode keeps preparation pins when caching is disabled", async () => {
  const { result } = await run(
    {},
    { INPUT_DYLINT: "true", INPUT_CACHE: "false", INPUT_TOOLCHAIN: "1.94.1" },
    undefined,
    async () => ({
      channel: "nightly-2026-01-18",
      rustVersion: "1.94",
      rustcRelease: "1.94.0-nightly",
      rustcCommitHash: "1111111111111111111111111111111111111111",
    }),
  );
  assert.equal(result.dylintCache.enabled, false);
  assert.equal(result.dylintCache.outputCacheEnabled, false);
  assert.notEqual(result.dylintCache.cacheIdentity, "");
  assert.equal(result.dylintCache.cargoDylintVersion, "6.2.0");
  assert.equal(result.dylintCache.dylintLinkVersion, "6.2.0");
});

// --- dylint-output-cache reused across commits (setup-soldr#540, ci.yml#1) ---
//
// The output cache used to be keyed on GITHUB_SHA, so every new commit was an
// exact-key miss even when the toolchain, lint libraries, Cargo.lock and
// target/flags shape were all unchanged. These tests pin the corrected
// contract: the exact key is a pure function of (toolchain identity, driver
// revision, cargo config, workspace/lint-library manifests, target shape,
// Cargo.lock) — never the commit — and restore-keys fall back across a
// Cargo.lock change only, never across a toolchain or manifest change.

const DYLINT_OUTPUT_NIGHTLY_A = async (): Promise<{
  channel: string;
  rustVersion: string;
  rustcRelease: string;
  rustcCommitHash: string;
}> => ({
  channel: "nightly-2026-01-18",
  rustVersion: "1.94",
  rustcRelease: "1.94.0-nightly",
  rustcCommitHash: "1111111111111111111111111111111111111111",
});

const DYLINT_OUTPUT_NIGHTLY_B = async (): Promise<{
  channel: string;
  rustVersion: string;
  rustcRelease: string;
  rustcCommitHash: string;
}> => ({
  channel: "nightly-2026-02-01",
  rustVersion: "1.95",
  rustcRelease: "1.95.0-nightly",
  rustcCommitHash: "2222222222222222222222222222222222222222",
});

// Unlike `run()`, these tests hold the workspace (and therefore its
// absolute target-dir path, which feeds `target_shape`) FIXED across both
// resolveSetup() calls, mutating only the one input under test — mirroring
// real CI, where GITHUB_WORKSPACE is the same path on every commit of the
// same job and only file contents (Cargo.lock, manifests) or env
// (GITHUB_SHA, the resolved nightly) change between runs.
async function resolveDylintOutputCache(
  ctxRoot: { root: string; workspace: string; runnerTemp: string },
  extraEnv: Record<string, string>,
  resolveNightly: () => Promise<{
    channel: string;
    rustVersion: string;
    rustcRelease: string;
    rustcCommitHash: string;
  }>,
): Promise<ResolveResult> {
  const ctx = makeContext(ctxRoot.root, ctxRoot.workspace, ctxRoot.runnerTemp);
  ctx.env = withInputs(ctx.env, extraEnv);
  const inputs: RawInputs = readRawInputs(ctx.env);
  return resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
    resolveDylintNightly: resolveNightly,
  });
}

test("dylint-output-cache exact key is stable across commits given the same real inputs", async () => {
  const ctxRoot = makeWorkspace({ lockfileContents: "# lockfile A\n" });
  const extraEnv = { INPUT_DYLINT: "true", INPUT_TOOLCHAIN: "1.94.1" };
  const commitOne = await resolveDylintOutputCache(
    ctxRoot,
    { ...extraEnv, GITHUB_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    DYLINT_OUTPUT_NIGHTLY_A,
  );
  const commitTwo = await resolveDylintOutputCache(
    ctxRoot,
    { ...extraEnv, GITHUB_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    DYLINT_OUTPUT_NIGHTLY_A,
  );
  assert.equal(
    commitOne.dylintCache.outputKey,
    commitTwo.dylintCache.outputKey,
    "ci.yml#1: the dylint-output-cache exact key must not depend on GITHUB_SHA",
  );
});

test("dylint-output-cache key changes on a Cargo.lock change, but its restore-keys prefix does not", async () => {
  const ctxRoot = makeWorkspace({ lockfileContents: "# lockfile A\n" });
  const extraEnv = { INPUT_DYLINT: "true", INPUT_TOOLCHAIN: "1.94.1" };
  const lockA = await resolveDylintOutputCache(ctxRoot, extraEnv, DYLINT_OUTPUT_NIGHTLY_A);
  fs.writeFileSync(
    path.join(ctxRoot.workspace, "Cargo.lock"),
    "# lockfile B (dependency bump)\n",
    "utf8",
  );
  const lockB = await resolveDylintOutputCache(ctxRoot, extraEnv, DYLINT_OUTPUT_NIGHTLY_A);
  assert.notEqual(
    lockA.dylintCache.outputKey,
    lockB.dylintCache.outputKey,
    "a Cargo.lock change must invalidate the exact dylint-output-cache key",
  );
  assert.equal(lockA.dylintCache.outputRestoreKeys.length, 1);
  assert.deepEqual(
    lockA.dylintCache.outputRestoreKeys,
    lockB.dylintCache.outputRestoreKeys,
    "restore-keys must drop ONLY the Cargo.lock component",
  );
  assert.ok(lockA.dylintCache.outputKey.startsWith(lockA.dylintCache.outputRestoreKeys[0]!));
  assert.ok(lockB.dylintCache.outputKey.startsWith(lockB.dylintCache.outputRestoreKeys[0]!));
});

test("dylint-output-cache key and restore-keys change when the dylint toolchain identity changes", async () => {
  const ctxRoot = makeWorkspace({ lockfileContents: "# lockfile A\n" });
  const extraEnv = { INPUT_DYLINT: "true", INPUT_TOOLCHAIN: "1.94.1" };
  const toolchainA = await resolveDylintOutputCache(ctxRoot, extraEnv, DYLINT_OUTPUT_NIGHTLY_A);
  const toolchainB = await resolveDylintOutputCache(ctxRoot, extraEnv, DYLINT_OUTPUT_NIGHTLY_B);
  assert.notEqual(toolchainA.dylintCache.outputKey, toolchainB.dylintCache.outputKey);
  assert.notEqual(
    toolchainA.dylintCache.outputRestoreKeys[0]!,
    toolchainB.dylintCache.outputRestoreKeys[0]!,
    "restore-keys must never cross a toolchain-identity change",
  );
});

test("dylint-output-cache key and restore-keys change when workspace/lint-library manifests change", async () => {
  const ctxRoot = makeWorkspace({
    lockfileContents: "# lockfile A\n",
    files: { "Cargo.toml": "[workspace]\nmembers = [\"a\"]\n" },
  });
  const extraEnv = { INPUT_DYLINT: "true", INPUT_TOOLCHAIN: "1.94.1" };
  const manifestA = await resolveDylintOutputCache(ctxRoot, extraEnv, DYLINT_OUTPUT_NIGHTLY_A);
  fs.writeFileSync(
    path.join(ctxRoot.workspace, "Cargo.toml"),
    "[workspace]\nmembers = [\"a\", \"dylints/platform_boundary\"]\n",
    "utf8",
  );
  const manifestB = await resolveDylintOutputCache(ctxRoot, extraEnv, DYLINT_OUTPUT_NIGHTLY_A);
  assert.notEqual(manifestA.dylintCache.outputKey, manifestB.dylintCache.outputKey);
  assert.notEqual(
    manifestA.dylintCache.outputRestoreKeys[0]!,
    manifestB.dylintCache.outputRestoreKeys[0]!,
    "restore-keys must never cross a workspace/lint-library manifest change",
  );
});

test("cargo-chef local dir is exported only after its bundled binary is installed", async () => {
  const { result } = await run({}, { INPUT_VERSION: "0.7.43" });
  assert.equal(result.envExports["SOLDR_CARGO_CHEF_LOCAL_DIR"], undefined);
});

test("invalid dylint cache boolean rejects with clear error", async () => {
  await assert.rejects(
    () => run({}, { "INPUT_DYLINT-CACHE": "maybe" }),
    /invalid 'dylint-cache' input/,
  );
});

test("compression inputs do not change cache keys", async () => {
  // Both runs must use the same workspace so target_cache_path (which feeds
  // the target_shape hash) is identical between the baseline and the
  // run-with-extra-inputs.
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const baseCtx = makeContext(root, workspace, runnerTemp);
  const inputsBase = readRawInputs(baseCtx.env);
  const r1 = await resolveSetup(baseCtx, inputsBase, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const ctx2 = makeContext(root, workspace, runnerTemp);
  ctx2.env = withInputs(ctx2.env, {
    INPUT_TARGET_CACHE_COMPRESS: "none",
    INPUT_TARGET_CACHE_COMPRESS_LEVEL: "9",
  });
  const inputs2 = readRawInputs(ctx2.env);
  const r2 = await resolveSetup(ctx2, inputs2, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const a = buildOutputs(r1);
  const b = buildOutputs(r2);
  assert.equal(a["cache_key"], b["cache_key"]);
  assert.equal(a["target_cache_key"], b["target_cache_key"]);
});

// --- profile ---

test("default target-cache-profile is thin-v1", async () => {
  const { outputs } = await run();
  assert.equal(outputs["target_cache_profile"], "thin-v1");
});

test("explicit target-cache-profile passes through", async () => {
  const { outputs } = await run({}, { INPUT_TARGET_CACHE_PROFILE: "thin-v2" });
  assert.equal(outputs["target_cache_profile"], "thin-v2");
});

test("thin-v3 gets its safe ownership fallback cache namespace", async () => {
  const cacheInputs = { INPUT_TARGET_CACHE: "true", INPUT_BUILD_CACHE_MODE: "thin" };
  const v1 = await run({}, { ...cacheInputs, INPUT_TARGET_CACHE_PROFILE: "thin-v1" });
  const v3 = await run({}, { ...cacheInputs, INPUT_TARGET_CACHE_PROFILE: "thin-v3" });
  assert.equal(v3.outputs["target_cache_profile"], "thin-v3");
  assert.notEqual(v3.outputs["target_cache_key"], v1.outputs["target_cache_key"]);
  assert.match(
    v3.outputs["target_cache_key"] ?? "",
    /thin-v3-lifetime-partition-v1-zccache-all-v1/,
  );
});

test("invalid target-cache-profile rejected", async () => {
  await assert.rejects(
    () => run({}, { INPUT_TARGET_CACHE_PROFILE: "fat" }),
    /invalid target-cache-profile/,
  );
});

// --- build cache mode ---

test("default build cache mode resolves to 'once', soldr-mode 'full'", async () => {
  const { result, outputs } = await run();
  assert.equal(outputs["build_cache_mode"], "once");
  assert.equal(result.envExports["SETUP_SOLDR_BUILD_CACHE_MODE"], "once");
  assert.equal(result.envExports["SOLDR_BUILD_CACHE_MODE"], "full");
});

test("thin build cache mode requires Cargo.lock", async () => {
  const { result, outputs } = await run(
    { withLockfile: false },
    { INPUT_BUILD_CACHE_MODE: "thin" },
  );
  assert.equal(outputs["target_lockfile_hash"], "no-lock");
  assert.equal(outputs["target_cache_enabled"], "false");
  assert.equal(outputs["target_cache_mode"], "off");
  assert.equal(outputs["target_cache_budget_bytes"], "");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
});

test("full build cache mode restores target tree + bundle", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "full", INPUT_TARGET_CACHE: "true" });
  const lines = (outputs["target_cache_paths"] ?? "").split("\n");
  assert.equal(lines.length, 2);
  assert.equal(outputs["target_cache_mode"], "full");
});

test("legacy hot -> thin translation", async () => {
  const { outputs } = await run({}, { INPUT_TARGET_CACHE_MODE: "hot" });
  assert.equal(outputs["build_cache_mode"], "thin");
});

test("legacy off disables target cache", async () => {
  const { result, outputs } = await run({}, { INPUT_TARGET_CACHE_MODE: "off" });
  assert.equal(outputs["build_cache_mode"], "once");
  assert.equal(outputs["target_cache_enabled"], "false");
  assert.equal(outputs["target_cache_mode"], "off");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
});

test("explicit version is normalized for cache keying", async () => {
  const { outputs: a } = await run({}, { INPUT_VERSION: "0.7.11" });
  const { outputs: b } = await run({}, { INPUT_VERSION: "v0.7.11" });
  assert.equal(a["soldr_version_resolved"], "v0.7.11");
  assert.equal(b["soldr_version_resolved"], "v0.7.11");
  assert.equal(a["cache_key"], b["cache_key"]);
});

test("latest release lookup uses token input for GitHub API auth", async () => {
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = (async (_url: unknown, init?: { headers?: unknown }) => {
    const headers = init?.headers as Record<string, string> | undefined;
    authorization = headers?.["Authorization"] ?? "";
    return new Response(JSON.stringify({ tag_name: "v0.7.12" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { root, workspace, runnerTemp } = makeWorkspace({});
    const ctx = makeContext(root, workspace, runnerTemp);
    ctx.env = withInputs(ctx.env, {
      INPUT_VERSION: "latest",
      INPUT_TOKEN: "input-token",
    });
    const inputs = readRawInputs(ctx.env);
    const result = await resolveSetup(ctx, inputs, {
      systemRustupOverride: async () => false,
    });

    assert.equal(result.soldrVersionResolved, "v0.7.12");
    assert.equal(authorization, "Bearer input-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manifest workspace follows the nearest Cargo.toml instead of target layout", () => {
  const root = mkTmp("setup-soldr-manifest-root-");
  const workspace = path.join(root, "workspace");
  const nested = path.join(workspace, "apps", "demo");
  const externalTarget = path.join(root, "external-target");
  try {
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(workspace, "Cargo.toml"), "[workspace]\n", "utf8");
    fs.writeFileSync(path.join(nested, "Cargo.toml"), "[package]\nname='demo'\n", "utf8");
    assert.equal(
      resolveManifestWorkspace(path.join(nested, ".cache", "target"), workspace),
      nested,
    );
    assert.equal(resolveManifestWorkspace(externalTarget, workspace), workspace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source ref changes setup cache key", async () => {
  const { outputs: base } = await run({}, { INPUT_REPO: "zackees/soldr" });
  const { outputs: branch } = await run({}, {
    INPUT_REPO: "zackees/soldr",
    INPUT_REF: "feature-x",
  });
  assert.notEqual(base["cache_key"], branch["cache_key"]);
});

test("local source identity is the exact pinned HEAD", () => {
  const root = mkTmp("setup-soldr-local-source-");
  const sourcePath = path.join(root, "soldr");
  try {
    initGitSource(sourcePath);
    const clean = resolveLocalSourceIdentity(sourcePath);
    assert.match(clean, /^local-[0-9a-f]{40}$/);
    fs.appendFileSync(path.join(sourcePath, "Cargo.toml"), "\n# dirty\n", "utf8");
    assert.equal(
      resolveLocalSourceIdentity(sourcePath),
      clean,
      "uncommitted edits are intentionally outside the pinned identity",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source-path bypasses release lookup and keys caches on the pinned checkout", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const sourcePath = path.join(workspace, "_vender", "soldr");
  try {
    initGitSource(sourcePath);
    const ctx = makeContext(root, workspace, runnerTemp);
    ctx.env = withInputs(ctx.env, {
      INPUT_SOURCE_PATH: "_vender/soldr",
      INPUT_VERSION: "0.9.2",
      INPUT_REF: "ignored-ref",
      INPUT_CACHE_KEY_SUFFIX: "run 42",
      INPUT_PREBUILD_DEPS: "soldr-cook",
      INPUT_CARGO_REGISTRY_CACHE: "true",
    });
    const inputs = readRawInputs(ctx.env);
    const result = await resolveSetup(ctx, inputs, {
      fetchReleaseTag: async () => {
        throw new Error("source-path must not query a release");
      },
      systemRustupOverride: async () => false,
    });

    assert.equal(result.soldrSourcePath, sourcePath);
    assert.match(result.soldrSourceIdentity, /^local-[0-9a-f]{40}$/);
    assert.equal(result.soldrRef, "local-source");
    assert.equal(result.soldrVersionRequested, "");
    assert.equal(result.soldrVersionResolved, "0.9.2");
    assert.equal(supportsLayeredCookCache(result.soldrVersionResolved), true);
    assert.match(result.cargoRegistryCache.key, /-xrun-42-/);

    fs.appendFileSync(path.join(sourcePath, "Cargo.toml"), "\n# local edit\n", "utf8");
    const unchangedPin = await resolveSetup(ctx, inputs, {
      fetchReleaseTag: async () => {
        throw new Error("source-path must not query a release");
      },
      systemRustupOverride: async () => false,
    });
    assert.equal(unchangedPin.soldrSourceIdentity, result.soldrSourceIdentity);
    assert.equal(unchangedPin.setupCache.key, result.setupCache.key);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- lockfile-only restore key ---

test("lockfile prefix emitted for once mode", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "once", INPUT_TARGET_CACHE: "true" });
  const prefix = outputs["target_cache_restore_key_lockfile"] ?? "";
  assert.match(prefix, /^setup-soldr-targetcache-once-v2-linux-x64-thin-v1-/);
  assert.ok(prefix.endsWith("-"));
});

test("lockfile prefix emitted for full mode", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "full", INPUT_TARGET_CACHE: "true" });
  const prefix = outputs["target_cache_restore_key_lockfile"] ?? "";
  assert.match(prefix, /^setup-soldr-targetcache-full-v2-linux-x64-thin-v1-/);
});

test("lockfile prefix stable across manifest changes", async () => {
  const { outputs: a } = await run({
    files: { "Cargo.toml": "[package]\nname='a'\nversion='0.1.0'\n" },
  }, { INPUT_BUILD_CACHE_MODE: "once", INPUT_TARGET_CACHE: "true" });
  const { outputs: b } = await run({
    files: { "Cargo.toml": "[package]\nname='a'\nversion='0.1.0'\n[[bin]]\nname='x'\npath='src/main.rs'\n" },
  }, { INPUT_BUILD_CACHE_MODE: "once", INPUT_TARGET_CACHE: "true" });
  assert.notEqual(a["target_cache_restore_key_lock"], b["target_cache_restore_key_lock"]);
  assert.equal(
    a["target_cache_restore_key_lockfile"],
    b["target_cache_restore_key_lockfile"],
  );
});

test("lockfile prefix changes when lockfile contents change", async () => {
  const { outputs: a } = await run({ lockfileContents: "# baseline\n" }, { INPUT_BUILD_CACHE_MODE: "once", INPUT_TARGET_CACHE: "true" });
  const { outputs: b } = await run({ lockfileContents: "# different\n" }, { INPUT_BUILD_CACHE_MODE: "once", INPUT_TARGET_CACHE: "true" });
  assert.notEqual(
    a["target_cache_restore_key_lockfile"],
    b["target_cache_restore_key_lockfile"],
  );
});

test("lockfile prefix empty when target cache disabled", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE: "false" });
  assert.equal(outputs["target_cache_enabled"], "false");
  assert.equal(outputs["target_cache_restore_key_lock"], "");
  assert.equal(outputs["target_cache_restore_key_lockfile"], "");
});

test("lockfile prefix includes cache-key suffix fragment", async () => {
  const { outputs } = await run({}, {
    INPUT_BUILD_CACHE_MODE: "once",
    INPUT_TARGET_CACHE: "true",
    INPUT_CACHE_KEY_SUFFIX: "myjob",
  });
  const prefix = outputs["target_cache_restore_key_lockfile"] ?? "";
  assert.ok(prefix.endsWith("-myjob-"));
});

test("primary cache_key includes cache-key-suffix", async () => {
  const { outputs } = await run({}, { INPUT_CACHE_KEY_SUFFIX: "myjob" });
  const key = outputs["cache_key"] ?? "";
  assert.ok(
    key.endsWith("-myjob"),
    `expected cache_key to end with -myjob, got ${key}`,
  );
});

test("build_cache_key is per-job + SHA-independent (setup-soldr#237)", async () => {
  const { outputs } = await run({}, { INPUT_CACHE_KEY_SUFFIX: "myjob" });
  const key = outputs["build_cache_key"] ?? "";
  assert.ok(key.length > 0, "expected a non-empty build_cache_key");
  // Keep the per-job suffix so each job restores its OWN store (sharing one
  // store across jobs that compile different things still hit 0%)...
  assert.ok(
    key.includes("-myjob-"),
    `expected build_cache_key to include the per-job suffix, got ${key}`,
  );
  // ...but drop the commit SHA so it warm-hits across commits (the SHA was the
  // root cause of the exact-miss-then-wrong-fallback that gave ~0% hits, #237).
  assert.ok(
    !key.includes("0123456789abcdef"),
    `build_cache_key must not include the commit SHA, got ${key}`,
  );
  // Shape: setup-soldr-buildcache-v3-<os>-<arch>-<digest>-<suffix>-<lockhash>-s<soldr>.
  assert.match(key, /^setup-soldr-buildcache-v3-.*-myjob-[0-9a-f]+-s[0-9a-f]{16}$/);
});

test("#625 a soldr release keeps the build-cache restore fallback", async () => {
  const { outputs: a } = await run({}, { INPUT_VERSION: "0.9.42", INPUT_CACHE_KEY_SUFFIX: "myjob" });
  const { outputs: b } = await run({}, { INPUT_VERSION: "0.9.44", INPUT_CACHE_KEY_SUFFIX: "myjob" });
  const keyA = a["build_cache_key"] ?? "";
  const keyB = b["build_cache_key"] ?? "";
  const fallback = b["build_cache_restore_key_toolchain"] ?? "";
  // The exact key still records the soldr release that wrote the store...
  assert.notEqual(keyA, keyB);
  // ...but the job-scoped fallback does not, so 0.9.44 restores 0.9.42's store.
  assert.equal(a["build_cache_restore_key_toolchain"], fallback);
  assert.match(fallback, /-myjob-$/);
  assert.ok(keyA.startsWith(fallback), `${keyA} must start with ${fallback}`);
  assert.ok(keyB.startsWith(fallback), `${keyB} must start with ${fallback}`);
  // The setup cache is unchanged (#625 scope): it still varies with soldr.
  assert.notEqual(a["cache_key"], b["cache_key"]);
});

test("#625 the build-cache fallback still separates toolchains", async () => {
  const { outputs: a } = await run({}, { INPUT_VERSION: "0.9.42", INPUT_CACHE_KEY_SUFFIX: "myjob", INPUT_TOOLCHAIN: "1.81.0" });
  const { outputs: b } = await run({}, {
    INPUT_VERSION: "0.9.42", INPUT_CACHE_KEY_SUFFIX: "myjob", INPUT_TOOLCHAIN: "1.80.0",
  });
  assert.notEqual(a["build_cache_restore_key_toolchain"], b["build_cache_restore_key_toolchain"]);
});

test("cargo_registry_cache_key drops cache-key-suffix (#375)", async () => {
  // #375: cargo-registry content is per-(lockHash, digest), identical
  // across jobs. Dropping the per-job suffix lets matrix jobs SHARE the
  // cache entry — first save wins, rest exact-HIT instead of FALLBACK.
  // Eliminates ~56 MB × (matrix_jobs - 1) of redundant uploads per CI
  // cycle. Build-cache (#237) KEPT suffix because target/ content
  // differs per job; cargo-registry contents do not.
  const { outputs } = await run({}, { INPUT_CACHE_KEY_SUFFIX: "myjob" });
  const key = outputs["cargo_registry_cache_key"] ?? "";
  assert.ok(
    !key.endsWith("-myjob"),
    `cargo_registry_cache_key must NOT include the per-job suffix (#375), got ${key}`,
  );
});

test("cargo registry cache evolves with lockfile and excludes auth-bearing roots (#1532)", async () => {
  const lockA = await run(
    { lockfileContents: "# lock A\nname = \\\"alpha\\\"\n" },
    { INPUT_CARGO_REGISTRY_CACHE: "true" },
  );
  const lockB = await run(
    { lockfileContents: "# lock B\nname = \\\"beta\\\"\n" },
    { INPUT_CARGO_REGISTRY_CACHE: "true" },
  );

  assert.notEqual(
    lockA.result.cargoRegistryCache.key,
    lockB.result.cargoRegistryCache.key,
    "different lockfiles must not share one registry snapshot key",
  );
  assert.deepEqual(
    lockA.result.cargoRegistryCache.extraBasenames.sort(),
    [".global-cache", "git"],
    "registry snapshots may include Cargo's dependency data only",
  );
  assert.equal(
    lockA.result.cargoRegistryCache.path,
    path.join(lockA.result.cargoHome, "registry"),
  );
});

test("cache-key-suffix works via kebab-case env (production form)", async () => {
  // Simulate exactly what the GitHub Actions runner does: set
  // INPUT_CACHE-KEY-SUFFIX (dashes), not INPUT_CACHE_KEY_SUFFIX.
  const { outputs } = await run({}, { "INPUT_CACHE-KEY-SUFFIX": "demo" });
  const key = outputs["cache_key"] ?? "";
  assert.ok(
    key.endsWith("-demo"),
    `expected cache_key to end with -demo when set via kebab env, got ${key}`,
  );
});

test("target_cache_key always derived from narrow lock prefix + SHA", async () => {
  const { outputs } = await run({}, { INPUT_BUILD_CACHE_MODE: "once", INPUT_TARGET_CACHE: "true" });
  const key = outputs["target_cache_key"] ?? "";
  const narrow = outputs["target_cache_restore_key_lock"] ?? "";
  assert.ok(key.startsWith(narrow), `expected ${key} to start with ${narrow}`);
  assert.ok(key.endsWith("0123456789abcdef"));
});

// --- system rustup layout ---

test("setup_cache_layout reflects managed rustup path by default", async () => {
  // Skip explicit RUSTUP_HOME so managed path is chosen.
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  delete ctx.env["RUSTUP_HOME"];
  const inputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  assert.equal(result.setupCache.layout, "bin+soldr-bin+rustup");
  assert.equal(result.rustupStrategy, "managed");
});

test("system rustup match makes layout bin+soldr-bin", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  delete ctx.env["RUSTUP_HOME"];
  const inputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => true,
  });
  assert.equal(result.setupCache.layout, "bin+soldr-bin");
  assert.equal(result.rustupStrategy, "system");
});

test("layout switch alters cache key", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  delete ctx.env["RUSTUP_HOME"];
  const inputs = readRawInputs(ctx.env);
  const r1 = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const r2 = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => true,
  });
  assert.notEqual(r1.setupCache.key, r2.setupCache.key);
});

// --- linker ---

async function runCapturingWarnings(
  extraEnv: Record<string, string> = {},
): Promise<{ result: ResolveResult; warnings: string[]; notices: string[]; infos: string[] }> {
  const { root, workspace, runnerTemp } = makeWorkspace();
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env = withInputs(ctx.env, extraEnv);
  const warnings: string[] = [];
  const notices: string[] = [];
  const infos: string[] = [];
  ctx.logger = {
    info: (msg) => infos.push(msg),
    notice: (msg) => notices.push(msg),
    warning: (msg) => warnings.push(msg),
    error: () => {},
    debug: () => {},
    log: () => {},
  };
  const inputs: RawInputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  return { result, warnings, notices, infos };
}

test("linker default exports SOLDR_LINKER=fast as a notice", async () => {
  const { result, warnings, notices } = await runCapturingWarnings();
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
  assert.equal(
    warnings.some((m) => m.includes("SOLDR_LINKER=fast")),
    false,
    `expected no linker warning, got: ${JSON.stringify(warnings)}`,
  );
  assert.equal(
    notices.some((m) => m.includes("SOLDR_LINKER=fast") && m.includes("platform-default")),
    true,
    `expected linker notice, got: ${JSON.stringify(notices)}`,
  );
});

test("linker platform-default omits SOLDR_LINKER and does not warn", async () => {
  const { result, warnings } = await runCapturingWarnings({ INPUT_LINKER: "platform-default" });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER")), false);
});

test("linker explicit value passes through verbatim without warning", async () => {
  const { result, warnings } = await runCapturingWarnings({ INPUT_LINKER: "rust-lld" });
  assert.equal(result.envExports["SOLDR_LINKER"], "rust-lld");
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER")), false);
});

test("linker explicit fast passes through without warning", async () => {
  const { result, warnings } = await runCapturingWarnings({ INPUT_LINKER: "fast" });
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER")), false);
});

// --- compile-priority ---

test("compile-priority defaults to high via action.yml", async () => {
  const { result } = await run({}, { INPUT_COMPILE_PRIORITY: "high" });
  assert.equal(result.envExports["ZCCACHE_COMPILE_PRIORITY"], "high");
});

test("compile-priority explicit low passes through verbatim", async () => {
  const { result } = await run({}, { INPUT_COMPILE_PRIORITY: "low" });
  assert.equal(result.envExports["ZCCACHE_COMPILE_PRIORITY"], "low");
});

test("compile-priority empty string skips export so zccache uses its native default", async () => {
  const { result } = await run({}, { INPUT_COMPILE_PRIORITY: "" });
  assert.equal(result.envExports["ZCCACHE_COMPILE_PRIORITY"], undefined);
});

// --- jobserver env deny list ---

test("CARGO_MAKEFLAGS / MAKEFLAGS are never exported", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE_STRIP_DEBUGINFO: "true",
  });
  assert.equal(result.envExports["CARGO_MAKEFLAGS"], undefined);
  assert.equal(result.envExports["MAKEFLAGS"], undefined);
});

// --- readRawInputs ---

test("readRawInputs maps INPUT_* env vars by name", () => {
  const inputs = readRawInputs({
    INPUT_VERSION: "0.7.11",
    INPUT_REPO: "zackees/soldr",
    INPUT_TARGET_CACHE_COMPRESS: "zstd",
    INPUT_CARGO_REGISTRY_CACHE: "true",
    INPUT_LINKER: "fast",
  });
  assert.equal(inputs.version, "0.7.11");
  assert.equal(inputs.repo, "zackees/soldr");
  assert.equal(inputs.targetCacheCompress, "zstd");
  assert.equal(inputs.cargoRegistryCache, "true");
  assert.equal(inputs.cacheDir, "");
  assert.equal(inputs.linker, "fast");
});

// --- linker input (validation + alias semantics) ---

test("linker 'default' opts out and does not export SOLDR_LINKER", async () => {
  const { result } = await run({}, { INPUT_LINKER: "default" });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
});

test("linker valid non-opt-out values export SOLDR_LINKER", async () => {
  for (const value of ["ld", "mold", "rust-lld", "fast"]) {
    const { result } = await run({}, { INPUT_LINKER: value });
    assert.equal(result.envExports["SOLDR_LINKER"], value, `linker=${value}`);
  }
});

test("linker invalid value throws with helpful message", async () => {
  await assert.rejects(
    () => run({}, { INPUT_LINKER: "garbage" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /invalid 'linker' input/);
      return true;
    },
  );
});

// --- linker default deferral when user has cross-compile env preset (issue #108) ---

test("linker default defers to user-set CARGO_TARGET_<TRIPLE>_LINKER and skips SOLDR_LINKER=fast", async () => {
  const { result, warnings, infos } = await runCapturingWarnings({
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
  assert.equal(
    warnings.some((m) => m.includes("SOLDR_LINKER")),
    false,
    `unexpected linker warning: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    infos.some(
      (m) =>
        m.includes("deferring to user-set") &&
        m.includes("CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc"),
    ),
    `expected deferral info, got: ${JSON.stringify(infos)}`,
  );
});

test("linker default defers when only CARGO_TARGET_<TRIPLE>_RUSTFLAGS is preset", async () => {
  const { result, infos } = await runCapturingWarnings({
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-C link-arg=-fuse-ld=ld",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], undefined);
  assert.ok(
    infos.some((m) =>
      m.includes("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C link-arg=-fuse-ld=ld"),
    ),
    `expected deferral info, got: ${JSON.stringify(infos)}`,
  );
});

test("linker explicit 'fast' still injects even when CARGO_TARGET_<TRIPLE>_LINKER is preset", async () => {
  const { result } = await runCapturingWarnings({
    INPUT_LINKER: "fast",
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
});

test("linker default with empty CARGO_TARGET_<TRIPLE>_LINKER does not defer", async () => {
  const { result, warnings, notices } = await runCapturingWarnings({
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "",
  });
  assert.equal(result.envExports["SOLDR_LINKER"], "fast");
  assert.equal(warnings.some((m) => m.includes("SOLDR_LINKER=fast")), false);
  assert.ok(notices.some((m) => m.includes("SOLDR_LINKER=fast")));
});

// --- detectMuslCcEnv (cc-rs cross-compile env autodetect) ---

test("detectMuslCcEnv picks up triple from CARGO_BUILD_TARGET and exports CC/CXX/AR", () => {
  const found = new Set([
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
    "aarch64-unknown-linux-musl-ar",
  ]);
  const hits = detectMuslCcEnv(
    { PATH: "/opt/cross/bin", CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl" },
    {
      findOnPath: (cmd) => (found.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.triple, "aarch64-unknown-linux-musl");
  assert.deepEqual(hits[0]!.exports, {
    CC_aarch64_unknown_linux_musl: "aarch64-unknown-linux-musl-gcc",
    CXX_aarch64_unknown_linux_musl: "aarch64-unknown-linux-musl-g++",
    AR_aarch64_unknown_linux_musl: "aarch64-unknown-linux-musl-ar",
  });
});

test("detectMuslCcEnv picks up triple from CARGO_TARGET_<TRIPLE>_LINKER preset", () => {
  const found = new Set([
    "x86_64-unknown-linux-musl-gcc",
    "x86_64-unknown-linux-musl-g++",
    "x86_64-unknown-linux-musl-ar",
  ]);
  const hits = detectMuslCcEnv(
    {
      PATH: "/opt/cross/bin",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "x86_64-unknown-linux-musl-gcc",
    },
    {
      findOnPath: (cmd) => (found.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.triple, "x86_64-unknown-linux-musl");
});

test("detectMuslCcEnv discovers triples by PATH scan when no env hints exist", () => {
  const hits = detectMuslCcEnv(
    { PATH: "/opt/cross/bin" },
    {
      findOnPath: (cmd) => {
        if (cmd.endsWith("-gcc") || cmd.endsWith("-g++") || cmd.endsWith("-ar")) {
          return `/opt/cross/bin/${cmd}`;
        }
        return null;
      },
      readDir: (dir) =>
        dir === "/opt/cross/bin"
          ? [
              "aarch64-unknown-linux-musl-gcc",
              "aarch64-unknown-linux-musl-g++",
              "aarch64-unknown-linux-musl-ar",
              "ls",
            ]
          : [],
    },
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.triple, "aarch64-unknown-linux-musl");
});

test("detectMuslCcEnv skips triple when user has already set CC_<triple>", () => {
  const found = new Set([
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
    "aarch64-unknown-linux-musl-ar",
  ]);
  const hits = detectMuslCcEnv(
    {
      PATH: "/opt/cross/bin",
      CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl",
      CC_aarch64_unknown_linux_musl: "/custom/path/cc",
    },
    {
      findOnPath: (cmd) => (found.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.deepEqual(hits, []);
});

test("detectMuslCcEnv ignores non-musl triples (e.g. linux-gnu)", () => {
  const hits = detectMuslCcEnv(
    {
      PATH: "/usr/bin",
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
    },
    {
      findOnPath: () => "/usr/bin/aarch64-linux-gnu-gcc",
      readDir: () => [],
    },
  );
  assert.deepEqual(hits, []);
});

test("detectMuslCcEnv skips triple when a required binary (ar) is missing on PATH", () => {
  const present = new Set([
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
  ]);
  const hits = detectMuslCcEnv(
    { PATH: "/opt/cross/bin", CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl" },
    {
      findOnPath: (cmd) => (present.has(cmd) ? `/opt/cross/bin/${cmd}` : null),
      readDir: () => [],
    },
  );
  assert.deepEqual(hits, []);
});

test("resolveSetup exports cc-rs musl env and emits a yellow warning when binaries are on PATH", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace();
  const fakeBin = path.join(root, "cross-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of [
    "aarch64-unknown-linux-musl-gcc",
    "aarch64-unknown-linux-musl-g++",
    "aarch64-unknown-linux-musl-ar",
  ]) {
    fs.writeFileSync(path.join(fakeBin, name), "", "utf8");
  }
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env = withInputs(ctx.env, {
    CARGO_BUILD_TARGET: "aarch64-unknown-linux-musl",
    PATH: fakeBin,
  });
  const warnings: string[] = [];
  ctx.logger = {
    info: () => {},
    notice: () => {},
    warning: (msg) => warnings.push(msg),
    error: () => {},
    debug: () => {},
    log: () => {},
  };
  const inputs: RawInputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  assert.equal(
    result.envExports["CC_aarch64_unknown_linux_musl"],
    "aarch64-unknown-linux-musl-gcc",
  );
  assert.equal(
    result.envExports["CXX_aarch64_unknown_linux_musl"],
    "aarch64-unknown-linux-musl-g++",
  );
  assert.equal(
    result.envExports["AR_aarch64_unknown_linux_musl"],
    "aarch64-unknown-linux-musl-ar",
  );
  assert.ok(
    warnings.some(
      (m) =>
        m.includes("auto-exporting cc-rs cross-compile env") &&
        m.includes("aarch64-unknown-linux-musl"),
    ),
    `expected musl cc-rs warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("detectUserLinkerEnv returns matching CARGO_TARGET_<TRIPLE> vars sorted", () => {
  const env = {
    HOME: "/home/x",
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-C link-arg=-fuse-ld=ld",
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: "aarch64-linux-gnu-gcc",
    CARGO_TARGET_DIR: "/tmp/target",
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_CC: "aarch64-linux-gnu-gcc",
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "",
  };
  assert.deepEqual(detectUserLinkerEnv(env), [
    "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C link-arg=-fuse-ld=ld",
  ]);
});

// --- enable input (passthrough mode) ---

test("enable defaults to true and soldrPath ends in soldr/soldr.exe", async () => {
  const { result, outputs } = await run();
  assert.equal(result.enabled, true);
  assert.equal(outputs["enabled"], "true");
  const expectedName = process.platform === "win32" ? "soldr.exe" : "soldr";
  assert.ok(
    result.soldrPath.endsWith(expectedName),
    `expected soldrPath to end in ${expectedName}, got ${result.soldrPath}`,
  );
});

test("enable=true is accepted and behaves as default", async () => {
  const { result } = await run({}, { INPUT_ENABLE: "true" });
  assert.equal(result.enabled, true);
});

test("enable=false flips enabled to false and points soldrPath at the stub file", async () => {
  const { result, outputs } = await run({}, { INPUT_ENABLE: "false" });
  assert.equal(result.enabled, false);
  assert.equal(outputs["enabled"], "false");
  const expectedName = process.platform === "win32" ? "soldr.cmd" : "soldr";
  assert.ok(
    result.soldrPath.endsWith(expectedName),
    `expected soldrPath to end in ${expectedName}, got ${result.soldrPath}`,
  );
});

test("enable invalid value rejects with helpful message", async () => {
  await assert.rejects(
    () => run({}, { INPUT_ENABLE: "maybe" }),
    /invalid 'enable' input/,
  );
});

// --- cache-shutdown-on-idle input ---

test("cache-shutdown-on-idle defaults to null (no override)", async () => {
  const { result } = await run();
  assert.equal(result.cacheShutdownOnIdleSeconds, null);
  assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], undefined);
  assert.equal(result.envExports["SCCACHE_IDLE_TIMEOUT"], undefined);
});

test("cache-shutdown-on-idle bare integer parsed as seconds", async () => {
  const { result } = await run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: "30" });
  assert.equal(result.cacheShutdownOnIdleSeconds, 30);
  assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], "30");
  assert.equal(result.envExports["SCCACHE_IDLE_TIMEOUT"], "30");
});

test("cache-shutdown-on-idle accepts s/m/h suffixes", async () => {
  const cases: Array<[string, number]> = [
    ["30s", 30],
    ["2m", 120],
    ["1h", 3600],
  ];
  for (const [raw, expected] of cases) {
    const { result } = await run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: raw });
    assert.equal(result.cacheShutdownOnIdleSeconds, expected, `input=${raw}`);
    assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], String(expected));
    assert.equal(result.envExports["SCCACHE_IDLE_TIMEOUT"], String(expected));
  }
});

test("cache-shutdown-on-idle '0'/'off'/'false' disable the override", async () => {
  for (const raw of ["0", "off", "false", "no"]) {
    const { result } = await run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: raw });
    assert.equal(result.cacheShutdownOnIdleSeconds, null, `input=${raw}`);
    assert.equal(result.envExports["ZCCACHE_IDLE_TIMEOUT"], undefined);
  }
});

// --- rust-backtrace input ---

test("rust-backtrace defaults to '1' (action.yml default)", async () => {
  const { result } = await run({}, { INPUT_RUST_BACKTRACE: "1" });
  assert.equal(result.envExports["RUST_BACKTRACE"], "1");
});

test("rust-backtrace accepts truthy aliases", async () => {
  for (const raw of ["1", "true", "on", "yes", "TRUE", "YES"]) {
    const { result } = await run({}, { INPUT_RUST_BACKTRACE: raw });
    assert.equal(result.envExports["RUST_BACKTRACE"], "1", `input=${raw}`);
  }
});

test("rust-backtrace accepts 'full' and exports verbatim", async () => {
  const { result } = await run({}, { INPUT_RUST_BACKTRACE: "full" });
  assert.equal(result.envExports["RUST_BACKTRACE"], "full");
});

test("rust-backtrace '0'/'off'/'false'/'no'/'' skip the export", async () => {
  for (const raw of ["0", "off", "false", "no", ""]) {
    const { result } = await run({}, { INPUT_RUST_BACKTRACE: raw });
    assert.equal(result.envExports["RUST_BACKTRACE"], undefined, `input=${JSON.stringify(raw)}`);
  }
});

test("rust-backtrace rejects unknown values", async () => {
  await assert.rejects(
    () => run({}, { INPUT_RUST_BACKTRACE: "maybe" }),
    /invalid 'rust-backtrace' input/,
  );
});

// --- cache umbrella ---

test("default cache policy keeps only the zccache build cache enabled", async () => {
  const { result } = await run();
  assert.equal(result.buildCache.mode, "once");
  assert.equal(result.targetCache.enabled, false);
  assert.equal(result.cargoRegistryCache.enabled, false);
  assert.equal(result.envExports["SETUP_SOLDR_BUILD_CACHE_MODE"], "once");
  assert.equal(result.envExports["SOLDR_BUILD_CACHE_MODE"], "full");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
  assert.equal(result.envExports["SOLDR_SKIP_CARGO_REGISTRY_SAVE"], undefined);
});

test("cache=false cascades to disable build-cache, target-cache, and cargo-registry-cache", async () => {
  const { result } = await run({}, {
    INPUT_CACHE: "false",
    INPUT_CARGO_REGISTRY_CACHE: "true",
    INPUT_TARGET_CACHE: "true",
    INPUT_BUILD_CACHE: "true",
  });
  assert.equal(result.buildCache.path !== "", true);
  assert.equal(result.targetCache.enabled, false, "target-cache forced off by cache=false");
  assert.equal(result.cargoRegistryCache.enabled, false, "cargo-registry-cache forced off by cache=false");
  // SOLDR_BUILD_CACHE_MODE switches to "off" so soldr stops invoking zccache.
  assert.equal(result.envExports["SOLDR_BUILD_CACHE_MODE"], "off");
  assert.equal(result.envExports["SETUP_SOLDR_BUILD_CACHE_MODE"], "off");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
});

test("cache=true (default) leaves per-layer flags in charge", async () => {
  const { result } = await run({}, {
    INPUT_CACHE: "true",
    INPUT_CARGO_REGISTRY_CACHE: "true",
    INPUT_TARGET_CACHE: "true",
    INPUT_BUILD_CACHE: "true",
  });
  assert.equal(result.cargoRegistryCache.enabled, true);
  assert.notEqual(result.envExports["SOLDR_BUILD_CACHE_MODE"], "off");
});

test("cargo-registry explicit Soldr opt-in selects v2 only for a compatible unencrypted release", async () => {
  const original = process.env["SOLDR_CARGO_REGISTRY_VIA_SOLDR"];
  process.env["SOLDR_CARGO_REGISTRY_VIA_SOLDR"] = "1";
  try {
    const { result } = await run({}, {
      INPUT_VERSION: "0.8.39",
      INPUT_CARGO_REGISTRY_CACHE: "true",
    });
    assert.equal(result.cargoRegistryCache.archive.format, "soldr-v2");
    assert.match(result.cargoRegistryCache.key, /^setup-soldr-cargoregistry-v2-/);
    assert.equal(result.cargoRegistryCache.archive.restorePaths.length, 2);
    assert.ok(
      result.cargoRegistryCache.archive.restorePaths.every((entry) =>
        entry.includes(`${path.sep}setup-soldr-cargo-registry${path.sep}v2${path.sep}`),
      ),
    );

    const encrypted = await run({}, {
      INPUT_VERSION: "0.8.39",
      INPUT_CARGO_REGISTRY_CACHE: "true",
      INPUT_CACHE_ENCRYPT_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    assert.equal(encrypted.result.cargoRegistryCache.archive.format, "legacy-v1");
    assert.match(encrypted.result.cargoRegistryCache.key, /^setup-soldr-cargoregistry-v1-/);

    const old = await run({}, {
      INPUT_VERSION: "0.7.11",
      INPUT_CARGO_REGISTRY_CACHE: "true",
    });
    assert.equal(old.result.cargoRegistryCache.archive.format, "legacy-v1");
  } finally {
    if (original === undefined) delete process.env["SOLDR_CARGO_REGISTRY_VIA_SOLDR"];
    else process.env["SOLDR_CARGO_REGISTRY_VIA_SOLDR"] = original;
  }
});

test("cache-shutdown-on-idle rejects malformed values", async () => {
  await assert.rejects(
    () => run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: "thirty" }),
    /invalid 'cache-shutdown-on-idle' input/,
  );
  await assert.rejects(
    () => run({}, { INPUT_CACHE_SHUTDOWN_ON_IDLE: "30sec" }),
    /invalid 'cache-shutdown-on-idle' input/,
  );
});

// --- cache retention gaps (setup-soldr#102) ---
//
// PRs 1+2 of the rollout: `.global-cache` (cargo's RFC-3413 GC db) and
// `git/` (db/ + checkouts/ for git-source crate deps) ride inside the
// existing cargo-registry cache archive. PR 3: `~/.rustup/update-hashes/`
// is always part of setup-cache so `rustup update` short-circuits.
//
// Cache *key* shape must not move — these are pure path-list additions
// living under the same actions/cache key.

test(
  "cargo-registry-cache extraBasenames bundles .global-cache + git (#102 PR 1-2)",
  async () => {
    const { result } = await run({}, { INPUT_CARGO_REGISTRY_CACHE: "true" });
    const extras = result.cargoRegistryCache.extraBasenames;
    assert.ok(
      extras.includes(".global-cache"),
      `expected .global-cache in extraBasenames, got ${JSON.stringify(extras)}`,
    );
    assert.ok(
      extras.includes("git"),
      `expected git in extraBasenames, got ${JSON.stringify(extras)}`,
    );
  },
);

test(
  "cargo-registry-cache extras are siblings of path (under $CARGO_HOME)",
  async () => {
    // The extras are basenames, not full paths — compressCache joins them
    // against dirname(path). Verify the parent is $CARGO_HOME so the saved
    // archive lays out as <cargoHome>/{registry,.global-cache,git}/.
    const { result } = await run({}, { INPUT_CARGO_REGISTRY_CACHE: "true" });
    const parent = path.dirname(result.cargoRegistryCache.path);
    assert.equal(
      parent,
      result.cargoHome,
      `expected dirname(cargoRegistryCache.path) to equal cargoHome`,
    );
  },
);

test(
  "cargo-registry-cache key is unchanged by extraBasenames (#102: no key shape change)",
  async () => {
    // PR 1-2 must only add paths inside the archive — the cache KEY itself
    // (prefix + lock hash + toolchain digest + sha + suffix) cannot
    // incorporate the new path names or warm caches on existing consumers
    // would invalidate.
    const { result } = await run({}, { INPUT_CARGO_REGISTRY_CACHE: "true" });
    // 1) Key shape: prefix `setup-soldr-cargoregistry-v1-<os>-<arch>-<lock>-<digest>`.
    // #371: SHA was dropped — same anti-pattern fix as #237 for build-cache.
    const key = result.cargoRegistryCache.key;
    assert.match(
      key,
      /^setup-soldr-cargoregistry-v1-linux-x64-[0-9a-f]{16}-[0-9a-f]{16}$/,
      `cache key shape regressed: ${key}`,
    );
    // The commit SHA must NOT appear (it was the #237/#371 anti-pattern).
    assert.ok(
      !key.includes("0123456789abcdef"),
      `cargo-registry key must not include the commit SHA (#371), got ${key}`,
    );
    // 2) The .global-cache / git names must NOT appear in the key.
    assert.ok(!key.includes(".global-cache"), `key leaked extra name: ${key}`);
    assert.ok(!key.includes("/git"), `key leaked extra name: ${key}`);
  },
);

test(
  "setup-cache always includes rustup update-hashes path (#102 PR 3)",
  async () => {
    // System rustup layout (no explicit RUSTUP_HOME, system rustup satisfies):
    // toolchains/ + settings.toml are owned by the runner image and stay
    // out of the cache, but update-hashes/ is tiny and a huge latency win
    // so it must always be in the path list.
    const { root, workspace, runnerTemp } = makeWorkspace({});
    const ctx = makeContext(root, workspace, runnerTemp);
    delete ctx.env["RUSTUP_HOME"];
    const inputs = readRawInputs(ctx.env);
    const sys = await resolveSetup(ctx, inputs, {
      fetchReleaseTag: async () => "v0.7.11",
      systemRustupOverride: async () => true,
    });
    const sysPaths = sys.setupCache.paths;
    assert.ok(
      sysPaths.some((p) => p.endsWith(path.join("update-hashes")) || p.endsWith("update-hashes")),
      `expected update-hashes in system-layout setup-cache paths: ${sysPaths.join(", ")}`,
    );
    // Managed layout still includes everything.
    const { root: root2, workspace: ws2, runnerTemp: rt2 } = makeWorkspace({});
    const ctx2 = makeContext(root2, ws2, rt2);
    delete ctx2.env["RUSTUP_HOME"];
    const inputs2 = readRawInputs(ctx2.env);
    const mgd = await resolveSetup(ctx2, inputs2, {
      fetchReleaseTag: async () => "v0.7.11",
      systemRustupOverride: async () => false,
    });
    const mgdPaths = mgd.setupCache.paths;
    assert.ok(
      mgdPaths.some((p) => p.endsWith("update-hashes")),
      `expected update-hashes in managed-layout setup-cache paths: ${mgdPaths.join(", ")}`,
    );
  },
);

test(
  "setup-cache layout key is unchanged by always-on update-hashes (#102: no key shape change)",
  async () => {
    // The layout label drives the cache-key digest. Adding update-hashes to
    // the path list of the *system* layout must not flip the layout label
    // — that would invalidate every warm cache. We assert the label and
    // the cache key prefix shape directly.
    const { root, workspace, runnerTemp } = makeWorkspace({});
    const ctx = makeContext(root, workspace, runnerTemp);
    delete ctx.env["RUSTUP_HOME"];
    const inputs = readRawInputs(ctx.env);
    const result = await resolveSetup(ctx, inputs, {
      fetchReleaseTag: async () => "v0.7.11",
      systemRustupOverride: async () => true,
    });
    assert.equal(result.setupCache.layout, "bin+soldr-bin");
    assert.match(
      result.setupCache.key,
      /^setup-soldr-v4-linux-x64-[0-9a-f]{16}$/,
      `setup-cache key shape regressed: ${result.setupCache.key}`,
    );
  },
);

test("cache keys use trimmed GitHub runner identity when ACTION overrides are blank", async () => {
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const ctx = makeContext(root, workspace, runnerTemp);
  ctx.env["ACTION_OS"] = "  ";
  ctx.env["ACTION_ARCH"] = "  ";
  ctx.env["RUNNER_OS"] = " Linux ";
  ctx.env["RUNNER_ARCH"] = " X64 ";
  const inputs = readRawInputs(ctx.env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => true,
  });
  assert.match(result.setupCache.key, /^setup-soldr-v4-linux-x64-/);
  assert.doesNotMatch(result.setupCache.key, /-unknown-/);
});

/* retired per-lane cross-tool tests
// --------------------- per-(host × target) tool cache plans (setup-soldr#106) ---------------------
//
// Wave 2.1 of zackees/soldr#514: when `cross-targets` is non-empty,
// resolveSetup must surface a `crossToolCaches` plan with one entry per
// declared target lane. Empty / unset `cross-targets` keeps the field empty
// so non-cross-compiling consumers see zero behavior change.

test("crossToolCaches is empty when cross-targets unset (backwards compat)", async () => {
  const { result } = await run();
  assert.ok(result.crossToolCaches, "crossToolCaches must exist on ResolveResult");
  assert.deepEqual(result.crossToolCaches, [], "no cross-targets => no lane plans");
});

test("crossToolCaches is empty when cross-tool=none even with cross-targets set", async () => {
  const { result } = await run({}, {
    INPUT_CROSS_TARGETS: "x86_64-pc-windows-gnu",
    INPUT_CROSS_TOOL: "none",
  });
  assert.deepEqual(result.crossToolCaches, []);
});

test("crossToolCaches: one entry per declared target (linux -> windows-gnu)", async () => {
  const { result } = await run({}, {
    INPUT_CROSS_TARGETS: "x86_64-pc-windows-gnu",
  });
  assert.equal(result.crossToolCaches.length, 1);
  const lane = result.crossToolCaches[0];
  assert.ok(lane);
  assert.equal(lane.target, "x86_64-pc-windows-gnu");
  assert.match(lane.host, /linux/);
  // The key must be in the new `tool-` namespace (collision guard).
  assert.ok(lane.key.startsWith("tool-"), `lane key shape regressed: ${lane.key}`);
  // The lane carries the on-disk paths to archive on save.
  assert.ok(Array.isArray(lane.paths));
  assert.ok(lane.paths.length > 0, "supported lane must contribute cache paths");
});

test("crossToolCaches: multi-target produces one slot per triple with distinct keys", async () => {
  const { result } = await run({}, {
    INPUT_CROSS_TARGETS: "x86_64-pc-windows-gnu\naarch64-unknown-linux-musl",
  });
  assert.equal(result.crossToolCaches.length, 2);
  const targets = result.crossToolCaches.map((c) => c.target).sort();
  assert.deepEqual(targets, ["aarch64-unknown-linux-musl", "x86_64-pc-windows-gnu"]);
  // Each lane must have a unique cache key (target is in the key shape).
  const keys = new Set(result.crossToolCaches.map((c) => c.key));
  assert.equal(keys.size, 2, "lane keys must be unique per target");
});

test("crossToolCaches: unsupported lane still gets an entry but with empty paths (no-op slot)", async () => {
  // windows -> apple-darwin is an MVP unsupported lane. The cache layer
  // still emits an entry so the resolve output shape is uniform, but the
  // `paths` are empty so main.ts skips both restore and save for that lane.
  const { result } = await run({}, {
    INPUT_CROSS_TARGETS: "x86_64-apple-darwin",
    ACTION_OS: "Windows",
    ACTION_ARCH: "X64",
  });
  assert.equal(result.crossToolCaches.length, 1);
  const lane = result.crossToolCaches[0];
  assert.ok(lane);
  assert.deepEqual(lane.paths, [], "unsupported lane has nothing to cache");
});

test("crossToolCaches keys do not collide with other cache namespaces", async () => {
  const { result } = await run({}, {
    INPUT_CROSS_TARGETS: "x86_64-pc-windows-gnu",
  });
  // Sanity: each existing cache layer uses a different prefix.
  const otherKeys = [
    result.setupCache.key,
    result.buildCache.key,
    result.targetCache.key,
    result.cargoRegistryCache.key,
  ];
  for (const lane of result.crossToolCaches) {
    for (const k of otherKeys) {
      assert.notEqual(lane.key, k, `lane key must not equal another layer's key`);
    }
    // Explicit guard: the lane key is in the `tool-` namespace.
    assert.ok(lane.key.startsWith("tool-"), `lane key must use tool- prefix: ${lane.key}`);
  }
});

test("crossToolCaches: setting cross-targets does NOT change the other cache keys", async () => {
  // Backwards-compat invariant: adding `cross-targets` must not invalidate
  // the existing setup/build/target/cargo-registry caches users already
  // populated on warm runs.
  const { root, workspace, runnerTemp } = makeWorkspace({});
  const baseCtx = makeContext(root, workspace, runnerTemp);
  const baseInputs = readRawInputs(baseCtx.env);
  const r1 = await resolveSetup(baseCtx, baseInputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const ctx2 = makeContext(root, workspace, runnerTemp);
  ctx2.env = withInputs(ctx2.env, {
    INPUT_CROSS_TARGETS: "x86_64-pc-windows-gnu",
  });
  const inputs2 = readRawInputs(ctx2.env);
  const r2 = await resolveSetup(ctx2, inputs2, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  assert.equal(r1.setupCache.key, r2.setupCache.key, "setup-cache key must be stable");
  assert.equal(r1.buildCache.key, r2.buildCache.key, "build-cache key must be stable");
  assert.equal(r1.targetCache.key, r2.targetCache.key, "target-cache key must be stable");
  assert.equal(
    r1.cargoRegistryCache.key,
    r2.cargoRegistryCache.key,
    "cargo-registry-cache key must be stable",
  );
});

*/
// ============================================================================
// cache-preset umbrella (#251 Proposal B) — explicit-wins precedence, mapping
// per preset, no-preset (default) case, invalid value rejection.
// ============================================================================

test("cache-preset: empty (default) does not mutate inputs; historical defaults apply", async () => {
  const { result } = await run({});
  assert.equal(result.cachePresetEffective, "");
  assert.equal(result.buildCache.enabled, true, "historical default keeps build-cache on");
  assert.equal(result.targetCache.enabled, false, "historical default keeps target-cache off");
  assert.equal(result.cargoRegistryCache.enabled, false, "historical default keeps registry off");
});

// ============================================================================
// #267: implicit cargo-registry-cache pairing when prebuild-deps=soldr-cook.
// ============================================================================

test("prebuild-deps=soldr-cook implicitly enables cargo-registry-cache (#267)", async () => {
  const { result } = await run({}, { INPUT_PREBUILD_DEPS: "soldr-cook" });
  assert.equal(
    result.cargoRegistryCache.enabled,
    true,
    "soldr-cook prebuild without explicit cargo-registry-cache should default registry on",
  );
});

test("prebuild-deps=soldr-cook + explicit cargo-registry-cache=false respects user (#267)", async () => {
  const { result } = await run({}, {
    INPUT_PREBUILD_DEPS: "soldr-cook",
    INPUT_CARGO_REGISTRY_CACHE: "false",
  });
  assert.equal(
    result.cargoRegistryCache.enabled,
    false,
    "explicit cargo-registry-cache=false must beat the #267 implicit pairing",
  );
});

test("prebuild-deps=none does not flip cargo-registry-cache (#267)", async () => {
  const { result } = await run({}, { INPUT_PREBUILD_DEPS: "none" });
  assert.equal(
    result.cargoRegistryCache.enabled,
    false,
    "no cook = no implicit pairing; cargo-registry-cache stays at historical default",
  );
});

test("cache-preset=minimal retains the registry sources required by soldr-cook (#470)", async () => {
  // Dependency rematerialization requires both the cooked target artifacts
  // and the exact Cargo registry/git sources that Cargo fingerprints.
  const { result } = await run({}, { INPUT_CACHE_PRESET: "minimal" });
  assert.equal(result.cachePresetEffective, "minimal");
  assert.equal(
    result.cargoRegistryCache.enabled,
    true,
    "minimal keeps the registry half of the dependency closure",
  );
});

test("cache-preset: foundation keeps the complete dependency closure (#470)", async () => {
  const { result } = await run({}, { INPUT_CACHE_PRESET: "foundation" });
  assert.equal(result.cachePresetEffective, "foundation");
  assert.equal(result.buildCache.enabled, true);
  assert.equal(result.targetCache.enabled, false);
  assert.equal(result.cargoRegistryCache.enabled, true);
});

test("cache-preset: minimal disables build/target caches but keeps dependency sources (#470)", async () => {
  const { result } = await run({}, { INPUT_CACHE_PRESET: "minimal" });
  assert.equal(result.cachePresetEffective, "minimal");
  assert.equal(result.buildCache.enabled, false, "minimal turns build-cache off");
  assert.equal(result.targetCache.enabled, false);
  assert.equal(result.cargoRegistryCache.enabled, true);
});

test("cache-preset: full enables target-cache + cargo-registry + thin build-cache-mode (#251)", async () => {
  const { result } = await run({}, { INPUT_CACHE_PRESET: "full" });
  assert.equal(result.cachePresetEffective, "full");
  assert.equal(result.buildCache.enabled, true);
  assert.equal(result.targetCache.enabled, true, "full opts target-cache in");
  assert.equal(result.cargoRegistryCache.enabled, true, "full opts cargo-registry-cache in");
  assert.equal(result.buildCache.mode, "thin", "full standardizes build-cache-mode=thin");
});

test("cache-preset: explicit fine-grained inputs override the preset (#251)", async () => {
  // cache-preset: minimal would set build-cache=false; explicit override wins.
  const { result } = await run({}, {
    INPUT_CACHE_PRESET: "minimal",
    INPUT_BUILD_CACHE: "true",
  });
  assert.equal(result.cachePresetEffective, "minimal");
  assert.equal(result.buildCache.enabled, true, "explicit build-cache=true beats minimal preset");
});

test("cache-preset: explicit target-cache=true under minimal still opts in (#251)", async () => {
  const { result } = await run({}, {
    INPUT_CACHE_PRESET: "minimal",
    INPUT_TARGET_CACHE: "true",
  });
  assert.equal(result.targetCache.enabled, false, "minimal disables build-cache, gating target-cache off");
  // Build-cache is the gate for target-cache (line ~495 of resolve-setup); minimal
  // turns build-cache off so target-cache cannot enable. The explicit-wins rule
  // is still honored at input level — the cascade just gates it later.
});

test("cache-preset: full + explicit build-cache-mode=full keeps full (#251)", async () => {
  const { result } = await run({}, {
    INPUT_CACHE_PRESET: "full",
    INPUT_BUILD_CACHE_MODE: "full",
  });
  assert.equal(result.buildCache.mode, "full", "explicit build-cache-mode beats preset's thin");
});

test("cache-preset: invalid value throws", async () => {
  await assert.rejects(
    run({}, { INPUT_CACHE_PRESET: "kitchen-sink" }),
    /invalid cache-preset 'kitchen-sink'/,
  );
});

test("cache-preset: cache-preset-effective output mirrors the resolved preset (#251)", async () => {
  const { outputs } = await run({}, { INPUT_CACHE_PRESET: "full" });
  assert.equal(outputs["cache-preset-effective"], "full");
});

test("cache-preset: no preset surfaces empty cache-preset-effective output (#251)", async () => {
  const { outputs } = await run({});
  assert.equal(outputs["cache-preset-effective"], "");
});

// ============================================================================
// build-cache-mode thin-default flip (#251 Proposal A) — empty + target-cache
// opt-in resolves to thin; no target-cache leaves SETUP_SOLDR_BUILD_CACHE_MODE
// at "once" for env-visible compatibility.
// ============================================================================

test("build-cache-mode: empty + target-cache=true resolves to thin (#251)", async () => {
  const { result, outputs } = await run({}, { INPUT_TARGET_CACHE: "true" });
  assert.equal(result.buildCache.mode, "thin");
  assert.equal(outputs["build-cache-mode"], "thin");
});

test("build-cache-mode: empty + target-cache=false (default) stays once (#251)", async () => {
  const { result } = await run({});
  assert.equal(result.buildCache.mode, "once");
});

test("build-cache-mode: explicit value beats the thin-default flip (#251)", async () => {
  const { result } = await run({}, {
    INPUT_TARGET_CACHE: "true",
    INPUT_BUILD_CACHE_MODE: "once",
  });
  assert.equal(result.buildCache.mode, "once");
});

// ============================================================================
// SOLDR_ZCCACHE_PRIVATE overlap warning (soldr#807). The env var is a
// silent no-op under setup-soldr because we pin ZCCACHE_CACHE_DIR
// explicitly, so detectZccachePrivateOverlap returns a warning string
// for the resolver to surface via core.warning.
// ============================================================================

test("detectZccachePrivateOverlap: returns warning when SOLDR_ZCCACHE_PRIVATE truthy", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", "Yes", " on ", "ON"]) {
    const msg = detectZccachePrivateOverlap({ SOLDR_ZCCACHE_PRIVATE: v });
    assert.ok(msg, `expected ${JSON.stringify(v)} to produce a warning`);
    assert.match(msg!, /SOLDR_ZCCACHE_PRIVATE/);
    assert.match(msg!, /ZCCACHE_CACHE_DIR/);
  }
});

test("detectZccachePrivateOverlap: returns null when SOLDR_ZCCACHE_PRIVATE falsy", () => {
  for (const v of ["0", "false", "no", "off", "", "   ", "maybe", "2"]) {
    const msg = detectZccachePrivateOverlap({ SOLDR_ZCCACHE_PRIVATE: v });
    assert.equal(msg, null, `expected ${JSON.stringify(v)} to be a no-op`);
  }
});

test("detectZccachePrivateOverlap: returns null when SOLDR_ZCCACHE_PRIVATE unset", () => {
  assert.equal(detectZccachePrivateOverlap({}), null);
  assert.equal(detectZccachePrivateOverlap({ SOLDR_ZCCACHE_PRIVATE: undefined }), null);
});

test("missing Cargo.lock disables dependency-bearing cache plans", async () => {
  const { result } = await run({ withLockfile: false }, {
    INPUT_CACHE: "true",
    INPUT_BUILD_CACHE: "true",
    INPUT_BUILD_CACHE_MODE: "full",
    INPUT_TARGET_CACHE: "true",
    INPUT_CARGO_REGISTRY_CACHE: "true",
    INPUT_PREBUILD_DEPS: "soldr-cook",
  });
  assert.equal(result.buildCache.enabled, false);
  assert.equal(result.targetCache.enabled, false);
  assert.equal(result.cargoRegistryCache.enabled, false);
  assert.equal(result.envExports["SOLDR_BUILD_CACHE_MODE"], "off");
  assert.equal(result.envExports["SETUP_SOLDR_BUILD_CACHE_MODE"], "off");
  assert.equal(result.envExports["SOLDR_TARGET_CACHE_MODE"], "off");
  const policyJson = result.envExports["SETUP_SOLDR_CACHE_POLICY_JSON"];
  assert.ok(policyJson);
  const policy = JSON.parse(policyJson);
  assert.deepEqual(policy.layers, ["toolchain"]);
});

test("missing Cargo.lock disables Dylint output cache but retains foundation tools", async () => {
  const { result } = await run(
    { withLockfile: false },
    { INPUT_DYLINT: "true", INPUT_TOOLCHAIN: "1.94.1" },
    undefined,
    async () => ({
      channel: "nightly-2026-01-18",
      rustVersion: "1.94",
      rustcRelease: "1.94.0-nightly",
      rustcCommitHash: "1111111111111111111111111111111111111111",
    }),
  );
  assert.equal(result.dylintCache.enabled, true);
  assert.equal(result.dylintCache.outputCacheEnabled, false);
});
