import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { prepareDylint } from "../src/lib/prepare-dylint.js";

test("disabled Dylint mode performs no preparation", async () => {
  let called = false;
  const paths = await prepareDylint({
    enabled: false,
    soldrPath: "/tools/soldr",
    soldrRoot: "/cache/soldr",
    workspace: "/workspace",
    cargoDylintVersion: "6.2.0",
    dylintLinkVersion: "6.2.0",
    execCommand: async () => {
      called = true;
      return 0;
    },
  });
  assert.equal(called, false);
  assert.deepEqual(paths, []);
});

test("declared dylint-targets each get their own soldr dylint prepare --target call before tool materialization", async () => {
  const calls: string[][] = [];
  await prepareDylint({
    enabled: true,
    soldrPath: "/tools/soldr",
    soldrRoot: "/cache/soldr",
    workspace: "/workspace",
    cargoDylintVersion: "6.2.0",
    dylintLinkVersion: "6.2.0",
    crossTargets: ["x86_64-pc-windows-msvc", "aarch64-apple-darwin"],
    execCommand: async (command, args) => {
      calls.push(args);
      return 0;
    },
    exists: () => true,
    addPath: () => undefined,
  });

  assert.deepEqual(calls, [
    ["dylint", "prepare"],
    ["dylint", "prepare", "--target", "x86_64-pc-windows-msvc"],
    ["dylint", "prepare", "--target", "aarch64-apple-darwin"],
  ]);
});

test("a failing cross-target prepare throws with the target name and does not fall through to tool checks", async () => {
  await assert.rejects(
    prepareDylint({
      enabled: true,
      soldrPath: "/tools/soldr",
      soldrRoot: "/cache/soldr",
      workspace: "/workspace",
      cargoDylintVersion: "6.2.0",
      dylintLinkVersion: "6.2.0",
      crossTargets: ["x86_64-pc-windows-msvc"],
      execCommand: async (_command, args) => (args.includes("--target") ? 1 : 0),
      exists: () => true,
      addPath: () => undefined,
    }),
    /soldr dylint prepare --target x86_64-pc-windows-msvc failed/,
  );
});

test("Dylint mode delegates preparation to Soldr and exports managed tool directories", async () => {
  const added: string[] = [];
  let invocation:
    | { command: string; args: string[]; cwd: string; forceManaged: string | undefined }
    | undefined;
  const paths = await prepareDylint({
    enabled: true,
    soldrPath: "/tools/soldr",
    soldrRoot: "/cache/soldr",
    workspace: "/workspace",
    cargoDylintVersion: "6.2.0",
    dylintLinkVersion: "6.2.0",
    execCommand: async (command, args, options) => {
      invocation = {
        command,
        args,
        cwd: options.cwd,
        forceManaged: options.env["SOLDR_FORCE_MANAGED_CARGO_SUBCOMMANDS"],
      };
      return 0;
    },
    exists: () => true,
    addPath: (directory) => added.push(directory),
  });

  assert.deepEqual(invocation, {
    command: "/tools/soldr",
    args: ["dylint", "prepare"],
    cwd: "/workspace",
    forceManaged: "1",
  });
  assert.deepEqual(paths, [
    path.join("/cache/soldr", "bin", "cargo-dylint-6.2.0"),
    path.join("/cache/soldr", "bin", "dylint-link-6.2.0"),
  ]);
  assert.deepEqual(added, paths);
});

test("Dylint mode fails closed when setup pins do not match Soldr's materialized tools", async () => {
  await assert.rejects(
    () =>
      prepareDylint({
        enabled: true,
        soldrPath: "/tools/soldr",
        soldrRoot: "/cache/soldr",
        workspace: "/workspace",
        cargoDylintVersion: "99.0.0",
        dylintLinkVersion: "99.0.0",
        execCommand: async () => 0,
        exists: () => false,
      }),
    /Dylint pin must match the installed Soldr release/,
  );
});

test("a failed Soldr preparation stops setup", async () => {
  await assert.rejects(
    () =>
      prepareDylint({
        enabled: true,
        soldrPath: "/tools/soldr",
        soldrRoot: "/cache/soldr",
        workspace: "/workspace",
        cargoDylintVersion: "6.2.0",
        dylintLinkVersion: "6.2.0",
        execCommand: async () => 17,
      }),
    /failed with exit code 17/,
  );
});
