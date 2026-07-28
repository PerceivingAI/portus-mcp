import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
mkdirSync(path.join(skillsDir, "sample", "assets"), { recursive: true });
mkdirSync(path.join(skillsDir, "no-entrypoint"), { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "# MCP Test\n", "utf8");
writeFileSync(path.join(projectRoot, "pathological-regex.txt"), `${"a".repeat(40)}X\n`, "utf8");
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
  scripts: {
    check: "node -e \"console.log('check-ok')\""
  }
}, null, 2), "utf8");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
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
writeFileSync(path.join(skillsDir, "sample", "assets", "sample.bin"), Buffer.from([0x00, 0xff, 0x10, 0x80]));
writeFileSync(path.join(skillsDir, "loose.md"), "# Loose Skill\n\nThis must be ignored.\n", "utf8");
writeFileSync(policyPath, JSON.stringify({
  subagents: {
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
      allowedCommands: ["git", "npm", "node"]
    }
  },
  chatgpt: {
    permissions: {
      registerProjects: true,
      updatePermissions: true,
      spawnSubagents: true,
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
      maxRegexExecutionMs: 250
    },
    skills: {
      maxReadChars: 200000,
    },
    subagentOutput: {
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
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.AGENT_SKILL_PATHS = skillsDir;
process.env.SUBAGENTS_SKILL_PATHS = skillsDir;
process.env.CEREBRAS_API_KEY = "test-key";
process.env.npm_execpath ??= path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

// Environment-backed paths must be installed before loading stateful server modules.
const { createHttpServer } = await import("../src/server.js");
const { loadSkillRegistry, parseSkillFrontmatter } = await import("../src/skills/SkillRegistry.js");
const { updatePermissions } = await import("../src/state/PermissionRegistry.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { getSession, upsertSession } = await import("../src/state/SessionRegistry.js");

updatePermissions({ permissions: { chatgpt: { projectRun: true } } });

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
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "project_context",
    "project_edit",
    "project_patch",
    "project_policy",
    "project_read",
    "project_run",
    "project_search",
    "subagent_context",
    "subagent_task"
  ]);
  const serverInstructions = client.getInstructions() ?? "";
  assert.match(serverInstructions, /root-alias="skill\/sample"/);
  assert.match(serverInstructions, /Sample skill for integration tests/);
  assert.equal(serverInstructions.includes("# Sample Skill"), false);
  assert.equal(serverInstructions.includes("default_prompt"), false);

  for (const tool of tools.tools) {
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} missing readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", `${tool.name} missing destructiveHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} missing openWorldHint`);
  }

  assert.throws(
    () => upsertProject({ projectAlias: "skill/collision", rootPath: projectRoot }),
    /reserved for configured read-only skills/
  );
  upsertProject({ projectAlias: "mcp", rootPath: projectRoot });
  const discovery = resultOf(await client.callTool({
    name: "project_context",
    arguments: { include: { projects: true } }
  }));
  assert.equal(discovery.sections.projects.value.projectAliases.includes("mcp"), true);
  assert.equal(JSON.stringify(discovery).includes(projectRoot), false);
  for (const privateField of ["rootPath", "createdAt", "updatedAt"]) {
    assert.equal(JSON.stringify(discovery).includes(privateField), false);
  }
  const missingAliasContext = await client.callTool({
    name: "project_context",
    arguments: { include: { status: true } }
  });
  assert.equal(missingAliasContext.isError, true);
  assert.match(JSON.stringify(missingAliasContext.structuredContent), /projectAlias/i);
  const registered = resultOf(await client.callTool({
    name: "project_policy",
    arguments: { action: { type: "register_project", projectAlias: "policy-registered", rootPath: projectRoot } }
  }));
  assert.equal(registered.action, "register_project");
  assert.equal(registered.project.projectAlias, "policy-registered");
  const context = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { status: true, files: { maxEntries: 50 }, tree: { maxDepth: 3, format: "json" } } }
  }));
  assert(context.sections.files.value.files.some((file: any) => file.relativePath === "README.md"));
  assert.equal(context.sections.tree.value.format, "json");
  assert.equal(Array.isArray(context.sections.tree.value.entries), true);
  assert.equal(context.sections.status.value.project.projectAlias, "mcp");
  assert.equal("rootPath" in context.sections.status.value.project, false);
  assert.equal(JSON.stringify(context).includes(projectRoot), false);

  const read = resultOf(await client.callTool({
    name: "project_read",
    arguments: { projectAlias: "mcp", requests: [{ relativePath: "README.md", mode: "content" }] }
  })).results[0];
  assert.match(read.content, /MCP Test/);
  assert.equal(read.projectAlias, "mcp");
  assert.equal(read.relativePath, "README.md");
  assert.equal("path" in read, false);

  const writes = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias: "mcp", operations: [
      { type: "write", relativePath: "generated.txt", content: "written through MCP\n" },
      { type: "write", relativePath: "unicode.txt", content: "�\n" },
      { type: "copy", sourceRelativePath: "generated.txt", destinationRelativePath: "copy/generated-copy.txt" }
    ] }
  }));
  assert.equal(writes.successCount, 3);
  assert.equal(writes.results[0].bytes, Buffer.byteLength("written through MCP\n", "utf8"));
  assert.equal(writes.results[1].bytes, Buffer.byteLength("�\n", "utf8"));
  assert.equal(writes.results[2].ok, true);

  const metadata = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { paths: [{ relativePath: "copy/generated-copy.txt", includeHash: true }] } }
  })).sections.paths.value[0];
  assert.equal(metadata.kind, "file");
  assert.equal(typeof metadata.sha256, "string");

  const searchFiles = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", mode: "files", query: "generated", maxResults: 10 }
  })).sections.files;
  assert.equal(searchFiles.matches.length > 0, true);

  const broadSearchFiles = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", mode: "files", query: "generated readme", maxResults: 10 }
  })).sections.files;
  assert.equal(broadSearchFiles.matches.some((match: { relativePath: string; matchedTokens: string[] }) => match.relativePath === "generated.txt" && match.matchedTokens.includes("generated")), true);
  assert.equal(broadSearchFiles.matches.some((match: { relativePath: string; matchedTokens: string[] }) => match.relativePath === "README.md" && match.matchedTokens.includes("readme")), true);

  const searchText = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", mode: "text", query: "written through MCP", maxResults: 10 }
  })).sections.text;
  assert.equal(searchText.matches.length > 0, true);

  const regexSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", mode: "text", query: "written\\s+through\\s+MCP", regex: true, maxResults: 10 }
  })).sections.text;
  assert.equal(regexSearch.ok, true);
  assert.equal(regexSearch.matches.some((match: { relativePath: string }) => match.relativePath === "generated.txt"), true);

  // This deliberately exercises the real worker deadline: fake timers cannot interrupt
  // catastrophic backtracking inside a worker thread.
  const pathologicalRegexSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", mode: "text", query: "(a+)+$", regex: true, maxResults: 10 }
  })).sections.text;
  assert.equal(pathologicalRegexSearch.ok, false);
  assert.equal(pathologicalRegexSearch.error, "regex_search_timeout");

  const healthAfterRegexTimeout = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(healthAfterRegexTimeout.status, 200);

  const edits = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias: "mcp", operations: [
      { type: "replace", relativePath: "generated.txt", search: "written", replace: "updated", expectedOccurrences: 1 },
      { type: "insert", relativePath: "generated.txt", marker: "updated", content: "new-", position: "before", expectedOccurrences: 1 }
    ] }
  }));
  assert.equal(edits.successCount, 2);

  const patchMissingExpected = await client.callTool({
    name: "project_patch",
    arguments: {
      projectAlias: "mcp", mode: "apply",
      patch: ["diff --git a/generated.txt b/generated.txt", "--- a/generated.txt", "+++ b/generated.txt", "@@ -1 +1 @@", "-new-updated through MCP", "+new-updated through MCP!"].join("\n"),
      dryRun: true
    }
  });
  assert.equal(patchMissingExpected.isError, true);

  const permissions = resultOf(await client.callTool({ name: "project_policy", arguments: { checks: [{ type: "permissions", projectAlias: "mcp", operation: "project_read" }] } }));
  assert.deepEqual(permissions.results[0].requiredPermissions, ["projectRead"]);
  const missingPolicyMode = await client.callTool({ name: "project_policy", arguments: {} });
  assert.equal(missingPolicyMode.isError, true);
  const conflictingPolicyModes = await client.callTool({
    name: "project_policy",
    arguments: {
      checks: [{ type: "permissions", projectAlias: "mcp", operation: "project_read" }],
      action: { type: "list_audit" }
    }
  });
  assert.equal(conflictingPolicyModes.isError, true);

  const effectiveConfig = resultOf(await client.callTool({
    name: "project_policy",
    arguments: { checks: [{ type: "config", projectAlias: "mcp" }] }
  })).results[0];
  assert.equal(effectiveConfig.permissions.chatgpt.projectRead, true);
  assert.deepEqual(effectiveConfig.pathPolicy.blockedPatterns, [".env"]);
  assert.deepEqual(effectiveConfig.traversal.excludedPatterns, [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"]);

  const updated = resultOf(await client.callTool({
    name: "project_policy",
    arguments: { action: { type: "update_permissions", projectAlias: "mcp", permissions: { subagents: { network: true }, chatgpt: { } } } }
  }));
  assert.equal(updated.permissions.subagents.network, true);
  assert.equal(updated.permissions.chatgpt.projectEdit, true);
  const obsoletePermission = await client.callTool({
    name: "project_policy",
    arguments: { action: { type: "update_permissions", projectAlias: "mcp", permissions: { chatgpt: { readFiles: true } } } }
  });
  assert.equal(obsoletePermission.isError, true);

  const movedAndDeleted = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias: "mcp", operations: [
      { type: "move", sourceRelativePath: "copy/generated-copy.txt", destinationRelativePath: "copy/generated-moved.txt" },
      { type: "delete", relativePath: "copy/generated-moved.txt", confirm: true }
    ] }
  }));
  assert.equal(movedAndDeleted.successCount, 2);
  assert.equal(movedAndDeleted.results[0].destinationRelativePath, "copy/generated-moved.txt");
  assert.equal(movedAndDeleted.results[1].deleted, true);

  const registry = loadSkillRegistry();
  assert.deepEqual(registry.connected.catalog.map((skill) => skill.name), ["sample"]);
  assert.deepEqual(registry.subagents.catalog.map((skill) => skill.name), ["sample"]);
  assert.equal(registry.connected.byName.get("sample")?.description, "Sample skill for integration tests.");
  assert.equal(registry.connected.byName.get("sample")?.openai?.interface?.display_name, "Sample");
  assert.equal(registry.connected.byName.get("sample")?.openai?.interface?.default_prompt, "Use $sample for integration testing.");

  const skillEntrypoint = resultOf(await client.callTool({
    name: "project_read",
    arguments: { projectAlias: "skill/sample", requests: [{ relativePath: "SKILL.md", mode: "content" }] }
  }));
  assert.equal(skillEntrypoint.successCount, 1);
  assert.match(skillEntrypoint.results[0].content, /# Sample Skill/);
  assert.equal(skillEntrypoint.results[0].content.includes("nested reference"), false);
  assert.equal(JSON.stringify(skillEntrypoint).includes("default_prompt"), false);

  const skillReference = resultOf(await client.callTool({
    name: "project_read",
    arguments: { projectAlias: "skill/sample", requests: [{ relativePath: "references/guide.md", mode: "content" }] }
  }));
  assert.match(skillReference.results[0].content, /nested reference/);

  const skillAsset = resultOf(await client.callTool({
    name: "project_read",
    arguments: { projectAlias: "skill/sample", requests: [{ relativePath: "assets/sample.bin", mode: "binary" }] }
  }));
  assert.equal(skillAsset.results[0].encoding, "base64");
  assert.equal(skillAsset.results[0].contentBase64, Buffer.from([0x00, 0xff, 0x10, 0x80]).toString("base64"));

  const escapedSkillRead = resultOf(await client.callTool({
    name: "project_read",
    arguments: { projectAlias: "skill/sample", requests: [{ relativePath: "../outside.txt", mode: "content" }] }
  }));
  assert.equal(escapedSkillRead.errorCount, 1);
  assert.match(escapedSkillRead.results[0].error, /escapes skill root/);

  const deniedSkillEdit = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias: "skill/sample", operations: [{ type: "write", relativePath: "forbidden.txt", content: "forbidden" }] }
  }));
  assert.equal(deniedSkillEdit.errorCount, 1);
  assert.equal(existsSync(path.join(skillsDir, "sample", "forbidden.txt")), false);

  const check = resultOf(await client.callTool({
    name: "project_run",
    arguments: { projectAlias: "mcp", type: "check", name: "check" }
  }));
  assert.equal(check.exitCode, 0);
  assert.match(check.stdout, /check-ok/);

  const scripts = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { scripts: true } }
  })).sections.scripts.value;
  assert.equal(Array.isArray(scripts.scripts), true);
  assert.equal(scripts.scripts.includes("check"), true);

  const runScript = resultOf(await client.callTool({
    name: "project_run",
    arguments: { projectAlias: "mcp", type: "script", name: "check" }
  }));
  assert.equal(runScript.exitCode, 0);

  const gitStatus = resultOf(await client.callTool({
    name: "project_run", arguments: { projectAlias: "mcp", type: "command", command: "git", args: ["status", "--short"] }
  }));
  assert.equal(gitStatus.exitCode, 0);
  assert.equal(gitStatus.requiresConfirmation, false);
  const deniedNodeCommand = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", type: "command", command: "node", args: ["--version"] } });
  assert.equal(deniedNodeCommand.isError, true);
  assert.match(JSON.stringify(deniedNodeCommand.structuredContent), /allowedCommands/);
  const deniedGitAdd = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", type: "command", command: "git", args: ["add", "README.md"] } });
  assert.equal(deniedGitAdd.isError, true);
  assert.match(JSON.stringify(deniedGitAdd.structuredContent), /Confirmation required/);
  const deniedGitRedirect = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", type: "command", command: "git", args: ["-C", "..", "status"] } });
  assert.equal(deniedGitRedirect.isError, true);
  assert.match(JSON.stringify(deniedGitRedirect.structuredContent), /Git option not allowed/);
  const gitAdd = resultOf(await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", type: "command", command: "git", args: ["add", "README.md"], confirm: true } }));
  assert.equal(gitAdd.exitCode, 0);
  assert.equal(gitAdd.requiresConfirmation, true);
  resultOf(await client.callTool({ name: "project_policy", arguments: { action: { type: "update_permissions", projectAlias: "mcp", permissions: { chatgpt: { projectRun: false } } } } }));
  const deniedScript = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", type: "script", name: "check" } });
  assert.equal(deniedScript.isError, true);
  resultOf(await client.callTool({ name: "project_policy", arguments: { action: { type: "update_permissions", projectAlias: "mcp", permissions: { chatgpt: { projectRun: true } } } } }));

  const completedSessionDir = path.join(stateDir, "sessions", "mcp_completed_public");
  mkdirSync(completedSessionDir, { recursive: true });
  const completedSession = upsertSession({
    sessionId: "mcp_completed_public", projectAlias: "mcp", agentTemplate: "ephemeral-project-subagent", task: "SECRET TASK SHOULD NOT BE RETURNED",
    status: "completed", startedAt: "2026-05-15T00:00:00.000Z", completedAt: "2026-05-15T00:00:01.000Z",
    stdoutPath: path.join(completedSessionDir, "stdout.log"), stderrPath: path.join(completedSessionDir, "stderr.log"), resultPath: path.join(completedSessionDir, "result.md"),
    metadataPath: path.join(completedSessionDir, "metadata.json"), eventsPath: path.join(completedSessionDir, "events.jsonl"), exitCode: 0
  });
  writeFileSync(completedSession.stdoutPath, "session stdout\n", "utf8"); writeFileSync(completedSession.stderrPath, "session stderr\n", "utf8");
  writeFileSync(completedSession.resultPath, JSON.stringify({ status: "completed" }), "utf8"); writeFileSync(completedSession.metadataPath, JSON.stringify({ rawInternalMetadata: true }), "utf8"); writeFileSync(completedSession.eventsPath!, "", "utf8");
  const runningSessionDir = path.join(stateDir, "sessions", "mcp_running_public");
  mkdirSync(runningSessionDir, { recursive: true });
  const runningSession = upsertSession({
    sessionId: "mcp_running_public", projectAlias: "mcp", agentTemplate: "ephemeral-project-subagent", task: "RUNNING SECRET TASK SHOULD NOT BE RETURNED", status: "running", startedAt: "2026-05-15T00:00:02.000Z",
    stdoutPath: path.join(runningSessionDir, "stdout.log"), stderrPath: path.join(runningSessionDir, "stderr.log"), resultPath: path.join(runningSessionDir, "result.md"), metadataPath: path.join(runningSessionDir, "metadata.json"), eventsPath: path.join(runningSessionDir, "events.jsonl")
  });
  for (const file of [runningSession.stdoutPath, runningSession.stderrPath, runningSession.resultPath, runningSession.eventsPath!]) writeFileSync(file, "", "utf8");
  writeFileSync(runningSession.metadataPath, JSON.stringify({ rawInternalMetadata: true }), "utf8");
  const contextResp = resultOf(await client.callTool({
    name: "subagent_context",
    arguments: {
      requests: [
        { type: "status", sessionId: completedSession.sessionId },
        { type: "list" },
        { type: "list", projectAlias: "mcp", activeOnly: true },
        { type: "output", sessionId: completedSession.sessionId }
      ]
    }
  })).results;

  const agentStatus = contextResp[0].session;
  assertPublicSession(agentStatus);

  const sessions = contextResp[1].sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.some((session) => session.sessionId === completedSession.sessionId), true);
  for (const session of sessions) assertPublicSession(session);

  const activeSessions = contextResp[2].sessions as Array<Record<string, unknown>>;
  assert.equal(activeSessions.some((session) => session.sessionId === runningSession.sessionId), true);

  const collected = contextResp[3];
  assertPublicSession(collected.session);
  assert.match(collected.outputs.stdout, /session stdout/);
  assert.equal("metadata" in collected, false);

  const taskResp = resultOf(await client.callTool({
    name: "subagent_task",
    arguments: {
      actions: [
        { type: "stop", sessionId: runningSession.sessionId }
      ]
    }
  }));
  assert.equal(taskResp.results[0].ok, false);
  assert.equal(getSession(runningSession.sessionId).status, "running");

  const policyChecks = resultOf(await client.callTool({
    name: "project_policy",
    arguments: { checks: [
      { type: "path", projectAlias: "mcp", relativePath: "README.md", operation: "read" },
      { type: "permissions", projectAlias: "mcp", operation: "project_edit" },
      { type: "permissions", projectAlias: "mcp", operation: "project_patch" },
      { type: "permissions", projectAlias: "mcp", operation: "project_run" },
      { type: "permissions", projectAlias: "mcp", operation: "project_policy" }
    ] }
  })).results;
  assert.equal(policyChecks[0].allowed, true);
  assert.deepEqual(policyChecks[1].requiredPermissions, ["projectEdit"]);
  assert.deepEqual(policyChecks[2].requiredPermissions, ["projectPatch"]);
  assert.deepEqual(policyChecks[3].requiredPermissions, ["projectRun"]);
  assert.deepEqual(policyChecks[4].requiredPermissions, ["projectPolicy"]);

  const audit = resultOf(await client.callTool({
    name: "project_policy",
    arguments: { action: { type: "list_audit", projectAlias: "mcp" } }
  }));
  assert.equal(Array.isArray(audit.events), true);
  const auditJson = JSON.stringify(audit.events);
  assert.match(auditJson, /"tool":"project_policy"/);
  assert.match(auditJson, /"operation":"update_permissions"/);
  assert.equal(auditJson.includes(projectRoot), false);
  assert.equal(auditJson.includes("rootPath"), false);
  assert.equal(auditJson.includes("args"), false);

  const auditRead = resultOf(await client.callTool({
    name: "project_policy",
    arguments: { action: { type: "read_audit", sessionId: runningSession.sessionId } }
  }));
  assert.equal(Array.isArray(auditRead.events), true);
  assert.equal(JSON.stringify(auditRead.events).includes("metadataPath"), false);
});

test("skill frontmatter parser enforces the Agent Skills metadata contract", () => {
  assert.deepEqual(parseSkillFrontmatter([
    "---",
    "name: valid-skill",
    "description: >",
    "  A valid folded",
    "  skill description.",
    "metadata:",
    "  owner: portus",
    "---",
    "",
    "# Valid Skill"
  ].join("\n"), "valid-skill"), {
    name: "valid-skill",
    description: "A valid folded skill description.",
    metadata: { owner: "portus" }
  });
  assert.throws(() => parseSkillFrontmatter("# Missing\n", "missing"), /missing SKILL.md frontmatter/);
  assert.throws(() => parseSkillFrontmatter([
    "---",
    "name: missing-description",
    "---"
  ].join("\n"), "missing-description"), /description/i);
  for (const invalidName of ["Invalid Name", "trailing-", "double--hyphen", "a".repeat(65)]) {
    assert.throws(() => parseSkillFrontmatter([
      "---",
      `name: ${invalidName}`,
      "description: Bad name.",
      "---"
    ].join("\n"), invalidName), /invalid frontmatter name/);
  }
  assert.throws(() => parseSkillFrontmatter([
    "---",
    "name: valid-skill",
    `description: ${"a".repeat(1025)}`,
    "---"
  ].join("\n"), "valid-skill"), /exceeds 1024 characters/);
  assert.throws(() => parseSkillFrontmatter([
    "---",
    "name: valid-skill",
    "name: duplicate",
    "description: Duplicate key.",
    "---"
  ].join("\n"), "valid-skill"), /Map keys must be unique/);
});


