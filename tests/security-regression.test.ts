import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(homedir(), "portus-security-test-"));
const projectRoot = path.join(root, "project");
const stateDir = path.join(projectRoot, ".portus-mcp");
const configPath = path.join(root, "config.json");
const dotenvPath = path.join(root, "missing.env");
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));


mkdirSync(projectRoot, { recursive: true });
mkdirSync(path.join(projectRoot, "ignored-dir"), { recursive: true });
mkdirSync(path.join(projectRoot, "ignored-delete-dir"), { recursive: true });
mkdirSync(path.join(projectRoot, "skip-me"), { recursive: true });
const { assertMainAgentPermission, assertSubagentPermission } = await import("../src/policy/permissionPolicy.js");
writeFileSync(path.join(projectRoot, ".gitignore"), "ignored.txt\nignored-dir/\nignored-delete-dir/\nignored-package.json\n", "utf8");
writeFileSync(path.join(projectRoot, "README.md"), "# Security Regression\n", "utf8");
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ok')\"" } }, null, 2), "utf8");
writeFileSync(path.join(projectRoot, ".env"), "SECRET_TOKEN=initial\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored.txt"), "hidden ignored content\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored-dir", "nested.txt"), "nested ignored content\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored-delete-dir", "nested.txt"), "delete target\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored-package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ignored')\"" } }, null, 2), "utf8");
writeFileSync(path.join(projectRoot, "skip-me", "visible.txt"), "excluded traversal content\n", "utf8");
writeFileSync(path.join(projectRoot, "pathological-regex.txt"), `${"a".repeat(40)}X\n`, "utf8");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["add", ".gitignore", "README.md", "package.json"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["add", "-f", ".env"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot, stdio: "ignore" });
writeFileSync(path.join(projectRoot, ".env"), "SECRET_TOKEN=changed\n", "utf8");

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
    excludedPatterns: [".git", "skip-me"]
  }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
delete process.env.PORTUS_MCP_POLICY_PATH;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.CEREBRAS_API_KEY = "test-key";

const { createHttpServer } = await import("../src/server.js");

const { loadPolicyConfig, policyPermissions } = await import("../src/policy/policyConfig.js");
const { getProject } = await import("../src/state/ProjectRegistry.js");
function registerProject(alias: string, rootPath: string): void {
  const projects = (process.env.PORTUS_MCP_PROJECTS ?? "").split(";").filter(Boolean).filter((entry) => !entry.startsWith(`${alias}=`));
  projects.push(`${alias}=${rootPath}`);
  process.env.PORTUS_MCP_PROJECTS = projects.join(";");
}
const selectedPolicy = loadPolicyConfig();
const withMainAgentPermissions = (
  permissions: Partial<typeof selectedPolicy.main_agent.permissions>
): typeof selectedPolicy => ({
  ...selectedPolicy,
  main_agent: {
    permissions: { ...selectedPolicy.main_agent.permissions, ...permissions }
  }
});
const networkDeniedPolicy: typeof selectedPolicy = {
  ...selectedPolicy,
  subagents: {
    ...selectedPolicy.subagents,
    permissions: {
      ...selectedPolicy.subagents.permissions,
      networkAccess: false
    }
  }
};



function resultOf(response: any): any {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return response.structuredContent.result;
}

async function withClient(t: TestContext, policyProvider: () => typeof selectedPolicy = () => selectedPolicy): Promise<Client> {
  const server = createHttpServer("/mcp", policyProvider);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address && "port" in address);
  const client = new Client({ name: "security-regression-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return client;
}

test("permission gates cover every selected-policy permission", () => {
  for (const permission of ["readGitIgnoredFiles", "allowShell"] as const) {
    assert.throws(() => assertMainAgentPermission(permission, selectedPolicy), /Permission denied/);
  }
  for (const permission of ["subagentTask", "subagentContext", "projectContext", "projectRead", "projectSearch", "projectEdit", "projectPatch", "projectRun", "projectPolicy", "requireConfirmation"] as const) {
    assert.doesNotThrow(() => assertMainAgentPermission(permission, selectedPolicy));
  }

  assert.throws(() => assertSubagentPermission("network", networkDeniedPolicy), /Permission denied/);
  assert.doesNotThrow(() => assertSubagentPermission("maxRuntimeSecs", selectedPolicy));

  const effective = policyPermissions(networkDeniedPolicy);
  assert.equal(effective.main_agent.projectEdit, true);
  assert.equal(effective.subagents.network, false);
});

test("MCP tools use their matching selected-policy permission", async (t) => {
  let activePolicy = selectedPolicy;
  const client = await withClient(t, () => activePolicy);
  const projectAlias = "broad-gates";
  registerProject(projectAlias, projectRoot);
  const cases = [
    { permission: "projectContext", tool: "project_context", arguments: { projectAlias, include: { status: true } } },
    { permission: "projectRead", tool: "project_read", arguments: { projectAlias, requests: [{ relativePath: "README.md", mode: "exists" }] } },
    { permission: "projectSearch", tool: "project_search", arguments: { projectAlias, requests: [{ mode: "files", query: "README" }] } },
    { permission: "projectEdit", tool: "project_edit", arguments: { projectAlias, batchMode: "ordered", operations: [{ type: "mkdir", relativePath: "dry-run" }], dryRun: true } },
    { permission: "projectPatch", tool: "project_patch", arguments: { projectAlias, mode: "prepare", patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-project fixture\n+project fixture updated\n" } },
    { permission: "projectRun", tool: "project_run", arguments: { projectAlias, requests: [{ type: "command", command: "git", args: ["status", "--short"] }] } },
    { permission: "projectPolicy", tool: "project_policy", arguments: { checks: [{ type: "permissions", projectAlias, operation: "project_read" }] } },
    { permission: "subagentContext", tool: "subagent_context", arguments: { requests: [{ type: "capabilities" }] } }
  ] as const;

  for (const entry of cases) {
    activePolicy = withMainAgentPermissions({ [entry.permission]: false });
    const denied = await client.callTool({ name: entry.tool, arguments: entry.arguments });
    assert.equal(denied.isError, true, `${entry.tool} should be denied`);
    assert.match(
      JSON.stringify(denied.structuredContent),
      new RegExp(`main_agent\\.${entry.permission}`)
    );

    activePolicy = selectedPolicy;
    const allowed = await client.callTool({ name: entry.tool, arguments: entry.arguments });
    assert.equal(allowed.isError, undefined, `${entry.tool} should be allowed: ${JSON.stringify(allowed)}`);
  }
});

test("project_screenshot gates on its dedicated projectScreenshot permission", async (t) => {
  const { upsertExecutionSession } = await import("../src/runtime/executionSessions.js");
  let activePolicy = selectedPolicy;
  const client = await withClient(t, () => activePolicy);
  const projectAlias = "screenshot-gates";
  registerProject(projectAlias, projectRoot);

  // Persisted (completed) session so list is otherwise permitted.
  const sessionId = "exec_42_cafecafe";
  upsertExecutionSession({
    sessionId,
    projectAlias,
    command: "node",
    args: [],
    shell: false,
    status: "completed",
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

  const arguments_ = { operation: "list" as const, projectAlias, executionSessionId: sessionId };

  // Shipped default keeps the permission off.
  assert.equal(selectedPolicy.main_agent.permissions.projectScreenshot, false);
  const denied = await client.callTool({ name: "project_screenshot", arguments: arguments_ });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.structuredContent), /main_agent\.projectScreenshot/);

  // Granting the dedicated permission admits the operation.
  activePolicy = withMainAgentPermissions({ projectScreenshot: true });
  const allowed = await client.callTool({ name: "project_screenshot", arguments: arguments_ });
  assert.equal(allowed.isError, undefined, JSON.stringify(allowed.structuredContent));

  // Cross-session access stays denied under the granted permission.
  activePolicy = withMainAgentPermissions({ projectScreenshot: true });
  const crossSession = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "list", projectAlias: "other-project", executionSessionId: sessionId }
  });
  assert.equal(crossSession.isError, true);
  assert.match(JSON.stringify(crossSession.structuredContent), /belongs to a different project|Unknown project alias/);
});

test("ignored-file authorization does not widen default root search", async (t) => {
  const ignoredAccessPolicy = withMainAgentPermissions({ readGitIgnoredFiles: true });
  const client = await withClient(t, () => ignoredAccessPolicy);
  const projectAlias = "ignored-search-scope";
  registerProject(projectAlias, projectRoot);

  const defaultScope = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias,
      requests: [{
        mode: "text",
        query: "nested ignored content",
        relativePath: ".",
        expect: "absent"
      }]
    }
  })).results[0].sections.text;
  assert.deepEqual(defaultScope.matches, []);
  assert.equal(defaultScope.scan.complete, true);
  assert.equal(defaultScope.expectation.met, true);

  const optedInScope = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias,
      requests: [{
        mode: "text",
        query: "nested ignored content",
        relativePath: ".",
        includeGitIgnored: true,
        expect: "present"
      }]
    }
  })).results[0].sections.text;
  assert.equal(optedInScope.matches.length, 1);
  assert.equal(optedInScope.matches[0].relativePath, "ignored-dir/nested.txt");
  assert.equal(optedInScope.expectation.met, true);
});

test("regex timeout leaves the MCP server responsive", async (t) => {
  const regexPolicy: typeof selectedPolicy = {
    ...selectedPolicy,
    limits: {
      ...selectedPolicy.limits,
      search: {
        ...selectedPolicy.limits.search,
        maxRegexExecutionMs: 50
      }
    }
  };
  const client = await withClient(t, () => regexPolicy);
  const projectAlias = "regex-timeout";
  registerProject(projectAlias, projectRoot);

  const section = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias,
      requests: [{
        mode: "text",
        query: "(a+)+$",
        regex: true,
        relativePath: "pathological-regex.txt",
        maxResults: 10
      }]
    }
  })).results[0].sections.text;
  assert.equal(section.ok, true);
  assert.equal(section.scan.complete, false);
  assert.deepEqual(section.scan.reasons, ["regex_timeout"]);

  const toolsAfterTimeout = await client.listTools();
  assert.equal(toolsAfterTimeout.tools.some((tool) => tool.name === "project_search"), true);
});

test("unregistered tool invocations fail closed", async (t) => {
  const client = await withClient(t);
  const denied = await client.callTool({ name: "unknown_tool", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /Tool unknown_tool not found/);
});

test("canonical project boundary permits internal links and rejects external junction escapes", async (t) => {
  const client = await withClient(t);
  const projectAlias = "canonical-boundary";
  const outsideRoot = path.join(root, "outside");
  const insideRoot = path.join(projectRoot, "inside-target");
  const outsideLink = path.join(projectRoot, "outside-link");
  const insideLink = path.join(projectRoot, "inside-link");
  const rootLink = path.join(root, "project-root-link");
  mkdirSync(outsideRoot, { recursive: true });
  mkdirSync(insideRoot, { recursive: true });
  writeFileSync(path.join(outsideRoot, "secret.txt"), "outside secret\n", "utf8");
  writeFileSync(path.join(insideRoot, "visible.txt"), "inside visible\n", "utf8");
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(outsideRoot, outsideLink, directoryLinkType);
  symlinkSync(insideRoot, insideLink, directoryLinkType);
  symlinkSync(projectRoot, rootLink, directoryLinkType);
  const savedProjects = process.env.PORTUS_MCP_PROJECTS;
  t.after(() => {
    process.env.PORTUS_MCP_PROJECTS = savedProjects;
    for (const junction of [outsideLink, insideLink, rootLink]) {
      try {
        unlinkSync(junction);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  });
  registerProject(projectAlias, rootLink);
  const linkedRegistration = getProject(projectAlias);
  assert.equal(linkedRegistration.rootPath, path.resolve(rootLink));

  const reads = resultOf(await client.callTool({
    name: "project_read",
    arguments: {
      projectAlias,
      requests: [
        { relativePath: "inside-link/visible.txt", mode: "content" },
        { relativePath: "outside-link/secret.txt", mode: "content" },
        { relativePath: "outside-link/secret.txt", mode: "metadata" },
        { relativePath: "outside-link/secret.txt", mode: "exists" }
      ]
    }
  }));
  assert.equal(reads.results[0].ok, true);
  assert.match(reads.results[0].content, /inside visible/);
  for (const escaped of reads.results.slice(1)) {
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /Path escapes project root/);
  }

  const search = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias, requests: [{ mode: "text", query: "outside secret", relativePath: "outside-link" }] }
  })).results[0];
  assert.equal(search.sections.text.ok, false);
  assert.match(search.sections.text.error, /Path escapes project root/);

  const escapedFileSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias, requests: [{ mode: "text", query: "outside secret", relativePath: "outside-link/secret.txt" }] }
  })).results[0];
  assert.equal(escapedFileSearch.sections.text.ok, false);
  assert.match(escapedFileSearch.sections.text.error, /Path escapes project root/);

  const edits = resultOf(await client.callTool({
    name: "project_edit",
    arguments: {
      projectAlias,
      batchMode: "ordered",
      continueOnFailure: true,
      operations: [
        { type: "write", relativePath: "outside-link/created.txt", content: "must not escape\n" },
        { type: "mkdir", relativePath: "outside-link/created-dir", recursive: true },
        { type: "copy", sourceRelativePath: "README.md", destinationRelativePath: "outside-link/copied.txt" },
        { type: "move", sourceRelativePath: "README.md", destinationRelativePath: "outside-link/moved.txt" }
      ]
    }
  }));
  assert.equal(edits.batchMode, "ordered");
  assert.equal(edits.batchOutcome, "failed");
  assert.equal(edits.repositoryState, "unchanged");
  assert.equal(edits.errorCount, 4);
  assert.equal(edits.skippedCount, 0);
  for (const escaped of edits.results) {
    assert.equal(escaped.outcome, "failed");
    assert.equal(escaped.operationStatus, "failed");
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /Path escapes project root/);
  }
  assert.equal(existsSync(path.join(outsideRoot, "created.txt")), false);
  assert.equal(existsSync(path.join(outsideRoot, "created-dir")), false);
  assert.equal(existsSync(path.join(outsideRoot, "copied.txt")), false);
  assert.equal(existsSync(path.join(outsideRoot, "moved.txt")), false);

  const patch = [
    "diff --git a/outside-link/patched.txt b/outside-link/patched.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/outside-link/patched.txt",
    "@@ -0,0 +1 @@",
    "+must not escape",
    ""
  ].join("\n");
  const patchResponse = await client.callTool({
    name: "project_patch",
    arguments: { projectAlias, mode: "apply", patch, dryRun: true }
  });
  assert.equal(patchResponse.isError, true);
  assert.match(JSON.stringify(patchResponse.structuredContent), /Path escapes project root/);
  assert.equal(existsSync(path.join(outsideRoot, "patched.txt")), false);
});

test("MCP denies gitignored-file reads and excludes traversal patterns", async (t) => {
  const client = await withClient(t);
  const projectAlias = "sec";
  registerProject(projectAlias, projectRoot);

  const reads = resultOf(await client.callTool({
    name: "project_read",
    arguments: {
      projectAlias: "sec",
      requests: [
        { relativePath: "ignored.txt", mode: "content" },
        { relativePath: "ignored.txt", mode: "metadata" },
        { relativePath: "ignored.txt", mode: "exists" }
      ]
    }
  }));
  for (const denied of reads.results) {
    assert.equal(denied.ok, false);
    assert.match(denied.error, /readGitIgnoredFiles/);
  }

  const copied = resultOf(await client.callTool({
    name: "project_edit",
    arguments: {
      projectAlias: "sec",
      batchMode: "ordered",
      dryRun: true,
      operations: [{ type: "copy", sourceRelativePath: "ignored.txt", destinationRelativePath: "copy.txt" }]
    }
  }));
  assert.equal(copied.results[0].ok, false);
  assert.match(copied.results[0].error, /readGitIgnoredFiles/);

  const context = resultOf(await client.callTool({
    name: "project_context",
    arguments: {
      projectAlias: "sec",
      include: {
        files: { maxEntries: 50 },
        tree: { format: "flat", maxEntries: 50 }
      }
    }
  }));
  const files = context.sections.files.value.files;
  assert.equal(files.some((file: { relativePath: string }) => file.relativePath.includes("ignored")), false);
  assert.equal(files.some((file: { relativePath: string }) => file.relativePath.includes("skip-me")), false);
  assert.equal(files.some((file: { relativePath: string }) => file.relativePath.includes(".portus-mcp")), false);
  const entries = context.sections.tree.value.entries;
  assert.equal(entries.some((entry: { relativePath: string }) => entry.relativePath.includes("ignored")), false);
  assert.equal(entries.some((entry: { relativePath: string }) => entry.relativePath.includes("skip-me")), false);
  assert.equal(entries.some((entry: { relativePath: string }) => entry.relativePath.includes(".portus-mcp")), false);

  for (const [mode, query] of [["files", "ignored"], ["files", "projects"], ["text", "ignored content"], ["text", "sec"]] as const) {
    const search = resultOf(await client.callTool({
      name: "project_search",
      arguments: { projectAlias: "sec", requests: [{ mode, query, maxResults: 20 }] }
    })).results[0];
    const matches = search.sections[mode].matches;
    assert.equal(matches.some((match: { relativePath: string }) =>
      match.relativePath.includes("ignored") || match.relativePath.includes(".portus-mcp") || match.relativePath.includes("skip-me")), false);
  }

  const ignoredFileSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "sec", requests: [{ mode: "text", query: "hidden ignored content", relativePath: "ignored.txt" }] }
  })).results[0];
  assert.equal(ignoredFileSearch.sections.text.ok, true);
  assert.deepEqual(ignoredFileSearch.sections.text.matches, []);
  assert.equal(ignoredFileSearch.sections.text.scan.complete, true);

  const excludedFileSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: { projectAlias: "sec", requests: [{ mode: "text", query: "excluded traversal content", relativePath: "skip-me/visible.txt" }] }
  })).results[0];
  assert.equal(excludedFileSearch.sections.text.ok, true);
  assert.deepEqual(excludedFileSearch.sections.text.matches, []);

  for (const mode of ["files", "text", "symbols", "all"] as const) {
    const directExcludedSearch = resultOf(await client.callTool({
      name: "project_search",
      arguments: {
        projectAlias: "sec",
        requests: [{
          mode,
          query: "not present",
          relativePath: `skip-me/missing-${mode}.txt`,
          expect: "absent"
        }]
      }
    })).results[0];
    assert.equal(directExcludedSearch.ok, true);
    assert.equal(directExcludedSearch.outcome, "completed");
    const sectionNames = mode === "all" ? ["files", "text", "symbols"] as const : [mode];
    for (const sectionName of sectionNames) {
      const section = directExcludedSearch.sections[sectionName];
      assert.deepEqual(section.matches, []);
      assert.equal(section.scan.complete, true);
      assert.equal(section.scan.filesVisited, 0);
      assert.equal(section.scan.directoriesVisited, 0);
    }
  }

  const missingIgnoredSearch = resultOf(await client.callTool({
    name: "project_search",
    arguments: {
      projectAlias: "sec",
      requests: [{
        mode: "text",
        query: "not present",
        relativePath: "ignored-dir/missing.txt",
        expect: "absent"
      }]
    }
  })).results[0].sections.text;
  assert.deepEqual(missingIgnoredSearch.matches, []);
  assert.equal(missingIgnoredSearch.scan.complete, true);
  assert.equal(missingIgnoredSearch.scan.filesVisited, 0);
  assert.equal(missingIgnoredSearch.scan.directoriesVisited, 0);
});

test("MCP package script tools cannot consume ignored package.json files when ignored reads are disabled", async (t) => {
  const client = await withClient(t);
  const ignoredPackageProjectRoot = path.join(root, "ignored-package-project");
  mkdirSync(ignoredPackageProjectRoot, { recursive: true });
  writeFileSync(path.join(ignoredPackageProjectRoot, ".gitignore"), "package.json\n", "utf8");
  writeFileSync(path.join(ignoredPackageProjectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ignored')\"" } }, null, 2), "utf8");
  execFileSync("git", ["init"], { cwd: ignoredPackageProjectRoot, stdio: "ignore" });

  const projectAlias = "ignored-package";
  registerProject(projectAlias, ignoredPackageProjectRoot);

  const context = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias, include: { scripts: true } }
  }));
  assert.equal(context.sections.scripts.ok, false);
  assert.match(context.sections.scripts.error, /readGitIgnoredFiles/);

  for (const req of [
    { type: "check" },
    { type: "script", name: "check" }
  ]) {
    const response = await client.callTool({ name: "project_run", arguments: { projectAlias, requests: [req] } });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /readGitIgnoredFiles/);
  }
});

test("direct file tools stay filtered while allowed git commands expose repository state", async (t) => {
  const client = await withClient(t);
  const projectAlias = "blocked";
  registerProject(projectAlias, projectRoot);
  const diff = resultOf(await client.callTool({
    name: "project_run",
    arguments: { projectAlias: "blocked", requests: [{ type: "command", command: "git", args: ["diff"] }] }
  })).results[0];
  assert.match(diff.stdout, /SECRET_TOKEN/);

  for (const mode of ["symbols", "text"] as const) {
    const search = resultOf(await client.callTool({
      name: "project_search",
      arguments: { projectAlias: "blocked", requests: [{ mode, query: "SECRET_TOKEN", maxResults: 20 }] }
    })).results[0];
    assert.equal(search.sections[mode].matches.length, 0);
  }
});

test("MCP mutation tools cannot operate on existing gitignored files when ignored reads are disabled", async (t) => {
  const client = await withClient(t);
  const projectAlias = "ignored-mutation";
  registerProject(projectAlias, projectRoot);

  const operations = [
    { type: "write", relativePath: "ignored.txt", content: "overwrite\n" },
    { type: "move", sourceRelativePath: "ignored.txt", destinationRelativePath: "visible-from-ignored.txt" },
    { type: "move", sourceRelativePath: "README.md", destinationRelativePath: "ignored.txt", overwrite: true },
    { type: "delete", relativePath: "ignored.txt", confirm: true },
    { type: "rmdir", relativePath: "ignored-delete-dir", recursive: true, confirm: true },
    { type: "replace", relativePath: "ignored.txt", search: "hidden", replace: "visible", expectedOccurrences: 1 },
    { type: "insert", relativePath: "ignored.txt", marker: "hidden", content: "visible", position: "before" }
  ];
  const edits = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias, batchMode: "ordered", operations, dryRun: true, continueOnFailure: true }
  }));
  assert.equal(edits.batchMode, "ordered");
  assert.equal(edits.batchOutcome, "failed");
  assert.equal(edits.repositoryState, "unchanged");
  assert.equal(edits.errorCount, operations.length);
  assert.equal(edits.skippedCount, 0);
  for (const denied of edits.results) {
    assert.equal(denied.outcome, "failed");
    assert.equal(denied.operationStatus, "failed");
    assert.equal(denied.ok, false);
    assert.match(denied.error, /readGitIgnoredFiles/);
  }

  for (const patch of [
    [
      "diff --git a/ignored.txt b/ignored.txt",
      "--- a/ignored.txt",
      "+++ b/ignored.txt",
      "@@ -1 +1 @@",
      "-hidden ignored content",
      "+changed ignored content",
      ""
    ].join("\n"),
    [
      "diff --git a/ignored.txt b/ignored.txt",
      "deleted file mode 100644",
      "--- a/ignored.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-hidden ignored content",
      ""
    ].join("\n")
  ]) {
    const response = await client.callTool({
      name: "project_patch",
      arguments: { projectAlias, mode: "apply", patch, dryRun: true, confirm: true }
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /readGitIgnoredFiles/);
  }

  const createIgnoredFilePatch = [
    "diff --git a/ignored-dir/generated.txt b/ignored-dir/generated.txt",
    "new file mode 100644",
    "index 0000000..d4e4f5a",
    "--- /dev/null",
    "+++ b/ignored-dir/generated.txt",
    "@@ -0,0 +1 @@",
    "+generated ignored content",
    ""
  ].join("\n");
  const created = resultOf(await client.callTool({
    name: "project_patch",
    arguments: { projectAlias, mode: "apply", patch: createIgnoredFilePatch, dryRun: true }
  }));
  assert.equal(created.applied, false);
  assert.equal(created.dryRun, true);
  assert.deepEqual(created.changedFiles, ["ignored-dir/generated.txt"]);
});

test("MCP mutation tools reject oversized input payloads", async (t) => {
  const client = await withClient(t);
  const projectAlias = "input-limits";
  registerProject(projectAlias, projectRoot);

  for (const [operation, error] of [
    [{ type: "write", relativePath: "large.txt", content: "x".repeat(1000001) }, /limits\.fileWrite\.maxChars/],
    [{ type: "replace", relativePath: "README.md", search: "x".repeat(20001), replace: "small", expectedOccurrences: 1 }, /limits\.textEdit\.maxSearchOrMarkerChars/],
    [{ type: "replace", relativePath: "README.md", search: "Security", replace: "x".repeat(200001), expectedOccurrences: 1 }, /limits\.textEdit\.maxOperationChars/],
    [{ type: "insert", relativePath: "README.md", marker: "x".repeat(20001), content: "small", position: "after" }, /limits\.textEdit\.maxSearchOrMarkerChars/],
    [{ type: "insert", relativePath: "README.md", marker: "Security", content: "x".repeat(200001), position: "after" }, /limits\.textEdit\.maxOperationChars/]
  ] as const) {
    const response = resultOf(await client.callTool({
      name: "project_edit",
      arguments: { projectAlias, operations: [operation], dryRun: true }
    }));
    assert.equal(response.results[0].ok, false);
    assert.match(response.results[0].error, error);
  }

  const patchResponse = await client.callTool({
    name: "project_patch",
    arguments: { projectAlias, mode: "apply", patch: "x".repeat(1000001), dryRun: true }
  });
  assert.equal(patchResponse.isError, true);
  assert.match(JSON.stringify(patchResponse.structuredContent), /limits\.patch\.maxChars/);
});


