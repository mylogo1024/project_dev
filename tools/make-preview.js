'use strict';

/**
 * 生成「读取应用信息」界面的静态预览 HTML。
 *
 * 目的：不启动 Electron 也能审阅概览页 / 详情页 / 对比页的真实渲染效果。
 * 做法：用 esbuild 把真实的 React 组件打包成 CJS，再用 react-dom/server
 *       把真实解析结果渲染成静态 HTML，并内联 App.css。
 *
 * 用法：node tools/make-preview.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'preview');
const OUT_FILE = path.join(OUT_DIR, 'apk-info-preview.html');
// 打包产物必须落在项目内，否则 Node 无法从 /tmp 解析 react
const BUNDLE = path.join(__dirname, '.preview-bundle.cjs');

// 预览用的真实包体（存在则用，缺失自动跳过）
const APK_CANDIDATES = [
  path.join(ROOT, '..', 'QA_AUTO', 'apks', 'csfusion.apk'),
  '/Users/violet/Documents/other_dev/QA_AUTO/apks/csfusion.apk',
  '/Users/violet/Documents/other_dev/QA_AUTO/apks/wlxq2855_wlxq2855_sign.apk',
  '/Users/violet/Downloads/ly_xgwh5.apk'
];
const IPA_CANDIDATES = [
  '/Users/violet/Downloads/i4ToolsDownloads/App/淘宝_10.66.1（正版）.ipa',
  '/Users/violet/Downloads/HYquickXFHXSdk.ipa'
];

const DETAIL_SECTIONS = ['2.1', '2.6', '2.8', '2.14', '2.15', '2.16', '2.19'];

/** 批量扫描预览用的候选目录。 */
const BATCH_DIR_CANDIDATES = [
  path.join(ROOT, '..', 'QA_AUTO', 'apks'),
  '/Users/violet/Documents/other_dev/QA_AUTO/apks',
  '/Users/violet/Downloads'
];

/** 近似 tool-env 的工具探测：只查 PATH，够预览用了。 */
function makeDetectTool() {
  return async (tool) => {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, tool);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return { installed: true, path: candidate };
      } catch (_) {
        // 继续找
      }
    }
    return { installed: false, path: null };
  };
}

function firstExisting(list) {
  return list.find((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** 预览用的假设备（不连真机，只展示下拉框的渲染效果）。 */
const PREVIEW_DEVICES = [
  { id: 'emulator-5554', label: 'Pixel 7 · Android 14（emulator-5554）' }
];

/**
 * 构建「安装应用到设备」的预览视图。
 *
 * 用真实包体（batchDir 里的 apk/ipa）当素材；再补两条合成条目，
 * 用来展示「与目标设备类型不符」和「不支持的文件类型」两种预检提示。
 */
function buildInstallTabs(renderer, batchDir) {
  const { collectPackages } = require(path.join(ROOT, 'electron', 'pkginfo', 'batch'));
  const { formatBytes } = require(path.join(ROOT, 'electron', 'pkginfo', 'util'));

  const dir = batchDir || '/Users/you/Downloads';
  let real = [];
  if (batchDir) {
    try {
      real = collectPackages(batchDir, { recursive: false, limit: 12 })
        .filter((file) => file.path.toLowerCase().endsWith('.apk'));
    } catch (_) { /* 目录不可读就用合成数据 */ }
  }

  const samples = real.length ? real.slice(0, 3) : [
    { path: path.join(dir, '示例应用_1.0.0.apk'), name: '示例应用_1.0.0.apk', size: 12345678 },
    { path: path.join(dir, '示例游戏_2.3.1.apk'), name: '示例游戏_2.3.1.apk', size: 209715200 },
    { path: path.join(dir, '示例工具_0.9.4.apk'), name: '示例工具_0.9.4.apk', size: 5242880 }
  ].map((file) => ({ ...file, size_human: formatBytes(file.size) }));

  const withSize = (file) => (file.size_human ? file : { ...file, size_human: formatBytes(file.size) });

  // 类型不符 / 不支持：靠预检提前拦下，而不是等 adb 报错
  const mismatched = {
    path: path.join(dir, '同名 iOS 版本.ipa'),
    name: '同名 iOS 版本.ipa',
    size: 88080384,
    size_human: formatBytes(88080384)
  };
  const unsupported = {
    path: path.join(dir, '安装说明.txt'),
    name: '安装说明.txt',
    size: 2048,
    size_human: formatBytes(2048)
  };

  const tabs = [];

  // 1) 单个安装：文件与设备都选好，等待点击
  tabs.push({
    id: 'install-single',
    label: '安装应用 · 单个',
    html: renderer.renderInstall({
      initialMode: 'single',
      initialPlatform: 'android',
      initialPackagePath: samples[0].path,
      initialDevices: PREVIEW_DEVICES,
      initialDevice: PREVIEW_DEVICES[0].id
    })
  });

  // 2) 批量安装：列表就绪，含两条预检提示
  tabs.push({
    id: 'install-batch',
    label: '安装应用 · 批量（就绪）',
    html: renderer.renderInstall({
      initialMode: 'batch',
      initialPlatform: 'android',
      initialDevices: PREVIEW_DEVICES,
      initialDevice: PREVIEW_DEVICES[0].id,
      initialFiles: [
        ...samples.map(withSize),
        { ...mismatched, status: 'skipped', reason: '与目标设备类型不符：目标是 Android，文件是 iOS' },
        { ...unsupported, status: 'skipped', reason: '不支持的文件类型（.TXT），仅支持 APK / IPA' }
      ]
    })
  });

  // 3) 批量安装进行中：第 1 个已装完，第 2 个正在装，第 3 个排队
  tabs.push({
    id: 'install-running',
    label: '安装应用 · 批量（进行中）',
    html: renderer.renderInstall({
      initialMode: 'batch',
      initialPlatform: 'android',
      initialRunning: true,
      initialElapsedMs: 23400,
      initialDevices: PREVIEW_DEVICES,
      initialDevice: PREVIEW_DEVICES[0].id,
      initialProgress: { percent: 46, stage: '批量安装 2/5 · 示例游戏_2.3.1.apk', itemPercent: 45 },
      initialFiles: [
        { ...withSize(samples[0]), status: 'success' },
        { ...withSize(samples[1]), status: 'running', itemPercent: 45 },
        { ...withSize(samples[2]), status: 'pending' },
        { ...mismatched, status: 'skipped', reason: '与目标设备类型不符：目标是 Android，文件是 iOS' }
      ]
    })
  });

  // 4) 批量安装完成：成功 / 失败 / 跳过 三种结果都有
  tabs.push({
    id: 'install-done',
    label: '安装应用 · 批量（完成）',
    html: renderer.renderInstall({
      initialMode: 'batch',
      initialPlatform: 'android',
      initialElapsedMs: 41200,
      initialDevices: PREVIEW_DEVICES,
      initialDevice: PREVIEW_DEVICES[0].id,
      initialProgress: { percent: 100, stage: '批量安装完成' },
      initialSummary: { total: 5, success: 2, failed: 1, skipped: 2, pending: 0, running: 0 },
      initialFiles: [
        { ...withSize(samples[0]), status: 'success' },
        { ...withSize(samples[1]), status: 'failed', message: 'INSTALL_FAILED_OLDER_SDK: 应用需要更高的 Android 版本' },
        { ...withSize(samples[2]), status: 'success' },
        { ...mismatched, status: 'skipped', reason: '与目标设备类型不符：目标是 Android，文件是 iOS' },
        { ...unsupported, status: 'skipped', reason: '不支持的文件类型（.TXT），仅支持 APK / IPA' }
      ]
    })
  });

  return tabs;
}

function buildBundle() {
  const esbuild = require('esbuild');
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'tools', 'preview-entry.jsx')],
    bundle: true,
    outfile: BUNDLE,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/server'],
    logLevel: 'warning'
  });
  return require(BUNDLE);
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function main() {
  const { parsePackageStaticInfo, comparePackageInfo } = require(path.join(ROOT, 'electron', 'pkginfo'));
  const renderer = buildBundle();

  const apkPath = firstExisting(APK_CANDIDATES);
  const ipaPath = firstExisting(IPA_CANDIDATES);

  if (!apkPath && !ipaPath) {
    console.error('未找到可用的测试包体，无法生成预览。');
    process.exit(1);
  }

  const tabs = [];

  if (apkPath) {
    const info = parsePackageStaticInfo(apkPath);
    const name = path.basename(apkPath);
    tabs.push({ id: 'apk-basic', label: `概览页 · ${name}`, html: renderer.renderBasic(info) });
    for (const sid of DETAIL_SECTIONS) {
      if (!info.detailed[sid]) continue;
      const title = (info.sections.find((s) => s.id === sid) || {}).title || sid;
      tabs.push({ id: `apk-${sid}`, label: `${sid} ${title}`, html: renderer.renderDetail(info, sid) });
    }

    // 版本对比：同一包体对比自身（用于展示差异视图的完整结构）
    const secondPath = firstExisting(APK_CANDIDATES.filter((p) => p !== apkPath));
    const other = secondPath ? parsePackageStaticInfo(secondPath) : info;
    const diffPayload = {
      before: { basic: info.basic, container: info.container },
      after: { basic: other.basic, container: other.container },
      diff: comparePackageInfo(info, other)
    };
    tabs.push({ id: 'apk-diff', label: '版本对比', html: renderer.renderDiff(diffPayload) });

    // 签名状态：v1 失效是「看着像签了、其实没签」的典型形态，
    // 这里把三种形态都渲染出来，方便肉眼核对文案与配色。
    const realSig = info.basic.signature || {};
    const sigVariants = [
      ['正常', realSig],
      ['v1 已失效（无其他有效方案）', {
        ...realSig,
        signed: false,
        type: '签名无效（v1 摘要不匹配）',
        schemes: [],
        v1_present: true,
        v1_stale: true,
        v1_stale_note: '12 个条目的摘要对不上（APK 可能在 v1 签名后被重打包或加固过）'
      }],
      ['v1 已失效（v2 仍然有效）', {
        ...realSig,
        signed: true,
        type: 'v2',
        schemes: ['v2'],
        v1_present: true,
        v1_stale: true,
        v1_stale_note: '3 个条目的摘要对不上（APK 可能在 v1 签名后被重打包或加固过）'
      }]
    ];
    sigVariants.forEach(([label, signature], index) => {
      tabs.push({
        id: `apk-sig-${index}`,
        label: `签名状态 · ${label}`,
        html: renderer.renderBasic({ ...info, basic: { ...info.basic, signature } })
      });
    });
  }

  // ---------- 文本工具（新增的行数统计/字数统计/去重/查找/替换） ----------
  const sampleLines = [
    'Hello world',
    '你好世界',
    'Hello world',
    'Line 3',
    '',
    'The quick brown fox jumps over the lazy dog.',
    '123 456 789'
  ].join('\n');

  tabs.push({ id: 'text-dedup', label: '文本工具 · 去重', html: renderer.renderTextTools({ initialTool: 'dedup', initialInput: sampleLines }) });
  tabs.push({ id: 'text-find', label: '文本工具 · 查找', html: renderer.renderTextTools({ initialTool: 'find', initialInput: sampleLines, initialFindText: 'Hello' }) });
  tabs.push({ id: 'text-replace', label: '文本工具 · 替换', html: renderer.renderTextTools({ initialTool: 'replace', initialInput: sampleLines, initialFindText: 'world', initialReplaceText: 'Earth' }) });
  tabs.push({ id: 'text-linecount', label: '文本工具 · 行数统计', html: renderer.renderTextTools({ initialTool: 'linecount', initialInput: sampleLines }) });
  tabs.push({ id: 'text-wordcount', label: '文本工具 · 字数统计', html: renderer.renderTextTools({ initialTool: 'wordcount', initialInput: sampleLines }) });

  if (ipaPath) {
    const info = parsePackageStaticInfo(ipaPath);
    const name = path.basename(ipaPath);
    tabs.push({ id: 'ipa-basic', label: `概览页 · ${name}`, html: renderer.renderBasic(info) });
    for (const sid of ['2.3', '2.5', '2.9', '2.11', '2.14', '2.16', '2.19']) {
      if (!info.detailed[sid]) continue;
      const title = (info.sections.find((s) => s.id === sid) || {}).title || sid;
      tabs.push({ id: `ipa-${sid}`, label: `${sid} ${title}`, html: renderer.renderDetail(info, sid) });
    }
  }

  // ---------- 进度条 / 提示条 ----------
  tabs.push({ id: 'feedback', label: '进度与提示', html: renderer.renderFeedbackShowcase() });

  // ---------- 批量扫描 ----------
  const batchDir = BATCH_DIR_CANDIDATES.find((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
  if (batchDir) {
    const { collectPackages, summarizePackage, failureRow } = require(path.join(ROOT, 'electron', 'pkginfo', 'batch'));
    const files = collectPackages(batchDir, { recursive: false, limit: 30 });
    const rows = [];
    let succeeded = 0;
    let failed = 0;
    const startedAt = Date.now();
    for (const file of files) {
      try {
        rows.push(summarizePackage(parsePackageStaticInfo(file.path), file));
        succeeded += 1;
      } catch (error) {
        rows.push(failureRow(file, error));
        failed += 1;
      }
    }
    const summary = {
      directory: batchDir,
      total: files.length,
      succeeded,
      failed,
      rows,
      elapsed_ms: Date.now() - startedAt
    };
    tabs.push({
      id: 'package-info-single',
      label: '读取应用信息 · 单个包体',
      html: renderer.renderPackageInfo({ mode: 'single' })
    });
    tabs.push({
      id: 'package-info-batch',
      label: `读取应用信息 · 批量扫描（${files.length} 个包体）`,
      html: renderer.renderPackageInfo({ mode: 'batch', rows, directory: batchDir, result: summary })
    });
    console.log(`  批量扫描预览: ${batchDir}（${succeeded} 成功 / ${failed} 失败）`);
  }

  // ---------- 平台能力矩阵 ----------
  const { createPlatformCapabilities } = require(path.join(ROOT, 'electron', 'platform-capabilities'));
  const capabilities = await createPlatformCapabilities({ detectTool: makeDetectTool() }).getPlatformCapabilities({ probe: true });
  tabs.push({
    id: 'platform',
    label: `平台能力 · ${capabilities.platform_label}`,
    html: renderer.renderPlatformMatrix(capabilities)
  });
  console.log(`  平台能力: ${capabilities.platform_label}，${capabilities.summary.ready}/${capabilities.summary.total} 个功能就绪`);

  // ---------- 安装应用到设备（单个 / 批量） ----------
  tabs.push(...buildInstallTabs(renderer, batchDir));

  const css = fs.readFileSync(path.join(ROOT, 'src', 'App.css'), 'utf8');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>开发工具箱 · 界面预览</title>
<style>
${css}
</style>
<style>
/* 预览容器专用样式 */
body { background: #f7f8fc; margin: 0; padding: 24px; }
.pv-head {
  max-width: 1240px; margin: 0 auto 16px; padding: 18px 22px;
  background: #fff; border-radius: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.04);
}
.pv-head h1 { margin: 0 0 6px; font-size: 20px; color: #202124; }
.pv-head p { margin: 0; font-size: 13px; color: #5f6368; line-height: 1.6; }
.pv-tabs {
  max-width: 1240px; margin: 0 auto 16px; display: flex; flex-wrap: wrap; gap: 6px;
}
.pv-tab {
  padding: 7px 13px; border: 1px solid #dadce0; background: #fff; border-radius: 20px;
  font-size: 12px; color: #3c4043; cursor: pointer; transition: all .15s;
  font-family: inherit;
}
.pv-tab:hover { border-color: #667eea; color: #667eea; }
.pv-tab.is-active { background: linear-gradient(135deg,#667eea,#764ba2); color: #fff; border-color: transparent; font-weight: 600; }
.pv-panel { display: none; }
.pv-panel.is-active { display: block; }
.pv-panel > .content-card { margin: 0 auto; max-width: 1240px; }
.pv-note { max-width: 1240px; margin: 0 auto 16px; font-size: 12px; color: #80868b; }
</style>
</head>
<body>
<div class="pv-head">
  <h1>开发工具箱 · 界面预览</h1>
  <p>
    由 <code>tools/make-preview.js</code> 使用<strong>真实包体解析结果</strong>与真实 React 组件静态渲染生成，
    用于在未启动 Electron 的情况下审阅界面（数据为真实数据，交互按钮不生效）。
    覆盖：读取应用信息（概览 / 各分类详情 / 版本对比）、安装应用（单个 / 批量）、批量扫描包体、进度与提示、平台能力矩阵。
  </p>
</div>
<div class="pv-tabs" id="tabs">
${tabs.map((t, i) => `  <button class="pv-tab${i === 0 ? ' is-active' : ''}" data-target="${esc(t.id)}">${esc(t.label)}</button>`).join('\n')}
</div>
<div class="pv-note" id="note"></div>
${tabs.map((t, i) => `<div class="pv-panel${i === 0 ? ' is-active' : ''}" id="${esc(t.id)}">\n${t.html}\n</div>`).join('\n')}
<script>
(function () {
  var tabs = document.querySelectorAll('.pv-tab');
  var panels = document.querySelectorAll('.pv-panel');
  function activate(id) {
    panels.forEach(function (p) { p.classList.toggle('is-active', p.id === id); });
    tabs.forEach(function (t) { t.classList.toggle('is-active', t.dataset.target === id); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { activate(t.dataset.target); });
  });
  // 概览页里的「查看详细信息」按钮：跳到第一个详情分类
  document.querySelectorAll('.pi-basic-actions button').forEach(function (b) {
    b.addEventListener('click', function () {
      var next = tabs[1];
      if (next) activate(next.dataset.target);
    });
  });
  document.getElementById('note').textContent =
    '共 ' + tabs.length + ' 个视图 · 切换标签查看概览页 / 各分类详情 / 版本对比 / 安装应用 / 批量扫描 / 进度提示 / 平台能力';
})();
</script>
</body>
</html>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  try { fs.unlinkSync(BUNDLE); } catch { /* 忽略 */ }

  const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`已生成预览: ${path.relative(ROOT, OUT_FILE)}（${sizeKb} KB，${tabs.length} 个视图）`);
  for (const t of tabs) console.log(`  - ${t.id.padEnd(12)} ${t.label}`);
}

main().catch((error) => {
  console.error('生成预览失败:', error);
  try { fs.unlinkSync(BUNDLE); } catch { /* 忽略 */ }
  process.exit(1);
});
