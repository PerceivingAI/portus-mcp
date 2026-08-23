import { optionalEnv } from "../src/env.js";
import { runProjectCommand } from "../src/runtime/commands.js";
import { collectDescendantPids } from "../src/runtime/processTermination.js";
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
      path: "main_agent.permissions.subagentContext",
      value: {
        ...selectedPolicy,
        main_agent: {
          permissions: withoutKey(selectedPolicy.main_agent.permissions, "subagentContext")
        }
      }
    },
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
      path: "limits.textEdit.maxRangeLines",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          textEdit: withoutKey(selectedPolicy.limits.textEdit, "maxRangeLines")
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
    },
    {
      path: "main_agent.permissions.projectScreenshot",
      value: {
        ...selectedPolicy,
        main_agent: {
          permissions: withoutKey(selectedPolicy.main_agent.permissions, "projectScreenshot")
        }
      }
    },
    {
      path: "limits.screenshot.maxBytes",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          screenshot: withoutKey(selectedPolicy.limits.screenshot, "maxBytes")
        }
      }
    },
    {
      path: "limits.screenshot.windowTokenTtlMs",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          screenshot: withoutKey(selectedPolicy.limits.screenshot, "windowTokenTtlMs")
        }
      }
    },
    {
      path: "limits.screenshot.minJpegQuality",
      value: {
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          screenshot: withoutKey(selectedPolicy.limits.screenshot, "minJpegQuality")
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
test("text-edit range limit rejects invalid values and unknown fields", () => {
  for (const maxRangeLines of [0, -1, 1.5]) {
    assert.throws(
      () => parsePolicyConfig({
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          textEdit: { ...selectedPolicy.limits.textEdit, maxRangeLines }
        }
      }),
      /limits\.textEdit\.maxRangeLines/
    );
  }
  assert.throws(
    () => parsePolicyConfig({
      ...selectedPolicy,
      limits: {
        ...selectedPolicy.limits,
        textEdit: { ...selectedPolicy.limits.textEdit, unknownLimit: 1 }
      }
    }),
    /limits\.textEdit/
  );
});

test("screenshot permission and limits parse strictly", () => {
  // The shipped default keeps the screenshot permission off...
  assert.equal(selectedPolicy.main_agent.permissions.projectScreenshot, false);
  // ...and it is never inferred from other project permissions.
  for (const key of ["projectRead", "projectEdit", "projectRun"] as const) {
    const policy = withMainAgentPermissions({ [key]: true } as any);
    assert.equal(parsePolicyConfig(policy).main_agent.permissions.projectScreenshot, false);
  }

  // Invalid screenshot limit values fail loading.
  for (const [field, value] of [
    ["maxBytes", 0],
    ["maxBytes", 1.5],
    ["maxWidth", -1],
    ["maxStoredFilesPerSession", 0],
    ["captureTimeoutMs", 0],
    ["windowTokenTtlMs", -5],
    ["minJpegQuality", 101],
    ["maxJpegQuality", 0]
  ] as Array<[string, number]>) {
    assert.throws(
      () => parsePolicyConfig({
        ...selectedPolicy,
        limits: {
          ...selectedPolicy.limits,
          screenshot: { ...selectedPolicy.limits.screenshot, [field]: value }
        }
      }),
      new RegExp(`limits\\.screenshot\\.${field}`)
    );
  }

  // Unknown fields inside limits.screenshot fail loading.
  assert.throws(
    () => parsePolicyConfig({
      ...selectedPolicy,
      limits: {
        ...selectedPolicy.limits,
        screenshot: { ...selectedPolicy.limits.screenshot, unknownLimit: 1 }
      }
    }),
    /limits\.screenshot/
  );

  // The complete defaults load and expose the documented values.
  const limits = selectedPolicy.limits.screenshot;
  assert.equal(limits.maxBytes, 8388608);
  assert.equal(limits.maxWidth, 3840);
  assert.equal(limits.maxHeight, 2160);
  assert.equal(limits.maxListPageSize, 100);
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
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log(process.argv[1])", metaArg], 10000, false);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), metaArg);
});

test("shell=true is rejected when selected policy disables shell execution", async () => {
  const deniedPolicy = withMainAgentPermissions({ allowShell: false });
  await assert.rejects(
    async () => runProjectCommand(projectRoot, "node", ["-e", "console.log(1)"], 10000, true, deniedPolicy),
    /Permission denied: main_agent.allowShell is false/
  );
});

test("shell=true executes cross-platform shell operators when selected policy enables shell execution", async () => {
  const allowedPolicy = withMainAgentPermissions({ allowShell: true });
  const result = await runProjectCommand(projectRoot, "node", ["--version", "&&", "node", "--version"], 10000, true, allowedPolicy);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0);
  const versionLines = result.stdout.trim().split(/\r?\n/);
  assert.equal(versionLines.length, 2);
  assert.equal(versionLines.every((line) => /^v\d+\./.test(line)), true);
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

test("Process outcome contract: Execution deadline preserves partial stdout and stderr", async () => {
  // This exercises the real child-process deadline; fake timers cannot drive the spawned process.
  const result = await runProjectCommand(
    projectRoot,
    "node",
    ["-e", "console.log('partial-timeout-stdout'); console.error('partial-timeout-stderr'); process.stdin.resume()"],
    1000
  );
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.exitCode, null);
  assert.match(result.executionError ?? "", /timed out/i);
  assert.equal(result.stdout.trim(), "partial-timeout-stdout");
  assert.equal(result.stderr.trim(), "partial-timeout-stderr");
  assert.equal(result.truncated, false);
  assert.equal(result.effectiveTimeoutMs, 1000);
  assert.equal(result.elapsedMs >= 900, true);
  assert.equal(result.elapsedMs < 10000, true);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  assert.equal(result.lifecycle.processStarted, true);
  assert.equal(result.lifecycle.processExited, false);
  assert.equal(result.lifecycle.killAttempted, true);
  assert.equal(result.lifecycle.killSucceeded, true);
  assert.equal(result.lifecycle.processTreeKillAttempted, true);
  assert.equal(result.lifecycle.processTreeKillSucceeded, true);
  assert.equal(result.lifecycle.descendantsRemaining, 0);
  assert.equal(result.lifecycle.waitAttempted, true);
  assert.equal(result.lifecycle.reaped, true);
  assert.equal(result.lifecycle.scope, "process_tree");
});

test("Process snapshots retain detached descendants by parent ancestry", () => {
  assert.deepEqual(collectDescendantPids([
    { pid: 101, parentPid: 100 },
    { pid: 102, parentPid: 101 },
    { pid: 103, parentPid: 102 },
    { pid: 200, parentPid: 1 }
  ], 100), [101, 102, 103]);
});

test("Process tree termination reaps spawned descendant processes on timeout and confirms descendantsRemaining === 0", async () => {
  const script = "const { spawn } = require('child_process'); const c = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true }); console.log('CHILD_PID:' + c.pid); setInterval(() => {}, 1000);";
  const result = await runProjectCommand(
    projectRoot,
    "node",
    ["-e", script],
    1200
  );
  assert.equal(result.outcome, "timed_out");
  assert.equal(result.lifecycle.killAttempted, true);
  assert.equal(result.lifecycle.killSucceeded, true);
  assert.equal(result.lifecycle.processTreeKillAttempted, true);
  assert.equal(result.lifecycle.processTreeKillSucceeded, true);
  assert.equal(result.lifecycle.descendantsRemaining, 0);
  assert.match(result.stdout, /CHILD_PID:\d+/);
  const match = result.stdout.match(/CHILD_PID:(\d+)/);
  if (match) {
    const childPid = parseInt(match[1], 10);
    let childAlive = false;
    try {
      process.kill(childPid, 0);
      childAlive = true;
    } catch {
      childAlive = false;
    }
    assert.equal(childAlive, false, `Descendant PID ${childPid} should have been reaped`);
  }
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
  const result = await runProjectCommand(projectRoot, "node", ["-e", "console.log('x'.repeat(20 * 1024 * 1024))"], 10000);
  assert.equal(result.outcome, "output_limit");
  assert.equal(result.exitCode, null);
  assert.match(result.executionError ?? "", /buffer limit/i);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
  assert.equal(result.truncated, true);
  assert.equal(result.lifecycle.processStarted, true);
  assert.equal(result.lifecycle.processExited, false);
  assert.equal(result.lifecycle.killAttempted, true);
  assert.equal(result.lifecycle.killSucceeded, true);
  assert.equal(result.lifecycle.waitAttempted, true);
  assert.equal(result.lifecycle.reaped, true);
});

test("toPublicAuditEvent preserves safe edit metadata and drops sensitive fields", () => {
  const rawEvent = {
    timestamp: "2026-08-10T00:00:00.000Z",
    tool: "project_edit",
    operation: "replace",
    projectAlias: "mcp",
    batchIndex: 2,
    batchMode: "staged",
    batchOutcome: "rejected",
    repositoryState: "unchanged",
    outcome: "completed",
    operationStatus: "not_applied",
    reason: "occurrence_mismatch",
    fileChanged: false,
    requestedCount: 2,
    successCount: 0,
    failedCount: 1,
    errorCount: 0,
    appliedCount: 0,
    noChangeCount: 0,
    plannedCount: 0,
    skippedCount: 1,
    expectedOccurrences: 1,
    matchesFound: 0,
    matchesApplied: 0,
    source: "secret source",
    replacement: "secret replacement",
    expectedSha256: "secret hash",
    absolutePath: "C:\\secret\\target.txt",
    error: "secret filesystem error"
  };
  const publicEvent = toPublicAuditEvent(rawEvent);
  assert.deepEqual(publicEvent, {
    timestamp: rawEvent.timestamp,
    tool: "project_edit",
    operation: "replace",
    projectAlias: "mcp",
    batchIndex: 2,
    batchMode: "staged",
    batchOutcome: "rejected",
    repositoryState: "unchanged",
    operationStatus: "not_applied",
    fileChanged: false,
    outcome: "completed",
    requestedCount: 2,
    successCount: 0,
    failedCount: 1,
    errorCount: 0,
    appliedCount: 0,
    noChangeCount: 0,
    plannedCount: 0,
    skippedCount: 1,
    expectedOccurrences: 1,
    matchesFound: 0,
    matchesApplied: 0,
    reason: "occurrence_mismatch"
  } satisfies PublicAuditEvent);
});

test("toPublicAuditEvent preserves run execution metadata", () => {
  const rawEvent = { timestamp: "2026-08-10T00:00:00.000Z", tool: "project_run", batchIndex: 2, type: "script", name: "check", outcome: "exited", exitCode: 0 };
  const publicEvent = toPublicAuditEvent(rawEvent as Record<string, unknown>);
  assert.equal(publicEvent?.batchIndex, 2);
  assert.equal(publicEvent?.executionType, "script");
  assert.equal(publicEvent?.name, "check");
  assert.equal(publicEvent?.outcome, "exited");
});


