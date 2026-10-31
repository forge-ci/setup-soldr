// Preload hook: register the .js -> .ts resolve loader so node --test can
// follow our TypeScript ESM source graph without ahead-of-time compilation.
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

// setup-soldr#527: cache saves are gated on GITHUB_EVENT_NAME and the
// save-cache input. Keep the suite hermetic when CI itself runs on a
// pull_request event; tests that exercise the gate set these explicitly.
delete process.env["GITHUB_EVENT_NAME"];
delete process.env["INPUT_SAVE-CACHE"];
// setup-soldr#587: auto also skips refs off the default branch, read from
// GITHUB_REF and the event payload's repository.default_branch.
delete process.env["GITHUB_REF"];
delete process.env["GITHUB_EVENT_PATH"];

// setup-soldr#647: give every test process its own temp root and remove it
// on exit. Test files, the code under test (snapshot-*, ws, ...) and any
// child processes all resolve os.tmpdir() through these variables, so no
// temp dir outlives the run even when a test never cleans up after itself.
// The runner process imports this too; its children nest inside its root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = tmpRoot;
process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort: a locked file on Windows must not fail the run.
  }
});
