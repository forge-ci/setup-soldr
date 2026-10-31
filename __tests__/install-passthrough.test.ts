import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { installPassthrough, _internal } from "../src/lib/install-passthrough.js";

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

test("installPassthrough writes a stub at the requested path", () => {
  const dir = mkTmp("setup-soldr-passthrough-");
  try {
    const isWindows = process.platform === "win32";
    const target = path.join(dir, isWindows ? "soldr.cmd" : "soldr");
    installPassthrough({ soldrPath: target, isWindows, log: () => {} });
    assert.ok(fs.statSync(target).isFile(), "stub file was created");
    const contents = fs.readFileSync(target, "utf8");
    if (isWindows) {
      assert.match(contents, /@echo off/);
      assert.match(contents, /version/);
      assert.match(contents, /exec|TOOL/);
    } else {
      assert.match(contents, /^#!\/usr\/bin\/env bash/);
      assert.match(contents, /exec "\$@"/);
      const mode = fs.statSync(target).mode & 0o777;
      assert.ok((mode & 0o100) !== 0, `expected stub to be executable, got mode ${mode.toString(8)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installPassthrough on Windows writes a bash-twin alongside soldr.cmd for Git Bash callers", () => {
  const dir = mkTmp("setup-soldr-passthrough-twin-");
  try {
    const cmdPath = path.join(dir, "soldr.cmd");
    installPassthrough({ soldrPath: cmdPath, isWindows: true, log: () => {} });
    assert.ok(fs.statSync(cmdPath).isFile(), "soldr.cmd was created");
    const twinPath = path.join(dir, "soldr");
    assert.ok(
      fs.statSync(twinPath).isFile(),
      "no-extension soldr bash twin was created next to soldr.cmd",
    );
    const twin = fs.readFileSync(twinPath, "utf8");
    assert.match(twin, /^#!\/usr\/bin\/env bash/, "twin has bash shebang");
    assert.match(twin, /exec "\$@"/, "twin forwards argv via exec");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bash stub treats `stop` as a silent no-op (passthrough has no daemon)", { skip: process.platform === "win32" }, () => {
  const dir = mkTmp("setup-soldr-passthrough-stop-");
  try {
    const target = path.join(dir, "soldr");
    installPassthrough({ soldrPath: target, isWindows: false, log: () => {} });
    const result = spawnSync(target, ["stop"], { encoding: "utf8" });
    assert.equal(result.status, 0, `stop should exit 0; stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "", "stop should produce no stdout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bash stub forwards argv[1..] to the named tool", { skip: process.platform === "win32" }, () => {
  const dir = mkTmp("setup-soldr-passthrough-fwd-");
  try {
    const target = path.join(dir, "soldr");
    installPassthrough({ soldrPath: target, isWindows: false, log: () => {} });
    const result = spawnSync(target, ["echo", "hello", "world"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "hello world");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bash stub returns stub JSON for `version`", { skip: process.platform === "win32" }, () => {
  const dir = mkTmp("setup-soldr-passthrough-ver-");
  try {
    const target = path.join(dir, "soldr");
    installPassthrough({ soldrPath: target, isWindows: false, log: () => {} });
    const result = spawnSync(target, ["version", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload["soldr_version"], _internal.STUB_VERSION);
    assert.equal(payload["setup_soldr_passthrough"], true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bash stub returns stub JSON for `cache report --json`", { skip: process.platform === "win32" }, () => {
  const dir = mkTmp("setup-soldr-passthrough-cache-");
  try {
    const target = path.join(dir, "soldr");
    installPassthrough({ soldrPath: target, isWindows: false, log: () => {} });
    const result = spawnSync(target, ["cache", "report", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(payload["status"], "ok");
    assert.equal(payload["soldr_version"], _internal.STUB_VERSION);
    assert.equal(payload["last_session"], null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
