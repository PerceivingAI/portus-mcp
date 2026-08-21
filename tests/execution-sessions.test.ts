import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import {
  startExecutionSession,
  pollExecutionSession,
  terminateExecutionSession,
  listExecutionSessions,
  getExecutionSession
} from "../src/runtime/executionSessions.js";
import { loadPolicyConfig } from "../src/policy/policyConfig.js";

const root = mkdtempSync(path.join(process.cwd(), ".portus-exec-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

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

  const finalRecord = getExecutionSession(session.sessionId);
  assert.equal(finalRecord.status, "stopped");
});
