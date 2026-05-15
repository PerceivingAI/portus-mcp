import { spawn } from "node:child_process";
import path from "node:path";

const port = process.env.PORTUS_MCP_PORT ?? "8789";
const url = `http://localhost:${port}/`;

const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
const command = process.execPath;
const args = [tsxCli, "src/server.ts"];
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const deadline = Date.now() + 15_000;

try {
  let response;
  while (Date.now() < deadline) {
    try {
      response = await fetch(url);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!response) {
    throw new Error(`Server did not respond at ${url}\n${output}`);
  }

  if (!response.ok) {
    throw new Error(`Health route returned ${response.status}`);
  }

  const body = await response.json();
  if (body.name !== "portus-mcp" || body.mcp !== "/mcp" || body.status !== "ok") {
    throw new Error(`Unexpected health payload: ${JSON.stringify(body)}`);
  }

  console.log(`Health check passed: ${url}`);
} finally {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

