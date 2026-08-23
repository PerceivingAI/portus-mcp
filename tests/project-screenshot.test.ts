/**
 * Phase 2 runtime tests for the screenshot system.
 *
 * Everything runs against deterministic fake worker dependencies, a
 * controllable clock, temporary registered projects, and in-memory fake
 * execution-session records — no desktop and no native binding required.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = mkdtempSync(path.join(process.cwd(), ".portus-shot-test-"));
const stateDir = path.join(root, "state");
process.env.PORTUS_MCP_STATE_DIR = stateDir;
// The shipped policy is valid today; path-policy containment checks load it.
process.env.PORTUS_MCP_POLICY_PATH = path.join(root, "policy.json");
writeFileSync(path.join(root, "policy.json"), readFileSync(path.resolve("portus-mcp.policy.json"), "utf8"));
after(() => rmSync(root, { recursive: true, force: true }));

// Stateful modules are imported only after the isolated environment paths are installed.
const { upsertProject } = await import("../src/state/ProjectRegistry.js");
const { upsertExecutionSession, getExecutionSession } = await import("../src/runtime/executionSessions.js");
const { stateStore } = await import("../src/state/StateStore.js");
const screenshot = await import("../src/runtime/screenshotSystem.js");

const projectRoot = path.join(root, "project");
mkdirSync(projectRoot, { recursive: true });
upsertProject({ projectAlias: "shots", rootPath: projectRoot });
const otherRoot = path.join(root, "other");
mkdirSync(otherRoot, { recursive: true });
upsertProject({ projectAlias: "other", rootPath: otherRoot });
const budgetRoot = path.join(root, "budget");
mkdirSync(budgetRoot, { recursive: true });
upsertProject({ projectAlias: "budget", rootPath: budgetRoot });

let sessionCounter = 0;
function addSession(overrides: Record<string, unknown> = {}): string {
  sessionCounter += 1;
  const sessionId = `exec_1000_${sessionCounter.toString(16).padStart(6, "0")}`;
  upsertExecutionSession({
    sessionId,
    projectAlias: "shots",
    command: "node",
    args: [],
    shell: false,
    status: "running",
    pid: 4000 + sessionCounter,
    startedAt: "2026-08-22T09:59:00.000Z",
    timeoutMs: 600000,
    exitCode: null,
    signal: null,
    executionError: null,
    stdoutPath: path.join(stateDir, "stdout.log"),
    stderrPath: path.join(stateDir, "stderr.log"),
    stdoutBytes: 0,
    stderrBytes: 0,
    lifecycle: {
      processStarted: true,
      processExited: false,
      killAttempted: false,
      killSucceeded: false,
      waitAttempted: false,
      reaped: false
    },
    ...overrides
  } as any);
  return sessionId;
}

const sharpModule = await import("sharp");
const sharp = sharpModule.default;
const pngImage = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 1, g: 2, b: 3 } }
})
  .png()
  .toBuffer();
const jpegImage = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 9, g: 8, b: 7 } }
})
  .jpeg({ quality: 80 })
  .toBuffer();

type FakeWindow = { id: number; pid: number; title?: string };

function makeHarness(options?: {
  windows?: FakeWindow[];
  limits?: Partial<screenshot.ScreenshotLimits>;
  captureBehavior?: "write" | "nowrite" | "garbage" | "wrongformat" | "oversize";
  failAfterWrite?: { code: string };
}) {
  const clock = { ms: Date.parse("2026-08-22T10:00:00Z") };
  const windows = [...(options?.windows ?? [{ id: 11, pid: 4001 }])];
  let currentAllowed = [4001];
  let hexCounter = 0;
  const launches: any[] = [];
  const allowedSetsHistory: number[][] = [];
  const limits = { ...screenshot.DEFAULT_SCREENSHOT_LIMITS, ...(options?.limits ?? {}) };

  const launchWorker = async (request: any) => {
    launches.push(request);
    if (request.op === "capabilities") {
      return {
        ok: true,
        result: { bindingLoaded: true, captureAvailable: true, platform: "win32", formats: ["png", "jpeg"] }
      };
    }
    if (request.op === "targets") {
      return {
        ok: true,
        result: {
          windows: windows.map((w) => ({
            nativeWindowId: w.id,
            pid: w.pid,
            appName: "fixture.exe",
            title: w.title ?? "Fixture Window",
            width: 800,
            height: 600
          }))
        }
      };
    }
    // capture op: simulate the worker writing the encoded image.
    const behavior = options?.captureBehavior ?? "write";
    if (behavior === "garbage") writeFileSync(request.outPath, Buffer.from("definitely not an image"));
    else if (behavior === "wrongformat")
      writeFileSync(request.outPath, request.format === "png" ? jpegImage : pngImage);
    else if (behavior === "oversize") writeFileSync(request.outPath, Buffer.alloc(limits.maxBytes + 1, 0x41));
    else if (behavior !== "nowrite") writeFileSync(request.outPath, request.format === "png" ? pngImage : jpegImage);
    if (options?.failAfterWrite) {
      return {
        ok: false,
        error: { code: options.failAfterWrite.code, message: `fixture ${options.failAfterWrite.code}` }
      };
    }
    return {
      ok: true,
      result: {
        nativeWindowId: request.nativeWindowId,
        pid: request.expectedPid,
        format: request.format,
        width: 64,
        height: 48,
        bytes: 1234,
        resized: false
      }
    };
  };

  const sys = screenshot.createScreenshotSystem({
    launchWorker,
    buildAllowedPids: async () => {
      allowedSetsHistory.push([...currentAllowed]);
      return currentAllowed;
    },
    now: () => clock.ms,
    randomHex: () => {
      hexCounter += 1;
      return hexCounter.toString(16).padStart(8, "0");
    },
    limits
  });

  return {
    sys,
    limits,
    clock,
    launches,
    allowedSetsHistory,
    setWindows(list: FakeWindow[]) {
      windows.splice(0, windows.length, ...list);
    },
    setAllowed(pids: number[]) {
      currentAllowed = pids;
    },
    advance(ms: number) {
      clock.ms += ms;
    }
  };
}

const shotsDir = (...parts: string[]) => path.join(projectRoot, ".portus-artifacts", "screenshots", ...parts);

function listSessionFiles(sessionId: string, project = projectRoot): string[] {
  const dir = path.join(project, ".portus-artifacts", "screenshots", sessionId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function auditEvents(): Array<Record<string, unknown>> {
  const logPath = path.join(stateDir, "audit.log");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.tool === "project_screenshot");
}

function assertScreenshotError(error: unknown, code: string): boolean {
  assert.ok(error instanceof Error, `expected an error, got ${String(error)}`);
  assert.equal((error as any).code, code, (error as Error).message);
  return true;
}

test("capture with one eligible window publishes a validated file with matching hash and no temp leftovers", async () => {
  const h = makeHarness();
  const sid = addSession({ pid: 4001 });
  const result = await h.sys.capture("shots", sid);

  assert.match(result.screenshotId, /^\d{8}T\d{6}Z_[0-9a-f]{8}\.png$/);
  assert.equal(result.format, "png");
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);
  const stored = readFileSync(shotsDir(sid, result.screenshotId));
  assert.equal(result.sha256, createHash("sha256").update(stored).digest("hex"));
  assert.deepEqual(listSessionFiles(sid), [result.screenshotId]);
  assert.ok(h.launches.some((l) => l.op === "capture" && Array.isArray(l.allowedPids) && l.allowedPids.includes(4001)));
});

test("capture with zero windows fails fast when no wait budget is given", async () => {
  const h = makeHarness({ windows: [] });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.sessionWindowNotFound)
  );
});

test("capture waits for a window within waitForWindowMs and succeeds when one appears", async () => {
  const h = makeHarness({ windows: [] });
  const sid = addSession();
  setTimeout(() => h.setWindows([{ id: 77, pid: 4001 }]), 300);
  const result = await h.sys.capture("shots", sid, { waitForWindowMs: 5000 });
  assert.ok(result.screenshotId.endsWith(".png"));
});

test("multiple eligible windows yield multiple_session_windows with opaque scoped candidates", async () => {
  const h = makeHarness({ windows: [{ id: 11, pid: 4001 }, { id: 12, pid: 4001, title: "Second" }] });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => {
      assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.multipleSessionWindows);
      const candidates = (error as any).details?.candidates;
      assert.equal(candidates.length, 2);
      for (const candidate of candidates) {
        assert.equal(typeof candidate.windowId, "string");
        assert.equal(candidate.windowId.length, 32);
        assert.ok(!candidate.windowId.includes("11") || !/^\d+$/.test(candidate.windowId));
      }
      return true;
    }
  );
  // A candidate token from the failed capture resolves to a successful capture.
  const error = await h.sys.capture("shots", sid).then(
    () => {
      throw new Error("expected rejection");
    },
    (caught) => caught
  );
  const token = (error as any).details.candidates[0].windowId as string;
  const result = await h.sys.capture("shots", sid, { windowId: token });
  assert.ok(result.screenshotId.endsWith(".png"));
});

test("unknown, expired, and foreign tokens are rejected", async () => {
  const h = makeHarness({ limits: { windowTokenTtlMs: 1000 } });
  const sidA = addSession();
  const sidB = addSession();

  await assert.rejects(
    () => h.sys.capture("shots", sidA, { windowId: "f".repeat(32) }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.windowTokenInvalid)
  );

  const targets = await h.sys.listTargets("shots", sidA);
  assert.equal(targets.length, 1);
  assert.ok(!JSON.stringify(targets).includes("4001"));

  // Cross-session misuse within the same project.
  await assert.rejects(
    () => h.sys.capture("shots", sidB, { windowId: targets[0].windowId }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.windowTokenInvalid)
  );

  // Expiry via the injected clock.
  h.advance(2000);
  await assert.rejects(
    () => h.sys.capture("shots", sidA, { windowId: targets[0].windowId }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.windowTokenExpired)
  );
});

test("ownership checks: unknown session, malformed id, project mismatch", async () => {
  const h = makeHarness();
  await assert.rejects(
    () => h.sys.capture("shots", "exec_9999_deadbeef"),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.unknownSession)
  );
  await assert.rejects(
    () => h.sys.capture("shots", "../../etc/passwd"),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidSessionId)
  );
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("other", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.sessionProjectMismatch)
  );
  await assert.rejects(
    () => h.sys.list("other", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.sessionProjectMismatch)
  );
});

test("completed sessions deny capture but allow read, list, and delete", async () => {
  const h = makeHarness();
  const sid = addSession();

  const published = await h.sys.capture("shots", sid);
  assert.equal(listSessionFiles(sid).length, 1);

  // The session exits after capture; managed files must remain usable.
  upsertExecutionSession({
    ...(getExecutionSession(sid) as any),
    status: "completed",
    exitCode: 0,
    completedAt: "2026-08-22T10:05:00.000Z"
  });

  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.sessionNotRunning)
  );
  await assert.rejects(
    () => h.sys.listTargets("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.sessionNotRunning)
  );

  const listed = await h.sys.list("shots", sid);
  assert.equal(listed.items.length, 1);
  const readBack = await h.sys.read("shots", sid, published.screenshotId);
  assert.equal(readBack.meta.screenshotId, published.screenshotId);
  await h.sys.deleteScreenshot("shots", sid, published.screenshotId);
  assert.deepEqual(listSessionFiles(sid), []);
});

test("dead root PID surfaces root_pid_unavailable and never launches the worker", async () => {
  let calls = 0;
  const sys = screenshot.createScreenshotSystem({
    launchWorker: async () => {
      calls += 1;
      return { ok: true, result: { windows: [] } };
    },
    buildAllowedPids: async () => {
      throw new screenshot.ScreenshotError(screenshot.SCREENSHOT_ERROR_CODES.rootPidUnavailable, "dead root");
    }
  });
  const sid = addSession();
  await assert.rejects(
    () => sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.rootPidUnavailable)
  );
  assert.equal(calls, 0);
});

test("the allowed PID set is rebuilt fresh for every capture (hot reload)", async () => {
  const h = makeHarness();
  const sid = addSession();
  await h.sys.capture("shots", sid);
  h.setAllowed([4001, 5555]);
  await h.sys.capture("shots", sid);
  // Each capture rebuilds the set twice: once for window selection, once for
  // the capture publication — never cached across launches.
  assert.equal(h.allowedSetsHistory.length, 4);
  assert.deepEqual(h.allowedSetsHistory.slice(0, 2), [[4001], [4001]]);
  assert.deepEqual(h.allowedSetsHistory.slice(2), [[4001, 5555], [4001, 5555]]);
  const captureLaunches = h.launches.filter((l) => l.op === "capture");
  assert.deepEqual(captureLaunches[0].allowedPids, [4001]);
  assert.deepEqual(captureLaunches[1].allowedPids, [4001, 5555]);
});

test("worker timeout after writing a temp file cleans up and fails closed", async () => {
  const h = makeHarness({ failAfterWrite: { code: "screenshot_worker_timeout" } });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.workerTimeout)
  );
  assert.deepEqual(listSessionFiles(sid), []);
});

test("malformed worker result is a protocol error with cleanup", async () => {
  const sid = addSession();
  const clockMs = Date.parse("2026-08-22T11:00:00Z");
  const sys = screenshot.createScreenshotSystem({
    launchWorker: async (request: any) => {
      if (request.op === "capabilities") return { ok: true, result: { captureAvailable: true } };
      if (request.op === "targets") {
        // One eligible window so the flow reaches the capture publication stage.
        return {
          ok: true,
          result: { windows: [{ nativeWindowId: 9, pid: 4001, appName: "a", title: "t", width: 800, height: 600 }] }
        };
      }
      // The worker writes a valid image but reports an unusable result shape.
      writeFileSync(request.outPath, pngImage);
      return { ok: true, result: { totallyUnexpectedShape: true } };
    },
    buildAllowedPids: async () => [4001],
    now: () => clockMs,
    randomHex: () => "abcd1234",
    limits: screenshot.DEFAULT_SCREENSHOT_LIMITS
  });
  await assert.rejects(
    () => sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.protocolError)
  );
  assert.deepEqual(listSessionFiles(sid), []);
});

test("worker success without an image file is rejected", async () => {
  const h = makeHarness({ captureBehavior: "nowrite" });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.workerFailed)
  );
  assert.deepEqual(listSessionFiles(sid), []);
});

test("oversized output is rejected as image_bounds_exceeded with cleanup", async () => {
  const h = makeHarness({ captureBehavior: "oversize" });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.imageBoundsExceeded)
  );
  assert.deepEqual(listSessionFiles(sid), []);
});

test("format mismatch between bytes and request is invalid_image_data", async () => {
  const h = makeHarness({ captureBehavior: "wrongformat" });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidImageData)
  );
  await assert.rejects(
    () => h.sys.capture("shots", sid, { format: "jpeg" }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidImageData)
  );
  assert.deepEqual(listSessionFiles(sid), []);
});

test("dimension limits reject oversized images before publication", async () => {
  const h = makeHarness({ limits: { maxWidth: 50 } });
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.imageBoundsExceeded)
  );
  assert.deepEqual(listSessionFiles(sid), []);
});

test("jpeg capture round-trips with matching hash and extension", async () => {
  const h = makeHarness();
  const sid = addSession();
  const result = await h.sys.capture("shots", sid, { format: "jpeg", jpegQuality: 80 });
  assert.ok(result.screenshotId.endsWith(".jpeg"));
  const stored = readFileSync(shotsDir(sid, result.screenshotId));
  assert.equal(result.sha256, createHash("sha256").update(stored).digest("hex"));
  assert.equal(result.width, 64);
});

test("capture options outside policy bounds are rejected", async () => {
  const h = makeHarness();
  const sid = addSession();
  await assert.rejects(
    () => h.sys.capture("shots", sid, { jpegQuality: 10 }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidCaptureOptions)
  );
  await assert.rejects(
    () => h.sys.capture("shots", sid, { maxWidth: 99999 }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidCaptureOptions)
  );
  await assert.rejects(
    () => h.sys.capture("shots", sid, { waitForWindowMs: 999999 }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidCaptureOptions)
  );
});

test("list returns newest-first metadata with cursor pagination and page bounds", async () => {
  const h = makeHarness();
  const sid = addSession();
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    h.advance(1000);
    ids.push((await h.sys.capture("shots", sid)).screenshotId);
  }
  const page1 = await h.sys.list("shots", sid, { limit: 2 });
  assert.deepEqual(page1.items.map((item) => item.screenshotId), [ids[2], ids[1]]);
  assert.equal(page1.total, 3);
  assert.equal(page1.nextCursor, ids[1]);
  const page2 = await h.sys.list("shots", sid, { cursor: page1.nextCursor!, limit: 2 });
  assert.deepEqual(page2.items.map((item) => item.screenshotId), [ids[0]]);
  assert.equal(page2.nextCursor, null);
  // Page limit is clamped to the configured maximum.
  const clamped = await h.sys.list("shots", sid, { limit: 99999 });
  assert.equal(clamped.items.length, 3);
});

test("read revalidates stored bytes and detects tampering", async () => {
  const h = makeHarness();
  const sid = addSession();
  const result = await h.sys.capture("shots", sid);
  const readBack = await h.sys.read("shots", sid, result.screenshotId);
  assert.equal(readBack.meta.sha256, result.sha256);
  assert.equal(readBack.data.equals(pngImage), true);

  writeFileSync(shotsDir(sid, result.screenshotId), Buffer.from("tampered"));
  await assert.rejects(
    () => h.sys.read("shots", sid, result.screenshotId),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidImageData)
  );
});

test("malformed screenshot ids are rejected before any path is touched", async () => {
  const h = makeHarness();
  const sid = addSession();
  await assert.rejects(
    () => h.sys.read("shots", sid, "../secrets.png"),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidScreenshotId)
  );
  await assert.rejects(
    () => h.sys.deleteScreenshot("shots", sid, "totally_random.png"),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.invalidScreenshotId)
  );
});

test("delete removes the file, audits, and reports not-found afterwards", async () => {
  const h = makeHarness();
  const sid = addSession();
  const result = await h.sys.capture("shots", sid);
  await h.sys.deleteScreenshot("shots", sid, result.screenshotId);
  assert.deepEqual(listSessionFiles(sid), []);
  await assert.rejects(
    () => h.sys.deleteScreenshot("shots", sid, result.screenshotId),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.screenshotNotFound)
  );
  assert.ok(auditEvents().some((event) => event.action === "delete" && event.screenshotId === result.screenshotId));
});

test("per-session retention evicts oldest beyond the configured count", async () => {
  const h = makeHarness({ limits: { maxStoredFilesPerSession: 2 } });
  const sid = addSession();
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    h.advance(1000);
    ids.push((await h.sys.capture("shots", sid)).screenshotId);
  }
  const remaining = listSessionFiles(sid);
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.includes(ids[0]), "oldest screenshot must be evicted");
  assert.deepEqual(remaining, [ids[1], ids[2]]);
  assert.ok(auditEvents().filter((event) => event.action === "retention_evict").length >= 1);
});

test("per-project total-byte retention spans sessions and evicts oldest first", async () => {
  // Dedicated project so the budget is not affected by files from other tests.
  const h = makeHarness({
    limits: { maxTotalBytesPerProject: pngImage.length * 2 - 1 }
  });
  const sidA = addSession({ projectAlias: "budget", pid: 4901 });
  const sidB = addSession({ projectAlias: "budget", pid: 4902 });
  await h.sys.capture("budget", sidA); // occupies the budget first
  await h.sys.capture("budget", sidB);
  // The second publication pushes the project over budget; the oldest file loses.
  assert.deepEqual(listSessionFiles(sidA, budgetRoot), []);
  assert.equal(listSessionFiles(sidB, budgetRoot).length, 1);
});

test("age-based retention deletes screenshots older than maxAgeDays on the next publish", async () => {
  const h = makeHarness({ limits: { maxAgeDays: 7 } });
  const sid = addSession();
  const old = await h.sys.capture("shots", sid);
  h.advance(8 * 86400_000);
  const fresh = await h.sys.capture("shots", sid);
  assert.deepEqual(listSessionFiles(sid), [fresh.screenshotId]);
  void old;
});

test("concurrent captures serialize per project and retention stays consistent", async () => {
  const h = makeHarness({ limits: { maxStoredFilesPerSession: 2 } });
  const sid = addSession();
  h.advance(0);
  const results = await Promise.all([
    h.sys.capture("shots", sid),
    (h.advance(1000), h.sys.capture("shots", sid)),
    (h.advance(1000), h.sys.capture("shots", sid))
  ]);
  const ids = new Set(results.map((result) => result.screenshotId));
  assert.equal(ids.size, 3);
  const remaining = listSessionFiles(sid);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((name) => !name.startsWith("pending_")));
});

test("a new system instance invalidates all window tokens (restart semantics)", async () => {
  const h = makeHarness();
  const sid = addSession();
  const targets = await h.sys.listTargets("shots", sid);
  const secondInstance = makeHarness().sys;
  await assert.rejects(
    () => secondInstance.capture("shots", sid, { windowId: targets[0].windowId }),
    (error) => assertScreenshotError(error, screenshot.SCREENSHOT_ERROR_CODES.windowTokenInvalid)
  );
});

test("capability projection follows permission and binding availability", async () => {
  const h = makeHarness();
  const denied = h.sys.getCapabilities({ permissionGranted: false });
  assert.equal(denied.enabled, false);
  assert.deepEqual(denied.operations, []);

  assert.equal(await h.sys.ensureBindingAvailability(), true);
  const granted = h.sys.getCapabilities({ permissionGranted: true });
  assert.equal(granted.enabled, true);
  assert.equal(granted.scope, "execution_session_windows");
  assert.deepEqual(granted.operations, ["targets", "capture", "read", "list", "delete"]);
  assert.equal(granted.desktopCapture, false);
  assert.equal(granted.activeWindowCapture, false);
  assert.equal(granted.regionCapture, false);

  const unavailable = screenshot.createScreenshotSystem({
    launchWorker: async () => ({ ok: true, result: { bindingLoaded: false, captureAvailable: false } })
  });
  assert.equal(await unavailable.ensureBindingAvailability(), false);
  const degraded = unavailable.getCapabilities({ permissionGranted: true });
  assert.deepEqual(degraded.operations, ["read", "list", "delete"]);
  assert.equal(degraded.captureAvailable, false);
});

test("audit events never contain PIDs, titles, native ids, or absolute paths", async () => {
  const h = makeHarness({ windows: [{ id: 11, pid: 4001, title: "Secret Editor Title" }] });
  const sid = addSession();
  const result = await h.sys.capture("shots", sid);
  await h.sys.read("shots", sid, result.screenshotId);
  await h.sys.list("shots", sid);
  await h.sys.deleteScreenshot("shots", sid, result.screenshotId);

  const serialized = JSON.stringify(auditEvents());
  for (const secret of ["4001", "Secret Editor Title", "nativeWindowId", "ownerPid", "pending_", projectRoot]) {
    assert.ok(!serialized.includes(secret), `audit leaked sensitive field: ${secret}`);
  }
  assert.ok(serialized.includes(`"${sid}"`));
});






