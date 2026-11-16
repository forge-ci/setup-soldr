// Redirect-manifest origin resolver for soldr toolchain fetches. Every test
// injects a fetch mock: no request leaves the process.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  BUILTIN_TOOLCHAIN_ORIGINS,
  DEFAULT_TOOLCHAIN_REDIRECT_URL,
  fetchToolchainFile,
  fetchToolchainJson,
  mergeOrigins,
  parseRedirectManifest,
  resetToolchainRedirectCache,
  resolveToolchainOrigins,
} from "../src/lib/soldr-toolchain-origins.cjs";

const FORGE = "https://forge-ci.github.io/soldr-toolchain";
const ZACKEES = "https://zackees.github.io/soldr-toolchain";

type Route = Response | Error | ((url: string) => Response | Promise<Response>);

function mockFetch(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request to ${url}`);
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route(url);
    return route.clone();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function manifest(origins: unknown): Response {
  return json({ schema_version: 1, toolchain: { origins } });
}

beforeEach(() => resetToolchainRedirectCache());

test("built-in list is the forge-ci mirror first, then zackees", () => {
  assert.deepEqual([...BUILTIN_TOOLCHAIN_ORIGINS], [FORGE, ZACKEES]);
  assert.equal(DEFAULT_TOOLCHAIN_REDIRECT_URL, "https://forge-ci.github.io/soldr-redirect.v1.json");
});

test("manifest validation accepts schema 1 https origins and strips trailing slashes", () => {
  assert.deepEqual(
    parseRedirectManifest({ schema_version: 1, toolchain: { origins: ["https://a.example/t/", "https://b.example"] } }),
    ["https://a.example/t", "https://b.example"],
  );
});

test("manifest validation rejects wrong schema, empty or non-https origin lists", () => {
  for (const payload of [
    null,
    [],
    "text",
    { schema_version: 2, toolchain: { origins: ["https://a.example"] } },
    { schema_version: "1", toolchain: { origins: ["https://a.example"] } },
    { schema_version: 1 },
    { schema_version: 1, toolchain: { origins: [] } },
    { schema_version: 1, toolchain: { origins: "https://a.example" } },
    { schema_version: 1, toolchain: { origins: ["http://a.example"] } },
    { schema_version: 1, toolchain: { origins: ["https://a.example", 42] } },
    { schema_version: 1, toolchain: { origins: ["not a url"] } },
  ]) {
    assert.equal(parseRedirectManifest(payload), null, JSON.stringify(payload));
  }
});

test("mergeOrigins de-duplicates with order preserved", () => {
  assert.deepEqual(mergeOrigins([ZACKEES, "https://x.example/"], [FORGE, ZACKEES]), [ZACKEES, "https://x.example", FORGE]);
});

test("manifest origins come first, then the built-in list, de-duplicated", async () => {
  const { fetch, calls } = mockFetch({
    [DEFAULT_TOOLCHAIN_REDIRECT_URL]: manifest(["https://mirror.example/soldr/", ZACKEES]),
  });
  const origins = await resolveToolchainOrigins({ env: {}, fetch });
  assert.deepEqual(origins, ["https://mirror.example/soldr", ZACKEES, FORGE]);
  assert.deepEqual(calls, [DEFAULT_TOOLCHAIN_REDIRECT_URL]);
});

test("the manifest is fetched once per process", async () => {
  const { fetch, calls } = mockFetch({ [DEFAULT_TOOLCHAIN_REDIRECT_URL]: manifest([ZACKEES]) });
  await resolveToolchainOrigins({ env: {}, fetch });
  await resolveToolchainOrigins({ env: {}, fetch });
  assert.equal(calls.length, 1);
});

test("an unreachable, invalid or erroring manifest falls back to the built-in list", async () => {
  const failures: Route[] = [
    new TypeError("fetch failed"),
    json({}, 404),
    json({}, 503),
    new Response("{not json", { status: 200 }),
    json({ schema_version: 2, toolchain: { origins: ["https://a.example"] } }),
    manifest(["http://insecure.example"]),
  ];
  for (const failure of failures) {
    resetToolchainRedirectCache();
    const logs: string[] = [];
    const { fetch } = mockFetch({ [DEFAULT_TOOLCHAIN_REDIRECT_URL]: failure });
    const origins = await resolveToolchainOrigins({ env: {}, fetch, log: (m) => logs.push(m) });
    assert.deepEqual(origins, [FORGE, ZACKEES]);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /using fallback origins/);
  }
});

test("a hung manifest request times out and falls back", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  const started = Date.now();
  const origins = await resolveToolchainOrigins({ env: {}, fetch: hang, timeoutMs: 50 });
  assert.deepEqual(origins, [FORGE, ZACKEES]);
  assert.ok(Date.now() - started < 5_000);
});

test("a failed manifest lookup is not repeated within the same run", async () => {
  const { fetch, calls } = mockFetch({ [DEFAULT_TOOLCHAIN_REDIRECT_URL]: json({}, 500) });
  assert.deepEqual(await resolveToolchainOrigins({ env: {}, fetch }), [FORGE, ZACKEES]);
  assert.deepEqual(await resolveToolchainOrigins({ env: {}, fetch }), [FORGE, ZACKEES]);
  assert.equal(calls.length, 1);
});

test("SOLDR_TOOLCHAIN_REDIRECT=0 skips the manifest", async () => {
  const { fetch, calls } = mockFetch({});
  assert.deepEqual(await resolveToolchainOrigins({ env: { SOLDR_TOOLCHAIN_REDIRECT: "0" }, fetch }), [FORGE, ZACKEES]);
  assert.deepEqual(calls, []);
});

test("SOLDR_TOOLCHAIN_REDIRECT_URL replaces the manifest URL", async () => {
  const custom = "https://example.test/redirect.json";
  const { fetch, calls } = mockFetch({ [custom]: manifest(["https://custom.example"]) });
  const origins = await resolveToolchainOrigins({ env: { SOLDR_TOOLCHAIN_REDIRECT_URL: custom }, fetch });
  assert.deepEqual(origins, ["https://custom.example", FORGE, ZACKEES]);
  assert.deepEqual(calls, [custom]);
});

test("SOLDR_TOOLCHAIN_ORIGIN wins and skips the redirect entirely", async () => {
  const { fetch, calls } = mockFetch({});
  const origins = await resolveToolchainOrigins({ env: { SOLDR_TOOLCHAIN_ORIGIN: "https://pinned.example/" }, fetch });
  assert.deepEqual(origins, ["https://pinned.example"]);
  assert.deepEqual(calls, []);
});

test("catalogue URL overrides bypass origins for their own file", async () => {
  const pinned = "https://pinned.example/catalogue.json";
  const { fetch, calls } = mockFetch({ [pinned]: json({ entries: [] }) });
  const { url } = await fetchToolchainJson("catalogue.v1.json", {
    env: { SOLDR_TOOLCHAIN_CATALOGUE_URL: pinned },
    fetch,
  });
  assert.equal(url, pinned);
  assert.deepEqual(calls, [pinned]);
});

test("file fetch fails over on network error, 404 and 5xx in origin order", async () => {
  for (const failure of [new TypeError("fetch failed"), json({}, 404), json({}, 502)] as Route[]) {
    resetToolchainRedirectCache();
    const { fetch, calls } = mockFetch({
      [DEFAULT_TOOLCHAIN_REDIRECT_URL]: json({}, 404),
      [`${FORGE}/cargo-chef/manifest.json`]: failure,
      [`${ZACKEES}/cargo-chef/manifest.json`]: json({ releases: [] }),
    });
    const { url, payload } = await fetchToolchainJson("cargo-chef/manifest.json", { env: {}, fetch });
    assert.equal(url, `${ZACKEES}/cargo-chef/manifest.json`);
    assert.deepEqual(payload, { releases: [] });
    assert.deepEqual(calls, [
      DEFAULT_TOOLCHAIN_REDIRECT_URL,
      `${FORGE}/cargo-chef/manifest.json`,
      `${ZACKEES}/cargo-chef/manifest.json`,
    ]);
  }
});

test("file fetch fails over when an origin times out", async () => {
  const hangingUrl = `${FORGE}/manifest.json`;
  const { fetch } = mockFetch({
    [hangingUrl]: () => new Promise<Response>(() => {}),
    [`${ZACKEES}/manifest.json`]: json({ ok: true }),
  });
  const wrapped = ((input: string, init?: RequestInit) =>
    String(input) === hangingUrl
      ? new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
      : fetch(input, init)) as typeof fetch;
  const { url } = await fetchToolchainFile("manifest.json", {
    env: { SOLDR_TOOLCHAIN_REDIRECT: "0" },
    fetch: wrapped,
    fileTimeoutMs: 50,
  });
  assert.equal(url, `${ZACKEES}/manifest.json`);
});

test("file fetch does not fail over on other HTTP errors", async () => {
  for (const status of [401, 403, 429]) {
    const { fetch, calls } = mockFetch({ [`${FORGE}/manifest.json`]: json({}, status) });
    await assert.rejects(
      fetchToolchainFile("manifest.json", { env: { SOLDR_TOOLCHAIN_REDIRECT: "0" }, fetch }),
      new RegExp(`HTTP ${status}`),
    );
    assert.deepEqual(calls, [`${FORGE}/manifest.json`]);
  }
});

test("content errors are hard errors, not a reason to try the next origin", async () => {
  const { fetch, calls } = mockFetch({ [`${FORGE}/manifest.json`]: new Response("<html>", { status: 200 }) });
  await assert.rejects(
    fetchToolchainJson("manifest.json", { env: { SOLDR_TOOLCHAIN_REDIRECT: "0" }, fetch }),
    /invalid JSON/,
  );
  assert.deepEqual(calls, [`${FORGE}/manifest.json`]);
});

test("every origin failing reports each attempt", async () => {
  const { fetch } = mockFetch({
    [`${FORGE}/manifest.json`]: json({}, 404),
    [`${ZACKEES}/manifest.json`]: new TypeError("fetch failed"),
  });
  await assert.rejects(
    fetchToolchainFile("manifest.json", { env: { SOLDR_TOOLCHAIN_REDIRECT: "0" }, fetch }),
    (error: Error) =>
      /unavailable from every origin/.test(error.message) &&
      error.message.includes(`${FORGE}/manifest.json: HTTP 404`) &&
      error.message.includes(`${ZACKEES}/manifest.json: network error: fetch failed`),
  );
});
