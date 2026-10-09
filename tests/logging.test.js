import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BossBrowser } from '../src/boss-browser.js';

const moduleUrl = new URL('../src/logging.js', import.meta.url).href;
const logging = await import(moduleUrl).catch(() => ({}));

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('runtime logger bounds each UTF-8 entry and preserves the newest entry after rotation', t => {
  assert.equal(typeof logging.RuntimeLog, 'function');
  const dir = temporary(t);
  const logger = new logging.RuntimeLog(dir, { maxBytes: 256, maxLineBytes: 128 });
  logger.write('info', '中文'.repeat(1000));
  for (let i = 0; i < 30; i++) logger.write('info', `entry-${i}`);
  assert.match(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8'), /entry-29/);
  for (const filename of fs.readdirSync(dir)) {
    const bytes = fs.readFileSync(path.join(dir, filename));
    assert.ok(bytes.length <= 256);
    assert.ok(!bytes.toString('utf8').includes('\uFFFD'));
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) assert.ok(Buffer.byteLength(`${line}\n`) <= 128);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, filename)).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['runtime.log', 'runtime.log.1', 'runtime.log.2']);
});

test('logger clamps huge existing runtime logs on restart without reading them in full', t => {
  assert.equal(typeof logging.RuntimeLog, 'function');
  const dir = temporary(t);
  for (const filename of ['runtime.log', 'runtime.log.1', 'runtime.log.2']) fs.writeFileSync(path.join(dir, filename), `${'old-entry\n'.repeat(2000)}recent-entry\n`);
  const logger = new logging.RuntimeLog(dir, { maxBytes: 256, maxLineBytes: 128 });
  logger.write('info', 'after-restart');
  for (const filename of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, filename)).size <= 256);
  assert.match(fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8'), /after-restart/);
  assert.match(fs.readFileSync(path.join(dir, 'runtime.log.1'), 'utf8'), /recent-entry/);
});

test('runtime log refuses symlink files and archives without touching their destinations', t => {
  assert.equal(typeof logging.RuntimeLog, 'function');
  const dir = temporary(t), external = path.join(dir, 'external.txt');
  fs.writeFileSync(external, 'protected');
  for (const filename of ['runtime.log', 'runtime.log.1', 'runtime.log.2']) {
    const link = path.join(dir, filename);
    fs.symlinkSync(external, link);
    assert.throws(() => new logging.RuntimeLog(dir), /普通|符号|regular|symlink/iu);
    assert.equal(fs.readFileSync(external, 'utf8'), 'protected');
    fs.unlinkSync(link);
  }
  const linkedDir = path.join(dir, 'linked');
  fs.symlinkSync(dir, linkedDir, 'dir');
  assert.throws(() => new logging.RuntimeLog(linkedDir), /目录|directory/iu);
});

test('runtime rotation refuses an archive linked after startup and preserves its destination', t => {
  const dir = temporary(t), external = path.join(dir, 'external.txt');
  fs.writeFileSync(external, 'protected');
  const logger = new logging.RuntimeLog(dir, { maxBytes: 256, maxLineBytes: 128 });
  logger.write('info', 'x'.repeat(80));
  logger.write('info', 'x'.repeat(80));
  fs.symlinkSync(external, path.join(dir, 'runtime.log.1'));
  assert.throws(() => logger.write('info', 'x'.repeat(120)), /普通|符号|regular|symlink/iu);
  assert.equal(fs.readFileSync(external, 'utf8'), 'protected');
  assert.ok(fs.statSync(path.join(dir, 'runtime.log')).size <= 256);
});

test('console logger writes bounded files even when the launcher discards stdout and stderr', t => {
  const dir = temporary(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installConsoleLogger } from ${JSON.stringify(moduleUrl)};
    installConsoleLogger(process.env.BOSS_LOG_TEST_DIR);
    console.log('startup marker');
    console.error('error marker');
    console.log('z'.repeat(50000));
  `], { env: { ...process.env, BOSS_LOG_TEST_DIR: dir }, stdio: 'ignore', timeout: 10_000 });
  assert.equal(result.status, 0);
  const content = fs.readFileSync(path.join(dir, 'runtime.log'), 'utf8');
  assert.match(content, /startup marker/);
  assert.match(content, /error marker/);
  assert.ok(fs.statSync(path.join(dir, 'runtime.log')).size < 10_000);
});

test('diagnostic retention removes only explicitly managed files and keeps manual and legacy evidence', t => {
  assert.equal(typeof logging.pruneDiagnostics, 'function');
  const dir = temporary(t);
  for (let i = 0; i < 24; i++) {
    const label = i === 23 ? 'resume-uncertain' : 'page';
    const filename = `boss-diag-${1700000000000 + i}-${label}-1234abcd.png`;
    fs.writeFileSync(path.join(dir, filename), Buffer.alloc(64));
  }
  const protectedNames = ['1700000000000-greeting-uncertain-1234abcd.png', 'user-evidence.png', 'capture.json'];
  for (const filename of protectedNames) fs.writeFileSync(path.join(dir, filename), 'protected');
  const symlink = 'boss-diag-1700000000999-page-1234abcd.png';
  fs.symlinkSync(path.join(dir, 'user-evidence.png'), path.join(dir, symlink));
  logging.pruneDiagnostics(dir, { maxFiles: 3, maxBytes: 160 });
  const managed = fs.readdirSync(dir).filter(name => name.startsWith('boss-diag-') && !fs.lstatSync(path.join(dir, name)).isSymbolicLink());
  assert.deepEqual(managed.sort(), ['boss-diag-1700000000022-page-1234abcd.png', 'boss-diag-1700000000023-resume-uncertain-1234abcd.png']);
  for (const filename of protectedNames) assert.equal(fs.readFileSync(path.join(dir, filename), 'utf8'), 'protected');
  assert.equal(fs.lstatSync(path.join(dir, symlink)).isSymbolicLink(), true);
});

test('diagnostic retention rejects a linked directory without removing any evidence', t => {
  assert.equal(typeof logging.pruneDiagnostics, 'function');
  const dir = temporary(t), nested = path.join(dir, 'real');
  fs.mkdirSync(nested);
  const filename = path.join(nested, 'boss-diag-1700000000000-page-1234abcd.png');
  fs.writeFileSync(filename, 'protected');
  const link = path.join(dir, 'link');
  fs.symlinkSync(nested, link, 'dir');
  assert.throws(() => logging.pruneDiagnostics(link, { maxFiles: 0 }), /目录|directory/iu);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'protected');
});

test('event limits include JSON escaping and malformed status payloads', () => {
  assert.equal(typeof logging.boundEvent, 'function');
  for (const message of ['\n'.repeat(100_000), '"\\'.repeat(100_000), { items: Array.from({ length: 100 }, () => 'x'.repeat(8000)) }]) {
    const record = logging.boundEvent({ id: 'stable-id', at: '2026-10-07T00:00:00Z', type: 'error', key: 'job:one', stage: 'resume', code: 'UNKNOWN', message });
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 8192);
    assert.equal(record.id, 'stable-id');
    assert.equal(record.type, 'error');
    assert.equal(record.key, 'job:one');
    assert.equal(record.stage, 'resume');
    assert.equal(record.truncated, true);
  }
});

test('browser error screenshots remain bounded and unsafe labels cannot escape the diagnostic directory', async t => {
  const dir = temporary(t), outputDir = path.join(dir, 'diagnostics');
  const browser = new BossBrowser({ profileDir: path.join(dir, 'profile'), outputDir });
  browser.page = {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/job_detail/fixture.html',
    screenshot: async ({ path: target }) => fs.writeFileSync(target, Buffer.alloc(1024)),
  };
  for (let i = 0; i < 25; i++) await browser.screenshot(i === 24 ? '../../../resume-uncertain' : 'page');
  const files = fs.readdirSync(outputDir);
  assert.equal(files.length, 20);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.ok(files.every(filename => filename.startsWith('boss-diag-')));
  if (process.platform !== 'win32') assert.ok(files.every(filename => (fs.statSync(path.join(outputDir, filename)).mode & 0o777) === 0o600));
});

test('an oversized error screenshot does not return an evidence path after retention removed it', async t => {
  const dir = temporary(t), outputDir = path.join(dir, 'diagnostics');
  const browser = new BossBrowser({ profileDir: path.join(dir, 'profile'), outputDir });
  browser.page = {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/job_detail/fixture.html',
    screenshot: async ({ path: target }) => fs.writeFileSync(target, Buffer.alloc(11 * 1024 * 1024)),
  };
  const evidence = await browser.screenshot('greeting-uncertain');
  assert.equal(evidence.screenshot, undefined);
  assert.equal(evidence.diagnosticExpired, true);
  assert.equal(evidence.url, 'https://www.zhipin.com/job_detail/fixture.html');
  assert.equal(fs.readdirSync(outputDir).length, 0);
});

test('partially written screenshots obey the file count limit even when screenshot capture throws', async t => {
  const dir = temporary(t), outputDir = path.join(dir, 'diagnostics');
  const browser = new BossBrowser({ profileDir: path.join(dir, 'profile'), outputDir });
  browser.page = {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/job_detail/fixture.html',
    screenshot: async ({ path: target }) => {
      fs.writeFileSync(target, Buffer.alloc(1024));
      throw new Error('capture interrupted');
    },
  };
  for (let i = 0; i < 25; i++) {
    const evidence = await browser.screenshot('greeting-uncertain');
    assert.equal(evidence.screenshot, undefined);
  }
  assert.equal(fs.readdirSync(outputDir).length, 20);
});

test('an oversized partial capture is pruned while the original unknown error remains intact', async t => {
  const dir = temporary(t), outputDir = path.join(dir, 'diagnostics');
  const browser = new BossBrowser({ profileDir: path.join(dir, 'profile'), outputDir });
  browser.page = {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/job_detail/fixture.html',
    screenshot: async ({ path: target }) => {
      fs.writeFileSync(target, Buffer.alloc(11 * 1024 * 1024));
      throw new Error('capture interrupted');
    },
  };
  await assert.rejects(browser.fail('UNKNOWN', 'operation result remains unknown'), error => {
    assert.equal(error.code, 'UNKNOWN');
    assert.equal(error.message, 'operation result remains unknown');
    assert.equal(error.evidence.screenshot, undefined);
    assert.equal(error.evidence.url, 'https://www.zhipin.com/job_detail/fixture.html');
    return true;
  });
  assert.equal(fs.readdirSync(outputDir).length, 0);
});
