'use strict';

/**
 * iOS 安装失败的**诊断**能力测试。
 *
 * 背景：用户报「签名成功但安装失败：签名校验未通过」。实测根因是**装错了包** ——
 * 原包的描述文件只授权 12 台设备（不含目标设备），而重签名产物用的是自己的
 * 描述文件（含目标设备）。两者文件名只差一个 `-resigned`，极易选错，
 * 而原来的报错只把 iOS 的错误码翻译成一句笼统的猜测。
 *
 * 所以这里测两件事：
 * 1. 「读包内描述文件 → 说出具体原因」这条链路是对的（用真实 IPA 验）
 * 2. 两条安装回退路径的结构约束（devicectl 的 DEVELOPER_DIR 与 .app 入参）
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  inspectIpaSignature,
  describeIpaSignature
} = require('../electron/ios-resign');
const { looksLikeSignatureFailure, explainIosInstallError } = require('../electron/ideviceinstaller');

const ROOT = path.join(__dirname, '..');

// ==================== 错误码判定 ====================

test('signature failures are recognised from the codes iOS actually returns', () => {
  for (const code of ['0xe8008015', '0xe8008016', '0xe8008018', '0xe8008014', 'ApplicationVerificationFailed']) {
    assert.equal(looksLikeSignatureFailure(`ERROR: ${code}`), true, `${code} 应被识别`);
  }
  // 别的失败不该被误判成签名问题 —— 否则会给出完全错误的方向
  assert.equal(looksLikeSignatureFailure('DeviceLocked'), false);
  assert.equal(looksLikeSignatureFailure('afc_file_open failed'), false);
  assert.equal(looksLikeSignatureFailure(''), false);
});

test('the signature message is a fallback, not the whole story', () => {
  // 这条文案本身是「不知道具体原因」时的兜底，所以它必须能被更具体的诊断覆盖
  const generic = explainIosInstallError('ApplicationVerificationFailed');
  assert.match(generic, /签名校验未通过/);
});

// ==================== 读包内描述文件（真实 IPA）====================

/** 找一台本机已知的设备 UDID（有设备连着时才拿得到）。 */
function firstConnectedUdid() {
  try {
    const out = require('node:child_process')
      .execFileSync('idevice_id', ['-l'], { encoding: 'utf8' }).trim();
    return out.split('\n')[0] || '';
  } catch (_) {
    return '';
  }
}

const downloads = path.join(os.homedir(), 'Downloads');
const ipaFiles = fs.existsSync(downloads)
  ? fs.readdirSync(downloads).filter((name) => name.toLowerCase().endsWith('.ipa'))
  : [];
const resignedIpa = ipaFiles.map((n) => path.join(downloads, n)).find((p) => /-resigned\.ipa$/i.test(p));
const originalIpa = ipaFiles.map((n) => path.join(downloads, n)).find((p) => !/-resigned\.ipa$/i.test(p));

test('reading the embedded profile tells the device count and whether it includes ours', {
  skip: !resignedIpa && '~/Downloads 里没有可用的 IPA'
}, async () => {
  const udid = firstConnectedUdid();
  const info = await inspectIpaSignature(resignedIpa, udid || 'no-such-udid');

  assert.equal(info.available, true);
  assert.ok(info.profileName, '应读出描述文件名字');
  assert.ok(info.applicationId, '应读出 application-identifier');
  assert.ok(info.deviceCount > 0, '开发描述文件应有设备列表');

  if (udid) {
    assert.equal(info.deviceIncluded, true,
      '重签名产物应使用含本机设备的描述文件（否则装不上）');
    // 描述文件含设备、包名匹配 → 不该再说「装错包」
    const detail = describeIpaSignature(info);
    assert.doesNotMatch(detail, /不含这台设备/, '含设备时不该报「不含这台设备」');
  }
});

test('an IPA whose profile excludes the device is called out precisely', {
  skip: !originalIpa && '~/Downloads 里没有未重签的 IPA'
}, async () => {
  // 用一个必然不在任何描述文件里的 UDID，验证「不含这台设备」这条判定
  const info = await inspectIpaSignature(originalIpa, 'ffffffffffffffffffffffffffffffffffffffff');
  assert.equal(info.available, true);
  assert.equal(info.deviceIncluded, false, '伪造的 UDID 必然不在描述文件里');

  const detail = describeIpaSignature(info);
  assert.match(detail, /不含这台设备/, '要明确说出是描述文件不含设备');
  assert.match(detail, /重签名/, '要引导用户去装重签名后的产物');
  assert.match(detail, new RegExp(String(info.deviceCount)), '要报出描述文件里的设备数量');
});

test('a non-IPA or unsigned package degrades instead of throwing', async () => {
  const notAnIpa = path.join(os.tmpdir(), `not-an-ipa-${Date.now()}.ipa`);
  fs.writeFileSync(notAnIpa, 'not a zip at all');
  try {
    await assert.rejects(() => inspectIpaSignature(notAnIpa), /./,
      '不是 zip 时应抛出，让调用方 catch 后保留原错误文案');
  } finally {
    fs.unlinkSync(notAnIpa);
  }
});

test('describeIpaSignature stays silent when there is nothing to say', () => {
  assert.equal(describeIpaSignature(null), '');
  assert.equal(describeIpaSignature({ available: false }), '');
});

// ==================== 安装回退路径的结构约束 ====================

test('devicectl detection passes DEVELOPER_DIR from a real Xcode', () => {
  // devicectl 只随完整 Xcode 提供。xcode-select 指向 CommandLineTools 时
  // `xcrun --find devicectl` 会失败 —— 必须显式给 DEVELOPER_DIR，否则
  // 「明明装了 Xcode 却说找不到 devicectl」。
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');

  assert.match(source, /findFullXcodeDeveloperDir/, '应有一个「找完整 Xcode」的步骤');
  // 判据必须是「有没有 devicectl」，不能只看目录名
  assert.match(source, /path\.join\(dir, 'usr', 'bin', 'devicectl'\)/,
    '应以 devicectl 是否存在为判据，而不是猜目录名');
  // 断言「具体怎么传的」而不是「有没有这个字符串」——
  // 只 grep 字符串的话，写进注释也能骗过测试
  assert.match(source, /DEVELOPER_DIR:\s*developerDir\b/,
    '探测时要用找到的 Xcode 目录作为 DEVELOPER_DIR');
  assert.match(source, /DEVELOPER_DIR:\s*devicectl\.developerDir\b/,
    '真正安装时也必须带上同一个 DEVELOPER_DIR');
});

test('devicectl is handed a .app bundle, never the raw .ipa', () => {
  // `devicectl device install app` 的官方说明是
  // "installs an app bundle (with a .app extension)" —— 喂 .ipa 会失败。
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const at = source.indexOf("'devicectl', 'device', 'install', 'app'");
  assert.ok(at > 0, '找不到 devicectl 安装调用，测试需要更新');

  const call = source.slice(at, at + 320);
  assert.match(call, /appDir/, 'devicectl 应收到解包后的 .app 目录');
  assert.doesNotMatch(call, /,\s*filePath\s*\]/, '不应把 .ipa 路径直接交给 devicectl');
});

test('a signature failure triggers the profile diagnosis', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  assert.match(source, /looksLikeSignatureFailure/, '应在签名类失败时进入诊断分支');
  assert.match(source, /inspectIpaSignature\(filePath, deviceId\)/,
    '诊断要看的是「这次安装的那个包」，参数必须是 filePath 与 deviceId');
  assert.match(source, /describeIpaSignature\(/, '应把诊断结果翻译成人话');
});

// ==================== APP 名称可选 ====================

test('APP name is optional and does not block resigning', async () => {
  const { resignIpa } = require('../electron/ios-resign');
  // 给一个不存在的 IPA：报错应该是「IPA 文件不存在」，
  // 而不是「请填写 APP 名称」—— 说明名称已经不参与校验
  await assert.rejects(
    () => resignIpa({
      ipaPath: '/tmp/definitely-not-here.ipa',
      provisionPath: '/tmp/definitely-not-here.mobileprovision',
      bundleId: 'com.example.app',
      appName: ''
    }),
    (error) => {
      assert.doesNotMatch(error.message, /APP 名称/, 'APP 名称不该再是必填');
      assert.match(error.message, /IPA 文件不存在/);
      return true;
    }
  );
});

test('resigning reports progress stages', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');
  // 重签名要解压几百 MB、签上百个目标、再重新打包，必须分阶段上报
  for (const stage of ['解压 IPA 包体', '正在签名', '重新打包 IPA', '重签名完成']) {
    assert.ok(source.includes(stage), `应上报「${stage}」阶段`);
  }
  assert.match(source, /onProgress/, 'resignIpa 应接受 onProgress 回调');
  // 进度回调自己出错不能影响签名本身
  assert.match(source, /进度回调出错不能影响签名本身/);
});

test('progress is wired from main to renderer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/SignApk.jsx'), 'utf8');

  assert.match(main, /sender\.send\('resign-progress'/, '主进程应发送 resign-progress');
  assert.match(preload, /ipcRenderer\.on\('resign-progress'/, 'preload 应订阅 resign-progress');
  assert.match(ui, /onResignProgress/, '界面应订阅进度');
  assert.match(ui, /sign-progress/, '界面应有进度条');
});

// ==================== 提示必须基于事实，不能写死断言 ====================

test('the post-sign hint reports facts instead of asserting them', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/SignApk.jsx'), 'utf8');

  // 之前这里写的是「原包用的是别人的描述文件，里面的设备列表通常不含你这台」——
  // 那是断言；而用户选的描述文件很可能**是**含他设备的，文案就自相矛盾了。
  assert.doesNotMatch(ui, /通常不含你这台/,
    '不该保留「通常不含」这种写死的断言');
  assert.match(ui, /describeDeviceCoverage/, '应改为按实际读到的描述文件陈述');
  assert.match(ui, /inspectIpaSignature/, '应真的去读包内的描述文件');
});

test('describeDeviceCoverage states each case without guessing', () => {
  // 复刻界面里的判定，确保三种情况都有明确说法
  const describe = (signature) => {
    if (!signature?.available) return '读不出';
    if (!signature.hasDeviceList) return '未列出设备（企业/App Store 描述文件，任意设备可装）';
    if (signature.deviceIncluded === true) return `${signature.deviceCount} 台设备，包含当前设备`;
    if (signature.deviceIncluded === false) return `${signature.deviceCount} 台设备，不含当前设备`;
    return `${signature.deviceCount} 台设备（未连接设备，无法比对）`;
  };
  assert.match(describe({ available: true, hasDeviceList: true, deviceIncluded: true, deviceCount: 101 }), /包含当前设备/);
  assert.match(describe({ available: true, hasDeviceList: true, deviceIncluded: false, deviceCount: 12 }), /不含当前设备/);
  assert.match(describe({ available: true, hasDeviceList: false, deviceCount: 0 }), /任意设备可装/);
  assert.match(describe({ available: true, hasDeviceList: true, deviceCount: 5 }), /无法比对/);
  assert.equal(describe(null), '读不出');
});


  // ==================== 重签名：APP 名称可选 + 输出进度 ====================

  test('app name is optional and falls back to the name inside the bundle', () => {
    const resign = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');

    // 曾经这里有一句 `if (!appName) throw new Error('请填写 APP 名称')` ——
    // 强迫用户填一个名字，结果把包内原有的显示名改掉了。
    assert.doesNotMatch(resign, /请填写\s*APP\s*名称/, '不该再强制要求填写 APP 名称');

    // 留空时必须**不写** plist，让包内原有名称保留。
    // 这依赖 setPlistString 对空值直接返回，那条守卫必须还在。
    assert.match(resign, /setPlistString\(plistPath, key, value\)/, '应复用 setPlistString');
    assert.match(resign, /if \(!value\) return;/,
      'setPlistString 必须在值为空时直接返回，否则留空会把名称清成空串');

    // 回传解析后的真实名称，界面才能告诉用户「沿用了哪个名字」
    assert.match(resign, /resolvedAppName/, '应把实际使用的名称回传');
    assert.match(resign, /appNameReused/, '应标明名称是沿用的还是用户填的');
  });

  test('the iOS form marks app name as optional', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'src/components/SignApk.jsx'), 'utf8');
    assert.match(ui, /APP 名称（可选）/, '界面要写明可选');
    assert.match(ui, /留空则沿用包内已有的名称/, '要说明留空时的行为');
    assert.doesNotMatch(ui, /请填写 APP 名称/, '不该再提示「请填写 APP 名称」');
  });

  test('resigning reports progress through all stages', () => {
    const resign = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');

    // 前端槽：必须有 0 起点、结束到 100、且中段真的在推进
    assert.match(resign, /report\(1, '准备重签名'\)/, '应从 1% 起步');
    assert.match(resign, /report\(38, '写入描述文件与包名'\)/, '解压后应进入写入阶段');
    assert.match(resign, /report\(42 \+ \(done \/ targets\.length\) \* 46/,
      '签名阶段要按已完成数量推进，不能只在开头报一次');
    assert.match(resign, /report\(100, '重签名完成'\)/, '结束必须到 100%');

    // 传输链路：主进程 → preload → 渲染进程，三处都要有，缺任何一段界面都不会动
    assert.match(main, /sender\.send\('resign-progress', progress\)/, '主进程要把进度发出去');
    assert.match(main, /sender\.isDestroyed\?\.\(\)/,
      '窗口可能已关闭，发送前必须检查，否则会抛错');
    assert.match(preload, /resign-progress/, 'preload 要暴露进度订阅');
  });

  test('the progress callback never breaks the signing itself', () => {
    const resign = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');
    // 进度只是锦上添花：回调抛错（窗口销毁、序列化失败）不能把签名拖垮
    assert.match(resign, /try \{\s*onProgress\(/, '进度上报要包在 try 里');
    assert.match(resign, /进度回调出错不能影响签名本身/, '要有说明为什么吞掉异常');
  });

  // ==================== 重签名：APP 名称可选 + 输出进度 ====================

  test('app name is optional and falls back to the name inside the bundle', () => {
    const resign = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');

    // 曾经这里有一句 `if (!appName) throw new Error('请填写 APP 名称')` ——
    // 强迫用户填一个名字，结果把包内原有的显示名改掉了。
    assert.doesNotMatch(resign, /请填写\s*APP\s*名称/, '不该再强制要求填写 APP 名称');

    // 留空时必须**不写** plist，让包内原有名称保留。
    // 这依赖 setPlistString 对空值直接返回，那条守卫必须还在。
    assert.match(resign, /setPlistString\(plistPath, key, value\)/, '应复用 setPlistString');
    assert.match(resign, /if \(!value\) return;/,
      'setPlistString 必须在值为空时直接返回，否则留空会把名称清成空串');

    // 回传解析后的真实名称，界面才能告诉用户「沿用了哪个名字」
    assert.match(resign, /resolvedAppName/, '应把实际使用的名称回传');
    assert.match(resign, /appNameReused/, '应标明名称是沿用的还是用户填的');
  });

  test('the iOS form marks app name as optional', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'src/components/SignApk.jsx'), 'utf8');
    assert.match(ui, /APP 名称（可选）/, '界面要写明可选');
    assert.match(ui, /留空则沿用包内已有的名称/, '要说明留空时的行为');
    assert.doesNotMatch(ui, /请填写 APP 名称/, '不该再提示「请填写 APP 名称」');
  });

  test('resigning reports progress through all stages', () => {
    const resign = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');

    // 前端槽：必须有 0 起点、结束到 100、且中段真的在推进
    assert.match(resign, /report\(1, '准备重签名'\)/, '应从 1% 起步');
    assert.match(resign, /report\(38, '写入描述文件与包名'\)/, '解压后应进入写入阶段');
    assert.match(resign, /report\(42 \+ \(done \/ targets\.length\) \* 46/,
      '签名阶段要按已完成数量推进，不能只在开头报一次');
    assert.match(resign, /report\(100, '重签名完成'\)/, '结束必须到 100%');

    // 传输链路：主进程 → preload → 渲染进程，三处都要有，缺任何一段界面都不会动
    assert.match(main, /sender\.send\('resign-progress', progress\)/, '主进程要把进度发出去');
    assert.match(main, /sender\.isDestroyed\?\.\(\)/,
      '窗口可能已关闭，发送前必须检查，否则会抛错');
    assert.match(preload, /resign-progress/, 'preload 要暴露进度订阅');
  });

  test('the progress callback never breaks the signing itself', () => {
    const resign = fs.readFileSync(path.join(ROOT, 'electron/ios-resign.js'), 'utf8');
    // 进度只是锦上添花：回调抛错（窗口销毁、序列化失败）不能把签名拖垮
    assert.match(resign, /try \{\s*onProgress\(/, '进度上报要包在 try 里');
    assert.match(resign, /进度回调出错不能影响签名本身/, '要有说明为什么吞掉异常');
  });
