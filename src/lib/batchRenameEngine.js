'use strict';

const ILLEGAL = /[\\/:*?"<>|]/g;

/** 完整 NATO 字母表，比原来 10 个词的选择面大得多。 */
const WORD_BANK = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey',
  'xray', 'yankee', 'zulu'
];

/**
 * 随机字符的字符集。
 * `safe` 去掉了 0/O/1/l/I 这些看错就认不出来的字符 —— 随机名经常要口头念或手输。
 */
const RANDOM_ALPHABETS = {
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  hex: '0123456789abcdef',
  safe: 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
};

function parseFilename(name) {
  const text = String(name || '');
  const index = text.lastIndexOf('.');
  if (index <= 0 || index === text.length - 1) return { stem: text, ext: '' };
  return { stem: text.slice(0, index), ext: text.slice(index + 1) };
}

function sanitizePart(value) {
  return String(value || '').replace(ILLEGAL, '_').replace(/^\.+$/, '_');
}

function joinFilename(stem, ext) {
  const safeStem = sanitizePart(stem).replace(/[. ]+$/g, '') || 'unnamed';
  const safeExt = sanitizePart(ext).replace(/^\./, '');
  return safeExt ? `${safeStem}.${safeExt}` : safeStem;
}

function padNumber(value, width) {
  const sign = value < 0 ? '-' : '';
  const abs = String(Math.abs(value));
  return sign + abs.padStart(Math.max(width, abs.length), '0');
}

function toLetters(index) {
  let n = Math.max(0, index);
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function formatDate(date, compact = true) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return compact ? `${y}${m}${day}` : `${y}-${m}-${day}`;
}

function titleCase(text) {
  return String(text || '').replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function camelCase(text) {
  const parts = String(text || '').split(/[\s._-]+/).filter(Boolean);
  return parts.map((part, index) => {
    const lower = part.toLowerCase();
    if (index === 0) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

function hashSeed(text) {
  let hash = 2166136261;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rng(seed) {
  let a = seed || 1;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChars(length, next, alphabetKey = 'alnum') {
  const alphabet = RANDOM_ALPHABETS[alphabetKey] || RANDOM_ALPHABETS.alnum;
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

/** 随机 UUID v4（版本位与变体位按规范固定）。 */
function randomUuid(next) {
  const hex = '0123456789abcdef';
  const pick = (count) => Array.from({ length: count }, () => hex[Math.floor(next() * 16)]).join('');
  return `${pick(8)}-${pick(4)}-4${pick(3)}-${'89ab'[Math.floor(next() * 4)]}${pick(3)}-${pick(12)}`;
}

/** 从词库随机取若干词，用分隔符连起来。 */
function randomWords(count, next, separator = '-') {
  const size = Math.max(1, Math.min(5, Number(count) || 1));
  const picked = Array.from({ length: size }, () => WORD_BANK[Math.floor(next() * WORD_BANK.length)]);
  return picked.join(separator);
}

/** 随机日期：过去一年内的某一天，格式 YYYYMMDD。 */
function randomDate(next, now = Date.now()) {
  const dayMs = 24 * 60 * 60 * 1000;
  return formatDate(now - Math.floor(next() * 365 * dayMs));
}

function shuffleText(text, next) {
  const chars = [...String(text || '')];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function compareFiles(a, b, sort) {
  const key = sort?.key || 'name';
  const dir = sort?.dir === 'desc' ? -1 : 1;
  let left = a.name;
  let right = b.name;
  if (key === 'ext') {
    left = parseFilename(a.name).ext;
    right = parseFilename(b.name).ext;
  } else if (key === 'size') {
    left = Number(a.size) || 0;
    right = Number(b.size) || 0;
  } else if (key === 'mtime') {
    left = Number(a.mtime) || 0;
    right = Number(b.mtime) || 0;
  } else if (key === 'ctime') {
    left = Number(a.ctime) || Number(a.birthtime) || 0;
    right = Number(b.ctime) || Number(b.birthtime) || 0;
  } else {
    left = String(a.name || '').toLowerCase();
    right = String(b.name || '').toLowerCase();
  }
  if (left < right) return -1 * dir;
  if (left > right) return 1 * dir;
  return String(a.path).localeCompare(String(b.path));
}

function sortFiles(files, sort) {
  const list = [...(files || [])];
  if (sort?.key === 'random') {
    const next = rng(hashSeed(JSON.stringify(list.map((item) => item.path))));
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  list.sort((a, b) => compareFiles(a, b, sort));
  return list;
}

function applyOne(ctx, rule, index) {
  if (!rule || rule.enabled === false) return ctx;
  const type = rule.type;
  let { stem, ext, vars } = ctx;

  if (type === 'extension') {
    if (rule.mode === 'set' && rule.value) ext = String(rule.value).replace(/^\./, '');
    if (rule.mode === 'strip') ext = '';
    if (rule.case === 'lower') ext = ext.toLowerCase();
    if (rule.case === 'upper') ext = ext.toUpperCase();
  }

  if (type === 'case') {
    if (rule.mode === 'upper') stem = stem.toUpperCase();
    if (rule.mode === 'lower') stem = stem.toLowerCase();
    if (rule.mode === 'title') stem = titleCase(stem);
    if (rule.mode === 'sentence') stem = stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();
    if (rule.mode === 'camel') stem = camelCase(stem);
  }

  if (type === 'sequence') {
    const value = Number(rule.start || 0) + index * Number(rule.step || 1);
    const token = rule.letters ? toLetters(value) : padNumber(value, Number(rule.pad || 0));
    const date = rule.datePrefix ? `${formatDate(ctx.mtime || Date.now())}_` : '';
    const piece = `${date}${token}`;
    if (rule.position === 'suffix') stem = `${stem}${rule.separator || '_'}${piece}`;
    else if (rule.position === 'at') {
      const at = Math.max(0, Number(rule.index || 0));
      stem = stem.slice(0, at) + piece + stem.slice(at);
    } else stem = `${piece}${rule.separator || '_'}${stem}`;
  }

  if (type === 'replace' && rule.find) {
    const flags = `${rule.all === false ? '' : 'g'}${rule.caseSensitive ? '' : 'i'}`;
    const escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    stem = stem.replace(new RegExp(escaped, flags || 'g'), rule.replace ?? '');
  }

  if (type === 'insert') {
    let text = rule.text || '';
    if (rule.includeParent) text += ctx.parentName || '';
    if (rule.includeDate) text += formatDate(ctx.mtime || Date.now());
    if (rule.position === 'suffix') stem += text;
    else if (rule.position === 'at') {
      const at = Math.max(0, Number(rule.index || 0));
      stem = stem.slice(0, at) + text + stem.slice(at);
    } else stem = text + stem;
  }

  if (type === 'truncate') {
    const n = Math.max(0, Number(rule.n || 0));
    if (rule.mode === 'keep-start') stem = stem.slice(0, n);
    if (rule.mode === 'keep-end') stem = stem.slice(Math.max(0, stem.length - n));
    if (rule.mode === 'drop-start') stem = stem.slice(n);
    if (rule.mode === 'drop-end') stem = n ? stem.slice(0, Math.max(0, stem.length - n)) : stem;
    if (rule.mode === 'range') {
      const from = Math.max(0, Number(rule.from || 1) - 1);
      const to = Math.max(from, Number(rule.to || stem.length));
      stem = stem.slice(from, to);
    }
  }

  if (type === 'reorganize') {
    const sep = rule.separator === '' ? ' ' : (rule.separator || ' ');
    const parts = stem.split(sep);
    const order = String(rule.order || '').split(/[,\s]+/).map((item) => Number(item) - 1).filter((item) => item >= 0 && item < parts.length);
    if (order.length) stem = order.map((item) => parts[item]).join(rule.joinWith ?? sep);
  }

  if (type === 'segment') {
    let extracted = '';
    if (rule.mode === 'delim') {
      const sep = rule.separator === '' ? ' ' : (rule.separator || ' ');
      const parts = stem.split(sep);
      const which = Math.max(0, Number(rule.index || 1) - 1);
      extracted = parts[which] || '';
    } else if (rule.mode === 'regex' && rule.pattern) {
      try {
        const match = stem.match(new RegExp(rule.pattern));
        extracted = match ? (match[1] || match[0] || '') : '';
        if (match) {
          match.slice(1).forEach((item, offset) => {
            if (item != null) vars[String(offset + 1)] = item;
          });
        }
      } catch (_) { /* 用户写的正则不合法：跳过这条片段规则，不要中断整批 */ }
    } else if (rule.mode === 'range') {
      const from = Math.max(0, Number(rule.from || 1) - 1);
      const to = Math.max(from, Number(rule.to || stem.length));
      extracted = stem.slice(from, to);
    }
    vars[rule.variable || '1'] = extracted;
    if (rule.replaceStem) stem = extracted;
  }

  if (type === 'random') {
    const next = rng(hashSeed(`${ctx.path}:${rule.id || type}:${index}`));
    const length = Math.max(1, Math.min(128, Number(rule.length || 8)));
    const prefix = rule.prefix || '';
    const suffix = rule.suffix || '';

    if (rule.mode === 'shuffle') {
      // 打乱是「改现有名字」，前后缀仍然有意义（比如统一加个前缀）
      stem = `${prefix}${shuffleText(stem, next)}${suffix}`;
    } else {
      let value = '';
      if (rule.mode === 'chars') value = randomChars(length, next, rule.alphabet);
      else if (rule.mode === 'uuid') value = randomUuid(next);
      else if (rule.mode === 'word') value = randomWords(rule.words, next, rule.separator ?? '-');
      else if (rule.mode === 'number') {
        const min = Number(rule.min || 0);
        const max = Number(rule.max || 9999);
        const lo = Math.min(min, max);
        const hi = Math.max(min, max);
        value = String(lo + Math.floor(next() * (hi - lo + 1)));
      }
      stem = `${prefix}${value}${suffix}`;
    }
  }

  if (type === 'remove') {
    if (rule.mode === 'text' && rule.text) stem = stem.split(rule.text).join('');
    if (rule.mode === 'digits') stem = stem.replace(/\d+/g, '');
    if (rule.mode === 'letters') stem = stem.replace(/[a-zA-Z]+/g, '');
    if (rule.mode === 'punct') stem = stem.replace(/[^\w\u4e00-\u9fff]+/g, '');
    if (rule.mode === 'spaces') stem = stem.replace(/\s+/g, '');
    if (rule.mode === 'parens') stem = stem.replace(/[（(\[{【][^）)\]}】]*[）)\]}】]/g, '');
  }

  if (type === 'delete') {
    if (rule.mode === 'trim') stem = stem.trim();
    if (rule.mode === 'dupes') stem = stem.replace(/(.)\1+/g, '$1');
    if (rule.mode === 'prefix' && rule.value && stem.startsWith(rule.value)) stem = stem.slice(rule.value.length);
    if (rule.mode === 'suffix' && rule.value && stem.endsWith(rule.value)) stem = stem.slice(0, -rule.value.length);
  }

  if (type === 'list' && Array.isArray(rule.names) && rule.names[index]) {
    const parsed = parseFilename(rule.names[index]);
    stem = parsed.stem;
    if (parsed.ext) ext = parsed.ext;
  }

  if (type === 'custom' && rule.template) {
    const seq = padNumber(index + Number(rule.start || 1), Number(rule.pad || 0));
    // 同一个文件用同一个种子，模板里出现多个随机变量时互不重复，
    // 同时保证「预览」和「真正执行」生成的名字完全一致
    const next = rng(hashSeed(`${ctx.path}:${rule.id || 'custom'}:${index}`));
    stem = String(rule.template)
      .replace(/%name%/g, ctx.originalStem)
      .replace(/%ext%/g, ext)
      .replace(/%n%/g, seq)
      .replace(/%randdate%/g, randomDate(next))
      .replace(/%date%/g, formatDate(ctx.mtime || Date.now()))
      .replace(/%parent%/g, ctx.parentName || '')
      .replace(/%uuid%/g, randomUuid(next))
      .replace(/%words?(\d*)%/g, (_, count) => randomWords(count || 1, next, '-'))
      .replace(/%random(\d*)%/g, (_, count) => randomChars(Math.max(1, Math.min(64, Number(count) || 6)), next))
      .replace(/\$(\d+)/g, (_, n) => vars[n] || '');
  }

  if (type === 'regex' && rule.pattern) {
    try {
      const flags = rule.flags || 'g';
      const re = new RegExp(rule.pattern, flags);
      stem = stem.replace(re, rule.replace ?? '');
    } catch (_) { /* 同上：正则不合法时保持原文件名 */ }
  }

  return { ...ctx, stem, ext, vars };
}

function applyRules(files, rules, options = {}) {
  const sorted = sortFiles(files, options.sort);
  const used = new Set();
  return sorted.map((file, index) => {
    const parsed = parseFilename(file.name);
    let ctx = {
      ...file,
      originalStem: parsed.stem,
      stem: parsed.stem,
      ext: parsed.ext,
      vars: {},
      parentName: file.parentName || ''
    };
    for (const rule of rules || []) ctx = applyOne(ctx, rule, index);
    let preview = joinFilename(ctx.stem, ctx.ext);
    if (!preview) preview = file.name;
    const dir = file.dir || '';
    const target = dir ? `${dir.replace(/[\\/]+$/, '')}/${preview}` : preview;
    const samePath = target === file.path;
    let status = preview === file.name ? 'unchanged' : 'ready';
    if (!samePath && used.has(target.toLowerCase())) status = 'conflict';
    used.add((samePath ? file.path : target).toLowerCase());
    return {
      ...file,
      preview,
      target,
      status,
      changed: preview !== file.name
    };
  });
}

function uniqueSuffix(name, taken) {
  const parsed = parseFilename(name);
  let n = 1;
  let next = name;
  while (taken.has(next.toLowerCase())) {
    next = joinFilename(`${parsed.stem} (${n})`, parsed.ext);
    n += 1;
  }
  return next;
}

/**
 * 把一批预览结果里的重名目标改成唯一。
 *
 * 随机命名理论上也会撞车（概率极低但不是零），撞了就整条跳过对用户不友好 ——
 * 这里按顺序给后来者补 -2、-3，保证整批目标两两不同，也保证不会覆盖已存在的同名文件。
 */
function ensureUniqueTargets(rows) {
  const used = new Set();
  return (rows || []).map((row) => {
    const dir = row.dir ? String(row.dir).replace(/[\\/]+$/, '') : '';
    const build = (name) => (dir ? `${dir}/${name}` : name);

    let preview = row.preview;
    let target = build(preview);
    if (used.has(target.toLowerCase())) {
      const parsed = parseFilename(preview);
      let n = 2;
      do {
        preview = joinFilename(`${parsed.stem}-${n}`, parsed.ext);
        target = build(preview);
        n += 1;
      } while (used.has(target.toLowerCase()));
    }
    used.add(target.toLowerCase());

    return {
      ...row,
      preview,
      target,
      status: preview === row.name ? 'unchanged' : 'ready',
      changed: preview !== row.name
    };
  });
}

export {
  RANDOM_ALPHABETS,
  ensureUniqueTargets,
  WORD_BANK,
  parseFilename,
  joinFilename,
  sortFiles,
  applyRules,
  uniqueSuffix,
  sanitizePart,
  formatDate,
  randomChars,
  randomUuid,
  randomWords,
  randomDate
};

export default {
  RANDOM_ALPHABETS,
  ensureUniqueTargets,
  WORD_BANK,
  parseFilename,
  joinFilename,
  sortFiles,
  applyRules,
  uniqueSuffix,
  sanitizePart,
  formatDate,
  randomChars,
  randomUuid,
  randomWords,
  randomDate
};
