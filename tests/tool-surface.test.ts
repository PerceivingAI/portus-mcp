import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-tool-surface-"));
const configPath = path.join(root, "config.json");
const previousConfigPath = process.env.PORTUS_MCP_CONFIG_PATH;
const previousAgentSkillPaths = process.env.AGENT_SKILL_PATHS;
const previousSubagentSkillPaths = process.env.SUBAGENTS_SKILL_PATHS;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";

test.after(() => {
  if (previousConfigPath === undefined) delete process.env.PORTUS_MCP_CONFIG_PATH;
  else process.env.PORTUS_MCP_CONFIG_PATH = previousConfigPath;
  if (previousAgentSkillPaths === undefined) delete process.env.AGENT_SKILL_PATHS;
  else process.env.AGENT_SKILL_PATHS = previousAgentSkillPaths;
  if (previousSubagentSkillPaths === undefined) delete process.env.SUBAGENTS_SKILL_PATHS;
  else process.env.SUBAGENTS_SKILL_PATHS = previousSubagentSkillPaths;
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(configPath, JSON.stringify({
    subagents: {
      defaultTemplate: "ephemeral-project-subagent",
      retry: {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 1500,
        maxDelayMs: 15000,
        jitterRatio: 0.2,
        retryOn: ["provider_rate_limited"],
        respectRetryAfter: true,
        maxRetryWindowSecs: 60
      }
    },
    traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp"] },
    ...extra
  }, null, 2), "utf8");
}

async function discoveredTools(): Promise<string[]> {
  writeConfig();
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object" && "port" in address);
    const client = new Client({ name: "tool-surface-test", version: "0.1.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      return listed.tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const expectedNames = [
  "project_context",
  "project_edit",
  "project_patch",
  "project_policy",
  "project_read",
  "project_run",
  "project_search",
  "subagent_context",
  "subagent_task"
].sort();

test("server exposes one complete tool surface", async () => {
  const names = await discoveredTools();
  assert.deepEqual(names, expectedNames);
  assert.equal(names.filter((name) => name === "project_read").length, 1);
});

test("retired toolSurface configuration fails closed", () => {
  for (const value of ["broad", "agent", "full"]) {
    writeConfig({ toolSurface: value });
    assert.throws(() => loadConfig(), /toolSurface/i);
  }
});
