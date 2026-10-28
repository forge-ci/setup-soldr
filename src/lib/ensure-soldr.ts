// Soldr binary installer. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/ensure_soldr.py.
// Downloads the soldr binary from a GitHub release asset (or builds from a
// git ref when INPUT_REF is set) and places it under $SOLDR_INSTALL_DIR.

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import { ToolRunner } from "@actions/exec/lib/toolrunner.js";
import * as tc from "@actions/tool-cache";
import * as fzstd from "fzstd";
import { createLogger, streamExec } from "./log-utils.js";
import { isSymbolsSidecar, pypiWheelHasTarget, retryReleaseRequest } from "./release-readiness.js";
import type { ResolveResult } from "./types.js";
import { githubApiUrl } from "./github-api.js";
import { parseVersionJsonOutput } from "./verify-soldr.js";

type ArchiveExt = "tar.zst" | "tar.gz" | "zip" | "whl";

interface InstallAsset {
  name: string;
  url: string;
  archiveExt: ArchiveExt;
  source: "github-release" | "pypi-wheel";
  expectedSha256?: string;
}

interface SupportAsset {
  filename: string;
  urls: string[];
  sha256: string;
  archiveExt: Exclude<ArchiveExt, "whl">;
}

const CARGO_CHEF_VERSION_BY_SOLDR: Readonly<Record<string, string>> = {
  "0.9.0": "0.1.73",
  "0.9.1": "0.1.73",
  "0.9.2": "0.1.73",
  "0.9.3": "0.1.73",
  "0.9.4": "0.1.73",
  "0.9.5": "0.1.73",
  "0.9.6": "0.1.73",
  "0.9.7": "0.1.73",
  "0.9.8": "0.1.73",
  "0.9.9": "0.1.73",
  "0.9.10": "0.1.73",
  "0.9.11": "0.1.73",
  "0.9.12": "0.1.73",
  "0.9.13": "0.1.73",
  "0.9.14": "0.1.73",
  "0.9.15": "0.1.73",
  "0.9.16": "0.1.73",
  "0.9.17": "0.1.73",
  "0.9.18": "0.1.73",
  "0.9.19": "0.1.73",
  "0.9.20": "0.1.73",
  "0.9.21": "0.1.73",
  "0.9.22": "0.1.73",
  "0.9.23": "0.1.73",
  "0.9.24": "0.1.73",
  "0.9.25": "0.1.73",
  "0.9.26": "0.1.73",
  "0.9.27": "0.1.73",
};

interface TargetInfo {
  target: string;
  binaryName: string;
}

function detectTarget(): TargetInfo {
  const machine = process.arch;
  let arch: string;
  if (machine === "x64") arch = "x86_64";
  else if (machine === "arm64") arch = "aarch64";
  else throw new Error(`unsupported architecture: ${machine}`);

  if (process.platform === "linux") {
    return { target: `${arch}-unknown-linux-gnu`, binaryName: "soldr" };
  }
  if (process.platform === "darwin") {
    return { target: `${arch}-apple-darwin`, binaryName: "soldr" };
  }
  if (process.platform === "win32") {
    return { target: `${arch}-pc-windows-msvc`, binaryName: "soldr.exe" };
  }
  throw new Error(`unsupported operating system: ${process.platform}`);
}

function normalizeVersion(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

function versionAtLeast(value: string, minimum: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = normalizeVersion(v).match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]!), Number(m[2]!), Number(m[3]!)];
  };
  const got = parse(value);
  const want = parse(minimum);
  if (!got || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (got[i]! > want[i]!) return true;
    if (got[i]! < want[i]!) return false;
  }
  return true;
}

function requestHeaders(githubToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "setup-soldr-action",
  };
  if (githubToken.trim()) {
    headers["Authorization"] = `Bearer ${githubToken.trim()}`;
  }
  return headers;
}

async function fetchJson(url: string, githubToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: requestHeaders(githubToken) });
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}`);
  }
  const payload = (await response.json()) as unknown;
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`unexpected JSON payload from ${url}`);
  }
  return payload as Record<string, unknown>;
}

function releaseUrl(repo: string, version: string): string {
  if (version) {
    const tag = version.startsWith("v") ? version : `v${version}`;
    return githubApiUrl(`repos/${repo}/releases/tags/${tag}`);
  }
  return githubApiUrl(`repos/${repo}/releases/latest`);
}

/**
 * Build a release payload for an exact tag without the REST API by probing
 * the conventional asset names on the plain `releases/download` URL (not
 * counted against the anonymous API quota). Returns null when no candidate
 * exists so the caller can fall back to the REST API.
 */
async function probeReleaseWithoutApi(
  repo: string,
  version: string,
  target: string,
): Promise<Record<string, unknown> | null> {
  if (!version || !target) return null;
  const tag = version.startsWith("v") ? version : `v${version}`;
  for (const ext of ["tar.zst", "tar.gz", "zip"]) {
    const name = `soldr-${tag}-${target}.${ext}`;
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": "setup-soldr-action" },
      });
      if (response.ok) {
        return { tag_name: tag, assets: [{ name, browser_download_url: url }] };
      }
    } catch {
      // try the next candidate / fall back to the API
    }
  }
  return null;
}

async function fetchRelease(
  repo: string,
  version: string,
  githubToken: string,
  target = "",
): Promise<Record<string, unknown>> {
  if (!githubToken.trim()) {
    const probed = await probeReleaseWithoutApi(repo, version, target);
    if (probed) return probed;
  }
  const url = releaseUrl(repo, version);
  try {
    return await retryReleaseRequest(() => fetchJson(url, githubToken), {
      onRetry: (attempt, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        core.info(`Release ${version || "latest"} was not ready (attempt ${attempt}/3): ${detail}; retrying exact tag`);
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to fetch exact soldr release ${version || "latest"} from ${repo}: ${detail}`);
  }
}

async function fetchPypiRelease(version: string): Promise<Record<string, unknown>> {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error("cannot resolve a PyPI wheel without an exact soldr version");
  const url = `https://pypi.org/pypi/soldr/${encodeURIComponent(normalized)}/json`;
  try {
    return await retryReleaseRequest(() => fetchJson(url, ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to fetch soldr ${normalized} wheel metadata from PyPI: ${detail}`);
  }
}

function canUseOfficialPypiFallback(repo: string, version: string): boolean {
  return (
    repo.trim().toLowerCase() === "zackees/soldr" &&
    bundledCargoChefVersionForSoldr(version) !== null
  );
}

function bundledCargoChefVersionForSoldr(version: string): string | null {
  return CARGO_CHEF_VERSION_BY_SOLDR[normalizeVersion(version)] ?? null;
}

async function resolveRefCommitSha(repo: string, ref: string, githubToken: string): Promise<string> {
  const url = githubApiUrl(`repos/${repo}/commits/${encodeURIComponent(ref)}`);
  const payload = await fetchJson(url, githubToken);
  const sha = payload["sha"];
  if (typeof sha !== "string" || !sha) {
    throw new Error(`failed to resolve commit sha for ${repo}@${ref}`);
  }
  return sha;
}

async function installedVersion(binaryPath: string): Promise<string | null> {
  if (!fs.existsSync(binaryPath)) return null;
  let stdout = "";
  const code = await new ToolRunner(binaryPath, ["version", "--json"], {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString("utf8");
      },
    },
  }).exec();
  if (code !== 0) return null;
  try {
    // Tolerant parse: extra fields, surrounding noise, and the silent-binary
    // regression (empty stdout, e.g. soldr v0.7.85/v0.7.87) all resolve to
    // null here, which makes the caller refresh the cached install.
    const payload = parseVersionJsonOutput(stdout);
    const v = payload["soldr_version"];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Validate the complete cached release payload using the same contract as
 * ensureSoldr's reuse path: executable version plus every required bundled
 * companion for that release/install source.
 */
export async function installedSoldrReleaseIsUsable(
  binaryPath: string,
  expectedVersion: string,
): Promise<boolean> {
  const current = await installedVersion(binaryPath);
  if (current === null || normalizeVersion(current) !== normalizeVersion(expectedVersion)) {
    return false;
  }
  const installDir = path.dirname(binaryPath);
  const binaryName = path.basename(binaryPath);
  const installMetadata = loadReleaseInstallMetadata(installDir);
  const { target } = detectTarget();
  const isPypiWheelInstall =
    installMetadata?.source === "pypi-wheel" &&
    installMetadata.target === target &&
    normalizeVersion(installMetadata.version ?? "") === normalizeVersion(expectedVersion);
  return hasRequiredReleasePayload(
    installDir,
    binaryName,
    expectedVersion,
    !isPypiWheelInstall || bundledCargoChefVersionForSoldr(expectedVersion) !== null,
  );
}

function sourceMetadataPath(installDir: string): string {
  return path.join(installDir, ".setup-soldr-source.json");
}

interface SourceMetadata {
  repo: string;
  ref: string;
  commit_sha: string;
  target: string;
  binary_name: string;
}

interface ReleaseInstallMetadata {
  source: "github-release" | "pypi-wheel";
  version: string;
  target: string;
  asset_name: string;
}

function releaseInstallMetadataPath(installDir: string): string {
  return path.join(installDir, ".setup-soldr-install.json");
}

function loadReleaseInstallMetadata(installDir: string): Partial<ReleaseInstallMetadata> | null {
  const metadataPath = releaseInstallMetadataPath(installDir);
  if (!fs.existsSync(metadataPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
    if (typeof data !== "object" || data === null) return null;
    return data as Partial<ReleaseInstallMetadata>;
  } catch {
    return null;
  }
}

function writeReleaseInstallMetadata(installDir: string, metadata: ReleaseInstallMetadata): void {
  fs.writeFileSync(
    releaseInstallMetadataPath(installDir),
    JSON.stringify(metadata, Object.keys(metadata).sort(), 2),
    "utf8",
  );
}

function loadSourceMetadata(p: string): Partial<SourceMetadata> | null {
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const out: Partial<SourceMetadata> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k as keyof SourceMetadata] = String(v);
    }
    return out;
  } catch {
    return null;
  }
}

function writeSourceMetadata(p: string, metadata: SourceMetadata): void {
  fs.writeFileSync(p, JSON.stringify(metadata, Object.keys(metadata).sort(), 2), "utf8");
}

function sourceInstallMatches(
  installDir: string,
  repo: string,
  ref: string,
  commitSha: string,
  target: string,
  binaryName: string,
): boolean {
  const binaryPath = path.join(installDir, binaryName);
  const metadata = loadSourceMetadata(sourceMetadataPath(installDir));
  if (!metadata || !fs.existsSync(binaryPath)) return false;
  return (
    metadata.repo === repo &&
    metadata.ref === ref &&
    metadata.commit_sha === commitSha &&
    metadata.target === target &&
    metadata.binary_name === binaryName
  );
}

function selectReleaseAsset(
  release: Record<string, unknown>,
  target: string,
): InstallAsset | null {
  const assets = release["assets"];
  if (!Array.isArray(assets)) throw new Error("release payload has no assets array");
  const tag = typeof release["tag_name"] === "string" ? (release["tag_name"] as string).trim() : "";
  // Preference order: tar.zst (newer releases — soldr 0.7.30+ ships these
  // for every platform including Windows MSVC), tar.gz (older Linux/macOS),
  // zip (older Windows). Within each extension class, an asset named exactly
  // `soldr-<tag>-<target>.<ext>` wins; otherwise the first substring match
  // wins (matching earlier, pre-#1010 release naming). Debug-symbol sidecar
  // assets (`soldr-vX.Y.Z-<triple>-symbols.tar.zst`, soldr#? / DEBUG_SIDECARS.md)
  // are never eligible — GitHub lists them ahead of the real binary archive.
  const extPreference: ArchiveExt[] = ["tar.zst", "tar.gz", "zip"];
  for (const ext of extPreference) {
    const suffix = `.${ext}`;
    const exactName = tag ? `soldr-${tag}-${target}.${ext}` : null;
    let fallback: { name: string; url: string } | null = null;
    for (const asset of assets) {
      if (typeof asset !== "object" || asset === null) continue;
      const a = asset as Record<string, unknown>;
      const name = typeof a["name"] === "string" ? (a["name"] as string) : "";
      if (!name.includes(target) || !name.endsWith(suffix) || isSymbolsSidecar(name)) continue;
      const url = a["browser_download_url"];
      if (typeof url !== "string") continue;
      if (exactName && name === exactName) {
        return { name, url, archiveExt: ext, source: "github-release" };
      }
      if (!fallback) fallback = { name, url };
    }
    if (fallback) return { name: fallback.name, url: fallback.url, archiveExt: ext, source: "github-release" };
  }
  return null;
}

function selectPypiWheel(pypiRelease: Record<string, unknown>, target: string): InstallAsset | null {
  const files = pypiRelease["urls"];
  if (!Array.isArray(files)) throw new Error("PyPI release payload has no urls array");
  for (const file of files) {
    if (!pypiWheelHasTarget(file, target) || typeof file !== "object" || file === null) continue;
    const record = file as Record<string, unknown>;
    const name = record["filename"] as string;
    const url = record["url"] as string;
    const digests = record["digests"];
    const expectedSha256 =
      typeof digests === "object" &&
      digests !== null &&
      typeof (digests as Record<string, unknown>)["sha256"] === "string"
        ? ((digests as Record<string, unknown>)["sha256"] as string).toLowerCase()
        : undefined;
    if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      throw new Error(`PyPI wheel ${name} has no valid SHA-256 digest`);
    }
    return {
      name,
      url,
      archiveExt: "whl",
      source: "pypi-wheel",
      expectedSha256,
    };
  }
  return null;
}

function archiveExtForFilename(filename: string): Exclude<ArchiveExt, "whl"> | null {
  if (filename.endsWith(".tar.zst")) return "tar.zst";
  if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) return "tar.gz";
  if (filename.endsWith(".zip")) return "zip";
  return null;
}

function toolchainPlatformForTarget(target: string): Record<string, string> | null {
  const platforms: Readonly<Record<string, Record<string, string>>> = {
    // cargo-chef is a host utility. Prefer the catalogue's static musl builds
    // on Linux so installing a manylinux Soldr wheel does not silently raise
    // the host glibc floor to whatever built the helper.
    "x86_64-unknown-linux-gnu": { os: "linux", arch: "x86_64", libc: "musl" },
    "aarch64-unknown-linux-gnu": { os: "linux", arch: "aarch64", libc: "musl" },
    "x86_64-apple-darwin": { os: "darwin", arch: "x86_64" },
    "aarch64-apple-darwin": { os: "darwin", arch: "aarch64" },
    "x86_64-pc-windows-msvc": { os: "windows", arch: "x86_64", abi: "msvc" },
    "aarch64-pc-windows-msvc": { os: "windows", arch: "aarch64", abi: "msvc" },
  };
  return platforms[target] ?? null;
}

function selectToolchainSupportAsset(
  catalog: Record<string, unknown>,
  version: string,
  target: string,
): SupportAsset | null {
  const releases = catalog["releases"];
  if (!Array.isArray(releases)) throw new Error("soldr-toolchain cargo-chef catalogue has no releases array");
  const releaseTag = version.startsWith("v") ? version : `v${version}`;
  const release = releases.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as Record<string, unknown>)["version"] === releaseTag,
  ) as Record<string, unknown> | undefined;
  if (!release) return null;
  const expectedPlatform = toolchainPlatformForTarget(target);
  if (!expectedPlatform) return null;
  const platforms = release["platforms"];
  if (!Array.isArray(platforms)) return null;
  for (const candidate of platforms) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const platform = record["platform"];
    const asset = record["asset"];
    if (typeof platform !== "object" || platform === null || typeof asset !== "object" || asset === null) continue;
    const platformRecord = platform as Record<string, unknown>;
    if (!Object.entries(expectedPlatform).every(([key, value]) => platformRecord[key] === value)) continue;
    const assetRecord = asset as Record<string, unknown>;
    const filename = typeof assetRecord["filename"] === "string" ? assetRecord["filename"] : "";
    const archiveExt = archiveExtForFilename(filename);
    const urls = Array.isArray(assetRecord["urls"])
      ? assetRecord["urls"].filter((url): url is string => typeof url === "string" && url.length > 0)
      : [];
    const sha256 = typeof assetRecord["sha256"] === "string" ? assetRecord["sha256"].toLowerCase() : "";
    if (!archiveExt || urls.length === 0 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`soldr-toolchain cargo-chef ${releaseTag} asset for ${target} is incomplete`);
    }
    return { filename, urls, sha256, archiveExt };
  }
  return null;
}

function prepareZipArchivePath(archivePath: string, archiveExt: ArchiveExt): string {
  if (archiveExt !== "whl") return archivePath;
  const zipPath = `${archivePath}.zip`;
  fs.copyFileSync(archivePath, zipPath);
  return zipPath;
}

export async function extractBinary(
  archivePath: string,
  archiveExt: ArchiveExt,
  binaryName: string,
  outDir: string,
): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  if (archiveExt === "zip" || archiveExt === "whl") {
    // Windows PowerShell's Expand-Archive rejects a valid ZIP payload when
    // its filename ends in .whl. tool-cache can fall back to that extractor
    // on self-hosted Windows runners, so give the verified wheel a .zip name.
    const zipPath = prepareZipArchivePath(archivePath, archiveExt);
    await tc.extractZip(zipPath, outDir);
  } else if (archiveExt === "tar.gz") {
    await tc.extractTar(archivePath, outDir, "xz");
  } else {
    // Extract tar.zst in-process so setup does not depend on zstd being installed
    // before soldr itself is available.
    await extractTarZst(archivePath, outDir);
  }
  const found = findFile(outDir, binaryName);
  if (!found) throw new Error(`downloaded archive did not contain ${binaryName}`);
  return found;
}

async function extractTarZst(archivePath: string, outDir: string): Promise<void> {
  const compressed = fs.readFileSync(archivePath);
  let decompressed: Uint8Array;
  try {
    decompressed = fzstd.decompress(compressed);
  } catch (err) {
    throw new Error(
      `failed to decompress ${path.basename(archivePath)} with embedded zstd: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  extractTarBuffer(decompressed, outDir);
}

const TAR_BLOCK_SIZE = 512;

function tarString(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  let end = slice.indexOf(0);
  if (end < 0) end = slice.length;
  return Buffer.from(slice.subarray(0, end)).toString("utf8");
}

function tarOctal(block: Uint8Array, start: number, length: number): number {
  const raw = tarString(block, start, length).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid tar octal field: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function tarEntryName(block: Uint8Array): string {
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function safeTarDestination(outDir: string, entryName: string): string {
  const normalizedName = entryName.replace(/\\/g, "/");
  if (!normalizedName || path.isAbsolute(normalizedName)) {
    throw new Error(`unsafe tar entry path: ${JSON.stringify(entryName)}`);
  }
  const destination = path.resolve(outDir, normalizedName);
  const root = path.resolve(outDir);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe tar entry path: ${JSON.stringify(entryName)}`);
  }
  return destination;
}

function extractTarBuffer(tarData: Uint8Array, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + TAR_BLOCK_SIZE <= tarData.length) {
    const header = tarData.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (isZeroBlock(header)) break;

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = tarOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > tarData.length) {
      throw new Error("truncated tar archive");
    }
    const data = tarData.subarray(dataStart, dataEnd);
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeflag === "L") {
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      continue;
    }

    const entryName = pendingLongName ?? tarEntryName(header);
    pendingLongName = null;
    if (!entryName) continue;

    const destination = safeTarDestination(outDir, entryName);
    if (typeflag === "5") {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      continue;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(data));
    if (process.platform !== "win32") {
      const mode = tarOctal(header, 100, 8);
      if (mode > 0) fs.chmodSync(destination, mode);
    }
  }
}

function findFile(root: string, name: string): string | null {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

function platformBinarySuffix(binaryName: string): string {
  return binaryName.endsWith(".exe") ? ".exe" : "";
}

function bundledReleasePayloadNames(binaryName: string): string[] {
  const suffix = platformBinarySuffix(binaryName);
  return [
    `zccache${suffix}`,
    `zccache-soldr${suffix}`,
    `zccache-daemon${suffix}`,
    `zccache-fp${suffix}`,
    `soldr-daemon${suffix}`,
    `soldr-shim${suffix}`,
    `crgx${suffix}`,
    `cargo-chef${suffix}`,
    `soldr-clang-shim${suffix}`,
    "manifest.json",
  ];
}

function bundledZccacheBinaryNames(binaryName: string): string[] {
  const suffix = platformBinarySuffix(binaryName);
  return [`zccache${suffix}`, `zccache-daemon${suffix}`, `zccache-fp${suffix}`];
}

function hasBundledZccachePayload(installDir: string, binaryName: string): boolean {
  return bundledZccacheBinaryNames(binaryName).every((name) =>
    fs.existsSync(path.join(installDir, name)),
  );
}

function embeddedZccacheBinaryNames(binaryName: string): string[] {
  const suffix = platformBinarySuffix(binaryName);
  return [`soldr-daemon${suffix}`, `soldr-shim${suffix}`];
}

function hasEmbeddedZccachePayload(installDir: string, binaryName: string): boolean {
  return embeddedZccacheBinaryNames(binaryName).every((name) =>
    fs.existsSync(path.join(installDir, name)),
  );
}

function hasMulticallRuntimePayload(installDir: string, binaryName: string): boolean {
  const suffix = platformBinarySuffix(binaryName);
  return fs.existsSync(path.join(installDir, `soldr-daemon${suffix}`));
}

function hasBundledCargoChefPayload(installDir: string, binaryName: string): boolean {
  const suffix = platformBinarySuffix(binaryName);
  return fs.existsSync(path.join(installDir, `cargo-chef${suffix}`));
}

// Sidecar-based soldr releases from 0.7.66 through 0.8.0 ship
// `soldr-clang-shim`, and their blessed `soldr build` surface requires it
// next to the running executable. Soldr 0.8.1+ folds clang/toolchain/zccache
// shims into the main multicall binary, so those releases deliberately omit
// this sidecar.
function hasBundledClangShimPayload(installDir: string, binaryName: string): boolean {
  const suffix = platformBinarySuffix(binaryName);
  return fs.existsSync(path.join(installDir, `soldr-clang-shim${suffix}`));
}

function hasRequiredReleasePayload(
  installDir: string,
  binaryName: string,
  resolvedVersion: string,
  requireBundledCargoChef = true,
): boolean {
  const usesMulticallRuntime = versionAtLeast(resolvedVersion, "0.8.1");
  const needsEmbeddedZccachePayload = versionAtLeast(resolvedVersion, "0.7.103");
  const needsCargoChef = versionAtLeast(resolvedVersion, "0.7.43");
  const needsLegacyClangShim =
    versionAtLeast(resolvedVersion, "0.7.66") && !usesMulticallRuntime;

  const hasRuntimePayload = usesMulticallRuntime
    ? hasMulticallRuntimePayload(installDir, binaryName)
    : needsEmbeddedZccachePayload
      ? hasEmbeddedZccachePayload(installDir, binaryName)
      : hasBundledZccachePayload(installDir, binaryName);

  return (
    hasRuntimePayload &&
    (!needsCargoChef || !requireBundledCargoChef || hasBundledCargoChefPayload(installDir, binaryName)) &&
    (!needsLegacyClangShim || hasBundledClangShimPayload(installDir, binaryName))
  );
}

function ensureMulticallRuntimeAlias(installDir: string, binaryName: string): string {
  const suffix = platformBinarySuffix(binaryName);
  const source = path.join(installDir, binaryName);
  const destination = path.join(installDir, `soldr-daemon${suffix}`);
  try {
    fs.rmSync(destination, { force: true });
  } catch {
    // The following link/copy reports the actionable failure.
  }
  try {
    fs.linkSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
  }
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
  return path.basename(destination);
}

function exportBundledCargoChefIfPresent(installDir: string, binaryName: string): void {
  if (hasBundledCargoChefPayload(installDir, binaryName)) {
    core.exportVariable("SOLDR_CARGO_CHEF_LOCAL_DIR", installDir);
  }
}

function clearBundledReleasePayload(installDir: string, binaryName: string): void {
  for (const name of bundledReleasePayloadNames(binaryName)) {
    try {
      fs.rmSync(path.join(installDir, name), { force: true });
    } catch {
      // best effort stale-payload cleanup
    }
  }
}

function copyBundledReleasePayload(
  extractDir: string,
  installDir: string,
  binaryName: string,
): string[] {
  const copied: string[] = [];
  for (const name of bundledReleasePayloadNames(binaryName)) {
    const source = findFile(extractDir, name);
    if (!source) continue;
    const destination = path.join(installDir, name);
    fs.copyFileSync(source, destination);
    if (name !== "manifest.json" && process.platform !== "win32") {
      fs.chmodSync(destination, 0o755);
    }
    copied.push(name);
  }
  return copied;
}

async function buildFromSource(opts: {
  repo: string;
  ref: string;
  commitSha: string;
  installDir: string;
  target: string;
  binaryName: string;
  githubToken: string;
  bootstrapSoldr: string;
  log: (msg: string) => void;
}): Promise<string> {
  const { repo, ref, commitSha, installDir, target, binaryName, githubToken, bootstrapSoldr, log } = opts;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-source-"));
  try {
    const archivePath = path.join(tmp, "source.zip");
    const sourceRoot = path.join(tmp, "source");
    log(`Downloading soldr source from ${repo}@${ref} (${commitSha})`);
    const archiveUrl = githubApiUrl(`repos/${repo}/zipball/${commitSha}`);
    await downloadWithHeaders(archiveUrl, archivePath, requestHeaders(githubToken));
    fs.mkdirSync(sourceRoot, { recursive: true });
    await tc.extractZip(archivePath, sourceRoot);
    const dirs = fs.readdirSync(sourceRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dirs.length !== 1) {
      throw new Error("source archive did not contain exactly one repository root");
    }
    const repoRoot = path.join(sourceRoot, (dirs[0] as fs.Dirent).name);
    const buildEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) buildEnv[k] = v;
    }
    buildEnv["CARGO_TERM_COLOR"] = buildEnv["CARGO_TERM_COLOR"] ?? "always";
    // The intermediate compiler must not start a persistent broker that a
    // different requested Soldr image inherits later in this action.
    buildEnv["SOLDR_RUSTC_WRAPPER"] = "none";
    buildEnv["SOLDR_BROKER_AUTOSPAWN"] = "0";
    buildEnv["SOLDR_NO_GLOBAL_DELEGATION"] = "1";
    buildEnv["SOLDR_AS"] = "";
    log(`Building soldr from source ref ${ref} (${commitSha})`);
    // #389: streamExec prefixes each `Compiling foo` line so the
    // forensic log shows where the soldr build wall-clock went.
    await streamExec(
      bootstrapSoldr,
      ["--no-cache", "cargo", "build", "--locked", "--bin", "soldr", "--target", target],
      { cwd: repoRoot, env: buildEnv },
    );
    const builtBinary = path.join(repoRoot, "target", target, "debug", binaryName);
    if (!fs.existsSync(builtBinary)) {
      throw new Error(`built soldr binary not found at ${builtBinary}`);
    }
    clearBundledReleasePayload(installDir, binaryName);
    const destination = path.join(installDir, binaryName);
    fs.copyFileSync(builtBinary, destination);
    if (process.platform !== "win32") {
      fs.chmodSync(destination, 0o755);
    }
    writeSourceMetadata(sourceMetadataPath(installDir), {
      repo,
      ref,
      commit_sha: commitSha,
      target,
      binary_name: binaryName,
    });
    try {
      fs.rmSync(releaseInstallMetadataPath(installDir), { force: true });
    } catch {
      // best effort stale release-metadata cleanup
    }
    return destination;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
}

async function buildFromLocalSource(opts: {
  sourcePath: string;
  sourceIdentity: string;
  installDir: string;
  target: string;
  binaryName: string;
  bootstrapSoldr: string;
  log: (msg: string) => void;
}): Promise<string> {
  const { sourcePath, sourceIdentity, installDir, target, binaryName, bootstrapSoldr, log } = opts;
  const buildEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) buildEnv[key] = value;
  }
  buildEnv["CARGO_TERM_COLOR"] = buildEnv["CARGO_TERM_COLOR"] ?? "always";
  // Keep the bootstrap's broker out of the requested source version's run.
  buildEnv["SOLDR_RUSTC_WRAPPER"] = "none";
  buildEnv["SOLDR_BROKER_AUTOSPAWN"] = "0";
  buildEnv["SOLDR_NO_GLOBAL_DELEGATION"] = "1";
  buildEnv["SOLDR_AS"] = "";
  const cargoTargetDir = path.join(os.tmpdir(), "setup-soldr-source-build", sourceIdentity);
  fs.mkdirSync(cargoTargetDir, { recursive: true });
  buildEnv["CARGO_TARGET_DIR"] = cargoTargetDir;

  log(`Building soldr from local source ${sourcePath} (${sourceIdentity})`);
  await streamExec(
    bootstrapSoldr,
    ["--no-cache", "cargo", "build", "--locked", "--bin", "soldr", "--target", target],
    { cwd: sourcePath, env: buildEnv },
  );
  const builtBinary = path.join(cargoTargetDir, target, "debug", binaryName);
  if (!fs.existsSync(builtBinary)) {
    throw new Error(`built soldr binary not found at ${builtBinary}`);
  }

  clearBundledReleasePayload(installDir, binaryName);
  const destination = path.join(installDir, binaryName);
  fs.copyFileSync(builtBinary, destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
  writeSourceMetadata(sourceMetadataPath(installDir), {
    repo: "local",
    ref: "working-tree",
    commit_sha: sourceIdentity,
    target,
    binary_name: binaryName,
  });
  try {
    fs.rmSync(releaseInstallMetadataPath(installDir), { force: true });
  } catch {
    // best effort stale release-metadata cleanup
  }
  return destination;
}

export async function downloadWithHeaders(url: string, dest: string, headers: Record<string, string>): Promise<void> {
  // tc.downloadTool supports auth/headers via separate args; rather than rely
  // on that, do a manual fetch+pipe to keep behavior parity with the Python
  // implementation. We stream to disk to avoid loading large archives in RAM.
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyDownloadedAsset(filePath: string, expectedSha256?: string): void {
  if (!expectedSha256) return;
  const actual = fileSha256(filePath);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

async function installCargoChefSupport(opts: {
  version: string;
  target: string;
  installDir: string;
  binaryName: string;
  log: (message: string) => void;
}): Promise<string> {
  const { version, target, installDir, binaryName, log } = opts;
  const catalogUrl = "https://zackees.github.io/soldr-toolchain/cargo-chef/manifest.json";
  const catalog = await fetchJson(catalogUrl, "");
  const asset = selectToolchainSupportAsset(catalog, version, target);
  if (!asset) {
    throw new Error(`soldr-toolchain has no cargo-chef ${version} support asset for ${target}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-cargo-chef-"));
  const cargoChefName = `cargo-chef${platformBinarySuffix(binaryName)}`;
  const failures: string[] = [];
  try {
    for (const [index, url] of asset.urls.entries()) {
      const archivePath = path.join(tmp, `${index}-${asset.filename}`);
      const extractDir = path.join(tmp, `extract-${index}`);
      try {
        log(`Downloading cargo-chef ${version} support for ${target}`);
        await downloadWithHeaders(url, archivePath, {});
        verifyDownloadedAsset(archivePath, asset.sha256);
        const source = await extractBinary(archivePath, asset.archiveExt, cargoChefName, extractDir);
        const destination = path.join(installDir, cargoChefName);
        fs.copyFileSync(source, destination);
        if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
        return cargoChefName;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
  throw new Error(`failed to install cargo-chef ${version} support for ${target}: ${failures.join("; ")}`);
}

export async function ensureSoldr(opts: {
  resolveResult: ResolveResult;
  githubToken: string;
  bootstrapSoldr?: string;
  getBootstrapSoldr?: () => Promise<string>;
}): Promise<void> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const { resolveResult, githubToken } = opts;

  const installDir = path.dirname(resolveResult.soldrPath);
  fs.mkdirSync(installDir, { recursive: true });
  const { target, binaryName } = detectTarget();
  const binaryPath = path.join(installDir, binaryName);
  const requestedRef = resolveResult.soldrRef.trim();
  const requestedVersion = resolveResult.soldrVersionRequested.trim();
  const repo = resolveResult.soldrRepo.trim() || "zackees/soldr";
  const sourcePath = resolveResult.soldrSourcePath.trim();
  const sourceIdentity = resolveResult.soldrSourceIdentity.trim();

  if (sourcePath) {
    const localRepo = "local";
    if (
      sourceInstallMatches(
        installDir,
        localRepo,
        "working-tree",
        sourceIdentity,
        target,
        binaryName,
      )
    ) {
      const current = await installedVersion(binaryPath);
      if (current !== null) {
        clearBundledReleasePayload(installDir, binaryName);
        log(`Using cached soldr ${current} built from ${sourcePath} (${sourceIdentity})`);
        core.setOutput("installed_version", current);
        return;
      }
    }
    const bootstrapSoldr = opts.bootstrapSoldr ?? await opts.getBootstrapSoldr?.();
    if (!bootstrapSoldr) throw new Error("verified Soldr bootstrap required for source build");
    const builtPath = await buildFromLocalSource({
      bootstrapSoldr,
      sourcePath,
      sourceIdentity,
      installDir,
      target,
      binaryName,
      log,
    });
    const current = await installedVersion(builtPath);
    log(`Installed soldr ${current ?? sourceIdentity} from ${sourcePath} (${sourceIdentity}) at ${builtPath}`);
    core.setOutput("installed_version", current ?? sourceIdentity);
    return;
  }

  if (requestedRef) {
    if (requestedVersion) {
      log(`Ignoring requested release version ${JSON.stringify(requestedVersion)} because ref is set`);
    }
    const commitSha = await resolveRefCommitSha(repo, requestedRef, githubToken);
    if (sourceInstallMatches(installDir, repo, requestedRef, commitSha, target, binaryName)) {
      const current = await installedVersion(binaryPath);
      if (current !== null) {
        clearBundledReleasePayload(installDir, binaryName);
        log(`Using cached soldr ${current} built from ${repo}@${requestedRef} (${commitSha})`);
        core.setOutput("installed_version", current);
        return;
      }
    }
    const bootstrapSoldr = opts.bootstrapSoldr ?? await opts.getBootstrapSoldr?.();
    if (!bootstrapSoldr) throw new Error("verified Soldr bootstrap required for source build");
    const builtPath = await buildFromSource({
      bootstrapSoldr,
      repo,
      ref: requestedRef,
      commitSha,
      installDir,
      target,
      binaryName,
      githubToken,
      log,
    });
    const current = await installedVersion(builtPath);
    log(
      `Installed soldr ${current ?? requestedRef} from ${repo}@${requestedRef} (${commitSha}) at ${builtPath}`,
    );
    core.setOutput("installed_version", current ?? requestedRef);
    return;
  }

  // Release branch
  const resolvedVersion = resolveResult.soldrVersionResolved.trim() || requestedVersion;
  const current = await installedVersion(binaryPath);
  if (current !== null && resolvedVersion) {
    if (normalizeVersion(current) === normalizeVersion(resolvedVersion)) {
      const installMetadata = loadReleaseInstallMetadata(installDir);
      const isPypiWheelInstall =
        installMetadata?.source === "pypi-wheel" &&
        installMetadata.target === target &&
        normalizeVersion(installMetadata.version ?? "") === normalizeVersion(resolvedVersion);
      const hasRequiredPayload = hasRequiredReleasePayload(
        installDir,
        binaryName,
        resolvedVersion,
        !isPypiWheelInstall || bundledCargoChefVersionForSoldr(resolvedVersion) !== null,
      );
      if (hasRequiredPayload) {
        exportBundledCargoChefIfPresent(installDir, binaryName);
        log(`Using cached soldr ${current} at ${binaryPath}`);
        core.setOutput("installed_version", current);
        return;
      }
      log(`Cached soldr ${current} is missing bundled release payload; refreshing`);
    }
    if (normalizeVersion(current) !== normalizeVersion(resolvedVersion)) {
      log(`Cached soldr ${current} does not match requested release ${resolvedVersion}; refreshing`);
    }
  }

  log(`Resolving soldr release ${resolvedVersion || "(latest)"} from ${repo}`);
  const release = await fetchRelease(repo, resolvedVersion, githubToken, target);
  const tagName = typeof release["tag_name"] === "string" ? (release["tag_name"] as string) : resolvedVersion;
  let asset = selectReleaseAsset(release, target);
  if (!asset) {
    if (!canUseOfficialPypiFallback(repo, tagName)) {
      throw new Error(
        `no release asset found for target ${target} in ${repo}; ` +
        `PyPI fallback is supported only for known wheel-compatible official releases`,
      );
    }
    log(`Combined GitHub release archive is absent for ${target}; resolving the exact ${tagName} PyPI wheel`);
    const pypiRelease = await fetchPypiRelease(tagName);
    asset = selectPypiWheel(pypiRelease, target);
    if (!asset) {
      throw new Error(`no combined release archive or PyPI wheel found for target ${target} at ${tagName}`);
    }
  }
  const { name: assetName, url: downloadUrl, archiveExt } = asset;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-soldr-release-"));
  try {
    const archivePath = path.join(tmp, assetName);
    const extractDir = path.join(tmp, "extract");
    log(`Downloading ${assetName}`);
    const downloadHeaders = asset.source === "github-release" ? requestHeaders(githubToken) : {};
    await downloadWithHeaders(downloadUrl, archivePath, downloadHeaders);
    verifyDownloadedAsset(archivePath, asset.expectedSha256);
    const sourceBinary = await extractBinary(archivePath, archiveExt, binaryName, extractDir);
    clearBundledReleasePayload(installDir, binaryName);
    fs.copyFileSync(sourceBinary, binaryPath);
    if (process.platform !== "win32") {
      fs.chmodSync(binaryPath, 0o755);
    }
    const copied = asset.source === "pypi-wheel"
      ? [ensureMulticallRuntimeAlias(installDir, binaryName)]
      : copyBundledReleasePayload(extractDir, installDir, binaryName);
    const cargoChefVersion = asset.source === "pypi-wheel"
      ? bundledCargoChefVersionForSoldr(tagName)
      : null;
    if (cargoChefVersion) {
      copied.push(
        await installCargoChefSupport({
          version: cargoChefVersion,
          target,
          installDir,
          binaryName,
          log,
        }),
      );
    }
    if (copied.length > 0) {
      log(`Installed bundled soldr release payload: ${copied.join(", ")}`);
    }
    exportBundledCargoChefIfPresent(installDir, binaryName);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
  if (asset.source === "pypi-wheel") {
    const installed = await installedVersion(binaryPath);
    if (installed === null || normalizeVersion(installed) !== normalizeVersion(tagName)) {
      throw new Error(
        `installed PyPI wheel did not execute as exact soldr ${normalizeVersion(tagName)} ` +
        `(reported ${installed ?? "no valid version"})`,
      );
    }
    if (!hasRequiredReleasePayload(installDir, binaryName, tagName, true)) {
      throw new Error(`installed PyPI wheel is missing required runtime payload for soldr ${tagName}`);
    }
  }
  const metadataPath = sourceMetadataPath(installDir);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
  writeReleaseInstallMetadata(installDir, {
    source: asset.source,
    version: tagName,
    target,
    asset_name: assetName,
  });
  log(`Installed soldr ${tagName} at ${binaryPath}`);
  core.setOutput("installed_version", tagName);
}

export const _internal = {
  fetchRelease,
  resolveRefCommitSha,
  probeReleaseWithoutApi,
  bundledReleasePayloadNames,
  bundledZccacheBinaryNames,
  bundledCargoChefVersionForSoldr,
  canUseOfficialPypiFallback,
  clearBundledReleasePayload,
  copyBundledReleasePayload,
  embeddedZccacheBinaryNames,
  ensureMulticallRuntimeAlias,
  extractTarBuffer,
  hasBundledCargoChefPayload,
  hasBundledClangShimPayload,
  hasBundledZccachePayload,
  hasEmbeddedZccachePayload,
  hasMulticallRuntimePayload,
  hasRequiredReleasePayload,
  prepareZipArchivePath,
  selectPypiWheel,
  selectReleaseAsset,
  selectToolchainSupportAsset,
  verifyDownloadedAsset,
  versionAtLeast,
};
