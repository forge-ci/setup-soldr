import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync("action.yml", "utf8");
const rustCi = readFileSync(".github/workflows/rust-ci.yml", "utf8");

test("action and reusable Rust CI default Dylint tools to Soldr's 6.2.0 pin", () => {
  for (const name of ["cargo-dylint-version", "dylint-link-version"]) {
    assert.match(
      action,
      new RegExp(`${name}:[\\s\\S]*?default: "6\\.2\\.0"`),
      `${name} action default must remain 6.2.0`,
    );
    assert.match(
      rustCi,
      new RegExp(`${name}:[\\s\\S]*?default: "6\\.2\\.0"`),
      `${name} reusable-workflow default must remain 6.2.0`,
    );
  }
});

test("reusable Rust CI delegates the complete Dylint foundation to setup-soldr", () => {
  assert.match(rustCi, /dylint: true/);
  assert.doesNotMatch(rustCi, /soldr cargo install[\s\S]*cargo-dylint/);
  assert.match(
    rustCi,
    /cargo-dylint-version: \$\{\{ inputs\.cargo-dylint-version \}\}/,
  );
  assert.match(
    rustCi,
    /dylint-link-version: \$\{\{ inputs\.dylint-link-version \}\}/,
  );
});
