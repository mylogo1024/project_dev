import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NO_CAPTURE_DEVICE,
  classifyCaptureError,
  describeCaptureFailure,
  describeScreenshotFailure,
  isRecoverableScreenshotError,
  planCaptureAttempts
} from '../lib/iosCapturePlan';
import { resolveIosControlPlan } from '../lib/iosControlPlan';
import { mapPointerToDevice } from '../lib/wdaClient';
import { appendRecordedStep, buildRecordedScript as buildScript } from '../lib/recordScript';
import { cleanIpcError } from '../lib/errorText';
import AutoPilot from './AutoPilot';

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 10;

const normalizeDevice = (device) => {
  if (typeof device === 'string') return { id: device, label: device, name: device };
  const id = device?.id || device?.deviceId || device?.udid || '';
  return {
    ...device,
    id,
    name: device?.name || device?.label || id,
    label: device?.label || device?.name || device?.displayName || id
  };
};

/** 把任意可绘制对象按旋转角度画到 canvas 并导出 PNG。 */
const renderRotated = (source, sourceW, sourceH, rotation) => {
  const rotated = rotation % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = rotated ? sourceH : sourceW;
  canvas.height = rotated ? sourceW : sourceH;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -sourceW / 2, -sourceH / 2);
  return canvas.toDataURL('image/png');
};

const captureVideoFrame = (video, rotation = 0) => {
  if (!video || !video.videoWidth) throw new Error('还没有可用画面');
  return renderRotated(video, video.videoWidth, video.videoHeight, rotation);
};

/** 先解码再换 src，避免每帧之间闪一下空白；顺带拿到画面原始尺寸。 */
const decodeImage = (dataUrl) => new Promise((resolve) => {
  const image = new Image();
  image.onload = () => resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => resolve({ dataUrl, width: 0, height: 0 });
  image.src = dataUrl;
});

const rotateDataUrl = (dataUrl, rotation) => new Promise((resolve, reject) => {
  if (!rotation) {
    resolve(dataUrl);
    return;
  }
  const image = new Image();
  image.onload = () => resolve(renderRotated(image, image.naturalWidth, image.naturalHeight, rotation));
  image.onerror = () => reject(new Error('画面解码失败'));
  image.src = dataUrl;
});

const clampZoom = (value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));

function IosMirror({ embedded = false, initialDevice = null }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const stageRef = useRef(null);
  const wrapRef = useRef(null);
  // tickNow：轮询循环的「立即执行下一帧」入口，操作设备后用它加速反馈
  const loopRef = useRef({ id: 0, timer: 0, tickNow: null });
  const failCountRef = useRef(0);
  // 截图轮询正常时的基线提示，失败报错恢复后要退回它
  const baselineRef = useRef(null);
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice?.id || '');
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState('auto');
  const [caps, setCaps] = useState({ platform: '', liveCapture: false, screenshot: false });
  const [hostCameras, setHostCameras] = useState([]);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [snapshot, setSnapshot] = useState('');
  // MJPEG 实时流的本地代理 URL（multipart/x-mixed-replace 由 <img> 原生消费）
  const [mjpegUrl, setMjpegUrl] = useState('');
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(100);
  const [landscape, setLandscape] = useState(false);
  const [controlTools, setControlTools] = useState(null);

  const selected = devices.find((item) => item.id === selectedDevice);
  const rotation = landscape ? 90 : 0;
  // 竖屏时手机是窄高图，把控制区放到左侧，画面区就能拿到全部高度；
  // 横屏时画面本来就是宽的，沿用「控制在上、画面在下」更省地方。
  const sideLayout = !landscape;

  // 探测这台机器装了哪些 iOS 控制后端。判定逻辑在 iosControlPlan 里（纯函数），
  // 这里只负责把「设备版本 + 工具 + 运行状态」喂进去。
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.detectIosControlTools?.()
      .then((data) => { if (!cancelled) setControlTools(data); })
      .catch(() => { if (!cancelled) setControlTools({ platform: '', tools: {} }); });
    return () => { cancelled = true; };
  }, []);

  // PC 点击操控（WebDriverAgent）的状态。**必须声明在 controlPlan 之前** ——
  // controlPlan 要用它判断 WDA 到底跑没跑。
  const [control, setControl] = useState({ enabled: false, available: false, baseUrl: '', message: '', screen: null });
  const [wdaBusy, setWdaBusy] = useState(false);
  const [wdaMessage, setWdaMessage] = useState('');
  const pointerRef = useRef(null);
  // 双击自判定：用 click 间隔代替浏览器原生 dblclick（macOS 系统级判定 500ms，
  // 体感卡顿明显）。350ms 内连续两次 click 视为双击，立即响应。
  const lastStageClickRef = useRef({ at: 0, x: 0, y: 0 });
  // ---------- 操作录制（→ 无人值守脚本） ----------
  // 把人在投屏上的真实操作记下来，一键转成 autopilot 脚本。详见 AutoPilot 组件注释。
  const [recording, setRecording] = useState(false);
  const recordRef = useRef({ steps: [], lastAt: 0 });
  const [recordedCount, setRecordedCount] = useState(0);

  /**
   * 记一步。规则全在 lib/recordScript.js（间隔折算 wait、步数上限、非法形状拒绝），
   * 这里只管「何时记」：录制开着 + 动作真的发到了设备上。
   */
  const recordStep = useCallback((step) => {
    if (!recording) return;
    const now = Date.now();
    const record = recordRef.current;
    const gap = record.lastAt ? now - record.lastAt : 0;
    record.steps = appendRecordedStep(record.steps, step, gap);
    record.lastAt = now;
    setRecordedCount(record.steps.length);
  }, [recording]);

  const clearRecording = useCallback(() => {
    recordRef.current = { steps: [], lastAt: 0 };
    setRecordedCount(0);
  }, []);

  const toggleRecording = useCallback(() => {
    setRecording((current) => {
      if (!current) clearRecording();
      return !current;
    });
  }, [clearRecording]);

  /**
   * 导出录制结果为 autopilot 脚本（AutoPilot 面板消费）。
   * 空录制返回 null —— 面板拿 null 自己提示，规则在 lib 里。
   */
  const buildRecordedScript = useCallback(() => (
    buildScript(recordRef.current.steps, { deviceId: selectedDevice })
  ), [selectedDevice]);

  const controlPlan = useMemo(() => {
    if (!controlTools) return null;
    return resolveIosControlPlan({
      iosVersion: selected?.version || selected?.iosVersion || '',
      deviceConnected: Boolean(selected),
      platform: controlTools.platform,
      tools: controlTools.tools,
      state: {
        streamRunning: running,
        // 这里以前写死成 false，导致即使 WDA 连上了状态条也一直说「未运行」。
        // 控制通道建起来（control.enabled）就代表 WDA 确实在服务。
        wdaRunning: control.enabled,
        tunnelUp: false,
        ddiMounted: false
      }
    });
  }, [controlTools, selected, running, control.enabled]);

  /**
   * 该不该给「启动 WebDriverAgent」按钮。
   *
   * 只在「WDA 没跑」且「本机能拉起它」时给 —— 缺 tidevice 时给按钮只会让人反复点，
   * 那种情况该显示的是安装指引。
   */
  const needsWdaStart = Boolean(
    controlPlan
    && !controlPlan.canControl
    && controlPlan.blockers.some((item) => item.code === 'wda-not-running')
    && controlTools?.tools?.tidevice
  );

  // ---------- PC 点击操控（WebDriverAgent） ----------
  // 画面上点一下 = 设备上点一下。坐标必须换算到设备逻辑坐标，见 lib/wdaClient 的说明。

  const connectControl = async () => {
    setControl((current) => ({ ...current, message: '正在连接 WebDriverAgent…' }));
    try {
      const probe = await window.electronAPI.iosControlProbe({ deviceId: selectedDevice });
      if (!probe?.reachable) {
        setControl({
          enabled: false,
          available: false,
          baseUrl: probe?.baseUrl || '',
          message: probe?.message || 'WebDriverAgent 未运行，无法操控设备',
          screen: null
        });
        return;
      }
      const size = await window.electronAPI.iosControlScreen();

      // 无人值守的关键一步：远程时人不在设备前，屏幕锁了就什么都点不了。
      // 无密码（或本轮已输过密码）的设备可以直接唤醒解锁；有密码的设备
      // 系统禁止注入密码键盘，只能在设备上手动输一次 —— 这必须明确告诉用户。
      let unlockNote = '';
      let unlockWarn = '';
      try {
        const lock = await window.electronAPI.iosControlLockState?.({ deviceId: selectedDevice });
        if (lock?.locked) {
          try {
            await window.electronAPI.iosControlUnlock?.();
            unlockNote = '设备已自动解锁';
          } catch (unlockError) {
            unlockWarn = '检测到设备已锁屏且可能有密码，远程无法输入锁屏密码，请在设备上手动输入一次后再操作。';
          }
        }
      } catch (_) {
        // 查询锁屏状态失败时不阻断连接，继续后续流程
      }

      setControl({
        enabled: true,
        available: true,
        baseUrl: probe.baseUrl,
        message: '',
        screen: size,
        unlocked: Boolean(unlockNote),
        unlockWarning: unlockWarn
      });
    } catch (error) {
      setControl({
        enabled: false,
        available: false,
        baseUrl: '',
        message: cleanIpcError(error, '连接 WebDriverAgent 失败'),
        screen: null
      });
    }
  };

  const disconnectControl = async () => {
    pointerRef.current = null;
    setControl({ enabled: false, available: false, baseUrl: '', message: '', screen: null });
    try {
      await window.electronAPI.iosControlDisconnect?.();
    } catch (_) {
      // 设备已断开时释放会话会失败，本地状态清掉就够了
    }
  };

  /**
   * 设备动作的统一封装：失败要可见（不能藏在 console 里）。
   *
   * 这些动作（按键 / 方向滑 / 启动 App / 缩放）失败时大多数情况都是
   * 设备状态没准备好（锁屏 / 应用闪退 / WDA 会话刚好失效），
   * 把 message 直接接在控制提示栏，比弹 alert 更不打断操作流。
   *
   * `step`（可选）：录制模式下成功后把这一步记进脚本 —— 按钮触发的动作
   * 和画面手势一样是「真实操作」，重放时必须能还原。
   */
  const sendDeviceCommand = async (label, run, step) => {
    if (!control.enabled) {
      setControl((current) => ({ ...current, message: '请先连接 WDA 再操作设备' }));
      return;
    }
    try {
      await run();
      if (step) recordStep(step);
    } catch (error) {
      const message = cleanIpcError(error, `${label}失败`);
      setControl((current) => ({ ...current, enabled: current.enabled, message }));
    }
  };

  /**
   * 让应用自己把设备上的 WebDriverAgent 拉起来。
   *
   * 这一步之前是缺的：应用只会说「用 Xcode 或已签名的 WDA 跑起来」，
   * 等于把最难的一步甩给用户。现在用 tidevice（免 Xcode）代劳，
   * 启动成功后自动接着连 —— 用户只需要点一下。
   */
  const startWda = async () => {
    setWdaBusy(true);
    setWdaMessage('');
    try {
      await window.electronAPI.iosControlStartWda({ deviceId: selectedDevice });
      setWdaMessage('');
      await connectControl();
    } catch (error) {
      setWdaMessage(cleanIpcError(error, '启动 WebDriverAgent 失败'));
    } finally {
      setWdaBusy(false);
    }
  };

  /**
   * 把画面上的指针位置换算成设备逻辑坐标。
   *
   * `clamp`：滑动终点经常落在画面边缘之外（滑出边界是自然手势），
   * 此时要把坐标钳回画面边缘再发，而不是丢弃手势 —— 点击仍用严格模式。
   */
  const toDevicePoint = (event, { clamp = false } = {}) => {
    const mediaWidth = canvas?.mediaWidth;
    const mediaHeight = canvas?.mediaHeight;
    if (!mediaWidth || !mediaHeight || !control.screen) return null;

    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    // 横屏时媒体元素被旋转了 90°，指针位置要先转回「未旋转」的媒体坐标系
    const pointerX = landscape ? py : px;
    const pointerY = landscape ? mediaHeight - px : py;

    return mapPointerToDevice({
      pointerX,
      pointerY,
      viewWidth: mediaWidth,
      viewHeight: mediaHeight,
      deviceWidth: control.screen.width,
      deviceHeight: control.screen.height
    }, { clamp });
  };

  const onControlPointerDown = (event) => {
    if (!control.enabled) {
      console.log('[mirror] pointerdown 被忽略：控制未连接（需要重新点「点击操控」）');
      return;
    }
    const point = toDevicePoint(event);
    if (!point) {
      console.log('[mirror] pointerdown 被忽略：坐标映射失败（画面尺寸或屏幕尺寸缺失）');
      return;
    }
    console.log(`[mirror] pointerdown 设备坐标=(${point.x},${point.y})`);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerRef.current = { ...point, moved: false };
  };

  const onControlPointerMove = (event) => {
    if (!control.enabled || !pointerRef.current) return;
    // 移动过程允许出画（钳制），否则把列表滑到底时手势会被中途丢弃
    const point = toDevicePoint(event, { clamp: true });
    if (!point) return;
    // 超过阈值才算滑动，避免手抖把点击变成滑动
    if (Math.hypot(point.x - pointerRef.current.x, point.y - pointerRef.current.y) > 12) {
      if (!pointerRef.current.moved) console.log(`[mirror] pointermove 越过滑动阈值，设备坐标=(${point.x},${point.y})`);
      pointerRef.current.moved = true;
      pointerRef.current.last = point;
    }
  };

  const onControlPointerUp = async (event) => {
    if (!control.enabled || !pointerRef.current) return;
    const start = pointerRef.current;
    pointerRef.current = null;

    // 操作完让轮询循环立即截一帧 —— 用户刚做完动作，等一帧的画面
    // 比「下一轮截图」要快 600~1000ms，体感差别非常明显
    const tickNow = loopRef.current.tickNow;
    const nudgePolling = () => {
      if (mode !== 'screenshot' || !loopRef.current.timer || !tickNow) return;
      window.clearTimeout(loopRef.current.timer);
      loopRef.current.timer = window.setTimeout(tickNow, 0);
    };

    if (start.moved) {
      // 滑动终点同样允许出画；指针已经在画布外抬起时（clientX 为画布外坐标）
      // 用 move 阶段记录的最后一个画布内位置兜底，避免手势被整个丢掉
      const endPoint = toDevicePoint(event, { clamp: true })
        || start.last
        || { x: start.x, y: start.y };
      // 时长跟距离走：短滑给 0.4s（低于这个值 iOS 容易当成 fling 甩动，滚动量丢失），
      // 长滑按距离线性放大并封顶 1.1s（太快会被当成甩动，太慢会变成拖拽）。
      // 下限从 0.35 提到 0.4 —— 短滑「时灵时不灵」的主因就是时长不够，系统判成点击/甩动。
      const distance = Math.hypot(endPoint.x - start.x, endPoint.y - start.y);
      const duration = Math.min(1.1, Math.max(0.4, distance / 1000));
      console.log(`[mirror] 发起 swipe：起点=(${start.x},${start.y}) 终点=(${endPoint.x},${endPoint.y}) 距离=${Math.round(distance)}`);
      try {
        await window.electronAPI.iosControlSwipe({
          from: { x: start.x, y: start.y },
          to: { x: endPoint.x, y: endPoint.y },
          duration
        });
        recordStep({
          op: 'swipe',
          from: { x: Math.round(start.x), y: Math.round(start.y) },
          to: { x: Math.round(endPoint.x), y: Math.round(endPoint.y) },
          duration: Math.round(duration * 1000) / 1000
        });
        nudgePolling();
      } catch (error) {
        setControl((current) => ({ ...current, message: cleanIpcError(error, '操作设备失败') }));
      }
      return;
    }

    const end = toDevicePoint(event);
    if (!end) {
      console.log('[mirror] tap 被忽略：抬手坐标映射失败');
      return;
    }
    console.log(`[mirror] 发起 tap：设备坐标=(${end.x},${end.y})`);
    try {
      await window.electronAPI.iosControlTap({ x: end.x, y: end.y });
      recordStep({ op: 'tap', x: Math.round(end.x), y: Math.round(end.y) });
      nudgePolling();
    } catch (error) {
      setControl((current) => ({ ...current, message: cleanIpcError(error, '操作设备失败') }));
    }
  };

  const stopStream = useCallback(() => {
    loopRef.current.id += 1;
    loopRef.current.tickNow = null;
    failCountRef.current = 0;
    baselineRef.current = null;
    if (loopRef.current.timer) {
      window.clearTimeout(loopRef.current.timer);
      loopRef.current.timer = 0;
    }
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setSnapshot('');
    setNatural({ width: 0, height: 0 });
    setRunning(false);
    setMode('');
    // MJPEG 流是同一台代理服务的，关掉本端连接 → 主进程那边客户端断 →
    // 同步关掉本轮 ref/new/replace 长连接；再次打开由 start() 重启
    setMjpegUrl('');
    // 关 fire-and-forget；startMjpegProxy 已经处理了重建场景
    window.electronAPI.iosControlStopMjpeg?.().catch(() => {});
    // 同步重置缩放 + 清空双击计数，避免关闭后点 stage 仍触发 zoom 切换的残留感
    setZoom(100);
    lastStageClickRef.current = { at: 0, x: 0, y: 0 };
  }, []);

  const loadDevices = useCallback(async () => {
    setDeviceLoading(true);
    try {
      const result = await window.electronAPI.getLogDevices('ios');
      const raw = Array.isArray(result) ? result : result?.devices;
      const next = (Array.isArray(raw) ? raw : []).map(normalizeDevice).filter((item) => item.id);
      setDevices(next);
      setSelectedDevice((current) => (
        next.some((item) => item.id === current) ? current : (next[0]?.id || '')
      ));
      if (!next.length) {
        setMessage({ type: 'warning', text: '未检测到 iPhone。请用 USB 连接、解锁，并点「信任此电脑」。' });
      } else {
        setMessage(null);
      }
    } catch (error) {
      setDevices([]);
      setSelectedDevice('');
      setMessage({ type: 'error', text: cleanIpcError(error, '获取 iPhone 失败') });
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameras([]);
      return [];
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all
      .filter((item) => item.kind === 'videoinput' && item.deviceId)
      .map((item) => ({ deviceId: item.deviceId, label: item.label || '未命名采集设备' }));
    setCameras(inputs);
    return inputs;
  }, []);

  // 主进程侧的本机摄像头清单（system_profiler），用来判断「这台机器到底有没有采集设备」
  const loadHostCameras = useCallback(async () => {
    try {
      const list = await window.electronAPI.listIosMirrorCameras?.();
      const next = Array.isArray(list) ? list : [];
      setHostCameras(next);
      return next;
    } catch (_) {
      setHostCameras([]);
      return [];
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadHostCameras();
    window.electronAPI.getIosMirrorCapabilities?.().then((next) => {
      if (next) setCaps(next);
    }).catch(() => {});
    return () => stopStream();
  }, [loadDevices, loadHostCameras, stopStream]);

  // 舞台尺寸变化时重算画面尺寸，保证「适应窗口」始终贴合。
  // 观察外层 wrapper 而不是 stage 本身：stage 是 overflow:auto，
  // 放大后滚动条出现会改变它的内容盒，进而反复重算，让 200% 变成 194% 之类的怪值。
  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setStageSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [sideLayout]);

  // 只用来让 label 变得可见；失败不算致命，真正的判断交给 startLive
  const warmupCamera = async () => {
    try {
      const warmup = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      warmup.getTracks().forEach((track) => track.stop());
    } catch (_) {
      /* 拿不到 label 也继续，deviceId 依然可用 */
    }
  };

  const startLive = async (inputs, deviceName) => {
    const candidates = planCaptureAttempts(inputs, deviceName, cameraId === 'auto' ? '' : cameraId);
    if (!candidates.length) {
      const error = new Error('没有可用的采集设备');
      error.name = 'NotFoundError';
      throw error;
    }

    let lastError = null;
    for (const deviceId of candidates) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setMode('live');
        setRunning(true);
        setSnapshot('');
        setNatural({
          width: videoRef.current?.videoWidth || 0,
          height: videoRef.current?.videoHeight || 0
        });
        setMessage({ type: 'success', text: '已开始实时画面。未越狱 iPhone 无法像 Android 那样用鼠标点击控制。' });
        return;
      } catch (error) {
        lastError = error;
        // 继续尝试下一个候选
      }
    }
    throw lastError || new Error('无法启动摄像头采集');
  };

  /**
   * MJPEG 实时流：从 WDA 内置的 9100 端点拿流，浏览器用 <img> 原生消费。
   *
   * **为什么放在 live / screenshot 之前**：这是从 WDA 设备侧取的真正实时流，
   * 比 USB 摄像头采集稳（不依赖 QuickTime 占用摄像头权限），比截图轮询快
   * （30fps vs 1fps）。失败就静默退化到下一种 —— 不能因为 MJPEG 通道
   * 起来慢就卡住 start。
   *
   * **为什么不需要轮询**：<img> 拿 multipart 流后浏览器持续解码，
   * 每一帧都是推送过来的，组件这边只负责设置 src / 监听 load error。
   */
  const startMjpeg = async () => {
    const result = await window.electronAPI.iosControlStartMjpeg?.({ deviceId: selectedDevice });
    if (!result?.ok || !result?.port) {
      throw new Error(result?.message || 'MJPEG 代理启动失败');
    }
    // 给一个 cache buster，避免上一轮 stopStream 之后 <img> 复用旧 src
    const url = `http://127.0.0.1:${result.port}/?t=${Date.now()}`;
    setMjpegUrl(url);
    setMode('mjpeg');
    setRunning(true);
    setSnapshot('');
    setNatural({ width: 0, height: 0 });
    setMessage({ type: 'success', text: '已启用 WDA MJPEG 实时流（设备端 ~30fps）。' });
  };

  // 截图轮询：不用 setInterval，避免上一张还没截完就叠下一次
  const startScreenshotLoop = async (deviceId) => {
    const runId = loopRef.current.id + 1;
    loopRef.current.id = runId;
    failCountRef.current = 0;
    setMode('screenshot');
    setRunning(true);

    // 失败时查一次设备还在不在，用来区分「拔了」和「锁屏 / 链路抖动」
    const reportFailure = async (error) => {
      if (!isRecoverableScreenshotError(error)) {
        setMessage({ type: 'error', text: cleanIpcError(error, '截图失败') });
        return;
      }
      let connected = null;
      try {
        const state = await window.electronAPI.getIosMirrorDeviceState?.(deviceId);
        if (state) connected = Boolean(state.connected);
      } catch (_) {
        /* 探测失败就按「锁屏 / 链路抖动」提示 */
      }
      setMessage({ type: 'error', text: describeScreenshotFailure(connected) });
    };

    const tick = async () => {
      if (loopRef.current.id !== runId) return;
      let ok = false;
      try {
        const shot = await window.electronAPI.takeIosMirrorScreenshot(deviceId);
        if (loopRef.current.id !== runId) return;
        if (shot?.dataUrl) {
          const frame = await decodeImage(shot.dataUrl);
          if (loopRef.current.id !== runId) return;
          setSnapshot(frame.dataUrl);
          if (frame.width && frame.height) setNatural({ width: frame.width, height: frame.height });
          ok = true;
        }
      } catch (error) {
        if (loopRef.current.id !== runId) return;
        failCountRef.current += 1;
        // 只在第一次失败时报一次，别每帧刷一条同样的错
        if (failCountRef.current === 1) reportFailure(error);
      }
      if (loopRef.current.id !== runId) return;

      if (ok) {
        // 恢复了：退回到基线说明（可能是「已改用截图刷新」，也可能是没有提示），回到正常节奏
        failCountRef.current = 0;
        setMessage((current) => (current?.type === 'error' ? baselineRef.current : current));
      }

      const backoff = failCountRef.current === 0
        ? 0
        : Math.min(3000, 500 * 2 ** Math.min(failCountRef.current, 3));
      // idevicescreenshot 单张本身就要 0.6~1s，加上 base64 + IPC 已经够慢；
      // 这里不要人为等间隔，立即排下一张就行 —— 上一张的解码/渲染会
      // 与下一张的获取并行，整体节奏接近「截图本身耗时 + 一帧渲染耗时」，
      // 再叠 backoff 应付锁屏/拔线场景
      loopRef.current.timer = window.setTimeout(tick, backoff);
    };

    await tick();
    // 把 tick 暴露出去，操作设备时可以「插队」下一帧，避免等满一个轮询间隔
    loopRef.current.tickNow = tick;
  };

  const start = async () => {
    if (!selectedDevice) {
      setMessage({ type: 'error', text: '请先选择 iPhone' });
      return;
    }
    setBusy(true);
    setMessage(null);
    stopStream();
    setZoom(100);
    try {
      // 最高优先级：WDA 的 MJPEG 实时流（设备端直出，~30fps）。
      // 失败不阻塞 —— 继续走下面的 USB 采集 / 截图轮询，用户永远有画面可看。
      try {
        await startMjpeg();
        return;
      } catch (mjpegError) {
        console.log(`[mirror] MJPEG 实时流不可用，继续走后续通道：${mjpegError.message}`);
      }

      let liveError = null;

      if (!caps.liveCapture) {
        liveError = new Error('iPhone 实时画面目前仅支持 macOS USB 采集。');
      } else if (!navigator.mediaDevices?.getUserMedia) {
        liveError = new Error('当前环境不支持摄像头采集。');
      } else {
        const inputs = await refreshCameras().catch(() => []);
        const hostList = hostCameras.length ? hostCameras : await loadHostCameras();

        if (!inputs.length) {
          // 本机一个采集设备都没有：直接走截图，不再弹无意义的摄像头授权
          liveError = new Error('本机没有可用的视频采集设备');
          liveError.name = 'NotFoundError';
          if (!hostList.length) liveError.hostHasNoCamera = true;
        } else {
          const access = await window.electronAPI.requestIosMirrorAccess?.();
          if (access && access.granted === false) {
            const denied = new Error('没有摄像头权限');
            denied.name = 'NotAllowedError';
            liveError = denied;
          } else {
            await warmupCamera();
            // 授权之后 label 才会变成真实设备名，重新枚举一次再做匹配
            const labelled = await refreshCameras().catch(() => inputs);
            try {
              await startLive(labelled.length ? labelled : inputs, selected?.name || selected?.label);
              return;
            } catch (error) {
              liveError = error;
              stopStream();
            }
          }
        }
      }

      if (!caps.screenshot) {
        throw liveError || new Error('没有可用的 iPhone 画面源');
      }

      // 先把「已改用截图刷新」这类基线说明放上去，再启动轮询。
      // 顺序很重要：轮询的第一次 tick 会在自己的 await 里就写好失败提示，
      // 如果这里晚一步再 setMessage，就会把那条报错覆盖掉（踩过这个坑）。
      if (liveError) {
        const kind = classifyCaptureError(liveError);
        const hasCaptureDevice = !(kind === NO_CAPTURE_DEVICE && liveError.hostHasNoCamera);
        // 顶部状态条已经说明「本机没有采集设备」时不再重复
        baselineRef.current = hasCaptureDevice
          ? { type: 'warning', text: describeCaptureFailure(kind, { hasCaptureDevice, screenshotAvailable: true }) }
          : null;
      } else {
        baselineRef.current = { type: 'warning', text: '当前用截图刷新（实测约 1 帧/秒），不是 USB 实时采集。' };
      }
      setMessage(baselineRef.current);

      await startScreenshotLoop(selectedDevice);
    } catch (error) {
      stopStream();
      setMessage({ type: 'error', text: cleanIpcError(error, '无法开始投屏') });
    } finally {
      setBusy(false);
    }
  };

  const saveFrame = async () => {
    try {
      let dataUrl = '';
      if (mode === 'live') {
        dataUrl = captureVideoFrame(videoRef.current, rotation);
      } else if (mode === 'mjpeg') {
        // MJPEG 是 <img>，videoWidth 不存在 —— 取 naturalWidth/Height
        const img = document.querySelector('.ios-mirror-canvas img[alt="iPhone 实时画面"]');
        if (!img?.naturalWidth) throw new Error('还没有可用画面');
        dataUrl = renderRotated(img, img.naturalWidth, img.naturalHeight, rotation);
      } else {
        dataUrl = await rotateDataUrl(snapshot, rotation);
      }
      if (!dataUrl) throw new Error('还没有可用画面');
      const filePath = await window.electronAPI.saveFile({
        defaultPath: `iphone-${Date.now()}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      });
      if (!filePath) return;
      await window.electronAPI.saveIosMirrorFrame(filePath, dataUrl);
      setMessage({ type: 'success', text: `画面已保存到 ${filePath}` });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '保存失败') });
    }
  };

  const toggleFullscreen = () => {
    const node = stageRef.current;
    if (!node?.requestFullscreen) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else node.requestFullscreen();
  };

  const setZoomBy = (delta) => setZoom((current) => clampZoom(current + delta));

  // 双击缩放：用 click 间隔自判定（350ms + 10px），绕过 macOS 系统级 dblclick
  // （默认 500ms，体感卡顿）。注意：不再依赖 React 的 onDoubleClick。
  const onStageClick = (event) => {
    if (!running || busy) return;
    const now = Date.now();
    const last = lastStageClickRef.current;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    if (now - last.at < 350 && Math.hypot(dx, dy) <= 10) {
      lastStageClickRef.current = { at: 0, x: 0, y: 0 };
      setZoom((current) => (current === 100 ? 200 : 100));
      return;
    }
    lastStageClickRef.current = { at: now, x: event.clientX, y: event.clientY };
  };

  // 画面显示尺寸：先按原始宽高比适应舞台，再乘以缩放倍数；横屏时宽高互换
  const canvas = useMemo(() => {
    const rawW = natural.width || 9;
    const rawH = natural.height || 16;
    const shownW = landscape ? rawH : rawW;
    const shownH = landscape ? rawW : rawH;
    if (!stageSize.width || !stageSize.height) return null;
    const fit = Math.min(stageSize.width / shownW, stageSize.height / shownH);
    const scale = fit * (zoom / 100);
    // 元素自身要按「未旋转」的宽高给盒子，再用 rotate 转过去，否则会被拉变形
    return {
      width: Math.max(40, Math.round(shownW * scale)),
      height: Math.max(40, Math.round(shownH * scale)),
      mediaWidth: Math.max(40, Math.round((landscape ? shownH : shownW) * scale)),
      mediaHeight: Math.max(40, Math.round((landscape ? shownW : shownH) * scale))
    };
  }, [natural, landscape, zoom, stageSize]);

  const hostCameraNames = hostCameras.map((item) => item.name).filter(Boolean);
  const noHostCamera = caps.liveCapture && hostCameras.length === 0;
  // 顶部只保留一条状态：没有采集设备时说明原因，否则显示本次操作的结果
  const statusLine = message
    || (noHostCamera
      ? { type: 'warning', text: '本机没有摄像头等采集设备，无法建立 USB 实时画面通道，已改用截图刷新（约 1 帧/秒）。' }
      : (!caps.liveCapture && !embedded
        ? { type: 'warning', text: '当前系统不能做 USB 实时采集，请在 Mac 上使用本功能。' }
        : (caps.liveCapture && hostCameraNames.length
          ? { type: 'success', text: `可用采集设备：${hostCameraNames.join('、')}` }
          : null)));

  // ---------- 可复用的控件片段（竖屏放左侧栏，横屏放顶部一行）----------
  const devicePicker = (
    <>
      <select
        className="ios-mirror-select"
        value={selectedDevice}
        onChange={(event) => setSelectedDevice(event.target.value)}
        disabled={deviceLoading || devices.length === 0 || running}
        title="选择要投屏的 iPhone"
      >
        {devices.length === 0 ? (
          <option value="">{deviceLoading ? '正在检测…' : '未检测到 iPhone'}</option>
        ) : (
          devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.version ? `${device.label} · iOS ${device.version}` : device.label}
            </option>
          ))
        )}
      </select>
      <button className="btn btn-secondary btn-sm" onClick={loadDevices} disabled={deviceLoading || running}>
        {deviceLoading ? '检测中…' : '刷新设备'}
      </button>
      <select
        className="ios-mirror-select"
        value={cameraId}
        onChange={(event) => setCameraId(event.target.value)}
        disabled={running}
        title="选择画面来源"
      >
        <option value="auto">自动匹配 iPhone</option>
        {cameras.length === 0 ? (
          <option value="" disabled>本机没有可用的采集设备</option>
        ) : (
          cameras.map((item) => (
            <option key={item.deviceId} value={item.deviceId}>{item.label}</option>
          ))
        )}
      </select>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => { refreshCameras(); loadHostCameras(); }}
        disabled={running}
      >
        刷新画面源
      </button>
    </>
  );

  const primaryActions = (
    <>
      {running ? (
        <button className="btn btn-danger btn-sm" onClick={stopStream} disabled={busy}>停止投屏</button>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={start} disabled={busy || !selectedDevice}>
          {busy ? '启动中…' : '开始实时显示'}
        </button>
      )}
      <button className="btn btn-secondary btn-sm" onClick={saveFrame} disabled={!running}>保存画面</button>
      <button className="btn btn-secondary btn-sm" onClick={toggleFullscreen} disabled={!running}>全屏</button>
      {control.enabled ? (
        <>
          <button className="btn btn-danger btn-sm" onClick={disconnectControl}>停止操控</button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => sendDeviceCommand('主屏', () => window.electronAPI.iosControlHome?.(), { op: 'pressHome' })}
          >
            主屏
          </button>
        </>
      ) : (
        <button className="btn btn-secondary btn-sm" onClick={connectControl} disabled={!running}>点击操控</button>
      )}
    </>
  );

  /**
   * 设备动作工具栏：按键 / 方向滑 / App 启动 / 双指缩放。
   *
   * **只在控制通道已建好的情况下渲染**：未连 WDA 时这些按钮毫无意义，
   * 还容易让用户以为点错了。放在 `primaryActions` 之后，视觉上紧跟
   * 「点击操控」按钮，避免远端操控功能被遮挡。
   */
  const deviceActions = control.enabled ? (
    <div className="ios-mirror-device-actions">
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => sendDeviceCommand('音量+', () => window.electronAPI.iosControlPressButton?.({ button: 'volumeUp' }), { op: 'pressButton', button: 'volumeUp' })}
        title="设备音量上调"
      >
        音量+
      </button>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => sendDeviceCommand('音量-', () => window.electronAPI.iosControlPressButton?.({ button: 'volumeDown' }), { op: 'pressButton', button: 'volumeDown' })}
        title="设备音量下调"
      >
        音量-
      </button>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => sendDeviceCommand('锁屏', () => window.electronAPI.iosControlPressButton?.({ button: 'power' }), { op: 'pressButton', button: 'power' })}
        title="模拟电源键（锁屏或唤醒）"
      >
        锁屏
      </button>
      <span className="ios-mirror-seg" title="按方向滑一屏：WDA 内部决定滑动距离">
        <button
          type="button"
          className="ios-mirror-seg__btn"
          onClick={() => sendDeviceCommand('向上滑', () => window.electronAPI.iosControlSwipeDirection?.({ direction: 'up' }), { op: 'swipeDirection', direction: 'up' })}
          title="向上滑一屏（适合翻页 / 下拉刷新）"
        >
          ↑
        </button>
        <button
          type="button"
          className="ios-mirror-seg__btn"
          onClick={() => sendDeviceCommand('向下滑', () => window.electronAPI.iosControlSwipeDirection?.({ direction: 'down' }), { op: 'swipeDirection', direction: 'down' })}
          title="向下滑一屏"
        >
          ↓
        </button>
        <button
          type="button"
          className="ios-mirror-seg__btn"
          onClick={() => sendDeviceCommand('向左滑', () => window.electronAPI.iosControlSwipeDirection?.({ direction: 'left' }), { op: 'swipeDirection', direction: 'left' })}
          title="向左滑一屏"
        >
          ←
        </button>
        <button
          type="button"
          className="ios-mirror-seg__btn"
          onClick={() => sendDeviceCommand('向右滑', () => window.electronAPI.iosControlSwipeDirection?.({ direction: 'right' }), { op: 'swipeDirection', direction: 'right' })}
          title="向右滑一屏"
        >
          →
        </button>
      </span>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => sendDeviceCommand('启动 Safari', () => window.electronAPI.iosControlLaunchApp?.({ bundleId: 'com.apple.mobilesafari' }), { op: 'launchApp', bundleId: 'com.apple.mobilesafari' })}
        title="打开 Safari（任意 App 改成对应 bundleId 即可）"
      >
        Safari
      </button>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => sendDeviceCommand('启动邮件', () => window.electronAPI.iosControlLaunchApp?.({ bundleId: 'com.apple.mobilemail' }), { op: 'launchApp', bundleId: 'com.apple.mobilemail' })}
        title="打开邮件"
      >
        邮件
      </button>
      <span className="ios-mirror-seg" title="双指缩放：以画面中心点为基准">
        <button
          type="button"
          className="ios-mirror-seg__btn"
          onClick={() => sendDeviceCommand('双指放大', () => window.electronAPI.iosControlZoom?.({ mode: 'in' }), { op: 'zoom', mode: 'in' })}
          title="双指外扩（放大）"
        >
          放大
        </button>
        <button
          type="button"
          className="ios-mirror-seg__btn"
          onClick={() => sendDeviceCommand('双指缩小', () => window.electronAPI.iosControlZoom?.({ mode: 'out' }), { op: 'zoom', mode: 'out' })}
          title="双指内收（缩小）"
        >
          缩小
        </button>
      </span>
    </div>
  ) : null;

  // 操控状态提示：连接失败要说清楚缺什么，而不是静默不生效；
  // 连接成功时也要反映解锁情况 —— 无人值守场景下「锁屏没解开」是首要故障
  const controlHint = control.message ? (
    <div className={`ios-mirror-control-hint ${control.enabled ? 'is-ok' : 'is-warn'}`}>
      {control.enabled
        ? `已连接 ${control.baseUrl}，画面上点击/滑动即操作设备`
        : control.message}
    </div>
  ) : null;
  const unlockHint = control.enabled && control.unlockWarning ? (
    <div className="ios-mirror-control-hint is-warn">{control.unlockWarning}</div>
  ) : (control.enabled && control.unlocked ? (
    <div className="ios-mirror-control-hint is-ok">设备锁屏已自动解锁，可直接远程操作。</div>
  ) : null);

  const zoomBar = (
    <>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => setZoomBy(-ZOOM_STEP)}
        disabled={!running || zoom <= ZOOM_MIN}
        title="缩小"
      >
        −
      </button>
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={zoom}
        disabled={!running}
        onChange={(event) => setZoom(clampZoom(Number(event.target.value)))}
        title="缩放画面"
      />
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => setZoomBy(ZOOM_STEP)}
        disabled={!running || zoom >= ZOOM_MAX}
        title="放大"
      >
        +
      </button>
      <button
        className="btn btn-secondary btn-sm"
        onClick={() => setZoom(100)}
        disabled={!running || zoom === 100}
        title="回到贴合窗口"
      >
        适应
      </button>
      <span className="ios-mirror-zoom__value">{zoom}%</span>
    </>
  );

  const orientationToggle = (
    <span className="ios-mirror-seg">
      <button
        type="button"
        className={`ios-mirror-seg__btn ${landscape ? '' : 'is-active'}`}
        onClick={() => setLandscape(false)}
        title="竖屏：控制区在左，画面在右"
      >
        竖屏
      </button>
      <button
        type="button"
        className={`ios-mirror-seg__btn ${landscape ? 'is-active' : ''}`}
        onClick={() => setLandscape(true)}
        title="横屏：控制区在上，画面铺满下方"
      >
        横屏
      </button>
    </span>
  );

  const statusNode = statusLine ? (
    <div className={`message ${statusLine.type} ios-mirror-message`}>
      {statusLine.text.split('\n').map((line, i) => (
        /* code-review-allow quality/no-index-key —— 文案是按行拆出来的只读文本，整体重算 */
        <div key={i} className={line.match(/^\d+\./) ? 'ios-mirror-guide-step' : ''}>{line}</div>
      ))}
    </div>
  ) : null;

  // 无人值守面板：放在控制区下方，给操作完实时屏的用户一个直接配脚本的入口。
  // 只有 WDA 可用时才有意义 —— 否则点启动会被主进程 iosControl 报回来，
  // UI 仍可写脚本和试运行（单次试跑即时报错）。
  // 录制能力由 IosMirror 注入：手势 / 按键 / App 启动全部埋在 IosMirror 的
  // 派发点里，AutoPilot 只消费「当前录制 + 已记步数」。
  const autoPilotNode = (
    <AutoPilot
      embedded
      recorder={{
        recording,
        recordedCount,
        onToggle: toggleRecording,
        onClear: clearRecording,
        buildScript: buildRecordedScript
      }}
    />
  );

  const stageNode = (
    <div className="ios-mirror-stage-wrap" ref={wrapRef}>
      <div className="ios-mirror-stage" ref={stageRef} onClick={onStageClick}>
        <div
          className={`ios-mirror-canvas ${running && canvas ? 'is-on' : 'is-off'} ${control.enabled ? 'is-controllable' : ''}`}
          style={canvas ? { width: canvas.width, height: canvas.height } : undefined}
          onPointerDown={onControlPointerDown}
          onPointerMove={onControlPointerMove}
          onPointerUp={onControlPointerUp}
          onPointerCancel={() => {
            // 诊断：如果这里频繁出现，说明系统还在取消手势（原生拖拽等），
            // 这正是滑动发不出去的直接原因
            console.log('[mirror] pointercancel：手势被系统中断', pointerRef.current?.moved ? '（已判定为滑动，手势被丢）' : '');
            pointerRef.current = null;
          }}
          onDragStart={(event) => event.preventDefault()}
        >
          <video
            ref={videoRef}
            className={mode === 'live' ? 'is-visible' : 'is-hidden'}
            style={{
              width: canvas?.mediaWidth,
              height: canvas?.mediaHeight,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`
            }}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={(event) => {
              const node = event.currentTarget;
              if (node.videoWidth && node.videoHeight) {
                setNatural({ width: node.videoWidth, height: node.videoHeight });
              }
            }}
          />
          {mode === 'screenshot' && snapshot ? (
            <img
              src={snapshot}
              alt="iPhone 截图"
              draggable={false}
              style={{
                width: canvas?.mediaWidth,
                height: canvas?.mediaHeight,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`
              }}
            />
          ) : null}
          {mode === 'mjpeg' && mjpegUrl ? (
            <img
              src={mjpegUrl}
              alt="iPhone 实时画面"
              crossOrigin="anonymous"
              draggable={false}
              style={{
                width: canvas?.mediaWidth,
                height: canvas?.mediaHeight,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`
              }}
              onLoad={(event) => {
                // 首帧到达时才知道流尺寸，用 naturalWidth/Height 定型画面
                const node = event.currentTarget;
                if (node.naturalWidth && node.naturalHeight) {
                  setNatural({ width: node.naturalWidth, height: node.naturalHeight });
                }
              }}
              onError={() => {
                // 流断了（WDA 重启 / 设备拔出）：回退到截图轮询，不中断整次投屏
                if (mode !== 'mjpeg') return;
                console.log('[mirror] MJPEG 流中断，回退到截图轮询');
                setMjpegUrl('');
                setMode('');
                startScreenshotLoop(selectedDevice).catch(() => {});
              }}
            />
          ) : null}
        </div>
        {!running && (
          <div className="ios-mirror-empty">
            连接 iPhone 后点「开始实时显示」
            <span className="ios-mirror-empty__sub">画面可缩放、可切横竖屏；双击画面在 100% / 200% 之间切换</span>
          </div>
        )}
      </div>

      {/* 横屏时控制区在顶部，缩放浮层贴在画面上，避免再占一行高度 */}
      {running && !sideLayout && (
        <div className="ios-mirror-overlay">
          <span className="ios-mirror-zoom">{zoomBar}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className={embedded ? 'ios-mirror-embed' : 'content-card ios-mirror-page'}>
      {!embedded && <h2>iPhone 实时投屏</h2>}

      {controlPlan && (
        <div className={`ios-control-status ${controlPlan.canControl ? 'is-ok' : 'is-blocked'}`}>
          <div className="ios-control-status__head">
            <span className="ios-control-status__dot" />
            <strong>{controlPlan.canControl ? '可以操作设备' : '当前只能看，不能操作'}</strong>
            <span className="ios-control-status__summary">{controlPlan.summary}</span>
          </div>
          {controlPlan.blockers.length > 0 && (
            <ul className="ios-control-status__list">
              {controlPlan.blockers.map((item) => (
                <li key={item.code}>
                  <span className="ios-control-status__msg">{item.message}</span>
                  <span className="ios-control-status__action">{item.action}</span>
                </li>
              ))}
            </ul>
          )}
          {controlPlan.alternatives.length > 0 && (
            <div className="ios-control-status__alt">
              {controlPlan.alternatives.map((item) => (
                <span key={item.backend}>备选：{item.message}</span>
              ))}
            </div>
          )}
          {/*
            「WDA 未运行」时给一个真的能按的按钮 —— 而不是让用户自己去装 Xcode。
            WDA 没装过时这个按钮会明确报「需要先用 Xcode 装一次」，不会白点。
          */}
          {needsWdaStart && (
            <div className="ios-control-status__actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={startWda}
                disabled={wdaBusy || !selectedDevice}
              >
                {wdaBusy ? '正在启动 WebDriverAgent…' : '启动 WebDriverAgent'}
              </button>
              <span className="ios-control-status__hint">
                应用会用 tidevice 拉起设备上已安装的 WDA，不需要 Xcode
              </span>
            </div>
          )}
          {wdaMessage && <div className="ios-control-status__error">{wdaMessage}</div>}
        </div>
      )}

      {controlHint}
      {unlockHint}

      {sideLayout ? (
        <div className="ios-mirror-split">
          <aside className="ios-mirror-side">
            <div className="ios-mirror-side__group">
              <span className="ios-mirror-side__label">设备与画面源</span>
              <div className="ios-mirror-side__stack">{devicePicker}</div>
            </div>
            <div className="ios-mirror-side__group">
              <span className="ios-mirror-side__label">操作</span>
              <div className="ios-mirror-side__actions">{primaryActions}</div>
            </div>
            {deviceActions && (
              <div className="ios-mirror-side__group">
                <span className="ios-mirror-side__label">设备动作</span>
                {deviceActions}
              </div>
            )}
            <div className="ios-mirror-side__group">
              <span className="ios-mirror-side__label">缩放</span>
              <div className="ios-mirror-side__zoom">{zoomBar}</div>
            </div>
            <div className="ios-mirror-side__group">
              <span className="ios-mirror-side__label">方向</span>
              {orientationToggle}
            </div>
            {statusNode}
            {autoPilotNode}
          </aside>
          {stageNode}
        </div>
      ) : (
        <>
          <div className="ios-mirror-row">
            {devicePicker}
            {primaryActions}
            {deviceActions}
            {orientationToggle}
          </div>
          {statusNode}
          {stageNode}
        </>
      )}

      <style>{`
        .ios-mirror-page { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
        .ios-mirror-embed { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
        .ios-mirror-page h2 { margin: 0 0 10px; padding: 0; border: 0; font-size: 22px; }

        /* ---------- 竖屏：左控制 / 右画面 ---------- */
        .ios-mirror-split {
          display: flex;
          flex: 1;
          min-height: 0;
          gap: 12px;
        }
        .ios-mirror-side {
          flex: 0 0 268px;
          width: 268px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          overflow-y: auto;
          padding-right: 2px;
        }
        .ios-mirror-side__group { display: flex; flex-direction: column; gap: 6px; }
        .ios-mirror-side__label {
          font-size: 12px;
          font-weight: 600;
          color: #5f6368;
          letter-spacing: 0.02em;
        }
        .ios-mirror-side__stack { display: flex; flex-direction: column; gap: 6px; }
        .ios-mirror-side__actions { display: flex; flex-wrap: wrap; gap: 6px; }
        /* 设备动作工具栏：和侧栏主操作同样的换行 + 间距，多按钮才不至于挤在一起 */
        .ios-mirror-device-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .ios-mirror-side__zoom {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .ios-mirror-side__zoom input[type="range"] { flex: 1; min-width: 90px; accent-color: #667eea; }
        .ios-mirror-side .ios-mirror-select { width: 100%; max-width: none; flex: none; }
        .ios-mirror-side .ios-mirror-message { margin: 0; }

        /* ---------- 横屏：控制在上 / 画面在下 ---------- */
        .ios-mirror-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
          flex-shrink: 0;
        }
        .ios-mirror-select {
          flex: 1 1 170px;
          min-width: 140px;
          max-width: 300px;
          padding: 6px 10px;
          border: 1px solid #e8eaed;
          border-radius: 8px;
          font-size: 13px;
          color: #3c4043;
          background: #fff;
          outline: none;
        }
        .ios-mirror-select:disabled { background: #f7f8fc; color: #9aa0a6; }
        .ios-mirror-row .btn-sm,
        .ios-mirror-side .btn-sm { padding: 6px 12px; font-size: 13px; }
        .ios-mirror-message { margin: 0 0 6px; padding: 6px 10px; font-size: 12px; flex-shrink: 0; line-height: 1.5; }

        /* ---------- 画面区 ---------- */
        .ios-mirror-stage-wrap {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          border: 1px solid #e8eaed;
          border-radius: 12px;
          background: #111;
          overflow: hidden;
        }
        .ios-mirror-stage {
          flex: 1;
          min-height: 0;
          display: flex;
          overflow: auto;
        }
        .ios-mirror-canvas { position: relative; margin: auto; flex: 0 0 auto; }
        /* 可控制时禁掉原生拖拽/选中/触摸滚动 —— 图片一被拖动就触发 dragstart，
           紧接着 pointercancel 会把滑动手势整个吃掉，swipe 永远发不出去 */
        .ios-mirror-canvas.is-controllable {
          user-select: none;
          -webkit-user-drag: none;
          touch-action: none;
          cursor: pointer;
        }
        .ios-mirror-canvas.is-controllable img,
        .ios-mirror-canvas.is-controllable video { -webkit-user-drag: none; pointer-events: none; }
        .ios-mirror-canvas.is-off { display: none; }
        .ios-mirror-canvas video,
        .ios-mirror-canvas img {
          position: absolute;
          left: 50%;
          top: 50%;
          object-fit: fill;
          display: block;
        }
        .ios-mirror-canvas video.is-hidden { display: none; }
        .ios-mirror-empty {
          margin: auto;
          color: #9aa0a6;
          font-size: 14px;
          text-align: center;
          line-height: 1.9;
        }
        .ios-mirror-empty__sub { display: block; font-size: 12px; color: #5f6368; }

        /* ---------- 浮层与小组件 ---------- */
        .ios-mirror-overlay {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 6px;
          border-radius: 999px;
          background: rgba(32, 33, 36, 0.82);
          z-index: 2;
        }
        .ios-mirror-zoom { display: inline-flex; align-items: center; gap: 5px; }
        .ios-mirror-zoom input[type="range"] { width: 108px; accent-color: #8ab4f8; }
        .ios-mirror-zoom__value { font-size: 12px; color: #5f6368; min-width: 38px; text-align: right; }
        .ios-mirror-overlay .ios-mirror-zoom__value { color: #e8eaed; }
        .ios-mirror-overlay .btn-sm {
          padding: 3px 9px;
          font-size: 12px;
          background: transparent;
          border-color: rgba(255, 255, 255, 0.28);
          color: #e8eaed;
        }
        .ios-mirror-overlay .btn-sm:disabled { color: #5f6368; border-color: rgba(255, 255, 255, 0.12); }
        .ios-mirror-seg { display: inline-flex; border-radius: 999px; overflow: hidden; border: 1px solid #e8eaed; }
        .ios-mirror-seg__btn {
          border: 0;
          background: #fff;
          color: #3c4043;
          font-size: 12px;
          padding: 5px 11px;
          cursor: pointer;
        }
        .ios-mirror-seg__btn.is-active { background: #667eea; color: #fff; }
        .ios-mirror-seg__btn:disabled { color: #b4b2a9; cursor: not-allowed; }
        .ios-mirror-page .btn-danger,
        .ios-mirror-embed .btn-danger { background: #c62828; color: #fff; border: none; }
        .ios-mirror-guide-step { margin: 2px 0; padding-left: 4px; }

        @media (max-width: 880px) {
          .ios-mirror-split { flex-direction: column; }
          .ios-mirror-side { flex: 0 0 auto; width: 100%; max-height: 42%; }
        }
      `}</style>
    </div>
  );
}

export default IosMirror;
