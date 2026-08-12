import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";

const { waitForMcpReady } = await import("../scripts/start-all.mjs");

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/secret/mcp`
  };
}

test("orchestrator waits for the Portus MCP readiness payload", async (t) => {
  let probes = 0;
  const { server, url } = await listen((_request, response) => {
    probes += 1;
    if (probes < 3) {
      response.writeHead(503).end("starting");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: "portus-mcp",
      status: "ok"
    }));
  });
  t.after(() => server.close());

  await waitForMcpReady({ url, timeoutMs: 1_000, retryDelayMs: 5 });
  assert.equal(probes, 3);
});

test("orchestrator readiness probe supports configured bearer authentication", async (t) => {
  const { server, url } = await listen((request, response) => {
    if (request.headers.authorization !== "Bearer readiness-secret") {
      response.writeHead(401).end("unauthorized");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: "portus-mcp",
      status: "ok"
    }));
  });
  t.after(() => server.close());

  await waitForMcpReady({
    url,
    bearerToken: "readiness-secret",
    timeoutMs: 1_000,
    retryDelayMs: 5
  });
});

test("orchestrator fails instead of launching dependents when Portus never becomes ready", async (t) => {
  const { server, url } = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      name: "another-service",
      status: "ok"
    }));
  });
  t.after(() => server.close());

  await assert.rejects(
    waitForMcpReady({ url, timeoutMs: 100, retryDelayMs: 5 }),
    /Timed out waiting for Portus MCP.*unexpected readiness payload/
  );
});
