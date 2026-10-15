'use strict';

/**
 * Local-network file server for Electron main-process integration.
 *
 * Public CommonJS API:
 *   createWebFileServerController(options) -> controller
 *   controller.setRoot(absolutePath)
 *   controller.getStatus()
 *   controller.start()
 *   controller.stop(reason?)
 *   controller.forceClose()
 *   controller.onStatus(listener) -> unsubscribe
 *
 * Only Node built-ins are used. Limit-related options are configurable so the
 * same security paths can be exercised without allocating production-sized
 * resources in tests.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const CLIENT_DIRECTORY = path.join(__dirname, 'web-file-server-client');
const DEFAULTS = Object.freeze({
  uploadLimitBytes: 2 * 1024 * 1024 * 1024,
  listingLimit: 10_000,
  maxConcurrentUploads: 2,
  shutdownGraceMs: 5_000,
  requestTimeoutMs: 30 * 60 * 1_000
});
const ROUTES = Object.freeze({
  index: '/',
  script: '/app.js',
  stylesheet: '/styles.css',
  files: '/api/files',
  download: '/api/download',
  upload: '/api/upload'
});

/** 保留多少条最近访问记录（用于「手机连不上」这类问题的定位）。 */
const RECENT_REQUEST_LIMIT = 20;

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
});

function makeError(statusCode, code, message, headers) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.headers = headers;
  return error;
}

function errorStatus(error) {
  if (Number.isInteger(error && error.statusCode)) return error.statusCode;
  if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 404;
  if (error && error.code === 'EEXIST') return 409;
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return 403;
  return 500;
}

function portableFilenameError(name) {
  if (typeof name !== 'string' || name.length === 0) return 'Filename is required';
  if (Buffer.byteLength(name, 'utf8') > 255) return 'Filename is too long';
  if (name === '.' || name === '..') return 'Reserved filename';
  if (/[/\\\0<>:"|?*\x00-\x1f]/.test(name)) return 'Filename contains a non-portable character';
  if (/[ .]$/.test(name)) return 'Filename cannot end with a space or period';
  const stem = name.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return 'Reserved filename';
  return null;
}

function isPortableFilename(name) {
  return portableFilenameError(name) === null;
}

function decodeRelativePath(value) {
  if (typeof value !== 'string') throw makeError(400, 'INVALID_PATH', 'Path must be a string');
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (_) {
    throw makeError(400, 'INVALID_PATH', 'Path contains invalid encoding');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw makeError(400, 'INVALID_PATH', 'Invalid path');
  }
  const segments = decoded.split('/').filter(Boolean);
  if (path.posix.isAbsolute(decoded) || segments.some(part => part === '.' || part === '..')) {
    throw makeError(400, 'INVALID_PATH', 'Path traversal is not allowed');
  }
  return segments;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveSafePath(root, encodedPath, options = {}) {
  const segments = decodeRelativePath(encodedPath || '');
  if (options.requirePortable) {
    for (const segment of segments) {
      const problem = portableFilenameError(segment);
      if (problem) throw makeError(400, 'INVALID_FILENAME', problem);
    }
  }
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!pathInside(root, current)) throw makeError(400, 'INVALID_PATH', 'Path traversal is not allowed');
    const isLeaf = index === segments.length - 1;
    if (isLeaf && options.allowMissingLeaf) break;
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') throw makeError(404, 'NOT_FOUND', 'Path not found');
      throw error;
    }
    if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'Symbolic links and junctions are not allowed');
    if (!isLeaf && !stat.isDirectory()) throw makeError(404, 'NOT_FOUND', 'Path not found');
    const real = await fsp.realpath(current);
    if (!pathInside(root, real)) throw makeError(403, 'LINK_REJECTED', 'Path leaves the selected root');
    current = real;
  }
  return current;
}

function normalizeHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes(',')) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch (_) {
    return null;
  }
}

function isLocalAddress(address) {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function collectInterfaceAddresses(networkInterfaces = os.networkInterfaces()) {
  return collectAddressEntries(networkInterfaces)
    .map((entry) => entry.address)
    .sort((a, b) => {
      const familyDifference = net.isIP(a) - net.isIP(b);
      return familyDifference || a.localeCompare(b);
    });
}

/** 和 collectInterfaceAddresses 一样，但顺带带上网卡名（用来判断是 Wi-Fi 还是插网线）。 */
function collectAddressEntries(networkInterfaces = os.networkInterfaces()) {
  const seen = new Set();
  const entries = [];
  for (const [name, records] of Object.entries(networkInterfaces)) {
    for (const record of records || []) {
      if (!record || record.internal || net.isIP(record.address) === 0) continue;
      if (seen.has(record.address)) continue;
      seen.add(record.address);
      entries.push({ address: record.address, interface: name });
    }
  }
  return entries;
}

function formatUrlHost(address) {
  return net.isIP(address) === 6 ? `[${address}]` : address;
}

/**
 * 只保留别的设备真的能连上的地址。
 *
 * **只过滤 IPv6 链路本地**（`fe80::/10`）：没有 zone id 时写成 URL 谁都不通，浏览器也解析不了。
 *
 * **不要过滤 IPv4 的 169.254.x**：那是「USB 直连 / 同一链路上双方都没拿到 DHCP」时的正常地址，
 * 直连的设备（典型是 iPhone 的 USB 网络）**真的能连上**。实测见过 iPhone 就是用
 * `http://169.254.x.x:端口/` 打开页面的 —— 一刀切过滤会把这条路掐掉。
 */
function isAdvertisableAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return true;
  if (family === 6) {
    const lower = String(address).toLowerCase();
    if (lower === '::1') return false;
    return !/^fe[89ab]/.test(lower);
  }
  return false;
}

/**
 * 给地址一句人话说明，帮用户挑对。
 *
 * 同一台电脑常常同时接好几个互不相通的网络（实测见过：有线 192.168.8.x + Wi-Fi 192.168.35.x），
 * 两条都标成「局域网」等于没标 —— 必须说清是**哪块网卡**，用户才能对上手机连的是哪个。
 *
 * @param {string} address
 * @param {string} interfaceName 网卡名（en0 / en1 …）
 * @param {Record<string,string>} interfaceLabels 网卡名 → 人话（由主进程探测后传入）
 */
function describeAddressKind(address, interfaceName, interfaceLabels = {}) {
  const value = String(address || '');
  if (value.startsWith('169.254.')) return 'USB 直连 / 链路本地';

  const named = interfaceName ? interfaceLabels[interfaceName] : '';
  if (named) return named;
  if (net.isIP(value) === 6) return interfaceName ? `IPv6 · ${interfaceName}` : 'IPv6';
  return interfaceName ? `局域网 · ${interfaceName}` : '局域网';
}

function sortLanAddresses(addresses) {
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    if (net.isIP(ip) === 6) return 8;
    if (ip.startsWith('169.254.') || ip.toLowerCase().startsWith('fe80:')) return 9;
    return 5;
  };
  return [...addresses].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

function pickPrimaryAddress(addresses, preferredAddress) {
  const sorted = sortLanAddresses(addresses);
  if (preferredAddress && sorted.includes(preferredAddress)) return preferredAddress;
  return sorted[0] || '127.0.0.1';
}

function listenAsync(server, listenOptions) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenOptions);
  });
}

async function bindPreferredPort(server, preferredPort) {
  const defaultPort = 18765;
  const ports = [];
  const add = (value) => {
    if (Number.isInteger(value) && value > 0 && value <= 65535 && !ports.includes(value)) ports.push(value);
  };
  add(preferredPort);
  add(defaultPort);
  for (let port = defaultPort + 1; port <= defaultPort + 12; port += 1) add(port);

  let lastError = null;
  for (const port of ports) {
    try {
      return await listenAsync(server, { host: '0.0.0.0', port, exclusive: true });
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  try {
    return await listenAsync(server, { host: '0.0.0.0', port: 0, exclusive: true });
  } catch (error) {
    throw lastError || error;
  }
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function makeToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString('base64url');
}

function buildPublicUrls(addresses, port, token) {
  const hosts = addresses.length ? addresses : ['127.0.0.1'];
  return hosts.map(address => {
    const base = `http://${formatUrlHost(address)}:${port}/`;
    // 未启用令牌时不拼 token，地址就是干净的 http://ip:port/，且在多次启停之间保持不变
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  });
}

function writeJson(response, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(body);
}

function writeError(response, error) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const statusCode = errorStatus(error);
  const code = statusCode === 500 ? 'INTERNAL_ERROR' : (error.code || 'REQUEST_ERROR');
  const message = statusCode === 500 ? 'Internal server error' : error.message;
  writeJson(response, statusCode, { error: { code, message } }, error.headers || {});
}

function methodNotAllowed(response, methods) {
  writeError(response, makeError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { Allow: methods.join(', ') }));
}

async function serveAsset(response, filename) {
  const assetPath = path.join(CLIENT_DIRECTORY, filename);
  const data = await fsp.readFile(assetPath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filename)] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(data);
}

async function listDirectory(root, encodedPath, listingLimit) {
  const directory = await resolveSafePath(root, encodedPath);
  const stat = await fsp.lstat(directory);
  if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'Symbolic links and junctions are not allowed');
  if (!stat.isDirectory()) throw makeError(400, 'NOT_DIRECTORY', 'Requested path is not a directory');

  const handle = await fsp.opendir(directory);
  const files = [];
  try {
    for await (const entry of handle) {
      if (files.length >= listingLimit) {
        throw makeError(413, 'LISTING_LIMIT', `Directory contains more than ${listingLimit} entries`);
      }
      const fullPath = path.join(directory, entry.name);
      let itemStat;
      try {
        itemStat = await fsp.lstat(fullPath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (itemStat.isSymbolicLink()) continue;
      const isDirectory = itemStat.isDirectory();
      if (!isDirectory && !itemStat.isFile()) continue;
      files.push({
        name: entry.name,
        type: isDirectory ? 'directory' : 'file',
        size: isDirectory ? null : itemStat.size,
        modifiedAt: itemStat.mtime.toISOString()
      });
    }
  } finally {
    try { await handle.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; }
  }
  files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  const relative = path.relative(root, directory).split(path.sep).filter(Boolean).join('/');
  return { path: relative, files };
}

async function streamDownload(root, encodedPath, request, response) {
  const filePath = await resolveSafePath(root, encodedPath);
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'Symbolic links and junctions are not allowed');
  if (!stat.isFile()) throw makeError(400, 'NOT_FILE', 'Requested path is not a regular file');
  const filename = path.basename(filePath);
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download.bin';
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', error => {
    if (!response.headersSent) writeError(response, error);
    else response.destroy(error);
  });
  request.on('aborted', () => stream.destroy());
  stream.pipe(response);
}

function parseUploadHeaders(request, uploadLimitBytes) {
  const rawLength = request.headers['content-length'];
  if (rawLength === undefined) throw makeError(411, 'LENGTH_REQUIRED', 'Content-Length is required');
  if (!/^\d+$/.test(rawLength)) throw makeError(400, 'INVALID_LENGTH', 'Invalid Content-Length');
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) throw makeError(400, 'INVALID_LENGTH', 'Invalid Content-Length');
  if (length > uploadLimitBytes) throw makeError(413, 'UPLOAD_TOO_LARGE', `Upload exceeds ${uploadLimitBytes} bytes`);
  const rawName = request.headers['x-file-name'];
  if (Array.isArray(rawName) || typeof rawName !== 'string') {
    throw makeError(400, 'INVALID_FILENAME', 'X-File-Name is required');
  }
  let filename;
  try {
    filename = decodeURIComponent(rawName);
  } catch (_) {
    throw makeError(400, 'INVALID_FILENAME', 'Filename contains invalid encoding');
  }
  const problem = portableFilenameError(filename);
  if (problem) throw makeError(400, 'INVALID_FILENAME', problem);
  // 文件夹上传时客户端会带 X-File-Path 头，表示文件在所选文件夹下的相对子路径
  let relativeSegments = [];
  const rawFilePath = request.headers['x-file-path'];
  if (typeof rawFilePath === 'string' && rawFilePath) {
    relativeSegments = decodeRelativePath(rawFilePath);
    for (const segment of relativeSegments) {
      const segProblem = portableFilenameError(segment);
      if (segProblem) throw makeError(400, 'INVALID_FILENAME', segProblem);
    }
  }
  return { length, filename, relativeSegments };
}

function drainOrDestroy(request) {
  if (request.destroyed || request.readableEnded) return;
  request.resume();
}

async function streamUpload(root, encodedDirectory, request, options) {
  const { uploadLimitBytes } = options;
  const { length, filename, relativeSegments } = parseUploadHeaders(request, uploadLimitBytes);
  const directory = await resolveSafePath(root, encodedDirectory);
  const directoryStat = await fsp.lstat(directory);
  if (directoryStat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'Symbolic links and junctions are not allowed');
  if (!directoryStat.isDirectory()) throw makeError(400, 'NOT_DIRECTORY', 'Upload target is not a directory');

  // 文件夹上传：在目标目录下逐级创建子目录（已存在则跳过），并校验每一段都不是符号链接
  let targetDir = directory;
  for (const segment of relativeSegments) {
    const next = path.join(targetDir, segment);
    if (!pathInside(root, next)) throw makeError(400, 'INVALID_PATH', 'Path traversal is not allowed');
    try {
      const stat = await fsp.lstat(next);
      if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'Symbolic links and junctions are not allowed');
      if (!stat.isDirectory()) throw makeError(400, 'NOT_DIRECTORY', 'A file already exists at this path');
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fsp.mkdir(next, { recursive: false });
      } else {
        throw error;
      }
    }
    targetDir = next;
  }

  const target = path.join(targetDir, filename);
  if (!pathInside(root, target)) throw makeError(400, 'INVALID_PATH', 'Path traversal is not allowed');

  let handle;
  let completed = false;
  let received = 0;
  try {
    handle = await fsp.open(target, 'wx', 0o600);
    for await (const chunk of request) {
      received += chunk.length;
      if (received > uploadLimitBytes || received > length) {
        throw makeError(413, 'UPLOAD_TOO_LARGE', 'Upload exceeded its declared or configured size');
      }
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset, null);
        offset += result.bytesWritten;
      }
    }
    if (received !== length) throw makeError(400, 'INCOMPLETE_UPLOAD', 'Upload was incomplete');
    await handle.sync();
    completed = true;
    return { name: filename, size: received };
  } catch (error) {
    if (error.code === 'EEXIST') throw makeError(409, 'FILE_EXISTS', 'A file with this name already exists');
    throw error;
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_) { /* 关闭失败不影响已经完成的上传 */ }
      if (!completed) {
        try { await fsp.unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
}

function createUploadGate(limit) {
  let active = 0;
  return {
    tryEnter() {
      if (active >= limit) return false;
      active += 1;
      return true;
    },
    leave() {
      active = Math.max(0, active - 1);
    },
    get active() { return active; }
  };
}

function createWebFileServerController(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const config = {
    uploadLimitBytes: options.uploadLimitBytes ?? DEFAULTS.uploadLimitBytes,
    listingLimit: options.listingLimit ?? DEFAULTS.listingLimit,
    maxConcurrentUploads: options.maxConcurrentUploads ?? DEFAULTS.maxConcurrentUploads,
    shutdownGraceMs: options.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs
  };
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < (name === 'shutdownGraceMs' ? 0 : 1)) {
      throw new TypeError(`${name} must be a valid positive integer`);
    }
  }

  const listeners = new Set();
  const sockets = new Set();
  const uploadGate = createUploadGate(config.maxConcurrentUploads);
  // 访问令牌策略：
  // - requireToken !== false 时启用令牌鉴权（默认，保持既有行为）
  // - accessToken 传入固定令牌时，地址在多次启停之间保持不变（不再每次随机）
  // 两者都可以在 start() 时按次覆盖，便于用户在运行期切换。
  let tokenRequired = options.requireToken !== false;
  let stableToken = typeof options.accessToken === 'string' && options.accessToken ? options.accessToken : null;
  let selectedRoot = null;
  let server = null;
  let token = null;
  let state = 'stopped';
  let port = null;
  let urls = [];
  let lastError = null;
  let lastChangeNotice = null;
  let primaryAddress = null;
  let advertisedEntries = [];
  let interfaceLabels = {};
  const recentRequests = [];
  let transition = Promise.resolve();

  function snapshot() {
    return {
      state,
      selectedRoot,
      rootPath: selectedRoot,
      port,
      primaryAddress,
      urls: [...urls],
      tokenRequired,
      addressKinds: Object.fromEntries(
        advertisedEntries.map((entry) => [
          entry.address,
          describeAddressKind(entry.address, entry.interface, interfaceLabels)
        ])
      ),
      recentRequests: [...recentRequests],
      changeNotice: lastChangeNotice,
      error: lastError ? { code: lastError.code || 'SERVER_ERROR', message: lastError.message } : null
    };
  }

  function emitStatus() {
    const status = snapshot();
    for (const listener of [...listeners]) {
      try { listener(status); } catch (_) { /* 单个订阅者抛错不能影响其它订阅者 */ }
    }
  }

  function update(nextState, updates = {}) {
    state = nextState;
    if (Object.prototype.hasOwnProperty.call(updates, 'port')) port = updates.port;
    if (Object.prototype.hasOwnProperty.call(updates, 'urls')) urls = updates.urls;
    if (Object.prototype.hasOwnProperty.call(updates, 'error')) lastError = updates.error;
    emitStatus();
  }

  function queue(operation) {
    const result = transition.then(operation, operation);
    transition = result.catch(() => {});
    return result;
  }

  function verifyHost(request) {
    const host = normalizeHostHeader(request.headers.host);
    if (!host) throw makeError(400, 'INVALID_HOST', 'Invalid Host header');
    const hostPort = Number(host.port || 80);
    if (hostPort !== port) throw makeError(400, 'INVALID_HOST', 'Invalid Host header');
    const hostname = host.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isLocalAddress(hostname)) return host;
    const localAddress = String(request.socket.localAddress || '').replace(/^::ffff:/, '').toLowerCase();
    const allowed = new Set(collectInterfaceAddresses().map((address) => address.toLowerCase()));
    if (hostname === localAddress || allowed.has(hostname)) return host;
    throw makeError(400, 'INVALID_HOST', 'Host header does not match the connected server');
  }

  function verifyOrigin(request, host) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (typeof origin !== 'string') throw makeError(403, 'INVALID_ORIGIN', 'Origin header is required');
    let parsed;
    try { parsed = new URL(origin); } catch (_) { throw makeError(403, 'INVALID_ORIGIN', 'Invalid Origin header'); }
    const expectedPort = host.port || '80';
    const originPort = parsed.port || (parsed.protocol === 'http:' ? '80' : '');
    if (parsed.protocol !== 'http:' || parsed.hostname.toLowerCase() !== host.hostname || originPort !== expectedPort || parsed.origin !== origin) {
      throw makeError(403, 'INVALID_ORIGIN', 'Origin does not match this server');
    }
  }

  function authenticate(parsedUrl) {
    // 未启用令牌时直接放行，客户端无需带 token 参数
    if (!token) return true;
    const queryToken = parsedUrl.searchParams.get('token');
    if (queryToken && safeEqual(queryToken, token)) return true;
    throw makeError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  async function handleRequest(request, response) {
    response.setHeader('Connection', state === 'stopping' ? 'close' : 'keep-alive');
    // 记下最近访问，用于区分「手机压根没连上（网络问题）」和「连上了但被拒（服务端问题）」。
    // 挂 finish 而不是在这里读 statusCode：那时状态码已经写好了，且错误响应也会走到。
    response.on('finish', () => {
      recentRequests.unshift({
        at: Date.now(),
        ip: String(request.socket.remoteAddress || '').replace(/^::ffff:/, ''),
        method: request.method,
        path: String(request.url || '').split('?')[0],
        status: response.statusCode
      });
      if (recentRequests.length > RECENT_REQUEST_LIMIT) recentRequests.length = RECENT_REQUEST_LIMIT;
    });
    const host = verifyHost(request);
    const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
    const isAsset = parsedUrl.pathname === ROUTES.index
      || parsedUrl.pathname === ROUTES.script
      || parsedUrl.pathname === ROUTES.stylesheet;
    if (!isAsset) authenticate(parsedUrl);
    verifyOrigin(request, host);
    if (!selectedRoot) throw makeError(409, 'ROOT_REQUIRED', 'No root directory is selected');

    if (parsedUrl.pathname === ROUTES.index) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response, ['GET', 'HEAD']);
      return serveAsset(response, 'index.html');
    }
    if (parsedUrl.pathname === ROUTES.script) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response, ['GET', 'HEAD']);
      return serveAsset(response, 'app.js');
    }
    if (parsedUrl.pathname === ROUTES.stylesheet) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response, ['GET', 'HEAD']);
      return serveAsset(response, 'styles.css');
    }
    if (parsedUrl.pathname === ROUTES.files) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response, ['GET', 'HEAD']);
      const result = await listDirectory(selectedRoot, parsedUrl.searchParams.get('path') || '', config.listingLimit);
      return writeJson(response, 200, result);
    }
    if (parsedUrl.pathname === ROUTES.download) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response, ['GET', 'HEAD']);
      if (!parsedUrl.searchParams.has('path')) throw makeError(400, 'INVALID_PATH', 'Download path is required');
      return streamDownload(selectedRoot, parsedUrl.searchParams.get('path'), request, response);
    }
    if (parsedUrl.pathname === ROUTES.upload) {
      if (request.method !== 'POST') return methodNotAllowed(response, ['POST']);
      if (!uploadGate.tryEnter()) {
        drainOrDestroy(request);
        throw makeError(429, 'TOO_MANY_UPLOADS', 'At most two uploads may run concurrently', { 'Retry-After': '1' });
      }
      try {
        const result = await streamUpload(selectedRoot, parsedUrl.searchParams.get('path') || '', request, config);
        return writeJson(response, 201, { uploaded: result });
      } finally {
        uploadGate.leave();
      }
    }
    throw makeError(404, 'NOT_FOUND', 'Route not found');
  }

  async function setRoot(nextRoot) {
    return queue(async () => {
      if (state !== 'stopped') throw new Error('Stop the file server before changing its root');
      if (typeof nextRoot !== 'string' || !path.isAbsolute(nextRoot)) {
        throw new TypeError('Root must be an absolute directory path');
      }
      const stat = await fsp.lstat(nextRoot);
      if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'The selected root cannot be a symbolic link or junction');
      if (!stat.isDirectory()) throw new TypeError('Root must be a directory');
      const canonical = await fsp.realpath(nextRoot);
      const canonicalStat = await fsp.lstat(canonical);
      if (!canonicalStat.isDirectory()) throw new TypeError('Root must be a directory');
      selectedRoot = canonical;
      lastError = null;
      emitStatus();
      return snapshot();
    });
  }

  async function start(listenOptions = {}) {
    return queue(async () => {
      if (state === 'running') return snapshot();
      if (state !== 'stopped') throw new Error(`Cannot start while server is ${state}`);
      if (!selectedRoot) throw new Error('Select a root directory before starting');
      const preferredPort = Number.isInteger(listenOptions.preferredPort) ? listenOptions.preferredPort : null;
      const preferredAddress = typeof listenOptions.preferredAddress === 'string' ? listenOptions.preferredAddress : null;
      if (Object.prototype.hasOwnProperty.call(listenOptions, 'requireToken')) {
        tokenRequired = listenOptions.requireToken !== false;
      }
      if (typeof listenOptions.accessToken === 'string' && listenOptions.accessToken) {
        stableToken = listenOptions.accessToken;
      }
      update('starting', { port: null, urls: [], error: null });
      lastChangeNotice = null;
      primaryAddress = null;
      token = tokenRequired
        ? (stableToken || makeToken(options.randomBytes || crypto.randomBytes))
        : null;
      const candidate = http.createServer((request, response) => {
        Promise.resolve(handleRequest(request, response)).catch(error => {
          drainOrDestroy(request);
          writeError(response, error);
        });
      });
      server = candidate;
      candidate.requestTimeout = config.requestTimeoutMs;
      candidate.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
      candidate.keepAliveTimeout = 5_000;
      candidate.maxHeadersCount = 64;
      candidate.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      candidate.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      });
      try {
        const addressInfo = await bindPreferredPort(candidate, preferredPort);
        port = addressInfo.port;
        const rawEntries = options.getNetworkAddresses
          ? options.getNetworkAddresses().map((address) => ({ address, interface: null }))
          : collectAddressEntries();
        // 过滤掉链路本地等连不上的地址；万一全被过滤掉就退回原始列表，
        // 宁可给出不完美的地址，也不要一个地址都不给
        const advertisable = rawEntries.filter((entry) => isAdvertisableAddress(entry.address));
        const entries = advertisable.length ? advertisable : rawEntries;
        advertisedEntries = entries;
        interfaceLabels = options.getInterfaceLabels ? (options.getInterfaceLabels() || {}) : {};
        const addresses = entries.map((entry) => entry.address);
        primaryAddress = pickPrimaryAddress(addresses, preferredAddress);
        const orderedAddresses = primaryAddress
          ? [primaryAddress, ...addresses.filter((item) => item !== primaryAddress)]
          : addresses;
        urls = buildPublicUrls(orderedAddresses, port, token);
        const portChanged = preferredPort != null && preferredPort !== port;
        const addressChanged = Boolean(preferredAddress) && preferredAddress !== primaryAddress;
        lastChangeNotice = (portChanged || addressChanged) ? {
          portChanged,
          addressChanged,
          previousPort: preferredPort,
          previousAddress: preferredAddress,
          port,
          address: primaryAddress,
          message: [
            portChanged ? `端口已从 ${preferredPort} 改为 ${port}` : `端口仍为 ${port}`,
            addressChanged ? `地址已从 ${preferredAddress} 改为 ${primaryAddress}` : `地址仍为 ${primaryAddress}`
          ].join('，') + '。请使用当前页面显示的新地址或二维码。'
        } : null;
        update('running', { port, urls, error: null });
        return snapshot();
      } catch (error) {
        try { candidate.close(); } catch (_) { /* 端口占用时关掉这个候选，继续试下一个 */ }
        server = null;
        token = null;
        primaryAddress = null;
        advertisedEntries = [];

        lastChangeNotice = null;
        update('stopped', { port: null, urls: [], error });
        throw error;
      }
    });
  }

  function destroySockets() {
    for (const socket of sockets) socket.destroy();
  }

  async function stop(reason = 'requested') {
    return queue(async () => {
      if (state === 'stopped') return snapshot();
      if (!server) {
        update('stopped', { port: null, urls: [], error: null });
        return snapshot();
      }
      const activeServer = server;
      update('stopping', { error: reason ? { code: 'STOPPING', message: String(reason) } : null });
      const closePromise = new Promise(resolve => activeServer.close(() => resolve(true)));
      if (typeof activeServer.closeIdleConnections === 'function') activeServer.closeIdleConnections();
      let timer;
      const graceful = await Promise.race([
        closePromise,
        new Promise(resolve => { timer = setTimeout(() => resolve(false), config.shutdownGraceMs); })
      ]);
      clearTimeout(timer);
      if (!graceful) {
        destroySockets();
        await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 250))]);
      }
      if (server === activeServer) server = null;
      token = null;
      primaryAddress = null;
      advertisedEntries = [];

      sockets.clear();
      update('stopped', { port: null, urls: [], error: null });
      return snapshot();
    });
  }

  function forceClose() {
    const activeServer = server;
    if (activeServer) {
      try { activeServer.close(); } catch (_) { /* 强制关闭时失败是正常的（可能已经关了） */ }
    }
    destroySockets();
    sockets.clear();
    server = null;
    token = null;
    state = 'stopped';
    port = null;
    urls = [];
    advertisedEntries = [];

    lastError = null;
    emitStatus();
    return snapshot();
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  return Object.freeze({ setRoot, getStatus: snapshot, start, stop, forceClose, onStatus });
}

module.exports = createWebFileServerController;
module.exports.createWebFileServerController = createWebFileServerController;
module.exports.helpers = Object.freeze({
  collectAddressEntries,
  collectInterfaceAddresses,
  decodeRelativePath,
  describeAddressKind,
  isAdvertisableAddress,
  isPortableFilename,
  normalizeHostHeader,
  portableFilenameError,
  resolveSafePath
});
module.exports.constants = Object.freeze({ DEFAULTS, ROUTES });