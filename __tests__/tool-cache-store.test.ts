// Tests for setup-soldr#557: on runners whose RUNNER_TOOL_CACHE outlives the
// job (act / `bosn ci`, self-hosted), a warm run must restore the managed
// Rust toolchain and soldr's stamped tool bundles (LLVM, ...) from the tool
// cache instead of re-installing them (rustup_install 14-17 s, and verify
// 9-10 s spent re-fetching LLVM, in every job of every warm run).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  decideToolCacheStore,
  linkDir,
  toolCacheStorePath,
} from "../src/lib/tool-cache-store.js";
import { adoptBundles, publishBundles } from "../src/lib/bundle-tool-cache.js";
import {
  adoptRustupStore,
  publishRustupStore,
  rustupStoreEntry,
  rustupStoreOffReason,
} from "../src/lib/rustup-tool-cache.js";

const unixOnly = { skip: process.platform === "win32" };

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const linux = "linux" as NodeJS.Platform;

test("#557 decide: act and self-hosted runners persist the tool cache", () => {
  const act = decideToolCacheStore({ env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", ACT: "true" }, platform: linux });
  assert.equal(act.enabled, true, act.reason);
  assert.equal(act.toolCache, "/opt/hostedtoolcache");
  const selfHosted = decideToolCacheStore({
    env: { RUNNER_TOOL_CACHE: "/srv/tc", RUNNER_ENVIRONMENT: "self-hosted" },
    platform: linux,
  });
  assert.equal(selfHosted.enabled, true, selfHosted.reason);
});

test("#557 decide: hosted, Windows, a missing tool cache and a layer veto stay off", () => {
  const off = (env: Record<string, string>, platform: NodeJS.Platform = linux, layerOff = ""): boolean =>
    decideToolCacheStore({ env, platform, layerOff }).enabled;
  assert.equal(off({ RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", RUNNER_ENVIRONMENT: "github-hosted" }), false);
  assert.equal(off({ RUNNER_TOOL_CACHE: "C:\\hostedtoolcache", ACT: "true" }, "win32"), false);
  assert.equal(off({ ACT: "true" }), false);
  assert.equal(off({ RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", ACT: "true" }, linux, "cross lane"), false);
});

test("#557 decide: SETUP_SOLDR_TOOL_CACHE overrides the runner default", () => {
  const on = decideToolCacheStore({
    env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", RUNNER_ENVIRONMENT: "github-hosted", SETUP_SOLDR_TOOL_CACHE: "1" },
    platform: linux,
  });
  assert.equal(on.enabled, true);
  const off = decideToolCacheStore({
    env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", ACT: "true", SETUP_SOLDR_TOOL_CACHE: "0" },
    platform: linux,
  });
  assert.equal(off.enabled, false);
});

test("#557 store paths are per layer and per platform-arch", () => {
  assert.equal(
    toolCacheStorePath("/opt/hostedtoolcache", "bundles", "linux", "x64"),
    path.join("/opt/hostedtoolcache", "soldr-bundles", "linux-x64"),
  );
});

// Mirrors soldr's `fetch_managed_llvm`: reuse `<bin>/llvm-<v>` when its
// `.complete` stamp exists, else download + extract in place + stamp.
function ensureLlvm(soldrBin: string, fetch: () => void): void {
  const install = path.join(soldrBin, "llvm-21.1.5");
  if (fs.existsSync(path.join(install, ".complete")) && fs.statSync(path.join(install, "hardlinked", "bin")).isDirectory()) {
    return;
  }
  fetch();
  fs.mkdirSync(path.join(install, "hardlinked", "bin"), { recursive: true });
  fs.writeFileSync(path.join(install, "hardlinked", "bin", "clang"), "clang");
  fs.linkSync(path.join(install, "hardlinked", "bin", "clang"), path.join(install, "hardlinked", "bin", "clang-cl"));
  fs.writeFileSync(path.join(install, ".complete"), "llvm 21.1.5");
}

test("#557 a warm run adopts LLVM published by the previous run, without fetching", unixOnly, () => {
  const store = toolCacheStorePath(mkTmp("ss557-tc-"), "bundles", process.platform, process.arch);
  let fetches = 0;
  const fetch = (): void => {
    fetches += 1;
  };

  // Run 1: empty store, fresh RUNNER_TEMP. Nothing to adopt; soldr fetches;
  // the post step publishes the stamped install.
  const bin1 = path.join(mkTmp("ss557-run1-"), "bin");
  assert.deepEqual(adoptBundles({ soldrBinDir: bin1, store }).linked, []);
  ensureLlvm(bin1, fetch);
  assert.equal(fetches, 1);
  assert.deepEqual(publishBundles({ soldrBinDir: bin1, store }).published, ["llvm-21.1.5"]);
  const published = path.join(store, "llvm-21.1.5", "hardlinked", "bin");
  assert.equal(
    fs.statSync(path.join(published, "clang")).ino,
    fs.statSync(path.join(published, "clang-cl")).ino,
    "hardlinks survive publishing (LLVM is 579 MB linked, 1.8 GB unlinked)",
  );

  // Run 2: a new container — RUNNER_TEMP is empty, the tool cache persisted.
  const bin2 = path.join(mkTmp("ss557-run2-"), "bin");
  assert.deepEqual(adoptBundles({ soldrBinDir: bin2, store }).linked, ["llvm-21.1.5"]);
  ensureLlvm(bin2, fetch);
  assert.equal(fetches, 1, "warm run must not fetch LLVM again");
  // Its post step has nothing new to publish.
  assert.deepEqual(publishBundles({ soldrBinDir: bin2, store }).published, []);
});

test("#557 bundles: unstamped installs, syslib and existing entries are never published", unixOnly, () => {
  const store = toolCacheStorePath(mkTmp("ss557-tc-"), "bundles", process.platform, process.arch);
  const bin = path.join(mkTmp("ss557-pub-"), "bin");
  fs.mkdirSync(path.join(bin, "zig-0.13.0"), { recursive: true }); // extraction interrupted: no stamp
  fs.mkdirSync(path.join(bin, "syslib", "zstd"), { recursive: true });
  fs.writeFileSync(path.join(bin, "syslib", ".complete"), "");
  fs.mkdirSync(path.join(bin, "llvm-21.1.5"), { recursive: true });
  fs.writeFileSync(path.join(bin, "llvm-21.1.5", ".complete"), "new");
  fs.mkdirSync(path.join(store, "llvm-21.1.5"), { recursive: true });
  fs.writeFileSync(path.join(store, "llvm-21.1.5", ".complete"), "old");

  const result = publishBundles({ soldrBinDir: bin, store });
  assert.deepEqual(result.published, []);
  assert.deepEqual(result.present, ["llvm-21.1.5"]);
  assert.equal(fs.readFileSync(path.join(store, "llvm-21.1.5", ".complete"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(store, "zig-0.13.0")), false);
  assert.equal(fs.existsSync(path.join(store, "syslib")), false);
  assert.deepEqual(fs.readdirSync(store).filter((n) => n.includes(".tmp-")), [], "no staging leftovers");
});

test("#557 bundles: a real install is kept and a dangling store link is dropped", unixOnly, () => {
  const store = toolCacheStorePath(mkTmp("ss557-tc-"), "bundles", process.platform, process.arch);
  fs.mkdirSync(path.join(store, "llvm-21.1.5"), { recursive: true });
  fs.writeFileSync(path.join(store, "llvm-21.1.5", ".complete"), "");
  fs.mkdirSync(path.join(store, "zig-0.13.0"), { recursive: true }); // unstamped: ignored
  const bin = path.join(mkTmp("ss557-adopt-"), "bin");
  fs.mkdirSync(path.join(bin, "llvm-21.1.5", "hardlinked"), { recursive: true }); // restored by setup-cache
  fs.symlinkSync(path.join(store, "gone-1.0"), path.join(bin, "gone-1.0"));

  const result = adoptBundles({ soldrBinDir: bin, store });
  assert.deepEqual(result.linked, []);
  assert.deepEqual(result.kept, ["llvm-21.1.5"]);
  assert.deepEqual(result.dropped, ["gone-1.0"]);
  assert.ok(fs.lstatSync(path.join(bin, "llvm-21.1.5")).isDirectory());
  assert.equal(fs.existsSync(path.join(bin, "zig-0.13.0")), false);
});

const spec = { channel: "1.95.0", profile: "minimal", components: ["rustfmt"], targets: [] as string[] };

// Mirrors ensureRustToolchain's warm check: `rustup toolchain list` reads
// RUSTUP_HOME/toolchains; a listed toolchain is not installed again.
function ensureToolchain(rustupHome: string, install: () => void): void {
  const toolchains = path.join(rustupHome, "toolchains");
  const name = "1.95.0-x86_64-unknown-linux-gnu";
  if (fs.existsSync(path.join(toolchains, name, "bin"))) return;
  install();
  fs.mkdirSync(path.join(toolchains, name, "bin"), { recursive: true });
  fs.writeFileSync(path.join(toolchains, name, "bin", "rustc"), "rustc");
  fs.mkdirSync(path.join(rustupHome, "update-hashes"), { recursive: true });
  fs.writeFileSync(path.join(rustupHome, "update-hashes", name), "hash");
  fs.writeFileSync(path.join(rustupHome, "settings.toml"), 'profile = "minimal"\n');
}

test("#557 a warm run restores the Rust toolchain from the tool cache, without installing", unixOnly, () => {
  const store = toolCacheStorePath(mkTmp("ss557-tc-"), "rustup", process.platform, process.arch);
  const entry = rustupStoreEntry(store, spec);
  let installs = 0;
  const install = (): void => {
    installs += 1;
  };

  const home1 = path.join(mkTmp("ss557-rh1-"), "rustup-home");
  fs.mkdirSync(home1, { recursive: true });
  assert.equal(adoptRustupStore({ rustupHome: home1, entry }), "miss");
  ensureToolchain(home1, install);
  assert.equal(publishRustupStore({ rustupHome: home1, entry }), "published");
  assert.ok(fs.existsSync(path.join(entry, ".complete")));
  assert.equal(fs.existsSync(path.join(entry, "settings.toml")), false, "settings.toml stays per job");

  const home2 = path.join(mkTmp("ss557-rh2-"), "rustup-home");
  fs.mkdirSync(home2, { recursive: true });
  assert.equal(adoptRustupStore({ rustupHome: home2, entry }), "adopted");
  ensureToolchain(home2, install);
  assert.equal(installs, 1, "warm run must not install the toolchain again");
  assert.equal(publishRustupStore({ rustupHome: home2, entry }), "already-present");
});

test("#557 rustup store entries are keyed by the full toolchain request", () => {
  const store = "/opt/hostedtoolcache/soldr-rustup/linux-x64";
  const base = rustupStoreEntry(store, spec);
  assert.ok(path.basename(base).startsWith("1.95.0-"));
  assert.notEqual(rustupStoreEntry(store, { ...spec, components: ["rustfmt", "clippy"] }), base);
  assert.notEqual(rustupStoreEntry(store, { ...spec, targets: ["wasm32-unknown-unknown"] }), base);
  assert.notEqual(rustupStoreEntry(store, { ...spec, profile: "default" }), base);
  assert.equal(rustupStoreEntry(store, { ...spec, components: ["rustfmt"] }), base);
});

test("#557 rustup store: off for solo-cache, non-managed homes, Dylint and rolling channels", () => {
  const managed = { strategy: "managed" as const, soloToolchainCache: false, dylint: false, channel: "1.95.0" };
  assert.equal(rustupStoreOffReason(managed), "");
  assert.equal(rustupStoreOffReason({ ...managed, channel: "nightly-2026-04-01" }), "");
  assert.notEqual(rustupStoreOffReason({ ...managed, soloToolchainCache: true }), "");
  assert.notEqual(rustupStoreOffReason({ ...managed, strategy: "system" }), "");
  assert.notEqual(rustupStoreOffReason({ ...managed, strategy: "explicit" }), "");
  assert.notEqual(rustupStoreOffReason({ ...managed, dylint: true }), "");
  assert.notEqual(rustupStoreOffReason({ ...managed, channel: "stable" }), "");
  assert.notEqual(rustupStoreOffReason({ ...managed, channel: "nightly" }), "");
});

test("#557 linkDir keeps a non-empty real dir and replaces an empty dir or stale link", unixOnly, () => {
  const root = mkTmp("ss557-link-");
  const target = path.join(root, "store");
  const full = path.join(root, "full");
  fs.mkdirSync(path.join(full, "x"), { recursive: true });
  assert.equal(linkDir({ linkPath: full, target }), "kept-existing-dir");
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  assert.equal(linkDir({ linkPath: empty, target }), "linked");
  assert.equal(linkDir({ linkPath: empty, target }), "already-linked");
  const stale = path.join(root, "stale");
  fs.symlinkSync(path.join(root, "gone"), stale);
  assert.equal(linkDir({ linkPath: stale, target }), "linked");
  assert.equal(path.resolve(root, fs.readlinkSync(stale)), target);
});

// setup-soldr#713: links into the store must be relative, so relocating the
// tree that holds both the bin dir and the store keeps them resolving, and a
// dangling link of any shape is dropped on adopt instead of failing install.
function assertRelativeAndResolving(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!fs.lstatSync(p).isSymbolicLink()) continue;
    const target = fs.readlinkSync(p);
    assert.ok(!path.isAbsolute(target), `${name} -> ${target} must be relative`);
    assert.ok(fs.existsSync(p), `${name} -> ${target} must resolve`);
  }
}

test("#713 adoptBundles links survive moving the tree that holds bin and store", unixOnly, () => {
  const root = mkTmp("ss713-");
  const before = path.join(root, "a");
  const store = toolCacheStorePath(path.join(before, "tool-cache"), "bundles", process.platform, process.arch);
  fs.mkdirSync(path.join(store, "llvm-21.1.5"), { recursive: true });
  fs.writeFileSync(path.join(store, "llvm-21.1.5", ".complete"), "");
  const bin = path.join(before, "soldr", "bin");
  assert.deepEqual(adoptBundles({ soldrBinDir: bin, store }).linked, ["llvm-21.1.5"]);
  assertRelativeAndResolving(bin);

  const moved = path.join(root, "b");
  fs.renameSync(before, moved);
  const movedBin = path.join(moved, "soldr", "bin");
  assert.ok(fs.existsSync(path.join(movedBin, "llvm-21.1.5", ".complete")), "link must still resolve after the move");
});

test("#713 adoptBundles drops a dangling absolute link from an old store path", unixOnly, () => {
  const root = mkTmp("ss713-dangle-");
  const store = toolCacheStorePath(path.join(root, "tc-new"), "bundles", process.platform, process.arch);
  fs.mkdirSync(path.join(store, "llvm-21.1.5"), { recursive: true });
  fs.writeFileSync(path.join(store, "llvm-21.1.5", ".complete"), "");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(root, "tc-old", "zig-0.13.0"), path.join(bin, "zig-0.13.0"));
  fs.symlinkSync(path.join(root, "tc-old", "llvm-21.1.5"), path.join(bin, "llvm-21.1.5"));

  const result = adoptBundles({ soldrBinDir: bin, store });
  assert.deepEqual(result.dropped, ["llvm-21.1.5", "zig-0.13.0"]);
  assert.deepEqual(result.linked, ["llvm-21.1.5"]);
  assert.equal(fs.existsSync(path.join(bin, "zig-0.13.0")), false);
  assert.equal(fs.lstatSync(path.join(bin, "zig-0.13.0"), { throwIfNoEntry: false }), undefined);
  assertRelativeAndResolving(bin);
});

test("#713 rustup store links are relative", unixOnly, () => {
  const root = mkTmp("ss713-rustup-");
  const entry = path.join(root, "tc", "soldr-rustup", "e");
  fs.mkdirSync(path.join(entry, "toolchains"), { recursive: true });
  fs.mkdirSync(path.join(entry, "update-hashes"), { recursive: true });
  fs.writeFileSync(path.join(entry, ".complete"), "");
  const home = path.join(root, "rustup-home");
  fs.mkdirSync(home);
  assert.equal(adoptRustupStore({ rustupHome: home, entry }), "adopted");
  assertRelativeAndResolving(home);
});
