import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.js';
import { ExtensionBridge } from './extension-bridge.js';
import { ExtensionBrowser } from './extension-browser.js';
import { Runner } from './runner.js';
import { createServer } from './server.js';
import { installConsoleLogger, pruneDiagnostics } from './logging.js';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(process.env.BOSS_DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockPath = join(dataDir, 'instance.json');
const args = process.argv.slice(2);
const sessionToken = randomBytes(32).toString('hex');
function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore' });
  child.on('error', () => console.log(`请手动打开 ${url}`));
  child.unref();
}
async function acquireLock() {
  try { const fd = openSync(lockPath, 'wx', 0o600); closeSync(fd); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); }
    catch { throw new Error('程序锁尚未写完或损坏，请稍后重试；不要并行启动两个程序'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('程序锁的进程标识无效，请检查是否仍有原程序运行');
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      unlinkSync(lockPath);
      const fd = openSync(lockPath, 'wx', 0o600); closeSync(fd);
      return;
    }
    console.log(`程序已在运行：${owner.url || '正在启动'}`);
    const localUrl = /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(owner.url || '') ? owner.url : null;
    if (localUrl && owner.token && !args.includes('--no-autorun')) {
      try {
        const state = await (await fetch(`${localUrl}/api/status`)).json();
        if (state.config.setupComplete && state.config.autoRun && ['idle','stopped','completed','error'].includes(state.runner.status)) {
          const response=await fetch(`${localUrl}/api/start`,{method:'POST',headers:{Origin:localUrl,'Content-Type':'application/json','x-boss-token':owner.token},body:'{}'});
          if(!response.ok)throw new Error((await response.json()).error);
          console.log('已恢复持续投递。');
        }
      } catch (error) { console.log(`请在已有控制台点击开始：${error.message}`); }
    }
    if (localUrl && !args.includes('--no-open')) openUrl(localUrl);
    process.exit(0);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
}
await acquireLock();
installConsoleLogger(dataDir);
pruneDiagnostics(join(root, 'output/playwright'));
let server, runner, browser, shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(watchdog);
  console.log('\n停止投递，正在关闭专用浏览器…');
  await runner?.stop();
  await browser?.shutdown();
  if (server) { server.close(); server.closeAllConnections(); }
  try { unlinkSync(lockPath); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', () => { try { const owner = JSON.parse(readFileSync(lockPath, 'utf8')); if (owner.pid === process.pid) unlinkSync(lockPath); } catch {} });
let lastHeartbeat = Date.now(), dashboardSeen = false;
const watchdog = setInterval(() => {
  const timeout = dashboardSeen ? 20_000 : 120_000;
  if (Date.now() - lastHeartbeat > timeout && runner?.task) {
    console.log('控制台连接已关闭，停止投递。');
    runner.stop().catch(error => console.error(error.message));
    lastHeartbeat = Date.now();
  }
}, 1000);
try {
  const store = new Store(dataDir);
  const extensionBridge = new ExtensionBridge({dataDir,canExecute:()=>runner?.state.status==='running'});
  browser = new ExtensionBrowser({
    bridge:extensionBridge,
    profileDir: join(dataDir, 'chrome-profile'), outputDir: join(root, 'output/playwright'),
    checkpoint: () => runner.checkpoint(),
    onEvent: event => store.appendEvent(typeof event === 'string' ? { type: 'browser', message: event } : event)
  });
  runner = new Runner({ store, browser });
  extensionBridge.on('connected',()=>{
    runner.log('extension_connected','Chrome 扩展已连接本地服务');
    if(runner.state.status==='paused'&&['EXTENSION_REQUIRED','EXTENSION_OFFLINE'].includes(runner.state.lastError?.code)&&runner.snapshot().counts.uncertain===0)runner.resume();
  });
  server = createServer({ store, runner, token: sessionToken, publicDir: join(root, 'public'),
    extensionBridge,
    setupExtension:()=>runner.prepareExtensionSetup(),
    inspectPage:()=>extensionBridge.request('INSPECT_PAGE',{}),
    timingSnapshot:()=>browser.timingSummary(),
    heartbeat: () => { lastHeartbeat = Date.now(); dashboardSeen = true; }, shutdown,
    leaseClosed: () => {
      try { if (runner.task || runner.loginTask || browser.context) runner.log('dashboard_closed','控制台连接已关闭，停止投递任务'); } catch {}
      runner.stop().catch(error => console.error(error.message));
    }
  });
  const portArg = args.find(a => a.startsWith('--port='));
  const port = Number(portArg?.split('=')[1] || process.env.BOSS_PORT || 17321);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效的端口');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, url, token:sessionToken, startedAt: new Date().toISOString() }), { mode: 0o600 });
  store.appendEvent({type:'service_start',message:`本地程序已启动，目标：${store.loadConfig().city} · ${store.loadConfig().targetRole||'AI Agent'}。此前日志保留为历史记录。`});
  const launchConfig=store.loadConfig();
  const targets=launchConfig.contactCompanyTarget||launchConfig.resumeCompanyTarget
    ? `公司目标：招呼 ${launchConfig.contactCompanyTarget||'不限'}，附件送达 ${launchConfig.resumeCompanyTarget||'不限'}；已启用目标都达到后停止。`
    : '未设置数量目标，持续运行到你停止。';
  console.log(`\nBOSS 岗位投递助手 · ${launchConfig.city} · ${launchConfig.targetRole||'AI Agent'}\n控制台：${url}\n${targets} Ctrl+C 或关闭终端退出。\n`);
  if (!args.includes('--no-open')) openUrl(url);
  if (store.loadConfig().setupComplete && store.loadConfig().autoRun && !args.includes('--no-autorun')) runner.start();
} catch (error) {
  console.error(`启动失败：${error.message}`);
  clearInterval(watchdog);
  try { unlinkSync(lockPath); } catch {}
  process.exitCode = 1;
  server?.close();
}
