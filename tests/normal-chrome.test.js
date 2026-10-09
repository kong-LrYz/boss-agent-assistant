import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, realpath, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { NormalChromeRuntime } from '../src/normal-chrome.js';
import { ChromeRuntime, findChromeExecutable } from '../src/chrome-runtime.js';

const runFile = promisify(execFile);
const recordName = '.boss-normal-session.json';
async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'boss-normal-chrome-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function nativeAvailable(t) {
  if (process.env.CI && !process.env.BOSS_NATIVE_SMOKE) { t.skip('optional native headed Chrome smoke in CI'); return false; }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { t.skip('native Chrome needs a graphical session'); return false; }
  if (!await findChromeExecutable()) { t.skip('Google Chrome not installed'); return false; }
  return true;
}
async function localFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'boss-normal-chrome-'));
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/session') requests++;
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end('<!doctype html><title>正常浏览器本地会话</title><body>本地测试</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { profile: path.join(dir, 'profile'), url: `http://127.0.0.1:${server.address().port}/session`, requests: () => requests, cleanup: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); } };
}
async function eventually(predicate, milliseconds = 6000) {
  const end = Date.now() + milliseconds;
  while (!await predicate()) {
    if (Date.now() >= end) assert.fail('Expected native process or local page condition did not arrive');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function reap(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await eventually(() => child.exitCode !== null || child.signalCode !== null);
  }
}

// Missing Chrome must remain a visible setup failure instead of launching a fallback.
test('normal browser reports a missing installed Chrome without creating a child', async t => {
  const dir = await directory(t);
  const runtime = new NormalChromeRuntime({ env: { BOSS_CHROME_PATH: path.join(dir, 'missing') } });
  await assert.rejects(runtime.launch(path.join(dir, 'profile')), error => error.code === 'BROWSER_NOT_FOUND' && /Google Chrome/u.test(error.message));
  assert.equal(runtime.child, null);
  assert.equal(runtime.session, null);
});

// Changing ownership validation must not let the app take over a user's daily profile.
test('normal browser refuses a daily Chrome profile even through a path alias', async t => {
  const dir = await directory(t);
  const daily = process.platform === 'darwin' ? path.join(dir, 'Library/Application Support/Google/Chrome') : process.platform === 'win32' ? path.join(dir, 'Google/Chrome/User Data') : path.join(dir, '.config/google-chrome');
  await mkdir(daily, { recursive: true });
  const alias = path.join(dir, 'alias');
  await symlink(daily, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = new NormalChromeRuntime({ homeDir: dir, env: { ...process.env, LOCALAPPDATA: dir } });
  await assert.rejects(runtime.launch(alias), error => error.code === 'BROWSER_SESSION_UNVERIFIED');
  assert.equal(runtime.child, null);
});

// Unsafe metadata must fail before launching a replacement or taking process ownership.
test('normal browser rejects malformed and symlinked session records', async t => {
  const dir = await directory(t);
  const profile = path.join(dir, 'profile');
  await mkdir(profile);
  const record = path.join(profile, recordName);
  await writeFile(record, JSON.stringify({ schema: 1, marker: 'invalid', profileDir: profile }), { mode: 0o600 });
  const runtime = new NormalChromeRuntime();
  await assert.rejects(runtime.launch(profile), error => error.code === 'BROWSER_SESSION_UNVERIFIED');
  assert.equal(runtime.child, null);
  await rm(record);
  const target = path.join(dir, 'external-record');
  await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, record);
  await assert.rejects(runtime.launch(profile), error => error.code === 'BROWSER_SESSION_UNVERIFIED');
  assert.equal(await readFile(target, 'utf8'), '{}');
});

// Passing unsupported URL protocols to a real browser would execute unexpected handlers.
test('normal browser refuses unsupported destination protocols before spawning', async t => {
  const dir = await directory(t);
  const runtime = new NormalChromeRuntime();
  await assert.rejects(runtime.launch(path.join(dir, 'profile'), { initialUrl: 'file:///etc/passwd' }), error => error.code === 'BROWSER_START_FAILED');
  assert.equal(runtime.child, null);
});

// Startup failure must reap only the newly created child and report the problem.
test('normal browser cleans up a failing native executable', async t => {
  const dir = await directory(t);
  const runtime = new NormalChromeRuntime({ env: { BOSS_CHROME_PATH: process.execPath }, timeoutMs: 2000 });
  await assert.rejects(runtime.launch(path.join(dir, 'profile'), { initialUrl: 'http://127.0.0.1:1/' }), error => error.code === 'BROWSER_START_FAILED');
  assert.equal(runtime.child, null);
  assert.equal(runtime.session, null);
});

// A fresh backend must reuse the existing normal window without opening duplicate tabs.
test('normal native Chrome has no automation flags and a fresh runtime preserves its session', async t => {
  if (!await nativeAvailable(t)) return;
  const fixture = await localFixture(t);
  const first = new NormalChromeRuntime();
  const second = new NormalChromeRuntime();
  t.after(async () => { await second.close(); await first.close(); await fixture.cleanup(); });
  await first.launch(fixture.profile, { initialUrl: fixture.url });
  const child = first.child;
  await eventually(() => fixture.requests() === 1);
  if (process.platform !== 'win32') {
    const { stdout } = await runFile('ps', ['-p', String(child.pid), '-o', 'command=']);
    assert.doesNotMatch(stdout, /--(?:remote-debugging|load-extension|enable-automation|disable-blink-features)/u);
  }
  const record = JSON.parse(await readFile(path.join(fixture.profile, recordName), 'utf8'));
  assert.equal(record.pid, child.pid);
  assert.equal(record.profileDir, await realpath(fixture.profile));
  assert.match(record.marker, /^[0-9a-f-]{36}$/u);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(fixture.profile, recordName))).mode & 0o777, 0o600);
  await second.launch(fixture.profile, { initialUrl: fixture.url });
  assert.equal(second.session.pid, child.pid);
  assert.equal(second.child, null);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fixture.requests(), 1);
  await second.close();
  await eventually(() => !alive(child.pid));
});

// Re-exec recovery must discard an exited ChildProcess instead of signalling a stale PID.
test('normal native Chrome recovers a replacement process and clears a stale child handle', async t => {
  if (!await nativeAvailable(t)) return;
  const fixture = await localFixture(t);
  const runtime = new NormalChromeRuntime();
  let child;
  t.after(async () => { await runtime.close(); await reap(child); await fixture.cleanup(); });
  await runtime.launch(fixture.profile, { initialUrl: fixture.url });
  child = runtime.child;
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => exited.once('exit', resolve));
  const record = JSON.parse(await readFile(path.join(fixture.profile, recordName), 'utf8'));
  record.pid = exited.pid;
  await writeFile(path.join(fixture.profile, recordName), JSON.stringify(record), { mode: 0o600 });
  runtime.child = exited;
  runtime.session = { ...runtime.session, pid: exited.pid };
  await runtime.launch(fixture.profile, { initialUrl: fixture.url });
  assert.equal(runtime.child, null);
  assert.equal(runtime.session.pid, child.pid);
  assert.equal(JSON.parse(await readFile(path.join(fixture.profile, recordName), 'utf8')).pid, child.pid);
  await runtime.close();
  await eventually(() => !alive(child.pid));
});

// A record changed after recovery must not grant close() authority over that window.
test('normal native recovered Chrome is not closed after its ownership marker changes', async t => {
  if (!await nativeAvailable(t)) return;
  const fixture = await localFixture(t);
  const first = new NormalChromeRuntime();
  const recovered = new NormalChromeRuntime();
  let child;
  t.after(async () => { await recovered.close(); await first.close(); await reap(child); await fixture.cleanup(); });
  await first.launch(fixture.profile, { initialUrl: fixture.url });
  child = first.child;
  await recovered.launch(fixture.profile, { initialUrl: fixture.url });
  const record = JSON.parse(await readFile(path.join(fixture.profile, recordName), 'utf8'));
  record.marker = randomUUID();
  await writeFile(path.join(fixture.profile, recordName), JSON.stringify(record), { mode: 0o600 });
  await recovered.close();
  assert.equal(alive(child.pid), true);
});

// Legacy debug-enabled Chrome must be explicitly replaced rather than silently reused.
test('normal native Chrome refuses an existing profile with remote debugging enabled', async t => {
  if (!await nativeAvailable(t)) return;
  const fixture = await localFixture(t);
  const legacy = new ChromeRuntime();
  const normal = new NormalChromeRuntime();
  t.after(async () => { await normal.close(); await legacy.close(); await fixture.cleanup(); });
  await legacy.launch(fixture.profile, { initialUrl: fixture.url });
  await assert.rejects(normal.launch(fixture.profile, { initialUrl: fixture.url }), error => error.code === 'BROWSER_MODE_CONFLICT' && /调试/u.test(error.message));
  assert.equal(alive(legacy.child.pid), true);
  assert.equal(normal.child, null);
});

// Parallel starters must not interpret a normal ProcessSingleton zero-exit as failure.
test('concurrent normal Chrome launchers recover the same verified primary process', async t => {
  if (!await nativeAvailable(t)) return;
  const fixture = await localFixture(t);
  const first = new NormalChromeRuntime();
  const second = new NormalChromeRuntime();
  t.after(async () => { await second.close(); await first.close(); await fixture.cleanup(); });
  await Promise.all([first.launch(fixture.profile, { initialUrl: fixture.url }), second.launch(fixture.profile, { initialUrl: fixture.url })]);
  assert.equal(first.session.pid, second.session.pid);
  assert.equal(alive(first.session.pid), true);
  assert.ok(first.child === null || first.child.pid === first.session.pid);
  assert.ok(second.child === null || second.child.pid === second.session.pid);
});

// A group-readable record can disclose local ownership details and cannot grant process authority.
test('normal Chrome rejects session metadata readable by other users', async t => {
  if (process.platform === 'win32') return t.skip('POSIX mode permissions do not apply');
  const dir = await directory(t);
  const profile = path.join(dir, 'profile');
  await mkdir(profile);
  const file = path.join(profile, recordName);
  await writeFile(file, JSON.stringify({schema: 1, marker: randomUUID(), pid: process.pid, owner: process.getuid(), executable: process.execPath, profileDir: profile}), { mode: 0o644 });
  await chmod(file, 0o644);
  const runtime = new NormalChromeRuntime();
  await assert.rejects(runtime.launch(profile), error => error.code === 'BROWSER_SESSION_UNVERIFIED');
  assert.equal(runtime.child, null);
});

// The only supported internal setup destination is the extensions management page.
test('normal Chrome can open its explicit extension setup page without a debugging transport', async t => {
  if (!await nativeAvailable(t)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'boss-normal-chrome-'));
  const runtime = new NormalChromeRuntime();
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.launch(path.join(dir, 'profile'), { initialUrl: 'chrome://extensions/' });
  assert.equal(alive(runtime.session.pid), true);
  if (process.platform !== 'win32') {
    const { stdout } = await runFile('ps', ['-p', String(runtime.session.pid), '-o', 'command=']);
    assert.match(stdout, /chrome:\/\/extensions\//u);
    assert.doesNotMatch(stdout, /--(?:remote-debugging|load-extension|enable-automation)/u);
  }
});
