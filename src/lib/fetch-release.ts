// GitHub release-tag resolution. Split out of resolve-setup.ts so the
// orchestrator module doesn't carry HTTP/auth wiring. The default
// fetcher hits the GitHub REST API; tests inject a stub via
// `ResolveSetupDeps.fetchReleaseTag`.

import type { SystemRustupProbeDeps } from "./toolchain.js";
import type { ToolchainSpec } from "./types.js";
import type { DylintNightlyIdentity } from "./dylint-nightly.js";
import { DEFAULT_SOLDR_VERSION } from "./default-soldr-version.js";
import { githubApiUrl } from "./github-api.js";

/**
 * Optional injectable dependencies for tests. Production code uses defaults.
 */
export interface ResolveSetupDeps {
  fetchReleaseTag?: (repo: string, version: string, env: Record<string, string | undefined>) => Promise<string>;
  systemRustup?: SystemRustupProbeDeps;
  systemRustupOverride?: (
    cargoHome: string,
    rustupHome: string,
    toolchain: ToolchainSpec,
  ) => Promise<boolean> | boolean;
  /** Test seam: host platform for the macOS managed-rustup override (#105). */
  platform?: NodeJS.Platform;
  /** Test seam: tool components installed in the runner toolchain. */
  runnerToolComponents?: (
    cargoHome: string,
    rustupHome: string,
    channel: string,
  ) => Promise<string[]> | string[];
  resolveDylintNightly?: (
    requested: string,
    env: Record<string, string | undefined>,
  ) => Promise<DylintNightlyIdentity>;
}

/**
 * Resolve a repo's latest release tag from the plain web redirect
 * `https://github.com/<repo>/releases/latest` -> `.../releases/tag/<tag>`.
 * That endpoint is not part of the REST API, so it does not consume the
 * 60 req/hr anonymous `core` quota (local `act` runs have no token).
 */
export async function resolveLatestTagViaRedirect(repo: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let url = new URL(`https://github.com/${repo}/releases/latest`);
    // A repository transfer can first redirect /releases/latest to the new
    // owner. Follow only GitHub release lookups, within the same time budget.
    for (let hop = 0; hop < 3; hop++) {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": "setup-soldr-action" },
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) {
        throw new Error(`releases/latest redirect for ${repo} returned HTTP ${response.status} without a release redirect`);
      }
      const next = new URL(location, url);
      if (next.origin !== "https://github.com" || next.username || next.password) {
        throw new Error(`releases/latest redirect for ${repo} points outside GitHub`);
      }
      const match = /^\/[^/]+\/[^/]+\/releases\/tag\/([^/]+)\/?$/.exec(next.pathname);
      const tag = match ? decodeURIComponent(match[1]!).trim() : "";
      if (tag) return tag;
      if (!/^\/[^/]+\/[^/]+\/releases\/latest\/?$/.test(next.pathname)) {
        throw new Error(`releases/latest redirect for ${repo} does not point to a release page`);
      }
      url = next;
    }
    throw new Error(`Too many releases/latest redirects for ${repo}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchReleaseTagDefault(
  repo: string,
  version: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (version) {
    // For explicit (non-latest) versions, return as-is. Caller normalizes.
    return "";
  }
  const token = (env["GITHUB_TOKEN"] ?? "").trim() || (env["INPUT_TOKEN"] ?? "").trim();
  if (!token) {
    // Anonymous: avoid the REST API quota; fall back to it only on failure.
    try {
      return await resolveLatestTagViaRedirect(repo);
    } catch {
      // fall through to the REST API
    }
  }
  const apiEnv = { ...process.env, ...env };
  const url = githubApiUrl(`repos/${repo}/releases/latest`, apiEnv);
  try {
    return await fetchLatestTagViaApi(repo, url, token);
  } catch (apiError) {
    // The unauthenticated path already tried the redirect. Keep custom and
    // enterprise API endpoints on their own server, including on failure.
    if (!token || githubApiUrl("", apiEnv) !== "https://api.github.com/") throw apiError;
    try {
      return await resolveLatestTagViaRedirect(repo);
    } catch (redirectError) {
      throw new AggregateError(
        [apiError, redirectError],
        `Could not resolve the latest Soldr release for ${repo}. GitHub API: ${String(apiError)}. ` +
          `GitHub release redirect: ${String(redirectError)}`,
        { cause: redirectError },
      );
    }
  }
}

async function fetchLatestTagViaApi(repo: string, url: string, token: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "setup-soldr-action",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status} for ${repo}`);
    }
    const payload = (await response.json()) as unknown;
    if (typeof payload !== "object" || payload === null) {
      throw new Error(`unexpected GitHub release payload for ${repo}`);
    }
    const tag = (payload as Record<string, unknown>)["tag_name"];
    const tagName = typeof tag === "string" ? tag.trim() : "";
    if (!tagName) {
      throw new Error(`failed to resolve latest soldr release tag from ${repo}`);
    }
    return tagName;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveSoldrReleaseVersion(
  repo: string,
  version: string,
  ref: string,
  env: Record<string, string | undefined>,
  deps?: ResolveSetupDeps,
): Promise<string> {
  if (ref.trim()) {
    return "";
  }
  let requested = version.trim();
  if (!requested || requested.toLowerCase() === "default") {
    // Vendor-locked default: no network lookup at all.
    requested = DEFAULT_SOLDR_VERSION;
  }
  if (requested.toLowerCase() !== "latest") {
    return requested.startsWith("v") ? requested : `v${requested}`;
  }
  const fetcher = deps?.fetchReleaseTag ?? fetchReleaseTagDefault;
  const tagName = await fetcher(repo, "", env);
  if (!tagName) {
    throw new Error(`failed to resolve latest soldr release tag from ${repo}`);
  }
  return tagName;
}
