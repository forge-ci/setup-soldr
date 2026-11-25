import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rustupProfileMatches,
  shouldRefreshToolchain,
  shouldSkipRefreshForExactHit,
  tryDelegateToSoldrToolchainEnsure,
} from "../src/lib/ensure-rust-toolchain.js";
import { resolveRustupStrategy } from "../src/lib/resolve-setup.js";

test("rustup profile check recognizes the existing profile", async () => {
  const matches = await rustupProfileMatches("rustup", "minimal", async (command, args) => {
    assert.equal(command, "rustup");
    assert.deepEqual(args, ["show", "profile"]);
    return { code: 0, stdout: "minimal\r\n" };
  });
  assert.equal(matches, true);
});

test("rustup profile check requires a successful, exact match", async () => {
  assert.equal(await rustupProfileMatches("rustup", "minimal", async () => ({
    code: 0, stdout: "default\n",
  })), false);
  assert.equal(await rustupProfileMatches("rustup", "minimal", async () => ({
    code: 1, stdout: "minimal\n",
  })), false);
});

test("shouldRefreshToolchain recognizes rolling aliases", () => {
  assert.equal(shouldRefreshToolchain("stable"), true);
  assert.equal(shouldRefreshToolchain("beta"), true);
  assert.equal(shouldRefreshToolchain("nightly"), true);
});

test("shouldRefreshToolchain handles host-suffixed rolling channels", () => {
  assert.equal(shouldRefreshToolchain("stable-x86_64-unknown-linux-gnu"), true);
  assert.equal(shouldRefreshToolchain("nightly-aarch64-apple-darwin"), true);
});

test("shouldRefreshToolchain does not refresh pinned versions", () => {
  assert.equal(shouldRefreshToolchain("1.78.0"), false);
  assert.equal(shouldRefreshToolchain("nightly-2024-04-01"), false);
  assert.equal(shouldRefreshToolchain("beta-2024-05-15"), false);
});

test("shouldRefreshToolchain rejects empty/whitespace input", () => {
  assert.equal(shouldRefreshToolchain(""), false);
  assert.equal(shouldRefreshToolchain("   "), false);
});

test("shouldSkipRefreshForExactHit requires exact match", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", true, "1.78.0"),
    true,
  );
});

test("shouldSkipRefreshForExactHit fails when releases differ", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", true, "1.77.0"),
    false,
  );
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", true, null),
    false,
  );
});

test("shouldSkipRefreshForExactHit requires setup-cache exact hit", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "1.78.0", false, "1.78.0"),
    false,
  );
});

test("shouldSkipRefreshForExactHit requires expected release to be set", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("stable", "", true, "1.78.0"),
    false,
  );
});

test("shouldSkipRefreshForExactHit returns false for non-rolling toolchains", () => {
  assert.equal(
    shouldSkipRefreshForExactHit("1.78.0", "1.78.0", true, "1.78.0"),
    false,
  );
});

// --- resolveRustupStrategy (setup-soldr#105) ---

test("resolveRustupStrategy forces managed on darwin when system requested", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "darwin",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "managed");
  assert.equal(warnings.length, 1);
  const warning = warnings[0] ?? "";
  // Warning must explain WHY so users debugging cache-hit changes get a hint.
  assert.match(warning, /macOS/);
  assert.match(warning, /managed/);
  assert.match(warning, /conflict/i);
  assert.match(warning, /105/);
});

test("resolveRustupStrategy leaves managed alone on darwin", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "managed",
    platform: "darwin",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "managed");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy leaves explicit alone on darwin", () => {
  // Explicit means the caller set RUSTUP_HOME — respect that choice.
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "explicit",
    platform: "darwin",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "explicit");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy does not fire on linux", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "linux",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "system");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy does not fire on win32", () => {
  const warnings: string[] = [];
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "win32",
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, "system");
  assert.equal(warnings.length, 0);
});

test("resolveRustupStrategy works without a warn callback", () => {
  // The override on darwin must not throw when no warn callback is provided.
  const result = resolveRustupStrategy({
    requested: "system",
    platform: "darwin",
  });
  assert.equal(result, "managed");
});

// --- Delegation to `soldr toolchain ensure --json` (Wave 3.4 / setup-soldr#133) ---

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

function mkExec(map: Record<string, ExecResult>): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(" ");
    return map[key] ?? { code: 127, stdout: "", stderr: `mock: no entry for ${key}` };
  };
}

test("tryDelegateToSoldrToolchainEnsure delegates when soldr 0.7.35 is installed", async () => {
  const ensurePayload = {
    schema_version: 1,
    channel: "1.94.1",
    rustup_bootstrapped: false,
    components_added: ["rustfmt", "clippy"],
    targets_added: ["x86_64-pc-windows-gnu"],
    plugins_installed: [],
    smoke_verify: { cargo_version: "cargo 1.94.1", rustc_version: "rustc 1.94.1", ok: true },
    elapsed_ms: 100,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain ensure --json --channel 1.94.1 --profile minimal --component rustfmt --component clippy --target x86_64-pc-windows-gnu": {
      code: 0,
      stdout: JSON.stringify(ensurePayload),
      stderr: "",
    },
  });
  const result = await tryDelegateToSoldrToolchainEnsure({
    soldrPath: "/fake/soldr",
    channel: "1.94.1",
    profile: "minimal",
    components: ["rustfmt", "clippy"],
    targets: ["x86_64-pc-windows-gnu"],
    exec,
  });
  assert.notEqual(result, null);
  assert.equal(result!.channel, "1.94.1");
  assert.deepEqual(result!.componentsAdded, ["rustfmt", "clippy"]);
});

test("tryDelegateToSoldrToolchainEnsure returns null for soldr 0.7.34 (fallback path)", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.34" }), stderr: "" },
  });
  const result = await tryDelegateToSoldrToolchainEnsure({
    soldrPath: "/fake/soldr",
    channel: "1.94.1",
    profile: "minimal",
    components: [],
    targets: [],
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrToolchainEnsure returns null when soldr binary missing", async () => {
  const exec: ExecFn = async () => ({ code: 127, stdout: "", stderr: "ENOENT" });
  const result = await tryDelegateToSoldrToolchainEnsure({
    soldrPath: "/no/such/path",
    channel: "1.94.1",
    profile: "minimal",
    components: [],
    targets: [],
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrToolchainEnsure returns null for passthrough stub", async () => {
  const exec = mkExec({
    "version --json": {
      code: 0,
      stdout: JSON.stringify({ soldr_version: "passthrough", setup_soldr_passthrough: true }),
      stderr: "",
    },
  });
  const result = await tryDelegateToSoldrToolchainEnsure({
    soldrPath: "/fake/soldr",
    channel: "1.94.1",
    profile: "minimal",
    components: [],
    targets: [],
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrToolchainEnsure returns null on schema_version mismatch", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain ensure --json --channel 1.94.1 --profile minimal": {
      code: 0,
      stdout: JSON.stringify({ schema_version: 99, channel: "1.94.1" }),
      stderr: "",
    },
  });
  const warnings: string[] = [];
  const result = await tryDelegateToSoldrToolchainEnsure({
    soldrPath: "/fake/soldr",
    channel: "1.94.1",
    profile: "minimal",
    components: [],
    targets: [],
    exec,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, null);
  // The schema_version warning must surface.
  assert.ok(warnings.some((w) => /schema_version/.test(w)));
});

test("tryDelegateToSoldrToolchainEnsure returns null when subcommand fails", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain ensure --json --channel 1.94.1 --profile minimal": {
      code: 1,
      stdout: "",
      stderr: "rustup install failed",
    },
  });
  const result = await tryDelegateToSoldrToolchainEnsure({
    soldrPath: "/fake/soldr",
    channel: "1.94.1",
    profile: "minimal",
    components: [],
    targets: [],
    exec,
  });
  assert.equal(result, null);
});
