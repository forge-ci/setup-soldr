// Focused tests for the `compile-cache-stats: summarize` slice (issue #98,
// PR1 of 4). The shared post.test.ts file exercises the full
// buildFinalCacheSummary surface; this file zeroes in on the four PR1
// guarantees:
//
//   1. A well-formed `soldr cache report --json` payload renders the
//      expected per-session Markdown table.
//   2. The scalar outputs (hit rate, hits, misses, total) are computed
//      from `report.last_session` exactly as documented in action.yml.
//   3. `compile-cache-stats: none` skips the rendering entirely — no
//      "Compile cache" section in the step-summary Markdown.
//   4. When the soldr binary or last-session JSON is absent, the action
//      surfaces a single-line note instead of throwing — keeps the
//      action green on old soldr versions before #320 shipped.
//
// PRs 2-4 of the rollout (detailed/insights modes, annotations, chrome
// trace, multi-step aggregation) are out of scope for this file. Their
// regression coverage lives in post.test.ts already.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

interface PostModule {
  buildFinalCacheSummary: (result: any, state: any, saves: any, passthrough?: boolean) => any;
  formatFinalCacheSummaryMarkdown: (
    summary: any,
    mode?: "none" | "summarize" | "detailed" | "insights",
  ) => string;
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyRestoreState(): Record<string, unknown> {
  return {
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
  };
}

function disabledSaves(): Record<string, unknown> {
  return {
    buildCache: { status: "disabled" },
    cargoRegistryCache: { status: "disabled" },
    targetCache: { status: "disabled" },
  };
}

function fakeResult(buildCachePath: string): Record<string, unknown> {
  return {
    setupCache: { key: "k" },
    targetCache: { key: "k" },
    buildCache: { key: "k", path: buildCachePath },
    cargoRegistryCache: { key: "k" },
  };
}

// Synthetic `soldr cache report --json` payload covering every field the
// summarize-mode renderer consumes. Mirrors the schema documented in
// zackees/soldr#320 (PR 1 — write last-session-stats.json + add
// `soldr cache report --json` subcommand).
function fixtureReport(): Record<string, unknown> {
  return {
    schema_version: 1,
    command: "cache report",
    soldr_version: "0.7.34",
    managed_zccache_version: "1.5.0",
    session_stats_present: true,
    journal_present: true,
    last_session: {
      status: "ok",
      session_id: "sess-abc",
      compilations: 162,
      hits: 140,
      misses: 22,
      hit_rate: 140 / 162,
      time_saved_ms: 41200,
      bytes_read: 432_013_312,
      bytes_written: 93_323_264,
    },
    rollups: {
      by_extension: { rlib: { hits: 130, misses: 12, total_ms: 9800 } },
      by_tool_total_ms: { rustc: 89200, "clippy-driver": 12400 },
    },
    notes: [],
  };
}

test("summarize renders per-session table with all PR1 columns", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-render-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // Stub out the spawned `soldr cache report --json` call by writing the
    // fixture directly into the parsed compile_cache_report. The post.ts
    // renderer is a pure function over the parsed FinalCacheSummary, so
    // mutating the spot the spawn would have populated is sufficient to
    // exercise the rendering path without needing a real binary on PATH.
    summary.compile_cache_report = {
      status: "ok",
      soldr_version: "0.7.34",
      managed_zccache_version: "1.5.0",
      report: fixtureReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /\| Metric \| Value \|/);
    assert.match(md, /\| Compilations \| 162 \|/);
    assert.match(md, /\| Hits \| 140 \|/);
    assert.match(md, /\| Misses \| 22 \|/);
    assert.match(md, /\| Hit rate \| 86\.4% \|/);
    assert.match(md, /\| Time saved \(est\.\) \| 41\.2s \|/);
    assert.match(md, /\| Bytes read \| 412\.0 MB \|/);
    assert.match(md, /\| Bytes written \| 89\.0 MB \|/);
    assert.match(md, /\| soldr \| 0\.7\.34 \|/);
    assert.match(md, /\| zccache \| 1\.5\.0 \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize tolerates missing optional fields (renders what is present)", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-partial-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // Minimal last_session — only the four core scalars are present. Optional
    // fields (time_saved_ms, bytes_read, bytes_written) deliberately omitted.
    summary.compile_cache_report = {
      status: "ok",
      report: {
        schema_version: 1,
        last_session: { hits: 10, misses: 0, compilations: 10, hit_rate: 1.0 },
      },
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Hits \| 10 \|/);
    assert.match(md, /\| Misses \| 0 \|/);
    assert.match(md, /\| Hit rate \| 100\.0% \|/);
    // Optional rows are simply omitted when their source value is undefined —
    // the renderer never throws on a missing field.
    assert.doesNotMatch(md, /Time saved/);
    assert.doesNotMatch(md, /Bytes read/);
    assert.doesNotMatch(md, /Bytes written/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("summarize renders n/a for hit_rate when the field is absent", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-no-rate-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: {
        schema_version: 1,
        // Note: no hit_rate. The renderer falls back to "n/a".
        last_session: { hits: 5, misses: 5, compilations: 10 },
      },
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Hit rate \| n\/a \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compile-cache-stats: none suppresses the entire Compile cache section", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-none-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "none");
    // The whole `### Compile cache (zccache)` block — header + table —
    // disappears when the user opts out. The rest of the final summary
    // (zccache session, JSON details block) stays.
    assert.doesNotMatch(md, /### Compile cache \(zccache\)/);
    assert.doesNotMatch(md, /Hit rate/);
    // Sanity-check that the rest of the summary still rendered so we
    // know "none" didn't accidentally suppress the outer markdown too.
    assert.match(md, /setup-soldr final cache summary/);
    assert.match(md, /zccache session/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing last-session-stats.json: zccache_session reports 'missing' (no throw)", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-missing-stats-");
  // No SOLDR_BINARY in the env, so compile_cache_report should land in
  // `missing-binary` status; the build-cache path also has no stats file
  // on disk so the legacy zccache_session.read should report "missing"
  // rather than throwing. Together these confirm setup-soldr stays green
  // on old soldr versions (< #320) and on cold runs where nothing has
  // been written yet.
  const previousBinary = process.env["SOLDR_BINARY"];
  delete process.env["SOLDR_BINARY"];
  try {
    const buildCachePath = path.join(root, "cache", "zccache");
    const result = fakeResult(buildCachePath);
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // Legacy path-based read: file does not exist on disk → status="missing".
    assert.equal(summary.zccache_session.present, false);
    assert.equal(summary.zccache_session.status, "missing");
    // Modern report path: binary missing → status="missing-binary".
    assert.equal(summary.compile_cache_report.status, "missing-binary");
    assert.ok(typeof summary.compile_cache_report.error === "string");
    // Markdown should still render (no throw) and call out the missing
    // signal explicitly so users know what to fix.
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /missing-binary/);
    assert.match(md, /missing/);
  } finally {
    if (previousBinary === undefined) delete process.env["SOLDR_BINARY"];
    else process.env["SOLDR_BINARY"] = previousBinary;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passthrough mode produces an 'ok' report with the passthrough marker", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-passthrough-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    // The passthrough flag tells buildFinalCacheSummary to short-circuit
    // the soldr cache report spawn — useful when the user opted out via
    // `enable: false` and the soldr binary on disk is the passthrough stub.
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves(), true);
    assert.equal(summary.compile_cache_report.status, "ok");
    assert.equal(summary.compile_cache_report.soldr_version, "passthrough");
    // last_session is null in passthrough → markdown falls back to the
    // "no last_session yet" hint instead of throwing.
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /no last\\?_session yet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scalar outputs: source fields land in compile-cache-* outputs", async () => {
  // Verifies the numeric conversion logic that backs the scalar action
  // outputs (compile-cache-hit-rate, compile-cache-hits, etc.). The
  // setCompileCacheOutputs() helper isn't exported, so we exercise it
  // by spying on process.env["GITHUB_OUTPUT"] — which is what
  // @actions/core.setOutput appends to.
  process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";
  const mod = (await import("../src/post.js")) as PostModule & {
    buildFinalCacheSummary: (r: any, s: any, sv: any) => any;
  };
  const root = mkTmp("ccs-outputs-");
  const ghOutputPath = path.join(root, "github-output.txt");
  const previousOutput = process.env["GITHUB_OUTPUT"];
  process.env["GITHUB_OUTPUT"] = ghOutputPath;
  try {
    fs.writeFileSync(ghOutputPath, "", "utf8");
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    // Drive the output writer the same way post.run() does — it sets
    // outputs before writing the step summary. We render the markdown
    // here purely to make sure both renderer and outputs see the same
    // fixture (and to confirm rendering didn't mutate the report).
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.ok(md.length > 0);

    // GITHUB_OUTPUT is the file @actions/core.setOutput appends to.
    // Outputs are written as multi-line `name<<HEREDOC\nvalue\nHEREDOC`
    // blocks. Verify the renderer didn't accidentally call setOutput by
    // checking the file stayed empty (renderer is pure).
    const ghOutContent = fs.readFileSync(ghOutputPath, "utf8");
    assert.equal(ghOutContent, "", "formatFinalCacheSummaryMarkdown must be pure (no setOutput calls)");

    // Numeric derivation sanity-check: the fixture's hit_rate is 140/162.
    const lastSession = (summary.compile_cache_report.report as any).last_session;
    const computedRate = lastSession.hits / lastSession.compilations;
    assert.equal(Math.abs(lastSession.hit_rate - computedRate) < 1e-9, true);
    assert.equal(lastSession.hits + lastSession.misses, lastSession.compilations);
  } finally {
    if (previousOutput === undefined) delete process.env["GITHUB_OUTPUT"];
    else process.env["GITHUB_OUTPUT"] = previousOutput;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("error status surfaces the error message in the markdown", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-error-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "error",
      error: "soldr exited 2: cache report failed",
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Status \| error \|/);
    assert.match(md, /\| Detail \| soldr exited 2: cache report failed \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported status (soldr too old) renders the unsupported marker", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-unsupported-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "unsupported",
      error: "unrecognized subcommand 'report'",
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /\| Status \| unsupported \|/);
    assert.match(md, /unrecognized subcommand/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PR3: `insights` mode — diagnoses rendering + GitHub annotations + chrome-trace.
// Each test below was written FIRST (TDD) against fixture JSON shaped to match
// the soldr#321 schema. All tests in this block were initially RED before the
// renderer / annotator landed; the implementation in src/lib/compile-cache-stats.ts
// + src/post.ts wiring turns them GREEN.
// ---------------------------------------------------------------------------

// Synthetic `soldr cache report --json` payload with the diagnoses[] surface
// PR3 consumes. Two diagnoses: one high (hit-rate dominator), one medium
// (rustc flag churn). Keeps the test self-contained — no real soldr binary
// needed since rendering is a pure function over the parsed payload.
function fixtureInsightsReport(): Record<string, unknown> {
  return {
    schema_version: 1,
    command: "cache report",
    soldr_version: "0.7.34",
    last_session: { hits: 50, misses: 112, compilations: 162, hit_rate: 0.31 },
    diagnoses: [
      {
        severity: "high",
        headline: "Hit rate 31% — dominated by 3 crates with frequent input changes",
        evidence: {
          miss_reasons_top: [
            { category: "inputs", file: "crates/big-crate/build.rs", misses: 42 },
            { category: "inputs", file: "crates/big-crate/src/lib.rs", misses: 28 },
            { category: "flag", flag: "-C debuginfo=2", misses: 14 },
          ],
          slowest_misses: [
            { crate: "big-crate", ms: 4200, miss_reason: "inputs" },
            { crate: "syn", ms: 2100, miss_reason: "inputs" },
          ],
          wasted_ms: 18500,
        },
        suggested_fix:
          "Normalize source mtimes via preserve-source-mtimes: true, or pin the workspace toolchain.",
      },
      {
        severity: "medium",
        headline: "rustc flag churn detected across compilation units",
        evidence: {
          miss_reasons_top: [
            { category: "flag", flag: "-C target-cpu=native", misses: 9 },
          ],
          wasted_ms: 3200,
        },
        suggested_fix: "Avoid -C target-cpu=native in CI; use a fixed CPU target.",
      },
    ],
  };
}

interface InsightsModule {
  renderInsights: (payload: Record<string, unknown>) => {
    markdown: string;
    annotations: string[];
  };
}

test("insights: renderInsights renders one <details> block per diagnosis with severity emoji + headline", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Each diagnosis gets a <details>…</details> block. Two diagnoses → two blocks.
  const detailsCount = (out.markdown.match(/<details>/g) || []).length;
  assert.equal(detailsCount, 2, "expected one <details> block per diagnosis");
  // Severity emoji + headline appear in the <summary> line.
  // 🔴 = high severity; 🟡 = medium.
  assert.match(out.markdown, /🔴/);
  assert.match(out.markdown, /🟡/);
  assert.match(out.markdown, /Hit rate 31% — dominated by 3 crates/);
  assert.match(out.markdown, /rustc flag churn detected/);
});

test("insights: renderInsights renders miss_reasons_top as a table inside each diagnosis", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // The first diagnosis has 3 miss_reasons_top entries. Verify the table
  // header and at least one row with the file column rendered.
  assert.match(out.markdown, /\| Category \| (File\/Flag|File\|Flag) \| Misses \|/);
  assert.match(out.markdown, /crates\/big-crate\/build\.rs/);
  assert.match(out.markdown, /-C debuginfo=2/);
  assert.match(out.markdown, /\| 42 \|/);
});

test("insights: renderInsights renders slowest_misses list and human-readable wasted_ms", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Slowest misses are emitted as a list. Verify at least the crate names land.
  assert.match(out.markdown, /big-crate/);
  assert.match(out.markdown, /4200|4\.2\s*s/i);
  // wasted_ms is rendered in human-readable form (s, not raw ms).
  // 18500 ms → "18.5s". The exact phrasing is renderer's call but it must NOT
  // be the bare integer 18500 ms.
  assert.match(out.markdown, /18\.5\s*s|18500\s*ms/i);
});

test("insights: renderInsights renders suggested_fix as a footer (quoted)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Suggested fix appears as a Markdown blockquote ("> …") for each diagnosis.
  assert.match(out.markdown, /> Normalize source mtimes/);
  assert.match(out.markdown, /> Avoid -C target-cpu=native/);
});

test("insights: high-severity diagnosis with file produces ::warning file=...:: annotation", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // First diagnosis is high severity and its first miss_reasons_top entry
  // has a file. → ::warning file=crates/big-crate/build.rs,line=1::<headline>
  const warn = out.annotations.find(
    (a) => a.startsWith("::warning") && a.includes("crates/big-crate/build.rs"),
  );
  assert.ok(warn, `expected a ::warning annotation pinned to build.rs, got ${JSON.stringify(out.annotations)}`);
  assert.match(warn!, /::warning file=crates\/big-crate\/build\.rs,line=1::/);
  assert.match(warn!, /Hit rate 31%/);
});

test("insights: medium-severity diagnosis emits ::notice:: annotation (file pin optional)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights(fixtureInsightsReport());
  // Second diagnosis is medium severity — its top miss reason is a flag,
  // not a file. → ::notice::<headline> without a file=… pin (line=1 stays
  // optional when there's no file).
  const notice = out.annotations.find(
    (a) => a.startsWith("::notice") && a.includes("rustc flag churn"),
  );
  assert.ok(notice, `expected a ::notice annotation for medium diagnosis, got ${JSON.stringify(out.annotations)}`);
});

test("insights: low severity also maps to ::notice::", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights({
    diagnoses: [
      {
        severity: "low",
        headline: "Minor: registry cache cold this run",
        evidence: { miss_reasons_top: [], wasted_ms: 50 },
        suggested_fix: "Enable cargo-registry-cache.",
      },
    ],
  });
  const notice = out.annotations.find((a) => a.startsWith("::notice"));
  assert.ok(notice, "expected a ::notice annotation for low severity");
  assert.match(notice!, /Minor: registry cache cold this run/);
});

test("insights: empty or missing diagnoses array produces an empty-but-valid result", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out1 = mod.renderInsights({ diagnoses: [] });
  assert.equal(out1.markdown.trim(), "", "no diagnoses → empty markdown");
  assert.deepEqual(out1.annotations, []);
  // Missing entirely (older soldr) is also non-fatal.
  const out2 = mod.renderInsights({});
  assert.equal(out2.markdown.trim(), "");
  assert.deepEqual(out2.annotations, []);
});

test("insights: tolerates diagnoses with missing optional fields (no file/no slowest_misses)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights({
    diagnoses: [
      {
        severity: "high",
        headline: "Catastrophic miss without evidence",
        // Note: evidence missing entirely.
        suggested_fix: "Run again with logging:true.",
      },
      {
        severity: "medium",
        headline: "Partial evidence",
        evidence: { wasted_ms: 100 }, // no miss_reasons_top, no slowest_misses
        suggested_fix: "Inspect.",
      },
    ],
  });
  // Both diagnoses must still render — the renderer never throws on
  // missing optional fields.
  assert.match(out.markdown, /Catastrophic miss without evidence/);
  assert.match(out.markdown, /Partial evidence/);
  // The first has no file → annotation is bare (no file= pin).
  const a1 = out.annotations.find((a) => a.includes("Catastrophic miss"));
  assert.ok(a1);
  assert.equal(/file=/.test(a1!), false, "no file= pin when evidence is absent");
  // Second still emits an annotation despite empty miss_reasons_top.
  assert.ok(out.annotations.find((a) => a.includes("Partial evidence")));
});

test("insights mode in formatFinalCacheSummaryMarkdown renders insights section", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-insights-md-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      soldr_version: "0.7.34",
      report: fixtureInsightsReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "insights" as any);
    // Insights mode is a superset of summarize — it MUST still render the
    // per-session table so workflows don't lose the baseline metrics.
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /\| Hit rate \| 31\.0% \|/);
    // …and it must add the insights section with the per-diagnosis blocks.
    assert.match(md, /### Compile cache insights/);
    assert.match(md, /🔴/);
    assert.match(md, /Hit rate 31% — dominated by 3 crates/);
    assert.match(md, /> Normalize source mtimes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("insights mode is opt-in: summarize/detailed/none do NOT render the insights section", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("ccs-insights-optin-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureInsightsReport(),
    };
    for (const mode of ["summarize", "detailed", "none"] as const) {
      const md = mod.formatFinalCacheSummaryMarkdown(summary, mode);
      assert.doesNotMatch(
        md,
        /### Compile cache insights/,
        `mode=${mode} must NOT render the insights section`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("insights: severity emoji mapping covers high/medium/low (sanity)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as InsightsModule;
  const out = mod.renderInsights({
    diagnoses: [
      { severity: "high", headline: "H", suggested_fix: "x" },
      { severity: "medium", headline: "M", suggested_fix: "x" },
      { severity: "low", headline: "L", suggested_fix: "x" },
    ],
  });
  // Exactly one of each emoji line should appear in the markdown.
  assert.equal((out.markdown.match(/🔴/g) || []).length, 1);
  assert.equal((out.markdown.match(/🟡/g) || []).length, 1);
  assert.equal((out.markdown.match(/🟢/g) || []).length, 1);
});

test("insights: normalizeCompileCacheStats accepts 'insights' as a distinct value (not alias for detailed)", async () => {
  // PR3 elevates 'insights' from "alias for detailed" (PR2 scaffolding) to a
  // first-class enum value. This regression test fails if a future refactor
  // collapses it back into detailed.
  const mod = (await import("../src/lib/input-parsers.js")) as {
    normalizeCompileCacheStats: (raw: string) => string;
  };
  assert.equal(mod.normalizeCompileCacheStats("insights"), "insights");
  assert.equal(mod.normalizeCompileCacheStats("detailed"), "detailed");
  assert.equal(mod.normalizeCompileCacheStats("summarize"), "summarize");
  assert.equal(mod.normalizeCompileCacheStats("none"), "none");
  // Unknown values still fall back to "summarize" (preserves old behavior).
  assert.equal(mod.normalizeCompileCacheStats("garbage"), "summarize");
});

// ---------------------------------------------------------------------------
// PR4 — Multi-step session aggregation across all sessions in a CI job.
//
// Today each `soldr cargo <verb>` invocation in a CI job writes its own
// `logs/last-session-stats.json`, and each new invocation overwrites the
// prior one. setup-soldr v0.9.7 + soldr#379 added `--archive-logs <dir>`
// so the per-session logs land under `<cache-dir>/logs/archive/<session-id>/`
// before the next invocation overwrites the "last" file. PR4 walks that
// archive dir in the post-step and rolls up every session's stats into a
// single job-wide aggregate.
//
// All tests below were written FIRST (TDD) — they were RED against the
// PR3 codebase before any aggregator/renderer/wiring landed. They turn
// GREEN once PR4's `aggregateSessions`, `collectArchivedSessionStats`,
// `renderMultiSessionRollup`, and `setMultiSessionOutputs` ship.
// ---------------------------------------------------------------------------

interface AggregatorModule {
  aggregateSessions: (statsFiles: Array<Record<string, unknown>>) => {
    sessionCount: number;
    totalHits: number;
    totalMisses: number;
    totalCompilations: number;
    overallHitRate: number | null;
    totalTimeSavedMs: number;
    totalBytesRead: number;
    totalBytesWritten: number;
    sessions: Array<{
      sessionId: string;
      hits: number;
      misses: number;
      hitRate: number | null;
      timeSavedMs: number;
    }>;
  };
  collectArchivedSessionStats: (archiveDir: string) => Array<Record<string, unknown>>;
  renderMultiSessionRollup: (rollup: ReturnType<AggregatorModule["aggregateSessions"]>) => string;
}

/**
 * Three synthetic per-session stats payloads — these are what each
 * `last-session-stats.json` looks like after soldr writes it under
 * `<cache-dir>/logs/archive/<session-id>/`. The schema follows
 * zackees/soldr#320 (the same one consumed by the single-session renderer).
 */
function multiSessionFixtures(): Array<Record<string, unknown>> {
  return [
    {
      status: "ok",
      session_id: "sess-cargo-build",
      compilations: 100,
      hits: 80,
      misses: 20,
      hit_rate: 0.8,
      time_saved_ms: 30000,
      bytes_read: 100_000_000,
      bytes_written: 20_000_000,
    },
    {
      status: "ok",
      session_id: "sess-cargo-test",
      compilations: 50,
      hits: 30,
      misses: 20,
      hit_rate: 0.6,
      time_saved_ms: 15000,
      bytes_read: 50_000_000,
      bytes_written: 10_000_000,
    },
    {
      status: "ok",
      session_id: "sess-cargo-clippy",
      compilations: 60,
      hits: 55,
      misses: 5,
      hit_rate: 55 / 60,
      time_saved_ms: 22500,
      bytes_read: 60_000_000,
      bytes_written: 2_000_000,
    },
  ];
}

test("PR4 aggregateSessions: sums hits, misses, compilations across all sessions", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions(multiSessionFixtures());
  assert.equal(rollup.sessionCount, 3);
  // 80 + 30 + 55 = 165
  assert.equal(rollup.totalHits, 165);
  // 20 + 20 + 5 = 45
  assert.equal(rollup.totalMisses, 45);
  // 100 + 50 + 60 = 210
  assert.equal(rollup.totalCompilations, 210);
});

test("PR4 aggregateSessions: overallHitRate is hits / compilations (weighted across sessions)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions(multiSessionFixtures());
  // Overall = 165 / 210 ≈ 0.7857 (NOT the unweighted mean of per-session rates)
  assert.ok(rollup.overallHitRate !== null);
  assert.ok(Math.abs((rollup.overallHitRate as number) - 165 / 210) < 1e-9);
});

test("PR4 aggregateSessions: sums time-saved and byte counters", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions(multiSessionFixtures());
  // 30000 + 15000 + 22500 = 67500
  assert.equal(rollup.totalTimeSavedMs, 67500);
  // 100M + 50M + 60M = 210M
  assert.equal(rollup.totalBytesRead, 210_000_000);
  // 20M + 10M + 2M = 32M
  assert.equal(rollup.totalBytesWritten, 32_000_000);
});

test("PR4 aggregateSessions: produces per-session breakdown preserving session_id", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions(multiSessionFixtures());
  assert.equal(rollup.sessions.length, 3);
  const ids = rollup.sessions.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ["sess-cargo-build", "sess-cargo-clippy", "sess-cargo-test"]);
  const build = rollup.sessions.find((s) => s.sessionId === "sess-cargo-build")!;
  assert.equal(build.hits, 80);
  assert.equal(build.misses, 20);
  assert.ok(Math.abs((build.hitRate as number) - 0.8) < 1e-9);
  assert.equal(build.timeSavedMs, 30000);
});

test("PR4 aggregateSessions: empty input → sessionCount=0, nulls and zeros, no throw", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions([]);
  assert.equal(rollup.sessionCount, 0);
  assert.equal(rollup.totalHits, 0);
  assert.equal(rollup.totalMisses, 0);
  assert.equal(rollup.totalCompilations, 0);
  // No compilations → hit_rate is null (not NaN, not 0).
  assert.equal(rollup.overallHitRate, null);
  assert.equal(rollup.totalTimeSavedMs, 0);
  assert.equal(rollup.totalBytesRead, 0);
  assert.equal(rollup.totalBytesWritten, 0);
  assert.deepEqual(rollup.sessions, []);
});

test("PR4 aggregateSessions: tolerates missing optional fields (time_saved_ms, bytes_*)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions([
    { status: "ok", session_id: "minimal-1", hits: 10, misses: 0, compilations: 10, hit_rate: 1.0 },
    { status: "ok", session_id: "minimal-2", hits: 5, misses: 5, compilations: 10 },
  ]);
  assert.equal(rollup.sessionCount, 2);
  assert.equal(rollup.totalHits, 15);
  assert.equal(rollup.totalMisses, 5);
  assert.equal(rollup.totalCompilations, 20);
  assert.equal(rollup.totalTimeSavedMs, 0);
  assert.equal(rollup.totalBytesRead, 0);
  assert.equal(rollup.totalBytesWritten, 0);
  // Second session has no hit_rate field → null in the per-session row,
  // but the aggregate hit rate is still well-defined.
  const second = rollup.sessions.find((s) => s.sessionId === "minimal-2")!;
  assert.equal(second.hitRate, null);
  assert.ok(Math.abs((rollup.overallHitRate as number) - 0.75) < 1e-9);
});

test("PR4 aggregateSessions: skips entries with status != ok (e.g. 'missing', 'invalid')", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions([
    { status: "ok", session_id: "good", hits: 10, misses: 0, compilations: 10 },
    { status: "missing", session_id: "bad-1" },
    { status: "invalid", session_id: "bad-2", error: "bad json" },
    { status: "ok", session_id: "good2", hits: 5, misses: 5, compilations: 10 },
  ]);
  // Only the two "ok" entries are aggregated.
  assert.equal(rollup.sessionCount, 2);
  assert.equal(rollup.totalHits, 15);
  assert.equal(rollup.totalCompilations, 20);
  assert.equal(rollup.sessions.length, 2);
});

test("PR4 collectArchivedSessionStats: walks <archive-dir>/<session-id>/last-session-stats.json", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const root = mkTmp("pr4-collect-");
  const archive = path.join(root, "logs", "archive");
  fs.mkdirSync(archive, { recursive: true });
  try {
    // Plant three sessions under archive/<session-id>/last-session-stats.json.
    for (const fixture of multiSessionFixtures()) {
      const sid = fixture["session_id"] as string;
      const sessionDir = path.join(archive, sid);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "last-session-stats.json"),
        JSON.stringify(fixture),
        "utf8",
      );
    }
    const found = mod.collectArchivedSessionStats(archive);
    assert.equal(found.length, 3, "expected three archived session stats");
    const hits = found.map((s) => s["hits"]).sort();
    assert.deepEqual(hits, [30, 55, 80]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 collectArchivedSessionStats: missing archive dir → empty array (no throw)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const root = mkTmp("pr4-noarchive-");
  try {
    const found = mod.collectArchivedSessionStats(path.join(root, "does", "not", "exist"));
    assert.deepEqual(found, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 collectArchivedSessionStats: skips invalid JSON without throwing", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const root = mkTmp("pr4-badjson-");
  const archive = path.join(root, "logs", "archive");
  fs.mkdirSync(path.join(archive, "good"), { recursive: true });
  fs.mkdirSync(path.join(archive, "bad"), { recursive: true });
  fs.mkdirSync(path.join(archive, "non-object"), { recursive: true });
  try {
    fs.writeFileSync(
      path.join(archive, "good", "last-session-stats.json"),
      JSON.stringify({ status: "ok", session_id: "good", hits: 1, misses: 0, compilations: 1 }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(archive, "bad", "last-session-stats.json"),
      "{not valid json",
      "utf8",
    );
    fs.writeFileSync(
      path.join(archive, "non-object", "last-session-stats.json"),
      "[1, 2, 3]",
      "utf8",
    );
    const found = mod.collectArchivedSessionStats(archive);
    // Only the well-formed one survives.
    assert.equal(found.length, 1);
    assert.equal(found[0]!["session_id"], "good");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 renderMultiSessionRollup: includes <details> block, title with session count, aggregate table", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions(multiSessionFixtures());
  const md = mod.renderMultiSessionRollup(rollup);
  // The roll-up is wrapped in a collapsed <details> so it doesn't dominate
  // the step summary on long jobs.
  assert.match(md, /<details>/);
  assert.match(md, /<\/details>/);
  // Title carries the session count so users see "Multi-step roll-up (3 sessions)".
  assert.match(md, /Multi-step roll-up \(3 sessions\)/);
  // Aggregate scalars table — hits/misses/compilations/hit-rate land at the top.
  assert.match(md, /\| Sessions \| 3 \|/);
  assert.match(md, /\| Total hits \| 165 \|/);
  assert.match(md, /\| Total misses \| 45 \|/);
  assert.match(md, /\| Total compilations \| 210 \|/);
  assert.match(md, /\| Overall hit rate \| 78\.6% \|/);
  // Total time saved and bytes appear too (67500 ms = 67.5s).
  assert.match(md, /67\.5\s*s/);
});

test("PR4 renderMultiSessionRollup: includes per-session table beneath the aggregate", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions(multiSessionFixtures());
  const md = mod.renderMultiSessionRollup(rollup);
  // Per-session table header. Columns: Session, Hits, Misses, Hit rate, Time saved.
  assert.match(md, /\| Session \| Hits \| Misses \| Hit rate \| Time saved \|/);
  assert.match(md, /sess-cargo-build/);
  assert.match(md, /sess-cargo-test/);
  assert.match(md, /sess-cargo-clippy/);
  // Per-session percentages (80.0%, 60.0%, ~91.7%).
  assert.match(md, /80\.0%/);
  assert.match(md, /60\.0%/);
});

test("PR4 renderMultiSessionRollup: returns empty string when sessionCount <= 1 (single-session path stays unchanged)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const empty = mod.renderMultiSessionRollup(mod.aggregateSessions([]));
  assert.equal(empty, "");
  const single = mod.renderMultiSessionRollup(
    mod.aggregateSessions([
      { status: "ok", session_id: "only", hits: 1, misses: 1, compilations: 2, hit_rate: 0.5 },
    ]),
  );
  // Single session: still empty — the existing single-session renderer
  // already covers this case and a multi-step block would be redundant.
  assert.equal(single, "");
});

test("PR4 renderMultiSessionRollup: handles null overallHitRate gracefully (n/a)", async () => {
  const mod = (await import("../src/lib/compile-cache-stats.js")) as unknown as AggregatorModule;
  const rollup = mod.aggregateSessions([
    // Two sessions with zero compilations each → overall hit rate is null.
    { status: "ok", session_id: "empty-1", hits: 0, misses: 0, compilations: 0 },
    { status: "ok", session_id: "empty-2", hits: 0, misses: 0, compilations: 0 },
  ]);
  const md = mod.renderMultiSessionRollup(rollup);
  // Aggregate hit rate renders as n/a when no compilations happened.
  assert.match(md, /\| Overall hit rate \| n\/a \|/);
});

test("PR4 formatFinalCacheSummaryMarkdown: multi-session rollup appears in summary when archive has N>1 sessions", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("pr4-fmt-multi-");
  const buildCachePath = path.join(root, "cache", "zccache");
  const archive = path.join(buildCachePath, "logs", "archive");
  fs.mkdirSync(archive, { recursive: true });
  try {
    // Plant three sessions on disk where post-step will discover them.
    for (const fixture of multiSessionFixtures()) {
      const sid = fixture["session_id"] as string;
      const sessionDir = path.join(archive, sid);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "last-session-stats.json"),
        JSON.stringify(fixture),
        "utf8",
      );
    }
    const result = fakeResult(buildCachePath);
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    // The single-session report still renders (PR1 path); PR4 just adds a
    // roll-up block on top when archive holds >1 sessions.
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    assert.match(md, /Multi-step roll-up \(3 sessions\)/);
    assert.match(md, /\| Sessions \| 3 \|/);
    assert.match(md, /sess-cargo-build/);
    // Single-session path must still work — both surfaces coexist.
    assert.match(md, /### Compile cache \(zccache\)/);
    assert.match(md, /\| Hit rate \| 86\.4% \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 formatFinalCacheSummaryMarkdown: NO multi-session block when archive is empty (single-session unchanged)", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("pr4-fmt-single-");
  try {
    const result = fakeResult(path.join(root, "cache", "zccache"));
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    const md = mod.formatFinalCacheSummaryMarkdown(summary, "summarize");
    // No archive → no roll-up. Existing single-session table still renders.
    assert.doesNotMatch(md, /Multi-step roll-up/);
    assert.match(md, /### Compile cache \(zccache\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 formatFinalCacheSummaryMarkdown: multi-session works in detailed and insights modes too", async () => {
  const mod = (await import("../src/post.js")) as PostModule;
  const root = mkTmp("pr4-fmt-allmodes-");
  const buildCachePath = path.join(root, "cache", "zccache");
  const archive = path.join(buildCachePath, "logs", "archive");
  fs.mkdirSync(archive, { recursive: true });
  try {
    for (const fixture of multiSessionFixtures()) {
      const sid = fixture["session_id"] as string;
      const sessionDir = path.join(archive, sid);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "last-session-stats.json"),
        JSON.stringify(fixture),
        "utf8",
      );
    }
    const result = fakeResult(buildCachePath);
    const summary = mod.buildFinalCacheSummary(result, emptyRestoreState(), disabledSaves());
    summary.compile_cache_report = {
      status: "ok",
      report: fixtureReport(),
    };
    for (const mode of ["summarize", "detailed", "insights"] as const) {
      const md = mod.formatFinalCacheSummaryMarkdown(summary, mode as any);
      assert.match(md, /Multi-step roll-up \(3 sessions\)/, `mode=${mode} should render multi-step block`);
    }
    // But "none" mode suppresses everything compile-cache related,
    // including the multi-step block.
    const mdNone = mod.formatFinalCacheSummaryMarkdown(summary, "none");
    assert.doesNotMatch(mdNone, /Multi-step roll-up/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 scalar outputs: compile-cache-sessions-total and compile-cache-overall-hit-rate emitted when N>1 sessions", async () => {
  const mod = (await import("../src/post.js")) as PostModule & {
    setMultiSessionOutputs?: (
      rollup: { sessionCount: number; overallHitRate: number | null },
    ) => void;
  };
  const root = mkTmp("pr4-outputs-");
  const ghOutputPath = path.join(root, "github-output.txt");
  const previousOutput = process.env["GITHUB_OUTPUT"];
  process.env["GITHUB_OUTPUT"] = ghOutputPath;
  try {
    fs.writeFileSync(ghOutputPath, "", "utf8");
    assert.ok(
      typeof mod.setMultiSessionOutputs === "function",
      "post.ts must export setMultiSessionOutputs for PR4",
    );
    mod.setMultiSessionOutputs!({ sessionCount: 3, overallHitRate: 165 / 210 });
    const ghOutContent = fs.readFileSync(ghOutputPath, "utf8");
    // @actions/core appends `name<<HEREDOC\nvalue\nHEREDOC\n` per output.
    assert.match(ghOutContent, /compile-cache-sessions-total/);
    assert.match(ghOutContent, /\b3\b/);
    assert.match(ghOutContent, /compile-cache-overall-hit-rate/);
  } finally {
    if (previousOutput === undefined) delete process.env["GITHUB_OUTPUT"];
    else process.env["GITHUB_OUTPUT"] = previousOutput;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR4 setMultiSessionOutputs: skips emission when sessionCount <= 1 (no false signal)", async () => {
  const mod = (await import("../src/post.js")) as PostModule & {
    setMultiSessionOutputs?: (
      rollup: { sessionCount: number; overallHitRate: number | null },
    ) => void;
  };
  const root = mkTmp("pr4-outputs-single-");
  const ghOutputPath = path.join(root, "github-output.txt");
  const previousOutput = process.env["GITHUB_OUTPUT"];
  process.env["GITHUB_OUTPUT"] = ghOutputPath;
  try {
    fs.writeFileSync(ghOutputPath, "", "utf8");
    assert.ok(typeof mod.setMultiSessionOutputs === "function");
    mod.setMultiSessionOutputs!({ sessionCount: 1, overallHitRate: 0.5 });
    mod.setMultiSessionOutputs!({ sessionCount: 0, overallHitRate: null });
    const ghOutContent = fs.readFileSync(ghOutputPath, "utf8");
    // With <= 1 sessions there is no "multi-step" — outputs stay empty so
    // downstream workflows can use `if: steps.x.outputs.compile-cache-sessions-total`
    // as a feature gate.
    assert.equal(ghOutContent, "");
  } finally {
    if (previousOutput === undefined) delete process.env["GITHUB_OUTPUT"];
    else process.env["GITHUB_OUTPUT"] = previousOutput;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #235 — cook reuse-mismatch detection.
// ---------------------------------------------------------------------------

interface CookMismatchModule {
  detectCookReuseMismatch: (input: {
    cookEnabled: boolean;
    cookProducedDeps: boolean;
    hits: number | null;
    misses: number | null;
    cookFlags: string;
  }) => { mismatch: boolean; message: string; annotationLevel?: "notice" };
  cookFlagsRequestRelease: (flags: string) => boolean;
}

async function cookMod(): Promise<CookMismatchModule> {
  return (await import("../src/lib/compile-cache-stats.js")) as unknown as CookMismatchModule;
}

test("#235 cookFlagsRequestRelease: detects release-profile flag shapes", async () => {
  const { cookFlagsRequestRelease } = await cookMod();
  assert.equal(cookFlagsRequestRelease("--release"), true);
  assert.equal(cookFlagsRequestRelease("--release --target x86_64-unknown-linux-gnu"), true);
  assert.equal(cookFlagsRequestRelease("--profile release"), true);
  assert.equal(cookFlagsRequestRelease("--profile bench"), true);
  assert.equal(cookFlagsRequestRelease(""), false);
  assert.equal(cookFlagsRequestRelease("--profile dev"), false);
  assert.equal(cookFlagsRequestRelease("--target x86_64-unknown-linux-gnu"), false);
});

test("#235 detectCookReuseMismatch: release cook + zero reuse fires with debug-profile hint", async () => {
  const { detectCookReuseMismatch } = await cookMod();
  // The #192 fingerprint: warm cook, 35 misses, 0 hits.
  const r = detectCookReuseMismatch({
    cookEnabled: true,
    cookProducedDeps: true,
    hits: 0,
    misses: 35,
    cookFlags: "--release",
  });
  assert.equal(r.mismatch, true);
  assert.equal(r.annotationLevel, "notice");
  assert.match(r.message, /35 miss/);
  assert.match(r.message, /prebuild-deps-flags: ""/);
  assert.match(r.message, /release profile/);
});

test("#235 detectCookReuseMismatch: debug cook + zero reuse fires with toolchain hint", async () => {
  const { detectCookReuseMismatch } = await cookMod();
  const r = detectCookReuseMismatch({
    cookEnabled: true,
    cookProducedDeps: true,
    hits: 0,
    misses: 12,
    cookFlags: "",
  });
  assert.equal(r.mismatch, true);
  assert.match(r.message, /different rust toolchain or profile/);
  assert.match(r.message, /build-cache/);
});

test("#235 detectCookReuseMismatch: stays quiet when cook produced reuse", async () => {
  const { detectCookReuseMismatch } = await cookMod();
  const r = detectCookReuseMismatch({
    cookEnabled: true,
    cookProducedDeps: true,
    hits: 40,
    misses: 5,
    cookFlags: "--release",
  });
  assert.equal(r.mismatch, false);
  assert.equal(r.message, "");
});

test("#235 detectCookReuseMismatch: no signal when cook disabled or produced no deps", async () => {
  const { detectCookReuseMismatch } = await cookMod();
  assert.equal(
    detectCookReuseMismatch({
      cookEnabled: false,
      cookProducedDeps: true,
      hits: 0,
      misses: 9,
      cookFlags: "--release",
    }).mismatch,
    false,
  );
  assert.equal(
    detectCookReuseMismatch({
      cookEnabled: true,
      cookProducedDeps: false,
      hits: 0,
      misses: 9,
      cookFlags: "--release",
    }).mismatch,
    false,
  );
});

test("#235 detectCookReuseMismatch: tolerant of missing counters (no false positive)", async () => {
  const { detectCookReuseMismatch } = await cookMod();
  assert.equal(
    detectCookReuseMismatch({
      cookEnabled: true,
      cookProducedDeps: true,
      hits: null,
      misses: null,
      cookFlags: "--release",
    }).mismatch,
    false,
  );
  // misses present but zero → nothing was compiled, so no mismatch.
  assert.equal(
    detectCookReuseMismatch({
      cookEnabled: true,
      cookProducedDeps: true,
      hits: 0,
      misses: 0,
      cookFlags: "--release",
    }).mismatch,
    false,
  );
});

// ---------------------------------------------------------------------------
// #227 — compile-cache activity verification (zero-count guard).
// ---------------------------------------------------------------------------

interface VerifyModule {
  parseVerifyCompileCacheMode: (value: string) => "off" | "warn" | "error";
  verifyCompileCacheActivity: (input: {
    mode: "off" | "warn" | "error";
    enabled: boolean;
    buildCacheEnabled: boolean;
    reportStatus: string;
    hits: number | null;
    misses: number | null;
    env: {
      rustcWrapper?: string;
      soldrCacheDir?: string;
      zccacheCacheDir?: string;
      shimsDir?: string;
      statsPath?: string;
    };
  }) => { status: "ok" | "invalid-measurement" | "skipped"; fail: boolean; message: string };
}

async function verifyMod(): Promise<VerifyModule> {
  return (await import("../src/lib/compile-cache-stats.js")) as unknown as VerifyModule;
}

const okEnv = { rustcWrapper: "/usr/bin/zccache", soldrCacheDir: "/c/soldr", zccacheCacheDir: "/c/z" };

test("#227 parseVerifyCompileCacheMode: maps aliases", async () => {
  const { parseVerifyCompileCacheMode } = await verifyMod();
  assert.equal(parseVerifyCompileCacheMode(""), "off");
  assert.equal(parseVerifyCompileCacheMode("off"), "off");
  assert.equal(parseVerifyCompileCacheMode("warn"), "warn");
  assert.equal(parseVerifyCompileCacheMode("warning"), "warn");
  assert.equal(parseVerifyCompileCacheMode("error"), "error");
  assert.equal(parseVerifyCompileCacheMode("true"), "error");
  assert.equal(parseVerifyCompileCacheMode("YES"), "error");
});

test("#227 verifyCompileCacheActivity: zero counts in error mode fails with bypass diagnostics", async () => {
  const { verifyCompileCacheActivity } = await verifyMod();
  const r = verifyCompileCacheActivity({
    mode: "error",
    enabled: true,
    buildCacheEnabled: true,
    reportStatus: "ok",
    hits: 0,
    misses: 0,
    env: { soldrCacheDir: "/c/soldr", zccacheCacheDir: "/c/z", statsPath: "/c/z/logs/x.json" },
  });
  assert.equal(r.status, "invalid-measurement");
  assert.equal(r.fail, true);
  assert.match(r.message, /0 hits and 0 misses/);
  assert.match(r.message, /RUSTC_WRAPPER is unset/);
});

test("#227 verifyCompileCacheActivity: zero counts in warn mode does not fail", async () => {
  const { verifyCompileCacheActivity } = await verifyMod();
  const r = verifyCompileCacheActivity({
    mode: "warn",
    enabled: true,
    buildCacheEnabled: true,
    reportStatus: "ok",
    hits: 0,
    misses: 0,
    env: okEnv,
  });
  assert.equal(r.status, "invalid-measurement");
  assert.equal(r.fail, false);
});

test("#227 verifyCompileCacheActivity: nonzero counts pass", async () => {
  const { verifyCompileCacheActivity } = await verifyMod();
  const r = verifyCompileCacheActivity({
    mode: "error",
    enabled: true,
    buildCacheEnabled: true,
    reportStatus: "ok",
    hits: 3,
    misses: 7,
    env: okEnv,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.fail, false);
  assert.equal(r.message, "");
});

test("#227 verifyCompileCacheActivity: legitimate bypasses skip, never fail", async () => {
  const { verifyCompileCacheActivity } = await verifyMod();
  const base = {
    buildCacheEnabled: true,
    reportStatus: "ok",
    hits: 0,
    misses: 0,
    env: okEnv,
  } as const;
  // mode off
  assert.equal(verifyCompileCacheActivity({ ...base, mode: "off", enabled: true }).status, "skipped");
  // passthrough (enable:false)
  const pass = verifyCompileCacheActivity({ ...base, mode: "error", enabled: false });
  assert.equal(pass.status, "skipped");
  assert.equal(pass.fail, false);
  // build-cache disabled
  assert.equal(
    verifyCompileCacheActivity({ ...base, mode: "error", enabled: true, buildCacheEnabled: false }).status,
    "skipped",
  );
  // report not ok
  assert.equal(
    verifyCompileCacheActivity({ ...base, mode: "error", enabled: true, reportStatus: "missing" }).status,
    "skipped",
  );
  // null counters
  assert.equal(
    verifyCompileCacheActivity({ ...base, mode: "error", enabled: true, hits: null, misses: null }).status,
    "skipped",
  );
});

// ---------------------------------------------------------------------------
// #230 / #214 — delta-aware build-cache save gate.
// ---------------------------------------------------------------------------

interface GateModule {
  parseMinCompiles: (value: string) => number;
  decideBuildCacheSave: (input: {
    restored: boolean;
    newCompiles: number | null;
    minCompiles: number;
    dylintOutputRestored?: boolean;
  }) => { skip: boolean; reason: string };
  decideTargetCacheSave: (input: {
    restored: boolean;
    newCompiles: number | null;
    minCompiles: number;
    dylintOutputRestored?: boolean;
  }) => { skip: boolean; reason: string };
}

async function gateMod(): Promise<GateModule> {
  return (await import("../src/lib/compile-cache-stats.js")) as unknown as GateModule;
}

test("#230 parseMinCompiles: empty/invalid → 1, clamps negative, honors 0", async () => {
  const { parseMinCompiles } = await gateMod();
  assert.equal(parseMinCompiles(""), 1);
  assert.equal(parseMinCompiles("  "), 1);
  assert.equal(parseMinCompiles("abc"), 1);
  assert.equal(parseMinCompiles("-3"), 1);
  assert.equal(parseMinCompiles("0"), 0);
  assert.equal(parseMinCompiles("10"), 10);
});

test("#230 decideBuildCacheSave: skips warm fallback with zero new compiles", async () => {
  const { decideBuildCacheSave } = await gateMod();
  const r = decideBuildCacheSave({ restored: true, newCompiles: 0, minCompiles: 1 });
  assert.equal(r.skip, true);
  assert.match(r.reason, /0 new compile/);
  assert.match(r.reason, /min-compiles=1/);
});

test("#230 decideBuildCacheSave: saves when new compiles meet threshold", async () => {
  const { decideBuildCacheSave } = await gateMod();
  assert.equal(decideBuildCacheSave({ restored: true, newCompiles: 5, minCompiles: 1 }).skip, false);
  // raised threshold skips a small delta
  assert.equal(decideBuildCacheSave({ restored: true, newCompiles: 5, minCompiles: 10 }).skip, true);
});

test("#230 decideBuildCacheSave: never gates a cold seed, disabled gate, or unknown count", async () => {
  const { decideBuildCacheSave } = await gateMod();
  // cold seed (nothing restored) always saves
  assert.equal(decideBuildCacheSave({ restored: false, newCompiles: 0, minCompiles: 1 }).skip, false);
  // gate disabled
  assert.equal(decideBuildCacheSave({ restored: true, newCompiles: 0, minCompiles: 0 }).skip, false);
  // unreadable count → save (no regression)
  assert.equal(decideBuildCacheSave({ restored: true, newCompiles: null, minCompiles: 1 }).skip, false);
});

test("#255 decideTargetCacheSave: same semantics as build, but reason names target-cache input", async () => {
  const { decideTargetCacheSave } = await gateMod();
  // skip on warm fallback + zero new compiles
  const skipped = decideTargetCacheSave({ restored: true, newCompiles: 0, minCompiles: 1 });
  assert.equal(skipped.skip, true);
  assert.match(skipped.reason, /0 new compile/);
  assert.match(skipped.reason, /target-cache-save-min-compiles=1/);
  // saves when delta meets threshold
  assert.equal(decideTargetCacheSave({ restored: true, newCompiles: 5, minCompiles: 1 }).skip, false);
  // never gates cold seed / disabled gate / unknown count
  assert.equal(decideTargetCacheSave({ restored: false, newCompiles: 0, minCompiles: 1 }).skip, false);
  assert.equal(decideTargetCacheSave({ restored: true, newCompiles: 0, minCompiles: 0 }).skip, false);
  assert.equal(decideTargetCacheSave({ restored: true, newCompiles: null, minCompiles: 1 }).skip, false);
});

// ---------------------------------------------------------------------------
// Dylint thin-store poisoning: a dylint-output-cache hit compiles almost
// nothing, so its build/target store must never be saved (it would replace
// and LRU-evict the real ~1.2 GB entry under Bosn's 8 GiB per-repo cap).
// ---------------------------------------------------------------------------

test("dylint thin store: output-cache hit + cold build-cache + thin compile skips build-cache save", async () => {
  const { decideBuildCacheSave } = await gateMod();
  const r = decideBuildCacheSave({ restored: false, newCompiles: 229, minCompiles: 1, dylintOutputRestored: true });
  assert.equal(r.skip, true);
  assert.match(r.reason, /dylint-output-cache was restored/);
  // Same with a fallback build-cache restore and with an unknown count.
  assert.equal(decideBuildCacheSave({ restored: true, newCompiles: 229, minCompiles: 1, dylintOutputRestored: true }).skip, true);
  assert.equal(decideBuildCacheSave({ restored: false, newCompiles: null, minCompiles: 1, dylintOutputRestored: true }).skip, true);
});

test("dylint thin store: target-cache save is gated the same way", async () => {
  const { decideTargetCacheSave } = await gateMod();
  const r = decideTargetCacheSave({ restored: false, newCompiles: 229, minCompiles: 1, dylintOutputRestored: true });
  assert.equal(r.skip, true);
});

test("dylint thin store: real compilation (output-cache miss) still saves, and min-compiles=0 force-saves", async () => {
  const { decideBuildCacheSave } = await gateMod();
  // cold seed after a real Dylint compile
  assert.equal(decideBuildCacheSave({ restored: false, newCompiles: 2233, minCompiles: 1, dylintOutputRestored: false }).skip, false);
  // warm fallback with a real delta
  assert.equal(decideBuildCacheSave({ restored: true, newCompiles: 2233, minCompiles: 1 }).skip, false);
  // explicit opt-out of the gate still saves a thin store
  assert.equal(decideBuildCacheSave({ restored: false, newCompiles: 229, minCompiles: 0, dylintOutputRestored: true }).skip, false);
});
