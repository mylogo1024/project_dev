'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SCHEME_PRESETS,
  normalizeSchemes,
  describeSchemes,
  buildApksignerSignArgs,
  looksLikeMissingV3,
  siblingPath,
  signApk
} = require('../electron/apk-sign');

test('refuses an empty scheme set and describes the selected ones', () => {
  assert.throws(() => normalizeSchemes({}), /至少选择/);
  assert.deepEqual(normalizeSchemes({ v1: true }), { v1: true, v2: false, v3: false });
  assert.equal(describeSchemes({ v1: true, v2: true, v3: false }), 'v1+v2');
  assert.equal(SCHEME_PRESETS.length, 6);
});

test('apksigner args enable exactly the checked schemes and point at the aligned apk', () => {
  const args = buildApksignerSignArgs({
    keystorePath: '/tmp/a.jks',
    alias: 'csgame',
    password: '123',
    outputPath: '/tmp/app-signed.apk',
    apkPath: '/tmp/app-aligned.apk',
    v1: true,
    v2: false,
    v3: true
  });
  assert.deepEqual(args, [
    'sign',
    '--ks', '/tmp/a.jks',
    '--ks-key-alias', 'csgame',
    '--ks-pass', 'pass:123',
    '--key-pass', 'pass:123',
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'false',
    '--v3-signing-enabled', 'true',
    '--out', '/tmp/app-signed.apk',
    '/tmp/app-aligned.apk'
  ]);
});

test('zipaligns before apksigner and never signs the original file', async () => {
  const apkPath = path.join(os.tmpdir(), `apk-sign-${Date.now()}.apk`);
  const calls = [];
  const result = await signApk({
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { stdout: '' };
    },
    apkPath,
    keystorePath: '/tmp/a.jks',
    alias: 'k',
    password: 'p',
    v1: true,
    v2: true,
    v3: true
  });
  const alignedPath = apkPath.replace(/\.apk$/i, '-aligned.apk');
  const signedPath = apkPath.replace(/\.apk$/i, '-signed.apk');
  assert.equal(calls[0].tool, 'zipalign');
  assert.deepEqual(calls[0].args, ['-f', '-p', '4', apkPath, alignedPath]);
  assert.equal(calls[1].tool, 'apksigner');
  assert.equal(calls[1].args.at(-1), alignedPath);
  assert.equal(result.outputPath, signedPath);
  assert.match(result.message, /v1\+v2\+v3/);
});

test('signApk can write the signed apk to an explicit output path', async () => {
  const apkPath = path.join(os.tmpdir(), `apk-sign-in-${Date.now()}.apk`);
  const dest = path.join(os.tmpdir(), `apk-sign-out-${Date.now()}.apk`);
  const result = await signApk({
    runTool: async () => ({ stdout: '' }),
    apkPath,
    outputPath: dest,
    keystorePath: '/tmp/a.jks',
    alias: 'k',
    password: 'p',
    v1: true,
    v2: true,
    v3: false
  });
  assert.equal(result.outputPath, dest);
});

test('stops if zipalign fails and does not call apksigner', async () => {
  await assert.rejects(
    () => signApk({
      runTool: async (tool) => {
        if (tool === 'zipalign') throw new Error('zipalign missing');
        throw new Error(`should not run ${tool}`);
      },
      apkPath: path.join(os.tmpdir(), 'never-signed.apk'),
      keystorePath: '/tmp/a.jks',
      alias: 'k',
      password: 'p'
    }),
    /签名前对齐失败/
  );
});

test('does not fall back to jarsigner when v2 or v3 is required', async () => {
  await assert.rejects(
    () => signApk({
      runTool: async (tool) => {
        if (tool === 'zipalign') return { stdout: '' };
        throw new Error('apksigner missing');
      },
      apkPath: path.join(os.tmpdir(), 'need-v2.apk'),
      keystorePath: '/tmp/a.jks',
      alias: 'k',
      password: 'p',
      v1: false,
      v2: true,
      v3: false
    }),
    /不能退回 jarsigner/
  );
});

test('old apksigner without v3 retries without that flag when v3 is off', () => {
  assert.equal(looksLikeMissingV3(new Error('Unrecognized option: --v3-signing-enabled')), true);
  assert.equal(siblingPath('/tmp/a.apk', '-signed'), '/tmp/a-signed.apk');
});
