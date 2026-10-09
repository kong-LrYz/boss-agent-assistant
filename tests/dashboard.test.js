import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { evaluateJob } from '../src/core.js';

async function chooseRole(page,value){
 const select=page.getByLabel('选择目标岗位',{exact:true});
 if(await select.locator('option').evaluateAll((options,value)=>options.some(option=>option.value===value),value))return select.selectOption(value);
 const field=page.getByLabel('目标岗位',{exact:true});await field.fill(value);await field.press('Tab');
}


test('dashboard can save real configuration, start unlimited mode, and stop', async t => {
  const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-'));
  const store=new Store(dir);
  const runner={status:'idle',task:null,start(){this.status='running';this.task={};},async stop(){this.status='stopped';this.task=null;},snapshot(){return{status:this.status,cycle:0,counts:{}};}};
  const server=createServer({store,runner,token:'dashboard-token',publicDir:join(import.meta.dirname,'../public')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch();
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('岗位类型').selectOption('graduate');
  await page.getByLabel('目标城市').selectOption('上海');
  await page.locator('#advanced-settings').evaluate(element=>{element.open=true;});
  await page.getByLabel('附件简历名称').fill('Agent简历.pdf');
  await page.getByRole('button',{name:'开始投递'}).click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='正在投递');
  assert.equal(store.loadConfig().roleType,'graduate');
  assert.equal(store.loadConfig().city,'上海');
  assert.equal(store.loadConfig().cityCode,'101020100');
  assert.equal(store.loadConfig().resumeName,'Agent简历.pdf');
  assert.equal(store.loadConfig().dailyLimit,0);
  assert.equal(store.loadConfig().runLimit,0);
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='已停止');
  assert.equal(runner.task,null);
});
test('settings can be saved for a preview without starting a contact run', async t => {
  const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-save-'));
  const store=new Store(dir);
  const runner={snapshot(){return{status:'idle',counts:{}};},start(){throw Error('save-only started outreach');}};
  const server=createServer({store,runner,token:'save-token',publicDir:join(import.meta.dirname,'../public')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch();
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const saveOnly=page.getByRole('button',{name:'保存设置',exact:true});
  assert.equal(await saveOnly.count(),1);
  await saveOnly.click();
  await page.waitForFunction(()=>!document.getElementById('preview').disabled);
  assert.equal(store.loadConfig().setupComplete,true);
 assert.equal(await page.locator('#status').innerText(),'准备就绪');
});

test('changing the target role and immediately saving replaces default Agent filters',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-role-'));const store=new Store(dir);
 const runner={snapshot:()=>({status:'idle',counts:{}}),start(){throw Error('save-only must not send');}};
 const server=createServer({store,runner,token:'role-ui-token',publicDir:join(import.meta.dirname,'../public')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 await chooseRole(page,'Java开发');
 await page.getByRole('button',{name:'保存设置',exact:true}).click();
 await page.waitForFunction(()=>!document.getElementById('preview').disabled);
 assert.equal(store.loadConfig().targetRole,'Java开发');assert.deepEqual(store.loadConfig().queries,['Java开发']);assert.deepEqual(store.loadConfig().requiredAny,['Java开发']);
 assert.match(await page.locator('#current').innerText(),/Java开发/u);
});

test('configuration errors remain visible after the automatic status refresh', async t => {
  const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-error-'));
  const store=new Store(dir);
  const runner={snapshot(){return{status:'idle',counts:{}};},start(){throw Error('invalid settings must not start');}};
  const server=createServer({store,runner,token:'error-token',publicDir:join(import.meta.dirname,'../public')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch();
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('目标城市').selectOption('__custom__');
  await page.getByLabel('自定义城市名称').fill('自定义测试城市');
  await page.getByLabel('自定义城市的 BOSS 城市编码').fill('');
  await page.getByRole('button',{name:'开始投递'}).click();
  await page.waitForFunction(()=>document.getElementById('notice').textContent.length>0);
  await page.waitForTimeout(2300);
  assert.equal(await page.locator('#notice').isVisible(),true);
  assert.ok((await page.locator('#notice').innerText()).length>0);
  assert.equal(store.loadConfig().setupComplete,false);
  assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).isDisabled(),false);
  assert.equal(await page.getByLabel('目标岗位',{exact:true}).isDisabled(),false);
});

test('login button shows opening state and prevents repeat clicks while browser starts', async t => {
  const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-login-'));
  let finishLogin;
  const runner={snapshot(){return{status:'idle',counts:{}};},prepareLogin(){return new Promise(r=>{finishLogin=r;});}};
  const server=createServer({store:new Store(dir),runner,token:'login-token',publicDir:join(import.meta.dirname,'../public')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch();
  t.after(async()=>{finishLogin?.();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'打开浏览器 / 扫码登录'}).click();
  assert.equal(await page.locator('#login').isDisabled(),true);
  assert.match(await page.locator('#login').innerText(),/正在打开/);
  finishLogin();
 await page.waitForFunction(()=>document.getElementById('login').textContent==='打开浏览器 / 扫码登录');
});
test('extension setup is visible and stops the active task before opening installation',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-setup-'));let setup=false;
 const runner={task:{},status:'paused',snapshot(){return{status:this.status,counts:{},lastError:{code:'EXTENSION_REQUIRED',message:'需要扩展'}};},async stop(){this.task=null;this.status='stopped';}};
 const server=createServer({store:new Store(dir),runner,token:'setup-token',publicDir:join(import.meta.dirname,'../public'),extensionBridge:{snapshot:()=>({paired:false,connected:false,pairingCode:'1'.repeat(64)}),async handle(){return false;}},setupExtension:async()=>{assert.equal(runner.task,null);setup=true;}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const page=await browser.newPage();page.setDefaultTimeout(2500);await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'打开扩展管理'}).click();await page.waitForFunction(()=>document.getElementById('extension-setup').disabled===false);
 assert.equal(setup,true);assert.equal(await page.locator('#pairing-code').getAttribute('type'),'password');
});

async function roleRulesDashboard(t, rules, customRunner) {
 const dir=mkdtempSync(join(tmpdir(),'boss-dashboard-role-rules-'));const store=new Store(dir);
 store.saveConfig({...store.loadConfig(),delaySeconds:90,contactBatchSize:5,batchBreakMinutes:10,idleMinutes:10,excludeKeywords:['销售'],roleTitleExclusions:rules});
 const runner=customRunner||{snapshot:()=>({status:'idle',counts:{}}),start(){throw Error('settings must not send');}};
 const server=createServer({store,runner,token:'role-rules-token',publicDir:join(import.meta.dirname,'../public')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
 const page=await browser.newPage();page.setDefaultTimeout(2500);await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value!=='');
 if(await page.locator('#advanced-settings').count())await page.locator('#advanced-settings').evaluate(element=>{element.open=true;});
 if(await page.locator('#diagnostics').count())await page.locator('#diagnostics').evaluate(element=>{element.open=true;});
 return {page,store,runner};
}

test('pending start prevents duplicate actions and configuration saves until failure recovers',async t=>{
 const runner={snapshot:()=>({status:'idle',counts:{}}),start(){throw Error('fixture start must stay intercepted');}};
 const {page,store}=await roleRulesDashboard(t,[],runner);
 let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());let starts=0,configs=0;
 await page.route('**/api/start',async route=>{starts++;await held;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"暂时无法启动"}'});});
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/config')configs++;});
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 const baseline=configs;await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('start').getAttribute('aria-busy')==='true');
 assert.equal(await page.locator('#preview').isDisabled(),true);assert.equal(await page.locator('button[value="save"]').isDisabled(),true);
 await page.locator('#start').dispatchEvent('click');await page.locator('#preview').dispatchEvent('click');
 await page.locator('#config-form').evaluate(form=>form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('button[value="start"]')})));
 await page.waitForTimeout(2100);assert.equal(starts,1);assert.equal(configs,baseline);assert.equal(store.loadConfig().setupComplete,true);assert.equal(await page.locator('#start').isDisabled(),true);
 release();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 assert.equal(await page.locator('#start').getAttribute('aria-busy'),'false');assert.match(await page.locator('#notice').innerText(),/暂时无法启动/u);assert.equal(await page.locator('button[value="save"]').isDisabled(),false);
});

test('saving visible basic settings preserves collapsed advanced fields and selected job type',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['运营']},{targetRole:'Go开发',keywords:['培训']}]);
 await page.locator('[name="contactCompanyTarget"]').fill('500');await page.locator('[name="resumeCompanyTarget"]').fill('100');
 await page.locator('#advanced-settings').evaluate(element=>{element.open=false;});await page.locator('#diagnostics').evaluate(element=>{element.open=false;});
 const previous=store.loadConfig();await page.getByLabel('岗位类型',{exact:true}).selectOption('internship');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 const next=store.loadConfig();assert.equal(next.roleType,'internship');assert.equal(next.contactCompanyTarget,500);assert.equal(next.resumeCompanyTarget,100);
 for(const key of ['queries','requiredAny','excludeKeywords','delaySeconds','idleMinutes','batchBreakMinutes','resumeName','autoRun'])assert.deepEqual(next[key],previous[key]);
 const orderedRules=config=>config.roleTitleExclusions.slice().sort((a,b)=>a.targetRole.localeCompare(b.targetRole));assert.deepEqual(orderedRules(next),orderedRules(previous));
 assert.equal(await page.locator('#advanced-settings').evaluate(element=>element.open),false);assert.equal(await page.getByLabel('岗位类型',{exact:true}).isVisible(),true);
});

test('stop remains available during a config save and cancels its queued start',async t=>{
 const runner={starts:0,stops:0,snapshot:()=>({status:'idle',counts:{}}),start(){this.starts++;},async stop(){this.stops++;}};
 const {page}=await roleRulesDashboard(t,[],runner);let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 await page.route('**/api/config',async route=>{await held;await route.continue();});
 await page.getByRole('button',{name:'开始投递',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name="targetRole"]').disabled);
 assert.equal(await page.locator('#stop').isDisabled(),false);await page.locator('#stop').click();await page.waitForFunction(()=>!document.getElementById('stop').getAttribute('aria-busy')||document.getElementById('stop').getAttribute('aria-busy')==='false');
 release();await page.waitForFunction(()=>!document.querySelector('button[value="save"]').disabled);assert.equal(runner.starts,0);assert.equal(runner.stops,1);
});

test('main start saves edited basic settings before requesting a run',async t=>{
 const runner={status:'idle',starts:0,snapshot(){return{status:this.status,counts:{}};},start(){this.status='running';this.starts++;}};
 const {page,store}=await roleRulesDashboard(t,[],runner);await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 await page.getByLabel('岗位类型',{exact:true}).selectOption('experienced');await page.locator('[name="contactCompanyTarget"]').fill('500');await page.locator('#start').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='正在投递');assert.equal(runner.starts,1);assert.equal(store.loadConfig().roleType,'experienced');assert.equal(store.loadConfig().contactCompanyTarget,500);
});

for(const path of ['start','login'])test(`stop cancels a late ${path} response without relaunching`,async t=>{
 const runner={status:'idle',starts:0,stops:0,snapshot(){return{status:this.status,counts:{}};},start(){this.starts++;this.status='running';},async prepareLogin(){this.starts++;},async stop(){this.stops++;this.status='stopped';}};
 const {page}=await roleRulesDashboard(t,[],runner);await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('start').disabled);
 let release;const held=new Promise(resolve=>{release=resolve;});t.after(()=>release());await page.route(`**/api/${path}`,async route=>{await held;await route.continue();});
 await page.locator(`#${path}`).click();await page.waitForFunction(id=>document.getElementById(id).getAttribute('aria-busy')==='true',path);
 assert.equal(await page.locator('#stop').isDisabled(),false);await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('stop').getAttribute('aria-busy')==='false');assert.equal(runner.stops,1);
 release();await page.waitForFunction(id=>document.getElementById(id).getAttribute('aria-busy')==='false',path);assert.equal(runner.starts,1);assert.equal(runner.stops,2);assert.equal(runner.status,'stopped');
});

async function timingValues(page){return page.evaluate(()=>Object.fromEntries(['delaySeconds','contactBatchSize','batchBreakMinutes','idleMinutes'].map(key=>[key,Number(document.querySelector(`[name="${key}"]`).value)])));}
const steadyTiming={delaySeconds:90,contactBatchSize:5,batchBreakMinutes:10,idleMinutes:10};
const efficientTiming={delaySeconds:0,contactBatchSize:10,batchBreakMinutes:0,idleMinutes:0};

test('speed profiles fill timing only and preserve saved defaults and target rules until an explicit save',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Go开发',keywords:['培训']}]);
 await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');assert.deepEqual(await timingValues(page),steadyTiming);
 assert.equal(await page.locator('[name="delaySeconds"]').getAttribute('min'),'0');assert.equal(await page.locator('[name="batchBreakMinutes"]').getAttribute('min'),'0');
 let mutations=0;page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(?:config|start)$/u.test(new URL(request.url()).pathname))mutations++;});
 await page.getByLabel('本目标岗位排除职能（仅看职位标题）').fill('运营');await page.locator('[name="queries"]').fill('自定义Agent检索');
 await page.getByRole('button',{name:'填入无等待档',exact:true}).click();assert.deepEqual(await timingValues(page),efficientTiming);assert.equal(await page.locator('[name="queries"]').inputValue(),'自定义Agent检索');assert.equal(await page.getByLabel('本目标岗位排除职能（仅看职位标题）').inputValue(),'运营');assert.match(await page.locator('#speed-note').innerText(),/尚未保存/u);
 await page.getByRole('button',{name:'填入稳健档',exact:true}).click();assert.deepEqual(await timingValues(page),steadyTiming);assert.equal(mutations,0);assert.equal(store.loadConfig().delaySeconds,90);assert.equal(store.loadConfig().batchBreakMinutes,10);
 await page.getByRole('button',{name:'填入无等待档',exact:true}).click();await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.equal(mutations,1);for(const [key,value] of Object.entries(efficientTiming))assert.equal(store.loadConfig()[key],value);assert.deepEqual(store.loadConfig().queries,['自定义Agent检索']);assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'Go开发',keywords:['培训']},{targetRole:'AI Agent',keywords:['运营']}]);
});
test('speed profiles cannot change timing during a config POST or a later idle poll',async t=>{
 const {page}=await roleRulesDashboard(t,[]);let release;const held=new Promise(resolve=>{release=resolve;});await page.route('**/api/config',async route=>{await held;await route.continue();});t.after(()=>release());
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name="targetRole"]').disabled);
 try{for(const id of ['speed-efficient','speed-steady']){assert.equal(await page.locator(`#${id}`).isDisabled(),true);await page.locator(`#${id}`).dispatchEvent('click');}assert.deepEqual(await timingValues(page),steadyTiming);await page.waitForTimeout(2100);assert.equal(await page.locator('#speed-efficient').isDisabled(),true);assert.deepEqual(await timingValues(page),steadyTiming);}finally{release();}
 await page.waitForFunction(()=>!document.getElementById('speed-efficient').disabled);
});
test('speed profiles remain locked while role defaults settle without preventing a newer target',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);let release;const held=new Promise(resolve=>{release=resolve;});await page.route('**/api/role-defaults?**',async route=>{if(new URL(route.request().url()).searchParams.get('role')==='Java开发')await held;await route.continue();});t.after(()=>release());
 const target=page.getByLabel('目标岗位',{exact:true});await chooseRole(page,'Java开发');await target.press('Tab');await page.getByRole('button',{name:'保存设置',exact:true}).click();assert.equal(await page.locator('#speed-efficient').isDisabled(),true);assert.equal(await target.isDisabled(),false);await page.locator('#speed-efficient').dispatchEvent('click');assert.deepEqual(await timingValues(page),steadyTiming);
 await chooseRole(page,'Go开发');await target.press('Tab');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='Go开发');release();await page.waitForFunction(()=>!document.getElementById('speed-efficient').disabled);assert.equal(store.loadConfig().targetRole,'Go开发');assert.equal(store.loadConfig().delaySeconds,90);
});
test('speed profiles refuse field changes while running waiting or paused',async t=>{
 const runner={status:'running',snapshot(){return{status:this.status,counts:{}};}};const {page}=await roleRulesDashboard(t,[],runner);
 for(const status of ['running','waiting','paused']){runner.status=status;await page.reload();await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');assert.equal(await page.locator('#speed-efficient').isDisabled(),true);await page.locator('#speed-efficient').dispatchEvent('click');assert.deepEqual(await timingValues(page),steadyTiming);}
});
for(const performance of [undefined,{detailReads:0,precheckRejected:0,verifiedNewContacts:0,elapsedMs:0,waitedMs:0,contactWaitMs:0,batchWaitMs:0,idleWaitMs:0,confirmedPerHour:0}])test(`runtime performance renders missing or zero samples safely (${performance?'zero':'missing'})`,async t=>{
 const {page}=await roleRulesDashboard(t,[],{snapshot:()=>({status:'idle',counts:{},performance})});const summary=await page.locator('#performance-summary').innerText();assert.match(summary,/详情检查 0/u);assert.match(summary,/预筛跳过 0/u);assert.match(summary,/已确认新联系 0/u);assert.match(summary,/耗时 0秒/u);assert.match(await page.locator('#performance-waits').innerText(),/联系间隔 0秒/u);assert.match(await page.locator('#performance-rate').innerText(),/样本不足/u);assert.doesNotMatch(await page.locator('#performance-panel').innerText(),/NaN|Infinity|个\/小时/u);
});
test('runtime performance never uses old contacts or uncertain records to inflate a small sample',async t=>{
 const performance={detailReads:9,precheckRejected:2,verifiedNewContacts:4,elapsedMs:1000,waitedMs:0,confirmedPerHour:14400};const {page}=await roleRulesDashboard(t,[],{snapshot:()=>({status:'idle',counts:{contacted:99,existing:90,uncertain:20},performance})});assert.match(await page.locator('#performance-summary').innerText(),/已确认新联系 4/u);assert.match(await page.locator('#performance-rate').innerText(),/样本不足/u);assert.doesNotMatch(await page.locator('#performance-rate').innerText(),/14400|个\/小时/u);
});
test('runtime performance shows measured counts wait categories and an hourly rate only with enough samples',async t=>{
 const performance={detailReads:20,precheckRejected:7,verifiedNewContacts:5,elapsedMs:3600000,waitedMs:900000,contactWaitMs:180000,batchWaitMs:600000,idleWaitMs:120000,confirmedPerHour:5};const {page}=await roleRulesDashboard(t,[],{snapshot:()=>({status:'idle',counts:{contacted:99,existing:90,uncertain:20},performance})});const summary=await page.locator('#performance-summary').innerText();assert.match(summary,/详情检查 20/u);assert.match(summary,/预筛跳过 7/u);assert.match(summary,/已确认新联系 5/u);assert.match(summary,/耗时 1时0分/u);assert.match(summary,/节奏等待 15分0秒/u);const waits=await page.locator('#performance-waits').innerText();assert.match(waits,/联系间隔 3分0秒/u);assert.match(waits,/批次休息 10分0秒/u);assert.match(waits,/轮次等待 2分0秒/u);assert.match(await page.locator('#performance-rate').innerText(),/5\.0个\/小时/u);
});
test('company goals default to unlimited and the settings entry opens editable role city and counts without posting',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);let posts=0;page.on('request',request=>{if(request.method()==='POST'&&/\/api\/(?:config|start)$/u.test(new URL(request.url()).pathname))posts++;});
 assert.equal(await page.locator('[name="contactCompanyTarget"]').inputValue(),'0');assert.equal(await page.locator('[name="resumeCompanyTarget"]').inputValue(),'0');assert.equal(await page.locator('[name="companyDedup"]').count(),0);
 await page.locator('#settings').evaluate(element=>{element.open=false;});await page.getByRole('button',{name:'设置目标岗位 / 城市 / 数量',exact:true}).click();assert.equal(await page.locator('#settings').evaluate(element=>element.open),true);assert.equal(await page.locator('[name="targetRole"]').evaluate(element=>element===document.activeElement),true);assert.equal(posts,0);assert.equal(store.loadConfig().contactCompanyTarget,0);assert.match(await page.locator('#goal-summary').innerText(),/持续至你停止/u);assert.match(await page.locator('#goal-status').innerText(),/不限数量/u);
});
test('company goals persist without company deduplication controls while speed profiles change only timing',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Java开发',keywords:['客服']}]);await chooseRole(page,'Java开发');await page.getByLabel('目标岗位',{exact:true}).press('Tab');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='Java开发');await page.getByLabel('目标城市',{exact:true}).selectOption('上海');await page.locator('[name="contactCompanyTarget"]').fill('500');await page.locator('[name="resumeCompanyTarget"]').fill('100');
 await page.getByRole('button',{name:'填入无等待档',exact:true}).click();assert.equal(await page.locator('[name="contactCompanyTarget"]').inputValue(),'500');assert.equal(await page.locator('[name="resumeCompanyTarget"]').inputValue(),'100');assert.equal(await page.locator('[name="companyDedup"]').count(),0);assert.equal(await page.getByLabel('目标岗位',{exact:true}).inputValue(),'Java开发');assert.equal(await page.getByLabel('目标城市',{exact:true}).inputValue(),'上海');assert.equal(await page.locator('[name="queries"]').inputValue(),'Java开发');assert.equal(await page.getByLabel('本目标岗位排除职能（仅看职位标题）').inputValue(),'客服');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);await page.waitForFunction(()=>document.getElementById('target-role-label').textContent==='Java开发');const config=store.loadConfig();assert.equal(config.contactCompanyTarget,500);assert.equal(config.resumeCompanyTarget,100);assert.equal(config.companyDedup,false);assert.equal(config.targetRole,'Java开发');assert.equal(config.city,'上海');assert.deepEqual(config.roleTitleExclusions,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Java开发',keywords:['客服']}]);assert.match(await page.locator('#goal-summary').innerText(),/500.*100.*两项/u);
});
test('finite company goals must be read back before starting when an older backend acknowledges but drops them',async t=>{
 const runner={starts:0,snapshot:()=>({status:'idle',counts:{}}),start(){this.starts++;}};const {page,store}=await roleRulesDashboard(t,[],runner);
 await page.route('**/api/config',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}));await page.locator('[name="contactCompanyTarget"]').fill('500');await page.locator('[name="resumeCompanyTarget"]').fill('100');await page.getByRole('button',{name:'开始投递',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('button[value="save"]').disabled);
 assert.equal(runner.starts,0);assert.equal(store.loadConfig().contactCompanyTarget,0);assert.match(await page.locator('#notice').innerText(),/公司目标.*确认/u);assert.equal(await page.locator('#settings').evaluate(element=>element.open),true);assert.equal(await page.locator('#start').isDisabled(),true);
});
test('company goal progress uses verified unique-company totals and explains each partial or completed target',async t=>{
 const runner={goal:null,snapshot(){return{status:'idle',counts:{contacted:999,requested:800,delivered:700,existing:600,uncertain:500},goal:this.goal};}};const {page}=await roleRulesDashboard(t,[],runner);
 const cases=[
  [{contactedCompanies:500,deliveredCompanies:45,contactTarget:500,resumeTarget:100,contactReached:true,resumeReached:false,complete:false},'继续待发附件',/停止新增招呼/u],
  [{contactedCompanies:120,deliveredCompanies:100,contactTarget:500,resumeTarget:100,contactReached:false,resumeReached:true,complete:false},'继续打招呼',/停止新增附件/u],
  [{contactedCompanies:10,deliveredCompanies:1,contactTarget:10,resumeTarget:0,contactReached:true,resumeReached:true,complete:true},'目标已完成',/任务会停止/u],
  [{contactedCompanies:77,deliveredCompanies:3,contactTarget:0,resumeTarget:3,contactReached:true,resumeReached:true,complete:true},'目标已完成',/任务会停止/u],
  [{contactedCompanies:500,deliveredCompanies:100,contactTarget:500,resumeTarget:100,contactReached:true,resumeReached:true,complete:true},'目标已完成',/任务会停止/u],
  [{contactedCompanies:0,deliveredCompanies:0,contactTarget:0,resumeTarget:0,contactReached:true,resumeReached:true,complete:false},'不限数量',/持续至你停止/u]
 ];
 for(const [goal,status,note] of cases){runner.goal=goal;await page.reload();await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');await page.locator('#diagnostics').evaluate(element=>{element.open=true;});assert.equal(await page.locator('#goal-status').innerText(),status);assert.match(await page.locator('#goal-note').innerText(),note);assert.match(await page.locator('#goal-contact').innerText(),new RegExp(`打招呼公司 ${goal.contactedCompanies} / ${goal.contactTarget||'不限'}`));assert.match(await page.locator('#goal-resume').innerText(),new RegExp(`附件送达公司 ${goal.deliveredCompanies} / ${goal.resumeTarget||'不限'}`));}
 runner.goal=undefined;await page.reload();await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');await page.locator('#diagnostics').evaluate(element=>{element.open=true;});assert.match(await page.locator('#goal-contact').innerText(),/打招呼公司 0 \/ 不限/u);assert.match(await page.locator('#goal-resume').innerText(),/附件送达公司 0 \/ 不限/u);assert.doesNotMatch(await page.locator('#goal-panel').innerText(),/999|800|700|600|500/u);
});
test('unsafe fractional negative or empty company targets are rejected before any configuration POST',async t=>{
 const {page}=await roleRulesDashboard(t,[]);let posts=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/config')posts++;});
 for(const value of ['9007199254740992','1.5','-1','']){await page.locator('[name="contactCompanyTarget"]').fill(value);await page.locator('#config-form').evaluate(form=>form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('button[value="save"]')})));await page.waitForFunction(()=>!document.querySelector('button[value="save"]').disabled);assert.match(await page.locator('#notice').innerText(),/公司目标/u);assert.equal(posts,0);}
});
test('company target fields retain running and pending-save locks while the settings entry remains available',async t=>{
 const runner={status:'running',snapshot(){return{status:this.status,counts:{}};}};const {page}=await roleRulesDashboard(t,[],runner);await page.getByRole('button',{name:'设置目标岗位 / 城市 / 数量',exact:true}).click();for(const name of ['contactCompanyTarget','resumeCompanyTarget'])assert.equal(await page.locator(`[name="${name}"]`).isDisabled(),true);
 runner.status='idle';await page.reload();await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');let release;const held=new Promise(resolve=>{release=resolve;});await page.route('**/api/config',async route=>{await held;await route.continue();});t.after(()=>release());await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[name="targetRole"]').disabled);try{for(const name of ['contactCompanyTarget','resumeCompanyTarget'])assert.equal(await page.locator(`[name="${name}"]`).isDisabled(),true);}finally{release();}
});

// Switching roles must not overwrite another target's saved title restrictions.
test('target-specific title exclusions switch and save without changing other roles or global exclusions',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品','运营']},{targetRole:'产品经理',keywords:['开发']}]);
 const field=page.getByLabel('本目标岗位排除职能（仅看职位标题）');
 assert.equal(await field.inputValue(),'产品\n运营');
 await chooseRole(page,'产品经理');await page.getByLabel('目标岗位',{exact:true}).press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='产品经理');
 assert.equal(await field.inputValue(),'开发');
 await field.fill('运营\n售后');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'AI Agent',keywords:['产品','运营']},{targetRole:'产品经理',keywords:['运营','售后']}]);
 assert.deepEqual(store.loadConfig().excludeKeywords,['销售']);
 await page.waitForFunction(()=>document.getElementById('current').textContent.includes('产品经理'));
 await page.locator('#settings').evaluate(el=>{el.open=true;});
 await page.getByLabel('选择目标岗位',{exact:true}).selectOption('AI Agent');await page.getByLabel('目标岗位',{exact:true}).press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="requiredAny"]').value.includes('智能体'));
 assert.equal(await field.inputValue(),'产品\n运营');
});

// Empty input should remove only the current target's entry, never write an invalid empty rule.
test('clearing current target title exclusions deletes that rule and preserves another target',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Java开发',keywords:['售前']}]);
 await page.getByLabel('本目标岗位排除职能（仅看职位标题）').fill('');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'Java开发',keywords:['售前']}]);
 assert.deepEqual(store.loadConfig().excludeKeywords,['销售']);
});

// Full-width/case/spacing variants of a role must edit its existing entry instead of creating duplicates.
test('target title exclusion lookup treats normalized role variants as the same target',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'ａｉ  ａｇｅｎｔ',keywords:['产品']},{targetRole:'Java开发',keywords:['客服']}]);
 const field=page.getByLabel('本目标岗位排除职能（仅看职位标题）');
 assert.equal(await field.inputValue(),'产品');
 await field.fill('运营');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'Java开发',keywords:['客服']},{targetRole:'AI Agent',keywords:['运营']}]);
});

// A save begun during one preset request must wait for a newer role request before serializing its rule.
test('saving during rapid role changes waits for the newest role and its exclusion rule',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Java开发',keywords:['客服']},{targetRole:'Python开发',keywords:['售前']},{targetRole:'Go开发',keywords:['培训']}]);
 const pending=new Map();
 await page.route('**/api/role-defaults?**',async route=>{
   const role=new URL(route.request().url()).searchParams.get('role');
   if(!pending.has(role)){let release;const promise=new Promise(resolve=>{release=resolve;});pending.set(role,{promise,release});}
   await pending.get(role).promise;
   await route.continue();
 });
 t.after(()=>{for(const item of pending.values())item.release();});
 const target=page.getByLabel('目标岗位',{exact:true});
 const javaRequested=page.waitForRequest(r=>r.url().includes('/api/role-defaults?')&&new URL(r.url()).searchParams.get('role')==='Java开发');
 await chooseRole(page,'Java开发');await target.press('Tab');await javaRequested;
 await page.getByRole('button',{name:'保存设置',exact:true}).click();
 const pythonRequested=page.waitForRequest(r=>r.url().includes('/api/role-defaults?')&&new URL(r.url()).searchParams.get('role')==='Python开发');
 await chooseRole(page,'Python开发');await target.press('Tab');await pythonRequested;
 pending.get('Java开发').release();
 await page.waitForTimeout(80);
 const goRequested=page.waitForRequest(r=>r.url().includes('/api/role-defaults?')&&new URL(r.url()).searchParams.get('role')==='Go开发');
 await chooseRole(page,'Go开发');await target.press('Tab');await goRequested;
 pending.get('Python开发').release();
 await page.waitForTimeout(120);
 assert.equal(store.loadConfig().targetRole,'AI Agent');
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok());
 pending.get('Go开发').release();await saved;
 assert.equal(store.loadConfig().targetRole,'Go开发');
 assert.deepEqual(store.loadConfig().queries,['Go开发']);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Java开发',keywords:['客服']},{targetRole:'Python开发',keywords:['售前']},{targetRole:'Go开发',keywords:['培训']}]);
});

// An obsolete preset failure must not cancel a save whose newer target has loaded correctly.
test('an obsolete role request failure does not block saving the latest target',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Go开发',keywords:['运营']}]);
 let release;const failedRequest=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/role-defaults?**',async route=>{
   if(new URL(route.request().url()).searchParams.get('role')!=='Java开发')return route.continue();
   await failedRequest;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'旧目标请求失败'})});
 });
 t.after(()=>release());
 const target=page.getByLabel('目标岗位',{exact:true});
 const requested=page.waitForRequest(r=>r.url().includes('/api/role-defaults?')&&new URL(r.url()).searchParams.get('role')==='Java开发');
 await chooseRole(page,'Java开发');await target.press('Tab');await requested;
 await page.getByRole('button',{name:'保存设置',exact:true}).click();
 await chooseRole(page,'Go开发');await target.press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='Go开发');
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok());
 release();await saved;
 assert.equal(store.loadConfig().targetRole,'Go开发');
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Go开发',keywords:['运营']}]);
});

// A pending config write must not allow a second save based on stale rules, even after an idle poll.
test('a delayed configuration save stays locked and later role saves preserve its new rule',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Go开发',keywords:['培训']}]);
 let release,submissions=0;const held=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/config',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   submissions++;
   if(submissions===1)await held;
   await route.continue();
 });
 t.after(()=>release());
 const field=page.getByLabel('本目标岗位排除职能（仅看职位标题）');
 const target=page.getByLabel('目标岗位',{exact:true});
 const save=page.getByRole('button',{name:'保存设置',exact:true});
 const firstRequest=page.waitForRequest(r=>r.url().endsWith('/api/config')&&r.method()==='POST');
 await field.fill('运营');await save.click();await firstRequest;
 try {
   assert.equal(await save.isDisabled(),true);
   assert.equal(await target.isDisabled(),true);
   await page.locator('#config-form').evaluate(form=>form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('button[value="save"]')})));
   await page.waitForTimeout(2100);
   assert.equal(submissions,1);
   assert.equal(await save.isDisabled(),true);
   assert.equal(await target.isDisabled(),true);
 } finally {release();}
 await page.waitForFunction(()=>!document.querySelector('[name="targetRole"]').disabled&&document.getElementById('preview').disabled===false);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'Go开发',keywords:['培训']},{targetRole:'AI Agent',keywords:['运营']}]);
 await page.locator('#settings').evaluate(el=>{el.open=true;});
 await chooseRole(page,'Go开发');await target.press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='Go开发');
 assert.equal(await field.inputValue(),'培训');
 await field.fill('客服');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),save.click()]);
 assert.equal(submissions,2);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'AI Agent',keywords:['运营']},{targetRole:'Go开发',keywords:['客服']}]);
});

// A successful write followed by a failed status read must never make the next save restore old rules.
test('a save after a failed status refresh synchronizes stored rules before saving another target',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Go开发',keywords:['培训']}]);
 let statusOffline=false,submissions=0;
 await page.route('**/api/status',route=>statusOffline?route.abort('connectionreset'):route.continue());
 await page.route('**/api/config',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   submissions++;
   if(submissions===1)statusOffline=true;
   await route.continue();
 });
 const target=page.getByLabel('目标岗位',{exact:true});
 const field=page.getByLabel('本目标岗位排除职能（仅看职位标题）');
 const save=page.getByRole('button',{name:'保存设置',exact:true});
 await field.fill('运营');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),save.click()]);
 await page.waitForFunction(()=>!document.querySelector('[name="targetRole"]').disabled&&document.getElementById('notice').textContent.includes('断开连接'));
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'Go开发',keywords:['培训']},{targetRole:'AI Agent',keywords:['运营']}]);
 await page.locator('#settings').evaluate(el=>{el.open=true;});
 await chooseRole(page,'Go开发');await target.press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='Go开发');
 await field.fill('客服');
 const syncAttempt=page.waitForRequest(r=>r.url().endsWith('/api/status'));
 await save.click();await syncAttempt;
 await page.waitForFunction(()=>!document.querySelector('button[value="save"]').disabled);
 assert.equal(submissions,1);
 assert.match(await page.locator('#notice').innerText(),/同步/u);
 assert.equal(await field.inputValue(),'客服');
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'Go开发',keywords:['培训']},{targetRole:'AI Agent',keywords:['运营']}]);
 statusOffline=false;
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),save.click()]);
 assert.equal(submissions,2);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'AI Agent',keywords:['运营']},{targetRole:'Go开发',keywords:['客服']}]);
});

// A poll that read an old snapshot before a save must not replace the newly synchronized config.
test('a delayed status response from before a save cannot restore old target rules',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品']},{targetRole:'Go开发',keywords:['培训']}]);
 await page.waitForFunction(()=>document.querySelector('[name="roleTitleExclusionTerms"]').value==='产品');
 let release,ready,heldOnce=false;
 const held=new Promise(resolve=>{release=resolve;}),oldRead=new Promise(resolve=>{ready=resolve;});
 await page.route('**/api/status',async route=>{
   if(heldOnce)return route.continue();
   heldOnce=true;const response=await route.fetch();ready();await held;
   await route.fulfill({response,headers:{...response.headers(),'x-fixture-old-status':'true'}});
 });
 t.after(()=>release());
 await oldRead;
 const field=page.getByLabel('本目标岗位排除职能（仅看职位标题）');
 const target=page.getByLabel('目标岗位',{exact:true});
 const save=page.getByRole('button',{name:'保存设置',exact:true});
 try {
   await field.fill('运营');
   await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),save.click()]);
   await page.waitForFunction(()=>!document.querySelector('[name="targetRole"]').disabled&&document.getElementById('preview').disabled===false);
 } finally {release();}
 await page.waitForResponse(r=>r.headers()['x-fixture-old-status']==='true');
 await page.locator('#settings').evaluate(el=>{el.open=true;});
 await chooseRole(page,'Go开发');await target.press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='Go开发');
 await field.fill('客服');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'&&r.ok()),save.click()]);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,[{targetRole:'AI Agent',keywords:['运营']},{targetRole:'Go开发',keywords:['客服']}]);
});

test('zero extra waiting profile saves every zero without starting outreach', async t => {
  const {page,store}=await roleRulesDashboard(t,[]);
  await page.locator('#speed-efficient').click();
  assert.deepEqual(await timingValues(page),{delaySeconds:0,contactBatchSize:10,batchBreakMinutes:0,idleMinutes:0});
  for (const field of ['delaySeconds','batchBreakMinutes','idleMinutes']) assert.equal(await page.locator(`[name="${field}"]`).getAttribute('min'),'0');
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
  for (const field of ['delaySeconds','batchBreakMinutes','idleMinutes']) assert.equal(store.loadConfig()[field],0);
});


test('role and city catalogs support no-typing choices while preserving unsaved values across polls',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品经理']}]);
 const target=page.getByLabel('目标岗位',{exact:true}),picker=page.getByLabel('选择目标岗位',{exact:true}),city=page.getByLabel('目标城市',{exact:true});
 assert.equal(await target.evaluate(element=>element.tagName),'INPUT');assert.equal(await city.evaluate(element=>element.tagName),'SELECT');
 assert.ok(await picker.locator('optgroup').count()>=10);assert.ok(await picker.locator('option').count()>=70);
 await picker.selectOption('销售专员');await city.selectOption('上海');await page.getByLabel('岗位类型',{exact:true}).selectOption('experienced');
 await page.waitForTimeout(2200);assert.equal(await target.inputValue(),'销售专员');assert.equal(await city.inputValue(),'上海');assert.equal(store.loadConfig().targetRole,'AI Agent');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 const config=store.loadConfig();assert.equal(config.targetRole,'销售专员');assert.equal(config.city,'上海');assert.equal(config.cityCode,'101020100');assert.ok(config.requiredAny.includes('销售专员'));assert.ok(!config.excludeKeywords.includes('销售'));assert.deepEqual(config.roleTitleExclusions,[{targetRole:'AI Agent',keywords:['产品经理']}]);
 assert.equal(await page.locator('#city-code-field').isVisible(),false);assert.equal(await page.locator('[name="customRole"]').count(),0);
});

test('stored custom role and custom city remain selectable and save without losing custom filters',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 store.saveConfig({...store.loadConfig(),targetRole:'卫星遥感标校',queries:['卫星标校'],requiredAny:['遥感'],city:'自定义测试城',cityCode:'101999999'});
 await page.reload();await page.waitForFunction(()=>document.querySelector('[name="targetRole"]').value==='卫星遥感标校');
 assert.equal(await page.getByLabel('目标城市',{exact:true}).inputValue(),'自定义测试城');assert.equal(await page.getByLabel('目标岗位',{exact:true}).evaluate(element=>element.tagName),'INPUT');
 assert.equal(await page.getByLabel('选择目标岗位',{exact:true}).inputValue(),'卫星遥感标校');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.deepEqual(store.loadConfig().queries,['卫星标校']);assert.deepEqual(store.loadConfig().requiredAny,['遥感']);assert.equal(store.loadConfig().cityCode,'101999999');
});

test('main role field accepts a custom role without opening advanced settings and trims on save',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 await page.locator('#advanced-settings').evaluate(element=>{element.open=false;});
 await page.getByLabel('目标岗位',{exact:true}).fill('  卫星遥感标校  ');
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('save-feedback').textContent==='已保存');
 assert.equal(store.loadConfig().targetRole,'卫星遥感标校');assert.deepEqual(store.loadConfig().queries,['卫星遥感标校']);assert.equal(await page.getByLabel('目标岗位',{exact:true}).inputValue(),'卫星遥感标校');
 assert.equal(await page.locator('#advanced-settings').evaluate(element=>element.open),false);
 assert.equal(await page.locator('#notice').isVisible(),false);
});

test('role picker and typing can replace each other without submitting the helper or altering other settings',async t=>{
 const {page,store}=await roleRulesDashboard(t,[{targetRole:'AI Agent',keywords:['产品经理']}]);
 const input=page.getByLabel('目标岗位',{exact:true}),picker=page.getByLabel('选择目标岗位',{exact:true}),previous=store.loadConfig();
 let submitted,starts=0;page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/api/config'&&request.method()==='POST')submitted=request.postDataJSON();if(path==='/api/start')starts++;});
 await input.fill('卫星遥感标校');await input.press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='卫星遥感标校');assert.equal(await picker.inputValue(),'');
 await picker.selectOption('销售专员');assert.equal(await input.inputValue(),'销售专员');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='销售专员');
 await input.fill('机器人运动控制');await input.press('Tab');
 await page.waitForTimeout(2200);assert.equal(await input.inputValue(),'机器人运动控制');assert.equal(await picker.inputValue(),'');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.equal(store.loadConfig().targetRole,'机器人运动控制');assert.deepEqual(store.loadConfig().queries,['机器人运动控制']);assert.equal(Object.hasOwn(submitted,'rolePicker'),false);assert.equal(Object.hasOwn(submitted,'customRole'),false);assert.equal(starts,0);
 for(const key of ['city','cityCode','roleType','resumeName','autoRun','contactCompanyTarget','resumeCompanyTarget','delaySeconds','idleMinutes','batchBreakMinutes'])assert.deepEqual(store.loadConfig()[key],previous[key]);
 assert.deepEqual(store.loadConfig().roleTitleExclusions,previous.roleTitleExclusions);
});

test('role catalog is keyboard reachable beside the editable input',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 const input=page.getByLabel('目标岗位',{exact:true}),picker=page.getByLabel('选择目标岗位',{exact:true});
 await input.focus();await input.press('Tab');assert.equal(await picker.evaluate(element=>element===document.activeElement),true);
 await picker.press('Shift+Tab');assert.equal(await input.evaluate(element=>element===document.activeElement),true);
 await input.press('ControlOrMeta+A');await input.pressSequentially('Rust');await input.press('Tab');assert.equal(await input.inputValue(),'Rust');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.equal(store.loadConfig().targetRole,'Rust');assert.deepEqual(store.loadConfig().queries,['Rust']);
});

test('role input keeps IME intermediate text from triggering defaults or saving',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 const input=page.getByLabel('目标岗位',{exact:true});let defaults=0,posts=0;
 page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/api/role-defaults')defaults++;if(path==='/api/config'&&request.method()==='POST')posts++;});
 await input.focus();await input.dispatchEvent('compositionstart');
 await input.evaluate(element=>{element.value='机';element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'机'}));});
 await input.dispatchEvent('change');
 await page.locator('#config-form').evaluate(form=>form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('button[value="save"]')})));
 assert.equal(defaults,0);assert.equal(posts,0);assert.equal(store.loadConfig().targetRole,'AI Agent');
 await input.evaluate(element=>{element.value='机器人开发';element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'机器人开发'}));});
 await input.dispatchEvent('compositionend');await input.dispatchEvent('change');await input.press('Tab');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.equal(store.loadConfig().targetRole,'机器人开发');assert.deepEqual(store.loadConfig().queries,['机器人开发']);assert.equal(posts,1);assert.ok(defaults>=1);
});

test('blank role cannot be saved and a saved case variant keeps custom search filters',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);const input=page.getByLabel('目标岗位',{exact:true});let posts=0;
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/config'&&request.method()==='POST')posts++;});
 await input.fill('');await page.getByRole('button',{name:'保存设置',exact:true}).click();assert.equal(await input.evaluate(element=>element.checkValidity()),false);assert.equal(posts,0);
 await input.fill('   ');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('请选择或输入目标岗位'));assert.equal(posts,0);
 store.saveConfig({...store.loadConfig(),targetRole:'ａｉ  ａｇｅｎｔ',queries:['保留的检索词'],requiredAny:['自定义匹配']});
 await page.reload();await page.waitForFunction(()=>document.querySelector('[name="targetRole"]').value==='ａｉ  ａｇｅｎｔ');
 assert.equal(await page.getByLabel('选择目标岗位',{exact:true}).inputValue(),'AI Agent');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.equal(store.loadConfig().targetRole,'ａｉ  ａｇｅｎｔ');assert.deepEqual(store.loadConfig().queries,['保留的检索词']);assert.deepEqual(store.loadConfig().requiredAny,['自定义匹配']);
});


test('isolated record errors keep active dashboard running without a continue prompt',async t=>{
 const {page,store}=await roleRulesDashboard(t,[],{snapshot:()=>({status:'running',counts:{},cycle:2})});
 store.appendEvent({type:'job_skipped',message:'详情页与目标岗位不一致；已跳过该岗位，自动处理下一岗位'});
 await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent==='正在投递');
 assert.equal(await page.locator('#resume').isVisible(),false);assert.equal(await page.locator('#notice').isVisible(),false);assert.equal(await page.locator('#stop').isDisabled(),false);
 assert.match(await page.locator('#events').textContent(),/自动处理下一岗位/u);
});

test('browsing role choices restores automatic exclusions and preserves explicit edits',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 const role=page.getByLabel('选择目标岗位',{exact:true}),field=page.getByLabel('排除的岗位关键词（每行一个）');
 await field.fill('销售\n电销\n客服');
 await role.selectOption('销售专员');
 await page.waitForFunction(()=>!document.querySelector('[name="excludeKeywords"]').value.split('\n').includes('销售'));
 await role.selectOption('AI Agent');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value.startsWith('AI Agent\n'));
 assert.ok((await field.inputValue()).split('\n').includes('销售'));assert.ok((await field.inputValue()).split('\n').includes('电销'));
 await role.selectOption('销售专员');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='销售专员');
 await field.fill(`${await field.inputValue()}\n销售\n特定外包`);
 await role.selectOption('AI Agent');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value.startsWith('AI Agent\n'));
 await role.selectOption('销售专员');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='销售专员');
 assert.ok((await field.inputValue()).split('\n').includes('销售'));assert.ok((await field.inputValue()).split('\n').includes('特定外包'));
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.ok(store.loadConfig().excludeKeywords.includes('销售'));assert.ok(store.loadConfig().excludeKeywords.includes('特定外包'));
});

test('typed custom role families remove inherited blockers and restore them when returning to Agent',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 store.saveConfig({...store.loadConfig(),excludeKeywords:['销售','电销','客服']});await page.reload();await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');await page.locator('#advanced-settings').evaluate(element=>{element.open=true;});
 const input=page.getByLabel('目标岗位',{exact:true}),field=page.getByLabel('排除的岗位关键词（每行一个）');
 await field.fill(`${await field.inputValue()}\n特定外包`);await page.locator('#advanced-settings').evaluate(element=>{element.open=false;});
 await input.fill('海外销售工程师');await input.press('Tab');
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='海外销售工程师');
 assert.ok(!(await field.inputValue()).split('\n').includes('销售'));assert.ok(!(await field.inputValue()).split('\n').includes('电销'));assert.ok((await field.inputValue()).split('\n').includes('特定外包'));
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 const config=store.loadConfig(),result=evaluateJob({title:'海外销售工程师',description:'海外销售工程师',company:'示例公司',city:config.city,tags:['实习']},config);
 assert.equal(result.eligible,true,JSON.stringify(result.reasons));assert.equal(await page.locator('#advanced-settings').evaluate(element=>element.open),false);
 await page.getByLabel('选择目标岗位',{exact:true}).selectOption('AI Agent');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value.startsWith('AI Agent\n'));
 assert.ok((await field.inputValue()).split('\n').includes('销售'));assert.ok((await field.inputValue()).split('\n').includes('电销'));assert.ok((await field.inputValue()).split('\n').includes('特定外包'));
 await input.fill('在线客服专员');await input.press('Tab');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='在线客服专员');assert.ok(!(await field.inputValue()).split('\n').includes('客服'));
});

test('custom role metadata preserves new advanced exclusions edited while its response is pending',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 store.saveConfig({...store.loadConfig(),excludeKeywords:['销售','电销','客服']});await page.reload();await page.waitForFunction(()=>document.querySelector('[name="delaySeconds"]').value==='90');await page.locator('#advanced-settings').evaluate(element=>{element.open=true;});
 const input=page.getByLabel('目标岗位',{exact:true}),field=page.getByLabel('排除的岗位关键词（每行一个）');let release,requested;
 const held=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{requested=resolve;});t.after(()=>release());
 await page.route('**/api/role-defaults?role=*',async route=>{if(new URL(route.request().url()).searchParams.get('role')!=='海外销售工程师')return route.continue();requested();await held;await route.continue();});
 await input.fill('海外销售工程师');await input.press('Tab');await seen;
 await field.press('ControlOrMeta+End');await field.pressSequentially('\n特定外包');
 release();await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='海外销售工程师');
 assert.ok(!(await field.inputValue()).split('\n').includes('销售'));assert.ok(!(await field.inputValue()).split('\n').includes('电销'));assert.ok((await field.inputValue()).split('\n').includes('特定外包'));
 await field.fill(`${await field.inputValue()}\n销售`);
 await page.getByLabel('选择目标岗位',{exact:true}).selectOption('AI Agent');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value.startsWith('AI Agent\n'));
 await input.fill('海外销售工程师');await input.press('Tab');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='海外销售工程师');assert.ok((await field.inputValue()).split('\n').includes('销售'));
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);assert.ok(store.loadConfig().excludeKeywords.includes('销售'));
});

test('an explicit replacement exclusion list is honored before unknown role metadata arrives',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);let release,requested;
 const held=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{requested=resolve;});t.after(()=>release());
 await page.route('**/api/role-defaults?role=*',async route=>{requested();await held;await route.continue();});
 const input=page.getByLabel('目标岗位',{exact:true}),field=page.getByLabel('排除的岗位关键词（每行一个）');
 await input.fill('海外销售工程师');await input.press('Tab');await seen;await field.fill('销售\n特定外包');release();
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='海外销售工程师');assert.deepEqual((await field.inputValue()).split('\n'),['销售','特定外包']);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);assert.deepEqual(store.loadConfig().excludeKeywords,['销售','特定外包']);
});

test('an explicit replacement exclusion list is honored while an official role preset is pending',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);let release,requested;
 const held=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{requested=resolve;});t.after(()=>release());
 await page.route('**/api/role-defaults?role=*',async route=>{requested();await held;await route.continue();});
 await page.getByLabel('选择目标岗位',{exact:true}).selectOption('销售专员');await seen;await page.getByLabel('排除的岗位关键词（每行一个）').fill('销售\n特定外包');release();
 await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='销售专员');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);assert.deepEqual(store.loadConfig().excludeKeywords,['销售','特定外包']);
});

test('saved custom role keeps its explicit blocker and personal search terms through first save and role switches',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 store.saveConfig({...store.loadConfig(),targetRole:'海外销售工程师',queries:['保留的海外业务检索'],requiredAny:['自定义匹配'],excludeKeywords:['销售','特定外包']});
 await page.reload();await page.waitForFunction(()=>document.querySelector('[name="targetRole"]').value==='海外销售工程师');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),page.getByRole('button',{name:'保存设置',exact:true}).click()]);
 assert.deepEqual(store.loadConfig().queries,['保留的海外业务检索']);assert.deepEqual(store.loadConfig().requiredAny,['自定义匹配']);assert.deepEqual(store.loadConfig().excludeKeywords,['销售','特定外包']);
 const input=page.getByLabel('目标岗位',{exact:true}),field=page.getByLabel('排除的岗位关键词（每行一个）');
 await page.getByLabel('选择目标岗位',{exact:true}).selectOption('AI Agent');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value.startsWith('AI Agent\n'));
 await input.fill('海外销售工程师');await input.press('Tab');await page.waitForFunction(()=>document.querySelector('[name="queries"]').value==='海外销售工程师');assert.ok((await field.inputValue()).split('\n').includes('销售'));assert.ok((await field.inputValue()).split('\n').includes('特定外包'));
});

test('official broad city options and nationwide save their verified codes without typing',async t=>{
 const {page,store}=await roleRulesDashboard(t,[]);
 const city=page.getByLabel('目标城市',{exact:true}),save=page.getByRole('button',{name:'保存设置',exact:true});
 assert.ok(await city.locator('option').count()>=374);assert.equal(await city.locator('optgroup').count(),35);
 await city.selectOption('北屯市');
 assert.equal(await page.locator('[name="cityCode"]').inputValue(),'101132100');assert.equal(await page.locator('#city-code-field').isVisible(),false);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),save.click()]);
 assert.equal(store.loadConfig().city,'北屯市');assert.equal(store.loadConfig().cityCode,'101132100');
 await page.waitForFunction(()=>!document.querySelector('button[value="save"]').disabled);
 await city.selectOption('全国');
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.ok()),save.click()]);
 assert.equal(store.loadConfig().city,'全国');assert.equal(store.loadConfig().cityCode,'100010000');
 assert.equal(await page.locator('#custom-city-field').isVisible(),false);
});

test('basic settings keep role city and type visible while optional targets stay collapsed',async t=>{
 const {page}=await roleRulesDashboard(t,[]);
 await page.locator('#advanced-settings').evaluate(element=>{element.open=false;});
 for(const name of ['目标岗位','目标城市','岗位类型'])assert.equal(await page.getByLabel(name,{exact:true}).isVisible(),true);
 assert.equal(await page.locator('#goal-settings').isVisible(),false);
 assert.equal(await page.getByRole('button',{name:'开始投递',exact:true}).count(),1);
 await page.getByText('数量与高级设置',{exact:true}).click();
 assert.equal(await page.locator('#goal-settings').isVisible(),true);
});
