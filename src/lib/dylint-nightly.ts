import { createHash } from "node:crypto";

export interface DylintNightlyIdentity {
  channel: string;
  rustVersion: string;
  rustcRelease: string;
  rustcCommitHash: string;
}

interface CatalogueEntry {
  owner: string;
  repo: string;
  tag: string;
  asset: string;
  url: string;
  sha256: string;
}

interface NightlyRow {
  rust_version: string;
  rustc_release: string;
  rustc_commit_hash: string;
}

interface VersionBucket {
  nightlies: string[];
  selected: string;
}

interface NightlyMap {
  schema_version: number;
  nightlies: Record<string, NightlyRow>;
  versions: Record<string, VersionBucket>;
}

export type FetchBytes = (url: string) => Promise<Buffer>;

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { "Accept-Encoding": "identity", "User-Agent": "setup-soldr-action" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function versionKey(channel: string): string {
  const match = channel.trim().match(/^(\d+)\.(\d+)(?:\.\d+)?$/);
  if (!match) {
    throw new Error(
      `cannot map Dylint from Rust channel '${channel}'; expected an exact numeric channel or a dated nightly`,
    );
  }
  return `${match[1]}.${match[2]}`;
}

function selectIdentity(map: NightlyMap, requested: string): DylintNightlyIdentity {
  if (map.schema_version !== 1) {
    throw new Error(`nightly map schema ${map.schema_version} is unsupported`);
  }
  let channel = requested.trim();
  let requestedVersion: string | undefined;
  if (!channel.startsWith("nightly-")) {
    const key = versionKey(channel);
    requestedVersion = key;
    const bucket = map.versions[key];
    if (!bucket) throw new Error(`nightly map has no Rust ${key} bucket`);
    if (bucket.nightlies[0] !== bucket.selected) {
      throw new Error(`nightly map Rust ${key} selection is not its first newest entry`);
    }
    for (let i = 1; i < bucket.nightlies.length; i += 1) {
      if (bucket.nightlies[i - 1]! <= bucket.nightlies[i]!) {
        throw new Error(`nightly map Rust ${key} entries are not descending`);
      }
    }
    channel = bucket.selected;
  }
  const row = map.nightlies[channel];
  if (!row) throw new Error(`nightly map has no identity for ${channel}`);
  if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(channel)) {
    throw new Error(`nightly map selected an invalid channel '${channel}'`);
  }
  if (requestedVersion && row.rust_version !== requestedVersion) {
    throw new Error(
      `nightly map indexed ${channel} under Rust ${requestedVersion} but the row reports ${row.rust_version}`,
    );
  }
  if (!/^\d+\.\d+\.\d+-nightly$/.test(row.rustc_release)) {
    throw new Error(`nightly map has an invalid compiler release for ${channel}`);
  }
  if (!/^[0-9a-f]{40}$/.test(row.rustc_commit_hash)) {
    throw new Error(`nightly map has an invalid compiler commit for ${channel}`);
  }
  return {
    channel,
    rustVersion: row.rust_version,
    rustcRelease: row.rustc_release,
    rustcCommitHash: row.rustc_commit_hash,
  };
}

export async function resolveDylintNightly(
  requested: string,
  env: Record<string, string | undefined>,
  fetchBytes: FetchBytes = defaultFetchBytes,
): Promise<DylintNightlyIdentity> {
  const origin = (env["SOLDR_TOOLCHAIN_ORIGIN"] || DEFAULT_DYLINT_CATALOGUE_ORIGIN)
    .trim()
    .replace(/\/+$/, "");
  const catalogueUrl =
    env["SOLDR_TOOLCHAIN_CATALOGUE_URL"]?.trim() || `${origin}/catalogue.v1.json`;

  let lastDigestError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const separator = catalogueUrl.includes("?") ? "&" : "?";
    const resolvedCatalogueUrl =
      attempt === 0 ? catalogueUrl : `${catalogueUrl}${separator}dylint_retry=${Date.now()}`;
    const catalogue = parseJson<{ entries?: CatalogueEntry[] }>(
      await fetchBytes(resolvedCatalogueUrl),
      "soldr-toolchain catalogue",
    );
    const entry = (catalogue.entries || []).find(
      (row) =>
        row.owner === "zackees" &&
        row.repo === "soldr-toolchain" &&
        row.tag === "assets" &&
        row.asset === "rust-nightly-versions.v1.json",
    );
    if (!entry) throw new Error("soldr-toolchain catalogue has no nightly-version map asset");
    const mapSeparator = entry.url.includes("?") ? "&" : "?";
    const mapUrl =
      attempt === 0 ? entry.url : `${entry.url}${mapSeparator}dylint_retry=${Date.now()}`;
    const mapBytes = await fetchBytes(mapUrl);
    const actual = createHash("sha256").update(mapBytes).digest("hex");
    if (actual !== entry.sha256) {
      lastDigestError = `nightly-version map digest mismatch: expected ${entry.sha256}, got ${actual}`;
      continue;
    }
    return selectIdentity(parseJson<NightlyMap>(mapBytes, "nightly-version map"), requested);
  }
  throw new Error(`${lastDigestError}; catalogue was refreshed once and unverified bytes were rejected`);
}

// Dylint's small, SHA-pinned metadata catalogue is published directly from
// the assets branch. This is deliberately not exported to Soldr itself: its
// full SDK catalogue has a separate publication endpoint and lifecycle.
export const DEFAULT_DYLINT_CATALOGUE_ORIGIN =
  "https://raw.githubusercontent.com/zackees/soldr-toolchain/assets";
