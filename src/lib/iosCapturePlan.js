'use strict';

/**
 * iPhone 投屏的「采集通路规划」纯逻辑。
 *
 * 背景：macOS 上的 USB 实时画面走的是 AVFoundation 采集设备，
 * 必须本机真的存在一个 videoinput（内置摄像头，或 QuickTime 激活出来的 iPhone 屏幕设备）。
 * Mac mini / Mac Studio / Mac Pro 没有内置摄像头，AVFoundation 也不会凭空变出 iPhone 屏幕设备，
 * 此时 getUserMedia 会抛 NotFoundError（"Requested device not found"），
 * 只能退回到 idevicescreenshot 轮询。
 *
 * 这里把「怎么选候选设备」「怎么归因失败」「该给用户看什么话」抽成纯函数，
 * 方便单测，也避免 UI 里再出现裸的英文异常串。
 */

export const NO_CAPTURE_DEVICE = 'no-capture-device';
export const PERMISSION_DENIED = 'permission-denied';
export const DEVICE_BUSY = 'device-busy';
export const NO_MATCHING_SOURCE = 'no-matching-source';
export const UNKNOWN = 'unknown';

const BUILTIN_CAMERA = /facetime|studio display|built-?in|macbook|imac|obs virtual|camo|continuity camera/i;
const CONTINUITY_HINT = /continuity|摄像头|camera|后置|前置|ultra wide|wide angle/i;
const IOS_HINT = /iphone|ipad|ipod/;

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 给一个采集设备名打分：越高越可能是「目标 iPhone 的画面源」。 */
export function scoreCaptureSource(label, deviceName) {
  const labelNorm = normalizeName(label);
  const nameNorm = normalizeName(deviceName);
  if (!labelNorm || BUILTIN_CAMERA.test(labelNorm)) return 0;
  if (nameNorm && labelNorm === nameNorm) return 100;
  if (nameNorm && (labelNorm.includes(nameNorm) || nameNorm.includes(labelNorm))) {
    return CONTINUITY_HINT.test(labelNorm) ? 55 : 90;
  }
  if (IOS_HINT.test(labelNorm)) return CONTINUITY_HINT.test(labelNorm) ? 40 : 70;
  return 5;
}

/**
 * 规划 getUserMedia 的尝试顺序。
 *
 * 关键点：没有「高分候选」时不能直接放弃 —— 没拿到摄像头权限时
 * enumerateDevices 的 label 是空串，所有设备都是 0 分，
 * 但 deviceId 依然是可用的，所以最后要把剩下的设备也依次试一遍。
 */
export function planCaptureAttempts(inputs, deviceName, preferredId = '') {
  const list = Array.isArray(inputs) ? inputs.filter((item) => item?.deviceId) : [];
  const attempts = [];

  const push = (id) => {
    if (id && !attempts.includes(id)) attempts.push(id);
  };

  push(preferredId);

  const ranked = list
    .map((item) => ({ deviceId: item.deviceId, score: scoreCaptureSource(item.label, deviceName) }))
    .sort((a, b) => b.score - a.score);
  for (const item of ranked) {
    if (item.score >= 40) push(item.deviceId);
  }
  for (const item of ranked) push(item.deviceId);

  return attempts;
}

/** 把 getUserMedia 的异常归因成一个稳定的类别。 */
export function classifyCaptureError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  if (name === 'NotFoundError' || /requested device not found|device[s]? not found|no device/i.test(message)) {
    return NO_CAPTURE_DEVICE;
  }
  if (name === 'NotAllowedError' || /permission|denied|not allowed/i.test(message)) {
    return PERMISSION_DENIED;
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || /in use|could not start|busy/i.test(message)) {
    return DEVICE_BUSY;
  }
  if (name === 'OverconstrainedError') return NO_MATCHING_SOURCE;
  return UNKNOWN;
}

/** 归类之后给用户看的人话，附带下一步该做什么。 */
export function describeCaptureFailure(kind, context = {}) {
  const { hasCaptureDevice = true, screenshotAvailable = false } = context;
  const tail = screenshotAvailable ? ' 已自动改用截图刷新模式。' : '';

  switch (kind) {
    case NO_CAPTURE_DEVICE:
      return hasCaptureDevice
        ? `没有找到 iPhone 画面源。请解锁 iPhone、确认已「信任此电脑」，并在 QuickTime Player 里用「新建影片录制」激活一次 iPhone 采集通道。${tail}`
        : `本机没有任何视频采集设备（Mac mini / Mac Studio / Mac Pro 一般没有内置摄像头），macOS 也就无法建立 iPhone 的 USB 实时画面通道。${tail}`;
    case PERMISSION_DENIED:
      return `没有摄像头权限。请到 系统设置 → 隐私与安全性 → 摄像头，勾选本应用后重开。${tail}`;
    case DEVICE_BUSY:
      return `采集通道被占用。请退出 QuickTime Player、相机、视频会议等正在用摄像头的应用后重试。${tail}`;
    case NO_MATCHING_SOURCE:
      return `没有匹配到 iPhone 画面源。请打开 QuickTime Player → 文件 → 新建影片录制 → 选择 iPhone，再回来点「刷新画面源」。${tail}`;
    default:
      return `无法启动摄像头采集。${tail}`;
  }
}

/**
 * 截图失败是不是「设备不在了 / 截图服务暂时不可达」这类**可自愈**的情况。
 *
 * idevicescreenshot 在设备被拔掉、手机锁屏、或 USB 链路被打断时都会输出
 * "No device found with udid xxx"（注意：这行字打在 stdout 上，退出码 255），
 * 三种原因的处置不同，但都值得继续重试而不是直接报死。
 */
export function isRecoverableScreenshotError(error) {
  const message = String(error?.message || error || '');
  return /no device found with udid|no device found|device not found/i.test(message);
}

/**
 * 截图失败给用户看的话。
 * `connected` 由主进程查 idevice_id -l 得到：false 表示设备真的不在了。
 */
export function describeScreenshotFailure(connected) {
  if (connected === false) {
    return 'iPhone 已断开连接。重新插好数据线后画面会自动恢复。';
  }
  return 'iPhone 暂时无法截图，通常是手机已锁屏或 USB 链路被打断。解锁手机后画面会自动恢复。';
}
