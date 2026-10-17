import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { ClientRequest, Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(path.join(process.cwd(), ".operation-lifetime-"));
const project = path.join(root, "project");
const markers = path.join(project, "markers");
const state = path.join(root, "state");
const skills = path.join(root, "skills");
for (const dir of [markers, state, skills]) mkdirSync(dir, { recursive: true });
const previousEnv = { ...process.env };
const policy = JSON.parse(readFileSync(path.join(process.cwd(), "portus-mcp.policy.json"), "utf8"));
policy.main_agent.permissions.allowedCommands = ["node"];
policy.subagents.lifecycle.maxRuntimeSecs = 10;
writeFileSync(path.join(root, "policy.json"), JSON.stringify(policy));
writeFileSync(path.join(root, "empty.env"), "");
writeFileSync(path.join(root, "config.json"), JSON.stringify({ subagents: { defaultTemplate: "ephemeral-project-subagent", retry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, retryOn: [], respectRetryAfter: false, maxRetryWindowSecs: 1 } }, traversal: { excludedPatterns: [".git", "node_modules"] } }));
const workload = `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const label = process.argv[2], mode = process.argv[3], directory = path.join(process.cwd(), 'markers');
const child = mode === 'tree' ? cp.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(94), 12000); setInterval(() => {}, 1000)'], {stdio:'ignore'}) : null;
fs.appendFileSync(path.join(directory, label + '.starts'), String(process.pid) + '\\n');
fs.writeFileSync(path.join(directory, label + '.json'), JSON.stringify({pid:process.pid,descendant:child?.pid}));
console.log('started:' + label);
const timer = setInterval(() => { if(mode === 'gate' && fs.existsSync(path.join(directory, label + '.release'))) { clearInterval(timer); clearTimeout(watchdog); fs.writeFileSync(path.join(directory, label + '.done'), label); console.log('done:' + label); } }, 10);
const watchdog = setTimeout(() => process.exit(93), 9000);
`;
writeFileSync(path.join(project, "work.cjs"), workload);
writeFileSync(path.join(root, "fake-flue.mjs"), `
import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const index = process.argv.indexOf('--payload'), payload = JSON.parse(process.argv[index + 1]);
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(94), 12000); setInterval(() => {}, 1000)'], {stdio:'ignore'});
fs.writeFileSync(path.join(payload.projectRoot,'markers','subagent.json'),JSON.stringify({pid:process.pid,descendant:child.pid}));
console.log('subagent-started'); setTimeout(() => process.exit(93),9000); setInterval(() => {},1000);
`);
Object.assign(process.env, { DOTENV_CONFIG_PATH: path.join(root, "empty.env"), PORTUS_MCP_POLICY_PATH: path.join(root, "policy.json"), PORTUS_MCP_CONFIG_PATH: path.join(root, "config.json"), PORTUS_MCP_STATE_DIR: state, PORTUS_MCP_PROJECTS: `fixture=${project}`, AGENT_SKILL_PATHS: skills, SUBAGENTS_SKILL_PATHS: skills, PORTUS_MCP_FLUE_CLI_PATH: path.join(root, "fake-flue.mjs"), PORTUS_MCP_DEFAULT_PROVIDER: "cerebras", PORTUS_MCP_CEREBRAS_MODEL: "fixture-model", CEREBRAS_API_KEY: "synthetic-unused-key" });
delete process.env.PORTUS_MCP_BEARER_TOKEN;
// Application loading must follow isolated env setup: env.ts reads dotenv at import.
const { createHttpServer } = await import("../src/server.js");

type ProcessMarker = { pid: number; descendant?: number };
type Reply = { status: number; body: any };
// Executor promises retain the package's declared Node 20.9 minimum (withResolvers needs Node 22).
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function until<T>(probe: () => T | Promise<T>, ready: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  do { const value = await probe(); if (ready(value)) return value; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Deadline waiting for ${label}`);
}
async function marker(label: string): Promise<ProcessMarker> {
  const file = path.join(markers, label + ".json");
  const started = await until(() => {
    try { return JSON.parse(readFileSync(file, "utf8")) as ProcessMarker; }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }, value => value !== undefined, label + " startup", 5000);
  assert(started);
  return started;
}
function startPost(url: string, method: string, params: unknown, id: number | null = 1) {
  const result = pending<Reply>();
  const closed = pending<void>();
  let socketSeen = false;
  const req = request(url, { method: "POST", agent: false, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", connection: "close" } }, response => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error("Response cap")); });
    response.on("error", result.reject);
    response.on("end", () => { try { result.resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : null }); } catch (error) { result.reject(error as Error); } });
  });
  req.once("socket", socket => { socketSeen = true; socket.once("close", () => closed.resolve()); });
  req.once("error", result.reject);
  req.once("close", () => { if (!socketSeen) closed.resolve(); });
  req.setTimeout(10000, () => req.destroy(new Error("HTTP deadline")));
  req.end(JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }));
  result.promise.catch(() => {});
  return { req, response: result.promise, closed: closed.promise };
}
async function tool(url: string, args: unknown, name = "project_run") {
  const call = startPost(url, "tools/call", { name, arguments: args });
  const response = await call.response;
  await call.closed;
  assert.equal(response.status, 200);
  assert.equal(response.body.error, undefined);
  assert.equal(response.body.result.isError, undefined);
  return response.body.result.structuredContent.result;
}
const runArgs = (label: string, mode = "gate", timeoutSecs = 5) => ({ projectAlias: "fixture", requests: [{ type: "command", command: "node", args: ["work.cjs", label, mode], timeoutSecs, confirm: true }] });
const sessionArgs = (action: Record<string, unknown>) => ({ projectAlias: "fixture", sessionAction: action });
function audit(label: string) {
  const file = path.join(state, "audit.log");
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)).find(row => row.tool === "project_run" && row.type === "command" && row.args?.includes(label));
}
async function absent(value: ProcessMarker) {
  for (const pid of [value.pid, value.descendant].filter((pid): pid is number => pid !== undefined)) await until(() => alive(pid), value => !value, `PID ${pid} absence`);
}
async function stopServer(server: Server) {
  server.closeAllConnections();
  const end = pending<void>();
  server.close(error => error ? end.reject(error) : end.resolve());
  await end.promise;
}
const callers = new Set<ClientRequest>();
async function backend(t: { after: (fn: () => Promise<void>) => void }) {
  const server = createHttpServer("/mcp");
  const listening = pending<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address(); assert(address && typeof address === "object");
  t.after(async () => {
    for (const caller of callers) caller.destroy();
    callers.clear();
    for (const file of readdirSync(markers).filter(name => name.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(path.join(markers, file), "utf8")) as ProcessMarker;
      if (!alive(record.pid) && (!record.descendant || !alive(record.descendant))) continue;
      // Failure-only cleanup is restricted to private fixture PIDs.
      for (const pid of [record.descendant, record.pid]) if (pid && alive(pid)) {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
        else process.kill(pid, "SIGKILL");
      }
    }
    await delay(100);
    await stopServer(server);
  });
  return `http://127.0.0.1:${address.port}/mcp`;
}
function oneShot(url: string, label: string, mode = "gate", timeout = 5, id = 1) {
  const call = startPost(url, "tools/call", { name: "project_run", arguments: runArgs(label, mode, timeout) }, id);
  callers.add(call.req);
  return call;
}
test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("disconnected one-shot work completes exactly once without replacement", { timeout: 40000 }, async t => {
  const url = await backend(t);
  const call = oneShot(url, "disconnected");
  const started = await marker("disconnected");
  call.req.destroy(new Error("Deliberate caller disconnect"));
  await assert.rejects(call.response, /Deliberate caller disconnect/);
  await call.closed;
  assert(alive(started.pid));
  writeFileSync(path.join(markers, "disconnected.release"), "release");
  const finished = await until(() => audit("disconnected"), row => row?.outcome === "exited", "one-shot audited completion");
  assert.equal(finished.exitCode, 0);
  assert.equal(readFileSync(path.join(markers, "disconnected.done"), "utf8"), "disconnected");
  assert.deepEqual(readFileSync(path.join(markers, "disconnected.starts"), "utf8").trim().split("\n"), [String(started.pid)]);
  await absent(started);
});

test("one-shot deadline still reaps its process tree after caller disconnect", { timeout: 40000 }, async t => {
  const url = await backend(t);
  const call = oneShot(url, "deadline", "tree", 2);
  const started = await marker("deadline");
  assert(started.descendant && alive(started.descendant));
  call.req.destroy(new Error("Deliberate caller disconnect"));
  await assert.rejects(call.response, /Deliberate caller disconnect/);
  await call.closed;
  const finished = await until(() => audit("deadline"), row => row?.outcome === "timed_out", "deadline after disconnect");
  assert.equal(finished.exitCode, null);
  await absent(started);
});

test("persistent execution survives start connection close and explicit stop reaps its tree", { timeout: 40000 }, async t => {
  const url = await backend(t);
  const result = await tool(url, sessionArgs({ type: "start", command: "node", args: ["work.cjs", "persistent", "tree"], timeoutSecs: 8, confirm: true }));
  const sessionId = result.session.sessionId;
  const started = await marker("persistent");
  const polled = await tool(url, sessionArgs({ type: "poll", sessionId }));
  assert.equal(polled.status, "running");
  assert(alive(started.pid)); assert(started.descendant && alive(started.descendant));
  const stopped = await tool(url, sessionArgs({ type: "terminate", sessionId }));
  assert.equal(stopped.session.status, "stopped");
  assert.equal(stopped.session.lifecycle.terminationOutcome, "terminated");
  assert.equal(stopped.session.lifecycle.descendantsRemaining, 0);
  await absent(started);
  assert.equal((await tool(url, sessionArgs({ type: "poll", sessionId }))).status, "stopped");
});

test("persistent execution deadline remains effective after start connection close", { timeout: 40000 }, async t => {
  const url = await backend(t);
  const result = await tool(url, sessionArgs({ type: "start", command: "node", args: ["work.cjs", "session-timeout", "tree"], timeoutSecs: 2, confirm: true }));
  const started = await marker("session-timeout");
  const final = await until(() => tool(url, sessionArgs({ type: "poll", sessionId: result.session.sessionId })), row => row.status === "timed_out", "session deadline");
  assert.equal(final.lifecycle.terminationOutcome, "terminated");
  assert.equal(final.lifecycle.reaped, true);
  await absent(started);
});

test("separate cancellation with colliding IDs does not cross-cancel or mix one-shot results", { timeout: 40000 }, async t => {
  const url = await backend(t);
  const a = oneShot(url, "client-a", "gate", 5, 41);
  const b = oneShot(url, "client-b", "gate", 5, 41);
  const [first, second] = await Promise.all([marker("client-a"), marker("client-b")]);
  const notification = startPost(url, "notifications/cancelled", { requestId: 41, reason: "Other client's request ID" }, null);
  assert.equal((await notification.response).status, 202); await notification.closed;
  assert(alive(first.pid)); assert(alive(second.pid));
  writeFileSync(path.join(markers, "client-a.release"), "release");
  const firstResult = await a.response; await a.closed;
  assert.equal(firstResult.body.result.structuredContent.result.results[0].stdout, "started:client-a\ndone:client-a\n");
  assert(alive(second.pid));
  writeFileSync(path.join(markers, "client-b.release"), "release");
  const secondResult = await b.response; await b.closed;
  assert.equal(secondResult.body.result.structuredContent.result.results[0].stdout, "started:client-b\ndone:client-b\n");
  await absent(first); await absent(second);
});

test("subagent survives start connection close and explicit stop reaps its fixture tree", { timeout: 40000 }, async t => {
  const url = await backend(t);
  const result = await tool(url, { actions: [{ type: "start", projectAlias: "fixture", task: "bounded local fixture", timeoutSecs: 8 }] }, "subagent_task");
  assert.equal(result.successCount, 1, JSON.stringify(result));
  const sessionId = result.results[0].session.sessionId;
  const started = await marker("subagent");
  assert(alive(started.pid)); assert(started.descendant && alive(started.descendant));
  const status = await tool(url, { requests: [{ type: "status", sessionId }] }, "subagent_context");
  assert.equal(status.results[0].session.status, "running");
  const stopped = await tool(url, { actions: [{ type: "stop", sessionId }] }, "subagent_task");
  assert.equal(stopped.results[0].session.status, "stopped");
  await absent(started);
});
