import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export type ProcessTerminationMethod = "process_group" | "taskkill_tree" | "win32_job_object" | "descendant_fallback";

export type ProcessTreeTerminationResult = {
  attempted: true;
  scope: "process_tree";
  method: ProcessTerminationMethod;
  confirmed: boolean;
  childCloseObserved: boolean;
  descendantsRemaining?: number;
  error?: string;
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
  scope?: "process_tree" | "direct_child";
  method?: ProcessTerminationMethod;
  error?: string;
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

const POSIX_PROCESS_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export type PosixProcessRow = {
  pid: number;
  parentPid: number;
};

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

export async function getPosixDescendants(rootPid: number): Promise<number[]> {
  if (process.platform === "win32" || rootPid <= 0) return [];
  const ps = spawn("ps", ["-e", "-o", "pid=,ppid="], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  const append = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
    if (outputExceeded) return;
    if (stream === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (stdoutBytes + stderrBytes > POSIX_PROCESS_SNAPSHOT_MAX_BYTES) {
      outputExceeded = true;
      ps.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  };
  ps.stdout?.on("data", (chunk: Buffer) => append(stdoutChunks, chunk, "stdout"));
  ps.stderr?.on("data", (chunk: Buffer) => append(stderrChunks, chunk, "stderr"));

  let snapshotTimedOut = false;
  const snapshotTimeout = setTimeout(() => {
    snapshotTimedOut = true;
    ps.kill("SIGKILL");
  }, 3000);
  let code: number | null;
  try {
    [code] = (await once(ps, "close")) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(snapshotTimeout);
  }
  if (snapshotTimedOut) throw new Error("POSIX process snapshot timed out");
  if (outputExceeded) throw new Error("POSIX process snapshot exceeded the output limit");
  if (code !== 0) {
    const detail = Buffer.concat(stderrChunks).toString("utf8").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
    throw new Error(`Unable to inspect POSIX process descendants${detail ? `: ${detail}` : ""}`);
  }

  const rows: PosixProcessRow[] = [];
  for (const line of Buffer.concat(stdoutChunks).toString("utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]) });
  }
  return collectDescendantPids(rows, rootPid);
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
}
`;

export async function getWindowsDescendants(rootPid: number): Promise<number[]> {
  if (process.platform !== "win32" || rootPid <= 0) return [];
  try {
    const psCmd = `Add-Type -TypeDefinition @'\n${WIN_PROCESS_TREE_CSHARP}\n'@ -Language CSharp\n[PortusWinProcessTree]::GetDescendants(${rootPid})`;
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", psCmd], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    ps.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const [code] = (await once(ps, "close", { signal: AbortSignal.timeout(3000) })) as [number | null, NodeJS.Signals | null];
    if (code === 0) {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.startsWith("[") && text.endsWith("]")) {
        return JSON.parse(text) as number[];
      }
    }
  } catch {
    // Fallback if PowerShell snapshot is unavailable
  }
  return [];
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
  if (code !== 0) throw new Error(`taskkill failed for process ${pid} with exit code ${code}`);
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
    return {
      attempted: true,
      scope: "process_tree",
      method,
      confirmed: false,
      childCloseObserved: hasChildClosed(child),
      error: "Cannot terminate process tree without a process id"
    };
  }
  let knownPosixDescendants: number[] = [];

  try {
    if (process.platform === "win32") {
      let taskkillError: Error | undefined;
      let taskkillSucceeded = false;
      if (!hasChildClosed(child)) {
        try {
          await runTaskkill(pid);
          taskkillSucceeded = true;
        } catch (err) {
          taskkillError = err instanceof Error ? err : new Error(String(err));
          if (!hasChildExited(child)) throw taskkillError;
        }
      }

      let descendantPids: number[] = [];
      if (!taskkillSucceeded) {
        descendantPids = await getWindowsDescendants(pid);
        for (const dPid of descendantPids) {
          if (isProcessAlive(dPid)) {
            await forceKillPid(dPid);
          }
        }
      }

      const childCloseObserved = await waitForChildClose(child, options.forcedCloseGraceMs);
      const remainingDescendants = descendantPids.filter(isProcessAlive);
      const isRootAlive = isProcessAlive(pid);
      const totalRemaining = remainingDescendants.length + (isRootAlive ? 1 : 0);

      if (!childCloseObserved && !hasChildClosed(child)) {
        throw new Error(taskkillError?.message ?? `Process ${pid} did not close after taskkill`);
      }
      if (totalRemaining > 0) {
        throw new Error(`Process tree ${pid} has ${totalRemaining} surviving descendant process(es): [${remainingDescendants.join(", ")}]`);
      }
      return {
        attempted: true,
        scope: "process_tree",
        method,
        confirmed: true,
        childCloseObserved: true,
        descendantsRemaining: 0
      };
    }

    knownPosixDescendants = await getPosixDescendants(pid);
    for (const descendantPid of [...knownPosixDescendants].reverse()) {
      signalProcess(descendantPid, "SIGTERM");
    }
    if (!hasProcessGroupExited(pid)) signalProcessGroup(pid, "SIGTERM");

    const exitedDuringGrace = await waitForPosixTreeExit(pid, knownPosixDescendants, options.escalationDelayMs);
    if (!exitedDuringGrace) {
      for (const descendantPid of remainingProcesses(knownPosixDescendants).reverse()) {
        signalProcess(descendantPid, "SIGKILL");
      }
      if (!hasProcessGroupExited(pid)) signalProcessGroup(pid, "SIGKILL");
    }

    const [childCloseObserved, treeExited] = await Promise.all([
      waitForChildClose(child, options.forcedCloseGraceMs),
      waitForPosixTreeExit(pid, knownPosixDescendants, options.forcedCloseGraceMs)
    ]);
    const survivingDescendants = remainingProcesses(knownPosixDescendants);
    if (!childCloseObserved || !treeExited) {
      throw new Error(
        survivingDescendants.length > 0
          ? `Process tree ${pid} has ${survivingDescendants.length} surviving descendant process(es): [${survivingDescendants.join(", ")}]`
          : !hasProcessGroupExited(pid)
            ? `Process group ${pid} remained alive after termination`
            : `Process ${pid} did not close after process-tree termination`
      );
    }
    return {
      attempted: true,
      scope: "process_tree",
      method,
      confirmed: true,
      childCloseObserved: true,
      descendantsRemaining: 0
    };
  } catch (error) {
    let fallbackError: string | undefined;
    let childCloseObserved = hasChildClosed(child);
    if (options.fallbackToTrackedChild !== false) {
      try {
        forceTrackedChild(child);
      } catch (fallback) {
        fallbackError = processErrorMessage(fallback);
      }
      childCloseObserved = await waitForChildClose(child, options.forcedCloseGraceMs);
    }
    const isRootAlive = pid ? isProcessAlive(pid) : false;
    const survivingDescendants = remainingProcesses(knownPosixDescendants);
    const primaryError = processErrorMessage(error);
    return {
      attempted: true,
      scope: "process_tree",
      method,
      confirmed: false,
      childCloseObserved,
      descendantsRemaining: survivingDescendants.length + (isRootAlive ? 1 : 0),
      error: fallbackError ? `${primaryError}; fallback kill failed: ${fallbackError}` : primaryError
    };
  }
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
