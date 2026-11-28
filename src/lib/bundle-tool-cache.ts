// setup-soldr#557: keep soldr's stamped tool bundles in RUNNER_TOOL_CACHE.
//
// soldr installs managed tool bundles as `$SOLDR_CACHE_DIR/bin/<name>/` with
// a `.complete` stamp written last (LLVM `llvm-<v>`, zig, xwin, ...). The
// LLVM one is fetched by the first `soldr cargo` call -- setup-soldr's own
// verify step -- so under act every warm job spent 9-10 s re-fetching it.
//
// Unlike syslib (#553), soldr extracts these bundles in place with no lock,
// so the store is never written through: the main step links stamped store
// entries into `bin/`, and the post step publishes bundles this job
// installed, copying each into a staging dir in the store and renaming it
// into place. Readers only ever see whole entries.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  copyTree,
  decideToolCacheStore,
  isStampedRealDir,
  linkDir,
  publishEntry,
  toolCacheStorePath,
  type StoreLogger,
  type ToolCacheDecision,
} from "./tool-cache-store.js";

/** syslib is a store of its own (#553), linked wholesale. */
const NOT_A_BUNDLE = new Set(["syslib"]);

export interface BundleToolCacheDecision extends ToolCacheDecision {
  store: string;
}

export function decideBundleToolCache(input: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  crossPrepareTarget: string;
}): BundleToolCacheDecision {
  const decision = decideToolCacheStore({
    env: input.env,
    platform: input.platform,
    // The cross-targets prepare archive carries `bin/` for that lane, and
    // soldr's restore refuses to unpack through a link leaving its root.
    layerOff: input.crossPrepareTarget.trim() ? "cross-targets prepare cache already persists this lane's bin" : "",
  });
  const store = decision.toolCache
    ? toolCacheStorePath(decision.toolCache, "bundles", input.platform, input.arch)
    : "";
  return { ...decision, store };
}

function stampedEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !NOT_A_BUNDLE.has(name) && !name.includes(".tmp-"))
    .filter((name) => isStampedRealDir(path.join(dir, name)))
    .sort();
}

/**
 * Link every stamped store entry into `soldrBinDir`, so soldr finds the
 * install and skips its fetch. Any link whose target is gone (a pruned tool
 * cache, or an absolute link into a store path that has since moved, #713)
 * is dropped, so soldr fetches afresh or the entry is re-linked.
 */
export function adoptBundles(input: { soldrBinDir: string; store: string }): {
  linked: string[];
  kept: string[];
  dropped: string[];
} {
  const { soldrBinDir, store } = input;
  const linked: string[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  fs.mkdirSync(soldrBinDir, { recursive: true });
  for (const name of fs.readdirSync(soldrBinDir).sort()) {
    const p = path.join(soldrBinDir, name);
    if (!fs.lstatSync(p).isSymbolicLink()) continue;
    if (!fs.existsSync(p)) {
      fs.unlinkSync(p);
      dropped.push(name);
    }
  }
  for (const name of stampedEntries(store)) {
    const status = linkDir({ linkPath: path.join(soldrBinDir, name), target: path.join(store, name) });
    if (status === "linked") linked.push(name);
    else if (status === "kept-existing-dir") kept.push(name);
  }
  return { linked, kept, dropped };
}

/** Publish every stamped bundle this job installed (real dirs, not links). */
export function publishBundles(input: { soldrBinDir: string; store: string }): {
  published: string[];
  present: string[];
} {
  const published: string[] = [];
  const present: string[] = [];
  for (const name of stampedEntries(input.soldrBinDir)) {
    const src = path.join(input.soldrBinDir, name);
    const status = publishEntry({ dest: path.join(input.store, name), populate: (staging) => copyTree(src, staging) });
    (status === "published" ? published : present).push(name);
  }
  return { published, present };
}

interface BundleStepInput {
  env: Record<string, string | undefined>;
  soldrBinDir: string;
  crossPrepareTarget: string;
  logger: StoreLogger;
}

function decideForStep(input: BundleStepInput): BundleToolCacheDecision {
  return decideBundleToolCache({
    env: input.env,
    platform: process.platform,
    arch: process.arch,
    crossPrepareTarget: input.crossPrepareTarget,
  });
}

/** Main step: link stored bundles into `bin/` before any soldr spawn. Best-effort. */
export function adoptBundleToolCache(input: BundleStepInput): BundleToolCacheDecision {
  const decision = decideForStep(input);
  if (!decision.enabled) {
    input.logger.debug(`bundle-tool-cache: off (${decision.reason})`);
    return decision;
  }
  try {
    const r = adoptBundles({ soldrBinDir: input.soldrBinDir, store: decision.store });
    input.logger.log(
      `bundle-tool-cache: store=${decision.store} linked=[${r.linked.join(",")}] kept=[${r.kept.join(",")}] ` +
        `dropped=[${r.dropped.join(",")}] (${decision.reason})`,
    );
  } catch (err) {
    // Without the links soldr fetches into RUNNER_TEMP as before.
    input.logger.warn(`bundle-tool-cache: could not adopt ${decision.store}: ${(err as Error).message}`);
  }
  return decision;
}

/** Post step: publish the bundles this job installed. Best-effort. */
export function publishBundleToolCache(input: BundleStepInput): void {
  const decision = decideForStep(input);
  if (!decision.enabled) return;
  const t0 = Date.now();
  try {
    const r = publishBundles({ soldrBinDir: input.soldrBinDir, store: decision.store });
    if (r.published.length > 0 || r.present.length > 0) {
      input.logger.log(
        `bundle-tool-cache: published=[${r.published.join(",")}] already-present=[${r.present.join(",")}] ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }
  } catch (err) {
    input.logger.warn(`bundle-tool-cache: could not publish to ${decision.store}: ${(err as Error).message}`);
  }
}
