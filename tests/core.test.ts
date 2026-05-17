import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "# Test\n", "utf8");
writeFileSync(path.join(projectRoot, ".env"), "SECRET=hidden\n", "utf8");
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
      maxRuntimeSecs: 900,
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
}, null, 2), "utf8");
writeFileSync(configPath, JSON.stringify({
  projects: { allowedRootMode: "registered-only" },
  agents: {
    defaultTemplate: "ephemeral-project-agent",
    allowPersistentSessions: false,
    useFlueCli: true,
    retry: {
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 1500,
      maxDelayMs: 15000,
      jitterRatio: 0.2,
      retryOn: ["provider_rate_limited", "network_transient", "flue_startup_hang"],
      respectRetryAfter: true,
      maxRetryWindowSecs: 60
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
process.env.CEREBRAS_API_KEY = "test-key";

const { loadAgentProviderConfig } = await import("../src/config.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { resolveProjectPath } = await import("../src/policy/pathPolicy.js");
const { assertChatGptPermission } = await import("../src/policy/permissionPolicy.js");
const { getEffectivePermissions, updatePermissions } = await import("../src/state/PermissionRegistry.js");

upsertProject({ projectAlias: "test", rootPath: projectRoot });
updatePermissions({ projectAlias: "test", permissions: { chatgpt: { writeFiles: false } } });

test("provider config resolves default Cerebras model", () => {
  const provider = loadAgentProviderConfig();
  assert.equal(provider.provider, "cerebras");
  assert.equal(provider.model, "cerebras/llama3.1-8b");
});

test("path policy blocks project root escapes", () => {
  assert.throws(() => resolveProjectPath("test", "../outside.txt"), /escapes project root/);
});

test("path policy blocks configured sensitive paths", () => {
  assert.throws(() => resolveProjectPath("test", ".env"), /Blocked path pattern/);
});

test("path policy blocks configured sensitive paths case-insensitively", () => {
  assert.throws(() => resolveProjectPath("test", ".ENV"), /Blocked path pattern/);
});

test("permission policy denies disabled permissions and accepts runtime updates", () => {
  assert.throws(() => assertChatGptPermission("writeFiles", "test"), /Permission denied/);
  updatePermissions({ projectAlias: "test", permissions: { chatgpt: { writeFiles: true } } });
  assert.doesNotThrow(() => assertChatGptPermission("writeFiles", "test"));
  assert.equal(getEffectivePermissions("test").chatgpt.writeFiles, true);
});


