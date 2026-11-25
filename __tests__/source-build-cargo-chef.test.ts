// setup-soldr#703: a source build must not push `soldr cook` onto an
// unauthenticated GitHub fetch for cargo-chef.
//
// The install itself needs the toolchain catalogue, so these tests pin the
// decision that guards it: when to install, and when to leave soldr alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import { cargoChefForSourceBuild } from "../src/lib/ensure-soldr.js";

test("a source build without the bundled payload gets a cargo-chef to install", () => {
  // 0.9.3 is in CARGO_CHEF_VERSION_BY_SOLDR; the release bundle carries 0.1.73.
  assert.equal(cargoChefForSourceBuild("0.9.3", false), "0.1.73");
});

test("a build that already has the payload installs nothing", () => {
  assert.equal(cargoChefForSourceBuild("0.9.3", true), null);
});

test("an unknown soldr version is not guessed at", () => {
  // No entry means we cannot know which cargo-chef this soldr expects, and
  // installing the wrong one is worse than fetching the right one.
  assert.equal(cargoChefForSourceBuild("0.0.1-not-a-release", false), null);
  assert.equal(cargoChefForSourceBuild(null, false), null);
});

test("the mapping is stable for every pinned soldr release", () => {
  for (const version of ["0.9.0", "0.9.1", "0.9.2", "0.9.3", "0.9.4"]) {
    assert.match(cargoChefForSourceBuild(version, false) ?? "", /^0\.1\.\d+$/, version);
  }
});
