'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createWebDavServerController = require('../electron/webdav-server');
const { helpers, constants } = createWebDavServerController;

const ROOT = path.join(__dirname, '..');

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'webdav-server-'));
  const controller = createWebDavServerController({
    getNetworkAddresses: () => ['127.0.0.1'],
    shutdownGraceMs: 50,
    ...options
  });
  await controller.setRoot(root);
  t.after(async () => {
    controller.forceClose();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, controller };
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(options.headers || {}) };
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath,
      method: options.method || 'GET', headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        text() { return this.body.toString('utf8'); }
      }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function startOpen(t, options = {}) {
  const result = await fixture(t, options);
  const status = await result.controller.start();
  return { ...result, status };
}

async function startLocked(t, options = {}) {
  const result = await fixture(t, options);
  await result.controller.setCredentials('admin', 'secret-pass');
  const status = await result.controller.start();
  return { ...result, status, auth: basicAuth('admin', 'secret-pass') };
}

// ==================== CommonJS 契约 ====================

test('exports the documented CommonJS controller contract', async t => {
  assert.equal(typeof createWebDavServerController, 'function');
  assert.equal(createWebDavServerController.createWebDavServerController, createWebDavServerController);
  assert.deepEqual(Object.keys(helpers).sort(), [
    'collectAddressEntries', 'decodeSegments', 'describeAddressKind',
    'isAdvertisableAddress', 'parseDestination'
  ].sort());
  assert.deepEqual(constants.DAV_METHODS, [
    'OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH',
    'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'
  ]);
  assert.equal(constants.DEFAULTS.defaultPort, 18766);
  const { controller, root } = await fixture(t);
  const canonicalRoot = await fsp.realpath(root);
  assert.deepEqual(Object.keys(controller).sort(),
    ['forceClose', 'getStatus', 'onStatus', 'setCredentials', 'setRoot', 'start', 'stop'].sort());
  const status = controller.getStatus();
  assert.equal(status.state, 'stopped');
  assert.equal(status.selectedRoot, canonicalRoot);
  assert.equal(status.rootPath, canonicalRoot);
  assert.equal(status.port, null);
  assert.deepEqual(status.urls, []);
  assert.equal(status.username, '');
  assert.equal(status.authRequired, false);
  assert.equal(status.error, null);
});

// ==================== helpers ====================

test('decodeSegments accepts plain paths and rejects traversal/encoding abuse', () => {
  assert.deepEqual(helpers.decodeSegments('/'), []);
  assert.deepEqual(helpers.decodeSegments(''), []);
  assert.deepEqual(helpers.decodeSegments('/a%20b'), ['a b']);
  assert.deepEqual(helpers.decodeSegments('/%E6%8A%A5%E5%91%8A/'), ['报告']);
  assert.deepEqual(helpers.decodeSegments('/folder/inner/file.txt'), ['folder', 'inner', 'file.txt']);
  assert.deepEqual(helpers.decodeSegments('///a//b'), ['a', 'b']);
  assert.throws(() => helpers.decodeSegments('/../secret'), /traversal/i);
  assert.throws(() => helpers.decodeSegments('/a/%2e%2e/b'), /traversal/i);
  assert.throws(() => helpers.decodeSegments('/a/./b'), /traversal|Invalid path/);
  assert.throws(() => helpers.decodeSegments('/folder%5csecret'), /Invalid path/);
  assert.throws(() => helpers.decodeSegments('/a%00b'), /Invalid path/);
  assert.throws(() => helpers.decodeSegments('/%e0%80%80'), /Invalid path|invalid encoding/);
});

test('parseDestination accepts same-server targets and rejects cross-server', () => {
  const port = 18766;
  assert.equal(helpers.parseDestination(`http://192.168.8.195:${port}/dest.txt`, port), '/dest.txt');
  assert.equal(helpers.parseDestination(`http://localhost:${port}/folder/`, port), '/folder/');
  // 无端口的 Host 视为默认 80；本服务非 80 时应拒绝
  assert.throws(() => helpers.parseDestination('http://example.com/dav/file.txt', port), /Cross-server/);
  assert.throws(() => helpers.parseDestination('http://other.host:9999/file', port), /Cross-server/);
  assert.throws(() => helpers.parseDestination('not-a-url', port), /Destination/i);
  assert.throws(() => helpers.parseDestination('', port), /Destination/i);
});

test('collectAddressEntries dedupes and skips internal entries', () => {
  const entries = helpers.collectAddressEntries({
    lo: [
      { address: '127.0.0.1', internal: true, family: 'IPv4' },
      { address: '::1', internal: true, family: 'IPv6' }
    ],
    en0: [
      { address: '192.168.8.195', internal: false, family: 'IPv4' },
      { address: 'fe80::1092:aeb2:f4e0:b1f5', internal: false, family: 'IPv6' }
    ],
    en1: [
      { address: '192.168.8.195', internal: false, family: 'IPv4' }
    ]
  });
  assert.deepEqual(entries, [
    { address: '192.168.8.195', interface: 'en0' },
    { address: 'fe80::1092:aeb2:f4e0:b1f5', interface: 'en0' }
  ]);
});

test('only advertises addresses a phone can actually reach', () => {
  assert.equal(helpers.isAdvertisableAddress('192.168.8.195'), true);
  assert.equal(helpers.isAdvertisableAddress('10.0.0.7'), true);
  assert.equal(helpers.isAdvertisableAddress('169.254.230.49'), true);
  assert.equal(helpers.isAdvertisableAddress('2001:db8::1'), true);
  assert.equal(helpers.isAdvertisableAddress('fe80::1092:aeb2:f4e0:b1f5'), false);
  assert.equal(helpers.isAdvertisableAddress('FE80::1'), false);
  assert.equal(helpers.isAdvertisableAddress('::1'), false);
  assert.equal(helpers.isAdvertisableAddress('not-an-ip'), false);
});

test('labels each address with the actual network card', () => {
  const labels = { en0: '以太网（有线）', en1: 'Wi-Fi（无线）' };
  assert.equal(helpers.describeAddressKind('192.168.8.195', 'en0', labels), '以太网（有线）');
  assert.equal(helpers.describeAddressKind('192.168.8.195', 'en0', {}), '局域网 · en0');
  assert.equal(helpers.describeAddressKind('2001:db8::1', 'en1', {}), 'IPv6 · en1');
  assert.equal(helpers.describeAddressKind('192.168.8.195'), '局域网');
  assert.equal(helpers.describeAddressKind('169.254.230.49', 'en8', labels), 'USB 直连 / 链路本地');
});

// ==================== root / credentials ====================

test('setRoot canonicalizes directories and rejects symlinks and relative paths', async t => {
  const { controller, root } = await fixture(t);
  assert.equal(controller.getStatus().selectedRoot, await fsp.realpath(root));
  await assert.rejects(controller.setRoot(path.join(root, 'missing')), /directory/i);
  await assert.rejects(controller.setRoot('relative/path'), /absolute/i);
  const link = `${root}-link`;
  try {
    await fsp.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  t.after(() => fsp.rm(link, { force: true }));
  await assert.rejects(controller.setRoot(link), /symbolic link|junction/i);
});

test('setCredentials defaults to admin and empties to trusted mode', async t => {
  const { controller } = await fixture(t);
  await controller.setCredentials('', 'pass');
  assert.equal(controller.getStatus().username, 'admin');
  assert.equal(controller.getStatus().authRequired, true);
  await controller.setCredentials('violet  ', 'new-pass');
  assert.equal(controller.getStatus().username, 'violet');
  await controller.setCredentials('violet', '');
  assert.equal(controller.getStatus().username, 'violet');
  assert.equal(controller.getStatus().authRequired, false);
});

test('setRoot and setCredentials are refused while running', async t => {
  const { controller } = await startOpen(t);
  try {
    await assert.rejects(controller.setRoot('/tmp'), /Stop the WebDAV server/);
    await assert.rejects(controller.setCredentials('a', 'b'), /Stop the WebDAV server/);
  } finally {
    await controller.stop('test');
  }
});

// ==================== 生命周期 ====================

test('emits serializable lifecycle statuses and supports unsubscribe', async t => {
  const { controller, root } = await fixture(t);
  const events = [];
  const unsubscribe = controller.onStatus(status => events.push(JSON.parse(JSON.stringify(status))));
  await controller.start();
  await controller.stop('test stop');
  unsubscribe();
  await controller.setRoot(root);
  assert.deepEqual(events.map(event => event.state), ['stopped', 'starting', 'running', 'stopping', 'stopped']);
  assert.equal(events[2].selectedRoot, await fsp.realpath(root));
  assert.equal(events[2].urls.length, 1);
  assert.match(events[2].urls[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(events[4].state, 'stopped');
});

test('stop closes idle sockets and forceClose is synchronous and idempotent', async t => {
  const { controller, status } = await startOpen(t);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  assert.equal((await request(status.port, '/', { method: 'OPTIONS', agent })).status, 200);
  const stopped = await controller.stop('test');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.port, null);
  assert.deepEqual(stopped.urls, []);
  assert.deepEqual(controller.forceClose(), stopped);
});

// ==================== OPTIONS 探测（挂载客户端最先发的请求） ====================

test('OPTIONS advertises DAV capabilities without requiring credentials', async t => {
  const { status } = await startLocked(t);
  const response = await request(status.port, '/', { method: 'OPTIONS' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.dav, '1, 2; propfind-finite-depth');
  assert.equal(response.headers['ms-author-via'], 'DAV');
  for (const method of constants.DAV_METHODS) {
    assert.ok(response.headers.allow.includes(method), `Allow 应包含 ${method}`);
  }
});

// ==================== 鉴权 ====================

test('empty password means trusted mode: every request passes without auth', async t => {
  const { root, status } = await startOpen(t);
  await fsp.writeFile(path.join(root, 'plain.txt'), 'ok');
  assert.equal((await request(status.port, '/plain.txt')).status, 200);
  const listed = await request(status.port, '/', { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(listed.status, 207);
});

test('a password requires Basic auth on every WebDAV method', async t => {
  const { root, status, auth } = await startLocked(t);
  await fsp.writeFile(path.join(root, 'secret.txt'), 'classified');
  for (const [label, entry] of [
    ['no header', { headers: {} }],
    ['wrong scheme', { headers: { Authorization: 'Bearer abc' } }],
    ['garbage base64', { headers: { Authorization: 'Basic !!!not-base64!!!' } }],
    ['no colon', { headers: { Authorization: basicAuth('admin', 'x').replace(/:x$/, '') } }],
    ['wrong user', { headers: { Authorization: basicAuth('root', 'secret-pass') } }],
    ['wrong pass', { headers: { Authorization: basicAuth('admin', 'wrong') } }]
  ]) {
    const denied = await request(status.port, '/secret.txt', { headers: entry.headers });
    assert.equal(denied.status, 401, label);
    assert.match(denied.headers['www-authenticate'], /^Basic realm="WebDAV"/, label);
  }
  const allowed = await request(status.port, '/secret.txt', { headers: { Authorization: auth } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.text(), 'classified');
});

test('status exposes hasPassword but never the password itself', async t => {
  const { controller } = await fixture(t);
  // 初始：无密码 → 两个标志都为 false
  assert.equal(controller.getStatus().hasPassword, false);
  assert.equal(controller.getStatus().authRequired, false);
  // 设密码 → 标志翻转，但 snapshot 不出现 password 字段
  await controller.setCredentials('admin', 'secret-pass');
  const locked = controller.getStatus();
  assert.equal(locked.hasPassword, true);
  assert.equal(locked.authRequired, true);
  assert.ok(!('password' in locked), 'snapshot 不应包含 password 字段');
  // 清密码 → 回到信任模式
  await controller.setCredentials('admin', '');
  assert.equal(controller.getStatus().hasPassword, false);
});

// ==================== PROPFIND ====================

test('PROPFIND depth 1 lists the collection itself plus sorted children', async t => {
  const { root, status } = await startOpen(t);
  await fsp.mkdir(path.join(root, 'folder'));
  await fsp.writeFile(path.join(root, 'z.txt'), 'zzz');
  await fsp.writeFile(path.join(root, '报告.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));
  const response = await request(status.port, '/', { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(response.status, 207);
  assert.match(response.headers['content-type'], /xml/);
  const xml = response.text();
  // 目录自身排第一，href 必须带尾斜杠（Finder 靠它认 collection）
  assert.match(xml, /<D:href>\/<\/D:href>/);
  assert.match(xml, /<D:resourcetype><D:collection\/><\/D:resourcetype>/);
  // 子项：目录优先、按名字排（zh-CN collation：报告 bào 排在 z 前）
  const hrefs = [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => match[1]);
  assert.deepEqual(hrefs, ['/', '/folder/', '/%E6%8A%A5%E5%91%8A.pdf', '/z.txt']);
  // 文件必须有大小；目录不能有 getcontentlength（用 </D:response> 收窄到 folder 这一块）
  assert.match(xml, /<D:getcontentlength>3<\/D:getcontentlength>/);
  const folderBlock = xml.slice(xml.indexOf('<D:href>/folder/'), xml.indexOf('</D:response>', xml.indexOf('<D:href>/folder/')));
  assert.doesNotMatch(folderBlock, /getcontentlength/);
});

test('PROPFIND depth 0 returns only the resource itself', async t => {
  const { root, status } = await startOpen(t);
  await fsp.mkdir(path.join(root, 'folder'));
  await fsp.writeFile(path.join(root, 'folder/a.txt'), 'a');
  const response = await request(status.port, '/folder/', { method: 'PROPFIND', headers: { Depth: '0' } });
  assert.equal(response.status, 207);
  const hrefs = [...response.text().matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => match[1]);
  assert.deepEqual(hrefs, ['/folder/']);
});

test('PROPFIND on a file returns the file entry regardless of depth', async t => {
  const { root, status } = await startOpen(t);
  await fsp.writeFile(path.join(root, 'file.txt'), 'content');
  const response = await request(status.port, '/file.txt', { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(response.status, 207);
  const hrefs = [...response.text().matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => match[1]);
  assert.deepEqual(hrefs, ['/file.txt']);
  assert.doesNotMatch(response.text(), /<D:collection\/>/);
});

test('PROPFIND rejects invalid depth and missing resources', async t => {
  const { status } = await startOpen(t);
  assert.equal((await request(status.port, '/', {
    method: 'PROPFIND', headers: { Depth: '2' }
  })).status, 400);
  assert.equal((await request(status.port, '/missing/', {
    method: 'PROPFIND', headers: { Depth: '0' }
  })).status, 404);
});

test('PROPFIND refuses Depth: infinity with 403 and the propfind-finite-depth precondition', async t => {
  const { status } = await startOpen(t);
  const response = await request(status.port, '/', { method: 'PROPFIND', headers: { Depth: 'infinity' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.precondition, 'propfind-finite-depth');
  // 缺省（不传 Depth）按规范视同 infinity，也应显式拒绝
  const omitted = await request(status.port, '/', { method: 'PROPFIND' });
  assert.equal(omitted.status, 403);
  assert.equal(omitted.headers.precondition, 'propfind-finite-depth');
});

test('PROPFIND hrefs escape # and ? per segment instead of encodeURI double-encoding', async t => {
  const { root, status } = await startOpen(t);
  await fsp.writeFile(path.join(root, '报告#1.txt'), 'hash');
  await fsp.writeFile(path.join(root, 'C#教程.pdf'), 'sharp');
  await fsp.writeFile(path.join(root, 'a?b.txt'), 'question');
  await fsp.mkdir(path.join(root, '目#录'));
  await fsp.writeFile(path.join(root, '目#录/inner.txt'), 'x');
  const response = await request(status.port, '/', { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(response.status, 207);
  const xml = response.text();
  const hrefs = [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => match[1]);
  // zh-CN collation 实际排序：目 mù → 报 bào → a → C（目录优先、大小写不敏感、数字排序）
  assert.deepEqual(hrefs, [
    '/',
    '/%E7%9B%AE%23%E5%BD%95/',
    '/%E6%8A%A5%E5%91%8A%231.txt',
    '/a%3Fb.txt',
    '/C%23%E6%95%99%E7%A8%8B.pdf'
  ]);
  // 拿到的 href 再请求必须能命中文件（# ? 不再被 URL 截断）
  const fetched = await request(status.port, '/%E6%8A%A5%E5%91%8A%231.txt');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.text(), 'hash');
  // 子目录里的 href 同样可用
  const inner = await request(status.port, '/%E7%9B%AE%23%E5%BD%95/', { method: 'PROPFIND', headers: { Depth: '1' } });
  assert.equal(inner.status, 207);
  const innerHrefs = [...inner.text().matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => match[1]);
  assert.deepEqual(innerHrefs, ['/%E7%9B%AE%23%E5%BD%95/', '/%E7%9B%AE%23%E5%BD%95/inner.txt']);
});

// ==================== GET / HEAD ====================

test('GET streams file bytes and HEAD reports metadata', async t => {
  const { root, status } = await startOpen(t);
  const payload = Buffer.from('download payload');
  await fsp.writeFile(path.join(root, 'z.txt'), payload);
  const got = await request(status.port, '/z.txt');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, payload);
  assert.equal(got.headers['content-length'], String(payload.length));
  assert.match(got.headers['last-modified'], /^[A-Z][a-z]{2}, /);
  const head = await request(status.port, '/z.txt', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(payload.length));
  assert.deepEqual(head.body, Buffer.alloc(0));
  // GET 一个目录不是文件下载，应报冲突
  assert.equal((await request(status.port, '/')).status, 409);
  assert.equal((await request(status.port, '/missing.txt')).status, 404);
});

// ==================== PUT ====================

test('PUT creates and overwrites atomically without leaving temp files', async t => {
  const { root, status } = await startOpen(t);
  const put = (body, extra = {}) => request(status.port, '/new%20file.txt', {
    method: 'PUT', body,
    headers: { 'Content-Length': String(body.length), ...extra.headers }
  });
  const created = await put(Buffer.from('hello'));
  assert.equal(created.status, 201);
  assert.equal(await fsp.readFile(path.join(root, 'new file.txt'), 'utf8'), 'hello');
  const overwritten = await put(Buffer.from('replaced'));
  assert.equal(overwritten.status, 204);
  assert.equal(await fsp.readFile(path.join(root, 'new file.txt'), 'utf8'), 'replaced');
  // 原子写入不能留下 .dav-upload- 临时文件
  const leftovers = (await fsp.readdir(root)).filter(name => name.includes('.dav-upload-'));
  assert.deepEqual(leftovers, []);
  // PUT 根 collection 是非法的
  assert.equal((await request(status.port, '/', {
    method: 'PUT', body: 'x', headers: { 'Content-Length': '1' }
  })).status, 405);
});

test('PUT rejects oversized bodies and cleans up partial temp files', async t => {
  const { root, status } = await startOpen(t, { uploadLimitBytes: 8 });
  await fsp.writeFile(path.join(root, 'target.bin'), Buffer.from('original'));
  // content-length 超限：请求直接拒绝
  const declared = await request(status.port, '/target.bin', {
    method: 'PUT', body: Buffer.alloc(9), headers: { 'Content-Length': '9' }
  });
  assert.equal(declared.status, 413);
  // 边写边超限：临时文件要被清掉，原文件不能被动过
  const streamed = await request(status.port, '/target.bin', {
    method: 'PUT', body: Buffer.alloc(9), headers: { 'Content-Length': '9' }
  }).catch(error => ({ status: error && error.code ? error.code : 0 }));
  assert.ok([413, 'ECONNRESET'].includes(streamed.status) || streamed.status === 413,
    `意外的结果：${JSON.stringify(streamed.status)}`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await fsp.readFile(path.join(root, 'target.bin'), 'utf8'), 'original');
  const leftovers = (await fsp.readdir(root)).filter(name => name.includes('.dav-upload-'));
  assert.deepEqual(leftovers, []);
});

// ==================== MKCOL / DELETE ====================

test('MKCOL creates collections and DELETE removes files and trees', async t => {
  const { root, status } = await startOpen(t);
  const made = await request(status.port, '/folder', { method: 'MKCOL' });
  assert.equal(made.status, 201);
  assert.ok((await fsp.stat(path.join(root, 'folder'))).isDirectory());
  assert.equal((await request(status.port, '/folder', { method: 'MKCOL' })).status, 405);
  // 带请求体的 MKCOL 不支持
  assert.equal((await request(status.port, '/other', {
    method: 'MKCOL', body: 'x', headers: { 'Content-Length': '1' }
  })).status, 415);
  // 父目录不存在时 409
  assert.equal((await request(status.port, '/nope/child', { method: 'MKCOL' })).status, 409);

  await fsp.writeFile(path.join(root, 'folder/inner.txt'), 'data');
  await fsp.mkdir(path.join(root, 'folder/sub'));
  const removed = await request(status.port, '/folder', { method: 'DELETE' });
  assert.equal(removed.status, 204);
  await assert.rejects(fsp.access(path.join(root, 'folder')));
  // 根 collection 拒绝删除
  assert.equal((await request(status.port, '/', { method: 'DELETE' })).status, 403);
  assert.equal((await request(status.port, '/ghost.txt', { method: 'DELETE' })).status, 404);
});

// ==================== COPY / MOVE ====================

test('COPY and MOVE obey Destination, Overwrite, and refuse the root', async t => {
  const { root, status } = await startOpen(t);
  await fsp.writeFile(path.join(root, 'src.txt'), 'copy me');
  await fsp.mkdir(path.join(root, 'dir'));
  const copy = await request(status.port, '/src.txt', {
    method: 'COPY',
    headers: { Destination: `http://127.0.0.1:${status.port}/dir/dst.txt` }
  });
  assert.equal(copy.status, 201);
  assert.equal(await fsp.readFile(path.join(root, 'dir/dst.txt'), 'utf8'), 'copy me');
  assert.equal(await fsp.readFile(path.join(root, 'src.txt'), 'utf8'), 'copy me');

  // 覆盖已有目标：默认 Overwrite T → 204
  await fsp.writeFile(path.join(root, 'exists.txt'), 'old');
  const overwrite = await request(status.port, '/src.txt', {
    method: 'COPY',
    headers: { Destination: `http://127.0.0.1:${status.port}/exists.txt` }
  });
  assert.equal(overwrite.status, 204);
  assert.equal(await fsp.readFile(path.join(root, 'exists.txt'), 'utf8'), 'copy me');
  // Overwrite F → 412
  const refused = await request(status.port, '/src.txt', {
    method: 'COPY',
    headers: { Destination: `http://127.0.0.1:${status.port}/exists.txt`, Overwrite: 'F' }
  });
  assert.equal(refused.status, 412);

  const moved = await request(status.port, '/src.txt', {
    method: 'MOVE',
    headers: { Destination: `http://127.0.0.1:${status.port}/dir/moved.txt` }
  });
  assert.equal(moved.status, 201);
  assert.equal(await fsp.readFile(path.join(root, 'dir/moved.txt'), 'utf8'), 'copy me');
  await assert.rejects(fsp.access(path.join(root, 'src.txt')));

  // 缺 Destination / 跨服务器 / 覆盖根 → 全部拒绝
  assert.equal((await request(status.port, '/dir/moved.txt', { method: 'COPY', headers: {} })).status, 400);
  assert.equal((await request(status.port, '/dir/moved.txt', {
    method: 'COPY', headers: { Destination: 'http://elsewhere.example:9999/out.txt' }
  })).status, 502);
  assert.equal((await request(status.port, '/dir/moved.txt', {
    method: 'COPY', headers: { Destination: `http://127.0.0.1:${status.port}/` }
  })).status, 403);
});

test('COPY and MOVE refuse destinations inside the source collection', async t => {
  const { root, status } = await startOpen(t);
  await fsp.mkdir(path.join(root, 'tree/inner'), { recursive: true });
  await fsp.writeFile(path.join(root, 'tree/a.txt'), 'a');
  await fsp.writeFile(path.join(root, 'tree/inner/b.txt'), 'b');
  const headers = (destinationPath) => ({
    Destination: `http://127.0.0.1:${status.port}${destinationPath}`
  });
  // 目录复制到自己的子目录里 → 409（无限递归）
  assert.equal((await request(status.port, '/tree/', {
    method: 'COPY', headers: headers('/tree/inner/copy-of-tree/')
  })).status, 409);
  // MOVE 目录到自己的子目录里 → 409（祖先搬进后代）
  assert.equal((await request(status.port, '/tree/', {
    method: 'MOVE', headers: headers('/tree/inner/moved-tree/')
  })).status, 409);
  // 文件不受影响：目标目录与源目录可以嵌套
  assert.equal((await request(status.port, '/tree/a.txt', {
    method: 'COPY', headers: headers('/tree/inner/a-copy.txt')
  })).status, 201);
  // 目录复制到平级（不在子树内）也正常
  assert.equal((await request(status.port, '/tree/inner/', {
    method: 'COPY', headers: headers('/inner-copy/')
  })).status, 201);
  assert.equal(await fsp.readFile(path.join(root, 'inner-copy/b.txt'), 'utf8'), 'b');
});

// ==================== LOCK / UNLOCK ====================

test('LOCK issues a token, conflicts with rivals, and UNLOCK requires the token', async t => {
  const { root, status } = await startOpen(t);
  await fsp.writeFile(path.join(root, 'a.txt'), 'data');
  const lockBody = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>tester</D:owner></D:lockinfo>';
  const locked = await request(status.port, '/a.txt', {
    method: 'LOCK', body: lockBody, headers: { 'Content-Length': String(Buffer.byteLength(lockBody)), Timeout: 'Second-120' }
  });
  assert.equal(locked.status, 200);
  const token = (locked.headers['lock-token'] || '').replace(/^<|>$/g, '');
  assert.match(token, /^opaquelocktoken:[0-9a-f-]+$/);
  assert.match(locked.text(), /<D:locktoken><D:href>/);
  assert.match(locked.text(), /<D:owner>tester<\/D:owner>/);

  // 刷新已有锁（If 头带 token）
  const refreshed = await request(status.port, '/a.txt', {
    method: 'LOCK', body: lockBody,
    headers: { 'Content-Length': String(Buffer.byteLength(lockBody)), If: `(<${token}>)`, Timeout: 'Second-300' }
  });
  assert.equal(refreshed.status, 200);

  // UNLOCK 用错 token → 409
  assert.equal((await request(status.port, '/a.txt', {
    method: 'UNLOCK', headers: { 'Lock-Token': '<opaquelocktoken:not-the-one>' }
  })).status, 409);
  // UNLOCK 对没锁的资源 → 409
  assert.equal((await request(status.port, '/missing.txt', {
    method: 'UNLOCK', headers: { 'Lock-Token': `<${token}>` }
  })).status, 409);
  // 正确 token → 204，之后可以再锁
  assert.equal((await request(status.port, '/a.txt', {
    method: 'UNLOCK', headers: { 'Lock-Token': `<${token}>` }
  })).status, 204);
  assert.equal((await request(status.port, '/a.txt', {
    method: 'LOCK', body: lockBody, headers: { 'Content-Length': String(Buffer.byteLength(lockBody)) }
  })).status, 200);
});

// ==================== PROPPATCH ====================

test('PROPPATCH answers 207 without applying anything (read-only properties)', async t => {
  const { root, status } = await startOpen(t);
  await fsp.writeFile(path.join(root, 'p.txt'), 'data');
  const body = '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><x:comment xmlns:x="urn:test">hi</x:comment></D:prop></D:set></D:propertyupdate>';
  const response = await request(status.port, '/p.txt', {
    method: 'PROPPATCH', body, headers: { 'Content-Length': String(Buffer.byteLength(body)) }
  });
  assert.equal(response.status, 207);
  assert.match(response.text(), /403 Forbidden/);
  assert.match(response.text(), /<D:href>\/p\.txt<\/D:href>/);
  // 对不存在的资源 PROPPATCH 应该 404（resolveSafePath 先跑）
  assert.equal((await request(status.port, '/ghost.txt', {
    method: 'PROPPATCH', body, headers: { 'Content-Length': String(Buffer.byteLength(body)) }
  })).status, 404);
});

// ==================== 安全边界 ====================

test('rejects traversal, symlinks, and cross-server destinations inside requests', async t => {
  const { root, status } = await startOpen(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'webdav-outside-'));
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));

  // new URL() 会把 /%2e%2e/ 归一化成 /../，Node 层已拒绝；
  // %2f 编码的穿越会穿透归一化，必须由 decodeSegments 拦下
  const traversal = await request(status.port, '/%2e%2e%2fsecret.txt');
  assert.equal(traversal.status, 400);

  const link = path.join(root, 'linked');
  try {
    await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  assert.equal((await request(status.port, '/linked/')).status, 403);
  assert.equal((await request(status.port, '/linked/', { method: 'PROPFIND', headers: { Depth: '0' } })).status, 403);

  // Host 端口对不上（且不是默认 80）→ 400
  const badHost = await request(status.port, '/', { headers: { Host: `localhost:${status.port + 1}` } });
  assert.equal(badHost.status, 400);
  // 未知方法 → 405
  assert.equal((await request(status.port, '/', { method: 'POST' })).status, 405);
});

// ==================== 地址广告 ====================

test('advertises http URLs with 169.254 preserved and fe80 dropped', async t => {
  const { controller } = await fixture(t, {
    getNetworkAddresses: () => [
      'fe80::1092:aeb2:f4e0:b1f5', '169.254.230.49', '192.168.8.195', 'fe80::42b2:d703:bb97:8dcc'
    ]
  });
  const status = await controller.start();
  assert.deepEqual(status.urls, [
    `http://192.168.8.195:${status.port}/`,
    `http://169.254.230.49:${status.port}/`
  ]);
  assert.equal(status.primaryAddress, '192.168.8.195');
  await controller.stop('test');
});

test('falls back to the raw list when every address is IPv6 link-local', async t => {
  const { controller } = await fixture(t, { getNetworkAddresses: () => ['fe80::1'] });
  const status = await controller.start();
  assert.equal(status.urls.length, 1);
  assert.match(status.urls[0], /^http:\/\/\[fe80::1\]:\d+\/$/);
  await controller.stop('test');
});

// ==================== 最近访问 ====================

test('records recent requests so "mount fails" can be told apart', async t => {
  const { status, controller } = await startOpen(t);
  assert.deepEqual(controller.getStatus().recentRequests, []);
  await request(status.port, '/', { method: 'OPTIONS' });
  await request(status.port, '/');
  await request(status.port, '/', { headers: { Host: `localhost:${status.port + 1}` } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const recent = controller.getStatus().recentRequests;
  assert.equal(recent.length, 3);
  assert.equal(recent[0].status, 400);
  assert.equal(recent[0].path, '/');
  assert.equal(recent[0].ip, '127.0.0.1');
  assert.equal(recent[0].method, 'GET');
  assert.ok(recent.every(item => typeof item.at === 'number'));
  assert.deepEqual(recent.map(item => item.path), ['/', '/', '/']);
});

// ==================== IPC 契约：主进程 → preload → 界面 ====================

test('the WebDAV IPC surface is wired consistently across main, preload, and the UI', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/WebDavServer.jsx'), 'utf8');

  const channels = ['select-directory', 'set-credentials', 'get-status', 'start', 'stop'];
  for (const channel of channels) {
    assert.ok(main.includes(`ipcMain.handle('webdav-server:${channel}'`),
      `main.js 应注册 webdav-server:${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('webdav-server:${channel}'`),
      `preload 应调用 webdav-server:${channel}`);
  }

  // 状态推送通道
  assert.ok(main.includes(`webContents.send('webdav-server:status'`),
    'main.js 应推送 webdav-server:status');
  assert.ok(preload.includes(`ipcRenderer.on('webdav-server:status'`),
    'preload 应订阅 webdav-server:status');

  // 界面消费的每个 API 在 preload 都有实现
  for (const api of [
    'getWebDavServerStatus', 'onWebDavServerStatus', 'selectWebDavServerDirectory',
    'setWebDavServerCredentials', 'startWebDavServer', 'stopWebDavServer'
  ]) {
    assert.ok(preload.includes(api), `preload 应暴露 ${api}`);
    assert.ok(ui.includes(api), `WebDavServer.jsx 应消费 ${api}`);
  }

  // 偏好持久化 + 退出收尾
  assert.ok(main.includes(`path.join(app.getPath('userData'), 'webdav-server.json')`),
    '偏好应落在 userData/webdav-server.json');
  assert.ok(/webDavServer\.stop\('app-quit'\)/.test(main), 'before-quit 应停止 WebDAV 服务');
  assert.ok(/webDavServer\.forceClose\(\)/.test(main), 'will-quit 应强制关闭 WebDAV 服务');

  // 密码不跨进程回传：get-status 返回值只包含标志位（不包含 password 字段）
  assert.ok(main.includes('persistedHasPassword'), 'get-status 应返回 persistedHasPassword 标志');
  assert.ok(!/password:\s*(status|preference)\.password/.test(main.split('webdav-server:get-status')[1] || ''),
    'get-status 返回值不应包含密码明文');
  assert.ok(ui.includes('window.confirm'), 'UI 清空密码前应弹确认框');
  assert.ok(!/nextStatus\.password/.test(ui), 'UI 不应从状态里回填密码明文');

  // 重启后偏好预热（不用等用户点启动）
  assert.ok(/applyWebDavPreference\(\)\.catch/.test(main), 'whenReady 应预热 WebDAV 偏好');

  // 功能注册：搜索能搜到
  const registry = fs.readFileSync(path.join(ROOT, 'src/lib/functions.js'), 'utf8');
  assert.ok(registry.includes("'webdav-server'"), '功能注册表应包含 webdav-server');
});
