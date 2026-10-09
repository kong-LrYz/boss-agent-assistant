import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { VERSION, OPS, EFFECT_OPS } from '../extension/protocol.js';

const operations = new Set(OPS);
const effects = new Set(EFFECT_OPS);
const maximumBytes = 65_536;
const allowedHeaders = new Set(['content-type', 'x-boss-bridge-token', 'x-boss-instance']);
const methods = { '/bridge/pair': 'POST', '/bridge/poll': 'GET', '/bridge/commands': 'POST', '/bridge/result': 'POST', '/bridge/permit': 'POST', '/bridge/heartbeat': 'POST' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function text(value, maximum = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/u.test(value);
}

function jsonValue(value, depth = 0) {
  if (depth > 24) throw failure('BAD_PACKET', '消息层级过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  if (!plain(value)) throw failure('BAD_PACKET', '消息必须是普通 JSON 数据');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw failure('BAD_PACKET', '消息字段不受支持');
    result[key] = jsonValue(item, depth + 1);
  }
  return result;
}

function packet(value) {
  const copied = jsonValue(value);
  if (Buffer.byteLength(JSON.stringify(copied)) > maximumBytes) throw failure('PACKET_TOO_LARGE', '消息过大', 413);
  return copied;
}

function fields(body, allowed, required = []) {
  if (!plain(body) || Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw failure('BAD_PACKET', '请求字段无效');
}

function equal(secret, supplied) {
  if (typeof supplied !== 'string' || supplied.length > 256) return false;
  const expected = Buffer.from(secret), actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function duration(value, field, maximum = 300_000) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${field} 必须是有效的毫秒整数`);
  return value;
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers['content-type'] || ''))) throw failure('JSON_REQUIRED', '需要 JSON 请求', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) throw failure('PACKET_TOO_LARGE', '消息过大', 413);
    chunks.push(chunk);
  }
  try { return packet(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
  catch (error) { if (error.code) throw error; throw failure('BAD_PACKET', '请求 JSON 无效'); }
}

export class ExtensionBridge extends EventEmitter {
  #binding = null;
  #pairingCode = randomBytes(32).toString('hex');
  #epoch = randomUUID();
  #active = false;
  #sequence = 0;
  #pending = new Map();
  #polls = new Set();
  #lastSeen = 0;
  #reportedConnected = false;
  #canExecute;
  #file;

  constructor({ dataDir, timeoutMs = 15_000, pollMs = 10_000, leaseMs = 8000, canExecute = () => true }) {
    super();
    if (!text(dataDir, 4096)) throw new TypeError('需要本地数据目录');
    if (typeof canExecute !== 'function') throw new TypeError('canExecute 必须是函数');
    this.#canExecute = canExecute;
    this.dataDir = path.resolve(dataDir);
    this.timeoutMs = duration(timeoutMs, 'timeoutMs');
    this.pollMs = Math.min(duration(pollMs, 'pollMs'), 10_000);
    this.leaseMs = duration(leaseMs, 'leaseMs');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(this.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('BRIDGE_STATE_INVALID', '桥接数据目录必须是普通目录');
    this.#file = path.join(this.dataDir, 'extension-bridge.json');
    this.#loadBinding();
    const watchdog = setInterval(() => {
      if (this.#reportedConnected && !this.isConnected()) {
        this.#reportedConnected = false;
        this.#rotate(false, 'EXTENSION_OFFLINE');
        this.emit('disconnected', this.snapshot());
      }
    }, 1000);
    watchdog.unref();
  }

  get active() { return this.#active; }
  get epoch() { return this.#epoch; }
  get paired() { return Boolean(this.#binding); }

  snapshot() {
    return { paired: this.paired, connected: this.isConnected(), ...(this.paired ? { extensionId: this.#binding.extensionId } : { pairingCode: this.#pairingCode }), epoch: this.#epoch, pending: this.#pending.size };
  }

  isConnected() {
    const age = Date.now() - this.#lastSeen;
    return this.paired && this.#lastSeen > 0 && age >= 0 && age < 30_000;
  }

  beginRun() { return this.#rotate(true, 'STOPPED'); }
  cancel() { return this.#rotate(false, 'STOPPED'); }

  #rotate(active, readCode) {
    this.#active = active;
    this.#epoch = randomUUID();
    for (const record of [...this.#pending.values()]) this.#finish(record, failure(record.effect ? 'UNKNOWN_RESULT' : readCode, record.effect ? '扩展动作结果未确认，不会自动重派' : '本次桥接操作已停止'));
    this.#flushPolls(true);
    return this.#epoch;
  }

  #seen() {
    const connected = this.isConnected();
    if (this.#reportedConnected && !connected) this.#rotate(false, 'EXTENSION_OFFLINE');
    this.#lastSeen = Date.now();
    this.#reportedConnected = true;
    if (!connected) this.emit('connected', this.snapshot());
  }

  #loadBinding() {
    try {
      const info = fs.lstatSync(this.#file);
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Invalid permissions');
      const binding = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      if (!plain(binding) || Object.keys(binding).some(key => !['schema', 'extensionId', 'instanceId', 'token'].includes(key)) || binding.schema !== VERSION || !/^[a-p]{32}$/u.test(binding.extensionId || '') || !text(binding.instanceId) || !/^[a-f0-9]{64}$/u.test(binding.token || '')) throw new Error('Invalid binding');
      this.#binding = binding;
      this.#pairingCode = null;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw failure('BRIDGE_STATE_INVALID', '桥接配对记录无法验证；未重置原有绑定');
    }
  }

  #saveBinding(binding) {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(binding));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.#file);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(this.dataDir, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } catch {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch {}
      throw failure('BRIDGE_STATE_WRITE_FAILED', '配对保存失败，未启用本次配对', 500);
    }
  }

  async request(op, args = {}, options = {}) {
    if (!this.paired) throw failure('EXTENSION_REQUIRED', '请先加载并配对 Chrome 扩展');
    if (!operations.has(op)) throw failure('UNKNOWN_OPERATION', '不支持的固定操作');
    fields(options, ['target', 'timeoutMs']);
    if (!plain(args)) throw failure('BAD_PACKET', '操作参数必须是 JSON 对象');
    const effect = effects.has(op);
    if (effect && !this.#active) throw failure('BRIDGE_INACTIVE', '任务未运行，未派发网页动作');
    const timeout = Object.hasOwn(options, 'timeoutMs') ? duration(options.timeoutMs, 'timeoutMs') : this.timeoutMs;
    const ttl = effect ? Math.min(timeout, this.leaseMs) : timeout;
    const command = packet({ v: VERSION, id: randomUUID(), seq: ++this.#sequence, epoch: this.#epoch, expiresAt: Date.now() + ttl, op, args, ...(Object.hasOwn(options, 'target') ? { target: options.target } : {}) });
    return new Promise((resolve, reject) => {
      const record = { command, effect, delivered: false, permitted: false, resolve, reject };
      record.timer = setTimeout(() => this.#expire(record), ttl);
      record.timer.unref();
      this.#pending.set(command.id, record);
      this.#flushPolls();
    });
  }

  #finish(record, error, result) {
    if (!this.#pending.delete(record.command.id)) return;
    clearTimeout(record.timer);
    if (error) record.reject(error); else record.resolve(result);
  }

  #expire(record) {
    this.#finish(record, failure(record.effect ? 'UNKNOWN_RESULT' : 'EXTENSION_OFFLINE', record.effect ? '扩展动作结果未确认，不会自动重派' : '扩展未在期限内返回读取结果'));
  }

  #takeCommand() {
    for (const record of this.#pending.values()) {
      if (Date.now() >= record.command.expiresAt) { this.#expire(record); continue; }
      if (record.delivered || record.command.epoch !== this.#epoch || (record.effect && !this.#active)) continue;
      record.delivered = true;
      return record.command;
    }
    return null;
  }

  #reply(res, status, data) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  #poll(res) {
    const command = this.#takeCommand();
    if (command) return this.#reply(res, 200, { epoch: this.#epoch, active: this.#active, command });
    const waiter = { res };
    waiter.timer = setTimeout(() => this.#answerPoll(waiter, null), this.pollMs);
    waiter.timer.unref();
    this.#polls.add(waiter);
    res.once('close', () => { clearTimeout(waiter.timer); this.#polls.delete(waiter); });
  }

  #answerPoll(waiter, command) {
    if (!this.#polls.delete(waiter)) return;
    clearTimeout(waiter.timer);
    this.#reply(waiter.res, 200, { epoch: this.#epoch, active: this.#active, command });
  }

  #flushPolls(force = false) {
    for (const waiter of [...this.#polls]) {
      if (waiter.res.destroyed || waiter.res.writableEnded) { clearTimeout(waiter.timer); this.#polls.delete(waiter); continue; }
      const command = this.#takeCommand();
      if (command || force) this.#answerPoll(waiter, command);
    }
  }

  #origin(req) {
    const origin = req.headers.origin;
    const match = typeof origin === 'string' ? /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin) : null;
    if (!match || (this.paired && match[1] !== this.#binding.extensionId)) throw failure('BRIDGE_ORIGIN_REJECTED', '扩展来源未获授权', 403);
    return { origin, extensionId: match[1] };
  }

  #authenticate(req) {
    if (!this.paired || !equal(this.#binding.token, req.headers['x-boss-bridge-token']) || req.headers['x-boss-instance'] !== this.#binding.instanceId) throw failure('BRIDGE_AUTH_FAILED', '扩展配对认证失败', 401);
  }

  #pendingRecord(body) {
    if (!text(body.id) || !text(body.epoch)) throw failure('BAD_PACKET', '命令标识无效');
    if (body.epoch !== this.#epoch) throw failure('OLD_EPOCH', '旧任务命令已失效', 409);
    const record = this.#pending.get(body.id);
    if (!record) throw failure('UNKNOWN_COMMAND', '命令不存在或已消费', 404);
    if (!record.delivered) throw failure('NOT_DELIVERED', '命令尚未交付', 409);
    if (Date.now() >= record.command.expiresAt) { this.#expire(record); throw failure('COMMAND_EXPIRED', '命令已经过期', 410); }
    return record;
  }

  async handle(req, res, url) {
    if (url.pathname !== '/bridge' && !url.pathname.startsWith('/bridge/')) return false;
    if (!Object.hasOwn(methods, url.pathname)) { this.#reply(res, 404, { error: '未知桥接操作' }); return true; }
    try {
      if (url.search) throw failure('BAD_PACKET', '桥接请求不接受 URL 参数');
      const { origin, extensionId } = this.#origin(req);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        const headers = String(req.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (req.headers['access-control-request-method'] !== methods[url.pathname] || headers.some(header => !allowedHeaders.has(header))) throw failure('BAD_PREFLIGHT', '桥接预检未获授权', 403);
        res.writeHead(204, { 'Access-Control-Allow-Methods': methods[url.pathname], 'Access-Control-Allow-Headers': [...allowedHeaders].join(', '), 'Cache-Control': 'no-store' }); res.end(); return true;
      }
      if (req.method !== methods[url.pathname]) throw failure('METHOD_NOT_ALLOWED', '桥接请求方法不受支持', 405);
      if (url.pathname !== '/bridge/pair') this.#authenticate(req);
      if (url.pathname === '/bridge/poll') { this.#seen(); this.#poll(res); return true; }
      const body = await readBody(req);
      if (url.pathname === '/bridge/pair') {
        fields(body, ['pairingCode', 'instanceId'], ['pairingCode', 'instanceId']);
        if (this.paired) throw failure('ALREADY_PAIRED', '扩展已经配对', 409);
        if (!equal(this.#pairingCode, body.pairingCode)) throw failure('PAIRING_REJECTED', '配对码无效或已消费', 403);
        if (!text(body.instanceId) || !/^[a-zA-Z0-9_-]+$/u.test(body.instanceId)) throw failure('BAD_PACKET', '扩展实例标识无效');
        const binding = { schema: VERSION, extensionId, instanceId: body.instanceId, token: randomBytes(32).toString('hex') };
        this.#saveBinding(binding); this.#binding = binding; this.#pairingCode = null;
        this.#reply(res, 200, { token: binding.token, epoch: this.#epoch });
      } else if (url.pathname === '/bridge/commands') {
        // The verified MV3 fixture omitted Origin on GET but kept it on POST.
        // Keep the same
        // authenticated queue rather than accepting an origin-less client.
        fields(body, []); this.#seen(); this.#poll(res);
      } else if (url.pathname === '/bridge/heartbeat') {
        fields(body, []); this.#seen(); this.#reply(res, 200, { epoch: this.#epoch, active: this.#active });
      } else if (url.pathname === '/bridge/permit') {
        fields(body, ['id', 'epoch'], ['id', 'epoch']);
        const record = this.#pendingRecord(body);
        if (!record.effect || !this.#active || record.permitted || this.#canExecute() !== true) throw failure('PERMIT_REJECTED', '动作许可已失效或已消费', 409);
        record.permitted = true; this.#reply(res, 200, { allowed: true });
      } else {
        fields(body, ['id', 'epoch', 'result', 'error'], ['id', 'epoch']);
        if (Object.hasOwn(body, 'result') && Object.hasOwn(body, 'error')) throw failure('BAD_PACKET', '结果与错误不能同时提交');
        const record = this.#pendingRecord(body);
        let error;
        if (Object.hasOwn(body, 'error')) {
          if (typeof body.error === 'string') error = failure('EXTENSION_FAILURE', body.error.slice(0, 1000));
          else {
            fields(body.error, ['code', 'message'], ['message']);
            if (typeof body.error.message !== 'string' || (Object.hasOwn(body.error, 'code') && !text(body.error.code, 80))) throw failure('BAD_PACKET', '错误结果无效');
            error = failure(body.error.code || 'EXTENSION_FAILURE', body.error.message.slice(0, 1000));
          }
        }
        // An authenticated preflight rejection reports why no click was allowed.
        // Successful mutation results still require the one-use action permit.
        if (record.effect && (!this.#active || (!record.permitted && !error))) throw failure('PERMIT_REQUIRED', '动作未获许可，未接受结果', 409);
        this.#finish(record, error, body.result); this.#reply(res, 200, { ok: true });
      }
    } catch (error) { this.#reply(res, error.status || 400, { error: error.message, code: error.code || 'BRIDGE_ERROR' }); }
    return true;
  }
}
