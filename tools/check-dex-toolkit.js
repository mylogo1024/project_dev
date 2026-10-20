/**
 * Dex 工具集自检 —— 用真实的 d8 / javac / baksmali / smali 走一遍全流程。
 *
 * 跑法：node tools/check-dex-toolkit.js
 *
 * 前提（缺哪个就跳过对应用例，不整体失败）：
 *   - d8       Android SDK build-tools
 *   - javac/jar JDK
 *   - baksmali.jar / smali.jar / cfr.jar / d2j-dex2jar.sh  放在下面任一目录：
 *       $DAILY_DEV_TOOLBOX_TOOLS_DIR 或 tool-installer 的安装目录
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFileSync } = require('child_process');

const { createToolContext, createToolRunner } = require('../electron/tool-env');
const toolInstaller = require('../electron/tool-installer');
const {
  runDexAction,
  collectConvertibles,
  collectJavaSources,
  collectSmaliDirs,
  findJarTool,
  resolveDefaultOutputDir,
  bucketByRoot
} = require('../electron/dex-toolkit');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function hasTool(name) {
  const runner = createToolRunner(createToolContext());
  try {
    await runner.runTool(name, ['--version'], { timeout: 8000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'dexkit-check-'));
  const srcDir = path.join(work, 'src');
  await fsp.mkdir(srcDir, { recursive: true });

  // ---- 0. 工具可用性 ----
  const runner = createToolRunner(createToolContext());
  const hasD8 = await hasTool('d8');
  const hasJavac = await hasTool('javac');
  const baksmali = findJarTool(toolInstaller, 'baksmali.jar');
  const smali = findJarTool(toolInstaller, 'smali.jar');
  const cfr = findJarTool(toolInstaller, 'cfr.jar');

  console.log('工具探测：');
  console.log(`  d8        ${hasD8 ? '可用' : '缺失'}`);
  console.log(`  javac/jar ${hasJavac ? '可用' : '缺失'}`);
  console.log(`  baksmali  ${baksmali || '缺失'}`);
  console.log(`  smali     ${smali || '缺失'}`);
  console.log(`  cfr       ${cfr || '缺失'}`);
  console.log('');

  // ---- 1. 纯逻辑：输入归一化 ----
  const javaFile = path.join(srcDir, 'Hello.java');
  await fsp.writeFile(javaFile, 'public class Hello { public static void main(String[] a){ System.out.println("hi"); } }\n');
  const nested = path.join(srcDir, 'com', 'demo');
  await fsp.mkdir(nested, { recursive: true });
  await fsp.writeFile(path.join(nested, 'A.java'), 'package com.demo; public class A {}\n');

  const javaSources = await collectJavaSources([srcDir]);
  record('collectJavaSources 递归到 .java', javaSources.length === 2, `${javaSources.length} 个`);

  const buckets = bucketByRoot(javaSources);
  record('bucketByRoot 按根目录分桶', buckets.size >= 1, `${buckets.size} 桶`);

  // 输出目录默认与输入同目录：目录取自身，文件取所在文件夹
  const defFromDir = await resolveDefaultOutputDir([srcDir]);
  record('resolveDefaultOutputDir 目录取自身', defFromDir === path.resolve(srcDir), defFromDir);
  const defFromFile = await resolveDefaultOutputDir([javaFile]);
  record(
    'resolveDefaultOutputDir 文件取所在目录',
    defFromFile === path.dirname(path.resolve(javaFile)),
    defFromFile
  );

  // ---- 2. 准备 jar（javac + jar，直接走系统命令，不走待测代码） ----
  if (!hasJavac) {
    record('javac 可用', false, '跳过后续 jar 相关用例');
  } else {
    const clsDir = path.join(work, 'classes');
    await fsp.mkdir(clsDir, { recursive: true });
    execFileSync('javac', ['-d', clsDir, javaFile], { stdio: 'pipe' });
    const jarPath = path.join(work, 'hello.jar');
    execFileSync('jar', ['cf', jarPath, '-C', clsDir, '.'], { stdio: 'pipe' });
    record('生成测试 hello.jar', fs.existsSync(jarPath), `${fs.statSync(jarPath).size} B`);

    const collected = await collectConvertibles([jarPath]);
    record('collectConvertibles 收单个 jar', collected.length === 1);
    const collectedDir = await collectConvertibles([work]);
    record('collectConvertibles 收目录', collectedDir.length >= 1, `${collectedDir.length} 个`);

    // ---- 3. jar2dex ----
    if (hasD8) {
      const dexOut = path.join(work, 'dex');
      const res = await runDexAction({
        action: 'jar2dex',
        inputs: [jarPath],
        outputDir: dexOut,
        runTool: runner.runTool,
        runToolStream: runner.runToolStream,
        toolInstaller
      });
      const dexFile = res.results[0].output;
      record('jar2dex 产出 .dex', fs.existsSync(dexFile), `${fs.statSync(dexFile).size} B`);

      // ---- 4. dex 反编译 / 回编译 ----
      if (baksmali && smali) {
        const smaliOut = path.join(work, 'smali');
        const dRes = await runDexAction({
          action: 'dex-decompile',
          inputs: [dexFile],
          outputDir: smaliOut,
          runTool: runner.runTool,
          runToolStream: runner.runToolStream,
          toolInstaller
        });
        const smaliDir = dRes.results[0].output;
        const smaliFiles = await fsp.readdir(smaliDir).catch(() => []);
        record('dex 反编译出 .smali', smaliFiles.some((f) => f.endsWith('.smali')), smaliFiles.join(','));

        const dirs = await collectSmaliDirs([smaliDir]);
        record('collectSmaliDirs 识别 smali 目录', dirs.length === 1);

        const reOut = path.join(work, 'redex');
        const rRes = await runDexAction({
          action: 'dex-recompile',
          inputs: [smaliDir],
          outputDir: reOut,
          runTool: runner.runTool,
          runToolStream: runner.runToolStream,
          toolInstaller
        });
        const reDex = rRes.results[0].output;
        record('dex 回编译出 .dex', fs.existsSync(reDex), `${fs.statSync(reDex).size} B`);
      } else {
        record('baksmali/smali 用例', false, '未找到 jar，跳过（放到工具目录后可覆盖）');
      }

      // ---- 5. dex2jar（需要 dex-tools） ----
      const hasDexTools = !!(require('../electron/dex-toolkit').resolveDexTools(toolInstaller));
      if (hasDexTools) {
        const jarOut = path.join(work, 'fromdex');
        const jRes = await runDexAction({
          action: 'dex2jar',
          inputs: [dexFile],
          outputDir: jarOut,
          runTool: runner.runTool,
          runToolStream: runner.runToolStream,
          toolInstaller
        });
        record('dex2jar 产出 .jar', fs.existsSync(jRes.results[0].output), '（dex-tools）');
      } else {
        record('dex2jar 用例', false, '未找到 dex-tools，跳过');
      }
    } else {
      record('d8 用例', false, '未找到 d8，跳过');
    }

    // ---- 6. jar 回编译 ----
    const rcOut = path.join(work, 'rejar');
    const rcRes = await runDexAction({
      action: 'jar-recompile',
      inputs: [srcDir],
      outputDir: rcOut,
      runTool: runner.runTool,
      runToolStream: runner.runToolStream,
      toolInstaller
    });
    const rebuilt = rcRes.results[0];
    record('jar 回编译产出 .jar', fs.existsSync(rebuilt.jar), path.basename(rebuilt.jar));

    // ---- 7. jar 反编译 ----
    if (cfr) {
      const dcOut = path.join(work, 'decompiled');
      const dcRes = await runDexAction({
        action: 'jar-decompile',
        inputs: [rebuilt.jar],
        outputDir: dcOut,
        runTool: runner.runTool,
        runToolStream: runner.runToolStream,
        toolInstaller
      });
      const outDir = dcRes.results[0].output;
      const files = await fsp.readdir(outDir, { recursive: true }).catch(() => []);
      record('jar 反编译出 .java', files.some((f) => String(f).endsWith('.java')), `${files.length} 个文件`);
    } else {
      record('CFR 用例', false, '未找到 cfr.jar，跳过');
    }

    // ---- 8. 批量 ----
    if (hasD8) {
      const jarB = path.join(work, 'hello2.jar');
      await fsp.copyFile(path.join(work, 'hello.jar'), jarB);
      const batchOut = path.join(work, 'batch');
      const bRes = await runDexAction({
        action: 'jar2dex',
        inputs: [path.join(work, 'hello.jar'), jarB],
        outputDir: batchOut,
        runTool: runner.runTool,
        runToolStream: runner.runToolStream,
        toolInstaller
      });
      record('批量 jar2dex 不互相覆盖', bRes.results.length === 2 && new Set(bRes.results.map((r) => r.output)).size === 2);
    }

    // ---- 9. 错误分支 ----
    let rejected = false;
    try {
      await runDexAction({
        action: 'jar2dex',
        inputs: [javaFile],
        outputDir: path.join(work, 'x'),
        runTool: runner.runTool,
        runToolStream: runner.runToolStream,
        toolInstaller
      });
    } catch (error) {
      rejected = /输入类型不匹配|未识别到/.test(error.message);
    }
    record('类型不匹配时报错', rejected);

    let noOutput = false;
    try {
      await runDexAction({
        action: 'jar2dex',
        inputs: [jarPath],
        outputDir: '',
        runTool: runner.runTool,
        runToolStream: runner.runToolStream,
        toolInstaller
      });
    } catch (error) {
      noOutput = /输出目录/.test(error.message);
    }
    record('缺输出目录时报错', noOutput);
  }

  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    console.log(failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('自检脚本异常:', error);
  process.exitCode = 1;
});
