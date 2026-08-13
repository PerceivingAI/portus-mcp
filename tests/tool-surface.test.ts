import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CompatibilityCallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PortusPolicyConfig } from "../src/policy/policyConfig.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-tool-surface-"));
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "selected-policy.json");
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const previousEnvironment = {
  PORTUS_MCP_CONFIG_PATH: process.env.PORTUS_MCP_CONFIG_PATH,
  PORTUS_MCP_POLICY_PATH: process.env.PORTUS_MCP_POLICY_PATH,
  PORTUS_MCP_STATE_DIR: process.env.PORTUS_MCP_STATE_DIR,
  AGENT_SKILL_PATHS: process.env.AGENT_SKILL_PATHS,
  SUBAGENTS_SKILL_PATHS: process.env.SUBAGENTS_SKILL_PATHS
};

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
  traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp"] }
}, null, 2), "utf8");
mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "tool surface fixture\n", "utf8");

process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";

// These modules bind environment-backed state at import time, so the fixture paths must be installed first.
const { createHttpServer } = await import("../src/server.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");

const shippedPolicy = JSON.parse(
  readFileSync(path.resolve("portus-mcp.policy.json"), "utf8")
) as PortusPolicyConfig;

function withPermissions(
  permissions: Partial<PortusPolicyConfig["main_agent"]["permissions"]>
): PortusPolicyConfig {
  return {
    ...shippedPolicy,
    main_agent: {
      permissions: {
        ...shippedPolicy.main_agent.permissions,
        ...permissions
      }
    }
  };
}

const permissivePolicy = withPermissions({
  subagentTask: true,
  subagentContext: true,
  projectContext: true,
  projectRead: true,
  projectSearch: true,
  projectEdit: true,
  projectPatch: true,
  projectRun: true,
  projectPolicy: true,
  readGitIgnoredFiles: true,
  requireConfirmation: true,
  allowShell: true,
  allowedCommands: ["git", "npm"]
});

const restrictivePolicy = withPermissions({
  subagentTask: false,
  subagentContext: false,
  projectContext: true,
  projectRead: true,
  projectSearch: false,
  projectEdit: false,
  projectPatch: false,
  projectRun: false,
  projectPolicy: false,
  readGitIgnoredFiles: false,
  requireConfirmation: true,
  allowShell: true,
  allowedCommands: ["git"]
});

const contextOnlyPolicy = withPermissions({
  ...restrictivePolicy.main_agent.permissions,
  subagentContext: true
});

const taskOnlyPolicy = withPermissions({
  ...restrictivePolicy.main_agent.permissions,
  subagentTask: true
});

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

const capabilityManifestSchema = z.object({
  complete: z.literal(true),
  availableTools: z.record(
    z.string(),
    z.object({
      enabled: z.literal(true),
      allowedCommands: z.array(z.string()).optional()
    }).strict()
  ),
  features: z.record(
    z.string(),
    z.object({ enabled: z.literal(true) }).strict()
  )
}).strict();


function capabilitiesOf(response: CompatibilityCallToolResult): z.infer<typeof capabilityManifestSchema> {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const envelope = z.object({
    result: z.object({
      sections: z.object({
        capabilities: z.object({
          value: capabilityManifestSchema
        })
      })
    })
  }).parse(response.structuredContent);
  return envelope.result.sections.capabilities.value;
}


async function withClient(
  policyProvider: (() => PortusPolicyConfig) | undefined,
  action: (client: Client) => Promise<void>
): Promise<void> {
  const server = policyProvider === undefined
    ? createHttpServer("/mcp")
    : createHttpServer("/mcp", policyProvider);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "tool-surface-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  try {
    await action(client);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test.after(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("fixed tool discovery and positive capabilities follow effective permissions", async () => {
  upsertProject({ projectAlias: "surface", rootPath: projectRoot });

  await withClient(() => restrictivePolicy, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedNames);

    const capabilities = capabilitiesOf(await client.callTool({
      name: "project_context",
      arguments: { projectAlias: "surface", include: { capabilities: true } }
    }));
    assert.deepEqual(capabilities, {
      complete: true,
      availableTools: {
        project_context: { enabled: true },
        project_read: { enabled: true }
      },
      features: {}
    });
    assert.equal(JSON.stringify(capabilities).includes("\"enabled\":false"), false);

    const deniedRun = await client.callTool({
      name: "project_run",
      arguments: {
        projectAlias: "surface",
        requests: [{ type: "command", command: "git", args: ["status", "--short"] }]
      }
    });
    assert.equal(deniedRun.isError, true);
    assert.match(JSON.stringify(deniedRun.structuredContent), /main_agent\.projectRun/);

    const deniedContext = await client.callTool({
      name: "subagent_context",
      arguments: { requests: [{ type: "capabilities" }] }
    });
    assert.equal(deniedContext.isError, true);
    assert.match(JSON.stringify(deniedContext.structuredContent), /main_agent\.subagentContext/);
  });

  await withClient(() => contextOnlyPolicy, async (client) => {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      expectedNames
    );
    const capabilities = capabilitiesOf(await client.callTool({
      name: "project_context",
      arguments: { projectAlias: "surface", include: { capabilities: true } }
    }));
    assert.equal("subagent_task" in capabilities.availableTools, false);
    assert.deepEqual(capabilities.availableTools.subagent_context, { enabled: true });

    const allowedContext = await client.callTool({
      name: "subagent_context",
      arguments: { requests: [{ type: "capabilities" }] }
    });
    assert.equal(allowedContext.isError, undefined, JSON.stringify(allowedContext.structuredContent));
  });

  await withClient(() => taskOnlyPolicy, async (client) => {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      expectedNames
    );
    const capabilities = capabilitiesOf(await client.callTool({
      name: "project_context",
      arguments: { projectAlias: "surface", include: { capabilities: true } }
    }));
    assert.deepEqual(capabilities.availableTools.subagent_task, { enabled: true });
    assert.equal("subagent_context" in capabilities.availableTools, false);

    const deniedContext = await client.callTool({
      name: "subagent_context",
      arguments: { requests: [{ type: "capabilities" }] }
    });
    assert.equal(deniedContext.isError, true);
    assert.match(JSON.stringify(deniedContext.structuredContent), /main_agent\.subagentContext/);
  });

  await withClient(() => permissivePolicy, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedNames);

    const capabilities = capabilitiesOf(await client.callTool({
      name: "project_context",
      arguments: { projectAlias: "surface", include: { capabilities: true } }
    }));
    assert.deepEqual(capabilities, {
      complete: true,
      availableTools: {
        project_context: { enabled: true },
        project_read: { enabled: true },
        project_search: { enabled: true },
        project_edit: { enabled: true },
        project_patch: { enabled: true },
        project_run: { enabled: true, allowedCommands: ["git", "npm"] },
        project_policy: { enabled: true },
        subagent_task: { enabled: true },
        subagent_context: { enabled: true }
      },
      features: {
        shell: { enabled: true },
        readGitIgnoredFiles: { enabled: true },
        protectedOperationsRequireConfirmation: { enabled: true }
      }
    });
  });
});

test("project_context uses the policy selected by PORTUS_MCP_POLICY_PATH", async () => {
  const selectedPolicy = withPermissions({
    projectContext: true,
    projectRead: true,
    projectSearch: false,
    projectEdit: false,
    projectPatch: false,
    projectRun: false,
    projectPolicy: false,
    subagentTask: false,
    subagentContext: true,
    readGitIgnoredFiles: true,
    requireConfirmation: false,
    allowShell: false
  });
  writeFileSync(policyPath, JSON.stringify(selectedPolicy, null, 2), "utf8");
  upsertProject({ projectAlias: "selected-policy", rootPath: projectRoot });

  await withClient(undefined, async (client) => {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      expectedNames
    );
    const capabilities = capabilitiesOf(await client.callTool({
      name: "project_context",
      arguments: { projectAlias: "selected-policy", include: { capabilities: true } }
    }));

    assert.deepEqual(capabilities, {
      complete: true,
      availableTools: {
        project_context: { enabled: true },
        project_read: { enabled: true },
        subagent_context: { enabled: true }
      },
      features: {
        readGitIgnoredFiles: { enabled: true }
      }
    });
    assert.equal("project_run" in capabilities.availableTools, false);
    assert.equal("shell" in capabilities.features, false);
  });
});
