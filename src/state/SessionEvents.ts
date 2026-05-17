import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getSession, type SessionRecord } from "./SessionRegistry.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { limitText } from "../runtime/outputLimits.js";

export type SessionEvent = {
  sequence: number;
  timestamp: string;
  sessionId: string;
  projectAlias: string;
  type: string;
  message: string;
  data: Record<string, unknown>;
};

export function sessionEventsPath(session: Pick<SessionRecord, "metadataPath" | "eventsPath">): string {
  return session.eventsPath ?? path.join(path.dirname(session.metadataPath), "events.jsonl");
}

export function appendSessionEvent(
  session: Pick<SessionRecord, "sessionId" | "projectAlias" | "metadataPath" | "eventsPath">,
  type: string,
  message: string,
  data: Record<string, unknown> = {}
): void {
  try {
    const filePath = sessionEventsPath(session);
    const event: SessionEvent = {
      sequence: nextSequence(filePath),
      timestamp: new Date().toISOString(),
      sessionId: session.sessionId,
      projectAlias: session.projectAlias,
      type,
      message,
      data: limitEventData(data)
    };
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Event writes are observability only. They must not break session execution.
  }
}

export function appendSessionEventById(
  sessionId: string,
  type: string,
  message: string,
  data: Record<string, unknown> = {}
): void {
  appendSessionEvent(getSession(sessionId), type, message, data);
}

export function readSessionEvents(input: {
  sessionId: string;
  afterSequence?: number;
}): { sessionId: string; events: SessionEvent[]; nextSequence: number; hasMore: boolean } {
  const session = getSession(input.sessionId);
  const filePath = sessionEventsPath(session);
  const policy = loadPolicyConfig().limits.sessionEvents;
  const afterSequence = Math.max(0, input.afterSequence ?? 0);
  const limit = policy.maxEvents;
  if (!existsSync(filePath)) {
    return { sessionId: input.sessionId, events: [], nextSequence: afterSequence, hasMore: false };
  }

  const events = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent)
    .filter((event) => event.sequence > afterSequence);
  const page = events.slice(0, limit);
  const nextSequence = page.length > 0 ? page[page.length - 1]!.sequence : afterSequence;
  return {
    sessionId: input.sessionId,
    events: page,
    nextSequence,
    hasMore: events.length > page.length
  };
}

function nextSequence(filePath: string): number {
  if (!existsSync(filePath)) return 1;
  const lines = readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return 1;
  try {
    const last = JSON.parse(lines[lines.length - 1]!) as { sequence?: unknown };
    return typeof last.sequence === "number" ? last.sequence + 1 : lines.length + 1;
  } catch {
    return lines.length + 1;
  }
}

function limitEventData(data: Record<string, unknown>): Record<string, unknown> {
  const maxChunkChars = loadPolicyConfig().limits.sessionEvents.maxChunkChars;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === "string"
      ? limitText(value, maxChunkChars).text
      : value;
  }
  return out;
}
