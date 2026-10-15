'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { createIosControl, describeForwardFailure, describeWdaStartFailure, normalizeBaseUrl } = require('../electron/ios-control');

/** 造一个假 transport：记录请求，按预设脚本返回。 */
function fakeTransport(script = {}) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, ...options });
    const key = `${options.method || 'GET'} ${url}`;
    const handler = script[key] ?? script[options.method || 'GET'] ?? script.default;
    if (typeof handler === 'function') return handler(url, options);
    if (handler) return handler;
    return { status: 200, text: JSON.stringify({ value: {} }) };
  };
  transport.calls = calls;
  return transport;
}

const ok = (value) => ({ status: 200, text: JSON.stringify({ value }) });

test('base url normalization avoids double slashes', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8100/'), 'http://127.0.0.1:8100');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8100'), 'http://127.0.0.1:8100');
  assert.equal(normalizeBaseUrl(''), 'http://127.0.0.1:8100', '空值应退回默认地址');
});

// ==================== 探测 ====================

test('probe reports reachable when WDA answers', async () => {
  const transport = fakeTransport({ 'GET http://127.0.0.1:8100/status': ok({ ready: true, message: 'ok' }) });
  const result = await createIosControl({ transport }).probe();
  assert.equal(result.reachable, true);
  assert.equal(result.ready, true);
});

test('probe reports unreachable with the reason instead of throwing', async () => {
  // 连不上是常态（用户没装 WDA），不能让界面崩，要给出原因
  const transport = async () => { throw new Error('connect ECONNREFUSED'); };
  const result = await createIosControl({ transport }).probe();
  assert.equal(result.reachable, false);
  assert.match(result.message, /ECONNREFUSED/);
});

test('probe surfaces a not-ready WDA', async () => {
  const transport = fakeTransport({ 'GET http://127.0.0.1:8100/status': ok({ ready: false, message: 'device locked' }) });
  const result = await createIosControl({ transport }).probe();
  assert.equal(result.reachable, true);
  assert.equal(result.ready, false);
  assert.match(result.message, /locked/);
});

// ==================== 会话 ====================

test('session is created once and reused', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 'abc' }),
    'POST http://127.0.0.1:8100/session/abc/wda/touch/perform': ok(null)
  });
  const control = createIosControl({ transport });

  await control.tap(10, 20);
  await control.tap(30, 40);

  const sessionCalls = transport.calls.filter((call) => call.url.endsWith('/session'));
  assert.equal(sessionCalls.length, 1, '两次点击只应创建一个会话');
  assert.equal(control.getSessionId(), 'abc');
});

test('a missing sessionId is reported clearly', async () => {
  const transport = fakeTransport({ 'POST http://127.0.0.1:8100/session': ok({}) });
  await assert.rejects(
    () => createIosControl({ transport }).ensureSession(),
    /未返回 sessionId/
  );
});

test('dropSession clears local state even when the delete call fails', async () => {
  // 设备拔掉后删会话会失败，本地状态必须清掉，否则会一直以为还连着
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 'abc' }),
    'DELETE http://127.0.0.1:8100/session/abc': { status: 500, text: 'boom' }
  });
  const control = createIosControl({ transport });
  await control.ensureSession();
  assert.equal(control.isConnected(), true);

  await assert.doesNotReject(() => control.dropSession());
  assert.equal(control.isConnected(), false);
  assert.equal(control.getSessionId(), null);
});

// ==================== 输入动作 ====================

test('tap posts bare coordinates to /wda/tap', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': ok(null)
  });
  await createIosControl({ transport }).tap(100.6, 200.4);

  const touch = transport.calls.find((call) => call.url.endsWith('/wda/tap'));
  assert.ok(touch, '应打到 /wda/tap');
  assert.deepEqual(touch.body, { x: 101, y: 200 });
});

test('swipe posts an actions drag sequence as the primary path', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/actions': ok(null)
  });
  await createIosControl({ transport }).swipe({ x: 100, y: 600 }, { x: 100, y: 200 });

  // W3C /actions 是首选路径 —— 起手停顿 + 多段轨迹更贴近真实手指，
  // iOS 16/17 识别率比 dragfromtoforduration 高
  const actions = transport.calls.find((call) => call.url.endsWith('/actions'));
  assert.ok(actions, '应优先打到 /session/:id/actions');
  const pointer = actions.body.actions[0];
  assert.equal(pointer.type, 'pointer');
  // 中间至少要 4 段移动，单点跃迁 iOS 容易忽略
  const moves = pointer.actions.slice(3, -2);
  assert.ok(moves.length >= 4);
  assert.equal(moves[moves.length - 1].y, 200, '最后一段落在终点');
});

test('swipe falls back to dragfromtoforduration when actions fails', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/actions': { status: 500, text: '{"value":{"message":"bad"}}' },
    'POST http://127.0.0.1:8100/session/s/wda/dragfromtoforduration': ok(null)
  });
  await createIosControl({ transport }).swipe({ x: 100, y: 600 }, { x: 100, y: 200 });

  const drag = transport.calls.find((call) => call.url.includes('dragfromtoforduration'));
  assert.ok(drag, 'actions 失败时应兜底到 dragfromtoforduration');
  assert.deepEqual(drag.body, { fromX: 100, fromY: 600, toX: 100, toY: 200, duration: 0.5 });
});

test('typing sends a character array (WDA rejects a plain string)', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/keys': ok(null)
  });
  await createIosControl({ transport }).typeText('你好a');

  const keys = transport.calls.find((call) => call.url.endsWith('/wda/keys'));
  assert.deepEqual(keys.body.value, ['你', '好', 'a']);
});

test('home goes to the homescreen endpoint', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/homescreen': ok(null)
  });
  await createIosControl({ transport }).pressHome();
  assert.ok(transport.calls.some((call) => call.url.endsWith('/wda/homescreen')));
});

// ==================== 屏幕尺寸 ====================

test('screen size comes from wda window rect and is cached', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'GET http://127.0.0.1:8100/session/s/window/rect': ok({ width: 390, height: 844 })
  });
  const control = createIosControl({ transport });

  assert.deepEqual(await control.getScreenSize(), { width: 390, height: 844 });
  await control.getScreenSize();

  const rectCalls = transport.calls.filter((call) => call.url.includes('window/rect'));
  assert.equal(rectCalls.length, 1, '第二次应走缓存');
});

test('a missing window rect is reported instead of returning NaN', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'GET http://127.0.0.1:8100/session/s/window/rect': ok({})
  });
  await assert.rejects(() => createIosControl({ transport }).getScreenSize(), /未返回屏幕尺寸/);
});

// ==================== 错误传播 ====================

test('http errors are surfaced with wda\'s own message', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': {
      status: 500,
      text: JSON.stringify({ value: { error: 'invalid element', message: '坐标超出屏幕' } })
    }
  });
  await assert.rejects(
    () => createIosControl({ transport }).tap(1, 1),
    /坐标超出屏幕/
  );
});

test('an error inside a 200 response is also treated as failure', async () => {
  // WDA 有时用 200 + value.error 表达失败，只看状态码会漏掉。
  // 但「会话失效」形态在这里被 withSession 自动救回，见下方恢复用例 ——
  // 这个用例换成普通错误，纯测「200 里的错误也当作失败抛出」
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': ok({ error: 'invalid element', message: '坐标超出屏幕' })
  });
  await assert.rejects(
    () => createIosControl({ transport }).tap(1, 1),
    /坐标超出屏幕/
  );
});

// ==================== 会话失效自动恢复 ====================
// WDA 中途重启（wdaproxy 掉线、被系统杀掉）后，旧 sessionId 全部 404。
// 修复前：404 直接抛错且不清缓存，用户每点一次失败一次，看起来像「点击坏了」。
// session 端点必须用队列（第一次返回旧会话、重建时返回新会话），静态映射测不出时序。

test('a 404 session-does-not-exist rebuilds the session and retries once', async () => {
  const dead = { status: 404, text: JSON.stringify({ value: { message: 'Session does not exist' } }) };
  const sessions = ['s', 's2'];
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': () => ok({ sessionId: sessions.shift() }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': dead,
    'POST http://127.0.0.1:8100/session/s2/wda/tap': ok(null)
  });
  const control = createIosControl({ transport });
  await control.ensureSession();
  assert.equal(control.getSessionId(), 's');

  // WDA 重启后：旧会话 404 → 自动重建 → 用新会话把同一个 tap 重发出去
  await control.tap(10, 20);

  assert.equal(control.getSessionId(), 's2', '应换上新会话');
  const taps = transport.calls.filter((call) => call.url.endsWith('/wda/tap'));
  assert.deepEqual(
    taps.map((call) => call.url),
    [
      'http://127.0.0.1:8100/session/s/wda/tap',
      'http://127.0.0.1:8100/session/s2/wda/tap'
    ],
    '重试必须用新会话拼新 URL'
  );
});

test('a 200 + session error also rebuilds the session and retries', async () => {
  // 部分 WDA 版本对失效会话返回 200 + value.error，两条形态都要能自愈
  const sessions = ['s', 's2'];
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': () => ok({ sessionId: sessions.shift() }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': ok({ error: 'invalid session id' })
  });
  const control = createIosControl({ transport });
  await control.ensureSession();

  await control.tap(10, 20);

  assert.equal(control.getSessionId(), 's2');
  assert.ok(transport.calls.some((call) => call.url.endsWith('/session/s2/wda/tap')));
});

test('session rebuild does not loop forever when WDA keeps dying', async () => {
  // 重建后的新会话也 404（WDA 真的没起来）→ 只重试一次就抛错
  const dead = () => ({ status: 404, text: JSON.stringify({ value: { message: 'Session does not exist' } }) });
  const sessions = ['s', 's2'];
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': () => ok({ sessionId: sessions.shift() }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': dead,
    'POST http://127.0.0.1:8100/session/s2/wda/tap': dead,
    default: dead
  });
  const control = createIosControl({ transport });
  await control.ensureSession();

  await assert.rejects(() => control.tap(10, 20), /Session does not exist/);

  const taps = transport.calls.filter((call) => call.url.endsWith('/wda/tap'));
  assert.equal(taps.length, 2, '一次动作最多两个 tap（原请求 + 重建后重试一次）');
});

test('a non-session 404 does not trigger a rebuild', async () => {
  // 端点不存在之类的普通 404 和会话失效无关，不应重建会话
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/tap': {
      status: 404,
      text: JSON.stringify({ value: { message: 'no such element' } })
    }
  });
  const control = createIosControl({ transport });
  await control.ensureSession();

  await assert.rejects(() => control.tap(1, 1), /no such element/);
  assert.equal(control.getSessionId(), 's', '普通 404 不应清会话');

  const sessionCalls = transport.calls.filter((call) => call.url.endsWith('/session'));
  assert.equal(sessionCalls.length, 1, '不应重新建会话');
});

test('swipe survives a session rebuild without hitting the dead-session fallback', async () => {
  // swipe 的 /actions 404 时不能拿死会话去打 dragfromtoforduration（注定再 404），
  // 而是抛回 withSession 重建后整体重跑
  const dead = { status: 404, text: JSON.stringify({ value: { message: 'Session does not exist' } }) };
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's2' }),
    'POST http://127.0.0.1:8100/session/s/actions': dead,
    'POST http://127.0.0.1:8100/session/s/wda/dragfromtoforduration': dead,
    'POST http://127.0.0.1:8100/session/s2/actions': ok(null)
  });
  const control = createIosControl({ transport });
  await control.ensureSession();

  await control.swipe({ x: 100, y: 600 }, { x: 100, y: 200 });

  assert.equal(control.getSessionId(), 's2');
  // 死会话的兜底端点根本不该被打到
  assert.ok(
    !transport.calls.some((call) => call.url.includes('/s/wda/dragfromtoforduration')),
    '会话已死时不应打 dragfromtoforduration 兜底'
  );
  assert.ok(transport.calls.some((call) => call.url.endsWith('/session/s2/actions')));
});

test('a non-json response does not crash the parser', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': { status: 200, text: '<html>not json</html>' }
  });
  // 解析不出来 → 拿不到 sessionId → 抛清晰错误而不是 JSON.parse 的异常
  await assert.rejects(() => createIosControl({ transport }).ensureSession(), /未返回 sessionId/);
});

// ==================== 拓展能力：按键 / 方向滑 / 应用管理 / 缩放 ====================

test('pressButton posts the button name and rejects an empty one', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/pressButton': ok(null)
  });
  const control = createIosControl({ transport });

  await control.pressButton('volumeUp');
  const buttonCall = transport.calls.find((call) => call.url.endsWith('/wda/pressButton'));
  assert.deepEqual(buttonCall.body, { name: 'volumeUp' });

  await assert.rejects(() => control.pressButton('  '), /按键名/);
  await assert.rejects(() => control.pressButton(null), /按键名/);
});

test('swipeDirection validates the direction before hitting WDA', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/swipe': ok(null)
  });
  const control = createIosControl({ transport });

  await control.swipeDirection('up');
  const swipeCall = transport.calls.find((call) => call.url.endsWith('/wda/swipe'));
  assert.deepEqual(swipeCall.body, { direction: 'up' });

  // 方向非法直接在客户端拒绝 —— 不让 WDA 收到 direction: "diagonal" 再报一个看不懂的错
  await assert.rejects(() => control.swipeDirection('diagonal'), /up\/down\/left\/right/);
  await assert.rejects(() => control.swipeDirection(''), /up\/down\/left\/right/);
});

test('launchApp and terminateApp send the bundleId as given', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'POST http://127.0.0.1:8100/session/s/wda/apps/launch': ok(null),
    'POST http://127.0.0.1:8100/session/s/wda/apps/terminate': ok(null)
  });
  const control = createIosControl({ transport });

  await control.launchApp('com.apple.mobilesafari');
  await control.terminateApp('com.apple.mobilesafari');

  assert.deepEqual(
    transport.calls.find((call) => call.url.endsWith('/apps/launch')).body,
    { bundleId: 'com.apple.mobilesafari' }
  );
  assert.deepEqual(
    transport.calls.find((call) => call.url.endsWith('/apps/terminate')).body,
    { bundleId: 'com.apple.mobilesafari' }
  );

  await assert.rejects(() => control.launchApp('  '), /bundleId/);
  await assert.rejects(() => control.terminateApp(null), /bundleId/);
});

test('activeApp returns only the fields the renderer needs', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'GET http://127.0.0.1:8100/session/s/wda/apps/active': ok({
      bundleId: 'com.apple.springboard',
      name: 'SpringBoard',
      pid: 123,
      state: 'running',
      extraJunk: 'should-not-leak'
    })
  });
  const control = createIosControl({ transport });

  assert.deepEqual(await control.activeApp(), {
    bundleId: 'com.apple.springboard',
    name: 'SpringBoard',
    pid: 123
  });
});

test('zoom derives center and gaps from the real screen size', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' }),
    'GET http://127.0.0.1:8100/session/s/window/rect': ok({ width: 390, height: 844 }),
    'POST http://127.0.0.1:8100/session/s/actions': ok(null)
  });
  const control = createIosControl({ transport });

  await control.zoom('in');

  const actionsCall = transport.calls.find((call) => call.url.endsWith('/session/s/actions'));
  assert.ok(actionsCall, 'zoom 走 /actions 双指针序列');
  const pointers = actionsCall.body.actions;
  assert.equal(pointers.length, 2, '必须是双指');

  // 默认中心 = 屏幕中点(195, 422)，默认起始间距 = 短边 390 × 20% = 78（半间距 39）
  const [f1, f2] = pointers.map((p) => p.actions);
  assert.equal(f1[0].x, 195 + 39);
  assert.equal(f2[0].x, 195 - 39);
  assert.equal(f1[0].y, 422);

  // zoom-in 结束间距 = 短边 × 70% = 273（半间距 ~137）
  const lastMove = f1.slice(3, -2).at(-1);
  assert.ok(Math.abs(lastMove.x - (195 + 136)) <= 1, `终点应在 endGap/2 处，实际 ${lastMove.x}`);
});

test('zoom rejects an unknown mode before any request goes out', async () => {
  const transport = fakeTransport({
    'POST http://127.0.0.1:8100/session': ok({ sessionId: 's' })
  });
  await assert.rejects(() => createIosControl({ transport }).zoom('sideways'), /'in' 或 'out'/);
  assert.equal(transport.calls.length, 0, '校验失败时连会话都不该建');
});

// ==================== USB 端口转发 ====================
// WDA 监听在**设备的** localhost:8100，Mac 直连不到，必须 iproxy 转发。
// 少了这一步，用户即使把 WDA 跑起来也只会看到「未运行」。

/**
 * 假 spawn。
 *
 * 可模拟三种真实失败形态 —— 它们的报错文案完全不同，必须分别覆盖：
 * - `spawnError`：iproxy 没装（Node 对 ENOENT 是发 'error' 事件，不是抛）
 * - `exitCode` + `stderr`：参数不对，进程起来又**立刻退出**（本次修掉的真实 bug）
 * - spawn 直接抛：参数类型非法
 */
function fakeSpawn(options = {}) {
  const spawned = [];
  const fn = (command, args) => {
    if (options.throwError) throw options.throwError;

    const listeners = {};
    const stderr = {
      setEncoding() {},
      on(event, handler) { listeners[event] = handler; return this; }
    };
    const child = {
      command,
      args,
      stderr,
      exitCode: typeof options.exitCode === 'number' ? options.exitCode : null,
      killed: false,
      kill() { this.killed = true; this.exitCode = 0; },
      once(event, handler) {
        if (event === 'error' && options.spawnError) handler(options.spawnError);
      }
    };
    // stderr 在真实进程里是异步来的 —— 这里也推迟一个微任务再回放，
    // 否则会在实现注册 'data' 监听之前就发出去，测试就测不到捕获逻辑了
    if (options.stderr) queueMicrotask(() => listeners.data?.(options.stderr));
    spawned.push(child);
    return child;
  };
  fn.spawned = spawned;
  return fn;
}

test('probe without a device id never tries to forward', async () => {
  const spawnFn = fakeSpawn();
  const transport = async () => { throw new Error('ECONNREFUSED'); };
  const result = await createIosControl({ transport, spawn: spawnFn }).probe();

  assert.equal(result.reachable, false);
  assert.equal(spawnFn.spawned.length, 0, '没给 deviceId 就不该起 iproxy');
});

test('an unreachable wda triggers iproxy and retries', async () => {
  const spawnFn = fakeSpawn();
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    // 第一次失败，转发建立后成功
    if (attempt === 1) throw new Error('ECONNREFUSED');
    return { status: 200, text: JSON.stringify({ value: { ready: true } }) };
  };

  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });
  const result = await control.probe('udid-1');

  assert.equal(result.reachable, true);
  assert.equal(result.forwarded, true, '应标注这次是靠转发连上的');
  // 第一条是 8100 控制转发，第二条是顺手起的 9100 MJPEG 转发
  assert.equal(spawnFn.spawned.length, 2);
  assert.deepEqual(
    spawnFn.spawned[0].args,
    ['-u', 'udid-1', '8100:8100'],
    'iproxy 用法是 `iproxy -u <udid> LOCAL:DEVICE`；写成 `iproxy 8100 8100 <udid>` 会立刻报错退出'
  );
  assert.equal(control.isForwarding(), true);
});

test('when forwarding succeeds but wda is still down, the message says what to check', async () => {
  const spawnFn = fakeSpawn();
  const transport = async () => { throw new Error('ECONNREFUSED'); };

  const result = await createIosControl({ transport, spawn: spawnFn, delay: async () => {} }).probe('udid-1');

  assert.equal(result.reachable, false);
  assert.match(result.message, /端口转发/, '要说明转发已建立');
  assert.match(result.message, /WebDriverAgent 已启动/, '要给出下一步');
});

// —— 以下是「转发没起来」的三种形态。它们曾经被同一条文案糊在一起，
// 用户看不出到底该装工具、该插线、还是该检查参数。——

test('iproxy exiting right away is reported as a failure, not a success', async () => {
  // 真实复现：`iproxy 8100 8100 <udid>` 会打印下面这句并**立刻退出**。
  // 旧实现只看「有没有 spawn 成功」，于是把它当成转发已建立，
  // 用户看到的是「WDA 未运行」—— 方向完全指错。
  const spawnFn = fakeSpawn({
    exitCode: 1,
    stderr: "Invalid listen port specified in argument '8100'!\n"
  });
  const transport = async () => { throw new Error('ECONNREFUSED'); };

  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });
  const result = await control.probe('udid-1');

  assert.equal(result.reachable, false);
  assert.equal(control.isForwarding(), false, 'iproxy 已退出，就不该认为还在转发');
  assert.match(result.message, /iproxy 启动后立即退出/, '要明说 iproxy 自己退出了');
  assert.match(result.message, /Invalid listen port/, '要把 iproxy 的原话带给用户');
  assert.doesNotMatch(result.message, /WebDriverAgent 已启动/, '不是 WDA 的问题就别往那边引');
});

test('a missing iproxy is reported as a spawn failure with an install hint', async () => {
  const notFound = new Error('spawn iproxy ENOENT');
  const spawnFn = fakeSpawn({ spawnError: notFound });
  const transport = async () => { throw new Error('ECONNREFUSED'); };

  const result = await createIosControl({ transport, spawn: spawnFn, delay: async () => {} }).probe('udid-1');

  assert.equal(result.reachable, false);
  assert.match(result.message, /未能启动 iproxy/);
  assert.match(result.message, /ENOENT/, '要带上系统给的原因');
  assert.match(result.message, /libimobiledevice/, '要给出安装提示');
});

test('a spawn that throws synchronously is caught, not propagated', async () => {
  const spawnFn = fakeSpawn({ throwError: new Error('invalid args') });
  const transport = async () => { throw new Error('ECONNREFUSED'); };

  const result = await createIosControl({ transport, spawn: spawnFn, delay: async () => {} }).probe('udid-1');

  assert.equal(result.reachable, false);
  assert.match(result.message, /invalid args/);
});

test('describeForwardFailure never returns an empty or vague line', () => {
  const cases = [
    [{ reason: 'no-device' }, /未指定设备/],
    [{ reason: 'spawn-failed', detail: 'ENOENT' }, /brew install libimobiledevice/],
    [{ reason: 'iproxy-failed', detail: '设备未找到' }, /信任/],
    [{ reason: 'something-new' }, /原因未知/]
  ];
  for (const [input, expected] of cases) {
    assert.match(describeForwardFailure(input), expected);
  }
});

// ==================== 退出时的同步清理 ====================
// iproxy 是真实子进程。应用退出时如果没收掉它，它会残留并占住 8100，
// 下次启动转发起不来 —— 而报错只会说「WebDriverAgent 未运行」，方向完全指错。
// `will-quit` 里不能 await，所以必须有这条同步路径。

test('forceKillForward kills the iproxy process synchronously', async () => {
  const spawnFn = fakeSpawn();
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('ECONNREFUSED');
    return { status: 200, text: JSON.stringify({ value: {} }) };
  };
  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });

  await control.probe('udid-1');
  assert.equal(control.isForwarding(), true);

  // 关键：**不 await** —— 模拟 will-quit 的调用方式
  control.forceKillForward();

  assert.equal(spawnFn.spawned[0].killed, true, '同步调用也必须真的 kill 掉');
  assert.equal(control.isForwarding(), false, '本地状态要一起清掉');
});

test('forceKillForward is a no-op when nothing is forwarding', () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({ transport: async () => ({ status: 200, text: '{}' }), spawn: spawnFn });

  // 没转发过就调用，不应抛（退出钩子里抛错会变成未捕获异常）
  assert.doesNotThrow(() => control.forceKillForward());
  assert.doesNotThrow(() => control.forceKillForward());
  assert.equal(spawnFn.spawned.length, 0);
  assert.equal(control.isForwarding(), false);
});

test('forceKillForward tolerates a kill that throws', async () => {
  const spawnFn = fakeSpawn();
  // 第一次探测必须失败，否则根本不会起转发，也就没有进程可 kill
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('ECONNREFUSED');
    return { status: 200, text: JSON.stringify({ value: {} }) };
  };
  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });
  await control.probe('udid-1');
  // MJPEG 实时流（9100）独立起第二条 —— 不然画面走截图轮询；
  // 这条独立 iproxy 是「顺手起」的优化（见 ios-control 的注释），不影响主转发断言
  assert.equal(spawnFn.spawned.length, 2, 'iproxy + MJPEG 应各自一条');

  // 进程可能已经自己退出了，这时 kill 会抛 —— 退出钩子里绝不能因此崩掉
  spawnFn.spawned[0].kill = () => { throw new Error('ESRCH'); };
  assert.doesNotThrow(() => control.forceKillForward());
  assert.equal(control.isForwarding(), false);
});

// ==================== 启动 WebDriverAgent 本体 ====================
// WDA 必须**在设备上跑着**才有得点。之前应用只会让用户自己去装 Xcode，
// 现在用 tidevice 免 Xcode 拉起设备上已安装的 WDA（`tidevice wdaproxy`）。

/** 造一个「前 n 次探测不通、之后通」的 transport。 */
function flakyTransport(failTimes) {
  let attempt = 0;
  return async () => {
    attempt += 1;
    if (attempt <= failTimes) throw new Error('ECONNREFUSED');
    return { status: 200, text: JSON.stringify({ value: { ready: true } }) };
  };
}

test('startWda launches tidevice wdaproxy and waits until it serves', async () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: flakyTransport(2), spawn: spawnFn, delay: async () => {}
  });

  const result = await control.startWda('udid-1');

  assert.equal(result.ok, true, `启动应成功，实际：${JSON.stringify(result)}`);
  assert.deepEqual(spawnFn.spawned[0].args, ['wdaproxy', '--port', '8100']);
  assert.equal(control.isWdaRunning(), true);
  assert.equal(control.isForwarding(), true, 'wdaproxy 自己就做端口转发');
});

test('startWda reports "not installed" separately from other failures', async () => {
  // tidevice 只启动、不安装。没装过 WDA 时它报 No app matches ——
  // 这条必须单独识别：用户要做的事（先用 Xcode 装一次）和其他失败完全不同。
  const spawnFn = fakeSpawn({
    exitCode: 1,
    stderr: 'MuxError: [Errno No app matches] com.*.xctrunner\n'
  });
  const control = createIosControl({
    transport: async () => { throw new Error('ECONNREFUSED'); },
    spawn: spawnFn, delay: async () => {}
  });

  const result = await control.startWda('udid-1');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wda-not-installed');
  assert.equal(control.isWdaRunning(), false, '失败后不该留下「在运行」的状态');
});

test('startWda does not spawn when wda is already reachable', async () => {
  const spawnFn = fakeSpawn();
  const transport = fakeTransport({ 'GET http://127.0.0.1:8100/status': ok({ ready: true }) });

  const result = await createIosControl({ transport, spawn: spawnFn }).startWda('udid-1');

  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(spawnFn.spawned.length, 0, '已经在跑就不该再起一个');
});

test('startWda stops iproxy first because both want port 8100', async () => {
  const spawnFn = fakeSpawn();
  // 前 3 次失败：probe 两次（起 iproxy）、startWda 的第一次探测；第 4 次成功
  const control = createIosControl({
    transport: flakyTransport(3), spawn: spawnFn, delay: async () => {}
  });

  await control.probe('udid-1');
  // MJPEG 实时流（9100）独立起第二条 —— 不然画面走截图轮询
  assert.equal(spawnFn.spawned.length, 2);
  const iproxy = spawnFn.spawned[0];
  assert.equal(iproxy.args[0], '-u', '第一个进程应是 iproxy');

  await control.startWda('udid-1');

  assert.equal(iproxy.killed, true, '起 wdaproxy 前必须把 iproxy 收掉，否则两个进程抢 8100');
});

test('startWda gives up instead of hanging forever', async () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: async () => { throw new Error('ECONNREFUSED') },
    spawn: spawnFn,
    delay: async () => {},
    wdaStartTimeoutMs: 0    // 注入 0 超时，否则这条用例要真等 30 秒
  });

  const result = await control.startWda('udid-1');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(control.isWdaRunning(), false, '超时后要把进程收掉，不能留着占端口');
});

test('forceKillWda kills wdaproxy synchronously', async () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: flakyTransport(1), spawn: spawnFn, delay: async () => {}
  });
  await control.startWda('udid-1');
  const wda = spawnFn.spawned[0];

  // 关键：**不 await** —— 模拟 will-quit 的调用方式
  control.forceKillWda();

  assert.equal(wda.killed, true);
  assert.equal(control.isWdaRunning(), false);
  assert.equal(control.isForwarding(), false, 'wdaproxy 没了就不该还认为在转发');
});

test('startWda without a device id fails fast', async () => {
  const spawnFn = fakeSpawn();
  const result = await createIosControl({
    transport: async () => { throw new Error('ECONNREFUSED') },
    spawn: spawnFn, delay: async () => {}
  }).startWda('');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-device');
  assert.equal(spawnFn.spawned.length, 0);
});

test('wdaproxy is killed as a process group, not just the direct child', async () => {
  // tidevice wdaproxy 会再派生一个子进程（真正监听 8100 的那个）。
  // 只 kill 直接子进程会留下它继续占着端口 —— 实测确认过这个泄漏。
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: flakyTransport(1), spawn: spawnFn, delay: async () => {}
  });
  await control.startWda('udid-1');

  const wda = spawnFn.spawned[0];
  wda.pid = 4242;

  const killed = [];
  const original = process.kill;
  process.kill = (pid, signal) => { killed.push({ pid, signal }); };
  try {
    control.forceKillWda();
  } finally {
    process.kill = original;
  }

  assert.deepEqual(killed, [{ pid: -4242, signal: 'SIGTERM' }],
    '应按负 pid 杀整个进程组（-pid 才是进程组）');
  assert.equal(control.isWdaRunning(), false);
});

test('a process group that is already gone falls back to a plain kill', async () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: flakyTransport(1), spawn: spawnFn, delay: async () => {}
  });
  await control.startWda('udid-1');
  const wda = spawnFn.spawned[0];
  wda.pid = 4242;

  // 进程组不存在时 process.kill(-pid) 会抛 —— 这时要退回单进程 kill，不能崩
  const original = process.kill;
  process.kill = () => { throw new Error('ESRCH'); };
  try {
    assert.doesNotThrow(() => control.forceKillWda());
  } finally {
    process.kill = original;
  }
  assert.equal(wda.killed, true, '退回路径也要真的 kill 掉');
  assert.equal(control.isWdaRunning(), false);
});

test('describeWdaStartFailure tells apart "install it" from "it did not start"', () => {
  // 这两种情况的下一步完全不同，文案混在一起用户只能瞎试
  assert.match(describeWdaStartFailure({ reason: 'wda-not-installed' }), /Xcode.*装一次/);
  assert.match(describeWdaStartFailure({ reason: 'spawn-failed', detail: 'ENOENT' }), /tidevice/);
  assert.match(describeWdaStartFailure({ reason: 'timeout' }), /超时/);
  assert.doesNotMatch(
    describeWdaStartFailure({ reason: 'timeout' }),
    /装一次/,
    '超时不是「没装」，别把用户引去重装'
  );
});

test('a reachable wda is used as-is, without starting iproxy', async () => {
  const spawnFn = fakeSpawn();
  const transport = fakeTransport({ 'GET http://127.0.0.1:8100/status': ok({ ready: true }) });

  const result = await createIosControl({ transport, spawn: spawnFn }).probe('udid-1');
  assert.equal(result.reachable, true);
  assert.equal(spawnFn.spawned.length, 0, '已经通了就不该多起一个进程');
});

test('iproxy is not restarted for the same device', async () => {
  const spawnFn = fakeSpawn();
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('ECONNREFUSED');
    return { status: 200, text: JSON.stringify({ value: {} }) };
  };
  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });

  await control.probe('udid-1');
  await control.probe('udid-1');
  // MJPEG 9100 那条独立起一次后复用，不会反复拉 —— 第二条 iproxy 也是创建一次
  assert.equal(spawnFn.spawned.length, 2, '同一台设备不该反复起 iproxy（含 MJPEG 那条）');
});

test('dropping the session also stops the port forward', async () => {
  const spawnFn = fakeSpawn();
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('ECONNREFUSED');
    if (attempt === 2) return { status: 200, text: JSON.stringify({ value: {} }) };
    return { status: 200, text: JSON.stringify({ value: { sessionId: 's' } }) };
  };
  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });

  await control.probe('udid-1');
  await control.ensureSession();
  assert.equal(control.isForwarding(), true);

  await control.dropSession();
  assert.equal(control.isForwarding(), false, '断开后必须把 iproxy 收掉，否则进程会残留');
  assert.equal(spawnFn.spawned[0].killed, true);
});

test('dropping a session with no session also cleans up the forward', async () => {
  const spawnFn = fakeSpawn();
  let attempt = 0;
  const transport = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('ECONNREFUSED');
    return { status: 200, text: JSON.stringify({ value: {} }) };
  };
  const control = createIosControl({ transport, spawn: spawnFn, delay: async () => {} });

  await control.probe('udid-1');
  assert.equal(control.isForwarding(), true);
  await control.dropSession();
  assert.equal(control.isForwarding(), false);
});

// ==================== MJPEG 实时流 ====================
// 画面延迟从「截图轮询 ~1 帧/秒」降到「设备端直出 ~30fps」的关键通道。
// 它比控制转发更容易失败（WDA 可能没开 MJPEG、9100 可能被占），
// 所以**失败必须能被单独观测到，且不能影响 8100 控制**。

test('mjpeg forward is a separate iproxy on port 9100', async () => {
  const spawnFn = fakeSpawn();
  const transport = async () => { throw new Error('ECONNREFUSED'); };
  await createIosControl({ transport, spawn: spawnFn, delay: async () => {} }).probe('udid-1');

  const mjpeg = spawnFn.spawned.find((child) => child.args?.[2] === '9100:9100');
  assert.ok(mjpeg, '应有一条独立的 9100 转发（与 8100 分开，否则 wdaproxy 会把它一起收掉）');
  assert.deepEqual(mjpeg.args, ['-u', 'udid-1', '9100:9100']);
});

test('a failing mjpeg forward does not break the control channel', async () => {
  // 9100 起不来（旧版 WDA 没有 MJPEG 端点 / 端口被占）时，
  // 控制链路必须照常可用 —— 否则用户连点击都没了，比画面慢严重得多。
  // 只让 9100 那条失败，8100 那条正常。
  const base = fakeSpawn();
  const spawned = [];
  const spawnFn = (command, args) => {
    const child = base(command, args);
    // 8100 与 9100 传不同的参数；这里只让 9100 那条进程立刻退出
    if (args?.[2] === '9100:9100') child.exitCode = 1;
    spawned.push(child);
    return child;
  };

  const control = createIosControl({
    transport: async () => ({ status: 200, text: JSON.stringify({ value: {} }) }),
    spawn: spawnFn,
    delay: async () => {}
  });

  const forward = await control.ensurePortForward('udid-1');
  assert.equal(forward.ok, true, '9100 失败不能连累 8100 控制转发');
  assert.equal(control.isForwarding(), true);
  assert.equal(control.isMjpegRunning(), false, '9100 没了就不该报告 MJPEG 可用');
});

test('startMjpegProxy reuses the running server instead of stacking listeners', async () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: async () => ({ status: 200, text: JSON.stringify({ value: {} }) }),
    spawn: spawnFn,
    delay: async () => {}
  });

  const first = await control.startMjpegProxy('udid-1');
  assert.equal(first.ok, true);
  assert.ok(first.port > 0, '应返回本地代理端口供渲染层拼 URL');

  const second = await control.startMjpegProxy('udid-1');
  assert.equal(second.reused, true, '已在跑就复用，不要叠第二个 server');
  assert.equal(second.port, first.port);

  control.forceKillMjpeg();
});

test('startMjpegProxy without a device id fails loudly', async () => {
  const control = createIosControl({ transport: async () => ({ status: 200, text: '{}' }) });
  await assert.rejects(() => control.startMjpegProxy(''), /deviceId/);
});

test('forceKillMjpeg tears down the proxy synchronously', async () => {
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: async () => ({ status: 200, text: JSON.stringify({ value: {} }) }),
    spawn: spawnFn,
    delay: async () => {}
  });
  await control.startMjpegProxy('udid-1');
  assert.equal(control.isMjpegRunning(), true);

  // 关键：**不 await** —— 模拟 will-quit 的同步调用方式
  control.forceKillMjpeg();

  assert.equal(control.isMjpegRunning(), false, '本地状态要一起清掉');
  const mjpeg = spawnFn.spawned.find((child) => child.args?.[2] === '9100:9100');
  assert.equal(mjpeg?.killed, true, '9100 那条 iproxy 也要收掉');
});

test('forceKillMjpeg is a no-op when nothing is running', () => {
  const control = createIosControl({ transport: async () => ({ status: 200, text: '{}' }) });
  assert.doesNotThrow(() => control.forceKillMjpeg());
  assert.equal(control.isMjpegRunning(), false);
});

test('startMjpegProxy rebuilds everything when the device changes', async () => {
  // 设备切换竞态：只看「进程活着」不看「属于谁」的话，旧设备的 9100
  // 转发会被直接复用 —— 用户看到的是**另一台手机**的画面，还不报错。
  const spawnFn = fakeSpawn();
  const control = createIosControl({
    transport: async () => ({ status: 200, text: JSON.stringify({ value: {} }) }),
    spawn: spawnFn,
    delay: async () => {}
  });

  try {
    const first = await control.startMjpegProxy('udid-1');
    assert.equal(first.ok, true);
    assert.equal(first.deviceId, 'udid-1');

    // 切到第二台设备：旧 server / 旧 iproxy 都不能复用
    const second = await control.startMjpegProxy('udid-2');
    assert.equal(second.ok, true);
    assert.ok(!second.reused, '换了设备就该重建代理，不能复用旧 server');
    assert.notEqual(second.port, first.port, '旧 server 关停后新 server 拿到新端口');
    assert.equal(second.deviceId, 'udid-2');

    const mjpegChildren = spawnFn.spawned.filter((child) => child.args?.[2] === '9100:9100');
    assert.equal(mjpegChildren.length, 2, '每台设备各起一条 9100 转发');
    assert.deepEqual(mjpegChildren[0].args, ['-u', 'udid-1', '9100:9100']);
    assert.deepEqual(mjpegChildren[1].args, ['-u', 'udid-2', '9100:9100']);
    assert.equal(mjpegChildren[0].killed, true, '旧设备的 9100 转发必须收掉');
    assert.equal(control.isMjpegRunning(), true);
  } finally {
    control.forceKillMjpeg();
  }
});

test('mjpeg proxy responses carry CORS headers for canvas export', async () => {
  // saveFrame 会把 <img> 画到 canvas 再 toDataURL —— 跨源资源没有
  // Access-Control-Allow-Origin 头时 canvas 被污染，toDataURL 必抛
  // SecurityError。代理必须补上这个头（配合 img crossOrigin="anonymous"）。
  // 验证方式：起一个真实的 9100 假上游，走代理的**成功转发路径**断言响应头
  // —— 502 失败分支不走这套头（失败流前端 onError 回退，不涉及导出）。
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
    res.write('--frame\r\n');
  });
  const upstreamPort = await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(9100, '127.0.0.1', () => resolve(upstream.address().port));
  }).catch(() => null);

  if (!upstreamPort) {
    // 9100 被占（比如真在跑 WDA 转发的机器上跑测试）：这个用例没意义，跳过
    console.log('  [skip] 9100 端口被占，跳过 CORS 响应头用例');
    return;
  }

  const control = createIosControl({
    transport: async () => ({ status: 200, text: JSON.stringify({ value: {} }) }),
    spawn: fakeSpawn(),
    delay: async () => {}
  });
  const { port } = await control.startMjpegProxy('udid-1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200, '假上游应答 200，走成功转发分支');
    assert.equal(
      res.headers.get('access-control-allow-origin'), '*',
      '转发路径必须带 ACAO 头，否则 canvas 导出抛 SecurityError'
    );
    await res.body?.cancel?.().catch(() => {});
  } finally {
    control.forceKillMjpeg();
    upstream.close();
    upstream.closeAllConnections?.();
  }
});
