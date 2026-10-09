import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export const LOG_LIMITS = Object.freeze({ runtimeBytes: 2 * 1024 * 1024, lineBytes: 8192, eventBytes: 8192, diagnosticBytes: 10 * 1024 * 1024, diagnosticFiles: 20 });

export function truncateUtf8(value, maxBytes) {
  const content = String(value);
  if (Buffer.byteLength(content) <= maxBytes) return content;
  let bytes = 0, result = '';
  for (const character of content) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function ordinaryDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('日志目录必须是普通目录，不能是符号链接');
}

function ordinaryFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('日志必须是普通文件，不能是符号链接或硬链接');
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function openFile(file, flags) {
  const descriptor = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0), 0o600);
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1) {
    fs.closeSync(descriptor);
    throw new Error('日志必须是普通文件，不能是链接');
  }
  fs.fchmodSync(descriptor, 0o600);
  return descriptor;
}

export class RuntimeLog {
  constructor(dataDir, { maxBytes = LOG_LIMITS.runtimeBytes, maxLineBytes = LOG_LIMITS.lineBytes } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 64 || maxLineBytes > maxBytes) throw new RangeError('日志容量设置无效');
    this.directory = path.resolve(dataDir);
    this.file = path.join(this.directory, 'runtime.log');
    this.maxBytes = maxBytes;
    this.maxLineBytes = maxLineBytes;
    ordinaryDirectory(this.directory);
    // Validate every managed path before rotating or truncating any file.
    for (const file of [this.file, `${this.file}.1`, `${this.file}.2`]) ordinaryFile(file);
    for (const file of [this.file, `${this.file}.1`, `${this.file}.2`]) this.clampExisting(file);
  }

  clampExisting(file) {
    const stat = ordinaryFile(file);
    if (!stat) return;
    const descriptor = openFile(file, fs.constants.O_RDWR);
    try {
      if (stat.size > this.maxBytes) {
        const tail = Buffer.alloc(this.maxBytes);
        const size = fs.readSync(descriptor, tail, 0, tail.length, stat.size - tail.length);
        const bytes = tail.subarray(0, size);
        const newline = bytes.indexOf(10);
        // A whole UTF-8 line boundary avoids keeping a partial old entry.
        const retained = newline >= 0 ? bytes.subarray(newline + 1) : Buffer.from(truncateUtf8(bytes.toString('utf8'), this.maxBytes));
        fs.ftruncateSync(descriptor, 0);
        fs.writeSync(descriptor, retained, 0, retained.length, 0);
      }
    } finally { fs.closeSync(descriptor); }
  }

  rotate() {
    for (const file of [this.file, `${this.file}.1`, `${this.file}.2`]) ordinaryFile(file);
    if (ordinaryFile(`${this.file}.2`)) fs.unlinkSync(`${this.file}.2`);
    if (ordinaryFile(`${this.file}.1`)) fs.renameSync(`${this.file}.1`, `${this.file}.2`);
    if (ordinaryFile(this.file)) fs.renameSync(this.file, `${this.file}.1`);
  }

  write(level, value) {
    const prefix = `${new Date().toISOString()} [${level}] `;
    const content = String(value).replace(/\r/gu, '\\r').replace(/\n/gu, '\\n');
    const budget = this.maxLineBytes - Buffer.byteLength(prefix) - 1;
    const shortened = Buffer.byteLength(content) > budget;
    const message = shortened ? `${truncateUtf8(content, budget - 15)} [truncated]` : content;
    const line = `${prefix}${message}\n`;
    ordinaryDirectory(this.directory);
    if ((ordinaryFile(this.file)?.size || 0) + Buffer.byteLength(line) > this.maxBytes) this.rotate();
    const descriptor = openFile(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
    try { fs.writeSync(descriptor, line, null, 'utf8'); }
    finally { fs.closeSync(descriptor); }
  }
}

export function installConsoleLogger(dataDir) {
  const logger = new RuntimeLog(dataDir);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...values) => {
      const message = format(...values);
      try { logger.write(method, message); }
      catch (error) { original(`日志写入失败：${truncateUtf8(error.message, 256)}`); }
      original(truncateUtf8(message, LOG_LIMITS.lineBytes));
    };
  }
  return logger;
}

export function boundEvent(event) {
  let truncated = false;
  const seen = new WeakSet();
  const walk = (value, depth = 0) => {
    if (typeof value === 'string') {
      const shortened = truncateUtf8(value, 4096);
      if (shortened !== value) truncated = true;
      return shortened;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (!value || typeof value !== 'object') return undefined;
    if (depth >= 5 || seen.has(value)) { truncated = true; return '[truncated]'; }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 32) truncated = true;
      return value.slice(0, 32).map(item => walk(item, depth + 1));
    }
    const entries = Object.entries(value);
    if (entries.length > 32) truncated = true;
    return Object.fromEntries(entries.slice(0, 32).map(([key, item]) => [truncateUtf8(key, 128), walk(item, depth + 1)]));
  };
  // Common identity/status fields always get budget before optional diagnostics.
  const record = Object.create(null);
  const primary = ['id', 'at', 'type', 'key', 'stage', 'code', 'message'];
  for (const key of primary) {
    if (!Object.hasOwn(event, key)) continue;
    let value = walk(event[key]);
    const budget = key === 'message' ? 4096 : key === 'key' ? 512 : 256;
    if (Buffer.byteLength(JSON.stringify(value) ?? '') > budget) {
      truncated = true;
      if (typeof value === 'string') {
        while (Buffer.byteLength(JSON.stringify(value)) > budget) value = truncateUtf8(value, Math.floor(Buffer.byteLength(value) * 0.75));
      } else value = '[truncated]';
    }
    record[key] = value;
  }
  for (const [key, value] of Object.entries(event)) {
    if (primary.includes(key)) continue;
    const name = truncateUtf8(key, 128), bounded = walk(value);
    const candidate = { ...record, [name]: bounded, truncated: true };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= LOG_LIMITS.eventBytes) record[name] = bounded;
    else truncated = true;
  }
  if (truncated) record.truncated = true;
  return record;
}

export function pruneDiagnostics(outputDir, { maxBytes = LOG_LIMITS.diagnosticBytes, maxFiles = LOG_LIMITS.diagnosticFiles } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new RangeError('诊断容量设置无效');
  const directory = path.resolve(outputDir);
  ordinaryDirectory(directory);
  const pattern = /^boss-diag-\d{13}-[a-z0-9_-]{1,64}-[a-f0-9]{8}\.(?:png|json)$/u;
  const files = [];
  for (const name of fs.readdirSync(directory)) {
    if (!pattern.test(name)) continue;
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
    files.push({ name, file, size: stat.size });
  }
  files.sort((left, right) => right.name.localeCompare(left.name));
  let bytes = 0, count = 0;
  for (const item of files) {
    if (count < maxFiles && bytes + item.size <= maxBytes) { bytes += item.size; count++; fs.chmodSync(item.file, 0o600); }
    else if (ordinaryFile(item.file)) fs.unlinkSync(item.file);
  }
}
