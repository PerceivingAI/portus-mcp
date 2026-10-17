import "dotenv/config";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveTailscalePath, runTailscaleCommand, inspectDaemon, monitorTailscaleProcess,
  validateTailscaleBind, assertTailscaleListenerFree, findOwnedTailscaleRoute, tailscaleForegroundReleased
} from "./tailscale.mjs";

export function shouldForwardExternalLogs(env = process.env) {
  const value = env.PORTUS_MCP_FORWARD_EXTERNAL_LOGS;
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}


function resolveTunnelClientPath(env = process.env) {
  if (env.PORTUS_TUNNEL_CLIENT_PATH && existsSync(env.PORTUS_TUNNEL_CLIENT_PATH)) {
    return env.PORTUS_TUNNEL_CLIENT_PATH;
  }

  const isWin = os.platform() === "win32";
  const exeName = isWin ? "tunnel-client.exe" : "tunnel-client";

  try {
    const checkCmd = isWin ? `where ${exeName}` : `which ${exeName}`;
    const found = execSync(checkCmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) return found;
  } catch {
    // Not in system PATH
  }

  const searchLocations = [
    isWin ? "C:\\tools\\tunnel-client\\tunnel-client.exe" : "/usr/local/bin/tunnel-client",
    path.join(os.homedir(), "tools", "tunnel-client", exeName),
    path.join(os.homedir(), "tools", exeName),
    path.join(os.homedir(), ".local", "bin", exeName),
    path.join(os.homedir(), "bin", exeName)
  ];

  for (const candidate of searchLocations) {
    if (existsSync(candidate)) return candidate;
  }

  return exeName;
}
function resolveProfileDir(env, profile) {
  if (env.TUNNEL_CLIENT_PROFILE_DIR && existsSync(env.TUNNEL_CLIENT_PROFILE_DIR)) {
    return env.TUNNEL_CLIENT_PROFILE_DIR;
  }
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "tunnel-client"),
    path.join(os.homedir(), ".config", "tunnel-client"),
    path.join(os.homedir(), ".tunnel-client")
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, `${profile}.yaml`))) {
      return dir;
    }
  }
  return candidates[0];
}


function log(prefix, colorCode, data) {
  const lines = data.toString().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    console.log(`\x1b[${colorCode}m[${prefix}]\x1b[0m ${line}`);
  }
}

export function startProcess(name, colorCode, command, args, {
  env = process.env,
  forwardOutput = true,
  tailscaleDiagnostics = false,
  onAnnounced,
  ipc = false,
  processGroup = false
} = {}) {
  const output = forwardOutput || tailscaleDiagnostics ? "pipe" : "ignore";
  const stdio = ["ignore", output, output];
  if (ipc) stdio.push("ipc");
  const proc = spawn(command, args, { stdio, env, detached: processGroup && os.platform() !== "win32" });

  if (tailscaleDiagnostics) {
    monitorTailscaleProcess(proc, { report: (message) => log(name, colorCode, message), verbose: forwardOutput, onAnnounced });
  } else if (forwardOutput) {
    proc.stdout.on("data", (data) => log(name, colorCode, data));
    proc.stderr.on("data", (data) => log(name, colorCode, data));
  }

  proc.on("error", (err) => {
    if (tailscaleDiagnostics) return;
    log(name, "31", `Failed to start: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    if (tailscaleDiagnostics) return;
    if (code !== null && code !== 0) {
      log(name, "31", `Exited with code ${code}`);
    } else if (signal) {
      log(name, "33", `Killed by signal ${signal}`);
    }
  });

  return proc;
}

export async function waitForMcpReady({
  url,
  bearerToken = "",
  timeoutMs = 30_000,
  child,
  bindHost,
  signal
}) {
  const endpoint = url instanceof URL ? url : new URL(url);
  const deadline = Date.now() + timeoutMs;
  if (!child?.channel) throw new Error("Readiness requires the owned backend's private IPC channel; a responding port is not ownership.");
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onMessage = (message) => {
      if (!message || typeof message !== "object" || message.type !== "portus-mcp:listening") return;
      if (typeof message.pid !== "number" || message.pid !== child.pid || message.host !== (bindHost ?? endpoint.hostname.replace(/^\[|\]$/g, "")) || message.port !== Number(endpoint.port || 80) || message.mcpPath !== endpoint.pathname) {
        finish(new Error("Owned backend reported a different bound endpoint; refusing to start exposure."));
      } else finish();
    };
    const onError = () => finish(new Error("Owned Portus backend failed to spawn."));
    const onExit = (code) => finish(new Error(`Owned Portus backend exited before readiness (${code ?? "signal"}); the port may already be occupied.`));
    const onDisconnect = () => finish(new Error("Owned backend disconnected before acknowledging its listener."));
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Owned Portus backend did not acknowledge readiness within the startup deadline.")), timeoutMs);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode);
  });
  signal?.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Owned backend startup deadline exceeded.");
  const probeSignal = AbortSignal.any([AbortSignal.timeout(Math.min(5_000, remaining)), ...(signal ? [signal] : [])]);
  const response = await fetch(endpoint, {
    headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : undefined,
    redirect: "error",
    signal: probeSignal
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Owned backend readiness returned HTTP ${response.status}.`);
  }
  const body = await response.json();
  if (body?.name !== "portus-mcp" || body?.status !== "ok" || child.exitCode !== null || child.signalCode !== null) throw new Error("Owned backend readiness was not confirmed.");
}

async function withinDeadline(promise, deadline, description) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${description} deadline exceeded.`);
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} deadline exceeded.`)), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

async function terminateOwnedTree(proc, deadline) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = new Promise((resolve) => proc.once("close", resolve));
  if (os.platform() === "win32") {
    const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const killed = new Promise((resolve, reject) => {
      killer.once("error", () => reject(new Error("Unable to start owned Windows process-tree teardown.")));
      killer.once("close", resolve);
    });
    const code = await withinDeadline(killed, deadline, "Windows process-tree teardown");
    if (code !== 0 && proc.exitCode === null && proc.signalCode === null) throw new Error("Owned Windows process-tree teardown failed.");
  } else {
    // Launcher-owned processes have their own process group on POSIX.
    try { process.kill(-proc.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await withinDeadline(closed, deadline, "Owned process exit");
}

export function createStandaloneLauncher({
  mode = "tunnel",
  env = process.env,
  executeTailscale = runTailscaleCommand,
  launchTailscale
} = {}) {
  const children = [];
  const controller = new AbortController();
  const host = env.PORTUS_MCP_HOST || "127.0.0.1";
  const port = env.PORTUS_MCP_PORT || "8789";
  const mcpPath = env.PORTUS_MCP_PATH || "/mcp";
  const profile = env.PORTUS_TUNNEL_PROFILE || "portus-local";
  const forwardExternalLogs = shouldForwardExternalLogs(env);
  const isTailscale = mode === "funnel" || mode === "serve";
  let binary;
  let baseline;
  let lease;
  let external;
  let hostname;
  let stopPromise;
  let startCalled = false;

  async function readConfig(deadline, signal) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Tailscale configuration observation deadline exceeded.");
    const command = await executeTailscale(binary, ["serve", "status", "--json"], { env, timeoutMs: Math.min(5_000, remaining), signal });
    signal?.throwIfAborted();
    if (command.state !== "ok") throw new Error(`Tailscale configuration is unknown [${command.reason}]; no route ownership claim is possible.`);
    return command.value;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    controller.abort(new DOMException("Launcher shutdown requested.", "AbortError"));
    stopPromise = (async () => {
      const deadline = Date.now() + 5_000;
      // Invoke every owned teardown even if one fails. Never enumerate/kill borrowed processes.
      const outcomes = await Promise.allSettled(children.map((proc) => terminateOwnedTree(proc, deadline)));
      const failure = outcomes.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      if (external && baseline) {
        while (Date.now() < deadline) {
          const current = await readConfig(deadline);
          if (tailscaleForegroundReleased(baseline, current, lease?.session)) return;
          await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        }
        throw new Error("Owned foreground route release was not confirmed within the teardown deadline; no reset/off was attempted.");
      }
    })();
    return stopPromise;
  }

  async function start() {
    if (startCalled) throw new Error("This standalone launcher already started; it will not adopt or duplicate a backend.");
    startCalled = true;
    try {
      controller.signal.throwIfAborted();
      if (!["tunnel", "serve", "funnel"].includes(mode)) throw new Error("Unsupported standalone launcher mode.");
      if (isTailscale) {
        validateTailscaleBind(env);
        binary = resolveTailscalePath(env);
        const preflightDeadline = Date.now() + 5_000;
        const [status, config] = await Promise.all([
          executeTailscale(binary, ["status", "--json"], { env, timeoutMs: 5_000, signal: controller.signal }),
          readConfig(preflightDeadline, controller.signal)
        ]);
        controller.signal.throwIfAborted();
        const daemon = inspectDaemon(status);
        if (daemon.state !== "connected") throw new Error(`Tailscale daemon is ${daemon.state}; establish connectivity separately before standalone exposure.`);
        baseline = assertTailscaleListenerFree(config);
        hostname = daemon.hostname;
      }

      const backend = startProcess("portus", "36", process.execPath, ["--import", "tsx", "src/server.ts"], { env, ipc: true, processGroup: true });
      children.push(backend);
      const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
      const urlHost = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
      await waitForMcpReady({
        url: new URL(mcpPath, `http://${urlHost}:${port}`),
        bearerToken: env.PORTUS_MCP_BEARER_TOKEN?.trim() ?? "",
        bindHost: host, child: backend, signal: controller.signal
      });
      controller.signal.throwIfAborted();
      log("orchestrator", "32", "Owned Portus backend bound its listener and passed local readiness.");

      if (mode === "tunnel") {
        const tunnelEnv = { ...env, TUNNEL_CLIENT_PROFILE_DIR: resolveProfileDir(env, profile) };
        external = startProcess("tunnel", "32", resolveTunnelClientPath(env), ["run", "--profile", profile], { env: tunnelEnv, forwardOutput: forwardExternalLogs, processGroup: true });
        children.push(external);
        return { backend, external };
      }

      // Recheck immediately before configuring: a port being free during the initial
      // preflight is not permission to replace a listener created while Portus started.
      const current = await readConfig(Date.now() + 5_000, controller.signal);
      baseline = assertTailscaleListenerFree(current);
      const color = mode === "funnel" ? "33" : "34";
      const options = { env, forwardOutput: forwardExternalLogs, tailscaleDiagnostics: true, processGroup: true };
      external = launchTailscale
        ? launchTailscale(binary, [mode, port], options)
        : startProcess(mode, color, binary, [mode, port], options);
      children.push(external);
      let spawnFailure = false;
      const onError = () => { spawnFailure = true; };
      external.on("error", onError);
      const routeDeadline = Date.now() + 30_000;
      try {
        while (Date.now() < routeDeadline) {
          controller.signal.throwIfAborted();
          if (spawnFailure || external.exitCode !== null || external.signalCode !== null) throw new Error("Owned Tailscale CLI failed before foreground route readiness.");
          const config = await readConfig(routeDeadline, controller.signal);
          lease = findOwnedTailscaleRoute(baseline, config, { hostname, host, port, mcpPath, mode });
          if (lease) {
            if (spawnFailure || external.exitCode !== null || external.signalCode !== null) throw new Error("Owned Tailscale CLI exited during route confirmation.");
            log(mode, color, "Owned foreground listener 443 configured; public MCP remains unverified.");
            return { backend, external, route: lease.route };
          }
          await delay(100, undefined, { signal: controller.signal });
        }
      } finally { external.off("error", onError); }
      throw new Error("Owned Tailscale foreground route startup deadline exceeded.");
    } catch (error) {
      try { await stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Standalone startup failed and owned cleanup could not be confirmed."); }
      throw error;
    }
  }
  return { start, stop };
}

async function main() {
  const mode = process.argv.find((arg) => arg.startsWith("--"))?.slice(2) || "tunnel";
  const launcher = createStandaloneLauncher({ mode });
  const requestShutdown = () => {
    log("orchestrator", "33", "Stopping owned processes and awaiting bounded teardown.");
    void launcher.stop().catch((error) => { log("orchestrator", "31", error.message); process.exitCode = 1; });
  };
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
  try { await launcher.start(); }
  catch (error) {
    if (error.name !== "AbortError") {
      log("orchestrator", "31", error.message);
      process.exitCode = 1;
    }
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
