'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 把工具目录指到临时目录，避免污染真实的 %APPDATA%
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-installer-'));
process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR = SANDBOX;

const installer = require('../electron/tool-installer');

test.after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test('toolRoot 落在环境变量指向的目录内', () => {
  assert.equal(installer.toolRoot(), path.resolve(SANDBOX));
});

test('未安装时 binDirectories 为空', () => {
  assert.deepEqual(installer.binDirectories(), []);
});

test('listInstalled 覆盖 adb / scrcpy / apktool 三件套', () => {
  const ids = installer.listInstalled().map((item) => item.id);
  assert.deepEqual(ids, ['adb', 'scrcpy', 'apktool']);
  assert.ok(installer.listInstalled().every((item) => item.installed === false));
});

test('版本号被清洗成单段目录名，无法穿越到父目录', () => {
  const dir = installer.installDirFor({ id: 'adb', version: '../../evil' });
  assert.ok(dir.startsWith(installer.toolRoot()));
  const relative = path.relative(installer.toolRoot(), dir);
  assert.ok(!relative.split(path.sep).includes('..'), `目录不应逃逸出工具根目录：${relative}`);
  assert.equal(relative.split(path.sep).length, 2, '应是 <toolId>/<version> 两层');
});

test('GitHub 工具生成镜像候选，直连排第一', () => {
  const scrcpy = installer.TOOL_DEFS.find((item) => item.id === 'scrcpy');
  const urls = installer.urlCandidates(scrcpy);
  assert.ok(urls[0].startsWith('https://github.com/'), '第一个应是官方直连');
  assert.ok(urls.length > 1, '应有镜像回退');
  assert.ok(urls.slice(1).every((url) => url.endsWith(urls[0])), '镜像应是原 URL 加前缀');
});

test('自定义镜像前缀优先生效', () => {
  process.env.DAILY_DEV_TOOLBOX_GITHUB_MIRROR = 'https://my-mirror.example/';
  const urls = installer.urlCandidates(installer.TOOL_DEFS.find((item) => item.id === 'scrcpy'));
  assert.ok(urls[1].startsWith('https://my-mirror.example/'));
  delete process.env.DAILY_DEV_TOOLBOX_GITHUB_MIRROR;
});

test('非 GitHub 工具（adb）不套镜像前缀', () => {
  const adb = installer.TOOL_DEFS.find((item) => item.id === 'adb');
  assert.deepEqual(installer.urlCandidates(adb), [adb.url]);
});

test('apktool 启动脚本：bat 指向同目录 jar，且带 sh 入口', () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'launcher-'));
  installer.writeApktoolLauncher(dir, 'apktool.jar');
  const bat = fs.readFileSync(path.join(dir, 'apktool.bat'), 'utf8');
  assert.match(bat, /java -jar "%BAT_DIR%apktool\.jar" %\*/);
  assert.match(bat, /@echo off/);
  // Windows 批处理必须是 CRLF，否则老版本 cmd 会解析异常
  assert.ok(bat.includes('\r\n'));
  assert.ok(fs.existsSync(path.join(dir, 'apktool')));
});

const ADB_TOOL = { id: 'adb', provides: ['adb'] };
const ADB_MARKER = 'adb.exe';

test('外层目录摊平：adb 藏在 platform-tools/ 里也能被提升到根', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'nested-'));
  const nested = path.join(dir, 'platform-tools');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, ADB_MARKER), 'x');

  await installer.flattenIfNeeded(dir, ADB_TOOL);
  assert.ok(fs.existsSync(path.join(dir, ADB_MARKER)), `${ADB_MARKER} 应被提升到根目录`);
  assert.ok(!fs.existsSync(nested), '空的外层目录应被删除');
});

test('已在根目录时不误摊平', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX, 'flat-'));
  fs.writeFileSync(path.join(dir, ADB_MARKER), 'x');
  fs.mkdirSync(path.join(dir, 'keepme'));
  fs.writeFileSync(path.join(dir, 'keepme', 'a.txt'), 'x');

  await installer.flattenIfNeeded(dir, ADB_TOOL);
  assert.ok(fs.existsSync(path.join(dir, 'keepme')), '无关子目录不应被动');
});

test('markerName：Windows 包固定按 .exe 判定（不看当前平台）', () => {
  const adb = installer.TOOL_DEFS.find((item) => item.id === 'adb');
  assert.equal(installer.markerName(adb), 'adb.exe');
  assert.equal(installer.markerName({ kind: 'apktool' }), 'apktool.bat');
});

test('installTool 对未知 id 明确报错', async () => {
  await assert.rejects(() => installer.installTool('nope'), /未知的工具/);
});

test('uninstallTool 清理整个工具目录', async () => {
  const dir = path.join(SANDBOX, 'apktool', '9.9.9');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'apktool.bat'), 'x');
  assert.ok(fs.existsSync(path.join(dir, 'apktool.bat')));

  await installer.uninstallTool('apktool');
  assert.ok(!fs.existsSync(path.join(SANDBOX, 'apktool')), '应删掉整个 apktool 目录');
});

test('已安装时跳过下载（幂等）', async () => {
  const tool = installer.TOOL_DEFS.find((item) => item.id === 'adb');
  const dir = installer.installDirFor(tool);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, installer.markerName(tool)), 'x');

  const stages = [];
  const result = await installer.installTool('adb', {
    onProgress: (p) => stages.push(p.stage)
  });
  assert.equal(result.skipped, true, '第二次调用应跳过');
  assert.ok(stages.includes('完成'));
});
