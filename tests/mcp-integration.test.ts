import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(process.cwd(), ".portus-mcp-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const skillsDir = path.join(root, "skills");
const configPath = path.join(root, "config.json");
const dotenvPath = path.join(root, "missing.env");
const connectedAllowedCommands = ["git"];
after(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    // Windows can hold directory handles briefly after spawned children exit.
    // Leaving an empty .portus-mcp-test-* temp root must not fail the file.
  }
});


mkdirSync(projectRoot, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
mkdirSync(path.join(skillsDir, "sample"), { recursive: true });
mkdirSync(path.join(skillsDir, "sample", "agents"), { recursive: true });
mkdirSync(path.join(skillsDir, "sample", "references"), { recursive: true });
mkdirSync(path.join(skillsDir, "sample", "assets"), { recursive: true });
mkdirSync(path.join(skillsDir, "no-entrypoint"), { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "# MCP Test README\n", "utf8");
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
  scripts: {
    check: "node -e \"console.log('check-ok')\"",
    "timeout-output": "node -e \"console.log('mcp-timeout-stdout'); console.error('mcp-timeout-stderr'); process.stdin.resume()\"",
    "timeout-tree": "node timeout-tree.cjs",
    "batch-output": "node -e \"process.stdout.write('o'.repeat(199000)); process.stderr.write('e'.repeat(199000))\""
  }
}, null, 2), "utf8");
writeFileSync(path.join(projectRoot, "timeout-tree.cjs"), [
  "const { spawn } = require('node:child_process');",
  "const descendant = spawn(process.execPath, ['-e', \"require('node:net').createServer().listen(0)\"], { stdio: 'ignore' });",
  "console.log(`descendant-pid=${descendant.pid}`);",
  "require('node:net').createServer().listen(0);"
].join("\n"), "utf8");
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
delete process.env.PORTUS_MCP_POLICY_PATH;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.AGENT_SKILL_PATHS = skillsDir;
process.env.SUBAGENTS_SKILL_PATHS = skillsDir;
process.env.CEREBRAS_API_KEY = "test-key";
process.env.npm_execpath ??= path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

// Environment-backed paths must be installed before loading stateful server modules.
const { createHttpServer } = await import("../src/server.js");
const { loadPolicyConfig } = await import("../src/policy/policyConfig.js");
const { loadSkillRegistry, parseSkillFrontmatter } = await import("../src/skills/SkillRegistry.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { getSession, upsertSession } = await import("../src/state/SessionRegistry.js");
const selectedPolicy = loadPolicyConfig();
const expectedCapabilities = {
  complete: true,
  availableTools: {
    project_context: { enabled: true },
    project_read: { enabled: true },
    project_search: { enabled: true },
    project_edit: { enabled: true },
    project_patch: { enabled: true },
    project_run: { enabled: true, allowedCommands: connectedAllowedCommands },
    project_policy: { enabled: true },
    subagent_task: { enabled: true },
    subagent_context: { enabled: true }
  },
  features: {
    protectedOperationsRequireConfirmation: { enabled: true }
  }
};


function resultOf(response: any): any {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return response.structuredContent.result;
}
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
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
    "project_screenshot",
    "project_search",
    "subagent_context",
    "subagent_task"
  ]);
  const readTool = tools.tools.find((tool) => tool.name === "project_read");
  const contextTool = tools.tools.find((tool) => tool.name === "project_context");
  const editTool = tools.tools.find((tool) => tool.name === "project_edit");
  assert.deepEqual(Object.keys(editTool?.inputSchema.properties ?? {}).sort(), ["batchMode", "continueOnFailure", "dryRun", "operations", "projectAlias"]);
  assert.match(readTool?.description ?? "", /skill rootAlias returned by project_context/);
  assert.match(contextTool?.description ?? "", /catalog-provided skill rootAlias/);
  for (const reason of [
    "occurrence_mismatch",
    "stale_file",
    "invalid_range",
    "conflicting_base_hash",
    "unsupported_batch_mode",
    "batch_rejected",
    "batch_failed",
    "prior_operation_failed"
  ]) {
    assert.match(editTool?.description ?? "", new RegExp(`\\b${reason}\\b`));
  }
  const includeProperties = ((contextTool?.inputSchema.properties?.include as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
  assert.equal("skills" in includeProperties, true);
  assert.equal("capabilities" in includeProperties, true);
  assert.equal("execution" in includeProperties, false);
  const serverInstructions = client.getInstructions() ?? "";
  assert.match(serverInstructions, /capabilities\.availableTools is the complete effective tool allowlist/);
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
    arguments: { include: { projects: true, skills: true } }
  }));
  assert.equal(discovery.sections.projects.value.projectAliases.includes("mcp"), true);
  assert.deepEqual(discovery.sections.skills.value.skills, [{
    name: "sample",
    description: "Sample skill for integration tests.",
    rootAlias: "skill/sample",
    entrypoint: "SKILL.md"
  }]);
  assert.equal(JSON.stringify(discovery).includes("allowedCommands"), false);
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
  const defaultContext = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp" }
  }));
  assert.deepEqual(defaultContext.sections.capabilities.value, expectedCapabilities);
  assert.equal("execution" in defaultContext.sections, false);
  assert.equal(JSON.stringify(defaultContext.sections.capabilities).includes("\"enabled\":false"), false);
  const removedExecutionContext = await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { execution: true } }
  });
  assert.equal(removedExecutionContext.isError, true);
  assert.equal(JSON.stringify(defaultContext).includes(projectRoot), false);

  const context = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { status: true, capabilities: true, files: { maxEntries: 50 }, tree: { maxDepth: 3, format: "json" } } }
  }));
  assert(context.sections.files.value.files.some((file: any) => file.relativePath === "README.md"));
  assert.equal(context.sections.tree.value.format, "json");
  assert.equal(Array.isArray(context.sections.tree.value.entries), true);
  assert.equal(context.sections.status.value.project.projectAlias, "mcp");
  assert.equal("rootPath" in context.sections.status.value.project, false);
  assert.equal(JSON.stringify(context).includes(projectRoot), false);
  assert.deepEqual(context.sections.capabilities.value, expectedCapabilities);


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
    arguments: { projectAlias: "mcp", batchMode: "ordered", operations: [
      { type: "write", relativePath: "generated.txt", content: "written through MCP\n" },
      { type: "write", relativePath: "unicode.txt", content: "�\n" },
      { type: "copy", sourceRelativePath: "generated.txt", destinationRelativePath: "copy/generated-copy.txt" }
    ] }
  }));
  assert.equal(writes.successCount, 3);
  assert.equal(writes.batchMode, "ordered");
  assert.equal(writes.batchOutcome, "succeeded");
  assert.equal(writes.repositoryState, "changed");
  assert.equal(writes.appliedCount, 3);
  assert.equal(writes.errorCount, 0);
  assert.equal(writes.results[0].bytes, Buffer.byteLength("written through MCP\n", "utf8"));
  assert.equal(writes.results[1].bytes, Buffer.byteLength("�\n", "utf8"));
  assert.equal(writes.results[2].operationStatus, "applied");

  const metadata = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { paths: [{ relativePath: "copy/generated-copy.txt", includeHash: true }] } }
  })).sections.paths.value[0];
  assert.equal(metadata.kind, "file");
  assert.equal(typeof metadata.sha256, "string");

  const searchFiles = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "files", query: "generated", maxResults: 10 }] }
  })).results[0].sections.files;
  assert.equal(searchFiles.matches.length > 0, true);

  const broadSearchFiles = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "files", query: "generated readme", maxResults: 10 }] }
  })).results[0].sections.files;
  assert.equal(broadSearchFiles.matches.some((match: { relativePath: string; matchedTokens: string[] }) => match.relativePath === "generated.txt" && match.matchedTokens.includes("generated")), true);
  assert.equal(broadSearchFiles.matches.some((match: { relativePath: string; matchedTokens: string[] }) => match.relativePath === "README.md" && match.matchedTokens.includes("readme")), true);

  const directFileNameSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "files", query: "generated", relativePath: "generated.txt", maxResults: 10 }] }
  })).results[0].sections.files;
  assert.equal(directFileNameSearch.ok, true);
  assert.deepEqual(directFileNameSearch.matches.map((match: { relativePath: string }) => match.relativePath), ["generated.txt"]);
  assert.equal(directFileNameSearch.matchesTruncated, false);

  const searchText = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "text", query: "written through MCP", maxResults: 10 }] }
  })).results[0].sections.text;
  assert.equal(searchText.matches.length > 0, true);

  const directFileAllSearchResult = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "all", query: "written through MCP", relativePath: "generated.txt", maxResults: 10 }] }
  }));
  const directFileAllSearch = directFileAllSearchResult.results[0].sections;
  assert.equal(directFileAllSearch.files.ok, true);
  assert.deepEqual(directFileAllSearch.files.matches, []);
  for (const mode of ["text", "symbols"] as const) {
    assert.equal(directFileAllSearch[mode].ok, true);
    assert.deepEqual(directFileAllSearch[mode].matches.map((match: { relativePath: string }) => match.relativePath), ["generated.txt"]);
  }
  assert.equal(directFileAllSearchResult.traversalsStarted, 1);
  assert.equal(directFileAllSearchResult.traversalsReused, 2);
  assert.equal(directFileAllSearchResult.gitProcessesSpawned, 1);
  assert.equal(directFileAllSearch.files.scan.traversalReused, false);
  assert.equal(directFileAllSearch.text.scan.traversalReused, true);
  assert.equal(directFileAllSearch.symbols.scan.traversalReused, true);

  const compatibleBatchSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { mode: "files", query: "generated", relativePath: "." },
        { mode: "text", query: "written through MCP", relativePath: "." },
        { mode: "symbols", query: "written through MCP", relativePath: "." }
      ]
    }
  }));
  assert.equal(compatibleBatchSearch.traversalsStarted, 1);
  assert.equal(compatibleBatchSearch.traversalsReused, 2);
  assert.equal(compatibleBatchSearch.gitProcessesSpawned, 1);
  assert.equal(compatibleBatchSearch.results[0].sections.files.scan.traversalReused, false);
  assert.equal(compatibleBatchSearch.results[1].sections.text.scan.traversalReused, true);
  assert.equal(compatibleBatchSearch.results[2].sections.symbols.scan.traversalReused, true);

  const distinctScopeSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { mode: "files", query: "generated", relativePath: "." },
        { mode: "files", query: "generated", relativePath: "generated.txt" }
      ]
    }
  }));
  assert.equal(distinctScopeSearch.traversalsStarted, 2);
  assert.equal(distinctScopeSearch.traversalsReused, 0);
  assert.equal(distinctScopeSearch.gitProcessesSpawned, 2);

  const distinctIgnoredPolicySearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { mode: "files", query: "generated", relativePath: ".", includeGitIgnored: false },
        { mode: "files", query: "generated", relativePath: ".", includeGitIgnored: true }
      ]
    }
  }));
  assert.equal(distinctIgnoredPolicySearch.traversalsStarted, 2);
  assert.equal(distinctIgnoredPolicySearch.traversalsReused, 0);
  assert.equal(distinctIgnoredPolicySearch.results[0].sections.files.ok, true);
  assert.equal(distinctIgnoredPolicySearch.results[1].sections.files.outcome, "failed");

  const sharedTraversalFailure = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "all", query: "anything", relativePath: "missing-search-root" }]
    }
  }));
  assert.equal(sharedTraversalFailure.traversalsStarted, 1);
  assert.equal(sharedTraversalFailure.traversalsReused, 2);
  assert.equal(sharedTraversalFailure.gitProcessesSpawned, 1);
  for (const mode of ["files", "text", "symbols"] as const) {
    assert.equal(sharedTraversalFailure.results[0].sections[mode].outcome, "failed");
  }

  const regexSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "text", query: "written\\s+through\\s+MCP", regex: true, maxResults: 10 }] }
  })).results[0].sections.text;
  assert.equal(regexSearch.ok, true);
  assert.equal(regexSearch.matches.some((match: { relativePath: string }) => match.relativePath === "generated.txt"), true);

  const directFileRegexSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "text", query: "written\\s+through\\s+MCP", relativePath: "generated.txt", regex: true, maxResults: 10 }] }
  })).results[0].sections.text;
  assert.equal(directFileRegexSearch.ok, true);
  assert.deepEqual(directFileRegexSearch.matches.map((match: { relativePath: string }) => match.relativePath), ["generated.txt"]);

  const directFileNoMatch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "text", query: "absent from generated file", relativePath: "generated.txt", maxResults: 10 }] }
  })).results[0].sections.text;
  assert.equal(directFileNoMatch.ok, true);
  assert.deepEqual(directFileNoMatch.matches, []);
  assert.equal(directFileNoMatch.matchesTruncated, false);
  assert.equal(directFileNoMatch.scan.complete, true);
  assert.equal(directFileNoMatch.expectation.met, false);

  const absenceMatchFound = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "text", query: "written through MCP", expect: "absent" }] }
  })).results[0].sections.text;
  assert.equal(absenceMatchFound.ok, false);
  assert.equal(absenceMatchFound.outcome, "completed");
  assert.equal(absenceMatchFound.expectation.kind, "absent");
  assert.equal(absenceMatchFound.expectation.met, false);
  assert.equal(absenceMatchFound.matches.length > 0, true);

  const absenceCleanPattern = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "mcp", requests: [{ mode: "text", query: "stale_absent_string_xyz_99999", expect: "absent" }] }
  })).results[0].sections.text;
  assert.equal(absenceCleanPattern.ok, true);
  assert.equal(absenceCleanPattern.expectation.kind, "absent");
  assert.equal(absenceCleanPattern.expectation.met, true);
  assert.equal(absenceCleanPattern.scan.complete, true);
  assert.deepEqual(absenceCleanPattern.matches, []);

  // Batch expectation assertion propagation test (4 passing expectations, 1 failing expectation)
  const expectationBatch = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { mode: "text", query: "MCP", expect: "present" },
        { mode: "text", query: "written", expect: "present" },
        { mode: "text", query: "stale_absent_1", expect: "absent" },
        { mode: "text", query: "stale_absent_2", expect: "absent" },
        { mode: "text", query: "stale_absent_3", expect: "present" } // Fails expectation
      ]
    }
  }));
  assert.equal(expectationBatch.requestedCount, 5);
  assert.equal(expectationBatch.successCount, 4);
  assert.equal(expectationBatch.failedCount, 1);
  assert.equal(expectationBatch.errorCount, 0);
  assert.equal(expectationBatch.results[4].ok, false);
  assert.equal(expectationBatch.results[4].outcome, "completed");
  assert.equal(expectationBatch.results[4].sections.text.expectation.met, false);

  const isolatedIgnoredScopeFailure = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { mode: "text", query: "MCP Test README", expect: "present" },
        { mode: "text", query: "ignored", includeGitIgnored: true }
      ]
    }
  }));
  assert.equal(isolatedIgnoredScopeFailure.requestedCount, 2);
  assert.equal(isolatedIgnoredScopeFailure.successCount, 1);
  assert.equal(isolatedIgnoredScopeFailure.failedCount, 0);
  assert.equal(isolatedIgnoredScopeFailure.errorCount, 1);
  assert.equal(isolatedIgnoredScopeFailure.results[0].ok, true);
  assert.equal(isolatedIgnoredScopeFailure.results[0].outcome, "completed");
  assert.equal(isolatedIgnoredScopeFailure.results[1].ok, false);
  assert.equal(isolatedIgnoredScopeFailure.results[1].outcome, "failed");
  assert.match(isolatedIgnoredScopeFailure.results[1].sections.text.error, /readGitIgnoredFiles/);
  const batch20Search = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: Array.from({ length: 20 }, (_, i) => ({ mode: "text", query: `query_${i}`, contextLines: 30 }))
    }
  }));
  assert.equal(batch20Search.requestedCount, 20);
  assert.equal(batch20Search.results.length, 20);
  assert.equal(batch20Search.results[0].index, 0);
  assert.equal(batch20Search.results[19].index, 19);

  const batch21Search = await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: Array.from({ length: 21 }, (_, i) => ({ mode: "text", query: `query_${i}` }))
    }
  });
  assert.equal(batch21Search.isError, true);

  const contextLines31Search = await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "text", query: "test", contextLines: 31 }]
    }
  });
  assert.equal(contextLines31Search.isError, true);


  const edits = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias: "mcp", operations: [
      { type: "replace", relativePath: "generated.txt", search: "written", replace: "updated", expectedOccurrences: 1 },
      { type: "insert", relativePath: "generated.txt", marker: "updated", content: "new-", position: "before" }
    ] }
  }));
  assert.equal(edits.successCount, 2);
  assert.equal(edits.batchOutcome, "succeeded");
  assert.equal(edits.appliedCount, 2);
  assert.deepEqual(edits.results.map((operation: Record<string, unknown>) => operation.operationStatus), ["applied", "applied"]);
  assert.deepEqual(edits.results.map((operation: Record<string, unknown>) => operation.matchesApplied), [1, 1]);

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
  assert.equal(effectiveConfig.permissions.main_agent.projectRead, true);
  assert.equal(effectiveConfig.permissions.main_agent.subagentContext, true);
  assert.deepEqual(effectiveConfig.pathPolicy.blockedPatterns, selectedPolicy.pathPolicy.blockedPatterns);
  assert.deepEqual(effectiveConfig.traversal.excludedPatterns, [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"]);


  const movedAndDeleted = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias: "mcp", batchMode: "ordered", operations: [
      { type: "move", sourceRelativePath: "copy/generated-copy.txt", destinationRelativePath: "copy/generated-moved.txt" },
      { type: "delete", relativePath: "copy/generated-moved.txt", confirm: true }
    ] }
  }));
  assert.equal(movedAndDeleted.successCount, 2);
  assert.equal(movedAndDeleted.results[0].destinationRelativePath, "copy/generated-moved.txt");
  assert.equal(movedAndDeleted.results[1].operationStatus, "applied");

  const registry = loadSkillRegistry();
  assert.deepEqual(registry.connected.catalog.map((skill) => skill.name), ["sample"]);
  assert.deepEqual(registry.subagents.catalog.map((skill) => skill.name), ["sample"]);
  assert.equal(registry.connected.byName.get("sample")?.description, "Sample skill for integration tests.");
  assert.equal(registry.connected.byName.get("sample")?.openai?.interface?.display_name, "Sample");
  assert.equal(registry.connected.byName.get("sample")?.openai?.interface?.default_prompt, "Use $sample for integration testing.");

  const skillContext = resultOf(await client.callTool({
    name: "project_context",
    arguments: {
      projectAlias: "skill/sample",
      include: {
        tree: { relativePath: ".", maxDepth: 3, includeFiles: true, includeDirs: true, format: "json" },
        files: { relativePath: ".", maxEntries: 100 },
        paths: [{ relativePath: "references" }]
      }
    }
  }));
  const skillTreeEntries: unknown = skillContext.sections.tree.value.entries;
  assert(Array.isArray(skillTreeEntries));
  const skillTreePaths = skillTreeEntries.map((entry: unknown) => {
    assert(entry && typeof entry === "object" && "relativePath" in entry && typeof entry.relativePath === "string");
    return entry.relativePath;
  });
  for (const expectedPath of ["SKILL.md", "agents", "agents/openai.yaml", "assets", "assets/sample.bin", "references", "references/guide.md"]) {
    assert.equal(skillTreePaths.includes(expectedPath), true, `skill tree missing ${expectedPath}`);
  }
  const skillFileEntries: unknown = skillContext.sections.files.value.files;
  assert(Array.isArray(skillFileEntries));
  const skillFilePaths = skillFileEntries.map((entry: unknown) => {
    assert(entry && typeof entry === "object" && "relativePath" in entry && typeof entry.relativePath === "string");
    return entry.relativePath;
  });
  for (const expectedPath of ["SKILL.md", "agents/openai.yaml", "assets/sample.bin", "references/guide.md", "references/unicode.md"]) {
    assert.equal(skillFilePaths.includes(expectedPath), true, `skill file listing missing ${expectedPath}`);
  }
  assert.equal(skillContext.sections.paths.value[0].kind, "directory");
  assert.equal(JSON.stringify(skillContext).includes(skillsDir), false);

  const escapedSkillContext = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "skill/sample", include: { tree: { relativePath: ".." } } }
  }));
  assert.equal(escapedSkillContext.sections.tree.ok, false);
  assert.match(escapedSkillContext.sections.tree.error, /escapes skill root/);

  const invalidSkillContext = await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "skill/sample", include: { status: true } }
  });
  assert.equal(invalidSkillContext.isError, true);
  assert.match(JSON.stringify(invalidSkillContext.structuredContent), /only tree, files, and paths/);

  const invalidSkillCapabilities = await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "skill/sample", include: { capabilities: true } }
  });
  assert.equal(invalidSkillCapabilities.isError, true);
  assert.match(JSON.stringify(invalidSkillCapabilities.structuredContent), /only tree, files, and paths/);

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
    arguments: { projectAlias: "mcp", requests: [{ type: "check", name: "check" }] }
  })).results[0];
  assert.equal(check.outcome, "exited");
  assert.equal(check.exitCode, 0);
  assert.equal(check.lifecycle.processStarted, true);
  assert.equal(check.lifecycle.processExited, true);
  assert.equal(check.lifecycle.killAttempted, false);
  assert.equal(check.lifecycle.killSucceeded, false);
  assert.equal(check.lifecycle.waitAttempted, true);
  assert.equal(check.lifecycle.reaped, true);
  assert.match(check.stdout, /check-ok/);

  const scripts = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias: "mcp", include: { scripts: true } }
  })).sections.scripts.value;
  assert.equal(Array.isArray(scripts.scripts), true);
  assert.equal(scripts.scripts.includes("check"), true);

  const runScript = resultOf(await client.callTool({
    name: "project_run",
    arguments: { projectAlias: "mcp", requests: [{ type: "script", name: "check" }] }
  })).results[0];
  assert.equal(runScript.outcome, "exited");
  assert.equal(runScript.exitCode, 0);
  // These calls exercise real child-process deadlines; fake timers cannot drive processes behind the MCP server.
  const timeoutBatch = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [{ type: "script", name: "timeout-output", timeoutSecs: 5 }]
    }
  }));
  const timeoutResult = timeoutBatch.results[0];
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.status, "executed");
  assert.equal(timeoutResult.outcome, "timed_out");
  assert.equal(timeoutResult.exitCode, null);
  assert.match(timeoutResult.stdout, /mcp-timeout-stdout/);
  assert.match(timeoutResult.stderr, /mcp-timeout-stderr/);
  assert.equal(timeoutResult.requestedTimeoutMs, 5000);
  assert.equal(timeoutResult.effectiveTimeoutMs, 5000);
  assert.equal(timeoutResult.timeoutSource, "request");
  assert.equal(timeoutResult.elapsedMs >= 4500, true);
  assert.equal(timeoutResult.stdoutTruncated, false);
  assert.equal(timeoutResult.stderrTruncated, false);
  assert.equal(timeoutResult.lifecycle.processStarted, true);
  assert.equal(timeoutResult.lifecycle.processExited, false);
  assert.equal(timeoutResult.lifecycle.killAttempted, true);
  assert.equal(timeoutResult.lifecycle.killSucceeded, true);
  assert.equal(timeoutResult.lifecycle.waitAttempted, true);
  assert.equal(timeoutResult.lifecycle.reaped, true);
  assert.equal(timeoutResult.lifecycle.scope, "process_tree");
  assert.equal(timeoutBatch.requestedCount, timeoutBatch.successCount + timeoutBatch.failedCount + timeoutBatch.errorCount + timeoutBatch.skippedCount);

  const batchDeadline = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      batchTimeoutSecs: 1,
      requests: [{ type: "script", name: "timeout-output", timeoutSecs: 10 }]
    }
  }));
  const batchDeadlineResult = batchDeadline.results[0];
  assert.equal(batchDeadlineResult.outcome, "timed_out");
  assert.equal(batchDeadlineResult.requestedTimeoutMs, 10000);
  assert.equal(batchDeadlineResult.effectiveTimeoutMs > 0 && batchDeadlineResult.effectiveTimeoutMs <= 1000, true);
  assert.equal(batchDeadlineResult.timeoutSource, "batch");
  assert.equal(batchDeadline.batchTimedOut, true);

  const timeoutTree = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [{ type: "script", name: "timeout-tree", timeoutSecs: 5 }]
    }
  })).results[0];
  assert.equal(timeoutTree.outcome, "timed_out");
  assert.equal(timeoutTree.lifecycle.processStarted, true);
  assert.equal(timeoutTree.lifecycle.processExited, false);
  assert.equal(timeoutTree.lifecycle.killAttempted, true);
  assert.equal(timeoutTree.lifecycle.killSucceeded, true);
  assert.equal(timeoutTree.lifecycle.reaped, true);
  const descendantMatch = timeoutTree.stdout.match(/descendant-pid=(\d+)/);
  assert.notEqual(descendantMatch, null, timeoutTree.stdout);
  assert.equal(isProcessAlive(Number(descendantMatch?.[1])), false);
  const outputBoundedBatch = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: Array.from({ length: 3 }, () => ({ type: "script", name: "batch-output" }))
    }
  }));
  assert.equal(outputBoundedBatch.batchOutputTruncated, true);
  const outputBoundedLast = outputBoundedBatch.results[2];
  assert.equal(outputBoundedLast.stdoutTruncated, false);
  assert.equal(outputBoundedLast.stderrTruncated, true);
  assert.equal(outputBoundedLast.truncated, true);
  const returnedBatchChars = outputBoundedBatch.results.reduce(
    (total: number, item: { stdout?: string; stderr?: string }) => total + (item.stdout?.length ?? 0) + (item.stderr?.length ?? 0),
    0
  );
  assert.equal(returnedBatchChars <= selectedPolicy.limits.process.maxBatchOutputChars, true);


  const gitStatus = resultOf(await client.callTool({
    name: "project_run", arguments: { projectAlias: "mcp", requests: [{ type: "command", command: "git", args: ["status", "--short"] }] }
  })).results[0];
  assert.equal(gitStatus.outcome, "exited");
  assert.equal(gitStatus.exitCode, 0);
  assert.equal(gitStatus.requiresConfirmation, false);
  const deniedNodeCommand = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", requests: [{ type: "command", command: "node", args: ["--version"] }] } });
  assert.equal(deniedNodeCommand.isError, true);
  assert.match(JSON.stringify(deniedNodeCommand.structuredContent), /allowedCommands/);
  const deniedGitAdd = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", requests: [{ type: "command", command: "git", args: ["add", "README.md"] }] } });
  assert.equal(deniedGitAdd.isError, true);
  assert.match(JSON.stringify(deniedGitAdd.structuredContent), /Confirmation required/);
  const deniedGitRedirect = await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", requests: [{ type: "command", command: "git", args: ["-C", "..", "status"] }] } });
  assert.equal(deniedGitRedirect.isError, true);
  assert.match(JSON.stringify(deniedGitRedirect.structuredContent), /Git option not allowed/);
  const gitAdd = resultOf(await client.callTool({ name: "project_run", arguments: { projectAlias: "mcp", requests: [{ type: "command", command: "git", args: ["add", "README.md"], confirm: true }] } })).results[0];
  assert.equal(gitAdd.outcome, "exited");
  assert.equal(gitAdd.exitCode, 0);
  assert.equal(gitAdd.requiresConfirmation, true);

  const batch10 = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: Array.from({ length: 10 }, () => ({ type: "command", command: "git", args: ["status", "--short"] }))
    }
  }));
  assert.equal(batch10.requestedCount, 10);
  assert.equal(batch10.executedCount, 10);
  assert.equal(batch10.successCount, 10);
  assert.equal(batch10.skippedCount, 0);

  const batch11 = await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: Array.from({ length: 11 }, () => ({ type: "command", command: "git", args: ["status", "--short"] }))
    }
  });
  assert.equal(batch11.isError, true);

  const preflightFail = await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { type: "command", command: "git", args: ["status", "--short"] },
        { type: "command", command: "git", args: ["add", "README.md"] }
      ]
    }
  });
  assert.equal(preflightFail.isError, true);
  assert.match(JSON.stringify(preflightFail.structuredContent), /Confirmation required/);

  const stopOnFailureTrue = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      stopOnFailure: true,
      requests: [
        { type: "command", command: "git", args: ["log", "--invalid-option-test"] },
        { type: "command", command: "git", args: ["status", "--short"] }
      ]
    }
  }));
  assert.equal(stopOnFailureTrue.requestedCount, 2);
  assert.equal(stopOnFailureTrue.executedCount, 1);
  assert.equal(stopOnFailureTrue.failedCount, 1);
  assert.equal(stopOnFailureTrue.skippedCount, 1);
  assert.equal(stopOnFailureTrue.results[0].status, "executed");
  assert.equal(stopOnFailureTrue.results[1].status, "skipped");
  assert.equal(stopOnFailureTrue.results[1].index, 1);
  assert.equal(stopOnFailureTrue.results[1].lifecycle.processStarted, false);
  assert.equal(stopOnFailureTrue.results[1].lifecycle.processExited, false);
  assert.equal(stopOnFailureTrue.results[1].lifecycle.killAttempted, false);
  assert.equal(stopOnFailureTrue.results[1].lifecycle.killSucceeded, false);
  assert.equal(stopOnFailureTrue.results[1].lifecycle.waitAttempted, false);
  assert.equal(stopOnFailureTrue.results[1].lifecycle.reaped, false);

  const stopOnFailureFalse = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      stopOnFailure: false,
      requests: [
        { type: "command", command: "git", args: ["log", "--invalid-option-test"] },
        { type: "command", command: "git", args: ["status", "--short"] }
      ]
    }
  }));
  assert.equal(stopOnFailureFalse.requestedCount, 2);
  assert.equal(stopOnFailureFalse.executedCount, 2);
  assert.equal(stopOnFailureFalse.failedCount, 1);
  assert.equal(stopOnFailureFalse.successCount, 1);
  assert.equal(stopOnFailureFalse.skippedCount, 0);
  assert.equal(stopOnFailureFalse.results[1].status, "executed");
  assert.equal(stopOnFailureFalse.results[1].ok, true);

  // Preflight rejects batch with direct .cmd request before executing earlier items
  const cmd02Marker = path.join(projectRoot, "cmd02_marker.txt");
  if (existsSync(cmd02Marker)) rmSync(cmd02Marker);
  const cmd02Result = await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { type: "command", command: "node", args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(cmd02Marker)}, 'executed')`] },
        { type: "command", command: "test.cmd", shell: false }
      ]
    }
  });
  assert.equal(cmd02Result.isError, true);
  assert.equal(existsSync(cmd02Marker), false);

  const deniedShellExecution = await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { type: "command", command: "git", args: ["status", "--short"], shell: true }
      ]
    }
  });
  assert.equal(deniedShellExecution.isError, true);
  assert.match(JSON.stringify(deniedShellExecution), /Shell execution is disabled|main_agent\.allowShell/);

  // project_run observable execution sessions: start -> poll -> list -> terminate
  const sessionStartRes = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      sessionAction: {
        type: "start",
        command: "git",
        args: ["status", "--short"]
      }
    }
  }));
  assert.equal(sessionStartRes.sessionAction, "start");
  assert.equal(typeof sessionStartRes.session.sessionId, "string");
  const createdSessionId = sessionStartRes.session.sessionId;

  const sessionPollRes = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      sessionAction: {
        type: "poll",
        sessionId: createdSessionId,
        cursor: 0
      }
    }
  }));
  assert.equal(sessionPollRes.sessionAction, "poll");
  assert.equal(sessionPollRes.sessionId, createdSessionId);
  // Regression guard (Phase 0): the poll result must surface the session
  // record's authoritative projectAlias exactly once.
  assert.equal(sessionPollRes.projectAlias, "mcp");
  assert.equal(typeof sessionPollRes.status, "string");
  assert.equal(typeof sessionPollRes.stdoutChunk, "string");

  const sessionListRes = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      sessionAction: {
        type: "list"
      }
    }
  }));
  assert.equal(sessionListRes.sessionAction, "list");
  assert.equal(Array.isArray(sessionListRes.sessions), true);
  assert.equal(sessionListRes.sessions.some((s: { sessionId: string }) => s.sessionId === createdSessionId), true);

  const sessionTermRes = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      sessionAction: {
        type: "terminate",
        sessionId: createdSessionId
      }
    }
  }));
  assert.equal(sessionTermRes.sessionAction, "terminate");
  assert.equal(sessionTermRes.session.sessionId, createdSessionId);

  // project_run rejects both requests and sessionAction
  const invalidBoth = await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [{ type: "command", command: "git", args: ["status"] }],
      sessionAction: { type: "list" }
    }
  });
  assert.equal(invalidBoth.isError, true);
  assert.match(JSON.stringify(invalidBoth.structuredContent), /cannot accept both/);

  // project_run sessionAction enforces command allowlist
  const sessionDeniedCmd = await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      sessionAction: {
        type: "start",
        command: "node",
        args: ["--version"]
      }
    }
  });
  assert.equal(sessionDeniedCmd.isError, true);
  assert.match(JSON.stringify(sessionDeniedCmd.structuredContent), /allowedCommands/);

  // Search request with failed section sets ok=false and increments errorCount
  const search05Result = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "text", query: "test", relativePath: "nonexistent-dir-xyz-123" }]
    }
  }));
  assert.equal(search05Result.results[0].ok, false);
  assert.equal(search05Result.errorCount, 1);

  // Short-circuiting after witness sets scan.complete=false
  const search07Result = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "text", query: "new-updated", expect: "absent" }]
    }
  })).results[0].sections.text;
  assert.equal(search07Result.scan.complete, false);
  assert.match(JSON.stringify(search07Result.scan.reasons), /short_circuited_after_witness/);

  // Files search returning complete traversal sets scan.complete=true even when ranked.length > maxResults
  const search08Result = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "files", query: "a", maxResults: 1 }]
    }
  })).results[0].sections.files;
  assert.equal(search08Result.matchesTruncated, true);
  assert.equal(search08Result.scan.complete, true);

  // Root-search regression: relativePath "." with present token completes cleanly
  const rootSearchPresent = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "text", query: "MCP", relativePath: "." }]
    }
  })).results[0].sections.text;
  assert.equal(rootSearchPresent.scan.complete, true);
  assert.equal(rootSearchPresent.matches.length > 0, true);
  assert.equal(rootSearchPresent.scan.gitProcessesSpawned, 1);
  assert.equal(rootSearchPresent.scan.traversalReused, false);

  // Root-search regression: relativePath "." with absent token completes cleanly with 0 matches
  const rootSearchAbsent = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [{ mode: "text", query: "definitely-absent-token-xyz-9999", relativePath: "." }]
    }
  })).results[0].sections.text;
  assert.equal(rootSearchAbsent.scan.complete, true);
  assert.equal(rootSearchAbsent.matches.length, 0);
  assert.equal(rootSearchAbsent.scan.gitProcessesSpawned, 1);
  assert.equal(rootSearchAbsent.scan.traversalReused, false);
  // Windows argv execution with real Git executable
  const gitGrepSmoke = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { type: "command", command: "git", args: ["grep", "-e", "patternA\\|patternB\\|README"], shell: false }
      ]
    }
  })).results[0];
  assert.equal(gitGrepSmoke.status, "executed");
  assert.equal(gitGrepSmoke.outcome, "exited");
  assert.equal(gitGrepSmoke.exitCode, 0);
  assert.match(gitGrepSmoke.stdout, /README/);
  // Smart default expectedExitCodes for git grep ([0, 1]) allows exit code 1 to return ok: true without requiring explicit expectedExitCodes
  const gitGrepAbsentSmartDefault = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { type: "command", command: "git", args: ["grep", "-e", "definitely_absent_pattern_xyz_9999"], shell: false }
      ]
    }
  }));
  assert.equal(gitGrepAbsentSmartDefault.successCount, 1);
  assert.equal(gitGrepAbsentSmartDefault.failedCount, 0);
  assert.equal(gitGrepAbsentSmartDefault.errorCount, 0);
  assert.equal(gitGrepAbsentSmartDefault.results[0].ok, true);
  assert.equal(gitGrepAbsentSmartDefault.results[0].outcome, "exited");
  assert.equal(gitGrepAbsentSmartDefault.results[0].exitCode, 1);

  // Explicit expectedExitCodes ([0]) overrides smart default and classifies exit code 1 as failedCount: 1, errorCount: 0
  const gitGrepAbsentExplicitZero = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { type: "command", command: "git", args: ["grep", "-e", "definitely_absent_pattern_xyz_9999"], shell: false, expectedExitCodes: [0] }
      ]
    }
  }));
  assert.equal(gitGrepAbsentExplicitZero.successCount, 0);
  assert.equal(gitGrepAbsentExplicitZero.failedCount, 1);
  assert.equal(gitGrepAbsentExplicitZero.errorCount, 0);
  assert.equal(gitGrepAbsentExplicitZero.results[0].ok, false);
  assert.equal(gitGrepAbsentExplicitZero.results[0].outcome, "exited");
  assert.equal(gitGrepAbsentExplicitZero.results[0].exitCode, 1);

  writeFileSync(path.join(projectRoot, "audit-source.txt"), "stable\n", "utf8");
  const auditedRejectedEdit = resultOf(await client.callTool({
    name: "project_edit",
    arguments: {
      projectAlias: "mcp",
      operations: [
        {
          type: "replace",
          relativePath: "audit-source.txt",
          search: "AUDIT_SECRET_MISSING_SOURCE",
          replace: "AUDIT_SECRET_REPLACEMENT",
          expectedOccurrences: 1
        },
        {
          type: "write",
          relativePath: "audit-withheld.txt",
          content: "AUDIT_SECRET_WITHHELD_CONTENT\n"
        }
      ]
    }
  }));
  assert.equal(auditedRejectedEdit.batchOutcome, "rejected");
  assert.equal(auditedRejectedEdit.repositoryState, "unchanged");
  assert.equal(auditedRejectedEdit.failedCount, 1);
  assert.equal(auditedRejectedEdit.skippedCount, 1);
  assert.equal(existsSync(path.join(projectRoot, "audit-withheld.txt")), false);

  // Public audit projection surfaces executionType, name, and batchIndex
  const auditList = resultOf(await client.callTool({
    name: "project_policy",
    arguments: {
      action: { type: "list_audit", projectAlias: "mcp" }
    }
  }));
  const runEvents = auditList.events.filter((e: Record<string, unknown>) => e.tool === "project_run");
  assert.equal(runEvents.length > 0, true);
  assert.equal("executionType" in runEvents[0], true);
  const rejectedEditOperations = auditList.events.filter((event: Record<string, unknown>) =>
    event.tool === "project_edit"
    && (event.relativePath === "audit-source.txt" || event.relativePath === "audit-withheld.txt")
    && (event.reason === "occurrence_mismatch" || event.reason === "batch_rejected")
  );
  assert.deepEqual(rejectedEditOperations.map((event: Record<string, unknown>) => ({
    batchIndex: event.batchIndex,
    operation: event.operation,
    outcome: event.outcome,
    operationStatus: event.operationStatus,
    reason: event.reason,
    fileChanged: event.fileChanged,
    expectedOccurrences: event.expectedOccurrences,
    matchesFound: event.matchesFound,
    matchesApplied: event.matchesApplied
  })), [
    {
      batchIndex: 0,
      operation: "replace",
      outcome: "completed",
      operationStatus: "not_applied",
      reason: "occurrence_mismatch",
      fileChanged: false,
      expectedOccurrences: 1,
      matchesFound: 0,
      matchesApplied: 0
    },
    {
      batchIndex: 1,
      operation: "write",
      outcome: "skipped",
      operationStatus: "skipped",
      reason: "batch_rejected",
      fileChanged: false,
      expectedOccurrences: undefined,
      matchesFound: undefined,
      matchesApplied: undefined
    }
  ]);
  const rejectedEditSummary = auditList.events.find((event: Record<string, unknown>) =>
    event.tool === "project_edit"
    && event.batchMode === "staged"
    && event.batchOutcome === "rejected"
    && event.requestedCount === 2
    && event.failedCount === 1
    && event.skippedCount === 1
  );
  assert.deepEqual({
    repositoryState: rejectedEditSummary?.repositoryState,
    successCount: rejectedEditSummary?.successCount,
    errorCount: rejectedEditSummary?.errorCount,
    appliedCount: rejectedEditSummary?.appliedCount,
    noChangeCount: rejectedEditSummary?.noChangeCount,
    plannedCount: rejectedEditSummary?.plannedCount,
    dryRun: rejectedEditSummary?.dryRun
  }, {
    repositoryState: "unchanged",
    successCount: 0,
    errorCount: 0,
    appliedCount: 0,
    noChangeCount: 0,
    plannedCount: 0,
    dryRun: false
  });
  const orderedWriteSummary = auditList.events.find((event: Record<string, unknown>) =>
    event.tool === "project_edit"
    && event.batchMode === "ordered"
    && event.batchOutcome === "succeeded"
    && event.requestedCount === 3
    && event.successCount === 3
    && event.appliedCount === 3
  );
  assert.deepEqual({
    repositoryState: orderedWriteSummary?.repositoryState,
    failedCount: orderedWriteSummary?.failedCount,
    errorCount: orderedWriteSummary?.errorCount,
    noChangeCount: orderedWriteSummary?.noChangeCount,
    plannedCount: orderedWriteSummary?.plannedCount,
    skippedCount: orderedWriteSummary?.skippedCount,
    dryRun: orderedWriteSummary?.dryRun
  }, {
    repositoryState: "changed",
    failedCount: 0,
    errorCount: 0,
    noChangeCount: 0,
    plannedCount: 0,
    skippedCount: 0,
    dryRun: false
  });
  const rawEditEvents = readFileSync(path.join(stateDir, "audit.log"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.tool === "project_edit");
  for (const event of rawEditEvents) {
    for (const unsafeField of ["content", "search", "replace", "marker", "replacement", "expectedSha256", "oldSha256", "newSha256", "projectedSha256", "error"]) {
      assert.equal(unsafeField in event, false, `project_edit audit leaked ${unsafeField}`);
    }
  }
  const rawEditJson = JSON.stringify(rawEditEvents);
  assert.equal(rawEditJson.includes(projectRoot), false);
  assert.equal(rawEditJson.includes("AUDIT_SECRET_MISSING_SOURCE"), false);
  assert.equal(rawEditJson.includes("AUDIT_SECRET_REPLACEMENT"), false);
  assert.equal(rawEditJson.includes("AUDIT_SECRET_WITHHELD_CONTENT"), false);
  // Hard-cutover search audit through project_search batch
  const searchBatchSmoke = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "mcp",
      requests: [
        { mode: "text", query: "new-updated", expect: "absent" },
        { mode: "text", query: "output_mode", expect: "absent" },
        { mode: "text", query: "nonexistent_stale_string_xyz_999", expect: "absent" }
      ]
    }
  }));
  assert.equal(searchBatchSmoke.requestedCount, 3);
  assert.equal(searchBatchSmoke.results[0].sections.text.expectation.met, false);
  assert.equal(searchBatchSmoke.results[1].sections.text.expectation.met, true);
  assert.equal(searchBatchSmoke.results[2].sections.text.expectation.met, true);

  const runBatchSmoke = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      stopOnFailure: true,
      requests: [
        { type: "script", name: "check" },
        { type: "script", name: "check" }
      ]
    }
  }));
  assert.equal(runBatchSmoke.requestedCount, 2);
  assert.equal(runBatchSmoke.executedCount, 2);
  assert.equal(runBatchSmoke.successCount, 2);
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
    arguments: { action: { type: "list_audit" } }
  }));
  assert.equal(Array.isArray(audit.events), true);
  const auditJson = JSON.stringify(audit.events);
  assert.match(auditJson, /"tool":"project_policy"/);
  assert.match(auditJson, /"operation":"register_project"/);
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



test("project_screenshot enforces its permission and serves validated images without base64 duplication", async (t) => {
  const { upsertExecutionSession } = await import("../src/runtime/executionSessions.js");
  const { createHash } = await import("node:crypto");
  const sharpModule: any = await import("sharp");
  const pngImage = await sharpModule.default({
    create: { width: 32, height: 24, channels: 3, background: { r: 5, g: 6, b: 7 } }
  })
    .png()
    .toBuffer();

  // Policy override enabling the screenshot permission while keeping the
  // shipped requireConfirmation=true behavior.
  const previousPolicyPath = process.env.PORTUS_MCP_POLICY_PATH;
  const overridePath = path.join(root, "policy-screenshot-enabled.json");
  writeFileSync(
    overridePath,
    JSON.stringify({
      ...selectedPolicy,
      main_agent: {
        ...selectedPolicy.main_agent,
        permissions: {
          ...selectedPolicy.main_agent.permissions,
          projectScreenshot: true,
          allowedCommands: [...selectedPolicy.main_agent.permissions.allowedCommands, "node"]
        }
      }
    }, null, 2),
    "utf8"
  );
  process.env.PORTUS_MCP_POLICY_PATH = overridePath;
  t.after(() => {
    if (previousPolicyPath === undefined) delete process.env.PORTUS_MCP_POLICY_PATH;
    else process.env.PORTUS_MCP_POLICY_PATH = previousPolicyPath;
  });

  // Seed a persisted session and one managed screenshot file.
  const sessionId = "exec_77_aabbccdd";
  upsertExecutionSession({
    sessionId,
    projectAlias: "mcp",
    command: "node",
    args: [],
    shell: false,
    status: "completed",
    pid: 41234,
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "2026-08-22T10:01:00.000Z",
    timeoutMs: 600000,
    exitCode: 0,
    signal: null,
    executionError: null,
    stdoutPath: path.join(stateDir, "stdout.log"),
    stderrPath: path.join(stateDir, "stderr.log"),
    stdoutBytes: 0,
    stderrBytes: 0,
    lifecycle: {
      processStarted: true,
      processExited: true,
      killAttempted: false,
      killSucceeded: false,
      waitAttempted: true,
      reaped: true
    }
  } as any);
  const shotName = "20260101T000000Z_cafef00d.png";
  const shotDir = path.join(projectRoot, ".portus-artifacts", "screenshots", sessionId);
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(path.join(shotDir, shotName), pngImage);

  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address() as any;
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "portus-screenshot-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());

  // Strict schema: unknown field is rejected.
  const bad = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "list", projectAlias: "mcp", executionSessionId: sessionId, bogusField: 1 }
  });
  assert.equal(bad.isError, true);

  // Strict discriminated union: fields from another operation are rejected.
  const wrongVariantField = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "list", projectAlias: "mcp", executionSessionId: sessionId, screenshotId: shotName }
  });
  assert.equal(wrongVariantField.isError, true);

  // List returns validated metadata only.
  const listed = resultOf(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "list", projectAlias: "mcp", executionSessionId: sessionId }
  }));
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].screenshotId, shotName);
  assert.equal(listed.items[0].width, 32);

  // Read returns a native image block; metadata never carries base64.
  const readResponse = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "read", projectAlias: "mcp", executionSessionId: sessionId, screenshotId: shotName }
  });
  assert.equal(readResponse.isError, undefined, JSON.stringify(readResponse.structuredContent));
  const meta = (readResponse.structuredContent as any).result;
  assert.equal(meta.screenshotId, shotName);
  assert.equal(meta.sha256, createHash("sha256").update(pngImage).digest("hex"));
  assert.ok(!meta.data, "structured content must not carry image bytes");
  const base64Prefix = pngImage.toString("base64").slice(0, 40);
  const structuredText = JSON.stringify(readResponse.structuredContent);
  assert.ok(!structuredText.includes(base64Prefix), "structured content leaked base64");
  const blocks = readResponse.content ?? [];
  assert.equal(blocks[0].type, "text");
  assert.ok(!blocks[0].text.includes(base64Prefix), "text block leaked base64");
  const imageBlock = blocks.find((block: any) => block.type === "image") as any;
  assert.ok(imageBlock, "expected a native image content block");
  assert.equal(imageBlock.mimeType, "image/png");
  assert.equal(Buffer.from(imageBlock.data, "base64").equals(pngImage), true);

  // returnImage=false omits native image content entirely.
  const noImage = resultOf(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "read", projectAlias: "mcp", executionSessionId: sessionId, screenshotId: shotName, returnImage: false }
  }));
  assert.equal(noImage.returnImage, false);

  // Delete requires confirmation under the shipped requireConfirmation=true.
  const deniedDelete = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "delete", projectAlias: "mcp", executionSessionId: sessionId, screenshotId: shotName }
  });
  assert.equal(deniedDelete.isError, true);
  assert.match(JSON.stringify(deniedDelete.structuredContent), /Confirmation required/);
  const confirmedDelete = resultOf(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "delete", projectAlias: "mcp", executionSessionId: sessionId, screenshotId: shotName, confirm: true }
  }));
  assert.equal(confirmedDelete.deleted, true);
  assert.equal(existsSync(path.join(shotDir, shotName)), false);

  // End-to-end ownership pipeline against a REAL execution session: a plain
  // node child owns no GUI windows, so targets must return zero candidates —
  // any entry here would be an unrelated-desktop-window leak — and capture
  // must fail closed with the stable zero-candidate error.
  const started = resultOf(await client.callTool({
    name: "project_run",
    arguments: {
      projectAlias: "mcp",
      sessionAction: { type: "start", command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], confirm: true }
    }
  }));
  const runningSessionId = started.session.sessionId as string;
  assert.equal(started.session.status, "running");

  const terminateRunning = () =>
    client.callTool({
      name: "project_run",
      arguments: { projectAlias: "mcp", sessionAction: { type: "terminate", sessionId: runningSessionId } }
    }).catch(() => undefined);
  t.after(terminateRunning);

  const liveTargets = resultOf(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "targets", projectAlias: "mcp", executionSessionId: runningSessionId }
  }));
  assert.deepEqual(liveTargets.targets, []);

  const noWindowCapture = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", projectAlias: "mcp", executionSessionId: runningSessionId, confirm: true }
  });
  assert.equal(noWindowCapture.isError, true);
  assert.match(JSON.stringify(noWindowCapture.structuredContent), /No eligible session window found/);

  // After the session exits: capture denied, list still allowed (empty).
  await terminateRunning();
  const captureAfterExit = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", projectAlias: "mcp", executionSessionId: runningSessionId, confirm: true }
  });
  assert.equal(captureAfterExit.isError, true);
  assert.match(JSON.stringify(captureAfterExit.structuredContent), /not running/);
  const listAfterExit = resultOf(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "list", projectAlias: "mcp", executionSessionId: runningSessionId }
  }));
  assert.equal(listAfterExit.total, 0);
});

