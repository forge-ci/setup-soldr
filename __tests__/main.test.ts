import { test } from "node:test";
import "./yank-audit.test.ts";
import assert from "node:assert/strict";

// Ensure main.ts does not auto-invoke its run() when imported under test.
process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

test("src/main.ts imports cleanly and exposes `run`", async () => {
  const mod = (await import("../src/main.js")) as { run?: () => Promise<void> };
  assert.equal(typeof mod.run, "function");
});

test("main.run is callable and returns a Promise", async () => {
  const mod = (await import("../src/main.js")) as { run: () => Promise<void> };
  // We don't drive it through to completion (it'd need a configured workspace,
  // network, etc). We just verify the entry point shape.
  const p = (() => {
    try {
      return mod.run();
    } catch (err) {
      // run is async but if it throws synchronously, swallow for the test.
      return Promise.reject(err);
    }
  })();
  assert.ok(p instanceof Promise);
  // Detach so unhandled rejection doesn't taint the test process.
  p.catch(() => undefined);
});

test("cargo-registry encryption failures honor skip only for legacy-v1", async () => {
  const mod = (await import("../src/main.js")) as {
    shouldSkipCargoRegistryExtractionError: (
      err: unknown,
      format: "legacy-v1" | "soldr-v2",
      onFailure: string,
    ) => boolean;
  };
  for (const code of ["EAUTHFAIL", "EENCNOKEY"]) {
    const err = Object.assign(new Error(code), { code });
    assert.equal(mod.shouldSkipCargoRegistryExtractionError(err, "legacy-v1", "skip"), true);
    assert.equal(mod.shouldSkipCargoRegistryExtractionError(err, "legacy-v1", "error"), false);
    assert.equal(mod.shouldSkipCargoRegistryExtractionError(err, "soldr-v2", "skip"), false);
  }
  assert.equal(
    mod.shouldSkipCargoRegistryExtractionError(
      Object.assign(new Error("corrupt"), { code: "EBADARCHIVE" }),
      "legacy-v1",
      "skip",
    ),
    false,
  );
});

test("cache=false disables all runtime cache restores despite enabled layer inputs", async () => {
  const { resolveRuntimeCacheFlags } = await import("../src/main.js");
  assert.deepEqual(resolveRuntimeCacheFlags("false", true, "true", "true"), {
    setup: false, build: false, mini: false, solo: false,
  });
  assert.deepEqual(resolveRuntimeCacheFlags("true", false, "true", "true"), {
    setup: true, build: false, mini: true, solo: true,
  });
});
