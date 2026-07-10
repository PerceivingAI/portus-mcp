import { closeSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { upsertProject, listProjects, getProject } from "../state/ProjectRegistry.js";
import { stateStore } from "../state/StateStore.js";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { assertChatGptCommandAllowed, assertChatGptPermission } from "../policy/permissionPolicy.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";
import { countChars, limitText } from "../runtime/outputLimits.js";
import { runProjectCheck, runProjectScript } from "../runtime/checks.js";
import { runProjectCommand } from "../runtime/commands.js";
import { registerTool } from "./toolUtils.js";

const execFileAsync = promisify(execFile);
const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".yaml", ".yml", ".toml", ".env", ".html", ".css", ".scss", ".xml", ".sh", ".ps1", ".sql"]);

function assertInputChars(name: string, value: string, limit: number): void {
  const chars = countChars(value);
  if (chars > limit) throw new Error(`Input exceeds ${name}: ${chars} > ${limit} chars`);
}

function resolveReadableTextFile(projectAlias: string, relativePath: string): string {
  assertChatGptPermission("readFiles", projectAlias);
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("Path is not allowed");
  }
  let target: string;
  try {
    target = resolveProjectPath(projectAlias, relativePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matchedAt = message.indexOf(" matched ");
    if (message.startsWith("Blocked path pattern ") && matchedAt !== -1) {
      throw new Error(`${message.slice(0, matchedAt)} matched ${relativePath}`);
    }
    throw error;
  }
  assertCanReadProjectPath(projectAlias, target, relativePath);
  if (!existsSync(target)) throw new Error(`File does not exist: ${relativePath}`);
  try {
    if (!statSync(target).isFile()) throw new Error(`Path is not a file: ${relativePath}`);
    if (!isTextLikely(target)) throw new Error(`File is not likely text: ${relativePath}`);
  } catch (error) {
    if (error instanceof Error && (error.message === `Path is not a file: ${relativePath}` || error.message === `File is not likely text: ${relativePath}`)) throw error;
    throw new Error(`Unable to inspect file: ${relativePath}`);
  }
  return target;
}

async function readProjectTextFile(input: { projectAlias: string; relativePath: string }) {
  const readLimit = loadPolicyConfig().limits.fileRead.maxChars;
  const target = resolveReadableTextFile(input.projectAlias, input.relativePath);
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch {
    throw new Error(`Unable to read text file: ${input.relativePath}`);
  }
  const limited = limitText(content, readLimit);
  return { projectAlias: input.projectAlias, relativePath: input.relativePath, content: limited.text, truncated: limited.truncated, chars: limited.chars, totalChars: limited.totalChars, omittedChars: limited.omittedChars, limit: limited.limit };
}

async function readProjectTextFileRange(input: { projectAlias: string; relativePath: string; startLine?: number; endLine?: number }) {
  const startLine = input.startLine ?? 1;
  const endLine = input.endLine ?? startLine + 199;
  if (endLine < startLine) throw new Error(`endLine must be greater than or equal to startLine`);
  const requestedLineCount = endLine - startLine + 1;
  if (requestedLineCount > 2000) throw new Error(`Requested line range exceeds maximum of 2000 lines`);

  const target = resolveReadableTextFile(input.projectAlias, input.relativePath);
  const stream = createReadStream(target, { encoding: "utf8" });
  const lines: string[] = [];
  let lineNumber = 0;
  let hasMore = false;
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if (lineNumber <= endLine) {
        lines.push(line);
        continue;
      }
      hasMore = true;
      break;
    }
  } catch {
    throw new Error(`Unable to read text file: ${input.relativePath}`);
  } finally {
    reader.close();
    stream.destroy();
  }

  const lineCount = lines.length;
  const limited = limitText(lines.join("\n"), loadPolicyConfig().limits.fileRead.maxChars);
  return {
    projectAlias: input.projectAlias,
    relativePath: input.relativePath,
    requested: { startLine, endLine },
    actual: {
      startLine: lineCount > 0 ? startLine : null,
      endLine: lineCount > 0 ? startLine + lineCount - 1 : null,
      lineCount
    },
    content: limited.text,
    hasMore,
    truncated: limited.truncated,
    chars: limited.chars,
    totalChars: limited.totalChars,
    omittedChars: limited.omittedChars,
    limit: limited.limit
  };
}

function hashSha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isTextLikely(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;
  const sample = Buffer.allocUnsafe(1024);
  const descriptor = openSync(filePath, "r");
  let bytesRead: number;
  try {
    bytesRead = readSync(descriptor, sample, 0, sample.length, 0);
  } finally {
    closeSync(descriptor);
  }
  for (let index = 0; index < bytesRead; index += 1) if (sample[index] === 0) return false;
  return true;
}

function getExcludedTraversalPatterns(): string[] {
  return loadConfig().traversal.excludedPatterns;
}

function pathMatchesPattern(relativePath: string, entryName: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase();
  const normalizedPath = relativePath.replace(/\\/g, "/").toLowerCase();
  if (!normalizedPattern.includes("/")) {
    return entryName.toLowerCase() === normalizedPattern || normalizedPath.split("/").includes(normalizedPattern);
  }
  return normalizedPath.includes(normalizedPattern);
}

function isGitIgnored(projectRoot: string, target: string): boolean {
  const relativePath = path.relative(projectRoot, target).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: projectRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function assertCanReadProjectPath(projectAlias: string, target: string, relativePath: string): void {
  const permissions = getEffectivePermissions(projectAlias).chatgpt;
  if (permissions.readGitIgnoredFiles) return;
  if (isGitIgnored(getProject(projectAlias).rootPath, target)) {
    throw new Error(`Permission denied: readGitIgnoredFiles is false for ignored path: ${relativePath}`);
  }
}

function canReadProjectRelativePath(projectAlias: string, relativePath: string): boolean {
  try {
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipTraversal(projectAlias: string, fullPath: string, entryName: string, excludedPatterns: string[], allowGitIgnored: boolean): boolean {
  const projectRoot = getProject(projectAlias).rootPath;
  const relativePath = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
  const relativeToStateRoot = path.relative(stateStore.root, fullPath);
  if (!relativeToStateRoot || (!relativeToStateRoot.startsWith("..") && !path.isAbsolute(relativeToStateRoot))) return true;
  if (excludedPatterns.some((pattern) => pathMatchesPattern(relativePath, entryName, pattern))) return true;
  return !allowGitIgnored && isGitIgnored(projectRoot, fullPath);
}

function collectPaths(projectAlias: string, root: string, maxEntries: number, includeFiles: boolean, includeDirs: boolean): Array<{ relativePath: string; kind: "file" | "directory"; bytes?: number; modifiedAt?: string }> {
  const out: Array<{ relativePath: string; kind: "file" | "directory"; bytes?: number; modifiedAt?: string }> = [];
  const queue = [root];
  const excludedPatterns = getExcludedTraversalPatterns();
  const allowGitIgnored = getEffectivePermissions(projectAlias).chatgpt.readGitIgnoredFiles;
  while (queue.length > 0 && out.length < maxEntries) {
    const dir = queue.shift()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/") || ".";
      if (!canReadProjectRelativePath(projectAlias, rel)) continue;
      if (entry.isDirectory()) {
        if (shouldSkipTraversal(projectAlias, full, entry.name, excludedPatterns, allowGitIgnored)) continue;
        if (includeDirs) out.push({ relativePath: rel, kind: "directory" });
        queue.push(full);
      } else if (entry.isFile() && includeFiles) {
        if (shouldSkipTraversal(projectAlias, full, entry.name, excludedPatterns, allowGitIgnored)) continue;
        const st = statSync(full);
        out.push({ relativePath: rel, kind: "file", bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }
      if (out.length >= maxEntries) break;
    }
  }
  return out;
}

function tokenizeFileSearchQuery(query: string, caseSensitive: boolean): string[] {
  const normalized = caseSensitive ? query.trim() : query.trim().toLowerCase();
  return normalized.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function scoreFileSearchPath(relativePath: string, query: string, tokens: string[], caseSensitive: boolean): { score: number; matchedTokens: string[] } {
  const haystack = caseSensitive ? relativePath : relativePath.toLowerCase();
  const basename = caseSensitive ? path.basename(relativePath) : path.basename(relativePath).toLowerCase();
  const exactQuery = caseSensitive ? query.trim() : query.trim().toLowerCase();
  const matchedTokens = tokens.filter((token) => haystack.includes(token));
  if (matchedTokens.length === 0 && !haystack.includes(exactQuery)) return { score: 0, matchedTokens: [] };
  let score = matchedTokens.length * 10;
  if (haystack.includes(exactQuery)) score += 50;
  for (const token of matchedTokens) {
    if (basename === token) score += 30;
    else if (basename.startsWith(token)) score += 20;
    else if (basename.includes(token)) score += 10;
  }
  return { score, matchedTokens };
}

function ensureExpectedHash(projectAlias: string, expectedSha256: string | undefined, relativePath: string): void {
  if (!expectedSha256) return;
  const target = resolveProjectPath(projectAlias, relativePath);
  const actual = hashSha256(readFileSync(target));
  if (actual !== expectedSha256) throw new Error(`stale_file:${relativePath}`);
}

const MAX_PATCH_PATHS = 100;
const PATCH_PATH_ESCAPE_BYTES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  "\"": 0x22,
  "\\": 0x5c
};

function decodeQuotedPatchPath(value: string): string | null {
  if (!value.startsWith("\"")) return null;
  const bytes: number[] = [];
  let index = 1;
  for (; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    if (character === "\"") break;
    if (character !== "\\") {
      bytes.push(...Buffer.from(character));
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    index += 1;
    if (index >= value.length) return null;
    const escaped = value[index]!;
    if (escaped in PATCH_PATH_ESCAPE_BYTES) {
      bytes.push(PATCH_PATH_ESCAPE_BYTES[escaped]!);
      continue;
    }
    if (!/[0-7]/.test(escaped)) return null;
    let octal = escaped;
    while (octal.length < 3 && index + 1 < value.length && /[0-7]/.test(value[index + 1]!)) {
      index += 1;
      octal += value[index]!;
    }
    const byte = Number.parseInt(octal, 8);
    if (byte > 0xff) return null;
    bytes.push(byte);
  }
  if (value[index] !== "\"") return null;
  const suffix = value.slice(index + 1);
  if (suffix !== "" && !suffix.startsWith("\t")) return null;
  const decoded = Buffer.from(bytes).toString("utf8");
  return decoded.includes("\uFFFD") ? null : decoded;
}

function parsePatchHeaderPath(line: string, marker: "--- " | "+++ "): string | null {
  if (!line.startsWith(marker)) return null;
  const value = line.slice(marker.length);
  const rawPath = value.startsWith("\"") ? decodeQuotedPatchPath(value) : value.split("\t", 1)[0] ?? "";
  if (!rawPath) return null;
  if (rawPath === "/dev/null") return rawPath;
  const relativePath = rawPath.replace(/^\.\//, "").replace(/^(?:a|b)\//, "");
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === "..")
  ) {
    return null;
  }
  return path.posix.normalize(relativePath.replace(/\\/g, "/"));
}

function parsePatchPaths(patch: string): { files: string[]; deleted: Set<string> } {
  const files = new Set<string>();
  const deleted = new Set<string>();
  const lines = patch.split(/\r?\n/);
  const addPath = (relativePath: string): void => {
    files.add(relativePath);
    if (files.size > MAX_PATCH_PATHS) throw new Error(`Patch affects more than ${MAX_PATCH_PATHS} unique paths`);
  };
  for (let index = 0; index < lines.length - 1; index += 1) {
    const oldLine = lines[index]!;
    const newLine = lines[index + 1]!;
    if (!oldLine.startsWith("--- ") || !newLine.startsWith("+++ ")) continue;
    const oldPath = parsePatchHeaderPath(oldLine, "--- ");
    const newPath = parsePatchHeaderPath(newLine, "+++ ");
    if (!oldPath || !newPath || (oldPath === "/dev/null" && newPath === "/dev/null")) {
      throw new Error("Patch contains an invalid file header");
    }
    if (oldPath !== "/dev/null") addPath(oldPath);
    if (newPath !== "/dev/null") addPath(newPath);
    if (newPath === "/dev/null") deleted.add(oldPath);
    index += 1;
  }
  return { files: Array.from(files), deleted };
}

export function registerProjectTools(server: McpServer): void {
  registerTool(server, "project_register", "Use this when the user wants to allow portus-mcp to work inside a local project folder.", { projectAlias: z.string(), rootPath: z.string() }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, rootPath }) => {
    assertChatGptPermission("registerProjects", projectAlias);
    if (!existsSync(rootPath)) throw new Error(`Project path does not exist: ${rootPath}`);
    stateStore.requireAuditWritable();
    const record = upsertProject({ projectAlias, rootPath });
    stateStore.audit({ tool: "project_register", projectAlias, rootPath });
    return record;
  });
  registerTool(server, "project_list", "Use this when the user wants to list registered projects.", {}, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async () => listProjects());
  registerTool(server, "project_status", "Use this when the user wants project registration status.", { projectAlias: z.string() }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => ({
    project: getProject(projectAlias)
  }));
  registerTool(server, "project_read_file", "Use this when ChatGPT needs to read a text file inside a registered project. The path must be relative to the registered project root and cannot read outside that project.", { projectAlias: z.string(), relativePath: z.string() }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath }) => readProjectTextFile({ projectAlias, relativePath }));
  registerTool(server, "project_read_text_file", "Use this when ChatGPT needs to read a text file inside a registered project. The path must be relative to the registered project root and cannot read outside that project.", { projectAlias: z.string(), relativePath: z.string() }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath }) => readProjectTextFile({ projectAlias, relativePath }));
  registerTool(server, "project_read_file_range", "Read a 1-based inclusive line range from a text file inside a registered project without loading the entire file.", { projectAlias: z.string(), relativePath: z.string(), startLine: z.number().int().positive().default(1), endLine: z.number().int().positive().optional() }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, startLine, endLine }) => readProjectTextFileRange({ projectAlias, relativePath, startLine, endLine }));
  registerTool(server, "project_list_files", "Use this when ChatGPT needs to list files inside a registered project.", { projectAlias: z.string(), relativePath: z.string().default("."), maxEntries: z.number().int().positive().max(1000).default(200) }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, maxEntries }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const root = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, root, relativePath);
    const files = collectPaths(projectAlias, root, maxEntries, true, false).filter((entry) => entry.kind === "file").map((entry) => entry.relativePath);
    return { projectAlias, relativePath, files, truncated: files.length >= maxEntries, maxEntries };
  });
  registerTool(server, "project_write_file", "Use this when ChatGPT needs to write a file inside a registered project.", { projectAlias: z.string(), relativePath: z.string(), content: z.string() }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, content }) => {
    assertChatGptPermission("writeFiles", projectAlias);
    assertInputChars("limits.fileWrite.maxChars", content, loadPolicyConfig().limits.fileWrite.maxChars);
    const target = resolveProjectPath(projectAlias, relativePath);
    if (existsSync(target)) assertCanReadProjectPath(projectAlias, target, relativePath);
    const bytes = Buffer.byteLength(content, "utf8");
    stateStore.requireAuditWritable();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    stateStore.audit({ tool: "project_write_file", projectAlias, relativePath, bytes });
    return { projectAlias, relativePath, bytes };
  });
  registerTool(server, "project_copy_file", "Copy a file inside a registered project.", { projectAlias: z.string(), sourceRelativePath: z.string(), destinationRelativePath: z.string(), overwrite: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, sourceRelativePath, destinationRelativePath, overwrite }) => {
    assertChatGptPermission("readFiles", projectAlias);
    assertChatGptPermission("writeFiles", projectAlias);
    const source = resolveProjectPath(projectAlias, sourceRelativePath);
    const destination = resolveProjectPath(projectAlias, destinationRelativePath);
    assertCanReadProjectPath(projectAlias, source, sourceRelativePath);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Source file does not exist or is not a file: ${sourceRelativePath}`);
    const existed = existsSync(destination);
    if (existed && !overwrite) throw new Error(`Destination already exists: ${destinationRelativePath}`);
    stateStore.requireAuditWritable();
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    const bytes = statSync(destination).size;
    stateStore.audit({ tool: "project_copy_file", projectAlias, sourceRelativePath, destinationRelativePath, bytes, overwrite });
    return { projectAlias, sourceRelativePath, destinationRelativePath, bytes, overwrote: existed && overwrite };
  });
  registerTool(server, "project_move_file", "Move or rename a file inside a registered project.", { projectAlias: z.string(), sourceRelativePath: z.string(), destinationRelativePath: z.string(), overwrite: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, sourceRelativePath, destinationRelativePath, overwrite }) => {
    assertChatGptPermission("moveFiles", projectAlias);
    const source = resolveProjectPath(projectAlias, sourceRelativePath);
    const destination = resolveProjectPath(projectAlias, destinationRelativePath);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`Source file does not exist or is not a file: ${sourceRelativePath}`);
    assertCanReadProjectPath(projectAlias, source, sourceRelativePath);
    if (!existsSync(path.dirname(destination))) throw new Error(`Destination parent does not exist: ${path.dirname(destinationRelativePath)}`);
    if (existsSync(destination)) {
      if (!overwrite) throw new Error(`Destination already exists: ${destinationRelativePath}`);
      if (!lstatSync(destination).isFile()) throw new Error(`Destination exists and is not a file: ${destinationRelativePath}`);
      assertCanReadProjectPath(projectAlias, destination, destinationRelativePath);
      stateStore.requireAuditWritable();
      unlinkSync(destination);
    } else {
      stateStore.requireAuditWritable();
    }
    renameSync(source, destination);
    stateStore.audit({ tool: "project_move_file", projectAlias, sourceRelativePath, destinationRelativePath, overwrite });
    return { projectAlias, sourceRelativePath, destinationRelativePath, overwrote: overwrite };
  });
  registerTool(server, "project_delete_file", "Delete a file in a registered project.", { projectAlias: z.string(), relativePath: z.string(), confirm: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ projectAlias, relativePath, confirm }) => {
    if (!confirm) throw new Error("Confirmation required: set confirm=true");
    assertChatGptPermission("deleteFiles", projectAlias);
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    const info = statSync(target);
    if (!info.isFile()) throw new Error(`Not a file: ${relativePath}`);
    stateStore.requireAuditWritable();
    unlinkSync(target);
    stateStore.audit({ tool: "project_delete_file", projectAlias, relativePath, bytes: info.size });
    return { projectAlias, relativePath, bytes: info.size, deleted: true };
  });
  registerTool(server, "project_file_info", "Inspect file or directory metadata without reading full content.", { projectAlias: z.string(), relativePath: z.string(), includeHash: z.boolean().default(false) }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, includeHash }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    if (!existsSync(target)) return { projectAlias, relativePath, exists: false };
    const st = statSync(target);
    const kind = st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
    const result: Record<string, unknown> = { projectAlias, relativePath, exists: true, kind, bytes: st.size, modifiedAt: st.mtime.toISOString(), isTextLikely: kind === "file" ? isTextLikely(target) : false };
    if (includeHash && kind === "file") result.sha256 = hashSha256(readFileSync(target));
    return result;
  });
  registerTool(server, "project_exists", "Check whether a path exists inside a registered project.", { projectAlias: z.string(), relativePath: z.string() }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    return { projectAlias, relativePath, exists: existsSync(target) };
  });
  registerTool(server, "project_tree", "Return a structured tree for a project path.", { projectAlias: z.string(), relativePath: z.string().default("."), maxDepth: z.number().int().positive().max(12).default(4), includeFiles: z.boolean().default(true), includeDirs: z.boolean().default(true), maxEntries: z.number().int().positive().max(5000).default(500), format: z.enum(["tree", "json", "flat"]).default("tree") }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, maxDepth, includeFiles, includeDirs, maxEntries, format }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const base = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, base, relativePath);
    let count = 0;
    let truncated = false;
    const excludedPatterns = getExcludedTraversalPatterns();
    const allowGitIgnored = getEffectivePermissions(projectAlias).chatgpt.readGitIgnoredFiles;
    function buildTree(current: string, depth: number): any {
      const node: any = { name: path.basename(current), kind: "directory", children: [] as any[] };
      if (depth >= maxDepth) return node;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (count >= maxEntries) { truncated = true; break; }
        const full = path.join(current, entry.name);
        if (shouldSkipTraversal(projectAlias, full, entry.name, excludedPatterns, allowGitIgnored)) continue;
        if (entry.isDirectory()) { node.children.push(buildTree(full, depth + 1)); count += 1; }
        else if (entry.isFile() && includeFiles) { node.children.push({ name: entry.name, kind: "file" }); count += 1; }
      }
      node.children = includeDirs ? node.children : node.children.filter((child: any) => child.kind === "file");
      return node;
    }
    const tree = buildTree(base, 0);
    if (format === "json") return { projectAlias, relativePath, tree, truncated, maxEntries };
    if (format === "flat") return { projectAlias, relativePath, entries: collectPaths(projectAlias, base, maxEntries, includeFiles, includeDirs), truncated, maxEntries };
    const lines: string[] = [relativePath === "." ? "." : relativePath];
    const render = (node: any, prefix: string) => {
      const children = node.children ?? [];
      children.forEach((child: any, idx: number) => {
        const last = idx === children.length - 1;
        lines.push(`${prefix}${last ? "└── " : "├── "}${child.name}`);
        if (child.kind === "directory") render(child, `${prefix}${last ? "    " : "│   "}`);
      });
    };
    render(tree, "");
    return { projectAlias, relativePath, format, truncated, output: lines.join("\n") };
  });
  registerTool(server, "project_search_files", "Search for files by name/path within a registered project.", { projectAlias: z.string(), query: z.string(), relativePath: z.string().default("."), glob: z.string().optional(), maxResults: z.number().int().positive().max(5000).default(100), includeDirs: z.boolean().default(false), caseSensitive: z.boolean().default(false) }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, query, relativePath, maxResults, includeDirs, caseSensitive }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const root = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, root, relativePath);
    const tokens = tokenizeFileSearchQuery(query, caseSensitive);
    const ranked = collectPaths(projectAlias, root, maxResults * 20, true, includeDirs)
      .map((item) => ({ item, ...scoreFileSearchPath(item.relativePath, query, tokens, caseSensitive) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.item.relativePath.localeCompare(b.item.relativePath));
    const matches = ranked.slice(0, maxResults).map(({ item, score, matchedTokens }) => ({ ...item, score, matchedTokens }));
    return { projectAlias, query, tokens, matches, truncated: ranked.length > maxResults, maxResults };
  });
  registerTool(server, "project_search_text", "Search text content inside project files.", { projectAlias: z.string(), query: z.string(), relativePath: z.string().default("."), glob: z.string().optional(), maxResults: z.number().int().positive().max(5000).default(100), contextLines: z.number().int().min(0).max(10).default(0), caseSensitive: z.boolean().default(false), regex: z.boolean().default(false) }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, query, relativePath, maxResults, contextLines, caseSensitive, regex }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const root = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, root, relativePath);
    const searchLimits = loadPolicyConfig().limits.search;
    const files = collectPaths(projectAlias, root, searchLimits.maxScanEntries, true, false);
    const matches: Array<Record<string, unknown>> = [];
    const pattern = regex ? new RegExp(query, caseSensitive ? "" : "i") : null;
    for (const entry of files) {
      if (matches.length >= maxResults) break;
      const full = path.join(root, entry.relativePath);
      if (!isTextLikely(full)) continue;
      const lines = limitText(readFileSync(full, "utf8"), searchLimits.maxTextFileChars).text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const matched = pattern ? pattern.test(line) : (caseSensitive ? line : line.toLowerCase()).includes(caseSensitive ? query : query.toLowerCase());
        if (!matched) continue;
        matches.push({ relativePath: entry.relativePath, line: i + 1, text: line, before: contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i) : [], after: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines) : [] });
        if (matches.length >= maxResults) break;
      }
    }
    return { projectAlias, query, matches, truncated: matches.length >= maxResults, maxResults };
  });
  registerTool(server, "project_prepare_patch", "Prepare safe file metadata for applying a unified diff patch.", { projectAlias: z.string(), patch: z.string(), includeHash: z.boolean().default(true) }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, patch, includeHash }) => {
    assertChatGptPermission("readFiles", projectAlias);
    assertInputChars("limits.patch.maxChars", patch, loadPolicyConfig().limits.patch.maxChars);
    getProject(projectAlias);
    const parsed = parsePatchPaths(patch);
    const expectedFiles = parsed.files.map((relativePath) => {
      let target: string;
      try {
        target = resolveProjectPath(projectAlias, relativePath);
      } catch {
        throw new Error("Patch contains a path that is not allowed");
      }
      if (!existsSync(target)) return { relativePath, exists: false as const };
      try {
        assertCanReadProjectPath(projectAlias, target, relativePath);
      } catch {
        throw new Error("Permission denied: patch path is not readable");
      }
      try {
        const stat = statSync(target);
        return {
          relativePath,
          exists: true as const,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isTextLikely: stat.isFile() ? isTextLikely(target) : false,
          ...(includeHash ? { sha256: hashSha256(readFileSync(target)) } : {})
        };
      } catch {
        throw new Error("Unable to read patch path metadata");
      }
    });
    return {
      projectAlias,
      changedFiles: parsed.files,
      deletedFiles: Array.from(parsed.deleted),
      expectedFiles,
      readyForApply: true
    };
  });
  registerTool(server, "project_apply_patch", "Apply a unified diff patch inside a registered project.", { projectAlias: z.string(), patch: z.string(), dryRun: z.boolean().default(false), expectedFiles: z.array(z.object({ relativePath: z.string(), sha256: z.string().optional(), sizeBytes: z.number().int().nonnegative().optional(), modifiedAt: z.string().optional() })).default([]), conflictPolicy: z.enum(["fail", "attempt-fuzzy"]).default("fail"), confirm: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ projectAlias, patch, dryRun, expectedFiles, conflictPolicy, confirm }) => {
    assertChatGptPermission("writeFiles", projectAlias);
    assertInputChars("limits.patch.maxChars", patch, loadPolicyConfig().limits.patch.maxChars);
    const project = getProject(projectAlias);
    const parsed = parsePatchPaths(patch);
    for (const file of parsed.files) resolveProjectPath(projectAlias, file);
    const expectedByPath = new Map(expectedFiles.map((item) => [item.relativePath, item]));
    for (const file of parsed.files) {
      const target = resolveProjectPath(projectAlias, file);
      if (existsSync(target)) assertCanReadProjectPath(projectAlias, target, file);
      if (existsSync(target) && !expectedByPath.has(file)) {
        throw new Error(`stale_file:${file}:missing_expected_metadata`);
      }
    }
    if (parsed.deleted.size > 0) {
      if (!confirm) throw new Error("Confirmation required: set confirm=true for file deletions");
      assertChatGptPermission("deleteFiles", projectAlias);
    }
    for (const expected of expectedFiles) {
      const target = resolveProjectPath(projectAlias, expected.relativePath);
      if (!existsSync(target)) continue;
      assertCanReadProjectPath(projectAlias, target, expected.relativePath);
      const st = statSync(target);
      if (expected.sizeBytes !== undefined && expected.sizeBytes !== st.size) throw new Error(`stale_file:${expected.relativePath}`);
      if (expected.modifiedAt && expected.modifiedAt !== st.mtime.toISOString()) throw new Error(`stale_file:${expected.relativePath}`);
      ensureExpectedHash(projectAlias, expected.sha256, expected.relativePath);
    }
    const patchPath = path.join(os.tmpdir(), `portus-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
    writeFileSync(patchPath, patch, "utf8");
    try {
      const check = await execFileAsync("git", ["apply", "--check", ...(conflictPolicy === "attempt-fuzzy" ? ["--3way"] : []), patchPath], { cwd: project.rootPath });
      if (!dryRun) stateStore.requireAuditWritable();
      if (!dryRun) await execFileAsync("git", ["apply", ...(conflictPolicy === "attempt-fuzzy" ? ["--3way"] : []), patchPath], { cwd: project.rootPath });
      stateStore.audit({ tool: "project_apply_patch", projectAlias, dryRun, files: parsed.files, deletedFiles: Array.from(parsed.deleted.values()), conflictPolicy });
      return { applied: !dryRun, dryRun, changedFiles: parsed.files, deletedFiles: Array.from(parsed.deleted.values()), patchOutput: `${check.stdout}${check.stderr}`.trim() };
    } catch (error: any) {
      const message = String(error?.stderr ?? error?.message ?? error);
      return { applied: false, errorType: message.includes("does not apply") ? "patch_does_not_apply" : "unknown", message };
    } finally {
      try { rmSync(patchPath, { force: true }); } catch { /* no-op */ }
    }
  });
  registerTool(server, "project_replace_text", "Replace text in a single project file.", { projectAlias: z.string(), relativePath: z.string(), search: z.string(), replace: z.string(), expectedOccurrences: z.number().int().nonnegative().optional(), expectedSha256: z.string().optional(), dryRun: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, search, replace, expectedOccurrences, expectedSha256, dryRun }) => {
    assertChatGptPermission("writeFiles", projectAlias);
    const textEditLimits = loadPolicyConfig().limits.textEdit;
    assertInputChars("limits.textEdit.maxSearchOrMarkerChars", search, textEditLimits.maxSearchOrMarkerChars);
    assertInputChars("limits.textEdit.maxOperationChars", replace, textEditLimits.maxOperationChars);
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    if (!isTextLikely(target)) throw new Error("binary_file");
    if (expectedSha256 && hashSha256(readFileSync(target)) !== expectedSha256) return { ok: false, errorType: "stale_file", message: `${relativePath} changed` };
    const source = readFileSync(target, "utf8");
    const occurrences = source.split(search).length - 1;
    if (expectedOccurrences !== undefined && occurrences !== expectedOccurrences) return { ok: false, errorType: "occurrence_mismatch", expectedOccurrences, actualOccurrences: occurrences };
    const updated = source.split(search).join(replace);
    if (!dryRun) stateStore.requireAuditWritable();
    if (!dryRun) writeFileSync(target, updated, "utf8");
    stateStore.audit({ tool: "project_replace_text", projectAlias, relativePath, occurrences, dryRun });
    return { ok: true, dryRun, occurrences, bytesWritten: Buffer.byteLength(updated, "utf8") };
  });
  registerTool(server, "project_insert_text", "Insert text before or after a marker in one file.", { projectAlias: z.string(), relativePath: z.string(), marker: z.string(), content: z.string(), position: z.enum(["before", "after"]), expectedOccurrences: z.number().int().positive().optional(), expectedSha256: z.string().optional(), dryRun: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, marker, content, position, expectedOccurrences, expectedSha256, dryRun }) => {
    assertChatGptPermission("writeFiles", projectAlias);
    const textEditLimits = loadPolicyConfig().limits.textEdit;
    assertInputChars("limits.textEdit.maxSearchOrMarkerChars", marker, textEditLimits.maxSearchOrMarkerChars);
    assertInputChars("limits.textEdit.maxOperationChars", content, textEditLimits.maxOperationChars);
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    if (expectedSha256 && hashSha256(readFileSync(target)) !== expectedSha256) return { ok: false, errorType: "stale_file" };
    const source = readFileSync(target, "utf8");
    const occurrences = source.split(marker).length - 1;
    if (expectedOccurrences !== undefined && occurrences !== expectedOccurrences) return { ok: false, errorType: "occurrence_mismatch", expectedOccurrences, actualOccurrences: occurrences };
    const updated = position === "before" ? source.replace(marker, `${content}${marker}`) : source.replace(marker, `${marker}${content}`);
    if (!dryRun) stateStore.requireAuditWritable();
    if (!dryRun) writeFileSync(target, updated, "utf8");
    stateStore.audit({ tool: "project_insert_text", projectAlias, relativePath, position, dryRun });
    return { ok: true, dryRun, occurrences, bytesWritten: Buffer.byteLength(updated, "utf8") };
  });
  registerTool(server, "project_create_directory", "Create a directory inside a project.", { projectAlias: z.string(), relativePath: z.string(), recursive: z.boolean().default(true) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, relativePath, recursive }) => {
    assertChatGptPermission("writeFiles", projectAlias);
    stateStore.requireAuditWritable();
    mkdirSync(resolveProjectPath(projectAlias, relativePath), { recursive });
    stateStore.audit({ tool: "project_create_directory", projectAlias, relativePath, recursive });
    return { projectAlias, relativePath, created: true, recursive };
  });
  registerTool(server, "project_delete_directory", "Delete a directory inside a project.", { projectAlias: z.string(), relativePath: z.string(), recursive: z.boolean().default(false), confirm: z.boolean().default(false) }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ projectAlias, relativePath, recursive, confirm }) => {
    if (!confirm) throw new Error("Confirmation required: set confirm=true");
    assertChatGptPermission("deleteFiles", projectAlias);
    const target = resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath);
    stateStore.requireAuditWritable();
    rmSync(target, { recursive, force: false });
    stateStore.audit({ tool: "project_delete_directory", projectAlias, relativePath, recursive });
    return { projectAlias, relativePath, deleted: true, recursive };
  });
  registerTool(server, "project_run_command", "Run one allowlisted command inside a registered project root.", {
    projectAlias: z.string(),
    command: z.string(),
    args: z.array(z.string()).default([]),
    timeoutSecs: z.number().int().positive().max(900).default(120),
    confirm: z.boolean().default(false)
  }, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async ({ projectAlias, command, args, timeoutSecs, confirm }) => {
    assertChatGptCommandAllowed(command, projectAlias);
    assertProjectCommandStaysInProject(command, args);
    const requiresConfirmation = commandRequiresConfirmation(command, args);
    if (requiresConfirmation && !confirm) {
      throw new Error("Confirmation required: set confirm=true");
    }
    stateStore.requireAuditWritable();
    const result = await runProjectCommand(getProject(projectAlias).rootPath, command, args, timeoutSecs);
    stateStore.audit({ tool: "project_run_command", projectAlias, command, args, exitCode: result.exitCode, confirm });
    return { projectAlias, ...result, requiresConfirmation };
  });
  registerTool(server, "project_run_checks", "Use this when ChatGPT needs to run an approved project check script.", { projectAlias: z.string(), scriptName: z.string().default("check"), timeoutSecs: z.number().int().positive().max(900).default(120) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, scriptName, timeoutSecs }) => {
    assertChatGptPermission("runPackageScripts", projectAlias);
    assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json");
    stateStore.requireAuditWritable();
    const result = await runProjectCheck(getProject(projectAlias).rootPath, scriptName, timeoutSecs);
    stateStore.audit({ tool: "project_run_checks", projectAlias, scriptName, exitCode: result.exitCode });
    return { projectAlias, ...result };
  });
  registerTool(server, "project_list_scripts", "List scripts in package.json for a registered project.", { projectAlias: z.string() }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const pkg = resolveProjectPath(projectAlias, "package.json");
    assertCanReadProjectPath(projectAlias, pkg, "package.json");
    const json = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
    return { projectAlias, scripts: Object.keys(json.scripts ?? {}) };
  });
  registerTool(server, "project_run_script", "Run an approved package script in a registered project.", { projectAlias: z.string(), scriptName: z.string(), args: z.array(z.string()).default([]), timeoutSecs: z.number().int().positive().max(900).default(120) }, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, scriptName, args, timeoutSecs }) => {
    assertChatGptPermission("runPackageScripts", projectAlias);
    assertCanReadProjectPath(projectAlias, resolveProjectPath(projectAlias, "package.json"), "package.json");
    stateStore.requireAuditWritable();
    const result = await runProjectScript(getProject(projectAlias).rootPath, scriptName, args, timeoutSecs);
    stateStore.audit({ tool: "project_run_script", projectAlias, scriptName, args, exitCode: result.exitCode });
    return { projectAlias, scriptName, args, ...result };
  });
  registerTool(server, "project_search_symbols", "Search symbols using a text heuristic.", { projectAlias: z.string(), query: z.string(), language: z.string().optional(), maxResults: z.number().int().positive().max(5000).default(100) }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, async ({ projectAlias, query, maxResults }) => {
    assertChatGptPermission("readFiles", projectAlias);
    const root = resolveProjectPath(projectAlias, ".");
    const matches: Array<{ relativePath: string; line: number; text: string }> = [];
    const needle = query.toLowerCase();
    for (const entry of collectPaths(projectAlias, root, loadPolicyConfig().limits.search.maxScanEntries, true, false)) {
      if (matches.length >= maxResults) break;
      if (!canReadProjectRelativePath(projectAlias, entry.relativePath)) continue;
      const target = resolveProjectPath(projectAlias, entry.relativePath);
      if (!isTextLikely(target)) continue;
      const lines = readFileSync(target, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i] ?? "";
        if (!text.toLowerCase().includes(needle)) continue;
        matches.push({ relativePath: entry.relativePath, line: i + 1, text });
        if (matches.length >= maxResults) break;
      }
    }
    return { projectAlias, query, matches, truncated: matches.length >= maxResults };
  });
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame", "describe", "ls-tree", "cat-file"]);
const FORBIDDEN_GIT_REPO_TARGET_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--bare", "--config-env"]);

function assertProjectCommandStaysInProject(command: string, args: string[]): void {
  if (command !== "git") return;
  for (const arg of args) {
    if (FORBIDDEN_GIT_REPO_TARGET_OPTIONS.has(arg) || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      throw new Error(`Git option not allowed for project-scoped command: ${arg}`);
    }
  }
}

function commandRequiresConfirmation(command: string, args: string[]): boolean {
  if (command !== "git") return true;
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  return !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}
