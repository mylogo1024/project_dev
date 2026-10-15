'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { formatRenderError, shouldResetError } = require('../src/lib/renderError');

const ROOT = path.join(__dirname, '..');

test('render error text carries message, stack and component stack', () => {
  const error = new Error('Cannot read properties of undefined');
  const text = formatRenderError(error, '\n    in Foo\n    in Bar');
  assert.match(text, /Cannot read properties of undefined/, '要包含错误消息');
  assert.match(text, /renderer-stability/, '要包含 JS 堆栈');
  assert.match(text, /in Foo/, '要包含组件栈，否则定位不到是哪个组件');
});

test('render error text survives non-Error throws', () => {
  // 有人会 throw 字符串、throw 对象，甚至 throw null —— 整理逻辑不能因此二次抛出
  for (const value of ['plain string', { code: 42 }, null, undefined, 0]) {
    let text;
    assert.doesNotThrow(() => { text = formatRenderError(value); }, `throw ${String(value)} 时不该抛`);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, '至少要给出「未知错误」而不是空字符串');
  }
  assert.match(formatRenderError(null), /未知错误/);
});

test('component stack is omitted when absent', () => {
  const text = formatRenderError(new Error('boom'));
  assert.doesNotMatch(text, /组件栈/, '没有组件栈时不要留一个空标题');
});

test('reset decision only fires when the reset key actually changed', () => {
  assert.equal(shouldResetError(true, 'a', 'b'), true);
  assert.equal(shouldResetError(true, 'a', 'a'), false, 'key 没变不能清错误状态');
  assert.equal(shouldResetError(false, 'a', 'b'), false, '本来就没错，不需要清');
});

test('the app wraps every function panel in an error boundary', () => {
  // React 渲染期抛错会卸载整棵树 → 白屏。没有错误边界的话，
  // 任意一个工具组件出问题都会让整个应用不可用。
  const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  assert.match(app, /import ErrorBoundary from/, 'App 应引入错误边界');

  // 精确切出错误边界标签之间的内容，别用「多少字符以内」这种脆断言
  const start = app.indexOf('<ErrorBoundary');
  const end = app.indexOf('</ErrorBoundary>', start);
  assert.ok(start >= 0 && end > start, 'App 应使用错误边界');
  const block = app.slice(start, end);
  assert.match(block, /renderFunction\(/, '功能面板要被错误边界包住');
  assert.match(block, /resetKey=/, '错误边界需要 resetKey 才能从错误里恢复');
  assert.match(block, /onReset=/, '错误边界需要提供恢复入口');
});

test('the entry point wraps App itself', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
  assert.match(entry, /<ErrorBoundary/, '入口应包一层最外层错误边界');
  assert.match(entry, /unhandledrejection/, '渲染层未处理的 Promise 拒绝至少要有记录');
});

// ==================== 兜底 UI 真的会渲染 ====================
// 直接调用 render() 检查返回的元素树 —— 不需要 DOM，也不需要 Electron，
// 但能证明「出错时用户看到的是兜底页」而不是白屏。

const Module = require('node:module');
const esbuild = require('esbuild');

/**
 * Node 本身解析不了 JSX，用 esbuild（已是 devDependency）即时编译成 CJS 再执行。
 * 这样 .jsx 组件也能被单测覆盖，而不只是测抽出来的纯函数。
 */
function loadJsx(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'jsx',
    format: 'cjs',
    jsx: 'automatic',
    target: 'node18'
  });
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(code, filename);
  return mod.exports.default || mod.exports;
}

const ErrorBoundary = loadJsx('src/components/common/ErrorBoundary.jsx');

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((child) => collectText(child, out)); return out; }
  if (node.props) collectText(node.props.children, out);
  return out;
}

test('the fallback UI renders when an error is present', () => {
  const instance = new ErrorBoundary({ title: '「JSON 工具」出错了', onReset: () => {} });
  instance.state = { error: new Error('boom'), componentStack: '' };

  const tree = instance.render();
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'error-boundary');

  const text = collectText(tree).join(' ');
  assert.match(text, /JSON 工具/, '标题要带上出问题的功能名');
  assert.match(text, /boom/, '要显示错误内容');
  assert.match(text, /重新加载此功能/, '要有恢复入口');
  assert.match(text, /复制错误信息/, '要能一键复制反馈');
});

test('no error means children pass through untouched', () => {
  const child = { type: 'span', props: { children: 'ok' } };
  const instance = new ErrorBoundary({ children: child });
  assert.equal(instance.render(), child, '没出错时必须原样渲染子节点');
});

test('fallback still renders without an onReset handler', () => {
  // 最外层边界用的是 location.reload，但组件不能强依赖这个回调
  const instance = new ErrorBoundary({});
  instance.state = { error: new Error('x'), componentStack: '' };
  assert.doesNotThrow(() => instance.render());
});
