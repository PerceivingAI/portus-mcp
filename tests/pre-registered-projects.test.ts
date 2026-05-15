import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-pre-reg-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const secondProjectRoot = path.join(root, "project-two");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");

mkdirSync(projectRoot, { recursive: true });
mkdirSync(secondProjectRoot, { recursive: true });
writeFileSync(policyPath, JSON.stringify({
  agents: {
    maxConcurrent: 4,
    maxConcurrentPerProject: 2,
    queueEnabled: false,
    maxQueueDepth: 10,
    queuedTaskTtlSecs: 300,
    projectLockTimeoutSecs: 1800,
    maxRuntimeSecs: 900,
    networkAccess: true,
    grantCommands: true,
    gitCommand: true,
    packageManagerCommand: false,
    nodeCommand: false
  },
  chatgpt: {
    registerProjects: false,
    updatePermissions: false,
    spawnAgents: true,
    readFiles: true,
    writeFiles: true,
    moveFiles: false,
    deleteFiles: false,
    readGitIgnoredFiles: false,
    runPackageScripts: false,
    gitCommands: true
  },
  output: {
    maxStdoutBytes: 200000,
    maxStderrBytes: 200000
  },
  input: {
    maxWriteBytes: 1000000,
    maxPatchBytes: 1000000,
    maxTextOperationBytes: 200000,
    maxSearchOrMarkerBytes: 20000
  },
  audit: {
    strictMode: false
  }
}, null, 2), "utf8");
writeFileSync(configPath, JSON.stringify({
  projects: { allowedRootMode: "registered-only" },
  agents: {
    defaultTemplate: "ephemeral-project-agent",
    allowPersistentSessions: false,
    useFlueCli: true,
    retry: {
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 1500,
      maxDelayMs: 15000,
      jitterRatio: 0.2,
      retryOn: ["provider_rate_limited", "network_transient", "flue_startup_hang"],
      respectRetryAfter: true,
      maxRetryWindowSecs: 60
    }
  },
  blockedPathPatterns: [".env"],
  skills: { directory: "skills" }
}, null, 2), "utf8");

process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_PROJECTS = `pre=${projectRoot};second=${secondProjectRoot}`;

const { listProjects } = await import("../src/state/ProjectRegistry.js");

test("pre-registered projects env is loaded into project registry list", () => {
  const projects = listProjects();
  assert.equal(projects.some((item) => item.projectAlias === "pre"), true);
  assert.equal(projects.some((item) => item.projectAlias === "second"), true);
});
