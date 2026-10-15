'use strict';

/**
 * 无人值守自动化执行器（13 天级）。
 *
 * **核心定位**：把现有 `ios-control` 的能力**声明化** —— 用户给一份 JSON 脚本
 * （步骤列表），autopilot 按调度策略在白班窗口跑、夜间锁屏省电、异常自愈、
 * 每步留快照、出问题写告警 + 系统通知。
 *
 * **为什么不重写一套执行器**：所有「操作设备」的能力已经在 `ios-control` 里
 * 实现且踩过坑了（WDA 会话失效自愈、拖拽轨迹拆段、坐标换算）。声明化就是把
 * 「调哪个方法、传什么参数」写成 JSON，而不是把 HTTP 层重来一遍。
 *
 * **可注入边界**（这样单测不需要真设备、真等 13 天）：
 *   - `iosControl`     —— 直接注入 ios-control 实例（本模块不 require 它）
 *   - `takeScreenshot` —— 注入截图函数（与 ios-mirror / WDA 截图解耦）
 *   - `notify`         —— 注入告警出口（生产 = Electron Notification，测试 = 空函数）
 *   - `now` / `delay`  —— 时间与等待可控
 *
 * **不在这里做的事**：
 *   - 不做 IPC（纯 CJS 模块，注册在 main.js）
 *   - 不做进程重启后的状态恢复（进程没了就重新开始白班窗口，13 天里系统
 *     不会无缘无故重启，这个取舍换来实现简单）
 */

const fs = require('fs');
const path = require('path');

const AP_LOG_PREFIX = '[autopilot]';
const apLog = (...parts) => {
  try { console.log(AP_LOG_PREFIX, ...parts); } catch (_) { /* 极端环境 console 不可用 */ }
};
const apError = (...parts) => {
  try { console.error(AP_LOG_PREFIX, ...parts); } catch (_) { /* 同上 */ }
};

/** 支持的操作。每个 op 映射到 ios-control 的一个方法。 */
const SUPPORTED_OPS = new Set([
  'tap', 'longPress', 'swipe', 'swipeDirection',
  'type', 'pressButton', 'pressHome', 'unlock',
  'launchApp', 'terminateApp', 'activeApp',
  'assertActiveApp', 'assert',
  'wait', 'screenshot', 'zoom'
]);

/**
 * 每个 op 允许的参数白名单。白名单之外的字段被**静默丢弃**。
 *
 * 脚本是用户给的数据，不该成为攻击面：比如有人在 step 里塞 `__proto__`
 * 或方法名，只要不通过白名单就进不了执行分支。
 */
const OP_KEY_WHITELIST = {
  tap: new Set(['x', 'y']),
  longPress: new Set(['x', 'y', 'duration']),
  swipe: new Set(['from', 'to', 'duration']),
  swipeDirection: new Set(['direction']),
  type: new Set(['text']),
  pressButton: new Set(['button']),
  pressHome: new Set(),
  unlock: new Set(),
  launchApp: new Set(['bundleId']),
  terminateApp: new Set(['bundleId']),
  activeApp: new Set(),
  assertActiveApp: new Set(['bundleId', 'timeoutMs']),
  assert: new Set(['expects', 'timeoutMs']),
  wait: new Set(['ms']),
  screenshot: new Set(['label']),
  zoom: new Set(['mode', 'duration'])
};

/**
 * 校验并清洗脚本。
 *
 * 返回 `{ name, deviceId, steps }`，step 只含白名单字段。任何不合规都抛错，
 * 错误信息直接可以显示给用户（不含内部术语）。
 */
function normalizeScript(script) {
  if (!script || typeof script !== 'object') throw new Error('脚本必须是对象');
  const name = String(script.name || '').trim() || 'autopilot';
  const deviceId = String(script.deviceId || '').trim();
  if (!deviceId) throw new Error('脚本缺少 deviceId');
  if (!Array.isArray(script.steps) || script.steps.length === 0) {
    throw new Error('脚本 steps 必须是非空数组');
  }

  const steps = [];
  for (let i = 0; i < script.steps.length; i += 1) {
    const raw = script.steps[i];
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${i + 1} 步必须是对象`);
    const op = String(raw.op || '').trim();
    if (!SUPPORTED_OPS.has(op)) {
      throw new Error(`第 ${i + 1} 步 op "${op}" 不支持，可用：${[...SUPPORTED_OPS].join(', ')}`);
    }
    const whitelist = OP_KEY_WHITELIST[op];
    const step = { op };
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'op') continue;
      if (whitelist.has(key)) step[key] = value;
    }
    if (op === 'wait' && !(Number.isFinite(Number(step.ms)) && Number(step.ms) >= 0)) {
      throw new Error(`第 ${i + 1} 步 wait.ms 必须是 ≥0 的数字`);
    }
    if (op === 'screenshot' && step.label != null && typeof step.label !== 'string') {
      throw new Error(`第 ${i + 1} 步 screenshot.label 必须是字符串`);
    }
    if ((op === 'assert' || op === 'assertActiveApp') && !step.bundleId && !step.expects) {
      throw new Error(`第 ${i + 1} 步 ${op} 需要 bundleId 或 expects`);
    }
    steps.push(step);
  }
  return { name, deviceId, steps };
}

/**
 * 夜间窗口判定。
 *
 * 默认 22:00–07:00（跨午夜）。窗口用「分钟」表示，避免跨天时比较 Date 的麻烦。
 * 支持两种形态：
 *   - 跨午夜（start > end，如 22:00–07:00）→ `minutes >= start || minutes < end`
 *   - 同日（start < end，如 09:00–18:00）→ `minutes >= start && minutes < end`
 * start === end 视为「不启用夜间」，恒为白班。
 */
function isNight(date, window = {}) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = window.startMinute ?? 22 * 60;
  const end = window.endMinute ?? 7 * 60;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** 文件系统安全的时间戳，13 天里时区即使漂移，同一台机器内仍然单调可比。 */
function dateStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 把时间挪到当天 `endMinute` 的时刻；已过则挪到明天。 */
function nextWakeTime(current, window = {}) {
  const end = window.endMinute ?? 7 * 60;
  const wake = new Date(current);
  wake.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (wake.getTime() <= current.getTime()) wake.setDate(wake.getDate() + 1);
  return wake;
}

function createAutoPilot(options = {}) {
  const iosControl = options.iosControl;
  if (!iosControl) throw new Error('createAutoPilot 需要 iosControl');
  const takeScreenshot = options.takeScreenshot || (async () => null);
  const notify = options.notify || (() => {});
  const now = options.now || (() => new Date());
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const archiveDir = options.archiveDir || path.join(process.cwd(), 'autopilot-archive');
  const nightWindow = options.nightWindow || {};
  /** 同一手/位置连点阈值：低于此值认为是「失败太多，设备多半失联」 */
  const consecutiveFailureAlert = Number(options.consecutiveFailureAlert) || 3;
  /** 连续 N 轮整轮失败 → 升级告警 */
  const wholeRunFailureAlert = Number(options.wholeRunFailureAlert) || 3;
  /** 连续 N 次单步失败 → 重启 WDA 自愈 */
  const wdaRecoverAfterFailures = Number(options.wdaRecoverAfterFailures) || 5;

  let running = false;
  let currentScript = null;
  let currentRunId = null;
  let currentStepIndex = -1;
  let consecutiveFailures = 0;
  let wholeRunFailures = 0;
  let runs = 0;
  let lastRunAt = null;
  let lastRunSummary = null;
  let nightLocked = false;
  let loopPromise = null;

  const stats = {
    runs: 0,
    totalSteps: 0,
    failedSteps: 0,
    alerts: 0,
    startedAt: null,
    lastError: null
  };

  function snapshot() {
    return {
      running,
      scriptName: currentScript?.name || null,
      deviceId: currentScript?.deviceId || null,
      stepCount: currentScript?.steps.length || 0,
      currentStepIndex,
      runs,
      lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
      lastRunSummary: lastRunSummary
        ? {
          runId: lastRunSummary.runId,
          total: lastRunSummary.total,
          ok: lastRunSummary.ok,
          failed: lastRunSummary.failed,
          startedAt: lastRunSummary.startedAt.toISOString(),
          endedAt: lastRunSummary.endedAt.toISOString()
        }
        : null,
      nightLocked,
      archiveDir,
      stats: { ...stats }
    };
  }

  function ensureArchiveDir() {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  function archiveScreenshot(shot, runId, stepIndex, label) {
    try {
      ensureArchiveDir();
      const safeLabel = String(label || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
      const dir = path.join(archiveDir, dateStamp(now()), runId);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${String(stepIndex).padStart(3, '0')}${safeLabel ? `-${safeLabel}` : ''}.png`;
      const comma = String(shot.dataUrl).indexOf(',');
      const base64 = comma >= 0 ? String(shot.dataUrl).slice(comma + 1) : '';
      fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
    } catch (error) {
      // 截图归档失败不该中断脚本 —— 13 天里这是最常见的偶发失败
      apError(`归档截图失败（不中断脚本）：${error.message}`);
    }
  }

  /**
   * 把整轮结果落盘。**这是事后排查的唯一依据** —— 13 天里出问题没有它就完全瞎了。
   */
  function archiveRunSummary(runId, summary) {
    try {
      ensureArchiveDir();
      const dir = path.join(archiveDir, dateStamp(summary.startedAt), runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    } catch (error) {
      apError(`归档 run summary 失败：${error.message}`);
    }
  }

  /**
   * 告警出口：写 `ALERTS.md`（人回到机器第一件事就是看这个）+ 系统通知。
   *
   * 同一 key 一分钟内只发一次 —— 否则设备彻底失联时（每 30 分钟一轮）
   * 重复告警会刷屏，真正重要的那条被淹掉。
   */
  let lastAlert = { key: '', at: 0 };
  function raiseAlert(key, message) {
    const t = now().getTime();
    if (lastAlert.key === key && t - lastAlert.at < 60_000) return;
    lastAlert = { key, at: t };

    stats.alerts += 1;
    apError(`ALERT [${key}] ${message}`);
    try {
      ensureArchiveDir();
      const line = `${now().toISOString()} [${key}] ${message}\n`;
      fs.appendFileSync(path.join(archiveDir, 'ALERTS.md'), line, 'utf8');
    } catch (_) { /* ALERTS.md 写不进也要保证 notify 有机会发出 */ }
    try {
      notify({ title: 'AutoPilot 告警', body: `[${key}] ${message}` });
    } catch (_) { /* 通知接口挂掉不能拖垮主循环 */ }
  }

  /** 单次动作：失败重试一次（捕获 WDA 瞬时抖动 / iproxy 抖动）。 */
  async function executeAction(step) {
    switch (step.op) {
      case 'tap': return iosControl.tap(Number(step.x), Number(step.y));
      case 'longPress':
        return iosControl.longPress(Number(step.x), Number(step.y), Number(step.duration));
      case 'swipe':
        return iosControl.swipe(
          step.from, step.to, step.duration != null ? Number(step.duration) : undefined
        );
      case 'swipeDirection': return iosControl.swipeDirection(step.direction);
      case 'type': return iosControl.typeText(String(step.text ?? ''));
      case 'pressButton': return iosControl.pressButton(step.button);
      case 'pressHome': return iosControl.pressHome();
      case 'unlock': return iosControl.unlock();
      case 'launchApp': return iosControl.launchApp(step.bundleId);
      case 'terminateApp': return iosControl.terminateApp(step.bundleId);
      case 'zoom': return iosControl.zoom(step.mode, { duration: step.duration });
      default: throw new Error(`未实现的操作 ${step.op}`);
    }
  }

  /** 轮询直到前台 App 命中期望，或超时。 */
  async function pollActiveApp(matcher, timeoutMs) {
    const deadline = now().getTime() + timeoutMs;
    let active = null;
    for (;;) {
      try {
        active = await iosControl.activeApp();
        if (matcher(active)) return { matched: true, active };
      } catch (_) { /* 轮询本来就在重试，单次失败忽略 */ }
      if (now().getTime() >= deadline) return { matched: false, active };
      await delay(300);
    }
  }

  /**
   * 跑一步。抛错交给 runOnce 累计 —— 这里不做任何「吞错」，
   * 除了 screenshot（它是辅助信息，失败不该让脚本停）。
   */
  async function runStep(step, index, runId) {
    currentStepIndex = index;
    apLog(`run ${runId} step ${index + 1}/${currentScript.steps.length} op=${step.op}`);

    if (step.op === 'wait') {
      await delay(Number(step.ms) || 0);
      return { ok: true, op: 'wait' };
    }

    if (step.op === 'screenshot') {
      try {
        const shot = await takeScreenshot(currentScript.deviceId);
        if (shot) archiveScreenshot(shot, runId, index, step.label);
        return { ok: true, op: 'screenshot' };
      } catch (error) {
        apError(`screenshot 失败（不中断脚本）：${error.message}`);
        return { ok: false, op: 'screenshot', error: error.message };
      }
    }

    if (step.op === 'activeApp') {
      return { ok: true, op: 'activeApp', value: await iosControl.activeApp() };
    }

    if (step.op === 'assertActiveApp') {
      const expected = String(step.bundleId || '').trim();
      const result = await pollActiveApp(
        (active) => active?.bundleId === expected,
        Number(step.timeoutMs) || 5000
      );
      if (!result.matched) {
        throw new Error(
          `断言失败：期望前台 App 为 ${expected}，实际 ${result.active?.bundleId || '未知'}`
        );
      }
      return { ok: true, op: 'assertActiveApp', value: result.active };
    }

    if (step.op === 'assert') {
      const expects = step.expects || {};
      const result = await pollActiveApp(
        (active) => active && Object.entries(expects).every(([k, v]) => active[k] === v),
        Number(step.timeoutMs) || 5000
      );
      if (!result.matched) {
        throw new Error(
          `断言失败：期望 ${JSON.stringify(expects)}，实际 ${JSON.stringify(result.active)}`
        );
      }
      return { ok: true, op: 'assert', value: result.active };
    }

    try {
      return { ok: true, op: step.op, value: await executeAction(step) };
    } catch (firstError) {
      apError(`step ${index + 1} ${step.op} 失败：${firstError.message}，重试一次`);
      await delay(500);
      const value = await executeAction(step); // 再失败就抛给 runOnce
      apLog(`step ${index + 1} ${step.op} 重试成功`);
      return { ok: true, op: step.op, value, retried: true };
    }
  }

  /** WDA 级自愈：清会话 → 重启 → 探测。仅在连续失败达阈值时调用。 */
  async function recoverWda() {
    raiseAlert('wda-recovery', `连续 ${consecutiveFailures} 次失败，重启 WDA 自愈`);
    try {
      await iosControl.dropSession();
      await iosControl.stopWda();
      const probe = await iosControl.probe(currentScript.deviceId);
      if (!probe.reachable) await iosControl.startWda(currentScript.deviceId);
    } catch (error) {
      apError(`WDA 自愈失败：${error.message}`);
      raiseAlert('wda-recovery-failed', `WDA 重启失败：${error.message}`);
    }
  }

  /** 跑一轮：顺序执行 steps。整轮结果写入归档。 */
  async function runOnce(script) {
    // 防御：直接调用 _runOnce 时也兜底校验一次。start() 进来的已校验过也无害（白名单字段幂等）。
    script = normalizeScript(script);
    // 直接赋值而不是依赖 start() 先设置：让 _runOnce 单独可用（单测 / IPC 手动触发）
    currentScript = script;
    const runId = `${dateStamp(now())}-${Math.random().toString(36).slice(2, 8)}`;
    currentRunId = runId;
    const startedAt = now();
    const stepResults = [];
    let okCount = 0;
    let failedCount = 0;
    // 自愈后本轮作废（让下一轮从干净状态重头来更稳），用这个标志跳出
    let aborted = false;

    for (let i = 0; i < script.steps.length; i += 1) {
      const step = script.steps[i];
      try {
        stepResults.push(await runStep(step, i, runId));
        okCount += 1;
        consecutiveFailures = 0;
      } catch (error) {
        failedCount += 1;
        consecutiveFailures += 1;
        stats.failedSteps += 1;
        stats.lastError = error.message;
        stepResults.push({ ok: false, op: step.op, error: error.message });
        apError(`run ${runId} step ${i + 1} ${step.op} 失败：${error.message}`);

        if (consecutiveFailures >= wdaRecoverAfterFailures) {
          await recoverWda();
          aborted = true;
          break;
        }
        if (consecutiveFailures >= consecutiveFailureAlert) {
          raiseAlert('step-failures', `连续 ${consecutiveFailures} 步失败：${error.message}`);
        }
      }
    }

    const endedAt = now();
    const summary = {
      runId,
      script: script.name,
      deviceId: script.deviceId,
      startedAt,
      endedAt,
      durationMs: endedAt.getTime() - startedAt.getTime(),
      total: script.steps.length,
      executed: okCount + failedCount,
      ok: okCount,
      failed: failedCount,
      abortedByRecovery: aborted,
      steps: stepResults
    };
    lastRunAt = endedAt;
    lastRunSummary = summary;
    stats.totalSteps += summary.total;
    stats.runs += 1;
    runs += 1;
    archiveRunSummary(runId, summary);

    // 整轮全失败 → 升级告警（设备真掉线了，单步告警看不出「一轮都没成」）
    if (summary.failed === summary.total && summary.total > 0) {
      wholeRunFailures += 1;
      if (wholeRunFailures >= wholeRunFailureAlert) {
        raiseAlert('whole-run-failed', `脚本 "${script.name}" 已连续 ${wholeRunFailures} 轮全部失败`);
      }
    } else {
      wholeRunFailures = 0;
    }

    return summary;
  }

  /** 可中断 sleep：stop() 后不必等完整间隔就能退出。 */
  async function sleepInterruptible(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!running) return;
      await delay(Math.min(1000, deadline - Date.now()));
    }
  }

  /**
   * 调度主循环：白班跑 → 夜间锁屏休眠 → 早上解锁继续。
   *
   * 用 `while` + `sleepInterruptible` 而不是 setInterval：跨「白班/夜间」边界时
   * 每次都要重新判断，而且 stop 必须能立刻中断长休眠。
   */
  async function scheduleLoop() {
    const intervalMs = Math.max(1000, Number(options.intervalMs) || 30 * 60 * 1000);

    while (running) {
      if (isNight(now(), nightWindow)) {
        if (!nightLocked) {
          nightLocked = true;
          apLog('进入夜间窗口，锁屏省电');
          try {
            await iosControl.pressButton('power');
          } catch (error) {
            // 锁屏失败不值得告警：夜间本来就不跑任务
            apError(`夜间锁屏失败：${error.message}`);
          }
        }
        const wake = nextWakeTime(now(), nightWindow);
        const waitMs = Math.max(60_000, wake.getTime() - now().getTime());
        apLog(`夜间休眠约 ${Math.round(waitMs / 60000)} 分钟后唤醒`);
        await sleepInterruptible(waitMs);
        if (!running) return;
        nightLocked = false;
        // 早上唤醒：解锁失败要告警 —— 不解锁等于一整天白跑
        try {
          await iosControl.unlock();
        } catch (error) {
          apError(`唤醒解锁失败：${error.message}`);
          raiseAlert('wake-unlock-failed', `夜间唤醒后解锁失败：${error.message}`);
        }
        continue;
      }

      nightLocked = false;
      try {
        await runOnce(currentScript);
      } catch (error) {
        // runOnce 内部已捕获单步错误，这里兜底的是「不该发生」的顶层异常
        apError(`runOnce 顶层异常：${error.message}`);
      }
      if (!running) return;
      await sleepInterruptible(intervalMs);
    }
  }

  async function start(rawScript) {
    if (running) throw new Error('已经在运行，请先停止');
    currentScript = normalizeScript(rawScript); // 立刻校验，别跑到一半才发现脚本是废的
    running = true;
    consecutiveFailures = 0;
    wholeRunFailures = 0;
    nightLocked = false;
    currentStepIndex = -1;
    stats.startedAt = now();
    apLog(`start script=${currentScript.name} steps=${currentScript.steps.length} device=${currentScript.deviceId}`);
    loopPromise = scheduleLoop().catch((error) => {
      apError(`调度循环退出：${error.message}`);
      running = false;
    });
    return { ok: true, scriptName: currentScript.name, stepCount: currentScript.steps.length };
  }

  function stop() {
    if (!running) return { ok: true, already: true };
    running = false;
    apLog('stop 已请求（当前 step 跑完后退出）');
    return { ok: true, already: false };
  }

  return {
    start,
    stop,
    snapshot,
    stats,
    archiveDir,
    /** 校验但不起跑 —— 给 IPC / 前端「验证脚本」用 */
    validate: (raw) => {
      const normalized = normalizeScript(raw);
      return { ok: true, name: normalized.name, stepCount: normalized.steps.length };
    },
    /** 内部接口，仅单测使用 */
    _runOnce: runOnce,
    _isNight: (date) => isNight(date, nightWindow),
    _nextWakeTime: (date) => nextWakeTime(date, nightWindow),
    _waitForLoop: () => loopPromise
  };
}

module.exports = {
  createAutoPilot,
  normalizeScript,
  isNight,
  nextWakeTime,
  SUPPORTED_OPS
};