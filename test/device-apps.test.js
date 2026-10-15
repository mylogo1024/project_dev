'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeviceApps, helpers } = require('../electron/device-apps');

test('parses dumpsys package blocks', () => {
  const apps = helpers.parseDumpsysPackages(`
Packages:
  Package [com.example.app] (abc123):
    userId=10123
    codePath=/data/app/~~xx==/com.example.app-yy==
    versionCode=10 minSdk=24 targetSdk=34
    versionName=1.0.1
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    dataDir=/data/user/0/com.example.app
    nativeLibraryDir=/data/app/~~xx==/com.example.app-yy==/lib/arm64
    primaryCpuAbi=arm64-v8a
    secondaryCpuAbi=armeabi-v7a
    firstInstallTime=2024-01-02 03:04:05
    lastUpdateTime=2024-06-07 08:09:10
    installerPackageName=com.android.vending
    signatures:
        SHA-1 digest:  AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD
        MD5 digest:    11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00
  Package [com.android.settings] (def):
    userId=1000
    codePath=/system/priv-app/Settings
    versionCode=34 minSdk=34 targetSdk=34
    versionName=14
    flags=[ SYSTEM HAS_CODE ]
    dataDir=/data/user/0/com.android.settings
`);
  assert.equal(apps.length, 2);
  assert.equal(apps[0].packageName, 'com.example.app');
  assert.equal(apps[0].versionName, '1.0.1');
  assert.equal(apps[0].targetSdk, '34');
  assert.equal(apps[0].apkPath, '/data/app/~~xx==/com.example.app-yy==/base.apk');
  assert.equal(apps[0].soArch, 'arm64-v8a / armeabi-v7a');
  assert.equal(apps[0].appBitness, 64);
  assert.equal(apps[0].sha1, 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD');
  assert.equal(apps[0].md5, '112233445566778899AABBCCDDEEFF00');
  assert.equal(apps[0].isSystem, false);
  assert.equal(apps[0].firstInstallTime, '2024-01-02 03:04:05');
  assert.equal(apps[1].packageName, 'com.android.settings');
  assert.equal(apps[1].isSystem, true);
});

test('parses device profile, aapt native-code and keytool certs', () => {
  const emulator = helpers.parseDeviceProfile(`
qemu=1
hw=ranchu
model=sdk_gphone64_arm64
abi=arm64-v8a
abi64=arm64-v8a
abilist=arm64-v8a,armeabi-v7a,armeabi
`);
  assert.equal(emulator.kind, 'emulator');
  assert.equal(emulator.kindLabel, '模拟器');
  assert.equal(emulator.bitness, 64);

  const device = helpers.parseDeviceProfile(`
qemu=0
hw=qcom
model=GM1900
abi=arm64-v8a
abi64=arm64-v8a
`);
  assert.equal(device.kind, 'device');
  assert.equal(device.kindLabel, '真机');

  assert.deepEqual(
    helpers.parseNativeCode("native-code: 'arm64-v8a' 'armeabi-v7a'"),
    ['arm64-v8a', 'armeabi-v7a']
  );
  assert.equal(helpers.parseAaptTargetSdk("targetSdkVersion:'34'"), '34');

  const certs = helpers.parseKeytoolCerts([
    'Owner: CN=Android',
    ' SHA1: AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
    ' MD5 Fingerprint: 49 1A F4 33 88 E4 49 EC 47 56 15 CC 9A DC 52 44'
  ].join('\n'));
  assert.equal(certs.sha1, 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD');
  assert.equal(certs.md5, '491AF43388E449EC475615CC9ADC5244');
  assert.equal(
    helpers.formatMd5Fingerprint('491AF43388E449EC475615CC9ADC5244'),
    '491AF43388E449EC475615CC9ADC5244'
  );

  const oid = Buffer.from([0x06, 0x03, 0x55, 0x04]);
  const fakeCert = Buffer.concat([
    Buffer.from([0x30, 0x82, 0x01, 0x04]),
    Buffer.alloc(256, 0x11),
    oid,
    Buffer.alloc(4, 0x22)
  ]);
  fakeCert.writeUInt16BE(fakeCert.length - 4, 2);
  const wrapped = Buffer.concat([Buffer.from([0x00, 0x01]), fakeCert]);
  const extracted = helpers.extractX509FromPkcs7(wrapped);
  assert.equal(extracted.equals(fakeCert), true);
});

test('parses du output, package set and apk icon path', () => {
  const du = helpers.parseDuMap('1234\t/data/data/com.foo\n56 /data/data/com.foo/cache\n');
  assert.equal(du['/data/data/com.foo'], 1234 * 1024);
  assert.equal(du['/data/data/com.foo/cache'], 56 * 1024);
  const set = helpers.parsePackageSet('package:com.foo\npackage:com.bar\n');
  assert.equal(set.has('com.foo'), true);
  assert.equal(helpers.apkFilePath('/data/app/foo'), '/data/app/foo/base.apk');
  assert.equal(
    helpers.pickApkIconPath("application-icon-160:'res/a.png'\napplication-icon-480:'res/b.png'\napplication-icon-640:'res/c.xml'"),
    'res/b.png'
  );
  assert.equal(helpers.parseApkLabel("application-label-zh-CN:'微信'\napplication-label:'WeChat'"), '微信');
});

test('parses iOS xml and dash app lists', () => {
  const xml = helpers.parseIosAppXml(`
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.foo.bar</string>
  <key>CFBundleDisplayName</key>
  <string>示例</string>
  <key>CFBundleShortVersionString</key>
  <string>2.1</string>
  <key>CFBundleVersion</key>
  <string>21</string>
</dict>`);
  assert.equal(xml[0].packageName, 'com.foo.bar');
  assert.equal(xml[0].label, '示例');
  assert.equal(xml[0].versionName, '2.1');

  const dash = helpers.parseIosDashApps('com.foo.bar - "示例应用" 2.1.0\n');
  assert.equal(dash[0].packageName, 'com.foo.bar');
  assert.equal(dash[0].label, '示例应用');
  assert.equal(dash[0].versionName, '2.1.0');
});

test('lists Android apps from dumpsys and marks user packages', async () => {
  const manager = createDeviceApps({
    deviceFiles: { probeAndroidRoot: async () => ({ rooted: false, prefix: null }) },
    runTool: async (tool, args) => {
      const command = args[args.length - 1] || '';
      if (String(command).includes('dumpsys package')) {
        return {
          stdout: `Package [com.shop.app] (x):
    userId=10180
    codePath=/data/app/com.shop.app
    versionCode=3 minSdk=21 targetSdk=33
    versionName=3.2
    flags=[ HAS_CODE ]
    firstInstallTime=2023-01-01 00:00:00
    lastUpdateTime=2023-02-02 00:00:00
`
        };
      }
      if (String(command).includes('pm list packages -3')) return { stdout: 'package:com.shop.app\n' };
      if (String(command).includes('android_id')) return { stdout: 'abcd1234\n' };
      if (String(command).includes('getprop ro.kernel.qemu') || String(command).includes('qemu=')) {
        return {
          stdout: 'qemu=0\nhw=qcom\nmodel=GM1900\ndevice=OnePlus7\nabi=arm64-v8a\nabi64=arm64-v8a\nabilist=arm64-v8a\n'
        };
      }
      if (String(command).includes('stat -c')) return { stdout: 'com.shop.app 4096\n' };
      throw new Error(String(args));
    }
  });
  const result = await manager.listApps({ platform: 'android', deviceId: 'DEV' });
  assert.equal(result.androidId, 'abcd1234');
  assert.equal(result.apps[0].packageName, 'com.shop.app');
  assert.equal(result.apps[0].isUser, true);
  assert.equal(result.apps[0].canUninstall, true);
  assert.equal(result.apps[0].apkSize, 4096);
  assert.equal(result.apps[0].targetSdk, '33');
  assert.equal(result.deviceKindLabel, '真机');
  assert.equal(result.deviceBitness, 64);
});
