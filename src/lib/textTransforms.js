'use strict';

/**
 * 文本工具里新增的纯转换函数。
 *
 * 抽出来是为了能单测：这些编解码/生成逻辑一旦写错（比如实体解码顺序、取模偏置），
 * 从界面上很难看出来。组件只负责把它们接到 UI 上。
 */

const safeFromCodePoint = (code) => {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '\ufffd';
  try {
    return String.fromCodePoint(code);
  } catch (_) {
    return '\ufffd';
  }
};

// ==================== HTML 实体 ====================

const HTML_NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const htmlEncode = (text) => String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);

/**
 * 解码顺序必须是「数字实体 → 命名实体（不含 amp）→ amp 最后」。
 * 否则 `&amp;lt;` 会被先解成 `&lt;` 再解成 `<`，而正确答案是 `&lt;`。
 */
const htmlDecode = (text) => String(text)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(Number.parseInt(dec, 10)))
  .replace(/&(lt|gt|quot|apos|nbsp);/gi, (_, name) => HTML_NAMED[name.toLowerCase()])
  .replace(/&amp;/gi, '&');

// ==================== Unicode 转义 ====================

/** 只转义非 ASCII：中文转成 \uXXXX，纯 ASCII 原样保留，结果仍然可读。 */
const unicodeEscape = (text) => Array.from(String(text)).map((ch) => {
  const code = ch.codePointAt(0);
  if (code < 128) return ch;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}).join('');

const unicodeUnescape = (text) => String(text)
  .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)))
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => safeFromCodePoint(Number.parseInt(hex, 16)));

// ==================== 十六进制 ====================

const hexEncode = (text) => Array.from(new TextEncoder().encode(String(text)))
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

/** 容忍空格、逗号、0x / \x 前缀 —— 从别处粘过来的十六进制常常带这些。 */
const hexDecode = (text) => {
  const cleaned = String(text).replace(/0x|\\x|[\s,]+/gi, '');
  if (!cleaned) return '';
  if (/[^0-9a-fA-F]/.test(cleaned)) throw new Error('包含非十六进制字符');
  if (cleaned.length % 2 !== 0) throw new Error('十六进制位数必须是偶数');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
};

// ==================== JSON 字符串转义 ====================

const jsonEscape = (text) => JSON.stringify(String(text)).slice(1, -1);

const JSON_UNESCAPE_MAP = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** 单趟扫描，避免 `\\u0041` 被拆成两段解错。 */
const jsonUnescape = (text) => String(text).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, body) => {
  if (body[0] === 'u') return safeFromCodePoint(Number.parseInt(body.slice(1), 16));
  return Object.prototype.hasOwnProperty.call(JSON_UNESCAPE_MAP, body) ? JSON_UNESCAPE_MAP[body] : body;
});

// ==================== JWT ====================

function base64UrlDecode(segment) {
  const normalized = String(segment).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const decodeJwt = (text) => {
  const token = String(text).trim().replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('不是有效的 JWT（应形如 header.payload.signature）');
  }

  let header;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]));
  } catch (_) {
    throw new Error('Header 段不是合法的 Base64URL JSON');
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch (_) {
    throw new Error('Payload 段不是合法的 Base64URL JSON');
  }

  const lines = ['— Header —', JSON.stringify(header, null, 2), '', '— Payload —', JSON.stringify(payload, null, 2)];

  const timeClaims = [['iat', '签发时间'], ['nbf', '生效时间'], ['exp', '过期时间']]
    .filter(([key]) => typeof payload[key] === 'number')
    .map(([key, label]) => `${label}（${key}）：${new Date(payload[key] * 1000).toLocaleString('zh-CN')}`);
  if (timeClaims.length) lines.push('', '— 时间 —', ...timeClaims);

  if (typeof payload.exp === 'number') {
    lines.push('', payload.exp * 1000 < Date.now() ? '⚠ 该 token 已过期' : '✓ 该 token 尚未过期');
  }
  lines.push('', `签名段：${parts[2] ? `${parts[2].length} 字符` : '无'}（仅解码，不校验签名）`);
  return lines.join('\n');
};

// ==================== 进制转换 ====================

const RADIX_PAIRS = {
  dec2hex: [10, 16], hex2dec: [16, 10],
  dec2bin: [10, 2], bin2dec: [2, 10],
  dec2oct: [10, 8], oct2dec: [8, 10]
};

/** 逐行转换：某一行不合法只标那一行，不整段失败。 */
const convertRadix = (text, mode) => {
  const [from, to] = RADIX_PAIRS[mode] || RADIX_PAIRS.dec2hex;
  // 按「源进制」允许的数码来校验，否则 'abc' 在十进制输入里会被当成合法十六进制，
  // 结果报「超出范围」这种牛头不对马嘴的错误
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, from);
  const validDigit = new RegExp(`^[${digits}]+$`, 'i');
  return String(text).split(/\r?\n/).map((line) => {
    const raw = line.trim().replace(/^0[xXbBoO]/, '');
    if (!raw) return line;
    if (!validDigit.test(raw)) return `[不是有效数字] ${line}`;
    const value = Number.parseInt(raw, from);
    if (!Number.isFinite(value)) return `[超出范围] ${line}`;
    return value.toString(to).toUpperCase();
  }).join('\n');
};

// ==================== URL 参数 ====================

const queryToJson = (text) => {
  const raw = String(text).trim().replace(/^[^?\s]*\?/, '');
  const params = new URLSearchParams(raw);
  const result = {};
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return JSON.stringify(result, null, 2);
};

const jsonToQuery = (text) => {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('需要是一个 JSON 对象，例如 {"a":1,"b":"x"}');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else if (value !== null && value !== undefined) params.append(key, String(value));
  }
  return params.toString();
};

// ==================== 行处理 ====================

const applyLineOp = (text, mode) => {
  const lines = String(text).split(/\r?\n/);
  switch (mode) {
    case 'number': {
      const width = String(lines.length).length;
      return lines.map((line, index) => `${String(index + 1).padStart(width, ' ')}. ${line}`).join('\n');
    }
    case 'unnumber':
      // 允许「1. 」「2) 」「3、」「4: 」以及纯空格分隔的「5 」
      return lines.map((line) => line.replace(/^\s*\d+(?:\s*[.、:)\]．。]\s*|\s+)/, '')).join('\n');
    case 'shuffle': {
      const copy = [...lines];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.join('\n');
    }
    case 'reverse':
      return [...lines].reverse().join('\n');
    case 'trim':
      return lines.map((line) => line.trim()).join('\n');
    case 'collapse':
      return lines.map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
    case 'blank':
      return lines.filter((line) => line.trim() !== '').join('\n');
    case 'indent':
      return lines.map((line) => (line.trim() ? `  ${line}` : line)).join('\n');
    case 'dedent':
      return lines.map((line) => line.replace(/^(?:\t| {1,4})/, '')).join('\n');
    default:
      return String(text);
  }
};

/** 按行反转字符，保留行序 —— 多行文本整体反转会把行序也打乱，通常不是想要的。 */
const reverseEachLine = (text) => String(text)
  .split(/\r?\n/)
  .map((line) => Array.from(line).reverse().join(''))
  .join('\n');

// ==================== 随机生成 ====================

const pickRandom = (alphabet, size) => {
  const out = [];
  // 拒绝采样，避免 256 % 字母表长度 造成的取模偏置
  const limit = 256 - (256 % alphabet.length);
  while (out.length < size) {
    for (const byte of crypto.getRandomValues(new Uint8Array(Math.max(16, size)))) {
      if (byte < limit && out.length < size) out.push(alphabet[byte % alphabet.length]);
    }
  }
  return out.join('');
};

const makeUuidV4 = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** 输入框里填数字可以指定长度（密码/随机串的字符数、十六进制的字节数）。 */
const generateRandom = (text, mode) => {
  const requested = Number.parseInt(String(text).trim(), 10);
  const length = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 4096) : null;

  if (mode === 'uuid') return makeUuidV4();
  if (mode === 'password') {
    return pickRandom('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+', length || 20);
  }
  if (mode === 'string') {
    return pickRandom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', length || 24);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length || 16));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

// ==================== 字典（Python / JS 字面量）↔ JSON ====================

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * 把 Python dict / JS 对象字面量转成严格 JSON。
 *
 * 处理：单引号字符串、裸键、True/False/None、# 与 // 注释、尾随逗号。
 * 用逐字符扫描而不是正则替换 —— 字符串里的逗号、冒号、引号不能被误伤。
 */
const dictToJson = (source) => {
  const src = String(source);
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // 字符串：原样取出，再按 JSON 规则重新加引号
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let body = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          const next = src[i + 1];
          if (next === quote) {
            // 转义的分隔符还原成字面量，后面再统一转义
            body += quote;
            i += 2;
            continue;
          }
          body += c + (next ?? '');
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          closed = true;
          break;
        }
        body += c;
        i += 1;
      }
      if (!closed) throw new Error('字符串没有闭合');
      out += `"${body.replace(/"/g, '\\"')}"`;
      continue;
    }

    // 注释
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('块注释没有闭合');
      i = end + 2;
      continue;
    }

    // 标识符：可能是裸键，也可能是 True/False/None
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      const word = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k += 1;

      if (src[k] === ':') out += `"${word}"`;                       // 裸键
      else if (word === 'True') out += 'true';
      else if (word === 'False') out += 'false';
      else if (word === 'None') out += 'null';
      else out += word;                                             // 其余交给 JSON.parse 判错
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  // 尾随逗号
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.stringify(JSON.parse(out), null, 2);
};

const dictStringify = (value, depth) => {
  const pad = '  '.repeat(depth);
  const padInner = '  '.repeat(depth + 1);

  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((item) => padInner + dictStringify(item, depth + 1)).join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  const body = entries
    .map(([key, item]) => `${padInner}'${String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}': ${dictStringify(item, depth + 1)}`)
    .join(',\n');
  return `{\n${body}\n${pad}}`;
};

/** JSON → Python dict 字面量（单引号、True/False/None）。 */
const jsonToDict = (text) => {
  const data = JSON.parse(text);
  return dictStringify(data, 0);
};

export {
  applyLineOp,
  convertRadix,
  decodeJwt,
  dictToJson,
  generateRandom,
  hexDecode,
  hexEncode,
  htmlDecode,
  htmlEncode,
  jsonEscape,
  jsonToDict,
  jsonToQuery,
  jsonUnescape,
  makeUuidV4,
  queryToJson,
  reverseEachLine,
  unicodeEscape,
  unicodeUnescape
};
