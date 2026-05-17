import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { optionalEnv } from "../env.js";
import type { PermissionConfig } from "../config.js";

const policySchema = z.object({
  agents: z.object({
    maxConcurrent: z.number().int().min(0),
    maxConcurrentPerProject: z.number().int().min(0),
    queueEnabled: z.boolean(),
    maxQueueDepth: z.number().int().positive(),
    queuedTaskTtlSecs: z.number().int().positive(),
    projectLockTimeoutSecs: z.number().int().positive(),
    maxRuntimeSecs: z.number().int().positive(),
    startupWatchdogMs: z.number().int().positive(),
    forcedCloseGraceMs: z.number().int().positive(),
    killEscalationDelayMs: z.number().int().positive(),
    queueDrainDelayMs: z.number().int().positive(),
    networkAccess: z.boolean(),
    grantCommands: z.boolean(),
    gitCommand: z.boolean(),
    packageManagerCommand: z.boolean(),
    nodeCommand: z.boolean()
  }).strict(),
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
  }).strict(),
  output: z.object({
    maxStdoutBytes: z.number().int().positive(),
    maxStderrBytes: z.number().int().positive(),
    defaultReadBytes: z.number().int().positive(),
    maxReadBytes: z.number().int().positive(),
    maxSkillReadBytes: z.number().int().positive(),
    maxSearchScanEntries: z.number().int().positive(),
    defaultEventLimit: z.number().int().positive(),
    maxEventLimit: z.number().int().positive(),
    maxEventChunkChars: z.number().int().positive(),
    defaultAuditLimit: z.number().int().positive(),
    maxAuditLimit: z.number().int().positive(),
    maxProcessOutputBufferBytes: z.number().int().positive()
  }).strict(),
  input: z.object({
    maxWriteBytes: z.number().int().positive(),
    maxPatchBytes: z.number().int().positive(),
    maxTextOperationBytes: z.number().int().positive(),
    maxSearchOrMarkerBytes: z.number().int().positive()
  }).strict(),
  audit: z.object({
    strictMode: z.boolean()
  }).strict()
}).strict().superRefine((policy, ctx) => {
  if (policy.output.defaultReadBytes > policy.output.maxReadBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["output", "defaultReadBytes"],
      message: "defaultReadBytes must be less than or equal to maxReadBytes"
    });
  }
  if (policy.output.defaultEventLimit > policy.output.maxEventLimit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["output", "defaultEventLimit"],
      message: "defaultEventLimit must be less than or equal to maxEventLimit"
    });
  }
  if (policy.output.defaultAuditLimit > policy.output.maxAuditLimit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["output", "defaultAuditLimit"],
      message: "defaultAuditLimit must be less than or equal to maxAuditLimit"
    });
  }
});

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
    chatgpt: { ...policy.chatgpt },
    agents: {
      network: policy.agents.networkAccess,
      grantCommands: policy.agents.grantCommands,
      gitCommand: policy.agents.gitCommand,
      packageManagerCommand: policy.agents.packageManagerCommand,
      nodeCommand: policy.agents.nodeCommand,
      maxRuntimeSecs: policy.agents.maxRuntimeSecs
    }
  };
}
