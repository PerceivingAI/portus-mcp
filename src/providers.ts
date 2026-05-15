export type AgentProviderDefinition = {
  modelEnv: string;
  runtimeProvider: string;
  requiredEnv: readonly string[];
  qualifyModel(model: string): string;
};

export const providerDefinitions = {
  openai: {
    modelEnv: "PORTUS_MCP_OPENAI_MODEL",
    runtimeProvider: "openai",
    requiredEnv: ["OPENAI_API_KEY"],
    qualifyModel(model: string): string {
      return qualifyProviderModel("openai", model);
    }
  },
  cerebras: {
    modelEnv: "PORTUS_MCP_CEREBRAS_MODEL",
    runtimeProvider: "cerebras",
    requiredEnv: ["CEREBRAS_API_KEY"],
    qualifyModel(model: string): string {
      return qualifyProviderModel("cerebras", model);
    }
  },
  gemini: {
    modelEnv: "PORTUS_MCP_GEMINI_MODEL",
    runtimeProvider: "google",
    requiredEnv: ["GEMINI_API_KEY"],
    qualifyModel(model: string): string {
      return qualifyProviderModel("google", model);
    }
  },
  cloudflare: {
    modelEnv: "PORTUS_MCP_CLOUDFLARE_MODEL",
    runtimeProvider: "cloudflare-workers-ai",
    requiredEnv: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
    qualifyModel(model: string): string {
      const trimmed = model.trim();
      if (trimmed.startsWith("@cf/")) return `cloudflare-workers-ai/${trimmed}`;
      return qualifyProviderModel("cloudflare-workers-ai", trimmed);
    }
  },
  openrouter: {
    modelEnv: "PORTUS_MCP_OPENROUTER_MODEL",
    runtimeProvider: "openrouter",
    requiredEnv: ["OPENROUTER_API_KEY"],
    qualifyModel(model: string): string {
      const trimmed = model.trim();
      if (trimmed.startsWith("openrouter/")) return trimmed;
      return `openrouter/${trimmed}`;
    }
  }
} as const satisfies Record<string, AgentProviderDefinition>;

export type AgentProvider = keyof typeof providerDefinitions;

export type AgentProviderConfig = {
  provider: AgentProvider;
  model: string;
  requiredEnv: string[];
};

export function parseAgentProvider(value: string): AgentProvider {
  const provider = value.trim().toLowerCase();
  if (provider in providerDefinitions) {
    return provider as AgentProvider;
  }
  throw new Error(`Unsupported provider '${value}'. Expected ${Object.keys(providerDefinitions).join(", ")}.`);
}

function qualifyProviderModel(runtimeProvider: string, model: string): string {
  const trimmed = model.trim();
  if (trimmed.includes("/")) return trimmed;
  return `${runtimeProvider}/${trimmed}`;
}
