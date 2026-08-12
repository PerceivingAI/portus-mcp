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
    subagents: {
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
      permissions: {
        networkAccess: true,
        allowedCommands: ["git"]
      }
    },
    main_agent: {
      permissions: {
        subagentTask: true,
        projectContext: true,
        projectRead: true,
        projectSearch: true,
        projectEdit: true,
        readGitIgnoredFiles: false,
        projectPatch: true,
        projectRun: false,
        projectPolicy: true,
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
        maxReadChars: 200000
      },
      subagentOutput: {
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
        maxOutputBufferMb: 10,
        maxBatchOutputChars: 1000000
      }
    },
    audit: {
      strictMode
    }
  }, null, 2), "utf8");
}
writePolicy(false);
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
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";
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

function resultOf(response: unknown): Record<string, unknown> {
  assert(response && typeof response === "object" && "structuredContent" in response);
  assert.equal("isError" in response ? response.isError : undefined, undefined);
  const structuredContent = response.structuredContent;
  assert(structuredContent && typeof structuredContent === "object" && "result" in structuredContent);
  const result = structuredContent.result;
  assert(result && typeof result === "object");
  return result as Record<string, unknown>;
}

test("strict audit mode blocks selected mutations when audit log is not writable", async (t) => {
  writePolicy(true);
  const client = await withClient(t);
  try {
    const writeDenied = resultOf(await client.callTool({
      name: "project_edit",
      arguments: {
        projectAlias: "audit",
        operations: [{ type: "write", relativePath: "created.txt", content: "should not write\n" }]
      }
    }));
    assert.equal(writeDenied.results[0].ok, false);
    assert.equal(writeDenied.repositoryState, "unchanged");
    assert.equal((writeDenied.results[0] as Record<string, unknown>).fileChanged, false);
    assert.equal(writeDenied.batchError, "Audit log is not writable: [redacted path]");
    assert.equal(existsSync(path.join(projectRoot, "created.txt")), false);
    assert.equal(writeDenied.batchMode, "staged");
    assert.equal(writeDenied.batchOutcome, "failed");
    assert.equal(writeDenied.errorCount, 0);
    assert.equal(writeDenied.skippedCount, 1);
    assert.equal(writeDenied.results[0].outcome, "skipped");
    assert.equal(writeDenied.results[0].reason, "batch_failed");

    const registrationDenied = await client.callTool({
      name: "project_policy",
      arguments: { action: { type: "register_project", projectAlias: "audit-denied", rootPath: projectRoot } }
    });
    assert.equal(registrationDenied.isError, true);
    assert.match(JSON.stringify(registrationDenied), /audit/i);
  } finally {
    writePolicy(false);
  }
});

test("project_edit reports sanitized filesystem causes", async (t) => {
  writePolicy(false);
  mkdirSync(path.join(projectRoot, "directory-target"), { recursive: true });
  const client = await withClient(t);
  const writeDenied = resultOf(await client.callTool({
    name: "project_edit",
    arguments: {
      projectAlias: "audit",
      operations: [{ type: "write", relativePath: "directory-target", content: "cannot replace a directory\n" }]
    }
  }));

  const operation = writeDenied.results[0] as Record<string, unknown>;
  assert.equal(operation.ok, false);
  assert.equal(operation.fileChanged, false);
  assert.equal("repositoryState" in operation, false);
  assert.equal(writeDenied.repositoryState, "unchanged");
  assert.match(String(operation.error), /EISDIR|EPERM|EACCES|illegal operation|permission denied|not a file/i);
  assert.equal(String(operation.error).includes(root), false);
});


