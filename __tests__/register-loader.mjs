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
