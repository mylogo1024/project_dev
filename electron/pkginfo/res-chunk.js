'use strict';

/**
 * Android 资源二进制块（ResChunk）公共解析
 *
 * 二进制 XML（AXML）与 resources.arsc 共用同一套「块 + 字符串池 + 类型化值」结构，
 * 这里抽出公共部分，避免重复实现。
 */

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const FLAG_SORTED = 1 << 0;
const FLAG_UTF8 = 1 << 8;

/** Res_value 数据类型 */
const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_DIMENSION = 0x05;
const TYPE_FRACTION = 0x06;
const TYPE_DYNAMIC_REFERENCE = 0x07;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const TYPE_INT_COLOR_ARGB8 = 0x1c;
const TYPE_INT_COLOR_RGB8 = 0x1d;
const TYPE_INT_COLOR_ARGB4 = 0x1e;
const TYPE_INT_COLOR_RGB4 = 0x1f;

/** 读一个 ResChunk_header。 */
function readChunkHeader(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  return {
    type: buffer.readUInt16LE(offset),
    headerSize: buffer.readUInt16LE(offset + 2),
    size: buffer.readUInt32LE(offset + 4),
    offset
  };
}

/** 遍历某个容器块内部的所有子块。 */
function* iterateChunks(buffer, start, end) {
  let cursor = start;
  const limit = Math.min(end, buffer.length);
  while (cursor + 8 <= limit) {
    const header = readChunkHeader(buffer, cursor);
    if (!header || header.size < 8) return;
    yield header;
    const next = cursor + header.size;
    if (next <= cursor) return;
    cursor = next;
  }
}

/** 解析字符串池块，返回字符串数组与元信息。 */
function parseStringPool(buffer, offset) {
  const header = readChunkHeader(buffer, offset);
  if (!header || header.type !== RES_STRING_POOL_TYPE) {
    return { strings: [], flags: 0, utf8: false, stringCount: 0, styleCount: 0, size: 0 };
  }

  const stringCount = buffer.readUInt32LE(offset + 8);
  const styleCount = buffer.readUInt32LE(offset + 12);
  const flags = buffer.readUInt32LE(offset + 16);
  const stringsStart = buffer.readUInt32LE(offset + 20);
  const utf8 = (flags & FLAG_UTF8) !== 0;

  const offsetsStart = offset + header.headerSize;
  const stringsBase = offset + stringsStart;

  const strings = [];
  for (let i = 0; i < stringCount; i += 1) {
    const itemOffset = offsetsStart + i * 4;
    if (itemOffset + 4 > buffer.length) break;
    const relative = buffer.readUInt32LE(itemOffset);
    const absolute = stringsBase + relative;
    if (absolute >= buffer.length) {
      strings.push('');
      continue;
    }
    try {
      strings.push(utf8 ? readUtf8String(buffer, absolute) : readUtf16String(buffer, absolute));
    } catch (_) {
      strings.push('');
    }
  }

  return {
    strings,
    flags,
    utf8,
    sorted: (flags & FLAG_SORTED) !== 0,
    stringCount,
    styleCount,
    size: header.size
  };
}

function readUtf8String(buffer, offset) {
  let cursor = offset;
  let length = buffer[cursor];
  cursor += 1;
  if (length & 0x80) {
    length = ((length & 0x7f) << 8) | buffer[cursor];
    cursor += 1;
  }
  let byteLength = buffer[cursor];
  cursor += 1;
  if (byteLength & 0x80) {
    byteLength = ((byteLength & 0x7f) << 8) | buffer[cursor];
    cursor += 1;
  }
  return buffer.toString('utf8', cursor, cursor + byteLength);
}

function readUtf16String(buffer, offset) {
  let cursor = offset;
  let length = buffer.readUInt16LE(cursor);
  cursor += 2;
  if (length & 0x8000) {
    length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(cursor);
    cursor += 2;
  }
  return buffer.toString('utf16le', cursor, cursor + length * 2);
}

/** 解析一个 Res_value（8 字节：size(2) res0(1) dataType(1) data(4)）。 */
function readResValue(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  return {
    size: buffer.readUInt16LE(offset),
    res0: buffer[offset + 2],
    dataType: buffer[offset + 3],
    data: buffer.readUInt32LE(offset + 4)
  };
}

/** 把 Res_value 转成可读文本，字符串类型需要传入字符串池。 */
function resValueToString(value, stringPool) {
  if (!value) return null;
  switch (value.dataType) {
    case TYPE_NULL:
      return null;
    case TYPE_STRING:
      return stringPool ? (stringPool.strings[value.data] ?? '') : `@string/0x${value.data.toString(16)}`;
    case TYPE_INT_DEC:
      return String(value.data | 0);
    case TYPE_INT_HEX:
      return `0x${(value.data >>> 0).toString(16)}`;
    case TYPE_INT_BOOLEAN:
      return value.data !== 0 ? 'true' : 'false';
    case TYPE_REFERENCE:
      return `@ref/0x${(value.data >>> 0).toString(16).padStart(8, '0')}`;
    case TYPE_ATTRIBUTE:
      return `?attr/0x${(value.data >>> 0).toString(16).padStart(8, '0')}`;
    case TYPE_FLOAT: {
      const scratch = Buffer.alloc(4);
      scratch.writeUInt32LE(value.data >>> 0);
      return String(scratch.readFloatLE(0));
    }
    case TYPE_INT_COLOR_ARGB8:
    case TYPE_INT_COLOR_RGB8:
    case TYPE_INT_COLOR_ARGB4:
    case TYPE_INT_COLOR_RGB4:
      return `#${(value.data >>> 0).toString(16).padStart(8, '0')}`;
    default:
      return String(value.data >>> 0);
  }
}

/** 把 Res_value 归一化成结构化对象（便于前端渲染与导出）。 */
function resValueToObject(value, stringPool) {
  if (!value) return null;
  const text = resValueToString(value, stringPool);
  const object = {
    data_type: `0x${value.dataType.toString(16).padStart(2, '0')}`,
    data: value.data >>> 0,
    text
  };
  if (value.dataType === TYPE_REFERENCE) {
    object.reference = value.data >>> 0;
    object.reference_hex = `0x${(value.data >>> 0).toString(16).padStart(8, '0')}`;
  }
  return object;
}

/** 把资源 ID 拆成 package / type / entry 三段。 */
function splitResourceId(resId) {
  const id = resId >>> 0;
  return {
    packageId: (id >> 24) & 0xff,
    typeId: (id >> 16) & 0xff,
    entryId: id & 0xffff,
    hex: `0x${id.toString(16).padStart(8, '0')}`
  };
}

module.exports = {
  RES_STRING_POOL_TYPE,
  RES_XML_TYPE,
  RES_XML_START_NAMESPACE_TYPE,
  RES_XML_END_NAMESPACE_TYPE,
  RES_XML_START_ELEMENT_TYPE,
  RES_XML_END_ELEMENT_TYPE,
  RES_XML_CDATA_TYPE,
  RES_XML_RESOURCE_MAP_TYPE,
  RES_TABLE_TYPE,
  RES_TABLE_PACKAGE_TYPE,
  RES_TABLE_TYPE_TYPE,
  RES_TABLE_TYPE_SPEC_TYPE,
  TYPE_NULL,
  TYPE_REFERENCE,
  TYPE_ATTRIBUTE,
  TYPE_STRING,
  TYPE_FLOAT,
  TYPE_DIMENSION,
  TYPE_FRACTION,
  TYPE_INT_DEC,
  TYPE_INT_HEX,
  TYPE_INT_BOOLEAN,
  readChunkHeader,
  iterateChunks,
  parseStringPool,
  readResValue,
  resValueToString,
  resValueToObject,
  splitResourceId
};
