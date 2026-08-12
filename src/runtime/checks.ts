import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runCapturedProcess, type ProcessResult } from "./commands.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";


export type ProjectScriptResult = ProcessResult & {
  command: string;
  args: string[];
};

export async function runProjectCheck(rootPath: string, scriptName = "check", timeoutMs = 120000): Promise<ProjectScriptResult> {
  const packageJsonPath = path.join(rootPath, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error("project_run check mode requires package.json");

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  return runProjectScript(rootPath, scriptName, [], timeoutMs, packageJson);
}

export async function runProjectScript(
  rootPath: string,
  scriptName: string,
  args: string[] = [],
  timeoutMs = 120000,
  packageJsonInput?: { scripts?: Record<string, string> }
): Promise<ProjectScriptResult> {
  const packageJsonPath = path.join(rootPath, "package.json");
  const packageJson = packageJsonInput ?? JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.[scriptName]) throw new Error(`Missing package.json script: ${scriptName}`);
  const policy = loadPolicyConfig();

  const npmExecPath = process.env.npm_execpath;
  const command = process.platform === "win32" && npmExecPath ? process.execPath : "npm";
  const runArgs = process.platform === "win32" && npmExecPath ? [npmExecPath, "run", scriptName] : ["run", scriptName];
  if (args.length > 0) runArgs.push("--", ...args);
  const displayCommand = `npm run ${scriptName}${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`;
  const result = await runCapturedProcess({
    rootPath,
    command,
    args: runArgs,
    timeoutMs,
    policy
  });
  return {
    command: displayCommand,
    args,
    ...result
  };
}
