import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-read-limits-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "abcdefghijklmnopqrstuvwxyz\n", "utf8");

const basePolicy = {
  agents: {
    maxConcurrent: 4,
    maxConcurrentPerProject: 2,
    queueEnabled: false,
    maxQueueDepth: 10,
    queuedTaskTtlSecs: 300,
    projectLockTimeoutSecs: 1800,
    maxRuntimeSecs: 900,
    startupWatchdogMs: 15000,
    forcedCloseGraceMs: 8000,
    killEscalationDelayMs: 1200,
    queueDrainDelayMs: 50,
    networkAccess: true,
    grantCommands: true,
    gitCommand: true,
    packageManagerCommand: false,
    nodeCommand: false
  },
  chatgpt: {
    registerProjects: true,
    updatePermissions: false,
    spawnAgents: true,
    readFiles: true,
    writeFiles: true,
    moveFiles: false,
    deleteFiles: false,
    readGitIgnoredFiles: false,
    runPackageScripts: false,
    gitCommands: true
  },
  output: {
    maxStdoutBytes: 200000,
    maxStderrBytes: 200000,
    defaultReadBytes: 5,
    maxReadBytes: 10,
    maxSkillReadBytes: 200000,
    maxSearchScanEntries: 100000,
    defaultEventLimit: 100,
    maxEventLimit: 500,
    maxEventChunkChars: 4000,
    defaultAuditLimit: 100,
    maxAuditLimit: 1000,
    maxProcessOutputBufferBytes: 10485760
  },
  input: {
    maxWriteBytes: 1000000,
    maxPatchBytes: 1000000,
    maxTextOperationBytes: 200000,
    maxSearchOrMarkerBytes: 20000
  },
  audit: {
    strictMode: false
  }
};

function writePolicy(policy = basePolicy): void {
  writeFileSync(policyPath, JSON.stringify(policy, null, 2), "utf8");
}

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

const { createHttpServer } = await import("../src/server.js");
const { loadPolicyConfig } = await import("../src/policy/policyConfig.js");

function resultOf(response: any): any {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return response.structuredContent.result;
}

async function withClient(t: any): Promise<Client> {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address && "port" in address);
  const client = new Client({ name: "read-limits-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

test("project reads use configured defaultReadBytes", async (t) => {
  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "read-default", rootPath: projectRoot } }));

  const read = resultOf(await client.callTool({
    name: "project_read_text_file",
    arguments: { projectAlias: "read-default", relativePath: "README.md" }
  }));

  assert.equal(read.limit, 5);
  assert.equal(read.truncated, true);
  assert.match(read.content, /^abcde/);
});

test("project reads allow maxBytes up to configured maxReadBytes", async (t) => {
  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "read-max", rootPath: projectRoot } }));

  const read = resultOf(await client.callTool({
    name: "project_read_text_file",
    arguments: { projectAlias: "read-max", relativePath: "README.md", maxBytes: 10 }
  }));

  assert.equal(read.limit, 10);
  assert.equal(read.truncated, true);
  assert.match(read.content, /^abcdefghij/);
});

test("project reads reject maxBytes above configured maxReadBytes", async (t) => {
  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "read-reject", rootPath: projectRoot } }));

  const response = await client.callTool({
    name: "project_read_text_file",
    arguments: { projectAlias: "read-reject", relativePath: "README.md", maxBytes: 11 }
  });

  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.structuredContent), /maxReadBytes/);
});

test("policy validation rejects defaultReadBytes above maxReadBytes", () => {
  writePolicy({
    ...basePolicy,
    output: {
      ...basePolicy.output,
      defaultReadBytes: 11,
      maxReadBytes: 10
    }
  });

  assert.throws(() => loadPolicyConfig(), /defaultReadBytes must be less than or equal to maxReadBytes/);
  writePolicy();
});

test("policy validation rejects defaultEventLimit above maxEventLimit", () => {
  writePolicy({
    ...basePolicy,
    output: {
      ...basePolicy.output,
      defaultEventLimit: 501,
      maxEventLimit: 500
    }
  });

  assert.throws(() => loadPolicyConfig(), /defaultEventLimit must be less than or equal to maxEventLimit/);
  writePolicy();
});

test("policy validation rejects defaultAuditLimit above maxAuditLimit", () => {
  writePolicy({
    ...basePolicy,
    output: {
      ...basePolicy.output,
      defaultAuditLimit: 1001,
      maxAuditLimit: 1000
    }
  });

  assert.throws(() => loadPolicyConfig(), /defaultAuditLimit must be less than or equal to maxAuditLimit/);
  writePolicy();
});
