import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { basename, join, resolve } from 'node:path';
import { validateConfig, jobKey } from '../src/core.js';
import { findChromeExecutable } from '../src/chrome-runtime.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const greetingStates = new Set(['none', 'intent', 'sent', 'existing', 'uncertain']);
const resumeStates = new Set(['none', 'intent', 'requested', 'sent', 'unavailable', 'uncertain']);

function readJson(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('必须是普通文件');
    return { exists: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw new Error(`无法只读检查 ${basename(file)}：${error.message}`);
  }
}

function inspectData(dataDir) {
  try {
    const stat = lstatSync(dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('数据目录必须是普通目录');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const configFile = readJson(join(dataDir, 'config.json'));
  const stateFile = readJson(join(dataDir, 'state.json'));
  const config = validateConfig(configFile.exists ? configFile.value : {});
  if (!stateFile.exists) {
    if (configFile.exists) throw new Error('已配置的数据目录缺少 state.json 状态文件，请恢复原文件后启动');
    return '首次启动时填写；诊断未创建数据目录或文件';
  }
  const state = stateFile.value;
  if (!object(state) || state.version !== 1 || !object(state.jobs) || !Array.isArray(state.events) || state.events.some(event => !object(event))) {
    throw new Error('状态文件格式损坏或版本不受支持');
  }
  let pending = 0;
  for (const [key, record] of Object.entries(state.jobs)) {
    if (!object(record) || record.key !== key || !greetingStates.has(record.greetingStatus) || !resumeStates.has(record.resumeStatus)) throw new Error(`岗位动作状态无效：${key}`);
    if (jobKey(record) !== key) throw new Error(`岗位身份标识不一致：${key}`);
    for (const field of ['createdAt', 'updatedAt']) {
      if (typeof record[field] !== 'string' || !Number.isFinite(Date.parse(record[field]))) throw new Error(`岗位 ${field} 无效：${key}`);
    }
    if (record.contactedAt !== null && record.contactedAt !== undefined && !Number.isFinite(Date.parse(record.contactedAt))) throw new Error(`岗位 contactedAt 无效：${key}`);
    pending += Number(record.greetingStatus === 'intent') + Number(record.resumeStatus === 'intent');
  }
  return `${config.setupComplete ? '已配置' : '首次启动时填写'}，${Object.keys(state.jobs).length} 条岗位记录${pending ? `；${pending} 个未确认操作意图保持原状态，由启动流程恢复` : ''}`;
}

const major = Number(process.versions.node.split('.')[0]);
const chromePath = await findChromeExecutable();
const checks = [
  ['Node.js >=22', major >= 22, process.version],
  ['实际运行所需的 Google Chrome', Boolean(chromePath), chromePath || '未找到；请从 https://www.google.com/chrome/ 自行安装，或设置 BOSS_CHROME_PATH'],
  ['控制台文件', existsSync(resolve(import.meta.dirname, '../public/index.html')), 'public/index.html']
];
try {
  const dataDir = resolve(process.env.BOSS_DATA_DIR || resolve(import.meta.dirname, '../data'));
  checks.push(['设置和记录只读检查', true, inspectData(dataDir)]);
} catch (error) { checks.push(['设置和记录可读取', false, error.message]); }
for (const [label, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${label}：${detail}`);
const fixturePath = chromium.executablePath();
console.log(`${existsSync(fixturePath) ? '✓' : '○'} 可选的 fixture 测试 Chromium：${existsSync(fixturePath) ? fixturePath : '未安装；只有运行 npm test 时才需先执行 npm run setup'}`);
console.log('实际求职使用独立普通 Google Chrome 与本项目扩展连接，不会修改浏览器指纹或绕过验证。');
console.log('BOSS 本人扫码、真实岗位聊天及附件投递：仍须在线验证。');
if (checks.some(c => !c[1])) process.exitCode = 1;
