'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { cleanIpcError, describeError, looksTechnical } = require('../src/lib/errorText');

const ROOT = path.join(__dirname, '..');

// ==================== 前缀清洗 ====================

test('strips the prefix electron adds to ipc failures', () => {
  const error = new Error("Error invoking remote method 'parse-package-info': Error: 文件不存在");
  assert.equal(cleanIpcError(error), '文件不存在');
});

test('strips nested prefixes', () => {
  // 主进程里再套一层 IPC 调用时会叠两层前缀
  const error = new Error(
    "Error invoking remote method 'outer': Error: Error invoking remote method 'inner': Error: 真正的错误"
  );
  assert.equal(cleanIpcError(error), '真正的错误');
});

test('strips the prefix even when there is no inner "Error:" label', () => {
  assert.equal(cleanIpcError("Error invoking remote method 'x': 出错了"), '出错了');
});

test('leaves a clean message untouched', () => {
  assert.equal(cleanIpcError(new Error('设备未连接')), '设备未连接');
});

// ==================== 各种输入形态 ====================

test('accepts strings, Errors and message-bearing objects', () => {
  assert.equal(cleanIpcError('直接是字符串'), '直接是字符串');
  assert.equal(cleanIpcError(new Error('标准错误')), '标准错误');
  assert.equal(cleanIpcError({ message: '带 message 的对象' }), '带 message 的对象');
});

test('never renders "[object Object]" to the user', () => {
  // 原来各处用 `String(error?.message || error)`，普通对象会变成 [object Object]
  for (const value of [{ code: 42 }, { err: 'x' }, [], 0, false]) {
    const text = cleanIpcError(value, '操作失败');
    assert.doesNotMatch(text, /\[object/, `输入 ${JSON.stringify(value)} 时不应显示 [object Object]`);
  }
});

test('falls back when there is nothing usable', () => {
  assert.equal(cleanIpcError(null), '操作失败');
  assert.equal(cleanIpcError(undefined), '操作失败');
  assert.equal(cleanIpcError(''), '操作失败');
  assert.equal(cleanIpcError('   '), '操作失败');
  assert.equal(cleanIpcError(null, '保存失败'), '保存失败');
});

test('a message that is only the prefix also falls back', () => {
  // 剥完前缀后为空，不能让界面出现一个空白提示
  assert.equal(cleanIpcError("Error invoking remote method 'x': Error: "), '操作失败');
});

// ==================== 技术细节判断 ====================

test('detects messages that still leak technical detail', () => {
  assert.equal(looksTechnical('Error invoking remote method'), true);
  assert.equal(looksTechnical('ENOENT: no such file'), true);
  assert.equal(looksTechnical('TypeError: x is not a function'), true);
  assert.equal(looksTechnical('设备未连接'), false);
  assert.equal(looksTechnical('文件不存在'), false);
});

test('describeError splits user-facing text from technical detail', () => {
  const error = new Error("Error invoking remote method 'x': Error: 磁盘已满");
  const result = describeError(error);
  assert.equal(result.message, '磁盘已满');
  assert.equal(typeof result.detail, 'string');
});

test('describeError tolerates non-Error values', () => {
  for (const value of ['字符串错误', null, { message: '对象错误' }, 0]) {
    assert.doesNotThrow(() => describeError(value));
  }
});

// ==================== 回归守卫：不许再复制一份 ====================

test('no component re-implements error text locally', () => {
  // 这段逻辑曾被复制 17 份（其中 3 份还没清洗前缀）。
  // 再复制一份就又会回到「有的地方处理了、有的没处理」。
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
      if (/Error invoking remote method|const ipcErrorText|const getErrorMessage/.test(line)) {
        offenders.push(path.relative(ROOT, file) + ':' + (index + 1));
      }
    });
  }
  assert.deepEqual(offenders, [], '这些地方又自己实现了一份错误文案：\n' + offenders.join('\n'));
});

test('all 17 former call sites now import the shared helper', () => {
  const files = [
    'ApkInfo', 'BatchScan', 'Settings', 'SignApk', 'HttpClient',
    'BatchRename', 'CodeSearch', 'DeviceApps', 'DeviceControl',
    'FileManager', 'InstallApk', 'IosMirror', 'PhoneDeviceInfo', 'PlatformMatrix',
    'LogViewer', 'EnvironmentCheck', 'WebFileServer'
  ];
  const missing = [];
  for (const name of files) {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'components', name + '.jsx'), 'utf8');
    if (!source.includes('cleanIpcError')) missing.push(name);
  }
  assert.deepEqual(missing, [], '这些文件应使用共享的错误文案函数：' + missing.join(', '));
});
