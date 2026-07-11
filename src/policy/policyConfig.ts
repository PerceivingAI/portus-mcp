import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { optionalEnv } from "../env.js";
import type { PermissionConfig } from "../config.js";

export type AgentCommandConfig = {
  allowedCommands: string[];
};

export type ChatGptCommandConfig = {
  allowedCommands: string[];
};

const safeCommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

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
    permissions: z.object({
      networkAccess: z.boolean(),
      allowedCommands: z.array(safeCommandNameSchema)
    }).strict()
  }).strict(),
  chatgpt: z.object({
    permissions: z.object({
      registerProjects: z.boolean(),
      updatePermissions: z.boolean(),
      spawnAgents: z.boolean(),
      projectContext: z.boolean(),
      projectRead: z.boolean(),
      projectSearch: z.boolean(),
      projectEdit: z.boolean(),
      projectPatch: z.boolean(),
      projectRun: z.boolean(),
      projectPolicy: z.boolean(),
      readGitIgnoredFiles: z.boolean(),
      allowedCommands: z.array(safeCommandNameSchema)
    }).strict()
  }).strict(),
  pathPolicy: z.object({
    blockedPatterns: z.array(z.string().min(1))
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
      maxTextFileChars: z.number().int().positive(),
      maxRegexExecutionMs: z.number().int().positive().default(120000)
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
    chatgpt: { ...policy.chatgpt.permissions },
    agents: {
      network: policy.agents.permissions.networkAccess,
      maxRuntimeSecs: policy.agents.lifecycle.maxRuntimeSecs
    }
  };
}

export function loadAgentCommandConfig(policy = loadPolicyConfig()): AgentCommandConfig {
  return {
    allowedCommands: normalizeCommandList(policy.agents.permissions.allowedCommands, "agents.permissions.allowedCommands")
  };
}

export function loadChatGptCommandConfig(policy = loadPolicyConfig()): ChatGptCommandConfig {
  return {
    allowedCommands: normalizeCommandList(policy.chatgpt.permissions.allowedCommands, "chatgpt.permissions.allowedCommands")
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
