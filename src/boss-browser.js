import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import defaultSelectors from './selectors.js';
import { ChromeRuntime } from './chrome-runtime.js';
import { pruneDiagnostics } from './logging.js';

const normalized = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const same = (left, right) => normalized(left) === normalized(right) && normalized(left) !== '';
const exactText = value => new RegExp(`^\\s*${normalized(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+')}\\s*$`, 'u');
const navigationUrl = value => {
  try { const url = new URL(value); url.hash = ''; url.searchParams.sort(); return url.href; }
  catch { return String(value); }
};
function jobUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || !/^\/job_detail\/[A-Za-z0-9_-]+\.html$/u.test(url.pathname)) throw new Error('只允许 BOSS 岗位详情地址');
  return `${url.origin}${url.pathname}`;
}

export class BossBrowser {
  constructor({ profileDir, outputDir, onEvent = async () => {}, checkpoint = async () => {}, selectors = {} }) {
    this.profileDir = path.resolve(profileDir);
    this.outputDir = path.resolve(outputDir);
    this.onEvent = onEvent;
    this.checkpoint = checkpoint;
    this.selectors = { ...defaultSelectors, ...selectors };
    this.context = null;
    this.page = null;
    this.authPage = null;
    this.workPage = null;
    this.lastNavigationAt = 0;
    this.lastKnownUrl = '';
    this.opening = null;
    this.chromeRuntime = null;
    this.boundPages = new WeakSet();
    this.navigationStates = new WeakMap();
  }

  async open() {
    while (this.opening) await this.opening;
    this.opening = this.openContext();
    try { return await this.opening; } finally { this.opening = null; }
  }

  async openForLogin() {
    if (this.selectors.transport === 'library') return this.open();
    while (this.opening) await this.opening;
    this.opening = this.launchManualLogin();
    try { return await this.opening; } finally { this.opening = null; }
  }

  async launchManualLogin() {
    await this.checkpoint();
    this.context = null;
    this.page = null;
    this.authPage = null;
    this.workPage = null;
    if (!this.chromeRuntime) this.chromeRuntime = new ChromeRuntime();
    await this.chromeRuntime.detach();
    await this.chromeRuntime.launch(this.profileDir, { checkpoint: this.checkpoint, initialUrl: this.selectors.loginUrl });
    await this.onEvent({ type: 'browser-open', message: 'Google Chrome 专用窗口已启动；请手动完成 BOSS 登录后点击开始' });
  }

  bindPage(page) {
    this.page = page;
    page.setDefaultTimeout(this.selectors.timeoutMs);
    page.setDefaultNavigationTimeout(30000);
    if (this.boundPages.has(page)) return;
    this.boundPages.add(page);
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      const state = this.navigationStates.get(page);
      if (!state || state.reversed) return;
      const current = navigationUrl(frame.url());
      if (current === state.target) { state.committed = true; return; }
      if (state.committed && (current === 'about:blank' || current === state.before)) {
        state.reversed = true;
        state.returnedUrl = current;
      }
    });
    page.on('close', () => {
      this.navigationStates.delete(page);
      if (this.page === page) { this.lastKnownUrl = page.url(); this.page = null; }
      if (this.authPage === page) this.authPage = null;
      if (this.workPage === page) this.workPage = null;
    });
  }

  async useWorkPage() {
    await this.open();
    await this.checkpoint();
    await this.requireOpenPage();
    if (!this.workPage || this.workPage.isClosed()) {
      try { this.workPage = await this.context.newPage(); }
      catch (error) {
        if (!this.context || /closed|disconnected/iu.test(error.message)) await this.fail('BROWSER_CLOSED', 'BOSS 浏览器已关闭，请重新打开并登录后继续');
        throw error;
      }
    }
    if (this.page !== this.workPage) this.bindPage(this.workPage);
  }

  async openContext() {
    const previous = this.context;
    if (previous && previous.browser()?.isConnected()) {
      if (this.page && !this.page.isClosed()) return;
      await this.checkpoint();
      try {
        const livePage = previous.pages().find(page => !page.isClosed());
        if (livePage) { this.bindPage(livePage); return; }
        if (this.selectors.transport === 'library') { this.bindPage(await previous.newPage()); return; }
        // Reopen a closed native window through the same normal startup flow.
        if (this.chromeRuntime) await this.chromeRuntime.close();
      } catch (error) {
        if (!/closed|disconnected/iu.test(error.message)) throw error;
        await previous.close().catch(() => {});
      }
    }
    if (this.context === previous) { this.context = null; this.page = null; this.authPage = null; this.workPage = null; }
    await this.checkpoint();
    await mkdir(this.profileDir, { recursive: true });
    await mkdir(this.outputDir, { recursive: true });
    let context;
    if (this.selectors.transport === 'library') {
      context = await chromium.launchPersistentContext(this.profileDir, {
        headless: Boolean(this.selectors.headless), viewport: { width: 1366, height: 900 }, locale: 'zh-CN',
      });
    } else {
      if (!this.chromeRuntime) this.chromeRuntime = new ChromeRuntime();
      try { await this.chromeRuntime.start(this.profileDir, { checkpoint: this.checkpoint, initialUrl: this.selectors.loginUrl, startupDelayMs: this.selectors.nativeStartupDelayMs }); }
      catch (error) { if (!error.evidence) error.evidence = await this.screenshot('browser-start'); throw error; }
      context = this.chromeRuntime.context;
    }
    this.context = context;
    context.on('close', () => {
      // An old close event must never invalidate a newly reopened context.
      if (this.context === context) {
        this.lastKnownUrl = this.page?.url() ?? this.lastKnownUrl;
        this.context = null;
        this.page = null;
        this.authPage = null;
        this.workPage = null;
        this.lastNavigationAt = 0;
      }
    });
    const pages = context.pages().filter(page => !page.isClosed());
    const rank = page => {
      try {
        const url = new URL(page.url());
        if (url.hostname !== 'www.zhipin.com') return 0;
        if (url.pathname === '/web/geek/resume') return 5;
        if (url.pathname === '/web/geek/chat') return 4;
        if (url.pathname.startsWith('/web/geek/')) return 3;
        if (url.pathname === '/') return 2;
        return 1;
      } catch { return 0; }
    };
    this.authPage = pages.sort((left, right) => rank(right) - rank(left))[0] ?? await context.newPage();
    this.bindPage(this.authPage);
    await this.onEvent({ type: 'browser-open', message: this.selectors.transport === 'library' ? '已打开浏览器测试会话' : '已打开 Google Chrome 专用 BOSS 窗口' });
  }

  async close() {
    const context = this.context;
    const runtime = this.chromeRuntime;
    this.chromeRuntime = null;
    this.context = null;
    this.page = null;
    this.authPage = null;
    this.workPage = null;
    if (context || runtime) {
      try { await this.onEvent({type:'browser-close',message:'程序已关闭专用浏览器'}); }
      finally { if (runtime) await runtime.close(); else await context.close(); }
    }
  }

  async screenshot(label = 'page') {
    const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9_-]/gu, '-').slice(0, 64) || 'page';
    const screenshot = path.join(this.outputDir, `boss-diag-${Date.now()}-${safeLabel}-${randomUUID().slice(0, 8)}.png`);
    let captured = false;
    try {
      pruneDiagnostics(this.outputDir);
      if (this.page && !this.page.isClosed()) {
        await this.page.screenshot({ path: screenshot, fullPage: false });
        captured = true;
      }
    } catch { /* Error evidence must not mask the original failure. */ }
    finally {
      // A failed capture can leave a large partial file; it needs the same cap.
      try { pruneDiagnostics(this.outputDir); } catch { /* Preserve the original operation error. */ }
    }
    if (captured) return { ...(existsSync(screenshot) ? { screenshot } : { diagnosticExpired: true }), url: this.page.url(), observedAt: new Date().toISOString() };
    return { url: this.page?.url() ?? this.lastKnownUrl, observedAt: new Date().toISOString() };
  }

  async fail(code, message) {
    const error = new Error(message);
    error.code = code;
    error.recoverable = true;
    error.evidence = await this.screenshot(code.toLowerCase());
    throw error;
  }

  async visible(locator) {
    const matches = [];
    for (let index = 0, count = Math.min(await locator.count(), 100); index < count; index++) {
      const element = locator.nth(index);
      if (await element.isVisible()) matches.push(element);
    }
    return matches;
  }

  async text(locator) {
    const values = await this.visible(locator);
    const texts = new Set(await Promise.all(values.map(async element => normalized(await element.innerText()))));
    return texts.size === 1 ? [...texts][0] : '';
  }

  async guard() {
    await this.requireOpenPage();
    await this.requireNavigationNotReversed();
    if (this.page.url() === 'about:blank') await this.fail('PAGE_CHANGED', this.page === this.workPage
      ? 'BOSS 岗位任务页变为空白（about:blank），岗位读取未完成；请核对专用浏览器页面后继续'
      : 'BOSS 页面变为空白，登录页面未正常显示；请重新打开登录页');
    if (/\/web\/passport\/zp\/verify\.html/u.test(this.page.url()) || (await this.visible(this.page.locator(this.selectors.captcha))).length) await this.fail('CAPTCHA', 'BOSS 要求安全验证，请在浏览器中完成后继续');
    if ((await this.visible(this.page.locator(this.selectors.login))).length || /\/(?:web\/user\/)?login(?:\?|$|\/)/u.test(this.page.url())) await this.fail('LOGIN_REQUIRED', '请在专用浏览器中扫码登录 BOSS 后继续');
    const text = await this.page.locator('body').innerText().catch(() => '');
    if (/(?:操作|访问|沟通|发送)(?:过于|太)?频繁|今日(?:沟通|招呼).{0,12}(?:上限|用完)|账号.{0,10}(?:受限|异常)/u.test(text)) await this.fail('RATE_LIMIT', 'BOSS 显示频率或账号限制，请处理后继续');
    if (/请完成安全验证|拖动.{0,10}(?:滑块|拼图)|访问.{0,5}异常.{0,10}验证/u.test(text)) await this.fail('CAPTCHA', 'BOSS 要求安全验证，请在浏览器中完成后继续');
  }

  async navigate(url) {
    await this.open();
    await this.paceNavigation();
    await this.checkpoint();
    await this.requireOpenPage();
    await this.requireNavigationNotReversed();
    try {
      await this.page.bringToFront();
      await this.requireOpenPage();
      await this.requireNavigationNotReversed();
      // A previous committed page can roll back during throttling or focus.
      // Preserve that evidence before creating the next navigation state.
      this.lastNavigationAt = Date.now();
      if (this.page === this.workPage) this.navigationStates.set(this.page, { before: navigationUrl(this.page.url()), target: navigationUrl(url), committed: false, reversed: false });
      else this.navigationStates.delete(this.page);
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.requireOpenPage();
      await this.page.bringToFront();
    }
    catch (error) {
      if (error.code) throw error;
      await this.requireNavigationNotReversed();
      if (/closed|disconnected/iu.test(error.message) || !this.page || this.page.isClosed()) await this.fail('BROWSER_CLOSED', 'BOSS 浏览器已关闭，请重新打开并登录后继续');
      await this.fail('PAGE_CHANGED', `BOSS 页面访问未完成：${error.message}`);
    }
    await this.requireOpenPage();
    await this.requireNavigationNotReversed();
    if (!this.page.url() || this.page.url() === 'about:blank') await this.fail('PAGE_CHANGED', this.page === this.workPage
      ? 'BOSS 岗位任务页变为空白（about:blank），岗位读取未完成；请核对专用浏览器页面后继续'
      : 'BOSS 页面仍为空白，登录页未打开；请点击重新登录');
    this.lastKnownUrl = this.page.url();
    await this.guard();
  }

  async requireNavigationNotReversed() {
    if (!this.page || this.page.isClosed()) return;
    const state = this.navigationStates.get(this.page);
    if (!state?.committed) return;
    const current = navigationUrl(this.page.url());
    if (current !== state.target && (current === 'about:blank' || current === state.before)) state.reversed = true;
    if (state.reversed) await this.fail('NAVIGATION_REVERSED', '职位页加载后回退，当前自动控制方式无法稳定读取；请停止任务，使用普通浏览器处理');
  }

  async paceNavigation() {
    const end = this.lastNavigationAt + Math.max(0, Number(this.selectors.navigationDelayMs) || 0);
    while (Date.now() < end) {
      await this.checkpoint();
      await this.wait(Math.min(250, end - Date.now()));
    }
  }

  async requireOpenPage() {
    if (!this.context || !this.context.browser()?.isConnected() || !this.page || this.page.isClosed()) await this.fail('BROWSER_CLOSED', 'BOSS 浏览器已关闭，请重新打开并登录后继续');
  }

  async wait(milliseconds) {
    await this.requireOpenPage();
    try { await this.page.waitForTimeout(Math.max(1, milliseconds)); }
    catch (error) {
      if (/closed|disconnected/iu.test(error.message)) await this.fail('BROWSER_CLOSED', 'BOSS 浏览器已关闭，请重新打开并登录后继续');
      throw error;
    }
  }

  async until(predicate) {
    const end = Date.now() + this.selectors.timeoutMs;
    while (true) {
      await this.checkpoint();
      await this.guard();
      const result = await predicate();
      if (result) return result;
      if (Date.now() >= end) return null;
      await this.checkpoint();
      await this.wait(Math.min(this.selectors.pollMs, Math.max(1, end - Date.now())));
    }
  }

  async login() {
    await this.open();
    if (this.authPage && !this.authPage.isClosed() && this.page !== this.authPage) this.bindPage(this.authPage);
    if (this.selectors.transport === 'library') await this.navigate(this.selectors.loginUrl);
    else {
      await this.requireOpenPage();
      await this.page.bringToFront();
      await this.guard();
      const current = new URL(this.page.url());
      const target = new URL(this.selectors.loginUrl);
      const onLoginPage = current.origin === target.origin && current.pathname === target.pathname;
      const account = await this.text(this.page.locator(this.selectors.authenticatedAccount));
      const onBossPortal = current.hostname === 'www.zhipin.com' && account && !/登录|注册/u.test(account);
      // Reuse the normal initial page and any authenticated BOSS portal.
      if (!onLoginPage && !onBossPortal) await this.navigate(this.selectors.loginUrl);
    }
    const account = await this.until(async () => {
      for (const marker of await this.visible(this.page.locator(this.selectors.authenticatedAccount))) {
        const text = normalized(await marker.innerText());
        if (text && !/登录|注册/u.test(text)) return text;
      }
      return null;
    });
    if (!account) {
      const rendered = await this.page.evaluate(() => {
        if (!document.body) return false;
        if (document.body.innerText.trim()) return true;
        return [...document.body.querySelectorAll('img, canvas, input, button, iframe')].some(element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });
      });
      if (!rendered) await this.fail('PAGE_CHANGED', 'BOSS 登录页面未正常显示，当前为空白；请重新打开登录页');
      await this.fail('LOGIN_REQUIRED', '尚未看到已登录账号，请在专用浏览器中扫码登录后继续');
    }
    return { loggedIn: true, account, note: '已看到 BOSS 登录账号，岗位操作前仍会检查登录与验证状态' };
  }

  async cardSignature() {
    const rows = [];
    for (const card of await this.visible(this.page.locator(this.selectors.jobCards))) {
      const links = await card.locator('a[href]').evaluateAll(elements => elements.map(element => element.href));
      rows.push(`${await this.text(card.locator(this.selectors.cardTitle))}|${links.join('|')}`);
    }
    return rows.length ? rows.join('\n') : null;
  }

  async discover(query, config) {
    const url = new URL(this.selectors.searchUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || !/^\/web\/geek\/jobs?$/u.test(url.pathname)) await this.fail('PAGE_CHANGED', '搜索地址不是正常 BOSS 职位搜索页');
    url.searchParams.set('city', String(config.cityCode || '101010100'));
    url.searchParams.set('query', query);
    await this.useWorkPage();
    await this.navigate(url.href);
    const jobs = new Map();
    const seenPages = new Set();
    for (let index = 0; index < (config.maxPages || 1); index++) {
      await this.checkpoint();
      const ready = await this.until(async () => {
        if ((await this.visible(this.page.locator(this.selectors.jobCards))).length) return true;
        return /没有找到|暂无相关|暂无职位/u.test(await this.page.locator('body').innerText()) ? 'empty' : null;
      });
      if (!ready) await this.fail('PAGE_CHANGED', '无法识别 BOSS 搜索结果，请核对网页结构');
      if (ready === 'empty') break;
      const signature = await this.cardSignature();
      if (seenPages.has(signature)) break;
      seenPages.add(signature);
      for (const card of await this.visible(this.page.locator(this.selectors.jobCards))) {
        const links = await card.locator('a[href]').evaluateAll(elements => elements.map(element => element.href));
        const allowed = [...new Set(links.flatMap(link => { try { return [jobUrl(link)]; } catch { return []; } }))];
        if (allowed.length !== 1) continue;
        const title = await this.text(card.locator(this.selectors.cardTitle));
        const company = await this.text(card.locator(this.selectors.cardCompany));
        if (!title || !company) continue;
        const url = allowed[0];
        jobs.set(url, { id: url.match(/\/([^/]+)\.html$/u)[1], url, title, company, city: await this.text(card.locator(this.selectors.cardCity)), tags: await card.locator(this.selectors.cardTags).allTextContents(), description: '' });
      }
      if (index + 1 >= (config.maxPages || 1)) break;
      const next = await this.visible(this.page.locator(this.selectors.nextPage));
      if (!next.length) break;
      if (next.length !== 1) await this.fail('PAGE_CHANGED', '搜索分页按钮不唯一');
      if (await next[0].isDisabled() || await next[0].getAttribute('aria-disabled') === 'true' || /disabled/u.test(await next[0].getAttribute('class') ?? '')) break;
      // A visible DOM pagination control must stay on the normal BOSS search page.
      const href = await next[0].getAttribute('href');
      if (href) {
        const destination = new URL(href, this.page.url());
        if (destination.protocol !== 'https:' || destination.hostname !== 'www.zhipin.com' || destination.pathname !== url.pathname) await this.fail('PAGE_CHANGED', '分页地址不是 BOSS 搜索页');
      }
      const before = await this.cardSignature();
      await this.paceNavigation();
      await this.checkpoint();
      this.lastNavigationAt = Date.now();
      await next[0].click();
      const changed = await this.until(async () => { const signature = await this.cardSignature(); return signature && signature !== before; });
      if (!changed) await this.fail('PAGE_CHANGED', '已点击下一页但没有确认新的岗位内容，暂停继续扫描');
    }
    return [...jobs.values()];
  }

  async details(job) {
    let url;
    try { url = jobUrl(job.url); } catch { await this.fail('PAGE_CHANGED', '岗位地址不属于 BOSS 详情页'); }
    await this.useWorkPage();
    await this.navigate(url);
    const identity = await this.until(async () => {
      const title = await this.text(this.page.locator(this.selectors.detailTitle));
      const company = await this.text(this.page.locator(this.selectors.detailCompany));
      return title && company ? { title, company } : null;
    });
    if (!identity) await this.fail('PAGE_CHANGED', '无法确认详情页岗位名称和公司');
    if ((job.title && !same(identity.title, job.title)) || (job.company && !same(identity.company, job.company))) await this.fail('RECIPIENT_UNVERIFIED', '详情页岗位或公司与目标不一致，已暂停');
    const city = await this.text(this.page.locator(this.selectors.detailCity));
    const description = await this.text(this.page.locator(this.selectors.detailDescription));
    if (!city || !description) await this.fail('PAGE_CHANGED', '岗位城市或职责不可见，请人工核对');
    const recruiterName = await this.text(this.page.locator(this.selectors.detailRecruiter));
    const recruiterIds = new Set();
    for (const scope of await this.visible(this.page.locator(this.selectors.detailRecruiterScope))) {
      for (const attribute of ['data-recruiter-id', 'data-boss-id']) {
        const id = normalized(await scope.getAttribute(attribute));
        if (id && /^[A-Za-z0-9_-]+$/u.test(id)) recruiterIds.add(id);
      }
    }
    const recruiter = recruiterName ? { name: recruiterName, ...(recruiterIds.size === 1 ? { id: [...recruiterIds][0] } : {}) } : undefined;
    return { ...job, ...identity, url, city, description, ...(recruiter ? { recruiter } : {}), tags: (await this.page.locator(this.selectors.detailTags).allTextContents()).map(normalized) };
  }

  async conversationJobId(container) {
    const ids = new Set();
    const headers = await this.visible(container.locator(this.selectors.chatIdentityHeader));
    for (const scope of [container, ...headers]) {
      const id = normalized(await scope.getAttribute('data-job-id'));
      if (id && /^[A-Za-z0-9_-]+$/u.test(id)) ids.add(id);
    }
    // Only header links bind the chat recipient. Job links mentioned in an
    // ordinary conversation message cannot substitute for recipient identity.
    for (const header of headers) {
      for (const link of await this.visible(header.locator('a[href]'))) {
        try {
          const url = jobUrl(await link.getAttribute('href') ? new URL(await link.getAttribute('href'), this.page.url()).href : '');
          ids.add(url.match(/\/([^/]+)\.html$/u)[1]);
        } catch { /* Non-job profile links provide no job identity. */ }
      }
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  async requireDetailIdentity(job) {
    await this.guard();
    let sameUrl = false;
    try { sameUrl = jobUrl(this.page.url()) === jobUrl(job.url); } catch { /* A redirect is not the target job. */ }
    const title = await this.text(this.page.locator(this.selectors.detailTitle));
    const company = await this.text(this.page.locator(this.selectors.detailCompany));
    if (!sameUrl || !same(title, job.title) || !same(company, job.company)) await this.fail('RECIPIENT_UNVERIFIED', '沟通前页面已改变，无法确认原岗位 ID、岗位名称和公司');
  }

  async recipient(job) {
    const targetId = jobUrl(job.url).match(/\/([^/]+)\.html$/u)[1];
    const candidates = this.page.locator(this.selectors.chatContainers)
      .filter({ has: this.page.locator(this.selectors.chatTitle).filter({ hasText: exactText(job.title) }) })
      .filter({ has: this.page.locator(this.selectors.chatCompany).filter({ hasText: exactText(job.company) }) });
    const headers = this.page.locator(this.selectors.chatIdentityHeader);
    const links = ['https://www.zhipin.com', ''].flatMap(origin => [
      `a[href="${origin}/job_detail/${targetId}.html"]`,
      `a[href^="${origin}/job_detail/${targetId}.html?"]`,
    ]).join(',');
    const matchingData = this.page.locator(`[data-job-id="${targetId}"]`);
    const bound = candidates.filter({ has: headers.filter({ has: this.page.locator(links) }) })
      .or(candidates.and(matchingData))
      .or(candidates.filter({ has: headers.and(matchingData) }))
      // Keep this identity constraint on every later live action locator. A
      // retained or replaced chat cannot become an arbitrary nth chat window.
      .and(this.page.locator(`[data-job-id="${targetId}"], :not([data-job-id])`))
      .filter({ hasNot: headers.and(this.page.locator(`[data-job-id]:not([data-job-id="${targetId}"])`)) })
      .filter({ hasNot: headers.filter({ has: this.page.locator(`a[href*="/job_detail/"]:not(${links})`) }) })
      .filter({ visible: true });
    const matches = await this.visible(bound);
    return matches.length === 1 && await this.conversationJobId(matches[0]) === targetId ? bound : null;
  }

  async requireRecipient(job) {
    const chat = await this.until(() => this.recipient(job));
    if (!chat) await this.fail('RECIPIENT_UNVERIFIED', '会话中无法唯一确认相同岗位 ID、岗位名称和公司，未发送后续消息');
    return chat;
  }

  async named(scope, name) {
    return this.visible(scope.locator('button, a, [role="button"]').filter({ hasText: name }).filter({ visible: true }));
  }

  async messageUnconfirmed(message) {
    const text = normalized(await message.innerText());
    const classes = await message.getAttribute('class') ?? '';
    return /发送失败|发送中|正在发送|尚未发送|待发送|未发送|发送未成功/u.test(text)
      || /(?:^|\s)(?:failed|sending|pending|is-failed|is-sending)(?:\s|$)/u.test(classes)
      || (await this.visible(message.locator('.send-failed, .send-error, .sending, .message-failed'))).length > 0;
  }

  async resumeProof(chat) {
    // Only sent messages scoped to the verified recipient can prove delivery.
    let requested = null;
    let uncertain = null;
    for (const message of await this.visible(chat.locator(this.selectors.outgoingMessages))) {
      const text = normalized(await message.innerText());
      if (await this.messageUnconfirmed(message) && /简历|resume|\.pdf|\.docx?/iu.test(text)) {
        uncertain = { status: 'uncertain', text };
        continue;
      }
      // An approval request can use the same card class as an attachment. Pending
      // wording takes priority for this message; a later attachment still wins.
      if (/申请发送.{0,15}简历|等待.{0,8}同意|已向对方申请|请求.{0,12}(?:发送|接收).{0,12}简历|同意后.{0,12}(?:发送|简历)/u.test(text)) {
        requested = { status: 'requested', text };
        continue;
      }
      if ((await message.locator(this.selectors.resumeAttachment).count() || await message.evaluate((element, selector) => element.matches(selector), this.selectors.resumeAttachment)) && /(?:已发送|发送成功).{0,20}(?:简历|附件)|附件简历.{0,15}已发送|\.pdf(?:\b|$)|\.docx?(?:\b|$)/iu.test(text)) return { status: 'sent', text };
      if (/已发送附件简历|附件简历.{0,15}已发送/u.test(text) && !/申请|等待|请求/u.test(text)) return { status: 'sent', text };
    }
    return uncertain ?? requested;
  }

  async resumeApproved(chat) {
    for (const message of await this.visible(chat.locator(this.selectors.allMessages))) {
      if (/对方已同意.{0,12}(?:简历|附件)|已同意接收.{0,12}简历/u.test(normalized(await message.innerText()))) return true;
    }
    return false;
  }

  async contact(job, { greeting = '', resumeName = '', resumeOnly = false, onStage } = {}) {
    if (typeof onStage !== 'function') throw new TypeError('contact 必须提供用于持久化动作意图的 onStage');
    if (!job.title || !job.company) await this.fail('RECIPIENT_UNVERIFIED', '发送前必须提供明确的岗位名称和公司');
    await this.details(job);
    const result = { greetingStatus: resumeOnly ? 'existing' : 'none', resumeStatus: 'none', note: '', evidence: {} };
    let possibleGreeting = false;
    let possibleResume = false;
    const persist = async (stage, patch) => { await onStage(stage, patch); Object.assign(result, patch); };
    try {
      let chat = await this.recipient(job);
      if (!chat) {
        const scope = this.page.locator(this.selectors.contactScope);
        const actions = await this.named(scope, /^(?:立即沟通|继续沟通|沟通)$/u);
        if (actions.length !== 1) await this.fail('PAGE_CHANGED', '无法唯一识别目标岗位的沟通按钮');
        // A navigation while paused must not re-resolve an identical button on
        // another job. Freeze the original element and recheck after checkpoint.
        const actionHandle = await actions[0].elementHandle();
        const existing = /继续沟通/u.test(normalized(await actions[0].innerText()));
        if (resumeOnly && !existing) await this.fail('RECIPIENT_UNVERIFIED', '仅核对简历时没有找到该岗位已有沟通');
        if (!existing) {
          await persist('greeting-intent', { greetingStatus: 'intent' });
          await this.checkpoint();
          possibleGreeting = true;
        }
        await this.checkpoint();
        await this.requireDetailIdentity(job);
        if (!actionHandle) await this.fail('PAGE_CHANGED', '原岗位沟通按钮已改变');
        await actionHandle.click();
        chat = await this.requireRecipient(job);
        if (existing) await persist('greeting-existing', { greetingStatus: 'existing' });
      } else await persist('greeting-existing', { greetingStatus: 'existing' });

      const newConversationState = possibleGreeting ? await this.until(async () => {
        const current = await this.recipient(job);
        if (!current) return null;
        // Read history first so a later platform greeting cannot appear only
        // in the history read after an earlier empty outgoing result.
        const messages = await this.visible(current.locator(this.selectors.allMessages));
        const outgoing = await this.visible(current.locator(this.selectors.outgoingMessages));
        if (outgoing.length) {
          for (const message of outgoing) if (!await this.messageUnconfirmed(message)) return 'greeting';
          return 'unconfirmed';
        }
        if (messages.length) return 'history';
        for (const marker of await this.visible(current.locator(this.selectors.newConversation))) {
          const text = normalized(await marker.innerText());
          if (/新会话|首次沟通/u.test(text) && /尚未发送|暂无消息|没有消息/u.test(text)) return 'empty';
        }
        return null;
      }) : null;
      if (possibleGreeting && newConversationState === 'greeting') await persist('greeting-sent', { greetingStatus: 'sent' });
      else if (possibleGreeting) {
        if (!greeting || newConversationState !== 'empty') {
          await persist('greeting-uncertain', { greetingStatus: 'uncertain' });
          result.note = '已打开新沟通，但没有可核对的招呼消息；请人工核对';
          result.evidence = await this.screenshot('greeting-uncertain');
          return result;
        }
        // Only a confirmed, empty new conversation permits a custom greeting.
        chat = await this.requireRecipient(job);
        const editors = await this.visible(chat.locator(this.selectors.editor));
        const sends = await this.named(chat.locator(this.selectors.chatActions), /^(?:发送)$/u);
        if (editors.length !== 1 || sends.length !== 1) await this.fail('PAGE_CHANGED', '会话编辑器或发送按钮不可唯一识别');
        await persist('greeting-intent', { greetingStatus: 'intent' });
        await this.checkpoint();
        await editors[0].fill(greeting);
        await this.requireRecipient(job);
        await this.checkpoint();
        await this.requireRecipient(job);
        await sends[0].click();
        const proof = await this.until(async () => {
          const current = await this.recipient(job);
          if (!current) return null;
          for (const message of await this.visible(current.locator(this.selectors.outgoingMessages))) if (same(await message.innerText(), greeting) && !await this.messageUnconfirmed(message)) return true;
          return null;
        });
        if (!proof) {
          await persist('greeting-uncertain', { greetingStatus: 'uncertain' });
          result.note = '招呼已点击发送但未看到相同消息，请人工核对';
          result.evidence = await this.screenshot('greeting-uncertain');
          return result;
        }
        await persist('greeting-sent', { greetingStatus: 'sent' });
      }

      chat = await this.requireRecipient(job);
      let proof = await this.resumeProof(chat);
      const approvedPendingRequest = proof?.status === 'requested' && await this.resumeApproved(chat);
      if (proof && !approvedPendingRequest) {
        await persist(`resume-${proof.status}`, { resumeStatus: proof.status });
        result.note = proof.status === 'requested' ? '已申请发送简历，等待对方同意' : proof.status === 'uncertain' ? '会话已有发送失败或发送中的简历消息，请人工核对' : '该岗位会话已有附件简历消息';
        result.evidence = { ...await this.screenshot(`resume-${proof.status}`), message: proof.text };
        return result;
      }
      const resumeActions = await this.named(chat, /^(?:发送简历|发送附件简历)$/u);
      if (resumeActions.length !== 1) await this.fail('PAGE_CHANGED', '目标会话的发送简历按钮不可唯一识别');
      await persist('resume-intent', { resumeStatus: 'intent' });
      await this.requireRecipient(job);
      await this.checkpoint();
      await this.requireRecipient(job);
      possibleResume = true;
      await resumeActions[0].click();
      const outcome = await this.until(async () => {
        const current = await this.recipient(job);
        if (!current) return null;
        const proof = await this.resumeProof(current);
        if (proof && (proof.status === 'sent' || !approvedPendingRequest)) return { proof };
        const dialogs = (await this.visible(this.page.locator(this.selectors.resumeDialogs))).filter(Boolean);
        const matching = [];
        for (const dialog of dialogs) if (/简历/u.test(await dialog.innerText())) matching.push(dialog);
        return matching.length === 1 ? { dialog: matching[0] } : null;
      });
      if (outcome?.dialog) {
        const options = await this.visible(outcome.dialog.locator(this.selectors.resumeOptions));
        const exact = resumeName ? (await Promise.all(options.map(async option => ({ option, name: normalized(await option.innerText()) })))).filter(item => same(item.name, resumeName)).map(item => item.option) : options.length === 1 ? options : [];
        if (exact.length !== 1) await this.fail('RESUME_SELECTION', '附件简历不唯一或名称没有精确匹配，请配置已有附件的完整名称');
        await this.requireRecipient(job);
        await this.checkpoint();
        await exact[0].click();
        const confirms = await this.named(outcome.dialog, /^(?:发送|确定|确认发送)$/u);
        if (confirms.length !== 1) await this.fail('PAGE_CHANGED', '简历确认发送按钮不可唯一识别');
        await persist('resume-intent', { resumeStatus: 'intent' });
        const confirmHandle = await confirms[0].elementHandle();
        await this.requireRecipient(job);
        await this.checkpoint();
        await this.requireRecipient(job);
        if (!confirmHandle) await this.fail('PAGE_CHANGED', '简历确认按钮已改变，请人工核对');
        await confirmHandle.click();
        proof = await this.until(async () => {
          const current = await this.recipient(job);
          const proof = current ? await this.resumeProof(current) : null;
          return proof && (proof.status === 'sent' || !approvedPendingRequest) ? proof : null;
        });
      } else proof = outcome?.proof;
      if (!proof) {
        await persist('resume-uncertain', { resumeStatus: 'uncertain' });
        result.note = '简历操作已点击但没有附件或申请消息证据，请人工核对';
        result.evidence = await this.screenshot('resume-uncertain');
        return result;
      }
      await persist(`resume-${proof.status}`, { resumeStatus: proof.status });
      result.note = proof.status === 'requested' ? '已申请发送简历，等待对方同意' : proof.status === 'uncertain' ? '简历消息显示发送失败或发送中，请人工核对' : '已看到该岗位的附件简历消息';
      result.evidence = { ...await this.screenshot(`resume-${proof.status}`), message: proof.text };
      return result;
    } catch (error) {
      // Persisted intent already forbids blind retries. Checkpoint cancellation and
      // failed disk writes propagate without pretending the action was confirmed.
      if (possibleResume && result.resumeStatus === 'intent') error.uncertain = 'resume';
      else if (possibleGreeting && result.greetingStatus === 'intent') error.uncertain = 'greeting';
      if (!error.evidence) error.evidence = await this.screenshot('contact-error');
      throw error;
    }
  }
}
