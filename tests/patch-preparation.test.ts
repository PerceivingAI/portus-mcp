import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TestContext } from "node:test";
import { z } from "zod";

const root = mkdtempSync(path.join(tmpdir(), "portus-patch-preparation-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "existing.txt"), "old\n", "utf8");
writeFileSync(path.join(projectRoot, "empty.txt"), "", "utf8");
writeFileSync(path.join(projectRoot, "deleted.txt"), "remove me\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored.txt"), "ignored old\n", "utf8");
writeFileSync(path.join(projectRoot, ".gitignore"), "ignored.txt\n", "utf8");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
execFileSync("git", ["config", "user.email", "patch-test@example.invalid"], { cwd: projectRoot });
execFileSync("git", ["config", "user.name", "Patch Test"], { cwd: projectRoot });
execFileSync("git", ["add", ".gitignore", "existing.txt", "empty.txt", "deleted.txt"], { cwd: projectRoot });
execFileSync("git", ["commit", "-m", "fixture"], { cwd: projectRoot, stdio: "ignore" });

writeFileSync(policyPath, JSON.stringify({
  subagents: {
    concurrency: { maxConcurrent: 4, maxConcurrentPerProject: 2, queueEnabled: false, maxQueueDepth: 10 },
    lifecycle: {
      queuedTaskTtlSecs: 300,
      projectLockTimeoutSecs: 1800,
      maxRuntimeSecs: 900,
      startupWatchdogMs: 15000,
      forcedCloseGraceMs: 8000,
      killEscalationDelayMs: 1200,
      queueDrainDelayMs: 50
    },
    permissions: { networkAccess: true, allowedCommands: ["git", "node"] }
  },
  chatgpt: {
    permissions: {
      registerProjects: true,
      updatePermissions: true,
      spawnSubagents: false,
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
  pathPolicy: { blockedPatterns: [".env"] },
  limits: {
    fileRead: { maxChars: 500000 },
    fileWrite: { maxChars: 1000000 },
    patch: { maxChars: 1000000 },
    textEdit: { maxOperationChars: 200000, maxSearchOrMarkerChars: 20000 },
    search: { maxScanEntries: 100000, maxTextFileChars: 200000 },
    skills: { maxReadChars: 200000 },
    subagentOutput: { maxStdoutChars: 200000, maxStderrChars: 200000 },
    sessionEvents: { maxEvents: 500, maxChunkChars: 4000 },
    audit: { maxEvents: 1000 },
    process: { maxOutputBufferMb: 10 }
  },
  audit: { strictMode: false }
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
      retryOn: ["provider_rate_limited"],
      respectRetryAfter: true,
      maxRetryWindowSecs: 60
    }
  },
  traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"] }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";

// Configuration modules read environment variables during module initialization, so this import must follow fixture setup.
const { createHttpServer } = await import("../src/server.js");
// State modules read environment variables during initialization, so fixture registration follows environment setup.
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { updatePermissions } = await import("../src/state/PermissionRegistry.js");
upsertProject({ projectAlias: "patch", rootPath: projectRoot });
upsertProject({ projectAlias: "prepare-read-only", rootPath: projectRoot });

const expectedFileSchema = z.object({
  relativePath: z.string(),
  exists: z.boolean(),
  isTextLikely: z.boolean().optional(),
  bytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  sha256: z.string().optional()
});
const preparedSchema = z.object({
  projectAlias: z.string(),
  changedFiles: z.array(z.string()),
  deletedFiles: z.array(z.string()),
  expectedFiles: z.array(expectedFileSchema),
  readyForApply: z.boolean()
});
const appliedSchema = z.object({
  applied: z.boolean(),
  dryRun: z.boolean(),
  changedFiles: z.array(z.string()),
  deletedFiles: z.array(z.string())
});
const permissionSchema = z.object({ requiredPermissions: z.array(z.string()) });
const errorSchema = z.object({ error: z.string() });

function resultOf<T>(response: CallToolResult, schema: z.ZodType<T>): T {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const envelope = z.object({ result: schema }).parse(response.structuredContent);
  return envelope.result;
}

function errorOf(response: CallToolResult): string {
  assert.equal(response.isError, true);
  return errorSchema.parse(response.structuredContent).error;
}

async function withClient(t: TestContext): Promise<Client> {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "patch-preparation-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

const combinedPatch = [
  "diff --git a/existing.txt b/existing.txt",
  "--- a/existing.txt",
  "+++ b/existing.txt",
  "@@ -1 +1 @@",
  "-old",
  "+updated",
  "diff --git a/empty.txt b/empty.txt",
  "--- a/empty.txt",
  "+++ b/empty.txt",
  "@@ -0,0 +1 @@",
  "+filled",
  "diff --git \"a/new file.txt\" \"b/new file.txt\"",
  "new file mode 100644",
  "--- /dev/null",
  "+++ \"b/new file.txt\"",
  "@@ -0,0 +1 @@",
  "+created",
  "diff --git a/deleted.txt b/deleted.txt",
  "deleted file mode 100644",
  "--- a/deleted.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-remove me",
  ""
].join("\n");

test("project_patch is discoverable and uses only its broad permission", async (t) => {
  const client = await withClient(t);
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "project_patch");
  assert(tool, "project_patch was not discovered");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  });

  const policy = resultOf(await client.callTool({
    name: "project_policy",
    arguments: {
      checks: [{ type: "permissions", projectAlias: "patch", operation: "project_patch" }]
    }
  }), z.object({ results: z.array(permissionSchema) }));
  assert.deepEqual(policy.results[0]?.requiredPermissions, ["projectPatch"]);

  updatePermissions({
    projectAlias: "prepare-read-only",
    permissions: { chatgpt: { projectEdit: false, } }
  });
  const preparedWithoutWriteGrants = resultOf(await client.callTool({
    name: "project_patch",
    arguments: {
      projectAlias: "prepare-read-only",
      mode: "prepare",
      patch: combinedPatch,
      includeHash: false
    }
  }), preparedSchema);
  assert.equal(preparedWithoutWriteGrants.readyForApply, true);
  assert.equal(preparedWithoutWriteGrants.expectedFiles.some((entry) => entry.sha256 !== undefined), false);


  updatePermissions({
    projectAlias: "prepare-read-only",
    permissions: { chatgpt: { projectPatch: false } }
  });
  const denied = await client.callTool({
    name: "project_patch",
    arguments: { projectAlias: "prepare-read-only", mode: "prepare", patch: combinedPatch }
  });
  assert.match(errorOf(denied), /chatgpt\.projectPatch/);
});

test("prepare returns existing, new, deleted, and zero-byte metadata usable by apply", async (t) => {
  const client = await withClient(t);
  const prepared = resultOf(await client.callTool({
    name: "project_patch",
    arguments: { projectAlias: "patch", mode: "prepare", patch: combinedPatch }
  }), preparedSchema);

  assert.deepEqual(prepared.changedFiles, ["existing.txt", "empty.txt", "new file.txt", "deleted.txt"]);
  assert.deepEqual(prepared.deletedFiles, ["deleted.txt"]);
  assert.equal(prepared.readyForApply, true);
  assert.deepEqual(Object.keys(prepared).sort(), ["changedFiles", "deletedFiles", "expectedFiles", "projectAlias", "readyForApply"]);
  const byPath = new Map(prepared.expectedFiles.map((entry) => [entry.relativePath, entry]));
  assert.equal(byPath.get("existing.txt")?.exists, true);
  assert.equal(byPath.get("existing.txt")?.bytes, Buffer.byteLength("old\n"));
  assert.equal(byPath.get("existing.txt")?.isTextLikely, true);
  assert.match(byPath.get("existing.txt")?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(byPath.get("empty.txt")?.exists, true);
  assert.equal(byPath.get("empty.txt")?.bytes, 0);
  assert.match(byPath.get("empty.txt")?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(byPath.get("new file.txt")?.exists, false);
  assert.deepEqual(byPath.get("new file.txt"), { relativePath: "new file.txt", exists: false });
  assert.equal(byPath.get("deleted.txt")?.exists, true);
  assert.equal(JSON.stringify(prepared).includes(root), false);
  assert.equal(JSON.stringify(prepared).includes(projectRoot), false);
  const expectedFiles = prepared.expectedFiles.map(({ relativePath, sha256, modifiedAt }) => ({
    relativePath,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(modifiedAt === undefined ? {} : { modifiedAt })
  }));

  const dryRun = resultOf(await client.callTool({
    name: "project_patch",
    arguments: {
      projectAlias: "patch",
      mode: "apply",
      patch: combinedPatch,
      expectedFiles,
      dryRun: true,
      confirm: true
    }
  }), appliedSchema);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.dryRun, true);

  const applied = resultOf(await client.callTool({
    name: "project_patch",
    arguments: {
      projectAlias: "patch",
      mode: "apply",
      patch: combinedPatch,
      expectedFiles,
      confirm: true
    }
  }), appliedSchema);
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changedFiles, prepared.changedFiles);
  assert.deepEqual(applied.deletedFiles, prepared.deletedFiles);
  assert.equal(JSON.stringify(applied).includes(root), false);
  assert.equal(JSON.stringify(applied).includes(projectRoot), false);
});

test("prepare rejects blocked, escaping, ignored existing, and over-cap paths without absolute path leaks", async (t) => {
  const client = await withClient(t);
  const patches = [
    ["blocked", "Blocked path pattern.", [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -0,0 +1 @@",
      "+SECRET=nope",
      ""
    ].join("\n")],
    ["escaping", "Patch contains an invalid file header", [
      "diff --git a/ok.txt b/../../escape.txt",
      "--- a/ok.txt",
      "+++ b/../../escape.txt",
      "@@ -0,0 +1 @@",
      "+escape",
      ""
    ].join("\n")],
    ["ignored", "Permission denied: readGitIgnoredFiles is false for ignored path: ignored.txt", [
      "diff --git a/ignored.txt b/ignored.txt",
      "--- a/ignored.txt",
      "+++ b/ignored.txt",
      "@@ -1 +1 @@",
      "-ignored old",
      "+ignored new",
      ""
    ].join("\n")],
    ["cap", "Patch affects more than 100 unique paths", Array.from({ length: 101 }, (_, index) => [
      `diff --git a/file-${index}.txt b/file-${index}.txt`,
      `--- a/file-${index}.txt`,
      `+++ b/file-${index}.txt`,
      "@@ -0,0 +1 @@",
      "+content"
    ].join("\n")).join("\n")]
  ] as const;

  for (const [label, expectedError, patch] of patches) {
    const response = await client.callTool({
      name: "project_patch",
      arguments: { projectAlias: "patch", mode: "prepare", patch }
    });
    const error = errorOf(response);
    assert.equal(error, expectedError);
    assert.equal(error.includes(root), false, `${label} error leaked fixture root: ${error}`);
    assert.equal(error.includes(projectRoot), false, `${label} error leaked project root: ${error}`);
  }
});
