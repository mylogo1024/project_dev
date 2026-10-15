'use strict';

/**
 * 平台能力自检
 *
 * 回答一个很实际的问题：这个功能在我的系统上到底能不能用？
 *
 * 把「功能」拆成两种约束：
 *   1. 平台约束（platforms）—— 由代码本身决定，例如 IPA 重签名依赖 macOS 的 codesign
 *   2. 工具约束（tools）    —— 由外部依赖决定，例如安装 APK 需要 adb
 *
 * 两者都满足才是「可用」；只满足平台但缺工具，会给出明确的安装提示。
 */

const os = require('os');

const PLATFORM_LABELS = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
};

const ALL_PLATFORMS = ['darwin', 'win32', 'linux'];

/**
 * 功能清单。
 * - platforms  该功能在哪些系统上「代码层面」受支持
 * - tools      需要的外部可执行文件（任一可用即可，用 anyOf 表达）
 * - always     不依赖外部工具，装了就能用
 */
const FEATURE_CATALOG = [
  {
    id: 'package-info',
    name: '读取应用信息（单个 / 批量扫描）',
    group: '包体分析',
    platforms: ALL_PLATFORMS,
    always: true,
    note: '纯 JS 解析，不依赖 aapt / keytool / plutil；批量模式复用同一解析器'
  },
  {
    id: 'apk-decompile',
    name: 'APK 反编译 / 回编译',
    group: '包体分析',
    platforms: ALL_PLATFORMS,
    tools: [
      { name: 'apktool', args: ['--version'], hint: 'brew install apktool' },
      { name: 'java', args: ['-version'], hint: '安装 JDK 17+' }
    ],
    anyOf: true
  },
  {
    id: 'apk-sign',
    name: 'APK 签名 / 重签名',
    group: '包体分析',
    platforms: ALL_PLATFORMS,
    tools: [
      { name: 'apksigner', args: ['--version'], hint: 'Android SDK build-tools 自带' },
      { name: 'keytool', args: ['-help'], hint: '随 JDK 安装' }
    ],
    anyOf: true
  },
  {
    id: 'ipa-resign',
    name: 'IPA 重签名',
    group: '包体分析',
    platforms: ['darwin'],
    tools: [{ name: 'codesign', args: ['-h'], hint: 'macOS 自带（Xcode Command Line Tools）' }],
    platform_note: '依赖 macOS 的 codesign / security，其他系统无法使用'
  },
  {
    id: 'apk-install',
    name: '安装 APK 到 Android 设备',
    group: '设备操作',
    platforms: ALL_PLATFORMS,
    tools: [{ name: 'adb', args: ['version'], hint: '安装 Android Platform Tools' }]
  },
  {
    id: 'ipa-install',
    name: '安装 IPA 到 iOS 设备',
    group: '设备操作',
    platforms: ALL_PLATFORMS,
    tools: [
      { name: 'ideviceinstaller', args: ['-h'], hint: 'libimobiledevice：brew install ideviceinstaller' },
      { name: 'xcrun', args: ['--version'], hint: 'macOS 安装 Xcode 后自带 devicectl' }
    ],
    anyOf: true,
    platform_note: 'macOS 走 Xcode devicectl，最省心；Linux / Windows 需自行安装 libimobiledevice'
  },
  {
    id: 'device-files',
    name: '设备文件管理',
    group: '设备操作',
    platforms: ALL_PLATFORMS,
    tools: [{ name: 'adb', args: ['version'], hint: '安装 Android Platform Tools' }]
  },
  {
    id: 'device-apps',
    name: '设备应用管理',
    group: '设备操作',
    platforms: ALL_PLATFORMS,
    tools: [{ name: 'adb', args: ['version'], hint: '安装 Android Platform Tools' }]
  },
  {
    id: 'log-view',
    name: '日志查看',
    group: '设备操作',
    platforms: ALL_PLATFORMS,
    tools: [{ name: 'adb', args: ['version'], hint: '安装 Android Platform Tools' }]
  },
  {
    id: 'scrcpy',
    name: 'Android 投屏（scrcpy）',
    group: '设备操作',
    platforms: ALL_PLATFORMS,
    tools: [{ name: 'scrcpy', args: ['--version'], hint: 'brew install scrcpy' }]
  },
  {
    id: 'ios-mirror',
    name: 'iOS 实时投屏',
    group: '设备操作',
    platforms: ['darwin'],
    always: true,
    platform_note: '依赖 macOS 的 AVFoundation 采集接口，Windows / Linux 不可用'
  },
  {
    id: 'web-file-server',
    name: '局域网文件服务',
    group: '本地工具',
    platforms: ALL_PLATFORMS,
    always: true
  },
  {
    id: 'batch-rename',
    name: '批量重命名',
    group: '本地工具',
    platforms: ALL_PLATFORMS,
    always: true
  },
  {
    id: 'hash-tool',
    name: '哈希工具',
    group: '本地工具',
    platforms: ALL_PLATFORMS,
    always: true
  },
  {
    id: 'qrcode',
    name: '二维码工具',
    group: '本地工具',
    platforms: ALL_PLATFORMS,
    always: true
  },
  {
    id: 'text-tools',
    name: '文本 / JSON / HTTP 工具',
    group: '本地工具',
    platforms: ALL_PLATFORMS,
    always: true
  }
];

function createPlatformCapabilities({ detectTool } = {}) {
  /**
   * @param {{probe?: boolean}} [options] probe=false 时跳过外部工具探测（只返回平台矩阵）
   */
  async function getPlatformCapabilities(options = {}) {
    const platform = process.platform;
    const probe = options.probe !== false;

    const features = [];
    for (const feature of FEATURE_CATALOG) {
      const platformOk = feature.platforms.includes(platform);
      const entry = {
        id: feature.id,
        name: feature.name,
        group: feature.group,
        platforms: feature.platforms,
        platform_ok: platformOk,
        always: Boolean(feature.always),
        note: feature.note || '',
        platform_note: feature.platform_note || '',
        tools: [],
        available: false,
        status: 'unavailable',
        reason: ''
      };

      if (!platformOk) {
        entry.reason = feature.platform_note || `当前系统（${PLATFORM_LABELS[platform] || platform}）不支持该功能`;
        features.push(entry);
        continue;
      }

      if (feature.always || !feature.tools?.length) {
        entry.available = true;
        entry.status = 'ready';
        entry.reason = feature.note || '无需外部依赖';
        features.push(entry);
        continue;
      }

      // 探测外部工具
      for (const tool of feature.tools) {
        if (!probe) {
          entry.tools.push({ name: tool.name, installed: null, path: null, hint: tool.hint });
          continue;
        }
        let result = { installed: false, path: null };
        try {
          result = await detectTool(tool.name, tool.args);
        } catch (_) {
          result = { installed: false, path: null };
        }
        entry.tools.push({
          name: tool.name,
          installed: Boolean(result?.installed),
          path: result?.path || null,
          hint: tool.hint
        });
      }

      const installedCount = entry.tools.filter((tool) => tool.installed).length;
      const satisfied = feature.anyOf ? installedCount > 0 : installedCount === entry.tools.length;
      entry.available = satisfied;
      entry.status = satisfied ? 'ready' : 'missing-tool';
      if (!satisfied) {
        const missing = entry.tools.filter((tool) => tool.installed === false);
        entry.reason = `缺少外部工具：${missing.map((tool) => `${tool.name}（${tool.hint}）`).join('、')}`;
      } else {
        entry.reason = entry.tools.filter((tool) => tool.installed).map((tool) => tool.name).join(' / ') || '就绪';
      }

      features.push(entry);
    }

    const ready = features.filter((feature) => feature.available).length;

    return {
      platform,
      platform_label: PLATFORM_LABELS[platform] || platform,
      arch: process.arch,
      release: os.release(),
      cpus: os.cpus()?.length || 0,
      memory_gb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
      versions: {
        electron: process.versions.electron || null,
        chrome: process.versions.chrome || null,
        node: process.versions.node || null,
        v8: process.versions.v8 || null
      },
      probed: probe,
      summary: {
        total: features.length,
        ready,
        unavailable: features.length - ready
      },
      features
    };
  }

  return { getPlatformCapabilities, FEATURE_CATALOG };
}

module.exports = { createPlatformCapabilities, FEATURE_CATALOG, PLATFORM_LABELS };
