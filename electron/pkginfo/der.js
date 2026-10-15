'use strict';

/**
 * DER / X.509 / PKCS#7 最小实现
 *
 * 只覆盖包体静态信息需要的部分：
 *  - 通用 DER 元素遍历
 *  - X.509 证书主体、颁发者、有效期、算法、公钥长度、指纹
 *  - PKCS#7 SignedData 中的证书集合提取（APK v1 签名 / iOS 描述文件）
 *  - CMS 内嵌 plist 定位（mobileprovision）
 */

const { decodeUtf16Be, hashBuffer, oidName } = require('./util');

// ==================== DER 基础 ====================

const TAG_CLASS = { UNIVERSAL: 0, APPLICATION: 1, CONTEXT: 2, PRIVATE: 3 };

function readDerElement(buffer, offset) {
  if (offset == null || offset + 2 > buffer.length) return null;
  const tagByte = buffer[offset];
  const tagClass = (tagByte >> 6) & 0x03;
  const constructed = (tagByte & 0x20) !== 0;
  let tagNumber = tagByte & 0x1f;
  let cursor = offset + 1;

  if (tagNumber === 0x1f) {
    tagNumber = 0;
    while (cursor < buffer.length) {
      const byte = buffer[cursor];
      tagNumber = (tagNumber << 7) | (byte & 0x7f);
      cursor += 1;
      if ((byte & 0x80) === 0) break;
    }
  }

  if (cursor >= buffer.length) return null;
  let length = buffer[cursor];
  cursor += 1;
  if (length & 0x80) {
    const byteCount = length & 0x7f;
    if (byteCount === 0 || byteCount > 6) return null;
    length = 0;
    for (let i = 0; i < byteCount; i += 1) {
      length = length * 256 + buffer[cursor];
      cursor += 1;
    }
  }

  const contentStart = cursor;
  const contentEnd = contentStart + length;
  if (contentEnd > buffer.length) return null;

  return {
    tagClass,
    tagNumber,
    constructed,
    isUniversal: tagClass === TAG_CLASS.UNIVERSAL,
    isContext: tagClass === TAG_CLASS.CONTEXT,
    length,
    headerLength: contentStart - offset,
    offset,
    contentStart,
    contentEnd,
    end: contentEnd
  };
}

/** 遍历构造类型元素的所有直接子元素。 */
function readDerChildren(buffer, element) {
  if (!element || !element.constructed) return [];
  const children = [];
  let cursor = element.contentStart;
  while (cursor < element.contentEnd) {
    const child = readDerElement(buffer, cursor);
    if (!child) break;
    children.push(child);
    if (child.end <= cursor) break;
    cursor = child.end;
  }
  return children;
}

function derContent(buffer, element) {
  if (!element) return Buffer.alloc(0);
  return buffer.subarray(element.contentStart, element.contentEnd);
}

/** 解析 OID 内容为点分字符串。 */
function parseOidContent(buffer, start, end) {
  if (start >= end) return '';
  const first = buffer[start];
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = start + 1; i < end; i += 1) {
    const byte = buffer[i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

function readOid(buffer, element) {
  if (!element || element.tagNumber !== 0x06) return '';
  return parseOidContent(buffer, element.contentStart, element.contentEnd);
}

function readInteger(buffer, element) {
  if (!element || element.tagNumber !== 0x02) return null;
  const bytes = derContent(buffer, element);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function readBigInt(buffer, element) {
  return readInteger(buffer, element);
}

function readBitStringBytes(buffer, element) {
  if (!element || element.tagNumber !== 0x03) return null;
  const content = derContent(buffer, element);
  if (content.length < 1) return null;
  const unusedBits = content[0];
  if (unusedBits !== 0) return content.subarray(1);
  return content.subarray(1);
}

function readStringValue(buffer, element) {
  if (!element) return '';
  const content = derContent(buffer, element);
  switch (element.tagNumber) {
    case 0x0c: // UTF8String
    case 0x13: // PrintableString
    case 0x16: // IA5String
    case 0x14: // T61String
    case 0x1a: // VisibleString
      return content.toString('utf8');
    case 0x1e: // BMPString
      // Node 没有 utf16be 编码（见 util.decodeUtf16Be）
      return decodeUtf16Be(content);
    case 0x12: // NumericString
      return content.toString('latin1');
    default:
      return content.toString('utf8');
  }
}

/** 解析 Time（UTCTime / GeneralizedTime）。 */
function readTimeValue(buffer, element) {
  if (!element) return null;
  const raw = derContent(buffer, element).toString('latin1').trim();
  if (element.tagNumber === 0x17) {
    // UTCTime: YYMMDDHHMMSSZ
    const match = raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})?$/);
    if (!match) return null;
    const year = Number(match[1]) >= 50 ? 1900 + Number(match[1]) : 2000 + Number(match[1]);
    return new Date(Date.UTC(
      year,
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0)
    ));
  }
  if (element.tagNumber === 0x18) {
    // GeneralizedTime: YYYYMMDDHHMMSSZ
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/);
    if (!match) return null;
    return new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0)
    ));
  }
  return null;
}

// ==================== X.509 证书 ====================

/** 解析 AlgorithmIdentifier → 算法名 + 参数 OID。 */
function parseAlgorithmIdentifier(buffer, element) {
  if (!element) return { name: '', oid: '', parameters: null };
  const children = readDerChildren(buffer, element);
  const oid = readOid(buffer, children[0]);
  let parameters = null;
  if (children[1]) {
    if (children[1].tagNumber === 0x06) parameters = readOid(buffer, children[1]);
    else if (children[1].tagNumber === 0x05) parameters = 'NULL';
    else parameters = children[1];
  }
  return { name: oidName(oid), oid, parameters };
}

/** 解析 Name（RDNSequence）。 */
function parseName(buffer, element) {
  const result = { raw: [], commonName: '', organization: '', organizationalUnit: '', country: '', email: '', full: '' };
  if (!element) return result;

  for (const rdn of readDerChildren(buffer, element)) {
    for (const atv of readDerChildren(buffer, rdn)) {
      const parts = readDerChildren(buffer, atv);
      const oid = readOid(buffer, parts[0]);
      const value = readStringValue(buffer, parts[1]);
      const key = oidName(oid);
      result.raw.push({ key, oid, value });
      if (key === 'CN') result.commonName = value;
      else if (key === 'O') result.organization = value;
      else if (key === 'OU') result.organizationalUnit = value;
      else if (key === 'C') result.country = value;
      else if (key === 'emailAddress') result.email = value;
    }
  }
  result.full = result.raw.map((item) => `${item.key}=${item.value}`).join(', ');
  return result;
}

const EC_CURVE_BITS = {
  '1.2.840.10045.3.1.7': 256, // prime256v1 / secp256r1
  '1.3.132.0.34': 384,        // secp384r1
  '1.3.132.0.35': 521,        // secp521r1
  '1.3.132.0.10': 256,        // secp256k1
  '1.2.840.10045.3.1.1': 192
};

/** 解析 SubjectPublicKeyInfo → 算法与密钥长度。 */
function parseSubjectPublicKeyInfo(buffer, element) {
  const result = { algorithm: '', oid: '', keySize: null, keySizeLabel: '' };
  if (!element) return result;
  const children = readDerChildren(buffer, element);
  const algorithm = parseAlgorithmIdentifier(buffer, children[0]);
  result.algorithm = algorithm.name;
  result.oid = algorithm.oid;

  const keyBytes = readBitStringBytes(buffer, children[1]);
  if (algorithm.name === 'RSA' && keyBytes) {
    const rsaSeq = readDerElement(keyBytes, 0);
    if (rsaSeq) {
      const rsaChildren = readDerChildren(keyBytes, rsaSeq);
      const modulus = readInteger(keyBytes, rsaChildren[0]);
      if (modulus != null) {
        const bits = modulus.toString(2).length;
        result.keySize = bits;
        result.keySizeLabel = `${bits} bit RSA`;
      }
    }
  } else if (algorithm.name === 'EC') {
    const curveOid = typeof algorithm.parameters === 'string' ? algorithm.parameters : '';
    const bits = EC_CURVE_BITS[curveOid] || null;
    result.keySize = bits;
    result.curve = oidName(curveOid);
    result.keySizeLabel = bits ? `${bits} bit EC (${result.curve})` : `EC (${result.curve || '未知曲线'})`;
  } else if (algorithm.name === 'DSA') {
    result.keySizeLabel = 'DSA';
  } else if (algorithm.name) {
    result.keySizeLabel = algorithm.name;
  }

  return result;
}

/**
 * 解析一张 X.509 证书。
 * @param {Buffer} buffer 证书 DER（必须正好是一张证书）
 */
function parseX509Certificate(buffer) {
  const certificate = readDerElement(buffer, 0);
  if (!certificate || certificate.tagNumber !== 0x10) {
    throw new Error('不是有效的 X.509 证书（缺少顶层 SEQUENCE）');
  }
  const top = readDerChildren(buffer, certificate);
  const tbs = top[0];
  const signatureAlgorithm = parseAlgorithmIdentifier(buffer, top[1]);
  const signatureValue = readBitStringBytes(buffer, top[2]);

  const tbsChildren = readDerChildren(buffer, tbs);
  let index = 0;
  let version = 1;
  if (tbsChildren[index] && tbsChildren[index].isContext && tbsChildren[index].tagNumber === 0) {
    const versionChild = readDerChildren(buffer, tbsChildren[index])[0];
    const versionValue = readInteger(buffer, versionChild);
    version = Number(versionValue) + 1;
    index += 1;
  }

  const serial = readInteger(buffer, tbsChildren[index]);
  index += 1;
  const tbsSignatureAlgorithm = parseAlgorithmIdentifier(buffer, tbsChildren[index]);
  index += 1;
  const issuer = parseName(buffer, tbsChildren[index]);
  index += 1;
  const validityElement = tbsChildren[index];
  index += 1;

  const validityChildren = readDerChildren(buffer, validityElement);
  const notBefore = readTimeValue(buffer, validityChildren[0]);
  const notAfter = readTimeValue(buffer, validityChildren[1]);

  const subject = parseName(buffer, tbsChildren[index]);
  index += 1;
  const spki = parseSubjectPublicKeyInfo(buffer, tbsChildren[index]);

  const certDer = buffer.subarray(certificate.offset, certificate.end);
  const now = new Date();

  return {
    version,
    serial: serial != null ? serial.toString() : '',
    serial_hex: serial != null ? serial.toString(16) : '',
    signature_algorithm: signatureAlgorithm.name,
    signature_algorithm_oid: signatureAlgorithm.oid,
    issuer,
    subject,
    not_before: notBefore,
    not_after: notAfter,
    is_expired: notAfter ? notAfter.getTime() < now.getTime() : null,
    is_not_yet_valid: notBefore ? notBefore.getTime() > now.getTime() : null,
    public_key: spki,
    fingerprints: {
      sha256: hashBuffer(certDer, 'sha256'),
      sha1: hashBuffer(certDer, 'sha1'),
      md5: hashBuffer(certDer, 'md5')
    },
    der_length: certDer.length,
    der: certDer
  };
}

// ==================== PKCS#7 / CMS ====================

/**
 * 从 PKCS#7 SignedData 中提取全部证书。
 * @returns {Array<object>} 解析后的证书数组
 */
function parsePkcs7Certificates(buffer) {
  const certificates = [];
  try {
    const contentInfo = readDerElement(buffer, 0);
    if (!contentInfo) return certificates;
    const contentInfoChildren = readDerChildren(buffer, contentInfo);
    const wrapper = contentInfoChildren.find((child) => child.isContext && child.tagNumber === 0);
    const signedDataElement = wrapper ? readDerChildren(buffer, wrapper)[0] : contentInfoChildren[1];
    if (!signedDataElement) return certificates;

    for (const child of readDerChildren(buffer, signedDataElement)) {
      if (!(child.isContext && child.tagNumber === 0)) continue;
      for (const certElement of readDerChildren(buffer, child)) {
        if (certElement.tagNumber !== 0x10) continue;
        try {
          certificates.push(parseX509Certificate(buffer.subarray(certElement.offset, certElement.end)));
        } catch (_) {
          // 跳过无法解析的证书
        }
      }
    }
  } catch (_) {
    // 整体失败时返回已收集到的证书
  }
  return certificates;
}

/**
 * 在 CMS 结构中定位内嵌的 plist（mobileprovision / provisioning profile）。
 * 先按 OCTET STRING 递归查找，再退化为原始文本扫描。
 */
function extractEmbeddedPlist(buffer) {
  const candidates = [];

  const walk = (element, depth) => {
    if (!element || depth > 12) return;
    if (element.tagNumber === 0x04 || element.tagNumber === 0x03) {
      const content = derContent(buffer, element);
      const probe = content.subarray(0, Math.min(16, content.length));
      const head = probe.toString('latin1');
      if (head.startsWith('<?xml') || head.startsWith('bplist') || head.includes('<plist')) {
        candidates.push(content);
      }
    }
    if (element.constructed) {
      for (const child of readDerChildren(buffer, element)) walk(child, depth + 1);
    }
  };

  const root = readDerElement(buffer, 0);
  if (root) walk(root, 0);
  if (candidates.length) return candidates[0];

  // 退化方案：直接扫描 XML 头尾
  const text = buffer.toString('latin1');
  const start = text.indexOf('<?xml');
  if (start >= 0) {
    const end = text.indexOf('</plist>', start);
    if (end >= 0) return Buffer.from(text.slice(start, end + 8), 'latin1');
  }
  return null;
}

/** 从 CMS 中提取签名者证书链（mobileprovision 的 DeveloperCertificates 由 plist 提供，这里备用）。 */
function parseCmsSignerCertificates(buffer) {
  return parsePkcs7Certificates(buffer);
}

module.exports = {
  TAG_CLASS,
  readDerElement,
  readDerChildren,
  derContent,
  parseOidContent,
  readOid,
  readInteger,
  readBigInt,
  readBitStringBytes,
  readStringValue,
  readTimeValue,
  parseAlgorithmIdentifier,
  parseName,
  parseSubjectPublicKeyInfo,
  parseX509Certificate,
  parsePkcs7Certificates,
  parseCmsSignerCertificates,
  extractEmbeddedPlist,
  EC_CURVE_BITS
};
