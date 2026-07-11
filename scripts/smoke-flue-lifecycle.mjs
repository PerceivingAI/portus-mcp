import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-flue-lifecycle-smoke-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const fakeFluePath = path.join(root, "fake-flue.mjs");

mkdirSync(projectRoot, { recursive: true });

writeFileSync(fakeFluePath, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const payloadIndex = process.argv.indexOf("--payload");
const payload = payloadIndex >= 0 ? JSON.parse(process.argv[payloadIndex + 1]) : {};
const cwd = process.cwd();
if (String(payload.task).includes("CONTROLLED FAILURE")) {
  console.error("controlled failure");
  process.exit(9);
}
if (String(payload.task).includes("CHECK COMMAND")) {
  console.log("check command simulated");
  process.exit(0);
}
if (String(payload.task).includes("DIRECT WRITE")) {
  const filePath = path.join(cwd, "FLUE_LIFECYCLE_TEST.md");
  writeFileSync(filePath, "lifecycle smoke direct write ok\\n", "utf8");
  console.log("direct write completed");
  process.exit(0);
}
appendFileSync(path.join(cwd, "UNEXPECTED_TASK.log"), String(payload.task) + "\\n");
process.exit(0);
`, "utf8");

writeFileSync(configPath, JSON.stringify({
  agents: {
    defaultTemplate: "ephemeral-project-agent",
    retry: {
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      jitterRatio: 0,
      retryOn: ["provider_rate_limited", "network_transient", "flue_startup_hang"],
      respectRetryAfter: true,
      maxRetryWindowSecs: 1
    }
  },
  traversal: {
    excludedPatterns: [
      ".git",
      "node_modules",
      "dist",
      ".portus-mcp",
      ".flue",
      "coverage",
      ".next",
      ".cache"
    ]
  },
  skills: { directory: "skills" }
}, null, 2), "utf8");

writeFileSync(policyPath, JSON.stringify({
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
      maxRuntimeSecs: 30,
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
  chatgpt: {
    permissions: {
      registerProjects: true,
      updatePermissions: true,
      spawnAgents: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      readGitIgnoredFiles: false,
      projectPatch: true,
      projectRun: true,
      projectPolicy: true,
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
      maxSearchOrMarkerChars: 20000
    },
    search: {
      maxScanEntries: 100000,
      maxTextFileChars: 200000,
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
}, null, 2), "utf8");

process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.PORTUS_MCP_FLUE_CLI_PATH = fakeFluePath;
process.env.CEREBRAS_API_KEY = "fake-key";

const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { getSession } = await import("../src/state/SessionRegistry.js");
const { runFlueTask } = await import("../src/flue/runTask.js");

upsertProject({ projectAlias: "smoke", rootPath: projectRoot });

async function waitForTerminalStatus(sessionId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const session = getSession(sessionId);
    if (session.status === "completed" || session.status === "failed" || session.status === "stopped") {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session ${sessionId}`);
}

try {
  const writeRun = await runFlueTask({ projectAlias: "smoke", task: "DIRECT WRITE", agentTemplate: "ephemeral-project-agent" });
  const writeDone = await waitForTerminalStatus(writeRun.sessionId);
  if (writeDone.status !== "completed") throw new Error("Direct write task did not complete.");
  readFileSync(path.join(projectRoot, "FLUE_LIFECYCLE_TEST.md"), "utf8");

  const checkRun = await runFlueTask({ projectAlias: "smoke", task: "CHECK COMMAND", agentTemplate: "ephemeral-project-agent" });
  const checkDone = await waitForTerminalStatus(checkRun.sessionId);
  if (checkDone.status !== "completed") throw new Error("Check command task did not complete.");

  const failRun = await runFlueTask({ projectAlias: "smoke", task: "CONTROLLED FAILURE", agentTemplate: "ephemeral-project-agent" });
  const failDone = await waitForTerminalStatus(failRun.sessionId);
  if (failDone.status !== "failed") throw new Error("Controlled failure task did not fail as expected.");

  console.log(JSON.stringify({
    status: "passed",
    projectRoot,
    directWriteSession: writeRun.sessionId,
    checkSession: checkRun.sessionId,
    failureSession: failRun.sessionId
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}



