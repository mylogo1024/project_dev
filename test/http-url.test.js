'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildFullUrl,
  buildQueryString,
  mergeQueryIntoUrl,
  parseQueryString,
  splitUrlQuery,
  tidyParamRows
} = require('../src/lib/httpUrl');

test('parses a query string in every shape people paste', () => {
  assert.deepEqual(parseQueryString('a=1&b=2'), [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
  assert.deepEqual(parseQueryString('?a=1'), [{ key: 'a', value: '1' }]);
  assert.deepEqual(parseQueryString('https://x.y/p?a=1&b=2'), [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
  assert.deepEqual(parseQueryString(''), []);
  // 重复的键要保留成两行，不能互相覆盖
  assert.deepEqual(parseQueryString('a=1&a=2'), [{ key: 'a', value: '1' }, { key: 'a', value: '2' }]);
  // 中文与特殊字符要解码
  assert.deepEqual(parseQueryString('q=%E4%B8%AD%E6%96%87&x=a+b'), [{ key: 'q', value: '中文' }, { key: 'x', value: 'a b' }]);
});

test('parse never lets a fragment leak into the last value', () => {
  // 曾经踩过：`?tag=b#frag` 解析出 tag="b#frag"，拼回 URL 时 fragment 还会重复一次
  assert.deepEqual(parseQueryString('https://x.y/p?a=1#frag'), [{ key: 'a', value: '1' }]);
  assert.deepEqual(parseQueryString('a=1#frag'), [{ key: 'a', value: '1' }]);
  // 编码过的 # 是值的一部分，不能砍
  assert.deepEqual(parseQueryString('a=1%232'), [{ key: 'a', value: '1#2' }]);
});

test('splits a URL into base and params, keeping the fragment out of the query', () => {
  assert.deepEqual(splitUrlQuery('https://x.y/p?a=1'), {
    base: 'https://x.y/p',
    params: [{ key: 'a', value: '1' }],
    hasQuery: true
  });
  // fragment 不能被当成参数，而且拆完还要留在 base 上
  assert.deepEqual(splitUrlQuery('https://x.y/p?a=1#frag'), {
    base: 'https://x.y/p#frag',
    params: [{ key: 'a', value: '1' }],
    hasQuery: true
  });
  assert.deepEqual(splitUrlQuery('https://x.y/p'), {
    base: 'https://x.y/p',
    params: [],
    hasQuery: false
  });
});

test('builds a query string skipping disabled and empty keys', () => {
  const rows = [
    { key: 'a', value: '1' },
    { key: 'b', value: '2', enabled: false },
    { key: '  ', value: '3' },
    { key: ' c ', value: ' 4 ' }
  ];
  assert.equal(buildQueryString(rows), 'a=1&c=+4+');
  assert.equal(buildQueryString([]), '');
});

test('tidy trims, drops empty keys, and de-duplicates', () => {
  const tidied = tidyParamRows([
    { key: ' b ', value: ' 2 ' },
    { key: 'a', value: '1' },
    { key: 'a', value: '1' },
    { key: '   ', value: 'x' }
  ]);
  assert.deepEqual(tidied.map((r) => [r.key, r.value]), [['b', '2'], ['a', '1']]);
  // 值不同不算重复
  assert.equal(tidyParamRows([{ key: 'a', value: '1' }, { key: 'a', value: '2' }]).length, 2);
});

test('tidy can sort by key', () => {
  const sorted = tidyParamRows([{ key: 'c', value: '' }, { key: 'a', value: '' }, { key: 'b', value: '' }], { sort: true });
  assert.deepEqual(sorted.map((r) => r.key), ['a', 'b', 'c']);
});

test('builds the final URL the way the backend will', () => {
  assert.equal(buildFullUrl('https://x.y/p', [{ key: 'a', value: '1' }]), 'https://x.y/p?a=1');
  // 已经有 query 了要接 & 而不是再插一个 ?
  assert.equal(buildFullUrl('https://x.y/p?z=0', [{ key: 'a', value: '1' }]), 'https://x.y/p?z=0&a=1');
  // fragment 必须在最后
  assert.equal(buildFullUrl('https://x.y/p#frag', [{ key: 'a', value: '1' }]), 'https://x.y/p?a=1#frag');
  assert.equal(buildFullUrl('https://x.y/p?a=1#frag', [{ key: 'b', value: '2' }]), 'https://x.y/p?a=1&b=2#frag');
  // 没有参数时原样返回，不要多加一个 ?
  assert.equal(buildFullUrl('https://x.y/p', []), 'https://x.y/p');
  assert.equal(buildFullUrl('https://x.y/p', [{ key: 'a', value: '1', enabled: false }]), 'https://x.y/p');
});

test('merge puts parsed params back without duplicating the question mark', () => {
  assert.equal(mergeQueryIntoUrl('https://x.y/p?a=1', [{ key: 'b', value: '2' }]), 'https://x.y/p?b=2');
  assert.equal(mergeQueryIntoUrl('https://x.y/p', [{ key: 'a', value: '1' }]), 'https://x.y/p?a=1');
});
