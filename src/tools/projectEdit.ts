import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { countChars } from "../runtime/outputLimits.js";
import { stateStore } from "../state/StateStore.js";
import { safeError, safeRelativePath } from "./projectToolUtils.js";
import { assertCanReadProjectPath, hashSha256, isTextLikely } from "./projects.js";

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/i);
const MAX_EXACT_MATCH_LOCATIONS = 20;

export const editOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), relativePath: z.string().min(1), content: z.string(), expectedSha256: SHA256_SCHEMA.optional() }).strict(),
  z.object({ type: z.literal("replace"), relativePath: z.string().min(1), search: z.string().min(1), replace: z.string(), expectedOccurrences: z.number().int().positive(), expectedSha256: SHA256_SCHEMA.optional() }).strict(),
  z.object({ type: z.literal("insert"), relativePath: z.string().min(1), marker: z.string().min(1), content: z.string(), position: z.enum(["before", "after"]), expectedSha256: SHA256_SCHEMA.optional() }).strict(),
  z.object({ type: z.literal("copy"), sourceRelativePath: z.string().min(1), destinationRelativePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("move"), sourceRelativePath: z.string().min(1), destinationRelativePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("delete"), relativePath: z.string().min(1), confirm: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("mkdir"), relativePath: z.string().min(1), recursive: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("rmdir"), relativePath: z.string().min(1), recursive: z.boolean().default(false), confirm: z.boolean().default(false) }).strict()
]);

export type EditOperation = z.infer<typeof editOperationSchema>;
type EditOperationType = EditOperation["type"];
type SemanticReason = "occurrence_mismatch" | "stale_file" | "invalid_range" | "conflicting_base_hash" | "unsupported_batch_mode";
type ExactMatchLocation = { line: number; column: number };
type OperationIdentity = {
  index: number;
  type: EditOperationType;
  relativePath?: string;
  sourceRelativePath?: string;
  destinationRelativePath?: string;
};
type ResultDetails = Record<string, unknown>;

type AppliedResult = OperationIdentity & ResultDetails & {
  ok: true;
  outcome: "completed";
  operationStatus: "applied";
  fileChanged: true;
};
type NoChangeResult = OperationIdentity & ResultDetails & {
  ok: true;
  outcome: "completed";
  operationStatus: "no_change";
  fileChanged: false;
};
type PlannedResult = OperationIdentity & ResultDetails & {
  ok: true;
  outcome: "completed";
  operationStatus: "planned";
  wouldChange: true;
  fileChanged: false;
};
type RejectedResult = OperationIdentity & ResultDetails & {
  ok: false;
  outcome: "completed";
  operationStatus: "not_applied";
  reason: SemanticReason;
  fileChanged: false;
};
type FailedResult = OperationIdentity & {
  ok: false;
  outcome: "failed";
  operationStatus: "failed";
  error: string;
} & ({ fileChanged: false } | { repositoryState: "unknown" });
type SkippedResult = OperationIdentity & {
  ok: false;
  outcome: "skipped";
  operationStatus: "skipped";
  reason: "prior_operation_failed";
  fileChanged: false;
};

type OperationResult = AppliedResult | NoChangeResult | PlannedResult | RejectedResult | FailedResult | SkippedResult;
type SuccessfulEvaluation = AppliedResult | NoChangeResult | PlannedResult;

type MatchScan = {
  matchesFound: number;
  firstIndex: number | null;
  exactMatchLocations: ExactMatchLocation[];
  locationsTruncated: boolean;
  sourceChars: number;
};

class SemanticRejection extends Error {
  constructor(
    readonly reason: SemanticReason,
    readonly details: ResultDetails
  ) {
    super(reason);
  }
}

function assertInputChars(name: string, value: string, limit: number): number {
  const chars = countChars(value);
  if (chars > limit) throw new Error(`Input exceeds ${name}: ${chars} > ${limit} chars`);
  return chars;
}

function assertCharCount(name: string, chars: number, limit: number): void {
  if (chars > limit) throw new Error(`Input exceeds ${name}: ${chars} > ${limit} chars`);
}

function operationIdentity(index: number, operation: EditOperation): OperationIdentity {
  if (operation.type === "copy" || operation.type === "move") {
    return {
      index,
      type: operation.type,
      sourceRelativePath: safeRelativePath(operation.sourceRelativePath),
      destinationRelativePath: safeRelativePath(operation.destinationRelativePath)
    };
  }
  return { index, type: operation.type, relativePath: safeRelativePath(operation.relativePath) };
}

function relevantRelativePath(operation: EditOperation): string {
  return operation.type === "copy" || operation.type === "move"
    ? operation.sourceRelativePath
    : operation.relativePath;
}

function applied(identity: OperationIdentity, details: ResultDetails = {}): AppliedResult {
  return { ...identity, ok: true, outcome: "completed", operationStatus: "applied", fileChanged: true, ...details };
}

function noChange(identity: OperationIdentity, details: ResultDetails = {}): NoChangeResult {
  return { ...identity, ok: true, outcome: "completed", operationStatus: "no_change", fileChanged: false, ...details };
}

function planned(identity: OperationIdentity, details: ResultDetails = {}): PlannedResult {
  return { ...identity, ok: true, outcome: "completed", operationStatus: "planned", wouldChange: true, fileChanged: false, ...details };
}

function rejected(identity: OperationIdentity, rejection: SemanticRejection): RejectedResult {
  return {
    ...identity,
    ok: false,
    outcome: "completed",
    operationStatus: "not_applied",
    reason: rejection.reason,
    fileChanged: false,
    ...rejection.details
  };
}

function failed(identity: OperationIdentity, error: unknown, relativePath: string, mutationAttempted: boolean): FailedResult {
  return {
    ...identity,
    ok: false,
    outcome: "failed",
    operationStatus: "failed",
    error: safeError(error, relativePath),
    ...(mutationAttempted ? { repositoryState: "unknown" as const } : { fileChanged: false as const })
  };
}

function skipped(index: number, operation: EditOperation): SkippedResult {
  return {
    ...operationIdentity(index, operation),
    ok: false,
    outcome: "skipped",
    operationStatus: "skipped",
    reason: "prior_operation_failed",
    fileChanged: false
  };
}

function scanExactMatches(source: string, marker: string): MatchScan {
  let matchesFound = 0;
  let firstIndex: number | null = null;
  let searchIndex = 0;
  let positionIndex = 0;
  let sourceChars = 0;
  let line = 1;
  let column = 1;
  const exactMatchLocations: ExactMatchLocation[] = [];

  while (searchIndex <= source.length - marker.length) {
    const matchIndex = source.indexOf(marker, searchIndex);
    if (matchIndex === -1) break;

    while (positionIndex < matchIndex) {
      const codePoint = source.codePointAt(positionIndex)!;
      if (codePoint === 0x0a) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      positionIndex += codePoint > 0xffff ? 2 : 1;
      sourceChars += 1;
    }

    if (firstIndex === null) firstIndex = matchIndex;
    matchesFound += 1;
    if (exactMatchLocations.length < MAX_EXACT_MATCH_LOCATIONS) {
      exactMatchLocations.push({ line, column });
    }

    const matchEnd = matchIndex + marker.length;
    while (positionIndex < matchEnd) {
      const codePoint = source.codePointAt(positionIndex)!;
      if (codePoint === 0x0a) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      positionIndex += codePoint > 0xffff ? 2 : 1;
      sourceChars += 1;
    }
    searchIndex = matchEnd;
  }
  while (positionIndex < source.length) {
    const codePoint = source.codePointAt(positionIndex)!;
    sourceChars += 1;
    positionIndex += codePoint > 0xffff ? 2 : 1;
  }


  return {
    matchesFound,
    firstIndex,
    exactMatchLocations,
    sourceChars,
    locationsTruncated: matchesFound > exactMatchLocations.length
  };
}

function replaceExactMatches(source: string, marker: string, replacement: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor <= source.length - marker.length) {
    const matchIndex = source.indexOf(marker, cursor);
    if (matchIndex === -1) break;
    parts.push(source.slice(cursor, matchIndex), replacement);
    cursor = matchIndex + marker.length;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function assertExpectedHash(expectedSha256: string | undefined, relativePath: string, content: Buffer): void {
  if (expectedSha256 && hashSha256(content) !== expectedSha256) {
    throw new SemanticRejection("stale_file", { relativePath: safeRelativePath(relativePath) });
  }
}

function readTextSource(projectAlias: string, relativePath: string, expectedSha256: string | undefined): { target: string; source: string } {
  const target = resolveProjectPath(projectAlias, relativePath);
  assertCanReadProjectPath(projectAlias, target, relativePath);
  if (!isTextLikely(target)) throw new Error("binary_file");
  const content = readFileSync(target);
  assertExpectedHash(expectedSha256, relativePath, content);
  return { target, source: content.toString("utf8") };
}

function auditTextOperation(input: {
  operation: "replace" | "insert";
  projectAlias: string;
  relativePath: string;
  matchesFound: number;
  dryRun: boolean;
}): void {
  stateStore.audit({
    tool: "project_edit",
    operation: input.operation,
    projectAlias: input.projectAlias,
    relativePath: input.relativePath,
    occurrences: input.matchesFound,
    dryRun: input.dryRun
  });
}

function executeWrite(index: number, operation: Extract<EditOperation, { type: "write" }>, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  assertInputChars("limits.fileWrite.maxChars", operation.content, policy.limits.fileWrite.maxChars);
  const target = resolveProjectPath(projectAlias, operation.relativePath);
  const desired = Buffer.from(operation.content, "utf8");

  if (existsSync(target)) {
    assertCanReadProjectPath(projectAlias, target, operation.relativePath);
    const current = readFileSync(target);
    assertExpectedHash(operation.expectedSha256, operation.relativePath, current);
    if (current.equals(desired)) {
      stateStore.audit({ tool: "project_edit", operation: "write", projectAlias, relativePath: operation.relativePath, dryRun, bytes: desired.length });
      return noChange(identity, { bytes: desired.length });
    }
  } else if (operation.expectedSha256) {
    throw new SemanticRejection("stale_file", { relativePath: safeRelativePath(operation.relativePath) });
  }

  if (dryRun) {
    stateStore.audit({ tool: "project_edit", operation: "write", projectAlias, relativePath: operation.relativePath, dryRun, bytes: desired.length });
    return planned(identity, { bytes: desired.length });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  mkdirSync(path.dirname(target), { recursive: true });
  resolveProjectPath(projectAlias, operation.relativePath);
  writeFileSync(target, desired);
  stateStore.audit({ tool: "project_edit", operation: "write", projectAlias, relativePath: operation.relativePath, dryRun, bytes: desired.length });
  return applied(identity, { bytes: desired.length });
}

function executeReplace(index: number, operation: Extract<EditOperation, { type: "replace" }>, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig, markMutation: () => void): OperationResult {
  const identity = operationIdentity(index, operation);
  const searchChars = assertInputChars("limits.textEdit.maxSearchOrMarkerChars", operation.search, policy.limits.textEdit.maxSearchOrMarkerChars);
  const replacementChars = assertInputChars("limits.textEdit.maxOperationChars", operation.replace, policy.limits.textEdit.maxOperationChars);
  const { target, source } = readTextSource(projectAlias, operation.relativePath, operation.expectedSha256);
  const scan = scanExactMatches(source, operation.search);
  const matchDetails = {
    expectedOccurrences: operation.expectedOccurrences,
    matchesFound: scan.matchesFound,
    exactMatchLocations: scan.exactMatchLocations,
    locationsTruncated: scan.locationsTruncated
  };

  if (scan.matchesFound !== operation.expectedOccurrences) {
    throw new SemanticRejection("occurrence_mismatch", { ...matchDetails, matchesApplied: 0 });
  }

  if (operation.search === operation.replace) {
    auditTextOperation({ operation: "replace", projectAlias, relativePath: operation.relativePath, matchesFound: scan.matchesFound, dryRun });
    return noChange(identity, { ...matchDetails, matchesApplied: 0 });
  }
  const projectedChars = scan.sourceChars + scan.matchesFound * (replacementChars - searchChars);
  assertCharCount("limits.fileWrite.maxChars", projectedChars, policy.limits.fileWrite.maxChars);
  const updated = replaceExactMatches(source, operation.search, operation.replace);
  if (dryRun) {
    auditTextOperation({ operation: "replace", projectAlias, relativePath: operation.relativePath, matchesFound: scan.matchesFound, dryRun });
    return planned(identity, { ...matchDetails, matchesPlanned: scan.matchesFound, matchesApplied: 0 });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  writeFileSync(target, updated, "utf8");
  auditTextOperation({ operation: "replace", projectAlias, relativePath: operation.relativePath, matchesFound: scan.matchesFound, dryRun });
  return applied(identity, { ...matchDetails, matchesApplied: scan.matchesFound });
}

function executeInsert(index: number, operation: Extract<EditOperation, { type: "insert" }>, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig, markMutation: () => void): OperationResult {
  const identity = operationIdentity(index, operation);
  assertInputChars("limits.textEdit.maxSearchOrMarkerChars", operation.marker, policy.limits.textEdit.maxSearchOrMarkerChars);
  const contentChars = assertInputChars("limits.textEdit.maxOperationChars", operation.content, policy.limits.textEdit.maxOperationChars);
  const { target, source } = readTextSource(projectAlias, operation.relativePath, operation.expectedSha256);
  const scan = scanExactMatches(source, operation.marker);
  const matchDetails = {
    expectedOccurrences: 1,
    matchesFound: scan.matchesFound,
    exactMatchLocations: scan.exactMatchLocations,
    locationsTruncated: scan.locationsTruncated
  };

  if (scan.matchesFound !== 1 || scan.firstIndex === null) {
    throw new SemanticRejection("occurrence_mismatch", { ...matchDetails, matchesApplied: 0 });
  }

  if (contentChars === 0) {
    auditTextOperation({ operation: "insert", projectAlias, relativePath: operation.relativePath, matchesFound: 1, dryRun });
    return noChange(identity, { ...matchDetails, matchesApplied: 0 });
  }
  assertCharCount("limits.fileWrite.maxChars", scan.sourceChars + contentChars, policy.limits.fileWrite.maxChars);
  const markerEnd = scan.firstIndex + operation.marker.length;
  const updated = operation.position === "before"
    ? `${source.slice(0, scan.firstIndex)}${operation.content}${source.slice(scan.firstIndex)}`
    : `${source.slice(0, markerEnd)}${operation.content}${source.slice(markerEnd)}`;
  if (dryRun) {
    auditTextOperation({ operation: "insert", projectAlias, relativePath: operation.relativePath, matchesFound: 1, dryRun });
    return planned(identity, { ...matchDetails, matchesPlanned: 1, matchesApplied: 0 });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  writeFileSync(target, updated, "utf8");
  auditTextOperation({ operation: "insert", projectAlias, relativePath: operation.relativePath, matchesFound: 1, dryRun });
  return applied(identity, { ...matchDetails, matchesApplied: 1 });
}

function executeCopy(index: number, operation: Extract<EditOperation, { type: "copy" }>, projectAlias: string, dryRun: boolean, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  const source = resolveProjectPath(projectAlias, operation.sourceRelativePath);
  const destination = resolveProjectPath(projectAlias, operation.destinationRelativePath);
  assertCanReadProjectPath(projectAlias, source, operation.sourceRelativePath);
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`Source file does not exist or is not a file: ${operation.sourceRelativePath}`);
  }
  const existed = existsSync(destination);
  if (existed) assertCanReadProjectPath(projectAlias, destination, operation.destinationRelativePath);
  if (existed && !operation.overwrite) throw new Error(`Destination already exists: ${operation.destinationRelativePath}`);
  if (dryRun) {
    stateStore.audit({ tool: "project_edit", operation: "copy", projectAlias, sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrite: operation.overwrite, dryRun });
    return planned(identity, { overwrote: existed });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.sourceRelativePath);
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  markMutation();
  mkdirSync(path.dirname(destination), { recursive: true });
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  copyFileSync(source, destination);
  stateStore.audit({ tool: "project_edit", operation: "copy", projectAlias, sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrite: operation.overwrite, dryRun });
  return applied(identity, { overwrote: existed });
}

function executeMove(index: number, operation: Extract<EditOperation, { type: "move" }>, projectAlias: string, dryRun: boolean, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  const source = resolveProjectPath(projectAlias, operation.sourceRelativePath);
  const destination = resolveProjectPath(projectAlias, operation.destinationRelativePath);
  assertCanReadProjectPath(projectAlias, source, operation.sourceRelativePath);
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`Source file does not exist or is not a file: ${operation.sourceRelativePath}`);
  }
  if (!existsSync(path.dirname(destination))) throw new Error(`Destination parent does not exist: ${operation.destinationRelativePath}`);
  const existed = existsSync(destination);
  if (existed && !operation.overwrite) throw new Error(`Destination already exists: ${operation.destinationRelativePath}`);
  if (existed) assertCanReadProjectPath(projectAlias, destination, operation.destinationRelativePath);
  if (dryRun) {
    stateStore.audit({ tool: "project_edit", operation: "move", projectAlias, sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrite: operation.overwrite, dryRun });
    return planned(identity, { overwrote: existed });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.sourceRelativePath);
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  markMutation();
  if (existed) unlinkSync(destination);
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  renameSync(source, destination);
  stateStore.audit({ tool: "project_edit", operation: "move", projectAlias, sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrite: operation.overwrite, dryRun });
  return applied(identity, { overwrote: existed });
}

function executeDelete(index: number, operation: Extract<EditOperation, { type: "delete" }>, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  if (policyPermissions(policy).main_agent.requireConfirmation && !operation.confirm) {
    throw new Error("Confirmation required: set confirm=true");
  }
  const target = resolveProjectPath(projectAlias, operation.relativePath);
  assertCanReadProjectPath(projectAlias, target, operation.relativePath);
  const info = statSync(target);
  if (!info.isFile()) throw new Error(`Not a file: ${operation.relativePath}`);
  if (dryRun) {
    stateStore.audit({ tool: "project_edit", operation: "delete", projectAlias, relativePath: operation.relativePath, bytes: info.size, dryRun });
    return planned(identity, { bytes: info.size });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  unlinkSync(target);
  stateStore.audit({ tool: "project_edit", operation: "delete", projectAlias, relativePath: operation.relativePath, bytes: info.size, dryRun });
  return applied(identity, { bytes: info.size });
}

function executeMkdir(index: number, operation: Extract<EditOperation, { type: "mkdir" }>, projectAlias: string, dryRun: boolean, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  const target = resolveProjectPath(projectAlias, operation.relativePath);
  if (existsSync(target)) {
    if (operation.recursive && lstatSync(target).isDirectory()) {
      stateStore.audit({ tool: "project_edit", operation: "mkdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
      return noChange(identity);
    }
    throw new Error(`Destination already exists: ${operation.relativePath}`);
  }
  if (dryRun) {
    stateStore.audit({ tool: "project_edit", operation: "mkdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
    return planned(identity);
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  mkdirSync(target, { recursive: operation.recursive });
  stateStore.audit({ tool: "project_edit", operation: "mkdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
  return applied(identity);
}

function executeRmdir(index: number, operation: Extract<EditOperation, { type: "rmdir" }>, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  if (policyPermissions(policy).main_agent.requireConfirmation && !operation.confirm) {
    throw new Error("Confirmation required: set confirm=true");
  }
  const target = resolveProjectPath(projectAlias, operation.relativePath);
  assertCanReadProjectPath(projectAlias, target, operation.relativePath);
  const info = lstatSync(target);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${operation.relativePath}`);
  if (dryRun) {
    stateStore.audit({ tool: "project_edit", operation: "rmdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
    return planned(identity);
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  rmSync(target, { recursive: operation.recursive, force: false });
  stateStore.audit({ tool: "project_edit", operation: "rmdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
  return applied(identity);
}

function executeOperation(index: number, operation: EditOperation, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig): OperationResult {
  let mutationAttempted = false;
  const markMutation = (): void => {
    mutationAttempted = true;
  };

  try {
    switch (operation.type) {
      case "write": return executeWrite(index, operation, projectAlias, dryRun, policy, markMutation);
      case "replace": return executeReplace(index, operation, projectAlias, dryRun, policy, markMutation);
      case "insert": return executeInsert(index, operation, projectAlias, dryRun, policy, markMutation);
      case "copy": return executeCopy(index, operation, projectAlias, dryRun, markMutation);
      case "move": return executeMove(index, operation, projectAlias, dryRun, markMutation);
      case "delete": return executeDelete(index, operation, projectAlias, dryRun, policy, markMutation);
      case "mkdir": return executeMkdir(index, operation, projectAlias, dryRun, markMutation);
      case "rmdir": return executeRmdir(index, operation, projectAlias, dryRun, policy, markMutation);
    }
  } catch (error) {
    const identity = operationIdentity(index, operation);
    return error instanceof SemanticRejection
      ? rejected(identity, error)
      : failed(identity, error, relevantRelativePath(operation), mutationAttempted);
  }
}

export type ProjectEditBatchResult = {
  projectAlias: string;
  batchMode: "ordered";
  batchOutcome: "succeeded" | "planned" | "rejected" | "partial" | "failed";
  repositoryState: "unchanged" | "changed" | "partially_changed" | "unknown";
  dryRun: boolean;
  requestedCount: number;
  successCount: number;
  failedCount: number;
  errorCount: number;
  appliedCount: number;
  noChangeCount: number;
  plannedCount: number;
  skippedCount: number;
  results: OperationResult[];
};

export function executeProjectEditBatch(input: {
  projectAlias: string;
  operations: EditOperation[];
  dryRun: boolean;
  continueOnFailure: boolean;
  policy: PortusPolicyConfig;
}): ProjectEditBatchResult {
  const results: OperationResult[] = [];
  let stop = false;
  for (const [index, operation] of input.operations.entries()) {
    if (stop) {
      results.push(skipped(index, operation));
      continue;
    }
    const result = executeOperation(index, operation, input.projectAlias, input.dryRun, input.policy);
    results.push(result);
    if (!result.ok && !input.continueOnFailure) stop = true;
  }
  const successCount = results.filter((result) => result.ok).length;
  const failedCount = results.filter((result) => !result.ok && result.outcome === "completed").length;
  const errorCount = results.filter((result) => result.outcome === "failed").length;
  const appliedCount = results.filter((result) => result.operationStatus === "applied").length;
  const noChangeCount = results.filter((result) => result.operationStatus === "no_change").length;
  const plannedCount = results.filter((result) => result.operationStatus === "planned").length;
  const skippedCount = results.filter((result) => result.operationStatus === "skipped").length;
  const hasUnknownRepositoryState = results.some((result) => result.outcome === "failed" && "repositoryState" in result);
  const incompleteCount = failedCount + errorCount + skippedCount;
  const repositoryState = hasUnknownRepositoryState
    ? "unknown"
    : appliedCount > 0 && incompleteCount > 0
      ? "partially_changed"
      : appliedCount > 0
        ? "changed"
        : "unchanged";
  const batchOutcome = appliedCount > 0 && incompleteCount > 0
    ? "partial"
    : errorCount > 0
      ? "failed"
      : failedCount > 0
        ? "rejected"
        : input.dryRun
          ? "planned"
          : "succeeded";

  return {
    projectAlias: input.projectAlias,
    batchMode: "ordered",
    batchOutcome,
    repositoryState,
    dryRun: input.dryRun,
    requestedCount: input.operations.length,
    successCount,
    failedCount,
    errorCount,
    appliedCount,
    noChangeCount,
    plannedCount,
    skippedCount,
    results
  };
}
