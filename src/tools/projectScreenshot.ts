/**
 * MCP registration for the tenth fixed tool: `project_screenshot`.
 *
 * One registered tool mixing read and mutation operations, so it carries
 * conservative annotations. Every operation requires `projectAlias` and
 * `executionSessionId`; capture and delete honor the selected-policy
 * confirmation requirement. Rich results attach native image blocks for
 * capture/read with `returnImage=true`; base64 never enters JSON or
 * structured content, and PID/native-handle data never leaves the runtime.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { loadScreenshotLimits, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { assertMainAgentPermission } from "../policy/permissionPolicy.js";
import {
  SCREENSHOT_ERROR_CODES,
  ScreenshotError,
  createScreenshotSystem,
  type ScreenshotCapabilities,
  type ScreenshotSystem
} from "../runtime/screenshotSystem.js";
import { subscribeExecutionSessionExit } from "../runtime/executionSessions.js";
import { richToolErrorResult, richToolSuccessResult, type RichToolResult } from "./projectToolUtils.js";

const SCREENSHOT_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const projectAliasSchema = z.string().min(1);
const executionSessionIdSchema = z.string().min(1);

export const projectScreenshotShape = {
  operation: z.enum(["targets", "capture", "read", "list", "delete"]).describe("The screenshot operation to perform: targets (list eligible windows), capture (save screenshot of session window), read (retrieve image data/metadata), list (paginate saved screenshots), or delete (remove saved screenshot)."),
  projectAlias: projectAliasSchema.describe("Registered project alias owning the execution session."),
  executionSessionId: executionSessionIdSchema.describe("Running execution session identifier owning the target window or captures."),
  closeSession: z.boolean().optional().describe("Required for capture: true to terminate the application session/window immediately after capture; false to leave it running."),
  windowId: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("For capture: opaque window token from targets. Optional for single-window sessions."),
  waitForWindowMs: z.number().int().min(0).max(600000).optional().describe("For capture: time in milliseconds to wait for an eligible session window to appear."),
  format: z.enum(["png", "jpeg"]).optional().describe("For capture: output image format (png or jpeg, default png)."),
  jpegQuality: z.number().int().min(1).max(100).optional().describe("For capture: JPEG quality (1-100, requires format=jpeg)."),
  maxWidth: z.number().int().min(1).max(7680).optional().describe("For capture: maximum image width in pixels."),
  maxHeight: z.number().int().min(1).max(7680).optional().describe("For capture: maximum image height in pixels."),
  screenshotId: z.string().min(1).max(64).optional().describe("For read/delete: identifier of the managed screenshot file."),
  cursor: z.string().min(1).max(128).optional().describe("For list: pagination cursor returned from a prior list request."),
  limit: z.number().int().min(1).max(10000).optional().describe("For list: maximum number of screenshots to return in one page."),
  returnImage: z.boolean().optional().describe("For capture/read: whether to return the native image content block (default true)."),
  confirm: z.boolean().optional().describe("For capture/delete: required when policy confirmation is enabled.")
};

/** Top-level object schema advertised to MCP clients (ChatGPT / SDK tools/list). */
export const projectScreenshotInputSchema = z.object(projectScreenshotShape).strict();

/** Strict discriminated union schema enforced during execution. */
export const discriminatedScreenshotSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("targets"),
    projectAlias: projectAliasSchema,
    executionSessionId: executionSessionIdSchema
  }).strict(),
  z.object({
    operation: z.literal("capture"),
    projectAlias: projectAliasSchema,
    executionSessionId: executionSessionIdSchema,
    closeSession: z.boolean(),
    windowId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    waitForWindowMs: z.number().int().min(0).max(600000).optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxWidth: z.number().int().min(1).max(7680).optional(),
    maxHeight: z.number().int().min(1).max(7680).optional(),
    returnImage: z.boolean().optional(),
    confirm: z.boolean().optional()
  }).strict(),
  z.object({
    operation: z.literal("read"),
    projectAlias: projectAliasSchema,
    executionSessionId: executionSessionIdSchema,
    screenshotId: z.string().min(1).max(64),
    returnImage: z.boolean().optional()
  }).strict(),
  z.object({
    operation: z.literal("list"),
    projectAlias: projectAliasSchema,
    executionSessionId: executionSessionIdSchema,
    cursor: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(10000).optional()
  }).strict(),
  z.object({
    operation: z.literal("delete"),
    projectAlias: projectAliasSchema,
    executionSessionId: executionSessionIdSchema,
    screenshotId: z.string().min(1).max(64),
    confirm: z.boolean().optional()
  }).strict()
]).superRefine((input, context) => {
  if (input.operation === "capture" && input.jpegQuality !== undefined && input.format !== "jpeg") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["jpegQuality"],
      message: "jpegQuality requires format=jpeg"
    });
  }
});

// Shared per-process instance so capability projection and tool calls observe
// the same binding-availability cache. Limits come from server-startup policy.
let sharedSystem: ScreenshotSystem | null = null;

export function getScreenshotSystem(policy: PortusPolicyConfig): ScreenshotSystem {
  sharedSystem ??= createScreenshotSystem({
    limits: loadScreenshotLimits(policy),
    subscribeSessionExit: subscribeExecutionSessionExit
  });
  return sharedSystem;
}

/** Warms (once) the cached binding-availability probe without blocking startup. */
export function probeScreenshotBinding(policy: PortusPolicyConfig): void {
  void getScreenshotSystem(policy).ensureBindingAvailability();
}

export function screenshotCapabilityEntry(policy: PortusPolicyConfig): ScreenshotCapabilities | null {
  if (!policyPermissions(policy).main_agent.projectScreenshot) return null;
  return getScreenshotSystem(policy).getCapabilities({ permissionGranted: true });
}

function requireConfirmationIfPolicyDemands(
  policy: PortusPolicyConfig,
  operation: "capture" | "delete",
  confirm: boolean | undefined
): void {
  if (policyPermissions(policy).main_agent.requireConfirmation && confirm !== true) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.confirmationRequired,
      `Confirmation required: ${operation} needs confirm=true under main_agent.permissions.requireConfirmation`
    );
  }
}

export function registerScreenshotTool(
  server: McpServer,
  policy: PortusPolicyConfig,
  system: ScreenshotSystem = getScreenshotSystem(policy)
): void {
  const execute = async (
    args: z.output<typeof discriminatedScreenshotSchema>
  ): Promise<RichToolResult> => {
      assertMainAgentPermission("projectScreenshot", policy);
      const { operation, projectAlias, executionSessionId } = args;

      if (operation === "targets") {
        const targets = await system.listTargets(projectAlias, executionSessionId);
        return {
          result: {
            operation,
            executionSessionId,
            targets,
            hint: targets.length > 1 ? "Several session-owned windows are eligible; pass one windowId to capture." : undefined
          }
        };
      }

      if (operation === "capture") {
        requireConfirmationIfPolicyDemands(policy, "capture", args.confirm);
        const capture = await system.capture(projectAlias, executionSessionId, {
          closeSession: args.closeSession,
          windowId: args.windowId,
          waitForWindowMs: args.waitForWindowMs,
          format: args.format,
          jpegQuality: args.jpegQuality,
          maxWidth: args.maxWidth,
          maxHeight: args.maxHeight
        });
        if (args.returnImage !== false) {
          const { data } = await system.read(projectAlias, executionSessionId, capture.screenshotId, { audit: false });
          return {
            result: { operation, ...capture },
            contentBlocks: [
              {
                type: "image" as const,
                data: data.toString("base64"),
                mimeType: capture.format === "png" ? "image/png" : "image/jpeg"
              }
            ]
          };
        }
        return { result: { operation, ...capture, returnImage: false } };
      }

      if (operation === "read") {
        if (args.returnImage !== false) {
          const { meta, data } = await system.read(projectAlias, executionSessionId, args.screenshotId);
          return {
            result: { operation, ...meta },
            contentBlocks: [
              {
                type: "image" as const,
                data: data.toString("base64"),
                mimeType: meta.format === "png" ? "image/png" : "image/jpeg"
              }
            ]
          };
        }
        const { meta } = await system.read(projectAlias, executionSessionId, args.screenshotId);
        return { result: { operation, ...meta, returnImage: false } };
      }

      if (operation === "list") {
        const page = await system.list(projectAlias, executionSessionId, {
          cursor: args.cursor,
          limit: args.limit
        });
        return { result: { operation, ...page } };
      }

      requireConfirmationIfPolicyDemands(policy, "delete", args.confirm);
      await system.deleteScreenshot(projectAlias, executionSessionId, args.screenshotId);
      return { result: { operation, screenshotId: args.screenshotId, deleted: true } };
  };

  server.registerTool(
    "project_screenshot",
    {
      description: "Visual verification of GUI work: target, capture, read, list, or delete screenshots of windows owned by a selected running execution session. Storage is repository-local under .portus-artifacts/screenshots.",
      inputSchema: projectScreenshotInputSchema,
      annotations: SCREENSHOT_TOOL_ANNOTATIONS
    },
    async (args): Promise<CallToolResult> => {
      try {
        const validated = discriminatedScreenshotSchema.parse(args);
        return richToolSuccessResult(await execute(validated));
      } catch (error) {
        return richToolErrorResult(error);
      }
    }
  );
}
