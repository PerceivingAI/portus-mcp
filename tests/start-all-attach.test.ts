import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server, type RequestListener } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLauncher, startProcess } from "../scripts/start-all.mjs";

const root = process.cwd();
const hostname = "attach-fixture.example.ts.net";
const mcpPath = "/attach/mcp";
type Mode = "serve" | "funnel";
type ServeConfig = {
  TCP?: Record<string, { HTTPS: boolean }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
};
type ManagedOptions = { env: NodeJS.ProcessEnv; forwardOutput: boolean; tailscaleDiagnostics: boolean; processGroup: boolean };
const listeningSchema = z.object({ type: z.literal("portus-mcp:listening"), pid: z.number().int().positive(), host: z.literal("127.0.0.1"), port: z.number().int().positive(), mcpPath: z.literal(mcpPath) });
const proxySchema = z.object({ type: z.literal("proxy-ready"), pid: z.number().int().positive(), port: z.number().int().positive() });
const watchSchema = z.object({ mode: z.enum(["serve", "funnel"]), port: z.number().int().positive() });
const initializeSchema = z.object({ result: z.object({ protocolVersion: z.literal("2025-06-18"), serverInfo: z.object({ name: z.literal("portus-mcp") }) }) });
const toolsSchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) });
const aliasesSchema = z.object({ result: z.object({ isError: z.boolean().optional(), structuredContent: z.object({ result: z.object({ sections: z.object({ projects: z.object({ ok: z.literal(true), value: z.object({ projectAliases: z.array(z.string()) }) }) }) }) }) }) });

function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  // Real child/socket integration cannot use fake time; this is only a failure
  // bound. Successful paths synchronize on IPC, HTTP, and process events.
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function route(port: number, mode: Mode = "serve", listener = 443): ServeConfig {
  return {
    TCP: { [listener]: { HTTPS: true } },
    Web: { [`${hostname}:${listener}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
    ...(mode === "funnel" ? { AllowFunnel: { [`${hostname}:${listener}`]: true } } : {})
  };
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
async function closeHttp(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await deadline(closed, 5000, "independent child cleanup");
}

async function fixture(t: TestContext, { token = "", initial = {} }: { token?: string; initial?: ServeConfig } = {}) {
  const temp = mkdtempSync(path.join(root, ".portus-attach-"));
  const project = path.join(temp, "project");
  mkdirSync(project);
  mkdirSync(path.join(temp, "skills"));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  Object.assign(env, {
    DOTENV_CONFIG_PATH: path.join(temp, "absent.env"),
    PORTUS_MCP_HOST: "127.0.0.1", PORTUS_MCP_PATH: mcpPath,
    PORTUS_MCP_CONFIG_PATH: path.join(root, "portus-mcp.config.json"),
    PORTUS_MCP_POLICY_PATH: path.join(root, "portus-mcp.policy.json"),
    PORTUS_MCP_STATE_DIR: path.join(temp, "state"), PORTUS_MCP_PROJECTS: `before=${project}`,
    AGENT_SKILL_PATHS: path.join(temp, "skills"), SUBAGENTS_SKILL_PATHS: path.join(temp, "skills")
  });
  if (token) env.PORTUS_MCP_BEARER_TOKEN = token;
  const children = new Set<ChildProcess>();
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();
  const launchers: Array<{ stop: () => Promise<void> }> = [];
  const config = structuredClone(initial);
  const proxyReady = deferred<z.infer<typeof proxySchema>>();
  let launches = 0;
  let backend: ChildProcess | undefined;
  let proxy: ChildProcess | undefined;
  let watchServer: NetServer | undefined;
  t.after(async () => {
    let failure: unknown;
    for (const launcher of launchers.reverse()) {
      try { await deadline(launcher.stop(), 6000, "launcher final cleanup"); } catch (error) { failure ??= error; }
    }
    // Independent ownership of every fixture child prevents a broken launcher
    // cleanup from leaving the borrowed backend or local proxy behind.
    for (const child of children) {
      try { await stopChild(child); } catch (error) { failure ??= error; }
    }
    for (const socket of sockets) socket.destroy();
    if (watchServer) await new Promise<void>(resolve => watchServer!.close(() => resolve()));
    for (const server of servers) await closeHttp(server);
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (failure) throw failure;
  });
  const reservation = createNetServer();
  env.PORTUS_MCP_PORT = String(await listen(reservation));
  await new Promise<void>(resolve => reservation.close(() => resolve()));

  watchServer = createNetServer(socket => {
    sockets.add(socket);
    let pending = "";
    let registered = false;
    socket.on("data", chunk => {
      pending += chunk.toString();
      if (registered || !pending.includes("\n")) return;
      const message = watchSchema.parse(JSON.parse(pending.split("\n")[0]));
      registered = true;
      config.Foreground ??= {};
      config.Foreground["attach-owned-session"] = route(message.port, message.mode);
      socket.write("registered\n");
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (!registered || !config.Foreground) return;
      delete config.Foreground["attach-owned-session"];
      if (!Object.keys(config.Foreground).length) delete config.Foreground;
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
      cwd: root, env: { ...env, PORTUS_MCP_PROJECTS: `${alias}=${project}` },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
    }));
    backend = child;
    let diagnostic = "";
    child.stdout?.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    child.stderr?.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    const acknowledgement = await deadline(new Promise<z.infer<typeof listeningSchema>>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Borrowed backend exited ${code}: ${diagnostic}`)));
      child.on("message", message => {
        const parsed = listeningSchema.safeParse(message);
        if (parsed.success) resolve(parsed.data);
      });
    }), 15000, "borrowed backend listen acknowledgement");
    assert.equal(acknowledgement.pid, child.pid);
    assert.equal(acknowledgement.port, Number(env.PORTUS_MCP_PORT));
    return child;
  }
  async function stopBackend() {
    assert(backend);
    await stopChild(backend);
  }
  function makeLauncher(mode: Mode | "tunnel" = "serve", options: { token?: string; failSpawn?: boolean } = {}) {
    const launcher = createLauncher({ mode, attachOnly: true,
      env: { ...env, ...(options.token === undefined ? {} : { PORTUS_MCP_BEARER_TOKEN: options.token }) },
      executeTailscale: async (_binary: string, args: string[]) => {
        if (args[0] === "status") {
          assert.deepEqual(args, ["status", "--json"]);
          return { state: "ok", observedAt: new Date().toISOString(), value: { BackendState: "Running", Self: { Online: true, DNSName: hostname } } };
        }
        assert.deepEqual(args, ["serve", "status", "--json"], "attach must only observe configuration, never reset/off");
        return { state: "ok", observedAt: new Date().toISOString(), value: structuredClone(config) };
      },
      launchTunnel: () => assert.fail("attach-only must never launch a tunnel client"),
      launchTailscale: (_binary: string, args: string[], managed: ManagedOptions) => {
        launches++;
        if (options.failSpawn) return track(startProcess("attach-fixture", "0", path.join(temp, "missing-cli"), [], managed));
        const source = `
          const http = require('node:http');
          const net = require('node:net');
          const proxy = http.createServer((request, response) => {
            const upstream = http.request({hostname:'127.0.0.1',port:${Number(env.PORTUS_MCP_PORT)},path:request.url,method:request.method,headers:request.headers}, reply => {
              response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
            });
            upstream.setTimeout(1000,()=>upstream.destroy(new Error('backend request deadline')));
            upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end('backend unavailable');});
            response.on('close',()=>upstream.destroy());
            request.pipe(upstream);
          });
          const watch = net.connect(${watchPort},'127.0.0.1');
          watch.once('error',()=>process.exit(9));
          watch.once('close',()=>process.exit(8));
          watch.once('connect',()=>{
            proxy.listen(0,'127.0.0.1',()=>watch.write(JSON.stringify({mode:${JSON.stringify(args[0])},port:${Number(args[1])}})+'\\n'));
          });
          watch.once('data',()=>process.send({type:'proxy-ready',pid:process.pid,port:proxy.address().port}));
          process.on('message',message=>{if(message && message.type==='exit')process.exit(0);});
        `;
        proxy = track(startProcess("attach-fixture", "0", process.execPath, ["-e", source], { ...managed, forwardOutput: false, ipc: true }));
        proxy.on("message", message => {
          const parsed = proxySchema.safeParse(message);
          if (parsed.success) proxyReady.resolve(parsed.data);
        });
        return proxy;
      }
    });
    launchers.push(launcher);
    return launcher;
  }
  async function fakeBackend(handler: RequestListener) {
    const server = createHttpServer(handler);
    servers.add(server);
    await listen(server, Number(env.PORTUS_MCP_PORT));
    return server;
  }
  return {
    env, startBackend, stopBackend, makeLauncher, fakeBackend,
    proxyReady: () => deadline(proxyReady.promise, 5000, "proxy acknowledgement"),
    state: () => structuredClone(config), launchCount: () => launches,
    proxy: () => { assert(proxy); return proxy; },
    backend: () => { assert(backend); return backend; },
    url: () => `http://127.0.0.1:${env.PORTUS_MCP_PORT}${mcpPath}`,
    token
  };
}

let requestId = 0;
async function rpc(url: string, token: string, method: string, params?: unknown, notification = false) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++requestId }), method, ...(params === undefined ? {} : { params }) }),
    signal: AbortSignal.timeout(2000)
  });
  const body = await response.text();
  return { status: response.status, json: body ? JSON.parse(body) as unknown : undefined };
}
async function assertAliases(url: string, token: string, expected: string[]) {
  const initialized = await rpc(url, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "attach-local-test", version: "1" } });
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
  assert.deepEqual(result.structuredContent.result.sections.projects.value.projectAliases, expected);
}

for (const [mode, token] of [["serve", ""], ["funnel", "attach-isolated-token"]] as const) {
  test(`attach-only ${mode} survives borrowed backend restart and manual stop preserves unrelated ownership`, { timeout: 40000 }, async t => {
    const unrelated = createHttpServer((_request, response) => response.end("unrelated-listener"));
    t.after(() => closeHttp(unrelated));
    const unrelatedPort = await listen(unrelated);
    const initial: ServeConfig = { ...route(unrelatedPort, "serve", 8443), Foreground: { borrowed: route(unrelatedPort, "serve", 10000) } };
    const f = await fixture(t, { token, initial });
    const original = await f.startBackend();
    const launcher = f.makeLauncher(mode);
    const running = await launcher.start();
    const proxy = await f.proxyReady();
    assert.equal(running.backend, undefined, "borrowed backend must not be returned as owned");
    assert.equal(running.external.pid, proxy.pid);
    assert.equal(running.route.exposure, mode === "funnel" ? "public" : "private");
    const url = `http://127.0.0.1:${proxy.port}${mcpPath}`;
    await assertAliases(url, token, ["before"]);
    const configured = f.state();
    await f.stopBackend();
    const unavailable = await fetch(url, { signal: AbortSignal.timeout(2000) });
    assert.equal(unavailable.status, 502);
    await unavailable.text();
    assert.equal(launcher.state, "running");
    assert.equal(f.proxy().exitCode, null);
    assert.deepEqual(f.state(), configured);
    const replacement = await f.startBackend("after");
    assert.notEqual(replacement.pid, original.pid);
    await assertAliases(url, token, ["after"]);
    assert.equal(f.proxy().pid, proxy.pid);
    assert.equal(f.launchCount(), 1);
    assert.deepEqual(f.state(), configured);
    await deadline(launcher.stop(), 6000, "manual companion stop");
    const terminal = await launcher.completion;
    assert.equal(terminal.state, "stopped");
    assert.equal(terminal.cleanup, "confirmed");
    assert(f.proxy().exitCode !== null || f.proxy().signalCode !== null);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
    assert.equal(replacement.exitCode, null);
    await assertAliases(f.url(), token, ["after"]);
    assert.deepEqual(f.state(), initial);
    const preserved = await fetch(`http://127.0.0.1:${unrelatedPort}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(await preserved.text(), "unrelated-listener");
  });
}

test("attach-only stops its companion while borrowed backend is absent", { timeout: 25000 }, async t => {
  const initial = route(9999, "serve", 8443);
  const f = await fixture(t, { initial });
  await f.startBackend();
  const launcher = f.makeLauncher();
  await launcher.start();
  await f.proxyReady();
  await f.stopBackend();
  await deadline(launcher.stop(), 6000, "stop without backend");
  assert.equal((await launcher.completion).cleanup, "confirmed");
  assert.deepEqual(f.state(), initial);
});

test("attach-only refuses wrong or missing configured authentication before exposure", { timeout: 30000 }, async t => {
  const f = await fixture(t, { token: "attach-required-token" });
  const borrowed = await f.startBackend();
  for (const token of ["wrong-token", ""]) {
    await deadline(assert.rejects(f.makeLauncher("funnel", { token }).start()), 6000, "authentication refusal");
    assert.equal(f.launchCount(), 0);
    assert.deepEqual(f.state(), {});
    assert.equal(borrowed.exitCode, null);
    await assertAliases(f.url(), f.token, ["before"]);
  }
});

for (const variant of ["health-only", "wrong-mcp", "unavailable"] as const) {
  test(`attach-only refuses ${variant} backend without exposing or claiming it`, { timeout: 12000 }, async t => {
    const f = await fixture(t);
    if (variant !== "unavailable") {
      await f.fakeBackend((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" || variant === "health-only") {
          response.end(JSON.stringify({ name: "portus-mcp", status: "ok" }));
          return;
        }
        let body = "";
        request.on("data", chunk => { body += chunk.toString(); });
        request.on("end", () => {
          const incoming = z.object({ id: z.number() }).parse(JSON.parse(body));
          response.end(JSON.stringify({ jsonrpc: "2.0", id: incoming.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "not-portus" } } }));
        });
      });
    }
    const launcher = f.makeLauncher();
    await deadline(assert.rejects(launcher.start()), 6500, "protocol refusal");
    assert.equal(f.launchCount(), 0);
    assert.deepEqual(f.state(), {});
    if (variant !== "unavailable") {
      const response = await fetch(f.url(), { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      await response.text();
    }
  });
}

test("attach-only repeated start and conflicting companion preserve the first session", { timeout: 25000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const first = f.makeLauncher();
  await first.start();
  const proxy = await f.proxyReady();
  const configured = f.state();
  await assert.rejects(first.start());
  await assert.rejects(f.makeLauncher("funnel").start(), /listener 443/);
  assert.equal(f.launchCount(), 1);
  assert.equal(first.state, "running");
  assert.deepEqual(f.state(), configured);
  await assertAliases(`http://127.0.0.1:${proxy.port}${mcpPath}`, "", ["before"]);
});

test("attach-only real CLI spawn failure cleans up without stopping borrowed backend", { timeout: 25000 }, async t => {
  const initial = route(9999, "serve", 8443);
  const f = await fixture(t, { initial });
  const backend = await f.startBackend();
  const launcher = f.makeLauncher("serve", { failSpawn: true });
  await deadline(assert.rejects(launcher.start()), 6500, "CLI spawn refusal");
  const terminal = await deadline(launcher.completion, 6000, "spawn failure cleanup");
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.cleanup, "confirmed");
  assert.equal(f.launchCount(), 1);
  assert.deepEqual(f.state(), initial);
  assert.equal(backend.exitCode, null);
  await assertAliases(f.url(), "", ["before"]);
});


test("attach-only intentional stop cancels an in-flight initial probe without exposure", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const borrowed = await f.fakeBackend((_request, _response) => entered.resolve());
  const launcher = f.makeLauncher();
  const starting = launcher.start();
  // Register rejection handling before cancellation, not after a possible rejection.
  const rejected = assert.rejects(starting);
  await deadline(entered.promise, 2000, "initial probe entered borrowed server");
  await deadline(launcher.stop(), 1500, "cancel hung initial probe");
  await deadline(rejected, 1500, "cancelled startup settles");
  assert.equal((await launcher.completion).state, "stopped");
  assert.equal(f.launchCount(), 0);
  assert.deepEqual(f.state(), {});
  assert.equal(borrowed.listening, true);
});

test("attach-only tunnel mode is rejected before any external child is launched", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.makeLauncher("tunnel").start());
  assert.equal(f.launchCount(), 0);
  assert.deepEqual(f.state(), {});
});
