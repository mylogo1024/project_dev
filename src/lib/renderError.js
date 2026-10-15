'use strict';

/**
 * 把渲染期错误整理成「可以直接复制反馈」的文本。
 *
 * 抽成独立模块是为了能单测：`error` 可能是 Error、字符串、null 或任意对象，
 * 整理逻辑一旦二次抛出，错误边界本身就成了新的崩溃源。
 */
export function formatRenderError(error, componentStack = '') {
  const message = error?.message ?? error ?? '未知错误';
  const stack = error?.stack || '(无堆栈)';

  return [
    `错误：${message}`,
    '',
    stack,
    componentStack ? `\n组件栈：${componentStack}` : ''
  ].join('\n');
}

/**
 * 判断「重新加载」后是否应该清掉错误状态。
 * 只要 resetKey 变了就说明用户主动重试过，必须给一次干净的机会，
 * 否则界面会永远停在错误页。
 */
export function shouldResetError(hasError, previousKey, nextKey) {
  return Boolean(hasError) && previousKey !== nextKey;
}
