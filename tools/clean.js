#!/usr/bin/env node
'use strict';

/**
 * 跨平台清理脚本。
 *
 * 原先 package.json 里写的是 `rm -rf dist dist-app node_modules`，
 * 在 Windows 的 cmd / PowerShell 下根本没有 rm，脚本会直接报错。
 * 这里用 Node 实现，三平台行为一致。
 *
 * 用法：
 *   node tools/clean.js                 # 清理 dist / dist-app
 *   node tools/clean.js --all           # 连 node_modules 一起清理
 *   node tools/clean.js dist preview    # 只清理指定目录
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGETS = ['dist', 'dist-app'];
const ALL_TARGETS = ['dist', 'dist-app', 'node_modules'];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function directorySize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try { total += fs.statSync(full).size; } catch (_) { /* 忽略 */ }
      }
    }
  }
  return total;
}

function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const all = process.argv.includes('--all');
  const targets = args.length ? args : (all ? ALL_TARGETS : DEFAULT_TARGETS);

  let removed = 0;
  let freed = 0;

  for (const name of targets) {
    const target = path.resolve(ROOT, name);
    // 安全护栏：只允许删除项目根目录下的直接子目录
    if (path.dirname(target) !== ROOT) {
      console.warn(`跳过 ${name}：不在项目根目录下`);
      continue;
    }
    if (!fs.existsSync(target)) {
      console.log(`跳过 ${name}：不存在`);
      continue;
    }
    const size = directorySize(target);
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
    freed += size;
    console.log(`已删除 ${name}/ （释放 ${formatSize(size)}）`);
  }

  console.log(`\n完成：清理 ${removed} 个目录，释放 ${formatSize(freed)}`);
  if (removed && targets.includes('node_modules')) {
    console.log('提示：node_modules 已删除，请重新执行 npm install');
  }
}

main();
