import { mkdir, realpath, readFile, writeFile, rename, lstat, chmod, readlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { findChromeExecutable } from './chrome-runtime.js';

const runFile = promisify(execFile);
const descriptorName = '.boss-normal-session.json';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const key = (value, platform) => platform === 'win32' ? value.toLowerCase() : value;
function runtimeError(code, message) {
  return Object.assign(new Error(message), { code, recoverable: true });
}

function flagValue(command, name) {
  const matches = [...command.matchAll(new RegExp(`(?:^|\\s)--${name}=(?:"([^"]*)"|'([^']*)'|(.+?))(?=\\s--[A-Za-z]|\\s(?:https?:|about:|chrome:)|$)`, 'gu'))];
  if (matches.length !== 1) return null;
  return (matches[0][1] ?? matches[0][2] ?? matches[0][3]).trim();
}

async function candidateProcesses(platform) {
  if (platform === 'win32') {
    const script = "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$items=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object {$owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid;[pscustomobject]@{pid=$_.ProcessId;exe=$_.ExecutablePath;command=$_.CommandLine;owner=$owner.Sid}});[pscustomobject]@{owner=$sid;items=$items}|ConvertTo-Json -Compress";
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const result = JSON.parse(stdout);
    return (result.items ?? []).filter(item => item.owner === result.owner);
  }
  const { stdout } = await runFile('ps', ['-ww', '-axo', 'pid=,uid=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const rows = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match || Number(match[2]) !== process.getuid() || !match[3].includes('--user-data-dir=')) return [];
    return [{ pid: Number(match[1]), owner: Number(match[2]), command: match[3] }];
  });
  const result = [];
  for (const row of rows) {
    try {
      const executable = platform === 'linux' ? await readlink(`/proc/${row.pid}/exe`) : (await runFile('ps', ['-p', String(row.pid), '-o', 'comm='], { timeout: 2000 })).stdout.trim();
      result.push({ ...row, exe: executable });
    } catch { /* The process can exit between snapshots. */ }
  }
  return result;
}

async function installedImages(executable, platform) {
  const installed = await realpath(executable);
  const allowed = new Set([key(installed, platform)]);
  if (platform === 'linux') {
    for (const candidate of [path.join(path.dirname(installed), 'chrome'), '/opt/google/chrome/chrome']) {
      try { allowed.add(key(await realpath(candidate), platform)); } catch { /* Optional vendor wrapper target. */ }
    }
  }
  return allowed;
}

async function profileProcesses(profile, executable, platform) {
  const allowed = await installedImages(executable, platform);
  const matches = [];
  for (const candidate of await candidateProcesses(platform)) {
    if (/(?:^|\s)--type(?:=|\s)/u.test(candidate.command)) continue;
    const profileArgument = flagValue(candidate.command, 'user-data-dir');
    if (!profileArgument) continue;
    try {
      const image = await realpath(candidate.exe);
      if (key(await realpath(profileArgument), platform) !== key(profile, platform) || !allowed.has(key(image, platform))) continue;
      matches.push({ pid: Number(candidate.pid), owner: candidate.owner, executable: image, profileDir: profile, debug: /(?:^|\s)--remote-debugging(?:[=\s-]|$)/u.test(candidate.command) });
    } catch { /* Inaccessible images or profiles never establish ownership. */ }
  }
  return matches;
}

async function descriptor(profile, platform) {
  const file = path.join(profile, descriptorName);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('Unsafe session record');
    const record = JSON.parse(await readFile(file, 'utf8'));
    const ownerValid = platform === 'win32' ? typeof record.owner === 'string' && /^S-\d(?:-\d+)+$/u.test(record.owner) : Number.isInteger(record.owner) && record.owner >= 0;
    if (record.schema !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record.marker ?? '') || !Number.isInteger(record.pid) || record.pid < 1 || !ownerValid || typeof record.executable !== 'string' || !path.isAbsolute(record.executable) || key(record.profileDir ?? '', platform) !== key(profile, platform)) throw new Error('Invalid session record');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw runtimeError('BROWSER_SESSION_UNVERIFIED', '普通 Chrome 会话记录无法验证，未接管或关闭现有浏览器');
  }
}

async function saveDescriptor(profile, processInfo, previous) {
  const { debug, ...session } = processInfo;
  const record = { schema: 1, ...session, marker: previous?.marker ?? randomUUID(), updatedAt: new Date().toISOString() };
  const temporary = path.join(profile, `${descriptorName}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path.join(profile, descriptorName));
  if (process.platform !== 'win32') await chmod(path.join(profile, descriptorName), 0o600);
  return record;
}

async function rejectDefaultProfile(profile, discovery) {
  const defaults = discovery.platform === 'darwin' ? [path.join(discovery.homeDir, 'Library/Application Support/Google/Chrome')]
    : discovery.platform === 'win32' ? [path.win32.join(discovery.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')]
      : [path.join(discovery.homeDir, '.config/google-chrome'), path.join(discovery.env.XDG_CONFIG_HOME ?? path.join(discovery.homeDir, '.config'), 'google-chrome')];
  for (const candidate of defaults) {
    try {
      if (key(await realpath(candidate), discovery.platform) === key(profile, discovery.platform)) throw runtimeError('BROWSER_SESSION_UNVERIFIED', '本程序不能接管日常 Chrome 配置目录，请使用独立专用目录');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function destinationFor(initialUrl) {
  try {
    const url = new URL(initialUrl);
    if (url.protocol === 'chrome:' && url.hostname === 'extensions' && ['', '/'].includes(url.pathname) && !url.search && !url.hash && !url.username && !url.password) return 'chrome://extensions/';
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported destination');
    return url.href;
  } catch { throw runtimeError('BROWSER_START_FAILED', 'Chrome 初始页面地址无效，请使用网页地址或扩展设置页'); }
}

async function waitForExit(child, timeout) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
    const timer = setTimeout(finish, timeout);
    child.once('exit', finish);
  });
}

async function waitForPidExit(pid, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await wait(50);
  }
}

/** Starts an ordinary dedicated Chrome without any browser debugging connection. */
export class NormalChromeRuntime {
  constructor({ platform = process.platform, env = process.env, homeDir = os.homedir(), timeoutMs = 12000 } = {}) {
    this.discovery = { platform, env, homeDir };
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.session = null;
    this.profileDir = null;
  }

  async recover(profile, executable, settling = false) {
    const previous = await descriptor(profile, this.discovery.platform);
    const matches = await profileProcesses(profile, executable, this.discovery.platform);
    if (matches.length > 1) {
      // A newly spawned singleton launcher can briefly overlap its primary.
      // Wait for one verified process; existing ambiguous sessions still fail.
      if (settling) return false;
      throw runtimeError('BROWSER_SESSION_UNVERIFIED', '存在多个相同配置目录的 Chrome 进程，未选择或关闭任何浏览器');
    }
    if (!matches.length) return false;
    const current = matches[0];
    if (current.debug) throw runtimeError('BROWSER_MODE_CONFLICT', '此专用 Chrome 仍处于旧版调试模式，请先关闭该专用窗口，再打开普通浏览器');
    if (previous) {
      let previousImage;
      try { previousImage = await realpath(previous.executable); }
      catch { throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 会话安装路径无法验证，未接管现有浏览器'); }
      if (previous.owner !== current.owner || key(previousImage, this.discovery.platform) !== key(current.executable, this.discovery.platform)) throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 会话所有者或安装路径不一致，未接管现有浏览器');
    }
    const saved = await saveDescriptor(profile, current, previous);
    if (this.child && (this.child.pid !== current.pid || this.child.exitCode !== null || this.child.signalCode !== null)) this.child = null;
    this.session = saved;
    this.profileDir = profile;
    return true;
  }

  async openSetup(executable, profile) {
    const child = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', 'chrome://extensions/'], { stdio: 'ignore', windowsHide: false });
    child.once('error', () => {});
    await waitForExit(child, 1500);
  }

  async launch(profileDir, { checkpoint = async () => {}, initialUrl = 'https://www.zhipin.com/web/user/', setup = false } = {}) {
    const destination = destinationFor(initialUrl);
    await mkdir(path.resolve(profileDir), { recursive: true, mode: 0o700 });
    const profile = await realpath(path.resolve(profileDir));
    await rejectDefaultProfile(profile, this.discovery);
    await descriptor(profile, this.discovery.platform);
    if (this.session && this.profileDir !== profile) throw runtimeError('BROWSER_START_FAILED', '专用 Chrome 已使用另一个配置目录，请先停止后重试');
    const executable = await findChromeExecutable(this.discovery);
    if (!executable) throw runtimeError('BROWSER_NOT_FOUND', '未找到 Google Chrome，请从 https://www.google.com/chrome/ 安装后重新打开本程序');
    await checkpoint();
    if (await this.recover(profile, executable)) {
      if (setup) { await checkpoint(); await this.openSetup(executable, profile); }
      return this;
    }
    await this.close();
    await checkpoint();
    const child = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', destination, ...(setup ? ['chrome://extensions/'] : [])], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    this.child = child;
    this.profileDir = profile;
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    child.stderr.on('data', () => {});
    try {
      const end = Date.now() + this.timeoutMs;
      const settleAt = Date.now() + 300;
      while (Date.now() < end) {
        await checkpoint();
        if (spawnError) throw runtimeError('BROWSER_START_FAILED', 'Google Chrome 启动失败，请检查 Chrome 安装');
        // ProcessSingleton may make a launcher exit zero while another verified
        // primary adopts the profile. Prefer the primary snapshot to exitCode.
        if (Date.now() >= settleAt && await this.recover(profile, executable, true)) return this;
        if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) throw runtimeError('BROWSER_START_FAILED', 'Google Chrome 启动失败，请检查专用配置目录及 Chrome 安装');
        await wait(100);
      }
      throw runtimeError('BROWSER_START_FAILED', '普通 Chrome 专用窗口未准备好，请关闭该专用窗口后重试');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const child = this.child;
    const session = this.session;
    this.child = null;
    this.session = null;
    this.profileDir = null;
    if (child) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await waitForExit(child, 2500);
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await waitForExit(child, 1000);
      return;
    }
    if (!session) return;
    try {
      const saved = await descriptor(session.profileDir, this.discovery.platform);
      const matches = await profileProcesses(session.profileDir, session.executable, this.discovery.platform);
      const current = matches[0];
      if (saved?.marker === session.marker && saved.pid === session.pid && saved.owner === session.owner && key(saved.executable, this.discovery.platform) === key(session.executable, this.discovery.platform) && matches.length === 1 && !current.debug && current.pid === session.pid && current.owner === session.owner && key(current.executable, this.discovery.platform) === key(session.executable, this.discovery.platform)) {
        process.kill(session.pid, 'SIGTERM');
        await waitForPidExit(session.pid, 2500);
      }
    } catch { /* A recovered process is never terminated without fresh ownership proof. */ }
  }
}
