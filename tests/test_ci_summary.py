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
        job("End-of-queue cache janitor", "failure"),
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
    assert set(gate["needs"]) == set(wf["jobs"]) - {"ci-summary", "queue-cache-janitor"}
