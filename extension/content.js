(function () {
  'use strict';
  if (window.top !== window || !globalThis.chrome?.runtime?.onMessage || !globalThis.BossDomExecutor || globalThis.BossContentRegistered) return;
  Object.defineProperty(globalThis,'BossContentRegistered',{value:true,writable:false,configurable:false});
  const effects=new Set(['NEXT_PAGE','OPEN_CONTACT','DISMISS_CONTACT_CONFIRMATION','VERIFY_CONVERSATION_JOB','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME']);
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
  async function announceReady() {
    try {
      if(typeof chrome.runtime.sendMessage==='function')await chrome.runtime.sendMessage({type:'BOSS_CONTENT_READY',meta:BossDomExecutor.metadata()});
    } catch { /* No active background receiver; read-only inspection remains available. */ }
  }
  function validateEffect(command) {
    if(!Number.isFinite(command.expiresAt)||command.expiresAt<=Date.now())fail('STALE_COMMAND','动作已过期或没有有效截止时间');
    const meta=BossDomExecutor.metadata(),expected=command.expectedDocument;
    const id=typeof expected==='string'?expected:expected?.documentId;
    if(id!==meta.documentId||(typeof expected==='object'&&expected.url&&expected.url!==meta.url))fail('DOCUMENT_CHANGED','当前文档已改变，未执行操作');
    if(typeof command.id!=='string'||!command.id||typeof command.epoch!=='string'||!command.epoch)fail('COMMAND_INVALID','动作 ID 或任务标识缺失');
  }
  async function receive(command) {
    if(command?.op==='READ_STATUS'||command?.op==='INSPECT_PAGE')await announceReady();
    if(effects.has(command?.op)) {
      validateEffect(command);
      const permit=await chrome.runtime.sendMessage({type:'BOSS_ACTION_PERMIT',id:command.id,epoch:command.epoch,expiresAt:command.expiresAt});
      if(permit?.ok!==true||permit.allowed!==true)fail('ACTION_NOT_PERMITTED','动作许可已拒绝或撤销，未执行操作');
      validateEffect(command);
    }
    return BossDomExecutor.execute(command);
  }
  chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'BOSS_DOM_COMMAND') return false;
    Promise.resolve().then(()=>receive(message.command)).then(result=>sendResponse({ok:true,result})).catch(error=>sendResponse({ok:false,error:{code:error.code??'DOM_ERROR',message:String(error.message??error)},meta:BossDomExecutor.metadata()}));
    return true;
  });
  void announceReady();
})();
