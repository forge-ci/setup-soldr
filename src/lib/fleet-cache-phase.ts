/**
 * The fleet-cache lifecycle: restore before the build, publish after it.
 *
 * `fleet-cache.ts` speaks the protocol; this module is what a caller in the
 * action actually invokes, and it owns the two decisions that must not be
 * duplicated per callsite:
 *
 * - **Layer format.** A layer is the same archive the Actions cache tier already
 *   produces (`tar -cf - -C <parent> <basename>` + zstd), so restoring it reuses
 *   `decompressCache` and there is no second archive path to keep correct — the
 *   double-nesting bug that made zccache report "0 hits despite restored
 *   artifacts" lives in exactly that code and is already fixed there.
 * - **Never fail a build.** Everything here resolves to a value; the caller gets
 *   a miss or a `published: false` with a reason and carries on.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { compressCache, decompressCache } from "./cache-compress.js";
import {
  FleetSession,
  type FleetConfig,
  type FleetPublish,
  type FleetRestore,
  type FetchLike,
} from "./fleet-cache.js";

export interface FleetPhaseOptions {
  config: FleetConfig;
  /** `owner/name`, as github.repository provides it. */
  repository: string;
  /** Derived once by the caller (see `deriveIdentity`) and reused for publish. */
  identity: string;
  /** The directory a build uses as its compiler-cache store. */
  cacheDir: string;
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
  /** Compression settings for the publish, matching the build-cache layer. */
  codec?: "auto" | "zstd" | "none";
  level?: string;
}

export interface FleetRestored {
  restore: FleetRestore;
  session: FleetSession | null;
  /** Layers actually applied to `cacheDir`. */
  applied: number;
  failure?: string;
}

const defaultLog = (message: string): void => console.log(message);

/**
 * Open a session and apply the newest compatible chain to `cacheDir`.
 *
 * Layers are applied in order (base first). A layer that cannot be downloaded or
 * decompressed aborts the restore and reports a miss: half-applied deltas would
 * corrupt the tree, which is worse than a cold build.
 */
export async function restoreFleetCache(opts: FleetPhaseOptions): Promise<FleetRestored> {
  const log = opts.log ?? defaultLog;
  const session = await FleetSession.open(opts.config, {
    repository: opts.repository,
    identity: opts.identity,
    fetchImpl: opts.fetchImpl,
  });
  if (session === null) {
    return {
      session: null,
      applied: 0,
      restore: {
        hit: false,
        reason: "fleet cache unavailable; continuing cold",
        layers: [],
        identity: opts.identity,
        degraded: true,
      },
    };
  }

  const decision = await session.restore();
  if (!decision.hit) {
    log(`fleet-cache: miss (${decision.reason})`);
    return { session, restore: decision, applied: 0 };
  }

  const parent = path.dirname(opts.cacheDir);
  fs.mkdirSync(parent, { recursive: true });
  let applied = 0;
  for (const layer of decision.layers) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-layer-"));
    const archive = path.join(staging, `${layer.seq}.tar.zst`);
    try {
      const bytes = await session.download(layer.digest);
      fs.writeFileSync(archive, bytes);
      await decompressCache({ archivePath: archive, targetDir: opts.cacheDir, log });
      applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`fleet-cache: layer s${String(layer.seq).padStart(6, "0")} failed to apply: ${message}`);
      return {
        session,
        applied: 0,
        failure: message,
        restore: {
          hit: false,
          reason: `layer s${String(layer.seq).padStart(6, "0")} could not be applied: ${message}`,
          layers: [],
          identity: opts.identity,
          degraded: true,
        },
      };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  log(`fleet-cache: hit — applied ${applied} layer(s) for ${opts.identity}`);
  return { session, restore: decision, applied };
}

/**
 * Compress `cacheDir` and publish it in the session, then seal the session.
 *
 * The session is closed either way: an unclosed session is a record nobody can
 * replay. Publishing after a failed build is the caller's decision — the post
 * step already gates that with `job-status`.
 */
export async function publishFleetCache(
  opts: FleetPhaseOptions & { session: FleetSession | null; outcome?: "closed" | "failed" },
): Promise<FleetPublish> {
  const log = opts.log ?? defaultLog;
  if (opts.session === null) {
    return { published: false, reason: "no fleet session; nothing to publish" };
  }
  const outcome = opts.outcome ?? "closed";
  try {
    if (!fs.existsSync(opts.cacheDir)) {
      await opts.session.close(outcome, "cache dir missing");
      return { published: false, reason: `cache dir ${opts.cacheDir} does not exist` };
    }
    const parent = path.dirname(opts.cacheDir);
    fs.mkdirSync(parent, { recursive: true });
    const before = new Set(fs.readdirSync(parent));
    await compressCache({
      cacheDir: opts.cacheDir,
      codec: opts.codec ?? "auto",
      level: opts.level ?? "3",
      log,
      label: "fleet-cache",
    });
    // compressCache leaves one archive in the parent; find it rather than rely on
    // its return shape, which has changed more than once.
    const archive = fs
      .readdirSync(parent)
      .find((name) => !before.has(name) && /\.tar\.(zst|gz)$/.test(name));
    if (!archive) {
      await opts.session.close(outcome, "no archive produced");
      return { published: false, reason: "compressCache produced no archive" };
    }
    const archivePath = path.join(parent, archive);
    let result: FleetPublish;
    try {
      result = await opts.session.publish(fs.readFileSync(archivePath));
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
    await opts.session.close(outcome, result.reason);
    log(`fleet-cache: ${result.reason}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await opts.session.close("failed", message);
    return { published: false, reason: message };
  }
}
