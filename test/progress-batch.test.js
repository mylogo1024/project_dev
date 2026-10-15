'use strict';

/**
 * 进度上报 / 跨平台 ZIP 解压 / 批量扫描 / 平台能力矩阵 的单元测试。
 *
 * 与 package-static-info.test.js 保持同样的风格：不依赖外部工具，
 * 用最小的合成数据把边界条件钉死。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const util = require('../electron/pkginfo/util');
const { openZip, safeJoin, unixModeFromEntry } = require('../electron/pkginfo/zip');
const { parsePackageStaticInfo } = require('../electron/pkginfo');
const batch = require('../electron/pkginfo/batch');
const { createPlatformCapabilities, FEATURE_CATALOG } = require('../electron/platform-capabilities');

// ==================== 测试用最小 ZIP 构造器 ====================

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 构造 STORED ZIP。
 * @param {Array<{name: string, data?: Buffer|string, unixMode?: number, encrypted?: boolean}>} files
 */
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8');
    const crc = crc32(data);
    const flags = file.encrypted ? 0x0001 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // versionMadeBy：高字节 3 = Unix，这样 externalAttrs 里的权限位才有效
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    if (file.unixMode) {
      central.writeUInt32LE((file.unixMode & 0xffff) << 16, 38);
    }
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

const tempDirs = [];

function tempDir(prefix = 'pkgtest-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempZip(name, buffer) {
  const dir = tempDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }
});

// ==================== 1. 进度上报 ====================

test('progress: makeProgressReporter 归一化 percent 并补全字段', () => {
  const seen = [];
  const report = util.makeProgressReporter((info) => seen.push(info));

  report(0, '开始');
  report(50.4, '中途', 'detail-x');
  report(150, '越界');
  report(-20, '负数');
  report(99);

  assert.equal(seen.length, 5);
  assert.deepEqual(seen[0], { percent: 0, stage: '开始', detail: '' });
  assert.equal(seen[1].percent, 50, '小数应四舍五入');
  assert.equal(seen[1].detail, 'detail-x');
  assert.equal(seen[2].percent, 100, '超过 100 应被夹紧');
  assert.equal(seen[3].percent, 0, '小于 0 应被夹紧');
  assert.equal(seen[4].stage, '');
  assert.equal(seen[4].detail, '');
});

test('progress: 回调抛异常不会中断主流程（回归）', () => {
  const report = util.makeProgressReporter(() => { throw new Error('回调炸了'); });
  assert.doesNotThrow(() => report(10, '阶段'));
});

test('progress: 未传 onProgress 时是安全的空操作', () => {
  const report = util.makeProgressReporter(undefined);
  assert.doesNotThrow(() => report(10, '阶段'));
});

test('progress: parsePackageStaticInfo 逐阶段上报且单调不减、以 100 收尾', () => {
  // 只有 AndroidManifest.xml 的畸形包：Manifest 解析会失败并写入 warnings，
  // 但整条进度链路必须完整走完 —— 这正是「坏包也不能卡住进度条」的保障。
  const zipBuffer = makeZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('not-a-real-binary-xml') },
    { name: 'resources.arsc', data: Buffer.from('nope') }
  ]);
  const file = writeTempZip('broken.apk', zipBuffer);

  const stages = [];
  const result = parsePackageStaticInfo(file, {
    onProgress: (info) => stages.push(info)
  });

  assert.ok(stages.length >= 8, `进度阶段过少: ${stages.length}`);
  assert.equal(stages[0].percent, 0, '第一条应为 0%');
  assert.equal(stages[stages.length - 1].percent, 100, '最后一条应为 100%');

  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(
      stages[i].percent >= stages[i - 1].percent,
      `进度回退: ${stages[i - 1].percent} → ${stages[i].percent}`
    );
  }

  for (const stage of stages) {
    assert.equal(typeof stage.stage, 'string');
    assert.ok(stage.stage.length > 0, '每个阶段都要有文案');
  }

  assert.ok(result.basic, '即使 Manifest 解析失败也要返回 basic');
  assert.ok(result.warnings.length > 0, '解析失败应记录 warning');
});

test('progress: 真实包解析结果与不带进度时完全一致（回归）', { skip: !findRealPackage() && '未找到测试包体' }, () => {
  const file = findRealPackage();
  const plain = parsePackageStaticInfo(file);
  const withProgress = parsePackageStaticInfo(file, { onProgress: () => {} });

  assert.equal(withProgress.basic.app.identifier, plain.basic.app.identifier);
  assert.equal(withProgress.basic.risk.score, plain.basic.risk.score);
  assert.equal(withProgress.basic.file.sha256, plain.basic.file.sha256);
});

// ==================== 2. 纯 JS ZIP 解压 ====================

test('zip: extractTo 解压文件、建目录并返回统计', () => {
  const zipBuffer = makeZip([
    { name: 'a.txt', data: 'hello' },
    { name: 'nested/b.txt', data: 'world' },
    { name: 'nested/deep/c.bin', data: Buffer.from([1, 2, 3, 4]) }
  ]);
  const file = writeTempZip('extract.zip', zipBuffer);
  const out = tempDir('extract-out-');

  const archive = openZip(file);
  const progress = [];
  const result = archive.extractTo(out, { onProgress: (info) => progress.push(info) });
  archive.close();

  assert.equal(result.files, 3);
  assert.equal(result.skipped, 0);
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(out, 'nested/b.txt'), 'utf8'), 'world');
  assert.deepEqual([...fs.readFileSync(path.join(out, 'nested/deep/c.bin'))], [1, 2, 3, 4]);

  assert.equal(progress.length, 3);
  assert.equal(progress[progress.length - 1].percent, 100);
  assert.ok(progress.every((item) => item.total === 3));
});

test('zip: extractTo 的 filter 只解压匹配条目', () => {
  const zipBuffer = makeZip([
    { name: 'Payload/App.app/Info.plist', data: 'plist' },
    { name: 'Payload/App.app/App', data: 'binary' },
    { name: 'SwiftSupport/lib.swift', data: 'swift' }
  ]);
  const file = writeTempZip('filter.zip', zipBuffer);
  const out = tempDir('filter-out-');

  const archive = openZip(file);
  const result = archive.extractTo(out, {
    filter: (entry) => entry.name.startsWith('Payload/')
  });
  archive.close();

  assert.equal(result.files, 2);
  assert.ok(fs.existsSync(path.join(out, 'Payload/App.app/Info.plist')));
  assert.ok(!fs.existsSync(path.join(out, 'SwiftSupport/lib.swift')), '未匹配的条目不应被写出');
});

test('zip: extractTo 阻止 zip-slip 目录穿越（回归）', () => {
  const zipBuffer = makeZip([
    { name: 'ok.txt', data: 'fine' },
    { name: '../../escaped.txt', data: 'pwned' }
  ]);
  const file = writeTempZip('slip.zip', zipBuffer);
  const out = tempDir('slip-out-');

  const archive = openZip(file);
  assert.throws(
    () => archive.extractTo(out),
    /路径越界/,
    '穿越路径必须被拦截'
  );
  archive.close();

  const escaped = path.resolve(out, '../../escaped.txt');
  assert.ok(!fs.existsSync(escaped), '越界文件不应被写到目标目录之外');
});

test('zip: safeJoin 允许正常子路径，拒绝越界路径', () => {
  const root = tempDir('safejoin-');
  assert.equal(safeJoin(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  assert.equal(safeJoin(root, 'a\\b\\c.txt'), path.join(root, 'a', 'b', 'c.txt'), '反斜杠应被归一化');
  assert.throws(() => safeJoin(root, '../x.txt'), /路径越界/);
  assert.throws(() => safeJoin(root, 'a/../../x.txt'), /路径越界/);
});

test('zip: extractTo 还原 Unix 可执行位', { skip: process.platform === 'win32' && 'Windows 无 Unix 权限位' }, () => {
  const zipBuffer = makeZip([
    { name: 'Payload/App.app/App', data: 'macho-binary', unixMode: 0o755 },
    { name: 'Payload/App.app/readme.txt', data: 'text', unixMode: 0o644 }
  ]);
  const file = writeTempZip('mode.zip', zipBuffer);
  const out = tempDir('mode-out-');

  const archive = openZip(file);
  archive.extractTo(out);
  archive.close();

  const binaryMode = fs.statSync(path.join(out, 'Payload/App.app/App')).mode & 0o777;
  const textMode = fs.statSync(path.join(out, 'Payload/App.app/readme.txt')).mode & 0o777;
  assert.equal(binaryMode, 0o755, '可执行位必须保留，否则 iOS 主二进制无法运行');
  assert.equal(textMode, 0o644);
});

test('zip: unixModeFromEntry 只对 Unix 打包来源生效', () => {
  const archive = openZip(writeTempZip('mode2.zip', makeZip([
    { name: 'x', data: 'y', unixMode: 0o755 }
  ])));
  const entry = archive.entries.find((item) => item.name === 'x');
  assert.equal(unixModeFromEntry(entry), 0o755);
  archive.close();

  const windowsZip = openZip(writeTempZip('mode3.zip', makeZip([{ name: 'x', data: 'y' }])));
  const plainEntry = windowsZip.entries.find((item) => item.name === 'x');
  assert.equal(unixModeFromEntry(plainEntry), null, '没有权限位时应返回 null');
  windowsZip.close();
});

test('zip: extractTo 跳过加密条目而不是抛错', () => {
  const zipBuffer = makeZip([
    { name: 'plain.txt', data: 'ok' },
    { name: 'locked.txt', data: 'secret', encrypted: true }
  ]);
  const file = writeTempZip('enc.zip', zipBuffer);
  const out = tempDir('enc-out-');

  const archive = openZip(file);
  const result = archive.extractTo(out);
  archive.close();

  assert.equal(result.files, 2);
  assert.equal(result.skipped, 1, '加密条目应被计入 skipped');
  assert.ok(fs.existsSync(path.join(out, 'plain.txt')));
  assert.ok(!fs.existsSync(path.join(out, 'locked.txt')));
});

// ==================== 3. 批量扫描 ====================

test('batch: collectPackages 只收 APK/AAB/IPA，可切换是否递归', () => {
  const root = tempDir('batch-collect-');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.apk'), 'x');
  fs.writeFileSync(path.join(root, 'b.ipa'), 'x');
  fs.writeFileSync(path.join(root, 'c.txt'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'd.aab'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'e.apk'), 'x');

  const shallow = batch.collectPackages(root, { recursive: false });
  assert.deepEqual(shallow.map((item) => item.name), ['a.apk', 'b.ipa']);

  const deep = batch.collectPackages(root, { recursive: true });
  assert.deepEqual(deep.map((item) => item.name).sort(), ['a.apk', 'b.ipa', 'd.aab', 'e.apk']);
  assert.equal(deep.find((item) => item.name === 'd.aab').type, 'AAB');
});

test('batch: collectPackages 遵守 limit', () => {
  const root = tempDir('batch-limit-');
  for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(root, `p${i}.apk`), 'x');
  assert.equal(batch.collectPackages(root, { limit: 5 }).length, 5);
});

test('batch: summarizePackage 从解析结果压出表格行', () => {
  const info = {
    file_path: '/tmp/demo.apk',
    elapsed_ms: 123,
    warnings: ['w1'],
    basic: {
      file: { name: 'demo.apk', type: 'APK', size: 2048, size_human: '2.00 KB' },
      app: { name: '演示', identifier: 'com.demo', version_name: '1.2.3', version_code: 7, min_os: 'Android 8.0', target_os: 'API 34', abis: ['arm64-v8a'] },
      signature: { signed: true, type: 'v2', sha256: 'abc', debug: false, expired: false },
      structure: { dex_count: 2, so_count: 1, permission_count: 9, dangerous_permission_count: 3, component_count: 5, exported_component_count: 2, packed: true, packed_by: '某加固', obfuscated: true },
      risk: { score: 71, level: 'high', level_label: '高风险', critical: 0, high: 2, medium: 1, low: 0 }
    },
    detailed: {
      '2.14': { sdks: [{ sdk_name: 'Adjust' }, { sdk_name: 'OkHttp' }] },
      '2.11': { abis: ['arm64-v8a'] },
      '2.6': { requested: ['A', 'B'] }
    }
  };

  const row = batch.summarizePackage(info);
  assert.equal(row.name, 'demo.apk');
  assert.equal(row.app_name, '演示');
  assert.equal(row.identifier, 'com.demo');
  assert.equal(row.version_name, '1.2.3');
  assert.equal(row.abis, 'arm64-v8a');
  assert.equal(row.sdk_count, 2);
  assert.equal(row.sdk_names, 'Adjust / OkHttp');
  assert.equal(row.packed_by, '某加固');
  assert.equal(row.risk_score, 71);
  assert.equal(row.risk_label, '高风险');
  assert.equal(row.warning_count, 1);
  assert.equal(row.error, '');
});

test('batch: failureRow 保留失败原因，便于在表格里定位', () => {
  const row = batch.failureRow({ name: 'bad.apk', path: '/tmp/bad.apk', type: 'APK', size: 10 }, new Error('签名解析炸了'));
  assert.equal(row.name, 'bad.apk');
  assert.match(row.error, /签名解析炸了/);
  assert.equal(row.risk_score, 0);
});

test('batch: toCsv 带 BOM 并正确转义逗号/引号/换行', () => {
  const csv = batch.toCsv([{ name: 'a,b', app_name: '带"引号"', identifier: 'x\ny' }], [
    { key: 'name', title: '文件名' },
    { key: 'app_name', title: '应用名' },
    { key: 'identifier', title: '包名' }
  ]);

  assert.ok(csv.startsWith('\uFEFF'), 'CSV 应带 UTF-8 BOM');
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '\uFEFF文件名,应用名,包名');
  assert.equal(lines[1], '"a,b","带""引号""","x\ny"');
});

test('batch: toMarkdown 转义竖线', () => {
  const md = batch.toMarkdown([{ name: 'a|b' }], [{ key: 'name', title: '文件名' }]);
  const lines = md.split('\n');
  assert.equal(lines[0], '| 文件名 |');
  assert.equal(lines[1], '| --- |');
  assert.equal(lines[2], '| a\\|b |');
});

test('batch: createBatchScanner 汇总成功/失败并上报进度', async () => {
  const root = tempDir('batch-scan-');
  fs.writeFileSync(path.join(root, 'good1.apk'), 'x');
  fs.writeFileSync(path.join(root, 'good2.apk'), 'x');
  fs.writeFileSync(path.join(root, 'bad.apk'), 'x');

  const scanner = batch.createBatchScanner({
    parseOne: async (filePath) => {
      if (filePath.endsWith('bad.apk')) throw new Error('故意失败');
      return {
        file_path: filePath,
        warnings: [],
        basic: {
          file: { name: path.basename(filePath), type: 'APK', size: 1, size_human: '1 B' },
          app: { name: 'ok' },
          signature: {},
          structure: {},
          risk: { score: 10, level_label: '低风险' }
        },
        detailed: {}
      };
    }
  });

  const progress = [];
  const items = [];
  const result = await scanner.scan({
    directory: root,
    recursive: false,
    onProgress: (info) => progress.push(info),
    onItem: (row) => items.push(row)
  });

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.rows.length, 3);
  assert.equal(items.length, 3, '每解析完一个都要回调 onItem');
  assert.equal(result.rows.filter((row) => row.error).length, 1);
  assert.ok(progress.length > 0);
  assert.equal(progress[progress.length - 1].percent, 100);
});

test('batch: createBatchScanner 对不存在的目录报错', async () => {
  const scanner = batch.createBatchScanner({ parseOne: async () => ({}) });
  await assert.rejects(() => scanner.scan({ directory: '/definitely/not/here' }), /目录不存在/);
});

test('batch: createBatchScanner 支持 signal 中断', async () => {
  const root = tempDir('batch-abort-');
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(root, `p${i}.apk`), 'x');

  const signal = { aborted: false };
  const scanner = batch.createBatchScanner({
    parseOne: async () => {
      signal.aborted = true; // 第一个解析完就请求停止
      return {
        file_path: 'x',
        warnings: [],
        basic: { file: { name: 'p.apk' }, app: {}, signature: {}, structure: {}, risk: {} },
        detailed: {}
      };
    }
  });

  const result = await scanner.scan({ directory: root, recursive: false, signal });
  assert.equal(result.rows.length, 1, '中断后不应继续解析剩余包体');
});

// ==================== 4. 平台能力矩阵 ====================

test('platform: FEATURE_CATALOG 的平台标识合法且至少覆盖三平台', () => {
  const valid = new Set(['darwin', 'win32', 'linux']);
  for (const feature of FEATURE_CATALOG) {
    assert.ok(feature.id, '每个功能都要有 id');
    assert.ok(feature.name, `${feature.id} 缺 name`);
    assert.ok(feature.group, `${feature.id} 缺 group`);
    assert.ok(Array.isArray(feature.platforms) && feature.platforms.length > 0, `${feature.id} 缺 platforms`);
    for (const platform of feature.platforms) {
      assert.ok(valid.has(platform), `${feature.id} 出现非法平台: ${platform}`);
    }
  }

  const ids = FEATURE_CATALOG.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length, '功能 id 不应重复');
});

test('platform: 读取应用信息（含批量扫描）在三平台都标记为可用', () => {
  const feature = FEATURE_CATALOG.find((item) => item.id === 'package-info');
  assert.ok(feature, '缺少功能 package-info');
  assert.deepEqual([...feature.platforms].sort(), ['darwin', 'linux', 'win32']);
  assert.equal(feature.always, true, 'package-info 应标注为无外部依赖');
  // 批量扫描已并入「读取应用信息」，不应再作为独立功能出现
  assert.equal(FEATURE_CATALOG.some((item) => item.id === 'batch-scan'), false);
});

test('platform: 依赖 macOS 的能力被正确限制', () => {
  const resign = FEATURE_CATALOG.find((item) => item.id === 'ipa-resign');
  const mirror = FEATURE_CATALOG.find((item) => item.id === 'ios-mirror');
  assert.deepEqual(resign.platforms, ['darwin']);
  assert.deepEqual(mirror.platforms, ['darwin']);
  assert.match(resign.platform_note, /macOS/);
});

test('platform: getPlatformCapabilities(probe:false) 返回当前平台且不探测工具', async () => {
  let detectCalled = false;
  const capabilities = createPlatformCapabilities({
    detectTool: async () => { detectCalled = true; return { installed: false, path: null }; }
  });

  const result = await capabilities.getPlatformCapabilities({ probe: false });

  assert.equal(result.platform, process.platform);
  assert.equal(result.probed, false);
  assert.ok(result.features.length === FEATURE_CATALOG.length);
  assert.equal(detectCalled, false, 'probe:false 时不应调用 detectTool');

  // 纯 JS 功能在当前平台上必须是可用的
  const packageInfo = result.features.find((item) => item.id === 'package-info');
  assert.equal(packageInfo.available, true);
  assert.equal(packageInfo.status, 'ready');

  // 非 macOS 上 IPA 重签名必须标记为不可用
  if (process.platform !== 'darwin') {
    const resign = result.features.find((item) => item.id === 'ipa-resign');
    assert.equal(resign.available, false);
    assert.equal(resign.status, 'unavailable');
    assert.match(resign.reason, /不支持/);
  }
});

test('platform: 缺工具时给出可执行的安装提示', async () => {
  const capabilities = createPlatformCapabilities({
    detectTool: async () => ({ installed: false, path: null })
  });
  const result = await capabilities.getPlatformCapabilities({ probe: true });

  const install = result.features.find((item) => item.id === 'apk-install');
  assert.equal(install.available, false);
  assert.equal(install.status, 'missing-tool');
  assert.match(install.reason, /adb/);
  assert.ok(install.tools[0].hint, '缺工具时必须给出安装提示');
});

// ==================== 辅助 ====================

function findRealPackage() {
  const candidates = [
    '/Users/violet/Documents/other_dev/QA_AUTO/apks',
    '/Users/violet/Downloads'
  ];
  for (const dir of candidates) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    const hit = names.find((name) => /\.(apk|aab|ipa)$/i.test(name));
    if (hit) return path.join(dir, hit);
  }
  return null;
}
