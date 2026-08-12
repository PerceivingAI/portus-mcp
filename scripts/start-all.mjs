import "dotenv/config";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const mode = process.argv.find((arg) => arg.startsWith("--"))?.slice(2) || "tunnel";
const host = process.env.PORTUS_MCP_HOST || "127.0.0.1";
const port = process.env.PORTUS_MCP_PORT || "8789";
const mcpPath = process.env.PORTUS_MCP_PATH || "/mcp";
const profile = process.env.PORTUS_TUNNEL_PROFILE || "portus-local";

function resolveTunnelClientPath() {
  if (process.env.PORTUS_TUNNEL_CLIENT_PATH && existsSync(process.env.PORTUS_TUNNEL_CLIENT_PATH)) {
    return process.env.PORTUS_TUNNEL_CLIENT_PATH;
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
function resolveProfileDir() {
  if (process.env.TUNNEL_CLIENT_PROFILE_DIR && existsSync(process.env.TUNNEL_CLIENT_PROFILE_DIR)) {
    return process.env.TUNNEL_CLIENT_PROFILE_DIR;
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
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
function resolveTailscalePath() {
  if (process.env.PORTUS_TAILSCALE_PATH && existsSync(process.env.PORTUS_TAILSCALE_PATH)) {
    return process.env.PORTUS_TAILSCALE_PATH;
  }

  const isWin = os.platform() === "win32";
  const exeName = isWin ? "tailscale.exe" : "tailscale";

  try {
    const checkCmd = isWin ? `where ${exeName}` : `which ${exeName}`;
    const found = execSync(checkCmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) return found;
  } catch {
    // Not in PATH
  }

  const searchLocations = [
    isWin ? "C:\\Program Files\\Tailscale\\tailscale.exe" : "/usr/bin/tailscale",
    "/usr/local/bin/tailscale"
  ];

  for (const candidate of searchLocations) {
    if (existsSync(candidate)) return candidate;
  }

  return exeName;
}

const children = [];

function log(prefix, colorCode, data) {
  const lines = data.toString().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    console.log(`\x1b[${colorCode}m[${prefix}]\x1b[0m ${line}`);
  }
}

function startProcess(name, colorCode, command, args, customEnv = process.env) {
  const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: customEnv });
  children.push(proc);

  proc.stdout.on("data", (data) => log(name, colorCode, data));
  proc.stderr.on("data", (data) => log(name, colorCode, data));

  proc.on("error", (err) => {
    log(name, "31", `Failed to start: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
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
  retryDelayMs = 100,
  child
}) {
  const endpoint = url instanceof URL ? url : new URL(url);
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "endpoint has not responded";
  let childFailure;
  const onChildError = (error) => {
    childFailure = `Portus MCP failed to start: ${error instanceof Error ? error.message : String(error)}`;
  };
  const onChildExit = (code, signal) => {
    childFailure = `Portus MCP exited before readiness${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
  };
  child?.once("error", onChildError);
  child?.once("exit", onChildExit);

  try {
    while (Date.now() < deadline) {
      if (childFailure) throw new Error(childFailure);
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Portus MCP exited before readiness${child.exitCode === null ? "" : ` with code ${child.exitCode}`}${child.signalCode ? ` (${child.signalCode})` : ""}`);
      }

      const remainingMs = deadline - Date.now();
      const controller = new AbortController();
      const probeTimeout = setTimeout(() => controller.abort(), Math.min(1_000, Math.max(1, remainingMs)));
      try {
        const response = await fetch(endpoint, {
          headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : undefined,
          signal: controller.signal
        });
        if (response.ok) {
          const body = await response.json();
          if (body?.name === "portus-mcp" && body?.status === "ok") {
            if (childFailure) throw new Error(childFailure);
            return;
          }
          lastFailure = "endpoint returned an unexpected readiness payload";
        } else {
          await response.text();
          lastFailure = `endpoint returned HTTP ${response.status}`;
        }
      } catch (error) {
        if (childFailure) throw new Error(childFailure);
        lastFailure = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(probeTimeout);
      }

      const delayMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } finally {
    child?.off("error", onChildError);
    child?.off("exit", onChildExit);
  }

  throw new Error(`Timed out waiting for Portus MCP at ${endpoint.href}. Last probe: ${lastFailure}`);
}

function localMcpUrl() {
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const urlHost = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
  return new URL(mcpPath, `http://${urlHost}:${port}/`);
}


let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[orchestrator] Shutting down all processes...");
  for (const proc of children) {
    if (proc.pid) {
      if (os.platform() === "win32") {
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        proc.kill("SIGTERM");
      }
    }
  }
  process.exit(exitCode);
}

async function main() {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  console.log("==================================================");
  console.log(`  Portus MCP Orchestrator (Mode: ${mode})`);
  console.log(`  • Server:  http://${host}:${port}${mcpPath}`);
  if (mode === "tunnel") {
    console.log(`  • Service: OpenAI tunnel-client (Profile: ${profile})`);
  } else if (mode === "funnel") {
    console.log(`  • Service: Tailscale Funnel (Port: ${port})`);
  } else if (mode === "serve") {
    console.log(`  • Service: Tailscale Serve (Port: ${port})`);
  }
  console.log("  Press Ctrl+C to stop all processes cleanly.");
  console.log("==================================================");

  const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
  const portus = startProcess("portus", "36", process.execPath, [tsxCli, "src/server.ts"]);
  try {
    await waitForMcpReady({
      url: localMcpUrl(),
      bearerToken: process.env.PORTUS_MCP_BEARER_TOKEN?.trim() ?? "",
      child: portus
    });
  } catch (error) {
    log("orchestrator", "31", error instanceof Error ? error.message : String(error));
    shutdown(1);
    return;
  }

  log("orchestrator", "32", "Portus MCP is ready; starting the external service.");
  if (mode === "tunnel") {
    const tunnelBin = resolveTunnelClientPath();
    const profileDir = resolveProfileDir();
    const env = { ...process.env, TUNNEL_CLIENT_PROFILE_DIR: profileDir };
    startProcess("tunnel", "32", tunnelBin, ["run", "--profile", profile], env);
  } else if (mode === "funnel") {
    const tailscaleBin = resolveTailscalePath();
    startProcess("funnel", "33", tailscaleBin, ["funnel", port]);
  } else if (mode === "serve") {
    const tailscaleBin = resolveTailscalePath();
    startProcess("serve", "34", tailscaleBin, ["serve", port]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
