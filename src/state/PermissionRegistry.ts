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
  stateStore.audit({ tool: "project_policy", operation: "update_permissions", projectAlias: input.projectAlias ?? null, permissions });
  return getEffectivePermissions(input.projectAlias);
}

function normalizePartialPermissions(input: PartialPermissionConfig | Record<string, unknown>): PartialPermissionConfig {
  const raw = input as Record<string, unknown>;
  const allowedTopLevel: Record<string, true> = { chatgpt: true, agents: true };
  const allowedChatGpt: Record<string, true> = {
    registerProjects: true, updatePermissions: true, spawnAgents: true,
    projectContext: true, projectRead: true, projectSearch: true, projectEdit: true,
    projectPatch: true, projectRun: true, projectPolicy: true,
    readGitIgnoredFiles: true, allowedCommands: true
  };
  const allowedAgents: Record<string, true> = { network: true, maxRuntimeSecs: true };
  const rejectUnknown = (value: unknown, allowed: Record<string, true>, scope: string): void => {
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${scope} permissions must be an object`);
    const unknown = Object.keys(value).filter((key) => !(key in allowed));
    if (unknown.length > 0) throw new Error(`Unknown ${scope} permission: ${unknown.join(", ")}`);
  };
  rejectUnknown(raw, allowedTopLevel, "top-level");
  rejectUnknown(raw.chatgpt, allowedChatGpt, "chatgpt");
  rejectUnknown(raw.agents, allowedAgents, "agents");
  return {
    chatgpt: { ...((raw.chatgpt as Partial<ChatGptPermissionConfig> | undefined) ?? {}) },
    agents: { ...((raw.agents as Partial<AgentPermissionConfig> | undefined) ?? {}) }
  };
}

function mergePartialPermissions(current: PartialPermissionConfig, next: PartialPermissionConfig): PartialPermissionConfig {
  return {
    chatgpt: { ...(normalizePartialPermissions(current).chatgpt ?? {}), ...(next.chatgpt ?? {}) },
    agents: { ...(normalizePartialPermissions(current).agents ?? {}), ...(next.agents ?? {}) }
  };
}
