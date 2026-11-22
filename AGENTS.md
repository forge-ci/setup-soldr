# Agent Notes

- After an important action feature or compatibility fix is merged, promote the floating `v0` tag only through the manual Update v0 tag workflow. Supply the full current `main` SHA and a successful FastLED/fbuild `ci-minimal.yml` pull-request canary run ID whose selected and full coverage jobs passed and whose logs prove `zackees/setup-soldr@<that SHA>` ran. The workflow repeats the exact-SHA contract, readiness, and local-action smoke; dry run is the default. Never move `v0` from contract success alone. Keep immutable release tags such as `v0.1.0` unchanged.

Pushes from clud sessions are gated by `pr_checks` (talos-hq/clud#2720): run `clud pr-check` before pushing; it runs `npm run lint` (oxlint with denied warnings) and `npm run typecheck` (TypeScript compile checks).
