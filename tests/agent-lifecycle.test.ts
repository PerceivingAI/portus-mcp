import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-agent-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const fakeFluePath = path.join(root, "fake-flue.mjs");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });

function writeDefaultFakeFlue(): void {
  writeFileSync(fakeFluePath, `
const payloadIndex = process.argv.indexOf("--payload");
const payload = payloadIndex >= 0 ? JSON.parse(process.argv[payloadIndex + 1]) : {};
if (payload.task.includes("FAIL")) {
  console.error("fake failure");
  process.exit(7);
}
if (payload.task.includes("SLEEP")) {
  console.log("started sleep");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log("finished sleep");
  process.exit(0);
}
console.log("fake success");
console.log(payload.task);
process.exit(0);
`, "utf8");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function writePolicy(overrides: DeepPartial<typeof defaultPolicy> = {}): void {
  writeFileSync(policyPath, JSON.stringify({
    ...defaultPolicy,
    ...overrides,
    agents: {
      ...defaultPolicy.agents,
      ...(overrides.agents ?? {}),
      concurrency: { ...defaultPolicy.agents.concurrency, ...(overrides.agents?.concurrency ?? {}) },
      lifecycle: { ...defaultPolicy.agents.lifecycle, ...(overrides.agents?.lifecycle ?? {}) },
      capabilities: { ...defaultPolicy.agents.capabilities, ...(overrides.agents?.capabilities ?? {}) }
    },
    permissions: {
      ...defaultPolicy.permissions,
      ...(overrides.permissions ?? {}),
      chatgpt: { ...defaultPolicy.permissions.chatgpt, ...(overrides.permissions?.chatgpt ?? {}) }
    },
    limits: {
      ...defaultPolicy.limits,
      ...(overrides.limits ?? {}),
      fileRead: { ...defaultPolicy.limits.fileRead, ...(overrides.limits?.fileRead ?? {}) },
      fileWrite: { ...defaultPolicy.limits.fileWrite, ...(overrides.limits?.fileWrite ?? {}) },
      patch: { ...defaultPolicy.limits.patch, ...(overrides.limits?.patch ?? {}) },
      textEdit: { ...defaultPolicy.limits.textEdit, ...(overrides.limits?.textEdit ?? {}) },
      search: { ...defaultPolicy.limits.search, ...(overrides.limits?.search ?? {}) },
      git: { ...defaultPolicy.limits.git, ...(overrides.limits?.git ?? {}) },
      skills: { ...defaultPolicy.limits.skills, ...(overrides.limits?.skills ?? {}) },
      agentOutput: { ...defaultPolicy.limits.agentOutput, ...(overrides.limits?.agentOutput ?? {}) },
      sessionEvents: { ...defaultPolicy.limits.sessionEvents, ...(overrides.limits?.sessionEvents ?? {}) },
      audit: { ...defaultPolicy.limits.audit, ...(overrides.limits?.audit ?? {}) },
      process: { ...defaultPolicy.limits.process, ...(overrides.limits?.process ?? {}) }
    },
    audit: { ...defaultPolicy.audit, ...(overrides.audit ?? {}) }
  }, null, 2), "utf8");
}

const defaultPolicy = {
  agents: {
    concurrency: {
      maxConcurrent: 4,
      maxConcurrentPerProject: 2,
      queueEnabled: false,
      maxQueueDepth: 10,
    },
    lifecycle: {
      queuedTaskTtlSecs: 300,
      projectLockTimeoutSecs: 1800,
      maxRuntimeSecs: 10,
      startupWatchdogMs: 15000,
      forcedCloseGraceMs: 8000,
      killEscalationDelayMs: 1200,
      queueDrainDelayMs: 50,
    },
    capabilities: {
      networkAccess: true,
      grantCommands: true,
      gitCommand: true,
      packageManagerCommand: false,
      nodeCommand: false
    }
  },
  permissions: {
    chatgpt: {
      registerProjects: false,
      updatePermissions: false,
      spawnAgents: true,
      readFiles: true,
      writeFiles: true,
      moveFiles: false,
      deleteFiles: false,
      readGitIgnoredFiles: false,
      runPackageScripts: false,
      gitCommands: true
    }
  },
  limits: {
    fileRead: {
      maxChars: 500000,
    },
    fileWrite: {
      maxChars: 1000000,
    },
    patch: {
      maxChars: 1000000,
    },
    textEdit: {
      maxOperationChars: 200000,
      maxSearchOrMarkerChars: 20000
    },
    search: {
      maxScanEntries: 100000,
      maxTextFileChars: 200000,
    },
    git: {
      maxDiffChars: 200000,
      maxUntrackedFileChars: 50000,
    },
    skills: {
      maxReadChars: 200000,
    },
    agentOutput: {
      maxStdoutChars: 200000,
      maxStderrChars: 200000,
    },
    sessionEvents: {
      maxEvents: 500,
      maxChunkChars: 4000,
    },
    audit: {
      maxEvents: 1000,
    },
    process: {
      maxOutputBufferMb: 10
    }
  },
  audit: {
    strictMode: false
  }
};

writeDefaultFakeFlue();
writePolicy();
writeFileSync(configPath, JSON.stringify({
  projects: { allowedRootMode: "registered-only" },
  agents: {
    defaultTemplate: "ephemeral-project-agent",
    allowPersistentSessions: false,
    useFlueCli: true,
    retry: {
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      jitterRatio: 0,
      retryOn: ["provider_rate_limited", "network_transient", "flue_startup_hang"],
      respectRetryAfter: true,
      maxRetryWindowSecs: 1
    }
  },
  blockedPathPatterns: [".env"],
  skills: { directory: "skills" }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.PORTUS_MCP_FLUE_CLI_PATH = fakeFluePath;
process.env.CEREBRAS_API_KEY = "test-key";

const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { getAgentLimits, runFlueTask, stopFlueTask } = await import("../src/flue/runTask.js");
const { getSession } = await import("../src/state/SessionRegistry.js");
const { readSessionEvents } = await import("../src/state/SessionEvents.js");
const { collectFlueResult } = await import("../src/flue/collectResult.js");

upsertProject({ projectAlias: "agent", rootPath: projectRoot });

async function waitForSession(sessionId: string, expected: "completed" | "failed" | "stopped") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const session = getSession(sessionId);
    if (session.status === expected) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${sessionId} to become ${expected}`);
}

test("agent sessions complete and collect artifacts with mocked Flue", async () => {
  const started = await runFlueTask({ projectAlias: "agent", task: "SUCCESS TASK", agentTemplate: "ephemeral-project-agent" });
  assert.equal(started.status, "running");

  const completed = await waitForSession(started.sessionId, "completed");
  assert.equal(completed.exitCode, 0);
  assert.equal(existsSync(completed.stdoutPath), true);

  const outputs = collectFlueResult(started.sessionId);
  assert.match(outputs.stdout, /fake success/);
  assert.match(outputs.stdout, /SUCCESS TASK/);
  const events = readSessionEvents({ sessionId: started.sessionId });
  const eventTypes = events.events.map((event) => event.type);
  for (const type of ["created", "started", "attempt_started", "stdout", "attempt_finished", "completed"]) {
    assert.equal(eventTypes.includes(type), true);
  }
  assert.equal(events.hasMore, false);
  assert.equal(events.nextSequence, events.events.at(-1)?.sequence);
});

test("OpenRouter child env includes only active provider credential", async () => {
  const original = {
    provider: process.env.PORTUS_MCP_DEFAULT_PROVIDER,
    cerebrasModel: process.env.PORTUS_MCP_CEREBRAS_MODEL,
    openrouterModel: process.env.PORTUS_MCP_OPENROUTER_MODEL,
    cerebrasKey: process.env.CEREBRAS_API_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
    openrouterKey: process.env.OPENROUTER_API_KEY
  };
  process.env.PORTUS_MCP_DEFAULT_PROVIDER = "openrouter";
  process.env.PORTUS_MCP_OPENROUTER_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  process.env.OPENAI_API_KEY = "inactive-openai-key";
  process.env.CEREBRAS_API_KEY = "inactive-cerebras-key";
  writeFileSync(fakeFluePath, `
console.log(JSON.stringify({
  provider: process.env.PORTUS_MCP_DEFAULT_PROVIDER,
  openrouter: process.env.OPENROUTER_API_KEY ?? null,
  openai: process.env.OPENAI_API_KEY ?? null,
  cerebras: process.env.CEREBRAS_API_KEY ?? null
}));
process.exit(0);
`, "utf8");

  try {
    const started = await runFlueTask({ projectAlias: "agent", task: "ENV TASK", agentTemplate: "ephemeral-project-agent" });
    const completed = await waitForSession(started.sessionId, "completed");
    const stdout = readFileSync(completed.stdoutPath, "utf8");
    const childEnvLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
    assert.equal(typeof childEnvLine, "string");
    const childEnv = JSON.parse(childEnvLine);
    assert.equal(childEnv.provider, "openrouter");
    assert.equal(childEnv.openrouter, "openrouter-test-key");
    assert.equal(childEnv.openai, null);
    assert.equal(childEnv.cerebras, null);
  } finally {
    writeDefaultFakeFlue();
    restoreEnv("PORTUS_MCP_DEFAULT_PROVIDER", original.provider);
    restoreEnv("PORTUS_MCP_CEREBRAS_MODEL", original.cerebrasModel);
    restoreEnv("PORTUS_MCP_OPENROUTER_MODEL", original.openrouterModel);
    restoreEnv("CEREBRAS_API_KEY", original.cerebrasKey);
    restoreEnv("OPENAI_API_KEY", original.openaiKey);
    restoreEnv("OPENROUTER_API_KEY", original.openrouterKey);
  }
});


test("agent sessions record failures with mocked Flue", async () => {
  writeDefaultFakeFlue();
  const started = await runFlueTask({ projectAlias: "agent", task: "FAIL TASK", agentTemplate: "ephemeral-project-agent" });
  const failed = await waitForSession(started.sessionId, "failed");
  assert.equal(failed.exitCode, 7);
  assert.match(readFileSync(failed.stderrPath, "utf8"), /fake failure/);
  const eventTypes = readSessionEvents({ sessionId: started.sessionId }).events.map((event) => event.type);
  assert.equal(eventTypes.includes("stderr"), true);
  assert.equal(eventTypes.includes("failed"), true);
});

test("agent_stop stops a running mocked Flue session", async () => {
  writeDefaultFakeFlue();
  const started = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-agent" });
  assert.equal(getSession(started.sessionId).status, "running");

  const stopped = stopFlueTask(started.sessionId);
  assert.equal(stopped.status, "stopped");
  const final = await waitForSession(started.sessionId, "stopped");
  assert.equal(final.status, "stopped");
  const eventTypes = readSessionEvents({ sessionId: started.sessionId }).events.map((event) => event.type);
  assert.equal(eventTypes.includes("stopped"), true);
});

test("hung attempt times out and transitions to failed", async () => {
  writeFileSync(fakeFluePath, `
await new Promise(() => {});
`, "utf8");

  const started = await runFlueTask({
    projectAlias: "agent",
    task: "HANG TASK",
    agentTemplate: "ephemeral-project-agent",
    timeoutSecs: 1
  });
  const failed = await waitForSession(started.sessionId, "failed");
  assert.equal(failed.status, "failed");
  const metadata = JSON.parse(readFileSync(failed.metadataPath, "utf8"));
  assert.equal(Array.isArray(metadata.attempts), true);
  assert.equal(metadata.attempts.length >= 1, true);
  assert.equal(typeof metadata.failureType, "string");
  const eventTypes = readSessionEvents({ sessionId: started.sessionId }).events.map((event) => event.type);
  assert.equal(eventTypes.includes("attempt_finished"), true);
  assert.equal(eventTypes.includes("failed"), true);
});

test("missing flue cli path fails fast with flue_cli_missing", async () => {
  const original = process.env.PORTUS_MCP_FLUE_CLI_PATH;
  process.env.PORTUS_MCP_FLUE_CLI_PATH = path.join(root, "missing-flue-cli.mjs");
  const failed = await runFlueTask({
    projectAlias: "agent",
    task: "MISSING CLI TASK",
    agentTemplate: "ephemeral-project-agent"
  });
  assert.equal(failed.status, "failed");
  const metadata = JSON.parse(readFileSync(failed.metadataPath, "utf8"));
  assert.equal(metadata.failureType, "flue_cli_missing");
  const eventTypes = readSessionEvents({ sessionId: failed.sessionId }).events.map((event) => event.type);
  assert.equal(eventTypes.includes("failed"), true);
  process.env.PORTUS_MCP_FLUE_CLI_PATH = original;
});

test("queue disabled rejects when concurrency limits are reached", async () => {
  writePolicy({ agents: { concurrency: { maxConcurrent: 1, maxConcurrentPerProject: 1, queueEnabled: false } } });
  writeDefaultFakeFlue();

  const first = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-agent" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "SECOND TASK", agentTemplate: "ephemeral-project-agent" }),
    /queue is disabled/
  );
  stopFlueTask(first.sessionId);
  await waitForSession(first.sessionId, "stopped");
  writePolicy();
});

test("agent run is disabled when max concurrent agents is zero", async () => {
  writePolicy({ agents: { concurrency: { maxConcurrent: 0 } } });

  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "SUCCESS TASK", agentTemplate: "ephemeral-project-agent" }),
    /Max concurrent agents is set to 0/
  );
  const limits = getAgentLimits("agent");
  assert.equal(limits.maxConcurrentAgents, 0);

  writePolicy();
});

test("agent run is disabled when max concurrent agents per project is zero", async () => {
  writePolicy({ agents: { concurrency: { maxConcurrentPerProject: 0 } } });

  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "SUCCESS TASK", agentTemplate: "ephemeral-project-agent" }),
    /Max concurrent agents per project is set to 0/
  );
  const limits = getAgentLimits("agent");
  assert.equal(limits.maxConcurrentAgentsPerProject, 0);

  writePolicy();
});

test("queue enabled enqueues and eventually executes task in order", async () => {
  writePolicy({ agents: { concurrency: { maxConcurrent: 1, maxConcurrentPerProject: 1, queueEnabled: true, maxQueueDepth: 10 }, lifecycle: { queuedTaskTtlSecs: 300 } } });
  writeDefaultFakeFlue();

  const first = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-agent" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await runFlueTask({ projectAlias: "agent", task: "SUCCESS QUEUED TASK", agentTemplate: "ephemeral-project-agent" });
  assert.equal(second.status, "queued");
  assert.equal(readSessionEvents({ sessionId: second.sessionId }).events.some((event) => event.type === "queued"), true);
  const secondQueued = getSession(second.sessionId);
  assert.equal(secondQueued.status, "queued");

  const completedFirst = await waitForSession(first.sessionId, "completed");
  assert.equal(completedFirst.status, "completed");
  const completedSecond = await waitForSession(second.sessionId, "completed");
  assert.equal(completedSecond.status, "completed");
  const secondEventTypes = readSessionEvents({ sessionId: second.sessionId }).events.map((event) => event.type);
  assert.equal(secondEventTypes.includes("dequeued"), true);
  assert.equal(secondEventTypes.includes("completed"), true);
  const limits = getAgentLimits("agent");
  assert.equal(limits.queueDepth, 0);
  writePolicy();
});

test("stopping running session releases lock for subsequent sessions", async () => {
  writePolicy({ agents: { concurrency: { maxConcurrent: 1, maxConcurrentPerProject: 1, queueEnabled: false } } });
  writeDefaultFakeFlue();

  const first = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-agent" });
  const stopped = stopFlueTask(first.sessionId);
  assert.equal(stopped.status, "stopped");
  await waitForSession(first.sessionId, "stopped");

  const second = await runFlueTask({ projectAlias: "agent", task: "SUCCESS AFTER STOP", agentTemplate: "ephemeral-project-agent" });
  const completed = await waitForSession(second.sessionId, "completed");
  assert.equal(completed.status, "completed");
  writePolicy();
});


