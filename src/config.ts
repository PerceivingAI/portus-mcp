import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { optionalEnv } from "./env.js";
import { parseAgentProvider, providerDefinitions } from "./providers.js";
import type { AgentProvider, AgentProviderConfig, AgentProviderDefinition } from "./providers.js";

export type { AgentProvider, AgentProviderConfig, AgentProviderDefinition } from "./providers.js";

export type ChatGptPermissionConfig = {
  registerProjects: boolean;
  updatePermissions: boolean;
  spawnAgents: boolean;
  readFiles: boolean;
  writeFiles: boolean;
  moveFiles: boolean;
  deleteFiles: boolean;
  readGitIgnoredFiles: boolean;
  runPackageScripts: boolean;
  gitCommands: boolean;
};

export type AgentPermissionConfig = {
  network: boolean;
  grantCommands: boolean;
  gitCommand: boolean;
  packageManagerCommand: boolean;
  nodeCommand: boolean;
  maxRuntimeSecs: number;
};

export type PermissionConfig = {
  chatgpt: ChatGptPermissionConfig;
  agents: AgentPermissionConfig;
};

export type AgentCommandConfig = {
  allowedCommands: string[];
};

export type PortusMcpConfig = {
  projects: {
    allowedRootMode: "registered-only";
  };
  agents: {
    defaultTemplate: string;
    allowPersistentSessions: boolean;
    useFlueCli: boolean;
    allowedCommands?: string[];
    retry: {
      enabled: boolean;
      maxAttempts: number;
      baseDelayMs: number;
      maxDelayMs: number;
      jitterRatio: number;
      retryOn: string[];
      respectRetryAfter: boolean;
      maxRetryWindowSecs: number;
    };
  };
  blockedPathPatterns: string[];
  excludedTraversalPatterns?: string[];
  skills: {
    directory: string;
  };
};

const retrySchema = z.object({
  enabled: z.boolean(),
  maxAttempts: z.number().int().positive(),
  baseDelayMs: z.number().int().positive(),
  maxDelayMs: z.number().int().positive(),
  jitterRatio: z.number().min(0).max(1),
  retryOn: z.array(z.string().min(1)),
  respectRetryAfter: z.boolean(),
  maxRetryWindowSecs: z.number().int().positive()
}).strict();

const configSchema = z.object({
  projects: z.object({
    allowedRootMode: z.literal("registered-only")
  }).strict(),
  agents: z.object({
    defaultTemplate: z.string().min(1),
    allowPersistentSessions: z.boolean(),
    useFlueCli: z.boolean(),
    allowedCommands: z.array(z.string().min(1)).optional(),
    retry: retrySchema
  }).strict(),
  blockedPathPatterns: z.array(z.string().min(1)),
  excludedTraversalPatterns: z.array(z.string().min(1)).optional(),
  skills: z.object({
    directory: z.string().min(1)
  }).strict()
}).strict();

export function loadConfig(): PortusMcpConfig {
  const configPath = path.resolve(optionalEnv("PORTUS_MCP_CONFIG_PATH", "./portus-mcp.config.json"));
  if (!existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid config JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${location}: ${issue.message}`;
    }).join("; ");
    throw new Error(`Invalid config file ${configPath}: ${details}`);
  }
  return parsed.data as PortusMcpConfig;
}

export function loadAgentCommandConfig(config = loadConfig()): AgentCommandConfig {
  const defaults: AgentCommandConfig = {
    allowedCommands: ["git", "npm", "node"]
  };
  const allowedCommands = normalizeCommandList(config.agents.allowedCommands ?? defaults.allowedCommands, "agents.allowedCommands");
  return {
    allowedCommands
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

export function loadAgentProviderConfig(config = loadConfig()): AgentProviderConfig {
  const provider = parseAgentProvider(optionalEnv("PORTUS_MCP_DEFAULT_PROVIDER", "cerebras"));
  const definition = providerDefinitions[provider];
  const rawModel = optionalEnv(definition.modelEnv, defaultProviderModels[provider]);

  if (!rawModel) {
    throw new Error(`Missing model for provider '${provider}'. Set ${definition.modelEnv}.`);
  }

  const requiredEnv = [...definition.requiredEnv];
  const missing = requiredEnv.filter((name) => !optionalEnv(name));
  if (missing.length > 0) {
    throw new Error("Missing API key for selected provider.");
  }

  return { provider, model: definition.qualifyModel(rawModel), requiredEnv };
}

export function listAgentProviderDefinitions(): Record<AgentProvider, AgentProviderDefinition> {
  return providerDefinitions;
}

const defaultProviderModels: Record<AgentProvider, string> = {
  openai: "gpt-5.4-mini",
  cerebras: "llama3.1-8b",
  gemini: "gemini-3.1-flash-lite-preview",
  cloudflare: "@cf/google/gemma-4-26b-a4b-it",
  openrouter: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
};

