// Toolchain resolution helpers. Owned by Agent 1.
//
// Port of resolve_setup.py:
//   - load_toolchain_spec()
//   - _rolling_toolchain_alias()
//   - _rust_channel_manifest_release()
//   - resolve_toolchain_cache_channel()
//   - _system_rustup_satisfies_request()

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as toml from "@iarna/toml";
import * as io from "@actions/io";
import * as exec from "@actions/exec";
import { ToolRunner } from "@actions/exec/lib/toolrunner.js";
import type { Logger, ToolchainSpec } from "./types.js";

const ROLLING_TOOLCHAIN_ALIASES = ["stable", "beta", "nightly"] as const;
type RollingAlias = (typeof ROLLING_TOOLCHAIN_ALIASES)[number];

/**
 * If the supplied channel is one of the rolling aliases (stable, beta,
 * nightly), possibly with a non-numeric suffix (e.g. host triple), return the
 * alias. Numerically-suffixed forms ("nightly-2024-04-01") return null.
 */
export function rollingToolchainAlias(channel: string): RollingAlias | null {
  const normalized = channel.trim().toLowerCase();
  for (const alias of ROLLING_TOOLCHAIN_ALIASES) {
    if (normalized === alias) {
      return alias;
    }
    if (normalized.startsWith(`${alias}-`)) {
      const next = normalized.charAt(alias.length + 1);
      if (next !== "" && !/[0-9]/.test(next)) {
        return alias;
      }
    }
  }
  return null;
}

/** Fetch the manifest for a rolling channel; return the release version or null. */
export async function rustChannelManifestRelease(
  channelAlias: RollingAlias,
  log?: (msg: string) => void,
): Promise<string | null> {
  const url = `https://static.rust-lang.org/dist/channel-rust-${channelAlias}.toml`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      log?.(
        `Unable to resolve rolling Rust channel ${channelAlias} to a release version: HTTP ${response.status}. Falling back to the requested channel string for cache keying.`,
      );
      return null;
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = toml.parse(text);
    } catch (err) {
      log?.(
        `Unable to resolve rolling Rust channel ${channelAlias} to a release version: ${(err as Error).message}. Falling back to the requested channel string for cache keying.`,
      );
      return null;
    }
    const rustPkg = extractRustPkg(payload);
    if (rustPkg === null) {
      log?.(
        `Rust manifest for rolling channel ${channelAlias} did not contain pkg.rust metadata. Falling back to the requested channel string for cache keying.`,
      );
      return null;
    }
    const rawVersion =
      typeof rustPkg["version"] === "string" ? (rustPkg["version"] as string).trim() : "";
    if (!rawVersion) {
      log?.(
        `Rust manifest for rolling channel ${channelAlias} did not contain a version string. Falling back to the requested channel string for cache keying.`,
      );
      return null;
    }
    return rawVersion.split(" ")[0] ?? rawVersion;
  } catch (err) {
    log?.(
      `Unable to resolve rolling Rust channel ${channelAlias} to a release version: ${(err as Error).message}. Falling back to the requested channel string for cache keying.`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractRustPkg(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const pkg = (payload as Record<string, unknown>)["pkg"];
  if (typeof pkg !== "object" || pkg === null) return null;
  const rust = (pkg as Record<string, unknown>)["rust"];
  if (typeof rust !== "object" || rust === null) return null;
  return rust as Record<string, unknown>;
}

/**
 * Resolve a rolling channel alias ("stable", "beta", "nightly") to the
 * concrete release version (e.g. "1.95.0"). Non-rolling channels and
 * fetch failures return the original channel string.
 */
export async function resolveToolchainCacheChannel(
  channel: string,
  log?: (msg: string) => void,
): Promise<string> {
  const alias = rollingToolchainAlias(channel);
  if (alias === null) {
    return channel;
  }
  const resolved = await rustChannelManifestRelease(alias, log);
  return resolved ?? channel;
}

function normalizeList(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      const s = String(item).trim();
      if (s.length > 0) out.push(s);
    }
    return out;
  }
  return [];
}

/**
 * Load toolchain spec from rust-toolchain.toml (or input override).
 */
export async function loadToolchainSpec(opts: {
  workspace: string;
  toolchainFile: string;
  toolchainOverride: string;
  log?: (msg: string) => void;
}): Promise<ToolchainSpec> {
  const { workspace, toolchainFile, toolchainOverride, log } = opts;

  let channel = "stable";
  let profile = "minimal";
  let components: string[] = [];
  let targets: string[] = [];
  let source = "default";
  let fileHash = "none";

  if (toolchainFile) {
    const filePath = path.join(workspace, toolchainFile);
    if (fs.existsSync(filePath)) {
      source = path.relative(workspace, filePath).split(path.sep).join("/");
      const bytes = fs.readFileSync(filePath);
      fileHash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      let data: unknown;
      try {
        data = toml.parse(bytes.toString("utf8"));
      } catch (err) {
        throw new Error(
          `failed to parse toolchain file ${filePath}: ${(err as Error).message}`,
        );
      }
      if (typeof data === "object" && data !== null) {
        const toolchain = (data as Record<string, unknown>)["toolchain"];
        if (typeof toolchain === "object" && toolchain !== null) {
          const tc = toolchain as Record<string, unknown>;
          if (typeof tc["channel"] === "string") channel = tc["channel"] as string;
          if (typeof tc["profile"] === "string") profile = tc["profile"] as string;
          components = normalizeList(tc["components"]);
          targets = normalizeList(tc["targets"]);
        }
      }
    }
  }

  if (toolchainOverride) {
    channel = toolchainOverride.trim();
    source = "input";
  }

  const cacheChannel = await resolveToolchainCacheChannel(channel, log);

  return {
    channel,
    cacheChannel,
    profile,
    components,
    targets,
    source,
    fileHash,
  };
}

// --------------------- system rustup probe ---------------------

async function runRustupText(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  const exitCode = await exec.exec(command, args, {
    env,
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
    },
  });
  return { exitCode, stdout };
}

async function rustupInstalledNames(
  rustup: string,
  args: string[],
  env: Record<string, string>,
): Promise<Set<string>> {
  const { exitCode, stdout } = await runRustupText(rustup, args, env);
  if (exitCode !== 0) {
    return new Set();
  }
  const out = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/, 1)[0];
    if (first) out.add(first);
  }
  return out;
}

/**
 * #304: read `$RUSTUP_HOME/toolchains/` directly to discover installed
 * toolchains. Skips the `rustup toolchain list` subprocess which on
 * hosted runners costs ~6-7s per call (observed in zccache CI). The
 * answer is the same — rustup itself reads this directory to build its
 * own list. Returns an empty set when the directory doesn't exist
 * (matches the "rustup not initialized" semantics).
 *
 * Naming: rustup stores toolchains as `<spec>-<target-triple>`
 * (e.g. `1.94.1-x86_64-unknown-linux-gnu` or `stable-aarch64-apple-darwin`).
 * Returns the directory names verbatim so `toolchainListContains` works
 * unchanged against them.
 */
function fsInstalledToolchains(rustupHome: string): Set<string> {
  const toolchainsDir = path.join(rustupHome, "toolchains");
  try {
    const entries = fs.readdirSync(toolchainsDir, { withFileTypes: true });
    const out = new Set<string>();
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        out.add(entry.name);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

function toolchainListContains(installed: Set<string>, channel: string): boolean {
  for (const name of installed) {
    if (name === channel || name.startsWith(`${channel}-`)) return true;
  }
  return false;
}

async function installedToolchainRelease(
  rustup: string,
  channel: string,
  env: Record<string, string>,
  bootstrapSoldr?: string,
): Promise<string | null> {
  let stdout = "";
  let exitCode: number;
  if (bootstrapSoldr) {
    exitCode = await new ToolRunner(bootstrapSoldr, ["--no-cache", "rustc", "--version"], {
      env: { ...env, RUSTUP_TOOLCHAIN: channel, SOLDR_NO_GLOBAL_DELEGATION: "1", SOLDR_BROKER_AUTOSPAWN: "0", SOLDR_AS: "" }, silent: true, ignoreReturnCode: true,
      listeners: { stdout: (data: Buffer) => { stdout += data.toString(); } },
    }).exec();
  } else {
    const result = await runRustupText(rustup, ["run", channel, "rustc", "--version"], env);
    exitCode = result.exitCode;
    stdout = result.stdout;
  }
  if (exitCode !== 0) return null;
  const match = stdout.trim().match(/^rustc\s+(\S+)/);
  return match ? (match[1] ?? null) : null;
}

function componentInstalled(installed: Set<string>, component: string): boolean {
  for (const name of installed) {
    if (name === component || name.startsWith(`${component}-`)) return true;
  }
  return false;
}

export interface SystemRustupProbeDeps {
  /** Returns absolute path to rustup, or null if not found. */
  which?: (cmd: string) => Promise<string | null>;
  /** Optional override for the runner used to probe rustup state. */
  rustupInstalledNames?: typeof rustupInstalledNames;
  installedToolchainRelease?: typeof installedToolchainRelease;
}

/**
 * Return true when the runner-managed rustup home already satisfies the
 * requested toolchain (channel + components + targets, with rolling alias
 * release pinning). Returns false otherwise; the action then falls back to a
 * managed RUSTUP_HOME under the setup cache root.
 */
export async function systemRustupSatisfiesRequest(opts: {
  cargoHome: string;
  rustupHome: string;
  bootstrapSoldr?: string;
  getBootstrapSoldr?: () => Promise<string>;
  allowUnmanagedProbe?: boolean;
  toolchain: ToolchainSpec;
  env: Record<string, string | undefined>;
  logger?: Logger;
  deps?: SystemRustupProbeDeps;
}): Promise<boolean> {
  const { cargoHome, rustupHome, toolchain, env, logger, deps } = opts;
  const which = deps?.which ?? defaultWhich;
  const installedNamesFn = deps?.rustupInstalledNames ?? rustupInstalledNames;
  const installedReleaseFn = deps?.installedToolchainRelease ?? installedToolchainRelease;

  const channel = toolchain.channel.trim() || "stable";

  // #304: fast-path. Check $RUSTUP_HOME/toolchains/ directly before
  // shelling out to `rustup`. On hosted runners the `rustup toolchain
  // list` spawn alone has been observed at ~7s on zccache CI; the same
  // information is in the filesystem and a `readdirSync` is sub-ms.
  // When the FS check rules the runner OUT (channel not installed) we
  // can return false immediately and avoid `which("rustup")` too,
  // shaving the entire probe to ~0s.
  const fsToolchains = fsInstalledToolchains(rustupHome);
  if (fsToolchains.size > 0 && !toolchainListContains(fsToolchains, channel)) {
    logger?.log(
      `Runner rustup home ${rustupHome} does not already contain toolchain ${channel}; using managed RUSTUP_HOME under the setup cache root`,
    );
    return false;
  }

  const rustup = await which("rustup");
  if (rustup === null) {
    logger?.log("rustup not found on PATH; using managed RUSTUP_HOME under the setup cache root");
    return false;
  }

  const probeEnv = makeProbeEnv(env, cargoHome, rustupHome);

  // When the FS readdir came back empty (uninitialized rustup home, or
  // a host where the toolchains live somewhere atypical), fall through
  // to the rustup spawn so we don't regress edge cases.
  if (fsToolchains.size === 0) {
    const installedToolchains = await installedNamesFn(rustup, ["toolchain", "list"], probeEnv);
    if (!toolchainListContains(installedToolchains, channel)) {
      logger?.log(
        `Runner rustup home ${rustupHome} does not already contain toolchain ${channel}; using managed RUSTUP_HOME under the setup cache root`,
      );
      return false;
    }
  }

  const expectedRelease = toolchain.cacheChannel.trim();
  if (rollingToolchainAlias(channel) !== null && expectedRelease) {
    let bootstrapSoldr = opts.bootstrapSoldr;
    if (!bootstrapSoldr && !opts.allowUnmanagedProbe && !deps?.installedToolchainRelease) {
      if (!opts.getBootstrapSoldr) throw new Error("verified Soldr bootstrap required for system Rust release probe");
      bootstrapSoldr = await opts.getBootstrapSoldr();
    }
    const installedRelease = await installedReleaseFn(rustup, channel, probeEnv, bootstrapSoldr);
    if (installedRelease !== expectedRelease) {
      logger?.log(
        `Runner rustup home ${rustupHome} has ${channel} release ${installedRelease ?? "missing"} but exact-hit reuse expects ${expectedRelease}; using managed RUSTUP_HOME under the setup cache root`,
      );
      return false;
    }
  }

  const components = [...toolchain.components];
  if (components.length > 0) {
    const installedComponents = await installedNamesFn(
      rustup,
      ["component", "list", "--toolchain", channel, "--installed"],
      probeEnv,
    );
    const missingComponents = components.filter((c) => !componentInstalled(installedComponents, c));
    if (missingComponents.length > 0) {
      logger?.log(
        `Runner rustup home ${rustupHome} is missing requested components for ${channel}: ${missingComponents.join(", ")}; using managed RUSTUP_HOME under the setup cache root`,
      );
      return false;
    }
  }

  const targets = [...toolchain.targets];
  if (targets.length > 0) {
    const installedTargets = await installedNamesFn(
      rustup,
      ["target", "list", "--toolchain", channel, "--installed"],
      probeEnv,
    );
    const missingTargets = targets.filter((t) => !installedTargets.has(t));
    if (missingTargets.length > 0) {
      logger?.log(
        `Runner rustup home ${rustupHome} is missing requested targets for ${channel}: ${missingTargets.join(", ")}; using managed RUSTUP_HOME under the setup cache root`,
      );
      return false;
    }
  }

  logger?.log(
    `Using runner rustup home ${rustupHome} for toolchain ${channel}; setup cache stays binary-only without managed rustup`,
  );
  return true;
}

function makeProbeEnv(
  env: Record<string, string | undefined>,
  cargoHome: string,
  rustupHome: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  out["CARGO_HOME"] = cargoHome;
  out["RUSTUP_HOME"] = rustupHome;
  return out;
}

async function defaultWhich(cmd: string): Promise<string | null> {
  try {
    return await io.which(cmd, true);
  } catch {
    return null;
  }
}
