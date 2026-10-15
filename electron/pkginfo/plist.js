const { decodeUtf16Be } = require('./util');
'use strict';

/**
 * Property List 解析（二进制 bplist + XML plist）
 *
 * 纯 JS 实现，不依赖 plutil，保证 Windows / Linux 上同样可用。
 */

const APPLE_EPOCH_OFFSET = 978307200; // 2001-01-01T00:00:00Z 相对 Unix 的秒数

// ==================== 二进制 plist ====================

function readBEInt(buffer, offset, byteCount) {
  let value = 0n;
  for (let i = 0; i < byteCount; i += 1) value = (value << 8n) | BigInt(buffer[offset + i]);
  return value;
}

function parseBinaryPlist(buffer) {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 6) !== 'bplist') {
    throw new Error('不是二进制 plist');
  }
  const trailerStart = buffer.length - 32;
  if (trailerStart < 8) throw new Error('二进制 plist 长度不足');

  const offsetIntSize = buffer[trailerStart + 6];
  const objectRefSize = buffer[trailerStart + 7];
  const numObjects = Number(readBEInt(buffer, trailerStart + 8, 8));
  const topObject = Number(readBEInt(buffer, trailerStart + 16, 8));
  const offsetTableOffset = Number(readBEInt(buffer, trailerStart + 24, 8));

  if (!offsetIntSize || !objectRefSize || numObjects <= 0) throw new Error('二进制 plist 尾部信息无效');

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i += 1) {
    const at = offsetTableOffset + i * offsetIntSize;
    if (at + offsetIntSize > buffer.length) break;
    offsets[i] = Number(readBEInt(buffer, at, offsetIntSize));
  }

  const memo = new Map();

  const parseLength = (info, cursor) => {
    if (info < 0x0f) return { length: info, next: cursor };
    const marker = buffer[cursor];
    if (marker >> 4 !== 0x1) throw new Error('plist 长度字段格式异常');
    const byteCount = 1 << (marker & 0x0f);
    return { length: Number(readBEInt(buffer, cursor + 1, byteCount)), next: cursor + 1 + byteCount };
  };

  const parseObject = (index, depth = 0) => {
    if (index == null || index < 0 || index >= numObjects || depth > 64) return null;
    if (memo.has(index)) return memo.get(index);
    const offset = offsets[index];
    if (offset == null || offset >= buffer.length) return null;

    const marker = buffer[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;
    let value = null;

    switch (type) {
      case 0x0:
        if (info === 0x8) value = false;
        else if (info === 0x9) value = true;
        else value = null;
        break;
      case 0x1: {
        const byteCount = 1 << info;
        value = Number(readBEInt(buffer, offset + 1, byteCount));
        break;
      }
      case 0x2: {
        const byteCount = 1 << info;
        value = byteCount === 4 ? buffer.readFloatBE(offset + 1) : buffer.readDoubleBE(offset + 1);
        break;
      }
      case 0x3: {
        const seconds = buffer.readDoubleBE(offset + 1);
        value = new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
        break;
      }
      case 0x4: {
        const { length, next } = parseLength(info, offset + 1);
        value = Buffer.from(buffer.subarray(next, next + length));
        break;
      }
      case 0x5: {
        const { length, next } = parseLength(info, offset + 1);
        value = buffer.toString('utf8', next, next + length);
        break;
      }
      case 0x6: {
        const { length, next } = parseLength(info, offset + 1);
        // Node 没有 utf16be 编码，必须手动换字节（见 util.decodeUtf16Be 的说明）
        value = decodeUtf16Be(buffer, next, next + length * 2);
        break;
      }
      case 0x7: {
        const { length, next } = parseLength(info, offset + 1);
        value = buffer.toString('utf8', next, next + length);
        break;
      }
      case 0x8: {
        const byteCount = info + 1;
        value = Number(readBEInt(buffer, offset + 1, byteCount));
        break;
      }
      case 0xa:
      case 0xb:
      case 0xc: {
        const { length, next } = parseLength(info, offset + 1);
        const array = [];
        memo.set(index, array);
        for (let i = 0; i < length; i += 1) {
          const refAt = next + i * objectRefSize;
          if (refAt + objectRefSize > buffer.length) break;
          const ref = Number(readBEInt(buffer, refAt, objectRefSize));
          array.push(parseObject(ref, depth + 1));
        }
        return array;
      }
      case 0xd: {
        const { length, next } = parseLength(info, offset + 1);
        const object = {};
        memo.set(index, object);
        for (let i = 0; i < length; i += 1) {
          const keyAt = next + i * objectRefSize;
          const valueAt = next + (length + i) * objectRefSize;
          if (valueAt + objectRefSize > buffer.length) break;
          const keyRef = Number(readBEInt(buffer, keyAt, objectRefSize));
          const valueRef = Number(readBEInt(buffer, valueAt, objectRefSize));
          const key = parseObject(keyRef, depth + 1);
          object[String(key)] = parseObject(valueRef, depth + 1);
        }
        return object;
      }
      default:
        value = null;
    }

    memo.set(index, value);
    return value;
  };

  return parseObject(topObject);
}

// ==================== XML plist ====================

/** 极简 XML plist 解析器（覆盖 dict/array/string/integer/real/date/data/true/false）。 */
function parseXmlPlist(text) {
  let pos = 0;
  const len = text.length;

  const skipPrologAndWhitespace = () => {
    for (;;) {
      while (pos < len && /\s/.test(text[pos])) pos += 1;
      if (text.startsWith('<?', pos)) {
        const end = text.indexOf('?>', pos);
        pos = end < 0 ? len : end + 2;
        continue;
      }
      if (text.startsWith('<!--', pos)) {
        const end = text.indexOf('-->', pos);
        pos = end < 0 ? len : end + 3;
        continue;
      }
      if (text.startsWith('<!', pos)) {
        const end = text.indexOf('>', pos);
        pos = end < 0 ? len : end + 1;
        continue;
      }
      return;
    }
  };

  const readTag = () => {
    skipPrologAndWhitespace();
    if (pos >= len || text[pos] !== '<') return null;
    const end = text.indexOf('>', pos);
    if (end < 0) return null;
    let raw = text.slice(pos + 1, end);
    pos = end + 1;
    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);
    const name = raw.trim().split(/[\s/]/)[0];
    if (!name) return null;
    return { name, selfClosing };
  };

  const readTextUntil = (tagName) => {
    const close = `</${tagName}>`;
    const end = text.indexOf(close, pos);
    if (end < 0) {
      const rest = text.slice(pos);
      pos = len;
      return decodeXmlEntities(rest);
    }
    const raw = text.slice(pos, end);
    pos = end + close.length;
    return decodeXmlEntities(raw);
  };

  const parseValue = () => {
    const tag = readTag();
    if (!tag) return null;

    switch (tag.name) {
      case 'plist': {
        if (tag.selfClosing) return null;
        const inner = parseValue();
        readTag(); // 吃掉 </plist>
        return inner;
      }
      case 'dict': {
        if (tag.selfClosing) return {};
        const object = {};
        for (;;) {
          const keyTag = readTag();
          if (!keyTag) break;
          if (keyTag.name === '/dict') break;
          if (keyTag.name !== 'key') {
            if (!keyTag.selfClosing) readTextUntil(keyTag.name);
            continue;
          }
          const key = readTextUntil('key');
          object[key] = parseValue();
        }
        return object;
      }
      case 'array': {
        if (tag.selfClosing) return [];
        const array = [];
        for (;;) {
          const save = pos;
          const next = readTag();
          if (!next) break;
          if (next.name === '/array') break;
          pos = save;
          array.push(parseValue());
        }
        return array;
      }
      case 'string':
        return tag.selfClosing ? '' : readTextUntil('string');
      case 'key':
        return tag.selfClosing ? '' : readTextUntil('key');
      case 'integer': {
        if (tag.selfClosing) return 0;
        const raw = readTextUntil('integer').trim();
        const parsed = Number.parseInt(raw, 10);
        return Number.isNaN(parsed) ? raw : parsed;
      }
      case 'real':
        return tag.selfClosing ? 0 : Number.parseFloat(readTextUntil('real'));
      case 'true':
        if (!tag.selfClosing) readTextUntil('true');
        return true;
      case 'false':
        if (!tag.selfClosing) readTextUntil('false');
        return false;
      case 'date': {
        if (tag.selfClosing) return null;
        const raw = readTextUntil('date').trim();
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? raw : date;
      }
      case 'data': {
        if (tag.selfClosing) return Buffer.alloc(0);
        const raw = readTextUntil('data').replace(/\s+/g, '');
        return Buffer.from(raw, 'base64');
      }
      default:
        if (!tag.selfClosing) readTextUntil(tag.name);
        return null;
    }
  };

  return parseValue();
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** 统一入口。 */
function parsePlist(buffer) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 6) === 'bplist') {
    return parseBinaryPlist(buffer);
  }
  const text = buffer.toString('utf8');
  const start = text.indexOf('<plist');
  const snippet = start >= 0 ? text.slice(start) : text;
  return parseXmlPlist(snippet);
}

// ==================== plist 值辅助 ====================

/** 取字符串（兼容 plist 的多语言 dict 形式）。 */
function plistString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return plistString(value[0]);
  if (typeof value === 'object') {
    if (value['#text'] != null) return String(value['#text']);
  }
  return '';
}

/** 取字符串数组。 */
function plistStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => plistString(item)).filter(Boolean);
  const single = plistString(value);
  return single ? [single] : [];
}

/** 取布尔。 */
function plistBool(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).toLowerCase();
  if (text === 'true' || text === 'yes' || text === '1') return true;
  if (text === 'false' || text === 'no' || text === '0') return false;
  return fallback;
}

/** 取数字。 */
function plistNumber(value, fallback = null) {
  if (value == null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

module.exports = {
  APPLE_EPOCH_OFFSET,
  parseBinaryPlist,
  parseXmlPlist,
  parsePlist,
  plistString,
  plistStringArray,
  plistBool,
  plistNumber,
  decodeXmlEntities
};
