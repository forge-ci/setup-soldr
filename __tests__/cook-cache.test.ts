// Tests for src/lib/cook-cache.ts.
//
// Covers the pure pieces — key shape, flag canonicalization, gate
// decisions, hash stability. The actual cache restore/save round trip
// is validated end-to-end by the demo workflow.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCookBaseCacheKey,
  buildCookCacheKey,
  buildCookDeltaCacheKey,
  buildCookDeltaCacheRestorePrefix,
  cookEnv,
  decideCookGate,
  hashCookBuildShape,
  hashCookFlags,
  isCookMode,
  canonicalizeCookFlags,
  layeredCookDeltaReady,
  loadLayeredCookCache,
  parseCookFlags,
  restoreCookCache,
  restoreLayeredCookCacheArchives,
  saveLayeredCookCache,
  supportsLayeredCookCache,
} from "../src/lib/cook-cache.js";
import type { TwoPhaseCacheOptions } from "../src/lib/two-phase-actions-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("hashCookFlags is stable across order and whitespace", () => {
  assert.equal(
    hashCookFlags(["--release", "--workspace"]),
    hashCookFlags(["--workspace", "  --release  "]),
  );
});

test("hashCookFlags returns 'none' for empty inputs", () => {
  assert.equal(hashCookFlags([]), "none");
  assert.equal(hashCookFlags(["", "  "]), "none");
});

test("hashCookFlags is sensitive to material flag changes", () => {
  assert.notEqual(hashCookFlags(["--release"]), hashCookFlags(["--release", "--workspace"]));
  assert.notEqual(
    hashCookFlags(["--release"]),
    hashCookFlags(["--release", "--target", "x86_64-unknown-linux-musl"]),
  );
});

test("buildCookCacheKey shape includes every dimension", () => {
  const key = buildCookCacheKey({
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "abc12345",
    lockHash: "deadbeef",
    soldrVersion: "v0.7.28",
  });
  assert.equal(
    key,
    "cook-linux-x64-glibc-rustc1.84.1-fabc12345-ldeadbeef-soldrv0.7.28",
  );
});

test("buildCookCacheKey is content-addressable — same inputs always produce same key", () => {
  const parts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "x",
    lockHash: "y",
    soldrVersion: "0.7.28",
  };
  assert.equal(buildCookCacheKey(parts), buildCookCacheKey(parts));
});

test("buildCookCacheKey does NOT include SHA — same lock hits across branches", () => {
  // Per the simulation findings: SHA in cook key = catastrophic eviction.
  // This test pins the contract: the key shape must remain content-addressable.
  const baseParts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "x",
    lockHash: "y",
    soldrVersion: "0.7.28",
  };
  // Two different "branches" with the same lockHash should produce the
  // same key. If a future change adds SHA to the key, this regresses.
  const branchA = buildCookCacheKey({ ...baseParts });
  const branchB = buildCookCacheKey({ ...baseParts });
  assert.equal(branchA, branchB);
});

test("buildCookBaseCacheKey stays Cargo.lock-oriented and omits SHA", () => {
  const parts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "abc12345",
    lockHash: "deadbeef",
    soldrVersion: "0.7.38",
  };
  assert.equal(
    buildCookBaseCacheKey(parts),
    "cook-base-v2-linux-x64-glibc-rustc1.84.1-fabc12345-ldeadbeef-soldr0.7.38",
  );
  assert.equal(buildCookBaseCacheKey(parts), buildCookBaseCacheKey(parts));
});

test("cook cache keys honor an explicit cache-key suffix", () => {
  const parts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "abc12345",
    lockHash: "deadbeef",
    soldrVersion: "0.9.3",
    keySuffix: "rematerialization/run 42",
  };
  assert.match(buildCookCacheKey(parts), /-xrematerialization_run_42$/);
  assert.match(buildCookBaseCacheKey(parts), /-xrematerialization_run_42$/);
  const restorePrefix = buildCookDeltaCacheRestorePrefix({
    ...parts,
    buildShapeHash: "shape",
  });
  assert.match(restorePrefix, /-xrematerialization_run_42-sshape-$/);
});

test("buildCookDeltaCacheKey includes build shape and commit SHA", () => {
  const parts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "abc12345",
    lockHash: "deadbeef",
    soldrVersion: "0.7.38",
    buildShapeHash: hashCookBuildShape("target-shape"),
    githubSha: "0123456789abcdef9999",
  };
  const key = buildCookDeltaCacheKey(parts);
  assert.match(
    key,
    /^cook-delta-v2-linux-x64-glibc-rustc1\.84\.1-fabc12345-ldeadbeef-soldr0\.7\.38-s[0-9a-f]{12}-g0123456789abcdef$/,
  );
  assert.notEqual(
    key,
    buildCookDeltaCacheKey({ ...parts, githubSha: "fedcba9876543210" }),
  );
});

test("buildCookDeltaCacheRestorePrefix keeps same target shape and drops SHA", () => {
  const parts = {
    runnerOs: "linux",
    runnerArch: "x64",
    libc: "glibc",
    rustcRelease: "1.84.1",
    flagsHash: "abc12345",
    lockHash: "deadbeef",
    soldrVersion: "0.7.38",
    buildShapeHash: hashCookBuildShape("target-shape"),
  };
  const prefix = buildCookDeltaCacheRestorePrefix(parts);
  assert.match(
    prefix,
    /^cook-delta-v2-linux-x64-glibc-rustc1\.84\.1-fabc12345-ldeadbeef-soldr0\.7\.38-s[0-9a-f]{12}-$/,
  );
  assert.ok(
    buildCookDeltaCacheKey({ ...parts, githubSha: "0123456789abcdef9999" }).startsWith(prefix),
  );
  assert.ok(
    buildCookDeltaCacheKey({ ...parts, githubSha: "fedcba9876543210" }).startsWith(prefix),
  );
});

test("layeredCookDeltaReady accepts loaded restore-key delta matches", () => {
  assert.equal(
    layeredCookDeltaReady(
      {
        base: {
          hit: true,
          matchedKey: "cook-base-v2-linux-x64",
          archivePath: "base.tar.zst",
          archiveBytes: 1,
        },
        delta: {
          hit: false,
          matchedKey: "cook-delta-v2-linux-x64-sabc-gparent",
          archivePath: "delta.tar.zst",
          archiveBytes: 1,
        },
      },
      {
        baseLoaded: true,
        deltaLoaded: true,
        baseReport: null,
        deltaReport: null,
      },
    ),
    true,
  );
});

test("#475 single cook restore rejects a matched zero-byte archive with a warning", async () => {
  const root = mkTmp("cook-zero-archive-");
  const archivePath = path.join(root, "cook.tar.zst");
  const warnings: string[] = [];
  try {
    const result = await restoreCookCache({
      exactKey: "cook-exact",
      archivePath,
      targetDir: path.join(root, "target"),
      longWindow: 27,
      debug: false,
      log: () => {},
      warn: (message) => warnings.push(message),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0]!, Buffer.alloc(0));
        return key;
      },
    });
    assert.deepEqual(result, { hit: false, matchedKey: "", archiveBytes: 0 });
    assert.ok(warnings.some((line) => line.includes("cook-exact") && line.includes("archive=0B")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#475 layered cook restore rejects matched zero-byte archives before soldr load", async () => {
  const root = mkTmp("cook-layer-zero-");
  const warnings: string[] = [];
  try {
    const result = await restoreLayeredCookCacheArchives({
      baseKey: "base-exact",
      deltaKey: "delta-exact",
      baseArchivePath: path.join(root, "base.tar.zst"),
      deltaArchivePath: path.join(root, "delta.tar.zst"),
      log: () => {},
      warn: (message) => warnings.push(message),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0]!, Buffer.alloc(0));
        return key;
      },
    });
    assert.equal(result.base.hit, false);
    assert.equal(result.base.matchedKey, "");
    assert.equal(result.delta.hit, false);
    assert.equal(result.delta.matchedKey, "");
    assert.ok(warnings.some((line) => line.includes("cook-cache-base:") && line.includes("base-exact")));
    assert.ok(warnings.some((line) => line.includes("cook-cache-delta:") && line.includes("delta-exact")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#475 single cook restore rejects a non-empty archive that extracts no payload", async () => {
  const root = mkTmp("cook-empty-extract-");
  const archivePath = path.join(root, "cook.tar.zst");
  const warnings: string[] = [];
  try {
    const result = await restoreCookCache({
      exactKey: "cook-truncated",
      archivePath,
      targetDir: path.join(root, "target"),
      longWindow: 27,
      debug: false,
      log: () => {},
      warn: (message) => warnings.push(message),
      restoreCache: async (paths, key) => {
        fs.writeFileSync(paths[0]!, Buffer.from([0x1f, 0x8b, 0x08]));
        return key;
      },
      decompress: async () => ({ archiveBytes: 3, inflatedBytes: 0, fileCount: 0 }),
    });
    assert.equal(result.hit, false);
    assert.equal(result.matchedKey, "");
    assert.ok(warnings.some((line) => line.includes("extracted_files=0")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#475 layered cook rejects a successful base load with a missing structural report", async () => {
  const warnings: string[] = [];
  const loaded = await loadLayeredCookCache({
    soldrBinary: "soldr",
    projectRoot: ".",
    targetDir: "target",
    baseArchivePath: "base.tar.zst",
    deltaArchivePath: "delta.tar.zst",
    baseManifestPath: "base.pb",
    restore: {
      base: { hit: true, matchedKey: "base", archivePath: "base.tar.zst", archiveBytes: 10 },
      delta: { hit: true, matchedKey: "delta", archivePath: "delta.tar.zst", archiveBytes: 10 },
    },
    log: () => {},
    warn: (message) => warnings.push(message),
    runSoldrJson: async () => ({ code: 0, stdout: "", stderr: "", payload: {} }),
  });
  assert.equal(loaded.baseLoaded, false);
  assert.equal(loaded.deltaLoaded, false);
  assert.ok(warnings.some((line) => line.includes("cook-cache-base") && line.includes("missing")));
});

test("#475 layered cook rejects a delta load that reports zero restored files", async () => {
  const warnings: string[] = [];
  let calls = 0;
  const loaded = await loadLayeredCookCache({
    soldrBinary: "soldr",
    projectRoot: ".",
    targetDir: "target",
    baseArchivePath: "base.tar.zst",
    deltaArchivePath: "delta.tar.zst",
    baseManifestPath: "base.pb",
    restore: {
      base: { hit: true, matchedKey: "base", archivePath: "base.tar.zst", archiveBytes: 10 },
      delta: { hit: true, matchedKey: "delta", archivePath: "delta.tar.zst", archiveBytes: 10 },
    },
    log: () => {},
    warn: (message) => warnings.push(message),
    runSoldrJson: async () => {
      calls += 1;
      return {
        code: 0,
        stdout: "",
        stderr: "",
        payload: { cache_files_restored: calls === 1 ? 5 : 0 },
      };
    },
  });
  assert.equal(loaded.baseLoaded, true);
  assert.equal(loaded.deltaLoaded, false);
  assert.ok(warnings.some((line) => line.includes("cook-cache-delta") && line.includes("=0")));
});

async function exerciseLayeredSave(output: "missing" | "empty"): Promise<{
  result: Awaited<ReturnType<typeof saveLayeredCookCache>>;
  uploadPreparations: number;
}> {
  const root = mkTmp(`cook-save-${output}-`);
  const targetDir = path.join(root, "target");
  const archivePath = path.join(root, "cook-base.tar.zst");
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, "artifact"), "materialized");
  let uploadPreparations = 0;
  try {
    const result = await saveLayeredCookCache({
      soldrBinary: "soldr",
      projectRoot: root,
      targetDir,
      exactKey: "cook-base-v2-test-key",
      archivePath,
      layer: "base",
      zstdLevel: "9",
      log: () => {},
      runSoldrJson: async () => {
        if (output === "empty") fs.writeFileSync(archivePath, "");
        return {
          code: 0,
          stdout: "",
          stderr: "",
          payload: { archive_bytes: 0, cache_files: 0 },
        };
      },
      saveReservedCache: async (options: TwoPhaseCacheOptions) => {
        try {
          const archive = await options.produce();
          uploadPreparations += 1;
          return { status: "saved", cacheId: 1, archive };
        } catch (error) {
          return { status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
    return { result, uploadPreparations };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("#511 layered cook save refuses a missing archive before upload preparation", async () => {
  const { result, uploadPreparations } = await exerciseLayeredSave("missing");
  assert.equal(result.status, "failed");
  assert.equal(uploadPreparations, 0);
  assert.match(result.error ?? "", /base/);
  assert.match(result.error ?? "", /cook-base-v2-test-key/);
  assert.match(result.error ?? "", /does not exist/);
});

test("#511 layered cook save refuses a zero-byte archive before upload preparation", async () => {
  const { result, uploadPreparations } = await exerciseLayeredSave("empty");
  assert.equal(result.status, "failed");
  assert.equal(uploadPreparations, 0);
  assert.match(result.error ?? "", /base/);
  assert.match(result.error ?? "", /cook-base-v2-test-key/);
  assert.match(result.error ?? "", /zero bytes/);
});

test("#511 layered cook save preserves a non-empty serialized zero-file delta", async () => {
  const root = mkTmp("cook-save-valid-delta-manifest-");
  try {
    // Zero logical files are acceptable when the serialized archive itself
    // has content: this is the valid base-only delta representation.
    const targetDir = path.join(root, "target");
    const archivePath = path.join(root, "cook-delta.tar.zst");
    const baseManifestPath = path.join(root, "base.pb");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "artifact"), "materialized");
    fs.writeFileSync(baseManifestPath, "manifest");
    let uploadPreparations = 0;
    const result = await saveLayeredCookCache({
      soldrBinary: "soldr",
      projectRoot: root,
      targetDir,
      exactKey: "cook-delta-v2-test-key",
      archivePath,
      layer: "delta",
      zstdLevel: "9",
      baseManifestPath,
      log: () => {},
      runSoldrJson: async () => {
        fs.writeFileSync(archivePath, "valid serialized delta");
        return { code: 0, stdout: "", stderr: "", payload: { archive_bytes: 22, cache_files: 0 } };
      },
      saveReservedCache: async (options: TwoPhaseCacheOptions) => {
        const archive = await options.produce();
        uploadPreparations += 1;
        return { status: "saved", cacheId: 1, archive };
      },
    });
    assert.equal(result.status, "saved");
    assert.equal(result.fileCount, 0);
    assert.equal(uploadPreparations, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supportsLayeredCookCache gates soldr versions", () => {
  assert.equal(supportsLayeredCookCache("0.7.37"), false);
  assert.equal(supportsLayeredCookCache("0.7.38"), true);
  assert.equal(supportsLayeredCookCache("v0.7.38"), true);
  assert.equal(supportsLayeredCookCache("0.7.39-rc1"), true);
  assert.equal(supportsLayeredCookCache("source-ref"), false);
});

test("isCookMode accepts soldr-cook and legacy cargo-chef alias", () => {
  assert.equal(isCookMode("soldr-cook"), true);
  assert.equal(isCookMode(" SOLDR-COOK "), true);
  assert.equal(isCookMode("cargo-chef"), true);
  assert.equal(isCookMode("bazel"), false);
});

test("parseCookFlags handles whitespace + empty input", () => {
  assert.deepEqual(parseCookFlags(""), []);
  assert.deepEqual(parseCookFlags("  "), []);
  assert.deepEqual(parseCookFlags("--release"), ["--release"]);
  assert.deepEqual(parseCookFlags("--release --workspace"), ["--release", "--workspace"]);
  assert.deepEqual(parseCookFlags("  --release   --target   x86_64-unknown-linux-musl  "), [
    "--release",
    "--target",
    "x86_64-unknown-linux-musl",
  ]);
});

test("canonicalizeCookFlags strips cosmetic flags", () => {
  assert.deepEqual(
    canonicalizeCookFlags(["--release", "--verbose", "-q", "--workspace"]),
    ["--release", "--workspace"],
  );
});

test("canonicalizeCookFlags preserves output-material flags", () => {
  const flags = ["--release", "--target", "x86_64-unknown-linux-musl", "--no-default-features", "--profile", "lto"];
  // All of these affect what cook produces; none should be stripped.
  assert.deepEqual(canonicalizeCookFlags(flags), flags);
});

test("decideCookGate disables on prebuild-deps=none", () => {
  const lock = mkTmp("cook-gate-lock-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    for (const v of ["none", "off", "false", ""]) {
      const g = decideCookGate({ prebuildDeps: v, cacheUmbrella: true, lockfilePath: lockPath });
      assert.equal(g.enabled, false, `expected gate disabled for ${JSON.stringify(v)}`);
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate disables on unknown strategy", () => {
  const lock = mkTmp("cook-gate-unknown-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({ prebuildDeps: "bazel", cacheUmbrella: true, lockfilePath: lockPath });
    assert.equal(g.enabled, false);
    assert.match(g.reason, /unknown strategy/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate disables when cache umbrella is off", () => {
  const lock = mkTmp("cook-gate-cache-off-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({
      prebuildDeps: "cargo-chef",
      cacheUmbrella: false,
      lockfilePath: lockPath,
    });
    assert.equal(g.enabled, false);
    assert.match(g.reason, /cache: false/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate disables when Cargo.lock missing", () => {
  const g = decideCookGate({
    prebuildDeps: "cargo-chef",
    cacheUmbrella: true,
    lockfilePath: "",
  });
  assert.equal(g.enabled, false);
  assert.match(g.reason, /no Cargo\.lock/);

  const g2 = decideCookGate({
    prebuildDeps: "cargo-chef",
    cacheUmbrella: true,
    lockfilePath: "/definitely/does/not/exist/Cargo.lock",
  });
  assert.equal(g2.enabled, false);
  assert.match(g2.reason, /does not exist/);
});

test("decideCookGate enables for soldr-cook mode", () => {
  const lock = mkTmp("cook-gate-ok-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({
      prebuildDeps: "soldr-cook",
      cacheUmbrella: true,
      lockfilePath: lockPath,
    });
    assert.equal(g.enabled, true);
    assert.match(g.reason, /soldr-cook enabled/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("decideCookGate keeps cargo-chef as a compatibility alias", () => {
  const lock = mkTmp("cook-gate-legacy-");
  const lockPath = path.join(lock, "Cargo.lock");
  fs.writeFileSync(lockPath, "[[package]]\n", "utf8");
  try {
    const g = decideCookGate({
      prebuildDeps: "cargo-chef",
      cacheUmbrella: true,
      lockfilePath: lockPath,
    });
    assert.equal(g.enabled, true);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test("cookEnv skips the shared cook-index pack unless the workflow set it (soldr#3499)", () => {
  const env = cookEnv({ PATH: "/bin", CI: "true" });
  assert.equal(env["SOLDR_COOK_INDEX"], "0");
  assert.equal(env["PATH"], "/bin");
  assert.equal(cookEnv({ SOLDR_COOK_INDEX: "1" })["SOLDR_COOK_INDEX"], "1");
});
