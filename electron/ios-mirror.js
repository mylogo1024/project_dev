'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 截图诊断日志。验证「画面延迟」时，用户要拿这条看真实节奏：
 * 单次截图耗时（idevicescreenshot 本体 + base64 + IPC 传输），
 * 而不是肉眼看帧率。
 */
const MIRROR_LOG_PREFIX = '[wda-mirror]';
const mirrorLog = (...parts) => {
  try {
    console.log(MIRROR_LOG_PREFIX, ...parts);
  } catch (_) {
    // console 不可用就吞掉
  }
};

const BUILTIN_CAMERA = /facetime|studio display|built-?in|macbook|imac|obs virtual|camo|continuity camera/i;
const CONTINUITY_HINT = /continuity|摄像头|camera|后置|前置|ultra wide|wide angle/i;
const IOS_HINT = /iphone|ipad|ipod/;

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseSystemProfilerCameras(json) {
  let root = json;
  if (typeof json === 'string') {
    const text = json.trim();
    if (!text) return [];
    root = JSON.parse(text);
  }
  const list = Array.isArray(root?.SPCameraDataType) ? root.SPCameraDataType : [];
  return list.map((item) => ({
    name: String(item?._name || item?.name || '').trim(),
    uniqueId: String(item?.['spcamera_unique-id'] || item?.uniqueId || '').trim(),
    modelId: String(item?.['spcamera_model-id'] || item?.modelId || '').trim()
  })).filter((item) => item.name);
}

function scoreCamera(label, deviceName) {
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

function pickBestCamera(cameras, deviceName) {
  const ranked = [...(cameras || [])]
    .map((item) => ({
      ...item,
      score: scoreCamera(item.label || item.name, deviceName)
    }))
    .sort((a, b) => b.score - a.score || String(a.label || a.name).localeCompare(String(b.label || b.name)));
  return ranked[0]?.score > 0 ? ranked[0] : null;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('没有可保存的画面');
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

function saveDataUrl(filePath, dataUrl) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('保存路径必须是绝对路径');
  const { buffer } = parseDataUrl(dataUrl);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return { success: true, path: filePath, bytes: buffer.length };
}

function createIosMirror({ runTool, detectTool, platform = process.platform } = {}) {
  if (typeof runTool !== 'function') throw new Error('createIosMirror 需要 runTool');

  async function getCapabilities() {
    const screenshot = typeof detectTool === 'function'
      ? await detectTool('idevicescreenshot')
      : { installed: false, path: null };
    return {
      platform,
      liveCapture: platform === 'darwin',
      screenshot: Boolean(screenshot?.installed),
      screenshotPath: screenshot?.path || ''
    };
  }

  async function listHostCameras() {
    if (platform !== 'darwin') return [];
    try {
      const { stdout } = await runTool('system_profiler', ['SPCameraDataType', '-json'], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024
      });
      return parseSystemProfilerCameras(stdout);
    } catch (_) {
      return [];
    }
  }

  async function takeScreenshot(deviceId) {
    const serial = String(deviceId || '').trim();
    if (!serial) throw new Error('请选择 iPhone');
    const out = path.join(os.tmpdir(), `ios-mirror-${serial.slice(0, 8)}-${Date.now()}.png`);
    const started = Date.now();
    try {
      await runTool('idevicescreenshot', ['-u', serial, out], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
      if (!fs.existsSync(out)) throw new Error('截图文件未生成，请确认设备已解锁并信任此电脑');
      const data = fs.readFileSync(out);
      mirrorLog(`截图 ${data.length}B 总耗时=${Date.now() - started}ms`);
      return {
        mime: 'image/png',
        dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        bytes: data.length
      };
    } catch (error) {
      mirrorLog(`截图失败（${Date.now() - started}ms）：${error.message}`);
      throw error;
    } finally {
      try { fs.unlinkSync(out); } catch (_) { /* 临时文件删不掉不影响已经拿到的数据 */ }
    }
  }

  /**
   * 判断某个 UDID 现在还在不在。
   *
   * idevicescreenshot 报 "No device found with udid xxx" 时，可能是设备真的拔了，
   * 也可能只是手机锁屏 / USB 链路被打断导致截图服务暂时不可达 —— 这两种情况
   * 给用户的提示完全不同，所以要能区分。注意这条消息是打在 stdout 上的（退出码 255）。
   */
  async function getDeviceState(deviceId) {
    const serial = String(deviceId || '').trim();
    if (!serial) return { connected: false, ids: [] };
    try {
      const { stdout } = await runTool('idevice_id', ['-l'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      const ids = String(stdout || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      return { connected: ids.includes(serial), ids };
    } catch (_) {
      return { connected: false, ids: [] };
    }
  }

  return {
    getCapabilities,
    listHostCameras,
    takeScreenshot,
    getDeviceState,
    saveDataUrl
  };
}

module.exports = {
  createIosMirror,
  helpers: {
    normalizeName,
    parseSystemProfilerCameras,
    scoreCamera,
    pickBestCamera,
    parseDataUrl,
    saveDataUrl
  }
};
