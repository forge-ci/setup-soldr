import * as core from "@actions/core";
import * as fs from "node:fs";
import {
  saveCookCache,
  saveLayeredCookCache,
} from "./lib/cook-cache.js";

function state(name: string): string {
  return core.getState(`deferredCook${name}`);
}

function stateBool(name: string): boolean {
  return state(name) === "true";
}

async function main(): Promise<void> {
  if (!stateBool("Enabled")) {
    core.info("cook-cache: post-step disabled - skipping save");
    return;
  }
  if (!stateBool("SaveCache")) {
    core.info("cook-cache: save disabled by save-cache policy - skipping save");
    return;
  }
  const ran = stateBool("Ran");
  const targetDir = state("TargetDir");
  const failOnError = stateBool("FailOnError");
  if (!ran) {
    core.info("cook-cache: cook did not run successfully - skipping save");
    return;
  }
  if (!targetDir || !fs.existsSync(targetDir)) {
    const message = `cook-cache: target dir ${targetDir || "(empty)"} missing - skipping save`;
    if (failOnError) throw new Error(message);
    core.info(message);
    return;
  }

  if (stateBool("Layered")) {
    const saveLayer = state("SaveLayer") || "none";
    if (saveLayer === "none") {
      core.info("cook-cache: layered cache warm or cook did not run successfully - skipping save");
      return;
    }
    const projectRoot = state("ProjectRoot");
    if (!projectRoot || !fs.existsSync(projectRoot)) {
      const message = `cook-cache: project root ${projectRoot || "(empty)"} missing - skipping save`;
      if (failOnError) throw new Error(message);
      core.info(message);
      return;
    }
    const saveKey = saveLayer === "delta" ? state("DeltaExactKey") : state("BaseExactKey");
    const archivePath = saveLayer === "delta" ? state("DeltaArchive") : state("BaseArchive");
    const zstdLevel = saveLayer === "delta"
      ? state("DeltaCompressLevel") || "3"
      : state("BaseCompressLevel") || "9";
    const saveResult = await saveLayeredCookCache({
      soldrBinary: state("SoldrBinary") || process.env["SOLDR_BINARY"]?.trim() || "soldr",
      projectRoot,
      targetDir,
      exactKey: saveKey,
      archivePath,
      layer: saveLayer === "delta" ? "delta" : "base",
      zstdLevel,
      baseManifestPath: state("BaseManifest"),
      log: (msg) => core.info(msg),
    });
    core.info(`cook-cache-${saveLayer}: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
    if (saveResult.status === "failed" && failOnError) {
      throw new Error(`cook-cache-${saveLayer}: save failed: ${saveResult.error ?? "unknown error"}`);
    }
    return;
  }

  const saveResult = await saveCookCache({
    targetDir,
    exactKey: state("ExactKey"),
    level: state("CompressLevel") || "9",
    longWindow: 27,
    debug: stateBool("Debug"),
    log: (msg) => core.info(msg),
  });
  core.info(`cook-cache: save status=${saveResult.status} error=${saveResult.error ?? "none"}`);
  if (saveResult.status === "failed" && failOnError) {
    throw new Error(`cook-cache: save failed: ${saveResult.error ?? "unknown error"}`);
  }
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
