'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createAutoPilot,
  normalizeScript,
  isNight,
  nextWakeTime,
  SUPPORTED_OPS
} = require('../electron/autopilot');

/** 造一个假 iosControl —— 全部方法都返回成功，便于观察调用链。 */
function fakeIosControl(overrides = {}) {
  const calls = [];
  const make = (name, value) => async (...args) => {
    calls.push({ method: name, args });
    return value;
  };
  const control = {
    calls,
    probe: make('probe', { reachable: true, ready: true }),
    startWda: make('startWda', { ok: true }),
    stopWda: make('stopWda', { ok: true }),
    dropSession: make('dropSession', { ok: true }),
    isConnected: make('isConnected', true),
    getScreenSize: make('getScreenSize', { width: 390, height: 844 }),
    tap: make('tap', { ok: true }),
    longPress: make('longPress', { ok: true }),
    swipe: make('swipe', { ok: true }),
    swipeDirection: make('swipeDirection', { ok: true }),
    typeText: make('typeText', { ok: true }),
    pressButton: make('pressButton', { ok: true }),
    pressHome: make('pressHome', { ok: true }),
    unlock: make('unlock', { ok: true }),
    launchApp: make('launchApp', { ok: true }),
    terminateApp: make('terminateApp', { ok: true }),
    activeApp: make('activeApp', { bundleId: 'com.example.app' }),
    zoom: make('zoom', { ok: true })
  };
  // override 也要进 calls，否则断言看不到调用链
  const wrapped = {};
  for (const [name, fn] of Object.entries(overrides)) {
    if (typeof fn !== 'function') continue;
    wrapped[name] = async (...args) => {
      calls.push({ method: name, args, override: true });
      return fn(...args);
    };
  }
  return { ...control, ...wrapped };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-'));
}

// ==================== SUPPORTED_OPS ====================

test('SUPPORTED_OPS 包含声明里所有 op', () => {
  for (const op of [
    'tap', 'longPress', 'swipe', 'swipeDirection',
    'type', 'pressButton', 'pressHome', 'unlock',
    'launchApp', 'terminateApp', 'activeApp',
    'assertActiveApp', 'assert',
    'wait', 'screenshot', 'zoom'
  ]) {
    assert.ok(SUPPORTED_OPS.has(op), `应支持 ${op}`);
  }
});

// ==================== normalizeScript ====================

test('normalizeScript 拒绝非对象', () => {
  assert.throws(() => normalizeScript(null), /脚本必须是对象/);
  assert.throws(() => normalizeScript('xxx'), /脚本必须是对象/);
});

test('normalizeScript 拒绝空 deviceId / 空 steps', () => {
  assert.throws(() => normalizeScript({ steps: [{ op: 'tap', x: 0, y: 0 }] }), /deviceId/);
  assert.throws(() => normalizeScript({ deviceId: '  ', steps: [{ op: 'tap', x: 0, y: 0 }] }), /deviceId/);
  assert.throws(() => normalizeScript({ deviceId: 'udid' }), /非空数组/);
  assert.throws(() => normalizeScript({ deviceId: 'udid', steps: [] }), /非空数组/);
});

test('normalizeScript 拒绝不支持的 op', () => {
  assert.throws(
    () => normalizeScript({ deviceId: 'udid', steps: [{ op: 'nuke', x: 1 }] }),
    /不支持/
  );
});

test('normalizeScript 丢弃白名单之外的字段（防注入）', () => {
  const normalized = normalizeScript({
    name: 'demo',
    deviceId: 'udid',
    steps: [
      { op: 'tap', x: 10, y: 20, __proto__: 'evil', fakeKey: 'x' }
    ]
  });
  assert.deepEqual(normalized.steps[0], { op: 'tap', x: 10, y: 20 });
  assert.equal(normalized.name, 'demo');
});

test('normalizeScript 等待 ms 必须是非负数', () => {
  assert.throws(
    () => normalizeScript({ deviceId: 'u', steps: [{ op: 'wait', ms: -5 }] }),
    /≥0/
  );
  assert.throws(
    () => normalizeScript({ deviceId: 'u', steps: [{ op: 'wait' }] }),
    /≥0/
  );
});

test('normalizeScript assert / assertActiveApp 必须带期望', () => {
  assert.throws(
    () => normalizeScript({ deviceId: 'u', steps: [{ op: 'assert' }] }),
    /需要 bundleId 或 expects/
  );
  assert.throws(
    () => normalizeScript({ deviceId: 'u', steps: [{ op: 'assertActiveApp' }] }),
    /需要 bundleId 或 expects/
  );
});

test('normalizeScript 默认名 = autopilot', () => {
  const n = normalizeScript({ deviceId: 'u', steps: [{ op: 'pressHome' }] });
  assert.equal(n.name, 'autopilot');
});

// ==================== isNight / nextWakeTime ====================

test('isNight 跨午夜窗口：22:00 是夜间，06:59 是夜间，07:00 是白班', () => {
  assert.equal(isNight(new Date(2026, 0, 1, 22, 0)), true);
  assert.equal(isNight(new Date(2026, 0, 1, 23, 59)), true);
  assert.equal(isNight(new Date(2026, 0, 1, 0, 0)), true);
  assert.equal(isNight(new Date(2026, 0, 1, 6, 59)), true);
  assert.equal(isNight(new Date(2026, 0, 1, 7, 0)), false);
  assert.equal(isNight(new Date(2026, 0, 1, 14, 30)), false);
});

test('isNight 同日窗口（start < end，如凌晨 02:00–05:00）也工作', () => {
  const w = { startMinute: 2 * 60, endMinute: 5 * 60 };
  assert.equal(isNight(new Date(2026, 0, 1, 1, 59), w), false, '01:59 在窗口前 = 白班');
  assert.equal(isNight(new Date(2026, 0, 1, 2, 0), w), true, '02:00 进入夜间窗口（含边界）');
  assert.equal(isNight(new Date(2026, 0, 1, 4, 59), w), true, '04:59 在夜间窗口内');
  assert.equal(isNight(new Date(2026, 0, 1, 5, 0), w), false, '05:00 离开夜间窗口（开区间）');
  assert.equal(isNight(new Date(2026, 0, 1, 12, 0), w), false, '12:00 白班');
});

test('isNight start === end 视为白班', () => {
  assert.equal(isNight(new Date(2026, 0, 1, 3, 0), { startMinute: 7 * 60, endMinute: 7 * 60 }), false);
});

test('nextWakeTime 22:00 唤醒时间是次日 07:00', () => {
  const t = nextWakeTime(new Date(2026, 0, 1, 22, 30));
  assert.equal(t.getHours(), 7);
  assert.equal(t.getMinutes(), 0);
  assert.equal(t.getDate(), 2);
});

test('nextWakeTime 06:00 唤醒时间是当天 07:00', () => {
  const t = nextWakeTime(new Date(2026, 0, 1, 6, 0));
  assert.equal(t.getHours(), 7);
  assert.equal(t.getDate(), 1);
});

// ==================== runOnce：基础流程 ====================

test('runOnce 顺序执行 steps 并归档 summary.json', async () => {
  const dir = tempDir();
  const control = fakeIosControl();
  const notify = [];
  const ap = createAutoPilot({
    iosControl: control,
    takeScreenshot: async () => null,
    notify: (msg) => notify.push(msg),
    archiveDir: dir
  });

  const summary = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [
      { op: 'tap', x: 10, y: 20 },
      { op: 'wait', ms: 50 },
      { op: 'pressHome' },
      { op: 'screenshot', label: 'after-home' }
    ]
  }));

  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 4);
  assert.equal(summary.failed, 0);

  const tap = control.calls.find((c) => c.method === 'tap');
  assert.ok(tap, '应调用 tap');
  assert.deepEqual(tap.args, [10, 20]);

  const home = control.calls.find((c) => c.method === 'pressHome');
  assert.ok(home, '应调用 pressHome');

  // summary.json 落盘
  const found = [];
  function walk(p) {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else found.push(full);
    }
  }
  walk(dir);
  const summaryFile = found.find((p) => p.endsWith('summary.json'));
  assert.ok(summaryFile, '应写出 summary.json');
  const saved = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  assert.equal(saved.ok, 4);
  assert.equal(saved.script, 'autopilot');

  assert.equal(notify.length, 0, '无失败不该告警');
  assert.equal(ap.stats.runs, 1);
});

test('runOnce 截图失败不该中断脚本', async () => {
  const dir = tempDir();
  const control = fakeIosControl();
  const ap = createAutoPilot({
    iosControl: control,
    takeScreenshot: async () => { throw new Error('截图器挂'); },
    archiveDir: dir
  });

  const summary = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [
      { op: 'screenshot', label: 'x' },
      { op: 'pressHome' }
    ]
  }));
  assert.equal(summary.ok, 2, '截图失败标记为 ok，但继续下一步');
  assert.ok(control.calls.find((c) => c.method === 'pressHome'), 'pressHome 仍应执行');
});

// ==================== runOnce：单步失败重试 ====================

test('单步第一次失败第二次成功 → 标记 retried 且 ok=1', async () => {
  const dir = tempDir();
  let count = 0;
  const control = fakeIosControl({
    tap: async () => {
      count += 1;
      if (count === 1) throw new Error('瞬时抖');
      return { ok: true };
    }
  });
  const ap = createAutoPilot({ iosControl: control, archiveDir: dir });
  const summary = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [{ op: 'tap', x: 1, y: 2 }]
  }));
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.steps[0].retried, true);
  assert.equal(count, 2, '应被调用两次');
});

test('单步两次都失败 → failed=1，连续失败累计', async () => {
  const dir = tempDir();
  const control = fakeIosControl({
    tap: async () => { throw new Error('tap boom'); }
  });
  const ap = createAutoPilot({
    iosControl: control,
    archiveDir: dir,
    consecutiveFailureAlert: 2,
    wdaRecoverAfterFailures: 100 // 不在这里触发自愈
  });
  const summary = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [{ op: 'tap', x: 1, y: 2 }]
  }));
  assert.equal(summary.failed, 1);
});

// ==================== runOnce：连续失败自愈 ====================

test('连续失败达到阈值 → dropSession/stopWda/probe/startWda 触发', async () => {
  const dir = tempDir();
  const control = fakeIosControl({
    tap: async () => { throw new Error('tap boom'); },
    // 让 probe 显示不可达 → 触发完整恢复路径
    probe: async () => ({ reachable: false, ready: false, message: 'no' })
  });
  const notify = [];
  const ap = createAutoPilot({
    iosControl: control,
    notify: (m) => notify.push(m),
    archiveDir: dir,
    consecutiveFailureAlert: 2,
    wdaRecoverAfterFailures: 2 // 第 2 次 tap 失败触发
  });
  const summary = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [
      { op: 'tap', x: 1, y: 1 },
      { op: 'tap', x: 2, y: 2 },
      { op: 'tap', x: 3, y: 3 }
    ]
  }));
  assert.equal(summary.abortedByRecovery, true, '本轮应作废');
  assert.equal(summary.failed, 2);

  assert.ok(control.calls.some((c) => c.method === 'dropSession'), '应 dropSession');
  assert.ok(control.calls.some((c) => c.method === 'stopWda'), '应 stopWda');
  assert.ok(control.calls.some((c) => c.method === 'probe'), '应 probe');
  assert.ok(control.calls.some((c) => c.method === 'startWda'), '应 startWda（probe 不可达）');

  assert.ok(notify.length >= 1, '应触发告警');
  assert.ok(notify[0].body.includes('wda-recovery'), '告警应包含 wda-recovery key');
});

// ==================== runOnce：整轮告警 ====================

test('整轮全失败连续 N 轮 → 触发 whole-run-failed 告警', async () => {
  const dir = tempDir();
  const control = fakeIosControl({
    tap: async () => { throw new Error('boom'); }
  });
  const notify = [];
  const ap = createAutoPilot({
    iosControl: control,
    notify: (m) => notify.push(m),
    archiveDir: dir,
    consecutiveFailureAlert: 100,
    wdaRecoverAfterFailures: 100,
    wholeRunFailureAlert: 2
  });
  const script = normalizeScript({ deviceId: 'udid', steps: [{ op: 'tap', x: 1, y: 1 }] });

  await ap._runOnce(script);
  await ap._runOnce(script);
  await ap._runOnce(script);

  const whole = notify.filter((n) => n.body.includes('whole-run-failed'));
  assert.ok(whole.length >= 1, '应触发整轮告警');
});

test('整轮全失败一次后下一轮成功 → 不再升级告警', async () => {
  const dir = tempDir();
  let n = 0;
  const control = fakeIosControl({
    tap: async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { ok: true };
    }
  });
  const notify = [];
  const ap = createAutoPilot({
    iosControl: control,
    notify: (m) => notify.push(m),
    archiveDir: dir,
    wholeRunFailureAlert: 2
  });
  const script = normalizeScript({ deviceId: 'udid', steps: [{ op: 'tap', x: 1, y: 1 }] });
  await ap._runOnce(script);
  await ap._runOnce(script);
  await ap._runOnce(script);

  const whole = notify.filter((notif) => notif.body.includes('whole-run-failed'));
  assert.equal(whole.length, 0, '第一轮失败后被清零');
});

// ==================== assert / assertActiveApp ====================

test('assertActiveApp 命中期望 → ok；不匹配 → 抛错', async () => {
  const dir = tempDir();
  const control = fakeIosControl({
    activeApp: async () => ({ bundleId: 'com.example.app' })
  });
  const ap = createAutoPilot({ iosControl: control, archiveDir: dir });

  const ok = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [{ op: 'assertActiveApp', bundleId: 'com.example.app', timeoutMs: 1000 }]
  }));
  assert.equal(ok.failed, 0);

  const fail = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [{ op: 'assertActiveApp', bundleId: 'com.other', timeoutMs: 500 }]
  }));
  assert.equal(fail.failed, 1);
});

test('assert 用 expects 字段比对 activeApp 多字段', async () => {
  const dir = tempDir();
  const control = fakeIosControl({
    activeApp: async () => ({ bundleId: 'com.x', pid: 42 })
  });
  const ap = createAutoPilot({ iosControl: control, archiveDir: dir });

  const ok = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [{ op: 'assert', expects: { bundleId: 'com.x', pid: 42 }, timeoutMs: 500 }]
  }));
  assert.equal(ok.failed, 0);

  const fail = await ap._runOnce(normalizeScript({
    deviceId: 'udid',
    steps: [{ op: 'assert', expects: { bundleId: 'com.y' }, timeoutMs: 500 }]
  }));
  assert.equal(fail.failed, 1);
});

// ==================== snapshot / start / stop ====================

test('snapshot 初始态字段齐全', () => {
  const ap = createAutoPilot({ iosControl: fakeIosControl() });
  const s = ap.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.scriptName, null);
  assert.equal(s.archiveDir != null, true);
  assert.equal(s.stats.runs, 0);
});

test('validate 不起跑，只校验', () => {
  const ap = createAutoPilot({ iosControl: fakeIosControl() });
  const v = ap.validate({ deviceId: 'udid', steps: [{ op: 'pressHome' }] });
  assert.equal(v.ok, true);
  assert.equal(ap.snapshot().running, false, '不该自动 start');
});

test('start 二次调用抛错', async () => {
  const dir = tempDir();
  const ap = createAutoPilot({
    iosControl: fakeIosControl(),
    archiveDir: dir,
    intervalMs: 5_000_000 // 不要在测试中真起循环
  });
  const ret = await ap.start({ deviceId: 'udid', steps: [{ op: 'pressHome' }] });
  assert.equal(ret.ok, true);
  await assert.rejects(() => ap.start({ deviceId: 'udid', steps: [{ op: 'pressHome' }] }), /已经在运行/);
  ap.stop();
  // 让 loop 退出
  await ap._waitForLoop().catch(() => {});
});

test('start 拒绝非法脚本（立刻抛）', async () => {
  const ap = createAutoPilot({ iosControl: fakeIosControl() });
  await assert.rejects(() => ap.start({ deviceId: 'udid' }), /非空/);
  await assert.rejects(() => ap.start({}), /deviceId/);
  assert.equal(ap.snapshot().running, false);
});