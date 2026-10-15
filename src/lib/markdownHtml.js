'use strict';

/**
 * Markdown → HTML（安全版）。
 *
 * **为什么单独抽出来**：原来的实现在组件里手写，第一步就是 `let html = text` ——
 * 原文不转义直接塞进 `dangerouslySetInnerHTML`，等于把 `<script>` / `<img onerror=...>`
 * 原样执行。在 Electron 里 preload 暴露了完整 API，一次 XSS 就能调用任意 IPC
 * （读文件、执行命令…），影响远大于普通网页。
 *
 * 正确顺序是**先转义原文、再插入我们自己生成的标签**：
 * 反过来（先插标签再整体转义）会把标签也转义掉；不转义则原文里的标签会生效。
 */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** 允许的协议：http(s)、mailto、tel，以及相对路径 / 锚点。 */
const SAFE_PROTOCOL = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i;

/**
 * 链接与图片地址的白名单校验。
 * `javascript:` 是 XSS 的经典入口；`data:` 可以用来塞 HTML/脚本，一并拦掉。
 * 先去掉空白与控制字符，避免 `java\nscript:` 这种绕过写法。
 */
export function sanitizeUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';

  const normalized = raw.replace(/[\u0000-\u001f\u007f\s]/g, '');
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(normalized);
  if (hasScheme && !SAFE_PROTOCOL.test(normalized)) return '';

  return raw;
}

/**
 * 把 Markdown 渲染成可安全插入的 HTML。
 * 输入里的一切 HTML 都会被转义成字面量，只有本函数生成的标签才会成为真正的标签。
 */
export function renderMarkdown(text) {
  // 第一步必须是转义 —— 后面的所有替换都只处理我们自己生成的标签
  let html = escapeHtml(text);

  // 标题
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // 粗体 / 斜体
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.*?)_/g, '<em>$1</em>');

  // 代码块（必须在行内代码之前）
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/`(.*?)`/g, '<code>$1</code>');

  // 图片要先于链接处理，否则 `![alt](url)` 会被链接规则先吃掉
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, (match, alt, url) => {
    const safe = sanitizeUrl(url);
    if (!safe) return escapeHtml(alt);
    return `<img src="${safe}" alt="${alt}" style="max-width: 100%;" />`;
  });

  html = html.replace(/\[(.*?)\]\((.*?)\)/g, (match, label, url) => {
    const safe = sanitizeUrl(url);
    // 地址不合法就降级成纯文本，而不是留下一个可点击的危险链接
    if (!safe) return label;
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  // 列表
  html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
  html = html.replace(/^- (.*$)/gim, '<li>$1</li>');
  html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');

  // 引用
  html = html.replace(/^&gt; (.*$)/gim, '<blockquote>$1</blockquote>');

  // 水平线
  html = html.replace(/^---$/gim, '<hr />');
  html = html.replace(/^\*\*\*$/gim, '<hr />');

  // 换行
  html = html.replace(/\n$/gim, '<br />');

  // 把连续的列表项包进 <ul>
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  return html;
}
