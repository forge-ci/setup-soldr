from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
DRIVER = REPO_ROOT / ".github/workflows/cook-downstream-rematerialization.yml"
REUSABLE = REPO_ROOT / ".github/workflows/_cook-consumer-rematerialization.yml"


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_running_process_gates_other_consumers_at_immutable_revisions() -> None:
    workflow = _load(DRIVER)
    jobs = workflow["jobs"]
    assert list(jobs) == ["running-process", "zccache", "soldr", "fbuild"]
    # #513 P0: a called workflow can never grant more than its caller, so
    # this ceiling is what lets the reusable cleanup job delete caches.
    assert workflow["permissions"]["actions"] == "write"
    assert "needs" not in jobs["running-process"]
    assert jobs["zccache"]["needs"] == "running-process"
    assert jobs["soldr"]["needs"] == "running-process"
    assert jobs["fbuild"]["needs"] == "running-process"
    for job in jobs.values():
        assert job["uses"] == "./.github/workflows/_cook-consumer-rematerialization.yml"
        revision = job["with"]["revision"]
        assert len(revision) == 40
        int(revision, 16)
    assert jobs["running-process"]["with"]["build_args"] == "-p running-process"


def test_reusable_workflow_proves_a_clean_job_loaded_the_cook_base() -> None:
    workflow = _load(REUSABLE)
    jobs = workflow["jobs"]
    assert list(jobs) == ["seed", "warm", "cleanup"]
    assert jobs["warm"]["needs"] == "seed"

    # #513 P0: the finalizer must run after both jobs on any outcome and
    # carries its own actions: write (the caller's ceiling is asserted in
    # the driver test below).
    cleanup = jobs["cleanup"]
    assert cleanup["if"] == "${{ always() }}"
    assert cleanup["needs"] == ["seed", "warm"]
    assert cleanup["permissions"]["actions"] == "write"

    seed_setup = next(step for step in jobs["seed"]["steps"] if step.get("id") == "setup")
    warm_setup = next(step for step in jobs["warm"]["steps"] if step.get("id") == "setup")
    for job in (jobs["seed"], jobs["warm"]):
        repair = next(
            step
            for step in job["steps"]
            if step.get("name") == "Repair yanked consumer lock entry"
        )
        assert "scripts/repair-yanked-chacha20-lock.py" in repair["run"]
        assert "consumer/Cargo.lock" in repair["run"]

    for setup in (seed_setup, warm_setup):
        inputs = setup["with"]
        assert "source-path" not in inputs
        assert inputs["build-cache"] is False
        assert inputs["target-cache"] is False
        assert inputs["cargo-registry-cache"] is True
        assert inputs["prebuild-deps"] == "soldr-cook"
        assert inputs["prebuild-deps-flags"] == "--release ${{ inputs.build_args }}"

    seed_guard = next(
        step for step in jobs["seed"]["steps"] if step.get("name") == "Require a cold cook seed"
    )
    assert 'test "$COOK_HIT" = false' in seed_guard["run"]
    assert 'test "$COOK_STATUS" = miss' in seed_guard["run"]
    assert "REGISTRY_HIT" not in seed_guard.get("env", {})

    warm_guard = next(
        step
        for step in jobs["warm"]["steps"]
        if step.get("name") == "Require the refreshed dependency closure"
    )
    assert 'test "$COOK_HIT" = true' in warm_guard["run"]
    assert 'test "$BASE_HIT" = true' in warm_guard["run"]
    assert 'test "$REGISTRY_HIT" = true' in warm_guard["run"]

    build = next(step for step in jobs["warm"]["steps"] if step.get("id") == "build")
    assert "soldr cargo build" in build["run"]
    assert "ZCCACHE_DISABLE" not in build["run"]
    assert "soldr cargo metadata --locked --format-version=1" in build["run"]
    assert "find . -path ./target -prune" in build["run"]
    assert '"$RUNNER_TEMP/${{ inputs.cache_key }}-metadata.json"' in build["run"]
    assert "assert_no_external_rebuild.py" in build["run"]


def test_reusable_workflow_serializes_cold_release_cooks() -> None:
    workflow = _load(REUSABLE)
    assert workflow["env"]["CARGO_BUILD_JOBS"] == "1"
    assert workflow["env"]["SOLDR_JOBS"] == "1"
