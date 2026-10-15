'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { escapeHtml, renderMarkdown, sanitizeUrl } = require('../src/lib/markdownHtml');
const { RULES, stripCommentsAndStrings } = require('../tools/check-code-review');

// ==================== Markdown 的 XSS 防护 ====================
// 这组用例来自一个真实缺陷：原来的实现第一步是 `let html = text`，
// 原文不转义直接进 dangerouslySetInnerHTML。在 Electron 里 preload 暴露了完整 API，
// 一次 XSS 就能调用任意 IPC。

test('raw html in markdown is escaped, not executed', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script/i, '不能出现真正的 script 标签');
  assert.match(html, /&lt;script&gt;/, '应当被转义成字面量');
});

test('event handler attributes cannot survive', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  // 整段被转义成纯文本，所以输出里不该有任何真正的 img 标签；
  // 文本里出现 'onerror=' 字样是无害的（它不是属性，只是字面量）
  assert.doesNotMatch(html, /<img/i, '不能出现真正的 img 标签');
  assert.doesNotMatch(html, /<[a-z]+[^>]*onerror/i, '不能出现带事件属性的标签');
  assert.match(html, /&lt;img/);
});

test('javascript: links are neutralised', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.doesNotMatch(html, /javascript:/i, '不能留下可点击的 javascript: 链接');
  assert.doesNotMatch(html, /<a\s/i, '非法地址应降级成纯文本');
  assert.match(html, /点我/);
});

test('data: urls are rejected for both links and images', () => {
  assert.doesNotMatch(renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)'), /data:/i);
  assert.doesNotMatch(renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)'), /data:/i);
});

test('scheme obfuscation with control characters is caught', () => {
  // `java\nscript:` 是经典的绕过写法，去掉空白与控制字符后再判协议
  assert.equal(sanitizeUrl('java\nscript:alert(1)'), '');
  assert.equal(sanitizeUrl('java\tscript:alert(1)'), '');
  assert.equal(sanitizeUrl('\u0000javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('JaVaScRiPt:alert(1)'), '');
});

test('safe urls are still allowed', () => {
  assert.equal(sanitizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(sanitizeUrl('http://example.com'), 'http://example.com');
  assert.equal(sanitizeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(sanitizeUrl('#anchor'), '#anchor');
  assert.equal(sanitizeUrl('/local/path'), '/local/path');
  assert.equal(sanitizeUrl('./relative'), './relative');
  assert.equal(sanitizeUrl(''), '');
});

test('a quote in the url cannot break out of the attribute', () => {
  const html = renderMarkdown('[x](https://a.com/" onmouseover="alert(1))');
  // 引号已经被转义成 &quot;，无法闭合 href 属性
  assert.doesNotMatch(html, /onmouseover="alert/);
  assert.match(html, /&quot;/);
});

test('normal markdown still renders correctly', () => {
  const html = renderMarkdown('# 标题\n\n**粗体** 和 *斜体*\n\n`code`');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test('safe links keep working and open with rel protection', () => {
  const html = renderMarkdown('[官网](https://example.com)');
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /rel="noreferrer noopener"/, '外链要带 rel，避免被反向控制');
});

test('ampersands are escaped exactly once', () => {
  // 转义两次会显示成 &amp;amp;，是常见的过度转义 bug
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
  assert.equal(renderMarkdown('a & b'), 'a &amp; b', '没有换行就不该多出 br');
  assert.equal(renderMarkdown('a & b\n'), 'a &amp; b<br />');
});

test('renderMarkdown tolerates non-string input', () => {
  for (const value of [null, undefined, 0, '']) {
    assert.doesNotThrow(() => renderMarkdown(value));
  }
});

// ==================== 审核器自身 ====================
// 它出过误报（把带注释的空 catch 判成空 catch、把 JSX 嵌套算成超深嵌套），
// 所以它自己的核心步骤也要有测试。

test('comment and string stripping removes content but keeps line numbers', () => {
  const source = [
    'const a = 1; // var x = 1',
    'const b = "var y = 2";',
    "const c = 'var z = 3';",
    'const d = `var w = 4`;',
    'var real = 5;'
  ].join('\n');

  const stripped = stripCommentsAndStrings(source);
  assert.equal(stripped.split('\n').length, 5, '行数必须保持不变，否则行号全错');
  assert.equal(stripped.split('\n').at(-1), 'var real = 5;', '真代码要原样保留');
  assert.doesNotMatch(stripped, /var x|var y|var z|var w/, '注释与字符串里的内容要消失');
});

test('stripping does not eat division operators as if they were regex', () => {
  const source = 'const half = total / 2;\nconst ratio = a / b / c;';
  const stripped = stripCommentsAndStrings(source);
  assert.match(stripped, /total \/ 2/, '除法不能被当成正则字面量吞掉');
  assert.match(stripped, /a \/ b \/ c/);
});

test('the no-empty-catch rule runs on raw source so comments count as an explanation', () => {
  const rule = RULES.find((item) => item.id === 'quality/no-empty-catch');
  assert.ok(rule, '规则应存在');
  assert.equal(rule.raw, true, '必须基于原文判断，否则带注释的空 catch 会被误报');

  assert.equal(rule.check('try { a(); } catch (_) { /* 忽略 */ }').length, 0, '写了原因就不该报');
  assert.equal(rule.check('try { a(); } catch (_) {}').length, 1, '真的空 catch 要报');
});

test('the noisy nesting rule was removed rather than left as noise', () => {
  // 它曾产出 467 条告警（JSX 嵌套也算），没人会看 —— 宁可不要这条规则
  assert.equal(RULES.some((item) => item.id === 'ali/max-nesting'), false);
});

test('every rule declares an id, a severity and a description', () => {
  for (const rule of RULES) {
    assert.match(rule.id, /^(ali|sec|quality)\/[\w-]+$/, `规则 id 不规范：${rule.id}`);
    assert.ok(['error', 'warn'].includes(rule.severity), `${rule.id} 的 severity 非法`);
    assert.ok(rule.desc && rule.desc.length > 4, `${rule.id} 缺少说明`);
    assert.equal(typeof rule.check, 'function');
  }
});

// ==================== 行内豁免 ====================

test('a suppression comment applies to the next code line', () => {
  const { collectSuppressions } = require('../tools/check-code-review');

  const single = collectSuppressions('// code-review-allow sec/no-innerhtml\nel.innerHTML = x;');
  assert.ok(single.lineAllow.get(2)?.has('sec/no-innerhtml'), '应作用到下一行');

  // 块注释跨行时，必须作用到「注释结束后」的那一行 ——
  // 这里曾经偏了一行，导致真实项目里的豁免静默失效
  const block = collectSuppressions(
    '/* code-review-allow sec/no-innerhtml\n   原因写在这里 */\ndangerouslySetInnerHTML = x;'
  );
  assert.ok(block.lineAllow.get(3)?.has('sec/no-innerhtml'), '跨行块注释要作用到注释之后的那一行');
  assert.equal(block.lineAllow.has(2), false, '不能作用到注释自己那一行');
});

test('file-level suppression covers the whole file', () => {
  const { collectSuppressions } = require('../tools/check-code-review');
  const { fileAllow } = collectSuppressions('// code-review-allow-file quality/no-empty-catch\nfoo();');
  assert.ok(fileAllow.has('quality/no-empty-catch'));
});
