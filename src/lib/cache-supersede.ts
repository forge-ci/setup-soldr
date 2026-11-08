/**
 * Delete superseded generations of a cache family right after a newer one is
 * saved.
 *
 * Why: the Actions cache is a 10 GB pool shared by every family, and the janitor
 * that enforces the repository budget only runs at the end of a merge-queue run.
 * Between those sweeps a family accumulates one entry per Rust/lockfile change,
 * so a single bump of the toolchain or a lockfile edit can momentarily hold two
 * or three complete generations of every cook layer and push the pool over the
 * ceiling, at which point GitHub's LRU evicts whatever it likes - including
 * layers a lane needs on its next run.
 *
 * Deleting the older generation at save time keeps exactly one entry per family
 * without waiting for the janitor, and it is the cheapest possible policy: the
 * save just proved the new key is complete, so the old one is by definition
 * superseded.
 *
 * Safety: only entries whose key shares the saved key's family prefix are
 * touched, never the just-saved key itself, and the whole sweep is best-effort -
 * a failure to delete is logged, never fatal.
 */

import * as github from "@actions/github";

export interface SupersededEntry {
  id: number;
  key: string;
  size_in_bytes: number;
}

export interface SupersedeResult {
  deleted: number;
  failed: number;
  bytes: number;
  reason?: string;
}

/**
 * The family prefix of a base-layer key.
 *
 * `buildCookBaseCacheKey` puts the soldr version last (`cook-base-v3-…-soldrv0.9.45`,
 * see setup-soldr#625) precisely so the version can be dropped; everything before
 * that segment identifies the family (os, arch, libc, rustc release, flags hash,
 * lockfile hash, key suffix).
 */
export function familyPrefixOfBaseKey(key: string): string | null {
  const marker = key.lastIndexOf("-soldrv");
  if (marker <= 0) return null;
  return key.slice(0, marker);
}

export interface SupersedeOptions {
  keepKey: string;
  log: (msg: string) => void;
  owner?: string;
  repo?: string;
  token?: string;
  familyPrefix?: string | null;
  listCachesByPrefix?: (prefix: string) => Promise<SupersededEntry[]>;
  deleteCacheById?: (cacheId: number) => Promise<void>;
}

function truthy(value: string | undefined): boolean {
  return Boolean(value && value.trim() && value.trim() !== "0");
}

/** `NO_CACHE_SUPERSEDE` (any truthy value) turns the sweep off entirely. */
export function supersedeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.NO_CACHE_SUPERSEDE);
}

export async function deleteSupersededFamilyEntries(
  opts: SupersedeOptions,
): Promise<SupersedeResult> {
  if (supersedeDisabled()) {
    return { deleted: 0, failed: 0, bytes: 0, reason: "disabled by NO_CACHE_SUPERSEDE" };
  }
  const prefix = opts.familyPrefix ?? familyPrefixOfBaseKey(opts.keepKey);
  if (!prefix) {
    return { deleted: 0, failed: 0, bytes: 0, reason: "key has no family prefix" };
  }
  const owner = opts.owner ?? process.env.GITHUB_REPOSITORY_OWNER ?? process.env.GITHUB_REPOSITORY?.split("/")[0];
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY?.split("/")[1];
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    return { deleted: 0, failed: 0, bytes: 0, reason: "no repository or token" };
  }

  const octokit = github.getOctokit(token);
  const listCachesByPrefix =
    opts.listCachesByPrefix ??
    (async (familyPrefix: string): Promise<SupersededEntry[]> => {
      const found: SupersededEntry[] = [];
      let page = 1;
      while (true) {
        const response = await octokit.rest.actions.getActionsCacheList({
          owner,
          repo,
          key: familyPrefix,
          per_page: 100,
          page,
        });
        const items = response.data.actions_caches ?? [];
        for (const item of items) {
          if (item.id != null && item.key != null && item.size_in_bytes != null) {
            found.push({ id: item.id, key: item.key, size_in_bytes: item.size_in_bytes });
          }
        }
        if (items.length < 100) break;
        page += 1;
      }
      return found;
    });
  const deleteCacheById =
    opts.deleteCacheById ??
    (async (cacheId: number): Promise<void> => {
      await octokit.rest.actions.deleteActionsCacheById({ owner, repo, cache_id: cacheId });
    });

  let stale: SupersededEntry[];
  try {
    stale = (await listCachesByPrefix(prefix)).filter(
      (entry) => entry.key !== opts.keepKey && entry.key.startsWith(prefix),
    );
  } catch (error) {
    opts.log(
      `cache-supersede: could not list family ${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { deleted: 0, failed: 0, bytes: 0, reason: "list failed" };
  }
  if (stale.length === 0) {
    return { deleted: 0, failed: 0, bytes: 0 };
  }

  let deleted = 0;
  let failed = 0;
  let bytes = 0;
  for (const entry of stale) {
    try {
      await deleteCacheById(entry.id);
      deleted += 1;
      bytes += entry.size_in_bytes;
    } catch (error) {
      failed += 1;
      opts.log(
        `cache-supersede: delete failed id=${entry.id} key=${entry.key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (deleted > 0) {
    opts.log(
      `cache-supersede: deleted ${deleted} superseded ${prefix} entr${deleted === 1 ? "y" : "ies"} (${bytes} bytes) after saving ${opts.keepKey}`,
    );
  }
  return { deleted, failed, bytes };
}
