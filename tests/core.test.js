import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultConfig, validateConfig, evaluateJob, renderGreeting, jobKey, dateKey } from '../src/core.js';
import * as core from '../src/core.js';

const agentInternship = {
  id: 'abc123', url: 'https://www.zhipin.com/job_detail/abc123.html?ka=search_list_1',
  title: 'AI Agent 开发实习生', company: '示例科技', city: '北京·海淀区',
  description: '使用 Python 开发 LLM Agent 与工具调用，参与 RAG 系统研发。', tags: ['实习', '本科'],
};

test('normalizes optional unlimited limits and independent config arrays', () => {
  const config = validateConfig({ queries: 'AI Agent\n智能体,AI Agent', dailyLimit: '0', runLimit: '0' });
  assert.deepEqual(config.queries, ['AI Agent', '智能体']);
  assert.equal(config.dailyLimit, 0);
  assert.equal(config.runLimit, 0);
  assert.equal(config.setupComplete, false);
  assert.equal(config.autoRun, true);
  config.queries.push('新查询');
  assert.equal(defaultConfig.queries.length, 4);
});

test('legacy configurations keep the AI Agent target and existing custom search terms', () => {
  const { targetRole: ignored, ...legacy } = defaultConfig;
  const config = validateConfig(legacy);
  assert.equal(config.targetRole, 'AI Agent');
  assert.deepEqual(config.queries, ['AI Agent', '智能体', 'Agent开发', 'LLM Agent']);
  assert.deepEqual(config.requiredAny, ['agent', '智能体']);
  const custom = validateConfig({ ...legacy, queries: ['工具调用'], requiredAny: ['LangGraph'] });
  assert.equal(custom.targetRole, 'AI Agent');
  assert.deepEqual(custom.queries, ['工具调用']);
  assert.deepEqual(custom.requiredAny, ['LangGraph']);
});

test('target role presets retain Agent aliases and return independent custom role terms', () => {
  assert.equal(typeof core.roleSearchDefaults, 'function');
  assert.deepEqual(core.roleSearchDefaults('AI Agent'), {
    queries: ['AI Agent', '智能体', 'Agent开发', 'LLM Agent'], requiredAny: ['agent', '智能体']
  });
  const custom = core.roleSearchDefaults(' Java ');
  assert.deepEqual(custom, { queries: ['Java'], requiredAny: ['Java'] });
  custom.queries.push('caller edit');
  assert.deepEqual(custom.requiredAny, ['Java']);
  custom.requiredAny[0] = 'changed';
  assert.deepEqual(core.roleSearchDefaults('Java'), { queries: ['Java'], requiredAny: ['Java'] });
});

test('changing only the target role replaces missing search and matching defaults', () => {
  const java = validateConfig({ targetRole: ' Java ' });
  assert.equal(java.targetRole, 'Java');
  assert.deepEqual(java.queries, ['Java']);
  assert.deepEqual(java.requiredAny, ['Java']);
  assert.equal(java.roleType, 'internship');
});

test('explicit role search or matching overrides survive role preset normalization', () => {
  const search = validateConfig({ targetRole: 'Java', queries: ['后端开发'] });
  assert.deepEqual(search.queries, ['后端开发']);
  assert.deepEqual(search.requiredAny, ['Java']);
  const matching = validateConfig({ targetRole: 'Java', requiredAny: ['Spring Boot', 'JVM'] });
  assert.deepEqual(matching.queries, ['Java']);
  assert.deepEqual(matching.requiredAny, ['Spring Boot', 'JVM']);
  const explicitOldTerms = validateConfig({ ...defaultConfig, targetRole: 'Java' });
  assert.deepEqual(explicitOldTerms.queries, defaultConfig.queries);
  assert.deepEqual(explicitOldTerms.requiredAny, defaultConfig.requiredAny);
  for (const field of ['queries', 'requiredAny']) {
    for (const value of [undefined, null, []]) assert.throws(() => validateConfig({ targetRole: 'Java', [field]: value }));
  }
});

test('custom Java matching does not retain Agent requirements or admit JavaScript only', () => {
  const java = { ...agentInternship, title: 'Java 开发实习生', description: '使用 Spring Boot 开发后端服务。' };
  const config = validateConfig({ targetRole: 'Java' });
  assert.equal(evaluateJob(java, config).eligible, true);
  assert.equal(evaluateJob(java, defaultConfig).eligible, false);
  const mismatch = evaluateJob({ ...java, title: 'JavaScript 前端实习生', description: '开发网页界面。' }, config);
  assert.equal(mismatch.eligible, false);
  assert.ok(mismatch.reasons.some(reason => /Java/.test(reason)));
  assert.ok(mismatch.reasons.every(reason => !/Agent|智能体/.test(reason)));
});

test('target job name stays separate from internship and experienced role types', () => {
  const java = { ...agentInternship, title: 'Java 开发实习生', description: '开发后端服务。' };
  const config = validateConfig({ targetRole: 'Java', roleType: 'experienced' });
  assert.equal(config.targetRole, 'Java');
  assert.equal(config.roleType, 'experienced');
  assert.equal(evaluateJob(java, config).eligible, false);
});

test('target job name must be a nonempty bounded string', () => {
  assert.equal(validateConfig({ targetRole: 'J'.repeat(100) }).targetRole.length, 100);
  for (const targetRole of ['', '   ', null, 42, 'J'.repeat(101), 'Java\0开发']) {
    assert.throws(() => validateConfig({ targetRole }));
    if (typeof core.roleSearchDefaults === 'function') assert.throws(() => core.roleSearchDefaults(targetRole));
  }
});

const productExclusions = [{ targetRole: 'AI Agent', keywords: ['产品经理', '产品策略', '产品运营', '产品实习'] }];

test('role title exclusions normalize into independent bounded per-target rules', () => {
  const input = [{ targetRole: '  ai　agent  ', keywords: [' 产品经理 ', '产品经理', '产品运营'] }];
  const config = validateConfig({ roleTitleExclusions: input });
  assert.deepEqual(config.roleTitleExclusions, [{ targetRole: 'ai agent', keywords: ['产品经理', '产品运营'] }]);
  input[0].keywords.push('caller edit');
  assert.equal(config.roleTitleExclusions[0].keywords.length, 2);
  assert.deepEqual(validateConfig({}).roleTitleExclusions, []);
  for (const rules of [
    null, {}, [{ targetRole: '', keywords: ['产品经理'] }], [{ targetRole: 'R'.repeat(101), keywords: ['产品经理'] }],
    [{ targetRole: 'AI Agent', keywords: [] }], [{ targetRole: 'AI Agent', keywords: '产品经理' }],
    [{ targetRole: 'AI Agent', keywords: [''] }], [{ targetRole: 'AI Agent', keywords: ['x'.repeat(101)] }],
    [{ targetRole: 'AI Agent', keywords: ['产品经理'], script: 'unused' }],
    [{ targetRole: 'AI Agent', keywords: ['产品经理'] }, { targetRole: ' ai　agent ', keywords: ['产品运营'] }],
    Array.from({ length: 21 }, (_, index) => ({ targetRole: `Role${index}`, keywords: ['产品经理'] })),
    [{ targetRole: 'AI Agent', keywords: Array.from({ length: 51 }, (_, index) => `排除${index}`) }],
    [{ targetRole: 'AI Agent', keywords: Array(51).fill('产品经理') }],
  ]) assert.throws(() => validateConfig({ roleTitleExclusions: rules }));
});

test('product role exclusions apply only to the matching target and to title functions', () => {
  const config = validateConfig({ roleTitleExclusions: productExclusions });
  for (const title of ['AI Agent 产品经理实习生', 'AI Agent 产品策略实习生', '智能体产品运营实习生', 'AI Agent 产品实习生']) {
    const result = evaluateJob({ ...agentInternship, title }, config);
    assert.equal(result.eligible, false, title);
    assert.ok(result.reasons.some(reason => /标题|职能/.test(reason)));
  }
  assert.equal(evaluateJob({ ...agentInternship, title: '智能体产品研发工程师（实习）' }, config).eligible, true);
  assert.equal(evaluateJob({ ...agentInternship, description: '开发 Agent，与产品经理、产品运营合作。' }, config).eligible, true);
  assert.equal(evaluateJob({ ...agentInternship, title: 'AI Agent 产品经理实习生' }, { ...config, targetRole: ' ai　AGENT ' }).eligible, false);
  const productConfig = validateConfig({ targetRole: '产品经理', roleTitleExclusions: productExclusions });
  assert.equal(evaluateJob({ ...agentInternship, title: '产品经理实习生', description: '产品规划。' }, productConfig).eligible, true);
  assert.equal(evaluateJob({ ...agentInternship, title: '智能客服 Agent 开发实习生' }, config).eligible, false, 'explicit raw title keyword exclusions must retain their meaning');
});

test('shared precheck hard rejects configured title and company exclusions only', () => {
  assert.equal(typeof core.precheckJob, 'function');
  const config = validateConfig({ roleTitleExclusions: productExclusions, excludeCompanies: ['拒绝公司'] });
  for (const card of [{ title: 'AI Agent 销售实习生' }, { title: 'AI Agent 产品经理实习生' }, { company: '拒绝公司' }]) {
    assert.equal(core.precheckJob(card, config).rejected, true);
  }
  for (const card of [{}, { title: '后端工程师' }, { title: 'AI Agent 实习生', description: '与产品经理、销售及客服团队合作。' }, { title: '智能体产品研发实习生' }]) {
    assert.equal(core.precheckJob(card, config).rejected, false);
  }
});

test('title relevance follows configured target keywords rather than Agent-specific terms', () => {
  assert.equal(typeof core.precheckJob, 'function');
  const config = validateConfig({ targetRole: 'Java', requiredAny: ['Java', 'JVM'] });
  const score = title => core.precheckJob({ title }, config).titleScore;
  assert.ok(score('Java 开发实习生') > score('后端实习生'));
  assert.ok(score('JVM 后端实习生') > score('AI Agent 实习生'));
  assert.equal(score('JavaScript 前端实习生'), score('后端实习生'));
});

test('rejects unsafe config bounds, invalid city codes and role values', () => {
  for (const config of [
    { cityCode: '101020100' }, { roleType: 'manager' },
    { dailyLimit: -1 }, { runLimit: 1.5 }, { delaySeconds: -1 }, { delaySeconds: 0.5 },
    { delaySeconds: Infinity }, { maxPages: 101 }, { idleMinutes: -1 },
    { contactBatchSize: 0 }, { contactBatchSize: 21 }, { batchBreakMinutes: -1 },
    { queries: [] }, { requiredAny: [] }, { autoRun: 'maybe' },
    { greetingTemplate: '你好，{unsupported}' },
  ]) assert.throws(() => validateConfig(config));
});

test('maps selected common cities and refuses explicit conflicting codes', () => {
  assert.equal(validateConfig({ city: '上海' }).cityCode, '101020100');
  assert.equal(validateConfig({ ...defaultConfig, city: '上海' }).cityCode, '101020100');
  assert.equal(validateConfig({ city: '上海市', cityCode: '101020100' }).city, '上海');
  assert.equal(validateConfig({ city: '深圳', cityCode: '101280600' }).cityCode, '101280600');
  assert.throws(() => validateConfig({ city: '上海', cityCode: '101280600' }));
});

test('custom cities require their own valid supplied code and a literal city name', () => {
  assert.equal(validateConfig({ city: '自定义城', cityCode: '101999999' }).cityCode, '101999999');
  assert.equal(validateConfig({ city: '自定义城市', cityCode: '101999999' }).city, '自定义城');
  for (const input of [
    { city: '自定义城' }, { ...defaultConfig, city: '自定义城' },
    { city: '自定义城', cityCode: '' }, { city: '自定义城', cityCode: 'invalid' },
    { city: '', cityCode: '101999999' }, { city: '全国', cityCode: '101999999' },
    { city: '远程', cityCode: '101999999' }, { city: '上海/杭州', cityCode: '101020100' },
  ]) assert.throws(() => validateConfig(input));
});

test('selected Shanghai accepts city and districts while rejecting Beijing and mixed locations', () => {
  const config = validateConfig({ city: '上海' });
  for (const city of ['上海', '上海市', '上海·浦东新区', '上海 - 徐汇区']) {
    assert.equal(evaluateJob({ ...agentInternship, city }, config).eligible, true, city);
  }
  for (const city of ['北京', '', '上海之外', '上海总部', '上海·浦东新区 / 北京', '上海/杭州', '上海·远程']) {
    assert.equal(evaluateJob({ ...agentInternship, city }, config).eligible, false, city);
  }
  const custom = validateConfig({ city: '福州', cityCode: '101230100' });
  assert.equal(evaluateJob({ ...agentInternship, city: '福州·鼓楼区' }, custom).eligible, true);
  assert.equal(evaluateJob({ ...agentInternship, city: '北京' }, custom).eligible, false);
  const tianjin = validateConfig({ city: '天津' });
  assert.equal(evaluateJob({ ...agentInternship, city: '天津·和平区' }, tianjin).eligible, true);
});

test('normalizes cautious contact intervals and batch rest settings', () => {
  const config = validateConfig({ delaySeconds: '90', contactBatchSize: '5', batchBreakMinutes: '10' });
  assert.equal(config.delaySeconds, 90);
  assert.equal(config.contactBatchSize, 5);
  assert.equal(config.batchBreakMinutes, 10);
});

test('immediate defaults and examples preserve explicit saved nonzero timing', () => {
  const example=validateConfig(JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8')));
  for (const config of [validateConfig({}),example]) {
    for (const field of ['delaySeconds','idleMinutes','batchBreakMinutes']) assert.equal(config[field],0);
  }
  const saved=validateConfig({...defaultConfig,delaySeconds:90,contactBatchSize:5,batchBreakMinutes:10,idleMinutes:10});
  assert.equal(saved.delaySeconds,90);assert.equal(saved.batchBreakMinutes,10);assert.equal(saved.idleMinutes,10);
});

test('company goals are optional bounded integers and legacy configurations remain unlimited', () => {
  const goals = validateConfig({ contactCompanyTarget: '500', resumeCompanyTarget: '100' });
  assert.equal(goals.contactCompanyTarget, 500);
  assert.equal(goals.resumeCompanyTarget, 100);
  assert.equal(goals.companyDedup, false);
  const legacy = validateConfig({ targetRole: 'Java' });
  assert.equal(legacy.contactCompanyTarget, 0);
  assert.equal(legacy.resumeCompanyTarget, 0);
  assert.equal(validateConfig({ companyDedup: false }).companyDedup, false);
  for (const input of [{ contactCompanyTarget: -1 }, { resumeCompanyTarget: 1.5 }, { contactCompanyTarget: 1_000_001 }, { resumeCompanyTarget: Infinity }, { companyDedup: 'maybe' }]) assert.throws(() => validateConfig(input));
});

test('company-name filtering stays disabled for defaults, examples, and saved legacy true values', () => {
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(defaultConfig.companyDedup, false);
  assert.equal(example.companyDedup, false);
  for (const companyDedup of [true, false, 'true', 'false']) {
    assert.equal(validateConfig({ companyDedup }).companyDedup, false);
  }
});

test('company normalization merges formatting aliases without inventing entity aliases', () => {
  assert.equal(typeof core.normalizeCompany, 'function');
  assert.equal(core.normalizeCompany('  ＡＣＭＥ　 科技  '), 'acme 科技');
  assert.equal(core.normalizeCompany('ACME  科技'), 'acme 科技');
  assert.notEqual(core.normalizeCompany('ACME 科技集团'), core.normalizeCompany('ACME 科技'));
  assert.equal(core.normalizeCompany(''), '');
  assert.equal(core.normalizeCompany(null), '');
});

test('qualifies Beijing Agent internship with an explainable score', () => {
  const result = evaluateJob(agentInternship, defaultConfig);
  assert.equal(result.eligible, true);
  assert.ok(result.score > 0);
  assert.ok(result.reasons.every(reason => typeof reason === 'string'));
});

test('unknown and non-Beijing locations are never eligible', () => {
  for (const city of ['', undefined, '上海', '北京总部，工作地点上海', '北京之外', '北京/保定', '北京·海淀区·福州']) {
    const result = evaluateJob({ ...agentInternship, city }, defaultConfig);
    assert.equal(result.eligible, false, String(city));
    assert.ok(result.reasons.some(reason => /北京|地区|城市/.test(reason)));
  }
});

test('accepts Beijing district labels without admitting arbitrary prefixed places', () => {
  for (const city of ['北京', '北京市', '北京市朝阳区', '北京·海淀区·中关村', '北京 - 大兴区', '北京·石景山区']) {
    assert.equal(evaluateJob({ ...agentInternship, city }, defaultConfig).eligible, true, city);
  }
});

test('rejects sales titles without excluding engineers whose JD mentions sales', () => {
  assert.equal(evaluateJob({ ...agentInternship, title: 'AI Agent 销售实习生' }, defaultConfig).eligible, false);
  assert.equal(evaluateJob({ ...agentInternship, description: `${agentInternship.description}与销售和培训团队协作。` }, defaultConfig).eligible, true);
  assert.equal(evaluateJob({ ...agentInternship, title: '智能体数据标注实习生' }, defaultConfig).eligible, false);
});

test('internship requires an explicit role signal and Agent must be substantive', () => {
  assert.equal(evaluateJob({ ...agentInternship, title: '后端工程师', tags: ['经验不限'], description: '需要具备实习经验，开发 Agent 系统。' }, defaultConfig).eligible, false);
  assert.equal(evaluateJob({ ...agentInternship, title: 'Management 实习生', description: '普通管理工作。' }, defaultConfig).eligible, false);
  assert.equal(evaluateJob({ ...agentInternship, title: '后端工程师', tags: ['经验不限'], description: '招聘实习生，开发智能体系统。' }, defaultConfig).eligible, true);
});

test('supports graduate, experienced and unrestricted roles without conflating them', () => {
  const graduate = { ...agentInternship, title: 'AI Agent 工程师（应届校招）', tags: ['应届生'] };
  const experienced = { ...agentInternship, title: 'AI Agent 工程师', tags: ['3-5年'], description: '开发智能体产品。' };
  assert.equal(evaluateJob(graduate, { ...defaultConfig, roleType: 'graduate' }).eligible, true);
  assert.equal(evaluateJob(graduate, { ...defaultConfig, roleType: 'experienced' }).eligible, false);
  assert.equal(evaluateJob(experienced, { ...defaultConfig, roleType: 'experienced' }).eligible, true);
  assert.equal(evaluateJob(experienced, { ...defaultConfig, roleType: 'any' }).eligible, true);
});

test('negative internship wording never turns a formal role into an internship', () => {
  const formal = { ...agentInternship, title: 'AI Agent 工程师', tags: ['3-5年'], description: '开发智能体。' };
  for (const wording of ['非实习', '不招实习', '不招聘实习生', '不接受实习生']) {
    const job = { ...formal, title: `${formal.title}（${wording}）` };
    assert.equal(evaluateJob(job, { ...defaultConfig, roleType: 'internship' }).eligible, false, wording);
    assert.equal(evaluateJob(job, { ...defaultConfig, roleType: 'experienced' }).eligible, true, wording);
  }
  assert.equal(evaluateJob({ ...formal, description: '不招聘实习生，开发智能体。' }, { ...defaultConfig, roleType: 'internship' }).eligible, false);
});

test('campus recruiting software experience does not declare a graduate opening', () => {
  for (const business of ['校园招聘系统', '校园招聘平台', '校园招聘业务']) {
    const job = { ...agentInternship, title: 'AI Agent 工程师', tags: ['3-5年'], description: `开发 AI Agent；有${business}开发经验优先。` };
    assert.equal(evaluateJob(job, { ...defaultConfig, roleType: 'graduate' }).eligible, false, business);
    assert.equal(evaluateJob(job, { ...defaultConfig, roleType: 'experienced' }).eligible, true, business);
  }
});

test('explicit role types still qualify after removing irrelevant type wording', () => {
  const plain = { ...agentInternship, title: 'AI Agent 工程师', tags: [], description: '开发智能体。' };
  for (const description of ['招聘实习生，开发智能体。', '岗位类型：实习', '招募实习生', '实习生岗位']) {
    assert.equal(evaluateJob({ ...plain, description }, { ...defaultConfig, roleType: 'internship' }).eligible, true, description);
  }
  for (const description of ['校园招聘，开发智能体。', '招聘应届生', '岗位类型：应届']) {
    assert.equal(evaluateJob({ ...plain, description }, { ...defaultConfig, roleType: 'graduate' }).eligible, true, description);
  }
  assert.equal(evaluateJob(plain, { ...defaultConfig, roleType: 'experienced' }).eligible, false);
  assert.equal(evaluateJob(plain, { ...defaultConfig, roleType: 'any' }).eligible, true);
  assert.equal(validateConfig({ ...defaultConfig, roleType: 'any' }).roleType, 'any');
});

test('company exclusions and required keyword edits affect eligibility', () => {
  assert.equal(evaluateJob(agentInternship, { ...defaultConfig, excludeCompanies: ['示例科技'] }).eligible, false);
  assert.equal(evaluateJob(agentInternship, { ...defaultConfig, requiredAny: ['LangGraph'] }).eligible, false);
  assert.equal(evaluateJob({ ...agentInternship, description: '开发 LangGraph 智能体。' }, { ...defaultConfig, requiredAny: ['LangGraph'] }).eligible, true);
});

test('greeting substitutes truthful provided profile data and no invented claims', () => {
  const config = validateConfig({ greetingTemplate: '您好，关注{company}的{title}。{profileSummary}', profileSummary: '我是研二学生。' });
  assert.equal(renderGreeting(agentInternship, config), '您好，关注示例科技的AI Agent 开发实习生。我是研二学生。');
  assert.equal(renderGreeting(agentInternship, { ...config, profileSummary: '' }), '您好，关注示例科技的AI Agent 开发实习生。');
});

test('deduplicates BOSS detail links across tracking params and mobile hosts', () => {
  const variants = [
    { id: 'abc123' },
    { url: 'https://www.zhipin.com/job_detail/abc123.html?ka=one&lid=two#tracking' },
    { url: 'http://m.zhipin.com/job_detail/abc123.html?securityId=other' },
  ];
  for (const job of variants) assert.equal(jobKey(job), 'job:abc123');
  assert.equal(jobKey({ url: '/job_detail/abc123.html?ka=x' }), 'job:abc123');
  assert.equal(jobKey({ url: 'https://example.com/jobs/abc?utm_source=a&role=2' }), 'url:https://example.com/jobs/abc?role=2');
  assert.throws(() => jobKey({ title: 'missing identity' }));
});

test('contact dates use Hong Kong midnight rather than UTC midnight', () => {
  assert.equal(dateKey(new Date('2026-10-06T15:59:59Z')), '2026-10-06');
  assert.equal(dateKey(new Date('2026-10-06T16:00:00Z')), '2026-10-07');
  assert.throws(() => dateKey(new Date('invalid')));
});

test('zero extra waiting is valid and is the source and example default', () => {
  const zero = validateConfig({ delaySeconds: '0', batchBreakMinutes: '0', idleMinutes: '0' });
  const example = validateConfig(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
  for (const config of [zero, validateConfig({}), example]) {
    for (const field of ['delaySeconds', 'batchBreakMinutes', 'idleMinutes']) assert.equal(config[field], 0);
  }
  assert.equal(validateConfig({ delaySeconds: 1, batchBreakMinutes: 1, idleMinutes: 1 }).delaySeconds, 1);
});

test('community presets expand chosen roles without retaining irrelevant default blockers',()=>{
 const model=validateConfig({targetRole:'大模型算法',roleType:'any'});
 assert.ok(model.requiredAny.includes('LLM'));assert.ok(model.requiredAny.includes('大模型'));
 const sales=validateConfig({targetRole:'销售',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'销售专员',description:'客户开发与销售跟进。'},sales).eligible,true);
 assert.equal(sales.excludeKeywords.includes('销售'),false);assert.equal(sales.excludeKeywords.includes('电销'),false);assert.equal(sales.excludeKeywords.includes('客服'),true);
 const custom=validateConfig({targetRole:'销售',excludeKeywords:['销售','某公司内部岗位'],roleType:'any'});
 assert.deepEqual(custom.excludeKeywords,['销售','某公司内部岗位']);
});

test('native BOSS combined labels match their actual role alternatives',()=>{
 const cpp=validateConfig({targetRole:'C/C++',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'C++开发工程师',description:'开发C++服务与底层系统。'},cpp).eligible,true);
 const assistant=validateConfig({targetRole:'产品专员/助理',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'产品助理',description:'产品需求调研和项目协作。'},assistant).eligible,true);
 const go=validateConfig({targetRole:'Golang',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'Go开发工程师',description:'使用Go开发后端服务。'},go).eligible,true);
 assert.equal(evaluateJob({...agentInternship,title:'Google广告投放',description:'负责广告。'},go).eligible,false);
});

test('native technical titles accept common job-title spellings without requiring the taxonomy suffix',()=>{
 const frontend=validateConfig({targetRole:'前端开发工程师',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'Web前端工程师',description:'开发网页应用。'},frontend).eligible,true);
 const embedded=validateConfig({targetRole:'嵌入式软件工程师',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'嵌入式开发',description:'开发嵌入式系统。'},embedded).eligible,true);
 const analyst=validateConfig({targetRole:'数据分析师',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'数据分析实习生',description:'数据分析与报表。'},analyst).eligible,true);
});

test('native education choices allow their family terminology while keeping explicit exclusions',()=>{
 const course=validateConfig({targetRole:'课程顾问',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'招生课程顾问',description:'课程咨询和招生服务。'},course).eligible,true);
 const teacher=validateConfig({targetRole:'少儿编程老师',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'少儿编程老师/讲师',description:'少儿编程教学。'},teacher).eligible,true);
 const explicit=validateConfig({targetRole:'课程顾问',roleType:'any',excludeKeywords:['招生']});
 assert.equal(evaluateJob({...agentInternship,title:'招生课程顾问'},explicit).eligible,false);
 assert.deepEqual(explicit.excludeKeywords,['招生']);
 assert.ok(validateConfig().excludeKeywords.includes('招生'));
});

test('native slash labels retain shared job functions instead of matching unrelated nouns',()=>{
 const media=validateConfig({targetRole:'语音/视频/图形开发',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'视频开发工程师',description:'实现视频编解码。'},media).eligible,true);
 assert.equal(evaluateJob({...agentInternship,title:'视频剪辑',description:'负责短视频拍摄剪辑。'},media).eligible,false);
 const repair=validateConfig({targetRole:'电脑/打印机维修',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'电脑维修员',description:'电脑硬件维修。'},repair).eligible,true);
 assert.equal(evaluateJob({...agentInternship,title:'电脑店导购',description:'电脑产品介绍与销售。'},repair).eligible,false);
 const food=validateConfig({targetRole:'食品/饮料研发',roleType:'any'});
 assert.equal(evaluateJob({...agentInternship,title:'食品研发工程师'},food).eligible,true);
 assert.equal(evaluateJob({...agentInternship,title:'食品质检员',description:'食品检验与抽样。'},food).eligible,false);
});

test('verified nationwide selection accepts concrete BOSS locations and rejects uncertain geography',()=>{
 const national=validateConfig({city:'全国'});
 assert.equal(national.cityCode,'100010000');assert.throws(()=>validateConfig({city:'全国',cityCode:'101010100'}));
 for(const city of ['北京·朝阳区','福州·鼓楼区','沈阳·和平区','乌鲁木齐','深圳市南山区'])assert.equal(evaluateJob({...agentInternship,city},national).eligible,true,city);
 for(const city of ['',undefined,'全国','远程','未知城市','北京/上海','福州·远程','海外·纽约'])assert.equal(evaluateJob({...agentInternship,city},national).eligible,false,String(city));
});

test('official city names do not conflate district homonyms with another city',()=>{
 for(const city of ['北京市朝阳区','北京·朝阳区','北京·朝阳区·望京'])assert.equal(evaluateJob({...agentInternship,city},defaultConfig).eligible,true,city);
 for(const city of ['北京·海淀区·朝阳','北京·海淀区·朝阳市','北京·海淀区·朝阳市双塔区'])assert.equal(evaluateJob({...agentInternship,city},defaultConfig).eligible,false,city);
 const fuzhou=validateConfig({city:'福州'});assert.equal(fuzhou.cityCode,'101230100');
 assert.equal(evaluateJob({...agentInternship,city:'福州·鼓楼区'},fuzhou).eligible,true);
 assert.equal(evaluateJob({...agentInternship,city:'福州·鼓楼区·厦门思明区'},fuzhou).eligible,false);
 assert.equal(evaluateJob({...agentInternship,city:'深圳·南山区·广州天河区'},validateConfig({city:'深圳'})).eligible,false);
});
