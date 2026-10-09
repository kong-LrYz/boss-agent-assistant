const token = document.querySelector('meta[name="boss-session"]').content;
const $ = id => document.getElementById(id);
const statusNames = { idle:'准备就绪', running:'正在投递', waiting:'持续运行 · 等待下一轮', paused:'已暂停，需要处理', stopped:'已停止', completed:'预览 / 本轮已完成', error:'运行出错' };
const greetingNames = { none:'未联系', intent:'确认中', sent:'已打招呼', existing:'已有沟通', uncertain:'需核对' };
const resumeNames = { none:'未发送', intent:'确认中', requested:'待对方同意', sent:'附件已发送', unavailable:'暂无法发送', uncertain:'需核对' };
let state, formLoaded = false, clientError = '', loginOpening = false, configSaving = false, configPosting = false;
let configVersion = 0, configNeedsSync = false;
let companyGoalsUnconfirmed = false;
let lastPresetRole = 'AI Agent', roleUpdate = Promise.resolve(), titleRuleRole = '';
let catalogSignature = '', rolePresetByKey = new Map();
let presetRemovedExclusions = [], explicitExclusionTerms = new Set();
let pendingAction = '', stopPending = false, stopVersion = 0, reconcilePending = false, formDirty = false, connectionLoaded = false;
function buttonBusy(button, busy, caption) {
  if(!button)return;
  if(!button.dataset.restCaption)button.dataset.restCaption=button.textContent;
  button.setAttribute('aria-label',button.dataset.restCaption);
  if(busy)button.style.width=`${button.getBoundingClientRect().width}px`;else button.style.width='';
  button.classList.toggle('busy',busy);button.setAttribute('aria-busy',String(busy));
  button.textContent=busy&&caption?caption:button.dataset.restCaption;
}
function updateControlAvailability() {
  const runner=state?.runner||{},active=['running','waiting','paused'].includes(runner.status);
  const locked=Boolean(pendingAction)||configSaving||configPosting||stopPending;
  $('start').disabled=active||locked||!state?.config?.setupComplete||companyGoalsUnconfirmed||Boolean(runner.goal?.complete&&((runner.goal.contactTarget||0)>0||(runner.goal.resumeTarget||0)>0));
  $('preview').disabled=active||locked||!state?.config?.setupComplete;
  $('login').disabled=active||locked;$('extension-setup').disabled=locked;
  $('pause').hidden=!['running','waiting'].includes(runner.status);$('pause').disabled=!active||locked;
  $('resume').hidden=runner.status!=='paused';$('resume').disabled=locked||runner.lastError?.code==='NAVIGATION_REVERSED';
  // STOP has its own lane so pending browser/config/start requests remain cancellable.
  $('stop').disabled=stopPending||(!active&&!pendingAction&&!configSaving&&!configPosting);
  $('quit').disabled=locked;
}
async function post(path, body = {}) {
  const response = await fetch(`/api/${path}`, { method:'POST', headers:{ 'Content-Type':'application/json','x-boss-token':token }, body:JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function action(path, body) {
  const stopping=path==='stop';
  if(stopping){if(stopPending)return;stopPending=true;stopVersion++;}
  else if(pendingAction||configSaving||configPosting||stopPending)return;
  if(path==='start'&&companyGoalsUnconfirmed){clientError='公司目标尚未确认保存，请先重新保存设置。';notice(clientError);return;}
  const startedStopVersion=stopVersion;
  if(!stopping)pendingAction=path;
  const opening=path==='login'||path==='extension-setup';
  const button=$(path==='start'&&body?.preview?'preview':path);
  buttonBusy(button,true,opening?'正在打开…':stopping?'停止中':path==='start'?'正在启动…':undefined);
  if(opening){
    loginOpening=true;
  }
  updateControlAvailability();updateFormAvailability();
  try{
    if(path==='extension-setup')await post('stop');
    await post(path,body);
    // A late start/login response must not undo the user's intervening STOP.
    if(!stopping&&startedStopVersion!==stopVersion&&['start','resume','login','extension-setup'].includes(path))await post('stop');
    clientError='';
  }
  catch(error){clientError=error.message;notice(clientError);}
  finally{
    if(opening)loginOpening=false;
    if(stopping)stopPending=false;else pendingAction='';
    buttonBusy(button,false);
    await refresh();
    updateControlAvailability();updateFormAvailability();
  }
}
function cell(text) { const td=document.createElement('td'); td.textContent=text; return td; }
function badge(text, warn, ok) { const td=document.createElement('td'); const span=document.createElement('span'); span.className=`badge ${warn?'warn':ok?'ok':''}`;span.textContent=text;td.append(span);return td; }
function targetRoleKey(value) { return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase(); }
function fillRoleTitleExclusions(role) {
  const rule=(state?.config?.roleTitleExclusions||[]).find(entry=>targetRoleKey(entry.targetRole)===targetRoleKey(role));
  $('config-form').elements.roleTitleExclusionTerms.value=rule?.keywords.join('\n')||'';
  titleRuleRole=targetRoleKey(role);
  $('role-title-exclusion-note').textContent=`仅对“${role}”生效，只匹配职位标题。`;
}
function selectedRole() {
  const form=$('config-form');
  return (form.elements.targetRole.value==='__custom__'?form.elements.customRole.value:form.elements.targetRole.value).trim();
}
function selectedCity() {
  const form=$('config-form');
  return (form.elements.city.value==='__custom__'?form.elements.customCity.value:form.elements.city.value).trim();
}
function ensureChoice(select,value,label=value) {
  if(!value||[...select.options].some(option=>option.value===value))return;
  let group=[...select.children].find(child=>child.tagName==='OPTGROUP'&&child.label==='已保存的自定义');
  if(!group){group=document.createElement('optgroup');group.label='已保存的自定义';select.append(group);}
  const option=document.createElement('option');option.value=value;option.textContent=label;group.append(option);
}
function renderCatalogs(data) {
  const catalogs=data.catalogs||{}, signature=JSON.stringify([catalogs.roleGroups||[],catalogs.cityGroups||[],data.cities||{}]);
  if(signature===catalogSignature)return;
  catalogSignature=signature;
  rolePresetByKey=new Map((catalogs.roleGroups||[]).flatMap(group=>group.options||[]).map(option=>[targetRoleKey(option.targetRole),option]));
  const form=$('config-form'),currentRole=formLoaded?form.elements.targetRole.value:data.config.targetRole||'AI Agent',currentCity=formLoaded?form.elements.city.value:data.config.city||'北京';
  for(const [select,groups,nameKey,value] of [[form.elements.targetRole,catalogs.roleGroups||[{label:'默认',options:[{targetRole:'AI Agent',label:'AI Agent'}]}],'targetRole',currentRole],[form.elements.city,catalogs.cityGroups||[{label:'城市',options:Object.entries(data.cities||{}).map(([name,code])=>({name,code}))}],'name',currentCity]]){
    select.replaceChildren();
    for(const group of groups){const container=document.createElement('optgroup');container.label=group.label;for(const item of group.options||[]){const option=document.createElement('option');option.value=item[nameKey];option.textContent=item.label||item[nameKey];container.append(option);}select.append(container);}
    if(select===form.elements.targetRole)ensureChoice(select,'AI Agent');
    const manual=document.createElement('option');manual.value='__custom__';manual.textContent='自定义…';select.append(manual);
    ensureChoice(select,value);select.value=value;
  }
}
function fillForm(config) {
  const form=$('config-form');
  for(const name of ['targetRole','city'])ensureChoice(form.elements[name],config[name]);
  for(const [key,value] of Object.entries(config)) {
    const field=form.elements.namedItem(key);
    if(field) field.value=Array.isArray(value)?value.join('\n'):String(value);
  }
  form.elements.customRole.value=config.targetRole||'';form.elements.customCity.value=config.city||'';
  formLoaded=true;
  lastPresetRole=config.targetRole||'AI Agent';
  presetRemovedExclusions=[];
  explicitExclusionTerms=new Set((config.excludeKeywords||[]).filter(term=>unblockedRoleTerms(lastPresetRole).includes(term)));
  fillRoleTitleExclusions(lastPresetRole);
  updateCity();updateCustomRole();
  $('settings').open=true;
}
function updateCustomRole() {
  $('custom-role-field').hidden=$('config-form').elements.targetRole.value!=='__custom__';
}
function updateCity() {
  const form=$('config-form'),custom=form.elements.city.value==='__custom__',code=state?.cities?.[selectedCity()];
  $('custom-city-field').hidden=!custom;
  $('city-code-field').hidden=Boolean(code)&&!custom;
  if(code)form.elements.cityCode.value=code;
}
function unblockedRoleTerms(role) {
  return rolePresetByKey.get(targetRoleKey(role))?.allowExcludedKeywords||[];
}
async function updateRoleDefaults() {
  const form=$('config-form'), role=selectedRole();
  if(!role)throw new Error('请选择目标岗位，或填写自定义岗位');
  if(targetRoleKey(role)!==titleRuleRole)fillRoleTitleExclusions(role);
  if(role===lastPresetRole)return;
  const response=await fetch(`/api/role-defaults?role=${encodeURIComponent(role)}`),defaults=await response.json();
  if(role!==selectedRole())return;
  if(!response.ok)throw new Error(defaults.error||'无法更新岗位默认搜索词');
  form.elements.queries.value=defaults.queries.join('\n');
  form.elements.requiredAny.value=defaults.requiredAny.join('\n');
  const allowed=unblockedRoleTerms(role);
  const terms=[...new Set([...form.elements.excludeKeywords.value.split('\n').map(term=>term.trim()).filter(Boolean),...presetRemovedExclusions])];
  presetRemovedExclusions=terms.filter(term=>allowed.includes(term)&&!explicitExclusionTerms.has(term));
  form.elements.excludeKeywords.value=terms.filter(term=>!presetRemovedExclusions.includes(term)).join('\n');
  lastPresetRole=role;
  $('role-note').textContent=`已按“${role}”重设搜索词和匹配词；可继续编辑，也请检查排除规则。`;
}
async function settleRoleUpdates() {
  while(true) {
    const pending=roleUpdate;
    try{await pending;}catch(error){if(pending!==roleUpdate)continue;throw error;}
    if(pending!==roleUpdate)continue;
    const role=selectedRole();
    try{await updateRoleDefaults();}catch(error){if(pending!==roleUpdate||role!==selectedRole())continue;throw error;}
    if(pending===roleUpdate&&role===selectedRole())return;
  }
}
function updateFormAvailability() {
  const active=['running','waiting','paused'].includes(state?.runner?.status);
  for(const field of $('config-form').elements)field.disabled=active||configPosting||Boolean(pendingAction)||stopPending||(configSaving&&(field.type==='submit'||field.hasAttribute('data-speed-profile')));
}
const speedProfiles={efficient:{label:'无额外等待档',delaySeconds:0,contactBatchSize:10,batchBreakMinutes:0,idleMinutes:0},steady:{label:'稳健档',delaySeconds:90,contactBatchSize:5,batchBreakMinutes:10,idleMinutes:10}};
function fillSpeedProfile(key) {
  const profile=speedProfiles[key];
  if(!profile||!formLoaded||configSaving||configPosting||['running','waiting','paused'].includes(state?.runner?.status))return;
  for(const name of ['delaySeconds','contactBatchSize','batchBreakMinutes','idleMinutes'])$('config-form').elements[name].value=String(profile[name]);
  formDirty=true;$('save-feedback').textContent='有未保存的修改';
  $('speed-note').textContent=`已填入${profile.label}：间隔${profile.delaySeconds}秒，每${profile.contactBatchSize}个新岗位休${profile.batchBreakMinutes}分钟，轮次间隔${profile.idleMinutes}分钟。尚未保存。`;
}
function performanceNumber(value) {return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;}
function duration(value) {
  const seconds=Math.floor(performanceNumber(value)/1000);
  if(seconds>=3600)return `${Math.floor(seconds/3600)}时${Math.floor(seconds/60)%60}分`;
  return seconds>=60?`${Math.floor(seconds/60)}分${seconds%60}秒`:`${seconds}秒`;
}
function renderPerformance(performance={}) {
  const count=key=>Math.floor(performanceNumber(performance?.[key]));
  const confirmed=count('verifiedNewContacts'),elapsed=performanceNumber(performance?.elapsedMs);
  $('performance-summary').textContent=`详情检查 ${count('detailReads')} · 预筛跳过 ${count('precheckRejected')} · 已确认新联系 ${confirmed} · 耗时 ${duration(elapsed)} · 节奏等待 ${duration(performance?.waitedMs)}`;
  $('performance-waits').textContent=`联系间隔 ${duration(performance?.contactWaitMs)} · 批次休息 ${duration(performance?.batchWaitMs)} · 轮次等待 ${duration(performance?.idleWaitMs)}`;
  const rate=performance?.confirmedPerHour;
  $('performance-rate').textContent=confirmed<5||elapsed<=0?'样本不足（至少5个已确认新联系）':typeof rate==='number'&&Number.isFinite(rate)&&rate>=0?`${rate.toFixed(1)}个/小时（本次，含等待）`:'速率待统计';
}
function goalNumber(value) {return Number.isSafeInteger(value)&&value>=0?value:0;}
function renderGoal(goal,config) {
  const contactTarget=goalNumber(goal?.contactTarget??config.contactCompanyTarget),resumeTarget=goalNumber(goal?.resumeTarget??config.resumeCompanyTarget);
  const contacted=goalNumber(goal?.contactedCompanies),delivered=goalNumber(goal?.deliveredCompanies);
  const complete=(contactTarget>0||resumeTarget>0)&&goal?.complete===true;
  const contactReached=contactTarget>0&&goal?.contactReached===true,resumeReached=resumeTarget>0&&goal?.resumeReached===true;
  $('goal-contact').textContent=`打招呼公司 ${contacted} / ${contactTarget||'不限'}${contactReached?' · 已达到':''}`;
  $('goal-resume').textContent=`附件送达公司 ${delivered} / ${resumeTarget||'不限'}${resumeReached?' · 已达到':''}`;
  $('goal-summary').textContent=contactTarget&&resumeTarget?`目标：确认打招呼${contactTarget}家公司、附件送达${resumeTarget}家公司；两项目标全部达到后停止。`:contactTarget?`目标：确认打招呼${contactTarget}家公司，达到后停止；附件数量不设目标。`:resumeTarget?`目标：附件送达${resumeTarget}家公司，达到后停止；打招呼数量不设目标。`:'未设置数量目标，持续至你停止。';
  let status='目标进行中',note='按设置继续处理；单项先达到时停止该项新增操作，全部设定目标达到后任务会停止。';
  if(!contactTarget&&!resumeTarget){status='不限数量';note='未设置数量目标，持续至你停止。';}
  else if(complete){status='目标已完成';note='已满足设定的公司目标，任务会停止。';}
  else if(contactReached&&resumeTarget){status='继续待发附件';note='打招呼目标已达到：停止新增招呼，继续处理已有沟通的待发附件。';}
  else if(resumeReached&&contactTarget){status='继续打招呼';note='附件目标已达到：停止新增附件，继续处理打招呼目标。';}
  $('goal-status').textContent=status;$('goal-note').textContent=note;
  return complete;
}
function renderJobs() {
  const filter=$('filter').value;
  const jobs=state.jobs.filter(j=>filter==='all'||(filter==='eligible'&&j.eligible)||(filter==='sent'&&j.resumeStatus==='sent')||(filter==='requested'&&j.resumeStatus==='requested')||(filter==='uncertain'&&(j.resumeStatus==='uncertain'||j.greetingStatus==='uncertain'))).slice().reverse();
  $('jobs').replaceChildren();
  if(!jobs.length) { const tr=document.createElement('tr'); const td=cell('暂时没有记录。');td.colSpan=5;td.className='empty';tr.append(td);$('jobs').append(tr);return; }
  for(const j of jobs) {
    const tr=document.createElement('tr'), first=document.createElement('td'), link=document.createElement('a');
    try { const u=new URL(j.url); if(u.protocol==='https:'&&u.hostname==='www.zhipin.com')link.href=u.href; }catch{}
    link.target='_blank';link.rel='noopener noreferrer';link.textContent=j.title||'待读取岗位';first.append(link);
    const company=document.createElement('div');company.className='company';company.textContent=`${j.company||''} · ${j.city||'地区未知'}`;first.append(company);
    const last=cell(j.note||j.reasons?.join('；')||'');
    if(j.greetingStatus==='uncertain'||j.resumeStatus==='uncertain') { const button=document.createElement('button');button.className='mini';button.textContent='核对结果';button.onclick=()=>{
      $('reconcile-key').value=j.key;$('reconcile-greeting').value=j.greetingStatus==='existing'?'existing':'sent';$('reconcile-resume').value='requested';$('reconcile-dialog').showModal();
    };last.append(document.createElement('br'),button); }
    tr.append(first,badge(j.eligible?'符合':'不符合',false,j.eligible),badge(greetingNames[j.greetingStatus]||j.greetingStatus,j.greetingStatus==='uncertain',j.greetingStatus==='sent'),badge(resumeNames[j.resumeStatus]||j.resumeStatus,['uncertain','requested'].includes(j.resumeStatus),j.resumeStatus==='sent'),last);$('jobs').append(tr);
  }
}
function render(data) {
  state=data;const r=data.runner;
  const ext=data.extension;$('extension-panel').hidden=!ext;
  if(ext){$('extension-status').textContent=ext.connected?'已连接':ext.paired?'已配对，等待浏览器':'首次使用，安装并配对';$('extension-directory').value=ext.directory||'';$('pairing-code').value=ext.pairingCode||'';$('pairing-area').hidden=ext.paired;if(!connectionLoaded){$('extension-panel').open=!ext.paired;connectionLoaded=true;}}
  $('target-role-label').textContent=data.config.targetRole||'AI Agent';
  $('target-city-label').textContent=data.config.city||'北京';
  const goalComplete=renderGoal(r.goal,data.config);
  renderCatalogs(data);
  $('status').textContent=r.mode==='preview'&&r.status==='running'?'正在预览岗位':r.status==='completed'&&r.mode!=='preview'&&goalComplete?'公司目标已完成':statusNames[r.status]||r.status;$('status-dot').className=`dot ${r.status}`;$('cycle').textContent=`第 ${r.cycle||0} 轮`;
  $('current').textContent=r.currentJob?`${r.currentJob.company} · ${r.currentJob.title}`:r.nextScanAt?`下一轮：${new Date(r.nextScanAt).toLocaleTimeString('zh-CN')}`:data.config.setupComplete?`${data.config.city} · ${data.config.targetRole||'AI Agent'}`:'首次使用，先保存求职设置。';
  const active=['running','waiting','paused'].includes(r.status);
  const navigationReversed=r.lastError?.code==='NAVIGATION_REVERSED';
  updateControlAvailability();
  if(r.lastError)notice(`${r.lastError.message}。${r.status==='paused'?navigationReversed?'请点击“停止”，当前自动控制方式需要调整，已禁止继续重试。':'处理后点击“继续”；结果不确定的记录会跳过，可停止后手动核对。':r.lastError.code==='LOGIN_REQUIRED'?'完成登录后点击开始。':'任务已停止，请先核对专用浏览器页面和运行日志。'}`);
  else notice(clientError);
  for(const key of ['discovered','eligible','contacted','requested','delivered'])$(`m-${key}`).textContent=r.counts?.[key]||0;
  renderPerformance(r.performance);
  if(!formLoaded)fillForm(data.config);
  updateFormAvailability();
  renderJobs();$('events').replaceChildren();
  for(const event of data.events) { const li=document.createElement('li'),time=document.createElement('time');time.textContent=new Date(event.at).toLocaleTimeString('zh-CN');li.append(time,document.createTextNode(event.message||event.type||''));$('events').append(li); }
}
async function refresh() {
  const version=configVersion;
  try{
    const response=await fetch('/api/status');if(!response.ok)throw new Error('连接失败');
    const data=await response.json();
    if(version!==configVersion)return false;
    render(data);configNeedsSync=false;return true;
  }catch{if(version===configVersion)notice('本地程序已断开连接。重新双击“启动.command”恢复。');return false;}
}
$('start').onclick=()=>{if(pendingAction||configSaving||configPosting||stopPending)return;if(formDirty)$('config-form').requestSubmit($('config-form').querySelector('button[value="start"]'));else action('start');};$('login').onclick=()=>action('login');$('preview').onclick=()=>action('start',{preview:true});$('pause').onclick=()=>action('pause');$('resume').onclick=()=>action('resume');$('stop').onclick=()=>action('stop');
$('extension-setup').onclick=()=>action('extension-setup');
for(const [button,field] of [['copy-extension-directory','extension-directory'],['copy-pairing-code','pairing-code']])$(button).onclick=async()=>{try{await navigator.clipboard.writeText($(field).value);notice('已复制，请粘贴到专用 Chrome。');}catch{$(field).focus();$(field).select();notice('请按 Ctrl+C 或 Command+C 复制选中内容。');}};
$('quit').onclick=async()=>{if(pendingAction||configSaving||configPosting||stopPending)return;pendingAction='shutdown';buttonBusy($('quit'),true,'退出中');updateControlAvailability();try{await post('shutdown');notice('程序已退出，可以关闭此页面。');$('status').textContent='已退出';}catch(error){notice(error.message);}finally{pendingAction='';buttonBusy($('quit'),false);updateControlAvailability();}};
$('filter').onchange=renderJobs;
$('settings-open').onclick=()=>{$('settings').open=true;$('settings').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});const field=$('config-form').elements.targetRole;if(!field.disabled)field.focus({preventScroll:true});};
$('config-form').oninput=event=>{
  formDirty=true;$('save-feedback').textContent='有未保存的修改';
  if(event.target===$('config-form').elements.excludeKeywords){
    const terms=event.target.value.split('\n').map(term=>term.trim()).filter(Boolean),allowed=unblockedRoleTerms(selectedRole());
    for(const term of explicitExclusionTerms)if(!terms.includes(term))explicitExclusionTerms.delete(term);
    for(const term of terms)if(allowed.includes(term))explicitExclusionTerms.add(term);
  }
};
$('config-form').elements.city.onchange=()=>{updateCity();if($('config-form').elements.city.value==='__custom__'){$('advanced-settings').open=true;$('config-form').elements.customCity.focus();}};
$('config-form').elements.customCity.oninput=updateCity;
for(const button of document.querySelectorAll('[data-speed-profile]'))button.onclick=()=>fillSpeedProfile(button.dataset.speedProfile);
function requestRoleDefaults(){const pending=updateRoleDefaults();roleUpdate=pending;pending.catch(error=>{if(pending!==roleUpdate)return;clientError=error.message;notice(clientError);});}
$('config-form').elements.targetRole.onchange=()=>{updateCustomRole();if($('config-form').elements.targetRole.value==='__custom__'){$('advanced-settings').open=true;$('config-form').elements.customRole.focus();return;}requestRoleDefaults();};
$('config-form').elements.customRole.onchange=()=>{if(selectedRole())requestRoleDefaults();};
$('config-form').onsubmit=async event=>{
  event.preventDefault();
  if(configSaving||pendingAction||stopPending||['running','waiting','paused'].includes(state?.runner?.status))return;
  const startedStopVersion=stopVersion;
  configSaving=true;buttonBusy(event.submitter,true,'保存中');updateFormAvailability();updateControlAvailability();$('save-feedback').textContent='正在保存…';
  try {
    if(configNeedsSync&&!await refresh())throw new Error('上次设置已保存，但页面尚未同步最新配置。请恢复本地连接后再次保存。');
    await settleRoleUpdates();
    const form=new FormData(event.target), config={};
    for(const [key,value] of form.entries()){
      if(['roleTitleExclusionTerms','customRole','customCity'].includes(key))continue;
      if(['contactCompanyTarget','resumeCompanyTarget'].includes(key)){
        const number=Number(value);if(!String(value).trim()||!Number.isSafeInteger(number)||number<0)throw new Error('公司目标必须填写0或非负安全整数');config[key]=number;
      }else config[key]=['queries','requiredAny','excludeKeywords','excludeCompanies'].includes(key)?value.split('\n').map(x=>x.trim()).filter(Boolean):['delaySeconds','maxPages','idleMinutes','contactBatchSize','batchBreakMinutes'].includes(key)?Number(value):key==='autoRun'?value==='true':value;
    }
    config.targetRole=selectedRole();config.city=selectedCity();
    const currentRole=config.targetRole.trim(), currentKey=targetRoleKey(currentRole);
    const titleTerms=String(form.get('roleTitleExclusionTerms')||'').split('\n').map(value=>value.trim()).filter(Boolean);
    config.roleTitleExclusions=(state?.config?.roleTitleExclusions||[]).filter(entry=>targetRoleKey(entry.targetRole)!==currentKey);
    if(titleTerms.length)config.roleTitleExclusions.push({targetRole:currentRole,keywords:titleTerms});
    // Company goals control total progress; legacy daily/run caps stay disabled.
    config.dailyLimit=0;config.runLimit=0;config.companyDedup=false;
    configPosting=true;updateFormAvailability();
    companyGoalsUnconfirmed=config.contactCompanyTarget>0||config.resumeCompanyTarget>0;
    await post('config',config);configVersion++;configNeedsSync=true;
    if(companyGoalsUnconfirmed){
      if(!await refresh())throw new Error('公司目标尚未确认保存，请恢复连接并重新保存设置。');
      if(['contactCompanyTarget','resumeCompanyTarget'].some(key=>state.config[key]!==config[key]))throw new Error('公司目标未确认保存，请更新并重新启动本地程序后再保存设置。');
      companyGoalsUnconfirmed=false;
    }
    for(const name of ['targetRole','city']){ensureChoice(event.target.elements[name],config[name]);event.target.elements[name].value=config[name];}
    updateCustomRole();updateCity();
    formDirty=false;$('settings').open=true;
    if(event.submitter?.value==='start'&&startedStopVersion===stopVersion){await post('start');if(startedStopVersion!==stopVersion)await post('stop');}
    $('save-feedback').textContent=startedStopVersion===stopVersion?'已保存':'已保存，投递已停止';clientError='';await refresh();
  } catch(error){clientError=error.message;notice(clientError);$('save-feedback').textContent='保存未完成';}
  finally{configSaving=false;configPosting=false;buttonBusy(event.submitter,false);updateFormAvailability();updateControlAvailability();}
};
$('reconcile-save').onclick=async()=>{if(reconcilePending)return;reconcilePending=true;$('reconcile-save').disabled=true;buttonBusy($('reconcile-save'),true,'保存中');try{await post('reconcile',{key:$('reconcile-key').value,greetingStatus:$('reconcile-greeting').value,resumeStatus:$('reconcile-resume').value});$('reconcile-dialog').close();clientError='';await refresh();}catch(error){clientError=error.message;notice(clientError);}finally{reconcilePending=false;buttonBusy($('reconcile-save'),false);$('reconcile-save').disabled=false;}};
const lease=new EventSource(`/api/lease?token=${encodeURIComponent(token)}`);
lease.onerror=()=>{};
refresh();post('heartbeat').catch(()=>{});
setInterval(refresh,2000);setInterval(()=>post('heartbeat').catch(()=>{}),5000);
