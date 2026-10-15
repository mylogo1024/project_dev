'use strict';

const { helpers: deviceFileHelpers } = require('./device-files');

const { adbArgs, normalizeDeviceId } = deviceFileHelpers;
const {
  iosHardware,
  formatIosMarketingName,
  resolveAndroidIdentity
} = require('./device-model-names');

const ANDROID_DUMP_SCRIPT = [
  'echo __PROP__',
  'getprop',
  'echo __BATTERY__',
  'dumpsys battery',
  'echo __DISPLAY__',
  'wm size',
  'wm density',
  'echo __MEM__',
  'cat /proc/meminfo',
  'echo __CPU__',
  'cat /proc/cpuinfo',
  'echo __CORES__',
  'ls /sys/devices/system/cpu 2>/dev/null | grep -c "^cpu[0-9]"',
  'echo __GPU__',
  'cat /sys/class/kgsl/kgsl-3d0/gpu_model 2>/dev/null',
  'cat /sys/devices/platform/kgsl-3d0.0/kgsl/kgsl-3d0/gpu_model 2>/dev/null',
  'cat /sys/kernel/gpu/gpu_model 2>/dev/null',
  'cat /proc/mali/platform 2>/dev/null',
  'timeout 3 dumpsys SurfaceFlinger 2>/dev/null | grep GLES | head -8',
  'echo __DF__',
  'df -h',
  'echo __UPTIME__',
  'cat /proc/uptime',
  'echo __ANDROID_ID__',
  'settings get secure android_id',
  'echo __IP__',
  'ip -o -4 addr show 2>/dev/null || ip addr 2>/dev/null || ifconfig 2>/dev/null'
].join('; ');

const BATTERY_STATUS = {
  1: '未知',
  2: '充电中',
  3: '放电中',
  4: '未充电',
  5: '已充满'
};

const BATTERY_HEALTH = {
  1: '未知',
  2: '良好',
  3: '过热',
  4: '损坏',
  5: '过压',
  6: '未知错误',
  7: '过冷'
};

const CPU_PARTS = {
  '0x41:0xd03': 'Cortex-A53',
  '0x41:0xd05': 'Cortex-A55',
  '0x41:0xd07': 'Cortex-A57',
  '0x41:0xd08': 'Cortex-A72',
  '0x41:0xd09': 'Cortex-A73',
  '0x41:0xd0a': 'Cortex-A75',
  '0x41:0xd0b': 'Cortex-A76',
  '0x41:0xd0d': 'Cortex-A77',
  '0x41:0xd41': 'Cortex-A78',
  '0x41:0xd44': 'Cortex-X1',
  '0x41:0xd46': 'Cortex-A510',
  '0x41:0xd47': 'Cortex-A710',
  '0x41:0xd48': 'Cortex-X2',
  '0x41:0xd4d': 'Cortex-A715',
  '0x41:0xd4e': 'Cortex-X3',
  '0x41:0xd80': 'Cortex-A520',
  '0x41:0xd81': 'Cortex-A720',
  '0x41:0xd82': 'Cortex-X4',
  '0x51:0x001': 'Qualcomm Oryon',
  '0x51:0x004': 'Kryo',
  '0x51:0x805': 'Kryo 385',
  '0x51:0x804': 'Kryo 385',
  '0x51:0x803': 'Kryo 385'
};

const RAM_NOTCHES_GB = [2, 3, 4, 6, 8, 12, 16, 18, 24, 32, 36, 48, 64];

function parseGetprop(stdout) {
  const props = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]\s*$/);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

function parseColonMap(stdout) {
  const values = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function splitDumpSections(stdout) {
  const sections = {};
  let current = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const marker = line.trim().match(/^__(PROP|BATTERY|DISPLAY|MEM|CPU|CORES|GPU|DF|UPTIME|ANDROID_ID|IP)__$/);
    if (marker) {
      current = marker[1].toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(sections).map(([key, lines]) => [key, lines.join('\n')])
  );
}

function parseBattery(stdout) {
  const raw = parseColonMap(stdout);
  const number = (key) => {
    const value = Number.parseFloat(raw[key]);
    return Number.isFinite(value) ? value : null;
  };
  const statusCode = number('status');
  const healthCode = number('health');
  const temperature = number('temperature');
  const voltage = number('voltage');
  const level = number('level');
  const scale = number('scale') || 100;
  const percent = level == null ? null : Math.round((level / scale) * 100);
  return {
    level: percent,
    status: BATTERY_STATUS[statusCode] || raw.status || '',
    health: BATTERY_HEALTH[healthCode] || raw.health || '',
    charging: /true/i.test(raw['USB powered'] || '') || /true/i.test(raw['AC powered'] || '') || /true/i.test(raw['Wireless powered'] || '') || statusCode === 2,
    temperatureC: temperature == null ? null : temperature / 10,
    voltageMv: voltage,
    present: /true/i.test(raw.present || 'true')
  };
}

function parseDisplay(stdout) {
  const text = String(stdout || '');
  const physical = text.match(/Physical size:\s*(\S+)/i);
  const override = text.match(/Override size:\s*(\S+)/i);
  const density = text.match(/Physical density:\s*(\d+)/i);
  const overrideDensity = text.match(/Override density:\s*(\d+)/i);
  return {
    size: (override && override[1]) || (physical && physical[1]) || '',
    physicalSize: physical ? physical[1] : '',
    density: Number.parseInt((overrideDensity && overrideDensity[1]) || (density && density[1]) || '', 10) || null
  };
}

function parseMeminfoKb(stdout) {
  const map = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB/i);
    if (match) map[match[1]] = Number.parseInt(match[2], 10) * 1024;
  }
  const total = map.MemTotal || 0;
  const available = map.MemAvailable || map.MemFree || 0;
  const used = Math.max(0, total - available);
  return {
    total,
    available,
    used,
    usagePercent: total ? Number(((used / total) * 100).toFixed(1)) : null,
    nominalGb: nominalRamGb(total)
  };
}

function nominalRamGb(bytes) {
  if (!bytes) return null;
  const gb = bytes / (1024 ** 3);
  let best = RAM_NOTCHES_GB[0];
  let bestDelta = Math.abs(gb - best);
  for (const notch of RAM_NOTCHES_GB) {
    const delta = Math.abs(gb - notch);
    if (delta < bestDelta || (delta === bestDelta && notch >= gb)) {
      best = notch;
      bestDelta = delta;
    }
  }
  if (gb > best * 0.72 && gb <= best * 1.08) return best;
  return Math.round(gb);
}

function parseCpuinfo(stdout) {
  const blocks = [];
  let current = {};
  const flush = () => {
    if (Object.keys(current).length) blocks.push(current);
    current = {};
  };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'processor') {
      flush();
      current = { processor: value };
      continue;
    }
    current[key] = value;
  }
  flush();

  const processors = blocks.filter((block) => block.processor != null);
  const hardwareBlock = blocks.find((block) => block.hardware) || {};
  const first = processors[0] || blocks[0] || {};
  const parts = [...new Set(processors.map((block) => {
    const implementer = String(block['cpu implementer'] || '').toLowerCase();
    const part = String(block['cpu part'] || '').toLowerCase();
    return CPU_PARTS[`${implementer}:${part}`] || '';
  }).filter(Boolean))];

  return {
    cores: processors.length,
    model: first['model name'] || hardwareBlock.hardware || first.hardware || '',
    hardware: hardwareBlock.hardware || first.hardware || '',
    parts,
    architecture: first['cpu architecture'] || first.architecture || ''
  };
}

function parseGpuSection(stdout, props) {
  const text = String(stdout || '');
  const gles = text.match(/GLES:\s*(.+)/i);
  let vendor = '';
  let renderer = '';
  let glesVersion = '';
  if (gles) {
    const parts = gles[1].split(',').map((item) => item.trim()).filter(Boolean);
    vendor = parts[0] || '';
    renderer = parts[1] || '';
    glesVersion = parts[2] || '';
  }
  const kgsl = text.split(/\r?\n/).map((line) => line.trim()).find((line) =>
    line && !/^GLES:/i.test(line) && !/^[0-9]+$/.test(line)
  ) || '';
  const egl = pickProp(props, ['ro.hardware.egl', 'ro.hardware.vulkan']);
  const opengl = parseGlesVersion(pickProp(props, ['ro.opengles.version']));
  return {
    name: renderer || kgsl || (egl && egl !== '1' ? egl : ''),
    vendor: vendor || '',
    gles: glesVersion || (opengl ? `OpenGL ES ${opengl}` : ''),
    egl
  };
}

function parseGlesVersion(value) {
  const number = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(number) || number <= 0) return '';
  return `${(number >> 16) & 0xff}.${number & 0xff}`;
}

function parseDf(stdout) {
  const disks = [];
  const seen = new Set();
  for (const line of String(stdout || '').split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const mount = parts[parts.length - 1];
    const filesystem = parts[0];
    const size = parts[1];
    const used = parts[2];
    const available = parts[3];
    const usePercent = parts[4];
    if (!/^\/(data|sdcard|storage)\b/.test(mount) && mount !== '/') continue;
    const key = `${mount}:${filesystem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    disks.push({ filesystem, size, used, available, usePercent, mount });
  }
  return disks;
}

function parseUptimeSeconds(stdout) {
  const match = String(stdout || '').trim().match(/^([\d.]+)/);
  return match ? Number.parseFloat(match[1]) : null;
}

function parseIpv4(stdout) {
  const addresses = [];
  const seen = new Set();
  const add = (iface, address) => {
    if (!address || address.startsWith('127.') || seen.has(address)) return;
    seen.add(address);
    addresses.push({ iface, address });
  };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const compact = line.match(/^(\d+):\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (compact) {
      add(compact[2].replace(/:$/, ''), compact[3]);
      continue;
    }
    const block = line.match(/inet(?: addr:)?\s*(\d+\.\d+\.\d+\.\d+)/);
    const iface = line.match(/^(\S+):/);
    if (block) add(iface ? iface[1] : '', block[1]);
  }
  return addresses;
}

function pickProp(props, keys) {
  for (const key of keys) {
    const value = props[key];
    if (value) return value;
  }
  return '';
}

function iosMarketingName(productType) {
  return formatIosMarketingName(iosHardware(productType), productType);
}

function parseBytesNumber(value) {
  const number = Number.parseInt(String(value || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(number) ? number : null;
}

function buildAndroidInfo(serial, dump) {
  const sections = splitDumpSections(dump);
  const props = parseGetprop(sections.prop || dump);
  const battery = parseBattery(sections.battery || '');
  const display = parseDisplay(sections.display || '');
  const memory = parseMeminfoKb(sections.mem || '');
  const cpuinfo = parseCpuinfo(sections.cpu || '');
  const gpu = parseGpuSection(sections.gpu || '', props);
  const disks = parseDf(sections.df || '');
  const uptime = parseUptimeSeconds(sections.uptime || '');
  const androidId = String(sections.android_id || '').trim();
  const resolved = resolveAndroidIdentity(props);
  const marketName = resolved.marketName;
  const model = resolved.model;
  const androidSpec = resolved.spec;
  const sysCores = Number.parseInt(String(sections.cores || '').trim(), 10);
  const cores = cpuinfo.cores || (Number.isFinite(sysCores) ? sysCores : 0) || (androidSpec && androidSpec.cores) || 0;
  const addresses = parseIpv4(sections.ip || '');
  const dhcpIp = pickProp(props, ['dhcp.wlan0.ipaddress', 'dhcp.eth0.ipaddress']);
  if (dhcpIp) parseIpv4(`wlan0 inet ${dhcpIp}`).forEach((item) => {
    if (!addresses.some((existing) => existing.address === item.address)) addresses.push(item);
  });

  const soc = pickProp(props, ['ro.soc.model', 'ro.soc.manufacturer'])
    ? [pickProp(props, ['ro.soc.manufacturer']), pickProp(props, ['ro.soc.model'])].filter(Boolean).join(' ')
    : pickProp(props, ['ro.chipname', 'ro.hardware.chipname', 'ro.mediatek.platform', 'ro.board.platform']);
  let cpuName = cpuinfo.model || soc || cpuinfo.hardware;
  if (androidSpec && (!cpuName || /ARMv8 Processor/i.test(cpuName))) cpuName = androidSpec.cpu || cpuName;
  const cpuDetail = cpuinfo.parts.length ? cpuinfo.parts.join(' / ') : '';
  if (androidSpec && androidSpec.gpu && (!gpu.name || /^(qcom|mali|pvr|powervr|1)$/i.test(gpu.name))) {
    gpu.name = androidSpec.gpu;
  }

  return {
    platform: 'android',
    deviceId: serial,
    identity: {
      brand: pickProp(props, ['ro.product.brand']),
      manufacturer: pickProp(props, ['ro.product.manufacturer']),
      marketName,
      model,
      device: resolved.device,
      name: resolved.name,
      serial: pickProp(props, ['ro.serialno', 'ro.boot.serialno']) || serial,
      androidId: androidId && androidId !== 'null' ? androidId : ''
    },
    system: {
      release: pickProp(props, ['ro.build.version.release']),
      sdk: pickProp(props, ['ro.build.version.sdk']),
      securityPatch: pickProp(props, ['ro.build.version.security_patch']),
      buildId: pickProp(props, ['ro.build.display.id', 'ro.build.id']),
      fingerprint: pickProp(props, ['ro.build.fingerprint']),
      type: pickProp(props, ['ro.build.type']),
      tags: pickProp(props, ['ro.build.tags']),
      incremental: pickProp(props, ['ro.build.version.incremental']),
      timezone: pickProp(props, ['persist.sys.timezone']),
      debuggable: pickProp(props, ['ro.debuggable']) === '1'
    },
    hardware: {
      model: marketName || model,
      cpu: cpuName,
      cpuDetail,
      cores,
      coresLabel: cores ? `${cores} 核` : (androidSpec && androidSpec.cores ? `${androidSpec.cores} 核` : ''),
      gpu: gpu.name,
      gpuVendor: gpu.vendor,
      gles: gpu.gles,
      soc,
      abi: pickProp(props, ['ro.product.cpu.abi']),
      abiList: pickProp(props, ['ro.product.cpu.abilist']),
      hardware: pickProp(props, ['ro.hardware']) || cpuinfo.hardware,
      board: pickProp(props, ['ro.product.board', 'ro.board.platform'])
    },
    display,
    battery,
    memory,
    disks,
    network: { addresses },
    uptime
  };
}

function buildIosInfo(udid, info, extras = {}) {
  const batteryRaw = extras.battery || {};
  const diskRaw = extras.disk || {};
  const productType = info.ProductType || '';
  const spec = iosHardware(productType);
  const ramBytes = spec && spec.ramGb ? spec.ramGb * 1024 * 1024 * 1024 : null;
  return {
    platform: 'ios',
    deviceId: udid,
    identity: {
      name: info.DeviceName || '',
      productType,
      marketingName: formatIosMarketingName(spec, productType),
      deviceClass: info.DeviceClass || '',
      udid: info.UniqueDeviceID || udid,
      serial: info.SerialNumber || '',
      imei: info.InternationalMobileEquipmentIdentity || info.InternationalMobileEquipmentIdentity2 || '',
      wifiAddress: info.WiFiAddress || '',
      bluetoothAddress: info.BluetoothAddress || '',
      ethernetAddress: info.EthernetAddress || ''
    },
    system: {
      version: info.ProductVersion || '',
      build: info.BuildVersion || '',
      hardwareModel: info.HardwareModel || '',
      cpu: (spec && spec.cpu) || info.CPUArchitecture || '',
      timezone: info.TimeZone || '',
      activationState: info.ActivationState || '',
      passwordProtected: /true/i.test(info.PasswordProtected || ''),
      deviceColor: info.DeviceColor || info.DeviceEnclosureColor || ''
    },
    hardware: {
      model: formatIosMarketingName(spec, productType) || info.DeviceName || productType,
      cpu: (spec && spec.cpu) || info.CPUArchitecture || '',
      cpuDetail: info.CPUArchitecture || '',
      cores: spec ? spec.cores : null,
      coresLabel: spec ? spec.coresLabel : '',
      gpu: spec ? spec.gpu : '',
      ramGb: spec ? spec.ramGb : null,
      architecture: info.CPUArchitecture || ''
    },
    radio: {
      baseband: info.BasebandVersion || '',
      phoneNumber: info.PhoneNumber || '',
      meid: info.MobileEquipmentIdentifier || ''
    },
    battery: {
      level: Number.isFinite(Number.parseFloat(batteryRaw.BatteryCurrentCapacity))
        ? Number.parseFloat(batteryRaw.BatteryCurrentCapacity)
        : null,
      charging: /true/i.test(batteryRaw.BatteryIsCharging || ''),
      externalConnected: /true/i.test(batteryRaw.ExternalConnected || '')
    },
    memory: ramBytes ? {
      total: ramBytes,
      available: null,
      used: null,
      usagePercent: null,
      nominalGb: spec.ramGb,
      estimated: true
    } : null,
    storage: {
      total: parseBytesNumber(diskRaw.TotalDiskCapacity),
      data: parseBytesNumber(diskRaw.TotalDataCapacity),
      dataAvailable: parseBytesNumber(diskRaw.TotalDataAvailable || diskRaw.AmountDataAvailable)
    }
  };
}

function createPhoneDeviceInfo({ runTool }) {
  if (typeof runTool !== 'function') {
    throw new Error('createPhoneDeviceInfo 需要 runTool');
  }

  async function getAndroidInfo(deviceId) {
    const serial = normalizeDeviceId(deviceId);
    if (!serial) throw new Error('未选择 Android 设备');
    const { stdout } = await runTool('adb', adbArgs(serial, ['shell', ANDROID_DUMP_SCRIPT]), {
      timeout: 25000,
      maxBuffer: 8 * 1024 * 1024
    });
    return buildAndroidInfo(serial, stdout);
  }

  async function getIosDomain(udid, domain) {
    try {
      const { stdout } = await runTool('ideviceinfo', ['-u', udid, '-q', domain], {
        timeout: 8000,
        maxBuffer: 1024 * 1024
      });
      return parseColonMap(stdout);
    } catch (_) {
      return {};
    }
  }

  async function getIosInfo(deviceId) {
    const udid = normalizeDeviceId(deviceId);
    if (!udid) throw new Error('未选择 iOS 设备');
    const { stdout } = await runTool('ideviceinfo', ['-u', udid], {
      timeout: 12000,
      maxBuffer: 2 * 1024 * 1024
    });
    const info = parseColonMap(stdout);
    const [battery, disk] = await Promise.all([
      getIosDomain(udid, 'com.apple.mobile.battery'),
      getIosDomain(udid, 'com.apple.disk_usage')
    ]);
    return buildIosInfo(udid, info, { battery, disk });
  }

  async function getInfo(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    const deviceId = normalizeDeviceId(payload.deviceId || payload.id || payload);
    if (!deviceId) throw new Error('未选择设备');
    return platform === 'ios' ? getIosInfo(deviceId) : getAndroidInfo(deviceId);
  }

  return { getInfo };
}

module.exports = {
  createPhoneDeviceInfo,
  helpers: {
    parseGetprop,
    parseColonMap,
    splitDumpSections,
    parseBattery,
    parseDisplay,
    parseMeminfoKb,
    parseCpuinfo,
    parseGpuSection,
    parseDf,
    parseUptimeSeconds,
    parseIpv4,
    iosMarketingName,
    iosHardware,
    nominalRamGb,
    buildAndroidInfo,
    buildIosInfo,
    ANDROID_DUMP_SCRIPT
  }
};
