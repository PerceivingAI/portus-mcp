import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import path from "node:path";
import {
  inspectTailscaleConfig, inspectDaemon, collectTailscaleStatus, probeLocalMcp,
  runTailscaleCommand, tailscaleEndpoint, tailscaleStatusExitCode,
  assertTailscaleListenerFree, findOwnedTailscaleRoute
} from "../scripts/tailscale.mjs";

const hostname = "fixture.example.ts.net";
const endpoint = { hostname, host: "127.0.0.1", port: 8789, mcpPath: "/private/mcp" };
function config({ backend = "http://127.0.0.1:8789", allowed, listener = 443, mount = "/", handlers }: { backend?: string; allowed?: boolean; listener?: number; mount?: string; handlers?: Record<string, unknown> } = {}) {
  return {
    TCP: { [listener]: { HTTPS: true } },
    Web: { [`${hostname}:${listener}`]: { Handlers: handlers ?? { [mount]: { Proxy: backend } } } },
    ...(allowed === undefined ? {} : { AllowFunnel: { [`${hostname}:${listener}`]: allowed } })
  };
}

for (const allowed of [false, undefined]) {
  test(`disabled or absent Funnel permission is private (${allowed})`, () => {
    const status = inspectTailscaleConfig(config({ allowed }), endpoint);
    assert.equal(status.state, "configured");
    assert.equal(status.exposure, "private");
    assert.equal(status.url, `https://${hostname}/private/mcp`);
  });
}
for (const allowed of [true, undefined]) {
  test(`unrelated backend is not a Portus endpoint (${allowed})`, () => {
    const status = inspectTailscaleConfig(config({ backend: "http://127.0.0.1:9999", allowed }), endpoint);
    assert.equal(status.state, "mismatch");
    assert.equal(status.url, undefined);
    assert.equal(status.exposure, undefined);
  });
}

test("foreground configuration, non-default port and custom MCP path identify the actual URL", () => {
  const status = inspectTailscaleConfig({ Foreground: { "opaque-session": config({ allowed: true, listener: 8443 }) } }, endpoint);
  assert.equal(status.state, "configured");
  assert.equal(status.exposure, "public");
  assert.equal(status.scope, "foreground");
  assert.equal(status.url, `https://${hostname}:8443/private/mcp`);
});

test("mount and proxy prefixes are inverted without assuming the backend path is public", () => {
  const status = inspectTailscaleConfig(config({ mount: "/bridge/", backend: "http://127.0.0.1:8789/private", allowed: true }), endpoint);
  assert.equal(status.url, `https://${hostname}/bridge/mcp`);
  assert.equal(status.state, "configured");
  const exact = inspectTailscaleConfig(config({ mount: "/bridge", backend: "http://127.0.0.1:8789/private/mcp" }), endpoint);
  assert.equal(exact.url, `https://${hostname}/bridge`);
});

test("a more specific unrelated handler shadows the matching root proxy", () => {
  const status = inspectTailscaleConfig(config({ allowed: true, handlers: { "/": { Proxy: "8789" }, "/private/": { Proxy: "9999" } } }), endpoint);
  assert.equal(status.state, "mismatch");
  assert.equal(status.url, undefined);
});

test("exact mounts cannot be guessed as subtree routes", () => {
  const status = inspectTailscaleConfig(config({ mount: "/bridge" }), endpoint);
  assert.equal(status.state, "mismatch");
});

test("a subtree slash redirect cannot be mistaken for an exact MCP route", () => {
  const status = inspectTailscaleConfig(config({ handlers: { "/": { Proxy: "8789" }, "/private/mcp/": { Proxy: "9999" } } }), endpoint);
  assert.equal(status.state, "mismatch");
});

test("a proxy base with a trailing slash does not match an endpoint without it", () => {
  const status = inspectTailscaleConfig(config({ backend: "http://127.0.0.1:8789/private/mcp/", mount: "/bridge" }), endpoint);
  assert.equal(status.state, "mismatch");
});

test("multiple listener or foreground matches are ambiguous, not a guessed URL", () => {
  const first = config({ allowed: true });
  const other = config({ allowed: true, listener: 8443 });
  const combined = { TCP: { ...first.TCP, ...other.TCP }, Web: { ...first.Web, ...other.Web }, AllowFunnel: { ...first.AllowFunnel, ...other.AllowFunnel } };
  assert.equal(inspectTailscaleConfig(combined, endpoint).state, "ambiguous");
  assert.equal(inspectTailscaleConfig({ ...first, Foreground: { session: first } }, endpoint).state, "ambiguous");
  assert.equal(inspectTailscaleConfig(combined, endpoint).url, undefined);
});

test("different hostname, disabled TLS and different bind do not identify the endpoint", () => {
  const differentHost = { ...endpoint, hostname: "other.example.ts.net" };
  assert.equal(inspectTailscaleConfig(config(), differentHost).state, "mismatch");
  assert.equal(inspectTailscaleConfig({ ...config(), TCP: { 443: { HTTPS: false } } }, endpoint).state, "mismatch");
  assert.equal(inspectTailscaleConfig(config({ backend: "http://127.0.0.2:8789" }), endpoint).state, "mismatch");
});

test("empty, malformed, unsupported and contradictory schemas remain distinct", () => {
  assert.equal(inspectTailscaleConfig({}, endpoint).state, "absent");
  for (const value of [null, [], { NewSchema: {} }, { Foreground: [] }, { Web: { bad: {} } }, { ...config(), AllowFunnel: { [`${hostname}:443`]: "false" } }, { ...config(), TCP: {443: {HTTPS: true, TCPForward: "127.0.0.1:8789"}} }, { Services: {"svc:other": {}} }]) {
    assert.equal(inspectTailscaleConfig(value, endpoint).state, "unknown");
  }
});

test("Running without Online true or usable DNS is not connected, malformed DNS never throws", () => {
  for (const value of [
    { BackendState: "Running", Self: { Online: false, DNSName: hostname } },
    { BackendState: "Running", Self: { DNSName: hostname } },
    { BackendState: "NoState", Self: { Online: false } }
  ]) assert.equal(inspectDaemon({state: "ok", value}).state, "not-ready");
  assert.equal(inspectDaemon({state: "ok", value: {BackendState: "Running", Self: {Online: true, DNSName: 7}}}).state, "unknown");
  assert.equal(inspectDaemon({state: "ok", value: {BackendState: "new-state"}}).state, "unknown");
});

test("saved public configuration cannot imply daemon, local MCP or public readiness", async () => {
  const status = await collectTailscaleStatus({
    env: {PORTUS_MCP_PATH: endpoint.mcpPath},
    execute: async (_binary: string, args: string[]) => ({state: "ok", observedAt: new Date().toISOString(), value: args[0] === "status" ? {BackendState: "NoState", Self: {Online: false, DNSName: hostname}} : config({allowed: true})}),
    probe: async () => ({state: "failed", reason: "mcp-auth-rejected", observedAt: new Date().toISOString()})
  });
  assert.equal(status.route.state, "configured");
  assert.equal(status.daemon.state, "not-ready");
  assert.equal(status.local.state, "failed");
  assert.equal(status.public.state, "not-checked");
  assert.equal(tailscaleStatusExitCode(status), 1);
});

async function localOrigin(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address === "object");
  return {host: "127.0.0.1", port: address.port, mcpPath: "/private/mcp", bearerToken: "fixture-token"};
}

test("a health payload or an SSE stream cannot verify MCP discovery", async t => {
  const health = await localOrigin(t, (_req, res) => res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({name:"portus-mcp",status:"ok"})));
  assert.equal((await probeLocalMcp(health)).state, "failed");
  const stream = await localOrigin(t, (_req, res) => { res.writeHead(200, {"content-type":"text/event-stream"}); res.flushHeaders(); });
  assert.equal((await probeLocalMcp(stream, {timeoutMs: 300})).reason, "non-json-mcp-response");
});

test("local authentication failure and a hung origin are bounded failed observations", async t => {
  // This integration checks AbortSignal cancellation of a real socket, not timer scheduling.
  const denied = await localOrigin(t, (_req, res) => res.writeHead(401).end());
  assert.equal((await probeLocalMcp(denied)).reason, "mcp-auth-rejected");
  const hung = await localOrigin(t, () => {});
  assert.equal((await probeLocalMcp(hung, {timeoutMs: 100})).reason, "local-probe-timeout");
});

test("non-loopback endpoints are not probed with the bearer", async () => {
  assert.throws(() => tailscaleEndpoint({PORTUS_MCP_HOST: "example.com"}));
  const status = await collectTailscaleStatus({env: {PORTUS_MCP_HOST:"example.com", PORTUS_MCP_BEARER_TOKEN:"fixture-secret"}, execute: async () => ({state:"error",reason:"cli-unavailable"})});
  assert.equal(status.local.state, "not-checked");
  assert.equal(status.route.state, "unknown");
  assert.equal(status.authentication, "configured");
  assert.ok(!JSON.stringify(status).includes("fixture-secret"));
});

test("real CLI command timeout, malformed JSON and output overflow disclose no raw data", async () => {
  // A real OS subprocess deadline cannot be driven by the parent's fake clock.
  const timed = await runTailscaleCommand(process.execPath, ["-e", "require('node:net').createServer().listen(0,'127.0.0.1')"], {timeoutMs:100});
  assert.equal(timed.reason, "command-timeout");
  const malformed = await runTailscaleCommand(process.execPath, ["-e", "console.log('Authorization: Bearer fixture-secret')"]);
  assert.equal(malformed.reason, "malformed-json");
  const overflow = await runTailscaleCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"]);
  assert.equal(overflow.reason, "command-output-limit");
  assert.ok(!JSON.stringify([timed,malformed,overflow]).includes("fixture-secret"));
});

async function childOutput(args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(process.execPath, args, {env, stdio:["ignore","pipe","pipe"]});
  let stdout = "", stderr = "";
  proc.stdout.on("data", b => stdout += b);
  proc.stderr.on("data", b => stderr += b);
  const code = await new Promise<number | null>((resolve,reject) => {proc.once("error",reject);proc.once("close",resolve);});
  return {code,stdout,stderr};
}
const safeEnv = () => ({...process.env, DOTENV_CONFIG_PATH:path.resolve(".missing-tailscale-fixture.env")});

test("actual status CLI honors an invalid explicit override and never falls back to the installed daemon", async () => {
  const result = await childOutput(["scripts/check-tailscale.mjs", "--json"], {...safeEnv(), PORTUS_TAILSCALE_PATH:path.resolve("private-fixture-directory", "missing-tailscale.exe"), PORTUS_MCP_PORT:"0", PORTUS_MCP_BEARER_TOKEN:"fixture-secret"});
  assert.equal(result.code,1);
  const status = JSON.parse(result.stdout);
  assert.equal(status.daemon.reason,"cli-unavailable");
  assert.equal(status.route.state,"unknown");
  assert.equal(status.local.state,"not-checked");
  assert.ok(!result.stdout.includes("private-fixture-directory"));
  assert.ok(!result.stdout.includes("fixture-secret"));
});

for(const verbose of [false,true]) {
  test(`actual launcher retains bounded redacted Tailscale failures with verbose=${verbose}`, async () => {
    const output = "Authentication failed Authorization: Bearer fixture-secret https://private.example.ts.net/secret-path C:\\private-fixture\\file\n";
    const source = `import {startProcess} from './scripts/start-all.mjs'; startProcess('funnel','0',process.execPath,['-e',${JSON.stringify(`process.stderr.write(${JSON.stringify(output)}.repeat(2000));process.exit(7)`)}],{forwardOutput:${verbose},tailscaleDiagnostics:true});`;
    const result = await childOutput(["--input-type=module","-e",source],safeEnv());
    assert.match(result.stdout,/authentication/i);
    assert.match(result.stdout,/exit 7/);
    for(const secret of ["fixture-secret","private.example.ts.net","secret-path","private-fixture"]) assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    assert.ok(result.stdout.length < 4096);
  });
}

test("listener preflight refuses unknown schemas rather than assuming a free port", () => {
  for (const value of [{NewSchema:{}},{Services:{"svc:unrelated":{}}},{TCP:{443:{HTTPS:"true"}}}]) {
    assert.throws(() => assertTailscaleListenerFree(value), /unsupported or malformed/);
  }
});

test("route ownership cannot be established after unrelated configuration changes", () => {
  const unrelated = config({listener:8443,backend:"http://127.0.0.1:9999"});
  const before = assertTailscaleListenerFree(unrelated);
  const foreground = {owned:config({allowed:true})};
  const changedBackground = config({listener:8443,backend:"http://127.0.0.1:9998"});
  assert.throws(() => findOwnedTailscaleRoute(before,{...changedBackground,Foreground:foreground},{...endpoint,mode:"funnel"}), /Background.*changed/);
  assert.throws(() => findOwnedTailscaleRoute(before,{...unrelated,Foreground:{...foreground,another:config({listener:10000})}},{...endpoint,mode:"funnel"}), /ambiguous/);
});
