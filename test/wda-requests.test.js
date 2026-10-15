'use strict';

/**
 * WDA 请求构造的测试。
 *
 * **这些断言里的端点形状不是推导出来的，是对着真机上跑起来的 WDA v16.12.9
 * 逐个请求验证过的**（返回 200 才算通过）。见 `electron/wda-requests.js` 顶部的对照表。
 *
 * 为什么这点要写清楚：这份测试的前身断言的是 `/wda/touch/perform` 和带 session 的
 * `/wda/homescreen`，两个端点在新版 WDA 上都是 404 —— 而测试是绿的，
 * 因为它测的是一个**主进程根本没用的平行实现**。
 * 所以这里除了断言 URL，还要断言「主进程确实用的是这个模块」。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeWdaBaseUrl,
  buildWdaSessionRequest,
  buildWdaDeleteSessionRequest,
  buildWdaTapRequest,
  buildWdaLongPressRequest,
  buildWdaDragRequest,
  buildWdaActionsDragRequest,
  buildWdaUnlockRequest,
  buildWdaTypeRequest,
  buildWdaHomeRequest,
  buildWdaWindowRectRequest,
  buildWdaPressButtonRequest,
  buildWdaDirectionalSwipeRequest,
  buildWdaAppLaunchRequest,
  buildWdaAppTerminateRequest,
  buildWdaActiveAppRequest,
  buildWdaZoomRequest,
  buildWdaStatusRequest
} = require('../electron/wda-requests');

const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:8100';

test('base url normalization avoids double slashes', () => {
  assert.equal(normalizeWdaBaseUrl(`${BASE}/`), BASE);
  assert.equal(normalizeWdaBaseUrl(BASE), BASE);
  assert.equal(normalizeWdaBaseUrl(''), '');
});

test('tap posts bare x/y to /wda/tap', () => {
  const request = buildWdaTapRequest(`${BASE}/`, 'sess-1', { x: 100.4, y: 200.6 });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${BASE}/session/sess-1/wda/tap`);
  // 坐标直接放在请求体里（不是旧 JSONWP 的 actions[].options）
  assert.deepEqual(request.body, { x: 100, y: 201 });
});

test('long press and drag use their own endpoints, not a shared one', () => {
  const hold = buildWdaLongPressRequest(BASE, 's', { x: 10, y: 20 }, 1.5);
  assert.equal(hold.url, `${BASE}/session/s/wda/touchAndHold`);
  assert.deepEqual(hold.body, { x: 10, y: 20, duration: 1.5 });

  const drag = buildWdaDragRequest(BASE, 's', { x: 100, y: 600 }, { x: 100, y: 200 }, 0.8);
  assert.equal(drag.url, `${BASE}/session/s/wda/dragfromtoforduration`);
  assert.deepEqual(drag.body, { fromX: 100, fromY: 600, toX: 100, toY: 200, duration: 0.8 });
});

test('durations fall back instead of sending zero', () => {
  // duration=0 会让拖拽变成瞬间完成，看起来像「没反应」
  assert.equal(buildWdaDragRequest(BASE, 's', { x: 1, y: 1 }, { x: 2, y: 2 }).body.duration, 0.5);
  assert.equal(buildWdaDragRequest(BASE, 's', { x: 1, y: 1 }, { x: 2, y: 2 }, 0).body.duration, 0.5);
  assert.equal(buildWdaLongPressRequest(BASE, 's', { x: 1, y: 1 }, 0).body.duration, 1);
});

test('actions drag posts a W3C pointer sequence as the swipe fallback', () => {
  const request = buildWdaActionsDragRequest(BASE, 's', { x: 100, y: 600 }, { x: 100, y: 200 }, 0.8);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${BASE}/session/s/actions`);

  const pointer = request.body.actions[0];
  assert.equal(pointer.type, 'pointer');
  assert.equal(pointer.id, 'finger1');
  assert.deepEqual(pointer.parameters, { pointerType: 'touch' });

  // 序列必须是「起点 → 按下 → 起手停顿 ≥ 200ms → 多段轨迹 → 停顿 → 抬起」，
  // 缺起手停顿或单点跃迁都会被 iOS 当成 tap。多段之间间距≈12 设备像素
  const actions = pointer.actions;
  assert.deepEqual(actions[0], { type: 'pointerMove', duration: 0, x: 100, y: 600 });
  assert.deepEqual(actions[1], { type: 'pointerDown', button: 0 });
  assert.ok(actions[2].type === 'pause' && actions[2].duration >= 200, '起手停顿要 ≥200ms 避免 iOS 误判 tap');
  const moves = actions.slice(3, -2);
  assert.ok(moves.length >= 4, '轨迹必须拆成多段，单点跃迁 iOS 容易忽略');
  assert.ok(moves.every((item) => item.type === 'pointerMove'), '中间段全是 pointerMove');
  assert.equal(moves[moves.length - 1].x, 100);
  assert.equal(moves[moves.length - 1].y, 200, '最后一段必须落在终点');
  assert.equal(actions.at(-2).type, 'pause', '抬手前再停顿一次');
  assert.equal(actions.at(-1).type, 'pointerUp');

  // duration=0 同样要兜住，避免瞬间完成
  const zero = buildWdaActionsDragRequest(BASE, 's', { x: 0, y: 0 }, { x: 0, y: 1 }, 0);
  // 距离很短时取最小段数 4
  const zeroMoves = zero.body.actions[0].actions.slice(3, -2);
  assert.equal(zeroMoves.length, 4);
});

test('unlock posts to the session-scoped /wda/unlock endpoint', () => {
  const request = buildWdaUnlockRequest(BASE, 's');
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${BASE}/session/s/wda/unlock`);
  assert.deepEqual(request.body, {});
});

test('type sends a character array because wda joins it back', () => {
  const type = buildWdaTypeRequest(BASE, 's', '你好ab');
  assert.equal(type.url, `${BASE}/session/s/wda/keys`);
  assert.deepEqual(type.body.value, ['你', '好', 'a', 'b']);
  assert.deepEqual(buildWdaTypeRequest(BASE, 's', '').body.value, []);
});

test('home screen is posted WITHOUT a session segment', () => {
  // WDA 里它注册为 `.withoutSession`：拼上 /session/:id 会 404，
  // 而报错只说 "Unhandled endpoint"，完全看不出是 session 段的问题。
  const request = buildWdaHomeRequest(BASE);
  assert.equal(request.url, `${BASE}/wda/homescreen`);
  assert.ok(!request.url.includes('/session/'), '回主屏不能带 session 段');
  // 签名上就不接受 sessionId，调用方想拼也拼不出来
  assert.equal(buildWdaHomeRequest.length, 1, 'buildWdaHomeRequest 只应接受 baseUrl');
});

test('session lifecycle and screen size use the documented endpoints', () => {
  assert.equal(buildWdaSessionRequest(`${BASE}/`).url, `${BASE}/session`);
  assert.equal(buildWdaDeleteSessionRequest(BASE, 's').url, `${BASE}/session/s`);
  assert.equal(buildWdaWindowRectRequest(BASE, 's').url, `${BASE}/session/s/window/rect`);
  assert.equal(buildWdaStatusRequest(BASE).url, `${BASE}/status`);
  assert.equal(buildWdaStatusRequest(BASE).method, 'GET');
});

test('session ids are url-encoded so a stray character cannot break the path', () => {
  const request = buildWdaTapRequest(BASE, 'a/b c', { x: 1, y: 2 });
  assert.ok(request.url.includes('a%2Fb%20c'), `实际：${request.url}`);
});

test('no request ever targets the removed /wda/touch/perform endpoint', () => {
  // 这是旧版 JSONWP 的写法，新版 WDA 返回 404 unknown command。
  // 这条守卫防止有人「凭印象」把它写回来。
  const builders = [
    buildWdaSessionRequest(BASE),
    buildWdaDeleteSessionRequest(BASE, 's'),
    buildWdaTapRequest(BASE, 's', { x: 1, y: 2 }),
    buildWdaLongPressRequest(BASE, 's', { x: 1, y: 2 }),
    buildWdaDragRequest(BASE, 's', { x: 1, y: 1 }, { x: 2, y: 2 }),
    buildWdaTypeRequest(BASE, 's', 'a'),
    buildWdaHomeRequest(BASE),
    buildWdaWindowRectRequest(BASE, 's'),
    buildWdaStatusRequest(BASE)
  ];
  for (const request of builders) {
    assert.ok(!request.url.includes('touch/perform'),
      `不应再使用已移除的端点：${request.url}`);
  }
});

test('the main process actually uses this module', () => {
  // 关键守卫：上面所有断言都只在这个模块被真正使用时才有意义。
  // 历史上主进程内联了另一份（同样错的）端点，于是这些测试全绿而功能不通。
  const source = fs.readFileSync(path.join(ROOT, 'electron/ios-control.js'), 'utf8');
  assert.match(source, /require\('\.\/wda-requests'\)/, 'ios-control 应从 wda-requests 引入请求构造');
  // 主进程里不该再出现任何硬编码的 WDA 路径片段
  for (const fragment of ['/wda/tap', '/wda/touchAndHold', '/wda/keys', '/wda/homescreen']) {
    assert.ok(!source.includes(`'${fragment}`) && !source.includes(`/${fragment}'`),
      `ios-control 不应内联路径 ${fragment}，应走 wda-requests`);
  }
});

test('the renderer module no longer carries a duplicate request builder', () => {
  // src/lib/wdaClient.js 是 ESM，主进程用不了它 —— 留在那里的请求构造必然是死代码。
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/wdaClient.js'), 'utf8');
  assert.ok(!/export function buildWda/.test(source),
    'src/lib/wdaClient.js 不应再导出 buildWda*（主进程无法 require ESM，必然是死代码）');
  assert.match(source, /export function mapPointerToDevice/, '坐标映射要保留（渲染层在用）');
});

test('hardware button posts name to the session-scoped /wda/pressButton', () => {
  const request = buildWdaPressButtonRequest(BASE, 's', 'volumeUp');
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `${BASE}/session/s/wda/pressButton`);
  assert.deepEqual(request.body, { name: 'volumeUp' });
  // 缺按键名时宁可空字符串进 WDA（让它报错），也不拼出 undefined
  assert.deepEqual(buildWdaPressButtonRequest(BASE, 's', null).body, { name: '' });
});

test('directional swipe is a different endpoint from two-point drag', () => {
  const request = buildWdaDirectionalSwipeRequest(BASE, 's', 'up');
  assert.equal(request.method, 'POST');
  // 注意：是 /wda/swipe，不是 /wda/dragfromtoforduration —— 两个语义不同的端点
  assert.equal(request.url, `${BASE}/session/s/wda/swipe`);
  assert.deepEqual(request.body, { direction: 'up' });
});

test('app launch/terminate/active hit the /wda/apps/* endpoints', () => {
  const launch = buildWdaAppLaunchRequest(BASE, 's', 'com.apple.mobilesafari');
  assert.equal(launch.method, 'POST');
  assert.equal(launch.url, `${BASE}/session/s/wda/apps/launch`);
  assert.deepEqual(launch.body, { bundleId: 'com.apple.mobilesafari' });

  const terminate = buildWdaAppTerminateRequest(BASE, 's', 'com.apple.mobilesafari');
  assert.equal(terminate.url, `${BASE}/session/s/wda/apps/terminate`);
  assert.deepEqual(terminate.body, { bundleId: 'com.apple.mobilesafari' });

  const active = buildWdaActiveAppRequest(BASE, 's');
  assert.equal(active.method, 'GET');
  assert.equal(active.url, `${BASE}/session/s/wda/apps/active`);
  assert.equal(active.body, null);
});

test('zoom builds a two-finger pinch sequence symmetric around the center', () => {
  const request = buildWdaZoomRequest(BASE, 's', {
    center: { x: 200, y: 400 },
    startGap: 80,
    endGap: 400,
    duration: 0.5
  });
  assert.equal(request.url, `${BASE}/session/s/actions`);

  const pointers = request.body.actions;
  assert.equal(pointers.length, 2, '双指缩放必须有两个 pointer');
  assert.deepEqual(pointers[0].parameters, { pointerType: 'touch' });
  assert.deepEqual(pointers[1].parameters, { pointerType: 'touch' });
  assert.notEqual(pointers[0].id, pointers[1].id);

  // 两根手指的动作序列形状相同：按下 → 起手停顿 → 多段移动 → 停顿 → 抬起
  for (const pointer of pointers) {
    const actions = pointer.actions;
    assert.equal(actions[1].type, 'pointerDown');
    assert.ok(actions[2].type === 'pause' && actions[2].duration >= 200, '起手停顿要 ≥200ms');
    const moves = actions.slice(3, -2);
    assert.ok(moves.length >= 4, '轨迹必须拆段');
    assert.ok(moves.every((item) => item.type === 'pointerMove'));
    assert.equal(actions.at(-1).type, 'pointerUp');
  }

  // 手指 1 从中心右侧出发，手指 2 从左侧 —— 间距从 startGap 撑到 endGap
  const [finger1, finger2] = pointers.map((p) => p.actions);
  assert.equal(finger1[0].x, 200 + 40, 'finger1 起点在中心右侧半间距处');
  assert.equal(finger2[0].x, 200 - 40, 'finger2 起点在中心左侧半间距处');
  assert.equal(finger1[0].y, 400);
  assert.equal(finger2[0].y, 400, '两指同 y —— 水平对称');
  // 终点：外扩到 endGap/2
  const finger1LastMove = finger1.slice(3, -2).at(-1);
  assert.equal(finger1LastMove.x, 200 + 200, 'finger1 终点在 endGap/2 处');
  // 两指轨迹关于中心镜像：任意中间点 x1 + x2 = 2*cx
  const moves1 = finger1.slice(3, -2);
  const moves2 = finger2.slice(3, -2);
  for (let i = 0; i < moves1.length; i += 1) {
    assert.equal(moves1[i].x + moves2[i].x, 400, `第 ${i} 段两指必须关于中心镜像`);
  }
});

test('zoom gaps never collapse to zero so the gesture stays recognizable', () => {
  // gap 下限 1：两指完全重合的 pinch 不会被 iOS 当手势
  const tiny = buildWdaZoomRequest(BASE, 's', { center: { x: 100, y: 100 }, startGap: 0, endGap: 0 });
  const [f1, f2] = tiny.body.actions.map((p) => p.actions);
  assert.ok(f1[0].x > f2[0].x, '即使 gap 传 0，两指起点也不能重合');
});
