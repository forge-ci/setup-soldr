import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

async function writeNodeShim(binDir: string, name: string, source: string): Promise<string> {
  const scriptPath = path.join(binDir, `${name}.cjs`);
  await fs.writeFile(scriptPath, source, "utf8");

  if (process.platform === "win32") {
    const shimPath = path.join(binDir, `${name}.cmd`);
    await fs.writeFile(
      shimPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8",
    );
    return shimPath;
  }

  const shimPath = path.join(binDir, name);
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    "utf8",
  );
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

test("collate-bench appends amortized payback fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-collate-"));
  await fs.mkdir(path.join(dir, "cell"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "cell", "bench.csv"),
    [
      "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model",
      "Linux,target,cold,15,12,,8,62,7.75,demo-small,1,local-tar-zstd,zstd-19-long27",
      "Linux,target,warm,1,,0.5,8,62,7.75,demo-small,1,local-tar-zstd,zstd-19-long27",
      "",
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, ["scripts/collate-bench.mjs", dir]);
  const lines = stdout.trim().split(/\r?\n/);
  const header = lines[0]!.split(",");
  const warm = lines.find((line) => line.includes(",target,warm,"))!.split(",");

  assert.ok(header.includes("break_even_warm_hits"));
  assert.ok(header.includes("cold_plus_save_s"));
  assert.equal(warm[header.indexOf("speedup_s")], "14");
  assert.equal(warm[header.indexOf("net_benefit_s")], "13.5");
  assert.equal(warm[header.indexOf("break_even_warm_hits")], "0.89");
  assert.equal(warm[header.indexOf("cold_plus_save_s")], "27");
});

test("render-bench-summary reports methodology, aggregates, and amortized flags", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-render-"));
  const csv = path.join(dir, "bench-matrix.csv");
  await fs.writeFile(
    csv,
    [
      "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model,speedup_s,net_benefit_s,mb_per_second_saved,break_even_warm_hits,cold_plus_save_s",
      "Linux,all-on,cold,15,200,,173,806,4.6,demo-small,1,local-tar-zstd,zstd-19-long27,,,,,215",
      "Linux,all-on,warm,1,,1,173,806,4.6,demo-small,1,local-tar-zstd,zstd-19-long27,14,13,12.36,15.38,215",
      "",
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, ["scripts/render-bench-summary.mjs", csv]);
  assert.match(stdout, /### Methodology/);
  assert.match(stdout, /### Rep aggregates/);
  assert.match(stdout, /break_even_warm_hits=15\.38/);
  assert.match(stdout, /inflated_mb=806/);
  assert.match(stdout, /actions-cache/);
});

test("bench-cache-cell writes a labeled partial-safe CSV in dry-run mode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  const out = path.join(dir, "bench.csv");

  await execFileAsync(process.execPath, [
    "scripts/bench-cache-cell.mjs",
    "--layer=all-on",
    "--workload=demo-small",
    "--rep=1",
    "--out=" + out,
  ], {
    env: {
      ...process.env,
      BENCH_SKIP_BUILD: "1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: path.join(home, ".cargo"),
      RUSTUP_HOME: path.join(home, ".rustup"),
      ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
      SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
      SOLDR_INSTALL_DIR: path.join(runnerTemp, "setup-soldr-tools"),
    },
  });

  const csv = await fs.readFile(out, "utf8");
  const lines = csv.trim().split(/\r?\n/);
  assert.match(lines[0]!, /cache_backend,compression_model,zccache_hits,zccache_misses,zccache_compilations$/);
  assert.ok(lines.some((line) => line.includes(",all-on,cold,")));
  assert.ok(lines.some((line) => line.includes(",all-on,warm,")));
  assert.doesNotMatch(csv, /toolchains/);
});

test("bench-cache-cell falls back to zccache stop before snapshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-stop-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  const binDir = path.join(dir, "bin");
  const argsFile = path.join(dir, "zccache-args.txt");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  const out = path.join(dir, "bench.csv");

  const soldrShim = path.join(binDir, process.platform === "win32" ? "soldr.cmd" : "soldr");
  const zccacheShim = path.join(binDir, process.platform === "win32" ? "zccache.cmd" : "zccache");
  if (process.platform === "win32") {
    await fs.writeFile(
      soldrShim,
      "@echo off\r\necho error: unexpected argument 'shutdown' found 1>&2\r\nexit /b 2\r\n",
      "utf8",
    );
    await fs.writeFile(
      zccacheShim,
      `@echo off\r\necho %* > "${argsFile}"\r\nexit /b 0\r\n`,
      "utf8",
    );
  } else {
    await fs.writeFile(
      soldrShim,
      "#!/usr/bin/env sh\necho \"error: unexpected argument 'shutdown' found\" >&2\nexit 2\n",
      "utf8",
    );
    await fs.writeFile(
      zccacheShim,
      `#!/usr/bin/env sh\nprintf '%s\\n' "$*" > '${argsFile}'\n`,
      "utf8",
    );
    await fs.chmod(soldrShim, 0o755);
    await fs.chmod(zccacheShim, 0o755);
  }

  const result = await execFileAsync(process.execPath, [
    "scripts/bench-cache-cell.mjs",
    "--layer=baseline",
    "--workload=demo-small",
    "--rep=1",
    "--out=" + out,
  ], {
    env: {
      ...process.env,
      BENCH_SKIP_BUILD: "1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: path.join(home, ".cargo"),
      RUSTUP_HOME: path.join(home, ".rustup"),
      ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
      SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
      SOLDR_BINARY: soldrShim,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.match(
    result.stdout + result.stderr,
    /falling back to zccache stop/,
  );
  if (process.platform !== "win32") {
    assert.equal((await fs.readFile(argsFile, "utf8")).trim(), "stop");
  }
});

test("bench-cache-cell runs cook-production cook before cold cargo build and emits warm row", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-cook-prod-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  const binDir = path.join(dir, "bin");
  const eventsFile = path.join(dir, "events.log");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  const out = path.join(dir, "bench.csv");
  const soldrShim = await writeNodeShim(binDir, "soldr", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const events = process.env.BENCH_EVENT_LOG;
function log(line) { fs.appendFileSync(events, line + "\\n"); }
log("soldr " + args.join(" "));
if (args[0] === "cook") {
  const target = path.join(process.cwd(), "target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "cook-output.txt"), "cook\\n");
  process.exit(0);
}
if (args[0] === "cache" && args[1] === "shutdown") process.exit(0);
process.exit(2);
`);
  await writeNodeShim(binDir, "cargo", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const events = process.env.BENCH_EVENT_LOG;
fs.appendFileSync(events, "cargo " + args.join(" ") + "\\n");
const target = process.env.CARGO_TARGET_DIR || path.join(process.cwd(), "target");
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "user-build.txt"), "cargo\\n");
`);
  await writeNodeShim(binDir, "tar", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const events = process.env.BENCH_EVENT_LOG;
function log(line) { fs.appendFileSync(events, line + "\\n"); }
function restoreTarget(root) {
  const target = path.join(root, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "cook-output.txt"), "cook\\n");
}
if (args.includes("-cf")) {
  const archive = args[args.indexOf("-cf") + 1];
  const parent = args[args.indexOf("-C") + 1];
  const basename = args[args.length - 1];
  const target = path.join(parent, basename);
  log("archive create hasCook=" + fs.existsSync(path.join(target, "cook-output.txt")) + " hasUser=" + fs.existsSync(path.join(target, "user-build.txt")));
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "archive\\n");
  process.exit(0);
}
if (args.includes("-xf")) {
  const root = args[args.indexOf("-C") + 1];
  log("archive extract");
  restoreTarget(root);
  process.exit(0);
}
process.exit(2);
`);
  await writeNodeShim(binDir, "bash", `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const script = args[1] || "";
const events = process.env.BENCH_EVENT_LOG;
function log(line) { fs.appendFileSync(events, line + "\\n"); }
function token(pattern) {
  const match = pattern.exec(script);
  return match && (match[1] || match[2] || match[3] || match[4]);
}
function restoreTarget(root) {
  const target = path.join(root, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "cook-output.txt"), "cook\\n");
}
if (script.includes("tar -cf -")) {
  const parent = token(/ -C (?:"([^"]+)"|(\\S+)) /);
  const basenameMatch = / -C (?:"[^"]+"|\\S+) (?:"([^"]+)"|(\\S+)) \\|/.exec(script);
  const basename = basenameMatch && (basenameMatch[1] || basenameMatch[2]);
  const archive = token(/ -o (?:"([^"]+)"|(\\S+))$/);
  const target = path.join(parent, basename);
  log("archive create hasCook=" + fs.existsSync(path.join(target, "cook-output.txt")) + " hasUser=" + fs.existsSync(path.join(target, "user-build.txt")));
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, "archive\\n");
  process.exit(0);
}
if (script.includes("tar -xf -")) {
  const root = token(/ -C (?:"([^"]+)"|(\\S+))$/);
  log("archive extract");
  restoreTarget(root);
  process.exit(0);
}
process.exit(2);
`);

  await execFileAsync(process.execPath, [
    "scripts/bench-cache-cell.mjs",
    "--layer=cook-production",
    "--workload=demo-small",
    "--rep=1",
    "--out=" + out,
  ], {
    env: {
      ...process.env,
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: path.join(home, ".cargo"),
      RUSTUP_HOME: path.join(home, ".rustup"),
      ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
      SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
      SOLDR_INSTALL_DIR: path.join(runnerTemp, "setup-soldr-tools"),
      SOLDR_BINARY: soldrShim,
      BENCH_EVENT_LOG: eventsFile,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  const csv = await fs.readFile(out, "utf8");
  assert.ok(csv.split(/\r?\n/).some((line) => line.includes(",cook-production,warm,")));
  const events = (await fs.readFile(eventsFile, "utf8")).trim().split(/\r?\n/);
  const soldrCook = events.findIndex((line) => line === "soldr cook --release");
  const archiveCreate = events.findIndex((line) => line.startsWith("archive create "));
  const firstCargo = events.findIndex((line) => line === "cargo build --release --quiet");
  assert.notEqual(soldrCook, -1);
  assert.notEqual(archiveCreate, -1);
  assert.notEqual(firstCargo, -1);
  assert.ok(soldrCook < archiveCreate);
  assert.ok(archiveCreate < firstCargo);
  assert.match(events[archiveCreate]!, /hasCook=true/);
  assert.match(events[archiveCreate]!, /hasUser=false/);
  assert.equal(events.filter((line) => line === "cargo build --release --quiet").length, 2);
});

test("bench-cache-cell emits zccache hit/miss/compile columns in the header (#192)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-zc-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  const out = path.join(dir, "bench.csv");

  await execFileAsync(process.execPath, [
    "scripts/bench-cache-cell.mjs",
    "--layer=baseline",
    "--workload=demo-small",
    "--rep=1",
    "--out=" + out,
  ], {
    env: {
      ...process.env,
      BENCH_SKIP_BUILD: "1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: runnerTemp,
      HOME: home,
      USERPROFILE: home,
      CARGO_HOME: path.join(home, ".cargo"),
      RUSTUP_HOME: path.join(home, ".rustup"),
      ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
      SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
      SOLDR_INSTALL_DIR: path.join(runnerTemp, "setup-soldr-tools"),
    },
  });

  const csv = await fs.readFile(out, "utf8");
  const header = csv.trim().split(/\r?\n/)[0]!.split(",");
  assert.ok(header.includes("zccache_hits"));
  assert.ok(header.includes("zccache_misses"));
  assert.ok(header.includes("zccache_compilations"));
});

test("bench-cache-cell writes a phase=timeout row and diagnostics on watchdog expiry (#191)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-cell-timeout-"));
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  const binDir = path.join(dir, "bin");
  await fs.mkdir(path.join(home, ".cargo"), { recursive: true });
  await fs.mkdir(path.join(home, ".rustup"), { recursive: true });
  await fs.mkdir(runnerTemp, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  const out = path.join(dir, "bench.csv");

  // A cargo shim that hangs forever, so the cold build never returns and the
  // watchdog (BENCH_CELL_TIMEOUT_MS) fires.
  await writeNodeShim(binDir, "cargo", `setInterval(() => {}, 1000);\n`);

  let failed = false;
  let stderr = "";
  try {
    await execFileAsync(process.execPath, [
      "scripts/bench-cache-cell.mjs",
      "--layer=target",
      "--workload=demo-small",
      "--rep=1",
      "--out=" + out,
    ], {
      env: {
        ...process.env,
        RUNNER_OS: "Linux",
        RUNNER_TEMP: runnerTemp,
        HOME: home,
        USERPROFILE: home,
        CARGO_HOME: path.join(home, ".cargo"),
        RUSTUP_HOME: path.join(home, ".rustup"),
        ZCCACHE_CACHE_DIR: path.join(home, ".cache", "zccache"),
        SETUP_SOLDR_CACHE_PATH: path.join(runnerTemp, "setup-soldr-cache"),
        SOLDR_INSTALL_DIR: path.join(runnerTemp, "setup-soldr-tools"),
        // The cargo shim hangs forever, so the watchdog always fires in the cold
        // phase; it only has to outlast `init`. 300 ms expired inside `init` on
        // a loaded host.
        BENCH_CELL_TIMEOUT_MS: "10000",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
  } catch (err) {
    failed = true;
    stderr = String((err as { stderr?: string }).stderr ?? "");
    assert.equal((err as { code?: number }).code, 124);
  }

  assert.ok(failed, "watchdog should make the process exit non-zero");
  assert.match(stderr, /TIMEOUT after .* in phase=cold/);

  const csv = await fs.readFile(out, "utf8");
  assert.ok(
    csv.split(/\r?\n/).some((line) => line.includes(",timeout,")),
    "CSV must carry a phase=timeout row",
  );
  assert.match(csv, /demo-small:timeout-in-cold/);

  const diag = JSON.parse(await fs.readFile(out + ".timeout.json", "utf8"));
  assert.equal(diag.activePhase, "cold");
  assert.ok(Array.isArray(diag.liveChildren));
});

test("render-bench-summary reports p95 and surfaces 0-hit cook warm rows (#191/#192)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-soldr-render-p95-"));
  const csv = path.join(dir, "bench-matrix.csv");
  const head =
    "os,layer,phase,wall_clock_s,save_time_s,restore_time_s,compressed_mb,inflated_mb,ratio,workload,rep,cache_backend,compression_model,zccache_hits,zccache_misses,zccache_compilations,speedup_s,net_benefit_s,mb_per_second_saved,break_even_warm_hits,cold_plus_save_s";
  await fs.writeFile(
    csv,
    [
      head,
      "Linux,cook,cold,30,10,,20,120,6,demo-small,1,local-tar-zstd,zstd-19-long27,,,,,,,,,40",
      "Linux,cook,warm,28,,2,20,120,6,demo-small,1,local-tar-zstd,zstd-19-long27,0,500,500,2,0,10,5,40",
      "Linux,cook,cold,30,10,,20,120,6,demo-small,2,local-tar-zstd,zstd-19-long27,,,,,,,,,40",
      "Linux,cook,warm,5,,2,20,120,6,demo-small,2,local-tar-zstd,zstd-19-long27,490,10,10,25,23,4,1,40",
      "",
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, ["scripts/render-bench-summary.mjs", csv]);
  assert.match(stdout, /warm_wall_s_p95/);
  assert.match(stdout, /### zccache stats \(cook warm rows\)/);
  assert.match(stdout, /WARM COOK, 0 HITS/);
});

// expand-bench-matrix prints raw matrix JSON to stdout only when GITHUB_OUTPUT
// is unset; with it set (as in CI) it writes the file and logs a "wrote
// matrix=..." line instead. Strip it so these tests parse JSON either way.
function matrixEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env["GITHUB_OUTPUT"];
  return env;
}

test("expand-bench-matrix honors the standard reps preset (#191)", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/expand-bench-matrix.mjs",
    "--reps-preset=standard",
  ], {
    env: matrixEnv({ INPUT_LAYERS: "target", INPUT_OSES: "ubuntu-24.04", INPUT_REPS: "" }),
  });
  const matrix = JSON.parse(stdout.trim());
  const reps = matrix.include.filter((c: { layer: string }) => c.layer === "target");
  assert.equal(reps.length, 3);
  assert.deepEqual(reps.map((c: { rep: number }) => c.rep).sort(), [1, 2, 3]);
});

test("expand-bench-matrix keeps reps=1 default backward compatible (#191)", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/expand-bench-matrix.mjs"], {
    env: matrixEnv({ INPUT_LAYERS: "target", INPUT_OSES: "ubuntu-24.04", INPUT_REPS: "" }),
  });
  const matrix = JSON.parse(stdout.trim());
  assert.equal(matrix.include.filter((c: { layer: string }) => c.layer === "target").length, 1);
});
