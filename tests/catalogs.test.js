import test from 'node:test';
import assert from 'node:assert/strict';
import { CITY_CODES } from '../src/cities.js';
import { roleSearchDefaults, validateConfig } from '../src/core.js';

test('selectable catalog has grouped broad roles and independent preset lists',async()=>{
 const { CHOICE_CATALOGS } = await import('../src/catalogs.js');
 const roles=CHOICE_CATALOGS.roleGroups.flatMap(group=>group.options);
 assert.ok(CHOICE_CATALOGS.roleGroups.length>=10);assert.ok(roles.length>=70);
 assert.ok(new Set(roles.map(option=>option.targetRole)).size>=800);assert.ok(CHOICE_CATALOGS.roleSource.sourceUrls.includes('https://www.zhipin.com/'));
 for(const direction of ['AI Agent','大模型算法','Java','软件测试','产品经理','平面设计','新媒体运营','销售专员','会计','人力资源专员/助理','机械工程师','物流运营'])assert.ok(roles.some(option=>option.targetRole===direction),direction);
 for(const option of roles){const first=roleSearchDefaults(option.targetRole);assert.ok(first.queries.length>0);assert.ok(first.requiredAny.length>0);first.queries.push('test');assert.ok(!roleSearchDefaults(option.targetRole).queries.includes('test'));}
});

test('city catalog offers explicit public search codes and keeps Beijing default',async()=>{
 const { CHOICE_CATALOGS }=await import('../src/catalogs.js');
 const options=CHOICE_CATALOGS.cityGroups.flatMap(group=>group.options);
 assert.ok(options.length>=100);assert.ok(CHOICE_CATALOGS.citySource.sourceUrls.every(url=>new URL(url).hostname.endsWith('zhipin.com')));
 const distinct=new Map(options.map(option=>[option.name,option.code]));
 assert.equal(CHOICE_CATALOGS.cityGroups.length,35);assert.equal(CHOICE_CATALOGS.citySource.cityCount,373);assert.equal(distinct.size,374);
 assert.equal(CHOICE_CATALOGS.citySource.sourceDataSha256,'ba0f697bd4ca937ff047c9c92ae617f9213762e2344dd3f26fcab1f01be1b64b');
 assert.equal(distinct.get('全国'),'100010000');assert.equal(distinct.get('北京'),'101010100');assert.equal(distinct.get('深圳'),'101280600');
 for(const [name,code] of distinct){assert.match(code,/^\d{9}$/u);assert.equal(CITY_CODES[name],code);assert.equal(validateConfig({city:name}).cityCode,code);}
 assert.equal(validateConfig().city,'北京');
});
