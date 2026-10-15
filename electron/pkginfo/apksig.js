'use strict';

/**
 * APK 签名解析
 *
 * 覆盖 APK Signature Scheme v1（JAR 签名）、v2、v3、v3.1，以及 v4 存在性判定。
 * 全部走纯 JS：v1 读 META-INF/*.RSA|DSA|EC 的 PKCS#7，v2/v3 读 APK Signing Block。
 */

const {
  parsePkcs7Certificates,
  parseSubjectPublicKeyInfo,
  parseX509Certificate,
  readDerElement
} = require('./der');
const { apkSignatureAlgorithmName, hashBuffer } = require('./util');

const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const BLOCK_ID_V2 = 0x7109871a;
const BLOCK_ID_V3 = 0xf05368c0;
const BLOCK_ID_V31 = 0x1b93ad61;
const BLOCK_ID_SOURCE_STAMP = 0x6dff800d;
const BLOCK_ID_VERITY_PADDING = 0x42726577;
const BLOCK_ID_FROSTING = 0x2146444e;

const KNOWN_BLOCK_IDS = {
  [BLOCK_ID_V2]: 'APK Signature Scheme v2',
  [BLOCK_ID_V3]: 'APK Signature Scheme v3',
  [BLOCK_ID_V31]: 'APK Signature Scheme v3.1',
  [BLOCK_ID_SOURCE_STAMP]: 'Source Stamp',
  [BLOCK_ID_VERITY_PADDING]: 'Verity Padding',
  [BLOCK_ID_FROSTING]: 'Frosting'
};

// ==================== 长度前缀读取 ====================

class LengthPrefixedReader {
  constructor(buffer, start = 0, end = buffer.length) {
    this.buffer = buffer;
    this.cursor = start;
    this.end = end;
  }

  get remaining() {
    return this.end - this.cursor;
  }

  readUInt32() {
    if (this.cursor + 4 > this.end) throw new Error('读取长度前缀越界');
    const value = this.buffer.readUInt32LE(this.cursor);
    this.cursor += 4;
    return value;
  }

  readBytes(length) {
    if (this.cursor + length > this.end) throw new Error('读取数据越界');
    const slice = this.buffer.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return slice;
  }

  /** 读取一个长度前缀块，返回新的 reader。 */
  readLengthPrefixed() {
    const length = this.readUInt32();
    const start = this.cursor;
    this.cursor += length;
    return new LengthPrefixedReader(this.buffer, start, start + length);
  }

  /** 读取一个长度前缀序列（连续读取到耗尽）。 */
  readSequence() {
    const items = [];
    while (this.remaining >= 4) {
      items.push(this.readLengthPrefixed());
    }
    return items;
  }
}

// ==================== APK Signing Block ====================

/** 定位并拆解 APK Signing Block。 */
function readApkSigningBlock(zip) {
  const cdOffset = zip.centralDirectoryOffset;
  if (!cdOffset || cdOffset < 32) return null;

  const tail = zip._readRange(cdOffset - 24, 24);
  if (tail.length < 24) return null;
  if (tail.toString('latin1', 8, 24) !== APK_SIG_BLOCK_MAGIC) return null;

  // APK Signing Block 的布局：
  //   [uint64 size_of_block]        ← 不含自身
  //   [ID-value 对...]
  //   [uint64 size_of_block]        ← 与上面同值
  //   [16 字节 magic "APK Sig Block 42"]
  //   [Central Directory]
  //
  // size_of_block 已经把「第二个 size 字段(8) + magic(16)」算进去了，
  // 所以整块长度 = 8 + trailingSize，块起点 = cdOffset - 8 - trailingSize。
  // （早先这里多减了一个 16，导致读到的 leadingSize 是块外数据，
  //   自检必然失败 → 整个函数返回 null → v2/v3/v3.1 全部检测不到，只剩 v1。）
  const trailingSize = Number(tail.readBigUInt64LE(0));
  const blockStart = cdOffset - 8 - trailingSize;
  if (blockStart < 0 || blockStart >= cdOffset) return null;

  const head = zip._readRange(blockStart, 8);
  if (head.length < 8) return null;
  const leadingSize = Number(head.readBigUInt64LE(0));
  if (leadingSize !== trailingSize) return null;

  const pairsLength = trailingSize - 24;
  if (pairsLength < 0) return null;
  const pairs = zip._readRange(blockStart + 8, pairsLength);

  const entries = [];
  let cursor = 0;
  while (cursor + 8 <= pairs.length) {
    const length = Number(pairs.readBigUInt64LE(cursor));
    cursor += 8;
    if (length < 4 || cursor + length > pairs.length) break;
    const id = pairs.readUInt32LE(cursor);
    const value = pairs.subarray(cursor + 4, cursor + length);
    entries.push({
      id,
      idHex: `0x${id.toString(16)}`,
      name: KNOWN_BLOCK_IDS[id] || `未知块 (0x${id.toString(16)})`,
      length: value.length,
      value
    });
    cursor += length;
  }

  return {
    offset: blockStart,
    size: 8 + trailingSize,
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry]))
  };
}

/** 解析 v2/v3 签名者公共部分（signed data / signatures / public key）。 */
function parseSigner(reader, options = {}) {
  const { withSdkRange = false } = options;
  const signedDataReader = reader.readLengthPrefixed();

  // digests
  const digestsReader = signedDataReader.readLengthPrefixed();
  const digests = [];
  for (const item of digestsReader.readSequence()) {
    const algorithmId = item.readUInt32();
    const digest = item.readLengthPrefixed().readBytes(item.remaining);
    digests.push({
      algorithm_id: algorithmId,
      algorithm: apkSignatureAlgorithmName(algorithmId),
      digest: hashBuffer(digest, 'sha256'),
      digest_length: digest.length
    });
  }

  // certificates
  const certificatesReader = signedDataReader.readLengthPrefixed();
  const certificates = [];
  for (const item of certificatesReader.readSequence()) {
    const der = item.readBytes(item.remaining);
    certificates.push(der);
  }

  let minSdk = null;
  let maxSdk = null;
  if (withSdkRange) {
    minSdk = signedDataReader.readUInt32();
    maxSdk = signedDataReader.readUInt32();
  }

  // additional attributes（跳过，但要消费掉）
  const attributesReader = signedDataReader.readLengthPrefixed();
  const additionalAttributes = [];
  for (const item of attributesReader.readSequence()) {
    const id = item.readUInt32();
    additionalAttributes.push({ id, idHex: `0x${id.toString(16)}` });
  }

  let signerMinSdk = minSdk;
  let signerMaxSdk = maxSdk;
  if (withSdkRange) {
    signerMinSdk = reader.readUInt32();
    signerMaxSdk = reader.readUInt32();
  }

  // signatures
  const signaturesReader = reader.readLengthPrefixed();
  const signatures = [];
  for (const item of signaturesReader.readSequence()) {
    const algorithmId = item.readUInt32();
    const signature = item.readLengthPrefixed().readBytes(item.remaining);
    signatures.push({
      algorithm_id: algorithmId,
      algorithm: apkSignatureAlgorithmName(algorithmId),
      length: signature.length
    });
  }

  // public key
  const publicKeyReader = reader.readLengthPrefixed();
  const publicKeyDer = publicKeyReader.readBytes(publicKeyReader.remaining);

  let publicKey = { algorithm: '', keySizeLabel: '' };
  try {
    const spki = readDerElement(publicKeyDer, 0);
    publicKey = parseSubjectPublicKeyInfo(publicKeyDer, spki);
    delete publicKey.der;
  } catch (_) {
    // 保留默认值
  }

  return {
    signed_data: {
      digests,
      certificate_count: certificates.length,
      certificate_ders: certificates,
      min_sdk: signerMinSdk,
      max_sdk: signerMaxSdk,
      additional_attributes: additionalAttributes
    },
    signatures,
    public_key: {
      algorithm: publicKey.algorithm,
      key_size: publicKey.keySize,
      key_size_label: publicKey.keySizeLabel,
      curve: publicKey.curve || null,
      sha256: hashBuffer(publicKeyDer, 'sha256')
    }
  };
}

/** 解析 v2 块。 */
function parseV2Block(value) {
  const reader = new LengthPrefixedReader(value);
  const signersReader = reader.readLengthPrefixed();
  const signers = [];
  for (const item of signersReader.readSequence()) {
    signers.push(parseSigner(item, { withSdkRange: false }));
  }
  return { signers };
}

/** 解析 v3 / v3.1 块。 */
function parseV3Block(value) {
  const reader = new LengthPrefixedReader(value);
  const signersReader = reader.readLengthPrefixed();
  const signers = [];
  for (const item of signersReader.readSequence()) {
    signers.push(parseSigner(item, { withSdkRange: true }));
  }
  return { signers };
}

// ==================== v1 签名 ====================

/** MANIFEST.MF 里可能出现的摘要头，从强到弱。 */
const MANIFEST_DIGEST_HEADERS = [
  { header: 'SHA-512-Digest', algorithm: 'sha512' },
  { header: 'SHA-256-Digest', algorithm: 'sha256' },
  { header: 'SHA1-Digest', algorithm: 'sha1' },
  { header: 'MD5-Digest', algorithm: 'md5' }
];

/**
 * 解析 MANIFEST.MF 的分节。
 *
 * 格式是 RFC822 那一套：`Key: Value`，空行分节；
 * 以单个空格开头的行是上一行的续行（长 base64 会被折行，
 * 直接按行切会把摘要截断，导致误判为「不匹配」）。
 */
function parseManifestSections(text) {
  const sections = [];
  let current = null;
  let lastKey = null;

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '') {
      if (current) sections.push(current);
      current = null;
      lastKey = null;
      continue;
    }
    if (line.startsWith(' ') && current && lastKey) {
      current[lastKey] += line.slice(1);      // 续行
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!current) current = {};
    current[key] = line.slice(colon + 1).trim();
    lastKey = key;
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * 校验 v1（JAR）签名是否**真的成立**。
 *
 * 只看 META-INF/*.RSA 在不在会误报。加固 / 重打包之后，签名文件往往
 * 被原样留在包里，但 MANIFEST.MF 记录的摘要早已跟包内实际内容对不上 ——
 * apksigner 对这种情况报 v1 = false，我们要是还报「v1」就是误导。
 * （实测 ysyzad1b_cs9377_sign.apk 就是这种：v2 有效、v1 已失效。）
 *
 * 判据与 jarsigner 一致：MANIFEST.MF 每个分节的 <Alg>-Digest
 * 必须等于对应条目**解压后**内容的摘要。
 */
function verifyV1Manifest(zip, manifestEntry) {
  const empty = { verified: false, checked: 0, mismatched: [], unreadable: [], reason: '' };

  if (!manifestEntry) {
    return { ...empty, reason: '缺少 META-INF/MANIFEST.MF' };
  }

  let text;
  try {
    text = zip.readEntryText(manifestEntry);
  } catch (error) {
    return { ...empty, reason: `MANIFEST.MF 读取失败：${error.message}` };
  }

  const sections = parseManifestSections(text).filter((section) => section.Name);
  if (!sections.length) {
    return { ...empty, reason: 'MANIFEST.MF 中没有任何条目摘要' };
  }

  const mismatched = [];
  const unreadable = [];
  let checked = 0;

  for (const section of sections) {
    const spec = MANIFEST_DIGEST_HEADERS.find((item) => section[item.header]);
    if (!spec) continue;

    const name = section.Name;
    if (name.endsWith('/')) continue;              // 目录条目没有内容

    const entry = zip.find(name);
    if (!entry) {
      mismatched.push({ name, reason: '包内找不到该条目' });
      continue;
    }

    let actual;
    try {
      actual = hashBuffer(zip.readEntry(entry), spec.algorithm, 'base64');
    } catch (error) {
      // 压缩方式不支持、条目损坏等：不算「不匹配」，但要如实记下来
      unreadable.push({ name, reason: error.message });
      continue;
    }

    checked += 1;
    if (actual !== section[spec.header]) {
      mismatched.push({ name, reason: `${spec.header} 不匹配` });
    }
  }

  const verified = checked > 0 && mismatched.length === 0;

  let reason = '';
  if (!verified) {
    if (mismatched.length) {
      reason = `${mismatched.length} 个条目的摘要对不上（APK 可能在 v1 签名后被重打包或加固过）`;
    } else if (unreadable.length) {
      reason = `${unreadable.length} 个条目无法读取，无法完成校验`;
    } else {
      reason = 'MANIFEST.MF 中没有可校验的摘要';
    }
  }

  return { verified, checked, mismatched, unreadable, reason };
}

function readV1Certificates(zip) {
  const signatureFiles = zip.match(/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i);
  const manifest = zip.find('META-INF/MANIFEST.MF');
  const sfFiles = zip.match(/^META-INF\/[^/]+\.SF$/i);
  const certificates = [];
  const errors = [];

  for (const entry of signatureFiles) {
    try {
      const buffer = zip.readEntry(entry);
      const certs = parsePkcs7Certificates(buffer);
      if (!certs.length) errors.push(`${entry.name}: 未解析出证书`);
      for (const cert of certs) certificates.push({ ...cert, source: entry.name });
    } catch (error) {
      errors.push(`${entry.name}: ${error.message}`);
    }
  }

  const verification = verifyV1Manifest(zip, manifest);

  return {
    // present：包里有没有 v1 签名文件（旧语义，保留给「存在性」展示用）
    present: signatureFiles.length > 0,
    // verified：摘要校验通过，才算真正有效的 v1 签名
    verified: verification.verified && signatureFiles.length > 0,
    verification,
    signature_files: signatureFiles.map((entry) => ({
      name: entry.name,
      size: entry.size,
      size_human: null,
      algorithm: entry.name.split('.').pop().toUpperCase()
    })),
    sf_files: sfFiles.map((entry) => entry.name),
    has_manifest: Boolean(manifest),
    manifest_size: manifest ? manifest.size : 0,
    certificates,
    errors
  };
}

// ==================== 汇总 ====================

function normalizeCertificate(cert) {
  return {
    subject: cert.subject.full,
    subject_cn: cert.subject.commonName,
    subject_org: cert.subject.organization,
    subject_ou: cert.subject.organizationalUnit,
    subject_country: cert.subject.country,
    issuer: cert.issuer.full,
    issuer_cn: cert.issuer.commonName,
    issuer_org: cert.issuer.organization,
    serial: cert.serial,
    serial_hex: cert.serial_hex,
    not_before: cert.not_before,
    not_after: cert.not_after,
    is_expired: cert.is_expired,
    signature_algorithm: cert.signature_algorithm,
    public_key: cert.public_key,
    sha256: cert.fingerprints.sha256,
    sha1: cert.fingerprints.sha1,
    md5: cert.fingerprints.md5,
    der: cert.der,
    version: cert.version
  };
}

const DEBUG_SIGNATURE_HINTS = [
  /CN=Android Debug/i,
  /CN=AndroidDebug/i,
  /O=Android,\s*C=US/i
];

const WEAK_SIGNATURE_ALGORITHMS = [
  /^MD5with/i,
  /^SHA1with/i,
  /^SHA1withRSAEncryption$/i
];

function isDebugCertificate(cert) {
  const text = `${cert.subject?.full || ''} ${cert.issuer?.full || ''} ${cert.subject_cn || ''}`;
  return DEBUG_SIGNATURE_HINTS.some((pattern) => pattern.test(text));
}

function isWeakCertificate(cert) {
  if (WEAK_SIGNATURE_ALGORITHMS.some((pattern) => pattern.test(cert.signature_algorithm || ''))) return true;
  if (cert.public_key?.algorithm === 'RSA' && cert.public_key?.keySize && cert.public_key.keySize < 2048) return true;
  if (cert.public_key?.algorithm === 'EC' && cert.public_key?.keySize && cert.public_key.keySize < 256) return true;
  return false;
}

/**
 * 解析 APK 签名信息。
 * @param {import('./zip').ZipArchive} zip
 */
function parseApkSignature(zip) {
  const block = readApkSigningBlock(zip);
  const v1Raw = readV1Certificates(zip);

  let v2 = null;
  let v3 = null;
  let v31 = null;
  const extraBlocks = [];

  if (block) {
    for (const entry of block.entries) {
      try {
        if (entry.id === BLOCK_ID_V2) v2 = parseV2Block(entry.value);
        else if (entry.id === BLOCK_ID_V3) v3 = parseV3Block(entry.value);
        else if (entry.id === BLOCK_ID_V31) v31 = parseV3Block(entry.value);
        else if (entry.id !== BLOCK_ID_VERITY_PADDING) {
          extraBlocks.push({ id: entry.idHex, name: entry.name, length: entry.length });
        }
      } catch (error) {
        extraBlocks.push({ id: entry.idHex, name: `${entry.name}（解析失败: ${error.message}）`, length: entry.length });
      }
    }
  }

  // 汇总所有证书（v3 优先，其次 v2，最后 v1）
  const schemeCertificates = [];
  const seenFingerprints = new Set();

  const collectFromSigners = (signers, scheme) => {
    const results = [];
    for (const signer of signers || []) {
      const chain = [];
      for (const der of signer.signed_data.certificate_ders) {
        const fingerprint = hashBuffer(der, 'sha256');
        if (seenFingerprints.has(fingerprint)) continue;
        seenFingerprints.add(fingerprint);
        try {
          const cert = normalizeCertificate(parseX509Certificate(der));
          cert.scheme = scheme;
          chain.push(cert);
          schemeCertificates.push(cert);
        } catch (_) {
          // 跳过无法解析的证书
        }
      }
      results.push({ scheme, chain });
    }
    return results;
  };

  const v3SignerChains = collectFromSigners(v3?.signers, 'v3');
  const v31SignerChains = collectFromSigners(v31?.signers, 'v3.1');
  const v2SignerChains = collectFromSigners(v2?.signers, 'v2');
  const v1Certificates = v1Raw.certificates.map((cert) => {
    const fingerprint = cert.fingerprints.sha256;
    if (seenFingerprints.has(fingerprint)) return null;
    seenFingerprints.add(fingerprint);
    const normalized = normalizeCertificate(cert);
    normalized.scheme = 'v1';
    schemeCertificates.push(normalized);
    return normalized;
  }).filter(Boolean);

  const primary = schemeCertificates[0] || null;
  const now = Date.now();

  const expired = schemeCertificates.filter((cert) => cert.is_expired).map((cert) => cert.subject_cn || cert.subject);
  const debug = schemeCertificates.length > 0 && schemeCertificates.every((cert) => isDebugCertificate(cert));
  const selfSigned = schemeCertificates.length > 0
    && schemeCertificates.every((cert) => cert.subject === cert.issuer);
  const weak = schemeCertificates.some((cert) => isWeakCertificate(cert));

  // v2 / v3 证书集合是否一致
  const fingerprintsOf = (chains) => {
    const set = new Set();
    for (const chain of chains) for (const cert of chain.chain) set.add(cert.sha256);
    return set;
  };
  const v2Set = fingerprintsOf(v2SignerChains);
  const v3Set = fingerprintsOf([...v3SignerChains, ...v31SignerChains]);
  let consistent = null;
  if (v2Set.size && v3Set.size) {
    consistent = v2Set.size === v3Set.size && [...v2Set].every((item) => v3Set.has(item));
  }

  // 只把「真正校验通过」的方案算进签名方案列表 —— 跟 apksigner 对齐。
  // v1 尤其要注意：包里留着 META-INF/*.RSA 不代表签名还有效。
  const schemes = [];
  if (v1Raw.verified) schemes.push('v1');
  if (v2) schemes.push('v2');
  if (v3) schemes.push('v3');
  if (v31) schemes.push('v3.1');

  const signed = schemes.length > 0;

  // v1 签名文件在、但摘要对不上：说明签名后被改过（重打包 / 加固）
  const v1Stale = v1Raw.present && !v1Raw.verified;

  // 一个有效方案都没有、但包里明明躺着 v1 签名文件时，
  // 别直接说「未签名」—— 那正是用户会怀疑「明明签了怎么说没签」的场景。
  const schemeLabel = schemes.length
    ? schemes.join(' + ')
    : (v1Stale ? '签名无效（v1 摘要不匹配）' : '未签名');

  const stripCert = (cert) => {
    const { der, ...rest } = cert;
    return { ...rest, der_length: der ? der.length : 0 };
  };

  return {
    signed,
    signed_schemes: schemes,
    scheme_label: schemeLabel,
    v1: {
      signed: v1Raw.verified,
      present: v1Raw.present,
      verified: v1Raw.verified,
      stale: v1Stale,
      stale_reason: v1Stale ? v1Raw.verification.reason : '',
      verified_entry_count: v1Raw.verification.checked,
      mismatched_entries: v1Raw.verification.mismatched.slice(0, 20),
      signature_files: v1Raw.signature_files,
      sf_files: v1Raw.sf_files,
      has_manifest: v1Raw.has_manifest,
      certificate_count: v1Raw.certificates.length,
      errors: v1Raw.errors
    },
    v2: { signed: Boolean(v2), signer_count: v2 ? v2.signers.length : 0, signers: v2 ? v2.signers.map((s) => ({ ...s, signed_data: { ...s.signed_data, certificate_ders: undefined } })) : [] },
    v3: { signed: Boolean(v3), signer_count: v3 ? v3.signers.length : 0, signers: v3 ? v3.signers.map((s) => ({ ...s, signed_data: { ...s.signed_data, certificate_ders: undefined } })) : [] },
    v3_1: { signed: Boolean(v31), signer_count: v31 ? v31.signers.length : 0 },
    v4: {
      signed: false,
      note: 'v4 签名保存在独立的 .idsig 文件中，不随 APK 包体分发'
    },
    signing_block: block ? {
      present: true,
      offset: block.offset,
      size: block.size,
      entry_count: block.entries.length,
      entries: block.entries.map((entry) => ({ id: entry.idHex, name: entry.name, length: entry.length })),
      extra_blocks: extraBlocks
    } : { present: false, offset: null, size: 0, entry_count: 0, entries: [], extra_blocks: [] },
    certificates: schemeCertificates.map(stripCert),
    certificate_chain: v3SignerChains.length
      ? v3SignerChains[0].chain.map(stripCert)
      : (v2SignerChains.length ? v2SignerChains[0].chain.map(stripCert) : v1Certificates.map(stripCert)),
    signer_chains: {
      v1: v1Certificates.map(stripCert),
      v2: v2SignerChains.map((chain) => chain.chain.map(stripCert)),
      v3: v3SignerChains.map((chain) => chain.chain.map(stripCert)),
      v3_1: v31SignerChains.map((chain) => chain.chain.map(stripCert))
    },
    summary: {
      is_debug: debug,
      is_expired: expired.length > 0,
      expired_subjects: expired,
      is_self_signed: selfSigned,
      is_weak_algorithm: weak,
      v2_v3_consistent: consistent,
      v1_stale: v1Stale,
      v1_stale_reason: v1Stale ? v1Raw.verification.reason : '',
      certificate_count: schemeCertificates.length,
      subject: primary ? primary.subject : '',
      issuer: primary ? primary.issuer : '',
      sha256: primary ? primary.sha256 : '',
      sha1: primary ? primary.sha1 : '',
      md5: primary ? primary.md5 : '',
      not_before: primary ? primary.not_before : null,
      not_after: primary ? primary.not_after : null,
      signature_algorithm: primary ? primary.signature_algorithm : '',
      public_key: primary ? primary.public_key : null,
      checked_at: new Date(now)
    }
  };
}

module.exports = {
  APK_SIG_BLOCK_MAGIC,
  BLOCK_ID_V2,
  BLOCK_ID_V3,
  BLOCK_ID_V31,
  BLOCK_ID_SOURCE_STAMP,
  BLOCK_ID_VERITY_PADDING,
  BLOCK_ID_FROSTING,
  KNOWN_BLOCK_IDS,
  LengthPrefixedReader,
  readApkSigningBlock,
  parseV2Block,
  parseV3Block,
  readV1Certificates,
  parseApkSignature,
  isDebugCertificate,
  isWeakCertificate,
  normalizeCertificate
};
