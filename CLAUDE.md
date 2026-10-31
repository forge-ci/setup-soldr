# setup-soldr — Claude instructions

## Change workflow

All changes land via a feature branch and PR — never commit directly to `main`. Merge to `main` only after CI passes (the PR is the unit of "on success"). This matches the repo's history of numbered bump/feature PRs (e.g. `#128`).

Floating major tags (e.g. `v0`) are moved to point at the new `main` commit only after the PR is merged, then pushed.

### Default-release rollout gate

The `v0` tag is moved only by manually dispatching
`.github/workflows/update-v0-tag.yml` with the full current `main` SHA and a
successful FastLED/fbuild `ci-minimal.yml` pull-request canary run ID. Its
selected and full coverage jobs must pass, and its logs must prove the runner
downloaded and executed `zackees/setup-soldr@<that exact SHA>`. The workflow
checks an exact-SHA successful `Setup Soldr Contract` run, then repeats release
readiness and a local-action install smoke before a compare-and-swap push.
Its default dry run reports evidence and refs without writing.

The canary is a "not for merge" fbuild PR that repins every exact
`setup-soldr@<sha>` (and `ci/render_workflows.py`) to the candidate. It must
carry the `ci-full` label: without it fbuild's `ci-minimal` skips the
`full / Full coverage` job that `scripts/verify-v0-promotion.py` requires,
and promotion fails with "canary lacks successful selected and full coverage
jobs". A canary that conflicts with fbuild `main` starts no pull-request
workflows at all, so rebuild it on current `main`. Close the canary PR and
delete its branch once `v0` has moved. Contract success
alone never promotes `v0`; immutable version tags remain unchanged. Explicit
`version` inputs remain exact and fail closed.

## Test infrastructure

`npm test` runs Node's built-in `node --test` runner with `--test-timeout=120000`, so every test is aborted with a stack trace if it exceeds two minutes. The cap exists to prevent the kind of hung-test scenario seen during the 2026-05-25 cargo-link-error debug session, where a stuck shell tied up CI minutes until manual intervention. Two minutes is generous for the existing fast unit suite while still catching deadlocks fast.

To verify the watchdog itself, run the gated self-test in `__tests__/watchdog-self-test.test.ts`:

```
SETUP_SOLDR_WATCHDOG_SELF_TEST=1 npm test 2>&1 | grep "test timed out"
```

The self-test deliberately hangs forever; node:test should abort it at ~2 min with a stack trace pointing back at that file. Do not enable the env var in CI.

## Cache and toolchain optimization principles

Durable design rules for fast-pathing the install of soldr, rustup, the Rust toolchain, components, targets, and any tool soldr fetches. These apply when adding new cache layers or modifying existing ones (`src/main.ts`, `src/post.ts`, `src/lib/cache-compress.ts`, `src/lib/ensure-rust-toolchain.ts`, `src/lib/ensure-soldr.ts`).

### Layer per change cadence

Build separate cache layers, each keyed by its own invalidation triggers. Conflating cadences kills hit rate.

| Layer | Cadence | Key on |
|---|---|---|
| soldr binary | per soldr release | `version` + platform |
| Rust toolchain + components + targets | per rustc release / per components change | exact `rustc_release` + sorted hashes |
| Project deps (`soldr cook` output) | per `Cargo.lock` change | lockfile hash |
| Build cache (zccache state) | per source compile | content-driven |
| Target cache | per build | content-driven |
| Per-(host × target) cross-tool cache (#106) | per cross-compile lane / per pinned tool version | `(host, target, toolset-versions, soldr-version)` |

A new cache layer must justify its ~200–500 ms per-run cache-API roundtrip. Don't add layers that only help fringe cases — the always-paid lookup tax outweighs the conditional win.

The per-(host × target) cross-tool cache (Wave 2.1 of zackees/soldr#514) is only activated when `cross-targets` is non-empty — non-cross-compiling consumers pay zero extra cache-API roundtrips. Each declared target is one independent tiny slot keyed on its toolset versions, so bumping one tool only invalidates the affected lanes. Slot key shape: `tool-<host>-<target>-<toolsHash>-soldr<ver>` (see `crossToolCacheKeyFor` in `src/lib/cache-keys.ts`).

### Detect-then-cache: only save the delta

Before saving a cache, snapshot what the runner image already provides; cache only what setup-soldr added on top.

- GitHub-hosted runners ship rustup + a current stable toolchain (`/usr/share/rust/` on Linux, user profile on macOS/Windows). Default-stable workflows should produce **zero cache writes**.
- `ensureRustupAvailable` (`src/lib/ensure-rust-toolchain.ts:50`) already short-circuits on PATH-resident rustup. Extend the same discipline per-component, per-target, per-exact-release.
- Snapshot `$RUSTUP_HOME/toolchains/` + `$CARGO_HOME/bin/` before our work; diff after; tar only the added paths. Wrong shape: snapshot the whole `RUSTUP_HOME` and pay for re-shipping what the runner already had.

### Coarse keys, shared across workflows

Cache keys live in the *(layer, platform, version-of-what-the-layer-tracks)* space — never mixed with workflow filename, branch, or `cache-key-suffix`. One repo with N workflows using the same toolchain should hit the same cache entry. LRU access pattern dominates eviction risk for small entries; coarse keys keep entries warm.

### Floating channels must resolve to exact release before keying

`stable`/`beta`/`nightly` resolve to a specific rustc release. Resolve that **before** building the cache key:

```
GET https://static.rust-lang.org/dist/channel-rust-${channel}.toml
→ pkg.rust.version = "1.84.1 (abc1234 2026-05-12)"
```

Key on `rustc_release` (`1.84.1`), not on `channel` (`stable`). Wrong shape:
- Key on `stable` literally → never invalidates when upstream ships a patch → serves stale toolchains.
- Don't resolve → every run looks like a miss → no warm path at all.

After restoring, run `rustc --version` against the restored `$RUSTUP_HOME` and verify it matches expected. Cheap insurance against corrupt cache entries.

### Restore-key fallback ladder

A small toolchain delta should not force a full reinstall. Order fallbacks from most-specific to least, never dropping safety dimensions:

1. exact: `prep-${os}-${arch}-${libc}-rustc${release}-c${cHash}-t${tHash}-soldr${sver}`
2. drop targets: restore + `rustup target add <missing>` (~seconds per target)
3. drop components: restore + `rustup component add <missing>` (~seconds per component)
4. drop soldr: restore + re-fetch soldr binary (~2 s)

**Never** drop `release`, `arch`, `os`, or `libc` from the key. A wrong-host toolchain is silent breakage, not a slow build.

### libc axis (glibc vs musl)

Keep `libc` in the cache key, accept two entries per repo when the matrix actually mixes them. Cross-libc sharing is mostly not worth the plumbing:

- **Host binaries** (`rustc`, `cargo`, `rustfmt`, `clippy`, `rustup`) link against the runner's libc — cannot be shared.
- **Target-side artifacts** (`rust-std-<target>`, manifest metadata) are byte-identical across libc, ~30–60 MB out of ~300–400 MB total. Two-layer split to share that slice is more complexity than it's worth unless the CI matrix routinely mixes glibc and musl hosts.

Reality check on the hosted-runner matrix: `ubuntu-*` and `ubuntu-*-arm` are glibc, `macos-*` and `windows-*` have no libc axis at all. Self-hosted Alpine is the only practical musl case.

### Compression: zstd -19 with `--long=27` for toolchain content

- Default `cache-compress.ts` level is 3. For long-lived caches (save once, restore N times) bump to **-19** — ~45 % smaller than gzip-6, restore time is constant.
- `-22` (ultra) shaves ~3 MB more for 3× save time. Not worth it.
- Add `--long=27` (128 MB window) for toolchain content — internal redundancy across crates that a small window misses. Another ~5–8 % off.
- Compression knob is already wired through `parseLevel` (`src/lib/cache-compress.ts:243`). Each layer should own its own level — solo-cache at -19, target-cache at its existing default.

### Runner-image reality for decompression

| Runner | `zstd` CLI | `tar --zstd` | Practical state |
|---|---|---|---|
| `ubuntu-*` | preinstalled | tar 1.34+ | works |
| `macos-*` | preinstalled | gnutar via Homebrew | works |
| `windows-*` | often missing | bsdtar 3.6+ ships with Windows | works via tar |
| Alpine / busybox containers | missing | busybox tar lacks `--zstd` | needs `apk add zstd` in image |

`src/lib/cache-compress.ts:144–156` already implements the `io.which("zstd") ?? tar --zstd` fallback. Mirror that pattern in any new install-side decompression (e.g., zstd-compressed soldr release assets).

### Vendor vs cache vs fetch decision

When a tool needs to be on the runner *before* any cache layer can do work (e.g., `zstd` itself), don't try to put it in a cache — bootstrap paradox kills it (a zstd-compressed cache holding zstd is unreachable). Three options, pick by size and version-coupling:

| Approach | Best for | Cost |
|---|---|---|
| **Vendor** (committed under `vendor/<tool>/<triple>/`) | tiny + stable + bootstrap-needed (e.g. `zstd`, <~3 MB across all platforms) | one-time action-checkout size; near-zero wire after gzip |
| **Cache** (Actions Cache layer) | medium size + version-coupled + frequently reused (Rust toolchain, deps) | ~200–500 ms lookup; LRU eviction risk |
| **Fetch on demand** (HTTPS to GH Releases / static.rust-lang.org) | large or rarely reused | full download every miss |

Decision boundary: ~5 MB per platform. Above that, vendoring inflates every action checkout and you should fetch + cache instead.

Vendor layout (when adopted):
```
vendor/
  <tool>/
    linux-x64/<tool>
    linux-arm64/<tool>
    macos-x64/<tool>
    macos-arm64/<tool>
    windows-x64/<tool>.exe
    windows-arm64/<tool>.exe
    VERSION.json   # upstream, version, sha256 per triple
    LICENSE        # carried from upstream
```

Vendor bumps go through a maintainer-run `scripts/sync-vendor.mjs` that hash-verifies against `VERSION.json`. Don't auto-update vendor on CI — each bump is a reviewable PR.

### Release format and cache format are independent

What soldr (or any upstream) ships on GitHub Releases is a separate decision from what setup-soldr stores in its cache. The cache layer can always recompress to whatever's optimal:

- Release as `.tar.gz` → setup-soldr cache as `.tar.zst -19` (decouples non-CI consumers from zstd requirements).
- Release as `.tar.zst` → setup-soldr cache same → decompression unified through `cache-compress.ts` magic-byte sniff.

Don't bundle non-CI consumers (Docker, manual install, `cargo install`) into a specific decompressor just to optimize the CI cache path.

### Cache-lifetime axis: build the foundation first

Cache layers live on two independent axes — **size** and **lifetime** (how often the key invalidates). Designs that ignore the lifetime axis end up shipping the wrong layer first.

```
              SHORT-LIVED                     LONG-LIVED
            (churns on edit)                (churns on release)
SMALL   ┌─────────────────────────┬─────────────────────────┐
        │ source-mtime sidecar    │ soldr-mini-cache        │
        │ compile-journal         │ vendored zstd           │
        │                         │ toolchain solo-cache    │
        ├─────────────────────────┼─────────────────────────┤
LARGE   │ target-cache            │ (rare — most large      │
        │ build-cache (zccache)   │  artifacts churn fast)  │
        │ soldr cook output       │                         │
        └─────────────────────────┴─────────────────────────┘
```

**Foundation layers live in the long-lived/small quadrant.** They're cheap, hit rate is near-100%, and they form the baseline every subsequent run can assume. Build these first because:

- **They don't depend on heavier layers.** Toolchain solo-cache works whether or not cook is wired in. Cook *needs* a toolchain — without the foundation the heavy layer pays bootstrap cost every cold run, blurring whatever signal it produces.
- **Measurement is cleaner once the floor exists.** Time a cook-cache hit vs miss against a workflow that already has the foundation, and the deps-compile delta is the only thing moving. Without the foundation, you're measuring `foundation_bootstrap + cook_delta` and can't separate them.
- **LRU pressure goes the right way.** GitHub Actions Cache is 10 GB per repo with LRU eviction. Small + frequently-hit entries keep their access timestamp warm and survive eviction trivially. Large + short-lived entries (cook tarballs, target trees) compete hard for the same budget — if a heavy layer drives out the foundation, the next cold run pays *both* costs.
- **Foundation layers don't need users to keep `Cargo.lock` stable** to deliver value. Heavy layers do.

**Anti-pattern**: shipping the biggest absolute win first (cook) without the foundation. The cook tarball is multi-GB and invalidates on any dep update, so its hit rate is workload-dependent. On a repo with active dep churn, cook misses most of the time and pays full cold-deps cost on every miss — *plus* whatever toolchain bootstrap the missing foundation didn't shave off. The combined cold-cold case is slower than a foundation-only setup.

**Rule**: when adding a new cache layer, place it on the size × lifetime grid first. If it lands in the short-lived/large quadrant, the foundation in the long-lived/small quadrant must be in place — otherwise you're optimizing the wrong floor.

### Parallelism scheduling: big-with-small, never big-with-big

When multiple cache restores run concurrently they contend on three resources: network ingress, CPU (zstd decoding), and disk write bandwidth. The bottleneck on hosted runners is **disk write**, not network. Cross-stream network contention is mild (TCP fairly shares the ~500 Mbps Azure ingress); decompress contention is real (multiple `tar | zstd` processes fighting for the same SSD write queue).

Empirical evidence from PRs #144 (4-way parallel block, +9 s saved), #145 (added cook → 5-way parallel, **-13 s regression**), #148 (cook restore as background promise overlapping with sequential install steps, +7 s saved):

| Scheduling | Cook participates with | Result |
|---|---|---|
| 4-way parallel block (#144) | small/medium archives (setup, target-cache thin, build-cache zccache state ~200 MB, cargo-registry ~140 MB) — total ~600 MB compressed | works: max-of-parallel wins, contention mild |
| 5-way parallel including cook (#145) | adds cook's 214 MB compressed / **2.5 GB inflated** to the mix | breaks: every layer ~50% slower, net regression |
| Cook bg-promise overlapping install (#148) | cook (large) runs concurrent with rust install, soldr install, shims, verify — all sub-second, no significant disk writes | works: cook's wall-clock hides behind sequential install steps |

**Rule**: parallelize **big-with-small**, never **big-with-big**. When two restores both write multi-GB tar trees, they will fight for disk bandwidth and the wall-clock max grows enough to erase the parallel savings. Schedule the largest decompress so it overlaps with non-disk-heavy work (process spawns, version checks, small file extractions).

### Empirical archive sizes for setup-soldr layers

Reference data measured on the zccache project on `ubuntu-24.04`, post the 0.7.33 era (May 2026):

| Layer | Compressed | Restore wall clock (warm exact-hit, in 4-way parallel block) |
|---|---:|---:|
| setup-cache | tiny (metadata) | <1 s |
| cargo-registry | ~138 MB | ~12 s |
| build-cache (zccache state) | **~1.04 GB** (post native-CC, soldr#494) | ~36 s |
| cook-cache (deps target/) | ~214 MB → ~2.5 GB inflated | ~12 s (bg) / ~7 s (sequential alone) |
| target-cache (rust-plan bundle, `once` mode) | **~1.5-1.6 GB** | ~30-80 s (varies with bundle content) |
| soldr-mini-cache | ~2 MB | <1 s |
| solo-toolchain-cache | typically empty diff | <1 s |
| Post Setup Soldr step (after #153, `journal-print-raw: false`) | — | ~5 s |
| Post Setup Soldr step (debug:true + raw dump, pre-#153) | — | ~58 s |

Total warm-build wall clock on the demo workflow: ~94 s after #153 (was ~116 s after #148, 161 s baseline). For a production user without `logging: true` and `journal-print-raw: false`, estimated ~50 s.

The build-cache (zccache state) grew from ~198 MB to ~1.04 GB on 2026-05-24 after soldr#494 (`feat(cargo): inject zccache CC/CXX env vars for native C/C++ caching`) landed. cc-rs build-script invocations (rusqlite-bundled, ring, zstd-sys, etc.) now hit the managed zccache and their object files persist alongside rustc artifacts. Investigated and confirmed expected in setup-soldr#155. Opt-out: `SOLDR_NATIVE_CACHE=0`.

The target-cache bundle is unexpectedly large given the "rust-plan only" framing — tracked at soldr#461.

#### Cost of diagnostic dumps in the post step

The post-phase `dumpDiagnostics` writes a `[compile_journal_raw]` section verbatim to stdout when gated on. Each per-rustc record is ~3-5 KB; a typical warm zccache demo build emits ~6900 records ≈ 20-30 MB of stdout. GitHub Actions' log writer becomes the bottleneck — observed cost is ~30-50 s of Post Setup Soldr wall clock for the dump alone.

`journal-print-raw` (added in #153) decouples the raw dump from `debug:true`. Demo workflow sets it to "false" because it already uploads `${ZCCACHE_CACHE_DIR}/logs/` as the `zccache-logs-*` artifact — stdout dump is purely redundant on that path. Other workflows that don't upload the JSONL artifact and want forensic data should keep the default (`debug:true` → raw dump on).

**Rule for future post-step features that emit per-record data**: gate them on a *named* input, not on `debug:true`. The "debug means everything" semantics conflate fast diagnostics (archive sizes, ratios) with slow ones (per-record streams), making the demo's diagnostic budget binary instead of granular.

### Prioritization framework for fast-path work

When ranking optimizations, two axes matter:

1. **Magnitude**: how many seconds/MB per run does it save?
2. **Universality**: every run vs conditional?

A 60-second win that fires every run beats a 600-second win that fires once a week. Order roughly by `seconds_saved × probability_of_firing`. Settled order at time of writing:

1. **Prepare/toolchain solo-cache** — every run pays the toolchain bootstrap, ~45–90 s savings, no upstream dependency. Do first.
2. **`soldr cook` integration** (setup-soldr#110) — 5–15 min savings on cold deps but only when `Cargo.lock` is stable. Bigger absolute win, lower hit rate. Do second.
3. **soldr-mini-cache** (binary-only, ~2 MB, keyed on version+platform) — small absolute win (~2 s) but near-100 % hit rate per version. Cheap to add alongside the toolchain solo-cache.
4. **Vendored `zstd`** — eliminates a fallback branch, gives container/self-hosted parity. Trivial, no urgency.

### What to verify before writing cache code

Cache code is famously easy to write and famously hard to validate. Before landing a new cache layer:

1. Measure the **no-op case** (vanilla `ubuntu-latest`, `channel: stable`, no extras). The new layer should produce **zero cache writes**. If it doesn't, the snapshot/diff logic is wrong.
2. Measure the **typical pinned case** (specific channel, one extra target). Confirm only the delta lands in the cache, not the runner's pre-existing toolchain.
3. **Cold restore smoke test**: untar the cache into a clean `$RUSTUP_HOME` and run `rustup show` + `rustc --version`. Catches "the cache restored but rustup can't see it" failures.
4. **Stat the archive size** before and after `--long=27`, before and after `-19` — cache stats are diagnostic gold. Pipe through `statsCollector` (`src/lib/stats-collector.ts`) so warm runs surface size drift over time.

## Monitoring GitHub PR checks (jq pitfall)

GitHub's PR `statusCheckRollup` returns two distinct GraphQL types and they use **different field names** for their state:

| `__typename`     | Producer                           | State field                      |
|------------------|------------------------------------|----------------------------------|
| `CheckRun`       | GitHub Actions, most CI providers  | `.conclusion` (settled) + `.status` (live) |
| `StatusContext`  | Legacy/external bots (e.g. **CodeRabbit**, some legacy CI) | `.state` (`SUCCESS`/`PENDING`/`FAILURE`/`ERROR`) |

A polling loop that only checks `CheckRun` fields will spin forever on a PR with a `StatusContext` entry, because neither `.conclusion` nor `.status` is ever set on that entry — they're `null`, so a filter like `select(.status != "COMPLETED" and .conclusion == null)` matches it on every poll.

**Wrong** (hung indefinitely on PR #288 against the CodeRabbit entry):
```bash
until [ "$(gh pr view $PR --json statusCheckRollup --jq \
  '[.statusCheckRollup[] | select(.status != "COMPLETED" and .conclusion == null)] | length' \
)" = "0" ]; do sleep 45; done
```

**Right** — coalesce all three fields and treat `null` as still pending:
```bash
until [ "$(gh pr view $PR --json statusCheckRollup --jq \
  '[.statusCheckRollup[] | select(((.conclusion // .state // .status) // "PENDING") | IN("PENDING","QUEUED","IN_PROGRESS"))] | length' \
)" = "0" ]; do sleep 45; done
```

Or filter explicitly per `__typename`:
```jq
[.statusCheckRollup[] | (
  if .__typename == "CheckRun" then .conclusion
  elif .__typename == "StatusContext" then .state
  else null end
) // "PENDING"] | map(select(. == "PENDING" or . == "IN_PROGRESS"))
```

Same trap exists when grouping completed-check counts (`group_by(.conclusion)` misses StatusContext entries entirely). Always coalesce `.conclusion // .state` before grouping.

### Second-order gotcha: jq `//` only replaces `null` / `false`, NOT empty strings

When a CheckRun is still queued/in-progress, `gh pr view --json statusCheckRollup` returns `.conclusion: ""` (empty string), not `null`. The `//` alternative operator in jq treats `""` as **present** (the value is "set" to an empty string), so:

```jq
(.conclusion // .state // .status)   # returns "" when conclusion=""
```

…silently bottoms out at the empty string and never falls through to `.state` or `.status`. A polling loop that then does `select(. == "PENDING" or . == "IN_PROGRESS")` will **not** match the empty string and considers the queued job "settled" — exiting too early.

**The robust pattern is explicit, not coalesced**: check the field that actually carries live state. For `CheckRun`, that's `.status == "COMPLETED"`; for `StatusContext`, it's `.state != "PENDING"`. Use a conditional, not `//`:

```bash
# Wait until every entry is genuinely settled (CheckRun.status=COMPLETED or
# StatusContext.state in {SUCCESS,FAILURE,ERROR,EXPECTED}).
until [ "$(gh pr view $PR --json statusCheckRollup --jq '
  [.statusCheckRollup[] | select(
    (.__typename == "CheckRun"      and .status != "COMPLETED") or
    (.__typename == "StatusContext" and .state  == "PENDING")
  )] | length
')" = "0" ]; do sleep 30; done
```

This is the second face of the same family of bugs — the first hit (the original CodeRabbit miss) and this one (empty-string-vs-null) together cost ~10 minutes of stuck polling in one session. **Default to explicit per-typename checks; treat `//` as suspicious for any field that GitHub serializes as `""` when unset.**
