'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  dismissToast,
  getToasts,
  pushToast,
  resetToasts,
  subscribeToasts,
  toastError,
  toastSuccess,
  toastWarning
} = require('../src/lib/toastStore');

test.beforeEach(() => resetToasts());

test('pushing a toast notifies subscribers', () => {
  const seen = [];
  const unsubscribe = subscribeToasts((list) => seen.push(list.length));

  pushToast({ type: 'success', text: '已保存' });
  assert.equal(getToasts().length, 1);
  assert.equal(seen.at(-1), 1, '订阅者应收到通知');

  unsubscribe();
  pushToast({ type: 'info', text: '再来一条' });
  assert.equal(seen.at(-1), 1, '退订后不该再收到通知');
});

test('a subscriber that throws does not break the others', () => {
  // 一个坏订阅者不能把整个提示系统带崩
  const seen = [];
  const bad = subscribeToasts(() => { throw new Error('boom'); });
  const good = subscribeToasts((list) => seen.push(list.length));

  assert.doesNotThrow(() => pushToast({ text: 'x' }));
  assert.equal(seen.length, 1);

  bad();
  good();
});

test('empty text is ignored instead of rendering an empty bubble', () => {
  assert.equal(pushToast({ text: '' }), null);
  assert.equal(pushToast({ text: null }), null);
  assert.equal(pushToast({}), null);
  assert.equal(pushToast(), null);
  assert.equal(getToasts().length, 0);
});

test('only the most recent few toasts are kept', () => {
  for (let i = 0; i < 10; i += 1) pushToast({ text: `第 ${i} 条` });
  const list = getToasts();
  assert.equal(list.length, 4, '最多同时显示 4 条，避免刷屏盖住界面');
  assert.equal(list.at(-1).text, '第 9 条');
});

test('each toast gets a unique id', () => {
  const ids = new Set();
  for (let i = 0; i < 20; i += 1) ids.add(pushToast({ text: `t${i}` }));
  assert.equal(ids.size, 20);
});

test('dismissing removes only that toast and is idempotent', () => {
  const first = pushToast({ text: 'a' });
  const second = pushToast({ text: 'b' });

  dismissToast(first);
  assert.deepEqual(getToasts().map((item) => item.text), ['b']);

  // 重复 dismiss 不应出错，也不该误删别的
  assert.doesNotThrow(() => dismissToast(first));
  assert.deepEqual(getToasts().map((item) => item.text), ['b']);

  dismissToast(second);
  assert.equal(getToasts().length, 0);
});

test('toasts auto-dismiss after their timeout', async () => {
  pushToast({ text: '短命', timeout: 20 });
  assert.equal(getToasts().length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(getToasts().length, 0, '超时后应自动消失，不留在界面上');
});

test('timeout 0 means the toast stays until dismissed', async () => {
  const id = pushToast({ text: '常驻', timeout: 0 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(getToasts().length, 1);
  dismissToast(id);
  assert.equal(getToasts().length, 0);
});

test('the typed helpers set the right tone', () => {
  resetToasts();
  toastSuccess('s');
  toastError('e');
  toastWarning('w');
  assert.deepEqual(getToasts().map((item) => item.type), ['success', 'error', 'warning']);
});

test('reset clears state so tests cannot leak into each other', () => {
  pushToast({ text: 'x', timeout: 0 });
  resetToasts();
  assert.equal(getToasts().length, 0);
});

// ==================== 错误提示不自动消失 ====================

test('error toasts stay until dismissed', async () => {
  // 错误详情常常很长，4 秒既读不完也来不及复制，消失后又无处可查。
  // 出错时是用户最需要信息的时刻，不该把信息拿走。
  toastError('解析失败', 'Error: 文件不存在');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(getToasts().length, 1, '错误提示不应自动消失');
  assert.equal(getToasts()[0].type, 'error');
});

test('other tones still auto-dismiss', async () => {
  resetToasts();
  // 用显式短超时验证「会消失」这个机制本身；
  // 默认 4 秒不适合在单测里等，所以这里不依赖默认值。
  pushToast({ type: 'success', text: '已保存', timeout: 20 });
  pushToast({ type: 'warning', text: '请先选择文件', timeout: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(getToasts().length, 0, '成功/警告提示应能自动消失，避免堆在界面上');
});

test('success and warning helpers still use a finite timeout', () => {
  // 防止有人把默认超时也改成 0（那样界面会被提示堆满）
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'toastStore.js'), 'utf8');
  const successLine = /export const toastSuccess = \(text, detail\) => pushToast\(\{ type: 'success', text, detail \}\);/.test(source);
  const warningLine = /export const toastWarning = \(text, detail\) => pushToast\(\{ type: 'warning', text, detail \}\);/.test(source);
  assert.ok(successLine, 'toastSuccess 不应传 timeout（走默认的有限超时）');
  assert.ok(warningLine, 'toastWarning 不应传 timeout（走默认的有限超时）');
});

test('callers can still opt into an auto-dismissing error', async () => {
  resetToasts();
  toastError('临时错误', '', 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(getToasts().length, 0, '显式传 timeout 时应按该时长消失');
});

test('error toasts carry a detail line when given one', () => {
  resetToasts();
  toastError('导出失败', '磁盘空间不足');
  assert.equal(getToasts()[0].detail, '磁盘空间不足');
});

// ==================== 防止 alert 回来 ====================

test('no component uses blocking alert any more', () => {
  // 16 处 alert() 已换成 toast。alert 会阻塞渲染进程，样式也和应用脱节，
  // 所以用测试把它挡在门外。
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');

  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.jsx$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/\balert\s*\(/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `这些地方还在用阻塞式 alert：\n${offenders.join('\n')}`);
});
