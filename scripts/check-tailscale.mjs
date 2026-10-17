import "dotenv/config";
import { collectTailscaleStatus, tailscaleStatusExitCode, tailscaleStatusSummary } from "./tailscale.mjs";

const status = await collectTailscaleStatus();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log("Portus MCP - Tailscale observations");
  console.log(`Observed at: ${status.observedAt}`);
  console.log(`Authentication: ${status.authentication === "configured" ? "Bearer configured; client compatibility not verified" : "No bearer configured; do not publish action-capable tools"}`);
  console.log(tailscaleStatusSummary(status));
  if (status.route.state === "configured") {
    console.log(`Configured MCP URL: ${status.route.url}`);
    console.log(`Listener scope: ${status.route.scope}; configuration does not prove process/route ownership.`);
  }
  console.log(`Daemon observation: ${status.daemon.observedAt}`);
  console.log(`Route observation: ${status.route.observedAt}`);
  console.log(`Local MCP observation: ${status.local.observedAt}`);
  console.log("Public MCP was not probed. Verification requires an authenticated request from outside the tailnet.");
}
process.exitCode = tailscaleStatusExitCode(status);
