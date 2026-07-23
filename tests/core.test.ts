import { optionalEnv } from "../src/env.js";
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
    permissions: {
      networkAccess: true,
      allowedCommands: ["git"]
    }
  },
  chatgpt: {
    permissions: {
      registerProjects: false,
      updatePermissions: false,
      spawnAgents: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      readGitIgnoredFiles: false,
      projectPatch: true,
      projectRun: false,
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
writeFileSync(configPath, JSON.stringify({
  agents: {
    defaultTemplate: "ephemeral-project-agent",
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
  traversal: {
    excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"]
  },
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
updatePermissions({ projectAlias: "test", permissions: { chatgpt: { projectEdit: false } } });

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
  assert.throws(() => assertChatGptPermission("projectEdit", "test"), /Permission denied/);
  updatePermissions({ projectAlias: "test", permissions: { chatgpt: { projectEdit: true } } });
  assert.doesNotThrow(() => assertChatGptPermission("projectEdit", "test"));
  assert.equal(getEffectivePermissions("test").chatgpt.projectEdit, true);
});

test("optionalEnv returns fallback when environment variable is missing, empty, or whitespace", () => {
  delete process.env.TEST_OPTIONAL_VAR;
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "default_val");

  process.env.TEST_OPTIONAL_VAR = "";
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "default_val");

  process.env.TEST_OPTIONAL_VAR = "   ";
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "default_val");

  process.env.TEST_OPTIONAL_VAR = "custom_path.json";
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "custom_path.json");

  delete process.env.TEST_OPTIONAL_VAR;
});


