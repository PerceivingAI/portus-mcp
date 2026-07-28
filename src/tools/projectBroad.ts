import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProject, listProjects } from "../state/ProjectRegistry.js";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";
import { stateStore } from "../state/StateStore.js";
import { resolveProjectPath, resolveReadablePath } from "../policy/pathPolicy.js";
import { assertChatGptCommandAllowed, assertChatGptPermission } from "../policy/permissionPolicy.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { countChars, limitText } from "../runtime/outputLimits.js";
import { runProjectCheck, runProjectScript } from "../runtime/checks.js";
import { runProjectCommand } from "../runtime/commands.js";
import { registerStrictProjectTool } from "./projectToolUtils.js";
import type { SkillRegistrySnapshot } from "../skills/SkillRegistry.js";
import {
  assertCanReadProjectPath,
  assertProjectCommandStaysInProject,
  canReadProjectRelativePath,
  collectPaths,
  commandRequiresConfirmation,
  ensureExpectedHash,
  hashSha256,
  isTextLikely,
  parsePatchPaths,
  readProjectBinaryFile,
  readProjectTextFile,
  readProjectTextFileRange,
  scoreFileSearchPath,
  tokenizeFileSearchQuery
} from "./projects.js";

const execFileAsync = promisify(execFile);
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutateAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

function assertInputChars(name: string, value: string, limit: number): void {
  const chars = countChars(value);
  if (chars > limit) throw new Error(`Input exceeds ${name}: ${chars} > ${limit} chars`);
}

function safeRelativePath(relativePath: string): string {
  return path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ? "[invalid path]" : relativePath;
}

function safeError(error: unknown, relativePath?: string): string {
  const safePath = relativePath ? safeRelativePath(relativePath) : undefined;
  const fallback = safePath ? `Operation failed: ${safePath}` : "Project operation failed";
  if (!(error instanceof Error) || error.message.trim() === "") return fallback;
  if (safePath === "[invalid path]") return fallback;

  const errorRecord = error as Error & { path?: unknown };
  let message = error.message;
  if (typeof errorRecord.path === "string" && errorRecord.path !== "") {
    message = message.split(errorRecord.path).join(safePath ?? "[redacted path]");
  }
  message = message
    .replace(/(["'])(?:(?:\\\\\?\\)?[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/]|\/(?:Users|home|var|tmp)\/)[^"'\r\n]*\1/g, "$1[redacted path]$1")
    .replace(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\r\n]*/g, "[redacted path]")
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]*/g, "[redacted path]")
    .replace(/\/(?:Users|home|var|tmp)\/[^\r\n]*/g, "[redacted path]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return message === "" ? fallback : message.slice(0, 2000);
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

function treeSection(rootAlias: string, options: { relativePath?: string; maxDepth?: number; includeFiles?: boolean; includeDirs?: boolean; maxEntries?: number; format?: "tree" | "json" | "flat" }, registry: SkillRegistrySnapshot): Record<string, unknown> {
  const relativePath = options.relativePath ?? ".";
  const maxDepth = Math.min(options.maxDepth ?? 4, 12);
  const maxEntries = Math.min(options.maxEntries ?? 500, 5000);
  const includeFiles = options.includeFiles ?? true;
  const includeDirs = options.includeDirs ?? true;
  const format = options.format ?? "tree";
  const base = resolveReadablePath(rootAlias, relativePath, registry);
  assertCanReadProjectPath(rootAlias, base, relativePath, registry);
  const depthFromBase = (entryRelativePath: string): number => {
    const target = resolveReadablePath(rootAlias, entryRelativePath, registry);
    const fromBase = path.relative(base, target).replace(/\\/g, "/");
    return fromBase === "." ? 0 : fromBase.split("/").length;
  };
  const entries = collectPaths(rootAlias, base, maxEntries, includeFiles, includeDirs, registry)
    .filter((entry) => depthFromBase(entry.relativePath) <= maxDepth);
  if (format === "flat" || format === "json") return { relativePath, format, entries, truncated: entries.length >= maxEntries, maxEntries };
  const output = [relativePath, ...entries.map((entry) => `${"  ".repeat(Math.max(0, depthFromBase(entry.relativePath) - 1))}${entry.kind === "directory" ? "[D] " : ""}${entry.relativePath}`)].join("\n");
  return { relativePath, format, output, truncated: entries.length >= maxEntries, maxEntries };
}

function filesSection(rootAlias: string, options: { relativePath?: string; maxEntries?: number }, registry: SkillRegistrySnapshot): Record<string, unknown> {
  const relativePath = options.relativePath ?? ".";
  const maxEntries = options.maxEntries ?? 200;
  const root = resolveReadablePath(rootAlias, relativePath, registry);
  assertCanReadProjectPath(rootAlias, root, relativePath, registry);
  const files = collectPaths(rootAlias, root, maxEntries, true, false, registry).filter((entry) => entry.kind === "file");
  return { relativePath, files, truncated: files.length >= maxEntries, maxEntries };
}

function filesSearch(projectAlias: string, query: string, relativePath: string, maxResults: number, caseSensitive: boolean) {
  const root = resolveProjectPath(projectAlias, relativePath);
  assertCanReadProjectPath(projectAlias, root, relativePath);
  const tokens = tokenizeFileSearchQuery(query, caseSensitive);
  const scanLimit = loadPolicyConfig().limits.search.maxScanEntries;
  const ranked = collectPaths(projectAlias, root, scanLimit, true, false)
    .map((item) => ({ item, ...scoreFileSearchPath(item.relativePath, query, tokens, caseSensitive) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.item.relativePath.localeCompare(right.item.relativePath));
  return { matches: ranked.slice(0, maxResults).map(({ item, score, matchedTokens }) => ({ ...item, score, matchedTokens })), truncated: ranked.length > maxResults };
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

  constructor(query: string, flags: string, maxExecutionMs: number) {
    // Validate syntax synchronously; matching untrusted input happens only in the worker.
    new RegExp(query, flags);
    this.worker = new Worker(REGEX_WORKER_SOURCE, { eval: true, workerData: { query, flags } });
    this.remainingExecutionMs = maxExecutionMs;
  }

  async matchingIndexes(lines: string[]): Promise<Set<number>> {
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
          void this.worker.terminate();
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

  close(): void {
    void this.worker.terminate();
  }
}

async function textSearch(projectAlias: string, query: string, relativePath: string, maxResults: number, contextLines: number, caseSensitive: boolean, regex: boolean, symbols: boolean) {
  const root = resolveProjectPath(projectAlias, relativePath);
  assertCanReadProjectPath(projectAlias, root, relativePath);
  const limits = loadPolicyConfig().limits.search;
  const matches: Array<Record<string, unknown>> = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matcher = regex ? new IsolatedRegexMatcher(query, caseSensitive ? "" : "i", limits.maxRegexExecutionMs) : null;
  try {
    for (const entry of collectPaths(projectAlias, root, limits.maxScanEntries, true, false)) {
      if (matches.length >= maxResults) break;
      if (!canReadProjectRelativePath(projectAlias, entry.relativePath)) continue;
      const target = resolveProjectPath(projectAlias, entry.relativePath);
      if (!isTextLikely(target)) continue;
      const lines = limitText(readFileSync(target, "utf8"), limits.maxTextFileChars).text.split(/\r?\n/);
      const regexIndexes = matcher ? await matcher.matchingIndexes(lines) : null;
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] ?? "";
        const candidate = caseSensitive ? text : text.toLowerCase();
        if (!(regexIndexes ? regexIndexes.has(index) : candidate.includes(needle))) continue;
        matches.push({ relativePath: entry.relativePath, line: index + 1, text, ...(symbols ? {} : { before: lines.slice(Math.max(0, index - contextLines), index), after: lines.slice(index + 1, index + 1 + contextLines) }) });
        if (matches.length >= maxResults) break;
      }
    }
    return { matches, truncated: matches.length >= maxResults };
  } finally {
    matcher?.close();
  }
}

const expectedFileSchema = z.object({ relativePath: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), sizeBytes: z.number().int().nonnegative().optional(), modifiedAt: z.string().optional() }).strict();
const editOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), relativePath: z.string().min(1), content: z.string(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict(),
  z.object({ type: z.literal("replace"), relativePath: z.string().min(1), search: z.string().min(1), replace: z.string(), expectedOccurrences: z.number().int().nonnegative().optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict(),
  z.object({ type: z.literal("insert"), relativePath: z.string().min(1), marker: z.string().min(1), content: z.string(), position: z.enum(["before", "after"]), expectedOccurrences: z.number().int().positive().optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict(),
  z.object({ type: z.literal("copy"), sourceRelativePath: z.string().min(1), destinationRelativePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("move"), sourceRelativePath: z.string().min(1), destinationRelativePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("delete"), relativePath: z.string().min(1), confirm: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("mkdir"), relativePath: z.string().min(1), recursive: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal("rmdir"), relativePath: z.string().min(1), recursive: z.boolean().default(false), confirm: z.boolean().default(false) }).strict()
]);

type EditOperation = z.infer<typeof editOperationSchema>;

function performEdit(projectAlias: string, operation: EditOperation, dryRun: boolean): Record<string, unknown> {
  if (operation.type === "write") {
    assertInputChars("limits.fileWrite.maxChars", operation.content, loadPolicyConfig().limits.fileWrite.maxChars);
    const target = resolveProjectPath(projectAlias, operation.relativePath);
    if (existsSync(target)) {
      assertCanReadProjectPath(projectAlias, target, operation.relativePath);
      ensureExpectedHash(projectAlias, operation.expectedSha256, operation.relativePath);
    } else if (operation.expectedSha256) throw new Error(`stale_file:${operation.relativePath}`);
    if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.relativePath); mkdirSync(path.dirname(target), { recursive: true }); resolveProjectPath(projectAlias, operation.relativePath); writeFileSync(target, operation.content, "utf8"); }
    stateStore.audit({ tool: "project_edit", operation: "write", projectAlias, relativePath: operation.relativePath, dryRun, bytes: Buffer.byteLength(operation.content) });
    return { relativePath: operation.relativePath, bytes: Buffer.byteLength(operation.content), dryRun };
  }
  if (operation.type === "replace" || operation.type === "insert") {
    const limits = loadPolicyConfig().limits.textEdit;
    const marker = operation.type === "replace" ? operation.search : operation.marker;
    const content = operation.type === "replace" ? operation.replace : operation.content;
    assertInputChars("limits.textEdit.maxSearchOrMarkerChars", marker, limits.maxSearchOrMarkerChars);
    assertInputChars("limits.textEdit.maxOperationChars", content, limits.maxOperationChars);
    const target = resolveProjectPath(projectAlias, operation.relativePath);
    assertCanReadProjectPath(projectAlias, target, operation.relativePath);
    if (!isTextLikely(target)) throw new Error("binary_file");
    ensureExpectedHash(projectAlias, operation.expectedSha256, operation.relativePath);
    const source = readFileSync(target, "utf8");
    const occurrences = source.split(marker).length - 1;
    if (operation.expectedOccurrences !== undefined && operation.expectedOccurrences !== occurrences) throw new Error(`occurrence_mismatch:${operation.relativePath}`);
    const updated = operation.type === "replace" ? source.split(marker).join(content) : operation.position === "before" ? source.replace(marker, `${content}${marker}`) : source.replace(marker, `${marker}${content}`);
    if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.relativePath); writeFileSync(target, updated, "utf8"); }
    stateStore.audit({ tool: "project_edit", operation: operation.type, projectAlias, relativePath: operation.relativePath, occurrences, dryRun });
    return { relativePath: operation.relativePath, occurrences, bytesWritten: Buffer.byteLength(updated), dryRun };
  }
  if (operation.type === "copy") {
    const source = resolveProjectPath(projectAlias, operation.sourceRelativePath); const destination = resolveProjectPath(projectAlias, operation.destinationRelativePath);
    assertCanReadProjectPath(projectAlias, source, operation.sourceRelativePath);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Source file does not exist or is not a file: ${operation.sourceRelativePath}`);
    const existed = existsSync(destination);
    if (existed) assertCanReadProjectPath(projectAlias, destination, operation.destinationRelativePath);
    if (existed && !operation.overwrite) throw new Error(`Destination already exists: ${operation.destinationRelativePath}`);
    if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.sourceRelativePath); resolveProjectPath(projectAlias, operation.destinationRelativePath); mkdirSync(path.dirname(destination), { recursive: true }); resolveProjectPath(projectAlias, operation.destinationRelativePath); copyFileSync(source, destination); }
    stateStore.audit({ tool: "project_edit", operation: "copy", projectAlias, sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrite: operation.overwrite, dryRun });
    return { sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrote: existed, dryRun };
  }
  if (operation.type === "move") {
    const source = resolveProjectPath(projectAlias, operation.sourceRelativePath); const destination = resolveProjectPath(projectAlias, operation.destinationRelativePath);
    assertCanReadProjectPath(projectAlias, source, operation.sourceRelativePath);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Source file does not exist or is not a file: ${operation.sourceRelativePath}`);
    if (!existsSync(path.dirname(destination))) throw new Error(`Destination parent does not exist: ${operation.destinationRelativePath}`);
    const existed = existsSync(destination); if (existed && !operation.overwrite) throw new Error(`Destination already exists: ${operation.destinationRelativePath}`);
    if (existed) assertCanReadProjectPath(projectAlias, destination, operation.destinationRelativePath);
    if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.sourceRelativePath); resolveProjectPath(projectAlias, operation.destinationRelativePath); if (existed) unlinkSync(destination); resolveProjectPath(projectAlias, operation.destinationRelativePath); renameSync(source, destination); }
    stateStore.audit({ tool: "project_edit", operation: "move", projectAlias, sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrite: operation.overwrite, dryRun });
    return { sourceRelativePath: operation.sourceRelativePath, destinationRelativePath: operation.destinationRelativePath, overwrote: existed, dryRun };
  }
  const requireConfirm = getEffectivePermissions(projectAlias).chatgpt.requireConfirmation;
  if (operation.type === "delete") {
    if (requireConfirm && !operation.confirm) throw new Error("Confirmation required: set confirm=true");
    const target = resolveProjectPath(projectAlias, operation.relativePath); assertCanReadProjectPath(projectAlias, target, operation.relativePath); const info = statSync(target);
    if (!info.isFile()) throw new Error(`Not a file: ${operation.relativePath}`);
    if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.relativePath); unlinkSync(target); }
    stateStore.audit({ tool: "project_edit", operation: "delete", projectAlias, relativePath: operation.relativePath, bytes: info.size, dryRun });
    return { relativePath: operation.relativePath, bytes: info.size, deleted: !dryRun, dryRun };
  }
  if (operation.type === "mkdir") { const target = resolveProjectPath(projectAlias, operation.relativePath);
    if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.relativePath); mkdirSync(target, { recursive: operation.recursive }); }
    stateStore.audit({ tool: "project_edit", operation: "mkdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
    return { relativePath: operation.relativePath, created: !dryRun, dryRun };
  }
  if (requireConfirm && !operation.confirm) throw new Error("Confirmation required: set confirm=true");
  const target = resolveProjectPath(projectAlias, operation.relativePath); assertCanReadProjectPath(projectAlias, target, operation.relativePath);
  if (!dryRun) { stateStore.requireAuditWritable(); resolveProjectPath(projectAlias, operation.relativePath); rmSync(target, { recursive: operation.recursive, force: false }); }
  stateStore.audit({ tool: "project_edit", operation: "rmdir", projectAlias, relativePath: operation.relativePath, recursive: operation.recursive, dryRun });
  return { relativePath: operation.relativePath, deleted: !dryRun, dryRun };
}

export function registerProjectReadTool(server: McpServer, registry: SkillRegistrySnapshot): void {
  registerStrictProjectTool(server, "project_read", "Read content or metadata from registered project paths and configured read-only skill paths. Use a project alias or a skill rootAlias returned by project_context; skill entrypoints and supporting files use their catalog-provided relative paths. Supports 1–20 batched content, binary, metadata, or existence requests with ordered per-item results.", {
    projectAlias: z.string().min(1),
    requests: z.array(z.object({ relativePath: z.string().min(1), mode: z.enum(["content", "binary", "metadata", "exists"]).default("content"), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict().superRefine((request, context) => { if (request.mode !== "content" && (request.startLine !== undefined || request.endLine !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Line ranges are only valid for content mode" }); })).min(1).max(20)
  }, readAnnotations, async ({ projectAlias, requests }) => {
    assertChatGptPermission("projectRead", registry.connected.byAlias.has(projectAlias) ? undefined : projectAlias);
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

export function registerBroadProjectTools(server: McpServer, registry: SkillRegistrySnapshot): void {
  registerProjectReadTool(server, registry);

  const treeSchema = z.object({ relativePath: z.string().min(1).optional(), maxDepth: z.number().int().positive().max(12).optional(), includeFiles: z.boolean().optional(), includeDirs: z.boolean().optional(), maxEntries: z.number().int().positive().max(5000).optional(), format: z.enum(["tree", "json", "flat"]).optional() }).strict();
  registerStrictProjectTool(server, "project_context", "Discover registered projects and available read-only skills, or inspect bounded trees, file listings, and path metadata using either a registered project alias or a catalog-provided skill rootAlias. Project status and package scripts are available only for registered projects.", {
    projectAlias: z.string().min(1).optional().describe("Registered project alias, or a skill rootAlias returned by include.skills for tree, files, and paths."), include: z.object({ projects: z.boolean().optional(), skills: z.boolean().optional(), status: z.boolean().optional(), tree: treeSchema.optional(), files: z.object({ relativePath: z.string().min(1).optional(), maxEntries: z.number().int().positive().max(1000).optional() }).strict().optional(), paths: z.array(z.object({ relativePath: z.string().min(1), includeHash: z.boolean().optional() }).strict()).max(20).optional(), scripts: z.boolean().optional() }).strict().optional()
  }, readAnnotations, async ({ projectAlias, include }) => {
    const requested = include ?? { status: true, tree: { maxDepth: 2, maxEntries: 200 }, scripts: true };
    const hasScopedRequest = requested.status === true || requested.tree !== undefined || requested.files !== undefined || requested.paths !== undefined || requested.scripts === true;
    const hasDiscoveryRequest = requested.projects === true || requested.skills === true;
    const isSkillRoot = projectAlias !== undefined && registry.connected.byAlias.has(projectAlias);
    if (hasScopedRequest && !projectAlias) throw new Error("projectAlias is required for project-scoped context sections");
    if (!hasScopedRequest && !hasDiscoveryRequest) throw new Error("Request at least one context section");
    if (isSkillRoot && (requested.status === true || requested.scripts === true)) {
      throw new Error("Skill rootAlias supports only tree, files, and paths context sections.");
    }
    if (hasDiscoveryRequest) assertChatGptPermission("projectContext");
    if (hasScopedRequest) assertChatGptPermission("projectContext", isSkillRoot ? undefined : projectAlias);
    const sections: Record<string, unknown> = {};
    const isolate = (name: string, action: () => unknown) => { try { sections[name] = { ok: true, value: action() }; } catch (error) { sections[name] = { ok: false, error: safeError(error) }; } };
    if (requested.projects) isolate("projects", () => ({ projectAliases: listProjects().map((project) => project.projectAlias) }));
    if (requested.skills) isolate("skills", () => ({
      skills: registry.connected.catalog.map(({ name, description, rootAlias, entrypoint }) => ({ name, description, rootAlias, entrypoint }))
    }));
    if (requested.status) isolate("status", () => {
      const project = getProject(projectAlias!);
      return {
        project: {
          projectAlias: project.projectAlias,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt
        }
      };
    });
    if (requested.tree) isolate("tree", () => treeSection(projectAlias!, requested.tree ?? {}, registry));
    if (requested.files) isolate("files", () => filesSection(projectAlias!, requested.files ?? {}, registry));
    if (requested.paths) isolate("paths", () => requested.paths?.map((item) => { try { return { ok: true, ...pathMetadata(projectAlias!, item.relativePath, item.includeHash ?? false, registry) }; } catch (error) { return { ok: false, relativePath: safeRelativePath(item.relativePath), error: safeError(error, item.relativePath) }; } }) ?? []);
    if (requested.scripts) isolate("scripts", () => ({ scripts: packageScripts(projectAlias!) }));
    return { projectAlias: projectAlias ?? null, sections };
  });

  registerStrictProjectTool(server, "project_search", "Search project file paths, text, symbols, or all three within authoritative scan and output limits.", {
    projectAlias: z.string().min(1), mode: z.enum(["files", "text", "symbols", "all"]), query: z.string().min(1), relativePath: z.string().min(1).default("."), regex: z.boolean().default(false), caseSensitive: z.boolean().default(false), contextLines: z.number().int().min(0).max(10).default(0), maxResults: z.number().int().positive().max(5000).default(100)
  }, readAnnotations, async ({ projectAlias, mode, query, relativePath, regex, caseSensitive, contextLines, maxResults }) => {
    assertChatGptPermission("projectSearch", projectAlias); const bounded = Math.min(maxResults, loadPolicyConfig().limits.search.maxScanEntries); const sections: Record<string, unknown> = {};
    const run = async (name: string, action: () => Record<string, unknown> | Promise<Record<string, unknown>>) => { try { sections[name] = { ok: true, ...await action() }; } catch (error) { sections[name] = { ok: false, error: safeError(error, relativePath) }; } };
    if (mode === "files" || mode === "all") await run("files", () => filesSearch(projectAlias, query, relativePath, bounded, caseSensitive));
    if (mode === "text" || mode === "all") await run("text", () => textSearch(projectAlias, query, relativePath, bounded, contextLines, caseSensitive, regex, false));
    if (mode === "symbols" || mode === "all") await run("symbols", () => textSearch(projectAlias, query, relativePath, bounded, 0, caseSensitive, regex, true));
    return { projectAlias, mode, query, maxResults: bounded, sections };
  });

  registerStrictProjectTool(server, "project_patch", "Prepare patch metadata or safely apply a unified diff inside a registered project.", {
    projectAlias: z.string().min(1), mode: z.enum(["prepare", "apply"]), patch: z.string().min(1), includeHash: z.boolean().optional(), expectedFiles: z.array(expectedFileSchema).optional(), dryRun: z.boolean().optional(), confirm: z.boolean().optional()
  }, mutateAnnotations, async ({ projectAlias, mode, patch, includeHash, expectedFiles, dryRun, confirm }) => {
    assertChatGptPermission("projectPatch", projectAlias);
    assertInputChars("limits.patch.maxChars", patch, loadPolicyConfig().limits.patch.maxChars); const parsed = parsePatchPaths(patch); getProject(projectAlias);
    if (mode === "prepare") {
      if (expectedFiles !== undefined || dryRun !== undefined || confirm !== undefined) throw new Error("Apply-only fields are not valid in prepare mode");
      return { projectAlias, mode, changedFiles: parsed.files, deletedFiles: [...parsed.deleted], expectedFiles: parsed.files.map((relativePath) => pathMetadata(projectAlias, relativePath, includeHash ?? true)), readyForApply: true };
    }
    if (includeHash !== undefined) throw new Error("includeHash is only valid in prepare mode"); const metadata = expectedFiles ?? []; const byPath = new Map(metadata.map((item) => [item.relativePath, item]));
    for (const file of parsed.files) { const target = resolveProjectPath(projectAlias, file); if (existsSync(target)) { assertCanReadProjectPath(projectAlias, target, file); if (!byPath.has(file)) throw new Error(`stale_file:${file}:missing_expected_metadata`); } }
    if (parsed.deleted.size > 0 && getEffectivePermissions(projectAlias).chatgpt.requireConfirmation) { if (!confirm) throw new Error("Confirmation required: set confirm=true for file deletions"); }
    for (const expected of metadata) { const target = resolveProjectPath(projectAlias, expected.relativePath); if (!existsSync(target)) continue; assertCanReadProjectPath(projectAlias, target, expected.relativePath); const info = statSync(target); if (expected.sizeBytes !== undefined && expected.sizeBytes !== info.size) throw new Error(`stale_file:${expected.relativePath}`); if (expected.modifiedAt && expected.modifiedAt !== info.mtime.toISOString()) throw new Error(`stale_file:${expected.relativePath}`); ensureExpectedHash(projectAlias, expected.sha256, expected.relativePath); }
    const patchPath = path.join(os.tmpdir(), `portus-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`); writeFileSync(patchPath, patch, "utf8");
    try { for (const file of parsed.files) resolveProjectPath(projectAlias, file); const projectRoot = resolveProjectPath(projectAlias, "."); await execFileAsync("git", ["apply", "--check", patchPath], { cwd: projectRoot }); if (!dryRun) { stateStore.requireAuditWritable(); for (const file of parsed.files) resolveProjectPath(projectAlias, file); await execFileAsync("git", ["apply", patchPath], { cwd: resolveProjectPath(projectAlias, ".") }); } stateStore.audit({ tool: "project_patch", projectAlias, mode, dryRun: dryRun ?? false, files: parsed.files, deletedFiles: [...parsed.deleted] }); return { projectAlias, mode, applied: !dryRun, dryRun: dryRun ?? false, changedFiles: parsed.files, deletedFiles: [...parsed.deleted] }; } catch { return { projectAlias, mode, applied: false, errorType: "patch_does_not_apply", message: "Patch could not be applied" }; } finally { try { rmSync(patchPath, { force: true }); } catch { /* temporary cleanup is best effort */ } }
  });

  registerStrictProjectTool(server, "project_run", "Run an approved check, package script, or allowlisted command with bounded timeout and output.", {
    projectAlias: z.string().min(1), type: z.enum(["check", "script", "command"]), name: z.string().min(1).optional(), command: z.string().min(1).optional(), args: z.array(z.string()).max(200).optional(), timeoutSecs: z.number().int().positive().max(900).optional(), confirm: z.boolean().optional()
  }, mutateAnnotations, async ({ projectAlias, type, name, command, args, timeoutSecs, confirm }) => {
    assertChatGptPermission("projectRun", projectAlias);
    const timeout = Math.min(timeoutSecs ?? 120, 900); const commandArgs = args ?? [];
    if (type === "check") { if (command !== undefined || confirm !== undefined || commandArgs.length > 0) throw new Error("Command fields are not valid for check type"); assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json"); stateStore.requireAuditWritable(); const result = await runProjectCheck(resolveProjectPath(projectAlias, "."), name ?? "check", timeout); stateStore.audit({ tool: "project_run", type, projectAlias, name: name ?? "check", exitCode: result.exitCode }); return { projectAlias, type, ...result }; }
    if (type === "script") { if (!name || command !== undefined || confirm !== undefined) throw new Error("Script type requires name and forbids command fields"); assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json"); stateStore.requireAuditWritable(); const result = await runProjectScript(resolveProjectPath(projectAlias, "."), name, commandArgs, timeout); stateStore.audit({ tool: "project_run", type, projectAlias, name, args: commandArgs, exitCode: result.exitCode }); return { projectAlias, type, name, args: commandArgs, ...result }; }
    if (!command || name !== undefined) throw new Error("Command type requires command and forbids name"); assertChatGptCommandAllowed(command, projectAlias); assertProjectCommandStaysInProject(command, commandArgs); const requiresConfirmation = getEffectivePermissions(projectAlias).chatgpt.requireConfirmation && commandRequiresConfirmation(command, commandArgs); if (requiresConfirmation && !confirm) throw new Error("Confirmation required: set confirm=true"); stateStore.requireAuditWritable(); const result = await runProjectCommand(resolveProjectPath(projectAlias, "."), command, commandArgs, timeout, projectAlias); stateStore.audit({ tool: "project_run", type, projectAlias, command, args: commandArgs, exitCode: result.exitCode, confirm: confirm ?? false }); return { projectAlias, type, requiresConfirmation, ...result };
  });

  registerStrictProjectTool(server, "project_edit", "Apply an ordered, non-atomic batch of policy-checked project file and directory edits.", {
    projectAlias: z.string().min(1), operations: z.array(editOperationSchema).min(1).max(20), dryRun: z.boolean().default(false)
  }, mutateAnnotations, async ({ projectAlias, operations, dryRun }) => {
    assertChatGptPermission("projectEdit", projectAlias);
    const results: Array<Record<string, unknown>> = [];
    for (const [index, operation] of operations.entries()) { try { results.push({ ok: true, index, type: operation.type, ...performEdit(projectAlias, operation, dryRun) }); } catch (error) { const relativePath = "relativePath" in operation ? operation.relativePath : "sourceRelativePath" in operation ? operation.sourceRelativePath : undefined; results.push({ ok: false, index, type: operation.type, relativePath: relativePath ? safeRelativePath(relativePath) : undefined, error: safeError(error, relativePath) }); } }
    return { projectAlias, dryRun, atomic: false, requestedCount: operations.length, successCount: results.filter((result) => result.ok).length, errorCount: results.filter((result) => !result.ok).length, results };
  });
}
