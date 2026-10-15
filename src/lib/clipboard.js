'use strict';

// 注意：这里必须写扩展名。Node 的原生 ESM 解析不做扩展名补全，
// 而 src/lib 下的模块要能被 `node --test` 直接 require（Vite 则两者都能解析）。
import { toastError, toastSuccess, toastWarning } from './toastStore.js';

/**
 * 统一的剪贴板写入。
 *
 * **为什么需要**：原先 13 处调用点里，8 处既不 `await` 也不 `catch` ——
 * 失败时界面毫无反应；`DeviceInfo.jsx` 更是**无条件**提示「已复制到剪贴板」，
 * 权限被拒时提示成功但剪贴板是空的。**假成功比崩溃更伤信任，因为用户以为做成了。**
 *
 * 两条路都要留（这是 `WebFileServer.jsx` 里验证过的经验）：
 * 异步 API 会因「窗口没有焦点」或「权限被拒」抛错
 * （`Document is not focused.` / `Write permission denied.`），
 * 这时旧的 `execCommand` 往往还能用。
 *
 * `env` 参数用于注入依赖，让这套 DOM 逻辑也能被单测覆盖。
 */

const EMPTY = 'empty';
const UNSUPPORTED = 'unsupported';
const FAILED = 'failed';

export async function copyText(text, env = {}) {
  const value = String(text ?? '');
  // 空内容不该被当成「复制成功」
  if (!value) return { ok: false, reason: EMPTY };

  const clipboard = env.clipboard !== undefined
    ? env.clipboard
    : (typeof navigator !== 'undefined' ? navigator.clipboard : null);
  const doc = env.document !== undefined
    ? env.document
    : (typeof document !== 'undefined' ? document : null);

  let asyncError = null;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return { ok: true, via: 'async' };
    } catch (error) {
      asyncError = error; // 继续走 execCommand 兜底
    }
  }

  if (!doc?.createElement || typeof doc.execCommand !== 'function' || !doc.body) {
    return { ok: false, reason: UNSUPPORTED, error: asyncError };
  }

  let node = null;
  try {
    node = doc.createElement('textarea');
    node.value = value;
    node.setAttribute('readonly', '');
    node.style.position = 'fixed';
    node.style.top = '-1000px';
    doc.body.appendChild(node);
    node.select();
    const copied = doc.execCommand('copy');
    if (!copied) return { ok: false, reason: FAILED, error: asyncError };
    return { ok: true, via: 'execCommand' };
  } catch (error) {
    return { ok: false, reason: FAILED, error };
  } finally {
    // 无论成败都要摘掉临时节点，否则会在 DOM 里越积越多
    try {
      node?.remove();
    } catch (_) { /* 节点可能已经不在文档里，忽略 */ }
  }
}

/**
 * 复制并给出用户反馈 —— 成功才说成功，失败必须说失败。
 * 这是各调用点最常用的形态，避免每处都重写一遍判断。
 * `options.env` 用于注入依赖（测试用）。
 */
export async function copyTextWithToast(text, options = {}) {
  const {
    successText = '已复制到剪贴板',
    emptyText = '没有可复制的内容',
    env
  } = options;

  const result = await copyText(text, env);

  if (result.ok) {
    toastSuccess(successText);
  } else if (result.reason === EMPTY) {
    toastWarning(emptyText);
  } else {
    toastError('复制失败，请手动选中后复制');
  }

  return result;
}

export const COPY_REASONS = { EMPTY, UNSUPPORTED, FAILED };
