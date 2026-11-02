from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_rollout_contract_workflow_covers_main_pr_and_manual_runs() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "name: Setup Soldr Contract" in workflow
    assert "workflow_dispatch:" in workflow
    assert "push:" in workflow
    assert "pull_request:" in workflow
    assert "merge_group:" in workflow
    # The required `CI summary` lives here: a path filter would leave PRs on
    # unlisted paths without the check and wedge the merge queue.
    import yaml

    triggers = yaml.safe_load(workflow)[True]  # PyYAML reads `on:` as True
    for event, spec in triggers.items():
        assert not (spec if isinstance(spec, dict) else {}).get("paths"), event
        assert not (spec if isinstance(spec, dict) else {}).get("paths-ignore"), event


def test_rollout_contract_workflow_builds_and_tests_the_js_action() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "actions/setup-node@" in workflow
    # Node 24 matches the GitHub Actions runtime declared by action.yml and
    # still supports --experimental-strip-types for the TypeScript test files.
    assert "node-version: 24" in workflow
    assert "npm ci" in workflow
    assert "npm run typecheck" in workflow
    assert "npm test" in workflow
    assert "npm run build" in workflow
    # #306: verify now checks entry-point bundles only (not the whole
    # dist/), because side chunks have non-deterministic webpack-internal
    # module ordering across hosts. Sanity check ensures referenced
    # chunk files exist on disk.
    assert "git diff --exit-code -- " in workflow
    assert "dist/main.js" in workflow
    assert "dist/post.js" in workflow


def test_rollout_contract_workflow_runs_remaining_python_contract_tests() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "python -m pytest" in workflow
    assert "tests/test_action_target_cache_wiring.py" in workflow
    assert "tests/test_cook_rematerialization_workflow.py" in workflow
    assert "tests/test_rust_ci_workflow.py" in workflow
    assert "tests/test_release_rollout_contract.py" in workflow
    assert "tests/test_v0_promotion_evidence.py" in workflow


def test_default_release_readiness_is_part_of_the_contract() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    assert "Default Release Readiness" in workflow
    assert "node scripts/check-default-release-readiness.mjs" in workflow

    readiness = (REPO_ROOT / "scripts/check-default-release-readiness.mjs").read_text(
        encoding="utf-8"
    )
    assert "https://pypi.org/pypi/soldr/" in readiness
    assert "https://zackees.github.io/soldr-toolchain/cargo-chef/manifest.json" in readiness
    assert "digests?.sha256" in readiness
    assert "missingSupport" in readiness
    assert "PyPI wheel fallbacks" in readiness


def test_install_smoke_runs_every_platform_that_uses_the_default_wheel_fallback() -> None:
    workflow = (REPO_ROOT / ".github/workflows/setup-soldr-contract.yml").read_text(
        encoding="utf-8"
    )

    for runner in (
        "ubuntu-24.04",
        "ubuntu-24.04-arm",
        "macos-15-intel",
        "windows-11-arm",
    ):
        assert f"- {runner}" in workflow
    assert "runs-on: ${{ matrix.runner }}" in workflow
    assert "cargo-chef 0.1.73" in workflow
    assert "soldr-daemon --help" in workflow


def test_v0_promotion_is_manual_and_repeats_the_gates() -> None:
    workflow = (REPO_ROOT / ".github/workflows/update-v0-tag.yml").read_text(
        encoding="utf-8"
    )

    assert "workflow_run:" not in workflow
    assert "workflow_dispatch:" in workflow
    assert "canary_run_id:" in workflow
    assert "default: true" in workflow
    assert "python3 scripts/verify-v0-promotion.py" in workflow
    assert "node scripts/check-default-release-readiness.mjs" in workflow
    assert "uses: ./" in workflow
    assert 'git push --force-with-lease="refs/tags/v0:${old_ref}"' in workflow
