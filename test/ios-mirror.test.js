'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createIosMirror, helpers } = require('../electron/ios-mirror');

test('scores USB iPhone screen higher than Continuity Camera and FaceTime', () => {
  assert.equal(helpers.scoreCamera('FaceTime HD Camera', 'violet的iPhone'), 0);
  assert.ok(helpers.scoreCamera('violet的iPhone', 'violet的iPhone') > helpers.scoreCamera('violet的iPhone 摄像头', 'violet的iPhone'));
  assert.ok(helpers.scoreCamera('iPhone', 'iPhone 15') > helpers.scoreCamera('iPhone Camera', 'iPhone 15'));
});

test('picks the best matching camera', () => {
  const picked = helpers.pickBestCamera([
    { label: 'FaceTime HD Camera' },
    { label: 'iPhone Camera' },
    { label: '花叔的iPhone' }
  ], '花叔的iPhone');
  assert.equal(picked.label, '花叔的iPhone');
  assert.equal(helpers.pickBestCamera([{ label: 'FaceTime HD Camera' }], 'iPhone'), null);
});

test('parses system_profiler camera JSON', () => {
  const cameras = helpers.parseSystemProfilerCameras(JSON.stringify({
    SPCameraDataType: [
      { _name: 'FaceTime HD Camera', 'spcamera_unique-id': 'a' },
      { _name: 'iPhone', 'spcamera_unique-id': 'b', 'spcamera_model-id': 'iOS Screen' }
    ]
  }));
  assert.deepEqual(cameras.map((item) => item.name), ['FaceTime HD Camera', 'iPhone']);
  assert.equal(cameras[1].uniqueId, 'b');
});

test('saves a data URL to an absolute path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-mirror-'));
  const filePath = path.join(dir, 'frame.png');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const result = helpers.saveDataUrl(filePath, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(filePath).equals(png), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('screenshot IPC uses idevicescreenshot -u and returns a data URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-mirror-shot-'));
  const mirror = createIosMirror({
    runTool: async (tool, args) => {
      assert.equal(tool, 'idevicescreenshot');
      assert.equal(args[0], '-u');
      assert.equal(args[1], 'UDID1');
      fs.writeFileSync(args[2], Buffer.from('png-bytes'));
      return { stdout: '' };
    },
    detectTool: async () => ({ installed: true, path: '/usr/local/bin/idevicescreenshot' })
  });
  const shot = await mirror.takeScreenshot('UDID1');
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(shot.dataUrl.split(',')[1], 'base64').toString(), 'png-bytes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capabilities report live capture only on darwin', async () => {
  const mirror = createIosMirror({
    runTool: async () => ({ stdout: '{}' }),
    detectTool: async () => ({ installed: false, path: null }),
    platform: 'linux'
  });
  const caps = await mirror.getCapabilities();
  assert.equal(caps.liveCapture, false);
  assert.equal(caps.screenshot, false);
});

test('getDeviceState tells whether the UDID is still plugged in', async () => {
  const mirror = createIosMirror({
    runTool: async (tool, args) => {
      assert.equal(tool, 'idevice_id');
      assert.deepEqual(args, ['-l']);
      return { stdout: 'AAA111\nBBB222\n' };
    },
    detectTool: async () => ({ installed: true, path: '/opt/homebrew/bin/idevicescreenshot' })
  });
  assert.deepEqual(await mirror.getDeviceState('BBB222'), { connected: true, ids: ['AAA111', 'BBB222'] });
  assert.deepEqual(await mirror.getDeviceState('CCC333'), { connected: false, ids: ['AAA111', 'BBB222'] });
  // 空 UDID 不该去调工具
  assert.deepEqual(await mirror.getDeviceState(''), { connected: false, ids: [] });
});

test('getDeviceState degrades to disconnected when idevice_id fails', async () => {
  const mirror = createIosMirror({
    runTool: async () => { throw new Error('idevice_id 不可用'); },
    detectTool: async () => ({ installed: false, path: null })
  });
  assert.deepEqual(await mirror.getDeviceState('AAA111'), { connected: false, ids: [] });
});
