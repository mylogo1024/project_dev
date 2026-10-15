'use strict';

/**
 * HTTP 请求页里 URL / Query 的纯逻辑。
 *
 * 抽出来是为了能单测：自动拆参数一旦拆错（比如把 `?` 后面的 fragment 也当参数，
 * 或者拼最终 URL 时重复加了 `?`），界面上很难发现，只有请求发出去才暴露。
 */

/** 解析 query 串成键值对数组；允许直接粘整条 URL 或带前导 `?`。 */
export function parseQueryString(text) {
  // 先砍掉 fragment：`?a=1#frag` 里的 #frag 不是参数值的一部分，
  // 不砍的话最后一个参数会变成 "1#frag"，拼回 URL 时还会重复一次
  const raw = String(text || '').trim().replace(/^[^?\s]*\?/, '').split('#')[0];
  if (!raw) return [];
  const search = new URLSearchParams(raw);
  const pairs = [];
  for (const [key, value] of search) pairs.push({ key, value });
  return pairs;
}

/**
 * 把 URL 拆成「不含 query 的 base」和 query 键值对。
 * fragment 会保留在 base 里，避免 `#` 之后的内容被当成参数。
 */
export function splitUrlQuery(url) {
  const text = String(url || '');
  const mark = text.indexOf('?');
  if (mark < 0) return { base: text, params: [], hasQuery: false };

  const hashMark = text.indexOf('#', mark);
  const base = text.slice(0, mark) + (hashMark < 0 ? '' : text.slice(hashMark));
  const query = hashMark < 0 ? text.slice(mark + 1) : text.slice(mark + 1, hashMark);
  return { base, params: parseQueryString(query), hasQuery: true };
}

/** 键值对 → query 串（只取启用的、key 非空的）。 */
export function buildQueryString(pairs) {
  const search = new URLSearchParams();
  for (const pair of pairs || []) {
    const key = String(pair?.key ?? '').trim();
    if (!key || pair?.enabled === false) continue;
    search.append(key, String(pair?.value ?? ''));
  }
  return search.toString();
}

/** 整理：修剪空白、丢掉空 key、按 key+value 去重，可选按 key 排序。 */
export function tidyParamRows(pairs, { sort = false } = {}) {
  const seen = new Set();
  const cleaned = [];
  for (const pair of pairs || []) {
    const key = String(pair?.key ?? '').trim();
    if (!key) continue;
    const value = String(pair?.value ?? '').trim();
    const signature = `${key}\u0000${value}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    cleaned.push({ ...pair, key, value });
  }
  if (sort) {
    cleaned.sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
  }
  return cleaned;
}

/**
 * 拼出最终会发出去的 URL。
 * 后端是把 params 追加到 URL 的 query 上的，所以这里要和后端保持一致：
 * 已有 `?` 就接 `&`，否则接 `?`，fragment 永远留在最后。
 */
export function buildFullUrl(url, pairs) {
  const query = buildQueryString(pairs);
  const text = String(url || '').trim();
  if (!query) return text;
  if (!text) return `?${query}`;

  const hashMark = text.indexOf('#');
  const head = hashMark < 0 ? text : text.slice(0, hashMark);
  const hash = hashMark < 0 ? '' : text.slice(hashMark);
  return `${head}${head.includes('?') ? '&' : '?'}${query}${hash}`;
}

/** 把 query 串合并进已有 URL（自动解析用）。 */
export function mergeQueryIntoUrl(url, pairs) {
  return buildFullUrl(splitUrlQuery(url).base, pairs);
}
