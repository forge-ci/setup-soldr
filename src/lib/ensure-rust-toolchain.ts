// Rustup / toolchain installer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/ensure_rust_toolchain.py.
// Bootstraps rustup if missing, installs the requested channel + components
// + targets, and ensures the toolchain is ready for downstream cargo calls.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { ToolRunner } from "@actions/exec/lib/toolrunner.js";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";
import { createLogger, streamExec } from "./log-utils.js";
import type { ResolveResult } from "./types.js";
import {
  detectSoldrSupportsToolchainSubcommands,
  soldrToolchainEnsure,
  type SoldrExecFn,
  type ToolchainEnsureResult,
} from "./soldr-toolchain-client.js";

function rustupInitTargetTriple(): string {
  const system = process.platform;
  const arch = process.arch;
  if (system === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "ia32") return "i686-pc-windows-msvc";
  } else if (system === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  } else if (system === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "ia32") return "i686-unknown-linux-gnu";
  }
  throw new Error(`unsupported platform for rustup bootstrap: ${system}/${arch}`);
}

function rustupInitUrl(): string {
  const target = rustupInitTargetTriple();
  const suffix = target.endsWith("windows-msvc") ? ".exe" : "";
  return `https://static.rust-lang.org/rustup/dist/${target}/rustup-init${suffix}`;
}

async function whichOrNull(cmd: string): Promise<string | null> {
  try {
    return await io.which(cmd, true);
  } catch {
    return null;
  }
}

async function ensureRustupAvailable(soldrRoot: string, log: (msg: string) => void): Promise<string> {
  const existing = await whichOrNull("rustup");
  if (existing) {
    log(`Using rustup at ${existing}`);
    return existing;
  }
  const installerDir = path.join(soldrRoot, "cache");
  fs.mkdirSync(installerDir, { recursive: true });
  const url = rustupInitUrl();
  log(`Downloading rustup-init from ${url}`);
  const targetName = process.platform === "win32" ? "rustup-init.exe" : "rustup-init";
  const downloaded = await tc.downloadTool(url, path.join(installerDir, targetName));
  if (process.platform !== "win32") {
    fs.chmodSync(downloaded, 0o755);
  }
  // #389: streamExec prefixes the rustup-init download/install progress lines.
  await streamExec(downloaded, ["-y", "--no-modify-path", "--default-toolchain", "none"]);
  const after = await whichOrNull("rustup");
  if (!after) {
    throw new Error("setup-soldr failed to bootstrap rustup on the runner");
  }
  return after;
}

async function captureText(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await exec.exec(command, args, {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString("utf8");
      },
    },
  });
  return { code, stdout };
}

async function captureAll(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; combined: string }> {
  let stdout = "";
  let combined = "";
  const code = await exec.exec(command, args, {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        const s = data.toString("utf8");
        stdout += s;
        combined += s;
      },
      stderr: (data: Buffer) => {
        combined += data.toString("utf8");
      },
    },
  });
  return { code, stdout, combined };
}

async function rustupInstalledNames(rustup: string, args: string[]): Promise<Set<string>> {
  const { code, stdout } = await captureText(rustup, args);
  if (code !== 0) return new Set();
  const out = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const first = t.split(/\s+/, 1)[0];
    if (first) out.add(first);
  }
  return out;
}

async function toolchainAvailable(rustup: string, channel: string): Promise<boolean> {
  const installed = await rustupInstalledNames(rustup, ["toolchain", "list"]);
  for (const name of installed) {
    if (name === channel || name.startsWith(`${channel}-`)) return true;
  }
  return false;
}

async function installedToolchainRelease(rustup: string, channel: string, bootstrapSoldr?: string): Promise<string | null> {
  let code: number;
  let stdout = "";
  if (bootstrapSoldr) {
    code = await new ToolRunner(bootstrapSoldr, ["--no-cache", "rustc", "--version"], {
      env: { ...process.env, RUSTUP_TOOLCHAIN: channel, SOLDR_NO_GLOBAL_DELEGATION: "1", SOLDR_BROKER_AUTOSPAWN: "0", SOLDR_AS: "" } as Record<string, string>,
      silent: true, ignoreReturnCode: true,
      listeners: { stdout: (data: Buffer) => { stdout += data.toString("utf8"); } },
    }).exec();
  } else {
    ({ code, stdout } = await captureText(rustup, ["run", channel, "rustc", "--version"]));
  }
  if (code !== 0) return null;
  const match = stdout.trim().match(/^rustc\s+(\S+)/);
  return match ? (match[1] ?? null) : null;
}

export function shouldRefreshToolchain(channel: string): boolean {
  const n = (channel ?? "").trim().toLowerCase();
  if (!n) return false;
  for (const alias of ["stable", "beta", "nightly"]) {
    if (n === alias) return true;
    if (n.startsWith(`${alias}-`)) {
      const re = new RegExp(`^${alias}-\\d`);
      if (!re.test(n)) return true;
    }
  }
  return false;
}

export function shouldSkipRefreshForExactHit(
  channel: string,
  expectedRelease: string,
  setupCacheExactHit: boolean,
  installedRelease: string | null,
): boolean {
  if (!shouldRefreshToolchain(channel)) return false;
  if (!setupCacheExactHit) return false;
  if (!expectedRelease.trim()) return false;
  return installedRelease === expectedRelease;
}

function componentInstalled(installed: Set<string>, component: string): boolean {
  for (const name of installed) {
    if (name === component || name.startsWith(`${component}-`)) return true;
  }
  return false;
}

async function missingComponents(rustup: string, channel: string, components: string[]): Promise<string[]> {
  const installed = await rustupInstalledNames(
    rustup,
    ["component", "list", "--toolchain", channel, "--installed"],
  );
  return components.filter((c) => !componentInstalled(installed, c));
}

async function missingTargets(rustup: string, channel: string, targets: string[]): Promise<string[]> {
  const installed = await rustupInstalledNames(
    rustup,
    ["target", "list", "--toolchain", channel, "--installed"],
  );
  return targets.filter((t) => !installed.has(t));
}

async function addComponents(
  rustup: string,
  channel: string,
  components: string[],
  log: (msg: string) => void,
): Promise<void> {
  if (components.length === 0) return;
  const missing = await missingComponents(rustup, channel, components);
  if (missing.length === 0) {
    log(`Rust components already installed for ${channel}: ${components.join(", ")}`);
    return;
  }
  log(`Installing Rust components for ${channel}: ${missing.join(", ")}`);
  const command = ["component", "add", "--toolchain", channel, ...missing];
  const first = await captureAll(rustup, command);
  if (first.code !== 0) {
    const combinedLower = first.combined.toLowerCase();
    const conflict =
      combinedLower.includes("failed to install component") && combinedLower.includes("detected conflict");
    if (!conflict) {
      throw new Error(`rustup component add failed (code ${first.code}):\n${first.combined}`);
    }
    log("Rust component install hit a rustup conflict; removing requested components and retrying");
    for (const c of missing) {
      await streamExec(rustup, ["component", "remove", "--toolchain", channel, c], {
        ignoreReturnCode: true,
      });
    }
    await streamExec(rustup, command);
  }
  const stillMissing = await missingComponents(rustup, channel, components);
  if (stillMissing.length > 0) {
    throw new Error(
      `rustup did not install requested components for ${channel}: ${stillMissing.join(", ")}`,
    );
  }
}

async function addTargets(
  rustup: string,
  channel: string,
  targets: string[],
  log: (msg: string) => void,
): Promise<void> {
  if (targets.length === 0) return;
  const missing = await missingTargets(rustup, channel, targets);
  if (missing.length === 0) {
    log(`Rust targets already installed for ${channel}: ${targets.join(", ")}`);
    return;
  }
  log(`Installing Rust targets for ${channel}: ${missing.join(", ")}`);
  await streamExec(rustup, ["target", "add", "--toolchain", channel, ...missing]);
  const stillMissing = await missingTargets(rustup, channel, targets);
  if (stillMissing.length > 0) {
    throw new Error(
      `rustup did not install requested targets for ${channel}: ${stillMissing.join(", ")}`,
    );
  }
}

/**
 * Try delegating toolchain provisioning to `soldr toolchain ensure --json`.
 *
 * Wave 3.4 of zackees/soldr#514 (setup-soldr#133): if the soldr binary at
 * `soldrPath` is >= 0.7.35 and the subcommand returns a schema-version-1
 * payload, the legacy in-TS rustup driver is bypassed entirely. On any
 * failure (missing binary, older version, schema mismatch, non-zero exit,
 * malformed JSON) this returns `null` and the caller must run the legacy
 * code path.
 *
 * Exported for unit tests. Callers in production should use
 * `ensureRustToolchain`, which threads through `ensure-rust-toolchain`'s
 * existing public API.
 */
export async function tryDelegateToSoldrToolchainEnsure(opts: {
  soldrPath: string;
  channel: string;
  profile: string;
  components: string[];
  targets: string[];
  exec?: SoldrExecFn;
  warn?: (msg: string) => void;
}): Promise<ToolchainEnsureResult | null> {
  const detected = await detectSoldrSupportsToolchainSubcommands(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
  });
  if (!detected.supported) return null;
  return soldrToolchainEnsure(opts.soldrPath, {
    exec: opts.exec,
    warn: opts.warn,
    channel: opts.channel,
    profile: opts.profile,
    components: opts.components,
    targets: opts.targets,
  });
}

export async function ensureRustToolchain(opts: {
  resolveResult: ResolveResult;
  setupCacheExactHit: boolean;
  bootstrapSoldr?: string;
  /** Reinstall after a restored cache entry fails a post-restore probe. */
  forceRepair?: boolean;
}): Promise<void> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);

  const { resolveResult, setupCacheExactHit, forceRepair = false } = opts;
  if (resolveResult.enabled && !opts.bootstrapSoldr) {
    throw new Error("verified Soldr bootstrap required for toolchain setup");
  }
  const cargoHome = resolveResult.cargoHome;
  const rustupHome = resolveResult.rustupHome;
  const soldrRoot = resolveResult.soldrRoot;
  const binDir = path.join(cargoHome, "bin");

  for (const dir of [cargoHome, rustupHome, soldrRoot, path.join(soldrRoot, "cache"), path.join(soldrRoot, "bin"), binDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // rustup respects $CARGO_HOME / $RUSTUP_HOME from process.env; make sure
  // they're set for child processes. (Main step exports them via resolve.)
  process.env["CARGO_HOME"] = cargoHome;
  process.env["RUSTUP_HOME"] = rustupHome;
  // Ensure cargo bin dir is on PATH for `cargo`/`rustc` lookups in this proc.
  const sep = process.platform === "win32" ? ";" : ":";
  if (!(process.env["PATH"] ?? "").split(sep).includes(binDir)) {
    process.env["PATH"] = `${binDir}${sep}${process.env["PATH"] ?? ""}`;
  }

  const channel = resolveResult.toolchain.channel.trim() || "stable";
  const profile = resolveResult.toolchain.profile.trim() || "minimal";
  const components = [...resolveResult.toolchain.components];
  const targets = [...resolveResult.toolchain.targets];
  const cacheChannel = resolveResult.toolchain.cacheChannel.trim();

  // Wave 3.4 (setup-soldr#133): try delegating to `soldr toolchain ensure --json`.
  // Returns null when the binary is missing, < 0.7.35, the schema mismatches,
  // or the subcommand exits non-zero — every such case falls through to the
  // legacy in-TS rustup driver below. The delegation is *optional*: the action
  // continues to work end-to-end when pinned to an older soldr release.
  const delegated = forceRepair ? null : await tryDelegateToSoldrToolchainEnsure({
    soldrPath: resolveResult.soldrPath,
    channel,
    profile,
    components,
    targets,
    warn: (msg) => core.warning(msg),
  });
  if (delegated) {
    log(
      `Delegated Rust toolchain provisioning to soldr toolchain ensure --json ` +
        `(channel=${delegated.channel}, elapsed_ms=${delegated.elapsedMs})`,
    );
    if (delegated.componentsAdded.length > 0) {
      log(`soldr installed Rust components: ${delegated.componentsAdded.join(", ")}`);
    }
    if (delegated.targetsAdded.length > 0) {
      log(`soldr installed Rust targets: ${delegated.targetsAdded.join(", ")}`);
    }
    core.exportVariable("RUSTUP_TOOLCHAIN", channel);
    process.env["RUSTUP_TOOLCHAIN"] = channel;
    core.setOutput("toolchain", channel);
    void os.EOL;
    return;
  }

  const rustup = await ensureRustupAvailable(soldrRoot, log);

  log(`Resolved Rust toolchain channel=${channel} profile=${profile}`);
  log(`Requested Rust components: ${components.length > 0 ? components.join(", ") : "none"}`);
  log(`Requested Rust targets: ${targets.length > 0 ? targets.join(", ") : "none"}`);

  await exec.exec(rustup, ["set", "profile", profile]);

  if (forceRepair) {
    log(`Cached Rust toolchain failed validation; reinstalling ${channel} before adding components/targets`);
    await exec.exec(rustup, ["toolchain", "uninstall", channel], {
      ignoreReturnCode: true,
      silent: true,
    });
    await streamExec(rustup, ["toolchain", "install", channel, "--profile", profile]);
  }

  if (!forceRepair && shouldRefreshToolchain(channel)) {
    const installedRelease = (await toolchainAvailable(rustup, channel))
      ? await installedToolchainRelease(rustup, channel, opts.bootstrapSoldr)
      : null;
    if (shouldSkipRefreshForExactHit(channel, cacheChannel, setupCacheExactHit, installedRelease)) {
      log(
        `Using installed rolling Rust toolchain ${channel} without refresh because the setup cache exact-hit matches release ${cacheChannel}`,
      );
    } else {
      if (setupCacheExactHit && cacheChannel) {
        log(
          `Rolling Rust toolchain ${channel} exact-hit expected release ${cacheChannel}; installed release is ${
            installedRelease ?? "missing"
          }, refreshing`,
        );
      } else {
        log(`Refreshing rolling Rust toolchain ${channel} with profile ${profile}`);
      }
      await streamExec(rustup, ["toolchain", "install", channel, "--profile", profile]);
    }
  } else if (!(await toolchainAvailable(rustup, channel))) {
    log(`Installing Rust toolchain ${channel} with profile ${profile}`);
    await exec.exec(rustup, ["toolchain", "install", channel, "--profile", profile]);
  } else {
    log(`Using installed Rust toolchain ${channel}`);
  }

  await addComponents(rustup, channel, components, log);
  await addTargets(rustup, channel, targets, log);

  core.exportVariable("RUSTUP_TOOLCHAIN", channel);
  process.env["RUSTUP_TOOLCHAIN"] = channel;

  const cargo = await whichOrNull("cargo");
  const rustc = await whichOrNull("rustc");
  if (!cargo || !rustc) {
    throw new Error("setup-soldr failed to expose cargo/rustc after rustup configured the toolchain");
  }
  if (opts.bootstrapSoldr) {
    const env = { ...process.env, SOLDR_NO_GLOBAL_DELEGATION: "1", SOLDR_BROKER_AUTOSPAWN: "0", SOLDR_AS: "" } as Record<string, string>;
    await new ToolRunner(opts.bootstrapSoldr, ["--no-cache", "cargo", "--version"], { env }).exec();
    await new ToolRunner(opts.bootstrapSoldr, ["--no-cache", "rustc", "--version"], { env }).exec();
  } else if (!resolveResult.enabled) {
    await exec.exec(cargo, ["--version"]);
    await exec.exec(rustc, ["--version"]);
  } else {
    throw new Error("verified Soldr bootstrap required for toolchain verification");
  }

  core.setOutput("toolchain", channel);
  // Touch os.EOL once to avoid unused-import complaints when running on some
  // platforms; ensures fs+os are both legitimately referenced.
  void os.EOL;
}
