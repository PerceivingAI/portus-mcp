import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { limitText } from "./outputLimits.js";

const execFileAsync = promisify(execFile);

export type ProjectCommandResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export async function runProjectCommand(rootPath: string, command: string, args: string[], timeoutSecs = 120): Promise<ProjectCommandResult> {
  const maxBuffer = Math.floor(loadPolicyConfig().limits.process.maxOutputBufferMb * 1024 * 1024);
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  try {
    const result = await execFileAsync(command, args, {
      cwd: rootPath,
      timeout: timeoutSecs * 1000,
      maxBuffer,
      env
    });
    return limitCommandOutput(command, args, 0, result.stdout, result.stderr);
  } catch (error: any) {
    return limitCommandOutput(
      command,
      args,
      typeof error?.code === "number" ? error.code : null,
      error?.stdout ?? "",
      error?.stderr ?? String(error)
    );
  }
}

function limitCommandOutput(command: string, args: string[], exitCode: number | null, stdoutText: string, stderrText: string): ProjectCommandResult {
  const policy = loadPolicyConfig().limits.agentOutput;
  const stdout = limitText(stdoutText, policy.maxStdoutChars);
  const stderr = limitText(stderrText, policy.maxStderrChars);
  return {
    command,
    args,
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated
  };
}
