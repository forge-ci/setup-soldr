import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getCacheServiceVersion } from "@actions/cache/lib/internal/config.js";
import * as cacheHttpClient from "@actions/cache/lib/internal/cacheHttpClient.js";
import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils.js";
import * as twirp from "@actions/cache/lib/internal/shared/cacheTwirpClient.js";
import * as cacheTar from "@actions/cache/lib/internal/tar.js";
import { allowCacheSave } from "./save-policy.js";

type CompressionMethod = Awaited<ReturnType<typeof cacheUtils.getCompressionMethod>>;

export interface ReservedCacheArchive {
  archivePath: string;
  archiveBytes: number;
  inflatedBytes?: number;
  fileCount?: number;
  sourceFiles?: number;
  deletedCacheFiles?: number;
  compressMs?: number;
}

export interface ActionsCacheArchive {
  archivePath: string;
  archiveBytes: number;
  cleanupDir?: string;
}

export interface TwoPhaseCacheResult {
  /**
   * `skipped-reservation` means exactly "a real conflict, someone else won".
   * `reservation-failed` means the reservation itself failed, so nothing was
   * written and nobody else is known to be writing it; `error` says why.
   */
  status: "saved" | "skipped-reservation" | "reservation-failed" | "policy-skip" | "failed";
  cacheId?: number;
  archive?: ReservedCacheArchive;
  error?: string;
}

export interface TwoPhaseCacheOptions {
  paths: string[];
  key: string;
  /** Layer name used in the save-policy skip line (#527). */
  layer?: string;
  enableCrossOsArchive?: boolean;
  log?: (message: string) => void;
  produce: () => Promise<ReservedCacheArchive>;
  reserve?: () => Promise<ReservationResult>;
  prepareUpload?: (
    reservation: Reservation,
    archive: ReservedCacheArchive,
  ) => Promise<ActionsCacheArchive>;
  upload?: (
    reservation: Reservation,
    archive: ActionsCacheArchive,
  ) => Promise<number | undefined>;
}

interface ActionsCacheArchiveTools {
  resolvePaths: (paths: string[]) => Promise<string[]>;
  createTempDirectory: () => Promise<string>;
  createTar: typeof cacheTar.createTar;
  stat: (archivePath: string) => Promise<{ size: number }>;
  removeDirectory: (directory: string) => Promise<void>;
}

const defaultArchiveTools: ActionsCacheArchiveTools = {
  resolvePaths: cacheUtils.resolvePaths,
  createTempDirectory: cacheUtils.createTempDirectory,
  createTar: cacheTar.createTar,
  stat: fsp.stat,
  removeDirectory: async (directory) => {
    await fsp.rm(directory, { recursive: true, force: true });
  },
};

export async function prepareActionsCacheArchive(
  reservation: Reservation,
  archive: ReservedCacheArchive,
  tools: ActionsCacheArchiveTools = defaultArchiveTools,
): Promise<ActionsCacheArchive> {
  const cachePaths = await tools.resolvePaths([archive.archivePath]);
  if (cachePaths.length === 0) {
    throw new Error(`produced archive does not exist: ${archive.archivePath}`);
  }
  const archiveFolder = await tools.createTempDirectory();
  try {
    const uploadArchivePath = path.join(
      archiveFolder,
      cacheUtils.getCacheFileName(reservation.compressionMethod),
    );
    await tools.createTar(archiveFolder, cachePaths, reservation.compressionMethod);
    const archiveBytes = (await tools.stat(uploadArchivePath)).size;
    return { archivePath: uploadArchivePath, archiveBytes, cleanupDir: archiveFolder };
  } catch (error) {
    await tools.removeDirectory(archiveFolder).catch(() => undefined);
    throw error;
  }
}

export interface Reservation {
  service: "v1" | "v2";
  compressionMethod: CompressionMethod;
  version?: string;
  cacheId?: number;
  signedUploadUrl?: string;
}

export type ReservationResult =
  | { kind: "reserved"; reservation: Reservation }
  | { kind: "conflict" }
  | { kind: "failed"; message: string };

/** Test seam over the two cache services; defaults to the real clients. */
export interface ReservationClient {
  serviceVersion: () => string;
  createCacheEntry: (request: { key: string; version: string }) => Promise<{
    ok: boolean;
    signedUploadUrl: string;
    message: string;
  }>;
  reserveCacheV1: typeof cacheHttpClient.reserveCache;
}

/** Service errors can echo signed URLs, so never log or report one verbatim. */
function redactSecrets(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<redacted-url>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
}

/**
 * The v2 twirp client exposes no status on its response: any non-2xx is thrown
 * as `Failed to CreateCacheEntry: ... Failed request: (409) Conflict: <msg>`,
 * so that text is the only place a real conflict can be recognized. A status,
 * when present, decides on its own: a 500 mentioning "already exists" failed.
 */
function isConflictMessage(message: string): boolean {
  const status = /Failed request: \((\d{3})\)/.exec(message)?.[1];
  if (status) return status === "409";
  return /already[ _]exists/i.test(message);
}

function classifyReservationMessage(message: string): ReservationResult {
  return isConflictMessage(message)
    ? { kind: "conflict" }
    : { kind: "failed", message: redactSecrets(message) };
}

function log(options: TwoPhaseCacheOptions, message: string): void {
  options.log?.(`two-phase-cache: ${message}`);
}

export async function reserve(
  options: TwoPhaseCacheOptions,
  client?: ReservationClient,
): Promise<ReservationResult> {
  const compressionMethod = await cacheUtils.getCompressionMethod();
  const enableCrossOsArchive = options.enableCrossOsArchive ?? false;
  if ((client?.serviceVersion ?? getCacheServiceVersion)() === "v2") {
    const version = cacheUtils.getCacheVersion(options.paths, compressionMethod, enableCrossOsArchive);
    const request = { key: options.key, version };
    // Non-2xx responses throw; saveReservedCache classifies those.
    const response = await (client
      ? client.createCacheEntry(request)
      : twirp.internalCacheTwirpClient().CreateCacheEntry(request));
    if (!response.ok) {
      return classifyReservationMessage(
        `CreateCacheEntry returned ok=false: ${response.message || "no message"}`,
      );
    }
    if (!response.signedUploadUrl) {
      return { kind: "failed", message: "CreateCacheEntry returned ok=true without signedUploadUrl" };
    }
    return {
      kind: "reserved",
      reservation: {
        service: "v2",
        compressionMethod,
        version,
        signedUploadUrl: response.signedUploadUrl,
      },
    };
  }

  const response = await (client?.reserveCacheV1 ?? cacheHttpClient.reserveCache)(options.key, options.paths, {
    compressionMethod,
    enableCrossOsArchive,
  });
  const cacheId = response.result?.cacheId;
  if (typeof cacheId === "number") {
    return { kind: "reserved", reservation: { service: "v1", compressionMethod, cacheId } };
  }
  if (response.statusCode === 409) return { kind: "conflict" };
  return {
    kind: "failed",
    message: redactSecrets(
      `reserveCache returned HTTP ${response.statusCode} without a cacheId` +
        (response.error ? `: ${response.error.message}` : ""),
    ),
  };
}

/**
 * Reserve an exact Actions cache key before producing the archive. The
 * producer is never called after a reservation conflict, which is the key
 * property missing from the public saveCache convenience API.
 */
export async function saveReservedCache(options: TwoPhaseCacheOptions): Promise<TwoPhaseCacheResult> {
  // #527: shared save policy. No reservation, no archive, no upload.
  if (!allowCacheSave(options.layer ?? "actions-cache", (m) => options.log?.(m))) {
    return { status: "policy-skip" };
  }
  let outcome: ReservationResult;
  try {
    outcome = options.reserve ? await options.reserve() : await reserve(options);
  } catch (error) {
    outcome = classifyReservationMessage(error instanceof Error ? error.message : String(error));
  }
  if (outcome.kind === "conflict") {
    log(options, `reservation conflict for key=${options.key}`);
    return { status: "skipped-reservation" };
  }
  if (outcome.kind === "failed") {
    log(options, `reservation failed for key=${options.key}: ${outcome.message}`);
    return { status: "reservation-failed", error: outcome.message };
  }
  const { reservation } = outcome;

  let archive: ReservedCacheArchive;
  try {
    archive = await options.produce();
  } catch (error) {
    log(options, `archive production failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  let uploadArchive: ActionsCacheArchive | undefined;
  try {
    uploadArchive = options.prepareUpload
      ? await options.prepareUpload(reservation, archive)
      : await prepareActionsCacheArchive(reservation, archive);
    log(
      options,
      `prepared Actions-cache wrapper inner=${archive.archiveBytes}B outer=${uploadArchive.archiveBytes}B`,
    );
    if (options.upload) {
      const cacheId = await options.upload(reservation, uploadArchive);
      return { status: "saved", cacheId, archive };
    }
    if (reservation.service === "v1") {
      await cacheHttpClient.saveCache(reservation.cacheId!, uploadArchive.archivePath, "", {
        archiveSizeBytes: uploadArchive.archiveBytes,
      });
      return { status: "saved", cacheId: reservation.cacheId, archive };
    }

    await cacheHttpClient.saveCache(-1, uploadArchive.archivePath, reservation.signedUploadUrl, {
      archiveSizeBytes: uploadArchive.archiveBytes,
      uploadChunkSize: 64 * 1024 * 1024,
      uploadConcurrency: 8,
      useAzureSdk: true,
    });
    const finalized = await twirp.internalCacheTwirpClient().FinalizeCacheEntryUpload({
      key: options.key,
      version: reservation.version!,
      sizeBytes: `${uploadArchive.archiveBytes}`,
    });
    if (!finalized.ok) throw new Error(finalized.message || "cache finalization failed");
    return { status: "saved", cacheId: Number.parseInt(finalized.entryId, 10), archive };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error), archive };
  } finally {
    await fsp.rm(archive.archivePath, { force: true }).catch(() => undefined);
    if (uploadArchive?.cleanupDir) {
      await fsp.rm(uploadArchive.cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function isReservationConflict(result: TwoPhaseCacheResult): boolean {
  return result.status === "skipped-reservation";
}
