'use strict';

/**
 * 包体静态信息解析 —— 公共工具
 *
 * 这里只放纯函数：哈希、格式化、二进制读取、字节序处理、OID 映射等。
 * 不依赖任何外部命令行工具，保证完全离线可用。
 */

const crypto = require('crypto');

// ==================== 哈希 ====================

/**
 * @param {Buffer} buffer
 * @param {string} algorithm
 * @param {string} [encoding] 默认 hex；JAR 清单里的摘要用的是 base64。
 */
function hashBuffer(buffer, algorithm, encoding = 'hex') {
  return crypto.createHash(algorithm).update(buffer).digest(encoding);
}

/**
 * 单次流式读取，同时算出 SHA-256 / SHA-1 / MD5 与整体熵值。
 * 避免为计算哈希把上百 MB 的包体整体读入内存。
 */
function computeFileDigests(filePath) {
  const fs = require('fs');
  const hashes = {
    sha256: crypto.createHash('sha256'),
    sha1: crypto.createHash('sha1'),
    md5: crypto.createHash('md5')
  };
  const histogram = new Float64Array(256);
  const chunkSize = 4 * 1024 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  const fd = fs.openSync(filePath, 'r');
  let total = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, chunkSize, null);
      if (read <= 0) break;
      const slice = buffer.subarray(0, read);
      hashes.sha256.update(slice);
      hashes.sha1.update(slice);
      hashes.md5.update(slice);
      for (let i = 0; i < read; i += 1) histogram[slice[i]] += 1;
      total += read;
    }
  } finally {
    fs.closeSync(fd);
  }

  let entropy = 0;
  if (total > 0) {
    for (let i = 0; i < 256; i += 1) {
      if (!histogram[i]) continue;
      const p = histogram[i] / total;
      entropy -= p * Math.log2(p);
    }
  }

  return {
    size: total,
    sha256: hashes.sha256.digest('hex'),
    sha1: hashes.sha1.digest('hex'),
    md5: hashes.md5.digest('hex'),
    entropy: Number(entropy.toFixed(4))
  };
}

// ==================== 格式化 ====================

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 1024) return `${value} B`;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 1 ? 2 : 2)} ${SIZE_UNITS[unit]}`;
}

function formatPercent(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '未知';
  return `${(num * 100).toFixed(digits)}%`;
}

function formatDateTime(input) {
  if (input == null || input === '') return '未知';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateOnly(input) {
  if (input == null || input === '') return '未知';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ==================== 熵值 ====================

/** 香农熵（0~8），用于判断某段数据是否被加密/压缩。 */
function shannonEntropy(buffer) {
  if (!buffer || !buffer.length) return 0;
  const counts = new Array(256).fill(0);
  for (let i = 0; i < buffer.length; i += 1) counts[buffer[i]] += 1;
  let entropy = 0;
  for (let i = 0; i < 256; i += 1) {
    if (!counts[i]) continue;
    const p = counts[i] / buffer.length;
    entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(4));
}

// ==================== 二进制读取 ====================

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readUInt64LE(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset));
}

/** 读取「长度前缀 + 数据」的 uleb128（DEX 使用）。 */
function readUleb128(buffer, offset) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    result |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: cursor };
}

/** 十六进制字符串（用于魔数、指纹等）。 */
function toHex(buffer, separator = '') {
  if (!buffer) return '';
  return Buffer.from(buffer).toString('hex').replace(/(..)(?=.)/g, `$1${separator}`);
}

/** 在缓冲区中查找 ASCII 字符串（大小写敏感）。 */
function indexOfAscii(haystack, needle, start = 0) {
  if (typeof needle === 'string') return haystack.indexOf(needle, start, 'latin1');
  return haystack.indexOf(needle, start);
}

/** 批量查找：任一命中即返回命中项。 */
function findAnyAscii(haystack, needles) {
  const hits = [];
  for (const needle of needles) {
    if (!needle) continue;
    if (indexOfAscii(haystack, needle) >= 0) hits.push(needle);
  }
  return hits;
}

/** 安全地把 Buffer 片段当作 latin1 文本。 */
function bufferToLatin1(buffer, offset, length) {
  return buffer.toString('latin1', offset, offset + length);
}

// ==================== 目录树 / 体积统计 ====================

function buildFileTree(paths) {
  const root = { name: '', path: '', type: 'dir', size: 0, children: [] };
  const index = new Map([['', root]]);

  const sorted = [...paths].sort();
  for (const item of sorted) {
    const segments = item.path.split('/').filter(Boolean);
    let parentPath = '';
    let parent = root;
    for (let i = 0; i < segments.length; i += 1) {
      const isLeaf = i === segments.length - 1;
      const currentPath = parentPath ? `${parentPath}/${segments[i]}` : segments[i];
      let node = index.get(currentPath);
      if (!node) {
        node = {
          name: segments[i],
          path: currentPath,
          type: isLeaf ? 'file' : 'dir',
          size: 0,
          children: []
        };
        index.set(currentPath, node);
        parent.children.push(node);
      }
      if (isLeaf) node.size = item.size || 0;
      parentPath = currentPath;
      parent = node;
    }
  }

  const accumulate = (node) => {
    if (node.type === 'file') return node.size;
    node.size = node.children.reduce((sum, child) => sum + accumulate(child), 0);
    return node.size;
  };
  accumulate(root);
  return root;
}

/** 按「一级目录」聚合体积。 */
function sizeByTopDirectory(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const segments = entry.name.split('/');
    const key = segments.length > 1 ? `${segments[0]}/` : '(根目录)';
    buckets.set(key, (buckets.get(key) || 0) + (entry.size || 0));
  }
  return [...buckets.entries()]
    .map(([name, size]) => ({ name, size, size_human: formatBytes(size) }))
    .sort((a, b) => b.size - a.size);
}

/** 按扩展名聚合体积。 */
function sizeByExtension(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const dot = entry.name.lastIndexOf('.');
    const slash = entry.name.lastIndexOf('/');
    const ext = dot > slash && dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : '(无扩展名)';
    const bucket = buckets.get(ext) || { extension: ext, count: 0, size: 0 };
    bucket.count += 1;
    bucket.size += entry.size || 0;
    buckets.set(ext, bucket);
  }
  return [...buckets.values()]
    .map((item) => ({ ...item, size_human: formatBytes(item.size) }))
    .sort((a, b) => b.size - a.size);
}

/** 按业务类别聚合体积（代码 / 原生库 / 资源 / assets / 其他）。 */
function categorizeEntry(name) {
  const lower = String(name || '').toLowerCase();
  if (/^lib\//.test(lower) || /\.so$/.test(lower) || /\.dylib$/.test(lower)) return '原生库';
  if (/^classes\d*\.dex$/.test(lower) || /\.dex$/.test(lower)) return '代码';
  if (/^res\//.test(lower) || /^resources\.arsc$/.test(lower) || /^androidmanifest\.xml$/.test(lower)) return '资源';
  if (/^assets\//.test(lower)) return 'assets';
  if (/^meta-inf\//.test(lower)) return '签名与元数据';
  if (/^payload\//.test(lower) || /^frameworks\//.test(lower)) return 'iOS 包体';
  return '其他';
}

function sizeByCategory(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const key = categorizeEntry(entry.name);
    buckets.set(key, (buckets.get(key) || 0) + (entry.size || 0));
  }
  return [...buckets.entries()]
    .map(([name, size]) => ({ name, size, size_human: formatBytes(size) }))
    .sort((a, b) => b.size - a.size);
}

/** 找出内容重复的文件（同名同大小同 CRC32）。 */
function findDuplicateFiles(entries, limit = 50) {
  const buckets = new Map();
  for (const entry of entries) {
    if (entry.isDirectory || !entry.size) continue;
    const key = `${entry.crc32}:${entry.size}`;
    const list = buckets.get(key) || [];
    list.push(entry.name);
    buckets.set(key, list);
  }
  const duplicates = [];
  for (const [key, names] of buckets.entries()) {
    if (names.length < 2) continue;
    const [crc32, size] = key.split(':');
    duplicates.push({ crc32, size: Number(size), size_human: formatBytes(Number(size)), files: names });
  }
  duplicates.sort((a, b) => b.size * b.files.length - a.size * a.files.length);
  return duplicates.slice(0, limit);
}

// ==================== OID 映射 ====================

const OID_NAMES = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.2': 'MD2withRSA',
  '1.2.840.113549.1.1.4': 'MD5withRSA',
  '1.2.840.113549.1.1.5': 'SHA1withRSA',
  '1.2.840.113549.1.1.11': 'SHA256withRSA',
  '1.2.840.113549.1.1.12': 'SHA384withRSA',
  '1.2.840.113549.1.1.13': 'SHA512withRSA',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.10045.2.1': 'EC',
  '1.2.840.10045.4.1': 'SHA1withECDSA',
  '1.2.840.10045.4.3.2': 'SHA256withECDSA',
  '1.2.840.10045.4.3.3': 'SHA384withECDSA',
  '1.2.840.10045.4.3.4': 'SHA512withECDSA',
  '1.2.840.10040.4.1': 'DSA',
  '1.2.840.10040.4.3': 'SHA1withDSA',
  '2.16.840.1.101.3.4.3.2': 'SHA256withDSA',
  '1.3.101.112': 'Ed25519',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'street',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.42': 'GN',
  '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.2': 'unstructuredName',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID'
};

function oidName(oid) {
  return OID_NAMES[oid] || oid;
}

const SIGNATURE_ALGORITHMS = {
  0x0101: 'RSASSA-PSS with SHA2-256',
  0x0102: 'RSASSA-PSS with SHA2-512',
  0x0103: 'RSASSA-PKCS1-v1_5 with SHA2-256',
  0x0104: 'RSASSA-PKCS1-v1_5 with SHA2-512',
  0x0201: 'ECDSA with SHA2-256',
  0x0202: 'ECDSA with SHA2-512',
  0x0301: 'DSA with SHA2-256',
  0x0421: 'RSA with SHA2-256 (Verity)',
  0x0423: 'RSA with SHA2-512 (Verity)'
};

function apkSignatureAlgorithmName(id) {
  return SIGNATURE_ALGORITHMS[id] || `未知算法 (0x${Number(id).toString(16)})`;
}

// ==================== 通用小工具 ====================

function unique(list) {
  return [...new Set(list.filter((item) => item !== undefined && item !== null && item !== ''))];
}

function safeArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function truncate(text, max = 160) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** 把 Map 转成按 key 排序的普通对象，便于 JSON 稳定输出。 */
function mapToSortedObject(map) {
  const result = {};
  for (const key of [...map.keys()].sort()) result[key] = map.get(key);
  return result;
}

/**
 * 进度上报助手。
 *
 * 统一 stage / percent / detail 的形状，并把回调里的异常吞掉 —— 进度上报
 * 失败绝不能影响主流程的解析结果。
 *
 * @param {(info: {percent: number, stage: string, detail: string}) => void} [onProgress]
 * @returns {(percent: number, stage: string, detail?: string) => void}
 */
function makeProgressReporter(onProgress) {
  if (typeof onProgress !== 'function') return () => {};
  return (percent, stage, detail) => {
    try {
      onProgress({
        percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
        stage: String(stage || ''),
        detail: detail == null ? '' : String(detail)
      });
    } catch (_) {
      // 进度回调异常不应中断解析
    }
  };
}

/**
 * 解码 UTF-16BE。
 *
 * **Node 的 Buffer 只有 `utf16le`，没有 `utf16be`** ——
 * 直接写 `buffer.toString('utf16be')` 会抛 `Unknown encoding: utf16be`。
 * plist（`bplist` 的 0x6 类型）与 X.509 的 BMPString 都会用到 BE，
 * 之前那两处调用一旦命中就解析失败（plist 那条还会把整个 IPA 解析带崩）。
 *
 * 做法与 `zip.js` 的 BOM 分支一致：两两交换字节后按 utf16le 读。
 */
function decodeUtf16Be(buffer, start = 0, end = buffer.length) {
  const slice = buffer.subarray(start, Math.min(end, buffer.length));
  // swap16() 要求偶数长度，奇数时丢掉末尾那半个字符而不是抛错
  const even = slice.length - (slice.length % 2);
  const swapped = Buffer.from(slice.subarray(0, even));
  swapped.swap16();
  return swapped.toString('utf16le');
}

module.exports = {
  hashBuffer,
  decodeUtf16Be,
  computeFileDigests,
  formatBytes,
  formatPercent,
  formatDateTime,
  formatDateOnly,
  shannonEntropy,
  readUInt16LE,
  readUInt32LE,
  readUInt64LE,
  readUleb128,
  toHex,
  indexOfAscii,
  findAnyAscii,
  bufferToLatin1,
  buildFileTree,
  sizeByTopDirectory,
  sizeByExtension,
  sizeByCategory,
  categorizeEntry,
  findDuplicateFiles,
  oidName,
  apkSignatureAlgorithmName,
  OID_NAMES,
  unique,
  safeArray,
  truncate,
  mapToSortedObject,
  makeProgressReporter
};
