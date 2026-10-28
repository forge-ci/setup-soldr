import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSoldr, _internal } from "../src/lib/ensure-soldr.js";

// Most of ensure-soldr's logic depends on external HTTP + subprocess, both of
// which we don't want to actually exercise in unit tests. We focus on the
// "module imports & exports the entry point" contract here and on the rest
// indirectly via main.test.ts which mocks ensureSoldr entirely.

test("ensureSoldr is an async function with one argument", () => {
  assert.equal(typeof ensureSoldr, "function");
  assert.equal(ensureSoldr.length, 1);
});

function tarEntry(name: string, bodyText: string, typeflag = "0"): Buffer {
  const body = Buffer.from(bodyText, "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function tarArchive(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

test("extractTarBuffer extracts release files without external tar or zstd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-tar-"));
  try {
    const archive = tarArchive([
      tarEntry("bin/", "", "5"),
      tarEntry("bin/soldr.exe", "soldr"),
      tarEntry("manifest.json", "{}"),
    ]);

    _internal.extractTarBuffer(archive, root);

    assert.equal(fs.readFileSync(path.join(root, "bin", "soldr.exe"), "utf8"), "soldr");
    assert.equal(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), "{}");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extractTarBuffer rejects path traversal entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-tar-safe-"));
  try {
    const archive = tarArchive([tarEntry("../escape.txt", "nope")]);

    assert.throws(
      () => _internal.extractTarBuffer(archive, root),
      /unsafe tar entry path/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("copyBundledReleasePayload keeps bundled tools from combined soldr archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-bundle-"));
  try {
    const extract = path.join(root, "extract", "soldr-v0.7.42-x86_64-unknown-linux-gnu");
    const install = path.join(root, "install");
    fs.mkdirSync(extract, { recursive: true });
    fs.mkdirSync(install, { recursive: true });
    for (const name of ["zccache", "zccache-soldr", "zccache-daemon", "zccache-fp", "soldr-daemon", "soldr-shim", "crgx", "cargo-chef", "soldr-clang-shim", "manifest.json"]) {
      fs.writeFileSync(path.join(extract, name), name);
    }

    const copied = _internal.copyBundledReleasePayload(extract, install, "soldr");

    assert.deepEqual(copied.sort(), ["cargo-chef", "crgx", "manifest.json", "soldr-clang-shim", "soldr-daemon", "soldr-shim", "zccache", "zccache-daemon", "zccache-fp", "zccache-soldr"].sort());
    for (const name of copied) {
      assert.equal(fs.readFileSync(path.join(install, name), "utf8"), name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectReleaseAsset skips a -symbols sidecar listed before the real archive", () => {
  const target = "x86_64-unknown-linux-gnu";
  const release = {
    tag_name: "v0.9.12",
    assets: [
      {
        name: `soldr-v0.9.12-${target}-symbols.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${target}-symbols.tar.zst`,
      },
      {
        name: `soldr-v0.9.12-${target}.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${target}.tar.zst`,
      },
    ],
  };

  assert.deepEqual(_internal.selectReleaseAsset(release, target), {
    name: `soldr-v0.9.12-${target}.tar.zst`,
    url: `https://example.invalid/soldr-v0.9.12-${target}.tar.zst`,
    archiveExt: "tar.zst",
    source: "github-release",
  });
});

test("selectReleaseAsset returns null when a release only publishes symbols sidecars", () => {
  const target = "aarch64-unknown-linux-gnu";
  const release = {
    tag_name: "v0.9.12",
    assets: [
      {
        name: `soldr-v0.9.12-${target}-symbols.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${target}-symbols.tar.zst`,
      },
      {
        name: `soldr-v0.9.12-${target}-symbols.tar.gz`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${target}-symbols.tar.gz`,
      },
    ],
  };

  assert.equal(_internal.selectReleaseAsset(release, target), null);
});

test("selectReleaseAsset prefers the exact soldr-<tag>-<target>.<ext> name over a looser substring match", () => {
  const target = "x86_64-unknown-linux-gnu";
  const release = {
    tag_name: "v0.9.12",
    assets: [
      {
        // Substring match only (e.g. a musl variant that also contains the gnu target string
        // as a prefix collision) — must lose to the exact match below.
        name: `soldr-v0.9.12-${target}-old-variant.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${target}-old-variant.tar.zst`,
      },
      {
        name: `soldr-v0.9.12-${target}.tar.zst`,
        browser_download_url: `https://example.invalid/soldr-v0.9.12-${target}.tar.zst`,
      },
    ],
  };

  assert.deepEqual(_internal.selectReleaseAsset(release, target), {
    name: `soldr-v0.9.12-${target}.tar.zst`,
    url: `https://example.invalid/soldr-v0.9.12-${target}.tar.zst`,
    archiveExt: "tar.zst",
    source: "github-release",
  });
});

test("selectReleaseAsset keeps prior first-match behaviour for older releases with no exact name", () => {
  const target = "x86_64-pc-windows-msvc";
  const release = {
    tag_name: "v0.7.10",
    assets: [
      {
        name: `soldr-${target}.zip`,
        browser_download_url: `https://example.invalid/soldr-${target}.zip`,
      },
    ],
  };

  assert.deepEqual(_internal.selectReleaseAsset(release, target), {
    name: `soldr-${target}.zip`,
    url: `https://example.invalid/soldr-${target}.zip`,
    archiveExt: "zip",
    source: "github-release",
  });
});

test("selectPypiWheel maps an official wheel to the requested target and digest", () => {
  const selected = _internal.selectPypiWheel(
    {
      urls: [
        {
          filename: "soldr-0.9.0-py3-none-win_amd64.whl",
          url: "https://files.pythonhosted.org/soldr-0.9.0-py3-none-win_amd64.whl",
          digests: { sha256: "a".repeat(64) },
          yanked: false,
        },
        {
          filename: "soldr-0.9.0-py3-none-win_arm64.whl",
          url: "https://files.pythonhosted.org/soldr-0.9.0-py3-none-win_arm64.whl",
          digests: { sha256: "b".repeat(64) },
          yanked: false,
        },
      ],
    },
    "aarch64-pc-windows-msvc",
  );

  assert.deepEqual(selected, {
    name: "soldr-0.9.0-py3-none-win_arm64.whl",
    url: "https://files.pythonhosted.org/soldr-0.9.0-py3-none-win_arm64.whl",
    archiveExt: "whl",
    source: "pypi-wheel",
    expectedSha256: "b".repeat(64),
  });
});

test("selectPypiWheel rejects wheel metadata without a valid SHA-256", () => {
  assert.equal(
    _internal.selectPypiWheel(
      {
        urls: [
          {
            filename: "soldr-0.9.0-py3-none-win_arm64.whl",
            url: "https://files.pythonhosted.org/soldr-0.9.0-py3-none-win_arm64.whl",
            digests: {},
          },
        ],
      },
      "aarch64-pc-windows-msvc",
    ),
    null,
  );
});

test("wheel extraction stages a .zip name for Windows PowerShell compatibility", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-wheel-zip-"));
  try {
    const wheel = path.join(root, "soldr.whl");
    fs.writeFileSync(wheel, "zip payload");
    const staged = _internal.prepareZipArchivePath(wheel, "whl");
    assert.equal(staged, `${wheel}.zip`);
    assert.equal(fs.readFileSync(staged, "utf8"), "zip payload");
    assert.equal(_internal.prepareZipArchivePath(staged, "zip"), staged);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PyPI fallback is restricted to the official soldr repository", () => {
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.0"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("ZACKEES/SOLDR", "v0.9.0"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.1"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.2"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.3"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.4"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.5"), true);
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.9.6"), true);
  for (let patch = 7; patch <= 27; patch += 1) {
    assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", `0.9.${patch}`), true);
  }
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.0"), false);
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.1"), false);
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.2"), false);
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.3"), false);
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.4"), false);
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.5"), false);
  assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", "0.9.6"), false);
  for (let patch = 7; patch <= 27; patch += 1) {
    assert.equal(_internal.canUseOfficialPypiFallback("fork/soldr", `0.9.${patch}`), false);
  }
  assert.equal(_internal.canUseOfficialPypiFallback("zackees/soldr", "0.8.44"), false);
});

test("soldr 0.9.0 through 0.9.27 wheel installs use their pinned cargo-chef support release", () => {
  assert.equal(_internal.bundledCargoChefVersionForSoldr("v0.9.0"), "0.1.73");
  for (let patch = 1; patch <= 27; patch += 1) {
    assert.equal(_internal.bundledCargoChefVersionForSoldr(`0.9.${patch}`), "0.1.73");
  }
  assert.equal(_internal.bundledCargoChefVersionForSoldr("v0.9.22"), "0.1.73");
});

test("selectToolchainSupportAsset matches the complete host platform", () => {
  const selected = _internal.selectToolchainSupportAsset(
    {
      releases: [
        {
          version: "v0.1.73",
          platforms: [
            {
              platform: { os: "linux", arch: "x86_64", libc: "glibc" },
              asset: { filename: "wrong.tar.zst", urls: ["https://example.invalid/wrong"], sha256: "a".repeat(64) },
            },
            {
              platform: { os: "linux", arch: "x86_64", libc: "musl" },
              asset: { filename: "bundle.tar.zst", urls: ["https://example.invalid/right"], sha256: "b".repeat(64) },
            },
          ],
        },
      ],
    },
    "0.1.73",
    "x86_64-unknown-linux-gnu",
  );

  assert.deepEqual(selected, {
    filename: "bundle.tar.zst",
    urls: ["https://example.invalid/right"],
    sha256: "b".repeat(64),
    archiveExt: "tar.zst",
  });
});

test("wheel installs materialize the soldr-daemon multicall alias", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-wheel-alias-"));
  try {
    fs.writeFileSync(path.join(root, "soldr.exe"), "multicall");
    assert.equal(_internal.ensureMulticallRuntimeAlias(root, "soldr.exe"), "soldr-daemon.exe");
    assert.equal(fs.readFileSync(path.join(root, "soldr-daemon.exe"), "utf8"), "multicall");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PyPI wheel digest verification fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-wheel-digest-"));
  try {
    const wheel = path.join(root, "soldr.whl");
    fs.writeFileSync(wheel, "verified wheel bytes");
    const digest = "0772cc9226f7820d08d74d548c7e451b651fcae0195340f609a3aa011fbe9c76";
    assert.doesNotThrow(() => _internal.verifyDownloadedAsset(wheel, digest));
    assert.throws(() => _internal.verifyDownloadedAsset(wheel, "0".repeat(64)), /SHA-256 mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clearBundledReleasePayload removes stale sibling bundled tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-clear-"));
  try {
    for (const name of ["zccache.exe", "zccache-soldr.exe", "zccache-daemon.exe", "zccache-fp.exe", "soldr-daemon.exe", "soldr-shim.exe", "crgx.exe", "cargo-chef.exe", "soldr-clang-shim.exe", "manifest.json"]) {
      fs.writeFileSync(path.join(root, name), "stale");
    }

    _internal.clearBundledReleasePayload(root, "soldr.exe");

    for (const name of ["zccache.exe", "zccache-soldr.exe", "zccache-daemon.exe", "zccache-fp.exe", "soldr-daemon.exe", "soldr-shim.exe", "crgx.exe", "cargo-chef.exe", "soldr-clang-shim.exe", "manifest.json"]) {
      assert.equal(fs.existsSync(path.join(root, name)), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasBundledZccachePayload requires the full zccache trio", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-bundle-"));
  try {
    fs.writeFileSync(path.join(root, "zccache.exe"), "zccache");
    fs.writeFileSync(path.join(root, "zccache-daemon.exe"), "zccache-daemon");
    assert.equal(_internal.hasBundledZccachePayload(root, "soldr.exe"), false);

    fs.writeFileSync(path.join(root, "zccache-fp.exe"), "zccache-fp");
    assert.equal(_internal.hasBundledZccachePayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasEmbeddedZccachePayload requires soldr embedded runtime payload only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-embedded-"));
  try {
    assert.equal(_internal.hasEmbeddedZccachePayload(root, "soldr.exe"), false);

    fs.writeFileSync(path.join(root, "soldr-daemon.exe"), "soldr-daemon");
    assert.equal(_internal.hasEmbeddedZccachePayload(root, "soldr.exe"), false);

    fs.writeFileSync(path.join(root, "soldr-shim.exe"), "soldr-shim");
    assert.equal(_internal.hasEmbeddedZccachePayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multicall soldr releases require the daemon alias but no legacy shim sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-multicall-payload-"));
  try {
    fs.writeFileSync(path.join(root, "soldr-daemon.exe"), "soldr-daemon");
    fs.writeFileSync(path.join(root, "cargo-chef.exe"), "cargo-chef");

    assert.equal(_internal.hasMulticallRuntimePayload(root, "soldr.exe"), true);
    assert.equal(_internal.hasRequiredReleasePayload(root, "soldr.exe", "0.8.18"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-multicall embedded releases still require their legacy sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-legacy-payload-"));
  try {
    for (const name of ["soldr-daemon.exe", "cargo-chef.exe"]) {
      fs.writeFileSync(path.join(root, name), name);
    }
    assert.equal(_internal.hasRequiredReleasePayload(root, "soldr.exe", "0.8.0"), false);

    for (const name of ["soldr-shim.exe", "soldr-clang-shim.exe"]) {
      fs.writeFileSync(path.join(root, name), name);
    }
    assert.equal(_internal.hasRequiredReleasePayload(root, "soldr.exe", "0.8.0"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasBundledCargoChefPayload checks the platform cargo-chef binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-chef-"));
  try {
    assert.equal(_internal.hasBundledCargoChefPayload(root, "soldr.exe"), false);
    fs.writeFileSync(path.join(root, "cargo-chef.exe"), "cargo-chef");
    assert.equal(_internal.hasBundledCargoChefPayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasBundledClangShimPayload checks the platform soldr-clang-shim binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-soldr-has-shim-"));
  try {
    assert.equal(_internal.hasBundledClangShimPayload(root, "soldr.exe"), false);
    fs.writeFileSync(path.join(root, "soldr-clang-shim.exe"), "soldr-clang-shim");
    assert.equal(_internal.hasBundledClangShimPayload(root, "soldr.exe"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("versionAtLeast gates clang-shim requirement at soldr 0.7.66", () => {
  assert.equal(_internal.versionAtLeast("0.7.65", "0.7.66"), false);
  assert.equal(_internal.versionAtLeast("v0.7.66", "0.7.66"), true);
  assert.equal(_internal.versionAtLeast("0.7.98", "0.7.66"), true);
});

test("versionAtLeast gates cargo-chef requirement at soldr 0.7.43", () => {
  assert.equal(_internal.versionAtLeast("0.7.42", "0.7.43"), false);
  assert.equal(_internal.versionAtLeast("v0.7.43", "0.7.43"), true);
  assert.equal(_internal.versionAtLeast("0.7.44", "0.7.43"), true);
});

test("ensureSoldr rejects with a clear message for unknown arch (mocked)", async () => {
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    Object.defineProperty(process, "arch", { value: "mips" as NodeJS.Architecture, configurable: true });
    // We expect the underlying detectTarget to throw.
    const resolveResult = {
      soldrPath: "/tmp/soldr-bin/soldr",
      soldrRepo: "zackees/soldr",
      soldrRef: "",
      soldrVersionRequested: "",
      soldrVersionResolved: "v0.7.18",
    } as Parameters<typeof ensureSoldr>[0]["resolveResult"];
    await assert.rejects(
      ensureSoldr({ resolveResult, githubToken: "" }),
      /unsupported architecture/,
    );
  } finally {
    if (originalArch) Object.defineProperty(process, "arch", originalArch);
  }
});

test("local source build invokes the verified bootstrap from a spaced path", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soldr source build "));
  const source = path.join(root, "source tree");
  const install = path.join(root, "install dir");
  fs.mkdirSync(source);
  const fake = path.join(root, "verified bootstrap");
  const marker = path.join(root, "arguments");
  fs.writeFileSync(fake, `#!/bin/sh
printf '%s|%s|%s|%s|%s\\n' "$*" "$PWD" "$SOLDR_NO_GLOBAL_DELEGATION" "$SOLDR_RUSTC_WRAPPER" "$SOLDR_BROKER_AUTOSPAWN" > "$SOURCE_BUILD_MARKER"
for last do :; done
mkdir -p "$CARGO_TARGET_DIR/$last/debug"
printf '#!/bin/sh\\necho '\''{"soldr_version":"0.0.1"}'\''\\n' > "$CARGO_TARGET_DIR/$last/debug/soldr"
chmod +x "$CARGO_TARGET_DIR/$last/debug/soldr"
`, { mode: 0o755 });
  const old = process.env.SOURCE_BUILD_MARKER;
  const oldWrapper = process.env.SOLDR_RUSTC_WRAPPER;
  process.env.SOURCE_BUILD_MARKER = marker;
  process.env.SOLDR_RUSTC_WRAPPER = "existing-wrapper";
  try {
    const result = {
      soldrPath: path.join(install, "soldr"), soldrRef: "", soldrVersionRequested: "",
      soldrRepo: "forge-ci/soldr", soldrSourcePath: source,
      soldrSourceIdentity: path.basename(root).replaceAll(" ", "-"),
    } as Parameters<typeof ensureSoldr>[0]["resolveResult"];
    await assert.rejects(() => ensureSoldr({ resolveResult: result, githubToken: "" }), /verified Soldr bootstrap required/);
    await ensureSoldr({ resolveResult: result, githubToken: "", bootstrapSoldr: fake });
    const observed = fs.readFileSync(marker, "utf8").trim();
    assert.match(observed, /^--no-cache cargo build --locked --bin soldr --target \S+\|/);
    assert.ok(observed.endsWith(`|${source}|1|none|0`));
    assert.ok(fs.existsSync(path.join(install, "soldr")));
  } finally {
    if (old === undefined) delete process.env.SOURCE_BUILD_MARKER;
    else process.env.SOURCE_BUILD_MARKER = old;
    if (oldWrapper === undefined) delete process.env.SOLDR_RUSTC_WRAPPER;
    else process.env.SOLDR_RUSTC_WRAPPER = oldWrapper;
  }
});
