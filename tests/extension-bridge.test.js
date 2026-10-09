import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ExtensionBridge;
try { ({ ExtensionBridge } = await import('../src/extension-bridge.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.url).endsWith('/src/extension-bridge.js')) throw error; }

const origin = `chrome-extension://${'a'.repeat(32)}`;
const otherOrigin = `chrome-extension://${'b'.repeat(32)}`;
const instanceId = 'fixture-instance';
const capture = promise => promise.then(result => ({ result }), error => ({ error }));

async function fixture(t, options = {}) {
  assert.equal(typeof ExtensionBridge, 'function', 'ExtensionBridge is not implemented');
  const dataDir = mkdtempSync(join(tmpdir(), 'boss-extension-bridge-'));
  const bridge = new ExtensionBridge({ dataDir, timeoutMs: 1500, leaseMs: 1200, pollMs: 15, ...options });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!await bridge.handle(req, res, url)) { res.writeHead(404); res.end('regular route'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    bridge.cancel(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  async function request(path, { method = 'POST', body = {}, auth = true, headers = {} } = {}) {
    return fetch(base + path, {
      method,
      headers: { Origin: origin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { 'x-boss-bridge-token': token || '', 'x-boss-instance': instanceId } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    });
  }
  async function pair() {
    const response = await request('/bridge/pair', { auth: false, body: { pairingCode: bridge.snapshot().pairingCode, instanceId } });
    assert.equal(response.status, 200);
    const data = await response.json(); token = data.token;
    assert.equal(typeof token, 'string'); assert.ok(token.length >= 32);
    return data;
  }
  async function poll() { return (await request('/bridge/poll', { method: 'GET' })).json(); }
  return { bridge, dataDir, request, pair, poll, base, token: () => token };
}

test('cold session creation can finish after the ordinary effect lease without replaying', async t => {
  const f = await fixture(t, { timeoutMs: 20_000, leaseMs: undefined });
  await f.pair(); f.bridge.beginRun();
  const originalNow = Date.now, started = originalNow();
  let pending;
  try {
    Date.now = () => started;
    pending = capture(f.bridge.request('OPEN_SESSION', { url: 'https://www.zhipin.com/web/user/' }));
  } finally { Date.now = originalNow; }
  const { command } = await f.poll(), body = { id: command.id, epoch: command.epoch };
  assert.equal(command.expiresAt - started, 15_000);
  assert.equal(f.bridge.leaseMs, 8000);
  try {
    Date.now = () => started + 9000;
    assert.equal((await f.request('/bridge/permit', { body })).status, 200);
    assert.equal((await f.request('/bridge/permit', { body })).status, 409);
    assert.equal((await f.request('/bridge/result', { body: { ...body, result: { opened: true } } })).status, 200);
  } finally { Date.now = originalNow; }
  assert.equal((await pending).result.opened, true);
  assert.equal((await f.poll()).command, null);
});

for (const op of ['NAV_SEARCH', 'NAV_JOB', 'SEND_GREETING', 'CONFIRM_RESUME']) test(`the cold-start budget does not extend ${op}`, async t => {
  const f = await fixture(t, { timeoutMs: 20_000, leaseMs: undefined });
  await f.pair(); f.bridge.beginRun();
  const originalNow = Date.now, started = originalNow();
  let pending;
  try { Date.now = () => started; pending = capture(f.bridge.request(op)); }
  finally { Date.now = originalNow; }
  const { command } = await f.poll();
  assert.equal(command.expiresAt - started, 8000);
  try {
    Date.now = () => started + 8000;
    assert.equal((await f.request('/bridge/permit', { body: { id: command.id, epoch: command.epoch } })).status, 410);
  } finally { Date.now = originalNow; }
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.poll()).command, null);
});

for (const [options, requestTimeout, expected] of [
  [{ leaseMs: 1200 }, 20_000, 1200],
  [{ leaseMs: 1200, sessionLeaseMs: 15_000 }, 20_000, 15_000],
  [{ leaseMs: undefined, sessionLeaseMs: 12_000 }, 20_000, 12_000],
  [{ leaseMs: undefined, sessionLeaseMs: 15_000 }, 900, 900]
]) test(`session creation preserves explicit lease and request deadlines (${expected} ms)`, async t => {
  const f = await fixture(t, { timeoutMs: 20_000, ...options });
  await f.pair(); f.bridge.beginRun();
  const originalNow = Date.now, started = originalNow();
  let pending;
  try { Date.now = () => started; pending = capture(f.bridge.request('OPEN_SESSION', {}, { timeoutMs: requestTimeout })); }
  finally { Date.now = originalNow; }
  const { command } = await f.poll();
  assert.equal(command.expiresAt - started, expected);
  const body = { id: command.id, epoch: command.epoch };
  assert.equal((await f.request('/bridge/result', { body: { ...body, error: { code: 'PAGE_NOT_READY', message: 'fixture pending' } } })).status, 200);
  assert.equal((await pending).error.code, 'PAGE_NOT_READY');
});

test('the longer cold-session deadline still expires once and cannot be revived', async t => {
  const f = await fixture(t, { timeoutMs: 20_000, leaseMs: undefined });
  await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('OPEN_SESSION'));
  const { command } = await f.poll(), body = { id: command.id, epoch: command.epoch };
  assert.equal((await f.request('/bridge/permit', { body })).status, 200);
  const originalNow = Date.now;
  try {
    Date.now = () => command.expiresAt;
    assert.equal((await f.request('/bridge/result', { body: { ...body, result: { opened: true } } })).status, 410);
  } finally { Date.now = originalNow; }
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.request('/bridge/permit', { body })).status, 404);
  assert.equal((await f.poll()).command, null);
});

test('stopping a cold session immediately rejects its longer-lived command', async t => {
  const f = await fixture(t, { timeoutMs: 20_000, leaseMs: undefined });
  await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('OPEN_SESSION'));
  const { command } = await f.poll(), body = { id: command.id, epoch: command.epoch };
  f.bridge.cancel();
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.request('/bridge/permit', { body })).status, 409);
  assert.equal((await f.request('/bridge/result', { body: { ...body, result: { opened: true } } })).status, 409);
  assert.equal((await f.poll()).command, null);
});

for (const sessionLeaseMs of [0, -1, 15_001, '15000']) test(`invalid cold-session lease is rejected (${sessionLeaseMs})`, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boss-session-budget-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.throws(() => new ExtensionBridge({ dataDir, sessionLeaseMs }), TypeError);
});

test('pairing accepts only an extension origin and consumes its code once', async t => {
  const f = await fixture(t);
  const pairingCode = f.bridge.snapshot().pairingCode;
  assert.ok(/^[a-f0-9]{64}$/u.test(pairingCode), '配对码必须包含 256 位随机数据');
  let response = await f.request('/bridge/pair', { auth: false, headers: { Origin: 'https://evil.example' }, body: { pairingCode, instanceId } });
  assert.equal(response.status, 403);
  response = await f.request('/bridge/pair', { auth: false, body: { pairingCode: 'wrong', instanceId } });
  assert.equal(response.status, 403);
  await f.pair();
  assert.equal(f.bridge.snapshot().paired, true);
  assert.equal(f.bridge.snapshot().extensionId, 'a'.repeat(32));
  assert.equal(Object.hasOwn(f.bridge.snapshot(), 'token'), false);
  assert.equal(f.bridge.snapshot().pairingCode, undefined);
  response = await f.request('/bridge/pair', { auth: false, body: { pairingCode, instanceId } });
  assert.equal(response.status, 409);
});

test('poll authenticates extension origin, token and the bound instance independently', async t => {
  const f = await fixture(t); await f.pair();
  for (const headers of [{ Origin: otherOrigin }, { Origin: '' }, { 'x-boss-bridge-token': 'wrong' }, { 'x-boss-instance': 'another-instance' }]) {
    const response = await f.request('/bridge/poll', { method: 'GET', headers });
    assert.ok(response.status === 401 || response.status === 403);
  }
  const missingOrigin = await fetch(f.base + '/bridge/poll', { headers: { 'x-boss-bridge-token': f.token(), 'x-boss-instance': instanceId } });
  assert.equal(missingOrigin.status, 403);
  assert.equal(f.bridge.isConnected(), false);
  const data = await f.poll(); assert.equal(data.command, null); assert.equal(f.bridge.isConnected(), true);
});

test('a queued read is delivered once and its result can be consumed only once', async t => {
  const f = await fixture(t); await f.pair();
  const pending = capture(f.bridge.request('READ_CARDS'));
  const { command } = await f.poll();
  assert.equal(command.op, 'READ_CARDS'); assert.equal(command.v, 1);
  assert.equal((await f.poll()).command, null);
  const body = { id: command.id, epoch: command.epoch, result: { cards: [{ id: 'fixture-job' }] } };
  let response = await f.request('/bridge/result', { body }); assert.equal(response.status, 200);
  assert.deepEqual((await pending).result, body.result);
  response = await f.request('/bridge/result', { body }); assert.ok(response.status >= 400);
  assert.equal(f.bridge.snapshot().pending, 0);
});
test('lean status and contact confirmation reads stay available without granting action permits',async t=>{
 const f=await fixture(t);await f.pair();
 for(const op of ['READ_STATUS','READ_CONTACT_CONFIRMATION']){
  const args=op==='READ_CONTACT_CONFIRMATION'?{job:{id:'fixture',url:'https://www.zhipin.com/job_detail/fixture.html',title:'本地岗位',company:'示例公司'}}:{};
  const pending=capture(f.bridge.request(op,args));const {command}=await f.poll();assert.ok(command,'固定只读操作必须进入已认证命令队列');assert.equal(command.op,op);assert.deepEqual(command.args,args);
  const body={id:command.id,epoch:command.epoch};assert.equal((await f.request('/bridge/permit',{body})).status,409);
  const result={meta:{url:'https://www.zhipin.com/job_detail/fixture.html',documentId:'doc-fixture'},ready:true};assert.equal((await f.request('/bridge/result',{body:{...body,result}})).status,200);assert.deepEqual((await pending).result,result);
 }
});
test('contact confirmation dismissal is a one-permit mutation and a lost result is never replayed',async t=>{
 const f=await fixture(t);await f.pair();await assert.rejects(f.bridge.request('DISMISS_CONTACT_CONFIRMATION'),{code:'BRIDGE_INACTIVE'});f.bridge.beginRun();
 const pending=capture(f.bridge.request('DISMISS_CONTACT_CONFIRMATION',{job:{id:'fixture'}}));const {command}=await f.poll();const body={id:command.id,epoch:command.epoch};
 assert.equal((await f.request('/bridge/result',{body:{...body,result:{dismissed:true}}})).status,409);assert.equal((await f.request('/bridge/permit',{body})).status,200);assert.equal((await f.request('/bridge/permit',{body})).status,409);
 assert.equal((await pending).error.code,'UNKNOWN_RESULT');assert.equal((await f.poll()).command,null);assert.ok((await f.request('/bridge/result',{body:{...body,result:{dismissed:true}}})).status>=400);
});

test('active mutations require one permit before accepting any result', async t => {
  const f = await fixture(t); await f.pair();
  await assert.rejects(f.bridge.request('SEND_GREETING', {}), error => error.code === 'BRIDGE_INACTIVE');
  f.bridge.beginRun();
  const pending = capture(f.bridge.request('SEND_GREETING', { greeting: 'fixture hello' }, { target: { documentId: 'document-one', url: 'https://www.zhipin.com/job_detail/fixture.html' } }));
  const { command } = await f.poll(); assert.equal(command.target.documentId, 'document-one');
  const body = { id: command.id, epoch: command.epoch };
  let response = await f.request('/bridge/result', { body: { ...body, result: { proof: 'outgoing-message' } } }); assert.ok(response.status >= 400);
  response = await f.request('/bridge/permit', { body }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { allowed: true });
  response = await f.request('/bridge/permit', { body }); assert.ok(response.status >= 400);
  response = await f.request('/bridge/result', { body: { ...body, result: { proof: 'outgoing-message' } } }); assert.equal(response.status, 200);
  assert.equal((await pending).result.proof, 'outgoing-message');
});

test('a delivered active mutation accepts an authenticated negative acknowledgement before permit', async t => {
  const f = await fixture(t); await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('OPEN_CONTACT', { job: { id: 'fixture-job' } }));
  const { command } = await f.poll();
  const body = { id: command.id, epoch: command.epoch, error: { code: 'DOCUMENT_CHANGED', message: '固定目标文档已变化，前置检查未执行点击' } };
  const response = await f.request('/bridge/result', { body });
  assert.equal(response.status, 200);
  const outcome = await pending;
  assert.equal(outcome.error.code, 'DOCUMENT_CHANGED');
  assert.equal(outcome.error.message, body.error.message);
  assert.equal(f.bridge.snapshot().pending, 0);
  assert.equal((await f.request('/bridge/result', { body })).status, 404);
  assert.equal((await f.request('/bridge/permit', { body: { id: command.id, epoch: command.epoch } })).status, 404);
});

test('negative acknowledgements still require authenticated delivery and a valid exclusive error payload', async t => {
  const f = await fixture(t); await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('SEND_GREETING'));
  const epoch = f.bridge.epoch;
  assert.equal((await f.request('/bridge/result', { body: { id: 'unknown-id', epoch, error: 'rejected' } })).status, 404);
  const { command } = await f.poll();
  const base = { id: command.id, epoch: command.epoch };
  for (const body of [{ ...base, error: { code: 'DOCUMENT_CHANGED' } }, { ...base, error: null }, { ...base, error: { message: 12 } }, { ...base, error: 'rejected', result: { sent: true } }]) {
    assert.equal((await f.request('/bridge/result', { body })).status, 400);
    assert.equal(f.bridge.snapshot().pending, 1);
  }
  for (const headers of [{ 'x-boss-bridge-token': 'wrong' }, { 'x-boss-instance': 'old-instance' }, { Origin: otherOrigin }]) {
    const response = await f.request('/bridge/result', { headers, body: { ...base, error: 'rejected' } });
    assert.ok([401, 403].includes(response.status));
    assert.equal(f.bridge.snapshot().pending, 1);
  }
  assert.equal((await f.request('/bridge/result', { body: { ...base, result: { sent: true } } })).status, 409);
  assert.equal((await f.request('/bridge/result', { body: { ...base, error: 'sender rejected before permit' } })).status, 200);
  assert.equal((await pending).error.code, 'EXTENSION_FAILURE');
});

test('negative acknowledgements cannot revive a stopped or expired command', async t => {
  const f = await fixture(t); await f.pair(); f.bridge.beginRun();
  const stopped = capture(f.bridge.request('OPEN_CONTACT'));
  const first = (await f.poll()).command;
  f.bridge.cancel();
  assert.equal((await stopped).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.request('/bridge/result', { body: { id: first.id, epoch: first.epoch, error: { code: 'DOCUMENT_CHANGED', message: 'late' } } })).status, 409);
  f.bridge.beginRun();
  const expired = capture(f.bridge.request('OPEN_CONTACT'));
  const second = (await f.poll()).command;
  const originalNow = Date.now;
  try {
    Date.now = () => second.expiresAt;
    assert.equal((await f.request('/bridge/result', { body: { id: second.id, epoch: second.epoch, error: 'late' } })).status, 410);
  } finally { Date.now = originalNow; }
  assert.equal((await expired).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.poll()).command, null);
});

test('stopping rotates the epoch and prevents a delivered mutation from obtaining permission', async t => {
  const f = await fixture(t); await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('REQUEST_RESUME'));
  const { command } = await f.poll(); const oldEpoch = command.epoch;
  f.bridge.cancel(); assert.notEqual(f.bridge.snapshot().epoch, oldEpoch);
  const response = await f.request('/bridge/permit', { body: { id: command.id, epoch: oldEpoch } }); assert.ok(response.status >= 400);
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  const poll = await f.poll(); assert.equal(poll.active, false); assert.equal(poll.command, null);
});

test('pausing the controller denies a delivered send without rotating the epoch', async t => {
  const controller = { status: 'running' };
  const f = await fixture(t, { timeoutMs: 200, leaseMs: 120, canExecute: () => controller.status === 'running' });
  await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('SEND_GREETING', { greeting: 'fixture greeting' }));
  const { command } = await f.poll(); const body = { id: command.id, epoch: command.epoch };
  controller.status = 'paused';
  assert.equal((await f.request('/bridge/permit', { body })).status, 409);
  assert.equal(f.bridge.epoch, command.epoch); assert.equal(f.bridge.active, true);
  assert.equal((await f.request('/bridge/result', { body: { ...body, result: { sent: true } } })).status, 409);
  controller.status = 'running';
  // Denial must not secretly consume/grant a permit even after the controller
  // resumes; an unsolicited success still cannot be accepted.
  assert.equal((await f.request('/bridge/result', { body: { ...body, result: { sent: true } } })).status, 409);
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.poll()).command, null);
});

test('beginning another run rejects the old result rather than replaying the command', async t => {
  const f = await fixture(t); await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('OPEN_CONTACT'));
  const { command } = await f.poll(); f.bridge.beginRun();
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  const response = await f.request('/bridge/result', { body: { id: command.id, epoch: command.epoch, result: {} } }); assert.ok(response.status >= 400);
  assert.equal((await f.poll()).command, null);
});

test('lost mutation results become UNKNOWN_RESULT and never return to the queue', async t => {
  const f = await fixture(t, { timeoutMs: 200, leaseMs: 100 }); await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('CONFIRM_RESUME'));
  const { command } = await f.poll();
  const body = { id: command.id, epoch: command.epoch };
  assert.equal((await f.request('/bridge/permit', { body })).status, 200);
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.poll()).command, null);
  assert.ok((await f.request('/bridge/permit', { body })).status >= 400);
  assert.ok((await f.request('/bridge/result', { body: { ...body, result: { sent: true } } })).status >= 400);
});

test('a waiting authenticated poll wakes when a command is added', async t => {
  const f = await fixture(t, { pollMs: 1000 }); await f.pair();
  const connected = new Promise(resolve => f.bridge.once('connected', resolve));
  const waitingPoll = f.request('/bridge/poll', { method: 'GET' }); await connected;
  const pending = capture(f.bridge.request('INSPECT_PAGE'));
  const command = (await (await waitingPoll).json()).command; assert.equal(command.op, 'INSPECT_PAGE');
  assert.equal((await f.request('/bridge/result', { body: { id: command.id, epoch: command.epoch, result: { url: 'fixture' } } })).status, 200);
  assert.equal((await pending).result.url, 'fixture');
});

test('POST commands delivers the same queue while retaining strict origin authentication', async t => {
  const f = await fixture(t); await f.pair();
  const pending = capture(f.bridge.request('READ_CARDS'));
  let response = await f.request('/bridge/commands');
  assert.equal(response.status, 200);
  const { command } = await response.json(); assert.equal(command.op, 'READ_CARDS');
  response = await f.request('/bridge/result', { body: { id: command.id, epoch: command.epoch, result: { cards: [] } } }); assert.equal(response.status, 200);
  assert.deepEqual((await pending).result, { cards: [] });
  assert.equal((await (await f.request('/bridge/commands')).json()).command, null);
  response = await fetch(f.base + '/bridge/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-boss-bridge-token': f.token(), 'x-boss-instance': instanceId }, body: '{}' });
  assert.equal(response.status, 403);
});

test('POST commands accepts only an empty JSON body', async t => {
  const f = await fixture(t); await f.pair();
  const response = await f.request('/bridge/commands', { body: { op: 'EVAL' } });
  assert.equal(response.status, 400); assert.equal(f.bridge.isConnected(), false);
});

test('request arguments are snapshotted and independent queued reads keep their order', async t => {
  const f = await fixture(t); await f.pair();
  const args = { query: 'Java' };
  const first = capture(f.bridge.request('READ_CARDS', args));
  args.query = 'changed later';
  const second = capture(f.bridge.request('READ_DETAIL'));
  const one = (await f.poll()).command, two = (await f.poll()).command;
  assert.equal(one.args.query, 'Java'); assert.ok(two.seq > one.seq); assert.notEqual(one.id, two.id);
  for (const command of [one, two]) assert.equal((await f.request('/bridge/result', { body: { id: command.id, epoch: command.epoch, result: null } })).status, 200);
  assert.equal((await first).result, null); assert.equal((await second).result, null);
});

test('undelivered expired commands cannot obtain permission or report completion', async t => {
  const f = await fixture(t, { timeoutMs: 60, leaseMs: 25 }); await f.pair(); f.bridge.beginRun();
  const pending = capture(f.bridge.request('OPEN_CONTACT'));
  assert.equal((await pending).error.code, 'UNKNOWN_RESULT');
  assert.equal((await f.poll()).command, null);
});

test('STOP_SESSION remains available for cleanup after a cancellation', async t => {
  const f = await fixture(t); await f.pair(); f.bridge.cancel();
  const pending = capture(f.bridge.request('STOP_SESSION'));
  const { command, active } = await f.poll(); assert.equal(active, false); assert.equal(command.op, 'STOP_SESSION');
  const response = await f.request('/bridge/result', { body: { id: command.id, epoch: command.epoch, result: { stopped: true } } }); assert.equal(response.status, 200);
  assert.equal((await pending).result.stopped, true);
});

test('persisted pairing is private and survives restart without restoring an active run', async t => {
  const f = await fixture(t); await f.pair(); const epoch = f.bridge.snapshot().epoch;
  const file = join(f.dataDir, 'extension-bridge.json');
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(persisted.token === f.token()); assert.equal(persisted.instanceId, instanceId);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const restarted = new ExtensionBridge({ dataDir: f.dataDir }); t.after(() => restarted.cancel());
  assert.equal(restarted.snapshot().paired, true); assert.equal(restarted.isConnected(), false); assert.notEqual(restarted.snapshot().epoch, epoch);
  assert.equal(restarted.snapshot().pending, 0); await assert.rejects(restarted.request('OPEN_CONTACT'), error => error.code === 'BRIDGE_INACTIVE');
});

test('unpaired requests and unknown operations are rejected before queueing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.request('READ_CARDS'), error => error.code === 'EXTENSION_REQUIRED');
  await f.pair();
  await assert.rejects(f.bridge.request('EVAL', { code: 'anything' }));
  await assert.rejects(f.bridge.request('READ_CARDS', { callback() {} }));
  assert.equal(f.bridge.snapshot().pending, 0);
});

test('bridge routes reject unknown bodies and oversized packets without touching ordinary routes', async t => {
  const f = await fixture(t); await f.pair();
  let response = await f.request('/bridge/heartbeat', { body: { unexpected: true } }); assert.equal(response.status, 400);
  response = await f.request('/bridge/result', { body: { id: 'unknown', epoch: f.bridge.snapshot().epoch, result: 'x'.repeat(70_000) } }); assert.equal(response.status, 413);
  response = await f.request('/bridge/unknown', { method: 'GET' }); assert.equal(response.status, 404);
  response = await f.request('/api/status', { method: 'GET' }); assert.equal(await response.text(), 'regular route');
});

test('preflight grants only the permitted extension, route method and fixed headers', async t => {
  const f = await fixture(t); await f.pair();
  const headers = { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-boss-bridge-token,x-boss-instance' };
  let response = await fetch(f.base + '/bridge/result', { method: 'OPTIONS', headers }); assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  response = await fetch(f.base + '/bridge/result', { method: 'OPTIONS', headers: { ...headers, Origin: otherOrigin } }); assert.equal(response.status, 403);
  response = await fetch(f.base + '/bridge/result', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'DELETE' } }); assert.equal(response.status, 403);
  response = await fetch(f.base + '/bridge/result', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'x-unapproved' } }); assert.equal(response.status, 403);
});

test('only authenticated poll or heartbeat emits the first connected event', async t => {
  const f = await fixture(t); let count = 0; f.bridge.on('connected', () => count++);
  await f.pair(); assert.equal(count, 0);
  assert.equal((await f.request('/bridge/heartbeat', { headers: { 'x-boss-bridge-token': 'wrong' } })).status, 401); assert.equal(count, 0);
  assert.equal((await f.request('/bridge/heartbeat')).status, 200); assert.equal(count, 1);
  await f.poll(); assert.equal(count, 1);
});

test('a recovered heartbeat rotates the stale lease and emits connected again', async t => {
  const f = await fixture(t); await f.pair(); let count = 0; f.bridge.on('connected', () => count++);
  await f.request('/bridge/heartbeat'); f.bridge.beginRun(); const oldEpoch = f.bridge.epoch;
  const originalNow = Date.now; const advanced = originalNow() + 31_000;
  try {
    Date.now = () => advanced;
    assert.equal(f.bridge.isConnected(), false);
    assert.equal((await f.request('/bridge/heartbeat')).status, 200);
    assert.equal(f.bridge.isConnected(), true); assert.equal(count, 2);
    assert.notEqual(f.bridge.epoch, oldEpoch); assert.equal(f.bridge.active, false);
  } finally { Date.now = originalNow; }
});

test('damaged persisted credentials fail closed without replacement', async t => {
  const f = await fixture(t); const file = join(f.dataDir, 'extension-bridge.json');
  writeFileSync(file, '{broken', { mode: 0o600 });
  assert.throws(() => new ExtensionBridge({ dataDir: f.dataDir }));
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});
