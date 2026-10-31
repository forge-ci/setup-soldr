// setup-soldr#647: guard that test processes leave nothing in the tmp root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const loader = path.resolve("__tests__", "register-loader.mjs");

test("register-loader removes temp dirs a test process leaves behind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  try {
    const script =
      'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");' +
      'const d=fs.mkdtempSync(path.join(os.tmpdir(),"leak-"));' +
      'fs.writeFileSync(path.join(d,"f"),"x");console.log(d);';
    const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    const r = spawnSync(process.execPath, ["--import", loader, "-e", script], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const leaked = r.stdout.trim();
    assert.ok(leaked.startsWith(root), `child should create under the guard root: ${leaked}`);
    assert.equal(fs.existsSync(leaked), false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
