import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TestContext } from "node:test";
import { z } from "zod";

const root = mkdtempSync(path.join(tmpdir(), "portus-read-file-range-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
mkdirSync(path.join(projectRoot, "directory"), { recursive: true });
writeFileSync(path.join(projectRoot, "lines.txt"), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n", "utf8");
writeFileSync(path.join(projectRoot, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
writeFileSync(path.join(projectRoot, "unicode.txt"), "🙂🙂\n", "utf8");
writeFileSync(path.join(projectRoot, ".env"), "SECRET=value\n", "utf8");
writeFileSync(path.join(projectRoot, "ignored.txt"), "ignored\n", "utf8");
writeFileSync(path.join(projectRoot, ".gitignore"), "ignored.txt\n", "utf8");
writeFileSync(path.join(projectRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
writeFileSync(path.join(root, "outside.txt"), "outside\n", "utf8");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });

const basePolicy = {
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
    permissions: { networkAccess: true, allowedCommands: ["git"] }
  },
  main_agent: {
    permissions: {
      subagentTask: false,
      subagentContext: false,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: false,
      readGitIgnoredFiles: false,
      projectPatch: true,
      projectRun: false,
      projectPolicy: true,
      requireConfirmation: false,
      allowShell: false,
      allowedCommands: ["git"]
    }
  },
  pathPolicy: { blockedPatterns: [".env"] },
  limits: {
    fileRead: { maxChars: 500000 },
    fileWrite: { maxChars: 1000000 },
    patch: { maxChars: 1000000 },
    textEdit: { maxOperationChars: 200000, maxSearchOrMarkerChars: 20000, maxRangeLines: 2000 },
    search: { maxScanEntries: 100000, maxTextFileChars: 200000, maxRegexExecutionMs: 120000, maxBatchMatches: 5000, maxBatchOutputChars: 500000 },
    skills: { maxReadChars: 200000 },
    subagentOutput: { maxStdoutChars: 200000, maxStderrChars: 200000 },
    sessionEvents: { maxEvents: 500, maxChunkChars: 4000 },
    audit: { maxEvents: 1000 },
    process: { maxOutputBufferMb: 10, maxBatchOutputChars: 1000000 }
  },
  audit: { strictMode: false }
};

function writePolicy(maxChars = basePolicy.limits.fileRead.maxChars): void {
  writeFileSync(policyPath, JSON.stringify({
    ...basePolicy,
    limits: { ...basePolicy.limits, fileRead: { maxChars } }
  }, null, 2), "utf8");
}

writePolicy();
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

// Configuration modules read environment variables during module initialization, so these imports must follow fixture setup.
const { createHttpServer } = await import("../src/server.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { stateStore } = await import("../src/state/StateStore.js");

const rangeResultSchema = z.object({
  projectAlias: z.string(),
  relativePath: z.string(),
  requested: z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict(),
  actual: z.object({
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    lineCount: z.number().int().nonnegative()
  }).strict(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
  chars: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(),
  omittedChars: z.number().int().nonnegative(),
  limit: z.number().int().positive()
}).strict();
const fullResultSchema = z.object({
  projectAlias: z.string(),
  relativePath: z.string(),
  content: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  truncated: z.boolean(),
  chars: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(),
  omittedChars: z.number().int().nonnegative(),
  limit: z.number().int().positive()
}).strict();
const errorSchema = z.object({ error: z.string() });

function resultOf<T>(response: CallToolResult, schema: z.ZodType<T>): T {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const wrapped = z.object({ result: z.unknown() }).parse(response.structuredContent).result;
  const broad = z.object({ results: z.array(z.object({ ok: z.boolean(), index: z.number(), mode: z.string() }).passthrough()) }).safeParse(wrapped);
  if (!broad.success) return schema.parse(wrapped);
  const item = broad.data.results[0];
  assert(item);
  const { ok, index, mode, ...value } = item;
  assert.equal(ok, true, JSON.stringify(item));
  assert.equal(index, 0);
  assert.equal(mode, "content");
  return schema.parse(value);
}

function errorOf(response: CallToolResult): string {
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(root), false, `error leaked fixture root: ${serialized}`);
  assert.equal(serialized.includes(projectRoot), false, `error leaked project root: ${serialized}`);
  if (response.isError === undefined) {
    const wrapped = z.object({ result: z.object({ results: z.array(z.object({ ok: z.literal(false), error: z.string() }).passthrough()) }) }).parse(response.structuredContent);
    return wrapped.result.results[0]?.error ?? "";
  }
  assert.equal(response.isError, true);
  const structured = errorSchema.safeParse(response.structuredContent);
  if (structured.success) return structured.data.error;
  return response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}
function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}


async function withClient(t: TestContext): Promise<Client> {
  const server = createHttpServer("/mcp");
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object" && "port" in address);
  const client = new Client({ name: "read-file-range-test", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function callRange(client: Client, arguments_: Record<string, unknown>): Promise<CallToolResult> {
  const { projectAlias, ...requested } = arguments_;
  const request = requested.startLine === undefined && requested.endLine === undefined
    ? { ...requested, startLine: 1, endLine: 200 }
    : requested;
  return client.callTool({ name: "project_read", arguments: { projectAlias, requests: [{ mode: "content", ...request }] } });
}
async function callFull(client: Client, relativePath: string): Promise<CallToolResult> {
  return client.callTool({ name: "project_read", arguments: { projectAlias: "range", requests: [{ mode: "content", relativePath }] } });
}


test("project_read range operation exposes and enforces its complete MCP contract", async (t) => {
  t.after(() => writePolicy());
  const client = await withClient(t);

  await t.test("discovery publishes the exact read-only annotations and caller schema", async () => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "project_read");
    assert(tool, "project_read was not discovered");
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["projectAlias", "requests"]);
    const requestProperties = (tool.inputSchema.properties?.requests as { items?: { properties?: Record<string, unknown> } } | undefined)?.items?.properties;
    assert.deepEqual(Object.keys(requestProperties ?? {}).sort(), ["endLine", "mode", "relativePath", "startLine"]);
    assert.equal(JSON.stringify(tool.inputSchema).includes("maxChars"), false);
    assert.equal(JSON.stringify(tool.inputSchema).includes("\"limit\""), false);
    assert.equal(listed.tools.some((candidate) => candidate.name === "project_read_file_range"), false);
  });

  upsertProject({ projectAlias: "range", rootPath: projectRoot });

  await t.test("reads explicit and default ranges with EOF lookahead semantics", async () => {
    const basic = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 3,
      endLine: 5
    }), rangeResultSchema);
    assert.deepEqual(basic, {
      projectAlias: "range",
      relativePath: "lines.txt",
      requested: { startLine: 3, endLine: 5 },
      actual: { startLine: 3, endLine: 5, lineCount: 3 },
      sha256: sha256(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"),
      content: "line 3\nline 4\nline 5",
      hasMore: true,
      truncated: false,
      chars: 20,
      totalChars: 20,
      omittedChars: 0,
      limit: 500000
    });
    assert.equal(JSON.stringify(basic).includes(root), false);
    assert.equal(JSON.stringify(basic).includes(projectRoot), false);

    const defaultRange = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt"
    }), rangeResultSchema);
    assert.deepEqual(defaultRange.requested, { startLine: 1, endLine: 200 });
    assert.deepEqual(defaultRange.actual, { startLine: 1, endLine: 10, lineCount: 10 });
    assert.equal(defaultRange.content, Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    assert.equal(defaultRange.hasMore, false);

    const customStartDefault = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 3
    }), rangeResultSchema);
    assert.deepEqual(customStartDefault.requested, { startLine: 3, endLine: 202 });
    assert.deepEqual(customStartDefault.actual, { startLine: 3, endLine: 10, lineCount: 8 });
    assert.equal(customStartDefault.content, Array.from({ length: 8 }, (_, index) => `line ${index + 3}`).join("\n"));

    const beyondEnd = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 9,
      endLine: 15
    }), rangeResultSchema);
    assert.deepEqual(beyondEnd.actual, { startLine: 9, endLine: 10, lineCount: 2 });
    assert.equal(beyondEnd.content, "line 9\nline 10");
    assert.equal(beyondEnd.hasMore, false);

    const beyondEof = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 20,
      endLine: 22
    }), rangeResultSchema);
    assert.deepEqual(beyondEof.actual, { startLine: null, endLine: null, lineCount: 0 });
    assert.equal(beyondEof.content, "");
    assert.equal(beyondEof.hasMore, false);
  });
  await t.test("returns the complete raw-file hash for full, bounded, and truncated reads", async () => {
    const rawContent = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const expectedSha256 = sha256(rawContent);
    const full = resultOf(await callFull(client, "lines.txt"), fullResultSchema);
    const bounded = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 4,
      endLine: 4
    }), rangeResultSchema);
    assert.equal(full.sha256, expectedSha256);
    assert.equal(bounded.sha256, expectedSha256);
    assert.equal(bounded.content, "line 4");

    writePolicy(8);
    const truncated = resultOf(await callFull(client, "lines.txt"), fullResultSchema);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.sha256, expectedSha256);
    writePolicy();
  });


  await t.test("normalizes CRLF input without phantom carriage returns", async () => {
    const crlf = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "crlf.txt",
      startLine: 1,
      endLine: 2
    }), rangeResultSchema);
    assert.equal(crlf.content, "alpha\nbeta");
    assert.deepEqual(crlf.actual, { startLine: 1, endLine: 2, lineCount: 2 });
    assert.equal(crlf.hasMore, true);
  });

  await t.test("rejects invalid and overwide windows", async () => {
    const reversed = errorOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 5,
      endLine: 4
    }));
    assert.match(reversed, /endLine must be greater than or equal to startLine/);

    const overwide = errorOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 1,
      endLine: 2001
    }));
    assert.match(overwide, /maximum of 2000 lines/);

    for (const invalid of [
      { startLine: 0, endLine: 1 },
      { startLine: 1, endLine: 0 },
      { startLine: 1.5, endLine: 2 }
    ]) {
      const message = errorOf(await callRange(client, {
        projectAlias: "range",
        relativePath: "lines.txt",
        ...invalid
      }));
      assert.match(message, /invalid|greater than 0|integer/i);
    }
  });

  await t.test("uses the server character limit and counts Unicode code points", async () => {
    writePolicy(8);
    const limited = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "lines.txt",
      startLine: 1,
      endLine: 2
    }), rangeResultSchema);
    assert.deepEqual({
      content: limited.content,
      truncated: limited.truncated,
      chars: limited.chars,
      totalChars: limited.totalChars,
      omittedChars: limited.omittedChars,
      limit: limited.limit
    }, {
      content: "line 1\nl",
      truncated: true,
      chars: 8,
      totalChars: 13,
      omittedChars: 5,
      limit: 8
    });
    assert.deepEqual(limited.actual, { startLine: 1, endLine: 2, lineCount: 2 });

    writePolicy(1);
    const unicode = resultOf(await callRange(client, {
      projectAlias: "range",
      relativePath: "unicode.txt",
      startLine: 1,
      endLine: 1
    }), rangeResultSchema);
    assert.equal(unicode.content, "🙂");
    assert.equal(unicode.content.length, 2, "fixture must distinguish UTF-16 units from code points");
    assert.equal(unicode.chars, 1);
    assert.equal(unicode.totalChars, 2);
    assert.equal(unicode.omittedChars, 1);
    assert.equal(unicode.truncated, true);
    assert.equal(unicode.limit, 1);
    writePolicy();
  });

  await t.test("reports the projectRead requirement without auditing reads", async () => {
    const policy = resultOf(await client.callTool({
      name: "project_policy",
      arguments: { checks: [{ type: "permissions", projectAlias: "range", operation: "project_read" }] }
    }), z.object({ results: z.array(z.object({ requiredPermissions: z.array(z.string()) }).passthrough()) }));
    assert.deepEqual(policy.results[0]?.requiredPermissions, ["projectRead"]);

    const audit = stateStore.readAudit();
    assert.equal(audit.some((event) => event.tool === "project_read"), false);
    assert.equal(audit.some((event) => event.tool === "project_read_file_range"), false);

  });

  await t.test("rejects directories, binary files, and unsafe paths without absolute-path leakage", async () => {
    const cases = [
      { relativePath: ".env", expected: /Blocked path pattern/ },
      { relativePath: "ignored.txt", expected: /readGitIgnoredFiles/ },
      { relativePath: "../outside.txt", expected: /escapes project root/i },
      { relativePath: "binary.bin", expected: /not likely text/i },
      { relativePath: "directory", expected: /not a file/i },
      { relativePath: path.join(root, "outside.txt"), expected: /Operation failed: \[invalid path\]/i }
    ];
    for (const fixture of cases) {
      const message = errorOf(await callRange(client, {
        projectAlias: "range",
        relativePath: fixture.relativePath,
        startLine: 1,
        endLine: 1
      }));
      assert.match(message, fixture.expected);
    }
  });
});
