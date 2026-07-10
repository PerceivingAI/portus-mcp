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

const root = mkdtempSync(path.join(tmpdir(), "portus-read-files-batch-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
mkdirSync(path.join(projectRoot, "directory"), { recursive: true });
mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
writeFileSync(path.join(projectRoot, "one.txt"), "one\ntwo\nthree\nfour\n", "utf8");
writeFileSync(path.join(projectRoot, "two.txt"), "alpha\nbeta\ngamma\n", "utf8");
writeFileSync(path.join(projectRoot, "unicode.txt"), "🙂🙂🙂🙂\n", "utf8");
writeFileSync(path.join(projectRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
writeFileSync(path.join(projectRoot, ".env"), "SECRET=value\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored.txt"), "ignored\n", "utf8");
writeFileSync(path.join(projectRoot, ".gitignore"), "ignored.txt\n", "utf8");
writeFileSync(path.join(projectRoot, "node_modules", "blocked.txt"), "blocked\n", "utf8");
writeFileSync(path.join(root, "outside.txt"), "outside\n", "utf8");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });

const basePolicy = {
  agents: {
    concurrency: { maxConcurrent: 4, maxConcurrentPerProject: 2, queueEnabled: false, maxQueueDepth: 10 },
    lifecycle: { queuedTaskTtlSecs: 300, projectLockTimeoutSecs: 1800, maxRuntimeSecs: 900, startupWatchdogMs: 15000, forcedCloseGraceMs: 8000, killEscalationDelayMs: 1200, queueDrainDelayMs: 50 },
    permissions: { networkAccess: true, allowedCommands: ["git"] }
  },
  chatgpt: { permissions: { registerProjects: true, updatePermissions: true, spawnAgents: false, readFiles: true, writeFiles: false, moveFiles: false, deleteFiles: false, readGitIgnoredFiles: false, runPackageScripts: false, allowedCommands: ["git"] } },
  pathPolicy: { blockedPatterns: [".env"] },
  limits: {
    fileRead: { maxChars: 500000 }, fileWrite: { maxChars: 1000000 }, patch: { maxChars: 1000000 },
    textEdit: { maxOperationChars: 200000, maxSearchOrMarkerChars: 20000 }, search: { maxScanEntries: 100000, maxTextFileChars: 200000 },
    skills: { maxReadChars: 200000 }, agentOutput: { maxStdoutChars: 200000, maxStderrChars: 200000 },
    sessionEvents: { maxEvents: 500, maxChunkChars: 4000 }, audit: { maxEvents: 1000 }, process: { maxOutputBufferMb: 10 }
  },
  audit: { strictMode: false }
};

function writePolicy(maxChars = 500000): void {
  writeFileSync(policyPath, JSON.stringify({ ...basePolicy, limits: { ...basePolicy.limits, fileRead: { maxChars } } }, null, 2), "utf8");
}
writePolicy();
writeFileSync(configPath, JSON.stringify({
  agents: { defaultTemplate: "ephemeral-project-agent", retry: { enabled: true, maxAttempts: 3, baseDelayMs: 1500, maxDelayMs: 15000, jitterRatio: 0.2, retryOn: ["provider_rate_limited"], respectRetryAfter: true, maxRetryWindowSecs: 60 } },
  traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"] },
  skills: { directory: "skills" }
}, null, 2), "utf8");
process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;

// Configuration reads environment variables at module initialization, so this test intentionally imports after fixture setup.
const { createHttpServer } = await import("../src/server.js");
const { updatePermissions } = await import("../src/state/PermissionRegistry.js");

const requestedSchema = z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
const actualSchema = z.object({ startLine: z.number().int().positive().nullable(), endLine: z.number().int().positive().nullable(), lineCount: z.number().int().nonnegative() }).strict();
const successSchema = z.object({
  ok: z.literal(true), index: z.number().int().nonnegative(), relativePath: z.string(), requested: requestedSchema, actual: actualSchema, content: z.string(), hasMore: z.boolean(), truncated: z.boolean(),
  chars: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative(), omittedChars: z.number().int().nonnegative(), limit: z.number().int().positive()
}).strict();
const itemErrorSchema = z.object({ ok: z.literal(false), index: z.number().int().nonnegative(), relativePath: z.string(), error: z.string() }).strict();
const batchSchema = z.object({
  projectAlias: z.string(), requestedCount: z.number().int().nonnegative(), successCount: z.number().int().nonnegative(), errorCount: z.number().int().nonnegative(),
  results: z.array(z.union([successSchema, itemErrorSchema]))
}).strict();

function assertNoRoots(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [root, projectRoot]) {
    assert.equal(serialized.includes(JSON.stringify(forbidden).slice(1, -1)), false, `output leaked absolute root: ${serialized}`);
  }
}
function resultOf(response: CallToolResult) {
  assertNoRoots(response);
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  return z.object({ result: batchSchema }).strict().parse(response.structuredContent).result;
}
function errorOf(response: CallToolResult): string {
  assertNoRoots(response);
  assert.equal(response.isError, true);
  const parsed = z.object({ error: z.string() }).safeParse(response.structuredContent);
  return parsed.success ? parsed.data.error : response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}
async function withClient(t: TestContext): Promise<Client> {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "read-files-batch-test", version: "0.1.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  t.after(async () => client.close());
  return client;
}
async function callBatch(client: Client, files: unknown): Promise<CallToolResult> {
  return client.callTool({ name: "project_read_files", arguments: { projectAlias: "batch", files } });
}

test("project_read_files exposes and enforces its complete MCP batch contract", async (t) => {
  t.after(() => writePolicy());
  const client = await withClient(t);

  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "project_read_files");
  assert(tool, "project_read_files was not discovered");
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["files", "projectAlias"]);
  const filesSchema = z.object({
    type: z.literal("array"),
    minItems: z.literal(1),
    maxItems: z.literal(20),
    items: z.object({
      type: z.literal("object"),
      properties: z.object({
        relativePath: z.object({ type: z.literal("string"), minLength: z.literal(1) }).passthrough(),
        startLine: z.object({ type: z.literal("number") }).passthrough(),
        endLine: z.object({ type: z.literal("number") }).passthrough()
      }).strict(),
      required: z.tuple([z.literal("relativePath")]),
      additionalProperties: z.literal(false)
    }).passthrough()
  }).passthrough().parse(tool.inputSchema.properties?.files);
  assert.deepEqual(Object.keys(filesSchema.items.properties).sort(), ["endLine", "relativePath", "startLine"]);
  const published = JSON.stringify(tool.inputSchema);
  for (const forbidden of ["maxChars", "limit", "maxBytes", "maxFiles", "includeHash", "includeBinary", "ignorePolicy"]) assert.equal(published.includes(`\"${forbidden}\"`), false, `published forbidden input name: ${forbidden}`);

  const register = await client.callTool({ name: "project_register", arguments: { projectAlias: "batch", rootPath: projectRoot } });
  assert.equal(register.isError, undefined);

  const explanation = await client.callTool({ name: "policy_explain_permissions", arguments: { projectAlias: "batch", operation: "project_read_files" } });
  assertNoRoots(explanation);
  assert.deepEqual(z.object({ result: z.object({ requiredPermissions: z.array(z.string()) }).passthrough() }).parse(explanation.structuredContent).result.requiredPermissions, ["readFiles"]);

  await t.test("returns multiple successes in request order with indexes, duplicates, and per-file ranges", async () => {
    const batch = resultOf(await callBatch(client, [
      { relativePath: "one.txt", startLine: 2, endLine: 3 },
      { relativePath: "two.txt" },
      { relativePath: "one.txt", startLine: 1, endLine: 1 }
    ]));
    assert.deepEqual({ projectAlias: batch.projectAlias, requestedCount: batch.requestedCount, successCount: batch.successCount, errorCount: batch.errorCount }, { projectAlias: "batch", requestedCount: 3, successCount: 3, errorCount: 0 });
    assert.deepEqual(batch.results.map((item) => item.relativePath), ["one.txt", "two.txt", "one.txt"]);
    assert.deepEqual(batch.results.map((item) => item.index), [0, 1, 2]);
    const successes = z.array(successSchema).parse(batch.results);
    assert.deepEqual(successes[0].requested, { startLine: 2, endLine: 3 });
    assert.deepEqual(successes[0].actual, { startLine: 2, endLine: 3, lineCount: 2 });
    assert.equal(successes[0].content, "two\nthree");
    assert.deepEqual(successes[1].requested, { startLine: 1, endLine: 200 });
    assert.equal(successes[1].content, "alpha\nbeta\ngamma");
    assert.equal(successes[2].content, "one");
  });

  await t.test("isolates ordinary and unsafe file failures while the batch succeeds", async () => {
    const paths = ["one.txt", "missing.txt", "binary.bin", "directory", "../outside.txt", path.join(root, "outside.txt"), ".env", "ignored.txt", "two.txt"];
    const batch = resultOf(await callBatch(client, paths.map((relativePath) => ({ relativePath }))));
    assert.equal(batch.requestedCount, paths.length);
    assert.equal(batch.successCount, 2);
    assert.equal(batch.errorCount, 7);
    assert.deepEqual(batch.results.map((item) => item.index), paths.map((_, index) => index));
    assert.equal(batch.results[0].ok, true);
    assert.equal(batch.results.at(-1)?.ok, true);
    const errors = batch.results.slice(1, -1).map((item) => itemErrorSchema.parse(item));
    for (const [error, expected] of errors.map((item) => item.error).entries()) {
      assert.match(expected, [/File does not exist: missing\.txt/, /not likely text/i, /not a file/i, /escapes project root/i, /not allowed|Unable to read text file/i, /Blocked path pattern/, /readGitIgnoredFiles|Unable to read text file: ignored\.txt/][error]);
    }
  });

  await t.test("keeps invalid numeric ranges as isolated item errors", async () => {
    const cases = [
      [{ relativePath: "one.txt", startLine: 4, endLine: 2 }, "endLine must be greater than or equal to startLine"],
      [{ relativePath: "one.txt", startLine: 0 }, "startLine must be a positive integer"],
      [{ relativePath: "one.txt", endLine: 0 }, "endLine must be a positive integer"],
      [{ relativePath: "one.txt", startLine: 1.5 }, "startLine must be a positive integer"],
      [{ relativePath: "one.txt", endLine: 2.5 }, "endLine must be a positive integer"],
      [{ relativePath: "one.txt", startLine: 1, endLine: 2001 }, "Requested line range exceeds maximum of 2000 lines"]
    ] as const;
    const batch = resultOf(await callBatch(client, [...cases.map(([file]) => file), { relativePath: "two.txt" }]));
    assert.equal(batch.successCount, 1);
    assert.equal(batch.errorCount, cases.length);
    for (const [index, [, expected]] of cases.entries()) {
      const error = itemErrorSchema.parse(batch.results[index]);
      assert.equal(error.error, expected);
    }
    assert.equal(batch.results.at(-1)?.ok, true);
  });

  await t.test("rejects malformed and out-of-cardinality batches at the top level", async () => {
    for (const files of [[], Array.from({ length: 21 }, () => ({ relativePath: "one.txt" })), [{ relativePath: "one.txt", startLine: "1" }]]) {
      errorOf(await callBatch(client, files));
    }
  });

  await t.test("checks read permission once for the whole call", async () => {
    updatePermissions({ projectAlias: "batch", permissions: { chatgpt: { readFiles: false } } });
    assert.equal(errorOf(await callBatch(client, [{ relativePath: "missing.txt" }, { relativePath: "one.txt" }])), "Permission denied: chatgpt.readFiles is false");
    updatePermissions({ projectAlias: "batch", permissions: { chatgpt: { readFiles: true } } });
  });

  await t.test("applies the server limit independently and counts Unicode code points", async () => {
    writePolicy(3);
    const batch = resultOf(await callBatch(client, [{ relativePath: "unicode.txt" }, { relativePath: "two.txt" }]));
    const successes = z.array(successSchema).parse(batch.results);
    for (const item of successes) {
      assert.equal(item.limit, 3);
      assert.equal(item.chars, 3);
      assert.equal(Array.from(item.content).length, 3);
      assert.equal(item.truncated, true);
    }
    assert.equal(successes[0].content, "🙂🙂🙂");
    assert.equal(successes[0].totalChars, 4);
    assert.equal(successes[0].omittedChars, 1);
    assert.equal(successes[1].content, "alp");
    assert.equal(successes[1].totalChars, 16);
    assert.equal(successes[1].omittedChars, 13);
    writePolicy();
  });

  const audit = await client.callTool({ name: "audit_list", arguments: { projectAlias: "batch" } });
  assertNoRoots(audit);
  const events = z.object({ result: z.object({ events: z.array(z.object({ tool: z.string().optional() }).passthrough()) }) }).parse(audit.structuredContent).result.events;
  assert.equal(events.some((event) => event.tool === "project_read_files"), false);
});
