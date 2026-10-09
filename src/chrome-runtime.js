import { chromium } from 'playwright';
import { access, mkdir, stat, realpath, readFile, writeFile, rename, lstat, chmod, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const runFile = promisify(execFile);
const descriptorName = '.boss-chrome-session.json';
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function flagValue(command, name) {
  const matches = [...command.matchAll(new RegExp(`(?:^|\\s)--${name}=(?:"([^"]*)"|'([^']*)'|(.+?))(?=\\s--[A-Za-z]|\\s(?:https?:|about:)|$)`, 'gu'))];
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
  const owner = process.getuid();
  const rows = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match || Number(match[2]) !== owner || !match[3].includes('--remote-debugging-port=') || !match[3].includes('--user-data-dir=')) return [];
    return [{ pid: Number(match[1]), owner, command: match[3] }];
  });
  const result = [];
  for (const row of rows) {
    try {
      const image = platform === 'linux' ? await readlink(`/proc/${row.pid}/exe`) : (await runFile('ps', ['-p', String(row.pid), '-o', 'comm='], { timeout: 2000 })).stdout.trim();
      result.push({ ...row, exe: image });
    } catch { /* A process may exit between snapshots. */ }
  }
  return result;
}

async function profileProcesses(profile, executable, platform) {
  const installed = await realpath(executable);
  const allowed = new Set([pathKey(installed)]);
  if (platform === 'linux') {
    for (const candidate of [path.join(path.dirname(installed), 'chrome'), '/opt/google/chrome/chrome']) {
      try { allowed.add(pathKey(await realpath(candidate))); } catch { /* Optional vendor wrapper target. */ }
    }
  }
  const candidates = [];
  for (const processInfo of await candidateProcesses(platform)) {
    const command = processInfo.command;
    if (/(?:^|\s)--type(?:=|\s)/u.test(command)) continue;
    const argumentProfile = flagValue(command, 'user-data-dir');
    const address = flagValue(command, 'remote-debugging-address');
    const portText = flagValue(command, 'remote-debugging-port');
    if (!argumentProfile || address !== '127.0.0.1' || !/^\d{1,5}$/u.test(portText ?? '') || Number(portText) < 1 || Number(portText) > 65535) continue;
    try {
      if (pathKey(await realpath(argumentProfile)) !== pathKey(profile) || !allowed.has(pathKey(await realpath(processInfo.exe)))) continue;
      candidates.push({ pid: processInfo.pid, owner: processInfo.owner, executable: await realpath(processInfo.exe), profileDir: profile, port: Number(portText) });
    } catch { /* Never infer ownership from a missing or inaccessible image. */ }
  }
  return candidates;
}

async function descriptor(profile) {
  const file = path.join(profile, descriptorName);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 会话记录权限异常，未连接现有浏览器');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.schema !== 1 || typeof value.marker !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.marker) || pathKey(value.profileDir ?? '') !== pathKey(profile)) throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 会话记录与本程序配置目录不一致，未连接现有浏览器');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'BROWSER_SESSION_UNVERIFIED') throw error;
    throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 会话记录无法验证，未连接或关闭现有浏览器');
  }
}

async function saveDescriptor(profile, session, previous) {
  const value = { schema: 1, ...session, marker: previous?.marker ?? randomUUID(), updatedAt: new Date().toISOString() };
  const temporary = path.join(profile, `${descriptorName}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path.join(profile, descriptorName));
  if (process.platform !== 'win32') await chmod(path.join(profile, descriptorName), 0o600);
  return value;
}

async function endpointFor(session) {
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Endpoint unavailable');
    const version = await response.json();
    const endpoint = new URL(version.webSocketDebuggerUrl ?? '');
    if (!/^Chrome\//u.test(version.Browser ?? '') || endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== session.port || endpoint.username || endpoint.password || endpoint.search || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/u.test(endpoint.pathname)) throw new Error('Endpoint mismatch');
    return endpoint.href;
  } catch { throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 的本地控制端点无法验证，未连接现有浏览器'); }
}

async function rejectDefaultProfile(profile, discovery) {
  const defaults = discovery.platform === 'darwin' ? [path.join(discovery.homeDir, 'Library/Application Support/Google/Chrome')]
    : discovery.platform === 'win32' ? [path.win32.join(discovery.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')]
      : [path.join(discovery.homeDir, '.config/google-chrome'), path.join(discovery.env.XDG_CONFIG_HOME ?? path.join(discovery.homeDir, '.config'), 'google-chrome')];
  for (const candidate of defaults) {
    try { if (pathKey(await realpath(candidate)) === pathKey(profile)) throw runtimeError('BROWSER_SESSION_UNVERIFIED', '本程序不能接管日常 Chrome 配置目录，请使用独立专用目录'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Locate vendor-installed Google Chrome; no download or user-profile copying. */
export async function findChromeExecutable({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  let candidates;
  if (env.BOSS_CHROME_PATH) candidates = [path.resolve(env.BOSS_CHROME_PATH)];
  else if (platform === 'darwin') candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
  else if (platform === 'win32') candidates = [env.PROGRAMFILES, env.ProgramFiles, env['ProgramFiles(x86)'], env.PROGRAMW6432, env.LOCALAPPDATA]
    .filter(Boolean).map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  else candidates = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(root => [path.join(root, 'google-chrome'), path.join(root, 'google-chrome-stable')]),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, constants.X_OK); return candidate; } catch { /* Continue standard locations. */ }
  }
  return null;
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.recoverable = true;
  return error;
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForExit(child, milliseconds) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    child.once('exit', finish);
  });
}

async function waitForPidExit(pid, milliseconds) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** Owns only the Chrome child it starts and its localhost DevTools connection. */
export class ChromeRuntime {
  constructor({ platform = process.platform, env = process.env, homeDir = os.homedir(), timeoutMs = 12000 } = {}) {
    this.discovery = { platform, env, homeDir };
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.browser = null;
    this.context = null;
    this.endpoint = null;
    this.profileDir = null;
    this.launchedAt = 0;
    this.session = null;
  }

  async recover(profile, executable) {
    const previous = await descriptor(profile);
    const matches = await profileProcesses(profile, executable, this.discovery.platform);
    if (matches.length > 1) throw runtimeError('BROWSER_SESSION_UNVERIFIED', '存在多个相同配置目录的 Chrome 进程，未选择或关闭任何浏览器');
    if (!matches.length) return false;
    const current = matches[0];
    if (previous && previous.owner !== current.owner) throw runtimeError('BROWSER_SESSION_UNVERIFIED', 'Chrome 会话所有者不一致，未连接现有浏览器');
    const endpoint = await endpointFor(current);
    const saved = await saveDescriptor(profile, current, previous);
    if (this.child && (this.child.pid !== current.pid || this.child.exitCode !== null || this.child.signalCode !== null)) this.child = null;
    this.session = saved;
    this.profileDir = profile;
    this.endpoint = endpoint;
    this.launchedAt = this.launchedAt || Date.now() - 10000;
    return true;
  }

  async launch(profileDir, { checkpoint = async () => {}, initialUrl = 'about:blank' } = {}) {
    await mkdir(path.resolve(profileDir), { recursive: true, mode: 0o700 });
    const profile = await realpath(path.resolve(profileDir));
    await rejectDefaultProfile(profile, this.discovery);
    if (this.child?.exitCode === null && this.child?.signalCode === null && this.endpoint && this.session?.pid === this.child.pid) {
      if (this.profileDir !== profile) throw runtimeError('BROWSER_START_FAILED', '专用 Chrome 已使用另一个配置目录，请先停止后重试');
      return this;
    }
    const executable = await findChromeExecutable(this.discovery);
    if (!executable) throw runtimeError('BROWSER_NOT_FOUND', '未找到 Google Chrome，请从 https://www.google.com/chrome/ 安装后重新打开本程序');
    await checkpoint();
    // Recover an updated/re-executed or previously launched project Chrome
    // before spawning; ProcessSingleton must not create another login tab.
    if (await this.recover(profile, executable)) return this;
    await this.close();
    const port = await unusedLoopbackPort();
    const destination = new URL(initialUrl);
    if (initialUrl !== 'about:blank' && !['http:', 'https:'].includes(destination.protocol)) throw runtimeError('BROWSER_START_FAILED', 'Chrome 初始页面地址无效');
    await checkpoint();
    const child = spawn(executable, [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1', '--no-first-run', destination.href,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    this.child = child;
    this.profileDir = profile;
    this.launchedAt = Date.now();
    let output = '';
    let advertisedEndpoint = null;
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    child.stderr.on('data', chunk => {
      output = (output + chunk.toString()).slice(-65536);
      for (const match of output.matchAll(/DevTools listening on (ws:\/\/[^\s]+)/gu)) {
        try {
          const endpoint = new URL(match[1]);
          if (endpoint.hostname === '127.0.0.1' && Number(endpoint.port) === port && endpoint.pathname.startsWith('/devtools/browser/')) advertisedEndpoint = endpoint.href;
        } catch { /* Only this child's verified loopback announcement is accepted. */ }
      }
    });
    try {
      const end = Date.now() + this.timeoutMs;
      while (!advertisedEndpoint) {
        await checkpoint();
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw runtimeError('BROWSER_START_FAILED', 'Google Chrome 启动失败；请关闭本程序专用浏览器后重试，或检查 Chrome 安装');
        if (Date.now() >= end) throw runtimeError('BROWSER_START_FAILED', 'Google Chrome 专用窗口未准备好；请关闭该专用窗口后重试');
        await checkpoint();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Listening is only lifecycle metadata; launch never connects a client.
      this.endpoint = advertisedEndpoint;
      if (!await this.recover(profile, executable)) throw runtimeError('BROWSER_SESSION_UNVERIFIED', '新 Chrome 进程无法核对专用配置目录，未连接');
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async start(profileDir, { checkpoint = async () => {}, initialUrl = 'about:blank', startupDelayMs = initialUrl === 'about:blank' ? 0 : 8000 } = {}) {
    if (this.browser?.isConnected() && this.session) return this;
    await this.launch(profileDir, { checkpoint, initialUrl });
    const child = this.child;
    try {
      // Preserve the same manual-login process and profile. Normal page scripts
      // have run since launch; attach does not refresh or relaunch the page.
      const attachAt = this.launchedAt + Math.max(0, Math.min(10000, Number(startupDelayMs) || 0));
      while (Date.now() < attachAt) {
        await checkpoint();
        if (child && (child.exitCode !== null || child.signalCode !== null)) throw runtimeError('BROWSER_START_FAILED', 'Google Chrome 在初始页面加载时关闭，请重新打开');
        await checkpoint();
        await new Promise(resolve => setTimeout(resolve, Math.min(100, attachAt - Date.now())));
      }
      await checkpoint();
      this.browser = await chromium.connectOverCDP(this.endpoint, { timeout: this.timeoutMs, noDefaults: true });
      this.context = this.browser.contexts()[0];
      if (!this.context) throw runtimeError('BROWSER_START_FAILED', 'Google Chrome 专用会话不可用，请重新打开');
      return this;
    } catch (error) {
      await this.close();
      if (!error.code && /closed|disconnected|connect|timeout/iu.test(error.message)) {
        error.code = 'BROWSER_START_FAILED';
        error.recoverable = true;
        error.message = 'Google Chrome 专用会话连接失败，请重新打开本程序';
      }
      throw error;
    }
  }

  async detach() {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    // Playwright's connected-browser close disconnects the CDP client. The
    // owned native process stays alive until close() explicitly reaps it.
    if (browser) await browser.close().catch(() => {});
  }

  async close() {
    const child = this.child;
    const session = this.session;
    this.child = null;
    this.endpoint = null;
    this.profileDir = null;
    this.launchedAt = 0;
    this.session = null;
    await this.detach();
    if (!child && session) {
      // A recovered process is signalled only after rechecking the private
      // marker and the current same-user/executable/profile/port tuple.
      try {
        const saved = await descriptor(session.profileDir);
        const matches = await profileProcesses(session.profileDir, session.executable, this.discovery.platform);
        if (saved?.marker === session.marker && matches.length === 1 && matches[0].pid === session.pid && matches[0].port === session.port && matches[0].owner === session.owner) {
          process.kill(session.pid, 'SIGTERM');
          await waitForPidExit(session.pid, 2000);
        }
      } catch { /* Never terminate an unverified or already exited process. */ }
      return;
    }
    if (!child) return;
    await waitForExit(child, 1000);
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitForExit(child, 2000);
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child, 1000);
  }
}
