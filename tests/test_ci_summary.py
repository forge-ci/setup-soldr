import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("ci_summary", Path(__file__).parents[1] / "ci" / "ci_summary.py")
ci_summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci_summary)


def job(name, conclusion, status="completed"):
    return {"name": name, "conclusion": conclusion, "status": status}


def test_blocks_each_unsuccessful_conclusion():
    for conclusion in ci_summary.BLOCKING:
        assert ci_summary.blockers([job("Contract Tests", conclusion)]) == [("Contract Tests", conclusion)]


def test_passes_success_and_skipped_and_exempts_by_exact_name():
    jobs = [
        job("JS Build and Tests", "success"),
        job("Wheel fallback smoke (ubuntu-24.04)", "skipped"),
        job("CI summary", None, "in_progress"),
        job("Cancel superseded queue runs", "cancelled"),
    ]
    assert ci_summary.blockers(jobs) == []


def test_wheel_smoke_and_unfinished_jobs_block():
    jobs = [job("Wheel fallback smoke (windows-11-arm)", "failure"), job("Contract Tests", None, "queued")]
    assert [name for name, _ in ci_summary.blockers(jobs)] == ["Wheel fallback smoke (windows-11-arm)", "Contract Tests"]


def test_workflow_gate_shape():
    import yaml

    wf = yaml.safe_load((Path(__file__).parents[1] / ".github/workflows/setup-soldr-contract.yml").read_text())
    gate = wf["jobs"]["ci-summary"]
    assert gate["name"] == "CI summary"
    assert gate["if"] == "${{ always() }}"
    assert gate["permissions"] == {"contents": "read", "actions": "read"}
    assert set(gate["needs"]) == set(wf["jobs"]) - {"ci-summary"}


def test_a_merge_group_run_holds_no_job_in_the_cache_janitor_group():
    """A displaced pending sweep concludes its run cancelled (run 42319023893)."""
    import yaml

    wf = yaml.safe_load((Path(__file__).parents[1] / ".github/workflows/setup-soldr-contract.yml").read_text())
    groups = [(job.get("concurrency") or {}).get("group") for job in wf["jobs"].values()]
    assert "cache-janitor" not in groups


def test_queue_traffic_is_swept_after_the_run_completes():
    import yaml

    wf = yaml.safe_load((Path(__file__).parents[1] / ".github/workflows/ingest-soldr-release.yml").read_text())
    assert wf[True]["workflow_run"] == {
        "workflows": ["Setup Soldr Contract"],
        "types": ["completed"],
        "branches": ["gh-readonly-queue/main/**"],
    }
    # Top-level concurrency would let queue traffic displace a pending ingest.
    assert "concurrency" not in wf
    assert wf["jobs"]["ingest"]["if"] == "${{ github.event_name != 'workflow_run' }}"
    assert wf["jobs"]["ingest"]["concurrency"]["group"] == "ingest-soldr-release"
    sweep = wf["jobs"]["queue-cache-sweep"]
    assert "github.event.workflow_run.event == 'merge_group'" in sweep["if"]
    assert sweep["concurrency"] == {"group": "cache-janitor", "cancel-in-progress": False}
    assert sweep["permissions"] == {"contents": "read", "actions": "write"}
    assert any("ci_lint cache janitor" in step.get("run", "") for step in sweep["steps"])


def test_workflow_triggers_are_unfiltered():
    import yaml

    wf = yaml.safe_load((Path(__file__).parents[1] / ".github/workflows/setup-soldr-contract.yml").read_text())
    on = wf[True]  # PyYAML reads the `on:` key as boolean True
    assert "pull_request" in on and "merge_group" in on
    for event, spec in on.items():
        assert not (spec if isinstance(spec, dict) else {}).get("paths"), f"{event} must not be path-filtered: the required check would never run"
        assert not (spec if isinstance(spec, dict) else {}).get("paths-ignore"), f"{event} must not use paths-ignore"
