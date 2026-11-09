import { execFileSync } from "node:child_process";
import * as core from "@actions/core";

type Reporter = Pick<typeof core, "warning" | "setFailed" | "debug">;
type Git = (args: string[], input?: string) => string;
const git: Git = (args, input) => execFileSync("git", args, {
  input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000,
});

export function countAttestations(trailers: string): number {
  return trailers.split(/\r?\n/).filter((line) => {
    const match = /^Ci-Attestation:\s*(.*)$/i.exec(line);
    if (!match) return false;
    try {
      const value: unknown = JSON.parse(match[1] ?? "");
      return value !== null && typeof value === "object" && !Array.isArray(value)
        && (value as { v?: unknown }).v === 1;
    } catch {
      return false;
    }
  }).length;
}

export function checkRequiredAttestation(
  env: NodeJS.ProcessEnv = process.env,
  reporter: Reporter = core,
  runGit: Git = git,
): void {
  // GitHub preserves hyphens in INPUT_ names; INPUT_REQUIRED_ATTESTATION is wrong.
  const mode = env["INPUT_REQUIRED-ATTESTATION"] ?? "off";
  if (mode === "off") return;
  if (mode !== "warn" && mode !== "enforce") {
    reporter.warning(`Unknown required-attestation value ${JSON.stringify(mode)}; behaving as off.`);
    return;
  }
  const sha = env.GITHUB_SHA || "HEAD";
  let count: number;
  try {
    const message = runGit(["show", "-s", "--format=%B", sha, "--"]);
    if (!message.trim()) {
      reporter.debug("required-attestation: commit message unavailable; behaving as off.");
      return;
    }
    count = countAttestations(runGit(["interpret-trailers", "--parse"], message));
  } catch {
    reporter.debug("required-attestation: git read failed; behaving as off.");
    return;
  }
  if (count > 0) return;
  const message = `${count} Ci-Attestation trailer(s) found for ${sha}. Run ./push (it runs 'soldr lint rust --attest' and stamps the commit) so CI can skip the work the client already did.`;
  if (mode === "warn") reporter.warning(message);
  else reporter.setFailed(message);
}
