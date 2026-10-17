import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_COMMAND_BYTES = 256 * 1024;
const timestamp = () => new Date().toISOString();
const normalizeHost = (host) => host === "localhost" ? "127.0.0.1" : host;
const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };

export function resolveTailscalePath(env = process.env, platform = os.platform()) {
  // An explicit override is authoritative. A bad override must not select a different installation.
  if (env.PORTUS_TAILSCALE_PATH?.trim()) return env.PORTUS_TAILSCALE_PATH.trim();
  const executable = platform === "win32" ? "tailscale.exe" : "tailscale";
  const separator = platform === "win32" ? ";" : ":";
  const locations = (env.PATH ?? env.Path ?? "").split(separator).filter(Boolean).map((dir) => path.join(dir.replace(/^"|"$/g, ""), executable));
  locations.push(...(platform === "win32" ? ["C:\\Program Files\\Tailscale\\tailscale.exe"] : ["/usr/bin/tailscale", "/usr/local/bin/tailscale"]));
  return locations.find(isFile) ?? executable;
}

export function runTailscaleCommand(binary, args, { timeoutMs = COMMAND_TIMEOUT_MS, env = process.env, signal } = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_COMMAND_BYTES, windowsHide: true, env, signal }, (error, stdout) => {
      if (error) {
        const reason = error.code === "ENOENT" ? "cli-unavailable"
          : error.code === "ABORT_ERR" ? "command-cancelled"
          : error.code === "EACCES" || error.code === "EPERM" ? "cli-permission-denied"
          : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "command-output-limit"
          : error.killed ? "command-timeout" : "command-failed";
        // Never include error.message/stderr: either may contain credentials, URLs, or local paths.
        resolve({ state: "error", reason, observedAt: timestamp() });
        return;
      }
      try { resolve({ state: "ok", value: JSON.parse(stdout), observedAt: timestamp() }); }
      catch { resolve({ state: "error", reason: "malformed-json", observedAt: timestamp() }); }
    });
  });
}

export function tailscaleEndpoint(env = process.env) {
  const host = normalizeHost(env.PORTUS_MCP_HOST?.trim() || "127.0.0.1");
  const rawPort = env.PORTUS_MCP_PORT?.trim() || "8789";
  const mcpPath = env.PORTUS_MCP_PATH?.trim() || "/mcp";
  if (!["127.0.0.1", "::1"].includes(host) || !/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535 || !mcpPath.startsWith("/") || /[?#%\\\s]/.test(mcpPath) || mcpPath.includes("//") || mcpPath.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("unsupported-local-endpoint");
  }
  return { host, port: Number(rawPort), mcpPath, bearerToken: env.PORTUS_MCP_BEARER_TOKEN?.trim() || "" };
}

function validHostname(hostname) {
  return typeof hostname === "string" && hostname.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) && !hostname.includes("..");
}

const daemonSchema = z.object({
  BackendState: z.enum(["NoState", "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "Running", "InUseOtherUser"]),
  Self: z.object({ Online: z.boolean().optional(), DNSName: z.string().nullish() }).nullish(),
  Health: z.array(z.unknown()).nullish()
});

const portSchema = z.string().regex(/^\d+$/).refine((value) => Number(value) >= 1 && Number(value) <= 65535);
const hostPortSchema = z.string().refine((value) => {
  const match = /^([^:]+):(\d+)$/.exec(value);
  return match && validHostname(match[1]) && portSchema.safeParse(match[2]).success;
});
const mountSchema = z.string().refine((value) => value.startsWith("/") && !/[%?#\\\s]/.test(value) && !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".."));
const tcpSchema = z.object({
  HTTPS: z.boolean().optional(), HTTP: z.boolean().optional(), TCPForward: z.string().optional(),
  TerminateTLS: z.string().optional(), ProxyProtocol: z.number().int().min(0).max(2).optional()
}).strict().refine((handler) => [handler.HTTPS, handler.HTTP, Boolean(handler.TCPForward)].filter(Boolean).length <= 1);
const handlerSchema = z.object({
  Proxy: z.string().optional(), Path: z.string().optional(), Text: z.string().optional(),
  Redirect: z.string().optional(), AcceptAppCaps: z.array(z.string()).optional()
}).strict().refine((handler) => ["Proxy", "Path", "Text", "Redirect"].filter((key) => handler[key] !== undefined).length === 1);
const serveLeafSchema = z.object({
  TCP: z.record(portSchema, tcpSchema).optional(),
  Web: z.record(hostPortSchema, z.object({ Handlers: z.record(mountSchema, handlerSchema) }).strict()).optional(),
  AllowFunnel: z.record(hostPortSchema, z.boolean()).optional(),
  // Tailnet Services are not a verified Portus endpoint shape in this integration.
  Services: z.record(z.unknown()).refine((services) => Object.keys(services).length === 0).optional()
}).strict();
const serveSchema = serveLeafSchema.extend({ Foreground: z.record(serveLeafSchema).optional() });
const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.record(z.unknown()), error: z.never().optional() });
const initializeSchema = z.object({ protocolVersion: z.literal("2025-06-18"), serverInfo: z.object({ name: z.literal("portus-mcp") }) });
const discoverySchema = z.object({ tools: z.array(z.object({ name: z.string().min(1) })) });

export function inspectDaemon(command) {
  if (command.state !== "ok") return { state: "unknown", reason: command.reason, observedAt: command.observedAt };
  const parsed = daemonSchema.safeParse(command.value);
  if (!parsed.success) return { state: "unknown", reason: "unsupported-daemon-status", observedAt: command.observedAt };
  const status = parsed.data;
  const hostname = status.Self?.DNSName?.replace(/\.$/, "");
  const connected = status.BackendState === "Running" && status.Self?.Online === true;
  return {
    state: connected && validHostname(hostname) ? "connected" : "not-ready",
    backendState: status.BackendState,
    online: status.Self?.Online === true,
    hostname: validHostname(hostname) ? hostname.toLowerCase() : undefined,
    healthCount: Array.isArray(status.Health) ? status.Health.length : 0,
    reason: connected && !validHostname(hostname) ? "dns-name-unavailable" : undefined,
    observedAt: command.observedAt
  };
}

function proxyUrl(proxy) {
  if (typeof proxy !== "string" || !proxy) return undefined;
  try {
    const expanded = /^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : proxy.includes("://") ? proxy : `http://${proxy}`;
    const url = new URL(expanded);
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || /[%\\]/.test(url.pathname)) return undefined;
    return url;
  } catch { return undefined; }
}

// Version-matched ServeConfig fields. Unknown extensions cannot become a ready endpoint.
function configurations(config) {
  const parsed = serveSchema.safeParse(config);
  if (!parsed.success) return undefined;
  return [
    { config: parsed.data, scope: "background" },
    ...Object.values(parsed.data.Foreground ?? {}).map((value) => ({ config: value, scope: "foreground" }))
  ];
}

function mountMatches(mount, requestPath) {
  return mount.endsWith("/") ? requestPath.startsWith(mount) : requestPath === mount;
}

export function inspectTailscaleConfig(config, { hostname, host = "127.0.0.1", port = 8789, mcpPath = "/mcp" }) {
  if (!validHostname(hostname)) return { state: "unknown", reason: "dns-name-unavailable" };
  const entries = configurations(config);
  if (!entries) return { state: "unknown", reason: "unsupported-configuration" };
  const matches = [];
  let hasConfiguration = false;
  for (const { config: value, scope } of entries) {
    hasConfiguration ||= ["TCP", "Web", "AllowFunnel"].some((key) => Object.keys(value[key] ?? {}).length > 0);
    for (const [hostPort, web] of Object.entries(value.Web ?? {})) {
      const [name, listener] = hostPort.split(":");
      if (name.toLowerCase() !== hostname.toLowerCase() || value.TCP?.[listener]?.HTTPS !== true) continue;
      for (const [mount, handler] of Object.entries(web.Handlers)) {
        const proxy = proxyUrl(handler.Proxy);
        if (!proxy || normalizeHost(proxy.hostname.replace(/^\[|\]$/g, "")) !== normalizeHost(host) || Number(proxy.port || 80) !== Number(port)) continue;
        if (proxy.pathname.endsWith("/") && proxy.pathname !== "/" && mcpPath === proxy.pathname.slice(0, -1)) continue;
        const base = proxy.pathname === "/" ? "" : proxy.pathname.replace(/\/$/, "");
        if (base && mcpPath !== base && !mcpPath.startsWith(`${base}/`)) continue;
        const suffix = mcpPath.slice(base.length);
        const externalPath = `${mount === "/" ? "" : mount.replace(/\/$/, "")}${suffix}` || "/";
        if (suffix === "" && mount === "/") continue;
        if (!web.Handlers[externalPath] && web.Handlers[`${externalPath}/`]) continue;
        if (!mountMatches(mount, externalPath)) continue;
        // Go ServeMux chooses the exact/longest matching mount. A shadowing handler wins.
        const selected = Object.keys(web.Handlers).filter((key) => mountMatches(key, externalPath)).sort((a, b) => b.length - a.length)[0];
        if (selected !== mount) continue;
        const url = new URL(`https://${hostname}:${listener}`);
        url.pathname = externalPath;
        matches.push({ exposure: value.AllowFunnel?.[hostPort] === true ? "public" : "private", url: url.href, listenerPort: Number(listener), mount, scope });
      }
    }
  }
  if (matches.length > 1) return { state: "ambiguous", reason: "multiple-matching-routes", matchCount: matches.length };
  if (matches.length === 0) return { state: hasConfiguration ? "mismatch" : "absent", reason: "no-matching-endpoint" };
  return { state: "configured", ...matches[0], ownership: "not-verified" };
}

export function validateTailscaleBind(env = process.env) {
  const host = env.PORTUS_MCP_HOST || "127.0.0.1";
  const port = env.PORTUS_MCP_PORT || "8789";
  if (host !== "127.0.0.1") throw new Error("Tailscale standalone modes require PORTUS_MCP_HOST=127.0.0.1; other binds do not match the IPv4 loopback proxy target.");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Tailscale standalone modes require a valid local backend port.");
}

function parsedServeConfig(config) {
  const parsed = serveSchema.safeParse(config);
  if (!parsed.success) throw new Error("Tailscale configuration is unsupported or malformed; refusing to change any listener.");
  return parsed.data;
}

function usesListener(config, listener) {
  return Object.hasOwn(config.TCP ?? {}, String(listener)) ||
    Object.keys(config.Web ?? {}).some((key) => key.endsWith(`:${listener}`)) ||
    Object.keys(config.AllowFunnel ?? {}).some((key) => key.endsWith(`:${listener}`));
}

export function assertTailscaleListenerFree(config, listener = 443) {
  const parsed = parsedServeConfig(config);
  if ([parsed, ...Object.values(parsed.Foreground ?? {})].some((value) => usesListener(value, listener))) {
    throw new Error(`Tailscale listener ${listener} already has unowned configuration; refusing to replace or adopt it.`);
  }
  return parsed;
}

function listenerContent(config) {
  return { TCP: config.TCP ?? {}, Web: config.Web ?? {}, AllowFunnel: config.AllowFunnel ?? {}, Services: config.Services ?? {} };
}

export function findOwnedTailscaleRoute(before, current, endpoint) {
  const after = parsedServeConfig(current);
  if (!isDeepStrictEqual(listenerContent(before), listenerContent(after))) throw new Error("Background Tailscale configuration changed during startup; ownership is not established.");
  for (const [key, value] of Object.entries(before.Foreground ?? {})) {
    if (!isDeepStrictEqual(value, after.Foreground?.[key])) throw new Error("An unrelated foreground route changed during startup; ownership is not established.");
  }
  const added = Object.keys(after.Foreground ?? {}).filter((key) => !Object.hasOwn(before.Foreground ?? {}, key));
  if (!added.length) return undefined;
  if (added.length !== 1) throw new Error("Multiple new Tailscale sessions appeared; route ownership is ambiguous.");
  const route = inspectTailscaleConfig({ Foreground: { [added[0]]: after.Foreground[added[0]] } }, endpoint);
  if (route.state !== "configured" || route.listenerPort !== 443 || route.exposure !== (endpoint.mode === "funnel" ? "public" : "private")) {
    throw new Error("The new foreground route does not match the owned Portus endpoint.");
  }
  return { session: added[0], route };
}

export function tailscaleForegroundReleased(before, current, ownedSession) {
  const after = parsedServeConfig(current);
  if (ownedSession) return !Object.hasOwn(after.Foreground ?? {}, ownedSession);
  // Shutdown can race route creation before its session is confirmed. Never delete it;
  // wait for the CLI watch to release any new foreground use of the selected listener.
  return !Object.entries(after.Foreground ?? {}).some(([key, value]) => !Object.hasOwn(before.Foreground ?? {}, key) && usesListener(value, 443));
}

async function jsonResponse(response) {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); throw new Error("non-json-mcp-response"); }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024 * 1024) throw new Error("mcp-response-limit");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function probeLocalMcp(endpoint, { timeoutMs = 5_000 } = {}) {
  if (!endpoint) return { state: "not-checked", reason: "unsupported-local-endpoint", observedAt: timestamp() };
  const signal = AbortSignal.timeout(timeoutMs);
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  const url = new URL(endpoint.mcpPath, `http://${host}:${endpoint.port}`);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(endpoint.bearerToken ? { authorization: `Bearer ${endpoint.bearerToken}` } : {}) };
  let id = 0;
  const post = async (method, params, notification = false) => {
    const requestId = notification ? undefined : ++id;
    const response = await fetch(url, { method: "POST", headers, redirect: "error", signal, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: requestId }), method, ...(params ? { params } : {}) }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? "mcp-auth-rejected" : "mcp-http-failed"); }
    if (notification) { await response.body?.cancel(); return; }
    const parsed = rpcSchema.safeParse(await jsonResponse(response));
    if (!parsed.success || parsed.data.id !== requestId) throw new Error("invalid-mcp-response");
    const result = parsed.data;
    const session = response.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    return result.result;
  };
  try {
    const initialized = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "portus-tailscale-status", version: "1" } });
    if (!initializeSchema.safeParse(initialized).success) throw new Error("unexpected-mcp-server");
    headers["mcp-protocol-version"] = initialized.protocolVersion;
    await post("notifications/initialized", undefined, true);
    const listed = await post("tools/list");
    if (!discoverySchema.safeParse(listed).success) throw new Error("invalid-tool-discovery");
    return { state: "verified", protocolVersion: initialized.protocolVersion, toolCount: listed.tools.length, observedAt: timestamp() };
  } catch (error) {
    const known = ["non-json-mcp-response", "mcp-response-limit", "mcp-auth-rejected", "mcp-http-failed", "invalid-mcp-response", "unexpected-mcp-server", "invalid-tool-discovery"];
    return { state: "failed", reason: signal.aborted ? "local-probe-timeout" : known.includes(error.message) ? error.message : "local-mcp-unreachable-or-invalid", observedAt: timestamp() };
  }
}

export async function collectTailscaleStatus({ env = process.env, execute = runTailscaleCommand, probe = probeLocalMcp } = {}) {
  let endpoint;
  try { endpoint = tailscaleEndpoint(env); } catch { /* Unsupported binds are not probed with credentials. */ }
  const binary = resolveTailscalePath(env);
  const [statusCommand, configCommand, local] = await Promise.all([
    execute(binary, ["status", "--json"], { env }),
    execute(binary, ["serve", "status", "--json"], { env }),
    probe(endpoint)
  ]);
  const daemon = inspectDaemon(statusCommand);
  let route;
  if (!endpoint) route = { state: "unknown", reason: "unsupported-local-endpoint" };
  else if (configCommand.state !== "ok") route = { state: "unknown", reason: configCommand.reason };
  else route = inspectTailscaleConfig(configCommand.value, { ...endpoint, hostname: daemon.hostname });
  return {
    observedAt: timestamp(),
    authentication: env.PORTUS_MCP_BEARER_TOKEN?.trim() ? "configured" : "unconfigured",
    daemon,
    route: { ...route, observedAt: configCommand.observedAt },
    local,
    public: { state: "not-checked", reason: "requires-outside-tailnet-probe", observedAt: timestamp() }
  };
}

export function tailscaleStatusExitCode(status) {
  return status.daemon.state === "connected" && status.route.state === "configured" && status.local.state === "verified" ? 0 : 1;
}

export function tailscaleStatusSummary(status) {
  return `Daemon: ${status.daemon.state}${status.daemon.backendState ? ` (${status.daemon.backendState})` : ""}${status.daemon.reason ? ` [${status.daemon.reason}]` : ""}; Portus route: ${status.route.state}${status.route.exposure ? `/${status.route.exposure}/${status.route.scope}` : ""}${status.route.reason ? ` [${status.route.reason}]` : ""}; ownership: not verified; local MCP: ${status.local.state}${status.local.reason ? ` [${status.local.reason}]` : ""}; public MCP: not checked.`;
}

// Only fixed diagnostic categories leave this boundary. Raw output never becomes a log,
// including verbose mode: an arbitrary CLI line can contain unlabelled credentials.
export function monitorTailscaleProcess(proc, { report, verbose = false, onAnnounced } = {}) {
  const reported = new Set();
  let announced = false;
  function emit(category, message) {
    if (reported.size >= 16 || reported.has(category)) return;
    reported.add(category);
    report(message);
  }
  function line(text) {
    if (/log.?in|authenticat|logged out|key.*expir/i.test(text)) emit("auth", "Tailscale requires authentication or an access-key check; no login was attempted.");
    else if (/permission|denied|forbidden|not allowed/i.test(text)) emit("policy", "Tailscale reported an access/policy denial; inspect Funnel permissions.");
    else if (/tailscaled.*(?:unavailable|not running)|failed to connect|tailscale is starting|backend.*(?:NoState|Stopped)/i.test(text)) emit("daemon", "Tailscale daemon is unavailable or not ready; inspect daemon status.");
    else if (/already.*(?:use|serv)|address.*use|conflict/i.test(text)) emit("conflict", "Tailscale reported a listener/configuration conflict; no route ownership is established.");
    else if (/certificate|\bTLS\b|\bHTTPS.*fail/i.test(text)) emit("tls", "Tailscale reported a TLS/certificate diagnostic; public TLS is not verified.");
    else if (/connection refused|backend.*(?:fail|unreach)/i.test(text)) emit("backend", "Tailscale reported an unreachable backend; verify local MCP separately.");
    else if (/error|fail|cannot|unable|fatal/i.test(text)) emit("error", "Tailscale reported a CLI error; raw details were withheld to protect credentials and paths.");
    else if (/available on|https:\/\//i.test(text)) {
      if (!announced) { announced = true; onAnnounced?.(); }
    }
    else if (verbose && text.trim()) emit("other", "Tailscale produced additional output; raw identifiers and paths were withheld.");
  }
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let discarding = false;
    const consume = (text) => {
      for (const part of text.split(/(?<=\n)/)) {
        if (!discarding) {
          pending += part.slice(0, Math.max(0, 4096 - pending.length));
          if (pending.length === 4096) { line(pending); pending = ""; discarding = true; }
        }
        if (part.endsWith("\n")) { if (!discarding) line(pending); pending = ""; discarding = false; }
      }
    };
    stream.on("data", (chunk) => consume(decoder.write(chunk)));
    stream.on("end", () => { consume(decoder.end()); if (pending) line(pending); });
  }
  proc.once("error", (error) => emit("spawn-error", `Tailscale CLI could not start [${["ENOENT", "EACCES", "EPERM"].includes(error.code) ? error.code : "spawn-error"}]; check the configured binary.`));
  proc.once("close", (code, signal) => emit("closed", `Tailscale CLI closed (${code === null ? "signal" : `exit ${code}`}${signal ? ", signalled" : ""}); no automatic recovery was attempted.`));
}
