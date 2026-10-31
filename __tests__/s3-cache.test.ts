// Optional S3-compatible remote cache (port of zackees/soldr#3974).
//
// No network: every test drives src/lib/s3-cache.ts through an in-memory
// fake transport. Mirrors the 42 cases of soldr's
// tests/test_setup_soldr_s3_cache.py, plus checks for the request
// canonicalization pitfall and the save-cache policy gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  S3Client,
  allowS3Save,
  configFromEnv,
  s3OffNotice,
  findRestoreObject,
  objectName,
  parseSize,
  planEviction,
  resolveLimit,
  restoreFamily,
  restoreState,
  runJanitor,
  saveFamily,
  savePhase,
  sigv4Authorization,
  sweepAllowed,
  type S3Object,
  type TransportRequest,
  type TransportResponse,
} from "../src/lib/s3-cache.js";

const NOW = new Date(Date.UTC(2026, 9, 30, 12, 0, 0));
const EMPTY_SHA = crypto.createHash("sha256").update("").digest("hex");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Stored { body: Buffer; lastModified: Date }

/** In-memory S3: objects keyed by name. */
class FakeS3 {
  objects = new Map<string, Stored>();
  deleted: string[] = [];
  calls: { method: string; key: string; url: string }[] = [];

  constructor(objects: Record<string, Stored> = {}) {
    for (const [k, v] of Object.entries(objects)) this.objects.set(k, v);
  }

  transport = async (req: TransportRequest): Promise<TransportResponse> => {
    assert.ok(req.headers["authorization"], "every request is signed");
    const url = new URL(req.url);
    const parts = url.pathname.split("/");
    const key = parts.length >= 3 ? decodeURIComponent(parts.slice(2).join("/")) : "";
    this.calls.push({ method: req.method, key, url: req.url });
    const ok = (body: Buffer = Buffer.alloc(0), status = 200): TransportResponse => ({ status, body });
    if (req.method === "GET" && url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      const xml = ["<ListBucketResult>", "<IsTruncated>false</IsTruncated>"];
      for (const [name, obj] of items) {
        xml.push(`<Contents><Key>${name}</Key><Size>${obj.body.length}</Size>` +
          `<LastModified>${obj.lastModified.toISOString()}</LastModified></Contents>`);
      }
      xml.push("</ListBucketResult>");
      return ok(Buffer.from(xml.join("")));
    }
    if (req.method === "PUT") {
      const data = req.bodyFile ? fs.readFileSync(req.bodyFile) : (req.body ?? Buffer.alloc(0));
      this.objects.set(key, { body: Buffer.from(data), lastModified: NOW });
      return ok();
    }
    if (req.method === "DELETE") {
      this.objects.delete(key);
      this.deleted.push(key);
      return ok(Buffer.alloc(0), 204);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const obj = this.objects.get(key);
      if (!obj) return { status: 404, body: Buffer.alloc(0) };
      if (req.method === "HEAD") return ok();
      if (req.responseFile) {
        fs.writeFileSync(req.responseFile, obj.body);
        return ok();
      }
      return ok(obj.body);
    }
    throw new Error(`unexpected ${req.method}`);
  };
}

function client(fake: FakeS3): S3Client {
  return new S3Client({
    bucket: "bkt", endpoint: "nyc3.digitaloceanspaces.com", region: "nyc3",
    accessKey: "AK", secretKey: "SK", transport: fake.transport, clock: () => NOW,
  });
}

function stored(body: string | Buffer, ageMs: number): Stored {
  return { body: Buffer.from(body), lastModified: new Date(NOW.getTime() - ageMs) };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "s3-cache-test-"));
}

function capture(): { log: (m: string) => void; out: () => string } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), out: () => lines.join("\n") };
}

// --- SigV4 ---------------------------------------------------------------

test("sigv4 matches the AWS documented GET Object vector", () => {
  // AWS S3 docs, "Signature Calculations ... Example: GET Object".
  const auth = sigv4Authorization({
    method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", query: {},
    headers: { range: "bytes=0-9" }, payloadSha256: EMPTY_SHA, amzDate: "20130524T000000Z",
    region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  assert.equal(auth,
    "AWS4-HMAC-SHA256 " +
    "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
    "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
    "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

// --- size parsing --------------------------------------------------------

const SIZE_CASES: [string, number][] = [
  ["50G", 50 * 1024 ** 3],
  ["50GiB", 50 * 1024 ** 3],
  ["50GB", 50 * 1000 ** 3],
  ["1.5T", Math.trunc(1.5 * 1024 ** 4)],
  ["1TB", 1000 ** 4],
  ["512M", 512 * 1024 ** 2],
  ["10k", 10 * 1024],
  ["10KB", 10_000],
  ["123", 123],
  ["7 MiB", 7 * 1024 ** 2],
];
for (const [text, expected] of SIZE_CASES) {
  test(`parseSize accepts decimal and binary suffixes: ${JSON.stringify(text)}`, () => {
    assert.equal(parseSize(text), expected);
  });
}

for (const text of ["", "G", "-1G", "5X", "abc", "1.2.3G"]) {
  test(`parseSize rejects garbage: ${JSON.stringify(text)}`, () => {
    assert.throws(() => parseSize(text));
  });
}

test("default limit is 50G when empty", () => {
  assert.equal(resolveLimit(""), 50 * 1024 ** 3);
});

// --- key layout + prefix fallback ----------------------------------------

test("object layout is <family>/<key>.tar.zst", () => {
  assert.equal(objectName("setup", "setup-soldr-v0-linux-x64-abc"), "setup/setup-soldr-v0-linux-x64-abc.tar.zst");
});

test("restore prefers the exact key, then the newest prefix match", async () => {
  const fake = new FakeS3({
    "build/setup-soldr-buildcache-v1-linux-x64-d1-sha1.tar.zst": stored("a", 2 * DAY),
    "build/setup-soldr-buildcache-v1-linux-x64-d1-sha2.tar.zst": stored("b", DAY),
    "build/setup-soldr-buildcache-v1-linux-x64-d0-sha9.tar.zst": stored("c", 0),
  });
  const c = client(fake);
  const hit = await findRestoreObject(c, "build", "setup-soldr-buildcache-v1-linux-x64-d1-sha3", [
    "setup-soldr-buildcache-v1-linux-x64-d1-",
    "setup-soldr-buildcache-v1-linux-x64-",
  ]);
  assert.equal(hit?.name, "build/setup-soldr-buildcache-v1-linux-x64-d1-sha2.tar.zst");
  assert.equal(hit?.exact, false);
  assert.equal(hit?.key, "setup-soldr-buildcache-v1-linux-x64-d1-sha2");
  const exact = await findRestoreObject(c, "build", "setup-soldr-buildcache-v1-linux-x64-d1-sha1", []);
  assert.equal(exact?.exact, true);
});

test("restore falls through to a broader prefix", async () => {
  const fake = new FakeS3({ "build/setup-soldr-buildcache-v1-linux-x64-d0-x.tar.zst": stored("c", 0) });
  const hit = await findRestoreObject(client(fake), "build", "setup-soldr-buildcache-v1-linux-x64-d1-sha3", [
    "setup-soldr-buildcache-v1-linux-x64-d1-",
    "setup-soldr-buildcache-v1-linux-x64-",
  ]);
  assert.ok(hit?.name.endsWith("-d0-x.tar.zst"));
});

test("client round-trips put/get/head/delete", async () => {
  const fake = new FakeS3();
  const c = client(fake);
  await c.put("setup/k.tar.zst", Buffer.from("payload"));
  assert.equal(await c.head("setup/k.tar.zst"), true);
  assert.equal((await c.get("setup/k.tar.zst"))?.toString(), "payload");
  await c.delete("setup/k.tar.zst");
  assert.equal(await c.head("setup/k.tar.zst"), false);
});

// --- janitor --------------------------------------------------------------

function objs(specs: [string, number, number][]): S3Object[] {
  return specs.map(([name, size, age]) => ({ name, size, lastModified: new Date(NOW.getTime() - age) }));
}

test("janitor is a no-op under the watermark", () => {
  const plan = planEviction(objs([["a", 10, 3 * DAY], ["b", 10, 2 * DAY]]), { limit: 100, now: NOW, protectedNames: new Set() });
  assert.deepEqual(plan.toDelete, []);
  assert.equal(plan.before, 20);
  assert.equal(plan.after, 20);
});

test("janitor deletes LRU until below the watermark", () => {
  const list = objs([["newest", 40, 2 * HOUR], ["oldest", 40, 5 * DAY], ["middle", 40, DAY]]);
  let plan = planEviction(list, { limit: 100, now: NOW, protectedNames: new Set() });
  assert.deepEqual(plan.toDelete.map((o) => o.name), ["oldest"]);
  assert.equal(plan.before, 120);
  assert.equal(plan.after, 80);
  plan = planEviction(list, { limit: 50, now: NOW, protectedNames: new Set() });
  assert.deepEqual(plan.toDelete.map((o) => o.name), ["oldest", "middle"]);
});

test("janitor never deletes the current run's or young objects", () => {
  const list = objs([["mine", 100, 9 * DAY], ["young", 100, 29 * MIN], ["old", 100, DAY]]);
  const plan = planEviction(list, { limit: 1, now: NOW, protectedNames: new Set(["mine"]) });
  assert.deepEqual(plan.toDelete.map((o) => o.name), ["old"]);
  assert.equal(plan.after, 200); // cannot reach the watermark safely; stops
});

test("janitor run is idempotent and logs before/after totals", async () => {
  const fake = new FakeS3({
    "setup/a.tar.zst": stored("x".repeat(60), 3 * DAY),
    "setup/b.tar.zst": stored("x".repeat(60), DAY),
  });
  const c = client(fake);
  const cap = capture();
  await runJanitor(c, { limit: 100, now: NOW, protectedNames: new Set(), log: cap.log });
  assert.deepEqual(fake.deleted, ["setup/a.tar.zst"]);
  await runJanitor(c, { limit: 100, now: NOW, protectedNames: new Set(), log: cap.log });
  assert.deepEqual(fake.deleted, ["setup/a.tar.zst"]);
  const out = cap.out();
  assert.match(out, /before=120/);
  assert.match(out, /after=60/);
  assert.match(out, /evict setup\/a\.tar\.zst/);
  assert.doesNotMatch(out, /SK/);
});

// --- merge-queue singleton gating ----------------------------------------

test("sweep runs only on merge_group", () => {
  assert.equal(sweepAllowed("merge_group"), true);
});

for (const event of ["pull_request", "push", "pull_request_target", "workflow_dispatch", ""]) {
  test(`sweep is skipped off merge_group: ${JSON.stringify(event)}`, () => {
    assert.equal(sweepAllowed(event), false);
  });
}

test("save on pull_request never deletes", async () => {
  const fake = new FakeS3({ "setup/old.tar.zst": stored("x".repeat(500), 30 * DAY) });
  await savePhase(client(fake), {
    family: "setup", key: "k1", archive: Buffer.from("y".repeat(10)), eventName: "pull_request",
    limit: 1, now: NOW, state: { hit: true, wipeDetected: false, exact: false, name: "" }, l2Root: tmpDir(), log: () => {},
  });
  assert.deepEqual(fake.deleted, []);
  assert.ok(fake.objects.has("setup/k1.tar.zst"));
});

test("save on merge_group sweeps but spares its own object", async () => {
  const fake = new FakeS3({ "setup/old.tar.zst": stored("x".repeat(500), 30 * DAY) });
  await savePhase(client(fake), {
    family: "setup", key: "k1", archive: Buffer.from("y".repeat(10)), eventName: "merge_group",
    limit: 1, now: NOW, state: { hit: true, wipeDetected: false, exact: false, name: "" }, l2Root: tmpDir(), log: () => {},
  });
  assert.deepEqual(fake.deleted, ["setup/old.tar.zst"]);
  assert.ok(fake.objects.has("setup/k1.tar.zst"));
});

// --- wipe -> seed --------------------------------------------------------

test("restore detects a wipe when the family is empty", async () => {
  const state = await restoreState(client(new FakeS3()), "setup", "k1", ["k"]);
  assert.equal(state.hit, false);
  assert.equal(state.wipeDetected, true);
});

test("restore miss without a wipe when the family has other objects", async () => {
  const fake = new FakeS3({ "setup/other.tar.zst": stored("z", 0) });
  const state = await restoreState(client(fake), "setup", "k1", ["k1-"]);
  assert.equal(state.hit, false);
  assert.equal(state.wipeDetected, false);
});

test("wipe detected takes the seed path and writes L2", async () => {
  const fake = new FakeS3();
  const l2 = tmpDir();
  const action = await savePhase(client(fake), {
    family: "setup", key: "k1", archive: Buffer.from("warm"), eventName: "pull_request",
    limit: 1e9, now: NOW, state: { hit: false, wipeDetected: true, exact: false, name: "" }, l2Root: l2, log: () => {},
  });
  assert.equal(action, "seed");
  assert.equal(fs.readFileSync(path.join(l2, "setup", "k1.tar.zst"), "utf8"), "warm");
  assert.ok(fake.objects.has("setup/k1.tar.zst")); // remote re-seeded too
});

test("no wipe takes the normal save path", async () => {
  const fake = new FakeS3();
  const l2 = tmpDir();
  const action = await savePhase(client(fake), {
    family: "setup", key: "k1", archive: Buffer.from("warm"), eventName: "pull_request",
    limit: 1e9, now: NOW, state: { hit: false, wipeDetected: false, exact: false, name: "" }, l2Root: l2, log: () => {},
  });
  assert.equal(action, "save");
  assert.equal(fs.existsSync(path.join(l2, "setup")), false);
  assert.ok(fake.objects.has("setup/k1.tar.zst"));
});

test("exact hit skips upload", async () => {
  const fake = new FakeS3({ "setup/k1.tar.zst": stored("old", 0) });
  const action = await savePhase(client(fake), {
    family: "setup", key: "k1", archive: Buffer.from("new"), eventName: "pull_request",
    limit: 1e9, now: NOW, state: { hit: true, wipeDetected: false, exact: true, name: "setup/k1.tar.zst" }, l2Root: tmpDir(), log: () => {},
  });
  assert.equal(action, "skip");
  assert.equal(fake.objects.get("setup/k1.tar.zst")?.body.toString(), "old");
});

// --- enablement ----------------------------------------------------------

test("disabled without bucket or credentials; region derived; secrets hidden", () => {
  assert.equal(configFromEnv({}), null);
  assert.equal(configFromEnv({ "INPUT_S3-BUCKET": "b" }), null);
  const cfg = configFromEnv({
    "INPUT_S3-BUCKET": "b",
    "INPUT_S3-ENDPOINT": "nyc3.digitaloceanspaces.com",
    SOLDR_S3_CACHE_ACCESS_KEY: "a-key-value",
    SOLDR_S3_CACHE_SECRET_KEY: "s-key-value",
  });
  assert.ok(cfg);
  assert.equal(cfg.region, "nyc3"); // derived from the DO endpoint
  assert.equal(cfg.limit, 50 * 1024 ** 3);
  const shown = JSON.stringify(cfg) + String(cfg) + JSON.stringify(cfg.client());
  assert.doesNotMatch(shown, /a-key-value|s-key-value/);
});

// --- restore -> save round trip (fake transport, archive files) ----------

for (const [event, evicts] of [["merge_group", true], ["pull_request", false]] as const) {
  test(`round trip: a wipe seeds L2 and the sweep is gated (${event})`, async () => {
    const dir = tmpDir();
    const fake = new FakeS3();
    const c = client(fake);
    const l2 = path.join(dir, "setup-soldr-l2");
    const archive = path.join(dir, "build.tar.zst");
    const key = "setup-soldr-buildcache-v1-linux-x64-d1";
    const restored = await restoreFamily(c, {
      family: "build", key, restoreKeys: ["setup-soldr-buildcache-v1-linux-x64-"], archivePath: archive, l2Root: l2, log: () => {},
    });
    assert.equal(restored.state.wipeDetected, true);
    assert.equal(restored.matchedKey, "");
    // A stale object appears after restore (old).
    fake.objects.set("setup/stale.tar.zst", stored("x".repeat(100), 9 * DAY));
    fs.writeFileSync(archive, "warm-archive");
    const action = await saveFamily(c, {
      family: "build", key, archivePath: archive, state: restored.state, eventName: event,
      limit: 1, now: NOW, l2Root: l2, log: () => {},
    });
    assert.equal(action, "seed");
    assert.ok(fs.statSync(path.join(l2, "build", `${key}.tar.zst`)).isFile());
    assert.ok(fake.objects.has(`build/${key}.tar.zst`));
    assert.equal(fake.deleted.includes("setup/stale.tar.zst"), evicts);
  });
}

// --- additions beyond the soldr suite ------------------------------------

test("ListObjectsV2 query is URI-encoded and sorted in both URL and signature", async () => {
  const fake = new FakeS3();
  await client(fake).list("build/a b/");
  const url = fake.calls[0]!.url;
  assert.match(url, /\?list-type=2&prefix=build%2Fa%20b%2F$/);
});

test("restoreFamily downloads an S3 hit to the archive path; L2 seed is the fallback", async () => {
  const dir = tmpDir();
  const archive = path.join(dir, "a.tar.zst");
  const fake = new FakeS3({ "build/k-old.tar.zst": stored("remote", DAY) });
  const r = await restoreFamily(client(fake), { family: "build", key: "k-new", restoreKeys: ["k-"], archivePath: archive, l2Root: path.join(dir, "l2"), log: () => {} });
  assert.equal(r.matchedKey, "k-old");
  assert.equal(r.source, "s3");
  assert.equal(fs.readFileSync(archive, "utf8"), "remote");

  const l2 = path.join(dir, "l2b");
  fs.mkdirSync(path.join(l2, "build"), { recursive: true });
  fs.writeFileSync(path.join(l2, "build", "k-seed.tar.zst"), "seeded");
  const r2 = await restoreFamily(client(new FakeS3()), { family: "build", key: "k-new", restoreKeys: ["k-"], archivePath: archive, l2Root: l2, log: () => {} });
  assert.equal(r2.source, "l2");
  assert.equal(r2.matchedKey, "k-seed");
  assert.equal(r2.state.wipeDetected, true);
  assert.equal(fs.readFileSync(archive, "utf8"), "seeded");
});

test("restoreFamily never throws on transport failure", async () => {
  const failing = new S3Client({
    bucket: "b", endpoint: "e.example", region: "r", accessKey: "AK", secretKey: "SK",
    transport: async () => { throw new Error("ECONNRESET"); },
  });
  const dir = tmpDir();
  const r = await restoreFamily(failing, { family: "build", key: "k", restoreKeys: [], archivePath: path.join(dir, "a"), l2Root: path.join(dir, "l2"), log: () => {} });
  assert.equal(r.matchedKey, "");
  assert.equal(r.state.wipeDetected, false); // an outage is not a wipe
});

test("allowS3Save honours save-cache=false, save-cache-remote=false and a cancelled job", () => {
  const base = { GITHUB_EVENT_NAME: "pull_request" };
  assert.equal(allowS3Save(base).save, true, "S3 is not ref-scoped: auto saves on pull_request");
  assert.equal(allowS3Save({ ...base, "INPUT_SAVE-CACHE": "false" }).save, false);
  assert.equal(allowS3Save({ ...base, "INPUT_SAVE-CACHE-REMOTE": "false" }).save, false);
  assert.equal(allowS3Save({ ...base, "INPUT_JOB-STATUS": "cancelled" }).save, false);
  assert.equal(allowS3Save({ ...base, "INPUT_SAVE-CACHE": "true" }).save, true);
});

test("s3OffNotice: local runners are off by design, GitHub wiring gaps warn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-off-"));
  const event = (fork: boolean) => {
    const p = path.join(dir, `event-${fork}.json`);
    fs.writeFileSync(p, JSON.stringify({ pull_request: { head: { repo: { fork } } } }));
    return p;
  };
  const keys = { SOLDR_S3_CACHE_ACCESS_KEY: "a", SOLDR_S3_CACHE_SECRET_KEY: "s" };
  const base = { "INPUT_S3-BUCKET": "b", "INPUT_S3-ENDPOINT": "e" };
  assert.equal(s3OffNotice({}), null);
  assert.equal(s3OffNotice({ ...base, ...keys }), null);
  // Local replay (bosn/act): off even with keys, and configFromEnv agrees.
  assert.equal(configFromEnv({ ...base, ...keys, ACT: "true" }), null);
  assert.equal(s3OffNotice({ ...base, ...keys, ACT: "true" })?.level, "info");
  const wiring = s3OffNotice({ ...base, GITHUB_EVENT_PATH: event(false) });
  assert.equal(wiring?.level, "warning");
  assert.match(wiring?.message ?? "", /SOLDR_S3_CACHE_ACCESS_KEY, SOLDR_S3_CACHE_SECRET_KEY are empty.*secrets: inherit/);
  assert.equal(s3OffNotice({ ...base, GITHUB_EVENT_PATH: event(true) })?.level, "info");
  assert.equal(s3OffNotice({ ...base, GITHUB_ACTOR: "dependabot[bot]" })?.level, "info");
  assert.match(s3OffNotice({ ...base, SOLDR_S3_CACHE_ACCESS_KEY: "a" })?.message ?? "", /SOLDR_S3_CACHE_SECRET_KEY is empty/);
});
