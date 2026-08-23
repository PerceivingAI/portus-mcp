/**
 * Deep screenshot runtime.
 *
 * Owns execution-session ownership checks, opaque window tokens, worker
 * launches, repository-local storage under `.portus-artifacts/screenshots`,
 * publication, read, list, explicit deletion, and audit events. Complexity is
 * kept behind a small operation interface; worker-launch, clock, random, and
 * PID-enumeration dependencies are injectable so tests replace side effects
 * without a public adapter hierarchy.
 *
 * Security invariants (notes/SCREENSHOTS_PLAN.md):
 * - only windows owned by the selected running execution session are eligible;
 * - the allowed PID set is rebuilt fresh for every worker launch;
 * - native window ids and PIDs never leave this module through results;
 * - screenshot paths derive only from validated session ids and generated
 *   filenames, revalidated through canonical project containment on every use;
 * - image bytes are validated (signature, dimensions, size) before
 *   publication and again before read;
 * - capture publication and explicit deletion are serialized per project;
 * - audit events omit titles, PIDs, native ids, and absolute paths.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { stateStore } from "../state/StateStore.js";
import { getExecutionSessionOwnership, terminateExecutionSession, type ExecutionSessionOwnership } from "./executionSessions.js";
import {
  getPosixSessionProcessSnapshot,
  getWindowsSessionProcessSnapshot,
  type SessionProcessSnapshot
} from "./processTermination.js";

export const SCREENSHOT_STORAGE_DIR = ".portus-artifacts/screenshots";
const WORKER_PROTOCOL_VERSION = 1;

export type ScreenshotFormat = "png" | "jpeg";

export type ScreenshotLimits = {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  captureTimeoutMs: number;
  maxWindowWaitMs: number;
  windowTokenTtlMs: number;
  maxListPageSize: number;
  minJpegQuality: number;
  maxJpegQuality: number;
};

export const DEFAULT_SCREENSHOT_LIMITS: ScreenshotLimits = {
  maxBytes: 8388608,
  maxWidth: 3840,
  maxHeight: 2160,
  captureTimeoutMs: 10000,
  maxWindowWaitMs: 30000,
  windowTokenTtlMs: 30000,
  maxListPageSize: 100,
  minJpegQuality: 50,
  maxJpegQuality: 95
};

export const SCREENSHOT_ERROR_CODES = {
  invalidSessionId: "invalid_session_id",
  unknownSession: "unknown_session",
  sessionProjectMismatch: "session_project_mismatch",
  confirmationRequired: "confirmation_required",
  sessionNotRunning: "session_not_running",
  rootPidUnavailable: "root_pid_unavailable",
  processIdentityMismatch: "process_identity_mismatch",
  invalidScreenshotId: "invalid_screenshot_id",
  invalidCursor: "invalid_cursor",
  screenshotNotFound: "screenshot_not_found",
  screenshotTooLarge: "screenshot_too_large",
  sessionWindowNotFound: "session_window_not_found",
  multipleSessionWindows: "multiple_session_windows",
  windowTokenInvalid: "window_token_invalid",
  staleSessionWindow: "stale_session_window",
  sessionWindowOwnershipChanged: "session_window_ownership_changed",
  windowIneligible: "window_ineligible",
  windowTokenExpired: "window_token_expired",
  workerTimeout: "screenshot_worker_timeout",
  workerFailed: "screenshot_worker_failed",
  protocolError: "screenshot_worker_protocol_error",
  bindingUnavailable: "screenshot_binding_unavailable",
  invalidImageData: "invalid_image_data",
  imageBoundsExceeded: "image_bounds_exceeded",
  invalidCaptureOptions: "invalid_capture_options",
  unsupportedSessionWindowCapture: "unsupported_session_window_capture",
} as const;

export class ScreenshotError extends ToolError {
  readonly code: string;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message, { code, ...details });
    this.code = code;
    this.name = "ScreenshotError";
  }
}

// ---- Worker protocol (mirrors scripts/screenshot-worker.mjs) ----

export type WorkerWindowInfo = {
  nativeWindowId: number;
  pid: number;
  appName: string;
  title: string;
  width: number;
  height: number;
};

export type WorkerRequest =
  | { op: "capabilities"; protocolVersion: 1 }
  | { op: "targets"; protocolVersion: 1; allowedPids: number[] }
  | {
      op: "capture";
      protocolVersion: 1;
      allowedPids: number[];
      nativeWindowId: number;
      expectedPid: number;
      format: ScreenshotFormat;
      maxBytes: number;
      jpegQuality?: number;
      maxWidth?: number;
      maxHeight?: number;
      outPath: string;
    };

export type WorkerOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export type ScreenshotWorkerLauncher = (
  request: WorkerRequest,
  timeoutMs: number
) => Promise<WorkerOutcome>;

const workerEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z
      .object({ code: z.string().min(1).max(64), message: z.string().max(500) })
      .strict()
  }).strict()
]);

const workerWindowSchema = z.object({
  nativeWindowId: z.number().int().positive(),
  pid: z.number().int().positive(),
  appName: z.string().max(256),
  title: z.string().max(256),
  width: z.number().int().positive(),
  height: z.number().int().positive()
}).strict();

const targetsResultSchema = z.object({ windows: z.array(workerWindowSchema).max(256) }).strict();

const capabilitiesResultSchema = z.object({
  captureAvailable: z.boolean(),
  reason: z.string().min(1).max(64).optional()
}).passthrough();

const captureResultSchema = z.object({
  nativeWindowId: z.number().int().positive(),
  pid: z.number().int().positive(),
  format: z.enum(["png", "jpeg"]),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().positive(),
  resized: z.boolean()
}).strict();

// ---- Storage name helpers ----

/** UTC compact timestamp, e.g. 20260822T121514Z; sorts lexicographically newest-first. */
function formatUtcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const GENERATED_NAME_RE = /^\d{8}T\d{6}Z_[0-9a-f]{8}\.(png|jpeg)$/;
const SESSION_ID_RE = /^exec_[0-9]+_[0-9a-f]{6,16}$/;

function capturedAtMsFromName(name: string): number | null {
  const stamp = name.slice(0, 16);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && formatUtcStamp(parsed) === stamp ? parsed : null;
}

function encodeListCursor(screenshotId: string): string {
  return `v1.${Buffer.from(screenshotId, "utf8").toString("base64url")}`;
}

function decodeListCursor(cursor: string): string {
  if (!cursor.startsWith("v1.")) {
    throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCursor, "Malformed screenshot list cursor.");
  }
  let screenshotId: string;
  try {
    screenshotId = Buffer.from(cursor.slice(3), "base64url").toString("utf8");
  } catch {
    throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCursor, "Malformed screenshot list cursor.");
  }
  if (
    encodeListCursor(screenshotId) !== cursor
    || !GENERATED_NAME_RE.test(screenshotId)
    || capturedAtMsFromName(screenshotId) === null
  ) {
    throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCursor, "Malformed screenshot list cursor.");
  }
  return screenshotId;
}

// ---- Image validation ----

export type ImageDimensions = { width: number; height: number };

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24) return null;
  const signatureOk =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (!signatureOk) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 <= bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01 || marker === 0xff) {
      pos += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(pos + 5), width: bytes.readUInt16BE(pos + 7) };
    }
    const segmentLength = bytes.readUInt16BE(pos + 2);
    if (segmentLength < 2) return null;
    pos += 2 + segmentLength;
  }
  return null;
}

/**
 * Validates signature and decodes dimensions for the declared format.
 * Returns null when the bytes do not match the format's signature or the
 * header cannot be parsed; callers treat null as untrusted data.
 */
export function validateImageBytes(bytes: Buffer, format: ScreenshotFormat): ImageDimensions | null {
  const dims = format === "png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dims || dims.width <= 0 || dims.height <= 0) return null;
  return dims;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- Opaque window token store ----

type WindowToken = {
  projectAlias: string;
  sessionId: string;
  nativeWindowId: number;
  ownerPid: number;
  expiresAtMs: number;
};

class WindowTokenStore {
  private readonly tokens = new Map<string, WindowToken>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly randomHex: (bytes: number) => string,
    private readonly maxTokens = 512
  ) {}

  issue(projectAlias: string, sessionId: string, window: { nativeWindowId: number; pid: number }): string {
    this.purgeExpired();
    while (this.tokens.size >= this.maxTokens) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    let windowId = this.randomHex(16);
    while (this.tokens.has(windowId)) windowId = this.randomHex(16);
    this.tokens.set(windowId, {
      projectAlias,
      sessionId,
      nativeWindowId: window.nativeWindowId,
      ownerPid: window.pid,
      expiresAtMs: this.now() + this.ttlMs
    });
    return windowId;
  }

  resolve(windowId: string, projectAlias: string, sessionId: string): { nativeWindowId: number; ownerPid: number } {
    const token = this.tokens.get(windowId);
    if (!token || token.projectAlias !== projectAlias || token.sessionId !== sessionId) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.windowTokenInvalid, "Unknown or mismatched window token.");
    }
    if (this.now() >= token.expiresAtMs) {
      this.tokens.delete(windowId);
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.windowTokenExpired, "Window token expired; list targets again.");
    }
    return { nativeWindowId: token.nativeWindowId, ownerPid: token.ownerPid };
  }

  drop(windowId: string): void {
    this.tokens.delete(windowId);
  }

  dropSession(sessionId: string): void {
    for (const [id, token] of this.tokens) {
      if (token.sessionId === sessionId) this.tokens.delete(id);
    }
  }

  private purgeExpired(): void {
    const nowMs = this.now();
    for (const [id, token] of this.tokens) {
      if (nowMs >= token.expiresAtMs) this.tokens.delete(id);
    }
  }
}

// ---- Default injectable dependency implementations ----

export type AllowedPidSetBuilder = (session: ExecutionSessionOwnership) => Promise<number[]>;

const PROCESS_START_TOLERANCE_MS = 10_000;

export function attestSessionProcessSnapshot(
  session: ExecutionSessionOwnership,
  snapshot: SessionProcessSnapshot
): number[] {
  if (
    session.pid === undefined
    || snapshot.rootPid !== session.pid
    || !Number.isFinite(session.startedAtMs)
    || Math.abs(snapshot.rootStartedAtMs - session.startedAtMs) > PROCESS_START_TOLERANCE_MS
  ) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.processIdentityMismatch,
      "Execution-session process identity no longer matches the recorded launch."
    );
  }
  const allowed = Array.from(new Set(snapshot.allowedPids.filter((pid) => Number.isInteger(pid) && pid > 0)));
  if (!allowed.includes(session.pid)) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.processIdentityMismatch,
      "Execution-session root process is absent from the attested process set."
    );
  }
  return allowed;
}

/** Builds a fresh, start-time-attested process set for every worker launch. */
export const defaultBuildAllowedPids: AllowedPidSetBuilder = async (session) => {
  if (!session.pid) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.rootPidUnavailable,
      "Execution session has no root process; capture is unavailable."
    );
  }
  let snapshot: SessionProcessSnapshot | null;
  try {
    snapshot = process.platform === "win32"
      ? await getWindowsSessionProcessSnapshot(session.pid)
      : await getPosixSessionProcessSnapshot(session.pid);
  } catch {
    snapshot = null;
  }
  if (snapshot === null) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.rootPidUnavailable,
      "Execution-session root process could not be attested."
    );
  }
  return attestSessionProcessSnapshot(session, snapshot);
};

function resolveWorkerScriptPath(): string {
  return fileURLToPath(new URL("../../scripts/screenshot-worker.mjs", import.meta.url));
}

const WORKER_STDIN_CAP_BYTES = 256 * 1024;
// Slightly above the worker's own output promise so overflow is observable.
const WORKER_STDOUT_CAP_BYTES = 320 * 1024;
const WORKER_STDERR_CAP_BYTES = 64 * 1024;

function fail(code: string, message: string): WorkerOutcome {
  return { ok: false, error: { code, message } };
}

/**
 * Launches the checked-in Node worker with execFile semantics: no shell,
 * bounded stdio, fixed timeout. Native crashes terminate the worker, never
 * the MCP server. Malformed or oversized protocol output maps to stable
 * error codes.
 */
export const defaultLaunchWorker: ScreenshotWorkerLauncher = (request, timeoutMs) =>
  new Promise<WorkerOutcome>((resolve) => {
    const scriptPath = resolveWorkerScriptPath();
    if (!existsSync(scriptPath)) {
      resolve(fail(SCREENSHOT_ERROR_CODES.bindingUnavailable, "Screenshot worker script is missing."));
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let settled = false;

    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (spawnError) {
        resolve(fail(SCREENSHOT_ERROR_CODES.workerFailed, "Screenshot worker could not be started."));
        return;
      }
      if (timedOut) {
        resolve(fail(SCREENSHOT_ERROR_CODES.workerTimeout, "Screenshot worker exceeded its time budget."));
        return;
      }
      if (stdoutOverflow) {
        resolve(fail(SCREENSHOT_ERROR_CODES.protocolError, "Worker result exceeded output bounds."));
        return;
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(stdout);
      } catch {
        resolve(fail(SCREENSHOT_ERROR_CODES.protocolError, "Worker produced malformed JSON output."));
        return;
      }
      const envelope = workerEnvelopeSchema.safeParse(candidate);
      if (!envelope.success) {
        resolve(fail(SCREENSHOT_ERROR_CODES.protocolError, "Worker output failed schema validation."));
        return;
      }
      if (!envelope.data.ok) {
        resolve({ ok: false, error: envelope.data.error });
        return;
      }
      if (child.exitCode !== 0) {
        resolve(fail(SCREENSHOT_ERROR_CODES.protocolError, "Worker reported success but exited nonzero."));
        return;
      }
      resolve({ ok: true, result: envelope.data.result });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < WORKER_STDOUT_CAP_BYTES) stdout += chunk.toString("utf8");
      else stdoutOverflow = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < WORKER_STDERR_CAP_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      spawnError = error;
    });
    child.on("close", () => finish());

    const payload = JSON.stringify(request);
    child.stdin.on("error", () => undefined); // EPIPE when the worker dies early; close handles it.
    if (Buffer.byteLength(payload, "utf8") > WORKER_STDIN_CAP_BYTES) {
      child.kill();
      resolve(fail(SCREENSHOT_ERROR_CODES.protocolError, "Worker request exceeded input bounds."));
      return;
    }
    child.stdin.end(payload);
    void stderr;
  });

// ---- Screenshot system factory ----

export type CaptureOptions = {
  closeSession: boolean;
  windowId?: string;
  waitForWindowMs?: number;
  format?: ScreenshotFormat;
  jpegQuality?: number;
  maxWidth?: number;
  maxHeight?: number;
};

export type CaptureResult = {
  screenshotId: string;
  format: ScreenshotFormat;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  capturedAt: string;
  resized: boolean;
  sessionClosed: boolean;
};

export type TargetCandidate = {
  windowId: string;
  title: string;
  appName: string;
  width: number;
  height: number;
};

export type ScreenshotMeta = {
  screenshotId: string;
  format: ScreenshotFormat;
  width: number | null;
  height: number | null;
  bytes: number;
  capturedAt: string;
  sha256?: string;
};

export type ScreenshotOperation = "targets" | "capture" | "read" | "list" | "delete";

export type ScreenshotCapabilities = {
  enabled: boolean;
  operations: ScreenshotOperation[];
};

export type ScreenshotSystem = {
  getCapabilities(): ScreenshotCapabilities;
  /** Probes (once per generation) whether the native binding supports capture. */
  ensureBindingAvailability(): Promise<boolean>;
  refreshBindingAvailability(): void;
  listTargets(projectAlias: string, executionSessionId: string): Promise<TargetCandidate[]>;
  capture(
    projectAlias: string,
    executionSessionId: string,
    options?: CaptureOptions
  ): Promise<CaptureResult>;
  read(
    projectAlias: string,
    executionSessionId: string,
    screenshotId: string,
    options?: { audit?: boolean }
  ): Promise<{ meta: ScreenshotMeta; data: Buffer }>;
  list(
    projectAlias: string,
    executionSessionId: string,
    page?: { cursor?: string; limit?: number }
  ): Promise<{ items: ScreenshotMeta[]; nextCursor: string | null; total: number }>;
  deleteScreenshot(projectAlias: string, executionSessionId: string, screenshotId: string): Promise<void>;
};

export function createScreenshotSystem(deps: {
  launchWorker?: ScreenshotWorkerLauncher;
  buildAllowedPids?: AllowedPidSetBuilder;
  limits?: ScreenshotLimits;
  now?: () => number;
  randomHex?: (bytes: number) => string;
  subscribeSessionExit?: (listener: (sessionId: string) => void) => () => void;
  terminateSession?: (sessionId: string) => Promise<unknown>;
} = {}): ScreenshotSystem {
  const limits = deps.limits ?? DEFAULT_SCREENSHOT_LIMITS;
  const now = deps.now ?? Date.now;
  const launchWorker = deps.launchWorker ?? defaultLaunchWorker;
  const buildAllowedPids = deps.buildAllowedPids ?? defaultBuildAllowedPids;
  const terminateSession = deps.terminateSession ?? terminateExecutionSession;
  const randomHex = deps.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const tokens = new WindowTokenStore(limits.windowTokenTtlMs, now, randomHex);
  deps.subscribeSessionExit?.((sessionId) => tokens.dropSession(sessionId));
  const projectLocks = new Map<string, Promise<unknown>>();
  let bindingAvailable: boolean | null = null;
  let bindingProbe: Promise<boolean> | null = null;

  function audit(action: string, fields: Record<string, unknown>): void {
    stateStore.audit({ tool: "project_screenshot", action, ...fields });
  }

  function runExclusive<T>(projectAlias: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = projectLocks.get(projectAlias) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    projectLocks.set(projectAlias, next.catch(() => undefined));
    return next;
  }

  function requireSession(projectAlias: string, executionSessionId: string): ExecutionSessionOwnership {
    if (!SESSION_ID_RE.test(executionSessionId)) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidSessionId, "Malformed execution session id.");
    }
    const session = getExecutionSessionOwnership(executionSessionId);
    if (!session) throw new ScreenshotError(SCREENSHOT_ERROR_CODES.unknownSession, "Unknown execution session.");
    if (session.projectAlias !== projectAlias) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.sessionProjectMismatch, "Execution session belongs to a different project.");
    }
    return session;
  }

  function requireLiveSession(projectAlias: string, executionSessionId: string): ExecutionSessionOwnership {
    const session = requireSession(projectAlias, executionSessionId);
    if (session.status !== "running") {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.sessionNotRunning, "Execution session is not running.");
    }
    return session;
  }

  function resolveScreenshotFile(projectAlias: string, sessionId: string, name: string): string {
    return resolveProjectPath(projectAlias, `${SCREENSHOT_STORAGE_DIR}/${sessionId}/${name}`);
  }

  function sessionDir(projectAlias: string, sessionId: string, create: boolean): string {
    const relativeDir = `${SCREENSHOT_STORAGE_DIR}/${sessionId}`;
    let dir = resolveProjectPath(projectAlias, relativeDir);
    if (create) {
      mkdirSync(dir, { recursive: true });
      dir = resolveProjectPath(projectAlias, relativeDir);
    }
    return dir;
  }

  function readBoundedFile(filePath: string, tooLargeCode: string): Buffer {
    const descriptor = openSync(filePath, "r");
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile()) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidImageData, "Managed screenshot path is not a regular file.");
      }
      if (before.size > limits.maxBytes) {
        throw new ScreenshotError(tooLargeCode, "Stored screenshot exceeds the byte limit.");
      }
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      const after = fstatSync(descriptor);
      if (offset !== before.size || after.size !== before.size) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidImageData, "Managed screenshot changed while it was being read.");
      }
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  }

  interface GeneratedFile {
    name: string;
    sessionId: string;
    capturedAtMs: number;
    bytes: number;
  }

  function listGeneratedFiles(projectAlias: string, sessionId: string): GeneratedFile[] {
    if (!SESSION_ID_RE.test(sessionId)) return [];
    let dir: string;
    try {
      dir = sessionDir(projectAlias, sessionId, false);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    } catch {
      return [];
    }
    const files: GeneratedFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !GENERATED_NAME_RE.test(entry.name)) continue;
      const capturedAtMs = capturedAtMsFromName(entry.name);
      if (capturedAtMs === null) continue;
      try {
        const filePath = resolveScreenshotFile(projectAlias, sessionId, entry.name);
        const stats = statSync(filePath);
        if (!stats.isFile()) continue;
        files.push({ name: entry.name, sessionId, capturedAtMs, bytes: stats.size });
      } catch {
        // Repository contents changed during the scan.
      }
    }
    return files;
  }

  function mapWorkerFailure(error: { code: string; message: string }): ScreenshotError {
    switch (error.code) {
      case SCREENSHOT_ERROR_CODES.workerTimeout:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.workerTimeout, error.message);
      case SCREENSHOT_ERROR_CODES.bindingUnavailable:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.bindingUnavailable, error.message);
      case SCREENSHOT_ERROR_CODES.unsupportedSessionWindowCapture:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.unsupportedSessionWindowCapture, error.message);
      case "window_not_found":
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.staleSessionWindow, error.message);
      case "window_not_owned":
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.sessionWindowOwnershipChanged, error.message);
      case "window_ineligible":
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.windowIneligible, error.message);
      case "protocol_error":
      case "input_too_large":
      case "output_too_large":
      case SCREENSHOT_ERROR_CODES.protocolError:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.protocolError, error.message);
      case SCREENSHOT_ERROR_CODES.imageBoundsExceeded:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.imageBoundsExceeded, error.message);
      case "encode_failed":
      case "image_processing_failed":
      case "output_write_failed":
      case "worker_internal":
        return new ScreenshotError(error.code, error.message);
      default:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.workerFailed, "Screenshot worker failed.");
    }
  }

  async function listEligibleWindows(session: ExecutionSessionOwnership): Promise<WorkerWindowInfo[]> {
    const allowedPids = await buildAllowedPids(session);
    const outcome = await launchWorker({ op: "targets", protocolVersion: WORKER_PROTOCOL_VERSION, allowedPids }, limits.captureTimeoutMs);
    if (!outcome.ok) throw mapWorkerFailure(outcome.error);
    const parsed = targetsResultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.protocolError, "Worker targets result failed validation.");
    }
    return parsed.data.windows;
  }

  async function listTargets(projectAlias: string, executionSessionId: string): Promise<TargetCandidate[]> {
    const session = requireLiveSession(projectAlias, executionSessionId);
    return listEligibleWindows(session).then((windows) =>
      windows.map((window) => ({
        windowId: tokens.issue(projectAlias, session.sessionId, window),
        title: window.title,
        appName: window.appName,
        width: window.width,
        height: window.height
      }))
    );
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function capture(
    projectAlias: string,
    executionSessionId: string,
    options: Partial<CaptureOptions> = {}
  ): Promise<CaptureResult> {
    const session = requireLiveSession(projectAlias, executionSessionId);
    const closeSession = Boolean(options.closeSession);
    const format: ScreenshotFormat = options.format ?? "png";
    if (format !== "png" && format !== "jpeg") {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCaptureOptions, "Unsupported capture format.");
    }
    const jpegQuality =
      options.jpegQuality === undefined ? undefined : Math.trunc(options.jpegQuality);
    if (
      jpegQuality !== undefined &&
      (!Number.isInteger(jpegQuality) || jpegQuality < limits.minJpegQuality || jpegQuality > limits.maxJpegQuality)
    ) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCaptureOptions, "JPEG quality outside policy bounds.");
    }
    for (const key of ["maxWidth", "maxHeight"] as const) {
      const value = options[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1 || value > (key === "maxWidth" ? limits.maxWidth : limits.maxHeight)) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCaptureOptions, `Bounded ${key} exceeded.`);
      }
    }
    const waitForWindowMs = options.waitForWindowMs ?? 0;
    if (!Number.isInteger(waitForWindowMs) || waitForWindowMs < 0 || waitForWindowMs > limits.maxWindowWaitMs) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCaptureOptions, "waitForWindowMs outside bounds.");
    }

    let nativeWindowId: number;
    let ownerPid: number;
    let usedWindowId: string | null = null;

    if (options.windowId !== undefined) {
      const token = tokens.resolve(options.windowId, projectAlias, session.sessionId);
      nativeWindowId = token.nativeWindowId;
      ownerPid = token.ownerPid;
      usedWindowId = options.windowId;
    } else {
      const deadline = now() + waitForWindowMs;
      for (;;) {
        const windows = await listEligibleWindows(session);
        if (windows.length === 1) {
          nativeWindowId = windows[0].nativeWindowId;
          ownerPid = windows[0].pid;
          break;
        }
        if (windows.length > 1) {
          throw new ScreenshotError(
            SCREENSHOT_ERROR_CODES.multipleSessionWindows,
            "Several session-owned windows are eligible; pick a target.",
            {
              candidates: windows.map((window) => ({
                windowId: tokens.issue(projectAlias, session.sessionId, window),
                title: window.title,
                appName: window.appName,
                width: window.width,
                height: window.height
              }))
            }
          );
        }
        if (now() >= deadline) {
          throw new ScreenshotError(SCREENSHOT_ERROR_CODES.sessionWindowNotFound, "No eligible session window found.");
        }
        await delay(Math.min(250, Math.max(1, deadline - now())));
      }
    }

    return runExclusive(projectAlias, () =>
      publishCapture(projectAlias, session.sessionId, {
        nativeWindowId,
        ownerPid,
        closeSession,
        format,
        jpegQuality,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        windowId: usedWindowId
      })
    );
  }

  async function publishCapture(
    projectAlias: string,
    sessionId: string,
    target: {
      nativeWindowId: number;
      ownerPid: number;
      closeSession: boolean;
      format: ScreenshotFormat;
      jpegQuality?: number;
      maxWidth?: number;
      maxHeight?: number;
      windowId: string | null;
    }
  ): Promise<CaptureResult> {
    sessionDir(projectAlias, sessionId, true);
    const extension = target.format === "png" ? "png" : "jpeg";
    let finalName = `${formatUtcStamp(now())}_${randomHex(4)}.${extension}`;
    while (existsSync(resolveScreenshotFile(projectAlias, sessionId, finalName))) {
      finalName = `${formatUtcStamp(now())}_${randomHex(4)}.${extension}`;
    }
    let tempName = `pending_${randomHex(4)}.${extension}`;
    while (existsSync(resolveScreenshotFile(projectAlias, sessionId, tempName))) {
      tempName = `pending_${randomHex(4)}.${extension}`;
    }
    const tempPath = resolveScreenshotFile(projectAlias, sessionId, tempName);
    let published = false;

    try {
      const liveSession = requireLiveSession(projectAlias, sessionId);
      const request: WorkerRequest = {
        op: "capture",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        allowedPids: await buildAllowedPids(liveSession),
        nativeWindowId: target.nativeWindowId,
        expectedPid: target.ownerPid,
        format: target.format,
        maxBytes: limits.maxBytes,
        outPath: tempPath,
        ...(target.jpegQuality !== undefined ? { jpegQuality: target.jpegQuality } : {}),
        ...(target.maxWidth !== undefined ? { maxWidth: target.maxWidth } : {}),
        ...(target.maxHeight !== undefined ? { maxHeight: target.maxHeight } : {})
      };
      const outcome = await launchWorker(request, limits.captureTimeoutMs);
      if (!outcome.ok) {
        if (target.windowId && (outcome.error.code === "window_not_found" || outcome.error.code === "window_not_owned")) {
          tokens.drop(target.windowId);
        }
        throw mapWorkerFailure(outcome.error);
      }
      const parsed = captureResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.protocolError, "Worker capture result failed validation.");
      }

      if (!existsSync(tempPath)) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.workerFailed, "Worker reported success without writing an image file.");
      }
      const bytes = readBoundedFile(tempPath, SCREENSHOT_ERROR_CODES.imageBoundsExceeded);
      const dims = validateImageBytes(bytes, target.format);
      if (!dims) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidImageData, "Encoded image failed signature validation.");
      }
      if (dims.width > limits.maxWidth || dims.height > limits.maxHeight) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.imageBoundsExceeded, "Captured image exceeds dimension limits.");
      }

      const finalPath = resolveScreenshotFile(projectAlias, sessionId, finalName);
      if (existsSync(finalPath)) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.workerFailed, "Generated screenshot name collided; retry.");
      }
      renameSync(tempPath, finalPath);
      published = true;

      audit("capture", {
        projectAlias,
        sessionId,
        screenshotId: finalName,
        format: target.format,
        bytes: bytes.length,
        sessionClosed: target.closeSession
      });
      const capturedAtMs = capturedAtMsFromName(finalName);
      if (capturedAtMs === null) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.workerFailed, "Generated screenshot timestamp was invalid.");
      }

      let sessionClosed = false;
      if (target.closeSession) {
        await terminateSession(sessionId);
        sessionClosed = true;
      }

      return {
        screenshotId: finalName,
        format: target.format,
        width: dims.width,
        height: dims.height,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        capturedAt: new Date(capturedAtMs).toISOString(),
        resized: parsed.data.resized,
        sessionClosed
      };
    } finally {
      if (!published) {
        try {
          const pendingPath = resolveScreenshotFile(projectAlias, sessionId, tempName);
          if (existsSync(pendingPath)) unlinkSync(pendingPath);
        } catch {
          // Never follow a repository-controlled path outside canonical containment.
        }
      }
    }
  }

  function parseScreenshotName(projectAlias: string, sessionId: string, screenshotId: string): { path: string; format: ScreenshotFormat; capturedAtMs: number } {
    const capturedAtMs = capturedAtMsFromName(screenshotId);
    if (!GENERATED_NAME_RE.test(screenshotId) || capturedAtMs === null) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidScreenshotId, "Malformed screenshot id.");
    }
    return {
      path: resolveScreenshotFile(projectAlias, sessionId, screenshotId),
      format: screenshotId.endsWith(".png") ? "png" : "jpeg",
      capturedAtMs
    };
  }

  async function read(
    projectAlias: string,
    executionSessionId: string,
    screenshotId: string,
    options?: { audit?: boolean }
  ): Promise<{ meta: ScreenshotMeta; data: Buffer }> {
    const session = requireSession(projectAlias, executionSessionId);
    const parsedName = parseScreenshotName(projectAlias, session.sessionId, screenshotId);
    if (!existsSync(parsedName.path)) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.screenshotNotFound, "Screenshot not found.");
    }
    const bytes = readBoundedFile(parsedName.path, SCREENSHOT_ERROR_CODES.screenshotTooLarge);
    const dims = validateImageBytes(bytes, parsedName.format);
    if (!dims) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidImageData, "Stored image failed signature validation.");
    }
    if (dims.width > limits.maxWidth || dims.height > limits.maxHeight) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.imageBoundsExceeded, "Stored screenshot exceeds dimension limits.");
    }
    if (options?.audit !== false) {
      audit("read", { projectAlias, sessionId: session.sessionId, screenshotId, format: parsedName.format });
    }
    return {
      meta: {
        screenshotId,
        format: parsedName.format,
        width: dims.width,
        height: dims.height,
        bytes: bytes.length,
        capturedAt: new Date(parsedName.capturedAtMs).toISOString(),
        sha256: sha256Hex(bytes)
      },
      data: bytes
    };
  }

  function buildMeta(projectAlias: string, file: GeneratedFile): ScreenshotMeta {
    const format: ScreenshotFormat = file.name.endsWith(".png") ? "png" : "jpeg";
    let dims: ImageDimensions | null = null;
    if (file.bytes > 0 && file.bytes <= limits.maxBytes) {
      let descriptor: number | null = null;
      try {
        const headerPath = resolveScreenshotFile(projectAlias, file.sessionId, file.name);
        descriptor = openSync(headerPath, "r");
        const stats = fstatSync(descriptor);
        if (stats.isFile() && stats.size === file.bytes) {
          const header = Buffer.allocUnsafe(Math.min(file.bytes, 512 * 1024));
          const bytesRead = readSync(descriptor, header, 0, header.length, 0);
          dims = validateImageBytes(header.subarray(0, bytesRead), format);
          if (dims && (dims.width > limits.maxWidth || dims.height > limits.maxHeight)) dims = null;
        }
      } catch {
        dims = null;
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
    }
    return {
      screenshotId: file.name,
      format,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      bytes: file.bytes,
      capturedAt: new Date(file.capturedAtMs).toISOString()
    };
  }

  function list(
    projectAlias: string,
    executionSessionId: string,
    page?: { cursor?: string; limit?: number }
  ): { items: ScreenshotMeta[]; nextCursor: string | null; total: number } {
    const session = requireSession(projectAlias, executionSessionId);
    const limit = Math.min(Math.max(1, page?.limit ?? limits.maxListPageSize), limits.maxListPageSize);
    const files = listGeneratedFiles(projectAlias, session.sessionId)
      .sort((a, b) => b.capturedAtMs - a.capturedAtMs || (a.name < b.name ? 1 : -1));
    let startIndex = 0;
    if (page?.cursor) {
      const cursorName = decodeListCursor(page.cursor);
      const cursorIndex = files.findIndex((file) => file.name === cursorName);
      if (cursorIndex < 0) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidCursor, "Screenshot list cursor is no longer valid.");
      }
      startIndex = cursorIndex + 1;
    }
    const pageFiles = files.slice(startIndex, startIndex + limit);
    audit("list", { projectAlias, sessionId: session.sessionId, count: pageFiles.length });
    return {
      items: pageFiles.map((file) => buildMeta(projectAlias, file)),
      nextCursor:
        pageFiles.length === limit && startIndex + limit < files.length
          ? encodeListCursor(pageFiles[pageFiles.length - 1].name)
          : null,
      total: files.length
    };
  }

  async function deleteScreenshot(projectAlias: string, executionSessionId: string, screenshotId: string): Promise<void> {
    await runExclusive(projectAlias, () => {
      const session = requireSession(projectAlias, executionSessionId);
      const parsedName = parseScreenshotName(projectAlias, session.sessionId, screenshotId);
      const filePath = parsedName.path;
      if (!existsSync(filePath)) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.screenshotNotFound, "Screenshot not found.");
      }
      unlinkSync(filePath);
      audit("delete", { projectAlias, sessionId: session.sessionId, screenshotId });
    });
  }

  function getCapabilities(): ScreenshotCapabilities {
    const captureReady = bindingAvailable === true;
    return {
      enabled: true,
      operations: captureReady ? ["targets", "capture", "read", "list", "delete"] : ["read", "list", "delete"]
    };
  }

  function ensureBindingAvailability(): Promise<boolean> {
    bindingProbe ??= (async () => {
      try {
        const outcome = await launchWorker({ op: "capabilities", protocolVersion: WORKER_PROTOCOL_VERSION }, 5000);
        if (!outcome.ok) {
          bindingAvailable = false;
          return false;
        }
        const parsed = capabilitiesResultSchema.safeParse(outcome.result);
        if (!parsed.success) {
          bindingAvailable = false;
          return false;
        }
        bindingAvailable = parsed.data.captureAvailable;
        return bindingAvailable;
      } catch {
        bindingAvailable = false;
        return false;
      }
    })();
    return bindingProbe;
  }
  return {
    getCapabilities,
    ensureBindingAvailability,
    refreshBindingAvailability: () => {
      bindingProbe = null;
      bindingAvailable = null;
    },
    listTargets,
    capture,
    read: async (projectAlias, executionSessionId, screenshotId, options) =>
      read(projectAlias, executionSessionId, screenshotId, options),
    list: async (projectAlias, executionSessionId, page) => list(projectAlias, executionSessionId, page),
    deleteScreenshot
  };
}

/** Default system instance wired to the real worker launcher and PID-set builder. */
export const screenshotSystem = createScreenshotSystem();











