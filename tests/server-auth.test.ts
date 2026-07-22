import test from "node:test";
import assert from "node:assert/strict";

const { createHttpServer } = await import("../src/server.js");

async function listenWithToken(token: string | undefined) {
  const original = process.env.PORTUS_MCP_BEARER_TOKEN;
  if (token === undefined) {
    delete process.env.PORTUS_MCP_BEARER_TOKEN;
  } else {
    process.env.PORTUS_MCP_BEARER_TOKEN = token;
  }
  const server = createHttpServer("/mcp");
  if (original === undefined) {
    delete process.env.PORTUS_MCP_BEARER_TOKEN;
  } else {
    process.env.PORTUS_MCP_BEARER_TOKEN = original;
  }

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert(address && "port" in address);
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

test("MCP routes do not require bearer auth when token is unset", async (t) => {
  const { server, baseUrl } = await listenWithToken(undefined);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/mcp`);
  assert.equal(response.status, 200);
  const body = await response.json() as { name: string; status: string };
  assert.equal(body.name, "portus-mcp");
  assert.equal(body.status, "ok");
});

test("MCP routes require bearer auth when token is configured", async (t) => {
  const { server, baseUrl } = await listenWithToken("test-secret-token");
  t.after(() => server.close());

  const missing = await fetch(`${baseUrl}/mcp`);
  assert.equal(missing.status, 401);
  assert.equal(await missing.text(), "Bearer token required for this Portus MCP server.");

  const wrong = await fetch(`${baseUrl}/mcp`, {
    headers: { authorization: "Bearer wrong-token" }
  });
  assert.equal(wrong.status, 401);

  const valid = await fetch(`${baseUrl}/mcp`, {
    headers: { authorization: "Bearer test-secret-token" }
  });
  assert.equal(valid.status, 200);
  const body = await valid.json() as { name: string; status: string };
  assert.equal(body.name, "portus-mcp");
  assert.equal(body.status, "ok");
});

test("MCP CORS preflight remains open when bearer auth is configured", async (t) => {
  const { server, baseUrl } = await listenWithToken("test-secret-token");
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-headers")?.includes("authorization"), true);
});

test("root health endpoint is not bearer-gated", async (t) => {
  const { server, baseUrl } = await listenWithToken("test-secret-token");
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const body = await response.json() as { name: string; status: string };
  assert.equal(body.name, "portus-mcp");
  assert.equal(body.status, "ok");
});
test("MCP POST route normalizes Accept header to support clients like Perplexity", async (t) => {
  const { server, baseUrl } = await listenWithToken(undefined);
  t.after(() => server.close());

  const initPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }
  });

  // Perplexity-style Accept header (application/json only)
  const jsonOnly = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: initPayload
  });
  assert.equal(jsonOnly.status, 200);
  const jsonOnlyBody = await jsonOnly.json() as { jsonrpc: string; id: number };
  assert.equal(jsonOnlyBody.jsonrpc, "2.0");
  assert.equal(jsonOnlyBody.id, 1);

  // Default fetch / missing Accept header
  const noAccept = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: initPayload
  });
  assert.equal(noAccept.status, 200);

  // tunnel-client style Accept header (both application/json and text/event-stream)
  const bothAccept = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: initPayload
  });
  assert.equal(bothAccept.status, 200);
});
