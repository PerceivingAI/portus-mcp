import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadPolicyConfig, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { limitText } from "./outputLimits.js";

const execFileAsync = promisify(execFile);

export type ProcessOutcome = "exited" | "spawn_failed" | "timed_out" | "signaled" | "output_limit";

export type ProcessResult = {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type ProjectCommandResult = ProcessResult & {
  command: string;
  args: string[];
};

export function classifyProcessError(error: unknown, timeoutSecsOrMs: number): {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  stdoutRaw: string;
  stderrRaw: string;
} {
  const timeoutMs = timeoutSecsOrMs <= 3600 ? timeoutSecsOrMs * 1000 : timeoutSecsOrMs;
  const timeoutSecsDisplay = (timeoutMs / 1000).toFixed(1).replace(/\.0$/, "");
  const errObj = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const stdoutRaw = typeof errObj.stdout === "string" ? errObj.stdout : "";
  const stderrRaw = typeof errObj.stderr === "string" ? errObj.stderr : "";
  const codeRaw = errObj.code;
  const signalRaw = typeof errObj.signal === "string" ? errObj.signal : null;
  const killed = errObj.killed === true;
  if (codeRaw === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (typeof errObj.message === "string" && errObj.message.includes("maxBuffer"))) {
    const maxBufferMb = loadPolicyConfig().limits.process.maxOutputBufferMb;
    return {
      outcome: "output_limit",
      exitCode: typeof codeRaw === "number" ? codeRaw : null,
      signal: signalRaw,
      executionError: `Process output exceeded configured buffer limit of ${maxBufferMb} MB`,
      stdoutRaw,
      stderrRaw
    };
  }
  if (killed && (codeRaw === "ETIMEDOUT" || signalRaw === "SIGTERM" || signalRaw === "SIGKILL" || codeRaw === undefined)) {
    return {
      outcome: "timed_out",
      exitCode: typeof codeRaw === "number" ? codeRaw : null,
      signal: signalRaw ?? "SIGTERM",
      executionError: `Command execution timed out after ${timeoutSecsDisplay} seconds`,
      stdoutRaw,
      stderrRaw
    };
  }

  if (codeRaw === "ETIMEDOUT") {
    return {
      outcome: "timed_out",
      exitCode: null,
      signal: signalRaw ?? "SIGTERM",
      executionError: `Command execution timed out after ${timeoutSecsDisplay} seconds`,
      stdoutRaw,
      stderrRaw
    };
  }

  if (typeof codeRaw === "string") {
    const message = typeof errObj.message === "string" ? errObj.message : String(error);
    return {
      outcome: "spawn_failed",
      exitCode: null,
      signal: null,
      executionError: message,
      stdoutRaw,
      stderrRaw
    };
  }

  if (typeof codeRaw === "number") {
    return {
      outcome: "exited",
      exitCode: codeRaw,
      signal: null,
      executionError: null,
      stdoutRaw,
      stderrRaw
    };
  }

  if (signalRaw !== null) {
    return {
      outcome: "signaled",
      exitCode: null,
      signal: signalRaw,
      executionError: null,
      stdoutRaw,
      stderrRaw
    };
  }

  const message = typeof errObj.message === "string" ? errObj.message : String(error);
  return {
    outcome: "spawn_failed",
    exitCode: null,
    signal: null,
    executionError: message,
    stdoutRaw,
    stderrRaw
  };
}

export function limitProcessOutput(classified: {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  stdoutRaw: string;
  stderrRaw: string;
}): ProcessResult {
  const policy = loadPolicyConfig().limits.subagentOutput;
  const stdout = limitText(classified.stdoutRaw, policy.maxStdoutChars);
  const stderr = limitText(classified.stderrRaw, policy.maxStderrChars);
  return {
    outcome: classified.outcome,
    exitCode: classified.exitCode,
    signal: classified.signal,
    executionError: classified.executionError,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated
  };
}

export async function runProjectCommand(
  rootPath: string,
  command: string,
  args: string[],
  timeoutSecsOrMs = 120000,
  shell = false,
  policy: PortusPolicyConfig = loadPolicyConfig()
): Promise<ProjectCommandResult> {
  const maxBuffer = Math.floor(policy.limits.process.maxOutputBufferMb * 1024 * 1024);
  const allowShell = policyPermissions(policy).main_agent.allowShell;

  if (shell && !allowShell) {
    throw new Error("Permission denied: main_agent.allowShell is false");
  }

  const isWin = process.platform === "win32";

  if (!shell && isWin && /\.(cmd|bat)$/i.test(command)) {
    throw new Error("Windows batch scripts (.cmd/.bat) require shell=true or package-script execution");
  }

  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  let execCommand = command;
  let execArgs = args;
  let shellOption = false;

  if (shell) {
    if (isWin) {
      execCommand = "cmd.exe";
      execArgs = ["/c", command, ...args];
      shellOption = false;
    } else {
      shellOption = true;
    }
  }

  const timeoutMs = timeoutSecsOrMs <= 3600 ? timeoutSecsOrMs * 1000 : timeoutSecsOrMs;

  try {
    const result = await execFileAsync(execCommand, execArgs, {
      cwd: rootPath,
      timeout: timeoutMs,
      maxBuffer,
      env,
      shell: shellOption
    });
    const limited = limitProcessOutput({
      outcome: "exited",
      exitCode: 0,
      signal: null,
      executionError: null,
      stdoutRaw: result.stdout,
      stderrRaw: result.stderr
    });
    return { command, args, ...limited };
  } catch (error: unknown) {
    const classified = classifyProcessError(error, timeoutMs);
    const limited = limitProcessOutput(classified);
    return { command, args, ...limited };
  }
}
