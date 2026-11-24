/**
 * The fleet cache tier (forge-ci/cache, forge-ci/setup-soldr#700).
 *
 * A fourth tier beside actions/cache, the cook registry and the S3 remote: a
 * session-oriented store that a `merge_group` run may *publish* to, which the
 * Actions cache structurally cannot (every save is gated on a default-branch
 * push).
 *
 * The whole point of putting it here rather than asking each workflow to call a
 * CLI: anything a workflow author could get wrong is computed, not passed.
 *
 * - `fleet-cache: auto|off` turns the tier on; **no URL means off**, the same
 *   rule that makes `s3-bucket` safe with no bucket or credentials.
 * - `fleet-cache-family` is the only thing a human names (a lane is "app", not
 *   "tier2"); getting it wrong only splits keys, it does not break correctness.
 * - The **identity is never an input**: it is derived here from the runner and
 *   the resolved toolchain, so a producer cannot publish under an identity no
 *   consumer computes.
 *
 * Failure semantics are the design's: a cache must never be able to fail a
 * build. Every operation is fail-open — an unreachable service, an absent entry
 * or an identity mismatch is a *miss with a logged reason*, and publishing is a
 * warning at worst.
 */
import { hostname, platform as osPlatform, arch as osArch } from "node:os";

export const SCHEMA = 1;

export type FleetMode = "auto" | "off";

export interface FleetConfig {
  /** Session endpoint, e.g. `http://127.0.0.1:8787`. No URL means the tier is off. */
  url: string;
  /** The build type: "app", "tier2", "rust-tests", ... */
  family: string;
  /** Optional bearer token for a service that requires one. */
  token: string;
  /** Per-request budget. A cache probe must never dominate a job. */
  timeoutMs: number;
}

export interface FleetLayer {
  seq: number;
  digest: string;
  bytes: number;
  kind: "full" | "delta";
}

export interface FleetRestore {
  hit: boolean;
  reason: string;
  layers: FleetLayer[];
  identity: string;
  /** True when the tier was on but unusable: callers must not treat it as a verified miss. */
  degraded: boolean;
}

export interface FleetPublish {
  published: boolean;
  kind?: "full" | "delta";
  seq?: number;
  digest?: string;
  reason: string;
}

export type FetchLike = typeof fetch;

/** `auto` is the default; anything unrecognised fails closed to `off`. */
export function parseMode(raw: string | undefined): FleetMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "auto" || value === "true" || value === "1" || value === "on") return "auto";
  return "off";
}

/**
 * Resolve the tier from the process environment.
 *
 * `INPUT_FLEET-CACHE` is how the runner passes a hyphenated input to a step;
 * the test seam also accepts the unhyphenated spelling.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): FleetConfig | null {
  const mode = parseMode(env["INPUT_FLEET-CACHE"] ?? env["INPUT_FLEET_CACHE"]);
  if (mode === "off") return null;
  const url = (env["FLEET_CACHE_URL"] ?? "").trim();
  if (!url) return null;
  const timeout = Number.parseInt(env["FLEET_CACHE_TIMEOUT_MS"] ?? "", 10);
  return {
    url: url.replace(/\/+$/, ""),
    family: (env["INPUT_FLEET-CACHE-FAMILY"] ?? env["INPUT_FLEET_CACHE_FAMILY"] ?? "").trim(),
    token: (env["FLEET_CACHE_TOKEN"] ?? "").trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 4000,
  };
}

/**
 * The compatibility contract, derived rather than supplied.
 *
 * Every component that can change what the build produces is in here; nothing
 * that changes per run (commit, run id, job name) is. A cache published under
 * one identity is invisible to a consumer computing another, which is why this
 * is computed in one place instead of being an action input.
 */
export function deriveIdentity(parts: {
  platform?: string;
  architecture?: string;
  configuration?: string;
  toolchain?: string;
}): string {
  const normalise = (value: string | undefined, fallback: string): string =>
    (value ?? fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  return [
    "fc",
    String(SCHEMA),
    normalise(parts.platform ?? osPlatform(), "unknown"),
    normalise(parts.architecture ?? osArch(), "unknown"),
    normalise(parts.configuration, "default"),
    normalise(parts.toolchain, "notoolchain"),
  ].join("-");
}

/** The store key: repo + family + platform. A repo without a slash is refused. */
export function keyFor(parts: {
  repository: string;
  family: string;
  platform?: string;
  architecture?: string;
}): { repo: string; family: string; platform: string } | null {
  const repo = (parts.repository ?? "").trim();
  const family = (parts.family ?? "").trim();
  if (!repo.includes("/") || !family) return null;
  const platformPart = (parts.platform ?? osPlatform()).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const archPart = (parts.architecture ?? osArch()).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return { repo, family, platform: `${platformPart}-${archPart}` };
}

class FleetUnavailable extends Error {}

async function call(
  config: FleetConfig,
  fetchImpl: FetchLike,
  method: string,
  path: string,
  body?: string | Uint8Array,
  contentType = "application/json",
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.url}${path}`, {
      method,
      body,
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": contentType }),
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        "User-Agent": `setup-soldr-fleet-cache/${SCHEMA} ${hostname()}`,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* not JSON: keep the raw prefix */
      }
      throw new FleetUnavailable(`${response.status} ${path}: ${message}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A session is one build's cache lifecycle. Restores and publishes share it, so
 * the service can log the whole job and replay it later.
 */
export class FleetSession {
  // Plain fields rather than constructor parameter properties: this estate runs
  // tests with `--experimental-strip-types`, which erases types instead of
  // transforming them, so only erasable TypeScript syntax is usable here.
  private readonly config: FleetConfig;
  private readonly fetchImpl: FetchLike;
  private readonly id: string;
  readonly identity: string;
  readonly key: { repo: string; family: string; platform: string };

  private constructor(
    config: FleetConfig,
    fetchImpl: FetchLike,
    id: string,
    identity: string,
    key: { repo: string; family: string; platform: string },
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.id = id;
    this.identity = identity;
    this.key = key;
  }

  static async open(
    config: FleetConfig,
    options: {
      repository: string;
      identity: string;
      fetchImpl?: FetchLike;
      ref?: string;
      sha?: string;
      runId?: string;
      job?: string;
    },
  ): Promise<FleetSession | null> {
    const key = keyFor({ repository: options.repository, family: config.family });
    if (key === null) return null;
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const created = (await call(config, fetchImpl, "POST", "/sessions", JSON.stringify({
        ...key,
        identity: options.identity,
        ref: options.ref ?? process.env["GITHUB_REF"] ?? "",
        sha: options.sha ?? process.env["GITHUB_SHA"] ?? "",
        run_id: options.runId ?? process.env["GITHUB_RUN_ID"] ?? "",
        job: options.job ?? process.env["GITHUB_JOB"] ?? "",
      }))) as { id?: string };
      if (!created?.id) return null;
      return new FleetSession(config, fetchImpl, created.id, options.identity, key);
    } catch (error) {
      warn("open", error);
      return null;
    }
  }

  get sessionId(): string {
    return this.id;
  }

  /**
   * Ask the service what to restore. Never throws: an unreachable service is a
   * `degraded` miss, which is different from "the store says there is nothing".
   */
  async restore(): Promise<FleetRestore> {
    const miss = (reason: string, degraded = false): FleetRestore => ({
      hit: false,
      reason,
      layers: [],
      identity: this.identity,
      degraded,
    });
    try {
      const decision = (await call(this.config, this.fetchImpl, "POST",
        `/sessions/${this.id}/restore`)) as {
          hit?: boolean;
          reason?: string;
          layers?: FleetLayer[];
        };
      return {
        hit: decision.hit === true,
        reason: decision.reason ?? "",
        layers: Array.isArray(decision.layers) ? decision.layers : [],
        identity: this.identity,
        degraded: false,
      };
    } catch (error) {
      warn("restore", error);
      return miss(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** Download one layer's bytes. Throws: a caller that asked for bytes must know. */
  async download(digest: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs * 10);
    try {
      const response = await this.fetchImpl(`${this.config.url}/blobs/${digest}`, {
        signal: controller.signal,
        headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
      });
      if (!response.ok) throw new FleetUnavailable(`${response.status} /blobs/${digest}`);
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  /** Publish this build's archive. A failure is a warning, never a failed job. */
  async publish(data: Buffer): Promise<FleetPublish> {
    try {
      const result = (await call(this.config, this.fetchImpl, "POST",
        `/sessions/${this.id}/publish`, new Uint8Array(data),
        "application/octet-stream")) as { kind?: "full" | "delta"; seq?: number; digest?: string };
      return {
        published: true,
        kind: result.kind,
        seq: result.seq,
        digest: result.digest,
        reason: `published ${result.kind ?? "layer"} s${String(result.seq ?? 0).padStart(6, "0")}`,
      };
    } catch (error) {
      warn("publish", error);
      return { published: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Seal the session. Best effort: the record is for replay, not for correctness. */
  async close(outcome: "closed" | "failed" = "closed", detail = ""): Promise<void> {
    try {
      await call(this.config, this.fetchImpl, "POST", `/sessions/${this.id}/close`,
        JSON.stringify({ outcome, detail }));
    } catch (error) {
      warn("close", error);
    }
  }
}

function warn(stage: string, error: unknown): void {
  // Never `core.setFailed`: a cache must not be able to fail a build.
  const message = error instanceof Error ? error.message : String(error);
  console.log(`fleet-cache: ${stage} unavailable, continuing cold: ${message}`);
}
