import type { AgentPermissionConfig, ChatGptPermissionConfig } from "../config.js";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";

type ChatGptBooleanPermissionKey = Exclude<keyof ChatGptPermissionConfig, "allowedCommands">;

export function assertChatGptPermission(permission: ChatGptBooleanPermissionKey, projectAlias?: string): void {
  const permissions = getEffectivePermissions(projectAlias).chatgpt;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: chatgpt.${String(permission)} is false`);
  }
}

export function assertChatGptCommandAllowed(command: string, projectAlias?: string): void {
  const permissions = getEffectivePermissions(projectAlias).chatgpt;
  if (!permissions.allowedCommands.includes(command)) {
    throw new Error(`Permission denied: chatgpt.allowedCommands does not include ${command}`);
  }
}

export function assertAgentPermission(permission: keyof AgentPermissionConfig, projectAlias?: string): void {
  const permissions = getEffectivePermissions(projectAlias).agents;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: agents.${String(permission)} is false`);
  }
}
