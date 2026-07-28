import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { limitText } from "./outputLimits.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";

const execFileAsync = promisify(execFile);

export async function runProjectCheck(rootPath: string, scriptName = "check", timeoutSecs = 120): Promise<{
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  const packageJsonPath = path.join(rootPath, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error("project_run check mode requires package.json");

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  return runProjectScript(rootPath, scriptName, [], timeoutSecs, packageJson);
}

export async function runProjectScript(
  rootPath: string,
  scriptName: string,
  args: string[] = [],
  timeoutSecs = 120,
  packageJsonInput?: { scripts?: Record<string, string> }
): Promise<{
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  const packageJsonPath = path.join(rootPath, "package.json");
  const packageJson = packageJsonInput ?? JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.[scriptName]) throw new Error(`Missing package.json script: ${scriptName}`);
  const maxBuffer = Math.floor(loadPolicyConfig().limits.process.maxOutputBufferMb * 1024 * 1024);

  const npmExecPath = process.env.npm_execpath;
  const command = process.platform === "win32" && npmExecPath ? process.execPath : "npm";
  const runArgs = process.platform === "win32" && npmExecPath ? [npmExecPath, "run", scriptName] : ["run", scriptName];
  if (args.length > 0) runArgs.push("--", ...args);
  try {
    const result = await execFileAsync(command, runArgs, {
      cwd: rootPath,
      timeout: timeoutSecs * 1000,
      maxBuffer
    });
    const policy = loadPolicyConfig().limits.subagentOutput;
    const stdout = limitText(result.stdout, policy.maxStdoutChars);
    const stderr = limitText(result.stderr, policy.maxStderrChars);
    return {
      command: `npm run ${scriptName}${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`,
      exitCode: 0,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated
    };
  } catch (error: any) {
    const policy = loadPolicyConfig().limits.subagentOutput;
    const stdout = limitText(error?.stdout ?? "", policy.maxStdoutChars);
    const stderr = limitText(error?.stderr ?? String(error), policy.maxStderrChars);
    return {
      command: `npm run ${scriptName}${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`,
      exitCode: typeof error?.code === "number" ? error.code : null,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated
    };
  }
}
