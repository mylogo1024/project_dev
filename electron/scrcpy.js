'use strict';

const path = require('path');
const crypto = require('crypto');

const READY_LINE = /\bINFO:\s+(Renderer|Texture|Device)\b/i;
const ERROR_LINE = /\bERROR:/i;
const BITRATE_RE = /^\d+[KMG]?$/i;
const MAX_LOG = 8000;
const STOP_GRACE_MS = 1500;

function makeSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

function appendLog(session, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  session.log = `${session.log || ''}${text}`.slice(-MAX_LOG);
}

function snapshot(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    state: session.state,
    pid: session.child?.pid || null,
    executable: session.executable || null,
    args: session.args || [],
    message: session.message || '',
    log: session.log || '',
    startedAt: session.startedAt || null,
    code: session.code ?? null,
    signal: session.signal || null
  };
}

function toInt(value, min, max) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function normalizeOptions(input = {}) {
  const deviceId = String(input.deviceId || input.serial || '').trim();
  if (!deviceId) throw new Error('请选择要投屏的 Android 设备');

  const maxSize = toInt(input.maxSize, 0, 8192);
  const maxFps = toInt(input.maxFps, 0, 240);
  const bitRate = String(input.bitRate || input.videoBitRate || '').trim();
  if (bitRate && !BITRATE_RE.test(bitRate)) {
    throw new Error('码率格式无效，例如 8M 或 8000000');
  }

  const recordPath = String(input.recordPath || '').trim();
  if (recordPath) {
    if (!path.isAbsolute(recordPath)) throw new Error('录制路径必须是绝对路径');
    if (recordPath.includes('\0')) throw new Error('录制路径无效');
  }

  const windowTitle = String(input.windowTitle || '开发工具箱 · 设备投屏').trim() || '开发工具箱 · 设备投屏';
  const keyboard = String(input.keyboard || '').trim().toLowerCase();
  if (keyboard && !['sdk', 'uhid', 'aoa', 'disabled'].includes(keyboard)) {
    throw new Error('键盘模式只能是 sdk / uhid / aoa / disabled');
  }

  return {
    deviceId,
    maxSize: maxSize || null,
    maxFps: maxFps || null,
    bitRate: bitRate || null,
    stayAwake: Boolean(input.stayAwake),
    turnScreenOff: Boolean(input.turnScreenOff),
    alwaysOnTop: Boolean(input.alwaysOnTop),
    fullscreen: Boolean(input.fullscreen),
    noAudio: Boolean(input.noAudio),
    noControl: Boolean(input.noControl),
    showTouches: Boolean(input.showTouches),
    powerOffOnClose: Boolean(input.powerOffOnClose),
    uhidKeyboard: Boolean(input.uhidKeyboard) || keyboard === 'uhid',
    keyboard: keyboard || (input.uhidKeyboard ? 'uhid' : ''),
    recordPath: recordPath || '',
    windowTitle
  };
}

function buildArgs(options) {
  const opts = options.deviceId ? options : normalizeOptions(options);
  const args = ['--serial', opts.deviceId, '--window-title', opts.windowTitle];
  if (opts.maxSize) args.push('--max-size', String(opts.maxSize));
  if (opts.maxFps) args.push('--max-fps', String(opts.maxFps));
  if (opts.bitRate) args.push('--video-bit-rate', opts.bitRate);
  if (opts.stayAwake) args.push('--stay-awake');
  if (opts.turnScreenOff) args.push('--turn-screen-off');
  if (opts.alwaysOnTop) args.push('--always-on-top');
  if (opts.fullscreen) args.push('--fullscreen');
  if (opts.noAudio) args.push('--no-audio');
  if (opts.noControl) args.push('--no-control');
  if (opts.showTouches) args.push('--show-touches');
  if (opts.powerOffOnClose) args.push('--power-off-on-close');
  if (opts.keyboard) args.push(`--keyboard=${opts.keyboard}`);
  else if (opts.uhidKeyboard) args.push('--keyboard=uhid');
  if (opts.recordPath) args.push(`--record=${opts.recordPath}`);
  return args;
}

function isReadyLine(text) {
  return READY_LINE.test(String(text || ''));
}

function isErrorLine(text) {
  return ERROR_LINE.test(String(text || ''));
}

function childEnv(baseEnv) {
  const env = { ...(baseEnv || process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  return env;
}

function createScrcpyController(deps = {}) {
  const spawnFn = deps.spawn || require('child_process').spawn;
  const resolveTool = deps.resolveTool;
  const detectTool = deps.detectTool;
  const env = deps.env || process.env;
  const sessions = new Map();
  const listeners = new Set();

  function emit() {
    const status = getStatus();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch (_) { /* 单个订阅者抛错不能影响其它订阅者 */ }
    }
  }

  function getStatus() {
    return {
      sessions: [...sessions.values()].map(snapshot)
    };
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function detect() {
    if (typeof detectTool !== 'function') {
      return { installed: false, path: null };
    }
    return detectTool('scrcpy', ['--version']);
  }

  function killChild(child, signal) {
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32') {
        child.kill();
        return;
      }
      child.kill(signal);
    } catch (_) { /* 进程可能已退出，kill 失败是正常的 */ }
  }

  function settleStart(session, error) {
    const resolve = session.resolveStart;
    const reject = session.rejectStart;
    session.resolveStart = null;
    session.rejectStart = null;
    if (error && typeof reject === 'function') {
      reject(error);
      return;
    }
    if (typeof resolve === 'function') resolve(snapshot(session));
  }

  function finalize(session, extra = {}) {
    if (session.finalized) return;
    session.finalized = true;
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    session.child = null;
    session.code = extra.code ?? session.code ?? null;
    session.signal = extra.signal || session.signal || null;
    if (session.stopRequested) {
      session.state = 'stopped';
      session.message = extra.message || '已停止投屏';
    } else if (extra.error || (Number.isInteger(session.code) && session.code !== 0)) {
      session.state = 'error';
      session.message = extra.message || session.message || 'scrcpy 已退出';
    } else {
      session.state = 'stopped';
      session.message = extra.message || '投屏窗口已关闭';
    }
    if (!session.ready && session.state === 'error') {
      settleStart(session, new Error(session.message || 'scrcpy 启动失败'));
    } else {
      settleStart(session);
    }
    emit();
  }

  async function start(input) {
    const options = normalizeOptions(input);
    const existing = sessions.get(options.deviceId);
    if (existing && !existing.finalized) {
      await stop(options.deviceId);
    }

    if (typeof resolveTool !== 'function') {
      throw new Error('未配置 scrcpy 查找器');
    }

    let executable;
    try {
      executable = resolveTool('scrcpy');
    } catch (error) {
      throw new Error('未找到 scrcpy。请先执行 brew install scrcpy（需已安装 adb），或把本地编译的 scrcpy 放到 PATH。');
    }

    const args = buildArgs(options);
    const session = {
      sessionId: makeSessionId(),
      deviceId: options.deviceId,
      state: 'starting',
      message: '正在启动 scrcpy…',
      executable,
      args,
      log: '',
      startedAt: Date.now(),
      ready: false,
      stopRequested: false,
      finalized: false,
      child: null,
      code: null,
      signal: null,
      stopTimer: null,
      resolveStart: null,
      rejectStart: null
    };
    sessions.set(options.deviceId, session);
    emit();

    let child;
    try {
      child = spawnFn(executable, args, {
        env: childEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
      });
    } catch (error) {
      session.state = 'error';
      session.message = error.message || '无法启动 scrcpy';
      sessions.delete(options.deviceId);
      emit();
      throw error;
    }

    session.child = child;
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.ready || session.finalized) return;
        session.ready = true;
        session.state = 'running';
        session.message = '投屏窗口已打开（若未看到画面，请看任务栏/程序坞）';
        emit();
        resolve(snapshot(session));
      }, 8000);

      session.resolveStart = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      session.rejectStart = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    const handleOutput = (buffer) => {
      const text = buffer.toString();
      appendLog(session, text);
      if (!session.ready && isReadyLine(text)) {
        session.ready = true;
        session.state = 'running';
        session.message = '投屏中，请在弹出的 scrcpy 窗口里用鼠标键盘控制设备';
        if (typeof session.resolveStart === 'function') {
          const resolve = session.resolveStart;
          session.resolveStart = null;
          session.rejectStart = null;
          resolve(snapshot(session));
        }
      } else if (isErrorLine(text) && !session.ready) {
        session.message = text.trim().split(/\r?\n/).filter((line) => /ERROR:/i.test(line)).pop() || session.message;
      }
      emit();
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);
    child.once('error', (error) => {
      session.message = error.message || 'scrcpy 进程异常';
      finalize(session, { error, message: session.message });
    });
    child.once('close', (code, signal) => {
      const tail = String(session.log || '').trim();
      const errorLine = tail.split(/\r?\n/).reverse().find((line) => /ERROR:/i.test(line));
      finalize(session, {
        code,
        signal,
        message: session.stopRequested
          ? '已停止投屏'
          : (errorLine || (code ? `scrcpy 退出，退出码 ${code}` : '投屏窗口已关闭'))
      });
    });

    return started;
  }

  async function stop(deviceId) {
    const id = String(deviceId || '').trim();
    const session = id ? sessions.get(id) : [...sessions.values()].find((item) => !item.finalized);
    if (!session || session.finalized) {
      return { success: true, stopped: false, deviceId: id || null };
    }
    session.stopRequested = true;
    session.state = 'stopping';
    session.message = '正在停止投屏…';
    emit();
    killChild(session.child, 'SIGTERM');
    await new Promise((resolve) => {
      if (session.finalized) {
        resolve();
        return;
      }
      session.stopTimer = setTimeout(() => {
        killChild(session.child, 'SIGKILL');
        if (!session.finalized) {
          finalize(session, { code: null, signal: 'SIGKILL', message: '已强制结束投屏' });
        }
        resolve();
      }, STOP_GRACE_MS);
      const done = () => {
        clearTimeout(session.stopTimer);
        session.stopTimer = null;
        resolve();
      };
      if (session.child) session.child.once('close', done);
      else done();
    });
    return { success: true, stopped: true, deviceId: session.deviceId, sessionId: session.sessionId };
  }

  async function stopAll() {
    const ids = [...sessions.keys()];
    for (const id of ids) {
      await stop(id);
    }
  }

  function forceKill() {
    for (const session of sessions.values()) {
      session.stopRequested = true;
      killChild(session.child, 'SIGKILL');
      if (!session.finalized) {
        finalize(session, { signal: 'SIGKILL', message: '应用退出，已结束投屏' });
      }
    }
    sessions.clear();
  }

  return {
    start,
    stop,
    stopAll,
    forceKill,
    getStatus,
    detect,
    onStatus
  };
}

module.exports = {
  createScrcpyController,
  helpers: {
    normalizeOptions,
    buildArgs,
    isReadyLine,
    isErrorLine
  }
};
