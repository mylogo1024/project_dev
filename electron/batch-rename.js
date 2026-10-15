'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
function uniqueSuffix(name, taken) {
  const text = String(name || '');
  const index = text.lastIndexOf('.');
  const stem = index > 0 ? text.slice(0, index) : text;
  const ext = index > 0 ? text.slice(index) : '';
  let n = 1;
  let next = text;
  while (taken.has(next.toLowerCase())) {
    next = `${stem} (${n})${ext}`;
    n += 1;
  }
  return next;
}

function describeFile(filePath, stat) {
  const parsed = path.parse(filePath);
  return {
    id: filePath,
    path: filePath,
    dir: parsed.dir,
    name: parsed.base,
    parentName: path.basename(parsed.dir),
    size: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    birthtime: stat.birthtimeMs
  };
}

function shouldSkip(name) {
  return name === '.DS_Store' || name === 'Thumbs.db';
}

function matchFilter(name, filter) {
  const text = String(filter || '').trim();
  if (!text) return true;
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  const allowed = text.split(/[,;\s]+/).map((item) => item.replace(/^\./, '').toLowerCase()).filter(Boolean);
  return allowed.includes(ext);
}

function collectFromPath(target, options, out, depth = 0) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return;
  }
  if (stat.isFile()) {
    if (!shouldSkip(path.basename(target)) && matchFilter(path.basename(target), options.filter)) {
      out.push(describeFile(target, stat));
    }
    return;
  }
  if (!stat.isDirectory()) return;
  if (depth > 0 && options.recursive === false) return;
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isFile()) {
      if (!shouldSkip(entry.name) && matchFilter(entry.name, options.filter)) {
        try {
          out.push(describeFile(full, fs.statSync(full)));
        } catch (_) { /* 单个文件 stat 失败（权限 / 已被删除）就跳过它，不影响整批 */ }
      }
    } else if (entry.isDirectory() && options.recursive !== false) {
      collectFromPath(full, options, out, depth + 1);
    }
  }
}

function collectFiles(paths, options = {}) {
  const out = [];
  const seen = new Set();
  for (const item of paths || []) {
    const resolved = path.resolve(String(item || ''));
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    collectFromPath(resolved, options, out);
  }
  return out;
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function applyRenames(operations, options = {}) {
  const conflict = options.conflict || 'suffix';
  const results = [];
  const taken = new Set();
  const sources = new Set((operations || []).map((item) => path.resolve(item.from)));

  for (const op of operations || []) {
    const from = path.resolve(op.from);
    let to = path.resolve(op.to);
    if (from === to) {
      results.push({ from, to, status: 'unchanged' });
      continue;
    }
    if (!fs.existsSync(from)) {
      results.push({ from, to, status: 'missing', error: '原文件不存在' });
      continue;
    }
    const exists = await pathExists(to);
    const vacating = sources.has(to);
    if ((exists && !vacating) || taken.has(to.toLowerCase())) {
      if (conflict === 'skip') {
        results.push({ from, to, status: 'skipped', error: '目标已存在' });
        continue;
      }
      if (conflict === 'suffix') {
        const dir = path.dirname(to);
        const used = new Set(
          fs.readdirSync(dir).map((name) => name.toLowerCase())
        );
        taken.forEach((item) => {
          if (path.dirname(item) === dir.toLowerCase() || path.dirname(to) === dir) {
            used.add(path.basename(item).toLowerCase());
          }
        });
        const nextName = uniqueSuffix(path.basename(to), used);
        to = path.join(dir, nextName);
      }
    }
    const tmp = path.join(path.dirname(to), `.rename-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(to)}`);
    try {
      if (exists && !vacating && conflict === 'overwrite') {
        await fsp.unlink(to);
      }
      if (from.toLowerCase() === to.toLowerCase() && from !== to) {
        await fsp.rename(from, tmp);
        await fsp.rename(tmp, to);
      } else {
        await fsp.rename(from, to);
      }
      taken.add(to.toLowerCase());
      results.push({ from, to, status: 'renamed' });
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) await fsp.rename(tmp, from);
      } catch (_) { /* 回滚失败不掩盖原始错误，下面会如实记录 */ }
      results.push({ from, to, status: 'error', error: error.message });
    }
  }
  return results;
}

async function undoRenames(operations) {
  const reversed = [...(operations || [])].reverse().map((item) => ({ from: item.to, to: item.from }));
  return applyRenames(reversed, { conflict: 'overwrite' });
}

module.exports = {
  collectFiles,
  applyRenames,
  undoRenames,
  uniqueSuffix,
  describeFile
};
