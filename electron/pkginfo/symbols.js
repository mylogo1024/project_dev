'use strict';

/**
 * DEX 符号检索：类名与字符串的浏览 / 搜索。
 *
 * **为什么需要这个**：现有分析只把类名拿来算「混淆率」，用户看不到包里到底有哪些类。
 * 而「这个功能在哪个类」「这个密钥硬编码在哪」是 APK 逆向里最高频的两个问题 ——
 * jadx-gui / Android Studio APK Analyzer 的核心能力就是回答它们。
 *
 * 纯逻辑（类名归一化、包聚合、匹配）都是可单测的函数；
 * 只有 buildSymbolIndex 需要真实的 DEX buffer。
 */

const { readDexClassNames, readDexStrings } = require('./binary');

// 上限是为了别让一个超大包把内存吃光；超了会在结果里标 truncated
const DEFAULT_CLASS_LIMIT = 60000;
const DEFAULT_STRING_LIMIT = 300000;
const DEFAULT_MATCH_LIMIT = 200;

/** `Lcom/a/B;` → `com.a.B`；已经是人话的（或不是描述符）原样返回。 */
function toJavaClassName(descriptor) {
  const text = String(descriptor ?? '');
  if (text.length < 2 || !text.startsWith('L') || !text.endsWith(';')) return text;
  return text.slice(1, -1).replace(/\//g, '.');
}

/** 类所属的包；默认包（没有 `.`）归到 `(默认包)`。 */
function packageOf(className) {
  const index = String(className ?? '').lastIndexOf('.');
  return index > 0 ? String(className).slice(0, index) : '(默认包)';
}

/** 按包聚合类数量，降序返回 —— 一眼看出这个包有多大。 */
function summarizePackages(classes) {
  const counter = new Map();
  for (const item of classes || []) {
    const name = packageOf(item?.name ?? item);
    counter.set(name, (counter.get(name) || 0) + 1);
  }
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * 取出用于匹配的文本。
 * 兼容两种条目形状：类名是 `{name, descriptor, dex}`，字符串是 `{value, dex}`。
 * （曾经只认 `value`，结果「按包名搜类」永远搜不到 —— 类条目里根本没有 value 字段。）
 */
function symbolText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry;
  return String(entry.value ?? entry.name ?? '');
}

/**
 * 大小写不敏感的包含匹配。
 * query 为空表示「全都要」（浏览模式）；返回 total 以便提示「还有多少没显示」。
 */
function matchSymbols(entries, query, limit = DEFAULT_MATCH_LIMIT) {
  const keyword = String(query ?? '').trim().toLowerCase();
  const max = Math.max(1, Number(limit) || DEFAULT_MATCH_LIMIT);

  const matched = [];
  let total = 0;
  for (const entry of entries || []) {
    const value = symbolText(entry);
    if (keyword && !value.toLowerCase().includes(keyword)) continue;
    total += 1;
    if (matched.length < max) matched.push(entry);
  }
  return { matched, total, truncated: total > matched.length };
}

/**
 * 把一批 DEX 读成可检索的符号索引。
 * @param {Array<{name: string, buffer: Buffer}>} dexBuffers
 */
function buildSymbolIndex(dexBuffers, options = {}) {
  const classLimit = Number(options.classLimit) > 0 ? Number(options.classLimit) : DEFAULT_CLASS_LIMIT;
  const stringLimit = Number(options.stringLimit) > 0 ? Number(options.stringLimit) : DEFAULT_STRING_LIMIT;

  const classes = [];
  const strings = [];
  const dexFiles = [];

  for (const item of dexBuffers || []) {
    if (!item?.buffer) continue;
    dexFiles.push(item.name);

    if (classes.length < classLimit) {
      for (const descriptor of readDexClassNames(item.buffer, classLimit - classes.length)) {
        classes.push({ name: toJavaClassName(descriptor), descriptor, dex: item.name });
      }
    }
    if (strings.length < stringLimit) {
      for (const value of readDexStrings(item.buffer, stringLimit - strings.length)) {
        strings.push({ value, dex: item.name });
      }
    }
  }

  return {
    dex_files: dexFiles,
    classes,
    strings,
    packages: summarizePackages(classes),
    totals: {
      classes: classes.length,
      strings: strings.length,
      dex_files: dexFiles.length
    }
  };
}

/**
 * 在索引里检索。
 * @param {object} index buildSymbolIndex 的结果
 * @param {{query?: string, scope?: 'class'|'string'|'all', limit?: number}} [options]
 */
function querySymbolIndex(index, options = {}) {
  const scope = options.scope === 'class' || options.scope === 'string' ? options.scope : 'all';
  const limit = Number(options.limit) > 0 ? Number(options.limit) : DEFAULT_MATCH_LIMIT;
  const query = String(options.query ?? '').trim();
  const browsing = !query;

  const classes = scope === 'string' ? null : matchSymbols(index?.classes, query, limit);
  // 浏览模式下不返回字符串：一个包几十万条，既没用又卡界面
  const strings = scope === 'class' || browsing ? null : matchSymbols(index?.strings, query, limit);

  return {
    query,
    scope,
    browsing,
    totals: index?.totals || { classes: 0, strings: 0, dex_files: 0 },
    packages: browsing ? (index?.packages || []).slice(0, 200) : [],
    classes: classes ? classes.matched : [],
    classes_total: classes ? classes.total : 0,
    classes_truncated: classes ? classes.truncated : false,
    strings: strings ? strings.matched : [],
    strings_total: strings ? strings.total : 0,
    strings_truncated: strings ? strings.truncated : false
  };
}

module.exports = {
  DEFAULT_CLASS_LIMIT,
  DEFAULT_STRING_LIMIT,
  DEFAULT_MATCH_LIMIT,
  buildSymbolIndex,
  matchSymbols,
  packageOf,
  querySymbolIndex,
  summarizePackages,
  symbolText,
  toJavaClassName
};
