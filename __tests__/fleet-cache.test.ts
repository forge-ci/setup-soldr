// forge-ci/setup-soldr#700: the fleet tier must be inert by default, derived
// rather than configured, and incapable of failing a build.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FleetSession,
  SCHEMA,
  configFromEnv,
  deriveIdentity,
  keyFor,
  parseMode,
  type FleetConfig,
} from "../src/lib/fleet-cache.js";

const CONFIG: FleetConfig = {
  url: "http://cache.test",
  family: "app",
  token: "",
  timeoutMs: 500,
};

interface Seen {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

function fakeFetch(handlers: Record<string, (seen: Seen) => { status?: number; body?: unknown; raw?: Uint8Array }>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const record: Seen = {
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    seen.push(record);
    const key = `${method} ${new URL(url).pathname.replace(/[0-9a-f]{32}/g, "<id>")}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    const result = handler(record);
    const status = result.status ?? 200;
    if (result.raw) {
      return new Response(result.raw, { status });
    }
    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("the tier is off with no URL, and off when the mode says so", () => {
  assert.equal(configFromEnv({}), null, "no inputs at all");
  assert.equal(configFromEnv({ "INPUT_FLEET-CACHE": "auto" }), null, "auto without a URL");
  assert.equal(
    configFromEnv({ "INPUT_FLEET-CACHE": "off", FLEET_CACHE_URL: "http://x" }),
    null,
    "an explicit off wins over a live URL",
  );
  assert.equal(
    configFromEnv({ "INPUT_FLEET-CACHE": "sometimes", FLEET_CACHE_URL: "http://x" }),
    null,
    "an unrecognised mode fails closed",
  );
});

test("a configured tier carries the family, strips trailing slashes and defaults its budget", () => {
  const config = configFromEnv({
    "INPUT_FLEET-CACHE": "auto",
    "INPUT_FLEET-CACHE-FAMILY": "app",
    FLEET_CACHE_URL: "http://cache.test/",
    FLEET_CACHE_TIMEOUT_MS: "not-a-number",
  });
  assert.deepEqual(config, { url: "http://cache.test", family: "app", token: "", timeoutMs: 4000 });
});

test("mode parsing accepts the spellings a workflow author will try", () => {
  for (const value of ["auto", "true", "1", "on", ""]) assert.equal(parseMode(value), "auto", value);
  for (const value of ["off", "false", "0", "no"]) assert.equal(parseMode(value), "off", value);
});

test("the identity is derived, stable and free of run-specific values", () => {
  const a = deriveIdentity({
    platform: "linux",
    architecture: "x64",
    configuration: "RelWithDebInfo",
    toolchain: "1.98.1",
  });
  const b = deriveIdentity({
    platform: "Linux",
    architecture: "x64",
    configuration: "relwithdebinfo",
    toolchain: "1.98.1",
  });
  assert.equal(a, b, "case and punctuation must not fork the identity");
  assert.equal(a, `fc-${SCHEMA}-linux-x64-relwithdebinfo-1.98.1`);
  assert.match(a, /^fc-1-/);
  assert.ok(!a.includes("run"), "an identity must not contain a run id");
});

test("the key is repo/family/platform and refuses nonsense", () => {
  assert.deepEqual(
    keyFor({ repository: "obs-rust/obs-studio", family: "app", platform: "linux", architecture: "x64" }),
    { repo: "obs-rust/obs-studio", family: "app", platform: "linux-x64" },
  );
  assert.equal(keyFor({ repository: "obs-studio", family: "app" }), null, "a repo without an owner");
  assert.equal(keyFor({ repository: "a/b", family: "" }), null, "no family");
});

test("a session opens with the derived identity and the job's coordinates", async () => {
  const { impl, seen } = fakeFetch({
    "POST /sessions": () => ({ status: 201, body: { id: "a".repeat(32) } }),
  });
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio",
    identity: "fc-1-linux-x64-debug-1.98.1",
    fetchImpl: impl,
    ref: "refs/heads/master",
    sha: "deadbeef",
    runId: "42",
    job: "ubuntu-build",
  });
  assert.ok(session);
  assert.equal(session.identity, "fc-1-linux-x64-debug-1.98.1");
  assert.equal(session.key.platform, "linux-x64");
  const body = JSON.parse(seen[0]!.body!);
  assert.equal(body.repo, "obs-rust/obs-studio");
  assert.equal(body.family, "app");
  assert.equal(body.ref, "refs/heads/master");
  assert.equal(body.run_id, "42");
});

test("a hit carries the layers a restore must apply", async () => {
  const { impl } = fakeFetch({
    "POST /sessions": () => ({ status: 201, body: { id: "b".repeat(32) } }),
    "POST /sessions/<id>/restore": () => ({
      body: { hit: true, reason: "newest entry s000002 (2 layer(s))", layers: [
        { seq: 1, digest: "sha256:" + "1".repeat(64), bytes: 10, kind: "full" },
        { seq: 2, digest: "sha256:" + "2".repeat(64), bytes: 20, kind: "delta" },
      ] },
    }),
  });
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  const restore = await session!.restore();
  assert.equal(restore.hit, true);
  assert.equal(restore.degraded, false);
  assert.deepEqual(restore.layers.map((layer) => layer.seq), [1, 2]);
});

test("an unreachable service is a degraded miss, not a thrown error", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8787");
  }) as unknown as typeof fetch;
  const opened = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  assert.equal(opened, null, "no session means the tier stays off for this job");
});

test("a session that opens but cannot restore reports degraded", async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ id: "c".repeat(32) }), { status: 201 });
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  const restore = await session!.restore();
  assert.equal(restore.hit, false);
  assert.equal(restore.degraded, true, "degraded is not the same as a verified miss");
});

test("publishing posts the archive bytes and reports the decision", async () => {
  const { impl, seen } = fakeFetch({
    "POST /sessions": () => ({ status: 201, body: { id: "d".repeat(32) } }),
    "POST /sessions/<id>/publish": () => ({
      status: 201,
      body: { kind: "delta", seq: 3, digest: "sha256:" + "3".repeat(64) },
    }),
  });
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  const published = await session!.publish(Buffer.from("layer-bytes"));
  assert.equal(published.published, true);
  assert.equal(published.kind, "delta");
  assert.equal(published.reason, "published delta s000003");
  const publishCall = seen.find((call) => call.url.endsWith("/publish"));
  assert.equal(publishCall?.headers["Content-Type"], "application/octet-stream");
});

test("a failed publish is a warning, never a failed job", async () => {
  const { impl } = fakeFetch({
    "POST /sessions": () => ({ status: 201, body: { id: "e".repeat(32) } }),
    "POST /sessions/<id>/publish": () => ({ status: 507, body: { error: "store is full" } }),
    "POST /sessions/<id>/close": () => ({ body: { status: "closed" } }),
  });
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  const published = await session!.publish(Buffer.from("x"));
  assert.equal(published.published, false);
  assert.match(published.reason, /store is full/);
  await session!.close();   // must not throw either
});

test("close is best effort", async () => {
  const impl = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/sessions")) {
      return new Response(JSON.stringify({ id: "f".repeat(32) }), { status: 201 });
    }
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  await session!.close();   // swallowed, logged
});

test("a download returns the exact bytes the service serves", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { impl } = fakeFetch({
    "POST /sessions": () => ({ status: 201, body: { id: "a1".repeat(16) } }),
    "GET /blobs/sha256:aaaa": () => ({ raw: bytes }),
  });
  const session = await FleetSession.open(CONFIG, {
    repository: "obs-rust/obs-studio", identity: "id", fetchImpl: impl,
  });
  const downloaded = await session!.download("sha256:aaaa");
  assert.deepEqual(new Uint8Array(downloaded), bytes);
});
