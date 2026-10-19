/**
 * Windows 缺失工具自动安装器
 *
 * 只服务 Windows：mac 用 brew、Linux 用包管理器，装起来就一行命令，
 * 没必要在应用里再实现一套下载逻辑。Windows 没有包管理器，
 * 用户看到「未找到工具 adb」后往往不知道去哪下、下完放哪，这里直接代劳。
 *
 * 三件事：
 *   1. 下载（带镜像回退 + 断点续传式进度）
 *   2. 解压/落盘（复用 pkginfo/zip.js，自带进度与取消）
 *   3. 生成启动脚本（apktool 是 jar，Windows 上需要 .bat 才能被 runTool 找到）
 *
 * 装到 %APPDATA%\<productName>\tools\<toolId>\，不动系统 PATH、不改注册表：
 *   卸载应用后残留文件用户可自行删除，重装应用也能直接复用（不重复下载）。
 *
 * 目录之所以要被 tool-env.js 感知，是因为 runTool 是按目录列表找可执行文件的，
 * 光下载下来不注册目录的话仍然报「未找到工具」。见 TOOL_ROOT / binDirectories()。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { openZip } = require('./pkginfo/zip');

/** 工具存放根目录：用户数据目录，卸载应用不会删，重装可复用。 */
function toolRoot() {
  if (process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR) {
    return path.resolve(process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR);
  }
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, '日常开发工具箱', 'tools');
}

/**
 * GitHub 加速镜像。
 *
 * 都是「把原 URL 拼在后面」的公共代理，按顺序尝试。
 * 直连在国内实测只有 50~240KB/s（scrcpy 约 20MB 要几分钟），
 * 代理通常能跑满带宽；全部失败才最终报错，用户也可以自己填前缀。
 */
const DEFAULT_GITHUB_MIRRORS = [
  'https://gh-proxy.com/',
  'https://gh.llkk.cc/',
  'https://gh-proxy.net/',
  'https://ghps.cc/',
  'https://gh-proxy.linkease.com/'
];

const USER_AGENT = 'daily-dev-toolbox';

/**
 * 可自动安装的 Windows 工具。
 *
 * `kind` 决定落盘方式：
 *   - 'adb'     解压 zip 后整个目录就是 platform-tools，直接用
 *   - 'scrcpy'  同 adb
 *   - 'apktool' 只有 jar，需要写 .bat（Windows 没有可执行位，双击靠扩展名）
 *
 * `versionUrl` 用于解析最新版本号，失败时回退到 `fallbackVersion`，
 * 这样 GitHub API 挂了也不至于装不了。
 */
const TOOL_DEFS = [
  {
    id: 'adb',
    name: 'Android Platform Tools（adb / fastboot）',
    provides: ['adb'],
    kind: 'zip',
    versionUrl: null,
    version: 'latest',
    url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    mirrors: [],
    approxBytes: 12 * 1024 * 1024,
    stripRoot: 'platform-tools',
    providesNote: '装好后可用：安装 APK、设备文件管理、设备应用管理、日志查看'
  },
  {
    id: 'scrcpy',
    name: 'scrcpy（Android 投屏）',
    provides: ['scrcpy'],
    kind: 'zip',
    versionUrl: 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest',
    version: '5.0.1',
    urlTemplate: (version) =>
      `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-win64-v${version}.zip`,
    github: true,
    approxBytes: 22 * 1024 * 1024,
    stripRoot: (entryName) => entryName.replace(/^[^/]+\//, ''),
    providesNote: '装好后可用：Android 投屏（scrcpy）'
  },
  {
    id: 'apktool',
    name: 'apktool（APK 反编译 / 回编译）',
    provides: ['apktool'],
    kind: 'apktool',
    versionUrl: 'https://api.github.com/repos/iBotPeaches/Apktool/releases/latest',
    version: '3.0.3',
    urlTemplate: (version) =>
      `https://github.com/iBotPeaches/Apktool/releases/download/v${version}/apktool_${version}.jar`,
    github: true,
    approxBytes: 19 * 1024 * 1024,
    providesNote: '装好后可用：APK 反编译 / 回编译（运行时仍需要 JRE）'
  },

  /**
   * 下面这批是「Dex 工具集」用的 Java 工具。
   *
   * 与 apktool 的区别在于：它们全部是 jar，没有可执行位，runTool 找不到，
   * 所以 kind 用 'jar'，marker 就是 jar 文件本身（dex-toolkit.js 里用
   * `java -jar <找到的 jar>` 调起，见 resolveJavaJar）。
   *
   * 平台策略（见 README 的产品约定）：
   *   - Windows：应用内一键安装（和 adb / scrcpy 一样）
   *   - mac / Linux：优先用「系统上已有的工具」，没有的话用户点「在线下载」
   *     手动拉到应用目录 —— 不静默改动系统目录。
   */
  {
    id: 'baksmali',
    name: 'baksmali（dex → smali 反编译）',
    provides: ['baksmali'],
    kind: 'jar',
    jarName: 'baksmali.jar',
    versionUrl: null,
    version: '2.5.2',
    // bitbucket 是 smali 官方发布点，直连即可；失败回退到 GitHub release
    url: 'https://bitbucket.org/JesusFreke/smali/downloads/baksmali-2.5.2.jar',
    mirrors: [
      'https://github.com/JesusFreke/smali/releases/download/v2.5.2/baksmali-2.5.2.jar'
    ],
    github: false,
    approxBytes: 2 * 1024 * 1024,
    providesNote: 'Dex 工具集：反编译 dex（需要 JRE）'
  },
  {
    id: 'smali',
    name: 'smali（smali → dex 回编译）',
    provides: ['smali'],
    kind: 'jar',
    jarName: 'smali.jar',
    versionUrl: null,
    version: '2.5.2',
    url: 'https://bitbucket.org/JesusFreke/smali/downloads/smali-2.5.2.jar',
    mirrors: [
      'https://github.com/JesusFreke/smali/releases/download/v2.5.2/smali-2.5.2.jar'
    ],
    github: false,
    approxBytes: 1 * 1024 * 1024,
    providesNote: 'Dex 工具集：回编译 dex（需要 JRE）'
  },
  {
    id: 'dex-tools',
    name: 'dex-tools（dex → jar，含 .class）',
    provides: ['d2j-dex2jar'],
    kind: 'dex-tools',
    jarName: 'd2j-dex2jar.jar',
    versionUrl: 'https://api.github.com/repos/pxb1988/dex2jar/releases/latest',
    version: '2.4',
    urlTemplate: (version) =>
      `https://github.com/pxb1988/dex2jar/releases/download/v${version}/dex-tools-v${version}.zip`,
    github: true,
    approxBytes: 19 * 1024 * 1024,
    providesNote: 'Dex 工具集：dex2jar（未装时自动回退 d8，产出的是含 dex 的 jar）'
  },
  {
    id: 'cfr',
    name: 'CFR（jar / class → java 源码）',
    provides: ['cfr'],
    kind: 'jar',
    jarName: 'cfr.jar',
    versionUrl: null,
    version: '0.152',
    url: 'https://repo1.maven.org/maven2/org/benf/cfr/0.152/cfr-0.152.jar',
    mirrors: [
      'https://github.com/leibnitz27/cfr/releases/download/0.152/cfr-0.152.jar'
    ],
    github: false,
    approxBytes: 3 * 1024 * 1024,
    providesNote: 'Dex 工具集：反编译 jar（需要 JRE）'
  }
];

function safeSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 把可能带路径分隔符的版本号洗成单段目录名，避免写入父目录。 */
function versionDir(version) {
  return safeSegment(version) || 'unknown';
}

function installDirFor(tool) {
  return path.join(toolRoot(), tool.id, versionDir(tool.version));
}

/**
 * 对外暴露的工具目录列表，供 tool-env.js 加入搜索路径。
 * 已安装的才返回（未安装时目录不存在，加进 PATH 也没意义）。
 * 例外：`DAILY_DEV_TOOLBOX_TOOLS_DIR` 是开发/自检目录，即使当前为空也加入，
 * 方便用户放好工具后无需重装应用即可被 tool-env 看到。
 */
function binDirectories() {
  const dirs = [];
  if (process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR) {
    const customDir = path.resolve(process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR);
    if (fs.existsSync(customDir)) dirs.push(customDir);
  }
  for (const tool of TOOL_DEFS) {
    const dir = installDirFor(tool);
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/** 已安装工具清单，供「已装/可装」UI 展示。 */
function listInstalled() {
  return TOOL_DEFS.map((tool) => {
    const dir = installDirFor(tool);
    const marker = path.join(dir, markerName(tool));
    const installed = fs.existsSync(marker);
    return {
      id: tool.id,
      name: tool.name,
      version: tool.version,
      installed,
      dir: installed ? dir : null,
      provides: tool.provides,
      providesNote: tool.providesNote,
      approxBytes: tool.approxBytes
    };
  });
}

/**
 * 压缩包里的可执行文件长什么样。
 *
 * 固定按 Windows 的 .exe 判定：这批包只在 Windows 上下载安装，
 * 不能用 process.platform —— 否则在开发机（mac）上跑验证脚本时，
 * 明明装好了 adb.exe，却因为去找 adb 而误判成「压缩包结构变化」。
 */
function markerName(tool) {
  if (tool.kind === 'apktool') return 'apktool.bat';
  // 纯 jar 工具：marker 就是 jar 本身（dex-toolkit.js 用 `java -jar` 调起）
  if (tool.kind === 'jar') return tool.jarName;
  // dex-tools 是 zip，解压后是 d2j-dex2jar.sh / .bat，另外还要产出 jar 供 fallback 用
  if (tool.kind === 'dex-tools') {
    return process.platform === 'win32' ? 'd2j-dex2jar.bat' : 'd2j-dex2jar.sh';
  }
  return `${tool.provides[0]}.exe`;
}

/**
 * 候选下载地址：直连优先，失败再走镜像。
 * 用户自定义前缀（DAILY_DEV_TOOLBOX_GITHUB_MIRROR）排最前。
 */
function urlCandidates(tool) {
  const primary = tool.urlTemplate ? tool.urlTemplate(tool.version) : tool.url;
  const urls = [primary];
  // mirrors: 任意 kind 都允许，用来支持 jar 类工具的多源（bitbucket / github / maven）
  if (Array.isArray(tool.mirrors)) {
    urls.push(...tool.mirrors);
  }
  if (tool.github) {
    const custom = String(process.env.DAILY_DEV_TOOLBOX_GITHUB_MIRROR || '').trim();
    if (custom) {
      const wrapped = custom.endsWith('/') ? custom + primary : custom + '/' + primary;
      urls.push(wrapped);
    }
    for (const mirror of DEFAULT_GITHUB_MIRRORS) {
      urls.push(mirror.endsWith('/') ? mirror + primary : mirror + '/' + primary);
    }
  }
  return urls;
}

/** 解析最新版本号。失败就返回 null，调用方回退到内置版本。 */
async function resolveLatestVersion(tool) {
  if (!tool.versionUrl) return null;
  try {
    const response = await requestJson(tool.versionUrl);
    const tag = response?.tag_name || response?.name;
    const clean = String(tag || '').replace(/^v/i, '').trim();
    return /^[\d][\w.-]*$/.test(clean) ? clean : null;
  } catch (_) {
    return null;
  }
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? require('http') : require('https');
    const req = mod.get(url, { headers: { 'user-agent': USER_AGENT }, timeout: 15000 }, (res) => {
      // 只跟 3xx 一次，代理链偶尔会跳
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        requestJson(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/**
 * 流式下载到临时文件。
 *
 * 写 .part 再 rename：下载中断不会留下「看起来装好了」的残包。
 * Content-Length 缺失时 total 为 0，调用方按不确定进度显示。
 */
function downloadToFile(url, target, options = {}) {
  const { onProgress, signal, timeout = 30000 } = options;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? require('http') : require('https');
    const part = target + '.part';

    const cleanup = () => { fsp.rm(part, { force: true }).catch(() => {}); };
    const fail = (error) => { cleanup(); reject(error); };

    const req = mod.get(url, { headers: { 'user-agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, target, options).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      let lastEmit = 0;
      const out = fs.createWriteStream(part);

      // 卡死判定：连续 timeout 没有字节进来就放弃，换下一个源
      let timer = setTimeout(() => { req.destroy(new Error('下载超时')); }, timeout);
      const bump = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { req.destroy(new Error('下载超时')); }, timeout);
      };

      res.on('data', (chunk) => {
        bump();
        received += chunk.length;
        if (signal?.aborted) {
          req.destroy(new Error('下载已取消'));
          return;
        }
        const now = Date.now();
        if (onProgress && now - lastEmit > 120) {
          lastEmit = now;
          onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
        }
      });
      res.on('error', (error) => fail(error));
      out.on('error', (error) => fail(error));
      out.on('finish', async () => {
        clearTimeout(timer);
        try {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.rename(part, target);
          onProgress?.({ received, total, percent: 100 });
          resolve({ bytes: received, total });
        } catch (error) {
          fail(error);
        }
      });
      res.pipe(out);
    });

    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', (error) => fail(error));
  });
}

/** 递归补齐安装目录内 .sh / .bat 的可执行位（zip 解压通常保留 755，但保险起见都 chmod 一遍）。 */
async function ensureExecutable(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await ensureExecutable(full);
    } else if (entry.isFile() && (entry.name.endsWith('.sh') || entry.name.endsWith('.bat') || entry.name === 'apktool')) {
      try { await fsp.chmod(full, 0o755); } catch (_) { /* Windows 没有可执行位 */ }
    }
  }
}

function writeApktoolLauncher(dir, jarName) {
  const bat = path.join(dir, 'apktool.bat');
  const script = [
    '@echo off',
    'setlocal',
    'set BAT_DIR=%~dp0',
    'java -jar "%BAT_DIR%apktool.jar" %*',
    'endlocal'
  ].join('\r\n');
  fs.writeFileSync(bat, script + '\r\n');
  // Linux/mac 理论上也走得到这里（kind 相同），顺便给个 sh 入口
  const sh = path.join(dir, 'apktool');
  fs.writeFileSync(sh, '#!/bin/sh\nexec java -jar "$(dirname "$0")/apktool.jar" "$@"\n');
  try { fs.chmodSync(sh, 0o755); } catch (_) { /* Windows 没有可执行位 */ }
  return { bat, jarName };
}

/**
 * 安装单个工具。
 *
 * @param {string} toolId
 * @param {object} [options]
 * @param {(payload: object) => void} [options.onProgress] {stage, percent, detail}
 * @param {{aborted?: boolean}} [options.signal]
 */
async function installTool(toolId, options = {}) {
  const { onProgress, signal } = options;
  const tool = TOOL_DEFS.find((item) => item.id === toolId);
  if (!tool) throw new Error(`未知的工具: ${toolId}`);

  const emit = (stage, percent, detail) => onProgress?.({ toolId, stage, percent, detail });

  emit('准备', 0, `解析 ${tool.name} 版本`);
  const latest = await resolveLatestVersion(tool);
  if (latest && latest !== tool.version) tool.version = latest;

  const dir = installDirFor(tool);
  const marker = path.join(dir, markerName(tool));
  if (fs.existsSync(marker)) {
    emit('完成', 100, '已安装，跳过下载');
    return { toolId, dir, skipped: true, version: tool.version };
  }

  await fsp.mkdir(dir, { recursive: true });
  const tmpRoot = path.join(toolRoot(), '.tmp');
  await fsp.mkdir(tmpRoot, { recursive: true });

  const urls = urlCandidates(tool);
  let lastError = null;

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    if (signal?.aborted) throw new Error('安装已取消');
    const archive = path.join(tmpRoot, `${tool.id}-${versionDir(tool.version)}${url.endsWith('.jar') ? '.jar' : '.zip'}`);
    try {
      emit('下载', 0, `${index === 0 ? '官方源' : `镜像 ${index}`}：${url}`);
      await downloadToFile(url, archive, {
        signal,
        onProgress: ({ received, total, percent }) => {
          const mb = (received / 1024 / 1024).toFixed(1);
          const totalMb = total ? (total / 1024 / 1024).toFixed(1) : '?';
          // 下载占 0~70，解压占 70~95，收尾 100
          emit('下载', percent === null ? null : Math.round(percent * 0.7), `${mb} MB / ${totalMb} MB`);
        }
      });

      if (tool.kind === 'apktool') {
        emit('安装', 75, '写入启动脚本');
        const jarPath = path.join(dir, 'apktool.jar');
        await fsp.copyFile(archive, jarPath);
        writeApktoolLauncher(dir, 'apktool.jar');
      } else if (tool.kind === 'jar') {
        emit('安装', 75, '落入目录');
        const jarPath = path.join(dir, tool.jarName);
        await fsp.copyFile(archive, jarPath);
      } else if (tool.kind === 'dex-tools') {
        emit('安装', 75, '落入目录');
        const zip = openZip(archive);
        try {
          zip.extractTo(dir, {
            signal,
            filter: (entry) => !entry.name.endsWith('/'),
            onProgress: ({ percent, done, total }) => {
              emit('安装', 75 + Math.round((percent / 100) * 18), `${done} / ${total} 个文件`);
            }
          });
        } finally {
          zip.close();
        }
        // 给 mac / Linux 加可执行位（zip 内通常已是 755，但保险起见都 chmod 一遍）
        await ensureExecutable(dir);
      } else {
        emit('解压', 72, '解压缩中');
        const zip = openZip(archive);
        try {
          zip.extractTo(dir, {
            signal,
            filter: (entry) => !entry.name.endsWith('/'),
            onProgress: ({ percent, done, total }) => {
              emit('解压', 72 + Math.round((percent / 100) * 23), `${done} / ${total} 个文件`);
            }
          });
        } finally {
          zip.close();
        }
        await flattenIfNeeded(dir, tool);
      }

      await fsp.rm(archive, { force: true });
      if (!fs.existsSync(marker)) {
        throw new Error(`安装后未找到 ${markerName(tool)}，压缩包结构可能已变化`);
      }
      emit('完成', 100, `已安装到 ${dir}`);
      return { toolId, dir, version: tool.version, skipped: false };
    } catch (error) {
      lastError = error;
      await fsp.rm(archive, { force: true }).catch(() => {});
      if (signal?.aborted) throw new Error('安装已取消');
      emit('重试', null, `${index === 0 ? '官方源' : `镜像 ${index}`}失败：${error.message}`);
    }
  }

  throw new Error(`${tool.name} 安装失败：${lastError?.message || '所有下载地址均不可用'}`);
}

/**
 * 官方 zip 常带一层 platform-tools/ 或 scrcpy-win64-xxx/ 外壳，
 * runTool 只在给定目录里找 adb.exe，多套一层就找不到，这里摊平。
 */
async function flattenIfNeeded(dir, tool) {
  if (tool.id === 'scrcpy' || tool.id === 'adb') {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const marker = markerName(tool);
    if (entries.some((entry) => entry.name === marker)) return;
    const subdir = entries.find(
      (entry) => entry.isDirectory() && !entry.name.startsWith('.__')
    );
    if (!subdir) return;
    const nested = path.join(dir, subdir.name);
    const nestedMarker = path.join(nested, marker);
    if (!fs.existsSync(nestedMarker)) return;
    for (const entry of await fsp.readdir(nested)) {
      await fsp.rename(path.join(nested, entry), path.join(dir, entry));
    }
    await fsp.rmdir(nested).catch(() => {});
  }
}

/** 删除已安装的工具目录（UI 的「卸载/清理」入口）。 */
async function uninstallTool(toolId) {
  const tool = TOOL_DEFS.find((item) => item.id === toolId);
  if (!tool) throw new Error(`未知的工具: ${toolId}`);
  await fsp.rm(path.join(toolRoot(), tool.id), { recursive: true, force: true });
  return { toolId, removed: true };
}

module.exports = {
  TOOL_DEFS,
  DEFAULT_GITHUB_MIRRORS,
  toolRoot,
  binDirectories,
  listInstalled,
  installTool,
  uninstallTool,
  installDirFor,
  markerName,
  resolveLatestVersion,
  urlCandidates,
  writeApktoolLauncher,
  flattenIfNeeded,
  downloadToFile
};
