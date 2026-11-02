// TEST-004 selector self-test (forge-ci/ci.yml#518): every explicit rule,
// the fail-closed cases, and the under-selection guard against a stale map.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

type Sel = typeof import("../ci/select-tests.mjs", { with: { "resolution-mode": "import" } });

const root = process.cwd();
let sel: Sel;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cfg: any;
let tracked: string[];
let graph: Map<string, Set<string>>;
let ALL: string[];

// The suite is CommonJS-typed; the selector is plain ESM, so load it dynamically.
before(async () => {
  sel = (await import("../ci/select-tests.mjs")) as Sel;
  cfg = sel.loadConfig(root);
  tracked = sel.trackedFiles(root);
  graph = sel.buildGraph(root, [...cfg.owner.keys()], tracked, cfg.opaque);
  ALL = Object.keys(cfg.suites).sort();
});

function pick(paths: string[], config = cfg): { all: string | null; suites: string[] } {
  const changes = paths.map((p) => {
    const m = /^([AMD]):(.+)$/.exec(p);
    return m ? { status: m[1] ?? "M", path: m[2] ?? p } : { status: "M", path: p };
  });
  const r = sel.select(changes, config, graph);
  return { all: r.all, suites: [...r.suites].sort() };
}

test("globs: ** crosses directories, * does not", () => {
  assert.ok(sel.matches("src/**", "src/lib/a.ts"));
  assert.ok(sel.matches("docs/**", "docs/a/b.md"));
  assert.ok(sel.matches("**/*.png", "x.png"));
  assert.ok(sel.matches("src/lib/cache-*.ts", "src/lib/cache-keys.ts"));
  assert.ok(!sel.matches("src/lib/cache-*.ts", "src/lib/sub/cache-keys.ts"));
  assert.ok(!sel.matches("*.md", "docs/a.md"));
  assert.ok(!sel.matches("ci/**", "cix/a"));
});

test("each explicit rule selects its declared suites", () => {
  const cases: Array<[string, string[]]> = [
    ["src/main.ts", ["action", "contract"]],
    ["src/lib/cache-keys.ts", ["action", "cache", "contract", "cook", "toolchain"]],
    ["src/lib/s3-cache.ts", ["action", "cache", "contract"]],
    ["src/lib/ensure-soldr.ts", ["action", "cache", "contract", "toolchain"]],
    ["src/lib/resolve-setup.ts", ["action", "contract", "toolchain"]],
    ["src/lib/cook-rustc.ts", ["action", "contract", "cook"]],
    ["cook/action.yml", ["contract"]],
    [".github/workflows/rust-ci.yml", ["contract"]],
    ["README.md", ["cache"]],
    ["scripts/bench-paths.mjs", ["tooling"]],
  ];
  for (const [file, want] of cases) {
    const got = pick([file]);
    assert.equal(got.all, null, `${file} should not select everything`);
    assert.deepEqual(got.suites, want, file);
  }
  // Every rule is exercised by at least one tracked file (else `check` fails).
  for (const rule of cfg.rules) {
    assert.ok(rule.paths.some((g: string) => tracked.some((t) => sel.matches(g, t))), rule.why);
  }
});

test("ignored paths select nothing", () => {
  assert.deepEqual(pick(["docs/design.md", "CHANGELOG.md", "tests/test_x.py"]), { all: null, suites: [] });
});

test("a path no rule matches selects every suite (fail closed)", () => {
  for (const p of ["brand-new/thing.txt", "scripts/some-new-script.mjs", "_vender/soldr", ".github/workflows/release-lane.yml"]) {
    const got = pick([p]);
    assert.ok(got.all, p);
    assert.deepEqual(got.suites, ALL, p);
  }
});

test("config files and the selector itself select every suite", () => {
  for (const p of ["package.json", "package-lock.json", "tsconfig.json", ".oxlintrc.json", "ci/select-tests.mjs", "ci/test-selection.json", "ci/local_gate.mjs", "action.yml", "__tests__/register-loader.mjs"]) {
    const got = pick(["docs/x.md", p]);
    assert.ok(got.all, p);
    assert.deepEqual(got.suites, ALL, p);
  }
});

test("test files: modified selects its suite and importers; added/renamed/deleted or unknown selects all", () => {
  assert.deepEqual(pick(["__tests__/cache-keys.test.ts"]).suites, ["cache"]);
  // yank-audit.test.ts is in `contract`, and main.test.ts (action) imports it too.
  assert.deepEqual(pick(["__tests__/yank-audit.test.ts"]).suites, ["action", "contract"]);
  assert.ok(pick(["A:__tests__/new-thing.test.ts"]).all);
  assert.ok(pick(["D:__tests__/cache-keys.test.ts"]).all);
  assert.ok(pick(["__tests__/not-in-any-suite.test.ts"]).all);
  const renamed = sel.select([{ status: "R", from: "__tests__/cache-keys.test.ts", path: "__tests__/keys.test.ts" }], cfg, graph);
  assert.ok(renamed.all);
});

test("suites partition exactly what npm test runs", () => {
  const npm: string[] = sel.npmTestFiles(root);
  assert.deepEqual([...cfg.owner.keys()].sort(), [...npm].sort());
});

test("the committed map passes the hidden-change self-test", () => {
  const { problems } = sel.check(root, cfg, tracked);
  assert.deepEqual(problems, []);
});

test("a stale map (cache rule dropped) is caught by the guard and by check", () => {
  const stale = structuredClone({ ...cfg, owner: undefined });
  stale.owner = cfg.owner;
  stale.rules = cfg.rules.filter((r: { suites: string[] }) => !(r.suites.length === 1 && r.suites[0] === "cache"));
  const changes = [{ status: "M", path: "src/lib/s3-cache.ts" }];
  const selection = sel.select(changes, stale, graph);
  assert.ok(!selection.suites.includes("cache"), "precondition: the stale map under-selects");
  const misses = sel.guard(changes, selection, stale, graph);
  assert.ok(misses.some((m) => m.test === "__tests__/s3-cache.test.ts"));
  assert.ok(sel.check(root, stale, tracked).problems.some((p) => p.includes("src/lib/s3-cache.ts")));
});

test("CLI plan: explicit files, JSON output", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["ci/select-tests.mjs", "plan", "--json", ...args], { cwd: root, encoding: "utf8" });
  const docs = run(["docs/x.md"]);
  assert.equal(docs.status, 0, docs.stderr);
  assert.deepEqual(JSON.parse(docs.stdout).suites, []);
  const pkg = run(["package.json"]);
  assert.equal(pkg.status, 0, pkg.stderr);
  assert.deepEqual(JSON.parse(pkg.stdout).suites.sort(), ALL);
  const cache = JSON.parse(run(["src/lib/s3-cache.ts"]).stdout);
  assert.deepEqual(cache.suites.sort(), ["action", "cache", "contract"]);
  assert.ok(cache.files.includes("__tests__/s3-cache.test.ts"));
  assert.ok(!cache.files.includes("__tests__/toolchain.test.ts"));
});
