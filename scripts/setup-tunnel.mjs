import "dotenv/config";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";

const profile = process.env.PORTUS_TUNNEL_PROFILE || "portus-local";
const host = process.env.PORTUS_MCP_HOST || "127.0.0.1";
const port = process.env.PORTUS_MCP_PORT || "8789";
const mcpPath = process.env.PORTUS_MCP_PATH || "/mcp";
const mcpUrl = `http://${host}:${port}${mcpPath}`;

function openBrowser(url) {
  try {
    const platform = os.platform();
    if (platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
    } else if (platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${url}" >/dev/null 2>&1 &`, { stdio: "ignore", shell: true });
    }
  } catch {
    // Ignore browser open failures
  }
}

async function resolveOrInstallTunnelClient() {
  const isWin = os.platform() === "win32";
  const exeName = isWin ? "tunnel-client.exe" : "tunnel-client";

  if (process.env.PORTUS_TUNNEL_CLIENT_PATH && existsSync(process.env.PORTUS_TUNNEL_CLIENT_PATH)) {
    return process.env.PORTUS_TUNNEL_CLIENT_PATH;
  }

  try {
    const checkCmd = isWin ? `where ${exeName}` : `which ${exeName}`;
    const found = execSync(checkCmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) return found;
  } catch {
    // Not in PATH
  }

  const defaultDir = isWin
    ? "C:\\tools\\tunnel-client"
    : path.join(os.homedir(), ".local", "bin");
  const defaultPath = path.join(defaultDir, exeName);

  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  console.log("tunnel-client not found. Downloading latest release from GitHub...");
  mkdirSync(defaultDir, { recursive: true });

  const releaseRes = await fetch("https://api.github.com/repos/openai/tunnel-client/releases/latest", {
    headers: { "User-Agent": "portus-setup" }
  });
  if (!releaseRes.ok) {
    throw new Error(`Failed to query latest tunnel-client release: ${releaseRes.statusText}`);
  }
  const releaseData = await releaseRes.json();

  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  const osTarget = isWin ? "windows" : os.platform() === "darwin" ? "darwin" : "linux";
  const ext = isWin ? ".zip" : ".tar.gz";

  const asset = releaseData.assets.find(
    (a) => a.name.includes(osTarget) && a.name.includes(arch) && a.name.endsWith(ext)
  );

  if (!asset) {
    throw new Error(`No matching tunnel-client asset found for ${osTarget}-${arch}`);
  }

  console.log(`Downloading ${asset.name}...`);
  const downloadRes = await fetch(asset.browser_download_url);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download ${asset.browser_download_url}`);
  }

  const tempArchive = path.join(defaultDir, `download${ext}`);
  const fileStream = createWriteStream(tempArchive);
  await pipeline(Readable.fromWeb(downloadRes.body), fileStream);

  console.log(`Extracting to ${defaultDir}...`);
  if (isWin) {
    execSync(`powershell.exe -NoProfile -Command "Expand-Archive -Path '${tempArchive}' -DestinationPath '${defaultDir}' -Force"`, { stdio: "inherit" });
  } else {
    execSync(`tar -xzf "${tempArchive}" -C "${defaultDir}"`, { stdio: "inherit" });
    execSync(`chmod +x "${defaultPath}"`);
  }

  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tempArchive);
  } catch {
    // Ignore cleanup error
  }

  return defaultPath;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    console.log("==================================================");
    console.log("  Portus MCP — Tunnel Client Setup Wizard");
    console.log(`  Profile Target: ${profile}`);
    console.log(`  MCP Endpoint:   ${mcpUrl}`);
    console.log("==================================================\n");

    const tunnelExe = await resolveOrInstallTunnelClient();
    console.log(`[✓] tunnel-client located at: ${tunnelExe}\n`);

    // 1. API Key handling
    let currentKey = process.env.CONTROL_PLANE_API_KEY?.trim() || "";
    if (currentKey) {
      const preview = currentKey.slice(0, 8);
      const answer = await rl.question(`Use existing CONTROL_PLANE_API_KEY (${preview}...)? (Y/n): `);
      if (answer.trim().toLowerCase() === "n") {
        currentKey = "";
      }
    }

    if (!currentKey) {
      console.log("\nOpening OpenAI API Keys page...");
      openBrowser("https://platform.openai.com/settings/organization/api-keys");
      while (true) {
        const key = (await rl.question("Enter OpenAI API Key (sk-...): ")).trim();
        if (key.startsWith("sk-")) {
          currentKey = key;
          process.env.CONTROL_PLANE_API_KEY = key;
          if (os.platform() === "win32") {
            try {
              execSync(`powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', '${key}', 'User')"`, { stdio: "ignore" });
            } catch {
              // Ignore persist error
            }
          } else {
            try {
              const envPath = path.resolve(".env");
              if (existsSync(envPath)) {
                let content = readFileSync(envPath, "utf8");
                if (content.includes("CONTROL_PLANE_API_KEY=")) {
                  content = content.replace(/^CONTROL_PLANE_API_KEY=.*$/m, `CONTROL_PLANE_API_KEY=${key}`);
                } else {
                  content += `\nCONTROL_PLANE_API_KEY=${key}\n`;
                }
                writeFileSync(envPath, content, "utf8");
              }
              const bashrc = path.join(os.homedir(), ".bashrc");
              if (existsSync(bashrc)) {
                const bashrcContent = readFileSync(bashrc, "utf8");
                if (!bashrcContent.includes("CONTROL_PLANE_API_KEY")) {
                  appendFileSync(bashrc, `\nexport CONTROL_PLANE_API_KEY="${key}"\n`, "utf8");
                }
              }
            } catch {
              // Ignore persist error
            }
          }
          break;
        }
        console.log("Invalid key: must start with 'sk-'.");
      }
    }

    // 2. Tunnel ID & Notice
    console.log("\n--------------------------------------------------");
    console.log("CRITICAL OPENAI UI NOTICE:");
    console.log("In the OpenAI Platform 'Create tunnel' modal:");
    console.log("• Name and Description are required (*).");
    console.log("• Organizations comes pre-selected.");
    console.log("• 'ChatGPT workspaces' has NO asterisk, but it is MANDATORY.");
    console.log("");
    console.log("If you do not select a workspace from the dropdown,");
    console.log("the ChatGPT plugin modal will NOT list or connect to the tunnel.");
    console.log("--------------------------------------------------\n");

    console.log("Opening OpenAI Tunnels page...");
    openBrowser("https://platform.openai.com/settings/organization/tunnels");

    let tunnelId = "";
    while (true) {
      const id = (await rl.question("Enter Tunnel ID (tunnel_...): ")).trim();
      if (id.startsWith("tunnel_")) {
        tunnelId = id;
        break;
      }
      console.log("Invalid Tunnel ID: must start with 'tunnel_'.");
    }

    // 3. Initialize profile
    console.log(`\nInitializing profile '${profile}' with tunnel ID '${tunnelId}'...`);
    const initResult = spawnSync(tunnelExe, [
      "init",
      "--profile", profile,
      "--tunnel-id", tunnelId,
      "--mcp-server-url", mcpUrl,
      "--health-listen-addr", "127.0.0.1:0",
      "--force"
    ], {
      stdio: "inherit",
      env: { ...process.env, CONTROL_PLANE_API_KEY: currentKey }
    });

    if (initResult.status !== 0) {
      console.error(`\n[!] Failed to initialize profile '${profile}'.`);
      process.exit(1);
    }

    console.log("\n==================================================");
    console.log("  Setup complete!");
    console.log("  To launch Portus MCP with the tunnel, run:");
    console.log("    npm run start:tunnel");
    console.log("==================================================");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
