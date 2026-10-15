'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'stream', 'string_decoder', 'timers',
  'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib'
]);

// 由运行时提供，不在 dependencies 里
const RUNTIME_PROVIDED = new Set(['electron']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 抽出所有裸模块名（跳过相对路径与内置模块）。 */
function bareRequires(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = new Set();
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const spec = match[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      // 取包名（处理 @scope/name 与 name/sub 两种形式）
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      found.add(name);
    }
  }
  return found;
}

const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {})
]);

test('every bare import in source is declared in package.json', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'electron'))];
  assert.ok(files.length > 0, '应该扫描到源码文件');

  const missing = [];
  for (const file of files) {
    for (const name of bareRequires(file)) {
      if (NODE_BUILTINS.has(name) || RUNTIME_PROVIDED.has(name) || declared.has(name)) continue;
      missing.push(`${path.relative(ROOT, file)} → ${name}`);
    }
  }
  assert.deepEqual(missing, [], `以下模块没有在 package.json 里声明：\n${missing.join('\n')}`);
});

test('react stays out of the main process', () => {
  // react / react-dom 已移到 devDependencies（由 vite 打进 dist）。
  // 主进程一旦 require 它们，打包后会直接报「找不到模块」。
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'electron'))) {
    for (const name of bareRequires(file)) {
      if (name === 'react' || name === 'react-dom') offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `主进程不能依赖 react：${offenders.join(', ')}`);
});

test('renderer-only packages are not shipped as runtime dependencies', () => {
  // 这是包体大小的主要来源：vite 已经把 react 打进 dist，
  // 再作为 dependencies 会让 electron-builder 把 node_modules/react 也复制一份进 asar
  for (const name of ['react', 'react-dom']) {
    assert.ok(!(name in (pkg.dependencies || {})), `${name} 不该出现在 dependencies 里`);
    assert.ok(name in (pkg.devDependencies || {}), `${name} 应该留在 devDependencies`);
  }
});

test('heavy image library does not come back', () => {
  // jimp 一家的传递依赖接近 25MB（gifwrap / zod / image-q / @jimp/* …），
  // 而我们只需要「把图片解成 RGBA 像素」——Electron 内置的 nativeImage 就能做。
  assert.ok(!('jimp' in (pkg.dependencies || {})), 'jimp 不该回到 dependencies');

  const users = [];
  for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'electron'))]) {
    if (bareRequires(file).has('jimp')) users.push(path.relative(ROOT, file));
  }
  assert.deepEqual(users, [], `这些文件还在用 jimp：${users.join(', ')}`);
});

test('packaging config keeps the size knobs on', () => {
  const build = pkg.build || {};
  assert.equal(build.asar, true, 'asar 必须开启，否则散文件会明显变大');

  // 这里刻意**不**断言 maximum —— 它是个陷阱。
  // electron-builder 对 ZIP + maximum 会额外追加 `-mpass=15`
  // （见 app-builder-lib/out/targets/archive.js:64），即把整个 .app 压 15 遍。
  // 实测（同一份 233MB 的 .app、同一个 7za 二进制）：
  //   maximum(-mx=9 -mpass=15) → 199s / 87.9MB
  //   normal (-mx=7)           →  24s / 88.2MB
  // 慢 8.3 倍只换来 0.3MB —— 因为 .app 里 225MB 是 Electron 运行时，本来就压不动。
  // 所以守的是「别退回 maximum」，而不是某个具体级别。
  assert.notEqual(build.compression, 'maximum',
    'ZIP + maximum 会触发 7za 的 -mpass=15，构建慢 8.3 倍只省 0.3MB（见 archive.js:64）');
  assert.ok(['store', 'normal'].includes(build.compression),
    `compression 只能是 store 或 normal，当前是 ${build.compression}`);

  assert.ok(Array.isArray(build.electronLanguages) && build.electronLanguages.length <= 3,
    'Electron 自带几十种语言的 .pak，只保留用得到的能省好几 MB');
  // files 里要排除源码映射与文档，它们对运行没有意义
  const files = (build.files || []).join(' ');
  assert.match(files, /!.*\.map/, '应排除 source map');
});

test('main process keeps its crash guards', () => {
  // 主进程里一个没 catch 的异常会直接杀掉整个应用，用户看到的就是「闪退」。
  // 这几行是防闪退的最后一道防线，删掉就会静默崩溃。
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  assert.match(main, /process\.on\('uncaughtException'/, '缺少 uncaughtException 兜底');
  assert.match(main, /process\.on\('unhandledRejection'/, '缺少 unhandledRejection 兜底');
  assert.match(main, /'render-process-gone'/, '缺少渲染进程崩溃处理');
  assert.match(main, /'child-process-gone'/, '缺少子进程崩溃处理');
  // 兜底逻辑自己要能容错，否则二次抛出就真的没救了
  assert.match(main, /function logCrash\(/, '缺少崩溃日志落盘');
});

test('main process releases the iOS port forward on quit', () => {
  // iproxy 是真实子进程。退出时不收掉它会残留并占住 8100 端口，
  // 下次启动转发起不来 —— 而报错只会说「WebDriverAgent 未运行」，方向完全指错。
  // 所以两个钩子都必须接上：before-quit 做异步清理，will-quit 做同步兜底。
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');

  const beforeQuitAt = main.indexOf("app.on('before-quit'");
  const willQuitAt = main.indexOf("app.on('will-quit'");
  assert.ok(beforeQuitAt > 0 && willQuitAt > beforeQuitAt, '找不到退出钩子，测试需要更新');

  const beforeQuit = main.slice(beforeQuitAt, willQuitAt);
  const willQuit = main.slice(willQuitAt);

  assert.match(beforeQuit, /iosControl\.isForwarding\(\)/,
    'before-quit 要判断是否需要清理，否则会白白阻止一次退出');
  assert.match(beforeQuit, /iosControl\.dropSession\(\)/,
    'before-quit 应释放 WDA 会话并收掉转发');
  assert.match(beforeQuit, /iosControl\.isWdaRunning\(\)/,
    'before-quit 的清理判断要包含「应用自己启动的 WDA」，否则退出时会漏掉它');
  assert.match(beforeQuit, /iosControl\.stopWda\(\)/,
    'before-quit 应停掉应用自己启动的 WDA');
  assert.match(willQuit, /iosControl\.forceKillForward\(\)/,
    'will-quit 不能 await，必须有一条同步兜底的 kill');
  assert.match(willQuit, /iosControl\.forceKillWda\(\)/,
    'will-quit 也要同步收掉 wdaproxy，否则它占着 8100 残留');
});
