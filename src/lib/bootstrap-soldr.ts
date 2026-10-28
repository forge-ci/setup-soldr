import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { downloadWithHeaders, extractBinary } from "./ensure-soldr.js";

/** Immutable official bootstrap used before any managed Rust command is available. */
export const BOOTSTRAP_VERSION = "0.9.41";

const ASSET_DIGESTS: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "6570ceab93d53684712edf0d4799c46ed1f3015395e0f59b4edc69ffdb4ed073",
  "aarch64-pc-windows-msvc": "344cdd361af45dcdfd3ed24a20b9c76c78bdc68428130bbf762282fdcc1001ec",
  "aarch64-unknown-linux-gnu": "8bf26e271a08ac0e0cf2b7a16339e26ac6ba8dd78b0bf872ae9cab15cc2a6520",
  "aarch64-unknown-linux-musl": "bd2b4d33fa8e285b229317bdc401b54b495376ae566ae4089615d5d7b6ad8319",
  "x86_64-apple-darwin": "a0a08dc0a74cf6482753428f25567ceb2afc8cd014a0381408e97ad67381cde0",
  "x86_64-pc-windows-msvc": "22fc64c557e1d16684574e00f780215c093a295381be5ed6119e23438615e518",
  "x86_64-unknown-linux-gnu": "a8cee120efe4a4e102c9d08240847734e30cacfd23128c50942ab848c1191591",
  "x86_64-unknown-linux-musl": "4e37eb83c1541867de4ed199ec3d4c19055e29e87c84a27b98deeb4972f91567",
};

export function bootstrapAssetFor(platform: string, arch: string, libc: string): {
  target: string; filename: string; sha256: string; binaryName: string;
} {
  const architecture = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : "";
  const suffix = platform === "darwin" ? "apple-darwin"
    : platform === "win32" ? "pc-windows-msvc"
    : platform === "linux" && libc === "glibc" ? "unknown-linux-gnu"
    : platform === "linux" && libc === "musl" ? "unknown-linux-musl" : "";
  const target = `${architecture}-${suffix}`;
  const sha256 = ASSET_DIGESTS[target];
  if (!architecture || !suffix || !sha256) {
    throw new Error(`unsupported Soldr bootstrap host: ${platform}/${arch}/${libc}`);
  }
  return { target, filename: `soldr-v${BOOTSTRAP_VERSION}-${target}.tar.zst`, sha256,
    binaryName: platform === "win32" ? "soldr.exe" : "soldr" };
}

export function verifyBootstrapDigest(actual: string, expected: string): void {
  if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
    throw new Error("Soldr bootstrap archive SHA-256 mismatch");
  }
}


type BootstrapAsset = ReturnType<typeof bootstrapAssetFor>;
type BootstrapDeps = {
  download: (url: string, destination: string) => Promise<void>;
  extract: (archive: string, extension: "tar.zst", binaryName: string, out: string) => Promise<string>;
  version: (binary: string) => Promise<string>;
  digest?: (archive: string) => Promise<string>;
};

async function bootstrapVersion(binary: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SOLDR_NO_GLOBAL_DELEGATION: "1", SOLDR_BROKER_AUTOSPAWN: "0" };
    delete env.SOLDR_AS;
    const child = spawn(binary, ["--version"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let bytes = 0;
    let failure = "";
    const timer = setTimeout(() => { failure = "version probe timed out"; child.kill(); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) { failure = "version probe output exceeded 65536 bytes"; child.kill(); return; }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) { failure = "version probe output exceeded 65536 bytes"; child.kill(); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(new Error(`Soldr bootstrap ${failure || `version probe exited ${code}`}`)); return; }
      const match = /^soldr\s+(\S+)/m.exec(stdout);
      if (!match?.[1]) { reject(new Error("Soldr bootstrap version probe returned invalid output")); return; }
      resolve(match[1]);
    });
  });
}

/** Download and verify a pinned archive before executing its extracted binary. */
export async function ensureBootstrap(
  runnerTemp: string,
  asset: BootstrapAsset,
  deps: BootstrapDeps = {
    download: (url, destination) => downloadWithHeaders(url, destination, {}),
    extract: extractBinary,
    version: bootstrapVersion,
  },
  cacheDir?: string,
  prefilledArchive?: string,
): Promise<string> {
  const expected = ASSET_DIGESTS[asset.target];
  const filename = `soldr-v${BOOTSTRAP_VERSION}-${asset.target}.tar.zst`;
  const binaryName = asset.target.endsWith("-windows-msvc") ? "soldr.exe" : "soldr";
  if (!expected || asset.sha256 !== expected || asset.filename !== filename || asset.binaryName !== binaryName) {
    throw new Error("invalid Soldr bootstrap asset");
  }
  fs.mkdirSync(runnerTemp, { recursive: true });
  const root = fs.mkdtempSync(path.join(runnerTemp, "setup-soldr-bootstrap-"));
  const archiveDigest = async (archive: string): Promise<string> => {
    if (deps.digest) return await deps.digest(archive);
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  };
  const snapshotArchive = (source: string, snapshot: string): void => {
    // Reject special files before opening, and use nonblocking/no-follow flags
    // where available so a path swapped to a FIFO or symlink cannot stall us.
    if (!fs.lstatSync(source).isFile()) throw new Error("invalid Soldr bootstrap archive");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(source, flags);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("invalid Soldr bootstrap archive");
      // Bound the read even if the source grows after fstat. One extra byte
      // detects growth instead of silently accepting a truncated snapshot.
      const bytes = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== stat.size) throw new Error("Soldr bootstrap archive changed during read");
      fs.writeFileSync(snapshot, bytes.subarray(0, offset), { flag: "wx", mode: 0o600 });
    } finally {
      fs.closeSync(fd);
    }
  };
  let archive: string | undefined;
  if (prefilledArchive) {
    if (!path.isAbsolute(prefilledArchive)) throw new Error("Soldr bootstrap archive path must be absolute");
    archive = path.join(root, "prefilled.tar.zst");
    snapshotArchive(prefilledArchive, archive);
    verifyBootstrapDigest(await archiveDigest(archive), expected);
  }
  const cacheRoot = cacheDir ? path.join(cacheDir, BOOTSTRAP_VERSION, asset.target) : undefined;
  if (!archive && cacheRoot) {
    try {
      for (const [index, entry] of fs.readdirSync(cacheRoot, { withFileTypes: true }).entries()) {
        if (!entry.isDirectory()) continue;
        const candidateDir = path.join(cacheRoot, entry.name);
        const candidate = path.join(candidateDir, asset.filename);
        const snapshot = path.join(root, `cached-${index}.tar.zst`);
        try {
          if (!fs.lstatSync(path.join(candidateDir, "complete")).isFile()) continue;
          // Open once without following a final symlink. Copy into a private
          // per-run directory, then hash and extract only that same snapshot.
          snapshotArchive(candidate, snapshot);
          verifyBootstrapDigest(await archiveDigest(snapshot), expected);
          archive = snapshot;
          break;
        } catch {
          // Ignore incomplete, corrupt, or concurrently populated entries.
        }
      }
    } catch {
      // A missing or unreadable persistent cache is not itself fatal.
    }
  }
  if (!archive) {
    archive = path.join(root, asset.filename);
    const url = `https://github.com/forge-ci/soldr/releases/download/v${BOOTSTRAP_VERSION}/${asset.filename}`;
    await deps.download(url, archive);
    verifyBootstrapDigest(await archiveDigest(archive), expected);
    if (cacheRoot) {
      try {
        fs.mkdirSync(cacheRoot, { recursive: true });
        const directory = fs.mkdtempSync(path.join(cacheRoot, "archive-"));
        fs.copyFileSync(archive, path.join(directory, asset.filename), fs.constants.COPYFILE_EXCL);
        // Publish only after the complete, verified archive has been copied.
        fs.writeFileSync(path.join(directory, "complete"), "", { flag: "wx" });
      } catch {
        // The verified private copy still works when persistent caching fails.
      }
    }
  }
  const binary = await deps.extract(archive, "tar.zst", asset.binaryName, path.join(root, "extract"));
  const version = await deps.version(binary);
  if (version !== BOOTSTRAP_VERSION) throw new Error(`unexpected Soldr bootstrap version: ${version}`);
  return binary;
}
