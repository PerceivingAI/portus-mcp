import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { limitText } from "./outputLimits.js";

const execFileAsync = promisify(execFile);
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

export async function gitStatus(cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", ["status", "--short"], { cwd });
  return limitText(stdout + stderr).text;
}

export async function gitDiff(cwd: string): Promise<string> {
  const status = await execFileAsync("git", ["status", "--short"], { cwd }).catch((error) => ({ stdout: "", stderr: String(error) }));
  const stat = await execFileAsync("git", ["diff", "--stat"], { cwd }).catch((error) => ({ stdout: "", stderr: String(error) }));
  const diff = await execFileAsync("git", ["diff"], { cwd }).catch((error) => ({ stdout: "", stderr: String(error) }));
  return limitText([
    "## git status --short",
    status.stdout + status.stderr,
    "## git diff --stat",
    stat.stdout + stat.stderr,
    "## git diff",
    diff.stdout + diff.stderr
  ].join("\n")).text;
}

export async function gitDiffFile(cwd: string, relativePath: string, includeUntracked = false): Promise<string> {
  const escaped = relativePath.replace(/\\/g, "/");
  const status = await execFileAsync("git", ["status", "--short", "--", escaped], { cwd }).catch((error) => ({ stdout: "", stderr: String(error) }));
  const diff = await execFileAsync("git", ["diff", "--", escaped], { cwd }).catch((error) => ({ stdout: "", stderr: String(error) }));
  let untracked = "";
  if (includeUntracked) {
    untracked = (await execFileAsync("git", ["diff", "--no-index", "--", nullDevice, escaped], { cwd }).catch((error) => ({ stdout: "", stderr: String(error) }))).stdout;
  }
  return limitText([
    "## git status --short -- <file>",
    status.stdout + status.stderr,
    "## git diff -- <file>",
    diff.stdout + diff.stderr,
    includeUntracked ? "## untracked preview" : "",
    includeUntracked ? untracked : ""
  ].join("\n")).text;
}

export async function gitUntrackedFiles(cwd: string): Promise<string[]> {
  const result = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}
