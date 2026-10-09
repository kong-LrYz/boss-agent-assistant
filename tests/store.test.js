import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(dir) };
}

const job = { id: 'one', url: 'https://www.zhipin.com/job_detail/one.html?ka=a', title: '智能体实习生', company: '示例科技', city: '北京', description: 'Agent 研发', tags: ['实习'] };

test('persists normalized config independently of caller mutations', t => {
  const { dir, store } = temporaryStore(t);
  const config = store.saveConfig({ setupComplete: true, dailyLimit: 0, runLimit: '0', queries: ['AI Agent'] });
  config.queries.push('caller edit');
  assert.deepEqual(new Store(dir).loadConfig().queries, ['AI Agent']);
  assert.equal(store.loadConfig().setupComplete, true);
  assert.throws(() => store.saveConfig({ dailyLimit: -1 }));
  assert.equal(store.loadConfig().dailyLimit, 0);
});

test('stores tracking variants once and preserves stages and extra patch fields', t => {
  const { dir, store } = temporaryStore(t);
  const first = store.upsertJob(job, { greetingStatus: 'sent', resumeStatus: 'requested', evidence: { greeting: '会话可见' }, lastResumeCheckAt: '2026-10-07T00:00:00Z' });
  const changed = store.upsertJob({ ...job, url: `${job.url}&lid=other`, title: '智能体开发实习生' });
  assert.equal(store.listJobs().length, 1);
  assert.equal(changed.key, 'job:one');
  assert.equal(changed.createdAt, first.createdAt);
  assert.equal(changed.greetingStatus, 'sent');
  assert.equal(changed.resumeStatus, 'requested');
  assert.equal(changed.lastResumeCheckAt, '2026-10-07T00:00:00Z');
  assert.deepEqual(new Store(dir).getJob('job:one').evidence, { greeting: '会话可见' });
  changed.evidence.greeting = 'changed outside';
  assert.equal(store.getJob('job:one').evidence.greeting, '会话可见');
  assert.equal(store.getJob('does-not-exist'), undefined);
  assert.equal(store.getJob('toString'), undefined);
});

test('recovers unfinished greeting and resume intents to uncertain durably', t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job, { greetingStatus: 'intent', resumeStatus: 'intent' });
  const recovered = new Store(dir).getJob('job:one');
  assert.equal(recovered.greetingStatus, 'uncertain');
  assert.equal(recovered.resumeStatus, 'uncertain');
  assert.ok(recovered.contactedAt);
  assert.match(recovered.note, /中断|未确认|核对/);
  assert.equal(new Store(dir).getJob('job:one').resumeStatus, 'uncertain');
});

test('requested resume is not relabeled sent on restart', t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job, { greetingStatus: 'existing', resumeStatus: 'requested' });
  const recovered = new Store(dir).getJob('job:one');
  assert.equal(recovered.greetingStatus, 'existing');
  assert.equal(recovered.resumeStatus, 'requested');
});

test('rejects invalid statuses before changing persisted or in-memory state', t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job);
  assert.throws(() => store.upsertJob(job, { greetingStatus: 'done' }));
  assert.equal(store.getJob('job:one').greetingStatus, 'none');
  assert.equal(new Store(dir).getJob('job:one').greetingStatus, 'none');
});

test('state write failure rejects mutation and keeps previous memory state', t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job);
  fs.renameSync(path.join(dir, 'state.json'), path.join(dir, 'state.saved.json'));
  fs.mkdirSync(path.join(dir, 'state.json'));
  assert.throws(() => store.upsertJob(job, { greetingStatus: 'intent' }));
  assert.equal(store.getJob('job:one').greetingStatus, 'none');
  assert.equal(store.getJob('job:one').contactedAt, null);
});

for (const phase of ['write', 'file flush', 'rename']) {
  for (const mutation of ['event', 'intent']) {
    test(`${phase} failure removes its temporary snapshot without committing ${mutation}`, t => {
      const { dir, store } = temporaryStore(t);
      store.upsertJob(job, { resumeStatus: 'uncertain' });
      const stateFile = path.join(dir, 'state.json');
      const previous = fs.readFileSync(stateFile);
      const failure = Object.assign(new Error(`injected ${phase} failure`), { code: 'EIO' });
      const original = { write: fs.writeFileSync, flush: fs.fsyncSync, rename: fs.renameSync };
      try {
        if (phase === 'write') fs.writeFileSync = (...args) => { original.write(...args); throw failure; };
        if (phase === 'file flush') fs.fsyncSync = () => { throw failure; };
        if (phase === 'rename') fs.renameSync = () => { throw failure; };
        assert.throws(() => mutation === 'event'
          ? store.appendEvent({ type: 'error', message: 'temporary fixture' })
          : store.upsertJob(job, { greetingStatus: 'intent' }), error => error.cause === failure);
      } finally {
        fs.writeFileSync = original.write;
        fs.fsyncSync = original.flush;
        fs.renameSync = original.rename;
      }
      assert.deepEqual(fs.readFileSync(stateFile), previous);
      assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
      assert.equal(store.listEvents(500).length, 0);
      assert.equal(store.getJob('job:one').greetingStatus, 'none');
      assert.equal(new Store(dir).getJob('job:one').resumeStatus, 'uncertain');
    });
  }
}

test('cleanup close failure preserves the original write error and removes the snapshot', t => {
  const { dir, store } = temporaryStore(t);
  const original = { write: fs.writeFileSync, close: fs.closeSync };
  const failure = Object.assign(new Error('original write failed'), { code: 'EIO' });
  try {
    fs.writeFileSync = () => { throw failure; };
    fs.closeSync = descriptor => { original.close(descriptor); throw new Error('cleanup close failed'); };
    assert.throws(() => store.appendEvent({ message: 'not committed' }), error => error.cause === failure);
  } finally {
    fs.writeFileSync = original.write;
    fs.closeSync = original.close;
  }
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  assert.equal(new Store(dir).listEvents(500).length, 0);
});

test('cleanup unlink failure preserves the original save error and committed state', t => {
  const { dir, store } = temporaryStore(t);
  const original = { rename: fs.renameSync, unlink: fs.unlinkSync };
  const stateFile = path.join(dir, 'state.json');
  const previous = fs.readFileSync(stateFile);
  const failure = Object.assign(new Error('original rename failed'), { code: 'EIO' });
  try {
    fs.renameSync = () => { throw failure; };
    fs.unlinkSync = () => { throw new Error('cleanup unlink failed'); };
    assert.throws(() => store.appendEvent({ message: 'not committed' }), error => error.cause === failure);
  } finally {
    fs.renameSync = original.rename;
    fs.unlinkSync = original.unlink;
  }
  assert.deepEqual(fs.readFileSync(stateFile), previous);
  assert.equal(store.listEvents(500).length, 0);
});

test('exclusive creation collision preserves the file owned by another writer', t => {
  const { dir, store } = temporaryStore(t);
  const originalOpen = fs.openSync;
  let foreign;
  try {
    fs.openSync = (target, flags, ...args) => {
      if (flags === 'wx') {
        foreign = target;
        fs.writeFileSync(target, 'other writer owns this file');
      }
      return originalOpen(target, flags, ...args);
    };
    assert.throws(() => store.appendEvent({ message: 'not committed' }), error => error.cause?.code === 'EEXIST');
  } finally { fs.openSync = originalOpen; }
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'other writer owns this file');
  assert.equal(new Store(dir).listEvents(500).length, 0);
});

test('directory flush failure keeps the replaced snapshot and recovers its unconfirmed intent', { skip: process.platform === 'win32' }, t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job);
  const originalFlush = fs.fsyncSync;
  const failure = Object.assign(new Error('directory flush failed'), { code: 'EIO' });
  try {
    fs.fsyncSync = descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw failure;
      return originalFlush(descriptor);
    };
    assert.throws(() => store.upsertJob(job, { greetingStatus: 'intent', resumeStatus: 'intent' }), error => error.cause === failure);
  } finally { fs.fsyncSync = originalFlush; }
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  assert.equal(store.getJob('job:one').greetingStatus, 'none');
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(persisted.jobs['job:one'].greetingStatus, 'intent');
  const recovered = new Store(dir).getJob('job:one');
  assert.equal(recovered.greetingStatus, 'uncertain');
  assert.equal(recovered.resumeStatus, 'uncertain');
});

test('directory cleanup close failure preserves the original directory flush error', { skip: process.platform === 'win32' }, t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job);
  const original = { flush: fs.fsyncSync, close: fs.closeSync };
  const failure = Object.assign(new Error('original directory flush failed'), { code: 'EIO' });
  try {
    fs.fsyncSync = descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw failure;
      return original.flush(descriptor);
    };
    fs.closeSync = descriptor => {
      const directory = fs.fstatSync(descriptor).isDirectory();
      original.close(descriptor);
      if (directory) throw new Error('directory cleanup close failed');
    };
    assert.throws(() => store.upsertJob(job, { greetingStatus: 'intent' }), error => error.cause === failure);
  } finally {
    fs.fsyncSync = original.flush;
    fs.closeSync = original.close;
  }
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  assert.equal(new Store(dir).getJob('job:one').greetingStatus, 'uncertain');
});

test('corrupted state and config never silently become fresh data', t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job);
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  assert.throws(() => new Store(dir), /state|状态|损坏|JSON/i);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: {}, events: [] }));
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  assert.throws(() => new Store(dir).loadConfig(), /config|配置|损坏|JSON/i);
});

test('missing state in a configured installation never forgets previous contacts', t => {
  const { dir, store } = temporaryStore(t);
  store.saveConfig({ setupComplete: true });
  store.upsertJob(job, { greetingStatus: 'sent' });
  fs.renameSync(path.join(dir, 'state.json'), path.join(dir, 'state.saved.json'));
  assert.throws(() => new Store(dir), /状态|state|丢失|缺少/);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('unsupported persisted schemas are rejected', t => {
  const { dir } = temporaryStore(t);
  for (const value of [{}, [], { version: 999, jobs: {}, events: [] }, { version: 1, jobs: [], events: [] }]) {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(value));
    assert.throws(() => new Store(dir));
  }
});

test('mismatched persisted record identity is treated as damaged state', t => {
  const { dir, store } = temporaryStore(t);
  const record = store.upsertJob(job);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: { 'job:wrong': { ...record, key: 'job:wrong' } }, events: [] }));
  assert.throws(() => new Store(dir), /身份|标识|无效|损坏/);
});

test('counts uncertain contact reservations across Hong Kong date boundaries', t => {
  const { store } = temporaryStore(t);
  store.upsertJob(job, { greetingStatus: 'uncertain', contactedAt: '2026-10-06T16:00:00Z' });
  store.upsertJob({ ...job, id: 'two', url: '/job_detail/two.html' }, { greetingStatus: 'sent', contactedAt: '2026-10-06T15:59:59Z' });
  store.upsertJob({ ...job, id: 'three', url: '/job_detail/three.html' }, { greetingStatus: 'existing' });
  assert.equal(store.dailyContacts(new Date('2026-10-07T00:00:00Z')), 1);
  assert.equal(store.dailyContacts(new Date('2026-10-06T00:00:00Z')), 1);
});

test('limits event history without dropping job records', t => {
  const { dir, store } = temporaryStore(t);
  store.upsertJob(job);
  for (let i = 0; i < 505; i++) store.appendEvent({ type: 'test', message: `event-${i}` });
  const reopened = new Store(dir);
  assert.equal(reopened.listEvents(1000).length, 500);
  assert.equal(reopened.listEvents(1)[0].message, 'event-504');
  assert.equal(reopened.listEvents(0).length, 0);
  assert.equal(reopened.listJobs().length, 1);
});

test('bounds each event without truncating job records or unfinished intent evidence', t => {
  const { dir, store } = temporaryStore(t);
  const evidence = { proof: '证'.repeat(20_000), securityIdentity: 'retained-identity' };
  store.upsertJob(job, { greetingStatus: 'intent', resumeStatus: 'intent', evidence });
  const event = store.appendEvent({ type: 'error', message: '异常'.repeat(100_000), key: 'job:one', evidence, diagnostic: { arrays: Array.from({ length: 500 }, () => ({ giant: 'x'.repeat(5000) })) } });
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 8192);
  assert.equal(event.type, 'error');
  assert.equal(event.key, 'job:one');
  assert.equal(event.truncated, true);
  assert.ok(!event.message.includes('\uFFFD'));
  const reopened = new Store(dir);
  assert.equal(reopened.getJob('job:one').greetingStatus, 'uncertain');
  assert.equal(reopened.getJob('job:one').resumeStatus, 'uncertain');
  assert.deepEqual(reopened.getJob('job:one').evidence, evidence);
});

test('startup compacts prior oversized event logs while preserving every durable job', t => {
  const { dir, store } = temporaryStore(t);
  const record = store.upsertJob(job, { greetingStatus: 'sent', evidence: { proof: 'retained' } });
  const stateFile = path.join(dir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.events = Array.from({ length: 510 }, (_, i) => ({ id: `old-${i}`, at: '2026-10-07T00:00:00Z', type: 'error', message: 'x'.repeat(20_000) }));
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const reopened = new Store(dir);
  assert.equal(reopened.listEvents(1000).length, 500);
  assert.equal(reopened.listEvents(1)[0].id, 'old-509');
  assert.ok(reopened.listEvents(1000).every(event => Buffer.byteLength(JSON.stringify(event)) <= 8192));
  assert.deepEqual(reopened.getJob('job:one'), record);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(Buffer.byteLength(JSON.stringify(persisted.events)) < 4_200_000);
  assert.equal(persisted.jobs['job:one'].greetingStatus, 'sent');
});

test('stored personal data has restrictive Unix permissions', { skip: process.platform === 'win32' }, t => {
  const { dir, store } = temporaryStore(t);
  store.saveConfig({});
  store.upsertJob(job);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of ['state.json', 'config.json']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
});

test('Windows persistence avoids directory flushing and still rejects file flush failures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-win-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    const originalOpen = fs.openSync;
    const originalFlush = fs.fsyncSync;
    let fileFlushes = 0;
    fs.openSync = (target, ...args) => {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        throw Object.assign(new Error('Windows cannot open a directory for fsync'), { code: 'EISDIR' });
      }
      return originalOpen(target, ...args);
    };
    fs.fsyncSync = descriptor => {
      assert.equal(fs.fstatSync(descriptor).isFile(), true);
      fileFlushes++;
      return originalFlush(descriptor);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = new Store(process.env.BOSS_STORE_TEST_DIR);
    store.saveConfig({ setupComplete: true });
    store.upsertJob({ id: 'portable', title: 'Agent 实习生', city: '北京' });
    store.appendEvent({ message: 'portable write' });
    const reopened = new Store(process.env.BOSS_STORE_TEST_DIR);
    assert.equal(reopened.loadConfig().setupComplete, true);
    assert.equal(reopened.getJob('job:portable').title, 'Agent 实习生');
    assert.equal(reopened.listEvents(1)[0].message, 'portable write');
    assert.ok(fileFlushes >= 4);
    fs.fsyncSync = () => { throw Object.assign(new Error('file flush failed'), { code: 'EIO' }); };
    assert.throws(() => store.upsertJob({ id: 'portable' }, { greetingStatus: 'intent' }), /保存.*失败/);
    assert.equal(store.getJob('job:portable').greetingStatus, 'none');
    fs.fsyncSync = originalFlush;
    assert.equal(new Store(process.env.BOSS_STORE_TEST_DIR).getJob('job:portable').greetingStatus, 'none');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, BOSS_STORE_TEST_DIR: dir }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('CSV escapes newlines, quotes and spreadsheet formula cells', t => {
  const { store } = temporaryStore(t);
  store.upsertJob({ ...job, title: '=HYPERLINK("evil")', company: '多行\n公司' }, { note: '他说："好"' });
  const csv = store.exportCsv();
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"多行\n公司"'));
  assert.ok(csv.includes('"他说：""好"""'));
});

test('company goals count unique confirmed records across restart without counting requests or old greetings', t => {
  const { dir, store } = temporaryStore(t);
  const put = (id, company, greetingStatus, resumeStatus) => store.upsertJob({ ...job, id, url: `/job_detail/${id}.html`, company }, { greetingStatus, resumeStatus });
  put('one', ' ACME  科技 ', 'sent', 'requested');
  put('two', 'ＡＣＭＥ 科技', 'sent', 'sent');
  put('three', '其他科技', 'existing', 'sent');
  put('four', '未知科技', 'uncertain', 'unavailable');
  put('five', '', 'sent', 'sent');
  assert.equal(typeof store.companyCounts, 'function');
  assert.deepEqual(store.companyCounts(), { contactedCompanies: 1, deliveredCompanies: 2 });
  assert.equal(store.hasContactedCompany('acme　科技'), true);
  assert.equal(store.hasContactedCompany('其他科技'), true);
  assert.equal(store.hasContactedCompany('未知科技'), true);
  assert.equal(store.hasContactedCompany(''), false);
  const reopened = new Store(dir);
  assert.deepEqual(reopened.companyCounts(), { contactedCompanies: 1, deliveredCompanies: 2 });
  assert.equal(reopened.listJobs().length, 5);
});

test('company reservations retain unresolved intents across restart and release only after an explicit state correction', t => {
  const { store, dir } = temporaryStore(t);
  store.upsertJob({ ...job, id: 'reservation1', url: '/job_detail/reservation1.html', company: ' ＡＣＭＥ　科技 ' }, { greetingStatus: 'intent', resumeStatus: 'intent' });
  store.upsertJob({ ...job, id: 'reservation2', url: '/job_detail/reservation2.html', company: 'ACME  科技' }, { greetingStatus: 'uncertain', resumeStatus: 'uncertain' });
  store.upsertJob({ ...job, id: 'existingOnly', url: '/job_detail/existingOnly.html', company: '旧沟通' }, { greetingStatus: 'existing', resumeStatus: 'requested' });
  const reopened = new Store(dir);
  const reserved = reopened.companyReservations();
  assert.deepEqual([...reserved.contactCompanies], ['acme 科技']);
  assert.deepEqual([...reserved.resumeCompanies], ['acme 科技']);
  assert.deepEqual(reopened.companyCounts(), { contactedCompanies: 0, deliveredCompanies: 0 });
  reserved.contactCompanies.clear();
  assert.equal(reopened.companyReservations().contactCompanies.size, 1);
  for (const id of ['reservation1', 'reservation2']) reopened.upsertJob(reopened.getJob(`job:${id}`), { greetingStatus: 'none', resumeStatus: 'none' });
  assert.equal(reopened.companyReservations().contactCompanies.size, 0);
  assert.equal(reopened.companyReservations().resumeCompanies.size, 0);
});
