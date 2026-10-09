import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfig, jobKey } from '../src/core.js';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';

// This measures scheduling with virtual time, not website throughput. All jobs,
// browser responses, and effects below are fictional; no browser is opened.
const root = resolve(import.meta.dirname, '..');
const timing = Object.freeze({ openMs: 200, loginMs: 300, discoveryMs: 1000,
  detailsMs: 4000, conversationPreparationMs: 2000, greetingConfirmationMs: 1000,
  resumePreparationMs: 1000, resumeConfirmationMs: 1000 });
const referencePacing = process.argv.includes('--reference-pacing');
const scheduling = Object.freeze(referencePacing
  ? { delaySeconds: 30, contactBatchSize: 10, batchBreakMinutes: 2 }
  : { delaySeconds: defaultConfig.delaySeconds, contactBatchSize: 10, batchBreakMinutes: defaultConfig.batchBreakMinutes });
const hash = source => createHash('sha256').update(source).digest('hex');

async function loadBaseline(file) {
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || !/\.(?:m?js)$/.test(absolute)) {
    throw new Error('--baseline must be a regular local Runner .js or .mjs source file (at most 1 MiB)');
  }
  const source = readFileSync(absolute, 'utf8');
  const allowedImports = [
    "import { EventEmitter } from 'node:events';",
    "import { performance } from 'node:perf_hooks';",
    "import { evaluateJob, jobKey, normalizeCompany, precheckJob, renderGreeting } from './core.js';",
  ];
  let body = source;
  for (const declaration of allowedImports) {
    assert.equal(body.split(declaration).length, 2, `baseline must contain exactly one expected import: ${declaration}`);
    body = body.replace(declaration, '');
  }
  const fingerprintImport = "import { createHash } from 'node:crypto';";
  if (body.includes(fingerprintImport)) {
    assert.equal(body.split(fingerprintImport).length, 2, 'baseline fingerprint import must be unique');
    body = body.replace(fingerprintImport, '');
  }
  // Baselines are trusted local Runner snapshots, not arbitrary modules. Do not
  // resolve any additional dependency, dynamic import, or networking primitive.
  if (/\b(?:import|require|fetch|WebSocket|XMLHttpRequest|eval|Function)\b/.test(body)) {
    throw new Error('baseline contains an unsupported import, executable loader, or networking primitive');
  }
  assert.match(body, /export class Runner extends EventEmitter\s*\{/);
  const transformed = source.replace(allowedImports[2],
    `import { evaluateJob, jobKey, normalizeCompany, precheckJob, renderGreeting } from ${JSON.stringify(pathToFileURL(join(root, 'src/core.js')).href)};`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`);
  return { RunnerClass: module.Runner, sourceHash: hash(source) };
}

function fictionalJob(index) {
  const id = `benchmark-${String(index + 1).padStart(3, '0')}`;
  return { id, url: `https://example.invalid/job_detail/${id}.html`, title: 'AI Agent 开发实习生',
    company: `本地基准虚构公司 ${index + 1}`, city: '北京', description: '使用 Python 开发 AI Agent 智能体。', tags: ['实习'] };
}

async function scenario(RunnerClass, name) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boss-local-benchmark-'));
  try {
    const isNew = name === 'new_companies';
    const jobs = Array.from({ length: isNew ? 20 : 40 }, (_, index) => fictionalJob(index));
    const store = new Store(dataDir);
    store.saveConfig({ ...defaultConfig, ...scheduling, setupComplete: true, autoRun: false,
      queries: ['AI Agent'], companyDedup: true, contactCompanyTarget: isNew ? jobs.length : 0,
      resumeCompanyTarget: isNew ? jobs.length : 0 });
    if (!isNew) {
      for (const job of jobs) store.upsertJob(job, { eligible: true, greetingStatus: 'existing', resumeStatus: 'none' });
    }
    let clock = 0;
    let readPreparationMs = 0;
    let confirmationMs = 0;
    const effectIntents = [];
    const flows = [];
    const browser = {
      async open() { clock += timing.openMs; readPreparationMs += timing.openMs; },
      async close() {},
      async login() { clock += timing.loginMs; readPreparationMs += timing.loginMs; return { loggedIn: true }; },
      async discover() { clock += timing.discoveryMs; readPreparationMs += timing.discoveryMs; return jobs; },
      async details(job) { clock += timing.detailsMs; readPreparationMs += timing.detailsMs; return { ...job }; },
      async contact(job, options) {
        const flow = { company: job.company, firstIntentMs: null, completedMs: null };
        const stageIntent = async (field, stage) => {
          await options.onStage(stage, { [field]: 'intent' });
          // The actual Store must persist the intent before our fictional effect.
          assert.equal(store.getJob(jobKey(job))[field], 'intent');
          if (flow.firstIntentMs === null) flow.firstIntentMs = clock;
          effectIntents.push({ company: job.company, kind: field, atMs: clock });
        };
        clock += timing.conversationPreparationMs;
        readPreparationMs += timing.conversationPreparationMs;
        if (!isNew) {
          assert.equal(options.resumeOnly, true);
          flow.completedMs = clock;
          flows.push(flow);
          return { greetingStatus: 'existing', resumeStatus: 'unavailable', note: '本地替身：附件控件不可用' };
        }
        assert.equal(options.resumeOnly, false);
        assert.equal(options.sendResume, true);
        await stageIntent('greetingStatus', 'before_greeting');
        clock += timing.greetingConfirmationMs;
        confirmationMs += timing.greetingConfirmationMs;
        await options.onStage('greeting_confirmed', { greetingStatus: 'sent' });
        clock += timing.resumePreparationMs;
        readPreparationMs += timing.resumePreparationMs;
        await stageIntent('resumeStatus', 'before_resume');
        clock += timing.resumeConfirmationMs;
        confirmationMs += timing.resumeConfirmationMs;
        await options.onStage('resume_confirmed', { resumeStatus: 'sent' });
        flow.completedMs = clock;
        flows.push(flow);
        return { greetingStatus: 'sent', resumeStatus: 'sent', note: '本地替身：已确认' };
      },
    };
    const runner = new RunnerClass({ store, browser, now: () => clock,
      sleep: async (ms, signal) => { assert.equal(signal.aborted, false); clock += ms; } });
    runner.on('paused', () => { throw new Error(`benchmark unexpectedly paused: ${runner.snapshot().lastError?.code}`); });
    await runner.start({ once: true });
    const snapshot = runner.snapshot();
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.lastError, null);
    assert.equal(snapshot.counts.uncertain, 0);
    const effectFlows = flows.filter(flow => flow.firstIntentMs !== null);
    const firstIntentIntervals = effectFlows.slice(1).map((flow, index) => flow.firstIntentMs - effectFlows[index].firstIntentMs);
    const completionToNextIntent = effectFlows.slice(1).map((flow, index) => flow.firstIntentMs - effectFlows[index].completedMs);
    const safeGap = scheduling.delaySeconds * 1000;
    assert.equal(effectFlows.length, isNew ? jobs.length : 0);
    assert.ok(completionToNextIntent.every(gap => gap >= safeGap), 'next-company effect happened before previous flow completion + configured delay');
    assert.equal(snapshot.performance.verifiedNewContacts, isNew ? jobs.length : 0);
    assert.equal(snapshot.goal.contactedCompanies, isNew ? jobs.length : 0);
    assert.equal(snapshot.goal.deliveredCompanies, isNew ? jobs.length : 0);
    assert.equal(effectIntents.length, isNew ? jobs.length * 2 : 0);
    assert.equal(snapshot.performance.elapsedMs, clock);
    assert.equal(clock, readPreparationMs + confirmationMs + snapshot.performance.waitedMs);
    if (!isNew) assert.equal(snapshot.performance.waitedMs, 0, 'read-only unavailable conversations must not incur effect pacing');
    return { scenario: name, jobs: jobs.length, virtualElapsedMs: clock,
      readPreparationMs, confirmationMs, configuredWaitMs: snapshot.performance.waitedMs,
      contactWaitMs: snapshot.performance.contactWaitMs, batchWaitMs: snapshot.performance.batchWaitMs,
      verifiedNewContacts: snapshot.performance.verifiedNewContacts,
      confirmedResumeCompanies: snapshot.goal.deliveredCompanies, effectIntentCount: effectIntents.length,
      minCrossCompanyFirstIntentIntervalMs: firstIntentIntervals.length ? Math.min(...firstIntentIntervals) : null,
      minPreviousFlowCompletionToNextIntentMs: completionToNextIntent.length ? Math.min(...completionToNextIntent) : null,
      conservativeDelaySatisfied: completionToNextIntent.every(gap => gap >= safeGap),
      completeGoal: snapshot.goal.complete, uncertain: snapshot.counts.uncertain };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--reference-pacing');
  if (args.length && (args.length !== 2 || args[0] !== '--baseline')) throw new Error('Usage: node scripts/benchmark.js [--reference-pacing] [--baseline <local-runner-source.mjs>]');
  const current = { RunnerClass: Runner, sourceHash: hash(readFileSync(join(root, 'src/runner.js'), 'utf8')) };
  const versions = args.length ? [['baseline', await loadBaseline(args[1])], ['current', current]] : [['current', current]];
  const results = [];
  for (const [version, implementation] of versions) {
    const scenarios = [];
    for (const name of ['new_companies', 'existing_unavailable']) scenarios.push(await scenario(implementation.RunnerClass, name));
    results.push({ version, sourceSha256: implementation.sourceHash, scenarios });
  }
  const comparison = results.length === 2 ? results[0].scenarios.map((baseline, index) => {
    const currentResult = results[1].scenarios[index];
    assert.equal(currentResult.jobs, baseline.jobs);
    assert.equal(currentResult.effectIntentCount, baseline.effectIntentCount);
    return { scenario: baseline.scenario, virtualElapsedMsSaved: baseline.virtualElapsedMs - currentResult.virtualElapsedMs,
      reductionPercent: Number(((1 - currentResult.virtualElapsedMs / baseline.virtualElapsedMs) * 100).toFixed(2)) };
  }) : undefined;
  process.stdout.write(`${JSON.stringify({ benchmark: 'runner-local-scheduling-v1',
    scope: 'Virtual-time local simulation; no real website requests, browser, greeting, or resume transfer.',
    storage: 'Fresh temporary Store per scenario, removed before output; user data is not loaded.',
    pacingMode: referencePacing ? 'explicit-reference-30s-2min' : 'current-default-no-extra-wait', scheduling, timing, results, ...(comparison ? { comparison } : {}) }, null, 2)}\n`);
}

await main().catch(error => { process.stderr.write(`Local benchmark failed: ${error.message}\n`); process.exitCode = 1; });
