import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import {
  startExecutionSession,
  pollExecutionSession,
  writeExecutionSession,
  terminateExecutionSession,
  listExecutionSessions,
  getExecutionSession,
  upsertExecutionSession,
  reconcileOrphanedExecutionSessions,
  subscribeExecutionSessionExit
} from "../src/runtime/executionSessions.js";
import { loadPolicyConfig } from "../src/policy/policyConfig.js";

const root = mkdtempSync(path.join(process.cwd(), ".portus-exec-test-"));
const stateDir = path.join(root, "state");
process.env.PORTUS_MCP_STATE_DIR = stateDir;
process.env.PORTUS_MCP_PROJECTS = `test=${root}`;
after(async () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Ignore transient cleanup errors on Windows
  }
});

const selectedPolicy = loadPolicyConfig();
const withMainAgentPermissions = (
  permissions: Partial<typeof selectedPolicy.main_agent.permissions>
): typeof selectedPolicy => ({
  ...selectedPolicy,
  main_agent: {
    permissions: { ...selectedPolicy.main_agent.permissions, ...permissions }
  }
});

test("Execution sessions: start, poll incremental chunks with cursor, and complete", async () => {
  const testPolicy = withMainAgentPermissions({
    allowedCommands: ["node", "git"]
  });

  const script = [
    "console.log('line1');",
    "console.log('line2');",
    "console.log('line3');"
  ].join("\n");

  const session = await startExecutionSession({
    projectAlias: "test",
    rootPath: root,
    command: "node",
    args: ["-e", script],
    timeoutSecs: 60,
    policy: testPolicy
  });

  assert.equal(typeof session.sessionId, "string");
  assert.equal(session.projectAlias, "test");
  assert.equal(session.status, "running");

  // Wait briefly for execution close
  let pollRes;
  const deadline = Date.now() + 5000;
  do {
    pollRes = pollExecutionSession({ sessionId: session.sessionId, cursor: 0 });
    if (pollRes.status !== "running") break;
    await delay(50);
  } while (Date.now() < deadline);

  assert.notEqual(pollRes.status, "running");
  assert.equal(pollRes.exitCode, 0);
  assert.match(pollRes.stdoutChunk, /line1\r?\nline2\r?\nline3/);
  assert.equal(pollRes.nextCursor > 0, true);

  // Poll again from nextCursor - should return empty chunk
  const nextPoll = pollExecutionSession({ sessionId: session.sessionId, cursor: pollRes.nextCursor });
  assert.equal(nextPoll.stdoutChunk, "");
  assert.equal(nextPoll.nextCursor, pollRes.nextCursor);

  // List sessions
  const list = listExecutionSessions("test");
  assert.equal(list.some((s) => s.sessionId === session.sessionId), true);
});

test("Execution sessions write bounded stdin and observe the response", async () => {
  const session = await startExecutionSession({
    projectAlias: "test",
    rootPath: root,
    command: "node",
    args: ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { process.stdout.write(`received:${data}`); if (data.includes('quit')) process.exit(0); });"],
    timeoutSecs: 60,
    policy: withMainAgentPermissions({ allowedCommands: ["node"] })
  });

  const writeResult = writeExecutionSession(session.sessionId, "ping\n");
  assert.equal(writeResult.status, "running");
  assert.equal(writeResult.writtenBytes, 5);

  const outputDeadline = Date.now() + 5000;
  let pollResult = pollExecutionSession({ sessionId: session.sessionId, cursor: 0 });
  while (!pollResult.stdoutChunk.includes("received:ping") && Date.now() < outputDeadline) {
    await delay(20);
    pollResult = pollExecutionSession({ sessionId: session.sessionId, cursor: pollResult.nextCursor });
  }
  assert.match(pollResult.stdoutChunk, /received:ping/);

  writeExecutionSession(session.sessionId, "quit\n");
  const completionDeadline = Date.now() + 5000;
  while (getExecutionSession(session.sessionId).status === "running" && Date.now() < completionDeadline) {
    await delay(20);
  }
  assert.equal(getExecutionSession(session.sessionId).status, "completed");
});

test("Execution sessions spawn a resolved executable while preserving the logical command", async () => {
  const session = await startExecutionSession({
    projectAlias: "test",
    rootPath: root,
    command: "chrome.exe",
    executablePath: process.execPath,
    args: ["-e", "console.log('resolved-launch')"],
    timeoutSecs: 60,
    policy: withMainAgentPermissions({ allowedCommands: ["chrome.exe"] })
  });

  assert.equal(session.command, "chrome.exe");
  const deadline = Date.now() + 5000;
  let pollResult = pollExecutionSession({ sessionId: session.sessionId, cursor: 0 });
  while (pollResult.status === "running" && Date.now() < deadline) {
    await delay(20);
    pollResult = pollExecutionSession({ sessionId: session.sessionId, cursor: 0 });
  }

  assert.equal(pollResult.status, "completed");
  assert.equal(pollResult.exitCode, 0);
  assert.match(pollResult.stdoutChunk, /resolved-launch/);
  assert.equal(getExecutionSession(session.sessionId).command, "chrome.exe");
});

test("Execution sessions flush short-lived output before finalization", async () => {
  const testPolicy = withMainAgentPermissions({
    allowedCommands: ["node"]
  });
  const expectedBytes = 512 * 1024;
  const session = await startExecutionSession({
    projectAlias: "test",
    rootPath: root,
    command: "node",
    args: ["-e", `process.stdout.write("x".repeat(${expectedBytes}))`],
    timeoutSecs: 60,
    policy: testPolicy
  });

  const deadline = Date.now() + 5000;
  let current = getExecutionSession(session.sessionId);
  while (current.status === "running" && Date.now() < deadline) {
    await delay(20);
    current = getExecutionSession(session.sessionId);
  }

  assert.equal(current.status, "completed");
  assert.equal(current.stdoutBytes, expectedBytes);
  const output = readFileSync(current.stdoutPath);
  assert.equal(output.length, expectedBytes);
  assert.equal(output.every((byte) => byte === 0x78), true);
});

test("Execution sessions: terminate reaps background process tree", async () => {
  const testPolicy = withMainAgentPermissions({
    allowedCommands: ["node"]
  });

  const longScript = "setInterval(() => { console.log('heartbeat'); }, 100);";

  const session = await startExecutionSession({
    projectAlias: "test",
    rootPath: root,
    command: "node",
    args: ["-e", longScript],
    timeoutSecs: 60,
    policy: testPolicy
  });
  assert.equal(session.status, "running");

  const term = await terminateExecutionSession(session.sessionId);
  assert.equal(term.status, "stopped");
  assert.equal(term.lifecycle.killAttempted, true);
  assert.equal(term.lifecycle.killSucceeded, true);
  assert.equal(term.lifecycle.processTreeKillAttempted, true);
  assert.equal(term.lifecycle.processTreeKillSucceeded, true);
  assert.equal(term.lifecycle.descendantsRemaining, 0);
  assert.equal(term.lifecycle.terminationOutcome, "terminated");
  assert.equal(term.lifecycle.terminationVerification, "confirmed_absent");

  const finalRecord = getExecutionSession(session.sessionId);
  assert.equal(finalRecord.status, "stopped");
});

test("Execution sessions finalize cleanly even when background child keeps inherited stdout open", async () => {
  const testPolicy = withMainAgentPermissions({
    allowedCommands: ["node"]
  });

  // Script launches a child inheriting stdout and holding it, while parent exits immediately with code 0
  const pipeInheritScript = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2], detached: true })",
    "console.log('CHILD_PID:' + child.pid)",
    "child.unref()",
    "console.log('parent-finished')"
  ].join("; ");

  const session = await startExecutionSession({
    projectAlias: "test",
    rootPath: root,
    command: "node",
    args: ["-e", pipeInheritScript],
    timeoutSecs: 60,
    policy: testPolicy
  });

  assert.equal(session.status, "running");

  // Wait for the exit event notification (emitted within ~500ms STDIO_DRAIN_GRACE_MS after root exit)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Session exit event timed out")), 5000);
    const unsubscribe = subscribeExecutionSessionExit((id) => {
      if (id === session.sessionId) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });

  const pollRes = pollExecutionSession({ sessionId: session.sessionId, stream: "both" });
  const rec = getExecutionSession(session.sessionId);
  const rawStdout = readFileSync(rec.stdoutPath, "utf8");
  const rawStderr = readFileSync(rec.stderrPath, "utf8");
  assert.equal(pollRes.status, "completed", `Status not completed. Stderr: ${rawStderr}`);
  assert.equal(pollRes.exitCode, 0, `Exit code not 0. Stderr: ${rawStderr}`);
  assert.match(pollRes.stdoutChunk || rawStdout, /parent-finished/, `Stdout missing. Out: "${rawStdout}", Err: "${rawStderr}"`);
  assert.equal(pollRes.lifecycle.reaped, true);

  const match = (pollRes.stdoutChunk || rawStdout).match(/CHILD_PID:(\d+)/);
  if (match?.[1]) {
    try {
      process.kill(Number(match[1]), "SIGKILL");
    } catch {
      // ignore
    }
  }
});

test("Execution sessions reconcile stale/orphaned sessions on poll and list", async () => {
  // Manually create a session record on disk with a nonexistent PID
  const staleSessionId = `exec_stale_${Date.now()}`;
  const fakeRecord = {
    sessionId: staleSessionId,
    projectAlias: "test",
    command: "node",
    args: ["-v"],
    shell: false,
    status: "running" as const,
    pid: 9999999, // nonexistent PID
    startedAt: new Date(Date.now() - 10000).toISOString(),
    timeoutMs: 60000,
    exitCode: null,
    signal: null,
    executionError: null,
    stdoutPath: path.join(stateDir, "executions", staleSessionId, "stdout.log"),
    stderrPath: path.join(stateDir, "executions", staleSessionId, "stderr.log"),
    stdoutBytes: 0,
    stderrBytes: 0,
    lifecycle: {
      processStarted: true,
      processExited: false,
      killAttempted: false,
      killSucceeded: false,
      waitAttempted: false,
      reaped: false
    }
  };
  upsertExecutionSession(fakeRecord);

  // 1. Polling the stale session should automatically reconcile it
  const polled = pollExecutionSession({ sessionId: staleSessionId });
  assert.equal(polled.status, "stopped");
  assert.equal(polled.lifecycle.processExited, true);
  assert.equal(polled.lifecycle.reaped, true);
  assert.equal(polled.lifecycle.reconciled, true);
  assert.equal(polled.lifecycle.reconciliationReason, "root_process_absent");

  // 2. Listing sessions should reflect the reconciled state
  const list = listExecutionSessions("test");
  const entry = list.find((s) => s.sessionId === staleSessionId);
  assert.ok(entry);
  assert.equal(entry.status, "stopped");
  assert.equal(entry.lifecycle.reconciled, true);
});
