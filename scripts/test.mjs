import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(path.join(root, "tests"), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map(entry => path.join("tests", entry.name))
  .sort();
if (files.length === 0) throw new Error("No test files found.");

// Node 20 on Windows does not expand the test glob passed through npm/cmd.exe.
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--test", "--test-concurrency=2", ...process.argv.slice(2), ...files
], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
