import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkRequiredAttestation, countAttestations } from "../src/lib/required-attestation.js";

const message = "0 Ci-Attestation trailer(s) found for abc123. Run ./push (it runs 'soldr lint rust --attest' and stamps the commit) so CI can skip the work the client already did.";
function check(mode?: string, trailers = "", failure = false, empty = false) {
  const warnings: string[] = [], failures: string[] = [], debug: string[] = [];
  const calls: [string[], string | undefined][] = [];
  checkRequiredAttestation({ ...(mode === undefined ? {} : { "INPUT_REQUIRED-ATTESTATION": mode }), GITHUB_SHA: "abc123" }, {
    warning: (s) => { warnings.push(String(s)); }, setFailed: (s) => { failures.push(String(s)); }, debug: (s) => { debug.push(s); },
  }, (args, input) => {
    calls.push([args, input]);
    if (failure) throw new Error("no git");
    return args[0] === "show" ? (empty ? "" : "subject\n") : trailers;
  });
  return { warnings, failures, debug, calls };
}
test("attestation off and absent input are silent without git calls", () => {
  for (const mode of [undefined, "off"]) assert.deepEqual(check(mode), { warnings: [], failures: [], debug: [], calls: [] });
});
test("attestation warn emits exact message without failing", () => {
  const result = check("warn");
  assert.deepEqual(result.warnings, [message]); assert.deepEqual(result.failures, []);
  assert.deepEqual(result.calls, [[["show", "-s", "--format=%B", "abc123", "--"], undefined], [["interpret-trailers", "--parse"], "subject\n"]]);
});
test("attestation enforce fails with exact message", () => { assert.deepEqual(check("enforce").failures, [message]); });
test("unknown attestation mode warns without git or failure", () => {
  const result = check("typo"); assert.match(result.warnings[0] ?? "", /Unknown.*typo/); assert.deepEqual(result.failures, []); assert.equal(result.calls.length, 0);
});
test("unavailable git and empty messages are silent except debug", () => {
  for (const result of [check("enforce", "", true), check("enforce", "", false, true)]) {
    assert.deepEqual(result.warnings, []); assert.deepEqual(result.failures, []); assert.equal(result.debug.length, 1);
  }
});
test("only JSON objects with numeric v1 count; valid attestations pass", () => {
  const trailers = ['Ci-Attestation: {"v":1}', 'ci-attestation: {"v":1,"gate":"lint"}', 'Ci-Attestation: {"v":"1"}', 'Ci-Attestation: {"v":2}', 'Ci-Attestation: null', 'Ci-Attestation: []', 'Ci-Attestation: broken', 'Other: {"v":1}'].join('\n');
  assert.equal(countAttestations(trailers), 2);
  for (const mode of ["warn", "enforce"]) { const result = check(mode, trailers); assert.deepEqual(result.warnings, []); assert.deepEqual(result.failures, []); }
});
test("git trailer parsing ignores body mentions and HEAD is the fallback", () => {
  const warnings: string[] = [];
  checkRequiredAttestation({ "INPUT_REQUIRED-ATTESTATION": "warn" }, {
    warning: (s) => { warnings.push(String(s)); }, setFailed: () => assert.fail(), debug: () => assert.fail(),
  }, (args, input) => {
    if (args[0] === "show") { assert.equal(args[3], "HEAD"); return 'subject\n\nCi-Attestation: {"v":1}\nThis is body text.\n'; }
    return execFileSync("git", args, { input, encoding: "utf8" });
  });
  assert.equal(warnings.length, 1); assert.match(warnings[0] ?? "", /for HEAD\./);
});
