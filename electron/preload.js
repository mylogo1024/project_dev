const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ==================== 设备相关 ====================
  // 获取设备列表（InstallApk/FileManager/LogViewer 共用）
  getDevices: () => ipcRenderer.invoke('get-devices'),
  // 兼容别名
  listDevices: () => ipcRenderer.invoke('get-devices'),

  // ==================== APK 相关 ====================
  selectApk: () => ipcRenderer.invoke('select-apk'),
  selectAppPackage: () => ipcRenderer.invoke('select-app-package'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectKeystore: () => ipcRenderer.invoke('select-keystore'),
  installApk: (apkPath, deviceId) => ipcRenderer.invoke('install-apk', apkPath, deviceId),
  installApp: (filePath, deviceId, platform) =>
    ipcRenderer.invoke('install-app', { filePath, deviceId, platform }),
  onInstallProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('install-progress', handler);
    return () => ipcRenderer.removeListener('install-progress', handler);
  },
  // ==================== 批量安装 ====================
  selectAppPackages: () => ipcRenderer.invoke('select-app-packages'),
  installAppBatch: (payload) => ipcRenderer.invoke('install-app-batch', payload),
  cancelInstallBatch: (jobId) => ipcRenderer.invoke('cancel-install-batch', jobId),
  onInstallBatchProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('install-batch-progress', handler);
    return () => ipcRenderer.removeListener('install-batch-progress', handler);
  },
  decompileApk: (inputPath, outputPath, payload) => ipcRenderer.invoke('decompile-apk', inputPath, outputPath, payload),
  inspectRebuildProject: (projectDir) => ipcRenderer.invoke('rebuild-package:inspect', projectDir),
  rebuildPackage: (payload) => ipcRenderer.invoke('rebuild-package', payload),
  getApkInfo: (filePath) => ipcRenderer.invoke('get-apk-info', filePath),
  getPackageInfo: (filePath) => ipcRenderer.invoke('get-package-info', filePath),
  // 包体静态信息（基本信息 + 详细信息两层，纯 JS 解析，无外部工具依赖）
  // payload 支持字符串路径，也支持 { filePath, jobId } —— 带 jobId 时可订阅分阶段进度
  getPackageStaticInfo: (filePath) => ipcRenderer.invoke('get-package-static-info', filePath),
  readPackageStaticInfo: (payload) => ipcRenderer.invoke('get-package-static-info', payload),
  cancelPackageInfo: (jobId) => ipcRenderer.invoke('cancel-package-info', jobId),
  onPackageInfoProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('package-info-progress', handler);
    return () => ipcRenderer.removeListener('package-info-progress', handler);
  },
  // 反编译进度（IPA 解包 + 符号提取会走多步）
  onDecompileProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('decompile-progress', handler);
    return () => ipcRenderer.removeListener('decompile-progress', handler);
  },
  exportPackageInfo: (payload) => ipcRenderer.invoke('export-package-info', payload),
  comparePackageInfo: (payload) => ipcRenderer.invoke('compare-package-info', payload),
  // 在包体 DEX 里检索类名 / 字符串
  searchPackageSymbols: (payload) => ipcRenderer.invoke('search-package-symbols', payload),
  // iOS 控制后端探测（装了哪些工具）
  detectIosControlTools: () => ipcRenderer.invoke('detect-ios-control-tools'),
  // iOS 设备控制（WebDriverAgent 后端）
  iosControlProbe: (payload) => ipcRenderer.invoke('ios-control:probe', payload),
  iosControlScreen: () => ipcRenderer.invoke('ios-control:screen'),
  iosControlTap: (payload) => ipcRenderer.invoke('ios-control:tap', payload),
  iosControlLongPress: (payload) => ipcRenderer.invoke('ios-control:long-press', payload),
  iosControlSwipe: (payload) => ipcRenderer.invoke('ios-control:swipe', payload),
  // 唤醒屏幕：有密码的设备仍然要在设备上手动输一次（XCUITest 不能注入密码键盘）
  iosControlUnlock: () => ipcRenderer.invoke('ios-control:unlock'),
  iosControlLockState: (payload) => ipcRenderer.invoke('ios-control:lock-state', payload),
  iosControlType: (payload) => ipcRenderer.invoke('ios-control:type', payload),
  iosControlHome: () => ipcRenderer.invoke('ios-control:home'),
  // 硬件按键（带会话）：volumeUp/volumeDown/power/mute
  iosControlPressButton: (payload) => ipcRenderer.invoke('ios-control:press-button', payload),
  // 按方向滑一屏：up/down/left/right（程序化手势，画布鼠标拖拽做不出来）
  iosControlSwipeDirection: (payload) => ipcRenderer.invoke('ios-control:swipe-direction', payload),
  // 启动 App（带会话）：bundleId 形如 com.apple.mobilesafari
  iosControlLaunchApp: (payload) => ipcRenderer.invoke('ios-control:launch-app', payload),
  // 结束 App（带会话）：只杀该 App，不影响系统
  iosControlTerminateApp: (payload) => ipcRenderer.invoke('ios-control:terminate-app', payload),
  // 查询前台 App（带会话）：返回 { bundleId, name, pid }
  iosControlActiveApp: () => ipcRenderer.invoke('ios-control:active-app'),
  // 双指缩放（带会话）：'in' 放大 / 'out' 缩小（默认按屏幕尺寸推导中心点+间距）
  iosControlZoom: (payload) => ipcRenderer.invoke('ios-control:zoom', payload),
  iosControlDisconnect: () => ipcRenderer.invoke('ios-control:disconnect'),
  // MJPEG 实时流：返回 { ok, port, deviceId }，port 是本地代理端口
  iosControlStartMjpeg: (payload) => ipcRenderer.invoke('ios-control:start-mjpeg', payload),
  iosControlStopMjpeg: () => ipcRenderer.invoke('ios-control:stop-mjpeg'),
  iosControlStartWda: (payload) => ipcRenderer.invoke('ios-control:start-wda', payload),
  iosControlStopWda: () => ipcRenderer.invoke('ios-control:stop-wda'),
  // ==================== 无人值守 AutoPilot（13 天级） ====================
  // 详见 electron/autopilot.js。脚本是声明式 JSON：deviceId + steps 数组。
  // start 跑调度主循环（白班跑 / 夜间锁屏 / 早上解锁）；stop 立刻请求退出。
  // runOnce 是「现在跑一次」按钮专用，不开调度。status 用来轮询 UI。
  autopilotValidate: (script) => ipcRenderer.invoke('autopilot:validate', script),
  autopilotStart: (script) => ipcRenderer.invoke('autopilot:start', script),
  autopilotStop: () => ipcRenderer.invoke('autopilot:stop'),
  autopilotRunOnce: (script) => ipcRenderer.invoke('autopilot:run-once', script),
  autopilotStatus: () => ipcRenderer.invoke('autopilot:status'),

  // 批量解析：选中一个目录或一批文件，逐个解析后汇总
  selectPackageDirectory: () => ipcRenderer.invoke('select-package-directory'),
  batchScanPackages: (payload) => ipcRenderer.invoke('batch-scan-packages', payload),
  cancelBatchScan: (jobId) => ipcRenderer.invoke('cancel-batch-scan', jobId),
  onBatchScanProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('batch-scan-progress', handler);
    return () => ipcRenderer.removeListener('batch-scan-progress', handler);
  },
  exportBatchScanResult: (payload) => ipcRenderer.invoke('export-batch-scan-result', payload),
  // 平台能力自检（macOS / Windows / Linux 功能可用性矩阵）
  getPlatformCapabilities: () => ipcRenderer.invoke('get-platform-capabilities'),
  signApk: (payload) => ipcRenderer.invoke('sign-apk', payload),
  listCodeSignIdentities: () => ipcRenderer.invoke('list-codesign-identities'),
  inspectProvision: (provisionPath) => ipcRenderer.invoke('inspect-provision', provisionPath),
  resignIpa: (payload) => ipcRenderer.invoke('resign-ipa', payload),
  // 重签名进度（解压 → 签名 N 个目标 → 重新打包）
  onResignProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('resign-progress', handler);
    return () => ipcRenderer.removeListener('resign-progress', handler);
  },
  // 读一个 IPA 的签名事实：描述文件、包名、设备列表是否含当前设备
  inspectIpaSignature: (payload) => ipcRenderer.invoke('inspect-ipa-signature', payload),

  // ==================== 缺失工具自动安装（仅 Windows） ====================
  toolInstallerList: () => ipcRenderer.invoke('tool-installer:list'),
  toolInstallerInstall: (toolId) => ipcRenderer.invoke('tool-installer:install', { toolId }),
  toolInstallerCancel: (toolId) => ipcRenderer.invoke('tool-installer:cancel', { toolId }),
  toolInstallerUninstall: (toolId) => ipcRenderer.invoke('tool-installer:uninstall', { toolId }),
  onToolInstallProgress: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('tool-installer:progress', handler);
    return () => ipcRenderer.removeListener('tool-installer:progress', handler);
  },

  // ==================== 环境检测 ====================
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),

  // ==================== 文件管理 ====================
  listDeviceFiles: (payload, path, options) => {
    if (payload && typeof payload === 'object') {
      return ipcRenderer.invoke('list-device-files', payload);
    }
    return ipcRenderer.invoke('list-device-files', {
      deviceId: payload,
      path,
      platform: options?.platform || 'android',
      refreshPrivilege: Boolean(options?.refreshPrivilege)
    });
  },
  pullFile: (payload, remotePath, localPath) => {
    if (payload && typeof payload === 'object' && payload.deviceId) {
      return ipcRenderer.invoke('pull-file', payload);
    }
    return ipcRenderer.invoke('pull-file', { deviceId: payload, remotePath, localPath, platform: 'android' });
  },
  pushFile: (payload, localPath, remotePath) => {
    if (payload && typeof payload === 'object' && payload.deviceId) {
      return ipcRenderer.invoke('push-file', payload);
    }
    return ipcRenderer.invoke('push-file', { deviceId: payload, localPath, remotePath, platform: 'android' });
  },
  deleteDeviceFile: (payload, remotePath) => {
    if (payload && typeof payload === 'object' && payload.deviceId) {
      return ipcRenderer.invoke('delete-device-file', payload);
    }
    return ipcRenderer.invoke('delete-device-file', { deviceId: payload, remotePath, platform: 'android' });
  },

  // ==================== 设备应用管理 ====================
  listDeviceApps: (payload) => ipcRenderer.invoke('list-device-apps', payload),
  getDeviceAppIcon: (payload) => ipcRenderer.invoke('get-device-app-icon', payload),
  uninstallDeviceApp: (payload) => ipcRenderer.invoke('uninstall-device-app', payload),
  exportDeviceApp: (payload) => ipcRenderer.invoke('export-device-app', payload),
  clearDeviceAppCache: (payload) => ipcRenderer.invoke('clear-device-app-cache', payload),
  clearDeviceAppData: (payload) => ipcRenderer.invoke('clear-device-app-data', payload),

  // ==================== 日志查看 ====================
  getLogDevices: (platform) => ipcRenderer.invoke('get-log-devices', platform),
  getAndroidApps: (deviceId) => ipcRenderer.invoke('get-android-apps', deviceId),
  startLogCapture: (deviceId, deviceType) =>
    ipcRenderer.invoke('start-log-capture', { deviceId, deviceType }),
  stopLogCapture: (sessionId) => ipcRenderer.invoke('stop-log-capture', sessionId),
  onLogData: (callback) => {
    // 主进程只按批推送（log-data-batch，见 main.js 的 flushPendingLogs），这里逐条展开
    const batchHandler = (event, payload) => {
      const logs = Array.isArray(payload) ? payload : payload?.logs;
      if (!Array.isArray(logs)) return;
      for (const log of logs) callback(log);
    };
    ipcRenderer.on('log-data-batch', batchHandler);
    return () => ipcRenderer.removeListener('log-data-batch', batchHandler);
  },
  onLogCaptureStatus: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('log-capture-status', handler);
    return () => ipcRenderer.removeListener('log-capture-status', handler);
  },
  saveLogFile: (path, content) => ipcRenderer.invoke('save-log-file', path, content),

  // ==================== 文件选择 ====================
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),
  selectMultipleFiles: () => ipcRenderer.invoke('select-multiple-files'),
  getFilesInDirectory: (dirPath) => ipcRenderer.invoke('get-files-in-directory', dirPath),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),
  collectRenameFiles: (paths, options) => ipcRenderer.invoke('batch-rename:collect', paths, options),
  applyRenameFiles: (operations, options) => ipcRenderer.invoke('batch-rename:apply', operations, options),
  undoRenameFiles: (operations) => ipcRenderer.invoke('batch-rename:undo', operations),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('write-text-file', filePath, content),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),

  // ==================== Hash 相关 ====================
  modifyFileHash: (filePaths) => ipcRenderer.invoke('modify-file-hash', filePaths),
  getFileHash: (filePaths) => ipcRenderer.invoke('get-file-hash', filePaths),

  // ==================== 配置相关 ====================
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // ==================== 设备信息 ====================
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  getPhoneDeviceInfo: (payload) => ipcRenderer.invoke('get-phone-device-info', payload),
  listPhoneDeviceActions: (payload) => ipcRenderer.invoke('phone-device:list-actions', payload),
  runPhoneDeviceAction: (payload) => ipcRenderer.invoke('phone-device:action', payload),
  exportDeviceInfo: (content, filePath) => ipcRenderer.invoke('export-device-info', content, filePath),

  // ==================== Markdown 相关 ====================
  saveMarkdown: (content) => ipcRenderer.invoke('save-markdown', content),
  loadMarkdown: () => ipcRenderer.invoke('load-markdown'),
  exportHtml: (htmlContent) => ipcRenderer.invoke('export-html', htmlContent),

  // ==================== XMind 相关 ====================
  selectXmindFile: () => ipcRenderer.invoke('select-file', { filters: [{ name: 'XMind', extensions: ['xmind'] }] }),
  parseXmindFile: (filePath) => ipcRenderer.invoke('parse-xmind-file', filePath),
  exportMindmapText: (textContent) => ipcRenderer.invoke('export-mindmap-text', textContent),

  // ==================== 局域网文件服务 ====================
  selectWebFileServerDirectory: () => ipcRenderer.invoke('web-file-server:select-directory'),
  getWebFileServerStatus: () => ipcRenderer.invoke('web-file-server:get-status'),
  startWebFileServer: () => ipcRenderer.invoke('web-file-server:start'),
  stopWebFileServer: () => ipcRenderer.invoke('web-file-server:stop'),
  setWebFileServerToken: (payload) => ipcRenderer.invoke('web-file-server:set-token', payload),
  onWebFileServerStatus: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('web-file-server:status', handler);
    return () => ipcRenderer.removeListener('web-file-server:status', handler);
  },

  // ==================== WebDAV 文件服务 ====================
  selectWebDavServerDirectory: () => ipcRenderer.invoke('webdav-server:select-directory'),
  getWebDavServerStatus: () => ipcRenderer.invoke('webdav-server:get-status'),
  setWebDavServerCredentials: (payload) => ipcRenderer.invoke('webdav-server:set-credentials', payload),
  startWebDavServer: () => ipcRenderer.invoke('webdav-server:start'),
  stopWebDavServer: () => ipcRenderer.invoke('webdav-server:stop'),
  onWebDavServerStatus: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('webdav-server:status', handler);
    return () => ipcRenderer.removeListener('webdav-server:status', handler);
  },

  detectScrcpy: () => ipcRenderer.invoke('scrcpy:detect'),
  getScrcpyStatus: () => ipcRenderer.invoke('scrcpy:get-status'),
  startScrcpy: (options) => ipcRenderer.invoke('scrcpy:start', options),
  stopScrcpy: (deviceId) => ipcRenderer.invoke('scrcpy:stop', deviceId),
  onScrcpyStatus: (callback) => {
    const handler = (event, status) => callback(status);
    ipcRenderer.on('scrcpy:status', handler);
    return () => ipcRenderer.removeListener('scrcpy:status', handler);
  },

  getIosMirrorCapabilities: () => ipcRenderer.invoke('ios-mirror:capabilities'),
  requestIosMirrorAccess: () => ipcRenderer.invoke('ios-mirror:request-access'),
  listIosMirrorCameras: () => ipcRenderer.invoke('ios-mirror:list-cameras'),
  takeIosMirrorScreenshot: (deviceId) => ipcRenderer.invoke('ios-mirror:screenshot', deviceId),
  getIosMirrorDeviceState: (deviceId) => ipcRenderer.invoke('ios-mirror:device-state', deviceId),
  saveIosMirrorFrame: (filePath, dataUrl) => ipcRenderer.invoke('ios-mirror:save-frame', filePath, dataUrl),

  // ==================== 二维码相关 ====================
  generateQRCode: (text, size, errorLevel) => ipcRenderer.invoke('generate-qrcode', text, size, errorLevel),
  downloadQRCode: (imageData) => ipcRenderer.invoke('download-qrcode', imageData),
  parseQRCode: () => ipcRenderer.invoke('parse-qrcode'),
  shareQrLanFile: (filePath) => ipcRenderer.invoke('qr-code:share-file', filePath),

  // ==================== 文本工具 ====================
  calculateHash: (text, algorithm) => ipcRenderer.invoke('calculate-hash', text, algorithm),
  httpRequest: (payload) => ipcRenderer.invoke('http-request', payload)
});
