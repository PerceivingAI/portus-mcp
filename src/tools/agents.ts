import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentLimits, runFlueTask, stopFlueTask } from "../flue/runTask.js";
import { collectFlueResult } from "../flue/collectResult.js";
import { getSession, listActiveSessions, listSessions, removeSession, toPublicSession } from "../state/SessionRegistry.js";
import { loadConfig } from "../config.js";
import { registerTool } from "./toolUtils.js";
import { limitText } from "../runtime/outputLimits.js";
import { formatSkillForPrompt, readFullSkill } from "./skills.js";
import { stateStore } from "../state/StateStore.js";
import { assertChatGptPermission } from "../policy/permissionPolicy.js";
import { appendSessionEvent, readSessionEvents } from "../state/SessionEvents.js";

export function registerAgentTools(server: McpServer): void {
  registerTool(server, "agent_run_task", "Use this when the user wants to spawn a Flue-backed Portus agent to perform a task in a registered project.", {
    projectAlias: z.string(),
    task: z.string(),
    agentTemplate: z.string().optional(),
    timeoutSecs: z.number().int().positive().optional()
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async ({ projectAlias, task, agentTemplate, timeoutSecs }) => {
    assertChatGptPermission("spawnAgents", projectAlias);
    const config = loadConfig();
    return toPublicSession(await runFlueTask({
      projectAlias,
      task,
      agentTemplate: agentTemplate ?? config.agents.defaultTemplate,
      timeoutSecs
    }));
  });

  registerTool(server, "agent_spawn", "Use this when ChatGPT needs to start a tracked Portus agent session.", {
    projectAlias: z.string(),
    task: z.string(),
    agentTemplate: z.string().optional(),
    timeoutSecs: z.number().int().positive().optional()
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async ({ projectAlias, task, agentTemplate, timeoutSecs }) => {
    assertChatGptPermission("spawnAgents", projectAlias);
    const config = loadConfig();
    return toPublicSession(await runFlueTask({
      projectAlias,
      task,
      agentTemplate: agentTemplate ?? config.agents.defaultTemplate,
      timeoutSecs
    }));
  });

  registerTool(server, "agent_run_skill", "Use this when ChatGPT needs to start an agent session with a named local skill.", {
    projectAlias: z.string(),
    skillName: z.string(),
    task: z.string(),
    agentTemplate: z.string().optional(),
    timeoutSecs: z.number().int().positive().optional()
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async ({ projectAlias, skillName, task, agentTemplate, timeoutSecs }) => {
    assertChatGptPermission("spawnAgents", projectAlias);
    const config = loadConfig();
    const skill = readFullSkill(skillName);
    return toPublicSession(await runFlueTask({
      projectAlias,
      agentTemplate: agentTemplate ?? config.agents.defaultTemplate,
      timeoutSecs,
      task: [
        `Use the following skill for this task.`,
        "",
        `Skill: ${skillName}`,
        "",
          formatSkillForPrompt(skill),
        "",
        "Task:",
        task
      ].join("\n")
    }));
  });

  registerTool(server, "agent_status", "Use this when ChatGPT needs to check an agent session status.", {
    sessionId: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ sessionId }) => toPublicSession(getSession(sessionId)));

  registerTool(server, "agent_collect_result", "Use this when ChatGPT needs to inspect result/stdout/stderr from a completed agent session.", {
    sessionId: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ sessionId }) => ({
    session: toPublicSession(getSession(sessionId)),
    outputs: collectFlueResult(sessionId)
  }));

  registerTool(server, "agent_stop", "Use this when ChatGPT needs to stop a running agent session.", {
    sessionId: z.string()
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ sessionId }) => {
    const session = getSession(sessionId);
    assertChatGptPermission("spawnAgents", session.projectAlias);
    return toPublicSession(stopFlueTask(sessionId));
  });

  registerTool(server, "session_list", "Use this when ChatGPT needs to list known Portus agent sessions.", {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => listSessions().map(toPublicSession));
  registerTool(server, "session_list_active", "Use this when ChatGPT needs to list running Portus agent sessions.", {
    projectAlias: z.string().optional()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => listActiveSessions(projectAlias).map(toPublicSession));

  registerTool(server, "session_status", "Use this when ChatGPT needs to inspect a Portus session status.", {
    sessionId: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ sessionId }) => toPublicSession(getSession(sessionId)));

  registerTool(server, "session_collect_artifacts", "Use this when ChatGPT needs to collect session metadata and output artifacts.", {
    sessionId: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ sessionId }) => {
    const session = getSession(sessionId);
    return {
      session: toPublicSession(session),
      outputs: collectFlueResult(sessionId)
    };
  });

  registerTool(server, "session_read_log", "Use this when ChatGPT needs to read stdout or stderr logs for a session.", {
    sessionId: z.string(),
    stream: z.enum(["stdout", "stderr", "result"]).default("result")
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ sessionId, stream }) => {
    const session = getSession(sessionId);
    const target = stream === "stdout" ? session.stdoutPath : stream === "stderr" ? session.stderrPath : session.resultPath;
    const limited = limitText(readFileSync(target, "utf8"));
    return { sessionId, stream, content: limited.text, truncated: limited.truncated, bytes: limited.bytes, limit: limited.limit };
  });

  registerTool(server, "session_read_events", "Use this when ChatGPT needs to inspect incremental session events without rereading full logs.", {
    sessionId: z.string(),
    afterSequence: z.number().int().min(0).default(0),
    limit: z.number().int().positive().max(500).default(100)
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ sessionId, afterSequence, limit }) => readSessionEvents({ sessionId, afterSequence, limit }));

  registerTool(server, "session_stop_all", "Stop all running sessions, optionally scoped to one project.", {
    projectAlias: z.string().optional()
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => {
    const active = listActiveSessions(projectAlias);
    for (const session of active) {
      assertChatGptPermission("spawnAgents", session.projectAlias);
    }
    const stopped = active.map((session) => stopFlueTask(session.sessionId));
    stateStore.audit({ tool: "session_stop_all", projectAlias: projectAlias ?? null, stopped: stopped.map((item) => item.sessionId) });
    return { projectAlias: projectAlias ?? null, stoppedSessionIds: stopped.map((item) => item.sessionId) };
  });

  registerTool(server, "session_cleanup", "Remove artifacts and registry entry for one non-running session.", {
    sessionId: z.string()
  }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ sessionId }) => {
    const session = getSession(sessionId);
    if (session.status === "running" || session.status === "queued") throw new Error("Cannot clean up a running or queued session.");
    assertChatGptPermission("spawnAgents", session.projectAlias);
    const sessionDir = path.dirname(session.metadataPath);
    appendSessionEvent(session, "cleanup", "Session artifacts cleaned up.", {});
    rmSync(sessionDir, { recursive: true, force: true });
    removeSession(sessionId);
    stateStore.audit({ tool: "session_cleanup", sessionId, projectAlias: session.projectAlias });
    return { sessionId, cleaned: true };
  });

  registerTool(server, "session_cleanup_completed", "Clean completed/stopped/failed sessions older than N days.", {
    projectAlias: z.string().optional(),
    olderThanDays: z.number().int().positive().default(7),
    dryRun: z.boolean().default(false)
  }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ projectAlias, olderThanDays, dryRun }) => {
    const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const candidates = listSessions().filter((session) => (session.status === "completed" || session.status === "failed" || session.status === "stopped") && (!projectAlias || session.projectAlias === projectAlias) && Date.parse(session.completedAt ?? session.startedAt) < cutoffMs);
    for (const session of candidates) {
      assertChatGptPermission("spawnAgents", session.projectAlias);
    }
    if (!dryRun) {
      for (const session of candidates) {
        appendSessionEvent(session, "cleanup", "Session artifacts cleaned up.", { olderThanDays });
        rmSync(path.dirname(session.metadataPath), { recursive: true, force: true });
        removeSession(session.sessionId);
      }
    }
    stateStore.audit({ tool: "session_cleanup_completed", projectAlias: projectAlias ?? null, olderThanDays, dryRun, count: candidates.length });
    return { projectAlias: projectAlias ?? null, olderThanDays, dryRun, sessionIds: candidates.map((item) => item.sessionId) };
  });

  registerTool(server, "agent_limits", "Report current configured/active agent concurrency limits.", {
    projectAlias: z.string().optional()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => getAgentLimits(projectAlias));

  registerTool(server, "agent_templates", "List local agent templates.", {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => ({
    templates: [
      {
        name: "ephemeral-project-agent",
        description: "Default local project agent",
        supportsSkills: true
      }
    ]
  }));

  registerTool(server, "agent_template_describe", "Describe one local agent template.", {
    agentTemplate: z.string()
  }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ agentTemplate }) => {
    if (agentTemplate !== "ephemeral-project-agent") throw new Error(`Unknown template: ${agentTemplate}`);
    return {
      name: "ephemeral-project-agent",
      description: "Default local project agent",
      supportsSkills: true,
      expectedPayload: ["task", "projectRoot", "provider", "model"]
    };
  });
}
