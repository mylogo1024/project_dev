'use strict';

/**
 * 从 Mach-O 提取「反编译级别的元数据」。
 *
 * **为什么需要**：`electron/pkginfo/binary.js` 的 `parseMachO` 只解析 load command，
 * 返回段名、链接库、加密标记这些**摘要信息**，拿不到 section 内容 ——
 * 所以它能告诉你「这个包有没有加密」，但答不了「这个 App 里有哪些类、哪些方法」。
 *
 * 这正是 Android 侧 DEX 检索在做的事。iOS 的对应物就是 Mach-O 的 ObjC/Swift 元数据段：
 *
 *   __objc_classname  → Objective-C 类名
 *   __objc_methname   → Objective-C 方法名
 *   __objc_methtype   → 方法类型签名
 *   __cstring         → C 字符串（常量、URL、密钥常藏在这里）
 *   LC_SYMTAB         → 符号表
 *
 * **注意**：这是「元数据提取」，不是「反汇编」。真正的伪代码还原需要 Hopper / IDA 那类工具，
 * 本项目不做也做不到 —— 所以界面上不要把它说成「反编译成源码」。
 */

// load command
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x2;

// 每个 section 最多提取多少个字符串（避免一个巨大 __cstring 撑爆内存与界面）
const MAX_PER_SECTION = 20000;
// 字符串长度上限，过滤掉明显是二进制垃圾的「超长串」
const MAX_STRING_LENGTH = 512;

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function readCString(buffer, start, end) {
  let cursor = start;
  while (cursor < end && buffer[cursor] !== 0) cursor += 1;
  if (cursor === start) return '';
  return TEXT_DECODER.decode(buffer.subarray(start, cursor));
}

/** 定长 16 字节的 C 字符串字段（segname / sectname）。 */
function readFixedString(buffer, offset, length) {
  let end = offset;
  const limit = Math.min(offset + length, buffer.length);
  while (end < limit && buffer[end] !== 0) end += 1;
  return TEXT_DECODER.decode(buffer.subarray(offset, end));
}

/**
 * 解析所有 section 的元信息。
 * 返回 [{ segname, sectname, offset, size, addr }]
 */
function readSections(buffer, { is64, littleEndian, ncmds, loadCommandsOffset }) {
  const sections = [];
  const read32 = (o) => (littleEndian ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  const read64 = (o) => Number(littleEndian ? buffer.readBigUInt64LE(o) : buffer.readBigUInt64BE(o));

  let cursor = loadCommandsOffset;
  for (let i = 0; i < ncmds; i += 1) {
    if (cursor + 8 > buffer.length) break;
    const cmd = read32(cursor);
    const cmdsize = read32(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > buffer.length) break;

    if (cmd === LC_SEGMENT_64 && is64) {
      const nsects = read32(cursor + 64);
      let sectionOffset = cursor + 72;
      for (let s = 0; s < nsects; s += 1) {
        if (sectionOffset + 80 > cursor + cmdsize) break;
        sections.push({
          sectname: readFixedString(buffer, sectionOffset, 16),
          segname: readFixedString(buffer, sectionOffset + 16, 16),
          addr: read64(sectionOffset + 32),
          size: read64(sectionOffset + 40),
          offset: read32(sectionOffset + 48)
        });
        sectionOffset += 80;
      }
    } else if (cmd === LC_SEGMENT && !is64) {
      const nsects = read32(cursor + 48);
      let sectionOffset = cursor + 56;
      for (let s = 0; s < nsects; s += 1) {
        if (sectionOffset + 68 > cursor + cmdsize) break;
        sections.push({
          sectname: readFixedString(buffer, sectionOffset, 16),
          segname: readFixedString(buffer, sectionOffset + 16, 16),
          addr: read32(sectionOffset + 32),
          size: read32(sectionOffset + 36),
          offset: read32(sectionOffset + 40)
        });
        sectionOffset += 68;
      }
    }

    cursor += cmdsize;
  }

  return sections;
}

/** 从一个 section 里按 NUL 分隔提取字符串。 */
function readSectionStrings(buffer, section, limit = MAX_PER_SECTION) {
  const start = section.offset;
  const size = Math.min(section.size, buffer.length - start);
  if (!Number.isFinite(size) || size <= 0 || start < 0 || start >= buffer.length) return [];

  const end = start + size;
  const out = [];
  let cursor = start;
  while (cursor < end && out.length < limit) {
    const value = readCString(buffer, cursor, end);
    if (value) {
      // 只保留像人写出来的字符串，过滤二进制噪声
      if (value.length <= MAX_STRING_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        out.push(value);
      }
      cursor += Buffer.byteLength(value, 'utf8') + 1;
    } else {
      cursor += 1;
    }
  }
  return out;
}

/** 解析符号表（LC_SYMTAB）。 */
function readSymbols(buffer, { is64, littleEndian, ncmds, loadCommandsOffset }) {
  const read32 = (o) => (littleEndian ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  let cursor = loadCommandsOffset;
  let command = null;

  for (let i = 0; i < ncmds; i += 1) {
    if (cursor + 8 > buffer.length) break;
    const cmd = read32(cursor);
    const cmdsize = read32(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > buffer.length) break;
    if (cmd === LC_SYMTAB) { command = { symoff: read32(cursor + 8), nsyms: read32(cursor + 12), stroff: read32(cursor + 16), strsize: read32(cursor + 20) }; break; }
    cursor += cmdsize;
  }
  if (!command || !command.nsyms) return [];

  const entrySize = is64 ? 16 : 12;
  const strEnd = Math.min(command.stroff + command.strsize, buffer.length);
  const out = [];
  for (let i = 0; i < command.nsyms && out.length < MAX_PER_SECTION; i += 1) {
    const entry = command.symoff + i * entrySize;
    if (entry + entrySize > buffer.length) break;
    const strx = read32(entry);
    const at = command.stroff + strx;
    if (at <= 0 || at >= strEnd) continue;
    const name = readCString(buffer, at, strEnd);
    // 下划线前缀是 Mach-O 的约定，去掉更易读
    if (name && name !== '_') out.push(name.startsWith('__Z') ? name : name.replace(/^_/, ''));
  }
  return out;
}

/** 解析一个 thin Mach-O 的元数据。 */
function extractFromThin(buffer) {
  if (buffer.length < 28) return null;

  const magicLE = buffer.readUInt32LE(0);
  const magicBE = buffer.readUInt32BE(0);
  let is64;
  let littleEndian;
  if (magicLE === 0xfeedfacf) { is64 = true; littleEndian = true; }
  else if (magicLE === 0xfeedface) { is64 = false; littleEndian = true; }
  else if (magicBE === 0xfeedfacf) { is64 = true; littleEndian = false; }
  else if (magicBE === 0xfeedface) { is64 = false; littleEndian = false; }
  else return null;

  const read32 = (o) => (littleEndian ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  const ncmds = read32(16);
  const sizeofcmds = read32(20);
  const headerSize = is64 ? 32 : 28;
  const loadCommandsOffset = headerSize;

  const sections = readSections(buffer, { is64, littleEndian, ncmds, loadCommandsOffset });
  const byName = (name) => sections.filter((s) => s.sectname === name);

  const pick = (names) => names.flatMap((name) => byName(name).flatMap((s) => readSectionStrings(buffer, s)));

  return {
    sections: sections.map((s) => ({ segname: s.segname, sectname: s.sectname, size: s.size })),
    classes: pick(['__objc_classname']),
    methods: pick(['__objc_methname']),
    methodTypes: pick(['__objc_methtype']),
    swiftTypes: pick(['__swift5_reflstr']),
    strings: pick(['__cstring']),
    symbols: readSymbols(buffer, { is64, littleEndian, ncmds, loadCommandsOffset }),
    // sizeofcmds 用于判断 load command 区域是否完整，损坏文件直接放弃
    intact: loadCommandsOffset + sizeofcmds <= buffer.length
  };
}

/**
 * 名称形态过滤。
 *
 * `__objc_methname` 段里除了方法名，还会混进属性类型编码
 * （实测 1488 条里有 145 条形如 `T{CGRect={CGPoint=dd}{CGSize=dd}},N,V_cropRect`）——
 * 那是编译器的元数据，不是方法名，混在结果里会让人以为分析错了。
 *
 * 类名：必须是合法标识符。
 * 方法名：允许 `:`（选择器）与开头的 `.`（`.cxx_destruct` 这类编译器生成的方法）。
 */
const VALID_CLASS_NAME = /^[A-Za-z_$][\w$]*$/;
const VALID_METHOD_NAME = /^[A-Za-z_$.][\w$:]*$/;

const filterNames = (list, pattern) => list.filter((name) => pattern.test(name));

const uniqSorted = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b, 'en'));

/**
 * 提取 Mach-O 元数据。支持 thin 与 fat（通用二进制，会合并各架构后去重）。
 * @param {Buffer} buffer
 * @returns {{classes:string[],methods:string[],methodTypes:string[],swiftTypes:string[],strings:string[],symbols:string[],sections:Array,architectures:number}}
 */
function extractMachoSymbols(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 28) return null;

  const magic = buffer.readUInt32BE(0);
  const merged = { sections: [], classes: [], methods: [], methodTypes: [], swiftTypes: [], strings: [], symbols: [], architectures: 0 };

  // fat / universal：magic 是 0xCAFEBABE（大端）
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const nfat = buffer.readUInt32BE(4);
    if (!nfat || nfat > 16) return null;
    for (let i = 0; i < nfat; i += 1) {
      const entry = 8 + i * 20;
      if (entry + 20 > buffer.length) break;
      const offset = buffer.readUInt32BE(entry + 8);
      const size = buffer.readUInt32BE(entry + 12);
      if (offset + size > buffer.length || size < 28) continue;
      const parsed = extractFromThin(buffer.subarray(offset, offset + size));
      if (!parsed) continue;
      merged.architectures += 1;
      merged.sections.push(...parsed.sections);
      merged.classes.push(...parsed.classes);
      merged.methods.push(...parsed.methods);
      merged.methodTypes.push(...parsed.methodTypes);
      merged.swiftTypes.push(...parsed.swiftTypes);
      merged.strings.push(...parsed.strings);
      merged.symbols.push(...parsed.symbols);
    }
  } else {
    const parsed = extractFromThin(buffer);
    if (!parsed) return null;
    if (!parsed.intact) return null;
    merged.architectures = 1;
    merged.sections = parsed.sections;
    merged.classes = parsed.classes;
    merged.methods = parsed.methods;
    merged.methodTypes = parsed.methodTypes;
    merged.swiftTypes = parsed.swiftTypes;
    merged.strings = parsed.strings;
    merged.symbols = parsed.symbols;
  }

  if (!merged.architectures) return null;

  return {
    architectures: merged.architectures,
    sections: merged.sections,
    classes: uniqSorted(filterNames(merged.classes, VALID_CLASS_NAME)),
    methods: uniqSorted(filterNames(merged.methods, VALID_METHOD_NAME)),
    methodTypes: uniqSorted(merged.methodTypes),
    swiftTypes: uniqSorted(merged.swiftTypes),
    strings: uniqSorted(merged.strings),
    symbols: uniqSorted(merged.symbols)
  };
}

module.exports = {
  MAX_PER_SECTION,
  extractMachoSymbols,
  readSectionStrings
};
