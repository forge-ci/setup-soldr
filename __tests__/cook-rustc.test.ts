import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureCookCommand, resolveCookRustcRelease } from "../src/lib/cook-rustc.js";
import { runCook } from "../src/lib/cook-cache.js";

test("cook identifies rustc through the selected Soldr executable", async () => {
  const calls: Array<[string, string[], string | undefined]> = [];
  const result = await resolveCookRustcRelease("/managed path/soldr", "/selected workspace", async (command, args, cwd) => {
    calls.push([command, args, cwd]);
    return { code: 0, stdout: "rustc 1.95.0 (example)\n", stderr: "" };
  }, () => {});
  assert.equal(result, "1.95.0");
  assert.deepEqual(calls, [["/managed path/soldr", ["rustc", "--version"], "/selected workspace"]]);
});

test("cook reports an unavailable managed compiler without a direct fallback", async () => {
  const warnings: string[] = [];
  const result = await resolveCookRustcRelease("soldr", "/workspace", async () => ({
    code: 7, stdout: "", stderr: "not available",
  }), (message) => warnings.push(message));
  assert.equal(result, "unresolved");
  assert.match(warnings[0] ?? "", /not available/);
});


test("cook probes from its selected workspace with a spaced executable path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cook probe path "));
  const workspace = path.join(dir, "selected workspace");
  fs.mkdirSync(workspace);
  const win = process.platform === "win32";
  const fake = path.join(dir, win ? "soldr.cmd" : "soldr");
  const script = win
    ? '@echo off\r\ncd > "%COOK_TEST_CWD%"\r\necho %* > "%COOK_TEST_ARGS%"\r\necho rustc 1.95.0\r\n'
    : '#!/bin/sh\npwd > "$COOK_TEST_CWD"\necho "$*" > "$COOK_TEST_ARGS"\necho "rustc 1.95.0"\n';
  fs.writeFileSync(fake, script, { mode: 0o755 });
  const marker = path.join(dir, "cwd.txt");
  const argsMarker = path.join(dir, "args.txt");
  const previous = process.env.COOK_TEST_CWD;
  const previousArgs = process.env.COOK_TEST_ARGS;
  process.env.COOK_TEST_CWD = marker;
  process.env.COOK_TEST_ARGS = argsMarker;
  try {
    const release = await resolveCookRustcRelease(fake, workspace, captureCookCommand, () => {});
    assert.equal(release, "1.95.0");
    assert.equal(fs.realpathSync(fs.readFileSync(marker, "utf8").trim()), fs.realpathSync(workspace));
    const cook = await runCook({ soldrBinary: fake, projectRoot: workspace, flags: ["--release"], log: () => {} });
    assert.equal(cook.exitCode, 0);
    assert.equal(fs.readFileSync(argsMarker, "utf8").trim(), "cook --release");
    assert.equal(fs.realpathSync(fs.readFileSync(marker, "utf8").trim()), fs.realpathSync(workspace));
  } finally {
    if (previous === undefined) delete process.env.COOK_TEST_CWD;
    else process.env.COOK_TEST_CWD = previous;
    if (previousArgs === undefined) delete process.env.COOK_TEST_ARGS;
    else process.env.COOK_TEST_ARGS = previousArgs;
  }
});
