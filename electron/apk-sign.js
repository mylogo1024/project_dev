'use strict';

/**
 * Android APK 签名：先 zipalign，再按用户勾选的 v1 / v2 / v3 调用 apksigner。
 *
 * 顺序不能反。apksigner 会保留对齐；jarsigner 会破坏对齐，所以 jarsigner
 * 只在「只要 v1 且 apksigner 不可用」时作为退路，签完还要再对齐一次。
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEME_KEYS = Object.freeze(['v1', 'v2', 'v3']);

const SCHEME_PRESETS = Object.freeze([
  { id: 'v1', label: '仅 v1', v1: true, v2: false, v3: false, hint: 'Android 4.x / 旧设备 JAR 签名' },
  { id: 'v2', label: '仅 v2', v1: false, v2: true, v3: false, hint: 'Android 7+ APK Signature Scheme v2' },
  { id: 'v3', label: '仅 v3', v1: false, v2: false, v3: true, hint: 'Android 9+ APK Signature Scheme v3' },
  { id: 'v1v2', label: 'v1 + v2', v1: true, v2: true, v3: false, hint: '覆盖旧系统与 Android 7+' },
  { id: 'v2v3', label: 'v2 + v3', v1: false, v2: true, v3: true, hint: 'Android 7+，不含 JAR 签名' },
  { id: 'v1v2v3', label: 'v1 + v2 + v3', v1: true, v2: true, v3: true, hint: '全开，兼容面最大' }
]);

function normalizeSchemes(input = {}) {
  const schemes = {
    v1: Boolean(input.v1),
    v2: Boolean(input.v2),
    v3: Boolean(input.v3)
  };
  if (!schemes.v1 && !schemes.v2 && !schemes.v3) {
    throw new Error('请至少选择一种签名方案（v1 / v2 / v3）');
  }
  return schemes;
}

function describeSchemes(schemes) {
  return SCHEME_KEYS.filter((key) => schemes[key]).join('+');
}

function boolFlag(value) {
  return value ? 'true' : 'false';
}

function buildApksignerSignArgs({
  keystorePath,
  alias,
  password,
  outputPath,
  apkPath,
  v1,
  v2,
  v3
}) {
  const schemes = normalizeSchemes({ v1, v2, v3 });
  return [
    'sign',
    '--ks', keystorePath,
    '--ks-key-alias', alias,
    '--ks-pass', `pass:${password}`,
    '--key-pass', `pass:${password}`,
    '--v1-signing-enabled', boolFlag(schemes.v1),
    '--v2-signing-enabled', boolFlag(schemes.v2),
    '--v3-signing-enabled', boolFlag(schemes.v3),
    '--out', outputPath,
    apkPath
  ];
}

function looksLikeMissingV3(error) {
  const text = String(error?.message || error || '');
  return /v3-signing-enabled|unrecognized option|unknown option/i.test(text);
}

function siblingPath(filePath, suffix) {
  const ext = path.extname(filePath);
  const stem = filePath.slice(0, filePath.length - ext.length);
  return `${stem}${suffix}${ext || '.apk'}`;
}

function removeIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) { /* 临时文件删不掉不影响签名结果 */ }
}

async function zipalignApk(runTool, inputPath, outputPath) {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  await runTool('zipalign', ['-f', '-p', '4', inputPath, outputPath], {
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024
  });
}

async function signWithApksigner(runTool, args) {
  try {
    return await runTool('apksigner', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const v3Index = args.indexOf('--v3-signing-enabled');
    if (v3Index >= 0 && looksLikeMissingV3(error)) {
      if (args[v3Index + 1] === 'true') {
        throw new Error('当前 apksigner 不支持 v3，请升级 Android SDK build-tools，或去掉 v3 后再签');
      }
      const retry = args.filter((_, index) => index !== v3Index && index !== v3Index + 1);
      return runTool('apksigner', retry, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    }
    throw error;
  }
}

async function signApk({
  runTool,
  apkPath,
  keystorePath,
  alias,
  password,
  outputPath: signedPath,
  v1 = true,
  v2 = true,
  v3 = true
} = {}) {
  if (typeof runTool !== 'function') throw new Error('signApk 需要 runTool');
  if (!apkPath) throw new Error('请先选择 APK 文件');
  if (!keystorePath) throw new Error('请选择签名文件');
  if (!alias) throw new Error('请输入别名');
  if (!password) throw new Error('请输入密码');

  const schemes = normalizeSchemes({ v1, v2, v3 });
  const alignedPath = siblingPath(apkPath, '-aligned');
  const outputPath = typeof signedPath === 'string' && signedPath.trim()
    ? path.resolve(signedPath.trim())
    : siblingPath(apkPath, '-signed');
  const errors = [];

  try {
    await zipalignApk(runTool, apkPath, alignedPath);
  } catch (error) {
    throw new Error(`签名前对齐失败: ${error.message}`);
  }

  try {
    const args = buildApksignerSignArgs({
      keystorePath,
      alias,
      password,
      outputPath,
      apkPath: alignedPath,
      ...schemes
    });
    await signWithApksigner(runTool, args);
    removeIfExists(alignedPath);
    return {
      success: true,
      outputPath,
      schemes,
      message: `签名成功（${describeSchemes(schemes)}，已先 zipalign），输出文件: ${outputPath}`
    };
  } catch (error) {
    errors.push(`apksigner: ${error.message}`);
    if (schemes.v2 || schemes.v3) {
      removeIfExists(alignedPath);
      throw new Error(`签名失败（需要 v2/v3，不能退回 jarsigner）。${errors.join('；')}`);
    }
  }

  // 只要 v1：jarsigner 会破坏对齐，签完必须再 zipalign
  const jarSignedPath = siblingPath(apkPath, '-jarsigned');
  try {
    fs.copyFileSync(alignedPath, jarSignedPath);
    await runTool('jarsigner', [
      '-keystore', keystorePath,
      '-storepass', password,
      '-keypass', password,
      jarSignedPath,
      alias
    ], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    await zipalignApk(runTool, jarSignedPath, outputPath);
    removeIfExists(alignedPath);
    removeIfExists(jarSignedPath);
    return {
      success: true,
      outputPath,
      schemes,
      message: `签名成功（v1 / jarsigner，签后已重新 zipalign），输出文件: ${outputPath}`
    };
  } catch (error) {
    errors.push(`jarsigner: ${error.message}`);
    removeIfExists(alignedPath);
    removeIfExists(jarSignedPath);
    throw new Error(`签名失败。${errors.join('；')}`);
  }
}

module.exports = {
  SCHEME_PRESETS,
  normalizeSchemes,
  describeSchemes,
  buildApksignerSignArgs,
  looksLikeMissingV3,
  siblingPath,
  signApk
};
