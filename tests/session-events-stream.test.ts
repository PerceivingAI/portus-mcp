import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { get, ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Keep bounded socket-readiness waits real while application timers are advanced.
const waitForIO = delay;
function pollClock(t: TestContext) {
  // Control the application's one-second poll, not HTTP/socket timers.
  const realTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Map<NodeJS.Timeout, { at: number; run: () => void }>();
  let now = 0;
  const schedule = t.mock.method(globalThis, "setTimeout", function(this: typeof globalThis, callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) {
    if (milliseconds !== 1000) return Reflect.apply(realTimeout, this, [callback, milliseconds, ...args]);
    const handle = {} as NodeJS.Timeout;
    pending.set(handle, { at: now + milliseconds, run: () => Reflect.apply(callback, handle, args) });
    return handle;
  });
  const cancel = t.mock.method(globalThis, "clearTimeout", function(this: typeof globalThis, handle: Parameters<typeof clearTimeout>[0]) {
    if (typeof handle === "object" && handle !== null && pending.delete(handle)) return;
    Reflect.apply(realClearTimeout, this, [handle]);
  });
  const clock = {
    tick(milliseconds: number) {
      now += milliseconds;
      for (const [handle, timer] of pending) {
        if (timer.at > now) continue;
        pending.delete(handle);
        timer.run();
      }
    },
    reset() { pending.clear(); schedule.mock.restore(); cancel.mock.restore(); }
  };
  t.after(() => clock.reset());
  return clock;
}

const root = mkdtempSync(path.join(process.cwd(), ".session-events-stream-"));
const state = path.join(root, "state");
const project = path.join(root, "project");
const skills = path.join(root, "skills");
for (const dir of [state, project, skills]) mkdirSync(dir, { recursive: true });
const previousEnv = { ...process.env };
Object.assign(process.env, { DOTENV_CONFIG_PATH: path.join(root, "empty.env"), PORTUS_MCP_STATE_DIR: state, PORTUS_MCP_POLICY_PATH: path.join(root, "policy.json"), PORTUS_MCP_CONFIG_PATH: path.join(root, "config.json"), PORTUS_MCP_PROJECTS: `fixture=${project}`, AGENT_SKILL_PATHS: skills, SUBAGENTS_SKILL_PATHS: skills });
delete process.env.PORTUS_MCP_BEARER_TOKEN;
writeFileSync(path.join(root, "empty.env"), "");
writeFileSync(path.join(root, "config.json"), JSON.stringify({ subagents: { defaultTemplate: "ephemeral-project-subagent", retry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, retryOn: [], respectRetryAfter: false, maxRetryWindowSecs: 1 } }, traversal: { excludedPatterns: [".git", "node_modules"] } }));
const policy = JSON.parse(readFileSync(path.join(process.cwd(), "portus-mcp.policy.json"), "utf8"));
policy.limits.sessionEvents.maxEvents = 2;
writeFileSync(path.join(root, "policy.json"), JSON.stringify(policy));
// Isolated dotenv/state must be installed before importing the application.
const { createHttpServer } = await import("../src/server.js");

type Frame = { id?: number; event: string; data: any };
// Retain the declared Node 20.9 minimum; Promise.withResolvers needs Node 22.
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until<T>(probe: () => T, ready: (value: T) => boolean, label: string, milliseconds = 5000): Promise<T> {
  const end = Date.now() + milliseconds;
  do { const value = probe(); if (ready(value)) return value; await waitForIO(10); } while (Date.now() < end);
  throw new Error(`Deadline waiting for ${label}`);
}
function seed(count: number) {
  const sessionId = "stream";
  const eventsPath = path.join(root, "events.jsonl");
  writeFileSync(eventsPath, Array.from({ length: count }, (_, index) => JSON.stringify({ sequence: index + 1, timestamp: new Date(0).toISOString(), sessionId, projectAlias: "fixture", type: "output", message: `event-${index + 1}`, data: { value: index + 1 } })).join("\n") + (count ? "\n" : ""));
  writeFileSync(path.join(state, "sessions.json"), JSON.stringify({ sessions: [{ sessionId, projectAlias: "fixture", agentTemplate: "synthetic", task: "fixture", status: "completed", startedAt: new Date(0).toISOString(), stdoutPath: path.join(root, "out"), stderrPath: path.join(root, "err"), resultPath: path.join(root, "result"), metadataPath: path.join(root, "metadata.json"), eventsPath }] }));
}
async function backend(t: TestContext, token?: string) {
  if (token) process.env.PORTUS_MCP_BEARER_TOKEN = token; else delete process.env.PORTUS_MCP_BEARER_TOKEN;
  const server = createHttpServer("/mcp");
  let response: ServerResponse | undefined;
  server.on("request", (req, res) => { if (req.url?.startsWith("/mcp/events")) response = res; });
  const listening = pending<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  t.after(async () => {
    server.closeAllConnections();
    const closed = pending<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  });
  const address = server.address(); assert(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/mcp`, response: () => response };
}
function connect(url: string, suffix = "/events?sessionId=stream", headers: Record<string, string> = {}) {
  const ready = pending<IncomingMessage>();
  const closed = pending<void>();
  const frames: Frame[] = [];
  let text = "";
  let bytes = 0;
  let response: IncomingMessage | undefined;
  let error: Error | undefined;
  const req = get(url + suffix, { agent: false, headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-03-26", ...headers } }, res => {
    response = res;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { req.destroy(new Error("Stream output cap")); return; }
      text += chunk;
      let boundary;
      while ((boundary = text.indexOf("\n\n")) !== -1) {
        const frame = text.slice(0, boundary); text = text.slice(boundary + 2);
        const lines = frame.split("\n");
        const id = lines.find(line => line.startsWith("id: "));
        const event = lines.find(line => line.startsWith("event: "))?.slice(7) ?? "message";
        const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        try { frames.push({ ...(id ? { id: Number(id.slice(4)) } : {}), event, data: JSON.parse(data) }); }
        catch (failure) { error = failure as Error; req.destroy(error); }
      }
    });
    res.on("error", failure => { error = failure; });
    res.once("close", closed.resolve);
    ready.resolve(res);
  });
  req.once("error", failure => { error = failure; ready.reject(failure); });
  req.once("close", closed.resolve);
  req.setTimeout(3000, () => { if (!response) req.destroy(new Error("Header deadline")); });
  ready.promise.catch(() => {});
  return { ready: ready.promise, closed: closed.promise, frames, stop() { req.destroy(); response?.destroy(); }, error: () => error };
}
function pressure(t: TestContext, blockAt: number) {
  let response: ServerResponse | undefined;
  let writes = 0;
  let held = false;
  let blocked = false;
  const original = ServerResponse.prototype.write;
  t.mock.method(ServerResponse.prototype, "write", function(this: ServerResponse, ...args: unknown[]) {
    const accepted = Reflect.apply(original, this, args);
    if (this.req.url?.startsWith("/mcp/events")) {
      response = this;
      writes++;
      if (writes === blockAt) { held = true; blocked = true; return false; }
    }
    return accepted;
  });
  return { response: () => response, writes: () => writes, held: () => held, resume() { assert(response && blocked); blocked = false; response.emit("drain"); } };
}
async function frames(connection: ReturnType<typeof connect>, count: number, clock?: ReturnType<typeof pollClock>) {
  try {
    await until(() => {
      // Socket callbacks can schedule the next poll after an earlier clock tick.
      // Advance pending application time while still yielding to real I/O.
      clock?.tick(1000);
      return connection.frames.length;
    }, length => length >= count, `${count} complete SSE frames`);
  } catch (error) {
    throw new Error(`${(error as Error).message}; received ${JSON.stringify(connection.frames)}`);
  }
  return connection.frames;
}
async function post(url: string) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { tools: { name: string }[] } };
  assert(body.result.tools.some(tool => tool.name === "project_context"));
}
test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("empty application streams expose headers without emitting synthetic data", { timeout: 10000 }, async t => {
  seed(0);
  const clock = pollClock(t);
  const { url } = await backend(t);
  const connection = connect(url); t.after(() => connection.stop());
  assert.equal((await connection.ready).statusCode, 200);
  clock.tick(1000);
  await waitForIO(10);
  assert.deepEqual(connection.frames, []);
});

for (const blockAt of [1, 2]) {
  test(`backpressure at page frame ${blockAt} pauses delivery and resumes without gaps or duplicates`, { timeout: 15000 }, async t => {
    seed(5);
    const clock = pollClock(t);
    const control = pressure(t, blockAt);
    const { url } = await backend(t);
    const connection = connect(url); t.after(() => connection.stop());
    await connection.ready;
    await frames(connection, blockAt);
    assert(control.held());
    clock.tick(1200);
    await waitForIO(10);
    assert.deepEqual(connection.frames.map(frame => frame.id), Array.from({ length: blockAt }, (_, index) => index + 1));
    assert.equal(control.writes(), blockAt);
    assert.equal(control.response()!.listenerCount("drain"), 1);
    // This resumes outside the request's policy scope, as a socket drain can.
    control.resume();
    await frames(connection, 5, clock);
    assert.deepEqual(connection.frames.map(frame => frame.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(connection.frames.map(frame => frame.data.data.value), [1, 2, 3, 4, 5]);
    connection.stop(); await connection.closed;
    await until(() => control.response()!.listenerCount("drain"), count => count === 0, "drain listener cleanup");
  });
}

test("reconnect resumes from Last-Event-ID and an explicit query cursor takes precedence", { timeout: 15000 }, async t => {
  seed(5);
  const clock = pollClock(t);
  const { url } = await backend(t);
  const byHeader = connect(url, "/events?sessionId=stream", { "last-event-id": "2" }); t.after(() => byHeader.stop());
  await byHeader.ready; await frames(byHeader, 3, clock);
  assert.deepEqual(byHeader.frames.map(frame => frame.id), [3, 4, 5]);
  byHeader.stop(); await byHeader.closed;
  const byQuery = connect(url, "/events?sessionId=stream&afterSequence=3", { "last-event-id": "1" }); t.after(() => byQuery.stop());
  await byQuery.ready; await frames(byQuery, 2);
  assert.deepEqual(byQuery.frames.map(frame => frame.id), [4, 5]);
});

for (const phase of ["idle", "flowing", "blocked", "error"] as const) {
  test(`closing an ${phase} stream releases delivery waits and stops further output`, { timeout: 10000 }, async t => {
    seed(phase === "idle" ? 0 : 4);
    const clock = pollClock(t);
    const control = pressure(t, phase === "blocked" || phase === "error" ? 1 : 999);
    const owner = await backend(t);
    const connection = connect(owner.url); t.after(() => connection.stop());
    await connection.ready;
    if (phase !== "idle") await frames(connection, phase === "flowing" ? 2 : 1);
    const response = control.response() ?? owner.response(); assert(response);
    const serverClosed = pending<void>();
    response.once("close", serverClosed.resolve);
    if (phase === "error") response.emit("error", new Error("Injected application stream error"));
    else connection.stop();
    await connection.closed;
    await serverClosed.promise;
    await until(() => response.listenerCount("drain"), count => count === 0, "owned drain listener release");
    assert.equal(response.listenerCount("error"), 0);
    const before = control.writes();
    clock.tick(1100);
    await waitForIO(10);
    assert.equal(control.writes(), before);
    clock.reset();
    await post(owner.url);
  });
}

test("unknown-session error frames retain HTTP 200 and obey backpressure", { timeout: 10000 }, async t => {
  seed(0);
  const clock = pollClock(t);
  const control = pressure(t, 1);
  const { url } = await backend(t);
  const connection = connect(url, "/events?sessionId=missing"); t.after(() => connection.stop());
  assert.equal((await connection.ready).statusCode, 200);
  await frames(connection, 1);
  assert.equal(connection.frames[0]!.event, "error");
  clock.tick(1200);
  await waitForIO(10);
  assert.equal(control.writes(), 1);
  control.resume();
  await frames(connection, 2);
  assert(connection.frames.every(frame => frame.event === "error" && frame.id === undefined));
});

test("a background stream write failure closes only that stream", { timeout: 10000 }, async t => {
  seed(0);
  const original = ServerResponse.prototype.write;
  t.mock.method(ServerResponse.prototype, "write", function(this: ServerResponse, ...args: unknown[]) {
    if (this.req.url?.startsWith("/mcp/events")) throw new Error("Injected event write failure");
    return Reflect.apply(original, this, args);
  });
  const owner = await backend(t);
  const connection = connect(owner.url); t.after(() => connection.stop());
  await connection.ready;
  seed(1);
  await connection.closed;
  assert.equal(owner.response()!.listenerCount("drain"), 0);
  await post(owner.url);
});

test("application streams preserve optional bearer auth and leave SDK GET and POST usable", { timeout: 10000 }, async t => {
  seed(0);
  const secured = await backend(t, "fixture-token");
  assert.equal((await fetch(secured.url + "/events?sessionId=stream", { signal: AbortSignal.timeout(3000) })).status, 401);
  assert.equal((await fetch(secured.url + "/events?sessionId=stream", { headers: { authorization: "Bearer wrong" }, signal: AbortSignal.timeout(3000) })).status, 401);
  const accepted = connect(secured.url, "/events?sessionId=stream", { authorization: "Bearer fixture-token" }); t.after(() => accepted.stop());
  assert.equal((await accepted.ready).statusCode, 200);
  const open = await backend(t);
  assert.equal((await fetch(open.url + "/events", { signal: AbortSignal.timeout(3000) })).status, 400);
  const application = connect(open.url); t.after(() => application.stop());
  assert.equal((await application.ready).statusCode, 200);
  const sdk = connect(open.url, ""); t.after(() => sdk.stop());
  assert.equal((await sdk.ready).statusCode, 200);
  await post(open.url);
  assert.deepEqual(sdk.frames, []);
});
