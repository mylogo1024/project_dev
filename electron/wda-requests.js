'use strict';

/**
 * WebDriverAgent 请求构造 —— **端点形状全部来自实测，不是猜的**。
 *
 * 为什么单独放一个 CJS 模块：主进程是 CJS，而 `src/lib/wdaClient.js` 是 ESM
 * （渲染层要用，且 ESM 才能被 Vite 打包）。`require()` 一个 ESM 在 Electron 28 的
 * Node 18 下**不可用**（`require(esm)` 是 Node 22 才有的）。
 *
 * 于是历史上一度出现「两边各写一份」：测试测 ESM 那份、真实代码跑 CJS 那份，
 * 两份端点都写错了，测试却是绿的 —— **测了一个平行实现**。
 * 现在把请求构造收口到这里，`electron/ios-control.js` 直接用它。
 *
 * 端点对照（v16.12.9 实测，`✓` 为实际返回 200）：
 *
 * | 操作     | 端点                                        | 请求体                        |
 * | -------- | ------------------------------------------- | ----------------------------- |
 * | 点击     | `POST /session/:id/wda/tap`                 | `{x, y}`                      |
 * | 长按     | `POST /session/:id/wda/touchAndHold`        | `{x, y, duration}`            |
 * | 拖拽     | `POST /session/:id/wda/dragfromtoforduration`| `{fromX, fromY, toX, toY, duration}` |
 * | 拖拽兜底 | `POST /session/:id/actions`                 | W3C `pointer` 序列（见下）    |
 * | 解锁     | `POST /session/:id/wda/unlock`              | `{}`                          |
 * | 输入文本 | `POST /session/:id/wda/keys`                | `{value: ["a","b"]}`          |
 * | 回主屏   | `POST /wda/homescreen`  ← **不带 session**  | `{}`                          |
 * | 屏幕尺寸 | `GET  /session/:id/window/rect`             | —                             |
 *
 * **两个最容易踩的坑**（都已实测确认）：
 *
 * 1. **`/wda/touch/perform` 在新版 WDA 上不存在**（返回 404 `unknown command`）。
 *    那是旧版 JSONWP 的写法（`{actions:[{action:'tap',options:{x,y}}]}`），
 *    现在每个动作各有独立端点。
 * 2. **回主屏必须不带 session** —— WDA 里它注册为 `.withoutSession`：
 *    `[[FBRoute POST:@"/wda/homescreen"].withoutSession ...]`。
 *    写成 `/session/:id/wda/homescreen` 会 404，而且报错只说 "Unhandled endpoint"，
 *    完全看不出是少了/多了 session 段。
 *
 * 想用 W3C 标准触摸动作时可以用 `/session/:id/actions`（同样实测 200），
 * 但上面这些专用端点更直接，也是当前实现采用的。
 */

/** 去掉末尾斜杠，避免拼出 `//session`。 */
function normalizeWdaBaseUrl(baseUrl) {
  const text = String(baseUrl ?? '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

/** 设备坐标必须是整数点。 */
function toPoint(value) {
  return Math.round(Number(value) || 0);
}

/** 时长（秒）。0 会让拖拽变成瞬间完成，所以给一个下限。 */
function toDuration(value, fallback) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return seconds;
}

function sessionPath(baseUrl, sessionId, suffix) {
  const base = normalizeWdaBaseUrl(baseUrl);
  const id = encodeURIComponent(String(sessionId ?? ''));
  return `${base}/session/${id}${suffix}`;
}

/** 创建会话。WDA 接受 WebDriver 的 capabilities 结构。 */
function buildWdaSessionRequest(baseUrl) {
  return {
    method: 'POST',
    url: `${normalizeWdaBaseUrl(baseUrl)}/session`,
    headers: { 'Content-Type': 'application/json' },
    body: { capabilities: { alwaysMatch: { platformName: 'iOS' } } }
  };
}

function buildWdaDeleteSessionRequest(baseUrl, sessionId) {
  return {
    method: 'DELETE',
    url: sessionPath(baseUrl, sessionId, ''),
    headers: {},
    body: null
  };
}

/** 点击（`/wda/tap`，坐标直接在请求体里）。 */
function buildWdaTapRequest(baseUrl, sessionId, point) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/tap'),
    headers: { 'Content-Type': 'application/json' },
    body: { x: toPoint(point?.x), y: toPoint(point?.y) }
  };
}

/** 长按（`/wda/touchAndHold`，duration 单位秒）。 */
function buildWdaLongPressRequest(baseUrl, sessionId, point, duration = 1) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/touchAndHold'),
    headers: { 'Content-Type': 'application/json' },
    body: {
      x: toPoint(point?.x),
      y: toPoint(point?.y),
      duration: toDuration(duration, 1)
    }
  };
}

/**
 * 拖拽（`/wda/dragfromtoforduration`）。
 *
 * 注意不要用 `/wda/swipe` —— 那个端点的语义是「按方向滑」，参数是
 * `{direction: 'up'|'down'|'left'|'right'}`，不是任意两点之间的拖拽。
 * 画面上按住拖动对应的是这里的两点拖拽。
 */
function buildWdaDragRequest(baseUrl, sessionId, from, to, duration = 0.5) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/dragfromtoforduration'),
    headers: { 'Content-Type': 'application/json' },
    body: {
      fromX: toPoint(from?.x),
      fromY: toPoint(from?.y),
      toX: toPoint(to?.x),
      toY: toPoint(to?.y),
      duration: toDuration(duration, 0.5)
    }
  };
}

/**
 * 拖拽兜底（W3C `/session/:id/actions`，实测 200）。
 *
 * `dragfromtoforduration` 在部分 WDA 版本 / 场景下会被静默忽略（请求 200 但屏幕没动），
 * 尤其是短距离快速滑动时。W3C actions 序列走的是另一条实现路径
 * （XCUITest 的 coordinate press + move），作为兜底成功率更高。
 *
 * **轨迹必须拆成多段**：iOS 对「单点 → 单点」的瞬时跃迁识别很差，看起来就像
 * 没反应。把 from→to 切成 N 个中间点（每段约 12 设备像素），加上起手按压停顿，
 * 等效于一根真正在屏幕上滑动的手指，系统才把它当 swipe 处理。
 *
 * 指针序列：
 *   pointerMove 起点 → pointerDown → pause(起手停顿) → N 段 pointerMove → pause → pointerUp
 * 三个 `pause` 把动作撑开成真实耗时，否则 WDA 会把整串动作瞬间执行完，
 * 效果等同于「瞬间移动」而不是滑动。
 */
function buildWdaActionsDragRequest(baseUrl, sessionId, from, to, duration = 0.5) {
  const seconds = toDuration(duration, 0.5);
  const startX = toPoint(from?.x);
  const startY = toPoint(from?.y);
  const endX = toPoint(to?.x);
  const endY = toPoint(to?.y);
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.hypot(dx, dy);
  // 段数：每段约 10 设备像素，4~32 段之间 —— 太密等于瞬移（系统来不及采到中间点），
  // 太疏轨迹不连续，iOS 会判成「拖拽」而不是「滑动」。
  // 关键：段数还要受**总时长**约束 —— W3C actions 的实际时长是各段 duration 的累加，
  // 不是参数里的 duration。段数 × 60ms 若超过总时长，等于把滑动偷偷放慢成拖拽
  // （一屏滑动会从 0.8s 变成 1.9s，惯性全丢）。所以上限取两者的较小值。
  const maxSegmentsByDistance = Math.max(4, Math.min(32, Math.round(distance / 10) || 1));
  const maxSegmentsByTime = Math.max(1, Math.floor((seconds * 1000) / 60));
  const segments = Math.max(4, Math.min(maxSegmentsByDistance, maxSegmentsByTime));
  // 下限从 20ms 提到 60ms：20ms 时整串动作经 WDA 下发后各段几乎同时到达，
  // 等效于「单点跃迁」，这正是「时灵时不灵」的主因。60ms 是实测的稳定下限，
  // 再低就会出现「有时滑不动」。上面的段数约束保证了总时长不会因此超标。
  const segmentMs = Math.max(60, Math.round((seconds * 1000) / segments));
  const moves = [];
  for (let i = 1; i <= segments; i += 1) {
    const ratio = i / segments;
    moves.push({
      type: 'pointerMove',
      duration: segmentMs,
      x: Math.round(startX + dx * ratio),
      y: Math.round(startY + dy * ratio)
    });
  }
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/actions'),
    headers: { 'Content-Type': 'application/json' },
    body: {
      actions: [
        {
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: startX, y: startY },
            { type: 'pointerDown', button: 0 },
            // 起手停顿：iOS 把低于 ~120ms 的 touch-then-move 当成 tap。
            // 原来给 220ms，在 iOS 17/18 上滑动成功率仍不稳定 —— 提到 300ms，
            // 代价是每次滑动多 ~80ms 延迟（用户感知不到），换来的是几乎不丢手势。
            { type: 'pause', duration: 300 },
            ...moves,
            // 末尾停顿后再抬手：太短的话系统在最后一刻把 swipe 判成 fling 甩动，
            // 只滚一点点就停。取滑动耗时的 25%，下限提到 120ms。
            { type: 'pause', duration: Math.max(120, Math.round(seconds * 250)) },
            { type: 'pointerUp', button: 0 }
          ]
        }
      ]
    }
  };
}

/**
 * 解锁（`/wda/unlock`）。
 *
 * 仅对**无密码或已输入过密码**的设备有效：它只是点亮/解锁屏幕，
 * 不能绕过锁屏密码键盘（XCUITest 被系统禁止向密码键盘注入触摸）。
 * 对无人值守场景，配合「设备不设密码」或「设置里关掉『需要密码』」使用。
 */
function buildWdaUnlockRequest(baseUrl, sessionId) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/unlock'),
    headers: { 'Content-Type': 'application/json' },
    body: {}
  };
}

/** 输入文本。WDA 要求把每个字符拆成数组（它内部 `componentsJoinedByString:@""`）。 */
function buildWdaTypeRequest(baseUrl, sessionId, text) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/keys'),
    headers: { 'Content-Type': 'application/json' },
    body: { value: Array.from(String(text ?? '')) }
  };
}

/**
 * 回到主屏。
 *
 * **不带 session** —— WDA 里注册为 `.withoutSession`，带上 `/session/:id` 会 404。
 * 所以这里没有 sessionId 参数，调用方也不要拼。
 */
function buildWdaHomeRequest(baseUrl) {
  return {
    method: 'POST',
    url: `${normalizeWdaBaseUrl(baseUrl)}/wda/homescreen`,
    headers: { 'Content-Type': 'application/json' },
    body: {}
  };
}

/** 设备逻辑屏幕尺寸（点，不是像素）。点击坐标必须换算到这个坐标系。 */
function buildWdaWindowRectRequest(baseUrl, sessionId) {
  return {
    method: 'GET',
    url: sessionPath(baseUrl, sessionId, '/window/rect'),
    headers: {},
    body: null
  };
}

/**
 * 硬件按键（`/wda/pressButton`，带会话）。
 *
 * 可用按键与 WDA 源码 `FBKeyboardButtonCode` 对照（实测设备 iOS 16/17）：
 * `home` 回主屏 / `volumeUp` `volumeDown` 音量 / `mute` 静音开关 / `power` 锁屏亮屏。
 * 注意 `home` 走这里时同样有效，但现有 `pressHome()` 走不带会话的
 * `/wda/homescreen`（会话失效也能用），优先用那一个。
 */
function buildWdaPressButtonRequest(baseUrl, sessionId, buttonName) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/pressButton'),
    headers: { 'Content-Type': 'application/json' },
    body: { name: String(buttonName ?? '') }
  };
}

/**
 * 按方向滑（`/wda/swipe`，带会话）。
 *
 * 和拖拽（两点坐标）是**两个不同端点**：这里语义是「向某方向翻一屏」，
 * `direction` 只接受 `up|down|left|right`，WDA 内部自己决定滑动距离。
 * 适合「翻页 / 下拉刷新」这类不需要精确落点的操作 —— 画布上做不出
 * 「方向」手势（鼠标拖拽天然带坐标），所以只有程序化调用方用。
 */
function buildWdaDirectionalSwipeRequest(baseUrl, sessionId, direction) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/swipe'),
    headers: { 'Content-Type': 'application/json' },
    body: { direction: String(direction ?? '') }
  };
}

/**
 * 启动 App（`/wda/apps/launch`，带会话）。
 *
 * `bundleId` 形如 `com.apple.mobilesafari`。设备上没装时 WDA 返回错误
 * `Application with ... not found`，调用方直接把 message 抛给用户即可。
 */
function buildWdaAppLaunchRequest(baseUrl, sessionId, bundleId) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/apps/launch'),
    headers: { 'Content-Type': 'application/json' },
    body: { bundleId: String(bundleId ?? '') }
  };
}

/** 结束 App（`/wda/apps/terminate`，带会话）。后台仍在跑的 App 用这个杀干净。 */
function buildWdaAppTerminateRequest(baseUrl, sessionId, bundleId) {
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/wda/apps/terminate'),
    headers: { 'Content-Type': 'application/json' },
    body: { bundleId: String(bundleId ?? '') }
  };
}

/**
 * 查询前台 App（`/wda/apps/active`，带会话，GET）。
 *
 * 返回 `value` 形如 `{ bundleId, name, pid, state? }` —— 渲染层显示
 * 「当前在操作哪个 App」、以及「launch 前先看看是不是已经开着」都靠它。
 */
function buildWdaActiveAppRequest(baseUrl, sessionId) {
  return {
    method: 'GET',
    url: sessionPath(baseUrl, sessionId, '/wda/apps/active'),
    headers: {},
    body: null
  };
}

/**
 * 双指缩放（W3C `/session/:id/actions` 双指针序列，WDA 无专用 zoom 端点）。
 *
 * W3C actions 天然支持多指针：两根手指以 `center` 为中心、间距从 `startGap`
 * 变到 `endGap` 同时移动，就是标准的 pinch 手势 —— `endGap > startGap` 为放大。
 * 轨迹拆段逻辑与 `buildWdaActionsDragRequest` 相同 —— 单点跃迁 iOS 识别很差。
 *
 * @param {object} options
 * @param {{x:number,y:number}} options.center 双指连线中点（设备坐标，一般传屏幕中点）
 * @param {number} options.startGap 起始双指间距（设备像素，建议 ≥ 短边 20%）
 * @param {number} options.endGap 结束双指间距
 * @param {number} [options.duration] 手势时长（秒）
 */
function buildWdaZoomRequest(baseUrl, sessionId, { center, startGap, endGap, duration = 0.5 } = {}) {
  const seconds = toDuration(duration, 0.5);
  const cx = toPoint(center?.x);
  const cy = toPoint(center?.y);
  const from = Math.max(1, toPoint(startGap) / 2);
  const to = Math.max(1, toPoint(endGap) / 2);
  const segments = 10;
  const segmentMs = Math.max(20, Math.round((seconds * 1000) / segments));
  // 两指水平对称分布在 center 两侧 —— zoom 手势对角度不敏感，水平最直观
  const buildFinger = (sign) => {
    const moves = [];
    for (let i = 1; i <= segments; i += 1) {
      const ratio = i / segments;
      const gap = from + (to - from) * ratio;
      moves.push({ type: 'pointerMove', duration: segmentMs, x: cx + Math.round(sign * gap), y: cy });
    }
    return moves;
  };
  const buildFingerActions = (sign) => [
    { type: 'pointerMove', duration: 0, x: cx + Math.round(sign * from), y: cy },
    { type: 'pointerDown', button: 0 },
    // 起手停顿：低于 ~120ms 的 touch-then-move 会被当成 tap，给足 220ms
    { type: 'pause', duration: 220 },
    ...buildFinger(sign),
    { type: 'pause', duration: 80 },
    { type: 'pointerUp', button: 0 }
  ];
  return {
    method: 'POST',
    url: sessionPath(baseUrl, sessionId, '/actions'),
    headers: { 'Content-Type': 'application/json' },
    body: {
      actions: [
        { type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: buildFingerActions(1) },
        { type: 'pointer', id: 'finger2', parameters: { pointerType: 'touch' }, actions: buildFingerActions(-1) }
      ]
    }
  };
}

/** 查询 WDA 是否就绪（不需要会话）。 */
function buildWdaStatusRequest(baseUrl) {
  return {
    method: 'GET',
    url: `${normalizeWdaBaseUrl(baseUrl)}/status`,
    headers: {},
    body: null
  };
}

module.exports = {
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
};
