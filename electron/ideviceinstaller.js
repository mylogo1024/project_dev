'use strict';

function looksLikeUnknownOption(error) {
  return /invalid option|unknown option|unrecognized option|unknown command|invalid command|unrecognized command/i.test(
    String(error && error.message || error || '')
  );
}

function collectInstallOutput(error) {
  const cause = error && error.cause;
  return [
    error && error.stderr,
    error && error.stdout,
    cause && cause.stderr,
    cause && cause.stdout,
    error && error.message
  ]
    .map((item) => String(item || '').trim())
    .filter((item, index, arr) => item && arr.indexOf(item) === index)
    .join('\n')
    .trim();
}

function stripSideloadWarnings(text) {
  return String(text || '')
    .replace(/WARNING: could not locate iTunesMetadata\.plist in archive!\s*/gi, '')
    .replace(/WARNING: could not locate Payload\/\S+\/SC_Info\/\S+ in archive!\s*/gi, '')
    .replace(/WARNING: Could not create directory 'PublicStaging' on device!\s*/gi, '')
    .replace(/ideviceinstaller 执行失败:\s*/gi, '')
    .trim();
}

function iosInstallSucceeded(text) {
  const body = String(text || '');
  if (/ApplicationVerificationFailed|ERROR: .* failed|Copying .*\.\.\. FAILED|Uploading .*\.\.\. FAILED/i.test(body)) {
    return false;
  }
  return /Install: Complete|Upgrade: Complete|App installed/i.test(body);
}

function parseInstalledBundleId(text) {
  const match = String(text || '').match(/Install(?:ing)?:?\s+'([^']+)'/i)
    || String(text || '').match(/Upgrad(?:e|ing):?\s+'([^']+)'/i);
  return match ? match[1] : '';
}

function parsePackageInstallProgress(text, previous = 0) {
  const body = String(text || '');
  let percent = Number(previous) || 0;
  let stage = '安装中';
  const percents = [...body.matchAll(/\((\d+)\s*%\)/g)].map((item) => Number(item[1]));
  const lastPct = percents.length ? percents[percents.length - 1] : null;

  if (/Copying|Uploading/i.test(body)) {
    stage = '正在传到设备';
    percent = Math.max(percent, lastPct != null ? Math.min(40, Math.max(10, lastPct)) : 20);
  }
  if (/Copying .*\.\.\. DONE|Uploading .*\.\.\. DONE/i.test(body)) {
    stage = '已传到设备，开始安装';
    percent = Math.max(percent, 40);
  }
  if (/Install(?:ing)?|Performing Streamed Install/i.test(body)) {
    stage = '正在安装';
    percent = Math.max(percent, lastPct != null ? Math.min(95, 40 + Math.round(lastPct * 0.55)) : 55);
  }
  if (/Install: Complete|Upgrade: Complete|Success/i.test(body)) {
    stage = '安装完成';
    percent = 100;
  }
  return { percent, stage };
}

/**
 * 输出里是否包含「签名/描述文件校验失败」的特征码。
 *
 * 单独暴露出来是因为：这个判定成立时，调用方还能做一件更有用的事 ——
 * 去读包内的描述文件，直接告诉用户**具体**哪里不对（例如描述文件不含这台设备），
 * 而不是只把 iOS 的错误码翻译成一句笼统的猜测。
 */
function looksLikeSignatureFailure(text) {
  return /ApplicationVerificationFailed|0xe8008015|0xe8008016|0xe8008018|0xe8008014/i.test(String(text || ''));
}

function explainIosInstallError(text) {
  const body = String(text || '');
  if (looksLikeSignatureFailure(body)) {
    return '安装失败：签名校验未通过。请确认 IPA 已用匹配这台设备的证书/描述文件签名，并在设备上信任该开发者。';
  }
  if (/DeviceLocked|PasswordProtected|paired|trust this computer/i.test(body)) {
    return '安装失败：设备已锁定或未信任此电脑。请解锁设备后重试。';
  }
  if (/afc_file_open|AFC Write|Copying .*\.\.\. FAILED/i.test(body)) {
    return '安装失败：无法把安装包传到设备。请解锁、保持 USB 连接，并确认已点“信任此电脑”。';
  }
  const cleaned = stripSideloadWarnings(body);
  if (!cleaned) {
    return '安装失败：开发者/企业 IPA 没有 iTunesMetadata 和 .sinf 是正常的，不是失败原因。请解锁设备后重试；若仍失败，多半是签名或描述文件不匹配。';
  }
  return cleaned;
}

async function runIdeviceinstaller(runTool, argSets, options = {}) {
  if (typeof runTool !== 'function') throw new Error('runIdeviceinstaller 需要 runTool');
  if (!Array.isArray(argSets) || argSets.length === 0) throw new Error('ideviceinstaller 缺少参数');
  let lastError = null;
  for (const args of argSets) {
    try {
      return await runTool('ideviceinstaller', args, options);
    } catch (error) {
      lastError = error;
      if (!looksLikeUnknownOption(error)) throw error;
    }
  }
  throw lastError || new Error('ideviceinstaller 执行失败');
}

function withUdid(udid, rest) {
  return ['-u', udid, ...rest];
}

function installArgSets(udid, filePath) {
  return [
    withUdid(udid, ['install', filePath]),
    withUdid(udid, ['-i', filePath])
  ];
}

function uninstallArgSets(udid, bundleId) {
  return [
    withUdid(udid, ['uninstall', bundleId]),
    withUdid(udid, ['-U', bundleId])
  ];
}

function listXmlArgSets(udid) {
  return [
    withUdid(udid, ['list', '--xml']),
    withUdid(udid, ['-l', '-o', 'xml'])
  ];
}

function listAllArgSets(udid) {
  return [
    withUdid(udid, ['list', '--all']),
    withUdid(udid, ['-l', '-o', 'list_all'])
  ];
}

function listArgSets(udid) {
  return [
    withUdid(udid, ['list']),
    withUdid(udid, ['-l'])
  ];
}

function listBundleArgSets(udid, bundleId) {
  return [
    withUdid(udid, ['list', '-b', bundleId]),
    withUdid(udid, ['-l', '-b', bundleId]),
    withUdid(udid, ['list']),
    withUdid(udid, ['-l'])
  ];
}

async function runIdeviceinstallerStream(runStream, argSets, options = {}) {
  if (typeof runStream !== 'function') throw new Error('runIdeviceinstallerStream 需要 runStream');
  if (!Array.isArray(argSets) || argSets.length === 0) throw new Error('ideviceinstaller 缺少参数');
  let lastError = null;
  for (const args of argSets) {
    try {
      return await runStream('ideviceinstaller', args, options);
    } catch (error) {
      lastError = error;
      if (!looksLikeUnknownOption(error)) throw error;
    }
  }
  throw lastError || new Error('ideviceinstaller 执行失败');
}

module.exports = {
  runIdeviceinstaller,
  runIdeviceinstallerStream,
  installArgSets,
  uninstallArgSets,
  listXmlArgSets,
  listAllArgSets,
  listArgSets,
  listBundleArgSets,
  collectInstallOutput,
  stripSideloadWarnings,
  iosInstallSucceeded,
  parseInstalledBundleId,
    parsePackageInstallProgress,
    looksLikeSignatureFailure,
    explainIosInstallError
  };
