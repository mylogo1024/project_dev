'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { extractMachoSymbols, readSectionStrings, MAX_PER_SECTION } = require('../electron/pkginfo/macho-symbols');

// 系统自带的 Mach-O，用来验证真实解析（不存在时整组跳过）
const REAL_BINARIES = ['/bin/ls', '/usr/bin/plutil', '/usr/lib/dyld'];
const available = REAL_BINARIES.filter((file) => fs.existsSync(file));
const firstAvailable = available[0];
/** 带 ObjC 运行时的二进制（/bin/ls 是纯 C，没有 ObjC 段） */
const objcBinary = available.find((file) => {
  const result = extractMachoSymbols(fs.readFileSync(file));
  return result && result.classes.length > 0;
});

// ==================== 输入守卫 ====================

test('returns null for anything that is not a Mach-O', () => {
  assert.equal(extractMachoSymbols(null), null);
  assert.equal(extractMachoSymbols(undefined), null);
  assert.equal(extractMachoSymbols('not a buffer'), null);
  assert.equal(extractMachoSymbols(Buffer.alloc(0)), null);
  assert.equal(extractMachoSymbols(Buffer.alloc(64)), null, '全 0 不是合法 magic');
  // 合法的 ELF magic 也不该被当成 Mach-O
  assert.equal(extractMachoSymbols(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

test('a truncated header does not throw', () => {
  // 只有 magic 和一个假的 ncmds，不应崩
  const buffer = Buffer.alloc(28);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(9999, 16); // ncmds 大得离谱
  assert.doesNotThrow(() => extractMachoSymbols(buffer));
});

test('a header claiming more load commands than the file holds is rejected', () => {
  // load command 区域超出文件长度 → 视为损坏，返回 null 而不是给出半截结果
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(3, 16);      // ncmds
  buffer.writeUInt32LE(4096, 20);   // sizeofcmds 远超文件长度
  assert.equal(extractMachoSymbols(buffer), null);
});

// ==================== 真实二进制 ====================

test('parses a real Mach-O into sections, strings and symbols', { skip: !firstAvailable && '系统里没有可用的 Mach-O' }, () => {
  const result = extractMachoSymbols(fs.readFileSync(firstAvailable));
  assert.ok(result, `${firstAvailable} 应能被解析`);
  assert.ok(result.architectures >= 1);
  assert.ok(result.sections.length > 0, '应解析出 section');
  assert.ok(result.symbols.length > 0, '应解析出符号');
  // section 名不该带出乱码
  for (const section of result.sections) {
    assert.match(section.sectname, /^[A-Za-z0-9_.$]*$/, `section 名异常：${section.sectname}`);
  }
});

test('extracts Objective-C class and method names when present', { skip: !objcBinary && '系统里没有带 ObjC 运行时的二进制' }, () => {
  const result = extractMachoSymbols(fs.readFileSync(objcBinary));
  assert.ok(result.classes.length > 0, `${objcBinary} 应提取出 ObjC 类名`);
  assert.ok(result.methods.length > 0, '应提取出 ObjC 方法名');
  // 类名是标识符形态，不该混入二进制垃圾
  for (const name of result.classes.slice(0, 50)) {
    assert.match(name, /^[A-Za-z_$][\w$]*$/, `类名形态异常：${name}`);
  }
});

test('results are de-duplicated and sorted', { skip: !firstAvailable && '系统里没有可用的 Mach-O' }, () => {
  const result = extractMachoSymbols(fs.readFileSync(firstAvailable));
  for (const key of ['classes', 'methods', 'strings', 'symbols']) {
    const list = result[key];
    assert.equal(new Set(list).size, list.length, `${key} 应已去重`);
    const sorted = [...list].sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(list, sorted, `${key} 应已排序`);
  }
});

test('universal binaries report more than one architecture', { skip: !available.some((f) => {
  const r = extractMachoSymbols(fs.readFileSync(f));
  return r && r.architectures > 1;
}) && '系统里没有通用二进制' }, () => {
  const fat = available.find((f) => {
    const r = extractMachoSymbols(fs.readFileSync(f));
    return r && r.architectures > 1;
  });
  const result = extractMachoSymbols(fs.readFileSync(fat));
  assert.ok(result.architectures > 1, `${fat} 应识别为多架构`);
  // 合并各架构后仍然要去重
  assert.equal(new Set(result.classes).size, result.classes.length);
});

// ==================== section 字符串提取 ====================

test('section strings stop at NUL and skip empty entries', () => {
  const buffer = Buffer.from('foo\0bar\0\0baz\0', 'utf8');
  const strings = readSectionStrings(buffer, { offset: 0, size: buffer.length });
  assert.deepEqual(strings, ['foo', 'bar', 'baz']);
});

test('section strings respect the cap so a huge section cannot blow up memory', () => {
  const parts = [];
  for (let i = 0; i < MAX_PER_SECTION + 500; i += 1) parts.push(`s${i}`);
  const buffer = Buffer.from(parts.join('\0') + '\0', 'utf8');
  const strings = readSectionStrings(buffer, { offset: 0, size: buffer.length });
  assert.equal(strings.length, MAX_PER_SECTION, '应按上限截断');
});

test('section strings ignore out-of-range sections instead of throwing', () => {
  const buffer = Buffer.from('abc\0', 'utf8');
  assert.deepEqual(readSectionStrings(buffer, { offset: 999, size: 100 }), []);
  assert.deepEqual(readSectionStrings(buffer, { offset: 0, size: 0 }), []);
  assert.deepEqual(readSectionStrings(buffer, { offset: -5, size: 10 }), []);
});

test('absurdly long strings are filtered as binary noise', () => {
  // 一个没有 NUL 的超长「字符串」通常是二进制数据被误读，不该塞进结果
  const buffer = Buffer.from('x'.repeat(600) + '\0ok\0', 'utf8');
  const strings = readSectionStrings(buffer, { offset: 0, size: buffer.length });
  assert.deepEqual(strings, ['ok']);
});
