'use strict';

/**
 * 包体静态信息解析测试
 *
 * 分两部分：
 *   1) 纯函数单测 —— 用合成 fixture 覆盖 ZIP / AXML / StringPool / plist / DER / ELF / DEX / Mach-O / 规则引擎
 *   2) 真实包体端到端 —— 若本机存在测试包则校验关键字段，否则自动跳过
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const util = require('../electron/pkginfo/util');
const { openZip, dosDateTimeToDate } = require('../electron/pkginfo/zip');
const {
  readChunkHeader,
  parseStringPool,
  resValueToString,
  splitResourceId,
  TYPE_STRING,
  TYPE_INT_BOOLEAN,
  TYPE_REFERENCE,
  RES_XML_TYPE,
  RES_XML_START_ELEMENT_TYPE,
  RES_XML_END_ELEMENT_TYPE
} = require('../electron/pkginfo/res-chunk');
const axml = require('../electron/pkginfo/axml');
const plist = require('../electron/pkginfo/plist');
const der = require('../electron/pkginfo/der');
const binary = require('../electron/pkginfo/binary');
const rules = require('../electron/pkginfo/rules');
const { parsePackageStaticInfo, comparePackageInfo } = require('../electron/pkginfo');

// ==================== fixture 构造工具 ====================

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 构造一个 STORED（不压缩）的合法 ZIP。 */
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, name);

    offset += lh.length + name.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, central, eocd]);
}

function encodePoolLength(n) {
  if (n > 0x7f) return Buffer.from([((n >> 8) & 0x7f) | 0x80, n & 0xff]);
  return Buffer.from([n]);
}

function encodeUtf8String(s) {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([encodePoolLength(s.length), encodePoolLength(bytes.length), bytes, Buffer.from([0])]);
}

function encodeUtf16String(s) {
  // UTF-16 池的长度字段是 16 位（不是 UTF-8 池的 1~2 字节变长编码）
  const head = Buffer.alloc(2);
  head.writeUInt16LE(s.length, 0);
  const body = Buffer.alloc(s.length * 2 + 2);
  for (let i = 0; i < s.length; i += 1) body.writeUInt16LE(s.charCodeAt(i), i * 2);
  return Buffer.concat([head, body]);
}

/** 构造 ResStringPool chunk。 */
function makeStringPool(strings, utf8 = true) {
  const encoded = strings.map((s) => (utf8 ? encodeUtf8String(s) : encodeUtf16String(s)));
  const offsets = [];
  let acc = 0;
  for (const e of encoded) { offsets.push(acc); acc += e.length; }
  const data = Buffer.concat(encoded);

  const headerSize = 28;
  const stringsStart = headerSize + strings.length * 4;
  const size = stringsStart + data.length;

  const buf = Buffer.alloc(size);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(headerSize, 2);
  buf.writeUInt32LE(size, 4);
  buf.writeUInt32LE(strings.length, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeUInt32LE(utf8 ? 0x0100 : 0x0000, 16);
  buf.writeUInt32LE(stringsStart, 20);
  buf.writeUInt32LE(0, 24);
  offsets.forEach((o, i) => buf.writeUInt32LE(o, headerSize + i * 4));
  data.copy(buf, stringsStart);
  return buf;
}

/**
 * 构造一份最小但结构完整的二进制 AndroidManifest.xml：
 *   <manifest package="com.demo">
 */
function makeBinaryXml() {
  const strings = ['manifest', 'package', 'com.demo'];
  const pool = makeStringPool(strings, true);

  // START_ELEMENT：chunk header(16) + attrExt(20) + 1 个 attribute(20)
  const start = Buffer.alloc(56);
  start.writeUInt16LE(RES_XML_START_ELEMENT_TYPE, 0);
  start.writeUInt16LE(16, 2);
  start.writeUInt32LE(56, 4);
  start.writeUInt32LE(1, 8);        // lineNumber
  start.writeUInt32LE(0xffffffff, 12); // comment
  start.writeUInt32LE(0xffffffff, 16); // ns
  start.writeUInt32LE(0, 20);       // name -> "manifest"
  start.writeUInt16LE(20, 24);      // attributeStart
  start.writeUInt16LE(20, 26);      // attributeSize
  start.writeUInt16LE(1, 28);       // attributeCount
  start.writeUInt16LE(0, 30);       // idIndex
  start.writeUInt16LE(0, 32);       // classIndex
  start.writeUInt16LE(0, 34);       // styleIndex
  // attribute[0]
  start.writeUInt32LE(0xffffffff, 36); // ns
  start.writeUInt32LE(1, 40);          // name -> "package"
  start.writeUInt32LE(2, 44);          // rawValue -> "com.demo"
  start.writeUInt16LE(8, 48);          // typedValue.size
  start.writeUInt8(0, 50);             // res0
  start.writeUInt8(TYPE_STRING, 51);   // dataType
  start.writeUInt32LE(2, 52);          // data -> string index 2

  // END_ELEMENT
  const end = Buffer.alloc(24);
  end.writeUInt16LE(RES_XML_END_ELEMENT_TYPE, 0);
  end.writeUInt16LE(16, 2);
  end.writeUInt32LE(24, 4);
  end.writeUInt32LE(1, 8);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  end.writeUInt32LE(0, 20);

  const total = 8 + pool.length + start.length + end.length;
  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML_TYPE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(total, 4);

  return Buffer.concat([header, pool, start, end]);
}

/** 构造最小二进制 plist：{ K: "V" } */
function makeBinaryPlist() {
  const header = Buffer.from('bplist00', 'latin1');       // 0..7
  const obj0 = Buffer.from([0xd1, 0x01, 0x02]);            // 8..10  dict(1): key->1, value->2
  const obj1 = Buffer.from([0x51, 0x4b]);                  // 11..12 ASCII "K"
  const obj2 = Buffer.from([0x51, 0x56]);                  // 13..14 ASCII "V"
  const offsets = Buffer.from([8, 11, 13]);                // 15..17

  const trailer = Buffer.alloc(32);
  trailer[6] = 1;   // offsetIntSize
  trailer[7] = 1;   // objectRefSize
  trailer.writeBigUInt64BE(3n, 8);    // numObjects
  trailer.writeBigUInt64BE(0n, 16);   // topObject
  trailer.writeBigUInt64BE(15n, 24);  // offsetTableOffset

  return Buffer.concat([header, obj0, obj1, obj2, offsets, trailer]);
}

/** 构造最小合法 DEX 头（112 字节）。 */
function makeDex({ methods = 12, classes = 5 } = {}) {
  const buf = Buffer.alloc(112);
  buf.write('dex\n035\0', 0, 'latin1');
  buf.writeUInt32LE(0x12345678, 8);   // checksum
  buf.writeUInt32LE(112, 32);         // file_size
  buf.writeUInt32LE(112, 36);         // header_size
  buf.writeUInt32LE(0x12345678, 40);  // endian_tag
  buf.writeUInt32LE(methods, 88);     // method_ids_size
  buf.writeUInt32LE(112, 92);         // method_ids_off
  buf.writeUInt32LE(classes, 96);     // class_defs_size
  buf.writeUInt32LE(112, 100);        // class_defs_off
  return buf;
}

/** 构造最小 ELF64 头。 */
function makeElf() {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2;   // 64-bit
  buf[5] = 1;   // little endian
  buf[6] = 1;   // version
  buf.writeUInt16LE(3, 16);     // e_type = ET_DYN
  buf.writeUInt16LE(0xb7, 18);  // e_machine = AArch64
  return buf;
}

/** 构造最小 Mach-O 64 头。 */
function makeMachO() {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0xfeedfacf, 0);   // MH_MAGIC_64
  buf.writeUInt32LE(0x0100000c, 4);   // CPU_TYPE_ARM64
  buf.writeUInt32LE(2, 12);           // MH_EXECUTE
  return buf;
}

/** DER 基础编码器。 */
function derTlv(tag, content) {
  const len = content.length;
  let lenBytes;
  if (len < 0x80) lenBytes = Buffer.from([len]);
  else if (len < 0x100) lenBytes = Buffer.from([0x81, len]);
  else lenBytes = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([Buffer.from([tag]), lenBytes, content]);
}

const derSeq = (...c) => derTlv(0x30, Buffer.concat(c));
const derSet = (...c) => derTlv(0x31, Buffer.concat(c));
const derOid = (bytes) => derTlv(0x06, Buffer.from(bytes));
const derPrintable = (s) => derTlv(0x13, Buffer.from(s, 'latin1'));
const derUtf8 = (s) => derTlv(0x0c, Buffer.from(s, 'utf8'));
const derUtcTime = (s) => derTlv(0x17, Buffer.from(s, 'latin1'));
const derNull = () => derTlv(0x05, Buffer.alloc(0));

function derIntegerFromInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return derTlv(0x02, Buffer.from(bytes));
}

const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_SHA256_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_EC = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_P256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

function writeTemp(name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkginfo-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

// ==================== 1. util ====================

test('util: hashBuffer 按指定算法产出摘要', () => {
  const buf = Buffer.from('abc');
  assert.equal(util.hashBuffer(buf, 'sha256'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(util.hashBuffer(buf, 'sha1'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(util.hashBuffer(buf, 'md5'), '900150983cd24fb0d6963f7d28e17f72');
});

test('util: computeFileDigests 单遍流式产出大小/三种哈希/熵', () => {
  const file = writeTemp('abc.bin', Buffer.from('abc'));
  const result = util.computeFileDigests(file);
  assert.equal(result.size, 3);
  assert.equal(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(result.sha1, 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(result.md5, '900150983cd24fb0d6963f7d28e17f72');
  assert.ok(result.entropy > 0);
});

test('util: formatBytes 与 formatPercent', () => {
  assert.equal(util.formatBytes(0), '0 B');
  assert.equal(util.formatBytes(1024), '1.00 KB');
  assert.equal(util.formatBytes(1536), '1.50 KB');
  assert.equal(util.formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(util.formatPercent(0.5), '50.00%');
});

test('util: shannonEntropy 对全零与均匀分布给出合理区间', () => {
  assert.equal(util.shannonEntropy(Buffer.alloc(64)), 0);
  const uniform = Buffer.alloc(4096);
  for (let i = 0; i < uniform.length; i += 1) uniform[i] = i & 0xff;
  assert.ok(util.shannonEntropy(uniform) > 7.9);
});

test('util: categorizeEntry 归类常见包内路径', () => {
  assert.equal(util.categorizeEntry('classes.dex'), '代码');
  assert.equal(util.categorizeEntry('classes2.dex'), '代码');
  assert.equal(util.categorizeEntry('lib/arm64-v8a/libfoo.so'), '原生库');
  assert.equal(util.categorizeEntry('res/drawable/icon.png'), '资源');
  assert.equal(util.categorizeEntry('resources.arsc'), '资源');
  assert.equal(util.categorizeEntry('AndroidManifest.xml'), '资源');
  assert.equal(util.categorizeEntry('assets/config.json'), 'assets');
  assert.equal(util.categorizeEntry('META-INF/CERT.RSA'), '签名与元数据');
  assert.equal(util.categorizeEntry('Payload/App.app/App'), 'iOS 包体');
  assert.equal(util.categorizeEntry('unknown.bin'), '其他');
});

test('util: sizeByCategory 将 DEX 与原生库分开统计（回归）', () => {
  const entries = [
    { name: 'classes.dex', size: 1000 },
    { name: 'classes2.dex', size: 500 },
    { name: 'lib/arm64-v8a/libfoo.so', size: 2000 }
  ];
  const buckets = util.sizeByCategory(entries);
  const byName = Object.fromEntries(buckets.map((b) => [b.name, b.size]));
  assert.equal(byName['代码'], 1500, 'DEX 应单独计入「代码」');
  assert.equal(byName['原生库'], 2000, 'SO 应计入「原生库」');
});

test('util: sizeByExtension 汇总并按体积降序', () => {
  const entries = [
    { name: 'a.dex', size: 100 },
    { name: 'b.dex', size: 200 },
    { name: 'c.png', size: 50 }
  ];
  const result = util.sizeByExtension(entries);
  assert.equal(result[0].extension, 'dex');
  assert.equal(result[0].size, 300);
  assert.equal(result[0].count, 2);
  assert.equal(result[1].extension, 'png');
});

test('util: findDuplicateFiles 依据 CRC32+大小识别重复文件', () => {
  const entries = [
    { name: 'a.txt', size: 10, crc32: 'aaaa1111' },
    { name: 'b.txt', size: 10, crc32: 'aaaa1111' },
    { name: 'c.txt', size: 20, crc32: 'bbbb2222' }
  ];
  const dupes = util.findDuplicateFiles(entries);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].files.length, 2);
  assert.ok(dupes[0].files.includes('a.txt'));
});

test('util: buildFileTree 依据 path 生成层级结构', () => {
  const tree = util.buildFileTree([
    { path: 'res/a.png', size: 10 },
    { path: 'res/b.png', size: 20 },
    { path: 'lib/x.so', size: 30 }
  ]);
  assert.equal(tree.children.length, 2);
  const res = tree.children.find((c) => c.name === 'res');
  assert.equal(res.children.length, 2);
  const lib = tree.children.find((c) => c.name === 'lib');
  assert.equal(lib.children[0].name, 'x.so');
});

test('util: oidName 与 apkSignatureAlgorithmName 解析已知 OID/算法 ID', () => {
  assert.equal(util.oidName('1.2.840.113549.1.1.11'), 'SHA256withRSA');
  assert.equal(util.oidName('2.5.4.3'), 'CN');
  assert.equal(util.oidName('9.9.9.9'), '9.9.9.9', '未知 OID 原样返回');
  assert.equal(util.apkSignatureAlgorithmName(0x0103), 'RSASSA-PKCS1-v1_5 with SHA2-256');
  assert.equal(util.apkSignatureAlgorithmName(0x0201), 'ECDSA with SHA2-256');
  assert.equal(util.apkSignatureAlgorithmName(0x0423), 'RSA with SHA2-512 (Verity)');
});

test('util: readUleb128 解码多字节变长整数', () => {
  assert.equal(util.readUleb128(Buffer.from([0x7f]), 0).value, 127);
  assert.equal(util.readUleb128(Buffer.from([0x80, 0x01]), 0).value, 128);
  assert.equal(util.readUleb128(Buffer.from([0xe5, 0x8e, 0x26]), 0).value, 624485);
});

// ==================== 2. ZIP ====================

test('zip: 解析中央目录并读取条目内容', () => {
  const zipBuf = makeZip([
    { name: 'AndroidManifest.xml', data: 'manifest-bytes' },
    { name: 'classes.dex', data: 'dex-bytes' },
    { name: 'res/drawable/icon.png', data: Buffer.alloc(32, 7) }
  ]);
  const file = writeTemp('test.apk', zipBuf);
  const zip = openZip(file);
  try {
    assert.equal(zip.entries.length, 3);
    assert.deepEqual(
      zip.entries.map((e) => e.name).sort(),
      ['AndroidManifest.xml', 'classes.dex', 'res/drawable/icon.png']
    );
    assert.equal(zip.readEntryText('classes.dex'), 'dex-bytes');
    assert.ok(zip.find('AndroidManifest.xml'));
    assert.equal(zip.find('nope.txt'), null);
    assert.equal(zip.match(/\.dex$/).length, 1);
  } finally {
    zip.close();
  }
});

test('zip: 记录 CRC32、压缩方式与是否为目录', () => {
  const zipBuf = makeZip([
    { name: 'dir/', data: '' },
    { name: 'dir/file.txt', data: 'hello' }
  ]);
  const file = writeTemp('dirs.apk', zipBuf);
  const zip = openZip(file);
  try {
    assert.equal(zip.find('dir/').isDirectory, true);
    const entry = zip.find('dir/file.txt');
    assert.equal(entry.isDirectory, false);
    assert.equal(entry.methodName, 'store');
    assert.equal(entry.crc32_hex.length, 8);
    assert.equal(entry.crc32_hex, crc32(Buffer.from('hello')).toString(16).padStart(8, '0'));
  } finally {
    zip.close();
  }
});

test('zip: dosDateTimeToDate 还原 DOS 时间戳', () => {
  const date = dosDateTimeToDate(0, 0x21);
  assert.equal(date.getFullYear(), 1980);
  assert.equal(date.getMonth(), 0);
  assert.equal(date.getDate(), 1);
});

test('zip: 非 ZIP 文件应抛错', () => {
  const file = writeTemp('broken.apk', Buffer.from('not a zip at all'));
  assert.throws(() => openZip(file));
});

// ==================== 3. res-chunk / StringPool ====================

test('res-chunk: readChunkHeader 解析 type/headerSize/size', () => {
  const pool = makeStringPool(['a']);
  const header = readChunkHeader(pool, 0);
  assert.equal(header.type, 0x0001);
  assert.equal(header.headerSize, 28);
  assert.equal(header.size, pool.length);
});

test('res-chunk: parseStringPool 解析 UTF-8 字符串池', () => {
  const strings = ['android', 'permission', 'INTERNET', '中文标签'];
  const parsed = parseStringPool(makeStringPool(strings, true), 0);
  assert.equal(parsed.stringCount, strings.length);
  assert.equal(parsed.utf8, true);
  assert.deepEqual(parsed.strings, strings);
});

test('res-chunk: parseStringPool 解析 UTF-16 字符串池', () => {
  const strings = ['hello', '世界'];
  const parsed = parseStringPool(makeStringPool(strings, false), 0);
  assert.equal(parsed.utf8, false);
  assert.deepEqual(parsed.strings, strings);
});

test('res-chunk: resValueToString 还原字符串引用与布尔值', () => {
  const pool = { strings: ['AndroidManifest.xml', 'com.demo'] };
  assert.equal(resValueToString({ dataType: TYPE_STRING, data: 1 }, pool), 'com.demo');
  assert.equal(resValueToString({ dataType: TYPE_INT_BOOLEAN, data: 0xffffffff }, pool), 'true');
  assert.equal(resValueToString({ dataType: TYPE_INT_BOOLEAN, data: 0 }, pool), 'false');
  assert.equal(resValueToString({ dataType: TYPE_REFERENCE, data: 0x7f060000 }, pool), '@ref/0x7f060000');
});

test('res-chunk: splitResourceId 拆分 0xPPTTEEEE', () => {
  const parts = splitResourceId(0x7f060000);
  assert.equal(parts.packageId, 0x7f);
  assert.equal(parts.typeId, 0x06);
  assert.equal(parts.entryId, 0x0000);
  assert.equal(parts.hex, '0x7f060000');
});

// ==================== 4. AXML ====================

test('axml: isBinaryXml 识别二进制与文本 XML', () => {
  assert.equal(axml.isBinaryXml(makeBinaryXml()), true);
  assert.equal(axml.isBinaryXml(Buffer.from('<?xml version="1.0"?>')), false);
  assert.equal(axml.isBinaryXml(Buffer.alloc(4)), false);
});

test('axml: parseXml 解析二进制 Manifest', () => {
  const buffer = makeBinaryXml();
  assert.equal(axml.isBinaryXml(buffer), true);

  const rootNode = axml.parseBinaryXml(buffer);
  assert.equal(rootNode.tag, 'manifest');
  assert.equal(axml.attr(rootNode, 'package'), 'com.demo');

  const parsed = axml.parseXml(buffer);
  assert.equal(parsed.format, 'binary');
  assert.equal(parsed.root.tag, 'manifest');
});

test('axml: parseXml 解析文本 XML 并暴露属性访问器', () => {
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.demo.app" android:versionCode="42">\n'
    + '  <uses-permission android:name="android.permission.INTERNET" />\n'
    + '  <application android:label="Demo" android:debuggable="true" />\n'
    + '</manifest>';
  const parsed = axml.parseXml(Buffer.from(xml, 'utf8'));
  assert.equal(parsed.format, 'text');
  assert.equal(axml.attr(parsed.root, 'package'), 'com.demo.app');
  // 属性名按本地名匹配（android: 前缀由 isAndroidNs 标记）
  assert.equal(axml.intAttr(parsed.root, 'versionCode'), 42);

  const permissions = axml.childElements(parsed.root, 'uses-permission');
  assert.equal(permissions.length, 1);
  assert.equal(axml.attr(permissions[0], 'name'), 'android.permission.INTERNET');

  const application = axml.findChild(parsed.root, 'application');
  assert.equal(axml.attr(application, 'label'), 'Demo');
  assert.equal(axml.boolAttr(application, 'debuggable'), true);
});

test('axml: parseXml 支持自闭合标签与空元素', () => {
  const parsed = axml.parseXml(Buffer.from('<manifest><a x="1"/><b/><c>text</c></manifest>', 'utf8'));
  const children = axml.childElements(parsed.root);
  assert.equal(children.length, 3);
  assert.equal(axml.attr(axml.childElements(parsed.root, 'a')[0], 'x'), '1');
  assert.equal(axml.childElements(parsed.root, 'c').length, 1);
});

test('axml: intAttr 支持十六进制并带兜底值', () => {
  const parsed = axml.parseXml(Buffer.from('<manifest a="0x10" b="notanumber"/>', 'utf8'));
  assert.equal(axml.intAttr(parsed.root, 'a'), 16);
  assert.equal(axml.intAttr(parsed.root, 'b', -1), -1);
  assert.equal(axml.intAttr(parsed.root, 'missing', 99), 99);
});

test('axml: parseXml 对非 Manifest 内容抛错', () => {
  assert.throws(() => axml.parseXml(Buffer.from('<root><a/></root>', 'utf8')), /无法识别的 AndroidManifest\.xml 格式/);
});

// ==================== 5. plist ====================

test('plist: parseXmlPlist 解析字典/数组/布尔/整数/实数', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.demo.app</string>
  <key>UIRequiresFullScreen</key>
  <true/>
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationLandscapeLeft</string>
  </array>
  <key>EmptyArray</key>
  <array/>
  <key>EmptyDict</key>
  <dict/>
  <key>ItemCount</key>
  <integer>7</integer>
  <key>Ratio</key>
  <real>1.5</real>
</dict>
</plist>`;
  const parsed = plist.parseXmlPlist(xml);
  assert.equal(parsed.CFBundleIdentifier, 'com.demo.app');
  assert.equal(parsed.UIRequiresFullScreen, true);
  assert.deepEqual(parsed.UISupportedInterfaceOrientations, [
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationLandscapeLeft'
  ]);
  assert.deepEqual(parsed.EmptyArray, []);
  assert.deepEqual(parsed.EmptyDict, {});
  assert.equal(parsed.ItemCount, 7);
  assert.equal(parsed.Ratio, 1.5);
});

test('plist: 自闭合空数组不会吞掉后续键（回归）', () => {
  const xml = '<plist version="1.0"><dict>'
    + '<key>A</key><array/>'
    + '<key>B</key><string>after</string>'
    + '<key>C</key><string>also-after</string>'
    + '</dict></plist>';
  const parsed = plist.parseXmlPlist(xml);
  assert.equal(parsed.B, 'after');
  assert.equal(parsed.C, 'also-after');
  assert.deepEqual(parsed.A, []);
});

test('plist: decodeXmlEntities 还原实体', () => {
  assert.equal(plist.decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
});

test('plist: parseBinaryPlist 解析二进制 plist', () => {
  const parsed = plist.parseBinaryPlist(makeBinaryPlist());
  assert.equal(parsed.K, 'V');
});

test('plist: parsePlist 自动识别 XML 与二进制', () => {
  const xml = '<plist version="1.0"><dict><key>K</key><string>V</string></dict></plist>';
  assert.equal(plist.parsePlist(Buffer.from(xml, 'utf8')).K, 'V');
  assert.equal(plist.parsePlist(makeBinaryPlist()).K, 'V');
  assert.equal(plist.parsePlist(Buffer.alloc(0)), null);
});

test('plist: plistString / plistBool / plistNumber 带兜底值', () => {
  assert.equal(plist.plistString('x'), 'x');
  assert.equal(plist.plistString(5), '5');
  assert.equal(plist.plistString(null), '');
  assert.equal(plist.plistBool(true), true);
  assert.equal(plist.plistBool(undefined, false), false);
  assert.equal(plist.plistNumber('42'), 42);
  assert.equal(plist.plistNumber('abc', 7), 7);
});

// ==================== 6. DER / X.509 ====================

test('der: readDerElement 解析 TLV 短长度与长长度', () => {
  const short = derPrintable('hi');
  const el = der.readDerElement(short, 0);
  assert.equal(el.tagNumber, 0x13);
  assert.equal(el.length, 2);
  assert.equal(el.headerLength, 2);
  assert.equal(der.readStringValue(short, el), 'hi');

  const long = derTlv(0x04, Buffer.alloc(300, 1));
  const el2 = der.readDerElement(long, 0);
  assert.equal(el2.length, 300);
  assert.equal(el2.headerLength, 4);
  assert.equal(el2.end, long.length);
});

test('der: readDerElement 越界或非法长度返回 null', () => {
  assert.equal(der.readDerElement(Buffer.from([0x30]), 0), null);
  assert.equal(der.readDerElement(Buffer.from([0x30, 0x05, 0x01]), 0), null);
});

test('der: readOid 解码 OID 点分字符串', () => {
  const oid = derOid(OID_SHA256_RSA);
  const el = der.readDerElement(oid, 0);
  assert.equal(der.readOid(oid, el), '1.2.840.113549.1.1.11');
});

test('der: readInteger 解码整数（BigInt）', () => {
  const pos = derIntegerFromInt(65537);
  const el = der.readDerElement(pos, 0);
  assert.equal(der.readInteger(pos, el), 65537n);
});

test('der: parseName 解析 RDN 为结构化 DN', () => {
  const name = derSeq(
    derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8('Demo CN'))),
    derSet(derSeq(derOid([0x55, 0x04, 0x06]), derPrintable('CN'))),
    derSet(derSeq(derOid([0x55, 0x04, 0x0a]), derUtf8('Demo Org')))
  );
  const el = der.readDerElement(name, 0);
  const parsed = der.parseName(name, el);
  assert.equal(parsed.commonName, 'Demo CN');
  assert.equal(parsed.country, 'CN');
  assert.equal(parsed.organization, 'Demo Org');
  assert.ok(parsed.full.includes('CN=Demo CN'));
});

test('der: parseSubjectPublicKeyInfo 识别 RSA 2048 密钥长度', () => {
  const modulus = Buffer.concat([Buffer.from([0x00, 0x80]), Buffer.alloc(255, 0x11)]);
  const rsaPublicKey = derSeq(derTlv(0x02, modulus), derIntegerFromInt(65537));
  const spki = derSeq(
    derSeq(derOid(OID_RSA), derNull()),
    derTlv(0x03, Buffer.concat([Buffer.from([0x00]), rsaPublicKey]))
  );
  const el = der.readDerElement(spki, 0);
  const parsed = der.parseSubjectPublicKeyInfo(spki, el);
  assert.equal(parsed.algorithm, 'RSA');
  assert.equal(parsed.keySize, 2048);
  assert.equal(parsed.keySizeLabel, '2048 bit RSA');
});

test('der: parseSubjectPublicKeyInfo 识别 EC 曲线与密钥长度', () => {
  const spki = derSeq(
    derSeq(derOid(OID_EC), derOid(OID_P256)),
    derTlv(0x03, Buffer.concat([Buffer.from([0x00, 0x04]), Buffer.alloc(64, 9)]))
  );
  const el = der.readDerElement(spki, 0);
  const parsed = der.parseSubjectPublicKeyInfo(spki, el);
  assert.equal(parsed.algorithm, 'EC');
  assert.equal(parsed.keySize, 256);
  assert.ok(parsed.curve, '应给出曲线标识');
});

test('der: parseX509Certificate 抽取主题/颁发者/有效期/算法', () => {
  const tbs = derSeq(
    derTlv(0xa0, derIntegerFromInt(2)),
    derIntegerFromInt(0x1234),
    derSeq(derOid(OID_SHA256_RSA), derNull()),
    derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8('Issuer CN')))),
    derSeq(derUtcTime('250101000000Z'), derUtcTime('300101000000Z')),
    derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8('Demo CN')))),
    derSeq(derSeq(derOid(OID_RSA), derNull()), derTlv(0x03, Buffer.concat([Buffer.from([0x00]), derSeq(derIntegerFromInt(3), derIntegerFromInt(65537))])))
  );
  const cert = derSeq(
    tbs,
    derSeq(derOid(OID_SHA256_RSA), derNull()),
    derTlv(0x03, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16, 3)]))
  );
  const parsed = der.parseX509Certificate(cert);
  assert.equal(parsed.subject.commonName, 'Demo CN');
  assert.equal(parsed.issuer.commonName, 'Issuer CN');
  assert.equal(parsed.signature_algorithm, 'SHA256withRSA');
  assert.equal(parsed.serial, '4660');
  assert.equal(parsed.not_after.getUTCFullYear(), 2030);
  assert.equal(parsed.is_expired, false);
  assert.equal(parsed.fingerprints.sha256.length, 64);
  assert.equal(parsed.der_length, cert.length);
});

test('der: parseX509Certificate 拒绝非 SEQUENCE 输入', () => {
  assert.throws(() => der.parseX509Certificate(Buffer.from([0x04, 0x01, 0x00])), /不是有效的 X\.509 证书/);
});

// ==================== 7. binary: DEX / ELF / Mach-O / protobuf ====================

test('binary: isDex / parseDexHeader', () => {
  const dex = makeDex({ methods: 12, classes: 5 });
  assert.equal(binary.isDex(dex), true);
  assert.equal(binary.isDex(Buffer.from('not a dex')), false);

  const header = binary.parseDexHeader(dex);
  assert.equal(header.version, '035');
  assert.equal(header.method_ids_size, 12);
  assert.equal(header.class_defs_size, 5);
  assert.equal(header.file_size, 112);
});

test('binary: isObfuscatedClassName 依据 DEX 类型描述符判定短类名', () => {
  assert.equal(binary.isObfuscatedClassName('La;'), true);
  assert.equal(binary.isObfuscatedClassName('La/b/c;'), true);
  assert.equal(binary.isObfuscatedClassName('Lcom/example/MainActivity;'), false);
  assert.equal(binary.isObfuscatedClassName('Landroid/app/Activity;'), false);
  assert.equal(binary.isObfuscatedClassName('not-a-descriptor'), false);
});

test('binary: isElf / parseElf 解析架构与类型', () => {
  const elf = makeElf();
  assert.equal(binary.isElf(elf), true);
  assert.equal(binary.isElf(Buffer.from([1, 2, 3, 4])), false);

  const parsed = binary.parseElf(elf);
  assert.equal(parsed.bits, 64);
  assert.equal(parsed.endian, 'little');
  assert.equal(parsed.arch, 'AArch64');
  assert.match(parsed.type, /DYN/);
});

test('binary: isMachO / parseMachO 解析 thin 二进制头', () => {
  const macho = makeMachO();
  assert.equal(binary.isMachO(macho), true);
  assert.equal(binary.isMachO(Buffer.from([0, 1, 2, 3])), false);

  const parsed = binary.parseMachO(macho);
  assert.equal(parsed.fat, false);
  assert.equal(parsed.architectures.length, 1);
  assert.equal(parsed.architectures[0].arch, 'arm64');
});

test('binary: machoArchLabel 区分 arm64 与 arm64e', () => {
  assert.equal(binary.machoArchLabel(0x0100000c, 0), 'arm64');
  assert.equal(binary.machoArchLabel(0x0100000c, 2), 'arm64e');
});

test('binary: readVarint / parseProtobuf 解析 AAB BundleConfig 片段', () => {
  // 字段 1（varint）= 150  →  08 96 01
  const varint = binary.readVarint(Buffer.from([0x08, 0x96, 0x01]), 0);
  assert.equal(varint.value, 8, '不带 tag 偏移时读出 tag 本身');

  const payload = binary.readVarint(Buffer.from([0x08, 0x96, 0x01]), 1);
  assert.equal(payload.value, 150);

  // 字段 2（string）= "hi"  →  12 02 68 69
  const parsed = binary.parseProtobuf(Buffer.from([0x12, 0x02, 0x68, 0x69]));
  assert.deepEqual(parsed['2'], ['hi']);

  // 字段 1（varint）= 150
  assert.deepEqual(binary.parseProtobuf(Buffer.from([0x08, 0x96, 0x01]))['1'], [150]);
});

// ==================== 8. rules 规则引擎 ====================

test('rules: computeRiskScore 按严重级别加权', () => {
  const none = rules.computeRiskScore([]);
  assert.equal(none.score, 0);
  assert.equal(none.level, 'safe');

  const one = rules.computeRiskScore([{ severity: 'critical' }]);
  assert.equal(one.score, 34);
  assert.equal(one.level, 'low');

  const counts = rules.computeRiskScore([
    { severity: 'critical' }, { severity: 'high' }, { severity: 'info' }
  ]).counts;
  assert.equal(counts.critical, 1);
  assert.equal(counts.high, 1);
  assert.equal(counts.info, 1);
});

test('rules: 分数随命中数递增且收敛，混合级别可达上限 100', () => {
  const highs = (n) => rules.computeRiskScore(
    Array.from({ length: n }, () => ({ severity: 'high' }))
  ).score;
  const seq = [1, 2, 4, 8, 16].map(highs);
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] >= seq[i - 1], `分数应单调不减: ${seq.join(' -> ')}`);
  }
  assert.ok(seq[0] < seq[seq.length - 1], '分数应随命中数增长');
  assert.ok(seq[seq.length - 1] < 100, '仅 high 不应顶到 100（衰减生效）');

  // 仅 critical 时收敛在 34/(1-0.45) ≈ 62
  const onlyCritical = rules.computeRiskScore(
    Array.from({ length: 40 }, () => ({ severity: 'critical' }))
  );
  assert.ok(onlyCritical.score >= 60 && onlyCritical.score < 70, `仅 critical 应收敛于 ~62，实际 ${onlyCritical.score}`);

  // 混合多级别应能触达上限
  const mixed = rules.computeRiskScore([
    ...Array.from({ length: 40 }, () => ({ severity: 'critical' })),
    ...Array.from({ length: 40 }, () => ({ severity: 'high' })),
    ...Array.from({ length: 40 }, () => ({ severity: 'medium' })),
    ...Array.from({ length: 40 }, () => ({ severity: 'low' }))
  ]);
  assert.equal(mixed.score, 100);
  assert.equal(mixed.level, 'critical');
});

test('rules: 等级阈值划分与标签完整', () => {
  const levelAt = (n, severity) => rules.computeRiskScore(
    Array.from({ length: n }, () => ({ severity }))
  ).level;
  assert.equal(rules.computeRiskScore([]).level, 'safe');
  assert.equal(levelAt(1, 'low'), 'safe', '1 条 low = 2 分，未达 low 阈值 14');
  assert.equal(levelAt(40, 'low'), 'safe', 'low 权重收敛上限 3.6 分，单独无法抬升等级');
  assert.equal(levelAt(1, 'high'), 'safe', '1 条 high = 13 分，仍低于 14');
  assert.equal(levelAt(2, 'high'), 'low', '2 条 high ≈ 20 分 → 低风险');
  assert.equal(levelAt(40, 'critical'), 'high');
  assert.equal(rules.LEVEL_LABELS.safe, '安全');
  assert.equal(rules.LEVEL_LABELS.low, '低风险');
  assert.equal(rules.LEVEL_LABELS.medium, '中风险');
  assert.equal(rules.LEVEL_LABELS.high, '高风险');
  assert.equal(rules.LEVEL_LABELS.critical, '严重');
});

test('rules: findMarkers 支持文本与 Buffer 两种来源', () => {
  const textHit = rules.findMarkers(['hello'], [{ type: 'text', value: 'say hello world', label: 'dex' }]);
  assert.equal(textHit.length, 1);
  assert.equal(textHit[0].where, 'dex');

  const bufHit = rules.findMarkers(['libc.so'], [{ type: 'buffer', value: Buffer.from('need libc.so here'), label: 'so' }]);
  assert.equal(bufHit.length, 1);
  assert.equal(bufHit[0].where, 'so');

  assert.equal(rules.findMarkers(['nothere'], [{ type: 'text', value: 'abc', label: 'x' }]).length, 0);
});

test('rules: detectSdks 从 DEX 字符串识别 SDK', () => {
  const sources = [{
    type: 'text',
    value: 'com.alipay.sdk.app.PayTask com.tencent.mm.opensdk.openapi.WXApi com.umeng.analytics.MobclickAgent',
    label: 'DEX 字符串'
  }];
  const sdks = rules.detectSdks(sources);
  const names = sdks.map((s) => s.sdk_name);
  assert.ok(names.some((n) => n.includes('支付宝')), `期望识别到支付宝 SDK，实际: ${names.join(', ')}`);
  assert.ok(names.some((n) => n.includes('微信')), `期望识别到微信 SDK，实际: ${names.join(', ')}`);
  for (const sdk of sdks) {
    assert.ok(Array.isArray(sdk.sdk_evidence) && sdk.sdk_evidence.length > 0, `${sdk.sdk_name} 应有识别依据`);
    assert.ok(sdk.sdk_category, `${sdk.sdk_name} 应有分类`);
  }
});

test('rules: detectSdks 对干净输入不误报', () => {
  const sdks = rules.detectSdks([{ type: 'text', value: 'nothing interesting here', label: 'x' }]);
  assert.equal(sdks.length, 0);
});

test('rules: detectPacker 识别加固方案并区分强/弱特征', () => {
  const packed = rules.detectPacker([{ type: 'text', value: 'libjiagu.so libjiagu_art.so', label: 'SO' }], { obfuscated: true });
  assert.equal(packed.is_packed, true);
  assert.ok(String(packed.packer_name).includes('360'), `期望识别 360 加固，实际: ${packed.packer_name}`);
  assert.equal(packed.is_obfuscated, true);

  const clean = rules.detectPacker([{ type: 'text', value: 'plain app', label: 'x' }], { obfuscated: false });
  assert.equal(clean.is_packed, false);
  assert.equal(clean.packer_name, null);
});

test('rules: detectHardening 仅对具体特征命中，避免误报（回归）', () => {
  // 裸标记不应命中
  const bare = rules.detectHardening([{ type: 'text', value: 'superuser qemu ptrace', label: 'x' }]);
  assert.deepEqual(Object.values(bare).filter(Boolean), [], '裸标记不应触发加固判定');

  // 具体特征应命中
  const real = rules.detectHardening([
    { type: 'text', value: 'TracerPid: reading /proc/self/status', label: 'x' }
  ]);
  assert.equal(real.anti_debug, true);
});

test('rules: makeFinding 生成规范的风险项结构', () => {
  const finding = rules.makeFinding('test-1', '权限', 'high', '测试问题', {
    evidence: ['a', 'b'],
    remediation: '移除该权限',
    cwe: 'CWE-250'
  });
  assert.equal(finding.id, 'test-1');
  assert.equal(finding.category, '权限');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.message, '测试问题');
  assert.deepEqual(finding.evidence, ['a', 'b']);
  assert.equal(finding.remediation, '移除该权限');
  assert.equal(finding.cwe, 'CWE-250');
  assert.equal(finding.owasp, null);
  assert.equal(finding.confidence, 'high');
});

// ==================== 9. index 入口与版本对比 ====================

test('index: 拒绝空路径与不存在的文件', () => {
  assert.throws(() => parsePackageStaticInfo(''), /请提供包体文件路径/);
  assert.throws(() => parsePackageStaticInfo(null), /请提供包体文件路径/);
  assert.throws(() => parsePackageStaticInfo('/definitely/not/here.apk'), /文件不存在/);
});

test('index: 对非包体 ZIP 报「不支持的文件类型」', () => {
  const notAPackage = writeTemp('note.txt', makeZip([{ name: 'a.txt', data: 'hi' }]));
  assert.throws(() => parsePackageStaticInfo(notAPackage), /不支持的文件类型/);
});

test('index: 对损坏的 .apk 抛错而非静默返回', () => {
  const broken = writeTemp('broken.apk', Buffer.from('this is not a zip file at all'));
  assert.throws(() => parsePackageStaticInfo(broken));
});

function makeInfo({ name, version, perms, components, sdks, score, size }) {
  return {
    basic: {
      file: { name, size, size_human: `${size} B` },
      app: { name, identifier: 'com.demo', version_name: version, version_code: '1', min_sdk: '21', target_sdk: '30' },
      signature: { sha256: 'abc' },
      structure: { dex_count: 1, packed: false },
      risk: { score, level: 'medium', level_label: '中风险' }
    },
    detailed: {
      '2.6': { requested: perms.map((p) => ({ name: p })) },
      '2.8': { activities: components.map((c) => ({ type: 'activity', name: c })) },
      '2.13': { entries: [{ name: 'classes.dex' }] },
      '2.14': { sdks: sdks.map((s) => ({ sdk_name: s })) },
      '2.15': { findings: [] }
    }
  };
}

test('index: comparePackageInfo 产出文档 2.18 的差异字段', () => {
  const before = makeInfo({
    name: 'v1.apk', version: '1.0.0', size: 1000, score: 40,
    perms: ['android.permission.INTERNET'], components: ['com.demo.A'], sdks: ['友盟']
  });
  const after = makeInfo({
    name: 'v2.apk', version: '2.0.0', size: 1500, score: 55,
    perms: ['android.permission.INTERNET', 'android.permission.CAMERA'],
    components: ['com.demo.A', 'com.demo.B'],
    sdks: ['友盟', '支付宝 SDK']
  });

  const diff = comparePackageInfo(before, after);
  assert.equal(diff.version_old, '1.0.0');
  assert.equal(diff.version_new, '2.0.0');
  assert.equal(diff.size_delta, 500);
  assert.equal(diff.risk_delta, 15);
  assert.deepEqual(diff.permission_added, ['android.permission.CAMERA']);
  assert.deepEqual(diff.permission_removed, []);
  assert.deepEqual(diff.component_added, ['activity:com.demo.B']);
  assert.deepEqual(diff.sdk_added, ['支付宝 SDK']);
  assert.equal(diff.signature_changed, false);
  assert.equal(diff.file_added_count, 0);
  assert.equal(diff.risk_level_old, '中风险');
});

test('index: comparePackageInfo 检测签名变更', () => {
  const before = makeInfo({ name: 'a.apk', version: '1', size: 1, score: 10, perms: [], components: [], sdks: [] });
  const after = makeInfo({ name: 'b.apk', version: '1', size: 1, score: 10, perms: [], components: [], sdks: [] });
  after.basic.signature.sha256 = 'def';
  assert.equal(comparePackageInfo(before, after).signature_changed, true);
});

test('index: comparePackageInfo 缺少完整结果时抛错', () => {
  assert.throws(() => comparePackageInfo({}, {}), /对比需要两份完整的解析结果/);
});

// ==================== 10. 真实包体端到端 ====================

const CANDIDATE_DIRS = [
  '/Users/violet/Documents/other_dev/QA_AUTO/apks',
  '/Users/violet/Downloads',
  '/Users/violet/Downloads/i4ToolsDownloads/App'
];

function findRealPackages() {
  const found = { apk: [], ipa: [] };
  for (const dir of CANDIDATE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const lower = entry.toLowerCase();
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch { continue; }
      if (lower.endsWith('.apk') && found.apk.length < 3) found.apk.push(full);
      else if (lower.endsWith('.ipa') && found.ipa.length < 2) found.ipa.push(full);
    }
  }
  return found;
}

const realPackages = findRealPackages();
const hasRealApk = realPackages.apk.length > 0;
const hasRealIpa = realPackages.ipa.length > 0;

test('e2e: 真实 APK 解析出两层结构且字段自洽', { skip: !hasRealApk && '未找到测试 APK' }, () => {
  for (const apkPath of realPackages.apk) {
    const info = parsePackageStaticInfo(apkPath);
    const label = path.basename(apkPath);

    assert.equal(info.schema_version, '0.2', `${label}: schema 版本`);
    assert.equal(info.platform, 'android', `${label}: platform`);
    assert.equal(info.container, 'apk', `${label}: container`);

    // 基本信息必需字段
    assert.ok(info.basic.file.name, `${label}: 文件名`);
    assert.equal(info.basic.file.type, 'APK', `${label}: 类型`);
    assert.equal(info.basic.file.sha256.length, 64, `${label}: SHA-256`);
    assert.equal(info.basic.file.sha1.length, 40, `${label}: SHA-1`);
    assert.equal(info.basic.file.md5.length, 32, `${label}: MD5`);
    assert.ok(info.basic.file.size > 0, `${label}: 文件大小`);
    assert.match(info.basic.file.size_human, /(B|KB|MB|GB)$/, `${label}: 可读大小`);

    // 应用标识
    assert.ok(info.basic.app.identifier, `${label}: 包名`);
    assert.ok(info.basic.app.version_name, `${label}: versionName`);
    assert.ok(info.basic.app.version_code, `${label}: versionCode`);
    assert.ok(info.basic.app.min_sdk, `${label}: minSdk`);

    // 签名
    assert.equal(info.basic.signature.signed, true, `${label}: 已签名`);
    assert.ok(Array.isArray(info.basic.signature.schemes), `${label}: 签名方案`);

    // 结构统计与详细分类一致
    const st = info.basic.structure;
    assert.equal(st.permission_count, info.detailed['2.6'].requested.length, `${label}: 权限数一致`);

    const comp = info.detailed['2.8'];
    const compTotal = comp.activities.length + comp.activity_aliases.length
      + comp.services.length + comp.receivers.length + comp.providers.length;
    assert.equal(st.component_count, compTotal, `${label}: 组件数一致`);

    // 风险
    assert.ok(info.basic.risk.score >= 0 && info.basic.risk.score <= 100, `${label}: 风险分区间`);
    assert.ok(['safe', 'low', 'medium', 'high', 'critical'].includes(info.basic.risk.level), `${label}: 风险等级`);
    for (const f of info.detailed['2.15'].findings) {
      assert.ok(f.id, `${label}: finding.id`);
      assert.ok(['critical', 'high', 'medium', 'low', 'info'].includes(f.severity), `${label}: finding.severity=${f.severity}`);
    }

    // 章节列表只包含 Android 适用项
    const ids = info.sections.map((s) => s.id);
    assert.ok(ids.includes('2.1'), `${label}: 含 2.1`);
    assert.ok(ids.includes('2.2'), `${label}: 含 2.2`);
    assert.ok(!ids.includes('2.3'), `${label}: 不应含 iOS 章节 2.3`);

    // 体积分类不应把 DEX 混进原生库
    const byCategory = Object.fromEntries(info.detailed['2.1'].size_analysis.by_category.map((c) => [c.name, c.size]));
    const dexBytes = (info.detailed['2.10'].dex_files || []).reduce((sum, d) => sum + (d.size || 0), 0);
    const soBytes = info.detailed['2.11'].so_total_size || 0;
    if (dexBytes > 0) {
      assert.ok(byCategory['代码'] >= dexBytes, `${label}: 「代码」分类应至少覆盖全部 DEX`);
      assert.ok(byCategory['原生库'] >= soBytes, `${label}: 「原生库」分类应至少覆盖全部 SO`);
      assert.ok(!byCategory['native'], `${label}: 不应残留旧的 native 分类名`);
    }

    // 原始数据
    assert.ok(info.detailed['2.19'].manifest_xml.includes('<manifest'), `${label}: Manifest 已解码`);
  }
});

test('e2e: 真实 IPA 解析出两层结构且字段自洽', { skip: !hasRealIpa && '未找到测试 IPA' }, () => {
  for (const ipaPath of realPackages.ipa) {
    const info = parsePackageStaticInfo(ipaPath);
    const label = path.basename(ipaPath);

    assert.equal(info.platform, 'ios', `${label}: platform`);
    assert.equal(info.container, 'ipa', `${label}: container`);
    assert.equal(info.basic.file.type, 'IPA', `${label}: 类型`);
    assert.equal(info.basic.file.sha256.length, 64, `${label}: SHA-256`);

    assert.ok(info.basic.app.identifier, `${label}: Bundle ID`);
    assert.ok(info.basic.app.version_name, `${label}: 版本名称`);
    assert.match(info.basic.app.identifier, /^[A-Za-z0-9.-]+$/, `${label}: Bundle ID 格式`);

    const ids = info.sections.map((s) => s.id);
    assert.ok(ids.includes('2.3'), `${label}: 含 2.3`);
    assert.ok(!ids.includes('2.2'), `${label}: 不应含 Android 章节 2.2`);

    // Info.plist 与 2.3 一致
    const plistSection = info.detailed['2.3'];
    assert.equal(plistSection.CFBundleIdentifier, info.basic.app.identifier, `${label}: Bundle ID 一致`);
    assert.ok(plistSection.raw_keys > 0, `${label}: 原始键数量`);

    // Mach-O
    const native = info.detailed['2.11'];
    assert.ok(native.binary_path, `${label}: 二进制路径`);
    assert.ok(Array.isArray(native.abis) && native.abis.length > 0, `${label}: ABI`);
    assert.ok(native.security && typeof native.security.pie === 'boolean', `${label}: 安全特性`);

    // 签名
    assert.equal(info.basic.signature.signed, true, `${label}: 已签名`);
    assert.ok(info.basic.signature.type, `${label}: 签名类型`);
  }
});

test('e2e: 解析结果可 JSON 序列化（IPC 传输安全）', { skip: !hasRealApk && '未找到测试 APK' }, () => {
  const info = parsePackageStaticInfo(realPackages.apk[0]);
  const roundTrip = JSON.parse(JSON.stringify(info));
  assert.equal(roundTrip.basic.app.identifier, info.basic.app.identifier);
  assert.equal(roundTrip.detailed['2.15'].findings.length, info.detailed['2.15'].findings.length);
  assert.ok(roundTrip.elapsed_ms >= 0);
});

test('e2e: 同一文件两次解析结果稳定', { skip: !hasRealApk && '未找到测试 APK' }, () => {
  const target = realPackages.apk[0];
  const a = parsePackageStaticInfo(target);
  const b = parsePackageStaticInfo(target);
  assert.equal(a.basic.file.sha256, b.basic.file.sha256);
  assert.equal(a.basic.risk.score, b.basic.risk.score);
  assert.equal(a.basic.structure.permission_count, b.basic.structure.permission_count);
  assert.deepEqual(a.detailed['2.14'].sdks.map((s) => s.sdk_name), b.detailed['2.14'].sdks.map((s) => s.sdk_name));
});

test('e2e: 同包自比对无差异', { skip: !hasRealApk && '未找到测试 APK' }, () => {
  const target = realPackages.apk[0];
  const info = parsePackageStaticInfo(target);
  const diff = comparePackageInfo(info, info);
  assert.equal(diff.size_delta, 0);
  assert.equal(diff.risk_delta, 0);
  assert.equal(diff.signature_changed, false);
  assert.deepEqual(diff.permission_added, []);
  assert.deepEqual(diff.permission_removed, []);
  assert.deepEqual(diff.risk_added, []);
  assert.deepEqual(diff.risk_fixed, []);
});
