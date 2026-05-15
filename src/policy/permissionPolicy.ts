import type { AgentPermissionConfig, ChatGptPermissionConfig } from "../config.js";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";

export function assertChatGptPermission(permission: keyof ChatGptPermissionConfig, projectAlias?: string): void {
  const permissions = getEffectivePermissions(projectAlias).chatgpt;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: chatgpt.${String(permission)} is false`);
  }
}

export function assertAgentPermission(permission: keyof AgentPermissionConfig, projectAlias?: string): void {
  const permissions = getEffectivePermissions(projectAlias).agents;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: agents.${String(permission)} is false`);
  }
}
