import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PortusPolicyConfig } from "../src/policy/policyConfig.js";
import type { ScreenshotSystem } from "../src/runtime/screenshotSystem.js";

const isolatedRoot = mkdtempSync(path.join(tmpdir(), "portus-screenshot-tool-test-"));
process.env.PORTUS_MCP_STATE_DIR = path.join(isolatedRoot, "state");
process.env.PORTUS_MCP_POLICY_PATH = path.resolve("portus-mcp.policy.json");
process.env.PORTUS_MCP_PROJECTS = `fixture=${path.resolve(".")}`;
const { parsePolicyConfig } = await import("../src/policy/policyConfig.js");
const { SCREENSHOT_ERROR_CODES, ScreenshotError } = await import("../src/runtime/screenshotSystem.js");
const { registerScreenshotTool } = await import("../src/tools/projectScreenshot.js");

const basePolicy = parsePolicyConfig(JSON.parse(readFileSync("portus-mcp.policy.json", "utf8")));
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const screenshotId = "20260822T100000Z_abcdef12.png";

function policyWith(options: { permission?: boolean; confirmation?: boolean } = {}): PortusPolicyConfig {
  return parsePolicyConfig({
    ...basePolicy,
    main_agent: {
      permissions: {
        ...basePolicy.main_agent.permissions,
        projectScreenshot: options.permission ?? true,
        requireConfirmation: options.confirmation ?? false
      }
    }
  });
}

function makeSystem(overrides: Partial<ScreenshotSystem> = {}): ScreenshotSystem {
  return {
    getCapabilities: () => ({
      enabled: true,
      scope: "execution_session_windows",
      operations: ["targets", "capture", "read", "list", "delete"],
      platform: process.platform,
      formats: ["png", "jpeg"],
      captureAvailable: true,
      desktopCapture: false,
      activeWindowCapture: false,
      regionCapture: false
    }),
    ensureBindingAvailability: async () => true,
    refreshBindingAvailability: () => undefined,
    listTargets: async () => [{ windowId: "a".repeat(32), title: "Fixture", appName: "fixture", width: 800, height: 600 }],
    capture: async (_alias, _sid, options) => ({
      screenshotId,
      format: "png",
      width: 800,
      height: 600,
      bytes: imageBytes.length,
      sha256: "hash",
      capturedAt: "2026-08-22T10:00:00.000Z",
      resized: false,
      sessionClosed: options?.closeSession ?? false
    }),
    read: async () => ({
      meta: {
        screenshotId,
        format: "png",
        width: 800,
        height: 600,
        bytes: imageBytes.length,
        capturedAt: "2026-08-22T10:00:00.000Z",
        sha256: "hash"
      },
      data: imageBytes
    }),
    list: async () => ({
      items: [{
        screenshotId,
        format: "png",
        width: 800,
        height: 600,
        bytes: imageBytes.length,
        capturedAt: "2026-08-22T10:00:00.000Z",
        sha256: "hash"
      }],
      nextCursor: null,
      total: 1
    }),
    deleteScreenshot: async () => undefined,
    ...overrides
  };
}

async function createHarness(t: test.TestContext, policy: PortusPolicyConfig, system: ScreenshotSystem) {
  const server = new McpServer({ name: "screenshot-tool-unit", version: "0.1.1" });
  registerScreenshotTool(server, policy, system);
  const client = new Client({ name: "screenshot-tool-unit-client", version: "0.1.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function structuredResult(response: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const result = response.structuredContent?.result;
  assert.ok(result && typeof result === "object" && !Array.isArray(result));
  return result as Record<string, unknown>;
}

test.after(() => rmSync(isolatedRoot, { recursive: true, force: true }));

test("capture returns one native image block and returnImage=false omits it", async (t) => {
  let reads = 0;
  const system = makeSystem({
    read: async (...args) => {
      reads += 1;
      return makeSystem().read(...args);
    }
  });
  const client = await createHarness(t, policyWith(), system);
  const baseArguments = {
    operation: "capture",
    projectAlias: "fixture",
    executionSessionId: "exec_1000_abcdef",
    closeSession: false
  } as const;

  const withImage = await client.callTool({ name: "project_screenshot", arguments: baseArguments });
  const result = structuredResult(withImage);
  assert.equal(result.screenshotId, screenshotId);
  assert.equal("data" in result, false);
  const imageBlocks = withImage.content?.filter((block) => block.type === "image") ?? [];
  assert.equal(imageBlocks.length, 1);
  assert.equal(imageBlocks[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(imageBlocks[0].data, "base64"), imageBytes);

  const withoutImage = await client.callTool({
    name: "project_screenshot",
    arguments: { ...baseArguments, returnImage: false }
  });
  structuredResult(withoutImage);
  assert.equal(withoutImage.content?.some((block) => block.type === "image"), false);
  assert.equal(reads, 1, "metadata-only capture must not re-read image bytes");
});

test("targets, list, read, and delete dispatch only their operation fields", async (t) => {
  const calls: string[] = [];
  const system = makeSystem({
    listTargets: async () => {
      calls.push("targets");
      return makeSystem().listTargets("fixture", "exec_1000_abcdef");
    },
    read: async (...args) => {
      calls.push("read");
      return makeSystem().read(...args);
    },
    list: async (...args) => {
      calls.push("list");
      return makeSystem().list(...args);
    },
    deleteScreenshot: async () => {
      calls.push("delete");
    }
  });
  const client = await createHarness(t, policyWith(), system);
  const scoped = { projectAlias: "fixture", executionSessionId: "exec_1000_abcdef" };

  structuredResult(await client.callTool({ name: "project_screenshot", arguments: { operation: "targets", ...scoped } }));
  structuredResult(await client.callTool({ name: "project_screenshot", arguments: { operation: "list", ...scoped, limit: 10 } }));
  structuredResult(await client.callTool({ name: "project_screenshot", arguments: { operation: "read", ...scoped, screenshotId, returnImage: false } }));
  structuredResult(await client.callTool({ name: "project_screenshot", arguments: { operation: "delete", ...scoped, screenshotId } }));
  assert.deepEqual(calls, ["targets", "list", "read", "delete"]);

  const wrongVariant = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "list", ...scoped, screenshotId }
  });
  assert.equal(wrongVariant.isError, true);
});

test("capture and delete confirmation follow the selected screenshot policy", async (t) => {
  const client = await createHarness(t, policyWith({ confirmation: true }), makeSystem());
  const scoped = { projectAlias: "fixture", executionSessionId: "exec_1000_abcdef" };

  for (const arguments_ of [
    { operation: "capture", ...scoped, closeSession: false },
    { operation: "delete", ...scoped, screenshotId }
  ]) {
    const denied = await client.callTool({ name: "project_screenshot", arguments: arguments_ });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent?.error?.code, SCREENSHOT_ERROR_CODES.confirmationRequired);
  }

  structuredResult(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", ...scoped, closeSession: false, confirm: true, returnImage: false }
  }));
  structuredResult(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "delete", ...scoped, screenshotId, confirm: true }
  }));
});

test("multiple-window capture preserves its stable error code and opaque candidates", async (t) => {
  const candidates = [
    { windowId: "a".repeat(32), title: "First", appName: "fixture", width: 800, height: 600 },
    { windowId: "b".repeat(32), title: "Second", appName: "fixture", width: 640, height: 480 }
  ];
  const system = makeSystem({
    capture: async () => {
      throw new ScreenshotError(
        SCREENSHOT_ERROR_CODES.multipleSessionWindows,
        "Several session-owned windows are eligible; pick a target.",
        { candidates }
      );
    }
  });
  const client = await createHarness(t, policyWith(), system);
  const response = await client.callTool({
    name: "project_screenshot",
    arguments: {
      operation: "capture",
      projectAlias: "fixture",
      executionSessionId: "exec_1000_abcdef",
      closeSession: false,
      returnImage: false
    }
  });

  assert.equal(response.isError, true);
  assert.equal(response.structuredContent?.error?.code, SCREENSHOT_ERROR_CODES.multipleSessionWindows);
  assert.deepEqual(response.structuredContent?.error?.candidates, candidates);
});

test("the dedicated screenshot permission gates every operation", async (t) => {
  const client = await createHarness(t, policyWith({ permission: false }), makeSystem());
  const response = await client.callTool({
    name: "project_screenshot",
    arguments: {
      operation: "targets",
      projectAlias: "fixture",
      executionSessionId: "exec_1000_abcdef"
    }
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.structuredContent), /projectScreenshot/);
});

test("capture requires explicit closeSession boolean", async (t) => {
  let capturedCloseOption: boolean | undefined;
  const system = makeSystem({
    capture: async (_alias, _sid, options) => {
      capturedCloseOption = options?.closeSession;
      return {
        screenshotId,
        format: "png",
        width: 800,
        height: 600,
        bytes: imageBytes.length,
        sha256: "hash",
        capturedAt: "2026-08-22T10:00:00.000Z",
        resized: false,
        sessionClosed: Boolean(options?.closeSession)
      };
    }
  });
  const client = await createHarness(t, policyWith(), system);
  const scoped = { projectAlias: "fixture", executionSessionId: "exec_1000_abcdef" };

  // Missing closeSession is rejected by schema
  const missing = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", ...scoped, returnImage: false }
  });
  assert.equal(missing.isError, true);

  // Non-boolean closeSession is rejected by schema
  const nonBoolean = await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", ...scoped, closeSession: "yes", returnImage: false }
  });
  assert.equal(nonBoolean.isError, true);

  // closeSession: true is passed through and returned
  const closed = structuredResult(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", ...scoped, closeSession: true, returnImage: false }
  }));
  assert.equal(capturedCloseOption, true);
  assert.equal(closed.sessionClosed, true);

  // closeSession: false is passed through and returned
  const kept = structuredResult(await client.callTool({
    name: "project_screenshot",
    arguments: { operation: "capture", ...scoped, closeSession: false, returnImage: false }
  }));
  assert.equal(capturedCloseOption, false);
  assert.equal(kept.sessionClosed, false);
});

test("project_screenshot advertises full input schema properties to MCP clients", async (t) => {
  const client = await createHarness(t, policyWith(), makeSystem());
  const tools = await client.listTools();
  const screenshotToolDef = tools.tools.find((tool) => tool.name === "project_screenshot");
  assert.ok(screenshotToolDef, "project_screenshot must be registered");
  assert.equal(screenshotToolDef.inputSchema.type, "object");
  const rawSchema = screenshotToolDef.inputSchema as { properties?: Record<string, unknown> };
  const properties = rawSchema.properties ?? {};
  const propertyKeys = Object.keys(properties);
  assert.ok(propertyKeys.includes("operation"), "must include operation");
  assert.ok(propertyKeys.includes("projectAlias"), "must include projectAlias");
  assert.ok(propertyKeys.includes("executionSessionId"), "must include executionSessionId");
  assert.ok(propertyKeys.includes("closeSession"), "must include closeSession");
  assert.ok(propertyKeys.includes("format"), "must include format");
  assert.ok(propertyKeys.includes("screenshotId"), "must include screenshotId");
  assert.ok(propertyKeys.length >= 10, `expected rich properties, got: ${propertyKeys.length}`);
});

test("capture supports direct command execution with auto-close (closeSession: true)", async (t) => {
  let capturedSid = "";
  let capturedClose = false;
  const system = makeSystem({
    capture: async (_alias, sid, options) => {
      capturedSid = sid;
      capturedClose = Boolean(options?.closeSession);
      return {
        screenshotId,
        format: "png",
        width: 800,
        height: 600,
        bytes: imageBytes.length,
        sha256: "hash",
        capturedAt: "2026-08-22T10:00:00.000Z",
        resized: false,
        sessionClosed: true
      };
    }
  });
  const client = await createHarness(t, policyWith(), system);
  const response = await client.callTool({
    name: "project_screenshot",
    arguments: {
      operation: "capture",
      projectAlias: "fixture",
      command: "git",
      args: ["status"],
      closeSession: true,
      returnImage: false
    }
  });
  const result = structuredResult(response);
  assert.ok(capturedSid.startsWith("exec_"));
  assert.equal(capturedClose, true);
  assert.equal(result.sessionClosed, true);
});

test("capture with direct command rejects disallowed command under policy", async (t) => {
  const client = await createHarness(t, policyWith(), makeSystem());
  const response = await client.callTool({
    name: "project_screenshot",
    arguments: {
      operation: "capture",
      projectAlias: "fixture",
      command: "forbidden-binary",
      closeSession: true,
      returnImage: false
    }
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.structuredContent), /allowedCommands/);
});

test("capture rejects when neither command nor executionSessionId is provided", async (t) => {
  const client = await createHarness(t, policyWith(), makeSystem());
  const response = await client.callTool({
    name: "project_screenshot",
    arguments: {
      operation: "capture",
      projectAlias: "fixture",
      closeSession: true,
      returnImage: false
    }
  });
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.structuredContent), /either command or executionSessionId/);
});
