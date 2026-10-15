'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  IOS_CONTROL_BACKENDS,
  isAtLeastIos,
  parseIosVersion,
  resolveIosControlPlan,
  resolveIosStreamPlan
} = require('../src/lib/iosControlPlan');
// 坐标映射留在 ESM 侧（渲染层要用）。请求构造的测试见 test/wda-requests.test.js ——
// 那个模块才是主进程实际使用的。
const { mapPointerToDevice } = require('../src/lib/wdaClient');

// ==================== 版本解析 ====================

test('ios version parsing handles the shapes devices actually report', () => {
  assert.deepEqual(parseIosVersion('17.4.1'), { major: 17, minor: 4, patch: 1 });
  assert.deepEqual(parseIosVersion('18'), { major: 18, minor: 0, patch: 0 });
  assert.deepEqual(parseIosVersion(' 26.6 '), { major: 26, minor: 6, patch: 0 });
  assert.equal(parseIosVersion(''), null);
  assert.equal(parseIosVersion(null), null);
  assert.equal(parseIosVersion('unknown'), null);
});

test('version comparison is numeric, not lexicographic', () => {
  // 字符串比较会把 '9' > '27' 判成真，这是经典坑
  assert.equal(isAtLeastIos('9.3', 27), false);
  assert.equal(isAtLeastIos('27.0', 27), true);
  assert.equal(isAtLeastIos('27.2', 27), true);
  assert.equal(isAtLeastIos('garbage', 12), false);
});

// ==================== 控制后端决策 ====================

test('an unreadable version is distinguished from "no device selected"', () => {
  // 这两种情况的处置完全不同，用同一句提示会把用户引到错误方向：
  // 「先连接设备」在设备已经连上时是误导。
  const noDevice = resolveIosControlPlan({ iosVersion: '', deviceConnected: false, platform: 'darwin' });
  assert.equal(noDevice.canControl, false);
  assert.equal(noDevice.versionKnown, false);
  assert.equal(noDevice.blockers[0].code, 'no-device');
  assert.match(noDevice.blockers[0].action, /选择一台 iPhone/);

  const unreadable = resolveIosControlPlan({ iosVersion: '', deviceConnected: true, platform: 'darwin' });
  assert.equal(unreadable.blockers[0].code, 'version-unreadable');
  assert.match(unreadable.blockers[0].action, /libimobiledevice|ProductVersion/);
  assert.doesNotMatch(unreadable.blockers[0].action, /先连接设备/);
});

test('go-ios wins when it is fully ready', () => {
  const plan = resolveIosControlPlan({
    iosVersion: '27.0',
    platform: 'darwin',
    tools: { 'go-ios': true },
    state: { tunnelUp: true, ddiMounted: true, streamRunning: true, wdaRunning: true }
  });
  assert.equal(plan.canControl, true);
  assert.equal(plan.backend, 'go-ios', '条件都满足时优先原生 HID');
});

test('wda is used when go-ios is not ready', () => {
  const plan = resolveIosControlPlan({
    iosVersion: '27.0',
    platform: 'darwin',
    tools: { 'go-ios': true },
    state: { tunnelUp: false, wdaRunning: true }
  });
  assert.equal(plan.backend, 'wda');
});

test('an older iphone is told exactly why go-ios cannot work', () => {
  // 这是最关键的一条：iOS 27 以下 CoreDevice HID 根本不存在，
  // 必须明确说清楚并引导到 WDA，而不是笼统地说「不支持」
  const plan = resolveIosControlPlan({
    iosVersion: '18.2',
    platform: 'darwin',
    tools: { 'go-ios': true },
    state: {}
  });
  assert.equal(plan.canControl, false);
  const codes = plan.blockers.map((item) => item.code);
  assert.ok(codes.includes('ios-too-old-for-go-ios'));
  assert.ok(codes.includes('wda-not-running'));
    const old = plan.blockers.find((item) => item.code === 'ios-too-old-for-go-ios');
    assert.match(old.action, /WebDriverAgent/, '要给出可执行的替代方案');
  });

  test('the wda blocker says different things depending on whether the app can start it', () => {
    // 「能由应用一键启动」和「必须先去装一次」是完全不同的两件事：
    // 前者给按钮就有用，后者给按钮只会让人反复点。文案必须分开。
    const withLauncher = resolveIosControlPlan({
      iosVersion: '16.7', platform: 'darwin', tools: { tidevice: true }, state: {}
    });
    const without = resolveIosControlPlan({
      iosVersion: '16.7', platform: 'darwin', tools: {}, state: {}
    });

    const a = withLauncher.blockers.find((item) => item.code === 'wda-not-running');
    const b = without.blockers.find((item) => item.code === 'wda-not-running');
    assert.ok(a, 'WDA 没跑时必须报出来');
    assert.ok(b, '缺工具时同样要报');

    assert.match(a.action, /启动 WebDriverAgent/, '有 tidevice 时应指向应用内的启动按钮');
    assert.match(a.message, /已装/, '应说明是「装了但没跑」，而不是「没装」');

    assert.match(b.action, /tidevice/, '缺工具时要说明缺什么');
    assert.doesNotMatch(b.action, /点「启动/, '缺工具时不该引导去点一个点不动的按钮');
  });

  test('a running wda clears the blocker and unlocks control', () => {
    const plan = resolveIosControlPlan({
      iosVersion: '16.7', platform: 'darwin', tools: { tidevice: true },
      state: { wdaRunning: true }
    });
    assert.equal(plan.canControl, true);
    assert.equal(plan.backend, 'wda');
    assert.equal(
      plan.blockers.some((item) => item.code === 'wda-not-running'), false,
      'WDA 已经在跑就不该再报「未运行」'
    );
  });

  test('the renderer does not hardcode wdaRunning to false', () => {
    // 曾经写死成 false，导致即使控制通道连上了，状态条也永远显示「未运行」——
    // 用户看到的是「明明连上了却说没连」。这类「写死的假值」只能靠守卫防住。
    const source = fs.readFileSync(path.join(ROOT, 'src/components/IosMirror.jsx'), 'utf8');
    const match = /state:\s*\{[^}]*wdaRunning:\s*([^,\n]+)/.exec(source);
    assert.ok(match, '找不到 wdaRunning 的赋值，测试需要更新');
    assert.notEqual(match[1].trim(), 'false',
      'wdaRunning 不能写死 false，应反映控制通道的真实状态');
  });

  test('a new iphone missing prerequisites lists each one separately', () => {  const plan = resolveIosControlPlan({
    iosVersion: '27.0',
    platform: 'darwin',
    tools: { 'go-ios': true },
    state: { tunnelUp: true, ddiMounted: false, streamRunning: false }
  });
  const codes = plan.blockers.map((item) => item.code);
  assert.ok(codes.includes('ddi-not-mounted'));
  assert.ok(codes.includes('stream-not-running'));
  // 隧道已建立就不该再报隧道问题
  assert.ok(!codes.includes('tunnel-down'));

  // 「媒体流没跑」是最容易被误判成「功能已实现」的一种，必须讲清楚后果
  const stream = plan.blockers.find((item) => item.code === 'stream-not-running');
  assert.match(stream.action, /丢弃|没反应/, '要说明症状，否则用户以为是自己点错了');
});

test('pymobiledevice3 is only used when the user installed it', () => {
  const without = resolveIosControlPlan({ iosVersion: '18.2', platform: 'darwin', tools: {}, state: {} });
  assert.notEqual(without.backend, 'pymobiledevice3');

  const withTool = resolveIosControlPlan({
    iosVersion: '18.2',
    platform: 'darwin',
    tools: { pymobiledevice3: true },
    state: {}
  });
  assert.equal(withTool.backend, 'pymobiledevice3');
});

test('non-macos platforms get an extra hint about the fragile link', () => {
  const plan = resolveIosControlPlan({
    iosVersion: '18.2',
    platform: 'win32',
    tools: {},
    state: {}
  });
  const note = plan.blockers.find((item) => item.code === 'non-macos-note');
  assert.ok(note, 'Windows / Linux 上要额外提示');
  assert.match(note.message, /Windows/);
});

test('backend table records the license constraint that drives the design', () => {
  // pymobiledevice3 是 GPL-3.0，不能随闭源产品分发 —— 这是选型时最容易忽略的硬约束
  assert.equal(IOS_CONTROL_BACKENDS.pymobiledevice3.bundleable, false);
  assert.equal(IOS_CONTROL_BACKENDS.pymobiledevice3.license, 'GPL-3.0');
  assert.equal(IOS_CONTROL_BACKENDS['go-ios'].bundleable, true);
  assert.equal(IOS_CONTROL_BACKENDS.wda.bundleable, true);
  assert.equal(IOS_CONTROL_BACKENDS['go-ios'].minIosMajor, 27);
});

// ==================== 画面来源决策 ====================

test('stream plan degrades from live to screenshot polling', () => {
  assert.equal(resolveIosStreamPlan({
    iosVersion: '27.0', platform: 'darwin', tools: { 'go-ios': true }, state: { tunnelUp: true, ddiMounted: true }
  }).method, 'go-ios-dvt');

  assert.equal(resolveIosStreamPlan({ iosVersion: '18.2', platform: 'darwin', tools: {} }).method, 'avfoundation');

  const poll = resolveIosStreamPlan({ iosVersion: '18.2', platform: 'win32', tools: {} });
  assert.equal(poll.method, 'screenshot-poll');
  assert.equal(poll.live, false, '截图轮询不是实时画面，必须如实标注');
});

// ==================== 坐标映射（点击画面 = 操作设备的关键） ====================

test('pointer maps to device coordinates when there is no letterbox', () => {
  // 画面与设备等比，无黑边
  const point = mapPointerToDevice({
    pointerX: 100, pointerY: 200,
    viewWidth: 400, viewHeight: 800,
    deviceWidth: 400, deviceHeight: 800
  });
  assert.deepEqual(point, { x: 100, y: 200 });
});

test('pointer mapping accounts for letterbox bars', () => {
  // 设备 400x800 放进 400x1000 的容器：上下各留 100px 黑边
  const centered = mapPointerToDevice({
    pointerX: 200, pointerY: 500,
    viewWidth: 400, viewHeight: 1000,
    deviceWidth: 400, deviceHeight: 800
  });
  assert.deepEqual(centered, { x: 200, y: 400 }, '要把上下黑边扣掉');

  // 点在黑边上 → 不算有效点击
  assert.equal(mapPointerToDevice({
    pointerX: 200, pointerY: 20,
    viewWidth: 400, viewHeight: 1000,
    deviceWidth: 400, deviceHeight: 800
  }), null);
});

test('pointer mapping scales correctly when the view is smaller', () => {
  // 设备 1170x2532（iPhone 13）显示在 390x844 的框里
  const point = mapPointerToDevice({
    pointerX: 195, pointerY: 422,
    viewWidth: 390, viewHeight: 844,
    deviceWidth: 1170, deviceHeight: 2532
  });
  assert.equal(point.x, 585);
  assert.equal(point.y, 1266);
});

test('pointer mapping clamps to the device instead of overflowing', () => {
  // 贴着右下角点，换算后可能算出 800 或 801，必须夹回 799
  const point = mapPointerToDevice({
    pointerX: 400, pointerY: 800,
    viewWidth: 400, viewHeight: 800,
    deviceWidth: 400, deviceHeight: 800
  });
  assert.deepEqual(point, { x: 399, y: 799 });
});

test('pointer mapping refuses invalid geometry instead of returning NaN', () => {
  const bad = [
    { viewWidth: 0, viewHeight: 800, deviceWidth: 400, deviceHeight: 800, pointerX: 1, pointerY: 1 },
    { viewWidth: 400, viewHeight: 800, deviceWidth: 0, deviceHeight: 0, pointerX: 1, pointerY: 1 },
    { viewWidth: 400, viewHeight: 800, deviceWidth: 400, deviceHeight: 800, pointerX: NaN, pointerY: 1 },
    {}
  ];
  for (const input of bad) {
    assert.equal(mapPointerToDevice(input), null, `不应返回坐标：${JSON.stringify(input)}`);
  }
});

test('clamped mapping keeps a swipe that ends outside the media area', () => {
  // 这是「只能点击、不能滑动」的直接根因：滑动手势的终点天然会滑出画面边缘
  // （上滑列表就是要滑到屏幕底边），默认行为会返回 null 把手势整条丢掉。
  const box = { viewWidth: 400, viewHeight: 1000, deviceWidth: 400, deviceHeight: 800 };

  // 终点落在上黑边（y=20 < 100）→ 钳到媒体区顶边，等价于滑到设备屏幕最上方
  assert.deepEqual(
    mapPointerToDevice({ ...box, pointerX: 200, pointerY: 20 }, { clamp: true }),
    { x: 200, y: 0 }
  );
  // 终点落在下黑边（y=980 > 900）→ 钳到媒体区底边
  assert.deepEqual(
    mapPointerToDevice({ ...box, pointerX: 200, pointerY: 980 }, { clamp: true }),
    { x: 200, y: 799 }
  );
  // 终点整个跑到画布左侧之外
  assert.deepEqual(
    mapPointerToDevice({ ...box, pointerX: -50, pointerY: 500 }, { clamp: true }),
    { x: 0, y: 400 }
  );
  // 默认（点击）行为不变：点黑边仍然不算有效点击
  assert.equal(mapPointerToDevice({ ...box, pointerX: 200, pointerY: 20 }), null);
});
