from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/cook-rematerialization.yml"


def _load() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _step(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


# The pipeline under test. `cleanup` (#513 P0) is a finalizer, not part of
# the seed/warm proof, and is asserted separately below.
PIPELINE_JOBS = ("baseline", "seed", "delta-seed", "warm")


def test_rematerialization_workflow_has_isolated_baseline_seed_delta_and_warm_jobs() -> None:
    workflow = _load()
    jobs = workflow["jobs"]
    assert set(jobs) == {*PIPELINE_JOBS, "cleanup"}
    assert jobs["delta-seed"]["needs"] == "seed"
    assert jobs["warm"]["needs"] == ["baseline", "delta-seed"]
    assert "github.run_attempt" in workflow["env"]["CACHE_GENERATION"]
    for job_name in PIPELINE_JOBS:
        checkout = jobs[job_name]["steps"][0]
        assert checkout["uses"] == "actions/checkout@v4"
        assert checkout["with"]["submodules"] == "recursive"


def test_seed_asserts_the_cook_save_stayed_inside_the_inventory() -> None:
    """#513 P0: the cook base is captured at cook time, bounded by the
    cook-time inventory — a deferred post-step capture reports nothing
    here and cannot pass."""
    workflow = _load()
    seed = workflow["jobs"]["seed"]
    step = _step(seed, "Assert the cook save stayed inside the cook-time inventory")
    assert step["shell"] == "bash"
    assert (
        step["env"]["SAVE_REPORT"]
        == "${{ steps.setup.outputs.cook-cache-save-report-json }}"
    )
    run = step["run"]
    assert '(.layer == "base")' in run
    assert "inventoryFileCount" in run
    assert "1.05" in run


def test_cleanup_is_an_always_finalizer_with_cache_delete_access() -> None:
    """#513 P0: run-scoped cache keys must be deleted on success, failure,
    and cancellation, and the job needs actions: write to do it."""
    workflow = _load()
    cleanup = workflow["jobs"]["cleanup"]
    assert cleanup["if"] == "${{ always() }}"
    assert cleanup["needs"] == list(PIPELINE_JOBS)
    assert cleanup["permissions"]["actions"] == "write"
    deleter = _step(cleanup, "Delete this run's namespaced cache keys")
    assert "delete-run-scoped-caches.mjs" in deleter["run"]


def test_staged_fixture_replaces_the_yanked_chacha20_lock_entry() -> None:
    repair = REPO_ROOT / "scripts/repair-yanked-chacha20-lock.py"
    assert repair.is_file()
    script_source = repair.read_text(encoding="utf-8")
    assert "chacha20 0.10.1" in script_source
    assert 'version = "0.10.2"' in script_source
    assert "expected at most one chacha20 0.10.1 or 0.10.2 lock entry" in script_source

    workflow = _load()
    for job_name in PIPELINE_JOBS:
        stage = _step(workflow["jobs"][job_name], "Stage isolated fixture")
        assert "scripts/repair-yanked-chacha20-lock.py" in stage["run"]


def test_seed_and_warm_use_pinned_source_and_only_dependency_closure_caches() -> None:
    workflow = _load()
    for job_name in ("seed", "delta-seed", "warm"):
        setup = next(
            step for step in workflow["jobs"][job_name]["steps"] if step.get("uses") == "./"
        )
        inputs = setup["with"]
        assert inputs["source-path"] == "_vender/soldr"
        assert inputs["build-cache"] is False
        assert inputs["target-cache"] is False
        assert inputs["cargo-registry-cache"] is True
        assert inputs["solo-toolchain-cache"] is False
        assert inputs["soldr-mini-cache"] is False
        assert inputs["prebuild-deps"] == "soldr-cook"
        assert inputs["prebuild-deps-delta-cache"] is True
        # #528: this lane validates the delta layer, which is opt-in.
        assert inputs["cook-delta"] is True
        assert inputs["lockfile"].endswith("/Cargo.lock")


def test_cold_cook_is_serialized_to_fit_hosted_runner_memory() -> None:
    workflow = _load()
    assert workflow["env"]["CARGO_BUILD_JOBS"] == "1"
    assert workflow["env"]["SOLDR_JOBS"] == "1"


def test_warm_gate_requires_usable_transports_and_zero_external_work() -> None:
    workflow = _load()
    warm = workflow["jobs"]["warm"]
    transport = _step(warm, "Require usable dependency-closure transports")
    assert "cook-cache-hit" in transport["env"]["COOK_HIT"]
    assert "cook-cache-base-hit" in transport["env"]["BASE_HIT"]
    assert "cook-cache-delta-hit" in transport["env"]["DELTA_HIT"]
    assert "cargo-registry-cache-hit" in transport["env"]["REGISTRY_HIT"]
    assert 'test "$COOK_HIT" = true' in transport["run"]
    assert 'test "$BASE_HIT" = true' in transport["run"]
    assert 'test "$DELTA_HIT" = false' in transport["run"]
    assert 'test "$REGISTRY_HIT" = true' in transport["run"]
    assert 'test "$COOK_STATUS" = base-hit' in transport["run"]
    assert 'report["delta"]["cacheFilesRestored"] == 0' in transport["run"]
    seed = _step(workflow["jobs"]["seed"], "Record seed transport state")
    assert 'test "$COOK_HIT" = false' in seed["run"]
    assert 'test "$REGISTRY_HIT" = false' in seed["run"]

    build = _step(warm, "Prove only workspace code rebuilds")
    script = build["run"]
    assert "soldr cargo build" in script
    assert "ZCCACHE_DISABLE" not in script
    baseline = _step(workflow["jobs"]["baseline"], "Measure clean dependency build")
    assert "soldr cargo build" in baseline["run"]
    assert "ZCCACHE_DISABLE" not in baseline["run"]
    assert "--message-format=json-render-diagnostics" in script
    assert "assert_warm.py" in script
    # setup-soldr's own copy, not the soldr submodule's. The Contract Tests
    # job checks out without submodules, so reading through _vender/soldr
    # raises FileNotFoundError in CI while passing locally against a populated
    # submodule -- a test that only fails where nobody is looking.
    assertion_source = (
        REPO_ROOT / "tests/cook-rematerialization/assert_warm.py"
    ).read_text(encoding="utf-8")
    assert 'if report["external_dirty"]' in assertion_source
    assert 'if report["external_build_script_runs"]' in assertion_source
    assert '"speedup":' in assertion_source
    assert "warm_ms * 10" not in assertion_source
