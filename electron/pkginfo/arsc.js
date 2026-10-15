'use strict';

/**
 * resources.arsc（ResTable）解析器
 *
 * 采用「索引 + 惰性读取」策略：只建立类型块索引与配置清单，具体条目值按需读取，
 * 避免为几十万条资源建立大对象图。
 *
 * 提供的能力：
 *  - 类型名称、资源数量、语言/密度清单
 *  - 资源 ID 解析（含 @ref 追链），用于取应用名、图标路径
 *  - 按类型 + 条目 ID 收集所有配置变体（用于挑最高密度图标）
 */

const {
  RES_STRING_POOL_TYPE,
  RES_TABLE_TYPE,
  RES_TABLE_PACKAGE_TYPE,
  RES_TABLE_TYPE_TYPE,
  RES_TABLE_TYPE_SPEC_TYPE,
  TYPE_REFERENCE,
  TYPE_STRING,
  readChunkHeader,
  parseStringPool,
  readResValue,
  resValueToString,
  splitResourceId
} = require('./res-chunk');

const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;

const FLAG_COMPLEX = 0x0001;

const DENSITY_NAMES = {
  0: 'default',
  120: 'ldpi',
  160: 'mdpi',
  213: 'tvdpi',
  240: 'hdpi',
  280: '280dpi',
  320: 'xhdpi',
  360: '360dpi',
  400: '400dpi',
  420: '420dpi',
  440: '440dpi',
  480: 'xxhdpi',
  560: '560dpi',
  640: 'xxxhdpi',
  65534: 'anydpi',
  65535: 'nodpi'
};

function densityLabel(density) {
  if (density == null) return 'default';
  return DENSITY_NAMES[density] || `${density}dpi`;
}

/** 解包 2 字节语言/地区编码（支持 3 字母压缩编码）。 */
function unpackLanguageOrRegion(raw, base) {
  const first = raw & 0xff;
  const second = (raw >> 8) & 0xff;
  if (first & 0x80) {
    return String.fromCharCode(
      base + (second & 0x1f),
      base + ((second & 0xe0) >> 5) + ((first & 0x03) << 3),
      base + ((first & 0x7c) >> 2)
    );
  }
  return String.fromCharCode(first, second).replace(/\0/g, '');
}

/** 解析 ResTable_config 中我们关心的字段。 */
function parseConfig(buffer, offset) {
  if (offset + 4 > buffer.length) return { size: 0, key: 'default' };
  const size = buffer.readUInt32LE(offset);
  const config = {
    size,
    mcc: buffer.readUInt16LE(offset + 4),
    mnc: buffer.readUInt16LE(offset + 6),
    language: unpackLanguageOrRegion(buffer.readUInt16LE(offset + 8), 'a'),
    country: unpackLanguageOrRegion(buffer.readUInt16LE(offset + 10), '0'),
    orientation: buffer[offset + 12],
    touchscreen: buffer[offset + 13],
    density: buffer.readUInt16LE(offset + 14),
    keyboard: buffer[offset + 16],
    navigation: buffer[offset + 17],
    inputFlags: buffer[offset + 18],
    screenWidth: buffer.readUInt16LE(offset + 20),
    screenHeight: buffer.readUInt16LE(offset + 22),
    sdkVersion: buffer.readUInt16LE(offset + 24),
    minorVersion: buffer.readUInt16LE(offset + 26),
    screenLayout: buffer[offset + 28],
    uiMode: buffer[offset + 29],
    smallestScreenWidthDp: buffer.readUInt16LE(offset + 30),
    screenWidthDp: buffer.readUInt16LE(offset + 32),
    screenHeightDp: buffer.readUInt16LE(offset + 34)
  };

  const parts = [];
  if (config.language) parts.push(config.country ? `${config.language}-r${config.country}` : config.language);
  if (config.density) parts.push(densityLabel(config.density));
  if (config.sdkVersion) parts.push(`v${config.sdkVersion}`);
  if (config.orientation === 1) parts.push('port');
  if (config.orientation === 2) parts.push('land');
  if (config.uiMode & 0x0f) parts.push(`night-${(config.uiMode & 0x0f) === 2 ? 'yes' : 'no'}`);
  if (config.smallestScreenWidthDp) parts.push(`sw${config.smallestScreenWidthDp}dp`);
  if (config.screenWidthDp) parts.push(`w${config.screenWidthDp}dp`);

  config.key = parts.length ? parts.join('-') : 'default';
  config.locale = config.language ? (config.country ? `${config.language}-${config.country}` : config.language) : '';
  return config;
}

class ArscTable {
  constructor(buffer) {
    this.buffer = buffer;
    this.headerSize = 0;
    this.packageCount = 0;
    this.globalStrings = { strings: [], stringCount: 0 };
    this.packages = [];
    this._parse();
  }

  _parse() {
    const buffer = this.buffer;
    const header = readChunkHeader(buffer, 0);
    if (!header || header.type !== RES_TABLE_TYPE) {
      throw new Error('resources.arsc 头无效');
    }
    this.headerSize = header.headerSize;
    this.packageCount = header.headerSize >= 12 ? buffer.readUInt32LE(8) : 0;

    let cursor = header.headerSize;
    const end = Math.min(header.size || buffer.length, buffer.length);

    while (cursor + 8 <= end) {
      const chunk = readChunkHeader(buffer, cursor);
      if (!chunk || chunk.size < 8) break;

      if (chunk.type === RES_STRING_POOL_TYPE) {
        this.globalStrings = parseStringPool(buffer, cursor);
      } else if (chunk.type === RES_TABLE_PACKAGE_TYPE) {
        this.packages.push(this._parsePackage(cursor, chunk));
      }
      cursor += chunk.size;
    }
  }

  _parsePackage(packageOffset, header) {
    const buffer = this.buffer;
    const id = buffer.readUInt32LE(packageOffset + 8);
    const name = buffer.toString('utf16le', packageOffset + 12, packageOffset + 12 + 256)
      .replace(/\0.*$/, '');
    const typeStringsOffset = buffer.readUInt32LE(packageOffset + 268);
    const keyStringsOffset = buffer.readUInt32LE(packageOffset + 276);

    const typePool = parseStringPool(buffer, packageOffset + typeStringsOffset);
    const keyPool = parseStringPool(buffer, packageOffset + keyStringsOffset);

    const pkg = {
      id,
      name,
      idHex: `0x${id.toString(16).padStart(2, '0')}`,
      typeStrings: typePool.strings,
      keyStrings: keyPool.strings,
      typeChunks: [],
      typeSpecs: [],
      _offset: packageOffset
    };

    let cursor = packageOffset + header.headerSize;
    const end = Math.min(packageOffset + header.size, buffer.length);
    while (cursor + 8 <= end) {
      const chunk = readChunkHeader(buffer, cursor);
      if (!chunk || chunk.size < 8) break;

      if (chunk.type === RES_TABLE_TYPE_SPEC_TYPE) {
        pkg.typeSpecs.push({
          typeId: buffer[cursor + 8],
          entryCount: buffer.readUInt32LE(cursor + 12)
        });
      } else if (chunk.type === RES_TABLE_TYPE_TYPE) {
        const typeId = buffer[cursor + 8];
        const flags = buffer[cursor + 9];
        const entryCount = buffer.readUInt32LE(cursor + 12);
        const entriesStart = buffer.readUInt32LE(cursor + 16);
        const config = parseConfig(buffer, cursor + 20);
        const typeChunk = {
          offset: cursor,
          size: chunk.size,
          typeId,
          flags,
          entryCount,
          entriesStart,
          entriesBase: cursor + entriesStart,
          config,
          typeName: typePool.strings[typeId - 1] || `type${typeId}`,
          pkg
        };
        pkg.typeChunks.push(typeChunk);
      }
      cursor += chunk.size;
    }

    return pkg;
  }

  get primaryPackage() {
    return this.packages[0] || null;
  }

  /** 类型统计：名称 + 条目数 + 配置变体数。 */
  get typeStats() {
    const stats = new Map();
    for (const pkg of this.packages) {
      for (const chunk of pkg.typeChunks) {
        const key = `${pkg.id}:${chunk.typeId}`;
        const item = stats.get(key) || {
          packageId: pkg.id,
          typeId: chunk.typeId,
          name: chunk.typeName,
          entryCount: 0,
          configCount: 0
        };
        item.entryCount = Math.max(item.entryCount, chunk.entryCount);
        item.configCount += 1;
        stats.set(key, item);
      }
    }
    return [...stats.values()].sort((a, b) => b.entryCount - a.entryCount);
  }

  /** 资源总数（按最大 entryCount 求和，避免多语言重复计数）。 */
  get resourceCount() {
    return this.typeStats.reduce((sum, item) => sum + item.entryCount, 0);
  }

  /** 全部语言列表。 */
  get locales() {
    const set = new Set();
    for (const pkg of this.packages) {
      for (const chunk of pkg.typeChunks) {
        if (chunk.config.locale) set.add(chunk.config.locale);
      }
    }
    return [...set].sort();
  }

  /** 全部密度列表。 */
  get densities() {
    const set = new Set();
    for (const pkg of this.packages) {
      for (const chunk of pkg.typeChunks) {
        if (chunk.config.density) set.add(densityLabel(chunk.config.density));
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  /** 读取指定类型块中某个条目 ID 的值。 */
  _readEntry(chunk, entryId) {
    const buffer = this.buffer;
    if (entryId >= chunk.entryCount) return null;

    let entryDataOffset = -1;
    if (chunk.flags & FLAG_SPARSE) {
      // 稀疏表：entryCount 个 (idx:uint16, offset:uint16) 对，按 idx 升序
      for (let i = 0; i < chunk.entryCount; i += 1) {
        const base = chunk.offset + chunk.entriesStart - chunk.entryCount * 4 + i * 4;
        if (base + 4 > buffer.length) break;
        if (buffer.readUInt16LE(base) === entryId) {
          entryDataOffset = chunk.entriesBase + buffer.readUInt16LE(base + 2) * 4;
          break;
        }
      }
    } else if (chunk.flags & FLAG_OFFSET16) {
      const base = chunk.offset + chunk.entriesStart - chunk.entryCount * 2 + entryId * 2;
      if (base + 2 > buffer.length) return null;
      const value = buffer.readUInt16LE(base);
      if (value !== 0xffff) entryDataOffset = chunk.entriesBase + value * 4;
    } else {
      const base = chunk.offset + chunk.entriesStart - chunk.entryCount * 4 + entryId * 4;
      if (base + 4 > buffer.length) return null;
      const value = buffer.readUInt32LE(base);
      if (value !== 0xffffffff) entryDataOffset = chunk.entriesBase + value;
    }
    if (entryDataOffset < 0 || entryDataOffset + 8 > buffer.length) return null;

    const entrySize = buffer.readUInt16LE(entryDataOffset);
    const entryFlags = buffer.readUInt16LE(entryDataOffset + 2);
    const keyIndex = buffer.readUInt32LE(entryDataOffset + 4);
    const result = {
      entryId,
      entrySize,
      entryFlags,
      key: chunk.pkg ? chunk.pkg.keyStrings[keyIndex] : undefined,
      config: chunk.config,
      isComplex: (entryFlags & FLAG_COMPLEX) !== 0,
      value: null,
      valueText: null,
      parent: null,
      mapCount: 0
    };

    if (result.isComplex) {
      result.parent = buffer.readUInt32LE(entryDataOffset + 8);
      result.mapCount = buffer.readUInt32LE(entryDataOffset + 12);
      return result;
    }

    const value = readResValue(buffer, entryDataOffset + entrySize);
    result.value = value;
    result.valueText = resValueToString(value, this.globalStrings);
    return result;
  }

  /** 按 typeId + entryId 收集所有配置变体。 */
  collectVariants(typeId, entryId, packageId = null) {
    const variants = [];
    for (const pkg of this.packages) {
      if (packageId != null && pkg.id !== packageId) continue;
      for (const chunk of pkg.typeChunks) {
        if (chunk.typeId !== typeId) continue;
        const entry = this._readEntry(chunk, entryId);
        if (!entry) continue;
        variants.push({
          config: chunk.config.key,
          locale: chunk.config.locale,
          density: chunk.config.density,
          densityLabel: densityLabel(chunk.config.density),
          sdkVersion: chunk.config.sdkVersion,
          typeName: chunk.typeName,
          key: entry.key,
          valueText: entry.valueText,
          valueType: entry.value ? entry.value.dataType : null,
          isComplex: entry.isComplex
        });
      }
    }
    return variants;
  }

  /**
   * 解析资源 ID。
   * @param {number} resId
   * @param {{followReference?: boolean, depth?: number}} options
   */
  resolve(resId, options = {}) {
    const { followReference = true, depth = 0 } = options;
    const { packageId, typeId, entryId, hex } = splitResourceId(resId);
    if (!resId || depth > 6) return null;

    let fallback = null;
    for (const pkg of this.packages) {
      if (packageId && pkg.id !== packageId) continue;
      for (const chunk of pkg.typeChunks) {
        if (chunk.typeId !== typeId) continue;
        const entry = this._readEntry(chunk, entryId);
        if (!entry) continue;

        const resolved = {
          resId: resId >>> 0,
          resIdHex: hex,
          typeName: chunk.typeName,
          entryKey: entry.key,
          config: chunk.config.key,
          valueText: entry.valueText,
          valueType: entry.value ? entry.value.dataType : null,
          isComplex: entry.isComplex
        };

        if (entry.value && entry.value.dataType === TYPE_REFERENCE && followReference) {
          const target = this.resolve(entry.value.data, { followReference, depth: depth + 1 });
          if (target) {
            resolved.target = target;
            if (target.valueText) resolved.valueText = target.valueText;
          }
        }

        const isDefaultConfig = !chunk.config.locale && !chunk.config.density;
        if (isDefaultConfig) return resolved;
        if (!fallback) fallback = resolved;
      }
    }
    return fallback;
  }

  /** 便捷方法：把资源 ID 解析成纯文本。 */
  resolveText(resId) {
    const resolved = this.resolve(resId);
    return resolved ? resolved.valueText : null;
  }

  /** 取某个类型的字符串资源（用于多语言应用名）。 */
  collectStringResources(typeId = 0x01) {
    const result = [];
    for (const pkg of this.packages) {
      for (const chunk of pkg.typeChunks) {
        if (chunk.typeId !== typeId) continue;
        for (let entryId = 0; entryId < chunk.entryCount; entryId += 1) {
          const entry = this._readEntry(chunk, entryId);
          if (!entry || entry.isComplex || !entry.value) continue;
          if (entry.value.dataType !== TYPE_STRING) continue;
          result.push({
            entryId,
            key: entry.key,
            locale: chunk.config.locale,
            value: entry.valueText
          });
        }
      }
    }
    return result;
  }

  get versionLabel() {
    return this.headerSize >= 12 ? 'v2（含 packageCount）' : `headerSize=${this.headerSize}`;
  }
}

function parseArsc(buffer) {
  return new ArscTable(buffer);
}

module.exports = {
  ArscTable,
  parseArsc,
  parseConfig,
  densityLabel,
  unpackLanguageOrRegion,
  DENSITY_NAMES
};
