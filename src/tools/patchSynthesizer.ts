import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveProjectPath } from "../policy/pathPolicy.js";

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/i);

export const structuredHunkSchema = z.object({
  old: z.string(),
  new: z.string(),
  contextBefore: z.string().optional(),
  contextAfter: z.string().optional(),
  lineHint: z.number().int().positive().optional()
}).strict();

export type StructuredHunk = z.infer<typeof structuredHunkSchema>;

export const structuredPatchFileSchema = z.object({
  relativePath: z.string().min(1),
  expectedSha256: SHA256_SCHEMA.optional(),
  newFile: z.boolean().optional(),
  deleted: z.boolean().optional(),
  hunks: z.array(structuredHunkSchema).optional(),
  content: z.string().optional()
}).strict().refine(
  (file) => file.deleted === true || (Array.isArray(file.hunks) && file.hunks.length > 0) || typeof file.content === "string",
  { message: "Structured patch file must specify hunks, full content, or deleted: true" }
);

export type StructuredPatchFile = z.infer<typeof structuredPatchFileSchema>;

export const structuredPatchSchema = z.object({
  files: z.array(structuredPatchFileSchema).min(1).max(50)
}).strict();

export type StructuredPatch = z.infer<typeof structuredPatchSchema>;

export const patchInputSchema = z.union([
  z.string().min(1),
  structuredPatchSchema,
  z.array(structuredPatchFileSchema).min(1).max(50)
]);

export type PatchInput = z.infer<typeof patchInputSchema>;

export type SynthesizedPatchResult = {
  unifiedDiff: string;
  files: string[];
  deleted: Set<string>;
};

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function findHunkLocation(
  fileLines: string[],
  hunk: StructuredHunk,
  relativePath: string
): { startLine: number; oldLines: string[]; newLines: string[] } {
  const oldLines = splitLines(hunk.old);
  const newLines = splitLines(hunk.new);
  const contextBeforeLines = hunk.contextBefore !== undefined ? splitLines(hunk.contextBefore) : [];
  const contextAfterLines = hunk.contextAfter !== undefined ? splitLines(hunk.contextAfter) : [];

  if (oldLines.length === 0) {
    throw new Error(`Hunk in ${relativePath} contains empty 'old' content`);
  }

  const matchIndices: number[] = [];

  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j] !== oldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      matchIndices.push(i);
    }
  }

  if (matchIndices.length === 0) {
    throw new Error(`Hunk not found in ${relativePath}: "${hunk.old.slice(0, 80)}"`);
  }

  let resolvedIndex: number | undefined;

  if (matchIndices.length === 1) {
    resolvedIndex = matchIndices[0];
  } else {
    // Try disambiguating with contextBefore
    let candidates = matchIndices;
    if (contextBeforeLines.length > 0) {
      candidates = candidates.filter((idx) => {
        if (idx < contextBeforeLines.length) return false;
        for (let c = 0; c < contextBeforeLines.length; c++) {
          if (fileLines[idx - contextBeforeLines.length + c] !== contextBeforeLines[c]) return false;
        }
        return true;
      });
    }

    // Try disambiguating with contextAfter
    if (candidates.length > 1 && contextAfterLines.length > 0) {
      candidates = candidates.filter((idx) => {
        const afterStart = idx + oldLines.length;
        if (afterStart + contextAfterLines.length > fileLines.length) return false;
        for (let c = 0; c < contextAfterLines.length; c++) {
          if (fileLines[afterStart + c] !== contextAfterLines[c]) return false;
        }
        return true;
      });
    }

    // Try disambiguating with lineHint
    if (candidates.length > 1 && hunk.lineHint !== undefined) {
      const targetZeroIndex = hunk.lineHint - 1;
      candidates.sort((a, b) => Math.abs(a - targetZeroIndex) - Math.abs(b - targetZeroIndex));
      resolvedIndex = candidates[0];
    } else if (candidates.length === 1) {
      resolvedIndex = candidates[0];
    } else {
      throw new Error(`Ambiguous hunk match in ${relativePath}: multiple occurrences found (${candidates.length})`);
    }
  }

  if (resolvedIndex === undefined) {
    throw new Error(`Failed to locate hunk in ${relativePath}`);
  }

  return {
    startLine: resolvedIndex + 1,
    oldLines,
    newLines
  };
}

function synthesizeFileDiff(
  projectAlias: string,
  file: StructuredPatchFile
): { diff: string; relativePath: string; isDeleted: boolean } {
  const normPath = path.posix.normalize(file.relativePath.replace(/\\/g, "/"));
  const targetPath = resolveProjectPath(projectAlias, normPath);

  if (file.deleted === true) {
    if (!existsSync(targetPath)) {
      throw new Error(`File to delete does not exist: ${normPath}`);
    }
    const rawContent = readFileSync(targetPath, "utf8");
    const lines = splitLines(rawContent);
    const lineCount = lines.length;
    const diffLines = [
      `diff --git a/${normPath} b/${normPath}`,
      "deleted file mode 100644",
      `--- a/${normPath}`,
      "+++ /dev/null",
      `@@ -1,${lineCount} +0,0 @@`,
      ...lines.map((l) => `-${l}`)
    ];
    return {
      diff: diffLines.join("\n") + "\n",
      relativePath: normPath,
      isDeleted: true
    };
  }

  if (file.newFile === true || (!existsSync(targetPath) && typeof file.content === "string")) {
    const lines = file.content !== undefined ? splitLines(file.content) : [];
    const lineCount = lines.length;
    const diffLines = [
      `diff --git a/${normPath} b/${normPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${normPath}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...lines.map((l) => `+${l}`)
    ];
    return {
      diff: diffLines.join("\n") + "\n",
      relativePath: normPath,
      isDeleted: false
    };
  }

  if (!existsSync(targetPath)) {
    throw new Error(`File does not exist: ${normPath}`);
  }

  const rawContent = readFileSync(targetPath, "utf8");
  const fileLines = splitLines(rawContent);

  if (typeof file.content === "string" && (!file.hunks || file.hunks.length === 0)) {
    // Full content replacement on existing file
    const newLines = splitLines(file.content);
    const oldLineCount = fileLines.length;
    const newLineCount = newLines.length;
    const diffLines = [
      `diff --git a/${normPath} b/${normPath}`,
      `--- a/${normPath}`,
      `+++ b/${normPath}`,
      `@@ -1,${oldLineCount} +1,${newLineCount} @@`,
      ...fileLines.map((l) => `-${l}`),
      ...newLines.map((l) => `+${l}`)
    ];
    return {
      diff: diffLines.join("\n") + "\n",
      relativePath: normPath,
      isDeleted: false
    };
  }

  if (!file.hunks || file.hunks.length === 0) {
    throw new Error(`No hunks provided for file modification: ${normPath}`);
  }

  // Resolve all hunks against original file content
  const resolvedHunks = file.hunks.map((hunk) => findHunkLocation(fileLines, hunk, normPath));

  // Sort hunks by starting line
  resolvedHunks.sort((a, b) => a.startLine - b.startLine);

  // Validate that hunks do not overlap
  for (let i = 0; i < resolvedHunks.length - 1; i++) {
    const current = resolvedHunks[i]!;
    const next = resolvedHunks[i + 1]!;
    if (current.startLine + current.oldLines.length > next.startLine) {
      throw new Error(`Overlapping hunks in ${normPath} between lines ${current.startLine} and ${next.startLine}`);
    }
  }

  const diffChunks: string[] = [
    `diff --git a/${normPath} b/${normPath}`,
    `--- a/${normPath}`,
    `+++ b/${normPath}`
  ];

  let lineOffset = 0;

  for (const resolved of resolvedHunks) {
    const oldStart = resolved.startLine;
    const oldLength = resolved.oldLines.length;
    const newStart = oldStart + lineOffset;
    const newLength = resolved.newLines.length;

    diffChunks.push(`@@ -${oldStart},${oldLength} +${newStart},${newLength} @@`);
    for (const l of resolved.oldLines) {
      diffChunks.push(`-${l}`);
    }
    for (const l of resolved.newLines) {
      diffChunks.push(`+${l}`);
    }

    lineOffset += (newLength - oldLength);
  }

  return {
    diff: diffChunks.join("\n") + "\n",
    relativePath: normPath,
    isDeleted: false
  };
}

export function synthesizeUnifiedDiff(
  projectAlias: string,
  patchInput: StructuredPatch | StructuredPatchFile[]
): SynthesizedPatchResult {
  const fileList = Array.isArray(patchInput) ? patchInput : patchInput.files;
  const diffParts: string[] = [];
  const files: string[] = [];
  const deleted = new Set<string>();

  for (const file of fileList) {
    const result = synthesizeFileDiff(projectAlias, file);
    diffParts.push(result.diff);
    files.push(result.relativePath);
    if (result.isDeleted) {
      deleted.add(result.relativePath);
    }
  }

  return {
    unifiedDiff: diffParts.join("\n"),
    files,
    deleted
  };
}
