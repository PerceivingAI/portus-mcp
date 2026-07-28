import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FlueContext, FlueSession, SessionInit } from "@flue/sdk/client";
import type { Bash } from "just-bash";
import projectAgent from "../agents/ephemeral-project-agent.js";
import { createHttpServer } from "../src/server.js";
import { loadSkillRegistry } from "../src/skills/SkillRegistry.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-skills-system-"));
const configPath = path.join(root, "portus-mcp.config.json");
const stateDir = path.join(root, "state");
const defaultCatalog = path.join(root, "skills");
const externalCatalog = path.join(root, "external-skills");
const duplicateCatalog = path.join(root, "duplicate-skills");
const policyPath = path.resolve("portus-mcp.policy.json");

const previousEnvironment: Record<string, string | undefined> = {
  PORTUS_MCP_CONFIG_PATH: process.env.PORTUS_MCP_CONFIG_PATH,
  PORTUS_MCP_POLICY_PATH: process.env.PORTUS_MCP_POLICY_PATH,
  PORTUS_MCP_STATE_DIR: process.env.PORTUS_MCP_STATE_DIR,
  PORTUS_MCP_PROJECTS: process.env.PORTUS_MCP_PROJECTS,
  AGENT_SKILL_PATHS: process.env.AGENT_SKILL_PATHS,
  SUBAGENTS_SKILL_PATHS: process.env.SUBAGENTS_SKILL_PATHS
};

function writeConfig(): void {
  writeFileSync(configPath, JSON.stringify({
    agents: {
      defaultTemplate: "ephemeral-project-agent",
      retry: {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitterRatio: 0,
        retryOn: ["provider_rate_limited"],
        respectRetryAfter: true,
        maxRetryWindowSecs: 1
      }
    },
    traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp"] }
  }, null, 2), "utf8");
}

function writeSkill(catalog: string, name: string, description: string): string {
  const skillRoot = path.join(catalog, name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(path.join(skillRoot, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    ""
  ].join("\n"), "utf8");
  return skillRoot;
}

async function instructionsFromServer(server: HttpServer): Promise<string> {
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "skills-system-test", version: "0.1.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  try {
    return client.getInstructions() ?? "";
  } finally {
    await client.close();
  }
}

async function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

writeConfig();
mkdirSync(defaultCatalog, { recursive: true });
mkdirSync(externalCatalog, { recursive: true });
mkdirSync(duplicateCatalog, { recursive: true });
const defaultSkillRoot = writeSkill(defaultCatalog, "default-skill", "Default catalog skill.");
writeSkill(externalCatalog, "external-skill", "Explicit external catalog skill.");
writeSkill(duplicateCatalog, "default-skill", "Conflicting duplicate skill.");

process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_PROJECTS = "";
delete process.env.AGENT_SKILL_PATHS;
delete process.env.SUBAGENTS_SKILL_PATHS;

test.after(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("skill sources are audience-scoped, explicit, canonical, and fail closed", () => {
  const defaults = loadSkillRegistry();
  assert.deepEqual(defaults.connected.catalog.map((skill) => skill.name), ["default-skill"]);
  assert.deepEqual(defaults.subagents.catalog.map((skill) => skill.name), ["default-skill"]);

  process.env.AGENT_SKILL_PATHS = "";
  process.env.SUBAGENTS_SKILL_PATHS = externalCatalog;
  const separated = loadSkillRegistry();
  assert.equal(separated.connected.catalog.length, 0);
  assert.deepEqual(separated.subagents.catalog.map((skill) => skill.name), ["external-skill"]);

  process.env.AGENT_SKILL_PATHS = defaultSkillRoot;
  const individual = loadSkillRegistry();
  assert.deepEqual(individual.connected.catalog.map((skill) => skill.name), ["default-skill"]);

  process.env.AGENT_SKILL_PATHS = `${defaultCatalog};${defaultCatalog}`;
  assert.deepEqual(loadSkillRegistry().connected.catalog.map((skill) => skill.name), ["default-skill"]);

  process.env.AGENT_SKILL_PATHS = `${defaultCatalog};${duplicateCatalog}`;
  assert.throws(() => loadSkillRegistry(), /Duplicate connected skill name/);

  process.env.AGENT_SKILL_PATHS = path.join(root, "missing-catalog");
  assert.throws(() => loadSkillRegistry(), /must be an existing directory/);
});

test("skill catalog changes become visible only after server restart", async () => {
  process.env.AGENT_SKILL_PATHS = defaultCatalog;
  process.env.SUBAGENTS_SKILL_PATHS = "";
  const firstServer = createHttpServer("/mcp");
  await new Promise<void>((resolve) => firstServer.listen(0, resolve));
  try {
    const initial = await instructionsFromServer(firstServer);
    assert.match(initial, /Default catalog skill/);
    assert.doesNotMatch(initial, /second-skill/);

    writeSkill(defaultCatalog, "default-skill", "Updated catalog skill.");
    writeSkill(defaultCatalog, "second-skill", "Second catalog skill.");
    const unchangedSnapshot = await instructionsFromServer(firstServer);
    assert.match(unchangedSnapshot, /Default catalog skill/);
    assert.doesNotMatch(unchangedSnapshot, /Updated catalog skill/);
    assert.doesNotMatch(unchangedSnapshot, /second-skill/);
  } finally {
    await closeServer(firstServer);
  }

  const secondServer = createHttpServer("/mcp");
  await new Promise<void>((resolve) => secondServer.listen(0, resolve));
  try {
    const restarted = await instructionsFromServer(secondServer);
    assert.match(restarted, /Updated catalog skill/);
    assert.match(restarted, /second-skill/);
    rmSync(path.join(defaultCatalog, "second-skill"), { recursive: true, force: true });
    assert.match(await instructionsFromServer(secondServer), /second-skill/);
  } finally {
    await closeServer(secondServer);
  }

  const thirdServer = createHttpServer("/mcp");
  await new Promise<void>((resolve) => thirdServer.listen(0, resolve));
  try {
    assert.doesNotMatch(await instructionsFromServer(thirdServer), /second-skill/);
  } finally {
    await closeServer(thirdServer);
  }
});

test("spawned agent mounts configured skills read-only beside its writable project", async () => {
  const projectRoot = path.join(root, "agent-project");
  mkdirSync(projectRoot, { recursive: true });
  const skillRoot = path.join(defaultCatalog, "default-skill");
  mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(skillRoot, "scripts", "probe.sh"), "echo skill-script-ok\n", "utf8");
  const response = await projectAgent({
    sessionId: "skills-test",
    payload: {
      projectRoot,
      model: "test/model",
      allowedCommands: [],
      grantedCommands: [],
      subagentSkills: [{
        name: "default-skill",
        description: "Updated catalog skill.",
        entrypoint: "SKILL.md",
        rootPath: skillRoot,
        allowImplicitInvocation: true,
        maxReadBytes: 800000
      }]
    },
    env: {},
    init: async (options?: SessionInit) => ({
      prompt: async (prompt: string) => {
        const sandbox = options?.sandbox as Bash;
        const skillRead = await sandbox.exec("cat /skills/default-skill/SKILL.md");
        const scriptRun = await sandbox.exec("bash /skills/default-skill/scripts/probe.sh");
        const unconfiguredSkillRead = await sandbox.exec("cat /skills/external-skill/SKILL.md");
        let skillWriteDenied = false;
        try {
          await sandbox.exec("echo forbidden > /skills/default-skill/forbidden.txt");
        } catch {
          skillWriteDenied = true;
        }
        const projectWrite = await sandbox.exec("echo allowed > /workspace/allowed.txt");
        return { prompt, skillRead, scriptRun, unconfiguredSkillRead, skillWriteDenied, projectWrite } as unknown;
      }
    } as FlueSession)
  } as FlueContext) as unknown as {
    prompt: string;
    skillRead: { stdout: string };
    scriptRun: { exitCode: number; stdout: string };
    unconfiguredSkillRead: { exitCode: number };
    skillWriteDenied: boolean;
    projectWrite: { exitCode: number };
  };

  assert.match(response.prompt, /Configured skill catalog/);
  assert.match(response.prompt, /default-skill/);
  assert.equal(response.prompt.includes(skillRoot), false);
  assert.match(response.skillRead.stdout, /name: default-skill/);
  assert.equal(response.scriptRun.exitCode, 0);
  assert.match(response.scriptRun.stdout, /skill-script-ok/);
  assert.notEqual(response.unconfiguredSkillRead.exitCode, 0);
  assert.equal(response.skillWriteDenied, true);
  assert.equal(existsSync(path.join(skillRoot, "forbidden.txt")), false);
  assert.equal(response.projectWrite.exitCode, 0);
  assert.match(readFileSync(path.join(projectRoot, "allowed.txt"), "utf8"), /allowed/);
});
