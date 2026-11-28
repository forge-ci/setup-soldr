// setup-soldr#553/#557: shared plumbing for the stores setup-soldr keeps in
// RUNNER_TOOL_CACHE on runners whose tool cache outlives the job.
//
// Under act (`bosn ci`, which persists /opt/hostedtoolcache across runs) and
// on self-hosted runners, RUNNER_TEMP is empty in every new job but the tool
// cache is not. Each layer -- soldr's syslib store (#553), its stamped tool
// bundles such as LLVM, and the managed Rust toolchain (#557) -- keeps its
// content under `$RUNNER_TOOL_CACHE/soldr-<layer>/<platform>-<arch>` so a
// warm run finds it instead of downloading it again.
//
// Off by default on GitHub-hosted runners (their tool cache dies with the VM
// and setup-cache carries these paths there) and on Windows (a link would
// need a junction, and soldr's Windows extractors special-case reparse
// points, soldr#2300). `SETUP_SOLDR_TOOL_CACHE=0|1` overrides the runner
// default for every layer.

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_CACHE_ENV = "SETUP_SOLDR_TOOL_CACHE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface StoreLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface ToolCacheDecision {
  enabled: boolean;
  /** RUNNER_TOOL_CACHE, trimmed; empty when unset. */
  toolCache: string;
  reason: string;
}

/**
 * Decide whether a layer may keep its store in RUNNER_TOOL_CACHE.
 * `layerOff`, when non-empty, is the layer's own reason to stay off; it
 * outranks a forcing override but not a disabling one.
 */
export function decideToolCacheStore(input: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  layerOff?: string;
}): ToolCacheDecision {
  const toolCache = (input.env["RUNNER_TOOL_CACHE"] ?? "").trim();
  const off = (reason: string): ToolCacheDecision => ({ enabled: false, toolCache, reason });
  const on = (reason: string): ToolCacheDecision => ({ enabled: true, toolCache, reason });
  const override = (input.env[TOOL_CACHE_ENV] ?? "").trim().toLowerCase();

  if (FALSY.has(override)) return off(`${TOOL_CACHE_ENV}=${override}`);
  if (!toolCache) return off("RUNNER_TOOL_CACHE is unset");
  if (input.platform === "win32") return off("not enabled on Windows");
  const layerOff = (input.layerOff ?? "").trim();
  if (layerOff) return off(layerOff);
  if (TRUTHY.has(override)) return on(`${TOOL_CACHE_ENV}=${override}`);
  if (TRUTHY.has((input.env["ACT"] ?? "").trim().toLowerCase())) {
    return on("act runner (tool cache persists across runs)");
  }
  if ((input.env["RUNNER_ENVIRONMENT"] ?? "").trim() === "self-hosted") {
    return on("self-hosted runner (tool cache persists across runs)");
  }
  return off("GitHub-hosted tool cache is per-VM; setup-cache carries this layer");
}

export function toolCacheStorePath(toolCache: string, layer: string, platform: string, arch: string): string {
  return path.join(toolCache, `soldr-${layer}`, `${platform}-${arch}`);
}

export type LinkStatus = "linked" | "already-linked" | "kept-existing-dir";

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Make `linkPath` a symlink to `target`. A non-empty real directory (for
 * example one setup-cache just restored) is left alone: it already holds the
 * content, and replacing it would discard it. An empty directory, a file, or
 * a link elsewhere is replaced.
 *
 * The link target is written relative to the link's directory (#713), so
 * relocating a tree that holds both the link and the store keeps it
 * resolving. An older absolute link to the same target is rewritten.
 */
export function linkDir(input: { linkPath: string; target: string }): LinkStatus {
  const { linkPath, target } = input;
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const relTarget = path.relative(path.dirname(linkPath), target) || ".";
  const existing = lstatOrNull(linkPath);
  if (existing?.isSymbolicLink()) {
    if (fs.readlinkSync(linkPath) === relTarget) return "already-linked";
    fs.unlinkSync(linkPath);
  } else if (existing?.isDirectory()) {
    if (fs.readdirSync(linkPath).length > 0) return "kept-existing-dir";
    fs.rmdirSync(linkPath);
  } else if (existing) {
    fs.unlinkSync(linkPath);
  }
  fs.symlinkSync(relTarget, linkPath, "dir");
  return "linked";
}

/** True when `p` is a real directory (not a link) holding a `.complete` stamp. */
export function isStampedRealDir(p: string): boolean {
  const st = lstatOrNull(p);
  return Boolean(st?.isDirectory()) && fs.existsSync(path.join(p, ".complete"));
}

/** Copy a tree, preserving hardlinks, symlinks, modes and times. */
export function copyTree(src: string, dest: string): void {
  // `cp -a` keeps hardlinks within the copied set; LLVM's `hardlinked/`
  // tree is 579 MB linked against 1.8 GB as independent copies.
  execFileSync("cp", ["-a", src, dest], { stdio: ["ignore", "ignore", "pipe"] });
}

export type PublishStatus = "published" | "already-present";

/**
 * Publish a store entry atomically: `populate` fills a staging directory
 * beside `dest` (same filesystem), which is then renamed into place. The
 * first publisher wins; a concurrent or later one discards its copy, so
 * readers only ever see a complete entry.
 */
export function publishEntry(input: { dest: string; populate: (staging: string) => void }): PublishStatus {
  const { dest } = input;
  if (fs.existsSync(dest)) return "already-present";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    input.populate(staging);
    try {
      fs.renameSync(staging, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EEXIST" || code === "ENOTEMPTY") && fs.existsSync(dest)) return "already-present";
      throw err;
    }
    return "published";
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
