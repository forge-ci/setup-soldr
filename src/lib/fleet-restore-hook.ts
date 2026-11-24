/**
 * The main-step half of the fleet tier, extracted so its decisions are testable.
 *
 * `main.ts` is an entry point that installs toolchains, so nothing can drive it
 * through a cache restore in a test. The rules that decide *whether* the fleet
 * tier runs, and what it hands back to the restore flow, live here instead — and
 * `__tests__/fleet-restore-hook.test.ts` drives them against a fake service.
 *
 * Three rules, each with a reason:
 *
 * 1. **Tiers do not fight.** The fleet tier is skipped when the S3 tier is
 *    configured or the job runs on a persistent root: both of those already own
 *    the build-cache directory, and applying two sources to one tree produces a
 *    mix that is neither.
 * 2. **A hit is expressed in the caller's own vocabulary.** The restore flow
 *    classifies hits by `matchedKey`, so a fleet hit returns
 *    `fleet:<identity>` and the caller skips the archive and decompress steps it
 *    would otherwise run against a file that does not exist.
 * 3. **The session travels.** Post publishes what main restored, so the session
 *    id and key are serialised here for `core.saveState`.
 */
import {
  FleetSession,
  type FleetConfig,
  type FleetRestore,
  type FetchLike,
} from "./fleet-cache.js";
import { restoreFleetCache } from "./fleet-cache-phase.js";

/** The marker the restore flow uses to recognise a fleet hit. */
export const FLEET_KEY_PREFIX = "fleet:";

export interface FleetHookState {
  id: string;
  identity: string;
  repo: string;
  family: string;
  platform: string;
}

export interface FleetHookOptions {
  config: FleetConfig | null;
  repository: string;
  identity: string;
  cacheDir: string;
  /** A persistent root seeds itself; the fleet tier stays out of its way (#691). */
  persistentRoot?: string | null;
  /** The S3 tier owns the build directory when configured. */
  s3Configured?: boolean;
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
}

export interface FleetHookResult {
  attempted: boolean;
  hit: boolean;
  applied: number;
  /** `fleet:<identity>` on a hit, empty otherwise. */
  matchedKey: string;
  reason: string;
  degraded: boolean;
  /** JSON for `core.saveState("fleetCache", ...)`, or null when no session exists. */
  state: string | null;
  restore: FleetRestore | null;
}

const defaultLog = (message: string): void => console.log(message);

export async function runFleetRestore(opts: FleetHookOptions): Promise<FleetHookResult> {
  const log = opts.log ?? defaultLog;
  const skipped = (reason: string): FleetHookResult => ({
    attempted: false,
    hit: false,
    applied: 0,
    matchedKey: "",
    reason,
    degraded: false,
    state: null,
    restore: null,
  });

  if (opts.config === null) return skipped("fleet tier is off");
  if (opts.persistentRoot) return skipped(`persistent root ${opts.persistentRoot} owns the cache`);
  if (opts.s3Configured) return skipped("the S3 tier owns the build cache");
  if (!opts.repository.includes("/")) return skipped(`no repository (got ${JSON.stringify(opts.repository)})`);

  const result = await restoreFleetCache({
    config: opts.config,
    repository: opts.repository,
    identity: opts.identity,
    cacheDir: opts.cacheDir,
    fetchImpl: opts.fetchImpl,
    log,
  });

  const state: FleetHookState | null = result.session === null
    ? null
    : {
      id: result.session.sessionId,
      identity: opts.identity,
      repo: result.session.key.repo,
      family: result.session.key.family,
      platform: result.session.key.platform,
    };

  return {
    attempted: true,
    hit: result.restore.hit,
    applied: result.applied,
    matchedKey: result.restore.hit ? `${FLEET_KEY_PREFIX}${opts.identity}` : "",
    reason: result.restore.reason,
    degraded: result.restore.degraded,
    state: state === null ? null : JSON.stringify(state),
    restore: result.restore,
  };
}

/** True when `matchedKey` marks a hit the fleet tier produced. */
export function isFleetHit(matchedKey: string): boolean {
  return matchedKey.startsWith(FLEET_KEY_PREFIX);
}

/** The session a later step (post) should publish into, if main opened one. */
export function attachFromState(config: FleetConfig, raw: string): FleetSession | null {
  try {
    const state = JSON.parse(raw) as FleetHookState;
    if (!state.id || !state.identity || !state.repo || !state.family || !state.platform) {
      return null;
    }
    return FleetSession.attach(config, {
      id: state.id,
      identity: state.identity,
      key: { repo: state.repo, family: state.family, platform: state.platform },
    });
  } catch {
    return null;
  }
}

export type { FleetConfig } from "./fleet-cache.js";
