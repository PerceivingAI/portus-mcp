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
      registerProjects: true,
      updatePermissions: false,
      spawnAgents: true,
      readFiles: true,
      writeFiles: true,
      moveFiles: false,
      deleteFiles: false,
      readGitIgnoredFiles: false,
      runPackageScripts: false,
      allowedCommands: ["git"]
    }
  },
  pathPolicy: {
    blockedPatterns: [".env"]
  },
  limits: {
    fileRead: {
      maxChars: 5,
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
};

function writePolicy(policy = basePolicy): void {
  writeFileSync(policyPath, JSON.stringify(policy, null, 2), "utf8");
}

writePolicy();
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

test("project reads use configured maxReadChars", async (t) => {
  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "read-max", rootPath: projectRoot } }));

  const read = resultOf(await client.callTool({
    name: "project_read_text_file",
    arguments: { projectAlias: "read-max", relativePath: "README.md" }
  }));

  assert.equal(read.limit, 5);
  assert.equal(read.truncated, true);
  assert.equal(read.chars, 5);
  assert.equal(read.totalChars, 27);
  assert.equal(read.omittedChars, 22);
  assert.equal(read.content.length, 5);
  assert.match(read.content, /^abcde/);
});

test("project read tools do not expose caller char limit arguments", async (t) => {
  const client = await withClient(t);
  const tools = await client.listTools();
  const readTool = tools.tools.find((tool) => tool.name === "project_read_text_file");
  assert(readTool);

  assert.equal(JSON.stringify(readTool.inputSchema).includes("maxChars"), false);
});

test("text input limits count Unicode code points", async (t) => {
  writePolicy({
    ...basePolicy,
    limits: {
      ...basePolicy.limits,
      fileWrite: { maxChars: 1 },
      textEdit: {
        ...basePolicy.limits.textEdit,
        maxOperationChars: 1,
        maxSearchOrMarkerChars: 1
      }
    }
  });
  t.after(() => writePolicy());

  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "unicode-input", rootPath: projectRoot } }));

  const write = resultOf(await client.callTool({
    name: "project_write_file",
    arguments: { projectAlias: "unicode-input", relativePath: "emoji.txt", content: "🙂" }
  }));
  assert.equal(write.bytes, Buffer.byteLength("🙂", "utf8"));

  const rejectedWrite = await client.callTool({
    name: "project_write_file",
    arguments: { projectAlias: "unicode-input", relativePath: "too-many.txt", content: "🙂🙂" }
  });
  assert.equal(rejectedWrite.isError, true);
  assert.match(JSON.stringify(rejectedWrite.structuredContent), /limits\.fileWrite\.maxChars/);
});

test("policy validation rejects the removed flat policy layout", () => {
  writePolicy({
    ...basePolicy,
    output: {
      maxReadChars: 11
    }
  });

  assert.throws(() => loadPolicyConfig(), /output/);
  writePolicy();
});


