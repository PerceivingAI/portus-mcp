import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer as createNetServer, createConnection, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLauncher, startProcess } from "../scripts/start-all.mjs";
import { cleanupExitedWindowsTree, type ExitedWindowsTreeOwner } from "../src/runtime/processTermination.js";

const hostname = "fixture.example.ts.net";
const root = process.cwd();
type ServeConfig = {
  TCP?: Record<string, {HTTPS: boolean}>;
  Web?: Record<string, {Handlers: Record<string, {Proxy: string}>}>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
};
type ManagedOptions = {env: NodeJS.ProcessEnv; forwardOutput: boolean; tailscaleDiagnostics: boolean; processGroup: boolean};
const childInfoSchema = z.object({pid:z.number().int().positive(),port:z.number().int().positive()});
const watchSchema = z.object({mode:z.enum(["serve","funnel"]),port:z.number().int().positive()});

function route(port: number, mode = "serve", listener = 443): ServeConfig {
  return {
    TCP:{[listener]:{HTTPS:true}},
    Web:{[`${hostname}:${listener}`]:{Handlers:{"/":{Proxy:`http://127.0.0.1:${port}`}}}},
    ...(mode === "funnel" ? {AllowFunnel:{[`${hostname}:${listener}`]:true}} : {})
  };
}
async function freePort() {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function fixture(t: TestContext, {initial = {}, port, onConfigRead}: {initial?: ServeConfig; port?: number; onConfigRead?: (count:number,config:ServeConfig) => void} = {}) {
  const temp = mkdtempSync(path.join(root,".portus-f2-"));
  mkdirSync(path.join(temp,"skills"));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
  Object.assign(env,{
    DOTENV_CONFIG_PATH:path.join(temp,"absent.env"),
    PORTUS_MCP_HOST:"127.0.0.1",PORTUS_MCP_PORT:String(port ?? await freePort()),PORTUS_MCP_PATH:"/f2/mcp",PORTUS_MCP_BEARER_TOKEN:"f2-isolated-token",
    PORTUS_MCP_CONFIG_PATH:path.join(root,"portus-mcp.config.json"),PORTUS_MCP_POLICY_PATH:path.join(root,"portus-mcp.policy.json"),
    PORTUS_MCP_STATE_DIR:path.join(temp,"state"),AGENT_SKILL_PATHS:path.join(temp,"skills"),SUBAGENTS_SKILL_PATHS:path.join(temp,"skills")
  });
  const config: ServeConfig = structuredClone(initial);
  const sockets = new Set<Socket>();
  const stopLaunchers: Array<() => Promise<void>> = [];
  let configReads = 0;
  let launched = 0;
  let informChild: (value:z.infer<typeof childInfoSchema>) => void = () => {};
  let ownedListener: z.infer<typeof childInfoSchema> | undefined;
  const orphanCleanup = {aliveAfterRootExit:false,terminated:0};
  const childInfo = new Promise<z.infer<typeof childInfoSchema>>(resolve => {informChild=resolve;});
  // This local fixture models daemon watch-session release. It never binds a public
  // listener or contacts Tailscale. Windows child-tree termination remains real.
  const watchServer = createNetServer(socket => {
    sockets.add(socket);
    let pending = "";
    socket.on("data",chunk => {
      pending += chunk.toString();
      if(!pending.includes("\n")) return;
      const message = watchSchema.parse(JSON.parse(pending.split("\n")[0]));
      config.Foreground ??= {};
      config.Foreground["f2-owned-session"] = route(message.port,message.mode);
      socket.removeAllListeners("data");
    });
    socket.on("close",() => {
      sockets.delete(socket);
      if(config.Foreground) {
        delete config.Foreground["f2-owned-session"];
        if(!Object.keys(config.Foreground).length) delete config.Foreground;
      }
    });
    socket.on("error",() => {});
  });
  await new Promise<void>(resolve => watchServer.listen(0,"127.0.0.1",resolve));
  const watchAddress = watchServer.address();
  assert(watchAddress && typeof watchAddress === "object");
  const watchPort = watchAddress.port;
  const nestedSource = `const s=require('node:http').createServer((q,r)=>{if(q.url===${JSON.stringify(`/stop-${path.basename(temp)}`)}){r.setHeader('connection','close');s.close(()=>process.exit(0));r.end('stopped');}else r.end('owned-descendant');});s.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:s.address().port}));`;

  function makeLauncher(mode = "serve", {failSpawn = false, exitBeforeRoute = false, proveDeadRoot = false, host = "127.0.0.1"} = {}) {
    let cliRoot: ChildProcess | undefined;
    const launcher = createLauncher({mode,env:{...env,PORTUS_MCP_HOST:host},
      ...(proveDeadRoot ? {cleanupExited:async(owner:ExitedWindowsTreeOwner,options:{timeoutMs:number})=>{
        if(owner.rootPid !== cliRoot?.pid) return cleanupExitedWindowsTree(owner,options);
        assert(cliRoot.exitCode !== null || cliRoot.signalCode !== null);
        assert(ownedListener);
        const response = await fetch(`http://127.0.0.1:${ownedListener.port}`,{signal:AbortSignal.timeout(1000)});
        assert.equal(await response.text(),"owned-descendant");
        orphanCleanup.aliveAfterRootExit = true;
        const result = await cleanupExitedWindowsTree(owner,options);
        orphanCleanup.terminated = result.terminated;
        return result;
      }} : {}),
      executeTailscale:async (_binary:string,args:string[]) => {
        if(args[0] === "status") return {state:"ok",observedAt:new Date().toISOString(),value:{BackendState:"Running",Self:{Online:true,DNSName:hostname}}};
        assert.deepEqual(args,["serve","status","--json"],"ownership must not issue global reset/off or mutate unrelated configuration");
        onConfigRead?.(++configReads,config);
        return {state:"ok",observedAt:new Date().toISOString(),value:structuredClone(config)};
      },
      launchTailscale:(_binary:string,args:string[],options:ManagedOptions) => {
        launched++;
        if(failSpawn) return startProcess("f2-fixture","0","f2-missing-executable",[],options);
        const source = `
          if (${exitBeforeRoute}) process.exit(0);
          process.on('message',message=>{if(Number.isInteger(message.exit))process.exit(message.exit);});
          const {spawn}=require('node:child_process');
          const net=require('node:net');
          const watch=net.connect(${watchPort},'127.0.0.1');
          watch.once('connect',()=>{
            const child=spawn(process.execPath,['-e',${JSON.stringify(nestedSource)}],{stdio:['ignore','ignore','ignore','ipc'],detached:true,windowsHide:true});
            child.once('message',info=>{
              watch.write(JSON.stringify({mode:${JSON.stringify(args[0])},port:${Number(args[1])}})+'\\n');
              process.send(info);
              console.log('Available on https://fixture.example.ts.net');
            });
          });
          watch.once('error',()=>process.exit(9));
        `;
        const child = startProcess("f2-fixture","0",process.execPath,["-e",source],{...options,ipc:true});
        cliRoot = child;
        child.on("message",message => {const parsed=childInfoSchema.safeParse(message);if(parsed.success){ownedListener=parsed.data;informChild(parsed.data);}});
        return child;
      }
    });
    stopLaunchers.push(launcher.stop);
    return launcher;
  }
  t.after(async () => {
    let failure: unknown;
    for(const stop of stopLaunchers.reverse()) {try {await stop();}catch(error){failure ??= error;}}
    for(const socket of sockets) socket.destroy();
    // Independent fixture teardown also removes a descendant if the implementation
    // under test failed its native cleanup assertions. Never use a bare stored PID.
    if(ownedListener) {
      try {const response=await fetch(`http://127.0.0.1:${ownedListener.port}/stop-${path.basename(temp)}`,{signal:AbortSignal.timeout(1000)});await response.text();} catch {}
    }
    await new Promise<void>(resolve => watchServer.close(() => resolve()));
    rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    if(failure) throw failure;
  });
  return {env,makeLauncher,childInfo,orphanCleanup,state:()=>structuredClone(config),launchCount:()=>launched};
}

async function health(env: NodeJS.ProcessEnv) {
  const response = await fetch(`http://127.0.0.1:${env.PORTUS_MCP_PORT}/f2/mcp`,{headers:{authorization:`Bearer ${env.PORTUS_MCP_BEARER_TOKEN}`},signal:AbortSignal.timeout(1000)});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).status,"ok");
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

for(const mode of ["serve","funnel"]) {
  test(`standalone ${mode} stops its Windows child tree/listeners and preserves unrelated routes`,{timeout:15000},async t => {
    const initial: ServeConfig = {...route(9999,"serve",8443),Foreground:{borrowed:route(9998,"serve",10000)}};
    const f = await fixture(t,{initial});
    const launcher = f.makeLauncher(mode);
    const running = await launcher.start();
    const descendant = await f.childInfo;
    await health(f.env);
    const response = await fetch(`http://127.0.0.1:${descendant.port}`,{signal:AbortSignal.timeout(1000)});
    assert.equal(await response.text(),"owned-descendant");
    assert.equal(running.route.exposure,mode === "funnel" ? "public" : "private");
    await launcher.stop();
    const terminal = await launcher.completion;
    assert.equal(terminal.state,"stopped");
    assert.equal(terminal.exitCode,0);
    assert.equal(terminal.cleanup,"confirmed");
    await closedPort(Number(f.env.PORTUS_MCP_PORT));
    await closedPort(descendant.port);
    assert.throws(()=>process.kill(descendant.pid,0),{code:"ESRCH"});
    assert.deepEqual(f.state(),initial);
  });
}

test("an occupied Portus-shaped backend is not adopted or stopped",{timeout:10000},async t => {
  const borrowed = createHttpServer((_req,res)=>res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({name:"portus-mcp",status:"ok"})));
  await new Promise<void>(resolve => borrowed.listen(0,"127.0.0.1",resolve));
  const address = borrowed.address();
  assert(address && typeof address === "object");
  t.after(()=>{borrowed.closeAllConnections();borrowed.close();});
  const f = await fixture(t,{port:address.port});
  await assert.rejects(f.makeLauncher().start(),/exited before readiness|disconnected before/);
  assert.equal(f.launchCount(),0);
  await health(f.env);
  assert.deepEqual(f.state(),{});
});

test("repeated standalone startup fails without disturbing the first owner",{timeout:15000},async t => {
  const f = await fixture(t);
  const first = f.makeLauncher();
  await first.start();
  const existing = f.state();
  await assert.rejects(f.makeLauncher().start(),/listener 443/);
  await health(f.env);
  assert.equal(f.launchCount(),1);
  assert.deepEqual(f.state(),existing);
});

test("unowned private/public/foreground/same-backend listeners are never replaced",{timeout:10000},async t => {
  const selectedPort = await freePort();
  const variants: ServeConfig[] = [route(9999),route(9999,"funnel"),{Foreground:{borrowed:route(selectedPort,"funnel")}},{Foreground:{borrowed:route(9999)}},{AllowFunnel:{[`${hostname}:443`]:false}}];
  for(const initial of variants) {
    const f = await fixture(t,{initial,port:selectedPort});
    await assert.rejects(f.makeLauncher().start(),/listener 443/);
    assert.equal(f.launchCount(),0);
    assert.deepEqual(f.state(),initial);
  }
});

test("a listener appearing during backend startup is refused and preserved",{timeout:10000},async t => {
  const borrowedRoute = route(9999,"funnel");
  const f = await fixture(t,{onConfigRead:(count,config)=>{if(count===2)Object.assign(config,borrowedRoute);}});
  await assert.rejects(f.makeLauncher().start(),/listener 443/);
  assert.equal(f.launchCount(),0);
  assert.deepEqual(f.state(),borrowedRoute);
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
});

test("unsupported Tailscale binds fail without starting backend or exposure",{timeout:10000},async t => {
  const f = await fixture(t);
  for(const host of ["0.0.0.0","::","::1","localhost"]) await assert.rejects(f.makeLauncher("serve",{host}).start(),/require PORTUS_MCP_HOST=127\.0\.0\.1/);
  assert.equal(f.launchCount(),0);
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
});

test("real CLI spawn failure after backend readiness cleans up only owned startup",{timeout:10000},async t => {
  const initial = route(9999,"serve",8443);
  const f = await fixture(t,{initial});
  await assert.rejects(f.makeLauncher("serve",{failSpawn:true}).start(),/failed before foreground route readiness/);
  assert.equal(f.launchCount(),1);
  assert.deepEqual(f.state(),initial);
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
});

test("unexpected Tailscale exit cleans descendants after their native root is gone",{timeout:15000},async t => {
  const initial: ServeConfig = {...route(9999,"serve",8443),Foreground:{borrowed:route(9998,"serve",10000)}};
  const f = await fixture(t,{initial});
  const launcher = f.makeLauncher("serve",{proveDeadRoot:process.platform === "win32"});
  const running = await launcher.start();
  const descendant = await f.childInfo;
  const injectedAt = Date.now();
  running.external.send({exit:23});
  const terminal = await launcher.completion;
  assert.equal(terminal.state,"failed");
  assert.equal(terminal.exitCode,1);
  assert.equal(terminal.cleanup,"confirmed");
  if(process.platform === "win32") {
    assert.equal(f.orphanCleanup.aliveAfterRootExit,true);
    assert(f.orphanCleanup.terminated >= 1,"the native helper must actually terminate a surviving owned descendant");
  }
  assert.match(terminal.reason,/Tailscale CLI exited unexpectedly \(exit 23\)/);
  const detectionMs = terminal.failureDetectedAt - injectedAt;
  const cleanupMs = Date.now() - terminal.failureDetectedAt;
  assert(detectionMs >= 0 && detectionMs <= 5000);
  assert(cleanupMs <= 5000,"teardown must meet its separate five-second ceiling");
  t.diagnostic(JSON.stringify({fault:"tailscale-exit-23-dead-root",detectionMs,cleanupMs,state:terminal.state,exitCode:terminal.exitCode,cleanup:terminal.cleanup}));
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
  await closedPort(descendant.port);
  assert.throws(()=>process.kill(descendant.pid,0),{code:"ESRCH"});
  assert.deepEqual(f.state(),initial);
  assert.equal(f.launchCount(),1);
});

test("zero Tailscale exit before route readiness fails startup and releases owned resources",{timeout:15000},async t => {
  const f = await fixture(t);
  const launcher = f.makeLauncher("serve",{exitBeforeRoute:true});
  await assert.rejects(launcher.start(),/Tailscale CLI exited before readiness \(exit 0\)/);
  const terminal = await launcher.completion;
  assert.equal(terminal.state,"failed");
  assert.equal(terminal.exitCode,1);
  assert.equal(terminal.cleanup,"confirmed");
  assert.equal(f.launchCount(),1);
  assert.deepEqual(f.state(),{});
  await closedPort(Number(f.env.PORTUS_MCP_PORT));
});
