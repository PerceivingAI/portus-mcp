import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "portus-git-traversal-"));
const stateDir = path.join(root, "state");
const configPath = path.join(root, "config.json");
const policyPath = path.join(root, "policy.json");
const gitProjectRoot = path.join(root, "git-project");
const nonGitProjectRoot = path.join(root, "non-git-project");

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
mkdirSync(gitProjectRoot, { recursive: true });
mkdirSync(nonGitProjectRoot, { recursive: true });
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
    excludedPatterns: [".git", "node_modules", "dist", ".portus-mcp", "target", ".flue", "coverage", ".next", ".cache"]
  }
}, null, 2), "utf8");
writeFileSync(policyPath, JSON.stringify({
  main_agent: {
    permissions: {
      subagentTask: true,
      subagentContext: true,
      projectContext: true,
      projectRead: true,
      projectSearch: true,
      projectEdit: true,
      projectPatch: true,
      projectRun: true,
      projectPolicy: true, projectScreenshot: false,
      readGitIgnoredFiles: false,
      requireConfirmation: true,
      allowShell: false,
      allowedCommands: ["git"]
    }
  },
  subagents: {
    concurrency: { maxConcurrent: 4, maxConcurrentPerProject: 2, queueEnabled: false, maxQueueDepth: 10 },
    lifecycle: {
      queuedTaskTtlSecs: 300,
      projectLockTimeoutSecs: 1800,
      maxRuntimeSecs: 3600,
      startupWatchdogMs: 15000,
      forcedCloseGraceMs: 8000,
      killEscalationDelayMs: 1200,
      queueDrainDelayMs: 50
    },
    permissions: { networkAccess: true, allowedCommands: ["git"] }
  },
  pathPolicy: { blockedPatterns: [".env"] },
  limits: {
    fileRead: { maxChars: 500000 },
    fileWrite: { maxChars: 1000000 },
    patch: { maxChars: 1000000 },
    textEdit: { maxOperationChars: 200000, maxSearchOrMarkerChars: 20000, maxRangeLines: 2000 },
    search: {
      maxScanEntries: 100000,
      maxTextFileChars: 200000,
      maxRegexExecutionMs: 120000,
      maxBatchMatches: 5000,
      maxBatchOutputChars: 500000
    },
    skills: { maxReadChars: 200000 },
    subagentOutput: { maxStdoutChars: 200000, maxStderrChars: 200000 },
    sessionEvents: { maxEvents: 500, maxChunkChars: 4000 },
    audit: { maxEvents: 1000 },
    process: { maxOutputBufferMb: 10, maxBatchOutputChars: 1000000 }, screenshot: { maxBytes: 8388608, maxWidth: 3840, maxHeight: 2160, maxStoredFilesPerSession: 20, maxTotalBytesPerProject: 104857600, maxAgeDays: 7, captureTimeoutMs: 10000, maxWindowWaitMs: 30000, windowTokenTtlMs: 30000, maxListPageSize: 100, minJpegQuality: 50, maxJpegQuality: 95 }
  },
  audit: { strictMode: false }
}, null, 2), "utf8");

process.env.PORTUS_MCP_CONFIG_PATH = configPath;
process.env.PORTUS_MCP_POLICY_PATH = policyPath;
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.DOTENV_CONFIG_PATH = path.join(root, "missing.env");

const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { collectSearchableFiles } = await import("../src/tools/projects.js");
const { loadPolicyConfig } = await import("../src/policy/policyConfig.js");
const policy = loadPolicyConfig();

execFileSync("git", ["init", "--quiet"], { cwd: gitProjectRoot, stdio: "ignore" });
writeFileSync(path.join(gitProjectRoot, ".gitignore"), "ignored/\n", "utf8");
mkdirSync(path.join(gitProjectRoot, "ignored", "nested"), { recursive: true });
writeFileSync(path.join(gitProjectRoot, "ignored", "nested", "hidden.txt"), "hidden\n", "utf8");
mkdirSync(path.join(gitProjectRoot, "coverage"), { recursive: true });
writeFileSync(path.join(gitProjectRoot, "coverage", "excluded.txt"), "excluded\n", "utf8");

for (let index = 0; index < 120; index += 1) {
  const directory = path.join(gitProjectRoot, `wide-${index}`);
  mkdirSync(directory);
  writeFileSync(path.join(directory, `file-${index}.txt`), `${index}\n`, "utf8");
}
let deepDirectory = path.join(gitProjectRoot, "deep");
mkdirSync(deepDirectory);
for (let depth = 0; depth < 35; depth += 1) {
  deepDirectory = path.join(deepDirectory, `level-${depth}`);
  mkdirSync(deepDirectory);
}
writeFileSync(path.join(deepDirectory, "deep.txt"), "deep\n", "utf8");

for (let index = 0; index < 40; index += 1) {
  const directory = path.join(nonGitProjectRoot, `directory-${index}`);
  mkdirSync(directory);
  writeFileSync(path.join(directory, `file-${index}.txt`), `${index}\n`, "utf8");
}

upsertProject({ projectAlias: "git-shapes", rootPath: gitProjectRoot });
upsertProject({ projectAlias: "non-git-shape", rootPath: nonGitProjectRoot });

test("wide and deep Git traversal uses one classifier process and prunes ignored directories", async () => {
  const result = await collectSearchableFiles("git-shapes", ".", 100000, false, policy);
  const paths = new Set(result.entries.map((entry) => entry.relativePath));

  assert.equal(result.gitProcessesSpawned, 1);
  assert.equal(result.stoppedAtCap, false);
  assert.equal(result.directoriesVisited, 157);
  assert.equal(paths.size, 122);
  assert.equal(paths.has("wide-0/file-0.txt"), true);
  assert.equal(paths.has("deep/level-0/level-1/level-2/level-3/level-4/level-5/level-6/level-7/level-8/level-9/level-10/level-11/level-12/level-13/level-14/level-15/level-16/level-17/level-18/level-19/level-20/level-21/level-22/level-23/level-24/level-25/level-26/level-27/level-28/level-29/level-30/level-31/level-32/level-33/level-34/deep.txt"), true);
  assert.equal(paths.has("ignored/nested/hidden.txt"), false);
  assert.equal(paths.has("coverage/excluded.txt"), false);
});

test("requested root and descendants share one classifier process", async () => {
  const result = await collectSearchableFiles("git-shapes", "wide-0", 100, false, policy);
  assert.equal(result.gitProcessesSpawned, 1);
  assert.equal(result.directoriesVisited, 1);
  assert.deepEqual(result.entries.map((entry) => entry.relativePath), ["wide-0/file-0.txt"]);
});

test("ignored and explicitly excluded search roots are rejected before enumeration", async () => {
  const ignored = await collectSearchableFiles("git-shapes", "ignored", 100, false, policy);
  assert.equal(ignored.gitProcessesSpawned, 1);
  assert.equal(ignored.directoriesVisited, 0);
  assert.deepEqual(ignored.entries, []);

  const excluded = await collectSearchableFiles("git-shapes", "coverage", 100, false, policy);
  assert.equal(excluded.gitProcessesSpawned, 0);
  assert.equal(excluded.directoriesVisited, 0);
  assert.deepEqual(excluded.entries, []);
});

test("scan caps retain completion reasons with one classifier process", async () => {
  const result = await collectSearchableFiles("git-shapes", ".", 5, false, policy);
  assert.equal(result.gitProcessesSpawned, 1);
  assert.equal(result.stoppedAtCap, true);
  assert.deepEqual(result.reasons, ["max_scan_entries"]);
  assert.equal(result.entries.length, 5);
});

test("non-Git traversal fails open once without process respawn", async () => {
  const result = await collectSearchableFiles("non-git-shape", ".", 1000, false, policy);
  assert.equal(result.gitProcessesSpawned, 1);
  assert.equal(result.stoppedAtCap, false);
  assert.equal(result.entries.length, 40);
  assert.equal(result.directoriesVisited, 41);
});
