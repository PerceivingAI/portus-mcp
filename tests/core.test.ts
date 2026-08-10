import { optionalEnv } from "../src/env.js";
import { assertMainAgentCommandAllowed } from "../src/policy/permissionPolicy.js";
import { runProjectCommand } from "../src/runtime/commands.js";
import { assertProjectCommandStaysInProject, commandRequiresConfirmation } from "../src/tools/projects.js";
import { toPublicAuditEvent, type PublicAuditEvent } from "../src/tools/config.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-agents-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const dotenvPath = path.join(root, "missing.env");

mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "# Test\n", "utf8");
writeFileSync(path.join(projectRoot, ".env"), "SECRET=hidden\n", "utf8");
writeFileSync(policyPath, JSON.stringify({
  subagents: {
    concurrency: {
      maxConcurrent: 4,
      maxConcurrentPerProject: 2,
      queueEnabled: false,
      maxQueueDepth: 10,
    },
    lifecycle: {
      queuedTaskTtlSecs: 300,
      projectLockTimeoutSecs: 1800,
      maxRuntimeSecs: 900,
      startupWatchdogMs: 15000,
      forcedCloseGraceMs: 8000,
      killEscalationDelayMs: 1200,
      queueDrainDelayMs: 50,
    },
    permissions: {
      networkAccess: true,
      allowedCommands: ["git"]
    }
  },
  main_agent: {
    permissions: {
      subagentTask: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      readGitIgnoredFiles: false,
      projectPatch: true,
      projectRun: false,
      projectPolicy: true,
      allowedCommands: ["git"]
    }
  },
  pathPolicy: {
    blockedPatterns: [".env"]
  },
  limits: {
    fileRead: {
      maxChars: 500000,
    },
    fileWrite: {
      maxChars: 1000000,
    },
    patch: {
      maxChars: 1000000,
    },
    textEdit: {
      maxOperationChars: 200000,
      maxSearchOrMarkerChars: 20000
    },
    search: {
      maxScanEntries: 100000,
      maxTextFileChars: 200000,
    },
    skills: {
      maxReadChars: 200000,
    },
    subagentOutput: {
      maxStdoutChars: 200000,
      maxStderrChars: 200000,
    },
    sessionEvents: {
      maxEvents: 500,
      maxChunkChars: 4000,
    },
    audit: {
      maxEvents: 1000,
    },
    process: {
      maxOutputBufferMb: 10
    }
  },
  audit: {
    strictMode: false
  }
}, null, 2), "utf8");
writeFileSync(configPath, JSON.stringify({
  subagents: {
    defaultTemplate: "ephemeral-project-subagent",
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
  traversal: {
    excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", ".flue", "coverage", ".next", ".cache"]
  }
}, null, 2), "utf8");

process.env.DOTENV_CONFIG_PATH = dotenvPath;
process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.CEREBRAS_API_KEY = "test-key";

const { loadAgentProviderConfig } = await import("../src/config.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { resolveProjectPath } = await import("../src/policy/pathPolicy.js");
const { assertMainAgentPermission, assertMainAgentCommandAllowed } = await import("../src/policy/permissionPolicy.js");
const { getEffectivePermissions, updatePermissions } = await import("../src/state/PermissionRegistry.js");

upsertProject({ projectAlias: "test", rootPath: projectRoot });
updatePermissions({ projectAlias: "test", permissions: { main_agent: { projectEdit: false } } });

test("provider config resolves default Cerebras model", () => {
  const provider = loadAgentProviderConfig();
  assert.equal(provider.provider, "cerebras");
  assert.equal(provider.model, "cerebras/llama3.1-8b");
});

test("path policy blocks project root escapes", () => {
  assert.throws(() => resolveProjectPath("test", "../outside.txt"), /escapes project root/);
});

test("path policy blocks configured sensitive paths", () => {
  assert.throws(() => resolveProjectPath("test", ".env"), /Blocked path pattern/);
});

test("path policy blocks configured sensitive paths case-insensitively", () => {
  assert.throws(() => resolveProjectPath("test", ".ENV"), /Blocked path pattern/);
});

test("permission policy denies disabled permissions and accepts runtime updates", () => {
  assert.throws(() => assertMainAgentPermission("projectEdit", "test"), /Permission denied/);
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { projectEdit: true } } });
  assert.doesNotThrow(() => assertMainAgentPermission("projectEdit", "test"));
  assert.equal(getEffectivePermissions("test").main_agent.projectEdit, true);
});

test("requireConfirmation accepts runtime updates", () => {
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { requireConfirmation: true } } });
  assert.equal(getEffectivePermissions("test").main_agent.requireConfirmation, true);
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { requireConfirmation: false } } });
  assert.equal(getEffectivePermissions("test").main_agent.requireConfirmation, false);
});

test("allowShell accepts runtime updates", () => {
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { allowShell: false } } });
  assert.equal(getEffectivePermissions("test").main_agent.allowShell, false);
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { allowShell: true } } });
  assert.equal(getEffectivePermissions("test").main_agent.allowShell, true);
});

test("stale useShell configuration or runtime permission is explicitly rejected", () => {
  assert.throws(
    () => updatePermissions({ projectAlias: "test", permissions: { main_agent: { useShell: true } as Record<string, unknown> } }),
    /Unknown main_agent permission: useShell/
  );
});

test("legacy chatgpt permission key is strictly rejected", () => {
  assert.throws(
    () => updatePermissions({ projectAlias: "test", permissions: { chatgpt: { allowShell: true } as Record<string, unknown> } }),
    /Unknown top-level permission: chatgpt/
  );
});

test("Native argv execution: direct command receives literal metacharacters without shell parsing", async () => {
  const metaArg = "patternA\\|patternB\\|patternC";
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log(process.argv[1])", metaArg], 10, undefined, false);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), metaArg);
});

test("shell=true is rejected when allowShell is false", async () => {
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { allowShell: false } } });
  await assert.rejects(
    async () => runProjectCommand(projectRoot, "node", ["-e", "console.log(1)"], 10, "test", true),
    /Permission denied: main_agent.allowShell is false/
  );
});

test("shell=true executes shell syntax when allowShell is true", async () => {
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { allowShell: true } } });
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log('shell_ok')"], 10, "test", true);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /shell_ok/);
});

test("assertMainAgentCommandAllowed resolves base command name on Windows for .bat, .cmd, and .exe", () => {
  updatePermissions({ projectAlias: "test", permissions: { main_agent: { allowedCommands: ["git", "modal-cli"] } } });
  assert.doesNotThrow(() => assertMainAgentCommandAllowed("git", "test"));
  assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli", "test"));
  if (process.platform === "win32") {
    assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli.bat", "test"));
    assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli.cmd", "test"));
    assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli.exe", "test"));
  }
});


test("Process outcome contract: Exit 0 returns outcome=exited, exitCode=0", async () => {
  const result = await runProjectCommand(projectRoot, "node", ["-e", "process.exit(0)"]);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.executionError, null);
});

test("Process outcome contract: Exit 1 with empty stderr returns outcome=exited, exitCode=1, and empty stderr", async () => {
  const result = await runProjectCommand(projectRoot, "node", ["-e", "process.exit(1)"]);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(result.executionError, null);
  assert.equal(result.stderr, "");
});

test("Process outcome contract: Exit 3 with real stderr preserves that stderr exactly", async () => {
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.error('custom error message'); process.exit(3)"]);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.executionError, null);
  assert.equal(result.stderr.trim(), "custom error message");
});

test("Process outcome contract: Missing executable returns outcome=spawn_failed, exitCode=null, and safe execution error", async () => {
  const result = await runProjectCommand(projectRoot, "nonexistent-command-xyz", []);
  assert.equal(result.outcome, "spawn_failed");
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.match(result.executionError ?? "", /nonexistent-command-xyz|ENOENT/i);
  assert.equal(result.stderr, "");
});

test("Process outcome contract: Execution deadline returns outcome=timed_out", async () => {
  const result = await runProjectCommand(projectRoot, "node", ["-e", "setTimeout(() => {}, 10000)"], 1);
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.exitCode, null);
  assert.match(result.executionError ?? "", /timed out/i);
});

test("optionalEnv returns fallback when environment variable is missing, empty, or whitespace", () => {
  delete process.env.TEST_OPTIONAL_VAR;
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "default_val");

  process.env.TEST_OPTIONAL_VAR = "";
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "default_val");

  process.env.TEST_OPTIONAL_VAR = "   ";
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "default_val");

  process.env.TEST_OPTIONAL_VAR = "custom_path.json";
  assert.equal(optionalEnv("TEST_OPTIONAL_VAR", "default_val"), "custom_path.json");

  delete process.env.TEST_OPTIONAL_VAR;
});

test("git.exe -C .. status is rejected by project confinement on all platforms", () => {
  assert.throws(
    () => assertProjectCommandStaysInProject("git.exe", ["-C", "..", "status"]),
    /Git option not allowed/
  );
  assert.throws(
    () => assertProjectCommandStaysInProject("git.exe", ["--git-dir=../.git", "status"]),
    /Git option not allowed/
  );
  assert.throws(
    () => assertProjectCommandStaysInProject("GIT.BAT", ["--work-tree=..", "status"]),
    /Git option not allowed/
  );
  assert.equal(commandRequiresConfirmation("git.exe", ["status"]), false);
  assert.equal(commandRequiresConfirmation("GIT.CMD", ["add", "README.md"]), true);
});

test("project_policy update_permissions accepts allowShell and rejects useShell", () => {
  const updated = updatePermissions({
    projectAlias: "test",
    permissions: { main_agent: { allowShell: true } }
  });
  assert.equal(updated.main_agent.allowShell, true);

  assert.throws(
    () => updatePermissions({ projectAlias: "test", permissions: { main_agent: { useShell: true } as Record<string, unknown> } }),
    /Unknown main_agent permission: useShell/
  );
});

test("Process exceeding maxBuffer returns output_limit outcome", async () => {
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log('x'.repeat(20 * 1024 * 1024))"], 10);
  assert.equal(result.outcome, "output_limit");
  assert.equal(result.exitCode, null);
  assert.match(result.executionError ?? "", /buffer limit/i);
});

test("toPublicAuditEvent preserves batchIndex, executionType, and name from raw audit event", () => {
  const rawEvent = { timestamp: "2026-08-10T00:00:00.000Z", tool: "project_run", batchIndex: 2, type: "script", name: "check", outcome: "exited", exitCode: 0 };
  const publicEvent = toPublicAuditEvent(rawEvent as Record<string, unknown>);
  assert.equal(publicEvent?.batchIndex, 2);
  assert.equal(publicEvent?.executionType, "script");
  assert.equal(publicEvent?.name, "check");
  assert.equal(publicEvent?.outcome, "exited");
});


