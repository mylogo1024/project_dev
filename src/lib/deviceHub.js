'use strict';

/**
 * 设备工作台的统一设备模型。
 *
 * 为什么要统一：项目里 Android / iOS 设备列表各有 6 个组件在各自拉取、各自 normalize，
 * 「设备墙」要一次显示全部设备，就必须有一个合并层。规则集中在这里，可单测。
 *
 * 职责：
 * 1. normalizeDevice：把 adb / idevice 返回的杂形状收敛成 { id, platform, name, model, version, label }
 * 2. mergeDevices：Android + iOS 两份列表合成一堵墙（平台分组、稳定排序）
 * 3. QUICK_ACTIONS：设备卡片上的快捷动作 —— 「点哪个工具直达哪台设备」的链路入口
 * 4. pickQuickAction：给一台设备挑默认动作（iOS 无 scrcpy，直接进 iOS 投屏）
 */

export const PLATFORM_LABELS = {
  android: 'Android',
  ios: 'iOS'
};

const PLATFORM_ORDER = { ios: 0, android: 1 };

/**
 * 收敛一台设备的形状。getLogDevices 返回的设备对象字段不一
 * （android 只有 id；ios 有 name/model/version），这里全部兜住。
 */
export function normalizeDevice(device) {
  if (typeof device === 'string') return { id: device, platform: 'android', name: device, model: null, version: null, label: device };
  const id = device?.id || device?.deviceId || device?.udid || '';
  const platform = device?.platform === 'ios' ? 'ios' : 'android';
  const name = device?.name || device?.label || id;
  const label = device?.label || (device?.name && device?.name !== id ? `${device.name} (${id})` : name);
  return {
    ...device,
    id,
    platform,
    name,
    model: device?.model || null,
    version: device?.version || null,
    label: label || id
  };
}

/**
 * 合并两平台的设备列表成一堵墙：iOS 在前（操控链路最完整），
 * 同平台内按 label 稳定排序。无效项（无 id）直接丢弃。
 */
export function mergeDevices(androidList, iosList) {
  const all = []
    .concat(Array.isArray(androidList) ? androidList : [])
    .concat(Array.isArray(iosList) ? iosList : [])
    .map(normalizeDevice)
    .filter((device) => device.id);
  return all.sort((a, b) => (
    (PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform])
    || String(a.label).localeCompare(String(b.label), 'zh-CN')
  ));
}

/**
 * 设备卡片副标题：一行字讲清这台设备是什么（型号 · 版本 · 序列号截断）。
 */
export function describeDevice(device) {
  const normalized = normalizeDevice(device);
  const parts = [];
  if (normalized.model && normalized.model !== normalized.id) parts.push(normalized.model);
  if (normalized.version) parts.push(`${PLATFORM_LABELS[normalized.platform]} ${normalized.version}`);
  const tail = parts.length ? parts.join(' · ') : (normalized.id.length > 18 ? `${normalized.id.slice(0, 16)}…` : normalized.id);
  return tail || normalized.platform;
}

/**
 * 快捷动作：设备 → 工具的直达链路。
 * `target` 是 functions.js 里的功能 id；`match` 决定某平台是否显示该动作。
 * iOS 不经过 scrcpy（进的是 IosMirror），所以 iOS 卡片上写「iOS 投屏」直达 scrcpy 功能页的 ios tab。
 */
export const QUICK_ACTIONS = [
  { key: 'mirror', label: '投屏操控', icon: '🖥️', target: 'scrcpy', platforms: ['android', 'ios'] },
  { key: 'logs', label: '实时日志', icon: '📋', target: 'logs', platforms: ['android', 'ios'] },
  { key: 'files', label: '文件管理', icon: '📂', target: 'files', platforms: ['android', 'ios'] },
  { key: 'apps', label: '应用管理', icon: '📱', target: 'apps', platforms: ['android', 'ios'] },
  { key: 'info', label: '设备信息', icon: '📲', target: 'phone-device', platforms: ['android', 'ios'] }
];

/** 给一台设备返回它可用的快捷动作。 */
export function quickActionsFor(device) {
  const platform = device?.platform === 'ios' ? 'ios' : 'android';
  return QUICK_ACTIONS.filter((action) => action.platforms.includes(platform));
}

/** 设备卡的默认动作：iOS 无 scrcpy 直达投屏；Android 也进投屏（工作台主入口）。 */
export function pickQuickAction(device) {
  const actions = quickActionsFor(device);
  return actions.find((action) => action.key === 'mirror') || actions[0] || null;
}

/**
 * 把「设备 + 目标功能」解析成 renderFunction 需要的深链参数。
 * 返回 { functionId, device }，device 是 normalize 之后的完整对象。
 */
export function resolveDeepLink(device, targetFunctionId) {
  const normalized = normalizeDevice(device);
  if (!normalized.id) return null;
  return { functionId: targetFunctionId, device: normalized };
}
