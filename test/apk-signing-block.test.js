'use strict';

/**
 * APK 签名解析回归测试（electron/pkginfo/apksig.js）
 *
 * 两块内容：
 *
 * 1) Signing Block —— readApkSigningBlock 曾经把 blockStart 多减了 16，
 *    导致 leadingSize 自检必然失败 → 整个函数返回 null →
 *    v2 / v3 / v3.1 全都检测不到，界面上只显示 v1
 *    （表现为「APK 明明签名了却像没签」）。
 *
 * 2) v1 清单校验 —— 早先只按「META-INF/*.RSA 在不在」判断 v1，
 *    加固 / 重打包留下的失效签名文件会被误报成有效 v1。
 *    现在按 JAR 规范逐条比对 MANIFEST.MF 里的摘要。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openZip } = require('../electron/pkginfo/zip');
const {
  readApkSigningBlock,
  readV1Certificates,
  parseApkSignature,
  APK_SIG_BLOCK_MAGIC,
  BLOCK_ID_V2,
  BLOCK_ID_V3,
  BLOCK_ID_V31,
  BLOCK_ID_VERITY_PADDING
} = require('../electron/pkginfo/apksig');

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apksig-block-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }
});

// ==================== ZIP 构造 ====================

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * 按规范拼一个 APK Signing Block。
 *
 * 布局：
 *   [uint64 size_of_block]   ← 不含自身
 *   [ID-value 对...]
 *   [uint64 size_of_block]   ← 与上面同值
 *   [16 字节 magic]
 *
 * size_of_block = 8（第二个 size 字段）+ 各对总长 + 16（magic）
 */
function buildSigningBlock(pairs) {
  const pairBufs = pairs.map(({ id, value }) => {
    const buf = Buffer.alloc(8 + 4 + value.length);
    buf.writeBigUInt64LE(BigInt(4 + value.length), 0);
    buf.writeUInt32LE(id, 8);
    value.copy(buf, 12);
    return buf;
  });
  const pairsTotal = pairBufs.reduce((sum, b) => sum + b.length, 0);
  const sizeOfBlock = 8 + pairsTotal + 16;

  return Buffer.concat([
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(sizeOfBlock), 0); return b; })(),
    ...pairBufs,
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(sizeOfBlock), 0); return b; })(),
    Buffer.from(APK_SIG_BLOCK_MAGIC, 'latin1')
  ]);
}

/**
 * 造一个 APK（STORED 方式）。
 * @param {Array<{name: string, data: Buffer}>} files
 * @param {Array<{id: number, value: Buffer}>|null} signingPairs 传 null 则不带 Signing Block
 */
function makeApk(files, signingPairs) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x800, 6);         // flags: UTF-8
    local.writeUInt16LE(0, 8);             // method: stored
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0, 12);            // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, file.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);      // version made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal
    // external (unix mode)。注意：JS 的 << 是「有符号 int32」移位，
    // 0o100644 << 16 = 2175070208 会溢出成负数，必须先 >>> 0 转回无符号。
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);     // local header offset
    nameBuf.copy(central, 46);

    centralParts.push(central);
    offset += local.length + file.data.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  // 带 Signing Block 时，Central Directory 整体后移
  const block = signingPairs ? buildSigningBlock(signingPairs) : Buffer.alloc(0);
  const cdOffset = localSection.length + block.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);        // ← 关键：指向块之后的 CD
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, block, centralSection, eocd]);
}

function writeApk(files, signingPairs) {
  const file = path.join(tempDir(), 'test.apk');
  fs.writeFileSync(file, makeApk(files, signingPairs));
  return file;
}

const SAMPLE_FILES = [
  { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
  { name: 'classes.dex', data: Buffer.from('dex\n035\0payload') },
  { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') }
];

// ==================== 回归：Signing Block 必须能被找到 ====================

test('readApkSigningBlock 能找到带 v2 的 Signing Block（曾经的 off-by-16 回归）', () => {
  const v2Value = Buffer.from('fake-v2-signature-value');
  const file = writeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: v2Value }]);

  const block = readApkSigningBlock(openZip(file));
  assert.ok(block, '应解析出 Signing Block —— 返回 null 就是那个 off-by-16 的 bug 复现了');
  assert.equal(block.entries.length, 1);
  assert.equal(block.entries[0].id, BLOCK_ID_V2);
  assert.deepEqual(Buffer.from(block.entries[0].value), v2Value);
});

test('Signing Block 的 offset / size 与规范一致', () => {
  const file = writeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(100, 7) }]);
  const zip = openZip(file);
  const block = readApkSigningBlock(zip);

  // 块起点 = CD 起点 - 块总长；块总长 = 8（首个 size 字段）+ size_of_block
  const cdOffset = zip.centralDirectoryOffset;
  assert.equal(block.offset + block.size, cdOffset, '块必须紧贴 Central Directory 之前结束');

  // 块首尾两个 size 字段必须相等
  const head = zip._readRange(block.offset, 8).readBigUInt64LE(0);
  const tail = zip._readRange(cdOffset - 24, 8).readBigUInt64LE(0);
  assert.equal(head, tail, '首尾 size 字段必须相等');

  // magic 必须落在块末尾
  assert.equal(zip._readRange(cdOffset - 16, 16).toString('latin1'), APK_SIG_BLOCK_MAGIC);
});

test('块大小 = 8 + size_of_block，不多不少', () => {
  const file = writeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(64) }]);
  const zip = openZip(file);
  const block = readApkSigningBlock(zip);
  const sizeOfBlock = Number(zip._readRange(zip.centralDirectoryOffset - 24, 8).readBigUInt64LE(0));
  assert.equal(block.size, 8 + sizeOfBlock);
});

test('能同时解析 v2 / v3 / v3.1 / verity padding 多个块', () => {
  const file = writeApk(SAMPLE_FILES, [
    { id: BLOCK_ID_V2, value: Buffer.alloc(48, 1) },
    { id: BLOCK_ID_V3, value: Buffer.alloc(56, 2) },
    { id: BLOCK_ID_V31, value: Buffer.alloc(60, 3) },
    { id: BLOCK_ID_VERITY_PADDING, value: Buffer.alloc(80, 4) }
  ]);

  const block = readApkSigningBlock(openZip(file));
  assert.equal(block.entries.length, 4);
  assert.deepEqual(
    block.entries.map((entry) => entry.id),
    [BLOCK_ID_V2, BLOCK_ID_V3, BLOCK_ID_V31, BLOCK_ID_VERITY_PADDING]
  );
  // byId 索引可用
  assert.equal(block.byId.get(BLOCK_ID_V3).value.length, 56);
  assert.equal(block.byId.get(BLOCK_ID_V2).length, 48);
});

test('v2/v3/v3.1 都能被识别出名字', () => {
  const file = writeApk(SAMPLE_FILES, [
    { id: BLOCK_ID_V2, value: Buffer.alloc(16) },
    { id: BLOCK_ID_V3, value: Buffer.alloc(16) },
    { id: BLOCK_ID_V31, value: Buffer.alloc(16) }
  ]);
  const block = readApkSigningBlock(openZip(file));
  assert.match(block.byId.get(BLOCK_ID_V2).name, /v2/);
  assert.match(block.byId.get(BLOCK_ID_V3).name, /v3/);
  assert.match(block.byId.get(BLOCK_ID_V31).name, /v3\.1/);
});

test('未知 ID 不会被丢掉，而是标为未知块', () => {
  const file = writeApk(SAMPLE_FILES, [{ id: 0x504b4453, value: Buffer.alloc(32) }]);
  const block = readApkSigningBlock(openZip(file));
  assert.equal(block.entries.length, 1);
  assert.match(block.entries[0].name, /未知块/);
  assert.equal(block.entries[0].idHex, '0x504b4453');
});

test('单个 ID-value 对的值长度要正确截断（不能把后面的对吃进来）', () => {
  const file = writeApk(SAMPLE_FILES, [
    { id: BLOCK_ID_V2, value: Buffer.alloc(20, 0xaa) },
    { id: BLOCK_ID_V3, value: Buffer.alloc(33, 0xbb) }
  ]);
  const block = readApkSigningBlock(openZip(file));
  assert.equal(block.byId.get(BLOCK_ID_V2).value.length, 20);
  assert.equal(block.byId.get(BLOCK_ID_V3).value.length, 33);
  assert.ok(block.byId.get(BLOCK_ID_V2).value.every((b) => b === 0xaa));
  assert.ok(block.byId.get(BLOCK_ID_V3).value.every((b) => b === 0xbb));
});

// ==================== 边界 ====================

test('没有 Signing Block 的普通 ZIP 返回 null', () => {
  const file = writeApk(SAMPLE_FILES, null);
  assert.equal(readApkSigningBlock(openZip(file)), null);
});

test('magic 被破坏时返回 null（不会误报）', () => {
  const raw = makeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(16) }]);
  const zip = openZip(writeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(16) }]));
  const cdOffset = zip.centralDirectoryOffset;

  // 把 magic 改掉
  const broken = Buffer.from(raw);
  broken.write('XXXXX Sig Block 42', cdOffset - 16, 'latin1');
  const brokenFile = path.join(tempDir(), 'broken.apk');
  fs.writeFileSync(brokenFile, broken);

  assert.equal(readApkSigningBlock(openZip(brokenFile)), null);
});

test('首尾 size 字段不一致时返回 null（自检生效）', () => {
  const raw = makeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(16) }]);
  const zip = openZip(writeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(16) }]));
  const cdOffset = zip.centralDirectoryOffset;
  const sizeOfBlock = Number(zip._readRange(cdOffset - 24, 8).readBigUInt64LE(0));
  const blockStart = cdOffset - 8 - sizeOfBlock;

  // 改掉块首的 size 字段
  const broken = Buffer.from(raw);
  broken.writeBigUInt64LE(BigInt(sizeOfBlock + 8), blockStart);
  const brokenFile = path.join(tempDir(), 'broken-size.apk');
  fs.writeFileSync(brokenFile, broken);

  assert.equal(readApkSigningBlock(openZip(brokenFile)), null);
});

test('空 ID-value 区（只有 size 和 magic）返回空 entries 而不是崩溃', () => {
  const file = writeApk(SAMPLE_FILES, []);
  const block = readApkSigningBlock(openZip(file));
  assert.ok(block);
  assert.deepEqual(block.entries, []);
});

test('Central Directory 偏移量在带块与不带块时都正确', () => {
  const plain = openZip(writeApk(SAMPLE_FILES, null));
  const withBlock = openZip(writeApk(SAMPLE_FILES, [{ id: BLOCK_ID_V2, value: Buffer.alloc(100) }]));
  assert.ok(withBlock.centralDirectoryOffset > plain.centralDirectoryOffset, '带块的 CD 应该更靠后');
  // 两者的条目数一致
  assert.equal(withBlock.entries.length, plain.entries.length);
  assert.deepEqual(withBlock.entries.map((e) => e.name), plain.entries.map((e) => e.name));
});

// ==================== v1 清单校验 ====================

const sha256Base64 = (buf) => crypto.createHash('sha256').update(buf).digest('base64');

/** 按 JAR 规范拼一份 MANIFEST.MF（CRLF 分行、空行分节、末尾留空行）。 */
function buildManifest(entries) {
  const lines = ['Manifest-Version: 1.0', ''];
  for (const entry of entries) {
    lines.push(`Name: ${entry.name}`);
    lines.push(`SHA-256-Digest: ${entry.digest || sha256Base64(entry.data)}`);
    lines.push('');
  }
  // 末尾补一个 CRLF，让最后一个分节也有完整的空行收尾
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

/** 造一个「有 v1 签名文件」的 APK；manifest 传 null 表示不带 MANIFEST.MF。 */
function makeV1Apk(manifest, extraFiles = []) {
  const files = [
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0payload') },
    // 签名文件只要「存在」即可，证书解析失败不影响 v1 是否成立的判定
    { name: 'META-INF/CERT.RSA', data: Buffer.from('not-a-real-pkcs7') },
    ...extraFiles
  ];
  if (manifest) files.push({ name: 'META-INF/MANIFEST.MF', data: manifest });
  return writeApk(files, null);
}

test('v1：清单摘要全部对得上 → verified = true', () => {
  const files = [
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0payload') }
  ];
  const zip = openZip(makeV1Apk(buildManifest(files)));

  const v1 = readV1Certificates(zip);
  assert.equal(v1.present, true, '有 META-INF/*.RSA，present 应为 true');
  assert.equal(v1.verified, true, '摘要全对，verified 应为 true');
  assert.equal(v1.verification.checked, 2);
  assert.deepEqual(v1.verification.mismatched, []);
});

test('v1：条目被改过 → verified = false 并指出是哪个条目（加固/重打包的典型形态）', () => {
  const original = Buffer.from('<manifest/>');
  const manifest = buildManifest([{ name: 'AndroidManifest.xml', data: original }]);

  // 签名之后再改内容：清单里的摘要还是老的
  const file = writeApk([
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest tampered="1"/>') },
    { name: 'META-INF/CERT.RSA', data: Buffer.from('not-a-real-pkcs7') },
    { name: 'META-INF/MANIFEST.MF', data: manifest }
  ], null);

  const v1 = readV1Certificates(openZip(file));
  assert.equal(v1.present, true);
  assert.equal(v1.verified, false, '内容变了，v1 就不能算有效');
  assert.equal(v1.verification.mismatched.length, 1);
  assert.equal(v1.verification.mismatched[0].name, 'AndroidManifest.xml');
  assert.match(v1.verification.reason, /重打包|加固/);
});

test('v1：失效的 v1 不能出现在签名方案里（这是「明明没签名却显示 v1」的根因）', () => {
  const manifest = buildManifest([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }]);
  const file = writeApk([
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest tampered="1"/>') },
    { name: 'META-INF/CERT.RSA', data: Buffer.from('not-a-real-pkcs7') },
    { name: 'META-INF/MANIFEST.MF', data: manifest }
  ], null);

  const sig = parseApkSignature(openZip(file));
  assert.equal(sig.v1.present, true, '签名文件确实在包里');
  assert.equal(sig.v1.verified, false);
  assert.equal(sig.v1.stale, true);
  assert.ok(!sig.signed_schemes.includes('v1'), '失效的 v1 不该算进签名方案');
  assert.deepEqual(sig.signed_schemes, []);
  assert.equal(sig.signed, false);
  // 关键：不能显示成「未签名」——包里明明有签名文件，得说清楚是「失效了」
  assert.equal(sig.scheme_label, '签名无效（v1 摘要不匹配）');
  assert.equal(sig.summary.v1_stale, true);
  assert.match(sig.v1.stale_reason, /重打包|加固/);
});

test('v1：清单里的摘要被折行（续行以空格开头）也能正确拼回来', () => {
  const data = Buffer.from('dex\n035\0payload');
  const digest = sha256Base64(data);
  const half = Math.ceil(digest.length / 2);

  // 手工构造折行的清单：第二行以单个空格开头
  const manifest = Buffer.from(
    'Manifest-Version: 1.0\r\n\r\n' +
    'Name: classes.dex\r\n' +
    `SHA-256-Digest: ${digest.slice(0, half)}\r\n ${digest.slice(half)}\r\n\r\n`,
    'utf8'
  );

  const file = writeApk([
    { name: 'classes.dex', data },
    { name: 'META-INF/CERT.RSA', data: Buffer.from('x') },
    { name: 'META-INF/MANIFEST.MF', data: manifest }
  ], null);

  const v1 = readV1Certificates(openZip(file));
  assert.equal(v1.verified, true, '折行的摘要必须拼回一行再比对，否则会误判为失效');
});

test('v1：清单列了但包里没有的条目 → 记入 mismatched', () => {
  const manifest = buildManifest([
    { name: 'classes.dex', data: Buffer.from('dex\n035\0payload') },
    { name: 'assets/missing.bin', data: Buffer.from('ghost') }
  ]);
  const file = writeApk([
    { name: 'classes.dex', data: Buffer.from('dex\n035\0payload') },
    { name: 'META-INF/CERT.RSA', data: Buffer.from('x') },
    { name: 'META-INF/MANIFEST.MF', data: manifest }
  ], null);

  const v1 = readV1Certificates(openZip(file));
  assert.equal(v1.verified, false);
  assert.deepEqual(v1.verification.mismatched.map((m) => m.name), ['assets/missing.bin']);
});

test('v1：没有 MANIFEST.MF 时给出明确原因，而不是默默算通过', () => {
  const zip = openZip(makeV1Apk(null));
  const v1 = readV1Certificates(zip);
  assert.equal(v1.present, true);
  assert.equal(v1.verified, false);
  assert.match(v1.verification.reason, /MANIFEST\.MF/);
});

test('v1：目录条目（以 / 结尾）不参与摘要比对', () => {
  const data = Buffer.from('dex\n035\0payload');
  // 目录分节没有内容，摘要拿「空内容的摘要」来占位，不该被当成「摘要不匹配」
  const manifest = Buffer.from(
    'Manifest-Version: 1.0\r\n\r\n' +
    `Name: classes.dex\r\nSHA-256-Digest: ${sha256Base64(data)}\r\n\r\n` +
    'Name: assets/\r\nSHA-256-Digest: 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\r\n\r\n',
    'utf8'
  );

  const file = writeApk([
    { name: 'classes.dex', data },
    { name: 'META-INF/CERT.RSA', data: Buffer.from('x') },
    { name: 'META-INF/MANIFEST.MF', data: manifest }
  ], null);

  const v1 = readV1Certificates(openZip(file));
  assert.equal(v1.verified, true, '目录条目没有内容，不该导致校验失败');
  assert.equal(v1.verification.checked, 1, '只应校验 classes.dex 一个条目');
});

test('v1：没有签名文件时不报 v1（present = false）', () => {
  const zip = openZip(writeApk(SAMPLE_FILES, null));
  const v1 = readV1Certificates(zip);
  assert.equal(v1.present, false);
  assert.equal(v1.verified, false);
});
