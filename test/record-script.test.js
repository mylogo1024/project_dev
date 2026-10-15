'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_STEPS,
  WAIT_CAP_MS,
  WAIT_GAP_MIN_MS,
  appendRecordedStep,
  buildRecordedScript,
  describeStep
} = require('../src/lib/recordScript');

// ---------- appendRecordedStep：间隔折算 wait ----------

test('gap 低于阈值不产生 wait 步', () => {
  const next = appendRecordedStep([], { op: 'tap', x: 1, y: 2 }, 200);
  assert.deepEqual(next, [{ op: 'tap', x: 1, y: 2 }]);
});

test('gap 达到阈值折算成 wait 步（毫秒取整）', () => {
  const next = appendRecordedStep([], { op: 'tap', x: 1, y: 2 }, WAIT_GAP_MIN_MS + 235.7);
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { op: 'wait', ms: WAIT_GAP_MIN_MS + 236 });
  assert.deepEqual(next[1], { op: 'tap', x: 1, y: 2 });
});

test('首个动作没有 gap，不产生 wait 步', () => {
  const next = appendRecordedStep([], { op: 'pressHome' }, 5000);
  // gap 传了很大，但调用方（IosMirror）首个动作传 0；lib 只看入参
  const first = appendRecordedStep([], { op: 'pressHome' }, 0);
  assert.deepEqual(first, [{ op: 'pressHome' }]);
  assert.equal(next.length, 2);
});

test('超长间隔封顶 10 秒（人发呆不该拖慢重放）', () => {
  const next = appendRecordedStep([], { op: 'tap', x: 9, y: 9 }, 120_000);
  assert.deepEqual(next[0], { op: 'wait', ms: WAIT_CAP_MS });
});

// ---------- appendRecordedStep：形状归一 ----------

test('tap 坐标取整', () => {
  const next = appendRecordedStep([], { op: 'tap', x: 12.6, y: 99.4 });
  assert.deepEqual(next, [{ op: 'tap', x: 13, y: 99 }]);
});

test('swipe 的 from/to 坐标取整且保留 duration', () => {
  const next = appendRecordedStep([], {
    op: 'swipe',
    from: { x: 10.5, y: 20.4 },
    to: { x: 30.6, y: 40.2 },
    duration: 0.8
  });
  assert.deepEqual(next, [{
    op: 'swipe',
    from: { x: 11, y: 20 },
    to: { x: 31, y: 40 },
    duration: 0.8
  }]);
});

test('其他 op 原样透传（pressButton / swipeDirection / launchApp…）', () => {
  const step = { op: 'swipeDirection', direction: 'up' };
  const next = appendRecordedStep([], step);
  assert.deepEqual(next, [step]);
  assert.notEqual(next[0], step, '透传也应复制，避免共享引用');
});

test('非法 step（无 op）直接忽略', () => {
  assert.deepEqual(appendRecordedStep([], { x: 1, y: 2 }), []);
  assert.deepEqual(appendRecordedStep([], null), []);
});

test('达到 MAX_STEPS 后拒绝再记', () => {
  let steps = [];
  for (let i = 0; i < MAX_STEPS + 10; i += 1) {
    steps = appendRecordedStep(steps, { op: 'pressHome' });
  }
  assert.equal(steps.length, MAX_STEPS);
});

test('纯函数：不改入参数组', () => {
  const input = [{ op: 'pressHome' }];
  const next = appendRecordedStep(input, { op: 'tap', x: 1, y: 1 });
  assert.equal(input.length, 1);
  assert.equal(next.length, 2);
});

// ---------- buildRecordedScript ----------

test('空录制返回 null', () => {
  assert.equal(buildRecordedScript([]), null);
  assert.equal(buildRecordedScript(undefined), null);
});

test('非空录制返回 name + deviceId + steps 拷贝', () => {
  const now = new Date(2026, 8, 29, 14, 5);
  const script = buildRecordedScript(
    [{ op: 'tap', x: 1, y: 2 }, { op: 'wait', ms: 800 }],
    { deviceId: 'udid-001', now }
  );
  assert.equal(script.name, 'recorded-20260929-1405');
  assert.equal(script.deviceId, 'udid-001');
  assert.equal(script.steps.length, 2);
  // steps 是拷贝，改脚本不影响录制现场
  script.steps.push({ op: 'pressHome' });
  assert.equal(script.steps.length, 3);
});

test('未传 deviceId 时兜底为空串（校验层会拦）', () => {
  const script = buildRecordedScript([{ op: 'pressHome' }], { now: new Date() });
  assert.equal(script.deviceId, '');
});

// ---------- describeStep ----------

test('每种 op 都有中文描述', () => {
  assert.match(describeStep({ op: 'tap', x: 100, y: 200 }), /^点击/);
  assert.match(describeStep({ op: 'longPress', x: 1, y: 2 }), /^长按/);
  assert.match(describeStep({ op: 'swipe', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }), /^滑动/);
  assert.equal(describeStep({ op: 'swipeDirection', direction: 'down' }), '向下滑一屏');
  assert.equal(describeStep({ op: 'type', text: 'hello world foo' }), '输入「hello world 」');
  assert.equal(describeStep({ op: 'pressButton', button: 'volumeUp' }), '音量+');
  assert.equal(describeStep({ op: 'pressButton', button: 'power' }), '电源键');
  assert.equal(describeStep({ op: 'pressHome' }), '回到主屏');
  assert.equal(describeStep({ op: 'unlock' }), '解锁屏幕');
  assert.equal(describeStep({ op: 'launchApp', bundleId: 'com.apple.mobilesafari' }), '启动 com.apple.mobilesafari');
  assert.equal(describeStep({ op: 'terminateApp', bundleId: 'com.x.y' }), '关闭 com.x.y');
  assert.equal(describeStep({ op: 'activeApp' }), '读取前台 App');
  assert.equal(describeStep({ op: 'assertActiveApp', bundleId: 'com.x.y' }), '校验前台 = com.x.y');
  assert.equal(describeStep({ op: 'assert' }), '校验断言');
  assert.equal(describeStep({ op: 'wait', ms: 1500 }), '等待 1500ms');
  assert.equal(describeStep({ op: 'screenshot', label: 'home' }), '截图「home」');
  assert.equal(describeStep({ op: 'screenshot' }), '截图');
  assert.equal(describeStep({ op: 'zoom', mode: 'in' }), '双指放大');
  assert.equal(describeStep({ op: 'zoom', mode: 'out' }), '双指缩小');
});

test('未知 op 回退为 op 本身，空 step 返回空串', () => {
  assert.equal(describeStep({ op: 'futureOp' }), 'futureOp');
  assert.equal(describeStep(null), '');
});
