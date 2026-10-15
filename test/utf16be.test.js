'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { decodeUtf16Be } = require('../electron/pkginfo/util');

const be = (text) => {
  const le = Buffer.from(text, 'utf16le');
  le.swap16();
  return le;
};

// ==================== 背景 ====================
// Node 的 Buffer 只有 utf16le，没有 utf16be —— 直接写 toString('utf16be') 会抛
// `Unknown encoding: utf16be`。plist 的 bplist 0x6 类型与 X.509 的 BMPString
// 都是 UTF-16BE，之前那两处一旦命中就失败（plist 那条还会把整个 IPA 解析带崩）。

test('node really has no utf16be encoding (this is why the helper exists)', () => {
  assert.throws(() => Buffer.from('x').toString('utf16be'), /Unknown encoding/);
});

test('decodes utf16be text correctly', () => {
  assert.equal(decodeUtf16Be(be('hello')), 'hello');
  assert.equal(decodeUtf16Be(be('中文AB')), '中文AB');
  assert.equal(decodeUtf16Be(be('')), '');
});

test('decodes a slice rather than the whole buffer', () => {
  // plist 的场景：字符串嵌在 buffer 中间，按 [start, end) 取
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), be('中文'), Buffer.from([0x00])]);
  assert.equal(decodeUtf16Be(buffer, 2, 6), '中文');
});

test('an odd length drops the trailing half character instead of throwing', () => {
  // swap16() 要求偶数长度，直接调用会抛 ERR_INVALID_BUFFER_SIZE
  const odd = Buffer.concat([be('中'), Buffer.from([0x00])]);
  assert.doesNotThrow(() => decodeUtf16Be(odd));
  assert.equal(decodeUtf16Be(odd), '中');
});

test('tolerates an end beyond the buffer length', () => {
  const buffer = be('ab');
  assert.equal(decodeUtf16Be(buffer, 0, 999), 'ab');
});

test('an empty or out-of-range slice returns an empty string', () => {
  assert.equal(decodeUtf16Be(Buffer.alloc(0)), '');
  assert.equal(decodeUtf16Be(be('ab'), 99, 200), '');
});

// ==================== 回归：真实 IPA 不再因 UTF-16BE 崩 ====================

const CANDIDATE_DIRS = ['/Users/violet/Downloads', '/Users/violet/Downloads/i4ToolsDownloads/App'];

function findIpa() {
  for (const dir of CANDIDATE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isFile() && entry.toLowerCase().endsWith('.ipa')) return full;
      } catch (_) { /* 读不了就跳过 */ }
    }
  }
  return null;
}

const realIpa = findIpa();

test('real ipa parses and the framework flags agree with the detected list', { skip: !realIpa && '未找到测试 IPA' }, () => {
  const { parsePackageStaticInfo } = require('../electron/pkginfo');
  const info = parsePackageStaticInfo(realIpa);

  assert.equal(info.platform, 'ios', '应识别为 iOS 包体');
  assert.ok(info.basic?.app?.identifier, '包名应解析成功');

  // `frameworks.detected` 曾经恒为空数组，导致 8 个跨平台框架字段永远为 false。
  // 现在它由 detectIosFrameworks 的结果回填，所以「布尔字段」与
  // 「detected_frameworks 列表」必须一致 —— 这正是回归判据。
  const section = info.detailed['2.9'];
  const detectedNames = (section.detected_frameworks || []).map((item) => item.name);

  const MAP = {
    flutter: 'Flutter',
    react_native: 'React Native',
    unity: 'Unity',
    cordova: 'Cordova',
    ionic: 'Ionic / Capacitor',
    capacitor: 'Ionic / Capacitor',
    xamarin: 'Xamarin',
    cocos2d: 'Cocos2d-x'
  };

  for (const [flag, framework] of Object.entries(MAP)) {
    assert.equal(
      section[flag],
      detectedNames.includes(framework),
      `${flag} 应与 detected_frameworks 是否含「${framework}」一致`
    );
  }
});

test('framework detection actually fires for a known marker', () => {
  // 上面那条测试若碰到「本来就没有跨平台框架」的包体会全 false，
  // 那样就无法证明逻辑通。这里直接验证识别机制本身。
  const { detectIosFrameworks } = require('../electron/pkginfo/rules');
  const hits = detectIosFrameworks(['Payload/X.app/Frameworks/Flutter.framework/Flutter']);
  assert.deepEqual(hits.map((item) => item.name), ['Flutter']);
  assert.deepEqual(detectIosFrameworks(['nothing here']), []);
});
