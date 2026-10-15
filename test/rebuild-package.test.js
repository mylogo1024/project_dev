'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  detectProjectKind,
  defaultOutputPath,
  ipaZipEntries,
  rebuildPackage
} = require('../electron/rebuild-package');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('detects apktool projects and unpacked IPAs, and ignores junk folders', () => {
  const android = tempDir('rebuild-apk-');
  fs.writeFileSync(path.join(android, 'apktool.yml'), 'version: 2.9.3\n');
  assert.equal(detectProjectKind(android), 'android');

  const ios = tempDir('rebuild-ipa-');
  fs.mkdirSync(path.join(ios, 'Payload', 'Demo.app'), { recursive: true });
  assert.equal(detectProjectKind(ios), 'ios');

  const empty = tempDir('rebuild-empty-');
  assert.equal(detectProjectKind(empty), null);
  assert.equal(detectProjectKind('/definitely-missing-dir'), null);

  fs.rmSync(android, { recursive: true, force: true });
  fs.rmSync(ios, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('default output sits next to the project with a rebuilt suffix', () => {
  assert.equal(
    defaultOutputPath('/tmp/小浣熊', 'android'),
    path.join('/tmp', '小浣熊-rebuilt.apk')
  );
  assert.equal(
    defaultOutputPath('/tmp/Game', 'ios'),
    path.join('/tmp', 'Game-rebuilt.ipa')
  );
});

test('IPA zip entries keep Payload extras and skip _symbols', () => {
  const dir = tempDir('rebuild-zip-');
  fs.mkdirSync(path.join(dir, 'Payload', 'Demo.app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'SwiftSupport'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_symbols'), { recursive: true });
  assert.deepEqual(ipaZipEntries(dir), ['Payload', 'SwiftSupport']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rebuild android apktools then zipaligns and signs v1+v2 with the given keystore', async () => {
  const dir = tempDir('rebuild-run-apk-');
  fs.writeFileSync(path.join(dir, 'apktool.yml'), 'version: 2\n');
  const outputPath = path.join(dir, 'out.apk');
  const unsignedPath = outputPath.replace(/\.apk$/i, '-unsigned.apk');
  const calls = [];
  const result = await rebuildPackage({
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { stdout: '' };
    },
    projectDir: dir,
    outputPath,
    sign: { keystorePath: '/tmp/a.jks', alias: 'k', password: 'p' }
  });
  assert.equal(result.kind, 'android');
  assert.equal(result.unsigned, false);
  assert.equal(result.signed, true);
  assert.equal(result.outputPath, outputPath);
  assert.equal(calls[0].tool, 'apktool');
  assert.deepEqual(calls[0].args, ['b', dir, '-o', unsignedPath]);
  assert.equal(calls[1].tool, 'zipalign');
  assert.equal(calls[2].tool, 'apksigner');
  assert.ok(calls[2].args.includes('--v1-signing-enabled'));
  assert.equal(calls[2].args[calls[2].args.indexOf('--v1-signing-enabled') + 1], 'true');
  assert.equal(calls[2].args[calls[2].args.indexOf('--v2-signing-enabled') + 1], 'true');
  assert.equal(calls[2].args[calls[2].args.indexOf('--v3-signing-enabled') + 1], 'false');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rebuild android refuses to skip signing when no keystore is configured', async () => {
  const dir = tempDir('rebuild-nosign-');
  fs.writeFileSync(path.join(dir, 'apktool.yml'), 'version: 2\n');
  await assert.rejects(
    () => rebuildPackage({
      runTool: async () => ({ stdout: '' }),
      projectDir: dir,
      outputPath: path.join(dir, 'out.apk')
    }),
    /设置/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rebuild ios zips Payload from the project directory', async () => {
  const dir = tempDir('rebuild-run-ipa-');
  fs.mkdirSync(path.join(dir, 'Payload', 'Demo.app'), { recursive: true });
  const outputPath = path.join(dir, 'out.ipa');
  const calls = [];
  const result = await rebuildPackage({
    runTool: async (tool, args, options) => {
      calls.push({ tool, args, cwd: options.cwd });
      return { stdout: '' };
    },
    projectDir: dir,
    outputPath
  });
  assert.equal(result.kind, 'ios');
  assert.equal(calls[0].tool, 'zip');
  assert.deepEqual(calls[0].args, ['-qry', outputPath, 'Payload']);
  assert.equal(calls[0].cwd, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a directory that is neither apktool nor IPA', async () => {
  const dir = tempDir('rebuild-bad-');
  await assert.rejects(
    () => rebuildPackage({ runTool: async () => ({}), projectDir: dir }),
    /apktool\.yml/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
