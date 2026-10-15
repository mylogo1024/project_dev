'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PLATFORM_LABELS,
  normalizeDevice,
  mergeDevices,
  describeDevice,
  QUICK_ACTIONS,
  quickActionsFor,
  pickQuickAction,
  resolveDeepLink
} = require('../src/lib/deviceHub');

// ---------- normalizeDevice ----------

test('字符串设备收敛为最小形状', () => {
  const device = normalizeDevice('emulator-5554');
  assert.equal(device.id, 'emulator-5554');
  assert.equal(device.platform, 'android');
  assert.equal(device.label, 'emulator-5554');
});

test('iOS 设备保留 platform/name/model/version', () => {
  const device = normalizeDevice({
    id: 'UDID-123',
    platform: 'ios',
    name: 'Violet 的 iPhone',
    model: 'iPhone16,1',
    version: '18.2'
  });
  assert.equal(device.platform, 'ios');
  assert.equal(device.name, 'Violet 的 iPhone');
  assert.equal(device.model, 'iPhone16,1');
  assert.equal(device.version, '18.2');
  // label 规则与「name 与 id 不同时带 UDID 后缀」一致
  assert.equal(device.label, 'Violet 的 iPhone (UDID-123)');
});

test('未知 platform 兜底为 android（adb 侧没有 platform 字段）', () => {
  const device = normalizeDevice({ id: 'abc123' });
  assert.equal(device.platform, 'android');
  assert.equal(device.model, null);
  assert.equal(device.version, null);
});

test('name 与 id 不同时 label 带 UDID 后缀', () => {
  const device = normalizeDevice({ id: 'UDID-9', platform: 'ios', name: '测试机' });
  assert.equal(device.label, '测试机 (UDID-9)');
});

// ---------- mergeDevices ----------

test('双平台合并：iOS 在前、同平台按 label 排序、无 id 的丢弃', () => {
  const merged = mergeDevices(
    [
      { id: 'b-device', platform: 'android' },
      { id: '', platform: 'android' },
      { id: 'a-device', platform: 'android' }
    ],
    [
      { id: 'ios-1', platform: 'ios', name: 'iPhone A', version: '17.0' },
      { id: 'ios-2', platform: 'ios', name: 'iPhone B', version: '18.2' }
    ]
  );
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.map((d) => d.platform), ['ios', 'ios', 'android', 'android']);
  assert.deepEqual(merged.map((d) => d.id), ['ios-1', 'ios-2', 'a-device', 'b-device']);
});

test('非数组入参安全兜底', () => {
  const merged = mergeDevices(null, undefined);
  assert.deepEqual(merged, []);
});

// ---------- describeDevice ----------

test('副标题：model + 平台版本', () => {
  assert.equal(
    describeDevice({ id: 'x', platform: 'ios', model: 'iPhone16,1', version: '18.2' }),
    'iPhone16,1 · iOS 18.2'
  );
});

test('副标题：无 model/version 时退化为截断 id', () => {
  const long = 'a'.repeat(30);
  assert.equal(describeDevice({ id: long, platform: 'android' }), `${'a'.repeat(16)}…`);
  assert.equal(describeDevice({ id: 'short', platform: 'android' }), 'short');
});

// ---------- 快捷动作 ----------

test('每个快捷动作都有 key/label/icon/target/platforms', () => {
  for (const action of QUICK_ACTIONS) {
    assert.ok(action.key, '缺 key');
    assert.ok(action.label, '缺 label');
    assert.ok(action.icon, '缺 icon');
    assert.ok(action.target, '缺 target');
    assert.ok(Array.isArray(action.platforms) && action.platforms.length > 0, '缺 platforms');
  }
});

test('双平台都能拿到动作且包含投屏', () => {
  for (const platform of ['android', 'ios']) {
    const actions = quickActionsFor({ platform });
    assert.ok(actions.length >= 3, `${platform} 动作过少`);
    assert.ok(actions.some((a) => a.key === 'mirror'), `${platform} 缺投屏入口`);
  }
});

test('默认动作是投屏操控', () => {
  assert.equal(pickQuickAction({ platform: 'android' })?.key, 'mirror');
  assert.equal(pickQuickAction({ platform: 'ios' })?.key, 'mirror');
});

// ---------- resolveDeepLink ----------

test('有效设备 + 目标功能返回深链', () => {
  const link = resolveDeepLink({ id: 'X1', platform: 'ios', name: 'iPhone' }, 'scrcpy');
  assert.equal(link.functionId, 'scrcpy');
  assert.equal(link.device.id, 'X1');
  assert.equal(link.device.platform, 'ios');
});

test('无 id 的设备返回 null', () => {
  assert.equal(resolveDeepLink({ platform: 'ios' }, 'scrcpy'), null);
  assert.equal(resolveDeepLink(null, 'scrcpy'), null);
});

test('PLATFORM_LABELS 双平台齐全', () => {
  assert.equal(PLATFORM_LABELS.android, 'Android');
  assert.equal(PLATFORM_LABELS.ios, 'iOS');
});
