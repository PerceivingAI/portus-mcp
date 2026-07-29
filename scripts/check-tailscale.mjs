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

const hasAuth = Boolean(process.env.PORTUS_MCP_BEARER_TOKEN?.trim());

console.log("==================================================");
console.log("  Portus MCP - Tailscale Status Summary");
console.log("==================================================");
console.log(`Portus Bind Address:  ${host}:${port}`);
console.log(`MCP Route:            ${mcpPath}`);
console.log(`Authentication:       ${hasAuth ? "Required (Bearer Token set)" : "Disabled (No-Auth flow)"}`);

if (!tailscaleInstalled) {
  console.log("Tailscale Status:     CLI not found or disabled");
  console.log("Exposure Mode:        LOCAL LOOPBACK ONLY");
  console.log("Public Exposure:      No");
  console.log("Identity Headers:     N/A (Local loopback)");
} else if (!isConnected) {
  console.log("Tailscale Status:     Disconnected or logging in");
  console.log("Exposure Mode:        LOCAL LOOPBACK ONLY");
  console.log("Public Exposure:      No");
  console.log("Identity Headers:     N/A (Disconnected)");
} else if (serveMode === "funnel") {
  console.log(`Tailscale Status:     Connected (${dnsName || "Tailnet Node"})`);
  console.log("Exposure Mode:        PUBLIC FUNNEL (tailscale funnel)");
  console.log("Public Exposure:      YES (Accessible from public internet)");
  console.log("Identity Headers:     None (Funnel traffic carries no Tailnet identity)");
  if (dnsName) {
    console.log(`Target MCP URL:       https://${dnsName}${mcpPath}`);
  }
  console.log(`External Readiness:   Funnel active. ${hasAuth ? "Bearer token set." : "WARN: Bearer token unconfigured."} Verify external reachability before adding URL to Perplexity.`);
} else if (serveMode === "serve") {
  console.log(`Tailscale Status:     Connected (${dnsName || "Tailnet Node"})`);
  console.log("Exposure Mode:        PRIVATE TAILNET MESH (tailscale serve)");
  console.log("Public Exposure:      No (Restricted to devices on your Tailnet)");
  console.log("Identity Headers:     Expected (Tailscale-User-Login injected)");
  if (dnsName) {
    console.log(`Target MCP URL:       https://${dnsName}${mcpPath}`);
  }
  console.log("External Readiness:   READY for private Tailnet devices (Codex, Cursor, laptops)");
} else {
  console.log(`Tailscale Status:     Connected (${dnsName || "Tailnet Node"})`);
  console.log("Exposure Mode:        LOCAL LOOPBACK ONLY");
  console.log("Public Exposure:      No");
  console.log("Identity Headers:     N/A (Local loopback)");
  if (dnsName) {
    console.log("\nQuick Exposure Commands:");
    console.log(`  • Private Tailnet Mesh: tailscale serve ${port}  (npm run start:serve)`);
    console.log(`  • Public Funnel:       tailscale funnel ${port} (npm run start:funnel)`);
    console.log(`  • Target URL will be:  https://${dnsName}${mcpPath}`);
  }
}
console.log("==================================================");
