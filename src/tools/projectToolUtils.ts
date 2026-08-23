import { z } from "zod";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { asErrorMessage, ToolError } from "../errors.js";

export function safeRelativePath(relativePath: string): string {
  return path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ? "[invalid path]" : relativePath;
}

export function safeError(error: unknown, relativePath?: string): string {
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

export function registerStrictProjectTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: T,
  annotations: ToolAnnotations,
  handler: (args: z.output<z.ZodObject<T, "strict">>) => Promise<unknown>
): void {
  const inputSchema = z.object(shape).strict();
  server.registerTool(name, { description, inputSchema, annotations }, async (args): Promise<CallToolResult> => {
    try {
      const result = await handler(args);
      return {
        structuredContent: { result },
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      const message = asErrorMessage(error);
      return {
        isError: true,
        structuredContent: { error: message },
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }]
      };
    }
  });
}

export type RichToolResult = {
  result: unknown;
  /** Extra native content blocks (e.g. images) appended after the metadata text block. */
  contentBlocks?: CallToolResult["content"];
};

function safeToolDetail(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return safeError(new Error(value));
  if (depth >= 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => safeToolDetail(item, depth + 1));
  if (typeof value !== "object") return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, detail] of Object.entries(value).slice(0, 64)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const sanitized = safeToolDetail(detail, depth + 1);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

export function richToolErrorResult(error: unknown): CallToolResult {
  const message = safeError(error);
  const details = error instanceof ToolError ? safeToolDetail(error.details) : undefined;
  const structuredError = details && typeof details === "object" && !Array.isArray(details)
    ? { ...details, message }
    : { message };
  return {
    isError: true,
    structuredContent: { error: structuredError },
    content: [{ type: "text", text: JSON.stringify({ error: structuredError }, null, 2) }]
  };
}

export function richToolSuccessResult({ result, contentBlocks }: RichToolResult): CallToolResult {
  return {
    structuredContent: { result },
    content: [
      { type: "text", text: JSON.stringify(result, null, 2) },
      ...(contentBlocks ?? [])
    ]
  };
}
