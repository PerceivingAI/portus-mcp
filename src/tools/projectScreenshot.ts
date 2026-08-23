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
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { loadScreenshotLimits, policyPermissions, type PortusPolicyConfig } from "../policy/policyConfig.js";
import { assertMainAgentPermission } from "../policy/permissionPolicy.js";
import {
  createScreenshotSystem,
  type ScreenshotFormat,
  type ScreenshotSystem
} from "../runtime/screenshotSystem.js";
import { registerStrictProjectToolWithContent } from "./projectToolUtils.js";

const SCREENSHOT_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

// Shared per-process instance so capability projection and tool calls observe
// the same binding-availability cache. Limits come from server-startup policy.
let sharedSystem: ScreenshotSystem | null = null;

export function getScreenshotSystem(policy: PortusPolicyConfig): ScreenshotSystem {
  sharedSystem ??= createScreenshotSystem({ limits: loadScreenshotLimits(policy) });
  return sharedSystem;
}

/** Warms (once) the cached binding-availability probe without blocking startup. */
export function probeScreenshotBinding(policy: PortusPolicyConfig): void {
  void getScreenshotSystem(policy).ensureBindingAvailability();
}

/**
 * Capability entry for project_context projection. Returns null when the
 * permission is not granted; otherwise exposes only operations that are
 * actually usable (capture-related operations drop out when the platform
 * cannot prove session ownership or load the binding).
 */
export function screenshotCapabilityEntry(policy: PortusPolicyConfig): Record<string, unknown> | null {
  if (!policyPermissions(policy).main_agent.projectScreenshot) return null;
  return getScreenshotSystem(policy).getCapabilities({ permissionGranted: true });
}

function requireConfirmationIfPolicyDemands(
  policy: PortusPolicyConfig,
  operation: "capture" | "delete",
  confirm: boolean | undefined
): void {
  if (policyPermissions(policy).main_agent.requireConfirmation && confirm !== true) {
    throw new Error(`Confirmation required: ${operation} needs confirm=true under main_agent.permissions.requireConfirmation`);
  }
}

export function registerScreenshotTool(server: McpServer, policy: PortusPolicyConfig): void {
  const system = getScreenshotSystem(policy);

  const shape = {
    operation: z.enum(["targets", "capture", "read", "list", "delete"]),
    projectAlias: z.string().min(1),
    executionSessionId: z.string().min(1),
    windowId: z.string().min(16).max(128).optional(),
    waitForWindowMs: z.number().int().min(0).max(600000).optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxWidth: z.number().int().min(1).optional(),
    maxHeight: z.number().int().min(1).optional(),
    returnImage: z.boolean().optional(),
    confirm: z.boolean().optional(),
    screenshotId: z.string().min(1).optional(),
    cursor: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(10000).optional()
  };

  registerStrictProjectToolWithContent(
    server,
    "project_screenshot",
    "Visual verification of GUI work: list, capture, read, list, or delete screenshots of windows owned by a selected running execution session. Storage is repository-local under .portus-artifacts/screenshots.",
    shape,
    SCREENSHOT_TOOL_ANNOTATIONS,
    async (args) => {
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
          windowId: args.windowId,
          waitForWindowMs: args.waitForWindowMs,
          format: args.format as ScreenshotFormat | undefined,
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
        return {
          result: { operation, ...capture, returnImage: false }
        };
      }

      if (operation === "read") {
        if (!args.screenshotId) throw new Error("read requires screenshotId");
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

      // delete
      if (!args.screenshotId) throw new Error("delete requires screenshotId");
      requireConfirmationIfPolicyDemands(policy, "delete", args.confirm);
      await system.deleteScreenshot(projectAlias, executionSessionId, args.screenshotId);
      return { result: { operation, screenshotId: args.screenshotId, deleted: true } };
    }
  );
}
