import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { waitForMcpReady } from "../scripts/start-all.mjs";

async function reservePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function ownedOrigin(t: TestContext, { token = "", validPayload = true, wrongAck = false } = {}) {
  const port = await reservePort();
  const source = `
    const http=require('node:http');
    const server=http.createServer((req,res)=>{
      if(${JSON.stringify(token)} && req.headers.authorization!==${JSON.stringify(`Bearer ${token}`)}) return res.writeHead(401).end();
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(${JSON.stringify(validPayload ? {name:"portus-mcp",status:"ok"} : {name:"other-service",status:"ok"})}));
    });
    server.listen(${port},'127.0.0.1',()=>process.send({type:'portus-mcp:listening',pid:process.pid${wrongAck ? "+1" : ""},host:'127.0.0.1',port:${port},mcpPath:'/private/mcp'}));
  `;
  const child = spawn(process.execPath,["-e",source],{stdio:["ignore","ignore","ignore","ipc"]});
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child.once("close",() => resolve()));
    child.kill();
    await closed;
  });
  return {child,url:`http://127.0.0.1:${port}/private/mcp`};
}

test("owned listener acknowledgement plus authenticated health confirms readiness", async t => {
  const {child,url} = await ownedOrigin(t,{token:"readiness-secret"});
  await waitForMcpReady({child,url,bearerToken:"readiness-secret",timeoutMs:3000});
});

test("owned readiness still rejects incorrect authentication", async t => {
  const {child,url} = await ownedOrigin(t,{token:"readiness-secret"});
  await assert.rejects(waitForMcpReady({child,url,bearerToken:"wrong",timeoutMs:3000}),/HTTP 401/);
});

test("a different payload or child identity cannot confirm owned readiness", async t => {
  const first = await ownedOrigin(t,{validPayload:false});
  await assert.rejects(waitForMcpReady({...first,timeoutMs:3000}),/not confirmed/);
  const second = await ownedOrigin(t,{wrongAck:true});
  await assert.rejects(waitForMcpReady({...second,timeoutMs:3000}),/different bound endpoint/);
});

test("an HTTP endpoint alone cannot supply process ownership", async () => {
  await assert.rejects(waitForMcpReady({url:"http://127.0.0.1:8789/mcp"}),/private IPC channel/);
});
