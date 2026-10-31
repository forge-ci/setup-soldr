/**
 * Optional S3-compatible remote cache (port of zackees/soldr#3974).
 *
 * Off unless the caller sets the `s3-bucket` and `s3-endpoint` inputs *and*
 * the job exports `SOLDR_S3_CACHE_ACCESS_KEY` / `SOLDR_S3_CACHE_SECRET_KEY`
 * from workflow secrets. Without them every entry point here is a no-op and
 * the action keeps using actions/cache exactly as before.
 *
 * Layout: `<family>/<key>.tar.zst`, where `key` is the cache key this action
 * already computed, so its restore-key prefixes become `ListObjectsV2`
 * prefixes (newest `LastModified` wins, as with actions/cache).
 *
 * Eviction is owned by the merge-queue singleton: only a `merge_group` run
 * sweeps the bucket down to `s3-cache-limit`. Every other run only reads and
 * writes its own keys, so concurrent runs never race a sweep.
 *
 * When restore finds a family completely empty the remote was wiped; the
 * post step then *seeds* the runner-local L2 directory with its archive (and
 * re-uploads) instead of dropping the work.
 *
 * Zero runtime dependencies: node:crypto for SigV4, global fetch for I/O.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isLocalRunner } from "./local-profile.js";
import { readDependencyLayerSaveGate } from "./failed-job-save.js";
import { parseSaveCacheMode } from "./save-policy.js";

export const ACCESS_KEY_ENV = "SOLDR_S3_CACHE_ACCESS_KEY";
export const SECRET_KEY_ENV = "SOLDR_S3_CACHE_SECRET_KEY";
export const DEFAULT_LIMIT = "50G";
export const MIN_EVICT_AGE_MS = 30 * 60 * 1000;
export const FAMILIES = ["setup", "build"] as const;
export const SINGLETON_EVENT = "merge_group";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const SUFFIX = ".tar.zst";

type Log = (msg: string) => void;

// --- size parsing -----------------------------------------------------------

const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(I?B?)\s*$/i;
const EXP: Record<string, number> = { "": 0, K: 1, M: 2, G: 3, T: 4 };

/** `50G`/`50GiB` are binary, `50GB` decimal, bare digits are bytes. */
export function parseSize(text: string): number {
  const m = SIZE_RE.exec(text ?? "");
  if (!m) throw new Error(`invalid size ${JSON.stringify(text)}; expected e.g. 50G, 512MiB, 1TB`);
  const unit = m[2]!.toUpperCase();
  const tail = m[3]!.toUpperCase();
  if (!unit && tail !== "" && tail !== "B") throw new Error(`invalid size ${JSON.stringify(text)}`);
  const base = tail === "B" && unit ? 1000 : 1024;
  return Math.trunc(Number(m[1]) * base ** EXP[unit]!);
}

export function resolveLimit(text: string): number {
  return parseSize(text.trim() || DEFAULT_LIMIT);
}

// --- SigV4 ------------------------------------------------------------------

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function uriEncode(value: string, keepSlash = false): string {
  const out = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, "/") : out;
}

/**
 * Canonical query string: every name and value URI-encoded, then sorted.
 * The request URL reuses this exact string so the signed and sent forms can
 * never drift (an unencoded `prefix=a/b/` is a 403 that looks like a
 * permissions bug).
 */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

const hmac = (key: crypto.BinaryLike, msg: string): Buffer => crypto.createHmac("sha256", key).update(msg, "utf8").digest();
const sha256Hex = (data: crypto.BinaryLike): string => crypto.createHash("sha256").update(data).digest("hex");

export function sigv4Authorization(opts: {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadSha256: string;
  amzDate: string;
  region: string;
  accessKey: string;
  secretKey: string;
  service?: string;
}): string {
  const service = opts.service ?? "s3";
  const signed: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) signed[k.toLowerCase()] = String(v).trim();
  signed["host"] = opts.host;
  signed["x-amz-content-sha256"] = opts.payloadSha256;
  signed["x-amz-date"] = opts.amzDate;
  const names = Object.keys(signed).sort();
  const canonical = [
    opts.method,
    uriEncode(opts.path, true),
    canonicalQuery(opts.query),
    names.map((n) => `${n}:${signed[n]}\n`).join(""),
    names.join(";"),
    opts.payloadSha256,
  ].join("\n");
  const day = opts.amzDate.slice(0, 8);
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", opts.amzDate, scope, sha256Hex(canonical)].join("\n");
  let key = hmac(`AWS4${opts.secretKey}`, day);
  for (const part of [opts.region, service, "aws4_request"]) key = hmac(key, part);
  const signature = crypto.createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope},SignedHeaders=${names.join(";")},Signature=${signature}`;
}

// --- transport + client -------------------------------------------------------

export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** Stream this file as the request body. */
  bodyFile?: string;
  /** Stream a 2xx response body into this file instead of buffering it. */
  responseFile?: string;
}

export interface TransportResponse {
  status: number;
  body: Buffer;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export const fetchTransport: Transport = async (req) => {
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers: req.headers };
  if (req.bodyFile) {
    init.body = Readable.toWeb(fs.createReadStream(req.bodyFile)) as unknown as RequestInit["body"];
    init.duplex = "half";
  } else if (req.body) {
    init.body = req.body;
  }
  const res = await fetch(req.url, { ...init, signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (req.responseFile && res.ok && res.body) {
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(req.responseFile));
    return { status: res.status, body: Buffer.alloc(0) };
  }
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

export class S3Error extends Error {}

export interface S3Object {
  name: string;
  size: number;
  lastModified: Date;
}

export interface S3ClientOptions {
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  transport?: Transport;
  clock?: () => Date;
}

/** Path-style S3 client: `https://<endpoint>/<bucket>/<key>`. */
export class S3Client {
  readonly bucket: string;
  readonly host: string;
  readonly #region: string;
  readonly #accessKey: string;
  readonly #secretKey: string;
  readonly #transport: Transport;
  readonly #clock: () => Date;

  constructor(opts: S3ClientOptions) {
    this.bucket = opts.bucket;
    this.host = opts.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.#region = opts.region;
    this.#accessKey = opts.accessKey;
    this.#secretKey = opts.secretKey;
    this.#transport = opts.transport ?? fetchTransport;
    this.#clock = opts.clock ?? (() => new Date());
  }

  toString(): string { // never expose credentials
    return `S3Client(bucket=${this.bucket}, endpoint=${this.host})`;
  }

  toJSON(): Record<string, string> {
    return { bucket: this.bucket, endpoint: this.host };
  }

  async #request(method: string, key = "", opts: {
    query?: Record<string, string>; body?: Buffer; bodyFile?: string; responseFile?: string;
  } = {}): Promise<TransportResponse> {
    const query = opts.query ?? {};
    const urlPath = `/${this.bucket}${key ? `/${key}` : ""}`;
    const amzDate = this.#clock().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const headers: Record<string, string> = {};
    let payload: string;
    if (opts.bodyFile) {
      payload = UNSIGNED_PAYLOAD;
      headers["content-length"] = String(fs.statSync(opts.bodyFile).size);
    } else {
      payload = sha256Hex(opts.body ?? Buffer.alloc(0));
    }
    const authorization = sigv4Authorization({
      method, host: this.host, path: urlPath, query, headers, payloadSha256: payload, amzDate,
      region: this.#region, accessKey: this.#accessKey, secretKey: this.#secretKey,
    });
    const qs = canonicalQuery(query);
    const url = `https://${this.host}${uriEncode(urlPath, true)}${qs ? `?${qs}` : ""}`;
    return this.#transport({
      method, url, body: opts.body, bodyFile: opts.bodyFile, responseFile: opts.responseFile,
      headers: { ...headers, "x-amz-date": amzDate, "x-amz-content-sha256": payload, authorization },
    });
  }

  async put(name: string, data: Buffer | string): Promise<void> {
    const res = typeof data === "string"
      ? await this.#request("PUT", name, { bodyFile: data })
      : await this.#request("PUT", name, { body: data });
    if (res.status >= 300) throw new S3Error(`PUT ${name} -> HTTP ${res.status}: ${res.body.subarray(0, 200).toString()}`);
  }

  async get(name: string): Promise<Buffer | null> {
    const res = await this.#request("GET", name);
    if (res.status === 404) return null;
    if (res.status >= 300) throw new S3Error(`GET ${name} -> HTTP ${res.status}`);
    return res.body;
  }

  /** Stream an object to `dest`. False when the object is gone. */
  async download(name: string, dest: string): Promise<boolean> {
    const res = await this.#request("GET", name, { responseFile: dest });
    if (res.status === 404) return false;
    if (res.status >= 300) throw new S3Error(`GET ${name} -> HTTP ${res.status}`);
    return true;
  }

  async head(name: string): Promise<boolean> {
    const res = await this.#request("HEAD", name);
    if (res.status === 404) return false;
    if (res.status >= 300) throw new S3Error(`HEAD ${name} -> HTTP ${res.status}`);
    return true;
  }

  async delete(name: string): Promise<void> {
    const res = await this.#request("DELETE", name);
    if (res.status >= 300 && res.status !== 404) throw new S3Error(`DELETE ${name} -> HTTP ${res.status}`);
  }

  async list(prefix = ""): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token = "";
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const res = await this.#request("GET", "", { query });
      if (res.status >= 300) throw new S3Error(`LIST ${JSON.stringify(prefix)} -> HTTP ${res.status}`);
      const xml = res.body.toString("utf8");
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const name = xmlText(m[1]!, "Key");
        const modified = xmlText(m[1]!, "LastModified");
        if (!name || !modified) continue;
        out.push({ name, size: Number(xmlText(m[1]!, "Size") || "0"), lastModified: new Date(modified) });
      }
      const truncated = xmlText(xml, "IsTruncated").toLowerCase() === "true";
      token = xmlText(xml, "NextContinuationToken");
      if (!truncated || !token) return out;
    }
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function xmlText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]!) : "";
}

// --- key layout / restore -------------------------------------------------------

export function objectName(family: string, key: string): string {
  return `${family}/${key}${SUFFIX}`;
}

/** Inverse of `objectName`: the cache key an object was saved under. */
export function keyOfObject(family: string, name: string): string {
  const prefix = `${family}/`;
  const inner = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return inner.endsWith(SUFFIX) ? inner.slice(0, -SUFFIX.length) : inner;
}

export interface RestoreHit {
  name: string;
  key: string;
  exact: boolean;
}

export interface S3RestoreState {
  hit: boolean;
  wipeDetected: boolean;
  exact: boolean;
  name: string;
}

const newestFirst = (a: { lastModified: Date; name: string }, b: { lastModified: Date; name: string }): number =>
  b.lastModified.getTime() - a.lastModified.getTime() || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

export async function findRestoreObject(
  client: S3Client, family: string, key: string, restorePrefixes: string[],
): Promise<RestoreHit | null> {
  const exact = objectName(family, key);
  if (await client.head(exact)) return { name: exact, key, exact: true };
  for (const prefix of restorePrefixes) {
    if (!prefix) continue;
    const found = (await client.list(`${family}/${prefix}`)).filter((o) => o.name.endsWith(SUFFIX)).sort(newestFirst);
    if (found[0]) return { name: found[0].name, key: keyOfObject(family, found[0].name), exact: false };
  }
  return null;
}

export async function restoreState(
  client: S3Client, family: string, key: string, restorePrefixes: string[],
): Promise<S3RestoreState> {
  const hit = await findRestoreObject(client, family, key, restorePrefixes);
  if (hit) return { hit: true, wipeDetected: false, exact: hit.exact, name: hit.name };
  // A miss in a family that still holds other objects is an ordinary cold
  // key; a family with *nothing* in it means the remote was wiped.
  const rest = await client.list(`${family}/`);
  return { hit: false, wipeDetected: rest.length === 0, exact: false, name: "" };
}

// --- janitor ----------------------------------------------------------------------

/** Only the serialized merge-queue run may evict (decentralized safety). */
export function sweepAllowed(eventName: string): boolean {
  return eventName === SINGLETON_EVENT;
}

export interface EvictionPlan {
  before: number;
  after: number;
  toDelete: S3Object[];
}

export function planEviction(
  objects: S3Object[], opts: { limit: number; now: Date; protectedNames: Set<string> },
): EvictionPlan {
  const total = objects.reduce((n, o) => n + o.size, 0);
  const plan: EvictionPlan = { before: total, after: total, toDelete: [] };
  if (total < opts.limit) return plan;
  const candidates = objects
    .filter((o) => !opts.protectedNames.has(o.name) && opts.now.getTime() - o.lastModified.getTime() >= MIN_EVICT_AGE_MS)
    .sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime() || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const obj of candidates) {
    if (plan.after < opts.limit) break;
    plan.toDelete.push(obj);
    plan.after -= obj.size;
  }
  return plan;
}

export async function runJanitor(
  client: S3Client, opts: { limit: number; now: Date; protectedNames: Set<string>; log: Log },
): Promise<EvictionPlan> {
  const objects: S3Object[] = [];
  for (const family of FAMILIES) objects.push(...(await client.list(`${family}/`)));
  const plan = planEviction(objects, opts);
  opts.log(`s3-cache janitor: limit=${opts.limit} before=${plan.before} after=${plan.after}`);
  for (const obj of plan.toDelete) {
    opts.log(`s3-cache janitor: evict ${obj.name} size=${obj.size} last_modified=${obj.lastModified.toISOString()}`);
    await client.delete(obj.name);
  }
  if (plan.toDelete.length === 0) opts.log("s3-cache janitor: nothing to evict");
  return plan;
}

// --- save -------------------------------------------------------------------------

export function seedL2(l2Root: string, family: string, key: string, archive: Buffer | string): string {
  const dest = path.join(l2Root, objectName(family, key));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (typeof archive === "string") fs.copyFileSync(archive, dest);
  else fs.writeFileSync(dest, archive);
  return dest;
}

export type SaveAction = "skip" | "seed" | "save";

/** Returns `skip` (exact hit), `seed` (wipe detected) or `save`. */
export async function savePhase(client: S3Client, opts: {
  family: string;
  key: string;
  /** Archive bytes, or the path of an archive file. */
  archive: Buffer | string;
  eventName: string;
  limit: number;
  now: Date;
  state: S3RestoreState;
  l2Root: string;
  protectedNames?: Set<string>;
  log: Log;
}): Promise<SaveAction> {
  const name = objectName(opts.family, opts.key);
  const protectedNames = new Set([...(opts.protectedNames ?? []), name]);
  let action: SaveAction;
  if (opts.state.exact) {
    action = "skip";
    opts.log(`s3-cache: exact hit for ${name}; not re-uploading`);
  } else {
    if (opts.state.wipeDetected) {
      action = "seed";
      const dest = seedL2(opts.l2Root, opts.family, opts.key, opts.archive);
      opts.log(`s3-cache: remote wipe detected; seeded L2 cache at ${dest}`);
    } else {
      action = "save";
    }
    await client.put(name, opts.archive);
    opts.log(`s3-cache: uploaded ${name}`);
  }
  if (sweepAllowed(opts.eventName)) {
    await runJanitor(client, { limit: opts.limit, now: opts.now, protectedNames, log: opts.log });
  } else {
    opts.log(`s3-cache: eviction skipped on ${opts.eventName || "unknown"} (merge_group only)`);
  }
  return action;
}

// --- config / policy ---------------------------------------------------------------

export interface S3Config {
  bucket: string;
  endpoint: string;
  region: string;
  limit: number;
  client(transport?: Transport): S3Client;
}

type Env = Record<string, string | undefined>;

function input(env: Env, name: string): string {
  const upper = name.toUpperCase();
  return (env[`INPUT_${upper}`] ?? env[`INPUT_${upper.replace(/-/g, "_")}`] ?? "").trim();
}

/** Null (feature off) unless bucket, endpoint and both credentials are set. */
export function configFromEnv(env: Env): S3Config | null {
  const bucket = input(env, "s3-bucket");
  const endpoint = input(env, "s3-endpoint");
  const accessKey = (env[ACCESS_KEY_ENV] ?? "").trim();
  const secretKey = (env[SECRET_KEY_ENV] ?? "").trim();
  if (!(bucket && endpoint && accessKey && secretKey) || isLocalRunner(env)) return null;
  let region = input(env, "s3-region");
  if (!region) {
    const host = endpoint.replace(/^https?:\/\//, "");
    region = /^([a-z0-9-]+)\.digitaloceanspaces\.com/.exec(host)?.[1] ?? "us-east-1";
  }
  const limit = resolveLimit(input(env, "s3-cache-limit"));
  // Credentials live only in this closure: never on an enumerable property.
  return {
    bucket, endpoint, region, limit,
    client: (transport?: Transport) => new S3Client({ bucket, endpoint, region, accessKey, secretKey, transport }),
  };
}

/**
 * Why S3 is off although the caller configured a bucket, or null. A local
 * runner (bosn/act replay, `ACT=true`) never uses the shared bucket, by
 * design, even when keys are present. On GitHub, missing keys are expected
 * for fork and Dependabot pull requests (info); anywhere else they are a
 * wiring bug, e.g. a reusable workflow called without `secrets: inherit`.
 */
export function s3OffNotice(env: Env): { level: "info" | "warning"; message: string } | null {
  if (!(input(env, "s3-bucket") && input(env, "s3-endpoint"))) return null;
  if (isLocalRunner(env)) {
    return { level: "info", message: "s3-cache: off on a local runner (ACT=true) by design; using the local cache" };
  }
  const missing = [ACCESS_KEY_ENV, SECRET_KEY_ENV].filter((k) => !(env[k] ?? "").trim());
  if (!missing.length) return null;
  const message = `s3-cache: off: s3-bucket is set but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} empty; using actions/cache`;
  if (secretsWithheldByGitHub(env)) return { level: "info", message: `${message} (secrets are withheld from fork and Dependabot pull requests)` };
  return { level: "warning", message: `${message}. Export both secrets as job env; a reusable workflow needs \`secrets: inherit\` from its caller` };
}

/** Fork or Dependabot pull request: GitHub withholds repository secrets. */
function secretsWithheldByGitHub(env: Env): boolean {
  if ((env["GITHUB_ACTOR"] ?? "") === "dependabot[bot]") return true;
  const eventPath = env["GITHUB_EVENT_PATH"];
  if (!eventPath) return false;
  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8")) as { pull_request?: { head?: { repo?: { fork?: unknown } } } };
    return payload.pull_request?.head?.repo?.fork === true;
  } catch {
    return false;
  }
}

/** The credential values, for `core.setSecret` masking by the caller. */
export function credentialValues(env: Env): string[] {
  return [env[ACCESS_KEY_ENV], env[SECRET_KEY_ENV]].map((v) => (v ?? "").trim()).filter(Boolean);
}

/**
 * S3 upload gate. The bucket is not ref-scoped, so the `pull_request` skip
 * that `save-cache: auto` applies to Actions cache (setup-soldr#527) does not
 * apply: a pull request writes its own keys. Explicit `save-cache: false`,
 * `save-cache-remote: false` and a cancelled job still forbid the upload.
 */
export function allowS3Save(env: Env): { save: boolean; reason: string } {
  let mode;
  let remote;
  try {
    mode = parseSaveCacheMode(env["INPUT_SAVE-CACHE"], "auto");
    remote = parseSaveCacheMode(env["INPUT_SAVE-CACHE-REMOTE"], "auto");
  } catch (err) {
    return { save: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (mode === "false") return { save: false, reason: "save-cache=false" };
  if (remote === "false") return { save: false, reason: "save-cache-remote=false" };
  try {
    const gate = readDependencyLayerSaveGate(env);
    if (!gate.save) return gate;
  } catch (err) {
    return { save: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { save: true, reason: `save-cache=${mode}` };
}

/** Runner-local L2 seed directory (sibling of the action cache root). */
export function l2RootFor(env: Env, cacheRoot: string): string {
  const explicit = (env["SOLDR_S3_L2_DIR"] ?? "").trim();
  return explicit || path.join(path.dirname(cacheRoot), "setup-soldr-l2");
}

// --- family-level entry points (main / post) ----------------------------------------

function l2Lookup(l2Root: string, family: string, key: string, prefixes: string[]): string | null {
  const exact = path.join(l2Root, objectName(family, key));
  if (fs.existsSync(exact)) return exact;
  const dir = path.join(l2Root, family);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const found = entries
      .filter((f) => f.startsWith(prefix) && f.endsWith(SUFFIX))
      .map((f) => ({ name: f, lastModified: fs.statSync(path.join(dir, f)).mtime }))
      .sort(newestFirst);
    if (found[0]) return path.join(dir, found[0].name);
  }
  return null;
}

export interface FamilyRestore {
  state: S3RestoreState;
  /** Key of the archive written to `archivePath`; empty on a miss. */
  matchedKey: string;
  source: "s3" | "l2" | "none";
}

/**
 * Restore one family's archive file from S3, else from the L2 seed. Never
 * throws: an outage degrades to a miss (and is not mistaken for a wipe).
 */
export async function restoreFamily(client: S3Client, opts: {
  family: string; key: string; restoreKeys: string[]; archivePath: string; l2Root: string; log: Log;
}): Promise<FamilyRestore> {
  const { family, key, restoreKeys, archivePath, l2Root, log } = opts;
  let state: S3RestoreState = { hit: false, wipeDetected: false, exact: false, name: "" };
  try {
    state = await restoreState(client, family, key, restoreKeys);
    if (state.hit) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      if (await client.download(state.name, archivePath)) {
        log(`s3-cache: restored ${family} from s3://${client.bucket}/${state.name}`);
        return { state, matchedKey: keyOfObject(family, state.name), source: "s3" };
      }
      state = { ...state, hit: false, exact: false, name: "" };
    }
  } catch (err) {
    log(`s3-cache: restore ${family} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (state.wipeDetected) log(`s3-cache: ${family} family is empty remotely (wipe detected); save will seed L2`);
  try {
    const seed = l2Lookup(l2Root, family, key, [key, ...restoreKeys]);
    if (seed) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.copyFileSync(seed, archivePath);
      log(`s3-cache: restored ${family} from L2 seed ${seed}`);
      return { state, matchedKey: keyOfObject(family, path.basename(seed)), source: "l2" };
    }
  } catch (err) {
    log(`s3-cache: L2 restore ${family} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { state, matchedKey: "", source: "none" };
}

/** Upload one family's archive file; seed L2 on a wipe; sweep on merge_group. */
export async function saveFamily(client: S3Client, opts: {
  family: string; key: string; archivePath: string; state: S3RestoreState; eventName: string;
  limit: number; now?: Date; l2Root: string; log: Log;
}): Promise<SaveAction> {
  return savePhase(client, {
    family: opts.family, key: opts.key, archive: opts.archivePath, eventName: opts.eventName,
    limit: opts.limit, now: opts.now ?? new Date(), state: opts.state, l2Root: opts.l2Root, log: opts.log,
  });
}
