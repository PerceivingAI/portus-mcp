import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { createLauncher, startProcess } from "../scripts/start-all.mjs";

const root = process.cwd();
const hostname = "recovery-fixture.example.ts.net";
const mcpPath = "/recovery/mcp";
type Mode = "serve" | "funnel";
type Config = {
  TCP?: Record<string, { HTTPS: boolean }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, Config>;
};
type ManagedOptions = NonNullable<Parameters<typeof startProcess>[4]>;
type Launcher = ReturnType<typeof createLauncher>;
type Plan = "ready" | "exit-before-ready" | "no-route" | "spawn-error";
const listeningSchema = z.object({ type: z.literal("portus-mcp:listening"), pid: z.number().int().positive(), host: z.literal("127.0.0.1"), port: z.number().int().positive(), mcpPath: z.literal(mcpPath) });
const childMessageSchema = z.object({ type: z.enum(["proxy-ready", "proxy-started"]), pid: z.number().int().positive(), port: z.number().int().positive() });
const watchSchema = z.object({ session: z.string(), mode: z.enum(["serve", "funnel"]), port: z.number().int().positive() });
const initializeSchema = z.object({ result: z.object({ protocolVersion: z.literal("2025-06-18"), serverInfo: z.object({ name: z.literal("portus-mcp") }) }) });
const toolsSchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) });
const aliasesSchema = z.object({ result: z.object({ isError: z.boolean().optional(), structuredContent: z.object({ result: z.object({ sections: z.object({ projects: z.object({ ok: z.literal(true), value: z.object({ projectAliases: z.array(z.string()) }) }) }) }) }) }) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function listen(server: Server | NetServer, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}
async function reservePort() {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function closeHttp(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await bounded(closed, 5000, "independent child cleanup");
}
function route(port: number, mode: Mode = "serve", listener = 443): Config {
  return {
    TCP: { [listener]: { HTTPS: true } },
    Web: { [`${hostname}:${listener}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
    ...(mode === "funnel" ? { AllowFunnel: { [`${hostname}:${listener}`]: true } } : {})
  };
}

async function fixture(t: TestContext, token = "") {
  const temp = mkdtempSync(path.join(root, ".portus-recovery-"));
  const project = path.join(temp, "project");
  mkdirSync(project);
  mkdirSync(path.join(temp, "skills"));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  Object.assign(env, {
    DOTENV_CONFIG_PATH: path.join(temp, "absent.env"), PORTUS_MCP_HOST: "127.0.0.1", PORTUS_MCP_PATH: mcpPath,
    PORTUS_MCP_CONFIG_PATH: path.join(root, "portus-mcp.config.json"), PORTUS_MCP_POLICY_PATH: path.join(root, "portus-mcp.policy.json"),
    PORTUS_MCP_STATE_DIR: path.join(temp, "state"), PORTUS_MCP_PROJECTS: `before=${project}`,
    AGENT_SKILL_PATHS: path.join(temp, "skills"), SUBAGENTS_SKILL_PATHS: path.join(temp, "skills")
  });
  if (token) env.PORTUS_MCP_BEARER_TOKEN = token;
  const children = new Set<ChildProcess>();
  const sockets = new Set<Socket>();
  const launchers: Launcher[] = [];
  const acknowledgedStopFailures = new Set<Launcher>();
  const events = new EventEmitter();
  const sessions: Array<{
    id: string; child: ChildProcess; spawnedAt: number; exitedAt?: number;
    port?: number; started: ReturnType<typeof deferred<void>>; ready: ReturnType<typeof deferred<void>>;
  }> = [];
  const backendPort = await reservePort();
  let backend: ChildProcess | undefined;
  let protocolRequests = 0;
  let daemonRunning = true;
  let watchServer: NetServer | undefined;
  const unrelated = createHttpServer((_request, response) => response.end("borrowed-listener"));
  const gateway = createHttpServer((request, response) => {
    if (request.method === "POST") protocolRequests++;
    const upstream = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: request.url, method: request.method, headers: request.headers }, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.setTimeout(1500, () => upstream.destroy(new Error("backend request deadline")));
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("backend unavailable"); });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  t.after(async () => {
    let failure: unknown;
    for (const launcher of launchers.reverse()) {
      if (acknowledgedStopFailures.has(launcher)) continue;
      try { await bounded(launcher.stop(), 7000, "launcher cleanup"); } catch (error) { failure ??= error; }
    }
    for (const child of children) {
      try { await stopChild(child); } catch (error) { failure ??= error; }
    }
    for (const socket of sockets) socket.destroy();
    if (watchServer) await new Promise<void>(resolve => watchServer!.close(() => resolve()));
    await closeHttp(gateway);
    await closeHttp(unrelated);
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (failure) throw failure;
  });
  const unrelatedPort = await listen(unrelated);
  const initial: Config = { ...route(unrelatedPort, "serve", 8443), Foreground: { borrowed: route(unrelatedPort, "serve", 10000) } };
  const config = structuredClone(initial);
  env.PORTUS_MCP_PORT = String(await listen(gateway));
  watchServer = createNetServer(socket => {
    sockets.add(socket);
    let pending = "";
    let session: string | undefined;
    socket.on("error", () => {});
    socket.on("data", chunk => {
      pending += chunk.toString();
      if (session || !pending.includes("\n")) return;
      const message = watchSchema.parse(JSON.parse(pending.split("\n")[0]));
      session = message.session;
      config.Foreground ??= {};
      config.Foreground[session] = route(message.port, message.mode);
      socket.write("registered\n");
      events.emit("change");
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (session) delete config.Foreground?.[session];
      events.emit("change");
    });
  });
  const watchPort = await listen(watchServer);
  function track(child: ChildProcess) {
    children.add(child);
    child.on("error", () => {});
    return child;
  }
  async function startBackend(alias = "before") {
    assert(!backend || backend.exitCode !== null || backend.signalCode !== null);
    const child = track(spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: root, env: { ...env, PORTUS_MCP_PORT: String(backendPort), PORTUS_MCP_PROJECTS: `${alias}=${project}` },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
    }));
    backend = child;
    let diagnostic = "";
    child.stdout?.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    child.stderr?.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    const ready = await bounded(new Promise<z.infer<typeof listeningSchema>>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Backend exited ${code}: ${diagnostic}`)));
      child.on("message", message => {
        const parsed = listeningSchema.safeParse(message);
        if (parsed.success) resolve(parsed.data);
      });
    }), 15000, "backend listening");
    assert.equal(ready.pid, child.pid);
    assert.equal(ready.port, backendPort);
    return child;
  }
  function makeLauncher(mode: Mode = "serve", options: { plans?: Plan[]; cleanupExited?: (...args: unknown[]) => Promise<{ confirmed: boolean }> } = {}) {
    const launcher = createLauncher({ mode, attachOnly: true, env,
      ...(options.cleanupExited ? { cleanupExited: options.cleanupExited } : {}),
      executeTailscale: async (_binary: string, args: string[]) => {
        if (args[0] === "status") return { state: "ok", observedAt: new Date().toISOString(), value: { BackendState: daemonRunning ? "Running" : "NeedsLogin", Self: { Online: daemonRunning, DNSName: hostname } } };
        assert.deepEqual(args, ["serve", "status", "--json"]);
        return { state: "ok", observedAt: new Date().toISOString(), value: structuredClone(config) };
      },
      launchTunnel: () => assert.fail("attach recovery must not launch a tunnel"),
      launchTailscale: (_binary: string, args: string[], managed: ManagedOptions) => {
        assert.equal(Object.keys(config.Foreground ?? {}).filter(key => key !== "borrowed").length, 0, "previous foreground session must be released before spawning");
        for (const previous of sessions) assert(previous.child.exitCode !== null || previous.child.signalCode !== null || !previous.child.pid, "no overlapping owned CLI processes");
        const index = sessions.length;
        const id = `owned-${index}`;
        const plan = options.plans?.[index] ?? "ready";
        const source = `
          const http = require('node:http');
          const net = require('node:net');
          const { z } = require('zod');
          const command = z.object({ type: z.literal('exit'), code: z.number().int(), diagnostic: z.string().optional() });
          const proxy = http.createServer((request,response)=>{
            const upstream=http.request({hostname:'127.0.0.1',port:${Number(env.PORTUS_MCP_PORT)},path:request.url,method:request.method,headers:request.headers},reply=>{response.writeHead(reply.statusCode,reply.headers);reply.pipe(response);});
            upstream.setTimeout(2000,()=>upstream.destroy(new Error('backend request deadline')));
            upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end('backend unavailable');});
            response.on('close',()=>upstream.destroy());request.pipe(upstream);
          });
          const watch=net.connect(${watchPort},'127.0.0.1');
          watch.on('error',()=>process.exit(9));watch.on('close',()=>process.exit(8));
          watch.once('connect',()=>proxy.listen(0,'127.0.0.1',()=>{
            process.send({type:'proxy-started',pid:process.pid,port:proxy.address().port});
            if(${JSON.stringify(plan)}==='exit-before-ready'){process.stderr.write('temporary transport stopped',()=>process.exit(7));return;}
            if(${JSON.stringify(plan)}==='no-route')return;
            watch.write(JSON.stringify({session:${JSON.stringify(id)},mode:${JSON.stringify(args[0])},port:${Number(args[1])}})+'\\n');
          }));
          watch.once('data',()=>process.send({type:'proxy-ready',pid:process.pid,port:proxy.address().port}));
          process.on('message',message=>{const parsed=command.safeParse(message);if(!parsed.success)return;const value=parsed.data;if(value.diagnostic)process.stderr.write(value.diagnostic,()=>process.exit(value.code));else process.exit(value.code);});
          setTimeout(()=>process.exit(99),60000);
        `;
        const child = track(plan === "spawn-error"
          ? startProcess("recovery-fixture", "0", path.join(temp, "missing-cli"), [], managed)
          : startProcess("recovery-fixture", "0", process.execPath, ["-e", source], { ...managed, forwardOutput: false, ipc: true }));
        const session = { id, child, spawnedAt: performance.now(), exitedAt: undefined as number | undefined, port: undefined as number | undefined, started: deferred<void>(), ready: deferred<void>() };
        sessions.push(session);
        child.once("exit", () => { session.exitedAt = performance.now(); events.emit("change"); });
        child.on("message", message => {
          const parsed = childMessageSchema.safeParse(message);
          if (!parsed.success) return;
          assert.equal(parsed.data.pid, child.pid);
          session.port = parsed.data.port;
          session.started.resolve();
          if (parsed.data.type === "proxy-ready") session.ready.resolve();
          events.emit("change");
        });
        events.emit("change");
        return child;
      }
    });
    launchers.push(launcher);
    return launcher;
  }
  async function sessionAt(index: number) {
    await bounded(new Promise<void>(resolve => {
      const check = () => { if (sessions[index]) { events.off("change", check); resolve(); } };
      events.on("change", check); check();
    }), 10000, `CLI spawn ${index}`);
    return sessions[index];
  }
  async function ready(index: number) {
    const session = await sessionAt(index);
    await bounded(session.ready.promise, 5000, "proxy route ready");
    return session;
  }
  async function lose(index: number, code = 0, diagnostic?: string) {
    const session = sessions[index];
    assert(session);
    const exited = once(session.child, "exit");
    session.child.send({ type: "exit", code, diagnostic });
    await bounded(exited, 5000, "controlled CLI exit");
    assert(session.exitedAt !== undefined);
    return session.exitedAt;
  }
  function url(index: number) {
    const session = sessions[index];
    assert(session?.port);
    return `http://127.0.0.1:${session.port}${mcpPath}`;
  }
  async function preserved(expected: Config = initial) {
    assert.equal(backend?.exitCode, null);
    assert.equal(backend?.signalCode, null);
    assert.deepEqual(config.TCP, expected.TCP);
    assert.deepEqual(config.Web, expected.Web);
    assert.deepEqual(config.AllowFunnel, expected.AllowFunnel);
    assert.deepEqual(config.Foreground?.borrowed, expected.Foreground?.borrowed);
    const response = await fetch(`http://127.0.0.1:${unrelatedPort}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await response.text(), "borrowed-listener");
    await assertAliases(`http://127.0.0.1:${env.PORTUS_MCP_PORT}${mcpPath}`, token, ["before"]);
  }
  return {
    startBackend, makeLauncher, ready, sessionAt, lose, url, sessions, token, preserved,
    backendUrl: () => `http://127.0.0.1:${env.PORTUS_MCP_PORT}${mcpPath}`,
    stopBackend: async () => { assert(backend); await stopChild(backend); },
    protocolRequests: () => protocolRequests,
    state: () => structuredClone(config), initial,
    waitForOwnedRelease: () => bounded(new Promise<void>(resolve => {
      const check = () => {
        if (Object.keys(config.Foreground ?? {}).every(key => key === "borrowed")) {
          events.off("change", check);
          resolve();
        }
      };
      events.on("change", check);
      check();
    }), 5000, "foreground watch release"),
    setDaemonUnavailable: () => { daemonRunning = false; },
    addConflict: () => {
      const conflict = route(unrelatedPort, "serve", 443);
      config.TCP = { ...config.TCP, ...conflict.TCP };
      config.Web = { ...config.Web, ...conflict.Web };
    },
    acknowledgeFailedStop: async (launcher: Launcher) => {
      await assert.rejects(launcher.stop());
      acknowledgedStopFailures.add(launcher);
    }
  };
}

let requestId = 0;
async function rpc(url: string, token: string, method: string, params?: unknown, notification = false) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++requestId }), method, ...(params === undefined ? {} : { params }) }),
    signal: AbortSignal.timeout(3000)
  });
  const body = await response.text();
  return { status: response.status, json: body ? JSON.parse(body) as unknown : undefined };
}
async function assertAliases(url: string, token: string, aliases: string[]) {
  const initialized = await rpc(url, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "recovery-local-test", version: "1" } });
  assert.equal(initialized.status, 200);
  initializeSchema.parse(initialized.json);
  assert.equal((await rpc(url, token, "notifications/initialized", undefined, true)).status, 202);
  const tools = await rpc(url, token, "tools/list");
  assert.equal(tools.status, 200);
  assert(toolsSchema.parse(tools.json).result.tools.some(tool => tool.name === "project_context"));
  const discovery = await rpc(url, token, "tools/call", { name: "project_context", arguments: { include: { projects: true } } });
  assert.equal(discovery.status, 200);
  const result = aliasesSchema.parse(discovery.json).result;
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent.result.sections.projects.value.projectAliases, aliases);
}
async function failed(launcher: Launcher) {
  await bounded(launcher.recovery, 31000, "recovery task");
  const terminal = await bounded(launcher.completion, 6000, "terminal recovery cleanup");
  assert.equal(terminal.state, "failed");
  assert.notEqual(terminal.exitCode, 0);
  return terminal;
}
function delayAtLeast(actual: number, expected: number) {
  assert(actual >= expected, `replacement spawned after ${actual.toFixed(1)}ms, expected at least ${expected}ms`);
}

test("Serve restores three consecutive losses, then exhausts its invocation-wide replacement allowance", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher();
  const initial = await launcher.start();
  assert.equal(initial.backend, undefined);
  assert.equal(initial.external.pid, (await f.ready(0)).child.pid);
  const pids = new Set<number>();
  for (let index = 0; index < 3; index++) {
    const old = await f.ready(index);
    assert(old.child.pid);
    pids.add(old.child.pid);
    const exited = index === 2
      ? await (async () => { const exit = once(old.child, "exit"); old.child.kill("SIGTERM"); await bounded(exit, 5000, "signal loss"); assert(old.exitedAt !== undefined); return old.exitedAt; })()
      : await f.lose(index, index === 0 ? 0 : 12);
    assert.equal(launcher.state, "recovering");
    await bounded(launcher.recovery, 30000, "route restoration");
    const next = await f.ready(index + 1);
    delayAtLeast(next.spawnedAt - exited, [1000, 2000, 4000][index]);
    assert(performance.now() - exited <= 30000);
    assert.equal(launcher.state, "running");
    assert.notEqual(next.child.pid, old.child.pid);
    assert.notEqual(next.id, old.id);
    assert.equal(f.state().Foreground?.[old.id], undefined);
    assert.equal(Object.keys(f.state().Foreground ?? {}).length, 2);
    await assertAliases(f.url(index + 1), "", ["before"]);
    await f.preserved();
  }
  assert((await f.ready(3)).child.pid);
  pids.add(f.sessions[3].child.pid!);
  assert.equal(pids.size, 4);
  await f.lose(3, 0);
  const terminal = await failed(launcher);
  assert.equal(terminal.cleanup, "confirmed");
  assert.equal(f.sessions.length, 4);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

test("Funnel restores its route while the borrowed authenticated backend is absent", { timeout: 40000 }, async t => {
  const f = await fixture(t, "isolated-recovery-token");
  const original = await f.startBackend();
  const launcher = f.makeLauncher("funnel");
  await launcher.start();
  const before = await f.ready(0);
  await assertAliases(f.url(0), f.token, ["before"]);
  await f.stopBackend();
  const protocolRequests = f.protocolRequests();
  await f.lose(0);
  await bounded(launcher.recovery, 30000, "Funnel route restoration without backend");
  const restored = await f.ready(1);
  assert.notEqual(restored.child.pid, before.child.pid);
  assert.equal(launcher.state, "running");
  assert.equal(f.protocolRequests(), protocolRequests, "recovery must not repeat initial MCP verification");
  const response = await fetch(f.url(1), { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 502);
  await response.text();
  const replacement = await f.startBackend("after");
  assert.notEqual(replacement.pid, original.pid);
  await assertAliases(f.url(1), f.token, ["after"]);
  await launcher.stop();
  assert.equal((await launcher.completion).state, "stopped");
  assert.equal(replacement.exitCode, null);
  assert.equal(replacement.signalCode, null);
  await assertAliases(f.backendUrl(), f.token, ["after"]);
  assert.deepEqual(f.state(), f.initial);
});

test("replacement processes exiting before readiness consume all attempts in the original outage episode", { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher("serve", { plans: ["ready", "exit-before-ready", "exit-before-ready", "exit-before-ready"] });
  await launcher.start();
  await f.ready(0);
  const exited = await f.lose(0);
  const terminal = await failed(launcher);
  assert.equal(terminal.cleanup, "confirmed");
  assert.equal(f.sessions.length, 4);
  for (let index = 1; index <= 3; index++) {
    const prior = f.sessions[index - 1];
    assert(prior.exitedAt !== undefined);
    delayAtLeast(f.sessions[index].spawnedAt - prior.exitedAt, [1000, 2000, 4000][index - 1]);
    assert.equal(f.sessions[index].child.exitCode, 7);
  }
  assert(performance.now() - exited <= 30000);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

test("a live replacement without a route exhausts the real outage deadline and is cleaned before terminal completion", { timeout: 50000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher("serve", { plans: ["ready", "no-route"] });
  await launcher.start();
  await f.ready(0);
  const exited = await f.lose(0);
  const replacement = await f.sessionAt(1);
  await bounded(replacement.started.promise, 5000, "replacement proxy listening without route");
  assert.equal(replacement.child.exitCode, null);
  assert.equal(launcher.state, "recovering");
  const terminal = await failed(launcher);
  const elapsed = performance.now() - exited;
  assert(elapsed >= 24900, `outage deadline ended early at ${elapsed}ms`);
  assert(elapsed <= 30000, `cleanup exceeded the outage budget at ${elapsed}ms`);
  assert.equal(terminal.cleanup, "confirmed");
  assert(replacement.child.exitCode !== null || replacement.child.signalCode !== null);
  assert.equal(f.sessions.length, 2);
  await launcher.stop();
  assert.equal(f.sessions.length, 2);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

for (const [category, diagnostic] of [
  ["auth", "authentication required"], ["policy", "permission denied"],
  ["configuration", "invalid configuration"], ["conflict", "address already in use"]
] as const) {
  test(`final streamed ${category} diagnostic refuses recovery before any replacement`, { timeout: 25000 }, async t => {
    const f = await fixture(t);
    await f.startBackend();
    const launcher = f.makeLauncher();
    await launcher.start();
    await f.ready(0);
    await f.lose(0, 1, diagnostic);
    const terminal = await failed(launcher);
    assert.equal(terminal.cleanup, "confirmed");
    assert.equal(f.sessions.length, 1);
    assert.deepEqual(f.state(), f.initial);
    await f.preserved();
  });
}

test("a backend-unreachable diagnostic does not refuse route-only recovery", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher();
  await launcher.start();
  await f.ready(0);
  await f.lose(0, 1, "backend unreachable");
  await bounded(launcher.recovery, 30000, "nonterminal backend diagnostic recovery");
  await f.ready(1);
  assert.equal(launcher.state, "running");
  assert.equal(f.sessions.length, 2);
  await assertAliases(f.url(1), "", ["before"]);
  await f.preserved();
});

for (const refusal of ["spawn-error", "daemon", "listener-conflict"] as const) {
  test(`replacement ${refusal} is terminal without subsequent spawn`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.startBackend();
    const launcher = f.makeLauncher("serve", { plans: ["ready", "spawn-error"] });
    await launcher.start();
    await f.ready(0);
    if (refusal === "daemon") f.setDaemonUnavailable();
    if (refusal === "listener-conflict") f.addConflict();
    const expected = f.state();
    delete expected.Foreground?.[f.sessions[0].id];
    await f.lose(0);
    const terminal = await failed(launcher);
    assert.equal(terminal.cleanup, "confirmed");
    assert.equal(f.sessions.length, refusal === "spawn-error" ? 2 : 1);
    if (refusal === "spawn-error") assert.equal(f.sessions[1].child.pid, undefined);
    assert.deepEqual(f.state(), expected);
    await f.preserved(expected);
  });
}

test("unverified exited-tree cleanup refuses replacement and preserves borrowed resources", { timeout: 30000, skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher("serve", { cleanupExited: async () => ({ confirmed: false }) });
  await launcher.start();
  await f.ready(0);
  await f.lose(0);
  const terminal = await failed(launcher);
  assert.equal(terminal.cleanup, "unverified");
  await f.acknowledgeFailedStop(launcher);
  await f.waitForOwnedRelease();
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

for (const phase of ["backoff", "replacement-startup"] as const) {
  test(`manual stop during recovery ${phase} cancels late spawns and preserves borrowed ownership`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.startBackend();
    const launcher = f.makeLauncher("serve", { plans: ["ready", "no-route"] });
    await launcher.start();
    await f.ready(0);
    await f.lose(0);
    assert.equal(launcher.state, "recovering");
    if (phase === "replacement-startup") {
      const replacement = await f.sessionAt(1);
      await bounded(replacement.started.promise, 5000, "replacement startup acknowledgement");
      assert.equal(replacement.child.exitCode, null);
      assert.equal(f.state().Foreground?.[replacement.id], undefined);
    }
    const recovery = launcher.recovery;
    await bounded(launcher.stop(), 7000, "manual recovery stop");
    await bounded(recovery, 1000, "cancelled recovery settles");
    const terminal = await launcher.completion;
    assert.equal(terminal.state, "stopped");
    assert.equal(terminal.exitCode, 0);
    assert.equal(terminal.cleanup, "confirmed");
    assert.equal(f.sessions.length, phase === "backoff" ? 1 : 2);
    for (const session of f.sessions) assert(session.child.exitCode !== null || session.child.signalCode !== null);
    assert.deepEqual(f.state(), f.initial);
    await f.preserved();
    assert.equal(f.sessions.length, phase === "backoff" ? 1 : 2);
  });
}
