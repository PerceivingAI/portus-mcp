/**
 * Portus screenshot worker.
 *
 * One-request child process around the npm-installed native window-capture
 * binding. Reads exactly one bounded JSON request from stdin, writes exactly
 * one bounded JSON result to stdout, writes bounded diagnostics to stderr,
 * and exits. The main Portus process never loads the native binding.
 *
 * Protocol rules (see notes/SCREENSHOTS_PLAN.md, "Worker protocol"):
 * - strict schemas with unknown-field rejection;
 * - maximum stdin/stdout/stderr sizes;
 * - one JSON object, no streaming, no shell, no network;
 * - no caller-selected project root;
 * - global windows are filtered by the supplied allowed-PID set BEFORE any
 *   metadata is serialized;
 * - capture re-enumerates windows and revalidates ownership immediately
 *   before acquiring pixels;
 * - PNG and JPEG only; image bytes never travel on stdout;
 * - sharp is used only when resize or explicit JPEG quality is required;
 * - stable error codes with bounded safe messages;
 * - nonzero exit for malformed protocol, native failure, or operational error.
 *
 * Exit codes:
 *   0 - ok:true result written;
 *   1 - protocol or input-size error (ok:false envelope still written);
 *   2 - native binding unavailable for targets/capture (ok:false envelope);
 *   3 - operational error such as window_not_found (ok:false envelope).
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const WORKER_PROTOCOL_VERSION = 1;

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;

const MAX_TEXT_LENGTH = 200;
const MAX_PID = 4294967295;
const MAX_DIMENSION = 7680;
const MIN_JPEG_QUALITY = 50;
const MAX_JPEG_QUALITY = 95;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const pidSchema = z.number().int().positive().max(MAX_PID);
const dimensionSchema = z.number().int().min(1).max(MAX_DIMENSION);

const baseShape = { protocolVersion: z.literal(WORKER_PROTOCOL_VERSION) };

const requestSchema = z.discriminatedUnion("op", [
  z
    .object({
      ...baseShape,
      op: z.literal("capabilities")
    })
    .strict(),
  z
    .object({
      ...baseShape,
      op: z.literal("targets"),
      allowedPids: z.array(pidSchema).min(1).max(4096)
    })
    .strict(),
  z
    .object({
      ...baseShape,
      op: z.literal("capture"),
      allowedPids: z.array(pidSchema).min(1).max(4096),
      nativeWindowId: pidSchema,
      expectedPid: pidSchema,
      format: z.enum(["png", "jpeg"]),
      maxBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
      jpegQuality: z.number().int().min(MIN_JPEG_QUALITY).max(MAX_JPEG_QUALITY).optional(),
      maxWidth: dimensionSchema.optional(),
      maxHeight: dimensionSchema.optional(),
      outPath: z.string().min(1).max(1024)
    })
    .strict()
]);

class BindingUnavailableError extends Error {}

/** Stable error codes surfaced through the JSON envelope. */
export const ERROR_CODES = {
  protocolError: "protocol_error",
  inputTooLarge: "input_too_large",
  outputTooLarge: "output_too_large",
  bindingUnavailable: "screenshot_binding_unavailable",
  unsupportedSessionWindowCapture: "unsupported_session_window_capture",
  windowNotFound: "window_not_found",
  windowNotOwned: "window_not_owned",
  windowIneligible: "window_ineligible",
  encodeFailed: "encode_failed",
  imageProcessingFailed: "image_processing_failed",
  outputWriteFailed: "output_write_failed",
  imageBoundsExceeded: "image_bounds_exceeded",
  workerInternal: "worker_internal"
};

export function captureEnvironmentStatus(platform, environment) {
  if (platform !== "linux") return { supported: true };
  const sessionType = String(environment.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  if (sessionType === "wayland" || (environment.WAYLAND_DISPLAY && !environment.DISPLAY)) {
    return { supported: false, reason: ERROR_CODES.unsupportedSessionWindowCapture };
  }
  return { supported: true };
}

function sanitizeText(value, maxLength = MAX_TEXT_LENGTH) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    // Strip control characters (including newlines) so titles stay single-line and path-safe.
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}\u2026`;
}

function safeInteger(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return numeric;
}

let stderrBytes = 0;
function diag(message) {
  if (stderrBytes >= MAX_STDERR_BYTES) {
    return;
  }
  const line = `${String(message).slice(0, 512)}\n`;
  stderrBytes += Buffer.byteLength(line);
  process.stderr.write(line);
}

/**
 * Loads the real dependencies. Called only inside the child process entrypoint;
 * unit tests replace this loader with deterministic fakes.
 */
export async function loadDefaultBindings() {
  try {
    const [nativeModule, sharpModule] = await Promise.all([
      import("node-screenshots"),
      import("sharp")
    ]);
    return {
      Window: nativeModule.Window,
      sharp: sharpModule.default,
      sharpAvailable: true
    };
  } catch (error) {
    diag(`binding load failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new BindingUnavailableError("native window-capture binding failed to load");
  }
}

/**
 * Loads bindings, classifying ANY loader failure (missing native package,
 * ABI mismatch, unloadable module, simulated test failures) as binding
 * unavailability rather than a generic worker error.
 */
async function loadBindingsOrUnavailable(loadBindings) {
  try {
    return await loadBindings();
  } catch (error) {
    if (!(error instanceof BindingUnavailableError)) {
      diag(`binding load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

function enumerateEligibleWindows(Window, allowedPids) {
  const allowed = new Set(allowedPids);
  const eligible = [];
  for (const window of Window.all()) {
    const pid = safeInteger(window.pid());
    if (pid === null || !allowed.has(pid)) {
      continue;
    }
    const width = safeInteger(window.width());
    const height = safeInteger(window.height());
    if (Boolean(window.isMinimized()) || width === null || height === null || width <= 0 || height <= 0) {
      continue;
    }
    eligible.push({
      nativeWindowId: safeInteger(window.id()),
      pid,
      appName: sanitizeText(window.appName()),
      title: sanitizeText(window.title()),
      width,
      height
    });
  }
  return eligible.filter((entry) => entry.nativeWindowId !== null);
}

function findFreshWindow(Window, allowedPids, nativeWindowId) {
  const allowed = new Set(allowedPids);
  for (const window of Window.all()) {
    if (safeInteger(window.id()) !== nativeWindowId) {
      continue;
    }
    const pid = safeInteger(window.pid());
    if (pid === null || !allowed.has(pid)) {
      return { status: "not_owned" };
    }
    return { status: "found", window, pid };
  }
  return { status: "not_found" };
}

function validateOutPath(outPath, format) {
  if (!isAbsolute(outPath)) {
    return "output path must be absolute";
  }
  const expectedExtensions = format === "png" ? [".png"] : [".jpeg", ".jpg"];
  const lower = outPath.toLowerCase();
  if (!expectedExtensions.some((extension) => lower.endsWith(extension))) {
    return "output path extension does not match format";
  }
  return null;
}

async function encodeImage(bindings, image, request) {
  let encoded = request.format === "png" ? await image.toPng() : await image.toJpeg();
  if (!Buffer.isBuffer(encoded) || encoded.byteLength === 0) {
    return { error: ERROR_CODES.encodeFailed };
  }

  const resizeRequested =
    Number.isInteger(request.maxWidth) || Number.isInteger(request.maxHeight);
  const qualityRequested = request.format === "jpeg" && request.jpegQuality !== undefined;
  let resized = false;

  if (resizeRequested || qualityRequested) {
    if (!bindings.sharpAvailable || typeof bindings.sharp !== "function") {
      return { error: ERROR_CODES.imageProcessingFailed };
    }
    try {
      let pipeline = bindings.sharp(encoded);
      if (resizeRequested) {
        pipeline = pipeline.resize({
          width: request.maxWidth,
          height: request.maxHeight,
          fit: "inside",
          withoutEnlargement: true
        });
        resized = true;
      }
      encoded =
        request.format === "png"
          ? await pipeline.png().toBuffer()
          : await pipeline.jpeg({ quality: request.jpegQuality }).toBuffer();
    } catch (error) {
      diag(`image processing failed: ${error instanceof Error ? error.message : String(error)}`);
      return { error: ERROR_CODES.imageProcessingFailed };
    }
    if (!Buffer.isBuffer(encoded) || encoded.byteLength === 0) {
      return { error: ERROR_CODES.encodeFailed };
    }
  }

  return { encoded, resized };
}

/**
 * Handles one parsed worker request. `deps.loadBindings` is injectable so
 * tests can supply deterministic fake bindings without a desktop session.
 */
export async function handleRequest(request, deps) {
  const loadBindings = deps?.loadBindings ?? loadDefaultBindings;
  const platform = deps?.platform ?? process.platform;
  const environment = deps?.environment ?? process.env;
  const environmentStatus = captureEnvironmentStatus(platform, environment);

  try {
    if (!environmentStatus.supported) {
      if (request.op === "capabilities") {
        return {
          ok: true,
          result: {
            bindingLoaded: false,
            captureAvailable: false,
            platform,
            formats: ["png", "jpeg"],
            reason: environmentStatus.reason
          }
        };
      }
      return {
        ok: false,
        error: {
          code: environmentStatus.reason,
          message: "session-owned window capture is unsupported in this display environment"
        }
      };
    }

    if (request.op === "capabilities") {
      try {
        const bindings = await loadBindings();
        bindings.Window.all();
        return {
          ok: true,
          result: {
            bindingLoaded: true,
            captureAvailable: true,
            platform,
            formats: ["png", "jpeg"]
          }
        };
      } catch {
        return {
          ok: true,
          result: {
            bindingLoaded: false,
            captureAvailable: false,
            platform,
            formats: ["png", "jpeg"],
            reason: ERROR_CODES.bindingUnavailable
          }
        };
      }
    }

    const bindings = await loadBindingsOrUnavailable(loadBindings);
    if (bindings === null) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.bindingUnavailable,
          message: "native window-capture binding is unavailable"
        }
      };
    }

    if (request.op === "targets") {
      return {
        ok: true,
        result: { windows: enumerateEligibleWindows(bindings.Window, request.allowedPids) }
      };
    }

    // Capture: revalidate everything immediately before acquiring pixels.
    const pathMatch = validateOutPath(request.outPath, request.format);
    if (pathMatch !== null) {
      return { ok: false, error: { code: ERROR_CODES.protocolError, message: pathMatch } };
    }

    const fresh = findFreshWindow(bindings.Window, request.allowedPids, request.nativeWindowId);
    if (fresh.status === "not_found") {
      return {
        ok: false,
        error: { code: ERROR_CODES.windowNotFound, message: "no session-owned window with that id" }
      };
    }
    if (fresh.status === "not_owned" || fresh.pid !== request.expectedPid) {
      return {
        ok: false,
        error: { code: ERROR_CODES.windowNotOwned, message: "window owner changed or is not allowed" }
      };
    }

    const width = safeInteger(fresh.window.width());
    const height = safeInteger(fresh.window.height());
    if (
      Boolean(fresh.window.isMinimized()) ||
      width === null ||
      height === null ||
      width <= 0 ||
      height <= 0
    ) {
      return {
        ok: false,
        error: { code: ERROR_CODES.windowIneligible, message: "window is minimized or has zero size" }
      };
    }

    const image = await fresh.window.captureImage();
    if (!image) {
      return {
        ok: false,
        error: { code: ERROR_CODES.encodeFailed, message: "window capture returned no image" }
      };
    }

    const encodedResult = await encodeImage(bindings, image, request);
    if (encodedResult.error !== undefined) {
      return { ok: false, error: { code: encodedResult.error, message: "image encoding failed" } };
    }
    if (encodedResult.encoded.byteLength > request.maxBytes) {
      return {
        ok: false,
        error: { code: ERROR_CODES.imageBoundsExceeded, message: "encoded image exceeds the byte limit" }
      };
    }

    try {
      // Exclusive creation: never overwrite an existing file.
      await writeFile(request.outPath, encodedResult.encoded, { flag: "wx" });
    } catch (error) {
      diag(`output write failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        ok: false,
        error: { code: ERROR_CODES.outputWriteFailed, message: "could not write encoded image exclusively" }
      };
    }

    return {
      ok: true,
      result: {
        nativeWindowId: request.nativeWindowId,
        pid: fresh.pid,
        format: request.format,
        width,
        height,
        bytes: encodedResult.encoded.byteLength,
        resized: encodedResult.resized
      }
    };
  } catch (error) {
    if (error instanceof BindingUnavailableError) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.bindingUnavailable,
          message: "native window-capture binding is unavailable"
        }
      };
    }
    diag(`worker internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return {
      ok: false,
      error: { code: ERROR_CODES.workerInternal, message: "unexpected worker failure" }
    };
  }
}

/** Parses a decoded JSON object into a validated worker request. */
export function parseRequestObject(candidate) {
  const parsed = requestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: ERROR_CODES.protocolError, message: "request failed strict schema validation" }
    };
  }
  return { ok: true, request: parsed.data };
}

function exitCodeFor(envelope) {
  if (envelope.ok) {
    return 0;
  }
  switch (envelope.error.code) {
    case ERROR_CODES.protocolError:
    case ERROR_CODES.inputTooLarge:
      return 1;
    case ERROR_CODES.bindingUnavailable:
      return 2;
    default:
      return 3;
  }
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return existsSync(entry) && import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) {
      return { tooLarge: true };
    }
    chunks.push(chunk);
  }
  return { tooLarge: false, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Full one-request cycle against real stdio. Returns the process exit code.
 * Separated from the module body so contract tests can exercise it directly.
 */
export async function runMain() {
  let payload;
  try {
    const read = await readBoundedStdin();
    if (read.tooLarge) {
      payload = { ok: false, error: { code: ERROR_CODES.inputTooLarge, message: "request exceeded input bounds" } };
    } else {
      let candidate;
      try {
        candidate = JSON.parse(read.text);
      } catch {
        candidate = undefined;
      }
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        payload = { ok: false, error: { code: ERROR_CODES.protocolError, message: "request is not a JSON object" } };
      } else {
        const parsed = parseRequestObject(candidate);
        if (!parsed.ok) {
          payload = { ok: false, error: parsed.error };
        } else {
          const outcome = await handleRequest(parsed.request, { loadBindings: loadDefaultBindings });
          payload = outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error };
        }
      }
    }
  } catch (error) {
    diag(`fatal worker error: ${error instanceof Error ? error.message : String(error)}`);
    payload = { ok: false, error: { code: ERROR_CODES.workerInternal, message: "unexpected worker failure" } };
  }

  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    text = JSON.stringify({
      ok: false,
      error: { code: ERROR_CODES.outputTooLarge, message: "worker result exceeded output bounds" }
    });
  }
  process.stdout.write(text);
  return exitCodeFor(payload);
}

if (isEntrypoint()) {
  runMain().then((code) => {
    process.exitCode = code;
  });
}



