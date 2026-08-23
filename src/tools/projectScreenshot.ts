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
import { assertMainAgentCommandAllowed, assertMainAgentPermission } from "../policy/permissionPolicy.js";
import { getProject } from "../state/ProjectRegistry.js";
import {
  SCREENSHOT_ERROR_CODES,
  ScreenshotError,
  createScreenshotSystem,
  type ScreenshotCapabilities,
  type ScreenshotSystem
} from "../runtime/screenshotSystem.js";
import { startExecutionSession, subscribeExecutionSessionExit, terminateExecutionSession } from "../runtime/executionSessions.js";
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
  operation: z.enum(["targets", "capture", "read", "list", "delete"]).describe("The screenshot operation to perform: targets (list eligible windows), capture (launch and/or save screenshot of session window), read (retrieve image data/metadata), list (paginate saved screenshots), or delete (remove saved screenshot)."),
  projectAlias: projectAliasSchema.describe("Registered project alias owning the execution session or command."),
  command: z.string().min(1).optional().describe("For capture: executable to launch (e.g. 'npm', 'node', 'msedge'). Provide either command or executionSessionId."),
  args: z.array(z.string()).optional().describe("For capture: command arguments when command is provided."),
  shell: z.boolean().optional().describe("For capture: execute command through system shell (requires allowShell policy)."),
  executionSessionId: executionSessionIdSchema.optional().describe("Running execution session identifier owning the target window or captures. Required for targets/read/list/delete; optional for capture when command is provided."),
  closeSession: z.boolean().optional().describe("Required for capture: true to auto-terminate the session/process tree after capture; false to leave it running in background."),
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
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    shell: z.boolean().optional(),
    executionSessionId: executionSessionIdSchema.optional(),
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
  if (input.operation === "capture") {
    if (!input.command && !input.executionSessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capture requires either command or executionSessionId"
      });
    }
    if (input.jpegQuality !== undefined && input.format !== "jpeg") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jpegQuality"],
        message: "jpegQuality requires format=jpeg"
      });
    }
  }
});
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
  return getScreenshotSystem(policy).getCapabilities();
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
      if (args.operation === "targets") {
        const targets = await system.listTargets(args.projectAlias, args.executionSessionId);
        return {
          result: {
            operation: args.operation,
            executionSessionId: args.executionSessionId,
            targets,
            hint: targets.length > 1 ? "Several session-owned windows are eligible; pass one windowId to capture." : undefined
          }
        };
      }

      if (args.operation === "capture") {
        requireConfirmationIfPolicyDemands(policy, "capture", args.confirm);

        let targetSessionId = args.executionSessionId;
        let spawnedSessionId: string | null = null;

        if (args.command) {
          assertMainAgentCommandAllowed(args.command, policy);
          const project = getProject(args.projectAlias);
          const session = await startExecutionSession({
            projectAlias: args.projectAlias,
            rootPath: project.rootPath,
            command: args.command,
            args: args.args,
            policy
          });
          targetSessionId = session.sessionId;
          spawnedSessionId = session.sessionId;
        }

        if (!targetSessionId) {
          throw new ScreenshotError(
            SCREENSHOT_ERROR_CODES.invalidCaptureOptions,
            "capture requires either command or executionSessionId"
          );
        }

        try {
          const capture = await system.capture(args.projectAlias, targetSessionId, {
            closeSession: args.closeSession,
            windowId: args.windowId,
            waitForWindowMs: args.waitForWindowMs ?? (args.command ? 5000 : 0),
            format: args.format,
            jpegQuality: args.jpegQuality,
            maxWidth: args.maxWidth,
            maxHeight: args.maxHeight
          });

          const resultPayload = {
            operation: args.operation,
            executionSessionId: targetSessionId,
            ...capture
          };

          if (args.returnImage !== false) {
            const { data } = await system.read(args.projectAlias, targetSessionId, capture.screenshotId, { audit: false });
            return {
              result: resultPayload,
              contentBlocks: [
                {
                  type: "image" as const,
                  data: data.toString("base64"),
                  mimeType: capture.format === "png" ? "image/png" : "image/jpeg"
                }
              ]
            };
          }
          return { result: { ...resultPayload, returnImage: false } };
        } catch (error) {
          if (spawnedSessionId && args.closeSession) {
            try {
              await terminateExecutionSession(spawnedSessionId);
            } catch {}
          }
          throw error;
        }
      }

      if (args.operation === "read") {
        if (args.returnImage !== false) {
          const { meta, data } = await system.read(args.projectAlias, args.executionSessionId, args.screenshotId);
          return {
            result: { operation: args.operation, ...meta },
            contentBlocks: [
              {
                type: "image" as const,
                data: data.toString("base64"),
                mimeType: meta.format === "png" ? "image/png" : "image/jpeg"
              }
            ]
          };
        }
        const { meta } = await system.read(args.projectAlias, args.executionSessionId, args.screenshotId);
        return { result: { operation: args.operation, ...meta, returnImage: false } };
      }

      if (args.operation === "list") {
        const page = await system.list(args.projectAlias, args.executionSessionId, {
          cursor: args.cursor,
          limit: args.limit
        });
        return { result: { operation: args.operation, ...page } };
      }

      requireConfirmationIfPolicyDemands(policy, "delete", args.confirm);
      await system.deleteScreenshot(args.projectAlias, args.executionSessionId, args.screenshotId);
      return { result: { operation: args.operation, screenshotId: args.screenshotId, deleted: true } };

  };

  server.registerTool(
    "project_screenshot",
    {
      description: "Take and manage screenshots of GUI applications.\n\nOperations:\n- capture: Launches an application to take its screenshot (pass command and args), or captures an already-running app (pass executionSessionId). Set closeSession: true to automatically close the application after taking the screenshot, or closeSession: false to keep it open.\n- read: Retrieve a captured screenshot image or metadata by screenshotId.\n- list: List captured screenshots for an executionSessionId.\n- targets: List window IDs when an application has multiple windows open.\n- delete: Delete a captured screenshot by screenshotId.",
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
