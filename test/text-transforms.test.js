'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyLineOp,
  convertRadix,
  decodeJwt,
  dictToJson,
  generateRandom,
  hexDecode,
  hexEncode,
  htmlDecode,
  htmlEncode,
  jsonEscape,
  jsonToDict,
  jsonToQuery,
  jsonUnescape,
  makeUuidV4,
  queryToJson,
  reverseEachLine,
  unicodeEscape,
  unicodeUnescape
} = require('../src/lib/textTransforms');

// ==================== HTML 实体 ====================

test('html entities encode the five dangerous characters', () => {
  assert.equal(htmlEncode('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(htmlEncode('普通中文'), '普通中文');
});

test('html decode resolves numbers, named entities, and amp last', () => {
  assert.equal(htmlDecode('&lt;p&gt;'), '<p>');
  assert.equal(htmlDecode('&#65;&#x42;'), 'AB');
  assert.equal(htmlDecode('a&nbsp;b'), 'a\u00a0b');
  // 关键：&amp;lt; 必须解成 &lt; 而不是 <，否则会把用户原文里的转义吃掉
  assert.equal(htmlDecode('&amp;lt;'), '&lt;');
  assert.equal(htmlDecode('&amp;amp;'), '&amp;');
  // 非法码点不能抛，退化成替换字符
  assert.equal(htmlDecode('&#999999999;'), '\ufffd');
});

test('html encode/decode round-trips', () => {
  const source = '<div class="x">中文 & 符号 \'引号\'</div>';
  assert.equal(htmlDecode(htmlEncode(source)), source);
});

// ==================== Unicode 转义 ====================

test('unicode escape only touches non-ASCII so output stays readable', () => {
  assert.equal(unicodeEscape('a中'), 'a\\u4e2d');
  assert.equal(unicodeEscape('abc'), 'abc');
  // 超出 BMP 的用 \u{...}
  assert.equal(unicodeEscape('😀'), '\\u{1f600}');
});

test('unicode escape/unscape round-trips including astral planes', () => {
  const source = 'Hello 中文 😀 混合';
  assert.equal(unicodeUnescape(unicodeEscape(source)), source);
  assert.equal(unicodeUnescape('\\u4e2d\\u6587'), '中文');
});

// ==================== 十六进制 ====================

test('hex encode uses UTF-8 bytes and round-trips Chinese', () => {
  assert.equal(hexEncode('中'), 'e4b8ad');
  assert.equal(hexDecode('e4b8ad'), '中');
  const source = 'ABC 中文 😀';
  assert.equal(hexDecode(hexEncode(source)), source);
});

test('hex decode tolerates the separators people paste in', () => {
  assert.equal(hexDecode('e4 b8 ad'), '中');
  assert.equal(hexDecode('0xe4,0xb8,0xad'), '中');
  assert.equal(hexDecode('\\xe4\\xb8\\xad'), '中');
  assert.equal(hexDecode('  '), '');
});

test('hex decode reports malformed input instead of returning garbage', () => {
  assert.throws(() => hexDecode('zz'), /非十六进制字符/);
  assert.throws(() => hexDecode('abc'), /偶数/);
});

// ==================== JSON 字符串转义 ====================

test('json escape/unscape round-trips control characters', () => {
  const source = 'line1\nline2\t"quoted"\\slash';
  assert.equal(jsonUnescape(jsonEscape(source)), source);
  assert.equal(jsonEscape('a\nb'), 'a\\nb');
});

test('json unescape scans in one pass so escaped backslashes survive', () => {
  // \\u0041 是「字面量 \u0041」，不能解成 A
  assert.equal(jsonUnescape('\\\\u0041'), '\\u0041');
  assert.equal(jsonUnescape('\\u0041'), 'A');
  assert.equal(jsonUnescape('\\n\\t'), '\n\t');
});

// ==================== JWT ====================

const base64Url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('jwt decode prints header, payload and human-readable times', () => {
  const token = `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url({ sub: '42', exp: 2000000000 })}.sig`;
  const output = decodeJwt(token);
  assert.match(output, /— Header —/);
  assert.match(output, /"alg": "HS256"/);
  assert.match(output, /— Payload —/);
  assert.match(output, /"sub": "42"/);
  assert.match(output, /过期时间（exp）：/);
  assert.match(output, /尚未过期/);
  assert.match(output, /不校验签名/);
});

test('jwt decode accepts a Bearer prefix and flags expired tokens', () => {
  const expired = `${base64Url({ alg: 'none' })}.${base64Url({ exp: 1000000000 })}.`;
  assert.match(decodeJwt(`Bearer ${expired}`), /已过期/);
});

test('jwt decode rejects non-token input with a clear message', () => {
  assert.throws(() => decodeJwt('not-a-jwt'), /不是有效的 JWT/);
  // header 合法但 payload 不是 JSON → 报 Payload 段而不是笼统失败
  assert.throws(() => decodeJwt(`${base64Url({ alg: 'none' })}.notjson`), /Payload 段/);
});

// ==================== 进制转换 ====================

test('radix conversion handles every pair', () => {
  assert.equal(convertRadix('255', 'dec2hex'), 'FF');
  assert.equal(convertRadix('FF', 'hex2dec'), '255');
  assert.equal(convertRadix('5', 'dec2bin'), '101');
  assert.equal(convertRadix('101', 'bin2dec'), '5');
  assert.equal(convertRadix('8', 'dec2oct'), '10');
  assert.equal(convertRadix('10', 'oct2dec'), '8');
  // 前缀和大小写都容忍
  assert.equal(convertRadix('0xff', 'hex2dec'), '255');
});

test('radix conversion marks only the bad line instead of failing everything', () => {
  assert.equal(convertRadix('10\nabc\n11', 'dec2bin'), '1010\n[不是有效数字] abc\n1011');
  // 空行原样保留
  assert.equal(convertRadix('10\n\n11', 'dec2bin'), '1010\n\n1011');
});

// ==================== URL 参数 ====================

test('query to json groups repeated keys into an array', () => {
  const output = JSON.parse(queryToJson('a=1&b=2&b=3'));
  assert.deepEqual(output, { a: '1', b: ['2', '3'] });
  // 整条 URL 也能直接粘进来
  assert.deepEqual(JSON.parse(queryToJson('http://x.y/p?a=1')), { a: '1' });
  assert.deepEqual(JSON.parse(queryToJson('?a=1')), { a: '1' });
});

test('json to query expands arrays and skips null', () => {
  assert.equal(jsonToQuery('{"a":1,"b":"x"}'), 'a=1&b=x');
  assert.equal(jsonToQuery('{"a":[1,2]}'), 'a=1&a=2');
  assert.equal(jsonToQuery('{"a":null,"b":1}'), 'b=1');
  // 中文和特殊字符要转义
  assert.equal(jsonToQuery('{"q":"中文 空格"}'), 'q=%E4%B8%AD%E6%96%87+%E7%A9%BA%E6%A0%BC');
});

test('json to query rejects non-objects', () => {
  assert.throws(() => jsonToQuery('[1,2]'), /JSON 对象/);
  assert.throws(() => jsonToQuery('nope'), SyntaxError);
});

// ==================== 行处理 ====================

test('line numbering pads to the width of the largest number', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
  const numbered = applyLineOp(lines.join('\n'), 'number');
  assert.equal(numbered.split('\n')[0], ' 1. L1');
  assert.equal(numbered.split('\n')[11], '12. L12');
});

test('line unnumbering strips common numbering styles', () => {
  assert.equal(applyLineOp('1. a\n2) b\n3、c\n4: d', 'unnumber'), 'a\nb\nc\nd');
  // 没有编号的行不动
  assert.equal(applyLineOp('plain text', 'unnumber'), 'plain text');
});

test('shuffle keeps every line but changes the order', () => {
  const source = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n');
  const shuffled = applyLineOp(source, 'shuffle');
  assert.notEqual(shuffled, source);
  assert.deepEqual(shuffled.split('\n').sort(), source.split('\n').sort());
});

test('whitespace and blank-line ops behave', () => {
  assert.equal(applyLineOp('  a  \n  b  ', 'trim'), 'a\nb');
  assert.equal(applyLineOp('a   b\t\tc', 'collapse'), 'a b c');
  assert.equal(applyLineOp('a\n\n  \nb', 'blank'), 'a\nb');
  assert.equal(applyLineOp('a\n\nb', 'reverse'), 'b\n\na');
  assert.equal(applyLineOp('a\n  b', 'indent'), '  a\n    b');
  assert.equal(applyLineOp('  a\n\tb', 'dedent'), 'a\nb');
});

// ==================== 反转文本 ====================

test('reverse text flips characters per line and keeps line order', () => {
  assert.equal(reverseEachLine('abc\ndef'), 'cba\nfed');
  // 按字符（码点）反转，emoji 不会被劈成两半
  assert.equal(reverseEachLine('a😀b'), 'b😀a');
});

// ==================== 随机生成 ====================

test('uuid v4 has the right shape and version bits', () => {
  for (let i = 0; i < 20; i += 1) {
    const uuid = makeUuidV4();
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('generated values honour the requested length', () => {
  assert.equal(generateRandom('32', 'password').length, 32);
  assert.equal(generateRandom('8', 'string').length, 8);
  // 十六进制的长度参数按字节算，输出字符数是两倍
  assert.equal(generateRandom('8', 'hex').length, 16);
  assert.equal(generateRandom('', 'password').length, 20);
});

test('generated passwords avoid look-alike characters and stay unique', () => {
  const samples = new Set();
  for (let i = 0; i < 50; i += 1) samples.add(generateRandom('16', 'password'));
  assert.equal(samples.size, 50);
  // 排除了 0/O/1/l/I 这类容易看错的字符
  for (const sample of samples) assert.doesNotMatch(sample, /[0O1lI]/);
});

test('length hint is clamped so a silly input cannot hang the renderer', () => {
  assert.equal(generateRandom('999999', 'string').length, 4096);
});

// ==================== 字典 ↔ JSON ====================

test('dict to json handles single quotes, bare keys and python literals', () => {
  const output = JSON.parse(dictToJson("{'a': 1, 'b': 'x', 'c': True, 'd': False, 'e': None}"));
  assert.deepEqual(output, { a: 1, b: 'x', c: true, d: false, e: null });
  assert.deepEqual(JSON.parse(dictToJson('{a: 1, b: "x"}')), { a: 1, b: 'x' });
  assert.deepEqual(JSON.parse(dictToJson("{'a': [1, 2], 'b': {'c': 'd'}}")), { a: [1, 2], b: { c: 'd' } });
});

test('dict to json does not mangle punctuation inside strings', () => {
  const source = `{'msg': 'a, b: c {d}', 'quote': 'say "hi"', 'hash': 'a # not a comment'}`;
  assert.deepEqual(JSON.parse(dictToJson(source)), {
    msg: 'a, b: c {d}',
    quote: 'say "hi"',
    hash: 'a # not a comment'
  });
});

test('dict to json strips comments and trailing commas', () => {
  const source = "{\n  # 注释\n  'a': 1,   // 行尾注释\n  'b': 2,   /* 块注释 */\n}";
  assert.deepEqual(JSON.parse(dictToJson(source)), { a: 1, b: 2 });
});

test('dict to json keeps escapes intact', () => {
  assert.deepEqual(JSON.parse(dictToJson(String.raw`{'a': 'line\nbreak', 'b': 'back\\slash'}`)), {
    a: 'line\nbreak',
    b: 'back\\slash'
  });
  assert.deepEqual(JSON.parse(dictToJson(String.raw`{'a': 'it\'s'}`)), { a: "it's" });
});

test('dict to json reports unclosed strings instead of producing garbage', () => {
  assert.throws(() => dictToJson("{'a': 'oops}"), /没有闭合/);
});

test('json to dict emits python-style literals', () => {
  const output = jsonToDict('{"a":1,"b":"x","c":true,"d":false,"e":null,"f":[],"g":{}}');
  assert.match(output, /'a': 1/);
  assert.match(output, /'b': 'x'/);
  assert.match(output, /'c': True/);
  assert.match(output, /'d': False/);
  assert.match(output, /'e': None/);
  assert.match(output, /'f': \[\]/);
  assert.match(output, /'g': \{\}/);
});

test('dict and json round-trip through each other', () => {
  const original = { name: '张三', list: [1, 2, { deep: true }], empty: null, nested: { a: 'b' } };
  const dict = jsonToDict(JSON.stringify(original));
  assert.deepEqual(JSON.parse(dictToJson(dict)), original);
});

test('json to dict escapes quotes inside keys and values', () => {
  const output = jsonToDict(JSON.stringify({ "it's": "a'b" }));
  assert.match(output, /'it\\'s': 'a\\'b'/);
  assert.deepEqual(JSON.parse(dictToJson(output)), { "it's": "a'b" });
});
