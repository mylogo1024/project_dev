'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { helpers } = require('./device-files');
const {
  runIdeviceinstaller,
  uninstallArgSets,
  listXmlArgSets,
  listAllArgSets,
  listArgSets
} = require('./ideviceinstaller');

const { adbArgs, adbShellArgv, normalizeDeviceId, posixShellQuote, parseInstalledApps } = helpers;

function parsePackageSet(stdout) {
  const set = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^package:(\S+)/);
    if (match) set.add(match[1]);
  }
  return set;
}

function parseDumpsysTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    if (ms > 0) return new Date(ms).toISOString();
  }
  return text;
}

function parseSdkLine(line) {
  const minSdk = (String(line || '').match(/minSdk=(\d+)/) || [])[1] || '';
  const targetSdk = (String(line || '').match(/targetSdk=(\d+)/) || [])[1] || '';
  const versionCode = (String(line || '').match(/^(\d+)/) || [])[1] || '';
  return { minSdk, targetSdk, versionCode };
}

function normalizeDigest(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

function formatDigest(value, separator = ':') {
  const hex = normalizeDigest(value);
  if (!hex) return '';
  return hex.match(/.{1,2}/g).join(separator);
}

function formatMd5Fingerprint(value) {
  const hex = normalizeDigest(value);
  if (hex.length < 32) return '';
  return hex.slice(0, 32);
}

function pickDigest(chunk, names, formatter = formatDigest) {
  const text = String(chunk || '');
  for (const name of names) {
    const match = text.match(new RegExp(`${name}\\s*(?:digest|fingerprint)?\\s*:\\s*([0-9A-Fa-f][0-9A-Fa-f: ]*)`, 'i'));
    if (match) return formatter(match[1]);
  }
  return '';
}

function parseSigningDigests(chunk) {
  return {
    sha1: pickDigest(chunk, ['SHA-1', 'SHA1']),
    md5: pickDigest(chunk, ['MD5'], formatMd5Fingerprint),
    sha256: pickDigest(chunk, ['SHA-256', 'SHA256'])
  };
}

function md5OfDer(der) {
  if (!der || !der.length) return '';
  return formatMd5Fingerprint(crypto.createHash('md5').update(der).digest('hex'));
}

function extractX509FromPkcs7(buffer) {
  const data = Buffer.from(buffer || []);
  let best = null;
  for (let i = 0; i < data.length - 4; i += 1) {
    if (data[i] !== 0x30 || data[i + 1] !== 0x82) continue;
    const length = data.readUInt16BE(i + 2);
    const total = 4 + length;
    if (total < 256 || i + total > data.length) continue;
    const slice = data.subarray(i, i + total);
    const looksLikeCert = slice.includes(Buffer.from([0x06, 0x03, 0x55, 0x04]))
      || slice.includes(Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01]));
    if (looksLikeCert && (!best || slice.length > best.length)) best = slice;
  }
  return best;
}

async function md5FromApkZip(zip) {
  const names = Object.keys(zip.files || {}).filter((name) => (
    /^META-INF\/.+\.(RSA|DSA|EC)$/i.test(name) && !zip.files[name].dir
  ));
  for (const name of names) {
    const bytes = await zip.files[name].async('nodebuffer');
    const md5 = md5OfDer(extractX509FromPkcs7(bytes));
    if (md5) return md5;
  }
  return '';
}

function parseKeytoolCerts(stdout) {
  return parseSigningDigests(stdout);
}

function abiBitness(abi) {
  if (!abi || abi === 'null') return null;
  return /64/.test(abi) ? 64 : 32;
}

function soArchLabel(primary, secondary) {
  return [primary, secondary].filter((item) => item && item !== 'null').join(' / ');
}

function abiFromLibDir(dir) {
  const match = String(dir || '').match(/\/lib\/([^/]+)\/?$/);
  return match ? match[1] : '';
}

function parseNativeCode(badging) {
  const line = String(badging || '').match(/native-code:\s*(.+)/);
  if (!line) return [];
  return [...line[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).filter(Boolean);
}

function parseAaptTargetSdk(badging) {
  const match = String(badging || '').match(/targetSdkVersion:'(\d+)'/);
  return match ? match[1] : '';
}

function parseDeviceProfile(stdout) {
  const map = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    map[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const blob = `${map.qemu || ''} ${map.hw || ''} ${map.model || ''} ${map.device || ''}`.toLowerCase();
  const emulator = map.qemu === '1' || /goldfish|ranchu|vbox|emulator|sdk_gphone|google_sdk|vsoc/.test(blob);
  const bitness = map.abi64 || /64/.test(map.abi || '') ? 64 : 32;
  return {
    kind: emulator ? 'emulator' : 'device',
    kindLabel: emulator ? '模拟器' : '真机',
    bitness,
    abi: map.abi || '',
    abiList: map.abilist || map.abi || ''
  };
}

function parseDumpsysPackages(stdout) {
  const apps = [];
  const chunks = String(stdout || '').split(/^\s*Package \[/m);
  for (const chunk of chunks.slice(1)) {
    const header = chunk.match(/^([^\]]+)\]/);
    if (!header) continue;
    const packageName = header[1].trim();
    if (!packageName) continue;
    const field = (key) => {
      const match = chunk.match(new RegExp(`^\\s*${key}=(.*)$`, 'm'));
      return match ? match[1].trim() : '';
    };
    const flags = `${field('flags')} ${field('pkgFlags')} ${field('privateFlags')}`;
    const sdk = parseSdkLine(field('versionCode'));
    const codePath = field('codePath') || field('resourcePath');
    const nativeLibDir = field('nativeLibraryDir') || field('legacyNativeLibraryDir');
    let primaryAbi = field('primaryCpuAbi');
    const secondaryAbi = field('secondaryCpuAbi');
    if (!primaryAbi || primaryAbi === 'null') {
      const fromDir = abiFromLibDir(nativeLibDir);
      if (fromDir) primaryAbi = fromDir;
    }
    const certs = parseSigningDigests(chunk);
    const isSystem = /\bSYSTEM\b/.test(flags) || /^\/(system|product|vendor|apex|odm)\b/.test(codePath);
    const appBits = abiBitness(primaryAbi) || abiBitness(secondaryAbi);
    apps.push({
      packageName,
      label: '',
      versionName: field('versionName') || '',
      versionCode: sdk.versionCode,
      minSdk: sdk.minSdk,
      targetSdk: sdk.targetSdk,
      apkPath: apkFilePath(codePath) || codePath,
      codePath,
      nativeLibDir,
      primaryAbi,
      secondaryAbi,
      soArch: soArchLabel(primaryAbi, secondaryAbi),
      appBitness: appBits,
      dataDir: field('dataDir'),
      uid: field('userId') || field('appId'),
      installer: field('installerPackageName'),
      firstInstallTime: parseDumpsysTime(field('firstInstallTime')),
      lastUpdateTime: parseDumpsysTime(field('lastUpdateTime')),
      enabled: !/enabled=false/i.test(chunk.slice(0, 800)),
      isSystem,
      sha1: certs.sha1,
      md5: certs.md5,
      sha256: certs.sha256,
      apkSize: 0,
      cacheSize: 0,
      dataSize: 0
    });
  }
  return apps;
}

function parseDuMap(stdout) {
  const map = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\/\S+)/);
    if (!match) continue;
    map[match[2].replace(/\/+$/, '')] = Number(match[1]) * 1024;
  }
  return map;
}

function parseIosAppXml(xml) {
  const apps = [];
  const dicts = String(xml || '').split(/<dict>/i).slice(1);
  for (const dict of dicts) {
    const value = (key) => {
      const match = dict.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'i'));
      return match ? match[1].trim() : '';
    };
    const bundleId = value('CFBundleIdentifier');
    if (!bundleId) continue;
    const capabilities = (() => {
      const arrayMatch = dict.match(/<key>UIRequiredDeviceCapabilities<\/key>\s*<array>([\s\S]*?)<\/array>/i);
      if (arrayMatch) {
        return [...arrayMatch[1].matchAll(/<string>([^<]*)<\/string>/gi)]
          .map((match) => match[1].trim())
          .filter(Boolean)
          .join(' / ');
      }
      return value('UIRequiredDeviceCapabilities');
    })();
    apps.push({
      packageName: bundleId,
      label: value('CFBundleDisplayName') || value('CFBundleName') || bundleId,
      versionName: value('CFBundleShortVersionString') || value('CFBundleVersion'),
      versionCode: value('CFBundleVersion'),
      targetSdk: value('MinimumOSVersion') || value('DTPlatformVersion'),
      apkPath: value('Path') || value('Container') || '',
      soArch: capabilities,
      appBitness: /64/.test(capabilities) ? 64 : (capabilities ? 32 : null),
      sha1: '',
      md5: '',
      isSystem: false,
      apkSize: 0,
      cacheSize: 0,
      dataSize: 0,
      firstInstallTime: '',
      lastUpdateTime: ''
    });
  }
  return apps;
}

function parseIosDashApps(stdout) {
  return parseInstalledApps(stdout).map((app) => {
    const leftover = String(app.name || '').replace(/"/g, '').trim();
    const versionMatch = leftover.match(/^(.*?)\s+([\d][\w.-]*)$/);
    const label = (versionMatch ? versionMatch[1] : leftover).trim();
    const versionName = versionMatch ? versionMatch[2] : '';
    return {
      packageName: app.bundleId,
      label: label || app.bundleId,
      versionName,
      versionCode: versionName,
      isSystem: false,
      apkSize: 0,
      cacheSize: 0,
      dataSize: 0,
      targetSdk: '',
      apkPath: '',
      soArch: '',
      appBitness: null,
      sha1: '',
      md5: '',
      firstInstallTime: '',
      lastUpdateTime: ''
    };
  });
}

function pickApkIconPath(badging) {
  const icons = [...String(badging || '').matchAll(/application-icon-(\d+):'([^']+)'/g)]
    .map((match) => ({ density: Number(match[1]), path: match[2] }))
    .filter((item) => /\.(png|webp|jpg)$/i.test(item.path))
    .sort((a, b) => b.density - a.density);
  return (icons[0] && icons[0].path) || '';
}

function parseApkLabel(badging) {
  const match = String(badging || '').match(/application-label(?:-zh)?(?:-CN)?:'([^']+)'/)
    || String(badging || '').match(/application-label:'([^']+)'/);
  return match ? match[1] : '';
}

function apkFilePath(codePath) {
  const remote = String(codePath || '').trim();
  if (!remote) return '';
  if (/\.apk$/i.test(remote)) return remote;
  return `${remote.replace(/\/+$/, '')}/base.apk`;
}

function createDeviceApps({ runTool, deviceFiles }) {
  if (typeof runTool !== 'function') throw new Error('createDeviceApps 需要 runTool');

  async function runAdb(deviceId, args, options = {}) {
    return runTool('adb', adbArgs(deviceId, args), {
      timeout: options.timeout || 20000,
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024
    });
  }

  async function shell(deviceId, command, options = {}) {
    const serial = normalizeDeviceId(deviceId);
    if (!serial) throw new Error('未选择设备');
    if (options.root && deviceFiles && typeof deviceFiles.probeAndroidRoot === 'function') {
      const probed = await deviceFiles.probeAndroidRoot(serial);
      if (probed.rooted && probed.prefix) {
        return runAdb(serial, adbShellArgv(command, probed), options);
      }
    }
    return runAdb(serial, ['shell', command], options);
  }

  async function dumpBadging(apkPath) {
    try {
      return await runTool('aapt', ['dump', 'badging', apkPath], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      try {
        return await runTool('aapt2', ['dump', 'badging', apkPath], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      } catch (_) {
        throw error;
      }
    }
  }

  async function listAndroid(deviceId) {
    const serial = normalizeDeviceId(deviceId);
    const root = deviceFiles && typeof deviceFiles.probeAndroidRoot === 'function'
      ? await deviceFiles.probeAndroidRoot(serial)
      : { rooted: false };
    const [dump, thirdParty, androidId, profileRaw] = await Promise.all([
      shell(serial, 'dumpsys package', { timeout: 45000, maxBuffer: 32 * 1024 * 1024 }),
      shell(serial, 'pm list packages -3', { timeout: 15000 }),
      shell(serial, 'settings get secure android_id', { timeout: 8000 }),
      shell(serial, [
        'printf',
        "'qemu=%s\\nhw=%s\\nmodel=%s\\ndevice=%s\\nabi=%s\\nabi64=%s\\nabilist=%s\\n'",
        '"$(getprop ro.kernel.qemu)"',
        '"$(getprop ro.hardware)"',
        '"$(getprop ro.product.model)"',
        '"$(getprop ro.product.device)"',
        '"$(getprop ro.product.cpu.abi)"',
        '"$(getprop ro.product.cpu.abilist64)"',
        '"$(getprop ro.product.cpu.abilist)"'
      ].join(' '), { timeout: 8000 })
    ]);
    const profile = parseDeviceProfile(profileRaw.stdout);
    const userPackages = parsePackageSet(thirdParty.stdout);
    const apps = parseDumpsysPackages(dump.stdout).map((app) => ({
      ...app,
      isSystem: app.isSystem && !userPackages.has(app.packageName),
      isUser: userPackages.has(app.packageName),
      canUninstall: userPackages.has(app.packageName),
      canClearData: true,
      canClearCache: Boolean(root.rooted),
      deviceKind: profile.kind,
      deviceKindLabel: profile.kindLabel,
      deviceBitness: profile.bitness,
      appBitness: app.appBitness || profile.bitness
    }));

    if (root.rooted) {
      try {
        const [dataDu, cacheDu] = await Promise.all([
          shell(serial, 'du -sk /data/data/* 2>/dev/null', { root: true, timeout: 25000 }),
          shell(serial, 'du -sk /data/data/*/cache /data/data/*/code_cache 2>/dev/null', { root: true, timeout: 25000 })
        ]);
        const dataMap = parseDuMap(dataDu.stdout);
        const cacheMap = parseDuMap(cacheDu.stdout);
        for (const app of apps) {
          const dataDir = `/data/data/${app.packageName}`;
          const cache = (cacheMap[`${dataDir}/cache`] || 0) + (cacheMap[`${dataDir}/code_cache`] || 0);
          app.cacheSize = cache;
          app.dataSize = Math.max(0, (dataMap[dataDir] || 0) - cache);
        }
      } catch (_) {
        // 无 root 或 du 失败时仍返回基本信息
      }
    }

    const sizeTargets = apps.filter((app) => app.isUser && app.apkPath).slice(0, 80);
    if (sizeTargets.length) {
      const script = sizeTargets.map((app) => {
        const remote = posixShellQuote(apkFilePath(app.apkPath));
        return `echo ${posixShellQuote(app.packageName)} $(stat -c %s ${remote} 2>/dev/null || echo 0)`;
      }).join('; ');
      try {
        const { stdout } = await shell(serial, script, { timeout: 20000 });
        const sizes = {};
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const match = line.trim().match(/^(\S+)\s+(\d+)$/);
          if (match) sizes[match[1]] = Number(match[2]);
        }
        for (const app of apps) {
          if (sizes[app.packageName]) app.apkSize = sizes[app.packageName];
        }
      } catch (_) {
        // ignore size failures
      }
    }

    apps.sort((a, b) => Number(b.isUser) - Number(a.isUser) || String(a.label || a.packageName).localeCompare(String(b.label || b.packageName)));
    return {
      platform: 'android',
      androidId: String(androidId.stdout || '').trim(),
      privilege: root.rooted ? 'root' : 'shell',
      deviceKind: profile.kind,
      deviceKindLabel: profile.kindLabel,
      deviceBitness: profile.bitness,
      deviceAbi: profile.abiList || profile.abi,
      apps
    };
  }

  async function listIos(deviceId) {
    const udid = normalizeDeviceId(deviceId);
    if (!udid) throw new Error('未选择 iOS 设备');
    let apps = [];
    try {
      const { stdout } = await runIdeviceinstaller(runTool, listXmlArgSets(udid), {
        timeout: 25000,
        maxBuffer: 8 * 1024 * 1024
      });
      apps = parseIosAppXml(stdout);
    } catch (_) {
      try {
        const { stdout } = await runIdeviceinstaller(runTool, listAllArgSets(udid), {
          timeout: 25000,
          maxBuffer: 8 * 1024 * 1024
        });
        apps = parseIosDashApps(stdout);
      } catch (__) {
        // 再试默认 list
      }
    }
    if (apps.length === 0) {
      const { stdout } = await runIdeviceinstaller(runTool, listArgSets(udid), {
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024
      });
      apps = parseIosDashApps(stdout);
    }
    let cpuArch = '';
    try {
      const { stdout } = await runTool('ideviceinfo', ['-u', udid, '-k', 'CPUArchitecture'], { timeout: 8000 });
      cpuArch = String(stdout || '').trim();
    } catch (_) {
      // 没有 ideviceinfo 时仍返回应用列表
    }
    const deviceBitness = /64/.test(cpuArch) ? 64 : (cpuArch ? 32 : 64);
    return {
      platform: 'ios',
      androidId: '',
      privilege: 'afc',
      deviceKind: 'device',
      deviceKindLabel: '真机',
      deviceBitness,
      deviceAbi: cpuArch,
      apps: apps.map((app) => ({
        ...app,
        isUser: true,
        canUninstall: true,
        canClearData: false,
        canClearCache: false,
        soArch: app.soArch || cpuArch,
        appBitness: app.appBitness || deviceBitness,
        deviceKind: 'device',
        deviceKindLabel: '真机',
        deviceBitness
      }))
    };
  }

  async function listApps(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    const deviceId = normalizeDeviceId(payload.deviceId || payload.id);
    if (!deviceId) throw new Error('未选择设备');
    return platform === 'ios' ? listIos(deviceId) : listAndroid(deviceId);
  }

  async function getAndroidIcon(deviceId, packageName, apkPath) {
    const remote = apkFilePath(apkPath);
    if (!remote) throw new Error('找不到 APK 路径');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'device-app-'));
    const localApk = path.join(tmpDir, 'base.apk');
    try {
      await runAdb(deviceId, ['pull', remote, localApk], { timeout: 60000 });
      const { stdout } = await dumpBadging(localApk);
      const label = parseApkLabel(stdout);
      const natives = parseNativeCode(stdout);
      const soArch = natives.join(' / ');
      const appBitness = natives.some((abi) => /64/.test(abi)) ? 64 : (natives.length ? 32 : null);
      const targetSdk = parseAaptTargetSdk(stdout);
      const iconPath = pickApkIconPath(stdout);
      let sha1 = '';
      let md5 = '';
      let sha256 = '';
      const buffer = await fs.promises.readFile(localApk);
      const zip = await JSZip.loadAsync(buffer);
      try {
        const cert = await runTool('keytool', ['-printcert', '-jarfile', localApk], { timeout: 30000 });
        const parsed = parseKeytoolCerts(`${cert.stdout || ''}\n${cert.stderr || ''}`);
        sha1 = parsed.sha1;
        md5 = parsed.md5;
        sha256 = parsed.sha256;
      } catch (_) {
        // 没有 Java/keytool 时仍返回 icon 和 ABI
      }
      if (!md5) {
        md5 = await md5FromApkZip(zip);
      }
      let iconDataUrl = '';
      if (iconPath) {
        const file = zip.file(iconPath) || zip.file(iconPath.replace(/^\/+/, ''));
        if (file) {
          const bytes = await file.async('nodebuffer');
          const mime = iconPath.endsWith('.webp') ? 'image/webp' : 'image/png';
          iconDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        }
      }
      return { packageName, label, iconDataUrl, soArch, appBitness, targetSdk, sha1, md5, sha256 };
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function getAppIcon(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    if (platform === 'ios') {
      return { packageName: payload.packageName, label: '', iconDataUrl: '' };
    }
    return getAndroidIcon(payload.deviceId, payload.packageName, payload.apkPath);
  }

  async function uninstallApp(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    const deviceId = normalizeDeviceId(payload.deviceId);
    const packageName = String(payload.packageName || '').trim();
    if (!deviceId || !packageName) throw new Error('缺少设备或包名');
    if (platform === 'ios') {
      await runIdeviceinstaller(runTool, uninstallArgSets(deviceId, packageName), { timeout: 120000 });
      return { success: true };
    }
    const { stdout, stderr } = await runAdb(deviceId, ['uninstall', packageName], { timeout: 120000 });
    const text = `${stdout || ''}\n${stderr || ''}`;
    if (/Failure|error/i.test(text) && !/Success/i.test(text)) throw new Error(text.trim() || '卸载失败');
    return { success: true };
  }

  async function clearAppCache(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    if (platform === 'ios') throw new Error('未越狱 iOS 不能按应用清除缓存');
    const deviceId = normalizeDeviceId(payload.deviceId);
    const packageName = String(payload.packageName || '').trim();
    const probed = await deviceFiles.probeAndroidRoot(deviceId);
    if (!probed.rooted) throw new Error('需要 root（su）才能只删除缓存。无 root 请用「清除数据」。');
    const dir = `/data/data/${packageName}`;
    await shell(deviceId, `rm -rf -- ${posixShellQuote(`${dir}/cache`)} ${posixShellQuote(`${dir}/code_cache`)}`, {
      root: true,
      timeout: 30000
    });
    return { success: true };
  }

  async function clearAppData(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    if (platform === 'ios') throw new Error('未越狱 iOS 不能清除应用数据');
    const deviceId = normalizeDeviceId(payload.deviceId);
    const packageName = String(payload.packageName || '').trim();
    const { stdout, stderr } = await shell(deviceId, `pm clear -- ${posixShellQuote(packageName)}`, { timeout: 30000 });
    const text = `${stdout || ''}\n${stderr || ''}`;
    if (!/Success/i.test(text)) {
      const retry = await shell(deviceId, `pm clear ${packageName}`, { timeout: 30000 });
      const retryText = `${retry.stdout || ''}\n${retry.stderr || ''}`;
      if (!/Success/i.test(retryText)) throw new Error(retryText.trim() || text.trim() || '清除数据失败');
    }
    return { success: true };
  }

  async function exportApp(payload = {}) {
    const platform = payload.platform === 'ios' ? 'ios' : 'android';
    const deviceId = normalizeDeviceId(payload.deviceId);
    const localPath = String(payload.localPath || '').trim();
    if (!deviceId) throw new Error('未选择设备');
    if (!localPath || !path.isAbsolute(localPath)) throw new Error('请选择要保存的本地路径');
    if (platform === 'ios') {
      throw new Error('未越狱 iOS 无法从设备导出 IPA。请用电脑上的安装包。');
    }
    const remote = apkFilePath(payload.apkPath || '');
    if (!remote) throw new Error('找不到 APK 路径，无法导出');
    await deviceFiles.pullFile({
      platform: 'android',
      deviceId,
      remotePath: remote,
      localPath
    });
    return { success: true, localPath, remotePath: remote };
  }

  return {
    listApps,
    getAppIcon,
    uninstallApp,
    exportApp,
    clearAppCache,
    clearAppData
  };
}

module.exports = {
  createDeviceApps,
  helpers: {
    parsePackageSet,
    parseDumpsysPackages,
    parseDuMap,
    parseIosAppXml,
    parseIosDashApps,
    pickApkIconPath,
    parseApkLabel,
    parseNativeCode,
    parseAaptTargetSdk,
    parseDeviceProfile,
    parseSigningDigests,
    parseKeytoolCerts,
    formatMd5Fingerprint,
    extractX509FromPkcs7,
    apkFilePath
  }
};
