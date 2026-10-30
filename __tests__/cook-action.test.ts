import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDeferredCookPlan,
  parseBooleanInput,
  selectDeferredCookSaveLayer,
} from "../src/lib/deferred-cook.js";

function mkWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-cook-action-"));
  fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n", "utf8");
  fs.writeFileSync(path.join(root, "Cargo.lock"), "# lock\n", "utf8");
  fs.mkdirSync(path.join(root, ".cargo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cargo", "config.toml"), "[build]\n", "utf8");
  return root;
}

test("parseBooleanInput accepts GitHub-style booleans", () => {
  assert.equal(parseBooleanInput("cache", "", true), true);
  assert.equal(parseBooleanInput("cache", "false", true), false);
  assert.equal(parseBooleanInput("cache", "ON", false), true);
  assert.throws(() => parseBooleanInput("cache", "maybe", true), /invalid 'cache' input/);
});

test("cook save policy leaves restore enabled but skips durable writes when requested", async () => {
  const workspace = mkWorkspace();
  try {
    const plan = await buildDeferredCookPlan({
      workspace, runnerOs: "Linux", runnerArch: "X64", githubSha: "0123456789abcdef",
      parentSha: "", targetDir: "target", lockfile: "", flags: "--release",
      cache: true, deltaCache: true, rustcRelease: "1.94.1",
      soldrVersion: "0.8.1", buildShape: "", env: {},
    });
    assert.equal(plan.enabled, true);
    assert.ok(plan.baseKey);
    assert.equal(selectDeferredCookSaveLayer(true, false, false, true), "none");
    assert.equal(selectDeferredCookSaveLayer(true, false, true, true), "base");
    assert.equal(selectDeferredCookSaveLayer(true, true, true, true), "delta");
    assert.equal(selectDeferredCookSaveLayer(true, true, false, true), "none");
    // #528: with the delta layer off (the default) a base hit saves nothing,
    // while a base miss still saves the base.
    assert.equal(selectDeferredCookSaveLayer(true, true, true, false), "none");
    assert.equal(selectDeferredCookSaveLayer(true, false, true, false), "base");
    assert.equal(selectDeferredCookSaveLayer(true, false, false, false), "none");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("deferred cook plan preserves target/profile-shaped flags for msvc cook", async () => {
  const workspace = mkWorkspace();
  try {
    const plan = await buildDeferredCookPlan({
      workspace,
      runnerOs: "Linux",
      runnerArch: "X64",
      githubSha: "0123456789abcdef",
      parentSha: "fedcba9876543210",
      targetDir: "target",
      lockfile: "",
      flags: "--profile ci-nextest --target x86_64-pc-windows-msvc --package soldr-cli",
      cache: true,
      deltaCache: true,
      rustcRelease: "1.94.1",
      soldrVersion: "0.8.1",
      buildShape: "",
      env: {
        RUSTFLAGS: "-Clink-arg=-fuse-ld=lld",
        CARGO_BUILD_TARGET: "x86_64-pc-windows-msvc",
      },
    });
    assert.equal(plan.enabled, true);
    assert.equal(plan.layered, true);
    assert.deepEqual(plan.flags, [
      "--profile",
      "ci-nextest",
      "--target",
      "x86_64-pc-windows-msvc",
      "--package",
      "soldr-cli",
    ]);
    assert.match(plan.baseKey, /^cook-base-v3-linux-x64-/);
    assert.match(plan.baseKey, /rustc1\.94\.1-/);
    assert.match(plan.baseKey, /soldr0\.8\.1$/);
    // #625: a soldr release must restore the previous soldr's base layer.
    assert.equal(plan.baseRestoreKeys.length, 1);
    assert.match(plan.baseRestoreKeys[0] ?? "", /^cook-base-v3-linux-x64-.*-soldr$/);
    assert.ok(plan.baseKey.startsWith(plan.baseRestoreKeys[0] ?? "missing-prefix"));
    assert.match(plan.deltaKey, /-g0123456789abcdef$/);
    assert.equal(plan.deltaRestoreKeys.length, 2);
    assert.match(plan.deltaRestoreKeys[0] ?? "", /-gfedcba9876543210$/);
    assert.match(plan.deltaRestoreKeys[1] ?? "", /^cook-delta-v2-linux-x64-.*-s[0-9a-f]{12}-$/);
    assert.ok(plan.deltaKey.startsWith(plan.deltaRestoreKeys[1] ?? "missing-prefix"));
    assert.equal(plan.projectRoot, workspace);
    assert.equal(plan.targetDir, path.join(workspace, "target"));
    assert.equal(plan.baseArchivePath, `${path.join(workspace, "target")}.soldr-base.tar.zst`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("deferred cook plan falls back to legacy cache when delta-cache is disabled", async () => {
  const workspace = mkWorkspace();
  try {
    const plan = await buildDeferredCookPlan({
      workspace,
      runnerOs: "Linux",
      runnerArch: "X64",
      githubSha: "0123456789abcdef",
      parentSha: "",
      targetDir: "target",
      lockfile: "",
      flags: "--release",
      cache: true,
      deltaCache: false,
      rustcRelease: "1.94.1",
      soldrVersion: "0.8.1",
      buildShape: "",
      env: {},
    });
    assert.equal(plan.enabled, true);
    assert.equal(plan.layered, false);
    assert.match(plan.legacyKey, /^cook-linux-x64-/);
    assert.equal(plan.legacyArchivePath, `${path.join(workspace, "target")}.tar.zst`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("deferred cook plan disables when cache is off or lockfile is missing", async () => {
  const workspace = mkWorkspace();
  try {
    const cacheOff = await buildDeferredCookPlan({
      workspace,
      runnerOs: "Linux",
      runnerArch: "X64",
      githubSha: "",
      parentSha: "",
      targetDir: "target",
      lockfile: "",
      flags: "--release",
      cache: false,
      deltaCache: true,
      rustcRelease: "1.94.1",
      soldrVersion: "0.8.1",
      buildShape: "",
      env: {},
    });
    assert.equal(cacheOff.enabled, false);
    assert.match(cacheOff.reason, /cache: false/);

    fs.rmSync(path.join(workspace, "Cargo.lock"), { force: true });
    const missingLock = await buildDeferredCookPlan({
      workspace,
      runnerOs: "Linux",
      runnerArch: "X64",
      githubSha: "",
      parentSha: "",
      targetDir: "target",
      lockfile: "",
      flags: "--release",
      cache: true,
      deltaCache: true,
      rustcRelease: "1.94.1",
      soldrVersion: "0.8.1",
      buildShape: "",
      env: {},
    });
    assert.equal(missingLock.enabled, false);
    assert.match(missingLock.reason, /Cargo\.lock/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
