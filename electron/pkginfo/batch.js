'use strict';

/**
 * 批量包体扫描
 *
 * 场景：测试同学拿到一个目录，里面有几十个 APK / IPA，需要一次性过一遍
 * 版本、体积、权限、SDK、风险分。逐个点开显然不现实。
 *
 * 这里负责三件事：
 *   1. 收集目录下的包体（可递归）
 *   2. 逐个交给解析器，实时上报「第 N / 共 M 个」
 *   3. 把结果压成扁平表格，供前端渲染与导出 CSV
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_EXTENSIONS = new Set(['.apk', '.aab', '.ipa']);
const DEFAULT_LIMIT = 500;

/** 递归（或仅当前层）收集目录下的包体文件。 */
function collectPackages(dirPath, options = {}) {
  const { recursive = true, limit = DEFAULT_LIMIT } = options;
  const found = [];
  const stack = [dirPath];

  while (stack.length && found.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!PACKAGE_EXTENSIONS.has(ext)) continue;

      let size = 0;
      let mtime = null;
      try {
        const stat = fs.statSync(full);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch (_) { /* 读不到就留空 */ }

      found.push({
        path: full,
        name: entry.name,
        type: ext.slice(1).toUpperCase(),
        size,
        modified_at: mtime
      });
    }
  }

  found.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return found;
}

/** 把一份完整解析结果压成一行表格数据。 */
function summarizePackage(info, meta = {}) {
  const basic = info?.basic || {};
  const detailed = info?.detailed || {};
  const app = basic.app || {};
  const file = basic.file || {};
  const signature = basic.signature || {};
  const structure = basic.structure || {};
  const risk = basic.risk || {};
  const sdks = detailed['2.14']?.sdks || [];
  const hardening = detailed['2.17'] || {};
  const native = detailed['2.11'] || {};
  const permissions = detailed['2.6']?.requested || [];

  return {
    name: file.name || meta.name || '',
    path: info?.file_path || meta.path || '',
    type: String(file.type || meta.type || '').toUpperCase(),
    size: file.size || meta.size || 0,
    size_human: file.size_human || '',
    app_name: app.name || '',
    identifier: app.identifier || '',
    version_name: app.version_name || '',
    version_code: app.version_code ?? '',
    min_os: app.min_os || '',
    target_os: app.target_os || '',
    abis: Array.isArray(app.abis) ? app.abis.join(' / ') : '',
    dex_count: structure.dex_count ?? 0,
    so_count: structure.so_count ?? 0,
    permission_count: structure.permission_count ?? permissions.length,
    dangerous_permission_count: structure.dangerous_permission_count ?? 0,
    component_count: structure.component_count ?? 0,
    exported_component_count: structure.exported_component_count ?? 0,
    sdk_count: sdks.length || structure.sdk_count || 0,
    sdk_names: sdks.slice(0, 8).map((item) => item.sdk_name).filter(Boolean).join(' / '),
    packed: structure.packed ?? hardening.packed ?? false,
    packed_by: structure.packed_by || hardening.packer_name || '',
    obfuscated: structure.obfuscated ?? '',
    signed: signature.signed ?? false,
    signature_type: signature.type || '',
    signature_sha256: signature.sha256 || '',
    signature_debug: signature.debug ?? null,
    signature_expired: signature.expired ?? null,
    risk_score: risk.score ?? 0,
    risk_level: risk.level || '',
    risk_label: risk.level_label || '',
    risk_critical: risk.critical ?? 0,
    risk_high: risk.high ?? 0,
    risk_medium: risk.medium ?? 0,
    risk_low: risk.low ?? 0,
    native_arch: Array.isArray(native.abis) ? native.abis.join(' / ') : '',
    elapsed_ms: info?.elapsed_ms ?? 0,
    warning_count: (info?.warnings || []).length,
    scanned_at: new Date().toISOString(),
    error: ''
  };
}

/** 解析失败时的占位行，保证表格里能看到「哪个包失败了、为什么」。 */
function failureRow(meta, error) {
  return {
    name: meta?.name || '',
    path: meta?.path || '',
    type: String(meta?.type || '').toUpperCase(),
    size: meta?.size || 0,
    size_human: '',
    app_name: '',
    identifier: '',
    version_name: '',
    version_code: '',
    min_os: '',
    target_os: '',
    abis: '',
    dex_count: 0,
    so_count: 0,
    permission_count: 0,
    dangerous_permission_count: 0,
    component_count: 0,
    exported_component_count: 0,
    sdk_count: 0,
    sdk_names: '',
    packed: false,
    packed_by: '',
    obfuscated: '',
    signed: false,
    signature_type: '',
    signature_sha256: '',
    signature_debug: null,
    signature_expired: null,
    risk_score: 0,
    risk_level: '',
    risk_label: '',
    risk_critical: 0,
    risk_high: 0,
    risk_medium: 0,
    risk_low: 0,
    native_arch: '',
    elapsed_ms: 0,
    warning_count: 0,
    scanned_at: new Date().toISOString(),
    error: error?.message || String(error)
  };
}

/** 表格列定义（顺序即导出 CSV 的列顺序）。 */
const BATCH_COLUMNS = [
  { key: 'name', title: '文件名' },
  { key: 'type', title: '类型' },
  { key: 'app_name', title: '应用名' },
  { key: 'identifier', title: '包名 / Bundle ID' },
  { key: 'version_name', title: '版本' },
  { key: 'version_code', title: '版本号' },
  { key: 'size_human', title: '体积' },
  { key: 'min_os', title: '最低系统' },
  { key: 'abis', title: '架构' },
  { key: 'dex_count', title: 'DEX 数' },
  { key: 'so_count', title: 'SO 数' },
  { key: 'permission_count', title: '权限数' },
  { key: 'dangerous_permission_count', title: '危险权限' },
  { key: 'component_count', title: '组件数' },
  { key: 'exported_component_count', title: '导出组件' },
  { key: 'sdk_count', title: 'SDK 数' },
  { key: 'sdk_names', title: '主要 SDK' },
  { key: 'packed_by', title: '加固' },
  { key: 'obfuscated', title: '混淆' },
  { key: 'signature_type', title: '签名方式' },
  { key: 'risk_score', title: '风险分' },
  { key: 'risk_label', title: '风险等级' },
  { key: 'error', title: '解析错误' }
];

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 行数组 → CSV 文本（带 UTF-8 BOM，Excel 打开不乱码）。 */
function toCsv(rows, columns = BATCH_COLUMNS) {
  const header = columns.map((column) => csvCell(column.title)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(','));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

/** 行数组 → Markdown 表格（方便直接贴到缺陷单 / 群里）。 */
function toMarkdown(rows, columns = BATCH_COLUMNS) {
  const header = `| ${columns.map((column) => column.title).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column.key] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function createBatchScanner({ parseOne }) {
  /**
   * 扫描一个目录下的所有包体。
   *
   * @param {object} payload
   * @param {string} payload.directory 目标目录
   * @param {boolean} [payload.recursive=true] 是否递归子目录
   * @param {number} [payload.limit=500] 最多扫描多少个
   * @param {(info: object) => void} [payload.onItem] 每解析完一个回调
   * @param {(info: object) => void} [payload.onProgress] 进度回调
   * @param {{aborted?: boolean}} [payload.signal] 中断信号
   */
  async function scan(payload = {}) {
    const directory = String(payload.directory || '').trim();
    if (!directory) throw new Error('请选择要扫描的目录');
    if (!fs.existsSync(directory)) throw new Error(`目录不存在: ${directory}`);
    if (!fs.statSync(directory).isDirectory()) throw new Error(`不是目录: ${directory}`);

    const startedAt = Date.now();
    const files = collectPackages(directory, {
      recursive: payload.recursive !== false,
      limit: Number(payload.limit) > 0 ? Number(payload.limit) : DEFAULT_LIMIT
    });

    if (!files.length) {
      return {
        directory,
        total: 0,
        succeeded: 0,
        failed: 0,
        rows: [],
        elapsed_ms: Date.now() - startedAt
      };
    }

    const rows = [];
    let succeeded = 0;
    let failed = 0;

    for (let index = 0; index < files.length; index += 1) {
      if (payload.signal?.aborted) break;
      const file = files[index];
      const base = Math.round((index / files.length) * 100);

      payload.onProgress?.({
        percent: base,
        index: index + 1,
        total: files.length,
        stage: `正在解析 ${file.name}`,
        detail: file.path
      });

      try {
        const info = await parseOne(file.path, {
          onProgress: (progress) => payload.onProgress?.({
            percent: Math.min(99, base + Math.round((progress.percent || 0) / files.length)),
            index: index + 1,
            total: files.length,
            stage: `${file.name} · ${progress.stage}`,
            detail: file.path
          })
        });
        const row = summarizePackage(info, file);
        rows.push(row);
        succeeded += 1;
        payload.onItem?.(row);
      } catch (error) {
        const row = failureRow(file, error);
        rows.push(row);
        failed += 1;
        payload.onItem?.(row);
      }

      payload.onProgress?.({
        percent: Math.round(((index + 1) / files.length) * 100),
        index: index + 1,
        total: files.length,
        stage: `已完成 ${index + 1}/${files.length}`,
        detail: file.path
      });
    }

    return {
      directory,
      total: files.length,
      succeeded,
      failed,
      rows,
      elapsed_ms: Date.now() - startedAt
    };
  }

  return { scan, collectPackages, summarizePackage };
}

module.exports = {
  createBatchScanner,
  collectPackages,
  summarizePackage,
  failureRow,
  toCsv,
  toMarkdown,
  BATCH_COLUMNS,
  PACKAGE_EXTENSIONS
};
