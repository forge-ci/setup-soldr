// The soldr release this setup-soldr build is vendor-locked to. When the
// `version` input is omitted (or empty / "default"), the action installs this
// exact release with zero network lookups for version resolution; only an
// explicit `version: latest` resolves the newest release at run time.
//
// Bumped by `node scripts/bump-default-soldr.mjs <version>` (run by the
// ingest-soldr-release workflow), which also updates action.yml's
// `inputs.version.default`; a unit test keeps the two in lockstep.
export const DEFAULT_SOLDR_VERSION = "0.9.37";
