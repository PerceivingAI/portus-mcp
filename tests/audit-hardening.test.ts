import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-audit-hardening-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
function writePolicy(strictMode: boolean): void {
  writeFileSync(policyPath, JSON.stringify({
    agents: {
      concurrency: {
        maxConcurrent: 4,
        maxConcurrentPerProject: 2,
        queueEnabled: false,
        maxQueueDepth: 10
      },
      lifecycle: {
        queuedTaskTtlSecs: 300,
        projectLockTimeoutSecs: 1800,
        maxRuntimeSecs: 900,
        startupWatchdogMs: 15000,
        forcedCloseGraceMs: 8000,
        killEscalationDelayMs: 1200,
        queueDrainDelayMs: 50
      },
      capabilities: {
        networkAccess: true,
        allowedCommands: ["git"]
      }
    },
    permissions: {
      chatgpt: {
        registerProjects: false,
        updatePermissions: true,
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
    pathPolicy: {
      blockedPatterns: [".env"]
    },
    limits: {
      fileRead: {
        maxChars: 500000
      },
      fileWrite: {
        maxChars: 1000000
      },
      patch: {
        maxChars: 1000000
      },
      textEdit: {
        maxOperationChars: 200000,
        maxSearchOrMarkerChars: 20000
      },
      search: {
        maxScanEntries: 100000,
        maxTextFileChars: 200000
      },
      git: {
        maxDiffChars: 200000,
        maxUntrackedFileChars: 50000
      },
      skills: {
        maxReadChars: 200000
      },
      agentOutput: {
        maxStdoutChars: 200000,
        maxStderrChars: 200000
      },
      sessionEvents: {
        maxEvents: 500,
        maxChunkChars: 4000
      },
      audit: {
        maxEvents: 1000
      },
      process: {
        maxOutputBufferMb: 10
      }
    },
    audit: {
      strictMode
    }
  }, null, 2), "utf8");
}
writePolicy(false);
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
const { upsertProject } = await import("../src/state/ProjectRegistry.js");

upsertProject({ projectAlias: "audit", rootPath: projectRoot });
mkdirSync(path.join(stateDir, "audit.log"), { recursive: true });

async function withClient(t: any): Promise<Client> {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address && "port" in address);
  const client = new Client({ name: "audit-hardening-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

test("strict audit mode blocks selected mutations when audit log is not writable", async (t) => {
  writePolicy(true);
  const client = await withClient(t);
  try {
    const writeDenied = await client.callTool({
      name: "project_write_file",
      arguments: { projectAlias: "audit", relativePath: "created.txt", content: "should not write\n" }
    });
    assert.equal(writeDenied.isError, true);
    assert.equal(existsSync(path.join(projectRoot, "created.txt")), false);

    const permissionDenied = await client.callTool({
      name: "permission_update",
      arguments: { projectAlias: "audit", permissions: { chatgpt: { deleteFiles: true } } }
    });
    assert.equal(permissionDenied.isError, true);
  } finally {
    writePolicy(false);
  }
});


