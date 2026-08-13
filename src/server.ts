import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { optionalEnv } from "./env.js";
import { loadPolicyConfig, type PortusPolicyConfig } from "./policy/policyConfig.js";
import { registerBroadProjectTools } from "./tools/projectBroad.js";
import { registerSubagentTools } from "./tools/subagents.js";
import { registerBroadPolicyTools } from "./tools/config.js";
import { readSessionEvents } from "./state/SessionEvents.js";
import { connectedSkillInstructions, loadSkillRegistry } from "./skills/SkillRegistry.js";
import type { SkillRegistrySnapshot } from "./skills/SkillRegistry.js";

const PROJECT_DISCOVERY_INSTRUCTIONS = "Discover registered projects with project_context using include.projects=true. After selecting a project alias, call scoped project_context; capabilities.availableTools is the complete effective tool allowlist, and registered tools absent from it must not be invoked.";

export type PolicyProvider = () => PortusPolicyConfig;

export function createMcpServer(
  skillRegistry: SkillRegistrySnapshot = loadSkillRegistry(),
  policy: PortusPolicyConfig = loadPolicyConfig()
): McpServer {
  const server = new McpServer({
    name: "portus-mcp",
    version: "0.1.1"
  }, {
    instructions: `${PROJECT_DISCOVERY_INSTRUCTIONS}\n${connectedSkillInstructions(skillRegistry)}`
  });
  registerBroadProjectTools(server, skillRegistry, policy);
  registerBroadPolicyTools(server, policy);
  registerSubagentTools(server, skillRegistry, policy);

  return server;
}

export function extractTailscaleUser(headers: IncomingMessage["headers"]): { userLogin?: string; userName?: string } {
  const userLoginHeader = headers["tailscale-user-login"];
  const userNameHeader = headers["tailscale-user-name"];

  const userLogin = Array.isArray(userLoginHeader) ? userLoginHeader[0] : userLoginHeader;
  const userName = Array.isArray(userNameHeader) ? userNameHeader[0] : userNameHeader;

  return {
    ...(userLogin?.trim() ? { userLogin: userLogin.trim() } : {}),
    ...(userName?.trim() ? { userName: userName.trim() } : {})
  };
}

export function createHttpServer(
  mcpPath = optionalEnv("PORTUS_MCP_PATH", "/mcp"),
  policyProvider: PolicyProvider = loadPolicyConfig
) {
  policyProvider();
  const skillRegistry = loadSkillRegistry();
  const bearerToken = optionalEnv("PORTUS_MCP_BEARER_TOKEN", "").trim();

  const hasValidBearerToken = (authorization: string | undefined): boolean => {
    if (!bearerToken) return true;
    const prefix = "Bearer ";
    if (!authorization?.startsWith(prefix)) return false;
    const suppliedToken = authorization.slice(prefix.length).trim();
    const expected = Buffer.from(bearerToken);
    const supplied = Buffer.from(suppliedToken);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const isMcpRoute = url.pathname === mcpPath || url.pathname.startsWith(`${mcpPath}/`);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization, last-event-id, tailscale-user-login, tailscale-user-name",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-session-id"
  };
  if (req.method === "OPTIONS" && isMcpRoute) {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: "portus-mcp",
      mcp: mcpPath,
      status: "ok"
    }, null, 2));
    return;
  }

  if (isMcpRoute && !hasValidBearerToken(req.headers.authorization)) {
    res.writeHead(401, {
      ...corsHeaders,
      "content-type": "text/plain",
      "www-authenticate": "Bearer"
    }).end("Bearer token required for this Portus MCP server.");
    return;
  }

  if (isMcpRoute && req.method === "GET" && url.pathname === `${mcpPath}/events`) {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { ...corsHeaders, "content-type": "text/plain" }).end("Missing sessionId");
      return;
    }
    let afterSequence = Number(url.searchParams.get("afterSequence") ?? req.headers["last-event-id"] ?? "0");
    if (!Number.isInteger(afterSequence) || afterSequence < 0) afterSequence = 0;
    res.writeHead(200, {
      ...corsHeaders,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const sendEvents = () => {
      try {
        const page = readSessionEvents({ sessionId, afterSequence });
        for (const event of page.events) {
          res.write(`id: ${event.sequence}\n`);
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          afterSequence = event.sequence;
        }
      } catch (error) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
      }
    };
    sendEvents();
    const interval = setInterval(sendEvents, 1000);
    res.on("close", () => clearInterval(interval));
    return;
  }

  if (isMcpRoute && req.method === "GET" && !String(req.headers.accept ?? "").includes("text/event-stream")) {
    res.writeHead(200, {
      ...corsHeaders,
      "content-type": "application/json"
    }).end(JSON.stringify({
      name: "portus-mcp",
      mcp: mcpPath,
      status: "ok",
      note: "Use POST with JSON-RPC or GET with Accept: text/event-stream for MCP."
    }, null, 2));
    return;
  }

  if (isMcpRoute && req.method && ["GET", "POST", "DELETE"].includes(req.method)) {
    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value);
    }

    if (req.method === "POST") {
      const rawAccept = String(req.headers.accept ?? "").trim();
      let normalizedAccept = rawAccept;
      if (!normalizedAccept.includes("application/json")) {
        normalizedAccept = normalizedAccept ? `${normalizedAccept}, application/json` : "application/json";
      }
      if (!normalizedAccept.includes("text/event-stream")) {
        normalizedAccept = `${normalizedAccept}, text/event-stream`;
      }
      req.headers.accept = normalizedAccept;
      let foundInRaw = false;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "accept") {
          req.rawHeaders[i + 1] = normalizedAccept;
          foundInRaw = true;
          break;
        }
      }
      if (!foundInRaw) {
        req.rawHeaders.push("accept", normalizedAccept);
      }
    }
    const server = createMcpServer(skillRegistry, policyProvider());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});
}

export function startServer(): void {
  const host = optionalEnv("PORTUS_MCP_HOST", "127.0.0.1");
  const port = Number(optionalEnv("PORTUS_MCP_PORT", "8789"));
  const mcpPath = optionalEnv("PORTUS_MCP_PATH", "/mcp");
  createHttpServer(mcpPath).listen(port, host, () => {
    console.log(`portus-mcp MCP server listening on http://${host}:${port}${mcpPath}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}

