// Shim-bypass diagnostic.
//
// When `shims: true` is requested, setup-soldr writes shim scripts (cargo,
// rustfmt, clippy-driver, rustc, rustdoc) into `shimsDir` and prepends that
// directory to PATH. Those shims re-exec the soldr binary, which in turn
// routes compile work through zccache.
//
// The shims only fire when a child process actually resolves `cargo` /
// `rustc` through PATH and the shim dir is at the front of PATH. A handful
// of common workflow patterns silently bypass them:
//
//   - `CARGO=<abs path to ~/.cargo/bin/cargo>` — maturin and other Python
//     packaging tools honor this env var and exec it directly, skipping
//     PATH resolution entirely.
//   - `RUSTC=<abs path to rustup toolchain rustc>` — same story for any
//     build script that respects RUSTC.
//   - `RUSTC_WRAPPER=<something other than soldr/zccache>` — installs a
//     competing wrapper in the slot soldr expects to own.
//   - `~/.cargo/bin` (the rustup-installed cargo) sits earlier on PATH
//     than the setup-soldr shim dir.
//
// In all of those cases, caching looks configured but the heavy compile
// work runs through plain cargo/rustc and never visits zccache. Emit an
// advisory warning so the workflow author can either drop the override or
// reorder PATH. See issue #160.

import * as path from "node:path";

/** Tools we write shims for. Mirror of ROUTED_TOOLS in ensure-shims.ts. */
const SHIMMED_TOOLS = ["cargo", "rustfmt", "clippy-driver", "rustc", "rustdoc"];

export interface ShimBypassInput {
  /** True when the user requested `shims: true`. When false the function
   *  returns no warnings — explicit env overrides are legitimate when the
   *  user opted out of shimming. */
  shimsEnabled: boolean;
  /** Absolute path to the shim directory. Used to compare against PATH
   *  entries and absolute env-var overrides. */
  shimDir: string;
  /** Full PATH string at the end of the setup step. PATH separator is
   *  platform-dependent — caller passes `process.env.PATH` verbatim. */
  path: string;
  /** Value of `process.env.CARGO`, if set. */
  cargoEnv?: string;
  /** Value of `process.env.RUSTC`, if set. */
  rustcEnv?: string;
  /** Value of `process.env.RUSTC_WRAPPER`, if set. */
  rustcWrapperEnv?: string;
  /** Path to the soldr binary. When non-empty, a RUSTC_WRAPPER pointing at
   *  it (or at a `zccache` binary) is considered fine. */
  soldrBinary?: string;
  /** Path separator for PATH. Defaults to platform default. Exposed for
   *  tests. */
  pathSep?: string;
  /** Platform string. Defaults to `process.platform`. Exposed for tests so
   *  Windows shim-name suffix rules can be exercised on any host. */
  platform?: NodeJS.Platform;
}

/**
 * Normalize a filesystem path for case-insensitive comparison on Windows.
 * On POSIX, returns the input verbatim.
 */
function normalizePath(p: string, platform: NodeJS.Platform): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  // Strip trailing slash/backslash so "C:/foo" and "C:/foo/" compare equal.
  const stripped = trimmed.replace(/[\\/]+$/, "");
  if (platform === "win32") {
    return stripped.replace(/\//g, "\\").toLowerCase();
  }
  return stripped;
}

/**
 * Return true when `candidate` lives inside (or equals) `dir`. Both inputs
 * are normalized first. Used to detect when an absolute CARGO/RUSTC
 * override happens to point into the shim dir (legitimate, no warning).
 */
function pathInsideDir(candidate: string, dir: string, platform: NodeJS.Platform): boolean {
  const c = normalizePath(candidate, platform);
  const d = normalizePath(dir, platform);
  if (!c || !d) return false;
  if (c === d) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return c.startsWith(d + sep);
}

/**
 * Look up the basename without an executable extension on Windows.
 * On POSIX, returns the basename verbatim. Used so "cargo.cmd" vs "cargo"
 * compares equal when checking if a CARGO override points at a shim.
 */
function execBasename(p: string, platform: NodeJS.Platform): string {
  const variant = platform === "win32" ? path.win32 : path.posix;
  const base = variant.basename(p.trim());
  if (platform === "win32") {
    return base.replace(/\.(cmd|bat|exe)$/i, "").toLowerCase();
  }
  return base;
}

/** Platform-aware absolute-path check. `path.isAbsolute` defers to the host
 *  os, so a Windows path like `C:\\...` is not considered absolute on a Linux
 *  CI runner — that breaks tests that exercise the win32 branch from Linux. */
function isAbsoluteFor(p: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
}

/** Platform-aware `path.join` so the suggested shim path in the warning
 *  uses the right separator regardless of host. */
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

/**
 * Detect known shim-bypass conditions and return a list of warning
 * messages. Empty list = no problems.
 *
 * Each message is self-contained: it names the offending var or PATH
 * entry, explains the consequence, and suggests a fix. Callers should
 * pipe each one through `core.warning(...)`.
 */
export function diagnoseShimBypass(input: ShimBypassInput): string[] {
  if (!input.shimsEnabled) return [];

  const platform = input.platform ?? process.platform;
  const sep = input.pathSep ?? (platform === "win32" ? ";" : ":");
  const shimDir = (input.shimDir ?? "").trim();
  if (!shimDir) return [];

  const warnings: string[] = [];
  const normShim = normalizePath(shimDir, platform);

  // ---- PATH ordering check ----
  // Walk PATH; if the first non-empty entry is not the shim dir, the user
  // has another dir at the front that may shadow our shims for at least
  // one of the routed tools. We emit a single warning per non-shim entry
  // that precedes the shim dir.
  const pathEntries = (input.path ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const shimIndex = pathEntries.findIndex((d) => normalizePath(d, platform) === normShim);
  if (shimIndex < 0) {
    warnings.push(
      `setup-soldr: shim directory ${shimDir} is not present on PATH. ` +
        `Compile work will bypass zccache/soldr because cargo, rustc, and ` +
        `other tools will resolve through their original locations. ` +
        `Make sure no later workflow step replaces or clears PATH; ` +
        `if a step prepends a custom toolchain dir, append the shim dir ` +
        `back to the front of PATH.`,
    );
  } else if (shimIndex > 0) {
    const earlier = pathEntries.slice(0, shimIndex);
    warnings.push(
      `setup-soldr: PATH has ${earlier.length} ${
        earlier.length === 1 ? "entry" : "entries"
      } ahead of the shim directory ${shimDir} ` +
        `(first offender: ${earlier[0]}). ` +
        `If any of those directories contain a cargo, rustc, rustfmt, ` +
        `clippy-driver, or rustdoc binary, those will be picked up first ` +
        `and compile work will bypass zccache/soldr. ` +
        `Move the shim directory to the front of PATH or remove the ` +
        `overriding entries.`,
    );
  }

  // ---- CARGO env override ----
  if (input.cargoEnv && input.cargoEnv.trim()) {
    const c = input.cargoEnv.trim();
    const isAbsolute = isAbsoluteFor(c, platform);
    const insideShim = pathInsideDir(c, shimDir, platform);
    const shimMatchByName = execBasename(c, platform) === "cargo" && insideShim;
    if (isAbsolute && !shimMatchByName && !insideShim) {
      warnings.push(
        `setup-soldr: CARGO env var is set to ${c}, which is not the ` +
          `setup-soldr cargo shim (${shimDir}). Tools that honor CARGO ` +
          `(maturin, build scripts, cargo-* subcommands spawned out-of-process) ` +
          `will exec that binary directly and bypass zccache/soldr. ` +
          `Unset CARGO, or set it to the shim at ${joinFor(
            platform,
            shimDir,
            platform === "win32" ? "cargo.cmd" : "cargo",
          )}.`,
      );
    }
  }

  // ---- RUSTC env override ----
  if (input.rustcEnv && input.rustcEnv.trim()) {
    const r = input.rustcEnv.trim();
    const isAbsolute = isAbsoluteFor(r, platform);
    const insideShim = pathInsideDir(r, shimDir, platform);
    const shimMatchByName = execBasename(r, platform) === "rustc" && insideShim;
    if (isAbsolute && !shimMatchByName && !insideShim) {
      warnings.push(
        `setup-soldr: RUSTC env var is set to ${r}, which is not the ` +
          `setup-soldr rustc shim (${shimDir}). Build scripts and cargo ` +
          `itself will exec that binary directly and bypass zccache/soldr. ` +
          `Unset RUSTC, or set it to the shim at ${joinFor(
            platform,
            shimDir,
            platform === "win32" ? "rustc.cmd" : "rustc",
          )}.`,
      );
    }
  }

  // ---- RUSTC_WRAPPER override ----
  // soldr's design is that zccache sits in the RUSTC_WRAPPER slot. If the
  // user (or another action) set RUSTC_WRAPPER to anything *other than*
  // the soldr binary or a zccache binary, they've installed a competing
  // wrapper and zccache will not be invoked.
  if (input.rustcWrapperEnv && input.rustcWrapperEnv.trim()) {
    const w = input.rustcWrapperEnv.trim();
    const wName = execBasename(w, platform);
    const soldr = (input.soldrBinary ?? "").trim();
    const normW = normalizePath(w, platform);
    const normSoldr = soldr ? normalizePath(soldr, platform) : "";

    const matchesSoldr = !!normSoldr && normW === normSoldr;
    const matchesSoldrByName = wName === "soldr";
    const matchesZccache = wName === "zccache" || wName === "zccache-server";
    if (!matchesSoldr && !matchesSoldrByName && !matchesZccache) {
      warnings.push(
        `setup-soldr: RUSTC_WRAPPER is set to ${w}, which is neither the ` +
          `soldr binary nor a zccache binary. This installs a competing ` +
          `wrapper in the slot soldr expects to own; compile work will ` +
          `bypass zccache and no caching will occur. ` +
          `Unset RUSTC_WRAPPER and let soldr manage the wrapper slot.`,
      );
    }
  }

  return warnings;
}

export { SHIMMED_TOOLS };
