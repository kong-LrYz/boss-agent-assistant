import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BossBrowser } from '../src/boss-browser.js';
import { ChromeRuntime, findChromeExecutable } from '../src/chrome-runtime.js';
import { chmod, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const job = {id:'a123',url:'https://www.zhipin.com/job_detail/a123.html',title:'AI Agent开发实习生',company:'示例科技',city:'北京'};
async function setup(t, mode = 'auto') {
  const dir=await mkdtemp(path.join(os.tmpdir(),'boss-browser-'));
  const browser=new BossBrowser({profileDir:path.join(dir,'profile'),outputDir:path.join(dir,'evidence'),selectors:{transport:'library',headless:true,timeoutMs:800,pollMs:30,navigationDelayMs:0},checkpoint:async()=>{}});
  await browser.open();
  const fixture=(await readFile(new URL('./fixtures/job.html',import.meta.url),'utf8')).replace('__MODE__',mode);
  const jobs=(await readFile(new URL('./fixtures/jobs.html',import.meta.url),'utf8')).replaceAll('__MODE__',mode);
  await browser.context.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('/job_detail/')?fixture:jobs}));
  t.after(async()=>{await browser.close();await rm(dir,{recursive:true,force:true});});
  return browser;
}
function stages(browser, output=[]) {return async(stage,patch)=>{output.push({stage,patch,state:await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')||'null'))});};}

test('Chrome discovery accepts an explicit executable override and rejects a missing one',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-chrome-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=path.join(dir,'Chrome app');await writeFile(binary,'test fixture');await chmod(binary,0o700);
 assert.equal(await findChromeExecutable({env:{BOSS_CHROME_PATH:binary}}),binary);
 assert.equal(await findChromeExecutable({env:{BOSS_CHROME_PATH:path.join(dir,'missing')}}),null);
 assert.equal(await findChromeExecutable({env:{BOSS_CHROME_PATH:dir}}),null);
});
test('missing production Chrome reports BROWSER_NOT_FOUND without silent library fallback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-chrome-missing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const runtime=new ChromeRuntime({env:{BOSS_CHROME_PATH:path.join(dir,'missing')}});
 await assert.rejects(runtime.start(path.join(dir,'profile')),error=>error.code==='BROWSER_NOT_FOUND'&&/Google Chrome/u.test(error.message));
 assert.equal(runtime.child,null);assert.equal(runtime.browser,null);
});
test('a failed native Chrome start reaps its owned child and never falls back',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-chrome-start-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const runtime=new ChromeRuntime({env:{BOSS_CHROME_PATH:process.execPath},timeoutMs:2000});
 await assert.rejects(runtime.start(path.join(dir,'profile')),error=>error.code==='BROWSER_START_FAILED');
 assert.equal(runtime.child,null);assert.equal(runtime.browser,null);
});
test('native Chrome local fixture uses a dedicated profile and reaps only its owned process',async t=>{
 if(process.env.CI&&!process.env.BOSS_NATIVE_SMOKE)return t.skip('optional native headed Chrome smoke in CI');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return t.skip('native headed Chrome needs a graphical session');
 if(!await findChromeExecutable())return t.skip('Google Chrome not installed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-chrome-local-'));const runtime=new ChromeRuntime();
 const server=createServer((request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end('<!doctype html><html><title>本地登录 fixture</title><body><h1>APP扫码登录</h1><input placeholder="手机号"></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await runtime.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await runtime.start(path.join(dir,'profile'));const child=runtime.child;
 assert.equal(new URL(runtime.endpoint).hostname,'127.0.0.1');assert.ok(child.pid>0);
 const page=runtime.context.pages()[0]??await runtime.context.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}/`);assert.equal(await page.locator('h1').innerText(),'APP扫码登录');
 await runtime.close();assert.equal(runtime.child,null);assert.ok(child.exitCode!==null||child.signalCode!==null);
});
test('production native BossBrowser loads its initial login before attach and does not refresh it',async t=>{
 if(process.env.CI&&!process.env.BOSS_NATIVE_SMOKE)return t.skip('optional native headed Chrome smoke in CI');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return t.skip('native headed Chrome needs a graphical session');
 if(!await findChromeExecutable())return t.skip('Google Chrome not installed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-native-initial-'));let requests=0;
 const server=createServer((request,response)=>{if(request.url==='/')requests++;response.setHeader('content-type','text/html;charset=utf-8');response.end('<!doctype html><html><title>本地账号页</title><body><nav class="user-nav"><span class="user-name">测试账号</span></nav></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/`;
 const browser=new BossBrowser({profileDir:path.join(dir,'profile'),outputDir:path.join(dir,'output'),selectors:{transport:'native',loginUrl:url,nativeStartupDelayMs:100,timeoutMs:800,pollMs:30},checkpoint:async()=>{}});
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await browser.open();assert.equal(browser.page.url(),url);
 assert.equal((await browser.login()).loggedIn,true);assert.equal(requests,1);
});
test('manual login launches without a protocol connection and later attaches to the same owned child',async t=>{
 if(process.env.CI&&!process.env.BOSS_NATIVE_SMOKE)return t.skip('optional native headed Chrome smoke in CI');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return t.skip('native headed Chrome needs a graphical session');
 if(!await findChromeExecutable())return t.skip('Google Chrome not installed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-native-handoff-'));let requests=0;let resolveLoaded;
 const loaded=new Promise(resolve=>{resolveLoaded=resolve;});
 const server=createServer((request,response)=>{if(request.url==='/'){requests++;resolveLoaded();}response.setHeader('content-type','text/html;charset=utf-8');response.end('<!doctype html><html><title>手动登录本地页</title><body><h1>请手动登录</h1></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/`;
 const browser=new BossBrowser({profileDir:path.join(dir,'profile'),outputDir:path.join(dir,'output'),selectors:{transport:'native',loginUrl:url,nativeStartupDelayMs:100,timeoutMs:800},checkpoint:async()=>{}});
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await browser.openForLogin();const child=browser.chromeRuntime.child;
 assert.equal(browser.context,null);assert.equal(browser.page,null);assert.equal(browser.chromeRuntime.browser,null);assert.equal(browser.chromeRuntime.context,null);
 assert.equal(child.exitCode,null);await loaded;
 await browser.open();assert.equal(browser.chromeRuntime.child,child);assert.equal(child.exitCode,null);
 assert.equal(await browser.page.title(),'手动登录本地页');assert.equal(requests,1);
 await browser.openForLogin();assert.equal(browser.chromeRuntime.child,child);assert.equal(browser.chromeRuntime.browser,null);assert.equal(browser.context,null);assert.equal(child.exitCode,null);
 await browser.open();assert.equal(await browser.page.title(),'手动登录本地页');assert.equal(requests,1);assert.equal(browser.chromeRuntime.child,child);
});
test('a fresh runtime recovers the same dedicated Chrome instead of a singleton launcher',async t=>{
 if(process.env.CI&&!process.env.BOSS_NATIVE_SMOKE)return t.skip('optional native headed Chrome smoke in CI');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return t.skip('native headed Chrome needs a graphical session');
 if(!await findChromeExecutable())return t.skip('Google Chrome not installed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-native-recover-'));const first=new ChromeRuntime();const second=new ChromeRuntime();let requests=0;
 const server=createServer((request,response)=>{if(request.url==='/')requests++;response.setHeader('content-type','text/html;charset=utf-8');response.end('<!doctype html><html><title>保留手动会话</title><body>本地已登录 fixture</body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;const profile=path.join(dir,'profile');
 t.after(async()=>{await second.close();await first.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await first.launch(profile,{initialUrl:url});const child=first.child;
 await unlink(path.join(profile,'.boss-chrome-session.json'));
 await second.start(profile,{initialUrl:url,startupDelayMs:100});
 assert.equal(second.session.pid,child.pid);assert.equal(child.exitCode,null);
 assert.equal(await second.context.pages()[0].title(),'保留手动会话');assert.equal(requests,1);
 if(process.platform!=='win32')assert.equal((await stat(path.join(profile,'.boss-chrome-session.json'))).mode&0o777,0o600);
});
test('stale child ownership after re-exec is recovered from the exact profile process',async t=>{
 if(process.env.CI&&!process.env.BOSS_NATIVE_SMOKE)return t.skip('optional native headed Chrome smoke in CI');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return t.skip('native headed Chrome needs a graphical session');
 if(!await findChromeExecutable())return t.skip('Google Chrome not installed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-native-reexec-'));const runtime=new ChromeRuntime();const profile=path.join(dir,'profile');let child;
 t.after(async()=>{await runtime.close();if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await rm(dir,{recursive:true,force:true});});
 await runtime.launch(profile);child=runtime.child;
 const descriptor=JSON.parse(await readFile(path.join(profile,'.boss-chrome-session.json'),'utf8'));
 const exited=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise(resolve=>exited.once('exit',resolve));
 descriptor.pid=exited.pid;await writeFile(path.join(profile,'.boss-chrome-session.json'),JSON.stringify(descriptor),{mode:0o600});
 runtime.child=exited;runtime.session={...runtime.session,pid:exited.pid};runtime.launchedAt=Date.now();
 await runtime.start(profile,{startupDelayMs:100});assert.equal(runtime.session.pid,child.pid);assert.equal(child.exitCode,null);assert.equal(runtime.child,null);
 const recovered=JSON.parse(await readFile(path.join(profile,'.boss-chrome-session.json'),'utf8'));assert.equal(recovered.pid,child.pid);
 await runtime.close();assert.ok(child.exitCode!==null||child.signalCode!==null);
});
test('corrupt ownership metadata never attaches or kills the existing dedicated Chrome',async t=>{
 if(process.env.CI&&!process.env.BOSS_NATIVE_SMOKE)return t.skip('optional native headed Chrome smoke in CI');
 if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return t.skip('native headed Chrome needs a graphical session');
 if(!await findChromeExecutable())return t.skip('Google Chrome not installed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-native-unverified-'));const profile=path.join(dir,'profile');const first=new ChromeRuntime();const second=new ChromeRuntime();
 t.after(async()=>{await second.close();await first.close();await rm(dir,{recursive:true,force:true});});
 await first.launch(profile);const child=first.child;
 await writeFile(path.join(profile,'.boss-chrome-session.json'),JSON.stringify({schema:1,profileDir:profile,marker:'invalid'}),{mode:0o600});
 await assert.rejects(second.start(profile,{startupDelayMs:0}),error=>error.code==='BROWSER_SESSION_UNVERIFIED');
 assert.equal(child.exitCode,null);assert.equal(second.browser,null);assert.equal(second.child,null);
});
test('default daily Chrome profile directories are rejected before launch or recovery',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-default-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const profile=process.platform==='darwin'?path.join(dir,'Library/Application Support/Google/Chrome'):process.platform==='win32'?path.join(dir,'Google/Chrome/User Data'):path.join(dir,'.config/google-chrome');
 await mkdir(profile,{recursive:true});
 const runtime=new ChromeRuntime({homeDir:dir,env:{...process.env,LOCALAPPDATA:dir}});
 await assert.rejects(runtime.launch(profile),error=>error.code==='BROWSER_SESSION_UNVERIFIED');assert.equal(runtime.child,null);
});

test('details retain exact identity and collect Beijing role text',async t=>{
 const browser=await setup(t); const result=await browser.details(job);
 assert.equal(result.city,'北京·海淀区');assert.match(result.description,/工具调用/);assert.equal(result.company,'示例科技');
 assert.deepEqual(result.recruiter,{name:'李招聘',id:'recruiter123'});
});
test('discovery only yields BOSS job URLs and follows visible next page',async t=>{
 const browser=await setup(t);const jobs=await browser.discover('AI Agent',{cityCode:'101010100',maxPages:2});
 assert.deepEqual(jobs.map(j=>j.id),['a123','b456']);assert.ok(jobs.every(j=>j.url.startsWith('https://www.zhipin.com/job_detail/')));
});
test('discovery uses the observed plural public job-search route',async t=>{
 const browser=await setup(t);const jobs=await browser.discover('AI Agent',{cityCode:'101010100',maxPages:1});
 assert.equal(new URL(browser.page.url()).pathname,'/web/geek/jobs');assert.equal(jobs.length,1);
});
test('a committed job page returning through history.back is NAVIGATION_REVERSED',async t=>{
 const browser=await setup(t,'authenticated');await browser.login();const auth=browser.authPage;
 const html=(await readFile(new URL('./fixtures/jobs.html',import.meta.url),'utf8')).replaceAll('__MODE__','history-back');
 await browser.context.route('https://www.zhipin.com/web/geek/jobs**',route=>route.fulfill({contentType:'text/html',body:html}));
 await assert.rejects(browser.discover('AI Agent',{cityCode:'101010100',maxPages:1}),error=>error.code==='NAVIGATION_REVERSED'&&/职位页加载后回退/u.test(error.message)&&Boolean(error.evidence?.screenshot));
 assert.equal(auth.url(),'https://www.zhipin.com/web/user/');assert.equal(auth.isClosed(),false);
});
test('a committed job page going back to its previous detail URL is NAVIGATION_REVERSED',async t=>{
 const browser=await setup(t);await browser.details(job);const before=browser.page.url();
 const html=(await readFile(new URL('./fixtures/jobs.html',import.meta.url),'utf8')).replaceAll('__MODE__','history-back');
 await browser.context.route('https://www.zhipin.com/web/geek/jobs**',route=>route.fulfill({contentType:'text/html',body:html}));
 await assert.rejects(browser.discover('AI Agent',{cityCode:'101010100',maxPages:1}),error=>error.code==='NAVIGATION_REVERSED');
 assert.equal(browser.page.url(),before);
});
test('an uncommitted empty task page remains PAGE_CHANGED instead of reversal',async t=>{
 const browser=await setup(t,'authenticated');await browser.login();await browser.useWorkPage();
 await assert.rejects(browser.guard(),error=>error.code==='PAGE_CHANGED');
});
test('late history rollback during spacing stops the next search before any request',async t=>{
 const browser=await setup(t,'authenticated');await browser.login();browser.selectors.navigationDelayMs=1000;
 const html=(await readFile(new URL('./fixtures/jobs.html',import.meta.url),'utf8')).replaceAll('__MODE__','late-history-back');let requests=0;
 await browser.context.route('https://www.zhipin.com/web/geek/jobs**',route=>{requests++;return route.fulfill({contentType:'text/html',body:html});});
 assert.equal((await browser.discover('AI Agent',{cityCode:'101010100',maxPages:1})).length,1);
 await assert.rejects(browser.navigate('https://www.zhipin.com/web/geek/jobs?city=101010100&query=second'),error=>error.code==='NAVIGATION_REVERSED');
 assert.equal(requests,1);
});
test('job reading uses one work tab and preserves the existing login tab',async t=>{
 const browser=await setup(t,'authenticated');await browser.login();const loginPage=browser.page;
 const before=browser.context.pages().length;
 await browser.discover('AI Agent',{cityCode:'101010100',maxPages:1});const workPage=browser.page;
 assert.notEqual(workPage,loginPage);assert.equal(loginPage.url(),'https://www.zhipin.com/web/user/');
 assert.equal(browser.context.pages().length,before+1);
 await browser.details(job);assert.equal(browser.page,workPage);assert.equal(browser.context.pages().length,before+1);
 await workPage.close();await browser.discover('AI Agent',{cityCode:'101010100',maxPages:1});
 assert.notEqual(browser.page,workPage);assert.equal(loginPage.url(),'https://www.zhipin.com/web/user/');
});
test('a blank work tab reports a job-page failure without asking to log in again',async t=>{
 const browser=await setup(t,'authenticated');await browser.login();const loginPage=browser.page;
 await browser.useWorkPage();
 await assert.rejects(browser.guard(),error=>error.code==='PAGE_CHANGED'&&/任务页/u.test(error.message)&&!/重新.*登录/u.test(error.message));
 assert.equal(loginPage.url(),'https://www.zhipin.com/web/user/');assert.equal(await loginPage.locator('.user-name').innerText(),'王同学');
});
test('discovery follows SPA pagination by changed job content without a changed URL',async t=>{
 const browser=await setup(t,'spa');const jobs=await browser.discover('AI Agent',{cityCode:'101010100',maxPages:2});
 assert.deepEqual(jobs.map(j=>j.id),['a123','b456']);
});
test('an unresponsive pagination click pauses with PAGE_CHANGED',async t=>{
 const browser=await setup(t,'stuck');
 await assert.rejects(browser.discover('AI Agent',{cityCode:'101010100',maxPages:2}),error=>error.code==='PAGE_CHANGED');
});
test('login only succeeds with a positive account indicator',async t=>{
 const browser=await setup(t);
 await assert.rejects(browser.login(),error=>error.code==='LOGIN_REQUIRED');
 const authenticated=await setup(t,'authenticated');assert.equal((await authenticated.login()).loggedIn,true);
});
test('login preparation leaves QR mode, agreement and submit controls for the user',async t=>{
 const browser=await setup(t);
 const html='<html><meta charset="utf-8"><body><div class="login-dialog"><input placeholder="手机号"><input placeholder="短信验证码"><input id="agreement" type="checkbox"><button id="qr" onclick="window.qrClicks=(window.qrClicks||0)+1;document.body.dataset.qr=1">APP扫码登录</button><button onclick="window.submitted=true">登录/注册</button></div></body></html>';
 await browser.context.route('https://www.zhipin.com/web/user/',route=>route.fulfill({contentType:'text/html',body:html}));
 await assert.rejects(browser.login(),error=>error.code==='LOGIN_REQUIRED');
 assert.equal(await browser.page.evaluate(()=>Boolean(window.qrClicks)),false);
 assert.equal(await browser.page.locator('#agreement').isChecked(),false);assert.equal(await browser.page.evaluate(()=>Boolean(window.submitted)),false);
});
test('login preparation leaves a mode alone when the user has entered phone or SMS text',async t=>{
 const browser=await setup(t);
 const html='<html><meta charset="utf-8"><body><div class="login-dialog"><input placeholder="手机号" value="123"><button onclick="window.qrClicked=true">APP扫码登录</button></div></body></html>';
 await browser.context.route('https://www.zhipin.com/web/user/',route=>route.fulfill({contentType:'text/html',body:html}));
 await assert.rejects(browser.login(),error=>error.code==='LOGIN_REQUIRED');
 assert.equal(await browser.page.evaluate(()=>Boolean(window.qrClicked)),false);
});
test('login opens the official dedicated sign-in URL rather than the home page',async t=>{
 const browser=await setup(t,'authenticated');assert.equal((await browser.login()).loggedIn,true);
 assert.equal(browser.page.url(),'https://www.zhipin.com/web/user/');
});
test('login preparation rejects a remaining about:blank page with a useful hint',async t=>{
 const browser=await setup(t,'authenticated');browser.selectors.loginUrl='about:blank';
 await assert.rejects(browser.login(),error=>error.code==='PAGE_CHANGED'&&/空白|登录/u.test(error.message));
});
test('a login page that clears itself after navigation is a rendering failure',async t=>{
 const browser=await setup(t,'delayed-blank');
 await assert.rejects(browser.login(),error=>error.code==='PAGE_CHANGED'&&/空白|显示/u.test(error.message));
});
test('an empty rendered official login response never pretends a QR page is ready',async t=>{
 const browser=await setup(t);
 await browser.context.route('https://www.zhipin.com/web/user/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title></title></head><body></body></html>'}));
 await assert.rejects(browser.login(),error=>error.code==='PAGE_CHANGED'&&/空白|显示/u.test(error.message));
});
test('open replaces a manually closed persistent browser context',async t=>{
 const browser=await setup(t,'authenticated');const original=browser.context;
 await original.close();await browser.open();
 assert.notEqual(browser.context,original);assert.equal(browser.page.isClosed(),false);
 const html=(await readFile(new URL('./fixtures/jobs.html',import.meta.url),'utf8')).replaceAll('__MODE__','authenticated');
 await browser.context.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:html}));
 assert.equal((await browser.login()).loggedIn,true);
});
test('login replaces a manually closed page in a still-open context',async t=>{
 const browser=await setup(t,'authenticated');const original=browser.page;
 await browser.context.newPage();await original.close();
 assert.equal((await browser.login()).loggedIn,true);
 assert.notEqual(browser.page,original);assert.equal(browser.page.isClosed(),false);
});
test('closing the browser during navigation spacing raises BROWSER_CLOSED',async t=>{
 const browser=await setup(t);await browser.details(job);
 browser.selectors.navigationDelayMs=500;let closed=false;
 browser.checkpoint=async()=>{if(!closed){closed=true;await browser.context.close();}};
 await assert.rejects(browser.details(job),error=>error.code==='BROWSER_CLOSED'&&/浏览器/u.test(error.message));
 assert.equal(browser.context,null);
});
test('browser closure after a send intent stops contact and retains uncertain intent',async t=>{
 const browser=await setup(t);let intent=false;let closed=false;const events=[];
 browser.checkpoint=async()=>{if(intent&&!closed){closed=true;await browser.context.close();}};
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:async(stage,patch)=>{events.push(patch);if(patch.resumeStatus==='intent')intent=true;}}),error=>error.code==='BROWSER_CLOSED');
 assert.equal(events.at(-1).resumeStatus,'intent');assert.equal(browser.context,null);
});
test('built-in greeting and attachment evidence are persisted and not duplicated',async t=>{
 const browser=await setup(t);const events=[];
 const first=await browser.contact(job,{greeting:'自定义你好',onStage:stages(browser,events)});
 assert.equal(first.greetingStatus,'sent');assert.equal(first.resumeStatus,'sent');
 assert.equal(events.find(e=>e.patch.greetingStatus==='intent').state,null);
 assert.equal(events.find(e=>e.patch.resumeStatus==='intent').state.resume,null);
 const second=await browser.contact(job,{greeting:'自定义你好',onStage:stages(browser)});
 assert.equal(second.greetingStatus,'existing');assert.equal(second.resumeStatus,'sent');
 const state=await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')));
 assert.deepEqual(state.greetings,['您好，我对该岗位感兴趣。']);
 assert.equal(await browser.page.evaluate(()=>Boolean(window.wrongRecipientSent)),false);
});
test('a verified empty new conversation receives one custom greeting',async t=>{
 const browser=await setup(t,'custom');const result=await browser.contact(job,{greeting:'自定义你好',onStage:stages(browser)});
 assert.equal(result.greetingStatus,'sent');
 const state=await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')));
 assert.deepEqual(state.greetings,['自定义你好']);
});
test('delayed platform greeting does not cause a second custom greeting',async t=>{
 const browser=await setup(t,'delayed');const result=await browser.contact(job,{greeting:'自定义你好',onStage:stages(browser)});
 assert.equal(result.greetingStatus,'sent');
 assert.deepEqual((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).greetings,['您好，我对该岗位感兴趣。']);
});
test('platform greeting arriving between outgoing and history reads is classified without another send',async t=>{
 const browser=await setup(t,'empty-unconfirmed');const visible=browser.visible.bind(browser);let inserted=false;
 browser.visible=async locator=>{
  const matches=await visible(locator);
  if(!inserted&&!matches.length&&locator.toString().includes(browser.selectors.outgoingMessages)){
   inserted=true;
   await browser.page.evaluate(()=>{current.greetings.push('您好，我对该岗位感兴趣。');save();message('您好，我对该岗位感兴趣。','text');});
  }
  return matches;
 };
 const result=await browser.contact(job,{greeting:'自定义你好',onStage:stages(browser)});
 assert.equal(inserted,true);assert.equal(result.greetingStatus,'sent');assert.equal(result.resumeStatus,'sent');
 assert.deepEqual((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).greetings,['您好，我对该岗位感兴趣。']);
 assert.equal(await browser.page.evaluate(()=>Boolean(window.wrongRecipientSent)),false);
});
test('an empty conversation without visible new-conversation proof is uncertain',async t=>{
 const browser=await setup(t,'empty-unconfirmed');const result=await browser.contact(job,{greeting:'自定义你好',onStage:stages(browser)});
 assert.equal(result.greetingStatus,'uncertain');
 assert.equal(await browser.page.locator('.message-item.sent').count(),0);
});
test('resume request remains requested until attachment message is visible',async t=>{
 const browser=await setup(t,'request');const result=await browser.contact(job,{greeting:'你好',onStage:stages(browser)});
 assert.equal(result.resumeStatus,'requested');assert.match(result.note,/同意/);
});
test('generic resume-card with pending request text never proves attachment delivery',async t=>{
 const browser=await setup(t,'request-card');const result=await browser.contact(job,{greeting:'你好',onStage:stages(browser)});
 assert.equal(result.resumeStatus,'requested');assert.match(result.note,/同意/);
});
test('missing exact recipient prevents resume or arbitrary send clicks',async t=>{
 const browser=await setup(t,'wrong-recipient');const events=[];
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:stages(browser,events)}),error=>error.code==='RECIPIENT_UNVERIFIED'&&Boolean(error.evidence?.screenshot));
 assert.equal(await browser.page.evaluate(()=>Boolean(window.wrongRecipientSent)),false);
 assert.equal(await browser.page.locator('.resume-dialog').count(),0);
 assert.ok(events.some(e=>e.patch.greetingStatus==='intent'));
 assert.ok(!events.some(e=>e.patch.resumeStatus==='intent'));
});
test('same title and company but a different chat job ID prevents further sends',async t=>{
 const browser=await setup(t,'wrong-jobid');const events=[];
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:stages(browser,events)}),error=>error.code==='RECIPIENT_UNVERIFIED');
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).resume,null);
 assert.ok(!events.some(e=>e.patch.resumeStatus==='intent'));
});
test('a chat without a stable target job identity cannot receive further sends',async t=>{
 const browser=await setup(t,'missing-jobid');
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:stages(browser)}),error=>error.code==='RECIPIENT_UNVERIFIED');
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).resume,null);
});
test('multiple resumes cannot be selected without exact configured name',async t=>{
 const browser=await setup(t,'multiple');
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:stages(browser)}),error=>error.code==='RESUME_SELECTION');
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).resume,null);
});
test('exact resume name chooses matching option even when there are multiple',async t=>{
 const browser=await setup(t,'multiple');const result=await browser.contact(job,{greeting:'你好',resumeName:'王同学.pdf',onStage:stages(browser)});
 assert.equal(result.resumeStatus,'sent');
});
test('a click without attachment proof returns uncertainty rather than success',async t=>{
 const browser=await setup(t,'no-evidence');const events=[];
 const result=await browser.contact(job,{greeting:'你好',onStage:stages(browser,events)});
 assert.equal(result.resumeStatus,'uncertain');assert.ok(result.evidence.screenshot);
 assert.ok(events.some(e=>e.patch.resumeStatus==='uncertain'));
});
test('a failed resume card is uncertain and cannot cause a blind retry',async t=>{
 const browser=await setup(t,'failed-resume');const first=await browser.contact(job,{greeting:'你好',onStage:stages(browser)});
 assert.equal(first.resumeStatus,'uncertain');
 const second=await browser.contact(job,{resumeOnly:true,onStage:stages(browser)});
 assert.equal(second.resumeStatus,'uncertain');
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).resumeClicks,1);
});
test('a failed greeting node never proves successful contact or permits a resume',async t=>{
 const browser=await setup(t,'failed-greeting');const result=await browser.contact(job,{greeting:'你好',onStage:stages(browser)});
 assert.equal(result.greetingStatus,'uncertain');
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).resume,null);
});
test('a recipient change at the final checkpoint blocks the resume button',async t=>{
 const browser=await setup(t);let intent=false;let checkpoints=0;let swapped=false;
 browser.checkpoint=async()=>{if(intent&&++checkpoints===2&&!swapped){swapped=true;await browser.page.locator('.job-link').evaluate(link=>link.href='https://www.zhipin.com/job_detail/otherJob.html');}};
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:async(stage,patch)=>{if(patch.resumeStatus==='intent')intent=true;}}),error=>error.code==='RECIPIENT_UNVERIFIED');
 assert.equal(await browser.page.locator('.resume-dialog').count(),0);
});
test('navigation at the final native-greeting checkpoint cannot contact a different job',async t=>{
 const browser=await setup(t);let intent=false;let checkpoints=0;
 browser.checkpoint=async()=>{if(intent&&++checkpoints===2)await browser.page.goto('https://www.zhipin.com/job_detail/otherJob.html');};
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:async(stage,patch)=>{if(patch.greetingStatus==='intent')intent=true;}}),error=>error.code==='RECIPIENT_UNVERIFIED');
 assert.equal(await browser.page.evaluate(()=>localStorage.getItem('conversation')),null);
});
test('resumeOnly revisits the same job and does not send a new greeting',async t=>{
 const browser=await setup(t,'request');await browser.contact(job,{greeting:'你好',onStage:stages(browser)});
 const result=await browser.contact(job,{resumeOnly:true,onStage:stages(browser)});
 assert.equal(result.greetingStatus,'existing');assert.equal(result.resumeStatus,'requested');
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).greetings.length,1);
});
test('later attachment evidence overrides an older pending resume request',async t=>{
 const browser=await setup(t,'request');await browser.contact(job,{greeting:'你好',onStage:stages(browser)});
 await browser.page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('conversation'));s.resume='sent';localStorage.setItem('conversation',JSON.stringify(s));});
 const result=await browser.contact(job,{resumeOnly:true,onStage:stages(browser)});
 assert.equal(result.resumeStatus,'sent');
});
test('resumeOnly sends an attachment after visible recipient approval',async t=>{
 const browser=await setup(t,'approved');await browser.details(job);
 await browser.page.evaluate(()=>localStorage.setItem('conversation',JSON.stringify({greetings:['已有招呼'],resume:'requested'})));
 const result=await browser.contact(job,{resumeOnly:true,onStage:stages(browser)});
 assert.equal(result.greetingStatus,'existing');assert.equal(result.resumeStatus,'sent');
 assert.deepEqual((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).greetings,['已有招呼']);
});
test('cancellation after resume intent stops before the resume button click',async t=>{
 const browser=await setup(t);let cancelled=false;
 browser.checkpoint=async()=>{if(cancelled){const error=new Error('cancelled');error.code='CANCELLED';throw error;}};
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:async(stage,patch)=>{if(patch.resumeStatus==='intent')cancelled=true;}}),error=>error.code==='CANCELLED');
 assert.equal(await browser.page.locator('.resume-dialog').count(),0);
 assert.equal((await browser.page.evaluate(()=>JSON.parse(localStorage.getItem('conversation')))).resume,null);
});
test('a failed intent write stops before contact is externally established',async t=>{
 const browser=await setup(t);
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:async()=>{throw new Error('disk failed');}}),/disk failed/);
 assert.equal(await browser.page.evaluate(()=>localStorage.getItem('conversation')),null);
});
test('login and CAPTCHA screens raise recoverable tagged errors with evidence',async t=>{
 for(const [mode,code] of [['login','LOGIN_REQUIRED'],['captcha','CAPTCHA']]){
  const browser=await setup(t,mode);await assert.rejects(browser.details(job),error=>error.code===code&&Boolean(error.evidence?.screenshot));
 }
});
