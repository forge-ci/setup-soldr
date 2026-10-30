// talos-hq/clud#2342: a solo-toolchain entry keyed `rustc1.95.0` shipped
// rustc 1.98.0-nightly. Restore verified the mismatch, repair could not delete
// the entry without `actions: write`, and the job failed with no fallback.
// These tests pin the three fixes: validate before save, cold-install
// fallback, and one precise diagnostic naming the missing permission.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveSoloCache } from "../src/lib/solo-toolchain-cache.js";
import {
  coldInstallAfterFailedRepair,
  parseRustcVersionVerbose,
  planPoisonedEntryRecovery,
  releaseFromSoloKey,
} from "../src/lib/solo-poison.js";

const POISONED_KEY = "solo-toolchain-v3-linux-x64-glibc-rustc1.95.0-cb6b9e404-tnone-soldrv0.9.44";
const NIGHTLY_VERBOSE = [
  "rustc 1.98.0-nightly (0123456789 2026-10-01)",
  "binary: rustc",
  "commit-hash: 0123456789abcdef0123456789abcdef01234567",
  "commit-date: 2026-10-01",
  "host: x86_64-unknown-linux-gnu",
  "release: 1.98.0-nightly",
  "LLVM version: 21.1.0",
].join("\n");
const STABLE_VERBOSE = [
  "rustc 1.95.0 (fedcba987 2026-08-01)",
  "binary: rustc",
  "commit-hash: fedcba9876543210fedcba9876543210fedcba98",
  "release: 1.95.0",
].join("\n");

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("#2342 releaseFromSoloKey reads the release the key promises", () => {
  assert.equal(releaseFromSoloKey(POISONED_KEY), "1.95.0");
  assert.equal(releaseFromSoloKey("solo-toolchain-v3-linux-x64-glibc-rustcnightly-2026-10-01-cnone-tnone-soldr1"), "nightly-2026-10-01");
  assert.equal(releaseFromSoloKey("unrelated-key"), null);
});

test("#2342 parseRustcVersionVerbose extracts release and commit hash", () => {
  assert.deepEqual(parseRustcVersionVerbose(NIGHTLY_VERBOSE), {
    release: "1.98.0-nightly",
    commitHash: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.deepEqual(parseRustcVersionVerbose("rustc 1.95.0 (abc 2026-08-01)"), { release: "1.95.0", commitHash: null });
  assert.equal(parseRustcVersionVerbose("garbage"), null);
});

async function saveWithProbe(stdout: string, code = 0) {
  const root = mkTmp("solo-2342-save-");
  const logs: string[] = [];
  let uploaded = 0;
  let compressed = 0;
  try {
    const stagingDir = path.join(root, "staged");
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "payload"), "ok");
    const archive = path.join(root, "archive.tar.zst");
    fs.writeFileSync(archive, "archive");
    const result = await saveSoloCache({
      stagingDir,
      key: POISONED_KEY,
      level: "1",
      debug: false,
      log: (m) => logs.push(m),
      cacheArchivePath: path.join(root, "canonical.tar.zst"),
      skipExistingProbe: true,
      probeRustcVersion: async () => ({ code, stdout, stderr: "" }),
      compress: async () => {
        compressed += 1;
        return { archivePath: archive, archiveBytes: 7, inflatedBytes: 2, fileCount: 1, payload: null };
      },
      saveCache: async () => {
        uploaded += 1;
        return 42;
      },
    });
    return { result, logs, uploaded, compressed };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("#2342 save refuses a toolchain whose rustc release contradicts the key", async () => {
  const { result, logs, uploaded, compressed } = await saveWithProbe(NIGHTLY_VERBOSE);
  assert.equal(result.status, "validation-refused");
  assert.equal(uploaded, 0, "a poisoned entry must never be uploaded");
  assert.equal(compressed, 0, "refuse before spending time compressing");
  const line = logs.find((l) => l.includes("refusing save"));
  assert.ok(line, `missing refusal log: ${logs.join("\n")}`);
  assert.match(line!, /expected=1\.95\.0/);
  assert.match(line!, /observed=1\.98\.0-nightly/);
  assert.match(line!, /commit=0123456789abcdef/);
});

test("#2342 save refuses when rustc cannot be probed", async () => {
  const { result, uploaded } = await saveWithProbe("", 1);
  assert.equal(result.status, "validation-refused");
  assert.equal(uploaded, 0);
});

test("#2342 save proceeds when the observed release matches the key", async () => {
  const { result, uploaded, logs } = await saveWithProbe(STABLE_VERBOSE);
  assert.equal(result.status, "saved");
  assert.equal(uploaded, 1);
  assert.ok(logs.some((l) => /pre-save verify .*expected=1\.95\.0 observed=1\.95\.0 .*match=true/.test(l)), logs.join("\n"));
});

test("#2342 undeletable poisoned entry gets one diagnostic naming actions: write and the key", () => {
  const plan = planPoisonedEntryRecovery({ key: POISONED_KEY, deletion: { found: 0, deleted: 0, failed: 1 } });
  assert.equal(plan.publishReplacement, false);
  assert.equal(plan.failJob, false, "a cache problem must not become a CI outage");
  assert.match(plan.message!, /actions: write/);
  assert.ok(plan.message!.includes(POISONED_KEY));
  assert.doesNotMatch(plan.message!, /setup-soldr failed/);
});

test("#2342 deletable poisoned entry is replaced without a diagnostic", () => {
  const plan = planPoisonedEntryRecovery({ key: POISONED_KEY, deletion: { found: 1, deleted: 1, failed: 0 } });
  assert.deepEqual(plan, { publishReplacement: true, failJob: false, message: null });
});

test("#2342 cold-install fallback discards restored toolchain dirs and reinstalls", async () => {
  const rustupHome = mkTmp("solo-2342-rustup-");
  try {
    const toolchains = path.join(rustupHome, "toolchains");
    fs.mkdirSync(path.join(toolchains, "1.95.0-x86_64-unknown-linux-gnu", "bin"), { recursive: true });
    fs.mkdirSync(path.join(toolchains, "stable-x86_64-unknown-linux-gnu"), { recursive: true });
    fs.mkdirSync(path.join(rustupHome, "update-hashes"), { recursive: true });
    fs.writeFileSync(path.join(rustupHome, "update-hashes", "1.95.0-x86_64-unknown-linux-gnu"), "stale");
    const warnings: string[] = [];
    let reinstalled = 0;
    let sawDirAtReinstall = true;
    await coldInstallAfterFailedRepair({
      rustupHome,
      channel: "1.95.0",
      key: POISONED_KEY,
      warn: (m) => warnings.push(m),
      reinstall: async () => {
        reinstalled += 1;
        sawDirAtReinstall = fs.existsSync(path.join(toolchains, "1.95.0-x86_64-unknown-linux-gnu"));
      },
      verify: async () => ({ match: true, observedRelease: "1.95.0" }),
    });
    assert.equal(reinstalled, 1);
    assert.equal(sawDirAtReinstall, false, "the poisoned toolchain dir must be gone before reinstall");
    assert.ok(fs.existsSync(path.join(toolchains, "stable-x86_64-unknown-linux-gnu")), "unrelated toolchains survive");
    assert.ok(!fs.existsSync(path.join(rustupHome, "update-hashes", "1.95.0-x86_64-unknown-linux-gnu")));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cold install/);
    assert.ok(warnings[0]!.includes(POISONED_KEY));
  } finally {
    fs.rmSync(rustupHome, { recursive: true, force: true });
  }
});

test("#2342 cold-install fallback fails precisely when the fresh toolchain is still wrong", async () => {
  const rustupHome = mkTmp("solo-2342-rustup-bad-");
  try {
    await assert.rejects(
      coldInstallAfterFailedRepair({
        rustupHome,
        channel: "1.95.0",
        key: POISONED_KEY,
        warn: () => {},
        reinstall: async () => {},
        verify: async () => ({ match: false, observedRelease: "1.98.0-nightly" }),
      }),
      /cold install of 1\.95\.0 .*observed=1\.98\.0-nightly/,
    );
  } finally {
    fs.rmSync(rustupHome, { recursive: true, force: true });
  }
});
