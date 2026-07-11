import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-pre-reg-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const secondProjectRoot = path.join(root, "project-two");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");

mkdirSync(projectRoot, { recursive: true });
mkdirSync(secondProjectRoot, { recursive: true });
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

const previousEnvironment: Record<string, string | undefined> = {
  PORTUS_MCP_CONFIG_PATH: process.env.PORTUS_MCP_CONFIG_PATH,
  PORTUS_MCP_POLICY_PATH: process.env.PORTUS_MCP_POLICY_PATH,
  PORTUS_MCP_STATE_DIR: process.env.PORTUS_MCP_STATE_DIR,
  PORTUS_MCP_PROJECTS: process.env.PORTUS_MCP_PROJECTS
};
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_PROJECTS = `pre=${projectRoot};second=${secondProjectRoot}`;

// Environment-backed state paths must be installed before loading stateful server modules.
const { listProjects, upsertProject } = await import("../src/state/ProjectRegistry.js");
const { createHttpServer } = await import("../src/server.js");

test("pre-registered projects env is loaded into project registry list", () => {
  const projects = listProjects();
  assert.equal(projects.some((item) => item.projectAlias === "pre"), true);
  assert.equal(projects.some((item) => item.projectAlias === "second"), true);
});

test("project_context safely discovers persisted and environment aliases before scoped use", async (t) => {
  upsertProject({ projectAlias: "persisted", rootPath: projectRoot });
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "pre-registered-projects-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await client.connect(transport);

  const discoveryResponse = await client.callTool({
    name: "project_context",
    arguments: { include: { projects: true } }
  });
  assert.equal(discoveryResponse.isError, undefined);
  const serializedDiscovery = JSON.stringify(discoveryResponse.structuredContent);
  for (const alias of ["persisted", "pre", "second"]) {
    assert.match(serializedDiscovery, new RegExp(`"${alias}"`));
  }
  for (const privateValue of [projectRoot, secondProjectRoot, "rootPath", "createdAt", "updatedAt"]) {
    assert.equal(serializedDiscovery.includes(privateValue), false, `discovery leaked ${privateValue}`);
  }

  const unscoped = await client.callTool({
    name: "project_context",
    arguments: { include: { status: true } }
  });
  assert.equal(unscoped.isError, true);
  assert.match(JSON.stringify(unscoped.structuredContent), /projectAlias/i);

  const scoped = await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "pre", include: { status: true } }
  });
  assert.equal(scoped.isError, undefined);
  assert.match(JSON.stringify(scoped.structuredContent), /"projectAlias":"pre"/);
});

test.after(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});


