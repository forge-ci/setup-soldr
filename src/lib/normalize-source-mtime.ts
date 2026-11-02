// Source mtime normalizer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/normalize_source_mtime.py.
// Rewrites the mtime of tracked Rust build-input files to each file's
// last-commit timestamp so cargo fingerprints stay stable across fresh
// checkouts of the same SHA.

import * as fs from "node:fs";
import * as path from "node:path";
import * as exec from "@actions/exec";
import { createLogger } from "./log-utils.js";


// Globs evaluated against the repo-relative POSIX path of each tracked file.
const INCLUDE_GLOBS: readonly string[] = [
  "*.rs",
  "**/*.rs",
  "Cargo.toml",
  "**/Cargo.toml",
  "Cargo.lock",
  "**/Cargo.lock",
  "build.rs",
  "**/build.rs",
  "rust-toolchain",
  "rust-toolchain.toml",
];

const EXCLUDE_PREFIXES: readonly string[] = ["target/", ".git/", "node_modules/"];

function fnmatchToRegex(pattern: string): RegExp {
  // Translate a shell-style glob to a regex. Supports `*`, `**`, `?` and
  // character classes the way Python's fnmatch.fnmatchcase does.
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] ?? "";
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        out += "\\[";
        i++;
      } else {
        out += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if (/[.+^$|(){}\\]/.test(c)) {
      out += `\\${c}`;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

const INCLUDE_REGEXES: readonly RegExp[] = INCLUDE_GLOBS.map(fnmatchToRegex);

function isExcluded(relativePosix: string): boolean {
  for (const prefix of EXCLUDE_PREFIXES) {
    const noTrail = prefix.replace(/\/$/, "");
    if (relativePosix === noTrail || relativePosix.startsWith(prefix)) {
      return true;
    }
    if (`/${relativePosix}`.includes(`/${prefix}`)) {
      return true;
    }
  }
  return false;
}

function matchesInclude(relativePosix: string): boolean {
  const basename = relativePosix.split("/").pop() ?? "";
  for (const re of INCLUDE_REGEXES) {
    if (re.test(relativePosix) || re.test(basename)) return true;
  }
  return false;
}

export function selectCandidateFiles(tracked: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of tracked) {
    const relativePosix = entry.replace(/\\/g, "/");
    if (isExcluded(relativePosix)) continue;
    if (!matchesInclude(relativePosix)) continue;
    out.push(relativePosix);
  }
  return out;
}

async function captureGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await exec.exec("git", args, {
    cwd,
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
  });
  return { code, stdout, stderr };
}

export async function isGitRepo(workspace: string): Promise<boolean> {
  try {
    const r = await captureGit(["-C", workspace, "rev-parse", "--is-inside-work-tree"], workspace);
    return r.code === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function listTrackedFiles(workspace: string): Promise<string[]> {
  // We use newline (default) instead of -z because @actions/exec gives us text;
  // GitHub Actions paths shouldn't contain NULs.
  const r = await captureGit(["-C", workspace, "ls-files"], workspace);
  if (r.code !== 0) {
    throw new Error(`git ls-files failed (code=${r.code}): ${r.stderr.trim()}`);
  }
  return r.stdout.split(/\r?\n/).filter((s) => s.length > 0);
}

async function lastCommitTimestamp(workspace: string, relativePosix: string): Promise<number | null> {
  const r = await captureGit(
    ["-C", workspace, "log", "-1", "--format=%ct", "--", relativePosix],
    workspace,
  );
  if (r.code !== 0) return null;
  const value = r.stdout.trim();
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

/**
 * Touch eligible tracked files to their last-commit timestamp.
 */
export async function normalizeWorkspace(workspace: string): Promise<{ normalized: number; skipped: number }> {
  const tracked = await listTrackedFiles(workspace);
  const candidates = selectCandidateFiles(tracked);
  let normalized = 0;
  let skipped = 0;
  for (const relativePosix of candidates) {
    const absolute = path.join(workspace, ...relativePosix.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ts = await lastCommitTimestamp(workspace, relativePosix);
    if (ts === null) {
      skipped += 1;
      continue;
    }
    try {
      fs.utimesSync(absolute, ts, ts);
    } catch {
      skipped += 1;
      continue;
    }
    normalized += 1;
  }
  return { normalized, skipped };
}

export async function normalizeSourceMtime(opts: {
  workspace: string;
  enabled: boolean;
}): Promise<void> {
  const logger = createLogger(process.env);
  if (!opts.enabled) {
    logger.log("source-mtime-normalize: skipped (input not enabled)");
    return;
  }
  const workspace = opts.workspace;
  if (!workspace) {
    logger.log("source-mtime-normalize: skipped (workspace not set)");
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspace);
  } catch {
    logger.log(`source-mtime-normalize: skipped (workspace ${workspace} is not a directory)`);
    return;
  }
  if (!stat.isDirectory()) {
    logger.log(`source-mtime-normalize: skipped (workspace ${workspace} is not a directory)`);
    return;
  }
  if (!(await isGitRepo(workspace))) {
    logger.log(`source-mtime-normalize: skipped (${workspace} is not a git work tree)`);
    return;
  }
  const start = Date.now();
  let normalized = 0;
  let skipped = 0;
  try {
    const r = await normalizeWorkspace(workspace);
    normalized = r.normalized;
    skipped = r.skipped;
  } catch (err) {
    logger.log(
      `source-mtime-normalize: git invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  const elapsedMs = Date.now() - start;
  logger.log(
    `source-mtime-normalize: normalized=${normalized} skipped=${skipped} workspace=${workspace} elapsed_ms=${elapsedMs}`,
  );
}

// Re-export internals for testing.
export const _internal = {
  fnmatchToRegex,
  isExcluded,
  matchesInclude,
};
