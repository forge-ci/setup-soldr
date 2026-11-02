// render-bench-summary.mjs - render collated CSV to a markdown table suitable
// for $GITHUB_STEP_SUMMARY. Usage:
//   node scripts/render-bench-summary.mjs <matrix-csv>

import * as fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: render-bench-summary.mjs <csv>");
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8").trim();
const lines = text.split(/\r?\n/);
if (lines.length < 2) {
  console.log("_(no rows)_");
  process.exit(0);
}

const header = lines[0].split(",");
const rows = lines.slice(1).map((l) => l.split(","));

const out = [];
out.push(`## Cache-mode benchmark - ${rows.length} row(s)`);
out.push("");
out.push("| " + header.join(" | ") + " |");
out.push("|" + header.map(() => "---").join("|") + "|");
for (const r of rows) out.push("| " + r.join(" | ") + " |");

const cols = {
  os: header.indexOf("os"),
  layer: header.indexOf("layer"),
  phase: header.indexOf("phase"),
  workload: header.indexOf("workload"),
  wall: header.indexOf("wall_clock_s"),
  speed: header.indexOf("speedup_s"),
  net: header.indexOf("net_benefit_s"),
  size: header.indexOf("inflated_mb"),
  breakEven: header.indexOf("break_even_warm_hits"),
  cacheBackend: header.indexOf("cache_backend"),
  compressionModel: header.indexOf("compression_model"),
  zccacheHits: header.indexOf("zccache_hits"),
  zccacheMisses: header.indexOf("zccache_misses"),
  zccacheCompilations: header.indexOf("zccache_compilations"),
};

if (cols.cacheBackend >= 0 || cols.compressionModel >= 0) {
  out.push("");
  out.push("### Methodology");
  out.push("");
  if (cols.cacheBackend >= 0) {
    out.push(`- Cache backend(s): ${uniqueValues(rows, cols.cacheBackend).map(code).join(", ")}`);
  }
  if (cols.compressionModel >= 0) {
    out.push(`- Compression model(s): ${uniqueValues(rows, cols.compressionModel).map(code).join(", ")}`);
  }
  out.push("- Rows using `local-tar-zstd` are synthetic local archive measurements, not direct Actions cache upload/download timings.");
  out.push("- Rows using `actions-cache` are opt-in smoke measurements from the GitHub Actions cache service for save/restore timing validation.");
}

const aggregates = warmAggregates(rows, cols);
if (aggregates.length) {
  out.push("");
  out.push("### Rep aggregates");
  out.push("");
  out.push("| os | workload | layer | reps | warm_wall_s_min | warm_wall_s_p50 | warm_wall_s_p95 | warm_wall_s_max | net_benefit_s_p50 | break_even_hits_p50 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const a of aggregates) {
    out.push(`| ${a.os} | ${a.workload} | ${a.layer} | ${a.reps} | ${a.wallMin} | ${a.wallP50} | ${a.wallP95} | ${a.wallMax} | ${a.netP50} | ${a.breakEvenP50} |`);
  }
}

// #192: surface zccache hit/miss/compile counts for cook warm rows so a
// "warm cook recompiled everything (0 hits)" result is visible at a glance.
const zccacheRows = cookWarmZccacheRows(rows, cols);
if (zccacheRows.length) {
  out.push("");
  out.push("### zccache stats (cook warm rows)");
  out.push("");
  out.push("| os | workload | layer | hits | misses | compilations | note |");
  out.push("|---|---|---|---|---|---|---|");
  for (const z of zccacheRows) {
    out.push(`| ${z.os} | ${z.workload} | ${z.layer} | ${z.hits} | ${z.misses} | ${z.compilations} | ${z.note} |`);
  }
}

out.push("");
out.push("### Retirement candidates (per issue criteria)");
out.push("");
out.push("Layers flagged below trip at least one threshold:");
out.push("- `net_benefit_s <= 2`");
out.push("- `break_even_warm_hits > 3`");
out.push("- `inflated_mb > 500`");
out.push("");

const flags = [];
for (const r of rows) {
  if (cols.phase < 0 || r[cols.phase] !== "warm") continue;
  const layer = cols.layer >= 0 ? r[cols.layer] : "(unknown)";
  const net = numAt(r, cols.net);
  const speed = numAt(r, cols.speed);
  const size = numAt(r, cols.size);
  const breakEven = numAt(r, cols.breakEven);
  const reasons = [];
  if (Number.isFinite(net) && net <= 2) reasons.push(`net_benefit_s=${net}`);
  if (Number.isFinite(breakEven) && breakEven > 3) reasons.push(`break_even_warm_hits=${breakEven}`);
  if (Number.isFinite(size) && size > 500) reasons.push(`inflated_mb=${size}, speedup_s=${speed}`);
  if (reasons.length) flags.push(`- **${layer}** - ${reasons.join("; ")}`);
}

if (flags.length === 0) out.push("_None flagged - all layers cleared the thresholds._");
else out.push(...flags);
out.push("");

process.stdout.write(out.join("\n") + "\n");

function uniqueValues(allRows, column) {
  return [...new Set(allRows.map((r) => r[column]).filter(Boolean))].sort();
}

function warmAggregates(allRows, columns) {
  if (["os", "layer", "phase", "workload", "wall"].some((name) => columns[name] < 0)) return [];
  const groups = new Map();
  for (const r of allRows) {
    if (r[columns.phase] !== "warm") continue;
    const key = `${r[columns.os]}|${r[columns.workload]}|${r[columns.layer]}`;
    const g = groups.get(key) ?? {
      os: r[columns.os],
      workload: r[columns.workload],
      layer: r[columns.layer],
      walls: [],
      nets: [],
      breakEvens: [],
    };
    pushNumber(g.walls, r[columns.wall]);
    pushNumber(g.nets, r[columns.net]);
    pushNumber(g.breakEvens, r[columns.breakEven]);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      os: g.os,
      workload: g.workload,
      layer: g.layer,
      reps: g.walls.length,
      wallMin: fmt(Math.min(...g.walls)),
      wallP50: fmt(p50(g.walls)),
      wallP95: fmt(p95(g.walls)),
      wallMax: fmt(Math.max(...g.walls)),
      netP50: fmt(p50(g.nets)),
      breakEvenP50: fmt(p50(g.breakEvens)),
    }))
    .filter((g) => g.reps > 0)
    .sort((a, b) => a.os.localeCompare(b.os) || a.workload.localeCompare(b.workload) || a.layer.localeCompare(b.layer));
}

// #192: collect cook/cook-production warm rows that carry zccache stats. The
// note column calls out the degenerate "0 hits" case so a warm cook that
// recompiled everything stands out in the rendered summary.
function cookWarmZccacheRows(allRows, columns) {
  if (columns.phase < 0 || columns.layer < 0 || columns.zccacheHits < 0) return [];
  const result = [];
  for (const r of allRows) {
    if (r[columns.phase] !== "warm") continue;
    const layer = r[columns.layer];
    if (layer !== "cook" && layer !== "cook-production") continue;
    const hits = numAt(r, columns.zccacheHits);
    const compilations = numAt(r, columns.zccacheCompilations);
    const hitsCell = cellOf(r, columns.zccacheHits);
    const missesCell = cellOf(r, columns.zccacheMisses);
    const compilationsCell = cellOf(r, columns.zccacheCompilations);
    if (hitsCell === "" && missesCell === "" && compilationsCell === "") continue;
    let note = "";
    if (Number.isFinite(hits) && hits === 0) note = "WARM COOK, 0 HITS - recompiled everything";
    else if (Number.isFinite(hits) && Number.isFinite(compilations) && compilations > hits) note = "more compilations than hits";
    result.push({
      os: columns.os >= 0 ? r[columns.os] : "(unknown)",
      workload: columns.workload >= 0 ? r[columns.workload] : "(unknown)",
      layer,
      hits: hitsCell,
      misses: missesCell,
      compilations: compilationsCell,
      note,
    });
  }
  return result;
}

function cellOf(row, column) {
  if (column < 0) return "";
  return row[column] ?? "";
}

function pushNumber(sink, raw) {
  if (raw === "" || raw === undefined) return;
  const n = Number(raw);
  if (Number.isFinite(n)) sink.push(n);
}

function p50(values) {
  return percentile(values, 0.5);
}

function p95(values) {
  return percentile(values, 0.95);
}

// Nearest-rank percentile on a 0-indexed sorted array. Matches the existing
// p50 lower-median behavior (floor of the fractional rank) so single-rep runs
// and the original p50 callers keep their values.
function percentile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * q);
  return sorted[idx];
}

function numAt(row, column) {
  if (column < 0) return NaN;
  if (row[column] === "" || row[column] === undefined) return NaN;
  const n = Number(row[column]);
  return Number.isFinite(n) ? n : NaN;
}

function fmt(n) {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "";
}

function code(value) {
  return `\`${value}\``;
}
