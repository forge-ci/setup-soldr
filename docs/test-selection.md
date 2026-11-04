# Test selection (TEST-004)

A pull request runs only the node test suites its change can affect. The
policy is forge-ci/ci.yml#518 (`TEST-004`); this is setup-soldr's
implementation.

## Pieces

| File | Role |
| --- | --- |
| `ci/test-selection.json` | The declared map: named suites (a partition of what `npm test` runs), path-glob rules, `always` and `ignore` globs. Review it like code. |
| `ci/select-tests.mjs` | The selector: `plan` prints the selection, `run` runs it, `check` is the self-test, `graph` prints which suites read each file. |
| `__tests__/select-tests.test.ts` | Unit tests for every explicit rule, the fail-closed cases and the guard. |

## Rules, in order

1. A path in `always` (`package.json`, `package-lock.json`, `tsconfig.json`,
   `.oxlintrc.json`, `action.yml`, `ci/**`, the test loader, the contract
   workflow) selects **every** suite.
2. A test file: modified, it selects its own suite plus the suites of the
   tests that import it; added, deleted, renamed or in no suite, it selects
   every suite.
3. Otherwise every matching rule adds its suites.
4. Otherwise an `ignore` glob (docs, the pytest tree, prose) selects nothing.
5. Otherwise the path is unresolvable: **every** suite (fail closed).

Then the **under-selection guard** runs: the selector builds each test
file's import closure (relative imports, plus repo paths named as string
literals, since several tests read `action.yml`, workflows or `src/` off
disk). If a test that reads a changed file sits in a suite the rules did
not select, the selector exits 3 and the run fails. A stale map cannot
skip green.

`check` (run in CI before every selection) proves the map against the graph
ahead of time: for every file any test reads, a synthetic one-file change must
select every suite that reads it, through the rules alone.

## Where it runs

- `npm run gate` (pre-push): the `tests` lane runs the selected suites.
  `node ci/local_gate.mjs run --all` runs every suite.
- `setup-soldr-contract.yml` `js-build`: on `pull_request` the "Select test
  suites" step writes the selection, with reasons, to the job summary, and
  "Unit tests" runs it. Push to `main`, the merge queue, manual dispatch and
  the nightly `schedule` run `npm test` (every suite).
- `npm test` is unchanged. `npm run test:<suite>` runs one suite,
  `npm run test:affected` runs the selection for your branch vs
  `origin/main`.

## Changing the map

Run `npm run test:select-check` after editing `ci/test-selection.json` or
adding an import. When it reports `a change to X would not select 'S'`, add
X to a rule for S (or to a broader rule). `node ci/select-tests.mjs graph`
lists the readers of every file.
