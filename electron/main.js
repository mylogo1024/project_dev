const { app, BrowserWindow, ipcMain, dialog, screen, systemPreferences, shell } = require('electron');
const path = require('path');
const { exec, execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const util = require('util');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Worker } = require('worker_threads');
const { createWebFileServerController } = require('./web-file-server');
const { createWebDavServerController } = require('./webdav-server');
const { placeShareFile, buildShareUrls } = require('./qr-lan-share');
const { detectProjectKind, defaultOutputPath, rebuildPackage } = require('./rebuild-package');
const { signApk } = require('./apk-sign');
const { createToolContext, createToolRunner } = require('./tool-env');
const toolInstaller = require('./tool-installer');
const {
  listCodeSignIdentities,
  inspectProvision,
  inspectIpaSignature,
  describeIpaSignature,
  resignIpa
} = require('./ios-resign');
const { createDeviceFileManager } = require('./device-files');
const { createPhoneDeviceInfo } = require('./phone-device-info');
const { createDeviceActions, describeAction } = require('./device-actions');
const { createDeviceApps } = require('./device-apps');
const { createScrcpyController } = require('./scrcpy');
const { createIosMirror } = require('./ios-mirror');
const { createIosControl, describeWdaStartFailure } = require('./ios-control');
const { createAutoPilot } = require('./autopilot');
const batchRename = require('./batch-rename');
const { parsePackageStaticInfo, comparePackageInfo, searchPackageSymbols, buildLaunchCommand, inspectPacker } = require('./pkginfo');
const { openZip } = require('./pkginfo/zip');
const { extractMachoSymbols } = require('./pkginfo/macho-symbols');
const { createBatchScanner, toCsv, toMarkdown, BATCH_COLUMNS } = require('./pkginfo/batch');
const { createPlatformCapabilities } = require('./platform-capabilities');
const {
  runDexAction,
  findJarTool,
  resolveDexTools,
  resolveDefaultOutputDir
} = require('./dex-toolkit');
const {
  planInstallBatch,
  runInstallBatch,
  describeBatchResult
} = require('./install-batch');
const {
  runIdeviceinstaller,
  runIdeviceinstallerStream,
  installArgSets,
  listBundleArgSets,
  collectInstallOutput,
  iosInstallSucceeded,
  parseInstalledBundleId,
  parsePackageInstallProgress,
  looksLikeSignatureFailure,
  explainIosInstallError
} = require('./ideviceinstaller');

const webFileServer = createWebFileServerController({
  clientDirectory: path.join(__dirname, 'web-file-server-client'),
  getInterfaceLabels: loadInterfaceLabels
});
let webFileServerOwnerId = null;

function broadcastWebFileServerStatus(status) {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('web-file-server:status', status);
      }
    } catch (_) {
      // The window may be destroyed between the checks and send.
    }
  }
}

webFileServer.onStatus(broadcastWebFileServerStatus);

function webFileServerPreferencePath() {
  return path.join(app.getPath('userData'), 'web-file-server.json');
}

/** 把 networksetup 报的硬件口名换成用户看得懂的说法。 */
function friendlyPortName(name) {
  const key = String(name || '').toLowerCase();
  if (key === 'ethernet' || key.includes('以太网')) return '以太网（有线）';
  if (key === 'wi-fi' || key === 'wifi' || key.includes('无线')) return 'Wi-Fi（无线）';
  if (key.includes('thunderbolt')) return '雷雳网桥';
  if (key.includes('iphone')) return 'iPhone USB';
  if (key.includes('bridge')) return '网桥';
  return String(name || '');
}

/**
 * 网卡名 → 人话（Wi-Fi / 以太网…）。
 *
 * 一台机器常常同时接好几个互不相通的网络，地址列表里两条都写「局域网」用户没法选，
 * 标成「Wi-Fi」「以太网」才能对上手机连的是哪个。探测失败就返回空对象，
 * 由调用方退回成「局域网 · en0」这种带网卡名的说法。
 */
function loadInterfaceLabels() {
  if (process.platform !== 'darwin') return {};
  try {
    const output = execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    const labels = {};
    for (const block of String(output).split(/\n\s*\n/)) {
      const port = /Hardware Port:\s*(.+)/.exec(block);
      const device = /Device:\s*(\S+)/.exec(block);
      if (port && device) labels[device[1]] = friendlyPortName(port[1].trim());
    }
    return labels;
  } catch (_) {
    return {};
  }
}

function loadWebFileServerPreference() {
  try {
    const data = JSON.parse(fs.readFileSync(webFileServerPreferencePath(), 'utf8'));
    return {
      preferredPort: Number.isInteger(data.port) ? data.port : null,
      preferredAddress: typeof data.address === 'string' && data.address ? data.address : null,
      accessToken: typeof data.accessToken === 'string' ? data.accessToken : '',
      // 默认不启用令牌：访问地址固定为 http://ip:port/，不会每次启停都变
      requireToken: data.requireToken === true
    };
  } catch (_) {
    return { preferredPort: null, preferredAddress: null, accessToken: '', requireToken: false };
  }
}

function saveWebFileServerPreference(preference) {
  try {
    const previous = loadWebFileServerPreference();
    fs.writeFileSync(webFileServerPreferencePath(), JSON.stringify({
      port: preference.port ?? previous.preferredPort ?? null,
      address: preference.address ?? previous.preferredAddress ?? null,
      accessToken: preference.accessToken ?? previous.accessToken ?? '',
      requireToken: preference.requireToken ?? previous.requireToken ?? false
    }, null, 2));
  } catch (_) { /* 偏好文件写不进去（磁盘满 / 无权限）不影响本次运行 */ }
}

/** 需要令牌但没有存过时生成一次并落盘，保证地址长期稳定。 */
function ensureWebFileServerToken(preference) {
  if (!preference.requireToken || preference.accessToken) return preference.accessToken || '';
  const token = crypto.randomBytes(24).toString('base64url');
  saveWebFileServerPreference({ ...preference, accessToken: token });
  return token;
}

// ==================== WebDAV 文件服务（可挂载为网络磁盘） ====================

const webDavServer = createWebDavServerController({ getInterfaceLabels: loadInterfaceLabels });
let webDavServerOwnerId = null;

function broadcastWebDavServerStatus(status) {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('webdav-server:status', status);
      }
    } catch (_) {
      // 窗口可能正在销毁，推送失败是正常的。
    }
  }
}

webDavServer.onStatus(broadcastWebDavServerStatus);

function webDavServerPreferencePath() {
  return path.join(app.getPath('userData'), 'webdav-server.json');
}

/**
 * WebDAV 偏好：端口 / 地址 / 账号 / 密码 / 共享目录。
 * 密码明文落盘是 WebDAV 挂载工具的通行做法（Basic 鉴权本来就能被
 * 抓包还原），重点是「关掉应用重开，账号密码和目录还在」。
 */
function loadWebDavServerPreference() {
  try {
    const data = JSON.parse(fs.readFileSync(webDavServerPreferencePath(), 'utf8'));
    return {
      rootPath: typeof data.rootPath === 'string' && data.rootPath ? data.rootPath : null,
      username: typeof data.username === 'string' && data.username ? data.username : 'admin',
      password: typeof data.password === 'string' ? data.password : '',
      preferredPort: Number.isInteger(data.port) ? data.port : null,
      preferredAddress: typeof data.address === 'string' && data.address ? data.address : null
    };
  } catch (_) {
    return { rootPath: null, username: 'admin', password: '', preferredPort: null, preferredAddress: null };
  }
}

function saveWebDavServerPreference(preference) {
  try {
    const previous = loadWebDavServerPreference();
    fs.writeFileSync(webDavServerPreferencePath(), JSON.stringify({
      rootPath: preference.rootPath ?? previous.rootPath ?? null,
      username: preference.username ?? previous.username ?? 'admin',
      password: preference.password ?? previous.password ?? '',
      port: preference.port ?? previous.preferredPort ?? null,
      address: preference.address ?? previous.preferredAddress ?? null
    }, null, 2));
  } catch (_) { /* 偏好文件写不进去不影响本次运行 */ }
}

/** 启动前把持久化的偏好灌进 controller（root / 账号 / 密码）。 */
async function applyWebDavPreference() {
  const preference = loadWebDavServerPreference();
  const status = webDavServer.getStatus();
  if (status.selectedRoot !== preference.rootPath && preference.rootPath) {
    try {
      await webDavServer.setRoot(preference.rootPath);
    } catch (_) { /* 目录被删了等：保留空 root，让 UI 引导用户重选 */ }
  }
  if (status.username !== preference.username || status.authRequired !== Boolean(preference.password)) {
    await webDavServer.setCredentials(preference.username, preference.password);
  }
  return preference;
}

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
const {
  directories: toolSearchDirectories,
  env: toolEnv,
  resolveTool,
  runTool,
  runToolStream,
  detectTool
} = createToolRunner(createToolContext());

/**
 * 装完新工具后刷新搜索路径。
 *
 * `directories` 是 createToolContext 当场生成的数组，runTool / detectTool 通过闭包持有它，
 * 所以原地 push 就能让后续调用看到新目录 —— 不必重建 deviceFiles / scrcpy 等一众模块。
 * 同时更新 PATH 环境变量，子进程（scrcpy 会再起 adb）也能继承到。
 */
function refreshToolEnvironment() {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  let changed = false;
  for (const directory of toolInstaller.binDirectories()) {
    if (toolSearchDirectories.includes(directory)) continue;
    toolSearchDirectories.push(directory);
    changed = true;
  }
  if (!changed) return;
  toolEnv[pathKey] = toolSearchDirectories.join(path.delimiter);
  if (pathKey !== 'PATH') toolEnv.PATH = toolEnv[pathKey];
}

/** 正在进行的安装任务，key 是 jobId，用于取消。 */
const toolInstallAborts = new Map();
const deviceFiles = createDeviceFileManager({ runTool });
const phoneDeviceInfo = createPhoneDeviceInfo({ runTool });
const deviceApps = createDeviceApps({ runTool, deviceFiles });
const scrcpy = createScrcpyController({
  spawn,
  resolveTool,
  detectTool,
  env: toolEnv
});
const iosMirror = createIosMirror({ runTool, detectTool });
// iOS 设备控制（WebDriverAgent 后端）。会话是长生命周期对象，所以做成单例
const iosControl = createIosControl();
const deviceActions = createDeviceActions({ runTool, iosControl });

/**
 * 无人值守执行器（13 天级）：把 ios-control 的能力声明化为 JSON 脚本，
 * 加上夜间锁屏、异常自愈、快照归档、告警。具体设计见 electron/autopilot.js。
 *
 * `takeScreenshot` 复用 ios-mirror 的实现 —— 它返回 { dataUrl, mime }，
 * 正好是 autopilot.archiveScreenshot 想要的形状。
 *
 * `notify` 用 Electron 系统通知。失败静默（AP 内部已写 ALERTS.md），
 * 用户回到机器时第一件事就是看 ALERTS.md + 通知中心。
 */
let autoPilotInstance = null;
function getAutoPilot() {
  if (autoPilotInstance) return autoPilotInstance;
  autoPilotInstance = createAutoPilot({
    iosControl,
    takeScreenshot: async (deviceId) => {
      try { return await iosMirror.takeScreenshot(deviceId); } catch (_) { return null; }
    },
    notify: (payload) => {
      try {
        const { Notification } = require('electron');
        if (!Notification.isSupported()) return;
        const n = new Notification({
          title: payload.title || 'AutoPilot',
          body: payload.body || '',
          silent: false
        });
        n.show();
      } catch (_) { /* 系统通知挂了不能拖垮主循环 */ }
    }
  });
  return autoPilotInstance;
}
const platformCapabilities = createPlatformCapabilities({ detectTool });
const batchScanner = createBatchScanner({
  parseOne: (filePath, options) => parsePackageInfoAsync(filePath, options)
});

function broadcastScrcpyStatus(status) {
  const payload = status || scrcpy.getStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('scrcpy:status', payload);
      }
    } catch (_) { /* 窗口可能正在销毁，推送状态失败是正常的 */ }
  }
}

scrcpy.onStatus(broadcastScrcpyStatus);

let mainWindow;

/**
 * 允许渲染进程申请的权限白名单。
 *
 * `clipboard-sanitized-write` 必须有：`navigator.clipboard.writeText()` 申请的就是它，
 * 不在白名单里会被直接拒绝，抛 `NotAllowedError: Write permission denied.`。
 * 应用里十几个「复制」按钮（复制访问地址、复制字段、复制 JSON…）全靠它。
 * 注意这个权限走的是 **requestHandler**（不是 checkHandler），两个都要放行才稳。
 */
const ALLOWED_PERMISSIONS = [
  'media',
  'camera',
  'microphone',
  'display-capture',
  'clipboard-sanitized-write',
  'clipboard-read'
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  const createdWindow = mainWindow;
  // 渲染层诊断日志转发到主进程终端：真机排查手势问题时，
  // 用户看终端比开 DevTools 方便得多（[mirror] 前缀）
  createdWindow.webContents.on('console-message', (_event, _level, message) => {
    if (typeof message === 'string' && message.includes('[mirror]')) {
      try { console.log(message); } catch (_) { /* 忽略终端异常 */ }
    }
  });
  createdWindow.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  createdWindow.webContents.session.setPermissionCheckHandler((_contents, permission) => (
    ALLOWED_PERMISSIONS.includes(permission)
  ));
  const windowOwner = createdWindow.webContents;
  windowOwner.once('destroyed', () => {
    queueLogTransition(async () => {
      if (activeLogSession && activeLogSession.ownerId === windowOwner.id) {
        await stopActiveLogSession(activeLogSession, 'owner-destroyed');
      }
    });
    if (webFileServerOwnerId === windowOwner.id) {
      webFileServerOwnerId = null;
      webFileServer.stop('owner-destroyed').catch(() => {});
    }
    if (webDavServerOwnerId === windowOwner.id) {
      webDavServerOwnerId = null;
      webDavServer.stop('owner-destroyed').catch(() => {});
    }
  });
  createdWindow.once('closed', () => {
    queueLogTransition(async () => {
      if (activeLogSession && activeLogSession.ownerId === windowOwner.id) {
        await stopActiveLogSession(activeLogSession, 'owner-destroyed');
      }
    });
    if (mainWindow === createdWindow) mainWindow = null;
  });

  // 开发环境
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // 生产环境 - 加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  
  // 开发环境热重载
  if (!app.isPackaged) {
    mainWindow.webContents.on('did-fail-load', () => {
      setTimeout(() => {
        mainWindow.loadURL('http://localhost:5173');
      }, 1000);
    });
  }
}

// ==================== 崩溃兜底 ====================

/**
 * 主进程的兜底防护。
 *
 * Electron 主进程里一个没 catch 的异常会**直接杀掉整个应用** —— 用户看到的就是「闪退」，
 * 没有任何提示，日志也可能还没落盘。这里把三类情况都接住：
 *
 *   1. `uncaughtException`  同步异常（含第三方库内部抛的）
 *   2. `unhandledRejection` 忘了 await / catch 的 Promise
 *   3. `render-process-gone` / `child-process-gone` 渲染进程或子进程挂掉
 *
 * 统一落盘到 userData/crash.log，并弹一次可关闭的错误框 —— 宁可给出一个「出错了 + 日志在哪」，
 * 也不要静默消失。**日志本身用 try/catch 包住**：兜底逻辑自己再抛就真的没救了。
 */
let crashDialogShown = false;
let rendererReloadAt = 0;

function crashLogPath() {
  try {
    return path.join(app.getPath('userData'), 'crash.log');
  } catch (_) {
    return 'crash.log';
  }
}

function logCrash(kind, detail) {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
  try {
    fs.appendFileSync(crashLogPath(), line);
  } catch (_) {
    // 磁盘满 / 无权限：只能退化成控制台输出
  }
  try {
    console.error(`[${kind}]`, detail);
  } catch (_) { /* 忽略 */ }
}

function reportCrash(kind, error) {
  const detail = error?.stack || String(error);
  logCrash(kind, detail);
  if (crashDialogShown) return; // 连环崩溃时不要弹一堆框
  crashDialogShown = true;
  try {
    dialog.showErrorBox(
      '应用遇到问题',
      `${kind}\n\n${detail}\n\n详细信息已写入日志：\n${crashLogPath()}`
    );
  } catch (_) {
    // 连弹框都失败，至少日志已经落盘
  }
}

process.on('uncaughtException', (error) => reportCrash('uncaughtException', error));
process.on('unhandledRejection', (reason) => reportCrash('unhandledRejection', reason));

app.whenReady().then(async () => {
  // 渲染进程崩了不要只留一片白屏：记录原因，并尝试自动重载一次。
  // 用时间窗限流，避免「崩 → 重载 → 再崩」的循环把 CPU 打满。
  app.on('render-process-gone', (event, webContents, details) => {
    const reason = details?.reason || 'unknown';
    logCrash('render-process-gone', `${reason}（exitCode ${details?.exitCode ?? 'n/a'}）`);

    const now = Date.now();
    if (reason === 'crashed' && now - rendererReloadAt > 30000
      && webContents && !webContents.isDestroyed()) {
      rendererReloadAt = now;
      try {
        webContents.reload();
      } catch (error) {
        logCrash('renderer-reload-failed', error?.message || error);
      }
    }
  });

  // GPU / utility 子进程挂掉不一定致命，只记日志，不打扰用户
  app.on('child-process-gone', (event, details) => {
    logCrash('child-process-gone', `${details?.type || 'unknown'}: ${details?.reason || 'unknown'}`);
  });

  createWindow();

  // 重启后立即把持久化的 WebDAV 偏好（目录/账号/密码）灌进 controller，
  // 让 UI 首屏就能显示真实的鉴权状态，而不是等用户点「启动」才生效。
  applyWebDavPreference().catch(() => { /* 偏好预热失败不阻塞启动 */ });

  // 开发模式下运行自动 QA 测试
  if (!app.isPackaged) {
    try {
      const runAutoQA = require('./qa-auto-test');
      // 延迟执行，等窗口加载完成
      setTimeout(async () => {
        console.log('\n🔍 开始自动 QA 测试...');
        const result = await runAutoQA();
        console.log(`\n✅ QA 完成: ${result.pass} 通过, ${result.fail} 失败, ${result.skip} 跳过`);
      }, 3000);
    } catch (e) {
      console.log('QA 测试脚本加载失败:', e.message);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

let quittingAfterServiceCleanup = false;

app.on('before-quit', (event) => {
  const logNeedsCleanup = Boolean(activeLogSession);
  const webStatus = webFileServer.getStatus();
  const webNeedsCleanup = webStatus.state !== 'stopped';
  const davStatus = webDavServer.getStatus();
  const davNeedsCleanup = davStatus.state !== 'stopped';
  const scrcpyNeedsCleanup = scrcpy.getStatus().sessions.some((session) => (
    session.state === 'starting' || session.state === 'running' || session.state === 'stopping'
  ));
  // iOS 控制会起子进程（iproxy 端口转发 / tidevice wdaproxy 启动 WDA），
  // 还会在设备上建 WDA 会话。不清理的话：子进程残留占住 8100，
  // 下次启动转发起不来（报错还指错方向）；WDA 会话也会在设备上堆积。
  const iosNeedsCleanup = iosControl.isForwarding()
    || iosControl.isConnected()
    || iosControl.isWdaRunning()
    || iosControl.isMjpegRunning();
  if ((!logNeedsCleanup && !webNeedsCleanup && !davNeedsCleanup && !scrcpyNeedsCleanup && !iosNeedsCleanup)
    || quittingAfterServiceCleanup) return;

  event.preventDefault();
  quittingAfterServiceCleanup = true;
  const logCleanup = queueLogTransition(async () => {
    if (activeLogSession) await stopActiveLogSession(activeLogSession, 'app-quit');
  });
  Promise.allSettled([
    logCleanup,
    webFileServer.stop('app-quit'),
    webDavServer.stop('app-quit'),
    scrcpy.stopAll(),
    iosControl.dropSession(),
    iosControl.stopWda(),
    iosControl.stopMjpegProxy(),
    autoPilotInstance ? Promise.resolve(autoPilotInstance.stop()) : Promise.resolve()
  ]).finally(() => app.quit());
});

app.on('will-quit', () => {
  forceKillLogSessionSync(activeLogSession);
  webFileServer.forceClose();
  webDavServer.forceClose();
  scrcpy.forceKill();
  // 这里不能 await —— 必须有同步路径把子进程收掉
  iosControl.forceKillForward();
  iosControl.forceKillWda();
  // 9100 的 iproxy 与本地代理 server 也要同步收 ——
  // 否则退出后端口和长连接还挂着，下次启动画面通道起不来
  iosControl.forceKillMjpeg();
});

/**
 * 找到**完整 Xcode** 的 Developer 目录。
 *
 * 为什么需要：`devicectl` 只随完整 Xcode 提供，CommandLineTools 里没有。
 * 而 `xcode-select` 经常指向 `/Library/Developer/CommandLineTools`（很多人为了
 * 避开 Xcode 授权或省事就这么设），此时 `xcrun --find devicectl` 会报
 * 「unable to find utility」，**即使完整 Xcode 明明装着**。
 *
 * 所以不能只依赖 `xcode-select` —— 要真的去找 `Xcode*.app`。
 * 找到后通过 `DEVELOPER_DIR` 环境变量传给 `xcrun`，不动用户的全局设置。
 */
let fullXcodeDeveloperDir;
let fullXcodeProbed = false;

async function findFullXcodeDeveloperDir() {
  if (fullXcodeProbed) return fullXcodeDeveloperDir;
  fullXcodeProbed = true;

  const candidates = [];
  try {
    const { stdout } = await runTool('xcode-select', ['-p'], { timeout: 5000 });
    candidates.push(String(stdout || '').trim());
  } catch (_) {
    // 没装 xcode-select 就走下面的目录扫描
  }
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (/^Xcode.*\.app$/.test(name)) {
          candidates.push(path.join(root, name, 'Contents', 'Developer'));
        }
      }
    } catch (_) {
      // 目录不存在就跳过
    }
  }

  // 用「有没有 devicectl」当判据，而不是看目录名 —— 目录名猜不出内容
  fullXcodeDeveloperDir = candidates.find((dir) => (
    dir && fs.existsSync(path.join(dir, 'usr', 'bin', 'devicectl'))
  )) || null;
  return fullXcodeDeveloperDir;
}

async function detectDevicectl() {
  const xcrun = await detectTool('xcrun');
  if (!xcrun.installed) return { installed: false, path: null };

  const developerDir = await findFullXcodeDeveloperDir();
  // 先带上 DEVELOPER_DIR 试（CommandLineTools 环境下这是唯一能找到的路径），
  // 不行再退回默认环境（xcode-select 已经指向完整 Xcode 时）
  const attempts = developerDir ? [{ env: { ...toolEnv, DEVELOPER_DIR: developerDir } }, {}] : [{}];
  for (const attempt of attempts) {
    try {
      const result = await runTool('xcrun', ['--find', 'devicectl'], {
        executable: xcrun.path,
        timeout: 5000,
        ...attempt
      });
      const located = String(result.stdout || '').trim();
      if (located) return { installed: true, path: located, developerDir: developerDir || null };
    } catch (_) {
      // 换下一种方式再试
    }
  }
  return { installed: false, path: xcrun.path, developerDir: developerDir || null };
}

// 检查环境工具是否已安装
ipcMain.handle('check-environment', async () => {
  const toolSpecs = {
    adb: ['version'],
    apktool: ['--version'],
    aapt: ['version'],
    apksigner: ['--help'],
    zipalign: null,
    keytool: ['-help'],
    jarsigner: ['-help'],
    scrcpy: ['--version']
  };
  const iosResolveOnly = ['idevice_id', 'ideviceinfo', 'idevicesyslog', 'ideviceinstaller', 'afcclient'];
  const toolDetails = {};

  await Promise.all(Object.entries(toolSpecs).map(async ([tool, args]) => {
    toolDetails[tool] = await detectTool(tool, args);
  }));

  const iosTools = {};
  await Promise.all(iosResolveOnly.map(async (tool) => {
    iosTools[tool] = await detectTool(tool);
  }));
  iosTools.devicectl = await detectDevicectl();

  const tools = Object.fromEntries(Object.keys(toolSpecs).map((tool) => [tool, toolDetails[tool].installed]));
  const androidToolKeys = Object.keys(toolSpecs);
  const installed = androidToolKeys.filter((key) => tools[key]).length;
  const total = androidToolKeys.length;
  const iosInstalled = Object.values(iosTools).filter((tool) => tool.installed).length;
  const features = {
    androidInstall: Boolean(tools.adb),
    androidLogs: Boolean(tools.adb),
    androidFiles: Boolean(tools.adb),
    androidDecompile: Boolean(tools.apktool),
    androidInfo: Boolean(tools.aapt),
    androidSign: Boolean(tools.apksigner || tools.jarsigner),
    androidControl: Boolean(tools.adb && toolDetails.scrcpy?.installed),
    iosMirror: process.platform === 'darwin',
    iosLogs: Boolean(iosTools.idevicesyslog.installed && iosTools.idevice_id.installed),
    iosInstall: Boolean(iosTools.ideviceinstaller.installed || iosTools.devicectl.installed),
    iosFiles: Boolean(iosTools.afcclient.installed && iosTools.idevice_id.installed)
  };

  return {
    tools,
    toolDetails,
    installed,
    total,
    allInstalled: installed === total,
    apkFeaturesAvailable: features.androidInstall && features.androidDecompile && features.androidInfo && features.androidSign,
    features,
    ios: {
      tools: iosTools,
      installed: iosInstalled,
      total: Object.keys(iosTools).length,
      captureAvailable: features.iosLogs,
      installAvailable: features.iosInstall,
      filesAvailable: features.iosFiles,
      mirrorAvailable: features.iosMirror,
      metadataAvailable: Boolean(iosTools.idevice_id.installed && iosTools.ideviceinfo.installed)
    },
    platform: process.platform,
    arch: process.arch,
    searchDirectories: [...toolSearchDirectories]
  };
});

// 选择 APK 文件
ipcMain.handle('select-apk', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'APK Files', extensions: ['apk'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-app-package', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '应用安装包', extensions: ['apk', 'ipa'] },
      { name: 'Android APK', extensions: ['apk'] },
      { name: 'iOS IPA', extensions: ['ipa'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

// 选择目录
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

// ==================== 局域网文件服务 ====================

ipcMain.handle('web-file-server:select-directory', async (event) => {
  const status = webFileServer.getStatus();
  if (status.state !== 'stopped' && status.state !== 'error') {
    throw new Error('请先停止局域网文件服务，再更改共享目录');
  }

  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('当前窗口已关闭');
  const result = await dialog.showOpenDialog(ownerWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return webFileServer.setRoot(result.filePaths[0]);
});

ipcMain.handle('web-file-server:get-status', () => {
  const preference = loadWebFileServerPreference();
  const status = webFileServer.getStatus();
  const idle = status.state === 'stopped' || status.state === 'error';
  return {
    ...status,
    // 令牌开关以持久化偏好为准：服务未运行时也能正确回显，且 start 用的就是这份偏好
    tokenRequired: preference.requireToken,
    // 停止时回显上次的端口与地址，让用户看到「下次启动还是这个地址」
    lastPort: idle ? preference.preferredPort : null,
    lastAddress: idle ? preference.preferredAddress : null
  };
});

ipcMain.handle('web-file-server:set-token', async (event, payload = {}) => {
  const state = webFileServer.getStatus().state;
  if (state !== 'stopped' && state !== 'error') {
    throw new Error('请先停止局域网文件服务，再修改访问令牌设置');
  }
  const requireToken = Boolean(payload?.requireToken);
  const current = loadWebFileServerPreference();
  let accessToken = current.accessToken;
  if (requireToken && !accessToken) {
    accessToken = crypto.randomBytes(24).toString('base64url');
  }
  saveWebFileServerPreference({ ...current, requireToken, accessToken });
  return {
    ...webFileServer.getStatus(),
    tokenRequired: requireToken
  };
});

ipcMain.handle('web-file-server:start', async (event) => {
  return startOwnedWebFileServer(event);
});

ipcMain.handle('web-file-server:stop', async (event) => {
  if (webFileServerOwnerId !== null && webFileServerOwnerId !== event.sender.id) {
    throw new Error('只有启动服务的窗口可以停止局域网文件服务');
  }
  const result = await webFileServer.stop('requested');
  webFileServerOwnerId = null;
  return result;
});

async function startOwnedWebFileServer(event) {
  if (event.sender.isDestroyed()) throw new Error('当前窗口已关闭');
  if (webFileServerOwnerId !== null && webFileServerOwnerId !== event.sender.id) {
    throw new Error('其他窗口正在管理局域网文件服务');
  }
  webFileServerOwnerId = event.sender.id;
  try {
    const preference = loadWebFileServerPreference();
    const result = await webFileServer.start({
      ...preference,
      accessToken: ensureWebFileServerToken(preference)
    });
    if (result?.port) {
      saveWebFileServerPreference({
        port: result.port,
        address: result.primaryAddress || preference.address || null
      });
    }
    return result;
  } catch (error) {
    if (webFileServer.getStatus().state !== 'running') webFileServerOwnerId = null;
    throw new Error(`启动局域网文件服务失败: ${error.message}`);
  }
}

async function ensureWebFileServerRunning(event) {
  const status = webFileServer.getStatus();
  if (status.state === 'running') return status;
  if (status.state === 'error') await webFileServer.stop('reset');
  const idle = webFileServer.getStatus();
  if (idle.state !== 'stopped') throw new Error('局域网文件服务正在切换，请稍后再试');

  let root = idle.selectedRoot || idle.rootPath;
  if (!root) {
    root = path.join(app.getPath('userData'), 'qr-lan-share');
    fs.mkdirSync(root, { recursive: true });
    await webFileServer.setRoot(root);
  }
  return startOwnedWebFileServer(event);
}

// 拖入文件 → 拷进共享目录 → 返回可扫码的直链下载地址
ipcMain.handle('qr-code:share-file', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请选择要分享的文件');
  const source = path.resolve(filePath.trim());
  let stat;
  try {
    stat = fs.statSync(source);
  } catch (_) {
    throw new Error('找不到该文件');
  }
  if (!stat.isFile()) throw new Error('请拖入一个文件，而不是文件夹');

  const status = await ensureWebFileServerRunning(event);
  const root = status.selectedRoot || status.rootPath;
  if (!root) throw new Error('局域网文件服务没有可用的共享目录');

  const placed = await placeShareFile(root, source);
  const next = webFileServer.getStatus();
  const urls = buildShareUrls(next.urls, placed.relativePath);
  if (!urls.length) throw new Error('没有可用的内网地址，请检查本机网络');
  return {
    fileName: placed.destName,
    relativePath: placed.relativePath,
    url: urls[0],
    urls
  };
});

// ==================== WebDAV 文件服务 IPC ====================

ipcMain.handle('webdav-server:select-directory', async (event) => {
  const status = webDavServer.getStatus();
  if (status.state !== 'stopped' && status.state !== 'error') {
    throw new Error('请先停止 WebDAV 服务，再更改存储路径');
  }
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow || ownerWindow.isDestroyed()) throw new Error('当前窗口已关闭');
  const result = await dialog.showOpenDialog(ownerWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  saveWebDavServerPreference({ rootPath: result.filePaths[0] });
  return webDavServer.setRoot(result.filePaths[0]);
});

/** 设置账号密码。账号留空 = 固定账号 admin；密码留空 = 关闭鉴权（局域网信任模式）。 */
ipcMain.handle('webdav-server:set-credentials', async (event, payload = {}) => {
  const state = webDavServer.getStatus().state;
  if (state !== 'stopped' && state !== 'error') {
    throw new Error('请先停止 WebDAV 服务，再修改账号密码');
  }
  const username = typeof payload?.username === 'string' ? payload.username.trim() : 'admin';
  const password = typeof payload?.password === 'string' ? payload.password : '';
  saveWebDavServerPreference({ username, password });
  return webDavServer.setCredentials(username, password);
});

ipcMain.handle('webdav-server:get-status', () => {
  const preference = loadWebDavServerPreference();
  const status = webDavServer.getStatus();
  const idle = status.state === 'stopped' || status.state === 'error';
  return {
    ...status,
    // 停止时回显上次的端口与地址（下次启动优先尝试同一个）
    lastPort: idle ? preference.preferredPort : null,
    lastAddress: idle ? preference.preferredAddress : null,
    persistedUsername: preference.username,
    // 预热完成前 controller 还没拿到密码，用持久化文件的标志兜底
    persistedHasPassword: Boolean(preference.password)
  };
});

ipcMain.handle('webdav-server:start', async (event) => {
  if (event.sender.isDestroyed()) throw new Error('当前窗口已关闭');
  if (webDavServerOwnerId !== null && webDavServerOwnerId !== event.sender.id) {
    throw new Error('其他窗口正在管理 WebDAV 服务');
  }
  webDavServerOwnerId = event.sender.id;
  try {
    const preference = await applyWebDavPreference();
    if (!webDavServer.getStatus().selectedRoot) {
      throw new Error('请先选择存储路径');
    }
    const result = await webDavServer.start(preference);
    if (result?.port) {
      saveWebDavServerPreference({
        port: result.port,
        address: result.primaryAddress || preference.preferredAddress || null
      });
    }
    return result;
  } catch (error) {
    if (webDavServer.getStatus().state !== 'running') webDavServerOwnerId = null;
    throw new Error(`启动 WebDAV 服务失败: ${error.message}`);
  }
});

ipcMain.handle('webdav-server:stop', async (event) => {
  if (webDavServerOwnerId !== null && webDavServerOwnerId !== event.sender.id) {
    throw new Error('只有启动服务的窗口可以停止 WebDAV 服务');
  }
  const result = await webDavServer.stop('requested');
  webDavServerOwnerId = null;
  return result;
});

// 选择签名文件
ipcMain.handle('select-keystore', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Keystore Files', extensions: ['jks', 'keystore'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

async function listAndroidDevices() {
  const { stdout } = await runTool('adb', ['devices'], { timeout: 8000 });
  return String(stdout).split(/\r?\n/).slice(1).flatMap((line) => {
    const match = line.trim().match(/^(\S+)\s+(\S+)$/);
    if (!match || match[2] !== 'device') return [];
    const id = match[1];
    return [{ id, platform: 'android', name: id, model: null, label: id }];
  });
}

async function getIosDeviceMetadata(id) {
  try {
    const { stdout } = await runTool('ideviceinfo', ['-u', id], {
      timeout: 3500,
      maxBuffer: 1024 * 1024
    });
    const metadata = {};
    for (const line of String(stdout).split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return {
      name: metadata.DeviceName || metadata.ProductType || id,
      model: metadata.ProductType || null,
      // ProductVersion 就是 iOS 版本（如 18.2）。ideviceinfo 本来就会返回它，
      // 之前只留了 name/model 把它丢掉了 —— 而「iOS 能不能操作设备」正是靠它判断的，
      // 丢掉之后就永远显示「未知设备版本」。
      version: metadata.ProductVersion || null
    };
  } catch (_) {
    return { name: id, model: null, version: null };
  }
}

async function listIosDevices() {
  const { stdout } = await runTool('idevice_id', ['-l'], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const ids = [...new Set(String(stdout).split(/\r?\n/).map(id => id.trim()).filter(Boolean))];
  return Promise.all(ids.map(async (id) => {
    const metadata = await getIosDeviceMetadata(id);
    const label = metadata.name === id ? id : `${metadata.name} (${id})`;
    return { id, platform: 'ios', name: metadata.name, model: metadata.model, version: metadata.version, label };
  }));
}

ipcMain.handle('get-log-devices', async (event, platform) => {
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error('设备平台只能是 android 或 ios');
  }
  try {
    const devices = platform === 'android' ? await listAndroidDevices() : await listIosDevices();
    return { platform, devices };
  } catch (error) {
    throw new Error(`无法获取 ${platform === 'android' ? 'Android' : 'iOS'} 设备列表: ${error.message}`);
  }
});

// 兼容现有组件：仅返回已授权的 Android 设备 ID
ipcMain.handle('get-devices', async () => {
  try {
    const devices = await listAndroidDevices();
    return devices.map(device => device.id);
  } catch (error) {
    throw new Error(`无法获取设备列表，请确保 ADB 已安装并配置环境变量: ${error.message}`);
  }
});

ipcMain.handle('scrcpy:detect', async () => scrcpy.detect());
ipcMain.handle('scrcpy:get-status', () => scrcpy.getStatus());
ipcMain.handle('scrcpy:start', async (event, options) => {
  if (event.sender.isDestroyed()) throw new Error('当前窗口已关闭');
  return scrcpy.start(options || {});
});
ipcMain.handle('scrcpy:stop', async (event, deviceId) => scrcpy.stop(deviceId));

ipcMain.handle('ios-mirror:capabilities', async () => iosMirror.getCapabilities());
ipcMain.handle('ios-mirror:request-access', async () => {
  if (process.platform !== 'darwin' || typeof systemPreferences.askForMediaAccess !== 'function') {
    return { granted: true, status: 'unknown', platform: process.platform };
  }
  const current = systemPreferences.getMediaAccessStatus('camera');
  if (current === 'granted') return { granted: true, status: current, platform: 'darwin' };
  const ok = await systemPreferences.askForMediaAccess('camera');
  const status = systemPreferences.getMediaAccessStatus('camera');
  return { granted: Boolean(ok) || status === 'granted', status, platform: 'darwin' };
});
ipcMain.handle('ios-mirror:list-cameras', async () => iosMirror.listHostCameras());
ipcMain.handle('ios-mirror:screenshot', async (event, deviceId) => iosMirror.takeScreenshot(deviceId));
ipcMain.handle('ios-mirror:device-state', async (event, deviceId) => iosMirror.getDeviceState(deviceId));
ipcMain.handle('ios-mirror:save-frame', async (event, filePath, dataUrl) => iosMirror.saveDataUrl(filePath, dataUrl));

function detectPlatformFromPackage(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.apk') return 'android';
  if (ext === '.ipa') return 'ios';
  return '';
}

function emitInstallProgress(sender, payload) {
  if (!sender || sender.isDestroyed?.()) return;
  try {
    sender.send('install-progress', payload);
  } catch (_) {
    // 窗口已关闭时忽略进度
  }
}

/** jobId → { aborted, control }，用于支持批量安装中途取消。 */
const activeInstallJobs = new Map();

function emitInstallBatchProgress(sender, jobId, payload) {
  if (!sender || sender.isDestroyed?.()) return;
  try {
    sender.send('install-batch-progress', { jobId, ...payload });
  } catch (_) {
    // 窗口已关闭时忽略进度
  }
}

/** 用户主动取消时，给正在跑的安装进程一个可识别的错误。 */
class InstallCancelledError extends Error {
  constructor(message = '已取消安装') {
    super(message);
    this.name = 'InstallCancelledError';
    this.cancelled = true;
  }
}

function outputLooksFailed(text) {
  return /Failure|error:|failed/i.test(text) && !/Success|Install: Complete|App installed/i.test(text);
}

async function installAndroidPackage(filePath, deviceId, onProgress, control) {
  onProgress?.({ percent: 8, stage: '开始安装 APK' });
  const args = deviceId
    ? ['-s', deviceId, 'install', '-r', filePath]
    : ['install', '-r', filePath];
  let latest = { percent: 8, stage: '正在安装 APK' };
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await runToolStream('adb', args, {
      timeout: 300000,
      onChild: (child) => { if (control) control.child = child; },
      onChunk: (_chunk, _stream, so, se) => {
        latest = parsePackageInstallProgress(`${so || ''}\n${se || ''}`, latest.percent);
        onProgress?.(latest);
      }
    }));
  } catch (error) {
    // 进程是我们自己 kill 掉的，adb 的报错没有意义
    if (control?.cancelled) throw new InstallCancelledError();
    throw error;
  }
  const text = `${stdout || ''}\n${stderr || ''}`.trim();
  if (outputLooksFailed(text) || !/Success/i.test(text)) throw new Error(text || 'adb 安装失败');
  onProgress?.({ percent: 100, stage: '安装完成' });
  return { success: true, platform: 'android', message: 'APK 安装成功' };
}

async function confirmIosAppInstalled(deviceId, bundleId) {
  if (!bundleId) return false;
  try {
    const { stdout } = await runIdeviceinstaller(runTool, listBundleArgSets(deviceId, bundleId), {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024
    });
    return String(stdout || '').includes(bundleId);
  } catch (_) {
    return false;
  }
}

async function runIosIdeviceInstall(idevice, deviceId, targetPath, onProgress, control) {
  let latest = { percent: 10, stage: '开始安装 IPA' };
  onProgress?.(latest);
  try {
    const { stdout, stderr } = await runIdeviceinstallerStream(
      runToolStream,
      installArgSets(deviceId, targetPath),
      {
        executable: idevice.path,
        timeout: 300000,
        onChild: (child) => { if (control) control.child = child; },
        onChunk: (_chunk, _stream, so, se) => {
          latest = parsePackageInstallProgress(`${so || ''}\n${se || ''}`, latest.percent);
          onProgress?.(latest);
        }
      }
    );
    const text = `${stdout || ''}\n${stderr || ''}`.trim();
    return { ok: iosInstallSucceeded(text), text };
  } catch (error) {
    // 用户取消导致的 kill 不是安装失败，往上抛专用错误
    if (control?.cancelled) throw new InstallCancelledError();
    const text = collectInstallOutput(error);
    latest = parsePackageInstallProgress(text, latest.percent);
    onProgress?.(latest);
    return { ok: iosInstallSucceeded(text), text };
  }
}

async function installIosPackage(filePath, deviceId, onProgress, control) {
  if (!deviceId) throw new Error('请选择要安装的 iOS 设备');
  const errors = [];

  const idevice = await detectTool('ideviceinstaller');
  let signatureSuspect = false;
  if (idevice.installed) {
    let lastText = '';
    const ipaResult = await runIosIdeviceInstall(idevice, deviceId, filePath, onProgress, control);
    lastText = ipaResult.text;
    signatureSuspect = looksLikeSignatureFailure(lastText);
    if (ipaResult.ok) {
      onProgress?.({ percent: 92, stage: '正在确认设备上的应用' });
      const bundleId = parseInstalledBundleId(ipaResult.text);
      const confirmed = bundleId ? await confirmIosAppInstalled(deviceId, bundleId) : true;
      if (confirmed) {
        onProgress?.({ percent: 100, stage: '安装完成' });
        return { success: true, platform: 'ios', message: 'IPA 安装成功（ideviceinstaller）' };
      }
      lastText = [lastText, `设备上未找到 ${bundleId}`].join('\n');
    }

    let extracted = null;
    try {
      onProgress?.({ percent: 30, stage: '正在解包 IPA 后重试' });
      extracted = await extractIpaAppDirectory(filePath, onProgress);
      const appResult = await runIosIdeviceInstall(idevice, deviceId, extracted.appDir, onProgress, control);
      lastText = [lastText, appResult.text].filter(Boolean).join('\n');
      signatureSuspect = signatureSuspect || looksLikeSignatureFailure(appResult.text);
      if (appResult.ok) {
        onProgress?.({ percent: 92, stage: '正在确认设备上的应用' });
        const bundleId = parseInstalledBundleId(appResult.text);
        const confirmed = bundleId ? await confirmIosAppInstalled(deviceId, bundleId) : true;
        if (confirmed) {
          onProgress?.({ percent: 100, stage: '安装完成' });
          return { success: true, platform: 'ios', message: 'IPA 安装成功（解包 .app）' };
        }
        lastText = [lastText, `设备上未找到 ${bundleId}`].join('\n');
      }
    } catch (error) {
      // 取消不是安装失败，往上抛给批量流程归一化
      if (error?.cancelled) throw error;
      lastText = [lastText, error.message].filter(Boolean).join('\n');
    } finally {
      if (extracted?.tmpDir) {
        await fs.promises.rm(extracted.tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    errors.push(`ideviceinstaller: ${explainIosInstallError(lastText)}`);
  } else {
    errors.push('未安装 ideviceinstaller');
  }

  const devicectl = await detectDevicectl();
  if (devicectl.installed) {
    let dcExtracted = null;
    try {
      // devicectl 要的是 **.app 包目录**，不是 .ipa：
      // 官方说明写着 "installs an app bundle (with a .app extension)"。
      // 之前直接把 .ipa 喂给它，即使 devicectl 被找到也会失败。
      onProgress?.({ percent: 50, stage: '改用 Xcode devicectl 安装（先解包）' });
      dcExtracted = await extractIpaAppDirectory(filePath, (info) => {
        onProgress?.({
          percent: 50 + Math.round((Number(info?.percent) || 0) * 0.1),
          stage: '解包 IPA（devicectl 需要 .app）'
        });
      });

      const { stdout, stderr } = await runToolStream('xcrun', [
        'devicectl', 'device', 'install', 'app', '--device', deviceId, dcExtracted.appDir
      ], {
        timeout: 300000,
        // devicectl 只随完整 Xcode 提供；xcode-select 指向 CommandLineTools 时
        // 必须显式给 DEVELOPER_DIR，否则连命令都找不到
        ...(devicectl.developerDir ? { env: { ...toolEnv, DEVELOPER_DIR: devicectl.developerDir } } : {}),
        onChild: (child) => { if (control) control.child = child; },
        onChunk: (_chunk, _stream, so, se) => {
          onProgress?.(parsePackageInstallProgress(`${so || ''}\n${se || ''}`, 60));
        }
      });
      const text = `${stdout || ''}\n${stderr || ''}`.trim();
      if (outputLooksFailed(text) || !/installed|complete|success/i.test(text)) {
        throw new Error(text || 'devicectl 安装失败');
      }
      onProgress?.({ percent: 100, stage: '安装完成' });
      return { success: true, platform: 'ios', message: 'IPA 安装成功（devicectl）' };
    } catch (error) {
      if (control?.cancelled || error?.cancelled) throw new InstallCancelledError();
      errors.push(`devicectl: ${error.message}`);
    } finally {
      if (dcExtracted?.tmpDir) {
        await fs.promises.rm(dcExtracted.tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } else {
    errors.push('未找到 Xcode devicectl');
  }

  // 签名类失败时不要只把 iOS 的错误码翻译成一句笼统的猜测 ——
  // 去读包内的描述文件，直接说清是「描述文件不含这台设备」还是「包名不匹配」。
  // 实测最常见的是**装错包**：原包与重签名产物只差一个 -resigned，极易选错。
  if (signatureSuspect) {
    try {
      const signature = await inspectIpaSignature(filePath, deviceId);
      const detail = describeIpaSignature(signature);
      if (detail) errors.push(detail);
    } catch (_) {
      // 读不出包内描述文件就保留原有文案，不能因为诊断失败而改变错误类型
    }
  }

  throw new Error(`iOS 安装失败。${errors.join('；')}`);
}

async function extractIpaAppDirectory(ipaPath, onProgress) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ipa-install-'));
  let archive = null;
  try {
    // 纯 JS 解压：Windows 上没有 unzip，改用内置 ZIP 读取器，三平台一致
    archive = openZip(ipaPath);
    onProgress?.({ percent: 10, stage: '解压 IPA 包体' });
    archive.extractTo(tmpDir, {
      filter: (entry) => entry.name === 'Payload/' || entry.name.startsWith('Payload/'),
      onProgress: (info) => {
        onProgress?.({
          percent: 10 + Math.round(info.percent * 0.25),
          stage: `解压 IPA 包体 ${info.percent}%`,
          detail: info.name
        });
      }
    });
    const payload = path.join(tmpDir, 'Payload');
    const names = await fs.promises.readdir(payload);
    const appName = names.find((name) => name.endsWith('.app'));
    if (!appName) throw new Error('IPA 中没有 Payload/*.app');
    return { tmpDir, appDir: path.join(payload, appName) };
  } catch (error) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    archive?.close();
  }
}

async function installAppPackage(filePath, deviceId, platformHint, onProgress, control) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('安装包不存在');
  const platform = platformHint || detectPlatformFromPackage(filePath);
  if (platform !== 'android' && platform !== 'ios') {
    throw new Error('仅支持 .apk 或 .ipa 安装包');
  }
  return platform === 'android'
    ? installAndroidPackage(filePath, deviceId, onProgress, control)
    : installIosPackage(filePath, deviceId, onProgress, control);
}

// 安装 APK（兼容旧接口）
ipcMain.handle('install-apk', async (event, apkPath, deviceId) => {
  try {
    return await installAppPackage(apkPath, deviceId, 'android', (payload) => emitInstallProgress(event.sender, payload));
  } catch (error) {
    throw new Error(`安装失败: ${error.message}`);
  }
});

ipcMain.handle('install-app', async (event, payload = {}) => {
  try {
    const filePath = payload.filePath || payload.apkPath || payload.path;
    const deviceId = payload.deviceId || payload.device || '';
    const platform = payload.platform || detectPlatformFromPackage(filePath);
    return await installAppPackage(filePath, deviceId, platform, (data) => emitInstallProgress(event.sender, data));
  } catch (error) {
    throw new Error(`安装失败: ${error.message}`);
  }
});

// ==================== 批量安装 ====================

ipcMain.handle('select-app-packages', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要安装的应用包（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '应用安装包', extensions: ['apk', 'ipa'] },
      { name: 'Android APK', extensions: ['apk'] },
      { name: 'iOS IPA', extensions: ['ipa'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

/**
 * 批量安装。
 *
 * 逐个串行安装（设备同一时刻只能装一个），每个包的进度会透传成整批的
 * 总体进度；与目标设备类型不符的文件直接标记为「跳过」并说明原因。
 */
ipcMain.handle('install-app-batch', async (event, payload = {}) => {
  const deviceId = payload.deviceId || payload.device || '';
  if (!deviceId) throw new Error('请选择目标设备');

  const targetPlatform = payload.platform
    || (Array.isArray(payload.files) ? detectPlatformFromPackage(payload.files[0]) : '');
  if (targetPlatform !== 'android' && targetPlatform !== 'ios') {
    throw new Error('无法判断目标设备类型，请先选择设备类型');
  }

  const plan = planInstallBatch(payload.files, targetPlatform);
  if (!plan.total) throw new Error('请提供要安装的应用包');
  if (!plan.installable_count) {
    throw new Error(`没有可安装的包体。${plan.items.find((item) => item.reason)?.reason || ''}`.trim());
  }

  const jobId = payload.jobId || `install-batch-${Date.now()}`;
  const job = { aborted: false, control: { child: null, cancelled: false } };
  activeInstallJobs.set(jobId, job);

  const startedAt = Date.now();
  const items = plan.items;
  const emit = (data) => emitInstallBatchProgress(event.sender, jobId, {
    ...data,
    elapsed_ms: Date.now() - startedAt
  });

  emit({
    phase: 'start',
    total: items.length,
    installable_count: plan.installable_count,
    skipped_count: plan.skipped_count,
    duplicates_dropped: plan.duplicates_dropped,
    items: items.map((item) => ({ ...item })),
    percent: 0,
    stage: `准备安装 ${plan.installable_count} 个安装包`
  });

  // 串行安装：顺序、进度换算、取消归一化、汇总都交给 runInstallBatch（可单测）
  let outcome;
  try {
    outcome = await runInstallBatch(items, {
      installOne: (item, onProgress, control) => installAppPackage(
        item.path,
        deviceId,
        item.platform,
        onProgress,
        control
      ),
      onEvent: (data) => emitInstallBatchProgress(event.sender, jobId, data),
      control: job.control,
      isAborted: () => job.aborted
    });
  } finally {
    activeInstallJobs.delete(jobId);
  }

  const summary = outcome.summary;
  emit({
    phase: 'done',
    total: items.length,
    items: items.map((item) => ({ ...item })),
    summary,
    percent: 100,
    stage: job.aborted ? '已取消' : '批量安装完成'
  });

  return {
    job_id: jobId,
    cancelled: job.aborted,
    items,
    summary,
    message: describeBatchResult(summary),
    elapsed_ms: outcome.elapsed_ms
  };
});

ipcMain.handle('cancel-install-batch', async (event, jobId) => {
  const job = jobId ? activeInstallJobs.get(jobId) : null;
  if (!job) return { success: false, message: '没有正在进行的批量安装' };
  job.aborted = true;
  // 正在跑的安装进程直接 kill，避免用户等一整个大包装完
  try {
    if (job.control) job.control.cancelled = true;
    if (job.control?.child && !job.control.child.killed) {
      job.control.child.kill();
    }
  } catch (_) {
    // 进程可能刚好自己退出了
  }
  return { success: true, message: '已请求取消，正在终止当前安装' };
});

function normalizeDeviceId(deviceId) {
  if (deviceId == null) return '';
  if (typeof deviceId === 'string' || typeof deviceId === 'number') return String(deviceId).trim();
  if (typeof deviceId === 'object') {
    return String(deviceId.id || deviceId.deviceId || deviceId.serial || deviceId.udid || '').trim();
  }
  return '';
}

function adbArgs(deviceId, args) {
  const serial = normalizeDeviceId(deviceId);
  return serial ? ['-s', serial, ...args] : args;
}

function posixShellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 反编译 APK
/**
 * 反编译 IPA。
 *
 * iOS 没有 apktool 的对应物 —— 真正的伪代码还原要靠 Hopper / IDA 那类工具，本项目不做。
 * 这里做的是**解包 + Mach-O 元数据提取**：
 *   1. 把 IPA 解压成目录（IPA 本身就是 zip），保留可执行位
 *   2. 从主二进制里抽出 ObjC 类名 / 方法名 / Swift 反射串 / 符号表 / C 字符串
 *   3. 把结果写成 `_symbols/*.txt`，方便直接搜
 *
 * 产出对应 Android 侧的「DEX 检索」：能回答「这个 App 里有哪些类、哪些方法」。
 */
async function decompileIpa(ipaPath, outputPath, onProgress) {
  const name = path.basename(ipaPath, path.extname(ipaPath));
  const targetDir = path.join(outputPath, name);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  const archive = openZip(ipaPath);
  try {
    onProgress?.({ percent: 5, stage: '解包 IPA' });
    const extracted = archive.extractTo(targetDir, {
      onProgress: (info) => onProgress?.({
        percent: 5 + Math.round(info.percent * 0.75),
        stage: `解包 IPA（${info.done}/${info.total}）`,
        detail: info.name
      })
    });

    // 主二进制：标准布局是 Payload/<AppName>.app/<AppName>
    const mainEntry = archive.entries.find((entry) => {
      if (entry.isDirectory) return false;
      const match = /^Payload\/([^/]+)\.app\/([^/]+)$/.exec(entry.name);
      return Boolean(match && match[1] === match[2]);
    });

    if (!mainEntry) {
      return {
        success: true,
        kind: 'ipa',
        outputDir: targetDir,
        extracted,
        message: `已解包 ${extracted.files} 个文件到 ${targetDir}，但没找到主二进制（Payload/*.app/ 下与应用同名的可执行文件），跳过符号提取`
      };
    }

    onProgress?.({ percent: 82, stage: '提取 Mach-O 元数据', detail: mainEntry.name });
    let symbols = null;
    try {
      symbols = extractMachoSymbols(archive.readEntry(mainEntry));
    } catch (error) {
      symbols = null;
      onProgress?.({ percent: 88, stage: `符号提取失败：${error.message}` });
    }

    if (!symbols) {
      return {
        success: true,
        kind: 'ipa',
        outputDir: targetDir,
        extracted,
        message: `已解包 ${extracted.files} 个文件到 ${targetDir}。主二进制不是可识别的 Mach-O，未提取符号`
      };
    }

    // 把提取结果落盘，方便用户直接 grep
    onProgress?.({ percent: 92, stage: '写出符号清单' });
    const symbolsDir = path.join(targetDir, '_symbols');
    fs.mkdirSync(symbolsDir, { recursive: true });
    const writeList = (file, list) => fs.writeFileSync(path.join(symbolsDir, file), list.join('\n'), 'utf8');
    writeList('classes.txt', symbols.classes);
    writeList('methods.txt', symbols.methods);
    writeList('method-types.txt', symbols.methodTypes);
    writeList('swift.txt', symbols.swiftTypes);
    writeList('strings.txt', symbols.strings);
    writeList('symbols.txt', symbols.symbols);
    fs.writeFileSync(path.join(symbolsDir, 'summary.json'), JSON.stringify({
      source: mainEntry.name,
      architectures: symbols.architectures,
      counts: {
        classes: symbols.classes.length,
        methods: symbols.methods.length,
        method_types: symbols.methodTypes.length,
        swift: symbols.swiftTypes.length,
        strings: symbols.strings.length,
        symbols: symbols.symbols.length
      }
    }, null, 2), 'utf8');

    onProgress?.({ percent: 100, stage: '完成' });
    return {
      success: true,
      kind: 'ipa',
      outputDir: targetDir,
      extracted,
      symbols: {
        binary: mainEntry.name,
        architectures: symbols.architectures,
        counts: {
          classes: symbols.classes.length,
          methods: symbols.methods.length,
          swift: symbols.swiftTypes.length,
          strings: symbols.strings.length,
          symbols: symbols.symbols.length
        },
        samples: {
          classes: symbols.classes.slice(0, 12),
          methods: symbols.methods.slice(0, 12)
        }
      },
      message: `已解包 ${extracted.files} 个文件，并从 ${mainEntry.name} 提取出 `
        + `${symbols.classes.length} 个 ObjC 类、${symbols.methods.length} 个方法、`
        + `${symbols.symbols.length} 个符号。清单在 ${path.join(targetDir, '_symbols')}`
    };
  } finally {
    archive.close();
  }
}

ipcMain.handle('decompile-apk', async (event, inputPath, outputPath, payload = {}) => {
  const ext = path.extname(String(inputPath || '')).toLowerCase();
  const onProgress = payload?.jobId
    ? (info) => {
      try {
        event.sender.send('decompile-progress', { jobId: payload.jobId, ...info });
      } catch (_) { /* 窗口可能已关闭，进度发不出去不影响主流程 */ }
    }
    : null;

  try {
    if (ext === '.ipa') {
      return await decompileIpa(inputPath, outputPath, onProgress);
    }

    if (ext !== '.apk' && ext !== '.aab') {
      throw new Error(`不支持的文件类型 ${ext || '（无扩展名）'}，仅支持 APK / AAB / IPA`);
    }

    const apkName = path.basename(inputPath, ext);
    const targetDir = path.join(outputPath, apkName);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    onProgress?.({ percent: 10, stage: '调用 apktool 解包' });
    await runTool('apktool', ['d', inputPath, '-o', targetDir, '-f'], {
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024
    });
    onProgress?.({ percent: 100, stage: '完成' });
    return {
      success: true,
      kind: 'apk',
      outputDir: targetDir,
      message: `反编译成功，输出目录: ${targetDir}`
    };
  } catch (error) {
    throw new Error(`反编译失败: ${error.message}`);
  }
});

ipcMain.handle('rebuild-package:inspect', async (_event, projectDir) => {
  const kind = detectProjectKind(projectDir);
  if (!kind) return { kind: null, defaultOutput: '' };
  return { kind, defaultOutput: defaultOutputPath(projectDir, kind) };
});

ipcMain.handle('rebuild-package', async (event, payload = {}) => {
  const onProgress = payload?.jobId
    ? (info) => {
      try {
        event.sender.send('decompile-progress', { jobId: payload.jobId, ...info });
      } catch (_) { /* 窗口可能已关闭，进度发不出去不影响主流程 */ }
    }
    : null;
  try {
    return await rebuildPackage({
      runTool,
      projectDir: payload.projectDir,
      outputPath: payload.outputPath,
      onProgress,
      sign: loadAppConfig()
    });
  } catch (error) {
    throw new Error(`回编译失败: ${error.message}`);
  }
});

// ==================== 读取应用信息（包体静态信息） ====================

const PACKAGE_INFO_WORKER = path.join(__dirname, 'pkginfo', 'worker.js');
/** jobId → Worker，用于支持用户主动取消解析。 */
const activePackageInfoJobs = new Map();
/** jobId → { aborted }，用于支持用户停止批量扫描。 */
const activeBatchJobs = new Map();

/**
 * 在 worker 线程里解析包体，避免大包（5~6 秒）阻塞主进程导致界面卡死。
 *
 * 极端环境下（例如某些受限的打包/沙箱环境）创建 worker 失败时，自动退回
 * 主进程同步解析 —— 功能优先，进度条降级但不至于直接报错。
 *
 * @param {string} filePath 包体路径
 * @param {{kind?: string, jobId?: string, onProgress?: Function}} [options]
 */
function parsePackageInfoAsync(filePath, options = {}) {
  return new Promise((resolve, reject) => {
    let worker = null;
    try {
      worker = new Worker(PACKAGE_INFO_WORKER, {
        workerData: { filePath, kind: options.kind || null }
      });
    } catch (error) {
      // 无法创建 worker：退回同步解析
      try {
        resolve(parsePackageStaticInfo(filePath, { kind: options.kind, onProgress: options.onProgress }));
      } catch (syncError) {
        reject(syncError);
      }
      return;
    }

    const { jobId } = options;
    if (jobId) activePackageInfoJobs.set(jobId, worker);

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (jobId) activePackageInfoJobs.delete(jobId);
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      fn(value);
    };

    worker.on('message', (message) => {
      if (!message) return;
      if (message.type === 'progress') {
        try { options.onProgress?.(message.progress); } catch (_) { /* 忽略 */ }
        return;
      }
      if (message.type === 'done') finish(resolve, message.result);
      else finish(reject, new Error(message.message || '解析失败'));
    });
    worker.on('error', (error) => finish(reject, error));
    worker.on('exit', (code) => {
      finish(reject, new Error(code === 0 ? '解析进程提前退出' : `解析进程异常退出（code ${code}）`));
    });
  });
}

function emitPackageInfoProgress(sender, jobId, progress) {
  if (!sender || sender.isDestroyed?.()) return;
  try {
    sender.send('package-info-progress', { jobId, ...progress });
  } catch (_) {
    // 窗口已关闭时忽略进度
  }
}

/**
 * 统一入口：解析 APK / AAB / IPA 的静态信息，返回 { basic, detailed } 两层结构。
 * 纯 JS 实现，不依赖 aapt / keytool / plutil 等外部工具。
 */
async function getPackageStaticInfo(event, payload) {
  const data = typeof payload === 'string' ? { filePath: payload } : (payload || {});
  const filePath = data.filePath || data.path || '';
  const jobId = data.jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const onProgress = (progress) => emitPackageInfoProgress(event?.sender, jobId, {
    ...progress,
    elapsed_ms: Date.now() - startedAt
  });

  onProgress({ percent: 0, stage: '准备解析' });
  const result = await parsePackageInfoAsync(filePath, { kind: data.kind, jobId, onProgress });
  onProgress({ percent: 100, stage: '解析完成' });
  return { ...result, job_id: jobId };
}

// 读取应用信息（APK / AAB / IPA 通用）
ipcMain.handle('get-apk-info', async (event, payload) => {
  try {
    return await getPackageStaticInfo(event, payload);
  } catch (error) {
    throw new Error(`读取应用信息失败: ${error.message}`);
  }
});

ipcMain.handle('get-package-info', async (event, payload) => {
  try {
    return await getPackageStaticInfo(event, payload);
  } catch (error) {
    throw new Error(`读取应用信息失败: ${error.message}`);
  }
});

ipcMain.handle('get-package-static-info', async (event, payload) => {
  try {
    return await getPackageStaticInfo(event, payload);
  } catch (error) {
    throw new Error(`读取应用信息失败: ${error.message}`);
  }
});

// 取消正在进行的解析（终止对应 worker）
ipcMain.handle('cancel-package-info', async (event, payload) => {
  const jobId = typeof payload === 'string' ? payload : payload?.jobId;
  const worker = jobId ? activePackageInfoJobs.get(jobId) : null;
  if (!worker) return { success: false, message: '没有正在进行的解析任务' };
  activePackageInfoJobs.delete(jobId);
  await worker.terminate().catch(() => {});
  return { success: true, message: '已取消解析' };
});

// ==================== 批量扫描 ====================

ipcMain.handle('select-package-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择包含 APK / AAB / IPA 的目录',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true, directory: null };
  return { canceled: false, directory: result.filePaths[0] };
});

ipcMain.handle('batch-scan-packages', async (event, payload = {}) => {
  const jobId = payload.jobId || `batch-${Date.now()}`;
  const signal = { aborted: false };
  activeBatchJobs.set(jobId, signal);

  const emit = (progress) => {
    if (event?.sender?.isDestroyed?.()) return;
    try {
      event.sender.send('batch-scan-progress', { jobId, ...progress });
    } catch (_) { /* 窗口已关闭 */ }
  };

  try {
    const result = await batchScanner.scan({
      directory: payload.directory,
      recursive: payload.recursive !== false,
      limit: payload.limit,
      signal,
      onProgress: emit,
      onItem: (row) => emit({ percent: null, row, partial: true })
    });
    return { ...result, job_id: jobId };
  } catch (error) {
    throw new Error(`批量扫描失败: ${error.message}`);
  } finally {
    activeBatchJobs.delete(jobId);
  }
});

ipcMain.handle('cancel-batch-scan', async (event, jobId) => {
  const signal = activeBatchJobs.get(jobId);
  if (!signal) return { success: false, message: '没有正在进行的批量扫描' };
  signal.aborted = true;
  return { success: true, message: '已请求停止，当前包解析完成后停止' };
});

ipcMain.handle('export-batch-scan-result', async (event, payload = {}) => {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new Error('没有可导出的扫描结果');
  const format = payload.format === 'csv' ? 'csv' : (payload.format === 'markdown' ? 'markdown' : 'json');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const baseName = payload.defaultName || `包体扫描结果-${stamp}`;

  const filters = {
    csv: [{ name: 'CSV', extensions: ['csv'] }],
    json: [{ name: 'JSON', extensions: ['json'] }],
    markdown: [{ name: 'Markdown', extensions: ['md'] }]
  }[format];

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出扫描结果',
    defaultPath: `${baseName}.${{ csv: 'csv', json: 'json', markdown: 'md' }[format]}`,
    filters
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  const content = format === 'csv'
    ? toCsv(rows, BATCH_COLUMNS)
    : (format === 'markdown' ? toMarkdown(rows, BATCH_COLUMNS) : JSON.stringify(rows, null, 2));

  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, filePath: result.filePath, format, count: rows.length };
  } catch (error) {
    throw new Error(`导出失败: ${error.message}`);
  }
});

// ==================== Dex 工具集 ====================

const DEX_JAR_TOOL_IDS = ['baksmali', 'smali', 'cfr'];

function getDexJarTools() {
  return DEX_JAR_TOOL_IDS
    .map((id) => toolInstaller.TOOL_DEFS.find((tool) => tool.id === id))
    .filter(Boolean)
    .map((tool) => ({
      id: tool.id,
      name: tool.name,
      jar: tool.jarName,
      url: tool.url,
      mirrors: tool.mirrors,
      approxBytes: tool.approxBytes,
      note: tool.providesNote
    }));
}

async function detectToolSafe(tool, args) {
  try {
    const result = await detectTool(tool, args);
    return result.installed;
  } catch (_) {
    return false;
  }
}

async function detectToolPath(tool, args) {
  try {
    const result = await detectTool(tool, args);
    return result.installed ? result.path : null;
  } catch (_) {
    return null;
  }
}

function resolveDexToolDir(toolId) {
  const tool = toolInstaller.TOOL_DEFS.find((item) => item.id === toolId);
  if (!tool) return toolInstaller.toolRoot();
  return toolInstaller.installDirFor(tool);
}

// Dex 工具集的可下载工具（jar 类 + dex-tools 压缩包），其余（d8 / javac）来自系统
const DEX_DOWNLOADABLE_IDS = ['baksmali', 'smali', 'cfr', 'dex-tools'];

/** 用户自定义工具目录的持久化配置文件（userData/dex-tools.json）。 */
function dexToolConfigPath() {
  return path.join(app.getPath('userData'), 'dex-tools.json');
}

function loadDexToolDirs() {
  try {
    const file = dexToolConfigPath();
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const raw = data?.customDirs;
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' && value) out[key] = value;
    }
    return out;
  } catch (_) {
    return {};
  }
}

function saveDexToolDirs(dirs) {
  const file = dexToolConfigPath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ customDirs: dirs }, null, 2));
  fs.renameSync(temp, file);
}

function sendDexProgress(event, jobId, info) {
  try {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed?.()) return;
    sender.send('dex-toolkit:progress', { jobId, ...info });
  } catch (_) { /* 进度推送失败不影响任务 */ }
}

/**
 * 探测依赖工具（baksmali / smali / cfr / dex-tools / d8 / javac）的状态。
 *
 * 每个工具都会返回 `path`（解析到的实际文件路径，找不到为 null）、
 * `customDir`（用户在 UI 上指定的自定义目录）与 `downloadable`（是否可下载）。
 *
 * 平台策略（用户确认）：Windows 走应用内一键安装；mac / Linux 优先用系统上已有的，
 * 没有就在 UI 上给「下载 / 选择本地目录」入口，不替用户静默改动系统目录。
 */
ipcMain.handle('dex-toolkit:status', async () => {
  const customDirs = loadDexToolDirs();
  const dirsFor = (id) => (customDirs[id] ? [customDirs[id]] : []);

  const jarTools = getDexJarTools().map((item) => {
    const found = findJarTool(toolInstaller, item.jar, dirsFor(item.id));
    const defaultDir = resolveDexToolDir(item.id);
    return {
      id: item.id,
      name: item.name,
      jar: item.jar,
      kind: 'jar',
      installed: Boolean(found),
      path: found,
      customDir: customDirs[item.id] || '',
      dir: defaultDir,
      // 展示给用户的「所在目录」：优先实际命中的目录，其次是自定义目录，最后是默认安装目录
      locatedDir: found ? path.dirname(found) : (customDirs[item.id] || defaultDir),
      downloadable: true,
      url: item.url,
      approxBytes: item.approxBytes,
      note: item.note
    };
  });

  const dexTools = resolveDexTools(toolInstaller, dirsFor('dex-tools'));
  const dexToolsDefaultDir = resolveDexToolDir('dex-tools');
  const d8Path = await detectToolPath('d8', ['--version']);
  const javacPath = await detectToolPath('javac', ['-version']);

  return {
    platform: process.platform,
    windowsAutoInstall: process.platform === 'win32',
    tools: [
      ...jarTools,
      {
        id: 'dex-tools',
        name: 'dex-tools（d2j-dex2jar）',
        kind: 'dex-tools',
        note: 'Dex 工具集：dex2jar（dex → jar，还原真正的 .class）',
        installed: Boolean(dexTools),
        path: dexTools,
        customDir: customDirs['dex-tools'] || '',
        dir: dexToolsDefaultDir,
        locatedDir: dexTools ? path.dirname(dexTools) : (customDirs['dex-tools'] || dexToolsDefaultDir),
        downloadable: true
      },
      {
        id: 'd8',
        name: 'd8',
        kind: 'builtin',
        note: '随 Android SDK build-tools 提供：DEX → DEX（优化）+ 桥梁',
        installed: Boolean(d8Path),
        path: d8Path,
        customDir: '',
        locatedDir: d8Path ? path.dirname(d8Path) : '',
        downloadable: false
      },
      {
        id: 'javac',
        name: 'javac / jar',
        kind: 'builtin',
        note: '随 JDK 提供：Java 编译 / 打包',
        installed: Boolean(javacPath),
        path: javacPath,
        customDir: '',
        locatedDir: javacPath ? path.dirname(javacPath) : '',
        downloadable: false
      }
    ],
    dexTools: Boolean(dexTools),
    d8: Boolean(d8Path),
    javac: Boolean(javacPath),
    toolDir: toolInstaller.toolRoot()
  };
});

/**
 * 「下载」：走 tool-installer 的安装流程，落到应用工具目录。
 * jar 类落成 <dir>/<jarName>，dex-tools 解压后摊平 —— 之后都能被自动搜索到。
 */
ipcMain.handle('dex-toolkit:download', async (event, payload = {}) => {
  const toolId = payload.toolId;
  if (!DEX_DOWNLOADABLE_IDS.includes(toolId)) return { ok: false, error: '未知工具' };
  const jobId = `dex-dl-${toolId}`;
  try {
    await toolInstaller.installTool(toolId, {
      onProgress: (info) => sendDexProgress(event, jobId, info)
    });
    refreshToolEnvironment();
    // 安装后重新解析一次，返回实际落地的文件路径（找不到则返回 null，前端会以状态刷新为准）
    const customDirs = loadDexToolDirs();
    const dirs = customDirs[toolId] ? [customDirs[toolId]] : [];
    let installedPath = null;
    if (toolId === 'dex-tools') {
      installedPath = resolveDexTools(toolInstaller, dirs);
    } else {
      const def = toolInstaller.TOOL_DEFS.find((item) => item.id === toolId);
      installedPath = def ? findJarTool(toolInstaller, def.jarName, dirs) : null;
    }
    return { ok: true, toolId, path: installedPath || null };
  } catch (error) {
    return { ok: false, toolId, error: error.message };
  }
});

/** 「选择目录」：持久化用户指定的工具目录（dir 为空字符串表示清除）。 */
ipcMain.handle('dex-toolkit:set-tool-dir', async (_event, payload = {}) => {
  const toolId = payload.toolId;
  if (!toolId) return { ok: false, error: '缺少工具 id' };
  const dir = typeof payload.dir === 'string' ? payload.dir.trim() : '';
  const dirs = loadDexToolDirs();
  if (dir) dirs[toolId] = path.resolve(dir);
  else delete dirs[toolId];
  try {
    saveDexToolDirs(dirs);
  } catch (error) {
    return { ok: false, error: `保存失败: ${error.message}` };
  }
  return { ok: true, toolId, dir: dirs[toolId] || '' };
});

ipcMain.handle('dex-toolkit:run', async (event, payload = {}) => {
  const jobId = payload.jobId || `dex-${Date.now()}`;
  const onProgress = (info) => sendDexProgress(event, jobId, info);
  const extraDirs = Object.values(loadDexToolDirs()).filter(Boolean);
  try {
    const result = await runDexAction({
      action: payload.action,
      inputs: payload.inputs || [],
      outputDir: payload.outputDir,
      runTool,
      runToolStream,
      toolInstaller,
      extraDirs,
      onProgress
    });
    return { ok: true, jobId, ...result };
  } catch (error) {
    return { ok: false, jobId, error: error.message };
  }
});

// 默认输出目录：输入是目录取目录本身，是文件取所在文件夹（与输入同目录）
ipcMain.handle('dex-toolkit:default-output', async (_event, payload = {}) => {
  const inputs = Array.isArray(payload) ? payload : (payload.inputs || []);
  try {
    return { ok: true, outputDir: await resolveDefaultOutputDir(inputs) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('dex-toolkit:reveal', async (_event, targetPath) => {
  if (!targetPath) return { ok: false };
  try {
    const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
    if (stat && stat.isDirectory()) {
      await shell.openPath(targetPath);
    } else if (stat) {
      shell.showItemInFolder(targetPath);
    } else if (!path.extname(targetPath)) {
      await shell.openPath(targetPath);
    } else {
      return { ok: false, error: '路径不存在' };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

/**
 * 启动命令：从 APK / AAB 读出包名与入口 Activity，拼出可复制的 adb 命令。
 * 只解析 Manifest，不跑 DEX 等重活，所以很快。
 */
ipcMain.handle('dex-toolkit:launch-command', async (_event, payload = {}) => {
  const filePath = typeof payload === 'string' ? payload : (payload.filePath || payload.path || '');
  if (!filePath) return { ok: false, error: '请选择 APK 文件' };
  try {
    return { ok: true, ...buildLaunchCommand(filePath) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/** 查壳：识别 APK / AAB 的加固方案与对抗特征（独立入口，复用包体解析的签名库）。 */
ipcMain.handle('dex-toolkit:check-packer', async (_event, payload = {}) => {
  const filePath = typeof payload === 'string' ? payload : (payload.filePath || payload.path || '');
  if (!filePath) return { ok: false, error: '请选择 APK 文件' };
  try {
    return { ok: true, ...inspectPacker(filePath) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// ==================== 缺失工具自动安装（仅 Windows） ====================
//
// Windows 没有包管理器，用户看到「未找到工具 adb」往往不知道去哪下、下完放哪。
// 这里直接代劳：下载 → 解压 → 注册到工具搜索目录。详见 electron/tool-installer.js。
// mac / Linux 直接返回 supported:false，前端不展示这块 UI（brew / apt 一行命令就够）。

ipcMain.handle('tool-installer:list', async () => ({
  supported: process.platform === 'win32',
  platform: process.platform,
  root: toolInstaller.toolRoot(),
  tools: toolInstaller.listInstalled()
}));

ipcMain.handle('tool-installer:install', async (event, payload = {}) => {
  const toolId = payload.toolId || payload;
  // 同一工具同时只允许一个安装任务（UI 也是这么禁用的），所以直接用 toolId 当取消键
  const jobId = `tool-${toolId}`;
  const signal = { aborted: false };
  toolInstallAborts.set(toolId, signal);
  try {
    const result = await toolInstaller.installTool(toolId, {
      signal,
      onProgress: (progress) => {
        for (const window of BrowserWindow.getAllWindows()) {
          try {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
              window.webContents.send('tool-installer:progress', { jobId, ...progress });
            }
          } catch (_) { /* 窗口销毁中，忽略 */ }
        }
      }
    });
    // 装完后重建工具环境，让 runTool 立刻能找到新落盘的可执行文件
    refreshToolEnvironment();
    return { jobId, ...result, ok: true };
  } catch (error) {
    return { jobId, ok: false, error: error.message };
  } finally {
    toolInstallAborts.delete(toolId);
  }
});

ipcMain.handle('tool-installer:cancel', async (event, payload = {}) => {
  const toolId = payload.toolId || payload;
  const signal = toolInstallAborts.get(toolId);
  if (signal) signal.aborted = true;
  return { canceled: Boolean(signal) };
});

ipcMain.handle('tool-installer:uninstall', async (event, payload = {}) => {
  const toolId = payload.toolId || payload;
  try {
    await toolInstaller.uninstallTool(toolId);
    refreshToolEnvironment();
    return { ok: true };
  } catch (error) {
    throw new Error(`卸载失败: ${error.message}`);
  }
});

// ==================== 平台能力自检 ====================

ipcMain.handle('get-platform-capabilities', async (event, options = {}) => {
  try {
    return await platformCapabilities.getPlatformCapabilities(options || {});
  } catch (error) {
    throw new Error(`平台能力检测失败: ${error.message}`);
  }
});

// 导出解析结果为 JSON
ipcMain.handle('export-package-info', async (event, payload) => {
  const data = payload && typeof payload === 'object' ? payload : {};
  const sourcePath = typeof data.filePath === 'string' ? data.filePath : '';
  const content = typeof data.content === 'string' ? data.content : '';
  if (!content) throw new Error('没有可导出的内容');

  const defaultName = sourcePath
    ? `${path.basename(sourcePath, path.extname(sourcePath))}-info.json`
    : 'package-info.json';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出包体静态信息',
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, filePath: result.filePath };
  } catch (error) {
    throw new Error(`导出失败: ${error.message}`);
  }
});

// ==================== iOS 设备控制（WebDriverAgent） ====================
//
// 走 WDA 的 HTTP 接口：兼容 iOS 12+，不需要内核隧道与开发者镜像。
// 后端选型依据见 COMPETITIVE_ANALYSIS.md。

ipcMain.handle('ios-control:probe', async (event, payload = {}) => iosControl.probe(payload.deviceId));

ipcMain.handle('ios-control:screen', async () => {
  const size = await iosControl.getScreenSize();
  return { width: size.width, height: size.height };
});

ipcMain.handle('ios-control:tap', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.tap(payload.x, payload.y);
  return { ok: true };
});

ipcMain.handle('ios-control:long-press', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.longPress(payload.x, payload.y, payload.duration);
  return { ok: true };
});

ipcMain.handle('ios-control:swipe', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.swipe(payload.from, payload.to, payload.duration);
  return { ok: true };
});

// 屏幕锁定状态（ideviceinfo 的 PasswordProtected）。查不到按未知处理，
// 让 UI 用「尽力而为」的话术而不是误报。
ipcMain.handle('ios-control:lock-state', async (event, payload = {}) => {
  const deviceId = payload.deviceId || '';
  if (!deviceId) return { locked: null, known: false };
  try {
    const { stdout } = await runTool('ideviceinfo', ['-u', deviceId, '-k', 'PasswordProtected'], {
      timeout: 3500,
      maxBuffer: 64 * 1024
    });
    const text = String(stdout).trim().toLowerCase();
    return { locked: text === 'true', known: text !== '' };
  } catch (_) {
    return { locked: null, known: false };
  }
});

// 解锁：只对「无密码」或「本轮已输过密码」的设备有效。
// XCUITest 不能向锁屏密码键盘注入触摸，有密码的设备仍要在设备上手动输一次。
ipcMain.handle('ios-control:unlock', async () => {
  await iosControl.unlock();
  return { ok: true };
});

ipcMain.handle('ios-control:type', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.typeText(payload.text);
  return { ok: true };
});

ipcMain.handle('ios-control:home', async () => {
  await iosControl.ensureSession();
  await iosControl.pressHome();
  return { ok: true };
});

ipcMain.handle('ios-control:press-button', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.pressButton(payload.button);
  return { ok: true };
});

ipcMain.handle('ios-control:swipe-direction', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.swipeDirection(payload.direction);
  return { ok: true };
});

ipcMain.handle('ios-control:launch-app', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.launchApp(payload.bundleId);
  return { ok: true };
});

ipcMain.handle('ios-control:terminate-app', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.terminateApp(payload.bundleId);
  return { ok: true };
});

ipcMain.handle('ios-control:active-app', async (event, payload = {}) => {
  await iosControl.ensureSession();
  return iosControl.activeApp();
});

ipcMain.handle('ios-control:zoom', async (event, payload = {}) => {
  await iosControl.ensureSession();
  await iosControl.zoom(payload.mode, payload.options || {});
  return { ok: true };
});

ipcMain.handle('ios-control:disconnect', async () => {
  await iosControl.dropSession();
  return { ok: true };
});

// MJPEG 实时流（设备 9100 端口，画质成帧 30fps 左右，远快于截图轮询）。
// 返回本地代理端口，渲染层用 <img src="http://127.0.0.1:<port>/"> 直接消费。
// 失败时抛错，渲染层据此回退到截图轮询 —— 不能因为画面通道起不来就让用户点不了。
ipcMain.handle('ios-control:start-mjpeg', async (event, payload = {}) => {
  await iosControl.ensureSession();
  return iosControl.startMjpegProxy(payload.deviceId);
});

ipcMain.handle('ios-control:stop-mjpeg', async () => {
  await iosControl.stopMjpegProxy();
  return { ok: true };
});

// 启动设备上的 WebDriverAgent（用 tidevice wdaproxy，免 Xcode）。
// WDA 装在设备上但没在跑时，这是「能不能点」的唯一出路 ——
// 之前只让用户自己去装 Xcode，等于没给路。
ipcMain.handle('ios-control:start-wda', async (event, payload = {}) => {
  const result = await iosControl.startWda(payload.deviceId);
  if (!result.ok) {
    throw new Error(describeWdaStartFailure(result));
  }
  return { ok: true, reused: Boolean(result.reused), already: Boolean(result.already) };
});

ipcMain.handle('ios-control:stop-wda', async () => {
  await iosControl.stopWda();
  return { ok: true };
});

// ==================== 无人值守 AutoPilot（13 天级调度） ====================
//
// 脚本格式 + 能力详见 electron/autopilot.js。这里只做 IPC 薄壳。
// 注意：`validate` 只校验不起跑，UI 可用来即时提示脚本是否合法；
// `runOnce` 给「现在立刻跑一次」的按钮用，调度主链路走 `start`。

ipcMain.handle('autopilot:validate', async (_event, script) => {
  try {
    const result = getAutoPilot().validate(script);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('autopilot:start', async (_event, script) => {
  try {
    const result = await getAutoPilot().start(script);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('autopilot:stop', async () => {
  try {
    return { ok: true, ...getAutoPilot().stop() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('autopilot:run-once', async (_event, script) => {
  // 异步执行，不阻塞 IPC：抛给后台 promise，UI 用 status 查结果
  const ap = getAutoPilot();
  ap._runOnce(script)
    .catch((error) => { console.error('[autopilot] run-once 失败：', error.message); });
  return { ok: true, queued: true };
});

ipcMain.handle('autopilot:status', async () => {
  try {
    return { ok: true, snapshot: getAutoPilot().snapshot() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// iOS 控制后端探测：只回报「这台机器上装了哪些工具」。
// 「能不能操作、走哪条路、缺什么」的判定放在渲染层（纯函数，可单测）——
// 主进程是 CJS，引用不了 src/lib 里的 ESM 模块。
ipcMain.handle('detect-ios-control-tools', async () => {
  const tools = {};
  // tidevice 能免 Xcode 启动设备上已安装的 WDA（`tidevice wdaproxy`），
  // 所以它决定了「WDA 未运行」这一步能不能由应用自己解决。
  for (const name of ['go-ios', 'pymobiledevice3', 'tidevice']) {
    try {
      tools[name] = Boolean(await detectTool(name));
    } catch (_) {
      tools[name] = false;
    }
  }
  return { platform: process.platform, tools };
});

// 在包体 DEX 里检索类名 / 字符串（「这个功能在哪个类」「密钥硬编码在哪」）
ipcMain.handle('search-package-symbols', async (event, payload = {}) => {
  const filePath = payload.path || payload.filePath;
  if (!filePath) throw new Error('请提供包体文件路径');
  return searchPackageSymbols(filePath, {
    query: payload.query,
    scope: payload.scope,
    limit: payload.limit
  });
});

// 对比两个包体（文档 2.18 差异字段）
ipcMain.handle('compare-package-info', async (event, payload) => {
  const beforePath = payload && payload.beforePath;
  const afterPath = payload && payload.afterPath;
  if (!beforePath || !afterPath) throw new Error('请提供两个包体路径');
  const jobId = payload?.jobId || `cmp-${Date.now()}`;
  const startedAt = Date.now();
  const onProgress = (progress) => emitPackageInfoProgress(event?.sender, jobId, {
    ...progress,
    elapsed_ms: Date.now() - startedAt
  });
  try {
    onProgress({ percent: 0, stage: '解析旧版本包体' });
    const beforeInfo = await parsePackageInfoAsync(beforePath, {
      onProgress: (info) => onProgress({ ...info, percent: Math.round(info.percent * 0.45), stage: `旧版本 · ${info.stage}` })
    });
    onProgress({ percent: 50, stage: '解析新版本包体' });
    const afterInfo = await parsePackageInfoAsync(afterPath, {
      onProgress: (info) => onProgress({ ...info, percent: 50 + Math.round(info.percent * 0.45), stage: `新版本 · ${info.stage}` })
    });
    onProgress({ percent: 97, stage: '计算版本差异' });
    const diff = comparePackageInfo(beforeInfo, afterInfo);
    onProgress({ percent: 100, stage: '对比完成' });
    return {
      job_id: jobId,
      before: { basic: beforeInfo.basic, container: beforeInfo.container },
      after: { basic: afterInfo.basic, container: afterInfo.container },
      diff
    };
  } catch (error) {
    throw new Error(`对比失败: ${error.message}`);
  }
});

// APK 签名：先 zipalign，再按勾选的 v1/v2/v3 调用 apksigner
ipcMain.handle('sign-apk', async (_event, payload = {}) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('签名参数无效，请升级后重试');
  }
  try {
    return await signApk({
      runTool,
      apkPath: payload.apkPath,
      keystorePath: payload.keystorePath,
      alias: payload.alias,
      password: payload.password,
      v1: payload.v1,
      v2: payload.v2,
      v3: payload.v3
    });
  } catch (error) {
    throw new Error(error.message);
  }
});

ipcMain.handle('list-codesign-identities', async () => {
  try {
    return await listCodeSignIdentities();
  } catch (error) {
    throw new Error(`读取本机证书失败: ${error.message}`);
  }
});

ipcMain.handle('inspect-provision', async (event, provisionPath) => {
  try {
    return await inspectProvision(provisionPath);
  } catch (error) {
    throw new Error(`读取配置文件失败: ${error.message}`);
  }
});

ipcMain.handle('resign-ipa', async (event, payload = {}) => {
  const sender = event?.sender;
  try {
    return await resignIpa({
      ...payload,
      // 重签名要解压几百 MB、签上百个目标、再重新打包 —— 不给进度界面会长时间没反应
      onProgress: (progress) => {
        if (!sender || sender.isDestroyed?.()) return;
        try {
          sender.send('resign-progress', progress);
        } catch (_) {
          // 窗口已关闭时忽略进度
        }
      }
    });
  } catch (error) {
    throw new Error(`iOS 重签名失败: ${error.message}`);
  }
});

// 读一个 IPA 的签名事实（描述文件、包名、设备列表是否含当前设备）。
// 单独做成 IPC 是为了让界面能给出**基于事实**的提示，而不是写死的断言。
ipcMain.handle('inspect-ipa-signature', async (event, payload = {}) => {
  const ipaPath = String(payload.ipaPath || '').trim();
  if (!ipaPath) throw new Error('请提供 IPA 路径');
  let deviceId = String(payload.deviceId || '').trim();
  if (!deviceId) {
    // 没指定就取当前连着的第一台 —— 用户关心的是「能不能装到我正插着的那台」
    try {
      const { stdout } = await runTool('idevice_id', ['-l'], { timeout: 5000 });
      deviceId = String(stdout || '').trim().split('\n')[0] || '';
    } catch (_) {
      // 读不到设备就不断言设备相关结论
    }
  }
  return inspectIpaSignature(ipaPath, deviceId);
});

function loadAppConfig() {
  const fallback = { keystorePath: '', alias: 'csgame', password: '123' };
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    if (!fs.existsSync(configPath)) return fallback;
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      keystorePath: typeof data.keystorePath === 'string' ? data.keystorePath : '',
      alias: typeof data.alias === 'string' && data.alias ? data.alias : fallback.alias,
      password: typeof data.password === 'string' && data.password ? data.password : fallback.password
    };
  } catch (_) {
    return fallback;
  }
}

// 保存配置
ipcMain.handle('save-config', async (event, config) => {
  try {
    const payload = {
      keystorePath: typeof config?.keystorePath === 'string' ? config.keystorePath : '',
      alias: typeof config?.alias === 'string' ? config.alias : 'csgame',
      password: typeof config?.password === 'string' ? config.password : '123'
    };
    const configPath = path.join(app.getPath('userData'), 'config.json');
    const tempPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, configPath);
    return { success: true, config: payload };
  } catch (error) {
    throw new Error(`保存配置失败: ${error.message}`);
  }
});

// 加载配置
ipcMain.handle('load-config', async () => {
  return loadAppConfig();
});

// 选择单个文件
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

// 选择多个文件
ipcMain.handle('select-multiple-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? null : result.filePaths;
});

// 选择文件（带过滤选项）
ipcMain.handle('select-files', async (event, options) => {
  const opts = options || {};
  const properties = Array.isArray(opts.properties) ? opts.properties : ['openFile'];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties,
    filters: opts.filters || []
  });
  if (result.canceled) return null;
  // 兼容既有调用方：默认单选返回单个路径字符串；显式请求多选时返回路径数组
  return properties.includes('multiSelections') ? result.filePaths : result.filePaths[0];
});

// 保存文件对话框
ipcMain.handle('save-file', async (event, options) => {
  const opts = options || {};
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: opts.defaultPath || undefined,
    filters: opts.filters || []
  });
  return result.canceled ? null : result.filePath;
});

// 获取目录下所有文件
ipcMain.handle('get-files-in-directory', async (event, dirPath) => {
  try {
    const files = [];
    
    function walkDir(dir) {
      const items = fs.readdirSync(dir);
      items.forEach(item => {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          files.push(fullPath);
        } else if (stat.isDirectory()) {
          walkDir(fullPath);
        }
      });
    }
    
    walkDir(dirPath);
    return files;
  } catch (error) {
    throw new Error(`读取目录失败: ${error.message}`);
  }
});

ipcMain.handle('batch-rename:collect', async (event, paths, options = {}) => {
  return batchRename.collectFiles(Array.isArray(paths) ? paths : [paths], options || {});
});

ipcMain.handle('batch-rename:apply', async (event, operations, options = {}) => {
  return batchRename.applyRenames(operations || [], options || {});
});

ipcMain.handle('batch-rename:undo', async (event, operations) => {
  return batchRename.undoRenames(operations || []);
});

ipcMain.handle('write-text-file', async (event, filePath, content) => {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('无效的保存路径');
  fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
  return { success: true, path: filePath };
});

ipcMain.handle('read-text-file', async (event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('无效的文件路径');
  return fs.readFileSync(filePath, 'utf8');
});

// 计算文件 Hash
function calculateHash(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// 获取文件 Hash
ipcMain.handle('get-file-hash', async (event, filePaths) => {
  const results = [];
  
  for (const filePath of filePaths) {
    try {
      const md5 = await calculateHash(filePath, 'md5');
      const sha1 = await calculateHash(filePath, 'sha1');
      const sha256 = await calculateHash(filePath, 'sha256');
      
      results.push({
        filename: path.basename(filePath),
        path: filePath,
        md5,
        sha1,
        sha256,
        success: true
      });
    } catch (error) {
      results.push({
        filename: path.basename(filePath),
        path: filePath,
        success: false,
        error: error.message
      });
    }
  }
  
  return results;
});

// ==================== 文件管理功能 ====================

function fileOpPayload(first, second, third, localIsSecond = false) {
  if (first && typeof first === 'object' && !Array.isArray(first)) return first;
  if (localIsSecond) {
    return { deviceId: first, localPath: second, remotePath: third, platform: 'android' };
  }
  return { deviceId: first, path: second, remotePath: second, localPath: third, platform: 'android' };
}

ipcMain.handle('list-device-files', async (event, deviceId, remotePath) => {
  try {
    return await deviceFiles.listFiles(fileOpPayload(deviceId, remotePath));
  } catch (error) {
    throw new Error(`读取文件列表失败: ${error.message}`);
  }
});

ipcMain.handle('pull-file', async (event, deviceId, remotePath, localPath) => {
  try {
    return await deviceFiles.pullFile(fileOpPayload(deviceId, remotePath, localPath));
  } catch (error) {
    throw new Error(`下载文件失败: ${error.message}`);
  }
});

ipcMain.handle('push-file', async (event, deviceId, localPath, remotePath) => {
  try {
    return await deviceFiles.pushFile(fileOpPayload(deviceId, localPath, remotePath, true));
  } catch (error) {
    throw new Error(`上传文件失败: ${error.message}`);
  }
});

ipcMain.handle('delete-device-file', async (event, deviceId, remotePath) => {
  try {
    return await deviceFiles.deleteFile(fileOpPayload(deviceId, remotePath));
  } catch (error) {
    throw new Error(`删除文件失败: ${error.message}`);
  }
});

ipcMain.handle('get-phone-device-info', async (event, payload = {}) => {
  try {
    return await phoneDeviceInfo.getInfo(payload);
  } catch (error) {
    throw new Error(`读取连接设备信息失败: ${error.message}`);
  }
});

ipcMain.handle('phone-device:list-actions', (_event, payload = {}) => {
  return deviceActions.listActions(payload);
});

ipcMain.handle('phone-device:action', async (event, payload = {}) => {
  const meta = describeAction(payload.action);
  if (!meta) throw new Error(`不支持的操作: ${payload.action || '（空）'}`);
  const next = { ...payload };
  if (meta.save) {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(ownerWindow || mainWindow, {
      defaultPath: `device-${meta.id}-${Date.now()}.${meta.save}`,
      filters: [{ name: meta.save.toUpperCase(), extensions: [meta.save] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    next.outputPath = result.filePath;
  }
  try {
    return await deviceActions.run(next);
  } catch (error) {
    throw new Error(error.message);
  }
});

ipcMain.handle('list-device-apps', async (event, payload = {}) => {
  try {
    return await deviceApps.listApps(payload);
  } catch (error) {
    throw new Error(`读取应用列表失败: ${error.message}`);
  }
});

ipcMain.handle('get-device-app-icon', async (event, payload = {}) => {
  try {
    return await deviceApps.getAppIcon(payload);
  } catch (error) {
    throw new Error(`读取应用图标失败: ${error.message}`);
  }
});

ipcMain.handle('uninstall-device-app', async (event, payload = {}) => {
  try {
    return await deviceApps.uninstallApp(payload);
  } catch (error) {
    throw new Error(`卸载应用失败: ${error.message}`);
  }
});

ipcMain.handle('export-device-app', async (event, payload = {}) => {
  try {
    return await deviceApps.exportApp(payload);
  } catch (error) {
    throw new Error(`导出应用失败: ${error.message}`);
  }
});

ipcMain.handle('clear-device-app-cache', async (event, payload = {}) => {
  try {
    return await deviceApps.clearAppCache(payload);
  } catch (error) {
    throw new Error(`清除缓存失败: ${error.message}`);
  }
});

ipcMain.handle('clear-device-app-data', async (event, payload = {}) => {
  try {
    return await deviceApps.clearAppData(payload);
  } catch (error) {
    throw new Error(`清除数据失败: ${error.message}`);
  }
});

ipcMain.handle('http-request', async (event, payload = {}) => {
  const method = String(payload.method || 'GET').toUpperCase();
  const rawUrl = String(payload.url || '').trim();
  if (!rawUrl) throw new Error('请输入请求 URL');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw new Error('不支持的请求方法');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('URL 无效，请包含 http:// 或 https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http 和 https 请求');
  }

  const query = Array.isArray(payload.params) ? payload.params : [];
  for (const item of query) {
    const key = String(item?.key || '').trim();
    if (!key || item?.enabled === false) continue;
    parsed.searchParams.append(key, String(item?.value ?? ''));
  }

  const headers = {};
  const headerRows = Array.isArray(payload.headers) ? payload.headers : [];
  for (const item of headerRows) {
    const key = String(item?.key || '').trim();
    if (!key || item?.enabled === false) continue;
    headers[key] = String(item?.value ?? '');
  }

  const init = { method, headers };
  if (!['GET', 'HEAD'].includes(method) && payload.body != null && payload.body !== '') {
    init.body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
  }

  const timeoutMs = Math.min(Math.max(Number(payload.timeout) || 30000, 1000), 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;
  const started = Date.now();

  try {
    const response = await fetch(parsed.toString(), init);
    const body = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body,
      url: response.url,
      durationMs: Date.now() - started
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
    throw new Error(`请求失败: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
});

const MAX_LOG_REMAINDER = 64 * 1024;
const MAX_STDERR_TAIL = 8 * 1024;
const MAX_PENDING_LOGS = 2000;
const MAX_LOG_BATCH = 500;
const LOG_BATCH_INTERVAL = 100;
let activeLogSession = null;
let logTransition = Promise.resolve();

function queueLogTransition(operation) {
  const result = logTransition.then(operation, operation);
  logTransition = result.catch(() => {});
  return result;
}

function isOwnerAvailable(session) {
  return session && session.owner && !session.owner.isDestroyed();
}

function sendToLogOwner(session, channel, payload) {
  if (!isOwnerAvailable(session)) return;
  session.owner.send(channel, payload);
}

function sendLogStatus(session, status, details = {}) {
  sendToLogOwner(session, 'log-capture-status', {
    status,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceType: session.deviceType,
    severity: details.severity || (status === 'error' ? 'error' : 'info'),
    message: details.message || '',
    code: details.code ?? null,
    signal: details.signal ?? null
  });
}

function flushPendingLogs(session) {
  if (!session || session.pendingLogs.length === 0) return;
  if (!isOwnerAvailable(session) || session.finalized) {
    session.pendingLogs.length = 0;
    return;
  }
  const batch = session.pendingLogs.splice(0, MAX_LOG_BATCH);
  sendToLogOwner(session, 'log-data-batch', {
    sessionId: session.sessionId,
    logs: batch
  });
}

function queueLogForOwner(session, log) {
  session.pendingLogs.push(log);
  if (session.pendingLogs.length > MAX_PENDING_LOGS) {
    const overflow = session.pendingLogs.length - MAX_PENDING_LOGS;
    session.pendingLogs.splice(0, overflow);
    session.droppedPendingLogs += overflow;
  }
}

function clearLogSessionBuffers(session) {
  if (!session) return;
  if (session.flushTimer) {
    clearInterval(session.flushTimer);
    session.flushTimer = null;
  }
  session.pendingLogs.length = 0;
  session.stdoutRemainder = '';
  session.stderrTail = '';
}

function detachLogChildStreams(session) {
  const child = session?.child;
  if (!child) return;
  child.stdout?.removeAllListeners('data');
  child.stderr?.removeAllListeners('data');
  child.stdout?.pause();
  child.stderr?.pause();
}

function appendStderrTail(session, text) {
  session.stderrTail = (session.stderrTail + text).slice(-MAX_STDERR_TAIL);
}

function finalizeLogSession(session, details = {}) {
  if (session.finalized) return;
  flushLogDecoders(session);
  flushPendingLogs(session);
  session.finalized = true;
  session.closeDetails = details;
  clearLogSessionBuffers(session);
  detachLogChildStreams(session);
  session.owner = null;
  session.child = null;
  session.stdoutDecoder = null;
  session.stderrDecoder = null;
  if (activeLogSession === session) activeLogSession = null;
  if (session.resolveClosed) session.resolveClosed(details);
  session.resolveClosed = null;
}

function forceKillLogSessionSync(session) {
  if (!session || session.finalized || !session.child) return;
  try { session.child.kill('SIGKILL'); } catch (_) { /* 进程可能已退出，kill 失败是正常的 */ }
}

function waitForSessionClose(session, timeoutMs) {
  if (session.finalized) return Promise.resolve(session.closeDetails || {});
  return Promise.race([
    session.closed,
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

async function stopActiveLogSession(session, reason = 'requested') {
  if (!session || session.finalized) return false;
  if (!session.stopRequested) {
    session.stopRequested = true;
    sendLogStatus(session, 'stopping', { message: reason === 'owner-destroyed' ? '日志窗口已关闭' : '正在停止日志捕获' });
  }

  const child = session.child;
  if (child) detachLogChildStreams(session);
  clearLogSessionBuffers(session);
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    finalizeLogSession(session, { code: child ? child.exitCode : null, signal: child ? child.signalCode : null });
  } else {
    try { child.kill('SIGTERM'); } catch (_) { /* 进程可能已退出，SIGTERM 失败是正常的 */ }
    let closed = await waitForSessionClose(session, 2000);
    if (!closed && !session.finalized) {
      try { child.kill('SIGKILL'); } catch (_) { /* 同上，SIGKILL 失败说明进程已经没了 */ }
      closed = await waitForSessionClose(session, 1000);
    }
    if (!closed && !session.finalized) {
      finalizeLogSession(session, { code: child.exitCode, signal: child.signalCode, timedOut: true });
    }
  }

  sendLogStatus(session, 'stopped', {
    message: '日志捕获已停止',
    code: session.closeDetails?.code,
    signal: session.closeDetails?.signal
  });
  return true;
}

function consumeLogOutput(session, text, flush = false) {
  session.stdoutRemainder += text;
  const lines = session.stdoutRemainder.split(/\r?\n/);
  session.stdoutRemainder = flush ? '' : lines.pop();
  if (flush && lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!flush && session.stdoutRemainder.length > MAX_LOG_REMAINDER) {
    session.stdoutRemainder = session.stdoutRemainder.slice(-MAX_LOG_REMAINDER);
    if (!session.remainderWarningSent) {
      session.remainderWarningSent = true;
      sendLogStatus(session, 'running', {
        severity: 'warning',
        message: '日志单行超过缓冲上限，已截断未完成内容'
      });
    }
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    const log = parseLogLine(line, session.deviceType);
    session.sequence += 1;
    queueLogForOwner(session, {
      ...log,
      sessionId: session.sessionId,
      sequence: session.sequence
    });
  }
}

function flushLogDecoders(session) {
  if (session.decodersFlushed) return;
  session.decodersFlushed = true;
  if (!session.stdoutDecoder || !session.stderrDecoder) return;
  consumeLogOutput(session, session.stdoutDecoder.end(), true);
  const stderrEnd = session.stderrDecoder.end();
  if (stderrEnd) appendStderrTail(session, stderrEnd);
}

function createLogSession(owner, deviceId, deviceType) {
  let resolveClosed;
  const session = {
    sessionId: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    owner,
    ownerId: owner.id,
    deviceId,
    deviceType,
    child: null,
    sequence: 0,
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    stdoutRemainder: '',
    stderrTail: '',
    pendingLogs: [],
    droppedPendingLogs: 0,
    flushTimer: null,
    remainderWarningSent: false,
    stopRequested: false,
    finalized: false,
    decodersFlushed: false,
    closeDetails: null,
    resolveClosed: null,
    closed: new Promise(resolve => { resolveClosed = resolve; })
  };
  session.resolveClosed = resolveClosed;
  session.flushTimer = setInterval(() => flushPendingLogs(session), LOG_BATCH_INTERVAL);
  session.flushTimer.unref?.();
  return session;
}

function startLogChild(session, executable, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let spawned = false;
    let child;
    try {
      child = spawn(executable, args, { shell: false, env: toolEnv, windowsHide: true });
      session.child = child;
    } catch (error) {
      finalizeLogSession(session, { error });
      reject(error);
      return;
    }

    child.stdout.on('data', (data) => {
      if (activeLogSession !== session || session.finalized) return;
      consumeLogOutput(session, session.stdoutDecoder.write(data));
    });
    child.stderr.on('data', (data) => {
      if (session.finalized) return;
      const text = session.stderrDecoder.write(data);
      appendStderrTail(session, text);
      if (activeLogSession === session && text.trim()) {
        sendLogStatus(session, 'running', {
          severity: 'warning',
          message: text.trim().slice(-MAX_STDERR_TAIL)
        });
      }
    });
    child.once('spawn', () => {
      spawned = true;
      if (activeLogSession !== session || session.stopRequested) return;
      sendLogStatus(session, 'running', { message: '日志捕获已启动' });
      if (!settled) {
        settled = true;
        resolve({ success: true, status: 'running', sessionId: session.sessionId });
      }
    });
    child.once('error', (error) => {
      if (session.finalized) return;
      sendLogStatus(session, 'error', { message: error.message, code: error.code });
      finalizeLogSession(session, { error, code: error.code || null, signal: null });
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => {
      if (session.finalized) return;
      const wasRequested = session.stopRequested;
      flushLogDecoders(session);
      const stderr = session.stderrTail.trim();
      if (!wasRequested) {
        sendLogStatus(session, code === 0 ? 'stopped' : 'error', {
          severity: code === 0 ? 'info' : 'error',
          message: stderr || `日志进程已退出${code === null ? '' : `，退出码 ${code}`}`,
          code,
          signal
        });
      }
      finalizeLogSession(session, { code, signal });
      if (!settled && !spawned) {
        settled = true;
        reject(new Error(stderr || '日志进程在启动前退出'));
      }
    });
  });
}

ipcMain.handle('start-log-capture', (event, request) => queueLogTransition(async () => {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('启动日志捕获需要 { deviceId, deviceType }');
  }
  const { deviceId, deviceType } = request;
  if (typeof deviceId !== 'string' || !deviceId.trim() || !['android', 'ios'].includes(deviceType)) {
    throw new Error('deviceId 必须是非空字符串，deviceType 必须是 android 或 ios');
  }
  const owner = event.sender;
  if (owner.isDestroyed()) throw new Error('日志窗口已关闭');
  if (activeLogSession) {
    if (activeLogSession.ownerId !== owner.id) throw new Error('其他窗口正在捕获日志');
    await stopActiveLogSession(activeLogSession, 'restart');
  }

  const tool = deviceType === 'android' ? 'adb' : 'idevicesyslog';
  const executable = resolveTool(tool);
  const args = deviceType === 'android'
    ? ['-s', deviceId.trim(), 'logcat', '-v', 'time']
    : ['-u', deviceId.trim(), '--no-colors', '-x'];
  const session = createLogSession(owner, deviceId.trim(), deviceType);
  activeLogSession = session;
  sendLogStatus(session, 'starting', { message: '正在启动日志捕获' });
  try {
    return await startLogChild(session, executable, args);
  } catch (error) {
    if (activeLogSession === session) activeLogSession = null;
    throw new Error(`启动日志捕获失败: ${error.message}`);
  }
}));

ipcMain.handle('stop-log-capture', (event, sessionId) => queueLogTransition(async () => {
  const session = activeLogSession;
  if (!session || typeof sessionId !== 'string' || session.sessionId !== sessionId) {
    return { success: true, stopped: false, sessionId: typeof sessionId === 'string' ? sessionId : null };
  }
  if (session.ownerId !== event.sender.id) throw new Error('只有日志捕获的所有者可以停止该会话');
  const stopped = await stopActiveLogSession(session);
  return { success: true, stopped, sessionId };
}));

// 解析日志行
function parseLogLine(line, deviceType) {
  if (deviceType === 'android') {
    // Android logcat 格式: 01-15 12:30:45.123 V/Tag(12345): Message
    const match = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+([VDIWEF])\/(.+?)\(\s*(\d+)\):\s*(.*)$/);
    if (match) {
      return {
        timestamp: match[1],
        level: match[2],
        tag: match[3],
        pid: match[4],
        message: match[5]
      };
    }
  } else if (deviceType === 'ios') {
    // Apple syslog: Sep 11 11:57:56.606665 mediaserverd(CoreAudio)[34] <Notice>: Message
    const appleMatch = line.match(/^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+([^\s\[]+?)(?:\(([^)]+)\))?\[\d+\]\s+<(Debug|Notice|Info|Default|Warning|Error|Fault|Critical)>:\s*(.*)$/i);
    if (appleMatch) {
      const levels = {
        debug: 'D', notice: 'I', info: 'I', default: 'I',
        warning: 'W', error: 'E', fault: 'F', critical: 'F'
      };
      return {
        timestamp: appleMatch[1],
        level: levels[appleMatch[4].toLowerCase()] || 'I',
        tag: appleMatch[3] || appleMatch[2],
        message: appleMatch[5]
      };
    }

    // 连接状态等 idevicesyslog 行。
    const statusMatch = line.match(/^\[([^\]]+)\]\s*:?[ \t]*(.*)$/);
    if (statusMatch) {
      return {
        timestamp: new Date().toLocaleTimeString(),
        level: 'I',
        tag: 'status',
        message: statusMatch[2] ? `[${statusMatch[1]}] ${statusMatch[2]}` : `[${statusMatch[1]}]`,
        raw: line
      };
    }

    // 兼容旧格式: Jan 15 12:30:45 iPhone MyApp[12345]: Message
    const legacyMatch = line.match(/^(\w+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\S+\s+(.+?)\[\d+\]:\s*(.*)$/);
    if (legacyMatch) {
      return {
        timestamp: legacyMatch[1],
        level: 'I',
        tag: legacyMatch[2],
        message: legacyMatch[3]
      };
    }
  }

  // 如果无法解析，完整保留原始行
  return {
    timestamp: new Date().toLocaleTimeString(),
    level: 'I',
    tag: '',
    message: line,
    raw: line
  };
}

// 获取 Android 设备上运行的应用进程（PID→包名），用于日志包名筛选
ipcMain.handle('get-android-apps', async (event, deviceId) => {
  try {
    const { stdout } = await runTool('adb', ['-s', String(deviceId || '').trim(), 'shell', 'ps'], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    const raw = String(stdout);
    let lines = raw.split(/\r?\n/);
    // 兼容旧版/新版 ps：若首行是表头则跳过
    if (lines.length > 0 && lines[0].includes('USER') && lines[0].includes('PID')) {
      lines = lines.slice(1);
    }
    const processes = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      // ps 输出格式: USER PID PPID VSZ RSS WCHAN ADDR S NAME
      // NAME 列是最后一个，包含包名
      const name = parts[parts.length - 1];
      if (!name || !name.includes('.')) continue;
      // 只取最后一个进程名（多进程时是 com.example:service）
      const pid = parseInt(parts[1], 10);
      if (!Number.isFinite(pid)) continue;
      processes.push({ pid, packageName: name });
    }
    return { deviceId: String(deviceId || '').trim(), processes };
  } catch (error) {
    throw new Error(`获取应用列表失败: ${error.message}`);
  }
});

// 保存日志文件
ipcMain.handle('save-log-file', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (error) {
    throw new Error(`保存日志失败: ${error.message}`);
  }
});

// Markdown 相关功能
ipcMain.handle('save-markdown', async (event, content) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'Markdown Files', extensions: ['md'] }],
      defaultPath: 'document.md'
    });
    
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false };
  } catch (error) {
    throw new Error(`保存失败: ${error.message}`);
  }
});

ipcMain.handle('load-markdown', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown Files', extensions: ['md', 'markdown', 'txt'] }]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      const content = fs.readFileSync(result.filePaths[0], 'utf-8');
      return content;
    }
    return null;
  } catch (error) {
    throw new Error(`加载失败: ${error.message}`);
  }
});

ipcMain.handle('export-html', async (event, htmlContent) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'HTML Files', extensions: ['html'] }],
      defaultPath: 'document.html'
    });
    
    if (!result.canceled && result.filePath) {
      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Export</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
    h1, h2, h3 { color: #2c3e50; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; }
    blockquote { border-left: 4px solid #3498db; padding-left: 16px; color: #7f8c8d; }
    a { color: #3498db; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
      fs.writeFileSync(result.filePath, fullHtml, 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false };
  } catch (error) {
    throw new Error(`导出失败: ${error.message}`);
  }
});

// XMind 相关功能
ipcMain.handle('parse-xmind-file', async (event, filePath) => {
  try {
    const JSZip = require('jszip');
    const xml2js = require('xml2js');

    // 读取 .xmind 文件（zip 格式）
    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data);

    // 获取 content.xml（XMind 的核心内容文件）
    const contentFile = zip.file('content.xml');
    if (!contentFile) {
      throw new Error('无效的 XMind 文件：缺少 content.xml');
    }

    const contentXml = await contentFile.async('string');
    const result = await xml2js.parseStringPromise(contentXml, { explicitArray: true });

    // 解析 XMind 结构为通用的思维导图格式
    const sheet = result['xmap-content']?.sheet?.[0];
    if (!sheet) {
      throw new Error('无法解析 XMind 内容');
    }

    const rootTopic = sheet.topic?.[0];
    if (!rootTopic) {
      throw new Error('XMind 文件中没有主题内容');
    }

    const parseTopic = (topic) => {
      const node = {
        title: topic.title?.[0] || '(无标题)',
        children: []
      };

      // 解析子主题
      const childrenTopics = topic.children?.[0]?.topics?.[0]?.topic || [];
      node.children = childrenTopics.map(parseTopic);

      return node;
    };

    return parseTopic(rootTopic);
  } catch (error) {
    throw new Error(`解析 XMind 文件失败: ${error.message}`);
  }
});

ipcMain.handle('export-mindmap-text', async (event, textContent) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'Text Files', extensions: ['txt', 'md'] }],
      defaultPath: 'mindmap.txt'
    });
    
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, textContent, 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false };
  } catch (error) {
    throw new Error(`导出失败: ${error.message}`);
  }
});

function prettyPlatformName() {
  const platform = os.platform();
  const release = os.release();
  if (platform === 'darwin') {
    const major = Number.parseInt(String(release).split('.')[0], 10);
    const names = {
      25: 'macOS 26',
      24: 'macOS 15 Sequoia',
      23: 'macOS 14 Sonoma',
      22: 'macOS 13 Ventura',
      21: 'macOS 12 Monterey'
    };
    return names[major] || `macOS (Darwin ${release})`;
  }
  if (platform === 'win32') return `Windows ${release}`;
  if (platform === 'linux') return `Linux ${release}`;
  return `${platform} ${release}`;
}

async function collectDisks() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFilePromise('wmic', ['logicaldisk', 'get', 'Caption,FileSystem,FreeSpace,Size'], {
        timeout: 5000,
        windowsHide: true
      });
      return String(stdout).split(/\r?\n/).slice(1).flatMap((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return [];
        const total = Number(parts[3]);
        const available = Number(parts[2]);
        if (!total) return [];
        return [{
          filesystem: parts[1],
          mount: parts[0],
          total,
          available,
          used: total - available,
          usagePercent: `${Math.round(((total - available) / total) * 100)}%`
        }];
      });
    }
    const { stdout } = await execFilePromise('df', ['-kP'], { timeout: 5000 });
    return String(stdout).split(/\r?\n/).slice(1).flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return [];
      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      const available = Number(parts[3]) * 1024;
      if (!total || parts[0] === 'devfs' || parts[5] === '/dev') return [];
      return [{
        filesystem: parts[0],
        mount: parts[5],
        total,
        used,
        available,
        usagePercent: parts[4]
      }];
    });
  } catch (_) {
    return [];
  }
}

async function collectGateway() {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFilePromise('route', ['-n', 'get', 'default'], { timeout: 4000 });
      const gateway = stdout.match(/gateway:\s+(\S+)/i);
      const iface = stdout.match(/interface:\s+(\S+)/i);
      return { gateway: gateway ? gateway[1] : null, interface: iface ? iface[1] : null };
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFilePromise('route', ['print', '0.0.0.0'], { timeout: 4000, windowsHide: true });
      const match = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
      return { gateway: match ? match[1] : null, interface: null };
    }
    const { stdout } = await execFilePromise('ip', ['route', 'show', 'default'], { timeout: 4000 });
    const match = stdout.match(/default via (\S+) dev (\S+)/);
    return { gateway: match ? match[1] : null, interface: match ? match[2] : null };
  } catch (_) {
    return { gateway: null, interface: null };
  }
}

function collectDnsServers() {
  try {
    if (process.platform === 'win32') return [];
    const text = fs.readFileSync('/etc/resolv.conf', 'utf8');
    return text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^nameserver\s+(\S+)/);
      return match ? [match[1]] : [];
    });
  } catch (_) {
    return [];
  }
}

function collectDisplays() {
  try {
    return screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label || `显示器 ${display.id}`,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: Boolean(display.internal),
      size: `${display.bounds.width} × ${display.bounds.height}`
    }));
  } catch (_) {
    return [];
  }
}

// 获取设备信息
ipcMain.handle('get-device-info', async () => {
  try {
    const cpus = os.cpus() || [];
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const user = os.userInfo();
    const [disks, route] = await Promise.all([collectDisks(), collectGateway()]);
    const uniqueModels = [...new Set(cpus.map((cpu) => cpu.model).filter(Boolean))];

    return {
      system: {
        platform: os.platform(),
        prettyName: prettyPlatformName(),
        type: os.type(),
        release: os.release(),
        version: typeof os.version === 'function' ? os.version() : os.release(),
        arch: os.arch(),
        machine: typeof os.machine === 'function' ? os.machine() : os.arch(),
        endianness: os.endianness(),
        hostname: os.hostname(),
        username: user.username,
        uid: user.uid,
        gid: user.gid,
        homedir: os.homedir(),
        tmpdir: os.tmpdir(),
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        uptime: os.uptime(),
        loadavg: os.loadavg()
      },
      cpu: {
        model: uniqueModels.join(' / ') || '未知',
        models: uniqueModels,
        speed: cpus[0] ? cpus[0].speed : 0,
        cores: cpus.length,
        physicalCores: Math.max(1, [...new Set(cpus.map((cpu) => `${cpu.model}-${cpu.speed}`))].length),
        times: cpus.map((cpu, index) => ({ index, ...cpu.times }))
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usagePercent: ((usedMem / totalMem) * 100).toFixed(2)
      },
      disks,
      displays: collectDisplays(),
      network: os.networkInterfaces(),
      route,
      dns: collectDnsServers(),
      node: {
        version: process.version,
        versions: process.versions,
        v8: process.versions.v8,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        openssl: process.versions.openssl,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        ppid: process.ppid,
        execPath: process.execPath,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      },
      env: {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        PATH: process.env.PATH,
        SHELL: user.shell || process.env.SHELL,
        ComSpec: process.env.ComSpec,
        TMPDIR: process.env.TMPDIR,
        TEMP: process.env.TEMP,
        LANG: process.env.LANG,
        JAVA_HOME: process.env.JAVA_HOME,
        ANDROID_HOME: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
      }
    };
  } catch (error) {
    throw new Error(`获取设备信息失败: ${error.message}`);
  }
});

// 导出设备信息
ipcMain.handle('export-device-info', async (event, textContent) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: 'Text Files', extensions: ['txt'] },
        { name: 'Markdown Files', extensions: ['md'] }
      ],
      defaultPath: `device-info-${new Date().toISOString().split('T')[0]}.txt`
    });
    
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, textContent, 'utf-8');
      return { success: true, path: result.filePath };
    }
    return { success: false };
  } catch (error) {
    throw new Error(`导出失败: ${error.message}`);
  }
});

// 计算文本哈希
ipcMain.handle('calculate-hash', async (event, text, algorithm) => {
  try {
    const hash = crypto.createHash(algorithm);
    hash.update(text);
    return hash.digest('hex');
  } catch (error) {
    throw new Error(`计算哈希失败: ${error.message}`);
  }
});

// 生成二维码（使用 npm 包 qrcode）
ipcMain.handle('generate-qrcode', async (event, text, size, errorLevel) => {
  try {
    // 注意：需要安装 qrcode 包: npm install qrcode
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(text, {
      width: size,
      errorCorrectionLevel: errorLevel,
      margin: 2
    });
    return dataUrl;
  } catch (error) {
    throw new Error(`生成二维码失败: ${error.message}`);
  }
});

// 下载二维码
ipcMain.handle('download-qrcode', async (event, imageData) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'Images', extensions: ['png'] }],
      defaultPath: `qrcode-${Date.now()}.png`
    });
    
    if (!result.canceled && result.filePath) {
      const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(result.filePath, base64Data, 'base64');
      return { success: true, path: result.filePath };
    }
    return { success: false };
  } catch (error) {
    throw new Error(`保存失败: ${error.message}`);
  }
});

// 解析二维码（使用 npm 包 qrcode-reader 或 jsqr）
ipcMain.handle('parse-qrcode', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }],
      properties: ['openFile']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      // 用 Electron 内置的 nativeImage 解码图片，不再依赖 jimp。
      // jimp 一家的传递依赖（gifwrap / zod / image-q / @jimp/* / await-to-js…）接近 25MB，
      // 而这里只需要「把图片解成 RGBA 像素」这一件事，nativeImage 零依赖就能做。
      const jsQR = require('jsqr');
      const { nativeImage } = require('electron');

      const image = nativeImage.createFromPath(result.filePaths[0]);
      if (image.isEmpty()) {
        throw new Error('无法解码该图片，请换 PNG / JPEG 格式');
      }

      const size = image.getSize();
      const bitmap = image.toBitmap();
      const totalPixels = Math.floor(bitmap.length / 4);

      // 优先信任位图长度：带 DPI 元数据的图片 getSize() 给的是「逻辑尺寸」，
      // 和真实像素数对不上，直接用会让 jsQR 按错误的行距读，识别率骤降。
      let width = size.width;
      let height = size.height;
      if (totalPixels > 0 && width > 0 && height > 0 && width * height !== totalPixels) {
        const ratio = width / height;
        const computedHeight = Math.round(Math.sqrt(totalPixels / ratio));
        const computedWidth = computedHeight > 0 ? Math.round(totalPixels / computedHeight) : 0;
        if (computedWidth * computedHeight === totalPixels) {
          width = computedWidth;
          height = computedHeight;
        }
      }
      if (!width || !height || width * height !== totalPixels) {
        throw new Error('图片尺寸与像素数据不匹配，无法识别二维码');
      }

      // nativeImage.toBitmap() 给的是 BGRA，jsQR 要 RGBA —— 交换 R/B 两个通道
      for (let i = 0; i < bitmap.length; i += 4) {
        const blue = bitmap[i];
        bitmap[i] = bitmap[i + 2];
        bitmap[i + 2] = blue;
      }

      const code = jsQR(new Uint8ClampedArray(bitmap), width, height);
      if (code) {
        return code.data;
      } else {
        throw new Error('未识别到二维码');
      }
    }
    return null;
  } catch (error) {
    throw new Error(`解析失败: ${error.message}`);
  }
});

// 修改文件 Hash
ipcMain.handle('modify-file-hash', async (event, filePaths) => {
  const results = [];
  
  for (const filePath of filePaths) {
    try {
      // 获取原始 MD5
      const oldMd5 = await calculateHash(filePath, 'md5');
      
      // 在文件末尾添加随机字节（不影响文件正常使用，但会改变 Hash）
      const randomBytes = crypto.randomBytes(16);
      fs.appendFileSync(filePath, randomBytes);
      
      // 获取新的 MD5
      const newMd5 = await calculateHash(filePath, 'md5');
      
      results.push({
        filename: path.basename(filePath),
        path: filePath,
        oldMd5,
        newMd5,
        success: true
      });
    } catch (error) {
      results.push({
        filename: path.basename(filePath),
        path: filePath,
        success: false,
        error: error.message
      });
    }
  }
  
  return results;
});
