'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  RANDOM_ALPHABETS,
  WORD_BANK,
  applyRules,
  ensureUniqueTargets,
  parseFilename,
  randomChars,
  randomDate,
  randomUuid,
  randomWords
} = require('../src/lib/batchRenameEngine');

const makeFile = (name, index = 0) => ({
  path: `/d/${name}`, dir: '/d', name, parentName: 'd', size: 1, mtime: 1700000000000 + index
});

test('each random alphabet only emits characters from its own set', () => {
  const next = () => Math.random();
  for (const [key, alphabet] of Object.entries(RANDOM_ALPHABETS)) {
    const sample = randomChars(400, next, key);
    assert.equal(sample.length, 400);
    for (const ch of sample) assert.ok(alphabet.includes(ch), `${key} 出现了 ${ch}`);
  }
  // safe 字符集必须真的不含易混字符
  assert.doesNotMatch(randomChars(600, next, 'safe'), /[0O1lI]/);
  // 未知字符集退回默认
  assert.equal(randomChars(12, next, 'nope').length, 12);
});

test('uuid v4 has the right shape and version/variant bits', () => {
  for (let i = 0; i < 30; i += 1) {
    assert.match(randomUuid(Math.random), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('random words come from the bank and honour the separator', () => {
  const one = randomWords(1, Math.random, '-');
  assert.ok(WORD_BANK.includes(one));
  const three = randomWords(3, Math.random, '_');
  assert.equal(three.split('_').length, 3);
  for (const word of three.split('_')) assert.ok(WORD_BANK.includes(word));
  // 词数被夹在 1~5
  assert.equal(randomWords(99, Math.random, '-').split('-').length, 5);
});

test('random date is a YYYYMMDD within the past year', () => {
  const now = Date.parse('2026-09-18T00:00:00Z');
  for (let i = 0; i < 50; i += 1) {
    const value = randomDate(Math.random, now);
    assert.match(value, /^\d{8}$/);
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`;
    const parsed = Date.parse(iso);
    assert.ok(parsed <= now + 86400000, '不能是未来');
    assert.ok(parsed >= now - 366 * 86400000, '不能超过一年前');
  }
});

test('random rule supports alphabet, length, prefix and suffix', () => {
  const files = [makeFile('a.txt', 0), makeFile('b.txt', 1)];
  const rows = applyRules(files, [
    { type: 'random', enabled: true, mode: 'chars', alphabet: 'digits', length: 5, prefix: 'IMG_', suffix: '_v1' }
  ]);
  for (const row of rows) assert.match(row.preview, /^IMG_\d{5}_v1\.txt$/);
});

test('random rule can emit uuid and multi-word names', () => {
  const files = [makeFile('a.png', 0)];
  const uuidRow = applyRules(files, [{ type: 'random', enabled: true, mode: 'uuid' }])[0];
  assert.match(uuidRow.preview, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/);

  const wordRow = applyRules(files, [{ type: 'random', enabled: true, mode: 'word', words: 2, separator: '_' }])[0];
  const stem = parseFilename(wordRow.preview).stem;
  assert.equal(stem.split('_').length, 2);
  for (const word of stem.split('_')) assert.ok(WORD_BANK.includes(word));
});

test('shuffle keeps the same characters and only reorders them', () => {
  const files = [makeFile('abcdefgh.jpg', 0)];
  const row = applyRules(files, [{ type: 'random', enabled: true, mode: 'shuffle' }])[0];
  const stem = parseFilename(row.preview).stem;
  assert.equal(stem.length, 8);
  assert.deepEqual([...stem].sort(), [...'abcdefgh'].sort());
  assert.equal(parseFilename(row.preview).ext, 'jpg');
});

test('random names are deterministic so the preview matches what runs', () => {
  const files = [makeFile('a.txt', 0), makeFile('b.txt', 1), makeFile('c.txt', 2)];
  const rule = { type: 'random', enabled: true, mode: 'chars', alphabet: 'safe', length: 12 };
  const first = applyRules(files, [rule]).map((row) => row.preview);
  const second = applyRules(files, [rule]).map((row) => row.preview);
  assert.deepEqual(first, second);
  // 不同文件要拿到不同的名字
  assert.equal(new Set(first).size, 3);
  for (const name of first) assert.equal(parseFilename(name).ext, 'txt');
});

test('custom template understands the new random variables', () => {
  const files = [makeFile('origin.txt', 0)];
  const rows = applyRules(files, [{
    type: 'custom',
    enabled: true,
    template: '%random12%_%uuid%_%randdate%_%word%_%words2%_%name%'
  }]);
  const parts = parseFilename(rows[0].preview).stem.split('_');
  assert.match(parts[0], /^[A-Za-z0-9]{12}$/);
  assert.match(parts[1], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(parts[2], /^\d{8}$/);
  assert.ok(WORD_BANK.includes(parts[3]));
  // %words2% 内部用 - 连接，所以这里是两个词而不是一个
  const words = parts[4].split('-');
  assert.equal(words.length, 2);
  for (const word of words) assert.ok(WORD_BANK.includes(word));
  assert.equal(parts[5], 'origin');
});

test('a template with two random tokens does not repeat the same value', () => {
  const rows = applyRules([makeFile('x.txt', 0)], [{
    type: 'custom', enabled: true, template: '%random8%_%random8%'
  }]);
  const [left, right] = parseFilename(rows[0].preview).stem.split('_');
  assert.notEqual(left, right);
});

test('ensureUniqueTargets resolves collisions instead of dropping files', () => {
  const rows = [
    { dir: '/d', name: 'a.txt', preview: 'same.txt', target: '/d/same.txt', changed: true, status: 'conflict' },
    { dir: '/d', name: 'b.txt', preview: 'same.txt', target: '/d/same.txt', changed: true, status: 'conflict' },
    { dir: '/d', name: 'c.txt', preview: 'same.txt', target: '/d/same.txt', changed: true, status: 'conflict' }
  ];
  const fixed = ensureUniqueTargets(rows);
  assert.deepEqual(fixed.map((row) => row.preview), ['same.txt', 'same-2.txt', 'same-3.txt']);
  assert.equal(new Set(fixed.map((row) => row.target)).size, 3);
  assert.ok(fixed.every((row) => row.status === 'ready'));
});

test('ensureUniqueTargets leaves already-unique rows untouched', () => {
  const rows = [
    { dir: '/d', name: 'a.txt', preview: 'one.txt', target: '/d/one.txt', changed: true, status: 'ready' },
    { dir: '/d', name: 'b.txt', preview: 'two.txt', target: '/d/two.txt', changed: true, status: 'ready' }
  ];
  assert.deepEqual(ensureUniqueTargets(rows).map((row) => row.preview), ['one.txt', 'two.txt']);

  // 名字没变的行要维持 unchanged，否则会触发无意义的重命名
  const unchanged = ensureUniqueTargets([
    { dir: '/d', name: 'same.txt', preview: 'same.txt', target: '/d/same.txt', changed: false, status: 'unchanged' }
  ]);
  assert.equal(unchanged[0].status, 'unchanged');
  assert.equal(unchanged[0].changed, false);
});

test('one-click random naming produces a collision-free batch', () => {
  // 模拟「全部随机命名」：safe 字符集 + 12 位 + ensureUniqueTargets 兜底
  const files = Array.from({ length: 300 }, (_, i) => makeFile(`photo-${i}.jpg`, i));
  const rows = ensureUniqueTargets(applyRules(files, [
    { type: 'random', id: 'random-all', enabled: true, mode: 'chars', alphabet: 'safe', length: 12 }
  ]));
  const targets = rows.map((row) => row.target);
  assert.equal(new Set(targets).size, 300);
  assert.ok(rows.every((row) => row.status === 'ready' && row.changed));
  for (const row of rows) {
    assert.match(row.preview, /^[A-Za-z0-9]{12}\.jpg$/);
    assert.doesNotMatch(row.preview, /[0O1lI]/);
  }
});
