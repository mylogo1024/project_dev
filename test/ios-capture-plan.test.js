'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEVICE_BUSY,
  NO_CAPTURE_DEVICE,
  NO_MATCHING_SOURCE,
  PERMISSION_DENIED,
  UNKNOWN,
  classifyCaptureError,
  describeCaptureFailure,
  describeScreenshotFailure,
  isRecoverableScreenshotError,
  planCaptureAttempts,
  scoreCaptureSource
} = require('../src/lib/iosCapturePlan');

test('scores an exact device-name match highest and ignores built-in cameras', () => {
  assert.equal(scoreCaptureSource('FaceTime HD Camera', 'violet的iPhone'), 0);
  assert.ok(scoreCaptureSource('violet的iPhone', 'violet的iPhone') > scoreCaptureSource('violet的iPhone 摄像头', 'violet的iPhone'));
  assert.ok(scoreCaptureSource('iPhone', 'iPhone 15') > scoreCaptureSource('iPhone Camera', 'iPhone 15'));
});

test('plans attempts with the explicit pick first, then ranked sources, then everything else', () => {
  const inputs = [
    { deviceId: 'cam-builtin', label: 'FaceTime HD Camera' },
    { deviceId: 'cam-phone', label: '花叔的iPhone' },
    { deviceId: 'cam-other', label: 'USB Capture' }
  ];
  assert.deepEqual(planCaptureAttempts(inputs, '花叔的iPhone', 'cam-other'), [
    'cam-other',
    'cam-phone',
    'cam-builtin'
  ]);
});

test('still tries every device when labels are empty (no camera permission yet)', () => {
  const inputs = [
    { deviceId: 'a', label: '' },
    { deviceId: 'b', label: '' }
  ];
  assert.deepEqual(planCaptureAttempts(inputs, 'iPhone'), ['a', 'b']);
  assert.deepEqual(planCaptureAttempts([], 'iPhone'), []);
});

test('classifies getUserMedia failures into stable kinds', () => {
  const notFound = new Error('Requested device not found');
  notFound.name = 'NotFoundError';
  assert.equal(classifyCaptureError(notFound), NO_CAPTURE_DEVICE);

  const denied = new Error('Permission denied');
  denied.name = 'NotAllowedError';
  assert.equal(classifyCaptureError(denied), PERMISSION_DENIED);

  const busy = new Error('Could not start video source');
  busy.name = 'NotReadableError';
  assert.equal(classifyCaptureError(busy), DEVICE_BUSY);

  const constrained = new Error('Constraints could not be satisfied');
  constrained.name = 'OverconstrainedError';
  assert.equal(classifyCaptureError(constrained), NO_MATCHING_SOURCE);

  assert.equal(classifyCaptureError(new Error('boom')), UNKNOWN);
  assert.equal(classifyCaptureError(null), UNKNOWN);
});

test('blames the missing hardware when the host has no capture device', () => {
  const hardware = describeCaptureFailure(NO_CAPTURE_DEVICE, { hasCaptureDevice: false, screenshotAvailable: true });
  assert.match(hardware, /Mac mini/);
  assert.match(hardware, /截图刷新/);

  const channel = describeCaptureFailure(NO_CAPTURE_DEVICE, { hasCaptureDevice: true, screenshotAvailable: false });
  assert.match(channel, /QuickTime/);
  assert.doesNotMatch(channel, /截图刷新/);
});

test('permission and busy failures carry actionable next steps', () => {
  assert.match(describeCaptureFailure(PERMISSION_DENIED, {}), /隐私与安全性/);
  assert.match(describeCaptureFailure(DEVICE_BUSY, {}), /QuickTime/);
  assert.match(describeCaptureFailure(NO_MATCHING_SOURCE, {}), /刷新画面源/);
});

test('recognises the recoverable "device not found" screenshot failure', () => {
  // idevicescreenshot 把这行字打在 stdout 上，退出码 255
  const gone = new Error('idevicescreenshot 执行失败: No device found with udid 403ebf5dde5300fcef5417a72868d6748c205814.');
  assert.equal(isRecoverableScreenshotError(gone), true);
  assert.equal(isRecoverableScreenshotError('No device found with udid ABC.'), true);
  assert.equal(isRecoverableScreenshotError(new Error('截图文件未生成')), false);
  assert.equal(isRecoverableScreenshotError(null), false);
});

test('tells apart an unplugged iPhone from a locked one', () => {
  // 设备真的不在了 → 让用户去检查线
  assert.match(describeScreenshotFailure(false), /已断开连接/);
  assert.match(describeScreenshotFailure(false), /数据线/);
  // 设备还在（锁屏 / 链路抖动）→ 让用户去解锁，不要误导他去拔线
  assert.match(describeScreenshotFailure(true), /锁屏/);
  assert.doesNotMatch(describeScreenshotFailure(true), /已断开连接/);
  // 探测失败（null）时按锁屏处理，两种提示都算可自愈
  assert.match(describeScreenshotFailure(null), /自动恢复/);
  assert.match(describeScreenshotFailure(false), /自动恢复/);
});
