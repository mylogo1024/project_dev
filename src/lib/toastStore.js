'use strict';

/**
 * 全局提示条（toast）。
 *
 * **为什么需要**：项目里原本散着 16 处 `alert()` —— 阻塞式系统弹窗，
 * 会打断用户操作，样式也和应用完全脱节。`common/Feedback.jsx` 里其实
 * 已经有 `Toast` / `ToastStack`，但没有全局出口，各组件只能各弹各的。
 *
 * **为什么用模块级订阅而不是 Context**：调用点常常在 `await` 之后或
 * 非组件模块里，拿不到 hook 的引用；模块级 store 在任何地方都能调。
 */

const MAX_VISIBLE = 4;
const DEFAULT_TIMEOUT = 4000;

let toasts = [];
let counter = 0;
const listeners = new Set();
const timers = new Map();

function emit() {
  for (const listener of listeners) {
    try {
      listener(toasts);
    } catch (_) { /* 单个订阅者抛错不能影响其它订阅者 */ }
  }
}

export function subscribeToasts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts() {
  return toasts;
}

export function dismissToast(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/**
 * 推一条提示。返回 id（可用于手动关闭），text 为空时什么都不做。
 * 超过上限会挤掉最早的，避免刷屏把界面盖住。
 */
export function pushToast({ type = 'info', text, detail, timeout = DEFAULT_TIMEOUT } = {}) {
  if (text === undefined || text === null || text === '') return null;

  counter += 1;
  const id = `toast-${counter}`;
  toasts = [...toasts.slice(-(MAX_VISIBLE - 1)), { id, type, text: String(text), detail }];
  emit();

  if (timeout > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), timeout));
  }
  return id;
}

export const toastSuccess = (text, detail) => pushToast({ type: 'success', text, detail });
export const toastWarning = (text, detail) => pushToast({ type: 'warning', text, detail });
export const toastInfo = (text, detail) => pushToast({ type: 'info', text, detail });

/**
 * 错误提示**默认不自动消失**。
 *
 * 原因：错误详情常常带一长串路径与原因，4 秒既读不完也来不及复制，
 * 而消失之后就再也找不回来了（没有错误历史）。出错时是用户最需要信息的时刻，
 * 不该把信息拿走。需要自动消失的调用方可以显式传 `timeout`。
 */
export const toastError = (text, detail, timeout = 0) => pushToast({ type: 'error', text, detail, timeout });

/** 只给测试用：清空提示与定时器，避免测试之间互相污染。 */
export function resetToasts() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  counter = 0;
  emit();
}
