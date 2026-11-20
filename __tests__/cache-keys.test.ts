import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  cargoConfigHash,
  crossToolCacheKeyFor,
  normalizeBuildCacheMode,
  normalizeLegacyTargetCacheMode,
  normalizeTargetCacheBool,
  normalizeTargetCacheCompress,
  normalizeTargetCacheCompressLevel,
  normalizeTargetCacheProfile,
  pathForOutput,
  resolveLockfilePath,
  sanitizeFragment,
  setupCacheLayout,
  setupCachePaths,
  shortFileHash,
  shortJsonHash,
  targetCacheSoftBudget,
  targetEnvHash,
  workspaceManifestHash,
} from "../src/lib/cache-keys.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("canonicalJsonStringify sorts keys recursively, compact separators", () => {
  const out = canonicalJsonStringify({ b: 1, a: { y: 2, x: [3, 1] }, c: null });
  assert.equal(out, '{"a":{"x":[3,1],"y":2},"b":1,"c":null}');
});

test("canonicalJsonStringify booleans", () => {
  assert.equal(canonicalJsonStringify({ b: false, a: true }), '{"a":true,"b":false}');
});

test("shortJsonHash matches Python sha256 first-16-hex over compact JSON", () => {
  const data = { name: "value", arr: [1, 2] };
  const compact = '{"arr":[1,2],"name":"value"}';
  const expected = createHash("sha256").update(compact, "utf8").digest("hex").slice(0, 16);
  assert.equal(shortJsonHash(data), expected);
});

test("shortJsonHash empty dict matches Python", () => {
  // Python: hashlib.sha256(b"{}").hexdigest()[:16] => "44136fa355b3678a"
  assert.equal(shortJsonHash({}), "44136fa355b3678a");
});

test("shortFileHash returns missing sentinel for absent file", async () => {
  const tmp = mkTmp("cache-keys-");
  const result = await shortFileHash(path.join(tmp, "nope"), "MISS");
  assert.equal(result, "MISS");
});

test("shortFileHash hashes file contents", async () => {
  const tmp = mkTmp("cache-keys-");
  const f = path.join(tmp, "data.txt");
  fs.writeFileSync(f, "hello", "utf8");
  const expected = createHash("sha256").update("hello").digest("hex").slice(0, 16);
  assert.equal(await shortFileHash(f, "no"), expected);
});

test("sanitizeFragment replaces invalid runs with single dash", () => {
  assert.equal(sanitizeFragment("foo/bar baz"), "foo-bar-baz");
});

test("sanitizeFragment strips leading/trailing dashes", () => {
  assert.equal(sanitizeFragment("//foo//"), "foo");
});

test("sanitizeFragment empty falls back to 'default'", () => {
  assert.equal(sanitizeFragment(""), "default");
  assert.equal(sanitizeFragment("/////"), "default");
});

test("sanitizeFragment preserves valid chars including .", () => {
  assert.equal(sanitizeFragment("1.2.3-alpha_4"), "1.2.3-alpha_4");
});

test("normalizeTargetCacheProfile defaults to thin-v1", () => {
  assert.equal(normalizeTargetCacheProfile(""), "thin-v1");
});

test("normalizeTargetCacheProfile accepts thin-v2", () => {
  assert.equal(normalizeTargetCacheProfile(" THIN-V2 "), "thin-v2");
});

test("normalizeTargetCacheProfile accepts thin-v3", () => {
  assert.equal(normalizeTargetCacheProfile(" THIN-V3 "), "thin-v3");
});

test("normalizeTargetCacheProfile rejects unknown", () => {
  assert.throws(() => normalizeTargetCacheProfile("fat"));
});

test("normalizeTargetCacheBool truthy aliases", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) {
    assert.equal(normalizeTargetCacheBool("input", v), "true", `for ${v}`);
  }
});

test("normalizeTargetCacheBool falsy aliases", () => {
  for (const v of ["false", "0", "no", "off", "FALSE", " Off "]) {
    assert.equal(normalizeTargetCacheBool("input", v), "false", `for ${v}`);
  }
});

test("normalizeTargetCacheBool empty returns null", () => {
  assert.equal(normalizeTargetCacheBool("input", ""), null);
  assert.equal(normalizeTargetCacheBool("input", "   "), null);
});

test("normalizeTargetCacheBool rejects unknown with the input name in error", () => {
  assert.throws(() => normalizeTargetCacheBool("target-cache-x", "maybe"), /invalid target-cache-x/);
});

test("normalizeLegacyTargetCacheMode hot becomes thin with deprecation log", () => {
  const logs: string[] = [];
  assert.equal(normalizeLegacyTargetCacheMode("hot", (m) => logs.push(m)), "thin");
  assert.match(logs[0] ?? "", /'hot' is deprecated/);
});

test("normalizeLegacyTargetCacheMode pass-through for thin/full/off", () => {
  assert.equal(normalizeLegacyTargetCacheMode("thin"), "thin");
  assert.equal(normalizeLegacyTargetCacheMode("full"), "full");
  assert.equal(normalizeLegacyTargetCacheMode("off"), "off");
});

test("normalizeLegacyTargetCacheMode rejects unknown", () => {
  assert.throws(() => normalizeLegacyTargetCacheMode("warm"));
});

test("normalizeBuildCacheMode defaults to 'thin' when empty + target-cache requested (#251)", () => {
  // allowLegacyTranslation=true is the "target-cache opted in without an
  // explicit build-cache-mode" signal from resolve-setup; the bounded
  // "thin" shape is the standardized default in that case.
  assert.equal(normalizeBuildCacheMode("", "", true), "thin");
});

test("normalizeBuildCacheMode defaults to 'once' when empty + target-cache off", () => {
  // When target-cache is off, the resolved mode is unused for caching but
  // is still surfaced via SETUP_SOLDR_BUILD_CACHE_MODE — keep "once" there
  // to preserve env-visible behavior for downstream tools. (#251)
  assert.equal(normalizeBuildCacheMode("", "", false), "once");
});

test("normalizeBuildCacheMode translates legacy hot -> thin", () => {
  const logs: string[] = [];
  assert.equal(normalizeBuildCacheMode("", "hot", true, (m) => logs.push(m)), "thin");
});

test("normalizeBuildCacheMode does not translate when explicit value present", () => {
  assert.equal(normalizeBuildCacheMode("once", "thin", true), "once");
});

test("normalizeBuildCacheMode rejects unknown value", () => {
  assert.throws(() => normalizeBuildCacheMode("wide", "", true));
});

test("normalizeTargetCacheCompress defaults to zstd", () => {
  assert.equal(normalizeTargetCacheCompress(""), "zstd");
});

test("normalizeTargetCacheCompress accepts auto/zstd/none case-insensitive", () => {
  assert.equal(normalizeTargetCacheCompress(" AUTO "), "auto");
  assert.equal(normalizeTargetCacheCompress("ZSTD"), "zstd");
  assert.equal(normalizeTargetCacheCompress("none"), "none");
});

test("normalizeTargetCacheCompress rejects unknown", () => {
  assert.throws(() => normalizeTargetCacheCompress("lz4"), /invalid target-cache-compress/);
});

test("normalizeTargetCacheCompressLevel defaults to 3", () => {
  assert.equal(normalizeTargetCacheCompressLevel(""), "3");
});

test("normalizeTargetCacheCompressLevel passes valid range, drops + sign", () => {
  assert.equal(normalizeTargetCacheCompressLevel("1"), "1");
  assert.equal(normalizeTargetCacheCompressLevel("9"), "9");
  assert.equal(normalizeTargetCacheCompressLevel("22"), "22");
});

test("normalizeTargetCacheCompressLevel rejects non-integer", () => {
  assert.throws(() => normalizeTargetCacheCompressLevel("fast"));
});

test("normalizeTargetCacheCompressLevel rejects out of range", () => {
  for (const v of ["0", "23", "-1", "100"]) {
    assert.throws(() => normalizeTargetCacheCompressLevel(v), `for ${v}`);
  }
});

test("targetCacheSoftBudget returns empties when disabled", () => {
  assert.deepEqual(targetCacheSoftBudget(false, "once"), ["", ""]);
});

test("targetCacheSoftBudget returns mode-specific budgets", () => {
  assert.deepEqual(targetCacheSoftBudget(true, "once"), ["1073741824", "8000"]);
  assert.deepEqual(targetCacheSoftBudget(true, "thin"), ["536870912", "4000"]);
  assert.deepEqual(targetCacheSoftBudget(true, "full"), ["2147483648", "12000"]);
});

test("workspaceManifestHash returns no-manifest for empty workspace", async () => {
  const tmp = mkTmp("ws-");
  assert.equal(await workspaceManifestHash(tmp), "no-manifest");
});

test("workspaceManifestHash hashes a single Cargo.toml", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "[package]\nname = 'x'\n", "utf8");
  const h1 = await workspaceManifestHash(tmp);
  assert.match(h1, /^[0-9a-f]{16}$/);
  // identical run = identical hash
  assert.equal(await workspaceManifestHash(tmp), h1);
});

test("workspaceManifestHash changes when manifest content changes", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "v1", "utf8");
  const a = await workspaceManifestHash(tmp);
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "v2", "utf8");
  const b = await workspaceManifestHash(tmp);
  assert.notEqual(a, b);
});

test("workspaceManifestHash ignores repository and generated trees", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "root", "utf8");
  const before = await workspaceManifestHash(tmp);
  for (const ignored of [".git", "target", ".soldr", "node_modules", "_vender"]) {
    fs.mkdirSync(path.join(tmp, ignored), { recursive: true });
    fs.writeFileSync(path.join(tmp, ignored, "Cargo.toml"), "ignored", "utf8");
  }
  assert.equal(await workspaceManifestHash(tmp), before);
});

test("workspaceManifestHash includes nested non-ignored manifests", async () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.toml"), "root", "utf8");
  fs.mkdirSync(path.join(tmp, "crates", "sub"), { recursive: true });
  const before = await workspaceManifestHash(tmp);
  fs.writeFileSync(path.join(tmp, "crates", "sub", "Cargo.toml"), "sub", "utf8");
  const after = await workspaceManifestHash(tmp);
  assert.notEqual(before, after);
});

test("cargoConfigHash returns no-config when neither config file exists", async () => {
  const tmp = mkTmp("ws-");
  assert.equal(await cargoConfigHash(tmp), "no-config");
});

test("cargoConfigHash hashes .cargo/config.toml when present", async () => {
  const tmp = mkTmp("ws-");
  fs.mkdirSync(path.join(tmp, ".cargo"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".cargo", "config.toml"), "[net]\n", "utf8");
  const h = await cargoConfigHash(tmp);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("targetEnvHash deterministic across irrelevant env", () => {
  const a = targetEnvHash({ FOO: "bar", RUSTFLAGS: "-C debuginfo=0" });
  const b = targetEnvHash({ RUSTFLAGS: "-C debuginfo=0", OTHER: "x" });
  assert.equal(a, b);
});

test("targetEnvHash includes CARGO_TARGET_<triple>_RUSTFLAGS", () => {
  const a = targetEnvHash({});
  const b = targetEnvHash({ CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-O" });
  assert.notEqual(a, b);
});

test("resolveLockfilePath prefers explicit relative input", () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "custom.lock"), "x", "utf8");
  const resolved = resolveLockfilePath(tmp, path.join(tmp, "target"), "custom.lock");
  assert.equal(resolved, path.resolve(path.join(tmp, "custom.lock")));
});

test("resolveLockfilePath falls back to workspace Cargo.lock", () => {
  const tmp = mkTmp("ws-");
  fs.writeFileSync(path.join(tmp, "Cargo.lock"), "x", "utf8");
  const resolved = resolveLockfilePath(tmp, path.join(tmp, "target"), "");
  assert.equal(resolved, path.resolve(path.join(tmp, "Cargo.lock")));
});

test("setupCachePaths includes rustup files when rustupHome inside setupCachePath", () => {
  const setupCachePath = "/tmp/setup-soldr";
  const out = setupCachePaths(
    setupCachePath,
    "/tmp/setup-soldr/bin",
    "/tmp/setup-soldr-soldr/bin",
    "/tmp/setup-soldr/rustup-home",
  );
  const lines = out.split("\n");
  assert.ok(lines.some((l) => l.endsWith("settings.toml")));
  assert.ok(lines.some((l) => l.endsWith("toolchains")));
  assert.ok(lines.some((l) => l.endsWith("update-hashes")));
});

test(
  "setupCachePaths still caches update-hashes when rustupHome is the system layout (setup-soldr#102)",
  () => {
    // System rustup case: toolchains/ + settings.toml stay excluded (the
    // runner image already owns those), but update-hashes/ is tiny and the
    // latency win is large, so it must always be in the cached path list.
    const out = setupCachePaths(
      "/tmp/setup-soldr",
      "/tmp/setup-soldr/bin",
      "/tmp/setup-soldr-soldr/bin",
      "/home/runner/.rustup",
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.ok(
      lines.some((l) => l.endsWith("update-hashes")),
      `expected update-hashes in ${lines.join(", ")}`,
    );
    // The toolchains/ + settings.toml entries are the gated ones — they
    // must NOT leak into the system-rustup layout.
    assert.ok(!lines.some((l) => l.endsWith("toolchains")));
    assert.ok(!lines.some((l) => l.endsWith("settings.toml")));
  },
);

test("setupCacheLayout reports bin+soldr-bin when rustup outside", () => {
  assert.equal(setupCacheLayout("/tmp/sc", "/home/r/.rustup"), "bin+soldr-bin");
});

test("setupCacheLayout reports bin+soldr-bin+rustup when rustup inside", () => {
  assert.equal(setupCacheLayout("/tmp/sc", "/tmp/sc/rustup-home"), "bin+soldr-bin+rustup");
});

test("pathForOutput returns workspace-relative path when inside workspace", () => {
  const ws = path.resolve(os.tmpdir(), "ws");
  fs.mkdirSync(ws, { recursive: true });
  const inside = path.join(ws, "Cargo.lock");
  assert.equal(pathForOutput(ws, inside), "Cargo.lock");
});

test("pathForOutput returns absolute path when outside workspace", () => {
  const outside = path.resolve("/tmp/somewhere-else");
  assert.equal(pathForOutput(path.resolve("/tmp/ws"), outside), outside);
});

test("pathForOutput returns empty string when null", () => {
  assert.equal(pathForOutput("/ws", null), "");
});

// --------------------- crossToolCacheKeyFor (setup-soldr#106) ---------------------
//
// Per-(host × target) tool cache slot — one tiny cache per cross-compile lane.
// Issue zackees/setup-soldr#106 / Wave 2.1 of zackees/soldr#514.
//
// Key shape (must be byte-stable across runs of the same lane):
//   tool-${host}-${target}-${toolset-versions}-soldr${soldrVer}
//
// MUST be distinct from the existing setup-cache / build-cache / target-cache /
// cargo-registry cache keys: the `tool-` prefix is the namespace guard.

test("crossToolCacheKeyFor: stable shape for linux -> windows-gnu lane (zigbuild + zig)", () => {
  const key = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  // The key must:
  //   - start with the `tool-` namespace prefix
  //   - embed host + target verbatim (sanitized)
  //   - end with the soldr version (so a key-tail scan can identify the
  //     soldr release the slot was built against)
  //   - be reproducible across calls
  assert.match(key, /^tool-/);
  assert.match(key, /linux-x64/);
  assert.match(key, /x86_64-pc-windows-gnu/);
  assert.match(key, /soldr0\.7\.33$/);
});

test("crossToolCacheKeyFor: deterministic — same input yields byte-identical output", () => {
  const a = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const b = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  assert.equal(a, b);
});

test("crossToolCacheKeyFor: host change invalidates", () => {
  const linux = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const macos = crossToolCacheKeyFor({
    host: "macos-arm64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  assert.notEqual(linux, macos);
});

test("crossToolCacheKeyFor: target change invalidates", () => {
  const gnuKey = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const muslKey = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  assert.notEqual(gnuKey, muslKey);
});

test("crossToolCacheKeyFor: tool version change invalidates only the affected lane", () => {
  const a = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const b = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.21.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  assert.notEqual(a, b);
});

test("crossToolCacheKeyFor: soldrVer change invalidates", () => {
  const a = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const b = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.8.0",
  });
  assert.notEqual(a, b);
});

test("crossToolCacheKeyFor: tool version order is irrelevant — keys are canonical", () => {
  // Keys must be canonical w.r.t. the toolVersions map order so two callers
  // that pass {zig, zigbuild} vs {zigbuild, zig} produce the same key.
  const a = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const b = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { ziglang: "0.13.0", "cargo-zigbuild": "0.20.0" },
    soldrVer: "0.7.33",
  });
  assert.equal(a, b);
});

test("crossToolCacheKeyFor: omits irrelevant tools — sparse spec is the source of truth", () => {
  // A linux -> musl lane has no xwin — it must be possible to express this by
  // simply omitting the key from toolVersions. The resulting key must be
  // distinct from one that includes a placeholder xwin entry.
  const sparse = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0" },
    soldrVer: "0.7.33",
  });
  const withXwin = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0", ziglang: "0.13.0", "cargo-xwin": "0.18.0" },
    soldrVer: "0.7.33",
  });
  assert.notEqual(sparse, withXwin);
});

test("crossToolCacheKeyFor: starts with `tool-` namespace prefix (collision guard)", () => {
  // The `tool-` prefix is what keeps this layer distinct from setup-cache
  // (`setup-soldr-v*-`), build-cache (`setup-soldr-buildcache-v*-`),
  // target-cache (`setup-soldr-targetcache-*-v*-`), cargo-registry
  // (`setup-soldr-cargoregistry-v*-`), and soldr-mini (`soldr-mini-`).
  const key = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0" },
    soldrVer: "0.7.33",
  });
  assert.ok(key.startsWith("tool-"), `expected key to start with 'tool-', got: ${key}`);
  // Must NOT collide with any of the other cache namespaces.
  assert.ok(!key.startsWith("setup-soldr-"), `must not overlap setup/build/target cache keys`);
  assert.ok(!key.startsWith("soldr-mini"), `must not overlap soldr-mini cache keys`);
});

test("crossToolCacheKeyFor: handles unresolved / empty soldr version gracefully", () => {
  // If we don't have a resolved soldr version yet, the key must still be
  // well-formed (no `undefined` literals leaking into the cache namespace).
  const key = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-musl",
    toolVersions: { "cargo-zigbuild": "0.20.0" },
    soldrVer: "",
  });
  assert.ok(key.length > 0);
  assert.doesNotMatch(key, /undefined/);
  assert.doesNotMatch(key, /\bnull\b/);
});

test("crossToolCacheKeyFor: empty toolVersions still produces a stable key (rust-std-only lane)", () => {
  // Native lanes (e.g. linux -> linux-gnu) have no extra tool installs — just
  // `rustup target add`. The key still needs to be derivable so the cache
  // layer can opt into a no-op slot per lane.
  const key = crossToolCacheKeyFor({
    host: "linux-x64",
    target: "x86_64-unknown-linux-gnu",
    toolVersions: {},
    soldrVer: "0.7.33",
  });
  assert.ok(key.startsWith("tool-"));
  assert.match(key, /linux-x64/);
  assert.match(key, /x86_64-unknown-linux-gnu/);
});

test("crossToolCacheKeyFor: sanitizes host/target fragments (no path separators or whitespace leak in)", () => {
  // host/target can come from runner.os + arch + user-typed triple — must be
  // sanitized so a malicious or careless input can't produce a key like
  // `tool-linux/x64-...-foo` that breaks actions/cache.
  const key = crossToolCacheKeyFor({
    host: "linux x64",
    target: "x86_64-pc-windows-gnu",
    toolVersions: { "cargo-zigbuild": "0.20.0" },
    soldrVer: "0.7.33",
  });
  assert.ok(!key.includes(" "), `key must not contain whitespace: ${key}`);
  assert.ok(!key.includes("/"), `key must not contain path separators: ${key}`);
});

// ---------------------------------------------------------------------------
// setup-soldr#682 — build-cache generations. The exact key is commit-free, so
// an exact hit used to freeze the first writer's zccache store forever. A warm
// run that still compiled saves `<exact>-g<run_id>[-<attempt>]`, and restore
// asks for `<exact>-g` first so the newest generation beats the bare key.
// ---------------------------------------------------------------------------

const GEN_EXACT = "setup-soldr-buildcache-v3-linux-x64-0427cc69b060d1bd-dylint-unified-v2-514fdd037a76e524-s57d57d7814452b77";

test("#682 generation prefix and key shape", async () => {
  const { buildCacheGenerationPrefix, buildCacheGenerationKey } = await import("../src/lib/cache-keys.js");
  assert.equal(buildCacheGenerationPrefix(GEN_EXACT), `${GEN_EXACT}-g`);
  assert.equal(buildCacheGenerationKey(GEN_EXACT, "44501733207", "1"), `${GEN_EXACT}-g44501733207`);
  assert.equal(buildCacheGenerationKey(GEN_EXACT, "44501733207", ""), `${GEN_EXACT}-g44501733207`);
  assert.equal(buildCacheGenerationKey(GEN_EXACT, "44501733207", "3"), `${GEN_EXACT}-g44501733207-3`);
  // No run id (local runner, act): there is no generation to write.
  assert.equal(buildCacheGenerationKey(GEN_EXACT, "", "1"), null);
  assert.equal(buildCacheGenerationKey(GEN_EXACT, "not-a-run", "1"), null);
});

test("#682 generation and warm-match recognition", async () => {
  const { isBuildCacheGenerationOf, isWarmBuildCacheMatch } = await import("../src/lib/cache-keys.js");
  assert.equal(isBuildCacheGenerationOf(`${GEN_EXACT}-g123`, GEN_EXACT), true);
  assert.equal(isBuildCacheGenerationOf(`${GEN_EXACT}-g123-2`, GEN_EXACT), true);
  assert.equal(isBuildCacheGenerationOf(GEN_EXACT, GEN_EXACT), false);
  assert.equal(isBuildCacheGenerationOf(`${GEN_EXACT}-g`, GEN_EXACT), false);
  assert.equal(isBuildCacheGenerationOf(`${GEN_EXACT}-gabc`, GEN_EXACT), false);
  assert.equal(isBuildCacheGenerationOf(`${GEN_EXACT}-extra-g123`, GEN_EXACT), false);
  assert.equal(isBuildCacheGenerationOf("", GEN_EXACT), false);
  assert.equal(isWarmBuildCacheMatch(GEN_EXACT, GEN_EXACT), true);
  assert.equal(isWarmBuildCacheMatch(`${GEN_EXACT}-g9`, GEN_EXACT), true);
  // A lockfile-prefix fallback is a donor, not warm.
  assert.equal(isWarmBuildCacheMatch(GEN_EXACT.replace("514fdd037a76e524", "0000000000000000"), GEN_EXACT), false);
  assert.equal(isWarmBuildCacheMatch("", GEN_EXACT), false);
});

test("#682 restore asks for the newest generation before the bare exact key", async () => {
  const { buildCacheRestoreRequest } = await import("../src/lib/cache-keys.js");
  const jobPrefix = "setup-soldr-buildcache-v3-linux-x64-0427cc69b060d1bd-dylint-unified-v2-";
  const req = buildCacheRestoreRequest(GEN_EXACT, [jobPrefix]);
  // The primary key never exists literally, so GitHub prefix-matches it and
  // returns the newest generation; the bare key and the job fallback follow.
  assert.equal(req.primaryKey, `${GEN_EXACT}-g`);
  assert.deepEqual(req.restoreKeys, [GEN_EXACT, jobPrefix]);
  assert.deepEqual(buildCacheRestoreRequest(GEN_EXACT, []).restoreKeys, [GEN_EXACT]);
});
