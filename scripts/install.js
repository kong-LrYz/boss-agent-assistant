import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checksums = await readFile(new URL('./install-node-checksums.txt', import.meta.url), 'utf8');

export function runtimeTarget(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`不支持自动安装 Node：${platform}/${arch}，请从 https://nodejs.org/ 安装 Node.js 22 或更新版。`);
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const file = `node-v22.23.3-${platform === 'win32' ? 'win' : platform}-${arch}.${extension}`;
  const match = checksums.split(/\r?\n/u).map(line => line.trim().split(/\s+/u)).filter(([hash, name]) => name === file && /^[a-f0-9]{64}$/u.test(hash));
  if (match.length !== 1) throw new Error('Node 下载校验记录缺失或不唯一，请重新下载项目源码。');
  return { file, extension, sha256: match[0][0], url: `https://nodejs.org/dist/v22.23.3/${file}` };
}

export function npmCliCandidates(nodePath, env = process.env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const folder = p.dirname(nodePath);
  return [...new Set([
    p.join(folder, 'node_modules/npm/bin/npm-cli.js'),
    p.resolve(folder, '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(platform === 'win32' ? [] : ['/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/share/npm/bin/npm-cli.js']),
    ...(env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(item => p.join(item, platform === 'win32' ? 'npm.cmd' : 'npm')),
  ])];
}

async function findNpmCli(nodePath, env) {
  for (const candidate of npmCliCandidates(nodePath, env)) {
    try {
      const resolved = await realpath(candidate);
      if (path.basename(resolved) === 'npm-cli.js' && (await lstat(resolved)).isFile()) return resolved;
    } catch { /* Continue documented system/portable layouts. */ }
  }
  throw new Error('当前 Node.js 不包含 npm，请重新运行安装入口，或从 https://nodejs.org/ 安装完整版本。');
}

async function plainDirectory(folder, { create = false } = {}) {
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path.basename(folder)} 必须是普通目录，不能是符号链接。`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (create) await mkdir(folder, { mode: 0o700 });
  }
}
async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path.basename(file)} 必须是普通文件。`);
  return readFile(file);
}

export function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: 'inherit', windowsHide: false, shell: false });
    const timer = options.timeout ? setTimeout(() => { child.kill(); reject(new Error('安装超时，请检查网络后重新启动。')); }, options.timeout) : null;
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `进程已结束：${signal}` : `进程退出码 ${code}，请查看上方错误。`));
    });
  });
}

export async function prepareProject({ root = projectRoot, nodePath = process.execPath, npmCli, env = process.env, run = runProcess, log = () => {} } = {}) {
  root = path.resolve(root);
  const runtime = path.join(root, '.runtime');
  await plainDirectory(runtime, { create: true });
  await plainDirectory(path.join(root, 'node_modules'));
  const [manifestBytes, lockBytes] = await Promise.all([regularFile(path.join(root, 'package.json')), regularFile(path.join(root, 'package-lock.json'))]);
  const manifest = JSON.parse(manifestBytes), lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(lock.packages?.['']?.dependencies ?? {})) throw new Error('package.json 与 package-lock.json 的锁定依赖不一致，请重新下载完整源码。');
  const fingerprint = sha(Buffer.concat([manifestBytes, Buffer.from('\0'), lockBytes]));
  async function complete() {
    for (const [name, locked] of Object.entries(lock.packages)) {
      if (!name || locked.dev || locked.optional) continue;
      if (!/^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/iu.test(name)) throw new Error('锁定依赖路径无效。');
      try {
        const item = JSON.parse(await regularFile(path.join(root, name, 'package.json')));
        if (item.version !== locked.version) return false;
      } catch { return false; }
    }
    return true;
  }
  const marker = path.join(runtime, 'dependencies.json');
  let previous;
  try { previous = JSON.parse(await regularFile(marker)); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (previous?.schema === 1 && previous.fingerprint === fingerprint && await complete()) return { installed: false };
  const selectedNpm = npmCli ?? await findNpmCli(nodePath, env);
  const installLock = path.join(runtime, 'dependencies-install.lock');
  try { await mkdir(installLock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('依赖安装正在进行，请等待当前安装完成后重新启动；若安装被强制结束，请检查 .runtime/dependencies-install.lock。');
    throw error;
  }
  try {
    log('首次启动或依赖更新：安装锁定的程序依赖…');
    await run(nodePath, [selectedNpm, 'ci', '--no-audit', '--no-fund'], { cwd: root, env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, timeout: 180_000 });
    if (!(await complete())) throw new Error('安装返回成功，但程序依赖不完整，请重新启动重试。');
    const temporary = path.join(runtime, `.dependencies-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ schema: 1, fingerprint }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, marker);
    } finally { await rm(temporary, { force: true }); }
  } finally { await rmdir(installLock); }
  return { installed: true };
}

async function main(args) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版，请运行安装入口。');
  await prepareProject({ log: console.log });
  const { findChromeExecutable } = await import('../src/chrome-runtime.js');
  const chrome = await findChromeExecutable();
  if (!chrome) {
    console.error('未找到 Google Chrome。请从 https://www.google.com/chrome/ 安装，再运行启动入口。');
    console.error('自定义位置可通过 BOSS_CHROME_PATH 指定。Linux ARM64 没有 Google Chrome 官方桌面包，请使用受支持的桌面系统。');
    if (args.includes('--open-chrome-download')) {
      const command = process.platform === 'darwin' ? ['open', ['https://www.google.com/chrome/']] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', 'https://www.google.com/chrome/']] : ['xdg-open', ['https://www.google.com/chrome/']];
      await runProcess(command[0], command[1], { timeout: 5000 }).catch(() => {});
    }
    if (args.includes('--install-only')) return;
    throw new Error('安装 Chrome 后重新运行即可，已安装的依赖会保留。');
  }
  if (args.includes('--install-only')) { console.log('依赖已就绪。运行启动入口即可打开控制台，首次需安装扩展并本人扫码。'); return; }
  await runProcess(process.execPath, [path.join(projectRoot, 'src/main.js'), ...args.filter(item => item !== '--open-chrome-download')], { cwd: projectRoot, env: process.env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`启动未完成：${error.message}`); process.exitCode = 1; });
}
