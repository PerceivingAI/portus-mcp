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
import { createAppDiscovery, type AppDiscovery } from "../runtime/appDiscovery.js";
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
  operation: z.enum(["app_discovery", "discover_running", "capture_launch", "capture_running", "read", "list", "delete"]).describe("The screenshot operation to perform: app_discovery (list configured apps found on this machine), discover_running (list eligible windows for running session), capture_launch (launch command and save screenshot), capture_running (save screenshot of existing running session), read (retrieve image data/metadata), list (paginate saved screenshots), or delete (remove saved screenshot)."),
  projectAlias: projectAliasSchema.describe("Registered project alias owning the execution session or command."),
  command: z.string().min(1).optional().describe("For capture_launch: executable to launch (e.g. 'npm', 'node', 'msedge')."),
  args: z.array(z.string()).optional().describe("For capture_launch: command arguments when command is provided."),
  shell: z.boolean().optional().describe("For capture_launch: execute command through system shell (requires allowShell policy)."),
  executionSessionId: executionSessionIdSchema.optional().describe("Running execution session identifier owning the target window or captures. Required for discover_running/capture_running/read/list/delete."),
  closeSession: z.boolean().optional().describe("Required for capture_launch and capture_running: true to auto-terminate the session/process tree after capture; false to leave it running in background."),
  windowId: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("For capture_running: opaque window token from discover_running. Optional for single-window sessions."),
  waitForWindowMs: z.number().int().min(0).max(600000).optional().describe("For capture_launch and capture_running: time in milliseconds to wait for an eligible session window to appear."),
  format: z.enum(["png", "jpeg"]).optional().describe("For capture_launch/capture_running: output image format (png or jpeg, default png)."),
  jpegQuality: z.number().int().min(1).max(100).optional().describe("For capture_launch/capture_running: JPEG quality (1-100, requires format=jpeg)."),
  maxWidth: z.number().int().min(1).max(7680).optional().describe("For capture_launch/capture_running: maximum image width in pixels."),
  maxHeight: z.number().int().min(1).max(7680).optional().describe("For capture_launch/capture_running: maximum image height in pixels."),
  screenshotId: z.string().min(1).max(64).optional().describe("For read/delete: identifier of the managed screenshot file."),
  cursor: z.string().min(1).max(128).optional().describe("For list: pagination cursor returned from a prior list request."),
  limit: z.number().int().min(1).max(10000).optional().describe("For list: maximum number of screenshots to return in one page."),
  returnImage: z.boolean().optional().describe("For capture_launch/capture_running/read: whether to return the native image content block (default true)."),
  confirm: z.boolean().optional().describe("For capture_launch/capture_running/delete: required when policy confirmation is enabled.")
};

/** Top-level object schema advertised to MCP clients (ChatGPT / SDK tools/list). */
export const projectScreenshotInputSchema = z.object(projectScreenshotShape).strict();

/** Strict discriminated union schema enforced during execution. */
export const discriminatedScreenshotSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("app_discovery"),
    projectAlias: projectAliasSchema
  }).strict(),
  z.object({
    operation: z.literal("discover_running"),
    projectAlias: projectAliasSchema,
    executionSessionId: executionSessionIdSchema
  }).strict(),
  z.object({
    operation: z.literal("capture_launch"),
    projectAlias: projectAliasSchema,
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    shell: z.boolean().optional(),
    closeSession: z.boolean(),
    waitForWindowMs: z.number().int().min(0).max(600000).optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxWidth: z.number().int().min(1).max(7680).optional(),
    maxHeight: z.number().int().min(1).max(7680).optional(),
    returnImage: z.boolean().optional(),
    confirm: z.boolean().optional()
  }).strict(),
  z.object({
    operation: z.literal("capture_running"),
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
  if (input.operation === "capture_launch" || input.operation === "capture_running") {
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
  operation: "capture_launch" | "capture_running" | "delete",
  confirm: boolean | undefined
): void {
  if (policyPermissions(policy).main_agent.requireConfirmation && confirm !== true) {
    throw new ScreenshotError(
      SCREENSHOT_ERROR_CODES.confirmationRequired,
      `Confirmation required: ${operation} needs confirm=true under main_agent.permissions.requireConfirmation`
    );
  }
}

export type ScreenshotToolDependencies = {
  system?: ScreenshotSystem;
  appDiscovery?: AppDiscovery;
  startSession?: typeof startExecutionSession;
};

export function registerScreenshotTool(
  server: McpServer,
  policy: PortusPolicyConfig,
  dependencies: ScreenshotToolDependencies = {}
): void {
  const system = dependencies.system ?? getScreenshotSystem(policy);
  const appDiscovery = dependencies.appDiscovery ?? createAppDiscovery();
  const startSession = dependencies.startSession ?? startExecutionSession;
  const execute = async (
    args: z.output<typeof discriminatedScreenshotSchema>
  ): Promise<RichToolResult> => {
      assertMainAgentPermission("projectScreenshot", policy);
      if (args.operation === "app_discovery") {
        getProject(args.projectAlias);
        const apps = await appDiscovery.discover(policy.screenshot.appDiscovery);
        return { result: { operation: args.operation, apps } };
      }
      if (args.operation === "discover_running") {
        const targets = await system.listTargets(args.projectAlias, args.executionSessionId);
        return {
          result: {
            operation: args.operation,
            executionSessionId: args.executionSessionId,
            targets,
            hint: targets.length > 1 ? "Several session-owned windows are eligible; pass one windowId to capture_running." : undefined
          }
        };
      }

      if (args.operation === "capture_launch") {
        requireConfirmationIfPolicyDemands(policy, "capture_launch", args.confirm);
        const resolution = await appDiscovery.resolveConfigured(args.command, policy.screenshot.appDiscovery);
        let executablePath: string | undefined;
        if (resolution.configured) {
          if (args.shell === true) {
            throw new ScreenshotError(
              SCREENSHOT_ERROR_CODES.invalidCaptureOptions,
              "Configured apps must be launched directly without a shell."
            );
          }
          if (resolution.executablePath === null) {
            throw new ScreenshotError(
              SCREENSHOT_ERROR_CODES.appNotFound,
              `Configured app could not be found: ${args.command}`,
              { command: args.command }
            );
          }
          executablePath = resolution.executablePath;
        } else {
          assertMainAgentCommandAllowed(args.command, policy);
        }

        const project = getProject(args.projectAlias);
        const session = await startSession({
          projectAlias: args.projectAlias,
          rootPath: project.rootPath,
          command: args.command,
          executablePath,
          args: args.args,
          shell: args.shell,
          policy
        });

        try {
          const capture = await system.capture(args.projectAlias, session.sessionId, {
            closeSession: args.closeSession,
            waitForWindowMs: args.waitForWindowMs ?? 5000,
            format: args.format,
            jpegQuality: args.jpegQuality,
            maxWidth: args.maxWidth,
            maxHeight: args.maxHeight
          });

          const resultPayload = {
            operation: args.operation,
            executionSessionId: session.sessionId,
            ...capture
          };

          if (args.returnImage !== false) {
            const { data } = await system.read(args.projectAlias, session.sessionId, capture.screenshotId, { audit: false });
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
          if (args.closeSession) {
            try {
              await terminateExecutionSession(session.sessionId);
            } catch {}
          }
          throw error;
        }
      }

      if (args.operation === "capture_running") {
        requireConfirmationIfPolicyDemands(policy, "capture_running", args.confirm);
        const capture = await system.capture(args.projectAlias, args.executionSessionId, {
          closeSession: args.closeSession,
          windowId: args.windowId,
          waitForWindowMs: args.waitForWindowMs ?? 0,
          format: args.format,
          jpegQuality: args.jpegQuality,
          maxWidth: args.maxWidth,
          maxHeight: args.maxHeight
        });

        const resultPayload = {
          operation: args.operation,
          executionSessionId: args.executionSessionId,
          ...capture
        };

        if (args.returnImage !== false) {
          const { data } = await system.read(args.projectAlias, args.executionSessionId, capture.screenshotId, { audit: false });
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
      description: "Take and manage screenshots of GUI applications.\n\nOperations:\n- app_discovery: List apps available for quick screenshot launch. Pass a returned app name as capture_launch.command.\n- discover_running: List the windows available for capture from a running execution session.\n- capture_launch: Launch an app and capture its window. Pass command, optional args, and required closeSession. Set closeSession: true by default, which closes the launched app after capture. Use closeSession: false ONLY when the user or workflow requires the app to remain open.\n- capture_running: Capture a window from an existing execution session. Pass executionSessionId, optional windowId, and required closeSession. Set closeSession: true by default if you created the session for verification. Set closeSession: false when the session was already running before inspection. User instructions and workflow requirements override these defaults.\n- read: Retrieve a captured screenshot or its metadata by screenshotId.\n- list: List screenshots captured for an execution session.\n- delete: Delete a captured screenshot by screenshotId.",
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
