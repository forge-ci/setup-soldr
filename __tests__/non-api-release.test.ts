import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fetchReleaseTagDefault, resolveSoldrReleaseVersion } from "../src/lib/fetch-release.js";
import { DEFAULT_SOLDR_VERSION } from "../src/lib/default-soldr-version.js";
import { githubApiUrl } from "../src/lib/github-api.js";
import { _internal } from "../src/lib/ensure-soldr.js";

type Call = { url: string; method: string; auth: string };

function mockFetch(handler: (url: string, method: string) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, auth: headers["Authorization"] ?? "" });
    return handler(url, method);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("anonymous latest-tag lookup uses the web redirect, not the REST API", async () => {
  const m = mockFetch(() =>
    new Response(null, { status: 302, headers: { location: "https://github.com/zackees/soldr/releases/tag/v0.9.25" } }),
  );
  try {
    assert.equal(await fetchReleaseTagDefault("zackees/soldr", "", {}), "v0.9.25");
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0]!.url, "https://github.com/zackees/soldr/releases/latest");
    assert.ok(m.calls.every((c) => !c.url.includes("api.github.com")));
  } finally {
    m.restore();
  }
});

test("anonymous latest-tag lookup falls back to the REST API when the redirect fails", async () => {
  const m = mockFetch((url) =>
    url.includes("api.github.com") ? json({ tag_name: "v0.9.26" }) : new Response(null, { status: 404 }),
  );
  try {
    assert.equal(await fetchReleaseTagDefault("zackees/soldr", "", {}), "v0.9.26");
    assert.deepEqual(m.calls.map((c) => c.url), [
      "https://github.com/zackees/soldr/releases/latest",
      "https://api.github.com/repos/zackees/soldr/releases/latest",
    ]);
  } finally {
    m.restore();
  }
});

test("authenticated latest-tag lookup keeps the REST API path", async () => {
  const m = mockFetch(() => json({ tag_name: "v0.9.27" }));
  try {
    assert.equal(await fetchReleaseTagDefault("zackees/soldr", "", { INPUT_TOKEN: "tok" }), "v0.9.27");
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0]!.url, "https://api.github.com/repos/zackees/soldr/releases/latest");
    assert.equal(m.calls[0]!.auth, "Bearer tok");
  } finally {
    m.restore();
  }
});

test("authenticated latest-tag lookup can recover from a REST timeout without forwarding the token", async () => {
  const m = mockFetch((url) => {
    if (url.startsWith("https://api.github.com/")) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (url.includes("/zackees/soldr/")) {
      return new Response(null, { status: 301, headers: { location: "https://github.com/forge-ci/soldr/releases/latest" } });
    }
    return new Response(null, { status: 302, headers: { location: "/forge-ci/soldr/releases/tag/v0.9.57" } });
  });
  try {
    assert.equal(await fetchReleaseTagDefault("zackees/soldr", "", { INPUT_TOKEN: "tok" }), "v0.9.57");
    assert.deepEqual(m.calls, [
      { url: "https://api.github.com/repos/zackees/soldr/releases/latest", method: "GET", auth: "Bearer tok" },
      { url: "https://github.com/zackees/soldr/releases/latest", method: "HEAD", auth: "" },
      { url: "https://github.com/forge-ci/soldr/releases/latest", method: "HEAD", auth: "" },
    ]);
  } finally {
    m.restore();
  }
});

test("latest-tag lookup refuses a release redirect to another origin", async () => {
  const m = mockFetch((url) => {
    if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 503 });
    return new Response(null, { status: 301, headers: { location: "https://example.org/forge-ci/soldr/releases/tag/v0.9.57" } });
  });
  try {
    await assert.rejects(
      fetchReleaseTagDefault("zackees/soldr", "", { INPUT_TOKEN: "tok" }),
      /release redirect.*outside GitHub/,
    );
    assert.equal(m.calls.length, 2);
  } finally {
    m.restore();
  }
});

test("authenticated latest-tag lookup never falls back from a custom API endpoint to github.com", async () => {
  const m = mockFetch(() => new Response(null, { status: 503 }));
  try {
    await assert.rejects(fetchReleaseTagDefault("acme/private", "", {
      GITHUB_API_URL: "https://git.acme.example/api/v3",
      INPUT_TOKEN: "tok",
    }), /GitHub API returned HTTP 503/);
    assert.deepEqual(m.calls.map((c) => c.url), ["https://git.acme.example/api/v3/repos/acme/private/releases/latest"]);
  } finally {
    m.restore();
  }
});

test("authenticated latest-tag lookup reports both surfaces when neither is available", async () => {
  const m = mockFetch((url) => new Response(null, { status: url.includes("api.github.com") ? 503 : 502 }));
  try {
    await assert.rejects(
      fetchReleaseTagDefault("zackees/soldr", "", { INPUT_TOKEN: "tok" }),
      /latest Soldr release.*GitHub API.*HTTP 503.*release redirect.*HTTP 502/,
    );
  } finally {
    m.restore();
  }
});

test("anonymous exact release resolves assets from releases/download without the REST API", async () => {
  const m = mockFetch((url) => new Response(null, { status: url.endsWith(".tar.zst") ? 200 : 404 }));
  try {
    const release = await _internal.fetchRelease("zackees/soldr", "v0.9.25", "", "x86_64-unknown-linux-gnu");
    const asset = _internal.selectReleaseAsset(release, "x86_64-unknown-linux-gnu");
    assert.equal(
      asset?.url,
      "https://github.com/zackees/soldr/releases/download/v0.9.25/soldr-v0.9.25-x86_64-unknown-linux-gnu.tar.zst",
    );
    assert.ok(m.calls.every((c) => !c.url.includes("api.github.com")));
  } finally {
    m.restore();
  }
});

test("anonymous exact release falls back to the REST API when no asset probe hits", async () => {
  const m = mockFetch((url) =>
    url.includes("api.github.com") ? json({ tag_name: "v0.9.25", assets: [] }) : new Response(null, { status: 404 }),
  );
  try {
    const release = await _internal.fetchRelease("zackees/soldr", "v0.9.25", "", "x86_64-unknown-linux-gnu");
    assert.equal(release["tag_name"], "v0.9.25");
    assert.equal(m.calls.at(-1)!.url, "https://api.github.com/repos/zackees/soldr/releases/tags/v0.9.25");
  } finally {
    m.restore();
  }
});

test("authenticated exact release keeps the REST API path", async () => {
  const m = mockFetch(() => json({ tag_name: "v0.9.25", assets: [] }));
  try {
    await _internal.fetchRelease("zackees/soldr", "v0.9.25", "tok", "x86_64-unknown-linux-gnu");
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0]!.url, "https://api.github.com/repos/zackees/soldr/releases/tags/v0.9.25");
    assert.equal(m.calls[0]!.auth, "Bearer tok");
  } finally {
    m.restore();
  }
});

test("omitted/default version is vendor-locked with zero network lookups", async () => {
  const m = mockFetch(() => { throw new Error("unexpected network call"); });
  try {
    for (const requested of ["", "  ", "default", "DEFAULT"]) {
      assert.equal(
        await resolveSoldrReleaseVersion("zackees/soldr", requested, "", {}),
        `v${DEFAULT_SOLDR_VERSION}`,
      );
    }
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("explicit latest resolves through the web redirect", async () => {
  const m = mockFetch(() =>
    new Response(null, { status: 302, headers: { location: "https://github.com/zackees/soldr/releases/tag/v9.9.9" } }),
  );
  try {
    assert.equal(await resolveSoldrReleaseVersion("zackees/soldr", "latest", "", {}), "v9.9.9");
    assert.ok(m.calls.every((c) => !c.url.includes("api.github.com")));
  } finally {
    m.restore();
  }
});

test("action.yml version default matches the baked DEFAULT_SOLDR_VERSION", () => {
  const action = fs.readFileSync("action.yml", "utf8");
  const match = action.match(/^  version:\r?\n[\s\S]*?^    default:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  assert.equal(match?.[1]?.trim(), DEFAULT_SOLDR_VERSION);
});

test("every REST call honors a GITHUB_API_URL carrying a path prefix", async () => {
  const base = "http://127.0.0.1:8123/secret-path/";
  const saved = process.env["GITHUB_API_URL"];
  process.env["GITHUB_API_URL"] = base;
  const m = mockFetch((url) => {
    if (url.startsWith("https://github.com/")) return new Response(null, { status: 404 });
    if (url.includes("/commits/")) return json({ sha: "a".repeat(40) });
    if (url.includes("/releases/")) return json({ tag_name: "v0.9.25", assets: [] });
    return new Response(null, { status: 404 });
  });
  try {
    // Token path (straight to REST) and anonymous fallback path.
    await fetchReleaseTagDefault("zackees/soldr", "", { INPUT_TOKEN: "tok" });
    await fetchReleaseTagDefault("zackees/soldr", "", {});
    await _internal.fetchRelease("zackees/soldr", "v0.9.25", "tok", "x86_64-unknown-linux-gnu");
    await _internal.fetchRelease("zackees/soldr", "v0.9.25", "", "x86_64-unknown-linux-gnu");
    await _internal.fetchRelease("zackees/soldr", "", "", "x86_64-unknown-linux-gnu");
    await _internal.resolveRefCommitSha("zackees/soldr", "main", "");
    const rest = m.calls.filter((c) => !c.url.startsWith("https://github.com/"));
    assert.deepEqual(rest.map((c) => c.url), [
      "http://127.0.0.1:8123/secret-path/repos/zackees/soldr/releases/latest",
      "http://127.0.0.1:8123/secret-path/repos/zackees/soldr/releases/latest",
      "http://127.0.0.1:8123/secret-path/repos/zackees/soldr/releases/tags/v0.9.25",
      "http://127.0.0.1:8123/secret-path/repos/zackees/soldr/releases/tags/v0.9.25",
      "http://127.0.0.1:8123/secret-path/repos/zackees/soldr/releases/latest",
      "http://127.0.0.1:8123/secret-path/repos/zackees/soldr/commits/main",
    ]);
    assert.ok(m.calls.every((c) => !c.url.includes("api.github.com")));
    assert.equal(githubApiUrl("repos/o/r/zipball/abc"), "http://127.0.0.1:8123/secret-path/repos/o/r/zipball/abc");
    assert.equal(githubApiUrl("/repos/o/r", {}), "https://api.github.com/repos/o/r");
  } finally {
    m.restore();
    if (saved === undefined) delete process.env["GITHUB_API_URL"];
    else process.env["GITHUB_API_URL"] = saved;
  }
});
