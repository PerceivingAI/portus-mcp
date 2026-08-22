import { ChildProcess, spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadPolicyConfig, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { stateStore } from "../state/StateStore.js";
import { terminateProcessTree, type ProcessLifecycle } from "./processTermination.js";

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
  stdoutFd: number;
  stderrFd: number;
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

export async function startExecutionSession(options: StartExecutionSessionOptions): Promise<PublicExecutionSession> {
  const policy = options.policy ?? loadPolicyConfig();
  const allowShell = policyPermissions(policy).main_agent.allowShell;
  const shell = options.shell ?? false;
  if (shell && !allowShell) {
    throw new Error("Permission denied: main_agent.allowShell is false");
  }

  const isWin = process.platform === "win32";
  if (!shell && isWin && /\.(cmd|bat)$/i.test(options.command)) {
    throw new Error("Windows batch scripts (.cmd/.bat) require shell=true or package-script execution");
  }

  const sessionId = `exec_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const execDir = getExecutionDirectory(sessionId);
  const stdoutPath = path.join(execDir, "stdout.log");
  const stderrPath = path.join(execDir, "stderr.log");

  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");

  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  let execCommand = options.command;
  let execArgs = options.args ?? [];
  let shellOption = false;
  if (shell) {
    if (isWin) {
      execCommand = "cmd.exe";
      execArgs = ["/c", options.command, ...execArgs];
    } else {
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
    closeSync(stdoutFd);
    closeSync(stderrFd);
    const errMessage = error instanceof Error ? error.message : String(error);
    const failedRecord: ExecutionSessionRecord = {
      sessionId,
      projectAlias: options.projectAlias,
      command: options.command,
      args: options.args ?? [],
      shell,
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
    shell,
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

  const timeoutHandle = setTimeout(() => {
    void handleSessionTimeout(sessionId);
  }, timeoutMs);

  const entry: ActiveProcessEntry = {
    child,
    timeoutHandle,
    startedAtMs,
    stdoutFd,
    stderrFd,
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

  const stdoutStream = createWriteStream("", { fd: stdoutFd, autoClose: false });
  const stderrStream = createWriteStream("", { fd: stderrFd, autoClose: false });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutStream.write(chunk);
    record.stdoutBytes += chunk.length;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrStream.write(chunk);
    record.stderrBytes += chunk.length;
  });

  child.once("close", (code, signal) => {
    handleProcessClosed(sessionId, code, signal);
  });

  child.once("error", (err) => {
    record.executionError = err.message;
  });

  return toPublicExecutionSession(record);
}

function handleProcessClosed(sessionId: string, exitCode: number | null, signal: NodeJS.Signals | null): void {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  clearTimeout(entry.timeoutHandle);
  activeProcesses.delete(sessionId);

  try {
    closeSync(entry.stdoutFd);
    closeSync(entry.stderrFd);
  } catch {
    // ignore
  }

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

  const rec = entry.record;
  rec.status = "timed_out";
  rec.executionError = `Execution session timed out after ${rec.timeoutMs} ms`;

  const termination = await terminateProcessTree(entry.child, {
    escalationDelayMs: ESCALATION_DELAY_MS,
    forcedCloseGraceMs: FORCED_CLOSE_GRACE_MS
  });

  rec.completedAt = new Date().toISOString();
  rec.lifecycle = {
    ...rec.lifecycle,
    killAttempted: true,
    killSucceeded: termination.confirmed,
    processTreeKillAttempted: true,
    processTreeKillSucceeded: termination.confirmed,
    descendantsRemaining: termination.descendantsRemaining ?? (termination.confirmed ? 0 : 1),
    scope: termination.scope,
    method: termination.method,
    waitAttempted: true,
    reaped: termination.confirmed
  };
  upsertExecutionSession(rec);

  stateStore.audit({
    tool: "project_run",
    sessionAction: "timed_out",
    sessionId,
    projectAlias: rec.projectAlias,
    killSucceeded: termination.confirmed
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

  try {
    closeSync(entry.stdoutFd);
    closeSync(entry.stderrFd);
  } catch {
    // ignore
  }

  rec.lifecycle = {
    ...rec.lifecycle,
    killAttempted: true,
    killSucceeded: termination.confirmed,
    processTreeKillAttempted: true,
    processTreeKillSucceeded: termination.confirmed,
    descendantsRemaining: termination.descendantsRemaining ?? (termination.confirmed ? 0 : 1),
    scope: termination.scope,
    method: termination.method,
    waitAttempted: true,
    reaped: termination.confirmed
  };
  upsertExecutionSession(rec);

  stateStore.audit({
    tool: "project_run",
    sessionAction: "terminate",
    sessionId,
    projectAlias: rec.projectAlias,
    killSucceeded: termination.confirmed
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
