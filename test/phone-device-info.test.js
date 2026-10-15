'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPhoneDeviceInfo, helpers } = require('../electron/phone-device-info');

test('parses getprop, battery, display, meminfo, df and ipv4', () => {
  const props = helpers.parseGetprop(`
[ro.product.brand]: [google]
[ro.product.model]: [Pixel 8]
[ro.build.version.release]: [15]
`);
  assert.equal(props['ro.product.model'], 'Pixel 8');

  const battery = helpers.parseBattery(`
  level: 85
  scale: 100
  status: 2
  health: 2
  temperature: 281
  USB powered: true
`);
  assert.equal(battery.level, 85);
  assert.equal(battery.status, '充电中');
  assert.equal(battery.temperatureC, 28.1);
  assert.equal(battery.charging, true);

  const display = helpers.parseDisplay('Physical size: 1080x2400\nPhysical density: 420\n');
  assert.equal(display.size, '1080x2400');
  assert.equal(display.density, 420);

  const memory = helpers.parseMeminfoKb('MemTotal:        8000000 kB\nMemAvailable:    2000000 kB\n');
  assert.equal(memory.total, 8000000 * 1024);
  assert.equal(memory.used, 6000000 * 1024);

  const disks = helpers.parseDf(`Filesystem     Size Used Avail Use% Mounted on
/dev/block/sda 110G  50G   60G  46% /data
tmpfs          1.2G  1.0M  1.2G   1% /dev
/dev/fuse       110G  50G   60G  46% /storage/emulated
`);
  assert.equal(disks[0].mount, '/data');
  assert.equal(disks[1].mount, '/storage/emulated');

  const ips = helpers.parseIpv4('2: wlan0    inet 192.168.1.8/24 brd 192.168.1.255 scope global wlan0\n');
  assert.deepEqual(ips, [{ iface: 'wlan0', address: '192.168.1.8' }]);
});

test('parses cpuinfo, GLES and nominal RAM', () => {
  const cpu = helpers.parseCpuinfo(`
processor	: 0
model name	: ARMv8 Processor
CPU implementer	: 0x41
CPU part	: 0xd47

processor	: 1
CPU implementer	: 0x41
CPU part	: 0xd47

processor	: 2
CPU implementer	: 0x41
CPU part	: 0xd48

Hardware	: Qualcomm Technologies, Inc SM8550
`);
  assert.equal(cpu.cores, 3);
  assert.equal(cpu.hardware, 'Qualcomm Technologies, Inc SM8550');
  assert.ok(cpu.parts.includes('Cortex-A710'));
  assert.ok(cpu.parts.includes('Cortex-X2'));

  const gpu = helpers.parseGpuSection('Adreno 740\nGLES: Qualcomm, Adreno (TM) 740, OpenGL ES 3.2\n', {
    'ro.opengles.version': '196610',
    'ro.hardware.egl': 'qcom'
  });
  assert.equal(gpu.name, 'Adreno (TM) 740');
  assert.equal(gpu.vendor, 'Qualcomm');
  assert.match(gpu.gles, /OpenGL ES 3\.2/);

  assert.equal(helpers.nominalRamGb(7.4 * 1024 * 1024 * 1024), 8);
  assert.equal(helpers.nominalRamGb(11.3 * 1024 * 1024 * 1024), 12);
});

test('builds Android info from a marked dump', () => {
  const info = helpers.buildAndroidInfo('SERIAL', `
__PROP__
[ro.product.manufacturer]: [Google]
[ro.product.model]: [Pixel 8]
[ro.soc.manufacturer]: [Google]
[ro.soc.model]: [Tensor G3]
[ro.product.marketname]: [Pixel 8]
[ro.build.version.release]: [15]
[ro.build.version.sdk]: [35]
__BATTERY__
  level: 40
  scale: 100
  status: 3
  health: 2
  temperature: 300
__DISPLAY__
Physical size: 1080x2400
Physical density: 420
__MEM__
MemTotal:        1000000 kB
MemAvailable:     400000 kB
__CPU__
processor	: 0
Hardware	: Google Tensor G3
processor	: 1
processor	: 2
processor	: 3
processor	: 4
processor	: 5
processor	: 6
processor	: 7
__CORES__
8
__GPU__
Mali-G715
GLES: ARM, Mali-G715, OpenGL ES 3.2
__DF__
Filesystem Size Used Avail Use% Mounted on
/dev/block/data 64G 20G 44G 32% /data
__UPTIME__
12345.67 888.0
__ANDROID_ID__
abcd1234
__IP__
2: wlan0    inet 10.0.0.8/24 scope global wlan0
`);
  assert.equal(info.identity.model, 'Pixel 8');
  assert.equal(info.identity.marketName, 'Pixel 8');
  assert.equal(info.hardware.cpu, 'Google Tensor G3');
  assert.equal(info.hardware.cores, 8);
  assert.match(info.hardware.gpu, /Mali-G715/);
  assert.equal(info.memory.nominalGb, 1);
  assert.equal(info.identity.androidId, 'abcd1234');
  assert.equal(info.system.release, '15');
  assert.equal(info.battery.level, 40);
  assert.equal(info.display.size, '1080x2400');
  assert.equal(info.network.addresses[0].address, '10.0.0.8');
  assert.equal(info.uptime, 12345.67);
});

test('builds iOS info with marketing name', () => {
  const info = helpers.buildIosInfo('UDID', {
    DeviceName: '花叔的 iPhone',
    ProductType: 'iPhone16,1',
    ProductVersion: '18.1',
    BuildVersion: '22B83',
    UniqueDeviceID: 'UDID',
    SerialNumber: 'ABC123',
    WiFiAddress: 'aa:bb:cc:dd:ee:ff',
    CPUArchitecture: 'arm64e',
    ActivationState: 'Activated'
  }, {
    battery: { BatteryCurrentCapacity: '72', BatteryIsCharging: 'true' },
    disk: { TotalDiskCapacity: '256000000000', TotalDataAvailable: '120000000000' }
  });
  assert.equal(info.identity.marketingName, '苹果 15 Pro（iPhone 15 Pro）');
  assert.equal(info.hardware.cpu, 'A17 Pro');
  assert.equal(info.hardware.gpu, 'Apple GPU（6-core）');
  assert.equal(info.hardware.cores, 6);
  assert.equal(info.memory.nominalGb, 8);
  assert.equal(info.battery.level, 72);
  assert.equal(info.battery.charging, true);
  assert.equal(info.storage.total, 256000000000);
  assert.equal(helpers.iosMarketingName('Unknown1,1'), 'Unknown1,1');
});

test('maps iPhone X and OnePlus 7 to marketing names', () => {
  const iphoneX = helpers.buildIosInfo('UDID', { ProductType: 'iPhone10,3', DeviceName: '我的 iPhone' });
  assert.equal(iphoneX.identity.marketingName, '苹果 X（iPhone X）');
  assert.equal(iphoneX.hardware.cpu, 'A11 Bionic');
  assert.equal(iphoneX.memory.nominalGb, 3);

  const iphoneXGsm = helpers.iosMarketingName('iPhone10,6');
  assert.equal(iphoneXGsm, '苹果 X（iPhone X）');

  const oneplus = helpers.buildAndroidInfo('SERIAL', `
__PROP__
[ro.product.brand]: [OnePlus]
[ro.product.manufacturer]: [OnePlus]
[ro.product.model]: [GM1900]
[ro.product.device]: [OnePlus7]
[ro.product.name]: [OnePlus7]
[bluetooth.device.default_name]: [OnePlus 7]
__BATTERY__
__DISPLAY__
__MEM__
__CPU__
__GPU__
__DF__
__UPTIME__
1.0
__ANDROID_ID__
x
__IP__
`);
  assert.equal(oneplus.identity.marketName, '一加 7（OnePlus 7）');
  assert.equal(oneplus.identity.model, 'GM1900');
  assert.equal(oneplus.hardware.cpu, '骁龙 855');
  assert.equal(oneplus.hardware.gpu, 'Adreno 640');
  assert.equal(oneplus.hardware.cores, 8);
});

test('createPhoneDeviceInfo routes Android and iOS commands', async () => {
  const calls = [];
  const manager = createPhoneDeviceInfo({
    runTool: async (tool, args) => {
      calls.push([tool, ...args]);
      if (tool === 'adb') {
        return { stdout: '__PROP__\n[ro.product.model]: [Pixel]\n__BATTERY__\n  level: 10\n  scale: 100\n  status: 3\n  health: 2\n__DISPLAY__\n__MEM__\n__DF__\n__UPTIME__\n1.0\n__ANDROID_ID__\nx\n__IP__\n' };
      }
      if (args.includes('-q')) return { stdout: 'BatteryCurrentCapacity: 88\n' };
      return { stdout: 'DeviceName: Demo\nProductType: iPhone15,2\nProductVersion: 18.0\n' };
    }
  });
  const android = await manager.getInfo({ platform: 'android', deviceId: 'DEV' });
  assert.equal(android.identity.model, 'Pixel');
  assert.equal(calls[0][0], 'adb');
  assert.equal(calls[0].includes('shell'), true);

  const ios = await manager.getInfo({ platform: 'ios', deviceId: 'UDID' });
  assert.equal(ios.identity.name, 'Demo');
  assert.equal(ios.identity.marketingName, '苹果 14 Pro（iPhone 14 Pro）');
  assert.equal(ios.hardware.cpu, 'A16 Bionic');
  assert.equal(ios.memory.nominalGb, 6);
  assert.equal(ios.battery.level, 88);
});
