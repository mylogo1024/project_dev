'use strict';

/**
 * ZIP 容器读取器
 *
 * 只读中央目录（central directory），按需解压单个条目，避免把上百 MB 的
 * APK/IPA 整个读进内存。支持 ZIP64、数据描述符、注释、加密标记。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** DOS 时间戳 → Date */
function dosDateTimeToDate(dosTime, dosDate) {
  if (!dosDate) return null;
  const day = dosDate & 0x1f;
  const month = (dosDate >> 5) & 0x0f;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const seconds = (dosTime & 0x1f) * 2;
  const minutes = (dosTime >> 5) & 0x3f;
  const hours = (dosTime >> 11) & 0x1f;
  if (!month || !day) return null;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/** 解析 extra field，取出 ZIP64 扩展信息。 */
function parseZip64Extra(extra, entry) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const dataSize = extra.readUInt16LE(cursor + 2);
    const dataStart = cursor + 4;
    if (headerId === 0x0001) {
      let offset = dataStart;
      if (entry.uncompressedSize === 0xffffffff && offset + 8 <= dataStart + dataSize) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(offset));
        offset += 8;
      }
      if (entry.compressedSize === 0xffffffff && offset + 8 <= dataStart + dataSize) {
        entry.compressedSize = Number(extra.readBigUInt64LE(offset));
        offset += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && offset + 8 <= dataStart + dataSize) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(offset));
      }
    }
    cursor = dataStart + dataSize;
  }
}

/**
 * 把 ZIP 条目名安全地拼到目标目录下，阻止 zip-slip 目录穿越。
 * 同时把反斜杠统一成 `/`，兼容 Windows 打包出来的畸形条目名。
 */
function safeJoin(destination, entryName) {
  const normalized = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(destination, normalized);
  const root = path.resolve(destination);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`条目路径越界，已阻止写入: ${entryName}`);
  }
  return target;
}

/** 从 ZIP 的 external attributes 还原 Unix 权限位（高 16 位）。 */
function unixModeFromEntry(entry) {
  const madeByUnix = ((entry.versionMadeBy >> 8) & 0xff) === 3;
  if (!madeByUnix) return null;
  const mode = (entry.externalAttrs >>> 16) & 0xffff;
  return mode ? mode & 0o7777 : null;
}

/**
 * 按 BOM 把一段字节解成文本（UTF-8 / UTF-16LE / UTF-16BE）。
 *
 * **只认 BOM，不猜无 BOM 的 UTF-16** —— 调用方除了文本还会拿它读二进制条目
 * （测试里就有把 classes.dex 当文本读的用法），靠「很多 0x00」这类启发式判断
 * 会把二进制误当 UTF-16 解成乱码，得不偿失。
 */
function decodeTextBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString('utf16le', 2);
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE：去掉 BOM 后两两交换字节，再按 utf16le 读
    const body = bytes.subarray(2);
    // swap16() 要求字节数为偶数；文件被截断成奇数长度时它会直接抛
    // ERR_INVALID_BUFFER_SIZE，这里丢掉末尾那半个字符而不是让整次读取失败
    const even = body.length - (body.length % 2);
    const swapped = Buffer.from(body.subarray(0, even));
    swapped.swap16();
    return swapped.toString('utf16le');
  }

  // UTF-8 BOM 必须去掉：留着的话返回的字符串首字符是 U+FEFF，
  // 会让 JSON.parse、按首行匹配（如 APK 的 MANIFEST.MF）这类下游处理莫名其妙地失败
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return bytes.toString('utf8', start);
}

class ZipArchive {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.fileSize = fs.fstatSync(this.fd).size;
    this.entries = [];
    this.comment = '';
    this.zipVersion = null;
    this.zip64 = false;
    this.centralDirectoryOffset = 0;
    this.centralDirectorySize = 0;
    this.encryptedEntries = 0;
    this._read();
  }

  _readRange(offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const chunk = fs.readSync(this.fd, buffer, read, length - read, offset + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  }

  _locateEocd() {
    const maxTail = Math.min(this.fileSize, 0xffff + 22 + 1024);
    const tailStart = this.fileSize - maxTail;
    const tail = this._readRange(tailStart, maxTail);
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength > tail.length) continue;
      return { offset: tailStart + i, tail, index: i };
    }
    return null;
  }

  _read() {
    if (this.fileSize < 22) throw new Error('文件过小，不是有效的 ZIP 容器');

    const eocd = this._locateEocd();
    if (!eocd) throw new Error('未找到 ZIP 结束记录（EOCD），文件可能已损坏或不是 ZIP 容器');

    const { tail, index } = eocd;
    let entryCount = tail.readUInt16LE(index + 10);
    let cdSize = tail.readUInt32LE(index + 12);
    let cdOffset = tail.readUInt32LE(index + 16);
    this.comment = tail.toString('utf8', index + 22, index + 22 + tail.readUInt16LE(index + 20));

    // ZIP64：优先读取 ZIP64 EOCD
    const locatorOffset = index - 20;
    if (locatorOffset >= 0 && tail.readUInt32LE(locatorOffset) === SIG_EOCD64_LOCATOR) {
      const eocd64Offset = Number(tail.readBigUInt64LE(locatorOffset + 8));
      const eocd64 = this._readRange(eocd64Offset, 56);
      if (eocd64.length >= 56 && eocd64.readUInt32LE(0) === SIG_EOCD64) {
        this.zip64 = true;
        entryCount = Number(eocd64.readBigUInt64LE(32));
        cdSize = Number(eocd64.readBigUInt64LE(40));
        cdOffset = Number(eocd64.readBigUInt64LE(48));
      }
    }

    this.centralDirectoryOffset = cdOffset;
    this.centralDirectorySize = cdSize;
    this.zipVersion = { entryCount, centralDirectorySize: cdSize, centralDirectoryOffset: cdOffset };

    const directory = this._readRange(cdOffset, cdSize);
    let cursor = 0;
    while (cursor + 46 <= directory.length) {
      if (directory.readUInt32LE(cursor) !== SIG_CENTRAL) break;

      const versionMadeBy = directory.readUInt16LE(cursor + 4);
      const versionNeeded = directory.readUInt16LE(cursor + 6);
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const modTime = directory.readUInt16LE(cursor + 12);
      const modDate = directory.readUInt16LE(cursor + 14);
      const crc32 = directory.readUInt32LE(cursor + 16);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const internalAttrs = directory.readUInt16LE(cursor + 36);
      const externalAttrs = directory.readUInt32LE(cursor + 38);
      const localHeaderOffset = directory.readUInt32LE(cursor + 42);

      const nameBuffer = directory.subarray(cursor + 46, cursor + 46 + nameLength);
      const utf8Flag = (flags & 0x0800) !== 0;
      const name = utf8Flag ? nameBuffer.toString('utf8') : nameBuffer.toString('utf8');
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const comment = directory.subarray(
        cursor + 46 + nameLength + extraLength,
        cursor + 46 + nameLength + extraLength + commentLength
      ).toString('utf8');

      const entry = {
        name,
        name_raw: nameBuffer,
        isDirectory: name.endsWith('/'),
        versionMadeBy,
        versionNeeded,
        flags,
        method,
        methodName: method === METHOD_STORE ? 'store' : (method === METHOD_DEFLATE ? 'deflate' : `method-${method}`),
        crc32: crc32 >>> 0,
        crc32_hex: (crc32 >>> 0).toString(16).padStart(8, '0'),
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        comment,
        internalAttrs,
        externalAttrs,
        isEncrypted: (flags & 0x0001) !== 0,
        hasDataDescriptor: (flags & 0x0008) !== 0,
        modifiedAt: dosDateTimeToDate(modTime, modDate),
        dosTime: modTime,
        dosDate: modDate,
        platform: (versionMadeBy >> 8) & 0xff
      };

      parseZip64Extra(extra, entry);
      entry.size = entry.uncompressedSize;
      entry.ratio = entry.uncompressedSize > 0
        ? 1 - entry.compressedSize / entry.uncompressedSize
        : 0;

      if (entry.isEncrypted) this.encryptedEntries += 1;
      this.entries.push(entry);

      cursor += 46 + nameLength + extraLength + commentLength;
    }

    this.entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按名称查条目。 */
  find(name) {
    return this.entries.find((entry) => entry.name === name) || null;
  }

  /** 按正则匹配条目。 */
  match(pattern) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    return this.entries.filter((entry) => regex.test(entry.name));
  }

  /** 读取并解压单个条目。 */
  readEntry(target) {
    const entry = typeof target === 'string' ? this.find(target) : target;
    if (!entry) throw new Error(`ZIP 中不存在条目: ${target}`);
    return this.readEntryRaw(entry);
  }

  readEntryRaw(entry) {
    if (entry.isDirectory) return Buffer.alloc(0);
    if (entry.isEncrypted) throw new Error(`条目已加密，无法读取: ${entry.name}`);

    const localHeader = this._readRange(entry.localHeaderOffset, 30);
    if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`条目本地头无效: ${entry.name}`);
    }
    const localNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;

    let size = entry.compressedSize;
    if (!size && entry.uncompressedSize && entry.method === METHOD_STORE) {
      size = entry.uncompressedSize;
    }
    const raw = this._readRange(dataOffset, size);

    if (entry.method === METHOD_STORE) return raw;
    if (entry.method === METHOD_DEFLATE) {
      try {
        return zlib.inflateRawSync(raw);
      } catch (error) {
        throw new Error(`条目解压失败: ${entry.name}（${error.message}）`);
      }
    }
    throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`);
  }

  /**
   * 读取条目并做文本解码，自动识别 BOM（UTF-8 / UTF-16LE / UTF-16BE）。
   */
  readEntryText(target) {
    return decodeTextBuffer(this.readEntry(target));
  }

  close() {
    if (this.fd != null) {
      try { fs.closeSync(this.fd); } catch (_) { /* 忽略 */ }
      this.fd = null;
    }
  }

  /**
   * 把整个压缩包解压到目标目录 —— 纯 JS 实现，跨平台（Windows 上无需 unzip）。
   *
   * @param {string} destination 目标目录，不存在时自动创建
   * @param {object} [options]
   * @param {(info: {percent: number, done: number, total: number, name: string}) => void} [options.onProgress]
   * @param {{aborted?: boolean}} [options.signal] 轮询式中断信号
   * @param {(entry: object) => boolean} [options.filter] 只解压匹配的条目
   * @returns {{files: number, bytes: number, skipped: number}}
   */
  extractTo(destination, options = {}) {
    const { onProgress, signal, filter } = options;
    const root = path.resolve(destination);
    fs.mkdirSync(root, { recursive: true });

    const candidates = this.entries.filter((entry) => !entry.isDirectory && (!filter || filter(entry)));
    const total = candidates.length;
    let done = 0;
    let bytes = 0;
    let skipped = 0;

    for (const entry of candidates) {
      if (signal?.aborted) throw new Error('解压已取消');

      const target = safeJoin(root, entry.name);
      if (entry.isEncrypted) {
        skipped += 1;
        done += 1;
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const buffer = this.readEntryRaw(entry);
      fs.writeFileSync(target, buffer);
      bytes += buffer.length;

      // 还原 Unix 可执行位（iOS 的 Mach-O 主二进制需要它才能在设备上运行）
      const mode = unixModeFromEntry(entry);
      if (mode && process.platform !== 'win32') {
        try { fs.chmodSync(target, mode); } catch (_) { /* 权限位失败不影响解压 */ }
      }

      done += 1;
      if (onProgress) {
        onProgress({
          percent: total ? Math.round((done / total) * 100) : 100,
          done,
          total,
          name: entry.name
        });
      }
    }

    return { files: done, bytes, skipped };
  }
}

function openZip(filePath) {
  return new ZipArchive(filePath);
}

module.exports = {
  ZipArchive,
  openZip,
  decodeTextBuffer,
  dosDateTimeToDate,
  safeJoin,
  unixModeFromEntry,
  METHOD_STORE,
  METHOD_DEFLATE
};
