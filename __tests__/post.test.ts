import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

test("post payload fail policy marks failure and cache reservation races require proof", async () => {
  const mod = (await import("../src/post.js")) as {
    applyCachePayloadOversizeAction: (
      action: "skip" | "fail",
      message: string,
      setFailed: (message: string) => void,
    ) => "oversize-skip" | "failed";
    classifyCacheSaveReservation: (
      id: number,
      key: string,
      probe: () => Promise<string | undefined>,
    ) => Promise<"saved" | "race-skip" | "failed">;
  };
  const failures: string[] = [];
  assert.equal(
    mod.applyCachePayloadOversizeAction("fail", "payload too large", (message) => failures.push(message)),
    "failed",
  );
  assert.deepEqual(failures, ["payload too large"]);
  assert.equal(
    mod.applyCachePayloadOversizeAction("skip", "payload too large", (message) => failures.push(message)),
    "oversize-skip",
  );
  assert.deepEqual(failures, ["payload too large"]);
  assert.equal(await mod.classifyCacheSaveReservation(42, "key", async () => undefined), "saved");
  assert.equal(await mod.classifyCacheSaveReservation(-1, "key", async () => "key"), "race-skip");
  assert.equal(await mod.classifyCacheSaveReservation(-1, "key", async () => undefined), "failed");
  assert.equal(
    await mod.classifyCacheSaveReservation(-1, "key", async () => {
      throw new Error("probe failed");
    }),
    "failed",
  );
});

test("#538 dylintMarkerIdentityMatches accepts the host-qualified channel Soldr actually writes", async () => {
  const mod = (await import("../src/post.js")) as {
    dylintMarkerIdentityMatches: (
      markerContent: string,
      cacheIdentity: string,
      hostTriple: string,
    ) => boolean;
  };
  const release = "1.98.0-nightly";
  const commit = "57d06900fd7d9ee06d3a7f323bb77f17ab3cfaf8";
  const cacheIdentity = `nightly-2026-05-28|${release}|${commit}`;
  const hostTriple = "x86_64-unknown-linux-gnu";
  // What `soldr dylint`/`soldr cargo dylint` actually writes to the marker
  // (crates/soldr-cli/src/dylint_toolchain.rs `qualify_toolchain_name`),
  // captured verbatim from zackees/template-python-rust-cmd run 36496358860,
  // job 109176814466.
  const markerContent = `nightly-2026-05-28-x86_64-unknown-linux-gnu|${release}|${commit}\n`;
  assert.equal(mod.dylintMarkerIdentityMatches(markerContent, cacheIdentity, hostTriple), true);
});

test("#538 dylintMarkerIdentityMatches still matches an exact (unqualified) marker", async () => {
  const mod = (await import("../src/post.js")) as {
    dylintMarkerIdentityMatches: (
      markerContent: string,
      cacheIdentity: string,
      hostTriple: string,
    ) => boolean;
  };
  const identity = "nightly-2026-05-28|1.98.0-nightly|57d06900fd7d9ee06d3a7f323bb77f17ab3cfaf8";
  assert.equal(
    mod.dylintMarkerIdentityMatches(`${identity}\n`, identity, "x86_64-unknown-linux-gnu"),
    true,
  );
});

test("#538 dylintMarkerIdentityMatches rejects a genuinely different compiler identity", async () => {
  const mod = (await import("../src/post.js")) as {
    dylintMarkerIdentityMatches: (
      markerContent: string,
      cacheIdentity: string,
      hostTriple: string,
    ) => boolean;
  };
  const cacheIdentity = "nightly-2026-05-28|1.98.0-nightly|57d06900fd7d9ee06d3a7f323bb77f17ab3cfaf8";
  const hostTriple = "x86_64-unknown-linux-gnu";
  // Different commit hash: must NOT match even with host-qualification.
  assert.equal(
    mod.dylintMarkerIdentityMatches(
      "nightly-2026-05-28-x86_64-unknown-linux-gnu|1.98.0-nightly|deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      cacheIdentity,
      hostTriple,
    ),
    false,
  );
  // Different host triple qualifying the channel: must NOT match.
  assert.equal(
    mod.dylintMarkerIdentityMatches(
      "nightly-2026-05-28-aarch64-apple-darwin|1.98.0-nightly|57d06900fd7d9ee06d3a7f323bb77f17ab3cfaf8",
      cacheIdentity,
      hostTriple,
    ),
    false,
  );
  // Empty marker/identity: must NOT match.
  assert.equal(mod.dylintMarkerIdentityMatches("", cacheIdentity, hostTriple), false);
  assert.equal(mod.dylintMarkerIdentityMatches("garbage", cacheIdentity, hostTriple), false);
});

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

test("#543 computeJobNewCompiles sums misses across every archived session, not just the newest", async () => {
  const mod = (await import("../src/post.js")) as {
    computeJobNewCompiles: (buildCachePath: string) => number | null;
  };
  const root = mkTmp("job-new-compiles-");
  try {
    const cache = path.join(root, "zccache");
    const archiveDir = path.join(cache, "logs", "archive");
    // Reproduces setup-soldr#543 / zackees/template-python-rust-cmd run
    // 36514690030: a job that ran multiple cargo invocations (e.g. build
    // then test), each its own zccache session archived by
    // `shutdownCacheDaemons`'s `--archive-logs`. The first session did a
    // heavy, genuinely-new compile (130 misses); the LAST session (the one
    // a single most-recent-mtime lookup would pick) compiled almost
    // nothing (1 miss) because it reused what the first session just
    // built. The job-wide new-compile count must be the sum, not the last
    // session alone.
    const session1 = path.join(archiveDir, "session-1");
    fs.mkdirSync(session1, { recursive: true });
    fs.writeFileSync(
      path.join(session1, "last-session-stats.json"),
      JSON.stringify({ status: "ok", session_id: "session-1", hits: 5, misses: 130 }),
    );
    // Second session written slightly later so a naive mtime-based
    // "most recent session" pick lands here.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const session2 = path.join(archiveDir, "session-2");
    fs.mkdirSync(session2, { recursive: true });
    fs.writeFileSync(
      path.join(session2, "last-session-stats.json"),
      JSON.stringify({ status: "ok", session_id: "session-2", hits: 40, misses: 1 }),
    );

    const total = mod.computeJobNewCompiles(cache);
    // Before the fix this returned 1 (the last session's misses alone),
    // which is `< build-cache-save-min-compiles=1`'s complement — actually
    // NOT below the default threshold of 1, so assert the real regression
    // shape: threshold 2 would wrongly skip on "1" but must not skip once
    // the true 131-compile delta is counted.
    assert.equal(total, 131, "must sum misses across all archived sessions for this job");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#573 computeJobNewCompiles counts nested front-door builds filed only in history", async () => {
  const mod = (await import("../src/post.js")) as {
    computeJobNewCompiles: (buildCachePath: string, sinceMs?: number) => number | null;
  };
  const root = mkTmp("job-new-compiles-history-");
  try {
    const cache = path.join(root, "zccache");
    const writeStats = (dir: string, body: Record<string, unknown>, mtimeMs?: number): void => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "last-session-stats.json");
      fs.writeFileSync(file, JSON.stringify(body));
      if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    };
    // History restored with the cache keeps its old mtime and must not count.
    writeStats(path.join(cache, "history", "1"), { status: "ok", session_id: "old", misses: 900 }, 1_000_000);
    const baseline = Date.now() - 1_000;
    // zackees/bosn#503: `./install` ran `soldr cargo build` under uv's PEP 517
    // backend (6 misses); post's archive held only the final 0-miss session.
    writeStats(path.join(cache, "history", "2"), { status: "ok", session_id: "nested", hits: 356, misses: 6 });
    writeStats(path.join(cache, "history", "3"), { status: "ok", session_id: "last", hits: 3, misses: 0 });
    writeStats(path.join(cache, "logs", "archive", "s-last"), { status: "ok", session_id: "last", hits: 3, misses: 0 });

    assert.equal(mod.computeJobNewCompiles(cache, baseline), 6);
    // No baseline: restored history is never mistaken for new work.
    assert.equal(mod.computeJobNewCompiles(cache), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#543 computeJobNewCompiles falls back to the single-session summary when no sessions were archived", async () => {
  const mod = (await import("../src/post.js")) as {
    computeJobNewCompiles: (buildCachePath: string) => number | null;
  };
  const root = mkTmp("job-new-compiles-fallback-");
  try {
    const cache = path.join(root, "zccache");
    const logs = path.join(cache, "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "last-session-stats.json"),
      JSON.stringify({ status: "ok", hits: 2, misses: 7 }),
    );
    // No logs/archive dir at all — older soldr, or archiving unavailable.
    assert.equal(mod.computeJobNewCompiles(cache), 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("src/post.ts imports cleanly and exposes `run`", async () => {
  const mod = (await import("../src/post.js")) as { run?: () => Promise<void> };
  assert.equal(typeof mod.run, "function");
});

test("#247 resolveZccacheSessionJournalPath finds the journal under the private-daemon layout", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveZccacheSessionJournalPath: (cacheDir: string) => string;
  };
  const root = mkTmp("journal-private-");
  try {
    const cache = path.join(root, "zccache");
    // soldr's private daemon session layout: NOT <cache>/logs/, but
    // <cache>/private/<id>/logs/last-session.jsonl
    const sessLogs = path.join(cache, "private", "soldr-dev-abc123", "logs");
    fs.mkdirSync(sessLogs, { recursive: true });
    const journal = path.join(sessLogs, "last-session.jsonl");
    fs.writeFileSync(journal, '{"outcome":"miss"}\n');

    const resolved = mod.resolveZccacheSessionJournalPath(cache);
    assert.equal(resolved, journal);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#247 resolveZccacheSessionJournalPath falls back to the bare logs path when nothing exists", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveZccacheSessionJournalPath: (cacheDir: string) => string;
  };
  const root = mkTmp("journal-empty-");
  try {
    const cache = path.join(root, "zccache");
    fs.mkdirSync(cache, { recursive: true });
    const resolved = mod.resolveZccacheSessionJournalPath(cache);
    assert.equal(resolved, path.join(cache, "logs", "last-session.jsonl"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#247 resolveZccacheSessionJournalPath prefers the bare logs path when present (legacy layout)", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveZccacheSessionJournalPath: (cacheDir: string) => string;
  };
  const root = mkTmp("journal-legacy-");
  try {
    const cache = path.join(root, "zccache");
    fs.mkdirSync(path.join(cache, "logs"), { recursive: true });
    const bare = path.join(cache, "logs", "last-session.jsonl");
    fs.writeFileSync(bare, '{"outcome":"hit"}\n');
    const resolved = mod.resolveZccacheSessionJournalPath(cache);
    assert.equal(resolved, bare);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post.run no-ops when no resolveResult state present", async () => {
  const mod = (await import("../src/post.js")) as { run: () => Promise<void> };
  // Make sure GITHUB_STATE points at a temp file with no key set.
  const root = mkTmp("post-empty-state-");
  try {
    const statePath = path.join(root, "state");
    fs.writeFileSync(statePath, "", "utf8");
    const previousState = process.env["GITHUB_STATE"];
    process.env["GITHUB_STATE"] = statePath;
    try {
      await mod.run();
    } finally {
      if (previousState === undefined) delete process.env["GITHUB_STATE"];
      else process.env["GITHUB_STATE"] = previousState;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // No assertion beyond "did not throw" — the function should silently exit
  // when there's nothing to save.
});

test("post.run parses bad state gracefully", async () => {
  const mod = (await import("../src/post.js")) as { run: () => Promise<void> };
  // Inject malformed JSON via STATE_resolveResult (the @actions/core
  // toolkit env-var naming convention for getState/saveState).
  const prev = process.env["STATE_resolveResult"];
  process.env["STATE_resolveResult"] = "{not valid json";
  try {
    await mod.run();
  } finally {
    if (prev === undefined) delete process.env["STATE_resolveResult"];
    else process.env["STATE_resolveResult"] = prev;
  }
});

test("final cache summary includes zccache stats and cache layer outcomes", async () => {
  const mod = (await import("../src/post.js")) as {
    buildFinalCacheSummary: (result: any, state: any, saves: any) => any;
    formatFinalCacheSummaryMarkdown: (summary: any) => string;
  };
  const root = mkTmp("post-final-summary-");
  try {
    const buildCachePath = path.join(root, "cache", "zccache");
    const statsPath = path.join(buildCachePath, "logs", "last-session-stats.json");
    fs.mkdirSync(path.dirname(statsPath), { recursive: true });
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        status: "ok",
        session_id: "session-1",
        compilations: 10,
        hits: 7,
        misses: 3,
        non_cacheable: 2,
        errors: 1,
        hit_rate: 0.7,
      }),
      "utf8",
    );

    const result = {
      setupCache: { key: "setup-key" },
      targetCache: { key: "target-key" },
      buildCache: { key: "build-key", path: buildCachePath },
      cargoRegistryCache: { key: "registry-key" },
    };
    const summary = mod.buildFinalCacheSummary(
      result,
      {
        setupCacheEnabled: true,
        setupCacheExactHit: true,
        setupCacheMatchedKey: "setup-key",
        targetCacheEnabled: true,
        targetCacheExactHit: false,
        targetCacheMatchedKey: "target-restore-key",
        buildCacheEnabled: true,
        buildCacheExactHit: false,
        buildCacheMatchedKey: "",
        cargoRegistryCacheEnabled: false,
        cargoRegistryCacheExactHit: false,
        cargoRegistryCacheMatchedKey: "",
      },
      {
        buildCache: { status: "saved", cache_id: 42 },
        cargoRegistryCache: { status: "disabled" },
        targetCache: { status: "disabled" },
      },
    );

    assert.equal(summary.zccache_session.status, "ok");
    assert.equal(summary.zccache_session.stats.hits, 7);
    assert.equal(summary.build_cache.save.cache_id, 42);
    assert.equal(summary.target_cache.restore_status, "restore-key-hit");
    assert.equal(summary.cargo_registry_cache.restore_status, "disabled");

    const markdown = mod.formatFinalCacheSummaryMarkdown(summary);
    assert.match(markdown, /hits=7 misses=3/);
    assert.match(markdown, /saved id=42/);
    assert.match(markdown, /restore-key hit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final cache summary resolves private zccache session stats", async () => {
  const mod = (await import("../src/post.js")) as {
    buildFinalCacheSummary: (result: any, state: any, saves: any) => any;
    formatFinalCacheSummaryMarkdown: (summary: any) => string;
  };
  const root = mkTmp("post-private-session-summary-");
  try {
    const buildCachePath = path.join(root, "cache", "zccache");
    const statsPath = path.join(
      buildCachePath,
      "private",
      "soldr-dev-session",
      "logs",
      "last-session-stats.json",
    );
    fs.mkdirSync(path.dirname(statsPath), { recursive: true });
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        status: "ok",
        session_id: "soldr-dev-session",
        compilations: 12,
        hits: 5,
        misses: 7,
        hit_rate: 5 / 12,
      }),
      "utf8",
    );

    const summary = mod.buildFinalCacheSummary(
      {
        setupCache: { key: "setup-key" },
        targetCache: { key: "target-key" },
        buildCache: { key: "build-key", path: buildCachePath },
        cargoRegistryCache: { key: "registry-key" },
      },
      {
        setupCacheEnabled: false,
        setupCacheExactHit: false,
        setupCacheMatchedKey: "",
        targetCacheEnabled: false,
        targetCacheExactHit: false,
        targetCacheMatchedKey: "",
        buildCacheEnabled: true,
        buildCacheExactHit: false,
        buildCacheMatchedKey: "",
        cargoRegistryCacheEnabled: false,
        cargoRegistryCacheExactHit: false,
        cargoRegistryCacheMatchedKey: "",
      },
      {
        buildCache: { status: "disabled" },
        cargoRegistryCache: { status: "disabled" },
        targetCache: { status: "disabled" },
      },
    );

    assert.equal(summary.zccache_session.status, "ok");
    assert.equal(summary.zccache_session.stats_path, statsPath);
    assert.equal(summary.zccache_session.stats.hits, 5);
    const markdown = mod.formatFinalCacheSummaryMarkdown(summary);
    assert.match(markdown, /hits=5 misses=7/);
    assert.ok(markdown.includes(statsPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final cache summary resolves archived private zccache stats after shutdown", async () => {
  const mod = (await import("../src/post.js")) as {
    buildFinalCacheSummary: (result: any, state: any, saves: any) => any;
  };
  const root = mkTmp("post-archived-session-summary-");
  try {
    const buildCachePath = path.join(root, "cache", "zccache");
    const statsPath = path.join(
      buildCachePath,
      "logs",
      "archive",
      "soldr-dev-session",
      "last-session-stats.json",
    );
    fs.mkdirSync(path.dirname(statsPath), { recursive: true });
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        status: "ok",
        session_id: "soldr-dev-session",
        compilations: 20,
        hits: 9,
        misses: 11,
        hit_rate: 0.45,
      }),
      "utf8",
    );

    const summary = mod.buildFinalCacheSummary(
      {
        setupCache: { key: "setup-key" },
        targetCache: { key: "target-key" },
        buildCache: { key: "build-key", path: buildCachePath },
        cargoRegistryCache: { key: "registry-key" },
      },
      {
        setupCacheEnabled: false,
        setupCacheExactHit: false,
        setupCacheMatchedKey: "",
        targetCacheEnabled: false,
        targetCacheExactHit: false,
        targetCacheMatchedKey: "",
        buildCacheEnabled: true,
        buildCacheExactHit: false,
        buildCacheMatchedKey: "",
        cargoRegistryCacheEnabled: false,
        cargoRegistryCacheExactHit: false,
        cargoRegistryCacheMatchedKey: "",
      },
      {
        buildCache: { status: "disabled" },
        cargoRegistryCache: { status: "disabled" },
        targetCache: { status: "disabled" },
      },
    );

    assert.equal(summary.zccache_session.status, "ok");
    assert.equal(summary.zccache_session.stats_path, statsPath);
    assert.equal(summary.zccache_session.stats.misses, 11);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compile_cache_report reports missing-binary when SOLDR_BINARY is unset", async () => {
  const mod = (await import("../src/post.js")) as {
    buildFinalCacheSummary: (result: any, state: any, saves: any) => any;
    formatFinalCacheSummaryMarkdown: (summary: any) => string;
  };
  const root = mkTmp("post-compile-cache-missing-");
  const previousBinary = process.env["SOLDR_BINARY"];
  delete process.env["SOLDR_BINARY"];
  try {
    const result = {
      setupCache: { key: "setup-key" },
      targetCache: { key: "target-key" },
      buildCache: { key: "build-key", path: path.join(root, "cache", "zccache") },
      cargoRegistryCache: { key: "registry-key" },
    };
    const summary = mod.buildFinalCacheSummary(
      result,
      {
        setupCacheEnabled: false,
        setupCacheExactHit: false,
        setupCacheMatchedKey: "",
        targetCacheEnabled: false,
        targetCacheExactHit: false,
        targetCacheMatchedKey: "",
        buildCacheEnabled: false,
        buildCacheExactHit: false,
        buildCacheMatchedKey: "",
        cargoRegistryCacheEnabled: false,
        cargoRegistryCacheExactHit: false,
        cargoRegistryCacheMatchedKey: "",
      },
      {
        buildCache: { status: "disabled" },
        cargoRegistryCache: { status: "disabled" },
        targetCache: { status: "disabled" },
      },
    );
    assert.equal(summary.compile_cache_report.status, "missing-binary");
    assert.ok(summary.compile_cache_report.error?.includes("SOLDR_BINARY"));
    const md = mod.formatFinalCacheSummaryMarkdown(summary);
    assert.match(md, /Compile cache/);
    assert.match(md, /missing-binary/);
  } finally {
    if (previousBinary === undefined) delete process.env["SOLDR_BINARY"];
    else process.env["SOLDR_BINARY"] = previousBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compile_cache_report parses a fake soldr cache report --json output", { skip: process.platform === "win32" ? "spawnSync cannot exec a .cmd shim without shell:true; real soldr is a .exe so this only matters for the test contrivance" : false }, async () => {
  const mod = (await import("../src/post.js")) as {
    buildFinalCacheSummary: (result: any, state: any, saves: any) => any;
    formatFinalCacheSummaryMarkdown: (summary: any, mode?: string) => string;
  };
  const root = mkTmp("post-compile-cache-fake-");
  const previousBinary = process.env["SOLDR_BINARY"];
  try {
    // Write a tiny fake-soldr that prints a canned cache report JSON when
    // invoked with `cache report --json`. Unix-only test (sh hashbang
    // script). Real soldr is a .exe on Windows so production spawnSync
    // works without shell:true; the test contrivance does not.
    const fakeJson = JSON.stringify({
      schema_version: 1,
      command: "cache report",
      soldr_version: "0.7.22",
      managed_zccache_version: "1.5.0",
      session_stats_present: true,
      journal_present: true,
      last_session: { status: "ok", hits: 11, misses: 4, hit_rate: 11 / 15 },
      rollups: {
        by_extension: { rlib: { hits: 8, misses: 2, total_ms: 1200 } },
        by_tool_total_ms: { rustc: 2500, "clippy-driver": 400 },
      },
      diagnoses: [],
      notes: [],
    });
    const helperPath = path.join(root, "fake-soldr-helper.cjs");
    fs.writeFileSync(
      helperPath,
      `process.stdout.write(${JSON.stringify(fakeJson)} + '\\n');\n`,
      "utf8",
    );
    const isWindows = process.platform === "win32";
    const fakeBinary = path.join(root, isWindows ? "soldr.cmd" : "soldr");
    if (isWindows) {
      fs.writeFileSync(
        fakeBinary,
        `@echo off\r\nnode "${helperPath}"\r\n`,
        "utf8",
      );
    } else {
      fs.writeFileSync(
        fakeBinary,
        `#!/bin/sh\nexec node "${helperPath}"\n`,
        "utf8",
      );
      fs.chmodSync(fakeBinary, 0o755);
    }
    process.env["SOLDR_BINARY"] = fakeBinary;
    const result = {
      setupCache: { key: "k" },
      targetCache: { key: "k" },
      buildCache: { key: "k", path: path.join(root, "cache", "zccache") },
      cargoRegistryCache: { key: "k" },
    };
    const summary = mod.buildFinalCacheSummary(
      result,
      {
        setupCacheEnabled: false,
        setupCacheExactHit: false,
        setupCacheMatchedKey: "",
        targetCacheEnabled: false,
        targetCacheExactHit: false,
        targetCacheMatchedKey: "",
        buildCacheEnabled: false,
        buildCacheExactHit: false,
        buildCacheMatchedKey: "",
        cargoRegistryCacheEnabled: false,
        cargoRegistryCacheExactHit: false,
        cargoRegistryCacheMatchedKey: "",
      },
      {
        buildCache: { status: "disabled" },
        cargoRegistryCache: { status: "disabled" },
        targetCache: { status: "disabled" },
      },
    );
    assert.equal(summary.compile_cache_report.status, "ok");
    assert.equal(summary.compile_cache_report.soldr_version, "0.7.22");
    assert.equal(summary.compile_cache_report.managed_zccache_version, "1.5.0");
    assert.equal((summary.compile_cache_report.report as any).last_session.hits, 11);
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "detailed");
    assert.match(md, /\| Hits \| 11 \|/);
    assert.match(md, /\| Misses \| 4 \|/);
    assert.match(md, /By output extension/);
    assert.match(md, /\| rlib \| 8 \| 2 \| 1200 \|/);
    assert.match(md, /By tool \(wall-clock\)/);
    assert.match(md, /\| rustc \| 2500 \|/);
  } finally {
    if (previousBinary === undefined) delete process.env["SOLDR_BINARY"];
    else process.env["SOLDR_BINARY"] = previousBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("resolveJournalPrintRaw: default (empty) mirrors debugMode", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveJournalPrintRaw: (raw: string, debug: boolean) => boolean;
  };
  assert.equal(mod.resolveJournalPrintRaw("", true), true);
  assert.equal(mod.resolveJournalPrintRaw("", false), false);
  assert.equal(mod.resolveJournalPrintRaw("   ", true), true);
});

test("resolveJournalPrintRaw: explicit true overrides debug=false", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveJournalPrintRaw: (raw: string, debug: boolean) => boolean;
  };
  for (const v of ["true", "1", "on", "yes", "TRUE", "On", " Yes "]) {
    assert.equal(mod.resolveJournalPrintRaw(v, false), true, `truthy "${v}" should enable`);
  }
});

test("resolveJournalPrintRaw: explicit false overrides debug=true", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveJournalPrintRaw: (raw: string, debug: boolean) => boolean;
  };
  for (const v of ["false", "0", "off", "no", "FALSE", "Off", " No "]) {
    assert.equal(mod.resolveJournalPrintRaw(v, true), false, `falsy "${v}" should disable`);
  }
});

test("resolveJournalPrintRaw: unrecognized falls back to debugMode", async () => {
  const mod = (await import("../src/post.js")) as {
    resolveJournalPrintRaw: (raw: string, debug: boolean) => boolean;
  };
  assert.equal(mod.resolveJournalPrintRaw("maybe", true), true);
  assert.equal(mod.resolveJournalPrintRaw("???", false), false);
});
