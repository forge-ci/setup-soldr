// bench-cache-cell.mjs — single-cell driver for the cache-mode benchmark.
//
// One invocation = one matrix cell (one (os, layer, rep) combination). Emits
// one or two CSV rows to --out: a 'cold' row always, plus a 'warm' row for
// layers whose snapshot/restore actually affects subsequent build wall clock.
//
// Per-cell flow:
//   1. Prepare a clean workload checkout under ${RUNNER_TEMP}/workload
//   2. Cold build (cargo build --release in the workload dir) — record wall clock
//      For cook-production, run `soldr cook` and snapshot its target/ output
//      before this user build, matching production cook-cache save timing.
//   3. Snapshot layer paths -> ${RUNNER_TEMP}/sim-cache/<layer>__<i>.tar.zst (tar+zstd -19 --long=27)
//   4. (build-affecting layers only) Wipe layer paths, target/, and any
//      out-of-scope zccache state, then restore from snapshot
//   5. (build-affecting layers only) Warm build — record wall clock
//
// The solo-toolchain cell supports a separate --pre-snapshot-out mode. The
// workflow runs that before setup-soldr, then passes --pre-snapshot-in to the
// measured cell so only toolchain files added on top of the runner image are
// archived.
//
// For layers that don't affect the workload's build (solo-toolchain, soldr-mini,
// setup-cache, baseline), the warm row is omitted; the CSV downstream treats
// those rows as "mechanics only" and skips speedup math.
//
// Usage:
//   node scripts/bench-cache-cell.mjs --layer=<name> --workload=<dirname> --rep=<n> --out=bench.csv
//
// Required env: RUNNER_TEMP (any path; tmpdir() is the local-dev fallback).
// Optional env: RUNNER_OS, BENCH_SKIP_BUILD (=1 to skip cargo for dry-runs).

import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathsForLayer, isActiveLayer, LAYER_NAMES } from "./bench-paths.mjs";

// Layers whose snapshot+restore changes what cargo finds at build time, so a
// warm rebuild is a meaningful measurement. Anything else is "mechanics only".
const BUILD_AFFECTING = new Set(["cargo-registry", "cook", "cook-production", "build", "target", "all-on"]);

// Layers we MUST NOT wipe — they're shared runner-image state. We still
// snapshot + restore-to-side, but skip the destructive wipe.
const WIPE_UNSAFE = new Set(["solo-toolchain", "soldr-mini", "setup-cache"]);

const args = parseArgs(process.argv.slice(2));
if (!args.layer) die("missing --layer");
if (!args.workload) die("missing --workload");
if (!LAYER_NAMES.includes(args.layer)) die(`unknown --layer=${args.layer} (allowed: ${LAYER_NAMES.join(",")})`);
const out = args.out ?? "bench.csv";
const rep = Number(args.rep ?? 1);
const skipBuild = process.env.BENCH_SKIP_BUILD === "1";
const runnerTemp = process.env.RUNNER_TEMP ?? os.tmpdir();
const runnerOs = process.env.RUNNER_OS ?? process.platform;
const cacheBackend = args["cache-backend"] ?? process.env.BENCH_CACHE_BACKEND ?? "local-tar-zstd";
const compressionModel = args["compression-model"] ?? process.env.BENCH_COMPRESSION_MODEL ?? "zstd-19-long27";
const cookProduction = args.layer === "cook-production";
const cookFlags = parseCookFlags(args["cook-flags"] ?? process.env.BENCH_COOK_FLAGS ?? "--release");

const workloadSrc = path.resolve("scripts", "bench-workloads", args.workload);
const workloadDir = path.join(runnerTemp, "bench-workload");
const simCacheDir = path.join(runnerTemp, "sim-cache");
await fsp.mkdir(simCacheDir, { recursive: true });

const env = { ...process.env, CARGO_TARGET_DIR: path.join(workloadDir, "target") };
const layerPaths = pathsForLayer(args.layer, { env, workloadDir });
const soloToolchainBasePaths = pathsForLayer("solo-toolchain", { env, workloadDir, includeRunnerToolchain: true });
const csvRows = [];
await writeCsv(csvRows);

// --- per-cell wall-clock watchdog --------------------------------------------
// A hung child (stuck cargo/soldr) must not tie up the runner indefinitely. We
// track the active phase name in a module-level variable and arm a timer that,
// on expiry, flushes a phase=timeout row capturing the stuck phase + any
// still-running child, then exits non-zero. BENCH_CELL_TIMEOUT_MS (or
// --timeout-ms=) overrides the default; <=0 disables the watchdog entirely.
const DEFAULT_CELL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const cellTimeoutMs = parseTimeoutMs(args["timeout-ms"] ?? process.env.BENCH_CELL_TIMEOUT_MS);
const cellStartMs = nowMs();
let activePhase = "init";
let timedOut = false;
const liveChildren = new Set();
let cellTimer = null;
if (cellTimeoutMs > 0) {
  cellTimer = setTimeout(() => { onCellTimeout().catch(() => process.exit(124)); }, cellTimeoutMs);
  if (typeof cellTimer.unref === "function") cellTimer.unref();
}
// Once the watchdog has fired, the main flow's pending awaits (a killed child
// rejects its run() promise) must not crash with a stack trace before we exit
// cleanly with 124. Swallow any post-timeout rejection.
process.on("unhandledRejection", (err) => {
  if (timedOut) return;
  console.error(`bench-cache-cell: unhandled rejection: ${err?.stack ?? err}`);
  process.exit(1);
});

log(`[bench] layer=${args.layer} workload=${args.workload} rep=${rep} paths=${layerPaths.length}`);

if (args["pre-snapshot-out"]) {
  if (args.layer !== "solo-toolchain" && args.layer !== "all-on") {
    die("--pre-snapshot-out is only supported for --layer=solo-toolchain or --layer=all-on");
  }
  await writePathStates(args["pre-snapshot-out"], soloToolchainBasePaths);
  log(`[bench] wrote pre-snapshot ${args["pre-snapshot-out"]}`);
  process.exit(0);
}

await prepareWorkload(workloadSrc, workloadDir);

// solo-toolchain overlaps runner-image state. Capture that baseline before the
// setup-soldr action runs, then only archive post-setup/cold added files.
const tracksSoloToolchainDelta = args.layer === "solo-toolchain" || args.layer === "all-on";
const preSnapshotStates = tracksSoloToolchainDelta
  ? args["pre-snapshot-in"]
    ? await readPathStates(args["pre-snapshot-in"])
    : await snapshotPathStates(soloToolchainBasePaths)
  : null;

let snapshotResult = null;
let coldPrebuildS = 0;
if (cookProduction) {
  activePhase = "cook-prebuild";
  const tCookStart = nowMs();
  await runSoldrCook(workloadDir, env, cookFlags);
  coldPrebuildS = (nowMs() - tCookStart) / 1000;
  log(`[bench] cook-production prebuild wall=${coldPrebuildS.toFixed(2)}s`);
  await quiesceCacheDaemonsBeforeSnapshot(env, workloadDir);
  snapshotResult = await snapshotLayer();
}

// --- 1. cold build -----------------------------------------------------------
activePhase = "cold";
const tColdStart = nowMs();
let wallColdS = 0;
if (skipBuild) {
  log(`[bench] BENCH_SKIP_BUILD=1, skipping cold cargo build`);
} else {
  await runCargoBuild(workloadDir, env);
}
wallColdS = coldPrebuildS + (nowMs() - tColdStart) / 1000;
log(`[bench] cold build wall=${wallColdS.toFixed(2)}s`);

if (!snapshotResult) {
  activePhase = "snapshot";
  await quiesceCacheDaemonsBeforeSnapshot(env, workloadDir);
  snapshotResult = await snapshotLayer();
} else {
  await quiesceCacheDaemonsBeforeSnapshot(env, workloadDir);
}

const { snapshots, saveTimeS, compressedMb, inflatedMb, ratio, soloToolchainDeltaEmpty } = snapshotResult;

csvRows.push(csvRow({
  os: runnerOs, layer: args.layer, phase: "cold", wallClockS: round(wallColdS, 2),
  saveTimeS: round(saveTimeS, 2), restoreTimeS: "",
  compressedMb, inflatedMb, ratio,
  workload: args.workload, rep,
}));
await writeCsv(csvRows);

// --- 3 + 4 + 5: restore + warm (only for build-affecting + wipe-safe) --------
const shouldWipe = !WIPE_UNSAFE.has(args.layer) && isActiveLayer(args.layer);
const shouldWarmBuild = BUILD_AFFECTING.has(args.layer) && isActiveLayer(args.layer);
const unsafeSnapshotKeys = unsafePathKeys(args.layer, env, workloadDir);
let restoreTimeS = 0;

if (snapshots.length > 0) {
  if (shouldWipe) {
    let wiped = 0;
    for (const s of snapshots) {
      if (unsafeSnapshotKeys.has(pathKey(s))) continue;
      await rmrf(path.join(s.parent, s.basename));
      wiped++;
    }
    log(`[bench] wiped ${wiped} path(s)`);
  } else if (isActiveLayer(args.layer)) {
    log(`[bench] layer ${args.layer} is wipe-unsafe; restoring into side dirs for mechanics measurement only`);
  }
}

if (shouldWarmBuild && shouldWipe) {
  await rmrf(env.CARGO_TARGET_DIR);
  log(`[bench] wiped CARGO_TARGET_DIR before warm build: ${env.CARGO_TARGET_DIR}`);
}

if (shouldWipeBuildCacheBeforeWarm(args.layer)) {
  let wipedBuildPaths = 0;
  for (const p of pathsForLayer("build", { env, workloadDir })) {
    await rmrf(path.join(p.parent, p.basename));
    wipedBuildPaths++;
  }
  log(`[bench] wiped build-cache path(s) before warm build: ${wipedBuildPaths}`);
}

if (snapshots.length > 0) {
  activePhase = "restore";
  for (const s of snapshots) {
    const restoreLive = shouldWipe && !unsafeSnapshotKeys.has(pathKey(s));
    const restoreRoot = restoreLive ? s.parent : path.join(runnerTemp, "sim-restore", args.layer);
    if (!restoreLive) await fsp.mkdir(restoreRoot, { recursive: true });
    const t0 = nowMs();
    await tarZstdExtract(s.archivePath, restoreRoot);
    restoreTimeS += (nowMs() - t0) / 1000;
  }
  log(`[bench] restore time=${restoreTimeS.toFixed(2)}s`);
}

if (shouldWarmBuild) {
  activePhase = "warm";
  const tWarmStart = nowMs();
  if (!skipBuild) await runCargoBuild(workloadDir, env);
  const wallWarmS = (nowMs() - tWarmStart) / 1000;
  log(`[bench] warm build wall=${wallWarmS.toFixed(2)}s`);

  // #192: capture zccache hit/miss/compile counts so a warm build that
  // recompiled everything (0 hits) is visible in the CSV. Best-effort: never
  // throw if soldr is absent or the report shape changes.
  const zstats = await captureZccacheStats(env);
  log(`[bench] warm zccache hits=${zstats.hits ?? "n/a"} misses=${zstats.misses ?? "n/a"} compilations=${zstats.compilations ?? "n/a"}`);

  csvRows.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "warm", wallClockS: round(wallWarmS, 2),
    saveTimeS: "", restoreTimeS: round(restoreTimeS, 2),
    compressedMb, inflatedMb, ratio,
    workload: args.workload, rep,
    zccacheHits: zstats.hits, zccacheMisses: zstats.misses, zccacheCompilations: zstats.compilations,
  }));
  await writeCsv(csvRows);
} else if (snapshots.length > 0 || soloToolchainDeltaEmpty) {
  // emit a mechanics-only row so downstream collation has size/save/restore numbers
  csvRows.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "mech", wallClockS: "",
    saveTimeS: round(saveTimeS, 2), restoreTimeS: round(restoreTimeS, 2),
    compressedMb, inflatedMb, ratio,
    workload: args.workload, rep,
  }));
  await writeCsv(csvRows);
}

activePhase = "done";
if (cellTimer) clearTimeout(cellTimer);
log(`[bench] wrote ${out} (${csvRows.length} row(s))`);

// ============================== helpers ======================================

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function parseCookFlags(raw) {
  return raw
    .trim()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseTimeoutMs(raw) {
  if (raw === undefined || raw === null || `${raw}`.trim() === "") return DEFAULT_CELL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CELL_TIMEOUT_MS;
  return n; // <=0 disables the watchdog
}

// On watchdog expiry: write a phase=timeout row that captures the active phase
// (in the workload column as "<workload>:timeout-in-<phase>") and the elapsed
// wall clock, flush partial CSV, record still-running children to a sidecar
// diagnostics file, then exit non-zero.
async function onCellTimeout() {
  timedOut = true;
  const elapsedS = round((nowMs() - cellStartMs) / 1000, 2);
  const stuck = [...liveChildren].map((c) => ({ pid: c.pid ?? null, cmd: c.__benchCmd ?? "" }));
  console.error(`bench-cache-cell: TIMEOUT after ${elapsedS}s in phase=${activePhase} ` +
    `(layer=${args.layer} workload=${args.workload} rep=${rep}); ${stuck.length} child(ren) still running`);

  // Kill the still-running children so their inherited stdio handles close and
  // this process can exit cleanly (otherwise the parent waits on orphaned pipes,
  // notably on Windows). On Windows a shell-wrapped child spawns a grandchild,
  // so use taskkill /T to tear down the whole tree by PID.
  await killLiveChildren();

  csvRows.push(csvRow({
    os: runnerOs, layer: args.layer, phase: "timeout", wallClockS: elapsedS,
    saveTimeS: "", restoreTimeS: "",
    compressedMb: "", inflatedMb: "", ratio: "",
    workload: `${args.workload}:timeout-in-${activePhase}`, rep,
  }));
  try { await writeCsv(csvRows); } catch { /* best-effort flush */ }

  const diagPath = `${path.resolve(out)}.timeout.json`;
  try {
    await fsp.writeFile(diagPath, JSON.stringify({
      version: 1,
      layer: args.layer, workload: args.workload, rep,
      activePhase, elapsedS, timeoutMs: cellTimeoutMs,
      liveChildren: stuck,
    }, null, 2), "utf8");
    console.error(`bench-cache-cell: wrote timeout diagnostics to ${diagPath}`);
  } catch { /* best-effort */ }

  for (const c of stuck) {
    console.error(`bench-cache-cell:   still-running pid=${c.pid} cmd=${c.cmd}`);
  }
  process.exit(124);
}

// #192: best-effort capture of last-session zccache hit/miss/compile counts via
// `soldr cache report --json`. Returns empty strings (CSV-safe) when soldr is
// absent, the command fails, or the JSON shape is unrecognized — never throws.
async function captureZccacheStats(envExt) {
  const empty = { hits: "", misses: "", compilations: "" };
  const soldr = envExt.SOLDR_BINARY?.trim() || "soldr";
  let result;
  try {
    result = await runBestEffort(soldr, ["cache", "report", "--json"], { env: envExt });
  } catch {
    return empty;
  }
  if (result.status !== "exit" || result.code !== 0 || !result.stdout) return empty;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return empty;
  }
  return extractZccacheStats(parsed);
}

// Pull hits/misses/compilations out of a `soldr cache report --json` payload.
// Tolerates a few shapes: a flat object, a {last_session|lastSession|stats}
// wrapper, or top-level keys. Missing fields become "".
function extractZccacheStats(parsed) {
  const empty = { hits: "", misses: "", compilations: "" };
  if (!parsed || typeof parsed !== "object") return empty;
  const node = parsed.last_session ?? parsed.lastSession ?? parsed.stats ?? parsed;
  if (!node || typeof node !== "object") return empty;
  return {
    hits: pickCount(node, ["hits", "cache_hits", "cacheHits"]),
    misses: pickCount(node, ["misses", "cache_misses", "cacheMisses"]),
    compilations: pickCount(node, ["compilations", "compiles", "compilation_count", "compilationCount"]),
  };
}

function pickCount(node, keys) {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return "";
}

async function killLiveChildren() {
  const kills = [];
  for (const c of liveChildren) {
    if (c.pid == null) continue;
    if (process.platform === "win32") {
      kills.push(new Promise((resolve) => {
        let killer;
        try {
          killer = spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
        } catch { resolve(); return; }
        killer.on("error", () => resolve());
        killer.on("exit", () => resolve());
      }));
    }
    try { c.kill("SIGKILL"); } catch { /* best-effort */ }
  }
  await Promise.all(kills);
}

function die(msg) { console.error(`bench-cache-cell: ${msg}`); process.exit(2); }
function log(msg) { console.log(msg); }
function nowMs() { return Number(process.hrtime.bigint() / 1_000_000n); }
function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }

function csvHeader() {
  return "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model,zccache_hits,zccache_misses,zccache_compilations";
}
function csvRow(r) {
  return [r.os, r.layer, r.phase, r.wallClockS, r.saveTimeS, r.restoreTimeS,
          r.compressedMb, r.inflatedMb, r.ratio, r.workload, r.rep,
          r.cacheBackend ?? cacheBackend, r.compressionModel ?? compressionModel,
          r.zccacheHits ?? "", r.zccacheMisses ?? "", r.zccacheCompilations ?? ""].join(",");
}

async function writeCsv(rows) {
  await fsp.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fsp.writeFile(out, [csvHeader(), ...rows].join("\n") + "\n", "utf8");
}

async function snapshotLayer() {
  // --- 2. snapshot -----------------------------------------------------------
  let snapshotPaths = layerPaths;
  let soloToolchainDeltaPaths = [];
  if (preSnapshotStates) {
    soloToolchainDeltaPaths = await materializeDeltaPaths(
      soloToolchainBasePaths,
      preSnapshotStates,
      path.join(runnerTemp, "sim-delta", args.layer, "solo-toolchain"),
    );
    snapshotPaths = args.layer === "solo-toolchain"
      ? soloToolchainDeltaPaths
      : dedupeLayerPaths([...layerPaths, ...soloToolchainDeltaPaths]);
  }
  const soloToolchainDeltaEmpty = args.layer === "solo-toolchain" && preSnapshotStates && snapshotPaths.length === 0;
  const allOnSoloToolchainDeltaEmpty = args.layer === "all-on" && preSnapshotStates && soloToolchainDeltaPaths.length === 0;
  if (soloToolchainDeltaEmpty) {
    log(`[bench] solo-toolchain delta is empty; emitting mechanics row without save/restore`);
  } else if (allOnSoloToolchainDeltaEmpty) {
    log(`[bench] all-on solo-toolchain delta is empty; runner-image toolchains excluded from snapshot`);
  }

  const snapshots = [];
  let totalCompressedMb = 0;
  let totalInflatedMb = 0;
  let saveTimeS = 0;
  for (let i = 0; i < snapshotPaths.length; i++) {
    const p = snapshotPaths[i];
    const archivePath = path.join(simCacheDir, `${args.layer}__${i}.tar.zst`);
    const inflated = await dirSizeBytes(path.join(p.parent, p.basename));
    if (inflated === 0) {
      log(`[bench] skip empty path ${p.parent}/${p.basename}`);
      continue;
    }
    const t0 = nowMs();
    await tarZstdCreate(archivePath, p.parent, p.basename);
    saveTimeS += (nowMs() - t0) / 1000;
    const compressed = await statSizeBytes(archivePath);
    snapshots.push({ ...p, archivePath, compressedBytes: compressed, inflatedBytes: inflated });
    totalCompressedMb += compressed / 1_000_000;
    totalInflatedMb += inflated / 1_000_000;
    log(`[bench] snap ${p.basename}: inflated=${(inflated / 1_000_000).toFixed(1)}MB compressed=${(compressed / 1_000_000).toFixed(1)}MB`);
  }

  const compressedMb = round(totalCompressedMb, 2);
  const inflatedMb = round(totalInflatedMb, 2);
  const ratio = totalInflatedMb > 0 ? round(totalInflatedMb / Math.max(totalCompressedMb, 0.001), 2) : 0;
  return { snapshots, saveTimeS, compressedMb, inflatedMb, ratio, soloToolchainDeltaEmpty };
}

async function prepareWorkload(src, dest) {
  await rmrf(dest);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await copyDir(src, dest);
  // Always start with no target/ so cold==cold.
  await rmrf(path.join(dest, "target"));
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "target") continue; // never copy build artifacts
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
}

async function statSizeBytes(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

async function snapshotPathStates(paths) {
  const states = new Map();
  for (const p of paths) {
    states.set(path.resolve(p.parent, p.basename), await fileStateMap(path.join(p.parent, p.basename)));
  }
  return states;
}

async function writePathStates(outPath, paths) {
  const states = await snapshotPathStates(paths);
  const payload = {
    version: 1,
    roots: [...states].map(([root, entries]) => ({
      root,
      entries: [...entries],
    })),
  };
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(payload), "utf8");
}

async function readPathStates(inPath) {
  if (!inPath) throw new Error("no pre-snapshot input");
  const payload = JSON.parse(await fsp.readFile(inPath, "utf8"));
  if (payload?.version !== 1 || !Array.isArray(payload.roots)) {
    throw new Error(`invalid pre-snapshot file: ${inPath}`);
  }
  const states = new Map();
  for (const root of payload.roots) {
    if (typeof root?.root !== "string" || !Array.isArray(root.entries)) continue;
    states.set(path.resolve(root.root), new Map(root.entries));
  }
  return states;
}

async function materializeDeltaPaths(paths, beforeStates, deltaRoot) {
  await rmrf(deltaRoot);
  const deltaPaths = [];
  for (const p of paths) {
    const srcRoot = path.join(p.parent, p.basename);
    const before = beforeStates.get(path.resolve(srcRoot)) ?? new Map();
    const after = await fileStateMap(srcRoot);
    let copied = 0;
    for (const [rel, state] of after) {
      if (before.has(rel)) continue;
      const dest = path.join(deltaRoot, p.basename, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await copyEntry(path.join(srcRoot, rel), dest, state);
      copied++;
    }
    if (copied > 0) {
      deltaPaths.push({ parent: deltaRoot, basename: p.basename });
      log(`[bench] solo-toolchain delta ${p.basename}: ${copied} added entr${copied === 1 ? "y" : "ies"}`);
    }
  }
  return deltaPaths;
}

async function fileStateMap(root) {
  const out = new Map();
  async function walk(d, relBase) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isSymbolicLink()) {
        try {
          const linkTarget = await fsp.readlink(full);
          out.set(rel, { kind: "symlink", linkTarget });
        } catch { /* ignore */ }
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          out.set(rel, { kind: "file", size: st.size });
        } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(root)) await walk(root, "");
  return out;
}

async function copyEntry(src, dest, state) {
  if (state?.kind === "symlink") {
    await fsp.symlink(state.linkTarget, dest).catch(async () => {
      const resolved = path.resolve(path.dirname(src), state.linkTarget);
      await fsp.copyFile(resolved, dest);
    });
    return;
  }
  await fsp.copyFile(src, dest);
}

function unsafePathKeys(layer, env, workloadDir) {
  const keys = new Set();
  if (WIPE_UNSAFE.has(layer)) {
    for (const p of pathsForLayer(layer, { env, workloadDir })) keys.add(pathKey(p));
    return keys;
  }
  if (layer !== "all-on") return keys;
  for (const name of WIPE_UNSAFE) {
    for (const p of pathsForLayer(name, { env, workloadDir })) keys.add(pathKey(p));
  }
  return keys;
}

function shouldWipeBuildCacheBeforeWarm(layer) {
  return BUILD_AFFECTING.has(layer) && !WIPE_UNSAFE.has(layer) && layer !== "build" && layer !== "all-on";
}

function pathKey(p) {
  return path.resolve(p.parent, p.basename);
}

function dedupeLayerPaths(paths) {
  const acc = [];
  for (const p of paths) addDedupedPath(acc, p);
  return acc;
}

function addDedupedPath(acc, candidate) {
  const candidateTarget = path.resolve(candidate.parent, candidate.basename);
  for (let i = 0; i < acc.length; i++) {
    const existingTarget = path.resolve(acc[i].parent, acc[i].basename);
    if (pathCovers(existingTarget, candidateTarget)) return;
    if (pathCovers(candidateTarget, existingTarget)) {
      acc.splice(i, 1);
      i--;
    }
  }
  acc.push(candidate);
}

function pathCovers(parentTarget, childTarget) {
  if (parentTarget === childTarget) return true;
  const rel = path.relative(parentTarget, childTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function dirSizeBytes(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try { total += (await fsp.stat(full)).size; } catch { /* ignore */ }
      } else if (e.isSymbolicLink()) {
        try { total += Math.max(1, Buffer.byteLength(await fsp.readlink(full))); } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(dir)) await walk(dir);
  return total;
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    // Pipe (not "inherit") child stdio and forward it to our own streams. This
    // keeps the child's output handles owned by THIS process rather than by our
    // caller's pipes, so when the watchdog hard-exits a stuck child, the
    // caller's pipe to us closes promptly instead of being held open by an
    // orphaned grandchild.
    const child = spawn(cmd, argv, spawnOptionsForCommand(cmd, { stdio: ["inherit", "pipe", "pipe"], ...opts }));
    trackChild(child, cmd, argv);
    child.stdout?.on("data", (d) => { process.stdout.write(d); });
    child.stderr?.on("data", (d) => { process.stderr.write(d); });
    // After the watchdog fires it kills children; the resulting non-zero/null
    // exit must neither reject (which would crash before the timeout row is
    // flushed) nor resolve (which would let the main flow race onCellTimeout's
    // exit). Once timed out, this promise simply never settles — onCellTimeout
    // owns process termination.
    child.on("error", (err) => { untrackChild(child); if (timedOut) return; reject(err); });
    child.on("exit", (code) => {
      untrackChild(child);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

function runBestEffort(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, spawnOptionsForCommand(cmd, { stdio: ["ignore", "pipe", "pipe"], ...opts }));
    } catch (err) {
      resolve({ status: "error", code: null, stdout: "", stderr: "", error: err });
      return;
    }
    trackChild(child, cmd, argv);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (err) => { untrackChild(child); resolve({ status: "error", code: null, stdout, stderr, error: err }); });
    child.on("exit", (code) => { untrackChild(child); resolve({ status: "exit", code, stdout, stderr, error: null }); });
  });
}

function trackChild(child, cmd, argv) {
  child.__benchCmd = `${cmd} ${(argv ?? []).join(" ")}`.trim();
  liveChildren.add(child);
}

function untrackChild(child) {
  liveChildren.delete(child);
}

function spawnOptionsForCommand(cmd, opts) {
  if (shouldUseWindowsCommandShell(cmd, opts.env)) {
    return { ...opts, shell: true };
  }
  return opts;
}

function shouldUseWindowsCommandShell(cmd, envExt) {
  if (process.platform !== "win32") return false;
  const ext = path.extname(cmd).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return true;
  if (ext) return false;

  const hasPathSeparator = cmd.includes(path.sep) || cmd.includes("/");
  const candidates = hasPathSeparator
    ? [path.dirname(cmd)]
    : envPathValue(envExt).split(path.delimiter).filter((entry) => entry.length > 0);
  const basename = hasPathSeparator ? path.basename(cmd) : cmd;
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, `${basename}.com`)) || fs.existsSync(path.join(dir, `${basename}.exe`))) {
      return false;
    }
    if (fs.existsSync(path.join(dir, `${basename}.bat`)) || fs.existsSync(path.join(dir, `${basename}.cmd`))) {
      return true;
    }
  }
  return false;
}

function envPathValue(envExt) {
  return envExt?.PATH ?? envExt?.Path ?? envExt?.path ?? process.env.PATH ?? process.env.Path ?? "";
}

async function quiesceCacheDaemonsBeforeSnapshot(envExt, workloadDir) {
  const buildCachePath = pathsForLayer("build", { env: envExt, workloadDir })[0];
  const buildCacheDir = path.join(buildCachePath.parent, buildCachePath.basename);
  const logsArchiveDir = path.join(buildCacheDir, "logs", "archive");
  const soldr = envExt.SOLDR_BINARY?.trim() || "soldr";

  log(`[bench] quiescing cache daemon(s) before snapshot`);
  const soldrResult = await runBestEffort(
    soldr,
    ["cache", "shutdown", "--archive-logs", logsArchiveDir],
    { env: envExt },
  );
  if (soldrResult.status === "exit" && soldrResult.code === 0) {
    log(`[bench] soldr cache shutdown completed`);
    return;
  }

  const canFallback =
    soldrResult.status === "error" ||
    (soldrResult.code === 2 && looksLikeUnsupportedSoldrShutdown(soldrResult.stderr));
  if (!canFallback) {
    log(`[bench] soldr cache shutdown exit ${soldrResult.code}; continuing best-effort without fallback`);
    return;
  }

  log(`[bench] soldr cache shutdown unavailable; falling back to zccache stop`);
  const zccacheResult = await runBestEffort("zccache", ["stop"], { env: envExt });
  if (zccacheResult.status === "exit" && zccacheResult.code === 0) {
    log(`[bench] zccache stop completed`);
  } else if (zccacheResult.status === "error") {
    log(`[bench] zccache stop spawn failed; continuing best-effort`);
  } else {
    log(`[bench] zccache stop exit ${zccacheResult.code}; continuing best-effort`);
  }
}

function looksLikeUnsupportedSoldrShutdown(stderr) {
  const s = stderr.toLowerCase();
  return (
    s.includes("unrecognized subcommand") ||
    s.includes("unknown subcommand") ||
    s.includes("invalid subcommand") ||
    s.includes("unexpected argument") ||
    s.includes("tool not found") ||
    s.includes("no release found")
  );
}

async function tarZstdCreate(archivePath, parent, basename) {
  // tar -cf - -C <parent> <basename> | zstd -T0 -19 --long=27 -o <archive>
  // We shell out via a single bash pipeline because node's spawn pipe glue is
  // verbose and the bench runs on hosted runners where bash + zstd are both
  // available (Windows runners have bsdtar + zstd via choco/preinstall).
  if (process.platform === "win32") {
    // bsdtar on Windows accepts --use-compress-program; zstd is shipped via
    // setup-soldr-contract.yml's setup-node + preinstalled tools. Fall back
    // to direct tar with --zstd if zstd CLI isn't on PATH.
    await run("tar", ["--use-compress-program=zstd -T0 -19 --long=27", "-cf", archivePath, "-C", parent, basename]);
  } else {
    await run("bash", ["-c", `tar -cf - -C ${shellEscape(parent)} ${shellEscape(basename)} | zstd -T0 -19 --long=27 -o ${shellEscape(archivePath)}`]);
  }
}

async function tarZstdExtract(archivePath, extractRoot) {
  await fsp.mkdir(extractRoot, { recursive: true });
  if (process.platform === "win32") {
    await run("tar", ["--use-compress-program=zstd -d --long=27", "-xf", archivePath, "-C", extractRoot]);
  } else {
    await run("bash", ["-c", `zstd -d --long=27 -c ${shellEscape(archivePath)} | tar -xf - -C ${shellEscape(extractRoot)}`]);
  }
}

function shellEscape(s) {
  // Safe-enough for bash -c with our known-clean paths (no spaces/$/backticks
  // expected in $RUNNER_TEMP or our workload paths). Reject obviously-unsafe
  // input rather than emit a buggy escape.
  if (/['"`$\\\n]/.test(s)) throw new Error(`refusing to shell-escape unsafe path: ${s}`);
  return /[ ()]/.test(s) ? `"${s}"` : s;
}

async function runSoldrCook(dir, envExt, flags) {
  const soldr = envExt.SOLDR_BINARY?.trim() || "soldr";
  const printableFlags = flags.length > 0 ? ` ${flags.join(" ")}` : "";
  log(`[bench] running production cook before cold build: ${soldr} cook${printableFlags}`);
  await run(soldr, ["cook", ...flags], { cwd: dir, env: envExt });
}

async function runCargoBuild(dir, envExt) {
  await run("cargo", ["build", "--release", "--quiet"], { cwd: dir, env: envExt });
}
