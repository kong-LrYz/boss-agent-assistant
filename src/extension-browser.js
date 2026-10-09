import { NormalChromeRuntime } from './normal-chrome.js';
import { OPS, EFFECT_OPS } from '../extension/protocol.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const loginUrl = 'https://www.zhipin.com/web/user/';
const operations = new Set(OPS);
const effects = new Set(EFFECT_OPS);
const navigations = new Set(['NAV_SEARCH', 'NAV_JOB', 'NEXT_PAGE']);
const navigationStarts = new Set(['NAV_SEARCH', 'NAV_JOB']);
const retryableReads = new Set(['READ_STATUS', 'INSPECT_PAGE', 'READ_CARDS', 'READ_DETAIL', 'READ_CONVERSATION', 'READ_RESUME', 'READ_CONTACT_CONFIRMATION', 'READ_CONVERSATION_VERIFICATION']);
const transientReadCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'NETWORK_ERROR', 'EXTENSION_OFFLINE']);
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const resumeDiagnosticCaptions = new Set(['同意','已同意','拒绝','发简历','发送简历','发送附件简历','发送','确定','确认发送','取消','关闭','已发送','发送成功','发送失败','发送中','待发送','未发送','选择附件简历','我的附件简历','附件简历','点击查看附件']);
const resumeStatuses = new Set(['none','unavailable','requested','uncertain','sent']);
const stoppedDiagnosticCodes = new Set(['STOPPED','CANCELLED','BRIDGE_INACTIVE','EXTENSION_OFFLINE','BROWSER_CLOSED','CAPTCHA','RATE_LIMIT','LOGIN_REQUIRED','DOCUMENT_CHANGED','RECIPIENT_UNVERIFIED']);
const diagnosticErrors = new Set(['STALE_COMMAND','BROWSER_CLOSED','BROWSER_UNSUPPORTED','DOCUMENT_CHANGED','ACTION_NOT_PERMITTED','RECIPIENT_UNVERIFIED','INVALID_COMMAND','COMMAND_INVALID','PAGE_NOT_READY','PAGE_CHANGED','UNKNOWN_RESULT','VERIFICATION_PENDING','DOM_ERROR','CAPTCHA','RATE_LIMIT','LOGIN_REQUIRED','DRAFT_CONFLICT','DUPLICATE_GREETING','GREETING_UNVERIFIED','RESULT_UNCERTAIN','RESUME_SELECTION','UNCLASSIFIED_ERROR']);
const diagnosticPhases = new Set(['started','completed','validate-preview','query-tabs','request-dom','dom-returned','await-preview','read-preview','bind-preview','permit-command-rejected','permit-source-rejected','permit-document-rejected','permit-url-rejected','permit-binding-rejected','permit-node-granted','permit-node-rejected','permit-node-error']);
function boundedOperationDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  return { op: operations.has(value.op) ? value.op : 'UNKNOWN_OPERATION', errorCode: value.errorCode == null ? null : diagnosticErrors.has(value.errorCode) ? value.errorCode : 'UNCLASSIFIED_ERROR', elapsedMs: Number.isFinite(value.elapsedMs) ? Math.min(86400000,Math.max(0,Math.floor(value.elapsedMs))) : 0, previewCapturedCount: Number.isFinite(value.previewCapturedCount) ? Math.min(20,Math.max(0,Math.floor(value.previewCapturedCount))) : 0, phase: diagnosticPhases.has(value.phase) ? value.phase : 'completed' };
}
function boundedResumeStructure(value) {
  const describe = node => {
    if (!node || typeof node !== 'object' || typeof node.tag !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(node.tag)) return null;
    return { tag: node.tag, classes: typeof node.classes === 'string' ? node.classes.slice(0,160) : '', textLength: Number.isSafeInteger(node.textLength) && node.textLength >= 0 ? node.textLength : 0, visible: node.visible === true, disabled: node.disabled === true, selected: node.selected === true, ...(resumeDiagnosticCaptions.has(node.caption) ? { caption: node.caption } : {}) };
  };
  const nodes = (items, limit) => (Array.isArray(items) ? items : []).slice(0,limit).map(node => {
    const base = describe(node); if (!base) return null;
    return { ...base, directChildren: (Array.isArray(node.directChildren) ? node.directChildren : []).slice(0,6).map(describe).filter(Boolean), ancestors: (Array.isArray(node.ancestors) ? node.ancestors : []).slice(0,2).map(describe).filter(Boolean) };
  }).filter(Boolean);
  const result = { chat: nodes(value?.chat,12), dialogs: nodes(value?.dialogs,2) };
  while (Buffer.byteLength(JSON.stringify(result),'utf8') > 8192) {
    const list = result.chat.length ? result.chat : result.dialogs, last = list.at(-1);
    if (!last) break;
    if (last.directChildren.length) last.directChildren.pop(); else if (last.ancestors.length) last.ancestors.pop(); else list.pop();
  }
  return result;
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function issue(code, message, evidence) { return Object.assign(new Error(message), { code, recoverable: true, evidence }); }
function retryAfterMs(value) {
  if (Number.isSafeInteger(value?.retryAfterMs) && value.retryAfterMs > 0) return value.retryAfterMs;
  const milliseconds = value?.retryAfterSeconds * 1000;
  if (typeof value?.retryAfterSeconds === 'number' && Number.isSafeInteger(milliseconds) && milliseconds > 0) return milliseconds;
  return undefined;
}
function normalizeJob(job) {
  let url;
  try { url = new URL(job?.url); } catch { throw issue('RECIPIENT_UNVERIFIED', '岗位地址不可确认'); }
  const match = /^\/job_detail\/([A-Za-z0-9_-]+)\.html$/u.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com' || url.username || url.password || !match || job.id && job.id !== match[1] || !clean(job.title) || !clean(job.company)) throw issue('RECIPIENT_UNVERIFIED', '岗位 ID、名称或公司不可确认');
  const canonical = url.origin + url.pathname;
  let navigationUrl = url.href;
  if (job.navigationUrl) {
    const navigation = new URL(job.navigationUrl);
    if (navigation.origin + navigation.pathname !== canonical || navigation.username || navigation.password) throw issue('RECIPIENT_UNVERIFIED', '岗位导航地址与岗位 ID 不一致');
    navigationUrl = navigation.href;
  }
  return { ...job, id: match[1], url: canonical, navigationUrl, title: clean(job.title), company: clean(job.company) };
}
const identity = (actual, expected) => actual.id === expected.id && actual.url === expected.url && actual.title === expected.title && actual.company === expected.company;
function navigationDestination(op, args) {
  if(op==='NAV_JOB')return normalizeJob(args.job).navigationUrl;
  if(typeof args.query!=='string'||args.query.length>200||!/^\d{9}$/u.test(args.cityCode))throw issue('INVALID_COMMAND','搜索参数无效');
  const url=new URL('https://www.zhipin.com/web/geek/jobs');url.searchParams.set('city',args.cityCode);url.searchParams.set('query',args.query);return url.href;
}

/** Fixed semantic operations through our own extension; no debugger transport. */
export class ExtensionBrowser {
  constructor({ bridge, launcher = new NormalChromeRuntime(), profileDir, outputDir, onEvent = async () => {}, checkpoint = async () => {}, timeoutMs = 12000, pollMs = 250, navigationDelayMs = 0, now = Date.now, sleep = pause }) {
    if (!bridge) throw new TypeError('需要扩展消息桥');
    Object.assign(this, { bridge, launcher, profileDir, outputDir, onEvent, checkpoint, timeoutMs, pollMs, navigationDelayMs, now, sleep });
    this.meta = null; this.session = false; this.detail = null; this.epoch = null; this.lastNavigationAt = 0; this.authPending = false; this.portalObservation = null;
    this.rateGate = null; this.rateLimitFailures = 0;
    this.readWaitBudget = new AsyncLocalStorage();
    this.operationTimings = []; this.timingTotals = new Map(); this.timingRequests = 0; this.timingEpoch = null;
  }
  evidence(message) { return { url: this.meta?.url ?? '', observedAt: new Date().toISOString(), ...(message ? { message } : {}) }; }
  async openForLogin() {
    await this.checkpoint();
    await this.launcher.launch(this.profileDir, { checkpoint: this.checkpoint, initialUrl: loginUrl, setup: !this.bridge.snapshot().paired });
    return { opened: true, manualLogin: true };
  }
  async setupExtension() {
    await this.checkpoint();
    await this.launcher.launch(this.profileDir, { checkpoint: this.checkpoint, initialUrl: loginUrl, setup: true });
    return { opened: true };
  }
  assertOpenOwnership() {
    const state = this.bridge.snapshot();
    if (!state.paired) throw issue('EXTENSION_REQUIRED', '请在专用 Chrome 加载本项目扩展并完成配对');
    if (this.bridge.active === true && (!this.session || this.epoch !== state.epoch)) throw issue('STOPPED', '另一个桥接会话已运行，未接管或重新创建工作标签');
    return state;
  }
  async waitForConnection() {
    const deadline = this.now() + this.timeoutMs;
    while (true) {
      await this.checkpoint();
      this.assertOpenOwnership();
      if (this.bridge.isConnected()) return;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw issue('EXTENSION_OFFLINE', '专用 Chrome 已打开，但扩展在连接等待期限内仍未就绪，请检查扩展连接');
      const milliseconds = Math.min(this.pollMs,100,remaining);
      if (typeof this.bridge.on !== 'function' || typeof this.bridge.off !== 'function') { await this.sleep(milliseconds); continue; }
      await new Promise(resolve => {
        let finished = false;
        const finish = () => { if (finished) return; finished = true; clearTimeout(timer); this.bridge.off('connected',finish); resolve(); };
        const timer = setTimeout(finish,milliseconds);
        this.bridge.on('connected',finish);
        // Registration can race the first authenticated poll from Chrome.
        if (this.bridge.isConnected()) finish();
      });
    }
  }
  async open() {
    await this.openForLogin();
    await this.waitForConnection();
    if (this.session && this.epoch === this.bridge.snapshot().epoch && this.bridge.active !== false) return this;
    await this.checkpoint(); this.assertOpenOwnership();
    const epoch = await this.bridge.beginRun();
    await this.checkpoint();
    if (epoch !== this.bridge.snapshot().epoch || this.bridge.active === false) throw issue('STOPPED', '创建工作标签前桥接会话已停止或改变');
    this.epoch = epoch;
    this.operationTimings = []; this.timingTotals.clear(); this.timingRequests = 0; this.timingEpoch = epoch;
    this.meta = null; this.detail = null; this.authPending = false; this.portalObservation = null;
    await this.call('OPEN_SESSION', { url: loginUrl });
    this.session = true;
    await this.onEvent({ type: 'browser_open', message: '扩展已建立专用工作标签' });
    return this;
  }
  withFailFastReads(operation) {
    return this.readWaitBudget.run({ transientRetries: 0, rateProbes: 0, failFast: true }, operation);
  }
  async call(op, args = {}, timeoutMs = this.timeoutMs) {
    if (!operations.has(op)) throw new TypeError('不支持的固定扩展操作');
    this.portalObservation = null;
    await this.checkpoint();
    if (navigations.has(op)) {
      let remaining;
      while ((remaining = this.lastNavigationAt + this.navigationDelayMs - this.now()) > 0) {
        await this.checkpoint();
        await this.sleep(Math.min(this.pollMs, remaining));
      }
      await this.checkpoint();
    }
    if (!this.bridge.isConnected()) throw issue('EXTENSION_OFFLINE', '扩展连接中断，已停止页面操作', this.evidence());
    if (effects.has(op) && op !== 'OPEN_SESSION' && this.rateGate) throw Object.assign(issue('RATE_LIMIT', '平台限流后需等待冷却结束并只读确认恢复，未派发网页动作', this.evidence()), { retryAfterMs: Math.max(0, this.rateGate.until - this.now()), operation: op });
    if (effects.has(op) && op !== 'OPEN_SESSION' && this.authPending) throw issue('LOGIN_REQUIRED', '账号尚未确认，未派发网页动作', this.evidence());
    if (effects.has(op) && op !== 'OPEN_SESSION' && !this.meta) throw issue('DOCUMENT_CHANGED', '缺少当前文档证据，未执行操作');
    const destination=navigationStarts.has(op)?navigationDestination(op,args):null;
    const options = { timeoutMs, ...(this.meta ? { target: { document: { ...this.meta } } } : {}) };
    if (navigations.has(op)) this.lastNavigationAt = this.now();
    const epoch = this.bridge.snapshot().epoch;
    const document = this.meta ? { ...this.meta } : null;
    const budget = this.readWaitBudget.getStore() ?? { transientRetries: 0, rateProbes: 0 };
    let attempts = 0, rateRecovered = false;
    while (true) {
      attempts++;
      try { return await this.requestOnce(op, args, options, destination); }
      catch (error) {
        error.operation ??= op;
        if (error.code === 'RATE_LIMIT') {
          this.recordRateLimit(error);
          if (budget.failFast || !retryableReads.has(op) || error.platformRisk !== true || rateRecovered || attempts >= 3) throw error;
          await this.recoverRateLimit(error, epoch, document, timeoutMs, budget);
          rateRecovered = true;
          continue;
        }
        if (budget.failFast || !retryableReads.has(op) || !transientReadCodes.has(error.code) || attempts >= 3 || budget.transientRetries >= 2) throw error;
        await this.checkReadSession(epoch);
        const delayMs = 250 * 2 ** budget.transientRetries++;
        await this.onEvent({ type: 'read_retry', message: '只读通信暂时失败，退避后重读；网页动作不重派', operation: op, code: error.code, attempt: attempts + 1, delayMs });
        await this.wait(delayMs);
        await this.checkReadSession(epoch);
      }
    }
  }
  async checkReadSession(epoch) {
    await this.checkpoint();
    if (this.bridge.snapshot().epoch !== epoch || this.bridge.active === false) throw issue('STOPPED', '读取重试前会话已停止或替换，未重派命令');
    if (!this.bridge.isConnected()) throw issue('EXTENSION_OFFLINE', '扩展连接中断，未重派读取命令', this.evidence());
  }
  async wait(milliseconds) {
    const end = this.now() + milliseconds;
    while (this.now() < end) {
      await this.checkpoint();
      await this.sleep(Math.min(this.pollMs, end - this.now()));
    }
    await this.checkpoint();
  }
  recordRateLimit(error) {
    this.rateLimitFailures++;
    const explicit = retryAfterMs(error);
    const delayMs = explicit ?? Math.min(60000 * 2 ** Math.min(this.rateLimitFailures - 1, 3), 600000);
    const until = Math.max(this.rateGate?.until ?? 0, Math.min(Number.MAX_SAFE_INTEGER, this.now() + delayMs));
    this.rateGate = { until, delayMs: Math.max(0, until - this.now()) };
  }
  async recoverRateLimit(originalError, epoch, document, timeoutMs, budget) {
    let lastError = originalError;
    for (let probe = 0; probe < 3; probe++) {
      if (budget.rateProbes >= 3) throw lastError;
      const delayMs = Math.max(0, this.rateGate.until - this.now());
      // A long advertised restriction remains intact and requires manual resume;
      // shortening it to our automatic wait budget could cause another limit.
      if (delayMs > 600000) throw lastError;
      await this.onEvent({ type: 'rate_limit_wait', message: '网页出现限流，冷却后只读确认状态', probe: budget.rateProbes + 1, delayMs });
      await this.wait(delayMs);
      await this.checkReadSession(epoch);
      try {
        const options = { timeoutMs, ...(this.meta ? { target: { document: { ...this.meta } } } : {}) };
        budget.rateProbes++;
        const status = await this.requestOnce('READ_STATUS', {}, options, null, false);
        if (status.ready !== true || status.loggedIn !== true || !clean(status.account) || /登录|注册/u.test(status.account)) throw issue('LOGIN_REQUIRED', '限流恢复检查未确认页面和已登录账号', this.evidence());
        if (document && (this.meta.url !== document.url || this.meta.documentId !== document.documentId)) throw issue('DOCUMENT_CHANGED', '限流恢复时页面文档已切换，未重读原目标', this.evidence());
        await this.checkReadSession(epoch);
        this.rateGate = null; this.rateLimitFailures = 0;
        return;
      } catch (error) {
        error.operation ??= 'READ_STATUS';
        if (error.code !== 'RATE_LIMIT') throw error;
        this.recordRateLimit(error);
        lastError = error;
      }
    }
    throw lastError;
  }
  timingSummary() {
    return { totalRequests: this.timingRequests, truncated: this.timingRequests > this.operationTimings.length,
      samples: this.operationTimings.map(value => ({ ...value })), totals: [...this.timingTotals.values()].map(value => ({ ...value })) };
  }
  recordTiming(op, epoch, started, result, errorCode, destination) {
    if (epoch !== this.timingEpoch || !operations.has(op)) return;
    const elapsed = this.now() - started;
    const elapsedMs = Number.isFinite(elapsed) ? Math.max(0, Math.min(86400000, elapsed)) : 0;
    let page = 'other';
    try {
      const url = new URL(result?.meta?.url ?? destination ?? this.meta?.url);
      if (url.origin === 'https://www.zhipin.com') page = url.pathname.startsWith('/job_detail/') ? 'detail' : url.pathname === '/web/geek/chat' ? 'chat' : url.pathname === '/web/geek/jobs' ? 'search' : url.pathname.startsWith('/web/user') ? 'profile' : 'other';
    } catch { /* No raw address is retained. */ }
    const boundedCode = code => code == null ? null : diagnosticErrors.has(code) || transientReadCodes.has(code) || ['STOPPED','CANCELLED','BRIDGE_INACTIVE'].includes(code) ? code : 'UNCLASSIFIED_ERROR';
    const sample = { op, elapsedMs, page, ready: typeof result?.ready === 'boolean' ? result.ready : null,
      loggedIn: typeof result?.loggedIn === 'boolean' ? result.loggedIn : null, authPending: this.authPending === true,
      riskCode: boundedCode(result?.risk?.code), errorCode: boundedCode(errorCode) };
    this.operationTimings.push(sample); if (this.operationTimings.length > 64) this.operationTimings.shift();
    this.timingRequests++;
    const total = this.timingTotals.get(op) ?? { op, count: 0, totalElapsedMs: 0, maxElapsedMs: 0, errors: 0 };
    total.count++; total.totalElapsedMs += elapsedMs; total.maxElapsedMs = Math.max(total.maxElapsedMs, elapsedMs); if (errorCode) total.errors++;
    this.timingTotals.set(op, total);
  }
  async requestOnce(op, args, options, destination, clearRateGate = true) {
    const timingStarted = this.now(), timingEpoch = this.bridge.snapshot().epoch;
    let timingResult, timingError = null;
    try {
      const epoch = this.bridge.snapshot().epoch;
      let result;
      try { result = await this.bridge.request(op, args, options); timingResult = result; }
      catch (error) { error.operation ??= op; throw error; }
      if(navigationStarts.has(op)) {
        if(!result||result.navigationStarted!==true||result.destination!==destination||Object.keys(result).some(key=>!['navigationStarted','destination'].includes(key)))throw issue('PAGE_CHANGED','扩展未确认跳转到指定目标地址',this.evidence());
        this.meta=null;this.detail=null;return result;
      }
      if (!result || typeof result.meta?.url !== 'string' || !result.meta.documentId) throw issue('PAGE_CHANGED', '扩展没有返回有效文档证据', this.evidence());
      this.meta = { ...result.meta };
      if (result.risk) {
        const pending = ['OPEN_SESSION', 'READ_STATUS', 'INSPECT_PAGE'].includes(op) && result.risk.code === 'LOGIN_REQUIRED' && result.authPending === true;
        if (!pending) {
          const error = Object.assign(issue(result.risk.code, result.risk.message, this.evidence()), { platformRisk: true });
          const advertised = retryAfterMs(result.risk);
          if (error.code === 'RATE_LIMIT' && advertised !== undefined) error.retryAfterMs = advertised;
          throw error;
        }
        this.authPending = true;
      } else if (['OPEN_SESSION', 'READ_STATUS', 'INSPECT_PAGE'].includes(op) && result.loggedIn === true && clean(result.account) && !/登录|注册/u.test(result.account)) {
        this.authPending = false;
        const gate = this.rateGate;
        if (clearRateGate && op === 'READ_STATUS' && result.ready === true && gate && this.now() >= gate.until) {
          await this.checkReadSession(epoch);
          // A concurrent restriction must not be cleared by the earlier status.
          if (this.rateGate === gate && this.now() >= gate.until) { this.rateGate = null; this.rateLimitFailures = 0; }
        }
      }
      return result;
    } catch (error) { timingError = error.code ?? 'UNCLASSIFIED_ERROR'; throw error; }
    finally { this.recordTiming(op, timingEpoch, timingStarted, timingResult, timingError, destination); }
  }
  async until(read, accept, message) {
    const waitForReady = async () => {
      const end = this.now() + this.timeoutMs;
      do {
        let result, pending = false;
        try { result = await read(Math.max(1,end-this.now())); }
        catch (error) {
          if (error.code !== 'PAGE_NOT_READY' || !retryableReads.has(error.operation)) throw error;
          // A loaded tab can answer before its content script has hydrated.
          // Keep the current readiness deadline and failure retry budget.
          pending = true;
        }
        if (!pending && accept(result)) return result;
        await this.checkpoint();
        await this.sleep(Math.min(this.pollMs, Math.max(0, end - this.now())));
        await this.checkpoint();
      } while (this.now() < end);
      if (message) throw issue('PAGE_CHANGED', message, this.evidence());
      return null;
    };
    // Pending page reads are normal; only actual retry/probe dispatches consume
    // this shared budget, including nested waits and document refresh reads.
    if (this.readWaitBudget.getStore()) return waitForReady();
    return this.readWaitBudget.run({ transientRetries: 0, rateProbes: 0 }, waitForReady);
  }
  async waitForNavigation(op,args,destination) {
    const expected=new URL(destination);
    return this.until(remaining=>this.call('READ_STATUS',{},remaining),value=>{
      if(value.ready!==true)return false;
      try{
        const actual=new URL(value.meta.url);
        if(actual.origin!=='https://www.zhipin.com'||actual.username||actual.password||actual.pathname!==expected.pathname)return false;
        if(op==='NAV_JOB')return actual.origin+actual.pathname===expected.origin+expected.pathname;
        return actual.searchParams.getAll('city').length===1&&actual.searchParams.get('city')===args.cityCode&&actual.searchParams.getAll('query').length===1&&actual.searchParams.get('query')===args.query;
      }catch{return false;}
    },'指定目标页面尚未加载或跳转地址不一致');
  }
  async login() {
    await this.open();
    const result = await this.until(() => this.call('READ_STATUS'), value => value.ready && value.loggedIn === true && clean(value.account) && !/登录|注册/u.test(value.account), null);
    if (!result) throw issue('LOGIN_REQUIRED', '未确认已登录账号，请等待入口加载或在普通 Chrome 手动登录后再开始', this.evidence());
    return { loggedIn: true, account: result.account, evidence: this.evidence() };
  }
  async discover(query, config) {
    await this.open();
    const navigation={query,cityCode:config.cityCode},started=await this.call('NAV_SEARCH',navigation);
    await this.waitForNavigation('NAV_SEARCH',navigation,started.destination);
    const jobs = new Map(); let previous = null;
    for (let page = 0; page < config.maxPages; page++) {
      const cards = await this.until(() => this.call('READ_CARDS'), value => Array.isArray(value.jobs) && (value.jobs.length > 0 || value.empty) && (previous === null || value.signature !== previous), '职位列表未加载或下一页没有发生变化');
      for (const candidate of cards.jobs) { const job = normalizeJob(candidate); jobs.set(job.id, jobs.get(job.id) ?? job); }
      if (!cards.next?.available || cards.next.disabled || page + 1 >= config.maxPages) break;
      previous = cards.signature;
      const next = await this.call('NEXT_PAGE');
      if (!next.clicked) throw issue('PAGE_CHANGED', '下一页控件未执行，已停止搜索', this.evidence());
    }
    this.detail = null;
    return [...jobs.values()];
  }
  checkDetail(result, expected) {
    const actual = normalizeJob(result.job);
    if (!identity(actual, expected)) throw issue('RECIPIENT_UNVERIFIED', '详情页与目标岗位 ID、名称或公司不一致', this.evidence());
    if (!clean(actual.city) || !clean(actual.description)) throw issue('PAGE_CHANGED', '岗位城市或描述不可确认', this.evidence());
    this.detail = { ...result, job: actual };
    return actual;
  }
  async details(input) {
    await this.open();
    const job = normalizeJob(input);
    const started=await this.call('NAV_JOB',{job});
    await this.waitForNavigation('NAV_JOB',{job},started.destination);
    const result = await this.until(() => this.call('READ_DETAIL', { job }), value => value.job?.description && value.job?.city, '岗位详情尚未加载');
    return this.checkDetail(result, job);
  }
  async conversation(job, greeting) {
    const args = { job, ...(greeting ? { greeting } : {}) };
    let state;
    try { state = await this.call('READ_CONVERSATION', args); }
    catch (error) {
      if (error.code !== 'DOCUMENT_CHANGED' || this.readWaitBudget.getStore()?.failFast) throw error;
      // Refresh only this read after a navigation supersedes its document.
      // The second read is deliberately outside the catch: no repeated recovery.
      this.meta = null;
      await this.call('READ_STATUS');
      state = await this.call('READ_CONVERSATION', args);
    }
    if (state.verified && state.jobId !== job.id) throw issue('RECIPIENT_UNVERIFIED', '会话没有相同岗位 ID 证据', this.evidence());
    return state;
  }
  async contactView(job, allowReceipt = false) {
    return this.until(async remaining => {
      await this.call('READ_STATUS', {}, remaining);
      const chat = await this.conversation(job);
      if (chat.verified) return { kind: 'conversation', chat };
      const url = new URL(this.meta.url);
      if (url.origin === 'https://www.zhipin.com' && url.pathname === '/web/geek/chat') {
        this.portalObservation = { job: { ...job }, chat, meta: { ...this.meta }, epoch: this.epoch };
        return { kind: 'portal', chat };
      }
      if (allowReceipt) {
        const proof = await this.call('READ_CONTACT_CONFIRMATION', { job });
        if (proof.confirmed === true) {
          if (proof.jobId !== job.id || proof.needsExistingConversation !== true) throw issue('RECIPIENT_UNVERIFIED', '招呼确认与当前岗位不一致', this.evidence());
          return { kind: 'receipt', proof };
        }
      }
      return null;
    }, value => value !== null, null);
  }
  async openContact(job, resumeOnly = false) {
    try { return await this.call('OPEN_CONTACT', { job, resumeOnly }); }
    catch (error) {
      if (!resumeOnly || !['UNKNOWN_RESULT', 'DOCUMENT_CHANGED'].includes(error.code)) throw error;
      // A continuing contact can unload its document before its DOM response.
      // Observe once; never repeat the click or infer a new greeting receipt.
      this.meta = null;
      const view = await this.contactView(job);
      if (view?.kind !== 'portal') throw error;
      // The caller must still verify the selected portal's actual job ID before
      // reading an attachment control or persisting an attachment intent.
      return { existing: true, observedExistingNavigation: true };
    }
  }
  async verifiedPortal(job, initialChat) {
    const url = new URL(this.meta.url);
    if (url.origin !== 'https://www.zhipin.com' || url.pathname !== '/web/geek/chat') throw issue('RECIPIENT_UNVERIFIED', '未进入官方沟通页面', this.evidence());
    const observed = this.portalObservation;
    this.portalObservation = null;
    // Consume only the immediately preceding same-job read; any intervening
    // request, document change, or session change falls back to fresh reads.
    const freshPreview = observed?.chat === initialChat && initialChat?.previewAvailable === true &&
      identity(observed.job, job) && clean(observed.job.recruiterName) === clean(job.recruiterName) &&
      observed.epoch === this.epoch && observed.epoch === this.bridge.snapshot().epoch &&
      observed.meta.url === this.meta.url && observed.meta.documentId === this.meta.documentId && observed.meta.title === this.meta.title;
    const ready = freshPreview ? initialChat : await this.until(async remaining => {
      await this.call('READ_STATUS', {}, remaining);
      const current = new URL(this.meta.url);
      if (current.origin !== 'https://www.zhipin.com' || current.pathname !== '/web/geek/chat') throw issue('RECIPIENT_UNVERIFIED', '沟通页面已切换，未执行岗位验证', this.evidence());
      return this.conversation(job);
    }, value => value.verified === true || value.previewAvailable === true, null);
    if (!ready) throw issue('RECIPIENT_UNVERIFIED', '当前会话岗位信息尚未一致，未执行岗位验证或附件操作', this.evidence());
    if (ready.verified === true) return ready;
    const started = await this.call('VERIFY_CONVERSATION_JOB', { job });
    if (started.previewStarted !== true) throw issue('RECIPIENT_UNVERIFIED', '会话岗位详情验证未启动', this.evidence());
    const proof = await this.until(remaining => this.call('READ_CONVERSATION_VERIFICATION', { job }, remaining), value => value.verified === true, null);
    if (!proof || proof.jobId !== job.id) throw issue('RECIPIENT_UNVERIFIED', '会话岗位 ID 仍未得到确认，未发送附件', this.evidence());
    const chat = await this.conversation(job);
    if (!chat.verified || chat.jobId !== job.id) throw issue('RECIPIENT_UNVERIFIED', '会话内容在验证后改变，未发送附件', this.evidence());
    return chat;
  }
  async resume(job) {
    const state = await this.call('READ_RESUME', { job });
    if (!state.verified) throw issue('RECIPIENT_UNVERIFIED', '附件会话收件人不可确认', this.evidence());
    return state;
  }
  async resumeFailureDiagnostics(job, observed, skipRead = false) {
    const fallback = observed ? { resumeStructure: boundedResumeStructure(observed.structure), resumeDiagnosticSource: 'last-read-resume' } : {};
    const sameDocument = (left,right) => left && right && left.url === right.url && left.documentId === right.documentId && left.title === right.title;
    const readable = () => observed && identity(observed.job,job) && this.detail && identity(this.detail.job,job) && sameDocument(this.meta,observed.meta) && this.epoch === observed.epoch && this.bridge.snapshot().epoch === observed.epoch && this.bridge.active !== false && this.bridge.isConnected();
    if (skipRead || !readable()) return fallback;
    try {
      await this.checkpoint(); if (!readable()) return fallback;
      const timeoutMs = Math.min(this.timeoutMs,1000), deadline = Date.now() + timeoutMs;
      // One fixed read only: diagnostic failures must not start retry/cooldown
      // loops or mutate adapter metadata after the original operation failed.
      const pending = this.bridge.request('INSPECT_PAGE',{}, { timeoutMs, target: { document: { ...observed.meta } } }).then(value => ({ value }), error => ({ error }));
      while (Date.now() < deadline) {
        await this.checkpoint(); if (!readable()) return fallback;
        const remaining = Math.max(1,deadline-Date.now());
        const outcome = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(null),Math.min(this.pollMs,100,remaining));
          pending.then(value => { clearTimeout(timer); resolve(value); });
        });
        if (!outcome) continue;
        await this.checkpoint();
        if (outcome.error || !readable() || !sameDocument(outcome.value?.meta,observed.meta) || outcome.value?.risk) return fallback;
        const diagnostic = boundedOperationDiagnostic(outcome.value.lastOperationDiagnostic);
        return { resumeStructure: boundedResumeStructure(outcome.value.resumeStructure), resumeDiagnosticSource: 'inspect-page', ...(diagnostic ? { lastOperationDiagnostic: diagnostic } : {}) };
      }
    } catch { /* Keep the original application error and the last safe read. */ }
    return fallback;
  }
  async contact(input, { greeting = '', resumeName = '', resumeOnly = false, sendResume = true, inspectResumeOnly = false, deferResumeAfterGreeting = false, onStage } = {}) {
    if (inspectResumeOnly && resumeOnly !== true) throw issue('INVALID_COMMAND', '附件只读检查必须限定于已有沟通');
    if (typeof onStage !== 'function') throw new TypeError('contact 必须持久化发送意图');
    const job = normalizeJob(input);
    if (!this.detail || !identity(this.detail.job, job)) await this.details(job);
    else this.checkDetail(await this.call('READ_DETAIL', { job }), job);
    const result = { greetingStatus: resumeOnly ? 'existing' : 'none', resumeStatus: 'none', note: '', evidence: {} };
    let greetingAttempt = false, resumeAttempt = false, lastResumeObservation = null;
    const readResume = async () => {
      const observed = await this.resume(job);
      lastResumeObservation = { job: { ...job }, meta: { ...this.meta }, epoch: this.epoch, structure: boundedResumeStructure(observed.resumeStructure) };
      return observed;
    };
    const persist = async (stage, patch) => { await onStage(stage, patch); Object.assign(result, patch); };
    const uncertain = async (field, message, diagnostics) => { await persist(`${field}-uncertain`, { [`${field}Status`]: 'uncertain' }); result.note = message; result.evidence = { ...this.evidence(message), ...(field === 'resume' ? diagnostics ?? await this.resumeFailureDiagnostics(job,lastResumeObservation) : {}) }; return result; };
    try {
      let chat = await this.conversation(job);
      if (!chat.verified) {
        if (resumeOnly && !this.detail.contactExisting) throw issue('RECIPIENT_UNVERIFIED', '复查简历时没有确认该岗位已有沟通', this.evidence());
        if (this.detail.contactAvailable === false) throw issue('PAGE_CHANGED', '未找到唯一沟通按钮，未执行点击', this.evidence());
        // A button observed as continuing can change before its click. Ordinary
        // contact always records intent; resumeOnly is guarded again by the DOM.
        if (!resumeOnly) await persist('greeting-intent', { greetingStatus: 'intent' });
        greetingAttempt = !resumeOnly;
        const opened = await this.openContact(job, resumeOnly);
        if (resumeOnly && !opened.existing) throw issue('RECIPIENT_UNVERIFIED', '简历复查未打开该岗位已有沟通', this.evidence());
        const view = await this.contactView(job, !resumeOnly && !opened.existing);
        if (view?.kind === 'receipt') {
          await persist('greeting-sent', { greetingStatus: 'sent' });
          greetingAttempt = false;
          if (!sendResume) {
            result.resumeSkipped = true;
            result.note = '已确认招呼发送，本次未执行附件步骤';
            result.evidence = this.evidence(result.note);
            return result;
          }
          if (deferResumeAfterGreeting === true) {
            // The native job-page receipt already confirms this greeting. The
            // queue will rebind the existing conversation before any attachment
            // operation; a greeting receipt alone never proves an attachment.
            result.resumeSkipped = true;
            result.resumeDeferred = true;
            result.note = '已确认招呼发送，附件已加入待发队列';
            result.evidence = this.evidence(result.note);
            return result;
          }
          const dismissed = await this.call('DISMISS_CONTACT_CONFIRMATION', { job });
          if (dismissed.dismissed !== true || dismissed.jobId !== job.id) throw issue('DOCUMENT_CHANGED', '确认弹窗未安全关闭', this.evidence());
          const existing = await this.openContact(job, true);
          if (existing.existing !== true) throw issue('RECIPIENT_UNVERIFIED', '没有进入该岗位已有沟通，未发送附件', this.evidence());
          const reopened = await this.contactView(job);
          chat = reopened?.kind === 'portal' ? await this.verifiedPortal(job, reopened.chat) : reopened?.chat;
        } else chat = view?.kind === 'portal' ? await this.verifiedPortal(job, view.chat) : view?.chat;
        if (!chat?.verified) {
          if (resumeOnly) throw issue('RECIPIENT_UNVERIFIED', '已有沟通的收件人仍无法确认，未发送简历', this.evidence());
          return await uncertain('greeting', '沟通已打开但收件人或消息未确认，请人工核对');
        }
        if (opened.existing && result.greetingStatus !== 'sent') await persist('greeting-existing', { greetingStatus: 'existing' });
      } else await persist('greeting-existing', { greetingStatus: 'existing' });
      if (greetingAttempt && result.greetingStatus !== 'existing') {
        if (chat.greetingSent) await persist('greeting-sent', { greetingStatus: 'sent' });
        else {
          if (chat.greetingUncertain || !chat.emptyNew || chat.existing || !greeting) return await uncertain('greeting', '没有确认招呼送达，请人工核对');
          await this.call('FILL_GREETING', { job, greeting });
          await persist('greeting-intent', { greetingStatus: 'intent' });
          await this.call('SEND_GREETING', { job, greeting });
          const proof = await this.until(() => this.conversation(job, greeting), value => value.verified && (value.greetingSent || value.greetingUncertain), null);
          if (!proof?.greetingSent) return await uncertain('greeting', '招呼已提交但没有相同消息的送达证据，请人工核对');
          await persist('greeting-sent', { greetingStatus: 'sent' });
        }
      }
      if (inspectResumeOnly) {
        const observed = await readResume();
        if (!resumeStatuses.has(observed.status)) throw issue('PAGE_CHANGED', '附件只读状态不在受支持的状态集合中', this.evidence());
        result.resumeSkipped = true; result.resumeInspection = true;
        result.resumeStatus = observed.status;
        result.resumeStructure = boundedResumeStructure(observed.resumeStructure);
        result.resumeObservation = { status: observed.status, approved: observed.approved === true, dialog: observed.dialog === true, optionCount: Array.isArray(observed.options) ? observed.options.length : 0 };
        result.note = '已验证该岗位既有会话，仅检查附件状态，未执行附件动作';
        result.evidence = this.evidence(result.note);
        return result;
      }
      if (!sendResume) {
        result.resumeSkipped = true;
        result.note = '本次未执行附件步骤';
        result.evidence = this.evidence(result.note);
        return result;
      }
      let proof = await readResume();
      if (proof.status === 'unavailable') {
        await persist('resume-unavailable', { resumeStatus: 'unavailable' });
        result.note = proof.reason || '平台暂未开放附件发送，等待对方回复后复查';
        result.evidence = this.evidence(result.note);
        return result;
      }
      const approvedPending = proof.status === 'requested' && proof.approved;
      if (proof.status === 'none' || approvedPending) {
        await persist('resume-intent', { resumeStatus: 'intent' }); resumeAttempt = true;
        await this.call('REQUEST_RESUME', { job });
        proof = await this.until(() => readResume(), value => value.dialog || value.status !== 'none' && (!approvedPending || value.status !== 'requested'), null);
        if (proof?.dialog && proof.status !== 'sent') {
          const options = proof.options ?? [];
          const matches = resumeName ? options.filter(option => clean(option.name) === clean(resumeName)) : options.length === 1 ? options : [];
          if (matches.length !== 1) throw issue('RESUME_SELECTION', '多份附件必须精确匹配已有简历名称', this.evidence());
          const selected = await this.call('SELECT_RESUME', { job, resumeName: matches[0].name });
          if (!selected.selected) throw issue('RESUME_SELECTION', '未确认附件被选中', this.evidence());
          await persist('resume-intent', { resumeStatus: 'intent' });
          await this.call('CONFIRM_RESUME', { job, resumeName: matches[0].name });
          proof = await this.until(() => readResume(), value => value.status !== 'none' && (!approvedPending || value.status !== 'requested'), null);
        }
      }
      if (!proof || proof.status === 'none') return await uncertain('resume', '简历操作已提交但没有附件或申请消息证据，请人工核对');
      if (!['sent', 'requested', 'uncertain'].includes(proof.status)) throw issue('PAGE_CHANGED', '简历证据状态无法识别', this.evidence());
      await persist(`resume-${proof.status}`, { resumeStatus: proof.status });
      result.note = proof.status === 'sent' ? '已看到该岗位的附件简历消息' : proof.status === 'requested' ? '已申请发送简历，等待对方同意' : '简历发送失败或尚未完成，请人工核对';
      result.evidence = this.evidence(proof.text);
      if (proof.status === 'uncertain') Object.assign(result.evidence,await this.resumeFailureDiagnostics(job,lastResumeObservation));
      return result;
    } catch (error) {
      const field = resumeAttempt && result.resumeStatus === 'intent' ? 'resume' : greetingAttempt && result.greetingStatus === 'intent' ? 'greeting' : null;
      if (field) error.uncertain = field;
      error.evidence ??= { ...this.evidence(error.message), ...(error.operation ? { operation: error.operation } : {}) };
      const diagnostics = field === 'resume' ? await this.resumeFailureDiagnostics(job,lastResumeObservation,stoppedDiagnosticCodes.has(error.code)) : undefined;
      if (diagnostics) Object.assign(error.evidence,diagnostics);
      if (field && error.code === 'UNKNOWN_RESULT') return await uncertain(field, '扩展操作回执丢失，未自动重发；请人工核对',diagnostics);
      throw error;
    }
  }
  async close() {
    await this.bridge.cancel();
    this.session = false; this.meta = null; this.detail = null; this.epoch = null; this.authPending = false; this.portalObservation = null;
    if (this.bridge.isConnected()) try { await this.bridge.request('STOP_SESSION', {}, { timeoutMs: this.timeoutMs }); } catch { /* Leases are already revoked; no send retry. */ }
  }
  async shutdown() { await this.close(); await this.launcher.close(); }
}
