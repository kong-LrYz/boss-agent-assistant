import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { jobKey } from '../src/core.js';
import { ExtensionBrowser } from '../src/extension-browser.js';

const job={id:'a123',url:'https://www.zhipin.com/job_detail/a123.html',navigationUrl:'https://www.zhipin.com/job_detail/a123.html?ka=search',title:'AI Agent实习生',company:'示例科技',city:'北京',description:'开发LLM工具调用',tags:['实习']};
const fresh=()=>({verified:true,jobId:job.id,existing:false,emptyNew:true,greetingSent:false,greetingUncertain:false});
const resume=(patch={})=>({verified:true,status:'none',approved:false,dialog:false,options:[],...patch});
class FakeBridge {
 constructor({paired=true,connected=true,handlers={}}={}){this.paired=paired;this.connected=connected;this.handlers=handlers;this.calls=[];this.sequence=0;this.epoch=0;this.meta={url:'https://www.zhipin.com/web/user/',title:'BOSS',documentId:'doc0'};this.active=false;}
 snapshot(){return {paired:this.paired,connected:this.connected,epoch:String(this.epoch)};}
 isConnected(){return this.connected;}
 beginRun(){this.active=true;this.epoch++;this.calls.push({op:'BEGIN'});return String(this.epoch);}
 cancel(){this.active=false;this.epoch++;this.calls.push({op:'CANCEL'});return String(this.epoch);}
 async request(op,args,options={}){
  const old={...this.meta};this.calls.push({op,args,options});
  if(['NAV_SEARCH','NAV_JOB','NEXT_PAGE','OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(op))assert.deepEqual(options.target?.document,old,'effect must carry the latest document');
  if(['OPEN_SESSION','NAV_SEARCH','NAV_JOB'].includes(op)){
   const search=new URL('https://www.zhipin.com/web/geek/jobs');search.searchParams.set('city',args.cityCode);search.searchParams.set('query',args.query);
   this.meta={url:op==='NAV_JOB'?args.job.navigationUrl??args.job.url:op==='NAV_SEARCH'?search.href:args.url,title:'BOSS',documentId:`doc${++this.sequence}`};
  }
  let result=this.handlers[op]?await this.handlers[op](args,this):({OPEN_SESSION:{opened:true},STOP_SESSION:{closed:true},READ_STATUS:{loggedIn:true,account:'王同学',ready:true},NAV_SEARCH:{navigationStarted:true,destination:this.meta.url},NAV_JOB:{navigationStarted:true,destination:this.meta.url},READ_DETAIL:{job,contactExisting:false},READ_CONVERSATION:fresh(),READ_RESUME:resume(),OPEN_CONTACT:{clicked:true,existing:false},FILL_GREETING:{filled:true},SEND_GREETING:{clicked:true},REQUEST_RESUME:{clicked:true},SELECT_RESUME:{selected:true},CONFIRM_RESUME:{confirmed:true}}[op]??{});
  if(['NAV_SEARCH','NAV_JOB'].includes(op))return result;
  if(op==='READ_CONVERSATION'&&result.verified===false&&new URL(this.meta.url).pathname==='/web/geek/chat'&&result.previewAvailable===undefined)result={...result,previewAvailable:true};
  return {...result,meta:{...this.meta}};
 }
}
function setup(options={}){const bridge=new FakeBridge(options);const launches=[];let closes=0;const launcher={launch:async(profile,opts)=>{launches.push({profile,opts});},close:async()=>{closes++;}};const browser=new ExtensionBrowser({bridge,launcher,profileDir:'/tmp/dedicated-fixture',outputDir:'/tmp/fixture-output',timeoutMs:12,pollMs:1,navigationDelayMs:0,...options.browserOptions});return {browser,bridge,launches,get closes(){return closes;}};}
async function persistentStage(t){const dir=await mkdtemp(path.join(os.tmpdir(),'boss-extension-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new Store(dir);store.upsertJob(job);return {store,stage:async(name,patch)=>store.upsertJob(job,patch),disk:async()=>JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).jobs[jobKey(job)]};}

test('unpaired login preparation launches setup but never reads the website',async()=>{const {browser,bridge,launches}=setup({paired:false,connected:false});await browser.openForLogin();assert.equal(launches[0].opts.setup,true);assert.equal(bridge.calls.length,0);await assert.rejects(browser.open(),{code:'EXTENSION_REQUIRED'});assert.equal(bridge.calls.length,0);});
test('offline extension and absent positive account cannot claim login',async()=>{const offline=setup({connected:false});await assert.rejects(offline.browser.open(),{code:'EXTENSION_OFFLINE'});const missing=setup({handlers:{READ_STATUS:()=>({loggedIn:false,ready:true})}});await assert.rejects(missing.browser.login(),{code:'LOGIN_REQUIRED'});});
test('default cold session requests a bounded startup budget without delaying ready operations',async()=>{
 const sleeps=[];const {browser,bridge}=setup({browserOptions:{timeoutMs:undefined,sleep:async ms=>sleeps.push(ms)}});
 await browser.open();
 const startup=bridge.calls.filter(call=>call.op==='OPEN_SESSION');assert.equal(startup.length,1);assert.equal(startup[0].options.timeoutMs,15000);
 await browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'});
 assert.equal(bridge.calls.at(-1).options.timeoutMs,12000);
 assert.deepEqual(sleeps,[]);
});
for(const [options,expected]of [[{timeoutMs:40},40],[{timeoutMs:40,sessionTimeoutMs:15000},15000],[{timeoutMs:undefined,sessionTimeoutMs:3000},3000]])test(`cold session honors an explicitly chosen startup timeout (${expected} ms)`,async()=>{
 const {browser,bridge}=setup({browserOptions:options});await browser.open();assert.equal(bridge.calls.find(call=>call.op==='OPEN_SESSION').options.timeoutMs,expected);
});
test('a lost cold-session result remains one dispatch and never becomes an active browser session',async()=>{
 const sleeps=[],original=Object.assign(Error('fixture startup result lost'),{code:'UNKNOWN_RESULT'});const {browser,bridge}=setup({browserOptions:{timeoutMs:undefined,sleep:async ms=>sleeps.push(ms)},handlers:{OPEN_SESSION:()=>{throw original;}}});
 await assert.rejects(browser.open(),error=>error===original);assert.equal(browser.session,false);assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,1);assert.deepEqual(sleeps,[]);
});
for(const sessionTimeoutMs of[0,-1,15001,'15000'])test(`invalid cold-session timeout is rejected (${sessionTimeoutMs})`,()=>{
 assert.throws(()=>setup({browserOptions:{sessionTimeoutMs}}),TypeError);
});
test('cold browser startup conditionally waits for its paired extension without relaunching or duplicate sessions',async()=>{
 let clock=1000;const sleeps=[];const {browser,bridge,launches}=setup({connected:false,browserOptions:{timeoutMs:50,pollMs:10,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;if(sleeps.length===2)bridge.connected=true;}}});
 await browser.open();assert.equal(launches.length,1);assert.deepEqual(sleeps,[10,10]);assert.equal(bridge.calls.filter(call=>call.op==='BEGIN').length,1);assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,1);
});
test('cold browser startup wakes from connected events immediately and removes the event listener',async()=>{
 const emitter=new EventEmitter(),sleeps=[];let subscriptions=0;const {browser,bridge,launches}=setup({connected:false,browserOptions:{timeoutMs:500,pollMs:500,sleep:async ms=>sleeps.push(ms)}});
 bridge.on=(event,listener)=>{subscriptions++;emitter.on(event,listener);queueMicrotask(()=>{bridge.connected=true;emitter.emit('connected',bridge.snapshot());});return bridge;};bridge.off=(event,listener)=>{emitter.off(event,listener);return bridge;};
 await browser.open();assert.equal(subscriptions,1);assert.equal(emitter.listenerCount('connected'),0);assert.deepEqual(sleeps,[]);assert.equal(launches.length,1);assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,1);
});
test('cold browser startup has one bounded timeout when the paired extension never connects',async()=>{
 let clock=1000;const sleeps=[];const {browser,bridge,launches}=setup({connected:false,browserOptions:{timeoutMs:50,pollMs:20,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;}}});
 await assert.rejects(browser.open(),{code:'EXTENSION_OFFLINE'});assert.equal(clock,1050);assert.deepEqual(sleeps,[20,20,10]);assert.equal(launches.length,1);assert.equal(bridge.calls.length,0);
});
test('cold browser startup is checkpoint cancellable before creating an active session',async()=>{
 let stopped=false,clock=1000;const {browser,bridge}=setup({connected:false,browserOptions:{timeoutMs:12000,pollMs:250,now:()=>clock,sleep:async ms=>{clock+=ms;stopped=true;},checkpoint:async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});}}});
 await assert.rejects(browser.open(),{code:'STOPPED'});assert.ok(clock<12000);assert.equal(bridge.calls.length,0);
});
test('cold browser startup checks stop during event waiting and cleans its pending listener',async()=>{
 const emitter=new EventEmitter();let stopped=false;const {browser,bridge}=setup({connected:false,browserOptions:{timeoutMs:5000,pollMs:5000,checkpoint:async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});}}});
 bridge.on=emitter.on.bind(emitter);bridge.off=emitter.off.bind(emitter);const timer=setTimeout(()=>{stopped=true;},5),start=Date.now();
 try {await assert.rejects(browser.open(),{code:'STOPPED'});}finally{clearTimeout(timer);}
 assert.ok(Date.now()-start<1000,'stop must be observed well before the startup timeout');assert.equal(emitter.listenerCount('connected'),0);assert.equal(bridge.calls.length,0);
});
test('cold browser startup permits an inactive initial epoch refresh before extension readiness',async()=>{
 let clock=1000;const {browser,bridge}=setup({connected:false,browserOptions:{timeoutMs:50,pollMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;bridge.cancel();bridge.connected=true;}}});
 await browser.open();assert.equal(browser.epoch,bridge.snapshot().epoch);assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,1);assert.equal(bridge.calls.filter(call=>call.op==='BEGIN').length,1);
});
test('cold browser startup does not take over another run that becomes active while connecting',async()=>{
 let clock=1000;const {browser,bridge}=setup({connected:false,browserOptions:{timeoutMs:50,pollMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;bridge.beginRun();bridge.connected=true;}}});
 await assert.rejects(browser.open(),{code:'STOPPED'});assert.equal(bridge.calls.filter(call=>call.op==='BEGIN').length,1);assert.equal(bridge.calls.some(call=>call.op==='OPEN_SESSION'),false);assert.equal(bridge.active,true);
});
test('cold browser startup rejects an already active foreign epoch even with an immediate connection',async()=>{
 const {browser,bridge}=setup();bridge.beginRun();await assert.rejects(browser.open(),{code:'STOPPED'});assert.equal(bridge.calls.filter(call=>call.op==='BEGIN').length,1);assert.equal(bridge.calls.some(call=>call.op==='OPEN_SESSION'),false);
});
test('cold browser startup does not wait when extension installation or pairing is still required',async()=>{
 const sleeps=[];const {browser,bridge,launches}=setup({paired:false,connected:false,browserOptions:{sleep:async ms=>sleeps.push(ms)}});
 await assert.rejects(browser.open(),{code:'EXTENSION_REQUIRED'});assert.deepEqual(sleeps,[]);assert.equal(launches.length,1);assert.equal(bridge.calls.length,0);
});
test('cold browser startup stops waiting if its extension pairing disappears',async()=>{
 let clock=1000;const {browser,bridge}=setup({connected:false,browserOptions:{timeoutMs:50,pollMs:10,now:()=>clock,sleep:async ms=>{clock+=ms;bridge.paired=false;}}});
 await assert.rejects(browser.open(),{code:'EXTENSION_REQUIRED'});assert.equal(bridge.calls.length,0);
});
test('login risk is preserved before any job command',async()=>{const {browser,bridge}=setup({handlers:{READ_STATUS:()=>({risk:{code:'CAPTCHA',message:'请完成安全验证'}})}});await assert.rejects(browser.login(),{code:'CAPTCHA'});assert.equal(bridge.calls.some(call=>call.op==='NAV_SEARCH'),false);});
test('discover deduplicates canonical IDs and checks real pagination transitions',async()=>{let page=0;const {browser}=setup({handlers:{READ_CARDS:()=>({jobs:page?[job,{...job,id:'b123',url:'https://www.zhipin.com/job_detail/b123.html',navigationUrl:'https://www.zhipin.com/job_detail/b123.html?ka=two'}]:[job],empty:false,next:{available:!page,disabled:Boolean(page)},signature:String(page)}),NEXT_PAGE:()=>{page++;return {clicked:true};}}});const jobs=await browser.discover('AI Agent',{cityCode:'101010100',maxPages:3});assert.equal(jobs.length,2);assert.equal(jobs[0].navigationUrl,job.navigationUrl);});
test('unchanged pagination fails instead of silently finishing',async()=>{const {browser}=setup({handlers:{READ_CARDS:()=>({jobs:[job],empty:false,next:{available:true,disabled:false},signature:'same'}),NEXT_PAGE:()=>({clicked:true})}});await assert.rejects(browser.discover('AI Agent',{cityCode:'101010100',maxPages:2}),{code:'PAGE_CHANGED'});});
test('details reject a changed job identity',async()=>{const {browser}=setup({handlers:{READ_DETAIL:()=>({job:{...job,id:'other',url:'https://www.zhipin.com/job_detail/other.html'}})}});await assert.rejects(browser.details(job),{code:'RECIPIENT_UNVERIFIED'});});

test('a missing unique contact button fails before intent or any contact command', async t => {
 const {stage,disk}=await persistentStage(t);const stages=[];
 const {browser,bridge}=setup({handlers:{
  READ_DETAIL:()=>({job,contactExisting:false,contactAvailable:false}),
  READ_CONVERSATION:()=>({verified:false}),
  OPEN_CONTACT:()=>{throw Object.assign(new Error('无唯一沟通按钮'),{code:'PAGE_CHANGED'});}
 }});
 await assert.rejects(browser.contact(job,{greeting:'你好',onStage:async(name,patch)=>{stages.push(name);await stage(name,patch);}}),{code:'PAGE_CHANGED'});
 assert.deepEqual(stages,[]);
 const record=await disk();assert.equal(record.greetingStatus,'none');assert.equal(record.resumeStatus,'none');
 assert.equal(bridge.calls.some(call=>['OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});

test('a verified conversation does not need a detail contact button', async t => {
 const {stage,disk}=await persistentStage(t);
 const {browser,bridge}=setup({handlers:{
  READ_DETAIL:()=>({job,contactExisting:false,contactAvailable:false}),
  READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),
  READ_RESUME:()=>resume({status:'sent',text:'王同学.pdf'})
 }});
 const result=await browser.contact(job,{resumeOnly:true,onStage:stage});
 assert.equal(result.greetingStatus,'existing');assert.equal(result.resumeStatus,'sent');
 assert.equal((await disk()).greetingStatus,'existing');
 assert.equal(bridge.calls.some(call=>['OPEN_CONTACT','SEND_GREETING','REQUEST_RESUME'].includes(call.op)),false);
});
test('native greeting and resume request require persisted intents without duplicate greeting',async t=>{const {store,stage,disk}=await persistentStage(t);let opened=false;let requested=false;const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>opened?{...fresh(),existing:true,emptyNew:false,greetingSent:true}: {verified:false},OPEN_CONTACT:async()=>{assert.equal((await disk()).greetingStatus,'intent');opened=true;return {clicked:true,existing:false};},READ_RESUME:()=>resume(requested?{status:'requested',text:'等待对方同意'}:{}),REQUEST_RESUME:async()=>{assert.equal((await disk()).resumeStatus,'intent');requested=true;return {clicked:true};}}});const result=await browser.contact(job,{greeting:'自定义招呼',onStage:stage});assert.equal(result.greetingStatus,'sent');assert.equal(result.resumeStatus,'requested');assert.equal(store.listJobs()[0].resumeStatus,'requested');assert.equal(bridge.calls.some(call=>call.op==='SEND_GREETING'),false);});
test('verified new empty conversation permits one custom greeting',async t=>{const {stage,disk}=await persistentStage(t);let opened=false,sent=false;const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>opened?{...fresh(),greetingSent:sent,existing:sent,emptyNew:!sent}:{verified:false},OPEN_CONTACT:()=>{opened=true;return {clicked:true,existing:false};},SEND_GREETING:async()=>{assert.equal((await disk()).greetingStatus,'intent');sent=true;return {clicked:true};},READ_RESUME:()=>resume({status:'sent',text:'王同学.pdf'})}});const result=await browser.contact(job,{greeting:'你好',onStage:stage});assert.equal(result.greetingStatus,'sent');assert.equal(bridge.calls.filter(call=>call.op==='SEND_GREETING').length,1);});
test('resumeOnly uses continuing contact and refuses a new native greeting',async t=>{const {stage}=await persistentStage(t);let opened=false;const good=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:true}),READ_CONVERSATION:()=>opened?{...fresh(),existing:true,emptyNew:false}:{verified:false},OPEN_CONTACT:args=>{assert.equal(args.resumeOnly,true);opened=true;return {existing:true,clicked:true};},READ_RESUME:()=>resume({status:'requested'})}});assert.equal((await good.browser.contact(job,{resumeOnly:true,onStage:stage})).greetingStatus,'existing');const bad=setup({handlers:{READ_CONVERSATION:()=>({verified:false})}});await assert.rejects(bad.browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.equal(bad.bridge.calls.some(call=>call.op==='OPEN_CONTACT'),false);});
test('multiple attachments need exact name before confirm and recheck delivery',async t=>{const {stage,disk}=await persistentStage(t);let requested=false,sent=false;const {browser}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume(sent?{status:'sent',text:'王同学.pdf'}:requested?{dialog:true,options:[{name:'王同学.pdf',index:0},{name:'其他.pdf',index:1}]}:{}),REQUEST_RESUME:()=>{requested=true;return {clicked:true};},SELECT_RESUME:args=>{assert.equal(args.resumeName,'王同学.pdf');return {selected:true};},CONFIRM_RESUME:async()=>{assert.equal((await disk()).resumeStatus,'intent');sent=true;return {confirmed:true};}}});assert.equal((await browser.contact(job,{resumeName:'王同学.pdf',onStage:stage})).resumeStatus,'sent');});
test('lost send result becomes uncertainty and is not replayed',async t=>{const {store,stage}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),REQUEST_RESUME:()=>{throw Object.assign(new Error('回执丢失'),{code:'UNKNOWN_RESULT'});}}});const result=await browser.contact(job,{onStage:stage});assert.equal(result.resumeStatus,'uncertain');assert.equal(store.listJobs()[0].resumeStatus,'uncertain');assert.equal(bridge.calls.filter(call=>call.op==='REQUEST_RESUME').length,1);});
test('close cancels leases before cleanup, shutdown alone closes normal Chrome',async()=>{const state=setup();await state.browser.open();await state.browser.close();const tail=state.bridge.calls.slice(-2).map(call=>call.op);assert.deepEqual(tail,['CANCEL','STOP_SESSION']);assert.equal(state.closes,0);await state.browser.shutdown();assert.equal(state.closes,1);});
test('adapter exposes fixed operations and contains no generic DOM executor',async()=>{const source=await readFile(new URL('../src/extension-browser.js',import.meta.url),'utf8');assert.doesNotMatch(source,/executeScript|querySelector|\.click\(|\beval\s*\(|new Function/u);});
test('continuing button observed earlier still persists intent before ordinary contact click',async t=>{const {stage,disk}=await persistentStage(t);let opened=false;const {browser}=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:true}),READ_CONVERSATION:()=>opened?{...fresh(),greetingSent:true,existing:true,emptyNew:false}:{verified:false},OPEN_CONTACT:async()=>{assert.equal((await disk()).greetingStatus,'intent');opened=true;return {clicked:true,existing:false};},READ_RESUME:()=>resume({status:'sent'})}});assert.equal((await browser.contact(job,{onStage:stage})).greetingStatus,'sent');});
test('unverified reopened existing chat fails without inventing a new greeting result',async t=>{const {stage,store}=await persistentStage(t);const {browser}=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:true}),READ_CONVERSATION:()=>({verified:false}),OPEN_CONTACT:()=>({clicked:true,existing:true})}});await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.notEqual(store.listJobs()[0].greetingStatus,'uncertain');});
test('an epoch change rebuilds the session before further work',async()=>{const {browser,bridge}=setup();await browser.open();bridge.cancel();await browser.open();assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,2);assert.equal(bridge.active,true);});
test('navigation pacing waits before dispatch and remains cancellable',async()=>{const {browser,bridge}=setup();browser.navigationDelayMs=40;await browser.open();await browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'});await browser.call('READ_STATUS');const start=Date.now();await browser.call('NAV_JOB',{job});assert.ok(Date.now()-start>=35);await browser.call('READ_STATUS');let checkpoints=0;browser.checkpoint=async()=>{if(++checkpoints===3)throw Object.assign(new Error('停止'),{code:'CANCELLED'});};await assert.rejects(browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'}),{code:'CANCELLED'});assert.equal(bridge.calls.filter(call=>call.op==='NAV_SEARCH').length,1);});
test('approved historical request can become a real attachment after confirmation',async t=>{const {stage}=await persistentStage(t);let requested=false,sent=false;const {browser}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume(sent?{status:'sent',text:'王同学.pdf'}:{status:'requested',approved:true,dialog:requested,options:requested?[{name:'王同学.pdf',index:0}]:[]}),REQUEST_RESUME:()=>{requested=true;return {clicked:true};},CONFIRM_RESUME:()=>{sent=true;return {confirmed:true};}}});assert.equal((await browser.contact(job,{resumeOnly:true,onStage:stage})).resumeStatus,'sent');});
test('a failed intent write prevents the corresponding external contact',async()=>{const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({verified:false})}});await assert.rejects(browser.contact(job,{onStage:async()=>{throw Error('磁盘写入失败');}}),/磁盘写入失败/u);assert.equal(bridge.calls.some(call=>call.op==='OPEN_CONTACT'),false);});
test('adapter and real Chromium DOM executor complete the local greeting and attachment flow',async t=>{
 const source=(await readFile(new URL('./fixtures/job.html',import.meta.url),'utf8')).replace('__MODE__','custom').replace('</html>','<nav class="user-nav"><div class="user-name">王同学</div></nav></html>');
 const chromiumBrowser=await chromium.launch({headless:true});const page=await chromiumBrowser.newPage();t.after(()=>chromiumBrowser.close());
 let fixtureRequests=0;
 await page.context().route('**/*',route=>{const request=new URL(route.request().url());if(request.origin==='https://www.zhipin.com'){fixtureRequests++;return route.fulfill({contentType:'text/html;charset=utf-8',body:source});}return route.abort();});
 const url='https://www.zhipin.com/job_detail/a123.html?ka=search';const executor=new URL('../extension/dom-executor.js',import.meta.url);await page.addInitScript({path:fileURLToPath(executor)});await page.goto(url);assert.equal(page.url(),url);
 const {store,disk}=await persistentStage(t);const domJob={...job,title:'AI Agent开发实习生'};const state=setup();
 const run=async(op,args)=>{const result=await page.evaluate(command=>BossDomExecutor.execute(command),{op,args,expiresAt:Date.now()+8000,expectedDocument:state.bridge.meta});state.bridge.meta=result.meta;return result;};
 state.bridge.handlers.OPEN_SESSION=async()=>{state.bridge.meta=await page.evaluate(()=>BossDomExecutor.metadata());return {opened:true};};
 state.bridge.handlers.NAV_JOB=async args=>{await page.goto(url);assert.equal(page.url(),url);state.bridge.meta=await page.evaluate(()=>BossDomExecutor.metadata());return {navigationStarted:true,destination:args.job.navigationUrl};};
 for(const op of ['READ_STATUS','READ_DETAIL','READ_CONVERSATION','READ_RESUME','OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'])state.bridge.handlers[op]=async args=>{if(op==='OPEN_CONTACT'||op==='SEND_GREETING')assert.equal((await disk()).greetingStatus,'intent');if(op==='REQUEST_RESUME'||op==='CONFIRM_RESUME')assert.equal((await disk()).resumeStatus,'intent');return run(op,args);};
 const result=await state.browser.contact(domJob,{greeting:'你好，我对该岗位感兴趣。',onStage:async(stage,patch)=>store.upsertJob(domJob,patch)});assert.equal(result.greetingStatus,'sent');assert.equal(result.resumeStatus,'sent');assert.match(result.evidence.message,/王同学\.pdf/u);assert.equal(await page.evaluate(()=>Boolean(window.wrongRecipientSent)),false);assert.ok(fixtureRequests>=2);
});
test('login waits for explicitly pending account hydration after opening the session',async()=>{
 let clock=1000;const sleeps=[];const pending=()=>({authPending:true,ready:true,risk:{code:'LOGIN_REQUIRED',message:'登录入口的账号标记尚未显示'}});const {browser,bridge}=setup({browserOptions:{timeoutMs:80,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}},handlers:{OPEN_SESSION:pending,READ_STATUS:()=>clock<1020?pending():{ready:true,loggedIn:true,account:'王同学'}}});
 const result=await browser.login();assert.equal(result.loggedIn,true);assert.equal(result.account,'王同学');assert.equal(clock,1020);assert.deepEqual(sleeps,[5,5,5,5]);assert.equal(bridge.calls.filter(call=>call.op==='READ_STATUS').length,5);assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,1);assert.equal(bridge.calls.some(call=>['NAV_SEARCH','NAV_JOB','OPEN_CONTACT'].includes(call.op)),false);
});
test('readiness negative acknowledgements wait for late login hydration without reopening the session',async()=>{
 let clock=1000,reads=0;const sleeps=[];const {browser,bridge,launches}=setup({browserOptions:{timeoutMs:50,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}},handlers:{READ_STATUS:()=>{if(++reads<3)throw Object.assign(Error('not hydrated'),{code:'PAGE_NOT_READY'});return{ready:true,loggedIn:true,account:'测试账号'};}}});
 const result=await browser.login();assert.equal(result.loggedIn,true);assert.equal(reads,3);assert.deepEqual(sleeps,[5,5]);assert.equal(launches.length,1);assert.equal(bridge.calls.filter(call=>call.op==='OPEN_SESSION').length,1);assert.equal(bridge.calls.some(call=>['NAV_SEARCH','NAV_JOB','OPEN_CONTACT','REQUEST_RESUME'].includes(call.op)),false);
});
for(const op of ['READ_STATUS','INSPECT_PAGE','READ_CARDS','READ_DETAIL','READ_CONVERSATION','READ_RESUME','READ_CONTACT_CONFIRMATION','READ_CONVERSATION_VERIFICATION'])test(`readiness negative acknowledgements retry only the pending read (${op})`,async()=>{
 let clock=1000,reads=0;const {browser,bridge}=setup({browserOptions:{timeoutMs:50,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;}},handlers:{[op]:()=>{if(++reads===1)throw Object.assign(Error('pending'),{code:'PAGE_NOT_READY'});return{ready:true};}}});await browser.open();bridge.calls.length=0;
 assert.equal((await browser.until(()=>browser.call(op),value=>value.ready===true,null)).ready,true);assert.equal(reads,2);assert.deepEqual(bridge.calls.map(call=>call.op),[op,op]);
});
test('readiness negative acknowledgements terminate at the original deadline',async()=>{
 let clock=1000;const sleeps=[];const {browser,bridge}=setup({browserOptions:{timeoutMs:12,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}},handlers:{READ_STATUS:()=>{throw Object.assign(Error('pending'),{code:'PAGE_NOT_READY'});}}});await browser.open();
 assert.equal(await browser.until(()=>browser.call('READ_STATUS'),()=>true,null),null);assert.equal(clock,1012);assert.deepEqual(sleeps,[5,5,2]);assert.equal(bridge.calls.filter(call=>call.op==='READ_STATUS').length,3);
});
test('readiness negative acknowledgement timeouts preserve the caller readiness error contract',async()=>{
 let clock=1000;const {browser}=setup({browserOptions:{timeoutMs:10,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;}},handlers:{READ_CARDS:()=>{throw Object.assign(Error('pending'),{code:'PAGE_NOT_READY'});}}});await browser.open();
 await assert.rejects(browser.until(()=>browser.call('READ_CARDS'),()=>true,'cards not ready'),{code:'PAGE_CHANGED',message:'cards not ready'});
});
for(const op of ['OPEN_SESSION','NAV_JOB','OPEN_CONTACT','REQUEST_RESUME','CONFIRM_RESUME'])test(`readiness negative acknowledgements never repeat an effect (${op})`,async()=>{
 const original=Object.assign(Error('effect not ready'),{code:'PAGE_NOT_READY'}),sleeps=[];const {browser,bridge}=setup({browserOptions:{sleep:async ms=>sleeps.push(ms)}});await browser.open();bridge.calls.length=0;bridge.handlers[op]=()=>{throw original;};
 await assert.rejects(browser.until(()=>browser.call(op,op==='OPEN_SESSION'?{url:'https://www.zhipin.com/web/user/'}:{job}),()=>true,null),error=>error===original);assert.equal(bridge.calls.filter(call=>call.op===op).length,1);assert.deepEqual(sleeps,[]);
});
for(const code of ['CAPTCHA','UNKNOWN_RESULT','DOCUMENT_CHANGED','PAGE_CHANGED','RATE_LIMIT','LOGIN_REQUIRED'])test(`readiness negative acknowledgements do not swallow ${code}`,async()=>{
 const original=Object.assign(Error('blocked'),{code}),sleeps=[];const {browser,bridge}=setup({browserOptions:{sleep:async ms=>sleeps.push(ms)},handlers:{READ_STATUS:()=>{throw original;}}});await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.until(()=>browser.call('READ_STATUS'),()=>true,null),error=>error===original);assert.equal(bridge.calls.length,1);assert.deepEqual(sleeps,[]);
});
test('readiness negative acknowledgement without a known read operation is never retried',async()=>{
 const original=Object.assign(Error('unknown operation pending'),{code:'PAGE_NOT_READY'}),sleeps=[];const {browser}=setup({browserOptions:{sleep:async ms=>sleeps.push(ms)}});let reads=0;
 await assert.rejects(browser.until(async()=>{reads++;throw original;},()=>true,null),error=>error===original);assert.equal(reads,1);assert.deepEqual(sleeps,[]);
});
test('readiness negative acknowledgement waiting observes stop even on its final deadline slice',async()=>{
 let clock=1000,stopped=false;const {browser,bridge}=setup({browserOptions:{timeoutMs:5,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;stopped=true;},checkpoint:async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});}},handlers:{READ_STATUS:()=>{throw Object.assign(Error('pending'),{code:'PAGE_NOT_READY'});}}});await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.until(()=>browser.call('READ_STATUS'),()=>true,null),{code:'STOPPED'});assert.equal(bridge.calls.length,1);
});
test('readiness negative acknowledgements leave the transient read retry budget available',async()=>{
 let clock=1000,reads=0;const sleeps=[];const {browser,bridge}=setup({browserOptions:{timeoutMs:1000,pollMs:1,now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}},handlers:{READ_CARDS:()=>{const count=++reads;if(count===1)throw Object.assign(Error('pending'),{code:'PAGE_NOT_READY'});if(count===2||count===3)throw Object.assign(Error('transient'),{code:'EPIPE'});return{ready:true};}}});await browser.open();bridge.calls.length=0;
 assert.equal((await browser.until(()=>browser.call('READ_CARDS'),value=>value.ready,null)).ready,true);assert.equal(reads,4);assert.equal(sleeps[0],1);assert.equal(sleeps.reduce((total,ms)=>total+ms,0),751);assert.equal(bridge.calls.filter(call=>call.op==='READ_CARDS').length,4);
});
test('visible login controls remain an immediate pause during account hydration',async()=>{
 const {browser,bridge}=setup({handlers:{OPEN_SESSION:()=>({authPending:false,risk:{code:'LOGIN_REQUIRED',message:'可见登录对话框'}}),READ_STATUS:()=>({ready:true,loggedIn:true,account:'王同学'})}});await assert.rejects(browser.login(),{code:'LOGIN_REQUIRED'});assert.equal(bridge.calls.some(call=>call.op==='READ_STATUS'),false);
});
test('account hydration without a positive account times out and dispatches no search',async()=>{
 let clock=1000;const sleeps=[];const pending=()=>({authPending:true,ready:true,risk:{code:'LOGIN_REQUIRED',message:'账号标记尚未显示'}});const {browser,bridge}=setup({browserOptions:{timeoutMs:12,pollMs:5,now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}},handlers:{OPEN_SESSION:pending,READ_STATUS:pending}});
 await assert.rejects(browser.login(),{code:'LOGIN_REQUIRED'});assert.equal(clock,1012);assert.deepEqual(sleeps,[5,5,2]);assert.equal(bridge.calls.filter(call=>call.op==='READ_STATUS').length,3);assert.equal(bridge.calls.some(call=>['NAV_SEARCH','NAV_JOB','OPEN_CONTACT'].includes(call.op)),false);
});
test('account-pending exceptions never authorize other operations or other risks',async()=>{const pending={authPending:true,risk:{code:'LOGIN_REQUIRED',message:'账号标记尚未显示'}};const {browser}=setup({handlers:{READ_CARDS:()=>pending,NAV_SEARCH:()=>pending,READ_STATUS:()=>({authPending:true,risk:{code:'CAPTCHA',message:'验证'}})}});await browser.open();await assert.rejects(browser.call('READ_CARDS'),{code:'LOGIN_REQUIRED'});await assert.rejects(browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'}),{code:'PAGE_CHANGED'});await assert.rejects(browser.call('READ_STATUS'),{code:'CAPTCHA'});});
test('an explicitly pending session cannot dispatch navigation before account confirmation',async()=>{const {browser,bridge}=setup({handlers:{OPEN_SESSION:()=>({authPending:true,risk:{code:'LOGIN_REQUIRED',message:'账号标记尚未显示'}})}});await browser.open();await assert.rejects(browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'}),{code:'LOGIN_REQUIRED'});assert.equal(bridge.calls.some(call=>call.op==='NAV_SEARCH'),false);});

test('a navigation start acknowledgement clears old document and detail evidence',async()=>{
 const {browser,bridge}=setup();await browser.open();browser.detail={job};
 assert.deepEqual(await browser.call('NAV_JOB',{job}),{navigationStarted:true,destination:'https://www.zhipin.com/job_detail/a123.html?ka=search'});
 assert.equal(browser.meta,null);assert.equal(browser.detail,null);
 assert.equal(bridge.calls.at(-1).options.target.document.documentId,'doc1');
});
for(const result of [
 {navigationStarted:false,destination:'https://www.zhipin.com/job_detail/a123.html?ka=search'},
 {navigationStarted:true,destination:'https://www.zhipin.com/job_detail/other.html'},
 {navigationStarted:true,destination:'https://www.zhipin.com/job_detail/a123.html'},
 {navigationStarted:true,destination:'https://www.zhipin.com/job_detail/a123.html?ka=search',meta:{url:job.url,documentId:'old-doc'}}
])test(`invalid navigation acknowledgement fails before reading detail (${JSON.stringify(result)})`,async()=>{
 const {browser,bridge}=setup({handlers:{NAV_JOB:()=>result}});
 await assert.rejects(browser.details(job),{code:'PAGE_CHANGED'});
 assert.equal(bridge.calls.some(call=>['READ_STATUS','READ_DETAIL'].includes(call.op)),false);
});
test('detail reading waits for a ready destination through read-only inspection',async()=>{
 let inspections=0;const {browser,bridge}=setup({handlers:{READ_STATUS:()=>({ready:++inspections>=3,loggedIn:true,account:'王同学'})}});browser.timeoutMs=50;
 assert.equal((await browser.details(job)).id,'a123');
 assert.equal(inspections,3);
 assert.equal(bridge.calls.filter(call=>call.op==='NAV_JOB').length,1);
 const first=bridge.calls.find(call=>call.op==='READ_STATUS');assert.equal(first.options.target,undefined);
 assert.equal(bridge.calls.findIndex(call=>call.op==='READ_DETAIL')>bridge.calls.map(call=>call.op).lastIndexOf('READ_STATUS'),true);
});
for(const wrongUrl of [
 'https://www.zhipin.com/job_detail/other.html',
 'https://www.zhipin.com.evil.example/job_detail/a123.html',
 'http://www.zhipin.com/job_detail/a123.html',
 'https://user@www.zhipin.com/job_detail/a123.html'
])test(`a ready detail at a different destination is never read (${wrongUrl})`,async()=>{
 const {browser,bridge}=setup({handlers:{READ_STATUS:(_args,current)=>{current.meta.url=wrongUrl;return{ready:true,loggedIn:true,account:'王同学'};}}});
 await assert.rejects(browser.details(job),{code:'PAGE_CHANGED'});
 assert.equal(bridge.calls.filter(call=>call.op==='NAV_JOB').length,1);
 assert.equal(bridge.calls.some(call=>call.op==='READ_DETAIL'),false);
});
for(const wrongUrl of [
 'https://www.zhipin.com/web/geek/jobs?city=101020100&query=AI+Agent',
 'https://www.zhipin.com/web/geek/jobs?city=101010100&query=Java',
 'https://www.zhipin.com/web/geek/jobs?city=101010100&city=101020100&query=AI+Agent',
 'https://www.zhipin.com/web/geek/jobs?city=101010100&query=AI+Agent&query=Java',
 'https://www.zhipin.com/other?city=101010100&query=AI+Agent'
])test(`a ready search with mismatched city or query is never read (${wrongUrl})`,async()=>{
 const {browser,bridge}=setup({handlers:{READ_STATUS:(_args,current)=>{current.meta.url=wrongUrl;return{ready:true,loggedIn:true,account:'王同学'};}}});
 await assert.rejects(browser.discover('AI Agent',{cityCode:'101010100',maxPages:1}),{code:'PAGE_CHANGED'});
 assert.equal(bridge.calls.filter(call=>call.op==='NAV_SEARCH').length,1);
 assert.equal(bridge.calls.some(call=>call.op==='READ_CARDS'),false);
});

test('routine readiness uses compact status and a resume goal skips every attachment operation',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false,greetingSent:true})}});
 const result=await browser.contact(job,{sendResume:false,onStage:stage});
 assert.equal(result.greetingStatus,'existing');assert.equal(result.resumeSkipped,true);assert.equal((await disk()).resumeStatus,'none');
 assert.equal(bridge.calls.some(call=>['READ_RESUME','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
 assert.ok(bridge.calls.some(call=>call.op==='READ_STATUS'));assert.equal(bridge.calls.some(call=>call.op==='INSPECT_PAGE'),false);
});
test('resume inspection rejects ordinary outreach before opening or persisting a job',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup();
 await assert.rejects(browser.contact(job,{inspectResumeOnly:true,onStage:stage}),{code:'INVALID_COMMAND'});
 assert.equal(bridge.calls.length,0);assert.equal((await disk()).greetingStatus,'none');assert.equal((await disk()).resumeStatus,'none');
});
test('resume inspection reads an existing verified conversation without an attachment intent or effect',async t=>{
 const {stage,disk}=await persistentStage(t);const stages=[];
 const structure={chat:[{tag:'button',classes:'resume-agree',textLength:2,visible:true,disabled:false,selected:false,caption:'同意',directChildren:[],ancestors:[]}],dialogs:[]};
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({status:'none',resumeStructure:structure})}});
 const result=await browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,sendResume:false,onStage:async(name,patch)=>{stages.push(name);await stage(name,patch);}});
 assert.equal(result.resumeInspection,true);assert.equal(result.resumeSkipped,true);assert.equal(result.resumeStatus,'none');assert.deepEqual(result.resumeStructure,structure);
 assert.equal((await disk()).resumeStatus,'none');assert.equal(stages.some(name=>name.startsWith('resume-')),false);
 assert.equal(bridge.calls.filter(call=>call.op==='READ_RESUME').length,1);assert.equal(bridge.calls.some(call=>['OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
test('resume inspection preserves confirmed observations without persisting them as application effects',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({status:'sent',approved:true,dialog:true,options:[{name:'PRIVATE_FILE.pdf'}],text:'PRIVATE_MESSAGE_BODY',resumeStructure:{chat:[],dialogs:[]}})}});
 const result=await browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage});assert.equal(result.resumeStatus,'sent');assert.deepEqual(result.resumeObservation,{status:'sent',approved:true,dialog:true,optionCount:1});assert.equal((await disk()).resumeStatus,'none');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/u);
 assert.equal(bridge.calls.some(call=>['REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
test('resume inspection must verify actual portal job identity before reading an attachment',async t=>{
 const {stage}=await persistentStage(t);let bound=false;
 const {browser,bridge}=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:true}),READ_CONVERSATION:()=>bound?{...fresh(),existing:true,emptyNew:false}:{verified:false},OPEN_CONTACT:(args,b)=>{assert.equal(args.resumeOnly,true);b.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'portal'};return{existing:true,clicked:true};},VERIFY_CONVERSATION_JOB:()=>({previewStarted:true}),READ_CONVERSATION_VERIFICATION:()=>{bound=true;return{verified:true,jobId:job.id};},READ_RESUME:()=>{assert.equal(bound,true);return resume({resumeStructure:{chat:[],dialogs:[]}});}}});
 const result=await browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage});assert.equal(result.resumeInspection,true);assert.equal(bridge.calls.filter(call=>call.op==='VERIFY_CONVERSATION_JOB').length,1);assert.equal(bridge.calls.some(call=>['FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
test('resume inspection refuses a new contact and an actual portal identity mismatch',async t=>{
 const {stage}=await persistentStage(t);const first=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:false}),READ_CONVERSATION:()=>({verified:false})}});
 await assert.rejects(first.browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.equal(first.bridge.calls.some(call=>['OPEN_CONTACT','READ_RESUME','REQUEST_RESUME'].includes(call.op)),false);
 let opened=false;const second=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:true}),READ_CONVERSATION:()=>({verified:false}),OPEN_CONTACT:(_args,b)=>{opened=true;b.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'portal'};return{existing:true};},VERIFY_CONVERSATION_JOB:()=>({previewStarted:true}),READ_CONVERSATION_VERIFICATION:()=>({verified:true,jobId:'different-job'})}});
 await assert.rejects(second.browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.equal(opened,true);assert.equal(second.bridge.calls.some(call=>['READ_RESUME','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
test('resume inspection sanitizes and bounds structure returned by its own extension',async t=>{
 const {stage}=await persistentStage(t);const raw={tag:'div',classes:'resume-card '.repeat(30),textLength:300,visible:true,disabled:false,selected:false,caption:'PRIVATE_BODY',text:'PRIVATE_BODY',href:'https://private.invalid/',directChildren:Array.from({length:20},()=>({tag:'span',classes:'file-name',textLength:12,visible:true,disabled:false,selected:false,text:'PRIVATE_FILE.pdf'})),ancestors:Array.from({length:8},()=>({tag:'section',classes:'messages',textLength:500,visible:true,disabled:false,selected:false}))};
 const {browser}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({resumeStructure:{chat:Array.from({length:40},()=>raw),dialogs:Array.from({length:10},()=>raw)}})}});
 const result=await browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage}),structure=result.resumeStructure;assert.ok(structure.chat.length<=12);assert.ok(structure.dialogs.length<=2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private\.invalid/u);assert.ok(new TextEncoder().encode(JSON.stringify(structure)).length<=8192);
 for(const node of [...structure.chat,...structure.dialogs]){assert.ok(node.classes.length<=160);assert.ok(node.directChildren.length<=6);assert.ok(node.ancestors.length<=2);}
});
test('resume inspection retains only the public attachment view caption without private receipt content',async t=>{
 const {stage}=await persistentStage(t);const structure={chat:[{tag:'span',classes:'unfamiliar-view-leaf',textLength:6,visible:true,disabled:false,selected:false,caption:'点击查看附件',text:'PRIVATE_SYSTEM_RECEIPT',href:'https://private.invalid/',directChildren:[],ancestors:[]}],dialogs:[]};
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({resumeStructure:structure})}});
 const result=await browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage});assert.equal(result.resumeStructure.chat[0].caption,'点击查看附件');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private\.invalid/u);assert.equal(bridge.calls.some(call=>['REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
test('resume inspection rejects an unrecognized private status before returning observations',async t=>{
 const {stage}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({status:'PRIVATE_STATUS_VALUE'})}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,onStage:stage}),{code:'PAGE_CHANGED'});assert.equal(bridge.calls.some(call=>['REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
const diagnosticStructure=(caption='发简历')=>({chat:[{tag:'div',classes:'toolbar-btn',textLength:3,visible:true,disabled:false,selected:false,caption,directChildren:[],ancestors:[]}],dialogs:[]});
test('resume failure diagnostics preserve selection errors and capture the still bound modal once',async t=>{
 const {stage,disk}=await persistentStage(t);let requested=false;
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({dialog:requested,options:[],resumeStructure:diagnosticStructure()}),REQUEST_RESUME:()=>{requested=true;return{clicked:true};},INSPECT_PAGE:()=>({resumeStructure:{chat:[],dialogs:[{tag:'section',classes:'unknown-resume-modal',textLength:14,visible:true,disabled:false,selected:false,directChildren:[],ancestors:[]}]},lastOperationDiagnostic:{op:'REQUEST_RESUME',errorCode:null,elapsedMs:20,previewCapturedCount:0,phase:'completed',text:'PRIVATE_DIAGNOSTIC_BODY',href:'https://private.invalid/'}})}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),error=>{assert.equal(error.code,'RESUME_SELECTION');assert.equal(error.uncertain,'resume');assert.equal(error.evidence.resumeStructure.dialogs[0].classes,'unknown-resume-modal');assert.equal(error.evidence.lastOperationDiagnostic.op,'REQUEST_RESUME');assert.equal(error.evidence.resumeDiagnosticSource,'inspect-page');assert.doesNotMatch(JSON.stringify(error.evidence),/PRIVATE_|private\.invalid/u);return true;});
 assert.equal((await disk()).resumeStatus,'intent');assert.equal(bridge.calls.filter(call=>call.op==='REQUEST_RESUME').length,1);assert.equal(bridge.calls.filter(call=>call.op==='INSPECT_PAGE').length,1);assert.equal(bridge.calls.some(call=>['SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});
test('resume failure diagnostics keep lost request acknowledgements uncertain without replay',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({resumeStructure:diagnosticStructure()}),REQUEST_RESUME:()=>{throw Object.assign(Error('lost request'),{code:'UNKNOWN_RESULT'});},INSPECT_PAGE:()=>({resumeStructure:diagnosticStructure('发送'),lastOperationDiagnostic:{op:'REQUEST_RESUME',errorCode:'UNKNOWN_RESULT',elapsedMs:8000,previewCapturedCount:0,phase:'completed'}})}});
 const result=await browser.contact(job,{resumeOnly:true,onStage:stage});assert.equal(result.resumeStatus,'uncertain');assert.equal((await disk()).resumeStatus,'uncertain');assert.equal(result.evidence.resumeStructure.chat[0].caption,'发送');assert.equal(result.evidence.lastOperationDiagnostic.errorCode,'UNKNOWN_RESULT');assert.equal(bridge.calls.filter(call=>call.op==='REQUEST_RESUME').length,1);assert.equal(bridge.calls.filter(call=>call.op==='INSPECT_PAGE').length,1);
});
test('resume failure diagnostics use the last read as fallback without retrying a broken inspection',async t=>{
 const {stage}=await persistentStage(t);let requested=false;const original=Object.assign(Error('selection failed'),{code:'RESUME_SELECTION'});
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({dialog:requested,options:requested?[{name:'PRIVATE_FILE.pdf'}]:[],resumeStructure:diagnosticStructure()}),REQUEST_RESUME:()=>{requested=true;return{clicked:true};},SELECT_RESUME:()=>{throw original;},INSPECT_PAGE:()=>{throw Object.assign(Error('PRIVATE_INSPECTION_ERROR'),{code:'EPIPE'});}}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),error=>{assert.equal(error,original);assert.equal(error.evidence.resumeDiagnosticSource,'last-read-resume');assert.equal(error.evidence.resumeStructure.chat[0].caption,'发简历');assert.doesNotMatch(JSON.stringify(error.evidence),/PRIVATE_/u);return true;});assert.equal(bridge.calls.filter(call=>call.op==='INSPECT_PAGE').length,1);assert.equal(bridge.calls.filter(call=>call.op==='REQUEST_RESUME').length,1);assert.equal(bridge.calls.filter(call=>call.op==='SELECT_RESUME').length,1);
});
for(const change of ['checkpoint','epoch','document'])test(`resume failure diagnostics skip unsafe inspection after ${change}`,async t=>{
 const {stage}=await persistentStage(t);let requested=false,stopped=false;const original=Object.assign(Error('selection failed'),{code:'RESUME_SELECTION'});
 const {browser,bridge}=setup({browserOptions:{checkpoint:async()=>{if(stopped)throw Object.assign(Error('stop'),{code:'STOPPED'});}},handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({dialog:requested,options:requested?[{name:'PRIVATE_FILE.pdf'}]:[],resumeStructure:diagnosticStructure()}),REQUEST_RESUME:()=>{requested=true;return{clicked:true};},SELECT_RESUME:()=>{if(change==='checkpoint')stopped=true;if(change==='epoch')bridge.cancel();if(change==='document')browser.meta={...browser.meta,documentId:'different'};throw original;}}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),error=>{assert.equal(error,original);assert.equal(error.evidence.resumeDiagnosticSource,'last-read-resume');return true;});assert.equal(bridge.calls.some(call=>call.op==='INSPECT_PAGE'),false);assert.equal(bridge.calls.filter(call=>call.op==='SELECT_RESUME').length,1);
});
test('resume failure diagnostics preserve the original exception when stopped during a pending inspection',async t=>{
 const {stage}=await persistentStage(t);let requested=false,stopped=false,timer=null;const original=Object.assign(Error('selection failed'),{code:'RESUME_SELECTION'});
 const {browser,bridge}=setup({browserOptions:{timeoutMs:1000,pollMs:10,checkpoint:async()=>{if(stopped)throw Object.assign(Error('stop'),{code:'STOPPED'});}},handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({dialog:requested,options:requested?[{name:'PRIVATE_FILE.pdf'}]:[],resumeStructure:diagnosticStructure()}),REQUEST_RESUME:()=>{requested=true;return{clicked:true};},SELECT_RESUME:()=>{throw original;},INSPECT_PAGE:()=>{timer=setTimeout(()=>{stopped=true;},40);return new Promise(()=>{});}}});
 const start=Date.now();try{await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),error=>{assert.equal(error,original);assert.equal(error.evidence.resumeDiagnosticSource,'last-read-resume');return true;});}finally{clearTimeout(timer);}assert.ok(Date.now()-start<400);assert.equal(bridge.calls.filter(call=>call.op==='INSPECT_PAGE').length,1);
});
test('resume failure diagnostics reject changed-document packets and private diagnostic fields',async t=>{
 const {stage}=await persistentStage(t);let requested=false;const original=Object.assign(Error('selection failed'),{code:'RESUME_SELECTION'});
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({dialog:requested,options:requested?[{name:'PRIVATE_FILE.pdf'}]:[],resumeStructure:diagnosticStructure()}),REQUEST_RESUME:()=>{requested=true;return{clicked:true};},SELECT_RESUME:()=>{throw original;},INSPECT_PAGE:(_args,current)=>{current.meta={...current.meta,documentId:'other'};return{resumeStructure:diagnosticStructure('发送'),lastOperationDiagnostic:{op:'PRIVATE_OPERATION',errorCode:'PRIVATE_ERROR',phase:'PRIVATE_PHASE',text:'PRIVATE_BODY'}};}}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),error=>{assert.equal(error,original);assert.equal(error.evidence.resumeStructure.chat[0].caption,'发简历');assert.equal(error.evidence.resumeDiagnosticSource,'last-read-resume');assert.doesNotMatch(JSON.stringify(error.evidence),/PRIVATE_/u);return true;});assert.equal(bridge.calls.filter(call=>call.op==='INSPECT_PAGE').length,1);
});

test('platform disabled attachment permission is unavailable without a resume intent or request',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({status:'unavailable',reason:'双方回复后可用'})}});
 const result=await browser.contact(job,{onStage:stage});assert.equal(result.resumeStatus,'unavailable');assert.match(result.note,/双方回复/u);assert.equal((await disk()).resumeStatus,'unavailable');assert.equal(bridge.calls.some(call=>call.op==='REQUEST_RESUME'),false);
});

test('a job-page receipt persists one greeting before entering an existing verified conversation',async t=>{
 const {store,stage,disk}=await persistentStage(t);let opened=0,bound=false;const stages=[];
 const {browser,bridge}=setup({handlers:{
  READ_CONVERSATION:()=>bound?{...fresh(),existing:true,emptyNew:false,greetingSent:true}:{verified:false},
  OPEN_CONTACT:async(args,b)=>{opened++;if(opened===1){assert.equal((await disk()).greetingStatus,'intent');assert.equal(args.resumeOnly,false);return{clicked:true,existing:false};}assert.equal(args.resumeOnly,true);assert.equal((await disk()).greetingStatus,'sent');b.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'portal'};return{clicked:true,existing:true};},
  READ_CONTACT_CONFIRMATION:()=>({confirmed:true,jobId:job.id,needsExistingConversation:true,evidence:{kind:'job-page-contact-confirmation',status:'已发送'}}),
  DISMISS_CONTACT_CONFIRMATION:async()=>{assert.equal((await disk()).greetingStatus,'sent');return{dismissed:true,jobId:job.id,needsExistingConversation:true};},
  VERIFY_CONVERSATION_JOB:()=>({previewStarted:true}),
  READ_CONVERSATION_VERIFICATION:()=>{bound=true;return{verified:true,jobId:job.id};},
  READ_RESUME:()=>resume({status:'unavailable',reason:'双方回复后可用'})
 }});
 const result=await browser.contact(job,{greeting:'自定义你好',onStage:async(name,patch)=>{stages.push(name);await stage(name,patch);}});
 assert.equal(result.greetingStatus,'sent');assert.equal(result.resumeStatus,'unavailable');assert.equal(store.getJob(jobKey(job)).greetingStatus,'sent');
 assert.equal(stages.filter(name=>name==='greeting-intent').length,1);assert.equal(stages.filter(name=>name==='greeting-sent').length,1);
 assert.equal(bridge.calls.filter(c=>c.op==='VERIFY_CONVERSATION_JOB').length,1);assert.equal(opened,2);
 assert.equal(bridge.calls.some(c=>['FILL_GREETING','SEND_GREETING','REQUEST_RESUME'].includes(c.op)),false);
});

test('a confirmed job-page receipt alone never authorizes an attachment or substitutes another job ID',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({verified:false}),READ_CONTACT_CONFIRMATION:()=>({confirmed:true,jobId:'wrong',needsExistingConversation:true})}});
 await assert.rejects(browser.contact(job,{onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.equal((await disk()).resumeStatus,'none');assert.equal(bridge.calls.some(c=>['READ_RESUME','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
});

function receiptFastPathFixture(stage,disk){
 let opened=0,bound=false;const stages=[];
 const state=setup({handlers:{
  READ_CONVERSATION:()=>bound?{...fresh(),existing:true,emptyNew:false,greetingSent:true}:{verified:false},
  OPEN_CONTACT:async(args,current)=>{opened++;if(opened===1){assert.equal((await disk()).greetingStatus,'intent');assert.equal(args.resumeOnly,false);return{clicked:true,existing:false};}assert.equal(args.resumeOnly,true);assert.equal((await disk()).greetingStatus,'sent');current.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'fast-path-portal'};return{clicked:true,existing:true};},
  READ_CONTACT_CONFIRMATION:()=>({confirmed:true,jobId:job.id,needsExistingConversation:true}),
  DISMISS_CONTACT_CONFIRMATION:()=>({dismissed:true,jobId:job.id}),
  VERIFY_CONVERSATION_JOB:()=>({previewStarted:true}),
  READ_CONVERSATION_VERIFICATION:()=>{bound=true;return{verified:true,jobId:job.id};},
  READ_RESUME:()=>resume({status:'unavailable',reason:'双方回复后可用'})
 }});
 return{...state,stages,onStage:async(name,patch)=>{stages.push(name);await stage(name,patch);},get opened(){return opened;}};
}

test('deferred native receipt reduces the actual adapter chain from fourteen commands to six without claiming an attachment',async t=>{
 const records=[];
 for(const deferResumeAfterGreeting of [false,true]){
  const {stage,disk}=await persistentStage(t);const state=receiptFastPathFixture(stage,disk);
  await state.browser.details(job);state.bridge.calls.length=0;
  const result=await state.browser.contact(job,{deferResumeAfterGreeting,onStage:state.onStage});
  records.push({state,result});
  assert.equal(result.greetingStatus,'sent');assert.equal((await disk()).greetingStatus,'sent');
  assert.equal(state.stages.filter(name=>name==='greeting-intent').length,1);assert.equal(state.stages.filter(name=>name==='greeting-sent').length,1);
  if(deferResumeAfterGreeting){
   assert.equal(result.resumeSkipped,true);assert.equal(result.resumeDeferred,true);assert.equal(result.resumeStatus,'none');assert.equal((await disk()).resumeStatus,'none');
   assert.match(result.note,/队列/u);assert.equal(state.stages.some(name=>name.startsWith('resume-')),false);
   assert.equal(state.bridge.calls.some(call=>['DISMISS_CONTACT_CONFIRMATION','VERIFY_CONVERSATION_JOB','READ_CONVERSATION_VERIFICATION','READ_RESUME','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
  }
 }
 assert.equal(records[0].state.bridge.calls.length,14);assert.equal(records[0].state.opened,2);assert.equal(records[0].result.resumeStatus,'unavailable');
 assert.equal(records[1].state.bridge.calls.length,6);assert.equal(records[1].state.opened,1);
});

test('deferred receipt never returns success before the greeting receipt reaches disk',async t=>{
 const {stage,disk}=await persistentStage(t);const state=receiptFastPathFixture(stage,disk);const original=Error('durable receipt write failed');
 await assert.rejects(state.browser.contact(job,{deferResumeAfterGreeting:true,onStage:async(name,patch)=>{if(name==='greeting-sent')throw original;await stage(name,patch);}}),error=>error===original);
 assert.equal((await disk()).greetingStatus,'intent');assert.equal((await disk()).resumeStatus,'none');assert.equal(state.opened,1);
 assert.equal(state.bridge.calls.some(call=>['READ_RESUME','REQUEST_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});

test('deferred receipt still rejects a different confirmed job before any attachment or success',async t=>{
 const {stage,disk}=await persistentStage(t);const state=receiptFastPathFixture(stage,disk);
 state.bridge.handlers.READ_CONTACT_CONFIRMATION=()=>({confirmed:true,jobId:'other-job',needsExistingConversation:true});
 await assert.rejects(state.browser.contact(job,{deferResumeAfterGreeting:true,onStage:state.onStage}),{code:'RECIPIENT_UNVERIFIED'});
 assert.equal((await disk()).greetingStatus,'intent');assert.equal((await disk()).resumeStatus,'none');assert.equal(state.opened,1);
 assert.equal(state.bridge.calls.some(call=>['DISMISS_CONTACT_CONFIRMATION','READ_RESUME','REQUEST_RESUME'].includes(call.op)),false);
});

test('deferred receipt retains the attachment target shortcut without adding queue work',async t=>{
 const {stage,disk}=await persistentStage(t);const state=receiptFastPathFixture(stage,disk);
 const result=await state.browser.contact(job,{deferResumeAfterGreeting:true,sendResume:false,onStage:state.onStage});
 assert.equal(result.greetingStatus,'sent');assert.equal(result.resumeSkipped,true);assert.equal(result.resumeDeferred,undefined);assert.match(result.note,/本次未执行附件步骤/u);
 assert.equal((await disk()).resumeStatus,'none');assert.equal(state.opened,1);assert.equal(state.bridge.calls.some(call=>call.op==='READ_RESUME'),false);
});

test('deferred receipt leaves an already verified conversation on the immediate attachment path',async t=>{
 const {stage,disk}=await persistentStage(t);let requested=false;const {browser,bridge}=setup({handlers:{
  READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({status:requested?'requested':'none'}),
  REQUEST_RESUME:async()=>{assert.equal((await disk()).resumeStatus,'intent');requested=true;return{clicked:true};}
 }});
 const result=await browser.contact(job,{deferResumeAfterGreeting:true,onStage:stage});
 assert.equal(result.greetingStatus,'existing');assert.equal(result.resumeStatus,'requested');assert.equal(result.resumeDeferred,undefined);assert.equal(result.resumeSkipped,undefined);
 assert.equal(bridge.calls.filter(call=>call.op==='REQUEST_RESUME').length,1);assert.equal((await disk()).resumeStatus,'requested');
});

test('deferred receipt leaves resumeOnly inspection read-only with the observed attachment state',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({...fresh(),existing:true,emptyNew:false}),READ_RESUME:()=>resume({status:'sent'})}});
 const result=await browser.contact(job,{resumeOnly:true,inspectResumeOnly:true,deferResumeAfterGreeting:true,onStage:stage});
 assert.equal(result.resumeInspection,true);assert.equal(result.resumeStatus,'sent');assert.equal(result.resumeDeferred,undefined);assert.equal((await disk()).resumeStatus,'none');
 assert.equal(bridge.calls.filter(call=>call.op==='READ_RESUME').length,1);assert.equal(bridge.calls.some(call=>['OPEN_CONTACT','REQUEST_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});

test('deferred receipt preserves an unknown greeting result without reopening or sending an attachment',async t=>{
 const {stage,disk}=await persistentStage(t);const state=receiptFastPathFixture(stage,disk);
 state.bridge.handlers.OPEN_CONTACT=()=>{throw Object.assign(Error('lost greeting click receipt'),{code:'UNKNOWN_RESULT'});};
 const result=await state.browser.contact(job,{deferResumeAfterGreeting:true,onStage:state.onStage});
 assert.equal(result.greetingStatus,'uncertain');assert.equal(result.resumeStatus,'none');assert.equal(result.resumeDeferred,undefined);assert.equal((await disk()).greetingStatus,'uncertain');
 assert.equal(state.bridge.calls.filter(call=>call.op==='OPEN_CONTACT').length,1);assert.equal(state.bridge.calls.some(call=>['READ_CONTACT_CONFIRMATION','READ_RESUME','REQUEST_RESUME'].includes(call.op)),false);
});

function lostExistingNavigation({proofId=job.id,remainOnDetail=false,risk=null}={}){
 let bound=false,opened=false;
 return setup({handlers:{
  READ_DETAIL:()=>({job,contactExisting:true,contactAvailable:true}),
  READ_STATUS:()=>risk&&opened?{ready:true,loggedIn:true,account:'王同学',risk}:{ready:true,loggedIn:true,account:'王同学'},
  READ_CONVERSATION:()=>bound?{...fresh(),existing:true,emptyNew:false}:{verified:false},
  OPEN_CONTACT:(args,current)=>{assert.equal(args.resumeOnly,true);opened=true;if(!remainOnDetail)current.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'new-portal'};throw Object.assign(Error('document navigation lost acknowledgement'),{code:'UNKNOWN_RESULT'});},
  VERIFY_CONVERSATION_JOB:()=>({previewStarted:true}),
  READ_CONVERSATION_VERIFICATION:()=>{bound=proofId===job.id;return{verified:true,jobId:proofId};},
  READ_RESUME:()=>{assert.equal(bound,true);return resume({status:'unavailable',reason:'双方回复后可用'});}
 }});
}
test('a lost existing-contact navigation acknowledgement is read without re-opening and still requires the exact portal job',async t=>{
 const {stage,disk}=await persistentStage(t),stages=[];const {browser,bridge}=lostExistingNavigation();
 const result=await browser.contact(job,{resumeOnly:true,onStage:async(name,patch)=>{stages.push(name);await stage(name,patch);}});
 assert.equal(result.resumeStatus,'unavailable');assert.equal((await disk()).resumeStatus,'unavailable');
 assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);
 assert.equal(bridge.calls.filter(c=>c.op==='VERIFY_CONVERSATION_JOB').length,1);
 assert.equal(bridge.calls.find(c=>c.op==='VERIFY_CONVERSATION_JOB').options.target.document.documentId,'new-portal');
 assert.equal(bridge.calls.some(c=>['FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
 assert.equal(stages.includes('greeting-intent')||stages.includes('resume-intent'),false);
});
test('an unknown existing-contact result remaining on its detail page is not retried or treated as navigation',async t=>{
 const {stage}=await persistentStage(t);const {browser,bridge}=lostExistingNavigation({remainOnDetail:true});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'UNKNOWN_RESULT'});
 assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME'].includes(c.op)),false);
});
test('a lost existing-contact acknowledgement cannot authorize attachments for a different verified job',async t=>{
 const {stage}=await persistentStage(t);const {browser,bridge}=lostExistingNavigation({proofId:'different'});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});
 assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['READ_RESUME','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
});
test('a lost existing-contact acknowledgement preserves website safety checks before any verification click',async t=>{
 const {stage}=await persistentStage(t);const {browser,bridge}=lostExistingNavigation({risk:{code:'CAPTCHA',message:'请完成验证'}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'CAPTCHA'});
 assert.equal(bridge.calls.some(c=>['VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME'].includes(c.op)),false);
});
test('a lost new-contact result remains uncertain even if a portal has appeared',async t=>{
 const {stage,disk}=await persistentStage(t);const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>({verified:false}),OPEN_CONTACT:(_args,current)=>{current.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'portal'};throw Object.assign(Error('lost'),{code:'UNKNOWN_RESULT'});}}});
 const result=await browser.contact(job,{onStage:stage});assert.equal(result.greetingStatus,'uncertain');assert.equal((await disk()).greetingStatus,'uncertain');
 assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME'].includes(c.op)),false);
});
test('an unknown existing-contact result on a detail-page inline chat still cannot recover as a portal navigation',async t=>{
 const {stage}=await persistentStage(t);let opened=false;
 const {browser,bridge}=setup({handlers:{READ_DETAIL:()=>({job,contactExisting:true}),READ_CONVERSATION:()=>opened?{...fresh(),existing:true,emptyNew:false}:{verified:false},OPEN_CONTACT:()=>{opened=true;throw Object.assign(Error('lost'),{code:'UNKNOWN_RESULT'});}}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'UNKNOWN_RESULT'});
 assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME'].includes(c.op)),false);
});
test('a superseded existing-contact document acknowledgement permits only read-only portal recovery and exact job verification',async t=>{
 const {stage}=await persistentStage(t);const {browser,bridge}=lostExistingNavigation();
 const old=bridge.handlers.OPEN_CONTACT;bridge.handlers.OPEN_CONTACT=async(args,b)=>{try{await old(args,b);}catch{throw Object.assign(Error('old response superseded by new READY'),{code:'DOCUMENT_CHANGED'});}};
 const result=await browser.contact(job,{resumeOnly:true,onStage:stage});assert.equal(result.resumeStatus,'unavailable');
 assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.filter(c=>c.op==='VERIFY_CONVERSATION_JOB').length,1);assert.equal(bridge.calls.some(c=>['SEND_GREETING','REQUEST_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
});
test('a pre-click document mismatch remaining at a job detail cannot recover or request an attachment',async t=>{
 const {stage}=await persistentStage(t);const {browser,bridge}=lostExistingNavigation({remainOnDetail:true});bridge.handlers.OPEN_CONTACT=()=>{throw Object.assign(Error('document changed before click'),{code:'DOCUMENT_CHANGED'});};
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'DOCUMENT_CHANGED'});assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME'].includes(c.op)),false);
});
test('portal verification waits read-only for matching selected job fields before its single preview click',async t=>{
 const {stage}=await persistentStage(t);let portal=false,bound=false,reads=0,clock=1000;const sleeps=[];
 const {browser,bridge}=setup({browserOptions:{now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}},handlers:{READ_DETAIL:()=>({job,contactExisting:true}),OPEN_CONTACT:(_args,b)=>{portal=true;b.meta={url:'https://www.zhipin.com/web/geek/chat',documentId:'portal',title:'BOSS'};return{existing:true,clicked:true};},READ_CONVERSATION:()=>bound?{...fresh(),existing:true,emptyNew:false}:{verified:false,previewAvailable:portal&&++reads>=3},VERIFY_CONVERSATION_JOB:()=>{assert.ok(reads>=3,'must not click while the selected job is still loading');return{previewStarted:true};},READ_CONVERSATION_VERIFICATION:()=>{bound=true;return{verified:true,jobId:job.id};},READ_RESUME:()=>resume({status:'unavailable'})}});
 const result=await browser.contact(job,{resumeOnly:true,onStage:stage});assert.equal(result.resumeStatus,'unavailable');assert.equal(clock,1001);assert.deepEqual(sleeps,[1]);assert.equal(bridge.calls.filter(c=>c.op==='VERIFY_CONVERSATION_JOB').length,1);assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
});
test('a portal whose current job fields never match receives no preview click or attachment operation',async t=>{
 const {stage}=await persistentStage(t);let clock=1000;const sleeps=[];const {browser,bridge}=lostExistingNavigation();Object.assign(browser,{now:()=>clock,sleep:async ms=>{clock+=ms;sleeps.push(ms);}});bridge.handlers.READ_CONVERSATION=()=>({verified:false,previewAvailable:false});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.equal(clock,1012);assert.deepEqual(sleeps,Array(12).fill(1));assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.some(c=>['VERIFY_CONVERSATION_JOB','READ_RESUME','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
});

test('a conversation document race refreshes current evidence and repeats only the same read once',async()=>{
 let reads=0;const {browser,bridge}=setup({handlers:{READ_CONVERSATION:(_args,current)=>{if(++reads===1){current.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'new-chat'};throw Object.assign(Error('new READY superseded old read'),{code:'DOCUMENT_CHANGED'});}return fresh();}}});
 await browser.open();bridge.calls.length=0;
 const state=await browser.conversation(job,'same greeting');assert.equal(state.verified,true);assert.equal(state.greetingSent,false);
 assert.deepEqual(bridge.calls.map(c=>c.op),['READ_CONVERSATION','READ_STATUS','READ_CONVERSATION']);
 assert.equal(bridge.calls[1].options.target,undefined);assert.equal(bridge.calls[2].options.target.document.documentId,'new-chat');
 assert.deepEqual(bridge.calls[0].args,{job,greeting:'same greeting'});assert.deepEqual(bridge.calls[2].args,{job,greeting:'same greeting'});
});
test('a second conversation document race is rejected after one refresh',async()=>{
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>{throw Object.assign(Error('changing'),{code:'DOCUMENT_CHANGED'});}}});await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.conversation(job),{code:'DOCUMENT_CHANGED'});assert.deepEqual(bridge.calls.map(c=>c.op),['READ_CONVERSATION','READ_STATUS','READ_CONVERSATION']);
});
test('a conversation unknown result is never refreshed or redispatched',async()=>{
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>{throw Object.assign(Error('lost'),{code:'UNKNOWN_RESULT'});}}});await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.conversation(job),{code:'UNKNOWN_RESULT'});assert.deepEqual(bridge.calls.map(c=>c.op),['READ_CONVERSATION']);
});
for(const code of ['CAPTCHA','DOCUMENT_CHANGED'])test(`conversation refresh preserves ${code} without another read`,async()=>{
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>{throw Object.assign(Error('changed'),{code:'DOCUMENT_CHANGED'});},READ_STATUS:()=>{throw Object.assign(Error('blocked'),{code});}}});await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.conversation(job),{code});assert.deepEqual(bridge.calls.map(c=>c.op),['READ_CONVERSATION','READ_STATUS']);
});
test('a stop after the first conversation race prevents refresh and further reads',async()=>{
 let stopped=false;const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>{stopped=true;throw Object.assign(Error('changed'),{code:'DOCUMENT_CHANGED'});}}});await browser.open();bridge.calls.length=0;
 browser.checkpoint=async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'CANCELLED'});};
 await assert.rejects(browser.conversation(job),{code:'CANCELLED'});assert.deepEqual(bridge.calls.map(c=>c.op),['READ_CONVERSATION']);
});
test('a conversation reread for the wrong job still blocks every attachment operation',async t=>{
 const {stage,disk}=await persistentStage(t);let reads=0;const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>{if(++reads===1)throw Object.assign(Error('changed'),{code:'DOCUMENT_CHANGED'});return{...fresh(),jobId:'wrong'};}}});
 await assert.rejects(browser.contact(job,{resumeOnly:true,onStage:stage}),{code:'RECIPIENT_UNVERIFIED'});assert.equal(reads,2);assert.equal((await disk()).resumeStatus,'none');
 assert.equal(bridge.calls.some(c=>['OPEN_CONTACT','VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'].includes(c.op)),false);
});
for(const code of ['DOCUMENT_CHANGED','UNKNOWN_RESULT'])for(const op of ['OPEN_CONTACT','SEND_GREETING','REQUEST_RESUME','CONFIRM_RESUME'])test(`conversation recovery never retries ${op} with ${code}`,async()=>{
 const {browser,bridge}=setup({handlers:{[op]:()=>{throw Object.assign(Error('failed effect'),{code});}}});await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.call(op,{job}),{code});assert.deepEqual(bridge.calls.map(c=>c.op),[op]);
});

function readyPortalFixture() {
 let bound=false;
 const state=setup({handlers:{
  READ_DETAIL:()=>({job,contactExisting:true}),
  OPEN_CONTACT:(_args,current)=>{current.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'ready-portal'};return{existing:true,clicked:true};},
  READ_CONVERSATION:()=>bound?{...fresh(),existing:true,emptyNew:false}:{verified:false,previewAvailable:true},
  VERIFY_CONVERSATION_JOB:()=>({previewStarted:true}),
  READ_CONVERSATION_VERIFICATION:()=>{bound=true;return{verified:true,jobId:job.id};},
  READ_RESUME:()=>resume({status:'unavailable'})
 }});
 return state;
}

test('a ready portal reuses its current conversation read without two redundant bridge requests',async()=>{
 const {browser,bridge}=readyPortalFixture();
 const result=await browser.contact(job,{resumeOnly:true,onStage:async()=>{}});
 assert.equal(result.resumeStatus,'unavailable');
 const open=bridge.calls.findIndex(call=>call.op==='OPEN_CONTACT'),verify=bridge.calls.findIndex(call=>call.op==='VERIFY_CONVERSATION_JOB');
 assert.deepEqual(bridge.calls.slice(open+1,verify).map(call=>call.op),['READ_STATUS','READ_CONVERSATION']);
 assert.equal(bridge.calls.filter(call=>call.op==='VERIFY_CONVERSATION_JOB').length,1);
 assert.deepEqual(bridge.calls.slice(verify+1).map(call=>call.op),['READ_CONVERSATION_VERIFICATION','READ_CONVERSATION','READ_RESUME']);
 assert.equal(bridge.calls.some(call=>['SEND_GREETING','REQUEST_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});

async function observedReadyPortal() {
 const state=readyPortalFixture();await state.browser.open();
 state.bridge.meta={url:'https://www.zhipin.com/web/geek/chat',title:'BOSS',documentId:'ready-portal'};
 const view=await state.browser.contactView(job);state.bridge.calls.length=0;
 return {...state,view};
}

test('the portal observation carries only the freshly read conversation and still requires actual job binding',async()=>{
 const {browser,bridge,view}=await observedReadyPortal();
 assert.equal(view.kind,'portal');assert.equal(typeof view.chat,'object');assert.equal(view.chat.previewAvailable,true);assert.equal(view.chat.verified,false);
 await browser.verifiedPortal(job,view.chat);
 assert.deepEqual(bridge.calls.map(call=>call.op),['VERIFY_CONVERSATION_JOB','READ_CONVERSATION_VERIFICATION','READ_CONVERSATION']);
 assert.equal(bridge.calls[0].options.target.document.documentId,'ready-portal');
});

for(const change of ['intervening-read','document','url','title','target','recruiter','epoch','forged-copy'])test(`a portal observation changed by ${change} is not reused`,async()=>{
 const {browser,bridge,view}=await observedReadyPortal();
 let target=job,initialChat=view.chat;
 if(change==='intervening-read')await browser.call('READ_STATUS');
 if(change==='document')browser.meta={...browser.meta,documentId:'other-document'};
 if(change==='url')browser.meta={...browser.meta,url:'https://www.zhipin.com/web/geek/chat?changed=1'};
 if(change==='title')browser.meta={...browser.meta,title:'Updated BOSS title'};
 if(change==='target')target={...job,title:'Another Agent role'};
 if(change==='recruiter')target={...job,recruiterName:'Another recruiter'};
 if(change==='epoch')browser.epoch='another-session';
 if(change==='forged-copy')initialChat={...view.chat};
 bridge.calls.length=0;await browser.verifiedPortal(target,initialChat);
 assert.deepEqual(bridge.calls.slice(0,2).map(call=>call.op),['READ_STATUS','READ_CONVERSATION']);
 assert.equal(bridge.calls.filter(call=>call.op==='VERIFY_CONVERSATION_JOB').length,1);
});

test('an unready portal observation keeps the matching-fields read-only wait',async()=>{
 const {browser,bridge}=readyPortalFixture();await browser.open();bridge.meta={url:'https://www.zhipin.com/web/geek/chat',documentId:'ready-portal'};
 bridge.handlers.READ_CONVERSATION=()=>({verified:false,previewAvailable:false});
 const view=await browser.contactView(job);bridge.calls.length=0;
 await assert.rejects(browser.verifiedPortal(job,view.chat),{code:'RECIPIENT_UNVERIFIED'});
 assert.equal(bridge.calls.some(call=>['VERIFY_CONVERSATION_JOB','READ_RESUME','REQUEST_RESUME'].includes(call.op)),false);
});

test('cancellation after a ready portal observation prevents every subsequent command',async()=>{
 const {browser,bridge,view}=await observedReadyPortal();
 browser.checkpoint=async()=>{throw Object.assign(Error('stopped'),{code:'CANCELLED'});};
 await assert.rejects(browser.verifiedPortal(job,view.chat),{code:'CANCELLED'});assert.deepEqual(bridge.calls,[]);
});

for(const code of ['CAPTCHA','RATE_LIMIT','UNKNOWN_RESULT'])test(`reusing a ready portal observation preserves ${code} from its single verification command`,async()=>{
 const {browser,bridge,view}=await observedReadyPortal();
 bridge.handlers.VERIFY_CONVERSATION_JOB=()=>{throw Object.assign(Error('verification rejected'),{code});};
 await assert.rejects(browser.verifiedPortal(job,view.chat),{code});
 assert.equal(bridge.calls.filter(call=>call.op==='VERIFY_CONVERSATION_JOB').length,1);
 assert.equal(bridge.calls.some(call=>['READ_RESUME','REQUEST_RESUME','CONFIRM_RESUME'].includes(call.op)),false);
});

test('leaving the official portal after its observation rejects verification without a command',async()=>{
 const {browser,bridge,view}=await observedReadyPortal();browser.meta={...browser.meta,url:'https://www.zhipin.com/job_detail/another.html'};
 await assert.rejects(browser.verifiedPortal(job,view.chat),{code:'RECIPIENT_UNVERIFIED'});assert.deepEqual(bridge.calls,[]);
});

async function retryFixture() {
 let clock=1000;const sleeps=[],events=[];
 const state=setup({browserOptions:{pollMs:250,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},onEvent:async event=>events.push(event)}});
 await state.browser.open();state.bridge.calls.length=0;events.length=0;
 return {...state,sleeps,events,get clock(){return clock;}};
}

test('normal navigation has zero default pacing and does not sleep when pages are already ready',async()=>{
 const bridge=new FakeBridge(),sleeps=[];const browser=new ExtensionBrowser({bridge,launcher:{launch:async()=>{}},profileDir:'/tmp/dedicated-fixture',outputDir:'/tmp/fixture-output',now:()=>1000,sleep:async ms=>sleeps.push(ms)});
 assert.equal(browser.navigationDelayMs,0);await browser.open();
 await browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'});await browser.call('READ_STATUS');
 await browser.call('NAV_JOB',{job});await browser.call('READ_STATUS');
 assert.deepEqual(sleeps,[]);
});

for(const op of ['READ_STATUS','READ_CARDS','READ_DETAIL','READ_CONVERSATION','READ_RESUME','READ_CONTACT_CONFIRMATION','READ_CONVERSATION_VERIFICATION','INSPECT_PAGE'])test(`safe read retry recovers ${op} on its third attempt only after transient failures`,async()=>{
 const {browser,bridge,sleeps,events}=await retryFixture();let attempts=0;
 bridge.handlers[op]=()=>{if(++attempts<3)throw Object.assign(Error('connection reset'),{code:'ECONNRESET'});return {ready:true,loggedIn:true,account:'王同学'};};
 await browser.call(op,{job});assert.equal(attempts,3);assert.equal(sleeps.reduce((a,b)=>a+b,0),750);
 assert.deepEqual(events.map(event=>[event.type,event.attempt,event.delayMs]),[['read_retry',2,250],['read_retry',3,500]]);
 const documents=bridge.calls.map(call=>call.options.target.document);assert.deepEqual(documents,[documents[0],documents[0],documents[0]]);
});

for(const code of ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','NETWORK_ERROR','EXTENSION_OFFLINE'])test(`safe read retry has a three-attempt ceiling for ${code}`,async()=>{
 const {browser,bridge,sleeps}=await retryFixture();let attempts=0;
 bridge.handlers.READ_STATUS=()=>{attempts++;throw Object.assign(Error('transient read failure'),{code});};
 await assert.rejects(browser.call('READ_STATUS'),{code});assert.equal(attempts,3);assert.equal(sleeps.reduce((a,b)=>a+b,0),750);
});

for(const op of ['NAV_SEARCH','NAV_JOB','NEXT_PAGE','OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME','VERIFY_CONVERSATION_JOB','DISMISS_CONTACT_CONFIRMATION'])test(`safe read retry never repeats effect ${op}`,async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers[op]=()=>{throw Object.assign(Error('connection reset'),{code:'ECONNRESET'});};
 const args=op==='NAV_SEARCH'?{query:'AI Agent',cityCode:'101010100'}:{job};
 await assert.rejects(browser.call(op,args),{code:'ECONNRESET'});assert.equal(bridge.calls.filter(call=>call.op===op).length,1);assert.deepEqual(sleeps,[]);
});

for(const code of ['UNKNOWN_RESULT','DOCUMENT_CHANGED','RECIPIENT_UNVERIFIED','PAGE_CHANGED','CAPTCHA','RATE_LIMIT','STOPPED','CANCELLED','BRIDGE_INACTIVE'])test(`safe read retry preserves ${code} without retry or delay`,async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers.READ_STATUS=()=>{throw Object.assign(Error('rejected'),{code});};
 await assert.rejects(browser.call('READ_STATUS'),{code});assert.equal(bridge.calls.length,1);assert.deepEqual(sleeps,[]);
});

test('safe read retry can be stopped during backoff before a second read',async()=>{
 const {browser,bridge,sleeps}=await retryFixture();let stopped=false;
 browser.sleep=async ms=>{sleeps.push(ms);stopped=true;};browser.checkpoint=async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});};
 bridge.handlers.READ_STATUS=()=>{throw Object.assign(Error('connection reset'),{code:'ECONNRESET'});};
 await assert.rejects(browser.call('READ_STATUS'),{code:'STOPPED'});assert.equal(bridge.calls.length,1);assert.deepEqual(sleeps,[250]);
});

test('safe read retry rejects a changed run epoch without a second dispatch',async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers.READ_STATUS=()=>{bridge.cancel();throw Object.assign(Error('connection reset'),{code:'ECONNRESET'});};
 await assert.rejects(browser.call('READ_STATUS'),{code:'STOPPED'});assert.equal(bridge.calls.filter(call=>call.op==='READ_STATUS').length,1);assert.deepEqual(sleeps,[]);
});

test('safe read retry does not dispatch when the extension is actually offline',async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers.READ_STATUS=()=>{bridge.connected=false;throw Object.assign(Error('disconnected'),{code:'EXTENSION_OFFLINE'});};
 await assert.rejects(browser.call('READ_STATUS'),{code:'EXTENSION_OFFLINE'});assert.equal(bridge.calls.length,1);assert.deepEqual(sleeps,[]);
});

for(const code of ['CAPTCHA','RATE_LIMIT'])test(`page-visible ${code} blocks without transport retries`,async()=>{
 const {browser,bridge,sleeps}=await retryFixture();const op=code==='RATE_LIMIT'?'OPEN_CONTACT':'READ_STATUS';bridge.handlers[op]=()=>({risk:{code,message:'visible restriction',retryAfterMs:90000}});
 await assert.rejects(browser.call(op,{job}),error=>{assert.equal(error.code,code);if(code==='RATE_LIMIT')assert.equal(error.retryAfterMs,90000);return true;});
 assert.equal(bridge.calls.length,1);assert.deepEqual(sleeps,[]);
});

test('a visible retry-after in seconds is preserved rather than shortened by a local cap',async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.READ_STATUS=()=>({risk:{code:'RATE_LIMIT',message:'visible restriction',retryAfterSeconds:7200}});
 await assert.rejects(browser.call('READ_STATUS'),error=>error.code==='RATE_LIMIT'&&error.retryAfterMs===7200000);
});

for(const retryAfterMs of [-1,0,'90000',NaN,Infinity,1.5])test(`invalid retry-after ${String(retryAfterMs)} is not accepted as platform evidence`,async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.OPEN_CONTACT=()=>({risk:{code:'RATE_LIMIT',message:'visible restriction',retryAfterMs}});
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),error=>error.code==='RATE_LIMIT'&&error.retryAfterMs===undefined);
});

test('rate-limit recovery waits only after a real read restriction, validates status and retries the original read once',async()=>{
 const {browser,bridge,sleeps,events}=await retryFixture();let attempts=0;
 bridge.handlers.READ_CARDS=()=>++attempts===1?{risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:5000}}:{jobs:[job],empty:false};
 const result=await browser.call('READ_CARDS');assert.equal(result.jobs[0].id,job.id);
 assert.deepEqual(bridge.calls.map(call=>call.op),['READ_CARDS','READ_STATUS','READ_CARDS']);assert.equal(sleeps.reduce((a,b)=>a+b,0),5000);
 assert.equal(events.filter(event=>event.type==='rate_limit_wait').length,1);assert.equal(browser.rateGate,null);
});

test('rate-limit recovery has three read-only probes with exponential cooldown before pausing',async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁'}});bridge.handlers.READ_STATUS=()=>({risk:{code:'RATE_LIMIT',message:'仍然访问频繁'}});
 await assert.rejects(browser.call('READ_CARDS'),{code:'RATE_LIMIT'});
 assert.deepEqual(bridge.calls.map(call=>call.op),['READ_CARDS','READ_STATUS','READ_STATUS','READ_STATUS']);
 assert.equal(sleeps.reduce((a,b)=>a+b,0),60000+120000+240000);assert.ok(browser.rateGate);
});

test('rate-limit recovery does not repeat the original read after a second restriction',async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1000}});
 await assert.rejects(browser.call('READ_CARDS'),{code:'RATE_LIMIT'});assert.deepEqual(bridge.calls.map(call=>call.op),['READ_CARDS','READ_STATUS','READ_CARDS']);
});

test('rate-limit effect gate needs both elapsed cooldown and a positive read-only status before another effect',async()=>{
 const state=await retryFixture(),{browser,bridge,sleeps}=state;bridge.handlers.OPEN_CONTACT=()=>({risk:{code:'RATE_LIMIT',message:'沟通频繁',retryAfterMs:1000}});
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'RATE_LIMIT'});await browser.call('READ_STATUS');
 await assert.rejects(browser.call('FILL_GREETING',{job,greeting:'你好'}),{code:'RATE_LIMIT'});assert.equal(bridge.calls.some(call=>call.op==='FILL_GREETING'),false);
 await browser.sleep(1000);await assert.rejects(browser.call('FILL_GREETING',{job,greeting:'你好'}),{code:'RATE_LIMIT'});
 await browser.call('READ_STATUS');await browser.call('FILL_GREETING',{job,greeting:'你好'});
 assert.equal(bridge.calls.filter(call=>call.op==='OPEN_CONTACT').length,1);assert.equal(bridge.calls.filter(call=>call.op==='FILL_GREETING').length,1);assert.deepEqual(sleeps,[1000]);
});

for(const code of ['CAPTCHA','LOGIN_REQUIRED','DOCUMENT_CHANGED','UNKNOWN_RESULT'])test(`rate-limit recovery stops on ${code} during its read-only probe`,async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1000}});
 bridge.handlers.READ_STATUS=()=>{throw Object.assign(Error('probe rejected'),{code});};
 await assert.rejects(browser.call('READ_CARDS'),{code});assert.equal(bridge.calls.filter(call=>call.op==='READ_CARDS').length,1);assert.equal(bridge.calls.some(call=>['OPEN_CONTACT','SEND_GREETING'].includes(call.op)),false);
});

for(const changed of ['documentId','url'])test(`rate-limit recovery refuses original read when its ${changed} changes`,async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1000}});
 bridge.handlers.READ_STATUS=(_args,current)=>{current.meta={...current.meta,[changed]:changed==='url'?job.url:'new-document'};return {ready:true,loggedIn:true,account:'王同学'};};
 await assert.rejects(browser.call('READ_CARDS'),{code:'DOCUMENT_CHANGED'});assert.equal(bridge.calls.filter(call=>call.op==='READ_CARDS').length,1);
 assert.ok(browser.rateGate,'failed recovery must retain the effect gate');
 await assert.rejects(browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'}),{code:'RATE_LIMIT'});assert.equal(bridge.calls.some(call=>call.op==='NAV_SEARCH'),false);
});

test('rate-limit recovery is cancellable during cooldown without issuing a status probe',async()=>{
 const {browser,bridge}=await retryFixture();let stopped=false;browser.sleep=async()=>{stopped=true;};browser.checkpoint=async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});};
 bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1000}});
 await assert.rejects(browser.call('READ_CARDS'),{code:'STOPPED'});assert.deepEqual(bridge.calls.map(call=>call.op),['READ_CARDS']);
});

test('an early risk probe cannot shorten a previously advertised long cooldown',async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.OPEN_CONTACT=()=>({risk:{code:'RATE_LIMIT',message:'沟通频繁',retryAfterMs:7200000}});
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'RATE_LIMIT'});const advertisedUntil=browser.rateGate.until;
 await browser.sleep(1000);bridge.handlers.READ_STATUS=()=>({risk:{code:'RATE_LIMIT',message:'仍然频繁'}});
 await assert.rejects(browser.call('READ_STATUS'),{code:'RATE_LIMIT'});assert.equal(browser.rateGate.until,advertisedUntil);
});

test('a changed epoch during a positive rate-limit status probe retains the effect gate',async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1000}});
 bridge.handlers.READ_STATUS=(_args,current)=>{current.cancel();return {ready:true,loggedIn:true,account:'王同学'};};
 await assert.rejects(browser.call('READ_CARDS'),{code:'STOPPED'});assert.ok(browser.rateGate);
 await assert.rejects(browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'}),{code:'RATE_LIMIT'});assert.equal(bridge.calls.some(call=>call.op==='NAV_SEARCH'),false);
});

for(const status of [{ready:false,loggedIn:true,account:'王同学'},{ready:true,loggedIn:false,account:'王同学'},{ready:true,loggedIn:true,account:''},{ready:true,loggedIn:true,account:'登录'}])test(`an unready or unauthenticated rate-limit probe retains the effect gate: ${JSON.stringify(status)}`,async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1000}});bridge.handlers.READ_STATUS=()=>status;
 await assert.rejects(browser.call('READ_CARDS'),{code:'LOGIN_REQUIRED'});assert.ok(browser.rateGate);
 await assert.rejects(browser.call('NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'}),{code:'RATE_LIMIT'});assert.equal(bridge.calls.some(call=>call.op==='NAV_SEARCH'),false);
});

test('one readiness wait shares at most three actual rate-limit probes across successful empty reads',async()=>{
 const {browser,bridge}=await retryFixture();browser.timeoutMs=12000;let reads=0;
 bridge.handlers.READ_CARDS=()=>++reads%2?{risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:1}}:{ready:false};
 await assert.rejects(browser.until(()=>browser.call('READ_CARDS'),value=>value.ready===true,null),{code:'RATE_LIMIT'});
 assert.equal(bridge.calls.filter(call=>call.op==='READ_STATUS').length,3);
 assert.equal(reads,7);assert.ok(browser.rateGate);
});

test('one readiness wait shares two transient read retries without counting successful pending reads',async()=>{
 const {browser,bridge,events}=await retryFixture();browser.timeoutMs=12000;let reads=0;
 bridge.handlers.READ_CARDS=()=>{if(++reads%2)throw Object.assign(Error('temporary read failure'),{code:'ECONNRESET'});return {ready:false};};
 await assert.rejects(browser.until(()=>browser.call('READ_CARDS'),value=>value.ready===true,null),{code:'ECONNRESET'});
 assert.equal(reads,5);assert.equal(events.filter(event=>event.type==='read_retry').length,2);
});

for(const change of ['epoch','active','connection','checkpoint'])test(`generic recovery status keeps the gate when its ${change} changes before acknowledgement consumption`,async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers.OPEN_CONTACT=()=>({risk:{code:'RATE_LIMIT',message:'沟通频繁',retryAfterMs:1}});
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'RATE_LIMIT'});await browser.sleep(1);let stopped=false;
 browser.checkpoint=async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});};
 bridge.handlers.READ_STATUS=(_args,current)=>{if(change==='epoch')current.cancel();if(change==='active')current.active=false;if(change==='connection')current.connected=false;if(change==='checkpoint')stopped=true;return {ready:true,loggedIn:true,account:'王同学'};};
 await assert.rejects(browser.call('READ_STATUS'),{code:change==='connection'?'EXTENSION_OFFLINE':'STOPPED'});
 assert.ok(browser.rateGate);assert.deepEqual(sleeps,[1]);
});

test('successful pending page reads do not consume the transient retry or rate recovery budget',async()=>{
 const {browser,bridge,events}=await retryFixture();browser.timeoutMs=12000;let reads=0;
 bridge.handlers.READ_CARDS=()=>({ready:++reads>=16});
 assert.equal((await browser.until(()=>browser.call('READ_CARDS'),value=>value.ready,null)).ready,true);
 assert.equal(reads,16);assert.equal(events.length,0);assert.equal(bridge.calls.some(call=>call.op==='READ_STATUS'),false);
});

test('nested readiness waits cannot reset the outer transient retry budget',async()=>{
 const {browser,bridge,events}=await retryFixture();browser.timeoutMs=12000;let reads=0;
 bridge.handlers.READ_CARDS=()=>{if(++reads%2)throw Object.assign(Error('temporary read failure'),{code:'ECONNRESET'});return {ready:false};};
 const inner=()=>browser.until(()=>browser.call('READ_CARDS'),()=>true,null);
 await assert.rejects(browser.until(inner,value=>value.ready===true,null),{code:'ECONNRESET'});
 assert.equal(reads,5);assert.equal(events.filter(event=>event.type==='read_retry').length,2);
});

test('independent calls receive a fresh retry budget after a readiness wait exhausts its own budget',async()=>{
 const {browser,bridge}=await retryFixture();browser.timeoutMs=12000;let pendingReads=0,statusReads=0;
 bridge.handlers.READ_CARDS=()=>{if(++pendingReads%2)throw Object.assign(Error('temporary read failure'),{code:'ECONNRESET'});return {ready:false};};
 await assert.rejects(browser.until(()=>browser.call('READ_CARDS'),value=>value.ready===true,null),{code:'ECONNRESET'});
 bridge.handlers.READ_STATUS=()=>{if(++statusReads<3)throw Object.assign(Error('temporary read failure'),{code:'ECONNRESET'});return {ready:true,loggedIn:true,account:'王同学'};};
 await browser.call('READ_STATUS');assert.equal(statusReads,3);
});

test('concurrent independent readiness waits retain separate transient retry budgets',async()=>{
 const {browser,bridge,events}=await retryFixture();browser.timeoutMs=12000;const reads={first:0,second:0};
 bridge.handlers.READ_CARDS=args=>{if(++reads[args.fixture]<3)throw Object.assign(Error('temporary read failure'),{code:'ECONNRESET'});return {ready:true};};
 const wait=fixture=>browser.until(()=>browser.call('READ_CARDS',{fixture}),value=>value.ready,null);
 const results=await Promise.all([wait('first'),wait('second')]);assert.ok(results.every(result=>result.ready));
 assert.deepEqual(reads,{first:3,second:3});assert.equal(events.filter(event=>event.type==='read_retry').length,4);
});

test('an earlier recovery status does not clear a concurrent newer rate restriction',async()=>{
 const {browser,bridge}=await retryFixture();bridge.handlers.OPEN_CONTACT=()=>({risk:{code:'RATE_LIMIT',message:'沟通频繁',retryAfterMs:1}});
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'RATE_LIMIT'});await browser.sleep(1);let observed=false;
 bridge.handlers.READ_STATUS=()=>{observed=true;return {ready:true,loggedIn:true,account:'王同学'};};
 browser.checkpoint=async()=>{if(observed){observed=false;browser.recordRateLimit({retryAfterMs:5000});}};
 await browser.call('READ_STATUS');assert.ok(browser.rateGate);
 await assert.rejects(browser.call('FILL_GREETING',{job,greeting:'你好'}),{code:'RATE_LIMIT'});
 assert.equal(bridge.calls.some(call=>call.op==='FILL_GREETING'),false);
});

test('a long rate restriction survives close reopen and early positive status without an automatic wait',async()=>{
 const {browser,bridge,sleeps}=await retryFixture();bridge.handlers.OPEN_CONTACT=()=>({risk:{code:'RATE_LIMIT',message:'沟通频繁',retryAfterMs:7200000}});
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'RATE_LIMIT'});const advertisedUntil=browser.rateGate.until;
 await browser.close();await browser.open();await browser.call('READ_STATUS');
 assert.equal(browser.rateGate.until,advertisedUntil);assert.deepEqual(sleeps,[]);
 await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'RATE_LIMIT'});
 assert.equal(bridge.calls.filter(call=>call.op==='OPEN_CONTACT').length,1);
});

test('real-clock rate cooldown stop remains bounded by one polling slice and sends no probe',async()=>{
 let stopped=false;const {browser,bridge}=setup({browserOptions:{pollMs:10,checkpoint:async()=>{if(stopped)throw Object.assign(Error('stopped'),{code:'STOPPED'});}}});
 await browser.open();bridge.calls.length=0;
 bridge.handlers.READ_CARDS=()=>({risk:{code:'RATE_LIMIT',message:'访问频繁',retryAfterMs:60000}});
 const started=Date.now(),timer=setTimeout(()=>{stopped=true;bridge.cancel();},15);
 try {await assert.rejects(browser.call('READ_CARDS'),{code:'STOPPED'});} finally {clearTimeout(timer);}
 assert.ok(Date.now()-started<500,'stop must not wait for the platform cooldown');
 assert.deepEqual(bridge.calls.map(call=>call.op),['READ_CARDS','CANCEL']);assert.ok(browser.rateGate);
});

test('operation timing records only bounded metadata and excludes message account filename and URL', async()=>{
 let clock=0;
 const {browser,bridge}=setup({browserOptions:{now:()=>clock},handlers:{READ_STATUS:()=>{clock+=17;return{ready:true,loggedIn:true,account:'private account',authPending:false,message:'private message',filename:'private.pdf'};}}});
 await browser.open();await browser.call('READ_STATUS');
 const timing=browser.timingSummary();
 assert.equal(timing.totalRequests,2);assert.equal(timing.samples.at(-1).op,'READ_STATUS');assert.equal(timing.samples.at(-1).elapsedMs,17);assert.equal(timing.samples.at(-1).loggedIn,true);assert.equal(timing.samples.at(-1).page,'profile');
 assert.doesNotMatch(JSON.stringify(timing),/private|https:|documentId|account|filename|message/u);
 timing.samples[0].op='mutated';assert.equal(browser.timingSummary().samples[0].op,'OPEN_SESSION');
 assert.equal(bridge.calls.filter(c=>c.op==='READ_STATUS').length,1);
});

test('operation timing keeps only 64 recent samples and retains bounded per-operation totals',async()=>{
 let clock=0;const {browser}=setup({browserOptions:{now:()=>clock},handlers:{READ_STATUS:()=>{clock+=3;return{ready:true,loggedIn:true,account:'account'};}}});
 await browser.open();for(let i=0;i<100;i++)await browser.call('READ_STATUS');
 const timing=browser.timingSummary();assert.equal(timing.totalRequests,101);assert.equal(timing.samples.length,64);assert.equal(timing.truncated,true);
 const stats=timing.totals.find(row=>row.op==='READ_STATUS');assert.equal(stats.count,100);assert.equal(stats.totalElapsedMs,300);assert.equal(stats.maxElapsedMs,3);assert.equal(stats.errors,0);
});

test('operation timing observes an uncertain effect once without replay and records errors without raw messages',async()=>{
 let clock=0;const {browser,bridge}=setup({browserOptions:{now:()=>clock},handlers:{OPEN_CONTACT:()=>{clock+=11;throw Object.assign(Error('private error text'),{code:'UNKNOWN_RESULT'});}}});
 await browser.open();await assert.rejects(browser.call('OPEN_CONTACT',{job}),{code:'UNKNOWN_RESULT'});
 const sample=browser.timingSummary().samples.at(-1);assert.equal(sample.op,'OPEN_CONTACT');assert.equal(sample.elapsedMs,11);assert.equal(sample.errorCode,'UNKNOWN_RESULT');assert.doesNotMatch(JSON.stringify(sample),/private|args|account/u);assert.equal(bridge.calls.filter(c=>c.op==='OPEN_CONTACT').length,1);
});

test('bounded measurement scope stops at the first rate limit and retains its gate without recovery reads',async()=>{
 const {browser,bridge}=setup({handlers:{READ_STATUS:()=>({risk:{code:'RATE_LIMIT',message:'too frequent',retryAfterMs:1000}})}});
 await browser.open();await assert.rejects(browser.withFailFastReads(()=>browser.call('READ_STATUS')),{code:'RATE_LIMIT'});
 assert.equal(bridge.calls.filter(c=>c.op==='READ_STATUS').length,1);assert.ok(browser.rateGate);assert.equal(bridge.calls.some(c=>c.op==='OPEN_CONTACT'),false);
});

test('bounded measurement scope does not internally retry transient reads',async()=>{
 const {browser,bridge}=setup({handlers:{READ_STATUS:()=>{throw Object.assign(Error('temporary'),{code:'ECONNRESET'});}}});
 await browser.open();await assert.rejects(browser.withFailFastReads(()=>browser.call('READ_STATUS')),{code:'ECONNRESET'});assert.equal(bridge.calls.filter(c=>c.op==='READ_STATUS').length,1);
});

test('bounded measurement scope preserves normal page hydration polling without adding failure retries',async()=>{
 let reads=0;const {browser,bridge}=setup({browserOptions:{timeoutMs:100,pollMs:1},handlers:{READ_STATUS:()=>{if(++reads===1)throw Object.assign(Error('not hydrated'),{code:'PAGE_NOT_READY'});return{ready:true,loggedIn:true,account:'account'};}}});
 await browser.open();const status=await browser.withFailFastReads(()=>browser.until(()=>browser.call('READ_STATUS'),value=>value.ready,null));assert.equal(status.ready,true);assert.equal(bridge.calls.filter(c=>c.op==='READ_STATUS').length,2);
});

test('bounded measurement scope rejects conversation document changes without refreshing or re-reading',async()=>{
 const {browser,bridge}=setup({handlers:{READ_CONVERSATION:()=>{throw Object.assign(Error('changed'),{code:'DOCUMENT_CHANGED'});}}});
 await browser.open();bridge.calls.length=0;
 await assert.rejects(browser.withFailFastReads(()=>browser.conversation(job)),{code:'DOCUMENT_CHANGED'});
 assert.deepEqual(bridge.calls.map(c=>c.op),['READ_CONVERSATION']);
});
