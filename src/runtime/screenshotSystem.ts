/**
 * Deep screenshot runtime.
 *
 * Owns execution-session ownership checks, opaque window tokens, worker
 * launches, repository-local storage under `.portus-artifacts/screenshots`,
 * publication/read/list/delete, retention, and audit events. Complexity is
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
 * - mutation and retention are serialized per project;
 * - audit events omit titles, PIDs, native ids, and absolute paths.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { stateStore } from "../state/StateStore.js";
import { getExecutionSessionOwnership, type ExecutionSessionOwnership } from "./executionSessions.js";
import { getPosixDescendants, getWindowsDescendants, isProcessAlive } from "./processTermination.js";

export const SCREENSHOT_STORAGE_DIR = ".portus-artifacts/screenshots";
const WORKER_PROTOCOL_VERSION = 1;

export type ScreenshotFormat = "png" | "jpeg";

export type ScreenshotLimits = {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxStoredFilesPerSession: number;
  maxTotalBytesPerProject: number;
  maxAgeDays: number;
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
  maxStoredFilesPerSession: 20,
  maxTotalBytesPerProject: 104857600,
  maxAgeDays: 7,
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
  sessionNotRunning: "session_not_running",
  rootPidUnavailable: "root_pid_unavailable",
  invalidScreenshotId: "invalid_screenshot_id",
  screenshotNotFound: "screenshot_not_found",
  screenshotTooLarge: "screenshot_too_large",
  sessionWindowNotFound: "session_window_not_found",
  multipleSessionWindows: "multiple_session_windows",
  windowTokenInvalid: "window_token_invalid",
  windowTokenExpired: "window_token_expired",
  workerTimeout: "screenshot_worker_timeout",
  workerFailed: "screenshot_worker_failed",
  protocolError: "screenshot_worker_protocol_error",
  bindingUnavailable: "screenshot_binding_unavailable",
  invalidImageData: "invalid_image_data",
  imageBoundsExceeded: "image_bounds_exceeded",
  invalidCaptureOptions: "invalid_capture_options"
} as const;

export class ScreenshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
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

function capturedAtMsFromName(name: string): number {
  const stamp = name.slice(0, 16);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  return Date.parse(iso);
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
    private readonly maxTokens = 512
  ) {}

  issue(projectAlias: string, sessionId: string, window: { nativeWindowId: number; pid: number }): string {
    this.purgeExpired();
    while (this.tokens.size >= this.maxTokens) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    let windowId = randomBytes(16).toString("hex");
    while (this.tokens.has(windowId)) windowId = randomBytes(16).toString("hex");
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

/**
 * Builds the fresh allowed-PID set for one worker launch: the session root
 * PID plus its current descendants. Throws `root_pid_unavailable` when the
 * root PID is missing or dead so capture fails closed.
 */
export const defaultBuildAllowedPids: AllowedPidSetBuilder = async (session) => {
  if (!session.pid || !isProcessAlive(session.pid)) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.rootPidUnavailable,
      "Execution session has no live root process; capture is unavailable."
    );
  }
  const descendants =
    process.platform === "win32"
      ? await getWindowsDescendants(session.pid)
      : await getPosixDescendants(session.pid);
  const allowed = new Set<number>([session.pid]);
  for (const pid of descendants) {
    if (Number.isInteger(pid) && pid > 0) allowed.add(pid);
  }
  return Array.from(allowed);
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

export type ScreenshotSystem = {
  getCapabilities(input: { permissionGranted: boolean }): Record<string, unknown>;
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
} = {}): ScreenshotSystem {
  const limits = deps.limits ?? DEFAULT_SCREENSHOT_LIMITS;
  const now = deps.now ?? Date.now;
  const launchWorker = deps.launchWorker ?? defaultLaunchWorker;
  const buildAllowedPids = deps.buildAllowedPids ?? defaultBuildAllowedPids;
  const tokens = new WindowTokenStore(limits.windowTokenTtlMs, now);
  const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");
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
    // Canonical containment is revalidated through path policy on every use.
    return resolveProjectPath(projectAlias, `${SCREENSHOT_STORAGE_DIR}/${sessionId}/${name}`);
  }

  function sessionDir(projectAlias: string, sessionId: string, create: boolean): string {
    const dir = path.join(resolveProjectPath(projectAlias, SCREENSHOT_STORAGE_DIR), sessionId);
    if (create) mkdirSync(dir, { recursive: true });
    return dir;
  }

  interface GeneratedFile {
    name: string;
    sessionId: string;
    capturedAtMs: number;
    bytes: number;
  }

  function listGeneratedFiles(projectAlias: string): GeneratedFile[] {
    const root = resolveProjectPath(projectAlias, SCREENSHOT_STORAGE_DIR);
    if (!existsSync(root)) return [];
    const files: GeneratedFile[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      for (const file of readdirSync(dir)) {
        if (!GENERATED_NAME_RE.test(file)) continue;
        try {
          files.push({
            name: file,
            sessionId: entry.name,
            capturedAtMs: capturedAtMsFromName(file),
            bytes: statSync(path.join(dir, file)).size
          });
        } catch {
          // File vanished mid-scan; skip it.
        }
      }
    }
    return files;
  }

  function removeGeneratedFile(projectAlias: string, file: GeneratedFile): void {
    try {
      rmSync(path.join(resolveProjectPath(projectAlias, SCREENSHOT_STORAGE_DIR), file.sessionId, file.name));
    } catch {
      // Best-effort eviction; never delete unknown files and never fail capture for eviction issues.
      return;
    }
    audit("retention_evict", { projectAlias, sessionId: file.sessionId, screenshotId: file.name, bytes: file.bytes });
  }

  /** Age → per-session count → per-project total bytes; oldest first, generated files only. */
  function enforceRetention(projectAlias: string): void {
    let files = listGeneratedFiles(projectAlias);
    const cutoffMs = now() - limits.maxAgeDays * 86400_000;
    for (const file of files) {
      if (file.capturedAtMs < cutoffMs) {
        removeGeneratedFile(projectAlias, file);
        file.bytes = 0;
      }
    }
    files = files.filter((file) => file.bytes > 0);

    const bySession = new Map<string, GeneratedFile[]>();
    for (const file of files) {
      const bucket = bySession.get(file.sessionId);
      if (bucket) bucket.push(file);
      else bySession.set(file.sessionId, [file]);
    }
    for (const bucket of bySession.values()) {
      bucket.sort((a, b) => b.capturedAtMs - a.capturedAtMs); // newest first
      for (const file of bucket.slice(limits.maxStoredFilesPerSession)) {
        removeGeneratedFile(projectAlias, file);
        file.bytes = 0;
      }
    }

    let remaining = files.filter((file) => file.bytes > 0);
    let totalBytes = remaining.reduce((sum, file) => sum + file.bytes, 0);
    remaining.sort((a, b) => a.capturedAtMs - b.capturedAtMs); // oldest first
    for (const file of remaining) {
      if (totalBytes <= limits.maxTotalBytesPerProject) break;
      removeGeneratedFile(projectAlias, file);
      totalBytes -= file.bytes;
    }
  }

  function mapWorkerFailure(error: { code: string; message: string }): ScreenshotError {
    switch (error.code) {
      case SCREENSHOT_ERROR_CODES.workerTimeout:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.workerTimeout, error.message);
      case SCREENSHOT_ERROR_CODES.bindingUnavailable:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.bindingUnavailable, error.message);
      default:
        return new ScreenshotError(SCREENSHOT_ERROR_CODES.workerFailed, `Screenshot worker failed: ${error.code}`);
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
    options: CaptureOptions = {}
  ): Promise<CaptureResult> {
    const session = requireLiveSession(projectAlias, executionSessionId);
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
      format: ScreenshotFormat;
      jpegQuality?: number;
      maxWidth?: number;
      maxHeight?: number;
      windowId: string | null;
    }
  ): Promise<CaptureResult> {
    const root = sessionDir(projectAlias, sessionId, true);
    const extension = target.format === "png" ? "png" : "jpeg";
    let finalName = `${formatUtcStamp(now())}_${randomHex(4)}.${extension}`;
    while (existsSync(path.join(root, finalName))) {
      finalName = `${formatUtcStamp(now())}_${randomHex(4)}.${extension}`;
    }
    let tempName = `pending_${randomHex(4)}.${extension}`;
    while (existsSync(path.join(root, tempName))) {
      tempName = `pending_${randomHex(4)}.${extension}`;
    }
    const tempPath = path.join(root, tempName);
    let published = false;

    try {
      const request: WorkerRequest = {
        op: "capture",
        protocolVersion: WORKER_PROTOCOL_VERSION,
        allowedPids: await buildAllowedPids(getExecutionSessionOwnership(sessionId)!),
        nativeWindowId: target.nativeWindowId,
        expectedPid: target.ownerPid,
        format: target.format,
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

      // Validate the encoded image before it may leave the pending namespace.
      let bytes: Buffer;
      try {
        bytes = readFileSync(tempPath);
      } catch {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.workerFailed, "Worker reported success without writing an image file.");
      }
      if (bytes.length > limits.maxBytes) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.imageBoundsExceeded, "Captured image exceeds the byte limit.");
      }
      const dims = validateImageBytes(bytes, target.format);
      if (!dims) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidImageData, "Encoded image failed signature validation.");
      }
      if (dims.width > limits.maxWidth || dims.height > limits.maxHeight) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.imageBoundsExceeded, "Captured image exceeds dimension limits.");
      }

      // Canonical containment revalidation immediately before publication.
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
        bytes: bytes.length
      });
      enforceRetention(projectAlias);

      return {
        screenshotId: finalName,
        format: target.format,
        width: dims.width,
        height: dims.height,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        capturedAt: new Date(capturedAtMsFromName(finalName)).toISOString(),
        resized: parsed.data.resized
      };
    } finally {
      if (!published && existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Cleanup is best-effort; the pending namespace is excluded from listing.
        }
      }
    }
  }

  function parseScreenshotName(projectAlias: string, sessionId: string, screenshotId: string): { path: string; format: ScreenshotFormat } {
    if (!GENERATED_NAME_RE.test(screenshotId)) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidScreenshotId, "Malformed screenshot id.");
    }
    return {
      path: resolveScreenshotFile(projectAlias, sessionId, screenshotId),
      format: screenshotId.endsWith(".png") ? "png" : "jpeg"
    };
  }

  async function read(
    projectAlias: string,
    executionSessionId: string,
    screenshotId: string,
    options?: { audit?: boolean }
  ): Promise<{ meta: ScreenshotMeta; data: Buffer }> {
    const session = requireSession(projectAlias, executionSessionId);
    const { format } = parseScreenshotName(projectAlias, session.sessionId, screenshotId);
    // Revalidate canonical containment right before reading; repository contents are untrusted.
    const filePath = resolveProjectPath(projectAlias, `${SCREENSHOT_STORAGE_DIR}/${session.sessionId}/${screenshotId}`);
    if (!existsSync(filePath)) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.screenshotNotFound, "Screenshot not found.");
    }
    const stats = statSync(filePath);
    if (stats.size > limits.maxBytes) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.screenshotTooLarge, "Stored screenshot exceeds the byte limit.");
    }
    const bytes = readFileSync(filePath);
    // Stored bytes are untrusted: signature and dimensions are revalidated on every read.
    const dims = validateImageBytes(bytes, format);
    if (!dims) {
      throw new ScreenshotError(SCREENSHOT_ERROR_CODES.invalidImageData, "Stored image failed signature validation.");
    }
    if (options?.audit !== false) {
      audit("read", { projectAlias, sessionId: session.sessionId, screenshotId, format });
    }
    return {
      meta: {
        screenshotId,
        format,
        width: dims.width,
        height: dims.height,
        bytes: bytes.length,
        capturedAt: new Date(capturedAtMsFromName(screenshotId)).toISOString(),
        sha256: sha256Hex(bytes)
      },
      data: bytes
    };
  }

  function buildMeta(projectAlias: string, file: GeneratedFile): ScreenshotMeta {
    const format: ScreenshotFormat = file.name.endsWith(".png") ? "png" : "jpeg";
    let dims: ImageDimensions | null = null;
    try {
      const headerPath = resolveProjectPath(projectAlias, `${SCREENSHOT_STORAGE_DIR}/${file.sessionId}/${file.name}`);
      const header = readFileSync(headerPath).subarray(0, 512 * 1024);
      dims = validateImageBytes(header, format);
    } catch {
      dims = null;
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
    const files = listGeneratedFiles(projectAlias)
      .filter((file) => file.sessionId === session.sessionId)
      .sort((a, b) => b.capturedAtMs - a.capturedAtMs || (a.name < b.name ? 1 : -1));
    const startIndex = page?.cursor ? files.findIndex((file) => file.name === page.cursor) + 1 : 0;
    const effectiveStart = startIndex > 0 ? startIndex : 0;
    const pageFiles = files.slice(effectiveStart, effectiveStart + limit);
    audit("list", { projectAlias, sessionId: session.sessionId, count: pageFiles.length });
    return {
      items: pageFiles.map((file) => buildMeta(projectAlias, file)),
      nextCursor:
        pageFiles.length === limit && effectiveStart + limit < files.length
          ? pageFiles[pageFiles.length - 1].name
          : null,
      total: files.length
    };
  }

  async function deleteScreenshot(projectAlias: string, executionSessionId: string, screenshotId: string): Promise<void> {
    await runExclusive(projectAlias, () => {
      const session = requireSession(projectAlias, executionSessionId);
      parseScreenshotName(projectAlias, session.sessionId, screenshotId);
      // Revalidate canonical containment immediately before deletion.
      const filePath = resolveProjectPath(projectAlias, `${SCREENSHOT_STORAGE_DIR}/${session.sessionId}/${screenshotId}`);
      if (!existsSync(filePath)) {
        throw new ScreenshotError(SCREENSHOT_ERROR_CODES.screenshotNotFound, "Screenshot not found.");
      }
      unlinkSync(filePath);
      audit("delete", { projectAlias, sessionId: session.sessionId, screenshotId });
    });
  }

  function getCapabilities(input: { permissionGranted: boolean }): Record<string, unknown> {
    if (!input.permissionGranted) {
      return {
        enabled: false,
        operations: [],
        platform: process.platform,
        formats: ["png", "jpeg"],
        captureAvailable: false,
        desktopCapture: false,
        activeWindowCapture: false,
        regionCapture: false
      };
    }
    // Only platform support is cached — never window or process state. A pending
    // or failed probe reports capture as unavailable and keeps the server healthy.
    const captureReady = bindingAvailable === true;
    return {
      enabled: true,
      scope: "execution_session_windows",
      operations: captureReady ? ["targets", "capture", "read", "list", "delete"] : ["read", "list", "delete"],
      platform: process.platform,
      formats: ["png", "jpeg"],
      captureAvailable: captureReady,
      desktopCapture: false,
      activeWindowCapture: false,
      regionCapture: false
    };
  }

  function ensureBindingAvailability(): Promise<boolean> {
    bindingProbe ??= Promise.resolve()
      .then(() => launchWorker({ op: "capabilities", protocolVersion: WORKER_PROTOCOL_VERSION }, 5000))
      .then(
        (outcome) =>
          outcome.ok &&
          typeof outcome.result === "object" &&
          outcome.result !== null &&
          (outcome.result as { captureAvailable?: unknown }).captureAvailable === true
      )
      .catch(() => false)
      .then((available) => {
        bindingAvailable = available;
        return available;
      });
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











