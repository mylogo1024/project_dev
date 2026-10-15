'use strict';

/**
 * 连接设备上的快捷操作。优先走系统自带接口，不装第三方控制 App。
 *
 * Android：adb reboot / input keyevent / screencap / screenrecord / cmd activity
 * iOS：idevicediagnostics、idevicescreenshot；按键类在有 WDA 时再走硬件键
 */
const fs = require('node:fs');
const path = require('node:path');
const { helpers: deviceFileHelpers } = require('./device-files');

const { adbArgs, normalizeDeviceId } = deviceFileHelpers;

const REMOTE_SHOT = '/data/local/tmp/toolbox-shot.png';
const REMOTE_REC = '/data/local/tmp/toolbox-record.mp4';

const CATALOG = Object.freeze([
  { id: 'shutdown', label: '关机', group: '电源', danger: true, platforms: ['android', 'ios'] },
  { id: 'reboot', label: '重启', group: '电源', danger: true, platforms: ['android', 'ios'] },
  { id: 'sleep', label: '息屏', group: '电源', platforms: ['android', 'ios'] },
  { id: 'wake', label: '亮屏', group: '电源', platforms: ['android', 'ios'] },
  { id: 'mute', label: '静音', group: '音量', platforms: ['android', 'ios'] },
  { id: 'volume-up', label: '音量加', group: '音量', platforms: ['android', 'ios'] },
  { id: 'volume-down', label: '音量减', group: '音量', platforms: ['android', 'ios'] },
  { id: 'home', label: '主界面', group: '导航', platforms: ['android', 'ios'] },
  { id: 'back', label: '返回', group: '导航', platforms: ['android'] },
  { id: 'recents', label: '最近任务', group: '导航', platforms: ['android'] },
  { id: 'clear-recents', label: '清空后台', group: '导航', platforms: ['android'] },
  { id: 'notifications', label: '通知栏', group: '导航', platforms: ['android'] },
  { id: 'screenshot', label: '截图', group: '采集', save: 'png', platforms: ['android', 'ios'] },
  { id: 'record-start', label: '开始录屏', group: '采集', platforms: ['android'] },
  { id: 'record-stop', label: '停止录屏', group: '采集', save: 'mp4', platforms: ['android'] }
]);

const KEYEVENT = Object.freeze({
  BACK: '4',
  HOME: '3',
  VOLUME_UP: '24',
  VOLUME_DOWN: '25',
  VOLUME_MUTE: '164',
  SLEEP: '223',
  WAKEUP: '224',
  APP_SWITCH: '187',
  NOTIFICATION: '83'
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function androidInvocation(action) {
  switch (action) {
    case 'shutdown': return { args: ['reboot', '-p'] };
    case 'reboot': return { args: ['reboot'] };
    case 'sleep': return { args: ['shell', 'input', 'keyevent', KEYEVENT.SLEEP] };
    case 'wake': return { args: ['shell', 'input', 'keyevent', KEYEVENT.WAKEUP] };
    case 'volume-up': return { args: ['shell', 'input', 'keyevent', KEYEVENT.VOLUME_UP] };
    case 'volume-down': return { args: ['shell', 'input', 'keyevent', KEYEVENT.VOLUME_DOWN] };
    case 'home': return { args: ['shell', 'input', 'keyevent', KEYEVENT.HOME] };
    case 'back': return { args: ['shell', 'input', 'keyevent', KEYEVENT.BACK] };
    case 'recents': return { args: ['shell', 'input', 'keyevent', KEYEVENT.APP_SWITCH] };
    case 'notifications': return { args: ['shell', 'cmd', 'statusbar', 'expand-notifications'] };
    case 'mute': return { args: ['shell', 'cmd', 'media', 'volume', '--stream', '3', '--set', '0'] };
    case 'clear-recents': return { args: ['shell', 'cmd', 'activity', 'recents', 'remove-all'] };
    default: return null;
  }
}

function describeAction(id) {
  return CATALOG.find((item) => item.id === id) || null;
}

function createDeviceActions({ runTool, iosControl } = {}) {
  if (typeof runTool !== 'function') throw new Error('createDeviceActions 需要 runTool');
  const recordings = new Map();

  function adb(serial, args, options = {}) {
    return runTool('adb', adbArgs(serial, args), {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      ...options
    });
  }

  function listActions(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    const deviceId = normalizeDeviceId(payload.deviceId || payload.id);
    const recording = Boolean(deviceId && recordings.has(deviceId));
    return CATALOG
      .filter((item) => item.platforms.includes(platform))
      .filter((item) => {
        if (item.id === 'record-start') return !recording;
        if (item.id === 'record-stop') return recording;
        return true;
      })
      .map((item) => ({
        id: item.id,
        label: item.label,
        group: item.group,
        danger: Boolean(item.danger),
        save: item.save || null
      }));
  }

  async function runAndroid(serial, action, outputPath) {
    if (action === 'screenshot') {
      if (!outputPath) throw new Error('请选择截图保存位置');
      await adb(serial, ['shell', 'screencap', '-p', REMOTE_SHOT]);
      await adb(serial, ['pull', REMOTE_SHOT, outputPath], { timeout: 30000 });
      try { await adb(serial, ['shell', 'rm', '-f', REMOTE_SHOT]); } catch (_) { /* 临时截图删不掉不影响已 pull 的文件 */ }
      if (!fs.existsSync(outputPath)) throw new Error('截图没有落到本机，请检查存储权限');
      return { ok: true, message: `截图已保存：${outputPath}`, outputPath };
    }

    if (action === 'record-start') {
      if (recordings.has(serial)) throw new Error('这台设备已经在录屏');
      await adb(serial, ['shell', `rm -f ${REMOTE_REC}`]);
      const { stdout } = await adb(serial, [
        'shell',
        `screenrecord --time-limit 180 ${REMOTE_REC} >/dev/null 2>&1 & echo $!`
      ]);
      const pid = String(stdout || '').trim().split(/\s+/).pop();
      if (!/^\d+$/.test(pid)) throw new Error('无法启动系统 screenrecord（设备可能没有这个命令）');
      recordings.set(serial, { pid, remote: REMOTE_REC });
      return { ok: true, recording: true, message: '已开始录屏（最长 3 分钟，再点一次停止并保存）' };
    }

    if (action === 'record-stop') {
      const session = recordings.get(serial);
      if (!session) throw new Error('当前没有进行中的录屏');
      if (!outputPath) throw new Error('请选择录屏保存位置');
      try {
        await adb(serial, ['shell', `kill -2 ${session.pid}`]);
      } catch (_) { /* 进程可能已经自己结束（到了 180 秒） */ }
      recordings.delete(serial);
      await sleep(1200);
      await adb(serial, ['pull', session.remote, outputPath], { timeout: 60000 });
      try { await adb(serial, ['shell', 'rm', '-f', session.remote]); } catch (_) { /* 设备上的临时录像删不掉不影响已 pull 的文件 */ }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 32) {
        throw new Error('录屏文件是空的，请确认录了足够长的时间');
      }
      return { ok: true, recording: false, message: `录屏已保存：${outputPath}`, outputPath };
    }

    const invocation = androidInvocation(action);
    if (!invocation) throw new Error(`不支持的操作: ${action}`);
    try {
      await adb(serial, invocation.args);
    } catch (error) {
      if (action === 'mute') {
        await adb(serial, ['shell', 'input', 'keyevent', KEYEVENT.VOLUME_MUTE]);
      } else if (action === 'clear-recents') {
        await adb(serial, ['shell', 'am', 'kill-all']);
        return { ok: true, message: '已尽量结束后台进程（部分系统不提供清空最近任务）' };
      } else if (action === 'notifications') {
        await adb(serial, ['shell', 'input', 'keyevent', KEYEVENT.NOTIFICATION]);
      } else {
        throw error;
      }
    }
    const meta = describeAction(action);
    return { ok: true, message: `已执行：${meta ? meta.label : action}` };
  }

  async function iosHardware(name, label) {
    if (!iosControl) {
      throw new Error(`${label}需要 WebDriverAgent。可先到「设备投屏控制」连接这台 iPhone。`);
    }
    try {
      if (name === 'home') {
        await iosControl.pressHome();
      } else {
        await iosControl.pressButton(name);
      }
      return { ok: true, message: `已执行：${label}` };
    } catch (error) {
      throw new Error(`${label}需要 WebDriverAgent（非越狱设备没有系统按键接口）。${error.message}`);
    }
  }

  async function runIos(udid, action, outputPath) {
    if (action === 'shutdown') {
      await runTool('idevicediagnostics', ['-u', udid, 'shutdown'], { timeout: 15000 });
      return { ok: true, message: '已请求关机' };
    }
    if (action === 'reboot') {
      await runTool('idevicediagnostics', ['-u', udid, 'restart'], { timeout: 15000 });
      return { ok: true, message: '已请求重启' };
    }
    if (action === 'sleep') {
      await runTool('idevicediagnostics', ['-u', udid, 'sleep'], { timeout: 15000 });
      return { ok: true, message: '已息屏' };
    }
    if (action === 'screenshot') {
      if (!outputPath) throw new Error('请选择截图保存位置');
      await runTool('idevicescreenshot', ['-u', udid, outputPath], {
        timeout: 20000,
        maxBuffer: 16 * 1024 * 1024
      });
      if (!fs.existsSync(outputPath)) throw new Error('截图未生成，请解锁手机并信任此电脑');
      return { ok: true, message: `截图已保存：${outputPath}`, outputPath };
    }
    if (action === 'wake') return iosHardware('power', '亮屏');
    if (action === 'mute') return iosHardware('mute', '静音');
    if (action === 'volume-up') return iosHardware('volumeUp', '音量加');
    if (action === 'volume-down') return iosHardware('volumeDown', '音量减');
    if (action === 'home') return iosHardware('home', '主界面');
    throw new Error(`这台 iPhone 不支持「${describeAction(action)?.label || action}」（非越狱没有对应系统接口）`);
  }

  async function run(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    const deviceId = normalizeDeviceId(payload.deviceId || payload.id);
    const action = String(payload.action || '').trim();
    if (!deviceId) throw new Error('未选择设备');
    if (!describeAction(action)) throw new Error(`不支持的操作: ${action || '（空）'}`);
    const outputPath = typeof payload.outputPath === 'string' ? payload.outputPath : '';
    if (outputPath) {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) throw new Error('保存目录不存在');
    }
    return platform === 'ios'
      ? runIos(deviceId, action, outputPath)
      : runAndroid(deviceId, action, outputPath);
  }

  return {
    listActions,
    run,
    isRecording: (deviceId) => recordings.has(normalizeDeviceId(deviceId))
  };
}

module.exports = {
  CATALOG,
  KEYEVENT,
  REMOTE_SHOT,
  REMOTE_REC,
  androidInvocation,
  describeAction,
  createDeviceActions
};
