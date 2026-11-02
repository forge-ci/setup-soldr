// ci/local_gate.mjs: the pre-push gate and the attestation CI verifies.
//
// Every case here runs the real script against a throwaway git repository
// whose lanes are stubs, so the test exercises the gate's logic (selection,
// stamping, tree binding, fail-closed verification) rather than oxlint or
// tsc. The stamp algorithm's byte-for-byte agreement with the fleet's
// `ci_lint.attestations` lives in docs/local-gate.md; what matters here is
// that nothing but genuine, matching evidence authorizes a skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATE = path.resolve("ci", "local_gate.mjs");
const DEFINITION = path.resolve("ci-attestations.yml");
const GATES = ["general/all/lint", "general/all/typecheck", "general/linux-x86_64/test"];
const posixOnly = { skip: process.platform === "win32" ? "POSIX shell stubs" : false };

interface Repo {
  root: string;
  // Every git and gate invocation runs with the same hermetic environment: no
  // global or system config, and an explicit identity. A runner has neither,
  // so without this a case that commits passes locally and fails in CI.
  env: NodeJS.ProcessEnv;
  git: (...args: string[]) => string;
  gitRaw: (args: string[], input?: string) => { status: number; out: string };
  gate: (args: string[], extraEnv?: Record<string, string>) => { status: number; out: string };
  verify: (args: string[]) => { status: number; out: string; outputs: Record<string, string> };
}

function makeRepo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Gate Test",
    GIT_AUTHOR_EMAIL: "gate@example.invalid",
    GIT_COMMITTER_NAME: "Gate Test",
    GIT_COMMITTER_EMAIL: "gate@example.invalid",
  };
  const gitRaw = (args: string[], input?: string) => {
    const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8", input });
    return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  };
  const git = (...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const gate = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [path.join(root, "ci", "local_gate.mjs"), ...args],
      { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
    return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  };
  const verify = (args: string[]) => {
    const outputFile = path.join(root, `output-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(outputFile, "");
    const result = gate(["verify", "--github-output", ...args], { GITHUB_OUTPUT: outputFile });
    const outputs: Record<string, string> = {};
    for (const line of fs.readFileSync(outputFile, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
    }
    return { ...result, outputs };
  };

  fs.mkdirSync(path.join(root, "ci"));
  fs.mkdirSync(path.join(root, "src"));
  fs.copyFileSync(GATE, path.join(root, "ci", "local_gate.mjs"));
  fs.copyFileSync(DEFINITION, path.join(root, "ci-attestations.yml"));
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "gate-fixture",
    private: true,
    // The lane commands are the real ones; only what they shell out to is a
    // stub, so lane selection and ordering are exercised for real.
    scripts: { typecheck: 'node -e ""', test: 'node -e ""' },
    devDependencies: { oxlint: "0.0.0-fixture", typescript: "0.0.0-fixture" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, ".oxlintrc.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = 1;\n");
  const bin = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  // `npx --no-install oxlint` resolves this.
  fs.writeFileSync(path.join(bin, "oxlint"), '#!/bin/sh\nexit "${GATE_FIXTURE_OXLINT_EXIT:-0}"\n');
  fs.chmodSync(path.join(bin, "oxlint"), 0o755);

  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "base");
  // Stand in for the fetched default branch the gate diffs against.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, env, git, gitRaw, gate, verify };
}

function commitChange(repo: Repo, file = path.join("src", "a.ts"), body = "export const a = 1;\n"): void {
  fs.mkdirSync(path.dirname(path.join(repo.root, file)), { recursive: true });
  fs.writeFileSync(path.join(repo.root, file), body);
  repo.git("add", "-A");
  repo.git("commit", "-q", "--no-verify", "-m", `change ${file}`);
}

function trailers(repo: Repo, key: string): string[] {
  return repo.git("log", "-1", "--format=%B", "HEAD")
    .split("\n")
    .filter((line) => line.startsWith(`${key}:`));
}

test("run attests every gate from a clean tree and verify trusts it", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  const run = repo.gate(["run"]);
  assert.equal(run.status, 0, run.out);

  const local = trailers(repo, "Local-Gate");
  assert.equal(local.length, 1, run.out);
  const tree = repo.git("rev-parse", "HEAD^{tree}").trim();
  assert.match(local[0]!, new RegExp(`^Local-Gate: v1 tree=${tree} secs=\\d+ lanes=\\S+$`));
  assert.match(local[0]!, /lanes=(?=.*lint:)(?=.*typecheck:)(?=.*tests:)/);

  const attestations = trailers(repo, "Ci-Attestation");
  assert.equal(attestations.length, GATES.length, run.out);
  const seen = attestations.map((line) => JSON.parse(line.slice("Ci-Attestation: ".length)));
  assert.deepEqual(seen.map((a) => a.gate).sort(), [...GATES].sort());
  for (const record of seen) {
    assert.equal(record.v, 1);
    assert.equal(record.tree, tree);
    assert.equal(record.via, "run");
    assert.equal(record.stamp.length, 32);
  }

  // The sidecar JSON must live under the git dir, never in the tree it attests.
  const head = repo.git("rev-parse", "HEAD").trim();
  const sidecar = JSON.parse(fs.readFileSync(path.join(repo.root, ".git", "local-gate", `${head}.json`), "utf8"));
  assert.equal(sidecar.tree, tree);
  assert.equal(sidecar.gates.length, GATES.length);
  assert.equal(repo.git("status", "--porcelain").trim(), "");

  const verified = repo.verify([]);
  assert.equal(verified.outputs["attested"], "true", verified.out);
  assert.equal(verified.outputs["skip_lint"], "true");
  assert.equal(verified.outputs["skip_typecheck"], "true");
  assert.equal(verified.outputs["skip_tests"], "true");
});

test("--fast leaves the test gate unattested, so CI still runs it", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  const run = repo.gate(["run", "--fast"]);
  assert.equal(run.status, 0, run.out);
  assert.equal(trailers(repo, "Ci-Attestation").length, GATES.length - 1);

  const verified = repo.verify([]);
  assert.equal(verified.outputs["attested"], "true", verified.out);
  assert.equal(verified.outputs["skip_lint"], "true");
  assert.equal(verified.outputs["skip_tests"], "false");
  assert.match(verified.out, /general\/linux-x86_64\/test: missing/);
});

test("a dirty tree attests nothing", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  fs.writeFileSync(path.join(repo.root, "src", "base.ts"), "export const base = 2;\n");
  const run = repo.gate(["run"]);
  assert.equal(run.status, 1);
  assert.match(run.out, /uncommitted tracked changes/);
  assert.equal(trailers(repo, "Ci-Attestation").length, 0);
});

test("a failing lane attests nothing", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  const run = repo.gate(["run"], { GATE_FIXTURE_OXLINT_EXIT: "1" });
  assert.equal(run.status, 1);
  assert.match(run.out, /lane lint \(oxlint\) failed with exit 1/);
  assert.equal(trailers(repo, "Local-Gate").length, 0);
  assert.equal(trailers(repo, "Ci-Attestation").length, 0);
});

test("editing a record distrusts the whole head", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  assert.equal(repo.gate(["run"]).status, 0);
  const message = repo.git("log", "-1", "--format=%B", "HEAD")
    .replace(/("stamp":")[0-9a-f]{32}/, "$1" + "0".repeat(32));
  const amend = repo.gitRaw(["commit", "--amend", "--no-verify", "--quiet", "-F", "-"], message);
  assert.equal(amend.status, 0, amend.out);

  const verified = repo.verify([]);
  assert.equal(verified.outputs["attested"], "false", verified.out);
  // Not merely the tampered gate: wrong evidence distrusts the head entirely.
  for (const lane of ["lint", "typecheck", "tests"]) assert.equal(verified.outputs[`skip_${lane}`], "false");
  assert.match(verified.out, /bad-stamp/);
});

test("sneaking a file in after the gate ran distrusts the head", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  assert.equal(repo.gate(["run"]).status, 0);
  fs.writeFileSync(path.join(repo.root, "src", "sneaked-in.ts"), "export const sneaky = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "--no-verify", "--amend", "--no-edit");

  const verified = repo.verify([]);
  assert.equal(verified.outputs["attested"], "false", verified.out);
  assert.equal(verified.outputs["state"], "stale-local-gate-trailer");
  // The tree-bound `Local-Gate:` trailer is checked first, so that is the
  // reason reported; either guard alone is enough to refuse.
  assert.match(verified.out, /Local-Gate names tree \w+, commit has \w+/);
  for (const lane of ["lint", "typecheck", "tests"]) assert.equal(verified.outputs[`skip_${lane}`], "false");
});

test("a rebase invalidates every record even when the tree is identical", posixOnly, () => {
  const repo = makeRepo();
  const base = repo.git("rev-parse", "HEAD").trim();
  commitChange(repo);
  assert.equal(repo.gate(["run"]).status, 0);
  const attested = repo.git("rev-parse", "HEAD").trim();
  const tree = repo.git("rev-parse", "HEAD^{tree}").trim();

  // Replay the same change over an extra (empty) commit: same content, same
  // tree, different parents — exactly what a rebase produces.
  repo.git("checkout", "-q", "--detach", base);
  repo.git("commit", "-q", "--no-verify", "--allow-empty", "-m", "someone else's commit");
  repo.git("cherry-pick", "--allow-empty", attested);
  assert.equal(repo.git("rev-parse", "HEAD^{tree}").trim(), tree);

  const verified = repo.verify([]);
  assert.equal(verified.outputs["attested"], "false", verified.out);
  assert.equal(verified.outputs["state"], "wrong-parents");
  for (const lane of ["lint", "typecheck", "tests"]) assert.equal(verified.outputs[`skip_${lane}`], "false");
});

test("check-push refuses an unattested head and accepts an attested one", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  const head = repo.git("rev-parse", "HEAD").trim();
  const line = (sha: string) => `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`;
  const push = (stdin: string) => {
    const r = spawnSync(process.execPath, [path.join(repo.root, "ci", "local_gate.mjs"), "check-push"],
      { cwd: repo.root, env: repo.env, input: stdin, encoding: "utf8" });
    return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  };

  const refused = push(line(head));
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /no Local-Gate trailer/);

  assert.equal(repo.gate(["run"]).status, 0);
  const accepted = push(line(repo.git("rev-parse", "HEAD").trim()));
  assert.equal(accepted.status, 0, accepted.out);

  // A deletion carries the zero sha and is not the gate's business.
  const deletion = push(`refs/heads/gone ${"0".repeat(40)} refs/heads/gone ${head}\n`);
  assert.equal(deletion.status, 0, deletion.out);
});

test("touching a gate surface is never trusted", posixOnly, () => {
  const repo = makeRepo();
  const base = repo.git("rev-parse", "HEAD").trim();
  const pkg = path.join(repo.root, "package.json");
  const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
  parsed.devDependencies.oxlint = "0.0.1-fixture";
  fs.writeFileSync(pkg, `${JSON.stringify(parsed, null, 2)}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "--no-verify", "-m", "bump the linter");
  assert.equal(repo.gate(["run"]).status, 0);

  // Without a base the records are valid; with the base, the surface rule bites.
  assert.equal(repo.verify([]).outputs["attested"], "true");
  const gated = repo.verify(["--base", base]);
  assert.equal(gated.outputs["attested"], "false", gated.out);
  assert.equal(gated.outputs["state"], "surface-changed");
  assert.match(gated.out, /package\.json/);
});

test("a stale record cannot authorize a skip", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  assert.equal(repo.gate(["run"]).status, 0);
  const fresh = repo.verify(["--max-age-hours", "24"]);
  assert.equal(fresh.outputs["attested"], "true", fresh.out);
  const expired = repo.verify(["--max-age-hours", "0"]);
  assert.equal(expired.outputs["attested"], "false", expired.out);
  assert.match(expired.out, /stale/);
});

test("install-hook is idempotent and never clobbers a foreign hook", posixOnly, () => {
  const repo = makeRepo();
  const hook = path.join(repo.root, ".git", "hooks", "pre-push");
  const first = repo.gate(["install-hook"]);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /wrote /);
  const written = fs.readFileSync(hook, "utf8");
  assert.match(written, /check-push/);
  assert.equal(repo.gate(["install-hook"]).out.includes("already current"), true);
  assert.equal(fs.readFileSync(hook, "utf8"), written);

  fs.writeFileSync(hook, "#!/bin/sh\necho mine\n");
  const refused = repo.gate(["install-hook"]);
  assert.equal(refused.status, 1);
  assert.match(refused.out, /was not written by this gate/);
  assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\necho mine\n");

  const chained = repo.gate(["install-hook", "--chain"]);
  assert.equal(chained.status, 0, chained.out);
  assert.match(fs.readFileSync(hook, "utf8"), /pre-push\.before-setup-soldr-gate/);
  assert.equal(fs.readFileSync(path.join(repo.root, ".git", "hooks", "pre-push.before-setup-soldr-gate"), "utf8"),
    "#!/bin/sh\necho mine\n");
});

test("an unparseable definition can authorize nothing", posixOnly, () => {
  const repo = makeRepo();
  commitChange(repo);
  assert.equal(repo.gate(["run"]).status, 0);
  fs.writeFileSync(path.join(repo.root, "ci-attestations.yml"), "version: 1\ngates:\n  nonsense\n");
  const verified = repo.verify([]);
  assert.equal(verified.outputs["attested"], "false", verified.out);
  assert.equal(verified.outputs["state"], "no-definition");
});
