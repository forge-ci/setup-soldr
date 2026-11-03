// setup-soldr#98 PR3 — insights-mode renderer + GitHub annotation builder.
// setup-soldr#98 PR4 — multi-step session aggregator + roll-up renderer.
//
// PR3 surface (insights):
//   - `renderInsights(payload)` consumes the `diagnoses[]` array shipped by
//     `soldr cache report --json` (schema defined in zackees/soldr#321) and
//     produces a Markdown block (per-diagnosis <details> with severity emoji,
//     headline, evidence tables, suggested_fix blockquote) plus a list of
//     GitHub workflow-command annotations (::warning::/::notice:: with
//     optional file= pins) ready to forward to core.warning / core.notice.
//
// PR4 surface (multi-step aggregation):
//   - `collectArchivedSessionStats(archiveDir)` walks
//     `<cache-dir>/logs/archive/<session-id>/last-session-stats.json`
//     (the soldr#379 `--archive-logs` layout) and returns one parsed JSON
//     object per session.
//   - `aggregateSessions(statsFiles)` rolls every per-session payload up
//     into a single `MultiSessionRollup` (totals + weighted hit rate +
//     per-session breakdown).
//   - `renderMultiSessionRollup(rollup)` emits a collapsed <details>
//     block titled "Multi-step roll-up (N sessions)" with the aggregate
//     scalars at the top and a per-session table beneath. Renders the
//     empty string when sessionCount <= 1 so the existing single-session
//     surface stays the single source of truth on jobs that only run one
//     cargo command.
//
// All renderers are pure — no I/O, no @actions/* imports — so they stay
// trivially unit-testable. The post-step wires their output into the
// step-summary append + the @actions/core annotation surface.

import * as fs from "node:fs";
import * as path from "node:path";

interface MissReason {
  category?: string;
  file?: string;
  flag?: string;
  misses?: number;
}

interface SlowestMiss {
  crate?: string;
  ms?: number;
  miss_reason?: string;
}

interface DiagnosisEvidence {
  miss_reasons_top?: MissReason[];
  slowest_misses?: SlowestMiss[];
  wasted_ms?: number;
}

interface Diagnosis {
  severity?: string;
  headline?: string;
  evidence?: DiagnosisEvidence;
  suggested_fix?: string;
}

export interface InsightsRenderResult {
  /**
   * Markdown to append to $GITHUB_STEP_SUMMARY. Empty string when there
   * are no diagnoses — the caller can append unconditionally.
   */
  markdown: string;
  /**
   * GitHub workflow-command annotation lines (e.g.
   * `::warning file=path,line=1::<headline>`). The caller forwards each
   * one to `core.warning`/`core.notice` so it shows up pinned to the
   * relevant file in the PR UI. Empty array when there are no diagnoses.
   */
  annotations: string[];
}

/** Markdown table cell escaping — keeps the table grid intact. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Severity → leading emoji. Maps "high" to a red circle (loudest signal in
 * a step summary), "medium" to yellow, "low" to green. Unknown severities
 * fall back to the medium glyph so the renderer never throws on a typo
 * from a future soldr release.
 */
function severityEmoji(severity: string | undefined): string {
  switch ((severity ?? "").toLowerCase()) {
    case "high":
      return "🔴";
    case "medium":
      return "🟡";
    case "low":
      return "🟢";
    default:
      return "🟡";
  }
}

/**
 * Severity → GitHub workflow-command verb. "high" gets `::warning::` so it
 * surfaces in the PR Files-Changed view; "medium"/"low" get `::notice::`
 * (less intrusive — annotation-tray only). Unknown severities default to
 * notice, the more conservative choice.
 */
function severityCommand(severity: string | undefined): "warning" | "notice" {
  return (severity ?? "").toLowerCase() === "high" ? "warning" : "notice";
}

/** Human-readable ms → seconds when ≥ 1s, otherwise verbatim ms. */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms} ms`;
}

/**
 * Strip newlines from a string before splicing it into a GitHub workflow
 * command. The `::warning ::<msg>` syntax breaks if `<msg>` contains a
 * literal `\n` (the runner stops parsing at the line break). URL-encoded
 * `%0A` is the documented escape; the actions/core library uses the same
 * transform internally.
 */
function escapeAnnotationMessage(msg: string): string {
  return msg.replace(/\r?\n/g, "%0A").replace(/\r/g, "%0D");
}

/**
 * Pull the first miss-reason entry that has a file path. Used to pin the
 * workflow annotation to a specific source file when one is available.
 * Falls back to undefined when no entry carries a file (e.g. all misses
 * are flag-driven).
 */
function pickFile(evidence: DiagnosisEvidence | undefined): string | undefined {
  const top = evidence?.miss_reasons_top;
  if (!Array.isArray(top)) return undefined;
  for (const entry of top) {
    if (entry && typeof entry.file === "string" && entry.file.length > 0) {
      return entry.file;
    }
  }
  return undefined;
}

function renderMissReasonsTable(rows: MissReason[]): string[] {
  if (rows.length === 0) return [];
  const out: string[] = [];
  out.push("| Category | File/Flag | Misses |");
  out.push("| --- | --- | --- |");
  for (const row of rows) {
    const category = typeof row.category === "string" ? row.category : "";
    const fileOrFlag =
      typeof row.file === "string" && row.file.length > 0
        ? row.file
        : typeof row.flag === "string"
          ? row.flag
          : "";
    const misses =
      typeof row.misses === "number" && Number.isFinite(row.misses)
        ? String(row.misses)
        : "";
    out.push(`| ${cell(category)} | ${cell(fileOrFlag)} | ${misses} |`);
  }
  return out;
}

function renderSlowestMissesList(rows: SlowestMiss[]): string[] {
  if (rows.length === 0) return [];
  const out: string[] = ["", "**Slowest misses:**", ""];
  for (const row of rows) {
    const crateName = typeof row.crate === "string" ? row.crate : "(unknown)";
    const ms = typeof row.ms === "number" ? row.ms : 0;
    const reason = typeof row.miss_reason === "string" ? row.miss_reason : "";
    const reasonText = reason ? ` — ${reason}` : "";
    out.push(`- ${crateName}: ${fmtMs(ms)} (${ms} ms)${reasonText}`);
  }
  return out;
}

function renderOneDiagnosis(diag: Diagnosis): string[] {
  const emoji = severityEmoji(diag.severity);
  const headline = typeof diag.headline === "string" ? diag.headline : "(no headline)";
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>${emoji} ${headline}</summary>`);
  lines.push("");
  const evidence = diag.evidence;
  const missRows = Array.isArray(evidence?.miss_reasons_top)
    ? (evidence!.miss_reasons_top as MissReason[])
    : [];
  if (missRows.length > 0) {
    lines.push("**Top miss reasons:**", "");
    lines.push(...renderMissReasonsTable(missRows));
  }
  const slowest = Array.isArray(evidence?.slowest_misses)
    ? (evidence!.slowest_misses as SlowestMiss[])
    : [];
  if (slowest.length > 0) {
    lines.push(...renderSlowestMissesList(slowest));
  }
  if (evidence && typeof evidence.wasted_ms === "number" && Number.isFinite(evidence.wasted_ms)) {
    lines.push("", `**Wasted compile time:** ${fmtMs(evidence.wasted_ms)}`);
  }
  if (typeof diag.suggested_fix === "string" && diag.suggested_fix.length > 0) {
    lines.push("");
    // Render the suggested fix as a Markdown blockquote so it stands
    // out from the evidence body — the user's eye goes straight to the
    // "what do I do about this" line.
    lines.push(`> ${diag.suggested_fix}`);
  }
  lines.push("");
  lines.push("</details>");
  return lines;
}

function buildAnnotation(diag: Diagnosis): string {
  const verb = severityCommand(diag.severity);
  const file = pickFile(diag.evidence);
  const headline = typeof diag.headline === "string" ? diag.headline : "(no headline)";
  const message = escapeAnnotationMessage(headline);
  if (file) {
    return `::${verb} file=${file},line=1::${message}`;
  }
  return `::${verb}::${message}`;
}

/**
 * Render the insights surface from a parsed `soldr cache report --json`
 * payload. Tolerant of every optional field — a payload from an older
 * soldr (no `diagnoses` array) returns an empty result without throwing.
 */
export function renderInsights(payload: Record<string, unknown>): InsightsRenderResult {
  const raw = payload?.["diagnoses"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { markdown: "", annotations: [] };
  }
  const diagnoses = raw as Diagnosis[];
  const markdownChunks: string[] = [];
  const annotations: string[] = [];
  for (const diag of diagnoses) {
    markdownChunks.push(...renderOneDiagnosis(diag));
    annotations.push(buildAnnotation(diag));
  }
  return {
    markdown: markdownChunks.join("\n"),
    annotations,
  };
}

// ---------------------------------------------------------------------------
// PR4 — Multi-step session aggregation.
// ---------------------------------------------------------------------------

/**
 * Per-session row inside a multi-step roll-up. Mirrors the four scalars a
 * downstream consumer most often wants to surface (session id, hits,
 * misses, hit rate, wall-clock saved). `hitRate` is null when the session
 * payload didn't carry one (very old soldr, or zero compilations).
 */
export interface MultiSessionRow {
  sessionId: string;
  hits: number;
  misses: number;
  hitRate: number | null;
  timeSavedMs: number;
}

/**
 * Roll-up over every per-invocation `last-session-stats.json` archived
 * under `<cache-dir>/logs/archive/<session-id>/`. `overallHitRate` is
 * weighted across compilations (NOT the unweighted mean of per-session
 * rates) so a job that runs `cargo build` + `cargo test` reports a hit
 * rate that reflects actual cache effectiveness across the whole job.
 * `null` when no compilations happened across any session — never NaN.
 */
export interface MultiSessionRollup {
  sessionCount: number;
  totalHits: number;
  totalMisses: number;
  totalCompilations: number;
  overallHitRate: number | null;
  totalTimeSavedMs: number;
  totalBytesRead: number;
  totalBytesWritten: number;
  sessions: MultiSessionRow[];
}

/** Number coercion that tolerates undefined / non-finite values. */
function numField(stats: Record<string, unknown>, key: string): number | undefined {
  const value = stats[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strField(stats: Record<string, unknown>, key: string): string | undefined {
  const value = stats[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walk `<archiveDir>/<session-id>/last-session-stats.json` and return one
 * parsed JSON object per session. Missing dir → empty array (most common
 * case — first run of a job, no archive present yet). Invalid JSON
 * entries are silently skipped so one corrupt file doesn't poison the
 * whole roll-up. Non-object payloads are also skipped.
 */
export function collectArchivedSessionStats(
  archiveDir: string,
  accept: (statsPath: string) => boolean = () => true,
): Array<Record<string, unknown>> {
  if (!archiveDir) return [];
  let entries: fs.Dirent[];
  try {
    const stat = fs.statSync(archiveDir);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const statsPath = path.join(archiveDir, ent.name, "last-session-stats.json");
    if (!accept(statsPath)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(statsPath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const stats = parsed as Record<string, unknown>;
    // Default the session_id to the on-disk dir name if the JSON itself
    // didn't carry one — gives the per-session table something to render
    // even when older soldr versions skipped writing the field.
    if (typeof stats["session_id"] !== "string") {
      stats["session_id"] = ent.name;
    }
    out.push(stats);
  }
  return out;
}

/**
 * Roll a list of per-session `last-session-stats.json` payloads up into
 * one aggregate. Entries with `status` != "ok" (e.g. "missing", "invalid")
 * are skipped — they carry no compilation counters worth summing.
 */
export function aggregateSessions(
  statsFiles: Array<Record<string, unknown>>,
): MultiSessionRollup {
  let totalHits = 0;
  let totalMisses = 0;
  let totalCompilations = 0;
  let totalTimeSavedMs = 0;
  let totalBytesRead = 0;
  let totalBytesWritten = 0;
  const sessions: MultiSessionRow[] = [];
  for (const raw of statsFiles) {
    if (!raw || typeof raw !== "object") continue;
    const status = strField(raw, "status");
    // Treat a missing `status` as "ok" so callers that hand us a bare
    // last_session payload (no envelope status field) still aggregate.
    if (status !== undefined && status !== "ok") continue;
    const hits = numField(raw, "hits") ?? 0;
    const misses = numField(raw, "misses") ?? 0;
    const compilations = numField(raw, "compilations") ?? hits + misses;
    const timeSavedMs = numField(raw, "time_saved_ms") ?? 0;
    const bytesRead = numField(raw, "bytes_read") ?? 0;
    const bytesWritten = numField(raw, "bytes_written") ?? 0;
    const hitRate = numField(raw, "hit_rate") ?? null;
    const sessionId = strField(raw, "session_id") ?? `session-${sessions.length + 1}`;
    totalHits += hits;
    totalMisses += misses;
    totalCompilations += compilations;
    totalTimeSavedMs += timeSavedMs;
    totalBytesRead += bytesRead;
    totalBytesWritten += bytesWritten;
    sessions.push({ sessionId, hits, misses, hitRate, timeSavedMs });
  }
  const overallHitRate = totalCompilations > 0 ? totalHits / totalCompilations : null;
  return {
    sessionCount: sessions.length,
    totalHits,
    totalMisses,
    totalCompilations,
    overallHitRate,
    totalTimeSavedMs,
    totalBytesRead,
    totalBytesWritten,
    sessions,
  };
}

/** ms → "12.4s" / "850 ms" — matches the existing PR1 single-session table. */
function fmtMsRollup(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms} ms`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms} ms`;
}

/** bytes → "412.0 MB" etc — same scale as post.ts's fmtBytes. */
function fmtBytesRollup(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Percentage formatter with the trailing "%". Null/undefined → "n/a". */
function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Cell-escape pipes and newlines to keep the Markdown table grid intact. */
function rollupCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Render the multi-step roll-up as a Markdown `<details>` block titled
 * "Multi-step roll-up (N sessions)". Aggregate scalars table sits at the
 * top, per-session table below. Returns the empty string when the job
 * only saw one session (or none) — the existing single-session renderer
 * already covers that case and a roll-up would be redundant noise.
 */
export function renderMultiSessionRollup(rollup: MultiSessionRollup): string {
  if (rollup.sessionCount <= 1) return "";
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>Multi-step roll-up (${rollup.sessionCount} sessions)</summary>`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Sessions | ${rollup.sessionCount} |`);
  lines.push(`| Total compilations | ${rollup.totalCompilations} |`);
  lines.push(`| Total hits | ${rollup.totalHits} |`);
  lines.push(`| Total misses | ${rollup.totalMisses} |`);
  lines.push(`| Overall hit rate | ${fmtPct(rollup.overallHitRate)} |`);
  if (rollup.totalTimeSavedMs > 0) {
    lines.push(`| Time saved (est.) | ${fmtMsRollup(rollup.totalTimeSavedMs)} |`);
  }
  if (rollup.totalBytesRead > 0) {
    lines.push(`| Bytes read | ${fmtBytesRollup(rollup.totalBytesRead)} |`);
  }
  if (rollup.totalBytesWritten > 0) {
    lines.push(`| Bytes written | ${fmtBytesRollup(rollup.totalBytesWritten)} |`);
  }
  lines.push("");
  lines.push("| Session | Hits | Misses | Hit rate | Time saved |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of rollup.sessions) {
    lines.push(
      `| ${rollupCell(row.sessionId)} | ${row.hits} | ${row.misses} | ${fmtPct(
        row.hitRate,
      )} | ${fmtMsRollup(row.timeSavedMs)} |`,
    );
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cook reuse-mismatch detection (issue #235).
// ---------------------------------------------------------------------------

/**
 * Inputs for the post-phase "cook produced no reuse" check. Every value is
 * read post-hoc in post.ts: setup-soldr cannot know at cook time which
 * profile or toolchain the consumer's later cargo step will use, so the
 * zero-reuse fingerprint is only observable after the job's compiles ran.
 */
export interface CookReuseMismatchInput {
  /** prebuild-deps cook was enabled this run. */
  cookEnabled: boolean;
  /** Cooked deps were present this run — cook ran (cold) or its cache restored (warm). */
  cookProducedDeps: boolean;
  /** Job-wide compile-cache hit count, or null when unavailable. */
  hits: number | null;
  /** Job-wide compile-cache miss count, or null when unavailable. */
  misses: number | null;
  /** Raw `prebuild-deps-flags` value, used only to tailor the suggested fix. */
  cookFlags: string;
}

export interface CookReuseMismatch {
  /** True when cook supplied deps but the session reused none of them. */
  mismatch: boolean;
  /** Actionable one-paragraph diagnostic; empty string when !mismatch. */
  message: string;
  /** Successful default-path diagnostics are notices, not warnings. */
  annotationLevel?: "notice";
}

/** True when the cook flag string requests a non-dev (release-ish) profile. */
export function cookFlagsRequestRelease(flags: string): boolean {
  const tokens = flags.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.includes("--release")) return true;
  const i = tokens.indexOf("--profile");
  if (i >= 0) {
    const profile = tokens[i + 1];
    if (profile && profile !== "dev" && profile !== "test") return true;
  }
  return false;
}

/**
 * Detect the "warm/ran cook, zero downstream reuse" fingerprint: cook
 * supplied dependency artifacts this run, yet the compile-cache session
 * recorded misses with zero hits. That means none of the cooked artifacts
 * matched what the job actually compiled — almost always a profile,
 * toolchain, or emit-kind mismatch between cook and the job's cargo step.
 *
 * Pure + tolerant: missing counters (null) yield no signal rather than a
 * false positive, so a job whose stats couldn't be read stays quiet. Only
 * the unambiguous `hits === 0 && misses > 0` case fires, to keep CI quiet.
 */
export function detectCookReuseMismatch(input: CookReuseMismatchInput): CookReuseMismatch {
  if (!input.cookEnabled || !input.cookProducedDeps) {
    return { mismatch: false, message: "" };
  }
  const { hits, misses } = input;
  if (hits === null || misses === null) return { mismatch: false, message: "" };
  if (!(hits === 0 && misses > 0)) return { mismatch: false, message: "" };

  const lead =
    `soldr cook prebuilt dependencies, but this job's compile cache recorded ` +
    `${misses} miss(es) and 0 hit(s) — none of the cooked artifacts were reused.`;
  let cause: string;
  if (cookFlagsRequestRelease(input.cookFlags)) {
    cause =
      ` cook ran with prebuild-deps-flags='${input.cookFlags.trim()}' (release profile), but ` +
      `cargo check/clippy/doc/test compile in the dev (debug) profile, which is a different ` +
      `cache key. Set prebuild-deps-flags: "" to cook in the debug profile so this job reuses ` +
      `it, or prebuild-deps: none if the job compiles under a different toolchain (build-cache ` +
      `still carries that work across runs).`;
  } else {
    cause =
      ` This usually means the job compiled under a different rust toolchain or profile than ` +
      `setup-soldr's cook (for example a nightly dylint/driver pass). cook cannot warm a ` +
      `different-toolchain compile; rely on the build-cache layer there, or set ` +
      `prebuild-deps: none to skip the unused cook.`;
  }
  return { mismatch: true, message: lead + cause, annotationLevel: "notice" };
}

// ---------------------------------------------------------------------------
// Compile-cache activity verification (issue #227).
//
// A job that is *supposed* to exercise the compile cache but reports
// `hits + misses == 0` either bypassed zccache (wrong RUSTC_WRAPPER, no
// SOLDR_CACHE_DIR, missing shims) or the measurement is invalid (stats file
// not found). Treating that as success silently launders a broken cache into
// "warm-cache evidence". This opt-in guard turns the zero-count into a loud,
// diagnosable signal while preserving legitimate bypass cases.
// ---------------------------------------------------------------------------

export type VerifyCompileCacheMode = "off" | "warn" | "error";

export interface CompileCacheVerifyInput {
  /** Parsed `verify-compile-cache` mode. */
  mode: VerifyCompileCacheMode;
  /** Action installed the real soldr (enable:true), not the passthrough stub. */
  enabled: boolean;
  /** build-cache layer is on (compile caching is expected this run). */
  buildCacheEnabled: boolean;
  /** `soldr cache report` status: ok / missing / unsupported / error. */
  reportStatus: string;
  hits: number | null;
  misses: number | null;
  /** Environment snapshot used to point at the likely bypass cause. */
  env: {
    rustcWrapper?: string;
    soldrCacheDir?: string;
    zccacheCacheDir?: string;
    shimsDir?: string;
    statsPath?: string;
  };
}

export interface CompileCacheVerifyResult {
  /** ok = cache observed work; invalid-measurement = zero-count; skipped = not checked. */
  status: "ok" | "invalid-measurement" | "skipped";
  /** Caller should fail the post step. */
  fail: boolean;
  /** Human-readable message (empty when status === "ok" or quietly skipped). */
  message: string;
}

/** Parse the `verify-compile-cache` input into a mode. */
export function parseVerifyCompileCacheMode(value: string): VerifyCompileCacheMode {
  const v = value.trim().toLowerCase();
  if (v === "error" || v === "fail" || v === "true" || v === "1" || v === "yes" || v === "on") {
    return "error";
  }
  if (v === "warn" || v === "warning") return "warn";
  return "off";
}

/**
 * Verify the compile cache observed cacheable work. Pure: all I/O is hoisted
 * into the `input` snapshot so this is unit-testable. Returns `skipped` for
 * every legitimate bypass (mode off, passthrough stub, build-cache disabled,
 * unreadable report, or null counters) so the guard never fails a job that
 * wasn't supposed to compile.
 */
export function verifyCompileCacheActivity(
  input: CompileCacheVerifyInput,
): CompileCacheVerifyResult {
  if (input.mode === "off") return { status: "skipped", fail: false, message: "" };
  if (!input.enabled) {
    return {
      status: "skipped",
      fail: false,
      message: "verify-compile-cache: skipped (enable:false passthrough — no soldr to measure).",
    };
  }
  if (!input.buildCacheEnabled) {
    return {
      status: "skipped",
      fail: false,
      message: "verify-compile-cache: skipped (build-cache disabled — compile caching opted out).",
    };
  }
  if (input.reportStatus !== "ok") {
    return {
      status: "skipped",
      fail: false,
      message:
        `verify-compile-cache: skipped (compile-cache report status '${input.reportStatus}' ` +
        `— stats unavailable, nothing to verify).`,
    };
  }
  if (input.hits === null || input.misses === null) {
    return {
      status: "skipped",
      fail: false,
      message: "verify-compile-cache: skipped (hit/miss counters unavailable).",
    };
  }
  if (input.hits + input.misses > 0) {
    return { status: "ok", fail: false, message: "" };
  }

  // hits + misses == 0 while compile caching was expected → bypass / invalid.
  const checks: string[] = [];
  const rw = input.env.rustcWrapper?.trim();
  checks.push(
    rw
      ? `RUSTC_WRAPPER=${rw}`
      : "RUSTC_WRAPPER is unset (cargo never routed compiles through the cache wrapper)",
  );
  checks.push(
    input.env.soldrCacheDir?.trim()
      ? `SOLDR_CACHE_DIR=${input.env.soldrCacheDir.trim()}`
      : "SOLDR_CACHE_DIR is unset",
  );
  checks.push(
    input.env.zccacheCacheDir?.trim()
      ? `ZCCACHE_CACHE_DIR=${input.env.zccacheCacheDir.trim()}`
      : "ZCCACHE_CACHE_DIR is unset",
  );
  if (input.env.shimsDir?.trim()) checks.push(`shims dir: ${input.env.shimsDir.trim()}`);
  checks.push(
    input.env.statsPath?.trim()
      ? `stats file: ${input.env.statsPath.trim()}`
      : "no per-session stats file was discovered",
  );

  const message =
    "verify-compile-cache: compile cache recorded 0 hits and 0 misses, but compile caching " +
    "was expected this run — the build was NOT routed through zccache (bypassed) or the " +
    "measurement is invalid. This is treated as a failed cache measurement, not warm-cache " +
    "evidence. Likely cause — inspect: " +
    checks.join("; ") +
    ". If this job intentionally compiles nothing (or runs under enable:false / build-cache:false), " +
    "set verify-compile-cache: off or leave it unset.";

  return { status: "invalid-measurement", fail: input.mode === "error", message };
}

// ---------------------------------------------------------------------------
// Delta-aware build-cache save gating (issues #230 / #214).
//
// On a fallback (restore-key) hit the build-cache key differs from what was
// restored, so the default behavior re-saves the whole (multi-GiB) payload —
// even when the job compiled almost nothing new. On Windows that archive +
// upload can dominate the job (#214). This gate skips the re-save when the
// session's new-compile signal is below a threshold, but stays conservative:
// it never blocks a cold seed (no restore) and never fires on an unreadable
// counter, so a real cache can always be seeded.
// ---------------------------------------------------------------------------

export interface BuildCacheSaveGateInput {
  /** A cache was restored this run (exact or restore-key fallback). */
  restored: boolean;
  /** zccache compilations recorded this session — the useful-delta proxy. */
  newCompiles: number | null;
  /** `build-cache-save-min-compiles`. <= 0 disables the gate (always save). */
  minCompiles: number;
  /**
   * A Dylint output cache (`dylint-output-cache`) was restored this run,
   * exact or fallback. Dylint then skips most rustc work, so the zccache
   * store only holds the handful of crates it re-checked: a thin entry that
   * must never replace (or LRU-evict) one produced by real compilation.
   */
  dylintOutputRestored?: boolean;
}

export interface BuildCacheSaveGate {
  /** Skip the build-cache save. */
  skip: boolean;
  /** Reason text (measured delta + threshold) when skip; empty otherwise. */
  reason: string;
}

/** Parse `build-cache-save-min-compiles` (default 1; empty → 1; clamped ≥ 0). */
export function parseMinCompiles(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 1;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

/**
 * Decide whether to skip a layered cache save based on the useful compile
 * delta. Pure. Skips only when: the gate is enabled (minCompiles > 0), a cache
 * was restored (so skipping doesn't lose a cold seed), the compile count is
 * known, and it is below the threshold. `gateName` controls the input name
 * surfaced in the reason text so the log line matches the action.yml input
 * the consumer would adjust.
 */
function decideCacheSaveGate(
  input: BuildCacheSaveGateInput,
  gateName: string,
): BuildCacheSaveGate {
  if (input.minCompiles <= 0) return { skip: false, reason: "" };
  // A run whose Dylint output came from cache did little compilation, so its
  // store is thin even when nothing was restored (the cold-seed exemption
  // below would otherwise upload it). Skip; a run that misses the output
  // cache compiles for real and seeds the layer.
  if (input.dylintOutputRestored) {
    return {
      skip: true,
      reason: `dylint-output-cache was restored, so this run's store is thin (${input.newCompiles ?? "unknown"} new compile(s)); a thin save would evict the real entry`,
    };
  }
  if (!input.restored) return { skip: false, reason: "" };
  if (input.newCompiles === null) return { skip: false, reason: "" };
  if (input.newCompiles < input.minCompiles) {
    return {
      skip: true,
      reason: `${input.newCompiles} new compile(s) < ${gateName}=${input.minCompiles}`,
    };
  }
  return { skip: false, reason: "" };
}

/**
 * Decide whether to skip the build-cache (zccache state) save. See
 * `decideCacheSaveGate`; this is the build-cache-named wrapper.
 */
export function decideBuildCacheSave(input: BuildCacheSaveGateInput): BuildCacheSaveGate {
  return decideCacheSaveGate(input, "build-cache-save-min-compiles");
}

/**
 * Decide whether to skip the target-cache (Rust target/ artifact) save. Same
 * delta-gate semantics as the build-cache, with the target-cache input name in
 * the reason text. (#255)
 */
export function decideTargetCacheSave(input: BuildCacheSaveGateInput): BuildCacheSaveGate {
  return decideCacheSaveGate(input, "target-cache-save-min-compiles");
}
