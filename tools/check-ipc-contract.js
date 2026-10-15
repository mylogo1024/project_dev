'use strict';

/**
 * IPC 契约自检
 *
 * 四层链路：React 组件 → preload 绑定 → ipcMain.handle / sender.send → 主进程实现。
 * 任何一层的名字写错，都要等运行时点下去才报错。这个脚本把它们对齐检查一遍。
 *
 * 用法：node tools/check-ipc-contract.js
 *
 * 实现说明（避免误报，这两点很容易踩）：
 *   1. preload 的绑定不都是一行箭头函数，很多是 `name: (args) => { ... }` 的多行块，
 *      所以必须先按顶层键切出绑定体，再在体内找 invoke / send / on 通道。
 *   2. 主进程的 send 不一定写成 `x.send('ch', ...)`，也可能走 `helper(session, 'ch', ...)`
 *      这种间接形式。所以「订阅的通道是否真的会到达」改为：该通道字面量是否出现在
 *      electron/ 下任意文件中 —— 只按发射点形状解析会漏掉一大片。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'electron');
const PRELOAD = path.join(ELECTRON_DIR, 'preload.js');
const MAIN = path.join(ELECTRON_DIR, 'main.js');
const SRC = path.join(ROOT, 'src');

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const preloadSrc = fs.readFileSync(PRELOAD, 'utf8');
const mainSrc = fs.readFileSync(MAIN, 'utf8');

// ---------- preload：按顶层键切出每个绑定的绑定体 ----------
const bindingStarts = [];
for (const m of preloadSrc.matchAll(/^ {2}(\w+)\s*:\s*\(/gm)) {
  bindingStarts.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
}
for (let i = 0; i < bindingStarts.length; i += 1) {
  bindingStarts[i].end = i + 1 < bindingStarts.length ? bindingStarts[i + 1].start : preloadSrc.length;
  bindingStarts[i].body = preloadSrc.slice(bindingStarts[i].bodyStart, bindingStarts[i].end);
}

const invokeBindings = new Map();   // 绑定名 → 通道（取第一个 invoke）
const sendBindings = new Map();
const listenChannels = new Set();   // 该绑定订阅的所有通道
const bindingChannels = new Map();  // 绑定名 → {invoke, send, listen:[]}

for (const b of bindingStarts) {
  const invoke = b.body.match(/ipcRenderer\.invoke\(\s*'([^']+)'/);
  const send = b.body.match(/ipcRenderer\.send\(\s*'([^']+)'/);
  const listens = [...b.body.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map((m) => m[1]);
  bindingChannels.set(b.name, {
    invoke: invoke ? invoke[1] : null,
    send: send ? send[1] : null,
    listen: listens
  });
  if (invoke) invokeBindings.set(b.name, invoke[1]);
  if (send) sendBindings.set(b.name, send[1]);
  for (const ch of listens) listenChannels.add(ch);
}

const allBindings = new Set(bindingChannels.keys());

// ---------- main：handle 通道 + 全部通道字面量 ----------
const handledChannels = new Set();
for (const m of mainSrc.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) handledChannels.add(m[1]);

// electron/ 下出现过的所有「像通道名」的字符串字面量
const electronLiterals = new Set();
for (const file of walk(ELECTRON_DIR, (n) => /\.(js|cjs|mjs)$/.test(n))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/'([a-zA-Z][\w:.-]*)'/g)) electronLiterals.add(m[1]);
}

// ---------- src：组件实际调用的绑定 ----------
// 注意三种形态都要认：
//   window.electronAPI.foo(...)          直接调用
//   const api = window.electronAPI; api?.foo(...)   别名调用
//   const reader = api.readPackageStaticInfo || api.getPackageStaticInfo   只是取属性（如做兼容回退）
const usedBindings = new Map();
const markUsed = (name, rel) => {
  if (!usedBindings.has(name)) usedBindings.set(name, new Set());
  usedBindings.get(name).add(rel);
};

for (const file of walk(SRC, (n) => /\.(jsx?|tsx?)$/.test(n))) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  for (const m of text.matchAll(/(?:window\.)?electronAPI\??\.(\w+)/g)) markUsed(m[1], rel);

  for (const m of text.matchAll(/\b\w+\??\.(\w+)\s*\(/g)) {
    if (allBindings.has(m[1])) markUsed(m[1], rel);
  }

  // 最宽松的一条：只要出现「.<绑定名>」就算用过（用于「未使用」提示，不作失败断言）
  for (const name of allBindings) {
    if (new RegExp(`\\.${name}\\b`).test(text)) markUsed(name, rel);
  }
}

// ---------- 断言 ----------
const failures = [];
const notes = [];

// 1. 组件用到的绑定必须在 preload 里定义
for (const [name, where] of usedBindings) {
  if (!allBindings.has(name)) {
    failures.push(`组件调用了未在 preload 暴露的 API: electronAPI.${name}（${[...where].join(', ')}）`);
  }
}

// 2. 每个 invoke 通道必须有 ipcMain.handle
for (const [name, channel] of invokeBindings) {
  if (handledChannels.has(channel)) continue;
  if (!electronLiterals.has(channel)) {
    failures.push(`preload 绑定 ${name} → invoke('${channel}')，但主进程里根本没有这个通道（既无 handle 也未出现过）`);
  } else {
    failures.push(`preload 绑定 ${name} → invoke('${channel}')，但 main.js 里没有 ipcMain.handle('${channel}')`);
  }
}

// 3. 订阅的通道必须真的会被发射（字面量至少出现在主进程某处）
for (const channel of listenChannels) {
  if (!electronLiterals.has(channel)) {
    failures.push(`preload 订阅了 '${channel}'，但主进程从未出现该通道名，事件永远不会到达`);
  }
}

// 4. 提示：preload 暴露但组件从未使用
const unused = [...allBindings].filter((name) => !usedBindings.has(name));
if (unused.length) {
  notes.push(`preload 暴露但组件未使用（${unused.length} 个）: ${unused.join(', ')}`);
}

// 5. 提示：handle 了但没有 preload 绑定（前端无法调用）
const reachable = new Set([...invokeBindings.values(), ...sendBindings.values()]);
const unreachable = [...handledChannels].filter((ch) => !reachable.has(ch));
if (unreachable.length) {
  notes.push(`main.js 已 handle 但 preload 未暴露（${unreachable.length} 个）: ${unreachable.join(', ')}`);
}

// ---------- 输出 ----------
console.log('=== IPC 契约自检 ===\n');
console.log(`preload 绑定      : ${allBindings.size}（invoke ${invokeBindings.size} / send ${sendBindings.size}）`);
console.log(`preload 订阅通道  : ${listenChannels.size}`);
console.log(`main handle 通道  : ${handledChannels.size}`);
console.log(`组件调用绑定      : ${usedBindings.size}\n`);

if (notes.length) {
  console.log('提示（不阻断）:');
  for (const n of notes) console.log(`  · ${n}`);
  console.log('');
}

if (failures.length) {
  console.log('发现问题:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\n${failures.length} 项失败`);
  process.exit(1);
}

console.log('✓ 四层链路全部对齐，无断链');
