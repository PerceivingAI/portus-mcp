import { ChildProcess, spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import crypto from "node:crypto";
import { loadPolicyConfig, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { stateStore } from "../state/StateStore.js";
import { terminateProcessTree, type ProcessLifecycle, type ProcessTreeTerminationResult } from "./processTermination.js";

const DEFAULT_SESSION_TIMEOUT_MS = 3600 * 1000;
const SESSIONS_FILE = "execution_sessions.json";
const ESCALATION_DELAY_MS = 1200;
const FORCED_CLOSE_GRACE_MS = 8000;

export type ExecutionSessionStatus = "running" | "completed" | "failed" | "timed_out" | "stopped";

export type ExecutionSessionRecord = {
  sessionId: string;
  projectAlias: string;
  command: string;
  args: string[];
  shell: boolean;
  status: ExecutionSessionStatus;
  pid?: number;
  startedAt: string;
  completedAt?: string;
  timeoutMs: number;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  lifecycle: ProcessLifecycle;
};

export type PublicExecutionSession = {
  sessionId: string;
  projectAlias: string;
  command: string;
  args: string[];
  status: ExecutionSessionStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  executionError?: string | null;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  lifecycle: ProcessLifecycle;
};

export type StartExecutionSessionOptions = {
  projectAlias: string;
  rootPath: string;
  command: string;
  /** Trusted, already-resolved executable used for spawning while `command` remains the public identity. */
  executablePath?: string;
  args?: string[];
  timeoutSecs?: number;
  shell?: boolean;
  policy?: PortusPolicyConfig;
};

export type PollExecutionSessionOptions = {
  sessionId: string;
  cursor?: number;
  maxChars?: number;
  stream?: "stdout" | "stderr" | "both";
};

export type PollExecutionSessionResult = {
  sessionId: string;
  projectAlias: string;
  status: ExecutionSessionStatus;
  stdoutChunk: string;
  stderrChunk?: string;
  nextCursor: number;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number | null;
  signal: string | null;
  executionError: string | null;
  elapsedMs: number;
  lifecycle: ProcessLifecycle;
};

type ActiveProcessEntry = {
  child: ChildProcess;
  timeoutHandle: NodeJS.Timeout;
  startedAtMs: number;
  stdoutStream: WriteStream;
  stderrStream: WriteStream;
  outputClosePromise?: Promise<void>;
  record: ExecutionSessionRecord;
};

const activeProcesses = new Map<string, ActiveProcessEntry>();

type SessionStateFile = {
  sessions: ExecutionSessionRecord[];
};

function readSessionRecords(): ExecutionSessionRecord[] {
  return stateStore.readJson<SessionStateFile>(SESSIONS_FILE, { sessions: [] }).sessions;
}

function writeSessionRecords(records: ExecutionSessionRecord[]): void {
  stateStore.writeJson(SESSIONS_FILE, { sessions: records });
}

export function getExecutionSession(sessionId: string): ExecutionSessionRecord {
  const record = readSessionRecords().find((item) => item.sessionId === sessionId);
  if (!record) throw new Error(`Unknown execution session id: ${sessionId}`);
  return record;
}

export type ExecutionSessionOwnership = {
  sessionId: string;
  projectAlias: string;
  status: ExecutionSessionStatus;
  pid?: number;
  startedAtMs: number;
};

type ExecutionSessionExitListener = (sessionId: string) => void;
const executionSessionExitListeners = new Set<ExecutionSessionExitListener>();

export function subscribeExecutionSessionExit(listener: ExecutionSessionExitListener): () => void {
  executionSessionExitListeners.add(listener);
  return () => executionSessionExitListeners.delete(listener);
}

function notifyExecutionSessionExit(sessionId: string): void {
  for (const listener of executionSessionExitListeners) {
    try {
      listener(sessionId);
    } catch {
      // Session cleanup must not fail because an observer failed.
    }
  }
}

/**
 * Narrow internal accessor for first-party screenshot ownership checks.
 * Exposes PID and start time to trusted runtime code without widening
 * `PublicExecutionSession`. Returns null instead of throwing for unknown ids.
 */
export function getExecutionSessionOwnership(sessionId: string): ExecutionSessionOwnership | null {
  const record = readSessionRecords().find((item) => item.sessionId === sessionId);
  if (!record) return null;
  return {
    sessionId: record.sessionId,
    projectAlias: record.projectAlias,
    status: record.status,
    ...(record.pid ? { pid: record.pid } : {}),
    startedAtMs: new Date(record.startedAt).getTime()
  };
}


export function upsertExecutionSession(record: ExecutionSessionRecord): ExecutionSessionRecord {
  const records = readSessionRecords().filter((item) => item.sessionId !== record.sessionId);
  records.push(record);
  writeSessionRecords(records);
  return record;
}

export function toPublicExecutionSession(record: ExecutionSessionRecord): PublicExecutionSession {
  const startedMs = new Date(record.startedAt).getTime();
  const endedMs = record.completedAt ? new Date(record.completedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, Math.round(endedMs - startedMs));
  return {
    sessionId: record.sessionId,
    projectAlias: record.projectAlias,
    command: record.command,
    args: record.args,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    exitCode: record.exitCode,
    signal: record.signal,
    executionError: record.executionError,
    elapsedMs,
    stdoutBytes: record.stdoutBytes,
    stderrBytes: record.stderrBytes,
    lifecycle: record.lifecycle
  };
}

export function listExecutionSessions(projectAlias?: string): PublicExecutionSession[] {
  const records = readSessionRecords();
  return records
    .filter((s) => !projectAlias || s.projectAlias === projectAlias)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map(toPublicExecutionSession);
}

function getExecutionDirectory(sessionId: string): string {
  const dir = path.join(stateStore.root, "executions", sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function closeOutputStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  const closePromise = once(stream, "close").then(
    () => undefined,
    () => undefined
  );
  if (!stream.writableEnded && !stream.destroyed) stream.end();
  return closePromise;
}

function closeExecutionOutput(entry: ActiveProcessEntry): Promise<void> {
  entry.outputClosePromise ??= Promise.all([
    closeOutputStream(entry.stdoutStream),
    closeOutputStream(entry.stderrStream)
  ]).then(() => undefined);
  return entry.outputClosePromise;
}

function lifecycleAfterTermination(
  lifecycle: ProcessLifecycle,
  termination: ProcessTreeTerminationResult
): ProcessLifecycle {
  const succeeded = termination.outcome === "terminated";
  return {
    ...lifecycle,
    killAttempted: true,
    killSucceeded: succeeded,
    processTreeKillAttempted: true,
    processTreeKillSucceeded: succeeded,
    descendantsRemaining: termination.descendantsRemaining,
    terminationOutcome: termination.outcome,
    terminationVerification: termination.verification,
    ...(termination.actionError ? { terminationActionError: termination.actionError } : {}),
    ...(termination.verificationError ? { terminationVerificationError: termination.verificationError } : {}),
    scope: termination.scope,
    method: termination.method,
    waitAttempted: true,
    reaped: termination.verification === "confirmed_absent"
  };
}

function appendTerminationFailure(
  currentError: string | null,
  termination: ProcessTreeTerminationResult
): string | null {
  if (termination.outcome === "terminated") return currentError;
  const details = [termination.actionError, termination.verificationError].filter(Boolean).join("; ");
  const message = `Process-tree termination ${termination.outcome}${details ? `: ${details}` : ""}`;
  return currentError ? `${currentError}; ${message}` : message;
}

export async function startExecutionSession(options: StartExecutionSessionOptions): Promise<PublicExecutionSession> {
  const policy = options.policy ?? loadPolicyConfig();
  const allowShell = policyPermissions(policy).main_agent.allowShell;
  const isWin = process.platform === "win32";
  if (options.executablePath !== undefined) {
    if (!path.isAbsolute(options.executablePath)) {
      throw new Error("Resolved execution-session executable path must be absolute");
    }
    if (options.shell === true) {
      throw new Error("Resolved execution-session executables cannot run through a shell");
    }
  }
  const isBatchScript = options.executablePath === undefined
    && isWin
    && (/\.(cmd|bat)$/i.test(options.command) || ["npm", "npx", "pnpm", "yarn", "corepack", "gradlew"].includes(options.command.toLowerCase()));

  if (isBatchScript && !allowShell) {
    throw new Error("Windows batch scripts (.cmd/.bat) require allowShell: true in policy");
  }

  const sessionId = `exec_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const execDir = getExecutionDirectory(sessionId);
  const stdoutPath = path.join(execDir, "stdout.log");
  const stderrPath = path.join(execDir, "stderr.log");

  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  let execCommand = options.executablePath ?? options.command;
  let execArgs = options.args ?? [];
  let shellOption = false;

  if (options.executablePath === undefined && allowShell) {
    if (isWin) {
      if (isBatchScript || (options.args ?? []).some((arg) => /[&|<>^%*?]/.test(arg))) {
        execCommand = "cmd.exe";
        execArgs = ["/c", options.command, ...execArgs];
      }
    } else if ((options.args ?? []).some((arg) => /[&|;<>`$]/.test(arg))) {
      shellOption = true;
    }
  }
  const timeoutMs = Math.min(Math.max(1, (options.timeoutSecs ?? 3600)) * 1000, DEFAULT_SESSION_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();

  let child: ChildProcess;
  try {
    child = spawn(execCommand, execArgs, {
      cwd: options.rootPath,
      env,
      shell: shellOption,
      detached: !isWin,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    const failedRecord: ExecutionSessionRecord = {
      sessionId,
      projectAlias: options.projectAlias,
      command: options.command,
      args: options.args ?? [],
      shell: shellOption,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      timeoutMs,
      exitCode: null,
      signal: null,
      executionError: errMessage,
      stdoutPath,
      stderrPath,
      stdoutBytes: 0,
      stderrBytes: 0,
      lifecycle: {
        processStarted: false,
        processExited: false,
        killAttempted: false,
        killSucceeded: false,
        waitAttempted: false,
        reaped: false,
        processTreeKillAttempted: false,
        processTreeKillSucceeded: false,
        descendantsRemaining: 0
      }
    };
    upsertExecutionSession(failedRecord);
    return toPublicExecutionSession(failedRecord);
  }

  const record: ExecutionSessionRecord = {
    sessionId,
    projectAlias: options.projectAlias,
    command: options.command,
    args: options.args ?? [],
    shell: shellOption,
    status: "running",
    pid: child.pid,
    startedAt,
    timeoutMs,
    exitCode: null,
    signal: null,
    executionError: null,
    stdoutPath,
    stderrPath,
    stdoutBytes: 0,
    stderrBytes: 0,
    lifecycle: {
      processStarted: true,
      processExited: false,
      killAttempted: false,
      killSucceeded: false,
      waitAttempted: false,
      reaped: false
    }
  };

  const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(stderrPath, { flags: "a" });
  stdoutStream.on("error", (error) => {
    record.executionError ??= `Unable to write execution stdout: ${error.message}`;
  });
  stderrStream.on("error", (error) => {
    record.executionError ??= `Unable to write execution stderr: ${error.message}`;
  });

  const timeoutHandle = setTimeout(() => {
    void handleSessionTimeout(sessionId);
  }, timeoutMs);

  const entry: ActiveProcessEntry = {
    child,
    timeoutHandle,
    startedAtMs,
    stdoutStream,
    stderrStream,
    record
  };
  activeProcesses.set(sessionId, entry);
  upsertExecutionSession(record);

  stateStore.audit({
    tool: "project_run",
    sessionAction: "start",
    sessionId,
    projectAlias: options.projectAlias,
    command: options.command,
    args: options.args ?? [],
    pid: child.pid
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    if (!stdoutStream.destroyed && !stdoutStream.writableEnded) stdoutStream.write(chunk);
    record.stdoutBytes += chunk.length;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (!stderrStream.destroyed && !stderrStream.writableEnded) stderrStream.write(chunk);
    record.stderrBytes += chunk.length;
  });

  child.once("close", (code, signal) => {
    void handleProcessClosed(sessionId, code, signal);
  });

  child.once("error", (err) => {
    record.executionError = err.message;
  });

  return toPublicExecutionSession(record);
}

async function handleProcessClosed(sessionId: string, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  clearTimeout(entry.timeoutHandle);
  activeProcesses.delete(sessionId);
  await closeExecutionOutput(entry);

  const rec = entry.record;
  rec.completedAt = new Date().toISOString();
  rec.exitCode = exitCode;
  rec.signal = signal;
  if (rec.status === "running") {
    rec.status = exitCode === 0 ? "completed" : "failed";
  }
  rec.lifecycle = {
    ...rec.lifecycle,
    processExited: exitCode !== null || signal !== null,
    waitAttempted: true,
    reaped: true
  };
  upsertExecutionSession(rec);
  notifyExecutionSessionExit(sessionId);

  stateStore.audit({
    tool: "project_run",
    sessionAction: "completed",
    sessionId,
    projectAlias: rec.projectAlias,
    status: rec.status,
    exitCode,
    signal
  });
}

async function handleSessionTimeout(sessionId: string): Promise<void> {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  clearTimeout(entry.timeoutHandle);
  activeProcesses.delete(sessionId);

  const rec = entry.record;
  rec.status = "timed_out";
  rec.executionError = `Execution session timed out after ${rec.timeoutMs} ms`;

  const termination = await terminateProcessTree(entry.child, {
    escalationDelayMs: ESCALATION_DELAY_MS,
    forcedCloseGraceMs: FORCED_CLOSE_GRACE_MS
  });

  if (termination.childCloseObserved) await closeExecutionOutput(entry);

  rec.completedAt = new Date().toISOString();
  rec.executionError = appendTerminationFailure(rec.executionError, termination);
  rec.lifecycle = lifecycleAfterTermination(rec.lifecycle, termination);
  upsertExecutionSession(rec);
  notifyExecutionSessionExit(sessionId);

  stateStore.audit({
    tool: "project_run",
    sessionAction: "timed_out",
    sessionId,
    projectAlias: rec.projectAlias,
    killSucceeded: termination.outcome === "terminated",
    terminationOutcome: termination.outcome,
    terminationVerification: termination.verification,
    descendantsRemaining: termination.descendantsRemaining
  });
}

export async function terminateExecutionSession(sessionId: string): Promise<PublicExecutionSession> {
  const entry = activeProcesses.get(sessionId);
  if (!entry) {
    const record = getExecutionSession(sessionId);
    if (record.status === "running") {
      record.status = "stopped";
      record.completedAt = new Date().toISOString();
      upsertExecutionSession(record);
      notifyExecutionSessionExit(sessionId);
    }
    return toPublicExecutionSession(record);
  }

  clearTimeout(entry.timeoutHandle);
  activeProcesses.delete(sessionId);

  const rec = entry.record;
  rec.status = "stopped";
  rec.completedAt = new Date().toISOString();

  const termination = await terminateProcessTree(entry.child, {
    escalationDelayMs: ESCALATION_DELAY_MS,
    forcedCloseGraceMs: FORCED_CLOSE_GRACE_MS
  });

  if (termination.childCloseObserved) await closeExecutionOutput(entry);

  rec.executionError = appendTerminationFailure(rec.executionError, termination);
  rec.lifecycle = lifecycleAfterTermination(rec.lifecycle, termination);
  upsertExecutionSession(rec);
  notifyExecutionSessionExit(sessionId);

  stateStore.audit({
    tool: "project_run",
    sessionAction: "terminate",
    sessionId,
    projectAlias: rec.projectAlias,
    killSucceeded: termination.outcome === "terminated",
    terminationOutcome: termination.outcome,
    terminationVerification: termination.verification,
    descendantsRemaining: termination.descendantsRemaining
  });

  return toPublicExecutionSession(rec);
}

export function pollExecutionSession(options: PollExecutionSessionOptions): PollExecutionSessionResult {
  const record = getExecutionSession(options.sessionId);
  const cursor = Math.max(0, options.cursor ?? 0);
  const maxChars = Math.min(Math.max(1, options.maxChars ?? 16384), 65536);

  let stdoutChunk = "";
  let nextCursor = cursor;

  if (existsSync(record.stdoutPath)) {
    const size = statSync(record.stdoutPath).size;
    if (cursor < size) {
      const bytesToRead = Math.min(size - cursor, maxChars);
      const buffer = Buffer.alloc(bytesToRead);
      const fd = openSync(record.stdoutPath, "r");
      try {
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, cursor);
        stdoutChunk = buffer.subarray(0, bytesRead).toString("utf8");
        nextCursor = cursor + bytesRead;
      } finally {
        closeSync(fd);
      }
    }
  }

  let stderrChunk: string | undefined;
  if (options.stream === "both" || options.stream === "stderr") {
    if (existsSync(record.stderrPath)) {
      const errSize = statSync(record.stderrPath).size;
      if (cursor < errSize) {
        const bytesToRead = Math.min(errSize - cursor, maxChars);
        const buffer = Buffer.alloc(bytesToRead);
        const fd = openSync(record.stderrPath, "r");
        try {
          const bytesRead = readSync(fd, buffer, 0, bytesToRead, cursor);
          stderrChunk = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          closeSync(fd);
        }
      } else {
        stderrChunk = "";
      }
    }
  }

  const startedMs = new Date(record.startedAt).getTime();
  const endedMs = record.completedAt ? new Date(record.completedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, Math.round(endedMs - startedMs));

  return {
    sessionId: record.sessionId,
    projectAlias: record.projectAlias,
    status: record.status,
    stdoutChunk,
    ...(stderrChunk !== undefined ? { stderrChunk } : {}),
    nextCursor,
    stdoutBytes: record.stdoutBytes,
    stderrBytes: record.stderrBytes,
    exitCode: record.exitCode,
    signal: record.signal,
    executionError: record.executionError,
    elapsedMs,
    lifecycle: record.lifecycle
  };
}
