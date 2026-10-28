"""Public-contract tests for the reusable release lane."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "release-lane.yml"
SMOKE_PATH = REPO_ROOT / ".github" / "workflows" / "release-lane-smoke.yml"
METADATA_PATH = REPO_ROOT / "scripts" / "write-release-metadata.mjs"
RESOLVER_PATH = REPO_ROOT / "scripts" / "resolve-release-artifacts.py"
README_PATH = REPO_ROOT / "README.md"


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _triggers(workflow: dict) -> dict:
    return workflow.get("on") or workflow.get(True)


def _step(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def test_release_lane_has_the_strict_public_interface() -> None:
    workflow = _load(WORKFLOW_PATH)
    call = _triggers(workflow)["workflow_call"]
    inputs = call["inputs"]

    assert set(inputs) == {
        "target",
        "working-directory",
        "package",
        "bin",
        "features",
        "no-default-features",
        "locked",
        "cache",
        "artifact-paths",
        "artifact-name",
        "retention-days",
    }
    assert inputs["target"]["required"] is True
    assert inputs["artifact-paths"]["required"] is True
    assert inputs["working-directory"]["default"] == "."
    assert inputs["locked"]["default"] is True
    assert inputs["cache"]["default"] is False
    assert inputs["artifact-name"]["default"] == "soldr-release"
    assert inputs["retention-days"]["default"] == 14
    assert set(call["outputs"]) == {
        "artifact-name",
        "prepared-target",
        "soldr-version",
        "target-cache-identity",
        "target-plan-json",
        "release-metadata-path",
    }


def test_release_lane_uses_soldr_capabilities_and_safe_release_arguments() -> None:
    workflow = _load(WORKFLOW_PATH)
    job = workflow["jobs"]["release"]
    assert job["runs-on"] == "ubuntu-24.04"
    assert job["outputs"]["prepared-target"] == "${{ steps.setup-soldr.outputs.prepared-target }}"
    assert job["outputs"]["soldr-version"] == "${{ steps.setup-soldr.outputs.soldr-version }}"
    assert job["outputs"]["target-plan-json"] == "${{ steps.setup-soldr.outputs.target-plan-json }}"

    setup = _step(job, "Setup Soldr release target")
    assert setup["uses"] == "./.setup-soldr-release-workflow"
    assert setup["with"]["cross-targets"] == "${{ inputs.target }}"
    assert setup["with"]["cache"] == "${{ inputs.cache }}"
    assert setup["with"]["build-cache"] == "${{ inputs.cache }}"
    assert setup["with"]["target-cache"] is False
    assert setup["with"]["cargo-registry-cache"] is False
    assert setup["with"]["solo-toolchain-cache"] == "${{ inputs.cache }}"
    assert setup["with"]["soldr-mini-cache"] == "${{ inputs.cache }}"
    assert setup["with"]["prebuild-deps"] == "none"
    assert "cross-tool" not in setup["with"]

    source = _step(job, "Resolve reusable workflow source")
    assert "toJSON(job)" in source["env"]["JOB_CONTEXT_JSON"]
    assert "workflow_repository" in source["run"]
    assert "workflow_sha" in source["run"]
    helpers = _step(job, "Checkout release workflow helpers")
    assert helpers["with"]["repository"] == "${{ steps.workflow-source.outputs.repository }}"
    assert helpers["with"]["ref"] == "${{ steps.workflow-source.outputs.sha }}"

    capability = _step(job, "Assert build capability")
    assert "target-capabilities-json" in capability["env"]["CAPABILITIES_JSON"]
    assert "supportedOperations" in capability["run"]
    assert "build" in capability["run"]

    build = _step(job, "Build release through Soldr")
    script = build["run"]
    assert build["working-directory"] == "${{ inputs.working-directory }}"
    assert "args=(build --target \"$TARGET\" --release)" in script
    assert "args+=(--locked)" in script
    assert "args+=(--package \"$PACKAGE\")" in script
    assert "args+=(--bin \"$BIN\")" in script
    assert "args+=(--features \"$FEATURES\")" in script
    assert "args+=(--no-default-features)" in script
    assert 'soldr "${args[@]}"' in script
    assert "eval" not in script


def test_release_lane_validates_allowlisted_artifacts_and_writes_provenance() -> None:
    workflow = _load(WORKFLOW_PATH)
    job = workflow["jobs"]["release"]
    text = WORKFLOW_PATH.read_text(encoding="utf-8")

    validate = _step(job, "Resolve required release artifacts")
    assert validate["id"] == "artifacts"
    assert "artifact-paths" in validate["env"]["ARTIFACT_PATHS"]
    assert "scripts/resolve-release-artifacts.py" in validate["run"]
    resolver = RESOLVER_PATH.read_text(encoding="utf-8")
    assert "No release artifacts matched" in resolver
    assert "secrets.token_hex" in resolver
    assert "cannot be uploaded safely" in resolver
    assert "target/" not in _step(job, "Upload release artifact")["with"]["path"]

    upload = _step(job, "Upload release artifact")
    assert upload["uses"] == "actions/upload-artifact@v4"
    assert upload["with"]["if-no-files-found"] == "error"
    assert upload["with"]["name"] == "${{ steps.artifacts.outputs.artifact-name }}"
    assert upload["with"]["retention-days"] == "${{ inputs.retention-days }}"
    assert "release-metadata.json" in _step(job, "Write release metadata")["env"]["METADATA_PATH"]
    assert ".setup-soldr-release/" not in _step(job, "Write release metadata")["env"]["METADATA_PATH"]
    assert "steps.artifacts.outputs.resolved-paths" in upload["with"]["path"]

    metadata = _step(job, "Write release metadata")
    assert "scripts/write-release-metadata.mjs" in metadata["run"]
    assert "target-plan-json" in text
    assert "target-cache-identity" in text

    source = METADATA_PATH.read_text(encoding="utf-8")
    for field in (
        "schema_version",
        "repository",
        "commit_sha",
        "ref",
        "target",
        "soldr_version",
        "target_cache_identity",
        "operations",
        "arguments",
        "cache_enabled",
        "cache_contract",
        "artifact_paths",
    ):
        assert field in source


def test_release_lane_smoke_builds_downloads_and_executes_exact_artifact() -> None:
    workflow = _load(SMOKE_PATH)
    triggers = _triggers(workflow)
    assert "pull_request" in triggers
    assert "workflow_dispatch" in triggers
    assert "scripts/resolve-release-artifacts.py" in triggers["pull_request"]["paths"]

    call = workflow["jobs"]["build-musl"]
    assert call["uses"] == "./.github/workflows/release-lane.yml"
    assert call["with"]["target"] == "x86_64-unknown-linux-musl"
    assert call["with"]["cache"] is False
    assert call["with"]["artifact-paths"] == "target/x86_64-unknown-linux-musl/release/release-lane-smoke"

    verify = workflow["jobs"]["verify-musl"]
    assert verify["needs"] == "build-musl"
    download = _step(verify, "Download exact release artifact")
    assert download["uses"] == "actions/download-artifact@v4"
    assert download["with"]["name"] == "${{ needs.build-musl.outputs.artifact-name }}"
    script = _step(verify, "Validate metadata and execute release")["run"]
    assert "cache_enabled" in script
    assert "managed_restore_enabled" in script
    assert "managed_save_enabled" in script
    assert "github.sha" in _step(verify, "Validate metadata and execute release")["env"]["EXPECTED_SHA"]
    assert "release lane smoke" in script

    contract = workflow["jobs"]["windows-msvc-contract"]
    assert contract["runs-on"] == "ubuntu-24.04"
    resolve = _step(contract, "Resolve Windows artifact contract")
    assert "scripts/resolve-release-artifacts.py" in resolve["run"]
    assert resolve["env"]["PREPARED_TARGET"] == "x86_64-pc-windows-msvc"
    assert resolve["env"]["ARTIFACT_PATHS"].endswith("release-lane-smoke.exe")
    assert "steps.resolve.outputs.artifact-name" in _step(contract, "Assert Windows artifact contract")["env"]["ARTIFACT_NAME"]


def test_release_lane_documentation_is_copy_pasteable_and_explicit() -> None:
    readme = README_PATH.read_text(encoding="utf-8")
    assert "uses: zackees/setup-soldr/.github/workflows/release-lane.yml@v0" in readme
    assert "artifact-paths:" in readme
    assert "cache is disabled by default" in readme.lower()
    assert "actions/download-artifact@v4" in readme
    assert "run the artifact on a compatible native runner" in readme.lower()


def test_metadata_writer_records_exact_release_provenance(tmp_path: Path) -> None:
    output = tmp_path / "release-metadata.json"
    env = {
        **os.environ,
        "METADATA_PATH": str(output),
        "REPOSITORY": "owner/project",
        "COMMIT_SHA": "a" * 40,
        "GIT_REF": "refs/heads/release",
        "TARGET": "x86_64-unknown-linux-musl",
        "SOLDR_VERSION": "0.8.39",
        "TARGET_CACHE_IDENTITY": "plan-v1-example",
        "CAPABILITIES_JSON": json.dumps(
            {"supportedOperations": ["prepare", "build"]}
        ),
        "ARGUMENTS_JSON": json.dumps(
            [
                "build",
                "--target",
                "x86_64-unknown-linux-musl",
                "--release",
                "--locked",
            ]
        ),
        "CACHE_ENABLED": "false",
        "CACHE_CONTRACT_JSON": json.dumps(
            {
                "managed_restore_enabled": False,
                "managed_save_enabled": False,
                "build_runtime_mode": "off",
                "target_cache_mode": "off",
            }
        ),
        "ARTIFACT_PATHS_JSON": json.dumps(
            ["target/x86_64-unknown-linux-musl/release/example"]
        ),
    }

    subprocess.run(["node", str(METADATA_PATH)], check=True, env=env)
    metadata = json.loads(output.read_text(encoding="utf-8"))
    assert metadata == {
        "schema_version": 1,
        "repository": "owner/project",
        "commit_sha": "a" * 40,
        "ref": "refs/heads/release",
        "target": "x86_64-unknown-linux-musl",
        "soldr_version": "0.8.39",
        "target_cache_identity": "plan-v1-example",
        "operations": ["prepare", "build"],
        "arguments": [
            "build",
            "--target",
            "x86_64-unknown-linux-musl",
            "--release",
            "--locked",
        ],
        "cache_enabled": False,
        "cache_contract": {
            "managed_restore_enabled": False,
            "managed_save_enabled": False,
            "build_runtime_mode": "off",
            "target_cache_mode": "off",
        },
        "artifact_paths": ["target/x86_64-unknown-linux-musl/release/example"],
    }


def test_artifact_resolver_uses_actual_windows_path_and_rejects_output_injection(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    working = workspace / "crate"
    artifact = working / "target" / "x86_64-pc-windows-msvc" / "release" / "app.exe"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(b"PE contract fixture")
    output = tmp_path / "github-output"
    output.write_text("", encoding="utf-8")
    env = {
        **os.environ,
        "GITHUB_WORKSPACE": str(workspace),
        "GITHUB_OUTPUT": str(output),
        "WORKING_DIRECTORY": "crate",
        "ARTIFACT_PREFIX": "soldr-release",
        "PREPARED_TARGET": "x86_64-pc-windows-msvc",
        "ARTIFACT_PATHS": "target/x86_64-pc-windows-msvc/release/app.exe",
    }

    subprocess.run(["python", str(RESOLVER_PATH)], check=True, env=env)
    contents = output.read_text(encoding="utf-8")
    assert "artifact-name=soldr-release-x86_64-pc-windows-msvc\n" in contents
    assert "SETUP_SOLDR_RELEASE_PATHS_" in contents
    assert 'resolved-json=["crate/target/x86_64-pc-windows-msvc/release/app.exe"]' in contents

    output.write_text("", encoding="utf-8")
    env["ARTIFACT_PREFIX"] = "release\ninjected=true"
    rejected = subprocess.run(
        ["python", str(RESOLVER_PATH)],
        check=False,
        env=env,
        capture_output=True,
        text=True,
    )
    assert rejected.returncode != 0
    assert output.read_text(encoding="utf-8") == ""
