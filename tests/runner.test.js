import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';
import { defaultConfig } from '../src/core.js';

const job = { id: 'job1', url: 'https://www.zhipin.com/job_detail/job1.html', title: 'AI Agent 开发实习生', company: '示例公司', city: '北京', description: '用 Python、LangGraph 开发智能体', tags: ['实习'] };
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'boss-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.saveConfig({ ...defaultConfig, setupComplete: true, ...overrides });
  const browser = {
    async open() {}, async close() {}, async login() {},
    async discover() { return [{ ...job }]; }, async details(j) { return j; },
    async contact(j, { onStage }) {
      await onStage('before_greeting', { greetingStatus: 'intent' });
      await onStage('greeting_confirmed', { greetingStatus: 'sent' });
      await onStage('before_resume', { resumeStatus: 'intent' });
      await onStage('resume_confirmed', { resumeStatus: 'requested' });
      return { greetingStatus: 'sent', resumeStatus: 'requested', note: '等对方同意' };
    }
  };
  return { store, browser, runner: new Runner({ store, browser, idleMs: 1, delayMs: 0 }) };
}

function greetingTrialFixture(t, overrides = {}) {
  const value = fixture(t, { queries: ['must-not-search'], ...overrides });
  const targets = Array.from({ length: 5 }, (_, index) => ({ ...job, id: `greeting-trial-${index}`, url: `https://www.zhipin.com/job_detail/greeting-trial-${index}.html`, company: `实测公司${index}` }));
  for (const target of targets) value.store.upsertJob(target, { eligible: true, greetingStatus: 'none', resumeStatus: 'none' });
  const keys = targets.map(target => `job:${target.id}`), calls = [];
  value.browser.discover = async () => { throw Error('bounded trial must not discover jobs'); };
  // If the scope branch is absent, ordinary discovery pauses. End that failed
  // invocation so the test reports the wrong branch instead of hanging.
  value.runner.on('paused', () => { value.runner.stop(); });
  value.browser.contact = async (target, options) => {
    calls.push({ id: target.id, greeting: options.greeting, sendResume: options.sendResume, resumeOnly: options.resumeOnly, deferred: options.deferResumeAfterGreeting });
    await options.onStage('greeting intent', { greetingStatus: 'intent' });
    assert.equal(value.store.getJob(`job:${target.id}`).greetingStatus, 'intent');
    await options.onStage('greeting confirmed', { greetingStatus: 'sent' });
    return { greetingStatus: 'sent', resumeStatus: 'none', resumeSkipped: true };
  };
  return { ...value, targets, keys, calls };
}

test('bounded greeting preview refreshes exactly selected stale eligibility without contacting anyone', async t => {
  const { store, browser, runner, keys, targets, calls } = greetingTrialFixture(t);
  store.upsertJob(targets[1], { eligible: false });
  const details = [], before = store.loadConfig();
  browser.details = async target => { details.push(target.id); return target; };
  await runner.start({ greetingJobKeys: [keys[1], keys[3]], greetingTestText: '您好，我对这个岗位感兴趣。' });
  assert.deepEqual(details, ['greeting-trial-1', 'greeting-trial-3']);
  assert.equal(calls.length, 0);
  assert.equal(store.getJob(keys[1]).eligible, true);
  for (const key of keys) assert.deepEqual([store.getJob(key).greetingStatus, store.getJob(key).resumeStatus], ['none', 'none']);
  assert.deepEqual(store.loadConfig(), before);
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(runner.snapshot().performance.detailReads, 2);
  assert.equal(runner.snapshot().performance.verifiedNewContacts, 0);
  assert.deepEqual(runner.snapshot().greetingTest, { preview: true, requested: 2, inspected: 2, eligible: 2, attempted: 0, confirmed: 0 });
});

test('bounded greeting trial sends only five frozen recipients once with exact greeting and no attachment queue', async t => {
  const { store, runner, keys, targets, calls } = greetingTrialFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 1 });
  store.upsertJob({ ...job, id: 'already-goal', url: 'https://www.zhipin.com/job_detail/already-goal.html' }, { eligible: true, greetingStatus: 'sent', resumeStatus: 'sent' });
  store.upsertJob({ ...job, id: 'pending-attachment', url: 'https://www.zhipin.com/job_detail/pending-attachment.html' }, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  const mutableKeys = [...keys], text = '您好，我对 AI Agent 开发岗位感兴趣，希望了解工作内容，谢谢。', config = store.loadConfig();
  const task = runner.start({ greetingJobKeys: mutableKeys, greetingTestText: text, greetingTestPreview: false, once: false });
  mutableKeys.splice(0, mutableKeys.length, 'job:pending-attachment');
  await task;
  assert.deepEqual(calls.map(call => call.id), targets.map(target => target.id));
  assert.ok(calls.every(call => call.greeting === text && call.sendResume === false && call.resumeOnly === false && call.deferred === false));
  for (const key of keys) assert.deepEqual([store.getJob(key).greetingStatus, store.getJob(key).resumeStatus], ['sent', 'none']);
  assert.equal(store.getJob('job:pending-attachment').resumeStatus, 'none');
  assert.deepEqual(store.loadConfig(), config);
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(runner.snapshot().performance.verifiedNewContacts, 5);
  assert.deepEqual(runner.snapshot().greetingTest, { preview: false, requested: 5, inspected: 5, eligible: 5, attempted: 5, confirmed: 5 });
  assert.throws(() => runner.start({ greetingJobKeys: keys, greetingTestText: text, greetingTestPreview: false }), /招呼|岗位|记录/u);
});

test('bounded greeting trial rejects invalid scope before starting the browser', async t => {
  const { browser, runner, keys } = greetingTrialFixture(t);
  let opened = 0; browser.open = async () => { opened++; };
  const valid = { greetingJobKeys: [keys[0]], greetingTestText: '您好' };
  for (const patch of [{ greetingJobKeys: [] }, { greetingJobKeys: [...keys, 'job:sixth'] }, { greetingJobKeys: [keys[0], keys[0]] }, { greetingJobKeys: ['https://www.zhipin.com/job_detail/greeting-trial-0.html'] }, { greetingJobKeys: [null] }, { greetingJobKeys: ['job:missing'] }, { greetingTestText: '' }, { greetingTestText: 'x'.repeat(501) }, { greetingTestText: null }, { greetingTestText: 'hello\0world' }, { greetingTestPreview: 'false' }, { resumeJobKey: keys[0] }, { inspectResumeOnly: true }]) assert.throws(() => runner.start({ ...valid, ...patch }));
  assert.equal(opened, 0);
});

for (const [greetingStatus, resumeStatus] of [['sent', 'none'], ['existing', 'none'], ['intent', 'none'], ['uncertain', 'none'], ['none', 'sent'], ['none', 'requested'], ['none', 'intent'], ['none', 'uncertain']]) test(`bounded greeting trial rejects prior ${greetingStatus}/${resumeStatus} record`, t => {
  const { store, browser, runner, keys, targets } = greetingTrialFixture(t);
  store.upsertJob(targets[0], { greetingStatus, resumeStatus });
  let opened = 0; browser.open = async () => { opened++; };
  assert.throws(() => runner.start({ greetingJobKeys: [keys[0]], greetingTestText: '您好' }));
  assert.equal(opened, 0);
  assert.deepEqual([store.getJob(keys[0]).greetingStatus, store.getJob(keys[0]).resumeStatus], [greetingStatus, resumeStatus]);
});

test('bounded greeting live trial requires refreshed stored eligibility and fresh eligibility before sending', async t => {
  const { store, browser, runner, keys, targets, calls } = greetingTrialFixture(t);
  store.upsertJob(targets[0], { eligible: false });
  assert.throws(() => runner.start({ greetingJobKeys: [keys[0]], greetingTestText: '您好', greetingTestPreview: false }));
  browser.details = async target => ({ ...target, city: '上海' });
  store.upsertJob(targets[0], { eligible: true });
  await runner.start({ greetingJobKeys: [keys[0]], greetingTestText: '您好', greetingTestPreview: false });
  assert.equal(calls.length, 0);
  assert.equal(store.getJob(keys[0]).eligible, false);
  assert.equal(store.getJob(keys[0]).greetingStatus, 'none');
});

for (const changed of ['state', 'identity']) test(`bounded greeting trial refuses a ${changed} change during fresh details`, async t => {
  const { store, browser, runner, keys, targets, calls } = greetingTrialFixture(t);
  browser.details = async target => {
    if (changed === 'state') store.upsertJob(targets[0], { greetingStatus: 'uncertain' });
    return changed === 'identity' ? { ...target, company: '另一收件人公司' } : target;
  };
  await runner.start({ greetingJobKeys: [keys[0], keys[1]], greetingTestText: '您好', greetingTestPreview: false });
  assert.equal(calls.length, 0);
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(store.getJob(keys[1]).greetingStatus, 'none');
  assert.equal(store.getJob(keys[0]).greetingStatus, changed === 'state' ? 'uncertain' : 'none');
});

test('bounded greeting trial rejects resume intent before any attachment effect', async t => {
  const { store, browser, runner, keys } = greetingTrialFixture(t);
  let effects = 0;
  browser.contact = async (_target, options) => { await options.onStage('wrong attachment', { resumeStatus: 'intent' }); effects++; return { greetingStatus: 'sent', resumeStatus: 'sent' }; };
  await runner.start({ greetingJobKeys: [keys[0], keys[1]], greetingTestText: '您好', greetingTestPreview: false });
  assert.equal(effects, 0);
  assert.equal(runner.snapshot().status, 'error');
  for (const key of keys) assert.deepEqual([store.getJob(key).greetingStatus, store.getJob(key).resumeStatus], ['none', 'none']);
});

test('bounded greeting trial cannot overwrite a changed durable state while awaiting the result', async t => {
  const { store, browser, runner, keys, targets } = greetingTrialFixture(t);
  let attempts = 0;
  browser.contact = async (_target, { onStage }) => {
    attempts++;
    await onStage('greeting intent', { greetingStatus: 'intent' });
    store.upsertJob(targets[0], { greetingStatus: 'uncertain' });
    return { greetingStatus: 'sent', resumeStatus: 'none' };
  };
  await runner.start({ greetingJobKeys: keys, greetingTestText: '您好', greetingTestPreview: false });
  assert.equal(attempts, 1);
  assert.equal(store.getJob(keys[0]).greetingStatus, 'uncertain');
  assert.equal(store.getJob(keys[1]).greetingStatus, 'none');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().performance.verifiedNewContacts, 0);
});

for (const preview of [true, false]) test(`bounded greeting ${preview ? 'preview' : 'live trial'} enters fail-fast adapter context without changing normal runs`, async t => {
  const { browser, runner, keys, calls } = greetingTrialFixture(t);
  let entered = 0, active = false;
  browser.withFailFastReads = async function (operation) {
    assert.equal(this, browser);
    entered++; active = true;
    try { return await operation(); } finally { active = false; }
  };
  browser.open = async () => { assert.equal(active, true); };
  browser.login = async () => { assert.equal(active, true); return { loggedIn: true }; };
  browser.details = async target => { assert.equal(active, true); return target; };
  const contact = browser.contact;
  browser.contact = async (...args) => { assert.equal(active, true); return contact(...args); };
  await runner.start({ greetingJobKeys: [keys[0]], greetingTestText: '您好', greetingTestPreview: preview });
  assert.equal(entered, 1);
  assert.equal(active, false);
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(calls.length, preview ? 0 : 1);
  browser.open = async () => { assert.equal(active, false); };
  browser.login = async () => { assert.equal(active, false); };
  browser.details = async target => { assert.equal(active, false); return target; };
  browser.discover = async () => [];
  await runner.start({ preview: true });
  assert.equal(entered, 1);
  assert.equal(runner.snapshot().status, 'completed');
});

for (const code of ['RATE_LIMIT', 'CAPTCHA', 'DOCUMENT_CHANGED', 'UNKNOWN_RESULT']) test(`bounded greeting trial ends on ${code} without pausing, retrying or touching the next recipient`, async t => {
  const { store, browser, runner, keys } = greetingTrialFixture(t);
  let attempts = 0, paused = 0;
  runner.on('paused', () => { paused++; });
  browser.contact = async (_target, { onStage }) => { attempts++; await onStage('greeting intent', { greetingStatus: 'intent' }); throw Object.assign(Error('measured flow must end'), { code }); };
  await runner.start({ greetingJobKeys: keys, greetingTestText: '您好', greetingTestPreview: false });
  runner.resume();
  assert.equal(attempts, 1);
  assert.equal(paused, 0);
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, code);
  assert.deepEqual([store.getJob(keys[0]).greetingStatus, store.getJob(keys[0]).resumeStatus], ['uncertain', 'none']);
  assert.equal(store.getJob(keys[1]).greetingStatus, 'none');
  assert.equal(runner.snapshot().greetingTest.attempted, 1);
});

test('bounded greeting trial preserves unknown result and cannot resume or resend it', async t => {
  const { store, browser, runner, keys } = greetingTrialFixture(t);
  let attempts = 0;
  browser.contact = async (_target, { onStage }) => { attempts++; await onStage('greeting intent', { greetingStatus: 'intent' }); await onStage('unknown', { greetingStatus: 'uncertain' }); return { greetingStatus: 'uncertain', resumeStatus: 'none' }; };
  await runner.start({ greetingJobKeys: keys, greetingTestText: '您好', greetingTestPreview: false });
  runner.resume();
  assert.equal(attempts, 1);
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(store.getJob(keys[0]).greetingStatus, 'uncertain');
  assert.throws(() => runner.start({ greetingJobKeys: [keys[0]], greetingTestText: '您好', greetingTestPreview: false }));
});
function timedFixture(t, config = {}, { delayMs = 20, batchBreakMs = 100, actualSleep = ms => ms } = {}) {
  const { store, browser } = fixture(t, { queries: ['AI Agent'], ...config });
  let clock = 0;
  const sleepCalls = [], waitCalls = [];
  const runner = new Runner({ store, browser, idleMs: 1, delayMs, batchBreakMs,
    now: () => clock,
    sleep: async (ms, signal) => { assert.equal(signal.aborted, false); sleepCalls.push(ms); clock += actualSleep(ms); },
  });
  const wait = runner.wait.bind(runner);
  runner.wait = async (ms, kind) => { waitCalls.push(ms); return wait(ms, kind); };
  return { store, browser, runner, sleepCalls, waitCalls, tick: ms => { clock += ms; } };
}
const companyJob = (id, company = `${id}科技`) => ({ ...job, id, url: `/job_detail/${id}.html`, company });
function goalFixture(t, config = {}, cards = []) {
  const state = timedFixture(t, config);
  state.effects = [];
  state.options = [];
  state.browser.discover = async () => cards;
  state.browser.contact = async (input, options) => {
    state.options.push({ id: input.id, resumeOnly: options.resumeOnly, sendResume: options.sendResume });
    if (!options.resumeOnly) {
      await options.onStage('greeting-intent', { greetingStatus: 'intent' });
      assert.equal(state.store.getJob(`job:${input.id}`).greetingStatus, 'intent');
      state.effects.push(`greeting:${input.id}`);
      await options.onStage('greeting-sent', { greetingStatus: 'sent' });
    }
    if (options.sendResume !== false) {
      await options.onStage('resume-intent', { resumeStatus: 'intent' });
      assert.equal(state.store.getJob(`job:${input.id}`).resumeStatus, 'intent');
      state.effects.push(`resume:${input.id}`);
      await options.onStage('resume-sent', { resumeStatus: 'sent' });
    }
    return { greetingStatus: options.resumeOnly ? 'existing' : 'sent', resumeStatus: options.sendResume === false ? 'none' : 'sent', ...(options.sendResume === false ? { resumeSkipped: true } : {}) };
  };
  return state;
}

test('single resume verification ignores discovery and every other pending record', async t => {
  const { store, browser, runner } = goalFixture(t, {}, [companyJob('new-job')]);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable' });
  store.upsertJob(companyJob('other-pending'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  const config = store.loadConfig();
  browser.discover = async () => { throw new Error('single verification must not search'); };
  let closed = 0;
  browser.close = async () => { closed++; };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1', once: true });
  assert.equal(store.getJob('job:job1').resumeStatus, 'sent');
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:other-pending').resumeStatus, 'none');
  assert.equal(store.getJob('job:new-job'), undefined);
  assert.equal(runner.snapshot().performance.verifiedNewContacts, 0);
  assert.equal(runner.snapshot().cycle, 1);
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(closed, 1);
  assert.deepEqual(store.loadConfig(), config);
});

test('single resume verification cannot be turned into preview or a repeating loop', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'existing', resumeStatus: 'requested' });
  browser.discover = async () => [];
  let calls = 0;
  browser.contact = async (_job, options) => {
    calls++;
    assert.equal(options.resumeOnly, true);
    return { greetingStatus: 'existing', resumeStatus: 'unavailable' };
  };
  // A broken implementation would wait after the first scan; stop it so RED
  // reports the observed scope breach instead of hanging the test suite.
  runner.once('waiting', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1', once: false, preview: true });
  assert.equal(calls, 1);
  assert.equal(runner.snapshot().cycle, 1);
  assert.equal(runner.snapshot().mode, 'resume-verification');
  assert.equal(runner.snapshot().status, 'completed');
});

for (const [name, key, patch] of [
  ['missing record', 'job:absent', null],
  ['invalid key', null, null],
  ['ineligible record', 'job:job1', { eligible: false, greetingStatus: 'sent', resumeStatus: 'none' }],
  ['uncontacted record', 'job:job1', { eligible: true, greetingStatus: 'none', resumeStatus: 'none' }],
  ['uncertain greeting', 'job:job1', { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'none' }],
  ['uncertain resume', 'job:job1', { eligible: true, greetingStatus: 'sent', resumeStatus: 'uncertain' }],
  ['unresolved resume intent', 'job:job1', { eligible: true, greetingStatus: 'sent', resumeStatus: 'intent' }],
  ['already sent resume', 'job:job1', { eligible: true, greetingStatus: 'sent', resumeStatus: 'sent' }],
]) test(`single resume verification rejects ${name} before opening any browser`, async t => {
  const { store, browser, runner } = goalFixture(t);
  if (patch) store.upsertJob(job, patch);
  let opens = 0;
  browser.open = async () => { opens++; };
  assert.throws(() => runner.start({ resumeJobKey: key, once: true }), /岗位|附件|记录/u);
  assert.equal(opens, 0);
  assert.equal(runner.task, null);
});

test('single resume verification refuses to attach to a running normal campaign', async t => {
  const { store, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  runner.task = Promise.resolve();
  assert.throws(() => runner.start({ resumeJobKey: 'job:job1' }), /停止|运行/u);
});

test('single resume verification still respects a delivered-company goal', async t => {
  const { store, browser, runner } = goalFixture(t, { resumeCompanyTarget: 1 });
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  store.upsertJob(companyJob('already-delivered'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'sent' });
  let opens = 0, contacts = 0;
  browser.open = async () => { opens++; };
  browser.contact = async () => { contacts++; throw Error('goal already reached'); };
  await runner.start({ resumeJobKey: 'job:job1' });
  assert.equal(opens, 0);
  assert.equal(contacts, 0);
  assert.equal(store.getJob('job:job1').resumeStatus, 'none');
});

test('single resume verification rejects a new greeting stage before it becomes an effect', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  browser.discover = async () => [];
  let effects = 0;
  browser.contact = async (_job, { onStage }) => {
    await onStage('unexpected greeting intent', { greetingStatus: 'intent' });
    effects++;
    return { greetingStatus: 'sent', resumeStatus: 'none' };
  };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1', once: true });
  assert.equal(effects, 0);
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'RESUME_SCOPE_VIOLATION');
});

for (const stage of ['open', 'login', 'details']) test(`single resume verification ends a ${stage} read failure without a replay or resume`, async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  browser.discover = async () => [];
  let calls = 0, closed = 0;
  browser[stage] = async () => { calls++; throw Object.assign(Error('页面暂时变化'), { code: 'DOCUMENT_CHANGED' }); };
  browser.close = async () => { closed++; };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1' });
  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'DOCUMENT_CHANGED');
  assert.equal(store.getJob('job:job1').resumeStatus, 'none');
});

test('single resume verification records an unknown send and terminates without re-running it', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  browser.discover = async () => [];
  let attempts = 0;
  browser.contact = async (_job, { onStage, resumeOnly }) => {
    assert.equal(resumeOnly, true);
    attempts++;
    await onStage('resume intent', { resumeStatus: 'intent' });
    throw Object.assign(Error('附件点击后未收到回执'), { code: 'ACTION_UNKNOWN' });
  };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1', once: false });
  assert.equal(attempts, 1);
  assert.equal(store.getJob('job:job1').resumeStatus, 'uncertain');
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(runner.snapshot().status, 'error');
  assert.throws(() => runner.start({ resumeJobKey: 'job:job1', once: true }), /附件|岗位|记录/u);
});

test('single resume verification retains uncertainty returned without throwing', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  browser.discover = async () => [];
  let calls = 0;
  browser.contact = async () => { calls++; return { greetingStatus: 'existing', resumeStatus: 'uncertain' }; };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1' });
  assert.equal(calls, 1);
  assert.equal(store.getJob('job:job1').resumeStatus, 'uncertain');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'UNCERTAIN');
});

test('single resume verification inspection reads only the selected conversation and preserves all send states', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable' });
  browser.discover = async () => { throw Error('inspection searched another job'); };
  let inspections = 0;
  browser.contact = async (_job, options) => {
    assert.equal(options.resumeOnly, true);
    assert.equal(options.sendResume, false);
    assert.equal(options.inspectResumeOnly, true);
    inspections++;
    await options.onStage('known conversation', { greetingStatus: 'existing' });
    return { greetingStatus: 'existing', resumeStatus: 'none', resumeSkipped: true, resumeInspection: true };
  };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true, once: true });
  assert.equal(inspections, 1);
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:job1').resumeStatus, 'unavailable');
  assert.equal(runner.snapshot().status, 'completed');
});

test('single resume verification inspection rejects a resume intent before any external click', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'requested' });
  browser.discover = async () => [];
  let effects = 0;
  browser.contact = async (_job, { onStage }) => {
    await onStage('unwanted resume intent', { resumeStatus: 'intent' });
    effects++;
    return { greetingStatus: 'existing', resumeStatus: 'sent' };
  };
  runner.once('paused', () => { runner.stop(); });
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true, once: true });
  assert.equal(effects, 0);
  assert.equal(store.getJob('job:job1').resumeStatus, 'requested');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'RESUME_SCOPE_VIOLATION');
});

test('single resume verification inspection cannot promote a read result into a sent attachment', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  browser.discover = async () => [];
  browser.contact = async () => ({ greetingStatus: 'existing', resumeStatus: 'sent' });
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true, once: true });
  assert.equal(store.getJob('job:job1').resumeStatus, 'none');
  assert.equal(runner.snapshot().counts.delivered, 0);
});

for (const resumeStatus of ['sent', 'uncertain', 'intent']) test(`single resume verification inspection may read ${resumeStatus} attachments without changing or retrying them`, async t => {
  const { store, browser, runner } = goalFixture(t, { resumeCompanyTarget: 1 });
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus });
  if (resumeStatus !== 'sent') store.upsertJob(companyJob('already-delivered'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'sent' });
  browser.discover = async () => { throw Error('inspection must stay scoped'); };
  let inspections = 0;
  browser.contact = async (_job, options) => {
    assert.equal(options.resumeOnly, true);
    assert.equal(options.sendResume, false);
    assert.equal(options.inspectResumeOnly, true);
    inspections++;
    await options.onStage('known conversation', { greetingStatus: 'existing' });
    return { greetingStatus: 'existing', resumeStatus: 'none', resumeSkipped: true, resumeInspection: true };
  };
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true });
  assert.equal(inspections, 1, 'a read-only inspection remains reachable after successful, unknown or in-flight history and full goals');
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:job1').resumeStatus, resumeStatus);
  assert.equal(runner.snapshot().status, 'completed');
  assert.throws(() => runner.start({ resumeJobKey: 'job:job1' }), /附件|岗位|记录/u);
});

test('single resume verification inspection still rejects an uncertain greeting before opening a browser', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'uncertain' });
  let opens = 0;
  browser.open = async () => { opens++; };
  assert.throws(() => runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true }), /附件|岗位|记录/u);
  assert.equal(opens, 0);
});

for (const afterConversationStage of [false, true]) test(`single resume verification inspection preserves historical intent when a read fails ${afterConversationStage ? 'after' : 'before'} the known-conversation stage`, async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'intent' });
  let effects = 0;
  browser.contact = async (_job, options) => {
    assert.equal(options.resumeOnly, true);
    assert.equal(options.sendResume, false);
    assert.equal(options.inspectResumeOnly, true);
    if (afterConversationStage) await options.onStage('known conversation', { greetingStatus: 'existing' });
    // No effect stage occurred in this invocation. A historical intent must
    // remain available for human reconciliation instead of being rewritten.
    effects += Number(options.sendResume);
    throw Object.assign(Error('只读聊天响应暂时未知'), { code: 'UNKNOWN_RESULT' });
  };
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true });
  assert.equal(effects, 0);
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:job1').resumeStatus, 'intent');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'UNKNOWN_RESULT');
});

test('single resume verification inspection preserves historical intent when an unwanted effect stage is rejected', async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'existing', resumeStatus: 'intent' });
  let effects = 0;
  browser.contact = async (_job, { onStage }) => {
    await onStage('unwanted new resume intent', { resumeStatus: 'intent' });
    effects++;
    return { greetingStatus: 'existing', resumeStatus: 'sent' };
  };
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true });
  assert.equal(effects, 0);
  assert.equal(store.getJob('job:job1').greetingStatus, 'existing');
  assert.equal(store.getJob('job:job1').resumeStatus, 'intent');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'RESUME_SCOPE_VIOLATION');
});

for (const operation of ['open', 'login', 'details']) test(`single resume verification inspection preserves historical intent on a ${operation} failure`, async t => {
  const { store, browser, runner } = goalFixture(t);
  store.upsertJob(job, { eligible: true, greetingStatus: 'sent', resumeStatus: 'intent' });
  let effects = 0;
  browser[operation] = async () => { throw Object.assign(Error('只读页面暂时变化'), { code: 'DOCUMENT_CHANGED' }); };
  browser.contact = async () => { effects++; throw Error('unexpected contact'); };
  await runner.start({ resumeJobKey: 'job:job1', inspectResumeOnly: true });
  assert.equal(effects, 0);
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:job1').resumeStatus, 'intent');
  assert.equal(runner.snapshot().status, 'error');
  assert.equal(runner.snapshot().lastError.code, 'DOCUMENT_CHANGED');
});
test('preview records eligible jobs without reserving or sending a contact', async t => {
  const { store, browser, runner } = fixture(t);
  browser.contact = async () => { throw new Error('preview sent a message'); };
  await runner.start({ preview: true, once: true });
  assert.equal(store.listJobs().length, 1);
  assert.equal(store.listJobs()[0].greetingStatus, 'none');
 assert.equal(runner.snapshot().status, 'completed');
});
test('confirmed login is shown before a preview searches any job',async t=>{
 const {store,browser,runner}=fixture(t);browser.login=async()=>({loggedIn:true});let confirmedBeforeSearch=false;
 browser.discover=async()=>{confirmedBeforeSearch=store.listEvents().some(event=>event.type==='login_confirmed');return [];};
 await runner.start({preview:true,once:true});assert.equal(confirmedBeforeSearch,true);assert.equal(store.listJobs().length,0);
});
test('a detected navigation reversal stays paused instead of retrying on resume',async t=>{
 const {browser,runner}=fixture(t);let scans=0;
 browser.discover=async()=>{scans++;throw Object.assign(new Error('职位页加载后回退'),{code:'NAVIGATION_REVERSED'});};
 const paused=new Promise(resolve=>runner.once('paused',resolve));const task=runner.start({preview:true});await paused;
 try{assert.throws(()=>runner.resume(),/回退|控制方式/u);assert.equal(runner.snapshot().status,'paused');assert.equal(scans,1);}
 finally{await runner.stop();await task;}
});
test('login preparation opens browser without contacting any job or requiring setup', async t => {
  const { store, browser, runner } = fixture(t);
  store.saveConfig({ ...defaultConfig, setupComplete:false });
  browser.login=async()=>{throw new Error('打开窗口时不应检查或操作登录页');};
  await runner.prepareLogin();
  assert.equal(runner.snapshot().lastError,null);
  assert.match(store.listEvents()[0].message,/自行.*登录/);
  assert.equal(store.listJobs().length,0);
  assert.equal(runner.task,null);
});
test('manual login uses the launch-only handoff before connecting any automation', async t => {
  const { browser, runner }=fixture(t);
  let handedOff=false;
  browser.openForLogin=async()=>{handedOff=true;};
  browser.open=async()=>{throw Error('manual login must not attach automation');};
  await runner.prepareLogin();
  assert.equal(handedOff,true);
  assert.equal(runner.snapshot().lastError,null);
});
test('extension setup resets a stopped checkpoint without starting outreach',async t=>{
 const {browser,runner,store}=fixture(t);await runner.stop();let opened=false;
 browser.setupExtension=async()=>{assert.equal(runner.abort.signal.aborted,false);opened=true;};
 await runner.prepareExtensionSetup();assert.equal(opened,true);assert.equal(runner.task,null);assert.equal(store.listJobs().length,0);
});
test('closing a browser during element reads yields a recoverable message instead of raw Playwright error', async t => {
  const { browser, runner }=fixture(t);
  browser.open=async()=>{throw new Error('locator.count: Target page, context or browser has been closed');};
  await runner.prepareLogin();
  assert.equal(runner.snapshot().lastError.code,'BROWSER_CLOSED');
  assert.match(runner.snapshot().lastError.message,/浏览器已关闭/);
  assert.doesNotMatch(runner.snapshot().lastError.message,/locator\.count/);
});
test('second launch does not greet again and pending resume is not treated as sent', async t => {
  const { store, runner } = fixture(t);
  await runner.start({ once: true });
  await runner.start({ once: true });
  assert.equal(store.listJobs()[0].resumeStatus, 'requested');
  assert.equal(store.listJobs()[0].greetingStatus, 'sent');
  assert.equal(store.listEvents().filter(e => e.type === 'contact_result').length, 1);
});
test('browser closure after an uncertain side effect pauses and survives restart with no repeat', async t => {
  const { store, browser, runner } = fixture(t);
  browser.contact = async (_j, { onStage }) => {
    await onStage('before_greeting', { greetingStatus: 'intent' });
    throw Object.assign(new Error('网页关闭，结果未知'), { code: 'BROWSER_CLOSED' });
  };
  const task = runner.start({ once: true });
  await new Promise(resolve => runner.once('paused', resolve));
  assert.equal(store.listJobs()[0].greetingStatus, 'uncertain');
  await runner.stop();
  await task;
  assert.equal(runner.snapshot().status, 'stopped');
});
test('explicit stop ends unlimited scan loop', async t => {
  const { runner } = fixture(t);
  const task = runner.start();
  await new Promise(resolve => runner.once('waiting', resolve));
  await runner.stop();
  await task;
  assert.equal(runner.snapshot().status, 'stopped');
});
test('non Beijing detail never sends even when search card matches', async t => {
  const { browser, runner, store } = fixture(t);
  browser.details = async j => ({ ...j, city: '上海' });
  browser.contact = async () => { throw new Error('sent non Beijing job'); };
  await runner.start({ once: true });
  assert.equal(store.listJobs()[0].eligible, false);
});

test('known greeting with missing resume is checked only as resumeOnly', async t => {
  const { browser, runner, store } = fixture(t);
  store.upsertJob(job, { greetingStatus:'sent', resumeStatus:'none', lastResumeCheckAt:'2020-01-01T00:00:00Z' });
  browser.contact = async (_job, options) => {
    assert.equal(options.resumeOnly, true);
    return { greetingStatus:'existing', resumeStatus:'sent', note:'附件已发送' };
  };
  await runner.start({ once:true });
  assert.equal(store.listJobs()[0].resumeStatus, 'sent');
  assert.equal(store.listJobs()[0].greetingStatus, 'sent');
});

test('zero batch rest processes every candidate without entering a timed break', async t => {
  const { browser, runner, store } = fixture(t, { contactBatchSize:1 });
  browser.discover = async () => [job, {...job,id:'job2',url:'https://www.zhipin.com/job_detail/job2.html'}];
  const breakEvents=[];
  runner.on('batch_break', () => breakEvents.push(runner.snapshot().status));
  runner.batchBreakMs=0;
  await runner.start({ once:true });
  assert.equal(store.listJobs().filter(j=>j.greetingStatus==='sent').length, 2);
  assert.equal(breakEvents.length, 0);
});
test('stored pending resume is checked even after it leaves current search results', async t => {
  const { browser, runner, store } = fixture(t);
  store.upsertJob(job, { eligible:true,greetingStatus:'sent',resumeStatus:'requested',lastResumeCheckAt:'2020-01-01T00:00:00Z' });
  browser.discover=async()=>[];
  browser.contact=async(_job,{resumeOnly})=>{
    assert.equal(resumeOnly,true);
    return{greetingStatus:'existing',resumeStatus:'sent',note:'对方已同意，已发附件'};
  };
  await runner.start({once:true});
  assert.equal(store.listJobs()[0].resumeStatus,'sent');
});

test('recently rejected jobs are cached instead of repeatedly loading every detail page', async t => {
  const { browser, runner, store }=fixture(t);
  let reads=0;
  browser.details=async j=>{reads++;return{...j,city:'上海'};};
  await runner.start({once:true});
  await runner.start({once:true});
  assert.equal(reads,1);
  assert.equal(store.listJobs()[0].eligible,false);
});
test('changing target filters invalidates the rejected-job cache', async t => {
  const { browser, runner, store }=fixture(t);
  browser.details=async j=>({...j,city:'上海'});
  await runner.start({once:true});
  store.saveConfig({...store.loadConfig(),city:'上海',cityCode:'101020100'});
  await runner.start({once:true});
  assert.equal(store.listJobs()[0].greetingStatus,'sent');
});

test('configured hard title and company rejects never open a detail page', async t => {
  const { browser, runner, store } = fixture(t, { roleTitleExclusions: [{ targetRole: 'AI Agent', keywords: ['产品经理'] }], excludeCompanies: ['拒绝公司'] });
  const cards = [
    { ...job, id: 'sales', url: '/job_detail/sales.html', title: 'AI Agent 销售实习生' },
    { ...job, id: 'product', url: '/job_detail/product.html', title: 'AI Agent 产品经理实习生' },
    { ...job, id: 'company', url: '/job_detail/company.html', company: '拒绝公司' },
  ];
  browser.discover = async () => cards;
  let reads = 0;
  browser.details = async card => { reads++; return card; };
  await runner.start({ preview: true, once: true });
  assert.equal(reads, 0);
  assert.equal(store.listJobs().length, 3);
  assert.ok(store.listJobs().every(record => record.eligible === false && record.greetingStatus === 'none'));
  await runner.start({ preview: true, once: true });
  assert.equal(reads, 0);
});

test('unknown card fields and an indirect role title still get detail verification', async t => {
  const { browser, runner, store } = fixture(t);
  const card = { id: job.id, url: job.url, title: '后端实习生', company: job.company };
  browser.discover = async () => [card];
  let reads = 0;
  browser.details = async input => { reads++; return { ...job, ...input }; };
  await runner.start({ preview: true, once: true });
  assert.equal(reads, 1);
  assert.equal(store.getJob('job:job1').eligible, true);
});

test('stronger configured title matches contact first with stable ties and immediate detail verification', async t => {
  const { browser, runner, store } = fixture(t, { targetRole: 'Java', queries: ['Java'], requiredAny: ['Java'] });
  const cards = [
    { ...job, id: 'indirect', url: '/job_detail/indirect.html', title: '后端实习生' },
    { ...job, id: 'first', url: '/job_detail/first.html', title: 'Java 开发实习生' },
    { ...job, id: 'second', url: '/job_detail/second.html', title: 'Java 后端实习生' },
  ];
  const sequence = [];
  browser.discover = async () => cards;
  browser.details = async card => { sequence.push(`detail:${card.id}`); return { ...card, description: '使用 Java 开发后端服务。' }; };
  const originalContact = browser.contact;
  browser.contact = async (input, options) => { sequence.push(`contact:${input.id}`); return originalContact(input, options); };
  await runner.start({ once: true });
  assert.deepEqual(sequence, ['detail:first', 'contact:first', 'detail:second', 'contact:second', 'detail:indirect', 'contact:indirect']);
  assert.equal(store.listJobs().filter(record => record.greetingStatus === 'sent').length, 3);
});

test('changed card city or role tags invalidate rejection without changing its title', async t => {
  for (const field of ['city', 'tags']) {
    const { browser, runner, store } = fixture(t);
    const card = { ...job, title: field === 'tags' ? '后端工程师' : job.title, city: field === 'city' ? '上海' : '北京', tags: field === 'tags' ? ['正式'] : ['实习'], description: '开发 Agent。' };
    browser.discover = async () => [{ ...card }];
    let reads = 0;
    browser.details = async input => { reads++; return input; };
    await runner.start({ preview: true, once: true });
    assert.equal(store.getJob('job:job1').eligible, false, field);
    card[field] = field === 'city' ? '北京' : ['实习'];
    await runner.start({ preview: true, once: true });
    assert.equal(reads, 2, field);
    assert.equal(store.getJob('job:job1').eligible, true, field);
  }
});

test('changed per-target title exclusions invalidate a cached hard rejection', async t => {
  const { browser, runner, store } = fixture(t, { roleTitleExclusions: [{ targetRole: 'AI Agent', keywords: ['产品经理'] }] });
  const card = { ...job, title: 'AI Agent 产品经理实习生' };
  browser.discover = async () => [card];
  let reads = 0;
  browser.details = async input => { reads++; return input; };
  await runner.start({ preview: true, once: true });
  assert.equal(store.getJob('job:job1').eligible, false);
  store.saveConfig({ ...store.loadConfig(), roleTitleExclusions: [] });
  await runner.start({ preview: true, once: true });
  assert.equal(reads, 1);
  assert.equal(store.getJob('job:job1').eligible, true);
});

test('five new contacts followed by three existing chats take one batch break', async t => {
  const { browser, runner, sleepCalls } = timedFixture(t);
  const cards = Array.from({ length: 8 }, (_, index) => ({ ...job, id: `batch${index}`, url: `/job_detail/batch${index}.html` }));
  browser.discover = async () => cards;
  browser.contact = async (input, { onStage }) => {
    const status = Number(input.id.slice(5)) < 5 ? 'sent' : 'existing';
    if (status === 'sent') await onStage('greeting-intent', { greetingStatus: 'intent' });
    await onStage(`greeting-${status}`, { greetingStatus: status });
    return { greetingStatus: status, resumeStatus: 'sent' };
  };
  let breaks = 0;
  runner.on('batch_break', () => breaks++);
  await runner.start({ once: true });
  assert.equal(breaks, 1);
  assert.equal(runner.runContacts, 5);
  assert.deepEqual(sleepCalls, [20, 20, 20, 20, 100]);
});

test('existing read-only resume checks skip contact pacing but a resume intent retains it', async t => {
  for (const attachmentAction of [false, true]) {
    const { browser, runner, store, waitCalls } = timedFixture(t);
    store.upsertJob(job, { eligible: true, greetingStatus: 'existing', resumeStatus: 'requested', lastResumeCheckAt: '2020-01-01T00:00:00Z' });
    store.upsertJob(companyJob('resume-second'), { eligible: true, greetingStatus: 'existing', resumeStatus: 'requested', lastResumeCheckAt: '2020-01-01T00:00:00Z' });
    browser.discover = async () => [];
    browser.contact = async (_job, { resumeOnly, onStage }) => {
      assert.equal(resumeOnly, true);
      if (attachmentAction) await onStage('resume-intent', { resumeStatus: 'intent' });
      return { greetingStatus: 'existing', resumeStatus: attachmentAction ? 'sent' : 'requested' };
    };
    await runner.start({ once: true });
    assert.deepEqual(waitCalls.filter(ms => ms > 0), attachmentAction ? [20] : []);
  }
});

test('observed batch waiting replaces the next contact delay only for the time already waited', async t => {
  for (const item of [
    { rest: 20, actual: ms => ms, waits: [20, 30, 20] },
    { rest: 0, actual: ms => ms, waits: [50] },
    { rest: 20, actual: ms => ms === 20 ? 60 : ms, waits: [20, 20] },
    { rest: 20, actual: ms => ms === 20 ? 10 : ms, waits: [20, 40, 20] },
  ]) {
    const { browser, runner, waitCalls } = timedFixture(t, { contactBatchSize: 1 }, { delayMs: 50, batchBreakMs: item.rest, actualSleep: item.actual });
    browser.discover = async () => [job, companyJob('after-rest')];
    const effectTimes = [];
    browser.contact = async (_job, { onStage }) => {
      await onStage('greeting-intent', { greetingStatus: 'intent' });
      effectTimes.push(runner.now());
      await onStage('greeting-sent', { greetingStatus: 'sent' });
      return { greetingStatus: 'sent', resumeStatus: 'unavailable' };
    };
    await runner.start({ once: true });
    assert.deepEqual(waitCalls.filter(ms => ms > 0), item.waits);
    assert.ok(effectTimes[1] - effectTimes[0] >= 50);
  }
});

test('run performance counts verified new sends and waits without poll-time persistence', async t => {
  const { browser, runner, store, tick } = timedFixture(t, { contactBatchSize: 10 });
  const cards = ['sent', 'existing', 'uncertain', 'old', 'sales'].map(id => ({ ...job, id, url: `/job_detail/${id}.html`, title: id === 'sales' ? 'AI Agent 销售实习生' : job.title }));
  store.upsertJob(cards[3], { eligible: true, greetingStatus: 'existing', resumeStatus: 'requested', lastResumeCheckAt: '2020-01-01T00:00:00Z' });
  browser.discover = async () => cards;
  browser.details = async card => { tick(10); return card; };
  browser.contact = async (input, { onStage }) => {
    if (input.id === 'sent') {
      await onStage('greeting-intent', { greetingStatus: 'intent' });
      await onStage('greeting-sent', { greetingStatus: 'sent' });
      return { greetingStatus: 'sent', resumeStatus: 'sent' };
    }
    if (input.id === 'uncertain') {
      await onStage('greeting-intent', { greetingStatus: 'intent' });
      return { greetingStatus: 'uncertain', resumeStatus: 'none' };
    }
    return { greetingStatus: 'existing', resumeStatus: 'requested' };
  };
  runner.once('paused', () => runner.resume());
  await runner.start({ once: true });
  const metrics = runner.snapshot().performance;
  assert.ok(metrics);
  assert.equal(metrics.detailReads, 4);
  assert.equal(metrics.precheckRejected, 1);
  assert.equal(metrics.verifiedNewContacts, 1);
  assert.equal(metrics.elapsedMs, 40);
  assert.equal(metrics.waitedMs, 0);
  assert.equal(metrics.contactWaitMs, 0);
  assert.equal(metrics.batchWaitMs, 0);
  assert.equal(metrics.confirmedPerHour, 90_000);
  const events = store.listEvents(500).length;
  tick(100);
  for (let i = 0; i < 10; i++) assert.equal(runner.snapshot().performance.elapsedMs, 40);
  assert.equal(store.listEvents(500).length, events);
  await runner.start({ once: true });
  assert.equal(runner.snapshot().performance.verifiedNewContacts, 0);
  assert.equal(runner.snapshot().performance.detailReads, 2, 'pending attachments are checked immediately on the next run');
});

test('a verified new greeting remains counted if its later resume action fails', async t => {
  const { browser, runner, store, tick } = timedFixture(t);
  browser.contact = async (_job, { onStage }) => {
    tick(20);
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    await onStage('greeting-sent', { greetingStatus: 'sent' });
    await onStage('resume-intent', { resumeStatus: 'intent' });
    throw Object.assign(new Error('附件未确认'), { code: 'PAGE_CHANGED' });
  };
  await runner.start({ once: true });
  assert.equal(runner.snapshot().status, 'completed');
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:job1').resumeStatus, 'uncertain');
  assert.equal(runner.snapshot().performance?.verifiedNewContacts, 1);
  tick(100);
  assert.equal(runner.snapshot().performance.elapsedMs, 20);
});

test('isolated detail metrics freeze elapsed time and preview idle waits remain separate', async t => {
  const failed = timedFixture(t);
  failed.browser.details = async input => { failed.tick(10); return { ...input, id: 'wrong', url: '/job_detail/wrong.html' }; };
  await failed.runner.start({ once: true });
  assert.equal(failed.runner.snapshot().status, 'completed');
  failed.tick(100);
  assert.equal(failed.runner.snapshot().performance.elapsedMs, 10);
  assert.equal(failed.runner.snapshot().performance.verifiedNewContacts, 0);

  const preview = timedFixture(t);
  let stopping;
  preview.runner.sleep = async ms => { preview.tick(ms); stopping = preview.runner.stop(); };
  await preview.runner.start({ preview: true, once: false });
  await stopping;
  const metrics = preview.runner.snapshot().performance;
  assert.equal(metrics.idleWaitMs, 1);
  assert.equal(metrics.waitedMs, 1);
  assert.equal(metrics.contactWaitMs, 0);
  assert.equal(metrics.verifiedNewContacts, 0);
});

test('zero company goals retain unlimited processing and existing project records do not fake new contacts', async t => {
  const state = goalFixture(t, {}, [companyJob('a'), companyJob('b')]);
  state.store.upsertJob(companyJob('old'), { greetingStatus: 'existing', resumeStatus: 'requested' });
  await state.runner.start({ once: true });
  assert.deepEqual(state.runner.snapshot().goal, { contactedCompanies: 2, deliveredCompanies: 2, contactTarget: 0, resumeTarget: 0, contactReached: false, resumeReached: false, complete: false });
  assert.deepEqual(state.effects, ['greeting:a', 'resume:a', 'greeting:b', 'resume:b']);
});

test('a contact-only goal stops at its boundary before any extra greeting or resume intent', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1 }, [companyJob('a'), companyJob('b')]);
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:a']);
  assert.equal(state.runner.snapshot().status, 'completed');
  assert.equal(state.runner.snapshot().goal.complete, true);
  assert.equal(state.store.getJob('job:a').greetingStatus, 'sent');
  assert.equal(state.store.getJob('job:a').resumeStatus, 'none');
});

test('resume goal reached first disables attachments while contacts continue to the other target', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 3, resumeCompanyTarget: 1 }, [companyJob('b'), companyJob('c'), companyJob('d')]);
  state.store.upsertJob(companyJob('a'), { greetingStatus: 'sent', resumeStatus: 'sent' });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:b', 'greeting:c']);
  assert.ok(state.options.every(options => options.sendResume === false));
  assert.equal(state.runner.snapshot().goal.complete, true);
  assert.equal(state.runner.snapshot().goal.deliveredCompanies, 1);
});

test('contact goal reached first continues an immediately pending original resume without new discovery', async t => {
  const original = companyJob('a');
  const state = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 1 }, [companyJob('other')]);
  state.store.upsertJob(original, { eligible: true, greetingStatus: 'sent', resumeStatus: 'none', lastResumeCheckAt: new Date().toISOString() });
  let searches = 0;
  state.browser.discover = async () => { searches++; return [companyJob('other')]; };
  await state.runner.start({ once: true });
  assert.equal(searches, 0);
  assert.deepEqual(state.effects, ['resume:a']);
  assert.deepEqual(state.options, [{ id: 'a', resumeOnly: true, sendResume: true }]);
  assert.equal(state.runner.snapshot().goal.complete, true);
});

test('different jobs at the same company are each contacted while company targets count them once', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 2, resumeCompanyTarget: 2 }, [companyJob('a', 'ACME 科技'), companyJob('alias', ' ＡＣＭＥ　科技 '), companyJob('b'), companyJob('c')]);
  const reads = [];
  state.browser.details = async card => { reads.push(card.id); return card; };
  await state.runner.start({ once: true });
  assert.deepEqual(reads, ['a', 'alias', 'b']);
  assert.deepEqual(state.effects, ['greeting:a', 'resume:a', 'greeting:alias', 'resume:alias', 'greeting:b', 'resume:b']);
  assert.equal(state.runner.snapshot().goal.complete, true);
  assert.equal(state.runner.snapshot().goal.contactedCompanies, 2);
  assert.equal(state.runner.snapshot().goal.deliveredCompanies, 2);
  assert.equal(state.runner.snapshot().counts.contacted, 3);
  assert.equal(state.runner.snapshot().counts.delivered, 3);
});

test('a fulfilled single resume goal returns completed without opening the browser', async t => {
  const state = goalFixture(t, { resumeCompanyTarget: 1 }, [companyJob('new')]);
  state.store.upsertJob(companyJob('old'), { greetingStatus: 'existing', resumeStatus: 'sent' });
  let opened = 0;
  state.browser.open = async () => { opened++; };
  await state.runner.start({ once: true });
  assert.equal(opened, 0);
  assert.equal(state.runner.snapshot().goal.complete, true);
  assert.equal(state.runner.snapshot().goal.contactedCompanies, 0);
  assert.deepEqual(state.effects, []);
});

test('waiting for recipient approval neither fulfills the resume goal nor expands company contacts', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 2 }, [companyJob('other')]);
  state.store.upsertJob(companyJob('a'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'requested', lastResumeCheckAt: '2020-01-01T00:00:00Z' });
  let searches = 0;
  state.browser.discover = async () => { searches++; return [companyJob('other')]; };
  state.browser.contact = async () => ({ greetingStatus: 'existing', resumeStatus: 'requested' });
  let waiting;
  let stopping;
  state.runner.once('waiting', () => { waiting = state.runner.snapshot(); stopping = state.runner.stop(); });
  await state.runner.start();
  await stopping;
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.goal.complete, false);
  assert.equal(waiting.goal.deliveredCompanies, 0);
  assert.equal(searches, 0);
  assert.deepEqual(state.effects, []);
});

test('intent guards block a mock ignoring sendResume and never persist an over-goal resume intent', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 3, resumeCompanyTarget: 1 }, [companyJob('b'), companyJob('c'), companyJob('d')]);
  state.store.upsertJob(companyJob('a'), { greetingStatus: 'sent', resumeStatus: 'sent' });
  state.browser.contact = async (input, { onStage }) => {
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push(`greeting:${input.id}`);
    await onStage('greeting-sent', { greetingStatus: 'sent' });
    await onStage('resume-intent', { resumeStatus: 'intent' });
    state.effects.push(`resume:${input.id}`);
    return { greetingStatus: 'sent', resumeStatus: 'sent' };
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:b', 'greeting:c']);
  assert.equal(state.store.getJob('job:b').resumeStatus, 'none');
  assert.equal(state.runner.snapshot().goal.deliveredCompanies, 1);
  assert.equal(state.runner.snapshot().goal.complete, true);
});

test('intent guard refuses any second greeting after the company contact target boundary', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 2 }, [companyJob('a')]);
  state.browser.contact = async (input, { onStage }) => {
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push(`greeting:${input.id}`);
    await onStage('greeting-sent', { greetingStatus: 'sent' });
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push('extra-greeting');
    return { greetingStatus: 'sent', resumeStatus: 'none' };
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:a']);
  assert.equal(state.store.getJob('job:a').greetingStatus, 'sent');
  assert.equal(state.runner.snapshot().goal.contactReached, true);
  assert.equal(state.runner.snapshot().goal.complete, false);
});

test('resume-only existing stages preserve a previously confirmed contact throughout the goal checkpoint', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 1 });
  state.store.upsertJob(companyJob('a'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  let reachedAfterExisting;
  state.browser.contact = async (_job, { resumeOnly, onStage }) => {
    assert.equal(resumeOnly, true);
    await onStage('greeting-existing', { greetingStatus: 'existing' });
    reachedAfterExisting = state.runner.snapshot().goal.contactReached;
    await onStage('resume-intent', { resumeStatus: 'intent' });
    await onStage('resume-sent', { resumeStatus: 'sent' });
    return { greetingStatus: 'existing', resumeStatus: 'sent' };
  };
  await state.runner.start({ once: true });
  assert.equal(reachedAfterExisting, true);
  assert.equal(state.store.getJob('job:a').greetingStatus, 'sent');
  assert.equal(state.runner.snapshot().goal.complete, true);
});

test('skipped attachment results preserve prior resume state instead of resetting it to none', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 2, resumeCompanyTarget: 1 }, [companyJob('new')]);
  state.store.upsertJob(companyJob('old'), { greetingStatus: 'sent', resumeStatus: 'sent' });
  state.store.upsertJob(companyJob('new'), { resumeStatus: 'requested' });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:new']);
  assert.equal(state.store.getJob('job:new').resumeStatus, 'requested');
  assert.equal(state.runner.snapshot().goal.deliveredCompanies, 1);
});

test('same-company new job is contacted before checking an original existing conversation attachment', async t => {
  const original = companyJob('original', 'ACME 科技');
  const state = goalFixture(t, {}, [companyJob('other', 'ＡＣＭＥ　科技')]);
  state.store.upsertJob(original, { eligible: true, greetingStatus: 'existing', resumeStatus: 'none', lastResumeCheckAt: new Date().toISOString() });
  const reads = [];
  state.browser.details = async card => { reads.push(card.id); return card; };
  await state.runner.start({ once: true });
  assert.deepEqual(reads, ['other', 'original']);
  assert.deepEqual(state.effects, ['greeting:other', 'resume:other', 'resume:original']);
  assert.equal(state.store.getJob('job:other').eligible, true);
  assert.equal(state.runner.snapshot().goal.contactedCompanies, 1);
});

test('legacy company-name rejection cache is re-evaluated after removal', async t => {
  const card = companyJob('new', 'ACME 科技');
  const state = goalFixture(t, { companyDedup: true }, [card]);
  state.store.upsertJob(companyJob('old', 'ACME 科技'), { greetingStatus: 'sent', resumeStatus: 'sent' });
  const config = state.store.loadConfig();
  const legacyCriteria = JSON.stringify([config.city, config.cityCode, config.targetRole, config.roleType, config.requiredAny, config.excludeKeywords, config.excludeCompanies, config.roleTitleExclusions, config.contactCompanyTarget, config.resumeCompanyTarget, true]);
  state.store.upsertJob(card, { eligible: false, reasons: ['本项目已沟通过该公司，跳过其他岗位的新招呼'], criteriaSignature: legacyCriteria, cardFingerprint: JSON.stringify([card.title, card.company, card.city, card.tags]), evaluatedAt: new Date().toISOString() });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:new', 'resume:new']);
  assert.equal(state.store.getJob('job:new').eligible, true);
  assert.equal(state.runner.snapshot().performance.precheckRejected, 0);
});

test('requested and unavailable resumes are immediately checked without a fixed cooldown', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 3, resumeCompanyTarget: 3 });
  for (const [id, resumeStatus] of [['untouched', 'none'], ['requested', 'requested'], ['unavailable', 'unavailable']]) {
    state.store.upsertJob(companyJob(id), { eligible: true, greetingStatus: 'sent', resumeStatus, lastResumeCheckAt: new Date().toISOString() });
  }
  await state.runner.start({ once: true });
  assert.deepEqual([...state.effects].sort(), ['resume:requested', 'resume:unavailable', 'resume:untouched']);
  assert.equal(state.runner.snapshot().goal.contactReached, true);
  assert.equal(state.runner.snapshot().goal.deliveredCompanies, 3);
  assert.equal(state.runner.snapshot().goal.complete, true);
});

test('a failed greeting intent reserves the optional run quota while automatic recovery continues', async t => {
  const state = goalFixture(t, { runLimit: 1 }, [companyJob('a'), companyJob('b')]);
  const contact = state.browser.contact;
  state.browser.contact = async (input, options) => {
    if (input.id !== 'a') return contact(input, options);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push('greeting:a');
    throw Object.assign(new Error('点击后页面变更，结果未确认'), { code: 'PAGE_CHANGED' });
  };
  state.runner.once('paused', () => state.runner.resume());
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:a']);
  assert.equal(state.runner.runContacts, 1);
  assert.equal(state.store.getJob('job:a').greetingStatus, 'uncertain');
  assert.equal(state.runner.snapshot().performance.verifiedNewContacts, 0);
});

test('an unknown contact reserves the company goal without counting success or sending to a second company', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1 }, [companyJob('a'), companyJob('b')]);
  const contact = state.browser.contact;
  state.browser.contact = async (input, options) => {
    if (input.id !== 'a') return contact(input, options);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push('greeting:a');
    throw Object.assign(new Error('点击后页面变更，结果未确认'), { code: 'PAGE_CHANGED' });
  };
  state.runner.once('paused', () => state.runner.resume());
  let waiting, stopping;
  state.runner.once('waiting', () => { waiting = state.runner.snapshot(); stopping = state.runner.stop(); });
  await state.runner.start();
  await stopping;
  assert.deepEqual(state.effects, ['greeting:a']);
  assert.equal(waiting?.status, 'waiting');
  assert.equal(waiting?.goal.contactedCompanies, 0);
  assert.equal(waiting?.goal.complete, false);
  assert.equal(state.runner.snapshot().performance.verifiedNewContacts, 0);
});

test('an unknown resume reserves the delivery goal without sending a second company attachment', async t => {
  const state = goalFixture(t, { resumeCompanyTarget: 1 }, [companyJob('a'), companyJob('b')]);
  const contact = state.browser.contact;
  state.browser.contact = async (input, options) => {
    if (input.id !== 'a') return contact(input, options);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push('greeting:a');
    await options.onStage('greeting-sent', { greetingStatus: 'sent' });
    await options.onStage('resume-intent', { resumeStatus: 'intent' });
    state.effects.push('resume:a');
    throw Object.assign(new Error('附件操作后页面变更，结果未确认'), { code: 'PAGE_CHANGED' });
  };
  state.runner.once('paused', () => state.runner.resume());
  let waiting, stopping;
  state.runner.once('waiting', () => { waiting = state.runner.snapshot(); stopping = state.runner.stop(); });
  await state.runner.start();
  await stopping;
  assert.deepEqual(state.effects, ['greeting:a', 'resume:a']);
  assert.equal(waiting?.status, 'waiting');
  assert.equal(waiting?.goal.deliveredCompanies, 0);
  assert.equal(waiting?.goal.complete, false);
  assert.equal(state.store.getJob('job:a').resumeStatus, 'uncertain');
});

test('resume intent checkpoint rejects an unknown occupied slot even when a mock ignores sendResume', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 2, resumeCompanyTarget: 1 }, [companyJob('b')]);
  state.store.upsertJob(companyJob('a'), { greetingStatus: 'sent', resumeStatus: 'uncertain' });
  state.browser.contact = async (input, { onStage }) => {
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push(`greeting:${input.id}`);
    await onStage('greeting-sent', { greetingStatus: 'sent' });
    await onStage('resume-intent', { resumeStatus: 'intent' });
    state.effects.push(`resume:${input.id}`);
    return { greetingStatus: 'sent', resumeStatus: 'sent' };
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:b']);
  assert.equal(state.store.getJob('job:b').resumeStatus, 'none');
  assert.equal(state.runner.snapshot().goal.deliveredCompanies, 0);
  assert.equal(state.runner.snapshot().goal.complete, false);
});

test('duplicate company records occupy one goal slot without company-name filtering', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 2 }, [companyJob('new', '第二公司')]);
  state.store.upsertJob(companyJob('confirmed', 'ACME 科技'), { greetingStatus: 'sent', resumeStatus: 'requested' });
  state.store.upsertJob(companyJob('unknown', ' ＡＣＭＥ　科技 '), { greetingStatus: 'uncertain', resumeStatus: 'none' });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:new']);
  assert.equal(state.runner.snapshot().goal.contactedCompanies, 2);
  assert.equal(state.runner.snapshot().goal.complete, true);
});

for (const contactCompanyTarget of [0, 10]) {
  for (const greetingStatus of ['intent', 'uncertain']) {
    test(`different job remains eligible at an unresolved company: target ${contactCompanyTarget}, ${greetingStatus}`, async t => {
      const state = goalFixture(t, { contactCompanyTarget }, [companyJob('new', 'ＡＣＭＥ　科技')]);
      state.store.upsertJob(companyJob('old', ' ACME  科技 '), { greetingStatus, resumeStatus: 'none' });
      let reads = 0;
      state.browser.details = async card => { reads++; return card; };
      await state.runner.start({ once: true });
      assert.deepEqual(state.effects, ['greeting:new', 'resume:new'], `${contactCompanyTarget}/${greetingStatus}`);
      assert.equal(reads, 1);
      assert.equal(state.store.getJob('job:new').greetingStatus, 'sent');
      assert.equal(state.store.getJob('job:new').eligible, true);
      assert.equal(state.store.getJob('job:old').greetingStatus, greetingStatus);
      assert.equal(state.runner.snapshot().goal.contactedCompanies, 1);
    });
  }
}

test('legacy true setting cannot suppress a different job at an unresolved company', async t => {
  const state = goalFixture(t, { companyDedup: true, contactCompanyTarget: 10 }, [companyJob('new', 'ＡＣＭＥ　科技')]);
  state.store.upsertJob(companyJob('old', ' ACME  科技 '), { greetingStatus: 'uncertain', resumeStatus: 'none' });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:new', 'resume:new']);
  assert.equal(state.runner.snapshot().goal.contactedCompanies, 1);
  assert.equal(state.store.companyReservations().contactCompanies.size, 1);
});

test('same attempt may repeat its durable intent before custom send without triggering another flow', async t => {
  const state = goalFixture(t, {}, [companyJob('new', 'ACME 科技')]);
  state.browser.contact = async (input, { onStage }) => {
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push('open-contact');
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push('custom-send');
    await onStage('greeting-sent', { greetingStatus: 'sent' });
    return { greetingStatus: 'sent', resumeStatus: 'requested' };
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['open-contact', 'custom-send']);
  assert.equal(state.store.getJob('job:new').greetingStatus, 'sent');
  assert.equal(state.runner.snapshot().performance.verifiedNewContacts, 1);
});

for (const greetingStatus of ['sent', 'existing', 'intent', 'uncertain']) {
  test(`same job with ${greetingStatus} greeting is never re-contacted across repeated scans`, async t => {
    const card = companyJob('same', 'ACME 科技');
    const state = goalFixture(t, {}, [card, { ...card }]);
    state.store.upsertJob(card, { eligible: true, greetingStatus, resumeStatus: 'sent' });
    const before = state.store.getJob('job:same');
    await state.runner.start({ once: true });
    await state.runner.start({ once: true });
    assert.deepEqual(state.effects, []);
    assert.equal(state.store.getJob('job:same').greetingStatus, greetingStatus);
    assert.equal(state.store.getJob('job:same').updatedAt, before.updatedAt);
  });
}

function preparedContacts(t, config = {}) {
  const state = timedFixture(t, { contactBatchSize: 10, ...config }, { delayMs: 30_000, batchBreakMs: 60_000 });
  state.effects = [];
  state.browser.discover = async () => ['speed-a', 'speed-b', 'speed-c'].map(id => companyJob(id));
  state.browser.details = async card => { state.tick(5_000); return card; };
  state.browser.contact = async (input, { onStage }) => {
    state.tick(3_000); // Verified reads before any irreversible action.
    await onStage('greeting-intent', { greetingStatus: 'intent' });
    assert.equal(state.store.getJob(`job:${input.id}`).greetingStatus, 'intent');
    state.effects.push({ id: input.id, at: state.runner.now() });
    state.tick(2_000); // Delivery proof and attachment availability reads.
    await onStage('greeting-sent', { greetingStatus: 'sent' });
    return { greetingStatus: 'sent', resumeStatus: 'unavailable' };
  };
  return state;
}

test('read-only preparation occupies the contact interval without sending before the previous flow deadline', async t => {
  const state = preparedContacts(t);
  await state.runner.start({ once: true });
  const metrics = state.runner.snapshot().performance;
  t.diagnostic(JSON.stringify({ elapsedMs: metrics.elapsedMs, contactWaitMs: metrics.contactWaitMs, effects: state.effects }));
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 40_000, 72_000]);
  assert.equal(metrics.elapsedMs, 74_000);
  assert.equal(metrics.contactWaitMs, 44_000);
  assert.equal(metrics.verifiedNewContacts, 3);
  for (let index = 1; index < state.effects.length; index++) {
    assert.ok(state.effects[index].at - (state.effects[index - 1].at + 2_000) >= 30_000);
  }
});

test('existing chats without an attachment intent use preparation time without resetting or waiting on a contact deadline', async t => {
  const state = preparedContacts(t);
  const contact = state.browser.contact;
  state.browser.contact = async (input, options) => {
    if (input.id !== 'speed-b') return contact(input, options);
    state.tick(3_000);
    return { greetingStatus: 'existing', resumeStatus: 'unavailable' };
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 40_000]);
  assert.deepEqual(state.sleepCalls, [14_000]);
  assert.equal(state.runner.snapshot().performance.elapsedMs, 42_000);
  assert.equal(state.store.getJob('job:speed-b').greetingStatus, 'existing');
});

test('batch rest remains complete while later preparation consumes any contact delay already covered by the rest', async t => {
  const state = preparedContacts(t, { contactBatchSize: 2 });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 40_000, 110_000]);
  assert.deepEqual(state.sleepCalls, [22_000, 60_000]);
  assert.equal(state.runner.snapshot().performance.batchWaitMs, 60_000);
  assert.equal(state.runner.snapshot().performance.elapsedMs, 112_000);
});

test('stop during the remaining contact wait leaves the prepared next job without a durable intent or send', async t => {
  const state = preparedContacts(t);
  let stopping;
  state.runner.sleep = async (_ms, signal) => {
    assert.equal(signal.aborted, false);
    state.tick(1_000);
    stopping = state.runner.stop();
  };
  await state.runner.start({ once: true });
  await stopping;
  assert.deepEqual(state.effects.map(effect => effect.id), ['speed-a']);
  const prepared = state.store.getJob('job:speed-b');
  assert.ok(prepared, 'read-only next-job preparation should precede the remaining wait');
  assert.equal(prepared.greetingStatus, 'none');
  assert.equal(state.runner.snapshot().status, 'stopped');
});

test('an uncertain intent retains its pacing deadline and is not retried while automatic recovery continues', async t => {
  const state = preparedContacts(t);
  const contact = state.browser.contact;
  state.browser.contact = async (input, options) => {
    if (input.id !== 'speed-a') return contact(input, options);
    state.tick(3_000);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push({ id: input.id, at: state.runner.now() });
    state.tick(2_000);
    throw Object.assign(new Error('Local fixture receipt is uncertain'), { code: 'UNKNOWN_RESULT' });
  };
  state.runner.on('paused', () => state.runner.resume());
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 40_000, 72_000]);
  assert.equal(state.effects.filter(effect => effect.id === 'speed-a').length, 1);
  assert.equal(state.store.getJob('job:speed-a').greetingStatus, 'uncertain');
  assert.equal(state.runner.snapshot().performance.verifiedNewContacts, 2);
});

test('the contact deadline survives a new start and a read-only preview without accumulating a preview deadline', async t => {
  const state = preparedContacts(t);
  const contact = state.browser.contact;
  state.browser.contact = async (...args) => ({ ...await contact(...args), resumeStatus: 'sent' });
  state.browser.discover = async () => [companyJob('speed-a')];
  await state.runner.start({ once: true });
  state.browser.discover = async () => [companyJob('speed-preview')];
  await state.runner.start({ preview: true, once: true });
  state.browser.discover = async () => [companyJob('speed-b')];
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 40_000]);
  assert.equal(state.store.getJob('job:speed-preview').greetingStatus, 'none');
  assert.deepEqual(state.sleepCalls, [17_000]);
});

test('stopping after a durable intent preserves the deadline on restart without retrying the uncertain job', async t => {
  const state = preparedContacts(t);
  const contact = state.browser.contact;
  let stopping;
  state.browser.discover = async () => [companyJob('speed-a')];
  state.browser.contact = async (input, options) => {
    if (input.id !== 'speed-a') return contact(input, options);
    state.tick(3_000);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    state.effects.push({ id: input.id, at: state.runner.now() });
    state.tick(2_000);
    stopping = state.runner.stop();
    throw Object.assign(new Error('Stopped after a local fixture action'), { code: 'STOPPED' });
  };
  await state.runner.start({ once: true });
  await stopping;
  assert.equal(state.runner.now(), 10_000, 'stop must not wait for the pacing interval');
  assert.equal(state.store.getJob('job:speed-a').greetingStatus, 'uncertain');
  state.browser.discover = async () => ['speed-a', 'speed-b'].map(id => companyJob(id));
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 40_000]);
  assert.equal(state.effects.filter(effect => effect.id === 'speed-a').length, 1);
  assert.deepEqual(state.sleepCalls, [22_000]);
});

test('zero contact delay clears an earlier pacing gate without any timer or intent delay', async t => {
  const state = preparedContacts(t, { contactBatchSize: 1 });
  state.runner.delayMs = 0;
  state.runner.batchBreakMs = 0;
  state.runner.idleMs = 0;
  state.runner.nextContactAt = 1_000_000;
  const breaks = [];
  state.runner.on('batch_break', () => breaks.push(state.runner.snapshot().status));
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects.map(effect => effect.at), [8_000, 18_000, 28_000]);
  assert.deepEqual(state.sleepCalls, []);
  assert.deepEqual(state.waitCalls, []);
  assert.deepEqual(breaks, []);
  assert.equal(state.runner.snapshot().performance.waitedMs, 0);
  assert.equal(state.runner.snapshot().performance.elapsedMs, 30_000);
});

test('zero idle scan yields to an event-loop stop request instead of an endless microtask loop', async t => {
  const state = timedFixture(t, {}, { delayMs: 0, batchBreakMs: 0 });
  state.runner.idleMs = 0;
  state.browser.discover = async () => [];
  let stopping, loopStop = false, fallbackStop = false;
  const immediate = setImmediate(() => { loopStop = true; stopping = state.runner.stop(); });
  t.after(() => clearImmediate(immediate));
  state.runner.on('update', snapshot => {
    if (snapshot.cycle === 3 && snapshot.status === 'running') {
      fallbackStop = true;
      stopping = state.runner.stop();
    }
  });
  await state.runner.start();
  await stopping;
  assert.equal(fallbackStop, false, 'the external stop must run before three immediate cycles');
  assert.equal(loopStop, true);
  assert.equal(state.runner.snapshot().status, 'stopped');
  assert.equal(state.runner.snapshot().cycle, 1);
  assert.deepEqual(state.sleepCalls, []);
  assert.equal(state.runner.snapshot().performance.waitedMs, 0);
  assert.deepEqual(state.store.listJobs(), []);
});

test('new candidates from every search run before old unavailable attachment checks', async t => {
  const state = goalFixture(t, { queries: ['AI Agent', '智能体'] });
  state.runner.delayMs = 0;
  state.runner.batchBreakMs = 0;
  state.store.upsertJob(companyJob('old'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable', lastResumeCheckAt: new Date().toISOString() });
  state.browser.discover = async query => [companyJob(query === 'AI Agent' ? 'new-a' : 'new-b'), companyJob('old')];
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:new-a', 'resume:new-a', 'greeting:new-b', 'resume:new-b', 'resume:old']);
  assert.equal(state.store.getJob('job:old').greetingStatus, 'sent');
  assert.equal(state.store.getJob('job:old').resumeStatus, 'sent');
});

test('new contact quota does not starve a queued existing attachment', async t => {
  const state = goalFixture(t, { queries: ['AI Agent', '智能体'], runLimit: 1 }, [companyJob('new-a'), companyJob('new-b')]);
  state.runner.delayMs = 0;
  state.runner.batchBreakMs = 0;
  state.store.upsertJob(companyJob('old'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'requested', lastResumeCheckAt: new Date().toISOString() });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:new-a', 'resume:new-a', 'resume:old']);
  assert.equal(state.runner.runContacts, 1);
});

test('zero wait does not retry an uncertain record when later scans run', async t => {
  const state = goalFixture(t, {}, [companyJob('unknown'), companyJob('fresh')]);
  state.runner.delayMs = 0;
  state.runner.batchBreakMs = 0;
  state.store.upsertJob(companyJob('unknown'), { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'none' });
  await state.runner.start({ once: true });
  await state.runner.start({ once: true });
  assert.deepEqual(state.effects, ['greeting:fresh', 'resume:fresh']);
  assert.equal(state.store.getJob('job:unknown').greetingStatus, 'uncertain');
  assert.equal(state.runner.snapshot().counts.uncertain, 1);
});

async function stopAfterCycles(runner, cycles) {
  let stopping;
  const listener = snapshot => {
    if (snapshot.status === 'running' && snapshot.cycle > cycles && !stopping) stopping = runner.stop();
  };
  runner.on('update', listener);
  try { await runner.start(); if (stopping) await stopping; }
  finally { runner.off('update', listener); }
}

async function stopOnNoWorkPause(runner) {
  let paused, stopping;
  const pausedListener = () => { paused = runner.snapshot(); stopping = runner.stop(); };
  const fallback = snapshot => {
    if (snapshot.status === 'running' && snapshot.cycle > 2 && !stopping) stopping = runner.stop();
  };
  runner.once('paused', pausedListener);
  runner.on('update', fallback);
  try { await runner.start(); if (stopping) await stopping; }
  finally { runner.off('paused', pausedListener); runner.off('update', fallback); }
  return paused;
}

for (const example of [
  { name: 'unknown contact reservations', config: { contactCompanyTarget: 1, resumeCompanyTarget: 100 }, record: { greetingStatus: 'uncertain', resumeStatus: 'none' }, code: 'GOAL_CONTACT_RESERVED' },
  { name: 'unknown resume reservations', config: { resumeCompanyTarget: 1 }, record: { greetingStatus: 'sent', resumeStatus: 'uncertain' }, code: 'GOAL_RESUME_RESERVED' },
  { name: 'reached contact target without a pending attachment', config: { contactCompanyTarget: 1, resumeCompanyTarget: 100 }, record: { greetingStatus: 'sent', resumeStatus: 'sent' }, code: 'NO_ACTIONABLE_WORK' },
  { name: 'uncertain attachment cannot be used as pending work', config: { contactCompanyTarget: 1, resumeCompanyTarget: 100 }, record: { greetingStatus: 'sent', resumeStatus: 'uncertain' }, code: 'NO_ACTIONABLE_WORK' },
]) {
  test(`no-work guard conditionally pauses ${example.name} without empty rescans`, async t => {
    const state = goalFixture(t, example.config);
    state.runner.idleMs = 0;
    state.store.upsertJob(companyJob('blocked'), { eligible: true, ...example.record });
    let searches = 0, reads = 0;
    state.browser.discover = async () => { searches++; return []; };
    state.browser.details = async card => { reads++; return card; };
    const paused = await stopOnNoWorkPause(state.runner);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused.lastError.code, example.code);
    assert.match(paused.lastError.message, /停止/u);
    assert.equal(paused.goal.complete, false);
    assert.equal(searches, 0);
    assert.equal(reads, 0);
    assert.deepEqual(state.effects, []);
    assert.equal(state.store.listEvents(500).filter(event => event.type === 'scan_start' || event.type === 'search_result').length, 0);
    assert.deepEqual(state.sleepCalls, []);
  });
}

test('no-work guard cannot blindly resume unresolved target reservations', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 100 });
  state.store.upsertJob(companyJob('blocked'), { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'none' });
  let rejected, stopping;
  state.runner.once('paused', () => {
    try { state.runner.resume(); } catch (error) { rejected = error; }
    stopping = state.runner.stop();
  });
  const fallback = snapshot => { if (snapshot.status === 'running' && snapshot.cycle > 2 && !stopping) stopping = state.runner.stop(); };
  state.runner.on('update', fallback);
  await state.runner.start(); if (stopping) await stopping;
  assert.match(rejected?.message || '', /停止.*核对/u);
  assert.deepEqual(state.effects, []);
});

test('no-work guard preserves a ready existing attachment and a later new greeting capacity', async t => {
  const pending = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 1 });
  pending.runner.idleMs = 0;
  pending.store.upsertJob(companyJob('pending'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  await pending.runner.start();
  assert.deepEqual(pending.effects, ['resume:pending']);
  assert.equal(pending.runner.snapshot().status, 'completed');

  const fresh = goalFixture(t, { contactCompanyTarget: 2, resumeCompanyTarget: 1 }, [companyJob('fresh')]);
  fresh.runner.idleMs = 0;
  fresh.store.upsertJob(companyJob('unknown'), { greetingStatus: 'sent', resumeStatus: 'uncertain' });
  const paused = [];
  let stopping;
  fresh.runner.on('paused', () => { paused.push(fresh.runner.snapshot().lastError.code); stopping = fresh.runner.stop(); });
  await stopAfterCycles(fresh.runner, 2);
  if (stopping) await stopping;
  assert.deepEqual(fresh.effects, ['greeting:fresh']);
  assert.equal(fresh.store.getJob('job:fresh').greetingStatus, 'sent');
  assert.deepEqual(paused, ['GOAL_RESUME_RESERVED']);
});

test('no-work guard retains one-shot completion and preview discovery', async t => {
  const state = goalFixture(t, { contactCompanyTarget: 1, resumeCompanyTarget: 100 });
  state.store.upsertJob(companyJob('blocked'), { greetingStatus: 'uncertain', resumeStatus: 'none' });
  await state.runner.start({ once: true });
  assert.equal(state.runner.snapshot().status, 'completed');
  let searches = 0;
  state.browser.discover = async () => { searches++; return []; };
  await state.runner.start({ preview: true, once: true });
  assert.equal(searches, 1);
  assert.equal(state.runner.snapshot().status, 'completed');
});

test('stable scan logs avoid 100 empty-query rewrites while discovery stays continuous', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent', '智能体'] });
  runner.idleMs = 0;
  let searches = 0, writes = 0;
  browser.discover = async () => { searches++; return []; };
  const append = store.appendEvent.bind(store);
  store.appendEvent = event => { writes++; return append(event); };
  await stopAfterCycles(runner, 100);
  assert.equal(searches, 200);
  assert.equal(writes, 3);
  assert.equal(store.listEvents(500).filter(event => event.type === 'scan_start').length, 1);
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
  assert.equal(runner.snapshot().performance.waitedMs, 0);
});

test('stable scan logs retain later jobs after 100 unchanged cached-query reads', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent'] });
  runner.idleMs = 0;
  let searches = 0;
  const rejected = { ...job, id: 'cached', url: '/job_detail/cached.html', city: '上海' };
  browser.discover = async () => { searches++; return searches <= 100 ? [rejected] : [rejected, job]; };
  await stopAfterCycles(runner, 101);
  assert.equal(searches, 101);
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.getJob('job:cached').eligible, false);
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
  assert.equal(store.listEvents(500).filter(event => event.type === 'stage').length, 4);
});

test('stable scan logs retain a later matching job after 100 empty scans', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent'] });
  runner.idleMs = 0;
  let searches = 0;
  browser.discover = async () => { searches++; return searches <= 100 ? [] : [job]; };
  await stopAfterCycles(runner, 101);
  assert.equal(searches, 101);
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
  assert.equal(store.listEvents(500).filter(event => event.type === 'stage').length, 4);
});

test('stable scan logs keep unknown cached jobs untouched while discovering a later company', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent'] });
  runner.idleMs = 0;
  const unknown = companyJob('cached-unknown');
  store.upsertJob(unknown, { eligible: true, greetingStatus: 'uncertain', resumeStatus: 'none' });
  let searches = 0;
  browser.discover = async () => { searches++; return searches <= 100 ? [unknown] : [unknown, job]; };
  await stopAfterCycles(runner, 101);
  assert.equal(searches, 101);
  assert.equal(store.getJob('job:cached-unknown').greetingStatus, 'uncertain');
  assert.equal(store.getJob('job:job1').greetingStatus, 'sent');
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
  assert.equal(store.listEvents(500).filter(event => event.type === 'stage').length, 4);
});

test('stable scan logs notice a different candidate id even at the same result count', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent'] });
  runner.idleMs = 0;
  let searches = 0;
  browser.discover = async () => {
    searches++;
    return [{ ...job, id: searches < 3 ? 'cached' : 'replacement', url: `/job_detail/${searches < 3 ? 'cached' : 'replacement'}.html`, city: '上海' }];
  };
  await stopAfterCycles(runner, 4);
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
  assert.equal(store.listJobs().length, 2);
});

test('stable scan logs notice changed card fields while suppressing harmless result reordering', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent'] });
  runner.idleMs = 0;
  const cards = [companyJob('cached-a'), companyJob('cached-b')].map(card => ({ ...card, city: '上海' }));
  browser.discover = async () => {
    if (runner.state.cycle === 1) return cards;
    if (runner.state.cycle === 2) return [...cards].reverse();
    return [{ ...cards[0], title: 'AI Agent 开发高级实习生' }, cards[1]];
  };
  await stopAfterCycles(runner, 4);
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
});

test('stable scan logs reset on each launch and changed criteria without swallowing action stages', async t => {
  const { runner, browser, store } = fixture(t, { queries: ['AI Agent'] });
  runner.idleMs = 0;
  browser.discover = async () => [];
  await runner.start({ once: true });
  await runner.start({ once: true });
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 2);
  browser.discover = async () => {
    if (runner.state.cycle === 2) store.saveConfig({ ...store.loadConfig(), excludeCompanies: ['新增排除条件'] });
    return [];
  };
  await stopAfterCycles(runner, 4);
  assert.equal(store.listEvents(500).filter(event => event.type === 'search_result').length, 4);
  assert.equal(store.listEvents(500).filter(event => event.type === 'scan_start').length, 4);
});

function deferredFlowFixture(t, config = {}) {
  const state = fixture(t, { queries: ['AI Agent'], ...config });
  const calls = [];
  state.browser.contact = async (input, options) => {
    calls.push({ id: input.id, resumeOnly: options.resumeOnly, deferred: options.deferResumeAfterGreeting });
    if (!options.resumeOnly) {
      await options.onStage('greeting-intent', { greetingStatus: 'intent' });
      await options.onStage('greeting-sent', { greetingStatus: 'sent' });
      return { greetingStatus: 'sent', resumeStatus: 'none', resumeSkipped: true, resumeDeferred: true };
    }
    await options.onStage('resume-unavailable', { resumeStatus: 'unavailable' });
    return { greetingStatus: 'existing', resumeStatus: 'unavailable' };
  };
  return { ...state, calls };
}

test('confirmed greeting deferrals enter the same-cycle attachment queue with a bounded fair batch', async t => {
  const { browser, runner, store, calls } = deferredFlowFixture(t);
  browser.discover = async () => Array.from({ length: 20 }, (_, i) => companyJob(`deferred-${i}`));
  await runner.start({ once: true });
  assert.equal(calls.filter(c => !c.resumeOnly).length, 20);
  assert.ok(calls.filter(c => !c.resumeOnly).every(c => c.deferred === true));
  assert.equal(calls.filter(c => c.resumeOnly).length, 5);
  assert.ok(calls.filter(c => c.resumeOnly).every(c => c.deferred === false));
  assert.equal(runner.snapshot().counts.contacted, 20);
  assert.equal(runner.snapshot().counts.delivered, 0);
  assert.equal(runner.snapshot().counts.uncertain, 0);
  assert.equal(store.getJob('job:deferred-19').resumeStatus, 'none');
});

test('attachment queue rotates oldest first instead of starving old conversations behind new batches', async t => {
  const { browser, runner, store, calls } = deferredFlowFixture(t);
  for (let i = 0; i < 7; i++) store.upsertJob(companyJob(`old-fair-${i}`), { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable', lastResumeCheckAt: `2020-01-0${i + 1}T00:00:00.000Z` });
  browser.discover = async () => Array.from({ length: 20 }, (_, i) => companyJob(`cycle-${runner.snapshot().cycle}-${i}`));
  runner.on('waiting', () => { if (runner.snapshot().cycle === 2) void runner.stop(); });
  await runner.start();
  const checked = calls.filter(c => c.resumeOnly).map(c => c.id);
  assert.equal(checked.length, 10);
  assert.deepEqual(checked.slice(0, 7), Array.from({ length: 7 }, (_, i) => `old-fair-${i}`));
  assert.equal(new Set(checked).size, checked.length);
  assert.equal(runner.snapshot().status, 'stopped');
});

test('attachment queue drains when there are no new contacts and never revisits unknown outcomes', async t => {
  const { browser, runner, store, calls } = deferredFlowFixture(t);
  for (let i = 0; i < 8; i++) store.upsertJob(companyJob(`old-drain-${i}`), { eligible: true, greetingStatus: 'sent', resumeStatus: 'none' });
  store.upsertJob(companyJob('old-unknown'), { eligible: true, greetingStatus: 'sent', resumeStatus: 'uncertain' });
  browser.discover = async () => [];
  await runner.start({ once: true });
  assert.equal(calls.length, 8);
  assert.ok(calls.every(c => c.resumeOnly && c.deferred === false));
  assert.equal(store.getJob('job:old-unknown').resumeStatus, 'uncertain');
});

test('a resume-only company goal processes every deferred candidate needed to reach the goal', async t => {
  const { browser, runner, calls } = deferredFlowFixture(t, { resumeCompanyTarget: 8 });
  browser.discover = async () => Array.from({ length: 12 }, (_, i) => companyJob(`resume-goal-${i}`));
  const contact = browser.contact;
  browser.contact = async (input, options) => {
    if (!options.resumeOnly) return contact(input, options);
    calls.push({ id: input.id, resumeOnly: true, deferred: options.deferResumeAfterGreeting });
    await options.onStage('resume-intent', { resumeStatus: 'intent' });
    await options.onStage('resume-sent', { resumeStatus: 'sent' });
    return { greetingStatus: 'existing', resumeStatus: 'sent' };
  };
  await runner.start({ once: true });
  assert.equal(calls.filter(c => c.resumeOnly).length, 8);
  assert.equal(runner.snapshot().goal.deliveredCompanies, 8);
  assert.equal(runner.snapshot().goal.complete, true);
  assert.equal(runner.snapshot().status, 'completed');
});

test('continuous empty searches rotate a small attachment batch so discovery is not blocked by the whole backlog', async t => {
  const { browser, runner, store, calls } = deferredFlowFixture(t);
  for (let i = 0; i < 8; i++) store.upsertJob(companyJob(`idle-fair-${i}`), { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable', lastResumeCheckAt: `2020-01-0${i + 1}T00:00:00.000Z` });
  let searches = 0;
  browser.discover = async () => { searches++; return []; };
  runner.on('waiting', () => { if (runner.snapshot().cycle === 2) void runner.stop(); });
  await runner.start();
  assert.equal(searches, 2);
  assert.equal(calls.length, 10);
  assert.deepEqual(calls.slice(0, 8).map(c => c.id), Array.from({ length: 8 }, (_, i) => `idle-fair-${i}`));
  assert.ok(calls.every(c => c.resumeOnly));
});

test('search cards preserve saved attachment timestamps so recurring conversations cannot jump the queue', async t => {
  const { browser, runner, store, calls } = deferredFlowFixture(t, { queries: ['AI Agent', '智能体'] });
  const cards = Array.from({ length: 8 }, (_, i) => companyJob(`listed-fair-${i}`));
  cards.forEach((card, i) => store.upsertJob(card, { eligible: true, greetingStatus: 'sent', resumeStatus: 'unavailable', lastResumeCheckAt: `2020-01-0${i + 1}T00:00:00.000Z` }));
  browser.discover = async () => cards.map(card => ({ ...card }));
  runner.on('waiting', () => { if (runner.snapshot().cycle === 2) void runner.stop(); });
  await runner.start();
  assert.equal(calls.length, 10);
  assert.deepEqual(calls.slice(0, 8).map(c => c.id), cards.map(card => card.id));
  assert.ok(calls.every(c => c.resumeOnly));
});


function automaticRecoveryFixture(t, overrides = {}) {
  const state = fixture(t, { queries: ['AI Agent'], delaySeconds: 0, batchBreakMinutes: 0, idleMinutes: 0, ...overrides });
  const first = companyJob('recovery-first'), second = companyJob('recovery-second');
  const sends = [], reads = [], pauses = [];
  state.browser.discover = async () => [first, second];
  state.browser.details = async card => { reads.push(card.id); return card; };
  state.browser.contact = async (card, options) => {
    sends.push(card.id);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    await options.onStage('greeting-sent', { greetingStatus: 'sent' });
    return { greetingStatus: 'sent', resumeStatus: 'sent' };
  };
  state.runner.on('paused', () => { pauses.push(state.runner.snapshot().lastError.code); void state.runner.stop(); });
  return { ...state, first, second, sends, reads, pauses };
}

test('automatic recovery skips a mismatched detail before any intent and continues the next verified job', async t => {
  const state = automaticRecoveryFixture(t);
  state.browser.details = async card => {
    state.reads.push(card.id);
    if (card.id === state.first.id) throw Object.assign(Error('详情页与目标岗位不一致'), { code: 'RECIPIENT_UNVERIFIED' });
    return card;
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.sends, [state.second.id]);
  assert.deepEqual(state.pauses, []);
  assert.equal(state.store.getJob(`job:${state.first.id}`)?.greetingStatus ?? 'none', 'none');
  assert.equal(state.store.getJob(`job:${state.second.id}`).greetingStatus, 'sent');
  const skipped = state.store.listEvents().find(event => event.type === 'job_skipped');
  assert.equal(skipped?.code, 'RECIPIENT_UNVERIFIED');
  assert.equal(skipped?.key, `job:${state.first.id}`);
  assert.equal(state.runner.snapshot().status, 'completed');
});


for (const field of ['id', 'title', 'company', 'url']) test(`automatic recovery rejects returned wrong ${field} without saving its fields or contacting it`, async t => {
  const state = automaticRecoveryFixture(t);
  const wrong = { ...state.first, [field]: `wrong-${field}` };
  if (field === 'id') wrong.url = 'https://www.zhipin.com/job_detail/wrong-id.html';
  state.browser.details = async card => card.id === state.first.id ? wrong : card;
  await state.runner.start({ once: true });
  assert.deepEqual(state.sends, [state.second.id]);
  assert.deepEqual(state.pauses, []);
  assert.equal(state.store.getJob(`job:${wrong.id}`), field === 'id' ? undefined : state.store.getJob(`job:${state.first.id}`));
  assert.equal(state.store.listJobs().some(record => record.title === 'wrong-title' || record.company === 'wrong-company'), false);
});

test('automatic recovery caches the same broken card across repeated cycles without another detail read or pause', async t => {
  const state = automaticRecoveryFixture(t);
  let scans = 0;
  state.browser.discover = async () => {
    if (++scans === 4) { void state.runner.stop(); return []; }
    return [state.first];
  };
  state.browser.details = async card => { state.reads.push(card.id); throw Object.assign(Error('详情错误'), { code: 'RECIPIENT_UNVERIFIED' }); };
  state.runner.idleMs = 0;
  await state.runner.start();
  assert.equal(scans, 4);
  assert.deepEqual(state.reads, [state.first.id]);
  assert.deepEqual(state.pauses, []);
  assert.equal(state.store.listEvents().filter(event => event.type === 'job_skipped').length, 1);
});

for (const change of ['card', 'criteria', 'search', 'url', 'time']) test(`automatic recovery permits a fresh read after ${change} changes, while retaining per-job replay protection`, async t => {
  const state = automaticRecoveryFixture(t);
  let reads = 0, broken = true, tick = 0, card = change === 'url' ? { ...state.first, url: new URL(state.first.url, 'https://www.zhipin.com').href.replace('https:', 'http:') } : state.first;
  state.runner.now = () => tick;
  state.browser.discover = async () => [card];
  state.browser.details = async input => { reads++; if (broken) throw Object.assign(Error('详情错误'), { code: 'RECIPIENT_UNVERIFIED' }); return input; };
  await state.runner.start({ once: true });
  await state.runner.start({ once: true });
  assert.equal(reads, 1);
  if (change === 'card') card = { ...card, title: `${card.title}（新岗位名称）` };
  if (change === 'criteria') state.store.saveConfig({ ...state.store.loadConfig(), excludeCompanies: ['另一个公司'] });
  if (change === 'search') state.store.saveConfig({ ...state.store.loadConfig(), queries: ['智能体'] });
  if (change === 'url') card = { ...card, url: state.first.url };
  if (change === 'time') tick += 10 * 60_000 + 1;
  broken = false;
  await state.runner.start({ once: true });
  assert.equal(reads, 2);
  assert.deepEqual(state.sends, [state.first.id]);
  assert.equal(state.store.getJob(`job:${state.first.id}`).greetingStatus, 'sent');
});

for (const kind of ['result', 'throw']) test(`automatic recovery isolates an uncertain greeting ${kind} and continues another job without repeating on restart`, async t => {
  const state = automaticRecoveryFixture(t);
  const contact = state.browser.contact;
  state.browser.contact = async (card, options) => {
    if (card.id !== state.first.id) return contact(card, options);
    state.sends.push(card.id);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    if (kind === 'throw') throw Object.assign(Error('点击后回执未知'), { code: 'UNKNOWN_RESULT' });
    return { greetingStatus: 'uncertain', resumeStatus: 'none' };
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.sends, [state.first.id, state.second.id]);
  assert.deepEqual(state.pauses, []);
  assert.equal(state.store.getJob(`job:${state.first.id}`).greetingStatus, 'uncertain');
  assert.equal(state.store.getJob(`job:${state.second.id}`).greetingStatus, 'sent');
  state.store.saveConfig({ ...state.store.loadConfig(), excludeCompanies: ['另一个公司'] });
  state.first.title += '（更新）';
  await state.runner.start({ once: true });
  assert.deepEqual(state.sends, [state.first.id, state.second.id]);
});

test('automatic recovery keeps a confirmed greeting when attachment recipient verification fails and processes another job', async t => {
  const state = automaticRecoveryFixture(t);
  const contact = state.browser.contact;
  state.browser.contact = async (card, options) => {
    if (card.id !== state.first.id) return contact(card, options);
    state.sends.push(card.id);
    await options.onStage('greeting-intent', { greetingStatus: 'intent' });
    await options.onStage('greeting-sent', { greetingStatus: 'sent' });
    throw Object.assign(Error('附件会话收件人不可确认'), { code: 'RECIPIENT_UNVERIFIED' });
  };
  await state.runner.start({ once: true });
  assert.deepEqual(state.sends, [state.first.id, state.second.id]);
  assert.equal(state.store.getJob(`job:${state.first.id}`).greetingStatus, 'sent');
  assert.equal(state.store.getJob(`job:${state.first.id}`).resumeStatus, 'none');
  assert.deepEqual(state.pauses, []);
  state.browser.discover = async () => [];
  // Clearing the timed cache permits only a resume-only check; it cannot greet again.
  state.runner.now = () => 10 ** 12;
  state.browser.contact = async (card, options) => {
    assert.equal(options.resumeOnly, true);
    assert.equal(card.id, state.first.id);
    return { greetingStatus: 'existing', resumeStatus: 'unavailable' };
  };
  await state.runner.start({ once: true });
  assert.equal(state.store.getJob(`job:${state.first.id}`).greetingStatus, 'sent');
});

for (const operation of ['details', 'contact']) for (const code of ['CAPTCHA', 'RATE_LIMIT', 'LOGIN_REQUIRED', 'BROWSER_CLOSED', 'EXTENSION_OFFLINE', 'BRIDGE_INACTIVE']) test(`automatic recovery preserves the ${operation} ${code} boundary before touching another job`, async t => {
  const state = automaticRecoveryFixture(t);
  let attempts = 0;
  state.browser[operation] = async card => { attempts++; assert.equal(card.id, state.first.id); throw Object.assign(Error(`boundary ${code}`), { code }); };
  await state.runner.start({ once: true });
  assert.equal(attempts, 1);
  assert.deepEqual(state.sends, []);
  assert.deepEqual(state.pauses, [code]);
  assert.equal(state.store.getJob(`job:${state.second.id}`), undefined);
});

test('automatic recovery does not remove an explicit user pause or prevent stop while a broken job is isolated', async t => {
  const state = automaticRecoveryFixture(t);
  let stopping;
  state.browser.details = async card => {
    assert.equal(card.id, state.first.id);
    state.runner.pause('用户主动暂停', 'USER_PAUSE');
    throw Object.assign(Error('详情错误'), { code: 'RECIPIENT_UNVERIFIED' });
  };
  state.runner.once('paused', () => { stopping = state.runner.stop(); });
  await state.runner.start({ once: true });
  await stopping;
  assert.deepEqual(state.pauses, ['USER_PAUSE']);
  assert.deepEqual(state.sends, []);
  assert.equal(state.runner.snapshot().status, 'stopped');
});


test('automatic recovery cache bounds retained bad jobs without delaying or suppressing a later candidate', async t => {
  const state = automaticRecoveryFixture(t);
  const events = [];
  // This test exercises the job-local recovery budget, not filesystem throughput.
  state.store.appendEvent = event => events.push(event);
  const error = Object.assign(Error('详情不可确认'), { code: 'RECIPIENT_UNVERIFIED' });
  const criteria = 'same-criteria', fingerprint = 'same-card';
  for (let index = 0; index < 1001; index++) state.runner.isolateJob(companyJob(`bounded-recovery-${index}`), criteria, fingerprint, error, 'details');
  assert.equal(state.runner.recoveryBlocked('job:bounded-recovery-0', criteria, fingerprint), false);
  assert.equal(state.runner.recoveryBlocked('job:bounded-recovery-1000', criteria, fingerprint), true);
  assert.equal(state.runner.recoveryBlocked('job:new-valid-candidate', criteria, fingerprint), false);
  assert.equal(state.runner.jobRecoveries.size, 1000);
  assert.equal(events.length, 1001);
});
