import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let args;
if (process.platform === "win32") {
  const concurrency = Number(process.env.PORTUS_TEST_CONCURRENCY ?? 2);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("PORTUS_TEST_CONCURRENCY must be a positive integer.");
  }
  const files = readdirSync(path.join(root, "tests"), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map(entry => path.join("tests", entry.name));
  if (files.length === 0) throw new Error("No test files found.");
  args = ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...process.argv.slice(2), ...files];
} else {
  args = ["--import", "tsx", path.join(root, "scripts", "test-runner.mjs"), ...process.argv.slice(2)];
}
const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
