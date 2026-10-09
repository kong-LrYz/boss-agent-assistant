import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/benchmark-throughput.js');
function invoke(args = []) {
  const cwd = mkdtempSync(join(tmpdir(), 'boss-benchmark-cli-'));
  try { return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 }); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('offline throughput CLI reports truthful greeting and deferred attachment workloads from an unrelated directory', () => {
  const result = invoke(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.match(output.scope, /Not measured website throughput or a manual-speed comparison/u);
  assert.equal(output.timing.millisecondsPerBridgeDispatch, 250);
  const [{ scenarios, sourceSha256 }] = output.results;
  assert.ok(Object.values(sourceSha256).every(value => /^[a-f0-9]{64}$/u.test(value)));
  const mixed = scenarios.find(value => value.scenario === 'new_with_historical_pending');
  assert.equal(mixed.confirmedNewGreetings, 20); assert.equal(mixed.confirmedResumeTransfers, 0); assert.equal(mixed.repeatedGreetingEffects, 0);
  assert.ok(mixed.timeTo20thConfirmedGreeting.virtualMs > 0);
  assert.equal(mixed.historicalResumeReads, 5); assert.equal(mixed.newlyContactedResumeReads, 0);
  assert.deepEqual(mixed.attachmentBacklog, { pending: 50, neverCheckedThisCycle: 45, deferredNewGreetings: 20 });
  const drain = scenarios.find(value => value.scenario === 'historical_pending_only');
  assert.equal(drain.historicalResumeReads, 30); assert.equal(drain.attachmentBacklog.neverCheckedThisCycle, 0);
  assert.equal(drain.confirmedNewGreetings, 0); assert.equal(drain.confirmedResumeTransfers, 0);
});

test('offline throughput CLI refuses a baseline whose source digest changed before importing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-benchmark-snapshot-'));
  try {
    const snapshot = join(directory, 'source.json');
    writeFileSync(snapshot, JSON.stringify({ source: { 'src/runner.js': "throw Error('SNAPSHOT_EXECUTED');" }, sha256: { 'src/runner.js': 'incorrect' } }));
    const result = invoke(['--baseline', snapshot]);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /baseline SHA-256 mismatch/u); assert.doesNotMatch(result.stderr, /SNAPSHOT_EXECUTED/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('offline throughput CLI rejects unsupported arguments before running scenarios', () => {
  const result = invoke(['--live']); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /Usage:/u);
});
