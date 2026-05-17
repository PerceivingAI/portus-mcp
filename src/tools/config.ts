import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadAgentProviderConfig, loadConfig } from "../config.js";
import { getEffectivePermissions, updatePermissions } from "../state/PermissionRegistry.js";
import { registerTool } from "./toolUtils.js";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { stateStore } from "../state/StateStore.js";
import { assertChatGptPermission } from "../policy/permissionPolicy.js";
import { loadAgentCommandConfig, loadPolicyConfig } from "../policy/policyConfig.js";

const permissionUpdateSchema = z.object({
  chatgpt: z.object({
    registerProjects: z.boolean().optional(),
    updatePermissions: z.boolean().optional(),
    spawnAgents: z.boolean().optional(),
    readFiles: z.boolean().optional(),
    writeFiles: z.boolean().optional(),
    moveFiles: z.boolean().optional(),
    deleteFiles: z.boolean().optional(),
    readGitIgnoredFiles: z.boolean().optional(),
    runPackageScripts: z.boolean().optional(),
    gitCommands: z.boolean().optional()
  }).optional(),
  agents: z.object({
    network: z.boolean().optional(),
    maxRuntimeSecs: z.number().int().positive().optional()
  }).optional()
});

type PublicAuditEvent = {
  timestamp: string;
  tool?: string;
  projectAlias?: string | null;
  sessionId?: string;
  status?: string;
  relativePath?: string;
  sourceRelativePath?: string;
  destinationRelativePath?: string;
  scriptName?: string;
  exitCode?: number | null;
  bytes?: number;
  count?: number;
  dryRun?: boolean;
  reason?: string;
  failureType?: string | null;
};

function toPublicAuditEvent(event: Record<string, unknown>): PublicAuditEvent | null {
  if (typeof event.timestamp !== "string") return null;
  const output: PublicAuditEvent = { timestamp: event.timestamp };
  if (typeof event.tool === "string") output.tool = event.tool;
  if (typeof event.projectAlias === "string" || event.projectAlias === null) output.projectAlias = event.projectAlias;
  if (typeof event.sessionId === "string") output.sessionId = event.sessionId;
  if (typeof event.status === "string") output.status = event.status;
  if (typeof event.relativePath === "string") output.relativePath = event.relativePath;
  if (typeof event.sourceRelativePath === "string") output.sourceRelativePath = event.sourceRelativePath;
  if (typeof event.destinationRelativePath === "string") output.destinationRelativePath = event.destinationRelativePath;
  if (typeof event.scriptName === "string") output.scriptName = event.scriptName;
  if (typeof event.exitCode === "number" || event.exitCode === null) output.exitCode = event.exitCode;
  if (typeof event.bytes === "number") output.bytes = event.bytes;
  if (typeof event.count === "number") output.count = event.count;
  if (Array.isArray(event.stopped)) output.count = event.stopped.length;
  if (typeof event.dryRun === "boolean") output.dryRun = event.dryRun;
  if (typeof event.reason === "string") output.reason = event.reason;
  if (typeof event.failureType === "string" || event.failureType === null) output.failureType = event.failureType;
  return output;
}

export function registerConfigTools(server: McpServer): void {
  registerTool(server, "config_show_safe", "Use this when ChatGPT needs to inspect non-secret portus-mcp configuration.", {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => loadConfig());

  registerTool(server, "effective_config_show", "Use this when ChatGPT needs effective non-secret configuration, permissions, provider, command grant, and path policy details.", {
    projectAlias: z.string().optional()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => {
    const config = loadConfig();
    const policy = loadPolicyConfig();
    const permissions = getEffectivePermissions(projectAlias);
    const commandConfig = loadAgentCommandConfig(policy);
    const provider = loadAgentProviderConfig(config);
    const effectiveCommands = commandConfig.allowedCommands;

    return {
      projectAlias: projectAlias ?? null,
      provider: {
        name: provider.provider,
        model: provider.model,
        credentialEnvNames: provider.requiredEnv
      },
      permissions,
      commands: {
        allowedCommands: commandConfig.allowedCommands,
        effectiveCommands
      },
      pathPolicy: {
        blockedPatterns: policy.pathPolicy.blockedPatterns
      },
      traversal: {
        excludedPatterns: config.traversal.excludedPatterns
      }
    };
  });

  registerTool(server, "permission_get", "Use this when ChatGPT needs to inspect effective non-secret permissions.", {
    projectAlias: z.string().optional()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => ({
    projectAlias: projectAlias ?? null,
    permissions: getEffectivePermissions(projectAlias)
  }));

  registerTool(server, "permission_update", "Use this when ChatGPT needs to update controlled runtime permissions.", {
    projectAlias: z.string().optional(),
    permissions: permissionUpdateSchema
  }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ projectAlias, permissions }) => ({
    projectAlias: projectAlias ?? null,
    permissions: (() => {
      assertChatGptPermission("updatePermissions", projectAlias);
      return updatePermissions({ projectAlias, permissions });
    })()
  }));

  registerTool(server, "policy_check_path", "Check whether a path operation would pass path policy constraints.", {
    projectAlias: z.string(),
    relativePath: z.string(),
    operation: z.enum(["read", "write", "copy", "move", "delete", "mkdir", "patch", "search"])
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, operation }) => {
    try {
      resolveProjectPath(projectAlias, relativePath);
      return { allowed: true, operation, projectAlias, relativePath };
    } catch (error) {
      return { allowed: false, operation, projectAlias, relativePath, reason: String(error) };
    }
  });

  registerTool(server, "policy_explain_permissions", "Explain which permission gates apply to a tool or operation.", {
    projectAlias: z.string().optional(),
    operation: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, operation }) => {
    const map: Record<string, string[]> = {
      project_read_file: ["readFiles"],
      project_read_text_file: ["readFiles"],
      project_list_files: ["readFiles"],
      project_write_file: ["writeFiles"],
      project_tree: ["readFiles"],
      project_search_files: ["readFiles"],
      project_search_text: ["readFiles"],
      project_search_symbols: ["readFiles"],
      project_file_info: ["readFiles"],
      project_exists: ["readFiles"],
      project_copy_file: ["readFiles", "writeFiles"],
      project_move_file: ["moveFiles"],
      project_delete_file: ["deleteFiles"],
      project_create_directory: ["writeFiles"],
      project_delete_directory: ["deleteFiles"],
      project_apply_patch: ["writeFiles"],
      project_replace_text: ["writeFiles"],
      project_insert_text: ["writeFiles"],
      project_git_status: ["gitCommands"],
      project_git_diff: ["gitCommands"],
      project_git_diff_file: ["gitCommands"],
      project_git_show_untracked: ["gitCommands", "readFiles"],
      project_run_checks: ["runPackageScripts"],
      project_run_script: ["runPackageScripts"],
      session_cleanup: ["spawnAgents"],
      session_stop_all: ["spawnAgents"]
    };
    const requiredPermissions = map[operation] ?? [];
    const permissions = getEffectivePermissions(projectAlias).chatgpt;
    const missing = requiredPermissions.filter((permission) => !(permissions as any)[permission]);
    return {
      operation,
      requiredPermissions,
      allowed: missing.length === 0,
      reason: missing.length === 0 ? "allowed" : `Missing permissions: ${missing.join(", ")}`
    };
  });

  registerTool(server, "audit_list", "List recent audit events.", {
    projectAlias: z.string().optional(),
    sessionId: z.string().optional()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, sessionId }) => {
    const auditLimit = loadPolicyConfig().limits.audit.maxEvents;
    const events = stateStore.readAudit(auditLimit).filter((event) => {
      if (projectAlias && event.projectAlias !== projectAlias) return false;
      if (sessionId && event.sessionId !== sessionId) return false;
      return true;
    });
    return { events: events.map(toPublicAuditEvent).filter((event): event is PublicAuditEvent => event !== null), limit: auditLimit };
  });

  registerTool(server, "audit_read", "Read detailed audit events by event id or session id.", {
    eventId: z.string().optional(),
    sessionId: z.string().optional()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ eventId, sessionId }) => {
    const events = stateStore.readAudit(loadPolicyConfig().limits.audit.maxEvents).filter((event) => {
      if (eventId && event.eventId !== eventId) return false;
      if (sessionId && event.sessionId !== sessionId) return false;
      return true;
    });
    return { events: events.map(toPublicAuditEvent).filter((event): event is PublicAuditEvent => event !== null) };
  });
}
