'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createScrcpyController, helpers } = require('../electron/scrcpy');

test('builds scrcpy args from normalized options', () => {
  const args = helpers.buildArgs({
    deviceId: 'emulator-5554',
    maxSize: '1024',
    maxFps: 60,
    bitRate: '8M',
    stayAwake: true,
    turnScreenOff: true,
    noAudio: true,
    uhidKeyboard: true,
    recordPath: '/tmp/demo.mp4',
    windowTitle: '投屏'
  });
  assert.deepEqual(args, [
    '--serial', 'emulator-5554',
    '--window-title', '投屏',
    '--max-size', '1024',
    '--max-fps', '60',
    '--video-bit-rate', '8M',
    '--stay-awake',
    '--turn-screen-off',
    '--no-audio',
    '--keyboard=uhid',
    '--record=/tmp/demo.mp4'
  ]);
});

test('rejects empty device and invalid bitrate', () => {
  assert.throws(() => helpers.normalizeOptions({}), /请选择/);
  assert.throws(() => helpers.normalizeOptions({ deviceId: 'abc', bitRate: 'fast' }), /码率/);
  assert.throws(() => helpers.normalizeOptions({ deviceId: 'abc', recordPath: 'relative.mp4' }), /绝对路径/);
});

test('detects ready and error lines', () => {
  assert.equal(helpers.isReadyLine('INFO: Renderer: metal'), true);
  assert.equal(helpers.isReadyLine('INFO: Texture: 1080x1920'), true);
  assert.equal(helpers.isReadyLine('INFO: Device: Pixel 8'), true);
  assert.equal(helpers.isErrorLine('ERROR: Could not find any ADB device'), true);
  assert.equal(helpers.isReadyLine('WARN: audio disabled'), false);
});

test('starts a session when scrcpy prints a ready line', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.emit('close', 0, null);
    return true;
  };

  const controller = createScrcpyController({
    spawn: () => child,
    resolveTool: () => '/opt/homebrew/bin/scrcpy',
    detectTool: async () => ({ installed: true, path: '/opt/homebrew/bin/scrcpy' }),
    env: process.env
  });

  const pending = controller.start({ deviceId: 'SERIAL', noAudio: true });
  child.stderr.emit('data', Buffer.from('INFO: Device: Pixel\nINFO: Renderer: metal\n'));
  const started = await pending;
  assert.equal(started.state, 'running');
  assert.equal(started.pid, 4242);
  assert.equal(started.args[0], '--serial');
  assert.equal(started.args[1], 'SERIAL');

  const stopped = await controller.stop('SERIAL');
  assert.equal(stopped.stopped, true);
});

test('fails start when scrcpy exits before ready', async () => {
  const child = new EventEmitter();
  child.pid = 7;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;

  const controller = createScrcpyController({
    spawn: () => child,
    resolveTool: () => '/usr/local/bin/scrcpy',
    env: process.env
  });

  const pending = controller.start({ deviceId: 'dead' });
  child.stderr.emit('data', Buffer.from('ERROR: Could not find any ADB device\n'));
  setImmediate(() => child.emit('close', 1, null));
  await assert.rejects(pending, /ADB device|启动失败|scrcpy/);
});
