import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadAgentProviderConfig } from "../src/config.js";

let providerConfig;
try {
  providerConfig = loadAgentProviderConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const provider = providerConfig.provider;

const tempRoot = mkdtempSync(path.join(tmpdir(), "portus-flue-smoke-"));
const projectRoot = path.join(tempRoot, "project");
mkdirSync(projectRoot, { recursive: true });

const sessionId = `smoke_${Date.now()}`;
const flueCli = path.resolve(process.env.PORTUS_MCP_FLUE_CLI_PATH ?? path.join(process.cwd(), "node_modules", "@flue", "cli", "dist", "flue.js"));
const agentName = `portus-${sessionId}`;
const projectAgentsDir = path.join(projectRoot, "agents");
mkdirSync(projectAgentsDir, { recursive: true });
copyFileSync(path.join(process.cwd(), "agents", "ephemeral-project-agent.ts"), path.join(projectAgentsDir, `${agentName}.ts`));
const projectNodeModulesDir = path.join(projectRoot, "node_modules");
mkdirSync(projectNodeModulesDir, { recursive: true });
symlinkSync(path.join(process.cwd(), "node_modules", "@flue"), path.join(projectNodeModulesDir, "@flue"), process.platform === "win32" ? "junction" : "dir");

const payload = {
  provider,
  model: providerConfig.model,
  projectRoot,
  task: "Create FLUE_WRITE_TEST.md with a single sentence confirming direct Flue filesystem writes are working."
};

const args = [
  flueCli,
  "run",
  agentName,
  "--target",
  "node",
  "--session-id",
  sessionId,
  "--workspace",
  projectRoot,
  "--output",
  path.join(process.cwd(), ".portus-mcp", "flue-smoke-builds", sessionId),
  "--payload",
  JSON.stringify(payload)
];

const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: process.env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` }));
});

const filePath = path.join(projectRoot, "FLUE_WRITE_TEST.md");
let content = "";
let created = false;
try {
  content = readFileSync(filePath, "utf8");
  created = true;
} catch {
  created = false;
}

if (result.code !== 0 || !created) {
  console.error(JSON.stringify({
    status: "failed",
    sessionId,
    provider,
    model: payload.model,
    projectRoot,
    created,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  }, null, 2));
  rmSync(tempRoot, { recursive: true, force: true });
  process.exit(1);
}

console.log(JSON.stringify({
  status: "passed",
  sessionId,
  provider,
  model: payload.model,
  projectRoot,
  filePath,
  content
}, null, 2));
rmSync(tempRoot, { recursive: true, force: true });

