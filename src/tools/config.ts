import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { loadPolicyConfig, policyPermissions, policySelection, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { upsertProject } from "../state/ProjectRegistry.js";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { stateStore } from "../state/StateStore.js";
import { assertMainAgentPermission } from "../policy/permissionPolicy.js";
import { registerStrictProjectTool } from "./projectToolUtils.js";


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

const policyActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register_project"),
    projectAlias: z.string().min(1),
    rootPath: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("list_audit"),
    projectAlias: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional()
  }).strict(),
  z.object({
    type: z.literal("read_audit"),
    eventId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional()
  }).strict()
]);


export type PublicAuditEvent = {
  eventId?: string;
  timestamp: string;
  tool?: string;
  operation?: string;
  projectAlias?: string | null;
  sessionId?: string;
  status?: string;
  relativePath?: string;
  sourceRelativePath?: string;
  destinationRelativePath?: string;
  scriptName?: string;
  command?: string;
  executionType?: string;
  name?: string;
  batchIndex?: number;
  batchMode?: string;
  batchOutcome?: string;
  repositoryState?: string;
  operationStatus?: string;
  fileChanged?: boolean;
  outcome?: string | null;
  exitCode?: number | null;
  bytes?: number;
  count?: number;
  dryRun?: boolean;
  requestedCount?: number;
  successCount?: number;
  failedCount?: number;
  errorCount?: number;
  appliedCount?: number;
  noChangeCount?: number;
  plannedCount?: number;
  skippedCount?: number;
  expectedOccurrences?: number;
  matchesFound?: number;
  matchesApplied?: number;
  matchesPlanned?: number;
  reason?: string;
  failureType?: string | null;
};
const PUBLIC_AUDIT_NUMBER_FIELDS = [
  "requestedCount",
  "successCount",
  "failedCount",
  "errorCount",
  "appliedCount",
  "noChangeCount",
  "plannedCount",
  "skippedCount",
  "expectedOccurrences",
  "matchesFound",
  "matchesApplied",
  "matchesPlanned"
] as const;


export function toPublicAuditEvent(event: Record<string, unknown>): PublicAuditEvent | null {
  if (typeof event.timestamp !== "string") return null;
  const output: PublicAuditEvent = { timestamp: event.timestamp };
  if (typeof event.eventId === "string") output.eventId = event.eventId;
  if (typeof event.tool === "string") output.tool = event.tool;
  if (typeof event.operation === "string") output.operation = event.operation;
  if (typeof event.projectAlias === "string" || event.projectAlias === null) output.projectAlias = event.projectAlias;
  if (typeof event.sessionId === "string") output.sessionId = event.sessionId;
  if (typeof event.status === "string") output.status = event.status;
  if (typeof event.relativePath === "string") output.relativePath = event.relativePath;
  if (typeof event.sourceRelativePath === "string") output.sourceRelativePath = event.sourceRelativePath;
  if (typeof event.destinationRelativePath === "string") output.destinationRelativePath = event.destinationRelativePath;
  if (typeof event.scriptName === "string") output.scriptName = event.scriptName;
  if (typeof event.command === "string") output.command = event.command;
  if (typeof event.type === "string") output.executionType = event.type;
  if (typeof event.name === "string") output.name = event.name;
  if (typeof event.batchIndex === "number") output.batchIndex = event.batchIndex;
  if (typeof event.batchMode === "string") output.batchMode = event.batchMode;
  if (typeof event.batchOutcome === "string") output.batchOutcome = event.batchOutcome;
  if (typeof event.repositoryState === "string") output.repositoryState = event.repositoryState;
  if (typeof event.operationStatus === "string") output.operationStatus = event.operationStatus;
  if (typeof event.fileChanged === "boolean") output.fileChanged = event.fileChanged;
  if (typeof event.outcome === "string" || event.outcome === null) output.outcome = event.outcome;
  if (typeof event.exitCode === "number" || event.exitCode === null) output.exitCode = event.exitCode;
  if (typeof event.bytes === "number") output.bytes = event.bytes;
  if (typeof event.count === "number") output.count = event.count;
  for (const field of PUBLIC_AUDIT_NUMBER_FIELDS) {
    if (typeof event[field] === "number") output[field] = event[field];
  }
  if (Array.isArray(event.stopped)) output.count = event.stopped.length;
  if (typeof event.dryRun === "boolean") output.dryRun = event.dryRun;
  if (typeof event.reason === "string") output.reason = event.reason;
  if (typeof event.failureType === "string" || event.failureType === null) output.failureType = event.failureType;
  return output;
}

export function registerBroadPolicyTools(server: McpServer, policy: PortusPolicyConfig = loadPolicyConfig()): void {
  registerStrictProjectTool(server, "project_policy", "Evaluate policy checks or perform one native project-policy action.", {
    checks: z.array(policyCheckSchema).min(1).max(250).optional(),
    action: policyActionSchema.optional()
  }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ checks, action }) => {
    if ((checks === undefined) === (action === undefined)) throw new Error("Provide exactly one of checks or action");
    if (checks) {
      assertMainAgentPermission("projectPolicy", policy);
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
            return {
              type: "config" as const,
              projectAlias: check.projectAlias ?? null,
              permissionSource: "operator_policy" as const,
              policySelection: policySelection(),
              permissions: policyPermissions(policy),
              pathPolicy: { blockedPatterns: policy.pathPolicy.blockedPatterns.map((pattern) => path.isAbsolute(pattern) ? "[absolute pattern redacted]" : pattern) },
              traversal: { excludedPatterns: config.traversal.excludedPatterns.map((pattern) => path.isAbsolute(pattern) ? "[absolute pattern redacted]" : pattern) }
            };
          }
          const permissions = policyPermissions(policy);
          const requiredPermissions = check.operation ? [broadPermissionMap[check.operation]] : [];
          const missing = requiredPermissions.filter((permission) => !permissions.main_agent[permission]);
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
    }
    if (!action) throw new Error("Missing project_policy action");
    if (action.type === "register_project") {
      assertMainAgentPermission("projectPolicy", policy);
      stateStore.requireAuditWritable();
      const record = upsertProject({ projectAlias: action.projectAlias, rootPath: action.rootPath });
      stateStore.audit({ tool: "project_policy", operation: "register_project", projectAlias: action.projectAlias });
      return { action: action.type, project: { projectAlias: record.projectAlias, createdAt: record.createdAt, updatedAt: record.updatedAt } };
    }
    if (action.type === "list_audit") {
      assertMainAgentPermission("projectPolicy", policy);
      const limit = policy.limits.audit.maxEvents;
      const events = stateStore.readAudit(limit).filter((event) =>
        (!action.projectAlias || event.projectAlias === action.projectAlias)
        && (!action.sessionId || event.sessionId === action.sessionId)
      );
      return { action: action.type, events: events.map(toPublicAuditEvent).filter((event): event is PublicAuditEvent => event !== null), limit };
    }
    if (!action.eventId && !action.sessionId) throw new Error("read_audit requires eventId or sessionId");
    assertMainAgentPermission("projectPolicy", policy);
    const events = stateStore.readAudit(policy.limits.audit.maxEvents).filter((event) =>
      (!action.eventId || event.eventId === action.eventId)
      && (!action.sessionId || event.sessionId === action.sessionId)
    );
    return { action: action.type, events: events.map(toPublicAuditEvent).filter((event): event is PublicAuditEvent => event !== null) };
  });
}
