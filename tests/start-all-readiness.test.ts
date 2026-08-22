import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { shouldForwardExternalLogs, startProcess, waitForMcpReady } from "../scripts/start-all.mjs";

test("external service log forwarding is opt-in", () => {
  assert.equal(shouldForwardExternalLogs({}), false);
  assert.equal(shouldForwardExternalLogs({ PORTUS_MCP_FORWARD_EXTERNAL_LOGS: "false" }), false);
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(shouldForwardExternalLogs({ PORTUS_MCP_FORWARD_EXTERNAL_LOGS: value }), true);
  }
});

test("managed processes ignore output only when forwarding is disabled", async () => {
  const silent = startProcess("silent-test", "0", process.execPath, ["-e", ""], {
    forwardOutput: false
  });
  const silentExit = once(silent, "exit");
  assert.equal(silent.stdout, null);
  assert.equal(silent.stderr, null);
  assert.equal((await silentExit)[0], 0);

  const forwarded = startProcess("forwarded-test", "0", process.execPath, ["-e", ""]);
  const forwardedExit = once(forwarded, "exit");
  assert.notEqual(forwarded.stdout, null);
  assert.notEqual(forwarded.stderr, null);
  assert.equal((await forwardedExit)[0], 0);
});

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
    /Timed out waiting for Portus MCP/
  );
});
