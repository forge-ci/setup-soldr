import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompressionMethod } from "@actions/cache/lib/internal/constants.js";
import * as cacheTar from "@actions/cache/lib/internal/tar.js";
import * as twirp from "@actions/cache/lib/internal/shared/cacheTwirpClient.js";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  isReservationConflict,
  prepareActionsCacheArchive,
  reserve,
  saveReservedCache,
  type Reservation,
  type ReservationClient,
} from "../src/lib/two-phase-actions-cache.js";

const winner: Reservation = {
  service: "v1",
  compressionMethod: "zstd" as Reservation["compressionMethod"],
  cacheId: 42,
};

test("reservation conflict never invokes the archive producer", async () => {
  let produced = false;
  const result = await saveReservedCache({
    paths: ["cache.tzst"],
    key: "cook-test",
    reserve: async () => ({ kind: "conflict" }),
    produce: async () => {
      produced = true;
      throw new Error("producer must not run");
    },
  });
  assert.deepEqual(result, { status: "skipped-reservation" });
  assert.equal(produced, false);
});

test("only the reservation winner produces and uploads under concurrency", async () => {
  let next = 0;
  let produced = 0;
  let uploaded = 0;
  const run = () => saveReservedCache({
    paths: ["cache.tzst"],
    key: "cook-concurrent",
    reserve: async () => (next++ === 0 ? { kind: "reserved", reservation: winner } : { kind: "conflict" }),
    produce: async () => {
      produced += 1;
      return { archivePath: "cache.tzst", archiveBytes: 12 };
    },
    prepareUpload: async () => ({ archivePath: "actions-cache.tzst", archiveBytes: 24 }),
    upload: async () => {
      uploaded += 1;
      return 42;
    },
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(produced, 1);
  assert.equal(uploaded, 1);
  assert.deepEqual(results.map((r) => r.status).sort(), ["saved", "skipped-reservation"]);
});

test("the default Actions-cache wrapper round trips producer archives for v1 and v2", {
  skip: process.platform === "win32" ? "the Actions tar helper requires gzip on PATH" : false,
}, async () => {
  const originalWorkspace = process.env.GITHUB_WORKSPACE;
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "two-phase-cache-"));
  const workspace = path.join(root, "workspace");
  await fsp.mkdir(workspace);
  process.env.GITHUB_WORKSPACE = workspace;
  // #637: without RUNNER_TEMP, @actions/cache falls back to /home/actions/temp,
  // which only exists on hosted runners.
  process.env.RUNNER_TEMP = path.join(root, "runner-temp");
  await fsp.mkdir(process.env.RUNNER_TEMP);
  try {
    const reservations: Reservation[] = [
      { service: "v1", compressionMethod: CompressionMethod.Gzip, cacheId: 42 },
      {
        service: "v2",
        compressionMethod: CompressionMethod.Gzip,
        version: "version",
        signedUploadUrl: "https://example.invalid/upload",
      },
    ];
    for (const reservation of reservations) {
      const payloadPath = path.join(workspace, `${reservation.service}-payload.tar.zst`);
      const payload = `inner archive for ${reservation.service}`;
      await fsp.writeFile(payloadPath, payload);
      let wrapperPath = "";
      const result = await saveReservedCache({
        paths: [payloadPath],
        key: `cook-wrapped-${reservation.service}`,
        reserve: async () => ({ kind: "reserved", reservation }),
        produce: async () => ({
          archivePath: payloadPath,
          archiveBytes: Buffer.byteLength(payload),
        }),
        upload: async (_reserved, prepared) => {
          wrapperPath = prepared.archivePath;
          assert.notEqual(wrapperPath, payloadPath);
          assert.ok(prepared.archiveBytes > 0);
          await fsp.rm(payloadPath);
          await cacheTar.extractTar(wrapperPath, reservation.compressionMethod);
          assert.equal(await fsp.readFile(payloadPath, "utf8"), payload);
          return 42;
        },
      });
      assert.equal(result.status, "saved", result.status === "failed" ? result.error : undefined);
      assert.ok(wrapperPath);
      assert.equal(fs.existsSync(wrapperPath), false);
    }
  } finally {
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = originalWorkspace;
    if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = originalRunnerTemp;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("wrapper preparation removes its temporary directory after tar creation fails", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "two-phase-cache-failure-"));
  const wrapperDir = path.join(root, "wrapper");
  await fsp.mkdir(wrapperDir);
  try {
    await assert.rejects(
      prepareActionsCacheArchive(
        winner,
        { archivePath: "payload.tar.zst", archiveBytes: 12 },
        {
          resolvePaths: async () => ["payload.tar.zst"],
          createTempDirectory: async () => wrapperDir,
          createTar: async () => {
            throw new Error("tar failed");
          },
          stat: async () => ({ size: 0 }),
          removeDirectory: async (directory) => {
            await fsp.rm(directory, { recursive: true, force: true });
          },
        },
      ),
      /tar failed/,
    );
    assert.equal(fs.existsSync(wrapperDir), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs a save through the real reserve(), never reaching the producer. */
async function saveWith(client: Partial<ReservationClient>) {
  const logs: string[] = [];
  let produced = false;
  const options = {
    paths: ["cache.tzst"],
    key: "cook-662",
    log: (message: string) => logs.push(message),
    produce: async () => {
      produced = true;
      throw new Error("producer must not run");
    },
  };
  const result = await saveReservedCache({
    ...options,
    reserve: () => reserve(options, {
      serviceVersion: () => "v2",
      createCacheEntry: async () => {
        throw new Error("createCacheEntry not stubbed");
      },
      reserveCacheV1: async () => {
        throw new Error("reserveCacheV1 not stubbed");
      },
      ...client,
    }),
  });
  assert.equal(produced, false);
  return { result, log: logs.join("\n") };
}

/** Sends CreateCacheEntry through the real twirp client to a local server. */
async function withTwirpServer<T>(
  status: number,
  body: string,
  run: (createCacheEntry: ReservationClient["createCacheEntry"]) => Promise<T>,
): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = {
    url: process.env.ACTIONS_RESULTS_URL,
    token: process.env.ACTIONS_RUNTIME_TOKEN,
    v2: process.env.ACTIONS_CACHE_SERVICE_V2,
  };
  process.env.ACTIONS_RESULTS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  process.env.ACTIONS_RUNTIME_TOKEN = "test-token";
  process.env.ACTIONS_CACHE_SERVICE_V2 = "true";
  try {
    return await run((request) =>
      twirp.internalCacheTwirpClient({ maxAttempts: 1 }).CreateCacheEntry(request),
    );
  } finally {
    for (const [name, value] of [
      ["ACTIONS_RESULTS_URL", saved.url],
      ["ACTIONS_RUNTIME_TOKEN", saved.token],
      ["ACTIONS_CACHE_SERVICE_V2", saved.v2],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

test("#662 a real twirp 409 is a conflict, not a failure", async () => {
  await withTwirpServer(
    409,
    JSON.stringify({ code: "already_exists", msg: "cache entry already exists" }),
    async (createCacheEntry) => {
      const { result } = await saveWith({ createCacheEntry });
      assert.deepEqual(result, { status: "skipped-reservation" });
      assert.equal(isReservationConflict(result), true);
    },
  );
});

test("#662 a real twirp 500 is a failure carrying the status", async () => {
  await withTwirpServer(
    500,
    JSON.stringify({ code: "internal", msg: "boom" }),
    async (createCacheEntry) => {
      const { result, log } = await saveWith({ createCacheEntry });
      assert.equal(result.status, "reservation-failed");
      assert.match(result.error ?? "", /\(500\)/);
      assert.equal(isReservationConflict(result), false);
      assert.match(log, /reservation failed for key=cook-662: .*\(500\)/);
      assert.doesNotMatch(log, /reservation conflict/);
    },
  );
});

for (const [status, code] of [[429, "resource_exhausted"], [401, "unauthenticated"]] as const) {
  test(`#662 a real twirp ${status} is a failure, even mentioning "already exists"`, async () => {
    await withTwirpServer(
      status,
      JSON.stringify({ code, msg: "token for a key that already exists" }),
      async (createCacheEntry) => {
        const { result } = await saveWith({ createCacheEntry });
        assert.equal(result.status, "reservation-failed");
        assert.match(result.error ?? "", new RegExp(`\\(${status}\\)`));
      },
    );
  });
}

test("#662 ok:true without signedUploadUrl is a failure", async () => {
  const { result } = await saveWith({
    createCacheEntry: async () => ({ ok: true, signedUploadUrl: "", message: "" }),
  });
  assert.equal(result.status, "reservation-failed");
  assert.match(result.error ?? "", /signedUploadUrl/);
});

test("#662 ok:false is a conflict only when it says already exists", async () => {
  const conflict = await saveWith({
    createCacheEntry: async () => ({ ok: false, signedUploadUrl: "", message: "entry already exists" }),
  });
  assert.equal(conflict.result.status, "skipped-reservation");
  for (const message of ["", "storage unavailable"]) {
    const { result } = await saveWith({
      createCacheEntry: async () => ({ ok: false, signedUploadUrl: "", message }),
    });
    assert.equal(result.status, "reservation-failed");
    assert.match(result.error ?? "", /ok=false/);
  }
});

test("#662 v1 reserveCache: 409 conflicts, other statuses fail with the status", async () => {
  const v1 = (statusCode: number, message?: string): Partial<ReservationClient> => ({
    serviceVersion: () => "v1",
    reserveCacheV1: async () => ({
      statusCode,
      result: null,
      headers: {},
      error: message ? new Error(message) as never : undefined,
    }),
  });
  const conflict = await saveWith(v1(409, "Cache already exists"));
  assert.deepEqual(conflict.result, { status: "skipped-reservation" });
  const failed = await saveWith(v1(503, "unavailable"));
  assert.equal(failed.result.status, "reservation-failed");
  assert.match(failed.result.error ?? "", /HTTP 503 .*: unavailable/);
});

test("#662 reservation errors never expose signed URLs or tokens", async () => {
  const { result, log } = await saveWith({
    createCacheEntry: async () => {
      throw new Error(
        "Failed to CreateCacheEntry: Failed request: (403) Forbidden: " +
          "https://acct.blob.example/c?sig=SECRET Bearer TOKENVALUE",
      );
    },
  });
  assert.equal(result.status, "reservation-failed");
  assert.match(result.error ?? "", /\(403\)/);
  for (const text of [result.error ?? "", log]) {
    assert.doesNotMatch(text, /SECRET|TOKENVALUE/);
  }
});
