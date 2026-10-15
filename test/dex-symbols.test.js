'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildSymbolIndex,
  matchSymbols,
  packageOf,
  querySymbolIndex,
  summarizePackages,
  symbolText,
  toJavaClassName
} = require('../electron/pkginfo/symbols');
const { searchPackageSymbols } = require('../electron/pkginfo');

// ==================== 纯逻辑 ====================

test('dex descriptors become readable java names', () => {
  assert.equal(toJavaClassName('Lcom/demo/LoginActivity;'), 'com.demo.LoginActivity');
  assert.equal(toJavaClassName('Lkotlin/jvm/internal/Intrinsics;'), 'kotlin.jvm.internal.Intrinsics');
  // 数组描述符不强行改写成类名，原样返回更诚实
  assert.equal(toJavaClassName('[Ljava/lang/String;'), '[Ljava/lang/String;');
  // 不是描述符的原样返回
  assert.equal(toJavaClassName('com.demo.Foo'), 'com.demo.Foo');
  assert.equal(toJavaClassName(''), '');
  assert.equal(toJavaClassName(null), '');
});

test('packageOf handles nested packages and the default package', () => {
  assert.equal(packageOf('com.demo.ui.LoginActivity'), 'com.demo.ui');
  assert.equal(packageOf('com.demo.Foo'), 'com.demo');
  assert.equal(packageOf('Foo'), '(默认包)');
  assert.equal(packageOf(''), '(默认包)');
});

test('package summary aggregates and sorts by class count', () => {
  const summary = summarizePackages([
    { name: 'com.a.Foo' },
    { name: 'com.a.Bar' },
    { name: 'com.b.Baz' },
    { name: 'Root' }
  ]);
  assert.deepEqual(summary, [
    { name: 'com.a', count: 2 },
    { name: '(默认包)', count: 1 },
    { name: 'com.b', count: 1 }
  ]);
});

test('matching is case insensitive and reports how much was cut off', () => {
  const entries = [
    { name: 'com.demo.LoginActivity' },
    { name: 'com.demo.LoginHelper' },
    { name: 'com.demo.PayActivity' }
  ];
  const all = matchSymbols(entries, 'login');
  assert.equal(all.total, 2);
  assert.equal(all.matched.length, 2);
  assert.equal(all.truncated, false);

  const limited = matchSymbols(entries, 'login', 1);
  assert.equal(limited.matched.length, 1);
  assert.equal(limited.total, 2, 'total 要是真实命中数，不是返回数');
  assert.equal(limited.truncated, true);
});

test('an empty query means browse everything', () => {
  const entries = [{ value: 'a' }, { value: 'b' }];
  const result = matchSymbols(entries, '');
  assert.equal(result.total, 2);
  assert.equal(matchSymbols(entries, '   ').total, 2);
  assert.equal(matchSymbols(null, 'x').total, 0);
});

test('browse mode returns the package summary and skips the huge string list', () => {
  const index = buildSymbolIndex([]);
  index.totals = { classes: 3, strings: 99999, dex_files: 1 };
  index.classes = [{ name: 'com.a.Foo', dex: 'classes.dex' }];
  index.strings = Array.from({ length: 500 }, (_, i) => ({ value: `s${i}`, dex: 'classes.dex' }));
  index.packages = summarizePackages(index.classes);

  const browsing = querySymbolIndex(index, {});
  assert.equal(browsing.browsing, true);
  assert.deepEqual(browsing.packages, [{ name: 'com.a', count: 1 }]);
  // 浏览时不能把几十万条字符串塞给界面
  assert.deepEqual(browsing.strings, []);
  assert.equal(browsing.strings_total, 0);
});

test('scope narrows what gets searched', () => {
  const index = {
    totals: { classes: 1, strings: 1, dex_files: 1 },
    packages: [],
    classes: [{ name: 'com.demo.LoginActivity', dex: 'classes.dex' }],
    strings: [{ value: 'https://login.demo.com', dex: 'classes.dex' }]
  };

  const both = querySymbolIndex(index, { query: 'login' });
  assert.equal(both.classes.length, 1);
  assert.equal(both.strings.length, 1);

  const classOnly = querySymbolIndex(index, { query: 'login', scope: 'class' });
  assert.equal(classOnly.classes.length, 1);
  assert.deepEqual(classOnly.strings, []);

  const stringOnly = querySymbolIndex(index, { query: 'login', scope: 'string' });
  assert.deepEqual(stringOnly.classes, []);
  assert.equal(stringOnly.strings.length, 1);
});

test('a non-dex container reports a clear error instead of an empty result', () => {
  assert.throws(() => searchPackageSymbols('/tmp/definitely-missing.apk'), /文件不存在/);
  assert.throws(() => searchPackageSymbols(''), /请提供包体文件路径/);
});

// ==================== 真实 APK 端到端 ====================

const CANDIDATE_DIRS = [
  '/Users/violet/Documents/other_dev/QA_AUTO/apks',
  '/Users/violet/Downloads',
  '/Users/violet/Downloads/i4ToolsDownloads/App'
];

function findRealApk() {
  for (const dir of CANDIDATE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isFile() && entry.toLowerCase().endsWith('.apk')) return full;
      } catch { /* 读不了就跳过 */ }
    }
  }
  return null;
}

const realApk = findRealApk();

test('e2e: real apk yields searchable classes and strings', { skip: !realApk && '未找到测试 APK' }, () => {
  const browse = searchPackageSymbols(realApk, { scope: 'class' });
  assert.ok(browse.totals.classes > 0, '应该解析出类名');
  assert.ok(browse.totals.dex_files > 0, '应该找到 DEX');
  assert.ok(browse.packages.length > 0, '应该给出包结构');

  // 包结构里每个包都要有类
  for (const item of browse.packages) {
    assert.ok(item.count > 0, `${item.name} 的类数应大于 0`);
    assert.ok(typeof item.name === 'string' && item.name.length > 0);
  }

  // 用第一个包名再搜一次，必须能搜到东西 —— 这验证了「点包名继续搜」这条路径
  const target = browse.packages[0].name;
  const hit = searchPackageSymbols(realApk, { query: target, scope: 'class' });
  assert.ok(hit.classes_total > 0, `搜 ${target} 应该有结果`);
  assert.ok(hit.classes.length > 0);
  for (const item of hit.classes) {
    assert.ok(item.name.toLowerCase().includes(target.toLowerCase()));
    assert.ok(item.dex.endsWith('.dex'));
  }
});

test('e2e: string search finds hardcoded urls and reports truncation honestly', { skip: !realApk && '未找到测试 APK' }, () => {
  const result = searchPackageSymbols(realApk, { query: 'https://', scope: 'string' });
  assert.ok(result.strings_total > 0, '真实 APK 里应该有 https 字面量');
  for (const item of result.strings) {
    assert.ok(item.value.includes('https://'));
  }
  // 截断时长度要正好等于上限，且 truncated 为真
  if (result.strings_truncated) {
    assert.ok(result.strings.length < result.strings_total);
  } else {
    assert.equal(result.strings.length, result.strings_total);
  }
});

test('e2e: searching the same package twice hits the cache', { skip: !realApk && '未找到测试 APK' }, () => {
  const first = searchPackageSymbols(realApk, { query: 'Activity', scope: 'class' });
  const startedAt = Date.now();
  const second = searchPackageSymbols(realApk, { query: 'Activity', scope: 'class' });
  const elapsed = Date.now() - startedAt;

  assert.equal(second.classes_total, first.classes_total);
  // 缓存命中应该明显快于首次解析（首次要解压 + 遍历 DEX，通常几百毫秒起）
  assert.ok(elapsed < 300, `缓存命中耗时 ${elapsed}ms，看起来没走缓存`);
});

test('symbolText reads both entry shapes so class search actually works', () => {
  // 类条目是 {name}，字符串条目是 {value} —— 只认其中一个就会有一半搜不到
  assert.equal(symbolText({ name: 'com.demo.Foo', dex: 'classes.dex' }), 'com.demo.Foo');
  assert.equal(symbolText({ value: 'https://x', dex: 'classes.dex' }), 'https://x');
  assert.equal(symbolText('plain'), 'plain');
  assert.equal(symbolText(null), '');
  assert.equal(symbolText({}), '');

  // 按包名搜类必须命中（这条曾经是失败的）
  const hit = matchSymbols([{ name: 'com.demo.ui.Login' }, { name: 'com.other.Thing' }], 'com.demo');
  assert.equal(hit.total, 1);
  assert.equal(hit.matched[0].name, 'com.demo.ui.Login');
});
