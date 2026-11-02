# The local gate (`ci/local_gate.mjs`)

Remote CI spends most of its `js-build` wall clock re-running two things a
developer host can run in about a minute and a half: `oxlint` and the
`node --test` suite. The local gate runs them before the push, writes a
tamper-evident record of what passed into the commit message, and lets CI skip
exactly those steps — and only those steps, and only when every piece of the
record checks out.

The shape is forge-ci/ci.yml's (`GATE-008`, `GATE-010`; see that repo's
`docs/ci-attestations.md`), not a new one, so the fleet's tooling reads these
commits unchanged.

## Install it once per clone

```
npm run gate:install-hook      # writes .git/hooks/pre-push
```

If a `pre-push` hook already exists and this gate did not write it, nothing is
touched: the installer prints what to do (`--chain` to keep yours and run it
first, `--force` to replace it with a backup, or call
`node ci/local_gate.mjs check-push "$@"` from your own hook).

The installer writes to `git rev-parse --git-path hooks`, which is the only
path git consults: it honours `core.hooksPath`, and in a linked worktree it is
the *shared* hooks directory. Installing from inside a worktree therefore gates
every worktree of that clone, including the primary one.

## Use it

From a clean, committed tree:

```
npm run gate        # lint + typecheck + unit tests, then stamps HEAD
npm run gate:fast   # skips the test lane; CI then runs it
```

The gate refuses to attest anything if the tree has uncommitted tracked
changes, if any lane fails, or if git state is unreadable. On success it amends
HEAD's *message* only — the tree is untouched — and the pre-push hook lets the
push through.

## Lanes

Changed files are computed against `origin/main` (`merge-base`), or the whole
tree when there is no merge base. Each lane decides from that list whether it
has anything to do; a lane with nothing to do still counts as proven, because
the base tree was already green.

| Lane | Runs | Selection |
| --- | --- | --- |
| `lint` | `oxlint --deny-warnings <changed files>` | only the changed `.ts`/`.mjs`/… under `src/`, `scripts/`, `ci/`, `__tests__/`. oxlint's enabled rules are file-local, so linting the changed files is equivalent to linting the tree whose other files the base already proved. |
| `typecheck` | `npm run typecheck` (`tsc --noEmit`) | the whole project — `tsc` needs the whole program — when any `.ts` changed. This *is* the fast path (~4 s). |
| `tests` | `npm test` | unless every changed path is prose, the pytest suite or its config. Skipped entirely by `--fast`. |

A change to `package.json`, `package-lock.json`, `tsconfig.json`,
`.oxlintrc.json`, `ci-attestations.yml` or `ci/local_gate.mjs` makes every lane
run against everything: those files decide what the lanes do.

`node ci/local_gate.mjs lanes` prints the gate/lane table and fails if
`ci-attestations.yml` names a lane the script does not implement.

## What gets written

Two trailers, in the fleet's exact shapes:

```
Local-Gate: v1 tree=<40 hex> secs=<n> lanes=lint:run,typecheck:run,tests:run
Ci-Attestation: {"at":...,"gate":"general/all/lint","host":"linux-x86_64","key":"...","lane":"lint","parents":["..."],"secs":...,"stamp":"...","tree":"...","v":1,"via":"run"}
```

One `Ci-Attestation:` per gate declared in [`ci-attestations.yml`](../ci-attestations.yml).
`stamp` is `sha256(tree \n comma-joined parents \n canonical JSON without the
stamp)` truncated to 32 hex — byte-identical to
`ci_lint.attestations.GateAttestation.compute_stamp`, verified against it. A
commit's own hash already covers its message, so the stamp binds the tree and
the parents instead: editing the JSON, changing a file, or rebasing invalidates
it. It is tamper-evident, not a signature; the hosted verifier is the boundary,
and a hook is always bypassable with `--no-verify`.

A machine-readable copy of the same records lands in
`$GIT_DIR/local-gate/<commit>.json` (and `latest.json`). It lives under the git
directory on purpose: a tracked file would change the very tree its records
attest.

## What CI does with it

`setup-soldr-contract.yml`'s `js-build` job gains one step,
`Verify local-gate attestation`, before Lint / Typecheck / Unit tests. It runs
`node ci/local_gate.mjs verify --commit <head> --base <base> --github-output
--summary` and each of those three steps carries
`if: steps.gate.outputs.skip_<lane> != 'true'`. The job summary always records
the decision and the evidence behind it.

It is one step in an existing job, not a new job: a new job would pay
runner-queue time and lose more than the skip saves.

Fail-closed, with no exceptions:

| Situation | Result |
| --- | --- |
| event is not `pull_request` (push to `main`, merge queue, dispatch) | every step runs — these are the post-merge catch and the merge boundary |
| the head is on a fork, or the author is not `OWNER`/`MEMBER`/`COLLABORATOR` | every step runs. The stamp is tamper-evident, not a signature: anyone holding the script can mint a record, so only a writer's head on this repository may authorize a skip |
| the checkout is not a two-parent merge commit, or `HEAD^2` is not the PR head GitHub reported | every step runs |
| the PR touches a gate surface (`package.json`, `package-lock.json`, `tsconfig.json`, `.oxlintrc.json`, `ci-attestations.yml`, `ci/local_gate.mjs`, this workflow) | every step runs: only a remote run can validate a change to what the gate itself does |
| `ci-attestations.yml` missing or unparseable **at the base** | every step runs. The definition is always read from the base, so a PR cannot widen what it may skip |
| no `Ci-Attestation:` for a gate | that gate's step runs. Omission means "not run locally"; there is no "skipped" record |
| wrong tree, wrong parents, bad stamp, duplicate, undeclared gate, lane mismatch, malformed JSON | nothing is skipped at all — the evidence is wrong, not absent, so the whole head is distrusted |
| the record is older than 24 h, or more than 60 s in the future | that gate is `stale`; its step runs |
| `Local-Gate:` trailer missing, or naming a different tree | nothing is skipped |

The `js-build` job as a whole is never skipped: it also builds and byte-verifies
the committed `dist/` bundles, which the gate does not prove. That is why
`ci-attestations.yml` deliberately carries no `jobs:` mapping — the fleet's unit
of skipping is a whole job, and this repository skips steps.

## Not covered

- No lane result cache (the fleet's `GATE-007`): a rerun repeats every selected
  lane. `ci.toml` records this as `[local] cache = "off"`.
- No audit sample. The fleet re-runs 1 PR in 10 remotely to check that the gate
  and CI agree; here the `main` push run after every merge is the only catch.
- Only the `linux-x86_64` host is attested. The `wheel-fallback-smoke` matrix
  (Linux arm64, macOS x64, Windows arm64) is remote-only by design and is never
  skipped.
