// Soldr toolchain subcommand client (Wave 3.4 / setup-soldr#133).
//
// Wraps the three JSON subcommands added in soldr 0.7.35:
//
//   soldr toolchain ensure --json
//   soldr toolchain link --shim-dir <path> --json
//   soldr toolchain doctor --json
//
// Each helper validates `schema_version === 1` and returns `null` on any
// failure (binary missing, unsupported version, schema mismatch, non-zero
// exit, malformed JSON). Callers are expected to fall back to the legacy
// in-TS implementation when `null` is returned. This is the linchpin of
// the backwards-compat strategy promised in the issue (the action must
// still work when pinned to a soldr release older than 0.7.35).

import { ToolRunner } from "@actions/exec/lib/toolrunner.js";
import { parseVersionJsonOutput } from "./verify-soldr.js";

/**
 * Minimum soldr version that exposes the `toolchain ensure/link/doctor`
 * JSON subcommands. Set by Wave 3.4 of zackees/soldr#514.
 */
export const TOOLCHAIN_SUBCOMMANDS_MIN_VERSION = "0.7.35";

/** The schema_version emitted by soldr 0.7.35's toolchain subcommands. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Pluggable exec signature used by tests. */
export type SoldrExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Optional knobs every helper accepts. */
export interface SoldrClientDeps {
  /** Inject a custom exec function. Defaults to `@actions/exec`. */
  exec?: SoldrExecFn;
  /** Where schema-mismatch warnings should land. Defaults to a no-op. */
  warn?: (msg: string) => void;
}

/** Capture exec used in production. Routed through `@actions/exec`. */
async function defaultExec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await new ToolRunner(cmd, args, {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString("utf8");
      },
      stderr: (data: Buffer) => {
        stderr += data.toString("utf8");
      },
    },
  }).exec();
  return { code, stdout, stderr };
}

function resolveExec(deps?: SoldrClientDeps): SoldrExecFn {
  return deps?.exec ?? defaultExec;
}

function resolveWarn(deps?: SoldrClientDeps): (msg: string) => void {
  return deps?.warn ?? (() => undefined);
}

// --- version parsing ---

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): ParsedVersion | null {
  const cleaned = value.trim().replace(/^v/, "");
  if (!cleaned || cleaned === "passthrough") return null;
  const parts = cleaned.split(".");
  if (parts.length < 3) return null;
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  const patchRaw = parts[2] ?? "";
  const patch = Number.parseInt((patchRaw.split("-", 1)[0] ?? ""), 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
  return { major, minor, patch };
}

function compareVersion(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

const MIN_VERSION_PARSED = parseVersion(TOOLCHAIN_SUBCOMMANDS_MIN_VERSION)!;

// --- detectSoldrSupportsToolchainSubcommands ---

export interface DetectResult {
  supported: boolean;
  /** The reported `soldr_version` string. Empty if the call failed. */
  soldrVersion: string;
  /** True iff the binary returned the passthrough stub marker. */
  passthrough: boolean;
}

/**
 * Probe `soldr version --json` and return whether it's new enough to host
 * the `toolchain ensure/link/doctor` subcommands.
 *
 * Returns `{ supported: false }` for:
 *   - exec failures (binary missing, non-zero exit)
 *   - non-JSON output
 *   - passthrough stub responses (`setup_soldr_passthrough: true`)
 *   - versions strictly older than `TOOLCHAIN_SUBCOMMANDS_MIN_VERSION`.
 */
export async function detectSoldrSupportsToolchainSubcommands(
  soldrPath: string,
  deps?: SoldrClientDeps,
): Promise<DetectResult> {
  const ex = resolveExec(deps);
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await ex(soldrPath, ["version", "--json"]);
  } catch {
    return { supported: false, soldrVersion: "", passthrough: false };
  }
  if (res.code !== 0) {
    return { supported: false, soldrVersion: "", passthrough: false };
  }
  let payload: Record<string, unknown>;
  try {
    // Tolerant parse (extra fields, surrounding noise); silent-binary
    // regressions (empty stdout, soldr v0.7.85/v0.7.87) land in the catch
    // and degrade to the legacy in-TS toolchain implementation.
    payload = parseVersionJsonOutput(res.stdout);
  } catch {
    return { supported: false, soldrVersion: "", passthrough: false };
  }
  const soldrVersion = String(payload["soldr_version"] ?? "");
  const passthrough = payload["setup_soldr_passthrough"] === true || soldrVersion === "passthrough";
  if (passthrough) {
    return { supported: false, soldrVersion, passthrough: true };
  }
  const parsed = parseVersion(soldrVersion);
  if (parsed === null) {
    return { supported: false, soldrVersion, passthrough: false };
  }
  const supported = compareVersion(parsed, MIN_VERSION_PARSED) >= 0;
  return { supported, soldrVersion, passthrough: false };
}

// --- soldrToolchainEnsure ---

export interface ToolchainEnsureSmokeVerify {
  cargoVersion: string;
  rustcVersion: string;
  ok: boolean;
}

export interface ToolchainEnsureResult {
  channel: string;
  rustupBootstrapped: boolean;
  componentsAdded: string[];
  targetsAdded: string[];
  pluginsInstalled: string[];
  smokeVerify: ToolchainEnsureSmokeVerify;
  elapsedMs: number;
}

export interface ToolchainEnsureOpts extends SoldrClientDeps {
  channel?: string;
  profile?: string;
  components?: string[];
  targets?: string[];
}

function checkSchemaVersion(
  payload: Record<string, unknown>,
  subcommand: string,
  warn: (msg: string) => void,
): boolean {
  const schema = payload["schema_version"];
  if (schema !== SUPPORTED_SCHEMA_VERSION) {
    warn(
      `soldr ${subcommand} returned unsupported schema_version=${JSON.stringify(schema)} ` +
        `(expected ${SUPPORTED_SCHEMA_VERSION}); falling back to legacy in-process implementation`,
    );
    return false;
  }
  return true;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Invoke `soldr toolchain ensure --json`. Returns the parsed result on
 * success, or `null` on any failure (caller must fall back to legacy).
 */
export async function soldrToolchainEnsure(
  soldrPath: string,
  opts?: ToolchainEnsureOpts,
): Promise<ToolchainEnsureResult | null> {
  const ex = resolveExec(opts);
  const warn = resolveWarn(opts);
  const args: string[] = ["toolchain", "ensure", "--json"];
  if (opts?.channel) {
    args.push("--channel", opts.channel);
  }
  if (opts?.profile) {
    args.push("--profile", opts.profile);
  }
  for (const c of opts?.components ?? []) {
    args.push("--component", c);
  }
  for (const t of opts?.targets ?? []) {
    args.push("--target", t);
  }
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await ex(soldrPath, args);
  } catch {
    return null;
  }
  if (res.code !== 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!checkSchemaVersion(payload, "toolchain ensure --json", warn)) {
    return null;
  }
  const smoke = (payload["smoke_verify"] ?? {}) as Record<string, unknown>;
  return {
    channel: String(payload["channel"] ?? ""),
    rustupBootstrapped: Boolean(payload["rustup_bootstrapped"]),
    componentsAdded: toStringArray(payload["components_added"]),
    targetsAdded: toStringArray(payload["targets_added"]),
    pluginsInstalled: toStringArray(payload["plugins_installed"]),
    smokeVerify: {
      cargoVersion: String(smoke["cargo_version"] ?? ""),
      rustcVersion: String(smoke["rustc_version"] ?? ""),
      ok: Boolean(smoke["ok"]),
    },
    elapsedMs: Number(payload["elapsed_ms"] ?? 0),
  };
}

// --- soldrToolchainLink ---

export interface ToolchainLinkTool {
  name: string;
  shimPath: string;
  created: boolean;
}

export interface ToolchainLinkResult {
  shimDir: string;
  tools: ToolchainLinkTool[];
  elapsedMs: number;
}

/**
 * Invoke `soldr toolchain link --shim-dir <path> --json`. Returns the
 * parsed result on success, or `null` on any failure.
 */
export async function soldrToolchainLink(
  soldrPath: string,
  shimDir: string,
  deps?: SoldrClientDeps,
): Promise<ToolchainLinkResult | null> {
  const ex = resolveExec(deps);
  const warn = resolveWarn(deps);
  const args = ["toolchain", "link", "--shim-dir", shimDir, "--json"];
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await ex(soldrPath, args);
  } catch {
    return null;
  }
  if (res.code !== 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!checkSchemaVersion(payload, "toolchain link --json", warn)) {
    return null;
  }
  const toolsRaw = Array.isArray(payload["tools"]) ? (payload["tools"] as Record<string, unknown>[]) : [];
  const tools: ToolchainLinkTool[] = toolsRaw.map((t) => ({
    name: String(t["name"] ?? ""),
    shimPath: String(t["shim_path"] ?? ""),
    created: Boolean(t["created"]),
  }));
  return {
    shimDir: String(payload["shim_dir"] ?? shimDir),
    tools,
    elapsedMs: Number(payload["elapsed_ms"] ?? 0),
  };
}

// --- soldrToolchainDoctor ---

export interface ToolchainDoctorHost {
  os: string;
  arch: string;
  libc: string;
}

export interface ToolchainDoctorProbe {
  name: string;
  ok: boolean;
  details: Record<string, unknown>;
}

export interface ToolchainDoctorResult {
  host: ToolchainDoctorHost;
  probes: ToolchainDoctorProbe[];
  elapsedMs: number;
}

/**
 * Invoke `soldr toolchain doctor --json`. Returns the parsed result on
 * success, or `null` on any failure.
 */
export async function soldrToolchainDoctor(
  soldrPath: string,
  deps?: SoldrClientDeps,
): Promise<ToolchainDoctorResult | null> {
  const ex = resolveExec(deps);
  const warn = resolveWarn(deps);
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await ex(soldrPath, ["toolchain", "doctor", "--json"]);
  } catch {
    return null;
  }
  if (res.code !== 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!checkSchemaVersion(payload, "toolchain doctor --json", warn)) {
    return null;
  }
  const hostRaw = (payload["host"] ?? {}) as Record<string, unknown>;
  const probesRaw = Array.isArray(payload["probes"]) ? (payload["probes"] as Record<string, unknown>[]) : [];
  const probes: ToolchainDoctorProbe[] = probesRaw.map((p) => ({
    name: String(p["name"] ?? ""),
    ok: Boolean(p["ok"]),
    details: (p["details"] ?? {}) as Record<string, unknown>,
  }));
  return {
    host: {
      os: String(hostRaw["os"] ?? ""),
      arch: String(hostRaw["arch"] ?? ""),
      libc: String(hostRaw["libc"] ?? ""),
    },
    probes,
    elapsedMs: Number(payload["elapsed_ms"] ?? 0),
  };
}
