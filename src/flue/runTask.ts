import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { loadAgentProviderConfig, loadConfig } from "../config.js";
import type { AgentProviderConfig } from "../config.js";
import { stateStore } from "../state/StateStore.js";
import { SessionRecord, getSession, listActiveSessions, upsertSession } from "../state/SessionRegistry.js";
import { appendSessionEvent, appendSessionEventById } from "../state/SessionEvents.js";
import { getProject } from "../state/ProjectRegistry.js";
import { optionalEnv } from "../env.js";
import { assertSubagentPermission } from "../policy/permissionPolicy.js";
import { loadSubagentCommandConfig, loadPolicyConfig, policyPermissions } from "../policy/policyConfig.js";
import { countChars } from "../runtime/outputLimits.js";
import { terminateProcessTree } from "../runtime/processTermination.js";
import type { SkillAudienceRegistry } from "../skills/SkillRegistry.js";

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
  subagentSkills?: SkillAudienceRegistry;
};

type QueueItem = {
  input: RunFlueTaskInput;
  record: SessionRecord;
  queuedAtMs: number;
};

export async function runFlueTask(input: RunFlueTaskInput): Promise<SessionRecord> {
  // Reject unknown projects before admitting work to the queue.
  getProject(input.projectAlias);
  assertSubagentPermission("network");

  const maxRuntimeSecs = policyPermissions().subagents.maxRuntimeSecs;
  const timeoutSecs = input.timeoutSecs ?? maxRuntimeSecs;
  if (timeoutSecs > maxRuntimeSecs) {
    throw new Error(`Requested timeout ${timeoutSecs}s exceeds maxRuntimeSecs ${maxRuntimeSecs}s`);
  }

  const limits = getSubagentLimits(input.projectAlias);
  if (limits.maxConcurrentAgents === 0) {
    throw new Error("Max concurrent subagents is set to 0.");
  }
  if (limits.maxConcurrentAgentsPerProject === 0) {
    throw new Error("Max concurrent subagents per project is set to 0.");
  }
  const blockedByCapacity = limits.activeSessions >= limits.maxConcurrentAgents || limits.projectActiveSessions >= limits.maxConcurrentAgentsPerProject;
  const blockedByLock = !canAcquireProjectLock(input.projectAlias);
  const isBlocked = blockedByCapacity || blockedByLock;
  if (isBlocked && !limits.queueEnabled) {
    throw new Error(blockedByLock
      ? `Project lock active for ${input.projectAlias}; queue is disabled`
      : `Concurrent subagent limit reached (total=${limits.maxConcurrentAgents}, perProject=${limits.maxConcurrentAgentsPerProject}); queue is disabled`);
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
    const maxQueueDepth = loadPolicyConfig().subagents.concurrency.maxQueueDepth;
    if (pendingQueue.length >= maxQueueDepth) {
      const failed = failQueuedRecord(record, "queue_ttl_expired", "Queue is full and cannot accept more tasks.");
      appendSessionEvent(failed, "queue_full", "Queue is full and cannot accept more tasks.", { queueDepth: pendingQueue.length });
      stateStore.audit({ tool: "subagent_task", sessionId, projectAlias: input.projectAlias, status: "failed", reason: "queue_full" });
      return failed;
    }
    pendingQueue.push({ input, record, queuedAtMs: Date.now() });
    appendSessionEvent(record, "queued", "Session queued.", { queueDepth: pendingQueue.length });
    stateStore.audit({ tool: "subagent_task", sessionId, projectAlias: input.projectAlias, status: "queued", queuedAt: record.queuedAt });
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
  const providerConfig = loadAgentProviderConfig();
  const project = getProject(input.projectAlias);
  const maxRuntimeSecs = policyPermissions().subagents.maxRuntimeSecs;
  const timeoutSecs = input.timeoutSecs ?? maxRuntimeSecs;

  acquireProjectLock(input.projectAlias, record.sessionId);

  const commandConfig = loadSubagentCommandConfig();
  const grantedCommands = grantedCommandsForProject(input.projectAlias, commandConfig.allowedCommands);
  const maxSkillReadBytes = loadPolicyConfig().limits.skills.maxReadChars * 4;
  const subagentSkills = (input.subagentSkills?.skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    entrypoint: skill.entrypoint,
    mountPath: `/skills/${skill.name}`,
    rootPath: skill.rootPath,
    allowImplicitInvocation: skill.allowImplicitInvocation,
    ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
    ...(skill.allowedTools === undefined ? {} : { allowedTools: skill.allowedTools }),
    ...(skill.openai?.dependencies === undefined ? {} : { dependencies: skill.openai.dependencies }),
    maxReadBytes: maxSkillReadBytes
  }));

  const flueAgentName = input.agentTemplate.replace(/\.ts$/, "");
  const flueWorkspace = process.cwd();
  const flueProjectAgent = prepareProjectFlueSubagent({
    flueWorkspace,
    projectRoot: project.rootPath,
    sourceAgentName: flueAgentName,
    sessionId: record.sessionId
  });
  const flueCli = path.resolve(optionalEnv("PORTUS_MCP_FLUE_CLI_PATH", path.join(flueWorkspace, "node_modules", "@flue", "cli", "dist", "flue.js")));
  if (!existsSync(flueCli)) {
    flueProjectAgent.cleanup();
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
    stateStore.audit({ tool: "subagent_task", sessionId: record.sessionId, projectAlias: input.projectAlias, status: "failed", failureType: "flue_cli_missing", flueCli });
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
    flueProjectAgent.workspaceDir,
    "--output",
    path.join(stateStore.root, "flue-builds", record.sessionId),
    "--payload",
    JSON.stringify({
      task: input.task,
      projectRoot: project.rootPath,
      provider: providerConfig.provider,
      model: providerConfig.model,
      allowedCommands: commandConfig.allowedCommands,
      grantedCommands,
      subagentSkills
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
  appendSessionEvent(runningRecord, "started", "Session started.", { grantedCommands, skills: subagentSkills.map((skill) => skill.name) });
  writeFileSync(record.metadataPath, JSON.stringify({
    status: "running",
    grantedCommands,
    skills: subagentSkills.map((skill) => skill.name),
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
    tool: "subagent_task",
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

function prepareProjectFlueSubagent(params: {
  flueWorkspace: string;
  projectRoot: string;
  sourceAgentName: string;
  sessionId: string;
}): { agentName: string; workspaceDir: string; cleanup: () => void } {
  const sourcePath = path.join(params.flueWorkspace, "subagents", `${params.sourceAgentName}.ts`);
  const fluePackagesPath = path.join(params.flueWorkspace, "node_modules", "@flue");
  if (!existsSync(sourcePath)) {
    throw new Error(`Flue subagent template does not exist: ${sourcePath}`);
  }
  if (!existsSync(fluePackagesPath)) {
    throw new Error(`Flue SDK packages do not exist: ${fluePackagesPath}`);
  }
  const workspaceDir = path.join(stateStore.root, "flue-workspaces", params.sessionId);
  const internalAgentsDir = path.join(workspaceDir, "agents");
  mkdirSync(internalAgentsDir, { recursive: true });
  const agentName = `portus-${params.sessionId}`;
  const targetPath = path.join(internalAgentsDir, `${agentName}.ts`);
  copyFileSync(sourcePath, targetPath);

  const internalNodeModulesDir = path.join(workspaceDir, "node_modules");
  mkdirSync(internalNodeModulesDir, { recursive: true });
  const flueLinkPath = path.join(internalNodeModulesDir, "@flue");
  if (!existsSync(flueLinkPath)) {
    symlinkSync(fluePackagesPath, flueLinkPath, process.platform === "win32" ? "junction" : "dir");
  }
  const justBashPackagesPath = path.join(params.flueWorkspace, "node_modules", "just-bash");
  if (existsSync(justBashPackagesPath)) {
    const justBashLinkPath = path.join(internalNodeModulesDir, "just-bash");
    if (!existsSync(justBashLinkPath)) {
      symlinkSync(justBashPackagesPath, justBashLinkPath, process.platform === "win32" ? "junction" : "dir");
    }
  }

  return {
    agentName,
    workspaceDir,
    cleanup: () => {
      try {
        if (existsSync(flueLinkPath)) unlinkSync(flueLinkPath);
      } catch {}
      try {
        const justBashLinkPath = path.join(internalNodeModulesDir, "just-bash");
        if (existsSync(justBashLinkPath)) unlinkSync(justBashLinkPath);
      } catch {}
      try {
        rmSync(workspaceDir, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
      } catch {}
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
  const delayMs = loadPolicyConfig().subagents.lifecycle.queueDrainDelayMs;
  setTimeout(() => {
    void drainQueue();
  }, delayMs);
}

async function drainQueue(): Promise<void> {
  if (pendingQueue.length === 0) return;
  const queueTtlMs = loadPolicyConfig().subagents.lifecycle.queuedTaskTtlSecs * 1000;
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
    const limits = getSubagentLimits(item.input.projectAlias);
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
  const lockTimeoutMs = loadPolicyConfig().subagents.lifecycle.projectLockTimeoutSecs * 1000;
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

function grantedCommandsForProject(_projectAlias: string, allowedCommands: string[]): string[] {
  return allowedCommands;
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

export function getSubagentLimits(projectAlias?: string): {
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
  const maxConcurrentAgents = policy.subagents.concurrency.maxConcurrent;
  const maxConcurrentAgentsPerProject = policy.subagents.concurrency.maxConcurrentPerProject;
  const activeSessions = listActiveSessions().length;
  const projectActiveSessions = projectAlias ? listActiveSessions(projectAlias).length : 0;
  const queueEnabled = policy.subagents.concurrency.queueEnabled;
  const maxQueueDepth = policy.subagents.concurrency.maxQueueDepth;
  const queueTaskTtlSecs = policy.subagents.lifecycle.queuedTaskTtlSecs;
  const sessionLockTimeoutSecs = policy.subagents.lifecycle.projectLockTimeoutSecs;
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

export async function stopFlueTask(sessionId: string): Promise<SessionRecord> {
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
  if (!child) {
    throw new Error(`Cannot confirm process-tree termination for session ${sessionId}: process is not tracked`);
  }

  runningStops.add(sessionId);
  try {
    await terminateChildTree(child, `manual stop for session ${sessionId}`);
  } catch (error) {
    runningStops.delete(sessionId);
    const message = error instanceof Error ? error.message : String(error);
    appendSessionEventById(sessionId, "termination_failed", "Process-tree termination failed.", { message });
    stateStore.audit({ tool: "agent_stop", sessionId, projectAlias: session.projectAlias, status: "failed", reason: "termination_failed", message });
    throw error;
  }

  const stopped: SessionRecord = {
    ...getSession(sessionId),
    status: "stopped",
    completedAt: new Date().toISOString(),
    exitCode: null
  };
  writeFileSync(session.metadataPath, JSON.stringify({ status: "stopped" }, null, 2), "utf8");
  upsertSession(stopped);
  appendSessionEvent(stopped, "stopped", "Running session stopped.", {});
  runningProcesses.delete(sessionId);
  runningStops.delete(sessionId);
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
      if (runningStops.has(params.sessionId)) return;
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
    env: buildAgentChildEnv(params.providerConfig),
    detached: process.platform !== "win32"
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
  const agentPolicy = loadPolicyConfig().subagents.lifecycle;
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

  let requestedTermination: Promise<void> | undefined;
  const { promise: terminationFailure, reject: rejectTerminationFailure } = deferred<never>();
  const requestTermination = (reason: string) => {
    requestedTermination ??= terminateChildTree(child, reason).catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      appendSessionEventById(params.sessionId, "termination_failed", "Process-tree termination failed.", { attempt, message: failure.message });
      stateStore.audit({ tool: "agent_run_task", sessionId: params.sessionId, status: "failed", failureType: "termination_failed", message: failure.message });
      rejectTerminationFailure(failure);
      throw failure;
    });
    void requestedTermination.catch(() => undefined);
  };
  const timeout = setTimeout(() => requestTermination(`attempt ${attempt} timeout`), params.timeoutSecs * 1000);
  const startupWatchdog = setTimeout(() => {
    if (emittedOutput || child.killed || child.exitCode !== null) return;
    startupHang = true;
    stderr += "\n[portus-mcp] startup watchdog detected no output";
    appendSessionEventById(params.sessionId, "startup_watchdog", "Startup watchdog detected no output.", { attempt });
    requestTermination(`attempt ${attempt} startup watchdog`);
  }, agentPolicy.startupWatchdogMs);

  const { promise: closeResultPromise, resolve: resolveCloseResult } = deferred<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; closed: boolean; startupHang: boolean }>();
  child.on("error", (error) => {
    const text = String(error);
    stderr += text;
    safeWrite(stderrStream, text);
    appendSessionEventById(params.sessionId, "stderr", "child process error", { attempt, text, chars: countChars(text) });
  });
  child.on("close", (code, signal) => {
    runningProcesses.delete(params.sessionId);
    safeWrite(stdoutStream, `\n[attempt ${attempt} end]\n`);
    safeWrite(stderrStream, `\n[attempt ${attempt} end]\n`);
    streamsClosed = true;
    stdoutStream.end();
    stderrStream.end();
    const result = { exitCode: code, signal, stdout, stderr, closed: true, startupHang };
    if (requestedTermination) {
      void requestedTermination.then(() => resolveCloseResult(result));
    } else {
      resolveCloseResult(result);
    }
  });
  let closeResult;
  try {
    closeResult = await Promise.race([closeResultPromise, terminationFailure]);
  } finally {
    clearTimeout(timeout);
    clearTimeout(startupWatchdog);
  }
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
  const cfg = config.subagents.retry;
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms: number) {
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function terminateChildTree(child: ChildProcess, reason: string): Promise<void> {
  const lifecycle = loadPolicyConfig().subagents.lifecycle;
  const result = await terminateProcessTree(child, {
    escalationDelayMs: lifecycle.killEscalationDelayMs,
    forcedCloseGraceMs: lifecycle.forcedCloseGraceMs,
    fallbackToTrackedChild: false
  });
  if (!result.confirmed || !result.childCloseObserved) {
    throw new Error(result.error ?? `Process-tree termination could not be confirmed for process ${child.pid ?? "unknown"}`);
  }
  stateStore.audit({ tool: "subagent_task", kill: "confirmed", pid: child.pid, reason });
}

