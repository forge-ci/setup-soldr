#!/usr/bin/env bash
set -euo pipefail

rm -rf /runner/action
mkdir -p /runner/action
for file in output state env path summary; do
  : > "/runner/action/$file"
done

export HOME=/root
export CARGO_HOME=/root/.cargo
export RUSTUP_HOME=/root/.rustup
export GITHUB_ACTIONS=true
export GITHUB_ACTION_PATH=/repo
export GITHUB_WORKSPACE=/repo
export RUNNER_TEMP=/runner
export RUNNER_OS=Linux
export RUNNER_ARCH=X64
export GITHUB_OUTPUT=/runner/action/output
export GITHUB_STATE=/runner/action/state
export GITHUB_ENV=/runner/action/env
export GITHUB_PATH=/runner/action/path
export GITHUB_STEP_SUMMARY=/runner/action/summary
export INPUT_ENABLE=true
export INPUT_REPO=zackees/soldr
export INPUT_CACHE=false
export INPUT_TOOLCHAIN=1.95.0
export INPUT_LINKER=platform-default
export INPUT_TIMESTAMPS=false

env \
  'INPUT_SOURCE-PATH=_vender/soldr' \
  'INPUT_PREBUILD-DEPS=none' \
  'INPUT_BUILD-CACHE=false' \
  'INPUT_TARGET-CACHE=false' \
  'INPUT_CARGO-REGISTRY-CACHE=false' \
  'INPUT_SOLO-TOOLCHAIN-CACHE=false' \
  'INPUT_SOLDR-MINI-CACHE=false' \
  node dist/main.js

while IFS= read -r path_entry; do
  PATH="${path_entry}:${PATH}"
done < "$GITHUB_PATH"
export PATH

version_json="$(soldr version --json)"
expected_version="$(python3 - <<'PY'
import re
from pathlib import Path
text = Path("/repo/_vender/soldr/Cargo.toml").read_text(encoding="utf-8")
match = re.search(r'^version = "([^"]+)"$', text, re.MULTILINE)
if not match:
    raise SystemExit("could not read Soldr workspace version")
print(match.group(1))
PY
)"
node -e '
  const payload = JSON.parse(process.argv[1]);
  if (payload.soldr_version !== process.argv[2]) {
    throw new Error(`unexpected local source version: ${payload.soldr_version}`);
  }
' "$version_json" "$expected_version"

metadata_path="$(find /runner -name '.setup-soldr-source.json' -print -quit)"
test -n "$metadata_path"
node -e '
  const metadata = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (metadata.repo !== "local") process.exit(1);
  if (!String(metadata.commit_sha).startsWith("local-")) process.exit(1);
' "$metadata_path"
test -x "$(command -v soldr)"
printf 'source-path smoke passed: %s\n' "$version_json"
