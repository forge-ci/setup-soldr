// setup-soldr#559: a job that did not succeed must not save its build
// outputs. A failed build (disk full under `bosn ci`, a compile error, a
// cancel) leaves a partial zccache store; saving it under the run's key
// poisoned that key: every later run got an exact hit on the broken store
// and, being an exact hit, never re-saved it.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  decideBuildOutputSave,
  decideLayerSave,
  FAILED_JOB_SKIP_STATUS,
  readBuildOutputSaveGate,
} from "../src/lib/failed-job-save.js";
import { readRawInputs } from "../src/lib/raw-inputs.js";
import { allowCacheSave, resetSavePolicyLogForTest } from "../src/lib/save-policy.js";

const ROOT = process.cwd();

test("#559 a failed or cancelled job skips the build-output save", () => {
  for (const jobStatus of ["failure", "cancelled", "Failure", " cancelled "]) {
    const d = decideBuildOutputSave({ jobStatus, saveOnFailure: "" });
    assert.equal(d.save, false, jobStatus);
    assert.match(d.reason, /job status/);
  }
});

test("#559 a succeeding job still saves; an unknown status does not block the save", () => {
  assert.equal(decideBuildOutputSave({ jobStatus: "success", saveOnFailure: "" }).save, true);
  // An old runner or a caller that blanks the input: keep today's behaviour.
  assert.equal(decideBuildOutputSave({ jobStatus: "", saveOnFailure: "" }).save, true);
});

test("#559 save-on-failure: true restores the old always-save behaviour", () => {
  assert.equal(decideBuildOutputSave({ jobStatus: "failure", saveOnFailure: "true" }).save, true);
  assert.equal(decideBuildOutputSave({ jobStatus: "failure", saveOnFailure: "false" }).save, false);
  assert.throws(() => decideBuildOutputSave({ jobStatus: "failure", saveOnFailure: "sometimes" }));
});

test("#559 the post step reads job-status and save-on-failure from its re-evaluated inputs", () => {
  const raw = readRawInputs({ "INPUT_JOB-STATUS": "failure", "INPUT_SAVE-ON-FAILURE": "false" });
  assert.equal(raw.jobStatus, "failure");
  assert.equal(raw.saveOnFailure, "false");
  const gate = readBuildOutputSaveGate({ "INPUT_JOB-STATUS": "failure" });
  assert.equal(gate.save, false);
  assert.equal(readBuildOutputSaveGate({ "INPUT_JOB-STATUS": "success" }).save, true);
});

test("#559 action.yml: job-status comes from the workflow, save-on-failure defaults to false", () => {
  const yml = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
  const block = (name: string): string => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `action.yml declares ${name}`);
    const next = yml.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
    return yml.slice(start, start + 1 + next);
  };
  // The runner evaluates `${{ }}` anywhere in action.yml, descriptions
  // included, and an action cannot read the `job` context ("Unrecognized
  // named-value: 'job'"), so the workflow passes it and the block names it
  // without expression syntax.
  assert.doesNotMatch(block("job-status"), /\$\{\{/);
  assert.match(block("job-status"), /default: ""/);
  assert.match(block("job-status"), /`job\.status`/);
  assert.match(block("save-on-failure"), /default: "false"/);
});

test("#559 post.ts gates the build-cache and target-cache saves on the job status", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "post.ts"), "utf8");
  const gate = src.indexOf("readBuildOutputSaveGate(process.env)");
  assert.ok(gate >= 0, "post.ts reads the gate");
  const buildSave = src.indexOf('label: "build-cache",\n      debug');
  const targetSave = src.indexOf('gatedSaveCache("target-cache"');
  assert.ok(gate < buildSave && gate < targetSave, "the gate is read before either save");
  assert.ok(src.includes(`status: FAILED_JOB_SKIP_STATUS`), "a skipped save is recorded");
  assert.equal(FAILED_JOB_SKIP_STATUS, "failed-job-skip");
});

// setup-soldr#626: dependency layers (cook-base, cargo registry, toolchain)
// are finalized before the first workspace compile, so a failing test or
// lint does not corrupt them. A failed job keeps saving them; a cancelled
// job may have been interrupted inside the dependency phase, so it saves
// nothing.
test("#626 a failed job still saves dependency layers; a cancelled job does not", () => {
  assert.equal(decideLayerSave({ jobStatus: "failure", saveOnFailure: "" }, "dependency").save, true);
  assert.equal(decideLayerSave({ jobStatus: " Failure ", saveOnFailure: "" }, "dependency").save, true);
  const cancelled = decideLayerSave({ jobStatus: "cancelled", saveOnFailure: "" }, "dependency");
  assert.equal(cancelled.save, false);
  assert.match(cancelled.reason, /job status cancelled/);
  assert.equal(decideLayerSave({ jobStatus: "success", saveOnFailure: "" }, "dependency").save, true);
  assert.equal(decideLayerSave({ jobStatus: "", saveOnFailure: "" }, "dependency").save, true);
  assert.equal(decideLayerSave({ jobStatus: "cancelled", saveOnFailure: "true" }, "dependency").save, true);
});

test("#626 output layers keep the #559 refusal for failure and cancelled", () => {
  for (const jobStatus of ["failure", "cancelled"]) {
    assert.equal(decideLayerSave({ jobStatus, saveOnFailure: "" }, "output").save, false, jobStatus);
    assert.deepEqual(
      decideLayerSave({ jobStatus, saveOnFailure: "" }, "output"),
      decideBuildOutputSave({ jobStatus, saveOnFailure: "" }),
    );
  }
  assert.equal(decideLayerSave({ jobStatus: "failure", saveOnFailure: "true" }, "output").save, true);
});

test("#626 the shared save gate refuses every layer on a cancelled job", () => {
  const saved = { status: process.env["INPUT_JOB-STATUS"], event: process.env["GITHUB_EVENT_NAME"], mode: process.env["INPUT_SAVE-CACHE"] };
  resetSavePolicyLogForTest();
  process.env["INPUT_SAVE-CACHE"] = "true";
  try {
    const lines: string[] = [];
    process.env["INPUT_JOB-STATUS"] = "cancelled";
    for (const layer of ["cargo-registry-cache", "solo-toolchain-cache", "cook-cache-base", "soldr-mini-cache"]) {
      assert.equal(allowCacheSave(layer, (m) => lines.push(m)), false, layer);
    }
    assert.ok(lines.some((l) => l.includes("cargo-registry-cache: save skipped: job status cancelled")));
    resetSavePolicyLogForTest();
    process.env["INPUT_JOB-STATUS"] = "failure";
    for (const layer of ["cargo-registry-cache", "solo-toolchain-cache", "cook-cache-base"]) {
      assert.equal(allowCacheSave(layer, () => {}), true, layer);
    }
  } finally {
    for (const [k, v] of [["INPUT_JOB-STATUS", saved.status], ["GITHUB_EVENT_NAME", saved.event], ["INPUT_SAVE-CACHE", saved.mode]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSavePolicyLogForTest();
  }
});

test("#626 post.ts refuses the cook delta (a workspace output) on a failed job", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "post.ts"), "utf8");
  const cook = src.indexOf('const cookSaveLayer = core.getState("cookSaveLayer")');
  assert.ok(cook >= 0, "post.ts has the layered cook save");
  const block = src.slice(cook, cook + 2500);
  assert.match(block, /cookSaveLayer === "delta" && !buildOutputGate\.save/);
});
