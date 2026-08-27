import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { optionalEnv } from "../env.js";
import type { PermissionConfig } from "../config.js";

export type SubagentCommandConfig = {
  allowedCommands: string[];
};
export type MainAgentCommandConfig = {
  allowedCommands: string[];
};

const safeCommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

const screenshotLimitsSchema = z.object({
  maxBytes: z.number().int().positive().max(64 * 1024 * 1024),
  maxWidth: z.number().int().positive().max(7680),
  maxHeight: z.number().int().positive().max(7680),
  captureTimeoutMs: z.number().int().positive().max(120000),
  maxWindowWaitMs: z.number().int().positive().max(600000),
  windowTokenTtlMs: z.number().int().positive().max(600000),
  maxListPageSize: z.number().int().positive().max(10000),
  minJpegQuality: z.number().int().min(1).max(100),
  maxJpegQuality: z.number().int().min(1).max(100)
}).strict().superRefine((limits, context) => {
  if (limits.minJpegQuality > limits.maxJpegQuality) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minJpegQuality"],
      message: "minJpegQuality must not exceed maxJpegQuality"
    });
  }
});

const appDiscoverySchema = z.object({
  commands: z.array(safeCommandNameSchema).max(32),
  aliases: z.record(safeCommandNameSchema, z.string().min(1).max(32767)).superRefine((aliases, context) => {
    if (Object.keys(aliases).length > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "aliases must contain at most 32 entries"
      });
    }
  })
}).strict();

const screenshotConfigSchema = z.object({
  appDiscovery: appDiscoverySchema
}).strict();

const policySchema = z.object({
  subagents: z.object({
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
    permissions: z.object({
      networkAccess: z.boolean(),
      allowedCommands: z.array(safeCommandNameSchema)
    }).strict()
  }).strict(),
  main_agent: z.object({
    permissions: z.object({
      subagentTask: z.boolean(),
      subagentContext: z.boolean(),
      projectContext: z.boolean(),
      projectRead: z.boolean(),
      projectSearch: z.boolean(),
      projectEdit: z.boolean(),
      projectPatch: z.boolean(),
      projectRun: z.boolean(),
      projectPolicy: z.boolean(),
      projectScreenshot: z.boolean(),
      readGitIgnoredFiles: z.boolean(),
      statGitIgnoredFiles: z.boolean().default(false),
      requireConfirmation: z.boolean(),
      allowShell: z.boolean(),
      allowedCommands: z.array(safeCommandNameSchema)
    }).strict()
  }).strict(),
  pathPolicy: z.object({
    blockedPatterns: z.array(z.string().min(1))
  }).strict(),
  screenshot: screenshotConfigSchema.default({ appDiscovery: { commands: [], aliases: {} } }),
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
      maxSearchOrMarkerChars: z.number().int().positive(),
      maxRangeLines: z.number().int().positive()
    }).strict(),
    search: z.object({
      maxScanEntries: z.number().int().positive(),
      maxTextFileChars: z.number().int().positive(),
      maxRegexExecutionMs: z.number().int().positive(),
      maxBatchMatches: z.number().int().positive(),
      maxBatchOutputChars: z.number().int().positive()
    }).strict(),
    skills: z.object({
      maxReadChars: z.number().int().positive()
    }).strict(),
    subagentOutput: z.object({
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
      maxOutputBufferMb: z.number().positive(),
      maxBatchOutputChars: z.number().int().positive()
    }).strict(),
    screenshot: screenshotLimitsSchema
  }).strict(),
  audit: z.object({
    strictMode: z.boolean()
  }).strict()
}).strict();

export type PortusPolicyConfig = z.infer<typeof policySchema>;
export function policySelection(): "configured" | "shipped" {
  return optionalEnv("PORTUS_MCP_POLICY_PATH") === "" ? "shipped" : "configured";
}

export function parsePolicyConfig(raw: unknown): PortusPolicyConfig {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${location}: ${issue.message}`;
    }).join("; ");
    throw new Error(details);
  }
  return parsed.data;
}



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
  try {
    return parsePolicyConfig(raw);
  } catch (error) {
    throw new Error(`Invalid policy file ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function policyPermissions(policy = loadPolicyConfig()): PermissionConfig {
  return {
    main_agent: { ...policy.main_agent.permissions },
    subagents: {
      network: policy.subagents.permissions.networkAccess,
      maxRuntimeSecs: policy.subagents.lifecycle.maxRuntimeSecs
    }
  };
}

/** Strict, policy-derived limits for the screenshot system (`limits.screenshot`). */
export function loadScreenshotLimits(policy: PortusPolicyConfig = loadPolicyConfig()) {
  return policy.limits.screenshot;
}

export function loadSubagentCommandConfig(policy = loadPolicyConfig()): SubagentCommandConfig {
  return {
    allowedCommands: normalizeCommandList(policy.subagents.permissions.allowedCommands, "subagents.permissions.allowedCommands")
  };
}

export function loadMainAgentCommandConfig(policy = loadPolicyConfig()): MainAgentCommandConfig {
  return {
    allowedCommands: normalizeCommandList(policy.main_agent.permissions.allowedCommands, "main_agent.permissions.allowedCommands")
  };
}

function normalizeCommandList(commands: string[], configPath: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of commands) {
    const command = raw.trim();
    if (!isSafeCommandName(command)) {
      throw new Error(`Invalid command name in ${configPath}: ${raw}`);
    }
    if (seen.has(command)) continue;
    seen.add(command);
    normalized.push(command);
  }
  return normalized;
}

function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(command);
}
