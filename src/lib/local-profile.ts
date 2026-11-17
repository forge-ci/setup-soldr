/**
 * Runner-aware cache profile (zackees/ci.yml#227, zackees/clud#1740).
 *
 * A GitHub-hosted runner has a 10 GB, ref-scoped Actions-cache budget and a
 * fast network, so small payloads and high zstd levels pay off there. A local
 * runner (act / act2, e.g. under bosn) has no budget, a slow refetch over the
 * developer's network and a fast disk, so it wants larger payloads and fast,
 * low compression.
 *
 * Fleet policy ("Two signals, two jobs"): `RUNNER_ENVIRONMENT` stays
 * `github-hosted` under act2 for parity, and `ACT=true` is THE local-runner
 * signal. Actions read `ACT` themselves; workflows must not. The same signal
 * drives the save policy (`save-policy.ts`, setup-soldr#537).
 *
 * The profile only supplies DEFAULTS. Each profile input's `action.yml`
 * default is `""`, so an empty value means "not set" and resolves here; an
 * explicit input always wins on both runner kinds. GitHub defaults are the
 * values the action used before this module existed, so GitHub behaviour is
 * byte-identical. Archives compressed at any level restore the same way, and
 * every `--long` window is kept, so a local runner can still restore an
 * archive written on GitHub and vice versa.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** True on a local runner: act and act2 always export `ACT=true`. */
export function isLocalRunner(env: Record<string, string | undefined>): boolean {
  return TRUTHY.has((env["ACT"] ?? "").trim().toLowerCase());
}

/** Action inputs whose `action.yml` default is `""` and resolves per profile. */
export type CacheProfileInputKnob =
  | "cache-payload-max-bytes"
  | "cache-payload-warn-bytes"
  | "target-cache-compress-level"
  | "solo-toolchain-cache-level";

/** Internal zstd levels that used to be hard-coded at their call sites. */
export type CacheProfileFixedKnob =
  | "cook-base-zstd-level"
  | "cook-delta-zstd-level"
  | "soldr-mini-zstd-level"
  | "cargo-registry-extras-zstd-level";

export type CacheProfileKnob = CacheProfileInputKnob | CacheProfileFixedKnob;

const GITHUB_DEFAULTS: Readonly<Record<CacheProfileKnob, string>> = {
  "cache-payload-max-bytes": "6GiB",
  "cache-payload-warn-bytes": "512MiB",
  "target-cache-compress-level": "3",
  "solo-toolchain-cache-level": "9",
  "cook-base-zstd-level": "9",
  "cook-delta-zstd-level": "3",
  "soldr-mini-zstd-level": "19",
  "cargo-registry-extras-zstd-level": "3",
};

// "0" means no payload cap (`parseByteCount` treats 0 as disabled). The
// notice threshold stays on so a multi-GiB payload is still visible.
const LOCAL_DEFAULTS: Readonly<Record<CacheProfileKnob, string>> = {
  "cache-payload-max-bytes": "0",
  "cache-payload-warn-bytes": "4GiB",
  "target-cache-compress-level": "1",
  "solo-toolchain-cache-level": "1",
  "cook-base-zstd-level": "1",
  "cook-delta-zstd-level": "1",
  "soldr-mini-zstd-level": "1",
  "cargo-registry-extras-zstd-level": "1",
};

export const CACHE_PROFILE_KNOBS = Object.keys(GITHUB_DEFAULTS) as CacheProfileKnob[];

/**
 * Set by the main step when the `zstd-level` input resolved a level
 * (`zstd-level.ts`); it replaces every zstd default below.
 */
export const ZSTD_RESOLVED_ENV = "SETUP_SOLDR_ZSTD_LEVEL_RESOLVED";

const ZSTD_KNOBS: ReadonlySet<CacheProfileKnob> = new Set([
  "target-cache-compress-level",
  "solo-toolchain-cache-level",
  "cook-base-zstd-level",
  "cook-delta-zstd-level",
  "soldr-mini-zstd-level",
  "cargo-registry-extras-zstd-level",
]);

/**
 * The profile default for `knob` on a GitHub (`local=false`) or local
 * runner, or the resolved `zstd-level` for a zstd knob when one is set.
 */
export function cacheProfileDefault(
  knob: CacheProfileKnob,
  local: boolean,
  env: Record<string, string | undefined> = process.env,
): string {
  if (ZSTD_KNOBS.has(knob)) {
    const resolved = (env[ZSTD_RESOLVED_ENV] ?? "").trim();
    if (/^\d{1,2}$/.test(resolved) && Number(resolved) >= 1 && Number(resolved) <= 19) return resolved;
  }
  return (local ? LOCAL_DEFAULTS : GITHUB_DEFAULTS)[knob];
}

/** Effective value: the trimmed explicit input, else the profile default. */
export function resolveCacheProfileInput(
  knob: CacheProfileInputKnob,
  raw: string | undefined,
  local: boolean,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = (raw ?? "").trim();
  return value || cacheProfileDefault(knob, local, env);
}

export interface CacheProfileSummary {
  payloadMaxBytes: string;
  zstdLevels: Record<string, string>;
}

function isNoCap(value: string): boolean {
  const v = value.trim();
  return v === "" || /^0+(\.0+)?\s*([kmgt]?i?b?)?$/i.test(v);
}

/**
 * The one log line the main step prints so users can see which profile
 * applied, e.g. `setup-soldr: local runner (ACT) cache profile: no payload
 * cap, zstd -1`. It reports EFFECTIVE values, so explicit inputs show up.
 */
export function describeCacheProfile(local: boolean, summary: CacheProfileSummary): string {
  const label = local ? "local runner (ACT)" : "GitHub-hosted";
  const cap = isNoCap(summary.payloadMaxBytes) ? "no payload cap" : `payload cap ${summary.payloadMaxBytes.trim()}`;
  const entries = Object.entries(summary.zstdLevels);
  const distinct = new Set(entries.map(([, level]) => level));
  const zstd = distinct.size === 1
    ? `zstd -${entries[0]?.[1] ?? ""}`
    : `zstd ${entries.map(([name, level]) => `${name} -${level}`).join(", ")}`;
  return `setup-soldr: ${label} cache profile: ${cap}, ${zstd}`;
}
