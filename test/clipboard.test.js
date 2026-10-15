'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { COPY_REASONS, copyText, copyTextWithToast } = require('../src/lib/clipboard');
const { getToasts, resetToasts } = require('../src/lib/toastStore');

/** 造一个假的 document，记录临时节点是否被正确摘掉。 */
function fakeDocument({ execResult = true, throwOnAppend = false } = {}) {
  const created = [];
  const appended = [];
  const removed = [];
  const doc = {
    body: {
      appendChild(node) {
        if (throwOnAppend) throw new Error('append failed');
        appended.push(node);
      }
    },
    createElement() {
      const node = {
        style: {},
        value: '',
        setAttribute() {},
        select() { this.selected = true; },
        remove() { removed.push(this); }
      };
      created.push(node);
      return node;
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      return execResult;
    }
  };
  return { doc, created, appended, removed };
}

test.beforeEach(() => resetToasts());

// ==================== 正常路径 ====================

test('uses the async clipboard api when available', async () => {
  let written = null;
  const result = await copyText('hello', { clipboard: { writeText: async (v) => { written = v; } } });
  assert.deepEqual(result, { ok: true, via: 'async' });
  assert.equal(written, 'hello');
});

test('falls back to execCommand when the async api throws', async () => {
  // 「窗口没有焦点」/「权限被拒」都会走到这里 —— 这正是原先静默失败的场景
  const { doc, created, removed } = fakeDocument();
  const result = await copyText('hello', {
    clipboard: { writeText: async () => { throw new Error('Document is not focused.'); } },
    document: doc
  });

  assert.equal(result.ok, true);
  assert.equal(result.via, 'execCommand');
  assert.equal(created.length, 1);
  assert.equal(created[0].value, 'hello');
  assert.equal(created[0].selected, true, '必须选中才能复制');
  assert.equal(removed.length, 1, '临时节点必须被摘掉');
});

test('falls back to execCommand when the async api is missing entirely', async () => {
  const { doc } = fakeDocument();
  const result = await copyText('x', { clipboard: null, document: doc });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'execCommand');
});

// ==================== 失败路径：必须如实报告 ====================

test('empty text is reported as a failure, not a success', async () => {
  // 这是「假成功」的根源：没内容也说复制成功
  for (const value of ['', null, undefined]) {
    const result = await copyText(value, { clipboard: { writeText: async () => {} } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, COPY_REASONS.EMPTY);
  }
});

test('reports failure when both paths are unavailable', async () => {
  const result = await copyText('x', { clipboard: null, document: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COPY_REASONS.UNSUPPORTED);
});

test('reports failure when execCommand returns false', async () => {
  const { doc, removed } = fakeDocument({ execResult: false });
  const result = await copyText('x', { clipboard: null, document: doc });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COPY_REASONS.FAILED);
  assert.equal(removed.length, 1, '失败时也要把临时节点摘掉，否则会泄漏 DOM');
});

test('reports failure when appending the helper node throws', async () => {
  const { doc } = fakeDocument({ throwOnAppend: true });
  const result = await copyText('x', { clipboard: null, document: doc });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COPY_REASONS.FAILED);
});

test('a broken document object does not crash the caller', async () => {
  // 缺 execCommand / 缺 body 的宿主环境不应抛异常
  for (const document of [{}, { createElement: () => ({}) }, { createElement: () => ({}), body: null }]) {
    const result = await copyText('x', { clipboard: null, document });
    assert.equal(result.ok, false);
  }
});

// ==================== 带提示的封装：反馈必须与结果一致 ====================

test('toast says success only when the copy actually succeeded', async () => {
  const ok = { clipboard: { writeText: async () => {} } };
  await copyTextWithToast('hello', { env: ok });
  const toasts = getToasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'success');
});

test('toast says failure when the copy failed — never a false success', async () => {
  // 这条直接对应缺陷 #2：原来权限被拒也提示「已复制到剪贴板」
  await copyTextWithToast('hello', { clipboard: null, document: null });
  const toasts = getToasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'error');
  assert.doesNotMatch(toasts[0].text, /已复制/);
});

test('empty content gets a warning rather than a success or an error', async () => {
  await copyTextWithToast('', {});
  const toasts = getToasts();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'warning');
});

test('callers can customise the success wording', async () => {
  const ok = { clipboard: { writeText: async () => {} } };
  await copyTextWithToast('x', { successText: '类名已复制', env: ok });
  assert.equal(getToasts()[0].text, '类名已复制');
});

// ==================== 防止绕过封装 ====================

test('no component calls navigator.clipboard directly any more', () => {
  // 13 处调用点已统一到 lib/clipboard。直接调用会绕过「失败必须说失败」这条保证，
  // 所以用测试把它挡住（与 quality/no-alert 同样的思路）。
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
      if (/navigator\.clipboard/.test(line)) {
        offenders.push(path.relative(ROOT, file) + ':' + (index + 1));
      }
    });
  }
  assert.deepEqual(offenders, [], '这些地方绕过了 lib/clipboard：\n' + offenders.join('\n'));
});
