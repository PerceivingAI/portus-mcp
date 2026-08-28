import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export type ProcessTerminationMethod = "process_group" | "taskkill_tree" | "win32_job_object" | "descendant_fallback";
export type ProcessTerminationOutcome = "terminated" | "termination_unverified" | "termination_failed";
export type ProcessTerminationVerification = "confirmed_absent" | "confirmed_alive" | "unavailable";

export type ProcessTreeTerminationResult = {
  attempted: true;
  scope: "process_tree";
  method: ProcessTerminationMethod;
  outcome: ProcessTerminationOutcome;
  verification: ProcessTerminationVerification;
  confirmed: boolean;
  childCloseObserved: boolean;
  descendantsRemaining: number;
  actionError?: string;
  verificationError?: string;
};

export type ProcessLifecycle = {
  processStarted: boolean;
  processExited: boolean;
  killAttempted: boolean;
  killSucceeded: boolean;
  waitAttempted: boolean;
  reaped: boolean;
  processTreeKillAttempted?: boolean;
  processTreeKillSucceeded?: boolean;
  descendantsRemaining?: number;
  terminationOutcome?: ProcessTerminationOutcome;
  terminationVerification?: ProcessTerminationVerification;
  terminationActionError?: string;
  terminationVerificationError?: string;
  scope?: "process_tree" | "direct_child";
  method?: ProcessTerminationMethod;
  reconciled?: boolean;
  reconciliationReason?: string;
  exitCodeKnown?: boolean;
};

export type ProcessTreeTerminationOptions = {
  escalationDelayMs: number;
  forcedCloseGraceMs: number;
  fallbackToTrackedChild?: boolean;
};

const terminationPromises = new WeakMap<ChildProcess, Promise<ProcessTreeTerminationResult>>();


function processErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 2000) || "Process-tree termination failed";
}

function terminationResult(options: {
  method: ProcessTerminationMethod;
  verification: ProcessTerminationVerification;
  childCloseObserved: boolean;
  descendantsRemaining: number;
  actionError?: string;
  verificationError?: string;
}): ProcessTreeTerminationResult {
  const outcome: ProcessTerminationOutcome = options.verification === "confirmed_absent"
    ? "terminated"
    : options.verification === "confirmed_alive"
      ? "termination_failed"
      : "termination_unverified";
  return {
    attempted: true,
    scope: "process_tree",
    method: options.method,
    outcome,
    verification: options.verification,
    confirmed: options.verification === "confirmed_absent",
    childCloseObserved: options.childCloseObserved,
    descendantsRemaining: options.descendantsRemaining,
    ...(options.actionError ? { actionError: options.actionError } : {}),
    ...(options.verificationError ? { verificationError: options.verificationError } : {})
  };
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function hasChildClosed(child: ChildProcess): boolean {
  if (!hasChildExited(child)) return false;
  const stdoutClosed = child.stdout === null || child.stdout.destroyed || child.stdout.readableEnded;
  const stderrClosed = child.stderr === null || child.stderr.destroyed || child.stderr.readableEnded;
  return stdoutClosed && stderrClosed;
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasChildClosed(child)) return true;
  try {
    await once(child, "close", { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
    return hasChildClosed(child);
  }
}

function hasProcessGroupExited(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

const PROCESS_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 3000;

export type PosixProcessRow = {
  pid: number;
  parentPid: number;
};

export type PosixSessionProcessRow = PosixProcessRow & {
  processGroupId: number;
  startedAtMs: number;
};

export type SessionProcessSnapshot = {
  rootPid: number;
  rootStartedAtMs: number;
  allowedPids: number[];
};

async function runBoundedSnapshotCommand(
  application: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean; description: string }
): Promise<string> {
  const child = spawn(application, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
    windowsHide: options.windowsHide
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalBytes = 0;
  let outputExceeded = false;
  let timedOut = false;
  let spawnError: Error | null = null;
  const append = (chunks: Buffer[], chunk: Buffer) => {
    if (outputExceeded) return;
    totalBytes += chunk.length;
    if (totalBytes > PROCESS_SNAPSHOT_MAX_BYTES) {
      outputExceeded = true;
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  };
  child.stdout?.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
  child.stderr?.on("data", (chunk: Buffer) => append(stderrChunks, chunk));
  child.on("error", (error: Error) => {
    spawnError = error;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PROCESS_SNAPSHOT_TIMEOUT_MS);
  let code: number | null;
  try {
    [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timeout);
  }
  if (spawnError) throw new Error(`${options.description} could not start`);
  if (timedOut) throw new Error(`${options.description} timed out`);
  if (outputExceeded) throw new Error(`${options.description} exceeded the output limit`);
  if (code !== 0) {
    const detail = Buffer.concat(stderrChunks).toString("utf8").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    throw new Error(`${options.description} failed${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.concat(stdoutChunks).toString("utf8").trim();
}

export function collectDescendantPids(rows: readonly PosixProcessRow[], rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.parentPid);
    if (children) children.push(row.pid);
    else childrenByParent.set(row.parentPid, [row.pid]);
  }

  const descendants: number[] = [];
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    const children = childrenByParent.get(queue[index]) ?? [];
    for (const childPid of children) {
      descendants.push(childPid);
      queue.push(childPid);
    }
  }
  return descendants;
}

export function collectPosixSessionPids(rows: readonly PosixSessionProcessRow[], rootPid: number): number[] {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root || root.processGroupId !== rootPid) return [];
  return rows
    .filter((row) => row.processGroupId === rootPid)
    .map((row) => row.pid)
    .sort((a, b) => a - b);
}

export async function getPosixDescendants(rootPid: number): Promise<number[]> {
  if (process.platform === "win32" || rootPid <= 0) return [];
  const text = await runBoundedSnapshotCommand(
    "ps",
    ["-e", "-o", "pid=,ppid="],
    { description: "POSIX process snapshot" }
  );
  const rows: PosixProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return collectDescendantPids(rows, rootPid);
}

export async function getPosixSessionProcessSnapshot(rootPid: number): Promise<SessionProcessSnapshot | null> {
  if (process.platform === "win32" || rootPid <= 0) return null;
  const text = await runBoundedSnapshotCommand(
    "ps",
    ["-e", "-o", "pid=,ppid=,pgid=,lstart="],
    {
      description: "POSIX session process snapshot",
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    }
  );
  const rows: PosixSessionProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const startedAtMs = Date.parse(match[4]);
    if (!Number.isFinite(startedAtMs)) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      startedAtMs
    });
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return null;
  const allowedPids = collectPosixSessionPids(rows, rootPid);
  if (allowedPids.length === 0) return null;
  return { rootPid, rootStartedAtMs: root.startedAtMs, allowedPids };
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function remainingProcesses(pids: readonly number[]): number[] {
  return pids.filter(isProcessAlive);
}

async function waitForPosixTreeExit(rootPid: number, descendantPids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (hasProcessGroupExited(rootPid) && remainingProcesses(descendantPids).length === 0) return true;
    await delay(20);
  } while (Date.now() < deadline);
  return hasProcessGroupExited(rootPid) && remainingProcesses(descendantPids).length === 0;
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

const WIN_PROCESS_TREE_CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;

public static class PortusWinProcessTree {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    public static string GetDescendants(uint rootPid) {
        IntPtr snap = CreateToolhelp32Snapshot(2, 0);
        if (snap == IntPtr.Zero || snap == (IntPtr)(-1)) return "[]";
        var parentMap = new Dictionary<uint, List<uint>>();
        PROCESSENTRY32 pe = new PROCESSENTRY32();
        pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32First(snap, ref pe)) {
            do {
                uint pid = pe.th32ProcessID;
                uint ppid = pe.th32ParentProcessID;
                if (!parentMap.ContainsKey(ppid)) {
                    parentMap[ppid] = new List<uint>();
                }
                parentMap[ppid].Add(pid);
            } while (Process32Next(snap, ref pe));
        }
        CloseHandle(snap);
        var descendants = new List<uint>();
        if (rootPid > 0) {
            var queue = new Queue<uint>();
            queue.Enqueue(rootPid);
            while (queue.Count > 0) {
                uint current = queue.Dequeue();
                if (parentMap.ContainsKey(current)) {
                    foreach (uint child in parentMap[current]) {
                        descendants.Add(child);
                        queue.Enqueue(child);
                    }
                }
            }
        }
        return "[" + string.Join(",", descendants) + "]";
    }

    public static string GetSessionSnapshot(uint rootPid) {
        long startedAtMs = -1;
        try {
            Process root = Process.GetProcessById((int)rootPid);
            startedAtMs = new DateTimeOffset(root.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
        } catch {
            return "-1|[]";
        }
        return startedAtMs.ToString() + "|" + GetDescendants(rootPid);
    }
}
`;

async function runWindowsProcessTreeQuery(method: "GetDescendants" | "GetSessionSnapshot", rootPid: number): Promise<string | null> {
  if (process.platform !== "win32" || rootPid <= 0) return null;
  try {
    const command = `Add-Type -TypeDefinition @'\n${WIN_PROCESS_TREE_CSHARP}\n'@ -Language CSharp\n[PortusWinProcessTree]::${method}(${rootPid})`;
    return await runBoundedSnapshotCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { description: "Windows process snapshot", windowsHide: true }
    );
  } catch {
    return null;
  }
}

function parsePidArray(text: string): number[] | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(candidate)) return null;
  const pids: number[] = [];
  for (const value of candidate) {
    if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) return null;
    pids.push(value);
  }
  return pids;
}

async function getWindowsDescendantSnapshot(rootPid: number): Promise<number[] | null> {
  const text = await runWindowsProcessTreeQuery("GetDescendants", rootPid);
  return text === null ? null : parsePidArray(text);
}

export async function getWindowsDescendants(rootPid: number): Promise<number[]> {
  return (await getWindowsDescendantSnapshot(rootPid)) ?? [];
}

export async function getWindowsSessionProcessSnapshot(rootPid: number): Promise<SessionProcessSnapshot | null> {
  const text = await runWindowsProcessTreeQuery("GetSessionSnapshot", rootPid);
  if (text === null) return null;
  const separator = text.indexOf("|");
  if (separator < 1) return null;
  const rootStartedAtMs = Number(text.slice(0, separator));
  const descendants = parsePidArray(text.slice(separator + 1));
  if (!Number.isFinite(rootStartedAtMs) || rootStartedAtMs <= 0 || descendants === null) return null;
  return {
    rootPid,
    rootStartedAtMs,
    allowedPids: [rootPid, ...descendants]
  };
}

export async function forceKillPid(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  if (process.platform === "win32" && isProcessAlive(pid)) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      await once(killer, "close");
    } catch {
      // ignore
    }
  }
}

async function runTaskkill(pid: number): Promise<void> {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  const [code] = await once(killer, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`taskkill failed with exit code ${code}`);
}

function forceTrackedChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "ERR_INVALID_HANDLE") throw error;
  }
}


async function performProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminationOptions
): Promise<ProcessTreeTerminationResult> {
  const method: ProcessTerminationMethod = process.platform === "win32" ? "taskkill_tree" : "process_group";
  const pid = child.pid;
  if (!pid) {
    return terminationResult({
      method,
      verification: "unavailable",
      childCloseObserved: hasChildClosed(child),
      descendantsRemaining: 0,
      verificationError: "Cannot verify process-tree termination without a process id"
    });
  }

  if (process.platform === "win32") {
    let actionError: string | undefined;
    let verificationError: string | undefined;
    const descendantSnapshot = await getWindowsDescendantSnapshot(pid);
    if (descendantSnapshot === null) {
      verificationError = "Unable to capture the Windows process tree before termination";
    }

    if (!hasChildClosed(child)) {
      try {
        await runTaskkill(pid);
      } catch (error) {
        actionError = processErrorMessage(error);
        if (descendantSnapshot !== null) {
          for (const descendantPid of descendantSnapshot) {
            try {
              await forceKillPid(descendantPid);
            } catch (fallbackError) {
              const message = processErrorMessage(fallbackError);
              actionError = actionError ? `${actionError}; descendant fallback failed: ${message}` : message;
            }
          }
        }
        if (options.fallbackToTrackedChild !== false) {
          try {
            forceTrackedChild(child);
          } catch (fallbackError) {
            const message = processErrorMessage(fallbackError);
            actionError = actionError ? `${actionError}; root fallback failed: ${message}` : message;
          }
        }
      }
    }

    let childCloseObserved = hasChildClosed(child);
    try {
      childCloseObserved = await waitForChildClose(child, options.forcedCloseGraceMs);
    } catch (error) {
      const message = processErrorMessage(error);
      verificationError = verificationError ? `${verificationError}; ${message}` : message;
    }

    if (descendantSnapshot === null) {
      return terminationResult({
        method,
        verification: "unavailable",
        childCloseObserved,
        descendantsRemaining: isProcessAlive(pid) ? 1 : 0,
        actionError,
        verificationError
      });
    }

    const descendantsRemaining = descendantSnapshot.filter(isProcessAlive).length + (isProcessAlive(pid) ? 1 : 0);
    return terminationResult({
      method,
      verification: descendantsRemaining === 0 ? "confirmed_absent" : "confirmed_alive",
      childCloseObserved,
      descendantsRemaining,
      actionError,
      ...(descendantsRemaining > 0
        ? { verificationError: "One or more tracked processes remained alive after termination" }
        : {})
    });
  }

  let knownDescendants: number[] | null = null;
  let actionError: string | undefined;
  let verificationError: string | undefined;
  try {
    knownDescendants = await getPosixDescendants(pid);
  } catch (error) {
    verificationError = processErrorMessage(error);
  }

  try {
    for (const descendantPid of [...(knownDescendants ?? [])].reverse()) {
      signalProcess(descendantPid, "SIGTERM");
    }
    if (!hasProcessGroupExited(pid)) signalProcessGroup(pid, "SIGTERM");

    if (knownDescendants !== null) {
      const exitedDuringGrace = await waitForPosixTreeExit(pid, knownDescendants, options.escalationDelayMs);
      if (!exitedDuringGrace) {
        for (const descendantPid of remainingProcesses(knownDescendants).reverse()) {
          signalProcess(descendantPid, "SIGKILL");
        }
        if (!hasProcessGroupExited(pid)) signalProcessGroup(pid, "SIGKILL");
      }
    }
  } catch (error) {
    actionError = processErrorMessage(error);
    if (options.fallbackToTrackedChild !== false) {
      try {
        forceTrackedChild(child);
      } catch (fallbackError) {
        actionError = `${actionError}; root fallback failed: ${processErrorMessage(fallbackError)}`;
      }
    }
  }

  let childCloseObserved = hasChildClosed(child);
  try {
    childCloseObserved = await waitForChildClose(child, options.forcedCloseGraceMs);
  } catch (error) {
    const message = processErrorMessage(error);
    verificationError = verificationError ? `${verificationError}; ${message}` : message;
  }

  if (knownDescendants === null) {
    return terminationResult({
      method,
      verification: "unavailable",
      childCloseObserved,
      descendantsRemaining: hasProcessGroupExited(pid) ? 0 : 1,
      actionError,
      verificationError: verificationError ?? "Unable to capture the process tree before termination"
    });
  }

  const survivingDescendants = remainingProcesses(knownDescendants);
  const processGroupAlive = !hasProcessGroupExited(pid);
  const descendantsRemaining = survivingDescendants.length + (processGroupAlive ? 1 : 0);
  return terminationResult({
    method,
    verification: descendantsRemaining === 0 ? "confirmed_absent" : "confirmed_alive",
    childCloseObserved,
    descendantsRemaining,
    actionError,
    ...(descendantsRemaining > 0
      ? { verificationError: "One or more tracked processes remained alive after termination" }
      : {})
  });
}

export function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminationOptions
): Promise<ProcessTreeTerminationResult> {
  const existing = terminationPromises.get(child);
  if (existing) return existing;
  const termination = performProcessTreeTermination(child, options).then((result) => {
    if (!result.confirmed) terminationPromises.delete(child);
    return result;
  });
  terminationPromises.set(child, termination);
  return termination;
}
