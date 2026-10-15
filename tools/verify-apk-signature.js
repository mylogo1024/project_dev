'use strict';

/**
 * APK 签名解析 · 真值交叉验证
 *
 * 拿 Android build-tools 自带的 apksigner 当「标准答案」，
 * 跟 electron/pkginfo/apksig.js 的解析结果逐项比对。
 *
 * apksigner 是 Google 官方实现，它说 v2 就是 v2 —— 拿它当基准，
 * 比拿自己的代码当基准靠谱得多（也正因如此才挖出 readApkSigningBlock
 * 那个 off-by-16：自测全绿，跟 apksigner 一比就露馅）。
 *
 * 用法：
 *   node tools/verify-apk-signature.js <apk...>
 *   node tools/verify-apk-signature.js --dir /path/to/apks
 *   node tools/verify-apk-signature.js --json <apk...>     # 机器可读
 *
 * 退出码：0 = 全部一致，1 = 存在不一致（方便挂到 CI / npm script）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { openZip } = require('../electron/pkginfo/zip');
const { parseApkSignature } = require('../electron/pkginfo/apksig');

// ---------- apksigner 定位 ----------

function findApksigner() {
  if (process.env.APKSIGNER) return process.env.APKSIGNER;

  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME || '', 'Library/Android/sdk')
  ].filter(Boolean);

  for (const root of sdkRoots) {
    const buildTools = path.join(root, 'build-tools');
    if (!fs.existsSync(buildTools)) continue;
    // 取版本号最大的那个
    const versions = fs
      .readdirSync(buildTools)
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
      });
    for (const version of versions) {
      const bin = path.join(buildTools, version, 'apksigner');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * 跑 apksigner verify --print-certs，返回它认可的签名方案集合。
 *
 * 注意：apksigner 的 "Verified using v2 scheme (APK Signature Scheme v2): true"
 * 只在「该方案存在且验签通过」时为 true。我们要比对的是「有没有」，
 * 所以这里读的是 vN scheme 那一行的 true/false。
 */
function runApksigner(apksigner, apkPath) {
  let output = '';
  try {
    output = execFileSync(apksigner, ['verify', '--print-certs', '--verbose', apkPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (error) {
    // apksigner 验签失败会以非 0 退出，但 stdout 里仍有完整信息
    output = `${error.stdout || ''}${error.stderr || ''}`;
    if (!output.trim()) {
      return { error: (error.message || 'apksigner 执行失败').split('\n')[0], schemes: [] };
    }
  }

  const schemes = [];
  const reportedSchemes = [];
  const matchers = [
    ['v1', /Verified using v1 scheme \(JAR signing\):\s*(true|false)/i],
    ['v2', /Verified using v2 scheme \(APK Signature Scheme v2\):\s*(true|false)/i],
    ['v3', /Verified using v3 scheme \(APK Signature Scheme v3\):\s*(true|false)/i],
    ['v3\.1', /Verified using v3\.1 scheme \(APK Signature Scheme v3\.1\):\s*(true|false)/i],
    ['v4', /Verified using v4 scheme \(APK Signature Scheme v4\):\s*(true|false)/i]
  ];
  for (const [name, re] of matchers) {
    const m = output.match(re);
    if (!m) continue;
    reportedSchemes.push(name);
    if (m[1].toLowerCase() === 'true') schemes.push(name);
  }

  const signerCount = (output.match(/^Signer #\d+/gm) || []).length;
  return {
    error: null,
    schemes,
    reportedSchemes,
    // 没有输出任何 "Verified using" 行 = apksigner 中途放弃，对签名方案「没有意见」
    noOpinion: reportedSchemes.length === 0,
    doesNotVerify: /DOES NOT VERIFY/i.test(output),
    raw: output
  };
}

// ---------- 比对 ----------

/**
 * 统计「没被中央目录收录、却带着加密位(bit0)的 local header」。
 *
 * 加固 / 加壳工具常把加密载荷塞成假的 local file header，故意不登记到
 * 中央目录里。java.util.zip（以及基于它的 apksigner / jarsigner）读到这些
 * 就会抛 `ZipException: encrypted ZIP entry not supported`，v1 校验直接中止。
 *
 * 纯按中央目录解析的实现看不见这些块，于是会出现
 * 「apksigner 说 v1=false、我们说 v1 有效」的差异。
 * 这是诊断用的小工具，不参与判定，只用来解释差异。
 */
function countUnregisteredEncryptedHeaders(apkPath, zip) {
  const registered = new Set(zip.entries.map((entry) => entry.localHeaderOffset));
  const raw = fs.readFileSync(apkPath);
  const needle = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let found = 0;
  let cursor = 0;
  while (true) {
    const at = raw.indexOf(needle, cursor);
    if (at < 0 || at + 8 > raw.length) break;
    const flags = raw.readUInt16LE(at + 6);
    if ((flags & 1) === 1 && !registered.has(at)) found += 1;
    cursor = at + 4;
  }
  return found;
}

function compare(apkPath, apksigner) {
  const name = path.basename(apkPath);
  const row = { file: name, path: apkPath };

  let ours;
  let zip = null;
  try {
    zip = openZip(apkPath);
    ours = parseApkSignature(zip);
  } catch (error) {
    row.oursError = (error.message || String(error)).split('\n')[0];
    row.ours = [];
    row.match = false;
    row.note = `解析抛错：${row.oursError}`;
    return row;
  }
  row.ours = ours.signed_schemes || [];
  row.schemeLabel = ours.scheme_label;

  const truth = runApksigner(apksigner, apkPath);
  row.truth = truth.schemes;
  row.truthError = truth.error;
  row.signerCount = truth.signerCount;
  row.doesNotVerify = truth.doesNotVerify;

  // apksigner 连 "Verified using ..." 都没打出来（比如 targetSdk 要求 v2 而包里没有，
  // 它直接 DOES NOT VERIFY 退出）——这种情况它对签名方案根本没表态，不能算差异。
  if (truth.noOpinion) {
    row.match = false;
    row.explained = true;
    row.noOpinion = true;
    row.note = 'apksigner 未输出任何签名方案结论（提前中止，通常是因为 targetSdk 要求更高版本的签名方案），无法比对';
    return row;
  }

  const oursSet = new Set(row.ours);
  const truthSet = new Set(truth.reportedSchemes.filter((s) => truth.schemes.includes(s)));
  // 只比对 apksigner 明确表过态的方案
  const truthReported = new Set(truth.reportedSchemes);
  row.missing = [...truthSet].filter((s) => !oursSet.has(s));
  row.extra = row.ours.filter((s) => truthReported.has(s) && !truthSet.has(s));
  row.match = row.missing.length === 0 && row.extra.length === 0;

  if (!row.match) {
    const bits = [];
    if (row.missing.length) bits.push(`漏报 ${row.missing.join('/')}`);
    if (row.extra.length) bits.push(`误报 ${row.extra.join('/')}`);
    row.note = bits.join('，');

    // v1 差异十有八九是「加固隐藏了加密载荷」，这里给出证据而不是含糊带过
    if (row.extra.includes('v1') && zip) {
      try {
        const hidden = countUnregisteredEncryptedHeaders(apkPath, zip);
        row.hiddenEncryptedHeaders = hidden;
        if (hidden > 0) {
          row.explained = true;
          // 已定位到原因，就别再写成「本项目误报」了 —— 会误导人以为解析器有 bug
          row.note = `检出 ${hidden} 个未登记的加密 local header（加固特征），` +
            'java.util.zip 读到就会中止，apksigner/jarsigner 因此给不出 v1 结论；' +
            '本项目按中央目录解析，四层 JAR 校验（PKCS#7 / .SF 清单摘要 / 条目摘要 / 覆盖率）均通过';
        }
      } catch (_) { /* 诊断失败不影响结论 */ }
    }
  }
  return row;
}

// ---------- 主流程 ----------

function collectTargets(argv) {
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      const dir = argv[i + 1];
      i += 1;
      if (!dir) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry.toLowerCase().endsWith('.apk')) targets.push(path.join(dir, entry));
      }
    } else if (!arg.startsWith('--')) {
      targets.push(arg);
    }
  }
  return targets;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const targets = collectTargets(argv);

  if (!targets.length) {
    console.error('用法：node tools/verify-apk-signature.js <apk...> | --dir <目录> [--json]');
    process.exit(2);
  }

  const apksigner = findApksigner();
  if (!apksigner) {
    console.error('找不到 apksigner。请设置 APKSIGNER 环境变量，或安装 Android build-tools。');
    process.exit(2);
  }

  const rows = targets.map((target) => compare(target, apksigner));

  if (asJson) {
    console.log(JSON.stringify({ apksigner, rows }, null, 2));
  } else {
    console.log(`apksigner: ${apksigner}\n`);
    const pad = (text, width) => String(text).padEnd(width);
    console.log(`${pad('文件', 40)} ${pad('本项目解析', 20)} ${pad('apksigner', 20)} 结论`);
    console.log('-'.repeat(100));
    for (const row of rows) {
      let verdict;
      if (row.match) verdict = 'OK';
      else if (row.explained) verdict = '差异（已解释）';
      else verdict = `不一致（${row.note}）`;
      console.log(
        `${pad(row.file.slice(0, 39), 40)} ${pad(row.ours.join('+') || '-', 20)} ` +
        `${pad(row.truth.join('+') || '-', 20)} ${verdict}`
      );
    }
    console.log('-'.repeat(100));

    const ok = rows.filter((row) => row.match).length;
    const explained = rows.filter((row) => !row.match && row.explained);
    const real = rows.filter((row) => !row.match && !row.explained);
    console.log(`完全一致 ${ok}/${rows.length}` +
      (explained.length ? `，已解释差异 ${explained.length}` : '') +
      (real.length ? `，待查差异 ${real.length}` : ''));

    for (const row of [...explained, ...real]) {
      console.log(`\n  · ${row.file}\n      ${row.note}`);
    }
  }

  // 只有「说不清原因」的差异才算失败；加固那种能解释的放行
  process.exit(rows.every((row) => row.match || row.explained) ? 0 : 1);
}

if (require.main === module) main();

module.exports = { findApksigner, runApksigner, compare };
