/**
 * Dex 工具集
 *
 * 六种转换，跑在 main 进程里，进度通过 onProgress 回调推给渲染层：
 *
 *   jar2dex    .jar / .class / .zip  → .dex                  (d8)
 *   dex2jar    .dex / .apk           → .jar（含 .class）      (dex-tools，缺失回退 d8)
 *   jar 反编译  .jar / .class        → .java 源码目录          (CFR)
 *   jar 回编译  .java（文件或目录）   → .jar（含 .class）      (javac + jar)
 *   dex 反编译  .dex / .apk          → .smali 目录            (baksmali)
 *   dex 回编译  .smali（文件或目录）  → .dex                   (smali)
 *
 * 工具来源：
 *   - d8 / javac / jar：tool-env.js 的目录表（Android SDK / JDK / PATH…），走 runTool
 *   - baksmali / smali / cfr / dex-tools：全是 jar，走 `java -jar`，先查系统再查安装目录
 *
 * 平台策略（用户确认）：
 *   - Windows：应用内一键安装（tool-installer.js）
 *   - mac / Linux：优先用系统上已有的；没有就提示「在线下载」到安装目录，不静默改系统目录
 *
 * 输入可以是单文件、多文件、目录 —— 统一归一化到「文件列表」再逐个处理，天然支持批量。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const DEX_EXT = new Set(['.dex', '.apk']);
const JAR_LIKE_EXT = new Set(['.jar', '.zip']);

function isDexLike(file) {
  return DEX_EXT.has(path.extname(file).toLowerCase());
}

function isJarLike(file) {
  const ext = path.extname(file).toLowerCase();
  return JAR_LIKE_EXT.has(ext) || ext === '.class';
}

function isSmali(file) {
  const name = path.basename(file).toLowerCase();
  return name.endsWith('.smali');
}

function isJava(file) {
  const name = path.basename(file).toLowerCase();
  return name.endsWith('.java');
}

// ---------------- 输入归一化 ----------------

async function walk(dir, predicate, out) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(entry.name)) out.add(full);
    }
  }
}

/** 归一化到「jar / dex 类文件」列表。 */
async function collectConvertibles(rawInputs) {
  const out = new Set();
  for (const raw of rawInputs) {
    if (!raw) continue;
    const stat = await fsp.stat(raw).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      if (isDexLike(raw) || isJarLike(raw)) out.add(path.resolve(raw));
    } else if (stat.isDirectory()) {
      await walk(path.resolve(raw), (name) => isDexLike(name) || isJarLike(name), out);
    }
  }
  return Array.from(out);
}

/** .java 源文件列表（目录会递归）。 */
async function collectJavaSources(rawInputs) {
  const out = new Set();
  for (const raw of rawInputs) {
    if (!raw) continue;
    const stat = await fsp.stat(raw).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      if (isJava(raw)) out.add(path.resolve(raw));
    } else if (stat.isDirectory()) {
      await walk(path.resolve(raw), (name) => isJava(name), out);
    }
  }
  return Array.from(out);
}

/**
 * smali 回编译的输入是「目录」不是文件 —— 单个 .smali 文件没有意义。
 * 传文件就取它所在的目录，传目录就用它自己（smali 会递归找 .smali）。
 */
async function collectSmaliDirs(rawInputs) {
  const out = new Set();
  for (const raw of rawInputs) {
    if (!raw) continue;
    const stat = await fsp.stat(raw).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      if (isSmali(raw)) out.add(path.dirname(path.resolve(raw)));
    } else if (stat.isDirectory()) {
      out.add(path.resolve(raw));
    }
  }
  // 只保留真正含 .smali 的目录，避免把用户误选的父目录塞进去
  const kept = [];
  for (const dir of out) {
    if (await dirHasSmali(dir)) kept.push(dir);
  }
  return kept;
}

async function dirHasSmali(dir) {
  const stack = [dir];
  let scanned = 0;
  while (stack.length && scanned < 2000) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      if (entry.isFile() && isSmali(entry.name)) return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return false;
}

// ---------------- 输出路径 ----------------

function stem(file) {
  return path.basename(file, path.extname(file));
}

// ---------------- 工具解析 ----------------

/**
 * 找一个 jar 工具：先系统（which 等价的目录扫描），再应用安装目录。
 *
 * 实际通过 toolInstaller.binDirectories() 间接完成：
 * 该列表既包含 tool-env 注册的搜索目录，也包含 tool-installer 已安装工具目录，
 * 因此这里不必再维护一份独立的 extraDirs。
 */
function findJarTool(toolInstaller, jarName) {
  const candidates = [];
  if (process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR) {
    candidates.push(process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR);
  }
  if (toolInstaller?.binDirectories) {
    candidates.push(...toolInstaller.binDirectories());
  }
  for (const dir of candidates) {
    const jar = path.join(dir, jarName);
    if (fs.existsSync(jar)) return jar;
  }
  return null;
}

function requireJar(toolInstaller, jarName, friendlyName) {
  const jar = findJarTool(toolInstaller, jarName);
  if (jar) return jar;
  throw new Error(
    `未找到 ${friendlyName}（${jarName}）。` +
    (process.platform === 'win32'
      ? '请在「工具安装」里一键安装。'
      : '系统上没有这个工具，请在本页点「在线下载」，或手动放到工具目录。')
  );
}

// ---------------- 6 种转换 ----------------

/**
 * jar2dex：d8 --output <dir> <input>
 *
 * d8 只接受「目录 / .zip / .jar」当 --output，且固定产出 classes.dex。
 * 批量时如果直接输出到同一个目录会互相覆盖，所以先输出到临时目录再改名搬走。
 */
async function jar2dex(ctx, inputs, outputDir, options) {
  const { runTool } = ctx;
  const { onProgress = () => {} } = options;
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const out = path.join(outputDir, `${stem(input)}.dex`);
    onProgress({
      percent: Math.round((i / inputs.length) * 90),
      stage: 'd8 编译',
      detail: path.basename(input)
    });

    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dex-jar2dex-'));
    try {
      await runTool('d8', ['--output', tmp, input], { timeout: 180000 });
      const produced = path.join(tmp, 'classes.dex');
      if (!fs.existsSync(produced)) throw new Error('d8 未生成 classes.dex');
      await fsp.copyFile(produced, out);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    results.push({ input, output: out });
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'jar2dex', results, outputDir };
}

/**
 * dex2jar：优先 dex-tools（真 .class），缺失回退 d8。
 *
 * d8 回退的 jar 里装的是 classes.dex（javac 读不了），所以要把 fallback:true
 * 传出去让 UI 明确提示，别让用户以为拿到了可用的 class。
 */
async function dex2jar(ctx, inputs, outputDir, options) {
  const { runTool, runToolStream, toolInstaller } = ctx;
  const { onProgress = () => {} } = options;
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  const dexTools = resolveDexTools(toolInstaller);
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const out = path.join(outputDir, `${stem(input)}.jar`);
    onProgress({
      percent: Math.round((i / inputs.length) * 90),
      stage: dexTools ? 'dex2jar' : 'd8 回退',
      detail: path.basename(input)
    });

    if (dexTools) {
      await runStream(runToolStream, dexTools, [input, '-o', out], { onProgress, stage: 'dex2jar' });
    } else {
      await runTool('d8', ['--output', out, input], { timeout: 180000 });
    }
    results.push({ input, output: out });
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'dex2jar', results, outputDir, fallback: !dexTools };
}

/** dex-tools 的入口脚本：Windows 是 .bat，其它是 .sh */
function resolveDexTools(toolInstaller) {
  const bins = toolInstaller?.binDirectories?.() || [];
  const script = process.platform === 'win32' ? 'd2j-dex2jar.bat' : 'd2j-dex2jar.sh';
  for (const dir of bins) {
    const full = path.join(dir, script);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * 反编译 jar：CFR
 * java -jar cfr.jar <jar> --outputdir <dir>
 */
async function decompileJar(ctx, inputs, outputDir, options) {
  const { runToolStream, toolInstaller } = ctx;
  const { onProgress = () => {} } = options;
  const cfr = requireJar(toolInstaller, 'cfr.jar', 'CFR');
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const outDir = path.join(outputDir, `${stem(input)}_src`);
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(outDir, { recursive: true });
    onProgress({
      percent: Math.round((i / inputs.length) * 90),
      stage: 'CFR 反编译',
      detail: path.basename(input)
    });
    await runStream(runToolStream, 'java', ['-jar', cfr, input, '--outputdir', outDir], {
      onProgress,
      stage: 'CFR'
    });
    results.push({ input, output: outDir });
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'jar-decompile', results, outputDir };
}

/**
 * 回编译 jar：javac → jar
 *
 * 按「每个源文件各算一个顶层目录」分桶：多份源码互不干扰，产物命名也不会撞车。
 * 顶层目录指的是源文件所在目录往上追溯到第一个「不再被其它源文件共享」的层。
 */
async function recompileJar(ctx, inputs, outputDir, options) {
  const { runTool } = ctx;
  const { onProgress = () => {} } = options;
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  const sources = await collectJavaSources(inputs);
  if (sources.length === 0) throw new Error('未发现任何 .java 源文件');

  const buckets = bucketByRoot(sources);
  let index = 0;
  for (const [root, files] of buckets) {
    const name = path.basename(root) || 'classes';
    const classDir = path.join(outputDir, `${name}_classes`);
    const jarOut = path.join(outputDir, `${name}.jar`);
    await fsp.rm(classDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(classDir, { recursive: true });

    onProgress({
      percent: Math.round((index / buckets.size) * 80),
      stage: 'javac 编译',
      detail: `${name}（${files.length} 个源文件）`
    });
    await runTool('javac', ['-d', classDir, ...files], { timeout: 180000 });

    onProgress({
      percent: Math.round((index / buckets.size) * 80) + 15,
      stage: '打包 jar'
    });
    await runTool('jar', ['cf', jarOut, '-C', classDir, '.'], { timeout: 60000 });

    results.push({ root, jar: jarOut, classes: classDir, count: files.length });
    index += 1;
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'jar-recompile', results, outputDir };
}

/** 把源文件按直接所在目录分组（同目录的源文件编译到同一个 jar）。 */
function bucketByRoot(sources) {
  const buckets = new Map();
  for (const file of sources) {
    const dir = path.dirname(file);
    if (!buckets.has(dir)) buckets.set(dir, []);
    buckets.get(dir).push(file);
  }
  return buckets;
}

/**
 * 反编译 dex：baksmali
 * java -jar baksmali.jar d <input.dex> -o <dir>
 *
 * baksmali 需要绝对路径（实测相对路径会报 Can't find file），inputs 已 resolve 过。
 */
async function decompileDex(ctx, inputs, outputDir, options) {
  const { runToolStream, toolInstaller } = ctx;
  const { onProgress = () => {} } = options;
  const baksmali = requireJar(toolInstaller, 'baksmali.jar', 'baksmali');
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const outDir = path.join(outputDir, `${stem(input)}_smali`);
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(outDir, { recursive: true });
    onProgress({
      percent: Math.round((i / inputs.length) * 90),
      stage: 'baksmali 反编译',
      detail: path.basename(input)
    });
    await runStream(runToolStream, 'java', ['-jar', baksmali, 'd', input, '-o', outDir], {
      onProgress,
      stage: 'baksmali'
    });
    results.push({ input, output: outDir });
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'dex-decompile', results, outputDir };
}

/**
 * 回编译 dex：smali
 * java -jar smali.jar a <dir> -o <out.dex>
 */
async function recompileDex(ctx, inputs, outputDir, options) {
  const { runToolStream, toolInstaller } = ctx;
  const { onProgress = () => {} } = options;
  const smali = requireJar(toolInstaller, 'smali.jar', 'smali');
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  const dirs = await collectSmaliDirs(inputs);
  if (dirs.length === 0) throw new Error('未找到任何含 .smali 文件的目录');

  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[i];
    const name = path.basename(dir) || 'classes';
    const out = path.join(outputDir, `${name}.dex`);
    onProgress({
      percent: Math.round((i / dirs.length) * 90),
      stage: 'smali 回编译',
      detail: name
    });
    await runStream(runToolStream, 'java', ['-jar', smali, 'a', dir, '-o', out], {
      onProgress,
      stage: 'smali'
    });
    results.push({ root: dir, output: out });
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'dex-recompile', results, outputDir };
}

/**
 * 跑 java -jar，并把 stderr/stdout 切成进度行推给 UI。
 *
 * 这些 java 工具动辄几十秒，没有输出会让用户以为卡死了，所以逐 chunk 回传。
 */
function runStream(runToolStream, executable, args, { onProgress, stage, timeout = 300000 }) {
  return runToolStream(null, args, {
    executable,
    timeout,
    onChunk: (text, stream) => {
      const detail = String(text || '').trim();
      if (detail) onProgress({ percent: null, stage, detail: detail.slice(0, 300) });
    }
  });
}

// ---------------- 分发 ----------------

const ACTIONS = {
  'jar2dex': { fn: jar2dex, label: 'jar2dex', collect: collectConvertibles, accept: (f) => isJarLike(f) },
  'dex2jar': { fn: dex2jar, label: 'dex2jar', collect: collectConvertibles, accept: (f) => isDexLike(f) },
  'jar-decompile': { fn: decompileJar, label: '反编译 jar', collect: collectConvertibles, accept: (f) => isJarLike(f) },
  'jar-recompile': { fn: recompileJar, label: '回编译 jar', collect: null, accept: null },
  'dex-decompile': { fn: decompileDex, label: '反编译 dex', collect: collectConvertibles, accept: (f) => isDexLike(f) },
  'dex-recompile': { fn: recompileDex, label: '回编译 dex', collect: null, accept: null }
};

const ACTION_LIST = Object.entries(ACTIONS).map(([id, def]) => ({
  id,
  label: def.label
}));

/**
 * 统一入口。
 *
 * @param {object} payload
 * @param {string} payload.action     见 ACTIONS
 * @param {string[]} payload.inputs   文件 / 目录（支持多个 → 批量）
 * @param {string} payload.outputDir
 * @param {Function} payload.runTool       来自 tool-env.js
 * @param {Function} payload.runToolStream 来自 tool-env.js
 * @param {object} payload.toolInstaller   tool-installer 模块
 * @param {Function} [payload.onProgress]  ({percent, stage, detail}) => void
 */
async function runDexAction(payload = {}) {
  const { action, inputs = [], outputDir, onProgress } = payload;
  const def = ACTIONS[action];
  if (!def) throw new Error(`未知操作: ${action}`);
  if (!outputDir) throw new Error('缺少输出目录');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('未提供任何输入');

  await fsp.mkdir(outputDir, { recursive: true });

  // 回编译的两个分支自己知道怎么收输入（.java / .smali），其余走通用收集
  const fileInputs = def.collect ? await def.collect(inputs) : inputs;
  if (fileInputs.length === 0) throw new Error('未识别到可处理的输入文件');

  if (def.accept) {
    const rejected = fileInputs.filter((f) => !def.accept(f));
    if (rejected.length) {
      throw new Error(
        `输入类型不匹配：${rejected.slice(0, 3).map((f) => path.basename(f)).join('、')} 不是本操作能处理的文件`
      );
    }
  }

  const ctx = {
    runTool: payload.runTool,
    runToolStream: payload.runToolStream,
    toolInstaller: payload.toolInstaller
  };
  return await def.fn(ctx, fileInputs, outputDir, { onProgress });
}

module.exports = {
  runDexAction,
  ACTION_LIST,
  // 下面的导出主要给自检脚本 / 单测用
  ACTIONS,
  collectConvertibles,
  collectJavaSources,
  collectSmaliDirs,
  findJarTool,
  resolveDexTools,
  bucketByRoot
};
