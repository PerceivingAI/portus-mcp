/**
 * Scripted stdio worker fixture for contract tests.
 *
 * Mimics the screenshot-worker.mjs one-request envelope so tests can observe
 * parent-side behaviors (timeout, crash, partial output, oversize output,
 * noisy output, capture-file omission) deterministically without a desktop.
 * Usage: node screenshot-worker-fixture.mjs <scenario>
 */

const scenario = process.argv[2] ?? "";
const write = (text) => process.stdout.write(text);
const okEnvelope = JSON.stringify({ ok: true, result: { fixture: "ok" } });

if (scenario === "ok") {
  write(okEnvelope);
  process.exit(0);
}

if (scenario.startsWith("delay:")) {
  const ms = Number.parseInt(scenario.slice("delay:".length), 10);
  setTimeout(() => {
    write(okEnvelope);
    process.exit(0);
  }, Number.isFinite(ms) ? ms : 5000);
} else if (scenario === "partial") {
  // Truncated JSON envelope, then a clean exit: parent must detect malformed output.
  write('{"ok":true,"result":{"fix');
  process.exit(0);
} else if (scenario === "oversize") {
  write(
    JSON.stringify({ ok: true, result: { blob: "x".repeat(300 * 1024) } })
  );
  process.exit(0);
} else if (scenario === "crash") {
  // Abnormal termination with no output at all.
  process.abort();
} else if (scenario === "capture-file-omission") {
  // Claims a successful capture result but never wrote any image file.
  write(
    JSON.stringify({
      ok: true,
      result: {
        nativeWindowId: 42,
        pid: 4242,
        format: "png",
        width: 800,
        height: 600,
        bytes: 12345,
        resized: false
      }
    })
  );
  process.exit(0);
} else if (scenario === "prefix-noise") {
  // Diagnostics-style noise before the single-line envelope: parent must reject.
  write("bootstrapping native subsystem...\n");
  write(`${okEnvelope}\n`);
  process.exit(0);
} else {
  write(
    JSON.stringify({
      ok: false,
      error: { code: "worker_internal", message: `unknown fixture scenario: ${scenario}` }
    })
  );
  process.exit(3);
}
