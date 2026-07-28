import type { SubagentPermissionConfig, ChatGptPermissionConfig } from "../config.js";
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
  if (permissions.allowedCommands.includes(command)) return;
  const baseCommand = process.platform === "win32" ? command.replace(/\.(bat|cmd|exe)$/i, "") : command;
  if (permissions.allowedCommands.includes(baseCommand)) return;
  throw new Error(`Permission denied: chatgpt.allowedCommands does not include ${command}`);
}

export function assertSubagentPermission(permission: keyof SubagentPermissionConfig, projectAlias?: string): void {
  const permissions = getEffectivePermissions(projectAlias).subagents;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: subagents.${String(permission)} is false`);
  }
}
