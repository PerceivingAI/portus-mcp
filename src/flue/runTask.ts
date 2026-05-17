import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { loadAgentCommandConfig, loadAgentProviderConfig, loadConfig } from "../config.js";
import type { AgentProviderConfig } from "../config.js";
import { stateStore } from "../state/StateStore.js";
import { SessionRecord, getSession, listActiveSessions, upsertSession } from "../state/SessionRegistry.js";
import { appendSessionEvent, appendSessionEventById } from "../state/SessionEvents.js";
import { getProject } from "../state/ProjectRegistry.js";
import { optionalEnv } from "../env.js";
import { assertAgentPermission } from "../policy/permissionPolicy.js";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { countChars } from "../runtime/outputLimits.js";

const runningProcesses = new Map<string, ChildProcess>();
const runningStops = new Set<string>();
const projectLocks = new Map<string, { sessionId: string; acquiredAtMs: number }>();
const pendingQueue: QueueItem[] = [];

type FailureType =
  | "flue_cli_missing"
  | "flue_startup_hang"
  | "provider_rate_limited"
  | "provider_auth"
  | "provider_quota"
  | "network_transient"
  | "workspace_error"
  | "flue_runtime_error"
  | "queue_ttl_expired"
  | "unknown";

type RetryPolicy = {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  retryOn: Set<FailureType>;
  respectRetryAfter: boolean;
  maxRetryWindowMs: number;
};

export type RunFlueTaskInput = {
  projectAlias: string;
  task: string;
  agentTemplate: string;
  timeoutSecs?: number;
};

type QueueItem = {
  input: RunFlueTaskInput;
  record: SessionRecord;
  queuedAtMs: number;
};

export async function runFlueTask(input: RunFlueTaskInput): Promise<SessionRecord> {
  const config = loadConfig();
  const project = getProject(input.projectAlias);
  assertAgentPermission("network", input.projectAlias);

  const maxRuntimeSecs = getEffectivePermissions(input.projectAlias).agents.maxRuntimeSecs;
  const timeoutSecs = input.timeoutSecs ?? maxRuntimeSecs;
  if (timeoutSecs > maxRuntimeSecs) {
    throw new Error(`Requested timeout ${timeoutSecs}s exceeds maxRuntimeSecs ${maxRuntimeSecs}s`);
  }

  const limits = getAgentLimits(input.projectAlias);
  if (limits.maxConcurrentAgents === 0) {
    throw new Error("Max concurrent agents is set to 0.");
  }
  if (limits.maxConcurrentAgentsPerProject === 0) {
    throw new Error("Max concurrent agents per project is set to 0.");
  }
  const blockedByCapacity = limits.activeSessions >= limits.maxConcurrentAgents || limits.projectActiveSessions >= limits.maxConcurrentAgentsPerProject;
  const blockedByLock = !canAcquireProjectLock(input.projectAlias);
  const isBlocked = blockedByCapacity || blockedByLock;
  if (isBlocked && !limits.queueEnabled) {
    throw new Error(blockedByLock
      ? `Project lock active for ${input.projectAlias}; queue is disabled`
      : `Concurrent agent limit reached (total=${limits.maxConcurrentAgents}, perProject=${limits.maxConcurrentAgentsPerProject}); queue is disabled`);
  }

  const sessionId = `sess_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionDir = path.join(stateStore.root, "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const promptPath = path.join(sessionDir, "prompt.txt");
  const stdoutPath = path.join(sessionDir, "stdout.log");
  const stderrPath = path.join(sessionDir, "stderr.log");
  const resultPath = path.join(sessionDir, "result.md");
  const metadataPath = path.join(sessionDir, "metadata.json");
  const eventsPath = path.join(sessionDir, "events.jsonl");

  writeFileSync(promptPath, input.task, "utf8");
  writeFileSync(stdoutPath, "", "utf8");
  writeFileSync(stderrPath, "", "utf8");
  writeFileSync(resultPath, "", "utf8");
  writeFileSync(eventsPath, "", "utf8");

  const record: SessionRecord = {
    sessionId,
    projectAlias: input.projectAlias,
    agentTemplate: input.agentTemplate,
    task: input.task,
    status: isBlocked && limits.queueEnabled ? "queued" : "running",
    startedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    resultPath,
    metadataPath,
    eventsPath,
    queuedAt: isBlocked && limits.queueEnabled ? new Date().toISOString() : undefined
  };
  upsertSession(record);
  appendSessionEvent(record, "created", "Session created.", {
    status: record.status,
    agentTemplate: input.agentTemplate
  });

  if (isBlocked && limits.queueEnabled) {
    const maxQueueDepth = loadPolicyConfig().agents.maxQueueDepth;
    if (pendingQueue.length >= maxQueueDepth) {
      const failed = failQueuedRecord(record, "queue_ttl_expired", "Queue is full and cannot accept more tasks.");
      appendSessionEvent(failed, "queue_full", "Queue is full and cannot accept more tasks.", { queueDepth: pendingQueue.length });
      stateStore.audit({ tool: "agent_run_task", sessionId, projectAlias: input.projectAlias, status: "failed", reason: "queue_full" });
      return failed;
    }
    pendingQueue.push({ input, record, queuedAtMs: Date.now() });
    appendSessionEvent(record, "queued", "Session queued.", { queueDepth: pendingQueue.length });
    stateStore.audit({ tool: "agent_run_task", sessionId, projectAlias: input.projectAlias, status: "queued", queuedAt: record.queuedAt });
    writeFileSync(metadataPath, JSON.stringify({
      status: "queued",
      queuedAt: record.queuedAt,
      queueDepth: pendingQueue.length
    }, null, 2), "utf8");
    scheduleQueueDrain();
    return record;
  }

  return startSessionExecution(input, record);
}

async function startSessionExecution(input: RunFlueTaskInput, record: SessionRecord): Promise<SessionRecord> {
  const config = loadConfig();
  const providerConfig = loadAgentProviderConfig(config);
  const project = getProject(input.projectAlias);
  const maxRuntimeSecs = getEffectivePermissions(input.projectAlias).agents.maxRuntimeSecs;
  const timeoutSecs = input.timeoutSecs ?? maxRuntimeSecs;

  acquireProjectLock(input.projectAlias, record.sessionId);

  const commandConfig = loadAgentCommandConfig(config);
  const grantedCommands = grantedCommandsForProject(input.projectAlias, commandConfig.allowedCommands);

  const flueAgentName = input.agentTemplate.replace(/\.ts$/, "");
  const flueWorkspace = process.cwd();
  const flueProjectAgent = prepareProjectFlueAgent({
    flueWorkspace,
    projectRoot: project.rootPath,
    sourceAgentName: flueAgentName,
    sessionId: record.sessionId
  });
  const flueCli = path.resolve(optionalEnv("PORTUS_MCP_FLUE_CLI_PATH", path.join(flueWorkspace, "node_modules", "@flue", "cli", "dist", "flue.js")));
  if (!existsSync(flueCli)) {
    const failed: SessionRecord = {
      ...record,
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: null
    };
    writeFileSync(record.resultPath, "Flue CLI path does not exist.\n", "utf8");
    writeFileSync(record.metadataPath, JSON.stringify({
      exitCode: null,
      signal: null,
      failureType: "flue_cli_missing",
      flueCli,
      attempts: [],
      stdoutChars: 0,
      stderrChars: 0,
      grantedCommands
    }, null, 2), "utf8");
    upsertSession(failed);
    appendSessionEvent(failed, "failed", "Flue CLI path does not exist.", { failureType: "flue_cli_missing" });
    releaseProjectLock(input.projectAlias, record.sessionId);
    stateStore.audit({ tool: "agent_run_task", sessionId: record.sessionId, projectAlias: input.projectAlias, status: "failed", failureType: "flue_cli_missing", flueCli });
    scheduleQueueDrain();
    return failed;
  }

  const args = [
    flueCli,
    "run",
    flueProjectAgent.agentName,
    "--target",
    "node",
    "--session-id",
    record.sessionId,
    "--workspace",
    project.rootPath,
    "--output",
    path.join(flueWorkspace, ".portus-mcp", "flue-builds", record.sessionId),
    "--payload",
    JSON.stringify({
      task: input.task,
      projectRoot: project.rootPath,
      provider: providerConfig.provider,
      model: providerConfig.model,
      allowedCommands: commandConfig.allowedCommands,
      grantedCommands
    })
  ];

  const retryPolicy = loadRetryPolicy(config);
  const nowIso = new Date().toISOString();
  const runningRecord: SessionRecord = {
    ...record,
    status: "running",
    dequeuedAt: record.status === "queued" ? nowIso : undefined,
    queueWaitMs: record.queuedAt ? Date.now() - Date.parse(record.queuedAt) : undefined
  };
  upsertSession(runningRecord);
  if (record.status === "queued") {
    appendSessionEvent(runningRecord, "dequeued", "Session dequeued.", { queueWaitMs: runningRecord.queueWaitMs ?? null });
  }
  appendSessionEvent(runningRecord, "started", "Session started.", { grantedCommands });
  writeFileSync(record.metadataPath, JSON.stringify({
    status: "running",
    grantedCommands,
    queuedAt: runningRecord.queuedAt ?? null,
    dequeuedAt: runningRecord.dequeuedAt ?? null,
    queueWaitMs: runningRecord.queueWaitMs ?? null
  }, null, 2), "utf8");

  void runSessionAttempts({
    input,
    sessionId: record.sessionId,
    projectRoot: project.rootPath,
    args,
    stdoutPath: record.stdoutPath,
    stderrPath: record.stderrPath,
    resultPath: record.resultPath,
    metadataPath: record.metadataPath,
    timeoutSecs,
    retryPolicy,
    providerConfig,
    grantedCommands,
    cleanup: flueProjectAgent.cleanup
  });
  stateStore.audit({
    tool: "agent_run_task",
    sessionId: record.sessionId,
    projectAlias: input.projectAlias,
    status: "running",
    grantedCommands,
    queuedAt: runningRecord.queuedAt ?? null,
    dequeuedAt: runningRecord.dequeuedAt ?? null,
    queueWaitMs: runningRecord.queueWaitMs ?? null
  });
  return runningRecord;
}

function prepareProjectFlueAgent(params: {
  flueWorkspace: string;
  projectRoot: string;
  sourceAgentName: string;
  sessionId: string;
}): { agentName: string; cleanup: () => void } {
  const sourcePath = path.join(params.flueWorkspace, "agents", `${params.sourceAgentName}.ts`);
  const fluePackagesPath = path.join(params.flueWorkspace, "node_modules", "@flue");
  if (!existsSync(sourcePath)) {
    throw new Error(`Flue agent template does not exist: ${sourcePath}`);
  }
  if (!existsSync(fluePackagesPath)) {
    throw new Error(`Flue SDK packages do not exist: ${fluePackagesPath}`);
  }
  const agentsDir = path.join(params.projectRoot, "agents");
  const createdAgentsDir = !existsSync(agentsDir);
  mkdirSync(agentsDir, { recursive: true });
  const agentName = `portus-${params.sessionId}`;
  const targetPath = path.join(agentsDir, `${agentName}.ts`);
  if (existsSync(targetPath)) {
    throw new Error(`Temporary Flue agent path already exists: ${targetPath}`);
  }
  copyFileSync(sourcePath, targetPath);
  const nodeModulesDir = path.join(params.projectRoot, "node_modules");
  const createdNodeModulesDir = !existsSync(nodeModulesDir);
  mkdirSync(nodeModulesDir, { recursive: true });
  const flueLinkPath = path.join(nodeModulesDir, "@flue");
  const createdFlueLink = !existsSync(flueLinkPath);
  if (createdFlueLink) {
    symlinkSync(fluePackagesPath, flueLinkPath, process.platform === "win32" ? "junction" : "dir");
  }
  return {
    agentName,
    cleanup: () => {
      rmSync(targetPath, { force: true });
      if (createdFlueLink) {
        rmSync(flueLinkPath, { force: true, recursive: true });
      }
      if (createdNodeModulesDir) {
        try {
          rmSync(nodeModulesDir, { force: true });
        } catch {
          // best effort
        }
      }
      if (createdAgentsDir) {
        try {
          rmSync(agentsDir, { force: true });
        } catch {
          // best effort
        }
      }
    }
  };
}

function failQueuedRecord(record: SessionRecord, failureType: FailureType, message: string): SessionRecord {
  const failed: SessionRecord = {
    ...record,
    status: "failed",
    completedAt: new Date().toISOString(),
    exitCode: null
  };
  writeFileSync(record.resultPath, `${message}\n`, "utf8");
  writeFileSync(record.metadataPath, JSON.stringify({
    status: "failed",
    failureType,
    message
  }, null, 2), "utf8");
  upsertSession(failed);
  appendSessionEvent(failed, failureType === "queue_ttl_expired" ? "queue_expired" : "failed", message, { failureType });
  return failed;
}

function scheduleQueueDrain(): void {
  const delayMs = loadPolicyConfig().agents.queueDrainDelayMs;
  setTimeout(() => {
    void drainQueue();
  }, delayMs);
}

async function drainQueue(): Promise<void> {
  if (pendingQueue.length === 0) return;
  const queueTtlMs = loadPolicyConfig().agents.queuedTaskTtlSecs * 1000;
  const now = Date.now();
  for (let i = pendingQueue.length - 1; i >= 0; i -= 1) {
    const item = pendingQueue[i]!;
    if (now - item.queuedAtMs > queueTtlMs) {
      pendingQueue.splice(i, 1);
      failQueuedRecord(item.record, "queue_ttl_expired", "Queued task expired before execution.");
      stateStore.audit({ tool: "agent_run_task", sessionId: item.record.sessionId, projectAlias: item.record.projectAlias, status: "failed", reason: "queue_ttl_expired" });
    }
  }
  if (pendingQueue.length === 0) return;

  for (let i = 0; i < pendingQueue.length; i += 1) {
    const item = pendingQueue[i]!;
    const limits = getAgentLimits(item.input.projectAlias);
    const blockedByCapacity = limits.activeSessions >= limits.maxConcurrentAgents || limits.projectActiveSessions >= limits.maxConcurrentAgentsPerProject;
    const blockedByLock = !canAcquireProjectLock(item.input.projectAlias);
    if (blockedByCapacity || blockedByLock) continue;
    pendingQueue.splice(i, 1);
    await startSessionExecution(item.input, item.record);
    break;
  }
  if (pendingQueue.length > 0) scheduleQueueDrain();
}

function canAcquireProjectLock(projectAlias: string): boolean {
  const existing = projectLocks.get(projectAlias);
  if (!existing) return true;
  const lockTimeoutMs = loadPolicyConfig().agents.projectLockTimeoutSecs * 1000;
  if (Date.now() - existing.acquiredAtMs > lockTimeoutMs) {
    projectLocks.delete(projectAlias);
    appendSessionEventById(existing.sessionId, "lock_expired", "Project lock expired and was released.", { projectAlias });
    stateStore.audit({ tool: "project_lock", projectAlias, action: "expired_lock_released", sessionId: existing.sessionId });
    return true;
  }
  return false;
}

function acquireProjectLock(projectAlias: string, sessionId: string): void {
  projectLocks.set(projectAlias, { sessionId, acquiredAtMs: Date.now() });
  appendSessionEventById(sessionId, "lock_acquired", "Project lock acquired.", { projectAlias });
  stateStore.audit({ tool: "project_lock", projectAlias, action: "acquire", sessionId });
}

function releaseProjectLock(projectAlias: string, sessionId: string): void {
  const lock = projectLocks.get(projectAlias);
  if (!lock) return;
  if (lock.sessionId !== sessionId) return;
  projectLocks.delete(projectAlias);
  appendSessionEventById(sessionId, "lock_released", "Project lock released.", { projectAlias });
  stateStore.audit({ tool: "project_lock", projectAlias, action: "release", sessionId });
}

function grantedCommandsForProject(projectAlias: string, allowedCommands: string[]): string[] {
  const permissions = getEffectivePermissions(projectAlias);
  if (!permissions.agents.grantCommands) return [];
  return allowedCommands.filter((command) => {
    if (command === "git") return permissions.agents.gitCommand;
    if (command === "npm") return permissions.agents.packageManagerCommand;
    if (command === "node") return permissions.agents.nodeCommand;
    return permissions.agents.grantCommands;
  });
}

function buildAgentChildEnv(providerConfig: AgentProviderConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const safeInheritedEnvNames = [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "SHELL"
  ];

  for (const name of safeInheritedEnvNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  env.PORTUS_MCP_DEFAULT_PROVIDER = providerConfig.provider;

  for (const name of providerConfig.requiredEnv) {
    env[name] = optionalEnv(name);
  }

  return env;
}

export function getAgentLimits(projectAlias?: string): {
  maxConcurrentAgents: number;
  activeSessions: number;
  maxConcurrentAgentsPerProject: number;
  projectActiveSessions: number;
  queueEnabled: boolean;
  queueDepth: number;
  maxQueueDepth: number;
  queueTaskTtlSecs: number;
  sessionLockTimeoutSecs: number;
  lockedProjects: Array<{ projectAlias: string; sessionId: string; acquiredAt: string }>;
} {
  const policy = loadPolicyConfig();
  const maxConcurrentAgents = policy.agents.maxConcurrent;
  const maxConcurrentAgentsPerProject = policy.agents.maxConcurrentPerProject;
  const activeSessions = listActiveSessions().length;
  const projectActiveSessions = projectAlias ? listActiveSessions(projectAlias).length : 0;
  const queueEnabled = policy.agents.queueEnabled;
  const maxQueueDepth = policy.agents.maxQueueDepth;
  const queueTaskTtlSecs = policy.agents.queuedTaskTtlSecs;
  const sessionLockTimeoutSecs = policy.agents.projectLockTimeoutSecs;
  const lockedProjects = Array.from(projectLocks.entries()).map(([alias, lock]) => ({
    projectAlias: alias,
    sessionId: lock.sessionId,
    acquiredAt: new Date(lock.acquiredAtMs).toISOString()
  }));
  return {
    maxConcurrentAgents,
    activeSessions,
    maxConcurrentAgentsPerProject,
    projectActiveSessions,
    queueEnabled,
    queueDepth: pendingQueue.length,
    maxQueueDepth,
    queueTaskTtlSecs,
    sessionLockTimeoutSecs,
    lockedProjects
  };
}

export function stopFlueTask(sessionId: string): SessionRecord {
  const session = getSession(sessionId);
  if (session.status === "queued") {
    const idx = pendingQueue.findIndex((item) => item.record.sessionId === sessionId);
    if (idx >= 0) pendingQueue.splice(idx, 1);
    const stoppedQueued: SessionRecord = {
      ...session,
      status: "stopped",
      completedAt: new Date().toISOString(),
      exitCode: null
    };
    writeFileSync(session.metadataPath, JSON.stringify({ status: "stopped", reason: "stopped_while_queued" }, null, 2), "utf8");
    upsertSession(stoppedQueued);
    appendSessionEvent(stoppedQueued, "stopped", "Queued session stopped.", { reason: "stopped_while_queued" });
    stateStore.audit({ tool: "agent_stop", sessionId, projectAlias: session.projectAlias, status: "stopped", reason: "queued" });
    return stoppedQueued;
  }
  if (session.status !== "running") return session;

  const child = runningProcesses.get(sessionId);
  if (child && !child.killed) child.kill();
  runningStops.add(sessionId);

  const stopped: SessionRecord = {
    ...session,
    status: "stopped",
    completedAt: new Date().toISOString(),
    exitCode: null
  };
  writeFileSync(session.metadataPath, JSON.stringify({ status: "stopped" }, null, 2), "utf8");
  upsertSession(stopped);
  appendSessionEvent(stopped, "stopped", "Running session stopped.", {});
  runningProcesses.delete(sessionId);
  releaseProjectLock(session.projectAlias, sessionId);
  scheduleQueueDrain();
  stateStore.audit({ tool: "agent_stop", sessionId, projectAlias: session.projectAlias, status: "stopped" });
  return stopped;
}

async function runSessionAttempts(params: {
  input: RunFlueTaskInput;
  sessionId: string;
  projectRoot: string;
  args: string[];
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  metadataPath: string;
  timeoutSecs: number;
  retryPolicy: RetryPolicy;
  providerConfig: AgentProviderConfig;
  grantedCommands: string[];
  cleanup?: () => void;
}) {
  try {
    const started = Date.now();
    const attempts: Array<Record<string, unknown>> = [];
    for (let attempt = 1; attempt <= params.retryPolicy.maxAttempts; attempt += 1) {
      if (runningStops.has(params.sessionId)) return;
      const result = await runSingleAttempt(params, attempt);
      const failureType = classifyFailure(result.stdout, result.stderr, result.exitCode, result.signal);
      const retryDelayMs = computeRetryDelayMs(result.stdout, result.stderr, attempt, params.retryPolicy);
      const shouldRetry = shouldRetryFailure(failureType, attempt, started, retryDelayMs, params.retryPolicy);
      appendSessionEventById(params.sessionId, "attempt_finished", "Attempt finished.", {
        attempt,
        exitCode: result.exitCode,
        signal: result.signal,
        failureType,
        shouldRetry,
        retryDelayMs
      });
      attempts.push({
        attempt,
        exitCode: result.exitCode,
        signal: result.signal,
        failureType,
        shouldRetry,
        retryDelayMs
      });

      if (result.exitCode === 0) {
        finalizeSession(params, {
          status: "completed",
          exitCode: 0,
          signal: result.signal,
          stdoutChars: countChars(result.stdout),
          stderrChars: countChars(result.stderr),
          attempts
        });
        return;
      }

      if (!shouldRetry) {
        finalizeSession(params, {
          status: "failed",
          exitCode: result.exitCode,
          signal: result.signal,
          stdoutChars: countChars(result.stdout),
          stderrChars: countChars(result.stderr),
          attempts,
          failureType
        });
        return;
      }
      appendSessionEventById(params.sessionId, "retry_scheduled", "Retry scheduled.", {
        attempt,
        failureType,
        retryDelayMs
      });
      await delay(retryDelayMs);
    }
  } finally {
    params.cleanup?.();
  }
}

async function runSingleAttempt(params: {
  sessionId: string;
  projectRoot: string;
  args: string[];
  stdoutPath: string;
  stderrPath: string;
  timeoutSecs: number;
  providerConfig: AgentProviderConfig;
}, attempt: number): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; startupHang: boolean }> {
  const child = spawn(process.execPath, params.args, {
    cwd: params.projectRoot,
    env: buildAgentChildEnv(params.providerConfig)
  });

  runningProcesses.set(params.sessionId, child);
  appendSessionEventById(params.sessionId, "attempt_started", "Attempt started.", { attempt });
  const stdoutStream = createWriteStream(params.stdoutPath, { flags: "a" });
  const stderrStream = createWriteStream(params.stderrPath, { flags: "a" });
  let streamsClosed = false;
  const safeWrite = (stream: ReturnType<typeof createWriteStream>, value: string) => {
    if (streamsClosed || stream.writableEnded || stream.destroyed) return;
    try {
      stream.write(value);
    } catch {
      // best effort
    }
  };
  safeWrite(stdoutStream, `\n[attempt ${attempt} start]\n`);
  safeWrite(stderrStream, `\n[attempt ${attempt} start]\n`);
  let stdout = "";
  let stderr = "";
  let emittedOutput = false;
  let startupHang = false;
  const agentPolicy = loadPolicyConfig().agents;
  child.stdout?.on("data", (chunk) => {
    emittedOutput = true;
    const text = chunk.toString("utf8");
    stdout += text;
    appendSessionEventById(params.sessionId, "stdout", "stdout chunk", { attempt, text, chars: countChars(text) });
  });
  child.stderr?.on("data", (chunk) => {
    emittedOutput = true;
    const text = chunk.toString("utf8");
    stderr += text;
    appendSessionEventById(params.sessionId, "stderr", "stderr chunk", { attempt, text, chars: countChars(text) });
  });
  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);

  const timeout = setTimeout(() => {
    void terminateChildTree(child, `attempt ${attempt} timeout`);
  }, params.timeoutSecs * 1000);
  const startupWatchdog = setTimeout(() => {
    if (emittedOutput || child.killed || child.exitCode !== null) return;
    startupHang = true;
    stderr += "\n[portus-mcp] startup watchdog detected no output";
    appendSessionEventById(params.sessionId, "startup_watchdog", "Startup watchdog detected no output.", { attempt });
    void terminateChildTree(child, `attempt ${attempt} startup watchdog`);
  }, agentPolicy.startupWatchdogMs);

  const closeResult = await new Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; closed: boolean; startupHang: boolean }>((resolve) => {
    let closed = false;
    const forcedCloseWatchdog = setTimeout(() => {
      if (closed) return;
      stderr += "\n[portus-mcp] attempt watchdog forced close";
      safeWrite(stdoutStream, `\n[attempt ${attempt} watchdog forced close]\n`);
      safeWrite(stderrStream, `\n[attempt ${attempt} watchdog forced close]\n`);
      appendSessionEventById(params.sessionId, "startup_watchdog", "Attempt watchdog forced close.", { attempt });
      runningProcesses.delete(params.sessionId);
      streamsClosed = true;
      stdoutStream.end();
      stderrStream.end();
      resolve({ exitCode: 124, signal: null, stdout, stderr, closed: false, startupHang });
    }, params.timeoutSecs * 1000 + agentPolicy.forcedCloseGraceMs);
    child.on("error", (error) => {
      const text = String(error);
      stderr += text;
      safeWrite(stderrStream, text);
      appendSessionEventById(params.sessionId, "stderr", "child process error", { attempt, text, chars: countChars(text) });
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(startupWatchdog);
      clearTimeout(forcedCloseWatchdog);
      runningProcesses.delete(params.sessionId);
      safeWrite(stdoutStream, `\n[attempt ${attempt} end]\n`);
      safeWrite(stderrStream, `\n[attempt ${attempt} end]\n`);
      streamsClosed = true;
      stdoutStream.end();
      stderrStream.end();
      resolve({ exitCode: code, signal, stdout, stderr, closed, startupHang });
    });
  });
  return {
    exitCode: closeResult.exitCode,
    signal: closeResult.signal,
    stdout: closeResult.stdout,
    stderr: closeResult.stderr,
    startupHang: closeResult.startupHang
  };
}

function finalizeSession(
  params: {
    input: RunFlueTaskInput;
    sessionId: string;
    resultPath: string;
    metadataPath: string;
    stdoutPath: string;
    stderrPath: string;
    grantedCommands: string[];
  },
  result: {
    status: "completed" | "failed";
    exitCode: number | null;
    signal: string | null;
    stdoutChars: number;
    stderrChars: number;
    attempts: Array<Record<string, unknown>>;
    failureType?: FailureType;
  }
) {
  const current = getSession(params.sessionId);
  if (current.status === "stopped") return;
  const completed: SessionRecord = {
    ...current,
    status: result.status,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode
  };

  const summary = {
    sessionId: params.sessionId,
    projectAlias: params.input.projectAlias,
    status: result.status,
    changedFiles: [] as string[],
    commandsRun: params.grantedCommands,
    checks: {
      exitCode: result.exitCode,
      attempts: result.attempts.length
    },
    followUpRisks: result.failureType ? [result.failureType] : []
  };
  try {
    writeFileSync(params.resultPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
    writeFileSync(params.metadataPath, JSON.stringify({
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutChars: result.stdoutChars,
      stderrChars: result.stderrChars,
      attempts: result.attempts,
      failureType: result.failureType ?? null,
      grantedCommands: params.grantedCommands,
      queuedAt: current.queuedAt ?? null,
      dequeuedAt: current.dequeuedAt ?? null,
      queueWaitMs: current.queueWaitMs ?? null,
      summary
    }, null, 2), "utf8");
  } catch {
    // best effort
  }
  upsertSession(completed);
  appendSessionEvent(completed, result.status, `Session ${result.status}.`, {
    exitCode: result.exitCode,
    signal: result.signal,
    failureType: result.failureType ?? null,
    stdoutChars: result.stdoutChars,
    stderrChars: result.stderrChars,
    attempts: result.attempts.length
  });
  releaseProjectLock(params.input.projectAlias, params.sessionId);
  scheduleQueueDrain();
  stateStore.audit({
    tool: "agent_run_task",
    sessionId: params.sessionId,
    projectAlias: params.input.projectAlias,
    status: result.status,
    failureType: result.failureType ?? null,
    grantedCommands: params.grantedCommands,
    queuedAt: current.queuedAt ?? null,
    dequeuedAt: current.dequeuedAt ?? null,
    queueWaitMs: current.queueWaitMs ?? null
  });
}

function loadRetryPolicy(config: ReturnType<typeof loadConfig>): RetryPolicy {
  const cfg = config.agents.retry;
  const retryOn = new Set(cfg.retryOn) as Set<FailureType>;
  return {
    enabled: cfg.enabled,
    maxAttempts: Math.max(1, cfg.maxAttempts),
    baseDelayMs: Math.max(100, cfg.baseDelayMs),
    maxDelayMs: Math.max(cfg.baseDelayMs, cfg.maxDelayMs),
    jitterRatio: Math.max(0, Math.min(1, cfg.jitterRatio)),
    retryOn,
    respectRetryAfter: cfg.respectRetryAfter,
    maxRetryWindowMs: Math.max(1000, cfg.maxRetryWindowSecs * 1000)
  };
}

function classifyFailure(stdout: string, stderr: string, exitCode: number | null, signal: string | null): FailureType {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if ((signal === "SIGTERM" || exitCode === 124) && text.includes("startup watchdog detected no output")) return "flue_startup_hang";
  if (text.includes("429")) return text.includes("quota") ? "provider_quota" : "provider_rate_limited";
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("forbidden")) return "provider_auth";
  if (text.includes("quota exceeded") || text.includes("insufficient_quota")) return "provider_quota";
  if (text.includes("enotfound") || text.includes("econnreset") || text.includes("etimedout") || text.includes("network error") || text.includes("connection failed")) return "network_transient";
  if (text.includes("path escapes project root") || text.includes("blocked path pattern")) return "workspace_error";
  if (text.includes("[flue] error")) return "flue_runtime_error";
  if ((signal === "SIGTERM" || exitCode === 124) && !text.trim()) return "flue_startup_hang";
  if (exitCode === 0) return "unknown";
  return "unknown";
}

function shouldRetryFailure(
  failureType: FailureType,
  attempt: number,
  startedMs: number,
  nextDelayMs: number,
  policy: RetryPolicy
) {
  if (!policy.enabled) return false;
  if (attempt >= policy.maxAttempts) return false;
  if (!policy.retryOn.has(failureType)) return false;
  const elapsed = Date.now() - startedMs;
  return elapsed + nextDelayMs <= policy.maxRetryWindowMs;
}

function computeRetryDelayMs(stdout: string, stderr: string, attempt: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = exp * policy.jitterRatio * Math.random();
  let delayMs = Math.round(exp + jitter);
  if (policy.respectRetryAfter) {
    const retryAfter = parseRetryAfterSeconds(`${stdout}\n${stderr}`);
    if (retryAfter !== null) {
      delayMs = Math.max(delayMs, retryAfter * 1000);
    }
  }
  return Math.min(delayMs, policy.maxDelayMs);
}

function parseRetryAfterSeconds(text: string): number | null {
  const match = text.match(/retry-after[^0-9]*([0-9]+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChildTree(child: ChildProcess, reason: string) {
  if (!child.pid) return;
  try {
    if (!child.killed) child.kill();
  } catch {
    // best effort
  }
  await delay(loadPolicyConfig().agents.killEscalationDelayMs);
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best effort
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  }
  stateStore.audit({ tool: "agent_run_task", kill: "forced", pid: child.pid, reason });
}

