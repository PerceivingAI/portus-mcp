import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { asErrorMessage } from "../errors.js";

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
