import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chromium } from 'playwright';
import { ExtensionBridge } from '../src/extension-bridge.js';
import { ExtensionBrowser } from '../src/extension-browser.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { EXTENSION_ID } from '../extension/identity.js';

const fixtureMarker='boss-lifecycle-local';
const job={id:'lifecycle123',url:'https://www.zhipin.com/job_detail/lifecycle123.html',title:'AI Agent开发实习生',company:'示例科技',city:'北京',description:'实习开发LLM Agent工具调用',recruiterName:'林闻'};
const account='<nav class="user-nav"><span class="user-name">测试求职者</span></nav>';
const shell=body=>`<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地求职流程夹具</title><body data-fixture="${fixtureMarker}">${account}${body}</body></html>`;
const jobDocument=shell(`<main class="job-primary detail-box"><h1>${job.title}</h1><span class="company-name">${job.company}</span><span class="text-city">北京</span><div class="job-op"><div class="btn-container"><div class="btn btn-startchat-wrap"><a class="btn btn-startchat" href="javascript:void(0)">立即沟通</a></div></div></div></main><section class="job-detail"><section class="job-detail-section"><h3>职位描述</h3><div class="job-sec-text">${job.description}</div><div class="job-boss-info"><h2 class="name">林闻<i class="icon-vip"></i><span class="boss-active-time">今日活跃</span></h2></div></section></section><script>
const contact=document.querySelector('.btn-startchat');if(localStorage.getItem('nativeGreetings'))contact.textContent='继续沟通';
contact.onclick=()=>{
 if(contact.textContent==='继续沟通'){fetch('/_fixture/event?kind=existing');location.href='https://www.zhipin.com/web/geek/chat';return;}
 localStorage.setItem('nativeGreetings',String(Number(localStorage.getItem('nativeGreetings')||0)+1));fetch('/_fixture/event?kind=greeting');contact.textContent='继续沟通';
 document.body.insertAdjacentHTML('beforeend','<div class="dialog-wrap startchat-dialog"><div class="dialog-layer"></div><div class="dialog-container"><div class="dialog-title"><h3 class="title"><div class="startchat-title"><img class="avatar"><div class="boss-info"><div class="name">林闻</div><div class="position">示例科技·招聘经理</div></div></div></h3><a class="close" href="javascript:;" style="display:inline-block;width:20px;height:20px"></a></div><div class="dialog-con"><div class="startchat-content"><ul class="message-list"><li class="message-item"><span class="status success">已发送</span><p class="text">您好，我对您发布的岗位感兴趣。</p></li></ul><button class="send-message disable" disabled>发送</button></div></div></div></div>');
 document.querySelector('.startchat-dialog .close').onclick=function(){fetch('/_fixture/event?kind=close');this.closest('.startchat-dialog').remove();};
};</script>`);
const chatDocument=shell(`<section class="chat-container page-container"><div class="chat-wrap"><main class="chat-conversation"><header><div class="user-info"><span class="name">林闻</span><span class="company">示例科技</span></div></header><div class="chat-position-content"><div class="left-content"><span class="position-name">${job.title}</span><span class="salary">150-250元/天</span><span class="city">苏州</span></div></div><div class="messages"><div class="message-item item-myself"><div class="message-content"><div class="text"><div><div class="text-content">您好，我对您发布的岗位感兴趣。</div></div></div></div></div></div><div class="chat-im chat-editor"><div class="toolbar-btn-content"><div class="toolbar-btn tooltip tooltip-top unable">发简历</div></div><textarea></textarea><button>发送</button></div></main></div></section><script>
document.querySelector('.left-content').onclick=()=>{fetch('/_fixture/event?kind=preview');window.open('${job.url}?fixture-preview=1','_blank');};
document.querySelector('.toolbar-btn').onclick=()=>fetch('/_fixture/event?kind=resume');
document.querySelector('.chat-editor button').onclick=()=>fetch('/_fixture/event?kind=send');
</script>`);

for(const scenario of ['native','lateChild','lostExistingAck'])test(scenario==='lateChild'?'real MV3 late preview ambiguity revokes its written DOM binding without sending a resume':scenario==='lostExistingAck'?'real MV3 existing contact hard-navigation survives a lost acknowledgement through read-only job verification':'real MV3 lifecycle confirms one native greeting binds its actual job preview and honors blocked resume',async t=>{
 const lateChild=scenario==='lateChild',lostExistingAck=scenario==='lostExistingAck';
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-mv3-lifecycle-'));const store=new Store(path.join(dir,'store'));
 store.saveConfig({...store.loadConfig(),contactCompanyTarget:1,resumeCompanyTarget:1,setupComplete:true});store.upsertJob(job);
 const bridge=new ExtensionBridge({dataDir:path.join(dir,'bridge'),pollMs:100,timeoutMs:12000});const operations=[],bridgeRequests=[],siteRequests=[],siteEvents=[],pageErrors=[];
 let bindReady,releaseBind;const afterBind=new Promise(resolve=>{bindReady=resolve;});
 const server=createServer(async(req,res)=>{
  if(req.url==='/_test/after-bind'){releaseBind=()=>{if(res.writableEnded||res.destroyed)return;res.setHeader('content-type','application/json');res.end('{}');};bindReady();return;}
  bridgeRequests.push({path:req.url,method:req.method});const originalEnd=res.end.bind(res);res.end=(chunk,...rest)=>{try{const packet=JSON.parse(chunk);if(packet.command)operations.push(packet.command.op);}catch{}return originalEnd(chunk,...rest);};
  if(!await bridge.handle(req,res,new URL(req.url,'http://127.0.0.1'))){res.writeHead(404);res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const fixture=createHttpsServer({key:await readFile(new URL('./fixtures/test-only-tls-key.pem',import.meta.url)),cert:await readFile(new URL('./fixtures/test-only-tls-cert.pem',import.meta.url))},(req,res)=>{
  const url=new URL(req.url,'https://www.zhipin.com');siteRequests.push({path:url.pathname,host:req.headers.host});res.setHeader('x-boss-fixture',fixtureMarker);
  if(url.pathname==='/_fixture/event'){siteEvents.push(url.searchParams.get('kind'));res.writeHead(204);res.end();return;}
  res.setHeader('content-type','text/html;charset=utf-8');res.end(url.pathname.startsWith('/job_detail/')?jobDocument:url.pathname==='/web/geek/chat'?chatDocument:shell('<p>登录已完成</p>'));
 });await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const extension=path.resolve('extension');
 const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--host-resolver-rules=MAP www.zhipin.com 127.0.0.1:${fixture.address().port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,'--no-proxy-server']});
 t.after(async()=>{releaseBind?.();bridge.cancel();server.closeAllConnections();fixture.closeAllConnections();await context.close();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>fixture.close(resolve))]);await rm(dir,{recursive:true,force:true});});
 context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
 const popup=await context.newPage();await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);await popup.locator('#base').fill(`http://127.0.0.1:${server.address().port}`);await popup.locator('#code').fill(bridge.snapshot().pairingCode);await popup.locator('button').click();await popup.waitForFunction(()=>document.getElementById('status').textContent.includes('配对成功'));
 const connectedUntil=Date.now()+6000;while(!bridge.isConnected()&&Date.now()<connectedUntil)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(bridge.isConnected(),true);
 const browser=new ExtensionBrowser({bridge,launcher:{async launch(){}},profileDir:path.join(dir,'profile'),timeoutMs:12000,pollMs:25,navigationDelayMs:0});
 const stages=[];let priorJobDocumentId;
 try{
  assert.equal((await browser.login()).loggedIn,true);
  const loginPage=context.pages().find(page=>page.url().startsWith('https://www.zhipin.com/'));assert.ok(loginPage);assert.equal(await loginPage.locator('body').getAttribute('data-fixture'),fixtureMarker);assert.ok(siteRequests.some(request=>request.path==='/web/user/'),'the native tab must reach our local HTTPS server before contact');
  if(lostExistingAck){
   await loginPage.evaluate(()=>localStorage.setItem('nativeGreetings','1'));store.upsertJob(job,{greetingStatus:'sent',resumeStatus:'none'});
   const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');await worker.evaluate(()=>{globalThis.lifecycleReady=[];chrome.runtime.onMessage.addListener((message,sender)=>{if(message?.type==='BOSS_CONTENT_READY')lifecycleReady.push({meta:message.meta,browserDocumentId:sender.documentId,frameId:sender.frameId,tabId:sender.tab?.id});return false;});const actual=chrome.tabs.sendMessage.bind(chrome.tabs);chrome.tabs.sendMessage=async(...args)=>{if(args[1]?.command?.op==='OPEN_CONTACT'&&args[1].command.args?.resumeOnly===true){try{await actual(...args);}catch{}throw Object.assign(new Error('The local hard-navigation fixture lost its existing-contact acknowledgement'),{code:'UNKNOWN_RESULT'});}return actual(...args);};});
   await browser.details(job);priorJobDocumentId=browser.meta.documentId;
  }
  if(lateChild){const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');await worker.evaluate(base=>{globalThis.lifecycleCreated=[];chrome.tabs.onCreated.addListener(tab=>lifecycleCreated.push({id:tab.id,openerTabId:tab.openerTabId,url:tab.url,createdAt:Date.now()}));const actual=chrome.tabs.sendMessage.bind(chrome.tabs);let injected=false;chrome.tabs.sendMessage=async(...args)=>{const result=await actual(...args);if(!injected&&args[1]?.command?.op==='BIND_CONVERSATION_JOB'){injected=true;await fetch(base+'/_test/after-bind');}return result;};},`http://127.0.0.1:${server.address().port}`);}
  const contact=browser.contact(job,{greeting:'自定义招呼不应再次发送',resumeOnly:lostExistingAck,onStage:async(stage,patch)=>{stages.push(stage);store.upsertJob(job,patch);}});
  if(lateChild){
   await afterBind;const chat=context.pages().find(page=>page.url()==='https://www.zhipin.com/web/geek/chat');await chat.bringToFront();await chat.evaluate(()=>window.open('https://www.zhipin.com/job_detail/lifecycle123.html?late-child=1','_blank'));await new Promise(resolve=>setTimeout(resolve,30));releaseBind();
   await assert.rejects(contact,error=>['RECIPIENT_UNVERIFIED','DOCUMENT_CHANGED'].includes(error.code));
   assert.equal((await browser.conversation(job)).verified,false);
   const direct=await popup.evaluate(async job=>{const tabs=await chrome.tabs.query({});const chat=tabs.find(tab=>tab.url==='https://www.zhipin.com/web/geek/chat');return chrome.tabs.sendMessage(chat.id,{type:'BOSS_DOM_COMMAND',command:{op:'READ_CONVERSATION',args:{job}}},{frameId:0});},job);assert.equal(direct.ok,true);assert.equal(direct.result.verified,false,'the DOM binding itself must be revoked, independently of the worker guard');
   assert.deepEqual(stages,['greeting-intent','greeting-sent']);assert.equal(siteEvents.filter(event=>event==='greeting').length,1);assert.equal(siteEvents.some(event=>event==='resume'||event==='send'),false);assert.deepEqual(store.companyCounts(),{contactedCompanies:1,deliveredCompanies:0});
   await browser.close();return;
  }
  const result=await contact;
  if(lostExistingAck){
   assert.equal(result.greetingStatus,'existing');assert.equal(result.resumeStatus,'unavailable');assert.equal(stages.includes('greeting-intent'),false);assert.equal(stages.some(stage=>stage.startsWith('resume-intent')),false);
   assert.equal(siteEvents.filter(event=>event==='greeting').length,0);assert.equal(siteEvents.filter(event=>event==='existing').length,1);assert.equal(siteEvents.filter(event=>event==='preview').length,1);assert.equal(siteEvents.some(event=>event==='resume'||event==='send'),false);
   assert.equal(operations.filter(op=>op==='OPEN_CONTACT').length,1);assert.equal(operations.filter(op=>op==='VERIFY_CONVERSATION_JOB').length,1);assert.equal(operations.some(op=>['REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME','SEND_GREETING'].includes(op)),false);
   const chat=context.pages().find(page=>page.url()==='https://www.zhipin.com/web/geek/chat');assert.ok(chat);assert.notEqual(browser.meta.documentId,priorJobDocumentId,'the portal must be a new content document rather than pushState in the job page');const ready=await context.serviceWorkers()[0].evaluate(()=>lifecycleReady.filter(entry=>entry.meta.url==='https://www.zhipin.com/web/geek/chat'));assert.ok(ready.length>=2,'read-only recovery must re-announce the portal after its initial document registration');assert.equal(new Set(ready.map(entry=>entry.browserDocumentId)).size,1);assert.equal(ready.every(entry=>entry.frameId===0&&typeof entry.browserDocumentId==='string'&&entry.browserDocumentId!==entry.meta.documentId),true,'Chrome supplies the real frame-zero document ID independently of the DOM nonce');assert.equal(await chat.locator('body').getAttribute('data-fixture'),fixtureMarker);assert.ok(siteRequests.some(request=>request.path==='/web/geek/chat'));assert.equal(await chat.evaluate(()=>Number(localStorage.getItem('nativeGreetings'))),1);await browser.close();return;
  }
  assert.equal(result.greetingStatus,'sent');assert.equal(result.resumeStatus,'unavailable');assert.deepEqual(stages,['greeting-intent','greeting-sent','resume-unavailable']);
  const chatPage=context.pages().find(page=>page.url()==='https://www.zhipin.com/web/geek/chat');assert.ok(chatPage);assert.equal(await chatPage.locator('body').getAttribute('data-fixture'),fixtureMarker);assert.equal(await chatPage.evaluate(()=>Number(localStorage.getItem('nativeGreetings'))),1);
  assert.equal(siteEvents.filter(event=>event==='greeting').length,1);assert.equal(siteEvents.filter(event=>event==='preview').length,1);assert.equal(siteEvents.filter(event=>event==='resume'||event==='send').length,0);
  assert.ok(siteRequests.filter(request=>request.path===job.url.slice('https://www.zhipin.com'.length)).length>=2,'main job and the site-created preview must both reach the local fixture');assert.ok(siteRequests.some(request=>request.path==='/web/geek/chat'));assert.ok(siteRequests.every(request=>request.host==='www.zhipin.com'));
  assert.equal(operations.filter(op=>op==='OPEN_CONTACT').length,2);assert.equal(operations.filter(op=>op==='VERIFY_CONVERSATION_JOB').length,1);assert.equal(operations.includes('DISMISS_CONTACT_CONFIRMATION'),true);assert.equal(operations.some(op=>['REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME','SEND_GREETING'].includes(op)),false);
  assert.deepEqual(store.companyCounts(),{contactedCompanies:1,deliveredCompanies:0});const runner=new Runner({store,browser});assert.deepEqual(runner.goalSnapshot(),{contactedCompanies:1,deliveredCompanies:0,contactTarget:1,resumeTarget:1,contactReached:true,resumeReached:false,complete:false});assert.equal(pageErrors.length,0);await browser.close();
 }catch(error){
  let tabs,created;try{tabs=await popup.evaluate(()=>chrome.tabs.query({}));if(lateChild)created=await context.serviceWorkers()[0].evaluate(()=>globalThis.lifecycleCreated);}catch{tabs=context.pages().map(page=>({url:page.url()}));}
  const diagnostic=`${error.message}; fixture=${JSON.stringify({operations,siteRequests,siteEvents,stages,bridgeRequests:bridgeRequests.slice(-20),tabs:tabs.map(tab=>({id:tab.id,url:tab.url,status:tab.status,openerTabId:tab.openerTabId})),created,pageErrors})}`;
  process.stderr.write(diagnostic+'\n');
  throw Object.assign(new Error(diagnostic,{cause:error}),{code:error.code});
 }
});
