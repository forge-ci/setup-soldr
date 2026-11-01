"""Aggregate merge gate: fail when any job of this run attempt did not succeed.

    python3 ci/ci_summary.py

Runs as the `CI summary` job of `Setup Soldr Contract` on pull_request and
merge_group (GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, a GH_TOKEN
with actions: read). It reads the attempt's full job list from the API rather
than `needs.*.result`, because a job reached through a reusable workflow can
end `cancelled` while its caller reports success.

Exempt jobs (by exact name, never by pattern):
  - CI summary                    this job; it is still running.
  - Cancel superseded queue runs  housekeeping; cancels other runs, not code.
  - End-of-queue cache janitor    cache writer that runs alongside this gate.
"""

from __future__ import annotations

import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SELF = "CI summary"
EXEMPT = frozenset({SELF, "Cancel superseded queue runs", "End-of-queue cache janitor"})
BLOCKING = frozenset({"failure", "cancelled", "timed_out", "startup_failure", "action_required"})
ATTEMPTS = 6


def get(url: str) -> tuple[dict, str]:
    """GET with retries on rate limits, 5xx and network errors."""
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response), response.headers.get("Link", "")
        except HTTPError as error:
            if (error.code not in (403, 429) and error.code < 500) or attempt == ATTEMPTS:
                raise
            reason = f"HTTP {error.code}"
        except URLError as error:
            if attempt == ATTEMPTS:
                raise
            reason = str(error.reason)
        delay = min(60, 5 * 2 ** (attempt - 1))
        print(f"job list call failed ({reason}); retry {attempt}/{ATTEMPTS - 1} in {delay}s")
        time.sleep(delay)
    raise AssertionError("unreachable")


def next_link(link: str) -> str | None:
    for part in link.split(","):
        url, _, rel = part.partition(";")
        if 'rel="next"' in rel:
            return url.strip().strip("<>")
    return None


def jobs() -> list[dict]:
    repo = os.environ["GITHUB_REPOSITORY"]
    run_id = os.environ["GITHUB_RUN_ID"]
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    url: str | None = (
        f"https://api.github.com/repos/{repo}/actions/runs/{run_id}"
        f"/attempts/{attempt}/jobs?per_page=100"
    )
    found: list[dict] = []
    while url:
        page, link = get(url)
        found.extend(page["jobs"])
        url = next_link(link)
    return found


def blockers(job_list: list[dict]) -> list[tuple[str, str]]:
    """(name, reason) for every non-exempt job that blocks the gate."""
    blocked = []
    for job in job_list:
        name = job["name"]
        if name in EXEMPT:
            continue
        conclusion = job.get("conclusion")
        if conclusion in BLOCKING:
            blocked.append((name, conclusion))
        elif conclusion is None:
            blocked.append((name, f"not finished ({job.get('status')})"))
    return blocked


def main() -> int:
    job_list = jobs()
    for job in job_list:
        tag = " (exempt)" if job["name"] in EXEMPT else ""
        print(f"{job.get('conclusion') or job.get('status')}: {job['name']}{tag}")
    blocked = blockers(job_list)
    if blocked:
        print(f"\n{SELF}: {len(blocked)} job(s) blocked the gate:")
        for name, reason in blocked:
            print(f"::error::{name}: {reason}")
        return 1
    print(f"\n{SELF}: all {len(job_list)} jobs passed or are exempt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
