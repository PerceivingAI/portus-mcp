import { existsSync, readFileSync } from "node:fs";
import { getSession } from "../state/SessionRegistry.js";
import { limitText } from "../runtime/outputLimits.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";

function readLimited(file: string): string {
  if (!existsSync(file)) return "";
  return limitText(readFileSync(file, "utf8")).text;
}

export function collectFlueResult(sessionId: string): { result: string; stdout: string; stderr: string; summary: Record<string, unknown> | null } {
  const session = getSession(sessionId);
  const policy = loadPolicyConfig();
  const stdoutMax = Math.max(1000, policy.output.maxStdoutBytes);
  const stderrMax = Math.max(1000, policy.output.maxStderrBytes);
  const stdout = limitText(readLimited(session.stdoutPath), stdoutMax).text;
  const stderr = limitText(readLimited(session.stderrPath), stderrMax).text;
  const result = readLimited(session.resultPath);
  const summary = extractSummary(result, session.metadataPath);
  return {
    result: result || stdout || stderr,
    stdout,
    stderr,
    summary
  };
}

function extractSummary(result: string, metadataPath: string): Record<string, unknown> | null {
  try {
    const parsedResult = JSON.parse(result) as Record<string, unknown>;
    if (parsedResult && typeof parsedResult === "object") return parsedResult;
  } catch {
    // no-op
  }
  try {
    if (!existsSync(metadataPath)) return null;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { summary?: Record<string, unknown> };
    return metadata.summary ?? null;
  } catch {
    return null;
  }
}

