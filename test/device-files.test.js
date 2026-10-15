'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeviceFileManager, helpers } = require('../electron/device-files');

const {
  parseLsLine,
  parseAfcLsLine,
  parseIosBrowsePath,
  parseInstalledApps,
  parseFileOpPayload,
  joinDevicePath,
  posixShellQuote,
  adbShellArgv
} = helpers;

function isIdProbe(args) {
  return args.some((arg) => arg === 'id' || arg === "'id'");
}

test('parses Android ls -lah lines', () => {
  const dir = parseLsLine('drwxrwx--x  2 u0_a123 sdcard_rw 4.0K 2024-01-01 12:00 DCIM');
  assert.equal(dir.name, 'DCIM');
  assert.equal(dir.isDirectory, true);
  assert.equal(dir.size, 4096);

  const file = parseLsLine('-rw-rw----  1 u0_a123 sdcard_rw 1.2M 2024-01-01 12:00 my photo.jpg');
  assert.equal(file.name, 'my photo.jpg');
  assert.equal(file.isDirectory, false);
  assert.equal(file.size, Math.round(1.2 * 1024 * 1024));

  assert.equal(parseLsLine('total 12'), null);
  assert.equal(parseLsLine('drwxr-xr-x 2 root root 4.0K 2024-01-01 12:00 .'), null);
});

test('parses afcclient ls -l lines and strips colors', () => {
  const dir = parseAfcLsLine('drwxr-xr-x    2 mobile mobile         68 14 Sep 2026 14:20:00 DCIM');
  assert.equal(dir.name, 'DCIM');
  assert.equal(dir.isDirectory, true);
  assert.equal(dir.size, 68);

  const file = parseAfcLsLine('\x1B[0m-rw-r--r--    1 mobile mobile     102400 01 Jan 2024 08:00:00 IMG_0001.JPG\x1B[0m');
  assert.equal(file.name, 'IMG_0001.JPG');
  assert.equal(file.isDirectory, false);
  assert.equal(file.size, 102400);

  assert.equal(parseAfcLsLine('Error: Failed to get file info'), null);
});

test('maps iOS virtual browse paths', () => {
  assert.deepEqual(parseIosBrowsePath('/'), { kind: 'media', bundleId: '', afcPath: '/' });
  assert.deepEqual(parseIosBrowsePath('/DCIM/100APPLE'), { kind: 'media', bundleId: '', afcPath: '/DCIM/100APPLE' });
  assert.deepEqual(parseIosBrowsePath('/media/DCIM'), { kind: 'media', bundleId: '', afcPath: '/DCIM' });
  assert.deepEqual(parseIosBrowsePath('/apps'), { kind: 'apps', bundleId: '', afcPath: '/' });
  assert.deepEqual(parseIosBrowsePath('/apps/com.foo.bar'), { kind: 'documents', bundleId: 'com.foo.bar', afcPath: '/' });
  assert.deepEqual(parseIosBrowsePath('/apps/com.foo.bar/Inbox/a.txt'), {
    kind: 'documents',
    bundleId: 'com.foo.bar',
    afcPath: '/Inbox/a.txt'
  });
  assert.equal(joinDevicePath('/sdcard/', 'Download'), '/sdcard/Download');
  assert.equal(posixShellQuote("it's"), `'it'\\''s'`);
  const wrapped = adbShellArgv(`rm -rf -- ${posixShellQuote('/sdcard/P2P(1).apk')}`, {
    rooted: true,
    prefix: ['su', '-c']
  });
  assert.deepEqual(wrapped.slice(0, 3), ['shell', 'su', '-c']);
  assert.equal(wrapped[3], posixShellQuote(`rm -rf -- ${posixShellQuote('/sdcard/P2P(1).apk')}`));
  assert.match(wrapped[3], /^'/);
  assert.match(wrapped[3], /P2P\(1\)\.apk/);
});

test('parses ideviceinstaller app lists', () => {
  const apps = parseInstalledApps(`
Total: 2 apps
com.foo.bar - "Foo Bar" 1.2.3
com.apple.TestFlight - TestFlight 3.0
CFBundleIdentifier, CFBundleName, CFBundleVersion
com.baz.qux, Baz, 9.0
`);
  assert.deepEqual(apps.map((app) => app.bundleId), ['com.foo.bar', 'com.apple.TestFlight', 'com.baz.qux']);
  assert.equal(apps[0].name.includes('Foo'), true);
});

test('normalizes IPC payloads', () => {
  assert.deepEqual(parseFileOpPayload({ deviceId: 'ABC', platform: 'ios', path: '/DCIM' }), {
    deviceId: 'ABC',
    platform: 'ios',
    remotePath: '/DCIM',
    localPath: '',
    refreshPrivilege: false
  });
  assert.equal(parseFileOpPayload('SERIAL', '/sdcard').platform, 'android');
  assert.equal(parseFileOpPayload('SERIAL', '/sdcard').remotePath, '/sdcard');
});

test('Android listing uses su when id reports uid=0, otherwise falls back', async () => {
  const calls = [];
  const manager = createDeviceFileManager({
    runTool: async (tool, args) => {
      calls.push([tool, ...args]);
      if (isIdProbe(args)) return { stdout: 'uid=0(root) gid=0(root)' };
      if (String(args.at(-1) || '').includes('ls -lah')) {
        return { stdout: 'drwxrwxrwx 2 root root 4.0K 2024-01-01 12:00 data\n' };
      }
      throw new Error(`unexpected ${tool} ${args.join(' ')}`);
    }
  });
  const listed = await manager.listFiles({ deviceId: 'DEV', platform: 'android', path: '/data' });
  assert.equal(listed.privilege, 'root');
  assert.equal(listed.files[0].name, 'data');
  assert.equal(calls[0].includes('su'), true);
  assert.equal(calls[1].includes('su'), true);
  assert.equal(String(calls[1].at(-1)), posixShellQuote("ls -lah -- '/data'"));
});

test('Android listing stays unprivileged when su is missing', async () => {
  const calls = [];
  const manager = createDeviceFileManager({
    runTool: async (tool, args) => {
      calls.push(args.slice());
      if (args.includes('su')) throw new Error('/system/bin/sh: su: not found');
      return { stdout: '-rw-rw---- 1 u0_a1 sdcard_rw 12 2024-01-01 12:00 note.txt\n' };
    }
  });
  const listed = await manager.listFiles({ deviceId: 'DEV', platform: 'android', path: '/sdcard' });
  assert.equal(listed.privilege, 'shell');
  assert.equal(listed.files[0].name, 'note.txt');
  const suCalls = calls.filter((args) => args.includes('su'));
  assert.equal(suCalls.length, 1);
  const lsCall = calls.find((args) => String(args.at(-1) || '').includes('ls -lah'));
  assert.equal(lsCall.includes('su'), false);
});

test('Android root pull copies through /data/local/tmp', async () => {
  const calls = [];
  const manager = createDeviceFileManager({
    runTool: async (tool, args) => {
      calls.push(args.slice());
      if (isIdProbe(args)) return { stdout: 'uid=0(root) gid=0(root)' };
      const joined = args.join(' ');
      if (joined.includes('pull') && joined.includes('/data/data/com.foo')) {
        throw new Error('Permission denied');
      }
      return { stdout: '' };
    }
  });
  const result = await manager.pullFile({
    deviceId: 'DEV',
    platform: 'android',
    remotePath: '/data/data/com.foo/files/a.txt',
    localPath: '/tmp/a.txt'
  });
  assert.equal(result.privilege, 'root');
  const joined = calls.map((args) => args.join(' ')).join('\n');
  assert.match(joined, /cat --/);
  assert.match(joined, /com\.foo\/files\/a\.txt/);
  assert.doesNotMatch(joined, /chmod -R 0777/);
  assert.match(joined, /pull \/data\/local\/tmp\/\.toolbox-fm-/);
  assert.match(joined, /rm -rf --/);
  assert.match(joined, /\/data\/local\/tmp\/\.toolbox-fm-/);
});

test('Android root delete quotes filenames that contain parentheses', async () => {
  const calls = [];
  const manager = createDeviceFileManager({
    runTool: async (tool, args) => {
      calls.push(args.slice());
      if (isIdProbe(args)) return { stdout: 'uid=0(root) gid=0(root)' };
      return { stdout: '' };
    }
  });
  const remotePath = '/sdcard/Download/P2P下载器-Plus_v1.7.3_去广解锁版(1).apk';
  await manager.deleteFile({ deviceId: 'DEV', platform: 'android', path: remotePath });
  const rmCall = calls.find((args) => String(args.at(-1) || '').includes('rm -rf'));
  assert.equal(rmCall.includes('su'), true);
  assert.equal(rmCall.at(-1), posixShellQuote(`rm -rf -- ${posixShellQuote(remotePath)}`));
});

test('readable tmp copy command never uses 0777', () => {
  const command = helpers.prepareReadableTmpCommand('/data/data/a.txt', '/data/local/tmp/.toolbox-fm-1');
  assert.match(command, /cat -- '\/data\/data\/a\.txt'/);
  assert.match(command, /chmod -R a\+rX/);
  assert.doesNotMatch(command, /0777/);
});

test('iOS media listing uses afcclient and apps listing uses ideviceinstaller', async () => {
  const calls = [];
  const manager = createDeviceFileManager({
    runTool: async (tool, args) => {
      calls.push([tool, ...args]);
      if (tool === 'afcclient') {
        return { stdout: 'drwxr-xr-x    2 mobile mobile         68 14 Sep 2026 14:20:00 DCIM\n' };
      }
      if (tool === 'ideviceinstaller') {
        return { stdout: 'com.foo.bar - Foo 1.0\n' };
      }
      throw new Error(tool);
    }
  });

  const media = await manager.listFiles({ deviceId: 'UDID', platform: 'ios', path: '/' });
  assert.equal(media.privilege, 'afc');
  assert.equal(media.files[0].name, 'DCIM');
  assert.deepEqual(calls[0], ['afcclient', '-u', 'UDID', 'ls', '-l', '/']);

  const apps = await manager.listFiles({ deviceId: 'UDID', platform: 'ios', path: '/apps' });
  assert.equal(apps.privilege, 'apps');
  assert.equal(apps.files[0].name, 'com.foo.bar');
  assert.equal(apps.files[0].isDirectory, true);
  assert.deepEqual(calls[1], ['ideviceinstaller', '-u', 'UDID', 'list']);
});

test('iOS app documents fall back from --documents to --container', async () => {
  const modes = [];
  const manager = createDeviceFileManager({
    runTool: async (tool, args) => {
      if (tool !== 'afcclient') throw new Error(tool);
      if (args.includes('--container')) {
        modes.push('container');
        // container 失败后会 fallback 到 documents
        throw new Error('InstallationLookupFailed');
      }
      if (args.includes('--documents')) {
        modes.push('documents');
        return { stdout: '-rw-r--r--    1 mobile mobile          4 14 Sep 2026 14:20:00 save.dat\n' };
      }
      modes.push('media');
      return { stdout: '-rw-r--r--    1 mobile mobile          4 14 Sep 2026 14:20:00 save.dat\n' };
    }
  });
  const listed = await manager.listFiles({
    deviceId: 'UDID',
    platform: 'ios',
    path: '/apps/com.foo.bar'
  });
  // 现在优先尝试 container（iOS 8.3+ 后更通用），失败后再试 documents
  assert.deepEqual(modes, ['container', 'documents']);
  assert.equal(listed.privilege, 'documents');
  assert.equal(listed.files[0].name, 'save.dat');
});
