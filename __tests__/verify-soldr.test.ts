import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseVersionJsonOutput, verifyManagedToolVersions, verifySoldr, versionTuple } from "../src/lib/verify-soldr.js";

test("versionTuple parses canonical semver", () => {
  assert.deepEqual(versionTuple("0.7.10"), { major: 0, minor: 7, patch: 10 });
  assert.deepEqual(versionTuple("v0.7.10"), { major: 0, minor: 7, patch: 10 });
  assert.deepEqual(versionTuple("1.2.3"), { major: 1, minor: 2, patch: 3 });
});

test("versionTuple strips pre-release suffix from patch", () => {
  assert.deepEqual(versionTuple("0.7.10-rc1"), { major: 0, minor: 7, patch: 10 });
  assert.deepEqual(versionTuple("1.0.0-alpha.3"), { major: 1, minor: 0, patch: 0 });
});

test("versionTuple returns null for malformed", () => {
  assert.equal(versionTuple(""), null);
  assert.equal(versionTuple("0.7"), null);
  assert.equal(versionTuple("not-a-version"), null);
  assert.equal(versionTuple("0.x.0"), null);
});

test("versionTuple ignores extra version parts beyond major/minor/patch", () => {
  // "0.7.10.4" is still valid; we only look at the first three.
  assert.deepEqual(versionTuple("0.7.10.4"), { major: 0, minor: 7, patch: 10 });
});

// --- parseVersionJsonOutput ---

test("parseVersionJsonOutput parses the pre-0.7.60 and current shapes", () => {
  // Byte-shape emitted by every release from at least v0.7.59 through
  // v0.7.96 (verified against the published release binaries).
  const current = `{
  "schema_version": 1,
  "command": "version",
  "soldr_version": "0.7.96"
}`;
  assert.equal(parseVersionJsonOutput(current)["soldr_version"], "0.7.96");
});

test("parseVersionJsonOutput tolerates extra and missing fields", () => {
  // Extra fields a future soldr may add must not break parsing...
  const extra = '{"schema_version": 2, "soldr_version": "0.8.0", "managed_zccache_version": "1.13.0", "new_field": [1, 2]}';
  assert.equal(parseVersionJsonOutput(extra)["soldr_version"], "0.8.0");
  // ...and missing fields are the caller's concern, not a parse error.
  const minimal = '{"soldr_version": "0.7.59"}';
  assert.equal(parseVersionJsonOutput(minimal)["soldr_version"], "0.7.59");
  assert.deepEqual(parseVersionJsonOutput("{}"), {});
});

test("parseVersionJsonOutput tolerates non-JSON noise around the payload", () => {
  const noisy =
    "soldr: note: a newer release is available\n" +
    '{"schema_version": 1, "command": "version", "soldr_version": "0.7.96"}\n' +
    "trust: verified\n";
  assert.equal(parseVersionJsonOutput(noisy)["soldr_version"], "0.7.96");
});

test("parseVersionJsonOutput reports the silent-binary regression actionably", () => {
  // soldr v0.7.85 / v0.7.87 release binaries exit 0 printing nothing at all
  // (fbuild misread the resulting "Unexpected end of JSON input" as a
  // version-JSON schema incompatibility). The error must name the broken
  // releases and the fixed floor.
  for (const stdout of ["", "   \n"]) {
    assert.throws(() => parseVersionJsonOutput(stdout), (err: Error) => {
      assert.match(err.message, /produced no output/);
      assert.match(err.message, /0\.7\.85/);
      assert.match(err.message, /0\.7\.87/);
      assert.match(err.message, /0\.7\.89/);
      return true;
    });
  }
});

test("parseVersionJsonOutput rejects garbage with a raw-output snippet", () => {
  assert.throws(() => parseVersionJsonOutput("not json at all"), (err: Error) => {
    assert.match(err.message, /non-JSON output/);
    assert.match(err.message, /raw output: not json at all/);
    return true;
  });
  // A JSON scalar is not an acceptable payload either.
  assert.throws(() => parseVersionJsonOutput('"0.7.96"'), /non-JSON output/);
});


test("managed version probes use the exact Soldr executable and tolerate tool failures", async () => {
  const calls: Array<{ command: string; args: string[]; ignore: boolean }> = [];
  const run = async (command: string, args: string[], opts: { ignoreReturnCode: boolean }) => {
    calls.push({ command, args, ignore: opts.ignoreReturnCode });
    return 17;
  };
  await verifyManagedToolVersions("/installed path/soldr", run);
  assert.deepEqual(calls, [
    { command: "/installed path/soldr", args: ["cargo", "--version"], ignore: true },
    { command: "/installed path/soldr", args: ["rustc", "--version"], ignore: true },
  ]);
});


test("verification executes a Soldr path containing spaces without invoking PATH tools", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr verify path "));
  const log = path.join(dir, "calls.log");
  const win = process.platform === "win32";
  const executableDir = win ? dir : path.join(dir, 'quoted "path" with \\ slash');
  if (!win) fs.mkdirSync(executableDir);
  const fake = path.join(executableDir, win ? "soldr.cmd" : "soldr");
  const script = win
    ? '@echo off\r\nif "%~1"=="version" (echo {"soldr_version":"0.9.41"}& exit /b 0)\r\nif "%~1"=="status" (echo {}& exit /b 0)\r\necho %*>>"%SETUP_SOLDR_TEST_LOG%"\r\nexit /b 17\r\n'
    : `#!/bin/sh
case "$1" in
  version) echo '{"soldr_version":"0.9.41"}' ;;
  status) echo '{}' ;;
  *) echo "$*" >> "$SETUP_SOLDR_TEST_LOG"; exit 17 ;;
esac
`;
  fs.writeFileSync(fake, script, { mode: 0o755 });
  const previous = process.env.SETUP_SOLDR_TEST_LOG;
  process.env.SETUP_SOLDR_TEST_LOG = log;
  try {
    const result = await verifySoldr({ soldrPath: fake, buildCacheMode: "", requireRustPlan: false });
    assert.equal(result.soldrVersion, "0.9.41");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split(/\r?\n/), ["cargo --version", "rustc --version"]);
  } finally {
    if (previous === undefined) delete process.env.SETUP_SOLDR_TEST_LOG;
    else process.env.SETUP_SOLDR_TEST_LOG = previous;
  }
});
