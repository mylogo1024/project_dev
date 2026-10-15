/**
 * 投屏操作录制 → 无人值守脚本的纯函数层。
 *
 * **为什么独立成 lib**：录制逻辑（间隔折算 wait、坐标取整、步数上限）
 * 必须可单测 —— 它直接决定 13 天无人值守重放的质量，坏一步就是一晚上空跑。
 * IosMirror 组件只做「何时调用」的胶水，规则全部在这里。
 *
 * **与 autopilot 契约对齐**：这里产出的 step 形状 = electron/autopilot.js 的
 * OP_KEY_WHITELIST 白名单。两边必须同步改，test/record-script.test.js 会盯住。
 */

/** 单个脚本最多记多少步。超过直接拒绝 —— 防误触 / 防内存失控。 */
export const MAX_STEPS = 500;

/** 两次动作间隔 ≥ 此值才折算成 wait 步（更短的间隔重放时无意义）。 */
export const WAIT_GAP_MIN_MS = 400;

/** 单个 wait 步的上限：更长的间隔说明人在犹豫/发呆，重放不该跟着等。 */
export const WAIT_CAP_MS = 10_000;

/** 坐标取整：设备逻辑坐标是浮点没必要，取整让脚本可读。 */
function roundPoint(point) {
  if (!point) return point;
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/**
 * 把一步记进录制（纯函数：返回新数组，不改入参）。
 *
 * @param {Array} steps 已有步骤
 * @param {object} step 新动作（autopilot 白名单形状）
 * @param {number} gapMs 距上一动作的真实间隔（ms）
 * @returns {Array} 新步骤数组
 */
export function appendRecordedStep(steps, step, gapMs) {
  const next = steps ? [...steps] : [];
  if (!step || !step.op) return next;
  if (next.length >= MAX_STEPS) return next;
  if (Number.isFinite(gapMs) && gapMs >= WAIT_GAP_MIN_MS) {
    next.push({ op: 'wait', ms: Math.min(WAIT_CAP_MS, Math.round(gapMs)) });
  }
  if (step.op === 'swipe') {
    next.push({
      op: 'swipe',
      from: roundPoint(step.from),
      to: roundPoint(step.to),
      duration: step.duration
    });
    return next;
  }
  if (step.op === 'tap') {
    next.push({ op: 'tap', x: Math.round(step.x), y: Math.round(step.y) });
    return next;
  }
  next.push({ ...step });
  return next;
}

/**
 * 组装成完整脚本对象。
 * 空录制返回 null（调用方自己提示「先操作几步」）。
 */
export function buildRecordedScript(steps, { deviceId, name, now = new Date() } = {}) {
  if (!steps || steps.length === 0) return null;
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return {
    name: name || `recorded-${stamp}`,
    deviceId: deviceId || '',
    steps: steps.map((step) => ({ ...step }))
  };
}

/**
 * 步骤的人类可读描述（录制面板 / 步骤列表用）。
 * 「tap (100,200)」比 JSON 更适合人扫一眼确认录制对不对。
 */
export function describeStep(step) {
  if (!step) return '';
  switch (step.op) {
    case 'tap': return `点击 (${step.x}, ${step.y})`;
    case 'longPress': return `长按 (${step.x}, ${step.y})`;
    case 'swipe': return `滑动 (${step.from?.x},${step.from?.y}) → (${step.to?.x},${step.to?.y})`;
    case 'swipeDirection': return `向${describeDirection(step.direction)}滑一屏`;
    case 'type': return `输入「${String(step.text).slice(0, 12)}」`;
    case 'pressButton': return describeButton(step.button);
    case 'pressHome': return '回到主屏';
    case 'unlock': return '解锁屏幕';
    case 'launchApp': return `启动 ${step.bundleId}`;
    case 'terminateApp': return `关闭 ${step.bundleId}`;
    case 'activeApp': return '读取前台 App';
    case 'assertActiveApp': return `校验前台 = ${step.bundleId}`;
    case 'assert': return '校验断言';
    case 'wait': return `等待 ${step.ms}ms`;
    case 'screenshot': return step.label ? `截图「${step.label}」` : '截图';
    case 'zoom': return step.mode === 'in' ? '双指放大' : '双指缩小';
    default: return step.op;
  }
}

function describeDirection(direction) {
  return { up: '上', down: '下', left: '左', right: '右' }[direction] || String(direction);
}

function describeButton(button) {
  return {
    home: 'Home 键',
    volumeUp: '音量+',
    volumeDown: '音量-',
    power: '电源键'
  }[button] || `按键 ${button}`;
}