# Changelog

## Unreleased

- Build-cache generation restore now works (#682, fixing #685). #685 put the
  `<exact-key>-g` prefix in the primary-key slot, but `@actions/cache` checks
  the primary key for an exact match only. The next restore key, the bare
  exact key, then exact-hit the stale bare entry, so FastLED/fbuild run
  44726574726 restored it (727.9 MB) instead of the newer 770 MB generation
  and missed 64/35/35 units again. `<exact-key>-g` is now the first restore
  key, ahead of the bare key and the job fallbacks. The primary still names
  no real entry, so it always misses and the restore keys decide.
- An exact build-cache hit that still compiled now saves a new generation
  instead of `exact-hit-skip` (#682). The key is commit-free, so the first
  writer's zccache store used to be frozen until the lockfile, toolchain or
  soldr changed, and every crate edited since then missed on every run
  (FastLED/fbuild's Dylint missed 62/33/33 units per pass). A warm restore
  whose session compiled at least `max(1, build-cache-save-min-compiles)`
  units saves `<exact-key>-g<GITHUB_RUN_ID>[-<attempt>]`; restore asks for
  `<exact-key>-g` before the bare key, so the newest generation wins. A
  generation restore counts as warm (`build-cache-hit: true`). After the save,
  older generations of the same key are deleted with the cook layer's
  supersede sweep; without `actions: write` that becomes a warning. Cold and
  fallback restores still save the bare key, and the #681 thin-store rule
  still refuses a thin cold seed.
- macOS: `soldr cargo clippy` works again after a workflow installs Rust with
  clippy before setup-soldr (#683). When macOS swaps in the private
  `RUSTUP_HOME` (#105), the managed toolchain now also gets the tool
  components the runner toolchain has (clippy, rustfmt, rust-src,
  rust-analyzer, llvm-tools, miri, rustc-dev). They become part of the solo
  key. Before this, soldr added clippy on first use, after the toolchain
  snapshot. The post step then saved rustup's updated `components` list
  without clippy's files. That produced entries where rustup reports clippy
  "up to date" but refuses to run cargo-clippy ("not applicable to the
  toolchain"). The post step now saves toolchain changes made after setup
  together with their files. Restore validation now checks every component
  rustup has registered, so a poisoned entry already in a cache is repaired
  and replaced instead of breaking the job.
- The Dylint thin-store rule now skips a build-cache or target-cache save
  only when that layer was not restored. A restored store plus this run's
  compiles is a superset, not thin, but the save was skipped whenever
  `dylint-output-cache` hit. In FastLED/fbuild run 44501733207 that dropped
  242 new compiles. Now the normal `build-cache-save-min-compiles` /
  `target-cache-save-min-compiles` gate decides. An exact build-cache hit
  still never re-saves (keys are immutable).
- The `dylint-output-cache` key now includes the resolved soldr identity
  (#678). Soldr owns the lint-library store layout under `target/dylint`, and
  0.9.51 -> 0.9.53 changed it. Without the version in the key, every run
  after the upgrade exact-hit the entry the old soldr wrote, rebuilt it all,
  then skipped the save because the hit was exact, so the stale entry was
  never replaced until someone deleted it by hand. The soldr identity sits in
  the non-Cargo.lock hash, so the `restore-keys` prefix cannot fall back
  across a soldr change either. Expect one cold Dylint run per soldr bump.
- New `persistent-root` input for self-hosted runners (obs-rust/obs-studio#4954).
  It keeps `cache-dir`, soldr's zccache, `RUSTUP_HOME` and `CARGO_HOME` under
  one root and skips every Actions-cache restore and save, the S3 tier and the
  ancestor lookup. It auto-detects a host descriptor (JSON schema 1 or
  obs-runner's `.persistent-cache` marker) and is crash safe: a `.clean` marker
  is removed when a job opens the root and rewritten atomically after the post
  step syncs; an unclean root is quarantined and rebuilt. New outputs
  `persistent-root` and `cache-ledger` (per-layer hits, misses, bytes, time and
  time saved, on every profile).
- On a local runner, `key: auto` falls back to the newest store of the same
  toolchain/job family when no entry shares the exact identity (#575). The
  identity hashes Cargo.lock, so any lockfile change, even a workspace
  version bump, used to restore nothing and compile cold. Local identities are
  now `<family><fine>`, and restore tries `v1-<family><fine>-` and then
  `v1-<family>`. zccache keys units by content, so the fallback is always safe.
  GitHub-hosted selection is unchanged.
- The build-cache save gate counts compiles made by a cargo nested inside
  another tool (#573). A job whose build runs through uv -> a PEP 517 backend
  -> `soldr cargo build` (zackees/bosn's `./install`) left those sessions out
  of `logs/archive/`, so post saw "0 new compile(s)" and skipped the save.
  Post now also reads every front-door record under
  `<build-cache>/history/<id>/` written after main restored the cache, and
  uses the larger of the two totals.
- `key: auto` / `auto-key: true` works on a local runner (`ACT=true`, #552).
  It needs no token or reviewed writer there: the build cache is written
  under the source's own ancestor key, and restore takes the newest entry
  with the same identity, then the legacy keys. A stale legacy key that
  exact-hits no longer blocks saving new workspace units. GitHub-hosted
  behaviour is unchanged.

- The comparison benchmark no longer uses `Swatinem/rust-cache` anywhere
  (CACHE-025 now has no exceptions, zackees/ci.yml maintainer decision
  2026-10-02; reverts the #556 baseline carve-out). The baseline competitor
  is renamed `swatinem` -> `target-cache` (a key-based `target/` + cargo-dir
  cache, simulated in-job as before), the soldr-under-test build step runs
  uncached, and the unused `swatinem` backend of `_comparison-build.yml` is
  gone.
- A job that failed or was cancelled no longer saves its build outputs
  (#559). The post step runs on failure (for the daemon shutdown) and saved
  the build-cache store regardless, so a failed build (disk full under
  `bosn ci`, a compile error, a cancel) saved a partial store under the run's
  key; the next run got an exact hit on it and, being an exact hit, never
  re-saved it. build-cache and target-cache now skip the save, logged as
  `failed-job-skip`, when the new `job-status` input is `failure` or
  `cancelled`. Pass `job-status: ${{ job.status }}` (the runner re-evaluates
  `with:` inputs for the post step; an action's own default cannot read the
  `job` context); empty, the default, keeps the old behaviour. Toolchain, registry and tool layers still save.
  `save-on-failure: true` restores the old behaviour.

- Keep the managed Rust toolchain and Soldr's stamped tool bundles in
  `RUNNER_TOOL_CACHE` on act/self-hosted runners too (#557), the way #553
  keeps the syslib store:
  - **Rust toolchain.** With the managed rustup strategy, a pinned channel
    and `solo-toolchain-cache` off, `RUSTUP_HOME/{toolchains,update-hashes}`
    link to `$RUNNER_TOOL_CACHE/soldr-rustup/<platform>-<arch>/<channel>-<hash>`
    (keyed by channel, profile, components and targets). A cold job installs
    into its own `RUSTUP_HOME` and publishes a copy (staged, then renamed into
    place); a warm job finds everything installed instead of spending
    14-17 s in `rustup toolchain install` (zccache's jobs). `settings.toml`
    stays per job. Off for rolling channels, Dylint mode, and a system or
    explicit `RUSTUP_HOME`.
  - **Tool bundles.** The verify step's first `soldr cargo` fetched LLVM
    into `RUNNER_TEMP` on every warm job (`verify` 9-10 s on clud's jobs).
    The post step now publishes stamped `$SOLDR_CACHE_DIR/bin/<bundle>`
    installs (LLVM, zig, ...) to `$RUNNER_TOOL_CACHE/soldr-bundles/<platform>-<arch>`,
    hardlinks preserved, and the next main step links them back before soldr
    runs. Soldr extracts these in place without a lock, so the store is
    never written through.
  - The `SETUP_SOLDR_SYSLIB_TOOL_CACHE` override from #553 (unreleased) is
    now `SETUP_SOLDR_TOOL_CACHE` and covers every layer.

- Keep Soldr's syslib/toolchain store in `RUNNER_TOOL_CACHE` on runners whose
  tool cache outlives the job (#553). Under act (`ACT=true`, e.g. `bosn ci`)
  and on self-hosted runners, `$SOLDR_CACHE_DIR/bin/syslib` becomes a link to
  `$RUNNER_TOOL_CACHE/soldr-syslib/<platform>-<arch>`, so a warm run reuses the
  zstd/sqlite/zlib-ng/lzma/bzip2/cmake/ninja/GCC installs instead of
  re-downloading them on every `soldr prepare` (35-77 s on clud's
  `build-linux-x64`). Soldr sha256-verifies each bundle before extracting it,
  promotes installs atomically behind a `.complete` stamp, and locks
  concurrent installs, so the shared store is safe. Off on GitHub-hosted
  runners (setup-cache already carries `bin/syslib`), Windows, and
  `cross-targets` lanes; `SETUP_SOLDR_TOOL_CACHE=0|1` overrides.
  The store path is exported as `SETUP_SOLDR_SYSLIB_STORE`.

- Ingest Soldr `0.9.27` (default `0.9.25` -> `0.9.27`, skipping `0.9.26`,
  whose bot ingest PR was never opened): it embeds zccache `1.15.0`, whose
  Unix cache blobs are sealed `r--rw-r--`, so a build after `soldr cook` can
  rebuild a host build-dependency restored from the cache instead of failing
  `output file ... is not writeable` (mimalloc-pprof#590, zccache#1791).
  Extends the hash-verified PyPI wheel fallback and cargo-chef `0.1.73`
  mapping through `0.9.27`.

- New `dylint-targets` input (ci.yml#9): comma/whitespace-separated canonical
  Rust target triples for cross-platform Dylint check-only passes, in
  addition to the host, with no per-repository cache plumbing. `soldr dylint
  prepare --target <t>` now runs for every declared target ahead of the
  check pass, and the resolved target set (host + declared targets) is
  folded into the Dylint foundation and output cache-key hashes, so a
  target-set change gets its own cache generation (`foundation-v3`) instead
  of colliding with a host-only or differently-shaped run. New
  `dylint-targets` output reports the resolved set.

- Vendor-lock the default soldr: an omitted `version` now installs the release
  baked into `DEFAULT_SOLDR_VERSION` (`0.9.25`) with no version lookup;
  `ingest-soldr-release.yml` opens the bump PR on each soldr release. Explicit
  `version: latest` still floats. Anonymous runs resolve `latest` via the
  `releases/latest` web redirect and exact assets via `releases/download`,
  falling back to the REST API only on failure (authenticated runs unchanged).

- Fix `dylint-output-cache` being keyed to the source commit (#540, fixes
  ci.yml#1), so every new commit was an exact-key miss even when the
  toolchain, lint libraries, Cargo.lock and target/flags shape were all
  unchanged. The exact key is now a pure function of the real inputs
  (toolchain+driver identity, workspace/lint-library manifests, target
  shape, Cargo.lock) with the commit dropped entirely — same fix shape as
  #237's build-cache and #371's cargo-registry key — plus a `restore-keys`
  fallback that drops ONLY the Cargo.lock component, so a dependency bump
  still restores the newest prior generation instead of cooking fully cold.
  Saves only happen on a genuine exact-key miss (one generation per
  lockfile, never one per commit — #533).

- Ingest Soldr `0.9.25`: extend the hash-verified PyPI wheel fallback and
  pinned cargo-chef `0.1.73` support mapping. The rolling `latest` default now
  resolves to the release with cross-target Dylint nightly `rust-std` setup.

- Ingest Soldr `0.9.23` and `0.9.24`: keep the rolling `latest` default and
  extend the hash-verified PyPI wheel fallback contract through `0.9.24`.
  Verified both GitHub releases have all six native target archives, all eight
  PyPI wheels, and the pinned cargo-chef `0.1.73` support assets before enabling
  the fallback. `0.9.24` includes zccache `1.14.14` and Soldr's `--zccache-mode`
  configuration surface.

- The cook delta layer is now off by default (#528). New input `cook-delta`
  (default `false`) on the main action and the `cook/` sub-action. With the
  default, the `cook-base-v2-*` archive is still restored and saved (on
  non-PR events, per `save-cache`), but no `cook-delta-v2-*` entry is
  restored or saved: a base hit re-runs `soldr cook` and uploads nothing. Set
  `cook-delta: true` to get the previous base+delta behavior.
  `prebuild-deps: soldr-cook` stays the default and is otherwise unchanged.

- Self-test workflows now delete the run-scoped caches they create (#513).
  `cross-prepare` joins `cook-soldr-selftest`, `cook-rematerialization` and
  `_cook-consumer-rematerialization`: its seed saves under a
  `cross-prepare-<run_id>-<run_attempt>` namespace, and an `always()`
  cleanup job with `actions: write` deletes it. The deleter
  (`scripts/delete-run-scoped-caches.mjs`) now lists only the run's own ref
  (`GITHUB_REF`) and also filters by ref on the client, so it cannot delete
  another ref's entries. `cache-key-suffix` now also applies to the blessed
  prepare cache key (`...-s<hash>-x<suffix>`); a suffixed key does not fall
  back to entries from other namespaces. A contract test requires every
  workflow that saves run-scoped keys to have this cleanup, and every
  `pull_request` workflow that forces `save-cache: "true"` to be run-scoped.

- Fix an intermittent crash while extracting a cache archive on macOS
  (#531). `zstd -d | tar -xf -` runs through `runPipe`, and bsdtar exits as
  soon as it reads the end-of-archive marker, leaving the pax record padding
  unread. When Node was still writing that padding, the write failed with
  EPIPE. Nothing listened for `'error'` on tar's stdin, so the action died
  with `Error: write EPIPE` (seen right after the solo-toolchain restore).
  `runPipe` is now one shared module (`src/lib/run-pipe.ts`), used by both
  `cache-compress` and `cargo-registry-archive`. On EPIPE it drains and
  discards the rest of the producer's output, and success is decided by the
  two exit codes. A process killed by a signal now counts as a failure
  instead of exit code 0.

- With `solo-toolchain-cache: false`, the toolchain phase no longer walks
  `$RUSTUP_HOME/toolchains` and `$CARGO_HOME/bin` (#525, T8/E7). The
  `snapshot-base` and `snapshot-post` walks and the
  `setup-soldr-toolchain-diff.json` manifest only served the solo cache's
  save-diff, yet ran on every job. In containers whose image pre-populates
  `RUSTUP_HOME` (135k files in wild's CI image) they cost 5-16 s per job.
  Cache-off jobs now report no `snapshot_*` sub-phases and log
  `toolchain: solo-toolchain-cache off — skipping toolchain snapshots (#525)`.
  Jobs with the cache on are unchanged.

- Stop saving durable caches from pull-request runs by default (#527). The
  main action gains `save-cache: auto | true | false` (default `auto`), and
  every durable upload (cook base/delta, build-cache, target-cache,
  solo-toolchain, cargo-registry, soldr-mini, blessed prepare, Dylint caches)
  goes through one shared save-policy gate (`src/lib/save-policy.ts`). `auto`
  skips uploads when `GITHUB_EVENT_NAME` is `pull_request`: those entries are
  scoped to `refs/pull/N/merge`, unreachable by other runs, and were filling
  consumers' 10 GB budget. Restores and cook-on-miss still run on PRs, and
  each skipped layer logs `save skipped: pull_request event (save-cache=auto)`.
  The `cook/` sub-action uses the same policy; its `save-cache` now accepts
  `auto` and defaults to it (was `true`), so `true`/`false` keep their
  meaning. A contract test fails if a new save call site bypasses the gate.

- Ingest soldr `0.9.22`: retain the rolling `latest` default and extend the
  hash-verified PyPI wheel fallback contract through `0.9.22`. The 23 GitHub
  release assets, all eight published wheels, and the pinned cargo-chef
  `0.1.73` support release were verified before enabling the fallback. 0.9.22
  carries the fix for zackees/soldr#3350: restored build scripts are no
  longer handed to cargo while a forked child still holds them open for
  writing (`Text file busy`).
- Ingest soldr `0.9.21`: retain the rolling `latest` default and extend the
  hash-verified PyPI wheel fallback contract through `0.9.21`. The native
  release archives, all eight published wheels, and the pinned cargo-chef
  `0.1.73` support assets were verified before enabling the fallback. Cook
  fixtures repair their isolated yanked `chacha20 0.10.1` lock entry to
  `0.10.2` before cache seeding, so it cannot poison their dependency closure.
  Inputs already at `0.10.2` or with no chacha20 entry are left untouched.
  The Soldr cook self-test deliberately dirties one first-party source file
  before its warm build, keeping its closure proof non-vacuous. Downstream
  closure proofs likewise refresh first-party Rust source mtimes before their
  warm build, requiring first-party work while leaving the dependency graph
  unchanged.

- Restore fresh Dylint setup after the published nightly-version map changed
  behind its stable URL. The `soldr-toolchain` catalogue now pins an immutable,
  content-addressed map URL whose bytes match its SHA-256, and a Linux + Intel
  macOS action fixture verifies the fail-closed resolver against production.

- Fix `setup-soldr failed: Error: downloaded archive did not contain soldr`
  when installing soldr `0.9.12+`. Since soldr `0.9.12`, releases publish a
  debug-symbol sidecar asset (`soldr-vX.Y.Z-<triple>-symbols.tar.zst`,
  documented in soldr's `docs/DEBUG_SIDECARS.md`) alongside the binary
  archive, and GitHub lists it first — the release-asset picker was matching
  it by target-triple substring and treating it as the installable archive.
  `selectReleaseAsset` (`src/lib/ensure-soldr.ts`) and `assetHasTarget`
  (`src/lib/release-readiness.ts`) now share an `isSymbolsSidecar` helper
  that excludes any asset name ending in `-symbols` before its archive
  extension, and `selectReleaseAsset` additionally prefers an asset named
  exactly `soldr-<tag>-<target>.<ext>` over a looser substring match when one
  is present.

- Default to soldr `0.9.6` and extend the hash-verified PyPI wheel fallback
  contract through `0.9.6`, retaining the pinned cargo-chef `0.1.73` helper.

- Keep prepared cross-toolchain caches warm across Soldr releases. Exact cache
  keys remain immutable per Soldr version, while automatic host/target/source
  restore prefixes reuse the previous LLVM, GNU/Linux, MinGW, musl, xwin, and
  Apple-target archive. Soldr validates the restored versioned paths, downloads
  only genuine gaps, and promotes the completed archive to the current exact
  key. The v3 prepared caches are protected by the action's foundation-cache
  eviction policy, and custom Soldr forks remain repository-isolated.

- Default to soldr `0.9.4` (was `0.9.3`). Cook now rematerializes excluded
  vendored and patched workspaces, preserves fractional Cargo fingerprint
  mtimes through archive hydration, and supplements the portable cargo-chef
  pass with the exact requested package and feature graph. Legacy Cargo
  registry archives now use pax headers so native dependency source mtimes
  also retain their fractional precision across fresh-runner cache restores.

- Default to soldr `0.9.3` (was `0.9.2`). This release preserves complete
  cooked dependency closures across archive hydration, including build-script
  executables required for Cargo freshness, so a clean runner can reuse the
  rematerialized graph without rebuilding external crates. It retains the
  pinned cargo-chef `0.1.73` helper and hash-verified wheel fallback.

- Make Linux `soldr-cook` dependency rematerialization verifiable and complete
  (#470): pair Cargo registry/git sources with every cook-enabled cache preset,
  expose base/delta/load diagnostics through `cook-cache-*` outputs, and add a
  pinned `_vender/soldr` development checkout plus `source-path` override for
  testing unreleased Soldr commits without changing the production default.
  The coordinated Soldr change preserves build-script executables in cooked
  target archives and promotes `soldr hydrate` while retaining `soldr load` as
  a compatibility alias.

- Default to soldr `0.9.2` (was `0.9.1`). The release preserves the existing
  combined-archive and hash-verified wheel install contract, including the
  pinned cargo-chef `0.1.73` helper. It adds the terminal release-surface
  completeness gate, lowers the GNU Linux binary baseline to glibc 2.17,
  updates embedded zccache to `1.13.5`, and includes wrapper, broker, daemon,
  toolchain-provisioning, and cross-target correctness fixes.

- Default to soldr `0.9.1` (was `0.9.0`). 0.9.1 keeps the same install
  contract as 0.9.0: combined GitHub release archives preferred, exact
  hash-verified PyPI wheel fallback for wheel-compatible releases (now
  `0.9.0` and `0.9.1`), and the same pinned cargo-chef `0.1.73` helper.
  0.9.1 fixes the Linux-hosted MSVC wheel link (`lld-link` linker export)
  and the daemon stop-then-relaunch root-ownership race.

- Default to soldr `0.9.0` (was `0.8.43`). Setup keeps combined GitHub
  release archives as the preferred install source and falls back to the
  matching hash-verified PyPI wheel when an exact runner archive is absent.
  Wheel installs materialize the `soldr-daemon` multicall alias locally and
  hydrate soldr's pinned cargo-chef helper from the same hash-verified public
  toolchain catalogue used to assemble combined release archives. Linux wheel
  installs select the catalogue's static musl helper so the fallback preserves
  the wheel's broad glibc compatibility. Promotion now requires native wheel
  install smokes on Linux x64/ARM64, Intel macOS, and Windows ARM64.

- Make the cargo-registry Soldr path reachable behind
  `SOLDR_CARGO_REGISTRY_VIA_SOLDR=1` (#266). The v2 cache owns a Soldr archive
  for `registry/` plus a separate tar+zstd archive containing only
  `.global-cache` and `git/`; credentials, binaries, and unrelated Cargo home
  state remain excluded. Cache download still overlaps the other layers, while
  extraction now waits for the installed Soldr runtime to be verified. Add a
  Windows 2025 benchmark workflow with alternating legacy/Soldr restores, raw
  CSV, content validation, and fixed 25-second/3x decision gates. In benchmark
  run 31089551078, all six 50,002-file restores passed count and SHA-256
  validation, but Soldr-v2's 25,881.275 ms median was slower than legacy-v1's
  9,669.428 ms median (0.37x), so it failed both performance gates. Legacy-v1
  therefore remains the default and `SOLDR_CARGO_REGISTRY_VIA_SOLDR=1` remains
  the explicit v2 opt-in; encrypted entries and Soldr versions older than
  0.7.47 also remain on v1. Windows v2 restores bootstrap pinned,
  SHA-256-verified zstd 1.5.7 when no zstd executable is on PATH.

- Default to soldr `0.8.6` (was `0.8.5`). This release restores the managed
  Windows MSVC cross-build lanes, including ARM64 target provisioning and
  clang-cl argument-mode handling (soldr#1559), and carries the multicall
  runtime, embedded-cache, daemon isolation, rust-plan, archive, and wrapper
  correctness work merged since `0.8.5`.

- Add `zackees/setup-soldr/cook`, a deferred cook-cache sub-action for
  workflows that must run target-specific setup before `soldr cook`. It reuses
  the main action's layered base/delta cook cache helpers, accepts explicit
  target/profile-shaped cook flags, and saves the selected layer from its own
  post step. This lets cross-compile workflows disable early
  `prebuild-deps` in the main action and run cook after `soldr prepare
  --target ... --github-env`.

- Default to soldr `0.8.5` (was `0.7.102`). This ingests the repaired 0.8.0
  release process together with the 0.8.1–0.8.5 embedded-zccache and daemon
  hardening series. Headline changes:
  - **Release order repaired (0.8.0):** soldr builds and verifies GitHub
    binary archives before the secondary package publishes, so
    crates.io/PyPI/npm do not advance past a broken binary release
    (soldr#1395-#1399). Native Windows MSVC release builds skip Linux-only
    xwin prep and use a faster MSVC release profile
    (soldr#1401/#1402/#1405/#1407).
  - **Embedded zccache coverage widened (0.8.1–0.8.3):** clippy-driver,
    rustfmt, rustdoc, `cargo miri`, direct `maturin` builds, and
    rust-analyzer child processes now route through the embedded zccache, and
    residual bypass gaps are closed (soldr#1411/#1421/#1424/#1426-#1431,
    #1460). Vendored zccache bumped to `1.12.15` (soldr#1466).
  - **Standalone-zccache carriers removed (0.8.4):** legacy standalone-zccache
    shell-out paths are deleted, the trampoline is gated to daemon-free
    subcommands + `ZCCACHE_NO_SPAWN`, and `soldr doctor` gains a
    standalone-zccache probe with a no-spawn regression lint
    (soldr#1467/#1469-#1472). Embedded zccache bumped to `1.12.15`.
  - **Daemon hardening (0.8.2/0.8.5):** Windows restart hangs are prevented
    (soldr#1450), and `running-process` is bumped to `4.5.10` so the Windows
    broker DACL no longer strips child/hardlinked ACLs (soldr#1513/#1518).
  - **musllinux wheels** are now shipped (soldr#1439).
  - The default still uses soldr's embedded zccache runtime. setup-soldr does
    not fetch or install a standalone zccache for this release.

- Default to soldr `0.7.102` (was `0.7.99`). This ingests the
  compiled-in zccache migration and CI perf span while staying on the
  newest upstream release that still publishes the GitHub tarball assets
  setup-soldr installs by default. Headline changes:
  - **Managed zccache download eliminated** (soldr#1374, released in
    0.7.102): soldr now routes zccache through the compiled-in vendored
    backend instead of fetching/spawning a managed external binary. This
    carries embedded zccache `1.12.13`.
  - **setup-soldr compatibility:** the zccache seed phase now probes
    `soldr status --json` first and skips the legacy `install-zccache`
    path when soldr reports `zccache.binary_source = "embedded"`. Older
    soldr pins still use the previous vendored/bundled/managed seed path.
  - **Upstream perf work in the 0.7.100-0.7.102 span:** Linux x64 CI keeps
    the wrapper path stable between build and test to avoid a full
    fingerprint invalidation (~90s saved on the tail lane, soldr#1373);
    `SOLDR_GITHUB_TOKEN` was wired through soldr-invoking workflows to
    avoid unauthenticated zccache release fetch fallback; the 1.94.1 Rust
    toolchain is pre-cached across the main CI lanes; and workspace deps
    were feature-trimmed/unified (soldr#1363/#1365).
  - soldr `0.7.103` is newer and carries zccache `1.12.14`, but its
    GitHub release currently has no binary tarball assets. The PyPI wheel
    exists, but it does not carry the same cook/cross helper payload as the
    GitHub release archives, so setup-soldr does not make it the default
    install source in this release.

- Default to soldr `0.7.99` (was `0.7.92`). Fast follow-up to the
  0.7.92 bump — three actually-tagged soldr releases shipped in the
  36 hours after 0.7.92 (0.7.93/0.7.94/0.7.95/0.7.97 were autonomous-
  release attempts that never got tag assets; 0.7.96/0.7.98/0.7.99
  landed with the accumulated changes each time). Headline changes:
  - **Managed zccache pin bumped `1.12.11` → `1.12.12`** with a
    protocol-v8 test repair, embedded-zccache state checkpoint before
    archive, and auto-GC at build end (soldr#1286 / #1295 / #1299,
    released in 0.7.99). First zccache pin bump for setup-soldr
    after retiring the vendored zccache subproject in #401.
  - **`x86_64-apple-darwin` dropped from the soldr release matrix**
    (soldr#1250, released in 0.7.95) — soldr picked the
    "always-native-runner" branch of the two-way decision in
    zackees/soldr#1243, and darwin-x64 builds are no longer produced
    at all. Consumers who pinned `cross-targets: x86_64-apple-darwin`
    against setup-soldr should switch to `aarch64-apple-darwin` (still
    published via native `macos-15` runner) or drop the target.
  - **Cross-lane repairs (soldr#1285 / #1289, released in 0.7.98):**
    windows-x64 + windows-arm64 `xwin` bundle case aliases and
    zlib-ng clang-cl ARM toggles; `*-apple-darwin` lanes now find
    `libobjc` (SDKROOT was being dropped by the wrapper env filter,
    and `cargo-zigbuild --sysroot -L` was doubling on zig 0.14).
  - **linux-arm-musl lane fix** (soldr#1284) — wrapper env allowlist
    was dropping `crgx`'s `cargo:rustc-env` `CRGX_TARGET`.
  - Release-side: manylinux_2_17 wheels + stable PEP 517 target dir
    for fbuild ingestion (soldr#1277); degrade tag/release 403s
    instead of stranding PyPI+npm (soldr#1281); uv-provisioned
    ninja fallback + concurrent-safe installs (soldr#1273); sweep
    stale cmake build dirs on generator switch (soldr#1278); use
    `ci-bootstrap` profile (no LTO, cu=16) for host build
    (soldr#1282).
  - CI perf (all in 0.7.96): `Swatinem/rust-cache` added to
    `_bootstrap-e2e`, `baseline-zero-deps`, Lint, `_build-and-test`
    (soldr#1232 / #1235 / #1239 / #1241); zig + `cargo-zigbuild`
    cached in `baseline-zero-deps` (soldr#1244); per-target
    toolchain-prep cache for the `*-apple-darwin` cross-build lanes
    (soldr#1246).
- Default to soldr `0.7.92` (was `0.7.59`). This is the re-attempted
  bump after the 0.7.87 default was rolled back for the
  `soldr version --json` empty-stdout regression (see prior entry).
  Fix and follow-up guards from the upstream:
  - **soldr#1206** `fix(release): smoke-test soldr version --json
    across all release lanes` — closes zackees/soldr#1202, the
    regression report filed from setup-soldr. Every release lane
    now runs `soldr version --json | jq .soldr_version` on the
    built binary before the release asset is published, so the
    empty-stdout mode cannot slip through again.
  - **soldr#1209** `fix(release): cross-arch size-floor guard for
    archive soldr bin` — follow-up to soldr#1206 that rejects a
    release archive whose `soldr` binary falls below a
    per-triple size floor (catches the "wrong binary got
    packaged" flavour of the same class of bug).
  Other upstream changes carried by the 0.7.88 → 0.7.92 span:
  - `soldr doctor` gains a rustlib-integrity probe for corrupt
    rustup `rust-std` trees (soldr#884 / #1188).
  - `soldr logs paths` — discoverable runtime-log API
    (soldr#820 / #1124).
  - `soldr exec` + Chocolatey-cargo shadow detection on Windows
    hosts (soldr#1059 / #1114); auto-inject MSVC env when
    projects pin `rust-lld` (soldr#1105 / #1109).
  - `*-sys` catalogue fetcher end-to-end: real download +
    extract for the syslib catalogue (soldr#1064 / #1111) plus
    wiring for python / nodelib / openssl / llvm-tools
    (soldr#1010 / #1127).
  - Migrate all internal tool queries to the `soldr-toolchain`
    catalogue (soldr#1125), retire manifest-LFS migration
    tooling (soldr#993 / #1122).
  - Release-side robustness: reject stub-wheel releases
    (soldr#1140 / #1141); `--cargo-profile release` for nextest
    archive share (soldr#1182 / #1183), then reverted after it
    regressed archive speed (soldr#1197 / #1198 / #1199).
  - `*-apple-darwin` cross-compile tail (post 0.7.89): fix
    per-target toolchain-prep `--github-env FILE` arg
    (soldr#1220), fix `crgx` / `cargo-chef` darwin-x64 cross
    (soldr#1223), inject the per-target lib path for zig-cc
    libiconv (soldr#1226).
  - `mimalloc` everywhere; drop `jemalloc` (soldr#1112, via
    zccache#948).
- Roll back default soldr version from `0.7.87` to `0.7.59` after
  post-merge smoke tests on `main` failed: the bundled
  `soldr version --json` on the linux-x64-glibc release exited 0
  with empty stdout, which is the exact failure mode
  `verifySoldr` (`src/lib/verify-soldr.ts:86`) refuses to accept
  ("soldr version --json returned non-JSON output: Unexpected
  end of JSON input"). Reproduced on the "Setup Soldr Action"
  and "Soldr Cache Speed Demo" workflow runs against commit
  f0942b3. Filed upstream as a follow-up soldr bug; setup-soldr
  will re-attempt the bump once soldr ships a fixed release.
  Revert of #396 for the default; consumers who explicitly opt
  into a newer soldr via `with: version: X.Y.Z` are unaffected.
- Default to soldr `0.7.59` (was `0.7.56`). Headline upstream changes
  carried by this bump:
  - `soldr prepare --target <triple>` composite-action surface that
    collapses cross-toolchain setup into one command (soldr#893,
    fixed by #905 / #907).
  - Auto-bootstrap of zig, LLVM/clang, and per-target toolchain prep
    for cross-compile lanes — `soldr cargo zigbuild` (linux → macOS)
    and `soldr cargo xwin` (linux → windows) now Just Work without
    external prefetch (soldr#841, #862, #864). MSVC CRT cache
    pre-fetched from manifest (soldr#891).
  - Manifest-first asset resolver with sha256 pinning (soldr#866,
    #871, #877, #878) plus `soldr archive --target` and
    `soldr build-from-source` CLI surfaces (soldr#865, #869).
  - Restored mac + windows release lanes after the 0.7.58 split-out
    (soldr#908, closes soldr#902).
  - Linux `.dwp` and macOS `.dSYM` debug sidecars staged in releases
    (soldr#814); Windows `.pdb` sidecars preserved (soldr#787).
- Default to soldr `0.7.56`, which bumps managed zccache
  `1.11.18 → 1.12.8` (and carries the soldr 0.7.54 / 0.7.55 interim
  changes that landed since the previous setup-soldr default). The
  zccache 1.12.x line is the version-namespaced cache root (issue
  zackees/zccache#761 / #762 / #763) plus the rustdoc and docs
  improvements in zackees/zccache#773. Closes the soldr-version drift
  introduced when soldr 0.7.54 and 0.7.55 shipped without a matching
  setup-soldr default bump.
- Default to soldr `0.7.53`, which bumps managed zccache
  `1.11.14 → 1.11.18` (four upstream patches): NormalizedPath
  Arc-interning (zackees/zccache#663); daemon `PendingCacheWrite`
  registry + cold-miss persist wiring (zackees/zccache#664, #665);
  cold/warm grouped bar charts on benchmark-stats
  (zackees/zccache#668); **daemon pipe-pool depletion + compile-path
  wedge recovery (zackees/zccache#669)**; adaptive daemon-spawn wait
  keyed on lockfile PID (zackees/zccache#674); `ZCCACHE_PATH_REMAP`
  surfaced in `zccache --help` (zackees/zccache#676); cleaner
  lost-connection message (zackees/zccache#678).
- Default to soldr `0.7.52`, which bundles zccache `1.11.14` carrying
  the `meson configure --no-walk` flag (zackees/zccache#660, closes
  zackees/zccache#659). The wrapper now skips its recursive
  `--source-dir` walk entirely when callers declare every input via
  `--input-file` — FastLED measured a ~9× cold-with-cache speedup on
  the hit path (5.6s → 0.62s, see FastLED/FastLED#2761). Closes
  zackees/setup-soldr#379; meta tracker zackees/zccache#662.

## v0.9.62 - 2026-06-02

- Drop per-job suffix from cargo-registry cache key (closes #375).
  cargo-registry content is `$CARGO_HOME/registry/` + `.global-cache`
  + `git/` — all keyed on Cargo.lock content, identical across
  matrix jobs that share the same lockfile. Per-job suffix made
  each matrix job save its own ~56 MB copy (~500 MB redundant
  uploads per CI cycle on zccache's 9-job matrix). Now the first
  matrix job to save wins; rest exact-HIT. build-cache (#237)
  KEEPS its per-job suffix because target/ content genuinely
  differs per job; this only applies to cargo-registry whose
  content does not.

## v0.9.61 - 2026-06-02

- Cache-eviction now sorts evictable entries by size descending
  (biggest first) instead of age ascending (oldest first). Same
  byte-target reached with ~10× fewer API calls in production.
  Observation on zccache: a typical 1.33 GB eviction needs to
  delete only ~10 big entries (>10 MB) when sorted biggest-first;
  oldest-first sort burns API calls on ~300 tiny sccache shards
  (<1 MB each, 70% of evictable population) to free the same
  bytes. Age remains the tiebreaker when sizes match. The age-
  floor (#352/#356) still gates fresh entries so we don't
  delete just-saved entries from this run. GitHub's own LRU
  evicts truly-stale tiny entries at 7-day inactivity.

## v0.9.60 - 2026-06-02

- Parallelize cache-eviction deletes with concurrency=10. Sequential
  deletes were observed at ~190ms each on the GitHub Actions Cache
  API; large eviction passes (300+ entries on a busy repo) took ~57s
  of post-step wall-clock. Worker-pool pattern with N=10 drops that
  to ~6s. Per-CI-cycle savings: ~50s × matrix-job-count of post-step
  time on the over-budget path.
- Pre-compute eviction list before firing deletes (was: decrement
  byte counter mid-loop). Over-deletion bounded by CONCURRENCY ×
  largest-entry which is negligible vs the budget target.
- 401/403 still aborts via shared flag; up to CONCURRENCY failed
  API calls before the abort propagates (was 1). Acceptable tradeoff
  for the per-cycle wall-clock savings.

## v0.9.59 - 2026-06-02

- Drop git SHA from cargo-registry cache key (closes #371). Same
  anti-pattern fix as #237 did for build-cache. Production
  observation: every commit's cargo-registry exact-key probe was
  missing (only matched same-SHA retries), and the action would
  burn ~56 MB upload bandwidth saving a new entry that no future
  probe could hit. The restore-key prefix (without SHA) already
  did the actual work via FALLBACK. After this fix, exact-key
  hit rate per (lockHash, digest) generation should climb toward
  ~100%, save-status flips to `skipped-race` for subsequent
  matrix jobs, and per-CI-cycle redundant uploads drop by ~50 MB
  × matrix-job-count.

## v0.9.58 - 2026-06-02

- Eviction log splits foundation-protected vs age-floor-protected
  counts. After #368 added cook-base to FOUNDATION_PREFIXES, the
  legacy single `protected N entries (younger than Xh)` line
  conflated entries skipped for being foundation (any age) with
  entries skipped for being too fresh. Operators couldn't tell
  whether the eviction was finding nothing because the budget was
  healthy or because foundation entries crowded everything else
  out. New format: `protected F entries by foundation prefix
  (#368), A entries by age floor (younger than Xh, #352/#356),
  E entries evictable`.

## v0.9.57 - 2026-06-02

- Add `cook-base-v2-` to `FOUNDATION_PREFIXES` so our controlled
  eviction skips cook-cache-base entries (closes #368). Production
  observation on zccache: a base entry that HIT at 08:17 was GONE
  by 08:38 on a 20-minute child commit cycle — graduated age floor
  (0.5h danger / 2h moderate / 6h baseline) doesn't protect entries
  older than 6h, and cook-base saves typically live for many hours.
  Cost of MISS = ~200s of cold cook; size = ~300 MB / platform
  after v0.9.53's zstd-9. Ratio comparable to solo-toolchain.
  GitHub's own LRU still evicts truly-stale cook-base entries that
  no run accesses for ~7 days, so unbounded growth is bounded.

## v0.9.56 - 2026-06-02

- Fix v0.9.55's parentSha derivation on shallow checkouts (the
  default `actions/checkout` config with `fetch-depth: 1`). The
  initial `git log -1 --format=%P HEAD` returns empty for the
  grafted root commit — production observation on zccache MSRV
  v0.9.55 showed `parent-sha: unexpected git output "\n"; leaving
  empty` immediately followed by `cook-cache-delta MISS`.
- New fallback: `git cat-file -p HEAD` reads the raw commit
  object whose `parent` header line is preserved even when the
  parent commit isn't fetched. This works for shallow checkouts
  and is the path most CI workflows will exercise.
- Pass 1 (`git log %P`) still runs first because it's slightly
  cheaper and works on full-depth checkouts.

## v0.9.55 - 2026-06-02

- Auto-derive `parentSha` from `git log -1 --format=%P HEAD` when
  the `ACTION_PARENT_SHA` env var isn't provided (closes #365).
  cook-cache-delta + target-cache + cargo-registry already had a
  parent-SHA fallback restore key, but it was inert in practice
  because consumers don't set `ACTION_PARENT_SHA`. Production
  observation: cook-cache-delta hit rate was 0% across 6 jobs ×
  3 zccache runs. With auto-derivation, the parent-SHA fallback
  key is populated for any repo with a non-shallow checkout
  (actions/checkout default is `fetch-depth: 1`, so consumers
  may need to bump it to enable this; falls back to "" silently
  otherwise — no regression from prior behavior).
- Add the parent fallback key to the cook-layered-keys log line
  for visibility into whether the fallback is wired up.

## v0.9.54 - 2026-06-02

- Extend #360 per-layer split timing (compress vs upload) to
  `build-cache` and `cargo-registry`. Their save paths already
  captured `CacheSavePhaseTimings` internally (from #214) but the
  postCollector record didn't surface them, so the table showed
  `-` in the new compress/upload columns for everything except
  cook-cache. With this change, build-cache and cargo-registry
  rows show the split too — operators can finally see at a
  glance whether build-cache's 5s save is dominated by compress
  or upload. target-cache uses `cache.saveCache` directly (no
  split available without internal API plumbing) and continues
  to show `-` in the new columns.

## v0.9.53 - 2026-06-01

- Lower cook-cache base compression level from zstd-19 → zstd-9.
  Cuts the post-step compress wall-clock ~4× (production
  observation on zccache: 165s for ~224 MB output) at the cost of
  ~25% larger archive (~280 MB) and ~1s extra upload wall-clock
  per save. zstd decompression speed is level-independent, so
  warm restores are unaffected. Net: ~125s win per save-attempt,
  with a much bigger multiplier on race-loss scenarios (5-way
  matrix where 1 job wins reservation and 4 lose: 660s → 160s of
  compress CPU wasted per CI cycle). Cook-cache-delta stays at
  level 3 (already cheap). Relates to #268/#358 (residual cook-
  cache double-compress race waste); this is a palliative that
  shrinks the worst-case race-loss window 4× without changing the
  reservation timing.

## v0.9.52 - 2026-06-01

- Per-layer cache metrics now split compress wall-clock from
  upload wall-clock for cook-cache saves (closes #360). The
  post-step's per-layer save table gains `compress` and `upload`
  columns when any layer reports split timing, and the footer
  totals both. Answers "is the post-step bottlenecked by CPU
  (compress) or network (upload)?" at a glance. Other layers
  (build-cache, cargo-registry, etc.) leave the new columns
  empty and use the legacy single-column layout. Schema-only
  for non-cook layers; cook-cache `CookSaveResult` gains
  optional `compressMs` + `uploadMs` fields.

## v0.9.51 - 2026-06-01

- Per-line timestamps on `soldr cook` output (closes #359). Cargo's
  `Compiling`/`Downloading`/`Updating crates.io index` lines now
  receive the same `MM:SS ` elapsed-time prefix as setup-soldr's
  own log lines, so forensic analysis of a slow cook phase can
  identify the bottleneck crate directly from the log timestamps.
  Implementation: `listeners.stdline`/`errline` on the `exec.exec`
  call for `soldr cook`, re-emitting each line through the existing
  `formatLogLine` helper. ANSI color escape sequences in cargo's
  output pass through unchanged. Honors `timestamps: false` (off
  for both setup-soldr lines and cook lines).

## v0.9.50 - 2026-06-01

- Graduated age floor for `cache-eviction-policy` (closes #356).
  v0.9.48's fixed 6h age floor became a no-op under heavy CI
  load — observed on zccache MSRV at 13.63 GB usage where ALL
  171 evictable entries were < 6h, leaving GitHub's own
  non-deterministic LRU in charge (which can evict foundation
  prefixes arbitrarily, defeating `protect-foundations`).
  New tier table relaxes the floor as overshoot grows:
  - small overshoot (<1 GB over trigger): baseline 6h —
    unchanged (#352 fix preserved).
  - moderate (1–3 GB over): 2h — protect only the current CI
    wave's saves.
  - danger (>3 GB over): 0.5h — only this run's just-saved
    entries protected; controlled eviction wins the race
    against GitHub's LRU.
  Post-step log emits `graduated age floor active — overshoot=
  X GB, floor=Y h` when relaxed. `aggressive` policy gets the
  same tiering (baseline 2h, danger 0.5h).

## v0.9.49 - 2026-06-01

- Raise `cache-eviction-policy` thresholds to better utilize
  GitHub's 10 GB repo cache cap. `protect-foundations` was firing
  at 9 GB / target 8 GB, leaving ~2 GB unused. In practice GitHub
  allows transient overshoot to ~13.6 GB before its own
  non-deterministic LRU kicks in. New values: trigger 9.5 GB,
  target 9.0 GB — ~0.5 GB headroom for one in-flight upload to
  land safely, 0.5 GB hysteresis to prevent thrash. Our
  controlled eviction still fires before GitHub's, protecting
  foundation prefixes from arbitrary LRU. `aggressive` (7/6 GB)
  and the 6h/2h age floor from v0.9.48 are unchanged.

## v0.9.48 - 2026-06-01

- **CRITICAL fix** for cache-eviction-policy self-eviction
  regression (closes #352). v0.9.47's `protect-foundations` policy
  was deleting freshly-saved `cook-base-v2-*` and
  `setup-soldr-buildcache-v2-*` entries (age ~0.1h) because the
  post-step ran eviction immediately after this run's saves
  landed. Next CI cycle then cold-cooked (200s+ vs 5s baseline).
  Two changes:
  - **Age floor**: don't delete entries younger than 6h
    (`protect-foundations`) or 2h (`aggressive`). Protects this
    run's saves + the next CI cycle's restores.
  - **Raised thresholds**: `protect-foundations` 8/7 GB → 9/8 GB,
    `aggressive` 6/5 GB → 7/6 GB. Less eager, 1 GB headroom
    under GitHub's 10 GB repo cache cap.

## v0.9.47 - 2026-06-01

- New `cache-eviction-policy` input (closes #347, #348). Bakes
  repo-level Actions Cache hygiene into setup-soldr's post-step so
  consumers don't need per-repo cleanup workflows. Foundation
  prefixes (`solo-toolchain-v`, `soldr-mini-`, `setup-soldr-v`,
  `setup-soldr-cargoregistry-v`) are NEVER evicted — they deliver
  the warm-CI wins we need to protect. Per-commit/per-lockfile
  entries (cook-delta, build-cache, test/bench artifacts) are
  evictable oldest-first when usage exceeds threshold. Values:
  `disabled` (default), `protect-foundations` (trigger 8 GB,
  target 7 GB), `aggressive` (trigger 6 GB, target 5 GB). Needs
  `actions: write` permission on `GITHUB_TOKEN`; gracefully
  no-ops on 401/403/404. Best-effort throughout — never fails the
  action. Replaces the per-consumer `cache-cleanup.yml` workflow
  pattern.

## v0.9.46 - 2026-06-01

- **BEHAVIOR CHANGE**: solo-toolchain-cache now defaults to `"true"`
  (closes #343, #344). Feature is validated end-to-end across 6
  consumer repos × 3 platforms × ~25 ticks of iteration. Consumers
  that don't explicitly set the input now get the warm-CI win for
  free: solo_restore ~3-5s + rustup_install SKIPPED = ~8-11s saved
  per warm job. Consumers that need opt-out (e.g., workflows that
  install components AFTER setup-soldr — see #334 for the rustfmt
  example) should pass `solo-toolchain-cache: false` explicitly OR
  declare components in their `rust-toolchain.toml`. Also includes
  the dist-verify relaxation (#341/#342) which fixed the
  ~10-tick-long "every PR fails verify" issue. action.yml-only
  change; dist/ unchanged.

## v0.9.45 - 2026-06-01

- Diagnostic counters for solo-cache hardlink fallbacks (closes
  #339). Adds `hardlinkSuccesses` + `copyFallbacks` counters to
  `applyStagedToLiveRoots`; surfaces them in the restore log:
  `applied files=N symlinks=M hardlinks=K copy-fallbacks=L
  (#338 diagnostic)`. macOS solo_restore was observed at 5.5-7.5s
  vs Linux 2.9s — this exposes whether fs.link is silently
  falling back to copyFile on APFS. Zero behavior change; pure
  observability. Next macOS warm run pinpoints the cause and
  unblocks the actual fix.

## v0.9.44 - 2026-06-01

- Hardlinks in seed-isolated-cache (closes #335, #336). Same fix
  pattern as #331 applied to `src/lib/seed-isolated-cache.ts`:
  `fs.copyFileSync` → `fs.linkSync` with EXDEV/EPERM fallback.
  zccache Integration on v0.9.43 was copying 5.46 GB across 1290
  build-cache artifact files (`seed-isolated-build-cache: seeded
  1290 artifact file(s) (5460263998 bytes)`), dominating the
  parallel-restore=35.1s phase. Hardlinks are constant-time on
  the same filesystem; zccache cache entries are content-addressed
  and immutable, so inode sharing is safe. Expected:
  `parallel-restore` drops from 35s → ~8s on Integration, net
  wall clock 41s → ~14s.

## v0.9.43 - 2026-05-31

- Use hardlinks instead of copyFile in solo-cache apply step
  (closes #331, #332). After the solo-cache series finally
  delivered HIT in v0.9.42, demo workflow data showed
  `toolchain=9.4s {solo_restore=9.1s rustup_install=0.2s}` —
  the install was correctly skipped, but solo_restore itself
  was dominated by 153 sequential `fsp.copyFile` calls over
  ~580 MB of toolchain content. Hardlinks via `fsp.link` are
  constant-time on hosted runners where staging and live
  RUSTUP_HOME share a filesystem. Expected drop: ~5s per warm
  job. Combined with #324: ~13s/warm-job total ≈ ~65s/CI cycle
  on 5-job workflows.

## v0.9.42 - 2026-05-31

- Add solo-cache schema-version to cache key (closes #328, #329).
  Cache key prefix is now `solo-toolchain-v2-...`. Bumping the
  schema constant invalidates all prior caches automatically —
  prevents the "v0.9.40-saved cache is unreadable by v0.9.41
  reader → manual `gh cache delete` required" foot-gun seen on
  the #326 rollout. Future tar/format changes just bump the
  constant. v2 also forces a fresh save of the new (#326)
  staging-basename structure, so this release is what finally
  delivers the warm-CI win that the #305/#310/#313-#321/#324/
  #326 chain has been chasing: `toolchain=~3s {rustup_install=0.0s
  solo_restore=~2-3s}`.

## v0.9.41 - 2026-05-31

- Fix #316/#321 follow-up — align tar's top-level dir between save
  and restore (closes #326). v0.9.40 cascade revealed
  `solo-toolchain-cache: restored archive was empty`: the archive
  WAS getting restored, but its tar top-level dir
  (`setup-soldr-solo-stage-save/`) didn't match what restore reads
  from (`staged/`). compressCache writes archives via `tar -cf - -C
  parent basename(stagingDir)`, so save's stagingDir basename
  controls the archive's contents. Now save uses
  `${runnerTemp}/setup-soldr-solo-cache/staged` so basename ==
  `staged` (matching restore's stagingOut basename). Also threads
  canonical archive path explicitly via cacheArchivePath option
  to decouple it from stagingDir layout. **Closes the solo-cache
  series end-to-end** — with #305 + #310 + #313-#321 + #324 + #326
  all in place, warm CI should see `toolchain=~3s
  {rustup_install=0.0s solo_restore=~2-3s}`.

- Skip `rustup install` when solo-toolchain-cache exact-hit verified
  (closes #323, #324). After #316/#321 unblocked solo-cache restore,
  data showed `toolchain=10.3s {rustup_install=8.4s solo_restore=2.0s}`
  on zccache Clippy — the 2s restore worked, but ensureRustToolchain
  was still called unconditionally, and `rustup toolchain install`
  costs ~8s as a no-op on hosted runners (self-update check,
  metadata fetch, profile diff). Now skipped on the verified
  exact-hit path. **Final piece of the solo-cache series**: with
  #305 + #310 + #313-#321 + #324 all in place, warm CI should now
  see `toolchain=Xs {rustup_install=0.0s solo_restore=~2s}` —
  delivering ~8 s per warm job × 5 jobs ≈ ~40 s/cycle in zccache.

## v0.9.39 - 2026-05-31

- **MAJOR**: Fix solo-toolchain-cache restore-MISS-despite-cache-exists
  (closes #316, #321). Save was passing
  `/runner/temp/setup-soldr-solo-stage-save.tar.zst` and restore was
  passing `/runner/temp/setup-soldr-solo-cache/solo-toolchain.tar.zst`
  to `@actions/cache.{saveCache,restoreCache}`. The library SHA-hashes
  the paths array into the cache "version" — different paths = different
  version = restore returns MISS even when GitHub Actions Cache has an
  entry with that key on the same branch scope. The cache was being
  saved successfully on every workflow run but never restored,
  explaining why `rustup_install=8s` persisted on warm CI despite the
  entire #302/#304/#305/#310/#313/#314/#317/#319 series of plumbing
  fixes. Added `soloCacheArchivePath(runnerTemp)` returning a
  canonical path that both sides (including lookupOnly probes) now
  use. Expected impact: solo-cache HITS materialize on warm runs;
  `rustup_install` drops to ~0s; `solo_restore` becomes a real
  ~3-5s ~170 MB extraction.

## v0.9.38 - 2026-05-31

- Fix #313/#314 lookupOnly probe ALWAYS erroring in production
  (closes #317). The probe in v0.9.37 was passing an empty paths
  array to `cache.restoreCache(..., { lookupOnly: true })`, which
  the @actions/cache library rejects with `Path Validation Error:
  At least one directory or file path is required`. Result: the
  race-precheck-skipped path NEVER fired in v0.9.37, so the
  intended ~3-4 min/cold-cycle savings were not delivered. Fixed
  by passing a throwaway runner-temp subdir; with lookupOnly the
  directory contents are never touched.

## v0.9.37 - 2026-05-31

- Pre-save lookupOnly probe for solo-toolchain-cache (closes #313,
  #314). When N parallel jobs in a single workflow all enable
  solo-toolchain-cache with the same key (rustc × components ×
  targets × soldr-version), each one used to stage+compress+upload
  the ~140-175 MB archive only for GitHub Actions Cache to reject
  all-but-one with `id=-1`. zccache CI v0.9.35 showed 3 parallel
  jobs each spending ~100s of post-step wall clock on wasted
  uploads. Fix: probe with `restoreCache([], key, [], {lookupOnly:
  true})` before staging; if the key already exists, skip the
  whole stage+compress+upload chain. Expected savings on a 5-job
  workflow: ~3-4 min per cold-save cycle. Race window narrowed to
  ~50-200 ms (probe duration); worst case is 2 wasted uploads
  instead of N.

## v0.9.36 - 2026-05-31

- solo-toolchain-cache default zstd compression dropped from -19 to
  -9 (closes #310, #311). Measured first cold-save cycle on zccache
  CI showed -19 produced a 140 MB archive in 104.8 s wall clock — 1.3
  MB/s, dominating the entire post-step. The amortization argument
  for -19 ("save once, restore N times") assumed save was cheap;
  measurement showed it wasn't. At -9 the archive grows ~25% (~175
  MB) but compress drops to ~10 s; restore stays bandwidth-bound at
  ~70 MB/s either way. Net ~92 s shaved every cold-save cycle
  (rustc / soldr version bump). Users can still override to "19"
  explicitly.

## v0.9.35 - 2026-05-31

- FS-first rustup probe (closes #304, #308). `systemRustupSatisfiesRequest`
  used to start with `rustup toolchain list` — a child-process spawn
  observed at ~7s on every warm zccache CI run (real numbers from
  #302 sub-phase data on v0.9.34). Replaced with a `readdirSync(
  $RUSTUP_HOME/toolchains)`: same information source rustup itself
  reads, sub-ms instead of seconds. Fast-paths the channel-absent
  case to return BEFORE `which("rustup")` too. Components/targets/
  rolling-release checks still spawn rustup when needed; those are
  rare on consumer workloads (zccache passes no components or
  targets). Expected win: ~7s shaved per warm zccache CI job.

## v0.9.34 - 2026-05-31

- Sub-phase observability for `resolve` / `toolchain` (closes #302,
  #303). Added `timeSubPhase(parent, name, body)` to
  `src/lib/phase-timing.ts` — records aggregated ms into
  `SETUP_SOLDR_PHASE_<parent>_SUB_<name>_MS` and propagates errors
  while still recording the duration. Wired around the high-value
  awaits inside `resolve` (toolchain-spec, rustup-probe,
  soldr-version, ws-hash, lock-hash) and `toolchain` (snapshot-pre/
  base/post, solo-restore, rustup-install). `setupPhaseSummaryOneLine`
  now appends `{sub=Xs sub=Ys}` (slowest first) for any parent ≥ 1s,
  so the post-run one-liner attributes time inside the two largest
  pre-build phases. First real data on the demo workflow surfaced
  two follow-up issues: #304 (rustup_probe=2.4s warm — cache the
  answer) and #305 (rustup_install=9.2s warm even when solo_restore
  was the cache pathway — short-circuit on exact-hit).

## v0.9.33 - 2026-05-31

- Parallel zstd decompression (closes #295 Fix A, #300). Single-flag
  change to `decompressCache`: pass `-T0` so zstd uses all available
  CPU cores. On 4-vCPU hosted Linux runners this should drop the
  multi-GiB build-cache restore from ~17s (single-threaded ~60 MB/s)
  to ~5-7s (~200+ MB/s). Applied to both the with-zstd-CLI and
  fallback-via-tar paths in `cache-compress.ts`. `-T0` is supported
  by all zstd ≥ 1.3.2 (Aug 2017) and is a no-op on single-core
  hosts — safe to add unconditionally.

## v0.9.32 - 2026-05-31

- Parallelize independent workspace hash walks in the resolve phase
  (#298). `workspaceManifestHash` + `cargoConfigHash` were running
  sequentially via `await ; await` even though they're independent
  file-system walks on disjoint subsets of the same workspace dir.
  Now via `Promise.all([...])`. Small companion win to #296 — saves
  resolve wall-clock equal to the smaller of the two hashes.

## v0.9.31 - 2026-05-31

- Parallel cook-cache base + delta restore (closes #295 Fix B, #296).
  The previous serial `await base; if (base.matchedKey) await delta`
  shape wasted ~11s of wall clock per warm run for zero correctness
  benefit — the delta key is independently computed (includes
  everything the base key does + source/git fingerprint), so the two
  restores have no data dependency. Now run via `Promise.all([base,
  delta])`. Contract preserved: when base missed, the delta archive
  is semantically invalid and discarded so callers can rely on
  `base.matchedKey === "" ⇒ delta.hit === false`. Validation rerun
  for #621 showed cook-cache-delta MISS taking 11.2s wall clock
  because it was waiting on base; this fix should shave that ~11s
  off the parallel-restore phase on warm runs.

## v0.9.30 - 2026-05-31

- Default to soldr `0.7.51`, which lands `soldr cook` warm-skip
  (zackees/soldr#622, closes zackees/soldr#621). When the recipe
  + rustc + soldr version match a previously-written marker file
  in `target/`, soldr cook short-circuits Phase 2 (the cargo-chef
  orchestration walk) — saving ~5 min on Coverage-shape workloads
  and ~2.5 min on Integration-shape ones, with no behavior change
  for cold runs or any case where the marker doesn't match.
  Marker is schema-versioned, per-target-dir, and falls through
  to the normal cook path on any read failure / mismatch / missing
  file. README + action.yml default version bumped to 0.7.51.

## v0.9.29 - 2026-05-31

- Post-step save table now includes build-cache + cargo-registry
  rows in ALL outcomes (#291). #287 patched 4 sites (solo-toolchain,
  cook-cache layered/legacy, soldr-mini) but build-cache and
  cargo-registry use a different code path that was missed — they
  only recorded `saved` / `oversize-skip`, filtering out
  `tiny-delta-skip` / `exact-hit-skip` / etc. Result: post-step
  table showed only the cook layer on common runs where build-cache
  was an exact hit. Now every layer renders regardless of outcome.

## v0.9.28 - 2026-05-31

- One-line setup-phase summary at end of pre-build (#289, #283
  companion). Reads the SETUP_SOLDR_PHASE_*_START_MS env vars
  (already recorded by `markPhase`) and emits a one-line aggregate
  showing each phase's wall-clock delta:

      setup phase totals: resolve=8.5s parallel-restore=8.9s
        target-tree=0.0s toolchain=8.9s install=2.2s zccache-seed=0.1s
        verify=0.1s cross-bootstrap=0.0s cook=152.4s total=181.0s

  Previously, identifying which pre-build phase consumed which slice
  of the budget required raw env-var inspection. The aggregate makes
  pre-build regressions visible on the first read — same shape as
  the post-step `cache save totals:` line. Phases whose env var
  isn't set (passthrough mode, test harness) are silently skipped.

## v0.9.27 - 2026-05-31

- Record skipped save layers in the post-step save table (#287). The
  v0.9.26 table from #285 only showed `status=saved` rows because
  `postCollector.record()` was gated saved-only; skip cases (race-
  precheck, tiny-delta, oversize, exact-hit, missing-target) just
  emitted single-line logs. Now every save attempt records into the
  StatsCollector, so the table renders every layer with its actual
  status. archive/inflated/file totals still only count what
  actually uploaded.

  Why the skip-decisions matter as their own row: `cook-cache
  skipped-race-precheck 0.1s` confirms #268 Fix A is firing;
  `build-cache skipped tiny-delta 0.3s` confirms the save-min-compiles
  gate is doing its job; `build-cache skipped oversize` flags that
  `cache-payload-max-bytes` (default 6GiB since v0.9.24) may need
  raising for this workload.

## v0.9.26 - 2026-05-31

- Per-layer cache-save table alongside the one-line aggregate
  (closes #269, #285). Mirrors the restore-side `summaryText()`
  shape: one row per save op with label, status, archive bytes,
  file count, wall-clock. Footer rolls up the totals.

  ```
  cache                 save status              archive    files     time
  ──────────────────────────────────────────────────────────────────────────
  build-cache           saved                     1.19 GB   24284    15.6s
  cargo-registry-cache  saved                    56.1 MB     3142     6.4s
  cook-cache-base       skipped-race-precheck     0 B          -      0.1s
  soldr-mini-cache      exact-hit-skip            0 B          -      0.0s
  ──────────────────────────────────────────────────────────────────────────
  2/4 saved  total upload: 1.25 GB  total wall: 22.1s
  ```

  Logged in sequence with the v0.9.25 one-liner — table first
  (detail), one-liner second (skim-readable). Empty when zero save
  ops recorded. Pure-formatting addition; no behavior change.

## v0.9.25 - 2026-05-31

- One-line cache-save aggregate at end of post step (#269 minimal cut,
  #283). After the existing per-layer `final cache summary:` line,
  log a rolled-up budget view:

      cache save totals: layers_saved=2/4 uploaded=1.25GB total_ms=24500

  Pulls from existing `StatsCollector` op records — no new
  instrumentation. Empty (no log line) when zero save ops were
  recorded. Designed to surface post-step budget regressions on the
  first run, not after manually scrolling per-layer records.

## v0.9.24 - 2026-05-31

- Raise `cache-payload-max-bytes` default 2GiB → 6GiB (#279, #280).
  The 2GiB cap was leaving the build-cache layer chronically inert on
  medium-large Rust workspaces. zccache CI itself ran 4-5 GiB / skip
  every run with the previous default — `build-cache: true` enabled the
  layer, but the save side never fired, wasting the cold-restore lookup
  + post-step census walk for zero value. 6GiB matches realistic zccache
  footprint for medium-large workspaces AND sits comfortably below
  GitHub Actions' ~10 GiB per-entry / per-repo budget. Runaway producers
  (7+ GiB single save) still trip the guardrail. action.yml + README
  only — no source/dist changes.

## v0.9.23 - 2026-05-31

- Default to soldr `0.7.48`, which bundles zccache `1.11.8` carrying the
  cross-clone cache-pollution fix (zackees/zccache#474 → PR #478): per-worktree
  key for PCH + MSVC plus explicit triple prefix-map
  (`-ffile-prefix-map` + `-fmacro-prefix-map` + `-fdebug-prefix-map`) for
  clang/gcc. Without 1.11.8, `.obj` artifacts produced in worktree A leaked
  into worktree B with original-clone absolute paths still embedded,
  breaking downstream PCH builds with header-redefinition errors.
- README + `action.yml` default version both bumped to 0.7.48.
- Hotfix #277: ncc side-chunk files (`<id>.index.js`) produced by ANY
  dynamic `await import(...)` — including transitive imports inside
  `@actions/artifact` → `@azure/identity` — are now COPIED alongside
  `dist/post.js` (and `dist/main.js`, `cleanup/dist/index.js`). v0.9.22
  shipped without those chunks because `scripts/bundle-entrypoint.mjs`
  only copied the main bundle; the cargo-registry save path opted in via
  `SOLDR_CARGO_REGISTRY_VIA_SOLDR=1` (#265) crashed with `Cannot find
  module './84.index.js'` on zccache CI run 26698978997. Module-ID
  renumbering is now skipped when chunks are present so chunk-reference
  IDs stay in sync with on-disk filenames. Also converts our own
  `await import("./lib/soldr-load-shim.js")` to static — one fewer
  chunk to ship.

## v0.9.22 - 2026-05-31

- Pre-compress race probe in the cook-cache save path (#268 Fix A,
  #274). Before invoking the expensive `--zstd-level 19` compress,
  probe the GitHub Actions cache for an existing entry at the exact
  key via `cache.restoreCache(paths, key, [], { lookupOnly: true })`.
  When a sibling job already won the race, bail out with
  `status=skipped-race-precheck` — turning the 19-minute waste
  pattern (zccache PR #480: 19m 5s compress lost the race + silently
  discarded) into a ~100-1000ms probe. This is the dominant fix for
  the wall-clock failure mode #272 made visible. Both
  `saveCookCache` (legacy) and `saveLayeredCookCache` (`soldr save
  --zstd-level 19`) paths patched. Probe failure is non-fatal —
  falls through to legacy compress+save; #272's visibility warning
  remains as the safety net.

## v0.9.21 - 2026-05-31

- Implicit `cargo-registry-cache=true` pairing when `prebuild-deps: soldr-cook`
  is set without an explicit `cargo-registry-cache` value (#267, #271).
  Without the pairing, cook restored `target/` but `$CARGO_HOME/registry`
  stayed cold — cargo then re-downloaded every `.crate` source on the next
  build (the "cook is on, why is it still downloading?" trap caught on
  zccache CI). Explicit user values + `cache-preset: minimal/foundation`
  presets (which explicitly set `cargo-registry-cache: false`) still win.
  A one-line log line announces the pairing so consumers see what happened.
- Cook-cache race-loss after a long compress is now LOUD (#268 Fix B,
  #272). When `actions/cache.saveCache` returns id<=0 (race lost) AND the
  preceding compress burned >=30s, emit a top-level `core.warning(...)`
  naming the wasted seconds + archive size + cache key. Previously this
  was a single mid-log line operators had to scroll to find; now it
  surfaces in the GitHub Actions annotations panel. Trigger case was
  zccache PR #480 (19m 5s compress → race loss → silent skip). Fix A
  (reserve key BEFORE compressing — the real ~19m→10s improvement)
  remains tracked at #268.

## v0.9.20 - 2026-05-30

- Default to soldr `0.7.47`, which lands:
  - zackees/soldr#581 — parallel per-file extraction in `soldr load`
    (the foundation for the Windows cargo-registry-cache wall-clock
    fix; bottleneck was Defender's per-CreateFile scan + NTFS MFT/USN
    overhead serialized on a single tar-extract thread).
  - zackees/soldr#583 — new `--profile-extract` flag (also
    `SOLDR_PROFILE_EXTRACT=1`) that emits per-worker job counts +
    per-file extract latency percentiles for tuning; `--auto-defender-exclude`
    CLI placeholder on Windows (real `Add-MpPreference` lifecycle is a
    follow-up that needs an internal module-graph cleanup).
  - zackees/soldr#591 — fix: per-worker `chmod` restores the Unix +x
    bit on cache-file restore, so cargo `build-script-build` binaries
    round-tripped through `soldr save`/`load` are still executable
    (regression from #581 — `std::fs::write` doesn't carry the tar
    header's mode the way `entry.unpack()` did).
- Restore-side wire-in for `soldr load` in the cargo-registry-cache
  restore path. New `src/lib/soldr-load-shim.ts` detects soldr-format
  archives (sniffs first tar entry for `SOLDR_MANIFEST.pb`) and
  branches to `soldr load --archive X --cache-dir Y` when the
  installed soldr is ≥ `0.7.46` and the archive matches. Otherwise
  falls through unconditionally to the existing tar+zstd path — no
  signature churn on `decompressCache`; the other four layers
  (build, target, cook, mini) keep their existing path. The wire-in
  is currently dormant for setup-soldr-produced archives (still tar
  format on the save side); save-side switch tracked at #263 — once
  that lands, the Windows cargo-registry-cache restore wall-clock
  drops from ~50 s to a target of < 25 s. (#260, #261, #262)

## v0.9.19 - 2026-05-30

- Default to soldr `0.7.45`, which bundles zccache `1.11.7` carrying the
  depgraph drift-detection fix (zackees/zccache#449 → PR #450): prevents
  stale-artifact hits that produced undefined-symbol link errors when
  transitive `.cpp.hpp` headers were modified in C++ unity builds.

## v0.9.18 - 2026-05-30

- Add `target-cache-save-min-compiles` (default `1`) — delta-aware save gate
  for the Rust target/ artifact cache, mirroring `build-cache-save-min-compiles`.
  When `target-cache` is opted in and the cache was restored from a fallback
  key, target-cache save is now skipped if the session compiled fewer than
  N new units; the restored entry already holds everything, so re-saving
  under a new key would just re-upload a duplicate multi-GiB payload. Closes
  the residual #214 follow-up for opt-in target-cache consumers. (#255)

## v0.9.17 - 2026-05-29

- Add the `cache-preset` umbrella input (`minimal` | `foundation` | `full`)
  that fills any cache-affecting input the consumer leaves unset; explicit
  fine-grained inputs always win over the preset. `foundation` matches the
  current historical default (no behavior change); `minimal` is the cook-only,
  no-zccache-state shape; `full` opts every layer in. The resolved preset is
  surfaced via the new `cache-preset-effective` output. (#251)
- Standardize `build-cache-mode: thin` as the resolved default when
  `target-cache` is opted in (either explicitly or via `cache-preset: full`)
  and `build-cache-mode` is unset. The heavier `once` rust-plan bundle and the
  unbounded `full` whole-target restore remain available as explicit opt-ins.
  When `target-cache` is off, the resolved mode stays `once` to preserve the
  env-visible `SETUP_SOLDR_BUILD_CACHE_MODE` value for downstream tools.
  Existing workflows with `target-cache: true` but no explicit
  `build-cache-mode` see a shape change (`once` → `thin`); keep `once` by
  setting it explicitly. (#251)
- Add `enabled: boolean` to `BuildCachePlan` so the build-cache layer's
  resolved on/off state is observable alongside `TargetCachePlan.enabled` and
  `CargoRegistryCachePlan.enabled`. (#251)

## v0.9.16 - 2026-05-29

- Default to soldr `0.7.44`, which carries the `soldr cook` project-restore fix
  (zackees/soldr#566): `cargo chef cook` no longer leaves the workspace in its
  stubbed `0.0.1` skeleton state, so builds after the cook prebuild compile real
  source at the real version. This stabilizes first-party compile-cache keys
  across cold→warm runs (the residual first-party warm-miss in #236 / #448 /
  zccache#448).

## v0.9.15 - 2026-05-29

- Fix the `[compile_journal]` diagnostic (emitted with `logging: true`) to find
  the per-invocation journal under soldr's private daemon session layout
  (`<cache>/private/<id>/logs/last-session.jsonl`) instead of only the bare
  `<cache>/logs/` path. The warm-miss dump (miss-reason histogram,
  `slowest_misses`, rollups) was previously silently empty by default. (#247)

## v0.9.14 - 2026-05-28

- Warn when `soldr cook` ran or restored but the compile-cache session reused
  none of it (`hits == 0 && misses > 0`) — the profile/toolchain/emit-kind
  mismatch fingerprint — naming the likely fix (`prebuild-deps-flags: ""`).
  (#235)
- Add the opt-in `verify-compile-cache` guard (`off`/`warn`/`error`): flag or
  fail a job that is expected to exercise zccache but reports
  `hits + misses == 0`, with bypass diagnostics (RUSTC_WRAPPER, SOLDR_CACHE_DIR,
  ZCCACHE_CACHE_DIR, shims) and a new `compile-cache-verification` output.
  Legitimate passthrough / build-cache-off / no-compile jobs are skipped. (#227)
- Add delta-aware build-cache save gating (`build-cache-save-min-compiles`,
  default `1`): skip re-saving a restored cache when nothing new compiled so a
  fallback-key hit does not re-upload a duplicate multi-GiB payload. Log
  per-phase save timing (compress vs upload) for slow-Windows-post diagnosis.
  (#230, #214)
- Add `seed-isolated-build-cache`: pre-seed an isolated `SOLDR_CACHE_DIR` with
  the content-addressed zccache artifact store (no logs/sockets/live daemon
  state) so daemon-isolated coverage/integration self-test phases start warm.
  (#240)
- Make the build-cache payload allow/deny file-class contract explicit and
  tested; preserve compiler stdout/stderr replay metadata stored inside zccache
  artifacts dirs while trimming standalone diagnostics. (#229)
- Harden the cache-mode benchmark: zccache hit/miss/compile columns on cook
  warm rows, an in-script per-cell timeout with a timeout row and
  still-running-child capture, a p95 aggregate, and a `reps=3` preset.
  (#192, #191)
- Document the per-layer cache policy defaults (default-on/off/opt-in), a
  pre-trim migration path, the Windows cargo-registry restore cost, the cook
  profile/toolchain/emit axes, and a cache-inspection guide. (#193, #231, #232)

## v0.9.13 - 2026-05-28

- Default to soldr `0.7.43`, copy the bundled `cargo-chef` binary from soldr
  release archives, and export `SOLDR_CARGO_CHEF_LOCAL_DIR` so `soldr cook`
  does not perform a live cargo-chef release lookup.
- Move the main and cleanup actions to the Node 24 GitHub Actions runtime.
- Add opt-in `dylint-cache` support for caching `cargo-dylint`, `dylint-link`,
  and compatible Dylint driver directories.
- Resolve final zccache stats from private session and archived shutdown logs.

## v0.9.12 - 2026-05-28

- Trim the default cache footprint: keep the Soldr/zccache build-cache enabled,
  but default the optional target-cache and cargo-registry-cache layers off.
- Add a zccache build-cache payload profile that skips
  `zccache/private/*/artifacts/**`, zccache log subtrees, and loose diagnostic
  files before tar/zstd saves.
- Add top-subtree payload audit output so oversized cache entries identify the
  largest contributing subtrees, not only individual files.
- Lower the default tar-backed cache payload warning threshold to `512MiB`
  while keeping the `2GiB` hard skip cap.

## v0.9.11 - 2026-05-28

- Add the cleanup sub-action for workflows that need to quiesce soldr/zccache
  before post-job cache saves.
- Formalize `prebuild-deps: soldr-cook`, including layered cook cache support
  for soldr `0.7.38+`.
- Harden the real-cache benchmark workflow so warm/cold setup-soldr paths use
  real GitHub cache actions and stable cook-production shaping.
- Default to soldr `0.7.42`, and seed zccache from the zccache trio bundled
  inside soldr release archives before using the legacy cross-repo zccache
  release fallback.
- Seed soldr's pinned zccache install during setup so isolated `SOLDR_CACHE_DIR`
  test roots do not refetch zccache or fall back to `cargo install`.
- Run that seed even when `build-cache` is disabled, and add
  `zccache-seed-strict` so repos can fail setup if zccache cannot be pinned
  instead of allowing a later slow `cargo install` fallback.
- Default `cache-payload-max-bytes` to `2GiB` with `skip` behavior to avoid
  uploading runaway multi-GiB zccache artifact caches in normal CI.

## v0.9.10 - 2026-05-26

- Fixed cache-mode benchmark methodology so the matrix now measures distinct
  build-affecting layers instead of reusing warmed target or zccache state.
- Added runner-image delta measurement for the solo-toolchain benchmark path.
- Verified the repaired default benchmark run:
  <https://github.com/zackees/setup-soldr/actions/runs/26457448768>.
