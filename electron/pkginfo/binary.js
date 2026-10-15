'use strict';

/**
 * 可执行体解析：DEX / ELF / Mach-O / Protocol Buffers
 *
 * 全部为只读解析，遇到不认识的结构会安全返回部分结果，不会抛异常中断整体流程。
 */

const { readUleb128, formatBytes } = require('./util');

// ==================== DEX ====================

const DEX_HEADER_SIZE = 112;

function isDex(buffer) {
  return Boolean(buffer) && buffer.length >= 8 && buffer.toString('latin1', 0, 4) === 'dex\n';
}

function readDexString(buffer, offset) {
  if (offset <= 0 || offset >= buffer.length) return '';
  const { next } = readUleb128(buffer, offset);
  const end = buffer.indexOf(0, next);
  return buffer.toString('utf8', next, end < 0 ? buffer.length : end);
}

/** 解析 DEX 头与计数。 */
function parseDexHeader(buffer) {
  if (!isDex(buffer)) return null;
  const version = buffer.toString('latin1', 4, 7).replace(/\0/g, '');
  return {
    version,
    checksum: buffer.readUInt32LE(8),
    signature: buffer.toString('hex', 12, 32),
    file_size: buffer.readUInt32LE(32),
    header_size: buffer.readUInt32LE(36),
    endian_tag: buffer.readUInt32LE(40).toString(16),
    string_ids_size: buffer.readUInt32LE(56),
    string_ids_off: buffer.readUInt32LE(60),
    type_ids_size: buffer.readUInt32LE(64),
    type_ids_off: buffer.readUInt32LE(68),
    proto_ids_size: buffer.readUInt32LE(72),
    proto_ids_off: buffer.readUInt32LE(76),
    field_ids_size: buffer.readUInt32LE(80),
    field_ids_off: buffer.readUInt32LE(84),
    method_ids_size: buffer.readUInt32LE(88),
    method_ids_off: buffer.readUInt32LE(92),
    class_defs_size: buffer.readUInt32LE(96),
    class_defs_off: buffer.readUInt32LE(100),
    data_size: buffer.readUInt32LE(104),
    data_off: buffer.readUInt32LE(108)
  };
}

/** 读取 DEX 字符串池（用于 URL / 特征串提取）。 */
function readDexStrings(buffer, limit = 200000) {
  const header = parseDexHeader(buffer);
  if (!header) return [];
  const strings = [];
  const count = Math.min(header.string_ids_size, limit);
  for (let i = 0; i < count; i += 1) {
    const offset = header.string_ids_off + i * 4;
    if (offset + 4 > buffer.length) break;
    const value = readDexString(buffer, buffer.readUInt32LE(offset));
    if (value) strings.push(value);
  }
  return strings;
}

/** 读取前 N 个类名（用于混淆程度判断）。 */
function readDexClassNames(buffer, limit = 3000) {
  const header = parseDexHeader(buffer);
  if (!header) return [];
  const names = [];
  const count = Math.min(header.class_defs_size, limit);
  for (let i = 0; i < count; i += 1) {
    const classDefOffset = header.class_defs_off + i * 32;
    if (classDefOffset + 32 > buffer.length) break;
    const classIdx = buffer.readUInt32LE(classDefOffset);
    if (classIdx >= header.type_ids_size) continue;
    const typeOffset = header.type_ids_off + classIdx * 4;
    if (typeOffset + 4 > buffer.length) continue;
    const descriptorIdx = buffer.readUInt32LE(typeOffset);
    if (descriptorIdx >= header.string_ids_size) continue;
    const stringOffset = header.string_ids_off + descriptorIdx * 4;
    if (stringOffset + 4 > buffer.length) continue;
    const name = readDexString(buffer, buffer.readUInt32LE(stringOffset));
    if (name) names.push(name);
  }
  return names;
}

/** 判断类名是否「被混淆」（如 La/a;、Lb1;）。 */
function isObfuscatedClassName(name) {
  const match = /^L([^/;]+)(?:\/.*)?;$/.exec(name);
  if (!match) return false;
  const segment = match[1];
  if (/^(android|androidx|kotlin|java|javax|org|com)$/.test(segment)) return false;
  return /^[a-zA-Z]{1,3}[0-9]{0,3}$/.test(segment) && segment.length <= 4;
}

/** 综合 DEX 信息。 */
function analyzeDexFiles(dexBuffers) {
  const files = [];
  let totalMethods = 0;
  let totalClasses = 0;
  let totalFields = 0;
  let totalStrings = 0;
  let totalTypes = 0;
  let totalProtos = 0;
  const classNames = [];

  for (const item of dexBuffers) {
    const header = parseDexHeader(item.buffer);
    if (!header) continue;
    files.push({
      name: item.name,
      size: item.buffer.length,
      size_human: formatBytes(item.buffer.length),
      version: header.version,
      checksum: header.checksum,
      signature_sha1: header.signature,
      method_count: header.method_ids_size,
      class_count: header.class_defs_size,
      field_count: header.field_ids_size,
      string_count: header.string_ids_size,
      type_count: header.type_ids_size,
      proto_count: header.proto_ids_size,
      data_size: header.data_size
    });
    totalMethods += header.method_ids_size;
    totalClasses += header.class_defs_size;
    totalFields += header.field_ids_size;
    totalStrings += header.string_ids_size;
    totalTypes += header.type_ids_size;
    totalProtos += header.proto_ids_size;
    if (classNames.length < 3000) {
      classNames.push(...readDexClassNames(item.buffer, 3000 - classNames.length));
    }
  }

  const obfuscatedCount = classNames.filter(isObfuscatedClassName).length;
  const shortClassRatio = classNames.length ? obfuscatedCount / classNames.length : 0;

  return {
    dex_count: files.length,
    dex_files: files,
    multidex: files.length > 1,
    main_dex: files.length ? files[0].name : null,
    total_size: files.reduce((sum, file) => sum + file.size, 0),
    method_count: totalMethods,
    class_count: totalClasses,
    field_count: totalFields,
    string_count: totalStrings,
    type_count: totalTypes,
    proto_count: totalProtos,
    method_limit_usage: Number((totalMethods / 65536).toFixed(4)),
    multidex_required: totalMethods > 65536,
    short_class_ratio: Number(shortClassRatio.toFixed(4)),
    obfuscated: shortClassRatio >= 0.3,
    sample_class_names: classNames.slice(0, 40),
    class_name_sample_size: classNames.length
  };
}

// ==================== ELF ====================

const ELF_MACHINES = {
  0x03: 'x86',
  0x08: 'MIPS',
  0x28: 'ARM',
  0x32: 'IA-64',
  0x3e: 'x86-64',
  0xb7: 'AArch64',
  0xf3: 'RISC-V'
};

const ELF_TYPES = {
  0: 'NONE',
  1: 'REL',
  2: 'EXEC',
  3: 'DYN (PIE / 共享库)',
  4: 'CORE'
};

const ELF_OSABI = {
  0: 'System V',
  1: 'HP-UX',
  2: 'NetBSD',
  3: 'Linux',
  6: 'Solaris',
  9: 'FreeBSD',
  12: 'OpenBSD'
};

const PT_GNU_STACK = 0x6474e551;
const PT_GNU_RELRO = 0x6474e552;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;

const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const SHT_DYNSYM = 11;

const DT_NEEDED = 1;
const DT_SONAME = 14;
const DT_RPATH = 15;
const DT_RUNPATH = 29;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_FLAGS_1 = 0x6ffffffb;

function isElf(buffer) {
  return Boolean(buffer) && buffer.length >= 20
    && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46;
}

function readElfString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return '';
  const end = buffer.indexOf(0, offset);
  return buffer.toString('utf8', offset, end < 0 ? buffer.length : end);
}

/** 解析 ELF（.so / 可执行文件）。 */
function parseElf(buffer) {
  if (!isElf(buffer)) return null;
  const bits = buffer[4] === 2 ? 64 : 32;
  const littleEndian = buffer[5] !== 2;
  const is64 = bits === 64;

  const read16 = (offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const read32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const read64 = (offset) => Number(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));

  const eType = read16(16);
  const eMachine = read16(18);
  const ePhoff = is64 ? read64(32) : read32(28);
  const eShoff = is64 ? read64(40) : read32(32);
  const ePhentsize = read16(is64 ? 54 : 42);
  const ePhnum = read16(is64 ? 56 : 44);
  const eShentsize = read16(is64 ? 58 : 46);
  const eShnum = read16(is64 ? 60 : 48);
  const eShstrndx = read16(is64 ? 62 : 50);

  // ---- 程序头 ----
  const programHeaders = [];
  let hasGnuStack = false;
  let stackExecutable = false;
  let hasRelro = false;
  let hasLoad = false;
  let dynamicVaddr = null;
  let dynamicSize = 0;
  let dynamicFileOffset = null;

  for (let i = 0; i < ePhnum; i += 1) {
    const offset = ePhoff + i * ePhentsize;
    if (offset + ePhentsize > buffer.length) break;
    const pType = read32(offset);
    const pFlags = is64 ? read32(offset + 4) : read32(offset + 24);
    const pOffset = is64 ? read64(offset + 8) : read32(offset + 4);
    const pVaddr = is64 ? read64(offset + 16) : read32(offset + 8);
    const pFilesz = is64 ? read64(offset + 32) : read32(offset + 16);

    programHeaders.push({
      type: `0x${pType.toString(16)}`,
      type_name: pType === PT_LOAD ? 'LOAD' : (pType === PT_DYNAMIC ? 'DYNAMIC' : (pType === PT_GNU_STACK ? 'GNU_STACK' : (pType === PT_GNU_RELRO ? 'GNU_RELRO' : 'OTHER'))),
      flags: pFlags,
      offset: pOffset,
      vaddr: pVaddr,
      filesz: pFilesz,
      executable: (pFlags & 0x1) !== 0,
      writable: (pFlags & 0x2) !== 0
    });

    if (pType === PT_GNU_STACK) {
      hasGnuStack = true;
      stackExecutable = (pFlags & 0x1) !== 0;
    }
    if (pType === PT_GNU_RELRO) hasRelro = true;
    if (pType === PT_LOAD) hasLoad = true;
    if (pType === PT_DYNAMIC) {
      dynamicVaddr = pVaddr;
      dynamicSize = pFilesz;
      dynamicFileOffset = pOffset;
    }
  }

  // ---- 节头 ----
  const sections = [];
  for (let i = 0; i < eShnum; i += 1) {
    const offset = eShoff + i * eShentsize;
    if (offset + eShentsize > buffer.length) break;
    sections.push({
      index: i,
      name_offset: read32(offset),
      type: read32(offset + 4),
      flags: is64 ? read64(offset + 8) : read32(offset + 8),
      addr: is64 ? read64(offset + 16) : read32(offset + 12),
      offset: is64 ? read64(offset + 24) : read32(offset + 16),
      size: is64 ? read64(offset + 32) : read32(offset + 20),
      link: read32(is64 ? offset + 40 : offset + 24),
      entsize: is64 ? read64(offset + 56) : read32(offset + 36)
    });
  }

  // 节名
  if (eShstrndx < sections.length) {
    const strSection = sections[eShstrndx];
    for (const section of sections) {
      section.name = readElfString(buffer, strSection.offset + section.name_offset);
    }
  }

  // ---- 动态段：依赖库 / SONAME / RPATH ----
  const dependencies = [];
  let soname = '';
  let rpath = '';
  let runpath = '';
  let flags1 = 0;

  const dynamicSection = sections.find((section) => section.type === SHT_DYNAMIC)
    || sections.find((section) => section.name === '.dynamic');
  let dynamicEntries = [];
  if (dynamicSection) {
    const strSection = sections[dynamicSection.link] || sections.find((section) => section.name === '.dynstr');
    const strtabOffset = strSection ? strSection.offset : 0;
    const entrySize = is64 ? 16 : 8;
    const count = entrySize ? Math.floor(dynamicSection.size / entrySize) : 0;
    for (let i = 0; i < count; i += 1) {
      const offset = dynamicSection.offset + i * entrySize;
      if (offset + entrySize > buffer.length) break;
      const tag = is64 ? read64(offset) : read32(offset);
      const value = is64 ? read64(offset + 8) : read32(offset + 4);
      dynamicEntries.push({ tag, value });
      if (tag === 0) break;
      if (tag === DT_NEEDED) dependencies.push(readElfString(buffer, strtabOffset + value));
      else if (tag === DT_SONAME) soname = readElfString(buffer, strtabOffset + value);
      else if (tag === DT_RPATH) rpath = readElfString(buffer, strtabOffset + value);
      else if (tag === DT_RUNPATH) runpath = readElfString(buffer, strtabOffset + value);
      else if (tag === DT_FLAGS_1) flags1 = value;
    }
  }

  // ---- 符号表：栈保护探测 ----
  const symbolNames = [];
  for (const section of sections) {
    if (section.type !== SHT_SYMTAB && section.type !== SHT_DYNSYM) continue;
    const strSection = sections[section.link];
    if (!strSection) continue;
    const entrySize = section.entsize || (is64 ? 24 : 16);
    const count = entrySize ? Math.floor(section.size / entrySize) : 0;
    for (let i = 0; i < count; i += 1) {
      const offset = section.offset + i * entrySize;
      if (offset + entrySize > buffer.length) break;
      const nameOffset = read32(offset);
      const name = readElfString(buffer, strSection.offset + nameOffset);
      if (name) symbolNames.push(name);
    }
  }

  const hasSymtab = sections.some((section) => section.type === SHT_SYMTAB && section.size > 0);
  const canary = symbolNames.includes('__stack_chk_fail')
    || symbolNames.includes('__stack_chk_guard')
    || buffer.includes(Buffer.from('__stack_chk_fail', 'latin1'));

  const dtFlags1Pie = (flags1 & 0x08000000) !== 0; // DF_1_PIE

  return {
    arch: ELF_MACHINES[eMachine] || `unknown(0x${eMachine.toString(16)})`,
    machine: eMachine,
    bits,
    endian: littleEndian ? 'little' : 'big',
    type: ELF_TYPES[eType] || `unknown(${eType})`,
    type_code: eType,
    os_abi: ELF_OSABI[buffer[7]] || `unknown(${buffer[7]})`,
    is_library: eType === 3,
    dependencies,
    dependency_count: dependencies.length,
    soname,
    rpath: rpath || runpath || '',
    section_count: sections.length,
    program_header_count: programHeaders.length,
    sections: sections.map((section) => ({ name: section.name, type: section.type, size: section.size })),
    program_headers: programHeaders,
    symbol_count: symbolNames.length,
    stripped: !hasSymtab,
    security: {
      pie: eType === 3 || dtFlags1Pie,
      nx: hasGnuStack ? !stackExecutable : null,
      canary: Boolean(canary),
      relro: hasRelro,
      relro_full: hasRelro && programHeaders.some((header) => header.type_name === 'GNU_RELRO'),
      bind_now: (flags1 & 0x1) !== 0
    },
    has_load_segment: hasLoad,
    dynamic_offset: dynamicFileOffset,
    dynamic_size: dynamicSize,
    dynamic_vaddr: dynamicVaddr,
    dynamic_entries: dynamicEntries.length
  };
}

// ==================== Mach-O ====================

const MACHO_CPU_TYPES = {
  7: 'x86',
  0x01000007: 'x86_64',
  12: 'arm',
  0x0100000c: 'arm64',
  0x0200000c: 'arm64_32',
  18: 'ppc',
  0x01000012: 'ppc64'
};

/** arm64 的子类型细分（arm64e 走的是 cpusubtype）。 */
function machoArchLabel(cputype, cpusubtype) {
  const base = MACHO_CPU_TYPES[cputype] || `unknown(0x${cputype.toString(16)})`;
  if (base === 'arm64' && (cpusubtype & 0xff) === 2) return 'arm64e';
  if (base === 'arm64' && (cpusubtype & 0xff) === 1) return 'arm64v8';
  return base;
}

const MACHO_FILE_TYPES = {
  1: 'OBJECT',
  2: 'EXECUTE',
  3: 'FVMLIB',
  4: 'CORE',
  5: 'PRELOAD',
  6: 'DYLIB',
  7: 'DYLINKER',
  8: 'BUNDLE',
  9: 'DYLIB_STUB',
  10: 'DSYM',
  11: 'KEXT_BUNDLE'
};

const LC_SEGMENT = 0x01;
const LC_SEGMENT_64 = 0x19;
const LC_SYMTAB = 0x02;
const LC_DYSYMTAB = 0x0b;
const LC_LOAD_DYLIB = 0x0c;
const LC_ID_DYLIB = 0x0d;
const LC_LOAD_WEAK_DYLIB = 0x8000018;
const LC_REEXPORT_DYLIB = 0x800001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x8000023;
const LC_UUID = 0x1b;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;
const LC_MAIN = 0x80000028;
const LC_BUILD_VERSION = 0x32;
const LC_SOURCE_VERSION = 0x2a;
const LC_CODE_SIGNATURE = 0x1d;

const MH_PIE = 0x200000;
const MH_ALLOW_STACK_EXECUTION = 0x20000;
const MH_NO_HEAP_EXECUTION = 0x1000000;
const MH_TWOLEVEL = 0x80;

const PLATFORMS = {
  1: 'macOS',
  2: 'iOS',
  3: 'tvOS',
  4: 'watchOS',
  5: 'bridgeOS',
  6: 'macCatalyst',
  7: 'iOS Simulator',
  8: 'tvOS Simulator',
  9: 'watchOS Simulator',
  10: 'DriverKit'
};

function isMachO(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const magic = buffer.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

/** 解析 Mach-O（自动处理 FAT 多架构）。 */
function parseMachO(buffer) {
  if (!isMachO(buffer)) return null;
  const magicBE = buffer.readUInt32BE(0);

  if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
    const littleEndian = magicBE === 0xbebafeca;
    const read32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
    const count = read32(4);
    const slices = [];
    for (let i = 0; i < count; i += 1) {
      const offset = 8 + i * 20;
      if (offset + 20 > buffer.length) break;
      const cputype = read32(offset);
      const cpusubtype = read32(offset + 4);
      const sliceOffset = read32(offset + 8);
      const sliceSize = read32(offset + 12);
      slices.push({ cputype, cpusubtype, offset: sliceOffset, size: sliceSize });
    }
    const architectures = [];
    let merged = null;
    for (const slice of slices) {
      const sliceBuffer = buffer.subarray(slice.offset, slice.offset + slice.size);
      const parsed = parseThinMachO(sliceBuffer);
      if (!parsed) continue;
      architectures.push({
        arch: machoArchLabel(slice.cputype, slice.cpusubtype),
        cputype: slice.cputype,
        cpusubtype: slice.cpusubtype,
        size: slice.size,
        size_human: formatBytes(slice.size)
      });
      if (!merged) merged = parsed;
      else {
        merged.uuid = merged.uuid || parsed.uuid;
        merged.linked_libraries = [...new Set([...merged.linked_libraries, ...parsed.linked_libraries])];
        merged.min_os_version = merged.min_os_version || parsed.min_os_version;
        merged.sdk_version = merged.sdk_version || parsed.sdk_version;
        merged.cryptid = merged.cryptid || parsed.cryptid;
        merged.encrypted = merged.encrypted || parsed.encrypted;
        merged.bitcode = merged.bitcode || parsed.bitcode;
      }
    }
    if (!merged) return null;
    return { ...merged, fat: true, slice_count: slices.length, architectures, size: buffer.length, size_human: formatBytes(buffer.length) };
  }

  const parsed = parseThinMachO(buffer);
  if (!parsed) return null;
  return {
    ...parsed,
    fat: false,
    slice_count: 1,
    architectures: [{ arch: parsed.arch, cputype: parsed.cputype, cpusubtype: parsed.cpusubtype, size: buffer.length, size_human: formatBytes(buffer.length) }],
    size: buffer.length,
    size_human: formatBytes(buffer.length)
  };
}

function parseThinMachO(buffer) {
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

  const read32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const read64 = (offset) => Number(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));

  const cputype = read32(4);
  const cpusubtype = read32(8);
  const filetype = read32(12);
  const ncmds = read32(16);
  const flags = read32(24);

  const linkedLibraries = [];
  let uuid = null;
  let minOsVersion = null;
  let sdkVersion = null;
  let cryptid = 0;
  let hasCodeSignature = false;
  let codeSignatureOffset = null;
  let codeSignatureSize = 0;
  let bitcode = false;
  let sourceVersion = null;
  let platform = null;
  let entryPoint = null;
  let segmentNames = [];
  let hasLlvmSection = false;

  const headerSize = is64 ? 32 : 28;
  let cursor = headerSize;

  const decodeVersion = (value) => {
    const major = (value >>> 16) & 0xffff;
    const minor = (value >>> 8) & 0xff;
    const patch = value & 0xff;
    return `${major}.${minor}${patch ? `.${patch}` : ''}`;
  };

  for (let i = 0; i < ncmds && cursor + 8 <= buffer.length; i += 1) {
    const cmd = read32(cursor);
    const cmdsize = read32(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > buffer.length) break;

    if (cmd === LC_UUID) {
      uuid = buffer.toString('hex', cursor + 8, cursor + 24).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toUpperCase();
    } else if (cmd === LC_LOAD_DYLIB || cmd === LC_LOAD_WEAK_DYLIB || cmd === LC_REEXPORT_DYLIB
      || cmd === LC_LAZY_LOAD_DYLIB || cmd === LC_LOAD_UPWARD_DYLIB || cmd === LC_ID_DYLIB) {
      const nameOffset = read32(cursor + 8);
      const start = cursor + nameOffset;
      if (start < buffer.length) {
        const end = buffer.indexOf(0, start);
        const name = buffer.toString('utf8', start, end < 0 ? cursor + cmdsize : end);
        if (name) linkedLibraries.push(name);
      }
    } else if (cmd === LC_ENCRYPTION_INFO) {
      cryptid = read32(cursor + 16);
    } else if (cmd === LC_ENCRYPTION_INFO_64) {
      cryptid = read32(cursor + 16);
    } else if (cmd === LC_VERSION_MIN_IPHONEOS) {
      minOsVersion = decodeVersion(read32(cursor + 8));
      sdkVersion = decodeVersion(read32(cursor + 12));
      platform = 'iOS';
    } else if (cmd === LC_VERSION_MIN_MACOSX) {
      minOsVersion = decodeVersion(read32(cursor + 8));
      sdkVersion = decodeVersion(read32(cursor + 12));
      platform = 'macOS';
    } else if (cmd === LC_BUILD_VERSION) {
      platform = PLATFORMS[read32(cursor + 8)] || `platform-${read32(cursor + 8)}`;
      minOsVersion = decodeVersion(read32(cursor + 12));
      sdkVersion = decodeVersion(read32(cursor + 16));
    } else if (cmd === LC_SOURCE_VERSION) {
      sourceVersion = read64(cursor + 8);
    } else if (cmd === LC_CODE_SIGNATURE) {
      hasCodeSignature = true;
      codeSignatureOffset = read32(cursor + 8);
      codeSignatureSize = read32(cursor + 12);
    } else if (cmd === LC_MAIN) {
      entryPoint = read64(cursor + 8);
    } else if (cmd === LC_SEGMENT || cmd === LC_SEGMENT_64) {
      const segNameStart = cursor + 8;
      const segName = buffer.toString('utf8', segNameStart, segNameStart + 16).replace(/\0.*$/, '');
      if (segName) segmentNames.push(segName);
      if (segName === '__LLVM' || segName === '__bitcode') bitcode = true;
      const sectionCount = read32(cursor + (is64 ? 64 : 48));
      if (sectionCount > 0 && (segName === '__LLVM' || segName === '__DATA' || segName === '__TEXT')) {
        const sectionStart = cursor + (is64 ? 72 : 56);
        const sectionSize = is64 ? 80 : 68;
        for (let s = 0; s < sectionCount; s += 1) {
          const at = sectionStart + s * sectionSize;
          if (at + 16 > buffer.length) break;
          const sectionName = buffer.toString('utf8', at, at + 16).replace(/\0.*$/, '');
          if (sectionName.includes('__llvm') || sectionName.includes('__LLVM') || sectionName.includes('bitcode')) bitcode = true;
        }
      }
    }

    cursor += cmdsize;
  }

  // 栈保护：Mach-O 的 __stack_chk_fail 出现在符号表中
  const canary = buffer.includes(Buffer.from('__stack_chk_fail', 'latin1'))
    || buffer.includes(Buffer.from('__stack_chk_guard', 'latin1'));

  return {
    arch: machoArchLabel(cputype, cpusubtype),
    cputype,
    cpusubtype,
    file_type: MACHO_FILE_TYPES[filetype] || `unknown(${filetype})`,
    file_type_code: filetype,
    is_executable: filetype === 2,
    is_dylib: filetype === 6,
    uuid,
    platform,
    min_os_version: minOsVersion,
    sdk_version: sdkVersion,
    source_version: sourceVersion,
    linked_libraries: linkedLibraries,
    linked_library_count: linkedLibraries.length,
    cryptid,
    encrypted: cryptid > 0,
    has_code_signature: hasCodeSignature,
    code_signature_offset: codeSignatureOffset,
    code_signature_size: codeSignatureSize,
    bitcode: Boolean(bitcode),
    segments: segmentNames,
    entry_point: entryPoint,
    flags,
    security: {
      pie: (flags & MH_PIE) !== 0,
      nx: (flags & MH_ALLOW_STACK_EXECUTION) === 0,
      no_heap_execution: (flags & MH_NO_HEAP_EXECUTION) !== 0,
      canary: Boolean(canary),
      two_level_namespace: (flags & MH_TWOLEVEL) !== 0,
      code_signed: hasCodeSignature
    },
    load_command_count: ncmds
  };
}

// ==================== Mach-O 代码签名（SuperBlob） ====================

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSMAGIC_EMBEDDED_ENTITLEMENTS = 0xfade7171;
const CSMAGIC_BLOBWRAPPER = 0xfade0b01;

const CSSLOT_CODEDIRECTORY = 0;
const CSSLOT_ENTITLEMENTS = 5;
const CSSLOT_SIGNATURESLOT = 0x10000;

const CS_FLAGS = {
  0x00000001: 'kSecCodeSignatureHost',
  0x00000002: 'kSecCodeSignatureAdhoc',
  0x00000100: 'kSecCodeSignatureRuntime',
  0x00000200: 'kSecCodeSignatureLinkerSigned'
};

const CS_HASH_TYPES = {
  1: 'SHA-1',
  2: 'SHA-256',
  3: 'SHA-256（truncated）',
  4: 'SHA-384'
};

const CS_PLATFORMS = {
  0: 'unknown',
  1: 'macOS',
  2: 'iOS',
  3: 'tvOS',
  4: 'watchOS',
  5: 'bridgeOS',
  6: 'macCatalyst',
  7: 'iOS Simulator'
};

/**
 * 解析 Mach-O 内嵌代码签名（LC_CODE_SIGNATURE 指向的 SuperBlob）。
 *
 * App Store 分发的 IPA 不包含 embedded.mobileprovision，签名证书与实际
 * entitlements 只能从这里取。
 */
function parseCodeSignature(buffer, offset, size) {
  if (offset == null || offset <= 0 || offset + 12 > buffer.length) return null;
  const limit = Math.min(buffer.length, offset + (size || 0) || buffer.length);
  if (buffer.readUInt32BE(offset) !== CSMAGIC_EMBEDDED_SIGNATURE) return null;

  const count = buffer.readUInt32BE(offset + 8);
  const blobs = new Map();
  for (let i = 0; i < count; i += 1) {
    const indexOffset = offset + 12 + i * 8;
    if (indexOffset + 8 > limit) break;
    const type = buffer.readUInt32BE(indexOffset);
    const blobOffset = offset + buffer.readUInt32BE(indexOffset + 4);
    if (blobOffset + 8 > limit) continue;
    const magic = buffer.readUInt32BE(blobOffset);
    const length = buffer.readUInt32BE(blobOffset + 4);
    if (length < 8 || blobOffset + length > limit) continue;
    blobs.set(type, { magic, offset: blobOffset, length, body: buffer.subarray(blobOffset + 8, blobOffset + length) });
  }

  const result = {
    present: true,
    blob_count: count,
    blob_types: [...blobs.keys()].map((type) => `0x${type.toString(16)}`),
    identifier: null,
    team_identifier: null,
    flags: null,
    flag_names: [],
    hash_type: null,
    page_size: null,
    code_slots: null,
    special_slots: null,
    entitlements: null,
    certificates: []
  };

  const codeDirectory = blobs.get(CSSLOT_CODEDIRECTORY);
  if (codeDirectory && codeDirectory.magic === CSMAGIC_CODEDIRECTORY) {
    // body 从 magic/length 之后开始：version 在 0，flags 在 4，……
    const cd = codeDirectory.body;
    try {
      const version = cd.readUInt32BE(0);
      const flags = cd.readUInt32BE(4);
      const identOffset = cd.readUInt32BE(12);
      const nSpecialSlots = cd.readUInt32BE(16);
      const nCodeSlots = cd.readUInt32BE(20);
      const hashSize = cd[28];
      const hashType = cd[29];
      const platform = cd[30];
      const pageSize = cd[31];
      const teamOffset = version >= 0x20200 ? cd.readUInt32BE(40) : 0;

      result.version = `0x${version.toString(16)}`;
      result.flags = `0x${flags.toString(16)}`;
      result.flag_names = Object.entries(CS_FLAGS)
        .filter(([bit]) => (flags & Number(bit)) !== 0)
        .map(([, name]) => name);
      result.hash_type = CS_HASH_TYPES[hashType] || `hashType=${hashType}`;
      result.hash_size = hashSize;
      result.page_size = pageSize ? 1 << pageSize : null;
      result.code_slots = nCodeSlots;
      result.special_slots = nSpecialSlots;
      result.platform = CS_PLATFORMS[platform] || null;
      // 字符串偏移是相对整个 CodeDirectory blob 起点（含 magic/length），不是相对 body
      result.identifier = readNullTerminated(buffer, codeDirectory.offset + identOffset);
      result.team_identifier = teamOffset
        ? readNullTerminated(buffer, codeDirectory.offset + teamOffset)
        : null;
    } catch (_) { /* 保留已解析字段 */ }
  }

  const entitlementsBlob = blobs.get(CSSLOT_ENTITLEMENTS);
  if (entitlementsBlob && entitlementsBlob.magic === CSMAGIC_EMBEDDED_ENTITLEMENTS) {
    result.entitlements_raw = entitlementsBlob.body.toString('utf8');
  }

  const signatureBlob = blobs.get(CSSLOT_SIGNATURESLOT);
  if (signatureBlob && signatureBlob.magic === CSMAGIC_BLOBWRAPPER) {
    result.cms_length = signatureBlob.body.length;
    result.cms_der = signatureBlob.body;
  }

  return result;
}

function readNullTerminated(buffer, offset) {
  if (offset == null || offset <= 0 || offset >= buffer.length) return null;
  const end = buffer.indexOf(0, offset);
  return buffer.toString('utf8', offset, end < 0 ? buffer.length : end) || null;
}

// ==================== Protocol Buffers（AAB BundleConfig.pb） ====================

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    result |= BigInt(byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: Number(result), next: cursor };
}

/** 极简 protobuf 解析：返回 { fieldNumber: [values] }，字符串按 UTF-8 解码。 */
function parseProtobuf(buffer, depth = 0) {
  const result = {};
  let cursor = 0;
  while (cursor < buffer.length && depth < 12) {
    const tag = readVarint(buffer, cursor);
    cursor = tag.next;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x07;
    if (fieldNumber === 0) break;

    if (wireType === 0) {
      const value = readVarint(buffer, cursor);
      cursor = value.next;
      (result[fieldNumber] ||= []).push(value.value);
    } else if (wireType === 2) {
      const length = readVarint(buffer, cursor);
      cursor = length.next;
      const end = cursor + length.value;
      if (end > buffer.length) break;
      const slice = buffer.subarray(cursor, end);
      cursor = end;
      const text = slice.toString('utf8');
      const isPrintable = /^[\x20-\x7e\t\r\n]*$/.test(text);
      let value = slice;
      if (isPrintable && text.length) {
        value = text;
      } else {
        try {
          const nested = parseProtobuf(slice, depth + 1);
          if (Object.keys(nested).length) value = nested;
        } catch (_) { /* 保留原始 Buffer */ }
      }
      (result[fieldNumber] ||= []).push(value);
    } else if (wireType === 5) {
      if (cursor + 4 > buffer.length) break;
      (result[fieldNumber] ||= []).push(buffer.readUInt32LE(cursor));
      cursor += 4;
    } else if (wireType === 1) {
      if (cursor + 8 > buffer.length) break;
      (result[fieldNumber] ||= []).push(Number(buffer.readBigUInt64LE(cursor)));
      cursor += 8;
    } else {
      break;
    }
  }
  return result;
}

module.exports = {
  isDex,
  parseDexHeader,
  readDexStrings,
  readDexClassNames,
  isObfuscatedClassName,
  analyzeDexFiles,
  isElf,
  parseElf,
  ELF_MACHINES,
  isMachO,
  parseMachO,
  parseCodeSignature,
  MACHO_CPU_TYPES,
  machoArchLabel,
  parseProtobuf,
  readVarint,
  DEX_HEADER_SIZE
};
