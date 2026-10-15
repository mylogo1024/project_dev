import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BasicView, DetailView, DiffView } from '../src/components/ApkInfo';
import BatchScan from '../src/components/BatchScan';
import PackageInfo from '../src/components/PackageInfo';
import PlatformMatrix from '../src/components/PlatformMatrix';
import InstallApk from '../src/components/InstallApk';
import TextTools from '../src/components/TextTools';
import { ProgressBar, Toast } from '../src/components/common/Feedback';

/**
 * 静态渲染入口：把真实解析结果渲染成 HTML 字符串。
 * 由 tools/make-preview.js 调用（esbuild 打包成 CJS 后 require）。
 */
export function renderBasic(info) {
  return renderToStaticMarkup(
    React.createElement(BasicView, { info, onOpenDetail: () => {} })
  );
}

export function renderDetail(info, sectionId) {
  return renderToStaticMarkup(
    React.createElement(DetailView, { info, initialSection: sectionId })
  );
}

export function renderDiff(payload) {
  return renderToStaticMarkup(
    React.createElement(DiffView, {
      diff: payload.diff,
      before: payload.before,
      after: payload.after,
      onClose: () => {}
    })
  );
}

/** 批量扫描面板（用真实扫描结果预填）。 */
export function renderBatchScan(rows, directory, result) {
  return renderToStaticMarkup(
    React.createElement(BatchScan, {
      initialRows: rows,
      initialDirectory: directory,
      initialResult: result
    })
  );
}

/** 合并后的「读取应用信息」页：单个包体 / 批量扫描 两个模式。 */
export function renderPackageInfo({ mode = 'single', rows = null, directory = '', result = null } = {}) {
  return renderToStaticMarkup(
    React.createElement(PackageInfo, {
      initialMode: mode,
      initialRows: rows,
      initialDirectory: directory,
      initialResult: result
    })
  );
}

/** 平台能力矩阵（用真实检测结果预填）。 */
export function renderPlatformMatrix(data) {
  return renderToStaticMarkup(
    React.createElement(PlatformMatrix, { initialData: data })
  );
}

/** 安装应用到设备：单个 / 批量。 */
export function renderInstall(options = {}) {
  return renderToStaticMarkup(React.createElement(InstallApk, options));
}

/** 文本工具的几种典型状态（用于走查新增功能）。 */
export function renderTextTools(options = {}) {
  return renderToStaticMarkup(React.createElement(TextTools, options));
}

/** 进度条 + 提示条的各种状态。 */
export function renderFeedbackShowcase() {
  const bar = (props) => renderToStaticMarkup(React.createElement(ProgressBar, props));

  const rows = [
    ['不确定进度（刚启动，还没拿到阶段）', bar({ percent: null, stage: '正在解析包体静态信息', elapsedMs: 0 })],
    ['确定进度 + 阶段 + 明细 + 取消', bar({
      percent: 46,
      stage: '解析签名信息（v1 / v2 / v3）',
      detail: 'META-INF/CERT.RSA',
      elapsedMs: 2140,
      onCancel: () => {}
    })],
    ['带阶段清单（每个阶段走完变绿）', bar({
      percent: 70,
      stage: '解析原生库（.so）',
      detail: 'lib/arm64-v8a/libc++_shared.so',
      elapsedMs: 5120,
      onCancel: () => {},
      steps: [
        { label: '打开包体容器', done: true },
        { label: '计算文件摘要', done: true },
        { label: '解析 AndroidManifest.xml', done: true },
        { label: '解析资源表 resources.arsc', done: true },
        { label: '解析签名信息', done: true },
        { label: '解析 DEX 字节码', done: true },
        { label: '解析原生库（.so）', done: false, active: true },
        { label: '识别第三方 SDK 与加固方案', done: false },
        { label: '评估安全风险评分', done: false }
      ]
    })],
    ['完成态（绿色）', bar({ percent: 100, stage: '解析完成', elapsedMs: 5242 })],
    ['紧凑模式（用于列表行内）', bar({ percent: 62, stage: '批量扫描 3/8 · 永远的蔚蓝星球', compact: true, elapsedMs: 18300 })]
  ];

  const toasts = [
    ['success', '永远的蔚蓝星球', '199.55 MB · 耗时 5.2 秒 · 3 条提示'],
    ['error', '解析失败', '读取应用信息失败: 文件不存在: /tmp/gone.apk'],
    ['warning', '3 个字段解析失败', 'resources.arsc 解析失败: 未找到资源表'],
    ['info', '已取消解析', '']
  ];

  return `<div class="content-card">
  <h2>进度与提示</h2>
  <p class="pi-hint">
    长时间操作（解析 5~6 秒的大包、批量扫描几十个包体）全程给出阶段、百分比与已耗时，
    并提供取消入口；结果与异常统一用提示条反馈，不再只有一行静态「加载中」。
  </p>
  <h3 style="font-size:14px;color:#202124;margin:18px 0 4px">进度条</h3>
  ${rows.map(([title, html]) => `<div style="margin-bottom:16px">
    <div style="font-size:12px;color:#80868b;margin-bottom:4px">${title}</div>
    ${html}
  </div>`).join('')}
  <h3 style="font-size:14px;color:#202124;margin:18px 0 10px">提示条</h3>
  <div class="ui-toast-stack">
    ${toasts.map(([type, text, detail]) => renderToStaticMarkup(
      React.createElement(Toast, { type, text, detail: detail || undefined, onClose: () => {} })
    )).join('')}
  </div>
</div>`;
}
