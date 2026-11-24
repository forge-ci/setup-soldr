// The rules that decide *whether* the fleet tier runs, and what it hands back to
// the restore flow. main.ts itself installs toolchains and cannot be driven
// through a restore in a test, so those decisions live in the hook and are
// proven here against a fake service.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FLEET_KEY_PREFIX,
  attachFromState,
  isFleetHit,
  runFleetRestore,
  type FleetHookOptions,
} from "../src/lib/fleet-restore-hook.js";
import type { FleetConfig } from "../src/lib/fleet-cache.js";

const CONFIG: FleetConfig = { url: "http://cache.test", family: "app", token: "", timeoutMs: 1000 };

function fakeService(hit: boolean): { fetchImpl: typeof fetch; published: () => number } {
  let publishes = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/sessions" && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ id: "1".repeat(32) }), { status: 201 });
    }
    if (url.pathname.endsWith("/restore")) {
      // No layers: this test is about the marker and the saved session, not
      // about applying an archive -- `fleet-cache-phase.test.ts` owns that with
      // a real tar.zst round trip.
      return new Response(JSON.stringify(hit
        ? { hit: true, reason: "newest entry s000002", layers: [] }
        : { hit: false, reason: "nothing published", layers: [] }), { status: 200 });
    }
    if (url.pathname.startsWith("/blobs/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (url.pathname.endsWith("/publish")) {
      publishes += 1;
      return new Response(JSON.stringify({ kind: "full", seq: 1, digest: "sha256:" + "b".repeat(64) }), { status: 201 });
    }
    if (url.pathname.endsWith("/close")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, published: () => publishes };
}

function options(overrides: Partial<FleetHookOptions> = {}): FleetHookOptions {
  return {
    config: CONFIG,
    repository: "obs-rust/obs-studio",
    identity: "fc-1-linux-x64-debug-1.98.1",
    cacheDir: "/tmp/does-not-matter",
    log: () => undefined,
    ...overrides,
  };
}

const untouchable = (async () => {
  throw new Error("the tier must not be contacted");
}) as unknown as typeof fetch;

test("the tier is off by default: no config, no work", async () => {
  const result = await runFleetRestore(options({ config: null, fetchImpl: untouchable }));
  assert.equal(result.attempted, false);
  assert.equal(result.hit, false);
  assert.equal(result.state, null);
  assert.equal(result.reason, "fleet tier is off");
});

test("a persistent root keeps the tier out of its cache", async () => {
  const result = await runFleetRestore(
    options({ persistentRoot: "/srv/soldr-root", fetchImpl: untouchable }),
  );
  assert.equal(result.attempted, false);
  assert.match(result.reason, /persistent root/);
});

test("a configured S3 tier does not stop the fleet tier from running first", async () => {
  // The alternative -- treating s3-bucket as a blocker -- would mean every lane
  // that already sets it could never try the fleet store without deleting its S3
  // configuration first. The caller uses `hit` to keep S3 out of the way.
  const { fetchImpl } = fakeService(true);
  const result = await runFleetRestore(options({ s3Configured: true, fetchImpl }));
  assert.equal(result.attempted, true);
  assert.equal(result.hit, true, "a hit tells main to skip the S3 tier");
  assert.equal(result.matchedKey.startsWith("fleet:"), true);
});

test("a repository without an owner is refused before any request", async () => {
  const result = await runFleetRestore(options({ repository: "obs-studio", fetchImpl: untouchable }));
  assert.equal(result.attempted, false);
  assert.match(result.reason, /no repository/);
});

test("a miss still hands post a session, so the job can publish", async () => {
  const { fetchImpl } = fakeService(false);
  const result = await runFleetRestore(options({ fetchImpl }));
  assert.equal(result.attempted, true);
  assert.equal(result.hit, false);
  assert.equal(result.matchedKey, "");
  assert.ok(result.state, "a session must be saved even when nothing restored");
  const state = JSON.parse(result.state!);
  assert.equal(state.id.length, 32);
  assert.equal(state.identity, "fc-1-linux-x64-debug-1.98.1");
  assert.equal(state.repo, "obs-rust/obs-studio");
  assert.equal(state.platform, "linux-x64");
});

test("a hit is expressed as a fleet: matchedKey the restore flow understands", async () => {
  const { fetchImpl } = fakeService(true);
  const result = await runFleetRestore(options({
    fetchImpl,
    cacheDir: (await import("node:fs")).mkdtempSync(
      (await import("node:path")).join(
        (await import("node:os")).tmpdir(),
        "fleet-hook-",
      ),
    ),
  }));
  assert.equal(result.hit, true, result.reason);
  assert.equal(result.matchedKey, `${FLEET_KEY_PREFIX}fc-1-linux-x64-debug-1.98.1`);
  assert.equal(isFleetHit(result.matchedKey), true);
  assert.equal(isFleetHit("legacy-key"), false);
  assert.ok(result.state);
});

test("an unreachable service is a degraded miss with no session", async () => {
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await runFleetRestore(options({ fetchImpl: down }));
  assert.equal(result.attempted, true);
  assert.equal(result.hit, false);
  assert.equal(result.degraded, true);
  assert.equal(result.state, null);
});

test("post can reattach exactly the session main saved", () => {
  const state = JSON.stringify({
    id: "2".repeat(32), identity: "id-a", repo: "obs-rust/obs-studio",
    family: "app", platform: "linux-x64",
  });
  const session = attachFromState(CONFIG, state);
  assert.ok(session);
  assert.equal(session.sessionId, "2".repeat(32));
  assert.deepEqual(session.key, { repo: "obs-rust/obs-studio", family: "app", platform: "linux-x64" });

  assert.equal(attachFromState(CONFIG, "not json"), null, "corrupt state is not a session");
  assert.equal(attachFromState(CONFIG, JSON.stringify({ id: "x" })), null, "partial state is not a session");
});
