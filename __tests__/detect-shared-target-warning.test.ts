import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  sharedTargetSignalSeverity,
  shouldEmitSharedTargetWarning,
  targetDirHasCompiledArtifacts,
  tryDelegateToSoldrDoctorSharedTargetWarning,
} from "../src/lib/detect-shared-target-warning.js";

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

test("targetDirHasCompiledArtifacts returns false for missing dir", () => {
  assert.equal(targetDirHasCompiledArtifacts("/non/existent/path/setup-soldr"), false);
});

test("targetDirHasCompiledArtifacts returns false for empty target dir", () => {
  const root = mkTmp("dst-empty-");
  try {
    assert.equal(targetDirHasCompiledArtifacts(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetDirHasCompiledArtifacts returns false for empty deps dir", () => {
  const root = mkTmp("dst-empty-deps-");
  try {
    fs.mkdirSync(path.join(root, "debug", "deps"), { recursive: true });
    assert.equal(targetDirHasCompiledArtifacts(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetDirHasCompiledArtifacts returns true for deps/*.rmeta", () => {
  const root = mkTmp("dst-rmeta-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "libfoo-1234.rmeta"), "x");
    assert.equal(targetDirHasCompiledArtifacts(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetDirHasCompiledArtifacts finds rmeta in nested target shapes", () => {
  const root = mkTmp("dst-rmeta-deep-");
  try {
    const deps = path.join(root, "x86_64-unknown-linux-gnu", "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "libbar.rmeta"), "y");
    assert.equal(targetDirHasCompiledArtifacts(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldEmitSharedTargetWarning false when build cache disabled", () => {
  assert.equal(
    shouldEmitSharedTargetWarning({
      buildCacheEnabled: false,
      buildCacheMode: "once",
      targetCacheEnabled: true,
      targetDir: "/tmp",
    }),
    false,
  );
});

test("shouldEmitSharedTargetWarning false when build cache mode is not 'once'", () => {
  const root = mkTmp("dst-mode-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "lib.rmeta"), "z");
    assert.equal(
      shouldEmitSharedTargetWarning({
        buildCacheEnabled: true,
        buildCacheMode: "thin",
        targetCacheEnabled: true,
        targetDir: root,
      }),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldEmitSharedTargetWarning false when target cache disabled", () => {
  const root = mkTmp("dst-tc-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "lib.rmeta"), "z");
    assert.equal(
      shouldEmitSharedTargetWarning({
        buildCacheEnabled: true,
        buildCacheMode: "once",
        targetCacheEnabled: false,
        targetDir: root,
      }),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldEmitSharedTargetWarning true when all conditions hold", () => {
  const root = mkTmp("dst-emit-");
  try {
    const deps = path.join(root, "debug", "deps");
    fs.mkdirSync(deps, { recursive: true });
    fs.writeFileSync(path.join(deps, "lib.rmeta"), "z");
    assert.equal(
      shouldEmitSharedTargetWarning({
        buildCacheEnabled: true,
        buildCacheMode: "once",
        targetCacheEnabled: true,
        targetDir: root,
      }),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Delegation to `soldr toolchain doctor --json` (Wave 3.4 / setup-soldr#133) ---

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

function mkExec(map: Record<string, ExecResult>): ExecFn {
  return async (_cmd, args) => {
    const key = args.join(" ");
    return map[key] ?? { code: 127, stdout: "", stderr: `mock: no entry for ${key}` };
  };
}

test("tryDelegateToSoldrDoctorSharedTargetWarning reads probe and forwards would_warn=true", async () => {
  const doctorPayload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [
      {
        name: "shared-target-warning",
        ok: false,
        details: { would_warn: true, target_dir: "target", build_cache_mode: "once" },
      },
    ],
    elapsed_ms: 1,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain doctor --json": { code: 0, stdout: JSON.stringify(doctorPayload), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorSharedTargetWarning({
    soldrPath: "/fake/soldr",
    exec,
  });
  assert.notEqual(result, null);
  assert.equal(result!.wouldWarn, true);
});

test("tryDelegateToSoldrDoctorSharedTargetWarning reads probe and forwards would_warn=false", async () => {
  const doctorPayload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [
      {
        name: "shared-target-warning",
        ok: true,
        details: { would_warn: false, target_dir: "target" },
      },
    ],
    elapsed_ms: 1,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain doctor --json": { code: 0, stdout: JSON.stringify(doctorPayload), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorSharedTargetWarning({
    soldrPath: "/fake/soldr",
    exec,
  });
  assert.notEqual(result, null);
  assert.equal(result!.wouldWarn, false);
});

test("tryDelegateToSoldrDoctorSharedTargetWarning returns null for soldr 0.7.34", async () => {
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.34" }), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorSharedTargetWarning({
    soldrPath: "/fake/soldr",
    exec,
  });
  assert.equal(result, null);
});

test("tryDelegateToSoldrDoctorSharedTargetWarning returns null when probe missing", async () => {
  const doctorPayload = {
    schema_version: 1,
    host: { os: "linux", arch: "x86_64", libc: "gnu" },
    probes: [{ name: "musl-cc", ok: true, details: {} }],
    elapsed_ms: 1,
  };
  const exec = mkExec({
    "version --json": { code: 0, stdout: JSON.stringify({ soldr_version: "0.7.35" }), stderr: "" },
    "toolchain doctor --json": { code: 0, stdout: JSON.stringify(doctorPayload), stderr: "" },
  });
  const result = await tryDelegateToSoldrDoctorSharedTargetWarning({
    soldrPath: "/fake/soldr",
    exec,
  });
  assert.equal(result, null);
});

test("#239 sharedTargetSignalSeverity: warning iff target-cache enabled", () => {
  // target-cache ON: a restored stale rust-plan can collide → warning.
  assert.equal(sharedTargetSignalSeverity(true), "warning");
  // target-cache OFF (e.g. zccache): populated target/ is this run's own cook
  // output, not a stale restored plan → quieter notice, off the warning channel.
  assert.equal(sharedTargetSignalSeverity(false), "notice");
});
