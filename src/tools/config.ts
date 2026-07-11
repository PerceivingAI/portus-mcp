import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { getEffectivePermissions, updatePermissions } from "../state/PermissionRegistry.js";
import { registerTool } from "./toolUtils.js";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { stateStore } from "../state/StateStore.js";
import { assertChatGptPermission } from "../policy/permissionPolicy.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { registerStrictProjectTool } from "./projectToolUtils.js";

const permissionUpdateSchema = z.object({
  chatgpt: z.object({
    registerProjects: z.boolean().optional(),
    updatePermissions: z.boolean().optional(),
    spawnAgents: z.boolean().optional(),
    projectContext: z.boolean().optional(),
    projectRead: z.boolean().optional(),
    projectSearch: z.boolean().optional(),
    projectEdit: z.boolean().optional(),
    projectPatch: z.boolean().optional(),
    projectRun: z.boolean().optional(),
    projectPolicy: z.boolean().optional(),
    readGitIgnoredFiles: z.boolean().optional(),
    allowedCommands: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).optional()
  }).strict().optional(),
  agents: z.object({
    network: z.boolean().optional(),
    maxRuntimeSecs: z.number().int().positive().optional()
  }).strict().optional()
}).strict();

const broadOperationSchema = z.enum([
  "project_context",
  "project_read",
  "project_search",
  "project_edit",
  "project_patch",
  "project_run",
  "project_policy"
]);

const broadPermissionMap = {
  project_context: "projectContext",
  project_read: "projectRead",
  project_search: "projectSearch",
  project_edit: "projectEdit",
  project_patch: "projectPatch",
  project_run: "projectRun",
  project_policy: "projectPolicy"
} as const;

const policyCheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("permissions"),
    projectAlias: z.string().optional(),
    operation: broadOperationSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("path"),
    projectAlias: z.string(),
    relativePath: z.string(),
    operation: z.enum(["read", "write", "copy", "move", "delete", "mkdir", "patch", "search"])
  }).strict(),
  z.object({
    type: z.literal("config"),
    projectAlias: z.string().optional()
  }).strict()
]);


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
  command?: string;
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
  if (typeof event.command === "string") output.command = event.command;
  if (typeof event.exitCode === "number" || event.exitCode === null) output.exitCode = event.exitCode;
  if (typeof event.bytes === "number") output.bytes = event.bytes;
  if (typeof event.count === "number") output.count = event.count;
  if (Array.isArray(event.stopped)) output.count = event.stopped.length;
  if (typeof event.dryRun === "boolean") output.dryRun = event.dryRun;
  if (typeof event.reason === "string") output.reason = event.reason;
  if (typeof event.failureType === "string" || event.failureType === null) output.failureType = event.failureType;
  return output;
}

export function registerBroadPolicyTools(server: McpServer): void {
  registerStrictProjectTool(server, "project_policy", "Evaluate read-only permission, path, and safe effective-configuration policy checks in order.", {
    checks: z.array(policyCheckSchema).min(1).max(100)
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ checks }) => {
    const projectAliases = [...new Set(checks.map((check) => check.projectAlias).filter((alias): alias is string => alias !== undefined))];
    if (projectAliases.length === 0) assertChatGptPermission("projectPolicy");
    else for (const projectAlias of projectAliases) assertChatGptPermission("projectPolicy", projectAlias);
    return {
      results: checks.map((check) => {
        if (check.type === "path") {
          try {
            resolveProjectPath(check.projectAlias, check.relativePath);
            return { type: "path" as const, allowed: true, operation: check.operation, projectAlias: check.projectAlias, relativePath: check.relativePath };
          } catch (error) {
            return { type: "path" as const, allowed: false, operation: check.operation, projectAlias: check.projectAlias, relativePath: check.relativePath, reason: error instanceof Error ? error.message : "Path denied by policy." };
          }
        }
        if (check.type === "config") {
          const config = loadConfig();
          const policy = loadPolicyConfig();
          return {
            type: "config" as const,
            projectAlias: check.projectAlias ?? null,
            toolSurface: config.toolSurface,
            permissions: getEffectivePermissions(check.projectAlias),
            pathPolicy: { blockedPatterns: policy.pathPolicy.blockedPatterns.map((pattern) => path.isAbsolute(pattern) ? "[absolute pattern redacted]" : pattern) },
            traversal: { excludedPatterns: config.traversal.excludedPatterns.map((pattern) => path.isAbsolute(pattern) ? "[absolute pattern redacted]" : pattern) }
          };
        }
        const permissions = getEffectivePermissions(check.projectAlias);
        const requiredPermissions = check.operation ? [broadPermissionMap[check.operation]] : [];
        const missing = requiredPermissions.filter((permission) => !permissions.chatgpt[permission]);
        return {
          type: "permissions" as const,
          projectAlias: check.projectAlias ?? null,
          operation: check.operation ?? null,
          permissions,
          requiredPermissions,
          allowed: missing.length === 0,
          reason: missing.length === 0 ? "allowed" : `Missing permissions: ${missing.join(", ")}`
        };
      })
    };
  });
}

export function registerAdminTools(server: McpServer): void {
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
