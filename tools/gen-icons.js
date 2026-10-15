/**
 * 生成本项目所需的三个平台图标：
 *   build/icon.png   (Linux, 512x512)
 *   build/icon.ico   (Windows, 256x256)
 *   build/icon.icns  (macOS, 16..1024)
 *
 * 无需任何外部依赖，纯 Node.js 实现（手写 PNG / ICO / ICNS 二进制格式）。
 * 用法: node tools/gen-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUILD_DIR = path.join(__dirname, '..', 'build');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- PNG 编码 ---------- */
function crcChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, crcChunk('IHDR', ihdr), crcChunk('IDAT', idat), crcChunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制图标内容（渐变背景 + 白色 "D" 字母 + 边框） ---------- */
function drawLogo(size) {
  const img = Buffer.alloc(size * size * 4);
  const c1 = { r: 91,  g: 63,  b: 217 };   // 蓝紫
  const c2 = { r: 245, g: 158, b: 11 };     // 橙
  const inset = size * 0.08;
  const corner = Math.max(1, Math.floor(size * 0.22));
  const border = Math.max(1, Math.floor(size * 0.03));

  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * (size - 1));
      let r = Math.round(c1.r + (c2.r - c1.r) * t);
      let g = Math.round(c1.g + (c2.g - c1.g) * t);
      let b = Math.round(c1.b + (c2.b - c1.b) * t);
      let a = 255;

      // 圆角矩形遮罩
      let outside = false;
      if (x < inset || y < inset || x >= size - inset || y >= size - inset) {
        if (x < inset + corner && y < inset + corner) {
          if (Math.hypot(x - (inset + corner), y - (inset + corner)) > corner) outside = true;
        } else if (x >= size - inset - corner && y < inset + corner) {
          if (Math.hypot(x - (size - inset - corner), y - (inset + corner)) > corner) outside = true;
        } else if (x < inset + corner && y >= size - inset - corner) {
          if (Math.hypot(x - (inset + corner), y - (size - inset - corner)) > corner) outside = true;
        } else if (x >= size - inset - corner && y >= size - inset - corner) {
          if (Math.hypot(x - (size - inset - corner), y - (size - inset - corner)) > corner) outside = true;
        } else {
          outside = true;
        }
      }
      if (outside) { r = 0; g = 0; b = 0; a = 0; }
      else if (x < inset + border || y < inset + border || x >= size - inset - border || y >= size - inset - border) {
        // 边框：加深色调
        r = Math.max(0, r - 60);
        g = Math.max(0, g - 60);
        b = Math.max(0, b - 60);
      }

      // 绘制字母 "D"
      const cx = size * 0.38;
      const cy = size * 0.5;
      const rx = size * 0.19;
      const ry = size * 0.28;
      const lw = Math.max(2, Math.floor(size * 0.08));
      const dTop = cy - ry, dBot = cy + ry;
      const straightX = cx - rx;
      const dMid = Math.hypot((x - cx) / rx, (y - cy) / ry);
      let onLetter = false;
      if (x >= straightX - lw / 2 && x <= straightX + lw / 2 &&
          y >= dTop + lw * 0.4 && y <= dBot - lw * 0.4) onLetter = true;
      if (Math.abs(dMid * ry - ry) < lw / 2 &&
          Math.abs((x - cx) / rx) <= 1.05) onLetter = true;

      if (onLetter) { r = 255; g = 255; b = 255; }

      img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = a;
    }
  }
  return img;
}

/* ---------- ICO 编码（PNG 内嵌形式） ---------- */
function pngToBmp32(size, rgba) {
  const stride = ((size * 4) + 3) & ~3;
  const padding = stride - size * 4;
  const hPad = Buffer.alloc(padding);
  const bmp = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * stride;
    for (let x = 0; x < size; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      bmp[di]     = rgba[si + 2];
      bmp[di + 1] = rgba[si + 1];
      bmp[di + 2] = rgba[si];
      bmp[di + 3] = rgba[si + 3];
    }
    if (padding > 0) hPad.copy(bmp, dstRow + size * 4);
  }
  return bmp;
}

function encodeICO(pngBuf, size) {
  const bmp = pngToBmp32(size, pngBuf);
  const ih = Buffer.alloc(40);
  ih.writeUInt32BE(40, 0);
  ih.writeUInt32BE(size, 4);
  ih.writeUInt32BE(size, 8);
  ih.writeUInt16BE(1, 12);
  ih.writeUInt16BE(32, 14);
  ih.writeUInt32BE(0, 16);
  ih.writeUInt32BE(bmp.length, 20);
  ih.writeUInt32BE(0, 24);
  ih.writeUInt32BE(0, 28);

  const pngBytes = pngBuf.length;
  const bmpBytes = ih.length + bmp.length;
  const totalBytes = bmpBytes + pngBytes;

  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(1, 4);

  const dir = Buffer.alloc(16);
  dir[0] = size >= 256 ? 0 : size;
  dir[1] = size >= 256 ? 0 : size;
  dir[2] = 0; dir[3] = 0;
  dir.writeUInt16BE(1, 4);
  dir.writeUInt16BE(32, 6);
  dir.writeUInt32BE(totalBytes, 8);
  dir.writeUInt32BE(22, 12);

  return Buffer.concat([header, dir, ih, bmp, pngBuf]);
}

/* ---------- ICNS 编码 ---------- */
function encodeICNS(pngs) {
  const chunks = [];
  const entries = new Map();
  for (const { type, buf } of pngs) {
    if (entries.has(type)) continue;
    const total = 8 + buf.length;
    const c = Buffer.alloc(total);
    const tag = type.charCodeAt(0) << 24 | type.charCodeAt(1) << 16 |
                type.charCodeAt(2) << 8  | type.charCodeAt(3);
    c.writeUInt32BE(tag, 0);
    c.writeUInt32BE(total, 4);
    buf.copy(c, 8);
    chunks.push(c);
    entries.set(type, total);
  }
  const totalSize = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(totalSize, 4);
  return Buffer.concat([header, ...chunks]);
}

const ICNS_TYPES = [
  [16, 'icp4'], [32, 'icp5'], [128, 'ic07'], [256, 'ic08'],
  [512, 'ic10'], [512, 'ic09'], [1024, 'ic11'],
];

function makeICNS() {
  const pngs = [];
  const seen = new Set();
  for (const [size, type] of ICNS_TYPES) {
    if (seen.has(size)) continue;
    seen.add(size);
    const img = drawLogo(size);
    pngs.push({ type, buf: encodePNG(size, size, img) });
  }
  return encodeICNS(pngs);
}

/* ---------- 主入口 ---------- */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function main() {
  ensureDir(BUILD_DIR);

  const png512 = drawLogo(512);
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), encodePNG(512, 512, png512));
  console.log('✓ build/icon.png  (512x512, Linux)');

  const ico256 = drawLogo(256);
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), encodeICO(encodePNG(256, 256, ico256), 256));
  console.log('✓ build/icon.ico  (256x256, Windows)');

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.icns'), makeICNS());
  console.log('✓ build/icon.icns (16..1024, macOS)');

  console.log('\n全部图标生成完成，输出目录：', BUILD_DIR);
}

main();
