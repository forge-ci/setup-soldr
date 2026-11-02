#!/usr/bin/env node
// setup-soldr's local gate: prove locally what the remote quick gate would
// prove, then attest it so CI can skip the duplicate work.
//
// The design is forge-ci/ci.yml's, not a new one. Two trailers are written
// onto HEAD, in exactly the fleet's shapes (ci_lint/local_gate.py and
// ci_lint/attestations.py, documented in that repo's docs/ci-attestations.md):
//
//   Local-Gate: v1 tree=<40 hex> secs=<n> lanes=<lane:via[,...]>
//   Ci-Attestation: {"at":...,"gate":...,"host":...,"key":...,"lane":...,
//                    "parents":[...],"secs":...,"stamp":...,"tree":...,
//                    "v":1,"via":"run"}
//
// The stamp is sha256(tree \n comma-joined-parents \n canonical JSON without
// the stamp), truncated to 32 hex — byte-for-byte the fleet's algorithm, so
// `ci-lint attest verify` reads these records unchanged. It is tamper-evident,
// not a signature: a commit's own hash already covers its message, so the
// stamp binds the tree and the parents instead.
//
// Everything fails closed. A dirty tree, a lane that fails, an unreadable git
// state, a missing gate definition, a stale or mis-stamped record: the push is
// refused locally and the remote steps run as before.
//
// Commands:
//   run [--fast] [--all]    run the lanes from a clean tree and stamp HEAD;
//                           the tests lane runs only the suites
//                           ci/select-tests.mjs selects (TEST-004), or every
//                           suite with --all
//   check-push              the pre-push hook's entry point (reads git's stdin)
//   install-hook [--chain|--force]
//                           write .git/hooks/pre-push
//   verify [--commit <sha>] [--base <sha>] [--github-output] [--summary]
//                           CI side: does this commit's attestation match its
//                           tree, and which lanes may be skipped
//   lanes                   print the lane/gate table

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { plan as planTests } from "./select-tests.mjs";

const TRAILER_KEY = "Local-Gate";
const TRAILER_VERSION = "v1";
const ATTESTATION_TRAILER_KEY = "Ci-Attestation";
const ATTESTATION_VERSION = 1;
const STAMP_HEX = 32;
const DEFINITION_FILE = "ci-attestations.yml";
const DEFAULT_MAX_AGE_HOURS = 24;
// The fleet allows 60 s of clock skew before a timestamp counts as "in the
// future" (ci_lint.freshness).
const CLOCK_SKEW_SECONDS = 60;
const HOOK_MARKER = "# managed by setup-soldr ci/local_gate.mjs -- do not edit";
const CHAINED_HOOK = "pre-push.before-setup-soldr-gate";
const ZERO_SHA = "0".repeat(40);
const UPSTREAM = process.env.SETUP_SOLDR_GATE_BASE || "origin/main";

const LINTABLE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/;
const LINT_ROOTS = ["src/", "scripts/", "ci/", "__tests__/"];

// A change to any of these invalidates every lane's file selection: they
// decide what the lanes do, or what they compile against.
const MANDATORY_INPUTS = [
  ".oxlintrc.json",
  "ci-attestations.yml",
  "ci/local_gate.mjs",
  "ci/select-tests.mjs",
  "ci/test-selection.json",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];

// GATE-008's "surfaces": files whose change can only be validated remotely,
// because changing them changes what the gate itself does or what it claims.
// A PR that touches one of these is never trusted — every step runs as before.
const SURFACES = [
  ...MANDATORY_INPUTS,
  ".github/workflows/setup-soldr-contract.yml",
];

// Which node test suites a change needs is decided by ci/select-tests.mjs
// from the declared map in ci/test-selection.json (TEST-004).

class GateError extends Error {}

// ── git plumbing ────────────────────────────────────────────────────────────

function gitCapture(args, { cwd = process.cwd() } = {}) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) throw new GateError(`git ${args.join(" ")}: ${res.error.message}`);
  return res;
}

function git(args, opts) {
  const res = gitCapture(args, opts);
  if (res.status !== 0) {
    throw new GateError(`git ${args.join(" ")}: ${(res.stderr || res.stdout || "").trim()}`);
  }
  return res.stdout;
}

function gitOrNull(args, opts) {
  try {
    const res = gitCapture(args, opts);
    return res.status === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]).trim();
}

function treeOf(sha) {
  return git(["rev-parse", `${sha}^{tree}`]).trim();
}

function parentsOf(sha) {
  return git(["log", "-1", "--format=%P", sha]).trim().split(/\s+/).filter(Boolean);
}

function messageOf(sha) {
  return git(["log", "-1", "--format=%B", sha]);
}

function trackedChanges(root) {
  return git(["status", "--porcelain", "--untracked-files=no"], { cwd: root })
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

// ── the gate definition (restricted YAML) ───────────────────────────────────

/**
 * Parse the subset of YAML `ci-attestations.yml` is allowed to use: comments,
 * `key: value` block mappings two levels deep, and flow `{a: b}` of scalars.
 * Anything else throws, so a definition this reader cannot fully understand
 * can never authorize a skip.
 */
function parseDefinition(text, source = DEFINITION_FILE) {
  const gates = new Map();
  let version = null;
  let section = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(body);
      if (!match) throw new GateError(`${source}:${i + 1}: not a top-level 'key:' line: ${body}`);
      const [, key, value] = match;
      if (key === "version") {
        version = Number(value);
        section = null;
      } else if (key === "gates") {
        if (value !== "") throw new GateError(`${source}:${i + 1}: 'gates:' must start a block mapping`);
        section = "gates";
      } else {
        throw new GateError(`${source}:${i + 1}: unknown top-level key '${key}' (only version, gates)`);
      }
      continue;
    }
    if (section !== "gates") throw new GateError(`${source}:${i + 1}: indented line outside 'gates:'`);
    const match = /^([A-Za-z0-9][A-Za-z0-9/_.-]*):\s*\{\s*lane:\s*([A-Za-z0-9_-]+)\s*\}$/.exec(body);
    if (!match) throw new GateError(`${source}:${i + 1}: not '<gate path>: {lane: <lane>}': ${body}`);
    const [, gatePath, lane] = match;
    const why = validateGatePath(gatePath);
    if (why) throw new GateError(`${source}:${i + 1}: gate '${gatePath}': ${why}`);
    if (gates.has(gatePath)) throw new GateError(`${source}:${i + 1}: gate '${gatePath}' declared twice`);
    gates.set(gatePath, lane);
  }
  if (version !== ATTESTATION_VERSION) throw new GateError(`${source}: version is ${version}, expected ${ATTESTATION_VERSION}`);
  if (gates.size === 0) throw new GateError(`${source}: declares no gates`);
  return { version, gates, source };
}

const ECOSYSTEMS = ["rust", "python", "cpp", "general"];

function validateGatePath(gatePath) {
  const match = /^([a-z]+)\/([A-Za-z0-9_.-]+)\/([a-z0-9][a-z0-9-]*)$/.exec(gatePath);
  if (!match) return "not '<ecosystem>/<platform>/<check>'";
  if (!ECOSYSTEMS.includes(match[1])) return `ecosystem '${match[1]}' is not one of ${ECOSYSTEMS.join(", ")}`;
  return null;
}

/** The definition as committed at `rev`, or at the worktree when rev is null. */
function loadDefinition(root, rev = null) {
  if (rev === null) {
    const file = path.join(root, DEFINITION_FILE);
    if (!fs.existsSync(file)) throw new GateError(`${DEFINITION_FILE} is missing; the gate cannot prove anything`);
    return parseDefinition(fs.readFileSync(file, "utf8"));
  }
  const shown = gitOrNull(["show", `${rev}:${DEFINITION_FILE}`], { cwd: root });
  if (shown === null) throw new GateError(`${DEFINITION_FILE} is not readable at ${rev}`);
  return parseDefinition(shown, `${rev}:${DEFINITION_FILE}`);
}

// ── lanes ───────────────────────────────────────────────────────────────────

function hostLabel() {
  // Matches ci_lint.attestations.host_label() on Linux and macOS
  // (`platform.system().lower()`-`platform.machine().lower()`). On Windows,
  // Node reports `win32`/`x86_64` where Python reports `windows`/`amd64`; the
  // field is informational and is stamped as written, so verification is
  // unaffected.
  return `${process.platform}-${os.machine().toLowerCase()}`;
}

function toolFingerprint(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const dev = pkg.devDependencies ?? {};
  return JSON.stringify({
    node: process.version,
    oxlint: dev.oxlint ?? null,
    typescript: dev.typescript ?? null,
  });
}

/** The GATE-007-shaped lane key: what the lane ran against, plus its tools. */
function laneKey(lane, tree, inputs, tools) {
  const h = createHash("sha256");
  h.update(`${lane}\n${tree}\n${tools}\n${[...inputs].sort().join("\n")}`);
  return h.digest("hex").slice(0, 12);
}

const LANES = [
  {
    id: "lint",
    title: "oxlint",
    select(changed, { fullTree, root }) {
      if (fullTree) return { run: true, files: LINT_ROOTS.map((p) => p.replace(/\/$/, "")), why: "a mandatory input changed: linting every source dir" };
      // A deleted file is a changed path but not a lintable one.
      const files = changed.filter((f) => LINTABLE.test(f) && LINT_ROOTS.some((r) => f.startsWith(r))
        && fs.existsSync(path.join(root, f)));
      if (files.length === 0) {
        return { run: false, files: [], why: "no lintable file changed; oxlint rules are file-local, so unchanged files stay proven by the base" };
      }
      return { run: true, files, why: `${files.length} changed source file(s)` };
    },
    command(files, root) {
      // Prefer the installed binary over `npx`: one fewer process, and no
      // dependence on which `npx --no-install` spelling the local npm takes.
      const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "oxlint.cmd" : "oxlint");
      const bin = fs.existsSync(local) ? local : "npx";
      const prefix = bin === "npx" ? ["--no-install", "oxlint"] : [];
      return [bin, [...prefix, "--deny-warnings", ...files]];
    },
  },
  {
    id: "typecheck",
    title: "tsc --noEmit",
    select(changed, { fullTree }) {
      if (fullTree) return { run: true, files: [], why: "a mandatory input changed" };
      const touched = changed.filter((f) => /\.(?:ts|mts|cts|tsx)$/.test(f));
      if (touched.length === 0) return { run: false, files: [], why: "no TypeScript source changed" };
      // tsc has no useful per-file mode under `strict` + project references:
      // it needs the whole program. That is the fast path anyway (~4 s).
      return { run: true, files: [], why: `${touched.length} changed .ts file(s); tsc typechecks the whole project` };
    },
    command() {
      return ["npm", ["run", "--silent", "typecheck"]];
    },
  },
  {
    id: "tests",
    title: "node --test",
    skippedByFast: true,
    // TEST-004: the declared map in ci/test-selection.json picks the suites;
    // ci/select-tests.mjs fails closed on any path it cannot resolve and
    // refuses outright when the import graph says the map under-selected.
    select(changed, { fullTree, root, base, all }) {
      if (fullTree) return { run: true, files: ["suite:*"], suites: null, why: "a mandatory input changed: every suite" };
      if (all) return { run: true, files: ["suite:*"], suites: null, why: "--all: every suite" };
      let result;
      try {
        result = planTests(root, { base, head: "HEAD", files: [], all: false });
      } catch (err) {
        throw new GateError(`test selection failed: ${err.message}`);
      }
      if (result.misses.length > 0) {
        throw new GateError([
          "local gate: the test selector under-selected; the import graph needs suites the map did not pick:",
          ...result.misses.map((m) => `  ${m.path} is read by ${m.test} (suite ${m.suite})`),
          "Add a rule to ci/test-selection.json, or run the gate with --all.",
        ].join("\n"));
      }
      const { all: everything, suites } = result.selection;
      if (everything) return { run: true, files: ["suite:*"], suites: null, why: `every suite: ${everything}` };
      if (suites.length === 0) return { run: false, files: [], why: "no suite is affected (every changed path is ignored by ci/test-selection.json)" };
      return { run: true, files: suites.map((x) => `suite:${x}`), suites, why: `selected suites: ${suites.join(", ")}` };
    },
    command(files, _root, selection) {
      if (!selection?.suites) return ["npm", ["run", "--silent", "test"]];
      return [process.execPath, ["ci/select-tests.mjs", "run", ...(selection.base ? ["--base", selection.base] : [])]];
    },
  },
];

function laneById(id) {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new GateError(`unknown lane '${id}'`);
  return lane;
}

// ── the attestation record ──────────────────────────────────────────────────

function attestationBody({ gate, tree, parents, lane, key, via, secs, host, at }) {
  return { at, gate, host, key, lane, parents, secs, tree, v: ATTESTATION_VERSION, via };
}

/** JSON with sorted keys and no whitespace: Python's `sort_keys, separators`. */
function canonicalJson(body) {
  const sorted = {};
  for (const k of Object.keys(body).sort()) sorted[k] = body[k];
  return JSON.stringify(sorted);
}

function computeStamp(body) {
  const digest = createHash("sha256")
    .update(`${body.tree}\n${body.parents.join(",")}\n${canonicalJson(body)}`)
    .digest("hex");
  return digest.slice(0, STAMP_HEX);
}

function stamped(body) {
  return { ...body, stamp: computeStamp(body) };
}

function attestationTrailer(record) {
  return `${ATTESTATION_TRAILER_KEY}: ${canonicalJson(record)}`;
}

function parseAttestationTrailers(message) {
  const out = [];
  const re = new RegExp(`^${ATTESTATION_TRAILER_KEY}:\\s*(\\{.*\\})\\s*$`, "gm");
  for (const match of message.matchAll(re)) {
    let raw;
    try {
      raw = JSON.parse(match[1]);
    } catch (error) {
      out.push({ record: null, error: `malformed ${ATTESTATION_TRAILER_KEY} trailer: ${error.message}` });
      continue;
    }
    const strings = ["gate", "tree", "lane", "key", "via", "host", "stamp"];
    const typed = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      && raw.v === ATTESTATION_VERSION
      && strings.every((f) => typeof raw[f] === "string")
      && Array.isArray(raw.parents) && raw.parents.every((p) => typeof p === "string")
      && Number.isInteger(raw.at)
      && (raw.secs === null || Number.isInteger(raw.secs));
    if (!typed) {
      out.push({ record: null, error: `malformed ${ATTESTATION_TRAILER_KEY} trailer: missing or mistyped field` });
      continue;
    }
    out.push({ record: raw, error: null });
  }
  return out;
}

function parseLocalGateTrailer(message) {
  const matches = [...message.matchAll(new RegExp(`^${TRAILER_KEY}:\\s*(.+?)\\s*$`, "gm"))];
  if (matches.length === 0) return null;
  const tokens = matches[matches.length - 1][1].split(/\s+/);
  if (tokens[0] !== TRAILER_VERSION) return null;
  const fields = {};
  for (const token of tokens.slice(1)) {
    const at = token.indexOf("=");
    if (at > 0) fields[token.slice(0, at)] = token.slice(at + 1);
  }
  if (!/^[0-9a-f]{40}$/.test(fields.tree ?? "")) return null;
  return {
    tree: fields.tree,
    secs: /^\d+$/.test(fields.secs ?? "") ? Number(fields.secs) : null,
    lanes: fields.lanes || null,
  };
}

function stripAttestationTrailers(message) {
  return `${message.split("\n").filter((line) => !line.startsWith(`${ATTESTATION_TRAILER_KEY}:`)).join("\n")}\n`;
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * Per declared gate: `valid`, `missing` (omitted — not run locally, so CI runs
 * it), or why not. Integrity always; freshness only when `maxAgeHours` is set.
 */
function verifyCommit(root, sha, definition, { maxAgeHours = null, now = Date.now() / 1000 } = {}) {
  let message;
  let tree;
  let parents;
  try {
    message = messageOf(sha);
    tree = treeOf(sha);
    parents = parentsOf(sha);
  } catch (error) {
    return { sha, statuses: [], malformed: [`cannot read commit ${sha}: ${error.message}`], unreadable: true };
  }
  const parsed = parseAttestationTrailers(message);
  const statuses = [];
  const seen = new Map();
  for (const item of parsed) {
    if (!item.record) continue;
    const att = item.record;
    seen.set(att.gate, (seen.get(att.gate) ?? 0) + 1);
    const declaredLane = definition.gates.get(att.gate);
    const body = attestationBody(att);
    if (declaredLane === undefined) {
      statuses.push({ gate: att.gate, state: "undeclared", detail: `not a gate in ${definition.source}` });
    } else if (seen.get(att.gate) > 1) {
      statuses.push({ gate: att.gate, state: "duplicate", detail: "attested more than once" });
    } else if (computeStamp(body) !== att.stamp) {
      statuses.push({ gate: att.gate, state: "bad-stamp", detail: "stamp does not match the record" });
    } else if (att.tree !== tree) {
      statuses.push({ gate: att.gate, state: "wrong-tree", detail: `attests tree ${att.tree.slice(0, 12)}, commit has ${tree.slice(0, 12)}` });
    } else if (att.parents.length !== parents.length || att.parents.some((p, i) => p !== parents[i])) {
      statuses.push({ gate: att.gate, state: "wrong-parents", detail: "attested on other parents (rebased or cherry-picked)" });
    } else if (att.lane !== declaredLane) {
      statuses.push({ gate: att.gate, state: "lane-mismatch", detail: `proved by lane '${att.lane}', ${definition.source} says '${declaredLane}'` });
    } else if (maxAgeHours !== null && !(att.at <= now + CLOCK_SKEW_SECONDS && att.at >= now - maxAgeHours * 3600)) {
      statuses.push({ gate: att.gate, state: "stale", detail: `executed at ${new Date(att.at * 1000).toISOString()}, outside the ${maxAgeHours} h window` });
    } else {
      statuses.push({ gate: att.gate, state: "valid", detail: `${att.via} by lane ${att.lane} on ${att.host}`, lane: declaredLane, secs: att.secs });
    }
  }
  const attested = new Set(statuses.map((s) => s.gate));
  for (const [gate] of definition.gates) {
    if (!attested.has(gate)) statuses.push({ gate, state: "missing", detail: "omitted: not run locally" });
  }
  return { sha, tree, parents, statuses, malformed: parsed.filter((p) => p.error).map((p) => p.error), unreadable: false };
}

// ── run ─────────────────────────────────────────────────────────────────────

function mergeBase(root) {
  const out = gitOrNull(["merge-base", UPSTREAM, "HEAD"], { cwd: root });
  return out === null ? null : out.trim() || null;
}

function changedFiles(root) {
  const base = mergeBase(root);
  if (base === null) {
    return { base: null, files: git(["ls-files"], { cwd: root }).split("\n").filter(Boolean), whole: true };
  }
  // `D` is included on purpose: deleting a module changes nothing in the
  // remaining files' text but can break `tsc` and the suite, and a lane that
  // never ran must not be attested.
  const out = git(["diff", "--name-only", "--diff-filter=ACMRTD", `${base}..HEAD`], { cwd: root });
  return { base, files: out.split("\n").filter(Boolean), whole: false };
}

function runCommand(cmd, argv, root) {
  const res = spawnSync(cmd, argv, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (res.error) throw new GateError(`${cmd}: ${res.error.message}`);
  return res.status ?? 1;
}

function cmdRun(argv) {
  const fast = argv.includes("--fast");
  const runAll = argv.includes("--all");
  const root = repoRoot();
  const definition = loadDefinition(root);

  const dirty = trackedChanges(root);
  if (dirty.length > 0) {
    fail([
      "local gate: the tree has uncommitted tracked changes, so nothing can be attested.",
      ...dirty.map((line) => `  ${line}`),
      "Commit (or stash) them and run the gate again.",
    ]);
  }

  const head = git(["rev-parse", "HEAD"], { cwd: root }).trim();
  const tree = treeOf(head);
  const parents = parentsOf(head);
  const { base, files, whole } = changedFiles(root);
  const fullTree = whole || files.some((f) => MANDATORY_INPUTS.includes(f));
  const tools = toolFingerprint(root);

  console.log(`local gate: HEAD ${head.slice(0, 12)} tree ${tree.slice(0, 12)}`);
  console.log(base === null
    ? `local gate: no merge base with ${UPSTREAM}; treating the whole tree as changed (${files.length} files)`
    : `local gate: ${files.length} file(s) changed vs ${UPSTREAM} (${base.slice(0, 12)})${fullTree ? ", and a mandatory input moved" : ""}`);

  const laneToGates = new Map();
  for (const [gate, lane] of definition.gates) {
    if (!laneToGates.has(lane)) laneToGates.set(lane, []);
    laneToGates.get(lane).push(gate);
  }

  const started = Date.now();
  const results = [];
  for (const laneId of laneToGates.keys()) {
    const lane = laneById(laneId);
    if (fast && lane.skippedByFast) {
      console.log(`local gate: lane ${laneId} -- SKIPPED by --fast; its gate(s) will not be attested`);
      results.push({ lane: laneId, attest: false, secs: 0 });
      continue;
    }
    const selection = lane.select(files, { fullTree, root, base, all: runAll });
    selection.base = base;
    if (!selection.run) {
      console.log(`local gate: lane ${laneId} (${lane.title}) -- nothing to do: ${selection.why}`);
      results.push({ lane: laneId, attest: true, secs: 0, inputs: [], ran: false });
      continue;
    }
    const [cmd, args] = lane.command(selection.files, root, selection);
    console.log(`\nlocal gate: lane ${laneId} (${lane.title}) -- ${selection.why}`);
    console.log(`  $ ${cmd} ${args.join(" ")}`);
    const laneStart = Date.now();
    const status = runCommand(cmd, args, root);
    const secs = Math.round((Date.now() - laneStart) / 1000);
    if (status !== 0) {
      fail([
        `local gate: lane ${laneId} (${lane.title}) failed with exit ${status} after ${secs}s.`,
        "Nothing was attested; fix it and run the gate again.",
      ]);
    }
    console.log(`local gate: lane ${laneId} passed in ${secs}s`);
    results.push({ lane: laneId, attest: true, secs, inputs: selection.files, ran: true });
  }

  const totalSecs = Math.round((Date.now() - started) / 1000);
  const trailers = [];
  const records = [];
  for (const [lane, gates] of laneToGates) {
    const result = results.find((r) => r.lane === lane);
    if (!result?.attest) continue;
    for (const gate of gates) {
      const body = attestationBody({
        gate,
        tree,
        parents,
        lane,
        key: laneKey(lane, tree, result.inputs ?? [], tools),
        via: "run",
        secs: result.secs,
        host: hostLabel(),
        at: Math.floor(Date.now() / 1000),
      });
      const record = stamped(body);
      trailers.push(attestationTrailer(record));
      records.push(record);
    }
  }
  const lanesField = results
    .filter((r) => r.attest)
    .map((r) => `${r.lane}:${r.ran === false ? "noop" : "run"}`)
    .join(",");

  const newHead = stampHead(root, { tree, secs: totalSecs, lanes: lanesField }, trailers);
  writeAttestationFile(root, newHead, { tree, parents, secs: totalSecs, lanes: lanesField, records });

  const unattested = results.filter((r) => !r.attest).map((r) => r.lane);
  console.log(`\nlocal gate: passed in ${totalSecs}s [${lanesField || "none"}]`);
  console.log(`local gate: stamped ${newHead.slice(0, 12)} (${TRAILER_KEY} tree=${tree.slice(0, 12)}, ${records.length} ${ATTESTATION_TRAILER_KEY} record(s))`);
  if (unattested.length > 0) {
    console.log(`local gate: lane(s) ${unattested.join(", ")} were not run, so CI will run their steps.`);
  }
  return 0;
}

function stampHead(root, localGate, attestationTrailers) {
  const secs = localGate.secs === null ? "" : ` secs=${localGate.secs}`;
  const lanes = localGate.lanes ? ` lanes=${localGate.lanes}` : "";
  const trailer = `${TRAILER_KEY}: ${TRAILER_VERSION} tree=${localGate.tree}${secs}${lanes}`;
  const message = stripAttestationTrailers(messageOf("HEAD"));
  const args = ["interpret-trailers", "--if-exists", "replace", "--trailer", trailer];
  for (const extra of attestationTrailers) args.push("--if-exists", "add", "--trailer", extra);
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", input: message });
  if (res.status !== 0) throw new GateError(`git interpret-trailers: ${(res.stderr || "").trim()}`);
  // The tree is untouched, so commit hooks have nothing new to inspect.
  const amend = spawnSync("git", ["commit", "--amend", "--allow-empty", "--no-verify", "--quiet", "-F", "-"],
    { cwd: root, encoding: "utf8", input: res.stdout });
  if (amend.status !== 0) throw new GateError(`git commit --amend: ${(amend.stderr || "").trim()}`);
  return git(["rev-parse", "HEAD"], { cwd: root }).trim();
}

/**
 * The machine-readable copy of what was just stamped. It lives under the git
 * directory, never in the worktree: a tracked file would change the very tree
 * its records attest.
 */
function writeAttestationFile(root, sha, payload) {
  const dir = path.join(git(["rev-parse", "--absolute-git-dir"], { cwd: root }).trim(), "local-gate");
  fs.mkdirSync(dir, { recursive: true });
  const document = {
    v: ATTESTATION_VERSION,
    commit: sha,
    tree: payload.tree,
    parents: payload.parents,
    local_gate: { v: TRAILER_VERSION, tree: payload.tree, secs: payload.secs, lanes: payload.lanes },
    gates: payload.records,
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, `${sha}.json`), text);
  fs.writeFileSync(path.join(dir, "latest.json"), text);
  console.log(`local gate: wrote ${path.relative(root, path.join(dir, `${sha}.json`))}`);
}

// ── check-push (the pre-push hook) ──────────────────────────────────────────

function cmdCheckPush() {
  const root = repoRoot();
  // git feeds the hook `<local ref> <local sha> <remote ref> <remote sha>` on
  // stdin. Invoked by hand from a terminal there is nothing to read.
  const stdinText = process.stdin.isTTY ? "" : readAllStdin();
  const problems = [];
  let refs = 0;
  let definition;
  try {
    definition = loadDefinition(root);
  } catch (error) {
    fail([`local gate: ${error.message}`, "The gate definition must be readable before anything may be pushed."]);
    return 1;
  }
  for (const line of stdinText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef] = parts;
    if (localSha === ZERO_SHA || remoteRef.startsWith("refs/tags/")) continue;
    refs += 1;
    const result = verifyCommit(root, localSha, definition);
    const where = `${localRef} -> ${remoteRef}`;
    if (result.unreadable) {
      problems.push(`${where}: ${result.malformed.join("; ")}`);
      continue;
    }
    problems.push(...result.malformed.map((m) => `${where}: ${m}`));
    const bad = result.statuses.filter((s) => s.state !== "valid" && s.state !== "missing");
    for (const status of bad) problems.push(`${where}: gate ${status.gate}: ${status.state} -- ${status.detail}`);
    const localGate = parseLocalGateTrailer(messageOf(localSha));
    if (localGate === null) {
      problems.push(`${where}: no ${TRAILER_KEY} trailer on ${localSha.slice(0, 12)}`);
    } else if (localGate.tree !== result.tree) {
      problems.push(`${where}: ${TRAILER_KEY} names tree ${localGate.tree.slice(0, 12)} but the commit's tree is ${result.tree.slice(0, 12)} (content changed after the gate ran)`);
    }
  }
  if (problems.length > 0) {
    fail([
      "local gate: refusing to push.",
      ...problems.map((p) => `  ${p}`),
      "",
      "Run the gate from a clean, committed tree:",
      "  npm run gate         # lint + typecheck + tests, then stamps HEAD",
      "  npm run gate:fast    # skips the test lane; CI then runs it",
    ]);
  }
  console.log(refs === 0
    ? "local gate: nothing to check (tag or deletion only)."
    : `local gate: ${refs} outgoing head(s) attested for their own tree.`);
  return 0;
}

function readAllStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ── install-hook ────────────────────────────────────────────────────────────

function hookScript(chained) {
  const head = [
    "#!/bin/sh",
    HOOK_MARKER,
    "set -e",
    'root="$(git rev-parse --show-toplevel)"',
    'hooks_dir="$(git rev-parse --git-path hooks)"',
    "if ! command -v node >/dev/null 2>&1; then",
    '  echo "setup-soldr local gate: node is not on PATH, so this pre-push hook cannot verify the push." >&2',
    '  echo "  Install Node (the version in .github/workflows/setup-soldr-contract.yml) and push again," >&2',
    '  echo "  or re-run with --no-verify if you accept an unattested head (CI will then run every step)." >&2',
    "  exit 1",
    "fi",
  ];
  if (!chained) {
    return [...head, 'exec node "$root/ci/local_gate.mjs" check-push "$@"', ""].join("\n");
  }
  // Two hooks, one stdin. git writes the ref lines once, so a chained hook
  // that reads them leaves `check-push` with nothing and the gate would pass
  // vacuously. Spool them to a file and feed both from it. No `exec`, so the
  // trap still runs.
  return [
    ...head,
    'refs="$(mktemp)"',
    'trap \'rm -f "$refs"\' EXIT',
    'cat > "$refs"',
    `if [ -x "$hooks_dir/${CHAINED_HOOK}" ]; then`,
    `  "$hooks_dir/${CHAINED_HOOK}" "$@" < "$refs" || exit $?`,
    "fi",
    'node "$root/ci/local_gate.mjs" check-push "$@" < "$refs"',
    "",
  ].join("\n");
}

function cmdInstallHook(argv) {
  const force = argv.includes("--force");
  const chain = argv.includes("--chain");
  const root = repoRoot();
  // `--git-path hooks` is the path git actually consults: it honours
  // `core.hooksPath`, and in a linked worktree it resolves to the *shared*
  // hooks directory rather than the per-worktree git dir, where a hook would
  // sit inert.
  const hooksDir = path.resolve(root, git(["rev-parse", "--git-path", "hooks"], { cwd: root }).trim());
  const hook = path.join(hooksDir, "pre-push");
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : null;
  const ours = existing !== null && existing.split("\n").slice(0, 3).some((l) => l === HOOK_MARKER);

  if (existing !== null && !ours && !force && !chain) {
    fail([
      `local gate: ${hook} already exists and was not written by this gate.`,
      "Nothing was changed. Pick one:",
      "  node ci/local_gate.mjs install-hook --chain   # keep yours, run it first, then the gate",
      "  node ci/local_gate.mjs install-hook --force   # replace it (the old one is kept as a backup)",
      "  ... or call `node ci/local_gate.mjs check-push \"$@\"` from your own hook.",
    ]);
  }

  const chained = chain && existing !== null && !ours;
  const script = hookScript(chained || (ours && existing.includes(CHAINED_HOOK)));
  if (existing === script) {
    console.log(`local gate: ${hook} is already current`);
    return 0;
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  let note = "";
  if (existing !== null && !ours) {
    const backup = path.join(hooksDir, chained ? CHAINED_HOOK : "pre-push.setup-soldr-gate-backup");
    fs.writeFileSync(backup, existing);
    fs.chmodSync(backup, 0o755);
    note = chained ? `; kept your hook as ${path.basename(backup)} and chained it first` : `; saved the old hook as ${path.basename(backup)}`;
  }
  fs.writeFileSync(hook, script);
  fs.chmodSync(hook, 0o755);
  console.log(`local gate: ${ours ? "refreshed" : "wrote"} ${hook}${note}`);
  return 0;
}

// ── verify (the CI consumer) ────────────────────────────────────────────────

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

function cmdVerify(argv) {
  const root = repoRoot();
  const commit = argValue(argv, "--commit") ?? "HEAD";
  const baseRev = argValue(argv, "--base");
  const maxAge = Number(argValue(argv, "--max-age-hours") ?? DEFAULT_MAX_AGE_HOURS);
  const wantOutput = argv.includes("--github-output");
  const wantSummary = argv.includes("--summary");
  const requireFresh = !argv.includes("--no-freshness");

  const notes = [];
  const skip = new Map(LANES.map((l) => [l.id, false]));
  let trusted = true;
  let state = "attested";

  // The definition is read from the base, never from the head: a PR may not
  // widen what it is allowed to skip.
  let definition = null;
  try {
    definition = loadDefinition(root, baseRev ?? null);
  } catch (error) {
    trusted = false;
    state = "no-definition";
    notes.push(`fail-closed: ${error.message}`);
  }

  let sha = null;
  if (trusted) {
    try {
      sha = git(["rev-parse", commit], { cwd: root }).trim();
    } catch (error) {
      trusted = false;
      state = "unreadable-head";
      notes.push(`fail-closed: ${error.message}`);
    }
  }

  if (trusted && baseRev !== null) {
    let changed;
    try {
      changed = git(["diff", "--name-only", "--diff-filter=ACMRTD", baseRev, sha], { cwd: root })
        .split("\n").filter(Boolean);
    } catch (error) {
      trusted = false;
      state = "unreadable-diff";
      notes.push(`fail-closed: cannot diff ${baseRev.slice(0, 12)}..${sha.slice(0, 12)}: ${error.message}`);
      changed = [];
    }
    const touched = changed.filter((f) => SURFACES.includes(f));
    if (touched.length > 0) {
      trusted = false;
      state = "surface-changed";
      notes.push(`fail-closed: this change touches gate surface(s) ${touched.join(", ")}; only a remote run can validate them`);
    }
  }

  let result = null;
  if (trusted) {
    result = verifyCommit(root, sha, definition, { maxAgeHours: requireFresh ? maxAge : null });
    if (result.unreadable) {
      trusted = false;
      state = "unreadable-head";
      notes.push(...result.malformed.map((m) => `fail-closed: ${m}`));
    } else if (result.malformed.length > 0) {
      trusted = false;
      state = "malformed";
      notes.push(...result.malformed.map((m) => `fail-closed: ${m}`));
    } else {
      const localGate = parseLocalGateTrailer(messageOf(sha));
      if (localGate === null || localGate.tree !== result.tree) {
        trusted = false;
        state = localGate === null ? "no-local-gate-trailer" : "stale-local-gate-trailer";
        notes.push(`fail-closed: ${localGate === null ? `no ${TRAILER_KEY} trailer on ${sha.slice(0, 12)}` : `${TRAILER_KEY} names tree ${localGate.tree.slice(0, 12)}, commit has ${result.tree.slice(0, 12)}`}`);
      }
    }
  }

  if (trusted && result) {
    for (const status of result.statuses) {
      if (status.state === "valid") {
        skip.set(status.lane, true);
        notes.push(`${status.gate}: valid (${status.detail}${status.secs === null ? "" : `, ${status.secs}s`}) -> skip the \`${status.lane}\` step`);
      } else {
        notes.push(`${status.gate}: ${status.state} -- ${status.detail}`);
        if (status.state !== "missing") {
          // Anything other than a plain omission means the evidence is wrong,
          // not absent: distrust the whole head.
          trusted = false;
          state = status.state;
        }
      }
    }
    if (!trusted) for (const key of skip.keys()) skip.set(key, false);
  }

  const header = trusted
    ? `local gate: ${commit} (${sha.slice(0, 12)}) attested; skipping ${[...skip].filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}`
    : `local gate: not trusted (${state}); every step runs as before`;
  console.log(header);
  for (const note of notes) console.log(`  ${note}`);

  if (wantOutput && process.env.GITHUB_OUTPUT) {
    const lines = [`attested=${trusted}`, `state=${state}`];
    for (const [lane, value] of skip) lines.push(`skip_${lane}=${value}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
  if (wantSummary && process.env.GITHUB_STEP_SUMMARY) {
    const rows = [...skip].map(([lane, value]) => `| \`${lane}\` | ${value ? "skipped (proven locally)" : "runs"} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "### Local gate attestation",
      "",
      header.replace(/^local gate: /, ""),
      "",
      "| lane | this run |",
      "| --- | --- |",
      ...rows,
      "",
      "<details><summary>evidence</summary>",
      "",
      ...notes.map((n) => `- ${n}`),
      "",
      `Definition: \`${DEFINITION_FILE}\`${baseRev ? ` as committed at \`${baseRev.slice(0, 12)}\`` : ""}. Omission means the lane was not run locally, so CI runs it.`,
      "</details>",
      "",
    ].join("\n"));
  }
  // Verification itself never fails the build: it decides what to skip, and
  // "nothing" is always a valid answer.
  return 0;
}

function cmdLanes() {
  const root = repoRoot();
  const definition = loadDefinition(root);
  console.log(`${DEFINITION_FILE} (version ${definition.version})`);
  for (const [gate, lane] of definition.gates) {
    const impl = LANES.find((l) => l.id === lane);
    console.log(`  ${gate.padEnd(28)} lane=${lane.padEnd(10)} ${impl ? impl.title : "!! no such lane in ci/local_gate.mjs"}${impl?.skippedByFast ? " (skipped by --fast)" : ""}`);
  }
  for (const [, lane] of definition.gates) {
    if (!LANES.some((l) => l.id === lane)) {
      fail([`${DEFINITION_FILE} names lane '${lane}', which ci/local_gate.mjs does not implement`]);
    }
  }
  return 0;
}

// ── entry point ─────────────────────────────────────────────────────────────

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function main(argv) {
  // The command is the first positional argument. `--check` is accepted as a
  // flag spelling of `verify` so a workflow can read as `--check`.
  const positional = argv.length > 0 && !argv[0].startsWith("-") ? argv[0] : null;
  const rest = positional === null ? argv : argv.slice(1);
  const command = positional ?? (argv.includes("--check") ? "verify" : "run");
  switch (command) {
    case "run": return cmdRun(rest);
    case "check-push": return cmdCheckPush(rest);
    case "install-hook": return cmdInstallHook(rest);
    case "verify": case "check": return cmdVerify(rest);
    case "lanes": return cmdLanes(rest);
    default:
      fail([
        `local gate: unknown command '${command}'`,
        "usage: node ci/local_gate.mjs [run [--fast] [--all] | check-push | install-hook [--chain|--force] | verify|--check [...] | lanes]",
      ]);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof GateError) fail([`local gate: ${error.message}`]);
  throw error;
}
