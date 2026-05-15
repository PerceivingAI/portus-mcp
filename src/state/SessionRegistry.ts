import { stateStore } from "./StateStore.js";

export type SessionRecord = {
  sessionId: string;
  projectAlias: string;
  agentTemplate: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  queuedAt?: string;
  dequeuedAt?: string;
  queueWaitMs?: number;
  completedAt?: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  metadataPath: string;
  eventsPath?: string;
  exitCode?: number | null;
};

export type PublicSession = {
  sessionId: string;
  projectAlias: string;
  agentTemplate: string;
  status: SessionRecord["status"];
  startedAt: string;
  queuedAt?: string;
  dequeuedAt?: string;
  queueWaitMs?: number;
  completedAt?: string;
  exitCode?: number | null;
};

type SessionState = {
  sessions: SessionRecord[];
};

const FILE = "sessions.json";

export function listSessions(): SessionRecord[] {
  return stateStore.readJson<SessionState>(FILE, { sessions: [] }).sessions;
}

export function getSession(sessionId: string): SessionRecord {
  const session = listSessions().find((item) => item.sessionId === sessionId);
  if (!session) throw new Error(`Unknown session id: ${sessionId}`);
  return session;
}

export function upsertSession(record: SessionRecord): SessionRecord {
  const state = stateStore.readJson<SessionState>(FILE, { sessions: [] });
  state.sessions = state.sessions.filter((item) => item.sessionId !== record.sessionId);
  state.sessions.push(record);
  stateStore.writeJson(FILE, state);
  return record;
}

export function listActiveSessions(projectAlias?: string): SessionRecord[] {
  return listSessions().filter((session) => session.status === "running" && (!projectAlias || session.projectAlias === projectAlias));
}

export function removeSession(sessionId: string): void {
  const state = stateStore.readJson<SessionState>(FILE, { sessions: [] });
  state.sessions = state.sessions.filter((item) => item.sessionId !== sessionId);
  stateStore.writeJson(FILE, state);
}

export function toPublicSession(session: SessionRecord): PublicSession {
  const output: PublicSession = {
    sessionId: session.sessionId,
    projectAlias: session.projectAlias,
    agentTemplate: session.agentTemplate,
    status: session.status,
    startedAt: session.startedAt
  };
  if (session.queuedAt !== undefined) output.queuedAt = session.queuedAt;
  if (session.dequeuedAt !== undefined) output.dequeuedAt = session.dequeuedAt;
  if (session.queueWaitMs !== undefined) output.queueWaitMs = session.queueWaitMs;
  if (session.completedAt !== undefined) output.completedAt = session.completedAt;
  if (session.exitCode !== undefined) output.exitCode = session.exitCode;
  return output;
}
