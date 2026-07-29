import "dotenv/config";
import { execSync } from "node:child_process";

const host = process.env.PORTUS_MCP_HOST || "127.0.0.1";
const port = process.env.PORTUS_MCP_PORT || "8789";
const mcpPath = process.env.PORTUS_MCP_PATH || "/mcp";

let tailscaleInstalled = false;
let isConnected = false;
let dnsName = "";
let serveMode = "none";

try {
  const statusRaw = execSync("tailscale status --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const status = JSON.parse(statusRaw);
  tailscaleInstalled = true;
  if (status.BackendState === "Running" && status.Self) {
    isConnected = true;
    dnsName = (status.Self.DNSName || "").replace(/\.$/, "");
  }
} catch {
  // Tailscale CLI not installed or unavailable
}

if (tailscaleInstalled && isConnected) {
  try {
    const serveRaw = execSync("tailscale serve status --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const serveStatus = JSON.parse(serveRaw);
    const serveStr = JSON.stringify(serveStatus).toLowerCase();
    if (serveStr.includes("funnel") || serveStr.includes("public")) {
      serveMode = "funnel";
    } else if (Object.keys(serveStatus).length > 0 || serveStr.includes(port)) {
      serveMode = "serve";
    }
  } catch {
    // Serve status check unavailable
  }
}

console.log("==================================================");
console.log("  Portus MCP - Tailscale Status Summary");
console.log("==================================================");
console.log(`Portus MCP State: Listening on http://${host}:${port}${mcpPath}`);
console.log(`Configured Path:  ${mcpPath}`);

if (!tailscaleInstalled) {
  console.log("Tailscale Status: CLI not found or disabled");
  console.log("Exposure Mode:    LOCAL LOOPBACK ONLY");
} else if (!isConnected) {
  console.log("Tailscale Status: Disconnected or logging in");
  console.log("Exposure Mode:    LOCAL LOOPBACK ONLY");
} else if (serveMode === "funnel") {
  console.log(`Tailscale Status: Connected (${dnsName || "Tailnet Node"})`);
  console.log("Exposure Mode:    PUBLIC FUNNEL (tailscale funnel)");
  if (dnsName) {
    console.log(`Target URL:       https://${dnsName}${mcpPath}`);
  }
  console.log("Status:           Ready for external cloud connectors (e.g. Perplexity).");
} else if (serveMode === "serve") {
  console.log(`Tailscale Status: Connected (${dnsName || "Tailnet Node"})`);
  console.log("Exposure Mode:    PRIVATE TAILNET MESH (tailscale serve)");
  if (dnsName) {
    console.log(`Target URL:       https://${dnsName}${mcpPath}`);
  }
  console.log("Status:           Ready for private devices on your Tailnet.");
} else {
  console.log(`Tailscale Status: Connected (${dnsName || "Tailnet Node"})`);
  console.log("Exposure Mode:    LOCAL LOOPBACK ONLY");
  if (dnsName) {
    console.log("\nQuick Exposure Commands:");
    console.log(`  • Private Tailnet Mesh: tailscale serve ${port}`);
    console.log(`  • Public Funnel:       tailscale funnel ${port}`);
    console.log(`  • Target URL will be:  https://${dnsName}${mcpPath}`);
  }
}
console.log("==================================================");
