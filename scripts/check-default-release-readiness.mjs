import { readFileSync } from "node:fs";
import { fetchToolchainJson } from "../src/lib/soldr-toolchain-origins.cjs";

const requiredTargets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
];

const wheelPlatformTags = {
  "x86_64-unknown-linux-gnu": "manylinux_2_17_x86_64.manylinux2014_x86_64",
  "aarch64-unknown-linux-gnu": "manylinux_2_17_aarch64.manylinux2014_aarch64",
  "x86_64-apple-darwin": "macosx_10_12_x86_64",
  "aarch64-apple-darwin": "macosx_11_0_arm64",
  "x86_64-pc-windows-msvc": "win_amd64",
  "aarch64-pc-windows-msvc": "win_arm64",
};

const cargoChefVersionBySoldr = {
  "0.9.0": "0.1.73",
  "0.9.1": "0.1.73",
  "0.9.2": "0.1.73",
  "0.9.3": "0.1.73",
  "0.9.4": "0.1.73",
};

const cargoChefPlatforms = {
  "x86_64-unknown-linux-gnu": { os: "linux", arch: "x86_64", libc: "musl" },
  "aarch64-unknown-linux-gnu": { os: "linux", arch: "aarch64", libc: "musl" },
  "x86_64-apple-darwin": { os: "darwin", arch: "x86_64" },
  "aarch64-apple-darwin": { os: "darwin", arch: "aarch64" },
  "x86_64-pc-windows-msvc": { os: "windows", arch: "x86_64", abi: "msvc" },
  "aarch64-pc-windows-msvc": { os: "windows", arch: "aarch64", abi: "msvc" },
};

const action = readFileSync("action.yml", "utf8");
const requestedVersion = action.match(/^  version:\r?\n[\s\S]*?^    default:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
if (!requestedVersion) throw new Error("could not read inputs.version default from action.yml");

const headers = { Accept: "application/vnd.github+json", "User-Agent": "setup-soldr-release-readiness" };
const token = process.env.GITHUB_TOKEN?.trim();
if (token) headers.Authorization = `Bearer ${token}`;
const apiBase = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
const releaseEndpoint = requestedVersion.toLowerCase() === "latest"
  ? `${apiBase}/repos/zackees/soldr/releases/latest`
  : `${apiBase}/repos/zackees/soldr/releases/tags/${requestedVersion.startsWith("v") ? requestedVersion : `v${requestedVersion}`}`;
const response = await fetch(releaseEndpoint, { headers });
if (!response.ok) throw new Error(`default release ${requestedVersion} returned HTTP ${response.status}`);
const release = await response.json();
const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
if (!/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error("default release has no semantic tag_name");
const version = tag.replace(/^v/, "");
if (release.draft) throw new Error(`default release ${tag} is a draft`);
if (!Array.isArray(release.assets)) throw new Error(`default release ${tag} has no assets array`);

const archiveTargets = new Set(requiredTargets.filter((target) => release.assets.some((asset) => {
  const name = typeof asset?.name === "string" ? asset.name : "";
  const url = typeof asset?.browser_download_url === "string" ? asset.browser_download_url.trim() : "";
  return name.includes(target) && /\.(tar\.zst|tar\.gz|zip)$/.test(name) && url;
})));
const missingArchives = requiredTargets.filter((target) => !archiveTargets.has(target));
let wheelFiles = [];
if (missingArchives.length > 0) {
  const pypiResponse = await fetch(`https://pypi.org/pypi/soldr/${encodeURIComponent(version.replace(/^v/, ""))}/json`, {
    headers: { Accept: "application/json", "User-Agent": "setup-soldr-release-readiness" },
  });
  if (!pypiResponse.ok) throw new Error(`default release ${tag} PyPI metadata returned HTTP ${pypiResponse.status}`);
  const pypi = await pypiResponse.json();
  if (!Array.isArray(pypi.urls)) throw new Error(`default release ${tag} PyPI metadata has no urls array`);
  wheelFiles = pypi.urls;
}
const missing = missingArchives.filter((target) => !wheelFiles.some((file) => {
  const platformTag = wheelPlatformTags[target];
  const filename = typeof file?.filename === "string" ? file.filename : "";
  const url = typeof file?.url === "string" ? file.url.trim() : "";
  const digest = typeof file?.digests?.sha256 === "string" ? file.digests.sha256.toLowerCase() : "";
  return filename.startsWith("soldr-") && filename.endsWith(`-${platformTag}.whl`) && url && !file.yanked && /^[0-9a-f]{64}$/.test(digest);
}));
if (missing.length > 0) throw new Error(`default release ${tag} lacks usable assets: ${missing.join(", ")}`);

if (missingArchives.length > 0) {
  const normalizedVersion = version.replace(/^v/, "");
  const cargoChefVersion = cargoChefVersionBySoldr[normalizedVersion];
  if (!cargoChefVersion) {
    throw new Error(`default release ${tag} has wheel fallbacks but no pinned cargo-chef support version`);
  }
  // Same origin resolution as the action: redirect manifest, then the
  // built-in mirrors, failing over on network errors, 404 and 5xx.
  const { url: catalogUrl, payload: catalog } = await fetchToolchainJson("cargo-chef/manifest.json", {
    headers: { Accept: "application/json", "User-Agent": "setup-soldr-release-readiness" },
    log: (message) => console.log(message),
  });
  console.log(`cargo-chef catalogue: ${catalogUrl}`);
  const supportRelease = Array.isArray(catalog.releases)
    ? catalog.releases.find((candidate) => candidate?.version === `v${cargoChefVersion}`)
    : undefined;
  const supportPlatforms = Array.isArray(supportRelease?.platforms) ? supportRelease.platforms : [];
  const missingSupport = missingArchives.filter((target) => {
    const expected = cargoChefPlatforms[target];
    return !supportPlatforms.some((candidate) => {
      const platform = candidate?.platform;
      const asset = candidate?.asset;
      const filename = typeof asset?.filename === "string" ? asset.filename : "";
      const urls = Array.isArray(asset?.urls) ? asset.urls.filter((url) => typeof url === "string" && url) : [];
      const digest = typeof asset?.sha256 === "string" ? asset.sha256.toLowerCase() : "";
      return expected && Object.entries(expected).every(([key, value]) => platform?.[key] === value) &&
        /\.(tar\.zst|tar\.gz|tgz|zip)$/.test(filename) && urls.length > 0 && /^[0-9a-f]{64}$/.test(digest);
    });
  });
  if (missingSupport.length > 0) {
    throw new Error(`cargo-chef ${cargoChefVersion} lacks usable support assets for: ${missingSupport.join(", ")}`);
  }
}

console.log(
  `Release readiness passed for ${tag} (${requiredTargets.length} supported targets: ` +
  `${archiveTargets.size} combined archives, ${missingArchives.length} PyPI wheel fallbacks).`,
);
