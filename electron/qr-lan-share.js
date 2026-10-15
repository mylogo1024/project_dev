'use strict';

/**
 * 把本机文件放进局域网文件服务的根目录，拼出可扫码下载的 URL。
 * 不负责启停 HTTP 服务——那是 web-file-server 的事。
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const SHARE_DIR = '.toolbox-qr';

function toDownloadUrl(pageUrl, relativePath) {
  if (typeof pageUrl !== 'string' || !pageUrl) throw new TypeError('pageUrl is required');
  const posix = String(relativePath || '').split(path.sep).join('/');
  if (!posix) throw new TypeError('relativePath is required');
  const url = new URL(pageUrl);
  url.pathname = '/api/download';
  url.searchParams.set('path', posix);
  return url.toString();
}

function sanitizeShareName(name) {
  let cleaned = path.basename(String(name || '')).replace(/[/\\\0<>:"|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') cleaned = 'file';
  const stem = cleaned.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) cleaned = `_${cleaned}`;
  if (Buffer.byteLength(cleaned, 'utf8') > 255) {
    const ext = path.extname(cleaned);
    const maxStem = Math.max(1, 255 - Buffer.byteLength(ext, 'utf8'));
    let stemBytes = Buffer.from(path.basename(cleaned, ext), 'utf8');
    while (stemBytes.length > maxStem && stemBytes.length > 0) {
      stemBytes = stemBytes.subarray(0, stemBytes.length - 1);
    }
    cleaned = `${stemBytes.toString('utf8')}${ext}`.replace(/[ .]+$/g, '') || 'file';
  }
  return cleaned;
}

function uniqueShareName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let index = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

async function placeShareFile(root, sourcePath) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Share root must be an absolute directory path');
  }
  if (typeof sourcePath !== 'string' || !sourcePath) {
    throw new TypeError('Source file path is required');
  }
  const destDir = path.join(root, SHARE_DIR);
  await fsp.mkdir(destDir, { recursive: true });
  const destName = uniqueShareName(destDir, sanitizeShareName(path.basename(sourcePath)));
  const destPath = path.join(destDir, destName);
  await fsp.copyFile(sourcePath, destPath);
  return {
    destName,
    destPath,
    relativePath: `${SHARE_DIR}/${destName}`
  };
}

function buildShareUrls(pageUrls, relativePath) {
  return (Array.isArray(pageUrls) ? pageUrls : []).map((page) => toDownloadUrl(page, relativePath));
}

module.exports = {
  SHARE_DIR,
  toDownloadUrl,
  sanitizeShareName,
  uniqueShareName,
  placeShareFile,
  buildShareUrls
};
