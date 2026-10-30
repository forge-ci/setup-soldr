import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildCookBaseCacheKey,
  buildCookBaseCacheRestorePrefix,
  buildCookCacheKey,
  buildCookDeltaCacheKey,
  buildCookDeltaCacheRestorePrefix,
  canonicalizeCookFlags,
  decideCookGate,
  hashCookBuildShape,
  hashCookFlags,
  parseCookFlags,
  selectCookSaveLayer,
  supportsLayeredCookCache,
} from "./cook-cache.js";
import {
  cargoConfigHash,
  resolveLockfilePath,
  shortFileHashSync,
  targetEnvHash,
  workspaceManifestHash,
} from "./cache-keys.js";
import { detectLibc } from "./solo-toolchain-cache.js";
import { cacheProfileDefault, isLocalRunner } from "./local-profile.js";

export interface DeferredCookInputs {
  workspace: string;
  runnerOs: string;
  runnerArch: string;
  githubSha: string;
  parentSha: string;
  targetDir: string;
  lockfile: string;
  flags: string;
  cache: boolean;
  deltaCache: boolean;
  rustcRelease: string;
  soldrVersion: string;
  buildShape: string;
  env: Record<string, string | undefined>;
}

export interface DeferredCookDisabledPlan {
  enabled: false;
  reason: string;
}

export interface DeferredCookEnabledPlan {
  enabled: true;
  layered: boolean;
  projectRoot: string;
  targetDir: string;
  lockfilePath: string;
  flags: string[];
  legacyKey: string;
  legacyArchivePath: string;
  baseKey: string;
  deltaKey: string;
  /** #625: soldr-free base fallback (previous soldr release's deps). */
  baseRestoreKeys: string[];
  deltaRestoreKeys: string[];
  baseArchivePath: string;
  deltaArchivePath: string;
  baseManifestPath: string;
  baseZstdLevel: string;
  deltaZstdLevel: string;
}

export type DeferredCookPlan = DeferredCookDisabledPlan | DeferredCookEnabledPlan;

export function selectDeferredCookSaveLayer(
  cookRan: boolean,
  baseReady: boolean,
  saveCache: boolean,
  deltaEnabled: boolean,
): "base" | "delta" | "none" {
  if (!saveCache) return "none";
  return selectCookSaveLayer(cookRan, baseReady, deltaEnabled);
}

export function parseBooleanInput(name: string, raw: string, defaultValue: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`invalid '${name}' input: ${JSON.stringify(raw)}`);
}

export function resolveWorkspacePath(workspace: string, value: string, fallback: string): string {
  const selected = value.trim() || fallback;
  if (path.isAbsolute(selected)) return path.resolve(selected);
  return path.resolve(workspace, selected);
}

function targetDirFallback(env: Record<string, string | undefined>): string {
  return env["CARGO_TARGET_DIR"]?.trim() || "target";
}

async function defaultBuildShape(opts: {
  workspace: string;
  targetDir: string;
  flags: string[];
  env: Record<string, string | undefined>;
}): Promise<string> {
  const [manifestHash, configHash] = await Promise.all([
    workspaceManifestHash(opts.workspace),
    cargoConfigHash(opts.workspace),
  ]);
  const relativeTarget = path.relative(opts.workspace, opts.targetDir) || ".";
  return JSON.stringify({
    manifest: manifestHash,
    cargo_config: configHash,
    target_env: targetEnvHash(opts.env),
    target_dir: relativeTarget.split(path.sep).join("/"),
    flags: opts.flags,
  });
}

export async function buildDeferredCookPlan(
  inputs: DeferredCookInputs,
): Promise<DeferredCookPlan> {
  const workspace = path.resolve(inputs.workspace || process.cwd());
  const targetDir = resolveWorkspacePath(workspace, inputs.targetDir, targetDirFallback(inputs.env));
  const lockfilePath = resolveLockfilePath(workspace, targetDir, inputs.lockfile);
  const gate = decideCookGate({
    prebuildDeps: "soldr-cook",
    cacheUmbrella: inputs.cache,
    lockfilePath,
  });
  if (!gate.enabled) {
    return { enabled: false, reason: gate.reason };
  }

  const flags = canonicalizeCookFlags(parseCookFlags(inputs.flags));
  const flagsHash = hashCookFlags(flags);
  const lockHash = shortFileHashSync(lockfilePath, "no-lock");
  const rustcRelease = inputs.rustcRelease.trim() || "unresolved";
  const soldrVersion = inputs.soldrVersion.trim() || "unresolved";
  const keyParts = {
    runnerOs: inputs.runnerOs.trim().toLowerCase() || process.platform,
    runnerArch: inputs.runnerArch.trim().toLowerCase() || process.arch,
    libc: detectLibc(),
    rustcRelease,
    flagsHash,
    lockHash,
    soldrVersion,
  };
  const layered = inputs.deltaCache && supportsLayeredCookCache(soldrVersion);
  const buildShape = inputs.buildShape.trim() || await defaultBuildShape({
    workspace,
    targetDir,
    flags,
    env: inputs.env,
  });
  const baseKey = buildCookBaseCacheKey(keyParts);
  const buildShapeHash = hashCookBuildShape(buildShape);
  const deltaKey = buildCookDeltaCacheKey({
    ...keyParts,
    buildShapeHash,
    githubSha: inputs.githubSha || "nosha",
  });
  const parentSha = inputs.parentSha.trim();
  const deltaRestoreKeys = [];
  if (parentSha && parentSha !== inputs.githubSha) {
    deltaRestoreKeys.push(
      buildCookDeltaCacheKey({
        ...keyParts,
        buildShapeHash,
        githubSha: parentSha,
      }),
    );
  }
  deltaRestoreKeys.push(
    buildCookDeltaCacheRestorePrefix({
      ...keyParts,
      buildShapeHash,
    }),
  );

  return {
    enabled: true,
    layered,
    projectRoot: workspace,
    targetDir,
    lockfilePath,
    flags,
    legacyKey: buildCookCacheKey(keyParts),
    legacyArchivePath: `${targetDir}.tar.zst`,
    baseKey,
    deltaKey,
    baseRestoreKeys: [buildCookBaseCacheRestorePrefix(keyParts)],
    deltaRestoreKeys,
    baseArchivePath: `${targetDir}.soldr-base.tar.zst`,
    deltaArchivePath: `${targetDir}.soldr-delta.tar.zst`,
    baseManifestPath: `${targetDir}.soldr-base-manifest.pb`,
    // Runner profile: GitHub 9/3, local runner (ACT) 1/1.
    baseZstdLevel: cacheProfileDefault("cook-base-zstd-level", isLocalRunner(inputs.env)),
    deltaZstdLevel: cacheProfileDefault("cook-delta-zstd-level", isLocalRunner(inputs.env)),
  };
}
