"""The promotion verifier refuses absent, failed, and wrong-SHA evidence."""

import http.client
import importlib.util
import io
import tempfile
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "v0_promotion", ROOT / "scripts/verify-v0-promotion.py"
)
promotion = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(promotion)
SHA = "a" * 40


def evidence(
    *, contract=True, canary_status="success", pinned_sha=SHA,
    canary_path=".github/workflows/ci-minimal.yml", full_job_status="success"
):
    run = {
        "id": 42,
        "head_sha": SHA,
        "head_branch": "main",
        "status": "completed",
        "conclusion": "success",
        "event": "push",
        "path": ".github/workflows/setup-soldr-contract.yml",
        "repository": {"full_name": "zackees/setup-soldr"},
        "html_url": "https://github.com/zackees/setup-soldr/actions/runs/42",
    }
    canary = {
        "id": 43,
        "repository": {"full_name": "FastLED/fbuild"},
        "status": "completed",
        "conclusion": canary_status,
        "event": "pull_request",
        "path": canary_path,
        "html_url": "https://github.com/FastLED/fbuild/actions/runs/43",
    }
    pin = f"zackees/setup-soldr@{pinned_sha}"
    blob = (
        f"Download action repository '{pin}' (SHA:{pinned_sha})\n"
        f"##[group]Run {pin}\n"
    ).encode()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("job.txt", blob)

    def fake_api(path, *, archive=False):
        if path.endswith("git/ref/heads/main"):
            return {"object": {"sha": SHA}}
        if "/workflows/" in path:
            return {"workflow_runs": [run] if contract else []}
        if "/jobs?" in path:
            return {
                "total_count": 2,
                "jobs": [
                    {"name": "CI selected coverage", "status": "completed", "conclusion": "success"},
                    {"name": "full / Full coverage", "status": "completed", "conclusion": full_job_status},
                ],
            }
        if path.endswith("/logs"):
            return stream.getvalue()
        return canary

    return fake_api


@pytest.mark.parametrize(
    "api,error",
    [
        (evidence(contract=False), "no successful Setup Soldr Contract"),
        (evidence(canary_status="failure"), "expected successful"),
        (evidence(canary_status="cancelled"), "expected successful"),
        (evidence(canary_path=".github/workflows/trivial.yml"), "expected successful"),
        (evidence(full_job_status="skipped"), "lacks successful"),
        (evidence(pinned_sha="b" * 40), "do not prove"),
    ],
)
def test_bad_evidence_fails_closed(api, error):
    with tempfile.TemporaryDirectory() as runner_temp:
        with patch.object(promotion, "api", api), patch.object(
            promotion.subprocess, "check_output", return_value=SHA
        ), patch.dict(promotion.os.environ, {"RUNNER_TEMP": runner_temp}):
            with pytest.raises(ValueError, match=error):
                promotion.verify(SHA, "43")


def test_exact_sha_success_returns_contract_run():
    with tempfile.TemporaryDirectory() as runner_temp:
        with patch.object(promotion, "api", evidence()), patch.object(
            promotion.subprocess, "check_output", return_value=SHA
        ), patch.dict(promotion.os.environ, {"RUNNER_TEMP": runner_temp}):
            assert promotion.verify(SHA, "43") == 42
            assert Path(runner_temp, "v0-contract-run-id").read_text() == "42"


def test_incomplete_archive_read_retries_with_bounded_backoff():
    class Response:
        def __init__(self, result):
            self.result = result

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

    results = iter([http.client.IncompleteRead(b"partial"), http.client.IncompleteRead(b"partial"), b"zip"])
    with patch.dict(promotion.os.environ, {"GH_TOKEN": "test"}), patch.object(
        promotion.urllib.request, "urlopen", side_effect=lambda *_args, **_kwargs: Response(next(results))
    ) as urlopen, patch.object(promotion.time, "sleep") as sleep:
        assert promotion.api("FastLED/fbuild/actions/runs/43/logs", archive=True) == b"zip"
    assert urlopen.call_count == 3
    assert [call.args[0] for call in sleep.call_args_list] == [1, 2]


def test_archive_retry_exhaustion_and_metadata_read_fail_closed():
    class BrokenResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            raise http.client.IncompleteRead(b"partial")

    with patch.dict(promotion.os.environ, {"GH_TOKEN": "test"}), patch.object(
        promotion.urllib.request, "urlopen", return_value=BrokenResponse()
    ) as urlopen, patch.object(promotion.time, "sleep") as sleep:
        with pytest.raises(http.client.IncompleteRead):
            promotion.api("FastLED/fbuild/actions/runs/43/logs", archive=True)
        assert urlopen.call_count == 4
        assert [call.args[0] for call in sleep.call_args_list] == [1, 2, 4]
        urlopen.reset_mock()
        sleep.reset_mock()
        with pytest.raises(http.client.IncompleteRead):
            promotion.api("zackees/setup-soldr/git/ref/heads/main")
        assert urlopen.call_count == 4
        assert [call.args[0] for call in sleep.call_args_list] == [1, 2, 4]


def test_transport_error_and_5xx_retry_but_4xx_does_not():
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b"complete"

    with patch.dict(promotion.os.environ, {"GH_TOKEN": "test"}), patch.object(
        promotion.urllib.request, "urlopen",
        side_effect=[urllib.error.URLError("connection dropped"), Response()],
    ) as urlopen, patch.object(promotion.time, "sleep") as sleep:
        assert promotion.api("FastLED/fbuild/actions/runs/43/logs", archive=True) == b"complete"
        assert urlopen.call_count == 2
        sleep.assert_called_once_with(1)

    error = urllib.error.HTTPError("https://example.com", 404, "missing", {}, None)
    with patch.dict(promotion.os.environ, {"GH_TOKEN": "test"}), patch.object(
        promotion.urllib.request, "urlopen", side_effect=error,
    ) as urlopen, patch.object(promotion.time, "sleep") as sleep:
        with pytest.raises(urllib.error.HTTPError):
            promotion.api("FastLED/fbuild/actions/runs/43/logs", archive=True)
        assert urlopen.call_count == 1
        sleep.assert_not_called()


def test_gateway_502_retries_on_metadata_calls():
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"ok": true}'

    bad_gateway = urllib.error.HTTPError("https://example.com", 502, "Bad Gateway", {}, None)
    with patch.dict(promotion.os.environ, {"GH_TOKEN": "test"}), patch.object(
        promotion.urllib.request, "urlopen", side_effect=[bad_gateway, Response()],
    ) as urlopen, patch.object(promotion.time, "sleep") as sleep:
        assert promotion.api("FastLED/fbuild/actions/runs/43/jobs") == {"ok": True}
        assert urlopen.call_count == 2
        sleep.assert_called_once_with(1)
