# setup-soldr

[![Setup Soldr Action](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml/badge.svg)](https://github.com/zackees/setup-soldr/actions/workflows/setup-soldr-action.yml)

Public GitHub Action for installing one released `soldr` binary, provisioning the resolved Rust toolchain, and restoring cacheable Soldr/zccache state without rehydrating large Cargo or toolchain homes by default. The default Soldr version is `0.9.35`.

This repository is intended to be generated from `zackees/soldr`. The source-of-truth contract and release process still live in `soldr` issue #137 and `docs/SETUP_SOLDR_PUBLIC_ACTION.md`.

## Usage

### Linux

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
      - run: soldr cargo build --locked --release
      - run: soldr cargo test --locked
```

### Self-build cleanup

Projects that build zccache or soldr with setup-soldr should stop the builder
cache daemon before running tests that exercise cache lifecycle behavior. Insert
the cleanup sub-action between the builder phase and the test phase:

```yaml
- uses: zackees/setup-soldr@v0
  with:
    cache: true
- run: soldr cargo build --workspace --locked
- uses: zackees/setup-soldr/cleanup@v0
  with:
    shutdown-timeout-seconds: 30
- run: soldr cargo test --workspace --locked
  env:
    SOLDR_CACHE_DIR: ${{ runner.temp }}/self-test-soldr
    ZCCACHE_CACHE_DIR: ${{ runner.temp }}/self-test-soldr/cache/zccache
```

The cleanup action calls `soldr cache shutdown` using the setup-soldr cache root
and fails by default if the scoped shutdown cannot be confirmed. The normal
setup-soldr post step still runs later so final cache saves see a quiescent
cache directory.

### Deferred dependency prebuilds

Use the cook sub-action when a workflow must run target-specific setup before
`soldr cook`. This keeps the main setup-soldr step focused on installing soldr
and the toolchain, then restores/runs/saves the cook cache after your workflow
has exported the target environment:

```yaml
- uses: zackees/setup-soldr@v0
  with:
    cache: true
    prebuild-deps: none
- run: soldr prepare --target x86_64-pc-windows-msvc --github-env
- uses: zackees/setup-soldr/cook@v0
  with:
    flags: --profile ci-nextest --target x86_64-pc-windows-msvc --package soldr-cli
- run: soldr build --target x86_64-pc-windows-msvc --profile ci-nextest --package soldr-cli
```

The cook sub-action uses the same base/delta cache helpers as the main action.
Its key includes runner OS, arch, libc, rustc release, soldr version,
`Cargo.lock`, and material cook flags. The delta layer also includes a build
shape derived after this step starts, so target/profile-shaped cooks do not
depend on setup-soldr's earlier main-action timing.

During setup, the action also checks the installed soldr zccache backend.
For soldr releases with embedded zccache, no seed is needed. Older soldr
releases still seed soldr's pinned zccache install from a vendored
`vendor/zccache/<host-triple>/` directory when present, otherwise from the
zccache trio bundled in the installed soldr release archive. Release archives
that do not carry the trio fall back to the managed zccache release asset.
This keeps isolated `SOLDR_CACHE_DIR` jobs from forcing a second zccache
release lookup or a `cargo install` fallback.

### macOS

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
      - run: soldr cargo build --locked --release
      - run: soldr cargo test --locked
```

### Windows

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
      - run: soldr cargo build --locked --release
      - run: soldr cargo test --locked
```

### Blessed cross-target preparation

For a non-host target, pass one canonical Rust target triple to `cross-targets`
in each job. Use a matrix for multiple targets. Aliases such as `macos-arm` are not accepted,
because the canonical triple is part of Soldr's target plan and cache identity.

```yaml
strategy:
  matrix:
    target:
      - x86_64-unknown-linux-musl
      - aarch64-apple-darwin
steps:
  - uses: actions/checkout@v4
  - uses: zackees/setup-soldr@v0
    id: setup
    with:
      cross-targets: ${{ matrix.target }}
      cache: false
  - run: soldr build --locked --release --target ${{ matrix.target }}
```

The action invokes `soldr prepare --target`; Soldr owns the compiler, linker,
SDK/sysroot, environment, and supported-operation selection. `cache: false`
disables only the prepared-state archive cache, not preparation. The archive
identity includes runner OS/architecture, canonical target, Soldr repository,
and resolved Soldr version. Cargo registry, compilation, and cook caches remain
independent.

`universal2-apple-darwin` is a packaging target, not a Rust standard-library
target. setup-soldr provisions both `aarch64-apple-darwin` and
`x86_64-apple-darwin`; Soldr reports whether build or packaging operations are
available. Both real Darwin targets are supported by the blessed lifecycle.
setup-soldr does not implement binary merging.

### Target-driven lifecycle hooks

After preparation, the action exposes `target-plan-json`,
`target-capabilities-json`, `target-env-json`, `target-cache-identity`, and
`target-artifact-dir`. It also exports build, lint, test-harness, wheel, and
sdist hooks. Target-scoped project flags are preserved when Soldr's planned
environment is merged.

A consumer that wants one complete operation can call the reusable lifecycle
workflow:

```yaml
jobs:
  build:
    uses: zackees/setup-soldr/.github/workflows/target-lifecycle.yml@v0
    with:
      target: aarch64-apple-darwin
      operation: build
      profile: release
```

Set `operation` to `build`, `clippy`, `test-no-run`, `wheel`, or `sdist`. The
requested capability must appear in `target-capabilities-json`; an absent
capability is an error rather than a partial setup.
### Reusable Rust CI workflow

For repos that just want the standard Rust quality gates
(`build`, `fmt`, `lint`, `clippy`, `test`, optional `dylint`) wired up on
top of `setup-soldr` without hand-rolling them, this repo ships a
reusable workflow at `.github/workflows/rust-ci.yml`. It uses a
warm-then-fan-out pattern: a single `warm` job runs `setup-soldr` plus
`soldr cargo build --workspace --all-targets` to populate the caches,
then each per-tool job re-runs `setup-soldr` (same SHA = same cache
key, so it hits the freshly-saved cache) and runs its own `soldr
cargo ...` invocation. Per-tool jobs are independently toggleable.

The reusable workflow is cross-compilation-first. By default it runs in
`compile-mode: cross` and builds the non-host
`x86_64-unknown-linux-musl` target on `ubuntu-latest`. That target keeps
the default CI lane genuinely cross-compiled while still letting the
workflow run `soldr cargo test --target x86_64-unknown-linux-musl` on
Linux. Select `compile-mode: native` when you want the previous
host-target behavior with no `--target` flag.

The workflow can be called from another workflow with `workflow_call`, and
maintainers can also run it directly from the Actions tab with
`workflow_dispatch` to compare cross and native modes on demand. Reusable
callers default to `working-directory: .`; manual runs in this repository
default to `scripts/bench-workloads/demo-small` so the dispatched workflow
has a small Rust fixture to compile.

For each Rust job, the workflow writes `rust-toolchain.rust-ci.toml` with
the effective channel, required components, and the cross target when
`compile-mode: cross` is selected. That file is passed to `setup-soldr`
through `toolchain-file`, so target/component provisioning stays inside
setup-soldr's supported toolchain-file path.

Artifact publication stays out of the general CI workflow. Use the dedicated
release lane below when a job needs a strict build-and-upload contract.

#### Inputs

| Name | Type | Default | Purpose |
| --- | --- | --- | --- |
| `os` | string | `ubuntu-latest` | Runner label. |
| `compile-mode` | string | `cross` | Compilation mode. `cross` writes the target into the generated setup-soldr toolchain file and passes `--target`; `native` builds the runner host target with no `--target`. |
| `target` | string | `x86_64-unknown-linux-musl` | Rust target triple used only when `compile-mode: cross`. Ignored in native mode. |
| `working-directory` | string | `.` (`workflow_call`), `scripts/bench-workloads/demo-small` (`workflow_dispatch`) | Directory containing the Rust workspace or package to check. |
| `toolchain` | string | `""` | Channel written into `rust-toolchain.rust-ci.toml`. Empty = channel parsed from `rust-toolchain.toml` when present, otherwise `stable`. |
| `features` | string | `""` | Forwarded as `--features` to the warm build. |
| `cargo-args` | string | `""` | Free-form extra args appended to the warm build. |
| `cache` | boolean | `true` | Forwarded to `setup-soldr`'s umbrella cache switch. |
| `lint` | boolean | `true` | `soldr cargo check --workspace --all-targets`. |
| `fmt` | boolean | `true` | `soldr cargo fmt --all -- --check`. |
| `clippy` | boolean | `true` | `soldr cargo clippy --workspace --all-targets -- -D warnings`. |
| `test` | boolean | `true` | `soldr cargo test --workspace`. |
| `dylint` | boolean | `false` | `soldr cargo dylint --all --workspace`. setup-soldr first runs `soldr dylint prepare`, which materializes the pinned prebuilt tools, nightly components, and driver. Opt-in: needs a consumer-provided `dylint.toml`. |
| `cargo-dylint-version` | string | `6.0.3` | Exact catalogued `cargo-dylint` version required from Soldr. |
| `dylint-link-version` | string | `6.0.3` | Exact catalogued `dylint-link` version required from Soldr. |

#### Default cross-compile consumer

```yaml
jobs:
  ci:
    uses: zackees/setup-soldr/.github/workflows/rust-ci.yml@v0
    with:
      os: ubuntu-latest
      dylint: false
```

That default invocation builds, checks, clippies, and tests
`x86_64-unknown-linux-musl`. The workflow writes
`rust-toolchain.rust-ci.toml` with `targets =
["x86_64-unknown-linux-musl"]` and passes it to `setup-soldr` through
`toolchain-file` before each targeted Rust command. Target provisioning stays in the setup-soldr/Soldr-owned path; consumers do
not install or select the underlying implementation.

#### Native opt-in consumer

```yaml
jobs:
  ci:
    uses: zackees/setup-soldr/.github/workflows/rust-ci.yml@v0
    with:
      os: ubuntu-latest
      compile-mode: native
```

#### Cross-compile matrix

```yaml
jobs:
  ci:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ubuntu-latest, target: x86_64-unknown-linux-musl, test: true }
          - { os: ubuntu-latest, target: aarch64-unknown-linux-musl, test: false }
          - { os: ubuntu-latest, target: x86_64-pc-windows-gnu, test: false }
    uses: zackees/setup-soldr/.github/workflows/rust-ci.yml@v0
    with:
      os:           ${{ matrix.os }}
      compile-mode: cross
      target:       ${{ matrix.target }}
      test:         ${{ matrix.test }}
```

Cross-compiled binaries usually cannot run on the host, so the matrix
example gates `test:` on the runnable musl cell. The template never tries
to auto-detect runnability; the consumer chooses.

### Reusable release lane

`.github/workflows/release-lane.yml` builds one canonical target through
Soldr and uploads only caller-declared deliverables plus provenance metadata.
The cache is disabled by default for release isolation, locked dependency
resolution is enabled by default, and a missing artifact or missing `build`
capability fails the job. `artifact-paths` is required; paths and globs are
relative to `working-directory`, and directories are not accepted as broad
uploads.

```yaml
jobs:
  build-release:
    permissions:
      contents: read
    uses: zackees/setup-soldr/.github/workflows/release-lane.yml@v0
    with:
      target: x86_64-unknown-linux-musl
      working-directory: .
      artifact-name: my-cli
      artifact-paths: target/x86_64-unknown-linux-musl/release/my-cli
```

The uploaded name is `my-cli-x86_64-unknown-linux-musl`. The artifact also
contains `release-metadata/release-metadata.json`, recording the source
repository, commit, ref, canonical target, Soldr version, target cache
identity, advertised operations, exact build arguments, cache mode, and
resolved artifact files. Set `cache: true` only when a release policy
explicitly permits managed cache restore and save.

Build once in the release lane. Then run the artifact on a compatible native runner
in a dependent job. Use the exact `artifact-name` workflow output so
download and execution cannot drift from the producer:

```yaml
  run-native:
    needs: build-release
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: ${{ needs.build-release.outputs.artifact-name }}
      - run: |
          chmod +x target/x86_64-unknown-linux-musl/release/my-cli
          target/x86_64-unknown-linux-musl/release/my-cli --version
```

## Multi-platform builds (target-driven contract)

Each matrix cell supplies exactly one canonical target and builds through
`soldr build --target`. The reusable lifecycle workflow is the shortest form:

```yaml
jobs:
  target-build:
    strategy:
      fail-fast: false
      matrix:
        target:
          - x86_64-unknown-linux-gnu
          - x86_64-unknown-linux-musl
          - aarch64-unknown-linux-gnu
          - aarch64-unknown-linux-musl
          - x86_64-apple-darwin
          - aarch64-apple-darwin
          - x86_64-pc-windows-msvc
          - aarch64-pc-windows-msvc
    uses: zackees/setup-soldr/.github/workflows/target-lifecycle.yml@v0
    with:
      target: ${{ matrix.target }}
      operation: build
```

Do not execute a cross-built binary unless its target is runnable on the host.
For release packaging, use a separate `universal2-apple-darwin` cell and inspect
its reported packaging capabilities; it expands to the two real Apple targets
for provisioning.

### Capability and environment diagnostics

Give the action step an ID and inspect its machine-readable outputs before
invoking an optional operation:

```yaml
- uses: zackees/setup-soldr@v0
  id: setup
  with:
    cross-targets: ${{ matrix.target }}
    cache: false
- name: Record target contract
  env:
    PLAN: ${{ steps.setup.outputs.target-plan-json }}
    CAPABILITIES: ${{ steps.setup.outputs.target-capabilities-json }}
    TARGET_ENV: ${{ steps.setup.outputs.target-env-json }}
  run: |
    jq -e '.schemaVersion >= 1 and .canonicalTarget != "" and .cacheIdentity != ""' <<<"$CAPABILITIES"
    jq . <<<"$PLAN"
    jq . <<<"$TARGET_ENV"
```

If preparation or a build fails, retain these outputs and the preceding Soldr
diagnostics. They identify the canonical target, selected platform/toolchain,
environment, cache identity, and supported operations without duplicating a
target-to-toolchain table in setup-soldr.
## GitHub API Authentication

`setup-soldr` calls the GitHub Releases API to resolve the requested
`soldr` release and download its platform asset. The action authenticates those
requests by default with the workflow's `${{ github.token }}` through its
`token` input. This avoids anonymous API rate limits and transient HTTP 403
failures on busy CI matrices.

Most workflows do not need to configure anything:

```yaml
- uses: zackees/setup-soldr@v0
  with:
    cache: true
```

To override the token, pass a token with read access to the release repository:

```yaml
- uses: zackees/setup-soldr@v0
  with:
    token: ${{ secrets.SOLDR_RELEASE_TOKEN }}
    cache: true
```

For compatibility with older workflows, `setup-soldr` also honors a
`GITHUB_TOKEN` environment variable on the step. The explicit `token` input is
preferred for new workflows.

## Inputs

| Input | Meaning |
|---|---|
| `version` | Soldr release tag or version to install. Defaults to the soldr release this setup-soldr build is vendor-locked to (`src/lib/default-soldr-version.ts`), resolved with no network lookup; `ingest-soldr-release.yml` bumps it on each soldr release. Pass `latest` to resolve the newest release at run time. |
| `source-path` | Internal development override that builds Soldr from a pinned local Git checkout such as `_vender/soldr`; the checkout must include required submodules. Release assets remain the production default. |
| `cross-targets` | One canonical target per job for Soldr blessed preparation; use a matrix for multiple targets. |
| `token` | GitHub token used for authenticated release metadata and asset download requests. Defaults to `${{ github.token }}`. |
| `cache` | Restore and save the action-managed cache/state root. |
| `save-cache` | `auto` (default), `true` or `false`. Governs every durable Actions-cache upload this action makes: cook base/delta, build-cache, target-cache, solo-toolchain, cargo-registry, soldr-mini, blessed prepare and Dylint caches. `auto` saves locally under act/act2 and skips GitHub `pull_request` uploads, because GitHub scopes those entries to `refs/pull/N/merge` and counts them against the 10 GB budget. `true` enables saves; `false` disables them everywhere, including local runners. Restores and cooking on a miss still run. |
| `save-cache-remote` | `auto` (default), `true` or `false`. With `auto`, the existing `save-cache` and event policy decide. `true` or `false` sets the remote write decision (for example, pass ci-lint's `cache_save` output here). act/act2 ignores this remote-only policy and retains local automatic saves. `save-cache=false` still disables every save everywhere. Invalid values fail closed. Also accepted by `cook/`. |
| `cache-dir` | Override the runner-local cache/state root used for the installed `soldr` binary and any managed rustup state this action rehydrates. |
| `cache-key-suffix` | Optional escape hatch appended to the cache key. |
| `key` | Build-cache override only. `auto` opts into the Phase 1 nearest clean ancestor pilot; any other nonempty value is an explicit build-cache key. Other families keep their identity keys. |
| `auto-key` | Default `false`. When `true`, an omitted `key` enables the same build-cache pilot. Requires `actions: read`; lookup errors keep legacy restore. Saves still obey `save-cache`, failed-job and poison guards. |
| (local runner) | Under `ACT=true` (act/act2) `auto` needs no token or reviewed writer: the build cache saves under the source's own key and restores the newest same-identity entry, then the legacy keys. |
| `auto-key-trusted-writers` | Phase 1 pilot trust policy: one `owner/repo/.github/workflows/file.yml@FULL_SOURCE_SHA:RUN_ID:ATTEMPT:JOB_ID` per line, after reviewing that immutable writer job, its pinned post action and transitive executable source. Unlisted writers retain legacy restore. This temporary pilot policy is not the final automatic writer-authentication design. |
| `toolchain` | Explicit Rust toolchain channel override. |
| `toolchain-file` | Alternate toolchain file path when `toolchain` is empty; `components` and `targets` in the file are provisioned during setup. |
| `trust-mode` | Optional `SOLDR_TRUST_MODE` value. |
| `linker` | Linker override forwarded as `SOLDR_LINKER` (requires soldr 0.7.19+). Empty (default) selects `fast` — mold-if-on-PATH-else-rust-lld on Linux, rust-lld on macOS/Windows — and emits a one-time GitHub Actions warning so the override is visible in CI logs. Soldr's native default is no injection (smaller artifact cache, slower link); pass `platform-default` (or `default`) to opt out and keep cargo/rust-toolchain.toml in charge. Other accepted values pass through verbatim: `ld`, `mold`, `rust-lld`, `fast`. Unknown values raise an error. |
| `compile-priority` | Compiler/linker child-process priority forwarded as `ZCCACHE_COMPILE_PRIORITY` (requires zccache 1.4.6+). Defaults to `high` because CI runners are dedicated and have no foreground workload to yield to. zccache's native default is `low` (designed for interactive dev). Accepted: `normal`, `low`, `idle`, `high`. Set to empty string to opt out and let zccache pick its native default. |
| `timestamps` | Prefix setup-soldr diagnostics and streamed command output with elapsed `mm:ss` timestamps. Default `true`; set to `false` to opt out. |
| `timestamp-format` | Format used by the timestamp prefix when `timestamps: true`. `mmss` (default) keeps the historical `MM:SS message` shape; `seconds` switches to two-decimal seconds since step start (e.g. `8.04 message`), which is monotonic and lets you subtract two adjacent prefixes to read the cost of an operation directly. Has no effect when `timestamps: false`. (#387) |
| `lockfile` | Optional `Cargo.lock` path used for Rust artifact cache keying. Empty infers `Cargo.lock` next to `target-dir`, then workspace `Cargo.lock`. |
| `build-cache` | Restore and save Soldr/zccache build cache state across runs. Default `true`; set to `false` to opt out. |
| `build-cache-mode` | Rust build cache mode. Default `once` saves a full snapshot on miss, then restores only the local rust-plan bundle on later hits without resaving the full target tree. `thin` is the bounded dependency-artifact alternative. `full` opts into normal whole-target restore/save behavior and should be treated as unbounded. |
| `build-cache-save-min-compiles` | Delta-aware build-cache save gate. Default `1`: when a cache was restored and the session compiled nothing new (zccache misses below this count), skip re-saving the build-cache so a fallback-key hit doesn't re-upload a duplicate multi-GiB payload. Raise to also skip tiny deltas; set `0` to always save. Never gates a cold seed. |
| `job-status` | Pass `${{ job.status }}` (re-evaluated for the post step; an action default cannot read `job`). When it is `failure` or `cancelled`, build-cache and target-cache are not saved, so a failed build's partial store cannot poison its key (#559). |
| `save-on-failure` | `true` saves build-cache and target-cache even when the job failed or was cancelled. Default `false`. |
| `seed-isolated-build-cache` | Optional newline/comma-separated isolated `SOLDR_CACHE_DIR` roots to pre-seed from the restored build-cache (issue #240). Copies only the content-addressed zccache artifact store (no logs/sockets/live daemon state) into `<root>/cache/zccache`, so a daemon-isolated coverage/integration phase starts warm instead of cold. Default empty (no seeding). |
| `verify-compile-cache` | Guard against silently-bypassed compile caching. `off` (default) no check; `warn` emits a warning when a job expected to use zccache reports `hits + misses == 0`; `error`/`true` fails the post step. Names the likely bypass (RUSTC_WRAPPER, SOLDR_CACHE_DIR, ZCCACHE_CACHE_DIR, shims) and sets the `compile-cache-verification` output. Legitimate no-compile / passthrough / build-cache-off jobs are skipped, never failed. |
| `zccache-seed-strict` | When `true`, setup fails if setup-soldr cannot seed older soldr releases' pinned zccache install from a vendored or managed release source. Default `false` keeps the seed best-effort and allows soldr's normal managed fallback path. Embedded-zccache soldr releases skip this seed because no external zccache install is needed. Enable this in repos where a later `cargo install zccache` fallback is unacceptable on older soldr pins. |
| `prebuild-deps` | Dependency prebuild mode. Default `soldr-cook` runs `soldr cook` and restores/saves a long-enduring dependency cache; its required Cargo registry/git source closure is paired automatically unless `cargo-registry-cache: false` is explicit. Set to `none` to skip. `cargo-chef` is accepted as a legacy alias. |
| `prebuild-deps-flags` | Flags forwarded to `soldr cook`; default `--release`. Material flags are hashed into the cook cache key. |
| `prebuild-deps-delta-cache` | Default `true`. With soldr `>=0.7.38`, restore/save the cook cache as a protobuf-backed base layer plus a smaller commit/build-shape delta layer. Set to `false` to use the legacy single cook archive. |
| `cook-delta` | Default `false` (#528). Controls only the `cook-delta-v2-*` layer stacked on the base. With `false`, the `cook-base-v2-*` archive is still restored and saved (per `save-cache`), but no delta is restored or saved. Set `true` for the previous base+delta behavior. Also accepted by the `cook/` sub-action. |
| `target-dir` | Cargo target directory used by soldr when constructing the Rust artifact cache plan. |
| `target-cache-profile` | Thin-slice pruning policy for the `target/` cache when `target-cache: true` is enabled. `thin-v1` (default) keeps `.rlib`/`.rmeta`/proc-macro outputs. `thin-v2` is the aggressive prune that keeps fingerprints + dep-info + final outputs only and relies on the zccache compilation cache to repopulate library bytes. See "Target cache profile" below before opting in. |
| `target-cache-strip-debuginfo` | Forward-compatible pass-through. When `true`, requests that soldr strip debug-info-bearing artifacts from the target-cache before saving. Requires soldr#237 to take effect; current soldr releases ignore the flag. Default unset (soldr default applies). See "Forward-compatible target-cache pruning inputs" below. |
| `target-cache-include-incremental` | Forward-compatible pass-through. When `false`, requests that soldr exclude `target/*/incremental/` directories from the target-cache. Requires soldr#237 to take effect. Default unset (soldr default applies). See "Forward-compatible target-cache pruning inputs" below. |
| `target-cache-include-build-script-binaries` | Forward-compatible pass-through. When `false`, requests that soldr exclude `target/*/build/*-{hash}/build-script-build` binaries from the target-cache. Requires soldr#237 to take effect. Default unset (soldr default applies). See "Forward-compatible target-cache pruning inputs" below. |
| `cache-payload-warn-bytes` | Soft notice threshold for tar-backed cache saves before compression. Default `512MiB` on GitHub-hosted runners, `4GiB` on a local runner (`ACT=true`); notices include the largest files and subtrees so runaway zccache payloads are diagnosable. |
| `cache-payload-max-bytes` | Hard limit for tar-backed cache saves before compression. Default `6GiB` on GitHub-hosted runners and no cap on a local runner (`ACT=true`); the GitHub value matches realistic zccache footprint for a medium-large Rust workspace (was `2GiB` through v0.9.23, which caused chronic enabled-but-inert build-cache on workspaces that produced 4-5 GiB of state — setup-soldr#279); set `0` to disable. |
| `cache-payload-oversize-action` | Behavior when `cache-payload-max-bytes` is exceeded. Default `skip` logs a warning and avoids the upload; `fail` treats the oversized payload as a post-step error. |
| `cache-payload-top-n` | Number of largest files and directories retained in cache payload stats and summaries. Default `10`; set `0` to keep only aggregate counts. |
| `cache-encrypt-key` | Optional 256-bit AES key (64-char hex, 44-char base64, or 43-char base64url). When set, every managed cache layer's `.tar.zst` archive is wrapped with AES-256-GCM before upload and verified+decrypted on restore. Pass via a GitHub Actions secret. See "Release-grade usage: encrypted cache" below. (#387) |
| `cache-encrypt-on-failure` | Behavior when an encrypted entry fails GCM authentication (wrong key, tampered ciphertext, or AAD mismatch). Default `error` stops the run; `skip` logs the failure and treats the entry as a cold miss. Has no effect when `cache-encrypt-key` is empty. (#387) |
| `source-mtime-normalize` | Opt-in. When `true`, rewrite the mtime of tracked Rust build-input files under `${{ github.workspace }}` to each file's last-commit timestamp before the target-cache restore. Default `false`. See "Source mtime normalization" below. |
| `cargo-registry-cache` | Caches `~/.cargo/registry`, `.global-cache`, and `git/` and exports `SOLDR_SKIP_CARGO_REGISTRY_SAVE=1` so zccache CLI's built-in registry save no-ops. Empty enables it automatically with `prebuild-deps: soldr-cook`, because Cargo source trees are part of the rematerialized dependency closure; set `false` explicitly to opt out. Legacy-v1 remains the codec default because Windows 2025 run 31089551078 failed both fixed performance gates; `SOLDR_CARGO_REGISTRY_VIA_SOLDR=1` opts into the split parallel-extract format where compatible. Requires zccache `>=1.4.4`. |
| `dylint` | Enable Dylint mode. Default `false`, so normal jobs do not fetch the nightly map, restore or install a nightly, substitute toolchains, or prepare Dylint caches. When `true`, setup-soldr maps the configured exact Rust release to the newest compatible dated nightly and scopes that identity to Soldr's Dylint subprocesses. |
| `dylint-foundation-cache` | Cache the exact Dylint nightly/components plus cargo-dylint, dylint-link, and compatible driver. Default `true` in Dylint mode and inert otherwise. The key includes the dated nightly, compiler release, and full compiler commit. |
| `dylint-output-cache` | Restore and save the isolated custom-library and workspace-check trees separately from the long-lived foundation. Default `true` in Dylint mode and inert otherwise; a save requires a successful Dylint run. |
| `dylint-cache` | Compatibility opt-in for the original Dylint tool/driver cache when `dylint` mode is not enabled. |
| `dylint-toolchain` | Nightly toolchain used by the Dylint driver, such as `nightly-2026-03-26`. Empty defaults to the resolved action toolchain. Included in the Dylint cache key. |
| `dylint-driver-rev` | Git revision or version identity for the compatible Dylint driver source. Included in the Dylint cache key. |
| `cargo-dylint-version` | `cargo-dylint` version materialized and verified by Soldr. Default `6.0.3`; included in the Dylint cache key. |
| `dylint-link-version` | `dylint-link` version materialized and verified by Soldr. Default `6.0.3`; included in the Dylint cache key. |
| `dylint-cache-paths` | Optional newline- or comma-separated path override for the Dylint cache. Empty uses `$CARGO_HOME/bin/cargo-dylint*`, `$CARGO_HOME/bin/dylint-link*`, `$CARGO_HOME/.crates.toml`, `$CARGO_HOME/.crates2.json`, and `$RUNNER_TEMP/dylint-drivers`. |
| `compile-cache-stats` | Controls compile-cache (zccache) diagnostic output. `none` suppresses all compile-cache info. `summarize` (default) renders a per-session totals table into `$GITHUB_STEP_SUMMARY` and emits scalar action outputs (hit rate, hits, misses, total). `detailed` adds per-extension and per-tool rollup tables and sets `compile-cache-rollups-json`. Requires soldr `>=0.7.22` for the typed `soldr cache report --json` payload; older releases fall back to a single-line note in the summary. |

### Legacy Compatibility Inputs

| Input | Meaning |
|---|---|
| `target-cache` | Deprecated compatibility input. Default `false` to keep the default cache footprint small. Set to `true` to enable Rust target artifact caching. |
| `target-cache-mode` | Deprecated compatibility input translated into `build-cache-mode`: `hot` maps to `thin`, `full` maps to `full`, and `off` disables Rust target artifact caching. |

## Outputs

| Output | Meaning |
|---|---|
| `soldr-path` | Installed Soldr binary path added to `PATH`. |
| `soldr-version` | Installed Soldr version reported by `soldr version --json`. |
| `cache-dir` | Action-managed runner-local cache/state root. |
| `setup-duration-seconds` | Total wall-clock time spent inside the setup-soldr action. |
| `setup-phase-summary` | JSON timing summary for the main setup phases and cache restore statuses. |
| `cache-hit` | Whether the action restored an exact cache hit. |
| `cache-key` | Primary key used for the action-managed cache/state root. |
| `cache-restore-status` | Diagnostic restore status for the action-managed cache/state root. |
| `cook-cache-hit` | Whether the long-lived dependency base was restored and loaded for usable rematerialization. |
| `cook-cache-base-hit` | Whether the Cargo.lock-oriented base archive was restored and loaded. |
| `cook-cache-delta-hit` | Whether a compatible build-shape delta was restored and loaded over the base. |
| `cook-cache-status` | Dependency-rematerialization transport status (`disabled`, `miss`, `base-hit`, `hit`, or `covered-by-target-cache`). |
| `cook-cache-load-report-json` | JSON base/delta load diagnostics, including restored-file and mtime replay counters. |
| `cargo-registry-cache-hit` | Whether the Cargo registry/git source half of the dependency closure restored an exact key. |
| `build-cache-hit` | Whether the Soldr-owned zccache compilation cache was restored. Empty only when `build-cache` is disabled. |
| `build-cache-key` | Primary key used for the Soldr-owned zccache compilation cache. |
| `build-cache-path` | Soldr-owned zccache compilation cache path. |
| `build-cache-mode` | Effective setup-soldr Rust build cache mode. |
| `build-cache-restore-status` | Diagnostic restore status for the Soldr-owned zccache compilation cache. In `once` mode this may report `skipped-target-cache-exact-hit` when the rust-plan bundle was already an exact hit and the separate compile-cache restore was intentionally skipped. |
| `target-cache-hit` | Whether the zccache-owned Rust artifact cache state was restored. |
| `target-cache-key` | Primary key used for the zccache-owned Rust artifact cache state. |
| `target-cache-path` | Cargo target directory used by soldr for Rust artifact planning. |
| `target-cache-paths` | Path or newline-delimited path list passed to `actions/cache` for zccache-owned Rust artifact cache state. |
| `target-cache-mode` | Effective setup-soldr Rust target artifact cache mode. |
| `target-cache-profile` | Effective setup-soldr thin-slice pruning policy (`thin-v1` or `thin-v2`). |
| `target-cache-restore-status` | Diagnostic restore status for the Rust target artifact cache state. |
| `target-cache-budget-bytes` | Soft byte budget used to warn when the restored Rust artifact cache footprint is likely too large for fast CI reuse. |
| `target-cache-budget-files` | Soft file-count budget used to warn when the restored Rust artifact cache footprint is likely too large for fast CI reuse. |
| `target-cache-footprint-bytes` | Observed byte size of the restored Rust artifact cache footprint across the cache paths selected for the current mode. |
| `target-cache-footprint-files` | Observed file count of the restored Rust artifact cache footprint across the cache paths selected for the current mode. |
| `target-cache-budget-status` | Soft-budget diagnostic for the restored Rust artifact cache footprint. |
| `target-lockfile` | `Cargo.lock` path used for Rust artifact cache keying. |
| `target-lockfile-hash` | Short hash of the `Cargo.lock` used for Rust artifact cache keying, or `no-lock`. |
| `dylint-cache-hit` | Whether the opt-in Dylint tool/driver cache restored an exact key hit. |
| `dylint-cache-key` | Primary key used by the opt-in Dylint tool/driver cache. |
| `dylint-cache-restore-status` | Diagnostic restore status for the opt-in Dylint tool/driver cache. |
| `dylint-driver-path` | Dylint driver directory exported as `DYLINT_DRIVER_PATH` when `dylint-cache` is enabled. |
| `toolchain` | Exact Rust toolchain channel configured for the action. |
| `compile-cache-session-status` | Compile-cache report status: `ok`, `missing-binary`, `unsupported`, or `error`. Surfaces version skew between setup-soldr and the installed soldr binary. |
| `compile-cache-hit-rate` | Compile-cache hit rate for the last session as a decimal in `[0, 1]`. Empty when the report status is not `ok` or the field is missing from the payload. |
| `compile-cache-hits` | Compile-cache hit count for the last session. |
| `compile-cache-misses` | Compile-cache miss count for the last session. |
| `compile-cache-compilations` | Total compilation count for the last session (`hits + misses`, or a separate compilations counter when zccache reports one). |
| `compile-cache-time-saved-ms` | Estimated compile time saved (milliseconds) for the last session. |
| `compile-cache-bytes-read` | Cache bytes read during the last session. |
| `compile-cache-bytes-written` | Cache bytes written during the last session. |
| `compile-cache-summary-json` | Full `soldr cache report --json` payload, one-shot consumer hook. Always populated when the report status is `ok`. |

## Notes

- Development branches may pin the tracked `_vender/soldr` checkout and pass `source-path: _vender/soldr`; setup-soldr keys the build on the checkout's exact `HEAD`; commit local edits before expecting a new source identity. Production installs remain release-asset based.
- `soldr-cook` rematerialization is a two-part dependency closure: the cooked `target/` base (fingerprints, dep-info, rlibs/proc macros, build-script executables and outputs) plus Cargo registry/git sources. The action restores both by default and reports transport/load status through the `cook-cache-*` outputs.
- The action installs exactly one released `soldr` binary for the active runner target, defaulting to the vendor-locked release. Without a token, `latest` resolves through the `github.com/<repo>/releases/latest` web redirect and assets are probed on `releases/download/<tag>/`, so anonymous runs (local `act`) spend no REST API quota; the REST API is used only as a fallback, or directly when a token is present. Combined GitHub release archives remain preferred; for explicitly supported wheel-compatible releases (currently `0.9.0` through `0.9.27`), a missing exact target archive falls back to the matching hash-verified wheel from the same version on PyPI.
- For soldr `0.7.43+`, the action installs the release-pinned `cargo-chef`
  binary and exports `SOLDR_CARGO_CHEF_LOCAL_DIR`, so `soldr cook` does not
  need a live upstream GitHub lookup. Combined archives bundle the helper;
  PyPI-wheel fallbacks hydrate its hash-verified asset from the public
  soldr-toolchain catalogue.
- The normal path provisions Rust with `rustup`, bootstrapping `rustup` when it is absent.
- Toolchain-file `components` and `targets` are installed during setup so later `cargo`/`soldr cargo` steps do not trigger rustup lazy installs.
- The action keeps using the runner's existing `CARGO_HOME` unless `CARGO_HOME` is already set by the workflow. When `RUSTUP_HOME` is not explicitly set, setup-soldr prefers the runner's existing rustup home if it already satisfies the requested toolchain/components/targets; otherwise it falls back to a managed `RUSTUP_HOME` under the action cache root and rehydrates that state on later warm runs.
- The action restores Soldr/zccache build-cache state by default so child branches can reuse parent-branch compile artifacts without saving a large `target/` layer.
- The default `build-cache-mode` is `once`, which maps to soldr/zccache full-target planning for the build-cache layer. The separate target-cache layer is now default-off; set `target-cache: true` when a workflow has measured that the rust-plan bundle pays for its cache footprint.
- When `target-cache: true` and `build-cache-mode: once` are combined, an exact rust-plan bundle hit skips the separate build-cache restore because the target bundle already rehydrates the warm artifacts needed for the following build.
- setup-soldr now emits soft target-cache footprint budgets by mode: `once` warns above `1 GiB` or `8000` files, `thin` warns above `512 MiB` or `4000` files, and `full` warns above `2 GiB` or `12000` files.
- When the restored target-cache footprint exceeds that soft budget, the setup step emits a warning and reports `target-cache-budget-status=over-soft-budget:...` so workflows can spot cache shapes that are unlikely to stay fast.
- During build-cache saves, setup-soldr excludes zccache private-daemon artifact payloads (`zccache/private/*/artifacts/**`) and loose diagnostic files (`*.jsonl`, `*.log`, `*.txt`, `*.out`, `*.err`, `*.stdout`, `*.stderr`, `*.trace`) from the zccache cache root. Public `zccache/artifacts/**` payloads and index files remain eligible for save.
- setup-soldr also emits `setup-duration-seconds` plus a JSON `setup-phase-summary` output so warm-path investigations can compare cache restore time against toolchain/install/verify overhead.
- During post-job finalization, setup-soldr writes a GitHub step summary with restore/save outcomes for the setup, target, build, and Cargo registry cache layers. When soldr emits `last-session-stats.json`, the summary includes zccache hit/miss counts, hit rate, compilation count, non-cacheable count, errors, and the stats file path.
- zccache is the artifact cache authority; soldr interprets the Rust build and passes zccache a structured Rust artifact plan.
- Inspect `soldr cache`, zccache session stats, and the setup step's restore-status outputs when warm cache reuse is unexpectedly low.
- The setup cache intentionally keeps the installed `soldr` binary and only includes rustup state when setup-soldr had to fall back to a managed `RUSTUP_HOME` under the setup cache root. The dedicated `ZCCACHE_CACHE_DIR` payload stays in its own cache so warm runs do not restore the same build-cache bytes twice.

## soldr-cook Dependency Prebuilds

`prebuild-deps: soldr-cook` runs `soldr cook` before the workflow's own
`soldr cargo ...` steps. With soldr `>=0.7.38`, setup-soldr restores a
protobuf-backed base archive first, then a delta archive. The base key is
long-lived and uses runner OS, arch, libc, resolved Rust release, material
cook flags, `Cargo.lock` hash, and soldr version. It deliberately omits commit
SHA, so the same dependency/toolchain shape can hit across branches and
commits. The delta key adds the target/build shape and commit SHA, so normal
code-only changes save a small secondary archive instead of re-uploading the
whole cook cache.

When target setup must happen after the main setup-soldr step, use
`zackees/setup-soldr/cook@v0` instead of the main action's early
`prebuild-deps: soldr-cook`. The sub-action runs later in the workflow and
accepts the same `soldr cook` flags through its `flags` input.
Its `save-cache` input shares the main action's policy: `auto` (the default)
uploads the cook archive except on `pull_request` events, `false` restores
shared cook archives and runs `soldr cook` on a miss without uploading, and
`true` always uploads. The default moved from `true` to `auto` (#527) because a
PR-scoped cook entry cannot be restored by any other ref; set `true` to keep
per-PR warm reruns. `cache: false` disables restore and cook as well.

Base key shape:
`cook-base-v2-<os>-<arch>-<libc>-rustc<release>-f<flags_hash>-l<lock_hash>-soldr<version>`.

Delta key shape:
`cook-delta-v2-<os>-<arch>-<libc>-rustc<release>-f<flags_hash>-l<lock_hash>-soldr<version>-s<shape_hash>-g<sha>`.

The delta layer is off by default (`cook-delta: false`, #528): only the base
archive is restored and saved, and a base hit that re-runs `soldr cook` saves
nothing new. Set `cook-delta: true` to restore and save a delta on top of the
base as before.

Set `prebuild-deps-delta-cache: false` to use the legacy single archive:
`cook-<os>-<arch>-<libc>-rustc<release>-f<flags_hash>-l<lock_hash>-soldr<version>`.
Older soldr releases fall back to this legacy namespace automatically.
`cargo-chef` remains accepted as an alias, but new workflows should use
`soldr-cook`.

When target-cache already matched at the lockfile/build-shape level,
setup-soldr skips the cook restore/run because the target cache already
contains the same dependency artifacts. Set `prebuild-deps: none` when a
workflow should rely only on target/build/cache layers.

### Match cook to what your job actually compiles

cook only speeds a job up when the cooked dependency artifacts share a cache
key with what the job compiles. Three independent axes have to line up — a
mismatch on **any one** means the cooked artifacts are never reused, so cook
spends wall-clock time and uploads artifacts the job rebuilds from scratch:

- **Profile.** `prebuild-deps-flags` defaults to `--release`, but
  `cargo check` / `clippy` / `doc` / `test` compile in the **dev (debug)**
  profile. A release `.rlib` is a different cache entry than a debug one. For
  debug jobs, set `prebuild-deps-flags: ""` so cook builds debug deps; keep
  `--release` only for jobs that actually build a release artifact.
- **Toolchain.** cook runs under the toolchain setup-soldr pins (`toolchain:` /
  `rust-toolchain.toml`). A job phase that compiles under a *different*
  toolchain — e.g. a nightly Dylint driver pass — cannot reuse a stable cook,
  because the rustc release is part of the key.
- **Emit kind.** `check`-style metadata compiles and full codegen builds are
  keyed separately.

`prebuild-deps: none` disables **cook only** — it does *not* disable
`build-cache`, which is the cross-run save-state for your job's own compiles
and stays on by default. So a job whose cook can never match (e.g. a
different-toolchain pass) still carries its build work forward via
`build-cache`; reach for `none` only when the cook itself is pure waste.

setup-soldr's post step emits a warning when it detects the mismatch
fingerprint — a cook that ran or restored, yet the compile-cache session
recorded misses with zero hits — naming the likely fix.

## Dylint caches

`dylint: true` selects the newest compatible dated nightly from the verified
soldr-toolchain map, then runs `soldr dylint prepare`. Soldr owns downloading
and verifying the catalogued `cargo-dylint`, `dylint-link`, dated nightly
components, and matching prebuilt driver; setup-soldr exports the managed tool
directories so direct Dylint UI-test builds can resolve `dylint-link`. Its
foundation key contains the dated channel, observed compiler release and full
commit, host, required-component contract, and tool/driver versions; unrelated
workspace changes do not invalidate it.

The separate output layer contains compiled custom libraries and workspace
check state. Its key includes the compiler identity, driver, lockfile,
manifests, configuration, target shape, and source revision. The post step
saves either cold layer only after Soldr records a successful outer Dylint
run. Restoring output never skips the actual lint command.

`dylint-cache: true` without `dylint: true` retains the legacy exact-key,
cache-only mode for workflows that manage their own Dylint installation. It
does not prepare or install anything on a cold run. New workflows should use
`dylint: true`, whose Soldr-owned prebuilt flow does not compile Dylint tools
or the driver from source. The 6.0.3 defaults match Soldr 0.9.5. Set
`dylint-driver-rev` only when a consumer builds a custom driver whose source
revision is not already identified by the selected Dylint release/toolchain;
that revision becomes part of the cache key.

The key includes host triple, `cargo-dylint-version`, `dylint-link-version`,
`dylint-toolchain`, `dylint-driver-rev`, the action toolchain signature,
`Cargo.lock`, Cargo config, and workspace manifests. A cold run should keep the
normal workflow install/build steps. A warm run can skip them when
`${{ steps.setup.outputs.dylint-cache-hit == 'true' }}` or
`SETUP_SOLDR_DYLINT_CACHE_HIT=true`.

## Cache-layer policy

The action keeps the default cache path small: zccache build-cache and soldr-cook
stay on, while the largest optional payloads must be opted into after measuring
save cost, restore cost, and hit rate for the current workload.

| Layer | Default | Default policy | Benchmark expectation |
|---|---|---|---|
| `build` / zccache state | `default-on` | Default warm path. Private daemon artifact payloads and diagnostics are pruned before save. | Do not treat a low restore time as success if warm zccache stats still show zero hits. |
| `soldr-cook` | `default-on` | Default dependency prebuild path (`prebuild-deps: soldr-cook`); skipped only when an opted-in target-cache already covers the same lockfile/build shape. | Compare `cook`, `cook-production`, and target-cache rows before changing defaults. |
| `target` / `target-cache: true` | `default-off` | Opt-in large warm path. Set `target-cache: true` after measuring payback. | Should show low warm wall time and roughly one-hit payback after save cost. |
| `cargo-registry` | `default-off` | Opt-in companion layer (`cargo-registry-cache: true`). Gate keep/retire decisions on multi-run or real-cache data. | Should beat noise after save cost and should never stall without a bounded timeout artifact. |
| `setup-cache` | `default-on` | Mechanics/install layer; part of the always-on `cache` umbrella switch. | Report save/restore mechanics separately from build warm speedup. |
| `soldr-mini` | `default-on` | Mechanics/install layer (binary-only, keyed on version+platform). | Report save/restore mechanics separately from build warm speedup. |
| `solo-toolchain` | `default-off` | Delta-only and opt-in. | Default stable on hosted runners should produce an empty or tiny delta. |
| `all-on` benchmark mode | `opt-in-by-workload` | Benchmark-only mode, never a runtime default. Diagnostic only. | Must not archive hosted-runner Rust toolchains unless explicitly requested. |

`bench-cache-modes.yml` labels synthetic local tar/zstd results in the CSV and
summary. Use `break_even_warm_hits` rather than restore-only net benefit when
deciding whether a cache layer belongs in the default path. For a small real
service check, dispatch the workflow with
`cache_backend=local-tar-zstd+actions-cache-smoke`; this keeps the normal local
matrix and adds a two-job target-cache save/restore smoke using
`@actions/cache`, emitted as `cache_backend=actions-cache`.

### Cache ownership and priority

Which artifacts earn a cache slot is decided by the stability of their identity
key relative to their size. A key that survives an ordinary commit buys many
warm runs per save; a key that changes on every commit buys none, and pays the
save cost anyway.

| Priority | What | Why it earns the slot |
|---|---|---|
| 1 | Pinned toolchain and SDK downloads (`setup-cache`, `soldr-mini`, `cargo-registry`) | Keyed on a version and a platform. Immutable once pinned. |
| 2 | `cook` dependency compilation | Keyed on `Cargo.lock` and the build shape. Durable across every commit that does not change dependencies. |
| 3 | The per-unit zccache store | Content-addressed per compilation unit, so an unchanged unit is a hit no matter what else moved. Safe by construction. |
| 4 | Nothing else | Anything whose key is as unstable as its size is large is not worth a slot. |

**Linked test products are never cached** — integration-test executables,
benches, examples built for tests, doctest products, their debug sidecars, and
test-specific incremental state. A test binary statically links the whole
dependency graph, so any transitive change invalidates it, and it costs tens of
megabytes each. zccache refuses `--test` harness link products at cache
admission, and setup-soldr never sets `ZCCACHE_CACHE_TEST_BINS`, so that default
stands. The worked failure is
[soldr#2931](https://github.com/zackees/soldr/issues/2931): a workspace with 98
top-level integration-test files produced a 3.3 GB nextest archive and exhausted
a hosted Windows runner's disk with `os error 112`.

`build-cache-mode: full` with target caching on is the only configuration that
snapshots the entire `target/` tree, which is where those products live.
Setting `ci-tests: true` therefore refuses it: the mode degrades to `thin`, a
warning explains why, and cook plus the zccache unit store still carry the lane.
A job that genuinely wants the bulk snapshot simply does not opt into
`ci-tests`. The resolved layers are reported by the `cache-policy-json` output
and the `SETUP_SOLDR_CACHE_POLICY_JSON` env var.

### Recovering pre-trim cache behavior (migration)

PR [#219](https://github.com/zackees/setup-soldr/pull/219) ("Trim default cache
footprint") made the two largest optional layers — `target-cache` and
`cargo-registry-cache` — default-off so the default warm path stays small and
fast to restore. A workflow that measured a net win from the older,
larger-cache behavior re-enables it explicitly:

- `target-cache: true` (or `build-cache-mode: full`) restores the full `target/`
  artifact tree across runs again, rather than the default `once` rust-plan
  bundle.
- `cargo-registry-cache: true` caches `~/.cargo/registry` plus Cargo's
  `.global-cache` and `git/` companion state. The legacy-v1 codec is the
  default because the initial Windows 2025 evidence failed both fixed
  performance gates. Set `SOLDR_CARGO_REGISTRY_VIA_SOLDR=1` to opt into the v2
  split layout; unset or `0`, `false`, `no`, or `off` selects legacy-v1.
  Encrypted entries, source-ref Soldr builds, and Soldr versions older than
  `0.7.47` always use v1.
  On Windows, v2 bootstraps a pinned, SHA-256-verified zstd 1.5.7 executable
  under `RUNNER_TEMP` when the runner does not already provide one.

These are opt-in because they pay a real save/restore cost that only some
workloads earn back. The `cargo-registry-cache` restore is especially expensive
on Windows: the registry is tens of thousands of small files, and restore has
been observed at roughly 47–50 s — a key reason it is default-off and should be
opted into only where the workload measures a net win over upload/retention
cost. Run the manual `cargo-registry-soldr-benchmark.yml` workflow to compare
three or more alternating restores from one deterministic fixture. It emits raw
CSV and a Markdown median summary; the default-on gate is Soldr under 25 seconds,
at least 3x faster than legacy, with every file-count and SHA-256 validation
passing. [Windows 2025 run 31089551078](https://github.com/zackees/setup-soldr/actions/runs/31089551078)
used 50,000 registry files and three alternating repetitions per codec. All
six restores passed count and content-hash validation, but Soldr-v2's median
was 25,881.275 ms versus 9,669.428 ms for legacy-v1 (0.37x), so the codec stays
opt-in without weakening either gate.

### Cache policy presets

The `cache-preset` input expresses cache *policy intent* in one line. It fills
any cache-affecting input the consumer leaves unset; **explicit fine-grained
inputs always win** over the preset:

| Preset | `build-cache` | `target-cache` | `cargo-registry-cache` | `prebuild-deps` | `build-cache-mode` |
|---|---|---|---|---|---|
| `minimal`             | `false` | `false` | `false` | `soldr-cook` | (unset → `once` env-visible) |
| `foundation` (today's default) | `true`  | `false` | `false` | `soldr-cook` | (unset → `once` env-visible) |
| `full`                | `true`  | `true`  | `true`  | `soldr-cook` | `thin` |

When `cache-preset` is empty (the default), every fine-grained input keeps its
own historical default — so existing workflows see no behavior change. Set
`cache-preset: minimal` to get the cook-only, no-zccache-state shape in one
line; set `cache-preset: full` to opt into every layer (with `thin` as the
target/ artifact shape — see Proposal A below for why thin is the standardized
default whenever `target-cache: true`).

```yaml
# Cook-only, smallest footprint — workspaces that get little zccache
# warm-hit value can opt out cleanly without disabling cook.
- uses: zackees/setup-soldr@v0
  with:
    cache-preset: minimal
```

```yaml
# Foundation + everything heavy — for workspaces that measured a net win
# from the larger target/ + cargo-registry caches.
- uses: zackees/setup-soldr@v0
  with:
    cache-preset: full
```

```yaml
# Foundation with an explicit override — explicit fine-grained inputs always
# win, so this disables build-cache without affecting the rest of the preset.
- uses: zackees/setup-soldr@v0
  with:
    cache-preset: foundation
    build-cache: false   # explicit wins over the preset's true
```

The resolved preset is surfaced via the `cache-preset-effective` output for
diagnostics.

#### `build-cache-mode: thin` is the resolved default when `target-cache: true`

When `target-cache` is opted in (either explicitly or via `cache-preset: full`)
and `build-cache-mode` is left unset, the resolved mode is **`thin`** — the
bounded dependency-artifact shape that pairs with `target-cache-profile:
thin-v1`. The heavier `once` rust-plan bundle and the unbounded `full`
whole-target restore remain available as explicit opt-ins. When `target-cache`
is off, the resolved mode stays `once` (it is unused for caching but is still
surfaced via the `SETUP_SOLDR_BUILD_CACHE_MODE` env var for downstream tools).
(#251)

### Inspecting cache behavior

Reading the action's own diagnostics is the fastest way to tell whether a cache
layer is actually paying off:

- **Payload census.** Cache saves emit a census of the largest files and
  directories in the tar payload. `cache-payload-top-n` (default `10`) controls
  how many entries are retained; set `0` to keep only aggregate counts. Use this
  to find which subtree is inflating a save.
- **Skipped file classes.** The post-step GitHub step summary lists the file
  classes trimmed before save and why, so you can confirm the trim happened.
  The build-cache save profile keeps the reusable content-addressed store —
  everything under a zccache `artifacts/` directory, including
  `zccache/private/*/artifacts/**` and the compiler stdout/stderr replay
  metadata stored there (excluding it produced restored-but-zero-hit caches,
  see [#398](https://github.com/zackees/setup-soldr/issues/398)) — and trims
  only the `logs/` subtree and standalone diagnostic sidecars (`*.jsonl`,
  `*.log`, `*.txt`, `*.out`, `*.err`, `*.stdout`, `*.stderr`, `*.trace`) that
  live outside any artifacts dir.
- **Compile-cache hits/misses.** With `compile-cache-stats: summarize` (default)
  the summary renders per-session totals and the action exports
  `compile-cache-hits`, `compile-cache-misses`, `compile-cache-hit-rate`, and
  `compile-cache-compilations` outputs. `detailed` adds per-extension and
  per-tool rollups.
- **Reading a zero-hit result.** A warm run with `hits + misses == 0` means the
  compile cache was bypassed entirely or the measurement is invalid — not a
  success. A fast restore time with zero hits is a red flag, not a win: the
  build either compiled nothing through zccache or never consulted the restored
  cache. Treat zero-hit warm runs as a configuration bug to investigate, not as
  evidence the cache is working. Set `verify-compile-cache: warn` (or `error`)
  to have the post step flag/fail that case automatically — it names the likely
  bypass (RUSTC_WRAPPER, SOLDR_CACHE_DIR, ZCCACHE_CACHE_DIR, shims) and sets the
  `compile-cache-verification` output. Legitimate no-compile jobs are skipped,
  never failed.
- **Save gating + timing.** The build-cache save logs per-phase timing
  (`compress=…ms upload=…ms`) so a slow post step is diagnosable. On a
  restore-key (fallback) hit where the session compiled nothing new, the save is
  skipped (`build-cache-save-min-compiles`, default `1`) to avoid re-uploading a
  duplicate multi-GiB payload; raise the threshold to also skip tiny deltas, or
  set `0` to always save.

## Release-grade usage: encrypted cache

For release pipelines, every cache layer setup-soldr manages can be wrapped
with AES-256-GCM authenticated encryption so an attacker who gains
write access to the GitHub Actions Cache cannot poison a release by
planting a malicious archive under one of setup-soldr's cache keys
(see #387).

### Setup

1. Generate a 256-bit key locally and store it as a repository secret:

   ```bash
   # Pick one — both shapes are accepted.
   openssl rand -hex 32         # 64-char hex
   openssl rand -base64 32      # 44-char base64
   ```

   Add it to the repo as `SETUP_SOLDR_CACHE_KEY` (Settings → Secrets and
   variables → Actions → New repository secret).

2. Pass the secret to setup-soldr in your release workflow:

   ```yaml
   - uses: zackees/setup-soldr@v0
     with:
       cache-encrypt-key: ${{ secrets.SETUP_SOLDR_CACHE_KEY }}
       # cache-encrypt-on-failure: error    # default; set to `skip` to
                                            # treat auth failures as a
                                            # cold miss instead of stopping
   ```

3. Every setup-soldr-managed `.tar.zst` archive is now encrypted before
   upload and verified+decrypted on restore. The on-disk filename does
   not change — only the byte content does — so the cache-key shape and
   downstream tooling are unchanged.

### Threat model

- **In scope.** An attacker with write access to the Actions Cache for
  this repo (compromised PR from a fork running with cache-write scope,
  leaked `GITHUB_TOKEN`, stolen runner) cannot plant a payload under
  any setup-soldr cache key without the AES key — GCM authentication
  rejects the tampered archive and (with `cache-encrypt-on-failure:
  error`) the release run stops.
- **Also in scope.** Cross-layer replay: a poisoned blob captured from
  one cache key cannot be replayed under a different key, even with the
  same encryption key, because the cache key is bound into the GCM
  AAD.
- **Out of scope.** An attacker who can read the repo secret can both
  decrypt and forge archives. Rotate the key on suspected compromise
  (see "Key rotation" below).

### Key rotation

Mixed-mode is supported so you can rotate keys without wiping the
cache:

- **Old plaintext entry + new key.** The legacy plaintext archive is
  accepted with a warning the first time it's restored; the next save
  writes encrypted.
- **Old encrypted entry + new key.** The wrong-key decrypt fails GCM
  authentication. With `cache-encrypt-on-failure: skip`, the entry is
  treated as a cold miss and the next save writes under the new key;
  with the default `error`, the run stops so you can intentionally
  evict the stale entry and re-run.

### Performance cost

Encryption adds one streamed read+write disk pass per archive
(roughly `archive_size / SSD_throughput` per layer — about 5 s per
GiB on a typical hosted-runner SSD). Acceptable for an opt-in
release-grade feature; non-release workflows should leave
`cache-encrypt-key` unset and pay nothing.

### Coverage

Encrypted today: build-cache, cargo-registry, soldr-mini-cache,
solo-toolchain-cache, cook-cache. Target-cache and dylint-cache
currently use `@actions/cache`'s native compression (multi-path
archives) and bypass setup-soldr's compress pipeline; encryption
coverage for those layers is tracked separately.

## Known limitations

### Repeated `soldr cargo build` sharing a target directory

Running `soldr cargo build` twice in a single job against the same Cargo
`target/` directory is currently best-effort and not guaranteed to succeed.
When `build-cache-mode: once` (the default) is combined with a pre-populated
target directory, the second invocation can restore a stale rust-plan bundle
whose `restored_file_count` is `0`, and Cargo then fails with
`error: extern location for ring does not exist: .../libring-*.rmeta`.

When setup-soldr detects that the restored `target-dir` already contains
compiled artifacts (a `deps/` subtree with `.rmeta` files) under the
risky configuration, it emits a GitHub Actions log warning so the pitfall
surfaces before Cargo trips on it.

Recommended workaround: give the second invocation its own `--target-dir`,
or call `cargo build` directly.

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: zackees/setup-soldr@v0
    with:
      cache: true
  - run: soldr cargo build --locked --release
  # Use a distinct target dir for the second build so the first build's
  # rust-plan is not reused with a stale dependency map.
  - run: soldr cargo build --locked --release --target-dir target/python-extension
```

See [issue #53](https://github.com/zackees/setup-soldr/issues/53) for
background.

## Target cache profile

`target-cache-profile` selects the thin-slice pruning policy used when soldr
builds the cached `target/` slice. Two values are accepted:

- `thin-v1` (default): the legacy slice that keeps `.rlib`, `.rmeta`, and
  proc-macro outputs alongside fingerprints, dep-info, and final outputs.
  This preserves the byte-identical behavior shipped before this input
  existed, so no caller regresses by leaving the input unset.
- `thin-v2`: an aggressive prune that keeps only fingerprints, dep-info, and
  final outputs and relies on the zccache compilation cache to repopulate
  library bytes on warm runs.

`thin-v2` is opt-in. [soldr#237](https://github.com/zackees/soldr/issues/237)
shipped in Soldr `0.7.15`, so the CLI now generates the thin-v2 manifest when
`SOLDR_TARGET_CACHE_PROFILE=thin-v2` is set. **Stay on `thin-v1` because
zccache has not yet been updated to honor the new `manifest.v2` wire format;
setting `thin-v2` against any current zccache release causes a silent
downgrade to `thin-v1` with a one-line soldr warning rather than actual
pruning.** The
[`thin-v2-verify`](https://github.com/zackees/soldr/blob/main/.github/workflows/thin-v2-verify.yml)
gate has only been green on soldr `main` since 2026-05-10, so the one-week
watch is still in progress. Opt into `thin-v2` only after a zccache release
ships with `manifest.v2` support and the verify gate has stayed green for a
full week; pin that zccache version alongside the input.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-profile: thin-v2
      - run: soldr cargo build --locked --release
```

## Forward-compatible target-cache pruning inputs

`target-cache-strip-debuginfo`, `target-cache-include-incremental`, and
`target-cache-include-build-script-binaries` are pass-through knobs that
export `SOLDR_TARGET_CACHE_STRIP_DEBUGINFO`,
`SOLDR_TARGET_CACHE_INCLUDE_INCREMENTAL`, and
`SOLDR_TARGET_CACHE_INCLUDE_BUILD_SCRIPT_BINARIES` env vars for the
downstream soldr CLI when they are set to a non-empty value. **Soldr
`0.7.15` shipped [soldr#237](https://github.com/zackees/soldr/issues/237) as
a single-knob profile selector (`SOLDR_TARGET_CACHE_PROFILE=thin-v2`) and
does not read these three env vars**, so today they have no effect on any
released soldr. To prune the target cache, use `target-cache-profile:
thin-v2` once the wire-format gate described in "Target cache profile"
above has cleared. These three inputs are retained in case a future soldr
release introduces finer-grained per-class toggles; until then they remain
no-ops. Accepted values are `true`/`false`/`1`/`0`/`yes`/`no`/`on`/`off`;
they are normalized to literal `"true"` or `"false"` before being exported.
See [issue #58](https://github.com/zackees/setup-soldr/issues/58) for
background.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-strip-debuginfo: true
          target-cache-include-incremental: false
          target-cache-include-build-script-binaries: false
      - run: soldr cargo build --locked --release
```

### Measuring target-cache pruning impact

The three pruning inputs above are no-ops on every current soldr release because soldr `0.7.15` chose the `target-cache-profile` selector instead of per-class env vars. The same matrix pattern works against `target-cache-profile` once the wire-format gate clears, and the action's existing footprint outputs and phase-timing summary can be used to measure impact today.

To compare before/after for the same workflow, run a matrix that toggles `target-cache-profile` and reads `target-cache-footprint-bytes`:

```yaml
jobs:
  measure-prune:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        profile: [thin-v1, thin-v2]
    steps:
      - uses: actions/checkout@v4
      - id: setup-soldr
        uses: zackees/setup-soldr@v0
        with:
          cache: true
          target-cache-profile: ${{ matrix.profile }}
      - run: soldr cargo build --locked --release
      - name: Report footprint
        run: |
          echo "profile=${{ matrix.profile }} bytes=${{ steps.setup-soldr.outputs.target-cache-footprint-bytes }} files=${{ steps.setup-soldr.outputs.target-cache-footprint-files }}"
```

To fail a job whose restored cache has drifted past the soft budget, gate on `target-cache-budget-status`; it is `disabled`, `within-soft-budget`, or `over-soft-budget:bytes,files`:

```yaml
      - name: Enforce target-cache budget
        if: startsWith(steps.setup-soldr.outputs.target-cache-budget-status, 'over-soft-budget:')
        run: |
          echo "::error::target-cache over soft budget: ${{ steps.setup-soldr.outputs.target-cache-budget-status }}"
          exit 1
```

Footprint deltas conflate cache-restore time and downstream compile time. To attribute wins to the restore phase only, parse `setup-phase-summary` (a compact JSON object) and read its `target_cache_seconds` field:

```yaml
      - name: Report target-cache restore time
        run: |
          echo '${{ steps.setup-soldr.outputs.setup-phase-summary }}' | jq '.target_cache_seconds'
```

See [soldr#237](https://github.com/zackees/soldr/issues/237) for the upstream artifact-class content policy that determines which files `thin-v2` actually strips.

## Source mtime normalization

Fresh GitHub checkouts assign new mtimes to every file, which can cause Cargo to invalidate fingerprints for packages whose sources did not actually change between a parent branch and a pull request. When `source-mtime-normalize: true` is set, `setup-soldr` rewrites the mtime of tracked Rust build-input files (`**/*.rs`, `**/Cargo.toml`, `**/Cargo.lock`, `**/build.rs`, `rust-toolchain`, `rust-toolchain.toml`) under `${{ github.workspace }}` to each file's last-commit timestamp from `git log -1 --format=%ct`. Files under `target/`, `.git/`, and `node_modules/` are always skipped, and untracked files are left alone, so genuine source edits still invalidate Cargo fingerprints. This is action-side behavior, not a substitute for upstream build-script hygiene, and it is a no-op when the input is `false` or the workspace is not a git work tree.

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: zackees/setup-soldr@v0
        with:
          cache: true
          source-mtime-normalize: true
      - run: soldr cargo build --locked --release
```

## Development

`setup-soldr` is a Node 24 JavaScript GitHub Action. The runtime lives in TypeScript under `src/` and is bundled into `dist/main.js` (pre-step) and `dist/post.js` (post-step) with `@vercel/ncc`. The bundled output **is committed** to the repository so consumers running `uses: zackees/setup-soldr@v0` get a self-contained action without needing `npm install` at action runtime.

Clone with submodules, or initialize them after clone:

```bash
git clone --recurse-submodules https://github.com/zackees/setup-soldr.git
```

```bash
git submodule update --init --recursive
```

The repository carries pinned `soldr/` and `zccache/` Git submodules for local source inspection against the exported action bundle.

### Local toolchain

```bash
npm install         # install TypeScript, ncc, and @actions/* runtime deps
npm run typecheck   # tsc --noEmit
npm test            # node --test across __tests__/**/*.test.ts
npm run build       # bundle dist/main.js and dist/post.js with ncc
```

Always re-run `npm run build` after changing anything under `src/` and commit the regenerated `dist/` alongside the source change — CI gates on `git diff --exit-code -- dist/` to catch dist drift.

### Integration knobs

For cross-repo integration work, the action carries hidden `repo` and `ref`
inputs. When `ref` is set, setup-soldr downloads the GitHub source archive for
that ref, builds `soldr` locally, and caches it under the normal setup root so
`fast-gh-rebuild` style branch loops can exercise unreleased Soldr changes.

Regenerate this repository bundle from the source repository with the exporter in `zackees/soldr`.
