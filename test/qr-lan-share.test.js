'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SHARE_DIR,
  toDownloadUrl,
  sanitizeShareName,
  uniqueShareName,
  placeShareFile,
  buildShareUrls
} = require('../electron/qr-lan-share');

test('turns a share homepage into a direct download URL and keeps the token', () => {
  assert.equal(
    toDownloadUrl('http://192.168.1.8:18765/?token=abc', '.toolbox-qr/demo.apk'),
    'http://192.168.1.8:18765/api/download?token=abc&path=.toolbox-qr%2Fdemo.apk'
  );
  assert.equal(
    toDownloadUrl('http://10.0.0.2:18765/', 'report.pdf'),
    'http://10.0.0.2:18765/api/download?path=report.pdf'
  );
});

test('sanitizes names the file server would reject', () => {
  assert.equal(sanitizeShareName('a/b\\c:d?.apk'), 'b_c_d_.apk');
  assert.equal(sanitizeShareName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeShareName('hello.'), 'hello');
  assert.equal(sanitizeShareName(''), 'file');
});

test('avoids colliding with a file already in the share folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-lan-share-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'a');
  assert.equal(uniqueShareName(dir, 'note.txt'), 'note-1.txt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('copies the dropped file under .toolbox-qr and lists download URLs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-lan-root-'));
  const source = path.join(root, '源文件 (1).apk');
  fs.writeFileSync(source, 'payload');
  const placed = await placeShareFile(root, source);
  assert.equal(placed.destName, '源文件 (1).apk');
  assert.equal(placed.relativePath, `${SHARE_DIR}/源文件 (1).apk`);
  assert.equal(fs.readFileSync(placed.destPath, 'utf8'), 'payload');

  const urls = buildShareUrls(['http://192.168.0.4:18765/'], placed.relativePath);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/download\?path=/);
  fs.rmSync(root, { recursive: true, force: true });
});
