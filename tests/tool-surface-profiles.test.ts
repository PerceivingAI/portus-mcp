import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import type { ToolSurfaceProfile } from "../src/config.js";
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

function writeConfig(toolSurface: ToolSurfaceProfile | string | undefined): void {
  writeFileSync(configPath, JSON.stringify({
    ...(toolSurface === undefined ? {} : { toolSurface }),
    agents: {
      defaultTemplate: "ephemeral-project-agent",
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
    traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp"] }
  }, null, 2), "utf8");
}

async function discoveredTools(toolSurface: ToolSurfaceProfile | undefined): Promise<string[]> {
  writeConfig(toolSurface);
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

const broadNames = [
  "project_context",
  "project_read",
  "project_search",
  "project_edit",
  "project_patch",
  "project_run",
  "project_policy"
].sort();


const obsoleteNames = [
  "project_register", "project_list", "permission_update", "audit_list", "audit_read",
  "project_read_file", "project_read_text_file", "project_read_file_range", "project_read_files",
  "project_status", "project_tree", "project_list_files", "project_file_info", "project_exists", "project_list_scripts",
  "project_search_files", "project_search_text", "project_search_symbols",
  "project_prepare_patch", "project_apply_patch",
  "project_run_checks", "project_run_script", "project_run_command",
  "project_write_file", "project_replace_text", "project_insert_text", "project_copy_file", "project_move_file",
  "project_delete_file", "project_create_directory", "project_delete_directory",
  "policy_check_path", "policy_explain_permissions", "permission_get", "effective_config_show", "config_show_safe",
  "skill_list", "skill_read", "skill_run", "agent_run_skill", "skill_activate", "skill_resource_read", "skill_script_run"
];

test("missing toolSurface defaults to exactly the seven broad tools", async () => {
  assert.deepEqual(await discoveredTools(undefined), broadNames);
});

test("management profile is invalid", () => {
  writeConfig("management");
  assert.throws(() => loadConfig(), /toolSurface.*Invalid enum value/i);
});

test("agent profile exposes agent sessions plus the shared bounded read capability", async () => {
  const names = await discoveredTools("agent");
  assert(names.includes("agent_run_task"));
  assert(names.includes("session_list"));
  assert(names.includes("project_read"));
  for (const name of broadNames.filter((name) => name !== "project_read")) {
    assert.equal(names.includes(name), false, `${name} must not be in the agent profile`);
  }
  for (const name of obsoleteNames) assert.equal(names.includes(name), false, `${name} must remain unavailable`);
});

test("full profile is exactly broad plus the agent and session groups", async () => {
  const agentNames = await discoveredTools("agent");
  const fullNames = await discoveredTools("full");
  assert.deepEqual(fullNames, [...new Set([...broadNames, ...agentNames])].sort());
  for (const name of obsoleteNames) assert.equal(fullNames.includes(name), false, `${name} must remain unavailable`);
});

test("unknown and legacy profiles fail closed", () => {
  for (const profile of ["legacy", "unexpected"]) {
    writeConfig(profile);
    assert.throws(() => loadConfig(), /toolSurface.*Invalid enum value/i);
  }
});
