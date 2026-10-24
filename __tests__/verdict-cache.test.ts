import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MANIFEST_PREFIX,
  MAX_MANIFESTS_PER_SCOPE,
  MAX_VERDICT_ENTRIES,
  VERDICT_PREFIX,
  isLazy,
  janitorPlan,
  manifestKey,
  manifestScope,
  parseRekey,
  publishManifest,
  publishVerdicts,
  resetSeen,
  restoreVerdicts,
  verdictPaths,
  type VerdictPaths,
} from "../src/lib/verdict-cache.js";
import { parseVerdictsInput } from "../src/lib/verdict-setup.js";

function tmpPaths(): VerdictPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-"));
  return {
    root,
    records: path.join(root, "records"),
    spool: path.join(root, "spool"),
    seen: path.join(root, "seen.jsonl"),
  };
}

test("rekey output separates keys, unkeyable checks and ungated work", () => {
  const out = [
    '{"tool":"clippy","key":"soldr-verdict-v1-clippy-ws-a"}',
    '{"tool":"clippy","key":"soldr-verdict-v1-clippy-ws-a"}',
    '{"tool":"fmt","key":null,"reason":"dirty"}',
    "soldr: some log line",
  ].join("\n");
  const prediction = parseRekey(out);
  assert.deepEqual(prediction.keys, ["soldr-verdict-v1-clippy-ws-a"]);
  assert.equal(prediction.unkeyable, 1);
  assert.equal(prediction.ungated, false);
  assert.equal(parseRekey('{"tool":null,"ungated":true}').ungated, true);
});

test("lazy only when every predicted check has a verdict and nothing else ran", () => {
  const base = { keys: ["a", "b"], unkeyable: 0, ungated: false };
  assert.equal(isLazy(base, ["a", "b"]), true);
  assert.equal(isLazy(base, ["a"]), false);
  assert.equal(isLazy({ ...base, ungated: true }, ["a", "b"]), false);
  assert.equal(isLazy({ ...base, unkeyable: 1 }, ["a", "b"]), false);
  assert.equal(isLazy({ keys: [], unkeyable: 0, ungated: false }, []), false);
  assert.equal(isLazy(null, ["a"]), false);
});

test("job scope ignores the ref and tokens but not inputs", () => {
  const env = {
    GITHUB_WORKFLOW_REF: "o/r/.github/workflows/ci.yml@refs/heads/main",
    GITHUB_JOB: "clippy",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    "INPUT_TARGET": "x86_64-unknown-linux-gnu",
    "INPUT_SOLDR-TOKEN": "t1",
  };
  const scope = manifestScope(env);
  assert.equal(manifestScope({ ...env, GITHUB_WORKFLOW_REF: "o/r/.github/workflows/ci.yml@refs/pull/9/merge" }), scope);
  assert.equal(manifestScope({ ...env, "INPUT_SOLDR-TOKEN": "t2" }), scope);
  assert.notEqual(manifestScope({ ...env, "INPUT_TARGET": "aarch64-apple-darwin" }), scope);
  assert.notEqual(manifestScope({ ...env, GITHUB_JOB: "dylint" }), scope);
  assert.ok(manifestKey(scope, "12", "1").startsWith(`${MANIFEST_PREFIX}${scope}-`));
});

test("restore keeps only exact verdict hits", async () => {
  const paths = tmpPaths();
  const restore = async (_p: string[], key: string): Promise<string | undefined> =>
    key === "k1" ? key : key === "k2" ? "other" : undefined;
  assert.deepEqual(await restoreVerdicts(["k1", "k2", "k3"], paths, restore), ["k1"]);
});

test("publish saves each spooled verdict and the manifest", async () => {
  const paths = tmpPaths();
  fs.mkdirSync(paths.records, { recursive: true });
  fs.mkdirSync(paths.spool, { recursive: true });
  const key = `${VERDICT_PREFIX}clippy-ws-abc`;
  fs.writeFileSync(path.join(paths.records, `${key}.json`), "{}");
  fs.writeFileSync(path.join(paths.spool, `${key}.json`), "{}");
  fs.writeFileSync(path.join(paths.spool, "stray.json"), "{}");
  const saved: string[] = [];
  const save = async (_p: string[], k: string): Promise<number> => {
    saved.push(k);
    return 1;
  };
  assert.equal(await publishVerdicts(paths, save, () => undefined), 1);
  assert.deepEqual(saved, [key]);

  const staging = path.join(paths.root, "staging", "seen.jsonl");
  assert.equal(await publishManifest(paths, staging, "m", save), false, "no seen log yet");
  fs.writeFileSync(paths.seen, '{"tool":"clippy"}\n');
  assert.equal(await publishManifest(paths, staging, "m", save), true);
  assert.equal(fs.readFileSync(staging, "utf8"), '{"tool":"clippy"}\n');
  resetSeen(paths);
  assert.equal(fs.existsSync(paths.seen), false);
  assert.equal(fs.existsSync(paths.spool), false);
});

test("janitor keeps the newest verdicts and manifests per scope", () => {
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const entries = [];
  for (let i = 0; i < MAX_VERDICT_ENTRIES + 3; i += 1) {
    entries.push({ id: i, key: `${VERDICT_PREFIX}clippy-ws-${i}`, last_accessed_at: at(i) });
  }
  for (let i = 0; i < MAX_MANIFESTS_PER_SCOPE + 2; i += 1) {
    entries.push({ id: 10_000 + i, key: `${MANIFEST_PREFIX}aaaa-${i}-1`, last_accessed_at: at(i) });
  }
  entries.push({ id: 20_000, key: `${MANIFEST_PREFIX}bbbb-1-1`, last_accessed_at: at(0) });
  const doomed = janitorPlan(entries).map((e) => e.id).sort((a, b) => a - b);
  assert.deepEqual(doomed, [0, 1, 2, 10_000, 10_001]);
});

test("old soldr without the ledger yields no paths", async () => {
  assert.equal(await verdictPaths(async () => ({ code: 2, stdout: "" }), "."), null);
  const json = '{"root":"/r","records":"/r/records","spool":"/r/spool","seen":"/r/seen.jsonl"}';
  assert.deepEqual(await verdictPaths(async () => ({ code: 0, stdout: `noise\n${json}\n` }), "."), JSON.parse(json));
});

test("verdicts input parses", () => {
  assert.equal(parseVerdictsInput(""), "auto");
  assert.equal(parseVerdictsInput("off"), "off");
  assert.equal(parseVerdictsInput("restore"), "restore");
});
