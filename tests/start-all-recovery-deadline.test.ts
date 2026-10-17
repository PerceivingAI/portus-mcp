import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fixture, bounded, failed } from "./fixtures/recovery.js";

test("a live replacement without a route exhausts the real outage deadline and is cleaned before terminal completion", { timeout: 50000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher("serve", { plans: ["ready", "no-route"] });
  await launcher.start();
  await f.ready(0);
  const exited = await f.lose(0);
  const replacement = await f.sessionAt(1);
  await bounded(replacement.started.promise, 5000, "replacement proxy listening without route");
  assert.equal(replacement.child.exitCode, null);
  assert.equal(launcher.state, "recovering");
  const terminal = await failed(launcher);
  const elapsed = performance.now() - exited;
  assert(elapsed >= 24900, `outage deadline ended early at ${elapsed}ms`);
  assert(elapsed <= 30000, `cleanup exceeded the outage budget at ${elapsed}ms`);
  assert.equal(terminal.cleanup, "confirmed");
  assert(replacement.child.exitCode !== null || replacement.child.signalCode !== null);
  assert.equal(f.sessions.length, 2);
  await launcher.stop();
  assert.equal(f.sessions.length, 2);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});
