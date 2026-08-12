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
import { registerStrictProjectTool, safeError, safeRelativePath } from "./projectToolUtils.js";
import { editOperationSchema, executeProjectEditBatch } from "./projectEdit.js";
import type { SkillRegistrySnapshot } from "../skills/SkillRegistry.js";
import {
  assertCanReadProjectPath,
  assertProjectCommandStaysInProject,
  collectPaths,
  collectSearchableFiles,
  commandRequiresConfirmation,
  ensureExpectedHash,
  hashSha256,
  isTextLikely,
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

function assertInputChars(name: string, value: string, limit: number): void {
  const chars = countChars(value);
  if (chars > limit) throw new Error(`Input exceeds ${name}: ${chars} > ${limit} chars`);
}


function pathMetadata(projectAlias: string, relativePath: string, includeHash: boolean, registry?: SkillRegistrySnapshot): Record<string, unknown> {
  const target = registry
    ? resolveReadablePath(projectAlias, relativePath, registry)
    : resolveProjectPath(projectAlias, relativePath);
  assertCanReadProjectPath(projectAlias, target, relativePath, registry);
  if (!existsSync(target)) return { relativePath, exists: false };
  const info = statSync(target);
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  return {
    relativePath,
    exists: true,
    kind,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    isTextLikely: kind === "file" ? isTextLikely(target) : false,
    ...(includeHash && kind === "file" ? { sha256: hashSha256(readFileSync(target)) } : {})
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

const expectedFileSchema = z.object({ relativePath: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), sizeBytes: z.number().int().nonnegative().optional(), modifiedAt: z.string().optional() }).strict();

export function registerProjectReadTool(server: McpServer, registry: SkillRegistrySnapshot, policy: PortusPolicyConfig = loadPolicyConfig()): void {
  registerStrictProjectTool(server, "project_read", "Read content or metadata from registered project paths and configured read-only skill paths. Text content results include the complete raw-file SHA-256, including for bounded or truncated reads. Use a project alias or a skill rootAlias returned by project_context; skill entrypoints and supporting files use their catalog-provided relative paths. Supports 1–50 batched content, binary, metadata, or existence requests with ordered per-item results.", {
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
                assertCanReadProjectPath(projectAlias, target, request.relativePath, registry);
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

export function registerBroadProjectTools(server: McpServer, registry: SkillRegistrySnapshot, policy: PortusPolicyConfig = loadPolicyConfig()): void {
  registerProjectReadTool(server, registry, policy);

  const treeSchema = z.object({ relativePath: z.string().min(1).optional(), maxDepth: z.number().int().positive().max(20).optional(), includeFiles: z.boolean().optional(), includeDirs: z.boolean().optional(), maxEntries: z.number().int().positive().max(20000).optional(), format: z.enum(["tree", "json", "flat"]).optional() }).strict();
  registerStrictProjectTool(server, "project_context", "Discover registered projects and available read-only skills, or inspect effective execution capabilities, bounded trees, file listings, and path metadata using either a registered project alias or a catalog-provided skill rootAlias. Project status, execution capabilities, and package scripts are available only for registered projects.", {
    projectAlias: z.string().min(1).optional().describe("Registered project alias, or a skill rootAlias returned by include.skills for tree, files, and paths."), include: z.object({ projects: z.boolean().optional(), skills: z.boolean().optional(), status: z.boolean().optional(), execution: z.boolean().optional(), tree: treeSchema.optional(), files: z.object({ relativePath: z.string().min(1).optional(), maxEntries: z.number().int().positive().max(10000).optional() }).strict().optional(), paths: z.array(z.object({ relativePath: z.string().min(1), includeHash: z.boolean().optional() }).strict()).max(100).optional(), scripts: z.boolean().optional() }).strict().optional()
  }, readAnnotations, async ({ projectAlias, include }) => {
    const requested = include ?? { status: true, execution: true, tree: { maxDepth: 2, maxEntries: 200 }, scripts: true };
    const hasScopedRequest = requested.status === true || requested.execution === true || requested.tree !== undefined || requested.files !== undefined || requested.paths !== undefined || requested.scripts === true;
    const hasDiscoveryRequest = requested.projects === true || requested.skills === true;
    const isSkillRoot = projectAlias !== undefined && registry.connected.byAlias.has(projectAlias);
    if (hasScopedRequest && !projectAlias) throw new Error("projectAlias is required for project-scoped context sections");
    if (!hasScopedRequest && !hasDiscoveryRequest) throw new Error("Request at least one context section");
    if (isSkillRoot && (requested.status === true || requested.execution === true || requested.scripts === true)) {
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
    if (requested.execution) await isolate("execution", () => {
      const permissions = policyPermissions(policy).main_agent;
      return {
        enabled: permissions.projectRun,
        allowedCommands: permissions.allowedCommands,
        allowShell: permissions.allowShell,
        requireConfirmation: permissions.requireConfirmation
      };
    });
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

  registerStrictProjectTool(server, "project_search", "Search project file paths, text, symbols, or all three within authoritative scan and output limits.", {
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

  registerStrictProjectTool(server, "project_patch", "Prepare patch metadata or safely apply a unified diff inside a registered project.", {
    projectAlias: z.string().min(1), mode: z.enum(["prepare", "apply"]), patch: z.string().min(1), includeHash: z.boolean().optional(), expectedFiles: z.array(expectedFileSchema).optional(), dryRun: z.boolean().optional(), confirm: z.boolean().optional()
  }, mutateAnnotations, async ({ projectAlias, mode, patch, includeHash, expectedFiles, dryRun, confirm }) => {
    assertMainAgentPermission("projectPatch", policy);
    assertInputChars("limits.patch.maxChars", patch, policy.limits.patch.maxChars);
    const parsed = parsePatchPaths(patch);
    getProject(projectAlias);
    if (mode === "prepare") {
      if (expectedFiles !== undefined || dryRun !== undefined || confirm !== undefined) throw new Error("Apply-only fields are not valid in prepare mode");
      return { projectAlias, mode, changedFiles: parsed.files, deletedFiles: [...parsed.deleted], expectedFiles: parsed.files.map((relativePath) => pathMetadata(projectAlias, relativePath, includeHash ?? true)), readyForApply: true };
    }
    if (includeHash !== undefined) throw new Error("includeHash is only valid in prepare mode");
    const metadata = expectedFiles ?? [];
    const byPath = new Map(metadata.map((item) => [item.relativePath, item]));
    for (const file of parsed.files) {
      const target = resolveProjectPath(projectAlias, file);
      if (existsSync(target)) {
        assertCanReadProjectPath(projectAlias, target, file);
        if (!byPath.has(file)) throw new Error(`stale_file:${file}:missing_expected_metadata`);
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
      if (expected.sizeBytes !== undefined && expected.sizeBytes !== info.size) throw new Error(`stale_file:${expected.relativePath}`);
      if (expected.modifiedAt && expected.modifiedAt !== info.mtime.toISOString()) throw new Error(`stale_file:${expected.relativePath}`);
      ensureExpectedHash(projectAlias, expected.sha256, expected.relativePath);
    }
    const patchPath = path.join(os.tmpdir(), `portus-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
    writeFileSync(patchPath, patch, "utf8");
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
      shell: z.boolean().optional(),
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
  registerStrictProjectTool(server, "project_run", "Run an approved check, package script, or allowlisted command with bounded timeout and output.", {
    projectAlias: z.string().min(1),
    batchTimeoutSecs: z.number().int().positive().max(3600).optional(),
    stopOnFailure: z.boolean().default(false),
    requests: z.array(runRequestSchema).min(1).max(10)
  }, mutateAnnotations, async ({ projectAlias, batchTimeoutSecs, stopOnFailure, requests }) => {
    assertMainAgentPermission("projectRun", policy);

    const permissions = policyPermissions(policy).main_agent;
    const projectRoot = resolveProjectPath(projectAlias, ".");

    for (const req of requests) {
      if (req.type === "check") {
        assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json");
      } else if (req.type === "script") {
        assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json");
      } else if (req.type === "command") {
        assertMainAgentCommandAllowed(req.command, policy);
        assertProjectCommandStaysInProject(req.command, req.args ?? []);
        const reqShell = req.shell ?? false;
        if (reqShell && !permissions.allowShell) {
          throw new Error(`Shell execution is disabled for project alias '${projectAlias}'`);
        }
        if (!reqShell && (req.command.endsWith(".cmd") || req.command.endsWith(".bat"))) {
          throw new Error(`Direct execution of Windows batch scripts is not allowed without shell=true`);
        }
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

    for (const [index, req] of requests.entries()) {
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
          error: "Batch timeout deadline expired before process start"
        });
        continue;
      }

      const itemTimeoutMs = Math.min(
        (req.timeoutSecs ?? 120) * 1000,
        remainingMs
      );

      const allowedExitCodes = resolveExpectedExitCodes(req);
      let itemResult: Record<string, unknown>;
      try {
        if (req.type === "check") {
          const checkRes = await runProjectCheck(projectRoot, req.name ?? "check", itemTimeoutMs);
          stateStore.audit({ tool: "project_run", type: "check", projectAlias, name: req.name ?? "check", exitCode: checkRes.exitCode, batchIndex: index });
          const ok = checkRes.outcome === "exited" && checkRes.exitCode !== null && allowedExitCodes.includes(checkRes.exitCode);
          itemResult = { ok, index, type: "check", name: req.name ?? "check", status: "executed", ...checkRes };
        } else if (req.type === "script") {
          const scriptRes = await runProjectScript(projectRoot, req.name, req.args ?? [], itemTimeoutMs);
          stateStore.audit({ tool: "project_run", type: "script", projectAlias, name: req.name, args: req.args ?? [], exitCode: scriptRes.exitCode, batchIndex: index });
          const ok = scriptRes.outcome === "exited" && scriptRes.exitCode !== null && allowedExitCodes.includes(scriptRes.exitCode);
          itemResult = { ok, index, type: "script", name: req.name, status: "executed", ...scriptRes };
        } else {
          const requiresConfirmation = permissions.requireConfirmation && commandRequiresConfirmation(req.command, req.args ?? []);
          if (requiresConfirmation && !req.confirm) {
            throw new Error("Confirmation required: set confirm=true");
          }
          const cmdRes = await runProjectCommand(projectRoot, req.command, req.args ?? [], itemTimeoutMs, req.shell ?? false, policy);
          stateStore.audit({ tool: "project_run", type: "command", projectAlias, command: req.command, args: req.args ?? [], exitCode: cmdRes.exitCode, confirm: req.confirm ?? false, batchIndex: index });
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
          error: safeError(error)
        };
      }

      const stdoutStr = typeof itemResult.stdout === "string" ? itemResult.stdout : "";
      const stderrStr = typeof itemResult.stderr === "string" ? itemResult.stderr : "";
      const itemChars = countChars(stdoutStr) + countChars(stderrStr);

      if (accumulatedOutputChars + itemChars > maxBatchOutputChars) {
        batchOutputTruncated = true;
        itemResult.truncated = true;
        const budgetLeft = Math.max(0, maxBatchOutputChars - accumulatedOutputChars);
        if (typeof itemResult.stdout === "string") {
          const limited = limitText(itemResult.stdout, budgetLeft);
          itemResult.stdout = limited.text;
        }
        if (typeof itemResult.stderr === "string") {
          const remainingBudget = Math.max(0, budgetLeft - countChars(typeof itemResult.stdout === "string" ? itemResult.stdout : ""));
          const limited = limitText(itemResult.stderr, remainingBudget);
          itemResult.stderr = limited.text;
        }
      }
      accumulatedOutputChars += itemChars;

      results.push(itemResult);

      if (stopOnFailure && !itemResult.ok) {
        for (let restIdx = index + 1; restIdx < requests.length; restIdx++) {
          const restReq = requests[restIdx];
          skippedCount++;
          results.push({
            ok: false,
            index: restIdx,
            type: restReq.type,
            status: "skipped",
            reason: "stop_on_failure"
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
      requestedCount: requests.length,
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

  registerStrictProjectTool(server, "project_edit", "Apply an ordered, policy-checked project edit batch, including hash-guarded inclusive line-range replacement. Stops after the first rejected or failed operation unless continueOnFailure=true; dry runs report planned mutations without changing files.", {
    projectAlias: z.string().min(1),
    operations: z.array(editOperationSchema).min(1).max(50),
    dryRun: z.boolean().default(false),
    continueOnFailure: z.boolean().default(false)
  }, mutateAnnotations, async ({ projectAlias, operations, dryRun, continueOnFailure }) => {
    assertMainAgentPermission("projectEdit", policy);
    return executeProjectEditBatch({ projectAlias, operations, dryRun, continueOnFailure, policy });
  });
}
