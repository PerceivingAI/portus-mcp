import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-security-regression-"));
const projectRoot = path.join(root, "project");
const stateDir = path.join(projectRoot, ".portus-mcp");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
mkdirSync(path.join(projectRoot, "ignored-dir"), { recursive: true });
mkdirSync(path.join(projectRoot, "ignored-delete-dir"), { recursive: true });
mkdirSync(path.join(projectRoot, "skip-me"), { recursive: true });
writeFileSync(path.join(projectRoot, ".gitignore"), "ignored.txt\nignored-dir/\nignored-delete-dir/\nignored-package.json\n", "utf8");
writeFileSync(path.join(projectRoot, "README.md"), "# Security Regression\n", "utf8");
writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ok')\"" } }, null, 2), "utf8");
writeFileSync(path.join(projectRoot, ".env"), "SECRET_TOKEN=initial\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored.txt"), "hidden ignored content\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored-dir", "nested.txt"), "nested ignored content\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored-delete-dir", "nested.txt"), "delete target\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored-package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ignored')\"" } }, null, 2), "utf8");
writeFileSync(path.join(projectRoot, "skip-me", "visible.txt"), "excluded traversal content\n", "utf8");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["add", ".gitignore", "README.md", "package.json"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["add", "-f", ".env"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot, stdio: "ignore" });
writeFileSync(path.join(projectRoot, ".env"), "SECRET_TOKEN=changed\n", "utf8");

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
    networkAccess: false,
    grantCommands: true,
    gitCommand: true,
    packageManagerCommand: false,
    nodeCommand: false
  },
  chatgpt: {
    registerProjects: true,
    updatePermissions: false,
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
    allowedCommands: ["git", "npm", "node"],
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
  excludedTraversalPatterns: [".git", "skip-me"],
  skills: { directory: "skills" }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.CEREBRAS_API_KEY = "test-key";

const { createHttpServer } = await import("../src/server.js");
const { assertAgentPermission, assertChatGptPermission } = await import("../src/policy/permissionPolicy.js");
const { getEffectivePermissions, updatePermissions } = await import("../src/state/PermissionRegistry.js");

function resultOf(response: any): any {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return response.structuredContent.result;
}

async function withClient(t: any): Promise<Client> {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address && "port" in address);
  const client = new Client({ name: "security-regression-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

test("permission gates cover every chatgpt and agents field", () => {
  for (const permission of ["moveFiles", "deleteFiles", "readGitIgnoredFiles", "runPackageScripts"] as const) {
    assert.throws(() => assertChatGptPermission(permission, "missing-project"), /Permission denied/);
  }
  for (const permission of ["registerProjects", "spawnAgents", "readFiles", "writeFiles", "gitCommands"] as const) {
    assert.doesNotThrow(() => assertChatGptPermission(permission, "missing-project"));
  }
  assert.throws(() => assertChatGptPermission("updatePermissions", "missing-project"), /Permission denied/);

  for (const permission of ["network", "packageManagerCommand", "nodeCommand"] as const) {
    assert.throws(() => assertAgentPermission(permission, "missing-project"), /Permission denied/);
  }
  for (const permission of ["grantCommands", "gitCommand", "maxRuntimeSecs"] as const) {
    assert.doesNotThrow(() => assertAgentPermission(permission, "missing-project"));
  }
});

test("runtime permissions override policy defaults", () => {
  updatePermissions({ projectAlias: "runtime", permissions: { chatgpt: { deleteFiles: true }, agents: { network: true } } });
  const effective = getEffectivePermissions("runtime");
  assert.equal(effective.chatgpt.deleteFiles, true);
  assert.equal(effective.agents.network, true);
});

test("MCP denies registration and permission updates when gated off", async (t) => {
  const client = await withClient(t);
  const permissionDenied = await client.callTool({
    name: "permission_update",
    arguments: { permissions: { chatgpt: { deleteFiles: true } } }
  });
  assert.equal(permissionDenied.isError, true);
  assert.match(JSON.stringify(permissionDenied.structuredContent), /updatePermissions/);
});

test("MCP denies gitignored-file reads and excludes traversal patterns", async (t) => {
  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "sec", rootPath: projectRoot } }));

  for (const call of [
    { name: "project_read_text_file", arguments: { projectAlias: "sec", relativePath: "ignored.txt" } },
    { name: "project_file_info", arguments: { projectAlias: "sec", relativePath: "ignored.txt" } },
    { name: "project_exists", arguments: { projectAlias: "sec", relativePath: "ignored.txt" } },
    { name: "project_copy_file", arguments: { projectAlias: "sec", sourceRelativePath: "ignored.txt", destinationRelativePath: "copy.txt" } },
    { name: "project_git_diff_file", arguments: { projectAlias: "sec", relativePath: "ignored.txt", includeUntracked: true } }
  ]) {
    const response = await client.callTool(call);
    assert.equal(response.isError, true, `${call.name} should deny ignored path`);
    assert.match(JSON.stringify(response.structuredContent), /readGitIgnoredFiles/);
  }

  const files = resultOf(await client.callTool({ name: "project_list_files", arguments: { projectAlias: "sec", maxEntries: 50 } }));
  assert.equal(files.files.includes("ignored.txt"), false);
  assert.equal(files.files.some((file: string) => file.includes("ignored-dir")), false);
  assert.equal(files.files.some((file: string) => file.includes("skip-me")), false);
  assert.equal(files.files.some((file: string) => file.includes(".portus-mcp")), false);

  const searchFiles = resultOf(await client.callTool({ name: "project_search_files", arguments: { projectAlias: "sec", query: "ignored", maxResults: 20 } }));
  assert.equal(searchFiles.matches.length, 0);
  const stateSearchFiles = resultOf(await client.callTool({ name: "project_search_files", arguments: { projectAlias: "sec", query: "projects", maxResults: 20 } }));
  assert.equal(stateSearchFiles.matches.some((match: any) => match.relativePath.includes(".portus-mcp")), false);

  const searchText = resultOf(await client.callTool({ name: "project_search_text", arguments: { projectAlias: "sec", query: "ignored content", maxResults: 20 } }));
  assert.equal(searchText.matches.length, 0);
  const stateSearchText = resultOf(await client.callTool({ name: "project_search_text", arguments: { projectAlias: "sec", query: "sec", maxResults: 20 } }));
  assert.equal(stateSearchText.matches.some((match: any) => match.relativePath.includes(".portus-mcp")), false);

  const tree = resultOf(await client.callTool({ name: "project_tree", arguments: { projectAlias: "sec", format: "flat", maxEntries: 50 } }));
  assert.equal(tree.entries.some((entry: any) => entry.relativePath.includes("ignored")), false);
  assert.equal(tree.entries.some((entry: any) => entry.relativePath.includes("skip-me")), false);
  assert.equal(tree.entries.some((entry: any) => entry.relativePath.includes(".portus-mcp")), false);
});

test("MCP package script tools cannot consume ignored package.json files when ignored reads are disabled", async (t) => {
  const client = await withClient(t);
  const ignoredPackageProjectRoot = path.join(root, "ignored-package-project");
  mkdirSync(ignoredPackageProjectRoot, { recursive: true });
  writeFileSync(path.join(ignoredPackageProjectRoot, ".gitignore"), "package.json\n", "utf8");
  writeFileSync(path.join(ignoredPackageProjectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ignored')\"" } }, null, 2), "utf8");
  execFileSync("git", ["init"], { cwd: ignoredPackageProjectRoot, stdio: "ignore" });

  const projectAlias = "ignored-package";
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias, rootPath: ignoredPackageProjectRoot } }));
  updatePermissions({ projectAlias, permissions: { chatgpt: { runPackageScripts: true } } });

  for (const call of [
    { name: "project_list_scripts", arguments: { projectAlias } },
    { name: "project_run_checks", arguments: { projectAlias } },
    { name: "project_run_script", arguments: { projectAlias, scriptName: "check" } }
  ]) {
    const response = await client.callTool(call);
    assert.equal(response.isError, true, `${call.name} should deny ignored package.json`);
    assert.match(JSON.stringify(response.structuredContent), /readGitIgnoredFiles/);
  }
});

test("MCP git diff and symbol search do not leak blocked tracked files", async (t) => {
  const client = await withClient(t);
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias: "blocked", rootPath: projectRoot } }));

  const diff = resultOf(await client.callTool({ name: "project_git_diff", arguments: { projectAlias: "blocked", maxChars: 20000 } }));
  assert.doesNotMatch(diff.diff, /SECRET_TOKEN/);
  assert.deepEqual(diff.skippedPaths, [".env"]);

  const symbols = resultOf(await client.callTool({ name: "project_search_symbols", arguments: { projectAlias: "blocked", query: "SECRET_TOKEN", maxResults: 20 } }));
  assert.equal(symbols.matches.length, 0);

  const text = resultOf(await client.callTool({ name: "project_search_text", arguments: { projectAlias: "blocked", query: "SECRET_TOKEN", maxResults: 20 } }));
  assert.equal(text.matches.length, 0);
});

test("MCP mutation tools cannot operate on existing gitignored files when ignored reads are disabled", async (t) => {
  const client = await withClient(t);
  const projectAlias = "ignored-mutation";
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias, rootPath: projectRoot } }));
  updatePermissions({ projectAlias, permissions: { chatgpt: { moveFiles: true, deleteFiles: true } } });

  for (const call of [
    { name: "project_write_file", arguments: { projectAlias, relativePath: "ignored.txt", content: "overwrite\n" } },
    { name: "project_move_file", arguments: { projectAlias, sourceRelativePath: "ignored.txt", destinationRelativePath: "visible-from-ignored.txt" } },
    { name: "project_move_file", arguments: { projectAlias, sourceRelativePath: "README.md", destinationRelativePath: "ignored.txt", overwrite: true } },
    { name: "project_delete_file", arguments: { projectAlias, relativePath: "ignored.txt", confirm: true } },
    { name: "project_delete_directory", arguments: { projectAlias, relativePath: "ignored-delete-dir", recursive: true, confirm: true } },
    { name: "project_replace_text", arguments: { projectAlias, relativePath: "ignored.txt", search: "hidden", replace: "visible", dryRun: true } },
    { name: "project_insert_text", arguments: { projectAlias, relativePath: "ignored.txt", marker: "hidden", content: "visible", position: "before", dryRun: true } },
    {
      name: "project_apply_patch",
      arguments: {
        projectAlias,
        dryRun: true,
        patch: [
          "diff --git a/ignored.txt b/ignored.txt",
          "--- a/ignored.txt",
          "+++ b/ignored.txt",
          "@@ -1 +1 @@",
          "-hidden ignored content",
          "+changed ignored content",
          ""
        ].join("\n")
      }
    },
    {
      name: "project_apply_patch",
      arguments: {
        projectAlias,
        dryRun: true,
        confirm: true,
        patch: [
          "diff --git a/ignored.txt b/ignored.txt",
          "deleted file mode 100644",
          "--- a/ignored.txt",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-hidden ignored content",
          ""
        ].join("\n")
      }
    }
  ]) {
    const response = await client.callTool(call);
    assert.equal(response.isError, true, `${call.name} should deny existing ignored path`);
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
  const created = resultOf(await client.callTool({ name: "project_apply_patch", arguments: { projectAlias, patch: createIgnoredFilePatch, dryRun: true } }));
  assert.equal(created.applied, false);
  assert.equal(created.dryRun, true);
  assert.deepEqual(created.changedFiles, ["ignored-dir/generated.txt"]);
});

test("MCP mutation tools reject oversized input payloads", async (t) => {
  const client = await withClient(t);
  const projectAlias = "input-limits";
  resultOf(await client.callTool({ name: "project_register", arguments: { projectAlias, rootPath: projectRoot } }));

  for (const call of [
    {
      name: "project_write_file",
      arguments: { projectAlias, relativePath: "large.txt", content: "x".repeat(1000001) },
      error: /maxWriteBytes/
    },
    {
      name: "project_apply_patch",
      arguments: { projectAlias, patch: "x".repeat(1000001), dryRun: true },
      error: /maxPatchBytes/
    },
    {
      name: "project_replace_text",
      arguments: { projectAlias, relativePath: "README.md", search: "x".repeat(20001), replace: "small", dryRun: true },
      error: /maxSearchOrMarkerBytes/
    },
    {
      name: "project_replace_text",
      arguments: { projectAlias, relativePath: "README.md", search: "Security", replace: "x".repeat(200001), dryRun: true },
      error: /maxTextOperationBytes/
    },
    {
      name: "project_insert_text",
      arguments: { projectAlias, relativePath: "README.md", marker: "x".repeat(20001), content: "small", position: "after", dryRun: true },
      error: /maxSearchOrMarkerBytes/
    },
    {
      name: "project_insert_text",
      arguments: { projectAlias, relativePath: "README.md", marker: "Security", content: "x".repeat(200001), position: "after", dryRun: true },
      error: /maxTextOperationBytes/
    }
  ]) {
    const response = await client.callTool(call);
    assert.equal(response.isError, true, `${call.name} should reject oversized input`);
    assert.match(JSON.stringify(response.structuredContent), call.error);
  }
});
