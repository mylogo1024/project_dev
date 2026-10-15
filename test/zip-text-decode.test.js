'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeTextBuffer } = require('../electron/pkginfo/zip');

const utf8 = (text) => Buffer.from(text, 'utf8');
const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text) => {
  const body = Buffer.from(text, 'utf16le');
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
};

test('plain utf8 passes through unchanged', () => {
  assert.equal(decodeTextBuffer(utf8('Manifest-Version: 1.0\n')), 'Manifest-Version: 1.0\n');
  assert.equal(decodeTextBuffer(utf8('中文内容')), '中文内容');
  assert.equal(decodeTextBuffer(Buffer.alloc(0)), '');
});

test('utf8 BOM is stripped instead of leaking U+FEFF', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{"a":1}')]);
  const decoded = decodeTextBuffer(withBom);
  assert.equal(decoded, '{"a":1}');
  // 这是关键：留着 U+FEFF 的话 JSON.parse 会直接抛，首行匹配也会失败
  assert.equal(decoded.charCodeAt(0), 0x7b);
  assert.doesNotThrow(() => JSON.parse(decoded));
});

test('utf16 little endian with BOM decodes', () => {
  assert.equal(decodeTextBuffer(utf16le('Manifest-Version: 1.0')), 'Manifest-Version: 1.0');
  assert.equal(decodeTextBuffer(utf16le('中文')), '中文');
});

test('utf16 big endian with BOM decodes', () => {
  assert.equal(decodeTextBuffer(utf16be('Manifest-Version: 1.0')), 'Manifest-Version: 1.0');
  assert.equal(decodeTextBuffer(utf16be('中文')), '中文');
});

test('a truncated utf16be payload does not blow up', () => {
  // 去掉 BOM 后只剩 3 字节（奇数）—— 以前 swap16() 会抛 ERR_INVALID_BUFFER_SIZE
  const broken = Buffer.concat([Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00])]);
  let decoded;
  assert.doesNotThrow(() => { decoded = decodeTextBuffer(broken); });
  assert.equal(decoded, 'A');
});

test('a truncated utf16le payload keeps the readable part', () => {
  const broken = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('AB', 'utf16le'), Buffer.from([0x43])]);
  // 末尾那半个字符被丢掉，前面的照常读出来（Node 的 utf16le 解码本身不会抛）
  assert.equal(decodeTextBuffer(broken), 'AB');
});

test('a lone BOM decodes to an empty string', () => {
  assert.equal(decodeTextBuffer(Buffer.from([0xff, 0xfe])), '');
  assert.equal(decodeTextBuffer(Buffer.from([0xfe, 0xff])), '');
  assert.equal(decodeTextBuffer(Buffer.from([0xef, 0xbb, 0xbf])), '');
});

test('the two BOM families are not confused with each other', () => {
  // FF FE 开头只能按 UTF-16LE 解，不能因为前两字节像 UTF-8 BOM 就误判
  assert.equal(decodeTextBuffer(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'A');
  // EF BB BF 才是 UTF-8 BOM
  assert.equal(decodeTextBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'A');
});

test('binary payloads decode without throwing', () => {
  // readEntryText 也会被用来读二进制条目（测试里就把它当文本读 classes.dex），
  // 所以任何字节序列都不能抛
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.doesNotThrow(() => decodeTextBuffer(binary));
  assert.equal(typeof decodeTextBuffer(binary), 'string');
  // 不能自作聪明把「很多 0x00」的二进制猜成 UTF-16
  assert.equal(decodeTextBuffer(Buffer.from([0x41, 0x00, 0x42, 0x00])), 'A\u0000B\u0000');
});

test('accepts a plain Uint8Array as well as a Buffer', () => {
  assert.equal(decodeTextBuffer(new Uint8Array([0x41, 0x42])), 'AB');
  assert.equal(decodeTextBuffer(null), '');
  assert.equal(decodeTextBuffer(undefined), '');
});
