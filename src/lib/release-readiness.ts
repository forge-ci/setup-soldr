// Release-readiness helpers shared by the action installer and the v0 rollout
// contract. A concrete version is always exact: retrying a just-published
// release is allowed, choosing a different release is not.

export const REQUIRED_RELEASE_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
] as const;

export const PYPI_WHEEL_PLATFORM_TAGS: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-gnu": "manylinux_2_17_x86_64.manylinux2014_x86_64",
  "aarch64-unknown-linux-gnu": "manylinux_2_17_aarch64.manylinux2014_aarch64",
  "x86_64-apple-darwin": "macosx_10_12_x86_64",
  "aarch64-apple-darwin": "macosx_11_0_arm64",
  "x86_64-pc-windows-msvc": "win_amd64",
  "aarch64-pc-windows-msvc": "win_arm64",
};

export type ReleasePayload = Record<string, unknown>;

const ARCHIVE_SUFFIXES = [".tar.zst", ".tar.gz", ".zip"] as const;

/**
 * True when `name` is a debug-symbol sidecar asset, i.e. the archive
 * extension-stripped name ends with `-symbols` (soldr's
 * `soldr-vX.Y.Z-<triple>-symbols.tar.zst` contract — see
 * soldr's docs/DEBUG_SIDECARS.md). Sidecars are never a valid soldr binary
 * archive and must be skipped by every asset matcher.
 */
export function isSymbolsSidecar(name: string): boolean {
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length).endsWith("-symbols");
    }
  }
  return false;
}

function assetHasTarget(asset: unknown, target: string): boolean {
  if (typeof asset !== "object" || asset === null) return false;
  const record = asset as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  const url = typeof record["browser_download_url"] === "string" ? record["browser_download_url"].trim() : "";
  return (
    name.includes(target) &&
    (name.endsWith(".tar.zst") || name.endsWith(".tar.gz") || name.endsWith(".zip")) &&
    !isSymbolsSidecar(name) &&
    url.length > 0
  );
}

export function pypiWheelHasTarget(file: unknown, target: string): boolean {
  if (typeof file !== "object" || file === null) return false;
  const platformTag = PYPI_WHEEL_PLATFORM_TAGS[target];
  if (!platformTag) return false;
  const record = file as Record<string, unknown>;
  const filename = typeof record["filename"] === "string" ? record["filename"] : "";
  const url = typeof record["url"] === "string" ? record["url"].trim() : "";
  const digests = record["digests"];
  const sha256 =
    typeof digests === "object" &&
    digests !== null &&
    typeof (digests as Record<string, unknown>)["sha256"] === "string"
      ? ((digests as Record<string, unknown>)["sha256"] as string).toLowerCase()
      : "";
  return (
    filename.startsWith("soldr-") &&
    filename.endsWith(`-${platformTag}.whl`) &&
    record["yanked"] !== true &&
    url.length > 0 &&
    /^[0-9a-f]{64}$/.test(sha256)
  );
}

/** Throws when a release cannot safely become setup-soldr's default. */
export function assertReleaseReady(
  release: ReleasePayload,
  requiredTargets: readonly string[] = REQUIRED_RELEASE_TARGETS,
  pypiRelease?: ReleasePayload,
): void {
  const tag = typeof release["tag_name"] === "string" ? release["tag_name"].trim() : "";
  if (!tag) throw new Error("release payload has no tag_name");
  if (release["draft"] === true) throw new Error(`release ${tag} is still a draft`);

  const assets = release["assets"];
  if (!Array.isArray(assets)) throw new Error(`release ${tag} has no assets array`);
  const pypiFiles = pypiRelease?.["urls"];
  const missing = requiredTargets.filter(
    (target) =>
      !assets.some((asset) => assetHasTarget(asset, target)) &&
      !(Array.isArray(pypiFiles) && pypiFiles.some((file) => pypiWheelHasTarget(file, target))),
  );
  if (missing.length > 0) {
    throw new Error(`release ${tag} is missing usable assets for: ${missing.join(", ")}`);
  }
}

export function isRetryableReleaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/HTTP\s+(\d{3})\b/)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code === 404 || code >= 500;
}

export async function retryReleaseRequest<T>(
  request: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    backoffFactor?: number;
    onRetry?: (attempt: number, error: unknown) => void;
    isRetryable?: (error: unknown) => boolean;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 500;
  const isRetryable = options.isRetryable ?? isRetryableReleaseError;
  const sleep = options.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;
      options.onRetry?.(attempt, error);
      await sleep(delayMs * (options.backoffFactor ?? 1) ** (attempt - 1));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`release request failed after ${attempts} attempts: ${detail}`);
}
