import { closeSync, createReadStream, Dirent, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { getProject } from "../state/ProjectRegistry.js";
import { stateStore } from "../state/StateStore.js";
import { resolveProjectPath, resolveReadablePath } from "../policy/pathPolicy.js";
import { loadPolicyConfig, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { limitText } from "../runtime/outputLimits.js";
import type { SkillRegistrySnapshot } from "../skills/SkillRegistry.js";
export { registerBroadProjectTools, registerProjectReadTool } from "./projectBroad.js";

const TEXT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".yaml", ".yml", ".toml", ".env", ".html", ".css", ".scss", ".xml", ".sh", ".ps1", ".sql"]);

function resolveReadableTextFile(projectAlias: string, relativePath: string, registry: SkillRegistrySnapshot): string {
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("Path is not allowed");
  }
  let target: string;
  try {
    target = resolveReadablePath(projectAlias, relativePath, registry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matchedAt = message.indexOf(" matched ");
    if (message.startsWith("Blocked path pattern ") && matchedAt !== -1) {
      throw new Error(`${message.slice(0, matchedAt)} matched ${relativePath}`);
    }
    throw error;
  }
  assertCanReadProjectPath(projectAlias, target, relativePath, registry);
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

export async function readProjectTextFile(input: { projectAlias: string; relativePath: string }, registry: SkillRegistrySnapshot) {
  const readLimit = loadPolicyConfig().limits.fileRead.maxChars;
  const target = resolveReadableTextFile(input.projectAlias, input.relativePath, registry);
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


export async function readProjectTextFileRange(input: { projectAlias: string; relativePath: string; startLine?: number; endLine?: number }, registry: SkillRegistrySnapshot) {
  const startLine = input.startLine ?? 1;
  const endLine = input.endLine ?? startLine + 199;
  assertValidLineRange(startLine, endLine);

  const target = resolveReadableTextFile(input.projectAlias, input.relativePath, registry);
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

export async function readProjectBinaryFile(input: { projectAlias: string; relativePath: string }, registry: SkillRegistrySnapshot) {
  if (path.posix.isAbsolute(input.relativePath) || path.win32.isAbsolute(input.relativePath)) {
    throw new Error("Path is not allowed");
  }
  const target = resolveReadablePath(input.projectAlias, input.relativePath, registry);
  assertCanReadProjectPath(input.projectAlias, target, input.relativePath, registry);
  if (!existsSync(target)) throw new Error(`File does not exist: ${input.relativePath}`);
  const info = statSync(target);
  if (!info.isFile()) throw new Error(`Path is not a file: ${input.relativePath}`);
  const limit = loadPolicyConfig().limits.fileRead.maxChars;
  const encodedChars = Math.ceil(info.size / 3) * 4;
  if (encodedChars > limit) {
    throw new Error(`Binary file exceeds the configured read limit: ${input.relativePath}`);
  }
  let contentBase64: string;
  try {
    contentBase64 = readFileSync(target).toString("base64");
  } catch {
    throw new Error(`Unable to read binary file: ${input.relativePath}`);
  }
  return {
    projectAlias: input.projectAlias,
    relativePath: input.relativePath,
    contentBase64,
    encoding: "base64" as const,
    bytes: info.size,
    chars: contentBase64.length,
    limit
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

export class GitIgnoreClassifier {
  private cache = new Map<string, boolean>();
  public gitProcessesSpawned = 0;

  constructor(private projectRoot: string) {}

  isIgnored(target: string): boolean {
    const relativePath = path.relative(this.projectRoot, target).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;

    const parts = relativePath.split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      if (this.cache.get(current) === true) return true;
    }

    if (this.cache.has(relativePath)) {
      return this.cache.get(relativePath)!;
    }

    try {
      this.gitProcessesSpawned += 1;
      execFileSync("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: this.projectRoot, stdio: "ignore" });
      this.cache.set(relativePath, true);
      return true;
    } catch {
      this.cache.set(relativePath, false);
      return false;
    }
  }

  checkBatch(relativePaths: string[]): Set<string> {
    const ignoredSet = new Set<string>();
    const unCached: string[] = [];

    for (const rel of relativePaths) {
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;

      const parts = rel.split("/");
      let current = "";
      let parentIgnored = false;
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i];
        if (this.cache.get(current) === true) {
          ignoredSet.add(rel);
          this.cache.set(rel, true);
          parentIgnored = true;
          break;
        }
      }
      if (parentIgnored) continue;

      if (this.cache.has(rel)) {
        if (this.cache.get(rel) === true) ignoredSet.add(rel);
      } else {
        unCached.push(rel);
      }
    }

    if (unCached.length === 0) return ignoredSet;

    try {
      this.gitProcessesSpawned += 1;
      const output = execFileSync("git", ["check-ignore", "--stdin"], {
        cwd: this.projectRoot,
        input: unCached.join("\n") + "\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"]
      });
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        ignoredSet.add(line);
        this.cache.set(line, true);
      }
      for (const rel of unCached) {
        if (!ignoredSet.has(rel)) {
          this.cache.set(rel, false);
        }
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err && err.stdout) {
        const lines = String(err.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          ignoredSet.add(line);
          this.cache.set(line, true);
        }
      }
      for (const rel of unCached) {
        if (!ignoredSet.has(rel)) {
          this.cache.set(rel, false);
        }
      }
    }

    return ignoredSet;
  }
}

function isGitIgnored(projectRoot: string, target: string, classifier?: GitIgnoreClassifier): boolean {
  if (classifier) return classifier.isIgnored(target);
  return new GitIgnoreClassifier(projectRoot).isIgnored(target);
}

export function assertCanReadProjectPath(projectAlias: string, target: string, relativePath: string, registry?: SkillRegistrySnapshot, classifier?: GitIgnoreClassifier, policy: PortusPolicyConfig = loadPolicyConfig()): void {
  if (registry?.connected.byAlias.has(projectAlias)) return;
  const permissions = policyPermissions(policy).main_agent;
  if (permissions.readGitIgnoredFiles) return;
  if (isGitIgnored(getProject(projectAlias).rootPath, target, classifier)) {
    throw new Error(`Permission denied: readGitIgnoredFiles is false for ignored path: ${relativePath}`);
  }
}

export function canReadProjectRelativePath(projectAlias: string, relativePath: string, registry?: SkillRegistrySnapshot, classifier?: GitIgnoreClassifier, policy: PortusPolicyConfig = loadPolicyConfig()): boolean {
  try {
    const target = registry
      ? resolveReadablePath(projectAlias, relativePath, registry)
      : resolveProjectPath(projectAlias, relativePath);
    assertCanReadProjectPath(projectAlias, target, relativePath, registry, classifier, policy);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipTraversal(rootAlias: string, readableRoot: string, fullPath: string, entryName: string, excludedPatterns: string[], allowGitIgnored: boolean, registry?: SkillRegistrySnapshot, classifier?: GitIgnoreClassifier): boolean {
  const relativePath = path.relative(readableRoot, fullPath).replace(/\\/g, "/");
  const relativeToStateRoot = path.relative(stateStore.root, fullPath);
  if (!relativeToStateRoot || (!relativeToStateRoot.startsWith("..") && !path.isAbsolute(relativeToStateRoot))) return true;
  if (excludedPatterns.some((pattern) => pathMatchesPattern(relativePath, entryName, pattern))) return true;
  if (registry?.connected.byAlias.has(rootAlias)) return false;
  return !allowGitIgnored && isGitIgnored(readableRoot, fullPath, classifier);
}

export type TraversalEntry = { relativePath: string; kind: "file" | "directory"; bytes?: number; modifiedAt?: string };

export type TraversalResult = {
  entries: TraversalEntry[];
  filesVisited: number;
  directoriesVisited: number;
  gitProcessesSpawned: number;
  elapsedMs: number;
  stoppedAtCap: boolean;
  reasons: string[];
};

export function collectPaths(
  projectAlias: string,
  root: string,
  maxEntries: number,
  includeFiles: boolean,
  includeDirs: boolean,
  registry?: SkillRegistrySnapshot,
  includeGitIgnored?: boolean,
  policy: PortusPolicyConfig = loadPolicyConfig()
): TraversalResult {
  const startTime = Date.now();
  const entries: TraversalEntry[] = [];
  const queue = [root];
  const excludedPatterns = getExcludedTraversalPatterns();
  const skill = registry?.connected.byAlias.get(projectAlias);
  const readableRoot = skill?.rootPath ?? getProject(projectAlias).rootPath;
  const policyAllowsGitIgnored = policyPermissions(policy).main_agent.readGitIgnoredFiles;
  if (!skill && includeGitIgnored === true && !policyAllowsGitIgnored) {
    throw new Error("Permission denied: main_agent.readGitIgnoredFiles is false");
  }
  const allowGitIgnored = skill ? true : includeGitIgnored ?? policyAllowsGitIgnored;
  const classifier = allowGitIgnored ? null : new GitIgnoreClassifier(readableRoot);

  let filesVisited = 0;
  let directoriesVisited = 0;
  let stoppedAtCap = false;
  const reasonsSet = new Set<string>();

  while (queue.length > 0) {
    const dir = queue.shift()!;
    directoriesVisited += 1;
    let dirEntries: Dirent[];
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      reasonsSet.add("read_error");
      continue;
    }

    const candidateEntries: { entry: Dirent; full: string; rel: string }[] = [];
    const relPathsToClassify: string[] = [];

    for (let i = 0; i < dirEntries.length; i += 1) {
      const entry = dirEntries[i];
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);
      const rel = path.relative(readableRoot, full).replace(/\\/g, "/") || ".";

      if (excludedPatterns.some((pattern) => pathMatchesPattern(rel, entry.name, pattern))) continue;

      const relativeToStateRoot = path.relative(stateStore.root, full);
      if (!relativeToStateRoot || (!relativeToStateRoot.startsWith("..") && !path.isAbsolute(relativeToStateRoot))) continue;

      candidateEntries.push({ entry, full, rel });
      if (classifier) relPathsToClassify.push(rel);
    }

    const ignoredSet = classifier && relPathsToClassify.length > 0
      ? classifier.checkBatch(relPathsToClassify)
      : new Set<string>();

    for (const { entry, full, rel } of candidateEntries) {
      if (ignoredSet.has(rel)) continue;
      if (!canReadProjectRelativePath(projectAlias, rel, registry, classifier ?? undefined, policy)) continue;

      if (entry.isDirectory()) {
        if (entries.length < maxEntries) {
          if (includeDirs) entries.push({ relativePath: rel, kind: "directory" });
          queue.push(full);
        } else {
          stoppedAtCap = true;
          break;
        }
      } else if (entry.isFile() && includeFiles) {
        filesVisited += 1;
        if (entries.length < maxEntries) {
          const st = statSync(full);
          entries.push({ relativePath: rel, kind: "file", bytes: st.size, modifiedAt: st.mtime.toISOString() });
        } else {
          stoppedAtCap = true;
          break;
        }
      }
    }

    if (stoppedAtCap) break;
  }

  if (queue.length > 0) {
    stoppedAtCap = true;
  }
  if (stoppedAtCap) reasonsSet.add("max_scan_entries");

  return {
    entries,
    filesVisited,
    directoriesVisited,
    gitProcessesSpawned: classifier?.gitProcessesSpawned ?? 0,
    elapsedMs: Date.now() - startTime,
    stoppedAtCap,
    reasons: Array.from(reasonsSet)
  };
}

export function collectSearchableFiles(projectAlias: string, relativePath: string, maxEntries: number, includeGitIgnored = false, policy: PortusPolicyConfig = loadPolicyConfig()): TraversalResult {
  const startedAt = Date.now();
  const root = resolveProjectPath(projectAlias, relativePath);
  if (includeGitIgnored && !policyPermissions(policy).main_agent.readGitIgnoredFiles) {
    throw new Error("Permission denied: main_agent.readGitIgnoredFiles is false");
  }

  const projectRoot = getProject(projectAlias).rootPath;
  const normalizedRelativePath = path.relative(projectRoot, root).replace(/\\/g, "/") || ".";
  const excludedPatterns = getExcludedTraversalPatterns();
  const classifier = includeGitIgnored || normalizedRelativePath === "."
    ? undefined
    : new GitIgnoreClassifier(projectRoot);
  if (normalizedRelativePath !== "." && shouldSkipTraversal(
    projectAlias,
    projectRoot,
    root,
    path.basename(root),
    excludedPatterns,
    includeGitIgnored,
    undefined,
    classifier
  )) {
    return {
      entries: [],
      filesVisited: 0,
      directoriesVisited: 0,
      gitProcessesSpawned: classifier?.gitProcessesSpawned ?? 0,
      elapsedMs: Date.now() - startedAt,
      stoppedAtCap: false,
      reasons: []
    };
  }

  const info = statSync(root);
  if (info.isDirectory()) {
    return collectPaths(projectAlias, root, maxEntries, true, false, undefined, includeGitIgnored, policy);
  }
  if (!info.isFile()) throw new Error(`Search root is not a regular file or directory: ${relativePath}`);
  return {
    entries: [{ relativePath: normalizedRelativePath, kind: "file", bytes: info.size, modifiedAt: info.mtime.toISOString() }],
    filesVisited: 1,
    directoriesVisited: 0,
    gitProcessesSpawned: classifier?.gitProcessesSpawned ?? 0,
    elapsedMs: Date.now() - startedAt,
    stoppedAtCap: false,
    reasons: []
  };
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


const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame", "describe", "ls-tree", "cat-file"]);
const FORBIDDEN_GIT_REPO_TARGET_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--bare", "--config-env"]);

export function assertProjectCommandStaysInProject(command: string, args: string[]): void {
  const baseCommand = command.replace(/\.(bat|cmd|exe)$/i, "").toLowerCase();
  if (baseCommand !== "git") return;
  for (const arg of args) {
    if (FORBIDDEN_GIT_REPO_TARGET_OPTIONS.has(arg) || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      throw new Error(`Git option not allowed for project-scoped command: ${arg}`);
    }
  }
}

export function commandRequiresConfirmation(command: string, args: string[]): boolean {
  const baseCommand = command.replace(/\.(bat|cmd|exe)$/i, "").toLowerCase();
  if (baseCommand !== "git") return true;
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  return !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}
