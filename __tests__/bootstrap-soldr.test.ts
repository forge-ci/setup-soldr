import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrapAssetFor, ensureBootstrap, verifyBootstrapDigest } from "../src/lib/bootstrap-soldr.js";

test("bootstrap assets are fixed to the correct native host and immutable digest", () => {
  const linux = bootstrapAssetFor("linux", "x64", "glibc");
  assert.equal(linux.target, "x86_64-unknown-linux-gnu");
  assert.match(linux.sha256, /^[0-9a-f]{64}$/);
  assert.equal(bootstrapAssetFor("linux", "arm64", "musl").target, "aarch64-unknown-linux-musl");
  assert.equal(bootstrapAssetFor("darwin", "arm64", "darwin").target, "aarch64-apple-darwin");
  assert.equal(bootstrapAssetFor("win32", "x64", "msvc").target, "x86_64-pc-windows-msvc");
  assert.throws(() => bootstrapAssetFor("linux", "mips", "glibc"), /unsupported/);
  assert.throws(() => bootstrapAssetFor("linux", "x64", "unknown"), /unsupported/);
});

test("bootstrap fails closed when an archive digest does not match", () => {
  assert.doesNotThrow(() => verifyBootstrapDigest("a".repeat(64), "a".repeat(64)));
  assert.throws(() => verifyBootstrapDigest("b".repeat(64), "a".repeat(64)), /SHA-256 mismatch/);
  assert.throws(() => verifyBootstrapDigest("", "a".repeat(64)), /SHA-256 mismatch/);
});


test("bootstrap verifies the archive before extraction and rejects wrong versions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr bootstrap test "));
  const bytes = Buffer.from("trusted fixture archive");
  const asset = bootstrapAssetFor("linux", "x64", "glibc");
  const calls: string[] = [];
  const deps = {
    download: async (_url: string, dest: string) => { calls.push("download"); fs.writeFileSync(dest, bytes); },
    extract: async (_archive: string, _ext: "tar.zst", name: string, out: string) => {
      calls.push("extract");
      fs.mkdirSync(out, { recursive: true });
      const binary = path.join(out, name);
      fs.writeFileSync(binary, "fixture");
      return binary;
    },
    version: async (_binary: string) => { calls.push("version"); return "0.9.41"; },
    digest: async (_archive: string) => asset.sha256,
  };
  const binary = await ensureBootstrap(root, asset, deps);
  assert.ok(fs.existsSync(binary));
  assert.deepEqual(calls, ["download", "extract", "version"]);
  calls.length = 0;
  await assert.rejects(() => ensureBootstrap(root, asset, { ...deps, digest: async () => "a".repeat(64) }), /SHA-256 mismatch/);
  assert.deepEqual(calls, ["download"]);
  calls.length = 0;
  await assert.rejects(() => ensureBootstrap(root, { ...asset, filename: "../escape" }, deps), /invalid Soldr bootstrap asset/);
  assert.deepEqual(calls, []);
  await assert.rejects(() => ensureBootstrap(root, asset, { ...deps, version: async () => "0.0.0" }), /bootstrap version/);
});

test("bootstrap reuses only a digest-verified cached archive while offline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr bootstrap cache "));
  const asset = bootstrapAssetFor("linux", "x64", "glibc");
  const cache = path.join(root, "persistent cache");
  let downloads = 0;
  const deps = {
    download: async (_url: string, dest: string) => { downloads++; fs.writeFileSync(dest, "verified fixture"); },
    digest: async (archive: string) => fs.readFileSync(archive, "utf8") === "verified fixture" ? asset.sha256 : "0".repeat(64),
    extract: async (_archive: string, _ext: "tar.zst", name: string, out: string) => {
      fs.mkdirSync(out, { recursive: true });
      const binary = path.join(out, name);
      fs.writeFileSync(binary, "fixture");
      return binary;
    },
    version: async () => "0.9.41",
  };
  await ensureBootstrap(root, asset, deps, cache);
  await ensureBootstrap(root, asset, { ...deps, download: async () => { throw new Error("offline"); } }, cache);
  assert.equal(downloads, 1);
  const cacheRoot = path.join(cache, "0.9.41", asset.target);
  const firstEntry = fs.readdirSync(cacheRoot)[0]!;
  fs.writeFileSync(path.join(cacheRoot, firstEntry, asset.filename), "corrupted fixture");
  await assert.rejects(() => ensureBootstrap(root, asset, { ...deps, download: async () => { throw new Error("offline"); } }, cache), /offline/);
  await ensureBootstrap(root, asset, deps, cache);
  assert.equal(downloads, 2);
});

test("an explicitly prefilled archive supports offline bootstrap and must match the pin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr bootstrap prefill "));
  const asset = bootstrapAssetFor("linux", "x64", "glibc");
  const prefill = path.join(root, "offline archive");
  fs.writeFileSync(prefill, "verified fixture");
  const deps = {
    download: async () => { throw new Error("network must not be used"); },
    digest: async (archive: string) => fs.readFileSync(archive, "utf8") === "verified fixture" ? asset.sha256 : "0".repeat(64),
    extract: async (_archive: string, _ext: "tar.zst", name: string, out: string) => {
      fs.mkdirSync(out, { recursive: true });
      const binary = path.join(out, name);
      fs.writeFileSync(binary, "fixture");
      return binary;
    },
    version: async () => "0.9.41",
  };
  await ensureBootstrap(root, asset, deps, undefined, prefill);
  fs.writeFileSync(prefill, "untrusted fixture");
  await assert.rejects(() => ensureBootstrap(root, asset, deps, undefined, prefill), /SHA-256 mismatch/);
  await assert.rejects(() => ensureBootstrap(root, asset, deps, undefined, "relative.tar.zst"), /must be absolute/);
});

test("offline prefill rejects symlinks and special files", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr special archive "));
  const asset = bootstrapAssetFor("linux", "x64", "glibc");
  const ordinary = path.join(root, "ordinary");
  const link = path.join(root, "archive-link");
  fs.writeFileSync(ordinary, "data");
  fs.symlinkSync(ordinary, link);
  await assert.rejects(() => ensureBootstrap(root, asset, undefined, undefined, link), /invalid Soldr bootstrap archive/);
  const { execFileSync } = await import("node:child_process");
  const fifo = path.join(root, "archive-fifo");
  execFileSync("mkfifo", [fifo]);
  await assert.rejects(() => ensureBootstrap(root, asset, undefined, undefined, fifo), /invalid Soldr bootstrap archive/);
});
