// Soldr smoke-test. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/verify_soldr.py.
// Runs `soldr version --json` and asserts the binary is on PATH, returns
// the resolved version string for the action output.

import { ToolRunner } from "@actions/exec/lib/toolrunner.js";
import { createLogger } from "./log-utils.js";

export interface VerifyResult {
  soldrVersion: string;
}

interface VersionTuple {
  major: number;
  minor: number;
  patch: number;
}

export function versionTuple(value: string): VersionTuple | null {
  const cleaned = value.trim().replace(/^v/, "");
  const parts = cleaned.split(".");
  if (parts.length < 3) return null;
  const major = parseInt(parts[0] ?? "", 10);
  const minor = parseInt(parts[1] ?? "", 10);
  const rawPatch = parts[2] ?? "";
  const patchStr = rawPatch.split("-", 1)[0] ?? "";
  const patch = parseInt(patchStr, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
  return { major, minor, patch };
}

function compareVersions(a: VersionTuple, b: VersionTuple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isTransientZccacheStatusFailure(combined: string): boolean {
  const lower = combined.toLowerCase();
  return lower.includes("zccache status failed") && lower.includes("daemon not running");
}

/**
 * Parse the stdout of `soldr version --json` into a JSON object,
 * defensively against both failure shapes seen in the wild:
 *
 * - soldr v0.7.85 and v0.7.87 shipped release binaries that exit 0 while
 *   printing nothing at all, for every subcommand (upstream silent-binary
 *   regression; fixed in v0.7.89). Bare `JSON.parse("")` surfaced that as
 *   the cryptic "Unexpected end of JSON input", which downstream consumers
 *   (e.g. FastLED/fbuild) misread as a version-JSON schema incompatibility.
 *   Empty output now gets a targeted, actionable error instead.
 * - Extra human-readable lines before/after the JSON body (progress notes,
 *   update hints a future soldr may print) are tolerated by falling back to
 *   the outermost `{...}` span when the raw output does not parse directly.
 *
 * Extra or missing fields inside the object remain the caller's concern —
 * only JSON syntax is enforced here.
 */
export function parseVersionJsonOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      "soldr version --json produced no output (binary exited 0 silently). " +
        "soldr v0.7.85 and v0.7.87 shipped broken release binaries that print " +
        "nothing for every command — pin soldr 0.7.89 or newer " +
        "(the version --json shape itself is unchanged since 0.7.35).",
    );
  }
  let firstError: Error;
  try {
    return asJsonObject(JSON.parse(trimmed));
  } catch (err) {
    firstError = err as Error;
  }
  // Tolerate surrounding non-JSON noise: retry on the outermost {...} span.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return asJsonObject(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      // fall through to the descriptive error below
    }
  }
  const snippet = trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
  throw new Error(
    `soldr version --json returned non-JSON output: ${firstError.message}\n` +
      `raw output: ${snippet}`,
  );
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("payload is not a JSON object");
  }
  return value as Record<string, unknown>;
}

async function captureAll(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; combined: string }> {
  let stdout = "";
  let combined = "";
  const code = await new ToolRunner(command, args, {
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
  }).exec();
  return { code, stdout, combined };
}

type VersionProbe = (
  command: string,
  args: string[],
  options: { ignoreReturnCode: boolean },
) => Promise<number>;

/** Informational probes must use the installed managed toolchain. */
export async function verifyManagedToolVersions(
  soldrPath: string,
  run: VersionProbe = (command, args, options) => new ToolRunner(command, args, options).exec(),
): Promise<void> {
  await run(soldrPath, ["cargo", "--version"], { ignoreReturnCode: true });
  await run(soldrPath, ["rustc", "--version"], { ignoreReturnCode: true });
}

export async function verifySoldr(opts: {
  soldrPath: string;
  buildCacheMode: string;
  requireRustPlan: boolean;
  minimumVersion?: string;
}): Promise<VerifyResult> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const { soldrPath, buildCacheMode, requireRustPlan } = opts;

  log(`Verifying soldr at ${soldrPath}`);
  const { code, stdout, combined } = await captureAll(soldrPath, ["version", "--json"]);
  if (code !== 0) {
    throw new Error(`soldr version --json failed (exit ${code}):\n${combined}`);
  }
  const payload = parseVersionJsonOutput(stdout);
  const soldrVersion = String(payload["soldr_version"] ?? "");
  if (!soldrVersion) {
    throw new Error("soldr version --json missing soldr_version field");
  }
  if (opts.minimumVersion) {
    const parsed = versionTuple(soldrVersion);
    const required = versionTuple(opts.minimumVersion);
    if (!parsed || !required || parsed.major < required.major || (parsed.major === required.major && (parsed.minor < required.minor || (parsed.minor === required.minor && parsed.patch < required.patch)))) {
      throw new Error(`cross-targets requires soldr ${opts.minimumVersion} or newer; installed ${soldrVersion}`);
    }
  }

  if (requireRustPlan) {
    const parsed = versionTuple(soldrVersion);
    const required: VersionTuple = { major: 0, minor: 7, patch: 10 };
    if (parsed === null || compareVersions(parsed, required) < 0) {
      throw new Error(
        `setup-soldr build-cache-mode ${JSON.stringify(buildCacheMode || "thin")} requires soldr v0.7.10 or newer for the zccache Rust artifact plan API; installed ${soldrVersion}.`,
      );
    }
  }

  // Version probes are informational, but still use the managed toolchain.
  await verifyManagedToolVersions(soldrPath);

  log("+ soldr status --json");
  const status = await captureAll(soldrPath, ["status", "--json"]);
  if (status.code === 0) {
    if (status.stdout.trim()) {
      for (const line of status.stdout.split(/\r?\n/)) {
        if (line) log(line);
      }
    }
  } else if (!isTransientZccacheStatusFailure(status.combined)) {
    throw new Error(`soldr status --json failed (exit ${status.code}):\n${status.combined}`);
  }

  return { soldrVersion };
}
