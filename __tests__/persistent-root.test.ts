// persistent-root (obs-rust/obs-studio#4954, proposal P4): on a self-hosted
// runner setup-soldr keeps its state on the runner and skips every GitHub
// Actions cache round trip, crash safely, and reports a per-job ledger.
//
// Every test passes its env explicitly or restores process.env, so the suite
// answers the same on a hosted runner, a self-hosted one and under act.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLEAN_MARKER,
  PERSISTENT_ROOT_ENV,
  STATE_DIR,
  appendLedgerHistory,
  choosePersistentRoot,
  closePersistentSession,
  lastMissDurationMs,
  openPersistentSession,
  persistentLayout,
  preparePersistentRoot,
  readLedgerHistory,
  remoteCacheBypassed,
  resetPersistentRootLogForTest,
  slotRoot,
  storeFromDescriptor,
  writeFileAtomic,
} from "../src/lib/persistent-root.js";
import {
  describeLedger,
  ledgerLayersFromRestores,
  persistentLayerStatus,
  probeDir,
  summarizeLedger,
} from "../src/lib/cache-ledger.js";
import { allowCacheSave, allowVerdictSave, resetSavePolicyLogForTest } from "../src/lib/save-policy.js";
import { restoreCookCache, restoreLayeredCookCacheArchives } from "../src/lib/cook-cache.js";
import { readRawInputs, resolveSetup } from "../src/lib/resolve-setup.js";
import { createLogger } from "../src/lib/log-utils.js";
import type { ActionContext } from "../src/lib/types.js";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

const SELF_HOSTED = { RUNNER_ENVIRONMENT: "self-hosted", RUNNER_NAME: "dell-1" };
const savedRootEnv = process.env[PERSISTENT_ROOT_ENV];
const savedEvent = process.env["GITHUB_EVENT_NAME"];
const tmpDirs: string[] = [];

afterEach(() => {
  if (savedRootEnv === undefined) delete process.env[PERSISTENT_ROOT_ENV];
  else process.env[PERSISTENT_ROOT_ENV] = savedRootEnv;
  if (savedEvent === undefined) delete process.env["GITHUB_EVENT_NAME"];
  else process.env["GITHUB_EVENT_NAME"] = savedEvent;
  resetPersistentRootLogForTest();
  resetSavePolicyLogForTest();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function mkTmp(prefix = "persistent-root-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const files = (map: Record<string, string>) => (p: string): string | null => map[p] ?? null;
const identity = (runner: string, runId: string) => ({ runner, runId, runAttempt: "1", job: "build" });

// --- choosing the root --------------------------------------------------

test("auto on a GitHub-hosted runner stays on the Actions cache, even with a descriptor", () => {
  const choice = choosePersistentRoot({
    input: "",
    env: { RUNNER_ENVIRONMENT: "github-hosted", RUNNER_NAME: "GitHub Actions 1" },
    descriptorPaths: ["/d/.persistent-cache"],
    readFile: files({ "/d/.persistent-cache": "dell\n" }),
  });
  assert.equal(choice.root, null);
  assert.equal(choice.warning, undefined);
});

test("an explicit path on a GitHub-hosted runner is ignored with a warning", () => {
  const choice = choosePersistentRoot({ input: "/srv/cache", env: { RUNNER_ENVIRONMENT: "github-hosted" } });
  assert.equal(choice.root, null);
  assert.match(choice.warning ?? "", /not self-hosted/);
});

test("off and SETUP_SOLDR_PROFILE=hosted disable it on a self-hosted runner", () => {
  for (const input of ["off", "false", "none"]) {
    assert.equal(choosePersistentRoot({ input, env: SELF_HOSTED }).root, null, input);
  }
  const killed = choosePersistentRoot({ input: "/srv/cache", env: { ...SELF_HOSTED, SETUP_SOLDR_PROFILE: "hosted" } });
  assert.equal(killed.root, null);
  assert.equal(killed.reason, "SETUP_SOLDR_PROFILE=hosted");
});

test("an explicit absolute path is used as-is; a relative one is refused", () => {
  const ok = choosePersistentRoot({ input: "/srv/cache/", env: SELF_HOSTED });
  assert.equal(ok.root, path.resolve("/srv/cache"));
  assert.equal(ok.source, "input");
  const rel = choosePersistentRoot({ input: "cache", env: SELF_HOSTED });
  assert.equal(rel.root, null);
  assert.match(rel.warning ?? "", /absolute/);
});

test("auto detects obs-runner's .persistent-cache marker and picks the runner's slot", () => {
  const choice = choosePersistentRoot({
    input: "auto",
    env: SELF_HOSTED,
    platform: "linux",
    arch: "x64",
    uid: 0,
    descriptorPaths: ["/var/cache/soldr-store/descriptor.json", "/var/cache/obs-runner/.persistent-cache"],
    readFile: files({ "/var/cache/obs-runner/.persistent-cache": "dell-fsx3mn2\n" }),
  });
  assert.equal(choice.source, "descriptor");
  assert.equal(choice.root, path.join("/var/cache/obs-runner", "slots", "dell-1", "setup-soldr", "linux-x64-u0"));
});

test("a JSON host-store descriptor names the store; unknown schema degrades with a warning", () => {
  assert.equal(storeFromDescriptor("/x/descriptor.json", '{"schema":1,"store":"/var/cache/soldr-store"}'), "/var/cache/soldr-store");
  assert.equal(storeFromDescriptor("/x/descriptor.json", '{"schema":2,"store":"/s"}'), null);
  assert.equal(storeFromDescriptor("/x/descriptor.json", '{"schema":1,"store":"rel"}'), null);
  const bad = choosePersistentRoot({
    input: "",
    env: SELF_HOSTED,
    descriptorPaths: ["/d.json"],
    readFile: files({ "/d.json": '{"schema":9}' }),
  });
  assert.equal(bad.root, null);
  assert.match(bad.warning ?? "", /schema 1/);
});

test("a descriptor without RUNNER_NAME, or no descriptor, stays off silently", () => {
  const noRunner = choosePersistentRoot({
    input: "",
    env: { RUNNER_ENVIRONMENT: "self-hosted" },
    descriptorPaths: ["/m"],
    readFile: files({ "/m": "host" }),
  });
  assert.equal(noRunner.root, null);
  const none = choosePersistentRoot({ input: "", env: SELF_HOSTED, descriptorPaths: ["/nope"], readFile: files({}) });
  assert.equal(none.root, null);
  assert.equal(none.warning, undefined);
});

test("slot names are sanitized and separate container (uid 0) from host (uid 1001) jobs", () => {
  assert.notEqual(slotRoot("/s", "r", "linux", "x64", 0), slotRoot("/s", "r", "linux", "x64", 1001));
  assert.equal(slotRoot("/s", "a/b c", "linux", "x64", 0), path.join("/s", "slots", "a_b_c", "setup-soldr", "linux-x64-u0"));
});

// --- crash safety -------------------------------------------------------

test("a fresh root opens, loses no data and is unclean until closed", () => {
  const root = path.join(mkTmp(), "root");
  const open = openPersistentSession(root, identity("dell-1", "1"));
  assert.equal(open.outcome, "fresh");
  assert.equal(fs.existsSync(path.join(root, CLEAN_MARKER)), false);
  fs.mkdirSync(path.join(root, "rustup", "toolchains", "1.95.0"), { recursive: true });
  closePersistentSession(root, { sync: () => undefined });
  assert.equal(fs.existsSync(path.join(root, CLEAN_MARKER)), true);
  const again = openPersistentSession(root, identity("dell-1", "2"));
  assert.equal(again.outcome, "clean");
  assert.ok(fs.existsSync(path.join(root, "rustup", "toolchains", "1.95.0")), "a clean root is reused");
  assert.equal(fs.existsSync(path.join(root, CLEAN_MARKER)), false, "opening removes the marker before any work");
});

test("a root whose session never closed is quarantined and rebuilt cold", () => {
  const root = path.join(mkTmp(), "root");
  openPersistentSession(root, identity("dell-1", "1"));
  fs.mkdirSync(path.join(root, "rustup", "toolchains"), { recursive: true });
  fs.writeFileSync(path.join(root, "rustup", "toolchains", "rustc"), ""); // truncated by a power loss
  // No close: the runner died. The next job on the same runner recovers.
  const next = openPersistentSession(root, identity("dell-1", "2"));
  assert.equal(next.outcome, "recovered");
  assert.deepEqual(next.quarantined, ["rustup"]);
  assert.equal(fs.existsSync(path.join(root, "rustup")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, STATE_DIR)).filter((n) => n.startsWith("quarantine-")), []);
});

test("content with no marker and no session record is untrusted", () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, "leftover"), "x");
  assert.equal(openPersistentSession(root, identity("dell-1", "1")).outcome, "recovered");
  assert.equal(fs.existsSync(path.join(root, "leftover")), false);
});

test("a second setup-soldr step in the same job re-enters its own session", () => {
  const root = mkTmp();
  openPersistentSession(root, identity("dell-1", "7"));
  fs.mkdirSync(path.join(root, "cargo"));
  const second = openPersistentSession(root, identity("dell-1", "7"));
  assert.equal(second.outcome, "reentrant");
  assert.ok(fs.existsSync(path.join(root, "cargo")));
});

test("a root another runner holds open is left alone; a stale one is recovered", () => {
  const root = mkTmp();
  let now = Date.parse("2026-11-17T00:00:00Z");
  openPersistentSession(root, identity("dell-2", "1"), { now: () => now });
  fs.mkdirSync(path.join(root, "cargo"));
  const busy = openPersistentSession(root, identity("dell-1", "2"), { now: () => now + 60_000 });
  assert.equal(busy.outcome, "busy");
  assert.ok(fs.existsSync(path.join(root, "cargo")));
  now += 8 * 3600 * 1000;
  assert.equal(openPersistentSession(root, identity("dell-1", "3"), { now: () => now }).outcome, "recovered");
});

test("preparePersistentRoot degrades to the Actions cache when the root is busy", () => {
  const root = mkTmp();
  openPersistentSession(root, identity("dell-2", "1"));
  fs.mkdirSync(path.join(root, "cargo"));
  const warnings: string[] = [];
  const prepared = preparePersistentRoot({
    input: root,
    env: { ...SELF_HOSTED, GITHUB_RUN_ID: "9", GITHUB_JOB: "build", GITHUB_RUN_ATTEMPT: "1" },
    dryRun: false,
    log: () => undefined,
    warn: (m) => warnings.push(m),
  });
  assert.equal(prepared.root, null);
  assert.match(warnings.join("\n"), /in use/);
});

test("writeFileAtomic replaces content without leaving temp files", () => {
  const dir = mkTmp();
  const file = path.join(dir, "sub", "f.json");
  writeFileAtomic(file, "one");
  writeFileAtomic(file, "two");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["f.json"]);
});

// --- the gates ----------------------------------------------------------

test("with a persistent root every save is skipped and every restore bypassed; verdicts still publish", async () => {
  process.env["GITHUB_EVENT_NAME"] = "push";
  delete process.env[PERSISTENT_ROOT_ENV];
  const logs: string[] = [];
  assert.equal(remoteCacheBypassed("build-cache", (m) => logs.push(m)), false);
  assert.equal(allowCacheSave("build-cache", (m) => logs.push(m)), true);

  process.env[PERSISTENT_ROOT_ENV] = "/srv/root";
  assert.equal(remoteCacheBypassed("build-cache", (m) => logs.push(m)), true);
  assert.equal(allowCacheSave("target-cache", (m) => logs.push(m)), false);
  assert.match(logs.join("\n"), /target-cache: save skipped: persistent-root \/srv\/root/);
  assert.equal(allowVerdictSave(() => undefined), true);

  let calls = 0;
  const restoreCache = async (): Promise<string | undefined> => {
    calls += 1;
    return "k";
  };
  const dir = mkTmp();
  const single = await restoreCookCache({
    exactKey: "k",
    archivePath: path.join(dir, "a.tar.zst"),
    targetDir: path.join(dir, "t"),
    longWindow: 27,
    debug: false,
    log: () => undefined,
    restoreCache,
  } as Parameters<typeof restoreCookCache>[0]);
  assert.equal(calls, 0, "the legacy single cook layer never leaves the runner");
  // #675: the layered cook base reads through the root's local store; only
  // a local miss reaches the remote cache, once, for the base layer alone.
  const layered = await restoreLayeredCookCacheArchives({
    baseKey: "b",
    deltaKey: "d",
    baseArchivePath: path.join(dir, "b.tar.zst"),
    deltaArchivePath: path.join(dir, "d.tar.zst"),
    log: () => undefined,
    restoreCache,
  } as Parameters<typeof restoreLayeredCookCacheArchives>[0]);
  assert.equal(calls, 1, "one remote base read after a local cook-store miss");
  assert.equal(single.hit, false);
  assert.equal(layered.base.matchedKey, "");
});

test("contract: every Actions-cache restore call site is gated or reviewed", () => {
  // A new restoreCache call must either go through remoteCacheBypassed or be
  // added here with the reason it is safe on a persistent root.
  const reviewed: Record<string, string> = {
    "src/main.ts": "restoreCacheSafe and the solo-toolchain probes (solo is forced off) are gated",
    "src/post.ts": "exact-key probes after a save, which allowCacheSave already refused",
    "src/lib/cook-cache.ts": "restoreCookCache is gated; restoreLayeredCookCacheArchives reads its local store first and the remote base only on a miss (#675)",
    "src/lib/solo-toolchain-cache.ts": "solo-toolchain-cache is forced off by resolveSetup",
    "src/lib/soldr-mini-cache.ts": "soldr-mini-cache is forced off by resolveSetup",
    "src/lib/verdict-setup.ts": "verdicts are proof of finished work and stay on every profile",
  };
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") && /\brestoreCache\(|\.restoreCache\(|restoreCache\s*\?\?/.test(fs.readFileSync(p, "utf8"))) {
        found.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  for (const file of found) assert.ok(file in reviewed, `${file} restores from the Actions cache without a persistent-root review`);
  for (const gated of ["src/main.ts", "src/lib/cook-cache.ts"]) {
    assert.match(fs.readFileSync(gated, "utf8"), /remoteCacheBypassed\(/, gated);
  }
});

// --- resolveSetup layout ------------------------------------------------

test("resolveSetup moves cache-dir, zccache, RUSTUP_HOME and CARGO_HOME under the root and drops Actions-cache layers", async () => {
  const base = mkTmp();
  const workspace = path.join(base, "ws");
  const runnerTemp = path.join(base, "tmp");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(path.join(workspace, "Cargo.lock"), "# lock\n");
  const root = path.join(base, "persist");
  const env: Record<string, string | undefined> = {
    ACTION_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    HOME: path.join(base, "home"),
    CARGO_HOME: "/usr/local/cargo",
    RUSTUP_HOME: "/usr/local/rustup",
    INPUT_VERSION: "0.7.11",
    INPUT_TIMESTAMPS: "false",
    "INPUT_CARGO-REGISTRY-CACHE": "true",
    "INPUT_SOLO-TOOLCHAIN-CACHE": "true",
    "INPUT_PERSISTENT-ROOT": root,
  };
  const ctx: ActionContext = {
    env,
    workspace,
    runnerTemp,
    runnerOs: "Linux",
    runnerArch: "X64",
    githubSha: "0123456789abcdef",
    githubToken: "",
    parentSha: "",
    logger: createLogger(env),
  };
  const inputs = readRawInputs(env);
  const result = await resolveSetup(ctx, inputs, {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
  const layout = persistentLayout(root);
  assert.equal(result.persistentRoot, root);
  assert.equal(result.cargoHome, layout.cargoHome);
  assert.equal(result.rustupHome, layout.rustupHome);
  assert.ok(result.setupCache.setupCachePath.startsWith(root + path.sep), result.setupCache.setupCachePath);
  assert.ok(result.buildCache.path.startsWith(root + path.sep), `zccache ${result.buildCache.path}`);
  assert.equal(result.cargoRegistryCache.enabled, false);
  assert.equal(result.targetCache.enabled, false);
  assert.equal(inputs.soloToolchainCache, "false");
  assert.equal(inputs.soldrMiniCache, "false");
});

// --- ledger -------------------------------------------------------------

test("ledger: a persistent layer hits only when it held content the phase left alone", () => {
  const dir = mkTmp();
  const empty = probeDir(path.join(dir, "missing"));
  fs.mkdirSync(path.join(dir, "toolchains", "1.95.0"), { recursive: true });
  fs.writeFileSync(path.join(dir, "toolchains", "1.95.0", "rustc"), "12345");
  const before = probeDir(path.join(dir, "toolchains"));
  assert.equal(before.bytes, 5);
  assert.equal(persistentLayerStatus(empty, before), "miss");
  assert.equal(persistentLayerStatus(before, probeDir(path.join(dir, "toolchains"))), "hit");
  fs.mkdirSync(path.join(dir, "toolchains", "nightly"));
  assert.equal(persistentLayerStatus(before, probeDir(path.join(dir, "toolchains"))), "miss");
});

test("ledger: a hit is credited with the duration of the layer's last miss on the root", () => {
  const root = mkTmp();
  appendLedgerHistory(root, { at: "t1", runId: "1", layers: [{ layer: "rust-toolchain", status: "miss", durationMs: 61_000 }] });
  appendLedgerHistory(root, { at: "t2", runId: "2", layers: [{ layer: "rust-toolchain", status: "hit", durationMs: 300 }] });
  const history = readLedgerHistory(root);
  assert.equal(history.length, 2);
  assert.equal(lastMissDurationMs(history, "rust-toolchain"), 61_000);
  assert.equal(lastMissDurationMs(history, "soldr"), null);

  const ledger = summarizeLedger("persistent-root", root, "clean", [
    { layer: "rust-toolchain", status: "hit", bytes: 1000, durationMs: 300, savedMs: 61_000 },
    { layer: "soldr", status: "miss", bytes: 10, durationMs: 2000, savedMs: null },
  ]);
  assert.deepEqual(ledger.totals, { hits: 1, partial: 0, misses: 1, bytes: 1010, durationMs: 2300, savedMs: 61_000 });
  assert.match(describeLedger(ledger), /persistent-root \(clean\) hits=1 partial=0 misses=1 .*saved=61\.0s/);
});

test("ledger: hosted restores map exact to hit, restore-key to partial, none to miss", () => {
  const layers = ledgerLayersFromRestores([
    { label: "setup-cache", operation: "restore", hit: true, matchedKey: "a", archiveBytes: 5, durationMs: 100 },
    { label: "build-cache", operation: "restore", hit: false, matchedKey: "old", archiveBytes: 9, durationMs: 200 },
    { label: "target-cache", operation: "restore", hit: false, matchedKey: "", archiveBytes: null, durationMs: 50 },
    { label: "build-cache", operation: "save", hit: false, matchedKey: "", archiveBytes: 1, durationMs: 1 },
  ]);
  assert.deepEqual(layers.map((l) => [l.layer, l.status]), [["setup-cache", "hit"], ["build-cache", "partial"], ["target-cache", "miss"]]);
});

// --- post ---------------------------------------------------------------

test("post marks the root clean only when setup completed", async () => {
  const { closePersistentRootIfComplete } = (await import("../src/post.js")) as {
    closePersistentRootIfComplete: (log: (m: string) => void, warn: (m: string) => void, getState: (n: string) => string) => void;
  };
  const root = mkTmp();
  openPersistentSession(root, identity("dell-1", "1"));
  const warnings: string[] = [];
  closePersistentRootIfComplete(() => undefined, (m) => warnings.push(m), (n) => ({ persistentRoot: root, persistentMainComplete: "false" })[n] ?? "");
  assert.equal(fs.existsSync(path.join(root, CLEAN_MARKER)), false);
  assert.match(warnings.join("\n"), /left unclean/);
  closePersistentRootIfComplete(() => undefined, () => undefined, (n) => ({ persistentRoot: root, persistentMainComplete: "true" })[n] ?? "");
  assert.equal(fs.existsSync(path.join(root, CLEAN_MARKER)), true);
});
