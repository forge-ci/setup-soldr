// forge-ci/setup-soldr#713 items 2-4: a `scope` input (default SOLDR_SCOPE)
// that gives each scope its own persistent root, a provided toolchain found
// through SOLDR_TOOLCHAIN_LOWER, and no directory creation on read-only paths.
// Env names match forge-ci/soldr#4308.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROVIDED_TOOLCHAIN_STAMP,
  SCOPE_ENV,
  TOOLCHAIN_LOWER_ENV,
  findProvidedToolchain,
  isReadOnlyPath,
  provisionProvidedToolchain,
  readOnlyPaths,
  resolveScope,
  scopeRoot,
} from "../src/lib/scope-lower.js";
import { persistentLayout, preparePersistentRoot } from "../src/lib/persistent-root.js";
import { readRawInputs, resolveSetup } from "../src/lib/resolve-setup.js";
import { createLogger } from "../src/lib/log-utils.js";
import type { ActionContext, ResolveResult } from "../src/lib/types.js";

// CommonJS views are mutable, so the network trap reaches every caller.
const require = createRequire(path.join(process.cwd(), "noop.js"));
const http = require("node:http") as typeof import("node:http");
const https = require("node:https") as typeof import("node:https");
const net = require("node:net") as typeof import("node:net");

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeLower(root: string, name = "1.80.0-x86_64-unknown-linux-gnu"): string {
  const lower = path.join(root, "lower");
  const tc = path.join(lower, "toolchains", name);
  fs.mkdirSync(path.join(tc, "bin"), { recursive: true });
  fs.writeFileSync(path.join(tc, "bin", "rustc"), "#!/bin/sh\necho rustc 1.80.0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tc, PROVIDED_TOOLCHAIN_STAMP), "{}\n");
  return lower;
}

/** Every regular file and directory a root holds, as absolute real paths. */
function writablePaths(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    out.add(fs.realpathSync(dir));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.add(fs.realpathSync(p));
    }
  };
  walk(root);
  return out;
}

function ctxFor(root: string, env: Record<string, string>): ActionContext {
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(path.join(workspace, "Cargo.lock"), "# lock\n");
  const full: Record<string, string | undefined> = {
    ACTION_WORKSPACE: workspace,
    ACTION_OS: "Linux",
    ACTION_ARCH: "X64",
    RUNNER_TEMP: runnerTemp,
    GITHUB_SHA: "0123456789abcdef",
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    CARGO_HOME: path.join(root, "cargo-home"),
    INPUT_VERSION: "0.7.11",
    INPUT_TIMESTAMPS: "false",
    INPUT_TOOLCHAIN_FILE: "",
    INPUT_TOOLCHAIN: "1.80.0",
    ...env,
  };
  return {
    env: full,
    workspace,
    runnerTemp,
    runnerOs: "Linux",
    runnerArch: "X64",
    githubSha: "0123456789abcdef",
    githubToken: "",
    parentSha: "",
    logger: createLogger(full),
  };
}

async function resolveWith(root: string, env: Record<string, string>): Promise<ResolveResult> {
  const ctx = ctxFor(root, env);
  return resolveSetup(ctx, readRawInputs(ctx.env), {
    fetchReleaseTag: async () => "v0.7.11",
    systemRustupOverride: async () => false,
  });
}

// ---- item 2: scope ----

test("resolveScope prefers the input, falls back to SOLDR_SCOPE, and sanitizes", () => {
  assert.equal(resolveScope("", {}), "");
  assert.equal(resolveScope("", { [SCOPE_ENV]: "  tenant-a " }), "tenant-a");
  assert.equal(resolveScope("job/b:1", { [SCOPE_ENV]: "ignored" }), "job_b_1");
  assert.equal(resolveScope("..", {}), "", "a dot-only scope cannot escape the root");
  assert.equal(scopeRoot("/r", ""), "/r");
  assert.equal(scopeRoot("/r", "a"), path.join("/r", "scopes", "a"));
});

test("raw inputs read the scope input", () => {
  assert.equal(readRawInputs({ INPUT_SCOPE: "s1" }).scope, "s1");
});

test("two scopes on one runner get disjoint persistent roots with no shared writable path", async () => {
  const base = mkTmp("setup-soldr-scope-");
  const store = path.join(base, "root");
  const env = { RUNNER_ENVIRONMENT: "self-hosted", RUNNER_NAME: "r1", GITHUB_RUN_ID: "1", GITHUB_JOB: "j" };
  const roots: string[] = [];
  for (const scope of ["alpha", "beta"]) {
    const prepared = preparePersistentRoot({
      input: store, scope, env, dryRun: false, log: () => {}, warn: (m) => assert.fail(m),
    });
    assert.equal(prepared.root, path.join(store, "scopes", scope));
    const layout = persistentLayout(prepared.root!);
    for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
    roots.push(prepared.root!);
  }
  const a = writablePaths(roots[0]!);
  const b = writablePaths(roots[1]!);
  for (const p of a) assert.ok(!b.has(p), `shared writable path ${p}`);
  assert.ok(!roots[0]!.startsWith(roots[1]!) && !roots[1]!.startsWith(roots[0]!));
});

test("no scope leaves the persistent root unchanged", () => {
  const base = mkTmp("setup-soldr-scope-");
  const prepared = preparePersistentRoot({
    input: base, env: { RUNNER_ENVIRONMENT: "self-hosted" }, dryRun: true, log: () => {}, warn: () => {},
  });
  assert.equal(prepared.root, base);
});

test("resolveSetup exports the scope to soldr and scopes the default cache root", async () => {
  const root = mkTmp("setup-soldr-scope-");
  const scoped = await resolveWith(root, { [SCOPE_ENV]: "alpha", RUSTUP_HOME: path.join(root, "rh") });
  assert.equal(scoped.envExports[SCOPE_ENV], "alpha");
  assert.ok(scoped.cacheRoot.includes(path.join("scopes", "alpha")), scoped.cacheRoot);
  const plain = await resolveWith(mkTmp("setup-soldr-scope-"), { RUSTUP_HOME: path.join(root, "rh2") });
  assert.equal(plain.envExports[SCOPE_ENV], undefined);
  assert.ok(!plain.cacheRoot.includes("scopes"), plain.cacheRoot);
  assert.equal(plain.providedToolchain, undefined);
});

// ---- item 3: provided toolchain ----

test("findProvidedToolchain needs the stamp and a matching channel", () => {
  const root = mkTmp("setup-soldr-lower-");
  const lower = makeLower(root);
  assert.equal(findProvidedToolchain(lower, "1.80.0")?.name, "1.80.0-x86_64-unknown-linux-gnu");
  assert.equal(findProvidedToolchain(lower, "1.80"), null, "1.80 must not match 1.80.0");
  assert.equal(findProvidedToolchain(lower, "stable"), null);
  fs.rmSync(path.join(lower, "toolchains", "1.80.0-x86_64-unknown-linux-gnu", PROVIDED_TOOLCHAIN_STAMP));
  assert.equal(findProvidedToolchain(lower, "1.80.0"), null, "unstamped toolchains are not provided");
  assert.equal(findProvidedToolchain(path.join(root, "missing"), "1.80.0"), null);
});

test("a provided toolchain makes no network request and points RUSTUP_HOME at a writable overlay", async () => {
  const root = mkTmp("setup-soldr-lower-");
  const lower = makeLower(root);
  fs.chmodSync(path.join(lower, "toolchains"), 0o555);
  fs.chmodSync(lower, 0o555);

  const blocked = (): never => { throw new Error("network blocked in test"); };
  const saved = {
    fetch: globalThis.fetch, httpReq: http.request, httpGet: http.get, httpsReq: https.request, httpsGet: https.get, connect: net.connect,
  };
  let attempts = 0;
  const trap = (): never => { attempts += 1; return blocked(); };
  globalThis.fetch = trap as unknown as typeof fetch;
  (http as { request: unknown }).request = trap;
  (http as { get: unknown }).get = trap;
  (https as { request: unknown }).request = trap;
  (https as { get: unknown }).get = trap;
  (net as { connect: unknown }).connect = trap;
  let result: ResolveResult;
  const pathBefore = process.env["PATH"];
  try {
    result = await resolveWith(root, { [TOOLCHAIN_LOWER_ENV]: lower });
    const provided = provisionProvidedToolchain(result, { log: () => {}, addPath: (p) => { process.env["PATH"] = `${p}${path.delimiter}${process.env["PATH"]}`; }, exportVariable: () => {} });
    assert.equal(provided, true);
  } finally {
    globalThis.fetch = saved.fetch;
    (http as { request: unknown }).request = saved.httpReq;
    (http as { get: unknown }).get = saved.httpGet;
    (https as { request: unknown }).request = saved.httpsReq;
    (https as { get: unknown }).get = saved.httpsGet;
    (net as { connect: unknown }).connect = saved.connect;
    process.env["PATH"] = pathBefore;
    fs.chmodSync(lower, 0o755);
    fs.chmodSync(path.join(lower, "toolchains"), 0o755);
  }
  assert.equal(attempts, 0);
  assert.ok(result.providedToolchain);
  assert.equal(result.rustupStrategy, "explicit", "solo-toolchain-cache stays off for a provided toolchain");
  assert.ok(!isReadOnlyPath(result.rustupHome, [lower]), "RUSTUP_HOME is writable, not the lower");
  assert.equal(result.envExports["RUSTUP_HOME"], result.rustupHome);
  const linked = path.join(result.rustupHome, "toolchains", "1.80.0-x86_64-unknown-linux-gnu");
  assert.ok(!path.isAbsolute(fs.readlinkSync(linked)), "overlay link is relative");
  assert.equal(fs.realpathSync(path.join(linked, "bin", "rustc")), fs.realpathSync(path.join(lower, "toolchains", "1.80.0-x86_64-unknown-linux-gnu", "bin", "rustc")));
  fs.accessSync(result.rustupHome, fs.constants.W_OK);
});

test("a lower without the requested channel falls back to the normal install", async () => {
  const root = mkTmp("setup-soldr-lower-");
  const lower = makeLower(root, "1.79.0-x86_64-unknown-linux-gnu");
  const result = await resolveWith(root, { [TOOLCHAIN_LOWER_ENV]: lower });
  assert.equal(result.providedToolchain, undefined);
  assert.equal(result.rustupStrategy, "managed");
  assert.equal(provisionProvidedToolchain(result, { log: () => {}, addPath: () => assert.fail(), exportVariable: () => assert.fail() }), false);
});

// ---- item 4: read-only paths ----

test("paths under the lower and SETUP_SOLDR_READONLY_PATHS are read-only", () => {
  const ro = readOnlyPaths({ [TOOLCHAIN_LOWER_ENV]: "/lower", SETUP_SOLDR_READONLY_PATHS: ["/ro1", "", "/ro2"].join(path.delimiter) });
  assert.deepEqual(ro, [path.resolve("/lower"), path.resolve("/ro1"), path.resolve("/ro2")]);
  assert.ok(isReadOnlyPath("/lower/toolchains/x", ro));
  assert.ok(isReadOnlyPath("/ro2", ro));
  assert.ok(!isReadOnlyPath("/lowerx", ro));
  assert.deepEqual(readOnlyPaths({}), []);
});

test("resolveSetup does not create directories on a read-only path", async () => {
  const root = mkTmp("setup-soldr-ro-");
  const roCargo = path.join(root, "ro-cargo");
  const result = await resolveWith(root, {
    CARGO_HOME: roCargo,
    RUSTUP_HOME: path.join(root, "rh"),
    SETUP_SOLDR_READONLY_PATHS: roCargo,
  });
  assert.equal(result.cargoHome, roCargo);
  assert.ok(!fs.existsSync(roCargo), "read-only CARGO_HOME was created");
  assert.ok(fs.existsSync(result.rustupHome));
});
