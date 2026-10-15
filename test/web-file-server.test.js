'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createWebFileServerController = require('../electron/web-file-server');
const { helpers } = createWebFileServerController;

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-file-server-'));
  const controller = createWebFileServerController({
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
      method: options.method || 'GET', headers,
      agent: options.agent
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        json() { return JSON.parse(this.body.toString('utf8')); }
      }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

function withToken(requestPath, token) {
  const url = new URL(requestPath, 'http://127.0.0.1');
  url.searchParams.set('token', token);
  return `${url.pathname}${url.search}`;
}

async function startAuthenticated(t, options = {}) {
  const result = await fixture(t, options);
  const status = await result.controller.start();
  const publicUrl = new URL(status.urls[0]);
  const token = publicUrl.searchParams.get('token');
  return { ...result, status, token, origin: `http://127.0.0.1:${status.port}` };
}

test('exports the documented CommonJS controller contract', async t => {
  assert.equal(typeof createWebFileServerController, 'function');
  assert.equal(createWebFileServerController.createWebFileServerController, createWebFileServerController);
  const { controller, root } = await fixture(t);
  const canonicalRoot = await fsp.realpath(root);
  assert.deepEqual(Object.keys(controller).sort(), ['forceClose', 'getStatus', 'onStatus', 'setRoot', 'start', 'stop'].sort());
  assert.equal(controller.getStatus().state, 'stopped');
  assert.equal(controller.getStatus().selectedRoot, canonicalRoot);
  assert.equal(controller.getStatus().rootPath, canonicalRoot);
  assert.equal(controller.getStatus().port, null);
  assert.deepEqual(controller.getStatus().urls, []);
  assert.equal(controller.getStatus().error, null);
});

test('validates portable filenames and relative paths', () => {
  for (const name of ['plain.txt', '报告.pdf', 'archive.tar.gz']) assert.equal(helpers.isPortableFilename(name), true);
  for (const name of ['', '..', 'a/b', 'a\\b', 'CON.txt', 'bad?.txt', 'trail.']) assert.equal(helpers.isPortableFilename(name), false, name);
  assert.deepEqual(helpers.decodeRelativePath('folder/a%20b'), ['folder', 'a b']);
  assert.throws(() => helpers.decodeRelativePath('../secret'), /traversal/i);
  assert.throws(() => helpers.decodeRelativePath('%2e%2e/secret'), /traversal/i);
  assert.throws(() => helpers.decodeRelativePath('folder%5csecret'), /Invalid path/);
});

test('setRoot canonicalizes directories and rejects root symlinks', async t => {
  const { controller, root } = await fixture(t);
  assert.equal(controller.getStatus().selectedRoot, await fsp.realpath(root));
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
  assert.match(events[2].urls[0], /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
});

test('requires a token on APIs and does not set cookies', async t => {
  const { status, token } = await startAuthenticated(t);
  const denied = await request(status.port, '/api/files');
  assert.equal(denied.status, 401);
  assert.equal(denied.json().error.code, 'UNAUTHORIZED');
  const loginUrl = new URL(status.urls[0]);
  const page = await request(status.port, loginUrl.pathname + loginUrl.search);
  assert.equal(page.status, 200);
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await request(status.port, '/')).status, 200);
  assert.equal((await request(status.port, withToken('/api/files', token))).status, 200);
});

test('enforces exact routes, methods, Host, and Origin', async t => {
  const { status, token, origin } = await startAuthenticated(t);
  assert.equal((await request(status.port, withToken('/unknown', token))).status, 404);
  assert.equal((await request(status.port, withToken('/api/files/', token))).status, 404);
  const wrongMethod = await request(status.port, withToken('/api/files', token), { method: 'POST', headers: { Origin: origin, 'Content-Length': '0' } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, HEAD');
  assert.equal((await request(status.port, '/', { headers: { Host: `localhost:${status.port + 1}` } })).status, 400);
  assert.equal((await request(status.port, withToken('/api/upload', token), { method: 'POST', headers: { 'Content-Length': '0', 'X-File-Name': 'a.txt' } })).status, 403);
  assert.equal((await request(status.port, withToken('/api/upload', token), { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Length': '0', 'X-File-Name': 'a.txt' } })).status, 403);
});

test('serves client assets with hardened headers', async t => {
  const { status } = await startAuthenticated(t);
  for (const asset of ['/', '/app.js', '/styles.css']) {
    const response = await request(status.port, asset);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('lists directories, sorts folders first, and streams downloads', async t => {
  const { root, status, token } = await startAuthenticated(t);
  await fsp.mkdir(path.join(root, 'folder'));
  await fsp.writeFile(path.join(root, 'z.txt'), Buffer.from('download payload'));
  const listed = await request(status.port, withToken('/api/files', token));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json().files.map(item => [item.name, item.type]), [['folder', 'directory'], ['z.txt', 'file']]);
  const downloaded = await request(status.port, withToken('/api/download?path=z.txt', token));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.body.toString(), 'download payload');
  assert.match(downloaded.headers['content-disposition'], /attachment/);
});

test('rejects traversal and symlinks for listing and downloads', async t => {
  const { root, status, token } = await startAuthenticated(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-file-outside-'));
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'secret');
  t.after(() => fsp.rm(outside, { recursive: true, force: true }));
  const traversal = await request(status.port, withToken('/api/download?path=%252e%252e%2Fsecret.txt', token));
  assert.equal(traversal.status, 400);
  const link = path.join(root, 'linked');
  try {
    await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  assert.equal((await request(status.port, withToken('/api/files?path=linked', token))).status, 403);
  assert.equal((await request(status.port, withToken('/api/download?path=linked%2Fsecret.txt', token))).status, 403);
});

test('enforces the configurable listing cap', async t => {
  const { root, status, token } = await startAuthenticated(t, { listingLimit: 2 });
  await Promise.all(['a', 'b', 'c'].map(name => fsp.writeFile(path.join(root, name), name)));
  const response = await request(status.port, withToken('/api/files', token));
  assert.equal(response.status, 413);
  assert.equal(response.json().error.code, 'LISTING_LIMIT');
});

test('uploads bytes exclusively and rejects invalid names and oversized bodies', async t => {
  const { root, status, token, origin, controller } = await startAuthenticated(t, { uploadLimitBytes: 8 });
  const diskRoot = controller.getStatus().selectedRoot;
  const upload = body => request(status.port, withToken('/api/upload', token), {
    method: 'POST', body,
    headers: { Origin: origin, 'Content-Length': String(body.length), 'X-File-Name': encodeURIComponent('new file.txt') }
  });
  const created = await upload(Buffer.from('hello'));
  assert.equal(created.status, 201);
  assert.equal(await fsp.readFile(path.join(diskRoot, 'new file.txt'), 'utf8'), 'hello');
  assert.equal((await upload(Buffer.from('again'))).status, 409);
  assert.equal(await fsp.readFile(path.join(diskRoot, 'new file.txt'), 'utf8'), 'hello');
  const invalid = await request(status.port, withToken('/api/upload', token), {
    method: 'POST', body: Buffer.from('x'),
    headers: { Origin: origin, 'Content-Length': '1', 'X-File-Name': encodeURIComponent('CON.txt') }
  });
  assert.equal(invalid.status, 400);
  const large = await request(status.port, withToken('/api/upload', token), {
    method: 'POST', body: Buffer.alloc(9),
    headers: { Origin: origin, 'Content-Length': '9', 'X-File-Name': 'large.bin' }
  });
  assert.equal(large.status, 413);
  await assert.rejects(fsp.access(path.join(diskRoot, 'large.bin')));
});

test('creates subdirectories from X-File-Path for folder uploads', async t => {
  const { root, status, token, origin, controller } = await startAuthenticated(t, { uploadLimitBytes: 100 });
  const diskRoot = controller.getStatus().selectedRoot;
  const body = Buffer.from('nested');
  const response = await request(status.port, withToken('/api/upload', token), {
    method: 'POST', body,
    headers: {
      Origin: origin,
      'Content-Length': String(body.length),
      'X-File-Name': encodeURIComponent('inner.txt'),
      'X-File-Path': encodeURIComponent('myfolder/sub')
    }
  });
  assert.equal(response.status, 201);
  assert.equal(await fsp.readFile(path.join(diskRoot, 'myfolder', 'sub', 'inner.txt'), 'utf8'), 'nested');
  // re-uploading to the same sub-path still 409s (file exists, dir already created)
  const dup = await request(status.port, withToken('/api/upload', token), {
    method: 'POST', body,
    headers: {
      Origin: origin,
      'Content-Length': String(body.length),
      'X-File-Name': encodeURIComponent('inner.txt'),
      'X-File-Path': encodeURIComponent('myfolder/sub')
    }
  });
  assert.equal(dup.status, 409);
  // traversal in X-File-Path is rejected
  const bad = await request(status.port, withToken('/api/upload', token), {
    method: 'POST', body,
    headers: {
      Origin: origin,
      'Content-Length': String(body.length),
      'X-File-Name': encodeURIComponent('evil.txt'),
      'X-File-Path': encodeURIComponent('../escape')
    }
  });
  assert.equal(bad.status, 400);
});

test('allows two active uploads and rejects a third', async t => {
  const { status, token, origin } = await startAuthenticated(t, { maxConcurrentUploads: 2, uploadLimitBytes: 100 });
  const openUpload = filename => {
    const req = http.request({
      host: '127.0.0.1', port: status.port, path: withToken('/api/upload', token), method: 'POST',
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin, 'Content-Length': '4', 'X-File-Name': filename }
    });
    req.write('a');
    return req;
  };
  const first = openUpload('one.txt');
  const second = openUpload('two.txt');
  await new Promise(resolve => setTimeout(resolve, 20));
  const third = await request(status.port, withToken('/api/upload', token), {
    method: 'POST', body: Buffer.from('four'),
    headers: { Origin: origin, 'Content-Length': '4', 'X-File-Name': 'three.txt' }
  });
  assert.equal(third.status, 429);
  first.end('bcd');
  second.end('bcd');
  first.on('error', () => {});
  second.on('error', () => {});
});

test('cleans an incomplete upload after the client disconnects', async t => {
  const { root, status, token, origin } = await startAuthenticated(t);
  await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: status.port, path: withToken('/api/upload', token), method: 'POST',
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin, 'Content-Length': '10', 'X-File-Name': 'partial.txt' }
    });
    req.on('error', () => resolve());
    req.write('part');
    req.destroy();
    setTimeout(resolve, 30);
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(fsp.access(path.join(root, 'partial.txt')));
});

test('stop closes idle sockets and forceClose is synchronous and idempotent', async t => {
  const { controller, status } = await startAuthenticated(t);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  assert.equal((await request(status.port, '/', { agent })).status, 200);
  const stopped = await controller.stop('test');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.port, null);
  assert.deepEqual(stopped.urls, []);
  assert.deepEqual(controller.forceClose(), stopped);
});

test('a fixed access token keeps the same URL across restarts', async t => {
  const { controller } = await fixture(t, { accessToken: 'stable-token-value' });
  const first = await controller.start();
  assert.equal(new URL(first.urls[0]).searchParams.get('token'), 'stable-token-value');
  await controller.stop('test');
  const second = await controller.start();
  assert.equal(new URL(second.urls[0]).searchParams.get('token'), 'stable-token-value');
  // 同一台机器上端口也被记住，所以整条地址完全一致
  assert.equal(second.urls[0], first.urls[0]);
});

test('requireToken false serves a clean fixed URL with no auth', async t => {
  const { controller, root } = await fixture(t, { requireToken: false });
  const status = await controller.start();
  assert.equal(status.tokenRequired, false);
  assert.match(status.urls[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(new URL(status.urls[0]).searchParams.has('token'), false);

  // 不带 token 直接调 API 也能通
  await fsp.writeFile(path.join(root, 'plain.txt'), 'ok');
  assert.equal((await request(status.port, '/api/files')).status, 200);
  assert.equal((await request(status.port, '/api/download?path=plain.txt')).body.toString(), 'ok');

  // 地址在重启后保持不变
  await controller.stop('test');
  const again = await controller.start();
  assert.equal(again.urls[0], status.urls[0]);
  assert.equal(again.tokenRequired, false);
});

test('requireToken false still rejects wrong Host and cross-origin uploads', async t => {
  const { status } = await startAuthenticated(t, { requireToken: false });
  assert.equal((await request(status.port, '/', { headers: { Host: `localhost:${status.port + 1}` } })).status, 400);
  const crossOrigin = await request(status.port, '/api/upload', {
    method: 'POST',
    body: Buffer.from('x'),
    headers: { Origin: 'http://evil.example', 'Content-Length': '1', 'X-File-Name': 'a.txt' }
  });
  assert.equal(crossOrigin.status, 403);
});

test('only advertises addresses a phone can actually reach', () => {
  const { isAdvertisableAddress } = helpers;
  // 可用：正常私网 / 公网 IPv4，全局 IPv6
  assert.equal(isAdvertisableAddress('192.168.8.195'), true);
  assert.equal(isAdvertisableAddress('10.0.0.7'), true);
  assert.equal(isAdvertisableAddress('172.16.5.4'), true);
  assert.equal(isAdvertisableAddress('2001:db8::1'), true);
  // 169.254.x 必须保留：USB 直连 / 同链路上双方都没 DHCP 时它真的能用，
  // 实测见过 iPhone 就是靠 http://169.254.x.x:端口/ 打开页面的
  assert.equal(isAdvertisableAddress('169.254.230.49'), true);
  // 不可用：IPv6 链路本地（没有 zone id 写不成能用的 URL）、回环、非法值
  assert.equal(isAdvertisableAddress('fe80::1092:aeb2:f4e0:b1f5'), false);
  assert.equal(isAdvertisableAddress('FE80::1'), false);
  assert.equal(isAdvertisableAddress('::1'), false);
  assert.equal(isAdvertisableAddress('not-an-ip'), false);
});

test('labels each address with the actual network card, not a generic "LAN"', () => {
  const { describeAddressKind } = helpers;
  const labels = { en0: '以太网（有线）', en1: 'Wi-Fi（无线）' };

  // 关键：两个互不相通的子网必须能区分开 —— 只说「局域网」用户没法选
  assert.equal(describeAddressKind('192.168.8.195', 'en0', labels), '以太网（有线）');
  assert.equal(describeAddressKind('192.168.35.75', 'en1', labels), 'Wi-Fi（无线）');
  assert.notEqual(
    describeAddressKind('192.168.8.195', 'en0', labels),
    describeAddressKind('192.168.35.75', 'en1', labels)
  );

  // 探测不到网卡类型时退回带网卡名的说法，仍能区分
  assert.equal(describeAddressKind('192.168.8.195', 'en0', {}), '局域网 · en0');
  assert.equal(describeAddressKind('2001:db8::1', 'en1', {}), 'IPv6 · en1');
  // 连网卡名都没有时退到最朴素的说法
  assert.equal(describeAddressKind('192.168.8.195'), '局域网');

  // USB 直连优先，不参与网卡标注
  assert.equal(describeAddressKind('169.254.230.49', 'en8', labels), 'USB 直连 / 链路本地');
});

test('keeps the USB link-local address but drops unusable IPv6 link-local noise', async t => {
  const { controller } = await fixture(t, {
    requireToken: false,
    getNetworkAddresses: () => [
      'fe80::1092:aeb2:f4e0:b1f5',
      '169.254.230.49',
      '192.168.8.195',
      'fe80::42b2:d703:bb97:8dcc'
    ]
  });
  const status = await controller.start({ requireToken: false });

  // fe80:: 全部丢掉，192.168 与 169.254 都保留（169.254 是 iPhone USB 那条路）
  assert.deepEqual(status.urls, [
    `http://192.168.8.195:${status.port}/`,
    `http://169.254.230.49:${status.port}/`
  ]);
  assert.equal(status.primaryAddress, '192.168.8.195');
  // 注入的地址没有网卡信息，退回朴素标注；有网卡信息时由 describeAddressKind 单测覆盖
  assert.equal(status.addressKinds['192.168.8.195'], '局域网');
  assert.equal(status.addressKinds['169.254.230.49'], 'USB 直连 / 链路本地');
});

test('falls back to the raw list when every address is IPv6 link-local', async t => {
  const { controller } = await fixture(t, {
    requireToken: false,
    getNetworkAddresses: () => ['fe80::1']
  });
  const status = await controller.start({ requireToken: false });
  // 宁可给出不完美的地址，也不要一个地址都不给
  assert.equal(status.urls.length, 1);
  assert.match(status.urls[0], /^http:\/\/\[fe80::1\]:\d+\/$/);
});

test('records recent requests so "phone cannot connect" can be told apart', async t => {
  const { status, controller } = await startAuthenticated(t, { requireToken: false });
  assert.deepEqual(controller.getStatus().recentRequests, []);

  await request(status.port, '/');
  await request(status.port, '/api/files');
  await request(status.port, '/', { headers: { Host: `localhost:${status.port + 1}` } });
  // finish 事件在响应发完之后才触发，给它一个 tick
  await new Promise(resolve => setTimeout(resolve, 30));

  const recent = controller.getStatus().recentRequests;
  assert.equal(recent.length, 3);
  // 最新的在最前
  assert.equal(recent[0].status, 400);
  assert.equal(recent[0].path, '/');
  assert.equal(recent[0].ip, '127.0.0.1');
  assert.equal(recent[0].method, 'GET');
  assert.ok(recent.every(item => typeof item.at === 'number'));
  assert.deepEqual(recent.map(item => item.path), ['/', '/api/files', '/']);
});
