'use strict';

/**
 * 包体静态信息解析 —— 统一入口
 *
 * 对外只暴露两个能力：
 *   parsePackageStaticInfo(filePath)  →  { basic, detailed, ... }
 *   comparePackageInfo(before, after) →  文档 2.18 版本对比差异
 *
 * 结构遵循《AppReader 包体静态信息文档》：
 *   basic    基本信息（P0，打开即看）
 *   detailed 详细信息（12 大类，P1/P2/P3）
 */

const fs = require('fs');
const path = require('path');

const { parseAndroidPackage, parseAabBundleConfig, detectContainerKind, buildLaunchCommand, inspectPacker } = require('./apk');
const { parseIosPackage } = require('./ipa');
const { openZip } = require('./zip');
const { buildSymbolIndex, querySymbolIndex } = require('./symbols');
const { formatBytes, makeProgressReporter } = require('./util');

const SCHEMA_VERSION = '0.2';

/** 支持的文件类型 → 内部标识。 */
const SUPPORTED_EXTENSIONS = {
  '.apk': 'apk',
  '.aab': 'aab',
  '.ipa': 'ipa'
};

const TYPE_LABELS = { apk: 'APK', aab: 'AAB', ipa: 'IPA' };

/** detailed 各分类的展示元信息，供前端渲染导航与表格。 */
const SECTION_CATALOG = [
  { id: '2.1', title: '文件与包体结构', icon: '📦', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.2', title: '应用标识（Android）', icon: '🆔', platforms: ['apk', 'aab'] },
  { id: '2.3', title: '应用标识（iOS）', icon: '🆔', platforms: ['ipa'] },
  { id: '2.4', title: '应用元数据', icon: '🏷️', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.5', title: '构建与签名信息', icon: '✍️', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.6', title: '权限（Android）', icon: '🔑', platforms: ['apk', 'aab'] },
  { id: '2.7', title: '权限（iOS）', icon: '🔑', platforms: ['ipa'] },
  { id: '2.8', title: '组件（Android）', icon: '🧩', platforms: ['apk', 'aab'] },
  { id: '2.9', title: '组件与框架（iOS）', icon: '🧩', platforms: ['ipa'] },
  { id: '2.10', title: 'DEX / 字节码', icon: '⚙️', platforms: ['apk', 'aab'] },
  { id: '2.11', title: 'Native / 原生代码', icon: '🧱', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.12', title: '资源', icon: '🎨', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.13', title: '文件清单', icon: '🗂️', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.14', title: 'SDK 与框架', icon: '📚', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.15', title: '安全与风险', icon: '🛡️', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.16', title: '隐私与合规', icon: '🔒', platforms: ['apk', 'aab', 'ipa'] },
  { id: '2.17', title: '加固与混淆', icon: '🧿', platforms: ['apk', 'aab'] },
  { id: '2.19', title: '原始数据（供高级用户）', icon: '🧾', platforms: ['apk', 'aab', 'ipa'] }
];

/**
 * 解析包体静态信息。
 * @param {string} filePath APK / AAB / IPA 绝对路径
 * @param {{kind?: string, onProgress?: (info: {percent: number, stage: string, detail?: string}) => void}} [options]
 *   onProgress 会在各解析阶段被同步调用，用于驱动前端进度条；
 *   回调内部异常会被吞掉，不会影响解析结果。
 */
function parsePackageStaticInfo(filePath, options = {}) {
  const report = makeProgressReporter(options.onProgress);
  report(0, '准备解析');
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('请提供包体文件路径');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是有效的文件: ${filePath}`);

  const ext = path.extname(filePath).toLowerCase();
  let kind = options.kind || SUPPORTED_EXTENSIONS[ext] || null;

  if (!kind) {
    // 扩展名不认识时按内容嗅探
    report(1, '嗅探容器类型');
    const probe = openZip(filePath);
    try {
      kind = detectContainerKind(probe);
    } finally {
      probe.close();
    }
    if (!kind) {
      throw new Error(`不支持的文件类型（${ext || '无扩展名'}），仅支持 APK / AAB / IPA`);
    }
  }

  if (!TYPE_LABELS[kind]) {
    throw new Error(`不支持的文件类型: ${kind}`);
  }

  let result;
  if (kind === 'ipa') {
    result = parseIosPackage(filePath, { onProgress: options.onProgress });
  } else {
    let bundleConfig = null;
    if (kind === 'aab') {
      report(4, '解析 AAB BundleConfig.pb');
      const probe = openZip(filePath);
      try {
        bundleConfig = parseAabBundleConfig(probe);
      } finally {
        probe.close();
      }
    }
    result = parseAndroidPackage(filePath, { kind, bundleConfig, onProgress: options.onProgress });
    if (kind === 'aab' && result.detailed['2.5']) {
      result.detailed['2.5'].build_info.aab_bundletool = bundleConfig;
    }
  }

  report(100, '解析完成');
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    file_path: filePath,
    container: result.container,
    platform: result.platform,
    sections: SECTION_CATALOG.filter((section) => section.platforms.includes(result.container)),
    basic: result.basic,
    detailed: result.detailed,
    warnings: result.warnings || [],
    elapsed_ms: result.elapsed_ms
  };
}

// ==================== 版本对比（文档 2.18） ====================

function toNameSet(list, key = 'name') {
  return new Set((list || []).map((item) => (typeof item === 'string' ? item : item?.[key])).filter(Boolean));
}

function diffSets(before, after) {
  const added = [...after].filter((item) => !before.has(item)).sort();
  const removed = [...before].filter((item) => !after.has(item)).sort();
  return { added, removed };
}

function diffValues(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const key of [...keys].sort()) {
    const a = before?.[key];
    const b = after?.[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changes.push({ field: key, before: a ?? null, after: b ?? null });
  }
  return changes;
}

/**
 * 对比两次解析结果，产出文档 2.18 定义的差异字段。
 * @param {object} before parsePackageStaticInfo 结果
 * @param {object} after  parsePackageStaticInfo 结果
 */
function comparePackageInfo(before, after) {
  if (!before?.basic || !after?.basic) {
    throw new Error('对比需要两份完整的解析结果');
  }

  const oldBasic = before.basic;
  const newBasic = after.basic;
  const oldDetailed = before.detailed || {};
  const newDetailed = after.detailed || {};

  const permissionDiff = diffSets(
    toNameSet(oldDetailed['2.6']?.requested || oldDetailed['2.7']?.usage_descriptions),
    toNameSet(newDetailed['2.6']?.requested || newDetailed['2.7']?.usage_descriptions)
  );

  const collectComponents = (detailed) => {
    const source = detailed['2.8'] || {};
    return [
      ...(source.activities || []),
      ...(source.activity_aliases || []),
      ...(source.services || []),
      ...(source.receivers || []),
      ...(source.providers || [])
    ];
  };
  const componentDiff = diffSets(
    new Set(collectComponents(oldDetailed).map((item) => `${item.type}:${item.name}`)),
    new Set(collectComponents(newDetailed).map((item) => `${item.type}:${item.name}`))
  );

  const sdkDiff = diffSets(
    toNameSet(oldDetailed['2.14']?.sdks, 'sdk_name'),
    toNameSet(newDetailed['2.14']?.sdks, 'sdk_name')
  );

  const fileDiff = diffSets(
    new Set((oldDetailed['2.13']?.entries || []).map((item) => item.name)),
    new Set((newDetailed['2.13']?.entries || []).map((item) => item.name))
  );

  const sizeDelta = (newBasic.file?.size || 0) - (oldBasic.file?.size || 0);
  const riskDelta = (newBasic.risk?.score || 0) - (oldBasic.risk?.score || 0);

  const findingsById = (detailed) => {
    const map = new Map();
    for (const finding of detailed['2.15']?.findings || []) map.set(finding.id, finding);
    return map;
  };
  const oldFindings = findingsById(oldDetailed);
  const newFindings = findingsById(newDetailed);
  const newRiskItems = [...newFindings.keys()].filter((id) => !oldFindings.has(id));
  const fixedRiskItems = [...oldFindings.keys()].filter((id) => !newFindings.has(id));

  return {
    version_old: oldBasic.app?.version_display || oldBasic.app?.version_name || '未知',
    version_new: newBasic.app?.version_display || newBasic.app?.version_name || '未知',
    version_code_old: oldBasic.app?.version_code ?? null,
    version_code_new: newBasic.app?.version_code ?? null,
    size_delta: sizeDelta,
    size_delta_human: `${sizeDelta >= 0 ? '+' : '-'}${formatBytes(Math.abs(sizeDelta))}`,
    size_old_human: oldBasic.file?.size_human || null,
    size_new_human: newBasic.file?.size_human || null,
    permission_added: permissionDiff.added,
    permission_removed: permissionDiff.removed,
    component_added: componentDiff.added,
    component_removed: componentDiff.removed,
    sdk_added: sdkDiff.added,
    sdk_removed: sdkDiff.removed,
    signature_changed: (oldBasic.signature?.sha256 || '') !== (newBasic.signature?.sha256 || ''),
    signature_old: oldBasic.signature?.sha256 || null,
    signature_new: newBasic.signature?.sha256 || null,
    risk_delta: riskDelta,
    risk_old: oldBasic.risk?.score ?? null,
    risk_new: newBasic.risk?.score ?? null,
    risk_level_old: oldBasic.risk?.level_label || null,
    risk_level_new: newBasic.risk?.level_label || null,
    risk_added: newRiskItems,
    risk_fixed: fixedRiskItems,
    file_added: fileDiff.added.slice(0, 500),
    file_removed: fileDiff.removed.slice(0, 500),
    file_added_count: fileDiff.added.length,
    file_removed_count: fileDiff.removed.length,
    identity_changes: diffValues(
      {
        identifier: oldBasic.app?.identifier,
        name: oldBasic.app?.name,
        min_sdk: oldBasic.app?.min_sdk,
        target_sdk: oldBasic.app?.target_sdk,
        abis: oldBasic.app?.abis,
        dex_count: oldBasic.structure?.dex_count,
        packed: oldBasic.structure?.packed
      },
      {
        identifier: newBasic.app?.identifier,
        name: newBasic.app?.name,
        min_sdk: newBasic.app?.min_sdk,
        target_sdk: newBasic.app?.target_sdk,
        abis: newBasic.app?.abis,
        dex_count: newBasic.structure?.dex_count,
        packed: newBasic.structure?.packed
      }
    )
  };
}

// ==================== DEX 符号检索 ====================

/**
 * 符号索引比较重（要解压并遍历所有 DEX），按「路径 + 大小 + mtime」缓存。
 * 同一个包连续搜几次就不用反复解析；用 Map 的迭代顺序当 LRU。
 */
const symbolIndexCache = new Map();
const SYMBOL_CACHE_LIMIT = 4;

function loadSymbolIndex(filePath) {
  const stat = fs.statSync(filePath);
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;

  const cached = symbolIndexCache.get(key);
  if (cached) {
    symbolIndexCache.delete(key);
    symbolIndexCache.set(key, cached);
    return cached;
  }

  const zip = openZip(filePath);
  try {
    const dexEntries = zip.entries
      .filter((entry) => !entry.isDirectory && /^classes\d*\.dex$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

    if (!dexEntries.length) {
      throw new Error('该包体里没有 DEX（IPA 不适用），此功能仅支持 APK / AAB');
    }

    const dexBuffers = [];
    for (const entry of dexEntries) {
      try {
        dexBuffers.push({ name: entry.name, buffer: zip.readEntry(entry) });
      } catch (_) {
        // 单个 dex 读失败（加密 / 损坏）不该让整次检索失败
      }
    }

    const index = buildSymbolIndex(dexBuffers);
    symbolIndexCache.set(key, index);
    while (symbolIndexCache.size > SYMBOL_CACHE_LIMIT) {
      symbolIndexCache.delete(symbolIndexCache.keys().next().value);
    }
    return index;
  } finally {
    zip.close();
  }
}

/**
 * 在包体的 DEX 里检索类名 / 字符串。
 * @param {string} filePath APK / AAB 路径
 * @param {{query?: string, scope?: 'class'|'string'|'all', limit?: number}} [options]
 */
function searchPackageSymbols(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('请提供包体文件路径');
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  if (!fs.statSync(filePath).isFile()) throw new Error(`不是有效的文件: ${filePath}`);

  const index = loadSymbolIndex(filePath);
  return { file_path: filePath, ...querySymbolIndex(index, options) };
}

module.exports = {
  parsePackageStaticInfo,
  comparePackageInfo,
  searchPackageSymbols,
  buildLaunchCommand,
  inspectPacker,
  SECTION_CATALOG,
  SCHEMA_VERSION,
  SUPPORTED_EXTENSIONS,
  TYPE_LABELS
};
