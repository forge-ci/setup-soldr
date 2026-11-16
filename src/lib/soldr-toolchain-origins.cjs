// Soldr toolchain origin resolver (redirect manifest v1).
//
// The soldr toolchain catalogue is a GitHub Pages site. Pages URLs do not
// redirect when a repository moves, so every toolchain fetch goes through this
// one resolver instead of a hard-coded origin:
//
//   1. Explicit overrides win and skip the redirect entirely
//      (SOLDR_TOOLCHAIN_ORIGIN; SOLDR_TOOLCHAIN_CATALOGUE_URL and
//      SOLDR_TOOLCHAIN_CATALOGUE_V2_URL for their own files).
//   2. SOLDR_TOOLCHAIN_REDIRECT_URL replaces the manifest URL;
//      SOLDR_TOOLCHAIN_REDIRECT=0 skips the manifest (built-in list only).
//   3. The manifest is fetched once per process with a short timeout and is
//      accepted only when it is JSON with schema_version 1 and a non-empty
//      toolchain.origins list of https:// URLs.
//   4. The manifest outcome (good or failed) is cached in memory for the
//      process, so one action run pays the lookup at most once. On failure
//      the built-in list is used; an unreachable manifest never fails a run.
//   5. Effective origins = manifest origins + built-in list, de-duplicated.
//   6. A file is fetched from each origin in order, moving on only for a
//      network error, a timeout, HTTP 404 or HTTP 5xx. Content errors stay
//      hard errors for the caller.
//
// Plain CommonJS with no TypeScript so both the action's TypeScript (a
// CommonJS project) and scripts/check-default-release-readiness.mjs load the
// same implementation on any Node version. Types live in the sibling .d.cts.

"use strict";

const DEFAULT_TOOLCHAIN_REDIRECT_URL = "https://forge-ci.github.io/soldr-redirect.v1.json";

const BUILTIN_TOOLCHAIN_ORIGINS = Object.freeze([
  "https://forge-ci.github.io/soldr-toolchain",
  "https://zackees.github.io/soldr-toolchain",
]);

const TOOLCHAIN_REDIRECT_TIMEOUT_MS = 5_000;
const TOOLCHAIN_FILE_TIMEOUT_MS = 60_000;

const SUPPORTED_REDIRECT_SCHEMA = 1;

/** In-flight or settled manifest lookups keyed by URL: one fetch per run. */
const manifestLookups = new Map();

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOrigin(value) {
  return String(value).trim().replace(/\/+$/, "");
}

/**
 * Validate a decoded redirect manifest. Returns the normalized origin list,
 * or null when the payload is not an acceptable schema-1 manifest.
 */
function parseRedirectManifest(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  if (payload.schema_version !== SUPPORTED_REDIRECT_SCHEMA) return null;
  const toolchain = payload.toolchain;
  if (typeof toolchain !== "object" || toolchain === null) return null;
  const origins = toolchain.origins;
  if (!Array.isArray(origins) || origins.length === 0) return null;
  const normalized = [];
  for (const origin of origins) {
    if (typeof origin !== "string") return null;
    const value = normalizeOrigin(origin);
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || !parsed.host) return null;
    normalized.push(value);
  }
  return normalized;
}

/** Concatenate origin lists, de-duplicated with first-seen order preserved. */
function mergeOrigins(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const origin of list) {
      const value = normalizeOrigin(origin);
      if (value && !seen.has(value)) {
        seen.add(value);
        merged.push(value);
      }
    }
  }
  return merged;
}

/** Forget every cached manifest. Test seam; also usable between runs. */
function resetToolchainRedirectCache() {
  manifestLookups.clear();
}

function describeError(error) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    return error.message;
  }
  return String(error);
}

async function fetchManifestOrigins(url, fetchImpl, timeoutMs, log) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "setup-soldr-action" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log(`soldr toolchain redirect manifest ${url} returned HTTP ${response.status}; using fallback origins`);
      return null;
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      log(`soldr toolchain redirect manifest ${url} is not valid JSON; using fallback origins`);
      return null;
    }
    const origins = parseRedirectManifest(payload);
    if (!origins) {
      log(`soldr toolchain redirect manifest ${url} failed validation; using fallback origins`);
      return null;
    }
    return origins;
  } catch (error) {
    log(`soldr toolchain redirect manifest ${url} unavailable (${describeError(error)}); using fallback origins`);
    return null;
  }
}

/**
 * Resolve the ordered origin list for toolchain files. Never throws for an
 * unreachable or invalid manifest.
 */
async function resolveToolchainOrigins(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const explicit = envValue(env, "SOLDR_TOOLCHAIN_ORIGIN");
  if (explicit) return [normalizeOrigin(explicit)];

  const builtin = [...BUILTIN_TOOLCHAIN_ORIGINS];
  if (envValue(env, "SOLDR_TOOLCHAIN_REDIRECT") === "0") return builtin;

  const url = envValue(env, "SOLDR_TOOLCHAIN_REDIRECT_URL") || DEFAULT_TOOLCHAIN_REDIRECT_URL;
  let lookup = manifestLookups.get(url);
  if (!lookup) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? TOOLCHAIN_REDIRECT_TIMEOUT_MS;
    lookup = fetchManifestOrigins(url, fetchImpl, timeoutMs, log);
    manifestLookups.set(url, lookup);
  }
  const manifestOrigins = (await lookup) ?? [];
  return mergeOrigins(manifestOrigins, builtin);
}

const EXPLICIT_FILE_OVERRIDES = {
  "catalogue.v1.json": "SOLDR_TOOLCHAIN_CATALOGUE_URL",
  "catalogue.v2.json": "SOLDR_TOOLCHAIN_CATALOGUE_V2_URL",
};

/** Whether a failed toolchain request may move on to the next origin. */
function isFailoverStatus(status) {
  return status === 404 || (status >= 500 && status <= 599);
}

/**
 * Fetch one toolchain file (a path relative to the origin, e.g.
 * "cargo-chef/manifest.json") from the first origin that serves it.
 * Resolves to `{ url, body }` where body is the full response bytes.
 */
async function fetchToolchainFile(relativePath, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.fileTimeoutMs ?? TOOLCHAIN_FILE_TIMEOUT_MS;
  const headers = options.headers ?? { Accept: "application/json", "User-Agent": "setup-soldr-action" };
  const relative = String(relativePath).replace(/^\/+/, "");

  const overrideName = EXPLICIT_FILE_OVERRIDES[relative];
  const overrideUrl = overrideName ? envValue(env, overrideName) : "";
  const urls = overrideUrl
    ? [overrideUrl]
    : (await resolveToolchainOrigins(options)).map((origin) => `${origin}/${relative}`);

  const failures = [];
  for (const url of urls) {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      failures.push(`${url}: network error: ${describeError(error)}`);
      continue;
    }
    if (!response.ok) {
      const failure = `${url}: HTTP ${response.status}`;
      if (!isFailoverStatus(response.status)) {
        throw new Error(`soldr toolchain request failed: ${[...failures, failure].join("; ")}`);
      }
      failures.push(failure);
      continue;
    }
    try {
      const body = Buffer.from(await response.arrayBuffer());
      return { url, body };
    } catch (error) {
      failures.push(`${url}: network error: ${describeError(error)}`);
    }
  }
  throw new Error(`soldr toolchain ${relative} unavailable from every origin: ${failures.join("; ")}`);
}

/**
 * Fetch and decode a JSON toolchain file. A body that is not a JSON object
 * is a content error and is not retried against another origin.
 */
async function fetchToolchainJson(relativePath, options = {}) {
  const { url, body } = await fetchToolchainFile(relativePath, options);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(`soldr toolchain ${url} returned invalid JSON`, { cause: error });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`unexpected JSON payload from ${url}`);
  }
  return { url, payload };
}

exports.DEFAULT_TOOLCHAIN_REDIRECT_URL = DEFAULT_TOOLCHAIN_REDIRECT_URL;
exports.BUILTIN_TOOLCHAIN_ORIGINS = BUILTIN_TOOLCHAIN_ORIGINS;
exports.TOOLCHAIN_REDIRECT_TIMEOUT_MS = TOOLCHAIN_REDIRECT_TIMEOUT_MS;
exports.TOOLCHAIN_FILE_TIMEOUT_MS = TOOLCHAIN_FILE_TIMEOUT_MS;
exports.normalizeOrigin = normalizeOrigin;
exports.parseRedirectManifest = parseRedirectManifest;
exports.mergeOrigins = mergeOrigins;
exports.resetToolchainRedirectCache = resetToolchainRedirectCache;
exports.resolveToolchainOrigins = resolveToolchainOrigins;
exports.isFailoverStatus = isFailoverStatus;
exports.fetchToolchainFile = fetchToolchainFile;
exports.fetchToolchainJson = fetchToolchainJson;
