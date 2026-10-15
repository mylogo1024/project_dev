'use strict';

/**
 * iOS 设备控制（WebDriverAgent 后端）。
 *
 * **为什么选 WDA**：它从 iOS 12 起就能用，**不需要内核隧道、不需要开发者镜像** ——
 * 兼容面比 CoreDevice HID（要求 iOS 27+）宽得多。选型依据见 `COMPETITIVE_ANALYSIS.md`。
 *
 * 这一层负责「把请求发出去」与「会话/端口转发的生命周期」。
 * 请求体怎么拼在 `./wda-requests`（端点形状都有实测依据）；坐标怎么换算在
 * `src/lib/wdaClient.js` 的 `mapPointerToDevice`（纯函数，渲染层也要用）。
 * 本文件负责 IO，因此把 HTTP 做成可注入的，单测里可以塞假实现，不需要真的连设备。
 */

const http = require('http');
const { spawn } = require('child_process');

/**
 * 诊断日志前缀。用户跑真机验证滑动时会看主进程控制台，
 * `[wda]` 是统一锚点，方便 grep / 过滤。
 *
 * 日志只在 iOS 控制真正发生动作时才打（tap/swipe/longPress/截图），
 * 心跳类（probe/status）默认不写，避免噪音盖掉真正的请求。
 */
const WDA_LOG_PREFIX = '[wda]';
const wdaLog = (...parts) => {
  try {
    console.log(WDA_LOG_PREFIX, ...parts);
  } catch (_) {
    // console 不可用（极端测试环境）就吞掉，不能让日志拖累主流程
  }
};
const wdaError = (...parts) => {
  try {
    console.error(WDA_LOG_PREFIX, ...parts);
  } catch (_) {
    // 同上
  }
};
const {
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
} = require('./wda-requests');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8100';
const DEFAULT_TIMEOUT = 8000;
/**
 * WDA 的 MJPEG 视频流默认监听在**设备的** 9100 端口（`FBMjpegServer`，
 * 路径 `/`）。它把屏幕编码成 JPEG 连续帧推给客户端，实测能到 10+ fps，
 * 比 idevicescreenshot 轮询（约 1 帧/秒）快一个数量级 —— 这是「画面延迟」
 * 问题的唯一出路（macOS 侧 AVFoundation 采集需要本机有摄像头，很多人没有）。
 *
 * 转发到本机后仍走 9100，前端再来取。见 `startMjpegProxy`。
 */
const MJPEG_DEVICE_PORT = 9100;
/** 建立端口转发后等多久再探测（iproxy 起得很快，但要给它一点时间） */
const FORWARD_SETTLE_MS = 700;
/** WDA 启动是「装好的测试 runner 被拉起来」，比 iproxy 慢得多，要轮询等 */
const WDA_START_TIMEOUT_MS = 30000;
const WDA_POLL_INTERVAL_MS = 1000;
/**
 * spawn 之后先等一小会儿再判断死活。
 *
 * **不能 spawn 完立刻查 `exitCode`** —— 进程瞬间失败时（参数不对 / 没装 / 设备不在），
 * stderr 还没来得及送到，会把「能识别的具体原因」误判成笼统的「退出码 1」，
 * 用户就拿不到该做什么。这和 `ensurePortForward` 里踩过的是同一个坑。
 */
const WDA_SPAWN_SETTLE_MS = 300;

/** 去掉末尾斜杠，避免拼出 `//session`。 */
function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

/**
 * 发一个 JSON 请求。WDA 的响应形如 `{ value: ... }`，出错时 value 里带 error/message。
 * 用可注入的 transport 是为了让单测不依赖真实设备。
 */
function defaultTransport(url, { method, body, timeout }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error(`WDA 地址无效：${url}`));
      return;
    }

    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const request = http.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });

    request.on('error', reject);
    request.setTimeout(timeout, () => {
      request.destroy(new Error(`请求 WDA 超时（${timeout}ms）`));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function parseResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * WDA 把错误放在 `value.error`（机器码，如 `invalid element`）与
 * `value.message`（给人看的说明）里。**优先取 message** —— 用户要的是
 * 「坐标超出屏幕」而不是「invalid element」。
 */
function extractWdaError(parsed, fallback) {
  const value = parsed?.value;
  if (value && typeof value === 'object') {
    return String(value.message || value.error || fallback);
  }
  return fallback;
}

/** 取多行输出的第一行非空内容（外部命令的报错通常第一行最有用）。 */
function firstLine(text) {
  const line = String(text || '').split('\n').map((item) => item.trim()).find(Boolean);
  return line || '';
}

/**
 * 日志里只留 `路径?查询`，去掉 `http://127.0.0.1:8100` 这段噪音 ——
 * 用户要核对的是「打到了哪个端点」。
 */
function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return String(url || '');
  }
}

/**
 * 把请求体压成一行短摘要，日志里才看得清关键参数。
 *
 * `/actions` 的请求体是几十段 pointerMove 的长数组，整条打出来会刷屏、
 * 真正要看的信息（分段数、起手停顿、首末坐标）全被淹掉。这里只抽这些。
 */
function compactBody(body) {
  if (body == null) return '';
  const pointer = body.actions?.[0];
  if (pointer?.actions) {
    const list = pointer.actions;
    const moves = list.filter((item) => item.type === 'pointerMove');
    const first = moves[0] || null;
    const last = moves[moves.length - 1] || null;
    const hold = list.find((item) => item.type === 'pause');
    return `[actions] 段数=${moves.length} 起手停顿=${hold?.duration ?? 0}ms `
      + `起点=(${first?.x},${first?.y}) 终点=(${last?.x},${last?.y})`;
  }
  if (body.from && body.to) {
    return `[drag] from=(${body.from.x},${body.from.y}) to=(${body.to.x},${body.to.y}) duration=${body.duration ?? '-'}`;
  }
  if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
    return `[point] (${body.x},${body.y})${body.duration != null ? ` duration=${body.duration}` : ''}`;
  }
  return '';
}

/**
 * 收掉子进程**及其派生的子进程**。
 *
 * `tidevice wdaproxy` 会再派生一个子进程（真正监听 8100 的那个，实测 `lsof` 能看到）。
 * 只 kill 直接子进程，那个孙子进程会继续占着 8100 —— 表现为
 * 「应用退出了，但下次启动转发起不来」。
 *
 * 所以启动时用 `detached: true` 让它成为**进程组组长**，退出时按负 pid 杀整组。
 *
 * `iproxy` 不需要这样：它是单个可执行文件，不派生（实测退出后无残留）。
 */
function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch (_) {
      // 进程组可能已经不在了，退回单进程 kill
    }
  }
  try {
    child.kill();
  } catch (_) {
    // 进程可能已经退出，kill 失败是正常的
  }
}

/**
 * 把端口转发的失败原因说成人话。
 * 这几种情况的处置完全不同，用同一句话会把用户引到错误方向。
 */
function describeForwardFailure(result) {
  if (result.reason === 'no-device') {
    return '未指定设备';
  }
  if (result.reason === 'spawn-failed') {
    return `未能启动 iproxy（${result.detail}）`
      + ' —— 请确认已安装 libimobiledevice（macOS 可执行 brew install libimobiledevice）';
  }
  if (result.reason === 'iproxy-failed') {
    return `iproxy 启动后立即退出：${result.detail}`
      + ' —— 请确认数据线已连接且已在这台电脑上「信任」该设备';
  }
  return '原因未知';
}

/**
 * 把「启动 WDA 失败」说成人话。
 *
 * 最关键的是把 **`wda-not-installed`** 单独拎出来：那说明设备上从来没装过 WDA，
 * 需要先用 Xcode 编译安装一次；而其余几种都只是「这次没起来」，
 * 处置完全不同。混成一句「启动失败」用户就只能瞎试。
 */
function describeWdaStartFailure(result) {
  if (result.reason === 'no-device') return '未指定设备';
  if (result.reason === 'spawn-failed') {
    return `未能启动 tidevice（${result.detail}）`
      + ' —— 请确认已安装 tidevice（pipx install tidevice）';
  }
  if (result.reason === 'wda-not-installed') {
    return '设备上还没装 WebDriverAgent —— 需要用 Xcode 编译安装一次'
      + '（详见 FEATURE_STATUS 的「免 Xcode 装一次 WDA」）';
  }
  if (result.reason === 'tidevice-failed') {
    return `tidevice 启动后立即退出：${result.detail}`;
  }
  if (result.reason === 'timeout') {
    return `等待 WebDriverAgent 就绪超时（${WDA_START_TIMEOUT_MS / 1000} 秒）`
      + `${result.detail ? `：${result.detail}` : ''}`;
  }
  return '原因未知';
}

function createIosControl(options = {}) {
  const transport = options.transport || defaultTransport;
  const spawnProcess = options.spawn || spawn;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  const port = Number(new URL(baseUrl).port) || 8100;
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // 可注入是为了让「等超时」这条路径能被单测覆盖 —— 否则测一次要真等 30 秒
  const wdaStartTimeout = Number(options.wdaStartTimeoutMs) || WDA_START_TIMEOUT_MS;
  const now = options.now || (() => Date.now());

  // 会话与屏幕尺寸都是「连上之后才知道」的，缓存在这里，避免每次点击都重新查
  let sessionId = null;
  let screenSize = null;
  let forwardProcess = null;
  let forwardDeviceId = null;
  let wdaProcess = null;
  let wdaDeviceId = null;
  // MJPEG 9100 转发是独立子进程（端口 8100 的 iproxy 是另一个）——
  // 不复用 forwardProcess，否则 wdaproxy 接管 8100 后会把 9100 一并杀掉。
  // deviceId 必须成对记录：复用前要校验「这条转发属于哪台设备」，
  // 否则用户切换设备后会拿到**旧设备**的画面流，且完全看不出异常。
  let mjpegForwardProcess = null;
  let mjpegForwardDeviceId = null;
  let mjpegProxyServer = null;
  let mjpegProxyDeviceId = null;

  /**
   * WebDriverAgent 监听在**设备的** localhost:8100 上，Mac 直连不到，
   * 必须先做 USB 端口转发。没有这一步，用户即使把 WDA 跑起来了，
   * 应用也只会一直报「未运行」。
   *
   * **参数形式很关键**（新版 libimobiledevice）：
   *
   * ```
   * iproxy [OPTIONS] LOCAL_PORT:DEVICE_PORT
   *   -u, --udid UDID    target specific device by UDID
   * ```
   *
   * 即 `iproxy -u <udid> 8100:8100`。旧写法 `iproxy 8100 8100 <udid>` 会直接报
   * `Invalid listen port specified in argument '8100'!` 并**立刻退出** ——
   * 转发静默失效，用户只会看到「WDA 未运行」，方向完全指错。
   *
   * 返回值是 `{ ok, reason, detail }` 而不是布尔：起不来和参数不对要能区分，
   * 否则用户拿不到可执行的下一步。
   */
  async function ensurePortForward(deviceId) {
    if (!deviceId) return { ok: false, reason: 'no-device' };
    // wdaproxy 已经接管了 8100（它自己就做转发），再起 iproxy 会抢端口
    if (isWdaRunning()) return { ok: true, reused: true, via: 'wda' };
    if (forwardProcess && forwardDeviceId === deviceId && forwardProcess.exitCode === null) {
      return { ok: true, reused: true };
    }
    await stopPortForward();

    let child;
    try {
      child = spawnProcess('iproxy', ['-u', deviceId, `${port}:${port}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', detail: error.message };
    }

    // 收下 stderr，失败时才能把 iproxy 自己的原话带给用户
    let stderr = '';
    let spawnError = null;
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
    child.once?.('error', (error) => { spawnError = error; });

    forwardProcess = child;
    forwardDeviceId = deviceId;

    await delay(FORWARD_SETTLE_MS);

    if (spawnError) {
      forwardProcess = null;
      forwardDeviceId = null;
      return { ok: false, reason: 'spawn-failed', detail: spawnError.message };
    }

    // iproxy 参数不对 / 设备不存在时会**立即退出**。必须查一次退出码，
    // 否则会把「转发根本没起来」当成「转发成功」，后面的报错就指错了方向。
    const code = child.exitCode;
    if (typeof code === 'number' && code !== 0) {
      forwardProcess = null;
      forwardDeviceId = null;
      const first = stderr.trim().split('\n')[0];
      return { ok: false, reason: 'iproxy-failed', detail: first || `退出码 ${code}` };
    }

    // 8100 转好时顺手把 MJPEG 9100 也起一条 iproxy。两个 iproxy 是独立子进程，
    // 互相不影响 —— 任一条失败都不影响另一条；MJPEG 转不起来时上层业务照常用，
    // 退化成截图轮询即可。
    try {
      await ensureMjpegForward(deviceId);
    } catch (mjpegError) {
      wdaError(`MJPEG 9100 端口转发失败（不影响 8100 控制）：${mjpegError.message}`);
    }
    return { ok: true };
  }

  /**
   * 给 MJPEG 流额外起一条 iproxy 9100 → 设备 9100。
   *
   * 为什么不复用 `forwardProcess`：WDA 启动后 wdaproxy 会接管 8100 的转发，
   * 那是另一个进程。9100 没人接，得单独起。
   *
   * 失败时只打日志不抛 —— 没有 MJPEG 流用户也能用截图轮询，不能因为画面慢
   * 就连点击都不让用。
   */
  async function ensureMjpegForward(deviceId) {
    // 复用前必须校验设备：只看「进程还活着」不看「属于谁」，切换设备后
    // 会把**旧设备**的 9100 流接给新设备 —— 画面是错的还不报错，最难排查
    if (
      mjpegForwardProcess
      && mjpegForwardProcess.exitCode === null
      && mjpegForwardDeviceId === deviceId
    ) {
      return;
    }
    if (mjpegForwardProcess) {
      try { mjpegForwardProcess.kill(); } catch (_) { /* 已退出 */ }
      mjpegForwardProcess = null;
    }
    mjpegForwardDeviceId = null;
    const child = spawnProcess('iproxy', [
      '-u', deviceId,
      `${MJPEG_DEVICE_PORT}:${MJPEG_DEVICE_PORT}`
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
    child.once?.('error', () => {});
    mjpegForwardProcess = child;
    mjpegForwardDeviceId = deviceId;
    await delay(FORWARD_SETTLE_MS);
    const code = child.exitCode;
    if (typeof code === 'number' && code !== 0) {
      const detail = stderr.trim().split('\n')[0] || `退出码 ${code}`;
      mjpegForwardProcess = null;
      mjpegForwardDeviceId = null;
      throw new Error(`iproxy -u ${deviceId} ${MJPEG_DEVICE_PORT}:${MJPEG_DEVICE_PORT}：${detail}`);
    }
  }

  /**
   * 同步收掉转发进程 —— 给 `will-quit` 兜底用。
   *
   * 退出清理**必须有一条同步路径**：`will-quit` 里不能 await。
   * 而 iproxy 是个真实子进程，不 kill 掉它会残留并占住 8100 端口，
   * 下次启动时转发起不来，而报错完全看不出是这个原因
   * （用户只会看到「WebDriverAgent 未运行」，方向直接指错）。
   */
  function forceKillForward() {
    const child = forwardProcess;
    forwardProcess = null;
    forwardDeviceId = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch (_) {
      // 进程可能已经退出，kill 失败是正常的
    }
  }

  /** 收掉 9100 转发与本地 MJPEG 代理。同步版，给 `will-quit` 用。 */
  function forceKillMjpeg() {
    const child = mjpegForwardProcess;
    mjpegForwardProcess = null;
    mjpegForwardDeviceId = null;
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (_) { /* 同上 */ }
    }
    const server = mjpegProxyServer;
    mjpegProxyServer = null;
    mjpegProxyDeviceId = null;
    if (server) {
      try { server.close(); } catch (_) { /* 没在监听就算了 */ }
      // 已建立的 MJPEG 长连接不会因为 close() 自动断，得显式销毁 ——
      // 否则退出时端口还被这些连接占着
      try { server.closeAllConnections?.(); } catch (_) { /* 老 Node 没有这个 API */ }
    }
  }

  async function stopPortForward() {
    forceKillForward();
    forceKillMjpeg();
  }

  const isForwarding = () => Boolean(
    (forwardProcess && forwardProcess.exitCode === null)
    || (wdaProcess && wdaProcess.exitCode === null)
  );

  // ==================== 启动 WebDriverAgent 本体 ====================
  //
  // 为什么应用要自己启动它：WDA 必须**在设备上跑着**才有得点，而之前应用只会告诉用户
  // 「用 Xcode 或已签名的 WDA 跑起来」—— 这是把最难的一步甩给用户，等于没给路。
  //
  // 现在改用 `tidevice wdaproxy`：它启动设备上**已安装**的 WDA，并顺带做端口转发，
  // **完全不需要 Xcode**。前提是 WDA 装过一次（见 FEATURE_STATUS 的说明）。
  //
  // 注意：wdaproxy 自己会占 8100 做转发，所以启动它之前必须先把 iproxy 收掉，
  // 否则两个进程抢同一个端口。

  const isWdaRunning = () => Boolean(wdaProcess && wdaProcess.exitCode === null);

  /**
   * 启动设备上的 WDA（并让它接管端口转发）。
   *
   * 返回值是 `{ok, reason, detail}`，失败原因要能区分 ——
   * 「设备上还没装 WDA」和「装了但起不来」的处置完全不同。
   */
  async function startWda(deviceId) {
    if (isWdaRunning()) return { ok: true, reused: true };

    // 已经在别处跑着（用户手动起的、或上次没退出干净）就不重复启动
    const existing = await probeOnce();
    if (existing.reachable) return { ok: true, already: true };

    if (!deviceId) return { ok: false, reason: 'no-device' };

    // wdaproxy 会占 8100，先把 iproxy 收掉免得抢端口
    await stopPortForward();

    let child;
    try {
      child = spawnProcess('tidevice', ['wdaproxy', '--port', String(port)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        // 让它成为进程组组长 —— 退出时才能连带收掉它派生的那个监听进程，
        // 否则 8100 会被残留占用（见 killProcessTree 的说明）
        detached: process.platform !== 'win32'
      });
    } catch (error) {
      return { ok: false, reason: 'spawn-failed', detail: error.message };
    }

    let stderr = '';
    let spawnError = null;
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
    child.once?.('error', (error) => { spawnError = error; });

    wdaProcess = child;
    wdaDeviceId = deviceId;

    // 先给它一点时间失败或开始工作，再看退出码 —— 见 WDA_SPAWN_SETTLE_MS 的说明
    await delay(WDA_SPAWN_SETTLE_MS);

    // 轮询等它真的开始服务 —— WDA 是「拉起测试 runner」，耗时不确定，
    // 用固定 sleep 要么白等要么等不够。
    const deadline = now() + wdaStartTimeout;
    for (;;) {
      if (spawnError) {
        forceKillWda();
        return { ok: false, reason: 'spawn-failed', detail: spawnError.message };
      }

      const code = child.exitCode;
      if (typeof code === 'number' && code !== 0) {
        forceKillWda();
        // 这一条最有价值：tidevice 只启动、不安装，没装过时会报 "No app matches"
        if (/no app matches/i.test(stderr)) {
          return { ok: false, reason: 'wda-not-installed', detail: firstLine(stderr) };
        }
        return { ok: false, reason: 'tidevice-failed', detail: firstLine(stderr) || `退出码 ${code}` };
      }

      const probe = await probeOnce();
      if (probe.reachable) return { ok: true, detail: probe.message };

      if (now() >= deadline) {
        forceKillWda();
        return { ok: false, reason: 'timeout', detail: firstLine(stderr) || probe.message };
      }
      await delay(WDA_POLL_INTERVAL_MS);
    }
  }

  /** 同步收掉 wdaproxy（连同它派生的监听进程）—— 给 `will-quit` 用。 */
  function forceKillWda() {
    const child = wdaProcess;
    wdaProcess = null;
    wdaDeviceId = null;
    killProcessTree(child);
  }

  async function stopWda() {
    forceKillWda();
  }

  /**
   * 会话失效（WDA 重启/被杀）时 WDA 的两种报错形态，实测都出现过：
   * HTTP 404 + `value.message: "Session does not exist"`，或 200 + `value.error`。
   * 统一在这里识别 —— `call()` 打标记，`withSession` 负责重建。
   */
  const SESSION_GONE_RE = /session does not exist|invalid session id/i;

  /** 错误打上这个标记，`withSession` 才会走「重建会话再重试」而不是直接抛给用户。 */
  function markSessionGone(error) {
    error.sessionGone = true;
    return error;
  }

  /**
   * 发一个已经拼好的请求（构造在 `./wda-requests`，端点形状都在那里有实测依据）。
   *
   * 这里只认**完整的请求描述**而不是裸路径，是为了让「端点怎么写」只有一处定义 ——
   * 历史上这里内联拼过路径，和 `src/lib/wdaClient.js` 各写一份，两份都错、
   * 而测试只测了没被使用的另一份。
   */
  async function call(request) {
    const started = Date.now();
    let response;
    try {
      response = await transport(request.url, {
        method: request.method,
        body: request.body,
        timeout
      });
    } catch (transportError) {
      // 网络层失败（连不上 / 超时）也要留痕 —— 这是「请求根本没到 WDA」的场景，
      // 没有这条日志用户会以为 WDA 不响应，其实可能是 USB 转发掉了。
      wdaError(`${request.method} ${shortUrl(request.url)} 失败：${transportError.message}`);
      throw transportError;
    }
    const elapsed = Date.now() - started;
    const parsed = parseResponse(response.text);

    if (response.status >= 400) {
      const message = extractWdaError(parsed, `WDA 返回 ${response.status}`);
      wdaError(
        `${request.method} ${shortUrl(request.url)} -> ${response.status} (${elapsed}ms)`,
        message,
        compactBody(request.body)
      );
      // WDA 重启后旧会话全部 404 —— 只清缓存不重试的话，用户每点一次失败一次，
      // 看起来就像「点击彻底坏了」。标记后交给 withSession 重建。
      if (SESSION_GONE_RE.test(message)) throw markSessionGone(new Error(message));
      throw new Error(message);
    }
    if (parsed && parsed.value && typeof parsed.value === 'object' && parsed.value.error) {
      const errText = extractWdaError(parsed, 'WDA 执行失败');
      // 和 404 分支保持一致：先留请求级日志（自愈时用户也能看到 WDA 原始返回），再判标记
      wdaError(
        `${request.method} ${shortUrl(request.url)} value.error (${elapsed}ms)`,
        errText
      );
      if (SESSION_GONE_RE.test(errText)) throw markSessionGone(new Error(errText));
      throw new Error(errText);
    }
    // 200 也要打：用户验证滑动时最常问的是「请求到底发出去没有」，没日志就只能猜
    wdaLog(
      `${request.method} ${shortUrl(request.url)} -> ${response.status} (${elapsed}ms)`,
      compactBody(request.body)
    );
    return parsed ? parsed.value : null;
  }

  /** 探测一次 WDA，不做任何副作用。 */
  async function probeOnce() {
    try {
      const value = await call(buildWdaStatusRequest(baseUrl));
      return {
        reachable: true,
        baseUrl,
        ready: value?.ready !== false,
        message: value?.message || '',
        // 老版本 WDA 不返回 ready，只要 HTTP 通了就算可用
        device: value?.device || null
      };
    } catch (error) {
      return { reachable: false, baseUrl, ready: false, message: error.message };
    }
  }

  /**
   * WDA 是否在跑。
   *
   * 传了 `deviceId` 且第一次探测不通时，会**自动建立 USB 端口转发再试一次** ——
   * 因为 WDA 监听在设备的 localhost 上，Mac 直连不到，
   * 少了这一步用户会一直看到「WDA 未运行」，即使它其实跑得好好的。
   */
  async function probe(deviceId) {
    const first = await probeOnce();
    if (first.reachable || !deviceId) return first;

    const forward = await ensurePortForward(deviceId);
    if (!forward.ok) {
      return {
        ...first,
        message: `${first.message}；且未能建立端口转发（${describeForwardFailure(forward)}）`
      };
    }

    const second = await probeOnce();
    if (second.reachable) return { ...second, forwarded: true };
    return {
      ...second,
      message: `${second.message}；已建立端口转发，但 ${baseUrl} 仍无响应 —— 请确认设备上的 WebDriverAgent 已启动`
    };
  }

  // in-flight 去重：并发动作同时发现会话失效时，只发一次建会话请求，共享同一个结果
  let sessionPending = null;

  async function ensureSession() {
    if (sessionId) return sessionId;
    if (sessionPending) return sessionPending;

    sessionPending = (async () => {
      const value = await call(buildWdaSessionRequest(baseUrl));
      const id = value?.sessionId || value?.id;
      if (!id) throw new Error('WDA 未返回 sessionId，可能设备未解锁或未信任此电脑');
      sessionId = id;
      return sessionId;
    })();

    try {
      return await sessionPending;
    } finally {
      // 无论成败都清掉 —— 失败时让下一个动作能重试，而不是永久卡在同一个被拒绝的 promise 上
      sessionPending = null;
    }
  }

  async function dropSession() {
    if (!sessionId) {
      await stopPortForward();
      return;
    }
    const id = sessionId;
    sessionId = null;
    screenSize = null;
    try {
      await call(buildWdaDeleteSessionRequest(baseUrl, id));
    } catch (_) {
      // 设备已断开时删会话会失败，本地状态已经清掉就够了
    }
    await stopPortForward();
  }

  /**
   * 启动一个本机 HTTP 代理，把前端的 GET 请求转发到设备的 9100 MJPEG 端点。
   *
   * **为什么不直接让前端连 127.0.0.1:9100**：
   * - Electron `contextIsolation` 下混用主进程端口会引发诡异时序；
   * - 9100 被占或没起来时，代理返回 502 + 明确错误，`<img>` 自然断开，比裸 9100 的 ECONNREFUSED 友好；
   * - 代理层可以一次性关停（`forceKillMjpeg`），不依赖 iproxy 退出码；
   * - 顺便把响应头改成 `multipart/x-mixed-replace`，避免某些代理把流当 chunked 切碎。
   *
   * 端口用 9101 —— 与设备端 9100 同号，避开常见冲突；MJPEG 流量不大，
   * 单客户端一个连接即可，不会撞端口。
   */
  async function startMjpegProxy(deviceId) {
    if (!deviceId) throw new Error('startMjpegProxy 需要 deviceId');
    await ensureMjpegForward(deviceId);
    // 代理与转发一样要校验设备：复用一个属于旧设备的 server，
    // 返回的端口里流的还是旧设备的画面
    if (mjpegProxyServer && mjpegProxyDeviceId === deviceId) {
      return { ok: true, reused: true, port: mjpegProxyServer.address()?.port };
    }
    if (mjpegProxyServer) {
      // 只关旧代理 server —— 9100 转发在上面 ensureMjpegForward 已按新设备换好，
      // 这里再动它等于「杀了刚起的又起一遍」。断开旧 <img> 的连接后前端 onError
      // 会回退截图轮询，但随后的 setMjpegUrl(新地址) 会重新拉起 <img>，
      // 用户只看到一次画面闪动
      const stale = mjpegProxyServer;
      mjpegProxyServer = null;
      mjpegProxyDeviceId = null;
      try { stale.close(); } catch (_) { /* 没在监听就算了 */ }
      try { stale.closeAllConnections?.(); } catch (_) { /* 老 Node 没有这个 API */ }
    }

    const server = http.createServer((req, res) => {
      const upstream = http.request({
        hostname: '127.0.0.1',
        port: MJPEG_DEVICE_PORT,
        path: req.url === '/' ? '/' : req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${MJPEG_DEVICE_PORT}` }
      }, (upstreamRes) => {
        // 跨源 CORS 头：前端 <img crossOrigin="anonymous"> 依赖它。没有这个头，
        // canvas 会被 img 污染，saveFrame 的 toDataURL 直接抛 SecurityError
        res.writeHead(upstreamRes.statusCode || 502, {
          ...upstreamRes.headers,
          'Access-Control-Allow-Origin': '*'
        });
        upstreamRes.on('data', (chunk) => {
          // 客户端已断开就别再写 —— 否则会触发 EPIPE 把代理搞挂
          if (!res.writableEnded) res.write(chunk);
        });
        upstreamRes.on('end', () => {
          if (!res.writableEnded) res.end();
        });
        upstreamRes.on('error', () => {
          if (!res.writableEnded) res.end();
        });
      });
      upstream.on('error', (error) => {
        // 客户端已断开（res 已销毁）时销毁 upstream 也会走到这 ——
        // 那不是上游的错，别刷误导性的错误日志
        if (res.destroyed) return;
        wdaError(`MJPEG 上游连接失败：${error.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (!res.writableEnded) res.end(`MJPEG upstream error: ${error.message}`);
      });
      // 客户端（`<img>`）断开时把上游连接也断了，不然 iproxy 那条 socket 一直挂着。
      // 必须监听 **res** 的 close 而不是 req 的：req 的 'close' 在无 body 的 GET 上
      // 表示「请求已读完」—— 连接刚建立就触发，会把还没应答的上游直接掐死，
      // <img> 一连上就收到 502，整个 MJPEG 通道形同虚设。
      res.on('close', () => {
        upstream.destroy();
      });
      req.pipe(upstream);
  });

  server.on('error', (error) => {
    wdaError(`MJPEG 代理端口启动失败：${error.message}`);
    if (mjpegProxyServer === server) mjpegProxyServer = null;
  });

    // 端口 0 = 让 Node 自选空闲端口；返回给上层方便渲染层拼 URL
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    mjpegProxyServer = server;
    mjpegProxyDeviceId = deviceId;
    return { ok: true, port: server.address()?.port, deviceId };
  }

  async function stopMjpegProxy() {
    forceKillMjpeg();
  }

  /**
   * 取设备逻辑屏幕尺寸（点，不是像素）。
   * 点击坐标必须换算到这个坐标系，否则会偏。
   */
  async function getScreenSize(force = false) {
    if (screenSize && !force) return screenSize;
    const rect = await withSession((id) => call(buildWdaWindowRectRequest(baseUrl, id)));
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    if (!width || !height) throw new Error('WDA 未返回屏幕尺寸');
    screenSize = { width, height };
    return screenSize;
  }

  /**
   * 所有带会话的动作都从这里走 —— 包括会话失效后的自愈。
   *
   * 自愈的关键在**请求必须在 `fn` 内部拼**：`fn` 拿到新 sessionId 才能拼出新 URL。
   * 历史上重试逻辑放在 `call()` 里、复用同一个拼好旧 id 的请求对象，重试注定 404。
   * 只重试一次：WDA 真没了的话（进程死了），重建会话会直接失败，不会死循环。
   */
  const withSession = async (fn) => {
    const id = await ensureSession();
    try {
      return await fn(id);
    } catch (error) {
      if (!error?.sessionGone) throw error;
      wdaError(`会话 ${id} 已失效（WDA 可能重启过），自动重建后重试一次`);
      // 只清自己用过的会话：并发动作里别人可能已经重建出更新的会话，别把它误杀
      if (sessionId === id) sessionId = null;
      const freshId = await ensureSession();
      wdaLog(`新会话 ${freshId} 已建立，重发原请求`);
      return fn(freshId);
    }
  };

  return {
    baseUrl,
    probe,
    ensurePortForward,
    stopPortForward,
    forceKillForward,
    isForwarding,
    startMjpegProxy,
    stopMjpegProxy,
    forceKillMjpeg,
    isMjpegRunning: () => Boolean(mjpegProxyServer || (mjpegForwardProcess && mjpegForwardProcess.exitCode === null)),
    startWda,
    stopWda,
    forceKillWda,
    isWdaRunning,
    getSessionId: () => sessionId,
    ensureSession,
    dropSession,
    getScreenSize,
    isConnected: () => Boolean(sessionId),

    async tap(x, y) {
      // 坐标来自渲染层的「画布点 → 设备点」换算，这一步最容易出偏差；
      // 打出来才能区分「点偏了」和「根本没点到」。
      wdaLog(`tap 坐标=(${x},${y})`);
      return withSession((id) => call(buildWdaTapRequest(baseUrl, id, { x, y })));
    },

    async longPress(x, y, duration = 1) {
      wdaLog(`longPress 坐标=(${x},${y}) duration=${duration}s`);
      return withSession((id) => call(buildWdaLongPressRequest(baseUrl, id, { x, y }, duration)));
    },

    async swipe(from, to, duration) {
      return withSession(async (id) => {
        // 优先用 W3C /actions 序列：带起手停顿 + 多段轨迹，最贴近真实手指，
        // 在 iOS 16/17 上识别率比 dragfromtoforduration 高很多。
        // dragfromtoforduration 在部分 WDA 版本/短距滑动下会被静默忽略，
        // 它作为兜底再试一次 —— 两条实现路径不同，救回来的概率更高。
        wdaLog(
          `swipe 起点=(${from?.x},${from?.y}) 终点=(${to?.x},${to?.y}) duration=${duration ?? '-'}s 会话=${id}`
        );
        try {
          const result = await call(buildWdaActionsDragRequest(baseUrl, id, from, to, duration));
          wdaLog('swipe 走 /actions 首选路径成功');
          return result;
        } catch (actionsError) {
          // 会话死了就别拿同一个死会话去打兜底端点（注定再 404）——
          // 抛给 withSession 重建会话后整个 swipe 会重来一遍
          if (actionsError.sessionGone) throw actionsError;
          wdaError(`swipe /actions 失败（${actionsError.message}），降级到 dragfromtoforduration`);
          try {
            const fallback = await call(buildWdaDragRequest(baseUrl, id, from, to, duration));
            wdaLog('swipe 走 dragfromtoforduration 兜底成功');
            return fallback;
          } catch (fallbackError) {
            wdaError(`swipe 兜底也失败：${fallbackError.message}`);
            // 兜底时会话恰好死了的话，抛带标记的兜底错误 ——
            // 抛 actionsError（无标记）会让 withSession 直接把 500 抛给用户，自愈信号就丢了
            throw fallbackError.sessionGone ? fallbackError : actionsError;
          }
        }
      });
    },

    /**
     * 解锁屏幕。
     *
     * 只能处理「无密码」或「本轮开机后已输过一次密码」的设备 ——
     * XCUITest 被系统禁止向锁屏密码键盘注入触摸，有密码时这条路走不通，
     * 只能在设备上手动输入一次。见 buildWdaUnlockRequest 的说明。
     */
    async unlock() {
      return withSession((id) => call(buildWdaUnlockRequest(baseUrl, id)));
    },

    async typeText(text) {
      return withSession((id) => call(buildWdaTypeRequest(baseUrl, id, text)));
    },

    /**
     * 回到主屏。
     *
     * **不经过会话** —— WDA 里 `/wda/homescreen` 注册为 `.withoutSession`，
     * 拼上 `/session/:id` 会 404。好处是没会话时也能用（例如会话已失效）。
     */
    async pressHome() {
      return call(buildWdaHomeRequest(baseUrl));
    },

    /**
     * 硬件按键（带会话）。
     *
     * `button` 形如 `volumeUp` `volumeDown` `power` `mute`。`home` 也能用，
     * 但优先走 `pressHome()` —— 那条路不带会话、会话失效也能用。
     */
    async pressButton(button) {
      const name = String(button ?? '').trim();
      if (!name) throw new Error('pressButton 需要按键名');
      wdaLog(`pressButton name=${name}`);
      return withSession((id) => call(buildWdaPressButtonRequest(baseUrl, id, name)));
    },

    /**
     * 按方向滑一屏（程序化手势，画布鼠标拖拽做不出来）。
     *
     * 适合「翻页」「下拉刷新」这种不需要精确落点的场景 —— WDA 内部决定
     * 滑动距离。精确拖拽请走 `swipe(from, to)`。
     */
    async swipeDirection(direction) {
      const dir = String(direction ?? '').trim();
      if (!['up', 'down', 'left', 'right'].includes(dir)) {
        throw new Error(`swipeDirection 方向必须是 up/down/left/right，收到 "${direction}"`);
      }
      wdaLog(`swipeDirection direction=${dir}`);
      return withSession((id) => call(buildWdaDirectionalSwipeRequest(baseUrl, id, dir)));
    },

    /**
     * 启动设备上的 App（带会话）。
     *
     * `bundleId` 形如 `com.apple.mobilesafari`。没装时 WDA 直接报错，
     * message 透传给用户（错误形如 `Application with ... not found`）。
     */
    async launchApp(bundleId) {
      const id = String(bundleId ?? '').trim();
      if (!id) throw new Error('launchApp 需要 bundleId');
      wdaLog(`launchApp bundleId=${id}`);
      return withSession((sid) => call(buildWdaAppLaunchRequest(baseUrl, sid, id)));
    },

    /** 结束 App（带会话）。仅杀该 App，不影响系统。 */
    async terminateApp(bundleId) {
      const id = String(bundleId ?? '').trim();
      if (!id) throw new Error('terminateApp 需要 bundleId');
      wdaLog(`terminateApp bundleId=${id}`);
      return withSession((sid) => call(buildWdaAppTerminateRequest(baseUrl, sid, id)));
    },

    /** 查询前台 App（带会话）。返回 `{ bundleId, name, pid }`。 */
    async activeApp() {
      const value = await withSession((id) => call(buildWdaActiveAppRequest(baseUrl, id)));
      // 渲染层只关心 bundleId/name/pid —— 其他字段未来有需要再放开
      if (!value || typeof value !== 'object') return null;
      return {
        bundleId: value.bundleId ?? null,
        name: value.name ?? null,
        pid: value.pid ?? null
      };
    },

    /**
     * 双指缩放（带会话，W3C 双指针 actions）。
     *
     * `mode` 为 `'in'` 放大 / `'out'` 缩小。中心点和间距由调用方按屏幕尺寸给：
     * 中心点一般是屏幕中点，间距取短边的 20% 起步。WDA 没有专用 zoom 端点，
     * 用多指针 actions 等价于真实 pinch 手势 —— 单指跃迁 iOS 识别差，轨迹已拆段。
     */
    async zoom(mode, options = {}) {
      const m = String(mode ?? '').trim();
      if (m !== 'in' && m !== 'out') {
        throw new Error(`zoom 模式必须是 'in' 或 'out'，收到 "${mode}"`);
      }
      const { width, height } = await getScreenSize();
      const shortSide = Math.min(width, height);
      const center = options.center ?? { x: Math.round(width / 2), y: Math.round(height / 2) };
      const startGap = options.startGap ?? Math.round(shortSide * 0.2);
      const endGap = options.endGap ?? Math.round(shortSide * (m === 'in' ? 0.7 : 0.05));
      wdaLog(`zoom mode=${m} center=(${center.x},${center.y}) gap=${startGap}->${endGap}`);
      return withSession((id) => call(buildWdaZoomRequest(baseUrl, id, {
        center,
        startGap,
        endGap,
        duration: options.duration
      })));
    }
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  createIosControl,
  describeForwardFailure,
  describeWdaStartFailure,
  normalizeBaseUrl
};
