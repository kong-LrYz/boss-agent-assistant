import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfig, jobKey } from '../src/core.js';
import { Runner } from '../src/runner.js';
import { ExtensionBrowser } from '../src/extension-browser.js';
import { Store } from '../src/store.js';
import { EFFECT_OPS } from '../extension/protocol.js';

// Exercise the real scheduler and adapter, replacing only their external bridge
// and clock. These fictional URLs are identity fixtures; no URL is ever opened.
const root = resolve(import.meta.dirname, '..');
const files = ['src/runner.js', 'src/extension-browser.js'];
const hash = source => createHash('sha256').update(source).digest('hex');
const operationMs = 250;
const effects = new Set(EFFECT_OPS);
const contactUrl = 'https://www.zhipin.com/web/geek/chat';

async function baseline(file) {
  const absolute = resolve(file), stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error('--baseline must be a regular local source JSON snapshot, at most 2 MiB');
  const snapshot = JSON.parse(readFileSync(absolute, 'utf8'));
  const implementations = [], sha256 = {};
  for (const name of files) {
    const source = snapshot.source?.[name];
    if (typeof source !== 'string' || !source) throw Error(`baseline is missing ${name}`);
    sha256[name] = hash(source);
    if (snapshot.sha256?.[name] !== sha256[name]) throw Error(`baseline SHA-256 mismatch: ${name}`);
    const allowedImports = name === files[0] ? ['node:events', 'node:perf_hooks', 'node:crypto', './core.js'] : ['node:async_hooks', './normal-chrome.js', '../extension/protocol.js'];
    for (const declaration of source.matchAll(/\bimport\s+[^;]+?\s+from\s+['"]([^'"]+)['"]/gu)) {
      if (!allowedImports.includes(declaration[1])) throw Error(`unsupported baseline dependency: ${declaration[1]}`);
    }
    if (/\b(?:import|require|fetch|WebSocket|XMLHttpRequest)\s*\(/u.test(source)) throw Error('baseline contains an unsupported executable loader or networking primitive');
    const transformed = source.replace(/from\s+(['"])(\.{1,2}\/[^'"]+)\1/gu, (_, quote, specifier) => {
      const allowed = name === files[0] ? ['./core.js'] : ['./normal-chrome.js', '../extension/protocol.js'];
      if (!allowed.includes(specifier)) throw Error(`unsupported baseline dependency: ${specifier}`);
      return `from ${JSON.stringify(pathToFileURL(resolve(root, 'src', specifier)).href)}`;
    });
    // This is a developer benchmark for trusted local source snapshots. It does
    // not fetch packages, dependencies, historical data, or source from a URL.
    implementations.push(await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`));
  }
  if (typeof implementations[0].Runner !== 'function' || typeof implementations[1].ExtensionBrowser !== 'function') throw Error('baseline must export Runner and ExtensionBrowser');
  return { RunnerClass: implementations[0].Runner, BrowserClass: implementations[1].ExtensionBrowser, sourceSha256: sha256 };
}

function job(index, historical = false) {
  const id = `offline-${historical ? 'old' : 'new'}-${String(index + 1).padStart(3, '0')}`;
  return { id, url: `https://www.zhipin.com/job_detail/${id}.html`, title: 'AI Agent 开发实习生',
    company: `离线虚构${historical ? '旧' : '新'}公司 ${index + 1}`, city: '北京',
    description: '使用 Python 开发 AI Agent 智能体。', tags: ['实习'], recruiterName: '虚构招聘者' };
}

class FictionalBridge {
  constructor(store, fresh, historical) {
    Object.assign(this, { store, fresh, clock: 0, epoch: 0, active: false, sequence: 0, calls: [], phase: 'login', currentJob: null, verified: false });
    this.greeted = new Set(historical.map(value => value.id));
    this.historical = new Set(this.greeted);
    this.newGreetingEffects = new Map();
    this.meta = { url: 'https://www.zhipin.com/web/user/', title: 'Offline fixture', documentId: 'fixture-0' };
  }
  snapshot() { return { paired: true, connected: true, epoch: String(this.epoch) }; }
  isConnected() { return true; }
  beginRun() { this.active = true; return String(++this.epoch); }
  cancel() { this.active = false; return String(++this.epoch); }
  document(url, phase) { this.meta = { url, title: 'Offline fixture', documentId: `fixture-${++this.sequence}` }; this.phase = phase; this.verified = false; }
  async request(op, args, options = {}) {
    if (effects.has(op) && !['OPEN_SESSION', 'STOP_SESSION'].includes(op)) assert.deepEqual(options.target?.document, this.meta, 'every fake effect must carry the current document');
    this.clock += operationMs;
    this.calls.push({ op, jobId: args.job?.id ?? null, resumeOnly: args.resumeOnly === true });
    let value;
    switch (op) {
      case 'OPEN_SESSION': this.document(args.url, 'login'); value = { opened: true }; break;
      case 'STOP_SESSION': value = { closed: true }; break;
      case 'READ_STATUS': value = { ready: true, loggedIn: true, account: '离线虚构账号' }; break;
      case 'NAV_SEARCH': {
        const url = new URL('https://www.zhipin.com/web/geek/jobs'); url.searchParams.set('city', args.cityCode); url.searchParams.set('query', args.query);
        this.document(url.href, 'search'); return { navigationStarted: true, destination: url.href };
      }
      case 'READ_CARDS': value = { jobs: this.fresh, empty: this.fresh.length === 0, signature: 'offline-static', next: { available: false, disabled: true } }; break;
      case 'NAV_JOB': this.currentJob = args.job; this.document(args.job.navigationUrl || args.job.url, 'detail'); return { navigationStarted: true, destination: this.meta.url };
      case 'READ_DETAIL': assert.equal(args.job.id, this.currentJob.id); value = { job: this.currentJob, contactExisting: this.greeted.has(this.currentJob.id), contactAvailable: true }; break;
      case 'READ_CONVERSATION':
        value = this.phase === 'portal' ? { verified: this.verified, previewAvailable: true, jobId: this.verified ? this.currentJob.id : undefined, existing: true, emptyNew: false, greetingSent: true, greetingUncertain: false } : { verified: false, previewAvailable: false };
        break;
      case 'OPEN_CONTACT': {
        const record = this.store.getJob(jobKey(args.job));
        if (args.resumeOnly) {
          assert.ok(this.greeted.has(args.job.id), 'continuing contact must be previously greeted');
          assert.ok(['sent', 'existing'].includes(record.greetingStatus));
          this.document(contactUrl, 'portal'); value = { clicked: true, existing: true };
        } else {
          assert.equal(record.greetingStatus, 'intent', 'intent must reach the real temporary Store before the fictional effect');
          assert.equal(this.greeted.has(args.job.id), false, 'a greeting must never be repeated');
          this.greeted.add(args.job.id); this.newGreetingEffects.set(args.job.id, 1); this.phase = 'receipt';
          value = { clicked: true, existing: false };
        }
        break;
      }
      case 'READ_CONTACT_CONFIRMATION':
        assert.equal(this.phase, 'receipt'); value = { confirmed: true, jobId: args.job.id, needsExistingConversation: true, evidence: { kind: 'job-page-contact-confirmation', status: '已发送' } }; break;
      case 'DISMISS_CONTACT_CONFIRMATION': assert.equal(this.store.getJob(jobKey(args.job)).greetingStatus, 'sent'); this.phase = 'detail'; value = { dismissed: true, jobId: args.job.id }; break;
      case 'VERIFY_CONVERSATION_JOB': assert.equal(this.phase, 'portal'); value = { previewStarted: true }; break;
      case 'READ_CONVERSATION_VERIFICATION': this.verified = true; value = { verified: true, jobId: args.job.id }; break;
      case 'READ_RESUME': assert.equal(this.verified, true); value = { verified: true, status: 'unavailable', approved: false, dialog: false, options: [], reason: '离线模拟：需对方回复后才可发送' }; break;
      default: throw Error(`unexpected benchmark command: ${op}`);
    }
    return { ...value, meta: { ...this.meta } };
  }
  counters() {
    const count = test => this.calls.filter(test).length;
    return { bridgeDispatches: this.calls.length, operations: Object.fromEntries([...new Set(this.calls.map(call => call.op))].map(op => [op, count(call => call.op === op)])),
      firstContactOpens: count(call => call.op === 'OPEN_CONTACT' && !call.resumeOnly), existingContactOpens: count(call => call.op === 'OPEN_CONTACT' && call.resumeOnly),
      actualUriPreviewVerifications: count(call => call.op === 'VERIFY_CONVERSATION_JOB'), resumeReads: count(call => call.op === 'READ_RESUME'),
      historicalResumeReads: count(call => call.op === 'READ_RESUME' && this.historical.has(call.jobId)),
      newlyContactedResumeReads: count(call => call.op === 'READ_RESUME' && !this.historical.has(call.jobId)) };
  }
}

async function scenario(implementation, name) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boss-offline-throughput-'));
  try {
    const single = name === 'single_native_receipt', fresh = Array.from({ length: single ? 1 : name === 'historical_pending_only' ? 0 : 20 }, (_, index) => job(index));
    const historical = Array.from({ length: single ? 0 : 30 }, (_, index) => job(index, true));
    const store = new Store(dataDir);
    store.saveConfig({ ...defaultConfig, setupComplete: true, autoRun: false, queries: ['AI Agent'], maxPages: 1, contactCompanyTarget: 500, resumeCompanyTarget: 100 });
    for (const value of historical) store.upsertJob(value, { eligible: true, greetingStatus: 'existing', resumeStatus: 'unavailable' });
    const bridge = new FictionalBridge(store, fresh, historical), launcher = { async launch() {}, async close() {} };
    const browser = new implementation.BrowserClass({ bridge, launcher, profileDir: join(dataDir, 'fixture-profile'), outputDir: dataDir,
      now: () => bridge.clock, sleep: async ms => { bridge.clock += ms; }, navigationDelayMs: 0 });
    let greetingMilestone = null, snapshot, contactChain;
    if (single) {
      store.upsertJob(fresh[0]); await browser.details(fresh[0]); bridge.calls.length = 0; bridge.clock = 0;
      const result = await browser.contact(fresh[0], { deferResumeAfterGreeting: true, onStage: async (_, patch) => store.upsertJob(fresh[0], patch) });
      assert.equal(result.greetingStatus, 'sent'); assert.notEqual(result.resumeStatus, 'sent');
      store.upsertJob(fresh[0], result); snapshot = { status: 'completed', counts: { uncertain: 0 }, performance: { verifiedNewContacts: 1 } };
      contactChain = { virtualMs: bridge.clock, ...bridge.counters() };
      await browser.close();
    } else {
      const runner = new implementation.RunnerClass({ store, browser, now: () => bridge.clock, sleep: async (ms, signal) => { assert.equal(signal.aborted, false); bridge.clock += ms; } });
      browser.checkpoint = () => runner.checkpoint();
      runner.on('paused', () => { throw Error(`offline benchmark paused: ${runner.snapshot().lastError?.code}`); });
      runner.on('update', state => {
        if (!greetingMilestone && state.performance.verifiedNewContacts === 20) greetingMilestone = { virtualMs: bridge.clock, ...bridge.counters() };
      });
      await runner.start({ once: true }); snapshot = runner.snapshot();
      assert.equal(snapshot.lastError, null); assert.equal(snapshot.counts.uncertain, 0);
    }
    assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.performance.verifiedNewContacts, fresh.length);
    assert.equal(bridge.newGreetingEffects.size, fresh.length);
    assert.ok([...bridge.newGreetingEffects.values()].every(count => count === 1));
    const records = store.listJobs(), checked = new Set(bridge.calls.filter(call => call.op === 'READ_RESUME').map(call => call.jobId));
    assert.equal(records.filter(record => record.resumeStatus === 'sent').length, 0, 'unavailable attachments must never be reported as sent');
    const pending = records.filter(record => ['none', 'requested', 'unavailable'].includes(record.resumeStatus));
    return { scenario: name, newJobs: fresh.length, historicalPendingJobs: historical.length,
      confirmedNewGreetings: fresh.length, confirmedResumeTransfers: 0, repeatedGreetingEffects: 0,
      ...(contactChain ? { contactChain } : {}),
      timeTo20thConfirmedGreeting: greetingMilestone, virtualCycleMsIncludingClose: bridge.clock, ...bridge.counters(),
      attachmentBacklog: { pending: pending.length, neverCheckedThisCycle: pending.filter(record => !checked.has(record.id)).length,
        deferredNewGreetings: records.filter(record => record.resumeDeferred === true).length } };
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

export async function runBenchmark({ baselinePath } = {}) {
  const current = { RunnerClass: Runner, BrowserClass: ExtensionBrowser, sourceSha256: Object.fromEntries(files.map(file => [file, hash(readFileSync(join(root, file), 'utf8'))])) };
  const variants = baselinePath ? [['baseline', await baseline(baselinePath)], ['current', current]] : [['current', current]];
  const results = [];
  for (const [version, implementation] of variants) {
    const scenarios = [];
    for (const name of ['single_native_receipt', 'new_with_historical_pending', 'historical_pending_only']) scenarios.push(await scenario(implementation, name));
    results.push({ version, sourceSha256: implementation.sourceSha256, scenarios });
  }
  const comparison = results.length === 2 ? results[0].scenarios.map((before, index) => {
    const after = results[1].scenarios[index]; assert.equal(after.confirmedNewGreetings, before.confirmedNewGreetings);
    const saved = (field, initial, currentValue) => ({ metric: field, baseline: initial, current: currentValue, reductionPercent: Number(((1 - currentValue / initial) * 100).toFixed(2)) });
    return { scenario: before.scenario, bridgeDispatches: saved('bridgeDispatches', before.bridgeDispatches, after.bridgeDispatches),
      ...(before.contactChain ? { contactChainDispatches: saved('bridgeDispatches', before.contactChain.bridgeDispatches, after.contactChain.bridgeDispatches) } : {}),
      ...(before.timeTo20thConfirmedGreeting ? { timeTo20thConfirmedGreeting: saved('virtualMs', before.timeTo20thConfirmedGreeting.virtualMs, after.timeTo20thConfirmedGreeting.virtualMs) } : {}),
      attachmentWorkloadEqual: before.resumeReads === after.resumeReads,
      baselineResumeReads: before.resumeReads, currentResumeReads: after.resumeReads,
      baselineBacklog: before.attachmentBacklog, currentBacklog: after.attachmentBacklog };
  }) : undefined;
  return { benchmark: 'runner-extension-offline-throughput-v1',
    scope: 'Local virtual-time simulation of actual Runner and ExtensionBrowser methods. No website, browser, HTTP, greetings or resume transfers. Not measured website throughput or a manual-speed comparison.',
    timing: { millisecondsPerBridgeDispatch: operationMs, modeled: 'Every semantic bridge request costs 250 ms; all readiness checks succeed immediately.',
      excluded: 'Real page/network/render latency, extension internals, disk latency, browser startup, retries, rate limits, HR replies and manual actions.' },
    workload: '20 new native-receipt greetings and 30 historical unavailable attachments. Greeting deferral reduces immediate attachment work; backlog and attachment-read counts are reported separately. A pending-only cycle validates queue draining.',
    storage: 'Fresh temporary Store per scenario, always removed. Existing user data is never read.', results, ...(comparison ? { comparison } : {}) };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const args = process.argv.slice(2);
  try {
    if (args.length && (args.length !== 2 || args[0] !== '--baseline')) throw Error('Usage: node scripts/benchmark-throughput.js [--baseline <trusted-source-snapshot.json>]');
    process.stdout.write(`${JSON.stringify(await runBenchmark({ baselinePath: args[1] }), null, 2)}\n`);
  } catch (error) { process.stderr.write(`Offline throughput benchmark failed: ${error.message}\n`); process.exitCode = 1; }
}
