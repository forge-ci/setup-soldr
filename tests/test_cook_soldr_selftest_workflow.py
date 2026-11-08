"""Guards for the soldr cook self-test workflow.

The workflow's whole value is that it passes NO cook inputs: it exercises the
shipped defaults against a real workspace. A well-meaning edit that pins
`prebuild-deps: soldr-cook` there would keep the workflow green while
destroying what it tests, so that absence is asserted here rather than left to
review.
"""

from __future__ import annotations

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).parents[1]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "cook-soldr-selftest.yml"
ACTION = REPO_ROOT / "action.yml"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def test_cook_is_on_by_default_in_the_action() -> None:
    """The property the workflow exists to protect, asserted at the source."""
    action = yaml.safe_load(ACTION.read_text(encoding="utf-8"))
    assert action["inputs"]["prebuild-deps"]["default"] == "soldr-cook"
    assert action["inputs"]["prebuild-deps-delta-cache"]["default"] == "true"


def test_cold_cook_is_serialized_to_fit_hosted_runner_memory() -> None:
    workflow = _workflow()
    assert workflow["env"]["CARGO_BUILD_JOBS"] == "1"
    assert workflow["env"]["SOLDR_JOBS"] == "1"


def test_selftest_repairs_the_yanked_soldr_lock_before_setup() -> None:
    workflow = _workflow()
    for job_name in ("seed", "warm"):
        repair = next(
            step
            for step in workflow["jobs"][job_name]["steps"]
            if step.get("name") == "Repair yanked Soldr lock entry"
        )
        assert "scripts/repair-yanked-chacha20-lock.py" in repair["run"]
        assert "_vender/soldr/Cargo.lock" in repair["run"]


def test_the_selftest_pins_no_cook_inputs() -> None:
    workflow = _workflow()
    for job_name, job in workflow["jobs"].items():
        for step in job["steps"]:
            if step.get("uses") != "./":
                continue
            pinned = sorted(k for k in (step.get("with") or {}) if "prebuild" in k)
            assert not pinned, (
                f"{job_name} pins {pinned}; this workflow must exercise the "
                "shipped defaults, not restate them"
            )


def test_both_jobs_default_to_linux_and_allow_dispatch_elsewhere() -> None:
    workflow = _workflow()
    for job_name in ("seed", "warm"):
        job = workflow["jobs"][job_name]
        assert "ubuntu-24.04" in str(job["runs-on"])
        assert "inputs.runner" in str(job["runs-on"])

    # The #513 cleanup finalizer only calls the cache API, so it stays on
    # fixed Linux even when a workflow_dispatch targets windows/macos.
    cleanup = workflow["jobs"]["cleanup"]
    assert cleanup["runs-on"] == "ubuntu-24.04"
    assert cleanup["if"] == "${{ always() }}"
    assert cleanup["needs"] == ["seed", "warm"]
    assert cleanup["permissions"]["actions"] == "write"

    # `on` is parsed by PyYAML as the boolean True.
    triggers = workflow.get("on", workflow.get(True))
    options = triggers["workflow_dispatch"]["inputs"]["runner"]["options"]
    assert {"windows-2022", "macos-14"} <= set(options)


def test_seed_asserts_the_cook_save_stayed_inside_the_inventory() -> None:
    """#513 P0: capture cook output at the correct boundary.

    The seed job builds soldr-cli right after setup — the lane that once
    uploaded a ~1 GB cook base containing the first-party build. The
    assertion must exist (post-step outputs are invisible to setup-step
    reads, so a regression back to deferred capture fails here) and must
    bound the saved file count by the cook-time inventory.
    """
    workflow = _workflow()
    seed = workflow["jobs"]["seed"]
    step = next(
        s
        for s in seed["steps"]
        if s.get("name") == "Assert the cook save stayed inside the cook-time inventory"
    )
    assert step["shell"] == "bash"
    assert (
        step["env"]["SAVE_REPORT"]
        == "${{ steps.setup.outputs.cook-cache-save-report-json }}"
    )
    run = step["run"]
    assert '(.layer == "base")' in run
    assert "inventoryFileCount" in run
    assert "fileCount" in run
    assert "1.05" in run
    # The assertion must precede the first-party build it protects against.
    names = [s.get("name") for s in seed["steps"]]
    assert names.index(
        "Assert the cook save stayed inside the cook-time inventory"
    ) < names.index("Build soldr so the closure is populated")


def test_the_warm_job_refuses_to_assert_without_a_restore() -> None:
    """A freshness assertion after a cache miss proves nothing."""
    warm = _workflow()["jobs"]["warm"]
    guard = next(s for s in warm["steps"] if "restored" in s.get("name", ""))
    assert 'COOK_HIT" != "true"' in guard["run"]

    build = next(s for s in warm["steps"] if s.get("id") == "build")
    assert "assert_no_external_rebuild.py" in build["run"]
    assert "soldr cargo metadata --locked --format-version=1" in build["run"]
    assert "touch crates/soldr-cli/src/main.rs" in build["run"]
    assert '"$RUNNER_TEMP/warm-metadata.json"' in build["run"]


def test_selftest_builds_use_the_default_cook_profile() -> None:
    """An early release capture cannot warm an unrelated debug build."""
    action = yaml.safe_load(ACTION.read_text(encoding="utf-8"))
    flags = action["inputs"]["prebuild-deps-flags"]["default"].split()
    assert "--release" in flags
    for job_name in ("seed", "warm"):
        builds = [
            step["run"]
            for step in _workflow()["jobs"][job_name]["steps"]
            if "soldr cargo build" in step.get("run", "")
        ]
        assert len(builds) == 1
        assert "soldr cargo build -p soldr-cli --release --locked" in builds[0]
