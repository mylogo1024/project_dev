'use strict';

/**
 * 统一的错误文案处理。
 *
 * **为什么需要**：`ipcErrorText` 曾被**复制到 4 个文件**
 * （ApkInfo / BatchScan / Settings / SignApk），实现都是 `String(error?.message || error)` ——
 * 没有清洗 Electron 注入的前缀。于是用户会看到：
 *
 *     Error invoking remote method 'parse-package-info': Error: 文件不存在
 *
 * 而 `HttpClient.jsx` 里另有一份实现**做了**清洗 —— **同类问题两套处理**，
 * 这正是「体验不一致」的典型来源：同一个问题在多处各写一遍，
 * 就必然出现「有的地方处理了、有的没处理」。
 *
 * 现在收口到这里，所有调用点行为一致。
 */

/**
 * Electron 在 `ipcRenderer.invoke` 失败时会给消息套一层前缀，
 * 主进程的错误再套一层就会叠加，所以循环剥掉。
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

const DEFAULT_FALLBACK = '操作失败';

/** 剥掉 Electron 的 IPC 前缀，返回可以直接给用户看的一句话。 */
export function cleanIpcError(error, fallback = DEFAULT_FALLBACK) {
  // 原来各处都用 `String(error?.message || error)`，遇到普通对象会显示 `[object Object]`。
  // 这里只认「能取出人话」的形态，其余一律退回 fallback。
  let raw = '';
  if (typeof error === 'string') raw = error;
  else if (error instanceof Error) raw = error.message;
  else if (error && typeof error === 'object' && typeof error.message === 'string') raw = error.message;

  raw = raw.trim();
  if (!raw) return fallback;

  let cleaned = raw;
  // 嵌套调用会叠加多层前缀，全部剥掉
  while (IPC_PREFIX.test(cleaned)) {
    cleaned = cleaned.replace(IPC_PREFIX, '').trim();
  }
  return cleaned || fallback;
}

/**
 * 判断这条消息是否还残留技术细节（供界面决定要不要折叠展示）。
 * 只做保守判断，宁可漏判也不要误把正常文案标成技术细节。
 */
export function looksTechnical(message) {
  const text = String(message ?? '');
  return /Error invoking remote method|\bat\s+\S+\s*\(|ENOENT|EACCES|EPERM|TypeError|ReferenceError/.test(text);
}

/**
 * 把错误拆成「给用户看的一句话」+「可折叠的技术细节」。
 * 界面上永远先展示 message，detail 只在需要时展开。
 */
export function describeError(error, fallback = DEFAULT_FALLBACK) {
  const message = cleanIpcError(error, fallback);
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  return {
    message,
    // 消息本身已经很干净时就没必要再给堆栈
    detail: looksTechnical(message) || !stack ? '' : stack
  };
}
