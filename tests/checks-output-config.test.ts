import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-check-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
  scripts: {
    check: "node -e \"console.log('ok')\"",
    fail: "node -e \"console.error('bad'); process.exit(3)\""
  }
}, null, 2), "utf8");
writeFileSync(policyPath, JSON.stringify({
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
  main_agent: {
    permissions: {
      subagentTask: true,
      subagentContext: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      readGitIgnoredFiles: false,
      projectPatch: true,
      projectRun: false,
      projectPolicy: true, projectScreenshot: false,
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
    screenshot: { maxBytes: 8388608, maxWidth: 3840, maxHeight: 2160, maxStoredFilesPerSession: 20, maxTotalBytesPerProject: 104857600, maxAgeDays: 7, captureTimeoutMs: 10000, maxWindowWaitMs: 30000, windowTokenTtlMs: 30000, maxListPageSize: 100, minJpegQuality: 50, maxJpegQuality: 95 }
  },
  audit: {
    strictMode: false
  }
}, null, 2), "utf8");
writeFileSync(configPath, JSON.stringify({
  subagents: {
    defaultTemplate: "ephemeral-project-subagent",
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
  }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;

const { runProjectCheck } = await import("../src/runtime/checks.js");
const { limitText } = await import("../src/runtime/outputLimits.js");
const { listAgentProviderDefinitions, loadAgentProviderConfig, loadConfig } = await import("../src/config.js");

test("project checks return successful stdout", async () => {
  const result = await runProjectCheck(projectRoot, "check", 10000);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ok/);
});

test("project checks return failure stderr and exit code", async () => {
  const result = await runProjectCheck(projectRoot, "fail", 10000);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /bad/);
});

test("output limiter truncates long text", () => {
  const result = limitText("x".repeat(300000), 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 1024);
  assert.equal(result.chars, 1024);
  assert.equal(result.totalChars, 300000);
  assert.equal(result.omittedChars, 298976);
});

test("output limiter counts unicode code points as chars", () => {
  const result = limitText("a🙂b", 2);
  assert.equal(result.text, "a🙂");
  assert.equal(result.truncated, true);
  assert.equal(result.chars, 2);
  assert.equal(result.totalChars, 3);
  assert.equal(result.omittedChars, 1);
});

test("provider config reports missing OpenAI credential", () => {
  delete process.env.OPENAI_API_KEY;
  process.env.PORTUS_MCP_DEFAULT_PROVIDER = "openai";
  process.env.PORTUS_MCP_OPENAI_MODEL = "gpt-5.4-mini";
  assert.throws(() => loadAgentProviderConfig(), /Missing API key for selected provider/);
});

test("provider config reports missing Cloudflare account id", () => {
  process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cloudflare";
  process.env.PORTUS_MCP_CLOUDFLARE_MODEL = "@cf/google/gemma-4-26b-a4b-it";
  process.env.CLOUDFLARE_API_KEY = "test-key";
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.throws(() => loadAgentProviderConfig(), /Missing API key for selected provider/);
});

test("provider config resolves OpenRouter model and credential", () => {
  process.env.PORTUS_MCP_DEFAULT_PROVIDER = "openrouter";
  process.env.PORTUS_MCP_OPENROUTER_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
  process.env.OPENROUTER_API_KEY = "test-key";
  const provider = loadAgentProviderConfig();
  assert.equal(provider.provider, "openrouter");
  assert.equal(provider.model, "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
  assert.deepEqual(provider.requiredEnv, ["OPENROUTER_API_KEY"]);
});

test("provider registry documents supported providers in one place", () => {
  const definitions = listAgentProviderDefinitions();
  assert.deepEqual(Object.keys(definitions), ["openai", "cerebras", "gemini", "cloudflare", "openrouter"]);
  assert.equal(definitions.gemini.runtimeProvider, "google");
  assert.equal(definitions.cloudflare.qualifyModel("@cf/google/gemma-4-26b-a4b-it"), "cloudflare-workers-ai/@cf/google/gemma-4-26b-a4b-it");
  assert.equal(definitions.openrouter.qualifyModel("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"), "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
});

test("config validation rejects unknown top-level fields", () => {
  const original = readFileSync(configPath, "utf8");
  try {
    const invalid = { ...JSON.parse(original), unexpected: true };
    writeFileSync(configPath, JSON.stringify(invalid, null, 2), "utf8");
    assert.throws(() => loadConfig(), /Invalid config file.*unexpected/i);
  } finally {
    writeFileSync(configPath, original, "utf8");
  }
});

test("config validation rejects invalid path pattern arrays", () => {
  const original = readFileSync(configPath, "utf8");
  try {
    const invalid = { ...JSON.parse(original), traversal: { excludedPatterns: [".git", 12] } };
    writeFileSync(configPath, JSON.stringify(invalid, null, 2), "utf8");
    assert.throws(() => loadConfig(), /traversal\.excludedPatterns\.1/i);
  } finally {
    writeFileSync(configPath, original, "utf8");
  }
});


