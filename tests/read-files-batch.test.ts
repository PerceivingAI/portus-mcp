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
  subagents: {
    concurrency: { maxConcurrent: 4, maxConcurrentPerProject: 2, queueEnabled: false, maxQueueDepth: 10 },
    lifecycle: { queuedTaskTtlSecs: 300, projectLockTimeoutSecs: 1800, maxRuntimeSecs: 900, startupWatchdogMs: 15000, forcedCloseGraceMs: 8000, killEscalationDelayMs: 1200, queueDrainDelayMs: 50 },
    permissions: { networkAccess: true, allowedCommands: ["git"] }
  },
  chatgpt: { permissions: { subagentTask: false, projectContext: true, projectRead: true, projectSearch: true, projectEdit: false, projectPatch: false, projectRun: false, projectPolicy: true, readGitIgnoredFiles: false, allowedCommands: ["git"] } },
  pathPolicy: { blockedPatterns: [".env"] },
  limits: {
    fileRead: { maxChars: 500000 }, fileWrite: { maxChars: 1000000 }, patch: { maxChars: 1000000 },
    textEdit: { maxOperationChars: 200000, maxSearchOrMarkerChars: 20000 }, search: { maxScanEntries: 100000, maxTextFileChars: 200000 },
    skills: { maxReadChars: 200000 }, subagentOutput: { maxStdoutChars: 200000, maxStderrChars: 200000 },
    sessionEvents: { maxEvents: 500, maxChunkChars: 4000 }, audit: { maxEvents: 1000 }, process: { maxOutputBufferMb: 10 }
  },
  audit: { strictMode: false }
};

function writePolicy(maxChars = 500000): void {
  writeFileSync(policyPath, JSON.stringify({ ...basePolicy, limits: { ...basePolicy.limits, fileRead: { maxChars } } }, null, 2), "utf8");
}
writePolicy();
writeFileSync(configPath, JSON.stringify({
  subagents: { defaultTemplate: "ephemeral-project-subagent", retry: { enabled: true, maxAttempts: 3, baseDelayMs: 1500, maxDelayMs: 15000, jitterRatio: 0.2, retryOn: ["provider_rate_limited"], respectRetryAfter: true, maxRetryWindowSecs: 60 } },
  traversal: { excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"] }
}, null, 2), "utf8");
process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.AGENT_SKILL_PATHS = "";
process.env.SUBAGENTS_SKILL_PATHS = "";

// Configuration reads environment variables at module initialization, so this test intentionally imports after fixture setup.
const { createHttpServer } = await import("../src/server.js");
const { updatePermissions } = await import("../src/state/PermissionRegistry.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { stateStore } = await import("../src/state/StateStore.js");

const requestedSchema = z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
const actualSchema = z.object({ startLine: z.number().int().positive().nullable(), endLine: z.number().int().positive().nullable(), lineCount: z.number().int().nonnegative() }).strict();
const successSchema = z.object({
  ok: z.literal(true), index: z.number().int().nonnegative(), mode: z.literal("content"), relativePath: z.string(), requested: requestedSchema, actual: actualSchema, content: z.string(), hasMore: z.boolean(), truncated: z.boolean(),
  chars: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative(), omittedChars: z.number().int().nonnegative(), limit: z.number().int().positive(), projectAlias: z.string()
}).strict();
const itemErrorSchema = z.object({ ok: z.literal(false), index: z.number().int().nonnegative(), mode: z.literal("content"), relativePath: z.string(), error: z.string() }).strict();
const readSchema = z.object({
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
  return z.object({ result: readSchema }).strict().parse(response.structuredContent).result;
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
async function callRead(client: Client, requests: unknown): Promise<CallToolResult> {
  const normalized = Array.isArray(requests) ? requests.map((request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) return request;
    const item = request as Record<string, unknown>;
    return item.startLine === undefined && item.endLine === undefined ? { ...item, startLine: 1, endLine: 200 } : item;
  }) : requests;
  return client.callTool({ name: "project_read", arguments: { projectAlias: "batch", requests: normalized } });
}

test("project_read exposes and enforces its complete MCP batch contract", async (t) => {
  t.after(() => writePolicy());
  const client = await withClient(t);

  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "project_read");
  assert(tool, "project_read was not discovered");
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["projectAlias", "requests"]);
  const requestsSchema = tool.inputSchema.properties?.requests as {
    type?: string;
    minItems?: number;
    maxItems?: number;
    items?: { properties?: Record<string, unknown>; additionalProperties?: boolean };
  };
  assert.equal(requestsSchema.type, "array");
  assert.equal(requestsSchema.minItems, 1);
  assert.equal(requestsSchema.maxItems, 50);
  assert.deepEqual(Object.keys(requestsSchema.items?.properties ?? {}).sort(), ["endLine", "mode", "relativePath", "startLine"]);
  assert.equal(requestsSchema.items?.additionalProperties, false);
  const published = JSON.stringify(tool.inputSchema);
  for (const forbidden of ["maxChars", "limit", "maxBytes", "maxFiles", "includeHash", "includeBinary", "ignorePolicy"]) assert.equal(published.includes(`\"${forbidden}\"`), false, `published forbidden input name: ${forbidden}`);
  assert.equal(listed.tools.some((candidate) => candidate.name === "project_read_files"), false);

  upsertProject({ projectAlias: "batch", rootPath: projectRoot });

  const explanation = await client.callTool({ name: "project_policy", arguments: { checks: [{ type: "permissions", projectAlias: "batch", operation: "project_read" }] } });
  assertNoRoots(explanation);
  assert.deepEqual(z.object({ result: z.object({ results: z.array(z.object({ requiredPermissions: z.array(z.string()) }).passthrough()) }) }).parse(explanation.structuredContent).result.results[0]?.requiredPermissions, ["projectRead"]);

  await t.test("returns multiple successes in request order with indexes, duplicates, and per-file ranges", async () => {
    const batch = resultOf(await callRead(client, [
      { relativePath: "one.txt", mode: "content", startLine: 2, endLine: 3 },
      { relativePath: "two.txt", mode: "content" },
      { relativePath: "one.txt", mode: "content", startLine: 1, endLine: 1 }
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
    const batch = resultOf(await callRead(client, paths.map((relativePath) => ({ relativePath, mode: "content" }))));
    assert.equal(batch.requestedCount, paths.length);
    assert.equal(batch.successCount, 2);
    assert.equal(batch.errorCount, 7);
    assert.deepEqual(batch.results.map((item) => item.index), paths.map((_, index) => index));
    assert.equal(batch.results[0].ok, true);
    assert.equal(batch.results.at(-1)?.ok, true);
    const errors = batch.results.slice(1, -1).map((item) => itemErrorSchema.parse(item));
    for (const [error, expected] of errors.map((item) => item.error).entries()) {
      assert.match(expected, [/File does not exist: missing\.txt/, /not likely text/i, /not a file/i, /escapes project root/i, /Operation failed: \[invalid path\]/i, /Blocked path pattern/, /readGitIgnoredFiles|Unable to read text file: ignored\.txt/][error]);
    }
  });

  await t.test("isolates semantic range failures and rejects malformed numeric ranges", async () => {
    const cases = [
      [{ relativePath: "one.txt", mode: "content", startLine: 4, endLine: 2 }, "endLine must be greater than or equal to startLine"],
      [{ relativePath: "one.txt", mode: "content", startLine: 1, endLine: 2001 }, "Requested line range exceeds maximum of 2000 lines"]
    ] as const;
    const batch = resultOf(await callRead(client, [...cases.map(([request]) => request), { relativePath: "two.txt", mode: "content" }]));
    assert.equal(batch.successCount, 1);
    assert.equal(batch.errorCount, cases.length);
    for (const [index, [, expected]] of cases.entries()) {
      const error = itemErrorSchema.parse(batch.results[index]);
      assert.equal(error.error, expected);
    }
    assert.equal(batch.results.at(-1)?.ok, true);
    for (const requests of [
      [{ relativePath: "one.txt", mode: "content", startLine: 0 }],
      [{ relativePath: "one.txt", mode: "content", endLine: 0 }],
      [{ relativePath: "one.txt", mode: "content", startLine: 1.5 }],
      [{ relativePath: "one.txt", mode: "content", endLine: 2.5 }]
    ]) errorOf(await callRead(client, requests));
  });

  await t.test("rejects malformed and out-of-cardinality batches at the top level", async () => {
    for (const requests of [[], Array.from({ length: 51 }, () => ({ relativePath: "one.txt", mode: "content" })), [{ relativePath: "one.txt", mode: "content", startLine: "1" }]]) {
      errorOf(await callRead(client, requests));
    }
  });

  await t.test("checks read permission once for the whole call", async () => {
    updatePermissions({ projectAlias: "batch", permissions: { chatgpt: { projectRead: false } } });
    assert.equal(errorOf(await callRead(client, [{ relativePath: "missing.txt", mode: "content" }, { relativePath: "one.txt", mode: "content" }])), "Permission denied: chatgpt.projectRead is false");
    updatePermissions({ projectAlias: "batch", permissions: { chatgpt: { projectRead: true } } });
  });

  await t.test("applies the server limit independently and counts Unicode code points", async () => {
    writePolicy(3);
    const batch = resultOf(await callRead(client, [{ relativePath: "unicode.txt", mode: "content" }, { relativePath: "two.txt", mode: "content" }]));
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

  const events = stateStore.readAudit();
  assert.equal(events.some((event) => event.tool === "project_read"), false);
  assert.equal(events.some((event) => event.tool === "project_read_files"), false);
});
