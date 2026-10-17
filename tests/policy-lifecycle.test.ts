import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const root = mkdtempSync(path.join(process.cwd(), ".policy-lifecycle-"));
const policyPath = path.join(root, "policy.json");
const project = path.join(root, "project");
const skills = path.join(root, "skills");
const state = path.join(root, "state");
for (const dir of [project, skills, state]) mkdirSync(dir, { recursive: true });
const originalEnv = { ...process.env };
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: path.join(root, "empty.env"),
  PORTUS_MCP_POLICY_PATH: policyPath,
  PORTUS_MCP_CONFIG_PATH: path.join(root, "config.json"),
  PORTUS_MCP_STATE_DIR: state,
  PORTUS_MCP_PROJECTS: `fixture=${project}`,
  AGENT_SKILL_PATHS: skills,
  SUBAGENTS_SKILL_PATHS: skills
});
delete process.env.PORTUS_MCP_BEARER_TOKEN;
writeFileSync(path.join(root, "empty.env"), "");
writeFileSync(path.join(root, "config.json"), JSON.stringify({ subagents: { defaultTemplate: "ephemeral-project-subagent", retry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, retryOn: [], respectRetryAfter: false, maxRetryWindowSecs: 1 } }, traversal: { excludedPatterns: [".git", "node_modules"] } }));
writeFileSync(path.join(project, "note.txt"), "abcdefghijk");
writeFileSync(path.join(project, "work.cjs"), "process.stdout.write('snapshot-command-ok');\n");
const shipped = JSON.parse(readFileSync(path.join(process.cwd(), "portus-mcp.policy.json"), "utf8"));
// Application imports follow isolated setup because env.ts loads dotenv on import.
const { createHttpServer } = await import("../src/server.js");
const { createPolicySnapshot, getPolicyConfig, runWithPolicyConfig } = await import("../src/policy/policyConfig.js");
const { upsertSession } = await import("../src/state/SessionRegistry.js");
const { appendSessionEvent, readSessionEvents } = await import("../src/state/SessionEvents.js");
const { stateStore } = await import("../src/state/StateStore.js");
const { loadSkillRegistry } = await import("../src/skills/SkillRegistry.js");

test.beforeEach(() => writeFileSync(policyPath, JSON.stringify(shipped)));
test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function listen(t: { after: (fn: () => Promise<void>) => void }, provider?: () => typeof shipped) {
  const server = createHttpServer("/mcp", provider);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => close(server));
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}
async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function rpc(url: string, method: string, params?: unknown, id = 1) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}
async function tool(url: string, name: string, args: unknown, id = 1) {
  const response = await rpc(url, "tools/call", { name, arguments: args }, id);
  assert.equal(response.status, 200);
  assert.equal(response.body.error, undefined);
  return response.body.result;
}
const readArgs = { projectAlias: "fixture", requests: [{ relativePath: "note.txt", mode: "content" }] };

test("invalid startup policy refuses backend construction", () => {
  rmSync(policyPath);
  assert.throws(() => createHttpServer("/mcp"), /Missing policy file/);
  writeFileSync(policyPath, "{broken");
  assert.throws(() => createHttpServer("/mcp"), /Invalid policy JSON/);
  writeFileSync(policyPath, "{}");
  assert.throws(() => createHttpServer("/mcp"), /Invalid policy file/);
});

test("running requests and newly started commands retain policy after file edits and corruption", async (t) => {
  const initial = structuredClone(shipped);
  initial.main_agent.permissions.allowedCommands = ["node"];
  initial.limits.fileRead.maxChars = 7;
  writeFileSync(policyPath, JSON.stringify(initial));
  const { url } = await listen(t);
  const init = await rpc(url, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "policy-lifetime", version: "1" } });
  assert.equal(init.body.result.serverInfo.name, "portus-mcp");
  const changed = structuredClone(initial);
  changed.main_agent.permissions.projectRead = false;
  changed.main_agent.permissions.allowedCommands = [];
  changed.pathPolicy.blockedPatterns.push("note.txt");
  changed.limits.fileRead.maxChars = 2;
  for (const contents of [JSON.stringify(changed), "{broken"]) {
    writeFileSync(policyPath, contents);
    const read = await tool(url, "project_read", readArgs);
    assert.equal(read.structuredContent.result.results[0].content, "abcdefg");
    assert.equal(read.structuredContent.result.results[0].truncated, true);
    const policy = await tool(url, "project_policy", { checks: [{ type: "permissions", operation: "project_read" }, { type: "path", projectAlias: "fixture", relativePath: "note.txt", operation: "read" }] });
    assert.equal(policy.structuredContent.result.results[0].allowed, true);
    assert.equal(policy.structuredContent.result.results[1].allowed, true);
    const run = await tool(url, "project_run", { projectAlias: "fixture", requests: [{ type: "command", command: "node", args: ["work.cjs"], timeoutSecs: 2, confirm: true }] });
    assert.equal(run.structuredContent.result.results[0].stdout, "snapshot-command-ok");
    assert.equal(run.structuredContent.result.results[0].exitCode, 0);
  }
});

test("explicit new backend adopts changed policy while an existing backend remains isolated", async (t) => {
  const supplied = structuredClone(shipped);
  supplied.limits.fileRead.maxChars = 8;
  const a = await listen(t, () => supplied);
  supplied.limits.fileRead.maxChars = 3;
  const b = await listen(t, () => supplied);
  supplied.limits.fileRead.maxChars = 1;
  const responses = await Promise.all([tool(a.url, "project_read", readArgs, 17), tool(b.url, "project_read", readArgs, 17)]);
  assert.equal(responses[0].structuredContent.result.results[0].content, "abcdefgh");
  assert.equal(responses[1].structuredContent.result.results[0].content, "abc");
  await close(a.server);
  writeFileSync(policyPath, JSON.stringify(supplied));
  const restarted = await listen(t);
  const response = await tool(restarted.url, "project_read", readArgs);
  assert.equal(response.structuredContent.result.results[0].content, "a");
  await close(restarted.server);
  writeFileSync(policyPath, "{broken");
  assert.throws(() => createHttpServer("/mcp"), /Invalid policy JSON/);
});

test("async policy scopes are detached immutable and unavailable outside their owner", async () => {
  const a = structuredClone(shipped);
  const b = structuredClone(shipped);
  a.limits.fileRead.maxChars = 11;
  b.limits.fileRead.maxChars = 22;
  const first = createPolicySnapshot(a);
  const second = createPolicySnapshot(b);
  a.limits.fileRead.maxChars = 99;
  assert.throws(() => { first.pathPolicy.blockedPatterns.push("new-rule"); }, TypeError);
  assert.throws(() => getPolicyConfig(), /not initialized/);
  const observed = await Promise.all([first, second].map((policy, index) => runWithPolicyConfig(policy, async () => {
    await new Promise((resolve) => setTimeout(resolve, index ? 1 : 10));
    return getPolicyConfig().limits.fileRead.maxChars;
  })));
  assert.deepEqual(observed, [11, 22]);
  assert.throws(() => getPolicyConfig(), /not initialized/);
});

test("event audit and skill helpers use active policy despite corrupted disk policy", () => {
  const value = structuredClone(shipped);
  value.limits.sessionEvents.maxEvents = 1;
  value.limits.sessionEvents.maxChunkChars = 4;
  value.audit.strictMode = false;
  const policy = createPolicySnapshot(value);
  runWithPolicyConfig(policy, () => {
    const dir = path.join(root, "session");
    mkdirSync(dir, { recursive: true });
    const record = { sessionId: "policy-events", projectAlias: "fixture", agentTemplate: "fixture", task: "fixture", status: "completed" as const, startedAt: new Date(0).toISOString(), stdoutPath: path.join(dir, "out"), stderrPath: path.join(dir, "err"), resultPath: path.join(dir, "result"), metadataPath: path.join(dir, "metadata.json"), eventsPath: path.join(dir, "events.jsonl") };
    writeFileSync(record.eventsPath, "");
    upsertSession(record);
    writeFileSync(policyPath, "{broken");
    appendSessionEvent(record, "output", "first", { text: "abcdefgh" });
    appendSessionEvent(record, "output", "second", { text: "ijklmnop" });
    const page = readSessionEvents({ sessionId: record.sessionId });
    assert.equal(page.events[0]!.data.text, "abcd");
    assert.equal(page.nextSequence, 1);
    assert.equal(page.hasMore, true);
    const next = readSessionEvents({ sessionId: record.sessionId, afterSequence: page.nextSequence });
    assert.equal(next.events[0]!.data.text, "ijkl");
    assert.equal(next.hasMore, false);
    stateStore.requireAuditWritable();
    assert.deepEqual(loadSkillRegistry().connected.catalog, []);
  });
});

for (const stage of ["registration", "transport-start"] as const) {
  test(`failed ${stage} is contained and subsequent requests remain usable`, async (t) => {
    const { url } = await listen(t);
    let fail = true;
    if (stage === "registration") {
      const original = McpServer.prototype.registerTool;
      t.mock.method(McpServer.prototype, "registerTool", function(this: McpServer, ...args: unknown[]) {
        if (fail) { fail = false; throw new Error("Injected request registration failure"); }
        return Reflect.apply(original, this, args);
      });
    } else {
      const original = StreamableHTTPServerTransport.prototype.start;
      t.mock.method(StreamableHTTPServerTransport.prototype, "start", async function(this: InstanceType<typeof StreamableHTTPServerTransport>) {
        if (fail) { fail = false; throw new Error("Injected request transport failure"); }
        return original.call(this);
      });
    }
    const failed = await rpc(url, "tools/list");
    assert.equal(failed.status, 500);
    const healthy = await tool(url, "project_read", readArgs);
    assert.equal(healthy.structuredContent.result.results[0].content, "abcdefghijk");
  });
}
