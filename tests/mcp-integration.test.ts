import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-mcp-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const skillsDir = path.join(root, "skills");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
mkdirSync(path.join(skillsDir, "sample"), { recursive: true });
mkdirSync(path.join(skillsDir, "sample", "agents"), { recursive: true });
mkdirSync(path.join(skillsDir, "sample", "references"), { recursive: true });
mkdirSync(path.join(skillsDir, "no-entrypoint"), { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "# MCP Test\n", "utf8");
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
  scripts: {
    check: "node -e \"console.log('check-ok')\""
  }
}, null, 2), "utf8");
writeFileSync(path.join(skillsDir, "sample", "SKILL.md"), [
  "---",
  "name: sample",
  "description: Sample skill for integration tests.",
  "---",
  "",
  "# Sample Skill",
  "",
  "Return concise results.",
  ""
].join("\n"), "utf8");
writeFileSync(path.join(skillsDir, "sample", "agents", "openai.yaml"), [
  "interface:",
  "  display_name: \"Sample\"",
  "  short_description: \"Sample integration skill\"",
  "  default_prompt: \"Use $sample for integration testing.\"",
  ""
].join("\n"), "utf8");
writeFileSync(path.join(skillsDir, "sample", "references", "guide.md"), "# Guide\n\nUse this nested reference.\n", "utf8");
writeFileSync(path.join(skillsDir, "sample", "references", "unicode.md"), "a🙂b\n", "utf8");
writeFileSync(path.join(skillsDir, "loose.md"), "# Loose Skill\n\nThis must be ignored.\n", "utf8");
writeFileSync(policyPath, JSON.stringify({
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
    packageManagerCommand: true,
    nodeCommand: true
  },
  chatgpt: {
    registerProjects: true,
    updatePermissions: true,
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
    maxStdoutChars: 200000,
    maxStderrChars: 200000,
    defaultReadChars: 120000,
    maxReadChars: 500000,
    maxSkillReadChars: 200000,
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
}, null, 2), "utf8");
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
  skills: { directory: skillsDir }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.CEREBRAS_API_KEY = "test-key";

const { createHttpServer } = await import("../src/server.js");
const { formatSkillForPrompt, parseSkillFrontmatter, readFullSkill } = await import("../src/tools/skills.js");
const { updatePermissions } = await import("../src/state/PermissionRegistry.js");
const { upsertSession } = await import("../src/state/SessionRegistry.js");

updatePermissions({ permissions: { chatgpt: { runPackageScripts: true } } });

function resultOf(response: any): any {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return response.structuredContent.result;
}

function assertPublicSession(session: any): void {
  assert.equal(typeof session.sessionId, "string");
  assert.equal(typeof session.projectAlias, "string");
  assert.equal(typeof session.agentTemplate, "string");
  assert.equal(typeof session.status, "string");
  assert.equal(typeof session.startedAt, "string");
  for (const field of ["task", "stdoutPath", "stderrPath", "resultPath", "metadataPath", "eventsPath"]) {
    assert.equal(field in session, false, `public session leaked ${field}`);
  }
}

test("MCP endpoint exposes and executes core tool surface", async (t) => {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());

  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address && "port" in address);

  const client = new Client({ name: "portus-agents-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of [
    "project_register",
    "project_list",
    "project_status",
    "project_list_files",
    "project_read_file",
    "project_read_text_file",
    "project_write_file",
    "project_copy_file",
    "project_move_file",
    "project_delete_file",
    "project_file_info",
    "project_exists",
    "project_tree",
    "project_search_files",
    "project_search_text",
    "project_search_symbols",
    "project_apply_patch",
    "project_replace_text",
    "project_insert_text",
    "project_create_directory",
    "project_delete_directory",
    "project_git_status",
    "project_git_diff",
    "project_git_diff_file",
    "project_git_show_untracked",
    "project_run_checks",
    "project_list_scripts",
    "project_run_script",
    "agent_run_task",
    "agent_spawn",
    "agent_run_skill",
    "agent_limits",
    "agent_templates",
    "agent_template_describe",
    "agent_status",
    "agent_collect_result",
    "agent_stop",
    "session_list",
    "session_list_active",
    "session_status",
    "session_collect_artifacts",
    "session_read_log",
    "session_read_events",
    "session_stop_all",
    "session_cleanup",
    "session_cleanup_completed",
    "skill_list",
    "skill_read",
    "skill_run",
    "config_show_safe",
    "effective_config_show",
    "permission_get",
    "permission_update",
    "policy_check_path",
    "policy_explain_permissions",
    "audit_list",
    "audit_read"
  ]) {
    assert.equal(toolNames.has(expected), true, `missing tool: ${expected}`);
  }
  assert.equal(toolNames.has("skill_describe"), false, "skill_describe should not be registered");

  for (const tool of tools.tools) {
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} missing readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} missing destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} missing openWorldHint`);
  }

  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "mcp", rootPath: projectRoot } }));
  const listFiles = resultOf(await client.callTool({ name: "project_list_files", arguments: { projectAlias: "mcp" } }));
  assert(listFiles.files.includes("README.md"));

  const read = resultOf(await client.callTool({
    name: "project_read_text_file",
    arguments: {
      projectAlias: "mcp",
      relativePath: "README.md",
      maxChars: 1000
    }
  }));
  assert.match(read.content, /MCP Test/);
  assert.equal(read.projectAlias, "mcp");
  assert.equal(read.relativePath, "README.md");
  assert.equal("path" in read, false);

  const write = resultOf(await client.callTool({
    name: "project_write_file",
    arguments: { projectAlias: "mcp", relativePath: "generated.txt", content: "written through MCP\n" }
  }));
  assert.equal(write.projectAlias, "mcp");
  assert.equal(write.relativePath, "generated.txt");
  assert.equal(write.bytes, "written through MCP\n".length);
  assert.equal("path" in write, false);

  const unicodeWrite = resultOf(await client.callTool({
    name: "project_write_file",
    arguments: { projectAlias: "mcp", relativePath: "unicode.txt", content: "á\n" }
  }));
  assert.equal(unicodeWrite.bytes, Buffer.byteLength("á\n", "utf8"));

  const copy = resultOf(await client.callTool({
    name: "project_copy_file",
    arguments: { projectAlias: "mcp", sourceRelativePath: "generated.txt", destinationRelativePath: "copy/generated-copy.txt" }
  }));
  assert.equal(copy.bytes > 0, true);

  const fileInfo = resultOf(await client.callTool({
    name: "project_file_info",
    arguments: { projectAlias: "mcp", relativePath: "copy/generated-copy.txt", includeHash: true }
  }));
  assert.equal(fileInfo.kind, "file");
  assert.equal(typeof fileInfo.sha256, "string");

  const searchFiles = resultOf(await client.callTool({
    name: "project_search_files",
    arguments: { projectAlias: "mcp", query: "generated", maxResults: 10 }
  }));
  assert.equal(searchFiles.matches.length > 0, true);

  const broadSearchFiles = resultOf(await client.callTool({
    name: "project_search_files",
    arguments: { projectAlias: "mcp", query: "generated readme", maxResults: 10 }
  }));
  assert.deepEqual(broadSearchFiles.tokens, ["generated", "readme"]);
  assert.equal(broadSearchFiles.matches.some((match: { relativePath: string; matchedTokens: string[] }) => match.relativePath === "generated.txt" && match.matchedTokens.includes("generated")), true);
  assert.equal(broadSearchFiles.matches.some((match: { relativePath: string; matchedTokens: string[] }) => match.relativePath === "README.md" && match.matchedTokens.includes("readme")), true);

  const searchText = resultOf(await client.callTool({
    name: "project_search_text",
    arguments: { projectAlias: "mcp", query: "written through MCP", maxResults: 10 }
  }));
  assert.equal(searchText.matches.length > 0, true);

  const tree = resultOf(await client.callTool({
    name: "project_tree",
    arguments: { projectAlias: "mcp", maxDepth: 3, format: "json" }
  }));
  assert.equal(tree.tree.kind, "directory");

  const replace = resultOf(await client.callTool({
    name: "project_replace_text",
    arguments: { projectAlias: "mcp", relativePath: "generated.txt", search: "written", replace: "updated", expectedOccurrences: 1 }
  }));
  assert.equal(replace.ok, true);

  const insert = resultOf(await client.callTool({
    name: "project_insert_text",
    arguments: { projectAlias: "mcp", relativePath: "generated.txt", marker: "updated", content: "new-", position: "before", expectedOccurrences: 1 }
  }));
  assert.equal(insert.ok, true);

  const patchMissingExpected = await client.callTool({
    name: "project_apply_patch",
    arguments: {
      projectAlias: "mcp",
      patch: [
        "diff --git a/generated.txt b/generated.txt",
        "--- a/generated.txt",
        "+++ b/generated.txt",
        "@@ -1 +1 @@",
        "-new-updated through MCP",
        "+new-updated through MCP!"
      ].join("\n"),
      dryRun: true
    }
  });
  assert.equal(patchMissingExpected.isError, true);

  const permissions = resultOf(await client.callTool({ name: "permission_get", arguments: { projectAlias: "mcp" } }));
  assert.equal(permissions.permissions.chatgpt.readFiles, true);

  const effectiveConfig = resultOf(await client.callTool({ name: "effective_config_show", arguments: { projectAlias: "mcp" } }));
  assert.equal(effectiveConfig.provider.name, "cerebras");
  assert.equal(effectiveConfig.provider.model, "cerebras/llama3.1-8b");
  assert.deepEqual(effectiveConfig.provider.credentialEnvNames, ["CEREBRAS_API_KEY"]);
  assert.equal("CEREBRAS_API_KEY" in effectiveConfig.provider, false);
  assert.equal(effectiveConfig.permissions.chatgpt.readFiles, true);
  assert.deepEqual(effectiveConfig.commands.allowedCommands, ["git", "npm", "node"]);
  assert.deepEqual(effectiveConfig.commands.effectiveCommands, ["git", "npm", "node"]);
  assert.deepEqual(effectiveConfig.pathPolicy.blockedPathPatterns, [".env"]);

  const updated = resultOf(await client.callTool({
    name: "permission_update",
    arguments: { projectAlias: "mcp", permissions: { agents: { network: true }, chatgpt: { moveFiles: true, deleteFiles: true } } }
  }));
  assert.equal(updated.permissions.agents.network, true);
  assert.equal(updated.permissions.chatgpt.moveFiles, true);
  assert.equal(updated.permissions.chatgpt.deleteFiles, true);

  const move = resultOf(await client.callTool({
    name: "project_move_file",
    arguments: { projectAlias: "mcp", sourceRelativePath: "copy/generated-copy.txt", destinationRelativePath: "copy/generated-moved.txt" }
  }));
  assert.equal(move.destinationRelativePath, "copy/generated-moved.txt");

  const del = resultOf(await client.callTool({
    name: "project_delete_file",
    arguments: { projectAlias: "mcp", relativePath: "copy/generated-moved.txt", confirm: true }
  }));
  assert.equal(del.deleted, true);

  const skills = resultOf(await client.callTool({ name: "skill_list", arguments: {} }));
  assert.equal(skills.skills.some((listedSkill: any) => listedSkill.name === "sample"), true);
  assert.equal(skills.skills.some((listedSkill: any) => listedSkill.name === "loose.md"), false);
  const listedSample = skills.skills.find((listedSkill: any) => listedSkill.name === "sample");
  assert.equal(listedSample.description, "Sample skill for integration tests.");
  assert.equal("content" in listedSample, false);
  assert.equal("path" in listedSample, false);
  assert.equal("entrypoint" in listedSample, false);
  assert.equal("bundledFiles" in listedSample, false);
  assert.equal(skills.skills.some((listedSkill: any) => listedSkill.name === "no-entrypoint"), false);

  const fullSkill = resultOf(await client.callTool({ name: "skill_read", arguments: { skillName: "sample" } }));
  assert.equal(fullSkill.name, "sample");
  assert.equal(fullSkill.description, "Sample skill for integration tests.");
  assert.equal(fullSkill.entrypoint.endsWith("/skills/sample/SKILL.md"), true);
  assert.equal(fullSkill.files.some((file: any) => file.relativePath === "SKILL.md" && /Sample Skill/.test(file.content)), true);
  assert.equal(fullSkill.files.some((file: any) => file.relativePath === "agents/openai.yaml" && /display_name/.test(file.content)), true);
  assert.equal(fullSkill.files.some((file: any) => file.relativePath === "references/guide.md" && /nested reference/.test(file.content)), true);
  assert.equal(fullSkill.files.some((file: any) => file.relativePath === "references/unicode.md" && file.chars === 4), true);
  assert.equal(fullSkill.totalChars, fullSkill.files.reduce((sum: number, file: any) => sum + file.chars, 0));

  const invalidFullSkill = await client.callTool({ name: "skill_read", arguments: { skillName: "../sample" } });
  assert.equal(invalidFullSkill.isError, true);
  assert.match(JSON.stringify(invalidFullSkill.structuredContent), /Invalid skill name/);

  const missingFullSkill = await client.callTool({ name: "skill_read", arguments: { skillName: "missing" } });
  assert.equal(missingFullSkill.isError, true);
  assert.match(JSON.stringify(missingFullSkill.structuredContent), /Skill not found: missing/);

  const skillPrompt = formatSkillForPrompt(readFullSkill("sample"));
  assert.match(skillPrompt, /--- SKILL.md ---/);
  assert.match(skillPrompt, /Sample Skill/);
  assert.match(skillPrompt, /--- agents\/openai.yaml ---/);
  assert.match(skillPrompt, /--- references\/guide.md ---/);
  assert.match(skillPrompt, /nested reference/);

  resultOf(await client.callTool({
    name: "permission_update",
    arguments: { projectAlias: "mcp", permissions: { chatgpt: { spawnAgents: false } } }
  }));
  const deniedSkillRun = await client.callTool({
    name: "skill_run",
    arguments: { projectAlias: "mcp", skillName: "sample", task: "No-op task." }
  });
  assert.equal(deniedSkillRun.isError, true);
  assert.match(JSON.stringify(deniedSkillRun.structuredContent), /Permission denied: chatgpt\.spawnAgents is false/);
  resultOf(await client.callTool({
    name: "permission_update",
    arguments: { projectAlias: "mcp", permissions: { chatgpt: { spawnAgents: true } } }
  }));

  const check = resultOf(await client.callTool({
    name: "project_run_checks",
    arguments: { projectAlias: "mcp", scriptName: "check" }
  }));
  assert.equal(check.exitCode, 0);
  assert.match(check.stdout, /check-ok/);

  const scripts = resultOf(await client.callTool({
    name: "project_list_scripts",
    arguments: { projectAlias: "mcp" }
  }));
  assert.equal(Array.isArray(scripts.scripts), true);
  assert.equal(scripts.scripts.includes("check"), true);

  const runScript = resultOf(await client.callTool({
    name: "project_run_script",
    arguments: { projectAlias: "mcp", scriptName: "check" }
  }));
  assert.equal(runScript.exitCode, 0);

  resultOf(await client.callTool({
    name: "permission_update",
    arguments: { projectAlias: "mcp", permissions: { chatgpt: { runPackageScripts: false } } }
  }));
  const deniedScript = await client.callTool({
    name: "project_run_script",
    arguments: { projectAlias: "mcp", scriptName: "check" }
  });
  assert.equal(deniedScript.isError, true);
  resultOf(await client.callTool({
    name: "permission_update",
    arguments: { projectAlias: "mcp", permissions: { chatgpt: { runPackageScripts: true } } }
  }));

  const pathCheck = resultOf(await client.callTool({
    name: "policy_check_path",
    arguments: { projectAlias: "mcp", relativePath: "README.md", operation: "read" }
  }));
  assert.equal(pathCheck.allowed, true);
  assert.equal("resolvedPath" in pathCheck, false);

  const writePermissionExplanation = resultOf(await client.callTool({
    name: "policy_explain_permissions",
    arguments: { projectAlias: "mcp", operation: "project_write_file" }
  }));
  assert.deepEqual(writePermissionExplanation.requiredPermissions, ["writeFiles"]);

  const textEditPermissionExplanation = resultOf(await client.callTool({
    name: "policy_explain_permissions",
    arguments: { projectAlias: "mcp", operation: "project_replace_text" }
  }));
  assert.deepEqual(textEditPermissionExplanation.requiredPermissions, ["writeFiles"]);

  const permExplain = resultOf(await client.callTool({
    name: "policy_explain_permissions",
    arguments: { projectAlias: "mcp", operation: "project_delete_file" }
  }));
  assert.equal(Array.isArray(permExplain.requiredPermissions), true);

  const limits = resultOf(await client.callTool({
    name: "agent_limits",
    arguments: { projectAlias: "mcp" }
  }));
  assert.equal(typeof limits.maxConcurrentAgents, "number");

  const templates = resultOf(await client.callTool({
    name: "agent_templates",
    arguments: {}
  }));
  assert.equal(Array.isArray(templates.templates), true);

  const completedSessionDir = path.join(stateDir, "sessions", "mcp_completed_public");
  mkdirSync(completedSessionDir, { recursive: true });
  const completedSession = upsertSession({
    sessionId: "mcp_completed_public",
    projectAlias: "mcp",
    agentTemplate: "ephemeral-project-agent",
    task: "SECRET TASK SHOULD NOT BE RETURNED",
    status: "completed",
    startedAt: "2026-05-15T00:00:00.000Z",
    completedAt: "2026-05-15T00:00:01.000Z",
    stdoutPath: path.join(completedSessionDir, "stdout.log"),
    stderrPath: path.join(completedSessionDir, "stderr.log"),
    resultPath: path.join(completedSessionDir, "result.md"),
    metadataPath: path.join(completedSessionDir, "metadata.json"),
    eventsPath: path.join(completedSessionDir, "events.jsonl"),
    exitCode: 0
  });
  writeFileSync(completedSession.stdoutPath, "session stdout\n", "utf8");
  writeFileSync(completedSession.stderrPath, "session stderr\n", "utf8");
  writeFileSync(completedSession.resultPath, JSON.stringify({ status: "completed", changedFiles: ["generated.txt"] }, null, 2), "utf8");
  writeFileSync(completedSession.metadataPath, JSON.stringify({ rawInternalMetadata: true, summary: { status: "completed" } }, null, 2), "utf8");
  writeFileSync(completedSession.eventsPath!, "", "utf8");

  const runningSessionDir = path.join(stateDir, "sessions", "mcp_running_public");
  mkdirSync(runningSessionDir, { recursive: true });
  const runningSession = upsertSession({
    sessionId: "mcp_running_public",
    projectAlias: "mcp",
    agentTemplate: "ephemeral-project-agent",
    task: "RUNNING SECRET TASK SHOULD NOT BE RETURNED",
    status: "running",
    startedAt: "2026-05-15T00:00:02.000Z",
    stdoutPath: path.join(runningSessionDir, "stdout.log"),
    stderrPath: path.join(runningSessionDir, "stderr.log"),
    resultPath: path.join(runningSessionDir, "result.md"),
    metadataPath: path.join(runningSessionDir, "metadata.json"),
    eventsPath: path.join(runningSessionDir, "events.jsonl")
  });
  writeFileSync(runningSession.stdoutPath, "", "utf8");
  writeFileSync(runningSession.stderrPath, "", "utf8");
  writeFileSync(runningSession.resultPath, "", "utf8");
  writeFileSync(runningSession.metadataPath, JSON.stringify({ rawInternalMetadata: true }, null, 2), "utf8");
  writeFileSync(runningSession.eventsPath!, "", "utf8");

  const agentStatus = resultOf(await client.callTool({ name: "agent_status", arguments: { sessionId: completedSession.sessionId } }));
  assertPublicSession(agentStatus);
  assert.equal(agentStatus.status, "completed");

  const sessionStatus = resultOf(await client.callTool({ name: "session_status", arguments: { sessionId: completedSession.sessionId } }));
  assertPublicSession(sessionStatus);

  const sessions = resultOf(await client.callTool({ name: "session_list", arguments: {} }));
  assert(Array.isArray(sessions));
  assert.equal(sessions.some((session: any) => session.sessionId === completedSession.sessionId), true);
  for (const session of sessions) assertPublicSession(session);

  const activeSessions = resultOf(await client.callTool({ name: "session_list_active", arguments: { projectAlias: "mcp" } }));
  assert(Array.isArray(activeSessions));
  assert.equal(activeSessions.some((session: any) => session.sessionId === runningSession.sessionId), true);
  for (const session of activeSessions) assertPublicSession(session);

  const collected = resultOf(await client.callTool({ name: "agent_collect_result", arguments: { sessionId: completedSession.sessionId } }));
  assertPublicSession(collected.session);
  assert.equal("artifacts" in collected, false);
  assert.match(collected.outputs.stdout, /session stdout/);

  const artifacts = resultOf(await client.callTool({ name: "session_collect_artifacts", arguments: { sessionId: completedSession.sessionId } }));
  assertPublicSession(artifacts.session);
  assert.equal("artifacts" in artifacts, false);
  assert.equal("metadata" in artifacts, false);
  assert.match(artifacts.outputs.stderr, /session stderr/);

  const stopped = resultOf(await client.callTool({ name: "agent_stop", arguments: { sessionId: runningSession.sessionId } }));
  assertPublicSession(stopped);
  assert.equal(stopped.status, "stopped");

  const audit = resultOf(await client.callTool({
    name: "audit_list",
    arguments: { projectAlias: "mcp", limit: 50 }
  }));
  assert.equal(Array.isArray(audit.events), true);
  const auditJson = JSON.stringify(audit.events);
  assert.equal(auditJson.includes(projectRoot), false);
  assert.equal(auditJson.includes("rootPath"), false);
  assert.equal(auditJson.includes("args"), false);

  const auditRead = resultOf(await client.callTool({
    name: "audit_read",
    arguments: { sessionId: runningSession.sessionId }
  }));
  assert.equal(Array.isArray(auditRead.events), true);
  assert.equal(JSON.stringify(auditRead.events).includes("metadataPath"), false);
});

test("skill frontmatter parser requires valid name and description", () => {
  assert.deepEqual(parseSkillFrontmatter([
    "---",
    "name: valid-skill",
    "description: \"A valid skill.\"",
    "---",
    "",
    "# Valid Skill"
  ].join("\n"), "valid-skill"), {
    name: "valid-skill",
    description: "A valid skill."
  });
  assert.throws(() => parseSkillFrontmatter("# Missing\n", "missing"), /missing SKILL.md frontmatter/);
  assert.throws(() => parseSkillFrontmatter([
    "---",
    "name: missing-description",
    "---"
  ].join("\n"), "missing-description"), /missing frontmatter description/);
  assert.throws(() => parseSkillFrontmatter([
    "---",
    "name: Invalid Name",
    "description: Bad name.",
    "---"
  ].join("\n"), "invalid-name"), /invalid frontmatter name/);
});
