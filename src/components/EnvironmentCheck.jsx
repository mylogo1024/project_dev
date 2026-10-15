import React, { useCallback, useEffect, useState } from 'react';
import ToolInstaller from './ToolInstaller';
import { copyTextWithToast } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

const TOOL_INFO = {
  adb: { name: 'ADB', desc: '安装 APK、设备日志、文件管理' },
  scrcpy: { name: 'scrcpy', desc: 'Android 投屏与键鼠控制' },
  apktool: { name: 'apktool', desc: '反编译 / 回编译 APK' },
  aapt: { name: 'aapt', desc: '反编译产物编译（读取应用信息已不再依赖）' },
  apksigner: { name: 'apksigner', desc: 'APK 签名（优先）' },
  zipalign: { name: 'zipalign', desc: '签名前对齐 APK' },
  keytool: { name: 'keytool', desc: '查看签名证书' },
  jarsigner: { name: 'jarsigner', desc: 'APK 签名（备用）' },
  idevice_id: { name: 'idevice_id', desc: '发现已连接的 iOS 设备' },
  ideviceinfo: { name: 'ideviceinfo', desc: '读取 iOS 设备与配对信息' },
  idevicesyslog: { name: 'idevicesyslog', desc: '实时读取 iOS 设备日志' },
  ideviceinstaller: { name: 'ideviceinstaller', desc: '安装 IPA 到 iOS 设备' },
  afcclient: { name: 'afcclient', desc: 'iOS 设备文件管理（媒体 / 应用文档）' },
  devicectl: { name: 'devicectl', desc: 'Xcode 安装 IPA 备用方案' }
};

const ANDROID_TOOL_KEYS = ['adb', 'scrcpy', 'apktool', 'aapt', 'apksigner', 'zipalign', 'keytool', 'jarsigner'];
const IOS_TOOL_KEYS = ['idevice_id', 'ideviceinfo', 'idevicesyslog', 'ideviceinstaller', 'afcclient', 'devicectl'];

const FEATURES = [
  { key: 'androidInstall', name: 'Android 安装', need: 'adb' },
  { key: 'androidLogs', name: 'Android 日志', need: 'adb' },
  { key: 'androidControl', name: '设备投屏（Android）', need: 'adb + scrcpy' },
  { key: 'iosMirror', name: '设备投屏（iOS）', need: 'macOS + USB 连接 iPhone' },
  { key: 'iosInstall', name: 'iOS 安装', need: 'ideviceinstaller 或 Xcode devicectl' },
  { key: 'iosLogs', name: 'iOS 日志', need: 'libimobiledevice' },
  { key: 'iosFiles', name: 'iOS 文件管理', need: 'afcclient（libimobiledevice）' },
  { key: 'androidDecompile', name: 'APK 反编译 / 回编译', need: 'apktool' },
  { key: 'androidInfo', name: '读取应用信息（APK / AAB / IPA）', need: '无需外部工具，纯 JS 解析' },
  { key: 'androidSign', name: 'APK 签名', need: 'apksigner / jarsigner' }
];

const INSTALL_METHODS = {
  adb: {
    darwin: [
      { title: 'Homebrew', command: 'brew install android-platform-tools' },
      { title: 'Android Studio', note: '安装后一般在 ~/Library/Android/sdk/platform-tools/adb' }
    ],
    linux: [
      { title: 'apt', command: 'sudo apt install android-tools-adb' }
    ],
    win32: [
      { title: 'Android SDK Platform-Tools', note: '从 Google 下载 platform-tools，并把目录加入 PATH。' }
    ]
  },
  scrcpy: {
    darwin: [{ title: 'Homebrew', command: 'brew install scrcpy' }],
    linux: [{ title: 'apt', command: 'sudo apt install scrcpy' }],
    win32: [{ title: '官方包', note: '从 https://github.com/Genymobile/scrcpy/releases 下载 Windows 包并加入 PATH。' }]
  },
  apktool: {
    darwin: [{ title: 'Homebrew', command: 'brew install apktool' }],
    linux: [{ title: 'apt', command: 'sudo apt install apktool' }],
    win32: [{ title: '官方包', note: '下载 apktool.jar / apktool.bat，放到已加入 PATH 的目录。' }]
  },
  aapt: {
    darwin: [
      { title: 'Android SDK build-tools', note: '用 Android Studio SDK Manager 安装 build-tools，aapt 在 ~/Library/Android/sdk/build-tools/<版本>/' }
    ],
    linux: [
      { title: 'Android SDK build-tools', note: '安装 SDK build-tools，aapt 在 $ANDROID_HOME/build-tools/<版本>/' }
    ],
    win32: [
      { title: 'Android SDK build-tools', note: '安装 SDK build-tools，aapt.exe 在 %LOCALAPPDATA%\\Android\\Sdk\\build-tools\\<版本>\\' }
    ]
  },
  apksigner: {
    darwin: [{ title: 'Android SDK build-tools', note: '与 aapt 同目录：~/Library/Android/sdk/build-tools/<版本>/apksigner' }],
    linux: [{ title: 'Android SDK build-tools', note: '位于 $ANDROID_HOME/build-tools/<版本>/apksigner' }],
    win32: [{ title: 'Android SDK build-tools', note: '位于 %LOCALAPPDATA%\\Android\\Sdk\\build-tools\\<版本>\\apksigner.bat' }]
  },
  zipalign: {
    darwin: [{ title: 'Android SDK build-tools', note: '与 aapt 同目录：~/Library/Android/sdk/build-tools/<版本>/zipalign' }],
    linux: [{ title: 'Android SDK build-tools', note: '位于 $ANDROID_HOME/build-tools/<版本>/zipalign' }],
    win32: [{ title: 'Android SDK build-tools', note: '位于 %LOCALAPPDATA%\\Android\\Sdk\\build-tools\\<版本>\\zipalign.exe' }]
  },
  keytool: {
    darwin: [{ title: 'Homebrew OpenJDK', command: 'brew install openjdk@17' }],
    linux: [{ title: 'apt', command: 'sudo apt install openjdk-17-jdk' }],
    win32: [{ title: 'JDK', note: '安装 Temurin / Oracle JDK 17+，并把 bin 加入 PATH。' }]
  },
  jarsigner: {
    darwin: [{ title: 'Homebrew OpenJDK', command: 'brew install openjdk@17' }],
    linux: [{ title: 'apt', command: 'sudo apt install openjdk-17-jdk' }],
    win32: [{ title: 'JDK', note: '安装 JDK 17+，jarsigner 在 JDK 的 bin 目录。' }]
  },
  idevice_id: {
    darwin: [{ title: 'Homebrew', command: 'brew install libimobiledevice' }],
    linux: [{ title: 'apt', command: 'sudo apt install libimobiledevice-utils' }],
    win32: [{ title: '不支持', note: 'libimobiledevice 命令行工具请在 macOS 或 Linux 上使用。' }]
  },
  ideviceinfo: {
    darwin: [{ title: 'Homebrew', command: 'brew install libimobiledevice' }],
    linux: [{ title: 'apt', command: 'sudo apt install libimobiledevice-utils' }],
    win32: [{ title: '不支持', note: '请在 macOS 或 Linux 上安装 libimobiledevice。' }]
  },
  idevicesyslog: {
    darwin: [{ title: 'Homebrew', command: 'brew install libimobiledevice' }],
    linux: [{ title: 'apt', command: 'sudo apt install libimobiledevice-utils' }],
    win32: [{ title: '不支持', note: '请在 macOS 或 Linux 上安装 libimobiledevice。' }]
  },
  ideviceinstaller: {
    darwin: [{ title: 'Homebrew', command: 'brew install ideviceinstaller' }],
    linux: [{ title: '源码 / 发行版包', note: '部分发行版提供 ideviceinstaller，也可自行编译 libimobiledevice 套件。' }],
    win32: [{ title: '不支持', note: '请在 macOS 上安装：brew install ideviceinstaller' }]
  },
  afcclient: {
    darwin: [{ title: 'Homebrew', command: 'brew install libimobiledevice' }],
    linux: [{ title: 'apt', command: 'sudo apt install libimobiledevice-utils' }],
    win32: [{ title: '不支持', note: '请在 macOS 或 Linux 上安装 libimobiledevice。' }]
  },
  devicectl: {
    darwin: [
      {
        title: '安装完整 Xcode 15 或更高',
        note: 'devicectl 只随完整 Xcode 提供，Homebrew 和「命令行工具」都没有这个命令。从 App Store 安装 Xcode，或到 Apple Developer 下载。'
      },
      { title: '切换开发者目录', command: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer' },
      { title: '接受许可并完成首次启动', command: 'sudo xcodebuild -license accept && xcodebuild -runFirstLaunch' },
      { title: '确认已安装', command: 'xcrun --find devicectl' }
    ],
    linux: [{ title: '不可用', note: 'devicectl 仅 macOS + Xcode 提供，当前系统无法安装。iOS 安装请改用 ideviceinstaller。' }],
    win32: [{ title: '不可用', note: 'devicectl 仅 macOS + Xcode 提供。请在 Mac 上安装 Xcode，或使用 ideviceinstaller。' }]
  }
};

const OS_LABEL = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows'
};

const osFamily = (platform) => {
  const value = String(platform || '').toLowerCase();
  if (value.includes('win')) return 'win32';
  if (value.includes('linux')) return 'linux';
  return 'darwin';
};

const methodsFor = (key, os) => INSTALL_METHODS[key]?.[os] || [];

function EnvironmentCheck() {
  const [envStatus, setEnvStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const checkEnvironment = async () => {
    setLoading(true);
    setError('');
    try {
      const status = await window.electronAPI.checkEnvironment();
      setEnvStatus(status);
    } catch (checkError) {
      setEnvStatus(null);
      setError(cleanIpcError(checkError, '环境检测失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkEnvironment();
  }, []);

  const copyCommand = (command) => copyTextWithToast(command, { successText: '命令已复制' });

  const toolDetails = envStatus?.toolDetails || {};
  const iosTools = envStatus?.ios?.tools || {};
  const getToolDetail = (key) => toolDetails[key] || iosTools[key] || {};
  const isInstalled = (key, fallback) => {
    const detail = getToolDetail(key);
    if (typeof detail === 'boolean') return detail;
    if (typeof detail.installed === 'boolean') return detail.installed;
    if (typeof fallback === 'boolean') return fallback;
    if (typeof fallback?.installed === 'boolean') return fallback.installed;
    return false;
  };
  const getResolvedPath = (key) => {
    const detail = getToolDetail(key);
    return detail.path || detail.resolvedPath || '';
  };

  if (loading) {
    return <div className="env-check"><div className="env-loading">正在检测环境…</div></div>;
  }

  if (error || !envStatus) {
    return (
      <div className="env-check">
        <div className="env-header"><h3>环境检测</h3></div>
        <div className="message error">
          <strong>环境检测失败</strong>
          <div>{error || '未返回环境检测结果'}</div>
          <button className="btn btn-secondary env-retry" onClick={checkEnvironment}>重新检测</button>
        </div>
      </div>
    );
  }

  const apkTools = envStatus.tools || {};
  const features = envStatus.features || {};
  const platformName = envStatus.platform || navigator.platform;
  const os = osFamily(platformName);
  const osName = OS_LABEL[os] || os;
  const androidReady = ANDROID_TOOL_KEYS.filter((key) => isInstalled(key, apkTools[key])).length;
  const iosReady = IOS_TOOL_KEYS.filter((key) => isInstalled(key, iosTools[key])).length;
  const missingKeys = [...ANDROID_TOOL_KEYS, ...IOS_TOOL_KEYS].filter((key) => {
    const fallback = ANDROID_TOOL_KEYS.includes(key) ? apkTools[key] : iosTools[key];
    return !isInstalled(key, fallback);
  });
  const missingIos = missingKeys.filter((key) => IOS_TOOL_KEYS.includes(key));

  const renderTool = (key, fallback) => {
    const info = TOOL_INFO[key] || { name: key, desc: '' };
    const installed = isInstalled(key, fallback);
    const resolvedPath = getResolvedPath(key);
    const firstMethod = methodsFor(key, os)[0];
    return (
      <div key={key} className={`env-tool ${installed ? 'is-ready' : 'is-missing'}`}>
        <div className="env-tool-main">
          <div className="env-tool-name">{info.name}</div>
          <div className="env-tool-desc">{info.desc}</div>
          {installed && resolvedPath && <div className="env-tool-path" title={resolvedPath}>{resolvedPath}</div>}
          {!installed && firstMethod && (
            <div className="env-tool-install">
              {firstMethod.command || firstMethod.note || firstMethod.title}
            </div>
          )}
        </div>
        <span className="env-tool-badge">{installed ? '已就绪' : '未找到'}</span>
      </div>
    );
  };

  return (
    <div className="env-check">
      <div className="env-header">
        <div>
          <h3>环境检测</h3>
          <div className="env-meta">
            {osName} {envStatus.arch ? `· ${envStatus.arch}` : ''}
            <span> · Android 工具 {androidReady}/{ANDROID_TOOL_KEYS.length}</span>
            <span> · iOS 工具 {iosReady}/{IOS_TOOL_KEYS.length}</span>
          </div>
        </div>
        <button className="btn btn-secondary" onClick={checkEnvironment}>重新检测</button>
      </div>

      <div className="env-features">
        {FEATURES.map((feature) => {
          const ready = Boolean(features[feature.key]);
          return (
            <div key={feature.key} className={`env-feature ${ready ? 'is-ready' : 'is-missing'}`}>
              <span className="env-feature-status">{ready ? '可用' : '缺少'}</span>
              <span className="env-feature-name">{feature.name}</span>
              {!ready && <span className="env-feature-need">{feature.need}</span>}
            </div>
          );
        })}
      </div>

      <details className="env-details" open={ANDROID_TOOL_KEYS.some((key) => missingKeys.includes(key))}>
        <summary>Android / APK 工具</summary>
        <div className="env-tool-list">
          {ANDROID_TOOL_KEYS.map((key) => renderTool(key, apkTools[key]))}
        </div>
      </details>

      <details className="env-details" open={missingIos.length > 0}>
        <summary>iOS 工具</summary>
        <div className="env-tool-list">
          {IOS_TOOL_KEYS.map((key) => renderTool(key, iosTools[key]))}
        </div>
      </details>

      <ToolInstaller onInstalled={checkEnvironment} />

      {missingKeys.length > 0 && (
        <div className="env-guide">
          <div className="env-guide-title">未安装工具 · {osName} 安装方法</div>
          <p>下面只列出当前没找到的工具。装完后完全退出本应用再打开，点「重新检测」。</p>
          {missingKeys.map((key) => {
            const info = TOOL_INFO[key] || { name: key, desc: '' };
            const methods = methodsFor(key, os);
            return (
              <div key={key} className="env-method">
                <div className="env-method-name">{info.name}</div>
                <div className="env-method-desc">{info.desc}</div>
                {methods.length === 0 ? (
                  <p>当前系统没有预设安装步骤，请自行安装 {info.name} 并加入 PATH。</p>
                ) : methods.map((method, index) => (
                  <div key={`${key}-${index}`} className="env-method-step">
                    <div className="env-method-title">{index + 1}. {method.title}</div>
                    {method.note && <p>{method.note}</p>}
                    {method.command && (
                      <div className="env-command">
                        <code>{method.command}</code>
                        <button className="btn btn-secondary" onClick={() => copyCommand(method.command)}>复制</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {Array.isArray(envStatus.searchDirectories) && envStatus.searchDirectories.length > 0 && (
        <details className="env-search">
          <summary>查看工具搜索目录（{envStatus.searchDirectories.length}）</summary>
          <ul>{envStatus.searchDirectories.map((directory) => <li key={directory}><code>{directory}</code></li>)}</ul>
        </details>
      )}
    </div>
  );
}

export default EnvironmentCheck;
