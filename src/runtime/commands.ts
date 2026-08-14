import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { loadPolicyConfig, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { limitText } from "./outputLimits.js";
import { terminateProcessTree, type ProcessTreeTerminationResult, type ProcessLifecycle } from "./processTermination.js";

const PROJECT_RUN_ESCALATION_DELAY_MS = 1200;
const PROJECT_RUN_FORCED_CLOSE_GRACE_MS = 8000;

export type ProcessOutcome = "exited" | "spawn_failed" | "timed_out" | "signaled" | "output_limit";

export type ProcessResult = {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  effectiveTimeoutMs: number;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  truncated: boolean;
  lifecycle: ProcessLifecycle;
};

export type ProjectCommandResult = ProcessResult & {
  command: string;
  args: string[];
};

type RawProcessResult = {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  effectiveTimeoutMs: number;
  elapsedMs: number;
  stdoutRaw: string;
  stderrRaw: string;
  stdoutCaptureTruncated: boolean;
  stderrCaptureTruncated: boolean;
  lifecycle: ProcessLifecycle;
};

type CapturedProcessOptions = {
  rootPath: string;
  command: string;
  args: string[];
  timeoutMs: number;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  policy?: PortusPolicyConfig;
};

type TerminalCause = "timed_out" | "output_limit";

type StreamCapture = {
  decoder: StringDecoder;
  chunks: string[];
  bytes: number;
  ended: boolean;
  captureTruncated: boolean;
};

function safeProcessError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 2000) || "Process execution failed";
}

function finishCapture(capture: StreamCapture): void {
  if (capture.ended) return;
  capture.ended = true;
  const finalText = capture.decoder.end();
  if (finalText !== "") capture.chunks.push(finalText);
}

function limitProcessOutput(raw: RawProcessResult, policy: PortusPolicyConfig): ProcessResult {
  const outputPolicy = policy.limits.subagentOutput;
  const stdout = limitText(raw.stdoutRaw, outputPolicy.maxStdoutChars);
  const stderr = limitText(raw.stderrRaw, outputPolicy.maxStderrChars);
  const stdoutTruncated = raw.stdoutCaptureTruncated || stdout.truncated;
  const stderrTruncated = raw.stderrCaptureTruncated || stderr.truncated;
  return {
    outcome: raw.outcome,
    exitCode: raw.exitCode,
    signal: raw.signal,
    executionError: raw.executionError,
    effectiveTimeoutMs: raw.effectiveTimeoutMs,
    elapsedMs: raw.elapsedMs,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated,
    stderrTruncated,
    truncated: stdoutTruncated || stderrTruncated,
    lifecycle: raw.lifecycle
  };
}

export async function runCapturedProcess(options: CapturedProcessOptions): Promise<ProcessResult> {
  const policy = options.policy ?? loadPolicyConfig();
  const maxBufferBytes = Math.floor(policy.limits.process.maxOutputBufferMb * 1024 * 1024);
  const startedAt = performance.now();
  const stdoutCapture: StreamCapture = { decoder: new StringDecoder("utf8"), chunks: [], bytes: 0, ended: false, captureTruncated: false };
  const stderrCapture: StreamCapture = { decoder: new StringDecoder("utf8"), chunks: [], bytes: 0, ended: false, captureTruncated: false };
  let child: ChildProcess;

  try {
    child = spawn(options.command, options.args, {
      cwd: options.rootPath,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      detached: process.platform !== "win32",
      windowsHide: true
    });
  } catch (error) {
    return limitProcessOutput({
      outcome: "spawn_failed",
      exitCode: null,
      signal: null,
      executionError: safeProcessError(error),
      effectiveTimeoutMs: options.timeoutMs,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      stdoutRaw: "",
      stderrRaw: "",
      stdoutCaptureTruncated: false,
      stderrCaptureTruncated: false,
      lifecycle: {
        processStarted: false,
        processExited: false,
        killAttempted: false,
        killSucceeded: false,
        waitAttempted: false,
        reaped: false
      }
    }, policy);
  }

  const terminationEvents = new EventEmitter();
  let terminalCause: TerminalCause | null = null;
  let terminationPromise: Promise<ProcessTreeTerminationResult> | undefined;
  let termination: ProcessTreeTerminationResult | undefined;
  let childError: unknown;

  const requestTermination = (cause: TerminalCause): void => {
    if (terminalCause === null) terminalCause = cause;
    if (terminationPromise) return;
    terminationPromise = terminateProcessTree(child, {
      escalationDelayMs: PROJECT_RUN_ESCALATION_DELAY_MS,
      forcedCloseGraceMs: PROJECT_RUN_FORCED_CLOSE_GRACE_MS
    }).then((result) => {
      termination = result;
      terminationEvents.emit("complete");
      return result;
    });
    void terminationPromise.catch((error) => {
      termination = {
        attempted: true,
        scope: "process_tree",
        method: process.platform === "win32" ? "taskkill_tree" : "process_group",
        confirmed: false,
        childCloseObserved: false,
        error: safeProcessError(error)
      };
      terminationEvents.emit("complete");
    });
  };

  const appendChunk = (capture: StreamCapture, value: Buffer | string): void => {
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    const remaining = Math.max(0, maxBufferBytes - capture.bytes);
    const retained = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
    if (retained.length > 0) {
      const text = capture.decoder.write(retained);
      if (text !== "") capture.chunks.push(text);
      capture.bytes += retained.length;
    }
    if (retained.length !== chunk.length) {
      capture.captureTruncated = true;
      requestTermination("output_limit");
    }
  };

  const onStdoutData = (chunk: Buffer | string) => appendChunk(stdoutCapture, chunk);
  const onStderrData = (chunk: Buffer | string) => appendChunk(stderrCapture, chunk);
  const onChildError = (error: unknown) => {
    childError = error;
  };
  child.stdout?.on("data", onStdoutData);
  child.stderr?.on("data", onStderrData);
  child.stdout?.once("end", () => finishCapture(stdoutCapture));
  child.stderr?.once("end", () => finishCapture(stderrCapture));
  child.once("error", onChildError);

  const timeout = setTimeout(() => requestTermination("timed_out"), options.timeoutMs);
  const completionAbort = new AbortController();
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  let closeObserved = false;

  try {
    const completion = await Promise.race([
      once(child, "close", { signal: completionAbort.signal }).then(([code, signal]) => ({
        kind: "close" as const,
        code: code as number | null,
        signal: signal as NodeJS.Signals | null
      })),
      once(terminationEvents, "complete", { signal: completionAbort.signal }).then(() => ({ kind: "termination" as const }))
    ]);
    if (completion.kind === "close") {
      closeObserved = true;
      closeCode = completion.code;
      closeSignal = completion.signal;
    } else if (termination?.childCloseObserved) {
      closeObserved = true;
      closeCode = child.exitCode;
      closeSignal = child.signalCode;
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") childError ??= error;
  } finally {
    clearTimeout(timeout);
    completionAbort.abort();
  }

  if (terminationPromise) {
    try {
      termination = await terminationPromise;
    } catch (error) {
      termination ??= {
        attempted: true,
        scope: "process_tree",
        method: process.platform === "win32" ? "taskkill_tree" : "process_group",
        confirmed: false,
        childCloseObserved: closeObserved,
        error: safeProcessError(error)
      };
    }
  }

  child.stdout?.off("data", onStdoutData);
  child.stderr?.off("data", onStderrData);
  child.off("error", onChildError);
  child.stdin?.destroy();
  if (!closeObserved) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  finishCapture(stdoutCapture);
  finishCapture(stderrCapture);

  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  let outcome: ProcessOutcome;
  let exitCode: number | null = null;
  let executionError: string | null = null;

  if (terminalCause === "timed_out") {
    outcome = "timed_out";
    executionError = `Command execution timed out after ${options.timeoutMs} ms`;
  } else if (terminalCause === "output_limit") {
    outcome = "output_limit";
    executionError = `Process output exceeded configured buffer limit of ${policy.limits.process.maxOutputBufferMb} MB`;
  } else if (childError !== undefined) {
    outcome = "spawn_failed";
    executionError = safeProcessError(childError);
  } else if (closeSignal !== null) {
    outcome = "signaled";
  } else if (closeCode !== null) {
    outcome = "exited";
    exitCode = closeCode;
  } else {
    outcome = "spawn_failed";
    executionError = "Process closed without an exit code or signal";
  }

  if (termination && !termination.confirmed && termination.error) {
    executionError = `${executionError ?? "Process execution failed"}; process-tree termination was not confirmed: ${termination.error}`;
  }
  const killAttempted = terminalCause !== null;
  const killSucceeded = termination ? termination.confirmed : false;
  const processExited = terminalCause === null && childError === undefined && closeSignal === null && closeCode !== null;
  const waitAttempted = true;
  const reaped = closeObserved && (!killAttempted || killSucceeded);

  const lifecycle: ProcessLifecycle = {
    processStarted: true,
    processExited,
    killAttempted,
    killSucceeded,
    waitAttempted,
    reaped,
    ...(termination ? {
      scope: termination.scope,
      method: termination.method,
      ...(termination.error ? { error: termination.error } : {})
    } : {})
  };

  return limitProcessOutput({
    outcome,
    exitCode,
    signal: closeSignal,
    executionError,
    effectiveTimeoutMs: options.timeoutMs,
    elapsedMs,
    stdoutRaw: stdoutCapture.chunks.join(""),
    stderrRaw: stderrCapture.chunks.join(""),
    stdoutCaptureTruncated: stdoutCapture.captureTruncated,
    stderrCaptureTruncated: stderrCapture.captureTruncated,
    lifecycle
  }, policy);
}

export async function runProjectCommand(
  rootPath: string,
  command: string,
  args: string[],
  timeoutMs = 120000,
  shell = false,
  policy: PortusPolicyConfig = loadPolicyConfig()
): Promise<ProjectCommandResult> {
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
    } else {
      shellOption = true;
    }
  }

  const result = await runCapturedProcess({
    rootPath,
    command: execCommand,
    args: execArgs,
    timeoutMs,
    shell: shellOption,
    env,
    policy
  });
  return { command, args, ...result };
}
