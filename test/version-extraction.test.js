'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractVersionFromEvidence } = require('../electron/pkginfo/rules');

const textSource = (value) => ({ type: 'text', value, label: '测试' });

// ==================== 行为：提取结果必须和原来一致 ====================

test('extracts the version embedded around the sdk name', () => {
  const sources = [textSource('前缀 com/umeng/sdk/3.2.1 后缀')];
  assert.equal(extractVersionFromEvidence(sources, 'umeng'), '3.2.1');
});

test('takes the first version found after the first occurrence', () => {
  // 原来对全串做 match，拿到的是「第一个匹配」，现在开窗也要拿到同一个
  const sources = [textSource('a/umeng/1.0.0 b/umeng/2.0.0')];
  assert.equal(extractVersionFromEvidence(sources, 'umeng'), '1.0.0');
});

test('returns null when the name is absent', () => {
  assert.equal(extractVersionFromEvidence([textSource('nothing here')], 'umeng'), null);
});

test('returns null when there is a name but no version nearby', () => {
  assert.equal(extractVersionFromEvidence([textSource('com/umeng/sdk')], 'umeng'), null);
});

test('skips non-text sources', () => {
  const sources = [
    { type: 'buffer', value: Buffer.from('com/umeng/9.9.9'), label: '二进制' },
    textSource('com/umeng/1.2.3')
  ];
  assert.equal(extractVersionFromEvidence(sources, 'umeng'), '1.2.3');
});

test('handles a four-segment version', () => {
  assert.equal(extractVersionFromEvidence([textSource('x/foo/1.2.3.4')], 'foo'), '1.2.3.4');
});

test('a name containing regex metacharacters is escaped', () => {
  // 未转义时 `a.b` 里的 `.` 会匹配任意字符，可能命中错误位置
  const sources = [textSource('axb/1.0.0 a.b/2.0.0')];
  assert.equal(extractVersionFromEvidence(sources, 'a.b'), '2.0.0');
});

test('a name at the very start or end of the text still works', () => {
  assert.equal(extractVersionFromEvidence([textSource('umeng/5.0.0')], 'umeng'), '5.0.0');
  assert.equal(extractVersionFromEvidence([textSource('v1.0.0/umeng')], 'umeng'), '1.0.0');
});

// ==================== 性能：这是本次修复的核心 ====================

test('does not rescan the whole text for every sdk (the 296x fix)', () => {
  // 构造一段「很大且不含目标」的文本：旧实现会对每个 SDK 全串跑一次带回溯的正则，
  // 新实现先 indexOf（原生实现）直接判定不存在，立刻返回。
  const huge = 'x'.repeat(2 * 1024 * 1024);
  const sources = [textSource(huge)];

  const started = Date.now();
  for (let i = 0; i < 40; i += 1) {
    assert.equal(extractVersionFromEvidence(sources, 'sdk' + i), null);
  }
  const elapsed = Date.now() - started;

  // 旧实现在 8.5MB × 20 个 SDK 上要 5.9 秒；这里 2MB × 40 个若走老路会超过 1 秒。
  assert.ok(elapsed < 300, `40 次未命中检索耗时 ${elapsed}ms，疑似退化成全串扫描`);
});

test('windowed search still finds a version far from the start', () => {
  // 版本号在文本很靠后的位置 —— 开窗必须能覆盖到
  const filler = 'y'.repeat(500000);
  const sources = [textSource(filler + ' com/umeng/7.7.7 ' + filler)];
  assert.equal(extractVersionFromEvidence(sources, 'umeng'), '7.7.7');
});

// ==================== 真实包体回归 ====================

const CANDIDATE_DIRS = ['/Users/violet/Documents/other_dev/QA_AUTO/apks', '/Users/violet/Downloads'];

function findApk() {
  for (const dir of CANDIDATE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).isFile() && entry.toLowerCase().endsWith('.apk')) return full;
      } catch (_) { /* 读不了就跳过 */ }
    }
  }
  return null;
}

const realApk = findApk();

test('real apk: parsing is no longer dominated by version extraction', { skip: !realApk && '未找到测试 APK' }, () => {
  const { parsePackageStaticInfo } = require('../electron/pkginfo');
  const started = Date.now();
  const info = parsePackageStaticInfo(realApk);
  const elapsed = Date.now() - started;

  // 修复前这一步占 94% 耗时，24MB 的包要 6 秒以上
  assert.ok(info.basic?.app?.identifier, '解析结果仍应完整');
  assert.ok(elapsed < 3000, `解析耗时 ${elapsed}ms，仍然偏慢`);
});
