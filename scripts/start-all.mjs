import "dotenv/config";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveTailscalePath, runTailscaleCommand, inspectDaemon, monitorTailscaleProcess,
  validateTailscaleBind, assertTailscaleListenerFree, findOwnedTailscaleRoute, tailscaleForegroundReleased,
  tailscaleEndpoint, probeLocalMcp
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
  onDiagnostic,
  recoveryEnabled = false,
  ipc = false,
  processGroup = false,
  expectedExit
} = {}) {
  const output = forwardOutput || tailscaleDiagnostics ? "pipe" : "ignore";
  const stdio = ["ignore", output, output];
  if (ipc) stdio.push("ipc");
  const proc = spawn(command, args, { stdio, env, detached: processGroup && os.platform() !== "win32" });

  if (tailscaleDiagnostics) {
    monitorTailscaleProcess(proc, { report: (message) => log(name, colorCode, message), verbose: forwardOutput, onAnnounced, onDiagnostic, recoveryEnabled });
  } else if (forwardOutput) {
    proc.stdout.on("data", (data) => log(name, colorCode, data));
    proc.stderr.on("data", (data) => log(name, colorCode, data));
  }

  proc.on("error", (err) => {
    if (tailscaleDiagnostics || expectedExit?.()) return;
    log(name, "31", `Failed to start: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    if (tailscaleDiagnostics || expectedExit?.()) return;
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

let exitedTreeHelper;
async function cleanupExitedTree(owner, options) {
  const requestedAt = Date.now();
  exitedTreeHelper ??= import("tsx/esm/api").then(({ tsImport }) => tsImport("../src/runtime/processTermination.ts", import.meta.url)).then((module) => module.cleanupExitedWindowsTree);
  const cleanup = await exitedTreeHelper;
  return cleanup(owner, { timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - requestedAt)) });
}

async function terminateOwnedTree(owner, deadline, cleanupExited) {
  const proc = owner.process;
  if (!proc?.pid) return;
  const closed = owner.closed ? Promise.resolve() : new Promise((resolve) => proc.once("close", resolve));
  const rootExited = proc.exitCode !== null || proc.signalCode !== null;
  if (os.platform() === "win32") {
    let needsDeadRootCleanup = rootExited;
    if (!rootExited) {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const killed = new Promise((resolve, reject) => {
        killer.once("error", () => reject(new Error("Unable to start owned Windows process-tree teardown.")));
        killer.once("close", resolve);
      });
      const code = await withinDeadline(killed, deadline, "Windows process-tree teardown");
      if (code !== 0) {
        if (proc.exitCode === null && proc.signalCode === null) throw new Error("Owned Windows process-tree teardown failed.");
        needsDeadRootCleanup = true;
      }
    }
    if (needsDeadRootCleanup) {
      if (!owner.exitedAtMs) throw new Error("Owned root exit identity is unavailable; descendant cleanup is unverified.");
      const result = await withinDeadline(cleanupExited({
        rootPid: proc.pid, startedAfterMs: owner.startedAtMs, exitedBeforeMs: owner.exitedAtMs
      }, { timeoutMs: Math.max(1, deadline - Date.now()) }), deadline, "Owned exited-root cleanup");
      if (!result.confirmed) throw new Error("Owned exited-root descendant cleanup is unverified.");
    }
  } else {
    // Spawn created a private launcher-owned session/process group. Address that
    // group rather than an individual historical PID, even after its leader exits.
    try { process.kill(-proc.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  await withinDeadline(closed, deadline, "Owned process exit");
}

export function createLauncher({
  mode = "tunnel",
  attachOnly = false,
  env = process.env,
  executeTailscale = runTailscaleCommand,
  launchTailscale,
  launchTunnel,
  cleanupExited = cleanupExitedTree
} = {}) {
  const children = [];
  const controller = new AbortController();
  const host = env.PORTUS_MCP_HOST || "127.0.0.1";
  const port = env.PORTUS_MCP_PORT || "8789";
  const mcpPath = env.PORTUS_MCP_PATH || "/mcp";
  const profile = env.PORTUS_TUNNEL_PROFILE || "portus-local";
  const forwardExternalLogs = shouldForwardExternalLogs(env);
  const isTailscale = mode === "funnel" || mode === "serve";
  const terminalDiagnostics = new Set(["auth", "policy", "configuration", "conflict", "spawn-error"]);
  const recoveryDelays = [1_000, 2_000, 4_000];
  let binary;
  let baseline;
  let external;
  let externalOwner;
  let hostname;
  let stopPromise;
  let startCalled = false;
  let phase = "idle";
  let shutdownStarted = false;
  let failure;
  let failureDetectedAt;
  let recoveryTask;
  let recoveryDeadline;
  let recoveryAttempts = 0;
  let finishCompletion;
  const completion = new Promise((resolve) => { finishCompletion = resolve; });

  function fail(error) {
    if (shutdownStarted) return;
    failure ??= error;
    failureDetectedAt ??= Date.now();
    phase = "failed";
    void stop().catch(() => {}); // Completion carries cleanup failure without an unhandled rejection.
  }

  function track(proc, role, startedAtMs, diagnostics = {}) {
    const owner = { process: proc, role, startedAtMs, exitedAtMs: undefined, closed: false, cleaned: false, controller: new AbortController(), diagnostics };
    children.push(owner);
    if (role === "external") externalOwner = owner;
    proc.once("close", () => { owner.closed = true; });
    proc.once("error", () => {
      const description = role === "backend" ? "Owned Portus backend failed to spawn."
        : isTailscale ? "Owned Tailscale CLI failed before foreground route readiness." : "Owned tunnel service failed to spawn.";
      // Spawn failures are terminal even during recovery; do not retry a bad binary.
      fail(new Error(description));
    });
    proc.once("exit", (code, signal) => {
      owner.exitedAtMs = Date.now();
      const service = role === "backend" ? "Portus backend" : isTailscale ? "Tailscale CLI" : "tunnel service";
      const transition = phase === "starting" ? "exited before readiness" : "exited unexpectedly";
      owner.exitError = new Error(`Owned ${service} ${transition} (${code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`}).`);
      owner.controller.abort(owner.exitError);
      if (shutdownStarted) return;
      if (attachOnly && role === "external" && phase === "running") {
        phase = "recovering";
        recoveryDeadline = owner.exitedAtMs + 30_000;
        recoveryTask = recover(owner, recoveryDeadline).catch((error) => {
          if (!shutdownStarted) fail(error);
        });
      } else if (!(attachOnly && role === "external" && phase === "recovering")) {
        fail(owner.exitError);
      }
    });
    return proc;
  }

  function waitForSpawn(proc) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        proc.off("spawn", onSpawn);
        proc.off("error", onError);
        controller.signal.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      };
      const onSpawn = () => finish();
      const onError = () => finish(failure ?? new Error("Owned external service failed to spawn."));
      const onAbort = () => finish(controller.signal.reason);
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
  }

  async function readConfig(deadline, signal) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Tailscale configuration observation deadline exceeded.");
    const command = await executeTailscale(binary, ["serve", "status", "--json"], { env, timeoutMs: Math.min(5_000, remaining), signal });
    signal?.throwIfAborted();
    if (command.state !== "ok") throw new Error(`Tailscale configuration is unknown [${command.reason}]; no route ownership claim is possible.`);
    return command.value;
  }

  async function preflight(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Tailscale recovery time budget exhausted.");
    const [status, config] = await Promise.all([
      executeTailscale(binary, ["status", "--json"], { env, timeoutMs: Math.min(5_000, remaining), signal: controller.signal }),
      readConfig(deadline, controller.signal)
    ]);
    controller.signal.throwIfAborted();
    const daemon = inspectDaemon(status);
    if (daemon.state !== "connected") throw new Error(`Tailscale daemon is ${daemon.state}; establish connectivity separately before Tailscale exposure.`);
    baseline = assertTailscaleListenerFree(config);
    hostname = daemon.hostname;
  }

  function spawnTailscale() {
    controller.signal.throwIfAborted();
    const diagnostics = {};
    const color = mode === "funnel" ? "33" : "34";
    const options = {
      env, forwardOutput: forwardExternalLogs, tailscaleDiagnostics: true, processGroup: true,
      recoveryEnabled: attachOnly, expectedExit: () => shutdownStarted,
      onDiagnostic: (category) => {
        if (terminalDiagnostics.has(category)) diagnostics.terminal = category;
      }
    };
    const startedAt = Date.now();
    external = track(launchTailscale
      ? launchTailscale(binary, [mode, port], options)
      : startProcess(mode, color, binary, [mode, port], options), "external", startedAt, diagnostics);
    externalOwner.baseline = baseline;
    return externalOwner;
  }

  async function waitForRoute(owner, deadline) {
    const signal = AbortSignal.any([controller.signal, owner.controller.signal]);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const config = await readConfig(deadline, signal);
      signal.throwIfAborted();
      owner.lease = findOwnedTailscaleRoute(owner.baseline, config, { hostname, host, port, mcpPath, mode });
      if (owner.lease) return owner.lease.route;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    throw new Error("Owned Tailscale foreground route startup deadline exceeded.");
  }

  function cleanupOwner(owner, deadline) {
    if (owner.cleaned) return Promise.resolve();
    // One cleanup per exact owned generation, shared by recovery and shutdown.
    // Never issue another tree kill against a historical PID after confirmation.
    owner.cleanupPromise ??= (async () => {
      await terminateOwnedTree(owner, deadline, cleanupExited);
      if (owner.baseline) {
        let released = false;
        while (Date.now() < deadline) {
          const current = await readConfig(deadline);
          if (tailscaleForegroundReleased(owner.baseline, current, owner.lease?.session)) {
            released = true;
            break;
          }
          await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        }
        if (!released) throw new Error("Owned foreground route release was not confirmed within the teardown deadline; no reset/off was attempted.");
      }
      owner.cleaned = true;
    })();
    return owner.cleanupPromise;
  }

  async function recover(previous, deadline) {
    // Reserve final cleanup inside the same 30-second episode, not after it.
    const workDeadline = deadline - 5_000;
    while (true) {
      await cleanupOwner(previous, Math.min(Date.now() + 5_000, deadline));
      controller.signal.throwIfAborted();
      // Cleanup waits for close/stream flush, so even a last unterminated stderr
      // diagnostic is classified before deciding to replace this generation.
      if (previous.diagnostics.terminal) throw new Error(`Tailscale recovery refused a non-retryable ${previous.diagnostics.terminal} diagnostic.`);
      if (recoveryAttempts === recoveryDelays.length) throw new Error("Tailscale recovery exhausted its three replacement attempts.");
      const backoff = recoveryDelays[recoveryAttempts];
      if (Date.now() + backoff >= workDeadline) throw new Error("Tailscale recovery time budget exhausted.");
      await delay(backoff, undefined, { signal: controller.signal });
      controller.signal.throwIfAborted();
      await preflight(workDeadline);
      controller.signal.throwIfAborted();
      if (Date.now() >= workDeadline) throw new Error("Tailscale recovery time budget exhausted.");
      recoveryAttempts++;
      log("orchestrator", "33", `Tailscale ${mode === "funnel" ? "Funnel" : "Serve"} recovery attempt ${recoveryAttempts}/3.`);
      previous = spawnTailscale();
      try {
        await waitForRoute(previous, workDeadline);
        previous.controller.signal.throwIfAborted();
      } catch (error) {
        controller.signal.throwIfAborted();
        if (previous.exitError) continue; // A failed replacement consumes the same episode budget.
        throw error;
      }
      controller.signal.throwIfAborted();
      phase = "running";
      recoveryDeadline = undefined;
      log("orchestrator", "32", `Tailscale ${mode === "funnel" ? "Funnel" : "Serve"} route restored. Press Ctrl+C to stop the companion.`);
      return;
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    shutdownStarted = true;
    if (!failure) phase = "stopping";
    controller.abort(failure ?? new DOMException("Launcher shutdown requested.", "AbortError"));
    const deadline = Math.min(Date.now() + 5_000, recoveryDeadline ?? Infinity);
    stopPromise = (async () => {
      let cleanup = "confirmed";
      let cleanupError;
      try {
        // A cancelled recovery must settle before the final child inventory.
        if (recoveryTask) await withinDeadline(recoveryTask, deadline, "Recovery cancellation");
        const outcomes = await Promise.allSettled(children.map((owner) => cleanupOwner(owner, deadline)));
        const failed = outcomes.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      } catch (error) {
        cleanup = "unverified";
        cleanupError = "Owned cleanup could not be confirmed within its identity and time bounds.";
        failure ??= new Error(cleanupError);
        failureDetectedAt ??= Date.now();
        throw error;
      } finally {
        phase = failure ? "failed" : "stopped";
        finishCompletion(Object.freeze({
          state: phase, exitCode: failure ? 1 : 0, cleanup,
          ...(failure ? { reason: failure.message, failureDetectedAt } : {}),
          ...(cleanupError ? { cleanupError } : {})
        }));
        if (cleanup === "unverified") {
          // Releasing handles is not a claim that unverified processes died.
          for (const { process: proc } of children) {
            proc.stdout?.destroy();
            proc.stderr?.destroy();
            if (proc.connected) { try { proc.disconnect(); } catch {} }
            proc.unref();
          }
        }
      }
    })();
    return stopPromise;
  }

  async function start() {
    if (startCalled) throw new Error("This launcher already started; it will not adopt or duplicate a backend.");
    if (shutdownStarted) throw controller.signal.reason;
    startCalled = true;
    phase = "starting";
    try {
      controller.signal.throwIfAborted();
      if (!["tunnel", "serve", "funnel"].includes(mode)) throw new Error("Unsupported launcher mode.");
      if (attachOnly && !isTailscale) throw new Error("Attach-only operation requires Serve or Funnel; it cannot start tunnel-client.");
      if (isTailscale) {
        validateTailscaleBind(env);
        binary = resolveTailscalePath(env);
        await preflight(Date.now() + 5_000);
      }

      let backend;
      if (attachOnly) {
        const endpoint = tailscaleEndpoint(env);
        const local = await probeLocalMcp(endpoint, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (local.state !== "verified") throw new Error(`Existing Portus backend could not be verified [${local.reason}]; no Tailscale exposure was started.`);
        // Borrowed backend lifetime is deliberately independent of this launcher.
      } else {
        const backendStartedAt = Date.now();
        backend = track(startProcess("portus", "36", process.execPath, ["--import", "tsx", "src/server.ts"], {
          env, ipc: true, processGroup: true, expectedExit: () => shutdownStarted
        }), "backend", backendStartedAt);
        const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
        const urlHost = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
        await waitForMcpReady({
          url: new URL(mcpPath, `http://${urlHost}:${port}`),
          bearerToken: env.PORTUS_MCP_BEARER_TOKEN?.trim() ?? "",
          bindHost: host, child: backend, signal: controller.signal
        });
        controller.signal.throwIfAborted();
        log("orchestrator", "32", "Owned Portus backend bound its listener and passed local readiness.");
      }

      if (mode === "tunnel") {
        const tunnelEnv = { ...env, TUNNEL_CLIENT_PROFILE_DIR: resolveProfileDir(env, profile) };
        const startedAt = Date.now();
        const options = { env: tunnelEnv, forwardOutput: forwardExternalLogs, processGroup: true, expectedExit: () => shutdownStarted };
        external = track(launchTunnel
          ? launchTunnel(resolveTunnelClientPath(env), ["run", "--profile", profile], options)
          : startProcess("tunnel", "32", resolveTunnelClientPath(env), ["run", "--profile", profile], options), "external", startedAt);
        await waitForSpawn(external);
        controller.signal.throwIfAborted();
        phase = "running";
        return { backend, external };
      }

      // Recheck immediately before configuring; initial availability is not ownership.
      baseline = assertTailscaleListenerFree(await readConfig(Date.now() + 5_000, controller.signal));
      const owner = spawnTailscale();
      const route = await waitForRoute(owner, Date.now() + 30_000);
      controller.signal.throwIfAborted();
      phase = "running";
      if (attachOnly) log("orchestrator", "32", `Tailscale ${mode === "funnel" ? "Funnel" : "Serve"} attached to the existing MCP backend. Press Ctrl+C to stop the companion.`);
      return { backend, external, route };
    } catch (error) {
      if (!shutdownStarted) {
        failure ??= error;
        failureDetectedAt ??= Date.now();
        phase = "failed";
      }
      const startupError = failure ?? error;
      try { await stop(); }
      catch (cleanupError) { throw new AggregateError([startupError, cleanupError], "Launcher startup failed and owned cleanup could not be confirmed."); }
      throw startupError;
    }
  }
  return { start, stop, completion, get state() { return phase; }, get recovery() { return recoveryTask; } };
}

async function main() {
  const args = process.argv.slice(2);
  const attachOnly = args.includes("--attach");
  const mode = args.find((arg) => arg !== "--attach" && arg.startsWith("--"))?.slice(2) || "tunnel";
  const host = process.env.PORTUS_MCP_HOST || "127.0.0.1";
  const port = process.env.PORTUS_MCP_PORT || "8789";
  const mcpPath = process.env.PORTUS_MCP_PATH || "/mcp";
  const profile = process.env.PORTUS_TUNNEL_PROFILE || "portus-local";
  const launcher = createLauncher({ mode, attachOnly });
  const requestShutdown = () => {
    log("orchestrator", "33", attachOnly ? "Stopping only the owned Tailscale companion and awaiting bounded teardown." : "Stopping owned processes and awaiting bounded teardown.");
    void launcher.stop().catch(() => {}); // The terminal completion below reports cleanup failure.
  };
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);

  console.log("==================================================");
  console.log(`  Portus MCP Orchestrator (Mode: ${attachOnly ? `attach:${mode}` : mode})`);
  console.log(`  • Server:  http://${host}:${port}${mcpPath}`);
  if (mode === "tunnel") {
    console.log(`  • Service: OpenAI tunnel-client (Profile: ${profile})`);
  } else if (mode === "funnel") {
    console.log(`  • Service: Tailscale Funnel (Port: ${port})`);
  } else if (mode === "serve") {
    console.log(`  • Service: Tailscale Serve (Port: ${port})`);
  }
  console.log(attachOnly ? "  Press Ctrl+C to stop only the Tailscale companion." : "  Press Ctrl+C to stop all processes cleanly.");
  console.log("==================================================");

  try {
    try { await launcher.start(); } catch { /* Startup outcome is preserved in completion. */ }
    const result = await launcher.completion;
    process.exitCode = result.exitCode;
    if (result.state === "failed") log("orchestrator", "31", `Launcher failed: ${result.reason}; owned cleanup: ${result.cleanup}.`);
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
