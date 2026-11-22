import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  auditDependencyYanks,
  cratesIoSparsePath,
  readRegistryDependencies,
  waitForYankAuditResult,
  writeYankAuditResult,
  resolveYankAuditResult,
  type YankAuditDependency,
} from "../src/lib/yank-audit.js";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

function dependency(name: string, version: string): YankAuditDependency {
  return { name, version, source: CRATES_IO };
}

function sparseFetch(records: Record<string, Array<{ vers: string; yanked: boolean }>>): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const crateName = String(input).split("/").at(-1) ?? "";
    const body = (records[crateName] ?? []).map((record) => JSON.stringify(record)).join("\n");
    return new Response(body, { status: records[crateName] ? 200 : 404 });
  }) as typeof fetch;
}

function bundledWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SETUP_SOLDR_TEST_IMPORT;
  delete env.SETUP_SOLDR_SKIP_AUTOSTART;
  return env;
}

test("Cargo.lock parser selects registry packages and deduplicates the closure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-lock-"));
  try {
    const lockfile = path.join(root, "Cargo.lock");
    fs.writeFileSync(lockfile, `
version = 4

[[package]]
name = "workspace"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "${CRATES_IO}"

[[package]]
name = "serde"
version = "1.0.0"
source = "${CRATES_IO}"

[[package]]
name = "git-dep"
version = "2.0.0"
source = "git+https://example.invalid/repo"
`, "utf8");
    assert.deepEqual(readRegistryDependencies(lockfile), [dependency("serde", "1.0.0")]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sparse-index paths follow the crates.io name layout", () => {
  assert.equal(cratesIoSparsePath("a"), "1/a");
  assert.equal(cratesIoSparsePath("ab"), "2/ab");
  assert.equal(cratesIoSparsePath("abc"), "3/a/abc");
  assert.equal(cratesIoSparsePath("Serde_JSON"), "se/rd/serde_json");
});

test("audit reports the yanked crate and version", async () => {
  const result = await auditDependencyYanks(
    [dependency("serde", "1.0.0"), dependency("itoa", "1.0.0")],
    {
      fetchImpl: sparseFetch({
        serde: [{ vers: "1.0.0", yanked: true }],
        itoa: [{ vers: "1.0.0", yanked: false }],
      }),
    },
  );
  assert.equal(result.status, "yanked");
  assert.deepEqual(result.yanked, [{ name: "serde", version: "1.0.0" }]);
  assert.equal(result.checkedCount, 2);
});

test("audit reports clean only after every registry dependency is checked", async () => {
  const result = await auditDependencyYanks([dependency("serde", "1.0.0")], {
    fetchImpl: sparseFetch({ serde: [{ vers: "1.0.0", yanked: false }] }),
  });
  assert.equal(result.status, "clean");
  assert.equal(result.checkedCount, 1);
  assert.deepEqual(result.errors, []);
});

test("large restored closure checks all 488 dependencies", async () => {
  const dependencies = Array.from({ length: 488 }, (_, index) => dependency(`crate-${index}`, "1.0.0"));
  const result = await auditDependencyYanks(dependencies, {
    fetchImpl: (async () => new Response('{"vers":"1.0.0","yanked":false}\n')) as typeof fetch,
    overallTimeoutMs: 5_000,
  });
  assert.equal(result.status, "clean");
  assert.equal(result.checkedCount, 488);
});

test("registry failure and unsupported registries are not checked, never clean", async () => {
  const unreachable = await auditDependencyYanks([dependency("serde", "1.0.0")], {
    fetchImpl: (async () => { throw new Error("network unreachable"); }) as typeof fetch,
  });
  assert.equal(unreachable.status, "not-checked");
  assert.match(unreachable.errors?.[0] ?? "", /network unreachable/);

  const unsupported = await auditDependencyYanks([
    { name: "private", version: "1.2.3", source: "registry+https://registry.example/index" },
  ]);
  assert.equal(unsupported.status, "not-checked");
  assert.match(unsupported.errors?.[0] ?? "", /not supported/);
});

test("one global deadline aborts every stalled request wave before post joins", async () => {
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
  const dependencies = Array.from({ length: 40 }, (_, index) =>
    dependency(`crate-${index}`, "1.0.0"));
  const started = Date.now();
  const result = await auditDependencyYanks(dependencies, {
    fetchImpl: stalledFetch,
    concurrency: 2,
    requestTimeoutMs: 5_000,
    overallTimeoutMs: 25,
  });
  assert.equal(result.status, "not-checked");
  assert.ok(Date.now() - started < 1_000, "global deadline must not wait for successive waves");
  assert.ok(result.errors?.some((error) => /aborted|deadline/.test(error)));
});

test("global deadline settles even when a fetch ignores its abort signal", async () => {
  const neverSettles = (() => new Promise<Response>(() => {})) as typeof fetch;
  const started = Date.now();
  const result = await auditDependencyYanks([dependency("serde", "1.0.0")], {
    fetchImpl: neverSettles,
    requestTimeoutMs: 10,
    overallTimeoutMs: 25,
  });
  assert.equal(result.status, "not-checked");
  assert.equal(result.auditTimedOut, true);
  assert.ok(Date.now() - started < 1_000);
});

test("post join waits for a pending worker result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-result-"));
  try {
    const resultPath = path.join(root, "result.json");
    writeYankAuditResult(resultPath, { status: "pending" });
    setTimeout(() => writeYankAuditResult(resultPath, {
      status: "clean",
      checkedAt: new Date().toISOString(),
      dependencyCount: 1,
      checkedCount: 1,
    }), 20);
    const result = await waitForYankAuditResult(resultPath, { timeoutMs: 1_000, pollMs: 5 });
    assert.equal(result.status, "clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post join timeout is reported as not checked", async () => {
  const result = await waitForYankAuditResult("missing-result.json", {
    timeoutMs: 10,
    pollMs: 2,
  });
  assert.equal(result.status, "not-checked");
  assert.equal(result.joinTimedOut, true);
  assert.match(result.errors?.[0] ?? "", /did not finish/);
});

test("bundled audit worker writes a terminal result for an empty closure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-bundle-"));
  try {
    const config = path.join(root, "config.json");
    const result = path.join(root, "result.json");
    fs.writeFileSync(config, JSON.stringify({ dependencies: [], requestTimeoutMs: 100, overallTimeoutMs: 100 }));
    const child = spawn(process.execPath, [path.resolve("dist/main.js"), "--setup-soldr-yank-audit-worker", config, result], { env: bundledWorkerEnv(), stdio: "pipe" });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.equal(JSON.parse(fs.readFileSync(result, "utf8")).status, "clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled worker crash leaves a non-clean result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-crash-"));
  try {
    const result = path.join(root, "result.json");
    const child = spawn(process.execPath, [path.resolve("dist/main.js"), "--setup-soldr-yank-audit-worker", path.join(root, "missing-config.json"), result], { env: bundledWorkerEnv(), stdio: "pipe" });
    await new Promise((resolve) => child.on("close", resolve));
    assert.equal(JSON.parse(fs.readFileSync(result, "utf8")).status, "not-checked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("killed bundled worker leaves pending and a foreground recheck recovers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-kill-"));
  try {
    const result = path.join(root, "result.json");
    const config = path.join(root, "config.json");
    const preload = path.join(root, "stall.cjs");
    fs.writeFileSync(config, JSON.stringify({ dependencies: [dependency("serde", "1.0.0")], requestTimeoutMs: 5_000, overallTimeoutMs: 5_000 }));
    fs.writeFileSync(preload, "globalThis.fetch = () => new Promise(() => {});\n");
    writeYankAuditResult(result, { status: "pending" });
    const child = spawn(process.execPath, [path.resolve("dist/main.js"), "--setup-soldr-yank-audit-worker", config, result], {
      env: { ...bundledWorkerEnv(), NODE_OPTIONS: `--require=${preload}` }, stdio: "pipe",
    });
    await new Promise<void>((resolve, reject) => {
      // Liveness, not a stopwatch: a worker that exits fails at once, and a live
      // one may take as long as a loaded host needs (a fixed 3 s flaked at load
      // ~120). The 60 s cap only stops a wedged worker from using the whole
      // per-test timeout.
      let exited = false;
      child.once("exit", () => { exited = true; });
      const deadline = Date.now() + 60_000;
      const poll = () => {
        if (JSON.parse(fs.readFileSync(result, "utf8")).workerPid === child.pid) resolve();
        else if (exited) reject(new Error("bundled worker exited before reporting ready"));
        else if (Date.now() > deadline) reject(new Error("bundled worker never reported ready"));
        else setTimeout(poll, 10);
      };
      poll();
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
    const recovered = await resolveYankAuditResult(result, async () => ({ status: "clean", dependencyCount: 1, checkedCount: 1 }), {
      startedAtMs: Date.now() - 100, backgroundDeadlineMs: 50, fallbackDeadlineMs: 100,
    });
    assert.equal(recovered.status, "clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lost and hung bundled workers trigger a bounded foreground recheck", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-yank-recheck-"));
  try {
    const result = path.join(root, "result.json");
    writeYankAuditResult(result, { status: "pending" });
    let calls = 0;
    const audit = async () => {
      calls += 1;
      return { status: "clean" as const, dependencyCount: 1, checkedCount: 1 };
    };
    const recovered = await resolveYankAuditResult(result, audit, { backgroundDeadlineMs: 10, fallbackDeadlineMs: 100 });
    assert.equal(recovered.status, "clean");
    assert.equal(calls, 1);
    writeYankAuditResult(result, { status: "not-checked", errors: ["worker failed before finishing"] });
    const retried = await resolveYankAuditResult(result, audit, { backgroundDeadlineMs: 10, fallbackDeadlineMs: 100 });
    assert.equal(retried.status, "clean");
    assert.equal(calls, 2);
    writeYankAuditResult(result, { status: "not-checked", yanked: [{ name: "serde", version: "1.0.0" }], errors: ["deadline"] });
    const poisoned = await resolveYankAuditResult(result, audit, { backgroundDeadlineMs: 10, fallbackDeadlineMs: 100 });
    assert.equal(poisoned.status, "yanked");
    assert.equal(calls, 2);
    writeYankAuditResult(result, { status: "pending" });
    const stalled = await resolveYankAuditResult(result, () => new Promise(() => {}), { backgroundDeadlineMs: 10, fallbackDeadlineMs: 10 });
    assert.equal(stalled.status, "not-checked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
