import test from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../extension/protocol.js';

test('extension navigation restricts jobs to official HTTPS and pairing to loopback',()=>{
  assert.equal(typeof protocol.jobUrl,'function');
  assert.equal(protocol.jobUrl('https://www.zhipin.com/job_detail/abc.html?ka=test'),'https://www.zhipin.com/job_detail/abc.html');
  assert.equal(protocol.localBase('http://127.0.0.1:17321'),'http://127.0.0.1:17321');
  for(const url of ['https://www.zhipin.com.evil.example/job_detail/abc.html','http://www.zhipin.com/job_detail/abc.html','https://user@www.zhipin.com/job_detail/abc.html','https://www.zhipin.com/other'])assert.throws(()=>protocol.jobUrl(url));
  for(const url of ['http://192.168.1.1:17321','https://127.0.0.1:17321','http://127.0.0.1:17321/?secret=x'])assert.throws(()=>protocol.localBase(url));
});
test('status and contact confirmation operations retain explicit read and mutation classifications',()=>{
 for(const op of ['READ_STATUS','READ_CONTACT_CONFIRMATION','READ_CONVERSATION_VERIFICATION']){assert.equal(protocol.OPS.includes(op),true);assert.equal(protocol.EFFECT_OPS.includes(op),false);assert.equal(protocol.SEND_OPS.includes(op),false);}
 for(const op of ['DISMISS_CONTACT_CONFIRMATION','VERIFY_CONVERSATION_JOB']){assert.equal(protocol.OPS.includes(op),true);assert.equal(protocol.EFFECT_OPS.includes(op),true);assert.equal(protocol.SEND_OPS.includes(op),false);}
 assert.equal(protocol.OPS.includes('BIND_CONVERSATION_JOB'),false);
 assert.equal(new Set(protocol.OPS).size,protocol.OPS.length);
});

async function workerFixture(){
  const imported=await import('../extension/background.js').catch(()=>null);assert.equal(typeof imported?.BrowserWorker,'function');const {BrowserWorker}=imported;
  const tabs=new Map([[9,{id:9,url:'https://www.zhipin.com/',status:'complete'}]]);let next=10,contacts=0;
  const chrome={runtime:{id:'a'.repeat(32)},storage:{session:{async set(){}},local:{async get(){return {};},async set(){}}},tabs:{
    async create({url}){const tab={id:next++,url,status:'complete'};tabs.set(tab.id,tab);return tab;},async get(id){if(!tabs.has(id))throw Error('closed');return tabs.get(id);},
    async remove(id){tabs.delete(id);},async update(id,patch){Object.assign(tabs.get(id),patch);return tabs.get(id);},
    async sendMessage(id,message){if(message.command.op==='OPEN_CONTACT')contacts++;return{ok:true,result:{meta:{url:tabs.get(id).url,title:'fixture',documentId:'doc1'},account:'测试账号'}};}
  }};
  const worker=new BrowserWorker(chrome);worker.epoch='run1';worker.auth={base:'http://127.0.0.1:17321',token:'test',instanceId:'test'};
  worker.send=async()=>({allowed:true});
  let seq=0;const command=(op,args={})=>({v:1,id:'cmd'+(++seq),seq,epoch:'run1',expiresAt:Date.now()+10000,op,args});
  return{worker,tabs,command,contacts:()=>contacts};
}
async function registeredWorkerFixture(){
 const fixture=await workerFixture();const {worker}=fixture;let listener;
 worker.api.runtime.onMessage={addListener(fn){listener=fn;}};worker.api.tabs.onRemoved=tabEvent();worker.api.tabs.onUpdated=tabEvent();worker.api.alarms={onAlarm:tabEvent(),async create(){}};worker.api.storage.session.get=async()=>({});worker.loop=()=>{};await worker.bootstrap();
 await worker.execute(fixture.command('OPEN_SESSION'));
 const sourceUrl='https://www.zhipin.com/web/geek/chat?id=fixture&jobId=a123',liveUrl='https://www.zhipin.com/web/geek/chat';fixture.tabs.get(10).url=liveUrl;
 const meta={url:liveUrl,title:'沟通',documentId:'current-dom',browserSourceUrl:'https://www.zhipin.com/forged',browserDocumentId:'forged-browser'};
 const sender={id:worker.api.runtime.id,frameId:0,tab:{id:10},url:sourceUrl,documentId:'current-browser'};
 listener({type:'BOSS_CONTENT_READY',meta},sender,()=>{});
 return{...fixture,listener,meta,sender,sourceUrl,liveUrl};
}
test('registered Chrome source and current DOM URL remain distinct for a same-document action permit',async()=>{
 const {worker,command,sourceUrl,liveUrl,sender}=await registeredWorkerFixture();const doc=worker.documents.get(10);assert.equal(doc.browserSourceUrl,sourceUrl);assert.equal(doc.url,liveUrl);assert.equal(doc.browserDocumentId,'current-browser');
 let permits=0;worker.send=async()=>{permits++;return{allowed:true};};const action=command('OPEN_CONTACT');action.target={document:{url:liveUrl,documentId:'current-dom'}};worker.domCommand=action;
 const result=await worker.permitDom({id:action.id,epoch:action.epoch,expiresAt:action.expiresAt},sender);assert.equal(result.allowed,true);assert.equal(permits,1);
});
for(const change of ['live-sender','different-query','foreign-host','browser-document','live-url'])test(`registered source permits reject ${change} before asking Node`,async()=>{
 const {worker,command,liveUrl,sender}=await registeredWorkerFixture();let permits=0;worker.send=async()=>{permits++;return{allowed:true};};
 const action=command('OPEN_CONTACT');action.target={document:{url:liveUrl,documentId:'current-dom'}};worker.domCommand=action;const actual={...sender};
 if(change==='live-sender')actual.url=liveUrl;else if(change==='different-query')actual.url+='&forged=1';else if(change==='foreign-host')actual.url='https://example.org/web/geek/chat';else if(change==='browser-document')actual.documentId='different-browser';else worker.documents.set(10,{...worker.documents.get(10),url:liveUrl+'?different=1'});
 assert.equal((await worker.permitDom({id:action.id,epoch:action.epoch,expiresAt:action.expiresAt},actual)).allowed,false);assert.equal(permits,0);
});
test('read and action metadata cannot replace registered Chrome source fields',async()=>{
 const {worker,command,sourceUrl,liveUrl}=await registeredWorkerFixture();worker.api.tabs.sendMessage=async()=>({ok:true,result:{meta:{url:liveUrl,documentId:'current-dom',browserSourceUrl:'https://www.zhipin.com/forged',browserDocumentId:'forged-browser'},ready:true}});
 for(const op of ['READ_STATUS','OPEN_CONTACT']){await worker.execute(command(op));assert.equal(worker.documents.get(10).browserSourceUrl,sourceUrl);assert.equal(worker.documents.get(10).browserDocumentId,'current-browser');}
});
test('extension cleanup closes only its created work tab and preserves preexisting tabs',async()=>{
  const {worker,tabs,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
  assert.equal(tabs.size,2);await worker.execute(command('STOP_SESSION'));assert.deepEqual([...tabs.keys()],[9]);
});
test('opening and reading status use lean frame-zero status while explicit inspection keeps diagnostics',async()=>{
 const {worker,tabs,command}=await workerFixture();const deliveries=[];
 worker.api.tabs.sendMessage=async(id,message,options)=>{deliveries.push({op:message.command.op,options});return{ok:true,result:{meta:{url:tabs.get(id).url,title:'fixture',documentId:'doc1'},loggedIn:true,account:'测试账号',ready:true,...(message.command.op==='INSPECT_PAGE'?{cardObservations:{cardCount:1},detailObservations:{scopes:[]}}:{})}};};
 const opened=await worker.execute(command('OPEN_SESSION'));assert.equal(Object.hasOwn(opened,'cardObservations'),false);assert.equal(Object.hasOwn(opened,'detailObservations'),false);
 let permits=0;worker.send=async()=>{permits++;return{allowed:true};};
 const status=await worker.execute(command('READ_STATUS'));assert.equal(status.loggedIn,true);assert.equal(status.ready,true);assert.equal(Object.hasOwn(status,'cardObservations'),false);assert.equal(Object.hasOwn(status,'detailObservations'),false);
 const inspected=await worker.execute(command('INSPECT_PAGE'));assert.equal(inspected.cardObservations.cardCount,1);assert.deepEqual(inspected.detailObservations,{scopes:[]});assert.equal(permits,0);
 assert.deepEqual(deliveries.map(delivery=>delivery.op),['READ_STATUS','READ_STATUS','INSPECT_PAGE']);for(const delivery of deliveries)assert.deepEqual(delivery.options,{frameId:0});
});
test('lean status preserves risk and does not authorize a document without a browser binding',async()=>{
 const {worker,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));let delivered=0;
 worker.api.tabs.sendMessage=async()=>{delivered++;return{ok:true,result:{meta:{url:'https://www.zhipin.com/web/user/',documentId:'new-dom'},risk:{code:'CAPTCHA',message:'请手动处理'}}};};
 worker.documents.set(10,{url:'https://www.zhipin.com/web/user/',documentId:'old-dom',browserDocumentId:'old-browser'});
 const status=await worker.execute(command('READ_STATUS'));assert.equal(status.risk.code,'CAPTCHA');assert.equal(worker.documents.has(10),false);
 await assert.rejects(worker.execute(command('DISMISS_CONTACT_CONFIRMATION',{job:{id:'a123'}})),{code:'DOCUMENT_CHANGED'});assert.equal(delivered,1);
});
for(const op of ['READ_STATUS','INSPECT_PAGE'])test(`${op} accepts a registered hydrated document while nonessential resources are loading`,async t=>{
 const {worker,tabs,command,meta,liveUrl}=await registeredWorkerFixture();tabs.get(10).status='loading';const deliveries=[];
 worker.api.tabs.sendMessage=async(id,message,options)=>{deliveries.push({op:message.command.op,options});return{ok:true,result:{meta,ready:true,loggedIn:true,account:'测试账号'}};};
 t.mock.timers.enable({apis:['Date','setTimeout']});const pending=worker.execute(command(op));pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(11000);
 const result=await pending;assert.equal(result.ready,true);assert.equal(result.meta.url,liveUrl);assert.equal(tabs.get(10).status,'loading');assert.equal(worker.documents.get(10).browserDocumentId,'current-browser');assert.deepEqual(deliveries,[{op,options:{frameId:0}}]);
});
for(const code of ['CAPTCHA','RATE_LIMIT','LOGIN_REQUIRED'])test(`a registered loading document surfaces ${code} before resource completion`,async t=>{
 const {worker,tabs,command,meta}=await registeredWorkerFixture();tabs.get(10).status='loading';worker.api.tabs.sendMessage=async()=>({ok:true,result:{meta,risk:{code,message:'可见限制'},authPending:code==='LOGIN_REQUIRED'}});
 t.mock.timers.enable({apis:['Date','setTimeout']});const pending=worker.execute(command('READ_STATUS'));pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(11000);
 const result=await pending;assert.equal(result.risk.code,code);assert.equal(tabs.get(10).status,'loading');
});
for(const change of ['no-registration','no-browser-nonce','old-dom','old-url','pending-redirect','not-hydrated','no-receiver','url-during-read','document-during-read'])test(`loading readiness cannot use ${change} as positive current-document evidence`,async t=>{
 const {worker,tabs,command,meta}=await registeredWorkerFixture();tabs.get(10).status='loading';const reply={...meta};let reads=0;
 if(change==='no-registration')worker.documents.delete(10);if(change==='no-browser-nonce')worker.documents.set(10,{...worker.documents.get(10),browserDocumentId:null});if(change==='old-dom')reply.documentId='old-dom';if(change==='old-url')reply.url='https://www.zhipin.com/job_detail/old.html';if(change==='pending-redirect')tabs.get(10).pendingUrl='https://www.zhipin.com/job_detail/other.html';
 worker.api.tabs.sendMessage=async()=>{reads++;if(change==='no-receiver')throw Error('receiver has not been injected');if(change==='url-during-read')tabs.get(10).url='https://www.zhipin.com/job_detail/other.html';if(change==='document-during-read')worker.documents.set(10,{...worker.documents.get(10),documentId:'replacement-dom',browserDocumentId:'replacement-browser'});return{ok:true,result:{meta:reply,ready:change!=='not-hydrated',loggedIn:true,account:'测试账号'}};};
 t.mock.timers.enable({apis:['Date','setTimeout']});let settled=false;const pending=worker.execute(command('READ_STATUS'));pending.finally(()=>{settled=true;}).catch(()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'unverified loading response must remain pending');t.mock.timers.tick(11000);await assert.rejects(pending,{code:'PAGE_NOT_READY'});assert.equal(tabs.get(10).status,'loading');if(change==='pending-redirect')assert.equal(reads,0);
});
test('loading readiness is revoked when its owned session is stopped',async t=>{
 const {worker,tabs,command,meta}=await registeredWorkerFixture();tabs.get(10).status='loading';worker.api.tabs.sendMessage=async()=>({ok:true,result:{meta,ready:false}});
 t.mock.timers.enable({apis:['Date','setTimeout']});const pending=worker.execute(command('READ_STATUS'));pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));await worker.cleanup();t.mock.timers.tick(150);await assert.rejects(pending,{code:'BROWSER_CLOSED'});
});
test('loading readiness rejects a changed epoch before accepting a positive document',async t=>{
 const {worker,tabs,command,meta}=await registeredWorkerFixture();tabs.get(10).status='loading';worker.api.tabs.sendMessage=async()=>{worker.epoch='different-run';return{ok:true,result:{meta,ready:true}};};
 t.mock.timers.enable({apis:['Date','setTimeout']});const pending=worker.execute(command('READ_STATUS'));pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(11000);await assert.rejects(pending,{code:'STALE_COMMAND'});
});
test('contact confirmation dismissals retain the pinned document and permit sender checks',async()=>{
 const {worker,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
 worker.documents.set(10,{url:'https://www.zhipin.com/web/user/',documentId:'doc1',browserDocumentId:'browser-doc'});
 let delivery;worker.api.tabs.sendMessage=async(id,message,options)=>{delivery={id,op:message.command.op,options};const action=worker.domCommand;assert.equal(action.op,'DISMISS_CONTACT_CONFIRMATION');const request={id:action.id,epoch:action.epoch,expiresAt:action.expiresAt};const sender={id:'a'.repeat(32),tab:{id:10},frameId:0,documentId:'different-browser-doc',url:'https://www.zhipin.com/web/user/'};assert.equal((await worker.permitDom(request,sender)).allowed,false);sender.documentId='browser-doc';assert.equal((await worker.permitDom(request,sender)).allowed,true);return{ok:true,result:{meta:{url:sender.url,documentId:'doc1'},dismissed:true}};};
 const result=await worker.execute(command('DISMISS_CONTACT_CONFIRMATION',{job:{id:'a123'}}));assert.equal(result.dismissed,true);assert.deepEqual(delivery,{id:10,op:'DISMISS_CONTACT_CONFIRMATION',options:{frameId:0,documentId:'browser-doc'}});assert.equal(worker.domCommand,null);
});
test('extension refuses an expired or duplicate command before a contact can run',async()=>{
  const {worker,command,contacts}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
  const expired=command('OPEN_CONTACT');expired.expiresAt=Date.now()-1;await assert.rejects(worker.execute(expired),e=>e.code==='STALE_COMMAND');
  const first=command('READ_DETAIL');await worker.execute(first);await assert.rejects(worker.execute(first),e=>e.code==='STALE_COMMAND');assert.equal(contacts(),0);
});
test('revoked action permission prevents a recruiter contact',async()=>{
  const {worker,command,contacts}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
  const action=command('OPEN_CONTACT');worker.domCommand=action;worker.documents.set(10,{browserDocumentId:'browser-doc',url:'https://www.zhipin.com/web/user/'});
  worker.send=async()=>({allowed:false});const reply=await worker.permitDom({id:action.id,epoch:action.epoch,expiresAt:action.expiresAt},{id:'a'.repeat(32),tab:{id:10},frameId:0,documentId:'browser-doc',url:'https://www.zhipin.com/web/user/'});
  assert.equal(reply.allowed,false);assert.equal(contacts(),0);
});
test('content permission requests cannot come from a different tab or replaced document',async()=>{
 const {worker,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));const action=command('SEND_GREETING');worker.domCommand=action;
 worker.documents.set(10,{browserDocumentId:'browser-doc',url:'https://www.zhipin.com/web/user/'});
 const request={id:action.id,epoch:action.epoch,expiresAt:action.expiresAt};
 for(const sender of [{id:'a'.repeat(32),tab:{id:9},frameId:0,documentId:'browser-doc',url:'https://www.zhipin.com/web/user/'},{id:'a'.repeat(32),tab:{id:10},frameId:0,documentId:'replaced',url:'https://www.zhipin.com/web/user/'}])assert.equal((await worker.permitDom(request,sender)).allowed,false);
});
test('a new content READY cannot be overwritten by an old contact response',async()=>{
 const {worker,tabs,command}=await workerFixture();let listener;
 worker.api.runtime.onMessage={addListener(fn){listener=fn;}};
 worker.api.tabs.onRemoved=tabEvent();worker.api.tabs.onUpdated=tabEvent();
 worker.api.alarms={onAlarm:tabEvent(),async create(){}};
 worker.api.storage.session.get=async()=>({});worker.loop=()=>{};await worker.bootstrap();
 await worker.execute(command('OPEN_SESSION'));
 const oldMeta={url:'https://www.zhipin.com/job_detail/a123.html',title:'岗位',documentId:'old-dom'};
 tabs.get(10).url=oldMeta.url;worker.documents.set(10,{...oldMeta,browserDocumentId:'old-browser'});
 let release,delivered;const started=new Promise(resolve=>{delivered=resolve;});
 worker.api.tabs.sendMessage=async(id,message,pin)=>{assert.equal(message.command.op,'OPEN_CONTACT');assert.deepEqual(pin,{frameId:0,documentId:'old-browser'});delivered();return new Promise(resolve=>{release=resolve;});};
 const pending=worker.execute(command('OPEN_CONTACT'));const rejected=assert.rejects(pending,{code:'DOCUMENT_CHANGED'});await started;
 const currentMeta={url:'https://www.zhipin.com/web/geek/chat',title:'沟通',documentId:'new-dom'};tabs.get(10).url=currentMeta.url;
 listener({type:'BOSS_CONTENT_READY',meta:currentMeta},{id:worker.api.runtime.id,frameId:0,tab:{id:10},url:currentMeta.url,documentId:'new-browser'},()=>{});
 const current=worker.documents.get(10);assert.equal(current.browserDocumentId,'new-browser');
 release({ok:true,result:{meta:oldMeta,opened:true}});await rejected;
 assert.equal(worker.documents.get(10),current);assert.equal(worker.documents.get(10).documentId,'new-dom');assert.equal(worker.domCommand,null);
});
test('a contact response with a different DOM nonce cannot relabel the pinned browser document',async()=>{
 const {worker,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
 const doc={url:'https://www.zhipin.com/web/geek/chat',documentId:'current-dom',browserDocumentId:'current-browser'};worker.documents.set(10,doc);
 worker.api.tabs.sendMessage=async()=>({ok:true,result:{meta:{url:doc.url,documentId:'different-dom'},opened:true}});
 await assert.rejects(worker.execute(command('OPEN_CONTACT')),{code:'DOCUMENT_CHANGED'});assert.equal(worker.documents.get(10),doc);assert.equal(worker.domCommand,null);
});
test('job navigation rejects a link that points at a different job ID',async()=>{
  const {worker,tabs,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
  await assert.rejects(worker.execute(command('NAV_JOB',{job:{url:'https://www.zhipin.com/job_detail/a.html',navigationUrl:'https://www.zhipin.com/job_detail/b.html'}})),e=>e.code==='INVALID_COMMAND');
  assert.equal(tabs.get(10).url,'https://www.zhipin.com/web/user/');
});
for(const [op,args,destination] of [
 ['NAV_SEARCH',{query:'AI Agent',cityCode:'101010100'},'https://www.zhipin.com/web/geek/jobs?city=101010100&query=AI+Agent'],
 ['NAV_JOB',{job:{url:'https://www.zhipin.com/job_detail/a.html',navigationUrl:'https://www.zhipin.com/job_detail/a.html?ka=search'}},'https://www.zhipin.com/job_detail/a.html?ka=search']
])test(`${op} acknowledges navigation before a page that loads after its eight-second action lease`,async t=>{
 const {worker,tabs,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
 t.mock.timers.enable({apis:['Date','setTimeout']});
 const loadedAt=Date.now()+8500;
 worker.documents.set(10,{url:'https://www.zhipin.com/web/user/',documentId:'old-dom',browserDocumentId:'old-browser'});
 worker.api.tabs.update=async(id,patch)=>{Object.assign(tabs.get(id),patch,{status:'loading'});return tabs.get(id);};
 worker.api.tabs.get=async id=>{const tab=tabs.get(id);if(Date.now()>=loadedAt)tab.status='complete';return tab;};
 const navigation=command(op,args);navigation.expiresAt=Date.now()+8000;
 let observed;const pending=worker.execute(navigation).then(value=>{observed=value;return value;});
 await new Promise(resolve=>setImmediate(resolve));
 try{
   assert.deepEqual(observed,{navigationStarted:true,destination});
   assert.equal(worker.documents.has(10),false);
 }finally{t.mock.timers.tick(8500);await pending;}
 const inspected=await worker.execute(command('INSPECT_PAGE'));
 assert.equal(inspected.meta.url,destination);
 assert.equal(tabs.get(10).status,'complete');
});
test('revoked navigation permission never changes the owned tab URL',async()=>{
 const {worker,tabs,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));
 worker.send=async()=>({allowed:false});
 await assert.rejects(worker.execute(command('NAV_JOB',{job:{url:'https://www.zhipin.com/job_detail/a.html'}})),{code:'STALE_COMMAND'});
 assert.equal(tabs.get(10).url,'https://www.zhipin.com/web/user/');
});
test('only the packaged extension popup can request pairing, including when opened as a tab',async()=>{
 const {BrowserWorker}=await import('../extension/background.js');let listener;
 const event={addListener(){}},storage={};
 const api={runtime:{id:'a'.repeat(32),onMessage:{addListener(fn){listener=fn;}}},tabs:{onRemoved:event,onUpdated:event},alarms:{onAlarm:event,async create(){}},storage:{local:{async get(){return{};},async set(value){Object.assign(storage,value);}},session:{async get(){return{};},async set(){}}}};
 const worker=new BrowserWorker(api,async()=>({ok:true,async json(){return{token:'f'.repeat(64)};}}));
 worker.loop=()=>{};await worker.bootstrap();
 const message={type:'BOSS_PAIR',base:'http://127.0.0.1:17321',code:'1'.repeat(64)};
 assert.equal(listener(message,{id:api.runtime.id,url:'https://www.zhipin.com/',tab:{id:9}},()=>{throw Error('BOSS page must not pair');}),false);assert.equal(worker.auth,null);
 const reply=await new Promise(resolve=>{const keep=listener(message,{id:api.runtime.id,url:`chrome-extension://${api.runtime.id}/popup.html`,tab:{id:10}},resolve);if(!keep)resolve(null);});
 assert.equal(reply?.ok,true);assert.equal(storage.bossBridge.base,'http://127.0.0.1:17321');
});
test('inspection resynchronizes a redirected owned tab without using the stale browser document',async()=>{
 const {worker,tabs,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));tabs.get(10).url='https://www.zhipin.com/';worker.documents.set(10,{url:'https://www.zhipin.com/web/user/',documentId:'old-dom',browserDocumentId:'old-browser-document'});let permits=0;worker.send=async()=>{permits++;return {allowed:true};};const deliveries=[];let first=true;
 worker.api.tabs.sendMessage=async(id,message,options)=>{deliveries.push({id,op:message.command.op,options});if(options.documentId)throw Error('Could not establish connection. Receiving end does not exist.');if(first){first=false;throw Error('Redirect receiver is not ready yet');}return {ok:true,result:{meta:{url:tabs.get(id).url,title:'BOSS',documentId:'new-dom'},ready:true,loggedIn:true,account:'测试账号'}};};
 const result=await worker.execute(command('INSPECT_PAGE'));assert.equal(result.loggedIn,true);assert.equal(result.meta.url,'https://www.zhipin.com/');assert.equal(result.meta.documentId,'new-dom');assert.equal(permits,0);assert.equal(deliveries.length,2);for(const delivery of deliveries)assert.deepEqual(delivery.options,{frameId:0});
 assert.equal(worker.documents.has(10),false);await assert.rejects(worker.execute(command('OPEN_CONTACT')),{code:'DOCUMENT_CHANGED'});assert.equal(deliveries.filter(delivery=>delivery.op==='OPEN_CONTACT').length,0);
 worker.documents.set(10,{url:'https://www.zhipin.com/',documentId:'new-dom',browserDocumentId:'new-browser-document'});await assert.rejects(worker.execute(command('OPEN_CONTACT')),/Receiving end does not exist/u);assert.equal(deliveries.at(-1).options.documentId,'new-browser-document');assert.equal(deliveries.filter(delivery=>delivery.op==='OPEN_CONTACT').length,1);
});

const previewJob={id:'a123',url:'https://www.zhipin.com/job_detail/a123.html',title:'AI Agent开发实习生',company:'示例公司',recruiterName:'测试招聘者'};
function tabEvent(){const listeners=new Set();return{addListener(listener){listeners.add(listener);},emit(...args){for(const listener of listeners)listener(...args);}};}
async function previewFixture(options={}){
 const fixture=await workerFixture();const {worker,tabs,command}=fixture;const events={created:tabEvent(),updated:tabEvent(),removed:tabEvent()};worker.api.tabs.onCreated=events.created;worker.api.tabs.onUpdated=events.updated;worker.api.tabs.onRemoved=events.removed;worker.api.tabs.query=async()=>[...tabs.values()];
 await worker.execute(command('OPEN_SESSION'));tabs.get(10).url='https://www.zhipin.com/web/geek/chat';worker.documents.set(10,{url:tabs.get(10).url,title:'fixture',documentId:'doc1',browserDocumentId:'browser-doc'});
 const removed=[],deliveries=[];let clicks=0,binds=0,permits=0,boundToken=null;
 worker.api.tabs.remove=async id=>{removed.push(id);tabs.delete(id);events.removed.emit(id);};worker.send=async()=>{permits++;return{allowed:options.allowed!==false};};
 const create=spec=>{const tab={id:20,openerTabId:10,url:'https://www.zhipin.com/job_detail/a123.html?from=chat',status:'complete',...spec};tabs.set(tab.id,tab);events.created.emit(tab);return tab;};
 const meta=()=>({url:tabs.get(10).url,title:'fixture',documentId:worker.documents.get(10)?.documentId||'doc1'});
 worker.api.tabs.sendMessage=async(id,message,pin)=>{
  deliveries.push({id,command:message.command,pin});
  if(message.command.op==='VERIFY_CONVERSATION_JOB'){
   const action=worker.domCommand;
   if(!options.skipPermit){const permit=await worker.permitDom({id:action.id,epoch:action.epoch,expiresAt:action.expiresAt},{id:'a'.repeat(32),tab:{id:10},frameId:0,documentId:'browser-doc',url:tabs.get(10).url});if(!permit.allowed)return{ok:false,error:{code:'ACTION_NOT_PERMITTED',message:'未许可'}};}
   clicks++;for(const tab of options.created??[{}])create(tab);
   return{ok:true,result:{meta:meta(),previewStarted:true,previewToken:message.command.args.previewToken}};
  }
  if(message.command.op==='BIND_CONVERSATION_JOB'){binds++;boundToken=message.command.args.previewToken;if(options.ambiguousDuringBind)create({id:21});return{ok:true,result:{meta:meta(),verified:true,jobId:options.boundJobId||previewJob.id}};}
  if(message.command.op==='REVOKE_CONVERSATION_JOB'){if(options.revokeFails)throw Error('fixture revoke unavailable');if(message.command.args.previewToken===boundToken)boundToken=null;return{ok:true,result:{meta:meta(),revoked:true}};}
  if(message.command.op==='READ_CONVERSATION')return{ok:true,result:{meta:meta(),verified:Boolean(boundToken),jobId:previewJob.id}};
  return{ok:true,result:{meta:meta(),ready:true}};
 };
 const packet=(op,args={job:previewJob})=>({...command(op,args),target:{document:{url:tabs.get(10).url,documentId:'doc1'}}});
 return{...fixture,events,create,removed,deliveries,packet,clicks:()=>clicks,binds:()=>binds,permits:()=>permits,bound:()=>Boolean(boundToken)};
}
test('conversation preview binds only a site-created job tab from the permitted owned document and cleans up it alone',async()=>{
 const f=await previewFixture();const started=await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));assert.equal(started.previewStarted,true);assert.equal(f.clicks(),1);assert.equal(f.binds(),0);
 const verified=await f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION'));assert.equal(verified.verified,true);assert.equal(verified.jobId,'a123');assert.equal(f.binds(),1);assert.equal(f.permits(),1);
 const bind=f.deliveries.find(delivery=>delivery.command.op==='BIND_CONVERSATION_JOB');assert.equal(bind.command.args.canonicalURL,'https://www.zhipin.com/job_detail/a123.html');assert.equal(bind.command.args.job.recruiterName,'测试招聘者');assert.match(bind.command.args.previewToken,/^[a-f0-9-]{36}$/u);assert.deepEqual(bind.pin,{frameId:0,documentId:'browser-doc'});assert.equal(bind.command.expectedDocument.documentId,'doc1');assert.deepEqual(f.removed,[20]);assert.deepEqual([...f.tabs.keys()],[9,10]);assert.equal(f.tabs.get(10).active,true);
});
test('loading conversation previews remain read-only pending beyond the capture lease without another click',async t=>{
 const f=await previewFixture({created:[{url:'about:blank',pendingUrl:previewJob.url,status:'loading'}]});t.mock.timers.enable({apis:['Date']});const verify=f.packet('VERIFY_CONVERSATION_JOB');verify.expiresAt=Date.now()+8000;await f.worker.execute(verify);
 let result=await f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION'));assert.equal(result.verified,false);assert.equal(result.pending,true);assert.equal(f.binds(),0);t.mock.timers.tick(9000);result=await f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION'));assert.equal(result.pending,true);assert.equal(f.clicks(),1);
 Object.assign(f.tabs.get(20),{url:previewJob.url,status:'complete'});delete f.tabs.get(20).pendingUrl;assert.equal((await f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION'))).verified,true);assert.equal(f.binds(),1);assert.equal(f.clicks(),1);
});
test('a preview without the content sender permit cannot capture or bind an opened tab',async()=>{
 const f=await previewFixture({skipPermit:true});await assert.rejects(f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB')),{code:'ACTION_NOT_PERMITTED'});assert.equal(f.binds(),0);assert.equal(f.removed.includes(20),false);
});
for(const created of [[{openerTabId:9}],[{openerTabId:undefined}],[{id:9}]])test(`unknown openers or preexisting tabs cannot become conversation proof (${JSON.stringify(created)})`,async t=>{
 const f=await previewFixture({created});t.mock.timers.enable({apis:['Date']});const verify=f.packet('VERIFY_CONVERSATION_JOB');verify.expiresAt=Date.now()+8000;await f.worker.execute(verify);assert.equal((await f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION'))).verified,false);t.mock.timers.tick(9000);await assert.rejects(f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION')),{code:'RECIPIENT_UNVERIFIED'});assert.equal(f.binds(),0);assert.equal(f.removed.includes(created[0].id??20),false);assert.equal(f.tabs.has(9),true);
});
for(const url of ['https://www.zhipin.com/job_detail/other.html','https://example.org/job_detail/a123.html','https://www.zhipin.com.evil.example/job_detail/a123.html','http://www.zhipin.com/job_detail/a123.html','https://user@www.zhipin.com/job_detail/a123.html'])test(`conversation proof rejects the Chrome-observed wrong destination (${url})`,async()=>{
 const f=await previewFixture({created:[{url}]});await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));await assert.rejects(f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION')),{code:'RECIPIENT_UNVERIFIED'});assert.equal(f.binds(),0);assert.deepEqual(f.removed,[20]);assert.equal(f.tabs.has(9),true);
});
test('multiple preview children are ambiguous and neither can be selected as proof',async()=>{
 const f=await previewFixture({created:[{id:20},{id:21}]});await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));await assert.rejects(f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION')),{code:'RECIPIENT_UNVERIFIED'});assert.equal(f.binds(),0);assert.deepEqual(f.removed,[20,21]);assert.equal(f.tabs.has(9),true);
});
test('conversation proof requires fixed job arguments and keeps its binder outside public commands',async()=>{
 const f=await previewFixture();for(const extra of [{previewToken:'forged'},{canonicalURL:previewJob.url},{tabId:9},{script:'return true'}])await assert.rejects(f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB',{job:previewJob,...extra})),{code:'INVALID_COMMAND'});await assert.rejects(f.worker.execute(f.packet('BIND_CONVERSATION_JOB')),{code:'STALE_COMMAND'});assert.equal(f.clicks(),0);assert.equal(f.permits(),0);
});
for(const change of ['epoch','document','work-url'])test(`stale conversation preview context cannot bind after ${change} changes`,async()=>{
 const f=await previewFixture();await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));if(change==='epoch')f.worker.epoch='run2';else if(change==='document')f.worker.documents.set(10,{...f.worker.documents.get(10),documentId:'new-dom',browserDocumentId:'new-browser'});else{f.tabs.get(10).url='https://www.zhipin.com/web/geek/chat?different=1';f.events.updated.emit(10,{url:f.tabs.get(10).url},f.tabs.get(10));}
 const read=f.packet('READ_CONVERSATION_VERIFICATION');read.epoch=f.worker.epoch;await assert.rejects(f.worker.execute(read),{code:'DOCUMENT_CHANGED'});assert.equal(f.binds(),0);assert.equal(f.tabs.has(9),true);
});
test('stopping a preview closes captured temporary and work tabs while preserving unrelated user tabs',async()=>{
 const f=await previewFixture();await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));f.create({id:30,openerTabId:9});await f.worker.execute(f.packet('STOP_SESSION',{}));assert.deepEqual([...f.tabs.keys()],[9,30]);assert.equal(f.binds(),0);
});
test('duplicate verification and a mismatched read never click or bind another job',async()=>{
 const f=await previewFixture({created:[{status:'loading'}]});await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));await assert.rejects(f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB')),{code:'VERIFICATION_PENDING'});await assert.rejects(f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION',{job:{...previewJob,id:'other',url:'https://www.zhipin.com/job_detail/other.html'}})),{code:'RECIPIENT_UNVERIFIED'});assert.equal(f.clicks(),1);assert.equal(f.binds(),0);
});
for(const revokeFails of [false,true])test(`a second child during binding revokes the old proof and grants no future resume permission (${revokeFails?'failed revoke':'successful revoke'})`,async()=>{
 const f=await previewFixture({ambiguousDuringBind:true,revokeFails});await f.worker.execute(f.packet('VERIFY_CONVERSATION_JOB'));await assert.rejects(f.worker.execute(f.packet('READ_CONVERSATION_VERIFICATION')),{code:'DOCUMENT_CHANGED'});assert.equal(f.binds(),1);const permitCount=f.permits();if(!revokeFails)assert.equal(f.bound(),false);
 assert.equal((await f.worker.execute(f.packet('READ_CONVERSATION'))).verified,false);await assert.rejects(f.worker.execute(f.packet('REQUEST_RESUME')),{code:'RECIPIENT_UNVERIFIED'});assert.equal(f.permits(),permitCount);assert.equal(f.deliveries.some(delivery=>delivery.command.op==='REQUEST_RESUME'),false);assert.equal(protocol.OPS.includes('REVOKE_CONVERSATION_JOB'),false);
});
test('inspection retains the real completed sender rejection after a late mutation result was discarded',async t=>{
 const {worker,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));worker.documents.set(10,{url:'https://www.zhipin.com/web/user/',documentId:'doc1',browserDocumentId:'browser-doc'});
 t.mock.timers.enable({apis:['Date']});const rejected=command('VERIFY_CONVERSATION_JOB');rejected.expiresAt=Date.now()+8000;const inspect=command('INSPECT_PAGE');inspect.expiresAt=Date.now()+20000;const execute=worker.execute.bind(worker);let delivered;
 worker.execute=async packet=>{if(packet.op==='VERIFY_CONVERSATION_JOB'){worker.domCommand=packet;const reply=await worker.permitDom({id:packet.id,epoch:packet.epoch,expiresAt:packet.expiresAt},{id:'a'.repeat(32),tab:{id:10},frameId:0,documentId:'browser-doc',url:'https://www.zhipin.com/web/geek/chat'});assert.equal(reply.allowed,false);worker.domCommand=null;t.mock.timers.tick(9000);throw Object.assign(Error('BODY_SECRET https://www.zhipin.com/?token=TOKEN_SECRET'),{code:'ACTION_NOT_PERMITTED'});}return execute(packet);};
 let polls=0;worker.send=async(path,body)=>{if(path==='/bridge/commands'){if(++polls===1)return{epoch:'run1',command:rejected};if(polls===2)return{epoch:'run1',command:inspect};worker.auth=null;return{epoch:'run1',command:null};}if(body.id===rejected.id)throw Error('expired result discarded');delivered=body.result;return{ok:true};};
 await worker.loop();const diagnostic=delivered.lastOperationDiagnostic;assert.equal(diagnostic.op,'VERIFY_CONVERSATION_JOB');assert.equal(diagnostic.errorCode,'ACTION_NOT_PERMITTED');assert.equal(diagnostic.elapsedMs,9000);assert.equal(diagnostic.phase,'permit-url-rejected');assert.equal(diagnostic.previewCapturedCount,0);assert.deepEqual(Object.keys(diagnostic).sort(),['elapsedMs','errorCode','op','phase','previewCapturedCount']);assert.doesNotMatch(JSON.stringify(diagnostic),/SECRET|https|job|招聘者/u);assert.equal(worker.lastOperationDiagnostic.op,'INSPECT_PAGE');
});
test('inspection diagnostic trims only bounded arrays so the complete result packet stays within 64 KiB',async()=>{
 const {worker,command}=await workerFixture();await worker.execute(command('OPEN_SESSION'));worker.lastOperationDiagnostic={op:'VERIFY_CONVERSATION_JOB',errorCode:'ACTION_NOT_PERMITTED',elapsedMs:9000,previewCapturedCount:999,phase:'TOKEN_SECRET',token:'TOKEN_SECRET',url:'https://example.org/BODY_SECRET',job:{company:'HR_SECRET'},body:'BODY_SECRET'};
 worker.api.tabs.sendMessage=async()=>({ok:true,result:{meta:{url:'https://www.zhipin.com/web/user/',documentId:'doc1'},ready:true,cardObservations:{sample:[]},detailObservations:{descriptions:Array.from({length:20},()=>({text:'界'.repeat(1500)}))}}});const packet=command('INSPECT_PAGE');const result=await worker.execute(packet);assert.ok(new TextEncoder().encode(JSON.stringify({id:packet.id,epoch:packet.epoch,result})).length<=65536);assert.ok(result.detailObservations.descriptions.length<20);assert.equal(result.ready,true);assert.ok(result.lastOperationDiagnostic.previewCapturedCount<=20);assert.doesNotMatch(JSON.stringify(result.lastOperationDiagnostic),/SECRET|https|job/u);
});
