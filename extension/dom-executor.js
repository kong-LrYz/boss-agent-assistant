(function () {
  'use strict';
  if (globalThis.BossDomExecutor) return;
  const documentId = crypto.randomUUID();
  const OPS = new Set(['READ_STATUS','INSPECT_PAGE','READ_CARDS','READ_DETAIL','READ_CONVERSATION','READ_RESUME','READ_CONTACT_CONFIRMATION','NEXT_PAGE','OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME','DISMISS_CONTACT_CONFIRMATION','VERIFY_CONVERSATION_JOB','BIND_CONVERSATION_JOB','REVOKE_CONVERSATION_JOB']);
  const EFFECTS = new Set(['NEXT_PAGE','OPEN_CONTACT','FILL_GREETING','SEND_GREETING','REQUEST_RESUME','SELECT_RESUME','CONFIRM_RESUME','DISMISS_CONTACT_CONFIRMATION','VERIFY_CONVERSATION_JOB']);
  const S = Object.freeze({
    cards: '.job-card-wrapper, .job-card-box', cardTitle: '.job-name, .job-title', cardCompany: '.company-name, .company-info h3', cardCity: '.job-area, .job-location, .text-city, .company-location', city: '.job-area, .job-location, .text-city', tags: '.tag-list li, .job-tags span',
    detail: '.job-detail, .job-banner, .job-primary', detailTitle: 'h1, .job-name, .job-title', detailCompany: '.company-name, .company-info .name', description: '.job-sec-text, .job-description, .description',
    contact: '.job-detail .op, .job-banner .op, .job-primary .op', next: '.options-pages .next, .page-next, a.next, button.next',
    chats: '.chat-window, .chat-container, .conversation-window', header: '.chat-header, .conversation-header', chatTitle: '.job-title, .job-name', chatCompany: '.company-name',
    messages: '.message-item, .chat-message', outgoing: '.message-item.sent, .message-item.is-self, .message-item.item-myself, .message-item.message-right', attachment: '.resume-attachment, .attachment-resume, .resume-card, .resume-file',
    empty: '.chat-empty, .conversation-empty, .new-conversation', editor: '.chat-editor textarea, .chat-editor [contenteditable="true"], .chat-input textarea, .chat-input [contenteditable="true"]', actions: '.chat-editor, .chat-input, .chat-tool',
    dialogs: '.resume-dialog, .resume-selection-dialog, [role="dialog"]', options: '.resume-item, .resume-option, [role="radio"]', optionName: '.resume-name, .file-name, .attachment-name',
    captcha: '.verify-dialog, .captcha-dialog, .geetest_panel, .geetest_holder, .security-check, .page-verify, .verify-container', login: '.login-dialog, .login-sign, .sign-wrap, .login-panel, .login-register-content', account: '.nav-figure .label-text, .nav-figure .user-name, .user-nav .user-name, .header-user .user-name'
  });
  const clean = value => String(value ?? '').replace(/\s+/gu,' ').trim();
  const clipped = value => clean(value).slice(0,160);
  const marker = element => ({tag:element.tagName.toLowerCase().slice(0,32),classes:clipped(element.getAttribute('class'))});
  const same = (a,b) => clean(a) !== '' && clean(a) === clean(b);
  const metadata = () => ({url:location.href,title:document.title,documentId});
  function fail(code,message) { const error=new Error(`${code}: ${message}`);error.code=code;throw error; }
  function visible(element) {
    if (!element?.isConnected) return false;
    const style=getComputedStyle(element);const box=element.getBoundingClientRect();
    return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&box.width>0&&box.height>0;
  }
  const all = (scope,selector) => [...scope.querySelectorAll(selector)].filter(visible);
  const text = element => clean(element?.innerText ?? element?.textContent ?? '');
  function uniqueText(scope,selector) {
    const elements=all(scope,selector).filter(element=>!all(element,selector).length);
    const values=[...new Set(elements.map(text).filter(Boolean))];return values.length===1?values[0]:'';
  }
  function titleText(scope,selector) {
    const headings=all(scope,'h1');if(headings.length===1)return text(headings[0]);
    const candidates=all(scope,selector).filter(element=>!all(element,selector).length);
    const values=candidates.map(element=>{const copy=element.cloneNode(true);copy.querySelectorAll('.salary, .salary-box, .job-salary').forEach(node=>node.remove());return clean(copy.textContent);}).filter(Boolean);
    const unique=[...new Set(values)];return unique.length===1?unique[0]:'';
  }
  function safeJobUrl(value) {
    try {const url=new URL(value,location.href);if(url.protocol!=='https:'||url.hostname!=='www.zhipin.com'||url.username||url.password||!/^\/job_detail\/[A-Za-z0-9_-]+\.html$/u.test(url.pathname))return null;return {id:url.pathname.match(/\/([^/]+)\.html$/u)[1],url:url.origin+url.pathname,navigationUrl:url.href};}catch{return null;}
  }
  function officialUrl(value) {try{const url=new URL(value,location.href);return url.origin==='https://www.zhipin.com'&&!url.username&&!url.password?url:null;}catch{return null;}}
  function gongsiUrl(value) {const url=officialUrl(value);return url&&/^\/gongsi\/[A-Za-z0-9_~-]+\.html$/u.test(url.pathname)?url:null;}
  function companyUrl(element) {const url=officialUrl(element.href);const canonical=url?url.origin+url.pathname:null;return url&&/^\/(?:gongsi|company)(?:\/|$)/u.test(url.pathname)&&canonical.length<=2048?canonical:null;}
  function ancestors(element) {const result=[];for(let parent=element.parentElement;parent&&result.length<3;parent=parent.parentElement)result.push(marker(parent));return result;}
  function cardCompanyText(card) {
    const candidates=all(card,S.cardCompany).filter(element=>!all(element,S.cardCompany).length);
    for(const anchor of all(card,'a.boss-info[href]')) {
      if(!gongsiUrl(anchor.href))continue;
      candidates.push(...all(anchor,'.boss-name').filter(element=>!all(element,'.boss-name').length));
    }
    const values=[...new Set(candidates.map(text).filter(Boolean))];return values.length===1?values[0]:'';
  }
  function detailCompanyText(scope) {
    const candidates=scope===document?[]:all(scope,S.detailCompany).filter(element=>!all(element,S.detailCompany).length);
    for(const sidebar of all(document,'.sider-company')) {
      candidates.push(...all(sidebar,S.detailCompany).filter(element=>!all(element,S.detailCompany).length));
      candidates.push(...all(sidebar,'.company-info a[href]').filter(anchor=>gongsiUrl(anchor.href)&&text(anchor)));
    }
    const values=[...new Set(candidates.map(text).filter(Boolean))];return values.length===1?values[0]:'';
  }
  function expectedJob(value) {
    const url=safeJobUrl(value?.url);if(!url||!same(url.id,value?.id??url.id)||!clean(value?.title)||!clean(value?.company))fail('RECIPIENT_UNVERIFIED','岗位 ID、名称和公司必须明确');
    return {...value,...url,title:clean(value.title),company:clean(value.company)};
  }
  function named(scope,pattern) {return all(scope,'button, a, [role="button"]').filter(element=>pattern.test(text(element)));}
  function one(elements,code,message) {if(elements.length!==1)fail(code,message);return elements[0];}
  function risk() {
    const body=text(document.body);
    if (/\/web\/passport\/zp\/verify|\/web\/geek\/safe-validate/u.test(location.pathname)||all(document,S.captcha).length||/请完成安全验证|拖动.{0,10}(?:滑块|拼图)/u.test(body))return {code:'CAPTCHA',message:'网页要求安全验证，请手动完成'};
    if(/(?:操作|访问|沟通|发送)(?:过于|太)?频繁|今日(?:沟通|招呼).{0,12}(?:上限|用完)|账号.{0,10}(?:受限|异常)/u.test(body))return {code:'RATE_LIMIT',message:'网页显示频率或账号限制，请手动处理'};
    const account=uniqueText(document,S.account);const positiveAccount=Boolean(account)&&!/登录|注册/u.test(account);
    if(all(document,S.login).length)return {code:'LOGIN_REQUIRED',message:'请在普通浏览器手动登录'};
    if(/\/web\/user\//u.test(location.pathname)&&!positiveAccount)return {code:'LOGIN_REQUIRED',message:'登录入口的账号标记尚未显示',authPending:true};
    return null;
  }
  function requireDocument(expected) {
    const id=typeof expected==='string'?expected:expected?.documentId;
    if(id!==documentId||(typeof expected==='object'&&expected.url&&expected.url!==location.href))fail('DOCUMENT_CHANGED','文档或页面地址已改变，未执行操作');
  }
  function requireEffect(command) {
    if(!Number.isFinite(command.expiresAt)||command.expiresAt<=Date.now())fail('STALE_COMMAND','动作已过期或没有有效截止时间，未执行操作');
    requireDocument(command.expectedDocument);
  }
  function cardData() {
    const jobs=[];const seen=new Set();
    for(const card of all(document,S.cards)){
      const links=all(card,'a[href]').map(link=>safeJobUrl(link.href)).filter(Boolean);const canonical=[...new Set(links.map(link=>link.url))];
      if(canonical.length!==1)continue;const link=links.find(link=>link.url===canonical[0]);const title=titleText(card,S.cardTitle);const company=cardCompanyText(card);
      if(!title||!company||seen.has(link.id))continue;seen.add(link.id);jobs.push({...link,title,company,city:uniqueText(card,S.cardCity),tags:all(card,S.tags).map(text),description:''});
    }
    const next=all(document,S.next);const button=next.length===1?next[0]:null;const disabled=!button||button.disabled||button.getAttribute('aria-disabled')==='true'||/disabled/u.test(button.className);
    return {jobs,empty:jobs.length===0&&/没有找到|暂无相关|暂无职位/u.test(text(document.body)),next:{available:Boolean(button),disabled:Boolean(disabled)},signature:JSON.stringify(jobs.map(job=>[job.id,job.title,job.company]))};
  }
  function cardObservations() {
    const companyLeaves='[class*="company"], [class*="boss"], [class*="brand"]';
    const encoder=new TextEncoder();let companyBudget=8192;
    function companyCandidates(card) {
      const links=all(card,'a[href]').filter(anchor=>companyUrl(anchor));
      const leaves=all(card,companyLeaves).filter(element=>!all(element,companyLeaves).length);
      const result=[];
      for(const element of new Set([...links,...leaves])) {
        if(element.matches('input, textarea, select, option')||element.querySelector('input, textarea, select'))continue;
        const ancestor=element.closest('a[href]');if(ancestor&&!officialUrl(ancestor.href))continue;
        const candidate={...marker(element),text:clipped(text(element)),ariaLabel:clipped(element.getAttribute('aria-label')),title:clipped(element.getAttribute('title'))};
        const url=element.matches('a[href]')?companyUrl(element):null;if(url)candidate.url=url;
        const cost=encoder.encode(JSON.stringify(candidate)).length;if(cost>companyBudget)continue;
        companyBudget-=cost;result.push(candidate);if(result.length===8)break;
      }
      return result;
    }
    const cards=all(document,S.cards);
    const sample=cards.slice(0,8).map(card=>({...marker(card),selfJobLink:card.matches('a[href]')&&Boolean(safeJobUrl(card.href)),insideCanonicalLinkCount:all(card,'a[href]').filter(link=>safeJobUrl(link.href)).length,titleText:clipped(titleText(card,S.cardTitle)),companyText:clipped(cardCompanyText(card)),companyCandidates:companyCandidates(card)}));
    const jobLinks=[];
    for(const anchor of all(document,'a[href]')) {
      const link=safeJobUrl(anchor.href);if(!link||link.url.length>2048)continue;
      jobLinks.push({...marker(anchor),text:clipped(text(anchor)),jobURL:link.url,ancestors:ancestors(anchor)});if(jobLinks.length===8)break;
    }
    return {cardCount:cards.length,sample,jobLinks};
  }
  function detailObservations() {
    const result={scopes:[],headings:[],companyLinks:[],locations:[],descriptions:[],sections:[],contactScopes:[],contactControls:[],confirmationStructure:[]};
    if(!/^\/job_detail\/[A-Za-z0-9_-]+\.html$/u.test(location.pathname))return result;
    const safe=element=>!element.closest('form, input, textarea, select, option')&&!element.querySelector('input, textarea, select, option');
    const leaves=(scope,selector)=>all(scope,selector).filter(element=>safe(element)&&!all(element,selector).length);
    function observedText(scope,selector,heading=false) {
      const headings=heading?all(scope,'h1').filter(safe):[];
      if(headings.length===1)return text(headings[0]);
      const values=[...new Set(leaves(scope,selector).map(element=>{
        if(!heading)return text(element);
        const copy=element.cloneNode(true);copy.querySelectorAll('.salary, .salary-box, .job-salary').forEach(node=>node.remove());return clean(copy.textContent);
      }).filter(Boolean))];return values.length===1?values[0]:'';
    }
    function contactVisible(element) {
      if(!visible(element))return false;
      for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;}
      return true;
    }
    function contactSafe(element) {
      if(!safe(element)||!contactVisible(element))return false;
      const control=element.closest('button,a,[role="button"]');if(control&&!safe(control))return false;
      const anchors=[element.closest('a[href]'),...element.querySelectorAll('a[href]')].filter(Boolean);
      return anchors.every(anchor=>officialUrl(anchor.href)||/^javascript:\s*(?:void\(\s*0\s*\)\s*;?|;)\s*$/iu.test(anchor.getAttribute('href')||''));
    }
    function contactCaption(element) {
      const caption=text(element);if(!/^(?:立即沟通|继续沟通|沟通)$/u.test(caption))return false;
      const parts=[];
      const collect=node=>{if(node.nodeType===Node.TEXT_NODE){parts.push(node.textContent);return;}if(node.nodeType!==Node.ELEMENT_NODE||!contactSafe(node))return;for(const child of node.childNodes)collect(child);};
      collect(element);return clean(parts.join(''))===caption;
    }
    const matches=all(document,'a,button,[role="button"],div,span').filter(contactSafe).filter(contactCaption);
    const controls=matches.filter(element=>!matches.some(child=>child!==element&&element.contains(child)));
    const contactScopes=all(document,'.op').filter(contactSafe);
    function nearestDetail(element) {
      const scope=element.closest(S.detail);if(!scope)return null;
      const titles=[...new Set(all(scope,'h1').filter(contactSafe).map(text).filter(Boolean))];
      return {...marker(scope),titleText:titles.length===1?clipped(titles[0]):''};
    }
    result.contactControls=controls.slice(0,8).map(element=>({...marker(element),text:clipped(text(element)),ancestors:ancestors(element),nearestDetail:nearestDetail(element)}));
    result.contactScopes=contactScopes.slice(0,8).map(scope=>{const captions=controls.filter(element=>scope.contains(element));return {...marker(scope),text:clipped(captions.map(text).join(' | ')),contactControlCount:captions.length,ancestors:ancestors(scope),nearestDetail:nearestDetail(scope)};});
    result.scopes=all(document,S.detail).filter(element=>!element.closest('form')).slice(0,4).map(scope=>({...marker(scope),dataJobId:clean(scope.getAttribute('data-job-id')).slice(0,128),titleText:clipped(observedText(scope,S.detailTitle,true)),companyText:clipped(observedText(scope,S.detailCompany)),cityText:clipped(observedText(scope,S.city)),descriptionChars:observedText(scope,S.description).length,contactScopeCount:contactScopes.filter(element=>scope.contains(element)).length}));
    result.headings=all(document,'h1').filter(safe).slice(0,4).map(element=>({...marker(element),text:clipped(text(element)),ancestors:ancestors(element)}));
    result.companyLinks=all(document,'a[href]').filter(element=>safe(element)&&companyUrl(element)).slice(0,8).map(element=>({...marker(element),text:clipped(text(element)),url:companyUrl(element),ancestors:ancestors(element)}));
    const locationLeaves='[class*="city"], [class*="location"], [class*="address"]';
    result.locations=leaves(document,locationLeaves).filter(element=>{const anchor=element.closest('a[href]');return !anchor||officialUrl(anchor.href);}).slice(0,8).map(element=>({...marker(element),text:clipped(text(element))}));
    const sectionSelector='.job-detail-section, div.detail-section';
    const sectionHeading=section=>section?clean(all(section,'h2, h3').filter(element=>safe(element)&&element.closest(sectionSelector)===section).map(text).join(' | ')).slice(0,80):'';
    result.descriptions=all(document,S.description).filter(safe).slice(0,8).map(element=>({...marker(element),text:clean(text(element)).slice(0,120),ancestors:ancestors(element),heading:sectionHeading(element.closest(sectionSelector))}));
    result.sections=all(document,sectionSelector).filter(element=>!element.closest('form, input, textarea, select, option')).slice(0,8).map(element=>({...marker(element),heading:sectionHeading(element),descriptionCount:all(element,S.description).filter(safe).length}));
    const structureAncestors=element=>{const values=[];for(let parent=element.parentElement;parent&&values.length<2;parent=parent.parentElement)values.push(marker(parent));return values;};
    function structureSummary(element) {
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let length=0;const short=[];
      for(let node=walker.nextNode();node;node=walker.nextNode())if(node.parentElement&&contactVisible(node.parentElement)&&!node.parentElement.closest('form,input,textarea,select,option')){length+=node.length;if(length<=12)short.push(node.data);else short.length=0;}
      const caption=length<=12?clean(short.join('')):'';
      return {textLength:length,...(/^(?:已发送|失败|发送中)$/u.test(caption)?{strictStatusText:caption}:{})};
    }
    const encoder=new TextEncoder();let structureBudget=8190;
    for(const dialog of all(document,'.dialog-wrap.startchat-dialog > .dialog-container').filter(contactVisible).filter(element=>!element.closest('form')).slice(0,2)){
      const headerNodes=all(dialog,'h1,h2,h3,h4,h5,h6,.title').filter(element=>safe(element)&&contactVisible(element)&&!element.closest('.message-list,.message-item')).slice(0,6).map(element=>({...marker(element),textLength:structureSummary(element).textLength,directChildren:[...element.children].filter(child=>safe(child)&&contactVisible(child)).slice(0,6).map(child=>({...marker(child),textLength:structureSummary(child).textLength}))}));
      const candidate={...marker(dialog),header:{name:all(dialog,confirmationNameSelector).filter(element=>safe(element)&&contactVisible(element)).slice(0,2).map(marker),position:all(dialog,confirmationPositionSelector).filter(element=>safe(element)&&contactVisible(element)).slice(0,2).map(marker),nodes:headerNodes},messages:all(dialog,'.message-list > .message-item').filter(element=>safe(element)&&contactVisible(element)).slice(0,4).map(message=>({...marker(message),...structureSummary(message),ancestors:structureAncestors(message),directChildren:[...message.children].filter(element=>safe(element)&&contactVisible(element)).slice(0,6).map(element=>({...marker(element),...structureSummary(element),ancestors:structureAncestors(element)}))}))};
      const serializedCost=()=>encoder.encode(JSON.stringify(candidate)).length+(result.confirmationStructure.length?1:0);let cost=serializedCost();
      while(cost>structureBudget&&candidate.messages.length){const last=candidate.messages.at(-1);if(last.directChildren.length)last.directChildren.pop();else candidate.messages.pop();cost=serializedCost();}
      while(cost>structureBudget&&candidate.header.nodes.length){const last=candidate.header.nodes.at(-1);if(last.directChildren.length)last.directChildren.pop();else candidate.header.nodes.pop();cost=serializedCost();}
      if(cost<=structureBudget){result.confirmationStructure.push(candidate);structureBudget-=cost;}
    }
    return result;
  }
  function statusData() {
    const account=uniqueText(document,S.account);
    return {loggedIn:Boolean(account)&&!/登录|注册/u.test(account),account:account||null,ready:document.readyState!=='loading'};
  }
  function chatStructure() {
    const result=[];
    if(location.pathname!=='/web/geek/chat')return result;
    const describe=element=>{const box=element.getBoundingClientRect();return {...marker(element),bbox:{width:Number.isFinite(box.width)?box.width:0,height:Number.isFinite(box.height)?box.height:0},visible:visible(element)};};
    const encoder=new TextEncoder();
    for(const pane of [...document.querySelectorAll('.chat-conversation')].slice(0,4)){
      const chain=[];for(let parent=pane.parentElement;parent&&chain.length<6;parent=parent.parentElement)chain.push(describe(parent));
      const candidate={...describe(pane),ancestors:chain,counts:{userInfo:all(pane,'.user-info').length,positionContent:all(pane,'.chat-position-content').length,leftContent:all(pane,'.left-content').length}};
      if(lastFailedChatTarget){
        const target=lastFailedChatTarget,headers=all(pane,'.user-info').filter(confirmationTextSafe),cards=all(pane,'.chat-position-content .left-content').filter(confirmationTextSafe);
        const spans=headers.length===1?all(headers[0],'span').filter(confirmationTextSafe).filter(element=>!all(element,'span').length).filter(element=>text(element)):[];
        const card=cards.length===1?cards[0]:null,title=card?fullChatCardTitle(card):null;
        candidate.targetMatch={title:{matches:Boolean(title)&&same(title.value,target.title),expectedLength:target.title.length,actualLength:title?title.value.length:null},company:{matches:headers.length===1&&spans.filter(element=>same(text(element),target.company)).length===1,expectedLength:target.company.length},recruiter:{matches:Boolean(target.recruiterName)&&headers.length===1&&spans.filter(element=>same(text(element),target.recruiterName)).length===1,expectedLength:target.recruiterName.length},headerSpans:spans.slice(0,8).map(element=>({...marker(element),textLength:text(element).length,companyMatch:same(text(element),target.company),recruiterMatch:same(text(element),target.recruiterName)})),cardChildren:card?[...card.children].filter(confirmationTextSafe).slice(0,4).map(element=>({...marker(element),textLength:text(element).length})):[]};
      }
      while(encoder.encode(JSON.stringify([...result,candidate])).length>8192&&candidate.ancestors.length)candidate.ancestors.pop();
      if(encoder.encode(JSON.stringify([...result,candidate])).length<=8192)result.push(candidate);
    }
    return result;
  }
  const resumeDiagnosticCaptions=new Set(['同意','已同意','拒绝','发简历','发送简历','发送附件简历','发送','确定','确认发送','取消','关闭','已发送','发送成功','发送失败','发送中','待发送','未发送','选择附件简历','我的附件简历','附件简历','点击查看附件']);
  function resumeStructure() {
    const result={chat:[],dialogs:[]};if(location.pathname!=='/web/geek/chat')return result;
    const safe=element=>confirmationVisible(element)&&!element.closest('form,input,textarea,select,option,.user-info,.chat-header,.conversation-header,.chat-position-content');
    const describe=element=>{const value=text(element);return {...marker(element),textLength:value.length,visible:visible(element),disabled:businessDisabled(element),selected:optionSelected(element),...(resumeDiagnosticCaptions.has(value)?{caption:value}:{})};};
    const node=element=>{const parents=[];for(let parent=element.parentElement;parent&&parents.length<2;parent=parent.parentElement){if(!safe(parent))break;parents.push(describe(parent));}return {...describe(element),directChildren:[...element.children].filter(safe).slice(0,6).map(describe),ancestors:parents};};
    const panes=all(document,fullChatSelector).filter(safe).slice(0,1);
    for(const pane of panes){
      const candidates=all(pane,'.message-item,.chat-message,.toolbar-btn,button,a,[role="button"],[class*="resume"],[class*="attachment"],[class*="file"]').filter(safe);
      const relevant=element=>/简历|resume|\.pdf(?:\b|$)|\.docx?(?:\b|$)/iu.test(text(element))||resumeDiagnosticCaptions.has(text(element))&&Boolean(element.closest('.message-item,.chat-message,.toolbar-btn'));
      const controls=candidates.filter(element=>element.matches('button,a,[role="button"],.toolbar-btn')&&relevant(element));
      const messages=candidates.filter(element=>!controls.includes(element)&&relevant(element));
      const viewSelector='a,button,[role="button"],[role="link"],span,div,p';
      const views=all(pane,viewSelector).filter(safe).filter(element=>text(element)==='点击查看附件'&&!all(element,viewSelector).some(child=>safe(child)&&text(child)==='点击查看附件'));
      const orderedMessages=[...messages.filter(element=>element.matches('.message-item.item-system')).reverse(),...messages.filter(element=>!element.matches('.message-item.item-system'))];
      result.chat=[...[...views.slice(0,2),...controls.filter(element=>!views.includes(element))].slice(0,4),...orderedMessages.slice(0,8)].slice(0,12).map(node);
    }
    result.dialogs=all(document,'.dialog-wrap,.dialog-container,.resume-dialog,.resume-selection-dialog,[role="dialog"]').filter(safe).filter(element=>/简历/u.test(text(element))).filter(element=>!all(element,'.dialog-wrap,.dialog-container,.resume-dialog,.resume-selection-dialog,[role="dialog"]').some(child=>safe(child)&&/简历/u.test(text(child)))).slice(0,2).map(node);
    const encoder=new TextEncoder();
    while(encoder.encode(JSON.stringify(result)).length>8192){const list=result.chat.length?result.chat:result.dialogs;const last=list.at(-1);if(!last)break;if(last.directChildren.length)last.directChildren.pop();else if(last.ancestors.length)last.ancestors.pop();else list.pop();}
    return result;
  }
  function inspectionData() {
    const result={...statusData(),cardObservations:cardObservations(),detailObservations:detailObservations(),chatStructure:chatStructure(),resumeStructure:resumeStructure()};
    const arrays=[result.cardObservations.sample,result.cardObservations.jobLinks,result.detailObservations.locations,result.detailObservations.companyLinks,result.detailObservations.headings,result.detailObservations.scopes,result.detailObservations.descriptions,result.detailObservations.sections,result.chatStructure,result.resumeStructure.chat,result.resumeStructure.dialogs];
    const encoder=new TextEncoder();
    while(encoder.encode(JSON.stringify({meta:metadata(),...result})).length>65536){const list=arrays.find(items=>items.length);if(!list)fail('PAGE_CHANGED','页面元信息超出诊断大小限制');list.pop();}
    return result;
  }
  function detailDescription(scope) {
    const sectionsSelector='.job-detail-section, .detail-section';
    const excluded='.job-detail-company, .company-info-box, .business-info-box, .more-job-section, .security-box, form';
    const safe=element=>{
      if(element.closest(excluded)||element.querySelector('input, textarea, select'))return false;
      const section=element.closest(sectionsSelector);if(!section)return true;
      const headings=all(section,'h2, h3').filter(heading=>heading.closest(sectionsSelector)===section&&!heading.closest('form')&&!heading.querySelector('input, textarea, select')).map(text);
      const explicitJob=headings.some(value=>/^(?:职位描述|岗位描述)$/u.test(value));
      return explicitJob||!headings.some(value=>/^(?:(?:公司|企业)(?:介绍|简介|概况|信息)|工商信息|工作地址|公司地址|竞争力分析|BOSS\s*安全提示|更多职位|精选职位)$/u.test(value));
    };
    const descriptionIn=(root,section=null,selector=S.description)=>{
      const nodes=all(root,selector).filter(element=>safe(element)&&!all(element,S.description).length&&(!section||element.closest(sectionsSelector)===section));
      const values=[...new Set(nodes.map(text).filter(Boolean))];return values.length===1?values[0]:'';
    };
    const sections=all(document,'.job-detail .job-detail-section, .job-detail .detail-section').filter(section=>safe(section)&&all(section,'h2, h3').some(heading=>safe(heading)&&heading.closest(sectionsSelector)===section&&/^(?:职位描述|岗位描述)$/u.test(text(heading))));
    if(sections.length>1)fail('PAGE_CHANGED','职位描述章节不可唯一确认');
    if(sections.length===1)return descriptionIn(sections[0],sections[0]);
    return descriptionIn(scope)||descriptionIn(document,null,'.job-detail .job-sec-text, .job-detail .job-description, .job-detail .description');
  }
  function contactActions(scope) {
    if(scope===document)return [];
    const safe=element=>{
      if(element.querySelector('input,textarea,select,option,form'))return false;
      for(let node=element;node;node=node.parentElement){
        if(node.matches('form,input,textarea,select,option,.more-job-section,.sider-company,.job-sider,.related-company,.company-sidebar')||[...node.classList].some(value=>value.startsWith('job-card')))return false;
        const style=getComputedStyle(node);if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;
        if(node.matches('a[href]')&&!officialUrl(node.href)&&!/^javascript:\s*(?:void\(\s*0\s*\)\s*;?|;)\s*$/iu.test(node.getAttribute('href')||''))return false;
      }
      return true;
    };
    const controls=all(scope,'.op,.job-op').flatMap(container=>named(container,/^(?:立即沟通|继续沟通|沟通)$/u));
    return [...new Set(controls)].filter(element=>scope.contains(element)&&safe(element));
  }
  function detailData(args,withScope=false) {
    const source=all(document,S.detail);const scopes=source.filter(element=>!source.some(other=>other!==element&&element.contains(other)));
    const scope=scopes.find(element=>titleText(element,S.detailTitle))??document;
    const title=titleText(scope,S.detailTitle);const company=detailCompanyText(scope);
    const route=/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/u.exec(location.pathname);const ids=new Set(route?[route[1]]:[]);
    for(const element of scopes){const id=clean(element.getAttribute('data-job-id'));if(id)ids.add(id);}
    if(ids.size!==1||!title||!company)fail('PAGE_CHANGED','详情页岗位 ID、名称或公司不可唯一确认');
    const id=[...ids][0];const url=`https://www.zhipin.com/job_detail/${id}.html`;const supplied=args.job?expectedJob(args.job):null;
    if(supplied&&(!same(supplied.id,id)||!same(supplied.title,title)||!same(supplied.company,company)))fail('RECIPIENT_UNVERIFIED','详情页与目标岗位不一致');
    const description=detailDescription(scope);const city=uniqueText(scope,S.city)||uniqueText(document,'.job-banner .text-city, .job-primary .text-city');
    if(!description||!city)fail('PAGE_CHANGED','详情城市或岗位描述未显示');
    const actual=safeJobUrl(location.href);const job={...(supplied??{}),id,url,navigationUrl:actual?.navigationUrl??supplied?.navigationUrl??url,title,company,city,description,tags:all(scope,S.tags).map(text)};
    const recruiterName=mainRecruiterName();if(recruiterName)job.recruiterName=recruiterName;else delete job.recruiterName;
    if(withScope&&scope===document)fail('PAGE_CHANGED','岗位详情控件范围不可确认');
    const actions=contactActions(scope),contactAvailable=actions.length===1;
    const contactExisting=contactAvailable&&/^继续沟通$/u.test(text(actions[0]));
    return withScope?{job,scope,contactAvailable,contactExisting}:{job,contactAvailable,contactExisting};
  }
  function conversation(job) {
    const actualPanes=all(document,'.chat-container.page-container > .chat-wrap > .chat-conversation');
    if(actualPanes.length)return boundFullChat(job);
    const matches=[];
    for(const chat of all(document,S.chats)){
      const headers=all(chat,S.header);const titles=[...new Set(headers.map(header=>titleText(header,S.chatTitle)).filter(Boolean))];const companies=[...new Set(headers.map(header=>uniqueText(header,S.chatCompany)).filter(Boolean))];
      const ids=new Set();for(const element of [chat,...headers]){const id=clean(element.getAttribute('data-job-id'));if(id)ids.add(id);}
      for(const header of headers)for(const link of all(header,'a[href]')){const target=safeJobUrl(link.href);if(target)ids.add(target.id);}
      if(titles.length===1&&companies.length===1&&same(titles[0],job.title)&&same(companies[0],job.company)&&ids.size===1&&ids.has(job.id))matches.push(chat);
    }
    return matches.length===1?matches[0]:null;
  }
  function requireChat(job) {return conversation(job)??fail('RECIPIENT_UNVERIFIED','会话中无法唯一确认相同岗位 ID、名称和公司');}
  function unconfirmed(message) {return /发送失败|发送中|正在发送|尚未发送|待发送|未发送|发送未成功/u.test(text(message))||/(?:^|\s)(?:failed|sending|pending|is-failed|is-sending)(?:\s|$)/u.test(message.className)||all(message,'.send-failed, .send-error, .sending, .message-failed').length>0;}
  function resumeLike(message) {return message.matches(S.attachment)||all(message,S.attachment).length||/附件简历|申请发送.{0,15}简历|等待.{0,8}同意/u.test(text(message));}
  function conversationData(job,args={}) {
    const chat=conversation(job);if(!chat){let previewAvailable=false;try{fullChatContext(job);previewAvailable=true;}catch{}return {verified:false,previewAvailable,existing:false,emptyNew:false,greetingSent:false,greetingUncertain:false};}
    const messages=all(chat,S.messages);const outgoing=all(chat,S.outgoing).filter(message=>!resumeLike(message));
    const successful=outgoing.filter(message=>!unconfirmed(message)&&(!args.greeting||same(text(message),args.greeting)));
    const emptyNew=!messages.length&&all(chat,S.empty).some(element=>/新会话|首次沟通/u.test(text(element))&&/尚未发送|暂无消息|没有消息/u.test(text(element)));
    return {verified:true,jobId:job.id,existing:messages.length>0,emptyNew,greetingSent:successful.length>0,greetingUncertain:outgoing.some(unconfirmed)};
  }
  function dialogData() {
    const dialogs=all(document,S.dialogs).filter(element=>/简历/u.test(text(element)));
    if(dialogs.length>1)fail('RESUME_SELECTION','附件选择对话框不唯一');
    const dialog=dialogs[0]??null;const options=dialog?all(dialog,S.options):[];
    return {dialog,options:options.map((element,index)=>({element,index,name:uniqueText(element,S.optionName)||text(element)}))};
  }
  function systemResumeReceipt(chat) {
    if(!chat.matches(fullChatSelector))return false;
    for(const message of all(chat,'li.message-item.item-system')){
      if(!confirmationTextSafe(message)||message.closest(fullChatSelector)!==chat||!message.parentElement?.matches('ul.im-list')||message.parentElement.closest('.message-item')||['item-friend','item-myself','is-self','message-right','sent','received','incoming'].some(value=>message.classList.contains(value))||unconfirmed(message))continue;
      const contents=[...message.querySelectorAll('.message-content')];
      if(contents.length!==1||!contents[0].matches('div.message-content')||contents[0].parentElement!==message||!confirmationTextSafe(contents[0]))continue;
      const content=contents[0],bubbles=[...content.querySelectorAll('.hyper-link.text')],views=[...content.querySelectorAll('.target-dom')];
      if(bubbles.length!==1||!bubbles[0].matches('div.hyper-link.text')||bubbles[0].parentElement!==content||!confirmationTextSafe(bubbles[0])||views.length!==1)continue;
      const view=views[0];if(!view.matches('a.target-dom')||view.parentElement!==bubbles[0]||view.childElementCount||!confirmationTextSafe(view)||businessDisabled(view)||text(view)!=='点击查看附件')continue;
      const walker=document.createTreeWalker(content,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let afterView=false,invalid=false,length=0;const parts=[];
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        if(node===view){afterView=true;continue;}
        if(node.nodeType!==Node.TEXT_NODE||!node.parentElement||view.contains(node.parentElement)||!confirmationTextSafe(node.parentElement))continue;
        const value=node.data;if(!clean(value))continue;if(afterView){invalid=true;break;}length+=value.length;if(length>768){invalid=true;break;}parts.push(value);
      }
      if(invalid||!afterView)continue;
      const body=clean(parts.join(''));
      if(/申请发送|请求.{0,12}(?:发送|接收).{0,12}简历|等待.{0,8}同意|需要.{0,8}同意|同意后/u.test(body))continue;
      const match=/^您的附件简历\s*(.+?)\s*已发送给Boss$/u.exec(body);
      if(match&&clean(match[1]))return true;
    }
    return false;
  }
  function resumeData(job) {
    const structure=resumeStructure();const finish=state=>{const result={...state,resumeStructure:structure},encoder=new TextEncoder();while(encoder.encode(JSON.stringify({meta:metadata(),...result})).length>65536){const list=structure.chat.length?structure.chat:structure.dialogs;if(!list.length)fail('PAGE_CHANGED','附件读取信息超出诊断大小限制');list.pop();}return result;};
    const chat=conversation(job);if(!chat)return finish({verified:false,status:'none',approved:false,dialog:false,options:[]});
    let pending=null;let uncertain=null;let delivered=null;
    for(const message of all(chat,S.outgoing)){
      const value=text(message);if(!/简历|resume|\.pdf|\.docx?/iu.test(value))continue;
      if(unconfirmed(message)){uncertain=value;continue;}
      if(/申请发送.{0,15}简历|等待.{0,8}同意|已向对方申请|请求.{0,12}(?:发送|接收).{0,12}简历|同意后.{0,12}(?:发送|简历)/u.test(value)){pending=value;continue;}
      const attachment=message.matches(S.attachment)||all(message,S.attachment).length>0;
      if(attachment&&/(?:已发送|发送成功).{0,20}(?:简历|附件)|\.pdf(?:\b|$)|\.docx?(?:\b|$)|附件简历.{0,15}已发送/iu.test(value))delivered=value;
    }
    if(systemResumeReceipt(chat)){
      if(conversation(job)!==chat)return finish({verified:false,status:'none',approved:false,dialog:false,options:[]});
      delivered='平台系统已确认附件简历发送';
    }
    if(!delivered&&resumeUnavailable(chat))return finish({verified:true,status:'unavailable',approved:false,dialog:false,options:[],reason:'平台当前禁止发送附件简历，需要等待对方回复并允许后再发送'});
    const modal=dialogData();const approved=all(chat,S.messages).some(message=>/对方已同意.{0,12}(?:简历|附件)|已同意接收.{0,12}简历/u.test(text(message)));
    return finish({verified:true,status:delivered?'sent':uncertain?'uncertain':pending?'requested':'none',approved,dialog:Boolean(modal.dialog),options:modal.options.map(({name,index})=>({name,index})),...(delivered||uncertain||pending?{text:delivered??uncertain??pending}:{})});
  }
  let selection=null,contactBinding=null,fullChatPreview=null,fullChatBinding=null,lastFailedChatTarget=null;
  function confirmationVisible(element) {
    if(!visible(element)||element.closest('form,input,textarea,select,option'))return false;
    for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;}
    return true;
  }
  function confirmationTextSafe(element) {return confirmationVisible(element)&&!element.querySelector('form,input,textarea,select,option');}
  const fullChatSelector='.chat-container.page-container > .chat-wrap > .chat-conversation';
  function fullChatCardTitle(card) {
    const names=[...card.querySelectorAll('.position-name')];
    if(!names.length)return {name:null,value:text(card)};
    if(names.length!==1||names[0].parentElement!==card||!confirmationTextSafe(names[0]))return null;
    return {name:names[0],value:text(names[0])};
  }
  function frozenFullChatTitle(snapshot) {
    const names=[...snapshot.card.querySelectorAll('.position-name')],name=snapshot.positionName;
    if(!name)return names.length===0&&text(snapshot.card)===snapshot.titleText;
    if(names.length!==1||names[0]!==name||!name.isConnected||name.parentElement!==snapshot.card||text(name)!==snapshot.titleText)return false;
    for(let node=name;node;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.opacity==='0')return false;}
    return true;
  }
  function fullChatContext(job) {
    try {
    if(!officialUrl(location.href)||location.pathname!=='/web/geek/chat')fail('RECIPIENT_UNVERIFIED','岗位会话不在官方完整聊天页');
    const pane=one(all(document,fullChatSelector).filter(confirmationVisible),'RECIPIENT_UNVERIFIED','当前完整会话范围不唯一');
    const header=one(all(pane,'.user-info').filter(confirmationTextSafe),'RECIPIENT_UNVERIFIED','当前会话招聘者信息不唯一');
    const card=one(all(pane,'.chat-position-content .left-content').filter(confirmationTextSafe),'RECIPIENT_UNVERIFIED','当前会话岗位卡不唯一');
    const title=fullChatCardTitle(card);
    const spans=all(header,'span').filter(confirmationTextSafe).filter(element=>!all(element,'span').length).map(element=>({element,value:text(element)})).filter(item=>item.value);
    if(spans.length>8||spans.filter(item=>same(item.value,job.company)).length!==1||job.recruiterName&&spans.filter(item=>same(item.value,job.recruiterName)).length!==1||!title||!same(title.value,job.title))fail('RECIPIENT_UNVERIFIED','会话公司、招聘者或岗位名称不一致');
    return {pane,header,card,positionName:title.name,titleText:title.value,spans,cardText:text(card),documentId,pageUrl:location.href,job:{id:job.id,url:job.url,title:job.title,company:job.company,...(job.recruiterName?{recruiterName:clean(job.recruiterName)}:{})}};
    } catch(error) {lastFailedChatTarget={title:clean(job.title),company:clean(job.company),recruiterName:clean(job.recruiterName)};throw error;}
  }
  function frozenFullChat(snapshot,job) {
    if(!snapshot||snapshot.documentId!==documentId||snapshot.pageUrl!==location.href||snapshot.job.id!==job.id||snapshot.job.url!==job.url||!same(snapshot.job.title,job.title)||!same(snapshot.job.company,job.company)||job.recruiterName&&snapshot.job.recruiterName&&!same(job.recruiterName,snapshot.job.recruiterName))return false;
    try{
      const current=fullChatContext({...job,...(snapshot.job.recruiterName?{recruiterName:snapshot.job.recruiterName}:{})});
      return current.pane===snapshot.pane&&current.header===snapshot.header&&current.card===snapshot.card&&current.positionName===snapshot.positionName&&current.titleText===snapshot.titleText&&current.spans.length===snapshot.spans.length&&current.spans.every((item,index)=>item.element===snapshot.spans[index].element&&item.value===snapshot.spans[index].value)&&current.cardText===snapshot.cardText;
    }catch{return false;}
  }
  function frozenFullChatFields(snapshot) {
    return snapshot.documentId===documentId&&snapshot.pageUrl===location.href&&snapshot.pane.isConnected&&snapshot.header.isConnected&&snapshot.card.isConnected&&snapshot.pane.contains(snapshot.header)&&snapshot.pane.contains(snapshot.card)&&snapshot.card.closest(fullChatSelector)===snapshot.pane&&text(snapshot.card)===snapshot.cardText&&frozenFullChatTitle(snapshot)&&snapshot.spans.every(item=>item.element.isConnected&&snapshot.header.contains(item.element)&&text(item.element)===item.value);
  }
  function boundFullChat(job) {
    if(!frozenFullChat(fullChatBinding,job)||!frozenFullChatFields(fullChatBinding))return null;
    return fullChatBinding.pane;
  }
  const actualResumeSelector='.chat-controls > .toolbar-btn-content > .toolbar-btn.tooltip.tooltip-top, .chat-im.chat-editor > .toolbar-btn-content > .toolbar-btn.tooltip.tooltip-top';
  const resumeMessageScopes='.message-item,.chat-message,.chat-record,.im-list,.dialog-wrap,.dialog-container,[role="dialog"],form';
  function businessDisabled(element) {
    for(let node=element;node;node=node.parentElement)if(node.classList.contains('unable')||node.classList.contains('disabled')||node.disabled||node.hasAttribute('disabled')||node.getAttribute('aria-disabled')==='true')return true;
    return false;
  }
  function resumeControlScope(element,chat) {return element.closest(fullChatSelector)===chat&&!element.closest(resumeMessageScopes);}
  function actualResumeControls(chat) {return all(chat,actualResumeSelector).filter(element=>resumeControlScope(element,chat)).filter(confirmationTextSafe).filter(element=>/^(?:发简历|发送简历)$/u.test(text(element)));}
  function resumeUnavailable(chat) {
    if(!chat.matches(fullChatSelector))return false;
    const controls=all(chat,'.toolbar-btn').filter(element=>resumeControlScope(element,chat)).filter(element=>confirmationVisible(element)&&(/^(?:发简历|发送简历|发送附件简历)$/u.test(text(element))||all(element,'span').some(leaf=>confirmationTextSafe(leaf)&&/^(?:发简历|发送简历|发送附件简历)$/u.test(text(leaf)))));
    return controls.some(businessDisabled);
  }
  function requireResumeAvailable(chat) {if(resumeUnavailable(chat))fail('RESUME_UNAVAILABLE','平台当前禁止发送附件简历，未执行操作');}
  function startchatDialogs() {return all(document,'.dialog-wrap.startchat-dialog > .dialog-container').filter(confirmationVisible);}
  const confirmationNameSelector='h3.title > .name, :scope > .dialog-title > h3.title > .startchat-title > .boss-info > div.name';
  const confirmationPositionSelector='h3.title > .position, :scope > .dialog-title > h3.title > .startchat-title > .boss-info > div.position';
  function mainRecruiterName() {
    const names=all(document,'.job-detail .job-detail-section > h3.name, .job-detail > .job-detail-section > .job-boss-info > h2.name').filter(element=>confirmationTextSafe(element)&&!element.closest('.more-job-section,.job-detail-company,.sider-company,.related-company'));
    if(names.length!==1)return '';
    const direct=clean([...names[0].childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join(' '));
    if(names[0].matches('.job-boss-info > h2.name')&&!direct)return '';
    const value=clean(direct||text(names[0])).replace(/\s*\d+\s*(?:日|天|周)内活跃\s*$/u,'').trim();
    return value&&value.length<=160?value:'';
  }
  function contactConfirmation(job,latch=false) {
    const missing={confirmed:false,jobId:job.id,needsExistingConversation:true};
    const binding=contactBinding;
    if(!binding||binding.documentId!==documentId||binding.pageUrl!==location.href||binding.job.id!==job.id||binding.job.url!==job.url||!same(binding.job.title,job.title)||!same(binding.job.company,job.company)||!binding.recruiterName)return {proof:missing};
    try{detailData({job},true);}catch{return {proof:missing};}
    if(mainRecruiterName()!==binding.recruiterName)return {proof:missing};
    const fresh=startchatDialogs().filter(dialog=>!binding.oldDialogs.has(dialog));
    if(fresh.length!==1||binding.confirmedDialog&&binding.confirmedDialog!==fresh[0])return {proof:missing};
    const dialog=fresh[0],names=all(dialog,confirmationNameSelector).filter(confirmationTextSafe),positions=all(dialog,confirmationPositionSelector).filter(confirmationTextSafe);
    if(names.length!==1||positions.length!==1||!same(text(names[0]),binding.recruiterName))return {proof:missing};
    const position=text(positions[0]),separator=position.indexOf('·');
    if(separator<1||!same(position.slice(0,separator),job.company)||!clean(position.slice(separator+1)))return {proof:missing};
    const messages=all(dialog,'.message-list > .message-item').filter(confirmationTextSafe);
    const failedStatuses='.send-failed,.send-error,.message-failed,.pending,.sending,.failed,.is-failed,.is-sending';
    if(messages.some(message=>unconfirmed(message)||message.matches(failedStatuses)||all(message,failedStatuses).length))return {proof:missing};
    const sent=messages.find(message=>{
      if(resumeLike(message)||/\.pdf(?:\b|$)|\.docx?(?:\b|$)/iu.test(text(message)))return false;
      const bodySelector=message.matches('li.message-item')?'.message-text,.message-body, :scope > p.text':'.message-text,.message-body';
      const bodies=all(message,bodySelector).filter(confirmationTextSafe).filter(element=>!all(element,'.message-text,.message-body').length);
      if(bodies.length!==1||!text(bodies[0]))return false;
      if(bodies[0].matches('p.text')){const statuses=all(message,':scope > span.status.success').filter(confirmationTextSafe);return statuses.length===1&&text(statuses[0])==='已发送';}
      const labels=all(message,'label,span,div').filter(confirmationTextSafe).filter(element=>{
        if(text(element)!=='已发送'||bodies.some(body=>body===element||body.contains(element)||element.contains(body)))return false;
        for(let parent=element.parentElement;parent&&parent!==message;parent=parent.parentElement)if(text(parent)!=='已发送')return false;
        return true;
      });
      return labels.length>0;
    });
    if(!sent)return {proof:missing};
    if(latch&&!binding.confirmedDialog){
      binding.confirmedDialog=dialog;
      const closes=all(dialog,'a.close').filter(confirmationTextSafe);
      binding.close=closes.length===1?closes[0]:null;binding.closeCaption=binding.close?text(binding.close):null;
    }
    return {dialog,proof:{confirmed:true,jobId:job.id,needsExistingConversation:true,evidence:{kind:'job-page-contact-confirmation',recruiterName:clipped(binding.recruiterName),company:clipped(job.company),status:'已发送',text:clipped(text(sent))}}};
  }
  function confirmationClose(job,binding) {
    const snapshot=contactConfirmation(job);
    if(!snapshot.proof.confirmed||!binding||binding!==contactBinding||binding.confirmedDialog!==snapshot.dialog)fail('PAGE_CHANGED','没有相同岗位的已确认沟通弹窗');
    const close=one(all(snapshot.dialog,'a.close').filter(confirmationTextSafe),'PAGE_CHANGED','沟通确认弹窗关闭控件不唯一');
    if(close!==binding.close||text(close)!==binding.closeCaption||/发送|沟通|扫码|二维码/u.test(text(close)))fail('PAGE_CHANGED','原沟通弹窗关闭控件或文字已改变');
    const href=close.getAttribute('href');if(href&&!officialUrl(close.href)&&!/^javascript:\s*(?:void\(\s*0\s*\)\s*;?|;)\s*$/iu.test(href))fail('PAGE_CHANGED','关闭控件地址不可确认');
    return close;
  }
  function connected(element) {if(!element?.isConnected||!visible(element))fail('DOCUMENT_CHANGED','原控件已改变，未执行操作');}
  function guardedClick(element,command,verify) {connected(element);if(verify)verify();requireEffect(command);element.click();}
  function optionSelected(element) {
    const radio=element.matches('input')?element:element.querySelector('input[type="radio"],input[type="checkbox"]');
    return Boolean(radio?.checked)||element.getAttribute('aria-checked')==='true'||/(?:^|\s)(?:selected|active|checked)(?:\s|$)/u.test(element.className);
  }
  function editorValue(element) {return element.matches('textarea, input')?element.value:element.textContent;}
  function setEditor(element,value) {
    if(element.matches('textarea, input')){const proto=element.matches('textarea')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);}else element.textContent=value;
    element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));
  }
  async function execute(command) {
    if(!command||!OPS.has(command.op)||!command.args&&command.args!==undefined)fail('COMMAND_INVALID','不支持的固定操作');
    const args=command.args??{};if(typeof args!=='object'||Array.isArray(args)||['selector','script','code','function','javascript'].some(key=>Object.prototype.hasOwnProperty.call(args,key)))fail('COMMAND_INVALID','不接受脚本、函数或任意选择器');
    if(command.op==='REVOKE_CONVERSATION_JOB'){
      const job=expectedJob(args.job),expectedId=typeof command.expectedDocument==='string'?command.expectedDocument:command.expectedDocument?.documentId;
      if(expectedId!==documentId)fail('DOCUMENT_CHANGED','旧文档不能撤销当前会话绑定');
      const matches=snapshot=>snapshot&&snapshot.documentId===documentId&&snapshot.previewToken===args.previewToken&&snapshot.job.id===job.id&&snapshot.job.url===job.url&&same(snapshot.job.title,job.title)&&same(snapshot.job.company,job.company);
      let revoked=false;if(matches(fullChatBinding)){fullChatBinding=null;revoked=true;}if(matches(fullChatPreview)){fullChatPreview=null;revoked=true;}
      return {meta:metadata(),revoked,jobId:job.id};
    }
    if(EFFECTS.has(command.op))requireEffect(command);
    const problem=risk();if(problem)return {meta:metadata(),risk:{code:problem.code,message:problem.message},authPending:problem.authPending===true};
    let result;
    switch(command.op){
      case 'READ_STATUS':result=statusData();break;
      case 'INSPECT_PAGE':result=inspectionData();break;
      case 'READ_CARDS':result=cardData();break;
      case 'READ_DETAIL':result=detailData(args);break;
      case 'READ_CONVERSATION':result=conversationData(expectedJob(args.job),args);break;
      case 'READ_RESUME':result=resumeData(expectedJob(args.job));break;
      case 'READ_CONTACT_CONFIRMATION':result=contactConfirmation(expectedJob(args.job),true).proof;break;
      case 'VERIFY_CONVERSATION_JOB':{fullChatPreview=null;fullChatBinding=null;const job=expectedJob(args.job);if(typeof args.previewToken!=='string'||!/^[a-f0-9-]{36}$/iu.test(args.previewToken))fail('COMMAND_INVALID','岗位预览标识无效');const snapshot=fullChatContext(job);guardedClick(snapshot.card,command,()=>{if(!frozenFullChat(snapshot,job))fail('RECIPIENT_UNVERIFIED','原会话岗位范围已改变');connected(snapshot.card);if(!frozenFullChatFields(snapshot))fail('RECIPIENT_UNVERIFIED','最后检查时原岗位卡或招聘者已改变');});fullChatPreview={...snapshot,previewToken:args.previewToken};result={previewStarted:true,previewToken:args.previewToken};break;}
      case 'BIND_CONVERSATION_JOB':{const job=expectedJob(args.job),snapshot=fullChatPreview;requireDocument(command.expectedDocument);if(!snapshot||snapshot.previewToken!==args.previewToken||args.canonicalURL!==job.url||!frozenFullChat(snapshot,job)||!frozenFullChatFields(snapshot))fail('RECIPIENT_UNVERIFIED','实际岗位详情地址或原会话预览绑定不一致');fullChatBinding=snapshot;fullChatPreview=null;result={verified:true,jobId:job.id};break;}
      case 'NEXT_PAGE':{const next=one(all(document,S.next),'PAGE_CHANGED','下一页按钮不唯一');if(next.disabled||next.getAttribute('aria-disabled')==='true'||/disabled/u.test(next.className)){result={clicked:false,disabled:true};break;}const href=next.getAttribute('href');if(href){const url=new URL(href,location.href);if(!/^\/web\/geek\/jobs?$/u.test(url.pathname)||!['www.zhipin.com',location.hostname].includes(url.hostname))fail('PAGE_CHANGED','下一页地址不可确认');}guardedClick(next,command);result={clicked:true};break;}
      case 'OPEN_CONTACT':{contactBinding=null;let pendingBinding=null;const job=expectedJob(args.job);const detail=detailData({job},true);const action=one(contactActions(detail.scope),'PAGE_CHANGED','岗位沟通按钮不唯一');const caption=text(action),existing=/^继续沟通$/u.test(caption);if(args.resumeOnly&&!existing)fail('RECIPIENT_UNVERIFIED','仅复查简历时未确认该岗位已有沟通');guardedClick(action,command,()=>{const current=detailData({job},true);const latest=one(contactActions(current.scope),'PAGE_CHANGED','岗位沟通按钮不唯一');if(args.resumeOnly&&!/^继续沟通$/u.test(text(latest)))fail('RECIPIENT_UNVERIFIED','仅复查简历时沟通状态已改变');if(latest!==action||text(latest)!==caption)fail('PAGE_CHANGED','原岗位沟通控件或文字已改变，未执行点击');connected(action);const recruiterName=mainRecruiterName(),oldDialogs=startchatDialogs();if(recruiterName&&oldDialogs.length<=8)pendingBinding={documentId,pageUrl:location.href,job:{id:job.id,url:job.url,title:job.title,company:job.company},recruiterName,oldDialogs:new Set(oldDialogs)};});contactBinding=pendingBinding;result={clicked:true,existing};break;}
      case 'DISMISS_CONTACT_CONFIRMATION':{const job=expectedJob(args.job),binding=contactBinding;if(!binding?.confirmedDialog)fail('RECIPIENT_UNVERIFIED','没有本次岗位沟通的已确认弹窗绑定');const close=confirmationClose(job,binding);guardedClick(close,command,()=>{if(confirmationClose(job,binding)!==close)fail('PAGE_CHANGED','关闭控件已改变');connected(close);if(binding!==contactBinding||!close.isConnected||!binding.confirmedDialog.isConnected||!binding.confirmedDialog.contains(close)||close!==binding.close||text(close)!==binding.closeCaption)fail('PAGE_CHANGED','最后检查时原关闭控件或文字已改变');});contactBinding=null;result={dismissed:true,jobId:job.id,needsExistingConversation:true};break;}
      case 'FILL_GREETING':case 'SEND_GREETING':{const job=expectedJob(args.job);const chat=requireChat(job);const state=conversationData(job);if(state.greetingSent||state.existing)fail('DUPLICATE_GREETING','会话已有消息，未重复发送招呼');if(!state.emptyNew)fail('GREETING_UNVERIFIED','没有明确的新空会话证据');if(typeof args.greeting!=='string'||!args.greeting.trim()||args.greeting.length>6000)fail('COMMAND_INVALID','招呼内容无效');const editor=one(all(chat,S.editor),'PAGE_CHANGED','编辑器不唯一');connected(editor);if(command.op==='FILL_GREETING'){if(clean(editorValue(editor))&&!same(editorValue(editor),args.greeting))fail('DRAFT_CONFLICT','会话已有草稿，未覆盖');requireChat(job);requireEffect(command);setEditor(editor,args.greeting);result={filled:true};}else{if(!same(editorValue(editor),args.greeting))fail('DRAFT_CONFLICT','草稿与本次招呼不一致');const sends=[];for(const scope of all(chat,S.actions))sends.push(...named(scope,/^发送$/u));const send=one([...new Set(sends)],'PAGE_CHANGED','发送按钮不唯一');guardedClick(send,command,()=>requireChat(job));result={clicked:true,...conversationData(job,args)};}break;}
      case 'REQUEST_RESUME':{const job=expectedJob(args.job);const chat=requireChat(job);requireResumeAvailable(chat);const before=resumeData(job);if(before.status==='sent'||before.status==='requested'&&!before.approved){result={clicked:false,...before};break;}if(before.status==='uncertain')fail('RESULT_UNCERTAIN','简历结果不确定，未自动重发');const binding=chat.matches(fullChatSelector)?fullChatBinding:null;const button=one(binding?actualResumeControls(chat):named(chat,/^(?:发送简历|发送附件简历)$/u),'PAGE_CHANGED','发送简历按钮不唯一'),caption=text(button),toolbarParent=button.parentElement,toolbarHost=toolbarParent?.parentElement;guardedClick(button,command,()=>{const current=requireChat(job);requireResumeAvailable(current);if(binding){if(current!==chat||binding!==fullChatBinding||one(actualResumeControls(current),'PAGE_CHANGED','发送简历按钮不唯一')!==button||text(button)!==caption)fail('PAGE_CHANGED','原简历控件或会话已改变');connected(button);if(!button.isConnected||!chat.contains(button)||!button.matches(actualResumeSelector)||!resumeControlScope(button,chat)||button.parentElement!==toolbarParent||toolbarParent?.parentElement!==toolbarHost||text(button)!==caption||!frozenFullChatFields(binding))fail('PAGE_CHANGED','最后检查时简历控件或会话已改变');if(businessDisabled(button))fail('RESUME_UNAVAILABLE','平台当前禁止发送附件简历，未执行操作');}});result={clicked:true,...resumeData(job)};break;}
      case 'SELECT_RESUME':{const job=expectedJob(args.job);requireResumeAvailable(requireChat(job));const modal=dialogData();if(!modal.dialog)fail('RESUME_SELECTION','没有附件简历对话框');const matches=args.resumeName?modal.options.filter(option=>same(option.name,args.resumeName)):modal.options.length===1?modal.options:[];const option=one(matches,'RESUME_SELECTION','多份附件必须精确匹配名称');guardedClick(option.element,command,()=>{requireResumeAvailable(requireChat(job));});if(!optionSelected(option.element))fail('RESUME_SELECTION','未看到附件被选中的状态');selection={jobId:job.id,company:job.company,title:job.title,dialog:modal.dialog,option:option.element,name:option.name,documentId};result={selected:true,name:option.name,index:option.index};break;}
      case 'CONFIRM_RESUME':{const job=expectedJob(args.job);requireResumeAvailable(requireChat(job));if(!selection||selection.documentId!==documentId||!same(selection.jobId,job.id)||!same(selection.company,job.company)||!same(selection.title,job.title)||args.resumeName&&!same(selection.name,args.resumeName))fail('RESUME_SELECTION','没有对应岗位的已选附件');connected(selection.dialog);connected(selection.option);const modal=dialogData();if(modal.dialog!==selection.dialog)fail('DOCUMENT_CHANGED','附件对话框已改变');const selected=modal.options.filter(option=>optionSelected(option.element));if(selected.length!==1||selected[0].element!==selection.option||!same(selected[0].name,selection.name))fail('RESUME_SELECTION','已选附件发生变化，未确认发送');const confirm=one(named(selection.dialog,/^(?:发送|确定|确认发送)$/u),'PAGE_CHANGED','附件确认按钮不唯一');guardedClick(confirm,command,()=>{requireResumeAvailable(requireChat(job));});selection=null;result={confirmed:true,clicked:true,...resumeData(job)};break;}
    }
    return {meta:metadata(),...result};
  }
  Object.defineProperty(globalThis,'BossDomExecutor',{value:Object.freeze({execute,metadata}),writable:false,configurable:false});
})();
