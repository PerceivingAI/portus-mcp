import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export type ProcessTerminationMethod = "process_group" | "taskkill_tree";

export type ProcessTreeTerminationResult = {
  attempted: true;
  scope: "process_tree";
  method: ProcessTerminationMethod;
  confirmed: boolean;
  childCloseObserved: boolean;
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

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (hasProcessGroupExited(pid)) return true;
    await delay(20);
  } while (Date.now() < deadline);
  return hasProcessGroupExited(pid);
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

  try {
    if (process.platform === "win32") {
      if (!hasChildClosed(child)) await runTaskkill(pid);
      const childCloseObserved = await waitForChildClose(child, options.forcedCloseGraceMs);
      if (!childCloseObserved) throw new Error(`Process ${pid} did not close after taskkill`);
      return {
        attempted: true,
        scope: "process_tree",
        method,
        confirmed: true,
        childCloseObserved: true
      };
    }

    if (!hasProcessGroupExited(pid)) {
      signalProcessGroup(pid, "SIGTERM");
      const exitedDuringGrace = await waitForProcessGroupExit(pid, options.escalationDelayMs);
      if (!exitedDuringGrace) signalProcessGroup(pid, "SIGKILL");
    }
    const childCloseObserved = await waitForChildClose(child, options.forcedCloseGraceMs);
    const groupExited = await waitForProcessGroupExit(pid, options.forcedCloseGraceMs);
    if (!childCloseObserved || !groupExited) {
      throw new Error(
        !groupExited
          ? `Process group ${pid} remained alive after termination`
          : `Process ${pid} did not close after process-group termination`
      );
    }
    return {
      attempted: true,
      scope: "process_tree",
      method,
      confirmed: true,
      childCloseObserved: true
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
    const primaryError = processErrorMessage(error);
    return {
      attempted: true,
      scope: "process_tree",
      method,
      confirmed: false,
      childCloseObserved,
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
