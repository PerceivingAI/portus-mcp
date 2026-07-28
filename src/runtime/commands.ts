import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";
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

export async function runProjectCommand(rootPath: string, command: string, args: string[], timeoutSecs = 120, projectAlias?: string): Promise<ProjectCommandResult> {
  const maxBuffer = Math.floor(loadPolicyConfig().limits.process.maxOutputBufferMb * 1024 * 1024);
  const useShell = projectAlias ? getEffectivePermissions(projectAlias).chatgpt.useShell : false;
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const isWin = process.platform === "win32";
  const execCommand = isWin && useShell ? "cmd.exe" : command;
  const execArgs = isWin && useShell ? ["/c", command, ...args] : args;
  const shellOption = isWin ? false : useShell;

  try {
    const result = await execFileAsync(execCommand, execArgs, {
      cwd: rootPath,
      timeout: timeoutSecs * 1000,
      maxBuffer,
      env,
      shell: shellOption
    });
    return limitCommandOutput(command, args, 0, result.stdout, result.stderr);
  } catch (error: unknown) {
    const errObj = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const stderrRaw = typeof errObj.stderr === "string" ? errObj.stderr : "";
    const messageRaw = typeof errObj.message === "string" ? errObj.message : String(error);
    const stderrText = stderrRaw.trim() !== "" ? stderrRaw : messageRaw;
    const stdoutText = typeof errObj.stdout === "string" ? errObj.stdout : "";
    const exitCode = typeof errObj.code === "number" ? errObj.code : null;
    return limitCommandOutput(
      command,
      args,
      exitCode,
      stdoutText,
      stderrText
    );
  }
}

function limitCommandOutput(command: string, args: string[], exitCode: number | null, stdoutText: string, stderrText: string): ProjectCommandResult {
  const policy = loadPolicyConfig().limits.subagentOutput;
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
