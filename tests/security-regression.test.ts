import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
      networkAccess: false,
      allowedCommands: ["git"]
    }
  },
  chatgpt: {
    permissions: {
      subagentTask: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      projectPatch: true,
      projectRun: true,
      projectPolicy: true,
      readGitIgnoredFiles: false,
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
    excludedPatterns: [".git", "skip-me"]
  }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.CEREBRAS_API_KEY = "test-key";

const { createHttpServer } = await import("../src/server.js");
const { assertSubagentPermission, assertChatGptPermission } = await import("../src/policy/permissionPolicy.js");
const { getEffectivePermissions, updatePermissions } = await import("../src/state/PermissionRegistry.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");

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
  for (const permission of ["readGitIgnoredFiles", "useShell"] as const) {
    assert.throws(() => assertChatGptPermission(permission, "missing-project"), /Permission denied/);
  }
  for (const permission of ["subagentTask", "projectContext", "projectRead", "projectSearch", "projectEdit", "projectPatch", "projectRun", "projectPolicy", "requireConfirmation"] as const) {
    assert.doesNotThrow(() => assertChatGptPermission(permission, "missing-project"));
  }

  for (const permission of ["network"] as const) {
    assert.throws(() => assertSubagentPermission(permission, "missing-project"), /Permission denied/);
  }
  for (const permission of ["maxRuntimeSecs"] as const) {
    assert.doesNotThrow(() => assertSubagentPermission(permission, "missing-project"));
  }
});

test("runtime permissions override policy defaults", () => {
  updatePermissions({ projectAlias: "runtime", permissions: { chatgpt: { }, subagents: { network: true } } });
  const effective = getEffectivePermissions("runtime");
  assert.equal(effective.chatgpt.projectEdit, true);
  assert.equal(effective.subagents.network, true);
});

test("each broad project tool is gated only by its matching permission", async (t) => {
  const client = await withClient(t);
  const projectAlias = "broad-gates";
  upsertProject({ projectAlias, rootPath: projectRoot });
  const cases = [
    { permission: "projectContext", tool: "project_context", arguments: { projectAlias, include: { status: true } } },
    { permission: "projectRead", tool: "project_read", arguments: { projectAlias, requests: [{ relativePath: "README.md", mode: "exists" }] } },
    { permission: "projectSearch", tool: "project_search", arguments: { projectAlias, mode: "files", query: "README" } },
    { permission: "projectEdit", tool: "project_edit", arguments: { projectAlias, operations: [{ type: "mkdir", relativePath: "dry-run" }], dryRun: true } },
    { permission: "projectPatch", tool: "project_patch", arguments: { projectAlias, mode: "prepare", patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-project fixture\n+project fixture updated\n" } },
    { permission: "projectRun", tool: "project_run", arguments: { projectAlias, type: "command", command: "git", args: ["status", "--short"] } },
    { permission: "projectPolicy", tool: "project_policy", arguments: { checks: [{ type: "permissions", projectAlias, operation: "project_read" }] } }
  ] as const;

  for (const entry of cases) {
    updatePermissions({ projectAlias, permissions: { chatgpt: { [entry.permission]: false } } });
    const denied = await client.callTool({ name: entry.tool, arguments: entry.arguments });
    assert.equal(denied.isError, true, `${entry.tool} should be denied`);
    assert.match(JSON.stringify(denied.structuredContent), new RegExp(`chatgpt\\.${entry.permission}`));
    updatePermissions({ projectAlias, permissions: { chatgpt: { [entry.permission]: true } } });
    const allowed = await client.callTool({ name: entry.tool, arguments: entry.arguments });
    assert.equal(allowed.isError, undefined, `${entry.tool} should be allowed: ${JSON.stringify(allowed.structuredContent)}`);
  }
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

  const linkedRegistration = upsertProject({ projectAlias, rootPath: rootLink });
  updatePermissions({ projectAlias, permissions: { chatgpt: { } } });
  assert.equal(linkedRegistration.rootPath, realpathSync.native(projectRoot));

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
    arguments: { projectAlias, mode: "text", query: "outside secret", relativePath: "outside-link" }
  }));
  assert.equal(search.sections.text.ok, false);
  assert.match(search.sections.text.error, /Path escapes project root/);

  const edits = resultOf(await client.callTool({
    name: "project_edit",
    arguments: {
      projectAlias,
      operations: [
        { type: "write", relativePath: "outside-link/created.txt", content: "must not escape\n" },
        { type: "mkdir", relativePath: "outside-link/created-dir", recursive: true },
        { type: "copy", sourceRelativePath: "README.md", destinationRelativePath: "outside-link/copied.txt" },
        { type: "move", sourceRelativePath: "README.md", destinationRelativePath: "outside-link/moved.txt" }
      ]
    }
  }));
  for (const escaped of edits.results) {
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
  upsertProject({ projectAlias: "sec", rootPath: projectRoot });

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
      arguments: { projectAlias: "sec", mode, query, maxResults: 20 }
    }));
    const matches = search.sections[mode].matches;
    assert.equal(matches.some((match: { relativePath: string }) =>
      match.relativePath.includes("ignored") || match.relativePath.includes(".portus-mcp") || match.relativePath.includes("skip-me")), false);
  }
});

test("MCP package script tools cannot consume ignored package.json files when ignored reads are disabled", async (t) => {
  const client = await withClient(t);
  const ignoredPackageProjectRoot = path.join(root, "ignored-package-project");
  mkdirSync(ignoredPackageProjectRoot, { recursive: true });
  writeFileSync(path.join(ignoredPackageProjectRoot, ".gitignore"), "package.json\n", "utf8");
  writeFileSync(path.join(ignoredPackageProjectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.log('ignored')\"" } }, null, 2), "utf8");
  execFileSync("git", ["init"], { cwd: ignoredPackageProjectRoot, stdio: "ignore" });

  const projectAlias = "ignored-package";
  upsertProject({ projectAlias, rootPath: ignoredPackageProjectRoot });
  updatePermissions({ projectAlias, permissions: { chatgpt: { projectRun: true } } });

  const context = resultOf(await client.callTool({
    name: "project_context",
    arguments: { projectAlias, include: { scripts: true } }
  }));
  assert.equal(context.sections.scripts.ok, false);
  assert.match(context.sections.scripts.error, /readGitIgnoredFiles/);

  for (const arguments_ of [
    { projectAlias, type: "check" },
    { projectAlias, type: "script", name: "check" }
  ]) {
    const response = await client.callTool({ name: "project_run", arguments: arguments_ });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /readGitIgnoredFiles/);
  }
});

test("direct file tools stay filtered while allowed git commands expose repository state", async (t) => {
  const client = await withClient(t);
  upsertProject({ projectAlias: "blocked", rootPath: projectRoot });

  const diff = resultOf(await client.callTool({
    name: "project_run",
    arguments: { projectAlias: "blocked", type: "command", command: "git", args: ["diff"] }
  }));
  assert.match(diff.stdout, /SECRET_TOKEN/);

  for (const mode of ["symbols", "text"] as const) {
    const search = resultOf(await client.callTool({
      name: "project_search",
      arguments: { projectAlias: "blocked", mode, query: "SECRET_TOKEN", maxResults: 20 }
    }));
    assert.equal(search.sections[mode].matches.length, 0);
  }
});

test("MCP mutation tools cannot operate on existing gitignored files when ignored reads are disabled", async (t) => {
  const client = await withClient(t);
  const projectAlias = "ignored-mutation";
  upsertProject({ projectAlias, rootPath: projectRoot });
  updatePermissions({ projectAlias, permissions: { chatgpt: { } } });

  const operations = [
    { type: "write", relativePath: "ignored.txt", content: "overwrite\n" },
    { type: "move", sourceRelativePath: "ignored.txt", destinationRelativePath: "visible-from-ignored.txt" },
    { type: "move", sourceRelativePath: "README.md", destinationRelativePath: "ignored.txt", overwrite: true },
    { type: "delete", relativePath: "ignored.txt", confirm: true },
    { type: "rmdir", relativePath: "ignored-delete-dir", recursive: true, confirm: true },
    { type: "replace", relativePath: "ignored.txt", search: "hidden", replace: "visible" },
    { type: "insert", relativePath: "ignored.txt", marker: "hidden", content: "visible", position: "before" }
  ];
  const edits = resultOf(await client.callTool({
    name: "project_edit",
    arguments: { projectAlias, operations, dryRun: true }
  }));
  for (const denied of edits.results) {
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
  upsertProject({ projectAlias, rootPath: projectRoot });

  for (const [operation, error] of [
    [{ type: "write", relativePath: "large.txt", content: "x".repeat(1000001) }, /limits\.fileWrite\.maxChars/],
    [{ type: "replace", relativePath: "README.md", search: "x".repeat(20001), replace: "small" }, /limits\.textEdit\.maxSearchOrMarkerChars/],
    [{ type: "replace", relativePath: "README.md", search: "Security", replace: "x".repeat(200001) }, /limits\.textEdit\.maxOperationChars/],
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


