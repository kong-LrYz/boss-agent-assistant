import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

async function popupFixture(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  page.setDefaultNavigationTimeout(3000);
  await page.addInitScript(() => {
    window.popupCalls = [];
    window.chrome = { runtime: { sendMessage(message) {
      window.popupCalls.push(message);
      if (message.type === 'BOSS_BRIDGE_STATUS') return new Promise((resolve, reject) => { window.finishInitialStatus = resolve; window.failInitialStatus = reject; });
      if (message.type === 'BOSS_PAIR') return Promise.resolve({ ok: true });
      throw Error('Unexpected popup operation');
    } } };
  });
  const files = new Map(await Promise.all(['popup.html', 'popup.js', 'popup.css'].map(async name => [name, await readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8')])));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1);
    if (url.origin !== 'http://127.0.0.1:17891' || !files.has(name)) return route.abort();
    return route.fulfill({ status: 200, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: files.get(name) });
  });
  await page.goto('http://127.0.0.1:17891/popup.html', { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.finishInitialStatus === 'function');
  return page;
}

test('popup pairs during pending initial state without native navigation or late-state overwrite', async t => {
  const page = await popupFixture(t);
  await page.locator('#base').fill('http://127.0.0.1:17892');
  await page.locator('#code').fill('synthetic-fixture-pair-code');
  await page.locator('button').click();
  assert.equal(await page.evaluate(() => window.popupCalls.filter(call => call.type === 'BOSS_PAIR').length), 1);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('配对成功'));
  assert.equal(page.url(), 'http://127.0.0.1:17891/popup.html');
  await page.evaluate(() => window.finishInitialStatus({ paired: true, base: 'http://127.0.0.1:17893' }));
  assert.equal(await page.locator('#base').inputValue(), 'http://127.0.0.1:17892');
  assert.match(await page.locator('#status').innerText(), /配对成功/u);
  assert.equal(await page.locator('#code').inputValue(), '');
});

test('popup catches initial status failure and still allows one explicit pairing', async t => {
  const page = await popupFixture(t);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => window.failInitialStatus(Error('状态读取失败')));
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('状态读取失败'));
  await page.locator('#code').fill('synthetic-fixture-pair-code');
  await page.locator('button').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('配对成功'));
  assert.equal(await page.evaluate(() => window.popupCalls.filter(call => call.type === 'BOSS_PAIR').length), 1);
  assert.deepEqual(errors, []);
});
