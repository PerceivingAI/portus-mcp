import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { getProject, listProjects } from "../state/ProjectRegistry.js";
import { stateStore } from "../state/StateStore.js";
import { resolveProjectPath, resolveReadablePath } from "../policy/pathPolicy.js";
import { assertMainAgentCommandAllowed, assertMainAgentPermission } from "../policy/permissionPolicy.js";
import { loadPolicyConfig, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { countChars, limitText } from "../runtime/outputLimits.js";
import { runProjectCheck, runProjectScript } from "../runtime/checks.js";
import { runProjectCommand } from "../runtime/commands.js";
import type { ScreenshotCapabilities } from "../runtime/screenshotSystem.js";
import {
  startExecutionSession,
  pollExecutionSession,
  writeExecutionSession,
  terminateExecutionSession,
  listExecutionSessions
} from "../runtime/executionSessions.js";
import { registerStrictProjectTool, safeError, safeRelativePath } from "./projectToolUtils.js";
import { screenshotCapabilityEntry } from "./projectScreenshot.js";
import { editBatchModeSchema, editOperationSchema, executeProjectEditBatch, type ProjectEditBatchResult } from "./projectEdit.js";
import { patchInputSchema, synthesizeUnifiedDiff } from "./patchSynthesizer.js";
import type { SkillRegistrySnapshot } from "../skills/SkillRegistry.js";
import {
  assertCanReadProjectPath,
  assertCanStatProjectPath,
  assertProjectCommandStaysInProject,
  collectPaths,
  collectSearchableFiles,
  commandRequiresConfirmation,
  hashSha256,
  isTextLikely,
  isProjectPathGitIgnored,
  parsePatchPaths,
  readProjectBinaryFile,
  readProjectTextFile,
  readProjectTextFileRange,
  scoreFileSearchPath,
  TraversalError,
  type TraversalResult,
  tokenizeFileSearchQuery
} from "./projects.js";

const execFileAsync = promisify(execFile);
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutateAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

type EnabledToolCapability = {
  enabled: true;
  allowedCommands?: string[];
};

type ScreenshotToolCapability = Omit<ScreenshotCapabilities, "enabled"> & {
  enabled: true;
};

type ProjectToolCapability = EnabledToolCapability | ScreenshotToolCapability;

type EnabledFeature = {
  enabled: true;
};

type ProjectContextCapabilities = {
  complete: true;
  availableTools: Record<string, ProjectToolCapability>;
  features: Record<string, EnabledFeature>;
};

function projectContextCapabilities(policy: PortusPolicyConfig): ProjectContextCapabilities {
  const permissions = policyPermissions(policy).main_agent;
  const availableTools: Record<string, ProjectToolCapability> = {};
  if (permissions.projectContext) availableTools.project_context = { enabled: true };
  if (permissions.projectRead) availableTools.project_read = { enabled: true };
  if (permissions.projectSearch) availableTools.project_search = { enabled: true };
  if (permissions.projectEdit) availableTools.project_edit = { enabled: true };
  if (permissions.projectPatch) availableTools.project_patch = { enabled: true };
  if (permissions.projectRun) {
    availableTools.project_run = {
      enabled: true,
      allowedCommands: [...permissions.allowedCommands]
    };
  }
  if (permissions.projectPolicy) availableTools.project_policy = { enabled: true };
  if (permissions.subagentTask) availableTools.subagent_task = { enabled: true };
  if (permissions.subagentContext) availableTools.subagent_context = { enabled: true };

  const screenshotEntry = screenshotCapabilityEntry(policy);
  if (screenshotEntry) {
    availableTools.project_screenshot = { ...screenshotEntry, enabled: true };
  }

  const features: Record<string, EnabledFeature> = {};
  if (permissions.projectRun && permissions.allowShell) features.shell = { enabled: true };
  if (permissions.readGitIgnoredFiles) features.readGitIgnoredFiles = { enabled: true };
  if (permissions.statGitIgnoredFiles) features.statGitIgnoredFiles = { enabled: true };
  if (
    permissions.requireConfirmation
    && (permissions.projectEdit || permissions.projectPatch || permissions.projectRun)
  ) {
    features.protectedOperationsRequireConfirmation = { enabled: true };
  }

  return {
    complete: true,
    availableTools,
    features
  };
}

function assertInputChars(name: string, value: string, limit: number): void {
  const chars = countChars(value);
  if (chars > limit) throw new Error(`Input exceeds ${name}: ${chars} > ${limit} chars`);
}


function pathMetadata(projectAlias: string, relativePath: string, includeHash: boolean, registry?: SkillRegistrySnapshot): Record<string, unknown> {
  const target = registry
    ? resolveReadablePath(projectAlias, relativePath, registry)
    : resolveProjectPath(projectAlias, relativePath);
  assertCanStatProjectPath(projectAlias, target, relativePath, registry);
  if (!existsSync(target)) return { relativePath, exists: false };
  const info = statSync(target);
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  const contentReadable = registry?.connected.byAlias.has(projectAlias)
    || !isProjectPathGitIgnored(projectAlias, target)
    || policyPermissions().main_agent.readGitIgnoredFiles;
  return {
    relativePath,
    exists: true,
    kind,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    isTextLikely: kind === "file" ? isTextLikely(target) : false,
    contentReadable,
    ...(includeHash && kind === "file" && contentReadable ? { sha256: hashSha256(readFileSync(target)) } : {})
  };
}

function packageScripts(projectAlias: string): string[] {
  const pkg = resolveProjectPath(projectAlias, "package.json");
  assertCanReadProjectPath(projectAlias, pkg, "package.json");
  const limited = limitText(readFileSync(pkg, "utf8"), loadPolicyConfig().limits.fileRead.maxChars);
  if (limited.truncated) throw new Error("Unable to inspect package scripts: package.json exceeds the configured read limit");
  const parsed: unknown = JSON.parse(limited.text);
  if (!parsed || typeof parsed !== "object" || !("scripts" in parsed) || !parsed.scripts || typeof parsed.scripts !== "object") return [];
  return Object.keys(parsed.scripts).slice(0, 200);
}

async function treeSection(rootAlias: string, options: { relativePath?: string; maxDepth?: number; includeFiles?: boolean; includeDirs?: boolean; maxEntries?: number; format?: "tree" | "json" | "flat" }, registry: SkillRegistrySnapshot): Promise<Record<string, unknown>> {
  const relativePath = options.relativePath ?? ".";
  const maxDepth = Math.min(options.maxDepth ?? 4, 20);
  const maxEntries = Math.min(options.maxEntries ?? 500, 20000);
  const includeFiles = options.includeFiles ?? true;
  const includeDirs = options.includeDirs ?? true;
  const format = options.format ?? "tree";
  const base = resolveReadablePath(rootAlias, relativePath, registry);
  const depthFromBase = (entryRelativePath: string): number => {
    const target = resolveReadablePath(rootAlias, entryRelativePath, registry);
    const fromBase = path.relative(base, target).replace(/\\/g, "/");
    return fromBase === "." ? 0 : fromBase.split("/").length;
  };
  const traversal = await collectPaths(rootAlias, base, maxEntries, includeFiles, includeDirs, registry);
  const entries = traversal.entries.filter((entry) => depthFromBase(entry.relativePath) <= maxDepth);
  const truncated = traversal.stoppedAtCap || traversal.entries.length >= maxEntries;
  if (format === "flat" || format === "json") return { relativePath, format, entries, truncated, maxEntries, filesVisited: traversal.filesVisited, reasons: traversal.reasons };
  const output = [relativePath, ...entries.map((entry) => `${"  ".repeat(Math.max(0, depthFromBase(entry.relativePath) - 1))}${entry.kind === "directory" ? "[D] " : ""}${entry.relativePath}`)].join("\n");
  return { relativePath, format, output, truncated, maxEntries, filesVisited: traversal.filesVisited, reasons: traversal.reasons };
}

async function filesSection(rootAlias: string, options: { relativePath?: string; maxEntries?: number }, registry: SkillRegistrySnapshot): Promise<Record<string, unknown>> {
  const relativePath = options.relativePath ?? ".";
  const maxEntries = options.maxEntries ?? 200;
  const root = resolveReadablePath(rootAlias, relativePath, registry);
  const traversal = await collectPaths(rootAlias, root, maxEntries, true, false, registry);
  const files = traversal.entries.filter((entry) => entry.kind === "file");
  const truncated = traversal.stoppedAtCap || traversal.entries.length >= maxEntries;
  return { relativePath, files, truncated, maxEntries, filesVisited: traversal.filesVisited, reasons: traversal.reasons };
}

type SearchTraversalLookup = {
  traversal: Readonly<TraversalResult>;
  traversalReused: boolean;
};

type SearchTraversalProvider = (
  relativePath: string,
  includeGitIgnored: boolean
) => Promise<SearchTraversalLookup>;


function canonicalTraversalPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function searchTraversalKey(
  projectRoot: string,
  relativePath: string,
  includeGitIgnored: boolean,
  maxScanEntries: number,
  readGitIgnoredFiles: boolean,
  traversalPolicyKey: string
): string {
  return JSON.stringify([
    canonicalTraversalPath(projectRoot),
    canonicalTraversalPath(path.resolve(projectRoot, relativePath)),
    includeGitIgnored,
    maxScanEntries,
    readGitIgnoredFiles,
    traversalPolicyKey
  ]);
}
async function filesSearch(query: string, relativePath: string, maxResults: number, caseSensitive: boolean, includeGitIgnored: boolean, traversalProvider: SearchTraversalProvider, expect?: "present" | "absent"): Promise<Record<string, unknown>> {
  const tokens = tokenizeFileSearchQuery(query, caseSensitive);
  const { traversal, traversalReused } = await traversalProvider(relativePath, includeGitIgnored);
  const ranked = traversal.entries
    .map((item) => ({ item, ...scoreFileSearchPath(item.relativePath, query, tokens, caseSensitive) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.item.relativePath.localeCompare(right.item.relativePath));
  const matches = ranked.slice(0, maxResults).map(({ item, score, matchedTokens }) => ({ ...item, score, matchedTokens }));
  const matchesTruncated = ranked.length > maxResults;
  const scanComplete = !traversal.stoppedAtCap && traversal.reasons.length === 0;
  const expectKind = expect ?? "present";
  const expectationMet = expectKind === "present"
    ? matches.length > 0
    : matches.length > 0
      ? false
      : scanComplete ? true : null;
  return { matches, matchesTruncated, scan: { complete: scanComplete, reasons: traversal.reasons, filesVisited: traversal.filesVisited, directoriesVisited: traversal.directoriesVisited, gitProcessesSpawned: traversal.gitProcessesSpawned, traversalReused, elapsedMs: traversal.elapsedMs }, expectation: { kind: expectKind, met: expectationMet } };
}

const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const pattern = new RegExp(workerData.query, workerData.flags);
parentPort.on("message", ({ id, lines }) => {
  try {
    const indexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) indexes.push(index);
    }
    parentPort.postMessage({ id, indexes });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

type RegexWorkerResponse = { id: number; indexes?: number[]; error?: string };

class IsolatedRegexMatcher {
  private readonly worker: Worker;
  private nextId = 1;
  private remainingExecutionMs: number;
  private closed = false;

  constructor(query: string, flags: string, maxExecutionMs: number) {
    new RegExp(query, flags);
    this.worker = new Worker(REGEX_WORKER_SOURCE, { eval: true, workerData: { query, flags } });
    this.remainingExecutionMs = maxExecutionMs;
  }

  async matchingIndexes(lines: string[]): Promise<Set<number>> {
    if (this.closed) throw new Error("Regex worker is closed");
    if (this.remainingExecutionMs <= 0) throw new Error("regex_search_timeout");
    const id = this.nextId++;
    const startedAt = Date.now();
    try {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), this.remainingExecutionMs);
      this.worker.postMessage({ id, lines });
      let response: RegexWorkerResponse;
      try {
        response = await Promise.race([
          once(this.worker, "message", { signal: abortController.signal }).then(([message]) => message as RegexWorkerResponse),
          once(this.worker, "exit", { signal: abortController.signal }).then(([code]) => {
            throw new Error(`Regex worker exited before completing the search (code ${String(code)})`);
          })
        ]);
      } catch (error) {
        if (abortController.signal.aborted) {
          void this.close();
          throw new Error("regex_search_timeout");
        }
        throw error;
      } finally {
        clearTimeout(timer);
        abortController.abort();
      }
      if (response.id !== id) throw new Error("Regex worker returned an unexpected response");
      if (response.error) throw new Error(`Invalid regular expression: ${response.error}`);
      const indexes = response.indexes ?? [];
      return new Set(indexes);
    } finally {
      this.remainingExecutionMs = Math.max(0, this.remainingExecutionMs - (Date.now() - startedAt));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.worker.terminate();
  }
}

type SearchBatchBudget = {
  maxMatches: number;
  maxChars: number;
  currentMatches: number;
  currentChars: number;
};

async function textSearch(
  projectAlias: string,
  query: string,
  relativePath: string,
  maxResults: number,
  contextLines: number,
  caseSensitive: boolean,
  regex: boolean,
  symbols: boolean,
  includeGitIgnored: boolean,
  policy: PortusPolicyConfig,
  traversalProvider: SearchTraversalProvider,
  expect?: "present" | "absent",
  budget?: SearchBatchBudget
) {
  const limits = policy.limits.search;
  const matches: Array<Record<string, unknown>> = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const { traversal, traversalReused } = await traversalProvider(relativePath, includeGitIgnored);
  const scanReasons = [...traversal.reasons];
  let stoppedEarly = traversal.stoppedAtCap;
  let regexTimedOut = false;
  let shortCircuitedWitness = false;

  const matcher = regex ? new IsolatedRegexMatcher(query, caseSensitive ? "" : "i", limits.maxRegexExecutionMs) : null;
  try {
    for (const entry of traversal.entries) {
      if (matches.length >= maxResults) break;
      if (budget && (budget.currentMatches >= budget.maxMatches || budget.currentChars >= budget.maxChars)) {
        stoppedEarly = true;
        if (!scanReasons.includes("max_batch_matches") && budget.currentMatches >= budget.maxMatches) scanReasons.push("max_batch_matches");
        if (!scanReasons.includes("max_batch_output_chars") && budget.currentChars >= budget.maxChars) scanReasons.push("max_batch_output_chars");
        break;
      }
      const target = resolveProjectPath(projectAlias, entry.relativePath);
      if (!isTextLikely(target)) continue;
      let lines: string[];
      try {
        lines = limitText(readFileSync(target, "utf8"), limits.maxTextFileChars).text.split(/\r?\n/);
      } catch {
        if (!scanReasons.includes("read_error")) scanReasons.push("read_error");
        continue;
      }
      let regexIndexes: Set<number> | null = null;
      if (matcher) {
        try {
          regexIndexes = await matcher.matchingIndexes(lines);
        } catch (err) {
          if (err instanceof Error && err.message === "regex_search_timeout") {
            regexTimedOut = true;
            stoppedEarly = true;
            if (!scanReasons.includes("regex_timeout")) scanReasons.push("regex_timeout");
            break;
          }
          throw err;
        }
      }
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] ?? "";
        const candidate = caseSensitive ? text : text.toLowerCase();
        if (!(regexIndexes ? regexIndexes.has(index) : candidate.includes(needle))) continue;
        const matchObj = {
          relativePath: entry.relativePath,
          line: index + 1,
          text,
          ...(symbols ? {} : { before: lines.slice(Math.max(0, index - contextLines), index), after: lines.slice(index + 1, index + 1 + contextLines) })
        };
        const matchChars = countChars(JSON.stringify(matchObj));
        if (budget && (budget.currentMatches + 1 > budget.maxMatches || budget.currentChars + matchChars > budget.maxChars)) {
          stoppedEarly = true;
          if (!scanReasons.includes("max_batch_matches") && budget.currentMatches + 1 > budget.maxMatches) scanReasons.push("max_batch_matches");
          if (!scanReasons.includes("max_batch_output_chars") && budget.currentChars + matchChars > budget.maxChars) scanReasons.push("max_batch_output_chars");
          break;
        }
        matches.push(matchObj);
        if (budget) {
          budget.currentMatches += 1;
          budget.currentChars += matchChars;
        }
        if (expect === "absent") {
          shortCircuitedWitness = true;
          stoppedEarly = true;
          if (!scanReasons.includes("short_circuited_after_witness")) scanReasons.push("short_circuited_after_witness");
          break;
        }
        if (matches.length >= maxResults) break;
      }
      if (regexTimedOut || shortCircuitedWitness) break;
    }
  } finally {
    if (matcher) await matcher.close();
  }

  const scanComplete = !stoppedEarly && scanReasons.length === 0;
  const expectKind = expect ?? "present";
  const expectationMet = expectKind === "present"
    ? matches.length > 0
    : matches.length > 0
      ? false
      : scanComplete ? true : null;

  return {
    matches,
    matchesTruncated: matches.length >= maxResults,
    scan: { complete: scanComplete, reasons: scanReasons, filesVisited: traversal.filesVisited, directoriesVisited: traversal.directoriesVisited, gitProcessesSpawned: traversal.gitProcessesSpawned, traversalReused, elapsedMs: traversal.elapsedMs },
    expectation: { kind: expectKind, met: expectationMet }
  };
}

const expectedFileSchema = z.object({
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  exists: z.boolean().optional(),
  isFile: z.boolean().optional(),
  isDirectory: z.boolean().optional(),
  isTextLikely: z.boolean().optional()
}).strict();

export function registerProjectReadTool(server: McpServer, registry: SkillRegistrySnapshot, policy: PortusPolicyConfig = loadPolicyConfig()): void {
  registerStrictProjectTool(server, "project_read", "Read files from a registered project or available skill. Pass a registered project alias or a skill rootAlias returned by project_context and batch up to 50 requests.\n\nModes:\n- content: Read text content. Optionally pass startLine and endLine for a line range.\n- binary: Read binary file data.\n- metadata: Read file metadata.\n- exists: Check whether a path exists.\n\nText reads return the complete file hash, including bounded and truncated reads.", {
    projectAlias: z.string().min(1),
    requests: z.array(z.object({ relativePath: z.string().min(1), mode: z.enum(["content", "binary", "metadata", "exists"]).default("content"), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict().superRefine((request, context) => { if (request.mode !== "content" && (request.startLine !== undefined || request.endLine !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Line ranges are only valid for content mode" }); })).min(1).max(50)
  }, readAnnotations, async ({ projectAlias, requests }) => {
    assertMainAgentPermission("projectRead", policy);
    const results: Array<Record<string, unknown>> = [];
    for (const [index, request] of requests.entries()) {
      try {
        const value = request.mode === "metadata"
          ? pathMetadata(projectAlias, request.relativePath, false, registry)
          : request.mode === "exists"
            ? (() => {
                const target = resolveReadablePath(projectAlias, request.relativePath, registry);
                assertCanStatProjectPath(projectAlias, target, request.relativePath, registry);
                return { relativePath: request.relativePath, exists: existsSync(target) };
              })()
            : request.mode === "binary"
              ? await readProjectBinaryFile({ projectAlias, relativePath: request.relativePath }, registry)
              : request.startLine !== undefined || request.endLine !== undefined
                ? await readProjectTextFileRange({ projectAlias, relativePath: request.relativePath, startLine: request.startLine, endLine: request.endLine }, registry)
                : await readProjectTextFile({ projectAlias, relativePath: request.relativePath }, registry);
        results.push({ ok: true, index, mode: request.mode, ...value });
      } catch (error) { results.push({ ok: false, index, mode: request.mode, relativePath: safeRelativePath(request.relativePath), error: safeError(error, request.relativePath) }); }
    }
    return { projectAlias, requestedCount: requests.length, successCount: results.filter((result) => result.ok).length, errorCount: results.filter((result) => !result.ok).length, results };
  });
}

function verifyProjectEditResult(projectAlias: string, result: ProjectEditBatchResult, policy: PortusPolicyConfig): Record<string, unknown> {
  if (result.dryRun) return { omittedReason: "dry_run" };
  const paths = new Set(
    result.results
      .filter((item) => item.operationStatus === "applied" || item.operationStatus === "no_change")
      .filter((item) => item.type === "write" || item.type === "replace" || item.type === "insert" || item.type === "replace_range")
      .map((item) => item.relativePath)
      .filter((relativePath): relativePath is string => typeof relativePath === "string")
  );
  const files: Array<Record<string, unknown>> = [];
  for (const relativePath of paths) {
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    if (!existsSync(target)) {
      files.push({ relativePath: safeRelativePath(relativePath), omittedReason: "file_not_found" });
      continue;
    }
    if (!isTextLikely(target)) {
      files.push({ relativePath: safeRelativePath(relativePath), omittedReason: "binary_file" });
      continue;
    }
    const raw = readFileSync(target, "utf8");
    const lines = raw === "" ? [] : raw.split(/\r\n|\n|\r/);
    if (lines.at(-1) === "") lines.pop();
    const limited = limitText(raw, Math.min(policy.limits.textEdit.maxOperationChars, 16384));
    files.push({
      relativePath: safeRelativePath(relativePath),
      resultingRange: lines.length === 0 ? null : { startLine: 1, endLine: lines.length },
      content: limited.text,
      truncated: limited.truncated
    });
  }
  return { files };
}

export function registerBroadProjectTools(server: McpServer, registry: SkillRegistrySnapshot, policy: PortusPolicyConfig = loadPolicyConfig()): void {
  registerProjectReadTool(server, registry, policy);

  const treeSchema = z.object({ relativePath: z.string().min(1).optional(), maxDepth: z.number().int().positive().max(20).optional(), includeFiles: z.boolean().optional(), includeDirs: z.boolean().optional(), maxEntries: z.number().int().positive().max(20000).optional(), format: z.enum(["tree", "json", "flat"]).optional() }).strict();
  registerStrictProjectTool(server, "project_context", "Discover projects and skills, or inspect a selected project or skill.\n\nSections:\n- projects: List registered project aliases. No projectAlias is required.\n- skills: List available skills and their rootAlias values. No projectAlias is required.\n- status: Read status for a registered project.\n- capabilities: Read the complete availableTools list for a registered project. Do not invoke tools absent from this list.\n- tree: Return a bounded directory tree for a project or skill rootAlias.\n- files: List files under a project or skill rootAlias.\n- paths: Read metadata for selected project or skill paths.\n- scripts: List package scripts for a registered project.", {
    projectAlias: z.string().min(1).optional().describe("Registered project alias, or a skill rootAlias returned by include.skills for tree, files, and paths."), include: z.object({ projects: z.boolean().optional(), skills: z.boolean().optional(), status: z.boolean().optional(), capabilities: z.boolean().optional(), tree: treeSchema.optional(), files: z.object({ relativePath: z.string().min(1).optional(), maxEntries: z.number().int().positive().max(10000).optional() }).strict().optional(), paths: z.array(z.object({ relativePath: z.string().min(1), includeHash: z.boolean().optional() }).strict()).max(100).optional(), scripts: z.boolean().optional() }).strict().optional()
  }, readAnnotations, async ({ projectAlias, include }) => {
    const requested = include ?? { status: true, capabilities: true, tree: { maxDepth: 2, maxEntries: 200 }, scripts: true };
    const hasScopedRequest = requested.status === true || requested.capabilities === true || requested.tree !== undefined || requested.files !== undefined || requested.paths !== undefined || requested.scripts === true;
    const hasDiscoveryRequest = requested.projects === true || requested.skills === true;
    const isSkillRoot = projectAlias !== undefined && registry.connected.byAlias.has(projectAlias);
    if (hasScopedRequest && !projectAlias) throw new Error("projectAlias is required for project-scoped context sections");
    if (!hasScopedRequest && !hasDiscoveryRequest) throw new Error("Request at least one context section");
    if (isSkillRoot && (requested.status === true || requested.capabilities === true || requested.scripts === true)) {
      throw new Error("Skill rootAlias supports only tree, files, and paths context sections.");
    }
    if (hasDiscoveryRequest) assertMainAgentPermission("projectContext", policy);
    if (hasScopedRequest) assertMainAgentPermission("projectContext", policy);
    const sections: Record<string, unknown> = {};
    const isolate = async (name: string, action: () => unknown | Promise<unknown>) => {
      try {
        sections[name] = { ok: true, value: await action() };
      } catch (error) {
        sections[name] = { ok: false, error: safeError(error) };
      }
    };
    if (requested.projects) await isolate("projects", () => ({ projectAliases: listProjects().map((project) => project.projectAlias) }));
    if (requested.skills) await isolate("skills", () => ({
      skills: registry.connected.catalog.map(({ name, description, rootAlias, entrypoint }) => ({ name, description, rootAlias, entrypoint }))
    }));
    if (requested.status) await isolate("status", () => {
      const project = getProject(projectAlias!);
      return {
        project: {
          projectAlias: project.projectAlias,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt
        }
      };
    });
    if (requested.capabilities) await isolate("capabilities", () => projectContextCapabilities(policy));
    if (requested.tree) await isolate("tree", () => treeSection(projectAlias!, requested.tree ?? {}, registry));
    if (requested.files) await isolate("files", () => filesSection(projectAlias!, requested.files ?? {}, registry));
    if (requested.paths) await isolate("paths", () => requested.paths?.map((item) => { try { return { ok: true, ...pathMetadata(projectAlias!, item.relativePath, item.includeHash ?? false, registry) }; } catch (error) { return { ok: false, relativePath: safeRelativePath(item.relativePath), error: safeError(error, item.relativePath) }; } }) ?? []);
    if (requested.scripts) await isolate("scripts", () => ({ scripts: packageScripts(projectAlias!) }));
    return { projectAlias: projectAlias ?? null, sections };
  });

  const searchRequestSchema = z.object({
    mode: z.enum(["files", "text", "symbols", "all"]),
    query: z.string().min(1),
    relativePath: z.string().min(1).default(".").describe("Project-relative regular file or directory to search"),
    includeGitIgnored: z.boolean().default(false),
    regex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    contextLines: z.number().int().min(0).max(30).default(0),
    maxResults: z.number().int().positive().max(20000).default(100),
    expect: z.enum(["present", "absent"]).optional()
  }).strict();

  registerStrictProjectTool(server, "project_search", "Search a registered project. Batch up to 20 search requests.\n\nModes:\n- files: Search file paths.\n- text: Search file contents.\n- symbols: Search symbol-like text.\n- all: Run file, text, and symbol search together.\n\nEach request can set its relative path, case sensitivity, regex behavior, context lines, expected presence, and result limit.", {
    projectAlias: z.string().min(1),
    requests: z.array(searchRequestSchema).min(1).max(20)
  }, readAnnotations, async ({ projectAlias, requests }) => {
    assertMainAgentPermission("projectSearch", policy);

    const searchLimits = policy.limits.search;
    const traversalExcludedPatterns = Object.freeze([...loadConfig().traversal.excludedPatterns]);
    const traversalPolicyKey = JSON.stringify(traversalExcludedPatterns);
    const projectRoot = getProject(projectAlias).rootPath;
    const readGitIgnoredFiles = policyPermissions(policy).main_agent.readGitIgnoredFiles;
    const traversalCache = new Map<string, Promise<Readonly<TraversalResult>>>();
    let traversalsStarted = 0;
    let traversalsReused = 0;
    let gitProcessesSpawned = 0;

    const traversalProvider: SearchTraversalProvider = async (relativePath, includeGitIgnored) => {
      const key = searchTraversalKey(
        projectRoot,
        relativePath,
        includeGitIgnored,
        searchLimits.maxScanEntries,
        readGitIgnoredFiles,
        traversalPolicyKey
      );
      const existing = traversalCache.get(key);
      if (existing) {
        traversalsReused += 1;
        return { traversal: await existing, traversalReused: true };
      }

      traversalsStarted += 1;
      const traversalPromise = collectSearchableFiles(
        projectAlias,
        relativePath,
        searchLimits.maxScanEntries,
        includeGitIgnored,
        policy,
        traversalExcludedPatterns
      ).then(
        (traversal) => {
          gitProcessesSpawned += traversal.gitProcessesSpawned;
          return traversal;
        },
        (error: unknown) => {
          if (error instanceof TraversalError) gitProcessesSpawned += error.gitProcessesSpawned;
          throw error;
        }
      );
      traversalCache.set(key, traversalPromise);
      return { traversal: await traversalPromise, traversalReused: false };
    };

    const budget: SearchBatchBudget = {
      maxMatches: searchLimits.maxBatchMatches,
      maxChars: searchLimits.maxBatchOutputChars,
      currentMatches: 0,
      currentChars: 0
    };

    const results: Array<Record<string, unknown>> = [];
    let matchesTruncated = false;

    for (const [index, req] of requests.entries()) {
      const boundedMax = Math.min(req.maxResults, searchLimits.maxScanEntries);
      const sections: Record<string, unknown> = {};

      const runSection = async (name: "files" | "text" | "symbols", action: () => Record<string, unknown> | Promise<Record<string, unknown>>) => {
        try {
          const res = await action();
          const exp = res.expectation;
          const expectationMet = req.expect !== undefined && exp && typeof exp === "object" && "met" in exp ? exp.met : undefined;
          const sectionOk = expectationMet === undefined ? true : expectationMet === true;
          sections[name] = { ok: sectionOk, outcome: "completed", ...res };
        } catch (error) {
          sections[name] = { ok: false, outcome: "failed", error: safeError(error, req.relativePath) };
        }
      };

      if (req.mode === "files" || req.mode === "all") {
        await runSection("files", () => filesSearch(req.query, req.relativePath, boundedMax, req.caseSensitive, req.includeGitIgnored, traversalProvider, req.expect));
      }
      if (req.mode === "text" || req.mode === "all") {
        await runSection("text", () => textSearch(projectAlias, req.query, req.relativePath, boundedMax, req.contextLines, req.caseSensitive, req.regex, false, req.includeGitIgnored, policy, traversalProvider, req.expect, budget));
      }
      if (req.mode === "symbols" || req.mode === "all") {
        await runSection("symbols", () => textSearch(projectAlias, req.query, req.relativePath, boundedMax, 0, req.caseSensitive, req.regex, true, req.includeGitIgnored, policy, traversalProvider, req.expect, budget));
      }

      const sectionEntries = Object.entries(sections) as Array<[string, Record<string, unknown>]>;
      const requestOk = sectionEntries.length > 0 && sectionEntries.every(([_, sec]) => sec.ok === true);
      const requestOutcome = sectionEntries.some(([_, sec]) => sec.outcome === "failed") ? "failed" : "completed";

      if (sectionEntries.some(([_, sec]) => sec.matchesTruncated === true)) {
        matchesTruncated = true;
      }

      results.push({
        ok: requestOk,
        outcome: requestOutcome,
        index,
        mode: req.mode,
        query: req.query,
        sections
      });
    }

    const successCount = results.filter((result) => result.ok).length;
    const failedCount = results.filter((result) => !result.ok && result.outcome === "completed").length;
    const errorCount = results.filter((result) => !result.ok && result.outcome === "failed").length;

    return {
      projectAlias,
      requestedCount: requests.length,
      successCount,
      failedCount,
      errorCount,
      matchesTruncated,
      gitProcessesSpawned,
      traversalsStarted,
      traversalsReused,
      results
    };
  });

  registerStrictProjectTool(server, "project_patch", "Prepare or apply a unified diff or structured patch inside a registered project.\n\nModes:\n- prepare: Inspect affected files and return current expectedFiles metadata for a later apply request.\n- apply: Validate and apply the patch. Pass expectedFiles from prepare for stale-file protection.\n\nOptions:\n- dryRun: Validate an apply request without changing files.\n- confirm: Confirm file deletion when required by policy.", {
    projectAlias: z.string().min(1), mode: z.enum(["prepare", "apply"]), patch: patchInputSchema, includeHash: z.boolean().optional(), expectedFiles: z.array(expectedFileSchema).optional(), dryRun: z.boolean().optional(), confirm: z.boolean().optional()
  }, mutateAnnotations, async ({ projectAlias, mode, patch, includeHash, expectedFiles, dryRun, confirm }) => {
    assertMainAgentPermission("projectPatch", policy);
    getProject(projectAlias);
    let unifiedDiff: string;
    let parsed: { files: string[]; deleted: Set<string> };
    if (typeof patch === "string") {
      assertInputChars("limits.patch.maxChars", patch, policy.limits.patch.maxChars);
      parsed = parsePatchPaths(patch);
      unifiedDiff = patch;
    } else {
      const synthesized = synthesizeUnifiedDiff(projectAlias, patch);
      unifiedDiff = synthesized.unifiedDiff;
      assertInputChars("limits.patch.maxChars", unifiedDiff, policy.limits.patch.maxChars);
      parsed = { files: synthesized.files, deleted: synthesized.deleted };
    }
    if (mode === "prepare") {
      if (expectedFiles !== undefined || dryRun !== undefined || confirm !== undefined) throw new Error("Apply-only fields are not valid in prepare mode");
      return { projectAlias, mode, changedFiles: parsed.files, deletedFiles: [...parsed.deleted], expectedFiles: parsed.files.map((relativePath) => pathMetadata(projectAlias, relativePath, includeHash ?? true)), readyForApply: true };
    }
    if (includeHash !== undefined) throw new Error("includeHash is only valid in prepare mode");
    const metadata = [...(expectedFiles ?? [])];
    const byPath = new Map(metadata.map((item) => [item.relativePath, item]));
    if (typeof patch !== "string") {
      const fileList = Array.isArray(patch) ? patch : patch.files;
      for (const f of fileList) {
        const normPath = path.posix.normalize(f.relativePath.replace(/\\/g, "/"));
        if (!byPath.has(normPath) && f.expectedSha256) {
          const hydrated = { relativePath: normPath, sha256: f.expectedSha256 };
          metadata.push(hydrated);
          byPath.set(normPath, hydrated);
        }
      }
    }
    const stalePatchResult = (reason: "stale_file" | "missing_expected_metadata", relativePath: string, details: Record<string, unknown> = {}) => ({
      projectAlias,
      mode,
      applied: false,
      dryRun: dryRun ?? false,
      changedFiles: parsed.files,
      deletedFiles: [...parsed.deleted],
      outcome: "completed" as const,
      operationStatus: "not_applied" as const,
      reason,
      relativePath,
      fileChanged: false,
      ...details
    });
    for (const file of parsed.files) {
      const target = resolveProjectPath(projectAlias, file);
      if (existsSync(target)) {
        assertCanReadProjectPath(projectAlias, target, file);
        if (!byPath.has(file)) return stalePatchResult("missing_expected_metadata", file);
      }
    }
    if (parsed.deleted.size > 0 && policyPermissions(policy).main_agent.requireConfirmation) {
      if (!confirm) throw new Error("Confirmation required: set confirm=true for file deletions");
    }
    for (const expected of metadata) {
      const target = resolveProjectPath(projectAlias, expected.relativePath);
      if (!existsSync(target)) continue;
      assertCanReadProjectPath(projectAlias, target, expected.relativePath);
      const info = statSync(target);
      const expectedSize = expected.sizeBytes ?? expected.bytes;
      if (expectedSize !== undefined && expectedSize !== info.size) {
        return stalePatchResult("stale_file", expected.relativePath, { expectedBytes: expectedSize, actualBytes: info.size });
      }
      const actualModifiedAt = info.mtime.toISOString();
      if (expected.modifiedAt && expected.modifiedAt !== actualModifiedAt) {
        return stalePatchResult("stale_file", expected.relativePath, { expectedModifiedAt: expected.modifiedAt, actualModifiedAt });
      }
      if (expected.sha256) {
        const actualSha256 = hashSha256(readFileSync(target));
        if (actualSha256 !== expected.sha256.toLowerCase()) {
          return stalePatchResult("stale_file", expected.relativePath, {
            expectedSha256: expected.sha256.toLowerCase(),
            actualSha256
          });
        }
      }
    }
    const patchPath = path.join(os.tmpdir(), `portus-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
    writeFileSync(patchPath, unifiedDiff, "utf8");
    try {
      for (const file of parsed.files) resolveProjectPath(projectAlias, file);
      const projectRoot = resolveProjectPath(projectAlias, ".");
      await execFileAsync("git", ["apply", "--check", patchPath], { cwd: projectRoot });
      if (!dryRun) {
        stateStore.requireAuditWritable();
        for (const file of parsed.files) resolveProjectPath(projectAlias, file);
        await execFileAsync("git", ["apply", patchPath], { cwd: resolveProjectPath(projectAlias, ".") });
      }
      stateStore.audit({ tool: "project_patch", projectAlias, mode, dryRun: dryRun ?? false, files: parsed.files, deletedFiles: [...parsed.deleted] });
      return { projectAlias, mode, applied: !dryRun, dryRun: dryRun ?? false, changedFiles: parsed.files, deletedFiles: [...parsed.deleted] };
    } catch (error) {
      return { projectAlias, mode, applied: false, dryRun: dryRun ?? false, changedFiles: parsed.files, deletedFiles: [...parsed.deleted], error: safeError(error) };
    } finally {
      if (existsSync(patchPath)) unlinkSync(patchPath);
    }
  });

  const runRequestSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("check"),
      name: z.string().min(1).max(256).optional(),
      timeoutSecs: z.number().int().positive().max(3600).optional(),
      expectedExitCodes: z.array(z.number().int().min(0).max(255)).optional().describe("Allowed exit codes for successful completion, e.g. [0, 1]")
    }).strict(),
    z.object({
      type: z.literal("script"),
      name: z.string().min(1).max(256),
      args: z.array(z.string().max(4096)).max(500).optional(),
      timeoutSecs: z.number().int().positive().max(3600).optional(),
      expectedExitCodes: z.array(z.number().int().min(0).max(255)).optional().describe("Allowed exit codes for successful completion, e.g. [0, 1]")
    }).strict(),
    z.object({
      type: z.literal("command"),
      command: z.string().min(1).max(256),
      args: z.array(z.string().max(4096)).max(500).optional(),
      timeoutSecs: z.number().int().positive().max(3600).optional(),
      confirm: z.boolean().optional(),
      expectedExitCodes: z.array(z.number().int().min(0).max(255)).optional().describe("Allowed exit codes for successful completion, e.g. [0, 1]")
    }).strict()
  ]);

  type RunRequest = z.infer<typeof runRequestSchema>;

  function resolveExpectedExitCodes(req: RunRequest): number[] {
    if (req.expectedExitCodes && req.expectedExitCodes.length > 0) {
      return req.expectedExitCodes;
    }
    if (req.type === "command") {
      const base = req.command.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
      const sub = req.args?.[0]?.toLowerCase();
      if (base === "git" && (sub === "grep" || sub === "diff")) {
        return [0, 1];
      }
    }
    return [0];
  }
  const sessionActionSchema = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("start"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      timeoutSecs: z.number().int().positive().max(3600).optional(),
      confirm: z.boolean().optional()
    }).strict(),
    z.object({
      type: z.literal("poll"),
      sessionId: z.string().min(1),
      cursor: z.number().int().nonnegative().optional(),
      maxChars: z.number().int().positive().max(65536).optional(),
      stream: z.enum(["stdout", "stderr", "both"]).optional()
    }).strict(),
    z.object({
      type: z.literal("write"),
      sessionId: z.string().min(1),
      input: z.string().max(65536)
    }).strict(),
    z.object({
      type: z.literal("terminate"),
      sessionId: z.string().min(1)
    }).strict(),
    z.object({
      type: z.literal("list")
    }).strict()
  ]);

  registerStrictProjectTool(server, "project_run", "Run project checks, package scripts, permitted commands, or observable execution sessions.\n\nRequest types:\n- check: Run a configured project check.\n- script: Run a package script with optional arguments.\n- command: Run a permitted command with an argument array.\n\nSession actions:\n- start: Start a long-running observable process.\n- poll: Read incremental output and current session state.\n- write: Write bounded input to a running session's stdin.\n- terminate: Stop the session and its process tree.\n- list: List execution sessions for the project.\n\nUse batched requests for work that should finish during the call. Use session actions for processes that must remain observable across calls.", {
    projectAlias: z.string().min(1),
    batchTimeoutSecs: z.number().int().positive().max(3600).optional(),
    stopOnFailure: z.boolean().default(false),
    requests: z.array(runRequestSchema).min(1).max(10).optional(),
    sessionAction: sessionActionSchema.optional()
  }, mutateAnnotations, async ({ projectAlias, batchTimeoutSecs, stopOnFailure, requests, sessionAction }) => {
    assertMainAgentPermission("projectRun", policy);

    if (!requests && !sessionAction) {
      throw new Error("project_run requires either 'requests' array or 'sessionAction' object");
    }
    if (requests && sessionAction) {
      throw new Error("project_run cannot accept both 'requests' and 'sessionAction' in the same call");
    }

    const permissions = policyPermissions(policy).main_agent;
    const projectRoot = resolveProjectPath(projectAlias, ".");

    if (sessionAction) {
      stateStore.requireAuditWritable();
      if (sessionAction.type === "start") {
        assertMainAgentCommandAllowed(sessionAction.command, policy);
        assertProjectCommandStaysInProject(sessionAction.command, sessionAction.args ?? []);
        const requiresConfirmation = permissions.requireConfirmation && commandRequiresConfirmation(sessionAction.command, sessionAction.args ?? []);
        if (requiresConfirmation && !sessionAction.confirm) {
          throw new Error("Confirmation required: set confirm=true");
        }
        const session = await startExecutionSession({
          projectAlias,
          rootPath: projectRoot,
          command: sessionAction.command,
          args: sessionAction.args,
          timeoutSecs: sessionAction.timeoutSecs,
          policy
        });
        return {
          projectAlias,
          sessionAction: "start",
          session
        };
      } else if (sessionAction.type === "poll") {
        const pollResult = pollExecutionSession({
          sessionId: sessionAction.sessionId,
          cursor: sessionAction.cursor,
          maxChars: sessionAction.maxChars,
          stream: sessionAction.stream
        });
        // pollExecutionSession returns the authoritative record alias; do not
        // duplicate projectAlias here or the spread would silently overwrite it.
        return {
          sessionAction: "poll",
          ...pollResult
        };
      } else if (sessionAction.type === "write") {
        const result = writeExecutionSession(sessionAction.sessionId, sessionAction.input);
        return {
          sessionAction: "write",
          ...result
        };
      } else if (sessionAction.type === "terminate") {
        const session = await terminateExecutionSession(sessionAction.sessionId);
        return {
          projectAlias,
          sessionAction: "terminate",
          session
        };
      } else {
        const sessions = listExecutionSessions(projectAlias);
        return {
          projectAlias,
          sessionAction: "list",
          sessions
        };
      }
    }

    const batchRequests = requests!;
    for (const req of batchRequests) {
      if (req.type === "check") {
        assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json");
      } else if (req.type === "script") {
        assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json");
      } else if (req.type === "command") {
        assertMainAgentCommandAllowed(req.command, policy);
        assertProjectCommandStaysInProject(req.command, req.args ?? []);
        const requiresConfirmation = permissions.requireConfirmation && commandRequiresConfirmation(req.command, req.args ?? []);
        if (requiresConfirmation && !req.confirm) {
          throw new Error("Confirmation required: set confirm=true");
        }
      }
    }

    stateStore.requireAuditWritable();

    const maxBatchOutputChars = policy.limits.process.maxBatchOutputChars;
    const effectiveBatchTimeoutMs = Math.min(batchTimeoutSecs ?? 120, 3600) * 1000;
    const deadlineAt = Date.now() + effectiveBatchTimeoutMs;
    let accumulatedOutputChars = 0;
    let batchOutputTruncated = false;
    let batchTimedOut = false;
    let executedCount = 0;
    let skippedCount = 0;

    const results: Array<Record<string, unknown>> = [];

    for (const [index, req] of batchRequests.entries()) {
      const now = Date.now();
      const remainingMs = deadlineAt - now;

      if (remainingMs <= 0) {
        batchTimedOut = true;
        skippedCount++;
        results.push({
          ok: false,
          index,
          type: req.type,
          ...(req.type === "check" ? { name: req.name ?? "check" } : {}),
          ...(req.type === "script" ? { name: req.name, args: req.args ?? [] } : {}),
          ...(req.type === "command" ? { command: req.command, args: req.args ?? [] } : {}),
          status: "skipped",
          reason: "batch_timeout",
          error: "Batch timeout deadline expired before process start",
          lifecycle: {
            processStarted: false,
            processExited: false,
            killAttempted: false,
            killSucceeded: false,
            waitAttempted: false,
            reaped: false,
            processTreeKillAttempted: false,
            processTreeKillSucceeded: false,
            descendantsRemaining: 0
          }
        });
        continue;
      }

      const requestedTimeoutMs = (req.timeoutSecs ?? 120) * 1000;
      const timeoutSource = remainingMs < requestedTimeoutMs ? "batch" : "request";
      const itemTimeoutMs = Math.min(requestedTimeoutMs, remainingMs);

      const allowedExitCodes = resolveExpectedExitCodes(req);
      let itemResult: Record<string, unknown>;
      try {
        if (req.type === "check") {
          const checkRes = await runProjectCheck(projectRoot, req.name ?? "check", itemTimeoutMs);
          stateStore.audit({ tool: "project_run", type: "check", projectAlias, name: req.name ?? "check", outcome: checkRes.outcome, exitCode: checkRes.exitCode, batchIndex: index });
          const ok = checkRes.outcome === "exited" && checkRes.exitCode !== null && allowedExitCodes.includes(checkRes.exitCode);
          itemResult = { ok, index, type: "check", name: req.name ?? "check", status: "executed", ...checkRes };
        } else if (req.type === "script") {
          const scriptRes = await runProjectScript(projectRoot, req.name, req.args ?? [], itemTimeoutMs);
          stateStore.audit({ tool: "project_run", type: "script", projectAlias, name: req.name, args: req.args ?? [], outcome: scriptRes.outcome, exitCode: scriptRes.exitCode, batchIndex: index });
          const ok = scriptRes.outcome === "exited" && scriptRes.exitCode !== null && allowedExitCodes.includes(scriptRes.exitCode);
          itemResult = { ok, index, type: "script", name: req.name, status: "executed", ...scriptRes };
        } else {
          const requiresConfirmation = permissions.requireConfirmation && commandRequiresConfirmation(req.command, req.args ?? []);
          if (requiresConfirmation && !req.confirm) {
            throw new Error("Confirmation required: set confirm=true");
          }
          const cmdRes = await runProjectCommand(projectRoot, req.command, req.args ?? [], itemTimeoutMs, policy);
          stateStore.audit({ tool: "project_run", type: "command", projectAlias, command: req.command, args: req.args ?? [], outcome: cmdRes.outcome, exitCode: cmdRes.exitCode, confirm: req.confirm ?? false, batchIndex: index });
          const ok = cmdRes.outcome === "exited" && cmdRes.exitCode !== null && allowedExitCodes.includes(cmdRes.exitCode);
          itemResult = { ok, index, type: "command", requiresConfirmation, status: "executed", ...cmdRes };
        }
        executedCount++;
      } catch (error) {
        executedCount++;
        itemResult = {
          ok: false,
          index,
          type: req.type,
          ...(req.type === "check" ? { name: req.name ?? "check" } : {}),
          ...(req.type === "script" ? { name: req.name, args: req.args ?? [] } : {}),
          ...(req.type === "command" ? { command: req.command, args: req.args ?? [] } : {}),
          status: "executed",
          error: safeError(error),
          lifecycle: {
            processStarted: false,
            processExited: false,
            killAttempted: false,
            killSucceeded: false,
            waitAttempted: false,
            reaped: false,
            processTreeKillAttempted: false,
            processTreeKillSucceeded: false,
            descendantsRemaining: 0
          }
        };
      }
      if (typeof itemResult.effectiveTimeoutMs === "number") {
        itemResult.requestedTimeoutMs = requestedTimeoutMs;
      }
      if (itemResult.outcome === "timed_out") {
        itemResult.timeoutSource = timeoutSource;
        if (timeoutSource === "batch") batchTimedOut = true;
      }


      const stdoutStr = typeof itemResult.stdout === "string" ? itemResult.stdout : "";
      const stderrStr = typeof itemResult.stderr === "string" ? itemResult.stderr : "";
      const itemChars = countChars(stdoutStr) + countChars(stderrStr);

      if (accumulatedOutputChars + itemChars > maxBatchOutputChars) {
        batchOutputTruncated = true;
        const budgetLeft = Math.max(0, maxBatchOutputChars - accumulatedOutputChars);
        let stdoutBatchTruncated = false;
        let stderrBatchTruncated = false;
        if (typeof itemResult.stdout === "string") {
          const limited = limitText(itemResult.stdout, budgetLeft);
          itemResult.stdout = limited.text;
          stdoutBatchTruncated = limited.truncated;
        }
        if (typeof itemResult.stderr === "string") {
          const remainingBudget = Math.max(0, budgetLeft - countChars(typeof itemResult.stdout === "string" ? itemResult.stdout : ""));
          const limited = limitText(itemResult.stderr, remainingBudget);
          itemResult.stderr = limited.text;
          stderrBatchTruncated = limited.truncated;
        }
        itemResult.stdoutTruncated = itemResult.stdoutTruncated === true || stdoutBatchTruncated;
        itemResult.stderrTruncated = itemResult.stderrTruncated === true || stderrBatchTruncated;
        itemResult.truncated = itemResult.stdoutTruncated === true || itemResult.stderrTruncated === true;
      }
      accumulatedOutputChars += itemChars;

      results.push(itemResult);

      if (stopOnFailure && !itemResult.ok) {
        for (let restIdx = index + 1; restIdx < batchRequests.length; restIdx++) {
          const restReq = batchRequests[restIdx];
          skippedCount++;
          results.push({
            ok: false,
            index: restIdx,
            type: restReq.type,
            status: "skipped",
            reason: "stop_on_failure",
            lifecycle: {
              processStarted: false,
              processExited: false,
              killAttempted: false,
              killSucceeded: false,
              waitAttempted: false,
              reaped: false,
              processTreeKillAttempted: false,
              processTreeKillSucceeded: false,
              descendantsRemaining: 0
            }
          });
        }
        break;
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    const failedCount = results.filter((r) => !r.ok && r.status === "executed" && r.outcome === "exited").length;
    const errorCount = results.filter((r) => !r.ok && (r.status === "skipped" || r.outcome !== "exited" || r.error !== undefined)).length;

    return {
      projectAlias,
      requestedCount: batchRequests.length,
      executedCount,
      skippedCount,
      successCount,
      failedCount,
      errorCount,
      ...(batchTimedOut ? { batchTimedOut: true } : {}),
      ...(batchOutputTruncated ? { batchOutputTruncated: true } : {}),
      results
    };
  });

  registerStrictProjectTool(server, "project_edit", "Edit files inside a registered project.\n\nBatch modes:\n- staged: Default for write, replace, insert, and replace_range. Evaluate related same-file edits together before committing them.\n- ordered: Use for copy, move, delete, mkdir, rmdir, or intentionally sequential changes.\n\nOptions:\n- dryRun: Return the planned result without modifying files.\n- verifyResult: Include bounded resulting text for changed text files.\n- continueOnFailure: Continue ordered execution after an operation fails.", {
    projectAlias: z.string().min(1),
    operations: z.array(editOperationSchema).min(1).max(50),
    batchMode: editBatchModeSchema,
    dryRun: z.boolean().default(false),
    verifyResult: z.boolean().default(false),
    continueOnFailure: z.boolean().default(false)
  }, mutateAnnotations, async ({ projectAlias, operations, batchMode, dryRun, verifyResult, continueOnFailure }) => {
    assertMainAgentPermission("projectEdit", policy);
    const result = executeProjectEditBatch({ projectAlias, operations, batchMode, dryRun, continueOnFailure, policy });
    return verifyResult ? { ...result, verification: verifyProjectEditResult(projectAlias, result, policy) } : result;
  });
}
