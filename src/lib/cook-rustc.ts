import { ToolRunner } from "@actions/exec/lib/toolrunner.js";

export async function captureCookCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await new ToolRunner(command, args, {
    cwd,
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => { stdout += data.toString("utf8"); },
      stderr: (data: Buffer) => { stderr += data.toString("utf8"); },
    },
  }).exec();
  return { code, stdout, stderr };
}

/** Resolve the cache-key compiler release in the workspace used by cook. */
export async function resolveCookRustcRelease(
  soldrPath: string,
  workspace: string,
  capture: typeof captureCookCommand,
  warn: (message: string) => void,
): Promise<string> {
  const result = await capture(soldrPath, ["rustc", "--version"], workspace);
  if (result.code !== 0) {
    warn(`cook: soldr rustc --version failed with exit ${result.code}: ${result.stderr.trim()}`);
    return "unresolved";
  }
  const match = /^rustc\s+(\S+)/.exec(result.stdout.trim());
  return match?.[1] ?? (result.stdout.trim() || "unresolved");
}
