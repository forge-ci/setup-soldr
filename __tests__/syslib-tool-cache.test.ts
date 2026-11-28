// Tests for setup-soldr#553: soldr prepare's syslib/toolchain store
// (`$SOLDR_CACHE_DIR/bin/syslib`) lives under RUNNER_TOOL_CACHE on runners
// whose tool cache outlives the job (act / `bosn ci`, self-hosted), so a
// warm run finds every install stamped and downloads nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  decideSyslibToolCache,
  linkSyslibToolCache,
  syslibToolCacheStore,
} from "../src/lib/syslib-tool-cache.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const linux = { platform: "linux" as NodeJS.Platform, arch: "x64" };

test("#553 store path lands under RUNNER_TOOL_CACHE", () => {
  const store = syslibToolCacheStore("/opt/hostedtoolcache", "linux", "x64");
  assert.equal(store, path.join("/opt/hostedtoolcache", "soldr-syslib", "linux-x64"));
});

test("#553 decide: act and self-hosted runners use the tool cache store", () => {
  const act = decideSyslibToolCache({
    env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", ACT: "true" },
    ...linux,
    crossPrepareTarget: "",
  });
  assert.equal(act.enabled, true, act.reason);
  assert.equal(act.store, path.join("/opt/hostedtoolcache", "soldr-syslib", "linux-x64"));

  const selfHosted = decideSyslibToolCache({
    env: { RUNNER_TOOL_CACHE: "/srv/tc", RUNNER_ENVIRONMENT: "self-hosted" },
    ...linux,
    crossPrepareTarget: "",
  });
  assert.equal(selfHosted.enabled, true, selfHosted.reason);
  assert.ok(selfHosted.store.startsWith(path.join("/srv/tc", "soldr-syslib")));
});

test("#553 decide: github-hosted, Windows, cross-targets, no tool cache stay off", () => {
  const hosted = decideSyslibToolCache({
    env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", RUNNER_ENVIRONMENT: "github-hosted" },
    ...linux,
    crossPrepareTarget: "",
  });
  assert.equal(hosted.enabled, false);

  const windows = decideSyslibToolCache({
    env: { RUNNER_TOOL_CACHE: "C:\\hostedtoolcache", ACT: "true" },
    platform: "win32",
    arch: "x64",
    crossPrepareTarget: "",
  });
  assert.equal(windows.enabled, false);

  const cross = decideSyslibToolCache({
    env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", ACT: "true" },
    ...linux,
    crossPrepareTarget: "x86_64-pc-windows-msvc",
  });
  assert.equal(cross.enabled, false);

  const noToolCache = decideSyslibToolCache({ env: { ACT: "true" }, ...linux, crossPrepareTarget: "" });
  assert.equal(noToolCache.enabled, false);
});

test("#553 decide: SETUP_SOLDR_TOOL_CACHE overrides the runner default", () => {
  const forcedOn = decideSyslibToolCache({
    env: {
      RUNNER_TOOL_CACHE: "/opt/hostedtoolcache",
      RUNNER_ENVIRONMENT: "github-hosted",
      SETUP_SOLDR_TOOL_CACHE: "1",
    },
    ...linux,
    crossPrepareTarget: "",
  });
  assert.equal(forcedOn.enabled, true);

  const forcedOff = decideSyslibToolCache({
    env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", ACT: "true", SETUP_SOLDR_TOOL_CACHE: "0" },
    ...linux,
    crossPrepareTarget: "",
  });
  assert.equal(forcedOff.enabled, false);
});

// Mirrors soldr's `ensure_syslib_bundle` (soldr-fetch syslib_common.rs):
// an install is reused when `<lib>/<version>/<slug>/.complete` and
// `package/` exist; otherwise it is fetched (sha256-verified) and promoted.
function ensureSyslib(soldrBin: string, fetch: () => void): void {
  const installRoot = path.join(soldrBin, "syslib", "zstd", "1.5.7", "linux-x64-gnu");
  if (fs.existsSync(path.join(installRoot, ".complete")) && fs.statSync(path.join(installRoot, "package")).isDirectory()) {
    return;
  }
  fetch();
  fs.mkdirSync(path.join(installRoot, "package"), { recursive: true });
  fs.writeFileSync(path.join(installRoot, ".complete"), "zstd 1.5.7 linux-x64-gnu");
}

test("#553 a second, fresh SOLDR_CACHE_DIR reuses the tool cache store without downloading", { skip: process.platform === "win32" }, () => {
  const toolCache = mkTmp("setup-soldr-553-tc-");
  const store = syslibToolCacheStore(toolCache, process.platform, process.arch);
  let downloads = 0;
  const fetch = (): void => {
    downloads += 1;
  };

  // Run 1: empty tool cache, fresh /tmp.
  const run1 = mkTmp("setup-soldr-553-run1-");
  const bin1 = path.join(run1, "setup-soldr-soldr", "bin");
  fs.mkdirSync(bin1, { recursive: true });
  const first = linkSyslibToolCache({ soldrBinDir: bin1, store });
  assert.equal(first.status, "linked");
  assert.equal(fs.realpathSync(path.join(bin1, "syslib")), fs.realpathSync(store));
  ensureSyslib(bin1, fetch);
  assert.equal(downloads, 1);
  assert.ok(fs.existsSync(path.join(store, "zstd", "1.5.7", "linux-x64-gnu", ".complete")));

  // Run 2: a new container — /tmp is empty again, the tool cache persisted.
  const run2 = mkTmp("setup-soldr-553-run2-");
  const bin2 = path.join(run2, "setup-soldr-soldr", "bin");
  fs.mkdirSync(bin2, { recursive: true });
  const second = linkSyslibToolCache({ soldrBinDir: bin2, store });
  assert.equal(second.status, "linked");
  ensureSyslib(bin2, fetch);
  assert.equal(downloads, 1, "warm run must not download again");

  // Same job, second setup-soldr invocation: the link is already in place.
  assert.equal(linkSyslibToolCache({ soldrBinDir: bin2, store }).status, "already-linked");
});

test("#553 a non-empty syslib dir (e.g. restored by setup-cache) is kept, never replaced", { skip: process.platform === "win32" }, () => {
  const toolCache = mkTmp("setup-soldr-553-tc-");
  const store = syslibToolCacheStore(toolCache, process.platform, process.arch);
  const bin = path.join(mkTmp("setup-soldr-553-keep-"), "bin");
  fs.mkdirSync(path.join(bin, "syslib", "cmake"), { recursive: true });
  const result = linkSyslibToolCache({ soldrBinDir: bin, store });
  assert.equal(result.status, "kept-existing-dir");
  assert.ok(fs.lstatSync(path.join(bin, "syslib")).isDirectory());
  assert.ok(fs.existsSync(path.join(bin, "syslib", "cmake")));
});

test("#553 an empty syslib dir or a stale/dangling link is replaced by the store link", { skip: process.platform === "win32" }, () => {
  const toolCache = mkTmp("setup-soldr-553-tc-");
  const store = syslibToolCacheStore(toolCache, process.platform, process.arch);

  const emptyBin = path.join(mkTmp("setup-soldr-553-empty-"), "bin");
  fs.mkdirSync(path.join(emptyBin, "syslib"), { recursive: true });
  assert.equal(linkSyslibToolCache({ soldrBinDir: emptyBin, store }).status, "linked");
  assert.ok(fs.lstatSync(path.join(emptyBin, "syslib")).isSymbolicLink());

  const staleBin = path.join(mkTmp("setup-soldr-553-stale-"), "bin");
  fs.mkdirSync(staleBin, { recursive: true });
  fs.symlinkSync(path.join(toolCache, "gone"), path.join(staleBin, "syslib"));
  assert.equal(linkSyslibToolCache({ soldrBinDir: staleBin, store }).status, "linked");
  assert.equal(path.resolve(staleBin, fs.readlinkSync(path.join(staleBin, "syslib"))), store);
});
