import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { classifyProcessError, limitProcessOutput, ProcessResult } from "./commands.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";

const execFileAsync = promisify(execFile);

export type ProjectScriptResult = ProcessResult & {
  command: string;
  args: string[];
};

export async function runProjectCheck(rootPath: string, scriptName = "check", timeoutSecsOrMs = 120000): Promise<ProjectScriptResult> {
  const packageJsonPath = path.join(rootPath, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error("project_run check mode requires package.json");

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  return runProjectScript(rootPath, scriptName, [], timeoutSecsOrMs, packageJson);
}

export async function runProjectScript(
  rootPath: string,
  scriptName: string,
  args: string[] = [],
  timeoutSecsOrMs = 120000,
  packageJsonInput?: { scripts?: Record<string, string> }
): Promise<ProjectScriptResult> {
  const packageJsonPath = path.join(rootPath, "package.json");
  const packageJson = packageJsonInput ?? JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.[scriptName]) throw new Error(`Missing package.json script: ${scriptName}`);
  const maxBuffer = Math.floor(loadPolicyConfig().limits.process.maxOutputBufferMb * 1024 * 1024);
  const timeoutMs = timeoutSecsOrMs <= 3600 ? timeoutSecsOrMs * 1000 : timeoutSecsOrMs;

  const npmExecPath = process.env.npm_execpath;
  const command = process.platform === "win32" && npmExecPath ? process.execPath : "npm";
  const runArgs = process.platform === "win32" && npmExecPath ? [npmExecPath, "run", scriptName] : ["run", scriptName];
  if (args.length > 0) runArgs.push("--", ...args);
  const displayCommand = `npm run ${scriptName}${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`;
  try {
    const result = await execFileAsync(command, runArgs, {
      cwd: rootPath,
      timeout: timeoutMs,
      maxBuffer
    });
    const limited = limitProcessOutput({
      outcome: "exited",
      exitCode: 0,
      signal: null,
      executionError: null,
      stdoutRaw: result.stdout,
      stderrRaw: result.stderr
    });
    return {
      command: displayCommand,
      args,
      ...limited
    };
  } catch (error: unknown) {
    const classified = classifyProcessError(error, timeoutMs);
    const limited = limitProcessOutput(classified);
    return {
      command: displayCommand,
      args,
      ...limited
    };
  }
}
