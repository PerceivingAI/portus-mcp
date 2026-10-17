import { readdirSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const concurrency = Number(process.env.PORTUS_TEST_CONCURRENCY ?? (process.platform === "win32" ? 2 : 4));
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  throw new Error("PORTUS_TEST_CONCURRENCY must be a positive integer.");
}
// Keep Windows' original lexical order; prioritize measured slow files elsewhere.
const priority = process.platform === "win32" ? [] : [
  "start-all-recovery.test.ts",
  "start-all-recovery-deadline.test.ts",
  "session-events-stream.test.ts",
  "mcp-integration.test.ts",
  "subagent-lifecycle.test.ts"
];
const rank = name => {
  const index = priority.indexOf(name);
  return index === -1 ? priority.length : index;
};
const files = readdirSync("tests", { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map(entry => entry.name)
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  .map(name => path.join("tests", name));
if (files.length === 0) throw new Error("No test files found.");

// The CLI re-sorts explicit paths. The public run API preserves this ordering
// while keeping each file in its own process and inheriting the tsx preload.
run({ files, concurrency, execArgv: process.argv.slice(2) })
  .on("test:fail", () => { process.exitCode = 1; })
  .compose(spec)
  .pipe(process.stdout);
