import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const job={id:'a123',url:'https://www.zhipin.com/job_detail/a123.html',title:'AI Agent开发实习生',company:'示例科技',city:'北京'};
function html({chatId='a123',message='',multiple=false,risk='',dialog=false}={}){
 return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地DOM测试</title><body>
 <main class="job-detail" data-job-id="a123"><div class="job-title"><h1>AI Agent开发实习生</h1><span class="salary">200-300元/天</span></div><div class="company-name">示例科技</div><div class="job-location">北京·海淀区</div><div class="job-sec-text">实习开发 LLM Agent 工具调用。</div><div class="job-tags"><span>实习</span></div><div class="op"><button id="contact">立即沟通</button></div></main>
 <ul class="job-list-box"><li class="job-card-wrapper"><a href="https://www.zhipin.com/job_detail/a123.html?ka=search_1"><span class="job-name">AI Agent开发实习生</span></a><span class="company-name">示例科技</span><span class="job-area">北京·海淀区</span><ul class="tag-list"><li>实习</li></ul></li><li class="job-card-wrapper"><a href="https://example.org/job_detail/evil.html"><span class="job-name">不可接受地址</span></a><span class="company-name">其他公司</span></li></ul>
 <section class="chat-window" data-job-id="${chatId}"><header class="chat-header"><span class="job-title">AI Agent开发实习生</span><span class="company-name">示例科技</span><a href="https://www.zhipin.com/job_detail/${chatId}.html">查看职位</a></header><div class="messages">${message||'<div class="chat-empty">新会话，尚未发送消息</div>'}</div><div class="chat-editor"><textarea id="editor"></textarea><button id="send">发送</button><button id="resume">发送简历</button></div></section>
 <aside><button onclick="window.wrongSend=true">发送</button></aside>
 ${risk?`<section class="verify-dialog">${risk}</section>`:''}
 ${dialog?`<section class="resume-dialog"><h2>选择附件简历</h2><label class="resume-item"><input type="radio" name="resume"><span class="resume-name">王同学.pdf</span></label>${multiple?'<label class="resume-item"><input type="radio" name="resume"><span class="resume-name">另一个.pdf</span></label>':''}<button id="confirm">发送</button></section>`:''}
 <script>
 document.querySelector('#contact').onclick=()=>{window.contactClicks=(window.contactClicks||0)+1;};
 document.querySelector('#send').onclick=()=>{window.sendClicks=(window.sendClicks||0)+1;const message=document.createElement('div');message.className='message-item sent';message.textContent=document.querySelector('#editor').value;document.querySelector('.messages').append(message);document.querySelector('.chat-empty')?.remove();document.querySelector('#editor').value='';};
 document.querySelector('#resume').onclick=()=>{window.resumeClicks=(window.resumeClicks||0)+1;const message=document.createElement('div');message.className='message-item sent resume-card';message.textContent='已向对方申请发送附件简历，等待对方同意';document.querySelector('.messages').append(message);};
 document.querySelector('#confirm')?.addEventListener('click',()=>{if(!document.querySelector('input[name=resume]:checked'))return;window.confirmClicks=(window.confirmClicks||0)+1;const message=document.createElement('div');message.className='message-item sent resume-attachment';message.textContent='已发送附件简历：王同学.pdf';document.querySelector('.messages').append(message);document.querySelector('.resume-dialog').remove();});
 </script></body></html>`;
}
async function fixture(t,options={}){
 const body=html(options);const server=createServer((request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(body);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 await page.goto(`http://127.0.0.1:${server.address().port}/job_detail/a123.html`);await page.addScriptTag({path:path.join(root,'extension/dom-executor.js')});return page;
}
async function execute(page,op,args={},expected){return page.evaluate(({op,args,expected})=>globalThis.BossDomExecutor.execute({op,args,expiresAt:Date.now()+8000,expectedDocument:expected??globalThis.BossDomExecutor.metadata()}),{op,args,expected});}

test('extension DOM extracts canonical jobs, preserved navigation URL and leaf detail title',async t=>{
 const page=await fixture(t);const cards=await execute(page,'READ_CARDS');assert.equal(cards.jobs.length,1);assert.equal(cards.jobs[0].url,job.url);assert.equal(cards.jobs[0].navigationUrl,job.url+'?ka=search_1');
 const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.job.title,job.title);assert.equal(detail.job.company,job.company);assert.match(detail.job.description,/工具调用/);
});
test('same title/company with a different job ID cannot receive extension sends',async t=>{
 const page=await fixture(t,{chatId:'other123'});assert.equal((await execute(page,'READ_CONVERSATION',{job})).verified,false);
 await assert.rejects(execute(page,'SEND_GREETING',{job,greeting:'你好'}),/RECIPIENT_UNVERIFIED/);assert.equal(await page.evaluate(()=>Boolean(window.sendClicks||window.wrongSend)),false);
});
test('extension risk detection prevents mutations during CAPTCHA',async t=>{
 const page=await fixture(t,{risk:'请完成安全验证'});const result=await execute(page,'OPEN_CONTACT',{job});assert.equal(result.risk.code,'CAPTCHA');assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('extension effect commands reject another document before click',async t=>{
 const page=await fixture(t);const prior=await page.evaluate(()=>BossDomExecutor.metadata());await page.reload();await page.addScriptTag({path:path.join(root,'extension/dom-executor.js')});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job},prior),/DOCUMENT_CHANGED/);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('single resume can be selected and only attachment evidence proves sending',async t=>{
 const page=await fixture(t,{dialog:true});const selected=await execute(page,'SELECT_RESUME',{job});assert.equal(selected.selected,true);assert.equal(selected.name,'王同学.pdf');
 const confirm=await execute(page,'CONFIRM_RESUME',{job});assert.equal(confirm.confirmed,true);assert.equal((await execute(page,'READ_RESUME',{job})).status,'sent');
});
test('multiple resume options require the exact configured name',async t=>{
 const page=await fixture(t,{dialog:true,multiple:true});await assert.rejects(execute(page,'SELECT_RESUME',{job}),/RESUME_SELECTION/);
 const selected=await execute(page,'SELECT_RESUME',{job,resumeName:'王同学.pdf'});assert.equal(selected.name,'王同学.pdf');
});
test('failed and pending resume cards do not claim delivery, later attachment wins',async t=>{
 const pending=await fixture(t,{message:'<div class="message-item sent"><div class="resume-card">已向对方申请发送附件简历，等待对方同意</div></div>'});assert.equal((await execute(pending,'READ_RESUME',{job})).status,'requested');
 const failed=await fixture(t,{message:'<div class="message-item sent resume-attachment">王同学.pdf 发送失败，请重试</div>'});assert.equal((await execute(failed,'READ_RESUME',{job})).status,'uncertain');
 await pending.locator('.messages').evaluate(element=>element.insertAdjacentHTML('beforeend','<div class="message-item sent resume-attachment">已发送附件简历：王同学.pdf</div>'));assert.equal((await execute(pending,'READ_RESUME',{job})).status,'sent');
});
test('resume delivery cannot be inferred from outgoing ordinary text claiming an attachment',async t=>{
 const page=await fixture(t,{message:'<div class="message-item sent">已发送附件简历：普通文本.pdf</div>'});
 assert.equal((await execute(page,'READ_RESUME',{job})).status,'none');
 assert.equal(await page.evaluate(()=>Boolean(window.resumeClicks||window.confirmClicks)),false);
});
for(const value of ['待发送：已有附件.pdf','未发送附件简历：已有附件.pdf','尚未发送：已有附件.pdf','申请发送附件简历：已有附件.pdf，等待对方同意','已有附件.pdf 发送失败'])test(`resume attachment requires successful non-pending evidence (${value})`,async t=>{
 const page=await fixture(t,{message:`<div class="message-item sent resume-attachment">${value}</div>`});
 assert.notEqual((await execute(page,'READ_RESUME',{job})).status,'sent');
});
test('extension greeting uses the verified empty chat and visible sent evidence',async t=>{
 const page=await fixture(t);assert.equal((await execute(page,'READ_CONVERSATION',{job})).emptyNew,true);await execute(page,'FILL_GREETING',{job,greeting:'你好'});await execute(page,'SEND_GREETING',{job,greeting:'你好'});
 assert.equal((await execute(page,'READ_CONVERSATION',{job,greeting:'你好'})).greetingSent,true);assert.equal(await page.evaluate(()=>window.sendClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.wrongSend)),false);
 await assert.rejects(execute(page,'SEND_GREETING',{job,greeting:'你好'}),/DUPLICATE_GREETING/);
});
test('executor refuses arbitrary operations and selector/script input',async t=>{
 const page=await fixture(t);await assert.rejects(execute(page,'EVAL',{script:'alert(1)'}),/COMMAND_INVALID/);await assert.rejects(execute(page,'READ_CARDS',{selector:'button'}),/COMMAND_INVALID/);
});
test('content receiver accepts only its own extension messages',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{globalThis.chrome={runtime:{id:'own-extension',onMessage:{addListener:listener=>{globalThis.testReceiver=listener;}}}};});await page.addScriptTag({path:path.join(root,'extension/content.js')});
 const rejected=await page.evaluate(()=>testReceiver({type:'BOSS_DOM_COMMAND',command:{op:'INSPECT_PAGE'}},{id:'other-extension'},()=>{}));assert.equal(rejected,false);
 const accepted=await page.evaluate(()=>new Promise(resolve=>{testReceiver({type:'BOSS_DOM_COMMAND',command:{op:'INSPECT_PAGE'}},{id:'own-extension'},resolve);}));assert.equal(accepted.ok,true);assert.equal(typeof accepted.result.meta.documentId,'string');
});
test('contact never borrows a button outside the verified detail',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('main .op').remove();document.body.insertAdjacentHTML('beforeend','<section class="job-detail"><div class="op"><button onclick="window.wrongContact=true">立即沟通</button></div></section>');});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/);assert.equal(await page.evaluate(()=>Boolean(window.wrongContact)),false);
});
test('resume confirmation refuses a selection changed after SELECT_RESUME',async t=>{
 const page=await fixture(t,{dialog:true,multiple:true});await execute(page,'SELECT_RESUME',{job,resumeName:'王同学.pdf'});await page.locator('input[name=resume]').nth(1).check();
 await assert.rejects(execute(page,'CONFIRM_RESUME',{job,resumeName:'王同学.pdf'}),/RESUME_SELECTION/);assert.equal(await page.evaluate(()=>Boolean(window.confirmClicks)),false);
});
test('extension effects require document metadata and failed greetings remain uncertain',async t=>{
 const page=await fixture(t,{message:'<div class="message-item sent send-failed">你好，发送失败</div>'});const state=await execute(page,'READ_CONVERSATION',{job});assert.equal(state.greetingSent,false);assert.equal(state.greetingUncertain,true);
 await assert.rejects(page.evaluate(job=>BossDomExecutor.execute({op:'OPEN_CONTACT',args:{job},expiresAt:Date.now()+8000}),job),/DOCUMENT_CHANGED/);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('split detail banner, company sidebar and description retain the verified contact scope',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{const detail=document.querySelector('main.job-detail');detail.className='job-banner';const description=detail.querySelector('.job-sec-text');const company=detail.querySelector('.company-name');const body=document.createElement('section');body.className='job-detail';body.append(description);document.body.append(body);const sidebar=document.createElement('aside');sidebar.className='sider-company';sidebar.append(company);document.body.append(sidebar);});
 const detail=await execute(page,'READ_DETAIL',{job});assert.match(detail.job.description,/工具调用/);assert.equal(detail.job.company,job.company);await execute(page,'OPEN_CONTACT',{job});assert.equal(await page.evaluate(()=>window.contactClicks),1);
});
test('resumeOnly requires a continuing contact button at the exact click boundary',async t=>{
 const page=await fixture(t);assert.equal((await execute(page,'READ_DETAIL',{job})).contactExisting,false);
 await assert.rejects(execute(page,'OPEN_CONTACT',{job,resumeOnly:true}),/RECIPIENT_UNVERIFIED/);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
 await page.locator('#contact').evaluate(button=>{button.textContent='继续沟通';});assert.equal((await execute(page,'READ_DETAIL',{job})).contactExisting,true);
 const result=await execute(page,'OPEN_CONTACT',{job,resumeOnly:true});assert.equal(result.existing,true);assert.equal(await page.evaluate(()=>window.contactClicks),1);
});
test('content announces its document once and ignores duplicate registration',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{globalThis.readyMessages=[];globalThis.receivers=[];globalThis.chrome={runtime:{id:'own-extension',onMessage:{addListener:listener=>receivers.push(listener)},sendMessage:message=>{readyMessages.push(message);return Promise.resolve();}}};});
 await page.addScriptTag({path:path.join(root,'extension/content.js')});await page.addScriptTag({path:path.join(root,'extension/content.js')});const state=await page.evaluate(()=>({messages:readyMessages,receivers:receivers.length,documentId:BossDomExecutor.metadata().documentId}));assert.equal(state.receivers,1);assert.equal(state.messages.length,1);assert.equal(state.messages[0].type,'BOSS_CONTENT_READY');assert.equal(state.messages[0].meta.documentId,state.documentId);
});
test('fixed content status reads await a fresh current-document announcement',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{globalThis.readyMessages=[];globalThis.readResponse=null;globalThis.holdReady=false;globalThis.chrome={runtime:{id:'own-extension',onMessage:{addListener:listener=>{globalThis.testReceiver=listener;}},sendMessage:message=>{readyMessages.push(message);return holdReady?new Promise(resolve=>{globalThis.releaseReady=resolve;}):Promise.resolve();}}};});await page.addScriptTag({path:path.join(root,'extension/content.js')});
 for(const [index,op]of ['READ_STATUS','INSPECT_PAGE'].entries()){
  await page.evaluate(op=>{holdReady=true;readResponse=null;globalThis.pendingRead=new Promise(resolve=>{testReceiver({type:'BOSS_DOM_COMMAND',meta:{documentId:'caller-invented'},command:{op}},{id:'own-extension'},response=>{readResponse=response;resolve(response);});});},op);
  await page.waitForTimeout(20);const before=await page.evaluate(()=>({messages:readyMessages,response:readResponse,meta:BossDomExecutor.metadata()}));assert.equal(before.messages.length,index+2);assert.equal(before.response,null,'the read must wait until the current document has been announced');assert.deepEqual(before.messages.at(-1),{type:'BOSS_CONTENT_READY',meta:before.meta});
  const result=await page.evaluate(async()=>{releaseReady();return pendingRead;});assert.equal(result.ok,true);assert.equal(result.result.meta.documentId,before.meta.documentId);
 }
 const count=await page.evaluate(()=>readyMessages.length);assert.equal(await page.evaluate(()=>testReceiver({type:'BOSS_DOM_COMMAND',command:{op:'READ_STATUS'}},{id:'other-extension'},()=>{})),false);assert.equal(await page.evaluate(()=>readyMessages.length),count);
});
test('status reads tolerate a missing background response without requesting action permission',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{globalThis.runtimeMessages=[];globalThis.chrome={runtime:{id:'own-extension',onMessage:{addListener:listener=>{globalThis.testReceiver=listener;}},sendMessage:message=>{runtimeMessages.push(message);return Promise.reject(new Error('No receiving background'));}}};});await page.addScriptTag({path:path.join(root,'extension/content.js')});
 for(const op of ['READ_STATUS','INSPECT_PAGE']){const result=await page.evaluate(op=>new Promise(resolve=>testReceiver({type:'BOSS_DOM_COMMAND',command:{op}},{id:'own-extension'},resolve)),op);assert.equal(result.ok,true);}
 assert.deepEqual(await page.evaluate(()=>runtimeMessages.map(message=>message.type)),['BOSS_CONTENT_READY','BOSS_CONTENT_READY','BOSS_CONTENT_READY']);
});
test('executor rejects missing expired or non-finite effect deadlines without clicking',async t=>{
 const page=await fixture(t);for(const mode of ['missing','expired','nonfinite'])await assert.rejects(page.evaluate(({job,mode})=>BossDomExecutor.execute({op:'OPEN_CONTACT',args:{job},expectedDocument:BossDomExecutor.metadata(),...(mode==='missing'?{}:{expiresAt:mode==='expired'?Date.now()-1:Infinity})}),{job,mode}),/STALE_COMMAND/);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('executor rechecks the deadline immediately before the actual control effect',async t=>{
 const page=await fixture(t);await assert.rejects(page.evaluate(job=>{const button=document.querySelector('#contact');const bounds=button.getBoundingClientRect.bind(button);button.getBoundingClientRect=()=>{const end=Date.now()+80;while(Date.now()<end){}return bounds();};return BossDomExecutor.execute({op:'OPEN_CONTACT',args:{job},expiresAt:Date.now()+50,expectedDocument:BossDomExecutor.metadata()});},job),/STALE_COMMAND/);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
async function receiver(page,mode){
 await page.evaluate(mode=>{globalThis.permitCalls=[];globalThis.chrome={runtime:{id:'own-extension',onMessage:{addListener:listener=>{globalThis.testReceiver=listener;}},sendMessage:async message=>{if(message.type!=='BOSS_ACTION_PERMIT')return;permitCalls.push(message);if(mode==='late')await new Promise(resolve=>setTimeout(resolve,40));if(mode==='changed')history.replaceState(null,'','/different-document-url');return {ok:true,allowed:mode!=='deny'};}}};},mode);
 await page.addScriptTag({path:path.join(root,'extension/content.js')});
}
async function receiveContact(page,{expiresIn=8000,delay=0}={}){return page.evaluate(({job,expiresIn,delay})=>new Promise(resolve=>{const command={op:'OPEN_CONTACT',args:{job},id:'command-one',epoch:'epoch-one',expiresAt:Date.now()+expiresIn,expectedDocument:BossDomExecutor.metadata()};setTimeout(()=>testReceiver({type:'BOSS_DOM_COMMAND',command},{id:'own-extension'},resolve),delay);}),{job,expiresIn,delay});}
test('a queued expired content action requests no permission and performs no click',async t=>{
 const page=await fixture(t);await receiver(page,'allow');const response=await receiveContact(page,{expiresIn:15,delay:35});assert.equal(response.ok,false);assert.equal(response.error.code,'STALE_COMMAND');assert.equal(await page.evaluate(()=>permitCalls.length),0);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('denied content action permission blocks the standard DOM click',async t=>{
 const page=await fixture(t);await receiver(page,'deny');const response=await receiveContact(page);assert.equal(response.ok,false);assert.equal(response.error.code,'ACTION_NOT_PERMITTED');assert.equal(await page.evaluate(()=>permitCalls.length),1);assert.equal(await page.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('content rechecks deadline and document after asynchronous permission returns',async t=>{
 const late=await fixture(t);await receiver(late,'late');const expired=await receiveContact(late,{expiresIn:20});assert.equal(expired.ok,false);assert.equal(expired.error.code,'STALE_COMMAND');assert.equal(await late.evaluate(()=>Boolean(window.contactClicks)),false);
 const changed=await fixture(t);await receiver(changed,'changed');const response=await receiveContact(changed);assert.equal(response.ok,false);assert.equal(response.error.code,'DOCUMENT_CHANGED');assert.equal(await changed.evaluate(()=>Boolean(window.contactClicks)),false);
});
test('content performs only a permitted effect and sends no secret or page command in the permit',async t=>{
 const page=await fixture(t);await receiver(page,'allow');const response=await receiveContact(page);assert.equal(response.ok,true);assert.equal(await page.evaluate(()=>window.contactClicks),1);assert.deepEqual(await page.evaluate(()=>Object.keys(permitCalls[0]).sort()),['epoch','expiresAt','id','type']);
});
test('positive account on user entry is accepted but visible login still blocks',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{history.replaceState(null,'','/web/user/');document.body.insertAdjacentHTML('afterbegin','<nav class="nav-figure"><span class="label-text">王同学</span></nav>');});const account=await execute(page,'INSPECT_PAGE');assert.equal(account.risk,undefined);assert.equal(account.loggedIn,true);
 await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<section class="login-dialog">扫码登录</section>'));assert.equal((await execute(page,'INSPECT_PAGE')).risk.code,'LOGIN_REQUIRED');
});
test('complete entry document may hydrate its positive account after the first inspection',async t=>{
 const page=await fixture(t);const first=await page.evaluate(async()=>{history.replaceState(null,'','/web/user/');const result=await BossDomExecutor.execute({op:'INSPECT_PAGE'});setTimeout(()=>document.body.insertAdjacentHTML('afterbegin','<nav class="nav-figure"><span class="label-text">王同学</span></nav>'),20);return {result,readyState:document.readyState};});assert.equal(first.readyState,'complete');assert.equal(first.result.risk.code,'LOGIN_REQUIRED');
 assert.equal(first.result.authPending,true);await page.waitForFunction(()=>document.querySelector('.nav-figure .label-text'));const hydrated=await execute(page,'INSPECT_PAGE');assert.equal(hydrated.risk,undefined);assert.equal(hydrated.loggedIn,true);assert.equal(hydrated.account,'王同学');
});
test('visible login controls never become an account-pending condition',async t=>{const page=await fixture(t);await page.evaluate(()=>{history.replaceState(null,'','/web/user/');document.body.insertAdjacentHTML('beforeend','<section class="login-dialog">扫码登录</section>');});const state=await execute(page,'INSPECT_PAGE');assert.equal(state.risk.code,'LOGIN_REQUIRED');assert.notEqual(state.authPending,true);});
test('fixed card observations distinguish self job anchors from descendant anchors',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.job-list-box').remove();document.querySelector('.chat-window').remove();document.body.insertAdjacentHTML('beforeend','<section class="job-list"><a class="job-card-box self-link" href="https://www.zhipin.com/job_detail/self123.html?ka=self"><span class="job-name">自身链接岗位</span><span class="company-name">甲公司</span></a><div class="job-card-wrapper child-link"><a href="https://www.zhipin.com/job_detail/child123.html?ka=child"><span class="job-name">内部链接岗位</span></a><span class="company-name">乙公司</span></div></section>');});
 const state=await execute(page,'INSPECT_PAGE');const observed=state.cardObservations;assert.equal(observed.cardCount,2);assert.equal(observed.sample.length,2);const self=observed.sample.find(card=>card.classes.includes('self-link'));assert.equal(self.tag,'a');assert.equal(self.selfJobLink,true);assert.equal(self.insideCanonicalLinkCount,0);assert.equal(self.titleText,'自身链接岗位');assert.equal(self.companyText,'甲公司');const child=observed.sample.find(card=>card.classes.includes('child-link'));assert.equal(child.selfJobLink,false);assert.equal(child.insideCanonicalLinkCount,1);assert.deepEqual(observed.jobLinks.map(link=>link.jobURL),['https://www.zhipin.com/job_detail/self123.html','https://www.zhipin.com/job_detail/child123.html']);assert.equal(observed.jobLinks[0].ancestors[0].tag,'section');
 // This inspection is diagnostic; it does not yet change cardData matching.
 assert.equal((await execute(page,'READ_CARDS')).jobs.some(job=>job.id==='self123'),false);
});
test('card observations omit non-job URLs and bound samples text classes and ancestry',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.job-list-box').remove();document.querySelector('.chat-window').remove();const outer=document.createElement('section');outer.className='x'.repeat(400);document.body.append(outer);for(let i=0;i<12;i++)outer.insertAdjacentHTML('beforeend',`<article class="job-card-wrapper ${'c'.repeat(300)}"><div><div><a class="${'a'.repeat(300)}" href="https://www.zhipin.com/job_detail/bounded${i}.html?ignored=private-query"><span class="job-name">${'岗'.repeat(300)}</span></a></div></div><span class="company-name">${'司'.repeat(300)}</span></article>`);outer.insertAdjacentHTML('beforeend','<a href="https://example.org/job_detail/foreign.html">FOREIGN_MARKER</a><a href="https://www.zhipin.com/web/geek/resume">RESUME_MARKER</a><a href="https://www.zhipin.com.evil.example/job_detail/fake.html">FAKE_MARKER</a><a href="https://www.zhipin.com/job_detail/hidden.html" style="display:none">HIDDEN_MARKER</a><input value="FORM_SECRET_MARKER">');});
 const observed=(await execute(page,'INSPECT_PAGE')).cardObservations;assert.equal(observed.cardCount,12);assert.equal(observed.sample.length,8);assert.equal(observed.jobLinks.length,8);for(const card of observed.sample){assert.ok(card.classes.length<=160);assert.ok(card.titleText.length<=160);assert.ok(card.companyText.length<=160);}for(const link of observed.jobLinks){assert.ok(link.text.length<=160);assert.ok(link.classes.length<=160);assert.ok(link.ancestors.length<=3);assert.ok(link.ancestors.every(ancestor=>ancestor.classes.length<=160));assert.doesNotMatch(link.jobURL,/\?/u);}assert.doesNotMatch(JSON.stringify(observed),/FOREIGN_MARKER|RESUME_MARKER|FAKE_MARKER|HIDDEN_MARKER|FORM_SECRET_MARKER|private-query/u);
 await assert.rejects(execute(page,'INSPECT_PAGE',{selector:'input'}),/COMMAND_INVALID/u);
});
test('company observations expose new brand leaves and official company links without changing matching',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.job-list-box').innerHTML='<li class="job-card-box"><a href="https://www.zhipin.com/job_detail/brand123.html"><span class="job-name">AI Agent实习生</span></a><span class="company-brand-new" aria-label="公司品牌" title="示例品牌完整名">示例品牌</span><a class="organization-link" href="https://www.zhipin.com/gongsi/brand123.html?tracking=QUERY_SECRET">公司官方链接</a><a class="company-brand-foreign" href="https://example.org/gongsi/foreign.html"><span class="brand-name">FOREIGN_COMPANY_MARKER</span></a><a href="https://www.zhipin.com/web/geek/resume">NON_COMPANY_MARKER</a></li>';});
 const card=(await execute(page,'INSPECT_PAGE')).cardObservations.sample[0];const leaf=card.companyCandidates.find(candidate=>candidate.classes==='company-brand-new');assert.equal(leaf.text,'示例品牌');assert.equal(leaf.ariaLabel,'公司品牌');assert.equal(leaf.title,'示例品牌完整名');const link=card.companyCandidates.find(candidate=>candidate.url);assert.equal(link.url,'https://www.zhipin.com/gongsi/brand123.html');assert.equal(link.text,'公司官方链接');assert.doesNotMatch(JSON.stringify(card.companyCandidates),/FOREIGN_COMPANY_MARKER|NON_COMPANY_MARKER|QUERY_SECRET/u);assert.equal((await execute(page,'READ_CARDS')).jobs.length,0);
});
test('company candidate diagnostics remain bounded and exclude form control values',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{const card=document.querySelector('.job-card-wrapper');for(let i=0;i<12;i++){const element=document.createElement('span');element.className='company-brand-'+i+'x'.repeat(400);element.textContent='品'.repeat(400);element.setAttribute('aria-label','牌'.repeat(400));element.title='名'.repeat(400);card.append(element);}card.insertAdjacentHTML('beforeend','<input class="company-input" value="INPUT_SECRET_MARKER" title="INPUT_TITLE_SECRET"><textarea class="brand-textarea">TEXTAREA_SECRET_MARKER</textarea><div class="boss-control"><input value="WRAPPER_SECRET_MARKER"></div><a class="company-link" href="https://www.zhipin.com/company/example?query=HIDDEN_QUERY_SECRET">官方公司</a>');});
 const observed=(await execute(page,'INSPECT_PAGE')).cardObservations;assert.ok(observed.sample.length<=8);for(const card of observed.sample){assert.ok(card.companyCandidates.length<=8);for(const candidate of card.companyCandidates)for(const field of ['classes','text','ariaLabel','title'])assert.ok(candidate[field].length<=160);}assert.ok(new TextEncoder().encode(JSON.stringify(observed.sample.map(card=>card.companyCandidates))).length<9000);assert.doesNotMatch(JSON.stringify(observed),/INPUT_SECRET_MARKER|INPUT_TITLE_SECRET|TEXTAREA_SECRET_MARKER|WRAPPER_SECRET_MARKER|HIDDEN_QUERY_SECRET/u);
});
test('observed card layout reads company only from official gongsi boss-info and its card location',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.head.insertAdjacentHTML('beforeend','<base href="https://www.zhipin.com/">');document.querySelector('.job-list-box').innerHTML='<li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/actual123.html?ka=source">AI Agent开发实习生</a><a class="boss-info" href="/gongsi/company123.html"><span class="boss-name">北京途识科技有限公司</span></a><span class="company-location">北京·海淀区·学院路</span></li><li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/actual456.html">AI Agent实习生</a><a class="boss-info" href="https://www.zhipin.com/gongsi/company456.html?ka=company"><span class="boss-name">VAST</span></a><span class="company-location">北京·海淀区</span></li>';});
 const jobs=(await execute(page,'READ_CARDS')).jobs;assert.equal(jobs.length,2);assert.equal(jobs[0].company,'北京途识科技有限公司');assert.equal(jobs[0].city,'北京·海淀区·学院路');assert.equal(jobs[0].navigationUrl,'https://www.zhipin.com/job_detail/actual123.html?ka=source');assert.equal(jobs[1].company,'VAST');assert.equal(jobs[1].city,'北京·海淀区');assert.equal((await execute(page,'INSPECT_PAGE')).cardObservations.sample[0].companyText,'北京途识科技有限公司');
});
test('conflicting card companies remain ambiguous and arbitrary boss names are never a company fallback',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.job-list-box').innerHTML='<li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/conflict.html">AI Agent实习生</a><span class="company-name">旧科技公司</span><a class="boss-info" href="https://www.zhipin.com/gongsi/company123.html"><span class="boss-name">不同科技公司</span></a><span class="company-location">北京</span></li><li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/foreignboss.html">AI Agent实习生</a><a class="boss-info" href="https://example.org/gongsi/company.html"><span class="boss-name">外域公司</span></a></li><li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/recruiter.html">AI Agent实习生</a><span class="boss-name">招聘人李先生</span></li><li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/bossprofile.html">AI Agent实习生</a><a class="boss-info" href="https://www.zhipin.com/web/boss/profile"><span class="boss-name">招聘人王女士</span></a></li>';});assert.equal((await execute(page,'READ_CARDS')).jobs.length,0);
});
test('observed card company-location does not broaden unverified detail location matching',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('main .job-location').remove();document.querySelector('main').insertAdjacentHTML('beforeend','<span class="company-location">北京·海淀区</span>');});await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);
});
test('actual tilde company ID format is accepted while query is removed and foreign company URLs stay rejected',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.job-list-box').innerHTML='<li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/tildeCompanyJob.html?ka=job">AI Agent实习生</a><a class="boss-info" href="https://www.zhipin.com/gongsi/fixtureCompany~.html?ka=company"><span class="boss-name">北京云境启星有限公司</span></a><span class="company-location">北京·海淀区</span></li><li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/foreignTilde.html">AI Agent实习生</a><a class="boss-info" href="https://example.org/gongsi/fixtureCompany~.html"><span class="boss-name">外域公司</span></a></li><li class="job-card-box"><a class="job-name" href="https://www.zhipin.com/job_detail/plusCompany.html">AI Agent实习生</a><a class="boss-info" href="https://www.zhipin.com/gongsi/fixture+Company.html"><span class="boss-name">未证实字符公司</span></a></li>';});
 const jobs=(await execute(page,'READ_CARDS')).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].company,'北京云境启星有限公司');assert.equal(jobs[0].navigationUrl,'https://www.zhipin.com/job_detail/tildeCompanyJob.html?ka=job');const candidate=(await execute(page,'INSPECT_PAGE')).cardObservations.sample[0].companyCandidates.find(value=>value.url);assert.equal(candidate.url,'https://www.zhipin.com/gongsi/fixtureCompany~.html');
});
test('fixed detail observations expose new heading company anchor and location leaves without changing matching',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.job-list-box').remove();document.querySelector('.chat-window').remove();document.querySelector('main').outerHTML='<section class="job-banner" data-job-id="a123"><div class="job-title"><h1>AI Agent开发实习生</h1></div><span class="job-location">北京·海淀区</span><div class="job-sec-text">岗位描述示例。</div></section><aside class="new-company-area"><a class="detail-company-new" href="https://www.zhipin.com/gongsi/fixtureCompany~.html?private=QUERY_SECRET">VAST</a></aside><div class="work-address"><span class="address-label">北京市海淀区学院路</span></div>';});
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations;assert.equal(observed.scopes.length,1);assert.equal(observed.scopes[0].tag,'section');assert.equal(observed.scopes[0].dataJobId,'a123');assert.equal(observed.scopes[0].titleText,job.title);assert.equal(observed.scopes[0].companyText,'');assert.equal(observed.scopes[0].cityText,'北京·海淀区');assert.equal(observed.scopes[0].descriptionChars,'岗位描述示例。'.length);assert.equal(observed.headings[0].text,job.title);assert.equal(observed.headings[0].ancestors[0].classes,'job-title');assert.equal(observed.companyLinks[0].url,'https://www.zhipin.com/gongsi/fixtureCompany~.html');assert.equal(observed.companyLinks[0].text,'VAST');assert.ok(observed.locations.some(location=>location.text==='北京市海淀区学院路'));assert.doesNotMatch(JSON.stringify(observed),/QUERY_SECRET/u);
 // The diagnostic supplies evidence; an unverified company selector still stops detail matching.
 await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);
});
test('detail observations omit foreign hidden and form sources and do not read addresses outside job details',async t=>{
 const page=await fixture(t);await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<a href="https://example.org/gongsi/company.html">FOREIGN_DETAIL_MARKER</a><a href="https://www.zhipin.com.evil.example/company/fake">FAKE_DETAIL_MARKER</a><a href="http://www.zhipin.com/gongsi/plain.html">HTTP_DETAIL_MARKER</a><a href="https://www.zhipin.com/gongsi/hidden.html" style="display:none">HIDDEN_DETAIL_MARKER</a><form><span class="work-address">FORM_ADDRESS_MARKER</span><input class="city-input" value="INPUT_DETAIL_MARKER"><textarea class="location-textarea">TEXTAREA_DETAIL_MARKER</textarea><a href="https://www.zhipin.com/company/form">FORM_LINK_MARKER</a><h1>FORM_HEADING_MARKER</h1></form>'));
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations;assert.doesNotMatch(JSON.stringify(observed),/FOREIGN_DETAIL_MARKER|FAKE_DETAIL_MARKER|HTTP_DETAIL_MARKER|HIDDEN_DETAIL_MARKER|FORM_ADDRESS_MARKER|INPUT_DETAIL_MARKER|TEXTAREA_DETAIL_MARKER|FORM_LINK_MARKER|FORM_HEADING_MARKER/u);
 await page.evaluate(()=>{history.replaceState(null,'','/web/geek/jobs');document.body.insertAdjacentHTML('beforeend','<span class="work-address">NON_DETAIL_ADDRESS_MARKER</span>');});const other=(await execute(page,'INSPECT_PAGE')).detailObservations;assert.deepEqual(other,{scopes:[],headings:[],companyLinks:[],locations:[],descriptions:[],sections:[],contactScopes:[],contactControls:[],confirmationStructure:[]});
});
test('detail observations limit counts text ancestry and combined inspection response bytes',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.body.innerHTML='';for(let i=0;i<12;i++)document.body.insertAdjacentHTML('beforeend',`<section class="job-detail ${'详'.repeat(250)}" data-job-id="${'岗'.repeat(250)}"><div class="${'祖'.repeat(250)}"><div><h1>${'名'.repeat(250)}</h1></div></div><span class="company-name">${'司'.repeat(250)}</span><span class="job-location">${'市'.repeat(250)}</span><div class="job-sec-text">${'描述'.repeat(1000)}</div><a class="${'链'.repeat(250)}" href="https://www.zhipin.com/gongsi/${'a'.repeat(1950)}${i}.html?private=SECRET_QUERY">${'企'.repeat(250)}</a><span class="work-address ${'址'.repeat(250)}">${'地'.repeat(250)}</span></section>`);});
 const result=await execute(page,'INSPECT_PAGE');const observed=result.detailObservations;assert.ok(observed.scopes.length<=4);assert.ok(observed.headings.length<=4);assert.ok(observed.companyLinks.length<=8);assert.ok(observed.locations.length<=8);assert.ok(observed.scopes.length>0);for(const scope of observed.scopes){assert.ok(scope.dataJobId.length<=128);for(const field of ['classes','titleText','companyText','cityText'])assert.ok(scope[field].length<=160);assert.equal(scope.descriptionChars,2000);}for(const item of [...observed.headings,...observed.companyLinks,...observed.locations]){assert.ok(item.text.length<=160);assert.ok(item.classes.length<=160);if(item.ancestors){assert.ok(item.ancestors.length<=3);assert.ok(item.ancestors.every(ancestor=>ancestor.classes.length<=160));}}assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=65536);assert.doesNotMatch(JSON.stringify(observed),/SECRET_QUERY/u);
});
async function sidebarDetail(t,companyMarkup) {
 const page=await fixture(t);await page.evaluate(companyMarkup=>{document.querySelector('.job-list-box').remove();document.querySelector('.chat-window').remove();document.querySelector('main').outerHTML='<section class="job-primary detail-box" data-job-id="a123"><div class="info-primary"><div class="name"><h1>AI Agent开发实习生</h1></div><span class="text-city">北京</span></div><div class="op"><button id="observed-contact" onclick="window.observedContactClicks=(window.observedContactClicks||0)+1">立即沟通</button></div></section><section class="job-detail"><div class="job-sec-text">实习开发 LLM Agent 工具调用。</div><div class="company-name">工商名称不作为岗位品牌</div></section><aside class="sider-company"><div class="company-info">'+companyMarkup+'</div></aside><section class="related-company"><div class="company-info"><span class="company-name">相关公司不作为岗位品牌</span><a href="https://www.zhipin.com/gongsi/related~.html">相关公司</a></div></section><a href="https://www.zhipin.com/gongsi/">所有公司</a>';},companyMarkup);return page;
}
test('observed detail sidebar reads a nonempty official single-company brand anchor and preserves detail identity',async t=>{
 const page=await sidebarDetail(t,'<a href="https://www.zhipin.com/gongsi/fixtureCompany~.html"><img alt="公司标志" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a><a href="https://www.zhipin.com/gongsi/fixtureCompany~.html?ka=company">示例科技</a><a class="look-all" href="https://www.zhipin.com/gongsi/job/fixtureCompany~.html">查看所有职位</a>');
 const result=await execute(page,'READ_DETAIL',{job});assert.equal(result.job.company,job.company);assert.equal(result.job.title,job.title);assert.equal(result.job.id,job.id);assert.equal(result.job.city,'北京');assert.match(result.job.description,/工具调用/u);await execute(page,'OPEN_CONTACT',{job});assert.equal(await page.evaluate(()=>window.observedContactClicks),1);
 await assert.rejects(execute(page,'READ_DETAIL',{job:{...job,company:'不同品牌'}}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>window.observedContactClicks),1);
});
test('detail company rejects foreign generic listing and out-of-sidebar links',async t=>{
 const page=await sidebarDetail(t,'<a href="https://example.org/gongsi/fixtureCompany~.html">示例科技</a><a href="https://www.zhipin.com.evil.example/gongsi/fixtureCompany~.html">示例科技</a><a href="http://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a><a href="https://www.zhipin.com/gongsi/">示例科技</a><a href="https://www.zhipin.com/gongsi/job/fixtureCompany~.html">示例科技</a><a href="https://www.zhipin.com/company/fixtureCompany~.html">示例科技</a>');
 await page.evaluate(()=>{document.querySelector('.related-company').remove();document.querySelector('.job-detail').insertAdjacentHTML('beforeend','<div class="company-info"><span class="name">示例科技</span><a href="https://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a></div>');});await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.observedContactClicks)),false);
});
test('detail sidebar company conflicts are rejected rather than hidden by a legacy match',async t=>{
 const page=await sidebarDetail(t,'<span class="company-name">示例科技</span><a href="https://www.zhipin.com/gongsi/otherCompany~.html">不同科技公司</a>');await page.evaluate(()=>document.querySelector('.job-primary').insertAdjacentHTML('beforeend','<span class="company-name">示例科技</span>'));await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.observedContactClicks)),false);
 const links=await sidebarDetail(t,'<a href="https://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a><a href="https://www.zhipin.com/gongsi/otherCompany~.html">不同科技公司</a>');await assert.rejects(execute(links,'READ_DETAIL',{job}),/PAGE_CHANGED/u);
});
test('description observations distinguish job and nested company sections without mixing their contents',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('main .job-sec-text').outerHTML='<section class="job-detail-section"><h2>职位描述</h2><div class="job-sec-text">评测 AI Agent 工具调用能力。</div><div class="detail-section"><h3>公司介绍</h3><div class="job-sec-text">公司介绍文字。</div></div></section>';});
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations;assert.equal(observed.descriptions.length,2);assert.equal(observed.descriptions[0].heading,'职位描述');assert.equal(observed.descriptions[0].text,'评测 AI Agent 工具调用能力。');assert.equal(observed.descriptions[0].ancestors[0].classes,'job-detail-section');assert.equal(observed.descriptions[1].heading,'公司介绍');assert.equal(observed.sections[0].heading,'职位描述');assert.equal(observed.sections[0].descriptionCount,2);assert.equal(observed.sections[1].heading,'公司介绍');assert.equal(observed.sections[1].descriptionCount,1);assert.equal((await execute(page,'READ_DETAIL',{job})).job.description,'评测 AI Agent 工具调用能力。');
});
test('description section observations are bounded and exclude hidden form and non-detail data',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('main .job-sec-text').remove();for(let i=0;i<12;i++)document.querySelector('main').insertAdjacentHTML('beforeend',`<section class="job-detail-section ${'节'.repeat(220)}"><h2>${'题'.repeat(160)}</h2><div class="job-sec-text ${'述'.repeat(220)}">${'文'.repeat(300)}</div></section>`);document.body.insertAdjacentHTML('beforeend','<section class="job-detail-section" style="display:none"><h2>HIDDEN_SECTION_MARKER</h2><div class="job-sec-text">HIDDEN_DESCRIPTION_MARKER</div></section><form><section class="job-detail-section"><h2>FORM_SECTION_MARKER</h2><div class="job-sec-text">FORM_DESCRIPTION_MARKER</div></section></form><section class="job-detail-section"><h2><textarea>FORM_HEADING_MARKER</textarea></h2><div class="job-sec-text"><input value="INPUT_DESCRIPTION_MARKER"></div></section>');});
 const result=await execute(page,'INSPECT_PAGE');const observed=result.detailObservations;assert.equal(observed.descriptions.length,8);assert.equal(observed.sections.length,8);for(const node of observed.descriptions){assert.ok(node.text.length<=120);assert.ok(node.heading.length<=80);assert.ok(node.classes.length<=160);assert.ok(node.ancestors.length<=3);assert.ok(node.ancestors.every(ancestor=>ancestor.classes.length<=160));}for(const section of observed.sections){assert.ok(section.heading.length<=80);assert.ok(section.classes.length<=160);assert.equal(section.descriptionCount,1);}assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=65536);assert.doesNotMatch(JSON.stringify(observed),/HIDDEN_SECTION_MARKER|HIDDEN_DESCRIPTION_MARKER|FORM_SECTION_MARKER|FORM_DESCRIPTION_MARKER|FORM_HEADING_MARKER|INPUT_DESCRIPTION_MARKER/u);
 await page.evaluate(()=>history.replaceState(null,'','/web/geek/jobs'));const other=(await execute(page,'INSPECT_PAGE')).detailObservations;assert.deepEqual(other.descriptions,[]);assert.deepEqual(other.sections,[]);
});
test('detail selects the named job description while excluding company introduction and recruiter headings',async t=>{
 const page=await sidebarDetail(t,'<a href="https://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a>');
 await page.evaluate(()=>{document.querySelector('.job-detail').innerHTML='<div class="job-detail-section"><h3>职位描述</h3><div class="job-sec-text">实习开发 AI Agent 工具调用，评测模型能力。</div><div class="recruiter"><h3>测试招聘者 3日内活跃</h3></div></div><div class="job-detail-section job-detail-company"><h3>公司介绍</h3><div class="detail-section-item company-info-box"><div class="job-sec-text fold-text">COMPANY_INTRO_NOT_JOB_DESCRIPTION</div></div></div>';});
 const result=await execute(page,'READ_DETAIL',{job});assert.equal(result.job.description,'实习开发 AI Agent 工具调用，评测模型能力。');assert.equal(result.job.city,'北京');assert.equal(result.job.company,'示例科技');
});
test('two named job description sections remain ambiguous and company-only text cannot substitute',async t=>{
 const page=await sidebarDetail(t,'<a href="https://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a>');
 await page.evaluate(()=>{document.querySelector('.job-detail').innerHTML='<div class="job-detail-section"><h3>职位描述</h3><div class="job-sec-text">岗位内容一</div></div><div class="job-detail-section"><h3>岗位描述</h3><div class="job-sec-text">不同岗位内容二</div></div>';});
 await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.observedContactClicks)),false);
 await page.evaluate(()=>{document.querySelector('.job-detail').innerHTML='<div class="job-detail-section job-detail-company"><h3>公司介绍</h3><div class="job-sec-text">公司介绍不是岗位职责</div></div>';});
 await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);
});
test('legacy description fallback rejects explicit company headings even without company classes',async t=>{
 const page=await sidebarDetail(t,'<a href="https://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a>');
 for(const heading of ['公司介绍','公司简介','工商信息']){
  await page.evaluate(heading=>{document.querySelector('.job-detail').innerHTML='<section class="detail-section"><h3>'+heading+'</h3><div class="job-sec-text">COMPANY_ONLY_SENTINEL</div></section>';},heading);
  await assert.rejects(execute(page,'READ_DETAIL',{job}),/PAGE_CHANGED/u);await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.observedContactClicks)),false);
 }
});
test('detail contact observations expose the innermost caption and scope without authorizing a click',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{
   document.querySelector('.job-list-box').remove();document.querySelector('.chat-window').remove();
   const main=document.querySelector('main');main.className='job-primary actual-primary';
   main.querySelector('.op').outerHTML='<div class="contact-wrapper"><a class="contact-anchor" href="javascript:void(0)" onclick="window.diagnosticClick=true"><span class="contact-caption">立即沟通</span></a></div>';
 });
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations;
 assert.equal(observed.scopes[0].contactScopeCount,0);
 assert.deepEqual(observed.contactScopes,[]);
 assert.equal(observed.contactControls.length,1);
 assert.deepEqual(observed.contactControls[0],{tag:'span',classes:'contact-caption',text:'立即沟通',ancestors:[{tag:'a',classes:'contact-anchor'},{tag:'div',classes:'contact-wrapper'},{tag:'main',classes:'job-primary actual-primary'}],nearestDetail:{tag:'main',classes:'job-primary actual-primary',titleText:'AI Agent开发实习生'}});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);
 assert.equal(await page.evaluate(()=>Boolean(window.diagnosticClick||window.contactClicks)),false);
});
test('detail contact observations bound global leaves op scopes text and nearest heading provenance',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{
   document.body.innerHTML=`<main class="job-banner ${'详'.repeat(220)}"><h1>${'岗'.repeat(220)}</h1></main>`;
   for(let i=0;i<12;i++)document.querySelector('main').insertAdjacentHTML('beforeend',`<div class="op ${'操'.repeat(220)}"><div class="${'祖'.repeat(220)}"><button class="${'钮'.repeat(220)}"><span class="${'词'.repeat(220)}">${i%2?'继续沟通':'沟通'}</span></button></div></div>`);
 });
 const result=await execute(page,'INSPECT_PAGE'),observed=result.detailObservations;
 assert.equal(observed.scopes[0].contactScopeCount,12);
 assert.equal(observed.contactScopes.length,8);assert.equal(observed.contactControls.length,8);
 for(const node of [...observed.contactScopes,...observed.contactControls]){
   assert.ok(node.text.length<=160);assert.ok(node.classes.length<=160);assert.ok(node.ancestors.length<=3);
   assert.ok(node.ancestors.every(ancestor=>ancestor.classes.length<=160));
   assert.ok(node.nearestDetail.classes.length<=160);assert.ok(node.nearestDetail.titleText.length<=160);
 }
 assert.ok(observed.contactScopes.every(scope=>scope.contactControlCount===1));
 assert.ok(observed.contactControls.every(control=>control.tag==='span'));
 assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=65536);
});
test('detail contact observations exclude form foreign hidden and token sources and other pages',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{
   document.body.innerHTML='<main class="job-primary"><h1>AI Agent开发实习生</h1><div class="op"><button class="SAFE_BUTTON">立即沟通</button><a class="SAFE_ANCHOR" href="javascript:;">继续沟通</a><a class="SAFE_OFFICIAL" href="https://www.zhipin.com/web/geek/chat?token=CONTACT_TOKEN_SECRET">沟通</a></div></main>';
   document.body.insertAdjacentHTML('beforeend','<form><div class="op FORM_CONTACT_SECRET"><button class="FORM_BUTTON_SECRET">立即沟通</button></div><input value="INPUT_CONTACT_SECRET"><textarea>TEXTAREA_CONTACT_SECRET</textarea></form><button class="INPUT_WRAPPER_SECRET"><span class="INPUT_CAPTION_SECRET">立即沟通</span><input value="INPUT_VALUE_SECRET"></button><div class="HIDDEN_WRAPPER_SECRET" style="opacity:0"><span class="HIDDEN_CAPTION_SECRET">立即沟通</span></div><div class="HIDDEN_CONTAINER_SECRET"><span style="display:none">立即沟通</span></div><span class="ARIA_HIDDEN_SECRET" aria-hidden="true">沟通</span><a class="FOREIGN_CONTACT_SECRET" href="https://example.org/?token=FOREIGN_TOKEN_SECRET"><span>继续沟通</span></a><div class="FOREIGN_WRAPPER_SECRET"><a href="https://www.zhipin.com.evil.example/?token=FOREIGN_TOKEN_SECRET"><span>立即沟通</span></a></div><button class="TOKEN_BUTTON_SECRET">CONTACT_TOKEN_SECRET</button><span>立即沟通岗位介绍</span>');
 });
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations;
 assert.deepEqual(observed.contactControls.map(node=>node.classes),['SAFE_BUTTON','SAFE_ANCHOR','SAFE_OFFICIAL']);
 assert.equal(observed.contactScopes.length,1);assert.equal(observed.contactScopes[0].contactControlCount,3);
 assert.doesNotMatch(JSON.stringify({scopes:observed.contactScopes,controls:observed.contactControls}),/CONTACT_TOKEN_SECRET|FORM_CONTACT_SECRET|FORM_BUTTON_SECRET|INPUT_|TEXTAREA_|HIDDEN_|ARIA_HIDDEN_SECRET|FOREIGN_|TOKEN_BUTTON_SECRET|href|javascript/u);
 await page.evaluate(()=>history.replaceState(null,'','/web/geek/jobs'));
 const search=(await execute(page,'INSPECT_PAGE')).detailObservations;
 assert.deepEqual(search.contactScopes,[]);assert.deepEqual(search.contactControls,[]);
 await page.evaluate(()=>history.replaceState(null,'','/job_detail/a123.html/other'));
 const nonDetail=(await execute(page,'INSPECT_PAGE')).detailObservations;
 assert.deepEqual(nonDetail.contactScopes,[]);assert.deepEqual(nonDetail.contactControls,[]);
});

async function actualContactDetail(t,caption='立即沟通') {
 const page=await sidebarDetail(t,'<a href="https://www.zhipin.com/gongsi/fixtureCompany~.html">示例科技</a>');
 await page.evaluate(caption=>{document.querySelector('.job-primary .op').outerHTML='<div class="job-op"><div class="btn-container"><div class="btn btn-startchat-wrap"><a class="btn btn-startchat" href="javascript:void(0)" onclick="window.actualContactClicks=(window.actualContactClicks||0)+1">'+caption+'</a></div></div></div>';},caption);
 return page;
}
test('observed job-op nested anchor is the unique verified contact action and preserves op compatibility',async t=>{
 const page=await actualContactDetail(t);
 const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.contactAvailable,true);assert.equal(detail.contactExisting,false);
 await page.locator('.btn-container').evaluate(element=>element.classList.add('op'));
 assert.equal((await execute(page,'READ_DETAIL',{job})).contactAvailable,true);
 const result=await execute(page,'OPEN_CONTACT',{job});assert.equal(result.clicked,true);assert.equal(result.existing,false);assert.equal(await page.evaluate(()=>window.actualContactClicks),1);
 const legacy=await fixture(t);assert.equal((await execute(legacy,'READ_DETAIL',{job})).contactAvailable,true);await execute(legacy,'OPEN_CONTACT',{job});assert.equal(await legacy.evaluate(()=>window.contactClicks),1);
});
test('a matching job-op anchor outside the verified detail is unavailable and cannot be borrowed',async t=>{
 const page=await actualContactDetail(t);await page.evaluate(()=>{document.body.append(document.querySelector('.job-primary .job-op'));});
 const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.contactAvailable,false);assert.equal(detail.contactExisting,false);
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks)),false);
});
test('related cards company sidebars forms and foreign anchors do not contribute contact actions',async t=>{
 const page=await actualContactDetail(t);await page.evaluate(()=>{
   const primary=document.querySelector('.job-primary');
   for(const [tag,classes] of [['section','more-job-section'],['div','job-card-new-layout'],['aside','sider-company'],['form','form-contact']])primary.insertAdjacentHTML('beforeend',`<${tag} class="${classes}"><div class="job-op op"><a href="javascript:;" onclick="window.misleadingContactClicks=(window.misleadingContactClicks||0)+1">继续沟通</a></div></${tag}>`);
   primary.insertAdjacentHTML('beforeend','<div class="op foreign-actions"><a href="https://example.org/contact" onclick="window.misleadingContactClicks=(window.misleadingContactClicks||0)+1">立即沟通</a></div>');
 });
 const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.contactAvailable,true);assert.equal(detail.contactExisting,false);
 await execute(page,'OPEN_CONTACT',{job});assert.equal(await page.evaluate(()=>window.actualContactClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.misleadingContactClicks)),false);
 await page.locator('.job-primary > .job-op').evaluate(element=>element.remove());
 const missing=await execute(page,'READ_DETAIL',{job});assert.equal(missing.contactAvailable,false);assert.equal(missing.contactExisting,false);
 await assert.rejects(execute(page,'OPEN_CONTACT',{job,resumeOnly:true}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.misleadingContactClicks)),false);
});
test('two legitimate contact actions report unavailable and never choose one arbitrarily',async t=>{
 const page=await actualContactDetail(t,'继续沟通');await page.locator('.job-primary .job-op').evaluate(element=>element.insertAdjacentHTML('beforeend','<button onclick="window.otherContactClicks=true">立即沟通</button>'));
 const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.contactAvailable,false);assert.equal(detail.contactExisting,false);
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks||window.otherContactClicks)),false);
});
test('job-op resumeOnly requires the unique continuing contact action',async t=>{
 const page=await actualContactDetail(t);
 assert.equal((await execute(page,'READ_DETAIL',{job})).contactAvailable,true);await assert.rejects(execute(page,'OPEN_CONTACT',{job,resumeOnly:true}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks)),false);
 await page.locator('.btn-startchat').evaluate(element=>{element.textContent='继续沟通';});
 const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.contactExisting,true);
 const result=await execute(page,'OPEN_CONTACT',{job,resumeOnly:true});assert.equal(result.existing,true);assert.equal(await page.evaluate(()=>window.actualContactClicks),1);
});
test('a second contact control inserted at the final connected check prevents the first click',async t=>{
 const page=await actualContactDetail(t);assert.equal((await execute(page,'READ_DETAIL',{job})).contactAvailable,true);
 await page.evaluate(()=>{const action=document.querySelector('.btn-startchat'),bounds=action.getBoundingClientRect.bind(action);let reads=0;action.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3)action.closest('.job-op').insertAdjacentHTML('beforeend','<button onclick="window.otherContactClicks=true">立即沟通</button>');return rect;};});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks||window.otherContactClicks)),false);
});
test('resumeOnly caption changing at the final connected check cannot start a new conversation',async t=>{
 const page=await actualContactDetail(t,'继续沟通');assert.equal((await execute(page,'READ_DETAIL',{job})).contactExisting,true);
 await page.evaluate(()=>{const action=document.querySelector('.btn-startchat'),bounds=action.getBoundingClientRect.bind(action);let reads=0;action.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3)action.textContent='立即沟通';return rect;};});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job,resumeOnly:true}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks)),false);
});
test('ordinary contact caption changing at the final connected check prevents a click',async t=>{
 const page=await actualContactDetail(t);assert.equal((await execute(page,'READ_DETAIL',{job})).contactAvailable,true);
 await page.evaluate(()=>{const action=document.querySelector('.btn-startchat'),bounds=action.getBoundingClientRect.bind(action);let reads=0;action.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3)action.textContent='沟通';return rect;};});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks)),false);
});
test('an original connected contact moved outside its scope is not replaced by a different control',async t=>{
 const page=await actualContactDetail(t);assert.equal((await execute(page,'READ_DETAIL',{job})).contactAvailable,true);
 await page.evaluate(()=>{const action=document.querySelector('.btn-startchat'),bounds=action.getBoundingClientRect.bind(action);let reads=0;action.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3){const replacement=action.cloneNode(true);action.parentElement.append(replacement);document.body.append(action);}return rect;};});
 await assert.rejects(execute(page,'OPEN_CONTACT',{job}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualContactClicks)),false);
});

function confirmationMarkup({dialogName='林闻',position='示例科技·招聘经理',status='已发送',message='您好，我对您发布的岗位感兴趣。',messageClass=''}={}) {
 return `<div class="dialog-wrap startchat-dialog"><div class="dialog-container"><h3 class="title"><span class="name">${dialogName}</span><span class="position">${position}</span></h3><div class="message-list"><div class="message-item ${messageClass}"><span class="send-status">${status}</span><div class="message-text">${message}</div></div></div><a class="close" href="javascript:;" onclick="window.confirmationCloseClicks=(window.confirmationCloseClicks||0)+1;this.closest('.startchat-dialog').remove()">关闭</a><button class="send-message disable" disabled onclick="window.confirmationSendClicks=true">发送</button><a class="qr-code" href="javascript:;" onclick="window.confirmationQrClicks=true">扫码</a></div></div>`;
}
async function confirmingContact(t,options={}) {
 const page=await actualContactDetail(t);const markup=confirmationMarkup(options);
 await page.evaluate(({markup,mainName})=>{
   document.querySelector('.job-detail').insertAdjacentHTML('beforeend',`<section class="job-detail-section"><h3 class="name">${mainName}<span class="active-badge">2周内活跃</span></h3></section>`);
   document.querySelector('.btn-startchat').onclick=()=>{window.actualContactClicks=(window.actualContactClicks||0)+1;document.body.insertAdjacentHTML('beforeend',markup);document.querySelector('.btn-startchat').textContent='继续沟通';};
 },{markup,mainName:options.mainName??'林闻'});
 return {page,markup};
}
function observedConfirmationMarkup({dialogName='林闻',position='示例科技·招聘经理',status='已发送',statusClass='status success',message='您好，我对您发布的岗位感兴趣。',messageClass=''}={}) {
 return `<div class="dialog-wrap startchat-dialog"><div class="dialog-layer"></div><div class="dialog-container"><div class="dialog-title"><h3 class="title"><div class="startchat-title"><img class="avatar"><div class="boss-info"><div class="name">${dialogName}</div><div class="position">${position}</div></div></div></h3><a class="close" href="javascript:;" style="display:inline-block;width:20px;height:20px" onclick="window.confirmationCloseClicks=(window.confirmationCloseClicks||0)+1;this.closest('.startchat-dialog').remove()"></a></div><div class="dialog-con"><div class="startchat-content"><div class="left"><ul class="message-list"><li class="message-item ${messageClass}"><span class="${statusClass}">${status}</span><p class="text">${message}</p></li></ul></div><div class="right"><div class="title">扫码查看</div><button class="send-message disable" disabled onclick="window.confirmationSendClicks=true">发送</button></div></div></div></div></div>`;
}
async function observedConfirmingContact(t,options={}) {
 const page=await actualContactDetail(t);const markup=observedConfirmationMarkup(options);
 await page.evaluate(({markup,mainName})=>{
   document.querySelector('.job-detail').insertAdjacentHTML('beforeend',`<section class="job-detail-section"><div class="job-boss-info"><div class="detail-figure"></div><h2 class="name">${mainName}<i class="icon-vip"></i><span class="boss-active-time">今日活跃</span></h2><div class="boss-info-attr">示例科技<em class="vdot">·</em>招聘经理</div></div></section>`);
   document.querySelector('.btn-startchat').onclick=()=>{window.actualContactClicks=(window.actualContactClicks||0)+1;document.body.insertAdjacentHTML('beforeend',markup);document.querySelector('.btn-startchat').textContent='继续沟通';};
 },{markup,mainName:options.mainName??'林闻'});
 return {page,markup};
}
test('observed native contact binds h2 recruiter nested header and direct successful p message before safe dismissal',async t=>{
 const {page}=await observedConfirmingContact(t);assert.equal((await execute(page,'READ_DETAIL',{job})).job.recruiterName,'林闻');await execute(page,'OPEN_CONTACT',{job});
 const proof=await execute(page,'READ_CONTACT_CONFIRMATION',{job});assert.equal(proof.confirmed,true);assert.equal(proof.evidence.recruiterName,'林闻');assert.equal(proof.evidence.company,'示例科技');assert.equal(proof.evidence.status,'已发送');assert.equal(await page.evaluate(()=>window.actualContactClicks),1);
 assert.equal((await execute(page,'DISMISS_CONTACT_CONFIRMATION',{job})).dismissed,true);assert.equal(await page.evaluate(()=>window.confirmationCloseClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.confirmationSendClicks)),false);
});
test('observed h2 recruiter requires its own direct name and never treats an activity badge as identity',async t=>{
 const {page}=await observedConfirmingContact(t,{mainName:''});assert.equal(Object.hasOwn((await execute(page,'READ_DETAIL',{job})).job,'recruiterName'),false);await execute(page,'OPEN_CONTACT',{job});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
});
for(const options of [{dialogName:'赵桐'},{position:'其他科技·招聘经理'},{mainName:''},{status:'发送中'},{status:'发送失败'},{statusClass:'status'},{statusClass:'status failed'},{messageClass:'resume-card',message:'已发送附件简历：示例.pdf'}])test(`observed native contact keeps identity and successful status requirements (${JSON.stringify(options)})`,async t=>{
 const {page}=await observedConfirmingContact(t,options);await execute(page,'OPEN_CONTACT',{job});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/RECIPIENT_UNVERIFIED|PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
for(const change of ['nested-body','nested-status','body-status','header-path','recruiter-path','duplicate-recruiter','changed-recruiter','changed-job'])test(`observed native contact refuses its ${change} structural or identity change`,async t=>{
 const {page}=await observedConfirmingContact(t);
 if(change==='recruiter-path')await page.locator('.job-boss-info').evaluate(element=>document.querySelector('.job-detail').append(element));
 if(change==='duplicate-recruiter')await page.locator('.job-boss-info').evaluate(element=>element.parentElement.append(element.cloneNode(true)));
 await execute(page,'OPEN_CONTACT',{job});
 await page.evaluate(change=>{const body=document.querySelector('.message-item > p.text'),status=document.querySelector('.message-item > span.status');if(change==='nested-body'||change==='nested-status'){const target=change==='nested-body'?body:status,wrap=document.createElement('div');target.replaceWith(wrap);wrap.append(target);}if(change==='body-status'){status.remove();body.innerHTML='<span class="status success">已发送</span>模板文字';}if(change==='header-path'){document.querySelector('.startchat-title').className='unknown-startchat-title';}if(change==='changed-recruiter')document.querySelector('.job-boss-info h2.name').firstChild.textContent='赵桐';if(change==='changed-job')document.querySelector('.job-primary h1').textContent='不同岗位';},change);
 assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('READ_STATUS returns the same account readiness without diagnostic arrays or large page data',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<nav class="user-nav"><div class="user-name">测试求职者</div></nav>');for(let i=0;i<30;i++)document.body.insertAdjacentHTML('beforeend',`<div class="job-detail"><h1>${'大'.repeat(200)}</h1><div class="job-sec-text">${'文'.repeat(1000)}</div></div>`);});
 const lean=await execute(page,'READ_STATUS'),full=await execute(page,'INSPECT_PAGE');
 assert.equal(lean.loggedIn,true);assert.equal(lean.account,'测试求职者');assert.equal(lean.ready,true);assert.deepEqual(lean.meta,full.meta);
 assert.deepEqual(Object.keys(lean).sort(),['account','loggedIn','meta','ready']);assert.equal(Object.values(lean).some(Array.isArray),false);assert.ok(new TextEncoder().encode(JSON.stringify(lean)).length<2048);
});
test('READ_STATUS preserves the same visible login and captcha risks as inspection',async t=>{
 const page=await fixture(t,{risk:'请完成安全验证'});assert.deepEqual(await execute(page,'READ_STATUS'),await execute(page,'INSPECT_PAGE'));
 await page.evaluate(()=>{document.querySelector('.verify-dialog').remove();document.body.insertAdjacentHTML('beforeend','<section class="login-dialog">扫码登录</section>');});assert.deepEqual(await execute(page,'READ_STATUS'),await execute(page,'INSPECT_PAGE'));
});
test('fresh native confirmation is bound to the clicked job recruiter and explicit sent message',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});
 const proof=await execute(page,'READ_CONTACT_CONFIRMATION',{job});
 assert.equal(proof.confirmed,true);assert.equal(proof.jobId,'a123');assert.equal(proof.needsExistingConversation,true);assert.equal(proof.evidence.recruiterName,'林闻');assert.equal(proof.evidence.company,'示例科技');assert.equal(proof.evidence.status,'已发送');assert.match(proof.evidence.text,/对您发布的岗位/u);
 assert.equal(Object.hasOwn(proof,'verified'),false);assert.equal(Object.hasOwn(proof,'resumeStatus'),false);assert.equal(await page.evaluate(()=>window.actualContactClicks),1);
});
test('a matching popup without an actual runtime contact binding cannot confirm or close',async t=>{
 const {page,markup}=await confirmingContact(t);await page.evaluate(markup=>document.body.insertAdjacentHTML('beforeend',markup),markup);
 assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
 await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/RECIPIENT_UNVERIFIED|PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('a popup already visible before the click is never a fresh confirmation',async t=>{
 const {page,markup}=await confirmingContact(t);await page.evaluate(markup=>{document.body.insertAdjacentHTML('beforeend',markup);document.querySelector('.btn-startchat').onclick=()=>{window.actualContactClicks=1;document.querySelector('.btn-startchat').textContent='继续沟通';};},markup);
 await execute(page,'OPEN_CONTACT',{job});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
for(const options of [{dialogName:'赵桐'},{position:'示例科技集团·招聘经理'},{position:'其他科技·招聘经理'},{mainName:''}])test(`native confirmation rejects missing or mismatched recruiter and company (${JSON.stringify(options)})`,async t=>{
 const {page}=await confirmingContact(t,options);await execute(page,'OPEN_CONTACT',{job});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
for(const options of [{status:'发送中'},{status:'发送失败'},{messageClass:'send-failed'},{messageClass:'resume-card',message:'已发送附件简历：测试简历.pdf'},{status:'',message:'普通文本提及已发送不能替代状态标签'},{status:'',message:'<div><span>已发送</span><span>普通模板文字</span></div>'},{status:'普通状态',message:'已发送'},{message:''}])test(`native confirmation requires a successful non-attachment explicit label (${JSON.stringify(options)})`,async t=>{
 const {page}=await confirmingContact(t,options);await execute(page,'OPEN_CONTACT',{job});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
});
test('native confirmation rejects changed detail identity main recruiter and ambiguous fresh dialogs',async t=>{
 const {page,markup}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});
 await page.locator('.job-detail h3.name').evaluate(element=>{element.firstChild.textContent='赵桐';});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
 await page.locator('.job-detail h3.name').evaluate(element=>{element.firstChild.textContent='林闻';});await page.evaluate(markup=>document.body.insertAdjacentHTML('beforeend',markup),markup);assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
 await page.locator('.startchat-dialog').last().evaluate(element=>element.remove());await page.locator('.job-primary h1').evaluate(element=>{element.textContent='不同岗位';});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
});
test('native proof never verifies a generic chat without a job ID or permits its attachment send',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,true);
 await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<section class="chat-window"><header class="chat-header"><span class="job-title">AI Agent开发实习生</span><span class="company-name">示例科技</span></header><div class="messages"><div class="message-item sent">已发送 您好</div></div><div class="chat-editor"><button onclick="window.unverifiedResumeSend=true">发送简历</button></div></section>'));
 assert.equal((await execute(page,'READ_CONVERSATION',{job})).verified,false);assert.equal((await execute(page,'READ_RESUME',{job})).verified,false);await assert.rejects(execute(page,'REQUEST_RESUME',{job}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.unverifiedResumeSend)),false);
});
test('only a previously confirmed native dialog can be closed without touching send or QR',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});
 await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/RECIPIENT_UNVERIFIED|PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
 assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,true);
 const closed=await execute(page,'DISMISS_CONTACT_CONFIRMATION',{job});assert.equal(closed.dismissed,true);assert.equal(closed.jobId,'a123');assert.equal(await page.evaluate(()=>window.confirmationCloseClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.confirmationSendClicks||window.confirmationQrClicks)),false);assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
});
for(const change of ['node','caption'])test(`closing refuses a confirmation close ${change} changed after it was bound`,async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});await execute(page,'READ_CONTACT_CONFIRMATION',{job});
 await page.locator('.startchat-dialog a.close').evaluate((element,change)=>{if(change==='node')element.replaceWith(element.cloneNode(true));else element.textContent='发送';},change);
 await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/PAGE_CHANGED|DOCUMENT_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks||window.confirmationSendClicks)),false);
});
test('closing rechecks the frozen close caption at its final connected boundary',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});await execute(page,'READ_CONTACT_CONFIRMATION',{job});
 await page.evaluate(()=>{const close=document.querySelector('.startchat-dialog a.close'),bounds=close.getBoundingClientRect.bind(close);let reads=0;close.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3)close.textContent='扫码';return rect;};});
 await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/PAGE_CHANGED|DOCUMENT_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks||window.confirmationQrClicks)),false);
});
test('closing refuses a replacement close node inserted at the final connected boundary',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});await execute(page,'READ_CONTACT_CONFIRMATION',{job});
 await page.evaluate(()=>{const close=document.querySelector('.startchat-dialog a.close'),bounds=close.getBoundingClientRect.bind(close);let reads=0;close.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3)close.replaceWith(close.cloneNode(true));return rect;};});
 await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/PAGE_CHANGED|DOCUMENT_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('content dismissal asks Node for permission and denied permission never closes the bound popup',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});await execute(page,'READ_CONTACT_CONFIRMATION',{job});await receiver(page,'deny');
 const result=await page.evaluate(job=>new Promise(resolve=>testReceiver({type:'BOSS_DOM_COMMAND',command:{id:'dismiss-one',epoch:'epoch-one',op:'DISMISS_CONTACT_CONFIRMATION',args:{job},expiresAt:Date.now()+8000,expectedDocument:BossDomExecutor.metadata()}},{id:'own-extension'},resolve)),job);
 assert.equal(await page.evaluate(()=>permitCalls.length),1);assert.equal(result.ok,false);assert.equal(result.error.code,'ACTION_NOT_PERMITTED');assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('document reload removes the runtime native confirmation binding',async t=>{
 const {page,markup}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});const prior=await execute(page,'READ_CONTACT_CONFIRMATION',{job});assert.equal(prior.confirmed,true);
 await page.reload();await page.addScriptTag({path:path.join(root,'extension/dom-executor.js')});await page.evaluate(markup=>document.body.insertAdjacentHTML('beforeend',markup),markup);
 const next=await execute(page,'READ_CONTACT_CONFIRMATION',{job});assert.notEqual(next.meta.documentId,prior.meta.documentId);assert.equal(next.confirmed,false);await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/RECIPIENT_UNVERIFIED|PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('native confirmation evidence stays bounded and excludes input values',async t=>{
 const {page}=await confirmingContact(t,{message:'正常模板内容。'.repeat(300)});await execute(page,'OPEN_CONTACT',{job});await page.locator('.dialog-container').evaluate(element=>element.insertAdjacentHTML('beforeend','<input value="CONFIRM_INPUT_SECRET"><textarea>CONFIRM_TEXTAREA_SECRET</textarea>'));
 const proof=await execute(page,'READ_CONTACT_CONFIRMATION',{job});assert.equal(proof.confirmed,true);assert.ok(proof.evidence.text.length<=160);assert.ok(proof.evidence.recruiterName.length<=160);assert.ok(proof.evidence.company.length<=160);assert.ok(new TextEncoder().encode(JSON.stringify(proof)).length<2048);assert.doesNotMatch(JSON.stringify(proof),/CONFIRM_INPUT_SECRET|CONFIRM_TEXTAREA_SECRET/u);
});
for(const change of ['caption','node'])test(`closing checks the frozen ${change} after its final visibility read`,async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});await execute(page,'READ_CONTACT_CONFIRMATION',{job});
 await page.evaluate(change=>{const close=document.querySelector('.startchat-dialog a.close'),bounds=close.getBoundingClientRect.bind(close);let reads=0;close.getBoundingClientRect=()=>{const rect=bounds();if(++reads===6){if(change==='caption')close.textContent='扫码';else close.replaceWith(close.cloneNode(true));}return rect;};},change);
 await assert.rejects(execute(page,'DISMISS_CONTACT_CONFIRMATION',{job}),/PAGE_CHANGED|DOCUMENT_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks||window.confirmationQrClicks)),false);
});
test('native confirmation stays false when the separate message body is not a known structure',async t=>{
 const {page}=await confirmingContact(t);await execute(page,'OPEN_CONTACT',{job});await page.locator('.message-text').evaluate(element=>{element.className='unknown-message-bubble';});assert.equal((await execute(page,'READ_CONTACT_CONFIRMATION',{job})).confirmed,false);
});

const chatJob={...job,recruiterName:'林闻'};
const previewToken='11111111-2222-4333-8444-555555555555';
async function fullChatFixture(t,{company='示例科技',recruiter='林闻',title='AI Agent开发实习生',disabled=true}={}) {
 const browser=await chromium.launch({headless:true});const page=await browser.newPage();t.after(()=>browser.close());
 const body=`<!doctype html><meta charset="utf-8"><title>本地完整聊天夹具</title><nav class="user-nav"><span class="user-name">测试求职者</span></nav><section class="chat-container page-container"><div class="chat-wrap"><main class="chat-conversation"><header><div class="user-info"><span class="name">${recruiter}</span><span class="company">${company}</span></div></header><div class="chat-position-content"><div class="left-content" onclick="window.previewClicks=(window.previewClicks||0)+1">${title}</div></div><div class="messages"><div class="message-item item-myself"><div class="message-content"><div class="text"><div><div class="text-content">您好，我对这个岗位感兴趣。</div></div></div></div></div></div><div class="chat-tool"><button class="toolbar-btn tooltip tooltip-top ${disabled?'unable':''}" onclick="window.actualResumeClicks=(window.actualResumeClicks||0)+1">发简历</button></div><div class="chat-im chat-editor"><textarea></textarea><button onclick="window.actualMessageClicks=(window.actualMessageClicks||0)+1">发送</button></div></main></div></section>`;
 await page.context().route('**/*',route=>new URL(route.request().url()).hostname==='www.zhipin.com'?route.fulfill({contentType:'text/html; charset=utf-8',body}):route.abort());
 await page.goto('https://www.zhipin.com/web/geek/chat');await page.addScriptTag({path:path.join(root,'extension/dom-executor.js')});return page;
}
async function bindFullChat(page,target=chatJob,token=previewToken) {
 const opened=await execute(page,'VERIFY_CONVERSATION_JOB',{job:target,previewToken:token});assert.equal(opened.previewStarted,true);assert.equal(Object.hasOwn(opened,'verified'),false);
 return execute(page,'BIND_CONVERSATION_JOB',{job:target,previewToken:token,canonicalURL:target.url});
}
test('detail supplies the observed recruiter name without the activity badge',async t=>{
 const {page}=await confirmingContact(t);const detail=await execute(page,'READ_DETAIL',{job});assert.equal(detail.job.recruiterName,'林闻');
});
test('a full chat without a job ID stays unverified until its actual preview URL is bound',async t=>{
 const page=await fullChatFixture(t);assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
 const started=await execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken});assert.equal(started.previewStarted,true);assert.equal(started.previewToken,previewToken);assert.equal(Object.hasOwn(started,'verified'),false);assert.equal(await page.evaluate(()=>window.previewClicks),1);
 assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
 const bound=await execute(page,'BIND_CONVERSATION_JOB',{job:chatJob,previewToken,canonicalURL:chatJob.url});assert.equal(bound.verified,true);assert.equal(bound.jobId,'a123');
 const conversation=await execute(page,'READ_CONVERSATION',{job:chatJob});assert.equal(conversation.verified,true);assert.equal(conversation.jobId,'a123');assert.equal(conversation.greetingSent,true);
});
test('unbound full chat reports preview readiness only after strict fields hydrate without authorizing resumes',async t=>{
 const page=await fullChatFixture(t,{company:'尚未加载',recruiter:'尚未加载',title:'尚未加载'});
 const loading=await execute(page,'READ_CONVERSATION',{job:chatJob});assert.equal(loading.previewAvailable,false);assert.equal(loading.verified,false);assert.equal(Object.hasOwn(loading,'jobId'),false);
 await page.evaluate(job=>{document.querySelector('.user-info .name').textContent=job.recruiterName;document.querySelector('.user-info .company').textContent=job.company;document.querySelector('.left-content').textContent=job.title;},chatJob);
 const ready=await execute(page,'READ_CONVERSATION',{job:chatJob});assert.equal(ready.previewAvailable,true);assert.equal(ready.verified,false);assert.equal(Object.hasOwn(ready,'jobId'),false);assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).verified,false);await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks||window.actualResumeClicks)),false);
 await page.locator('.chat-conversation').evaluate(pane=>pane.parentElement.append(pane.cloneNode(true)));assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).previewAvailable,false);
});
async function structuredFullChatTitle(page){await page.locator('.left-content').evaluate((card,title)=>{card.innerHTML='<span class="position-name"></span><span class="salary">150-250元/天</span><span class="city">苏州</span>';card.querySelector('.position-name').textContent=title;},chatJob.title);}
test('full chat reads its unique direct position name independently of salary and city',async t=>{
 const page=await fullChatFixture(t,{title:'加载中'});assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).previewAvailable,false);await structuredFullChatTitle(page);
 const ready=await execute(page,'READ_CONVERSATION',{job:chatJob});assert.equal(ready.previewAvailable,true);assert.equal(ready.verified,false);const match=(await execute(page,'INSPECT_PAGE')).chatStructure[0].targetMatch.title;assert.equal(match.matches,true);assert.equal(match.actualLength,chatJob.title.length);await bindFullChat(page);assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,true);assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'unavailable');assert.equal(await page.evaluate(()=>window.previewClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
for(const change of ['multiple','hidden','mismatch','nested','external'])test(`position-name ${change} never borrows another title or falls back to the whole card`,async t=>{
 const page=await fullChatFixture(t);await structuredFullChatTitle(page);await page.locator('.left-content').evaluate((card,change)=>{const name=card.querySelector('.position-name');if(change==='multiple')card.append(name.cloneNode(true));if(change==='hidden')name.style.display='none';if(change==='mismatch')name.textContent='虚构其他岗位';if(change==='nested'){const wrap=document.createElement('div');card.prepend(wrap);wrap.append(name);}if(change==='external'){card.parentElement.append(name);card.textContent='虚构其他岗位';}},change);
 assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).previewAvailable,false);await assert.rejects(execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
for(const change of ['replace','title','salary'])test(`a structured card ${change} change invalidates the frozen preview binding`,async t=>{
 const page=await fullChatFixture(t);await structuredFullChatTitle(page);await execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken});await page.locator('.left-content').evaluate((card,change)=>{const name=card.querySelector('.position-name');if(change==='replace')name.replaceWith(name.cloneNode(true));if(change==='title')name.textContent='虚构新岗位';if(change==='salary')card.querySelector('.salary').textContent='300-400元/天';},change);
 await assert.rejects(execute(page,'BIND_CONVERSATION_JOB',{job:chatJob,previewToken,canonicalURL:chatJob.url}),/RECIPIENT_UNVERIFIED/u);assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
for(const change of ['replace','title','hidden'])test(`structured title ${change} at the final card layout check prevents its preview click`,async t=>{
 const page=await fullChatFixture(t);await structuredFullChatTitle(page);await page.locator('.left-content').evaluate((card,change)=>{const bounds=card.getBoundingClientRect.bind(card);let reads=0;card.getBoundingClientRect=()=>{const rect=bounds();if(++reads===6){window.finalTitleMutation=true;const name=card.querySelector('.position-name');if(change==='replace')name.replaceWith(name.cloneNode(true));if(change==='title')name.textContent='虚构最后变化岗位';if(change==='hidden')name.style.opacity='0';}return rect;};},change);
 await assert.rejects(execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken}),/RECIPIENT_UNVERIFIED|DOCUMENT_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.finalTitleMutation)),true);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
test('chat matching diagnostics recompute failed-target matches with bounded lengths rather than source text',async t=>{
 const page=await fullChatFixture(t,{company:'PRIVATE_COMPANY',recruiter:'PRIVATE_RECRUITER',title:'PRIVATE_TITLE'});await execute(page,'READ_CONVERSATION',{job:chatJob});
 await page.locator('.left-content').evaluate(card=>{card.innerHTML='<h3>PRIVATE_CARD_HEADING</h3><span>PRIVATE_CARD_SUBTITLE</span>';});
 const first=(await execute(page,'INSPECT_PAGE')).chatStructure[0].targetMatch;assert.equal(first.title.matches,false);assert.equal(first.company.matches,false);assert.equal(first.recruiter.matches,false);assert.equal(first.title.expectedLength,chatJob.title.length);assert.ok(first.title.actualLength>0);assert.deepEqual(first.cardChildren.map(child=>child.tag),['h3','span']);assert.equal(first.headerSpans.length,2);assert.equal(first.headerSpans[0].textLength,'PRIVATE_RECRUITER'.length);assert.equal(first.headerSpans[0].recruiterMatch,false);assert.doesNotMatch(JSON.stringify(first),/PRIVATE_|林闻|示例科技|AI Agent/u);
 await page.evaluate(job=>{document.querySelector('.user-info .name').textContent=job.recruiterName;document.querySelector('.user-info .company').textContent=job.company;document.querySelector('.left-content').textContent=job.title;},chatJob);
 const updated=(await execute(page,'INSPECT_PAGE')).chatStructure[0].targetMatch;assert.equal(updated.title.matches,true);assert.equal(updated.company.matches,true);assert.equal(updated.recruiter.matches,true);
 await page.evaluate(()=>{for(let i=0;i<12;i++)document.querySelector('.user-info').insertAdjacentHTML('beforeend',`<span class="${'头'.repeat(300)}">PRIVATE_EXTRA_${i}</span>`);document.querySelector('.left-content').innerHTML=Array.from({length:9},()=>`<b class="${'子'.repeat(300)}">PRIVATE_CHILD</b>`).join('');});
 const bounded=await execute(page,'INSPECT_PAGE'),diag=bounded.chatStructure[0].targetMatch;assert.ok(diag.headerSpans.length<=8);assert.ok(diag.cardChildren.length<=4);assert.ok(new TextEncoder().encode(JSON.stringify(bounded.chatStructure)).length<=8192);assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).length<=65536);assert.doesNotMatch(JSON.stringify(diag),/PRIVATE_/u);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
for(const options of [{company:'其他公司'},{recruiter:'赵桐'},{title:'不同岗位'}])test(`full chat preview refuses a mismatched header or position (${JSON.stringify(options)})`,async t=>{
 const page=await fullChatFixture(t,options);await assert.rejects(execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken}),/RECIPIENT_UNVERIFIED|PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
for(const change of ['pane','card','header','name','company','title','duplicate'])test(`a ${change} change between preview and binding never authorizes the full conversation`,async t=>{
 const page=await fullChatFixture(t);await execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken});
 await page.evaluate(change=>{const pane=document.querySelector('.chat-conversation');if(change==='pane')pane.replaceWith(pane.cloneNode(true));if(change==='card'){const el=pane.querySelector('.left-content');el.replaceWith(el.cloneNode(true));}if(change==='header'){const el=pane.querySelector('.user-info');el.replaceWith(el.cloneNode(true));}if(change==='name')pane.querySelector('.name').textContent='赵桐';if(change==='company')pane.querySelector('.company').textContent='其他公司';if(change==='title')pane.querySelector('.left-content').textContent='不同岗位';if(change==='duplicate')pane.parentElement.append(pane.cloneNode(true));},change);
 await assert.rejects(execute(page,'BIND_CONVERSATION_JOB',{job:chatJob,previewToken,canonicalURL:chatJob.url}),/RECIPIENT_UNVERIFIED|DOCUMENT_CHANGED|PAGE_CHANGED/u);assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
});
for(const args of [{previewToken:'22222222-2222-4333-8444-555555555555',canonicalURL:job.url},{previewToken,canonicalURL:'https://www.zhipin.com/job_detail/other.html'},{previewToken,canonicalURL:'https://www.zhipin.com.evil.example/job_detail/a123.html'}])test(`full chat binding refuses an unbound token or different observed URL (${JSON.stringify(args)})`,async t=>{
 const page=await fullChatFixture(t);await execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken});await assert.rejects(execute(page,'BIND_CONVERSATION_JOB',{job:chatJob,...args}),/RECIPIENT_UNVERIFIED|DOCUMENT_CHANGED|PAGE_CHANGED/u);assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
});
test('bound full chat becomes unverified when a frozen header node changes afterward',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await page.locator('.user-info .name').evaluate(element=>element.replaceWith(element.cloneNode(true)));assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('the platform unable resume toolbar reports unavailable and cannot be requested or selected',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);
 const state=await execute(page,'READ_RESUME',{job:chatJob});assert.equal(state.verified,true);assert.equal(state.status,'unavailable');assert.match(state.reason,/平台|允许|回复/u);
 for(const op of ['REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME'])await assert.rejects(execute(page,op,{job:chatJob}),/RESUME_UNAVAILABLE/u);
 assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks||window.actualMessageClicks)),false);
 await page.locator('.toolbar-btn').evaluate(element=>element.classList.remove('unable'));assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'none');
});
test('an existing confirmed outgoing attachment remains sent after its toolbar becomes unable',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);
 await page.locator('.chat-conversation').evaluate(pane=>{pane.insertAdjacentHTML('beforeend','<div class="message-item item-myself"><div class="resume-attachment">已发送附件简历：历史附件.pdf</div></div>');pane.querySelector('.toolbar-btn').classList.add('unable');});
 const state=await execute(page,'READ_RESUME',{job:chatJob});assert.equal(state.status,'sent');
 assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('an approved pending request cannot bypass a currently unable resume toolbar',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);
 await page.locator('.chat-conversation').evaluate(pane=>{pane.insertAdjacentHTML('beforeend','<div class="message-item item-myself"><div class="resume-card">已向对方申请发送附件简历，等待对方同意</div></div><div class="message-item">对方已同意接收附件简历</div>');pane.querySelector('.toolbar-btn').classList.add('unable');});
 assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'unavailable');assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('resume diagnostics observe request and option structure without exposing messages filenames or controls values',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);
 await page.locator('.chat-conversation').evaluate(pane=>{pane.insertAdjacentHTML('beforeend','<div class="message-item request-card"><p>我想要一份您的附件简历，您是否同意 PRIVATE_REQUEST_BODY</p><button>同意</button><button>拒绝</button></div><div class="message-item item-myself"><div class="resume-attachment"><span class="file-name">PRIVATE_ATTACHMENT_NAME.pdf</span><span class="status">已发送</span></div></div><form><div class="message-item resume-card">PRIVATE_FORM_BODY<input value="PRIVATE_FORM_VALUE"></div></form><div class="message-item resume-card" style="display:none">PRIVATE_HIDDEN_BODY</div>');document.body.insertAdjacentHTML('beforeend','<section class="resume-dialog"><h2>选择附件简历</h2><label class="resume-item active"><input type="radio" checked value="PRIVATE_RADIO_VALUE"><span class="resume-name">PRIVATE_OPTION_NAME.pdf</span></label><button>发送</button></section>');});
 const inspected=await execute(page,'INSPECT_PAGE');const state=await execute(page,'READ_RESUME',{job:chatJob});
 assert.deepEqual(state.resumeStructure,inspected.resumeStructure);assert.ok(state.resumeStructure.chat.length>0);assert.equal(state.resumeStructure.dialogs.length,1);
 const encoded=JSON.stringify(state.resumeStructure);assert.doesNotMatch(encoded,/PRIVATE_|\.pdf|href|account|userinfo/iu);assert.ok(new TextEncoder().encode(encoded).length<=8192);
 const nodes=[...state.resumeStructure.chat,...state.resumeStructure.dialogs].flatMap(node=>[node,...node.directChildren,...node.ancestors]);
 assert.ok(nodes.some(node=>node.caption==='同意'));assert.ok(nodes.some(node=>node.caption==='发送'));assert.ok(nodes.some(node=>node.selected));assert.ok(nodes.every(node=>Number.isSafeInteger(node.textLength)&&typeof node.visible==='boolean'&&typeof node.disabled==='boolean'&&typeof node.selected==='boolean'));
 assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('resume diagnostics cap candidate counts depth and complete inspection bytes',async t=>{
 const page=await fullChatFixture(t);await page.locator('.chat-conversation').evaluate(pane=>{for(let i=0;i<24;i++){const message=document.createElement('div');message.className='message-item resume-card '+'结'.repeat(250);for(let j=0;j<12;j++)message.insertAdjacentHTML('beforeend','<span class="resume-file">PRIVATE_BIG_MESSAGE</span>');pane.append(message);}for(let i=0;i<8;i++)document.body.insertAdjacentHTML('beforeend','<section class="resume-dialog"><h2>选择附件简历</h2><button>发送</button></section>');});
 const result=await execute(page,'INSPECT_PAGE'),structure=result.resumeStructure;assert.ok(structure.chat.length>0&&structure.chat.length<=12);assert.ok(structure.dialogs.length<=2);
 for(const node of [...structure.chat,...structure.dialogs]){assert.ok(node.classes.length<=160);assert.ok(node.directChildren.length<=6);assert.ok(node.ancestors.length<=2);assert.ok([...node.directChildren,...node.ancestors].every(child=>child.classes.length<=160&&!Object.hasOwn(child,'directChildren')));}
 assert.ok(new TextEncoder().encode(JSON.stringify(structure)).length<=8192);assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=65536);assert.doesNotMatch(JSON.stringify(structure),/PRIVATE_BIG_MESSAGE/u);
});
test('resume diagnostics remain empty off the exact chat route',async t=>{
 const page=await fixture(t,{dialog:true});const result=await execute(page,'INSPECT_PAGE');assert.deepEqual(result.resumeStructure,{chat:[],dialogs:[]});
});
test('resume diagnostics expose the exact attachment view leaf without private system receipt text',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);
 await page.locator('.messages').evaluate(messages=>messages.insertAdjacentHTML('beforeend','<li class="message-item item-system"><div class="message-content"><div class="unfamiliar-system-content">您的附件简历 PRIVATE_SYSTEM_FILENAME.pdf 已发送给Boss <span class="unfamiliar-view-leaf">点击查看附件</span></div></div></li>'));
 const result=await execute(page,'INSPECT_PAGE'),structure=result.resumeStructure;const leaf=structure.chat.find(node=>node.caption==='点击查看附件');assert.ok(leaf);assert.equal(leaf.tag,'span');assert.equal(leaf.classes,'unfamiliar-view-leaf');assert.equal(leaf.textLength,6);assert.deepEqual(leaf.ancestors.map(node=>node.classes),['unfamiliar-system-content','message-content']);assert.doesNotMatch(JSON.stringify(structure),/PRIVATE_|\.pdf|您的附件简历|已发送给Boss|href/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('resume diagnostics prioritize a latest system attachment receipt within the existing structure budget',async t=>{
 const page=await fullChatFixture(t);await page.locator('.messages').evaluate(messages=>{for(let i=0;i<16;i++)messages.insertAdjacentHTML('beforeend','<li class="message-item item-friend"><div class="message-content">PRIVATE_OLD_BODY 简历</div></li>');messages.insertAdjacentHTML('beforeend','<li class="message-item item-system"><div class="message-content">您的附件简历 PRIVATE_LATEST_FILENAME.pdf 已发送给Boss <span class="unfamiliar-view-leaf">点击查看附件</span></div></li>');});
 const structure=(await execute(page,'INSPECT_PAGE')).resumeStructure;assert.ok(structure.chat.some(node=>node.classes==='message-item item-system'));assert.ok(structure.chat.some(node=>node.caption==='点击查看附件'));assert.ok(structure.chat.length<=12);assert.ok(new TextEncoder().encode(JSON.stringify(structure)).length<=8192);assert.doesNotMatch(JSON.stringify(structure),/PRIVATE_|\.pdf/u);
});
test('resume diagnostics ignore hidden and form attachment view leaves',async t=>{
 const page=await fullChatFixture(t);await page.locator('.messages').evaluate(messages=>messages.insertAdjacentHTML('beforeend','<li class="message-item item-system"><div class="message-content">您的附件简历 PRIVATE_FILENAME.pdf 已发送给Boss <span class="hidden-view" style="display:none">点击查看附件</span><form><span class="form-view">点击查看附件</span></form></div></li>'));
 const structure=(await execute(page,'INSPECT_PAGE')).resumeStructure;assert.equal(structure.chat.some(node=>node.caption==='点击查看附件'),false);assert.doesNotMatch(JSON.stringify(structure),/PRIVATE_|hidden-view|form-view/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
async function observedSystemResumeReceipt(page,{recordTag='li',direction='item-system',contentTag='div',bubbleTag='div',bubbleClass='hyper-link text',viewTag='a',viewClass='target-dom',caption='点击查看附件',body='您的附件简历 PRIVATE_SYSTEM_FILENAME.pdf 已发送给Boss',link=true,first=false}={}) {
 await page.locator('.messages').evaluate((messages,options)=>{const list=document.createElement('ul');list.className='im-list';const view=options.link?`<${options.viewTag} class="${options.viewClass}" href="javascript:;" onclick="window.resumeViewClicks=(window.resumeViewClicks||0)+1">${options.caption}</${options.viewTag}>`:'';list.innerHTML=`<${options.recordTag} class="message-item ${options.direction}"><${options.contentTag} class="message-content"><${options.bubbleTag} class="${options.bubbleClass}">${options.first?view+options.body:options.body+view}</${options.bubbleTag}></${options.contentTag}></${options.recordTag}>`;messages.append(list);},{recordTag,direction,contentTag,bubbleTag,bubbleClass,viewTag,viewClass,caption,body,link,first});
}
test('observed official system attachment receipt proves delivery without opening or exposing the file',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await observedSystemResumeReceipt(page);
 const proof=await execute(page,'READ_RESUME',{job:chatJob});assert.equal(proof.verified,true);assert.equal(proof.status,'sent');assert.doesNotMatch(JSON.stringify(proof),/PRIVATE_SYSTEM_FILENAME|\.pdf|javascript:/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks||window.resumeViewClicks)),false);
});
test('observed official system attachment receipt allows short whitespace around a nonempty filename',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await observedSystemResumeReceipt(page,{body:'您的附件简历\n\t 示例 简历 \n 已发送给Boss \n '});assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'sent');
});
for(const options of [{recordTag:'div'},{direction:'item-friend'},{direction:'item-myself'},{direction:'item-system item-friend'},{direction:'item-system item-myself'},{contentTag:'section'},{bubbleTag:'span'},{bubbleClass:'plain-text'},{viewTag:'span'},{viewClass:'unfamiliar-view'},{caption:'查看附件'},{link:false},{first:true},{body:'您的附件简历 已发送给Boss'},{body:'您的附件简历 示例.pdf 未发送给Boss'},{body:'您的附件简历 示例.pdf 尚未发送给Boss'},{body:'您的附件简历 示例.pdf 发送中，已发送给Boss'},{body:'您的附件简历 示例.pdf 发送失败，已发送给Boss'},{body:'您的附件简历 示例.pdf 申请发送，已发送给Boss'},{body:'您的附件简历 示例.pdf 等待同意，已发送给Boss'},{body:'您的附件简历 示例.pdf 已发送给Boss 其他说明'}])test(`observed system attachment receipt rejects nonmatching structure direction or state (${JSON.stringify(options)})`,async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await observedSystemResumeReceipt(page,options);assert.notEqual((await execute(page,'READ_RESUME',{job:chatJob})).status,'sent');assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks||window.resumeViewClicks)),false);
});
for(const hidden of ['record','content','bubble','view','filename'])test(`observed system attachment receipt requires visible ${hidden}`,async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await observedSystemResumeReceipt(page);
 await page.locator('.im-list > .item-system').evaluate((message,hidden)=>{const node=hidden==='record'?message:hidden==='content'?message.querySelector('.message-content'):hidden==='bubble'?message.querySelector('.hyper-link'):hidden==='view'?message.querySelector('.target-dom'):null;if(node)node.style.display='none';else message.querySelector('.hyper-link').innerHTML='<span>您的附件简历 </span><span style="display:none">PRIVATE_HIDDEN_FILENAME.pdf</span><span> 已发送给Boss</span><a class="target-dom">点击查看附件</a>';},hidden);
 assert.notEqual((await execute(page,'READ_RESUME',{job:chatJob})).status,'sent');assert.equal(await page.evaluate(()=>Boolean(window.resumeViewClicks)),false);
});
for(const change of ['nested-system','duplicate-content','duplicate-view','wrong-list'])test(`observed system attachment receipt rejects ambiguous or forged nesting (${change})`,async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await observedSystemResumeReceipt(page);
 await page.locator('.im-list > .item-system').evaluate((message,change)=>{if(change==='nested-system'){const wrapper=document.createElement('li');wrapper.className='message-item item-friend';message.parentElement.insertBefore(wrapper,message);wrapper.append(message);}if(change==='duplicate-content')message.append(message.querySelector('.message-content').cloneNode(true));if(change==='duplicate-view')message.querySelector('.hyper-link').append(message.querySelector('.target-dom').cloneNode(true));if(change==='wrong-list')message.parentElement.className='ordinary-messages';},change);
 assert.notEqual((await execute(page,'READ_RESUME',{job:chatJob})).status,'sent');assert.equal(await page.evaluate(()=>Boolean(window.resumeViewClicks)),false);
});
test('observed system attachment receipt cannot bypass an absent actual conversation job binding',async t=>{
 const page=await fullChatFixture(t);await observedSystemResumeReceipt(page);const proof=await execute(page,'READ_RESUME',{job:chatJob});assert.equal(proof.verified,false);assert.notEqual(proof.status,'sent');
 await bindFullChat(page);await page.locator('.user-info .company').evaluate(node=>{node.textContent='其他公司';});assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).verified,false);assert.equal(await page.evaluate(()=>Boolean(window.resumeViewClicks)),false);
});
test('observed system attachment receipt rechecks the recipient after reading its view control',async t=>{
 const page=await fullChatFixture(t);await bindFullChat(page);await observedSystemResumeReceipt(page);
 await page.locator('.target-dom').evaluate(element=>{const bounds=element.getBoundingClientRect.bind(element);element.getBoundingClientRect=()=>{const value=bounds();document.querySelector('.user-info .company').textContent='已切换公司';return value;};});const proof=await execute(page,'READ_RESUME',{job:chatJob});assert.equal(proof.verified,false);assert.notEqual(proof.status,'sent');assert.equal(await page.evaluate(()=>Boolean(window.resumeViewClicks)),false);
});
test('full chat verification rechecks the preview card after its last connected layout read',async t=>{
 const page=await fullChatFixture(t);await page.locator('.left-content').evaluate(element=>{const bounds=element.getBoundingClientRect.bind(element);let reads=0;element.getBoundingClientRect=()=>{const rect=bounds();if(++reads===3)element.textContent='不同岗位';return rect;};});
 await assert.rejects(execute(page,'VERIFY_CONVERSATION_JOB',{job:chatJob,previewToken}),/RECIPIENT_UNVERIFIED|PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
async function actualResumeToolbar(page) {
 await page.evaluate(()=>{document.querySelector('.chat-tool').remove();document.querySelector('.chat-im.chat-editor').insertAdjacentHTML('afterbegin','<div class="toolbar-btn-content"><div class="toolbar-btn tooltip tooltip-top" onclick="window.actualResumeClicks=(window.actualResumeClicks||0)+1">发简历</div></div>');});
}
async function observedControlsResumeToolbar(page) {
 await page.evaluate(()=>{document.querySelector('.chat-tool').remove();document.querySelector('.chat-im.chat-editor').insertAdjacentHTML('beforebegin','<div class="chat-controls"><div class="toolbar-btn-content"><div class="toolbar-btn tooltip tooltip-top" onclick="window.actualResumeClicks=(window.actualResumeClicks||0)+1">发简历</div></div></div>');});
}
test('observed chat-controls resume toolbar requests exactly once from the bound conversation',async t=>{
 const page=await fullChatFixture(t);await observedControlsResumeToolbar(page);await bindFullChat(page);
 const result=await execute(page,'REQUEST_RESUME',{job:chatJob});assert.equal(result.clicked,true);assert.equal(result.status,'none');assert.equal(await page.evaluate(()=>window.actualResumeClicks),1);
});
for(const duplicate of ['same-layout','old-and-observed'])test(`observed resume toolbar rejects ambiguous duplicate controls (${duplicate})`,async t=>{
 const page=await fullChatFixture(t);await observedControlsResumeToolbar(page);await bindFullChat(page);
 await page.evaluate(duplicate=>{const pane=document.querySelector('.chat-conversation'),control=document.querySelector('.toolbar-btn');if(duplicate==='same-layout')control.parentElement.append(control.cloneNode(true));else pane.querySelector('.chat-im.chat-editor').insertAdjacentHTML('afterbegin','<div class="toolbar-btn-content"><div class="toolbar-btn tooltip tooltip-top" onclick="window.wrongResumeClick=true">发简历</div></div>');},duplicate);
 await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks||window.wrongResumeClick)),false);
});
for(const flag of ['unable','disabled','aria-disabled','ancestor-unable'])test(`observed chat-controls resume toolbar respects ${flag}`,async t=>{
 const page=await fullChatFixture(t);await observedControlsResumeToolbar(page);await bindFullChat(page);
 await page.locator('.toolbar-btn').evaluate((element,flag)=>{if(flag==='aria-disabled')element.setAttribute(flag,'true');else if(flag==='ancestor-unable')element.parentElement.classList.add('unable');else element.classList.add(flag);},flag);
 assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'unavailable');await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/RESUME_UNAVAILABLE/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('observed resume toolbar ignores enabled and disabled message controls with matching classes',async t=>{
 const page=await fullChatFixture(t);await observedControlsResumeToolbar(page);await bindFullChat(page);
 await page.locator('.message-item').evaluate(message=>message.insertAdjacentHTML('beforeend','<div class="chat-controls"><div class="toolbar-btn-content"><div class="toolbar-btn tooltip tooltip-top unable" onclick="window.wrongResumeClick=true">发简历</div><div class="toolbar-btn tooltip tooltip-top" onclick="window.wrongResumeClick=true">发简历</div></div></div>'));
 assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'none');const result=await execute(page,'REQUEST_RESUME',{job:chatJob});assert.equal(result.clicked,true);assert.equal(await page.evaluate(()=>window.actualResumeClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.wrongResumeClick)),false);
});
test('a message-contained observed resume control cannot substitute for the actual toolbar',async t=>{
 const page=await fullChatFixture(t);await observedControlsResumeToolbar(page);await bindFullChat(page);
 await page.evaluate(()=>document.querySelector('.message-item').append(document.querySelector('.chat-controls')));
 await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
for(const change of ['caption','node','unable','message-container'])test(`observed resume toolbar rechecks ${change} after its final visibility read`,async t=>{
 const page=await fullChatFixture(t);await observedControlsResumeToolbar(page);await bindFullChat(page);
 await page.locator('.toolbar-btn').evaluate((element,change)=>{const bounds=element.getBoundingClientRect.bind(element);let reads=0;element.getBoundingClientRect=()=>{const rect=bounds();if(++reads===12){if(change==='caption')element.textContent='发送简历';if(change==='node')element.replaceWith(element.cloneNode(true));if(change==='unable')element.classList.add('unable');if(change==='message-container')document.querySelector('.message-item').append(element.parentElement.parentElement);}return rect;};},change);
 await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/PAGE_CHANGED|DOCUMENT_CHANGED|RESUME_UNAVAILABLE/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('only the observed enabled bound full-chat toolbar can request a resume from a nonsemantic control',async t=>{
 const page=await fullChatFixture(t);await actualResumeToolbar(page);await bindFullChat(page);
 await page.locator('.chat-conversation').evaluate(element=>element.insertAdjacentHTML('beforeend','<div onclick="window.wrongResumeClick=true">发简历</div>'));
 const result=await execute(page,'REQUEST_RESUME',{job:chatJob});assert.equal(result.clicked,true);assert.equal(await page.evaluate(()=>window.actualResumeClicks),1);assert.equal(await page.evaluate(()=>Boolean(window.wrongResumeClick)),false);
});
for(const flag of ['unable','disabled','aria-disabled','ancestor-unable'])test(`the exact full-chat resume toolbar respects its ${flag} business restriction`,async t=>{
 const page=await fullChatFixture(t);await actualResumeToolbar(page);await bindFullChat(page);await page.locator('.toolbar-btn').evaluate((element,flag)=>{if(flag==='aria-disabled')element.setAttribute(flag,'true');else if(flag==='ancestor-unable')element.parentElement.classList.add('unable');else element.classList.add(flag);},flag);
 assert.equal((await execute(page,'READ_RESUME',{job:chatJob})).status,'unavailable');await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/RESUME_UNAVAILABLE/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('requesting from an unbound exact toolbar or a toolbar outside the pane cannot click',async t=>{
 const page=await fullChatFixture(t);await actualResumeToolbar(page);await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/RECIPIENT_UNVERIFIED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
 await bindFullChat(page);await page.locator('.toolbar-btn-content').evaluate(element=>document.body.append(element));await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/PAGE_CHANGED/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
for(const change of ['caption','node','unable'])test(`full-chat resume request rechecks ${change} after its final visibility read`,async t=>{
 const page=await fullChatFixture(t);await actualResumeToolbar(page);await bindFullChat(page);
 await page.locator('.toolbar-btn').evaluate((element,change)=>{const bounds=element.getBoundingClientRect.bind(element);let reads=0;element.getBoundingClientRect=()=>{const rect=bounds();if(++reads===12){if(change==='caption')element.textContent='发送简历';if(change==='node')element.replaceWith(element.cloneNode(true));if(change==='unable')element.classList.add('unable');}return rect;};},change);
 await assert.rejects(execute(page,'REQUEST_RESUME',{job:chatJob}),/PAGE_CHANGED|DOCUMENT_CHANGED|RESUME_UNAVAILABLE/u);assert.equal(await page.evaluate(()=>Boolean(window.actualResumeClicks)),false);
});
test('the content receiver requests Node permission before a conversation job preview click',async t=>{
 const page=await fullChatFixture(t);await receiver(page,'deny');
 const result=await page.evaluate(({job,previewToken})=>new Promise(resolve=>testReceiver({type:'BOSS_DOM_COMMAND',command:{id:'preview-one',epoch:'epoch-one',op:'VERIFY_CONVERSATION_JOB',args:{job,previewToken},expiresAt:Date.now()+8000,expectedDocument:BossDomExecutor.metadata()}},{id:'own-extension'},resolve)),{job:chatJob,previewToken});
 assert.equal(await page.evaluate(()=>permitCalls.length),1);assert.equal(result.ok,false);assert.equal(result.error.code,'ACTION_NOT_PERMITTED');assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
test('confirmation structure exposes only markers lengths and exact public status words',async t=>{
 const page=await fixture(t);await page.evaluate(markup=>{document.body.insertAdjacentHTML('beforeend',markup);document.querySelector('.message-list').insertAdjacentHTML('beforeend','<div class="message-item"><div>失败</div><div class="new-body-class">PRIVATE_SECOND_BODY</div></div><div class="message-item"><span>发送中</span><div>PRIVATE_THIRD_BODY</div></div><form><div class="message-item FORM_MARKER"><textarea>PRIVATE_TEXTAREA_VALUE</textarea><input value="PRIVATE_INPUT_VALUE"></div></form>');document.querySelector('.dialog-container').insertAdjacentHTML('beforeend','<form><input value="OTHER_INPUT_SECRET"><textarea>OTHER_TEXTAREA_SECRET</textarea></form>');},confirmationMarkup({message:'PRIVATE_CONFIRMATION_BODY'}));
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations.confirmationStructure;
 assert.equal(observed.length,1);assert.equal(observed[0].header.name[0].classes,'name');assert.equal(observed[0].header.position[0].classes,'position');assert.equal(observed[0].messages.length,3);
 assert.equal(observed[0].messages[0].directChildren[0].strictStatusText,'已发送');assert.equal(observed[0].messages[1].directChildren[0].strictStatusText,'失败');assert.equal(observed[0].messages[2].directChildren[0].strictStatusText,'发送中');
 assert.equal(observed[0].messages[0].directChildren[1].textLength,'PRIVATE_CONFIRMATION_BODY'.length);assert.equal(Object.hasOwn(observed[0].messages[0].directChildren[1],'strictStatusText'),false);
 assert.doesNotMatch(JSON.stringify(observed),/PRIVATE_|OTHER_INPUT_SECRET|OTHER_TEXTAREA_SECRET|FORM_MARKER|林闻|招聘经理|您好/u);assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('confirmation structure reports bounded unfamiliar header tags without exposing header values',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<div class="dialog-wrap startchat-dialog"><div class="dialog-container"><h4 class="title"><span class="name">PRIVATE_HEADER_NAME</span><span class="position">PRIVATE_HEADER_POSITION</span><span style="display:none">PRIVATE_HIDDEN_HEADER</span></h4><section class="title"><div>PRIVATE_SECOND_HEADER</div></section><form><h2 class="title">PRIVATE_FORM_HEADER</h2></form><h5 class="title" style="display:none">PRIVATE_HIDDEN_TITLE</h5><div class="message-list"><li class="message-item"><h6 class="title">PRIVATE_MESSAGE_TITLE</h6><span class="status success">已发送</span><p class="text">PRIVATE_MESSAGE_BODY</p></li></div></div></div>');});
 const observed=(await execute(page,'INSPECT_PAGE')).detailObservations.confirmationStructure;
 assert.equal(observed.length,1);assert.ok(Array.isArray(observed[0].header.nodes),'header structure candidates are present');assert.deepEqual(observed[0].header.nodes.map(node=>({tag:node.tag,classes:node.classes})),[{tag:'h4',classes:'title'},{tag:'section',classes:'title'}]);
 assert.equal(observed[0].header.nodes[0].textLength,'PRIVATE_HEADER_NAMEPRIVATE_HEADER_POSITION'.length);assert.deepEqual(observed[0].header.nodes[0].directChildren.map(child=>({tag:child.tag,classes:child.classes,textLength:child.textLength})),[{tag:'span',classes:'name',textLength:'PRIVATE_HEADER_NAME'.length},{tag:'span',classes:'position',textLength:'PRIVATE_HEADER_POSITION'.length}]);
 assert.equal(observed[0].header.nodes[1].directChildren[0].tag,'div');assert.equal(Object.hasOwn(observed[0].header.nodes[1],'strictStatusText'),false);assert.doesNotMatch(JSON.stringify(observed),/PRIVATE_|林闻|示例科技/u);
 assert.equal(await page.evaluate(()=>Boolean(window.confirmationCloseClicks)),false);
});
test('confirmation structure bounds dialogs messages direct children ancestry and bytes',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{for(let i=0;i<5;i++){const wrap=document.createElement('section');wrap.className='dialog-wrap startchat-dialog '+ '模'.repeat(250);wrap.innerHTML='<div class="dialog-container"><h3 class="title"><span class="name">PRIVATE_NAME</span><span class="position">PRIVATE_POSITION</span></h3><div class="message-list"></div></div>';document.body.append(wrap);for(let j=0;j<9;j++){const header=document.createElement('h4');header.className='title '+ '题'.repeat(250);for(let k=0;k<10;k++)header.insertAdjacentHTML('beforeend',`<span class="${'字'.repeat(250)}">PRIVATE_LONG_HEADER</span>`);wrap.querySelector('.dialog-container').prepend(header);const message=document.createElement('div');message.className='message-item '+ '消'.repeat(250);for(let k=0;k<10;k++)message.insertAdjacentHTML('beforeend',`<div class="${'子'.repeat(250)}">${k===0?'已发送':'PRIVATE_LONG_BODY'.repeat(100)}</div>`);wrap.querySelector('.message-list').append(message);}}});
 const inspected=await execute(page,'INSPECT_PAGE'),observed=inspected.detailObservations.confirmationStructure;
 assert.ok(observed.length>0&&observed.length<=2);
 for(const dialog of observed){assert.ok(dialog.classes.length<=160);assert.ok(Array.isArray(dialog.header.nodes),'header structure candidates are present');assert.ok(dialog.header.nodes.length<=6);for(const header of dialog.header.nodes){assert.ok(header.classes.length<=160);assert.ok(header.directChildren.length<=6);assert.equal(Object.hasOwn(header,'text'),false);assert.ok(header.directChildren.every(child=>child.classes.length<=160&&!Object.hasOwn(child,'text')));}assert.ok(dialog.messages.length<=4);for(const message of dialog.messages){assert.ok(message.classes.length<=160);assert.ok(message.ancestors.length<=2);assert.ok(message.directChildren.length<=6);for(const child of message.directChildren){assert.ok(child.classes.length<=160);assert.ok(child.ancestors.length<=2);assert.equal(Object.hasOwn(child,'text'),false);}}}
 assert.ok(new TextEncoder().encode(JSON.stringify(observed)).length<=8192);assert.ok(new TextEncoder().encode(JSON.stringify(inspected)).length<=65536);assert.doesNotMatch(JSON.stringify(observed),/PRIVATE_|PRIVATE_POSITION/u);
});
test('confirmation structure omits hidden dialogs and stays empty outside exact job detail routes',async t=>{
 const page=await fixture(t);await page.evaluate(markup=>{document.body.insertAdjacentHTML('beforeend',markup);document.querySelector('.startchat-dialog').style.opacity='0';},confirmationMarkup({message:'PRIVATE_HIDDEN_BODY'}));
 assert.deepEqual((await execute(page,'INSPECT_PAGE')).detailObservations.confirmationStructure,[]);
 await page.locator('.startchat-dialog').evaluate(element=>{element.style.opacity='1';});await page.evaluate(()=>history.replaceState(null,'','/web/geek/chat'));assert.deepEqual((await execute(page,'INSPECT_PAGE')).detailObservations.confirmationStructure,[]);
 await page.evaluate(()=>history.replaceState(null,'','/job_detail/a123.html/extra'));assert.deepEqual((await execute(page,'INSPECT_PAGE')).detailObservations.confirmationStructure,[]);
});
test('fixed chat structure records raw zero-box candidates actual parents and only visible control counts',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{history.replaceState(null,'','/web/geek/chat');document.body.innerHTML='<div class="chat-container page-container"><section class="observed-wrapper"><div class="chat-wrap"><article class="chat-conversation" style="display:contents"><div class="user-info">PRIVATE_RECRUITER</div><div class="user-info" style="display:none">HIDDEN_PRIVATE_RECRUITER</div><div class="chat-position-content"><div class="left-content">PRIVATE_JOB_TITLE</div></div><div class="private-body">PRIVATE_CHAT_BODY</div><input value="PRIVATE_INPUT_VALUE"><textarea>PRIVATE_TEXTAREA_VALUE</textarea><a href="https://example.invalid/PRIVATE_URI">PRIVATE_LINK_BODY</a></article></div></section></div>';});
 const result=await execute(page,'INSPECT_PAGE');assert.equal(result.chatStructure.length,1);const pane=result.chatStructure[0];assert.equal(pane.tag,'article');assert.equal(pane.classes,'chat-conversation');assert.deepEqual(pane.bbox,{width:0,height:0});assert.equal(pane.visible,false);assert.deepEqual(pane.ancestors.slice(0,3).map(parent=>parent.classes),['chat-wrap','observed-wrapper','chat-container page-container']);assert.deepEqual(pane.counts,{userInfo:1,positionContent:1,leftContent:1});assert.doesNotMatch(JSON.stringify(result.chatStructure),/PRIVATE_|https:|value|text/u);assert.equal(Object.hasOwn(await execute(page,'READ_STATUS'),'chatStructure'),false);assert.equal(await page.evaluate(()=>Boolean(window.previewClicks)),false);
});
test('fixed chat structure bounds candidates ancestry bytes and excludes other routes',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{history.replaceState(null,'','/web/geek/chat');document.body.innerHTML='';for(let i=0;i<9;i++){let outer=document.createElement('div');document.body.append(outer);for(let j=0;j<10;j++){const child=document.createElement('section');child.className='模'.repeat(300);outer.append(child);outer=child;}outer.innerHTML=`<div class="chat-conversation ${'会'.repeat(300)}"><div class="user-info">PRIVATE_NAME</div><div class="left-content">PRIVATE_TITLE</div></div>`;}});
 const result=await execute(page,'INSPECT_PAGE');assert.ok(result.chatStructure.length>0&&result.chatStructure.length<=4);for(const pane of result.chatStructure){assert.ok(pane.classes.length<=160);assert.ok(pane.ancestors.length<=6);assert.ok(pane.ancestors.every(parent=>parent.classes.length<=160&&Number.isFinite(parent.bbox.width)&&Number.isFinite(parent.bbox.height)&&typeof parent.visible==='boolean'));}assert.ok(new TextEncoder().encode(JSON.stringify(result.chatStructure)).length<=8192);assert.ok(new TextEncoder().encode(JSON.stringify(result)).length<=65536);assert.doesNotMatch(JSON.stringify(result.chatStructure),/PRIVATE_/u);
 await page.evaluate(()=>history.replaceState(null,'','/web/geek/jobs'));assert.deepEqual((await execute(page,'INSPECT_PAGE')).chatStructure,[]);
 await assert.rejects(execute(page,'INSPECT_PAGE',{selector:'.chat-conversation'}),/COMMAND_INVALID/u);
});
test('internal failed-verification revocation removes the matching binding even after its pane changes',async t=>{
 const page=await fullChatFixture(t);const bound=await bindFullChat(page);await page.locator('.user-info .name').evaluate(element=>{element.textContent='赵桐';});assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
 const revoked=await execute(page,'REVOKE_CONVERSATION_JOB',{job:chatJob,previewToken},bound.meta);assert.equal(revoked.revoked,true);
 await page.locator('.user-info .name').evaluate(element=>{element.textContent='林闻';});assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
});
test('internal revocation cannot remove a different token binding and can clear one after same-document history changes',async t=>{
 const page=await fullChatFixture(t);const bound=await bindFullChat(page);
 const wrong=await execute(page,'REVOKE_CONVERSATION_JOB',{job:chatJob,previewToken:'22222222-2222-4333-8444-555555555555'});assert.equal(wrong.revoked,false);assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,true);
 await page.evaluate(()=>history.replaceState(null,'','/web/geek/chat?changed=1'));assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
 assert.equal((await execute(page,'REVOKE_CONVERSATION_JOB',{job:chatJob,previewToken},bound.meta)).revoked,true);
 await page.evaluate(()=>history.replaceState(null,'','/web/geek/chat'));assert.equal((await execute(page,'READ_CONVERSATION',{job:chatJob})).verified,false);
});
