import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompressionMethod } from "@actions/cache/lib/internal/constants.js";
import * as cacheTar from "@actions/cache/lib/internal/tar.js";
import {
  prepareActionsCacheArchive,
  saveReservedCache,
  type Reservation,
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
    reserve: async () => null,
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
    reserve: async () => (next++ === 0 ? winner : null),
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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "two-phase-cache-"));
  const workspace = path.join(root, "workspace");
  await fsp.mkdir(workspace);
  process.env.GITHUB_WORKSPACE = workspace;
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
        reserve: async () => reservation,
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
      assert.equal(result.status, "saved");
      assert.ok(wrapperPath);
      assert.equal(fs.existsSync(wrapperPath), false);
    }
  } finally {
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = originalWorkspace;
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
