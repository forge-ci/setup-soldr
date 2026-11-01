// Tests for src/lib/solo-toolchain-cache.ts.
//
// Covers the pure pieces (key shape, hash determinism, libc detect,
// staging-copy) without exercising the actual @actions/cache network
// round trip — that's validated end-to-end by the demo workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSoloCacheKeys,
  detectLibc,
  hashStringArray,
  stageDiffForSave,
  applyStagedToLiveRoots,
  soloExactHitAllowed,
  deleteCorruptSoloCacheEntries,
  saveSoloCache,
  soloCacheEntryExistsForRef,
  verifyProbeEnv,
  verifyRestoredToolchain,
  verifyRegisteredTargetPayloads,
  type RootMap,
} from "../src/lib/solo-toolchain-cache.js";
import type { SnapshotDiff, SnapshotEntry } from "../src/lib/toolchain-snapshot.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

const fixtureRustc = path.join(path.parse(process.cwd()).root, "tc", "bin", process.platform === "win32" ? "rustc.exe" : "rustc");

test("restored cache detects missing std for registered but undeclared targets", async () => {
  const calls: string[][] = [];
  const result = await verifyRegisteredTargetPayloads({
    channel: "1.95.0", log: () => {},
    runRustup: async (args) => {
      calls.push(args);
      return { code: 0, stdout: args[0] === "which" ? `${fixtureRustc}\n` : "x86_64-unknown-linux-gnu\naarch64-apple-darwin\n", stderr: "" };
    },
    readManifest: async (filename) => {
      const target = filename.split("manifest-rust-std-")[1];
      return `file:lib/rustlib/${target}/lib/libcore-abcd.rlib\nfile:lib/rustlib/${target}/lib/libstd-abcd.rlib\n`;
    },
    isFile: async (filename) => !filename.includes("aarch64-apple-darwin") || !filename.includes("libstd-"),
  });
  assert.equal(result, false);
  assert.deepEqual(calls[0], ["target", "list", "--toolchain", "1.95.0", "--installed"]);
});

test("registered target verification accepts intact payloads and fails closed on query errors", async () => {
  const base = { channel: "stable", log: () => {}, readManifest: async () => "file:lib/rustlib/x86_64-unknown-linux-gnu/lib/libcore-abcd.rlib\n", isFile: async () => true };
  const healthy = await verifyRegisteredTargetPayloads({ ...base, runRustup: async (args) => ({ code: 0, stdout: args[0] === "which" ? `${fixtureRustc}\n` : "x86_64-unknown-linux-gnu\n", stderr: "" }) });
  assert.equal(healthy, true);
  const failed = await verifyRegisteredTargetPayloads({ ...base, runRustup: async () => ({ code: 1, stdout: "", stderr: "failure" }) });
  assert.equal(failed, false);
});

test("restored toolchain verification includes undeclared registered target payloads", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "", channel: "stable", rustupCommand: "rustup", log: () => {},
    checkRegisteredTargets: true,
    runRustup: async (args) => ({ code: 0, stdout: args[0] === "which" ? `${fixtureRustc}\n` : "aarch64-apple-darwin\n", stderr: "" }),
    readTargetManifest: async () => "file:lib/rustlib/aarch64-apple-darwin/lib/libcore-abcd.rlib\n",
    targetFileExists: async () => false,
  });
  assert.equal(result.match, false);
});

test("hashStringArray is stable across input order", () => {
  assert.equal(
    hashStringArray(["rustfmt", "clippy", "rust-src"]),
    hashStringArray(["clippy", "rust-src", "rustfmt"]),
  );
});

test("hashStringArray returns 'none' for empty inputs", () => {
  assert.equal(hashStringArray([]), "none");
  assert.equal(hashStringArray(["", "  "]), "none");
});

test("verifyRestoredToolchain rejects a restored toolchain with unusable target std", async () => {
  const logs: string[] = [];
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedTargets: ["aarch64-unknown-linux-gnu"],
    channel: "stable",
    rustupCommand: "rustup",
    log: (message) => logs.push(message),
    runRustup: async () => ({ code: 1, stdout: "", stderr: "can't find target library" }),
  });
  assert.equal(result.match, false);
  assert.ok(logs.some((line) => line.includes("target std probe failed")));
});

test("verifyRestoredToolchain accepts a valid target std probe", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedTargets: ["aarch64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
    channel: "stable",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  assert.equal(result.match, true);
});

test("#473 verification pins the requested channel and rejects missing components", async () => {
  const calls: string[][] = [];
  const result = await verifyRestoredToolchain({
    expectedRelease: "1.95.0",
    expectedComponents: ["rustfmt", "clippy"],
    channel: "1.95.0",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async (args) => {
      calls.push(args);
      if (args[0] === "run") return { code: 0, stdout: "rustc 1.95.0 (abc 2026-01-01)\n", stderr: "" };
      return { code: 0, stdout: "rustfmt-x86_64-pc-windows-msvc\n", stderr: "" };
    },
  });
  assert.equal(result.match, false);
  assert.deepEqual(calls[0], ["run", "1.95.0", "rustc", "--version", "--verbose"]);
  assert.deepEqual(calls[1], ["component", "list", "--toolchain", "1.95.0", "--installed"]);
});

test("#473 verification rejects registered components with corrupt executables", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedComponents: ["rustfmt", "clippy"],
    channel: "stable",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async (args) => {
      if (args[0] === "component") {
        return { code: 0, stdout: "rustfmt-host\nclippy-host\n", stderr: "" };
      }
      if (args.includes("clippy-driver")) return { code: 1, stdout: "", stderr: "corrupt" };
      return { code: 0, stdout: "rustfmt 1.95.0\n", stderr: "" };
    },
  });
  assert.equal(result.match, false);
});

test("#473 verification accepts rustup preview aliases in installed output", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "",
    expectedComponents: ["llvm-tools-preview"],
    channel: "stable",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async () => ({
      code: 0,
      stdout: "llvm-tools-x86_64-unknown-linux-gnu\n",
      stderr: "",
    }),
  });
  assert.equal(result.match, true);
});

test("#473 failed poison deletion cannot turn save id=-1 into false repair success", async () => {
  const root = mkTmp("solo-save-id-");
  try {
    const stagingDir = path.join(root, "staged");
    fs.mkdirSync(stagingDir, { recursive: true });
    writeFile(stagingDir, "payload", "ok");
    const archive = path.join(root, "made.tar.zst");
    fs.writeFileSync(archive, "archive");
    const result = await saveSoloCache({
      stagingDir,
      key: "solo-toolchain-v3-repair",
      level: "1",
      debug: false,
      log: () => {},
      cacheArchivePath: path.join(root, "canonical.tar.zst"),
      skipExistingProbe: true,
      compress: async () => ({ archivePath: archive, archiveBytes: 7, inflatedBytes: 2, fileCount: 1, payload: null }),
      saveCache: async () => -1,
    });
    assert.equal(result.status, "failed");
  } finally {
    rmDir(root);
  }
});

test("#473 concurrent repaired writer is accepted only after an exact-key lookup", async () => {
  const root = mkTmp("solo-save-race-");
  try {
    const stagingDir = path.join(root, "staged");
    fs.mkdirSync(stagingDir, { recursive: true });
    writeFile(stagingDir, "payload", "ok");
    const archive = path.join(root, "made.tar.zst");
    fs.writeFileSync(archive, "archive");
    const key = "solo-toolchain-v3-repair";
    const result = await saveSoloCache({
      stagingDir, key, level: "1", debug: false, log: () => {},
      cacheArchivePath: path.join(root, "canonical.tar.zst"),
      skipExistingProbe: true,
      compress: async () => ({ archivePath: archive, archiveBytes: 7, inflatedBytes: 2, fileCount: 1, payload: null }),
      saveCache: async () => -1,
      lookupExactKey: async () => key,
    });
    assert.equal(result.status, "race-precheck-skipped");
  } finally {
    rmDir(root);
  }
});

test("#473 repair-race proof rejects an exact key found only on another ref", async () => {
  const key = "solo-toolchain-v3-cross-ref";
  const exists = await soloCacheEntryExistsForRef({
    owner: "zackees",
    repo: "setup-soldr",
    token: "test-token",
    key,
    ref: "refs/pull/473/merge",
    log: () => {},
    listCaches: async () => [
      { id: 1, key, ref: "refs/heads/main" },
      { id: 2, key: "other", ref: "refs/pull/473/merge" },
    ],
  });
  assert.equal(exists, false);
});

test("hashStringArray is case-insensitive and trims", () => {
  assert.equal(hashStringArray(["RustFmt", "Clippy"]), hashStringArray(["rustfmt", "  clippy  "]));
});

test("buildSoloCacheKeys produces stable exact key with all parts", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    componentsHash: "deadbeef",
    targetsHash: "cafebabe",
    soldrVersion: "0.7.28",
  });
  assert.equal(
    keys.exact,
    "solo-toolchain-v3-linux-x64-glibc-rustc1.84.1-cdeadbeef-tcafebabe-soldr0.7.28",
  );
});

test("buildSoloCacheKeys restore-key ladder drops in the documented order", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    componentsHash: "ch",
    targetsHash: "th",
    soldrVersion: "1.0.0",
  });
  // 1) drop soldr version, 2) also drop targets, 3) also drop components
  assert.deepEqual(keys.fallbacks, [
    "solo-toolchain-v3-linux-x64-glibc-rustc1.84.1-cch-tth-soldr",
    "solo-toolchain-v3-linux-x64-glibc-rustc1.84.1-cch-t-soldr",
    "solo-toolchain-v3-linux-x64-glibc-rustc1.84.1-c-t-soldr",
  ]);
});

test("buildSoloCacheKeys never drops os/arch/libc/release", () => {
  const keys = buildSoloCacheKeys({
    runnerOs: "macos",
    runnerArch: "arm64",
    libc: "darwin",
    rustcRelease: "1.83.0",
    componentsHash: "a",
    targetsHash: "b",
    soldrVersion: "0.7.28",
  });
  for (const key of [keys.exact, ...keys.fallbacks]) {
    assert.ok(key.includes("-macos-"), `missing os in ${key}`);
    assert.ok(key.includes("-arm64-"), `missing arch in ${key}`);
    assert.ok(key.includes("-darwin-"), `missing libc in ${key}`);
    assert.ok(key.includes("-rustc1.83.0-"), `missing release in ${key}`);
  }
});

test("detectLibc returns one of the documented values for this host", () => {
  const v = detectLibc();
  assert.ok(["glibc", "musl", "darwin", "msvc", "unknown"].includes(v));
});

test("stageDiffForSave + applyStagedToLiveRoots round-trip", async () => {
  const liveA = mkTmp("solo-stage-toolchains-");
  const liveB = mkTmp("solo-stage-bin-");
  const stagingDir = mkTmp("solo-stage-area-");
  const liveARestored = mkTmp("solo-restore-toolchains-");
  const liveBRestored = mkTmp("solo-restore-bin-");
  try {
    // Populate live state.
    writeFile(liveA, "1.84.0/bin/rustc", "rustc-bytes");
    writeFile(liveA, "1.84.0/lib/libstd.so", "libstd-bytes");
    writeFile(liveB, "rustfmt", "rustfmt-bytes");

    const sourceMap: RootMap = {
      "rustup-toolchains": liveA,
      "cargo-bin": liveB,
    };

    // Build a synthetic diff that pretends these are the "added" inodes.
    const added: SnapshotEntry[] = [
      { root: liveA, relpath: "1.84.0", kind: "directory", size: 0 },
      { root: liveA, relpath: "1.84.0/bin", kind: "directory", size: 0 },
      { root: liveA, relpath: "1.84.0/bin/rustc", kind: "file", size: 11 },
      { root: liveA, relpath: "1.84.0/lib", kind: "directory", size: 0 },
      { root: liveA, relpath: "1.84.0/lib/libstd.so", kind: "file", size: 12 },
      { root: liveB, relpath: "rustfmt", kind: "file", size: 13 },
    ];
    const diff: SnapshotDiff = { added, removed: [], changed: [] };

    const stageResult = await stageDiffForSave(diff, sourceMap, stagingDir);
    assert.equal(stageResult.stagedFiles, 3);
    assert.equal(stageResult.missingFiles, 0);
    assert.ok(
      fs.existsSync(path.join(stagingDir, "rustup-toolchains/1.84.0/bin/rustc")),
      "rustc not staged",
    );
    assert.ok(
      fs.existsSync(path.join(stagingDir, "cargo-bin/rustfmt")),
      "rustfmt not staged",
    );

    // Apply to a different pair of live roots (simulating restore on a
    // different runner).
    const restoreMap: RootMap = {
      "rustup-toolchains": liveARestored,
      "cargo-bin": liveBRestored,
    };
    const applied = await applyStagedToLiveRoots(stagingDir, restoreMap);
    assert.equal(applied.appliedFiles, 3);
    assert.equal(
      fs.readFileSync(path.join(liveARestored, "1.84.0/bin/rustc"), "utf8"),
      "rustc-bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(liveARestored, "1.84.0/lib/libstd.so"), "utf8"),
      "libstd-bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(liveBRestored, "rustfmt"), "utf8"),
      "rustfmt-bytes",
    );
    // Exercise the actual manifest and file reads against an incomplete
    // restored toolchain. The target remains registered even though libstd
    // is missing; restoring it is what turns this verification green.
    const target = "aarch64-apple-darwin";
    const root = path.join(liveARestored, "1.84.0");
    writeFile(root, `lib/rustlib/manifest-rust-std-${target}`,
      `file:lib/rustlib/${target}/lib/libcore-fake.rlib\nfile:lib/rustlib/${target}/lib/libstd-fake.rlib\n`);
    writeFile(root, `lib/rustlib/${target}/lib/libcore-fake.rlib`, "core");
    const verify = () => verifyRegisteredTargetPayloads({
      channel: "1.84.0", log: () => {},
      runRustup: async (args) => ({
        code: 0,
        stdout: args[0] === "which" ? `${path.join(root, "bin", process.platform === "win32" ? "rustc.exe" : "rustc")}\n` : `${target}\n`,
        stderr: "",
      }),
    });
    assert.equal(await verify(), false);
    writeFile(root, `lib/rustlib/${target}/lib/libstd-fake.rlib`, "std");
    assert.equal(await verify(), true);
  } finally {
    rmDir(liveA);
    rmDir(liveB);
    rmDir(stagingDir);
    rmDir(liveARestored);
    rmDir(liveBRestored);
  }
});

test("stageDiffForSave silently skips entries whose root isn't in the map", async () => {
  const liveA = mkTmp("solo-strange-");
  const stagingDir = mkTmp("solo-strange-stage-");
  try {
    writeFile(liveA, "file", "x");
    const sourceMap: RootMap = {
      "rustup-toolchains": "/some/other/root",
      "cargo-bin": "/another/different/root",
    };
    const diff: SnapshotDiff = {
      added: [{ root: liveA, relpath: "file", kind: "file", size: 1 }],
      removed: [],
      changed: [],
    };
    const stageResult = await stageDiffForSave(diff, sourceMap, stagingDir);
    assert.equal(stageResult.stagedFiles, 0);
    assert.equal(stageResult.missingFiles, 0);
  } finally {
    rmDir(liveA);
    rmDir(stagingDir);
  }
});

test("#473 stageDiffForSave includes files replaced during cache repair", async () => {
  const live = mkTmp("solo-repair-live-");
  const stagingDir = mkTmp("solo-repair-stage-");
  try {
    writeFile(live, "1.95.0/lib/rustlib/aarch64-unknown-linux-gnu/lib/libcore.rlib", "repaired");
    const after: SnapshotEntry = {
      root: live,
      relpath: "1.95.0/lib/rustlib/aarch64-unknown-linux-gnu/lib/libcore.rlib",
      kind: "file",
      size: 8,
    };
    const diff: SnapshotDiff = {
      added: [],
      removed: [],
      changed: [{ before: { ...after, size: 0 }, after }],
    };
    const result = await stageDiffForSave(diff, {
      "rustup-toolchains": live,
      "cargo-bin": path.join(live, "cargo-bin"),
    }, stagingDir);
    assert.equal(result.stagedFiles, 1);
    assert.equal(
      fs.readFileSync(path.join(stagingDir, "rustup-toolchains", after.relpath), "utf8"),
      "repaired",
    );
  } finally {
    rmDir(live);
    rmDir(stagingDir);
  }
});

test("#473 stageDiffForSave reports a disappearing repair file as missing", async () => {
  const live = mkTmp("solo-repair-missing-");
  const stagingDir = mkTmp("solo-repair-missing-stage-");
  try {
    const result = await stageDiffForSave({
      added: [{ root: live, relpath: "vanished.rlib", kind: "file", size: 8 }],
      removed: [],
      changed: [],
    }, {
      "rustup-toolchains": live,
      "cargo-bin": path.join(live, "cargo-bin"),
    }, stagingDir);
    assert.deepEqual(result, { stagedFiles: 0, stagedSymlinks: 0, missingFiles: 1 });
  } finally {
    rmDir(live);
    rmDir(stagingDir);
  }
});

test("#473 corrupt-cache deletion is scoped to the matched key and current ref", async () => {
  const deleted: number[] = [];
  const result = await deleteCorruptSoloCacheEntries({
    owner: "zackees",
    repo: "example",
    token: "test-token",
    key: "solo-toolchain-v3-linux-x64-bad",
    ref: "refs/heads/main",
    log: () => {},
    listCaches: async () => [
      { id: 1, key: "solo-toolchain-v3-linux-x64-bad", ref: "refs/heads/main" },
      { id: 2, key: "solo-toolchain-v3-linux-x64-bad", ref: "refs/pull/1/merge" },
      { id: 3, key: "another-key", ref: "refs/heads/main" },
    ],
    deleteCacheById: async (id) => { deleted.push(id); },
  });
  assert.deepEqual(deleted, [1]);
  assert.deepEqual(result, { found: 1, deleted: 1, failed: 0 });
});

test("restored release is checked through the verified Soldr bootstrap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore managed probe "));
  const win = process.platform === "win32";
  const fake = path.join(root, win ? "soldr.cmd" : "soldr");
  const marker = path.join(root, "arguments.txt");
  fs.writeFileSync(fake, win
    ? '@echo off\r\necho %*^|%RUSTUP_TOOLCHAIN% > "%RESTORE_PROBE_MARKER%"\r\necho rustc 1.95.0\r\n'
    : '#!/bin/sh\nprintf "%s|%s\\n" "$*" "$RUSTUP_TOOLCHAIN" > "$RESTORE_PROBE_MARKER"\necho "rustc 1.95.0"\n', { mode: 0o755 });
  const old = process.env.RESTORE_PROBE_MARKER;
  process.env.RESTORE_PROBE_MARKER = marker;
  try {
    const result = await verifyRestoredToolchain({
      expectedRelease: "1.95.0", channel: "stable", rustupCommand: "unused-rustup",
      bootstrapSoldr: fake, log: () => {},
    });
    assert.equal(result.match, true);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "--no-cache rustc --version --verbose|stable");
  } finally {
    if (old === undefined) delete process.env.RESTORE_PROBE_MARKER;
    else process.env.RESTORE_PROBE_MARKER = old;
  }
});

test("#622 probe env drops SOLDR_DYLINT_TOOLCHAIN so Dylint jobs verify the cached channel", () => {
  const env = { PATH: "/bin", SOLDR_DYLINT_TOOLCHAIN: "nightly-2026-05-28", UNSET: undefined };
  const unmanaged = verifyProbeEnv(env, null);
  assert.deepEqual(unmanaged, { PATH: "/bin" });
  const managed = verifyProbeEnv(env, "1.95.0");
  assert.equal(managed["SOLDR_DYLINT_TOOLCHAIN"], undefined);
  assert.equal(managed["RUSTUP_TOOLCHAIN"], "1.95.0");
  assert.equal(managed["SOLDR_NO_GLOBAL_DELEGATION"], "1");
  assert.equal(managed["SOLDR_BROKER_AUTOSPAWN"], "0");
  assert.equal(managed["SOLDR_AS"], "");
  assert.equal(env.SOLDR_DYLINT_TOOLCHAIN, "nightly-2026-05-28");
});

test("#636 verification reports the restored commit hash", async () => {
  const result = await verifyRestoredToolchain({
    expectedRelease: "1.95.0",
    channel: "1.95.0",
    rustupCommand: "rustup",
    log: () => {},
    runRustup: async () => ({
      code: 0,
      stdout: "rustc 1.95.0 (fedcba987 2026-08-01)\nbinary: rustc\ncommit-hash: fedcba98\nrelease: 1.95.0\n",
      stderr: "",
    }),
  });
  assert.equal(result.match, true);
  assert.equal(result.observedRelease, "1.95.0");
  assert.equal(result.observedCommit, "fedcba98");
});

// #610: cargo-bin lives in a user-owned CARGO_HOME; restore must never
// replace or redirect existing entries there.
function stageCargoBin(stagingDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(stagingDir, "cargo-bin"), rel, content);
}

test("#610 restore preserves user-owned cargo-bin executables and reports the conflict", async () => {
  const staging = mkTmp("solo-610-stage-");
  const toolchains = mkTmp("solo-610-tc-");
  const bin = mkTmp("solo-610-bin-");
  try {
    stageCargoBin(staging, { cargo: "cached-cargo", rustc: "cached-rustc", rustfmt: "cached-rustfmt" });
    writeFile(path.join(staging, "rustup-toolchains"), "1.84.0/bin/rustc", "new-toolchain-rustc");
    writeFile(toolchains, "1.84.0/bin/rustc", "stale-toolchain-rustc");
    const sentinel = writeFile(bin, "cargo", "user-custom-cargo");
    writeFile(bin, "rustfmt", "cached-rustfmt"); // identical: compatible
    const applied = await applyStagedToLiveRoots(staging, { "rustup-toolchains": toolchains, "cargo-bin": bin });
    assert.equal(fs.readFileSync(sentinel, "utf8"), "user-custom-cargo");
    assert.equal(fs.readFileSync(path.join(bin, "rustc"), "utf8"), "cached-rustc", "missing proxy is restored");
    assert.deepEqual(applied.preservedConflicts, [path.join(bin, "cargo")]);
    // The setup-managed toolchain root keeps the overwrite fast path.
    assert.equal(fs.readFileSync(path.join(toolchains, "1.84.0/bin/rustc"), "utf8"), "new-toolchain-rustc");
  } finally {
    rmDir(staging); rmDir(toolchains); rmDir(bin);
  }
});

test("#610 nested directory symlinks in cargo-bin cannot redirect restored files", async () => {
  const staging = mkTmp("solo-610-stage-");
  const toolchains = mkTmp("solo-610-tc-");
  const bin = mkTmp("solo-610-bin-");
  const outside = mkTmp("solo-610-outside-");
  try {
    stageCargoBin(staging, { "nested/tool": "cached-tool" });
    fs.symlinkSync(outside, path.join(bin, "nested"), process.platform === "win32" ? "junction" : "dir");
    const applied = await applyStagedToLiveRoots(staging, { "rustup-toolchains": toolchains, "cargo-bin": bin });
    assert.equal(fs.existsSync(path.join(outside, "tool")), false);
    assert.deepEqual(applied.preservedConflicts, [path.join(bin, "nested")]);
  } finally {
    rmDir(staging); rmDir(toolchains); rmDir(bin); rmDir(outside);
  }
});

test("#610 an existing symlinked proxy pointing elsewhere is preserved and flagged", async (t) => {
  const staging = mkTmp("solo-610-stage-");
  const toolchains = mkTmp("solo-610-tc-");
  const bin = mkTmp("solo-610-bin-");
  const outside = mkTmp("solo-610-outside-");
  try {
    stageCargoBin(staging, { rustc: "cached-rustc" });
    const target = writeFile(outside, "rustc", "unrelated-rustc");
    try {
      fs.symlinkSync(target, path.join(bin, "rustc"), "file");
    } catch {
      t.skip("file symlinks need privilege on this host");
      return;
    }
    const applied = await applyStagedToLiveRoots(staging, { "rustup-toolchains": toolchains, "cargo-bin": bin });
    assert.equal(fs.readFileSync(target, "utf8"), "unrelated-rustc");
    assert.equal(fs.lstatSync(path.join(bin, "rustc")).isSymbolicLink(), true);
    assert.deepEqual(applied.preservedConflicts, [path.join(bin, "rustc")]);
  } finally {
    rmDir(staging); rmDir(toolchains); rmDir(bin); rmDir(outside);
  }
});

test("#610 a preserved conflicting proxy can never yield a healthy exact hit", () => {
  assert.equal(soloExactHitAllowed({ matchedKey: "k", exactKey: "k", preservedConflicts: [] }), true);
  assert.equal(soloExactHitAllowed({ matchedKey: "k", exactKey: "k", preservedConflicts: ["/home/u/.cargo/bin/rustc"] }), false);
  assert.equal(soloExactHitAllowed({ matchedKey: "k-old", exactKey: "k", preservedConflicts: [] }), false);
});
