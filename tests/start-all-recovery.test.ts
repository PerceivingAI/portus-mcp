import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fixture, bounded, assertAliases, failed, delayAtLeast } from "./fixtures/recovery.js";

test("Serve restores three consecutive losses, then exhausts its invocation-wide replacement allowance", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher();
  const initial = await launcher.start();
  assert.equal(initial.backend, undefined);
  assert.equal(initial.external.pid, (await f.ready(0)).child.pid);
  const pids = new Set<number>();
  for (let index = 0; index < 3; index++) {
    const old = await f.ready(index);
    assert(old.child.pid);
    pids.add(old.child.pid);
    const exited = index === 2
      ? await (async () => { const exit = once(old.child, "exit"); old.child.kill("SIGTERM"); await bounded(exit, 5000, "signal loss"); assert(old.exitedAt !== undefined); return old.exitedAt; })()
      : await f.lose(index, index === 0 ? 0 : 12);
    assert.equal(launcher.state, "recovering");
    await bounded(launcher.recovery, 30000, "route restoration");
    const next = await f.ready(index + 1);
    delayAtLeast(next.spawnedAt - exited, [1000, 2000, 4000][index]);
    assert(performance.now() - exited <= 30000);
    assert.equal(launcher.state, "running");
    assert.notEqual(next.child.pid, old.child.pid);
    assert.notEqual(next.id, old.id);
    assert.equal(f.state().Foreground?.[old.id], undefined);
    assert.equal(Object.keys(f.state().Foreground ?? {}).length, 2);
    await assertAliases(f.url(index + 1), "", ["before"]);
    await f.preserved();
  }
  assert((await f.ready(3)).child.pid);
  pids.add(f.sessions[3].child.pid!);
  assert.equal(pids.size, 4);
  await f.lose(3, 0);
  const terminal = await failed(launcher);
  assert.equal(terminal.cleanup, "confirmed");
  assert.equal(f.sessions.length, 4);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

test("Funnel restores its route while the borrowed authenticated backend is absent", { timeout: 40000 }, async t => {
  const f = await fixture(t, "isolated-recovery-token");
  const original = await f.startBackend();
  const launcher = f.makeLauncher("funnel");
  await launcher.start();
  const before = await f.ready(0);
  await assertAliases(f.url(0), f.token, ["before"]);
  await f.stopBackend();
  const protocolRequests = f.protocolRequests();
  await f.lose(0);
  await bounded(launcher.recovery, 30000, "Funnel route restoration without backend");
  const restored = await f.ready(1);
  assert.notEqual(restored.child.pid, before.child.pid);
  assert.equal(launcher.state, "running");
  assert.equal(f.protocolRequests(), protocolRequests, "recovery must not repeat initial MCP verification");
  const response = await fetch(f.url(1), { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 502);
  await response.text();
  const replacement = await f.startBackend("after");
  assert.notEqual(replacement.pid, original.pid);
  await assertAliases(f.url(1), f.token, ["after"]);
  await launcher.stop();
  assert.equal((await launcher.completion).state, "stopped");
  assert.equal(replacement.exitCode, null);
  assert.equal(replacement.signalCode, null);
  await assertAliases(f.backendUrl(), f.token, ["after"]);
  assert.deepEqual(f.state(), f.initial);
});

test("replacement processes exiting before readiness consume all attempts in the original outage episode", { timeout: 45000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher("serve", { plans: ["ready", "exit-before-ready", "exit-before-ready", "exit-before-ready"] });
  await launcher.start();
  await f.ready(0);
  const exited = await f.lose(0);
  const terminal = await failed(launcher);
  assert.equal(terminal.cleanup, "confirmed");
  assert.equal(f.sessions.length, 4);
  for (let index = 1; index <= 3; index++) {
    const prior = f.sessions[index - 1];
    assert(prior.exitedAt !== undefined);
    delayAtLeast(f.sessions[index].spawnedAt - prior.exitedAt, [1000, 2000, 4000][index - 1]);
    assert.equal(f.sessions[index].child.exitCode, 7);
  }
  assert(performance.now() - exited <= 30000);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

for (const [category, diagnostic] of [
  ["auth", "authentication required"], ["policy", "permission denied"],
  ["configuration", "invalid configuration"], ["conflict", "address already in use"]
] as const) {
  test(`final streamed ${category} diagnostic refuses recovery before any replacement`, { timeout: 25000 }, async t => {
    const f = await fixture(t);
    await f.startBackend();
    const launcher = f.makeLauncher();
    await launcher.start();
    await f.ready(0);
    await f.lose(0, 1, diagnostic);
    const terminal = await failed(launcher);
    assert.equal(terminal.cleanup, "confirmed");
    assert.equal(f.sessions.length, 1);
    assert.deepEqual(f.state(), f.initial);
    await f.preserved();
  });
}

test("a backend-unreachable diagnostic does not refuse route-only recovery", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher();
  await launcher.start();
  await f.ready(0);
  await f.lose(0, 1, "backend unreachable");
  await bounded(launcher.recovery, 30000, "nonterminal backend diagnostic recovery");
  await f.ready(1);
  assert.equal(launcher.state, "running");
  assert.equal(f.sessions.length, 2);
  await assertAliases(f.url(1), "", ["before"]);
  await f.preserved();
});

for (const refusal of ["spawn-error", "daemon", "listener-conflict"] as const) {
  test(`replacement ${refusal} is terminal without subsequent spawn`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.startBackend();
    const launcher = f.makeLauncher("serve", { plans: ["ready", "spawn-error"] });
    await launcher.start();
    await f.ready(0);
    if (refusal === "daemon") f.setDaemonUnavailable();
    if (refusal === "listener-conflict") f.addConflict();
    const expected = f.state();
    delete expected.Foreground?.[f.sessions[0].id];
    await f.lose(0);
    const terminal = await failed(launcher);
    assert.equal(terminal.cleanup, "confirmed");
    assert.equal(f.sessions.length, refusal === "spawn-error" ? 2 : 1);
    if (refusal === "spawn-error") assert.equal(f.sessions[1].child.pid, undefined);
    assert.deepEqual(f.state(), expected);
    await f.preserved(expected);
  });
}

test("unverified exited-tree cleanup refuses replacement and preserves borrowed resources", { timeout: 30000, skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  await f.startBackend();
  const launcher = f.makeLauncher("serve", { cleanupExited: async () => ({ confirmed: false }) });
  await launcher.start();
  await f.ready(0);
  await f.lose(0);
  const terminal = await failed(launcher);
  assert.equal(terminal.cleanup, "unverified");
  await f.acknowledgeFailedStop(launcher);
  await f.waitForOwnedRelease();
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(f.state(), f.initial);
  await f.preserved();
});

for (const phase of ["backoff", "replacement-startup"] as const) {
  test(`manual stop during recovery ${phase} cancels late spawns and preserves borrowed ownership`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    await f.startBackend();
    const launcher = f.makeLauncher("serve", { plans: ["ready", "no-route"] });
    await launcher.start();
    await f.ready(0);
    await f.lose(0);
    assert.equal(launcher.state, "recovering");
    if (phase === "replacement-startup") {
      const replacement = await f.sessionAt(1);
      await bounded(replacement.started.promise, 5000, "replacement startup acknowledgement");
      assert.equal(replacement.child.exitCode, null);
      assert.equal(f.state().Foreground?.[replacement.id], undefined);
    }
    const recovery = launcher.recovery;
    await bounded(launcher.stop(), 7000, "manual recovery stop");
    await bounded(recovery, 1000, "cancelled recovery settles");
    const terminal = await launcher.completion;
    assert.equal(terminal.state, "stopped");
    assert.equal(terminal.exitCode, 0);
    assert.equal(terminal.cleanup, "confirmed");
    assert.equal(f.sessions.length, phase === "backoff" ? 1 : 2);
    for (const session of f.sessions) assert(session.child.exitCode !== null || session.child.signalCode !== null);
    assert.deepEqual(f.state(), f.initial);
    await f.preserved();
    assert.equal(f.sessions.length, phase === "backoff" ? 1 : 2);
  });
}
