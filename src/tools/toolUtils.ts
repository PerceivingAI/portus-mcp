import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asErrorMessage } from "../errors.js";

export function registerTool<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: T,
  annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  },
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>
): void {
  server.tool(
    name,
    description,
    schema as any,
    annotations,
    (async (args: unknown): Promise<CallToolResult> => {
      try {
        const result = await handler(args as z.infer<z.ZodObject<T>>);
        return {
          structuredContent: { result },
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          structuredContent: { error: asErrorMessage(error) },
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: asErrorMessage(error) }, null, 2)
            }
          ]
        };
      }
    }) as any
  );
}
