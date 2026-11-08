import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteCacheEntriesByKeys,
  evictIfOverBudget,
  thresholdsForPolicy,
  ageFloorForOvershoot,
  FOUNDATION_PREFIXES,
  type CacheEntry,
  type EvictDeps,
} from "../src/lib/cache-eviction.js";

const GB = 1024 * 1024 * 1024;

function makeDeps(opts: {
  caches: CacheEntry[];
  usageGb: number;
  deletions?: number[];
}): { deps: EvictDeps; deleted: number[]; log: string[] } {
  const log: string[] = [];
  const deleted: number[] = opts.deletions ?? [];
  const deps: EvictDeps = {
    owner: "test-owner",
    repo: "test-repo",
    token: "fake-token",
    log: (msg) => log.push(msg),
    listCaches: async () => opts.caches,
    getUsageBytes: async () => opts.usageGb * GB,
    deleteCacheById: async (id) => {
      deleted.push(id);
    },
  };
  return { deps, deleted, log };
}

function entry(id: number, key: string, sizeMB: number, ageHours: number): CacheEntry {
  return {
    id,
    key,
    size_in_bytes: sizeMB * 1024 * 1024,
    created_at: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
  };
}

test("thresholdsForPolicy returns null for disabled", () => {
  assert.equal(thresholdsForPolicy("disabled"), null);
});

test("thresholdsForPolicy returns 9.5/9.0 + 6h age floor for protect-foundations", () => {
  assert.deepEqual(thresholdsForPolicy("protect-foundations"), {
    triggerGb: 9.5,
    targetGb: 9,
    minAgeHoursBeforeDelete: 6,
  });
});

test("thresholdsForPolicy returns 7/6 + 2h age floor for aggressive (#352)", () => {
  assert.deepEqual(thresholdsForPolicy("aggressive"), {
    triggerGb: 7,
    targetGb: 6,
    minAgeHoursBeforeDelete: 2,
  });
});

test("disabled policy never fires", async () => {
  const { deps, deleted } = makeDeps({ caches: [], usageGb: 20 });
  const result = await evictIfOverBudget("disabled", deps);
  assert.equal(result.fired, false);
  assert.equal(result.reason, "policy=disabled");
  assert.equal(deleted.length, 0);
});

test("under trigger threshold is no-op", async () => {
  const { deps, deleted } = makeDeps({
    caches: [entry(1, "cook-delta-v3-foo", 500, 24)],
    usageGb: 9, // < 9.5 GB trigger
  });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, false);
  assert.equal(result.deletedCount, 0);
  assert.equal(deleted.length, 0);
});

test("evicts biggest non-foundation entries until under target (age tiebreaker)", async () => {
  const caches = [
    entry(101, "cook-delta-v3-foo", 1024, 48), // oldest, evictable (>6h)
    entry(102, "zccache-Linux-X64-test-aaa", 1024, 36), // evictable
    entry(103, "cook-delta-v3-bar", 1024, 24), // evictable
    entry(104, "solo-toolchain-v2-xyz", 170, 12), // FOUNDATION — protected
    entry(105, "soldr-mini-darwin", 11, 12), // FOUNDATION
    entry(106, "setup-soldr-cargoregistry-v1-foo", 50, 12), // FOUNDATION
    entry(107, "cook-delta-v3-baz", 1024, 12), // evictable (>6h)
  ];
  // total = 3*1024 + 170 + 11 + 50 + 1024 ≈ 4.25 GB
  // But say usage is reported as 11 GB to force eviction.
  const { deps, deleted, log } = makeDeps({
    caches,
    usageGb: 11, // > 9.5 GB trigger
  });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  // Must evict oldest evictable first: 101 (48h), then 102 (36h)…
  // bytes start at 11 GB; need to drop to 9 GB target (delete 2 GB).
  // Each entry is 1024 MB = 1 GB. So 2 deletes get us to 9 GB.
  assert.deepEqual(deleted, [101, 102]);
  assert.equal(result.deletedCount, 2);
  // None of the foundation entries should be in the delete list.
  for (const protectedId of [104, 105, 106]) {
    assert.ok(!deleted.includes(protectedId), `entry ${protectedId} was foundation, should not be deleted`);
  }
  // log mentions eviction.
  assert.ok(log.some((l) => l.includes("evicting toward 9 GB")), `expected log line, got: ${log.join("\n")}`);
});

test("age floor protects fresh entries from self-eviction (#352)", async () => {
  // All non-foundation entries fresh (< 6h). Usage at 10 GB is only
  // ~0.5 GB over trigger (9.5 GB), so the graduated floor stays at 6h
  // and NO eviction should happen — protecting this run's saves.
  const caches = [
    // #368: cook-base is now foundation, so we use cook-delta + buildcache
    // here to exercise the age-floor path (these layers ARE evictable).
    entry(201, "cook-delta-v3-foo", 2000, 0.1), // age 6 minutes
    entry(202, "setup-soldr-buildcache-v2-bar", 300, 0.1),
    entry(203, "cook-delta-v3-baz", 1500, 1.5), // age 1.5h still < 6h
    entry(204, "solo-toolchain-v2-foo", 170, 1), // foundation
    entry(205, "cook-base-v4-baz", 300, 12), // foundation (#368) — old but protected
  ];
  const { deps, deleted, log } = makeDeps({ caches, usageGb: 10 });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  // Should attempt to evict (usage > trigger) but find ZERO eligible
  // entries because all non-foundation entries are < 6h old.
  assert.equal(result.deletedCount, 0, "no entries should be deleted — all fresh");
  assert.equal(deleted.length, 0);
  assert.ok(
    log.some((l) => l.includes("protected") && l.includes("younger than 6h")),
    `expected protected-by-age log line, got: ${log.join("\n")}`,
  );
});

test("ageFloorForOvershoot tiers (#356)", () => {
  const t = { triggerGb: 9.5, targetGb: 9, minAgeHoursBeforeDelete: 6 };
  // small overshoot (<1 GB over) -> baseline 6h
  assert.equal(ageFloorForOvershoot(9.5, t), 6);
  assert.equal(ageFloorForOvershoot(10.4, t), 6);
  // moderate (1–3 GB over) -> 2h
  assert.equal(ageFloorForOvershoot(10.6, t), 2);
  assert.equal(ageFloorForOvershoot(12.5, t), 2);
  // danger (>3 GB over) -> 0.5h
  assert.equal(ageFloorForOvershoot(12.6, t), 0.5);
  assert.equal(ageFloorForOvershoot(13.6, t), 0.5);
  // aggressive policy keeps baseline of 2h at small overshoot
  const a = { triggerGb: 7, targetGb: 6, minAgeHoursBeforeDelete: 2 };
  assert.equal(ageFloorForOvershoot(7.5, a), 2);
  // moderate tier caps at min(2, baseline) — for aggressive baseline=2, tier stays 2h
  assert.equal(ageFloorForOvershoot(9.5, a), 2);
  // danger zone for aggressive triggers at 10 GB (>3 over 7 GB trigger)
  assert.equal(ageFloorForOvershoot(10.5, a), 0.5);
});

test("graduated age floor evicts in danger zone (#356)", async () => {
  // Reproduce zccache 13.63 GB observation: trigger 9.5 GB, usage
  // 13.63 GB (overshoot 4.13 GB, danger zone). All entries are < 6h
  // but > 0.5h. The graduated floor drops to 0.5h, so most should
  // become evictable and we should free space toward the 9 GB target.
  const caches = [
    entry(301, "cook-delta-v3-foo", 2000, 5), // 5h old — beats 0.5h floor
    entry(302, "setup-soldr-buildcache-v2-bar", 1500, 4),
    entry(303, "cook-delta-v3-baz", 1500, 3),
    entry(304, "solo-toolchain-v2-foo", 170, 1), // foundation, protected anyway
    entry(305, "cook-delta-v3-fresh", 200, 0.1), // 6 min — still under 0.5h floor
  ];
  const { deps, deleted, log } = makeDeps({ caches, usageGb: 13.63 });
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  // Should delete ≥ 1 entry (graduated floor active) — at usage 13.63
  // GB target 9 GB, need to free 4.63 GB. Each large entry is 1.5-2 GB.
  // Expect 301, 302, 303 evicted (5+4+3h, oldest first).
  assert.ok(result.deletedCount! >= 2, `expected ≥ 2 deletes, got ${result.deletedCount}`);
  assert.deepEqual(deleted.slice(0, 3).sort(), [301, 302, 303]);
  // 305 is too fresh (6 min < 0.5h floor) — should NOT be deleted.
  assert.ok(!deleted.includes(305), "entry 305 (6 min old) should be protected by 0.5h floor");
  // 304 is foundation — should NOT be deleted.
  assert.ok(!deleted.includes(304), "entry 304 (solo-toolchain) is foundation, protected");
  // log mentions graduated floor activation.
  assert.ok(
    log.some((l) => l.includes("graduated age floor active")),
    `expected graduated-floor log, got: ${log.join("\n")}`,
  );
});

test("404 from delete is tolerated (concurrent race)", async () => {
  const caches = [entry(1, "cook-delta-v3-foo", 1024, 24)];
  const log: string[] = [];
  const deps: EvictDeps = {
    owner: "x",
    repo: "y",
    token: "z",
    log: (m) => log.push(m),
    listCaches: async () => caches,
    getUsageBytes: async () => 10 * GB,
    deleteCacheById: async () => {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    },
  };
  const result = await evictIfOverBudget("protect-foundations", deps);
  assert.equal(result.fired, true);
  assert.equal(result.deletedCount, 0); // 404 = treated as already-deleted
});

test("403 permission denied logs once and stops", async () => {
  const caches = [
    entry(1, "cook-delta-v3-foo", 1024, 24),
    entry(2, "cook-delta-v3-bar", 1024, 18),
  ];
  let attempts = 0;
  const log: string[] = [];
  const deps: EvictDeps = {
    owner: "x",
    repo: "y",
    token: "z",
    log: (m) => log.push(m),
    listCaches: async () => caches,
    getUsageBytes: async () => 10 * GB,
    deleteCacheById: async () => {
      attempts += 1;
      const err = new Error("forbidden") as Error & { status?: number };
      err.status = 403;
      throw err;
    },
  };
  await evictIfOverBudget("protect-foundations", deps);
  // First attempt logs the permission warning; subsequent ones should be skipped.
  assert.equal(attempts, 1, "should stop trying after 403");
  assert.ok(
    log.some((l) => l.includes("permission denied")),
    "should log a clear permission-denied message",
  );
});

test("entries matching ANY foundation prefix are protected", () => {
  for (const key of [
    "solo-toolchain-v2-linux-x64-glibc-rustc1.94.1-cnone-tnone-soldrv0.7.51",
    "soldr-mini-linux-x64-glibc-v0.7.51",
    "setup-soldr-v4-linux-unknown-abc-def",
    "setup-soldr-cargoregistry-v1-linux-unknown-abc",
    "setup-soldr-prepare-v3-Linux-X64-aarch64-unknown-linux-gnu-rabc-sdef",
    // #368: cook-cache-base is foundation. Lockfile-keyed →
    // serves many CI cycles. Eviction observed within 20 min on
    // zccache before this was added.
    "cook-base-v4-linux-x64-glibc-rustc1.94.1-fnone-l92559307b22cc1be-soldrv0.7.51",
  ]) {
    assert.ok(
      FOUNDATION_PREFIXES.some((p) => key.startsWith(p)),
      `${key} should be classified as foundation`,
    );
  }
});

test("entries NOT matching foundation prefix are evictable", () => {
  for (const key of [
    // cook-delta IS evictable — it's commit-keyed, ages off quickly.
    "cook-delta-v3-linux-x64-glibc-rustc1.94.1-fnone-l...",
    "setup-soldr-buildcache-v2-linux-unknown-abc",
    "zccache-Linux-X64-test-foo",
    "cargo-target-Linux-X64-bench-abc",
  ]) {
    assert.ok(
      !FOUNDATION_PREFIXES.some((p) => key.startsWith(p)),
      `${key} should NOT be classified as foundation`,
    );
  }
});

test("targeted yank repair deletes exact poisoned keys and the retry misses", async () => {
  const store = new Map<number, CacheEntry>([
    [1, entry(1, "build-poisoned", 10, 1)],
    [2, entry(2, "cook-poisoned", 20, 1)],
    [3, entry(3, "healthy", 30, 1)],
  ]);
  const result = await deleteCacheEntriesByKeys({
    owner: "owner",
    repo: "repo",
    token: "token",
    keys: ["build-poisoned", "cook-poisoned"],
    log: () => undefined,
    listCachesForKey: async (key) => [...store.values()].filter((item) => item.key === key),
    deleteCacheById: async (id) => { store.delete(id); },
  });
  assert.deepEqual(result, { found: 2, deleted: 2, failed: 0 });
  assert.equal([...store.values()].some((item) => item.key === "build-poisoned"), false);
  assert.equal([...store.values()].some((item) => item.key === "cook-poisoned"), false);
  assert.equal([...store.values()].some((item) => item.key === "healthy"), true);
});

test("targeted yank repair reports permission failure and leaves the poisoned key", async () => {
  const poisoned = entry(9, "poisoned", 10, 1);
  const result = await deleteCacheEntriesByKeys({
    owner: "owner",
    repo: "repo",
    token: "read-only-token",
    keys: ["poisoned"],
    log: () => undefined,
    listCachesForKey: async () => [poisoned],
    deleteCacheById: async () => {
      const error = new Error("forbidden") as Error & { status: number };
      error.status = 403;
      throw error;
    },
  });
  assert.deepEqual(result, { found: 1, deleted: 0, failed: 1 });
});

test("targeted yank repair treats a concurrent 404 deletion race as repaired", async () => {
  const result = await deleteCacheEntriesByKeys({
    owner: "owner",
    repo: "repo",
    token: "token",
    keys: ["poisoned"],
    log: () => undefined,
    listCachesForKey: async () => [entry(9, "poisoned", 10, 1)],
    deleteCacheById: async () => {
      const error = new Error("gone") as Error & { status: number };
      error.status = 404;
      throw error;
    },
  });
  assert.deepEqual(result, { found: 1, deleted: 1, failed: 0 });
});
