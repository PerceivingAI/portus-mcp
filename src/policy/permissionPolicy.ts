import type { SubagentPermissionConfig, MainAgentPermissionConfig } from "../config.js";
import { policyPermissions, type PortusPolicyConfig } from "./policyConfig.js";

type MainAgentBooleanPermissionKey = Exclude<keyof MainAgentPermissionConfig, "allowedCommands">;

export function assertMainAgentPermission(permission: MainAgentBooleanPermissionKey, policy?: PortusPolicyConfig): void {
  const permissions = policyPermissions(policy).main_agent;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: main_agent.${String(permission)} is false`);
  }
}

export function normalizeCommandName(command: string): string {
  return command.replace(/\.(bat|cmd|exe)$/i, "").toLowerCase();
}

export function assertMainAgentCommandAllowed(command: string, policy?: PortusPolicyConfig): void {
  const permissions = policyPermissions(policy).main_agent;
  if (permissions.allowedCommands.includes(command)) return;
  const baseCommand = normalizeCommandName(command);
  const normalizedAllowed = permissions.allowedCommands.map((cmd) => normalizeCommandName(cmd));
  if (normalizedAllowed.includes(baseCommand)) return;
  throw new Error(`Permission denied: main_agent.allowedCommands does not include ${command}`);
}

export function assertSubagentPermission(permission: keyof SubagentPermissionConfig, policy?: PortusPolicyConfig): void {
  const permissions = policyPermissions(policy).subagents;
  if (!permissions[permission]) {
    throw new Error(`Permission denied: subagents.${String(permission)} is false`);
  }
}
