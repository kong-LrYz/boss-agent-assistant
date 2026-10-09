import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateConfig, jobKey, dateKey, normalizeCompany } from './core.js';
import { boundEvent } from './logging.js';

const greetingStates = new Set(['none', 'intent', 'sent', 'existing', 'uncertain']);
const resumeStates = new Set(['none', 'intent', 'requested', 'sent', 'unavailable', 'uncertain']);
const eventLimit = 500;

function copy(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('数据必须可序列化');
  return JSON.parse(serialized);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(record, key) {
  if (!object(record) || record.key !== key || !greetingStates.has(record.greetingStatus) || !resumeStates.has(record.resumeStatus)) {
    throw new TypeError(`状态文件中的岗位记录无效：${key}`);
  }
  if (jobKey(record) !== key) throw new TypeError(`状态文件中的岗位身份标识不一致：${key}`);
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof record[field] !== 'string' || !Number.isFinite(Date.parse(record[field]))) throw new TypeError(`岗位 ${field} 无效`);
  }
  if (record.contactedAt !== null && record.contactedAt !== undefined && !Number.isFinite(Date.parse(record.contactedAt))) throw new TypeError('岗位 contactedAt 无效');
}

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('必须是普通文件');
    fs.chmodSync(file, 0o600);
    return { exists: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw new Error(`无法读取 ${path.basename(file)}，文件可能损坏：${error.message}`, { cause: error });
  }
}

function atomicWrite(file, value) {
  const payload = `${JSON.stringify(value)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor, directoryDescriptor;
  let ownsTemporary = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    ownsTemporary = true;
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    ownsTemporary = false;
    // Windows does not support opening directories for fsync. File flushing and
    // atomic replacement still run there; Unix also flushes the rename itself.
    if (process.platform !== 'win32') {
      directoryDescriptor = fs.openSync(path.dirname(file), 'r');
      fs.fsyncSync(directoryDescriptor);
      fs.closeSync(directoryDescriptor);
      directoryDescriptor = undefined;
    }
  } catch (error) {
    // Only a successful exclusive create grants cleanup ownership. A completed
    // rename relinquishes it, so directory-flush failures keep the new state.
    for (const open of [descriptor, directoryDescriptor]) {
      if (open !== undefined) { try { fs.closeSync(open); } catch {} }
    }
    if (ownsTemporary) { try { fs.unlinkSync(temporary); } catch {} }
    throw new Error(`保存 ${path.basename(file)} 失败；已停止接受本次状态变更：${error.message}`, { cause: error });
  }
}

export class Store {
  #state;
  #configFile;
  #stateFile;

  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('需要数据目录');
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据目录必须是普通目录');
    fs.chmodSync(this.dataDir, 0o700);
    this.#configFile = path.join(this.dataDir, 'config.json');
    this.#stateFile = path.join(this.dataDir, 'state.json');
    const loaded = readJson(this.#stateFile);
    if (loaded.exists) {
      const state = loaded.value;
      if (!object(state) || state.version !== 1 || !object(state.jobs) || !Array.isArray(state.events)) throw new TypeError('状态文件格式损坏或版本不受支持');
      for (const [key, record] of Object.entries(state.jobs)) assertRecord(record, key);
      if (state.events.some(event => !object(event))) throw new TypeError('状态文件事件格式无效');
      this.#state = state;
    } else {
      if (fs.existsSync(this.#configFile)) throw new Error('已配置的数据目录缺少 state.json 状态文件；请恢复原文件后启动，避免重复联系。');
      this.#state = { version: 1, jobs: {}, events: [] };
      atomicWrite(this.#stateFile, this.#state);
    }
    const recovered = copy(this.#state);
    recovered.events = this.#state.events.slice(-eventLimit).map(boundEvent);
    let changed = JSON.stringify(recovered.events) !== JSON.stringify(this.#state.events);
    const now = new Date().toISOString();
    for (const record of Object.values(recovered.jobs)) {
      let recoveredRecord = false;
      if (record.greetingStatus === 'intent') { record.greetingStatus = 'uncertain'; recoveredRecord = true; }
      if (record.resumeStatus === 'intent') { record.resumeStatus = 'uncertain'; recoveredRecord = true; }
      if (recoveredRecord) {
        changed = true;
        record.updatedAt = now;
        record.note = [record.note, '上次运行中断，发送意图未确认；请人工核对后再操作。'].filter(Boolean).join('\n');
      }
    }
    if (changed) this.#commit(recovered);
  }

  #commit(state) {
    atomicWrite(this.#stateFile, state);
    this.#state = state;
  }

  loadConfig() {
    const loaded = readJson(this.#configFile);
    return validateConfig(loaded.exists ? loaded.value : {});
  }

  saveConfig(input) {
    const config = validateConfig(input);
    atomicWrite(this.#configFile, config);
    return copy(config);
  }

  upsertJob(job, patch = {}) {
    if (!object(job) || !object(patch)) throw new TypeError('岗位和更新必须是对象');
    const key = jobKey(job);
    const previous = this.#state.jobs[key];
    const now = new Date().toISOString();
    const initial = {
      key, id: '', url: '', title: '', company: '', city: '', description: '', tags: [],
      greetingStatus: 'none', resumeStatus: 'none', createdAt: now, updatedAt: now,
      contactedAt: null, note: '', evidence: {},
    };
    const record = copy({ ...initial, ...previous, ...job, ...patch, key, createdAt: previous?.createdAt || now, updatedAt: now });
    if (!record.contactedAt && ['intent', 'sent', 'uncertain'].includes(record.greetingStatus)) record.contactedAt = now;
    assertRecord(record, key);
    const state = copy(this.#state);
    state.jobs[key] = record;
    this.#commit(state);
    return copy(record);
  }

  getJob(key) {
    if (!Object.hasOwn(this.#state.jobs, key)) return undefined;
    const record = this.#state.jobs[key];
    return record ? copy(record) : undefined;
  }

  listJobs() {
    return Object.values(this.#state.jobs).map(copy).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  companyCounts() {
    const contacted = new Set();
    const delivered = new Set();
    for (const record of Object.values(this.#state.jobs)) {
      const company = normalizeCompany(record.company);
      if (!company) continue;
      if (record.greetingStatus === 'sent') contacted.add(company);
      if (record.resumeStatus === 'sent') delivered.add(company);
    }
    return { contactedCompanies: contacted.size, deliveredCompanies: delivered.size };
  }

  companyReservations() {
    const contactCompanies = new Set();
    const resumeCompanies = new Set();
    for (const record of Object.values(this.#state.jobs)) {
      const company = normalizeCompany(record.company);
      if (!company) continue;
      if (['sent', 'intent', 'uncertain'].includes(record.greetingStatus)) contactCompanies.add(company);
      if (['sent', 'intent', 'uncertain'].includes(record.resumeStatus)) resumeCompanies.add(company);
    }
    return { contactCompanies, resumeCompanies };
  }

  hasContactedCompany(name, { excludeKey } = {}) {
    const company = normalizeCompany(name);
    return Boolean(company) && Object.values(this.#state.jobs).some(record =>
      record.key !== excludeKey && ['sent', 'existing', 'intent', 'uncertain'].includes(record.greetingStatus) && normalizeCompany(record.company) === company);
  }

  appendEvent(event) {
    if (!object(event)) throw new TypeError('日志必须是对象');
    const record = copy(boundEvent({ ...event, id: crypto.randomUUID(), at: event.at || new Date().toISOString() }));
    const state = copy(this.#state);
    state.events.push(record);
    if (state.events.length > eventLimit) state.events = state.events.slice(-eventLimit);
    this.#commit(state);
    return copy(record);
  }

  listEvents(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('日志条数必须是非负整数');
    if (limit === 0) return [];
    return this.#state.events.slice(-Math.min(limit, eventLimit)).reverse().map(copy);
  }

  dailyContacts(date = new Date()) {
    const day = dateKey(date);
    return Object.values(this.#state.jobs).filter(record => record.contactedAt && dateKey(record.contactedAt) === day).length;
  }

  exportCsv() {
    const columns = [
      ['key', '岗位标识'], ['title', '岗位'], ['company', '公司'], ['city', '城市'], ['url', '链接'],
      ['greetingStatus', '沟通状态'], ['resumeStatus', '简历状态'], ['contactedAt', '联系时间'],
      ['createdAt', '发现时间'], ['updatedAt', '更新时间'], ['note', '备注'],
    ];
    const cell = value => {
      let content = String(value ?? '');
      if (/^[\s\uFEFF]*[=+\-@]/.test(content)) content = `'${content}`;
      return `"${content.replace(/"/g, '""')}"`;
    };
    const rows = [columns.map(([, label]) => cell(label)).join(',')];
    for (const record of this.listJobs()) rows.push(columns.map(([field]) => cell(record[field])).join(','));
    return `\uFEFF${rows.join('\r\n')}\r\n`;
  }
}
