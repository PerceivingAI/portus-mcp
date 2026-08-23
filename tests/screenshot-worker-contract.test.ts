/**
 * Worker unit tests and child-process contract tests for the screenshot worker.
 *
 * Unit tests drive `handleRequest` with injected fake bindings so no desktop
 * is required. Contract tests spawn the real worker and a scripted fixture to
 * verify process isolation behaviors: bounded stdio, timeout kill, crash,
 * partial output, oversize output, and capture-file omission.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ERROR_CODES,
  MAX_INPUT_BYTES,
  WORKER_PROTOCOL_VERSION,
  handleRequest,
  parseRequestObject
} from "../scripts/screenshot-worker.mjs";

const workerPath = path.resolve("scripts", "screenshot-worker.mjs");
const fixturePath = path.resolve("tests", "fixtures", "screenshot-worker-fixture.mjs");

interface FakeWindowSpec {
  id: number;
  pid: number;
  title?: string;
  appName?: string;
  width?: number;
  height?: number;
  minimized?: boolean;
  imageBuffer?: Buffer | null;
}

function makeFakeWindow(spec: FakeWindowSpec) {
  return {
    id: () => spec.id,
    pid: () => spec.pid,
    title: () => spec.title ?? "fixture window",
    appName: () => spec.appName ?? "fixture.exe",
    width: () => spec.width ?? 320,
    height: () => spec.height ?? 240,
    isMinimized: () => Boolean(spec.minimized),
    captureImage: async () =>
      spec.imageBuffer === null ? null : makeFakeImage(spec.imageBuffer ?? Buffer.from([0x89, 0x50]))
  };
}

function makeFakeImage(buffer: Buffer) {
  return {
    width: 320,
    height: 240,
    toPng: async () => buffer,
    toJpeg: async () => buffer
  };
}

function makeBindings(windows: FakeWindowSpec[] | (() => FakeWindowSpec[]), options?: { sharp?: any }) {
  const source = Array.isArray(windows) ? () => windows : windows;
  return {
    loadBindings: async () => ({
      Window: { all: () => source().map(makeFakeWindow) },
      sharp: options?.sharp ?? (() => {
        throw new Error("sharp must not be used in this test");
      }),
      sharpAvailable: Boolean(options?.sharp)
    })
  };
}

function makeLoadFailure() {
  return { loadBindings: async () => { throw new Error("simulated binding load failure"); } };
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "portus-worker-test-"));
}

// ---------------------------------------------------------------------------
// Request parsing (strict schema, unknown-field rejection, version check)
// ---------------------------------------------------------------------------

test("parse rejects unknown fields", () => {
  const parsed = parseRequestObject({
    op: "targets",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    allowedPids: [100],
    extraField: true
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.error.code, ERROR_CODES.protocolError);
  }
});

test("parse rejects protocol version mismatch", () => {
  const parsed = parseRequestObject({ op: "capabilities", protocolVersion: 999 });
  assert.equal(parsed.ok, false);
});

test("parse rejects unknown operations", () => {
  const parsed = parseRequestObject({ op: "list_monitors", protocolVersion: WORKER_PROTOCOL_VERSION });
  assert.equal(parsed.ok, false);
});

test("parse rejects jpeg quality outside bounds", () => {
  for (const quality of [49, 96, 60.5]) {
    const parsed = parseRequestObject({
      op: "capture",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      allowedPids: [1],
      nativeWindowId: 1,
      expectedPid: 1,
      format: "jpeg",
      jpegQuality: quality,
      outPath: "C:\\tmp\\out.jpeg"
    });
    assert.equal(parsed.ok, false, `quality ${quality} must be rejected`);
  }
});

test("parse accepts a valid capture request", () => {
  const parsed = parseRequestObject({
    op: "capture",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    allowedPids: [10, 11],
    nativeWindowId: 7,
    expectedPid: 10,
    format: "png",
    maxWidth: 1920,
    maxHeight: 1080,
    outPath: path.join(tmpdir(), "capture.png")
  });
  assert.equal(parsed.ok, true);
});

// ---------------------------------------------------------------------------
// targets: allowed-PID filtering before serialization, eligibility rejection
// ---------------------------------------------------------------------------

test("targets filters windows by allowed PIDs and never serializes unrelated metadata", async () => {
  const bindings = makeBindings([
    { id: 1, pid: 100, title: "owned window" },
    { id: 2, pid: 200, title: "unrelated secret title" },
    { id: 3, pid: 300, appName: "explorer", title: "desktop" }
  ]);
  const outcome = await handleRequest(
    { op: "targets", protocolVersion: WORKER_PROTOCOL_VERSION, allowedPids: [100] } as any,
    bindings as any
  );
  assert.equal(outcome.ok, true);
  const serialized = JSON.stringify(outcome);
  if (outcome.ok) {
    assert.equal(outcome.result.windows.length, 1);
    assert.equal(outcome.result.windows[0].pid, 100);
    assert.equal(outcome.result.windows[0].title, "owned window");
    assert.equal(outcome.result.windows[0].nativeWindowId, 1);
  }
  assert.ok(!serialized.includes("unrelated secret title"));
  assert.ok(!serialized.includes("explorer"));
});

test("targets excludes minimized and zero-size windows", async () => {
  const bindings = makeBindings([
    { id: 4, pid: 100, minimized: true },
    { id: 5, pid: 100, width: 0 },
    { id: 6, pid: 100 },
    { id: 7, pid: 100, height: 0 }
  ]);
  const outcome = await handleRequest(
    { op: "targets", protocolVersion: WORKER_PROTOCOL_VERSION, allowedPids: [100] } as any,
    bindings as any
  );
  if (outcome.ok) {
    assert.deepEqual(outcome.result.windows.map((w: any) => w.nativeWindowId), [6]);
  } else {
    assert.fail("expected ok outcome");
  }
});

test("titles are sanitized: control characters stripped and length bounded", async () => {
  const bindings = makeBindings([
    { id: 8, pid: 100, title: `bad\u0007title\u001B[31m${"x".repeat(400)}` }
  ]);
  const outcome = await handleRequest(
    { op: "targets", protocolVersion: WORKER_PROTOCOL_VERSION, allowedPids: [100] } as any,
    bindings as any
  );
  if (outcome.ok) {
    const title = outcome.result.windows[0].title as string;
    assert.ok(!/[\u0000-\u001F\u007F]/.test(title));
    assert.ok(title.length <= 200);
  } else {
    assert.fail("expected ok outcome");
  }
});

// ---------------------------------------------------------------------------
// capture: ownership revalidation, eligibility, exclusive write, encoding
// ---------------------------------------------------------------------------

function makeCaptureRequest(overrides: Record<string, unknown> = {}) {
  return {
    op: "capture",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    allowedPids: [100],
    nativeWindowId: 9,
    expectedPid: 100,
    format: "png",
    outPath: path.join(tmpdir(), `capture-${Date.now()}-${Math.random().toString(16).slice(2)}.png`),
    ...overrides
  };
}

async function runCapture(bindings: any, overrides: Record<string, unknown> = {}) {
  return handleRequest(makeCaptureRequest(overrides) as any, bindings as any);
}

test("capture succeeds with real fs write and reports source dimensions", async () => {
  const dir = tempDir();
  try {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const outPath = path.join(dir, "shot.png");
    const outcome = await runCapture(makeBindings([{ id: 9, pid: 100, imageBuffer: payload }]), { outPath });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.bytes, payload.byteLength);
      assert.equal(outcome.result.width, 320);
      assert.equal(outcome.result.height, 240);
      assert.equal(outcome.result.resized, false);
    }
    assert.deepEqual(readFileSync(outPath), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});



test("capture validates against the fresh enumeration: a PID change between requests is rejected", async () => {
  // Simulates Tauri hot reload: the native window id still exists, but the
  // owning process changed after the caller recorded expectedPid.
  const outcome = await runCapture(makeBindings([{ id: 9, pid: 200 }]), { expectedPid: 100 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, ERROR_CODES.windowNotOwned);
  }
});

test("capture rejects window ids that vanished from the fresh enumeration", async () => {
  // The worker holds no cached state between requests: only windows present in
  // the fresh Window.all() scan are eligible, so vanished ids fail closed.
  const outcome = await runCapture(makeBindings([]));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, ERROR_CODES.windowNotFound);
  }
});

test("capture rejects mismatched expectedPid but accepts matching owner", async () => {
  const mismatch = await runCapture(makeBindings([{ id: 9, pid: 100 }]), { expectedPid: 999 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.error.code, ERROR_CODES.windowNotOwned);
  }
  const match = await runCapture(makeBindings([{ id: 9, pid: 100 }]), { expectedPid: 100 });
  assert.equal(match.ok, true);
});

test("capture rejects a window owned by a PID outside the allowed set", async () => {
  const outcome = await runCapture(makeBindings([{ id: 9, pid: 200 }]));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, ERROR_CODES.windowNotOwned);
  }
});

test("capture rejects minimized and zero-size windows", async () => {
  for (const spec of [
    { id: 9, pid: 100, minimized: true },
    { id: 9, pid: 100, width: 0 },
    { id: 9, pid: 100, height: 0 }
  ]) {
    const outcome = await runCapture(makeBindings([spec]));
    assert.equal(outcome.ok, false, JSON.stringify(spec));
    if (!outcome.ok) {
      assert.equal(outcome.error.code, ERROR_CODES.windowIneligible);
    }
  }
});

test("capture reports encode failure when the binding returns no image", async () => {
  const outcome = await runCapture(makeBindings([{ id: 9, pid: 100, imageBuffer: null }]));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, ERROR_CODES.encodeFailed);
  }
});

test("capture routes through sharp only when resize or jpeg quality is requested", async () => {
  const dir = tempDir();
  try {
    const realSharp = (await import("sharp")).default;
    // A genuinely valid PNG produced by the installed sharp, so the sharp
    // pipeline under test receives decodable input.
    const validPng = await realSharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
      .png()
      .toBuffer();

    // No resize and PNG: sharp must not be touched (the injected sharp throws).
    const plain = await runCapture(
      makeBindings([{ id: 9, pid: 100, imageBuffer: validPng }], {}),
      { outPath: path.join(dir, "plain.png") }
    );
    assert.equal(plain.ok, true);
    assert.deepEqual(readFileSync(path.join(dir, "plain.png")), validPng);

    // JPEG quality + resize requires sharp; verify real quality/resize behavior.
    const jpegOutcome = await runCapture(
      makeBindings([{ id: 9, pid: 100, imageBuffer: validPng }], { sharp: realSharp }),
      {
        format: "jpeg",
        jpegQuality: 60,
        maxWidth: 100,
        maxHeight: 100,
        outPath: path.join(dir, "small.jpeg")
      }
    );
    assert.equal(jpegOutcome.ok, true);
    if (jpegOutcome.ok) {
      // Result metadata reports the captured window's source dimensions plus a
      // resized flag; final stored-file dimensions are verified from the file.
      assert.equal(jpegOutcome.result.resized, true);
      assert.equal(jpegOutcome.result.width, 320);
      assert.equal(jpegOutcome.result.height, 240);
    }
    const metadata = await realSharp(path.join(dir, "small.jpeg")).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.ok((metadata.width ?? 0) <= 100);
    assert.ok((metadata.height ?? 0) <= 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture reports image_processing_failed when sharp processing throws", async () => {
  const outcome = await runCapture(makeBindings([{ id: 9, pid: 100 }]), {
    maxWidth: 50,
    outPath: path.join(tempDir(), "never.png")
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, ERROR_CODES.imageProcessingFailed);
  }
});

test("capture validates the output path before touching the binding", async () => {
  const bindings = makeBindings([{ id: 9, pid: 100 }]);
  for (const [overrides, expectedCode] of [
    [{ outPath: "relative/out.png" }, ERROR_CODES.protocolError],
    [{ outPath: path.join(tmpdir(), "wrong.txt") }, ERROR_CODES.protocolError],
    [{ format: "jpeg", outPath: path.join(tmpdir(), "wrong.png") }, ERROR_CODES.protocolError]
  ] as Array<[Record<string, unknown>, string]>) {
    const outcome = await runCapture(bindings, overrides);
    assert.equal(outcome.ok, false, JSON.stringify(overrides));
    if (!outcome.ok) {
      assert.equal(outcome.error.code, expectedCode);
    }
  }
});

test("binding load failure yields binding_unavailable error for targets and capture", async () => {
  const failure = makeLoadFailure();
  const targets = await handleRequest(
    { op: "targets", protocolVersion: WORKER_PROTOCOL_VERSION, allowedPids: [1] } as any,
    failure as any
  );
  assert.equal(targets.ok, false);
  if (!targets.ok) {
    assert.equal(targets.error.code, ERROR_CODES.bindingUnavailable);
  }
  const capture = await runCapture(failure);
  assert.equal(capture.ok, false);
  if (!capture.ok) {
    assert.equal(capture.error.code, ERROR_CODES.bindingUnavailable);
  }
});

test("capabilities degrades gracefully when the binding cannot load", async () => {
  const outcome = await handleRequest(
    { op: "capabilities", protocolVersion: WORKER_PROTOCOL_VERSION } as any,
    makeLoadFailure() as any
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.bindingLoaded, false);
    assert.equal(outcome.result.captureAvailable, false);
    assert.equal(outcome.result.reason, ERROR_CODES.bindingUnavailable);
    assert.deepEqual(outcome.result.formats, ["png", "jpeg"]);
  }
});

test("capabilities reports availability when bindings load", async () => {
  const outcome = await handleRequest(
    { op: "capabilities", protocolVersion: WORKER_PROTOCOL_VERSION } as any,
    makeBindings([]) as any
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.bindingLoaded, true);
    assert.equal(outcome.result.captureAvailable, true);
  }
});

// ---------------------------------------------------------------------------
// Child-process contract: real worker over stdio
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(
  scriptPath: string,
  args: string[],
  input: string,
  timeoutMs = 15000
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Generous collection bound (well above the worker's own 256 KiB output
    // promise) so tests can observe and assert on oversize worker output.
    const collectCap = 2 * 1024 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < collectCap) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < collectCap) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function parseEnvelope(text: string): any {
  return JSON.parse(text);
}

test("worker contract: malformed stdin yields protocol_error and exit code 1", async () => {
  const result = await runProcess(workerPath, [], "{not valid json");
  assert.equal(result.code, 1);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.protocolError);
});

test("worker contract: empty stdin yields protocol_error and exit code 1", async () => {
  const result = await runProcess(workerPath, [], "");
  assert.equal(result.code, 1);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.error.code, ERROR_CODES.protocolError);
});

test("worker contract: unknown field is rejected end to end", async () => {
  const result = await runProcess(
    workerPath,
    [],
    JSON.stringify({
      op: "capabilities",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      injected: "field"
    })
  );
  assert.equal(result.code, 1);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.error.code, ERROR_CODES.protocolError);
});

test("worker contract: oversized input yields input_too_large without processing", async () => {
  const result = await runProcess(
    workerPath,
    [],
    JSON.stringify({
      op: "capabilities",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      pad: "x".repeat(MAX_INPUT_BYTES + 1)
    })
  );
  assert.equal(result.code, 1);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.error.code, "input_too_large");
});

test("worker contract: capabilities succeeds with the real native binding", async () => {
  const result = await runProcess(
    workerPath,
    [],
    JSON.stringify({ op: "capabilities", protocolVersion: WORKER_PROTOCOL_VERSION })
  );
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(typeof envelope.result.captureAvailable, "boolean");
  if (envelope.result.bindingLoaded === true) {
    // On this machine the binding must load; degraded platforms report bindingLoaded=false.
    assert.equal(envelope.result.captureAvailable, true);
    assert.deepEqual(envelope.result.formats, ["png", "jpeg"]);
  } else {
    assert.equal(envelope.result.reason, ERROR_CODES.bindingUnavailable);
  }
});

test("worker contract: targets with an impossible PID set returns an empty eligible list", async () => {
  const result = await runProcess(
    workerPath,
    [],
    JSON.stringify({
      op: "targets",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      allowedPids: [2147483000]
    })
  );
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.result.windows, []);
});

test("worker contract: capture with an unknown window id fails closed", async () => {
  const result = await runProcess(
    workerPath,
    [],
    JSON.stringify({
      op: "capture",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      allowedPids: [1],
      nativeWindowId: 987654321,
      expectedPid: 1,
      format: "png",
      outPath: path.join(tmpdir(), "never-written.png")
    })
  );
  assert.equal(result.code, 3);
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, ERROR_CODES.windowNotFound);
  assert.ok(!existsSync(path.join(tmpdir(), "never-written.png")));
});

// ---------------------------------------------------------------------------
// Child-process contract: scripted fixture for parent-side isolation behavior
// ---------------------------------------------------------------------------

test("fixture contract: a hanging worker is killed by the parent timeout", async () => {
  const result = await runProcess(fixturePath, ["delay:30000"], "", 500);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("fixture contract: an aborted worker produces no parseable envelope", async () => {
  const result = await runProcess(fixturePath, ["crash"], "");
  assert.ok(result.code === null || result.code !== 0);
  assert.throws(() => parseEnvelope(result.stdout));
});

test("fixture contract: partial output is detected as malformed JSON", async () => {
  const result = await runProcess(fixturePath, ["partial"], "");
  assert.throws(() => parseEnvelope(result.stdout), {
    name: "SyntaxError"
  });
});

test("fixture contract: oversized output is detectable against the output bound", async () => {
  const result = await runProcess(fixturePath, ["oversize"], "");
  // The envelope parses but exceeds the worker's own MAX_OUTPUT_BYTES promise,
  // which the Phase 2 launcher must treat as a protocol violation.
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, true);
  assert.ok(Buffer.byteLength(result.stdout) > 256 * 1024);
});

test("fixture contract: noise before the single-line envelope breaks strict parsing", async () => {
  const result = await runProcess(fixturePath, ["prefix-noise"], "");
  assert.throws(() => parseEnvelope(result.stdout));
});

test("fixture contract: capture-file omission is representable for Phase 2 verification", async () => {
  const result = await runProcess(fixturePath, ["capture-file-omission"], "");
  const envelope = parseEnvelope(result.stdout);
  assert.equal(envelope.ok, true);
  // The launcher must stat the declared output path and fail this capture.
  assert.equal(typeof envelope.result.bytes, "number");
});



