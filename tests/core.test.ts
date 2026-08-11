import { optionalEnv } from "../src/env.js";
import { runProjectCommand } from "../src/runtime/commands.js";
import { assertProjectCommandStaysInProject, commandRequiresConfirmation } from "../src/tools/projects.js";
import { toPublicAuditEvent, type PublicAuditEvent } from "../src/tools/config.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = mkdtempSync(path.join(process.cwd(), ".portus-core-test-"));
const stateDir = path.join(root, "state");
const projectRoot = path.join(root, "project");
const configPath = path.join(root, "config.json");
const dotenvPath = path.join(root, "missing.env");
after(() => rmSync(root, { recursive: true, force: true }));


mkdirSync(projectRoot, { recursive: true });
writeFileSync(path.join(projectRoot, "README.md"), "# Test\n", "utf8");
writeFileSync(path.join(projectRoot, ".env"), "SECRET=hidden\n", "utf8");
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
delete process.env.PORTUS_MCP_POLICY_PATH;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_DEFAULT_PROVIDER = "cerebras";
process.env.PORTUS_MCP_CEREBRAS_MODEL = "llama3.1-8b";
process.env.CEREBRAS_API_KEY = "test-key";

// Stateful modules are loaded only after this test installs its isolated environment paths.
const { loadAgentProviderConfig } = await import("../src/config.js");
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { resolveProjectPath } = await import("../src/policy/pathPolicy.js");
const { assertMainAgentPermission, assertMainAgentCommandAllowed } = await import("../src/policy/permissionPolicy.js");
const { loadPolicyConfig, parsePolicyConfig, policyPermissions } = await import("../src/policy/policyConfig.js");

upsertProject({ projectAlias: "test", rootPath: projectRoot });
const selectedPolicy = loadPolicyConfig();
const withMainAgentPermissions = (
  permissions: Partial<typeof selectedPolicy.main_agent.permissions>
): typeof selectedPolicy => ({
  ...selectedPolicy,
  main_agent: {
    permissions: { ...selectedPolicy.main_agent.permissions, ...permissions }
  }
});

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
}


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

test("permission policy evaluates complete immutable policy objects", () => {
  const deniedPolicy = withMainAgentPermissions({ projectEdit: false });
  assert.throws(() => assertMainAgentPermission("projectEdit", deniedPolicy), /Permission denied/);
  assert.doesNotThrow(() => assertMainAgentPermission("projectEdit", selectedPolicy));
  assert.equal(policyPermissions(deniedPolicy).main_agent.projectEdit, false);
  assert.equal(policyPermissions(selectedPolicy).main_agent.projectEdit, true);
});

test("complete policy validation rejects every formerly defaulted field when omitted", () => {
  const incompletePolicies: Array<{ path: string; value: unknown }> = [
    {
      path: "main_agent.permissions.requireConfirmation",
      value: {
        ...selectedPolicy,
        main_agent: {
          permissions: withoutKey(selectedPolicy.main_agent.permissions, "requireConfirmation")
        }
      }
    },
    {
      path: "main_agent.permissions.allowShell",
      value: {
        ...selectedPolicy,
        main_agent: {
          permissions: withoutKey(selectedPolicy.main_agent.permissions, "allowShell")
        }
      }
    },
    {
      path: "limits.search.maxRegexExecutionMs",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          search: withoutKey(selectedPolicy.limits.search, "maxRegexExecutionMs")
        }
      }
    },
    {
      path: "limits.search.maxBatchMatches",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          search: withoutKey(selectedPolicy.limits.search, "maxBatchMatches")
        }
      }
    },
    {
      path: "limits.search.maxBatchOutputChars",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          search: withoutKey(selectedPolicy.limits.search, "maxBatchOutputChars")
        }
      }
    },
    {
      path: "limits.process.maxBatchOutputChars",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          process: withoutKey(selectedPolicy.limits.process, "maxBatchOutputChars")
        }
      }
    }
  ];

  for (const incomplete of incompletePolicies) {
    assert.throws(
      () => parsePolicyConfig(incomplete.value),
      new RegExp(incomplete.path.replaceAll(".", "\\."))
    );
  }
});

test("requireConfirmation comes exclusively from the supplied policy", () => {
  const requiredPolicy = withMainAgentPermissions({ requireConfirmation: true });
  const optionalPolicy = withMainAgentPermissions({ requireConfirmation: false });
  assert.equal(policyPermissions(requiredPolicy).main_agent.requireConfirmation, true);
  assert.equal(policyPermissions(optionalPolicy).main_agent.requireConfirmation, false);
});

test("allowShell comes exclusively from the supplied policy", () => {
  const deniedPolicy = withMainAgentPermissions({ allowShell: false });
  const allowedPolicy = withMainAgentPermissions({ allowShell: true });
  assert.equal(policyPermissions(deniedPolicy).main_agent.allowShell, false);
  assert.equal(policyPermissions(allowedPolicy).main_agent.allowShell, true);
});

test("Native argv execution: direct command receives literal metacharacters without shell parsing", async () => {
  const metaArg = "patternA\\|patternB\\|patternC";
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log(process.argv[1])", metaArg], 10, false);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), metaArg);
});

test("shell=true is rejected when selected policy disables shell execution", async () => {
  const deniedPolicy = withMainAgentPermissions({ allowShell: false });
  await assert.rejects(
    async () => runProjectCommand(projectRoot, "node", ["-e", "console.log(1)"], 10, true, deniedPolicy),
    /Permission denied: main_agent.allowShell is false/
  );
});

test("shell=true executes when selected policy enables shell execution", async () => {
  const allowedPolicy = withMainAgentPermissions({ allowShell: true });
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log('shell_ok')"], 10, true, allowedPolicy);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /shell_ok/);
});

test("assertMainAgentCommandAllowed normalizes executable suffixes against supplied policy", () => {
  const commandPolicy = withMainAgentPermissions({ allowedCommands: ["git", "modal-cli"] });
  assert.doesNotThrow(() => assertMainAgentCommandAllowed("git", commandPolicy));
  assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli", commandPolicy));
  if (process.platform === "win32") {
    assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli.bat", commandPolicy));
    assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli.cmd", commandPolicy));
    assert.doesNotThrow(() => assertMainAgentCommandAllowed("modal-cli.exe", commandPolicy));
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


