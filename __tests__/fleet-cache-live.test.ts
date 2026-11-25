// The pairing that actually runs in production: the TypeScript client against the
// Python service.
//
// Every other fleet test uses a fake service, which proves the client's own logic
// and nothing about the wire. This one starts the real `cache_server.py` (checked
// out from forge-ci/cache) and drives a whole session against it, so a protocol
// mismatch between the two implementations fails here instead of in a repo's CI.
//
// Skipped unless CACHECTL_SERVER_URL is set; the `fleet-cache integration`
// workflow sets it after starting the server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { FleetSession, type FleetConfig } from "../src/lib/fleet-cache.js";
import { publishFleetCache, restoreFleetCache } from "../src/lib/fleet-cache-phase.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const URL_FROM_ENV = process.env["CACHECTL_SERVER_URL"] ?? "";
const REPO = "obs-rust/obs-studio";

function config(): FleetConfig {
  return { url: URL_FROM_ENV.replace(/\/+$/, ""), family: "app", token: "", timeoutMs: 10_000 };
}

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fleet-live-${name}-`));
}

function seedCacheDir(root: string): string {
  const cacheDir = path.join(root, "ccache");
  fs.mkdirSync(path.join(cacheDir, "objects"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "objects", "one.o"), "live-object");
  fs.writeFileSync(path.join(cacheDir, "stats"), "hits=1");
  return cacheDir;
}

test("a session against the real service publishes and restores", { skip: URL_FROM_ENV === "" }, async () => {
  const identity = `fc-1-linux-x64-live-${Date.now()}`;
  const root = tempDir("source");
  const cacheDir = seedCacheDir(root);

  const first = await restoreFleetCache({
    config: config(), repository: REPO, identity, cacheDir, log: () => undefined,
  });
  assert.equal(first.restore.hit, false, "a fresh identity must miss");
  assert.ok(first.session, "the service must hand back a session on a miss");

  const published = await publishFleetCache({
    config: config(), repository: REPO, identity, cacheDir, session: first.session,
    log: () => undefined,
  });
  assert.equal(published.published, true, published.reason);

  // A different runner, a different directory: only the service connects them.
  const destination = path.join(tempDir("restored"), "ccache");
  const restored = await restoreFleetCache({
    config: config(), repository: REPO, identity, cacheDir: destination, log: () => undefined,
  });
  assert.equal(restored.restore.hit, true, restored.restore.reason);
  assert.equal(restored.applied, 1);
  assert.equal(fs.readFileSync(path.join(destination, "objects", "one.o"), "utf8"), "live-object");
  assert.equal(fs.readFileSync(path.join(destination, "stats"), "utf8"), "hits=1");
  assert.equal(fs.existsSync(path.join(destination, "ccache")), false, "no double nesting");
});

test("the client and the service agree on the same bytes", { skip: URL_FROM_ENV === "" }, async () => {
  const identity = `fc-1-linux-x64-bytes-${Date.now()}`;
  const payload = Buffer.from("layer-bytes-from-typescript");
  const session = await FleetSession.open(config(), { repository: REPO, identity });
  assert.ok(session, "the service must accept a session");

  const published = await session.publish(payload);
  assert.equal(published.published, true, published.reason);
  assert.equal(published.digest, "sha256:" + createHash("sha256").update(payload).digest("hex"),
    "the digest the service computes must be the one the client can compute");

  const decision = await session.restore();
  assert.equal(decision.hit, true, decision.reason);
  const tip = decision.layers.at(-1);
  assert.ok(tip, "a hit must name at least one layer");
  const downloaded = await session.download(tip.digest);
  assert.deepEqual(downloaded, payload);
  await session.close();
});

test("a publish with no session is reported, not thrown", { skip: URL_FROM_ENV === "" }, async () => {
  const cacheDir = seedCacheDir(tempDir("nosession"));
  const result = await publishFleetCache({
    config: config(), repository: REPO, identity: "fc-1-linux-x64-none", cacheDir,
    session: null, log: () => undefined,
  });
  assert.equal(result.published, false);
  assert.match(result.reason, /no fleet session/);
});
