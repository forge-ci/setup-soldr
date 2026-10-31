import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Prevent auto-invocation when main.ts is imported.
process.env["SETUP_SOLDR_TEST_IMPORT"] = "1";

const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Set up ephemeral GitHub Actions file-protocol env vars and return a cleanup
 * function that restores the originals.
 */
function setupGithubEnvFiles(root: string): () => void {
  const outputPath = path.join(root, "GITHUB_OUTPUT");
  const envPath = path.join(root, "GITHUB_ENV");
  const pathPath = path.join(root, "GITHUB_PATH");
  const statePath = path.join(root, "GITHUB_STATE");

  fs.writeFileSync(outputPath, "", "utf8");
  fs.writeFileSync(envPath, "", "utf8");
  fs.writeFileSync(pathPath, "", "utf8");
  fs.writeFileSync(statePath, "", "utf8");

  const saved: Record<string, string | undefined> = {
    GITHUB_OUTPUT: process.env["GITHUB_OUTPUT"],
    GITHUB_ENV: process.env["GITHUB_ENV"],
    GITHUB_PATH: process.env["GITHUB_PATH"],
    GITHUB_STATE: process.env["GITHUB_STATE"],
  };

  process.env["GITHUB_OUTPUT"] = outputPath;
  process.env["GITHUB_ENV"] = envPath;
  process.env["GITHUB_PATH"] = pathPath;
  process.env["GITHUB_STATE"] = statePath;

  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("dry run: SETUP_SOLDR_DRY_RUN=1 skips install and logs DRY RUN", async () => {
  const root = mkTmp("setup-soldr-dry-run-");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  const logFile = path.join(root, "dry-run.log");

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });

  const restoreGithubEnv = setupGithubEnvFiles(root);

  // Save env vars we're about to set so we can restore them.
  const envKeys = [
    "SETUP_SOLDR_DRY_RUN",
    "ACTION_WORKSPACE",
    "RUNNER_TEMP",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "GITHUB_SHA",
    "INPUT_VERSION",
    "INPUT_CACHE",
    "INPUT_BUILD_CACHE",
    "INPUT_CARGO_REGISTRY_CACHE",
    "INPUT_TIMESTAMPS",
    "INPUT_TOOLCHAIN_FILE",
    "INPUT_LINKER",
    "SETUP_SOLDR_LOG",
    "HOME",
    "USERPROFILE",
    "CARGO_HOME",
    "RUSTUP_HOME",
  ] as const;

  const saved: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    saved[key] = process.env[key];
  }

  try {
    process.env["SETUP_SOLDR_DRY_RUN"] = "1";
    process.env["ACTION_WORKSPACE"] = workspace;
    process.env["RUNNER_TEMP"] = runnerTemp;
    process.env["RUNNER_OS"] = "Linux";
    process.env["RUNNER_ARCH"] = "X64";
    process.env["GITHUB_SHA"] = "abc123";
    process.env["INPUT_VERSION"] = "0.7.21";
    process.env["INPUT_CACHE"] = "false";
    process.env["INPUT_BUILD_CACHE"] = "false";
    process.env["INPUT_CARGO_REGISTRY_CACHE"] = "false";
    process.env["INPUT_TIMESTAMPS"] = "false";
    process.env["INPUT_TOOLCHAIN_FILE"] = "";
    process.env["INPUT_LINKER"] = "platform-default";
    process.env["SETUP_SOLDR_LOG"] = logFile;
    process.env["HOME"] = path.join(root, "home");
    process.env["USERPROFILE"] = path.join(root, "home");
    process.env["CARGO_HOME"] = path.join(root, "cargo-home");
    process.env["RUSTUP_HOME"] = path.join(root, "rustup-home");

    const { run } = (await import("../src/main.js")) as { run: () => Promise<void> };

    // Should complete without throwing.
    await run();

    // Assert log file was written.
    assert.ok(fs.existsSync(logFile), "log file should exist");

    const logContents = fs.readFileSync(logFile, "utf8");
    assert.ok(logContents.length > 0, "log file should not be empty");

    // Assert DRY RUN marker is present.
    assert.ok(
      logContents.includes("DRY RUN"),
      `expected "DRY RUN" in log file, got:\n${logContents}`,
    );
  } finally {
    // Restore env vars.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreGithubEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
