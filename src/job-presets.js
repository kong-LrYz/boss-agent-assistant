// Selectable roles come from the pinned BOSS public homepage taxonomy.
// Search aliases are local presets; position IDs are never inferred.
// The AI Agent default remains unchanged; advanced settings can override every term.
import positionCatalog from './position-catalog.json' with { type:'json' };
const overrides = {
  'AI Agent': { queries:['AI Agent','智能体','Agent开发','LLM Agent'], requiredAny:['agent','智能体'] },
  大模型应用开发: {queries:['大模型应用','LLM开发','RAG开发'],requiredAny:['大模型','LLM','RAG','AIGC']},
  大模型算法: {queries:['大模型算法','LLM算法'],requiredAny:['大模型','LLM','预训练','模型微调']},
  'C/C++': {queries:['C++开发','C语言开发'],requiredAny:['C++','C语言','C开发']},
  Golang: {queries:['Golang','Go开发'],requiredAny:['Golang','Go']},
  '自然语言处理算法': {queries:['自然语言处理','NLP算法'],requiredAny:['自然语言处理','NLP']},
  '图像算法': {queries:['图像算法','计算机视觉'],requiredAny:['图像算法','计算机视觉','视觉算法','CV']},
  '前端开发工程师': {queries:['前端开发','前端工程师'],requiredAny:['前端','frontend']},
  '嵌入式软件工程师': {queries:['嵌入式开发','嵌入式软件'],requiredAny:['嵌入式','embedded']},
  '数据分析师': {queries:['数据分析师','数据分析'],requiredAny:['数据分析','data analyst']},
  自然语言处理: {queries:['自然语言处理','NLP'],requiredAny:['自然语言处理','NLP']},
  计算机视觉: {queries:['计算机视觉','图像算法'],requiredAny:['计算机视觉','图像算法','视觉算法','CV']},
  销售: {queries:['销售','销售专员','客户经理'],requiredAny:['销售','客户经理']},
  客服: {queries:['客服','客户服务'],requiredAny:['客服','客户服务']},
  财务: {queries:['财务','会计'],requiredAny:['财务','会计']},
  人力资源: {queries:['人力资源','人事'],requiredAny:['人力资源','人事','HR']},
  商务拓展: {queries:['商务拓展','BD'],requiredAny:['商务拓展','BD']},
  外贸业务: {queries:['外贸业务','外贸销售'],requiredAny:['外贸','国际贸易']},
  UI设计: {queries:['UI设计','界面设计'],requiredAny:['UI','界面设计']},
  UX设计: {queries:['UX设计','用户体验设计'],requiredAny:['UX','用户体验']},
  物流: {queries:['物流','物流运营'],requiredAny:['物流']},
};
// In these official combined labels the last function belongs to every item.
// Keep that function in each local alias so “视频开发” does not become “视频”.
const sharedFunctionAliases = {
  '语音/视频/图形开发':['语音开发','视频开发','图形开发'],
  '电脑/打印机维修':['电脑维修','打印机维修'],
  '无线/天线工程师':['无线工程师','天线工程师'],
  '数据/策略运营':['数据运营','策略运营'],
  '货代/物流销售':['货代销售','物流销售'],
  '建筑/工程会计':['建筑会计','工程会计'],
  'CNC数控操机/编程员':['CNC数控操机','CNC编程员','数控编程员'],
  '家电/3C结构工程师':['家电结构工程师','3C结构工程师'],
  '铸造/锻造工程师':['铸造工程师','锻造工程师'],
  '生产组长/拉长':['生产组长','生产拉长'],
  '生产跟单/文员':['生产跟单','生产文员'],
  '食品/饮料研发':['食品研发','饮料研发'],
  '服装/纺织/皮革跟单':['服装跟单','纺织跟单','皮革跟单'],
  '服装/纺织设计':['服装设计','纺织设计'],
  '理货/陈列员':['理货员','陈列员'],
  '保安主管/队长':['保安主管','保安队长'],
  '电动车/摩托车维修':['电动车维修','摩托车维修'],
  '体育/体能老师':['体育老师','体能老师'],
  '摄影/摄像师':['摄影师','摄像师'],
  '餐饮前厅经理/领班':['餐饮前厅经理','餐饮前厅领班'],
  '面包/烘焙师':['面包师','烘焙师'],
  '蛋糕/裱花师':['蛋糕师','裱花师'],
  'UX/交互设计师':['UX设计','交互设计'],
  '展览/展示设计':['展览设计','展示设计'],
  '园林/景观设计':['园林设计','景观设计'],
  '土木/土建/结构工程师':['土木工程师','土建工程师','结构工程师'],
  '广告/会展项目经理':['广告项目经理','会展项目经理'],
  '会务/会展执行':['会务执行','会展执行'],
  '会务/会展策划':['会务策划','会展策划'],
  '水/空/陆运操作':['水运操作','空运操作','陆运操作'],
  '物流/仓储项目经理':['物流项目经理','仓储项目经理'],
  '报关/报检员':['报关员','报检员'],
  '知识产权/专利/商标代理人':['知识产权代理人','专利代理人','商标代理人'],
  '韩语/朝鲜语翻译':['韩语翻译','朝鲜语翻译'],
  '风电/光伏运维工程师':['风电运维','光伏运维'],
  '农业/林业技术员':['农业技术员','林业技术员'],
  '分公司/代表处负责人':['分公司负责人','代表处负责人'],
};
function allowedTerms(role,group) {
  const terms=[];
  if(group?.parent==='销售'||group?.category?.includes('销售')||/销售|客户经理|商务|外贸|导购|置业顾问|经纪人|顾问/.test(role))terms.push('销售','电销');
  if(group?.category==='客服'||/客服/.test(role))terms.push('客服');
  if(group?.parent==='教育培训'||group?.category==='教培销售'||/教师|老师|教务|培训|讲师|招生|家教|幼教|助教|教练/.test(role))terms.push('讲师','培训师','招生');
  if(/标注|AI训练/.test(role))terms.push('数据标注','标注员');
  return [...new Set(terms)];
}
export const JOB_PRESET_GROUPS = Object.freeze([{label:'默认岗位',options:Object.freeze([Object.freeze({targetRole:'AI Agent',label:'AI Agent',allowExcludedKeywords:Object.freeze([])})])},...positionCatalog.roleGroups.map(group=>Object.freeze({label:group.label,parent:group.parent,category:group.category,options:Object.freeze(group.options.map(option=>Object.freeze({...option,allowExcludedKeywords:Object.freeze(allowedTerms(option.targetRole,group))})))}))]);
export const JOB_SOURCE = Object.freeze(Object.fromEntries(Object.entries(positionCatalog).filter(([key])=>key!=='roleGroups')));
const presetByRole = new Map(JOB_PRESET_GROUPS.flatMap(group=>group.options).map(option=>[option.targetRole.toLocaleLowerCase(),option]));
export function findJobPreset(targetRole) {
  const key=targetRole.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase();
  return presetByRole.get(key)||{targetRole,allowExcludedKeywords:allowedTerms(targetRole)};
}
export function presetSearchDefaults(targetRole) {
  const preset=findJobPreset(targetRole),value=preset?.targetRole||targetRole;
  const alternatives=value.includes('/')?value.split('/').map((part,index,parts)=>index>0&&/^(?:助理|专员|主管|经理|总监|VP)$/u.test(part)?parts[0].replace(/(?:助理|专员|主管|经理|总监)$/u,'')+part:part).filter(Boolean):[value];
  const aliases=sharedFunctionAliases[value]||alternatives;
  const data=overrides[value]||{queries:aliases,requiredAny:aliases};
  return {queries:[...data.queries],requiredAny:[...data.requiredAny]};
}
