import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
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
  z.object({ type: z.literal("replace_range"), relativePath: z.string().min(1), expectedSha256: SHA256_SCHEMA, startLine: z.number().int().positive(), endLine: z.number().int().positive(), replacement: z.string() }).strict(),
  z.object({ type: z.literal("copy"), sourceRelativePath: z.string().min(1), destinationRelativePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("move"), sourceRelativePath: z.string().min(1), destinationRelativePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("delete"), relativePath: z.string().min(1), confirm: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("mkdir"), relativePath: z.string().min(1), recursive: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("rmdir"), relativePath: z.string().min(1), recursive: z.boolean().default(false), confirm: z.boolean().default(false) }).strict()
]);

export type EditOperation = z.infer<typeof editOperationSchema>;
export const editBatchModeSchema = z.enum(["staged", "ordered"]).default("staged");
export type EditBatchMode = z.infer<typeof editBatchModeSchema>;
type EditOperationType = EditOperation["type"];
type StagedEditOperation = Extract<EditOperation, { type: "write" | "replace" | "insert" | "replace_range" }>;
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
type LineRange = { startLine: number; endLine: number };
export type RangeTransformationResult =
  | {
      ok: false;
      reason: "invalid_range";
      requestedRange: LineRange;
      availableLines?: number;
      maxRangeLines: number;
    }
  | {
      ok: true;
      updatedContent: Buffer;
      oldRange: LineRange;
      newRange: LineRange | null;
      oldSha256: string;
      newSha256: string;
      wouldChange: boolean;
    };


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
  reason: "prior_operation_failed" | "batch_rejected" | "batch_failed";
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

function skipped(index: number, operation: EditOperation, reason: SkippedResult["reason"] = "prior_operation_failed"): SkippedResult {
  return {
    ...operationIdentity(index, operation),
    ok: false,
    outcome: "skipped",
    operationStatus: "skipped",
    reason,
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
export function transformLineRange(input: {
  source: Buffer;
  startLine: number;
  endLine: number;
  replacement: string;
  maxRangeLines: number;
}): RangeTransformationResult {
  const requestedRange = { startLine: input.startLine, endLine: input.endLine };
  const width = input.endLine - input.startLine + 1;
  if (
    !Number.isInteger(input.startLine)
    || !Number.isInteger(input.endLine)
    || input.startLine <= 0
    || input.endLine < input.startLine
    || width > input.maxRangeLines
  ) {
    return { ok: false, reason: "invalid_range", requestedRange, maxRangeLines: input.maxRangeLines };
  }

  let availableLines = 0;
  let lineStart = 0;
  let rangeStart = -1;
  let rangeEnd = -1;
  let preferredLineEnding: Buffer | undefined;
  for (let index = 0; index < input.source.length; index += 1) {
    const byte = input.source[index];
    let endingEnd = -1;
    if (byte === 0x0d) {
      endingEnd = input.source[index + 1] === 0x0a ? index + 2 : index + 1;
    } else if (byte === 0x0a) {
      endingEnd = index + 1;
    } else {
      continue;
    }

    availableLines += 1;
    if (availableLines === input.startLine) rangeStart = lineStart;
    if (availableLines === input.endLine) rangeEnd = endingEnd;
    preferredLineEnding ??= input.source.subarray(index, endingEnd);
    lineStart = endingEnd;
    index = endingEnd - 1;
  }

  const hasFinalLineEnding = input.source.length > 0 && lineStart === input.source.length;
  if (lineStart < input.source.length) {
    availableLines += 1;
    if (availableLines === input.startLine) rangeStart = lineStart;
    if (availableLines === input.endLine) rangeEnd = input.source.length;
  }

  if (input.endLine > availableLines || rangeStart < 0 || rangeEnd < 0) {
    return { ok: false, reason: "invalid_range", requestedRange, availableLines, maxRangeLines: input.maxRangeLines };
  }

  const lineEnding = (preferredLineEnding ?? Buffer.from("\n")).toString("utf8");
  const replacementLines = input.replacement === "" ? [] : input.replacement.split(/\r\n|\r|\n/);
  if (replacementLines.at(-1) === "") replacementLines.pop();
  let replacementContent = Buffer.from(replacementLines.join(lineEnding), "utf8");
  const suffix = input.source.subarray(rangeEnd);
  if (replacementLines.length > 0 && (suffix.length > 0 || (input.endLine === availableLines && hasFinalLineEnding))) {
    replacementContent = Buffer.concat([replacementContent, Buffer.from(lineEnding)]);
  }

  const updatedContent = Buffer.concat([
    input.source.subarray(0, rangeStart),
    replacementContent,
    suffix
  ]);
  return {
    ok: true,
    updatedContent,
    oldRange: requestedRange,
    newRange: replacementLines.length === 0
      ? null
      : { startLine: input.startLine, endLine: input.startLine + replacementLines.length - 1 },
    oldSha256: hashSha256(input.source),
    newSha256: hashSha256(updatedContent),
    wouldChange: !input.source.equals(updatedContent)
  };
}


function assertExpectedHash(expectedSha256: string | undefined, relativePath: string, content: Buffer): void {
  if (expectedSha256 && hashSha256(content) !== expectedSha256.toLowerCase()) {
    throw new SemanticRejection("stale_file", { relativePath: safeRelativePath(relativePath) });
  }
}

function readTextContent(projectAlias: string, relativePath: string, expectedSha256: string | undefined): { target: string; content: Buffer } {
  const target = resolveProjectPath(projectAlias, relativePath);
  assertCanReadProjectPath(projectAlias, target, relativePath);
  if (!isTextLikely(target)) throw new Error("binary_file");
  const content = readFileSync(target);
  assertExpectedHash(expectedSha256, relativePath, content);
  return { target, content };
}

function readTextSource(projectAlias: string, relativePath: string, expectedSha256: string | undefined): { target: string; source: string } {
  const { target, content } = readTextContent(projectAlias, relativePath, expectedSha256);
  return { target, source: content.toString("utf8") };
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
      return noChange(identity, { bytes: desired.length });
    }
  } else if (operation.expectedSha256) {
    throw new SemanticRejection("stale_file", { relativePath: safeRelativePath(operation.relativePath) });
  }

  if (dryRun) {
    return planned(identity, { bytes: desired.length });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  mkdirSync(path.dirname(target), { recursive: true });
  resolveProjectPath(projectAlias, operation.relativePath);
  writeFileSync(target, desired);
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
    return noChange(identity, { ...matchDetails, matchesApplied: 0 });
  }
  const projectedChars = scan.sourceChars + scan.matchesFound * (replacementChars - searchChars);
  assertCharCount("limits.fileWrite.maxChars", projectedChars, policy.limits.fileWrite.maxChars);
  const updated = replaceExactMatches(source, operation.search, operation.replace);
  if (dryRun) {
    return planned(identity, { ...matchDetails, matchesPlanned: scan.matchesFound, matchesApplied: 0 });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  writeFileSync(target, updated, "utf8");
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
    return noChange(identity, { ...matchDetails, matchesApplied: 0 });
  }
  assertCharCount("limits.fileWrite.maxChars", scan.sourceChars + contentChars, policy.limits.fileWrite.maxChars);
  const markerEnd = scan.firstIndex + operation.marker.length;
  const updated = operation.position === "before"
    ? `${source.slice(0, scan.firstIndex)}${operation.content}${source.slice(scan.firstIndex)}`
    : `${source.slice(0, markerEnd)}${operation.content}${source.slice(markerEnd)}`;
  if (dryRun) {
    return planned(identity, { ...matchDetails, matchesPlanned: 1, matchesApplied: 0 });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  writeFileSync(target, updated, "utf8");
  return applied(identity, { ...matchDetails, matchesApplied: 1 });
}
function executeReplaceRange(index: number, operation: Extract<EditOperation, { type: "replace_range" }>, projectAlias: string, dryRun: boolean, policy: PortusPolicyConfig, markMutation: () => void): OperationResult {
  const identity = operationIdentity(index, operation);
  assertInputChars("limits.textEdit.maxOperationChars", operation.replacement, policy.limits.textEdit.maxOperationChars);
  const { target, content } = readTextContent(projectAlias, operation.relativePath, operation.expectedSha256);
  const transformation = transformLineRange({
    source: content,
    startLine: operation.startLine,
    endLine: operation.endLine,
    replacement: operation.replacement,
    maxRangeLines: policy.limits.textEdit.maxRangeLines
  });
  if (!transformation.ok) {
    throw new SemanticRejection("invalid_range", {
      requestedRange: transformation.requestedRange,
      ...(transformation.availableLines === undefined ? {} : { availableLines: transformation.availableLines }),
      maxRangeLines: transformation.maxRangeLines
    });
  }

  if (!transformation.wouldChange) {
    return noChange(identity, {
      oldRange: transformation.oldRange,
      newRange: transformation.newRange,
      oldSha256: transformation.oldSha256,
      newSha256: transformation.newSha256
    });
  }

  assertCharCount("limits.fileWrite.maxChars", countChars(transformation.updatedContent.toString("utf8")), policy.limits.fileWrite.maxChars);
  if (dryRun) {
    return planned(identity, {
      oldRange: transformation.oldRange,
      projectedNewRange: transformation.newRange,
      oldSha256: transformation.oldSha256,
      projectedSha256: transformation.newSha256
    });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  writeFileSync(target, transformation.updatedContent);
  return applied(identity, {
    oldRange: transformation.oldRange,
    newRange: transformation.newRange,
    oldSha256: transformation.oldSha256,
    newSha256: transformation.newSha256
  });
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
    return planned(identity, { overwrote: existed });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.sourceRelativePath);
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  markMutation();
  mkdirSync(path.dirname(destination), { recursive: true });
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  copyFileSync(source, destination);
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
    return planned(identity, { overwrote: existed });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.sourceRelativePath);
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  markMutation();
  if (existed) unlinkSync(destination);
  resolveProjectPath(projectAlias, operation.destinationRelativePath);
  renameSync(source, destination);
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
    return planned(identity, { bytes: info.size });
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  unlinkSync(target);
  return applied(identity, { bytes: info.size });
}

function executeMkdir(index: number, operation: Extract<EditOperation, { type: "mkdir" }>, projectAlias: string, dryRun: boolean, markMutation: () => void): SuccessfulEvaluation {
  const identity = operationIdentity(index, operation);
  const target = resolveProjectPath(projectAlias, operation.relativePath);
  if (existsSync(target)) {
    if (operation.recursive && lstatSync(target).isDirectory()) {
      return noChange(identity);
    }
    throw new Error(`Destination already exists: ${operation.relativePath}`);
  }
  if (dryRun) {
    return planned(identity);
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  mkdirSync(target, { recursive: operation.recursive });
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
    return planned(identity);
  }

  stateStore.requireAuditWritable();
  resolveProjectPath(projectAlias, operation.relativePath);
  markMutation();
  if (operation.recursive) {
    rmSync(target, { recursive: true, force: false });
  } else {
    rmdirSync(target);
  }
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
      case "replace_range": return executeReplaceRange(index, operation, projectAlias, dryRun, policy, markMutation);
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

type PathProjection = {
  key: string;
  relativePath: string;
  target: string;
  baseExists: boolean;
  baseContent: Buffer | null;
  baseSha256?: string;
  projectedContent: Buffer | null;
  suppliedBaseHash?: string;
  firstTouchOrder: number;
  projectedIsText?: boolean;
};

type StagedChange = {
  plannedDetails: ResultDetails;
  appliedDetails: ResultDetails;
  canceledDetails: ResultDetails;
};

type StagedEvaluation = {
  index: number;
  operation: StagedEditOperation;
  projection?: PathProjection;
  result?: OperationResult;
  change?: StagedChange;
};

function canonicalProjectionKey(target: string): string {
  let nearestExisting = target;
  const missingSegments: string[] = [];
  while (!existsSync(nearestExisting)) {
    const parent = path.dirname(nearestExisting);
    if (parent === nearestExisting) break;
    missingSegments.unshift(path.basename(nearestExisting));
    nearestExisting = parent;
  }
  const canonicalExisting = realpathSync.native(nearestExisting);
  const canonicalTarget = path.join(canonicalExisting, ...missingSegments);
  return process.platform === "win32" ? canonicalTarget.toLowerCase() : canonicalTarget;
}

function captureStagedProjection(
  projectAlias: string,
  relativePath: string,
  projections: Map<string, PathProjection>,
  policy: PortusPolicyConfig
): PathProjection {
  const target = resolveProjectPath(projectAlias, relativePath);
  const key = canonicalProjectionKey(target);
  const existing = projections.get(key);
  if (existing) {
    if (existing.baseExists) {
      assertCanReadProjectPath(projectAlias, target, relativePath, undefined, policy);
    }
    return existing;
  }

  const baseExists = existsSync(target);
  let baseContent: Buffer | null = null;
  if (baseExists) {
    assertCanReadProjectPath(projectAlias, target, relativePath, undefined, policy);
    if (!statSync(target).isFile()) throw new Error(`Not a file: ${relativePath}`);
    baseContent = readFileSync(target);
  }
  const projection: PathProjection = {
    key,
    relativePath: safeRelativePath(relativePath),
    target,
    baseExists,
    baseContent,
    ...(baseContent === null ? {} : { baseSha256: hashSha256(baseContent) }),
    projectedContent: baseContent,
    firstTouchOrder: projections.size,
  };
  projections.set(key, projection);
  return projection;
}

function evaluateStagedOperation(
  index: number,
  operation: StagedEditOperation,
  projection: PathProjection,
  dryRun: boolean,
  policy: PortusPolicyConfig
): StagedEvaluation {
  const identity = operationIdentity(index, operation);
  const expectedSha256 = operation.expectedSha256?.toLowerCase();
  if (expectedSha256) {
    if (projection.suppliedBaseHash && projection.suppliedBaseHash !== expectedSha256) {
      throw new SemanticRejection("conflicting_base_hash", {});
    }
    if (!projection.baseExists || projection.baseSha256 !== expectedSha256) {
      throw new SemanticRejection("stale_file", {});
    }
    projection.suppliedBaseHash ??= expectedSha256;
  }

  if (operation.type === "write") {
    assertInputChars("limits.fileWrite.maxChars", operation.content, policy.limits.fileWrite.maxChars);
    const desired = Buffer.from(operation.content, "utf8");
    if (projection.projectedContent?.equals(desired)) {
      return { index, operation, projection, result: noChange(identity, { bytes: desired.length }) };
    }
    projection.projectedContent = desired;
    const details = { bytes: desired.length };
    projection.projectedIsText = true;
    return {
      index,
      operation,
      projection,
      change: { plannedDetails: details, appliedDetails: details, canceledDetails: details }
    };
  }

  const sourceContent = projection.projectedContent;
  if (sourceContent === null) throw new Error(`File does not exist: ${operation.relativePath}`);
  if (projection.projectedIsText === undefined) {
    projection.projectedIsText = isTextLikely(projection.target);
  }
  if (!projection.projectedIsText) throw new Error("binary_file");

  if (operation.type === "replace") {
    const searchChars = assertInputChars("limits.textEdit.maxSearchOrMarkerChars", operation.search, policy.limits.textEdit.maxSearchOrMarkerChars);
    const replacementChars = assertInputChars("limits.textEdit.maxOperationChars", operation.replace, policy.limits.textEdit.maxOperationChars);
    const source = sourceContent.toString("utf8");
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
      return {
        index,
        operation,
        projection,
        result: noChange(identity, {
          ...matchDetails,
          ...(dryRun ? {} : { matchesApplied: 0 })
        })
      };
    }
    const projectedChars = scan.sourceChars + scan.matchesFound * (replacementChars - searchChars);
    assertCharCount("limits.fileWrite.maxChars", projectedChars, policy.limits.fileWrite.maxChars);
    projection.projectedContent = Buffer.from(replaceExactMatches(source, operation.search, operation.replace), "utf8");
    return {
      index,
      operation,
      projection,
      change: {
        plannedDetails: { ...matchDetails, matchesPlanned: scan.matchesFound },
        appliedDetails: { ...matchDetails, matchesApplied: scan.matchesFound },
        canceledDetails: { ...matchDetails, matchesPlanned: scan.matchesFound, matchesApplied: 0 }
      }
    };
  }

  if (operation.type === "insert") {
    assertInputChars("limits.textEdit.maxSearchOrMarkerChars", operation.marker, policy.limits.textEdit.maxSearchOrMarkerChars);
    const contentChars = assertInputChars("limits.textEdit.maxOperationChars", operation.content, policy.limits.textEdit.maxOperationChars);
    const source = sourceContent.toString("utf8");
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
      return {
        index,
        operation,
        projection,
        result: noChange(identity, {
          ...matchDetails,
          ...(dryRun ? {} : { matchesApplied: 0 })
        })
      };
    }
    assertCharCount("limits.fileWrite.maxChars", scan.sourceChars + contentChars, policy.limits.fileWrite.maxChars);
    const markerEnd = scan.firstIndex + operation.marker.length;
    const updated = operation.position === "before"
      ? `${source.slice(0, scan.firstIndex)}${operation.content}${source.slice(scan.firstIndex)}`
      : `${source.slice(0, markerEnd)}${operation.content}${source.slice(markerEnd)}`;
    projection.projectedContent = Buffer.from(updated, "utf8");
    return {
      index,
      operation,
      projection,
      change: {
        plannedDetails: { ...matchDetails, matchesPlanned: 1 },
        appliedDetails: { ...matchDetails, matchesApplied: 1 },
        canceledDetails: { ...matchDetails, matchesPlanned: 1, matchesApplied: 0 }
      }
    };
  }

  assertInputChars("limits.textEdit.maxOperationChars", operation.replacement, policy.limits.textEdit.maxOperationChars);
  const transformation = transformLineRange({
    source: sourceContent,
    startLine: operation.startLine,
    endLine: operation.endLine,
    replacement: operation.replacement,
    maxRangeLines: policy.limits.textEdit.maxRangeLines
  });
  if (!transformation.ok) {
    throw new SemanticRejection("invalid_range", {
      requestedRange: transformation.requestedRange,
      ...(transformation.availableLines === undefined ? {} : { availableLines: transformation.availableLines }),
      maxRangeLines: transformation.maxRangeLines
    });
  }
  if (!transformation.wouldChange) {
    return {
      index,
      operation,
      projection,
      result: noChange(identity, {
        oldRange: transformation.oldRange,
        newRange: transformation.newRange,
        oldSha256: transformation.oldSha256,
        newSha256: transformation.newSha256
      })
    };
  }
  assertCharCount("limits.fileWrite.maxChars", countChars(transformation.updatedContent.toString("utf8")), policy.limits.fileWrite.maxChars);
  projection.projectedContent = transformation.updatedContent;
  return {
    index,
    operation,
    projection,
    change: {
      plannedDetails: {
        oldRange: transformation.oldRange,
        projectedNewRange: transformation.newRange,
        oldSha256: transformation.oldSha256,
        projectedSha256: transformation.newSha256
      },
      appliedDetails: {
        oldRange: transformation.oldRange,
        newRange: transformation.newRange,
        oldSha256: transformation.oldSha256,
        newSha256: transformation.newSha256
      },
      canceledDetails: {
        oldRange: transformation.oldRange,
        projectedNewRange: transformation.newRange,
        oldSha256: transformation.oldSha256,
        projectedSha256: transformation.newSha256
      }
    }
  };
}


const PROJECT_EDIT_MATCH_COUNT_FIELDS = [
  "expectedOccurrences",
  "matchesFound",
  "matchesApplied",
  "matchesPlanned"
] as const;

function auditProjectEditOperation(projectAlias: string, dryRun: boolean, result: OperationResult): void {
  const resultRecord = result as unknown as Record<string, unknown>;
  const event: Record<string, unknown> = {
    tool: "project_edit",
    projectAlias,
    batchIndex: result.index,
    operation: result.type,
    outcome: result.outcome,
    operationStatus: result.operationStatus,
    dryRun
  };
  if (result.relativePath !== undefined) event.relativePath = safeRelativePath(result.relativePath);
  if (result.sourceRelativePath !== undefined) event.sourceRelativePath = safeRelativePath(result.sourceRelativePath);
  if (result.destinationRelativePath !== undefined) event.destinationRelativePath = safeRelativePath(result.destinationRelativePath);
  if ("reason" in result) event.reason = result.reason;
  if ("fileChanged" in result) event.fileChanged = result.fileChanged;
  if ("repositoryState" in result) event.repositoryState = result.repositoryState;
  for (const field of PROJECT_EDIT_MATCH_COUNT_FIELDS) {
    if (typeof resultRecord[field] === "number") event[field] = resultRecord[field];
  }
  stateStore.audit(event);
}

function auditProjectEditBatchSummary(result: ProjectEditBatchResult): void {
  stateStore.audit({
    tool: "project_edit",
    projectAlias: result.projectAlias,
    batchMode: result.batchMode,
    batchOutcome: result.batchOutcome,
    repositoryState: result.repositoryState,
    requestedCount: result.requestedCount,
    successCount: result.successCount,
    failedCount: result.failedCount,
    errorCount: result.errorCount,
    appliedCount: result.appliedCount,
    noChangeCount: result.noChangeCount,
    plannedCount: result.plannedCount,
    skippedCount: result.skippedCount,
    dryRun: result.dryRun
  });
}

function combineBatchErrors(existing: string | undefined, auditError: string): string {
  return existing ?? auditError;
}

function auditProjectEditBatchResult(result: ProjectEditBatchResult): ProjectEditBatchResult {
  try {
    for (const operation of result.results) {
      auditProjectEditOperation(result.projectAlias, result.dryRun, operation);
    }
    auditProjectEditBatchSummary(result);
    return result;
  } catch (error) {
    const batchOutcome = result.batchOutcome === "partial"
      || result.repositoryState === "changed"
      || result.repositoryState === "partially_changed"
      ? "partial"
      : "failed";
    return {
      ...result,
      batchOutcome,
      batchError: combineBatchErrors(result.batchError, safeError(error))
    };
  }
}

function summarizeProjectEditBatch(input: {
  projectAlias: string;
  batchMode: EditBatchMode;
  dryRun: boolean;
  results: OperationResult[];
  repositoryState?: ProjectEditBatchResult["repositoryState"];
  batchOutcome?: ProjectEditBatchResult["batchOutcome"];
  batchError?: string;
}): ProjectEditBatchResult {
  const successCount = input.results.filter((result) => result.ok).length;
  const failedCount = input.results.filter((result) => !result.ok && result.outcome === "completed").length;
  const errorCount = input.results.filter((result) => result.outcome === "failed").length;
  const appliedCount = input.results.filter((result) => result.operationStatus === "applied").length;
  const noChangeCount = input.results.filter((result) => result.operationStatus === "no_change").length;
  const plannedCount = input.results.filter((result) => result.operationStatus === "planned").length;
  const skippedCount = input.results.filter((result) => result.operationStatus === "skipped").length;
  const incompleteCount = failedCount + errorCount + skippedCount;
  const hasUnknownRepositoryState = input.results.some((result) => result.outcome === "failed" && "repositoryState" in result);
  const repositoryState = input.repositoryState ?? (hasUnknownRepositoryState
    ? "unknown"
    : appliedCount > 0 && incompleteCount > 0
      ? "partially_changed"
      : appliedCount > 0
        ? "changed"
        : "unchanged");
  const batchOutcome = input.batchOutcome ?? (appliedCount > 0 && incompleteCount > 0
    ? "partial"
    : errorCount > 0
      ? "failed"
      : failedCount > 0
        ? "rejected"
        : input.dryRun
          ? "planned"
          : "succeeded");
  const result: ProjectEditBatchResult = {
    projectAlias: input.projectAlias,
    batchMode: input.batchMode,
    batchOutcome,
    repositoryState,
    dryRun: input.dryRun,
    requestedCount: input.results.length,
    successCount,
    failedCount,
    errorCount,
    appliedCount,
    noChangeCount,
    plannedCount,
    skippedCount,
    ...(input.batchError === undefined ? {} : { batchError: input.batchError }),
    results: input.results
  };
  return auditProjectEditBatchResult(result);
}

function executeStagedProjectEditBatch(input: {
  projectAlias: string;
  operations: EditOperation[];
  dryRun: boolean;
  policy: PortusPolicyConfig;
}): ProjectEditBatchResult {
  const projections = new Map<string, PathProjection>();
  const blockedRelativePaths = new Set<string>();
  const evaluations: StagedEvaluation[] = [];

  for (const [index, operation] of input.operations.entries()) {
    if (
      operation.type !== "write"
      && operation.type !== "replace"
      && operation.type !== "insert"
      && operation.type !== "replace_range"
    ) {
      evaluations.push({
        index,
        operation: operation as never,
        result: rejected(
          operationIdentity(index, operation),
          new SemanticRejection("unsupported_batch_mode", { batchMode: "staged" })
        )
      });
      continue;
    }

    const relativeKey = path.normalize(operation.relativePath);
    const blockedKey = process.platform === "win32" ? relativeKey.toLowerCase() : relativeKey;
    if (blockedRelativePaths.has(blockedKey)) {
      evaluations.push({ index, operation, result: skipped(index, operation) });
      continue;
    }

    let projection: PathProjection | undefined;
    let projectedContentBefore: Buffer | null | undefined;
    let projectedIsTextBefore: boolean | undefined;
    try {
      projection = captureStagedProjection(input.projectAlias, operation.relativePath, projections, input.policy);
      projectedContentBefore = projection.projectedContent;
      projectedIsTextBefore = projection.projectedIsText;
      evaluations.push(evaluateStagedOperation(index, operation, projection, input.dryRun, input.policy));
    } catch (error) {
      const result = error instanceof SemanticRejection
        ? rejected(operationIdentity(index, operation), error)
        : failed(operationIdentity(index, operation), error, operation.relativePath, false);
      if (projection && projectedContentBefore !== undefined) {
        projection.projectedContent = projectedContentBefore;
        projection.projectedIsText = projectedIsTextBefore;
      } else {
        blockedRelativePaths.add(blockedKey);
      }
      evaluations.push({ index, operation, projection, result });
    }
  }

  const planningFailed = evaluations.some((evaluation) => evaluation.result?.outcome === "failed");
  const planningRejected = evaluations.some((evaluation) =>
    evaluation.result?.outcome === "completed" && !evaluation.result.ok
  );
  if (input.dryRun) {
    for (const evaluation of evaluations) {
      if (evaluation.change) {
        evaluation.result = planned(operationIdentity(evaluation.index, evaluation.operation), evaluation.change.plannedDetails);
      }
    }
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: true,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState: "unchanged",
      batchOutcome: planningFailed ? "failed" : planningRejected ? "rejected" : "planned"
    });
  }

  if (planningFailed || planningRejected) {
    for (const evaluation of evaluations) {
      if (evaluation.change) {
        evaluation.result = skipped(
          evaluation.index,
          evaluation.operation,
          planningFailed ? "batch_failed" : "batch_rejected"
        );
      }
    }
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: false,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState: "unchanged",
      batchOutcome: planningFailed ? "failed" : "rejected"
    });
  }

  const changedProjections = [...projections.values()]
    .filter((projection) => projection.projectedContent !== null && (
      !projection.baseExists || !projection.baseContent?.equals(projection.projectedContent)
    ))
    .sort((left, right) => left.firstTouchOrder - right.firstTouchOrder);
  const changedProjectionKeys = new Set(changedProjections.map((projection) => projection.key));
  for (const evaluation of evaluations) {
    if (evaluation.change && evaluation.projection && !changedProjectionKeys.has(evaluation.projection.key)) {
      evaluation.result = noChange(operationIdentity(evaluation.index, evaluation.operation), evaluation.change.canceledDetails);
    }
  }

  if (changedProjections.length === 0) {
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: false,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState: "unchanged",
      batchOutcome: "succeeded"
    });
  }

  try {
    stateStore.requireAuditWritable();
  } catch (error) {
    for (const evaluation of evaluations) {
      if (evaluation.change && !evaluation.result) {
        evaluation.result = skipped(evaluation.index, evaluation.operation, "batch_failed");
      }
    }
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: false,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState: "unchanged",
      batchOutcome: "failed",
      batchError: safeError(error)
    });
  }

  const staleProjectionKeys = new Set<string>();
  try {
    for (const projection of projections.values()) {
      const target = resolveProjectPath(input.projectAlias, projection.relativePath);
      if (canonicalProjectionKey(target) !== projection.key || existsSync(target) !== projection.baseExists) {
        staleProjectionKeys.add(projection.key);
        continue;
      }
      if (!projection.baseExists) continue;
      assertCanReadProjectPath(input.projectAlias, target, projection.relativePath, undefined, input.policy);
      if (!statSync(target).isFile() || hashSha256(readFileSync(target)) !== projection.baseSha256) {
        staleProjectionKeys.add(projection.key);
      }
    }
  } catch (error) {
    for (const evaluation of evaluations) {
      if (evaluation.change && !evaluation.result) {
        evaluation.result = skipped(evaluation.index, evaluation.operation, "batch_failed");
      }
    }
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: false,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState: "unchanged",
      batchOutcome: "failed",
      batchError: safeError(error)
    });
  }

  if (staleProjectionKeys.size > 0) {
    for (const evaluation of evaluations) {
      if (evaluation.projection && staleProjectionKeys.has(evaluation.projection.key)) {
        evaluation.result = rejected(operationIdentity(evaluation.index, evaluation.operation), new SemanticRejection("stale_file", {}));
      } else if (evaluation.change && !evaluation.result) {
        evaluation.result = skipped(evaluation.index, evaluation.operation, "batch_rejected");
      }
    }
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: false,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState: "unchanged",
      batchOutcome: "rejected"
    });
  }

  const committedProjectionKeys = new Set<string>();
  const createdDirectories = new Set<string>();
  let commitError: unknown;
  let failedProjection: PathProjection | undefined;
  for (const projection of changedProjections) {
    const missingParents: string[] = [];
    let currentParent = path.dirname(projection.target);
    while (!existsSync(currentParent)) {
      missingParents.push(currentParent);
      const parent = path.dirname(currentParent);
      if (parent === currentParent) break;
      currentParent = parent;
    }
    try {
      mkdirSync(path.dirname(projection.target), { recursive: true });
      const target = resolveProjectPath(input.projectAlias, projection.relativePath);
      if (canonicalProjectionKey(target) !== projection.key) throw new Error(`Target changed before commit: ${projection.relativePath}`);
      writeFileSync(target, projection.projectedContent!);
      committedProjectionKeys.add(projection.key);
    } catch (error) {
      commitError = error;
      failedProjection = projection;
    } finally {
      for (const createdDirectory of missingParents) {
        if (existsSync(createdDirectory) && lstatSync(createdDirectory).isDirectory()) {
          createdDirectories.add(createdDirectory);
        }
      }
    }
    if (commitError) break;
  }

  if (commitError) {
    for (const evaluation of evaluations) {
      if (!evaluation.change || evaluation.result) continue;
      evaluation.result = evaluation.projection && committedProjectionKeys.has(evaluation.projection.key)
        ? applied(operationIdentity(evaluation.index, evaluation.operation), evaluation.change.appliedDetails)
        : skipped(evaluation.index, evaluation.operation, "batch_failed");
    }

    let inspectionUnknown = false;
    let mutationObserved = createdDirectories.size > 0 || committedProjectionKeys.size > 0;
    for (const projection of changedProjections) {
      try {
        const target = resolveProjectPath(input.projectAlias, projection.relativePath);
        const exists = existsSync(target);
        if (projection.baseExists) {
          if (!exists || !statSync(target).isFile()) mutationObserved = true;
          else if (!readFileSync(target).equals(projection.baseContent!)) mutationObserved = true;
        } else if (exists) {
          mutationObserved = true;
        }
      } catch {
        inspectionUnknown = true;
      }
    }
    const repositoryState = mutationObserved ? "partially_changed" : inspectionUnknown ? "unknown" : "unchanged";
    const batchError = safeError(commitError, failedProjection?.relativePath);
    return summarizeProjectEditBatch({
      projectAlias: input.projectAlias,
      batchMode: "staged",
      dryRun: false,
      results: evaluations.map((evaluation) => evaluation.result!),
      repositoryState,
      batchOutcome: committedProjectionKeys.size > 0 ? "partial" : "failed",
      batchError
    });
  }

  for (const evaluation of evaluations) {
    if (evaluation.change && !evaluation.result) {
      evaluation.result = applied(operationIdentity(evaluation.index, evaluation.operation), evaluation.change.appliedDetails);
    }
  }
  return summarizeProjectEditBatch({
    projectAlias: input.projectAlias,
    batchMode: "staged",
    dryRun: false,
    results: evaluations.map((evaluation) => evaluation.result!),
    repositoryState: "changed",
    batchOutcome: "succeeded"
  });
}


export type ProjectEditBatchResult = {
  projectAlias: string;
  batchMode: EditBatchMode;
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
  batchError?: string;
  results: OperationResult[];
};

function executeOrderedProjectEditBatch(input: {
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
  return summarizeProjectEditBatch({
    projectAlias: input.projectAlias,
    batchMode: "ordered",
    dryRun: input.dryRun,
    results
  });
}

export function executeProjectEditBatch(input: {
  projectAlias: string;
  operations: EditOperation[];
  batchMode: EditBatchMode;
  dryRun: boolean;
  continueOnFailure: boolean;
  policy: PortusPolicyConfig;
}): ProjectEditBatchResult {
  if (input.batchMode === "staged") {
    if (input.continueOnFailure) {
      throw new Error("continueOnFailure is only valid when batchMode is ordered");
    }
    return executeStagedProjectEditBatch(input);
  }
  return executeOrderedProjectEditBatch(input);
}
