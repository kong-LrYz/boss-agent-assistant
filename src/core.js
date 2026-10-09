import { CITY_CODES } from './cities.js';
import { findJobPreset, presetSearchDefaults } from './job-presets.js';
export { CITY_CODES } from './cities.js';

const roleTypes = new Set(['internship', 'graduate', 'experienced', 'any']);
const defaultValues = {
  setupComplete: false,
  autoRun: true,
  city: '北京',
  cityCode: '101010100',
  targetRole: 'AI Agent',
  roleType: 'internship',
  queries: ['AI Agent', '智能体', 'Agent开发', 'LLM Agent'],
  requiredAny: ['agent', '智能体'],
  excludeKeywords: ['销售', '电销', '客服', '招生', '讲师', '培训师', '数据标注', '标注员'],
  excludeCompanies: [],
  roleTitleExclusions: [],
  greetingTemplate: '您好，我对{company}的{title}岗位感兴趣。{profileSummary}希望进一步了解工作内容，期待与您沟通，谢谢。',
  profileSummary: '',
  resumeName: '',
  dailyLimit: 0,
  runLimit: 0,
  contactCompanyTarget: 0,
  resumeCompanyTarget: 0,
  companyDedup: false,
  delaySeconds: 0,
  maxPages: 5,
  idleMinutes: 0,
  contactBatchSize: 5,
  batchBreakMinutes: 0,
};
for (const value of Object.values(defaultValues)) if (Array.isArray(value)) Object.freeze(value);
export const defaultConfig = Object.freeze(defaultValues);

function text(value, field, maxLength, allowEmpty = true) {
  if (typeof value !== 'string') throw new TypeError(`${field} 必须是文本`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength || normalized.includes('\0')) {
    throw new RangeError(`${field} 内容为空或过长`);
  }
  return normalized;
}

function list(value, field, { maxItems = 50, maxLength = 100, required = false } = {}) {
  const items = typeof value === 'string' ? value.split(/[,，、;；\n]+/) : value;
  if (!Array.isArray(items)) throw new TypeError(`${field} 必须是列表`);
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const term = text(item, field, maxLength);
    if (term && !seen.has(term.toLocaleLowerCase())) {
      seen.add(term.toLocaleLowerCase());
      normalized.push(term);
    }
  }
  if (normalized.length > maxItems || (required && normalized.length === 0)) throw new RangeError(`${field} 数量不符合要求`);
  return normalized;
}

function boolean(value, field) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${field} 必须是布尔值`);
}

function integer(value, field, min, max) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

export function normalizeTargetRole(value) {
  const normalized = text(value, 'targetRole', 100, false).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return text(normalized, 'targetRole', 100, false);
}

export function normalizeCompany(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function roleTitleRules(value) {
  if (!Array.isArray(value) || value.length > 20) throw new RangeError('roleTitleExclusions 必须是最多 20 条规则的数组');
  const seen = new Set();
  return value.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(key => !['targetRole', 'keywords'].includes(key))) throw new TypeError('标题职能规则只接受 targetRole 和 keywords');
    const targetRole = text(rule.targetRole, 'roleTitleExclusions.targetRole', 100, false).normalize('NFKC').trim().replace(/\s+/g, ' ');
    const key = normalizeTargetRole(targetRole);
    if (seen.has(key)) throw new RangeError('标题职能规则的目标岗位不能重复');
    seen.add(key);
    if (!Array.isArray(rule.keywords) || rule.keywords.length < 1 || rule.keywords.length > 50) throw new TypeError('标题职能规则 keywords 必须是 1 到 50 条文本的数组');
    const keywords = list(rule.keywords.map(value => text(text(value, 'roleTitleExclusions.keywords', 100, false).normalize('NFKC'), 'roleTitleExclusions.keywords', 100, false)), 'roleTitleExclusions.keywords', { maxItems: 50, required: true });
    return { targetRole, keywords };
  });
}

export function roleSearchDefaults(targetRole = defaultConfig.targetRole) {
  const role = text(targetRole, 'targetRole', 100, false);
  return presetSearchDefaults(role);
}

export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('配置必须是对象');
  const config = { ...defaultConfig, ...input };
  const targetRole = text(config.targetRole, 'targetRole', 100, false);
  if (Object.hasOwn(input, 'targetRole')) {
    const preset = roleSearchDefaults(targetRole);
    for (const field of ['queries', 'requiredAny']) if (!Object.hasOwn(input, field)) config[field] = preset[field];
    if (!Object.hasOwn(input, 'excludeKeywords')) {
      const allowed=findJobPreset(targetRole)?.allowExcludedKeywords||[];
      config.excludeKeywords=defaultConfig.excludeKeywords.filter(term=>!allowed.includes(term));
    }
  }
  // Validate legacy input, but company names never suppress distinct jobs.
  boolean(config.companyDedup, 'companyDedup');
  const cityName=text(config.city,'city',40,false);
  const normalized = {
    setupComplete: boolean(config.setupComplete, 'setupComplete'),
    autoRun: boolean(config.autoRun, 'autoRun'),
    city: CITY_CODES[cityName]?cityName:cityName.replace(/市$/, ''),
    cityCode: text(config.cityCode, 'cityCode', 20, false),
    targetRole,
    roleType: text(config.roleType, 'roleType', 30, false),
    queries: list(config.queries, 'queries', { maxItems: 20, required: true }),
    requiredAny: list(config.requiredAny, 'requiredAny', { required: true }),
    excludeKeywords: list(config.excludeKeywords, 'excludeKeywords'),
    excludeCompanies: list(config.excludeCompanies, 'excludeCompanies', { maxItems: 100, maxLength: 200 }),
    roleTitleExclusions: roleTitleRules(config.roleTitleExclusions),
    greetingTemplate: text(config.greetingTemplate, 'greetingTemplate', 1000, false),
    profileSummary: text(config.profileSummary, 'profileSummary', 1000),
    resumeName: text(config.resumeName, 'resumeName', 200),
    dailyLimit: integer(config.dailyLimit, 'dailyLimit', 0, 1_000_000),
    runLimit: integer(config.runLimit, 'runLimit', 0, 1_000_000),
    contactCompanyTarget: integer(config.contactCompanyTarget, 'contactCompanyTarget', 0, 1_000_000),
    resumeCompanyTarget: integer(config.resumeCompanyTarget, 'resumeCompanyTarget', 0, 1_000_000),
    companyDedup: false,
    delaySeconds: integer(config.delaySeconds, 'delaySeconds', 0, 3600),
    maxPages: integer(config.maxPages, 'maxPages', 1, 100),
    idleMinutes: integer(config.idleMinutes, 'idleMinutes', 0, 1440),
    contactBatchSize: integer(config.contactBatchSize, 'contactBatchSize', 1, 20),
    batchBreakMinutes: integer(config.batchBreakMinutes, 'batchBreakMinutes', 0, 1440),
  };
  const nationwide=normalized.city==='全国'&&CITY_CODES.全国==='100010000';
  if (!nationwide&&(!/^[\p{Script=Han}]{2,40}$/u.test(normalized.city) || /全国|远程|不限|海外|全省|周边|出差|总部|线上/.test(normalized.city))) {
    throw new RangeError('请指定一个明确的城市名称');
  }
  const knownCode = CITY_CODES[normalized.city];
  if (knownCode) {
    if (!Object.hasOwn(input, 'cityCode') || (!nationwide&&normalized.city !== defaultConfig.city && normalized.cityCode === defaultConfig.cityCode)) normalized.cityCode = knownCode;
    else if (normalized.cityCode !== knownCode) throw new RangeError('城市名称与城市编码不一致');
  } else if (!Object.hasOwn(input, 'cityCode') || normalized.cityCode === defaultConfig.cityCode) {
    throw new RangeError('自定义城市需要填写对应的 9 位城市编码，不能沿用北京编码');
  }
  if (!/^\d{9}$/.test(normalized.cityCode)) throw new RangeError('城市编码必须是 9 位数字');
  if (!roleTypes.has(normalized.roleType)) throw new RangeError('不支持的岗位类型');
  for (const match of normalized.greetingTemplate.matchAll(/\{([^{}]+)\}/g)) {
    if (!['title', 'company', 'profileSummary'].includes(match[1])) throw new RangeError(`未知招呼模板字段：${match[1]}`);
  }
  return normalized;
}

function jobText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function contains(haystack, needle) {
  const term = needle.toLocaleLowerCase();
  const source = haystack.toLocaleLowerCase();
  if (/^[a-z]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z])${escaped}(?![a-z])`, 'i').test(source);
  }
  return source.includes(term);
}

function isBeijing(city) {
  if (city === '北京' || city === '北京市') return true;
  const district = '(?:东城|西城|朝阳|丰台|石景山|海淀|门头沟|房山|通州|顺义|昌平|大兴|怀柔|平谷|密云|延庆)';
  if (!new RegExp(`^北京市?[\\s·\\-—/]*${district}[区县]?(?:$|[\\s·\\-—/].+)`).test(city)) return false;
  // A headquarters mention is insufficient if the location also names another city.
  if (/(总部|上海|天津|深圳|广州|杭州|成都|南京|苏州|武汉|重庆|西安|长沙|郑州|济南|青岛|合肥|厦门|珠海|东莞|海外|远程)/.test(city)) return false;
  return true;
}

const concreteCityNames=[...new Set(Object.keys(CITY_CODES).filter(name=>name!=='全国').map(name=>name.replace(/市$/u,'')))].sort((a,b)=>b.length-a.length);
const otherCityMention=new RegExp(`(${concreteCityNames.join('|')})(?:市(?=$|[\\p{Script=Han}\\s·\\-—/,，、|])|(?=$|[\\s·\\-—/,，、|])|(?=[\\p{Script=Han}]{1,20}(?:区|县|市)(?:$|[\\s·\\-—/,，、|])))`,'gu');
function matchesCity(city, selected) {
  if(selected==='全国'){
    const concrete=concreteCityNames.find(name=>city.startsWith(name));
    return Boolean(concrete&&matchesCity(city,concrete));
  }
  selected=selected.replace(/市$/u,'');
  if (/总部|远程|海外|全国|工作地点|异地|出差/.test(city)) return false;
  if (city === selected || city === `${selected}市`) return true;
  if (!city.startsWith(selected)) return false;
  const suffix = city.slice(selected.length).replace(/^市/, '').replace(/^[\s·\-—/]+/, '');
  if (/[,，、/|]/.test(suffix)) return false;
  for(const match of suffix.matchAll(otherCityMention))if(match[1]!==selected)return false;
  if (selected === '北京') return isBeijing(city);
  return /^[\p{Script=Han}]+(?:区|县|市|镇|街道)(?:$|[\s·\-—].+)/u.test(suffix);
}

function matchesRole(job, roleType, title, tags, description) {
  if (roleType === 'any') return true;
  // A negated type is not positive hiring evidence, even inside a title.
  const negativeInternship = /(?:非|不是|不招(?:聘|收)?|不接受|不接收|暂不招(?:聘|收)?)\s*实习(?:生)?/g;
  const explicit = `${title} ${tags}`.replace(negativeInternship, '');
  const typeDescription = description.replace(negativeInternship, '');
  const internship = /实习/.test(explicit) || /(?:岗位类型\s*[:：]\s*实习|招聘实习生|招募实习生|实习生岗位)/.test(typeDescription);
  const graduate = /应届|校招|校园招聘|毕业生/.test(explicit) || /(?:岗位类型\s*[:：]\s*应届|招聘应届生|校园招聘(?!\s*(?:系统|平台|业务)))/.test(typeDescription);
  const declared = job.roleType;
  if (roleType === 'internship') return declared === 'internship' || internship;
  if (roleType === 'graduate') return !internship && (declared === 'graduate' || graduate);
  return !internship && !graduate && (declared === 'experienced' || /社招|社会招聘|(?:\d+\s*[-–~至]\s*\d+|\d+年以上?)\s*年?/.test(explicit));
}

function checkTitleAndCompany(job, config) {
  const title = jobText(job?.title);
  const company = jobText(job?.company);
  const reasons = [];
  const excludedTitle = config.excludeKeywords.find(keyword => contains(title, keyword));
  if (excludedTitle) reasons.push(`岗位名称命中排除关键词：${excludedTitle}`);
  const target = normalizeTargetRole(config.targetRole);
  const rule = config.roleTitleExclusions.find(rule => normalizeTargetRole(rule.targetRole) === target);
  const excludedRole = rule?.keywords.find(keyword => contains(title, keyword));
  if (excludedRole) reasons.push(`“${config.targetRole}”标题职能命中排除规则：${excludedRole}`);
  const excludedCompany = config.excludeCompanies.find(keyword => contains(company, keyword));
  if (excludedCompany) reasons.push(`公司命中排除名单：${excludedCompany}`);
  const titleScore = (contains(title, jobText(config.targetRole)) ? 2 : 0) + config.requiredAny.filter(keyword => contains(title, keyword)).length;
  return { rejected: reasons.length > 0, titleScore, reasons };
}

export function precheckJob(job, input = defaultConfig) {
  return checkTitleAndCompany(job, validateConfig(input));
}

export function evaluateJob(job, input = defaultConfig) {
  const config = validateConfig(input);
  if (!job || typeof job !== 'object') return { eligible: false, score: 0, reasons: ['岗位信息缺失'] };
  const title = jobText(job.title);
  const description = jobText(job.description);
  const tags = Array.isArray(job.tags) ? job.tags.map(jobText).join(' ') : jobText(job.tags);
  const city = jobText(job.city);
  const combined = `${title} ${description} ${tags}`;
  const reasons = [];
  let score = 0;
  if (!matchesCity(city, config.city)) reasons.push(city ? `岗位地区未确认为${config.city}` : `岗位城市缺失，需读取详情确认${config.city}`);
  else score += 10;
  if (!title) reasons.push('岗位名称缺失');
  const keywords = config.requiredAny.filter(keyword => contains(combined, keyword));
  if (!keywords.length) reasons.push(`岗位内容未命中“${config.targetRole}”目标关键词：${config.requiredAny.join(' / ')}`);
  else {
    score += 20;
    if (keywords.some(keyword => contains(title, keyword))) score += 40;
    if (keywords.some(keyword => contains(description, keyword))) score += 10;
  }
  reasons.push(...checkTitleAndCompany(job, config).reasons);
  if (!matchesRole(job, config.roleType, title, tags, description)) reasons.push('岗位类型不符合设置，或缺少明确类型证据');
  else score += 20;
  return { eligible: reasons.length === 0, score, reasons };
}

export function renderGreeting(job, input = defaultConfig) {
  const config = validateConfig(input);
  const values = { title: jobText(job?.title), company: jobText(job?.company), profileSummary: config.profileSummary };
  return config.greetingTemplate.replace(/\{(title|company|profileSummary)\}/g, (_, key) => values[key]).trim();
}

function normalizeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const id = String(value).trim().replace(/\.html$/i, '');
  if (!id || id.length > 512 || /[\s\0/?#]/.test(id)) throw new TypeError('岗位 ID 无效');
  return id;
}

export function jobKey(job) {
  if (!job || typeof job !== 'object') throw new TypeError('缺少岗位身份');
  let url;
  if (typeof job.url === 'string' && job.url.trim()) {
    try { url = new URL(job.url.trim(), 'https://www.zhipin.com'); }
    catch { throw new TypeError('岗位 URL 无效'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('岗位 URL 必须是 HTTP(S)');
    const match = url.pathname.match(/\/job_detail\/([^/]+?)(?:\.html)?\/?$/i);
    if (match) return `job:${normalizeId(decodeURIComponent(match[1]))}`;
  }
  const id = normalizeId(job.id);
  if (id) return `job:${id}`;
  if (url) {
    url.protocol = 'https:';
    url.hash = '';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|ka|lid|traceId|trackingId|source|from|sessionId|securityId|kpt|bg)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.toString()}`;
  }
  if (typeof job.key === 'string' && /^(?:job:|url:)/.test(job.key)) return job.key;
  throw new TypeError('岗位缺少稳定 ID 或 URL');
}

export function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('日期无效');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
