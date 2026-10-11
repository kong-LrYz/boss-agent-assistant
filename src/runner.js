import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { evaluateJob, jobKey, normalizeCompany, precheckJob, renderGreeting } from './core.js';

const cancelled = () => Object.assign(new Error('运行已停止'), { code: 'STOPPED' });
const goalBlocked = (code, message) => Object.assign(new Error(message), { code });
const jobLocalCodes = new Set(['RECIPIENT_UNVERIFIED', 'PAGE_CHANGED', 'DOCUMENT_CHANGED', 'PAGE_NOT_READY', 'DRAFT_CONFLICT', 'DUPLICATE_GREETING', 'GREETING_UNVERIFIED', 'RESULT_UNCERTAIN', 'UNKNOWN_RESULT', 'RESUME_SELECTION', 'VERIFICATION_PENDING', 'DOM_ERROR']);
const recoveryTtlMs = 10 * 60_000, recoveryCacheLimit = 1000;
const goalCodes = new Set(['GOAL_COMPLETE', 'GOAL_CONTACT_REACHED', 'GOAL_CONTACT_RESERVED', 'GOAL_RESUME_REACHED', 'GOAL_RESUME_RESERVED', 'JOB_ALREADY_CONTACTED']);
function resumeDue(record) {
  return ['none', 'requested', 'unavailable'].includes(record?.resumeStatus);
}
function resumeSelectable(record, inspection) {
  return resumeDue(record) || (inspection && ['sent', 'uncertain', 'intent'].includes(record?.resumeStatus));
}
const freshPerformance = () => ({ detailReads: 0, precheckRejected: 0, verifiedNewContacts: 0, elapsedMs: 0, waitedMs: 0, contactWaitMs: 0, batchWaitMs: 0, idleWaitMs: 0, confirmedPerHour: 0 });
function cancellableSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
function cardFingerprint(card) {
  const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  const tags = Array.isArray(card.tags) ? card.tags.map(clean).sort() : clean(card.tags);
  return JSON.stringify([clean(card.title), clean(card.company), clean(card.city), tags]);
}
function detailMatchesCard(detail, card) {
  const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const canonical = value => { try { const url = new URL(value, 'https://www.zhipin.com'); return url.origin + url.pathname; } catch { return null; } };
  return detail && jobKey(detail) === jobKey(card) && clean(card.title) && clean(card.company) && clean(detail.title) === clean(card.title) && clean(detail.company) === clean(card.company) && canonical(detail.url) !== null && canonical(detail.url) === canonical(card.url);
}
function searchFingerprint(cards) {
  const digest = createHash('sha256');
  for (const value of cards.map(card => JSON.stringify([jobKey(card), cardFingerprint(card)])).sort()) digest.update(value).update('\n');
  return digest.digest('hex');
}
function browserError(error) {
  if (/Target (?:page|browser)|browser has been closed|context has been closed|browser.*disconnected/i.test(error.message || '')) {
    error.code='BROWSER_CLOSED';
    error.message='专用浏览器已关闭，请点击“打开浏览器 / 扫码登录”重新打开；投递中的任务请处理后继续，未确认的消息不会自动重发';
  }
  return error;
}
export class Runner extends EventEmitter {
  constructor({ store, browser, idleMs, delayMs, batchBreakMs, now = () => performance.now(), sleep = cancellableSleep }) {
    super();
    this.store = store;
    this.browser = browser;
    this.idleMs = idleMs;
    this.delayMs = delayMs;
    this.batchBreakMs = batchBreakMs;
    this.now = now;
    this.sleep = sleep;
    this.performanceStartedAt = null;
    this.performanceFinishedAt = null;
    this.state = { status: 'idle', mode: 'apply', cycle: 0, currentJob: null, nextScanAt: null, lastError: null, startedAt: null, performance: freshPerformance() };
    this.task = null;
    this.loginTask = null;
    this.abort = null;
    this.runContacts = 0;
    this.nextContactAt = 0;
    this.scanLogCriteria = null;
    this.searchLogSignatures = new Map();
    this.jobRecoveries = new Map();
  }
  snapshot() {
    const { counts } = this.store.getProgressSummary();
    const metrics = this.state.performance;
    metrics.elapsedMs = this.performanceStartedAt === null ? 0 : Math.max(0, (this.performanceFinishedAt ?? this.now()) - this.performanceStartedAt);
    metrics.confirmedPerHour = metrics.elapsedMs > 0 ? metrics.verifiedNewContacts * 3_600_000 / metrics.elapsedMs : 0;
    return { ...this.state, performance: { ...metrics }, goal: this.goalSnapshot(), counts };
  }
  goalSnapshot(config = this.store.loadConfig()) {
    const counts = this.store.companyCounts();
    const contactTarget = config.contactCompanyTarget, resumeTarget = config.resumeCompanyTarget;
    const contactReached = contactTarget > 0 && counts.contactedCompanies >= contactTarget;
    const resumeReached = resumeTarget > 0 && counts.deliveredCompanies >= resumeTarget;
    return { ...counts, contactTarget, resumeTarget, contactReached, resumeReached,
      complete: (contactTarget > 0 || resumeTarget > 0) && (contactTarget === 0 || contactReached) && (resumeTarget === 0 || resumeReached) };
  }
  goalCapacity(config) {
    const reserved = this.store.companyReservations();
    return { ...reserved,
      contactFull: config.contactCompanyTarget > 0 && reserved.contactCompanies.size >= config.contactCompanyTarget,
      resumeFull: config.resumeCompanyTarget > 0 && reserved.resumeCompanies.size >= config.resumeCompanyTarget };
  }
  setState(patch) {
    if (['completed', 'stopped', 'error'].includes(patch.status) && this.performanceStartedAt !== null && this.performanceFinishedAt === null) this.performanceFinishedAt = this.now();
    Object.assign(this.state, patch);
    this.emit('update', this.snapshot());
  }
  log(type, message, extras = {}) { this.store.appendEvent({ type, message, ...extras }); this.emit('update', this.snapshot()); }
  prepareLogin() {
    return this.prepareBrowser(false);
  }
  prepareExtensionSetup() {
    return this.prepareBrowser(true);
  }
  prepareBrowser(setup) {
    if (this.task) throw new Error('投递正在运行，请在当前专用浏览器处理登录');
    if (this.loginTask) return this.loginTask;
    this.abort = new AbortController();
    this.setState({ status:'idle', lastError:null });
    this.loginTask = (async () => {
      try {
        if (setup) {
          if (!this.browser.setupExtension) throw new Error('当前测试会话没有扩展安装入口');
          await this.browser.setupExtension();
        } else if (this.browser.openForLogin) await this.browser.openForLogin();
        else await this.browser.open();
        this.log('login_waiting', setup ? '专用 Chrome 已打开；如显示新标签页，请在该浏览器地址栏输入 chrome://extensions/ 打开扩展管理，加载本项目 extension 目录，再用控制台配对码连接' : '专用浏览器已打开，请自行选择扫码或短信登录；完成后可先预览岗位');
      }
      catch (error) {
        if (this.abort.signal.aborted) { await this.browser.close().catch(() => {}); return; }
        browserError(error);
        this.setState({ lastError:{message:error.message,code:error.code||'BROWSER_ERROR'} });
        this.log('login_waiting', error.message);
      }
    })().finally(() => { this.loginTask = null; });
    return this.loginTask;
  }
  start({ preview = false, once = preview, resumeJobKey, inspectResumeOnly = false, greetingJobKeys, greetingTestText, greetingTestPreview = true } = {}) {
    if (this.task) {
      if (resumeJobKey !== undefined || greetingJobKeys !== undefined) throw new Error('请先停止运行，再执行指定岗位验收');
      return this.task;
    }
    if (this.loginTask) throw new Error('登录浏览器正在打开，请稍后再开始');
    const config = this.store.loadConfig();
    if (!config.setupComplete) throw new Error('请先保存求职设置');
    let greetingSelection;
    if (greetingJobKeys !== undefined) {
      if (resumeJobKey !== undefined || inspectResumeOnly || !Array.isArray(greetingJobKeys) || greetingJobKeys.length < 1 || greetingJobKeys.length > 5 || greetingJobKeys.some(key => typeof key !== 'string' || !/^job:[A-Za-z0-9_-]+$/u.test(key)) || new Set(greetingJobKeys).size !== greetingJobKeys.length || typeof greetingTestPreview !== 'boolean' || typeof greetingTestText !== 'string' || !greetingTestText.trim() || greetingTestText.length > 500 || greetingTestText.includes('\0')) throw new Error('招呼实测只接受 1 到 5 个不同岗位记录、明确招呼文本和布尔预览选项');
      greetingSelection = Object.freeze(greetingJobKeys.map(key => {
        const record = this.store.getJob(key);
        if (!record || record.greetingStatus !== 'none' || record.resumeStatus !== 'none' || (!greetingTestPreview && record.eligible !== true)) throw new Error('招呼实测只接受未沟通、未操作附件的岗位；发送前需先刷新筛选结果');
        return Object.freeze({ ...record });
      }));
    } else if (greetingTestText !== undefined || greetingTestPreview !== true) throw new Error('招呼实测必须指定岗位记录');
    if (typeof inspectResumeOnly !== 'boolean' || (inspectResumeOnly && resumeJobKey === undefined)) throw new Error('只读附件验收必须指定单个岗位记录');
    if (resumeJobKey !== undefined) {
      const record = typeof resumeJobKey === 'string' && resumeJobKey.trim() ? this.store.getJob(resumeJobKey) : null;
      if (!record || record.eligible !== true || !['sent', 'existing'].includes(record.greetingStatus) || !resumeSelectable(record, inspectResumeOnly)) throw new Error('单岗附件验收只接受符合筛选、已沟通且附件结果可处理的岗位记录');
      preview = false;
      once = true;
    }
    this.abort = new AbortController();
    this.runContacts = 0;
    this.scanLogCriteria = null;
    this.searchLogSignatures.clear();
    this.performanceStartedAt = this.now();
    this.performanceFinishedAt = null;
    this.setState({ status: 'running', mode: greetingSelection ? greetingTestPreview ? 'greeting-preview' : 'greeting-verification' : resumeJobKey !== undefined ? 'resume-verification' : preview ? 'preview' : 'apply', startedAt: new Date().toISOString(), lastError: null, cycle: 0, performance: freshPerformance(), greetingTest: greetingSelection ? { preview: greetingTestPreview, requested: greetingSelection.length, inspected: 0, eligible: 0, attempted: 0, confirmed: 0 } : null });
    let operation;
    if (greetingSelection) {
      const verify = () => this.runGreetings({ selection: greetingSelection, greeting: greetingTestText, preview: greetingTestPreview });
      operation = typeof this.browser.withFailFastReads === 'function' ? this.browser.withFailFastReads(verify) : verify();
    } else operation = this.run({ preview, once, resumeJobKey, inspectResumeOnly });
    this.task = operation.finally(() => { this.task = null; this.emit('update', this.snapshot()); });
    return this.task;
  }
  pause(reason = '已暂停，请处理浏览器页面后点击继续', code = 'USER_PAUSE') {
    if (!this.task || this.state.status === 'stopped') return;
    this.setState({ status: 'paused', lastError: { message: reason, code }, nextScanAt: null });
    this.log('paused', reason, { code });
    this.emit('paused');
  }
  resume() {
    if (this.state.status !== 'paused') return;
    if (this.state.lastError?.code === 'NAVIGATION_REVERSED') throw new Error('职位页已发生回退，当前自动控制方式无法稳定读取；请停止任务并处理浏览器兼容性问题');
    if (['GOAL_CONTACT_RESERVED', 'GOAL_RESUME_RESERVED', 'NO_ACTIONABLE_WORK'].includes(this.state.lastError?.code)) throw new Error('当前目标没有可执行的工作；请先停止任务，再核对未确认记录或修改目标设置后重新启动');
    this.setState({ status: 'running', lastError: null });
    this.emit('resume_signal');
  }
  async stop() {
    this.abort?.abort();
    this.emit('resume_signal');
    this.setState({ status: 'stopped', currentJob: null, nextScanAt: null });
    await this.browser.close().catch(() => {});
    if (this.loginTask) await this.loginTask;
    if (this.task) await this.task;
  }
  async checkpoint() {
    if (this.abort?.signal.aborted) throw cancelled();
    while (this.state.status === 'paused') {
      await new Promise(resolve => this.once('resume_signal', resolve));
      if (this.abort?.signal.aborted) throw cancelled();
    }
  }
  async wait(ms, kind) {
    await this.checkpoint();
    if (ms <= 0) return 0;
    const started = this.now();
    let elapsed;
    try { await this.sleep(ms, this.abort.signal); await this.checkpoint(); }
    finally {
      elapsed = Math.max(0, this.now() - started);
      this.state.performance.waitedMs += elapsed;
      const field = { contact: 'contactWaitMs', batch: 'batchWaitMs', idle: 'idleWaitMs' }[kind];
      if (field) this.state.performance[field] += elapsed;
    }
    return elapsed;
  }
  recoveryBlocked(key, criteria, fingerprint) {
    const recovery = this.jobRecoveries.get(key);
    if (!recovery) return false;
    if (recovery.criteria !== criteria || recovery.fingerprint !== fingerprint || recovery.until <= this.now()) {
      this.jobRecoveries.delete(key);
      return false;
    }
    return true;
  }
  isolateJob(card, criteria, fingerprint, error, phase) {
    const key = jobKey(card);
    this.jobRecoveries.delete(key);
    this.jobRecoveries.set(key, { criteria, fingerprint, until: this.now() + recoveryTtlMs });
    while (this.jobRecoveries.size > recoveryCacheLimit) this.jobRecoveries.delete(this.jobRecoveries.keys().next().value);
    this.log('job_skipped', `${card.company} · ${card.title}：${error.message}；已跳过该岗位，自动处理下一岗位，未确认的发送不会重发`, { key, code: error.code, phase });
  }
  async readOperation(operation, { failFast = false, jobLocal = false } = {}) {
    for (;;) {
      await this.checkpoint();
      try { return await operation(); }
      catch (error) {
        if (this.abort.signal.aborted) throw cancelled();
        browserError(error);
        if (failFast || (jobLocal && jobLocalCodes.has(error.code))) throw error;
        this.pause(error.message, error.code || 'BROWSER_ERROR');
        await this.checkpoint();
      }
    }
  }
  async runGreetings({ selection, greeting, preview }) {
    const issue = (code, message) => Object.assign(new Error(message), { code });
    const sameIdentity = (actual, expected) => actual && jobKey(actual) === expected.key && actual.id === expected.id && actual.url === expected.url && actual.title === expected.title && actual.company === expected.company;
    const unchanged = expected => {
      const current = this.store.getJob(expected.key);
      if (!sameIdentity(current, expected) || current.greetingStatus !== 'none' || current.resumeStatus !== 'none') throw issue('GREETING_RECORD_CHANGED', '指定岗位身份或发送状态已改变，本次实测结束');
      return current;
    };
    const stats = { ...this.state.greetingTest };
    const updateStats = () => this.setState({ greetingTest: { ...stats } });
    const read = operation => this.readOperation(operation, { failFast: true });
    try {
      await read(() => this.browser.open());
      const login = await read(() => this.browser.login());
      if (login?.loggedIn) this.log('login_confirmed', '已确认 BOSS 账号登录，开始指定岗位招呼验收');
      this.setState({ cycle: 1 });
      for (const selected of selection) {
        await this.checkpoint();
        const before = unchanged(selected);
        this.setState({ currentJob: { title: selected.title, company: selected.company, url: selected.url } });
        const job = await read(() => { this.state.performance.detailReads++; return this.browser.details({ ...before }); });
        if (!sameIdentity(job, selected)) throw issue('GREETING_SCOPE_VIOLATION', '新读取的岗位身份与指定岗位不一致，未新增招呼');
        unchanged(selected);
        const evaluation = evaluateJob(job, this.store.loadConfig());
        this.store.upsertJob(job, { ...evaluation, greetingStatus: 'none', resumeStatus: 'none', evaluatedAt: new Date().toISOString() });
        stats.inspected++; if (evaluation.eligible) stats.eligible++;
        updateStats();
        if (preview || !evaluation.eligible) continue;
        await this.checkpoint();
        unchanged(selected);
        if (stats.attempted >= 5) throw issue('GREETING_SCOPE_VIOLATION', '已达到本次招呼实测的尝试上限');
        stats.attempted++; updateStats();
        let intentWritten = false, confirmed = false, expectedGreeting = 'none';
        const countVerified = () => {
          if (confirmed) return;
          confirmed = true; stats.confirmed++; this.state.performance.verifiedNewContacts++; updateStats();
        };
        try {
          const result = await this.browser.contact(job, { greeting, resumeOnly: false, sendResume: false, deferResumeAfterGreeting: false,
            onStage: async (stage, patch) => {
              await this.checkpoint();
              if (!patch || Object.hasOwn(patch, 'resumeStatus') || !['intent', 'sent', 'existing', 'uncertain'].includes(patch.greetingStatus)) throw issue('GREETING_SCOPE_VIOLATION', '招呼实测禁止附件步骤或无效发送阶段');
              const current = this.store.getJob(selected.key);
              if (!sameIdentity(current, selected) || current.resumeStatus !== 'none' || current.greetingStatus !== expectedGreeting || (patch.greetingStatus === 'intent' && !['none', 'intent'].includes(expectedGreeting))) throw issue('GREETING_RECORD_CHANGED', '指定岗位在发送阶段已改变，本次实测结束');
              if (['sent', 'uncertain'].includes(patch.greetingStatus) && !intentWritten) throw issue('GREETING_SCOPE_VIOLATION', '未持久化招呼意图，不能记录发送回执');
              this.store.upsertJob(job, { greetingStatus: patch.greetingStatus, ...(patch.note ? { note: patch.note } : {}), ...(patch.evidence ? { evidence: patch.evidence } : {}) });
              expectedGreeting = patch.greetingStatus;
              if (patch.greetingStatus === 'intent') intentWritten = true;
              if (patch.greetingStatus === 'sent') countVerified();
              this.log('stage', `${job.title}：${stage}`, { key: selected.key, stage });
            }
          });
          const current = this.store.getJob(selected.key);
          if (!sameIdentity(current, selected) || current.resumeStatus !== 'none' || current.greetingStatus !== expectedGreeting || !result || !['sent', 'existing', 'uncertain'].includes(result.greetingStatus) || (result.resumeStatus !== undefined && result.resumeStatus !== 'none') || (result.greetingStatus === 'sent' && !intentWritten)) throw issue('GREETING_SCOPE_VIOLATION', '招呼实测回执超出指定范围，本次实测结束');
          this.store.upsertJob(current, { greetingStatus: result.greetingStatus, resumeStatus: 'none', note: result.note || '指定岗位招呼验收', evidence: result.evidence || current.evidence });
          if (result.greetingStatus === 'sent') countVerified();
          this.log('contact_result', `${job.company} · ${job.title}：${result.note || result.greetingStatus}`, { key: selected.key, greetingStatus: result.greetingStatus, resumeStatus: 'none', greetingTest: true });
          if (result.greetingStatus === 'uncertain') throw issue('UNCERTAIN', '招呼发送结果未确认，实测已结束且不会自动重发');
        } catch (error) {
          const current = this.store.getJob(selected.key);
          if (current) this.store.upsertJob(current, { note: error.message, ...(intentWritten && current.greetingStatus === 'intent' ? { greetingStatus: 'uncertain' } : {}) });
          throw error;
        }
      }
      this.setState({ status: this.abort.signal.aborted ? 'stopped' : 'completed', currentJob: null, nextScanAt: null });
    } catch (error) {
      browserError(error);
      if (error.code === 'STOPPED' || this.abort.signal.aborted) this.setState({ status: 'stopped', currentJob: null, nextScanAt: null });
      else {
        this.setState({ status: 'error', currentJob: null, nextScanAt: null, lastError: { message: error.message, code: error.code || 'ERROR' } });
        try { this.log('error', error.message); } catch { /* a failed durable write ends the bounded invocation */ }
      }
    } finally { await this.browser.close().catch(() => {}); }
  }
  async run({ preview, once, resumeJobKey, inspectResumeOnly }) {
    const scoped = resumeJobKey !== undefined;
    const read = operation => this.readOperation(operation, { failFast: scoped });
    const readJob = operation => this.readOperation(operation, { failFast: scoped, jobLocal: !scoped });
    try {
      if (!preview && !inspectResumeOnly && this.goalSnapshot().complete) throw goalBlocked('GOAL_COMPLETE', '已达到配置的公司数量目标');
      await read(() => this.browser.open());
      const login = await read(() => this.browser.login());
      if (login?.loggedIn) this.log('login_confirmed', '已确认 BOSS 账号登录，开始读取岗位');
      do {
        await this.checkpoint();
        const config = this.store.loadConfig();
        const contactDelay = this.delayMs ?? config.delaySeconds * 1000;
        const criteriaSignature=JSON.stringify([config.city,config.cityCode,config.targetRole,config.roleType,config.requiredAny,config.excludeKeywords,config.excludeCompanies,config.roleTitleExclusions,config.contactCompanyTarget,config.resumeCompanyTarget]);
        const recoveryCriteria = JSON.stringify([criteriaSignature, config.queries]);
        const cycleGoal = preview || inspectResumeOnly ? null : this.goalSnapshot(config);
        if (cycleGoal?.complete) throw goalBlocked('GOAL_COMPLETE', '已达到配置的公司数量目标');
        const pendingJobs = new Map(this.store.listJobs().filter(j => (!scoped || jobKey(j) === resumeJobKey) && j.eligible && ['sent', 'existing'].includes(j.greetingStatus) && resumeSelectable(j, inspectResumeOnly)).map(j => [jobKey(j), j]));
        if (!preview && !once && (config.contactCompanyTarget > 0 || config.resumeCompanyTarget > 0)) {
          const capacity = this.goalCapacity(config), goal = cycleGoal;
          const noNewContact = capacity.contactFull || (capacity.resumeFull && config.contactCompanyTarget === 0);
          const pendingActionable = !capacity.resumeFull && !goal.resumeReached && [...pendingJobs.values()].some(card => !precheckJob(card, config).rejected);
          if (noNewContact && !pendingActionable) {
            const code = capacity.contactFull && !goal.contactReached ? 'GOAL_CONTACT_RESERVED' : capacity.resumeFull && !goal.resumeReached ? 'GOAL_RESUME_RESERVED' : 'NO_ACTIONABLE_WORK';
            const message = code === 'NO_ACTIONABLE_WORK' ? '已达到新联系公司的目标，当前没有可处理的待发附件；请停止任务后检查记录或调整目标，再重新启动' : '未确认的发送已占用目标额度，当前没有可执行的工作；请先停止任务并人工核对结果，未确认记录不会自动重发';
            this.pause(message, code);
            await this.checkpoint();
            continue;
          }
        }
        this.setState({ status: 'running', cycle: this.state.cycle + 1, nextScanAt: null });
        const searchCriteria = JSON.stringify([criteriaSignature, config.queries, config.maxPages]);
        if (!scoped && this.scanLogCriteria !== searchCriteria) {
          this.scanLogCriteria = searchCriteria;
          // One digest per configured query (at most 20), scoped to this launch
          // and criteria. No candidate records or history accumulate here.
          this.searchLogSignatures.clear();
          this.log('scan_start', `开始第 ${this.state.cycle} 轮${config.city} ${config.targetRole||'AI Agent'} 岗位搜索`);
        }
        const seen = new Set(), resumeSeen = new Set();
        let quotaReached = false, cycleNewContacts = 0, resumeChecks = 0;
        // Search every query before revisiting old conversations. A separate
        // final group keeps attachments reachable even after the new-contact quota.
        const groups = scoped ? [{ pending: true }] : [...config.queries.map(query => ({ query })), { pending: true }];
        for (const group of groups) {
          await this.checkpoint();
          const { query, pending } = group;
          if (!pending && quotaReached) continue;
          const goal = this.goalSnapshot(config);
          const capacity = this.goalCapacity(config);
          if (!preview && !inspectResumeOnly && goal.complete) throw goalBlocked('GOAL_COMPLETE', '已达到配置的公司数量目标');
          const noNewContact = capacity.contactFull || (capacity.resumeFull && config.contactCompanyTarget === 0);
          const found = pending || (!preview && noNewContact) ? [] : await read(() => this.browser.discover(query, config));
          const cards = pending ? (preview || inspectResumeOnly || !goal.resumeReached ? [...pendingJobs.values()] : []) : found;
          // Keep old conversations moving without reopening every old chat after
          // each search cycle. When only attachments remain, drain the queue.
          const resumeBudget = pending && !scoped && !preview && !inspectResumeOnly && (!once || cycleNewContacts > 0) && !noNewContact && !quotaReached && !(config.resumeCompanyTarget > 0 && config.contactCompanyTarget === 0) ? 5 : Infinity;
          const lastCheck = card => { const value = Date.parse(card.lastResumeCheckAt || ''); return Number.isFinite(value) ? value : 0; };
          const rankedCards = cards.map((card, index) => ({ card, index, precheck: precheckJob(card, config) }))
            .sort((a, b) => pending ? lastCheck(a.card) - lastCheck(b.card) || a.index - b.index : b.precheck.titleScore - a.precheck.titleScore || a.index - b.index);
          if (pending) {
            if (cards.length) this.log('resume_queue', scoped ? '仅验收指定岗位的附件简历，不新增招呼' : `本轮检查 ${Math.min(cards.length, resumeBudget)} 个待发简历岗位，按最久未检查的会话轮转`);
          } else {
            const signature = searchFingerprint(found);
            if (this.searchLogSignatures.get(query) !== signature) {
              this.searchLogSignatures.set(query, signature);
              this.log('search_result', `“${query}”找到 ${found.length} 个岗位`);
            }
          }
          for (const { card, precheck } of rankedCards) {
            await this.checkpoint();
            const key = jobKey(card);
            if (pending && resumeChecks >= resumeBudget) break;
            const visited = pending ? resumeSeen : seen;
            if (visited.has(key)) continue;
            const fingerprint = cardFingerprint(card);
            let recoveryAddress;
            try { const url = new URL(card.url, 'https://www.zhipin.com'); recoveryAddress = url.origin + url.pathname; } catch { recoveryAddress = card.url; }
            const recoveryFingerprint = JSON.stringify([fingerprint, recoveryAddress]);
            if (!scoped && this.recoveryBlocked(key, recoveryCriteria, recoveryFingerprint)) continue;
            let old = this.store.getJob(key);
            if (['intent', 'uncertain'].includes(old?.greetingStatus) || (!inspectResumeOnly && ['intent', 'uncertain'].includes(old?.resumeStatus))) continue;
            if (old?.eligible===false && old.criteriaSignature===criteriaSignature && old.cardFingerprint===fingerprint && Date.now()-Date.parse(old.evaluatedAt||'')<6*60*60_000) continue;
            const contacted = ['sent', 'existing'].includes(old?.greetingStatus);
            if (!preview && contacted && !pending) {
              if (resumeDue(old)) pendingJobs.set(key, { ...card, lastResumeCheckAt: old.lastResumeCheckAt });
              continue;
            }
            visited.add(key);
            const currentGoal = this.goalSnapshot(config);
            const currentCapacity = this.goalCapacity(config);
            if (!preview && !inspectResumeOnly && currentGoal.complete) throw goalBlocked('GOAL_COMPLETE', '已达到配置的公司数量目标');
            if (contacted && !inspectResumeOnly && (!resumeDue(old) || (!preview && currentGoal.resumeReached))) continue;
            if (!preview && !contacted && (currentCapacity.contactFull || (currentCapacity.resumeFull && config.contactCompanyTarget === 0))) continue;
            if (precheck.rejected) {
              this.state.performance.precheckRejected++;
              this.store.upsertJob(card, { eligible: false, score: 0, reasons: precheck.reasons, criteriaSignature, cardFingerprint: fingerprint, evaluatedAt: new Date().toISOString() });
              continue;
            }
            this.setState({ currentJob: { title: card.title, company: card.company, url: card.url } });
            if (pending) resumeChecks++;
            let job;
            try {
              job = await readJob(() => { this.state.performance.detailReads++; return this.browser.details(card); });
              if (!detailMatchesCard(job, card)) throw Object.assign(new Error('岗位详情与搜索结果的 ID、名称或公司不一致，未执行发送'), { code: 'RECIPIENT_UNVERIFIED' });
            } catch (error) {
              if (scoped || !jobLocalCodes.has(error.code) || this.abort.signal.aborted) throw error;
              this.isolateJob(card, recoveryCriteria, recoveryFingerprint, error, 'details');
              continue;
            }
            const evaluation = evaluateJob(job, config);
            this.store.upsertJob(job, { ...evaluation, criteriaSignature, cardFingerprint: fingerprint, evaluatedAt:new Date().toISOString() });
            if (!evaluation.eligible || preview) continue;
            old = this.store.getJob(key);
            if (!contacted && ((config.dailyLimit > 0 && this.store.dailyContacts() >= config.dailyLimit) || (config.runLimit > 0 && this.runContacts >= config.runLimit))) {
              quotaReached = true;
              break;
            }
            await this.checkpoint();
            let greetingIntent = false, resumeIntent = false, verifiedCounted = false, budgetCounted = false;
            let shouldPace = false, newVerifiedContact = false, paceChecked = false;
            const markVerified = () => {
              if (!contacted && !verifiedCounted) { verifiedCounted = true; newVerifiedContact = true; this.state.performance.verifiedNewContacts++; }
            };
            const countContact = status => {
              if (!contacted && !budgetCounted && ['sent', 'uncertain'].includes(status)) { budgetCounted = true; this.runContacts++; }
            };
            try {
              const result = await this.browser.contact(job, {
                greeting: renderGreeting(job, config), resumeName: config.resumeName, resumeOnly: scoped || contacted,
                deferResumeAfterGreeting: !scoped && !contacted,
                sendResume: !inspectResumeOnly && !this.goalCapacity(config).resumeFull,
                ...(inspectResumeOnly ? { inspectResumeOnly: true } : {}),
                onStage: async (stage, patch) => {
                  // All intent writes must reach disk before the browser performs the click.
                  await this.checkpoint();
                  if (scoped && patch.greetingStatus && patch.greetingStatus !== 'existing') throw Object.assign(new Error('单岗附件验收禁止新增招呼'), { code: 'RESUME_SCOPE_VIOLATION' });
                  if (inspectResumeOnly && patch.resumeStatus) throw Object.assign(new Error('只读附件验收禁止写入附件发送阶段'), { code: 'RESUME_SCOPE_VIOLATION' });
                  if (patch.greetingStatus === 'intent' || patch.resumeStatus === 'intent') {
                    // Read-only preparation may fill the interval. The first
                    // durable intent of the next flow still waits for its gate.
                    if (!paceChecked) {
                      while (contactDelay > 0 && this.nextContactAt > this.now()) await this.wait(this.nextContactAt - this.now(), 'contact');
                      paceChecked = true;
                    }
                    const goal = this.goalSnapshot(config);
                    const capacity = this.goalCapacity(config);
                    const company = normalizeCompany(job.company);
                    if (goal.complete) throw goalBlocked('GOAL_COMPLETE', '已达到配置的公司数量目标');
                    if (patch.greetingStatus === 'intent') {
                      if (goal.contactReached) throw goalBlocked('GOAL_CONTACT_REACHED', '已达到新沟通公司的目标，只继续检查待发附件');
                      if (capacity.contactFull && !capacity.contactCompanies.has(company)) throw goalBlocked('GOAL_CONTACT_RESERVED', '未确认的招呼已占用目标额度，请先人工核对');
                      const current = this.store.getJob(key);
                      if (['sent', 'existing', 'uncertain'].includes(current?.greetingStatus) || (current?.greetingStatus === 'intent' && !greetingIntent)) throw goalBlocked('JOB_ALREADY_CONTACTED', '该岗位已沟通过或发送结果未确认，拒绝再次写入招呼意图');
                    }
                    if (patch.resumeStatus === 'intent' && goal.resumeReached) throw goalBlocked('GOAL_RESUME_REACHED', '已达到简历送达公司的目标，跳过附件动作');
                    if (patch.resumeStatus === 'intent' && capacity.resumeFull && !capacity.resumeCompanies.has(company)) throw goalBlocked('GOAL_RESUME_RESERVED', '未确认的附件已占用目标额度，请先人工核对');
                  }
                  const staged = { ...patch, lastResumeCheckAt: new Date().toISOString() };
                  if (contacted && patch.greetingStatus === 'existing') staged.greetingStatus = old.greetingStatus;
                  this.store.upsertJob(job, staged);
                  if (patch.greetingStatus === 'intent') greetingIntent = true;
                  if (patch.resumeStatus === 'intent') resumeIntent = true;
                  if (patch.greetingStatus === 'sent') { markVerified(); countContact('sent'); }
                  this.log('stage', `${job.title}：${stage}`, { key, stage });
                }
              });
              const patch = { ...result, resumeDeferred: result.resumeDeferred === true, lastResumeCheckAt: new Date().toISOString() };
              if (contacted) patch.greetingStatus = old.greetingStatus;
              if (result.resumeSkipped || inspectResumeOnly) patch.resumeStatus = old.resumeStatus;
              this.store.upsertJob(job, patch);
              const newContact = !contacted && ['sent', 'uncertain'].includes(result.greetingStatus);
              if (newContact) countContact(result.greetingStatus);
              if (newContact && result.greetingStatus === 'sent') { markVerified(); cycleNewContacts++; }
              const queued = this.store.getJob(key);
              if (!scoped && !pending && result.resumeDeferred === true && queued.eligible && ['sent', 'existing'].includes(queued.greetingStatus) && resumeDue(queued)) pendingJobs.set(key, queued);
              shouldPace = resumeIntent || newContact;
              this.log('contact_result', `${job.company} · ${job.title}：${result.note || result.resumeStatus}`, { key, ...result });
              if (result.greetingStatus === 'uncertain' || result.resumeStatus === 'uncertain') {
                if (scoped) throw Object.assign(new Error('本次附件操作结果未确认，验收已结束；该记录不会自动重发'), { code: 'UNCERTAIN' });
                this.isolateJob(card, recoveryCriteria, recoveryFingerprint, Object.assign(new Error('本次操作结果未确认，记录已隔离'), { code: 'UNCERTAIN' }), 'contact');
              }
            } catch (error) {
              if (goalCodes.has(error.code)) {
                shouldPace = greetingIntent || resumeIntent;
                this.log('goal_guard', error.message, { key, code: error.code });
                if (error.code === 'GOAL_COMPLETE') throw error;
              } else {
                browserError(error);
                const record = this.store.getJob(key);
                const patch = { note: error.message, evidence: error.evidence || record?.evidence,
                  ...(scoped ? { greetingStatus: record.greetingStatus, resumeStatus: record.resumeStatus } : {}) };
                // Inspection cannot reinterpret a historical intent: no send
                // was authorized or attempted in this read-only invocation.
                if (!inspectResumeOnly && record?.greetingStatus === 'intent') patch.greetingStatus = 'uncertain';
                if (!inspectResumeOnly && record?.resumeStatus === 'intent') patch.resumeStatus = 'uncertain';
                const updated = this.store.upsertJob(job, patch);
                countContact(updated.greetingStatus);
                if (this.abort.signal.aborted) throw cancelled();
                shouldPace = greetingIntent || resumeIntent;
                if (scoped) throw error;
                if (jobLocalCodes.has(error.code)) this.isolateJob(card, recoveryCriteria, recoveryFingerprint, error, 'contact');
                else {
                  this.pause(`${job.title}：${error.message}`, error.code || 'CONTACT_ERROR');
                  await this.checkpoint();
                }
              }
            } finally {
              if (shouldPace || greetingIntent || resumeIntent) this.nextContactAt = contactDelay > 0 ? Math.max(this.nextContactAt, this.now() + contactDelay) : 0;
            }
            if (!inspectResumeOnly && this.goalSnapshot(config).complete) throw goalBlocked('GOAL_COMPLETE', '已达到配置的公司数量目标');
            if (newVerifiedContact && this.state.performance.verifiedNewContacts % config.contactBatchSize === 0) {
              const rest = this.batchBreakMs ?? config.batchBreakMinutes * 60_000;
              if (rest > 0) {
                this.setState({ status: 'waiting', nextScanAt: new Date(Date.now() + rest).toISOString() });
                this.log('batch_break', `已确认 ${config.contactBatchSize} 个新岗位招呼，休息 ${config.batchBreakMinutes} 分钟后继续`);
                this.emit('batch_break');
                await this.wait(rest, 'batch');
                this.setState({ status: 'running', nextScanAt: null });
              }
            }
          }
        }
        this.setState({ currentJob: null });
        if (once) break;
        const idle = this.idleMs ?? config.idleMinutes * 60_000;
        if (idle > 0) {
          this.setState({ status: 'waiting', nextScanAt: new Date(Date.now() + idle).toISOString() });
          const capacity = this.goalCapacity(config), goal = this.goalSnapshot(config);
          const unresolvedGoal = (capacity.contactFull && !goal.contactReached) || (capacity.resumeFull && !goal.resumeReached);
          this.log('waiting', unresolvedGoal ? '未确认的发送已占用公司目标额度，请先人工核对；成功进度尚未达到目标' : quotaReached ? '达到你设置的可选上限，稍后重新检查' : '本轮已扫描完，等待下一轮；已联系岗位会自动跳过');
          this.emit('waiting');
          await this.wait(idle, 'idle');
        } else {
          // This is scheduler fairness, not a timed delay. Immediate read-only
          // adapters must still let HTTP stop requests and aborts run.
          await new Promise(resolve => setImmediate(resolve));
          await this.checkpoint();
        }
      } while (!this.abort.signal.aborted);
      this.setState({ status: this.abort.signal.aborted ? 'stopped' : 'completed', currentJob: null, nextScanAt: null });
    } catch (error) {
      if (error.code === 'STOPPED' || this.abort.signal.aborted) this.setState({ status: 'stopped', currentJob: null, nextScanAt: null });
      else if (error.code === 'GOAL_COMPLETE') {
        this.setState({ status: 'completed', currentJob: null, nextScanAt: null, lastError: null });
        this.log('goal_complete', error.message);
      }
      else {
        this.setState({ status: 'error', lastError: { message: error.message, code: error.code || 'ERROR' } });
        try { this.log('error', error.message); } catch { /* storage failures must prevent further sending */ }
      }
    } finally { await this.browser.close().catch(() => {}); }
  }
}
