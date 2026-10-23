// setup-soldr#527: one save policy gates every durable Actions-cache write.
//
// - Under `pull_request` with the default (`save-cache: auto`) no layer
//   calls saveCache / reserveCache.
// - Under `push` eligible layers save.
// - Explicit `true` / `false` override both.
// - Contract: every save call site in src/ goes through the gate.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  allowCacheSave,
  currentSaveDecision,
  decideCacheSave,
  gatedSaveCache,
  parseSaveCacheMode,
  resetSavePolicyLogForTest,
  setSaveCacheBackendForTest,
} from "../src/lib/save-policy.js";
import { saveCookCache, saveLayeredCookCache } from "../src/lib/cook-cache.js";
import { saveSoloCache } from "../src/lib/solo-toolchain-cache.js";
import { saveMiniCache } from "../src/lib/soldr-mini-cache.js";
import { saveReservedCache, type Reservation } from "../src/lib/two-phase-actions-cache.js";
import { selectDeferredCookSaveLayer } from "../src/lib/deferred-cook.js";

// Tests run from the repository root (package.json `test` script).
const srcRoot = path.resolve(process.cwd(), "src");

const savedEnv = {
  event: process.env["GITHUB_EVENT_NAME"],
  input: process.env["INPUT_SAVE-CACHE"],
  os: process.env["RUNNER_OS"],
  act: process.env["ACT"],
  remote: process.env["INPUT_SAVE-CACHE-REMOTE"],
};

// `act` is explicit so the suite gives the same answers when it runs under
// act itself (#537): `undefined` means "not a local runner".
function setEnv(event: string | undefined, input: string | undefined, runnerOs?: string, act?: string, remote?: string): void {
  if (event === undefined) delete process.env["GITHUB_EVENT_NAME"];
  else process.env["GITHUB_EVENT_NAME"] = event;
  if (input === undefined) delete process.env["INPUT_SAVE-CACHE"];
  else process.env["INPUT_SAVE-CACHE"] = input;
  if (runnerOs !== undefined) process.env["RUNNER_OS"] = runnerOs;
  if (act === undefined) delete process.env["ACT"];
  else process.env["ACT"] = act;
  if (remote === undefined) delete process.env["INPUT_SAVE-CACHE-REMOTE"];
  else process.env["INPUT_SAVE-CACHE-REMOTE"] = remote;
}

beforeEach(() => resetSavePolicyLogForTest());
afterEach(() => {
  setSaveCacheBackendForTest(null);
  setEnv(savedEnv.event, savedEnv.input, undefined, savedEnv.act, savedEnv.remote);
  if (savedEnv.os === undefined) delete process.env["RUNNER_OS"];
  else process.env["RUNNER_OS"] = savedEnv.os;
});

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const winner: Reservation = { service: "v1", compressionMethod: "zstd" as Reservation["compressionMethod"], cacheId: 7 };

/** Drive every save layer we can exercise hermetically; count backend calls. */
async function exerciseAllLayers(): Promise<{ saveCalls: number; reserveCalls: number; statuses: Record<string, string> }> {
  let saveCalls = 0;
  let reserveCalls = 0;
  const statuses: Record<string, string> = {};
  const root = mkTmp("save-policy-");
  try {
    const dir = path.join(root, "payload");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "f"), "x");
    const archive = path.join(root, "made.tar.zst");
    fs.writeFileSync(archive, "archive");

    setSaveCacheBackendForTest(async () => {
      saveCalls += 1;
      return 1;
    });

    // Generic gated saveCache (build, cargo-registry, retired lanes,
    // blessed prepare, dylint caches in post.ts).
    const id = await gatedSaveCache("build-cache", [archive], "k-build", () => {});
    statuses["build-cache"] = id > 0 ? "saved" : "policy-skip";

    // Two-phase reserve (cook base/delta, plain cook).
    const twoPhase = await saveReservedCache({
      paths: [archive],
      key: "k-two-phase",
      reserve: async () => {
        reserveCalls += 1;
        return winner;
      },
      produce: async () => ({ archivePath: archive, archiveBytes: 7 }),
      prepareUpload: async () => ({ archivePath: archive, archiveBytes: 7 }),
      upload: async () => {
        saveCalls += 1;
        return 7;
      },
    });
    statuses["two-phase"] = twoPhase.status;

    // Layered cook base.
    const layered = await saveLayeredCookCache({
      soldrBinary: "soldr",
      projectRoot: root,
      targetDir: dir,
      exactKey: "k-cook-base",
      archivePath: path.join(root, "base.tar.zst"),
      layer: "base",
      zstdLevel: "9",
      log: () => {},
      runSoldrJson: async () => ({ code: 0, stdout: "", stderr: "", payload: {} }),
      saveReservedCache: async () => {
        reserveCalls += 1;
        return { status: "saved", cacheId: 1, archive: { archivePath: archive, archiveBytes: 7 } };
      },
    });
    statuses["cook-base"] = layered.status;

    // Solo toolchain (own archive: the two-phase path deletes its input).
    const soloArchive = path.join(root, "solo-made.tar.zst");
    fs.writeFileSync(soloArchive, "archive");
    const solo = await saveSoloCache({
      stagingDir: dir,
      key: "k-solo",
      level: "1",
      debug: false,
      log: () => {},
      cacheArchivePath: path.join(root, "canonical.tar.zst"),
      skipExistingProbe: true,
      compress: async () => ({ archivePath: soloArchive, archiveBytes: 7, inflatedBytes: 2, fileCount: 1, payload: null }),
      saveCache: async () => {
        saveCalls += 1;
        return 3;
      },
    });
    statuses["solo-toolchain"] = solo.status === "failed" ? `failed: ${solo.error}` : solo.status;
    return { saveCalls, reserveCalls, statuses };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("#527 parseSaveCacheMode accepts auto/true/false and boolean aliases", () => {
  assert.equal(parseSaveCacheMode(""), "auto");
  assert.equal(parseSaveCacheMode(undefined), "auto");
  assert.equal(parseSaveCacheMode("", "true"), "true");
  assert.equal(parseSaveCacheMode("AUTO"), "auto");
  assert.equal(parseSaveCacheMode("true"), "true");
  assert.equal(parseSaveCacheMode("yes"), "true");
  assert.equal(parseSaveCacheMode("false"), "false");
  assert.equal(parseSaveCacheMode("0"), "false");
  assert.throws(() => parseSaveCacheMode("sometimes"), /save-cache/);
});

test("#527 decision matrix: auto skips only pull_request; true/false override", () => {
  assert.equal(decideCacheSave("auto", "pull_request").save, false);
  assert.equal(decideCacheSave("auto", "pull_request").reason, "pull_request event (save-cache=auto)");
  for (const ev of ["push", "workflow_dispatch", "release", "schedule", "pull_request_target", "merge_group", ""]) {
    assert.equal(decideCacheSave("auto", ev).save, true, ev);
  }
  assert.equal(decideCacheSave("true", "pull_request").save, true);
  assert.equal(decideCacheSave("false", "push").save, false);
});

test("remote write policy does not disable local automatic saves", () => {
  assert.equal(decideCacheSave("auto", "workflow_dispatch", false, "false").save, false);
  assert.equal(decideCacheSave("auto", "pull_request", true, "false").save, true);
  assert.equal(decideCacheSave("auto", "pull_request", false, "true").save, true);
  assert.equal(decideCacheSave("true", "push", false, "false").save, false);
  assert.equal(decideCacheSave("false", "push", true, "true").save, false);
});

test("remote write policy is read by main and post save gates", () => {
  assert.equal(currentSaveDecision({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    "INPUT_SAVE-CACHE-REMOTE": "false",
  }).save, false);
  assert.equal(currentSaveDecision({
    GITHUB_EVENT_NAME: "pull_request",
    ACT: "true",
    "INPUT_SAVE-CACHE-REMOTE": "false",
  }).save, true);
  assert.equal(currentSaveDecision({
    GITHUB_EVENT_NAME: "push",
    "INPUT_SAVE-CACHE-REMOTE": "invalid",
  }).save, false);
});

test("remote read-only policy gates all layers and local automatic saves still persist", async () => {
  setEnv("workflow_dispatch", "auto", undefined, undefined, "false");
  const remote = await exerciseAllLayers();
  assert.equal(remote.saveCalls, 0);
  assert.equal(remote.reserveCalls, 0);
  setEnv("pull_request", "auto", undefined, "true", "false");
  const local = await exerciseAllLayers();
  assert.ok(local.saveCalls > 0);
  assert.ok(local.reserveCalls > 0);
});

for (const runnerOs of ["Linux", "Windows", "macOS"]) {
  test(`#527 event gate is OS independent (RUNNER_OS=${runnerOs})`, () => {
    setEnv("pull_request", undefined, runnerOs);
    assert.equal(currentSaveDecision().save, false);
    setEnv("push", undefined, runnerOs);
    assert.equal(currentSaveDecision().save, true);
    setEnv("pull_request", "true", runnerOs);
    assert.equal(currentSaveDecision().save, true);
    setEnv("push", "false", runnerOs);
    assert.equal(currentSaveDecision().save, false);
  });
}

test("#527 pull_request + default: no layer calls saveCache/reserveCache", async () => {
  setEnv("pull_request", undefined, "Windows");
  const logs: string[] = [];
  const r = await exerciseAllLayers();
  assert.equal(r.saveCalls, 0, JSON.stringify(r.statuses));
  assert.equal(r.reserveCalls, 0, JSON.stringify(r.statuses));
  for (const [layer, status] of Object.entries(r.statuses)) {
    assert.equal(status, "policy-skip", layer);
  }

  // Plain cook + soldr-mini gate before archive production.
  const root = mkTmp("save-policy-cook-");
  try {
    fs.writeFileSync(path.join(root, "f"), "x");
    const cook = await saveCookCache({ targetDir: root, exactKey: "k", level: "1", longWindow: 27, debug: false, log: (m) => logs.push(m) });
    assert.equal(cook.status, "policy-skip");
    const mini = await saveMiniCache({ installDir: root, archivePath: `${root}.tar.zst`, exactKey: "k", level: "1", longWindow: 27, debug: false, log: (m) => logs.push(m) });
    assert.equal(mini.status, "policy-skip");
    assert.equal(fs.existsSync(`${root}.tar.zst`), false, "no archive produced on a skipped save");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(logs.some((l) => l === "cook-cache: save skipped: pull_request event (save-cache=auto)"), logs.join("\n"));
  assert.ok(logs.some((l) => l === "soldr-mini-cache: save skipped: pull_request event (save-cache=auto)"), logs.join("\n"));
});

test("#527 push + default: eligible layers save", async () => {
  setEnv("push", undefined);
  const r = await exerciseAllLayers();
  assert.equal(r.statuses["build-cache"], "saved");
  assert.equal(r.statuses["two-phase"], "saved");
  assert.equal(r.statuses["cook-base"], "saved");
  assert.equal(r.statuses["solo-toolchain"], "saved");
  assert.ok(r.saveCalls >= 3);
  assert.ok(r.reserveCalls >= 2);
});

test("#527 explicit save-cache=true saves on pull_request", async () => {
  setEnv("pull_request", "true");
  const r = await exerciseAllLayers();
  for (const [layer, status] of Object.entries(r.statuses)) assert.equal(status, "saved", layer);
});

test("#537 decision matrix: auto saves on a local runner whatever the event; true/false still win", () => {
  const local = decideCacheSave("auto", "pull_request", true);
  assert.equal(local.save, true);
  assert.equal(local.reason, "local runner (act): no ref scoping (save-cache=auto)");
  for (const ev of ["pull_request", "push", ""]) {
    assert.equal(decideCacheSave("auto", ev, true).save, true, ev);
  }
  assert.equal(decideCacheSave("false", "pull_request", true).save, false);
  assert.equal(decideCacheSave("true", "pull_request", true).save, true);
  // GitHub (not a local runner) keeps #527's behaviour.
  assert.equal(decideCacheSave("auto", "pull_request", false).save, false);
});

test("#537 ACT=true makes auto save on a pull_request event; ACT unset or false does not", () => {
  setEnv("pull_request", undefined, "Linux", "true");
  assert.equal(currentSaveDecision().save, true);
  setEnv("pull_request", undefined, "Linux", "false");
  assert.equal(currentSaveDecision().save, false);
  setEnv("pull_request", undefined, "Linux", undefined);
  assert.equal(currentSaveDecision().save, false);
  setEnv("pull_request", "false", "Linux", "true");
  assert.equal(currentSaveDecision().save, false, "explicit false wins under act");
});

test("#537 pull_request + default under act: every layer saves", async () => {
  setEnv("pull_request", undefined, "Linux", "true");
  const r = await exerciseAllLayers();
  for (const [layer, status] of Object.entries(r.statuses)) assert.equal(status, "saved", layer);
});

test("#527 explicit save-cache=false skips on push", async () => {
  setEnv("push", "false");
  const r = await exerciseAllLayers();
  assert.equal(r.saveCalls, 0);
  assert.equal(r.reserveCalls, 0);
});

test("#527 skip line is logged once per layer", () => {
  setEnv("pull_request", undefined);
  const logs: string[] = [];
  assert.equal(allowCacheSave("build-cache", (m) => logs.push(m)), false);
  assert.equal(allowCacheSave("build-cache", (m) => logs.push(m)), false);
  assert.equal(allowCacheSave("solo-toolchain-cache", (m) => logs.push(m)), false);
  assert.deepEqual(logs, [
    "build-cache: save skipped: pull_request event (save-cache=auto)",
    "solo-toolchain-cache: save skipped: pull_request event (save-cache=auto)",
  ]);
});

test("#527 cook action: deferred cook save layer honors the shared policy", () => {
  setEnv("pull_request", undefined);
  assert.equal(selectDeferredCookSaveLayer(true, false, currentSaveDecision().save, false), "none");
  setEnv("push", undefined);
  assert.equal(selectDeferredCookSaveLayer(true, false, currentSaveDecision().save, false), "base");
});

test("#527 action.yml files declare save-cache with auto default", () => {
  for (const file of ["action.yml", path.join("cook", "action.yml")]) {
    const text = fs.readFileSync(path.resolve(srcRoot, "..", file), "utf8");
    const m = text.match(/\n {2}save-cache:\n(?: {4}.*\n)+/);
    assert.ok(m, `${file} declares save-cache`);
    assert.match(m![0], /default: "auto"/, file);
    const remote = text.match(/\n {2}save-cache-remote:\n(?: {4}.*\n)+/);
    assert.ok(remote, `${file} declares save-cache-remote`);
    assert.match(remote![0], /default: "auto"/, file);
  }
});

// ---------------------------------------------------------------------------
// Contract: every durable save call site in src/ goes through the gate.
// ---------------------------------------------------------------------------

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Text of the innermost named function enclosing `index`. */
function enclosingFunction(text: string, index: number): { name: string; body: string } {
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  let last: { name: string; start: number } | null = null;
  for (let m = re.exec(text); m && m.index < index; m = re.exec(text)) {
    last = { name: m[1] ?? "", start: m.index };
  }
  if (!last) return { name: "<module>", body: text.slice(0, index) };
  return { name: last.name, body: text.slice(last.start, index) };
}

// Primitives that write a durable Actions-cache entry.
const RAW_PRIMITIVES = /\bcache\.saveCache\s*\(|\bcacheHttpClient\.(?:reserveCache|saveCache)\s*\(|\bCreateCacheEntry\s*\(|\bopts\.saveCache\b/g;
// Wrappers that write a durable entry and must be preceded by the gate
// in the calling function (or gate themselves).
const WRAPPERS = /\b(?:saveReservedCache|saveReserved|saveCookCache|saveLayeredCookCache|saveSoloCache|saveMiniCache|saveOne)\s*\(/g;

test("#527 contract: every save call site in src/ passes the save-policy gate", () => {
  const violations: string[] = [];
  let rawSites = 0;
  let wrapperSites = 0;
  for (const file of listTs(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join("/");
    if (rel === "lib/save-policy.ts") continue;
    // Blank block comments (keeping newlines) so dead commented-out code
    // does not count as a call site.
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    for (const m of text.matchAll(RAW_PRIMITIVES)) {
      const line = text.slice(0, m.index).split("\n").length;
      const lineText = text.split("\n")[line - 1] ?? "";
      if (/^\s*(\/\/|\*)/.test(lineText)) continue;
      rawSites += 1;
      const fn = enclosingFunction(text, m.index!);
      // two-phase's private `reserve()` is only reachable from the gated
      // saveReservedCache.
      if (rel === "lib/two-phase-actions-cache.ts" && fn.name === "reserve") continue;
      if (!fn.body.includes("allowCacheSave(")) {
        violations.push(`${rel}:${line} raw save in ${fn.name}() without allowCacheSave`);
      }
    }
    for (const m of text.matchAll(WRAPPERS)) {
      const line = text.slice(0, m.index).split("\n").length;
      const lineText = text.split("\n")[line - 1] ?? "";
      if (/^\s*(\/\/|\*)/.test(lineText)) continue;
      // Skip definitions (`function saveOne(`) and imports.
      const before = text.slice(Math.max(0, m.index! - 20), m.index);
      if (/function\s+$/.test(before)) continue;
      wrapperSites += 1;
      const fn = enclosingFunction(text, m.index!);
      if (fn.name === "<module>") continue;
      // Wrappers gate themselves; the call is fine as long as the wrapper does.
    }
  }
  // Wrappers must each gate at their definition.
  const wrapperDefs: Array<[string, string]> = [
    ["lib/two-phase-actions-cache.ts", "saveReservedCache"],
    ["lib/cook-cache.ts", "saveCookCache"],
    ["lib/cook-cache.ts", "saveLayeredCookCache"],
    ["lib/solo-toolchain-cache.ts", "saveSoloCache"],
    ["lib/soldr-mini-cache.ts", "saveMiniCache"],
    ["post.ts", "saveOne"],
  ];
  for (const [rel, name] of wrapperDefs) {
    const text = fs.readFileSync(path.join(srcRoot, rel), "utf8");
    const start = text.search(new RegExp(`function\\s+${name}\\s*\\(`));
    assert.ok(start >= 0, `${rel} defines ${name}`);
    const next = text.slice(start + 1).search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/);
    const body = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
    if (!body.includes("allowCacheSave(")) violations.push(`${rel}: ${name}() does not call allowCacheSave`);
  }
  // No direct `cache.saveCache(` outside the policy module at all: use gatedSaveCache.
  for (const file of listTs(srcRoot)) {
    const rel = path.relative(srcRoot, file).split(path.sep).join("/");
    if (rel === "lib/save-policy.ts") continue;
    const lines = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).split("\n");
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      if (/\bcache\.saveCache\s*\(/.test(l)) violations.push(`${rel}:${i + 1} calls cache.saveCache directly; use gatedSaveCache`);
    });
  }
  assert.ok(rawSites + wrapperSites > 0, "contract found no save sites; regex drifted");
  assert.deepEqual(violations, []);
});

// setup-soldr#587: GitHub scopes a save to its ref, so `auto` declines a save
// on any GitHub ref other than the default branch, not just `pull_request`.
// A local runner (act) keeps saving: its cache is machine-scoped.
test("auto declines GitHub saves off the default branch (#587)", () => {
  const main = { ref: "refs/heads/main", defaultBranch: "main" };
  const branch = { ref: "refs/heads/test/2017-x", defaultBranch: "main" };
  assert.equal(decideCacheSave("auto", "push", false, "auto", main).save, true);
  assert.equal(decideCacheSave("auto", "workflow_dispatch", false, "auto", branch).save, false);
  assert.equal(
    decideCacheSave("auto", "workflow_dispatch", false, "auto", branch).reason,
    "ref refs/heads/test/2017-x is not the default branch main (save-cache=auto)",
  );
  assert.equal(decideCacheSave("auto", "push", false, "auto", { ref: "refs/tags/v1.2.3", defaultBranch: "main" }).save, false);
  assert.equal(decideCacheSave("auto", "pull_request", true, "auto", branch).save, true);
  assert.equal(decideCacheSave("true", "workflow_dispatch", false, "auto", branch).save, true);
  // Unknown ref or default branch keeps the event-only rule.
  assert.equal(decideCacheSave("auto", "workflow_dispatch", false, "auto", { ref: "refs/heads/x" }).save, true);
});

test("currentSaveDecision reads the default branch from the event payload (#587)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "save-policy-587-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: "main" } }));
  try {
    const base = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath };
    assert.equal(currentSaveDecision({ ...base, GITHUB_REF: "refs/heads/feature" }).save, false);
    assert.equal(currentSaveDecision({ ...base, GITHUB_REF: "refs/heads/main" }).save, true);
    assert.equal(currentSaveDecision({ ...base, GITHUB_REF: "refs/heads/feature", ACT: "true" }).save, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
