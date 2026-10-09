import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { validateConfig, roleSearchDefaults, CITY_CODES } from './core.js';
import { CHOICE_CATALOGS } from './catalogs.js';
import { findJobPreset } from './job-presets.js';

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
export function createServer({ store, runner, token, publicDir, extensionBridge = null, setupExtension = async () => {}, inspectPage = null, timingSnapshot = null, heartbeat = () => {}, shutdown = async () => {}, leaseClosed = () => {}, leaseGraceMs = 2000 }) {
  let leases = 0, leaseTimer, leaseStopRequired = false;
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = req.headers.host;
    const port = req.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(res, 403, { error: '只接受本地控制台请求' });
    const url = new URL(req.url, `http://${host}`);
    try {
      if(extensionBridge && await extensionBridge.handle(req,res,url))return;
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '拒绝跨站请求' });
      if (req.method === 'POST') {
        const supplied = Buffer.from(String(req.headers['x-boss-token'] || ''));
        const expected = Buffer.from(token);
        if (req.headers.origin !== `http://${host}` || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 403, { error: '本地会话校验失败，请刷新控制台' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
        let raw = '';
        for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > 65_536) { res.writeHead(413); res.end(); return; } }
        const body = raw ? JSON.parse(raw) : {};
        if (url.pathname === '/api/inspect') {
          if (url.search || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error('只读页面诊断仅接受空对象，不接受操作、选择器或脚本参数');
          if (typeof inspectPage !== 'function') return json(res, 501, { error: '当前会话未启用只读页面诊断' });
          return json(res, 200, await inspectPage());
        } else if (url.pathname === '/api/config') {
          if (runner.task) return json(res, 409, { error: '请先停止运行，再修改设置' });
          const previous=store.loadConfig(),patch={...body};
          if(Object.hasOwn(body,'targetRole')){
            const preset=roleSearchDefaults(body.targetRole);
            if(body.targetRole.trim()!==previous.targetRole){
              if(!Object.hasOwn(body,'queries'))patch.queries=preset.queries;
              if(!Object.hasOwn(body,'requiredAny'))patch.requiredAny=preset.requiredAny;
            }
          }
          store.saveConfig(validateConfig({ ...previous, ...patch, setupComplete: true }));
        } else if (url.pathname === '/api/start') {
          runner.start({ preview: body.preview === true });
        } else if (url.pathname === '/api/verify-greetings') {
          if (url.search || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['keys', 'greeting', 'preview'].includes(key)) || !Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 5 || body.keys.some(key => typeof key !== 'string' || !/^job:[A-Za-z0-9_-]+$/u.test(key)) || new Set(body.keys).size !== body.keys.length || typeof body.greeting !== 'string' || !body.greeting.trim() || body.greeting.length > 500 || body.greeting.includes('\0') || (Object.hasOwn(body, 'preview') && typeof body.preview !== 'boolean')) throw new Error('招呼实测只接受 1 到 5 个不同岗位记录、招呼文本和布尔预览选项');
          if (runner.task) return json(res, 409, { error: '请先停止运行，再执行指定岗位招呼实测' });
          for (const key of body.keys) {
            const record = store.getJob(key);
            if (!record) return json(res, 404, { error: '找不到指定岗位记录' });
            if (record.greetingStatus !== 'none' || record.resumeStatus !== 'none' || (body.preview === false && record.eligible !== true)) throw new Error('招呼实测只接受未沟通、未操作附件的岗位；发送前需先刷新筛选结果');
          }
          runner.start({ greetingJobKeys: [...body.keys], greetingTestText: body.greeting, greetingTestPreview: body.preview !== false });
        } else if (url.pathname === '/api/verify-resume') {
          if (url.search || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['key', 'inspectOnly'].includes(key)) || !Object.hasOwn(body, 'key') || typeof body.key !== 'string' || !body.key.trim() || (Object.hasOwn(body, 'inspectOnly') && typeof body.inspectOnly !== 'boolean')) throw new Error('单岗附件验收仅接受岗位记录 key 和只读 inspectOnly，不接受 URL、选择器或重复运行参数');
          if (runner.task) return json(res, 409, { error: '请先停止运行，再验收单个岗位附件' });
          const record = store.getJob(body.key);
          if (!record) return json(res, 404, { error: '找不到岗位记录' });
          const allowedResume = body.inspectOnly === true ? ['none', 'requested', 'unavailable', 'sent', 'uncertain', 'intent'] : ['none', 'requested', 'unavailable'];
          if (record.eligible !== true || !['sent', 'existing'].includes(record.greetingStatus) || !allowedResume.includes(record.resumeStatus)) throw new Error('仅能验收符合筛选、已沟通且附件结果可处理的岗位；未确认或已发送的附件不会重发');
          runner.start({ resumeJobKey: body.key, once: true, inspectResumeOnly: body.inspectOnly === true });
        } else if (url.pathname === '/api/login') {
          await runner.prepareLogin();
        } else if (url.pathname === '/api/extension-setup') {
          await setupExtension();
        } else if (url.pathname === '/api/pause') runner.pause('你已暂停，点击继续后恢复');
        else if (url.pathname === '/api/resume') runner.resume();
        else if (url.pathname === '/api/stop') await runner.stop();
        else if (url.pathname === '/api/heartbeat') heartbeat();
        else if (url.pathname === '/api/shutdown') { json(res, 200, { ok: true }); setImmediate(shutdown); return; }
        else if (url.pathname === '/api/reconcile') {
          if (runner.task) return json(res, 409, { error: '请先停止运行，再核对结果' });
          const record = store.getJob(body.key);
          if (!record) return json(res, 404, { error: '找不到岗位记录' });
          const allowedGreeting = ['none', 'sent', 'existing'];
          const allowedResume = ['none', 'requested', 'sent', 'unavailable'];
          if (!allowedGreeting.includes(body.greetingStatus) || !allowedResume.includes(body.resumeStatus)) throw new Error('无效的核对状态');
          store.upsertJob(record, { greetingStatus: body.greetingStatus, resumeStatus: body.resumeStatus, note: '用户在 BOSS 聊天记录核对后手动标记', lastResumeCheckAt: new Date().toISOString() });
          store.appendEvent({ type: 'reconciled', message: `${record.title}：用户核对了发送状态`, key: body.key });
        } else return json(res, 404, { error: '未知操作' });
        return json(res, 200, { ok: true });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '请求方法不支持' });
      if (url.pathname === '/api/lease') {
        if (url.searchParams.get('token') !== token) return json(res, 403, { error: '本地会话校验失败' });
        // A lone page may refresh within the grace period. With another page
        // still connected, closing a dashboard requires a stop regardless of
        // later heartbeats or reconnects from the remaining pages.
        if (!leaseStopRequired) { clearTimeout(leaseTimer); leaseTimer = undefined; }
        leases++;
        heartbeat();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
        res.write('data: connected\n\n');
        const tick = setInterval(() => { res.write(': alive\n\n'); heartbeat(); }, 10_000);
        tick.unref();
        res.on('close', () => {
          clearInterval(tick);
          leases--;
          if (leases > 0) leaseStopRequired = true;
          if (!leaseTimer) {
            leaseTimer = setTimeout(() => {
              leaseTimer = undefined;
              leaseStopRequired = false;
              leaseClosed();
            }, leaseGraceMs);
            leaseTimer.unref();
          }
        });
        return;
      }
      if (url.pathname === '/api/status') return json(res, 200, { runner: runner.snapshot(), config: store.loadConfig(), cities:CITY_CODES, catalogs:CHOICE_CATALOGS, jobs: store.listJobs(), events: store.listEvents(100), extension:extensionBridge?{...extensionBridge.snapshot(),directory:resolve(publicDir,'..','extension')}:null });
      if (url.pathname === '/api/timings') {
        if (url.search) throw new Error('运行计时只接受固定只读请求');
        return json(res, 200, typeof timingSnapshot === 'function' ? timingSnapshot() : null);
      }
      if (url.pathname === '/api/role-defaults') {
        const role=url.searchParams.get('role')??'AI Agent',defaults=roleSearchDefaults(role);
        return json(res,200,{...defaults,allowExcludedKeywords:[...(findJobPreset(role)?.allowExcludedKeywords||[])]});
      }
      if (url.pathname === '/api/export') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="boss-applications.csv"' });
        return res.end(store.exportCsv());
      }
      const filename = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const fullPath = resolve(publicDir, filename);
      if (!fullPath.startsWith(resolve(publicDir) + sep)) return json(res, 403, { error: '路径不允许' });
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[extname(fullPath)];
      if (!mime) return json(res, 404, { error: '文件不存在' });
      let file = await readFile(fullPath);
      if (filename === 'index.html') file = Buffer.from(file.toString().replace('__SESSION_TOKEN__', token));
      res.writeHead(200, { 'Content-Type': mime });
      res.end(file);
    } catch (error) { json(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message }); }
  });
}
