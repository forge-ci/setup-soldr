// Poisoned solo-toolchain entries (talos-hq/clud#2342).
//
// A key promised `rustc1.95.0` while its archive shipped 1.98.0-nightly.
// Restore detected it, but deletion needs `actions: write` and there was no
// fallback, so every job failed. This module holds the pure decisions:
// validate before save, cold-install after a failed repair, and the one
// diagnostic for an entry the token cannot delete.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { DeleteCorruptSoloCacheResult } from "./solo-toolchain-cache.js";

/** Release segment of a solo key: `...-rustc<release>-c<hash>-t<hash>-soldr...`. */
export function releaseFromSoloKey(key: string): string | null {
  const match = key.match(/-rustc(.+?)-c[^-]*-t[^-]*-soldr/);
  return match ? (match[1] ?? null) : null;
}

export interface RustcVersionInfo {
  release: string;
  commitHash: string | null;
}

/** Parse `rustc --version --verbose` (or plain `--version`) output. */
export function parseRustcVersionVerbose(stdout: string): RustcVersionInfo | null {
  const text = stdout.trim();
  const release = text.match(/^release:\s*(\S+)/m)?.[1] ?? text.match(/^rustc\s+(\S+)/)?.[1];
  if (!release) return null;
  return { release, commitHash: text.match(/^commit-hash:\s*(\S+)/m)?.[1] ?? null };
}

export type RustcProbe = () => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Confirm the live toolchain matches the release named in `key` before it is
 * archived under that key. Any failure to prove a match refuses the save.
 */
export async function toolchainMatchesKey(opts: {
  key: string;
  probe: RustcProbe;
  log: (msg: string) => void;
}): Promise<boolean> {
  const expected = releaseFromSoloKey(opts.key);
  let observed: RustcVersionInfo | null = null;
  let detail = "";
  try {
    const out = await opts.probe();
    if (out.code === 0) observed = parseRustcVersionVerbose(out.stdout);
    else detail = ` exit=${out.code} ${out.stderr.trim()}`.trimEnd();
  } catch (err) {
    detail = ` error=${err instanceof Error ? err.message : String(err)}`;
  }
  const match = expected !== null && observed !== null && observed.release === expected;
  const summary =
    `key=${opts.key} expected=${expected ?? "unparseable"} observed=${observed?.release ?? "unknown"} ` +
    `commit=${observed?.commitHash ?? "unknown"} match=${match}${detail}`;
  opts.log(match
    ? `solo-toolchain-cache: pre-save verify ${summary}`
    : `solo-toolchain-cache: refusing save; toolchain does not match its key (#2342): ${summary}`);
  return match;
}

export interface PoisonRecoveryPlan {
  /** True only when the poisoned key is gone and a replacement can be saved. */
  publishReplacement: boolean;
  /** Never true: the job already cold-installed a verified toolchain. */
  failJob: false;
  /** One diagnostic for the undeletable case; null otherwise. */
  message: string | null;
}

export function planPoisonedEntryRecovery(opts: {
  key: string;
  deletion: DeleteCorruptSoloCacheResult;
}): PoisonRecoveryPlan {
  const { found, deleted, failed } = opts.deletion;
  if (failed === 0 && deleted === found) return { publishReplacement: true, failJob: false, message: null };
  return {
    publishReplacement: false,
    failJob: false,
    message:
      `solo-toolchain-cache: poisoned cache entry key=${opts.key} cannot be deleted: the workflow token lacks ` +
      `the actions: write permission (found=${found} deleted=${deleted} failed=${failed}). This job used a ` +
      `fresh toolchain install instead; grant actions: write or delete that exact key to stop the repeat restore.`,
  };
}

/**
 * Discard every restored copy of `channel` under `$RUSTUP_HOME`, reinstall it
 * from scratch and re-verify. Throws only if the fresh install is also wrong.
 */
export async function coldInstallAfterFailedRepair(opts: {
  rustupHome: string;
  channel: string;
  key: string;
  warn: (msg: string) => void;
  reinstall: () => Promise<void>;
  verify: () => Promise<{ match: boolean; observedRelease: string | null }>;
}): Promise<void> {
  const { rustupHome, channel, key } = opts;
  opts.warn(
    `solo-toolchain-cache: restored entry key=${key} is still invalid after repair; discarding the cached ` +
      `toolchain and falling back to a cold install of ${channel} (#2342).`,
  );
  const owned = (name: string) => name === channel || name.startsWith(`${channel}-`);
  for (const sub of ["toolchains", "update-hashes"]) {
    const dir = path.join(rustupHome, sub);
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter(owned)) {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
  await opts.reinstall();
  const verified = await opts.verify();
  if (!verified.match) {
    throw new Error(
      `solo-toolchain-cache: cold install of ${channel} did not produce the requested toolchain ` +
        `(observed=${verified.observedRelease ?? "unknown"}); key=${key}`,
    );
  }
}

/**
 * #634: the rustc binary inside the toolchain directory that will be archived.
 * Probing it directly needs no rustup on PATH and checks exactly what is saved.
 * Returns null when no toolchain dir for `channel` holds a rustc.
 */
export async function resolveArchivedRustc(opts: {
  rustupHome: string;
  channel: string;
  /** Executable suffix: ".exe" on Windows, "" elsewhere. */
  exe: string;
}): Promise<{ command: string; args: string[] } | null> {
  const dir = path.join(opts.rustupHome, "toolchains");
  const names = (await fsp.readdir(dir).catch(() => [] as string[]))
    .filter((name) => name === opts.channel || name.startsWith(`${opts.channel}-`))
    .sort();
  for (const name of names) {
    const rustc = path.join(dir, name, "bin", `rustc${opts.exe}`);
    if (await fsp.access(rustc).then(() => true, () => false)) {
      return { command: rustc, args: ["--version", "--verbose"] };
    }
  }
  return null;
}

/**
 * #633: marker entry recording that `key` is poisoned but could not be
 * deleted. Its prefix differs from every solo-toolchain restore key, so a
 * prefix match can never hand it back as a toolchain.
 */
export function soloTombstoneKey(key: string): string {
  return `solo-tombstone-v1-${key}`;
}

/** Canonical path for the tombstone marker; save and lookup must agree (#316). */
export function soloTombstonePath(runnerTemp: string): string {
  return path.join(runnerTemp, "setup-soldr-solo-tombstone");
}

/**
 * #633: once the exact key is tombstoned, restore and save the repaired key
 * only. Fallbacks are dropped because they prefix-match the poisoned entry.
 */
export function planSoloRestoreKeys<T extends { exact: string; fallbacks: string[] }>(opts: {
  keys: T;
  tombstoned: boolean;
}): { exact: string; fallbacks: string[] } {
  if (!opts.tombstoned) return opts.keys;
  return { exact: `${opts.keys.exact}-repaired`, fallbacks: [] };
}
