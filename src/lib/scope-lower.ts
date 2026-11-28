// forge-ci/setup-soldr#713 items 2-4 (env names match forge-ci/soldr#4308).
//
// - Scope: `scope` input, default SOLDR_SCOPE, sanitized to [A-Za-z0-9._-].
//   A set scope moves the persistent root (and the default cache root) under
//   `scopes/<id>/`, so two scopes on one runner share no writable path, and is
//   exported to soldr as SOLDR_SCOPE.
// - Provided toolchain: SOLDR_TOOLCHAIN_LOWER is a read-only directory with
//   `toolchains/<name>/`. A toolchain whose name is the requested channel (or
//   `<channel>-<host triple>`) and that carries PROVIDED_TOOLCHAIN_STAMP is
//   used as is: no rustup-init download, no `rustup toolchain install`.
//   RUSTUP_HOME points at a writable overlay whose `toolchains/<name>` is a
//   relative link into the lower.
// - Read-only paths: the lower plus SETUP_SOLDR_READONLY_PATHS (path-list);
//   setup-soldr never creates directories on or under them.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolveResult } from "./types.js";

export const SCOPE_ENV = "SOLDR_SCOPE";
export const TOOLCHAIN_LOWER_ENV = "SOLDR_TOOLCHAIN_LOWER";
export const READONLY_PATHS_ENV = "SETUP_SOLDR_READONLY_PATHS";
/** Marker a complete toolchain in the lower carries. */
export const PROVIDED_TOOLCHAIN_STAMP = ".soldr-toolchain-complete";

type Env = Record<string, string | undefined>;

/** The scope id: the input when set, else SOLDR_SCOPE; "" means unscoped. */
export function resolveScope(input: string | undefined, env: Env): string {
  const raw = (input ?? "").trim() || (env[SCOPE_ENV] ?? "").trim();
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(safe) ? "" : safe;
}

export function scopeRoot(root: string, scope: string): string {
  return scope ? path.join(root, "scopes", scope) : root;
}

export function readOnlyPaths(env: Env): string[] {
  const out: string[] = [];
  const lower = (env[TOOLCHAIN_LOWER_ENV] ?? "").trim();
  if (lower) out.push(path.resolve(lower));
  for (const p of (env[READONLY_PATHS_ENV] ?? "").split(path.delimiter)) {
    if (p.trim()) out.push(path.resolve(p.trim()));
  }
  return out;
}

export function isReadOnlyPath(p: string, readOnly: readonly string[]): boolean {
  const target = path.resolve(p);
  return readOnly.some((ro) => {
    const rel = path.relative(ro, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/** mkdir -p every path that is not flagged read-only. */
export function makeWritableDirs(paths: readonly string[], readOnly: readonly string[]): void {
  for (const p of paths) {
    if (!isReadOnlyPath(p, readOnly)) fs.mkdirSync(p, { recursive: true });
  }
}

export interface ProvidedToolchain {
  lower: string;
  name: string;
  dir: string;
}

export function findProvidedToolchain(lower: string, channel: string): ProvidedToolchain | null {
  const want = channel.trim();
  if (!lower.trim() || !want) return null;
  const toolchains = path.join(path.resolve(lower), "toolchains");
  let entries: string[];
  try {
    entries = fs.readdirSync(toolchains).sort();
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name !== want && !name.startsWith(`${want}-`)) continue;
    // `1.80` must not pick `1.80.0-...`: the remainder must be a host triple.
    if (name !== want && /^\d/.test(name.slice(want.length + 1))) continue;
    const dir = path.join(toolchains, name);
    if (fs.existsSync(path.join(dir, PROVIDED_TOOLCHAIN_STAMP))) {
      return { lower: path.resolve(lower), name, dir };
    }
  }
  return null;
}

/** Create the writable overlay RUSTUP_HOME that links the lower toolchain. */
export function prepareToolchainOverlay(overlay: string, provided: ProvidedToolchain): void {
  const toolchains = path.join(overlay, "toolchains");
  fs.mkdirSync(toolchains, { recursive: true });
  const link = path.join(toolchains, provided.name);
  const target = path.relative(toolchains, provided.dir);
  let current: string | null = null;
  try {
    current = fs.readlinkSync(link);
  } catch {
    current = null;
  }
  if (current === target) return;
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * main's toolchain step for a provided toolchain: no download, no rustup
 * install. Returns false (and does nothing) when no lower toolchain applies.
 */
export function provisionProvidedToolchain(
  result: Pick<ResolveResult, "providedToolchain" | "toolchain">,
  io: { log: (msg: string) => void; addPath: (p: string) => void; exportVariable: (name: string, value: string) => void },
): boolean {
  const provided = result.providedToolchain;
  if (!provided) return false;
  io.log(`toolchain: using provided ${provided.name} from ${TOOLCHAIN_LOWER_ENV}=${provided.lower}; skipping download and rustup install (#713)`);
  io.addPath(path.join(provided.dir, "bin"));
  io.exportVariable("RUSTUP_TOOLCHAIN", provided.name);
  process.env["RUSTUP_TOOLCHAIN"] = provided.name;
  return true;
}
