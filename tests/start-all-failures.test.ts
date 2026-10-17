import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer, createConnection } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createStandaloneLauncher, startProcess } from "../scripts/start-all.mjs";
import { cleanupExitedWindowsTree } from "../src/runtime/processTermination.js";

const root = process.cwd();
const listenerSchema = z.object({port:z.number().int().positive()});
type ManagedOptions = {env:NodeJS.ProcessEnv; forwardOutput:boolean; processGroup:boolean; expectedExit:()=>boolean};

async function fixture(t:TestContext, {unverified = false} = {}) {
  const reservation = createNetServer();
  await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));
  const address = reservation.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve,reject)=>reservation.close(error=>error ? reject(error) : resolve()));
  const temp = mkdtempSync(path.join(root,".portus-f3-"));
  mkdirSync(path.join(temp,"skills"));
  const env:NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  Object.assign(env,{
    DOTENV_CONFIG_PATH:path.join(temp,"absent.env"),PORTUS_MCP_HOST:"127.0.0.1",PORTUS_MCP_PORT:String(address.port),
    PORTUS_MCP_PATH:"/f3/mcp",PORTUS_MCP_BEARER_TOKEN:"f3-isolated-token",
    PORTUS_MCP_CONFIG_PATH:path.join(root,"portus-mcp.config.json"),PORTUS_MCP_POLICY_PATH:path.join(root,"portus-mcp.policy.json"),
    PORTUS_MCP_STATE_DIR:path.join(temp,"state"),AGENT_SKILL_PATHS:path.join(temp,"skills"),SUBAGENTS_SKILL_PATHS:path.join(temp,"skills")
  });
  let launched = 0;
  let informReady:(value:z.infer<typeof listenerSchema>)=>void = ()=>{};
  const ready = new Promise<z.infer<typeof listenerSchema>>(resolve=>{informReady=resolve;});
  const launcher = createStandaloneLauncher({env,
    ...(unverified ? {cleanupExited:async()=>({confirmed:false,terminated:0,unverified:1,remaining:0})} : {}),
    launchTunnel:(_binary:string,_args:string[],options:ManagedOptions)=>{
      launched++;
      const source = `const s=require('node:http').createServer((q,r)=>r.end('owned-external'));process.on('message',m=>{if(Number.isInteger(m.exit))process.exit(m.exit);});s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));`;
      const child = startProcess("f3-fixture","0",process.execPath,["-e",source],{...options,ipc:true});
      child.on("message",(message:unknown)=>{const parsed=listenerSchema.safeParse(message);if(parsed.success)informReady(parsed.data);});
      return child;
    }
  });
  t.after(async()=>{
    try { await launcher.stop(); }
    catch(error) { if(!unverified || (await launcher.completion).cleanup !== "unverified") throw error; }
    finally { rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
  });
  return {launcher,ready,env,launchCount:()=>launched};
}

async function closedPort(port:number) {
  // Bound real socket I/O, not a guessed cleanup sleep or a pooled HTTP request.
  await new Promise<void>((resolve,reject)=>{
    const socket = createConnection({host:"127.0.0.1",port});
    socket.setTimeout(1000);
    socket.once("connect",()=>{socket.destroy();reject(new Error("Owned listener is still accepting connections."));});
    socket.once("timeout",()=>{socket.destroy();reject(new Error("Listener closure could not be established."));});
    socket.once("error",error=>{socket.destroy();if("code" in error && error.code === "ECONNREFUSED")resolve();else reject(error);});
  });
}

for(const kind of ["zero","signal"] as const) {
  test(`unexpected external ${kind} exit is terminal, bounded, and never respawned`,{timeout:15000},async t=>{
    const f = await fixture(t);
    const running = await f.launcher.start();
    const listener = await f.ready;
    const injectedAt = Date.now();
    if(kind === "zero") running.external.send({exit:0});
    else running.external.kill("SIGTERM");
    const terminal = await f.launcher.completion;
    assert.equal(terminal.state,"failed");
    assert.equal(terminal.exitCode,1);
    assert.equal(terminal.cleanup,"confirmed");
    assert.match(terminal.reason,kind === "zero" ? /tunnel service exited unexpectedly \(exit 0\)/ : /tunnel service exited unexpectedly/);
    const detectionMs = terminal.failureDetectedAt - injectedAt;
    const cleanupMs = Date.now() - terminal.failureDetectedAt;
    assert(detectionMs >= 0 && detectionMs <= 5000);
    assert(cleanupMs <= 5000,"owned teardown has a separate five-second ceiling");
    t.diagnostic(JSON.stringify({fault:`external-${kind}`,detectionMs,cleanupMs,state:terminal.state,exitCode:terminal.exitCode,cleanup:terminal.cleanup}));
    await f.launcher.stop();
    assert.equal(f.launcher.state,"failed","manual stop cannot turn an actual failure into success");
    assert.equal(f.launchCount(),1);
    await closedPort(Number(f.env.PORTUS_MCP_PORT));
    await closedPort(listener.port);
  });
}

test("backend loss stops owned external service, preserves unrelated service, and cannot recover implicitly",{timeout:15000},async t=>{
  const borrowed = createHttpServer((_req,res)=>res.end("borrowed-survived"));
  await new Promise<void>(resolve=>borrowed.listen(0,"127.0.0.1",resolve));
  const address = borrowed.address();
  assert(address && typeof address === "object");
  t.after(()=>{borrowed.closeAllConnections();borrowed.close();});
  const f = await fixture(t);
  const running = await f.launcher.start();
  const listener = await f.ready;
  const injectedAt = Date.now();
  running.backend.kill("SIGTERM");
  const terminal = await f.launcher.completion;
  assert.equal(terminal.state,"failed");
  assert.equal(terminal.exitCode,1);
  assert.equal(terminal.cleanup,"confirmed");
  assert.match(terminal.reason,/Portus backend exited unexpectedly/);
  const detectionMs = terminal.failureDetectedAt - injectedAt;
  const cleanupMs = Date.now() - terminal.failureDetectedAt;
  assert(detectionMs >= 0 && detectionMs <= 5000);
  assert(cleanupMs <= 5000);
  t.diagnostic(JSON.stringify({fault:"backend-loss",detectionMs,cleanupMs,state:terminal.state,exitCode:terminal.exitCode,cleanup:terminal.cleanup}));
  await closedPort(listener.port);
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
  const response = await fetch(`http://127.0.0.1:${address.port}`,{signal:AbortSignal.timeout(1000)});
  assert.equal(await response.text(),"borrowed-survived");
  const returned = createHttpServer((_req,res)=>res.end("dependency-returned"));
  t.after(()=>{returned.closeAllConnections();returned.close();});
  await new Promise<void>(resolve=>returned.listen(Number(f.env.PORTUS_MCP_PORT),"127.0.0.1",resolve));
  const restored = await fetch(`http://127.0.0.1:${f.env.PORTUS_MCP_PORT}`,{signal:AbortSignal.timeout(1000)});
  assert.equal(await restored.text(),"dependency-returned");
  assert.equal(f.launcher.state,"failed");
  assert.equal(f.launchCount(),1);
  await assert.rejects(f.launcher.start(),/already started/);
});

test("manual shutdown while backend readiness is pending remains stopped and never starts exposure",{timeout:15000},async t=>{
  const f = await fixture(t);
  const starting = f.launcher.start();
  const rejected = assert.rejects(starting,{name:"AbortError"});
  await f.launcher.stop();
  await rejected;
  const terminal = await f.launcher.completion;
  assert.equal(terminal.state,"stopped");
  assert.equal(terminal.exitCode,0);
  assert.equal(terminal.cleanup,"confirmed");
  assert.equal(f.launchCount(),0);
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
});

test("unverifiable dead-root cleanup is reported as failed rather than successful shutdown",{skip:process.platform !== "win32",timeout:15000},async t=>{
  const f = await fixture(t,{unverified:true});
  const running = await f.launcher.start();
  const listener = await f.ready;
  running.external.send({exit:0});
  const terminal = await f.launcher.completion;
  assert.equal(terminal.state,"failed");
  assert.equal(terminal.exitCode,1);
  assert.equal(terminal.cleanup,"unverified");
  assert.match(terminal.cleanupError,/could not be confirmed/);
  await assert.rejects(f.launcher.stop(),/cleanup is unverified/);
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
  await closedPort(listener.port);
});

test("Windows dead-root cleanup rejects a live root without touching its unrelated listener",{skip:process.platform !== "win32",timeout:10000},async t=>{
  const borrowed = createHttpServer((_req,res)=>res.end("not-owned"));
  await new Promise<void>(resolve=>borrowed.listen(0,"127.0.0.1",resolve));
  const address = borrowed.address();
  assert(address && typeof address === "object");
  t.after(()=>{borrowed.closeAllConnections();borrowed.close();});
  const now = Date.now();
  const result = await cleanupExitedWindowsTree({rootPid:process.pid,startedAfterMs:now-1000,exitedBeforeMs:now});
  assert.equal(result.confirmed,false);
  assert.equal(result.unverified,1);
  assert.equal(result.remaining,1);
  const response = await fetch(`http://127.0.0.1:${address.port}`,{signal:AbortSignal.timeout(1000)});
  assert.equal(await response.text(),"not-owned");
});

test("Windows dead-root cleanup leaves descendants outside the recorded ownership time window alive",{skip:process.platform !== "win32",timeout:15000},async t=>{
  const nested = `const s=require('node:http').createServer((q,r)=>{if(q.url==='/stop'){r.setHeader('connection','close');s.close(()=>process.exit(0));r.end('stopped');}else r.end('identity-rejected');});s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));`;
  const source = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:['ignore','ignore','ignore','ipc'],detached:true,windowsHide:true});c.once('message',m=>process.send(m));process.on('message',()=>process.exit(0));`;
  const owner:ChildProcess = spawn(process.execPath,["-e",source],{stdio:["ignore","ignore","ignore","ipc"],windowsHide:true});
  let listener: z.infer<typeof listenerSchema> | undefined;
  t.after(async()=>{
    if(owner.pid && owner.exitCode === null && owner.signalCode === null) {
      const killer = spawn("taskkill",["/pid",String(owner.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});
      await once(killer,"close");
    }
    if(listener) {
      try {const response=await fetch(`http://127.0.0.1:${listener.port}/stop`,{signal:AbortSignal.timeout(1000)});await response.text();} catch { /* Failed identity assertions may already have removed this test-owned listener. */ }
    }
  });
  const exited = once(owner,"exit");
  const [message] = await once(owner,"message");
  listener = listenerSchema.parse(message);
  assert(owner.pid);
  owner.send({stop:true});
  await exited;
  const aliveAfterRootExit = await fetch(`http://127.0.0.1:${listener.port}`,{signal:AbortSignal.timeout(1000)});
  assert.equal(await aliveAfterRootExit.text(),"identity-rejected");
  const future = Date.now()+60_000;
  const result = await cleanupExitedWindowsTree({rootPid:owner.pid,startedAfterMs:future,exitedBeforeMs:future+1000});
  assert.equal(result.confirmed,false);
  assert(result.unverified > 0);
  assert.equal(result.terminated,0,"unknown ownership must not authorize any termination");
  const response = await fetch(`http://127.0.0.1:${listener.port}`,{signal:AbortSignal.timeout(1000)});
  assert.equal(await response.text(),"identity-rejected");
});
