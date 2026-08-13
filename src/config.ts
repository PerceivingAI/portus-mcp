import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { optionalEnv } from "./env.js";
import { parseAgentProvider, providerDefinitions } from "./providers.js";
import type { AgentProvider, AgentProviderConfig, AgentProviderDefinition } from "./providers.js";

export type { AgentProvider, AgentProviderConfig, AgentProviderDefinition } from "./providers.js";


export type MainAgentPermissionConfig = {
  subagentTask: boolean;
  subagentContext: boolean;
  projectContext: boolean;
  projectRead: boolean;
  projectSearch: boolean;
  projectEdit: boolean;
  projectPatch: boolean;
  projectRun: boolean;
  projectPolicy: boolean;
  readGitIgnoredFiles: boolean;
  requireConfirmation: boolean;
  allowShell: boolean;
  allowedCommands: string[];
};

export type SubagentPermissionConfig = {
  network: boolean;
  maxRuntimeSecs: number;
};

export type PermissionConfig = {
  main_agent: MainAgentPermissionConfig;
  subagents: SubagentPermissionConfig;
};

export type PortusMcpConfig = {
  subagents: {
    defaultTemplate: string;
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
  traversal: {
    excludedPatterns: string[];
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
  subagents: z.object({
    defaultTemplate: z.string().min(1),
    retry: retrySchema
  }).strict(),
  traversal: z.object({
    excludedPatterns: z.array(z.string().min(1))
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

export function loadAgentProviderConfig(): AgentProviderConfig {
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

