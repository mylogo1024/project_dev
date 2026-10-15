'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CATEGORIES,
  FAVORITE_LIMIT,
  FUNCTIONS,
  buildFavorites,
  findFunction,
  scoreFunction,
  searchFunctions
} = require('../src/lib/functions');

const ids = (list) => list.map((item) => item.id);

test('the registry is internally consistent', () => {
  const seen = new Set();
  for (const item of FUNCTIONS) {
    assert.ok(item.id && item.name && item.icon, `${item.id} 缺少必要字段`);
    assert.ok(!seen.has(item.id), `重复的功能 id: ${item.id}`);
    seen.add(item.id);
    assert.ok(Array.isArray(item.keywords) && item.keywords.length, `${item.id} 没有关键词，搜不到`);
    assert.equal(findFunction(item.id)?.id, item.id);
  }
  // 首页分类不能引用不存在的功能，也不能漏掉任何一个
  const inCategories = CATEGORIES.flatMap((category) => category.functions);
  assert.equal(new Set(inCategories).size, inCategories.length, '分类里有重复引用');
  for (const id of inCategories) assert.ok(seen.has(id), `分类引用了不存在的功能: ${id}`);
  assert.equal(new Set(inCategories).size, FUNCTIONS.length, '有功能没被放进任何分类');
});

test('exact and prefix name matches outrank keyword matches', () => {
  // 「文本工具」的关键词里也有 json，但搜 json 时「JSON 工具」必须排前面
  const result = ids(searchFunctions('json'));
  assert.equal(result[0], 'json');
  assert.ok(result.includes('text'));

  const sign = ids(searchFunctions('签名'));
  assert.equal(sign[0], 'sign');
});

test('users can find things by what they call them, not by our names', () => {
  // 搜 "apk" 应该覆盖安装 / 反编译 / 读信息 / 签名这几件事
  const apk = ids(searchFunctions('apk'));
  for (const id of ['install', 'decompile', 'info', 'sign']) {
    assert.ok(apk.includes(id), `搜 apk 应该能找到 ${id}`);
  }
  // 常用缩写与英文
  assert.ok(ids(searchFunctions('adb')).includes('files'));
  assert.ok(ids(searchFunctions('logcat')).includes('logs'));
  assert.ok(ids(searchFunctions('keystore')).includes('sign'));
  assert.ok(ids(searchFunctions('回编译')).includes('decompile'));
  assert.ok(ids(searchFunctions('zipalign')).includes('sign'));
  assert.ok(ids(searchFunctions('正则')).includes('text'));
  assert.ok(ids(searchFunctions('投屏')).includes('scrcpy'));
  assert.ok(ids(searchFunctions('截图')).includes('phone-device'));
  assert.ok(ids(searchFunctions('wifi')).includes('web-file-server'));
  assert.ok(ids(searchFunctions('重命名')).includes('rename'));
  assert.ok(ids(searchFunctions('思维导图')).includes('xmind'));
});

test('matching is case insensitive and tolerates surrounding spaces', () => {
  assert.deepEqual(ids(searchFunctions('JSON')), ids(searchFunctions('json')));
  assert.deepEqual(ids(searchFunctions('  adb  ')), ids(searchFunctions('adb')));
});

test('fuzzy subsequence match works as a last resort', () => {
  // 「日查」能命中「实时日志查看」
  assert.ok(ids(searchFunctions('日查')).includes('logs'));
  // 「lgs」能命中 id 'logs'
  assert.ok(ids(searchFunctions('lgs')).includes('logs'));
  // 子序列匹配的排名要低于任何直接命中
  assert.equal(ids(searchFunctions('sign'))[0], 'sign');
});

test('nonsense queries return nothing instead of everything', () => {
  assert.deepEqual(searchFunctions('zzzzqqqqxxxx'), []);
  assert.deepEqual(searchFunctions('这个功能不存在'), []);
});

test('an empty query returns the whole list in its original order', () => {
  assert.deepEqual(ids(searchFunctions('')), ids(FUNCTIONS));
  assert.deepEqual(ids(searchFunctions('   ')), ids(FUNCTIONS));
});

test('scoring is monotonic across the documented tiers', () => {
  const item = { id: 'demo', name: '演示功能', keywords: ['demo', '样例'] };
  // 名称完全一致 > id 完全一致 > 名称前缀 > 关键词完全一致 > 名称包含
  assert.ok(scoreFunction(item, '演示功能') > scoreFunction(item, 'demo'));
  assert.ok(scoreFunction(item, 'demo') > scoreFunction(item, '演示'));
  assert.ok(scoreFunction(item, '演示') > scoreFunction(item, '样例'));
  assert.ok(scoreFunction(item, '样例') > scoreFunction(item, '功能'));
  assert.equal(scoreFunction(item, ''), 1);
  assert.equal(scoreFunction(null, 'x'), 0);
});

test('favorites keep their order, drop unknown ids, and de-duplicate', () => {
  const built = buildFavorites(['json', 'not-a-real-id', 'json', 'text']);
  assert.deepEqual(ids(built), ['json', 'text']);
});

test('favorites are capped so the sidebar cannot grow forever', () => {
  const many = FUNCTIONS.map((item) => item.id);
  assert.equal(buildFavorites(many).length, FAVORITE_LIMIT);
});

test('favorites survive a stale id left over from an older build', () => {
  // 功能被删掉之后，localStorage 里可能还留着旧 id —— 不能因此崩掉
  assert.deepEqual(buildFavorites(['deleted-function']), []);
  assert.deepEqual(ids(buildFavorites(['deleted-function', 'json'])), ['json']);
});

test('the recent-functions feature is fully removed', () => {
  // 「最近使用」曾和收藏一起把「全部功能」挤到侧边栏下方，而搜索已能解决「找不到」。
  // 用测试挡住它被无意中加回来。
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');

  const lib = fs.readFileSync(path.join(ROOT, 'src/lib/functions.js'), 'utf8');
  assert.doesNotMatch(lib, /buildRecent|RECENT_LIMIT/, 'lib 里不应再有最近使用的实现');

  for (const rel of ['src/App.jsx', 'src/components/common/CommandPalette.jsx']) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(source, /buildRecent|recentIds|最近使用/, rel + ' 里不应再有最近使用的痕迹');
  }

  // 侧边栏搜索必须保留
  const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  assert.match(app, /sidebar-search__input/, '侧边栏搜索框应保留');
});
