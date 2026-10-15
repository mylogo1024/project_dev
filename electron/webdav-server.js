'use strict';

/**
 * WebDAV 文件服务（主进程，纯 Node 内置模块，无第三方依赖）。
 *
 * 为什么要有它：局域网文件服务（web-file-server）只能用浏览器访问；
 * WebDAV 才能让手机/电脑把它当「网络磁盘/网盘」挂载 —— 文件 App、
 * Finder、Windows 资源管理器、RaiDrive、Infuse 都能直接读写。
 *
 * Public CommonJS API（与 web-file-server 同款生命周期）：
 *   createWebDavServerController(options) -> controller
 *   controller.setRoot(absolutePath)
 *   controller.setCredentials(username, password)   // 密码为空 = 不鉴权
 *   controller.getStatus()
 *   controller.start() / controller.stop(reason?) / controller.forceClose()
 *   controller.onStatus(listener) -> unsubscribe
 *
 * 安全策略（沿用 web-file-server 的经验）：
 * - Basic 鉴权 + timingSafeEqual，密码为空时任何请求都放行（局域网信任模式）
 * - 路径逐段校验 + realpath，拒绝符号链接与穿越
 * - 只监听本机网卡地址，不碰公网
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  uploadLimitBytes: 2 * 1024 * 1024 * 1024,
  shutdownGraceMs: 5_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  defaultPort: 18766,
  portRetries: 12,
  listingLimit: 10_000
});

const DAV_METHODS = [
  'OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH',
  'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'
];

/** 记录最近访问，用于「手机连不上」排查（与 web-file-server 一致）。 */
const RECENT_REQUEST_LIMIT = 20;

function makeError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function errorStatus(error) {
  if (Number.isInteger(error && error.statusCode)) return error.statusCode;
  if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 404;
  if (error && error.code === 'EEXIST') return 405;
  if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return 403;
  if (error && error.code === 'ENOSPC') return 507;
  return 500;
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * 解析 URL path 成段数组。拒绝穿越与反斜杠；不存在的叶子允许（PUT/MKCOL 需要）。
 * 入参是 URL pathname（一定以 / 开头），所以绝对性检查放在去头斜杠之后才有意义。
 */
function decodeSegments(rawPath) {
  if (typeof rawPath !== 'string') throw makeError(400, 'INVALID_PATH', 'Path must be a string');
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch (_) {
    throw makeError(400, 'INVALID_PATH', 'Path contains invalid encoding');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw makeError(400, 'INVALID_PATH', 'Invalid path');
  }
  const segments = decoded.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..')) {
    throw makeError(400, 'INVALID_PATH', 'Path traversal is not allowed');
  }
  return segments;
}

/**
 * 把段数组解析成 root 内的绝对路径，逐段校验符号链接。
 * options.allowMissingLeaf：PUT/MKCOL 目标可以不存在。
 */
async function resolveSafePath(root, segments, options = {}) {
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
    if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'Symbolic links are not allowed');
    if (!isLeaf && !stat.isDirectory()) throw makeError(409, 'CONFLICT', 'Path is not a directory');
    const real = await fsp.realpath(current);
    if (!pathInside(root, real)) throw makeError(403, 'LINK_REJECTED', 'Path leaves the selected root');
    current = real;
  }
  return current;
}

function isLocalAddress(address) {
  if (!address) return false;
  const normalized = String(address).replace(/^::ffff:/, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

/** 与 web-file-server 相同的地址收集/过滤规则（含 169.254 USB 直连保留）。 */
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

function formatUrlHost(address) {
  return net.isIP(address) === 6 ? `[${address}]` : address;
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

function describeAddressKind(address, interfaceName, interfaceLabels = {}) {
  const value = String(address || '');
  if (value.startsWith('169.254.')) return 'USB 直连 / 链路本地';
  const named = interfaceName ? interfaceLabels[interfaceName] : '';
  if (named) return named;
  if (net.isIP(value) === 6) return interfaceName ? `IPv6 · ${interfaceName}` : 'IPv6';
  return interfaceName ? `局域网 · ${interfaceName}` : '局域网';
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toIsoDate(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 单条 &lt;D:response&gt;（一个资源的属性）。isRoot 时是目录自身（href 不拼名字）。 */
function buildResponseXml(href, entry) {
  const size = entry.isDirectory || entry.size == null ? '' : `<D:getcontentlength>${entry.size}</D:getcontentlength>`;
  const resourceType = entry.isDirectory ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
  return `<D:response>
<D:href>${escapeXml(href)}</D:href>
<D:propstat>
<D:prop>
${resourceType}
${size}
<D:getlastmodified>${toIsoDate(entry.modifiedAt)}</D:getlastmodified>
<D:creationdate>${toIsoDate(entry.modifiedAt)}</D:creationdate>
<D:supportedlock>
<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>
</D:supportedlock>
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>`;
}

/**
 * 把解码后的段数组重建成规范 href：每段单独 encodeURIComponent。
 * 不能对 URL.pathname 的产物再 encodeURI —— pathname 本身就是百分号编码形态，
 * encodeURI 会把 % 再转成 %25（双重编码），而且不转义 # 和 ?
 * （含这些字符的文件名 href 会把 fragment/query 截断，客户端一访问就 404）。
 */
function segmentsToHref(segments) {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/** 子资源的 href：父段数组 + 名字（目录带尾斜杠）。 */
function childHref(parentSegments, entry) {
  return segmentsToHref([...parentSegments, entry.name]) + (entry.isDirectory ? '/' : '');
}

/** 目录自身的 href（保证尾斜杠，客户端靠它认 collection）。 */
function selfHref(segments) {
  const base = segmentsToHref(segments);
  return base === '/' ? base : `${base}/`;
}

/** PROPFIND 的 multistatus XML：responses 是拼接好的 &lt;D:response&gt; 字符串数组。 */
function buildMultistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join('\n')}
</D:multistatus>`;
}

async function readRequestBody(request, limitBytes) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > limitBytes) throw makeError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function drainRequest(request) {
  if (!request.destroyed && !request.readableEnded) request.resume();
}

/**
 * 解析 Destination 头（COPY/MOVE 用）。必须是本服务上的绝对路径。
 */
function parseDestination(headerValue, port) {
  if (typeof headerValue !== 'string' || !headerValue) {
    throw makeError(400, 'INVALID_DESTINATION', 'Destination header is required');
  }
  let parsed;
  try {
    parsed = new URL(headerValue);
  } catch (_) {
    throw makeError(400, 'INVALID_DESTINATION', 'Invalid Destination header');
  }
  // 挂载客户端写的 Destination 五花八门（可能带域名、可能带默认端口），
  // 只要端口对得上本服务就当作本服务路径处理；跨服务器 COPY/MOVE 不支持。
  const host = String(parsed.host || '').toLowerCase();
  const portMatch = /:(\d+)$/.exec(host);
  const hostPort = portMatch ? Number(portMatch[1]) : 80;
  const hostName = portMatch ? host.slice(0, -portMatch[0].length) : host;
  const isOwnHost = hostPort === port
    || (hostPort === 80 && !port)
    || isLocalAddress(hostName.replace(/^\[|\]$/g, ''));
  if (!isOwnHost) {
    throw makeError(502, 'BAD_DESTINATION', 'Cross-server copy is not supported');
  }
  return parsed.pathname;
}

function createWebDavServerController(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const config = {
    uploadLimitBytes: options.uploadLimitBytes ?? DEFAULTS.uploadLimitBytes,
    shutdownGraceMs: options.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    defaultPort: options.defaultPort ?? DEFAULTS.defaultPort,
    portRetries: options.portRetries ?? DEFAULTS.portRetries,
    listingLimit: options.listingLimit ?? DEFAULTS.listingLimit
  };

  const listeners = new Set();
  const sockets = new Set();
  const recentRequests = [];
  const activeLocks = new Map();

  let selectedRoot = null;
  let username = typeof options.username === 'string' ? options.username : '';
  let password = typeof options.password === 'string' ? options.password : '';
  let server = null;
  let state = 'stopped';
  let port = null;
  let primaryAddress = null;
  let urls = [];
  let advertisedEntries = [];
  let interfaceLabels = {};
  let lastError = null;
  let lastChangeNotice = null;
  let transition = Promise.resolve();

  function snapshot() {
    return {
      state,
      selectedRoot,
      rootPath: selectedRoot,
      port,
      primaryAddress,
      urls: [...urls],
      username,
      authRequired: Boolean(password),
      // 密码本身绝不跨进程回传；UI 靠这个标志显示「已设密码」并拦截误清空
      hasPassword: Boolean(password),
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
      try { listener(status); } catch (_) { /* 单个订阅者抛错不影响其它订阅者 */ }
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
    const rawHost = request.headers.host;
    if (typeof rawHost !== 'string' || !rawHost || rawHost.includes(',')) {
      throw makeError(400, 'INVALID_HOST', 'Invalid Host header');
    }
    // 挂载客户端（Finder/Windows）发的 Host 千奇百怪，只做最低限度校验：端口对得上
    const portMatch = /:(\d+)$/.exec(rawHost);
    const hostPort = portMatch ? Number(portMatch[1]) : 80;
    if (port && hostPort !== port && hostPort !== 80) {
      throw makeError(400, 'INVALID_HOST', 'Host header does not match the connected server');
    }
    return rawHost;
  }

  /**
   * Basic 鉴权。密码为空 = 局域网信任模式，直接放行。
   * 账号由 UI 层通过 setCredentials 决定（固定或自定义）。
   */
  function authorize(request) {
    if (!password) return true;
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Basic ')) {
      throw makeError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    let decoded;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch (_) {
      throw makeError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }
    const separator = decoded.indexOf(':');
    if (separator < 0) throw makeError(401, 'UNAUTHORIZED', 'Invalid credentials');
    const providedUser = decoded.slice(0, separator);
    const providedPass = decoded.slice(separator + 1);
    if (!safeEqual(providedUser, username) || !safeEqual(providedPass, password)) {
      throw makeError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }
    return true;
  }

  function writeXml(response, statusCode, body) {
    const payload = Buffer.from(body);
    response.writeHead(statusCode, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store'
    });
    response.end(payload);
  }

  function writeText(response, statusCode, message) {
    const payload = Buffer.from(message || '');
    response.writeHead(statusCode, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store'
    });
    response.end(payload);
  }

  function writeErrorResponse(request, response, error) {
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    const statusCode = errorStatus(error);
    const headers = {};
    if (statusCode === 401) {
      headers['WWW-Authenticate'] = 'Basic realm="WebDAV", charset="UTF-8"';
    }
    if (error.precondition) {
      // RFC 6578 风格的 precondition 头（如 propfind-finite-depth），客户端靠它降级
      headers.Precondition = error.precondition;
    }
    const payload = Buffer.from(error.code === 'UNAUTHORIZED'
      ? '401 Unauthorized'
      : `${statusCode} ${error.message || 'Error'}`);
    response.writeHead(statusCode, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      ...headers
    });
    response.end(payload);
    drainRequest(request);
  }

  async function statEntry(absolutePath, name) {
    let stat;
    try {
      stat = await fsp.lstat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return null;
    if (!stat.isDirectory() && !stat.isFile()) return null;
    return {
      name,
      isDirectory: stat.isDirectory(),
      size: stat.isDirectory() ? null : stat.size,
      modifiedAt: stat.mtimeMs
    };
  }

  async function listDirectory(directory, listingLimit = 10_000) {
    const handle = await fsp.opendir(directory);
    const entries = [];
    try {
      for await (const entry of handle) {
        if (entries.length >= listingLimit) {
          throw makeError(413, 'LISTING_LIMIT', `Directory contains more than ${listingLimit} entries`);
        }
        const item = await statEntry(path.join(directory, entry.name), entry.name);
        if (item) entries.push(item);
      }
    } finally {
      try { await handle.close(); } catch (error) { if (error.code !== 'ERR_DIR_CLOSED') throw error; }
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    return entries;
  }

  async function handlePropfind(request, response, segments) {
    if (request.method !== 'PROPFIND') return false;
    const depthHeader = String(request.headers.depth || 'infinity');
    if (!['0', '1', 'infinity'].includes(depthHeader)) {
      throw makeError(400, 'INVALID_DEPTH', 'Invalid Depth header');
    }
    // RFC 4918 §9.1：服务端可以拒绝 Depth: infinity，但必须声明 propfind-finite-depth
    // precondition，让客户端知道改用逐层 PROPFIND。静默降级成 1 会让客户端
    // 误以为拿到了完整树（rsync 类工具会漏文件）。
    if (depthHeader === 'infinity') {
      const error = makeError(403, 'PROPFIND_FINITE_DEPTH', 'Depth: infinity is not supported; request Depth 0 or 1');
      error.precondition = 'propfind-finite-depth';
      throw error;
    }
    const depth = Number(depthHeader);
    // 吸掉请求体（allprop/propname 都按 allprop 处理）
    await readRequestBody(request, 64 * 1024);
    const target = await resolveSafePath(selectedRoot, segments);
    const stat = await fsp.lstat(target);
    const selfEntry = { isDirectory: stat.isDirectory(), size: stat.isDirectory() ? null : stat.size, modifiedAt: stat.mtimeMs };
    if (stat.isFile()) {
      // 文件的 href 不能带尾斜杠（带斜杠客户端会当成 collection）
      writeXml(response, 207, buildMultistatus([buildResponseXml(segmentsToHref(segments), selfEntry)]));
      return true;
    }
    if (depth === 0) {
      writeXml(response, 207, buildMultistatus([buildResponseXml(selfHref(segments), selfEntry)]));
      return true;
    }
    const entries = await listDirectory(target, config.listingLimit);
    // 首条是目录自身（Finder/资源管理器都靠尾斜杠 + collection 识别目录）
    const responses = [
      buildResponseXml(selfHref(segments), selfEntry),
      ...entries.map((entry) => buildResponseXml(childHref(segments, entry), entry))
    ];
    writeXml(response, 207, buildMultistatus(responses));
    return true;
  }

  async function handleOptions(request, response) {
    response.writeHead(200, {
      Allow: DAV_METHODS.join(', '),
      'MS-Author-Via': 'DAV',
      // 告诉客户端：PROPFIND 不支持 Depth: infinity，请逐层请求
      DAV: '1, 2; propfind-finite-depth',
      'Content-Length': 0
    });
    response.end();
    return true;
  }

  async function handleGetHead(request, response, segments) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const filePath = await resolveSafePath(selectedRoot, segments);
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile()) throw makeError(409, 'CONFLICT', 'Requested resource is a collection');
    const filename = path.basename(filePath);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none'
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return true;
    }
    response.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      if (!response.headersSent) writeErrorResponse(request, response, error);
      else response.destroy(error);
    });
    request.on('aborted', () => stream.destroy());
    stream.pipe(response);
    return true;
  }

  async function handlePut(request, response, segments, parsedUrl) {
    if (request.method !== 'PUT') return false;
    if (segments.length === 0) throw makeError(405, 'METHOD_NOT_ALLOWED', 'Cannot PUT the collection root');
    const filePath = await resolveSafePath(selectedRoot, segments, { allowMissingLeaf: true });
    const parentDir = path.dirname(filePath);
    // 父目录必须存在（WebDAV 不自动建中间目录）
    try {
      const parentStat = await fsp.lstat(parentDir);
      if (!parentStat.isDirectory()) throw makeError(409, 'CONFLICT', 'Parent is not a directory');
    } catch (error) {
      if (error.code === 'ENOENT') throw makeError(409, 'CONFLICT', 'Parent directory does not exist');
      throw error;
    }
    const rawLength = request.headers['content-length'];
    const length = typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    if (length !== null && length > config.uploadLimitBytes) {
      throw makeError(413, 'UPLOAD_TOO_LARGE', `Upload exceeds ${config.uploadLimitBytes} bytes`);
    }
    const existed = await fsp.lstat(filePath).then(() => true).catch(() => false);
    // 先写临时文件再原子替换：上传中途断掉不会留下半截原文件（大文件保护）
    const temporaryPath = `${filePath}.dav-upload-${process.pid}-${Date.now()}`;
    let handle;
    let received = 0;
    try {
      handle = await fsp.open(temporaryPath, 'wx');
      for await (const chunk of request) {
        received += chunk.length;
        if (received > config.uploadLimitBytes) {
          throw makeError(413, 'UPLOAD_TOO_LARGE', 'Upload exceeded the configured size');
        }
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset, null);
          offset += result.bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporaryPath, filePath);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch (_) { /* 关闭失败不影响后续清理 */ }
      }
      try { await fsp.unlink(temporaryPath); } catch (_) { /* 临时文件可能没建出来 */ }
      throw error;
    }
    response.writeHead(existed ? 204 : 201, { 'Content-Length': 0 });
    response.end();
    return true;
  }

  async function handleMkcol(request, response, segments) {
    if (request.method !== 'MKCOL') return false;
    if (segments.length === 0) throw makeError(405, 'METHOD_NOT_ALLOWED', 'Collection already exists');
    // 带 body 的 MKCOL：先报告 415，body 再丢弃（readRequestBody(limit=0) 会抛 413，顺序不对）
    const body = await readRequestBody(request, 1024 * 1024);
    if (body.length > 0) throw makeError(415, 'UNSUPPORTED_MEDIA_TYPE', 'MKCOL with a request body is not supported');
    let target;
    try {
      target = await resolveSafePath(selectedRoot, segments, { allowMissingLeaf: true });
    } catch (error) {
      // RFC 4918 §10.3：父集合不存在时 MKCOL 必须回 409，而不是 404
      if (error.code === 'NOT_FOUND') throw makeError(409, 'CONFLICT', 'Parent directory does not exist');
      throw error;
    }
    try {
      await fsp.mkdir(target);
    } catch (error) {
      if (error.code === 'EEXIST') throw makeError(405, 'METHOD_NOT_ALLOWED', 'Resource already exists');
      if (error.code === 'ENOENT') throw makeError(409, 'CONFLICT', 'Parent directory does not exist');
      throw error;
    }
    response.writeHead(201, { 'Content-Length': 0 });
    response.end();
    return true;
  }

  async function handleDelete(request, response, segments) {
    if (request.method !== 'DELETE') return false;
    if (segments.length === 0) throw makeError(403, 'FORBIDDEN', 'Cannot delete the collection root');
    const target = await resolveSafePath(selectedRoot, segments);
    const stat = await fsp.lstat(target);
    if (stat.isDirectory()) {
      await fsp.rm(target, { recursive: true });
    } else {
      await fsp.unlink(target);
    }
    response.writeHead(204, { 'Content-Length': 0 });
    response.end();
    return true;
  }

  async function handleCopyMove(request, response, segments) {
    if (request.method !== 'COPY' && request.method !== 'MOVE') return false;
    const destinationPath = parseDestination(request.headers.destination, port);
    const destinationSegments = decodeSegments(destinationPath);
    if (destinationSegments.length === 0) throw makeError(403, 'FORBIDDEN', 'Cannot overwrite the collection root');
    const source = await resolveSafePath(selectedRoot, segments);
    const destination = await resolveSafePath(selectedRoot, destinationSegments, { allowMissingLeaf: true });
    if (source === destination) throw makeError(403, 'FORBIDDEN', 'Source and destination are the same');
    if (!pathInside(selectedRoot, destination)) throw makeError(400, 'INVALID_PATH', 'Path traversal is not allowed');
    // RFC 4918 §9.8.4：目标不能位于源的子树内（含目标就是源的子目录），
    // 否则 COPY 会无限递归、MOVE 会把祖先搬进自己的后代
    const sourceStat = await fsp.lstat(source);
    if (sourceStat.isDirectory() && destination !== source && pathInside(source, destination)) {
      throw makeError(409, 'CONFLICT', 'Destination is inside the source collection');
    }
    const overwriteHeader = String(request.headers.overwrite || 'T').toUpperCase() !== 'F';
    const existed = await fsp.lstat(destination).then(() => true).catch(() => false);
    if (existed && !overwriteHeader) throw makeError(412, 'PRECONDITION_FAILED', 'Destination exists and Overwrite is F');

    if (request.method === 'COPY') {
      await fsp.cp(source, destination, { recursive: true, force: overwriteHeader, errorOnExist: !overwriteHeader });
    } else {
      try {
        await fsp.rename(source, destination);
      } catch (error) {
        if (error.code !== 'EXDEV') {
          if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
            // 目标存在且允许覆盖：先删再移（rename 在部分平台不肯覆盖非空目录）
            if (overwriteHeader) {
              await fsp.rm(destination, { recursive: true, force: true });
              await fsp.rename(source, destination);
            } else {
              throw makeError(412, 'PRECONDITION_FAILED', 'Destination exists');
            }
          } else {
            throw error;
          }
        } else {
          // 跨设备（root 是挂载点时可能）：退化为 cp + rm
          await fsp.cp(source, destination, { recursive: true, force: overwriteHeader });
          await fsp.rm(source, { recursive: true, force: true });
        }
      }
    }
    response.writeHead(existed ? 204 : 201, { 'Content-Length': 0 });
    response.end();
    return true;
  }

  /**
   * LOCK/UNLOCK：很多挂载客户端（Finder、Windows 资源管理器）写文件前会先 LOCK，
   * 不支持就报「锁定失败」拒写。这里实现最小假锁：发 token、记住、校验、过期清理。
   */
  async function handleLockUnlock(request, response, segments, parsedUrl) {
    if (request.method !== 'LOCK' && request.method !== 'UNLOCK') return false;
    const resourceKey = path.posix.join('/', segments.join('/'));
    if (request.method === 'UNLOCK') {
      const tokenHeader = String(request.headers['lock-token'] || '');
      const token = tokenHeader.trim().replace(/^<|>$/g, '');
      const lock = activeLocks.get(resourceKey);
      if (!lock || !safeEqual(lock.token, token)) {
        throw makeError(409, 'LOCK_CONFLICT', 'No matching lock on this resource');
      }
      activeLocks.delete(resourceKey);
      response.writeHead(204, { 'Content-Length': 0 });
      response.end();
      return true;
    }
    // LOCK
    const body = await readRequestBody(request, 64 * 1024);
    const timeoutHeader = String(request.headers.timeout || 'Second-600');
    const seconds = Number(/(\d+)/.exec(timeoutHeader)?.[1] || 600);
    const now = Date.now();
    // 刷新已有锁（If 头带 token）
    const ifHeader = String(request.headers.if || '');
    const existing = activeLocks.get(resourceKey);
    if (existing && ifHeader.includes(existing.token)) {
      existing.expiresAt = now + Math.min(seconds, 3600) * 1000;
      writeLockResponse(response, existing, parsedUrl.pathname);
      return true;
    }
    if (existing && existing.expiresAt > now) {
      // 资源已被别的锁占着 —— 按规范返回锁冲突
      const conflictXml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
<D:lockdiscovery>
${lockDiscoveryXml(existing)}
</D:lockdiscovery>
</D:prop>`;
      writeXml(response, 423, conflictXml);
      return true;
    }
    const lock = {
      token: `opaquelocktoken:${crypto.randomUUID()}`,
      owner: extractLockOwner(body),
      createdAt: now,
      expiresAt: now + Math.min(Math.max(seconds, 60), 3600) * 1000
    };
    activeLocks.set(resourceKey, lock);
    // 顺手清理过期锁
    for (const [key, value] of activeLocks) {
      if (value.expiresAt <= now) activeLocks.delete(key);
    }
    writeLockResponse(response, lock, parsedUrl.pathname);
    return true;
  }

  /**
   * 从 LOCK 请求体里提取 owner（规范允许纯文本或内嵌 XML，常见是 <D:href>）。
   * 提不出来时退回通用占位，保证任何客户端都能拿到锁。
   */
  function extractLockOwner(bodyBuffer) {
    if (!bodyBuffer || !bodyBuffer.length) return 'dav-client';
    const raw = String(bodyBuffer).slice(0, 1024);
    const match = /<(?:[\w-]+:)?owner[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?owner\s*>/i.exec(raw);
    const content = match ? match[1] : raw;
    const text = content.replace(/<[^>]*>/g, '').trim();
    return (text || 'dav-client').slice(0, 256);
  }

  function lockDiscoveryXml(lock) {
    return `<D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>0</D:depth>
<D:owner>${escapeXml(lock.owner)}</D:owner>
<D:timeout>Second-${Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 1000))}</D:timeout>
<D:locktoken><D:href>${escapeXml(lock.token)}</D:href></D:locktoken>
</D:activelock>`;
  }

  function writeLockResponse(response, lock, resourcePath) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
<D:lockdiscovery>
${lockDiscoveryXml(lock)}
</D:lockdiscovery>
</D:prop>`;
    response.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml),
      'Lock-Token': `<${lock.token}>`
    });
    response.end(xml);
  }

  async function handleProppatch(request, response, segments) {
    if (request.method !== 'PROPPATCH') return false;
    // 只支持只读属性：吸掉请求体，全部回「失败但继续」的 207 —— 客户端不当它是致命错误
    await readRequestBody(request, 64 * 1024);
    await resolveSafePath(selectedRoot, segments);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response>
<D:href>${escapeXml(segmentsToHref(segments))}</D:href>
<D:propstat>
<D:prop/>
<D:status>HTTP/1.1 403 Forbidden</D:status>
</D:propstat>
</D:response>
</D:multistatus>`;
    writeXml(response, 207, xml);
    return true;
  }

  async function handleRequest(request, response) {
    // finish 可能在连接已销毁后触发，remoteAddress 要提前取
    const clientIp = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
    response.setHeader('Connection', state === 'stopping' ? 'close' : 'keep-alive');
    response.on('finish', () => {
      recentRequests.unshift({
        at: Date.now(),
        ip: clientIp,
        method: request.method,
        path: String(request.url || '').split('?')[0],
        status: response.statusCode
      });
      if (recentRequests.length > RECENT_REQUEST_LIMIT) recentRequests.length = RECENT_REQUEST_LIMIT;
    });

    const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const segments = decodeSegments(parsedUrl.pathname);

    if (!DAV_METHODS.includes(request.method) && request.method !== 'OPTIONS') {
      throw makeError(405, 'METHOD_NOT_ALLOWED', `Method ${request.method} is not supported`);
    }

    // OPTIONS 不需要 root/鉴权（挂载客户端探测能力时最先发这个）
    if (request.method === 'OPTIONS') return handleOptions(request, response);

    verifyHost(request);
    authorize(request);

    if (!selectedRoot) throw makeError(409, 'ROOT_REQUIRED', 'No root directory is selected');

    if (await handlePropfind(request, response, segments)) return;
    if (await handleGetHead(request, response, segments)) return;
    if (await handlePut(request, response, segments, parsedUrl)) return;
    if (await handleMkcol(request, response, segments)) return;
    if (await handleDelete(request, response, segments)) return;
    if (await handleCopyMove(request, response, segments)) return;
    if (await handleLockUnlock(request, response, segments, parsedUrl)) return;
    if (await handleProppatch(request, response, segments)) return;
    throw makeError(405, 'METHOD_NOT_ALLOWED', `Method ${request.method} is not handled`);
  }

  async function setRoot(nextRoot) {
    return queue(async () => {
      if (state !== 'stopped') throw new Error('Stop the WebDAV server before changing its root');
      if (typeof nextRoot !== 'string' || !path.isAbsolute(nextRoot)) {
        throw new TypeError('Root must be an absolute directory path');
      }
      const stat = await fsp.lstat(nextRoot);
      if (stat.isSymbolicLink()) throw makeError(403, 'LINK_REJECTED', 'The selected root cannot be a symbolic link');
      if (!stat.isDirectory()) throw new TypeError('Root must be a directory');
      const canonical = await fsp.realpath(nextRoot);
      selectedRoot = canonical;
      lastError = null;
      emitStatus();
      return snapshot();
    });
  }

  /** 设置账号密码。账号默认 admin（UI 层固定账号模式）；密码清空 = 关闭鉴权（局域网信任模式）。 */
  async function setCredentials(nextUsername, nextPassword) {
    return queue(async () => {
      if (state !== 'stopped') throw new Error('Stop the WebDAV server before changing credentials');
      username = typeof nextUsername === 'string' && nextUsername.trim() ? nextUsername.trim() : 'admin';
      password = typeof nextPassword === 'string' ? nextPassword : '';
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
      update('starting', { port: null, urls: [], error: null });
      lastChangeNotice = null;
      primaryAddress = null;

      const candidate = http.createServer((request, response) => {
        Promise.resolve(handleRequest(request, response)).catch((error) => {
          drainRequest(request);
          writeErrorResponse(request, response, error);
        });
      });
      server = candidate;
      candidate.requestTimeout = config.requestTimeoutMs;
      candidate.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
      candidate.keepAliveTimeout = 5_000;
      candidate.maxHeadersCount = 64;
      candidate.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      candidate.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      });

      try {
        const ports = [];
        const add = (value) => {
          if (Number.isInteger(value) && value > 0 && value <= 65535 && !ports.includes(value)) ports.push(value);
        };
        add(preferredPort);
        add(config.defaultPort);
        for (let offset = 1; offset <= config.portRetries; offset += 1) add(config.defaultPort + offset);

        let addressInfo = null;
        let lastBindError = null;
        for (const portCandidate of ports) {
          try {
            addressInfo = await listenAsync(candidate, { host: '0.0.0.0', port: portCandidate, exclusive: true });
            break;
          } catch (error) {
            lastBindError = error;
            if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
          }
        }
        if (!addressInfo) {
          try {
            addressInfo = await listenAsync(candidate, { host: '0.0.0.0', port: 0, exclusive: true });
          } catch (error) {
            throw lastBindError || error;
          }
        }

        port = addressInfo.port;
        const rawEntries = options.getNetworkAddresses
          ? options.getNetworkAddresses().map((address) => ({ address, interface: null }))
          : collectAddressEntries();
        const advertisable = rawEntries.filter((entry) => isAdvertisableAddress(entry.address));
        const entries = advertisable.length ? advertisable : rawEntries;
        advertisedEntries = entries;
        interfaceLabels = options.getInterfaceLabels ? (options.getInterfaceLabels() || {}) : {};
        const addresses = entries.map((entry) => entry.address);
        primaryAddress = pickPrimaryAddress(addresses, preferredAddress);
        const orderedAddresses = primaryAddress
          ? [primaryAddress, ...addresses.filter((item) => item !== primaryAddress)]
          : addresses;
        // Finder/Windows 资源管理器挂载用 http://；dav:// 只有部分客户端认
        urls = orderedAddresses.map((address) => `http://${formatUrlHost(address)}:${port}/`);
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
          ].join('，') + '。请使用当前页面显示的新地址。'
        } : null;
        update('running', { port, urls, error: null });
        return snapshot();
      } catch (error) {
        try { candidate.close(); } catch (_) { /* 端口占用时关掉候选，继续试下一个 */ }
        server = null;
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
      const closePromise = new Promise((resolve) => activeServer.close(() => resolve(true)));
      if (typeof activeServer.closeIdleConnections === 'function') activeServer.closeIdleConnections();
      let timer;
      const graceful = await Promise.race([
        closePromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), config.shutdownGraceMs); })
      ]);
      clearTimeout(timer);
      if (!graceful) {
        destroySockets();
        await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 250))]);
      }
      if (server === activeServer) server = null;
      primaryAddress = null;
      advertisedEntries = [];
      activeLocks.clear();
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
    activeLocks.clear();
    server = null;
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

  return Object.freeze({
    setRoot,
    setCredentials,
    getStatus: snapshot,
    start,
    stop,
    forceClose,
    onStatus
  });
}

module.exports = createWebDavServerController;
module.exports.createWebDavServerController = createWebDavServerController;
module.exports.helpers = Object.freeze({
  collectAddressEntries,
  decodeSegments,
  describeAddressKind,
  isAdvertisableAddress,
  parseDestination
});
module.exports.constants = Object.freeze({ DEFAULTS, DAV_METHODS });
