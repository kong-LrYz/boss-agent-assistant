import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {chromium} from 'playwright';
import {ExtensionBridge} from '../src/extension-bridge.js';
import {ExtensionBrowser} from '../src/extension-browser.js';
import {EXTENSION_ID} from '../extension/identity.js';

async function bounded(promise,timeoutMs,message){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeoutMs);})]);}finally{clearTimeout(timer);}
}

async function mv3Fixture(t,{slowSearchMs=0,slowResourceMs=0,slowStartupMs=0}={}){
 const fixtureStarted=Date.now(),normalLeaseMs=8000;
 const dir=await mkdtemp(path.join(os.tmpdir(),'boss-extension-e2e-'));const bridge=new ExtensionBridge({dataDir:path.join(dir,'data'),pollMs:500,timeoutMs:8000});const observed=[];
 const record=value=>{observed.push({atMs:Date.now()-fixtureStarted,...value});};
 const request=bridge.request.bind(bridge);
 bridge.request=async(op,args,options={})=>{
  const start=Date.now();
  record({phase:'dispatch',op,epoch:bridge.epoch,timeoutMs:options.timeoutMs??bridge.timeoutMs,leaseMs:op==='OPEN_SESSION'?bridge.sessionLeaseMs:bridge.leaseMs});
  try{const result=await request(op,args,options);record({phase:'acknowledged',op,elapsedMs:Date.now()-start});return result;}
  catch(error){record({phase:'failed',op,elapsedMs:Date.now()-start,code:error.code??error.name});throw error;}
 };
 const server=createServer(async(req,res)=>{record({path:req.url,origin:req.headers.origin??null,method:req.method});const end=res.end.bind(res);res.end=(chunk,...args)=>{try{const data=JSON.parse(chunk);if(data.epoch)record({phase:'delivered',epoch:data.epoch,op:data.command?.op,id:data.command?.id});}catch{}return end(chunk,...args);};if(!await bridge.handle(req,res,new URL(req.url,`http://127.0.0.1:${server.address().port}`))){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const html=(await readFile('tests/fixtures/jobs.html','utf8')).replaceAll('__MODE__','authenticated');
 const fixtureRequests=[];
 const resourceTimers=new Set();let resourceCompletions=0;
 const fixture=createHttpsServer({key:await readFile('tests/fixtures/test-only-tls-key.pem'),cert:await readFile('tests/fixtures/test-only-tls-cert.pem')},(req,res)=>{fixtureRequests.push(req.url);res.setHeader('content-type','text/html;charset=utf-8');const url=new URL(req.url,'https://www.zhipin.com');if(slowResourceMs&&url.pathname==='/local-slow-image'){const timer=setTimeout(()=>{resourceTimers.delete(timer);resourceCompletions++;res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');},slowResourceMs);resourceTimers.add(timer);}else if(slowSearchMs&&url.pathname==='/web/geek/jobs'&&url.searchParams.get('query')==='slow AI Agent')setTimeout(()=>res.end(html),slowSearchMs);else res.end(slowResourceMs&&url.pathname==='/web/geek/jobs'&&url.searchParams.get('query')==='slow image AI Agent'?html.replace('</html>','<img src="/local-slow-image" alt=""></html>'):html);});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 const extension=path.resolve('extension');
 // Native chrome.tabs.create starts navigation before a Playwright page route
 // can attach. Map the domain directly to our local TLS fixture and block other
 // DNS names; this test never needs the public BOSS service or a real account.
 const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--host-resolver-rules=MAP www.zhipin.com 127.0.0.1:${fixture.address().port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,'--no-proxy-server']});
 t.after(async()=>{bridge.cancel();await context.close();for(const timer of resourceTimers)clearTimeout(timer);server.closeAllConnections();fixture.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>fixture.close(r))]);await rm(dir,{recursive:true,force:true});});
 if(slowStartupMs){
  // Reproduce a hosted runner that schedules its first native tab slowly.
  // This setup delay is independent of the later search/image speed check.
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  await worker.evaluate(delay=>{const create=chrome.tabs.create.bind(chrome.tabs);let delayed=false;chrome.tabs.create=async(...args)=>{if(!delayed&&args[0]?.url==='https://www.zhipin.com/web/user/'){delayed=true;await new Promise(resolve=>setTimeout(resolve,delay));}return create(...args);};},slowStartupMs);
 }
 const popup=await context.newPage();await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
 const phase=async(name,operation)=>{
  record({phase:name});
  try{return await operation();}
  catch(error){
   let state;try{state=await bounded(popup.evaluate(async()=>({status:await chrome.runtime.sendMessage({type:'BOSS_BRIDGE_STATUS'}),tabs:(await chrome.tabs.query({})).slice(0,12).map(tab=>({id:tab.id,url:tab.url,status:tab.status,pendingUrl:tab.pendingUrl??null}))})),2000,'fixture diagnostic unavailable');}catch{state={pages:context.pages().slice(0,12).map(page=>page.url())};}
   throw Object.assign(Error(`${error.message}; phase=${name}; fixture=${JSON.stringify({state,trace:observed.slice(-48),requests:fixtureRequests.slice(-12)})}`,{cause:error}),{code:error.code,operation:error.operation});
  }
 };
 // The popup reads its MV3 worker state asynchronously before enabling pairing.
 // Visibility of the form alone does not prove the submit listener is ready.
 await popup.waitForFunction(()=>document.getElementById('status').textContent.startsWith('尚未配对'));
 await popup.locator('#base').fill(`http://127.0.0.1:${server.address().port}`);await popup.locator('#code').fill(bridge.snapshot().pairingCode);await popup.locator('button').click();
 try{await popup.waitForFunction(()=>document.getElementById('status').textContent.includes('配对成功'),null,{timeout:6000});}
 catch(error){throw Error(`${await popup.locator('#status').innerText()}; trace=${JSON.stringify(observed.slice(-48))}`,{cause:error});}
 const end=Date.now()+6000;while(!bridge.isConnected()&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
 assert.ok(bridge.isConnected(),JSON.stringify(observed.slice(-48)));return {bridge,popup,context,observed,dir,fixtureRequests,phase,normalLeaseMs,resourceCompletions:()=>resourceCompletions};
}
test('real MV3 reads a hydrated registered job document before its slow image finishes',async t=>{
 const f=await mv3Fixture(t,{slowResourceMs:3000,slowStartupMs:8250});const browser=new ExtensionBrowser({bridge:f.bridge,launcher:{async launch(){}},profileDir:path.join(f.dir,'profile'),sessionTimeoutMs:15000,timeoutMs:12000,pollMs:50,navigationDelayMs:0});
 assert.equal((await f.phase('login',()=>browser.login())).loggedIn,true);assert.equal(f.bridge.leaseMs,f.normalLeaseMs);const started=Date.now();
 assert.ok(f.observed.find(event=>event.phase==='acknowledged'&&event.op==='OPEN_SESSION').elapsedMs>f.normalLeaseMs,'cold tab setup must exercise the startup deadline without replay');
 const rows=await f.phase('search',()=>browser.discover('slow image AI Agent',{cityCode:'101010100',maxPages:1}));const elapsed=Date.now()-started;
 assert.ok(browser.meta.documentId);assert.equal(new URL(browser.meta.url).searchParams.get('query'),'slow image AI Agent');assert.equal(f.resourceCompletions(),0,'a ready DOM must not wait for nonessential images');
 const tab=await f.popup.evaluate(async()=>{const status=await chrome.runtime.sendMessage({type:'BOSS_BRIDGE_STATUS'});return chrome.tabs.get(status.workTab);});assert.equal(tab.status,'loading');assert.ok(f.fixtureRequests.includes('/local-slow-image'));
 assert.equal(rows[0].id,'a123');assert.equal(rows[0].company,'示例科技');assert.equal(f.observed.filter(event=>event.phase==='delivered'&&event.op==='OPEN_SESSION').length,1);assert.equal(f.observed.filter(event=>event.phase==='delivered'&&event.op==='NAV_SEARCH').length,1);
 assert.equal(f.observed.some(event=>['OPEN_CONTACT','SEND_GREETING','REQUEST_RESUME','CONFIRM_RESUME'].includes(event.op)),false);t.diagnostic(`local MV3 hydrated navigation ${elapsed} ms; image held 3000 ms`);await f.phase('close',()=>browser.close());
});
test('real MV3 refreshes the same registered document after a history route change while its image still loads',async t=>{
 const f=await mv3Fixture(t,{slowResourceMs:3000});const browser=new ExtensionBrowser({bridge:f.bridge,launcher:{async launch(){}},profileDir:path.join(f.dir,'profile'),sessionTimeoutMs:15000,timeoutMs:12000,pollMs:50,navigationDelayMs:0});
 assert.equal((await f.phase('login',()=>browser.login())).loggedIn,true);assert.equal(f.bridge.leaseMs,f.normalLeaseMs);await f.phase('search',()=>browser.discover('slow image AI Agent',{cityCode:'101010100',maxPages:1}));const original={...browser.meta};
 const page=f.context.pages().find(page=>page.url()===original.url);assert.ok(page);const updated=await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('spa','hydrated');history.replaceState(null,'',url.href);return location.href;});
 const before=await f.popup.evaluate(async()=>{const status=await chrome.runtime.sendMessage({type:'BOSS_BRIDGE_STATUS'});const tab=await chrome.tabs.get(status.workTab);return{url:tab.url,pendingUrl:tab.pendingUrl??null,status:tab.status};});assert.equal(before.status,'loading');const started=Date.now();const state=await f.phase('history-read',()=>f.bridge.request('READ_STATUS'));const elapsed=Date.now()-started;
 assert.equal(state.meta.url,updated);assert.equal(state.meta.documentId,original.documentId);assert.equal(state.ready,true);assert.equal(f.resourceCompletions(),0,'a same-document history change must not require full resource completion');t.diagnostic(`local same-document route read ${elapsed} ms; tab=${JSON.stringify(before)}; image held 3000 ms`);await f.phase('close',()=>browser.close());
});
test('real MV3 worker pairs over loopback and reads fixture jobs without a DOM debugger transport',async t=>{
 const {bridge,popup,observed,fixtureRequests,phase,normalLeaseMs}=await mv3Fixture(t);bridge.beginRun();
 let opened,rows;
 try{opened=await phase('open-session',()=>bridge.request('OPEN_SESSION',{url:'https://www.zhipin.com/'},{timeoutMs:15000}));assert.equal(bridge.leaseMs,normalLeaseMs);rows=await phase('cards',()=>bridge.request('READ_CARDS'));}
 catch(error){const tabs=await popup.evaluate(()=>chrome.tabs.query({}));const status=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'BOSS_BRIDGE_STATUS'}));throw Object.assign(Error(`${error.message};trace=${JSON.stringify(observed.slice(-48))};tabs=${JSON.stringify(tabs.map(t=>({id:t.id,url:t.url})))};state=${JSON.stringify(status)}`,{cause:error}),{code:error.code,operation:error.operation});}
 assert.ok(opened.meta.documentId);assert.ok(rows.jobs,JSON.stringify({opened,rows,observed}));assert.equal(rows.jobs[0].id,'a123');assert.equal(rows.jobs[0].company,'示例科技');
 assert.equal(opened.meta.url,'https://www.zhipin.com/');
 assert.ok(fixtureRequests.includes('/'),'the MV3 task must load the local HTTPS fixture');
 const next=await bridge.request('NEXT_PAGE',{}, {target:{document:rows.meta}});assert.equal(next.clicked,true);
 await bridge.request('STOP_SESSION');
});

test('real MV3 navigation survives page loading longer than its action lease without repeating navigation',async t=>{
 const {bridge,observed,dir,fixtureRequests,phase,normalLeaseMs}=await mv3Fixture(t,{slowSearchMs:8500});
 const browser=new ExtensionBrowser({bridge,launcher:{async launch(){}},profileDir:path.join(dir,'profile'),sessionTimeoutMs:15000,timeoutMs:12000,pollMs:50,navigationDelayMs:0});
 assert.equal((await phase('login',()=>browser.login())).loggedIn,true);assert.equal(bridge.leaseMs,normalLeaseMs);
 const started=Date.now(),jobs=await phase('search',()=>browser.discover('slow AI Agent',{cityCode:'101010100',maxPages:1}));
 assert.ok(Date.now()-started>=8000);
 assert.equal(jobs[0].id,'a123');assert.equal(jobs[0].company,'示例科技');
 assert.ok(fixtureRequests.some(value=>new URL(value,'https://www.zhipin.com').searchParams.get('query')==='slow AI Agent'),'the delayed navigation must reach the local HTTPS fixture');
 assert.equal(observed.filter(event=>event.phase==='delivered'&&event.op==='NAV_SEARCH').length,1);
 assert.equal(observed.some(event=>['OPEN_CONTACT','SEND_GREETING','REQUEST_RESUME','CONFIRM_RESUME'].includes(event.op)),false);
 const sequence=observed.filter(event=>event.phase==='delivered'&&event.op).map(event=>event.op),navigation=sequence.indexOf('NAV_SEARCH');
 const tail=sequence.slice(navigation+1);
 assert.ok(tail.indexOf('READ_STATUS')>=0);
 assert.ok(tail.indexOf('READ_STATUS')<tail.indexOf('READ_CARDS'));
 await phase('close',()=>browser.close());
});
