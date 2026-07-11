import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { upsertProject, listProjects, getProject } from "../state/ProjectRegistry.js";
import { stateStore } from "../state/StateStore.js";
import { resolveProjectPath } from "../policy/pathPolicy.js";
import { loadPolicyConfig } from "../policy/policyConfig.js";
import { assertChatGptPermission } from "../policy/permissionPolicy.js";
import { getEffectivePermissions } from "../state/PermissionRegistry.js";
import { limitText } from "../runtime/outputLimits.js";
import { registerStrictProjectTool } from "./projectToolUtils.js";
export { registerBroadProjectTools } from "./projectBroad.js";

const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".yaml", ".yml", ".toml", ".env", ".html", ".css", ".scss", ".xml", ".sh", ".ps1", ".sql"]);

function resolveReadableTextFile(projectAlias: string, relativePath: string): string {
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

export async function readProjectTextFile(input: { projectAlias: string; relativePath: string }) {
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

function assertValidLineRange(startLine: number, endLine: number): void {
  if (!Number.isInteger(startLine) || startLine <= 0) throw new Error("startLine must be a positive integer");
  if (!Number.isInteger(endLine) || endLine <= 0) throw new Error("endLine must be a positive integer");
  if (endLine < startLine) throw new Error("endLine must be greater than or equal to startLine");
  if (endLine - startLine + 1 > 2000) throw new Error("Requested line range exceeds maximum of 2000 lines");
}


export async function readProjectTextFileRange(input: { projectAlias: string; relativePath: string; startLine?: number; endLine?: number }) {
  const startLine = input.startLine ?? 1;
  const endLine = input.endLine ?? startLine + 199;
  assertValidLineRange(startLine, endLine);

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

export function hashSha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function isTextLikely(filePath: string): boolean {
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

export function assertCanReadProjectPath(projectAlias: string, target: string, relativePath: string): void {
  const permissions = getEffectivePermissions(projectAlias).chatgpt;
  if (permissions.readGitIgnoredFiles) return;
  if (isGitIgnored(getProject(projectAlias).rootPath, target)) {
    throw new Error(`Permission denied: readGitIgnoredFiles is false for ignored path: ${relativePath}`);
  }
}

export function canReadProjectRelativePath(projectAlias: string, relativePath: string): boolean {
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

export function collectPaths(projectAlias: string, root: string, maxEntries: number, includeFiles: boolean, includeDirs: boolean): Array<{ relativePath: string; kind: "file" | "directory"; bytes?: number; modifiedAt?: string }> {
  const out: Array<{ relativePath: string; kind: "file" | "directory"; bytes?: number; modifiedAt?: string }> = [];
  const queue = [root];
  const excludedPatterns = getExcludedTraversalPatterns();
  const projectRoot = getProject(projectAlias).rootPath;
  const allowGitIgnored = getEffectivePermissions(projectAlias).chatgpt.readGitIgnoredFiles;
  while (queue.length > 0 && out.length < maxEntries) {
    const dir = queue.shift()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, full).replace(/\\/g, "/") || ".";
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

export function tokenizeFileSearchQuery(query: string, caseSensitive: boolean): string[] {
  const normalized = caseSensitive ? query.trim() : query.trim().toLowerCase();
  return normalized.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

export function scoreFileSearchPath(relativePath: string, query: string, tokens: string[], caseSensitive: boolean): { score: number; matchedTokens: string[] } {
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

export function ensureExpectedHash(projectAlias: string, expectedSha256: string | undefined, relativePath: string): void {
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

export function parsePatchPaths(patch: string): { files: string[]; deleted: Set<string> } {
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

export function registerProjectManagementTools(server: McpServer): void {
  registerStrictProjectTool(server, "project_register", "Register a local project folder for policy-bounded access.", {
    projectAlias: z.string().min(1),
    rootPath: z.string().min(1)
  }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async ({ projectAlias, rootPath }) => {
    assertChatGptPermission("registerProjects", projectAlias);
    if (!existsSync(rootPath)) throw new Error("Project path does not exist");
    stateStore.requireAuditWritable();
    const record = upsertProject({ projectAlias, rootPath });
    stateStore.audit({ tool: "project_register", projectAlias, rootPath });
    return record;
  });
  registerStrictProjectTool(server, "project_list", "List registered projects.", {}, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }, async () => listProjects());
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame", "describe", "ls-tree", "cat-file"]);
const FORBIDDEN_GIT_REPO_TARGET_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--bare", "--config-env"]);

export function assertProjectCommandStaysInProject(command: string, args: string[]): void {
  if (command !== "git") return;
  for (const arg of args) {
    if (FORBIDDEN_GIT_REPO_TARGET_OPTIONS.has(arg) || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      throw new Error(`Git option not allowed for project-scoped command: ${arg}`);
    }
  }
}

export function commandRequiresConfirmation(command: string, args: string[]): boolean {
  if (command !== "git") return true;
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  return !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}
