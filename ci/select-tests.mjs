#!/usr/bin/env node
// TEST-004 (forge-ci/ci.yml#518): run only the node test suites a change
// touches, from a declared, reviewable map (ci/test-selection.json).
//
//   node ci/select-tests.mjs plan  [--base REF] [--head REF] [--all] [--json]
//                                  [--github-output] [--summary] [--suite NAME]...
//                                  [FILE...]
//   node ci/select-tests.mjs run   (same flags) -- plan, then run the suites
//   node ci/select-tests.mjs check -- the selector self-test
//   node ci/select-tests.mjs graph -- which suites read each file
//
// Selection is fail-closed:
//   * a path in `always`, or a test file no suite lists, or an added/renamed/
//     deleted test file selects every suite;
//   * a path matching no rule and no `ignore` glob selects every suite;
//   * after the declared rules pick suites, the import graph of every test
//     file is checked: if a test that (transitively) imports a changed file,
//     or names it as a string literal, sits in a suite that was NOT selected,
//     the selector refuses (exit 3). A stale map fails the run; it can never
//     silently skip a suite that would have caught the change.
//
// With no FILE arguments the change set is `git diff --name-status BASE...HEAD`
// (BASE defaults to the merge base with origin/main). FILE arguments are
// treated as modified paths; `A:path` / `D:path` mark additions/deletions.
// `--suite NAME` (repeatable) runs the named suites as-is (npm run test:<name>).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "ci/test-selection.json";
const NODE_TEST_FLAGS = [
  "--test",
  "--test-timeout=120000",
  "--experimental-strip-types",
  "--import",
  "./__tests__/register-loader.mjs",
];

export class SelectionError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

// ── globs ───────────────────────────────────────────────────────────────────

/** `**` crosses directories, `*` and `?` do not. Anchored, case-sensitive. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
export function matches(glob, file) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(file);
}
const anyMatch = (globs, file) => globs.some((g) => matches(g, file));

// ── config ──────────────────────────────────────────────────────────────────

export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new SelectionError(`cannot read ${CONFIG_FILE}: ${err.message}`);
  }
  for (const key of ["suites", "always", "ignore", "rules"]) {
    if (cfg[key] === undefined) throw new SelectionError(`${CONFIG_FILE}: missing "${key}"`);
  }
  cfg.unlisted ??= [];
  cfg.opaque ??= [];
  const owner = new Map();
  for (const [suite, files] of Object.entries(cfg.suites)) {
    for (const f of files) {
      if (owner.has(f)) throw new SelectionError(`${CONFIG_FILE}: ${f} is in both '${owner.get(f)}' and '${suite}'`);
      owner.set(f, suite);
    }
  }
  for (const rule of cfg.rules) {
    for (const s of rule.suites) {
      if (!cfg.suites[s]) throw new SelectionError(`${CONFIG_FILE}: rule names unknown suite '${s}'`);
    }
  }
  cfg.owner = owner;
  return cfg;
}

/** The test files `npm test` runs today, in order (pretest first). */
export function npmTestFiles(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const pick = (script) => (script ?? "").split(/\s+/).filter((t) => /^__tests__\/.+\.test\.ts$/.test(t));
  return [...pick(pkg.scripts?.pretest), ...pick(pkg.scripts?.test)];
}

// ── import graph ────────────────────────────────────────────────────────────

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function resolveImport(root, fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(path.dirname(path.join(root, fromFile)), spec);
  const candidates = [abs, abs.replace(/\.js$/, ".ts"), abs.replace(/\.mjs$/, ".mts"), `${abs}.ts`, `${abs}.mjs`, `${abs}.js`];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(root, c).split(path.sep).join("/");
  }
  return null;
}

/**
 * For each test file, the set of repo files it can observe: its transitive
 * relative-import closure, plus every tracked non-test file whose repo path
 * appears as a string literal in any file of that closure (tests that read
 * `action.yml`, a workflow or a script off disk).
 */
export function buildGraph(root, testFiles, tracked, opaque = []) {
  const literalTargets = tracked.filter((f) => !f.startsWith("__tests__/") && !f.startsWith("dist") && !f.includes("/dist/"));
  const textCache = new Map();
  const read = (f) => {
    if (!textCache.has(f)) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, f), "utf8");
      } catch {
        // missing file: nothing to follow
      }
      textCache.set(f, text);
    }
    return textCache.get(f);
  };
  const graph = new Map();
  for (const test of testFiles) {
    const seen = new Set([test]);
    const queue = [test];
    while (queue.length) {
      const cur = queue.shift();
      const text = read(cur);
      for (const m of text.matchAll(SPECIFIER)) {
        const dep = resolveImport(root, cur, m[1]);
        if (dep && !seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    // `opaque` tests name repo paths as data (the selector's own fixtures), not as reads.
    const closureText = [...seen].filter((f) => !opaque.includes(f)).map(read).join("\n");
    for (const f of literalTargets) {
      if (!seen.has(f) && (closureText.includes(`"${f}"`) || closureText.includes(`'${f}'`) || closureText.includes(`\`${f}\``))) {
        seen.add(f);
      }
    }
    seen.delete(test);
    graph.set(test, seen);
  }
  return graph;
}

// ── selection ───────────────────────────────────────────────────────────────

/** `changes`: [{ status: "A"|"M"|"D"|"R", path, from? }]. */
export function select(changes, cfg, graph = null) {
  const allSuites = Object.keys(cfg.suites);
  const picked = new Set();
  const reasons = [];
  let all = null;
  const everything = (why) => {
    if (!all) all = why;
  };
  for (const ch of changes) {
    const paths = ch.from ? [ch.from, ch.path] : [ch.path];
    for (const p of paths) {
      if (anyMatch(cfg.always, p)) {
        reasons.push({ path: p, suites: ["*"], why: "always-run input" });
        everything(`${p} is an always-run input`);
        continue;
      }
      if (/^__tests__\/.+\.test\.ts$/.test(p)) {
        const suite = cfg.owner.get(p);
        const known = suite || cfg.unlisted.includes(p);
        if (ch.status !== "M" || !known || !graph) {
          const why = !known
            ? "a test file no suite lists"
            : ch.status !== "M"
              ? `a test file was ${ch.status === "A" ? "added" : ch.status === "D" ? "deleted" : "renamed"}`
              : "a test file changed and no import graph was supplied";
          reasons.push({ path: p, suites: ["*"], why });
          everything(`${p}: ${why}`);
          continue;
        }
        // The file's own suite, plus the suite of every test that imports it.
        const suites = new Set(suite ? [suite] : []);
        for (const [test, deps] of graph) if (deps.has(p)) suites.add(cfg.owner.get(test));
        suites.delete(undefined);
        if (suites.size === 0) {
          reasons.push({ path: p, suites: ["*"], why: "an unlisted test file nothing imports" });
          everything(`${p}: unlisted and imported by no suite`);
          continue;
        }
        for (const s of suites) picked.add(s);
        reasons.push({ path: p, suites: [...suites], why: suite ? "test file (and its importers)" : "unlisted test file, run by its importers" });
        continue;
      }
      const hits = cfg.rules.filter((r) => anyMatch(r.paths, p));
      if (hits.length > 0) {
        const suites = [...new Set(hits.flatMap((r) => r.suites))];
        for (const s of suites) picked.add(s);
        reasons.push({ path: p, suites, why: "rule" });
        continue;
      }
      if (anyMatch(cfg.ignore, p)) {
        reasons.push({ path: p, suites: [], why: "ignored (cannot affect node tests)" });
        continue;
      }
      reasons.push({ path: p, suites: ["*"], why: "matches no rule (fail closed)" });
      everything(`${p} matches no rule`);
    }
  }
  const suites = all ? allSuites : allSuites.filter((s) => picked.has(s));
  return { all, suites, reasons };
}

/**
 * The under-selection guard: every test whose graph reaches a changed path
 * must be in a selected suite. Returns the misses (empty = sound).
 */
export function guard(changes, selection, cfg, graph) {
  if (selection.all) return [];
  const selected = new Set(selection.suites);
  const misses = [];
  for (const ch of changes) {
    for (const p of ch.from ? [ch.from, ch.path] : [ch.path]) {
      for (const [test, deps] of graph) {
        if (!deps.has(p)) continue;
        const suite = cfg.owner.get(test);
        if (suite && !selected.has(suite)) misses.push({ path: p, test, suite });
      }
    }
  }
  return misses;
}

export function testFilesFor(suites, cfg, order) {
  const want = new Set(suites.flatMap((s) => cfg.suites[s]));
  const ordered = order.filter((f) => want.has(f));
  for (const f of want) if (!ordered.includes(f)) ordered.push(f);
  return ordered;
}

// ── self-test ───────────────────────────────────────────────────────────────

export function check(root, cfg, tracked) {
  const problems = [];
  const listed = [...cfg.owner.keys()];
  const npm = npmTestFiles(root);
  for (const f of npm) if (!cfg.owner.has(f)) problems.push(`npm test runs ${f}, but no suite lists it`);
  for (const f of listed) if (!npm.includes(f)) problems.push(`suite file ${f} is not in npm test (the union must equal npm test)`);
  for (const f of tracked.filter((t) => /^__tests__\/.+\.test\.ts$/.test(t))) {
    if (!cfg.owner.has(f) && !cfg.unlisted.includes(f)) problems.push(`${f} is in no suite and not 'unlisted'`);
  }
  for (const f of [...listed, ...cfg.unlisted]) if (!tracked.includes(f)) problems.push(`${f} is declared but not tracked`);
  for (const rule of cfg.rules) {
    for (const g of rule.paths) if (!tracked.some((t) => matches(g, t))) problems.push(`rule glob ${g} matches no tracked file`);
  }
  for (const [suite, files] of Object.entries(cfg.suites)) {
    if (files.length === 0) problems.push(`suite ${suite} is empty`);
  }
  // Hidden-change self-test: a synthetic edit to every tracked file a test
  // can observe must select that test's suite through the declared map alone.
  const graph = buildGraph(root, listed, tracked, cfg.opaque);
  const observed = new Set([...graph.values()].flatMap((s) => [...s]));
  for (const f of observed) {
    const changes = [{ status: "M", path: f }];
    const sel = select(changes, cfg, graph);
    for (const m of guard(changes, sel, cfg, graph)) {
      problems.push(`a change to ${m.path} would not select '${m.suite}', but ${m.test} reads it`);
    }
  }
  for (const [suite, files] of Object.entries(cfg.suites)) {
    for (const f of files) {
      const sel = select([{ status: "M", path: f }], cfg, graph);
      if (!sel.suites.includes(suite)) problems.push(`editing ${f} does not select its own suite '${suite}'`);
    }
  }
  return { problems, observed: observed.size };
}

// ── git ─────────────────────────────────────────────────────────────────────

function git(root, args) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (res.status !== 0) throw new SelectionError(`git ${args.join(" ")}: ${(res.stderr || "").trim()}`);
  return res.stdout;
}

export function trackedFiles(root) {
  return git(root, ["ls-files"]).split("\n").filter(Boolean);
}

export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const [status, a, b] = line.split("\t");
    const s = status[0];
    if (s === "R" || s === "C") out.push({ status: "R", from: a, path: b });
    else out.push({ status: s === "A" ? "A" : s === "D" ? "D" : "M", path: a });
  }
  return out;
}

export function diffChanges(root, base, head = "HEAD") {
  return parseNameStatus(git(root, ["diff", "--name-status", "-M", `${base}...${head}`]));
}

function parseFileArg(arg) {
  const m = /^([AMD]):(.+)$/.exec(arg);
  return m ? { status: m[1], path: m[2] } : { status: "M", path: arg };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function plan(root, { base, head, files, all, suites: named = [] }) {
  const cfg = loadConfig(root);
  if (named.length > 0) {
    for (const n of named) if (!cfg.suites[n]) throw new SelectionError(`unknown suite '${n}' (have: ${Object.keys(cfg.suites).join(", ")})`);
    const suites = Object.keys(cfg.suites).filter((x) => named.includes(x));
    return { cfg, changes: [], selection: { all: null, suites, reasons: [] }, misses: [], source: `--suite ${suites.join(",")}` };
  }
  let changes;
  let source;
  if (files.length > 0) {
    changes = files.map(parseFileArg);
    source = "explicit file list";
  } else {
    const ref = base ?? (spawnSync("git", ["merge-base", "origin/main", head ?? "HEAD"], { cwd: root, encoding: "utf8" }).stdout || "").trim();
    if (!ref) {
      return { cfg, changes: [], selection: { all: "no merge base: cannot compute the change set", suites: Object.keys(cfg.suites), reasons: [] }, misses: [], source: "none" };
    }
    changes = diffChanges(root, ref, head ?? "HEAD");
    source = `git diff ${ref.slice(0, 12)}...${head ?? "HEAD"}`;
  }
  const graph = buildGraph(root, [...cfg.owner.keys()], trackedFiles(root), cfg.opaque);
  const selection = all ? { all: "--all requested", suites: Object.keys(cfg.suites), reasons: [] } : select(changes, cfg, graph);
  const misses = guard(changes, selection, cfg, graph);
  return { cfg, changes, selection, misses, source };
}

export function renderSummary(result) {
  const { selection, changes, misses, source, cfg } = result;
  const lines = ["### Test selection (TEST-004)", ""];
  lines.push(`Change set: ${source}, ${changes.length} path(s).`, "");
  if (misses.length > 0) {
    lines.push("**Under-selection guard failed** -- the declared map missed suites the import graph needs:", "");
    for (const m of misses) lines.push(`- \`${m.path}\` is read by \`${m.test}\` (suite \`${m.suite}\`)`);
    lines.push("");
  }
  lines.push(selection.all ? `**All suites** -- ${selection.all}.` : `**Selected:** ${selection.suites.map((s) => `\`${s}\``).join(", ") || "none"}`);
  const skipped = Object.keys(cfg.suites).filter((s) => !selection.suites.includes(s));
  if (skipped.length) lines.push("", `Skipped (TEST-004: not affected): ${skipped.map((s) => `\`${s}\``).join(", ")}`);
  if (selection.reasons.length) {
    lines.push("", "| path | suites | why |", "| --- | --- | --- |");
    for (const r of selection.reasons.slice(0, 200)) lines.push(`| \`${r.path}\` | ${r.suites.join(", ") || "-"} | ${r.why} |`);
    if (selection.reasons.length > 200) lines.push(`| ... | | ${selection.reasons.length - 200} more |`);
  }
  return `${lines.join("\n")}\n\n`;
}

function main(argv) {
  const [cmd = "plan", ...rest] = argv;
  const opts = { base: undefined, head: undefined, files: [], suites: [], all: false, json: false, githubOutput: false, summary: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--base") opts.base = rest[++i];
    else if (a === "--head") opts.head = rest[++i];
    else if (a === "--all") opts.all = true;
    else if (a === "--suite") opts.suites.push(rest[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--github-output") opts.githubOutput = true;
    else if (a === "--summary") opts.summary = true;
    else if (a.startsWith("--")) throw new SelectionError(`unknown flag ${a}`);
    else opts.files.push(a);
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();

  if (cmd === "check") {
    const cfg = loadConfig(root);
    const { problems, observed } = check(root, cfg, trackedFiles(root));
    if (problems.length) {
      for (const p of problems) console.error(`select-tests check: ${p}`);
      return 1;
    }
    console.log(`select-tests check: ok (${Object.keys(cfg.suites).length} suites, ${cfg.owner.size} test files, ${observed} observed source files each select their readers)`);
    return 0;
  }
  if (cmd === "graph") {
    // Which suites read each file: the evidence the declared rules are written from.
    const cfg = loadConfig(root);
    const graph = buildGraph(root, [...cfg.owner.keys()], trackedFiles(root), cfg.opaque);
    const readers = new Map();
    for (const [test, deps] of graph) {
      for (const d of deps) {
        if (!readers.has(d)) readers.set(d, new Set());
        readers.get(d).add(cfg.owner.get(test));
      }
    }
    for (const [f, suites] of [...readers].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${[...suites].sort().join(",").padEnd(44)} ${f}`);
    return 0;
  }
  if (cmd !== "plan" && cmd !== "run") throw new SelectionError(`unknown command ${cmd}`);

  const result = plan(root, opts);
  const { selection, misses, cfg } = result;
  const files = testFilesFor(selection.suites, cfg, npmTestFiles(root));
  if (opts.summary && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(result));
  if (opts.githubOutput && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `suites=${selection.suites.join(",")}\nall=${selection.all ? "true" : "false"}\n`);
  }
  if (opts.json) {
    console.log(JSON.stringify({ all: selection.all, suites: selection.suites, files, misses, reasons: selection.reasons }, null, 2));
  } else {
    console.error(renderSummary(result).trimEnd());
  }
  if (misses.length > 0) {
    console.error(`select-tests: refusing -- ${misses.length} test(s) read a changed file but their suite was not selected. Add a rule to ${CONFIG_FILE}, or run with --all.`);
    return 3;
  }
  if (cmd === "plan") return 0;
  if (files.length === 0) {
    console.error("select-tests: no suite is affected; nothing to run.");
    return 0;
  }
  console.error(`select-tests: node ${NODE_TEST_FLAGS.join(" ")} <${files.length} file(s)>`);
  const res = spawnSync(process.execPath, [...NODE_TEST_FLAGS, ...files], { cwd: root, stdio: "inherit" });
  return res.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof SelectionError) {
      console.error(`select-tests: ${err.message}`);
      process.exitCode = err.code;
    } else {
      throw err;
    }
  }
}
