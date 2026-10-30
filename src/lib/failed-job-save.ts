// setup-soldr#559: a job that did not succeed does not save its build outputs.
//
// The post step runs on failure too (`post-if: always()`, for the daemon
// shutdown). It used to save the build-cache store regardless, so a failed
// build -- disk full under `bosn ci`, a compile error, a cancel -- saved a
// partial store under the run's key. The next run got an exact hit on it and,
// being an exact hit, never re-saved: the key stayed poisoned until it
// changed. Like `actions/cache` (`post-if: success()`), a job that failed or
// was cancelled now skips the build-output layers (build-cache and
// target-cache). Toolchain and registry layers are unaffected: their content
// is a verified install, not a half-finished build.
//
// The job status comes from the `job-status` input, which the workflow sets
// to `${{ job.status }}` (an action's own input default cannot read the `job`
// context). The runner re-evaluates a step's `with:` inputs for its post step,
// so the post step sees the job's status at the end of its steps. An empty
// status (the default) keeps the old always-save behaviour, as does
// `save-on-failure: true`.
//
// setup-soldr#626 splits the layers in two. Output layers (build-cache,
// target-cache, the cook delta) hold what the failing build produced and are
// refused on `failure` and `cancelled`, as above. Dependency layers (cook
// base, cargo registry, toolchain) are finalized before the first workspace
// compile, so a failing test or lint cannot corrupt them: a `failure` keeps
// saving them, otherwise a lane that fails deterministically never warms.
// A `cancelled` job may have been interrupted inside the dependency phase
// itself, so it saves nothing: `save-policy.ts`'s shared gate applies the
// dependency rule to every layer.

import { readRawInputs } from "./raw-inputs.js";

/** Save status recorded when a failed or cancelled job skips the save. */
export const FAILED_JOB_SKIP_STATUS = "failed-job-skip" as const;

export interface BuildOutputSaveDecision {
  save: boolean;
  reason: string;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["", "0", "false", "no", "off"]);
const NOT_SUCCEEDED = new Set(["failure", "cancelled"]);

export function decideBuildOutputSave(input: { jobStatus: string; saveOnFailure: string }): BuildOutputSaveDecision {
  const status = input.jobStatus.trim().toLowerCase();
  const raw = input.saveOnFailure.trim().toLowerCase();
  if (!TRUTHY.has(raw) && !FALSY.has(raw)) {
    throw new Error(`save-on-failure must be true or false (got '${input.saveOnFailure}')`);
  }
  if (!NOT_SUCCEEDED.has(status)) {
    return { save: true, reason: `job status ${status || "unknown"}` };
  }
  if (TRUTHY.has(raw)) return { save: true, reason: `job status ${status}, save-on-failure=true` };
  return { save: false, reason: `job status ${status} (set save-on-failure: true to save anyway)` };
}

/** The gate as the post step sees it, from its re-evaluated inputs. */
export function readBuildOutputSaveGate(env: Record<string, string | undefined>): BuildOutputSaveDecision {
  const raw = readRawInputs(env);
  return decideBuildOutputSave({ jobStatus: raw.jobStatus, saveOnFailure: raw.saveOnFailure });
}

export type LayerSaveClass = "dependency" | "output";

/** #626: the job-status decision for one class of layer. */
export function decideLayerSave(
  input: { jobStatus: string; saveOnFailure: string },
  kind: LayerSaveClass,
): BuildOutputSaveDecision {
  const output = decideBuildOutputSave(input);
  if (kind === "output" || output.save) return output;
  const status = input.jobStatus.trim().toLowerCase();
  if (status === "failure") {
    return { save: true, reason: "job status failure (dependency layer, finalized before the workspace build)" };
  }
  return output;
}

/** #626: the dependency-layer gate from the step's inputs. */
export function readDependencyLayerSaveGate(env: Record<string, string | undefined>): BuildOutputSaveDecision {
  const raw = readRawInputs(env);
  return decideLayerSave({ jobStatus: raw.jobStatus, saveOnFailure: raw.saveOnFailure }, "dependency");
}
