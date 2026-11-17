/**
 * Runner-aware zstd level (`zstd-level` input).
 *
 * A self-hosted runner (the Dell E640, act/act2 under bosn) has fast local
 * disks and no cache budget, so every archive written there should compress
 * fast, not small. A hosted runner keeps each layer's existing level (its
 * uploads are budget- and network-bound).
 *
 * Precedence: an explicit `zstd-level` input, then `SETUP_SOLDR_ZSTD_LEVEL`
 * already set in the job, then a pre-set `ZSTD_CLEVEL`, then `auto`. A value
 * that is not an integer in 1..19 (the range the zstd CLI's ZSTD_CLEVEL
 * accepts) is ignored with a note and the next source applies.
 *
 * A resolved level is exported for later steps: `ZSTD_CLEVEL` and
 * `ZSTD_NBTHREADS=0`, which the zstd CLI honours natively (so `tar --zstd`
 * picks them up), `SOLDR_ZSTD_LEVEL` for soldr's archive writers, and
 * `SETUP_SOLDR_ZSTD_LEVEL_RESOLVED`, which replaces every zstd default of
 * the cache profile (`local-profile.ts`) in this action's main and post
 * steps. An explicit per-layer level input still wins over it.
 */
import { isLocalRunner, ZSTD_RESOLVED_ENV } from "./local-profile.js";

export { ZSTD_RESOLVED_ENV };

export type ZstdLevelSource = "input" | "SETUP_SOLDR_ZSTD_LEVEL" | "ZSTD_CLEVEL" | "auto";

export interface ZstdLevelResolution {
  /** null: no override; each layer keeps its profile default. */
  level: number | null;
  source: ZstdLevelSource;
  reason: string;
  /** Notes about values that were set but invalid. */
  ignored: string[];
}

/** The fast level auto picks on self-hosted runners. */
export const ZSTD_SELF_HOSTED_LEVEL = 1;
const PERSISTENT_ROOT_ENV = "SETUP_SOLDR_PERSISTENT_ROOT";

/** Self-hosted, a persistent root, or a local act runner. */
export function isSelfHostedRunner(env: Record<string, string | undefined>): boolean {
  if ((env["RUNNER_ENVIRONMENT"] ?? "").trim().toLowerCase() === "self-hosted") return true;
  if ((env[PERSISTENT_ROOT_ENV] ?? "").trim()) return true;
  return isLocalRunner(env);
}

function parseLevel(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 19 ? n : null;
}

export function resolveZstdLevel(
  input: string | undefined,
  env: Record<string, string | undefined>,
): ZstdLevelResolution {
  const ignored: string[] = [];
  const candidates: Array<[Exclude<ZstdLevelSource, "auto">, string]> = [
    ["input", (input ?? "").trim()],
    ["SETUP_SOLDR_ZSTD_LEVEL", (env["SETUP_SOLDR_ZSTD_LEVEL"] ?? "").trim()],
    ["ZSTD_CLEVEL", (env["ZSTD_CLEVEL"] ?? "").trim()],
  ];
  for (const [source, raw] of candidates) {
    if (!raw || (source === "input" && raw.toLowerCase() === "auto")) continue;
    const level = parseLevel(raw);
    if (level === null) {
      ignored.push(`${source}=${JSON.stringify(raw)} is not an integer 1..19; ignored`);
      continue;
    }
    return { level, source, reason: `${source}=${level}`, ignored };
  }
  if (isSelfHostedRunner(env)) {
    return {
      level: ZSTD_SELF_HOSTED_LEVEL,
      source: "auto",
      reason: `auto: self-hosted runner (fast local disk), level ${ZSTD_SELF_HOSTED_LEVEL}`,
      ignored,
    };
  }
  return { level: null, source: "auto", reason: "auto: GitHub-hosted runner, per-layer defaults", ignored };
}

/** Environment to export for later steps; empty when nothing was resolved. */
export function zstdLevelExports(r: ZstdLevelResolution): Record<string, string> {
  if (r.level === null) return {};
  const level = String(r.level);
  return { ZSTD_CLEVEL: level, ZSTD_NBTHREADS: "0", SOLDR_ZSTD_LEVEL: level, [ZSTD_RESOLVED_ENV]: level };
}

/** The level main resolved and exported, or null (read by the cache profile). */
export function resolvedZstdLevel(env: Record<string, string | undefined>): string | null {
  const raw = (env[ZSTD_RESOLVED_ENV] ?? "").trim();
  return raw && parseLevel(raw) !== null ? raw : null;
}
