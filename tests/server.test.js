import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { defaultConfig } from '../src/core.js';

async function compactStatusFixture(t) {
  const value = await resumeVerificationServer(t, { eligible: true, greetingStatus: 'none', resumeStatus: 'none', evidence: { privateDetail: 'synthetic fixture evidence' } });
  value.store.appendEvent({ type: 'fixture', message: '合成日志', detail: 'not displayed', at: '2026-01-01T00:00:00.000Z' });
  return { ...value, read: query => fetch(value.base + '/api/status' + (query ? '?' + query : '')) };
}

async function resumeVerificationServer(t, patch = { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable' }) {
  const dir = mkdtempSync(join(tmpdir(), 'boss-resume-verification-'));
  const store = new Store(dir);
  store.saveConfig({ ...defaultConfig, setupComplete: true, companyDedup: false });
  const target = { id: 'resume-target', url: 'https://www.zhipin.com/job_detail/resume-target.html', title: 'AI Agent 开发', company: '验收示例公司', city: '北京', tags: ['实习'], description: 'AI Agent 智能体开发' };
  if (patch) store.upsertJob(target, patch);
  const trace = { opened: 0, discovered: 0, sent: 0, options: [] };
  const browser = {
    async open() { trace.opened++; }, async close() {}, async login() {},
    async discover() { trace.discovered++; return []; }, async details(card) { return card; },
    async contact(card, options) {
      trace.options.push({ id: card.id, resumeOnly: options.resumeOnly });
      await options.onStage('resume intent', { resumeStatus: 'intent' });
      trace.sent++;
      return { greetingStatus: 'existing', resumeStatus: 'sent' };
    }
  };
  const runner = new Runner({ store, browser, delayMs: 0 });
  const server = createServer({ store, runner, token: 'resume-verify-token', publicDir: join(import.meta.dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runner.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, headers = {}, path = '/api/verify-resume') => fetch(base + path, { method: 'POST', headers: { Origin: base, 'x-boss-token': 'resume-verify-token', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, runner, trace, send, target, base };
}

async function greetingVerificationServer(t, patch = { eligible: true, greetingStatus: 'none', resumeStatus: 'none' }) {
  const value = await resumeVerificationServer(t, patch);
  value.runner.browser.contact = async (_card, options) => {
    value.trace.options.push({ greeting: options.greeting, sendResume: options.sendResume, resumeOnly: options.resumeOnly });
    await options.onStage('greeting intent', { greetingStatus: 'intent' });
    value.trace.sent++;
    await options.onStage('greeting confirmed', { greetingStatus: 'sent' });
    return { greetingStatus: 'sent', resumeStatus: 'none', resumeSkipped: true };
  };
  const baseSend = value.send;
  value.send = (body, headers = {}, path = '/api/verify-greetings') => baseSend(body, headers, path);
  return value;
}

test('bounded greeting endpoint defaults to read-only preview then permits exactly selected greeting without attachment', async t => {
  const { store, runner, trace, send, target } = await greetingVerificationServer(t, { eligible: false, greetingStatus: 'none', resumeStatus: 'none' });
  const body = { keys: ['job:resume-target'], greeting: '您好，我对这个岗位感兴趣。' }, before = store.loadConfig();
  store.upsertJob({ ...target, id: 'unselected', url: 'https://www.zhipin.com/job_detail/unselected.html' }, { eligible: true, greetingStatus: 'none', resumeStatus: 'none' });
  assert.equal((await send(body)).status, 200);
  await runner.task;
  assert.equal(trace.sent, 0);
  assert.equal(store.getJob('job:resume-target').eligible, true);
  assert.deepEqual([store.getJob('job:resume-target').greetingStatus, store.getJob('job:resume-target').resumeStatus], ['none', 'none']);
  assert.equal((await send({ ...body, preview: false })).status, 200);
  await runner.task;
  assert.equal(trace.sent, 1);
  assert.equal(trace.discovered, 0);
  assert.deepEqual(trace.options, [{ greeting: body.greeting, sendResume: false, resumeOnly: false }]);
  assert.deepEqual([store.getJob('job:resume-target').greetingStatus, store.getJob('job:resume-target').resumeStatus], ['sent', 'none']);
  assert.equal(store.getJob('job:unselected').greetingStatus, 'none');
  assert.deepEqual(store.loadConfig(), before);
  assert.equal((await send({ ...body, preview: false })).status, 400);
  assert.equal(trace.sent, 1);
});

test('bounded greeting endpoint rejects malformed or expandable scopes before browser startup', async t => {
  const { trace, send } = await greetingVerificationServer(t);
  const valid = { keys: ['job:resume-target'], greeting: '您好' };
  for (const body of [null, [], {}, { ...valid, keys: [] }, { ...valid, keys: Array.from({ length: 6 }, (_, index) => `job:${index}`) }, { ...valid, keys: ['job:resume-target', 'job:resume-target'] }, { ...valid, keys: [null] }, { ...valid, keys: ['https://www.zhipin.com/job_detail/resume-target.html'] }, { ...valid, greeting: '' }, { ...valid, greeting: null }, { ...valid, greeting: 'x'.repeat(501) }, { ...valid, preview: 'false' }, { ...valid, preview: 0 }, { ...valid, once: false }, { ...valid, sendResume: true }, { ...valid, url: 'https://other.example' }, { ...valid, selector: '#send' }, { ...valid, op: 'SEND_GREETING' }]) assert.equal((await send(body)).status, 400);
  assert.equal((await send(valid, {}, '/api/verify-greetings?preview=false')).status, 400);
  assert.equal(trace.opened, 0);
  assert.equal(trace.sent, 0);
});

test('bounded greeting endpoint rejects cross-origin or old token before browser startup', async t => {
  const { trace, send } = await greetingVerificationServer(t);
  const valid = { keys: ['job:resume-target'], greeting: '您好', preview: false };
  assert.equal((await send(valid, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send(valid, { 'x-boss-token': 'old-token' })).status, 403);
  assert.equal(trace.opened, 0);
});

for (const [name, patch, status] of [['missing', null, 404], ['old sent', { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' }, 400], ['old existing', { eligible: true, greetingStatus: 'existing', resumeStatus: 'none' }, 400], ['unknown', { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'none' }, 400], ['attachment sent', { eligible: true, greetingStatus: 'none', resumeStatus: 'sent' }, 400]]) test(`bounded greeting endpoint rejects ${name} record before starting`, async t => {
  const { trace, send } = await greetingVerificationServer(t, patch);
  assert.equal((await send({ keys: ['job:resume-target'], greeting: '您好' })).status, status);
  assert.equal(trace.opened, 0);
});

test('bounded greeting endpoint refuses to extend running campaign or send stale ineligible record', async t => {
  const { runner, trace, send } = await greetingVerificationServer(t, { eligible: false, greetingStatus: 'none', resumeStatus: 'none' });
  const valid = { keys: ['job:resume-target'], greeting: '您好', preview: false };
  assert.equal((await send(valid)).status, 400);
  runner.task = Promise.resolve();
  assert.equal((await send(valid)).status, 409);
  assert.equal(trace.opened, 0);
});

test('timing endpoint returns bounded observer metadata without starting a sender', async t => {
  let starts = 0, calls = 0;
  const observed = { operations: [{ op: 'READ_STATUS', elapsedMs: 24, ready: true, loggedIn: true, authPending: false, page: 'user', errorCode: null }] };
  const server = createServer({ store: {}, runner: { start() { starts++; } }, token: 'timing-token', publicDir: join(import.meta.dirname, '../public'), timingSnapshot: () => { calls++; return observed; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/timings`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), observed);
  assert.equal(calls, 1);
  assert.equal(starts, 0);
});

test('protected single-resume endpoint submits only the selected existing record', async t => {
  const { store, runner, trace, send, target } = await resumeVerificationServer(t);
  store.upsertJob({ ...target, id: 'other-pending', url: 'https://www.zhipin.com/job_detail/other-pending.html', company: '另一示例公司' }, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  const previous = store.loadConfig();
  const response = await send({ key: 'job:resume-target' });
  assert.equal(response.status, 200);
  await runner.task;
  assert.equal(trace.opened, 1);
  assert.equal(trace.discovered, 0);
  assert.equal(trace.sent, 1);
  assert.deepEqual(trace.options, [{ id: 'resume-target', resumeOnly: true }]);
  assert.equal(store.getJob('job:resume-target').resumeStatus, 'sent');
  assert.equal(store.getJob('job:other-pending').resumeStatus, 'none');
  assert.deepEqual(store.loadConfig(), previous);
  assert.equal(runner.snapshot().status, 'completed');
});

test('single-resume endpoint rejects cross-origin and old tokens without starting a browser', async t => {
  const { trace, send } = await resumeVerificationServer(t);
  assert.equal((await send({ key: 'job:resume-target' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send({ key: 'job:resume-target' }, { 'x-boss-token': 'old-token' })).status, 403);
  assert.equal(trace.opened, 0);
});

test('single-resume endpoint rejects caller-selected operations, selectors, URLs and repeat options', async t => {
  const { trace, send } = await resumeVerificationServer(t);
  for (const body of [null, [], 'text', {}, { key: '' }, { key: 1 }, { key: 'job:resume-target', once: false }, { key: 'job:resume-target', preview: true }, { key: 'job:resume-target', url: 'https://other.example' }, { key: 'job:resume-target', selector: '#send' }, { key: 'job:resume-target', op: 'SEND_GREETING' }]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send({ key: 'job:resume-target' }, {}, '/api/verify-resume?once=false')).status, 400);
  assert.equal(trace.opened, 0);
});

for (const [name, patch, status] of [
  ['missing record', null, 404],
  ['ineligible record', { eligible: false, greetingStatus: 'sent', resumeStatus: 'none' }, 400],
  ['not contacted record', { eligible: true, greetingStatus: 'none', resumeStatus: 'none' }, 400],
  ['uncertain greeting', { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'none' }, 400],
  ['uncertain resume', { eligible: true, greetingStatus: 'sent', resumeStatus: 'uncertain' }, 400],
  ['already sent resume', { eligible: true, greetingStatus: 'sent', resumeStatus: 'sent' }, 400],
]) test(`single-resume endpoint rejects ${name} before browser startup`, async t => {
  const { trace, send } = await resumeVerificationServer(t, patch);
  assert.equal((await send({ key: 'job:resume-target' })).status, status);
  assert.equal(trace.opened, 0);
  assert.equal(trace.sent, 0);
});

test('single-resume endpoint refuses to extend a currently running campaign', async t => {
  const { runner, trace, send } = await resumeVerificationServer(t);
  runner.task = Promise.resolve();
  assert.equal((await send({ key: 'job:resume-target' })).status, 409);
  assert.equal(trace.opened, 0);
});

test('single-resume endpoint allows only its boolean read-only inspection option', async t => {
  const { runner, trace, send } = await resumeVerificationServer(t);
  runner.browser.contact = async (_card, options) => {
    assert.equal(options.resumeOnly, true);
    assert.equal(options.sendResume, false);
    assert.equal(options.inspectResumeOnly, true);
    return { greetingStatus: 'existing', resumeSkipped: true, resumeInspection: true, resumeStatus: 'none' };
  };
  for (const inspectOnly of [null, 'true', 1, {}, []]) assert.equal((await send({ key: 'job:resume-target', inspectOnly })).status, 400);
  assert.equal(trace.opened, 0);
  assert.equal((await send({ key: 'job:resume-target', inspectOnly: true })).status, 200);
  await runner.task;
  assert.equal(trace.opened, 1);
  assert.equal(trace.sent, 0);
});

for (const resumeStatus of ['sent', 'uncertain', 'intent']) test(`single-resume endpoint permits read-only ${resumeStatus} history while refusing an actual replay`, async t => {
  const { store, runner, trace, send } = await resumeVerificationServer(t, { eligible: true, greetingStatus: 'sent', resumeStatus });
  runner.browser.contact = async (_card, options) => {
    assert.equal(options.resumeOnly, true);
    assert.equal(options.sendResume, false);
    assert.equal(options.inspectResumeOnly, true);
    return { greetingStatus: 'existing', resumeSkipped: true, resumeInspection: true, resumeStatus: 'none' };
  };
  assert.equal((await send({ key: 'job:resume-target' })).status, 400);
  assert.equal(trace.opened, 0);
  assert.equal((await send({ key: 'job:resume-target', inspectOnly: true })).status, 200);
  await runner.task;
  assert.equal(trace.opened, 1);
  assert.equal(trace.sent, 0);
  assert.equal(store.getJob('job:resume-target').resumeStatus, resumeStatus);
  assert.equal(store.getJob('job:resume-target').greetingStatus, 'sent');
  assert.equal(runner.snapshot().status, 'completed');
});

test('single-resume endpoint refuses an uncertain greeting even in read-only mode', async t => {
  const { trace, send } = await resumeVerificationServer(t, { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'uncertain' });
  assert.equal((await send({ key: 'job:resume-target', inspectOnly: true })).status, 400);
  assert.equal(trace.opened, 0);
});

test('closing the dashboard connection stops its lease', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lease-'));
  let disconnected = false;
  const server = createServer({ store: new Store(dir), runner: {}, token: 'lease-token', publicDir: join(import.meta.dirname, '../public'), leaseClosed: () => { disconnected = true; }, leaseGraceMs: 10 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const response = await fetch(base + '/api/lease?token=lease-token', { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(disconnected, true);
});

test('closing one of two dashboards still stops despite remaining heartbeats and reconnects', async t => {
  let disconnected = false;
  const server = createServer({ store: {}, runner: {}, token: 'multi-lease-token', publicDir: join(import.meta.dirname, '../public'), leaseClosed: () => { disconnected = true; }, leaseGraceMs: 80 });
  let firstRequest = true;
  const firstClosed = new Promise(resolve => server.on('request', (req, res) => {
    if (req.url.startsWith('/api/lease') && firstRequest) { firstRequest = false; res.once('close', resolve); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  t.after(() => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = controller => fetch(base + '/api/lease?token=multi-lease-token', { signal: controller.signal });
  assert.equal((await open(controllers[0])).status, 200);
  assert.equal((await open(controllers[1])).status, 200);
  controllers[0].abort();
  await firstClosed;
  assert.equal(disconnected, false, 'the close must retain its grace period');
  const heartbeat = await fetch(base + '/api/heartbeat', { method: 'POST', headers: { Origin: base, 'x-boss-token': 'multi-lease-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(heartbeat.status, 200);
  await heartbeat.json();
  assert.equal((await open(controllers[2])).status, 200);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(disconnected, true);
});

test('a lone dashboard reconnecting during refresh grace keeps its lease', async t => {
  let disconnected = false;
  const server = createServer({ store: {}, runner: {}, token: 'refresh-token', publicDir: join(import.meta.dirname, '../public'), leaseClosed: () => { disconnected = true; }, leaseGraceMs: 500 });
  let firstRequest = true;
  const firstClosed = new Promise(resolve => server.on('request', (req, res) => {
    if (req.url.startsWith('/api/lease') && firstRequest) { firstRequest = false; res.once('close', resolve); }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = new AbortController(), refreshed = new AbortController();
  t.after(() => { original.abort(); refreshed.abort(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/lease?token=refresh-token', { signal: original.signal })).status, 200);
  original.abort();
  await firstClosed;
  assert.equal((await fetch(base + '/api/lease?token=refresh-token', { signal: refreshed.signal })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(disconnected, false);
});

test('local API rejects cross origin mutations and invalid tokens', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-server-'));
  const store = new Store(dir);
  const runner = { snapshot: () => ({ status: 'idle' }), start() {}, pause() {}, resume() {}, stop() {} };
  const server = createServer({ store, runner, token: 'test-token', publicDir: join(import.meta.dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let res = await fetch(base + '/api/start', { method: 'POST', headers: { Origin: 'https://evil.example', 'x-boss-token': 'test-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/start', { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/lease?token=previous-instance-token');
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/heartbeat', { method: 'POST', headers: { Origin: base, 'x-boss-token': 'previous-instance-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/start', { method: 'POST', headers: { Origin: base, 'x-boss-token': 'test-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  res = await fetch(base + '/api/status');
  assert.equal(res.status, 200);
 assert.equal((await res.json()).runner.status, 'idle');
});
test('role presets and a role-only configuration change remove inherited Agent matching',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'boss-role-api-'));const store=new Store(dir);
 const server=createServer({store,runner:{snapshot:()=>({status:'idle'}),task:null},token:'role-token',publicDir:join(import.meta.dirname,'../public')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 let res=await fetch(base+'/api/role-defaults?role='+encodeURIComponent('Java开发'));assert.equal(res.status,200);
 assert.deepEqual(await res.json(),{queries:['Java开发'],requiredAny:['Java开发'],allowExcludedKeywords:[]});
 res=await fetch(base+'/api/role-defaults?role='+encodeURIComponent('海外销售工程师'));assert.equal(res.status,200);
 assert.deepEqual(await res.json(),{queries:['海外销售工程师'],requiredAny:['海外销售工程师'],allowExcludedKeywords:['销售','电销']});
 res=await fetch(base+'/api/role-defaults?role='+encodeURIComponent('在线客服专员'));assert.equal(res.status,200);
 assert.deepEqual(await res.json(),{queries:['在线客服专员'],requiredAny:['在线客服专员'],allowExcludedKeywords:['客服']});
 res=await fetch(base+'/api/role-defaults?role=');assert.equal(res.status,400);
 res=await fetch(base+'/api/role-defaults?role='+encodeURIComponent('岗'.repeat(101)));assert.equal(res.status,400);
 const save=body=>fetch(base+'/api/config',{method:'POST',headers:{Origin:base,'x-boss-token':'role-token','content-type':'application/json'},body:JSON.stringify(body)});
 res=await save({targetRole:'Java开发'});assert.equal(res.status,200);assert.equal(store.loadConfig().targetRole,'Java开发');assert.deepEqual(store.loadConfig().requiredAny,['Java开发']);
 res=await save({targetRole:'后端开发',queries:['Spring工程师'],requiredAny:['Spring']});assert.equal(res.status,200);assert.deepEqual(store.loadConfig().queries,['Spring工程师']);assert.deepEqual(store.loadConfig().requiredAny,['Spring']);
});
test('the extension bridge has its own route and does not gain dashboard mutation access',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'boss-separate-bridge-'));let handled=0,setup=0;
 const bridge={snapshot:()=>({paired:false,pairingCode:'fixture-code'}),async handle(req,res,url){if(url.pathname!=='/bridge/heartbeat')return false;handled++;res.writeHead(200,{'content-type':'application/json'});res.end('{}');return true;}};
 const runner={snapshot:()=>({status:'idle'}),task:null};
 const server=createServer({store:new Store(dir),runner,token:'dashboard-only',publicDir:join(import.meta.dirname,'../public'),extensionBridge:bridge,setupExtension:async()=>{setup++;}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 let response=await fetch(base+'/bridge/heartbeat',{method:'POST',headers:{origin:'chrome-extension://'+'a'.repeat(32),'sec-fetch-site':'cross-site','content-type':'application/json'},body:'{}'});assert.equal(response.status,200);assert.equal(handled,1);
 response=await fetch(base+'/api/start',{method:'POST',headers:{origin:'chrome-extension://'+'a'.repeat(32),'x-boss-token':'dashboard-only','content-type':'application/json'},body:'{}'});assert.equal(response.status,403);
 response=await fetch(base+'/api/status');assert.equal((await response.json()).extension.pairingCode,'fixture-code');
 response=await fetch(base+'/api/extension-setup',{method:'POST',headers:{origin:base,'x-boss-token':'dashboard-only','content-type':'application/json'},body:'{}'});assert.equal(response.status,200);assert.equal(setup,1);
});

test('inspect returns the fixed read-only callback result without changing the runner', async t => {
  const result = { url: 'https://fixture.example/jobs', loggedIn: true, jobCount: 15 };
  const calls = [];
  const runner = new Proxy(Object.freeze({ state: Object.freeze({ status: 'paused' }) }), { get(target, key) { if (key !== 'state') throw new Error('inspect must not call runner methods'); return target[key]; } });
  const server = createServer({ store: {}, runner, token: 'inspect-token', publicDir: join(import.meta.dirname, '../public'), inspectPage: async (...args) => { calls.push(args); return result; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/inspect', { method: 'POST', headers: { Origin: base, 'x-boss-token': 'inspect-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls, [[]]);
  assert.equal(runner.state.status, 'paused');
});

test('inspect rejects unauthorized and parameterized requests before its callback', async t => {
  let calls = 0;
  const server = createServer({ store: {}, runner: {}, token: 'inspect-token', publicDir: join(import.meta.dirname, '../public'), inspectPage: async () => { calls++; return {}; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, headers = {}, path = '/api/inspect') => fetch(base + path, { method: 'POST', headers: { Origin: base, 'x-boss-token': 'inspect-token', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await send({}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send({}, { 'x-boss-token': 'previous-instance-token' })).status, 403);
  assert.equal((await send({}, { 'content-type': 'text/plain' })).status, 415);
  for (const body of [{ op: 'SEND_GREETING' }, { selector: '#target' }, { script: 'arbitrary()' }, [], null, 'text']) assert.equal((await send(body)).status, 400);
  assert.equal((await send({}, {}, '/api/inspect?op=SEND_GREETING')).status, 400);
  assert.equal(calls, 0);
});

test('inspect without an installed callback reports unavailable', async t => {
  const server = createServer({ store: {}, runner: {}, token: 'inspect-token', publicDir: join(import.meta.dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/inspect', { method: 'POST', headers: { Origin: base, 'x-boss-token': 'inspect-token', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 501);
});

test('dashboard status projects all displayed records while the legacy status keeps complete evidence', async t => {
  const { read, trace } = await compactStatusFixture(t);
  const legacy = await (await read('')).json();
  const compact = await (await read('view=dashboard')).json();
  assert.equal(legacy.jobs[0].description, 'AI Agent 智能体开发');
  assert.deepEqual(legacy.jobs[0].evidence, { privateDetail: 'synthetic fixture evidence' });
  assert.equal(compact.jobs.length, legacy.jobs.length);
  for (const key of ['key', 'url', 'title', 'company', 'city', 'eligible', 'greetingStatus', 'resumeStatus', 'note']) assert.deepEqual(compact.jobs[0][key], legacy.jobs[0][key]);
  for (const key of ['description', 'tags', 'evidence', 'id', 'createdAt', 'updatedAt']) assert.equal(Object.hasOwn(compact.jobs[0], key), false);
  assert.equal(compact.events[0].message, legacy.events[0].message);
  assert.equal(Object.hasOwn(compact.events[0], 'detail'), false);
  assert.deepEqual(compact.runner.counts, legacy.runner.counts);
  assert.deepEqual(compact.catalogs, legacy.catalogs);
  assert.ok(compact.versions.jobs && compact.versions.events && compact.versions.catalogs);
  assert.equal(trace.opened, 0); assert.equal(trace.sent, 0);
});

test('dashboard status omits unchanged collections and resends only the changed collection', async t => {
  const { read, store, target } = await compactStatusFixture(t);
  const first = await (await read('view=dashboard')).json();
  const query = new URLSearchParams({ view: 'dashboard', knownJobs: first.versions.jobs, knownEvents: first.versions.events, knownCatalogs: first.versions.catalogs });
  const unchanged = await (await read(query)).json();
  for (const key of ['jobs', 'events', 'cities', 'catalogs']) assert.equal(Object.hasOwn(unchanged, key), false);
  assert.ok(unchanged.runner && unchanged.config);
  store.appendEvent({ type: 'later', message: '新的合成日志' });
  const eventChange = await (await read(query)).json();
  assert.equal(Object.hasOwn(eventChange, 'jobs'), false);
  assert.equal(eventChange.events[0].message, '新的合成日志');
  assert.notEqual(eventChange.versions.events, first.versions.events);
  query.set('knownEvents', eventChange.versions.events);
  store.upsertJob(target, { greetingStatus: 'uncertain', note: '合成未确认结果' });
  const jobChange = await (await read(query)).json();
  assert.equal(Object.hasOwn(jobChange, 'events'), false);
  assert.equal(jobChange.jobs[0].greetingStatus, 'uncertain');
  assert.equal(jobChange.runner.counts.uncertain, 1);
  assert.notEqual(jobChange.versions.jobs, first.versions.jobs);
});

test('dashboard restart resends records even when stored revision numbers coincide', async t => {
  const { read, store, runner } = await compactStatusFixture(t);
  const first = await (await read('view=dashboard')).json();
  const server = createServer({ store, runner, token: 'second-status-token', publicDir: join(import.meta.dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const query = new URLSearchParams({ view: 'dashboard', knownJobs: first.versions.jobs, knownEvents: first.versions.events, knownCatalogs: first.versions.catalogs });
  const next = await (await fetch(`http://127.0.0.1:${server.address().port}/api/status?${query}`)).json();
  assert.equal(next.jobs.length, first.jobs.length);
  assert.equal(next.events.length, first.events.length);
  assert.notEqual(next.versions.jobs, first.versions.jobs);
  assert.notEqual(next.versions.events, first.versions.events);
  assert.equal(next.versions.catalogs, first.versions.catalogs);
  assert.equal(Object.hasOwn(next, 'catalogs'), false);
});
