import { VERSION, OPS, EFFECT_OPS, bossUrl, jobUrl, localBase } from './protocol.js';
const effects=new Set(EFFECT_OPS), sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const browserEffects=new Set(['OPEN_SESSION','NAV_SEARCH','NAV_JOB']);
const fault=(code,message)=>Object.assign(Error(message),{code});
const clean=value=>String(value??'').replace(/\s+/gu,' ').trim();
function previewJob(args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='job')||!args.job||typeof args.job!=='object'||Array.isArray(args.job))throw fault('INVALID_COMMAND','会话验证只接受固定岗位参数');
  const job=args.job;let canonical;
  try{canonical=jobUrl(job.url);if(new URL(canonical).origin!=='https://www.zhipin.com')throw Error();}catch{throw fault('INVALID_COMMAND','岗位地址不可确认');}
  const id=new URL(canonical).pathname.match(/\/([^/]+)\.html$/u)[1];
  if(job.id!=null&&job.id!==id||typeof job.title!=='string'||!clean(job.title)||typeof job.company!=='string'||!clean(job.company)||job.recruiterName!=null&&typeof job.recruiterName!=='string')throw fault('INVALID_COMMAND','岗位 ID、名称、公司或招聘者不可确认');
  return {...job,id,url:canonical,title:clean(job.title),company:clean(job.company),...(job.recruiterName!=null?{recruiterName:clean(job.recruiterName)}:{})};
}
function observedJobUrl(value){try{const canonical=jobUrl(value);return new URL(canonical).origin==='https://www.zhipin.com'?canonical:null;}catch{return null;}}
const samePreviewJob=(left,right)=>left.url===right.url&&left.title===right.title&&left.company===right.company&&clean(left.recruiterName)===clean(right.recruiterName);
const diagnosticErrors=new Set(['STALE_COMMAND','BROWSER_CLOSED','BROWSER_UNSUPPORTED','DOCUMENT_CHANGED','ACTION_NOT_PERMITTED','RECIPIENT_UNVERIFIED','INVALID_COMMAND','COMMAND_INVALID','PAGE_NOT_READY','PAGE_CHANGED','UNKNOWN_RESULT','VERIFICATION_PENDING','DOM_ERROR','CAPTCHA','RATE_LIMIT','LOGIN_REQUIRED','DRAFT_CONFLICT','DUPLICATE_GREETING','GREETING_UNVERIFIED','RESULT_UNCERTAIN','RESUME_SELECTION','UNCLASSIFIED_ERROR']);
const diagnosticPhases=new Set(['started','completed','validate-preview','query-tabs','request-dom','dom-returned','await-preview','read-preview','bind-preview','permit-command-rejected','permit-source-rejected','permit-document-rejected','permit-url-rejected','permit-binding-rejected','permit-node-granted','permit-node-rejected','permit-node-error']);
function boundedDiagnostic(value){
  if(!value)return null;
  return{op:OPS.includes(value.op)?value.op:'UNKNOWN_OPERATION',errorCode:value.errorCode==null?null:diagnosticErrors.has(value.errorCode)?value.errorCode:'UNCLASSIFIED_ERROR',elapsedMs:Number.isFinite(value.elapsedMs)?Math.min(86400000,Math.max(0,Math.floor(value.elapsedMs))):0,previewCapturedCount:Number.isFinite(value.previewCapturedCount)?Math.min(20,Math.max(0,Math.floor(value.previewCapturedCount))):0,phase:diagnosticPhases.has(value.phase)?value.phase:'completed'};
}
function inspectionDiagnostic(result,diagnostic,command){
  const output={...result,...(diagnostic?{lastOperationDiagnostic:boundedDiagnostic(diagnostic)}:{})};const arrays=[];
  for(const key of ['cardObservations','detailObservations'])if(output[key]&&typeof output[key]==='object'){output[key]={...output[key]};for(const [name,value] of Object.entries(output[key]))if(Array.isArray(value)){output[key][name]=value.slice();arrays.push(output[key][name]);}}
  const encoder=new TextEncoder();while(encoder.encode(JSON.stringify({id:command.id,epoch:command.epoch,result:output})).length>65536){const list=arrays.find(items=>items.length);if(!list)throw fault('PAGE_CHANGED','诊断回执超出大小限制');list.pop();}return output;
}

export class BrowserWorker {
  constructor(api,fetcher=globalThis.fetch.bind(globalThis)){this.api=api;this.fetcher=fetcher;this.auth=null;this.epoch=null;this.seq=0;this.workTab=null;this.owned=new Set();this.documents=new Map();this.running=false;this.domCommand=null;this.conversationPreview=null;this.previewHooks=false;this.failedConversationBindings=new Map();this.lastOperationDiagnostic=null;this.operationProgress=null;}
  operationPhase(phase,count){if(!this.operationProgress)return;if(diagnosticPhases.has(phase))this.operationProgress.phase=phase;if(Number.isFinite(count))this.operationProgress.previewCapturedCount=count;}
  isBoss(url){try{bossUrl(url);return true;}catch{return false;}}
  async bootstrap(){
    this.api.runtime.onMessage.addListener((message,sender,reply)=>{
      if(sender.id!==this.api.runtime.id)return false;
      if(message?.type==='BOSS_ACTION_PERMIT'){this.permitDom(message,sender).then(reply,error=>reply({ok:false,allowed:false,error:error.message}));return true;}
      if(message?.type==='BOSS_CONTENT_READY'){
        if(sender.frameId===0&&sender.tab?.id&&this.isBoss(sender.url)&&this.isBoss(message.meta?.url)&&message.meta?.documentId)this.documents.set(sender.tab.id,{...message.meta,browserDocumentId:sender.documentId,browserSourceUrl:sender.url});
        return false;
      }
      let popup=false;try{const u=new URL(sender.url);popup=u.protocol==='chrome-extension:'&&u.hostname===this.api.runtime.id&&u.pathname==='/popup.html';}catch{}
      if(!popup)return false;
      if(message?.type==='BOSS_BRIDGE_STATUS'){reply({ok:true,paired:!!this.auth,base:this.auth?.base,epoch:this.epoch,seq:this.seq,workTab:this.workTab,owned:[...this.owned]});return false;}
      if(message?.type==='BOSS_PAIR'){this.pair(message.base,message.code).then(value=>reply({ok:true,value}),error=>reply({ok:false,error:error.message}));return true;}
      return false;
    });
    this.api.tabs.onRemoved.addListener(id=>{this.documents.delete(id);this.owned.delete(id);if(id===this.workTab)this.workTab=null;});
    this.api.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading')this.documents.delete(id);});
    this.api.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='boss-bridge')this.loop();});
    await this.api.alarms.create('boss-bridge',{periodInMinutes:.5});
    await this.api.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
    await this.api.storage.session.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
    const saved=await this.api.storage.local.get('bossBridge');
    if(saved.bossBridge){try{localBase(saved.bossBridge.base);this.auth=saved.bossBridge;}catch{}}
    const owned=await this.api.storage.session.get('bossOwnedTabs');
    for(const id of owned.bossOwnedTabs||[])if(Number.isSafeInteger(id))this.owned.add(id);
    this.loop();
  }
  async pair(base,code){
    base=localBase(base);
    if(typeof code!=='string'||!/^[a-f0-9]{64}$/u.test(code.trim()))throw Error('请输入控制台给出的配对码');
    const saved=await this.api.storage.local.get('bossInstanceId'),instanceId=saved.bossInstanceId||crypto.randomUUID();
    const res=await this.fetcher(base+'/bridge/pair',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({pairingCode:code.trim(),instanceId})});
    const data=await res.json();if(!res.ok)throw Error(data.error||'配对失败');
    this.auth={base,token:data.token,instanceId};this.epoch=null;this.seq=0;
    await this.api.storage.local.set({bossBridge:this.auth,bossInstanceId:instanceId});this.loop();return{paired:true,base};
  }
  async send(path,body){
    if(!this.auth)throw fault('EXTENSION_REQUIRED','扩展尚未配对');
    const headers={'x-boss-bridge-token':this.auth.token,'x-boss-instance':this.auth.instanceId};if(body!==undefined)headers['content-type']='application/json';
    const res=await this.fetcher(this.auth.base+path,{method:body===undefined?'GET':'POST',redirect:'error',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await res.json();if(!res.ok)throw fault(data.code||'BRIDGE_REJECTED',data.error||'连接被拒绝');return data;
  }
  async cleanup(){
    const preview=this.conversationPreview;if(preview)await this.clearPreview(preview,{restore:false});
    const ids=[...this.owned];this.owned.clear();this.workTab=null;this.documents.clear();
    for(const id of ids){try{await this.api.tabs.remove(id);}catch{}}
    await this.api.storage.session.set({bossOwnedTabs:[]});
    this.failedConversationBindings.clear();
  }
  async own(id){this.owned.add(id);this.workTab=id;await this.api.storage.session.set({bossOwnedTabs:[...this.owned]});}
  async permitDom(message,sender){
    const command=this.domCommand,doc=this.documents.get(this.workTab),expected=command?.target?.document;
    const valid=command&&effects.has(command.op)&&!browserEffects.has(command.op)&&command.id===message.id&&command.epoch===message.epoch&&command.epoch===this.epoch&&command.expiresAt===message.expiresAt&&command.expiresAt>Date.now();
    const targetMatches=!expected||expected.documentId===doc?.documentId&&expected.url===doc?.url;
    if(!valid||sender.id!==this.api.runtime.id||sender.frameId!==0||sender.tab?.id!==this.workTab||!this.owned.has(this.workTab)||!doc?.browserDocumentId||this.bindingBlocked(this.workTab,doc)||sender.documentId!==doc.browserDocumentId||sender.url!==(doc.browserSourceUrl??doc.url)||!this.isBoss(sender.url)||!this.isBoss(doc.url)||!targetMatches){
      this.operationPhase(!valid?'permit-command-rejected':sender.id!==this.api.runtime.id||sender.frameId!==0||sender.tab?.id!==this.workTab||!this.owned.has(this.workTab)?'permit-source-rejected':!doc?.browserDocumentId||sender.documentId!==doc.browserDocumentId?'permit-document-rejected':this.bindingBlocked(this.workTab,doc)?'permit-binding-rejected':'permit-url-rejected');
      return{ok:false,allowed:false,error:'动作来源、文档或截止时间不匹配'};
    }
    try{const permit=await this.send('/bridge/permit',{id:command.id,epoch:command.epoch});let allowed=permit.allowed===true;
      if(allowed&&command.op==='VERIFY_CONVERSATION_JOB'){const context=this.conversationPreview;allowed=Boolean(context&&context.commandId===command.id&&this.previewPinMatches(context)&&Date.now()<context.captureExpiresAt);if(allowed)context.permitted=true;}
      this.operationPhase(allowed?'permit-node-granted':'permit-node-rejected');return{ok:allowed,allowed};
    }catch(error){this.operationPhase('permit-node-error');return{ok:false,allowed:false,error:error.message};}
  }
  previewPinMatches(context){
    const doc=this.documents.get(context.workTab);
    return this.conversationPreview===context&&this.epoch===context.epoch&&this.workTab===context.workTab&&this.owned.has(context.workTab)&&doc?.browserDocumentId===context.browserDocumentId&&doc?.documentId===context.meta.documentId&&doc?.url===context.meta.url;
  }
  bindingBlocked(id,doc){const failed=this.failedConversationBindings.get(id);return Boolean(failed&&doc&&failed.browserDocumentId===doc.browserDocumentId&&failed.documentId===doc.documentId);}
  installPreviewHooks(){
    if(this.previewHooks)return;
    if(!this.api.tabs.onCreated?.addListener||!this.api.tabs.onRemoved?.addListener||!this.api.tabs.onUpdated?.addListener)throw fault('BROWSER_UNSUPPORTED','浏览器没有可验证的临时标签事件');
    this.api.tabs.onCreated.addListener(tab=>{
      const context=this.conversationPreview;
      if(!context||!context.permitted||!this.previewPinMatches(context)||Date.now()>=context.captureExpiresAt||!Number.isSafeInteger(tab.id)||tab.id<0||tab.openerTabId!==context.workTab||context.initialTabs.has(tab.id))return;
      context.tabs.add(tab.id);this.owned.add(tab.id);
      this.operationPhase(this.operationProgress?.phase,context.tabs.size);
      context.persistence=Promise.all([context.persistence,this.api.storage.session.set({bossOwnedTabs:[...this.owned]})]);context.persistence.catch(()=>{});
      if(context.tabs.size>1)context.error=fault('RECIPIENT_UNVERIFIED','本次会话打开了多个岗位标签，未建立绑定');
    });
    this.api.tabs.onRemoved.addListener(id=>{const context=this.conversationPreview;if(context&&(id===context.workTab||context.tabs.has(id)))context.error=fault('DOCUMENT_CHANGED','会话或岗位预览标签已关闭');});
    this.api.tabs.onUpdated.addListener((id,change)=>{const context=this.conversationPreview;if(context&&id===context.workTab&&(change.status==='loading'||change.url&&change.url!==context.meta.url))context.error=fault('DOCUMENT_CHANGED','原会话文档已改变');});
    this.previewHooks=true;
  }
  async clearPreview(context,{preserveBinding=false,restore=true}={}){
    if(this.conversationPreview===context)this.conversationPreview=null;
    if(context.bindStarted&&!preserveBinding){
      this.failedConversationBindings.set(context.workTab,{browserDocumentId:context.browserDocumentId,documentId:context.meta.documentId});
      let timer;
      try{await Promise.race([this.api.tabs.sendMessage(context.workTab,{type:'BOSS_DOM_COMMAND',command:{op:'REVOKE_CONVERSATION_JOB',args:{job:context.job,previewToken:context.token},expectedDocument:{documentId:context.meta.documentId}}},{frameId:0,documentId:context.browserDocumentId}),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}catch{}finally{clearTimeout(timer);}
    }
    await context.persistence.catch(()=>{});
    for(const id of context.tabs){if(!this.owned.has(id))continue;try{await this.api.tabs.remove(id);}catch{}this.owned.delete(id);this.documents.delete(id);}
    await this.api.storage.session.set({bossOwnedTabs:[...this.owned]});
    if(restore&&this.workTab===context.workTab&&this.owned.has(context.workTab))try{await this.api.tabs.update(context.workTab,{active:true});}catch{}
  }
  async startConversationPreview(command){
    this.operationPhase('validate-preview');
    const job=previewJob(command.args);
    if(this.conversationPreview)throw fault('VERIFICATION_PENDING','已有会话岗位预览未完成，未重复点击');
    this.installPreviewHooks();
    const doc=this.documents.get(this.workTab),expected=command.target?.document;
    if(this.bindingBlocked(this.workTab,doc))throw fault('RECIPIENT_UNVERIFIED','本会话先前岗位绑定未获确认，请重新读取岗位详情');
    if(!doc?.browserDocumentId||!doc.documentId||expected?.documentId!==doc.documentId||expected?.url!==doc.url)throw fault('DOCUMENT_CHANGED','会话文档证据缺失或不一致');
    this.operationPhase('query-tabs');const initialTabs=new Set((await this.api.tabs.query({})).map(tab=>tab.id));
    const original=await this.api.tabs.get(this.workTab);
    if(this.documents.get(this.workTab)!==doc||original.url!==doc.url||original.status!=='complete'||command.expiresAt<=Date.now())throw fault('DOCUMENT_CHANGED','原会话尚未准备好或已改变');
    const context={job,commandId:command.id,epoch:command.epoch,workTab:this.workTab,browserDocumentId:doc.browserDocumentId,meta:{url:doc.url,title:doc.title||'',documentId:doc.documentId},token:crypto.randomUUID(),captureExpiresAt:command.expiresAt,initialTabs,tabs:new Set(),permitted:false,persistence:Promise.resolve(),error:null};
    this.conversationPreview=context;this.domCommand=command;
    try{
      this.operationPhase('request-dom');
      const response=await this.api.tabs.sendMessage(context.workTab,{type:'BOSS_DOM_COMMAND',command:{id:command.id,epoch:command.epoch,expiresAt:command.expiresAt,op:command.op,args:{job,previewToken:context.token},expectedDocument:context.meta}},{frameId:0,documentId:context.browserDocumentId});
      if(this.operationProgress?.phase==='request-dom')this.operationPhase('dom-returned');
      if(!context.permitted)throw fault('ACTION_NOT_PERMITTED','岗位预览未取得当前内容文档的动作许可');
      if(!response?.ok)throw fault(response?.error?.code||'UNKNOWN_RESULT',response?.error?.message||'岗位预览未确认');
      if(response.result?.previewStarted!==true||response.result.meta?.documentId!==context.meta.documentId||response.result.meta?.url!==context.meta.url||response.result.previewToken!=null&&response.result.previewToken!==context.token||!this.previewPinMatches(context))throw fault('DOCUMENT_CHANGED','岗位预览的原会话证据已改变');
      this.operationPhase('await-preview',context.tabs.size);return{meta:{...context.meta},previewStarted:true};
    }catch(error){await this.clearPreview(context);throw error;}finally{this.domCommand=null;}
  }
  async readConversationPreview(command){
    this.operationPhase('read-preview',this.conversationPreview?.tabs.size||0);
    const job=previewJob(command.args),context=this.conversationPreview;
    if(!context)throw fault('RECIPIENT_UNVERIFIED','没有本次会话的岗位预览证据');
    try{
      if(!samePreviewJob(job,context.job))throw fault('RECIPIENT_UNVERIFIED','读取岗位与本次会话预览不一致');
      if(context.error)throw context.error;
      if(!this.previewPinMatches(context))throw fault('DOCUMENT_CHANGED','会话文档或任务已改变');
      await context.persistence;
      const original=await this.api.tabs.get(context.workTab);
      if(original.url!==context.meta.url||original.status!=='complete')throw fault('DOCUMENT_CHANGED','原会话网页已改变');
      if(context.tabs.size!==1){if(context.tabs.size>1||Date.now()>=context.captureExpiresAt)throw fault('RECIPIENT_UNVERIFIED','未取得唯一岗位详情页；请检查专用 Chrome 地址栏是否拦截了弹出窗口，处理后再继续');return{meta:{...context.meta},verified:false,pending:true};}
      const tab=await this.api.tabs.get([...context.tabs][0]);
      if(tab.openerTabId!==context.workTab)throw fault('RECIPIENT_UNVERIFIED','岗位预览来源不可确认');
      for(const value of [tab.url,tab.pendingUrl].filter(value=>value&&value!=='about:blank'))if(observedJobUrl(value)!==context.job.url)throw fault('RECIPIENT_UNVERIFIED','浏览器实际岗位地址与目标不一致');
      const canonicalURL=observedJobUrl(tab.url);
      if(tab.status!=='complete'||!canonicalURL)return{meta:{...context.meta},verified:false,pending:true};
      if(command.expiresAt<=Date.now()||!this.previewPinMatches(context)||context.error)throw fault('DOCUMENT_CHANGED','岗位验证回执过期或原会话已改变');
      context.bindStarted=true;
      this.operationPhase('bind-preview',context.tabs.size);
      const response=await this.api.tabs.sendMessage(context.workTab,{type:'BOSS_DOM_COMMAND',command:{id:command.id,epoch:command.epoch,expiresAt:command.expiresAt,op:'BIND_CONVERSATION_JOB',args:{job:context.job,previewToken:context.token,canonicalURL},expectedDocument:context.meta}},{frameId:0,documentId:context.browserDocumentId});
      const actualJobId=new URL(canonicalURL).pathname.match(/\/([^/]+)\.html$/u)[1];
      if(!response?.ok||response.result?.verified!==true||response.result.jobId!==actualJobId)throw fault('RECIPIENT_UNVERIFIED','网页未确认原会话岗位绑定');
      if(command.expiresAt<=Date.now()||!this.previewPinMatches(context)||context.error||response.result.meta?.documentId!==context.meta.documentId||response.result.meta?.url!==context.meta.url)throw fault('DOCUMENT_CHANGED','会话绑定结果已过期或文档已改变');
      await this.clearPreview(context,{preserveBinding:true});return{meta:{...context.meta},verified:true,jobId:actualJobId};
    }catch(error){await this.clearPreview(context);throw error;}
  }
  async ready(id,op='READ_STATUS'){
    const end=Date.now()+10000,epoch=this.epoch;
    const session=()=>{if(this.epoch!==epoch)throw fault('STALE_COMMAND','准备网页时所属任务已改变');if(this.workTab!==id||!this.owned.has(id))throw fault('BROWSER_CLOSED','本任务的工作标签已关闭');};
    while(Date.now()<end){
      session();
      const tab=await this.api.tabs.get(id);
      const loading=['READ_STATUS','INSPECT_PAGE'].includes(op)&&tab.status==='loading'&&this.isBoss(tab.url)&&(!tab.pendingUrl||tab.pendingUrl===tab.url);
      if(tab.status==='complete'||loading){
        if(!this.isBoss(tab.url))throw fault('PAGE_CHANGED','工作标签已离开 BOSS 网页');
        try{const response=await this.api.tabs.sendMessage(id,{type:'BOSS_DOM_COMMAND',command:{op,args:{}}},{frameId:0});
          session();
          if(response?.ok&&response.result?.meta){const doc=this.documents.get(id);
            // A committed, authenticated content document can be usable before
            // unrelated images finish. Never infer readiness from a loading tab
            // alone, or reuse a response from a redirect/replaced document.
            let current=!loading;
            if(loading&&(response.result.ready===true||response.result.risk)&&doc?.browserDocumentId&&this.isBoss(doc.browserSourceUrl)&&doc.documentId===response.result.meta.documentId&&doc.url===response.result.meta.url&&doc.url===tab.url){
              const latest=await this.api.tabs.get(id);session();
              current=this.documents.get(id)===doc&&latest.url===tab.url&&(!latest.pendingUrl||latest.pendingUrl===latest.url);
            }
            if(current){if(doc){if(doc.documentId===response.result.meta.documentId)this.documents.set(id,{...doc,...response.result.meta,browserDocumentId:doc.browserDocumentId,browserSourceUrl:doc.browserSourceUrl});else this.documents.delete(id);}return response.result;}
          }
          if(response?.error)throw fault(response.error.code,response.error.message);
        }catch(error){if(error.code)throw error;}
      }
      await sleep(150);
    }
    throw fault('PAGE_NOT_READY','网页或内容脚本尚未准备好');
  }
  async execute(command){
    if(command.v!==VERSION||!OPS.includes(command.op)||command.epoch!==this.epoch||!Number.isSafeInteger(command.seq)||command.seq<=this.seq||command.expiresAt<=Date.now())throw fault('STALE_COMMAND','指令过期、重复或所属任务已改变');
    this.seq=command.seq;
    if(command.op==='STOP_SESSION'){await this.cleanup();return{stopped:true};}
    if(browserEffects.has(command.op)){const permit=await this.send('/bridge/permit',{id:command.id,epoch:command.epoch});if(!permit.allowed||command.expiresAt<=Date.now())throw fault('STALE_COMMAND','动作许可已撤销');}
    if(command.op==='OPEN_SESSION'){
      const url=bossUrl(command.args?.url||'https://www.zhipin.com/web/user/').href;
      if(!this.workTab){const tab=await this.api.tabs.create({url,active:true});await this.own(tab.id);}return this.ready(this.workTab);
    }
    if(!this.workTab||!this.owned.has(this.workTab))throw fault('BROWSER_CLOSED','本任务的工作标签已关闭');
    if(command.op==='INSPECT_PAGE'){const prior=this.lastOperationDiagnostic;return inspectionDiagnostic(await this.ready(this.workTab,command.op),prior,command);}
    if(command.op==='READ_STATUS')return this.ready(this.workTab,command.op);
    if(command.op==='VERIFY_CONVERSATION_JOB')return this.startConversationPreview(command);
    if(command.op==='READ_CONVERSATION_VERIFICATION')return this.readConversationPreview(command);
    if(command.op==='NAV_SEARCH'){
      if(typeof command.args.query!=='string'||command.args.query.length>200||!/^\d{9}$/u.test(command.args.cityCode))throw fault('INVALID_COMMAND','搜索参数无效');
      const url=new URL('https://www.zhipin.com/web/geek/jobs');url.searchParams.set('city',command.args.cityCode);url.searchParams.set('query',command.args.query);
      this.documents.delete(this.workTab);
      await this.api.tabs.update(this.workTab,{url:url.href,active:true});return{navigationStarted:true,destination:url.href};
    }
    if(command.op==='NAV_JOB'){
      const canonical=jobUrl(command.args.job.url),destination=command.args.job.navigationUrl||canonical;
      if(jobUrl(destination)!==canonical)throw fault('INVALID_COMMAND','详情地址与岗位 ID 不一致');
      this.documents.delete(this.workTab);
      await this.api.tabs.update(this.workTab,{url:destination,active:true});return{navigationStarted:true,destination};
    }
    const workTab=this.workTab,doc=this.documents.get(workTab);
    if(effects.has(command.op)&&this.bindingBlocked(this.workTab,doc))throw fault('RECIPIENT_UNVERIFIED','本会话岗位绑定未获确认，未执行动作');
    if(effects.has(command.op)&&!doc?.browserDocumentId)throw fault('DOCUMENT_CHANGED','当前工作文档尚未绑定，未执行动作');
    this.domCommand=effects.has(command.op)?command:null;
    try{
      const response=await this.api.tabs.sendMessage(workTab,{type:'BOSS_DOM_COMMAND',command:{id:command.id,epoch:command.epoch,expiresAt:command.expiresAt,op:command.op,args:command.args||{},expectedDocument:command.target?.document}},{frameId:0,...(doc?.browserDocumentId?{documentId:doc.browserDocumentId}:{})});
      if(!response?.ok)throw fault(response?.error?.code||'UNKNOWN_RESULT',response?.error?.message||'网页没有返回可核对的结果');
      if(doc&&response.result?.meta){
        if(this.workTab!==workTab||this.documents.get(workTab)!==doc||response.result.meta.documentId!==doc.documentId)throw fault('DOCUMENT_CHANGED','回执的原工作文档已改变，未覆写新文档证据');
        this.documents.set(workTab,{...doc,...response.result.meta,browserDocumentId:doc.browserDocumentId,browserSourceUrl:doc.browserSourceUrl});
      }
      if(['READ_CONVERSATION','READ_RESUME'].includes(command.op)&&this.bindingBlocked(this.workTab,this.documents.get(this.workTab)))return{...response.result,verified:false};
      return response.result;
    }finally{this.domCommand=null;}
  }
  async loop(){
    if(this.running||!this.auth)return;this.running=true;
    try{while(this.auth){
      let packet;try{packet=await this.send('/bridge/commands',{});}catch{await sleep(3000);continue;}
      if(packet.epoch!==this.epoch){await this.cleanup();this.epoch=packet.epoch;this.seq=0;}
      if(!packet.command)continue;
      const command=packet.command;let result,error;
      const startedAt=Date.now();this.operationProgress={op:command.op,phase:'started',previewCapturedCount:0};
      try{result=await this.execute(command);}catch(e){error={code:e.code||'UNKNOWN_RESULT',message:e.message};}
      this.lastOperationDiagnostic=boundedDiagnostic({...this.operationProgress,errorCode:error?.code??null,elapsedMs:Date.now()-startedAt});this.operationProgress=null;
      try{await this.send('/bridge/result',{id:command.id,epoch:command.epoch,...(error?{error}:{result})});}catch{/* Node will preserve unconfirmed intent. */}
    }}finally{this.running=false;}
  }
}
if(typeof chrome!=='undefined'&&chrome.runtime?.id)new BrowserWorker(chrome).bootstrap().catch(()=>{});
