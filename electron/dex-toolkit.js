/**
 * Dex 工具集
 *
 * 七种转换，跑在 main 进程里，进度通过 onProgress 回调推给渲染层：
 *
 *   jar2dex    .jar / .class / .zip  → .dex                  (d8)
 *   dex2jar    .dex / .apk           → .jar（含 .class）      (dex-tools)
 *   jar 反编译  .jar / .class        → .java 源码目录          (CFR)
 *   jar 回编译  .java（文件或目录）   → .jar（含 .class）      (javac + jar)
 *   dex 反编译  .dex / .apk          → .smali 目录            (baksmali)
 *   dex 回编译  .smali（文件或目录）  → .dex                   (smali)
 *   odex 反编译 .odex / .vdex / .dex → 提取内嵌 dex → smali    (内置提取 + baksmali)
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

// odex 反编译的输入：odex / vdex 容器，以及已经拆出来的裸 dex
const ODEX_EXT = new Set(['.odex', '.vdex', '.dex']);

function isOdexLike(file) {
  return ODEX_EXT.has(path.extname(file).toLowerCase());
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

/** odex 反编译的输入：.odex / .vdex / .dex（目录会递归）。 */
async function collectOdexInputs(rawInputs) {
  const out = new Set();
  for (const raw of rawInputs) {
    if (!raw) continue;
    const stat = await fsp.stat(raw).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      if (isOdexLike(raw)) out.add(path.resolve(raw));
    } else if (stat.isDirectory()) {
      await walk(path.resolve(raw), (name) => isOdexLike(name), out);
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

/**
 * 输出文件统一追加 _modify 后缀，避免直接覆盖输入：
 *   a.jar → a_modify.dex / a_modify.jar
 */
function modifyFileName(input, ext) {
  return `${stem(input)}_modify${ext}`;
}

/**
 * 输出目录统一追加 _modify 后缀：a_src → a_src_modify。
 */
function modifyDirName(name) {
  return `${name}_modify`;
}

/**
 * 推导默认输出目录：输入是目录就取目录本身，是文件就取所在文件夹。
 * 取第一个能识别到的输入（同一批输入通常同目录，结果一致）。
 */
async function resolveDefaultOutputDir(inputs = []) {
  for (const raw of inputs) {
    if (!raw) continue;
    const stat = await fsp.stat(raw).catch(() => null);
    if (!stat) continue;
    return stat.isDirectory() ? path.resolve(raw) : path.dirname(path.resolve(raw));
  }
  return '';
}

// ---------------- 工具解析 ----------------

/**
 * 找一个 jar 工具：先查用户在 UI 上「选择目录」指定的自定义路径，
 * 再查环境变量目录与应用安装目录（toolInstaller.binDirectories()）。
 *
 * extraDirs 由 main.js 从持久化配置读出后传入，让用户可以手动指定工具所在目录。
 */
function findJarTool(toolInstaller, jarName, extraDirs = []) {
  const candidates = [];
  if (process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR) {
    const customDir = path.resolve(process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR);
    if (fs.existsSync(customDir)) candidates.push(customDir);
  }
  // 用户在 UI 上「选择目录」指定的自定义路径，优先级高于应用安装目录
  for (const dir of extraDirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    if (fs.existsSync(resolved)) candidates.push(resolved);
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

function requireJar(toolInstaller, jarName, friendlyName, extraDirs = []) {
  const jar = findJarTool(toolInstaller, jarName, extraDirs);
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
    const out = path.join(outputDir, modifyFileName(input, '.dex'));
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
 * dex2jar：dex / apk → jar（含真正的 .class），由 dex-tools（d2j-dex2jar）完成。
 *
 * 注意：d8 是「class → dex」编译器，喂 dex 只会得到一个「内含 classes.dex」的套壳 jar，
 * 不是可用的 class，所以这里不再回退 d8 —— 缺 dex-tools 时直接报错，避免产出异常 jar。
 */
async function dex2jar(ctx, inputs, outputDir, options) {
  const { runToolStream, toolInstaller, extraDirs } = ctx;
  const { onProgress = () => {} } = options;
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  const dexTools = resolveDexTools(toolInstaller, extraDirs);
  if (!dexTools) {
    throw new Error(
      '未找到 dex-tools（d2j-dex2jar）。dex → jar 需要它才能还原出真正的 .class。' +
      (process.platform === 'win32'
        ? '请在「工具安装」里一键安装。'
        : '请在本页点「在线下载」，或手动放到工具目录。')
    );
  }

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const out = path.join(outputDir, modifyFileName(input, '.jar'));
    onProgress({
      percent: Math.round((i / inputs.length) * 90),
      stage: 'dex2jar',
      detail: path.basename(input)
    });

    await runStream(runToolStream, dexTools, [input, '-o', out], { onProgress, stage: 'dex2jar' });
    results.push({ input, output: out });
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'dex2jar', results, outputDir };
}

/** dex-tools 的入口脚本：Windows 是 .bat，其它是 .sh */
function resolveDexTools(toolInstaller, extraDirs = []) {
  const bins = [];
  for (const dir of extraDirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    if (fs.existsSync(resolved)) bins.push(resolved);
  }
  bins.push(...(toolInstaller?.binDirectories?.() || []));
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
  const { runToolStream, toolInstaller, extraDirs } = ctx;
  const { onProgress = () => {} } = options;
  const cfr = requireJar(toolInstaller, 'cfr.jar', 'CFR', extraDirs);
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const outDir = path.join(outputDir, modifyDirName(`${stem(input)}_src`));
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
 * 按源文件「直接所在目录」分桶：同一目录下的源文件编进同一个 jar，不同目录互不干扰，
 * 产物命名也不会撞车。参见 bucketByRoot。
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
    const classDir = path.join(outputDir, modifyDirName(`${name}_classes`));
    const jarOut = path.join(outputDir, `${name}_modify.jar`);
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
  const { runToolStream, toolInstaller, extraDirs } = ctx;
  const { onProgress = () => {} } = options;
  const baksmali = requireJar(toolInstaller, 'baksmali.jar', 'baksmali', extraDirs);
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const outDir = path.join(outputDir, modifyDirName(`${stem(input)}_smali`));
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
  const { runToolStream, toolInstaller, extraDirs } = ctx;
  const { onProgress = () => {} } = options;
  const smali = requireJar(toolInstaller, 'smali.jar', 'smali', extraDirs);
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];

  const dirs = await collectSmaliDirs(inputs);
  if (dirs.length === 0) throw new Error('未找到任何含 .smali 文件的目录');

  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[i];
    const name = path.basename(dir) || 'classes';
    const out = path.join(outputDir, `${name}_modify.dex`);
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

// ---------------- odex / vdex 反编译 ----------------

const DEX_MAGIC = Buffer.from('dex\n', 'latin1');
const DEX_HEADER_MIN = 112; // dex 头固定长度（0x70）

/** 文件头是不是一个裸 dex（dex\n0xx）。 */
function isDexBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.toString('latin1', 0, 4) === 'dex\n';
}

/**
 * 从 odex / vdex 容器里「抠」出内嵌的 dex。
 *
 * odex / vdex 本质是把一批 dex 拼在容器里，dex 之间还夹着 ELF 头 / 元数据。
 * 这里不解析容器格式，直接按 dex 魔数定位、再用 dex 头里的 file_size 切出完整 segment：
 * 对未 quicken 的 vdex / odex 足够用，也不需要用户额外装 vdexExtractor。
 */
function carveDexBuffers(buffer) {
  const out = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < DEX_HEADER_MIN) return out;
  let from = 0;
  while (from < buffer.length) {
    const at = buffer.indexOf(DEX_MAGIC, from);
    if (at < 0 || at + DEX_HEADER_MIN > buffer.length) break;
    const fileSize = buffer.readUInt32LE(at + 32);
    const headerSize = buffer.readUInt32LE(at + 36);
    if (fileSize < DEX_HEADER_MIN || headerSize < DEX_HEADER_MIN || at + fileSize > buffer.length) {
      from = at + 8; // 魔数误命中，继续往后找
      continue;
    }
    out.push(buffer.subarray(at, at + fileSize));
    from = at + fileSize;
  }
  return out;
}

/**
 * 反编译 odex / vdex：先提取内嵌 dex，再 baksmali 成 smali（两步）。
 *
 * 1) 提取：裸 dex 直接用；odex / vdex 按魔数切出全部内嵌 dex，落盘到 <stem>_dex/
 * 2) 反编译：对每个提取出的 dex 跑 baksmali，产物统一落到 <stem>_smali/
 *
 * 单个文件提取失败不中断整批，失败项收集到 failures 里一并返回。
 */
async function odexDecompile(ctx, inputs, outputDir, options) {
  const { runToolStream, toolInstaller, extraDirs } = ctx;
  const { onProgress = () => {} } = options;
  const baksmali = requireJar(toolInstaller, 'baksmali.jar', 'baksmali', extraDirs);
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];
  const failures = [];

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    const base = Math.round((i / inputs.length) * 90);
    onProgress({ percent: base, stage: '提取 dex', detail: path.basename(input) });

    let dexBuffers;
    try {
      const buffer = await fsp.readFile(input);
      dexBuffers = isDexBuffer(buffer) ? [buffer] : carveDexBuffers(buffer);
    } catch (error) {
      failures.push({ input, error: error.message });
      continue;
    }
    if (!dexBuffers.length) {
      failures.push({ input, error: '未在文件中找到内嵌的 dex' });
      continue;
    }

    const dexDir = path.join(outputDir, modifyDirName(`${stem(input)}_dex`));
    const smaliDir = path.join(outputDir, modifyDirName(`${stem(input)}_smali`));
    await fsp.rm(dexDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(smaliDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dexDir, { recursive: true });
    await fsp.mkdir(smaliDir, { recursive: true });

    const dexFiles = [];
    for (let d = 0; d < dexBuffers.length; d += 1) {
      const name = dexBuffers.length === 1 ? 'classes.dex' : `classes${d + 1}.dex`;
      const target = path.join(dexDir, name);
      await fsp.writeFile(target, dexBuffers[d]);
      dexFiles.push(target);
    }

    for (let d = 0; d < dexFiles.length; d += 1) {
      onProgress({
        percent: base + Math.round(((d + 1) / dexFiles.length) * (90 / inputs.length)),
        stage: 'baksmali 反编译',
        detail: `${path.basename(input)} · ${path.basename(dexFiles[d])}`
      });
      await runStream(runToolStream, 'java', ['-jar', baksmali, 'd', dexFiles[d], '-o', smaliDir], {
        onProgress,
        stage: 'baksmali'
      });
    }

    results.push({ input, dexDir, dexFiles, output: smaliDir, count: dexFiles.length });
  }

  if (!results.length) {
    throw new Error(
      `未能在输入中提取到 dex：${failures
        .slice(0, 3)
        .map((item) => `${path.basename(item.input)}（${item.error}）`)
        .join('、')}`
    );
  }

  onProgress({ percent: 100, stage: '完成' });
  return { success: true, action: 'odex-decompile', results, failures, outputDir };
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
  'dex-recompile': { fn: recompileDex, label: '回编译 dex', collect: null, accept: null },
  'odex-decompile': { fn: odexDecompile, label: '反编译 odex', collect: collectOdexInputs, accept: (f) => isOdexLike(f) }
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
 * @param {string[]} [payload.extraDirs]   用户自定义工具目录（UI 上「选择目录」指定）
 * @param {Function} [payload.onProgress]  ({percent, stage, detail}) => void
 */
async function runDexAction(payload = {}) {
  const { action, inputs = [], outputDir, onProgress, extraDirs = [] } = payload;
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
    toolInstaller: payload.toolInstaller,
    extraDirs
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
  collectOdexInputs,
  carveDexBuffers,
  findJarTool,
  resolveDexTools,
  resolveDefaultOutputDir,
  bucketByRoot
};
