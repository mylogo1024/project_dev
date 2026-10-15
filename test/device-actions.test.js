'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CATALOG,
  KEYEVENT,
  REMOTE_SHOT,
  androidInvocation,
  createDeviceActions
} = require('../electron/device-actions');

test('catalog covers the requested buttons and hides iOS-only gaps', () => {
  const ids = CATALOG.map((item) => item.id);
  for (const id of ['shutdown', 'reboot', 'screenshot', 'record-start', 'mute', 'volume-up', 'volume-down', 'sleep', 'wake', 'home', 'clear-recents', 'back']) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(CATALOG.find((item) => item.id === 'back').platforms.includes('ios'), false);
  assert.equal(CATALOG.find((item) => item.id === 'record-start').platforms.includes('ios'), false);
});

test('android invocations use system reboot and keyevents, not a helper app', () => {
  assert.deepEqual(androidInvocation('shutdown').args, ['reboot', '-p']);
  assert.deepEqual(androidInvocation('reboot').args, ['reboot']);
  assert.deepEqual(androidInvocation('home').args, ['shell', 'input', 'keyevent', KEYEVENT.HOME]);
  assert.deepEqual(androidInvocation('back').args, ['shell', 'input', 'keyevent', KEYEVENT.BACK]);
  assert.deepEqual(androidInvocation('clear-recents').args, ['shell', 'cmd', 'activity', 'recents', 'remove-all']);
  assert.deepEqual(androidInvocation('mute').args, ['shell', 'cmd', 'media', 'volume', '--stream', '3', '--set', '0']);
});

test('runs android keyevents through adb -s and saves screenshots via screencap+pull', async () => {
  const dest = path.join(os.tmpdir(), `da-shot-${Date.now()}.png`);
  const calls = [];
  const actions = createDeviceActions({
    runTool: async (tool, args) => {
      calls.push([tool, ...args]);
      if (args.includes('pull')) fs.writeFileSync(dest, 'png');
      return { stdout: '' };
    }
  });
  await actions.run({ platform: 'android', deviceId: 'SER', action: 'home' });
  assert.deepEqual(calls[0], ['adb', '-s', 'SER', 'shell', 'input', 'keyevent', '3']);

  const shot = await actions.run({
    platform: 'android',
    deviceId: 'SER',
    action: 'screenshot',
    outputPath: dest
  });
  assert.equal(shot.ok, true);
  assert.ok(calls.some((item) => item.includes('screencap') && item.includes(REMOTE_SHOT)));
  assert.ok(calls.some((item) => item.includes('pull')));
  fs.rmSync(dest, { force: true });
});

test('lists record-stop only while a session is running', async () => {
  const actions = createDeviceActions({
    runTool: async (_tool, args) => {
      if (String(args.at(-1) || '').includes('screenrecord')) return { stdout: '4321\n' };
      return { stdout: '' };
    }
  });
  const startIds = actions.listActions({ platform: 'android', deviceId: 'A' }).map((item) => item.id);
  assert.ok(startIds.includes('record-start'));
  assert.ok(!startIds.includes('record-stop'));

  await actions.run({ platform: 'android', deviceId: 'A', action: 'record-start' });
  const live = actions.listActions({ platform: 'android', deviceId: 'A' }).map((item) => item.id);
  assert.ok(live.includes('record-stop'));
  assert.ok(!live.includes('record-start'));
});

test('ios power actions use idevicediagnostics, buttons go through WDA', async () => {
  const calls = [];
  const buttons = [];
  const dest = path.join(os.tmpdir(), `da-ios-${Date.now()}.png`);
  const actions = createDeviceActions({
    runTool: async (tool, args) => {
      calls.push([tool, ...args]);
      if (tool === 'idevicescreenshot') fs.writeFileSync(dest, 'png');
      return { stdout: '' };
    },
    iosControl: {
      pressHome: async () => { buttons.push('home'); },
      pressButton: async (name) => { buttons.push(name); }
    }
  });
  await actions.run({ platform: 'ios', deviceId: 'UDID', action: 'reboot' });
  assert.deepEqual(calls[0], ['idevicediagnostics', '-u', 'UDID', 'restart']);
  await actions.run({ platform: 'ios', deviceId: 'UDID', action: 'home' });
  assert.deepEqual(buttons, ['home']);
  await actions.run({ platform: 'ios', deviceId: 'UDID', action: 'screenshot', outputPath: dest });
  assert.equal(calls[1][0], 'idevicescreenshot');
  fs.rmSync(dest, { force: true });
});

test('ios without WDA explains why volume keys are unavailable', async () => {
  const actions = createDeviceActions({
    runTool: async () => ({ stdout: '' })
  });
  await assert.rejects(
    () => actions.run({ platform: 'ios', deviceId: 'U', action: 'volume-up' }),
    /WebDriverAgent/
  );
});
