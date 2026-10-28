"""Fail-closed evidence check for the manually dispatched v0 promotion."""

import http.client
import io
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

SETUP_REPO = "zackees/setup-soldr"
CANARY_REPO = "FastLED/fbuild"
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")


def api(path: str, *, archive: bool = False):
    token = os.environ["GH_TOKEN"]
    request = urllib.request.Request(
        f"https://api.github.com/repos/{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    # Every call retries transport failures and 5xx: a 502 from the API
    # gateway (or the log archive's blob redirect) is transient, and failing
    # the promotion on it forces a re-run of the whole verification.
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            break
        except (http.client.IncompleteRead, ConnectionError, TimeoutError, urllib.error.URLError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code < 500:
                raise
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    return data if archive else json.loads(data)


def verify(target: str, canary_id: str) -> int:  # noqa: C901 - measured baseline, zackees/ci.yml#229
    if not SHA_PATTERN.fullmatch(target):
        raise ValueError("target_sha must be a full lowercase 40-character commit SHA")
    if not canary_id.isdecimal() or int(canary_id) <= 0:
        raise ValueError("canary_run_id must be a positive run ID")
    if subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != target:
        raise ValueError("checked-out action is not the candidate SHA")
    workflow_repository_id = os.environ.get("GITHUB_REPOSITORY_ID", "")
    if not workflow_repository_id.isascii() or not workflow_repository_id.isdecimal():
        raise ValueError("promotion workflow has no valid repository identity")
    repository_id = api(SETUP_REPO).get("id")
    if type(repository_id) is not int or repository_id <= 0 or repository_id != int(workflow_repository_id):
        raise ValueError("setup-soldr alias does not match the promotion repository")
    main = api(f"{SETUP_REPO}/git/ref/heads/main")["object"]["sha"]
    if main != target:
        raise ValueError("candidate is not current main")

    runs = api(
        f"{SETUP_REPO}/actions/workflows/setup-soldr-contract.yml/runs"
        f"?head_sha={target}&branch=main&status=success&per_page=100"
    )["workflow_runs"]
    contracts = [
        run for run in runs
        if run["head_sha"] == target
        and run["head_branch"] == "main"
        and run["status"] == "completed"
        and run["conclusion"] == "success"
        and run["event"] in ("push", "workflow_dispatch")
        and run["path"].lstrip("/") == ".github/workflows/setup-soldr-contract.yml"
        and run["repository"].get("id") == repository_id
    ]
    if not contracts:
        raise ValueError("no successful Setup Soldr Contract run for exact main SHA")

    canary = api(f"{CANARY_REPO}/actions/runs/{canary_id}")
    if (
        canary["id"] != int(canary_id)
        or canary["repository"]["full_name"].lower() != CANARY_REPO.lower()
        or canary["event"] != "pull_request"
        or canary["path"].lstrip("/") != ".github/workflows/ci-minimal.yml"
        or canary["status"] != "completed"
        or canary["conclusion"] != "success"
    ):
        raise ValueError("expected successful FastLED/fbuild ci-minimal pull-request canary")

    required_jobs = {"CI selected coverage", "full / Full coverage"}
    successful_jobs = set()
    # 30 per page: on a re-run canary (116 jobs) the API answers
    # `per_page=100` with a deterministic 502 Bad Gateway.
    for page in range(1, 34):
        result = api(
            f"{CANARY_REPO}/actions/runs/{canary_id}/jobs"
            f"?filter=latest&per_page=30&page={page}"
        )
        successful_jobs.update(
            job["name"] for job in result["jobs"]
            if job["status"] == "completed" and job["conclusion"] == "success"
        )
        if required_jobs <= successful_jobs:
            break
        if page * 30 >= result["total_count"]:
            break
    if not required_jobs <= successful_jobs:
        raise ValueError("canary lacks successful selected and full coverage jobs")

    pin = f"zackees/setup-soldr@{target}"
    download = f"Download action repository '{pin}' (SHA:{target})"
    executed = f"Run {pin}"
    texts = []
    # The run-level /logs archive holds only the latest attempt, so a canary
    # whose failed job was re-run would hide the jobs that ran the pin.
    for attempt in range(1, int(canary.get("run_attempt", 1)) + 1):
        logs = api(f"{CANARY_REPO}/actions/runs/{canary_id}/attempts/{attempt}/logs", archive=True)
        if len(logs) > 100_000_000:
            raise ValueError("canary log archive exceeds verification limit")
        with zipfile.ZipFile(io.BytesIO(logs)) as archive:
            texts.extend(
                archive.read(name).decode("utf-8", errors="replace")
                for name in archive.namelist() if name.endswith(".txt")
            )
    if not any(download in text for text in texts) or not any(executed in text for text in texts):
        raise ValueError("canary logs do not prove download and execution of exact action SHA")

    contract = max(contracts, key=lambda run: run["id"])
    print(f"Contract: {contract['html_url']}")
    print(f"Canary: {canary['html_url']}")
    Path(os.environ["RUNNER_TEMP"], "v0-contract-run-id").write_text(str(contract["id"]))
    return contract["id"]


if __name__ == "__main__":
    verify(os.environ["TARGET_SHA"], os.environ["CANARY_RUN_ID"])
