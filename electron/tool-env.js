const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');
const util = require('util');

const execFilePromise = util.promisify(execFile);

const DEFAULT_TOOL_DIRECTORIES = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin'
];

const SYSTEM_DIRECTORIES = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
];

const MAC_JAVA_STUBS = new Set(['java', 'javac', 'jar', 'jarsigner', 'keytool', 'javadoc']);

function normalizeKey(directory) {
  const normalized = path.normalize(directory);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSystemDirectory(directory) {
  const normalized = path.normalize(directory);
  if (process.platform === 'win32') {
    return /\\(system32|syswow64|windows)\\?$/i.test(normalized);
  }
  return SYSTEM_DIRECTORIES.includes(normalized);
}

function isMacJavaStub(executable) {
  if (process.platform !== 'darwin') return false;
  const base = path.basename(executable);
  const dir = path.normalize(path.dirname(executable));
  return (dir === '/usr/bin' || dir === '/bin') && MAC_JAVA_STUBS.has(base);
}

function isStubError(error) {
  const text = `${error?.stderr || ''} ${error?.stdout || ''} ${error?.message || ''}`;
  return /Unable to locate a Java Runtime/i.test(text);
}

function compareVersionDesc(a, b) {
  const pa = String(a).split(/[^\d]+/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[^\d]+/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function readExistingDirs(parent) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (_) {
    return [];
  }
}

function getLoginShellPathDirectories() {
  if (process.platform === 'win32') return [];
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const stdout = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], {
      timeout: 3500,
      encoding: 'utf8',
      env: { ...process.env, TERM: 'dumb' }
    });
    return String(stdout).split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * 应用内自动安装的工具目录（electron/tool-installer.js）。
 *
 * lazy require 有两层考虑：
 *   1. tool-installer 依赖 pkginfo/zip.js，不必为了「只是找工具」付出这份加载成本
 *   2. 任何异常（目录不可读、模块损坏）都不能让工具环境整体初始化失败
 */
function getAutoInstalledToolDirectories() {
  try {
    return require('./tool-installer').binDirectories();
  } catch (_) {
    return [];
  }
}

function createToolContext() {
  const directories = [];
  const seen = new Set();
  const deferredSystem = [];

  const addDirectory = (directory, requireExisting = true) => {
    if (!directory || !path.isAbsolute(directory)) return;
    if (requireExisting && !fs.existsSync(directory)) return;
    const normalized = path.normalize(directory);
    const key = normalizeKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    if (isSystemDirectory(normalized)) {
      deferredSystem.push(normalized);
      return;
    }
    directories.push(normalized);
  };

  const addAndroidSdk = (sdkRoot) => {
    if (!sdkRoot) return;
    addDirectory(path.join(sdkRoot, 'platform-tools'));
    const buildToolsRoot = path.join(sdkRoot, 'build-tools');
    if (!fs.existsSync(buildToolsRoot)) return;
    readExistingDirs(buildToolsRoot)
      .sort(compareVersionDesc)
      .forEach((version) => addDirectory(path.join(buildToolsRoot, version)));
  };

  DEFAULT_TOOL_DIRECTORIES.forEach((directory) => addDirectory(directory));

  ['/opt/homebrew/opt', '/usr/local/opt'].forEach((prefix) => {
    readExistingDirs(prefix).forEach((name) => {
      if (name === 'openjdk' || name.startsWith('openjdk@')) {
        addDirectory(path.join(prefix, name, 'bin'));
        addDirectory(path.join(prefix, name, 'libexec', 'openjdk.jdk', 'Contents', 'Home', 'bin'));
      }
    });
  });

  if (process.env.JAVA_HOME) {
    addDirectory(path.join(process.env.JAVA_HOME, 'bin'));
  }

  addAndroidSdk(process.env.ANDROID_HOME);
  addAndroidSdk(process.env.ANDROID_SDK_ROOT);
  addAndroidSdk(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  addAndroidSdk(path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'));
  if (process.env.LOCALAPPDATA) {
    addAndroidSdk(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  }
  addAndroidSdk('/opt/homebrew/share/android-sdk');
  addAndroidSdk('/usr/local/share/android-sdk');

  addDirectory(path.join(os.homedir(), 'Documents', 'apktool'));
  addDirectory(path.join(os.homedir(), 'apktool'));

  // 应用自己下载的工具（见 electron/tool-installer.js），仅 Windows 走这条路
  getAutoInstalledToolDirectories().forEach((directory) => addDirectory(directory));

  [
    path.resolve(__dirname, '../../project_git/scrcpy'),
    path.join(os.homedir(), 'Documents', 'other_dev', 'project_git', 'scrcpy')
  ].forEach((root) => {
    [
      '',
      'x',
      path.join('x', 'app'),
      'build',
      path.join('build', 'app'),
      'install',
      path.join('install', 'bin'),
      'app'
    ].forEach((relative) => addDirectory(relative ? path.join(root, relative) : root));
  });

  getLoginShellPathDirectories().forEach((directory) => addDirectory(directory));

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  String(process.env[pathKey] || '').split(path.delimiter).forEach((directory) => addDirectory(directory));

  deferredSystem.forEach((directory) => {
    const key = normalizeKey(directory);
    if (!seen.has(key)) {
      seen.add(key);
    }
    if (!directories.includes(directory)) directories.push(directory);
  });

  const env = { ...process.env, [pathKey]: directories.join(path.delimiter) };
  if (pathKey !== 'PATH') env.PATH = env[pathKey];

  if (!env.JAVA_HOME) {
    const inferredHome = directories
      .filter((directory) => directory.includes('openjdk') && directory.endsWith(`${path.sep}bin`))
      .map((directory) => path.dirname(directory))
      .find((home) => fs.existsSync(path.join(home, 'bin', 'java')) || fs.existsSync(path.join(home, 'bin', 'java.exe')));
    if (inferredHome) env.JAVA_HOME = inferredHome;
  }

  return { directories, env };
}

function executableCandidates(tool) {
  if (process.platform !== 'win32') return [tool];
  if (path.extname(tool)) return [tool];
  const extensions = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  return [
    tool,
    ...extensions.map((extension) => `${tool}${extension.toLowerCase()}`),
    ...extensions.map((extension) => `${tool}${extension.toUpperCase()}`)
  ];
}

function isExecutableFile(executable) {
  try {
    const stat = fs.statSync(executable);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(executable, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function createToolRunner(context) {
  const { directories, env } = context;

  function listToolCandidates(tool) {
    if (typeof tool !== 'string' || !tool || path.basename(tool) !== tool) {
      throw new Error(`无效的工具名称: ${tool}`);
    }
    const found = [];
    const seen = new Set();
    for (const directory of directories) {
      for (const candidate of executableCandidates(tool)) {
        const executable = path.resolve(directory, candidate);
        const key = normalizeKey(executable);
        if (seen.has(key) || !isExecutableFile(executable)) continue;
        seen.add(key);
        found.push(executable);
      }
    }
    return found;
  }

  function resolveTool(tool) {
    const candidates = listToolCandidates(tool).filter((item) => !isMacJavaStub(item));
    if (candidates.length === 0) {
      throw new Error(`未找到工具 ${tool}（已搜索 ${directories.join(', ')}）`);
    }
    return candidates[0];
  }

  async function runTool(tool, args = [], options = {}) {
    const { executable: preferredExecutable, env: overrideEnv, ...execOptions } = options;
    let executable;
    try {
      executable = preferredExecutable || resolveTool(tool);
      const result = await execFilePromise(executable, args, {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        ...execOptions,
        env: overrideEnv || env
      });
      return { ...result, executable };
    } catch (error) {
      const detail = [error.stderr, error.stdout, error.message]
        .map((item) => String(item || '').trim())
        .filter((item, index, arr) => item && arr.indexOf(item) === index)
        .join('\n')
        .trim() || String(error);
      const wrapped = new Error(`${tool} 执行失败: ${detail}`);
      wrapped.cause = error;
      wrapped.stdout = error.stdout;
      wrapped.stderr = error.stderr;
      wrapped.executable = executable || null;
      throw wrapped;
    }
  }

  async function detectTool(tool, args) {
    let candidates;
    try {
      candidates = listToolCandidates(tool);
    } catch (_) {
      return { installed: false, path: null };
    }

    const usable = candidates.filter((item) => !isMacJavaStub(item));
    if (!args || args.length === 0) {
      return usable[0]
        ? { installed: true, path: usable[0] }
        : { installed: false, path: null };
    }

    for (const executable of usable) {
      try {
        await execFilePromise(executable, args, {
          env,
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 1024 * 1024
        });
        return { installed: true, path: executable };
      } catch (error) {
        if (error.code === 'ENOENT' || isStubError(error)) continue;
        if (typeof error.code === 'number' || error.status || error.stdout || error.stderr) {
          return { installed: true, path: executable };
        }
      }
    }
    return { installed: false, path: null };
  }

  async function runToolStream(tool, args = [], options = {}) {
    const { executable: preferredExecutable, env: overrideEnv, onChunk, onChild, timeout = 300000 } = options;
    const executable = preferredExecutable || resolveTool(tool);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        env: overrideEnv || env,
        windowsHide: true
      });
      // 把子进程交给调用方，便于「取消」时直接 kill 掉正在跑的命令
      if (typeof onChild === 'function') {
        try {
          onChild(child);
        } catch (_) {
          // 回调失败不影响执行
        }
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error(`${tool} 执行超时`));
      }, timeout);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      };

      const handle = (buffer, stream) => {
        const text = buffer.toString();
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        if (typeof onChunk === 'function') {
          try {
            onChunk(text, stream, stdout, stderr);
          } catch (_) {
            // 进度回调失败不影响安装
          }
        }
      };

      child.stdout.on('data', (buffer) => handle(buffer, 'stdout'));
      child.stderr.on('data', (buffer) => handle(buffer, 'stderr'));
      child.on('error', fail);
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = { stdout, stderr, executable };
        if (code === 0) {
          resolve(result);
          return;
        }
        const detail = [stderr, stdout].map((item) => String(item || '').trim()).filter(Boolean).join('\n');
        const error = new Error(`${tool} 执行失败: ${detail || `退出码 ${code}`}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      });
    });
  }

  return {
    directories,
    env,
    listToolCandidates,
    resolveTool,
    runTool,
    runToolStream,
    detectTool
  };
}

module.exports = {
  createToolContext,
  createToolRunner
};
