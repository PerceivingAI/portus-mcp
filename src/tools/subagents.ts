import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSubagentLimits, runFlueTask, stopFlueTask } from "../flue/runTask.js";
import { collectFlueResult } from "../flue/collectResult.js";
import { getSession, listSessions, removeSession, toPublicSession } from "../state/SessionRegistry.js";
import { loadConfig } from "../config.js";
import { registerTool } from "./toolUtils.js";
import { limitText } from "../runtime/outputLimits.js";
import { stateStore } from "../state/StateStore.js";
import { assertChatGptPermission } from "../policy/permissionPolicy.js";
import { appendSessionEvent, readSessionEvents } from "../state/SessionEvents.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { asErrorMessage } from "../errors.js";
import type { SkillRegistrySnapshot } from "../skills/SkillRegistry.js";

const startActionSchema = z.object({
  type: z.literal("start"),
  projectAlias: z.string().min(1),
  task: z.string().min(1),
  agentTemplate: z.string().optional(),
  timeoutSecs: z.number().int().positive().optional()
}).strict();

const stopActionSchema = z.object({
  type: z.literal("stop"),
  sessionId: z.string().optional(),
  projectAlias: z.string().optional()
}).strict();

const cleanupActionSchema = z.object({
  type: z.literal("cleanup"),
  sessionId: z.string().optional(),
  projectAlias: z.string().optional(),
  olderThanDays: z.number().int().positive().optional(),
  dryRun: z.boolean().optional()
}).strict();

const subagentTaskActionSchema = z.discriminatedUnion("type", [
  startActionSchema,
  stopActionSchema,
  cleanupActionSchema
]);

const listRequestSchema = z.object({
  type: z.literal("list"),
  projectAlias: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "stopped"]).optional(),
  activeOnly: z.boolean().optional(),
  olderThanDays: z.number().int().positive().optional()
}).strict();

const statusRequestSchema = z.object({
  type: z.literal("status"),
  sessionId: z.string().min(1)
}).strict();

const outputRequestSchema = z.object({
  type: z.literal("output"),
  sessionId: z.string().min(1),
  stream: z.enum(["stdout", "stderr", "result", "all"]).optional()
}).strict();

const eventsRequestSchema = z.object({
  type: z.literal("events"),
  sessionId: z.string().min(1),
  afterSequence: z.number().int().min(0).optional()
}).strict();

const capabilitiesRequestSchema = z.object({
  type: z.literal("capabilities"),
  projectAlias: z.string().optional(),
  agentTemplate: z.string().optional()
}).strict();

const subagentContextRequestSchema = z.discriminatedUnion("type", [
  listRequestSchema,
  statusRequestSchema,
  outputRequestSchema,
  eventsRequestSchema,
  capabilitiesRequestSchema
]);

export function registerSubagentTools(server: McpServer, registry: SkillRegistrySnapshot): void {
  registerTool(
    server,
    "subagent_task",
    "Manage subagent task lifecycles through batched action requests (start, stop, cleanup).",
    {
      actions: z.array(subagentTaskActionSchema).min(1)
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ actions }) => {
      const results: Array<Record<string, unknown>> = [];
      for (const [index, action] of actions.entries()) {
        try {
          if (action.type === "start") {
            assertChatGptPermission("spawnSubagents", action.projectAlias);
            const config = loadConfig();
            const session = await runFlueTask({
              projectAlias: action.projectAlias,
              task: action.task,
              agentTemplate: action.agentTemplate ?? config.subagents.defaultTemplate,
              timeoutSecs: action.timeoutSecs,
              subagentSkills: registry.subagents
            });
            results.push({
              ok: true,
              index,
              type: "start",
              session: toPublicSession(session)
            });
          } else if (action.type === "stop") {
            if (action.sessionId) {
              const session = getSession(action.sessionId);
              assertChatGptPermission("spawnSubagents", session.projectAlias);
              const stopped = await stopFlueTask(action.sessionId);
              results.push({
                ok: true,
                index,
                type: "stop",
                sessionId: action.sessionId,
                session: toPublicSession(stopped)
              });
            } else {
              const active = listSessions().filter((s) => s.status === "running" && (!action.projectAlias || s.projectAlias === action.projectAlias));
              for (const session of active) {
                assertChatGptPermission("spawnSubagents", session.projectAlias);
              }
              const stopped = await Promise.all(active.map((session) => stopFlueTask(session.sessionId)));
              stateStore.audit({ tool: "subagent_task", action: "stop", projectAlias: action.projectAlias ?? null, stopped: stopped.map((item) => item.sessionId) });
              results.push({
                ok: true,
                index,
                type: "stop",
                projectAlias: action.projectAlias ?? null,
                stoppedSessionIds: stopped.map((item) => item.sessionId),
                sessions: stopped.map(toPublicSession)
              });
            }
          } else if (action.type === "cleanup") {
            if (action.sessionId) {
              const session = getSession(action.sessionId);
              if (session.status === "running" || session.status === "queued") {
                throw new Error("Cannot clean up a running or queued session.");
              }
              assertChatGptPermission("spawnSubagents", session.projectAlias);
              const sessionDir = path.dirname(session.metadataPath);
              appendSessionEvent(session, "cleanup", "Session artifacts cleaned up.", {});
              rmSync(sessionDir, { recursive: true, force: true });
              removeSession(action.sessionId);
              stateStore.audit({ tool: "subagent_task", action: "cleanup", sessionId: action.sessionId, projectAlias: session.projectAlias });
              results.push({
                ok: true,
                index,
                type: "cleanup",
                sessionId: action.sessionId,
                cleaned: true
              });
            } else {
              const olderThanDays = action.olderThanDays ?? 7;
              const dryRun = action.dryRun ?? false;
              const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
              const candidates = listSessions().filter((session) =>
                (session.status === "completed" || session.status === "failed" || session.status === "stopped") &&
                (!action.projectAlias || session.projectAlias === action.projectAlias) &&
                Date.parse(session.completedAt ?? session.startedAt) < cutoffMs
              );
              for (const session of candidates) {
                assertChatGptPermission("spawnSubagents", session.projectAlias);
              }
              if (!dryRun) {
                for (const session of candidates) {
                  appendSessionEvent(session, "cleanup", "Session artifacts cleaned up.", { olderThanDays });
                  rmSync(path.dirname(session.metadataPath), { recursive: true, force: true });
                  removeSession(session.sessionId);
                }
              }
              stateStore.audit({ tool: "subagent_task", action: "cleanup", projectAlias: action.projectAlias ?? null, olderThanDays, dryRun, count: candidates.length });
              results.push({
                ok: true,
                index,
                type: "cleanup",
                projectAlias: action.projectAlias ?? null,
                olderThanDays,
                dryRun,
                cleanedSessionIds: candidates.map((item) => item.sessionId)
              });
            }
          }
        } catch (error) {
          results.push({
            ok: false,
            index,
            type: action.type,
            error: asErrorMessage(error)
          });
        }
      }
      return {
        requestedCount: actions.length,
        successCount: results.filter((r) => r.ok).length,
        errorCount: results.filter((r) => !r.ok).length,
        results
      };
    }
  );

  registerTool(
    server,
    "subagent_context",
    "Inspect subagent state, outputs, events, capabilities, and listings through batched read requests.",
    {
      requests: z.array(subagentContextRequestSchema).min(1)
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ requests }) => {
      const results: Array<Record<string, unknown>> = [];
      for (const [index, request] of requests.entries()) {
        try {
          if (request.type === "list") {
            let sessions = listSessions();
            if (request.projectAlias) {
              sessions = sessions.filter((s) => s.projectAlias === request.projectAlias);
            }
            if (request.status) {
              sessions = sessions.filter((s) => s.status === request.status);
            }
            if (request.activeOnly) {
              sessions = sessions.filter((s) => s.status === "running" || s.status === "queued");
            }
            if (request.olderThanDays) {
              const cutoffMs = Date.now() - request.olderThanDays * 24 * 60 * 60 * 1000;
              sessions = sessions.filter((s) => Date.parse(s.completedAt ?? s.startedAt) < cutoffMs);
            }
            results.push({
              ok: true,
              index,
              type: "list",
              sessions: sessions.map(toPublicSession)
            });
          } else if (request.type === "status") {
            const session = getSession(request.sessionId);
            results.push({
              ok: true,
              index,
              type: "status",
              session: toPublicSession(session)
            });
          } else if (request.type === "output") {
            const session = getSession(request.sessionId);
            const stream = request.stream ?? "all";
            if (stream === "all") {
              results.push({
                ok: true,
                index,
                type: "output",
                session: toPublicSession(session),
                outputs: collectFlueResult(request.sessionId)
              });
            } else {
              const target = stream === "stdout" ? session.stdoutPath : stream === "stderr" ? session.stderrPath : session.resultPath;
              const policy = loadPolicyConfig().limits;
              const limit = stream === "stdout"
                ? policy.subagentOutput.maxStdoutChars
                : stream === "stderr"
                  ? policy.subagentOutput.maxStderrChars
                  : policy.fileRead.maxChars;
              const limited = limitText(readFileSync(target, "utf8"), limit);
              results.push({
                ok: true,
                index,
                type: "output",
                sessionId: request.sessionId,
                stream,
                content: limited.text,
                truncated: limited.truncated,
                chars: limited.chars,
                totalChars: limited.totalChars,
                omittedChars: limited.omittedChars,
                limit: limited.limit
              });
            }
          } else if (request.type === "events") {
            const events = readSessionEvents({ sessionId: request.sessionId, afterSequence: request.afterSequence ?? 0 });
            results.push({
              ok: true,
              index,
              type: "events",
              sessionId: request.sessionId,
              events
            });
          } else if (request.type === "capabilities") {
            const limits = getSubagentLimits(request.projectAlias);
            const templates = [
              {
                name: "ephemeral-project-subagent",
                description: "Default local project subagent",
                supportsSkills: true
              }
            ];
            let templateDetail: Record<string, unknown> | undefined = undefined;
            if (request.agentTemplate) {
              if (request.agentTemplate !== "ephemeral-project-subagent") {
                throw new Error(`Unknown template: ${request.agentTemplate}`);
              }
              templateDetail = {
                name: "ephemeral-project-subagent",
                description: "Default local project subagent",
                supportsSkills: true,
                expectedPayload: ["task", "projectRoot", "provider", "model"]
              };
            }
            results.push({
              ok: true,
              index,
              type: "capabilities",
              limits,
              templates,
              ...(templateDetail ? { template: templateDetail } : {})
            });
          }
        } catch (error) {
          results.push({
            ok: false,
            index,
            type: request.type,
            error: asErrorMessage(error)
          });
        }
      }
      return {
        requestedCount: requests.length,
        successCount: results.filter((r) => r.ok).length,
        errorCount: results.filter((r) => !r.ok).length,
        results
      };
    }
  );
}
