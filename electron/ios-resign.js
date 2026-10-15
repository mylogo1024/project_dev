'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const execFilePromise = util.promisify(execFile);

const { openZip } = require('./pkginfo/zip');

function run(command, args, options = {}) {
  return execFilePromise(command, args, {
    timeout: options.timeout || 30000,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env || process.env
  });
}

/**
 * 解析系统自带工具的真实路径。
 *
 * 从 Finder / 桌面图标启动的 Electron 应用继承的是极窄的 PATH，`security`、
 * `codesign` 这些工具未必可见，因此先查 PATH，再回落到系统标准目录。
 * 结果会缓存，避免每次都扫盘。
 */
const SYSTEM_TOOL_CACHE = new Map();
const SYSTEM_TOOL_FALLBACK_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function resolveSystemTool(name) {
  if (SYSTEM_TOOL_CACHE.has(name)) return SYSTEM_TOOL_CACHE.get(name);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .concat(SYSTEM_TOOL_FALLBACK_DIRS);

  let resolved = name;
  let found = false;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        resolved = candidate;
        found = true;
        break;
      } catch (_) {
        // 继续尝试下一个候选
      }
    }
    if (found) break;
  }

  SYSTEM_TOOL_CACHE.set(name, resolved);
  return resolved;
}

function decodePlistXmlText(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractPlistXmlSlice(xml, key) {
  const keyTag = `<key>${key}</key>`;
  const idx = xml.indexOf(keyTag);
  if (idx < 0) return '';
  return xml.slice(idx + keyTag.length).trimStart();
}

function extractPlistXmlValue(xml, key) {
  const rest = extractPlistXmlSlice(xml, key);
  if (!rest) return '';
  const stringMatch = rest.match(/^<string>([\s\S]*?)<\/string>/);
  if (stringMatch) return decodePlistXmlText(stringMatch[1]);
  const arrayMatch = rest.match(/^<array>([\s\S]*?)<\/array>/);
  if (arrayMatch) {
    return [...arrayMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((item) => decodePlistXmlText(item[1]));
  }
  if (/^<true\s*\/>/.test(rest)) return true;
  if (/^<false\s*\/>/.test(rest)) return false;
  return '';
}

function extractPlistXmlDict(xml, key) {
  const rest = extractPlistXmlSlice(xml, key);
  if (!rest.startsWith('<dict>')) return '';
  let depth = 0;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest.startsWith('<dict>', index)) {
      depth += 1;
      index += 5;
      continue;
    }
    if (rest.startsWith('</dict>', index)) {
      depth -= 1;
      if (depth === 0) return rest.slice(0, index + 7);
      index += 6;
    }
  }
  return '';
}

function bundleIdFromApplicationId(appId) {
  const value = String(appId || '');
  const dot = value.indexOf('.');
  return dot >= 0 ? value.slice(dot + 1) : value;
}

function profileAllowsBundle(appId, bundleId) {
  const suffix = bundleIdFromApplicationId(appId);
  if (!suffix || suffix === '*') return true;
  if (suffix.endsWith('.*')) {
    const prefix = suffix.slice(0, -2);
    return bundleId === prefix || bundleId.startsWith(`${prefix}.`);
  }
  return bundleId === suffix;
}

function parseIdentityLines(stdout) {
  return String(stdout || '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*\d+\)\s+([A-F0-9]+)\s+"(.+)"\s*$/i);
    if (!match) return [];
    return [{ hash: match[1], name: match[2], label: `${match[2]}` }];
  });
}

async function listCodeSignIdentities(keychain) {
  const args = ['find-identity', '-v', '-p', 'codesigning'];
  if (keychain) args.push(keychain);
  try {
    const { stdout } = await run(resolveSystemTool('security'), args, { timeout: 15000 });
    return parseIdentityLines(stdout);
  } catch (_) {
    return [];
  }
}

async function decodeProvisionFile(provisionPath) {
  const { stdout } = await run(resolveSystemTool('security'), ['cms', '-D', '-i', provisionPath], {
    timeout: 20000
  });
  const xml = String(stdout || '');
  const entitlements = extractPlistXmlDict(xml, 'Entitlements');
  const appId = extractPlistXmlValue(entitlements, 'application-identifier');
  return {
    xml,
    entitlementsXml: entitlements,
    name: extractPlistXmlValue(xml, 'Name') || '',
    teamName: extractPlistXmlValue(xml, 'TeamName') || '',
    teamId: [].concat(extractPlistXmlValue(xml, 'TeamIdentifier') || []).filter(Boolean)[0] || '',
    uuid: extractPlistXmlValue(xml, 'UUID') || '',
    expiration: extractPlistXmlValue(xml, 'ExpirationDate') || '',
    applicationId: appId || '',
    bundleId: bundleIdFromApplicationId(appId),
    // 设备列表：企业/App Store 描述文件没有这个键，此时装到哪台都行
    provisionedDevices: [].concat(extractPlistXmlValue(xml, 'ProvisionedDevices') || []).filter(Boolean)
  };
}

function writeEntitlementsPlist(entitlementsDictXml, destPath) {
  if (!entitlementsDictXml) throw new Error('描述文件中没有 Entitlements');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${entitlementsDictXml}
</plist>
`;
  fs.writeFileSync(destPath, body);
}

async function setPlistString(plistPath, key, value) {
  if (!value) return;
  try {
    await run(resolveSystemTool('plutil'), ['-replace', key, '-string', value, plistPath]);
  } catch (_) {
    await run(resolveSystemTool('plutil'), ['-insert', key, '-string', value, plistPath]);
  }
}

async function readPlistString(plistPath, key) {
  try {
    const { stdout } = await run(resolveSystemTool('plutil'), ['-extract', key, 'raw', '-o', '-', plistPath]);
    return String(stdout || '').trim();
  } catch (_) {
    return '';
  }
}

function collectSignTargets(appPath) {
  const targets = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const isBundle = /\.(framework|appex|app|xctest)$/i.test(entry.name);
        visit(full);
        if (isBundle) targets.push(full);
      } else if (/\.dylib$/i.test(entry.name)) {
        targets.push(full);
      }
    }
  };
  visit(appPath);
  targets.push(appPath);
  return [...new Set(targets)];
}

async function rewriteNestedBundleIds(appPath, oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  const visit = async (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (/\.(appex|app)$/i.test(entry.name)) {
        const info = path.join(full, 'Info.plist');
        if (fs.existsSync(info)) {
          const current = await readPlistString(info, 'CFBundleIdentifier');
          if (current === oldId || current.startsWith(`${oldId}.`)) {
            await setPlistString(info, 'CFBundleIdentifier', newId + current.slice(oldId.length));
          }
        }
      }
      await visit(full);
    }
  };
  await visit(appPath);
}

async function withOptionalP12(p12Path, p12Password, fn) {
  if (!p12Path) return fn({ keychain: null, identities: await listCodeSignIdentities() });

  const keychain = path.join(os.tmpdir(), `ios-resign-${crypto.randomBytes(6).toString('hex')}.keychain-db`);
  const pass = crypto.randomBytes(16).toString('hex');
  await run(resolveSystemTool('security'), ['create-keychain', '-p', pass, keychain]);
  try {
    await run(resolveSystemTool('security'), ['set-keychain-settings', '-lut', '7200', keychain]);
    await run(resolveSystemTool('security'), ['unlock-keychain', '-p', pass, keychain]);
    await run(resolveSystemTool('security'), [
      'import', p12Path, '-k', keychain, '-P', String(p12Password || ''),
      '-A', '-T', resolveSystemTool('codesign'), '-T', resolveSystemTool('security')
    ], { timeout: 30000 });
    try {
      await run(resolveSystemTool('security'), [
        'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', pass, keychain
      ]);
    } catch (_) { /* 设置 key 分区失败不致命，紧接着会校验身份列表 */ }
    const identities = await listCodeSignIdentities(keychain);
    if (!identities.length) throw new Error('p12 证书中没有可用的代码签名身份');
    return fn({ keychain, identities });
  } finally {
    try { await run(resolveSystemTool('security'), ['delete-keychain', keychain]); } catch (_) { /* 临时钥匙串删不掉不影响重签名结果 */ }
    try { fs.unlinkSync(keychain); } catch (_) { /* 同上，临时文件清理失败不影响结果 */ }
  }
}

function findAppBundle(workDir) {
  const payload = path.join(workDir, 'Payload');
  if (!fs.existsSync(payload)) throw new Error('IPA 中没有 Payload 目录');
  const apps = fs.readdirSync(payload).filter((name) => name.endsWith('.app'));
  if (!apps.length) throw new Error('IPA 中没有 .app 包');
  return path.join(payload, apps[0]);
}

async function inspectProvision(provisionPath) {
  if (!provisionPath || !fs.existsSync(provisionPath)) throw new Error('请选择配置文件（.mobileprovision）');
  const info = await decodeProvisionFile(provisionPath);
  return {
    name: info.name,
    teamName: info.teamName,
    teamId: info.teamId,
    uuid: info.uuid,
    expiration: info.expiration,
    applicationId: info.applicationId,
    bundleId: info.bundleId.includes('*') ? '' : info.bundleId
  };
}

/**
 * 从 IPA 里读出「签名相关的事实」—— **不解压整包**，只读两个小文件。
 *
 * 用途：安装失败时给出**具体**原因，而不是笼统的「签名校验未通过」。
 * 实测最常见的一种是**装错包了**：原包用的描述文件里没有这台设备，
 * 而重签名产物用的是自己的描述文件（含这台设备）。两者文件名只差一个 `-resigned`，
 * 极易选错，报错却完全看不出是这个原因。
 *
 * @param {string} deviceId 目标设备 UDID；给了才能判断「描述文件含不含这台设备」
 */
async function inspectIpaSignature(ipaPath, deviceId = '') {
  if (!fs.existsSync(ipaPath)) throw new Error('IPA 文件不存在');
  const archive = openZip(ipaPath);
  let tempProfile = null;
  try {
    const provEntry = archive.match(/^Payload\/[^/]+\.app\/embedded\.mobileprovision$/)[0];
    if (!provEntry) {
      return { available: false, reason: '这个包里没有 embedded.mobileprovision，说明它没有被签名过' };
    }

    // 描述文件是 CMS 包裹的二进制，必须落盘再交给 security cms 解
    tempProfile = path.join(os.tmpdir(), `ipa-prov-${crypto.randomBytes(6).toString('hex')}.mobileprovision`);
    fs.writeFileSync(tempProfile, archive.readEntryRaw(provEntry));
    const provision = await decodeProvisionFile(tempProfile);

    const infoEntry = archive.match(/^Payload\/[^/]+\.app\/Info\.plist$/)[0];
    let appBundleId = '';
    if (infoEntry) {
      const tempInfo = path.join(os.tmpdir(), `ipa-info-${crypto.randomBytes(6).toString('hex')}.plist`);
      try {
        fs.writeFileSync(tempInfo, archive.readEntryRaw(infoEntry));
        appBundleId = await readPlistString(tempInfo, 'CFBundleIdentifier');
      } finally {
        try { fs.unlinkSync(tempInfo); } catch (_) { /* 临时文件删不掉不影响结论 */ }
      }
    }

    const devices = provision.provisionedDevices;
    const hasDeviceList = devices.length > 0;
    const deviceIncluded = hasDeviceList && deviceId ? devices.includes(deviceId) : null;
    const bundleIdMatches = appBundleId && provision.bundleId
      ? profileAllowsBundle(provision.applicationId, appBundleId)
      : null;

    return {
      available: true,
      appBundleId,
      profileName: provision.name,
      teamId: provision.teamId,
      applicationId: provision.applicationId,
      expiration: provision.expiration,
      deviceCount: devices.length,
      hasDeviceList,
      deviceIncluded,
      bundleIdMatches
    };
  } finally {
    archive.close();
    if (tempProfile) {
      try { fs.unlinkSync(tempProfile); } catch (_) { /* 同上 */ }
    }
  }
}

/**
 * 把 `inspectIpaSignature` 的结果说成人话 —— 安装失败时最需要这一句。
 * @returns {string} 空串表示「没查出确切原因」，调用方保留原有文案
 */
function describeIpaSignature(signature) {
  if (!signature || !signature.available) return '';
  const lines = [];

  if (signature.deviceIncluded === false) {
    lines.push(`这个包的描述文件（${signature.profileName}）授权了 ${signature.deviceCount} 台设备，`
      + '但**不含这台设备**。装重签名后的产物，不要装原包。');
  }
  if (signature.bundleIdMatches === false) {
    lines.push(`包内 Bundle ID（${signature.appBundleId}）与描述文件允许的 `
      + `${signature.applicationId} 不匹配。`);
  }
  if (signature.deviceIncluded === true && signature.bundleIdMatches !== false) {
    lines.push('描述文件含这台设备、包名也匹配 —— 签名本身没问题，'
      + '请检查设备是否已开启「开发者模式」，以及是否已在设备上信任该开发者证书。');
  }
  return lines.join(' ');
}

async function resignIpa(payload = {}) {
  if (process.platform !== 'darwin') throw new Error('iOS 重签名仅支持在 macOS 上进行');
  const ipaPath = String(payload.ipaPath || '').trim();
  const provisionPath = String(payload.provisionPath || '').trim();
  const identity = String(payload.identity || '').trim();
  const p12Path = String(payload.p12Path || '').trim();
  const p12Password = String(payload.p12Password || '');
  const bundleId = String(payload.bundleId || '').trim();
  const appName = String(payload.appName || '').trim();
  // 进度上报。重签名要解压几百 MB、再签上百个目标、最后重新打包，
  // 不给进度的话界面会长时间毫无反应，用户以为卡死了。
  const onProgress = typeof payload.onProgress === 'function' ? payload.onProgress : () => {};
  const report = (percent, stage, detail) => {
    try {
      onProgress({ percent: Math.max(0, Math.min(100, Math.round(percent))), stage, detail });
    } catch (_) {
      // 进度回调出错不能影响签名本身
    }
  };
  if (!ipaPath || !ipaPath.toLowerCase().endsWith('.ipa')) throw new Error('请选择 IPA 文件');
  if (!fs.existsSync(ipaPath)) throw new Error('IPA 文件不存在');
  if (!provisionPath) throw new Error('请选择配置文件');
  if (!fs.existsSync(provisionPath)) throw new Error('配置文件不存在');
  if (!bundleId) throw new Error('请填写包名（Bundle ID）');
  // APP 名称是**可选**的：留空就沿用包内已有的名称。
  // 强行要求填写只会让用户随便打一个，把原来的显示名改掉。
  if (!identity && !p12Path) throw new Error('请选择证书或导入 p12');

  const provision = await decodeProvisionFile(provisionPath);
  if (!profileAllowsBundle(provision.applicationId, bundleId)) {
    throw new Error(`包名 ${bundleId} 与配置文件允许的 ID（${provision.bundleId || provision.applicationId}）不匹配`);
  }

  report(1, '准备重签名');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-resign-'));
  const outputPath = ipaPath.replace(/\.ipa$/i, '-resigned.ipa');
  try {
    // 纯 JS 解压，避免依赖 unzip（同时保证可执行位被正确还原）
    report(3, '解压 IPA 包体');
    const sourceArchive = openZip(ipaPath);
    try {
      sourceArchive.extractTo(workDir, {
        filter: (entry) => entry.name === 'Payload/' || entry.name.startsWith('Payload/'),
        onProgress: (info) => {
          // 解压占整条流程的前 35%
          report(3 + (Number(info?.percent) || 0) * 0.32, '解压 IPA 包体',
            info?.name ? String(info.name).replace(/^Payload\//, '') : '');
        }
      });
    } finally {
      sourceArchive.close();
    }
    const appPath = findAppBundle(workDir);
    const infoPlist = path.join(appPath, 'Info.plist');
    if (!fs.existsSync(infoPlist)) throw new Error('未找到 Info.plist');

    report(38, '写入描述文件与包名');
    const oldBundleId = await readPlistString(infoPlist, 'CFBundleIdentifier');
    fs.copyFileSync(provisionPath, path.join(appPath, 'embedded.mobileprovision'));
    await setPlistString(infoPlist, 'CFBundleIdentifier', bundleId);
    // 名称留空时 setPlistString 会直接返回，包内原有名称保持不变
    await setPlistString(infoPlist, 'CFBundleDisplayName', appName);
    await setPlistString(infoPlist, 'CFBundleName', appName);
    await rewriteNestedBundleIds(appPath, oldBundleId, bundleId);
    // 没填名称时，把包内真实的名字读出来回传 —— 界面要能告诉用户「沿用了哪个名字」
    const resolvedAppName = appName
      || (await readPlistString(infoPlist, 'CFBundleDisplayName'))
      || (await readPlistString(infoPlist, 'CFBundleName'))
      || '';

    const entitlementsPath = path.join(workDir, 'entitlements.plist');
    writeEntitlementsPlist(provision.entitlementsXml, entitlementsPath);

    return await withOptionalP12(p12Path || '', p12Password, async ({ keychain, identities }) => {
      const selected = identities.find((item) => item.hash === identity || item.name === identity) || identities[0];
      if (!selected) throw new Error('未找到可用的签名证书');
      const signIdentity = selected.hash;
      const targets = collectSignTargets(appPath);
      report(42, '开始签名', `共 ${targets.length} 个目标`);

      let done = 0;
      for (const target of targets) {
        const args = ['--force', '--sign', signIdentity, '--timestamp=none'];
        if (keychain) args.push('--keychain', keychain);
        if (target === appPath || /\.appex$/i.test(target)) {
          args.push('--entitlements', entitlementsPath);
        }
        const derArgs = [...args, '--generate-entitlement-der', target];
        try {
          await run(resolveSystemTool('codesign'), derArgs, { timeout: 120000 });
        } catch (_) {
          await run(resolveSystemTool('codesign'), [...args, target], { timeout: 120000 });
        }
        done += 1;
        // 签名占 42% ~ 88%
        report(42 + (done / targets.length) * 46, '正在签名',
          `${done}/${targets.length} · ${path.basename(target)}`);
      }

      report(89, '重新打包 IPA');
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      const zipEntries = ['Payload'];
      for (const extra of ['SwiftSupport', 'WatchKitSupport2', 'Symbols']) {
        if (fs.existsSync(path.join(workDir, extra))) zipEntries.push(extra);
      }
      await run(resolveSystemTool('zip'), ['-qry', outputPath, ...zipEntries], {
        cwd: workDir,
        timeout: 180000
      });
      report(100, '重签名完成');
      return {
        success: true,
        message: `重签名成功，输出文件: ${outputPath}`,
        outputPath,
        identity: selected.name,
        bundleId,
        appName: resolvedAppName,
        appNameReused: !appName
      };
    });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* 临时工作目录清理失败不影响重签名结果 */ }
  }
}

module.exports = {
  listCodeSignIdentities,
  inspectProvision,
  inspectIpaSignature,
  describeIpaSignature,
  resignIpa
};
