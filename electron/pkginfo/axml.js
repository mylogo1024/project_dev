'use strict';

/**
 * 二进制 AndroidManifest.xml（AXML / ResXMLTree）解析器
 *
 * 产出通用的 XML 树结构：
 *   { tag, namespace, attributes: [{ ns, name, nameResId, value, typed }], children: [] }
 *
 * 同时兼容「已经是纯文本 XML」的输入（少数工具会直接产出文本清单）。
 */

const {
  RES_XML_TYPE,
  RES_XML_START_NAMESPACE_TYPE,
  RES_XML_END_NAMESPACE_TYPE,
  RES_XML_START_ELEMENT_TYPE,
  RES_XML_END_ELEMENT_TYPE,
  RES_XML_CDATA_TYPE,
  RES_XML_RESOURCE_MAP_TYPE,
  RES_STRING_POOL_TYPE,
  readChunkHeader,
  parseStringPool,
  readResValue,
  resValueToString,
  resValueToObject
} = require('./res-chunk');

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const ANDROID_NS_PREFIX = 'android';

/**
 * android 命名空间属性 ID → 名称。
 * 正常 AAPT 产物里字符串池已包含属性名，此表仅作为「属性名被抹掉」时的兜底。
 */
const ANDROID_ATTR_NAMES = {
  0x01010000: 'theme',
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010004: 'permission',
  0x01010005: 'readPermission',
  0x01010006: 'writePermission',
  0x0101000b: 'enabled',
  0x0101000c: 'debuggable',
  0x0101000d: 'allowClearUserData',
  0x01010010: 'allowTaskReparenting',
  0x01010018: 'authorities',
  0x0101001a: 'launchMode',
  0x0101001c: 'screenOrientation',
  0x0101001d: 'configChanges',
  0x0101001e: 'description',
  0x0101001f: 'targetPackage',
  0x01010024: 'versionCode',
  0x01010025: 'versionName',
  0x0101002d: 'minSdkVersion',
  0x01010031: 'targetSdkVersion',
  0x01010032: 'maxSdkVersion',
  0x01010036: 'theme',
  0x01010040: 'allowBackup',
  0x01010041: 'glEsVersion',
  0x01010042: 'required',
  0x01010043: 'handleProfiling',
  0x01010044: 'functionalTest',
  0x01010045: 'value',
  0x01010046: 'resource',
  0x01010047: 'mimeType',
  0x01010048: 'scheme',
  0x01010049: 'host',
  0x0101004a: 'port',
  0x0101004b: 'path',
  0x0101004c: 'pathPrefix',
  0x0101004d: 'pathPattern',
  0x0101004e: 'action',
  0x0101004f: 'category',
  0x01010050: 'priority',
  0x01010051: 'autoVerify',
  0x01010052: 'process',
  0x01010053: 'taskAffinity',
  0x01010054: 'excludeFromRecents',
  0x01010055: 'multiprocess',
  0x01010056: 'initOrder',
  0x01010057: 'grantUriPermissions',
  0x01010058: 'launchMode',
  0x01010059: 'clearTaskOnLaunch',
  0x0101005a: 'alwaysRetainTaskState',
  0x0101005b: 'stateNotNeeded',
  0x0101005c: 'finishOnTaskLaunch',
  0x0101005d: 'noHistory',
  0x0101005e: 'stateUnchanged',
  0x0101005f: 'stateHidden',
  0x01010060: 'label',
  0x01010061: 'icon',
  0x01010062: 'logo',
  0x01010063: 'banner',
  0x01010064: 'roundIcon',
  0x01010065: 'requiredFeature',
  0x01010066: 'minSdkVersion',
  0x01010067: 'targetSdkVersion',
  0x01010068: 'foregroundServiceType',
  0x01010069: 'usesCleartextTraffic',
  0x0101006a: 'networkSecurityConfig',
  0x0101006b: 'installLocation',
  0x0101006c: 'sharedUserId',
  0x0101006d: 'sharedUserLabel',
  0x0101006e: 'requestLegacyExternalStorage',
  0x0101006f: 'preserveLegacyExternalStorage',
  0x01010070: 'usesPermissionFlags',
  0x01010071: 'maxSdkVersion',
  0x01010072: 'protectionLevel',
  0x01010073: 'permissionGroup',
  0x01010074: 'debuggable',
  0x01010075: 'allowBackup',
  0x01010076: 'largeHeap',
  0x01010077: 'hardwareAccelerated',
  0x01010078: 'supportsRtl',
  0x01010079: 'resizeableActivity',
  0x0101007a: 'maxAspectRatio',
  0x0101007b: 'minAspectRatio',
  0x0101007c: 'usesNonSdkApi',
  0x0101007d: 'extractNativeLibs',
  0x0101007e: 'requestRawExternalStorageAccess',
  0x0101007f: 'enableOnBackInvokedCallback',
  0x01010080: 'isolatedProcess',
  0x01010081: 'exported',
  0x01010082: 'directBootAware',
  0x01010083: 'usesCleartextTraffic',
  0x01010084: 'appComponentFactory',
  0x01010085: 'backupAgent',
  0x01010086: 'fullBackupContent',
  0x01010087: 'dataExtractionRules',
  0x01010088: 'debuggable',
  0x01010089: 'allowBackup',
  0x0101008a: 'requestLegacyExternalStorage',
  0x0101008b: 'killAfterRestore',
  0x0101008c: 'restoreNeedsApplication',
  0x0101008d: 'backupInForeground',
  0x0101008e: 'testOnly',
  0x0101008f: 'allowClearUserData',
  0x01010090: 'vmSafeMode',
  0x01010091: 'multiArch',
  0x01010092: 'requiredAccountType',
  0x01010093: 'restrictedAccountType',
  0x01010094: 'supportsScreens',
  0x01010095: 'anyDensity',
  0x01010096: 'resizeable',
  0x01010097: 'smallScreens',
  0x01010098: 'normalScreens',
  0x01010099: 'largeScreens',
  0x0101009a: 'xlargeScreens',
  0x0101009b: 'requiresSmallestWidthDp',
  0x0101009c: 'compatibleWidthLimitDp',
  0x0101009d: 'largestWidthLimitDp',
  0x0101009e: 'minSdkVersion',
  0x0101009f: 'glEsVersion',
  0x010100a0: 'required'
};

/** 资源 ID 转属性名（兜底用）。 */
function androidAttrNameFromResId(resId) {
  return ANDROID_ATTR_NAMES[resId >>> 0] || `attr/0x${(resId >>> 0).toString(16).padStart(8, '0')}`;
}

/** 判断是不是二进制 XML（ResXMLTree）。 */
function isBinaryXml(buffer) {
  if (!buffer || buffer.length < 8) return false;
  if (buffer.readUInt16LE(0) !== RES_XML_TYPE) return false;
  const headerSize = buffer.readUInt16LE(2);
  const size = buffer.readUInt32LE(4);
  return headerSize >= 8 && size >= 8 && size <= buffer.length;
}

/**
 * 解析二进制 XML。
 * @param {Buffer} buffer
 * @returns {{tag: string, attributes: Array, children: Array}}
 */
function parseBinaryXml(buffer) {
  const root = { tag: '#document', namespace: '', attributes: [], children: [] };
  const stack = [root];
  let stringPool = { strings: [], utf8: false, stringCount: 0 };
  let resourceMap = [];
  const namespaceStack = [];

  const header = readChunkHeader(buffer, 0);
  if (!header) throw new Error('二进制 XML 头无效');

  let cursor = header.headerSize;
  const end = Math.min(header.size || buffer.length, buffer.length);

  while (cursor + 8 <= end) {
    const chunk = readChunkHeader(buffer, cursor);
    if (!chunk || chunk.size < 8) break;

    if (chunk.type === RES_STRING_POOL_TYPE) {
      stringPool = parseStringPool(buffer, cursor);
    } else if (chunk.type === RES_XML_RESOURCE_MAP_TYPE) {
      const count = Math.floor((chunk.size - chunk.headerSize) / 4);
      resourceMap = [];
      for (let i = 0; i < count; i += 1) {
        resourceMap.push(buffer.readUInt32LE(cursor + chunk.headerSize + i * 4));
      }
    } else if (chunk.type === RES_XML_START_NAMESPACE_TYPE) {
      const prefix = stringPool.strings[buffer.readUInt32LE(cursor + 16)] || '';
      const uri = stringPool.strings[buffer.readUInt32LE(cursor + 20)] || '';
      namespaceStack.push({ prefix, uri });
    } else if (chunk.type === RES_XML_END_NAMESPACE_TYPE) {
      namespaceStack.pop();
    } else if (chunk.type === RES_XML_START_ELEMENT_TYPE) {
      const element = parseStartElement(buffer, cursor, chunk, stringPool, resourceMap);
      stack[stack.length - 1].children.push(element);
      stack.push(element);
    } else if (chunk.type === RES_XML_END_ELEMENT_TYPE) {
      if (stack.length > 1) stack.pop();
    }
    // CDATA 暂不参与建模

    cursor += chunk.size;
  }

  return root.children[0] || root;
}

function parseStartElement(buffer, chunkOffset, chunk, stringPool, resourceMap) {
  const nameIndex = buffer.readUInt32LE(chunkOffset + 20);
  const tag = stringPool.strings[nameIndex] || '';
  const attributeStart = buffer.readUInt16LE(chunkOffset + 24);
  const attributeSize = buffer.readUInt16LE(chunkOffset + 26) || 20;
  const attributeCount = buffer.readUInt16LE(chunkOffset + 28);

  const attributes = [];
  const attributesBase = chunkOffset + chunk.headerSize + attributeStart;
  for (let i = 0; i < attributeCount; i += 1) {
    const base = attributesBase + i * attributeSize;
    if (base + attributeSize > buffer.length) break;
    const nsIndex = buffer.readInt32LE(base);
    const attrNameIndex = buffer.readUInt32LE(base + 4);
    const rawValueIndex = buffer.readInt32LE(base + 8);
    const typed = readResValue(buffer, base + 12);

    let name = stringPool.strings[attrNameIndex];
    let nameResId = null;
    if (resourceMap[attrNameIndex]) nameResId = resourceMap[attrNameIndex] >>> 0;
    if (!name) {
      if (nameResId) name = androidAttrNameFromResId(nameResId);
      else name = `attr#${attrNameIndex}`;
    }

    const ns = nsIndex >= 0 ? (stringPool.strings[nsIndex] || '') : '';
    const value = rawValueIndex >= 0 && stringPool.strings[rawValueIndex] !== undefined
      ? stringPool.strings[rawValueIndex]
      : resValueToString(typed, stringPool);

    attributes.push({
      ns,
      name,
      nameResId,
      nameResIdHex: nameResId ? `0x${nameResId.toString(16).padStart(8, '0')}` : null,
      rawValue: rawValueIndex >= 0 ? stringPool.strings[rawValueIndex] : undefined,
      value,
      typed: resValueToObject(typed, stringPool),
      isAndroidNs: ns === ANDROID_NS
    });
  }

  return { tag, namespace: '', attributes, children: [] };
}

// ==================== 纯文本 XML 兜底 ====================

/** 极简 XML 解析：只覆盖清单文件需要的元素/属性/自闭合标签。 */
function parseTextXml(text) {
  const root = { tag: '#document', attributes: [], children: [] };
  const stack = [root];
  const tagPattern = /<([!?/]?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->/g;

  let match = tagPattern.exec(text);
  while (match) {
    const [full, marker, tagName, attrText, selfClosing] = match;
    if (marker === '!' || marker === '?') {
      match = tagPattern.exec(text);
      continue;
    }
    if (marker === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      const attributes = [];
      const attrPattern = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let attrMatch = attrPattern.exec(attrText || '');
      while (attrMatch) {
        const rawName = attrMatch[1];
        const value = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
        const colon = rawName.indexOf(':');
        const prefix = colon >= 0 ? rawName.slice(0, colon) : '';
        const localName = colon >= 0 ? rawName.slice(colon + 1) : rawName;
        const ns = prefix === ANDROID_NS_PREFIX || prefix === 'android'
          ? ANDROID_NS
          : (prefix ? `urn:${prefix}` : '');
        attributes.push({
          ns,
          name: localName,
          nameResId: null,
          rawValue: value,
          value,
          typed: null,
          isAndroidNs: ns === ANDROID_NS
        });
        attrMatch = attrPattern.exec(attrText || '');
      }
      const element = { tag: tagName, attributes, children: [] };
      stack[stack.length - 1].children.push(element);
      if (!selfClosing) stack.push(element);
    }
    match = tagPattern.exec(text);
  }

  return root.children[0] || root;
}

/** 统一入口：自动识别二进制/文本 XML。 */
function parseXml(buffer) {
  if (isBinaryXml(buffer)) return { format: 'binary', root: parseBinaryXml(buffer) };
  const text = buffer.toString('utf8');
  if (/<\s*manifest[\s>]/.test(text)) return { format: 'text', root: parseTextXml(text) };
  throw new Error('无法识别的 AndroidManifest.xml 格式（既不是二进制 XML 也不是文本 XML）');
}

// ==================== 树操作辅助 ====================

function childElements(node, tag) {
  if (!node || !node.children) return [];
  return tag ? node.children.filter((child) => child.tag === tag) : node.children;
}

function findChild(node, tag) {
  return childElements(node, tag)[0] || null;
}

/** 取属性值（优先 android 命名空间）。 */
function attr(node, name) {
  if (!node) return undefined;
  const android = node.attributes.find((item) => item.isAndroidNs && item.name === name);
  if (android) return android.value;
  const plain = node.attributes.find((item) => item.name === name);
  return plain ? plain.value : undefined;
}

function attrEntry(node, name) {
  if (!node) return null;
  return node.attributes.find((item) => item.isAndroidNs && item.name === name)
    || node.attributes.find((item) => item.name === name)
    || null;
}

/** 取布尔属性。 */
function boolAttr(node, name, fallback = null) {
  const value = attr(node, name);
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

/** 取整型属性。 */
function intAttr(node, name, fallback = null) {
  const value = attr(node, name);
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number.parseInt(String(value), value.startsWith('0x') || /^0[0-9a-fA-F]/.test(String(value)) ? 16 : 10);
  return Number.isNaN(num) ? fallback : num;
}

/** 是否为资源引用（@ref/0x... 或 @7f...）。 */
function referenceAttr(node, name) {
  const entry = attrEntry(node, name);
  if (!entry) return null;
  if (entry.typed && entry.typed.reference != null) {
    return { resId: entry.typed.reference >>> 0, hex: entry.typed.reference_hex, text: entry.typed.text };
  }
  const value = entry.value;
  if (typeof value === 'string') {
    const match = value.match(/^@(?:ref\/)?0x([0-9a-fA-F]{1,8})$/);
    if (match) return { resId: Number.parseInt(match[1], 16) >>> 0, hex: `0x${match[1]}`, text: value };
    const shortMatch = value.match(/^@([0-9a-fA-F]{8})$/);
    if (shortMatch) return { resId: Number.parseInt(shortMatch[1], 16) >>> 0, hex: `0x${shortMatch[1]}`, text: value };
  }
  return null;
}

/** 把节点属性转成普通对象（用于原始数据展示）。 */
function attributesToObject(node) {
  const result = {};
  for (const item of node?.attributes || []) {
    const key = item.isAndroidNs ? `android:${item.name}` : item.name;
    result[key] = item.value;
  }
  return result;
}

/** 把 XML 树序列化为带缩进的文本（用于「原始 Manifest」展示）。 */
function serializeXml(node, depth = 0) {
  if (!node) return '';
  const indent = '  '.repeat(depth);
  const attrs = (node.attributes || [])
    .map((item) => `${item.isAndroidNs ? 'android:' : ''}${item.name}="${String(item.value ?? '').replace(/"/g, '&quot;')}"`)
    .join(' ');
  const head = `${indent}<${node.tag}${attrs ? ` ${attrs}` : ''}`;
  if (!node.children || node.children.length === 0) return `${head} />`;
  const inner = node.children.map((child) => serializeXml(child, depth + 1)).join('\n');
  return `${head}>\n${inner}\n${indent}</${node.tag}>`;
}

module.exports = {
  ANDROID_NS,
  ANDROID_NS_PREFIX,
  ANDROID_ATTR_NAMES,
  androidAttrNameFromResId,
  isBinaryXml,
  parseBinaryXml,
  parseTextXml,
  parseXml,
  childElements,
  findChild,
  attr,
  attrEntry,
  boolAttr,
  intAttr,
  referenceAttr,
  attributesToObject,
  serializeXml
};
