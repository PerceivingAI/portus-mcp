import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { collectTailscaleStatus } from './tailscale.mjs';

const root = process.cwd();
const temp = mkdtempSync(path.join(root, '.portus-b0-'));
const token = randomBytes(32).toString('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(k)));
Object.assign(env, {
  DOTENV_CONFIG_PATH: path.join(temp, 'absent.env'),
  PORTUS_MCP_CONFIG_PATH: path.join(root, 'portus-mcp.config.json'),
  PORTUS_MCP_POLICY_PATH: path.join(root, 'portus-mcp.policy.json'),
  PORTUS_MCP_STATE_DIR: path.join(temp, 'state'),
  PORTUS_MCP_PROJECTS: `b0-fixture=${path.join(temp, 'project')}`,
  PORTUS_MCP_BEARER_TOKEN: token,
  PORTUS_MCP_HOST: '127.0.0.1',
  PORTUS_MCP_PATH: '/b0/mcp',
  AGENT_SKILL_PATHS: path.join(temp, 'skills'),
  SUBAGENTS_SKILL_PATHS: path.join(temp, 'skills')
});
mkdirSync(path.join(temp, 'project'), { recursive: true });
mkdirSync(path.join(temp, 'skills'));
for (let d = 0; d < 20; d++) {
  const dir = path.join(temp, 'project', `group-${String(d).padStart(2, '0')}`);
  mkdirSync(dir);
  for (let i = 0; i < 100; i++) writeFileSync(path.join(dir, `file-${String(i).padStart(3, '0')}.txt`), 'b0 baseline fixture\n');
}
const owned = new Set();
const results = { startedUtc: new Date().toISOString(), isolation: { productionSecretsInherited: false, publicRouteCreated: false, fixtureFiles: 2000 }, startupMs: [], teardownMs: [], http: {}, resources: [], cycles: [], statusFixtures: [], childProbes: [] };
let requestId = 0;
const deadline = (promise, ms, name) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} deadline`)), ms); })]).finally(() => clearTimeout(timer));
};
const round = n => Math.round(n * 100) / 100;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)), elapsedMs: round(values.reduce((a,b) => a+b, 0)), errors: 0 };
}
async function finiteChild(source) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(p);
  let stdout = '', stderr = '';
  p.stdout.on('data', b => { stdout = (stdout + b).slice(-32768); });
  p.stderr.on('data', b => { stderr = (stderr + b).slice(-32768); });
  const [code, signal] = await deadline(once(p, 'exit'), 5000, 'finite child');
  owned.delete(p);
  return { code, signal, stdout, stderr };
}
const serverSource = `
import { createHttpServer } from './src/server.ts';
const server = createHttpServer('/b0/mcp');
server.listen(0, '127.0.0.1', () => process.send({type:'ready',port:server.address().port}));
process.on('message', message => {
  if(message === 'metrics') process.send({type:'metrics',rss:process.memoryUsage().rss,cpu:process.cpuUsage(),resources:process.getActiveResourcesInfo()});
  if(message === 'stop') { server.closeAllConnections(); server.close(() => process.exit(0)); }
});
`;
async function metric(p) {
  const reply = deadline(new Promise(resolve => {
    const on = m => { if (m.type === 'metrics') { p.off('message', on); resolve(m); } };
    p.on('message', on);
  }), 5000, 'metrics');
  p.send('metrics');
  return reply;
}
async function http(url, method, params, auth = token, notification = false) {
  const start = performance.now();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, ...(params ? {params} : {}) }), signal: AbortSignal.timeout(5000) });
  const text = await r.text();
  let json;
  if (r.headers.get('content-type')?.includes('application/json')) json = JSON.parse(text);
  return { status: r.status, json, ms: performance.now() - start, session: r.headers.get('mcp-session-id') };
}
const initialize = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'b0-local-baseline', version: '1' } };
const discovery = { name: 'project_context', arguments: { include: { projects: true } } };
const traversal = { name: 'project_context', arguments: { projectAlias: 'b0-fixture', include: { tree: { maxDepth: 4, maxEntries: 2000, format: 'json' } } } };
function check(r, kind) {
  assert.equal(r.status, 200);
  assert.ok(r.json?.result && !r.json.error);
  if (kind === 'initialize') { assert.equal(r.json.result.protocolVersion, '2025-06-18'); assert.equal(r.json.result.serverInfo.name, 'portus-mcp'); assert.equal(r.session, null); }
  if (kind === 'tools/list') { assert.equal(r.json.result.tools.length, 10); assert.ok(r.json.result.tools.some(t => t.name === 'project_context')); }
  if (kind === 'alias') { assert.notEqual(r.json.result.isError, true); assert.deepEqual(r.json.result.structuredContent.result, { projectAlias: null, sections: { projects: { ok: true, value: { projectAliases: ['b0-fixture'] } } } }); }
  if (kind === 'tree') { assert.notEqual(r.json.result.isError, true); const section = r.json.result.structuredContent.result.sections.tree; assert.equal(section.ok, true); assert.equal(section.value.format, 'json'); assert.equal(section.value.relativePath, '.'); assert.equal(section.value.entries.length, 2000); assert.equal(section.value.truncated, true); assert.ok(section.value.entries.every(e => /^group-\d{2}(?:\/file-\d{3}\.txt)?$/.test(e.relativePath))); assert.ok(!JSON.stringify(section.value).includes(temp)); }
}
try {
  for (let cycle = 0; cycle < 3; cycle++) {
    const start = performance.now();
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', serverSource], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    owned.add(p);
    let diagnostic = '';
    p.stdout.on('data', b => { diagnostic = (diagnostic + b).slice(-32768); });
    p.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-32768); });
    const ready = await deadline(new Promise((resolve, reject) => {
      p.on('message', m => { if (m.type === 'ready') resolve(m); });
      p.once('error', reject);
      p.once('exit', code => reject(new Error(`server exited ${code}; diagnostic bytes ${diagnostic.length}`)));
    }), 30000, 'startup');
    const url = `http://127.0.0.1:${ready.port}/b0/mcp`;
    check(await http(url, 'initialize', initialize), 'initialize');
    results.startupMs.push(round(performance.now() - start));
    assert.equal((await http(url, 'notifications/initialized', undefined, token, true)).status, 202);
    const list = await http(url, 'tools/list'); check(list, 'tools/list');
    check(await http(url, 'tools/call', discovery), 'alias');
    if (cycle === 0) {
      for (const [name, method, params] of [['initialize', 'initialize', initialize], ['tools/list', 'tools/list', undefined], ['alias', 'tools/call', discovery], ['tree', 'tools/call', traversal]]) {
        for(let n = 0; n < 5; n++) check(await http(url, method, params), name);
        const samples = [];
        for(let n = 0; n < 30; n++) { const r = await http(url, method, params); check(r, name); samples.push(r.ms); }
        results.http[name] = stats(samples);
      }
      const auth = [];
      for (const [label, credential] of [['missing', ''], ['wrong', 'b0-deliberately-wrong']]) {
        for (const [method, params] of [['initialize', initialize], ['tools/list', undefined], ['tools/call', discovery]]) {
          const r = await http(url, method, params, credential);
          assert.equal(r.status, 401); auth.push({credential:label,method,status:r.status});
        }
        const r = await fetch(url + '/events?sessionId=b0-absent', {headers:credential?{authorization:`Bearer ${credential}`}:{}, signal:AbortSignal.timeout(5000)});
        assert.equal(r.status,401); await r.text(); auth.push({credential:label,method:'GET application events',status:r.status});
      }
      results.authentication = auth;
      let previous = await metric(p);
      const idleStart = performance.now();
      for (let window = 0; window < 2; window++) {
        const t = performance.now();
        await new Promise(resolve => setTimeout(resolve, 15000));
        const current = await metric(p);
        const durationMs = performance.now() - t;
        results.resources.push({ window: window+1, elapsedMs:round(durationMs), rssMiB:round(current.rss/1048576), cpuOneCorePercent:round(((current.cpu.user-previous.cpu.user)+(current.cpu.system-previous.cpu.system))/(durationMs*1000)*100), activeResources:current.resources.reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{}), sinceIdleStartMs:round(performance.now()-idleStart) });
        previous=current;
      }
    }
    const active = await metric(p);
    const t = performance.now();
    const exited = once(p, 'exit');
    p.send('stop');
    const [code] = await deadline(exited, 5000, 'teardown');
    assert.equal(code,0);
    results.teardownMs.push(round(performance.now()-t));
    owned.delete(p);
    let closed = false;
    try { const r = await fetch(url, {signal:AbortSignal.timeout(1000)}); await r.body?.cancel(); } catch(e) { closed = e.cause?.code === 'ECONNREFUSED'; }
    assert.equal(closed,true);
    results.cycles.push({cycle:cycle+1,exitCode:code,listenerClosed:closed,activeResourcesBeforeStop:active.resources.reduce((a,k)=>(a[k]=(a[k]||0)+1,a),{})});
  }

  const hostname = 'b0-node.example.ts.net';
  function config(backend=8789,allow,port=443) {
    const hp = `${hostname}:${port}`;
    return { TCP:{[port]:{HTTPS:true}}, Web:{[hp]:{Handlers:{'/':{Proxy:`http://127.0.0.1:${backend}`}}}}, ...(allow === undefined ? {} : {AllowFunnel:{[hp]:allow}}) };
  }
  const fixtures = [
    ['disabled-funnel',config(8789,false),'private',443],
    ['unrelated-private',config(9999),'none',443],
    ['unrelated-public',config(9999,true),'none',443],
    ['foreground-public',{Foreground:{'b0-session':config(8789,true)}},'public',443],
    ['nondefault-listener',config(8789,true,8443),'public',8443],
    ['empty',{},'none',443],
    ['malformed','{','unknown',443],
    ['disconnected',config(8789,true),'not-ready',443]
  ];
  for(const [name,cfg,expected,port] of fixtures) {
    const status = await collectTailscaleStatus({
      env: {PORTUS_MCP_PORT:'8789',PORTUS_MCP_PATH:'/b0/mcp'},
      execute: async (_binary, args) => {
        if (args[0] === 'status') return {state:'ok',observedAt:new Date().toISOString(),value:{BackendState:name==='disconnected'?'NoState':'Running',Self:{DNSName:hostname+'.',Online:name!=='disconnected'}}};
        return typeof cfg === 'string' ? {state:'error',reason:'malformed-json',observedAt:new Date().toISOString()} : {state:'ok',value:cfg,observedAt:new Date().toISOString()};
      },
      probe: async () => ({state:'not-checked',observedAt:new Date().toISOString()})
    });
    const actual = status.daemon.state !== 'connected' ? 'not-ready' : status.route.state === 'configured' ? status.route.exposure : ['unknown','ambiguous'].includes(status.route.state) ? 'unknown' : 'none';
    const correctUrl=`https://${hostname}${port===443?'':`:${port}`}/b0/mcp`;
    const urlCorrect=!['public','private'].includes(expected)||status.route.url === correctUrl;
    results.statusFixtures.push({name,expected,actual,urlCorrect,correct:actual===expected&&urlCorrect});
  }
  for(const mode of ['exit23','exit0','spawn-error']) {
    const command = mode==='spawn-error' ? `'b0-command-does-not-exist'` : 'process.execPath';
    const args = mode==='spawn-error' ? '[]' : JSON.stringify(['-e',`process.exit(${mode==='exit23'?23:0})`]);
    const outcome = await finiteChild(`import {startProcess} from './scripts/start-all.mjs'; const child=startProcess('b0-child','0',${command},${args},{forwardOutput:false}); const event=await new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',e=>resolve({errorCode:e.code}));}); await new Promise(r=>setTimeout(r,100)); console.log(JSON.stringify({event,parentExitCode:process.exitCode??null}));`);
    const last=outcome.stdout.trim().split(/\r?\n/).at(-1);
    results.childProbes.push({mode,wrapperExitCode:outcome.code,observed:JSON.parse(last)});
  }
  results.startup = stats(results.startupMs);
  results.teardown = stats(results.teardownMs);
  results.probeSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
} finally {
  for(const p of owned) {
    if(p.pid && p.exitCode === null) {
      const ended = once(p, 'exit').catch(() => undefined);
      try { if(process.platform==='win32') execFileSync('taskkill',['/pid',String(p.pid),'/T','/F'],{stdio:'ignore',timeout:5000}); else p.kill('SIGTERM'); } catch {}
      await deadline(ended, 5000, 'cleanup exit');
    }
  }
  rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  results.cleanup={temporaryDirectoryRemoved:!existsSync(temp),ownedProcessesRemaining:[...owned].filter(p=>p.exitCode===null&&p.signalCode===null).length};
  results.finishedUtc=new Date().toISOString();
  console.log(JSON.stringify(results,null,2));
}
