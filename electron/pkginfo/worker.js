'use strict';

/**
 * 包体静态信息解析 worker。
 *
 * 解析一个 5~6 秒的大包（淘宝 IPA、加固后的 APK）时，如果直接在主进程里跑
 * 同步代码，整个应用会卡住：进度条不动、窗口拖不动、点「取消」也没反应。
 * 放到 worker 线程里跑，主进程的事件循环始终空闲，进度事件可以立刻转发给
 * 渲染进程，UI 全程保持流畅。
 *
 * 协议：
 *   主线程 → worker   { filePath, kind }
 *   worker → 主线程   { type: 'progress', progress: { percent, stage, detail } }
 *                     { type: 'done',     result }
 *                     { type: 'error',    message, stack }
 */

const { parentPort, workerData } = require('worker_threads');
const { parsePackageStaticInfo } = require('./index');

function post(message) {
  try {
    parentPort.postMessage(message);
  } catch (_) {
    // 主线程已经终止了这个 worker，忽略即可
  }
}

try {
  const result = parsePackageStaticInfo(workerData.filePath, {
    kind: workerData.kind || undefined,
    onProgress: (progress) => post({ type: 'progress', progress })
  });
  post({ type: 'done', result });
} catch (error) {
  post({ type: 'error', message: error?.message || String(error), stack: error?.stack || '' });
}
