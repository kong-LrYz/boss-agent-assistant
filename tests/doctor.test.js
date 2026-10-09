import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { defaultConfig } from '../src/core.js';

const doctor = resolve(import.meta.dirname, '../scripts/doctor.js');
const timestamp = '2026-10-07T00:00:00.000Z';
const record = { key: 'job:one', id: 'one', url: 'https://www.zhipin.com/job_detail/one.html', title: 'AI Agent实习生', company: '示例公司', city: '北京', greetingStatus: 'intent', resumeStatus: 'intent', createdAt: timestamp, updatedAt: timestamp, contactedAt: timestamp };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'boss-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(dir) {
  // The diagnostic only locates an executable; it must never start it. A known
  // executable keeps these filesystem tests independent of an installed Chrome.
  return spawnSync(process.execPath, [doctor], { env: { ...process.env, BOSS_DATA_DIR: dir, BOSS_CHROME_PATH: process.execPath }, encoding: 'utf8', timeout: 10_000 });
}
function writeState(dir, job = record) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig, setupComplete: true }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: { 'job:one': job }, events: [] }));
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('doctor leaves unfinished action intents and both file hashes unchanged', t => {
  const dir = fixture(t);
  writeState(dir);
  const files = ['config.json', 'state.json'].map(name => join(dir, name));
  const before = files.map(hash);
  const modes = files.map(file => statSync(file).mode);
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(files.map(hash), before);
  if (process.platform !== 'win32') assert.deepEqual(files.map(file => statSync(file).mode), modes);
  assert.equal(JSON.parse(readFileSync(files[1], 'utf8')).jobs['job:one'].greetingStatus, 'intent');
  assert.match(result.stdout, /未确认|待确认|意图/);
});

test('doctor reports first-run data without creating a directory or state file', t => {
  const dir = join(fixture(t), 'new-data');
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(dir), false);
  assert.match(result.stdout, /首次/);
});

test('doctor rejects configured data missing its state without creating it', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig, setupComplete: true }));
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /state\.json|缺少.*状态/);
  assert.equal(existsSync(join(dir, 'state.json')), false);
});

test('doctor rejects a damaged action status without repairing the file', t => {
  const dir = fixture(t);
  writeState(dir, { ...record, greetingStatus: 'done' });
  const file = join(dir, 'state.json');
  const before = hash(file);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /状态|无效|损坏/);
  assert.equal(hash(file), before);
});
