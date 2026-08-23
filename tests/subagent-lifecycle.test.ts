import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = mkdtempSync(path.join(tmpdir(), "portus-subagents-test-"));
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
    subagents: {
      ...defaultPolicy.subagents,
      ...(overrides.subagents ?? {}),
      concurrency: { ...defaultPolicy.subagents.concurrency, ...(overrides.subagents?.concurrency ?? {}) },
      lifecycle: { ...defaultPolicy.subagents.lifecycle, ...(overrides.subagents?.lifecycle ?? {}) },
      permissions: { ...defaultPolicy.subagents.permissions, ...(overrides.subagents?.permissions ?? {}) }
    },
    main_agent: {
      ...defaultPolicy.main_agent,
      ...(overrides.main_agent ?? {}),
      permissions: { ...defaultPolicy.main_agent.permissions, ...(overrides.main_agent?.permissions ?? {}) }
    },
    pathPolicy: {
      ...defaultPolicy.pathPolicy,
      ...(overrides.pathPolicy ?? {})
    },
    limits: {
      ...defaultPolicy.limits,
      ...(overrides.limits ?? {}),
      fileRead: { ...defaultPolicy.limits.fileRead, ...(overrides.limits?.fileRead ?? {}) },
      fileWrite: { ...defaultPolicy.limits.fileWrite, ...(overrides.limits?.fileWrite ?? {}) },
      patch: { ...defaultPolicy.limits.patch, ...(overrides.limits?.patch ?? {}) },
      textEdit: { ...defaultPolicy.limits.textEdit, ...(overrides.limits?.textEdit ?? {}) },
      search: { ...defaultPolicy.limits.search, ...(overrides.limits?.search ?? {}) },
      skills: { ...defaultPolicy.limits.skills, ...(overrides.limits?.skills ?? {}) },
      subagentOutput: { ...defaultPolicy.limits.subagentOutput, ...(overrides.limits?.subagentOutput ?? {}) },
      sessionEvents: { ...defaultPolicy.limits.sessionEvents, ...(overrides.limits?.sessionEvents ?? {}) },
      audit: { ...defaultPolicy.limits.audit, ...(overrides.limits?.audit ?? {}) },
      process: { ...defaultPolicy.limits.process, ...(overrides.limits?.process ?? {}) }
    },
    audit: { ...defaultPolicy.audit, ...(overrides.audit ?? {}) }
  }, null, 2), "utf8");
}

const defaultPolicy = {
  subagents: {
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
    permissions: {
      networkAccess: true,
      allowedCommands: ["git"]
    }
  },
  main_agent: {
    permissions: {
      subagentTask: true,
      subagentContext: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      projectPatch: true,
      projectRun: true,
      projectPolicy: false, projectScreenshot: false,
      readGitIgnoredFiles: false,
      requireConfirmation: false,
      allowShell: false,
      allowedCommands: ["git"]
    }
  },
  pathPolicy: {
    blockedPatterns: [".env"]
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
      maxSearchOrMarkerChars: 20000,
      maxRangeLines: 2000
    },
    search: {
      maxScanEntries: 100000,
      maxTextFileChars: 200000,
      maxRegexExecutionMs: 120000,
      maxBatchMatches: 5000,
      maxBatchOutputChars: 500000
    },
    skills: {
      maxReadChars: 200000,
    },
    subagentOutput: {
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
      maxOutputBufferMb: 10,
      maxBatchOutputChars: 1000000
    },
    screenshot: { maxBytes: 8388608, maxWidth: 3840, maxHeight: 2160, captureTimeoutMs: 10000, maxWindowWaitMs: 30000, windowTokenTtlMs: 30000, maxListPageSize: 100, minJpegQuality: 50, maxJpegQuality: 95 }
  },
  audit: {
    strictMode: false
  }
};

writeDefaultFakeFlue();
writePolicy();
writeFileSync(configPath, JSON.stringify({
  subagents: {
    defaultTemplate: "ephemeral-project-subagent",
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
  traversal: {
    excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"]
  }
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
const { getSubagentLimits, runFlueTask, stopFlueTask } = await import("../src/flue/runTask.js");
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

test("subagent sessions complete and collect artifacts with mocked Flue", async () => {
  const started = await runFlueTask({ projectAlias: "agent", task: "SUCCESS TASK", agentTemplate: "ephemeral-project-subagent" });
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
    const started = await runFlueTask({ projectAlias: "agent", task: "ENV TASK", agentTemplate: "ephemeral-project-subagent" });
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

test("subagent sessions record failures with mocked Flue", async () => {
  writeDefaultFakeFlue();
  const started = await runFlueTask({ projectAlias: "agent", task: "FAIL TASK", agentTemplate: "ephemeral-project-subagent" });
  const failed = await waitForSession(started.sessionId, "failed");
  assert.equal(failed.exitCode, 7);
  assert.match(readFileSync(failed.stderrPath, "utf8"), /fake failure/);
  const eventTypes = readSessionEvents({ sessionId: started.sessionId }).events.map((event) => event.type);
  assert.equal(eventTypes.includes("stderr"), true);
  assert.equal(eventTypes.includes("failed"), true);
});

test("stopFlueTask stops a running mocked Flue session", async () => {
  writeDefaultFakeFlue();
  const started = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-subagent" });
  assert.equal(getSession(started.sessionId).status, "running");

  const stopped = await stopFlueTask(started.sessionId);
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
    agentTemplate: "ephemeral-project-subagent",
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
    agentTemplate: "ephemeral-project-subagent"
  });
  assert.equal(failed.status, "failed");
  const metadata = JSON.parse(readFileSync(failed.metadataPath, "utf8"));
  assert.equal(metadata.failureType, "flue_cli_missing");
  const eventTypes = readSessionEvents({ sessionId: failed.sessionId }).events.map((event) => event.type);
  assert.equal(eventTypes.includes("failed"), true);
  process.env.PORTUS_MCP_FLUE_CLI_PATH = original;
});

test("queue disabled rejects when concurrency limits are reached", async () => {
  writePolicy({ subagents: { concurrency: { maxConcurrent: 1, maxConcurrentPerProject: 1, queueEnabled: false } } });
  writeDefaultFakeFlue();

  const first = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-subagent" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "SECOND TASK", agentTemplate: "ephemeral-project-subagent" }),
    /queue is disabled/
  );
  await stopFlueTask(first.sessionId);
  await waitForSession(first.sessionId, "stopped");
  writePolicy();
});

test("subagent run is disabled when max concurrent subagents is zero", async () => {
  writePolicy({ subagents: { concurrency: { maxConcurrent: 0 } } });

  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "SUCCESS TASK", agentTemplate: "ephemeral-project-subagent" }),
    /Max concurrent subagents is set to 0/
  );
  const limits = getSubagentLimits("agent");
  assert.equal(limits.maxConcurrentAgents, 0);

  writePolicy();
});

test("subagent run is disabled when max concurrent subagents per project is zero", async () => {
  writePolicy({ subagents: { concurrency: { maxConcurrentPerProject: 0 } } });

  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "SUCCESS TASK", agentTemplate: "ephemeral-project-subagent" }),
    /Max concurrent subagents per project is set to 0/
  );
  const limits = getSubagentLimits("agent");
  assert.equal(limits.maxConcurrentAgentsPerProject, 0);

  writePolicy();
});

test("queue enabled enqueues and eventually executes task in order", async () => {
  writePolicy({ subagents: { concurrency: { maxConcurrent: 1, maxConcurrentPerProject: 1, queueEnabled: true, maxQueueDepth: 10 }, lifecycle: { queuedTaskTtlSecs: 300 } } });
  writeDefaultFakeFlue();

  const first = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-subagent" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await runFlueTask({ projectAlias: "agent", task: "SUCCESS QUEUED TASK", agentTemplate: "ephemeral-project-subagent" });
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
  const limits = getSubagentLimits("agent");
  assert.equal(limits.queueDepth, 0);
  writePolicy();
});

test("stopFlueTask terminates descendants before reporting stopped", async () => {
  writeFileSync(fakeFluePath, `
import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("descendant:" + descendant.pid);
await new Promise(() => {});
`, "utf8");

  const started = await runFlueTask({ projectAlias: "agent", task: "DESCENDANT TASK", agentTemplate: "ephemeral-project-subagent" });
  let descendantPid = 0;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && descendantPid === 0) {
    const match = readFileSync(started.stdoutPath, "utf8").match(/descendant:(\d+)/);
    descendantPid = match ? Number(match[1]) : 0;
    if (descendantPid === 0) await sleep(20);
  }
  assert.equal(descendantPid > 0, true);

  const stopped = await stopFlueTask(started.sessionId);
  assert.equal(stopped.status, "stopped");
  assert.throws(() => process.kill(descendantPid, 0));
  writeDefaultFakeFlue();
});

test("termination failure retains running state and project lock", async () => {
  writeDefaultFakeFlue();
  const started = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-subagent" });
  const originalPath = process.env.PATH;
  const originalKill = process.kill;
  if (process.platform === "win32") {
    const failingBin = path.join(root, "failing-bin");
    mkdirSync(failingBin, { recursive: true });
    writeFileSync(path.join(failingBin, "taskkill.cmd"), "@exit /b 9\r\n", "utf8");
    process.env.PATH = failingBin;
  } else {
    process.kill = (() => {
      const error = new Error("injected termination failure") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;
  }

  await assert.rejects(() => stopFlueTask(started.sessionId), /taskkill failed|injected termination failure|ENOENT/);
  assert.equal(getSession(started.sessionId).status, "running");
  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "LOCK MUST REMAIN", agentTemplate: "ephemeral-project-subagent" }),
    /Project lock active/
  );
  assert.equal(readSessionEvents({ sessionId: started.sessionId }).events.some((event) => event.type === "termination_failed"), true);

  process.env.PATH = originalPath;
  process.kill = originalKill;
  await stopFlueTask(started.sessionId);
});

test("stopping running session releases lock for subsequent sessions", async () => {
  writePolicy({ subagents: { concurrency: { maxConcurrent: 1, maxConcurrentPerProject: 1, queueEnabled: false } } });
  writeDefaultFakeFlue();

  const first = await runFlueTask({ projectAlias: "agent", task: "SLEEP TASK", agentTemplate: "ephemeral-project-subagent" });
  const stopPromise = stopFlueTask(first.sessionId);
  await assert.rejects(
    () => runFlueTask({ projectAlias: "agent", task: "TOO EARLY", agentTemplate: "ephemeral-project-subagent" }),
    /Project lock active/
  );
  const stopped = await stopPromise;
  assert.equal(stopped.status, "stopped");

  const second = await runFlueTask({ projectAlias: "agent", task: "SUCCESS AFTER STOP", agentTemplate: "ephemeral-project-subagent" });
  const completed = await waitForSession(second.sessionId, "completed");
  assert.equal(completed.status, "completed");
  writePolicy();
});
