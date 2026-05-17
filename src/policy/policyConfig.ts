import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { optionalEnv } from "../env.js";
import type { PermissionConfig } from "../config.js";

const policySchema = z.object({
  agents: z.object({
    concurrency: z.object({
      maxConcurrent: z.number().int().min(0),
      maxConcurrentPerProject: z.number().int().min(0),
      queueEnabled: z.boolean(),
      maxQueueDepth: z.number().int().positive()
    }).strict(),
    lifecycle: z.object({
      queuedTaskTtlSecs: z.number().int().positive(),
      projectLockTimeoutSecs: z.number().int().positive(),
      maxRuntimeSecs: z.number().int().positive(),
      startupWatchdogMs: z.number().int().positive(),
      forcedCloseGraceMs: z.number().int().positive(),
      killEscalationDelayMs: z.number().int().positive(),
      queueDrainDelayMs: z.number().int().positive()
    }).strict(),
    capabilities: z.object({
      networkAccess: z.boolean(),
      grantCommands: z.boolean(),
      gitCommand: z.boolean(),
      packageManagerCommand: z.boolean(),
      nodeCommand: z.boolean()
    }).strict()
  }).strict(),
  permissions: z.object({
    chatgpt: z.object({
      registerProjects: z.boolean(),
      updatePermissions: z.boolean(),
      spawnAgents: z.boolean(),
      readFiles: z.boolean(),
      writeFiles: z.boolean(),
      moveFiles: z.boolean(),
      deleteFiles: z.boolean(),
      readGitIgnoredFiles: z.boolean(),
      runPackageScripts: z.boolean(),
      gitCommands: z.boolean()
    }).strict()
  }).strict(),
  limits: z.object({
    fileRead: z.object({
      maxChars: z.number().int().positive()
    }).strict(),
    fileWrite: z.object({
      maxChars: z.number().int().positive()
    }).strict(),
    patch: z.object({
      maxChars: z.number().int().positive()
    }).strict(),
    textEdit: z.object({
      maxOperationChars: z.number().int().positive(),
      maxSearchOrMarkerChars: z.number().int().positive()
    }).strict(),
    search: z.object({
      maxScanEntries: z.number().int().positive(),
      maxTextFileChars: z.number().int().positive()
    }).strict(),
    git: z.object({
      maxDiffChars: z.number().int().positive(),
      maxUntrackedFileChars: z.number().int().positive()
    }).strict(),
    skills: z.object({
      maxReadChars: z.number().int().positive()
    }).strict(),
    agentOutput: z.object({
      maxStdoutChars: z.number().int().positive(),
      maxStderrChars: z.number().int().positive()
    }).strict(),
    sessionEvents: z.object({
      maxEvents: z.number().int().positive(),
      maxChunkChars: z.number().int().positive()
    }).strict(),
    audit: z.object({
      maxEvents: z.number().int().positive()
    }).strict(),
    process: z.object({
      maxOutputBufferMb: z.number().positive()
    }).strict()
  }).strict(),
  audit: z.object({
    strictMode: z.boolean()
  }).strict()
}).strict();

export type PortusPolicyConfig = z.infer<typeof policySchema>;

export function loadPolicyConfig(): PortusPolicyConfig {
  const policyPath = path.resolve(optionalEnv("PORTUS_MCP_POLICY_PATH", "./portus-mcp.policy.json"));
  if (!existsSync(policyPath)) {
    throw new Error(`Missing policy file: ${policyPath}.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid policy JSON in ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${location}: ${issue.message}`;
    }).join("; ");
    throw new Error(`Invalid policy file ${policyPath}: ${details}`);
  }
  return parsed.data;
}

export function policyPermissions(policy = loadPolicyConfig()): PermissionConfig {
  return {
    chatgpt: { ...policy.permissions.chatgpt },
    agents: {
      network: policy.agents.capabilities.networkAccess,
      grantCommands: policy.agents.capabilities.grantCommands,
      gitCommand: policy.agents.capabilities.gitCommand,
      packageManagerCommand: policy.agents.capabilities.packageManagerCommand,
      nodeCommand: policy.agents.capabilities.nodeCommand,
      maxRuntimeSecs: policy.agents.lifecycle.maxRuntimeSecs
    }
  };
}
