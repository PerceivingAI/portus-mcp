import { AgentPermissionConfig, ChatGptPermissionConfig, PermissionConfig } from "../config.js";
import { policyPermissions } from "../policy/policyConfig.js";
import { stateStore } from "./StateStore.js";

type PermissionState = {
  default?: PartialPermissionConfig;
  projects: Record<string, PartialPermissionConfig>;
};

export type PartialPermissionConfig = {
  chatgpt?: Partial<ChatGptPermissionConfig>;
  agents?: Partial<AgentPermissionConfig>;
} & Record<string, unknown>;

const FILE = "permissions.json";

function readState(): PermissionState {
  return stateStore.readJson<PermissionState>(FILE, { projects: {} });
}

export function getEffectivePermissions(projectAlias?: string): PermissionConfig {
  const state = readState();
  const base = policyPermissions();
  const globalOverride = normalizePartialPermissions(state.default ?? {});
  const projectOverride = normalizePartialPermissions(projectAlias ? state.projects[projectAlias] ?? {} : {});
  return {
    chatgpt: {
      ...base.chatgpt,
      ...globalOverride.chatgpt,
      ...projectOverride.chatgpt
    },
    agents: {
      ...base.agents,
      ...globalOverride.agents,
      ...projectOverride.agents
    }
  };
}

export function updatePermissions(input: {
  projectAlias?: string;
  permissions: PartialPermissionConfig;
}): PermissionConfig {
  const permissions = normalizePartialPermissions(input.permissions);
  stateStore.requireAuditWritable();
  const state = readState();
  if (input.projectAlias) {
    state.projects[input.projectAlias] = mergePartialPermissions(state.projects[input.projectAlias] ?? {}, permissions);
  } else {
    state.default = mergePartialPermissions(state.default ?? {}, permissions);
  }
  stateStore.writeJson(FILE, state);
  stateStore.audit({ tool: "permission_update", projectAlias: input.projectAlias ?? null, permissions });
  return getEffectivePermissions(input.projectAlias);
}

function normalizePartialPermissions(input: PartialPermissionConfig | Record<string, unknown>): PartialPermissionConfig {
  const raw = input as Record<string, any>;
  const chatgpt: Partial<ChatGptPermissionConfig> = { ...(raw.chatgpt ?? {}) };
  const agents: Partial<AgentPermissionConfig> = { ...(raw.agents ?? {}) };

  copyLegacy(raw, chatgpt, "registerProjects", "registerProjects");
  copyLegacy(raw, chatgpt, "updatePermissions", "updatePermissions");
  copyLegacy(raw, chatgpt, "spawnAgents", "spawnAgents");
  copyLegacy(raw, chatgpt, "readFiles", "readFiles");
  copyLegacy(raw, chatgpt, "writeFiles", "writeFiles");
  copyLegacy(raw, chatgpt, "moveFiles", "moveFiles");
  copyLegacy(raw, chatgpt, "deleteFiles", "deleteFiles");
  copyLegacy(raw, chatgpt, "readGitIgnoredFiles", "readGitIgnoredFiles");
  copyLegacy(raw, chatgpt, "gitCommands", "gitCommands");
  copyLegacy(raw, chatgpt, "runPackageManager", "runPackageScripts");

  copyLegacy(raw, agents, "network", "network");
  copyLegacy(raw, agents, "maxRuntimeSecs", "maxRuntimeSecs");

  return { chatgpt, agents };
}

function copyLegacy<T extends Record<string, unknown>>(raw: Record<string, unknown>, target: T, from: string, to: keyof T): void {
  if (raw[from] !== undefined) target[to] = raw[from] as T[keyof T];
}

function mergePartialPermissions(current: PartialPermissionConfig, next: PartialPermissionConfig): PartialPermissionConfig {
  return {
    chatgpt: { ...(normalizePartialPermissions(current).chatgpt ?? {}), ...(next.chatgpt ?? {}) },
    agents: { ...(normalizePartialPermissions(current).agents ?? {}), ...(next.agents ?? {}) }
  };
}
