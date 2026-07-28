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
  "agent_collect_result",
  "agent_limits",
  "agent_run_task",
  "agent_spawn",
  "agent_status",
  "agent_stop",
  "agent_template_describe",
  "agent_templates",
  "project_context",
  "project_edit",
  "project_patch",
  "project_policy",
  "project_read",
  "project_run",
  "project_search",
  "session_cleanup",
  "session_cleanup_completed",
  "session_collect_artifacts",
  "session_list",
  "session_list_active",
  "session_read_events",
  "session_read_log",
  "session_status",
  "session_stop_all"
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

test("server exposes one complete tool surface", async () => {
  const names = await discoveredTools();
  assert.deepEqual(names, expectedNames);
  assert.equal(names.filter((name) => name === "project_read").length, 1);
  for (const name of obsoleteNames) assert.equal(names.includes(name), false, `${name} must remain unavailable`);
});

test("retired toolSurface configuration fails closed", () => {
  for (const value of ["broad", "agent", "full"]) {
    writeConfig({ toolSurface: value });
    assert.throws(() => loadConfig(), /toolSurface/i);
  }
});
