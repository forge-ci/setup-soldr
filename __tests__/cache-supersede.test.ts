// Tests for src/lib/cache-supersede.ts.
//
// The sweep exists because the Actions cache is a 10 GB pool shared by every
// family and the repository janitor only runs at the end of a merge-queue run.
// These tests pin the two things that could go wrong: deleting something that is
// not this family, and deleting the entry that was just saved.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deleteSupersededFamilyEntries,
  familyPrefixOfBaseKey,
  supersedeDisabled,
  type SupersededEntry,
} from "../src/lib/cache-supersede.js";

const KEY = "cook-base-v3-linux-x64-glibc-rustc1.98.1-fea2183cb-l7d46f1b3ea231b6d-xlinux-host-v3-soldrv0.9.45";
const PREFIX = "cook-base-v3-linux-x64-glibc-rustc1.98.1-fea2183cb-l7d46f1b3ea231b6d-xlinux-host-v3";

test("family prefix drops the trailing soldr version segment", () => {
  assert.equal(familyPrefixOfBaseKey(KEY), PREFIX);
  assert.equal(familyPrefixOfBaseKey("no-such-shape"), null);
});

test("NO_CACHE_SUPERSEDE disables the sweep", () => {
  assert.equal(supersedeDisabled({ NO_CACHE_SUPERSEDE: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(supersedeDisabled({ NO_CACHE_SUPERSEDE: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(supersedeDisabled({} as NodeJS.ProcessEnv), false);
});

test("deletes older generations of the same family only", async () => {
  const older: SupersededEntry = { id: 11, key: `${PREFIX}-soldrv0.9.44`, size_in_bytes: 1000 };
  const other: SupersededEntry = {
    id: 12,
    key: "cook-base-v3-macos-arm64-darwin-rustc1.98.1-aa-bb-soldrv0.9.45",
    size_in_bytes: 2000,
  };
  const current: SupersededEntry = { id: 13, key: KEY, size_in_bytes: 3000 };
  const deleted: number[] = [];
  const logs: string[] = [];

  const result = await deleteSupersededFamilyEntries({
    keepKey: KEY,
    log: (msg) => logs.push(msg),
    owner: "o",
    repo: "r",
    token: "t",
    listCachesByPrefix: async () => [older, other, current],
    deleteCacheById: async (id) => {
      deleted.push(id);
    },
  });

  assert.deepEqual(deleted, [11]);
  assert.equal(result.deleted, 1);
  assert.equal(result.bytes, 1000);
  assert.match(logs.join("\n"), /deleted 1 superseded/);
});

test("a failed delete is counted, never thrown", async () => {
  const result = await deleteSupersededFamilyEntries({
    keepKey: KEY,
    log: () => {},
    owner: "o",
    repo: "r",
    token: "t",
    listCachesByPrefix: async () => [{ id: 21, key: `${PREFIX}-soldrv0.9.40`, size_in_bytes: 5 }],
    deleteCacheById: async () => {
      throw new Error("403");
    },
  });
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 1);
});

test("a listing failure is reported and does not throw", async () => {
  const result = await deleteSupersededFamilyEntries({
    keepKey: KEY,
    log: () => {},
    owner: "o",
    repo: "r",
    token: "t",
    listCachesByPrefix: async () => {
      throw new Error("network");
    },
    deleteCacheById: async () => {},
  });
  assert.equal(result.reason, "list failed");
});

test("no token means no sweep", async () => {
  const saved = {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    owner: process.env.GITHUB_REPOSITORY_OWNER,
  };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY_OWNER;
  try {
    const result = await deleteSupersededFamilyEntries({ keepKey: KEY, log: () => {} });
    assert.equal(result.reason, "no repository or token");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) continue;
      process.env[key === "token" ? "GITHUB_TOKEN" : key === "repo" ? "GITHUB_REPOSITORY" : "GITHUB_REPOSITORY_OWNER"] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// setup-soldr#682 — after saving a build-cache generation, delete the older
// generations of the same exact key (never the bare key, never other jobs).
// ---------------------------------------------------------------------------

test("#682 build-cache generation sweep deletes only older generations of this key", async () => {
  const { sweepSupersededBuildCacheGenerations } = await import("../src/lib/cache-supersede.js");
  const exact = "setup-soldr-buildcache-v3-linux-x64-d-sfx-lock-ssoldr";
  const keep = `${exact}-g900`;
  const entries: SupersededEntry[] = [
    { id: 1, key: exact, size_in_bytes: 10 },
    { id: 2, key: `${exact}-g800`, size_in_bytes: 20 },
    { id: 3, key: `${exact}-g850-2`, size_in_bytes: 30 },
    { id: 4, key: keep, size_in_bytes: 40 },
  ];
  const prefixes: string[] = [];
  const deleted: number[] = [];
  const warnings: string[] = [];
  const result = await sweepSupersededBuildCacheGenerations({
    exactKey: exact,
    keepKey: keep,
    log: () => {},
    warn: (m) => warnings.push(m),
    owner: "o",
    repo: "r",
    token: "t",
    listCachesByPrefix: async (prefix) => {
      prefixes.push(prefix);
      return entries.filter((e) => e.key.startsWith(prefix));
    },
    deleteCacheById: async (id) => {
      deleted.push(id);
    },
  });
  assert.deepEqual(prefixes, [`${exact}-g`]);
  assert.deepEqual(deleted.sort(), [2, 3]);
  assert.equal(result.deleted, 2);
  assert.equal(result.bytes, 50);
  assert.deepEqual(warnings, []);
});

test("#682 build-cache generation sweep degrades to a warning without actions: write", async () => {
  const { sweepSupersededBuildCacheGenerations } = await import("../src/lib/cache-supersede.js");
  const exact = "setup-soldr-buildcache-v3-linux-x64-d-sfx-lock-ssoldr";
  const warnings: string[] = [];
  const result = await sweepSupersededBuildCacheGenerations({
    exactKey: exact,
    keepKey: `${exact}-g900`,
    log: () => {},
    warn: (m) => warnings.push(m),
    owner: "o",
    repo: "r",
    token: "t",
    listCachesByPrefix: async () => [{ id: 2, key: `${exact}-g800`, size_in_bytes: 20 }],
    deleteCacheById: async () => {
      throw new Error("Resource not accessible by integration (403)");
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /actions: write/);
});

test("#682 build-cache generation sweep refuses a keep key outside the generation family", async () => {
  const { sweepSupersededBuildCacheGenerations } = await import("../src/lib/cache-supersede.js");
  const exact = "setup-soldr-buildcache-v3-linux-x64-d-sfx-lock-ssoldr";
  let listed = false;
  const result = await sweepSupersededBuildCacheGenerations({
    exactKey: exact,
    keepKey: exact,
    log: () => {},
    warn: () => {},
    owner: "o",
    repo: "r",
    token: "t",
    listCachesByPrefix: async () => {
      listed = true;
      return [];
    },
    deleteCacheById: async () => {},
  });
  assert.equal(listed, false);
  assert.equal(result.deleted, 0);
});
