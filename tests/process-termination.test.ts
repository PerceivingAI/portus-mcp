import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { terminateProcessTree } from "../src/runtime/processTermination.js";

test("failed taskkill is an action warning when verification confirms the tree is absent", {
  skip: process.platform !== "win32"
}, async () => {
  const fake = Object.assign(new EventEmitter(), {
    pid: 2_000_000_000,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: null,
    stderr: null,
    kill() {
      this.exitCode = 0;
      return true;
    }
  }) as unknown as ChildProcess;

  const result = await terminateProcessTree(fake, {
    escalationDelayMs: 1,
    forcedCloseGraceMs: 20
  });

  assert.equal(result.outcome, "terminated");
  assert.equal(result.verification, "confirmed_absent");
  assert.equal(result.descendantsRemaining, 0);
  assert.match(result.actionError ?? "", /taskkill failed/);
});

test("missing process identity reports termination_unverified", async () => {
  const fake = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: null,
    stderr: null
  }) as unknown as ChildProcess;

  const result = await terminateProcessTree(fake, {
    escalationDelayMs: 1,
    forcedCloseGraceMs: 20
  });

  assert.equal(result.outcome, "termination_unverified");
  assert.equal(result.verification, "unavailable");
  assert.equal(result.descendantsRemaining, 0);
  assert.match(result.verificationError ?? "", /without a process id/);
});
