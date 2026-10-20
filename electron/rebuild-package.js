'use strict';

/**
 * 把反编译目录打回 APK / IPA。
 *
 * Android：apktool b（需要目录里有 apktool.yml）
 * iOS：把 Payload 等顶层目录重新 zip 成 IPA（解包时多出来的 _symbols 不打进去）
 */
const fs = require('node:fs');
const path = require('node:path');
const { siblingPath, signApk } = require('./apk-sign');

const IPA_EXTRAS = Object.freeze(['SwiftSupport', 'WatchKitSupport2', 'Symbols']);

function detectProjectKind(projectDir) {
  if (typeof projectDir !== 'string' || !projectDir) return null;
  let stat;
  try {
    stat = fs.statSync(projectDir);
  } catch (_) {
    return null;
  }
  if (!stat.isDirectory()) return null;
  if (fs.existsSync(path.join(projectDir, 'apktool.yml'))) return 'android';
  if (hasPayloadApp(projectDir)) return 'ios';
  return null;
}

function hasPayloadApp(projectDir) {
  const payload = path.join(projectDir, 'Payload');
  try {
    return fs.readdirSync(payload).some((name) => name.endsWith('.app'));
  } catch (_) {
    return false;
  }
}

function defaultOutputPath(projectDir, kind) {
  const parent = path.dirname(projectDir);
  const name = path.basename(projectDir);
  const ext = kind === 'ios' ? '.ipa' : '.apk';
  return path.join(parent, `${name}-rebuilt${ext}`);
}

function ipaZipEntries(projectDir) {
  const entries = ['Payload'];
  for (const extra of IPA_EXTRAS) {
    if (fs.existsSync(path.join(projectDir, extra))) entries.push(extra);
  }
  return entries;
}

function removeIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) { /* 临时未签名包删不掉不影响已签好的产物 */ }
}

async function rebuildAndroid({ runTool, projectDir, outputPath, onProgress, sign }) {
  if (!sign || !sign.keystorePath) {
    throw new Error('请先在「设置」里配置签名文件，回编译会按 v1+v2 对齐并签名');
  }
  const unsignedPath = siblingPath(outputPath, '-unsigned');
  onProgress?.({ percent: 8, stage: '调用 apktool 回编译' });
  removeIfExists(unsignedPath);
  await runTool('apktool', ['b', projectDir, '-o', unsignedPath], {
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024
  });
  onProgress?.({ percent: 72, stage: '对齐并签名（v1+v2）' });
  try {
    const signed = await signApk({
      runTool,
      apkPath: unsignedPath,
      outputPath,
      keystorePath: sign.keystorePath,
      alias: sign.alias || '',
      password: sign.password || '',
      v1: sign.v1 !== false,
      v2: sign.v2 !== false,
      v3: sign.v3 === true
    });
    removeIfExists(unsignedPath);
    onProgress?.({ percent: 100, stage: '完成' });
    return {
      success: true,
      kind: 'android',
      outputPath: signed.outputPath,
      unsigned: false,
      signed: true,
      schemes: signed.schemes,
      message: `回编译成功，已 zipalign 并以 v1+v2 签名，输出文件: ${signed.outputPath}`
    };
  } catch (error) {
    throw new Error(`${error.message}（未签名包还在 ${unsignedPath}）`);
  }
}

async function rebuildIos({ runTool, projectDir, outputPath, onProgress }) {
  onProgress?.({ percent: 10, stage: '打包 IPA' });
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  await runTool('zip', ['-qry', outputPath, ...ipaZipEntries(projectDir)], {
    cwd: projectDir,
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024
  });
  onProgress?.({ percent: 100, stage: '完成' });
  return {
    success: true,
    kind: 'ios',
    outputPath,
    unsigned: false,
    message: `回编译成功，输出文件: ${outputPath}。如需改签名，请到「应用签名」重签。`
  };
}

async function rebuildPackage({ runTool, projectDir, outputPath, onProgress, sign } = {}) {
  if (typeof runTool !== 'function') throw new Error('rebuildPackage 需要 runTool');
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    throw new Error('请选择反编译后的目录');
  }
  const root = path.resolve(projectDir.trim());
  const kind = detectProjectKind(root);
  if (!kind) {
    throw new Error('这个目录不是 apktool 工程（缺 apktool.yml），也不是解包后的 IPA（缺 Payload/*.app）');
  }
  const dest = outputPath && String(outputPath).trim()
    ? path.resolve(outputPath.trim())
    : defaultOutputPath(root, kind);
  if (kind === 'android') {
    return rebuildAndroid({ runTool, projectDir: root, outputPath: dest, onProgress, sign });
  }
  return rebuildIos({ runTool, projectDir: root, outputPath: dest, onProgress });
}

module.exports = {
  detectProjectKind,
  defaultOutputPath,
  ipaZipEntries,
  rebuildPackage
};
