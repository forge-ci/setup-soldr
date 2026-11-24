// The lifecycle: publish a real cache dir, then restore it into a fresh one.
// This is the only test that exercises the archive format end to end, so it is
// what keeps `restoreFleetCache` from "succeeding" while putting the tree in the
// wrong place (the double-nesting failure zccache hit before).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  publishFleetCache,
  restoreFleetCache,
  type FleetPhaseOptions,
} from "../src/lib/fleet-cache-phase.js";
import type { FleetConfig } from "../src/lib/fleet-cache.js";

interface StoredLayer {
  seq: number;
  digest: string;
  bytes: number;
  kind: "full" | "delta";
}

interface FakeSession {
  identity: string;
  closed: string[];
}

/**
 * The service, in memory: sessions, restore decisions, publish and blobs. Faithful
 * enough that the phase code cannot tell it from the real one, and it keeps the
 * test offline.
 */
function fakeService(): { fetchImpl: typeof fetch; sessions: Map<string, FakeSession> } {
  const sessions = new Map<string, FakeSession>();
  // The store is per key, not per session: that is the property being tested --
  // one run publishes, a later run of the same identity restores.
  const layers: StoredLayer[] = [];
  const blobs = new Map<string, Uint8Array>();
  let counter = 0;
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "POST" && url.pathname === "/sessions") {
      counter += 1;
      const id = String(counter).padStart(32, "0");
      const body = JSON.parse(String(init?.body ?? "{}")) as { identity: string };
      sessions.set(id, { identity: body.identity, closed: [] });
      return json(201, { id });
    }
    if (parts[0] === "blobs" && method === "GET") {
      const digest = decodeURIComponent(url.pathname.slice("/blobs/".length));
      const bytes = blobs.get(digest);
      if (bytes) return new Response(bytes, { status: 200 });
      return json(404, { error: "no such blob" });
    }
    const session = sessions.get(parts[1] ?? "");
    if (!session) return json(404, { error: "no session" });
    if (parts[2] === "restore") {
      return json(200, layers.length === 0
        ? { hit: false, reason: "nothing published", layers: [] }
        : { hit: true, reason: `newest ${layers.length} layer(s)`, layers });
    }
    if (parts[2] === "publish") {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      const layer: StoredLayer = {
        seq: layers.length + 1,
        digest,
        bytes: bytes.byteLength,
        kind: layers.length === 0 ? "full" : "delta",
      };
      layers.push(layer);
      blobs.set(digest, bytes);
      return json(201, { kind: layer.kind, seq: layer.seq, digest, bytes: layer.bytes });
    }
    if (parts[2] === "close") {
      session.closed.push(String(JSON.parse(String(init?.body ?? "{}")).outcome ?? "closed"));
      return json(200, { status: "closed" });
    }
    return json(404, { error: `no route ${url.pathname}` });
  }) as unknown as typeof fetch;

  return { fetchImpl: impl, sessions };
}

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fleet-phase-${name}-`));
}

function seedCacheDir(root: string): string {
  const cacheDir = path.join(root, "ccache");
  fs.mkdirSync(path.join(cacheDir, "objects", "ab"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "objects", "ab", "one.o"), "first-object");
  fs.writeFileSync(path.join(cacheDir, "stats"), "hits=12 misses=3");
  return cacheDir;
}

const CONFIG: FleetConfig = { url: "http://cache.test", family: "app", token: "", timeoutMs: 5000 };

function options(overrides: Partial<FleetPhaseOptions> & { cacheDir: string }): FleetPhaseOptions {
  return {
    config: CONFIG,
    repository: "obs-rust/obs-studio",
    identity: "fc-1-linux-x64-relwithdebinfo-1.98.1",
    ...overrides,
  };
}

test("a published cache dir restores into a fresh directory byte for byte", async () => {
  const { fetchImpl } = fakeService();
  const source = tempDir("source");
  const cacheDir = seedCacheDir(source);

  const restoredFirst = await restoreFleetCache(options({ cacheDir, fetchImpl }));
  assert.equal(restoredFirst.restore.hit, false, "a cold session misses");
  assert.ok(restoredFirst.session, "a session is available even on a miss");

  const published = await publishFleetCache({
    ...options({ cacheDir, fetchImpl }),
    session: restoredFirst.session,
  });
  assert.equal(published.published, true, published.reason);
  assert.equal(published.kind, "full");

  // A different runner, a different working directory: only the store connects them.
  const other = tempDir("other");
  const destination = path.join(other, "ccache");
  const restored = await restoreFleetCache(options({ cacheDir: destination, fetchImpl }));
  assert.equal(restored.restore.hit, true, restored.restore.reason);
  assert.equal(restored.applied, 1);
  assert.equal(
    fs.readFileSync(path.join(destination, "objects", "ab", "one.o"), "utf8"),
    "first-object",
  );
  assert.equal(fs.readFileSync(path.join(destination, "stats"), "utf8"), "hits=12 misses=3");
  // The archive's top-level basename must not end up nested inside the cache dir.
  assert.equal(fs.existsSync(path.join(destination, "ccache")), false, "double-nested restore");
});

test("a second publish continues the chain and both layers are applied", async () => {
  const { fetchImpl } = fakeService();
  const root = tempDir("chain");
  const cacheDir = seedCacheDir(root);

  const first = await restoreFleetCache(options({ cacheDir, fetchImpl }));
  await publishFleetCache({ ...options({ cacheDir, fetchImpl }), session: first.session });

  // Run two: restore first (which reapplies the base over the local dir), *then*
  // change the tree the way a build would, then publish. This ordering matters:
  // a restore overwrites whatever a previous run left behind, which is correct
  // for a cache and wrong for a working copy.
  const secondSession = await restoreFleetCache(options({ cacheDir, fetchImpl }));
  assert.equal(secondSession.restore.hit, true, "run two starts from the published layer");
  fs.writeFileSync(path.join(cacheDir, "stats"), "hits=99 misses=0");
  const second = await publishFleetCache({
    ...options({ cacheDir, fetchImpl }),
    session: secondSession.session,
  });
  assert.equal(second.kind, "delta");

  const destination = path.join(tempDir("chain-target"), "ccache");
  const restored = await restoreFleetCache(options({ cacheDir: destination, fetchImpl }));
  assert.equal(restored.applied, 2, "base first, then the delta");
  assert.equal(fs.readFileSync(path.join(destination, "stats"), "utf8"), "hits=99 misses=0");
});

test("an unreachable service is a degraded miss, never a thrown error", async () => {
  const cacheDir = seedCacheDir(tempDir("down"));
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await restoreFleetCache(options({ cacheDir, fetchImpl: down }));
  assert.equal(result.restore.hit, false);
  assert.equal(result.restore.degraded, true);
  assert.equal(result.session, null);
});

test("publishing with no session is a no-op with a reason", async () => {
  const cacheDir = seedCacheDir(tempDir("nosession"));
  const published = await publishFleetCache({ ...options({ cacheDir }), session: null });
  assert.equal(published.published, false);
  assert.match(published.reason, /no fleet session/);
});

test("publishing a missing cache dir closes the session and reports why", async () => {
  const { fetchImpl, sessions } = fakeService();
  const root = tempDir("missing");
  const opened = await restoreFleetCache(options({ cacheDir: path.join(root, "absent"), fetchImpl }));
  const published = await publishFleetCache({
    ...options({ cacheDir: path.join(root, "absent"), fetchImpl }),
    session: opened.session,
  });
  assert.equal(published.published, false);
  assert.match(published.reason, /does not exist/);
  const [session] = [...sessions.values()];
  assert.deepEqual(session!.closed, ["closed"], "a session must never be left unsealed");
});

test("a failed publish still seals the session", async () => {
  const { fetchImpl: service, sessions } = fakeService();
  // One transport for the whole job: the session binds its fetch when it opens,
  // so a failure has to be injected there, not swapped in at publish time.
  const failing = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/publish")) throw new Error("store is full");
    return service(input as string, init);
  }) as unknown as typeof fetch;
  const cacheDir = seedCacheDir(tempDir("failing"));
  const opened = await restoreFleetCache(options({ cacheDir, fetchImpl: failing }));

  const published = await publishFleetCache({
    ...options({ cacheDir, fetchImpl: failing }),
    session: opened.session,
  });
  assert.equal(published.published, false);
  assert.match(published.reason, /store is full/);
  const [session] = [...sessions.values()];
  assert.equal(session!.closed.length, 1, "closed exactly once, after the failure");
});
