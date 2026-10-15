'use strict';

/**
 * iOS 包体（IPA）静态信息组装
 *
 * 输出与《AppReader 包体静态信息文档》一致的 two-layer 结构。
 * 纯 JS：plist 自己解析，描述文件走 CMS 内嵌 plist，Mach-O 自己解析，
 * 不需要 plutil / security / codesign 等系统工具。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { openZip } = require('./zip');
const { parsePlist, plistString, plistStringArray, plistBool, plistNumber } = require('./plist');
const { parseX509Certificate, extractEmbeddedPlist, parsePkcs7Certificates } = require('./der');
const { parseMachO, parseCodeSignature } = require('./binary');
const { detectSdks, detectIosFrameworks, evaluateRisk } = require('./rules');
const {
  computeFileDigests,
  formatBytes,
  formatDateTime,
  buildFileTree,
  sizeByTopDirectory,
  sizeByExtension,
  sizeByCategory,
  findDuplicateFiles,
  unique,
  makeProgressReporter
} = require('./util');

const MAX_ENTRY_LIST = 20000;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_STRING_TEXT = 16 * 1024 * 1024;

/** Info.plist 中的权限用途说明键 → 中文标签。 */
const IOS_USAGE_DESCRIPTIONS = {
  NSCameraUsageDescription: '相机',
  NSMicrophoneUsageDescription: '麦克风',
  NSLocationWhenInUseUsageDescription: '位置（使用时）',
  NSLocationAlwaysAndWhenInUseUsageDescription: '位置（始终）',
  NSLocationAlwaysUsageDescription: '位置（始终，旧版键）',
  NSLocationTemporaryUsageDescriptionDictionary: '临时精确定位',
  NSContactsUsageDescription: '通讯录',
  NSCalendarsUsageDescription: '日历',
  NSCalendarsFullAccessUsageDescription: '日历（完整访问）',
  NSRemindersUsageDescription: '提醒事项',
  NSRemindersFullAccessUsageDescription: '提醒事项（完整访问）',
  NSPhotoLibraryUsageDescription: '照片（读取）',
  NSPhotoLibraryAddUsageDescription: '照片（写入）',
  NSBluetoothAlwaysUsageDescription: '蓝牙',
  NSBluetoothPeripheralUsageDescription: '蓝牙（旧版键）',
  NSHealthShareUsageDescription: '健康（读取）',
  NSHealthUpdateUsageDescription: '健康（写入）',
  NSHealthClinicalHealthRecordsShareUsageDescription: '临床健康记录',
  NSMotionUsageDescription: '运动与健身',
  NSUserTrackingUsageDescription: '广告追踪（ATT）',
  NSSpeechRecognitionUsageDescription: '语音识别',
  NSFaceIDUsageDescription: '面容 ID',
  NSSiriUsageDescription: 'Siri',
  NSHomeKitUsageDescription: 'HomeKit',
  NFCReaderUsageDescription: 'NFC',
  NSLocalNetworkUsageDescription: '本地网络',
  NSUserNotificationUsageDescription: '通知',
  NSAppleMusicUsageDescription: 'Apple Music',
  NSVideoSubscriberAccountUsageDescription: '电视提供商',
  NSSensorKitUsageDescription: 'SensorKit',
  NSFileProviderDomainUsageDescription: '文件提供程序',
  NSFocusStatusUsageDescription: '专注状态',
  NSFallDetectionUsageDescription: '跌倒检测',
  NSIdentityUsageDescription: '身份验证',
  NSAppClipRequestEphemeralUserNotificationUsageDescription: 'App Clip 通知',
  NSAppClipRequestLocationConfirmationUsageDescription: 'App Clip 位置确认',
  NSFamilyControlsUsageDescription: '家庭控制',
  NSSharingUsageDescription: '共享',
  NSDesktopFolderUsageDescription: '桌面文件夹',
  NSDocumentsFolderUsageDescription: '文稿文件夹',
  NSDownloadsFolderUsageDescription: '下载文件夹',
  NSNetworkVolumesUsageDescription: '网络卷',
  NSRemovableVolumesUsageDescription: '可移除宗卷',
  NSSystemAdministrationUsageDescription: '系统管理',
  NSSystemExtensionUsageDescription: '系统扩展'
};

/** 能力 → 需要的用途说明键（用于「申请了能力但缺少说明文案」检测）。 */
const CAPABILITY_REQUIREMENTS = [
  { capability: '相机', frameworks: ['AVFoundation.framework', 'AVFAudio', 'CoreMedia', 'UIImagePickerController'], keys: ['NSCameraUsageDescription'] },
  { capability: '麦克风', frameworks: ['AVFAudio', 'AVFoundation.framework', 'AudioToolbox', 'Speech.framework'], keys: ['NSMicrophoneUsageDescription'] },
  { capability: '定位', frameworks: ['CoreLocation.framework'], keys: ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription'] },
  { capability: '通讯录', frameworks: ['Contacts.framework', 'AddressBook.framework'], keys: ['NSContactsUsageDescription'] },
  { capability: '照片', frameworks: ['Photos.framework', 'PhotosUI.framework', 'PHPhotoLibrary'], keys: ['NSPhotoLibraryUsageDescription'] },
  { capability: '蓝牙', frameworks: ['CoreBluetooth.framework'], keys: ['NSBluetoothAlwaysUsageDescription'] },
  { capability: '健康', frameworks: ['HealthKit.framework'], keys: ['NSHealthShareUsageDescription'] },
  { capability: '运动', frameworks: ['CoreMotion.framework'], keys: ['NSMotionUsageDescription'] },
  { capability: '广告追踪', frameworks: ['AdSupport.framework', 'AppTrackingTransparency.framework'], keys: ['NSUserTrackingUsageDescription'] },
  { capability: '语音识别', frameworks: ['Speech.framework'], keys: ['NSSpeechRecognitionUsageDescription'] },
  { capability: '面容 ID', frameworks: ['LocalAuthentication.framework'], keys: ['NSFaceIDUsageDescription'] }
];

const BACKGROUND_MODES = {
  audio: '音频播放',
  location: '定位更新',
  voip: 'VoIP',
  'external-accessory': '外接配件',
  'bluetooth-central': '蓝牙中心',
  'bluetooth-peripheral': '蓝牙外设',
  fetch: '后台抓取',
  'remote-notification': '远程通知',
  processing: '后台处理',
  'nearby-interaction': '近场交互'
};

// ==================== 主流程 ====================

function parseIosPackage(filePath, options = {}) {
  const startedAt = Date.now();
  const report = makeProgressReporter(options.onProgress);
  report(2, '打开 IPA 容器');
  const stat = fs.statSync(filePath);
  const zip = openZip(filePath);
  const warnings = [];

  try {
    report(8, `读取压缩包目录（${zip.entries.length} 个条目）`);
    const digests = computeFileDigests(filePath);
    report(16, '计算文件摘要（SHA-256 / SHA-1 / MD5）');

    // ---------- 定位主 App ----------
    report(22, '定位 Payload/*.app');
    const infoEntries = zip.match(/^Payload\/[^/]+\.app\/Info\.plist$/);
    if (!infoEntries.length) throw new Error('IPA 中未找到 Payload/*.app/Info.plist，可能不是有效的 IPA');
    const infoEntry = infoEntries[0];
    const appRoot = infoEntry.name.replace(/Info\.plist$/, '');
    const appName = appRoot.replace(/^Payload\//, '').replace(/\/$/, '');

    report(28, '解析 Info.plist');
    const info = parsePlist(zip.readEntry(infoEntry)) || {};

    // ---------- 描述文件 ----------
    report(34, '解析 embedded.mobileprovision');
    const provision = parseProvision(zip, appRoot);

    // ---------- 主二进制 ----------
    report(42, '解析主二进制（Mach-O）');
    const executableName = plistString(info.CFBundleExecutable);
    const binary = parseMainBinary(zip, appRoot, executableName, warnings);

    // ---------- Entitlements ----------
    report(50, '提取 Entitlements 授权项');
    const entitlements = buildEntitlements(zip, appRoot, provision, info, binary.codeSignature);

    // ---------- 签名类型 ----------
    report(56, '判定签名类型与证书链');
    const signing = buildSigningInfo(zip, appRoot, provision, entitlements, binary);

    // ---------- 框架 / 动态库 ----------
    report(64, '扫描内嵌 Framework 与 dylib');
    const frameworks = buildFrameworks(zip, appRoot);

    // ---------- 资源 ----------
    report(70, '整理资源文件（本地化 / 图片 / 配置）');
    const resources = buildIosResources(zip, appRoot, info);

    // ---------- 图标 ----------
    report(74, '解析应用图标');
    const icon = resolveIosIcon(zip, appRoot, info);

    // ---------- 体积 / 清单 ----------
    report(79, '统计体积分布与文件清单');
    const sizeAnalysis = buildSizeAnalysis(zip.entries);
    const inventory = buildIosInventory(zip, appRoot);

    // ---------- SDK / 框架识别 ----------
    report(85, '识别第三方 SDK 与系统框架');
    const pathText = zip.entries.map((entry) => entry.name).join('\n');
    const frameworkText = frameworks.frameworks.map((item) => item.name).join('\n');
    const binaryText = binary.rawStrings ? binary.rawStrings.join('\n') : '';
    const sources = [
      { type: 'text', value: `${pathText}\n${frameworkText}`, label: '包内路径' },
      { type: 'text', value: binaryText.slice(0, MAX_STRING_TEXT), label: '二进制字符串' }
    ];
    const sdks = detectSdks(sources);
    const iosFrameworks = detectIosFrameworks([pathText, frameworkText]);

    // `buildFrameworks` 只扫描包内路径，拿不到上面的识别结果，所以它返回的
    // `detected` 是空数组占位；而 flutter / react_native / unity / cordova /
    // ionic / capacitor / xamarin / cocos2d 这 8 个字段都靠 `frameworks.detected`
    // 判断 —— 不在这里补上，它们会**永远为 false**（曾经就是这样）。
    frameworks.detected = iosFrameworks.map((item) => item.name);

    // ---------- 隐私 ----------
    report(90, '分析隐私与合规项');
    const privacy = buildIosPrivacy(info, entitlements, frameworks, binary, resources);

    // ---------- 权限（用途说明） ----------
    const permissions = buildIosPermissions(info, frameworks, binary);

    // ---------- 风险 ----------
    report(95, '评估安全风险评分');
    const ats = info.NSAppTransportSecurity || {};
    const risk = evaluateRisk({
      platform: 'ios',
      signature: {
        signed: signing.signed,
        provision: {
          get_task_allow: entitlements['get-task-allow'] === true,
          provisions_all_devices: Boolean(provision?.ProvisionsAllDevices),
          expired: provision?.expired ?? null,
          expiration_date: provision?.ExpirationDate || null,
          signing_type: signing.signing_type
        }
      },
      native: { binary },
      privacy,
      sdks,
      network: {
        ats_disabled: plistBool(ats.NSAllowsArbitraryLoads, false) === true
          || plistBool(ats.NSAllowsArbitraryLoadsInWebContent, false) === true
      }
    });

    const appLabel = plistString(info.CFBundleDisplayName) || plistString(info.CFBundleName) || appName;
    const abis = binary.binary?.architectures ? unique(binary.binary.architectures.map((item) => item.arch)) : [];

    // ---------- 基本信息 ----------
    const basic = {
      file: {
        name: path.basename(filePath),
        path: filePath,
        type: 'IPA',
        container: 'IPA（ZIP 容器）',
        size: digests.size,
        size_human: formatBytes(digests.size),
        sha256: digests.sha256,
        sha1: digests.sha1,
        md5: digests.md5,
        entropy: digests.entropy,
        modified_at: formatDateTime(stat.mtime),
        created_at: formatDateTime(stat.birthtime),
        zip_comment: zip.comment,
        zip_entries: zip.entries.length,
        zip64: zip.zip64,
        encrypted: zip.encryptedEntries > 0,
        split: false,
        magic_bytes: readMagicBytes(filePath)
      },
      app: {
        name: appLabel,
        identifier: plistString(info.CFBundleIdentifier) || '未知',
        version_name: plistString(info.CFBundleShortVersionString) || '未知',
        version_code: plistString(info.CFBundleVersion) || '未知',
        version_display: `${plistString(info.CFBundleShortVersionString) || '?'} (${plistString(info.CFBundleVersion) || '?'})`,
        min_os: plistString(info.MinimumOSVersion) || binary.binary?.min_os_version || '未知',
        target_os: plistString(info.DTSDKName) || binary.binary?.sdk_version || '未知',
        min_sdk: plistString(info.MinimumOSVersion) || null,
        target_sdk: plistString(info.DTSDKName) || null,
        abis,
        icon: icon.data_url,
        icon_path: icon.path
      },
      signature: {
        signed: signing.signed,
        type: signing.signing_type,
        schemes: signing.schemes,
        debug: entitlements['get-task-allow'] === true,
        subject: signing.certificates[0]?.subject || '',
        issuer: signing.certificates[0]?.issuer || '',
        sha256: signing.certificates[0]?.sha256 || '',
        algorithm: signing.certificates[0]?.signature_algorithm || '',
        key_size: signing.certificates[0]?.key_size_label || '',
        not_before: signing.certificates[0]?.not_before || null,
        not_after: signing.certificates[0]?.not_after || null,
        expired: provision?.expired ?? null,
        weak: signing.certificates.some((cert) => /MD5|SHA1/i.test(cert.signature_algorithm || '')),
        certificate_count: signing.certificates.length,
        team_identifier: provision?.TeamIdentifier ? provision.TeamIdentifier.join(', ') : '',
        provision_name: provision?.Name || '',
        provision_expiration: provision?.ExpirationDate || null,
        provision_uuid: provision?.UUID || '',
        device_count: provision?.ProvisionedDevices ? provision.ProvisionedDevices.length : null,
        provisions_all_devices: Boolean(provision?.ProvisionsAllDevices)
      },
      structure: {
        dex_count: 0,
        so_count: 0,
        abis,
        permission_count: permissions.count,
        dangerous_permission_count: permissions.sensitive_count,
        component_count: frameworks.frameworks.length,
        exported_component_count: 0,
        activity_count: 0,
        service_count: 0,
        receiver_count: 0,
        provider_count: 0,
        locale_count: resources.locales.length,
        resource_count: resources.file_count,
        sdk_count: sdks.length,
        packed: false,
        packed_by: null,
        obfuscated: null,
        framework_count: frameworks.frameworks.length,
        extension_count: frameworks.extensions.length,
        encrypted_binary: binary.binary ? binary.binary.encrypted : null
      },
      risk: {
        score: risk.score,
        level: risk.level,
        level_label: risk.level_label,
        critical: risk.counts.critical || 0,
        high: risk.counts.high || 0,
        medium: risk.counts.medium || 0,
        low: risk.counts.low || 0,
        info: risk.counts.info || 0,
        top: risk.top
      }
    };

    // ---------- 详细信息 ----------
    const detailed = {
      '2.1': {
        title: '文件与包体结构',
        file: {
          file_path: filePath,
          file_name: path.basename(filePath),
          file_ext: '.ipa',
          file_size_bytes: digests.size,
          file_size_human: formatBytes(digests.size),
          mime_type: 'application/octet-stream',
          created_at: formatDateTime(stat.birthtime),
          modified_at: formatDateTime(stat.mtime),
          accessed_at: formatDateTime(stat.atime),
          sha256: digests.sha256,
          sha1: digests.sha1,
          md5: digests.md5,
          entropy: digests.entropy,
          magic_bytes: readMagicBytes(filePath),
          zip_comment: zip.comment,
          zip_version: `中央目录 ${zip.centralDirectoryOffset} 起，共 ${zip.centralDirectorySize} 字节`,
          zip_entries: zip.entries.length,
          zip_compressed_size: sizeAnalysis.total_compressed,
          zip_uncompressed_size: sizeAnalysis.total_size,
          zip_ratio: sizeAnalysis.overall_ratio,
          zip64: zip.zip64,
          is_split: false,
          is_encrypted: zip.encryptedEntries > 0,
          encrypted_entries: zip.encryptedEntries
        },
        structure: {
          app_root: appRoot,
          app_bundle_name: appName,
          entry_count: zip.entries.length,
          top_level_directories: unique(zip.entries.map((entry) => entry.name.split('/').slice(0, 2).join('/'))).slice(0, 60),
          executable: executableName || null,
          frameworks: frameworks.frameworks.map((item) => item.path),
          dylibs: frameworks.dylibs,
          extensions: frameworks.extensions.map((item) => item.path),
          watch_apps: frameworks.watchApps,
          app_clips: frameworks.appClips,
          code_signature: frameworks.codeSignature,
          file_types: sizeByExtension(zip.entries).slice(0, 30)
        },
        size_analysis: sizeAnalysis
      },
      '2.3': {
        title: '应用标识（iOS）',
        CFBundleIdentifier: plistString(info.CFBundleIdentifier),
        CFBundleName: plistString(info.CFBundleName),
        CFBundleDisplayName: plistString(info.CFBundleDisplayName),
        CFBundleExecutable: plistString(info.CFBundleExecutable),
        CFBundleVersion: plistString(info.CFBundleVersion),
        CFBundleShortVersionString: plistString(info.CFBundleShortVersionString),
        CFBundlePackageType: plistString(info.CFBundlePackageType),
        CFBundleSignature: plistString(info.CFBundleSignature),
        CFBundleInfoDictionaryVersion: plistString(info.CFBundleInfoDictionaryVersion),
        CFBundleDevelopmentRegion: plistString(info.CFBundleDevelopmentRegion),
        CFBundleIconFiles: plistStringArray(info.CFBundleIconFiles),
        CFBundleIconName: plistString(info.CFBundleIconName),
        CFBundleURLTypes: normalizeUrlTypes(info.CFBundleURLTypes),
        MinimumOSVersion: plistString(info.MinimumOSVersion),
        Platform: plistString(info.Platform),
        SupportedPlatforms: plistStringArray(info.SupportedPlatforms),
        UIDeviceFamily: normalizeDeviceFamily(info.UIDeviceFamily),
        LSRequiresIPhoneOS: plistBool(info.LSRequiresIPhoneOS, null),
        UIRequiredDeviceCapabilities: plistStringArray(info.UIRequiredDeviceCapabilities),
        UIUserInterfaceStyle: plistString(info.UIUserInterfaceStyle),
        UILaunchStoryboardName: plistString(info.UILaunchStoryboardName),
        UISupportedInterfaceOrientations: plistStringArray(info.UISupportedInterfaceOrientations),
        UISupportedInterfaceOrientationsForIpad: plistStringArray(info['UISupportedInterfaceOrientations~ipad']),
        DTPlatformName: plistString(info.DTPlatformName),
        DTSDKName: plistString(info.DTSDKName),
        DTXcode: plistString(info.DTXcode),
        DTXcodeBuild: plistString(info.DTXcodeBuild),
        DTCompiler: plistString(info.DTCompiler),
        DTPlatformVersion: plistString(info.DTPlatformVersion),
        DTAppStoreToolsBuild: plistString(info.DTAppStoreToolsBuild),
        BuildMachineOSBuild: plistString(info.BuildMachineOSBuild),
        ITSAppUsesNonExemptEncryption: plistBool(info.ITSAppUsesNonExemptEncryption, null),
        LSApplicationCategoryType: plistString(info.LSApplicationCategoryType),
        LSMinimumSystemVersion: plistString(info.LSMinimumSystemVersion),
        UIRequiresFullScreen: plistBool(info.UIRequiresFullScreen, null),
        UIStatusBarHidden: plistBool(info.UIStatusBarHidden, null),
        UIFileSharingEnabled: plistBool(info.UIFileSharingEnabled, null),
        LSSupportsOpeningDocumentsInPlace: plistBool(info.LSSupportsOpeningDocumentsInPlace, null),
        UIApplicationSupportsIndirectInputEvents: plistBool(info.UIApplicationSupportsIndirectInputEvents, null),
        CADisableMinimumFrameDurationOnPhone: plistBool(info.CADisableMinimumFrameDurationOnPhone, null),
        raw_keys: Object.keys(info).length
      },
      '2.4': {
        title: '应用元数据',
        label: appLabel,
        label_by_locale: resources.app_names,
        icon: {
          resource_name: icon.resource_name,
          path: icon.path,
          size: icon.size,
          size_human: icon.size_human,
          sha256: icon.sha256,
          variants: icon.variants,
          note: icon.note
        },
        round_icon: null,
        banner: null,
        logo: null,
        theme: plistString(info.UIUserInterfaceStyle) || null,
        app_category: plistString(info.LSApplicationCategoryType) || null,
        description: null,
        privacy_policy_url: privacy.privacy_policy_urls[0] || null,
        privacy_policy_urls: privacy.privacy_policy_urls,
        support_url: null,
        market_url: plistString(info.CFBundleIdentifier)
          ? `https://apps.apple.com/app/id${plistString(info.CFBundleIdentifier)}`
          : null,
        update_url: null,
        url_schemes: normalizeUrlTypes(info.CFBundleURLTypes),
        associated_domains: entitlements['com.apple.developer.associated-domains'] || []
      },
      '2.5': {
        title: '构建与签名信息',
        signed: signing.signed,
        signing_type: signing.signing_type,
        signing_type_note: signing.signing_type_note,
        team_identifier: provision?.TeamIdentifier || [],
        application_identifier: entitlements['application-identifier'] || '',
        bundle_identifier_from_entitlement: entitlements['application-identifier']
          ? String(entitlements['application-identifier']).split('.').slice(1).join('.')
          : '',
        entitlements,
        provisioned_devices: provision?.ProvisionedDevices || [],
        provisioned_device_count: provision?.ProvisionedDevices ? provision.ProvisionedDevices.length : 0,
        provisions_all_devices: Boolean(provision?.ProvisionsAllDevices),
        expiration_date: provision?.ExpirationDate || null,
        creation_date: provision?.CreationDate || null,
        expired: provision?.expired ?? null,
        provision_name: provision?.Name || '',
        provision_team_name: provision?.TeamName || '',
        provision_uuid: provision?.UUID || '',
        provision_platform: provision?.Platform || [],
        certificate_chain: signing.certificates,
        code_resources: frameworks.codeSignature,
        get_task_allow: entitlements['get-task-allow'] === true,
        aps_environment: entitlements['aps-environment'] || null,
        icloud: entitlements['com.apple.developer.icloud-container-identifiers']
          || entitlements['com.apple.developer.ubiquity-kvstore-identifier'] || null,
        keychain_groups: entitlements['keychain-access-groups'] || [],
        associated_domains: entitlements['com.apple.developer.associated-domains'] || [],
        binary: binary.binary ? {
          encrypted: binary.binary.encrypted,
          cryptid: binary.binary.cryptid,
          uuid: binary.binary.uuid,
          architectures: binary.binary.architectures,
          code_signature: binary.binary.has_code_signature,
          bitcode: binary.binary.bitcode,
          security: binary.binary.security
        } : null,
        code_signature: binary.codeSignature ? {
          present: true,
          blob_count: binary.codeSignature.blob_count,
          identifier: binary.codeSignature.identifier,
          team_identifier: binary.codeSignature.team_identifier,
          version: binary.codeSignature.version,
          flags: binary.codeSignature.flags,
          flag_names: binary.codeSignature.flag_names,
          hash_type: binary.codeSignature.hash_type,
          page_size: binary.codeSignature.page_size,
          code_slots: binary.codeSignature.code_slots,
          special_slots: binary.codeSignature.special_slots,
          platform: binary.codeSignature.platform,
          cms_length: binary.codeSignature.cms_length || 0
        } : { present: false }
      },
      '2.7': {
        title: '权限（iOS）',
        usage_descriptions: permissions.usage_descriptions,
        usage_description_count: permissions.count,
        by_key: permissions.by_key,
        background_modes: plistStringArray(info.UIBackgroundModes).map((mode) => ({
          mode,
          label: BACKGROUND_MODES[mode] || mode
        })),
        privacy_manifest: resources.privacy_manifest,
        sensitive_capabilities: permissions.capabilities,
        missing_usage_descriptions: permissions.missing
      },
      '2.9': {
        title: '组件与框架（iOS）',
        frameworks: frameworks.frameworks,
        framework_count: frameworks.frameworks.length,
        dylibs: frameworks.dylibs,
        dylib_count: frameworks.dylibs.length,
        swift_version: frameworks.swiftVersion,
        cocoapods: frameworks.cocoapods,
        spm: frameworks.spm,
        flutter: frameworks.detected.includes('Flutter'),
        react_native: frameworks.detected.includes('React Native'),
        unity: frameworks.detected.includes('Unity'),
        cordova: frameworks.detected.includes('Cordova'),
        ionic: frameworks.detected.includes('Ionic / Capacitor'),
        capacitor: frameworks.detected.includes('Ionic / Capacitor'),
        xamarin: frameworks.detected.includes('Xamarin'),
        cocos2d: frameworks.detected.includes('Cocos2d-x'),
        detected_frameworks: iosFrameworks,
        app_extension: frameworks.extensions,
        extension_count: frameworks.extensions.length,
        watch_app: frameworks.watchApps,
        app_clips: frameworks.appClips,
        linked_libraries: binary.binary ? binary.binary.linked_libraries : []
      },
      '2.11': {
        title: 'Native / Mach-O',
        executable: executableName || null,
        binary_path: binary.path,
        abis,
        architectures: binary.binary ? binary.binary.architectures : [],
        fat: binary.binary ? binary.binary.fat : null,
        slice_count: binary.binary ? binary.binary.slice_count : 0,
        macho: binary.binary ? {
          file_type: binary.binary.file_type,
          uuid: binary.binary.uuid,
          platform: binary.binary.platform,
          min_os_version: binary.binary.min_os_version,
          sdk_version: binary.binary.sdk_version,
          source_version: binary.binary.source_version,
          flags: `0x${(binary.binary.flags || 0).toString(16)}`,
          load_command_count: binary.binary.load_command_count,
          segments: binary.binary.segments
        } : null,
        cryptid: binary.binary ? binary.binary.cryptid : null,
        encrypted: binary.binary ? binary.binary.encrypted : null,
        bitcode: binary.binary ? binary.binary.bitcode : null,
        linked_libraries: binary.binary ? binary.binary.linked_libraries : [],
        linked_library_count: binary.binary ? binary.binary.linked_library_count : 0,
        security: binary.binary ? binary.binary.security : null,
        embedded_dylibs: frameworks.dylibs,
        note: binary.error || ''
      },
      '2.12': {
        title: '资源',
        locales: resources.locales,
        locale_count: resources.locales.length,
        densities: [],
        file_count: resources.file_count,
        total_size: resources.total_size,
        total_size_human: formatBytes(resources.total_size),
        by_type: resources.by_type,
        asset_catalogs: resources.asset_catalogs,
        storyboards: resources.storyboards,
        launch_images: resources.launch_images,
        icon_sets: resources.icon_sets,
        strings_files: resources.strings_files,
        strings_count: resources.strings_count,
        assets_car_present: resources.assets_car_present,
        note: resources.note
      },
      '2.13': {
        title: '文件清单',
        ...inventory
      },
      '2.14': {
        title: 'SDK 与框架',
        sdks,
        sdk_count: sdks.length,
        categories: countBy(sdks, 'sdk_category'),
        vendors: countBy(sdks, 'sdk_vendor'),
        countries: countBy(sdks, 'sdk_country'),
        detected_frameworks: iosFrameworks
      },
      '2.15': {
        title: '安全与风险',
        risk_score: risk.score,
        risk_level: risk.level,
        risk_level_label: risk.level_label,
        counts: risk.counts,
        findings: risk.findings,
        by_category: countBy(risk.findings, 'category'),
        top: risk.top
      },
      '2.16': {
        title: '隐私与合规',
        ...privacy
      },
      '2.19': {
        title: '原始数据（供高级用户）',
        info_plist_raw_size: zip.find(infoEntry.name) ? zip.find(infoEntry.name).size : 0,
        info_plist_json: info,
        entitlements_raw: entitlements,
        provision_raw: provision ? provision.raw : null,
        provision_keys: provision ? provision.keys : [],
        certificates_raw: signing.certificates.map((cert) => ({
          subject: cert.subject,
          sha256: cert.sha256,
          sha1: cert.sha1,
          md5: cert.md5,
          der_length: cert.der_length
        })),
        macho_headers: binary.binary ? [{
          path: binary.path,
          arch: binary.binary.arch,
          file_type: binary.binary.file_type,
          uuid: binary.binary.uuid,
          load_commands: binary.binary.load_command_count,
          segments: binary.binary.segments
        }] : [],
        privacy_manifest_raw: resources.privacy_manifest_raw
      }
    };

    report(99, '整理输出结构');
    return {
      platform: 'ios',
      container: 'ipa',
      basic,
      detailed,
      warnings,
      elapsed_ms: Date.now() - startedAt
    };
  } finally {
    zip.close();
  }
}

// ==================== 描述文件 ====================

function parseProvision(zip, appRoot) {
  const entry = zip.find(`${appRoot}embedded.mobileprovision`);
  if (!entry) return null;
  try {
    const buffer = zip.readEntry(entry);
    const plistBuffer = extractEmbeddedPlist(buffer);
    if (!plistBuffer) {
      return { error: '描述文件中未找到内嵌 plist', raw: null, keys: [] };
    }
    const data = parsePlist(plistBuffer) || {};
    const expiration = data.ExpirationDate instanceof Date
      ? data.ExpirationDate
      : (data.ExpirationDate ? new Date(data.ExpirationDate) : null);
    const creation = data.CreationDate instanceof Date
      ? data.CreationDate
      : (data.CreationDate ? new Date(data.CreationDate) : null);

    const developerCertificates = (data.DeveloperCertificates || [])
      .filter((item) => Buffer.isBuffer(item))
      .map((der) => {
        try {
          return { ...parseX509Certificate(der), der };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    return {
      Name: plistString(data.Name),
      TeamName: plistString(data.TeamName),
      TeamIdentifier: plistStringArray(data.TeamIdentifier),
      AppIDName: plistString(data.AppIDName),
      ApplicationIdentifierPrefix: plistStringArray(data.ApplicationIdentifierPrefix),
      CreationDate: creation ? creation.toISOString() : plistString(data.CreationDate),
      ExpirationDate: expiration ? expiration.toISOString() : plistString(data.ExpirationDate),
      expired: expiration ? expiration.getTime() < Date.now() : null,
      TimeToLive: plistNumber(data.TimeToLive, null),
      UUID: plistString(data.UUID),
      Version: plistNumber(data.Version, null),
      Platform: plistStringArray(data.Platform),
      ProvisionsAllDevices: plistBool(data.ProvisionsAllDevices, false),
      ProvisionedDevices: plistStringArray(data.ProvisionedDevices),
      Entitlements: data.Entitlements || {},
      DeveloperCertificates: developerCertificates,
      keys: Object.keys(data),
      raw: {
        Name: plistString(data.Name),
        TeamName: plistString(data.TeamName),
        UUID: plistString(data.UUID),
        ExpirationDate: expiration ? expiration.toISOString() : null,
        CreationDate: creation ? creation.toISOString() : null,
        TimeToLive: plistNumber(data.TimeToLive, null),
        Version: plistNumber(data.Version, null),
        Platform: plistStringArray(data.Platform),
        ProvisionsAllDevices: plistBool(data.ProvisionsAllDevices, false),
        ProvisionedDeviceCount: plistStringArray(data.ProvisionedDevices).length,
        Entitlements: data.Entitlements || {}
      }
    };
  } catch (error) {
    return { error: error.message, raw: null, keys: [] };
  }
}

// ==================== 主二进制 ====================

function parseMainBinary(zip, appRoot, executableName, warnings) {
  const result = { path: null, binary: null, codeSignature: null, error: '', rawStrings: [] };
  if (!executableName) {
    result.error = 'Info.plist 中缺少 CFBundleExecutable';
    return result;
  }
  const entry = zip.find(`${appRoot}${executableName}`);
  if (!entry) {
    result.error = `未找到主二进制 ${appRoot}${executableName}`;
    return result;
  }
  result.path = entry.name;
  try {
    const buffer = zip.readEntry(entry);
    result.binary = parseMachO(buffer);
    if (!result.binary) {
      result.error = '主二进制不是可识别的 Mach-O 格式';
    } else if (result.binary.code_signature_offset) {
      result.codeSignature = parseCodeSignature(
        buffer,
        result.binary.code_signature_offset,
        result.binary.code_signature_size
      );
    }
    result.rawStrings = extractAsciiStrings(buffer, 5, 200, 400000);
  } catch (error) {
    result.error = `解析主二进制失败: ${error.message}`;
    warnings.push(result.error);
  }
  return result;
}

/**
 * 从二进制中抽取可打印 ASCII 串。
 *
 * 使用「蓄水池采样」：超过上限后按轮转替换，保证对整个文件均匀覆盖，
 * 而不是只看到文件开头。
 */
function extractAsciiStrings(buffer, minLength = 5, maxLength = 200, limit = 200000) {
  const results = [];
  let count = 0;
  let current = [];
  const flush = () => {
    if (current.length >= minLength && current.length <= maxLength) {
      const text = Buffer.from(current).toString('latin1');
      if (count < limit) results.push(text);
      else results[count % limit] = text;
      count += 1;
    }
    current = [];
  };

  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (byte >= 0x20 && byte < 0x7f) {
      current.push(byte);
    } else {
      flush();
    }
  }
  flush();
  return results;
}

// ==================== Entitlements ====================

function buildEntitlements(zip, appRoot, provision, info, codeSignature) {
  const fromProvision = provision?.Entitlements && typeof provision.Entitlements === 'object'
    ? provision.Entitlements
    : {};

  const merged = { ...fromProvision };

  // 二进制里实际签进去的 entitlements 优先级最高
  if (codeSignature?.entitlements_raw) {
    try {
      const data = parsePlist(Buffer.from(codeSignature.entitlements_raw, 'utf8'));
      if (data && typeof data === 'object') Object.assign(merged, data);
    } catch (_) { /* 忽略 */ }
  }

  const xcentEntry = zip.find(`${appRoot}archived-expanded-entitlements.xcent`)
    || zip.match(new RegExp(`^${escapeRegExp(appRoot)}.*\\.xcent$`))[0];
  if (xcentEntry) {
    try {
      const data = parsePlist(zip.readEntry(xcentEntry));
      if (data && typeof data === 'object') Object.assign(merged, data);
    } catch (_) { /* 忽略 */ }
  }

  // 归一化：Buffer / Date → 可读值
  const normalized = {};
  for (const [key, value] of Object.entries(merged)) {
    normalized[key] = normalizeEntitlementValue(value);
  }
  return normalized;
}

function normalizeEntitlementValue(value) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeEntitlementValue);
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = normalizeEntitlementValue(item);
    return result;
  }
  return value;
}

// ==================== 签名信息 ====================

function buildSigningInfo(zip, appRoot, provision, entitlements, binary) {
  const codeSignatureFiles = zip.match(new RegExp(`^${escapeRegExp(appRoot)}_CodeSignature/`));
  const hasProvision = Boolean(provision && !provision.error);
  const hasCodeSignature = codeSignatureFiles.length > 0;

  const certificates = [];
  const seen = new Set();

  const pushCert = (cert) => {
    const fingerprint = cert.fingerprints?.sha256 || cert.sha256;
    if (!fingerprint || seen.has(fingerprint)) return;
    seen.add(fingerprint);
    certificates.push({
      subject: cert.subject?.full || cert.subject || '',
      subject_cn: cert.subject?.commonName || '',
      issuer: cert.issuer?.full || cert.issuer || '',
      issuer_cn: cert.issuer?.commonName || '',
      serial: cert.serial || '',
      not_before: cert.not_before || null,
      not_after: cert.not_after || null,
      is_expired: cert.is_expired ?? null,
      signature_algorithm: cert.signature_algorithm || '',
      public_key: cert.public_key ? {
        algorithm: cert.public_key.algorithm,
        key_size: cert.public_key.keySize,
        key_size_label: cert.public_key.keySizeLabel,
        curve: cert.public_key.curve || null
      } : null,
      key_size_label: cert.public_key?.keySizeLabel || '',
      sha256: cert.fingerprints?.sha256 || cert.sha256 || '',
      sha1: cert.fingerprints?.sha1 || cert.sha1 || '',
      md5: cert.fingerprints?.md5 || cert.md5 || '',
      der_length: cert.der ? cert.der.length : (cert.der_length || 0)
    });
  };

  for (const cert of provision?.DeveloperCertificates || []) pushCert(cert);

  // App Store 包没有描述文件，证书只存在于二进制内嵌的代码签名里
  let codeSignatureCmsCerts = [];
  if (!certificates.length && binary?.codeSignature?.cms_der) {
    try {
      codeSignatureCmsCerts = parsePkcs7Certificates(binary.codeSignature.cms_der);
      for (const cert of codeSignatureCmsCerts) pushCert(cert);
    } catch (_) { /* 忽略 */ }
  }

  const hasGetTaskAllow = entitlements['get-task-allow'] === true;
  const allDevices = Boolean(provision?.ProvisionsAllDevices);
  const devices = provision?.ProvisionedDevices || [];

  let signingType = '未签名';
  let note = '';
  if (!hasProvision && !hasCodeSignature) {
    signingType = '未签名';
    note = '未找到 embedded.mobileprovision 与 _CodeSignature，包体可能未签名或已重打包';
  } else if (allDevices) {
    signingType = 'Enterprise';
    note = '企业（In-House）证书，不限制安装设备';
  } else if (devices.length > 0) {
    signingType = hasGetTaskAllow ? 'Development' : 'Ad Hoc';
    note = hasGetTaskAllow
      ? '开发描述文件，包含调试授权（get-task-allow）'
      : `Ad Hoc 描述文件，绑定 ${devices.length} 台设备`;
  } else {
    signingType = 'App Store';
    note = 'App Store 分发描述文件，不绑定具体设备';
  }

  const schemes = [];
  if (hasCodeSignature) schemes.push('code-signature');
  if (hasProvision) schemes.push('provision');

  return {
    signed: hasProvision || hasCodeSignature,
    signing_type: signingType,
    signing_type_note: note,
    schemes,
    certificates,
    code_signature: {
      present: hasCodeSignature,
      file_count: codeSignatureFiles.length,
      files: codeSignatureFiles.map((entry) => entry.name).slice(0, 20)
    }
  };
}

// ==================== 框架 / 动态库 ====================

function buildFrameworks(zip, appRoot) {
  const frameworksRoot = `${appRoot}Frameworks/`;
  const frameworks = [];
  const dylibs = [];
  const extensions = [];
  const watchApps = [];
  const appClips = [];

  for (const entry of zip.entries) {
    if (entry.isDirectory) continue;
    const name = entry.name;
    if (name.startsWith(frameworksRoot)) {
      const relative = name.slice(frameworksRoot.length);
      const segments = relative.split('/');
      if (segments[0].endsWith('.framework')) {
        if (!frameworks.some((item) => item.name === segments[0])) {
          const frameworkEntries = zip.entries.filter((item) => item.name.startsWith(`${frameworksRoot}${segments[0]}/`));
          frameworks.push({
            name: segments[0],
            path: name,
            file_count: frameworkEntries.length,
            size: frameworkEntries.reduce((sum, item) => sum + item.size, 0),
            size_human: formatBytes(frameworkEntries.reduce((sum, item) => sum + item.size, 0))
          });
        }
      } else if (segments[0].endsWith('.dylib')) {
        if (!dylibs.includes(segments[0])) dylibs.push(segments[0]);
      }
    }
    if (name.startsWith(`${appRoot}PlugIns/`) && name.endsWith('.appex/Info.plist')) {
      extensions.push({ path: name.slice(appRoot.length), name: name.split('/')[1] });
    }
    if (/^Payload\/Watch\/[^/]+\.app\//.test(name)) {
      const watchName = name.split('/')[2];
      if (!watchApps.includes(watchName)) watchApps.push(watchName);
    }
    if (name.includes('.appex/') && name.endsWith('Info.plist') && !extensions.some((item) => name.includes(item.name))) {
      extensions.push({ path: name.slice(appRoot.length), name: name.split('.appex/')[0].split('/').pop() + '.appex' });
    }
    if (/\/AppClips\/[^/]+\.app\/Info\.plist$/.test(name)) {
      const clipName = name.split('/').slice(-2)[0];
      if (!appClips.includes(clipName)) appClips.push(clipName);
    }
  }

  const allNames = zip.entries.map((entry) => entry.name).join('\n');
  const swiftLibs = zip.match(/libswift[^/]*\.dylib/);
  const swiftVersion = /libswift[^/]*\.dylib|Swift\.framework|\.swiftmodule/.test(allNames)
    ? (swiftLibs.length ? `Swift（发现 ${swiftLibs.length} 个 libswift*.dylib）` : 'Swift')
    : null;
  const cocoapods = /Pods[-_][^/]*\.framework|Pods\.xcodeproj|Pods-Dummy\.m/.test(allNames);
  const spm = /SourcePackages|\.swiftpm/.test(allNames);

  const codeSignatureEntries = zip.match(new RegExp(`^${escapeRegExp(appRoot)}_CodeSignature/`));

  return {
    frameworks: frameworks.sort((a, b) => b.size - a.size),
    dylibs: dylibs.sort(),
    extensions,
    watchApps,
    appClips,
    swiftVersion,
    cocoapods,
    spm,
    // 注意：这里恒为空数组，由调用方在识别完第三方框架后回填。
    // 直接消费 `frameworks.detected` 的字段（flutter / unity / …）依赖那次回填。
    detected: [],
    codeSignature: {
      present: codeSignatureEntries.length > 0,
      files: codeSignatureEntries.map((entry) => entry.name)
    }
  };
}

// ==================== 资源 ====================

function buildIosResources(zip, appRoot, info) {
  const appEntries = zip.entries.filter((entry) => !entry.isDirectory && entry.name.startsWith(appRoot));

  const locales = unique(appEntries
    .map((entry) => /([^/]+)\.lproj\//.exec(entry.name))
    .filter(Boolean)
    .map((match) => match[1]))
    .sort();

  const appNames = {};
  for (const locale of locales) {
    const entry = zip.find(`${appRoot}${locale}.lproj/InfoPlist.strings`);
    if (!entry) continue;
    const text = safeReadText(zip, entry);
    const match = /CFBundleDisplayName"?\s*=\s*"([^"]+)"/.exec(text)
      || /CFBundleName"?\s*=\s*"([^"]+)"/.exec(text);
    if (match) appNames[locale] = match[1];
  }

  const privacyEntry = zip.find(`${appRoot}PrivacyInfo.xcprivacy`);
  let privacyManifest = { present: Boolean(privacyEntry), size: privacyEntry ? privacyEntry.size : 0 };
  let privacyManifestRaw = null;
  if (privacyEntry) {
    try {
      const data = parsePlist(zip.readEntry(privacyEntry));
      privacyManifestRaw = data;
      privacyManifest = {
        present: true,
        size: privacyEntry.size,
        tracked_domains: plistStringArray(data?.NSPrivacyTrackingDomains),
        tracking: plistBool(data?.NSPrivacyTracking, false),
        collected_data_types: (data?.NSPrivacyCollectedDataTypes || []).map((item) => ({
          type: plistString(item?.NSPrivacyCollectedDataType),
          linked: plistBool(item?.NSPrivacyCollectedDataTypeLinked, null),
          tracking: plistBool(item?.NSPrivacyCollectedDataTypeTracking, null),
          purposes: plistStringArray(item?.NSPrivacyCollectedDataTypePurposes)
        })),
        accessed_api_types: (data?.NSPrivacyAccessedAPITypes || []).map((item) => ({
          type: plistString(item?.NSPrivacyAccessedAPIType),
          reasons: plistStringArray(item?.NSPrivacyAccessedAPITypeReasons)
        }))
      };
    } catch (error) {
      privacyManifest.error = error.message;
    }
  }

  const stringsEntries = appEntries.filter((entry) => entry.name.endsWith('.strings'));
  const assetCatalogs = appEntries.filter((entry) => entry.name.endsWith('.car')).map((entry) => entry.name);
  const storyboards = appEntries.filter((entry) => entry.name.endsWith('.storyboardc')).length
    + appEntries.filter((entry) => entry.name.endsWith('.storyboard')).length;
  const launchImages = appEntries.filter((entry) => /LaunchImage|LaunchScreen/.test(entry.name)).map((entry) => entry.name);

  const byType = {};
  for (const entry of appEntries) {
    const dot = entry.name.lastIndexOf('.');
    const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '(无扩展名)';
    const bucket = byType[ext] || { extension: ext, count: 0, size: 0 };
    bucket.count += 1;
    bucket.size += entry.size;
    byType[ext] = bucket;
  }

  const totalSize = appEntries.reduce((sum, entry) => sum + entry.size, 0);

  return {
    locales,
    app_names: appNames,
    file_count: appEntries.length,
    total_size: totalSize,
    by_type: Object.values(byType)
      .map((item) => ({ ...item, size_human: formatBytes(item.size) }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 40),
    asset_catalogs: assetCatalogs,
    assets_car_present: assetCatalogs.length > 0,
    storyboards,
    launch_images: launchImages,
    icon_sets: appEntries.filter((entry) => /AppIcon|Icon-/.test(entry.name)).map((entry) => entry.name).slice(0, 40),
    strings_files: stringsEntries.map((entry) => entry.name),
    strings_count: stringsEntries.length,
    privacy_manifest: privacyManifest,
    privacy_manifest_raw: privacyManifestRaw,
    note: assetCatalogs.length
      ? '图标与部分资源打包在 Assets.car（编译后的资源目录）中，本工具不解包该格式'
      : ''
  };
}

// ==================== 图标 ====================

function resolveIosIcon(zip, appRoot, info) {
  const result = { resource_name: null, path: null, variants: [], data_url: null, size: 0, size_human: null, sha256: null, note: '' };

  const candidates = [];
  const iconsDict = info.CFBundleIcons || {};
  const primary = iconsDict.CFBundlePrimaryIcon || {};
  const iconFiles = [
    ...plistStringArray(primary.CFBundleIconFiles),
    ...plistStringArray(iconsDict.CFBundlePrimaryIcon?.CFBundleIconName ? [iconsDict.CFBundlePrimaryIcon.CFBundleIconName] : []),
    ...plistStringArray(info.CFBundleIconFiles),
    plistString(info.CFBundleIconName)
  ].filter(Boolean);
  result.resource_name = iconFiles[0] || null;

  for (const name of iconFiles) {
    for (const suffix of ['@3x.png', '@2x.png', '.png', '@3x~iphone.png', '@2x~iphone.png', '']) {
      const candidate = `${appRoot}${name}${suffix}`;
      const entry = zip.find(candidate);
      if (entry) candidates.push(entry);
    }
  }

  if (!candidates.length) {
    const fallback = zip.match(new RegExp(`^${escapeRegExp(appRoot)}(?:AppIcon|Icon)[^/]*\\.png$`));
    candidates.push(...fallback.sort((a, b) => b.size - a.size));
  }

  if (!candidates.length) {
    result.note = '未在 .app 根目录找到图标文件（可能仅存在于 Assets.car 中）';
    return result;
  }

  const best = candidates.reduce((current, entry) => (entry.size > current.size ? entry : current), candidates[0]);
  result.path = best.name.replace(appRoot, '');
  result.size = best.size;
  result.size_human = formatBytes(best.size);
  result.variants = candidates.slice(0, 12).map((entry) => ({
    path: entry.name.replace(appRoot, ''),
    size: entry.size,
    size_human: formatBytes(entry.size)
  }));

  if (best.size > 0 && best.size <= MAX_ICON_BYTES) {
    try {
      const buffer = zip.readEntry(best);
      result.data_url = `data:image/png;base64,${buffer.toString('base64')}`;
      result.sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    } catch (error) {
      result.note = `图标读取失败: ${error.message}`;
    }
  } else if (best.size > MAX_ICON_BYTES) {
    result.note = '图标文件过大，已跳过内嵌预览';
  }

  return result;
}

// ==================== 权限 / 隐私 ====================

function buildIosPermissions(info, frameworks, binary) {
  const byKey = {};
  for (const [key, label] of Object.entries(IOS_USAGE_DESCRIPTIONS)) {
    const value = info[key];
    if (value == null) continue;
    byKey[key] = {
      label,
      value: typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : plistString(value),
      present: true
    };
  }

  const usageDescriptions = Object.entries(byKey).map(([key, item]) => ({
    key,
    label: item.label,
    value: item.value
  }));

  const binaryText = binary.binary
    ? [
      ...(binary.binary.linked_libraries || []),
      ...(binary.rawStrings || []).slice(0, 20000)
    ].join('\n')
    : '';

  const frameworkNames = frameworks.frameworks.map((item) => item.name).join('\n');

  const capabilities = [];
  const missing = [];
  for (const requirement of CAPABILITY_REQUIREMENTS) {
    const detected = requirement.frameworks.some((marker) => frameworkNames.includes(marker) || binaryText.includes(marker));
    if (!detected) continue;
    capabilities.push(requirement.capability);
    const hasAny = requirement.keys.some((key) => byKey[key]);
    if (!hasAny) missing.push(`${requirement.capability}（缺少 ${requirement.keys.join(' / ')}）`);
  }

  const sensitiveCount = usageDescriptions.filter((item) => [
    '相机', '麦克风', '位置（使用时）', '位置（始终）', '通讯录', '照片（读取）',
    '蓝牙', '健康（读取）', '运动与健身', '广告追踪', '语音识别', '面容 ID'
  ].includes(item.label)).length;

  return {
    usage_descriptions: usageDescriptions,
    by_key: byKey,
    count: usageDescriptions.length,
    sensitive_count: sensitiveCount,
    capabilities,
    missing
  };
}

function buildIosPrivacy(info, entitlements, frameworks, binary, resources) {
  const ats = info.NSAppTransportSecurity || {};
  const usageKeys = Object.keys(IOS_USAGE_DESCRIPTIONS).filter((key) => info[key] != null);
  const stringsText = (binary.rawStrings || []).join('\n');
  const privacyUrls = unique((stringsText.match(/https?:\/\/[^\s"'<>\\)\]}]*?(?:privacy|privacy-policy)[^\s"'<>\\)\]}]*/gi) || []).slice(0, 10));

  const tracking = Boolean(info.NSUserTrackingUsageDescription)
    || frameworks.frameworks.some((item) => /AdSupport|AppTrackingTransparency|GoogleAds|Facebook/.test(item.name))
    || Boolean(resources.privacy_manifest?.tracking);

  return {
    privacy_policy_url: privacyUrls[0] || null,
    privacy_policy_urls: privacyUrls,
    privacy_policy_present: privacyUrls.length > 0,
    data_collected: usageKeys.map((key) => IOS_USAGE_DESCRIPTIONS[key]),
    data_shared: [],
    data_encrypted: plistBool(ats.NSAllowsArbitraryLoads, false) !== true,
    data_deletion: null,
    tracking,
    idfa: Boolean(entitlements['com.apple.developer.adsupport'] || frameworks.frameworks.some((item) => /AdSupport/.test(item.name))),
    att: Boolean(info.NSUserTrackingUsageDescription),
    att_description: plistString(info.NSUserTrackingUsageDescription) || null,
    skadnetwork: Boolean(info.SKAdNetworkItems),
    skadnetwork_items: (info.SKAdNetworkItems || []).length,
    imei: false,
    imsi: false,
    mac: /MACAddress|getMacAddress/.test(stringsText),
    oaid: false,
    android_id: false,
    gaid: false,
    children: null,
    age_rating: null,
    gdpr: null,
    ccpa: null,
    pipl: null,
    data_localization: null,
    cross_border: null,
    usage_descriptions: usageKeys.map((key) => ({ key, label: IOS_USAGE_DESCRIPTIONS[key], value: plistString(info[key]) })),
    usage_descriptions_missing: buildIosPermissions(info, frameworks, binary).missing,
    privacy_manifest_present: Boolean(resources.privacy_manifest?.present),
    privacy_manifest: resources.privacy_manifest,
    app_transport_security: {
      allows_arbitrary_loads: plistBool(ats.NSAllowsArbitraryLoads, null),
      allows_arbitrary_loads_in_web_content: plistBool(ats.NSAllowsArbitraryLoadsInWebContent, null),
      allows_arbitrary_loads_for_media: plistBool(ats.NSAllowsArbitraryLoadsForMedia, null),
      allows_local_networking: plistBool(ats.NSAllowsLocalNetworking, null),
      exception_domains: Object.keys(ats.NSExceptionDomains || {}),
      raw: ats
    },
    url_schemes: normalizeUrlTypes(info.CFBundleURLTypes),
    background_modes: plistStringArray(info.UIBackgroundModes)
  };
}

// ==================== 体积 / 清单 ====================

function buildSizeAnalysis(entries) {
  const files = entries.filter((entry) => !entry.isDirectory);
  const totalSize = files.reduce((sum, entry) => sum + entry.size, 0);
  const totalCompressed = files.reduce((sum, entry) => sum + entry.compressedSize, 0);

  return {
    total_size: totalSize,
    total_size_human: formatBytes(totalSize),
    total_compressed: totalCompressed,
    total_compressed_human: formatBytes(totalCompressed),
    overall_ratio: totalSize > 0 ? Number(((1 - totalCompressed / totalSize) * 100).toFixed(2)) : 0,
    file_count: files.length,
    directory_count: entries.filter((entry) => entry.isDirectory).length,
    by_category: sizeByCategory(entries),
    by_extension: sizeByExtension(entries).slice(0, 40),
    by_directory: sizeByTopDirectory(entries).slice(0, 30),
    top_10_largest: [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((entry) => ({
      name: entry.name,
      size: entry.size,
      size_human: formatBytes(entry.size),
      compressed: entry.compressedSize,
      ratio: Number((entry.ratio * 100).toFixed(2))
    })),
    compressible: {
      stored_count: files.filter((entry) => entry.method === 0).length,
      deflated_count: files.filter((entry) => entry.method === 8).length,
      stored_size: files.filter((entry) => entry.method === 0).reduce((sum, entry) => sum + entry.size, 0)
    },
    duplicate_files: findDuplicateFiles(entries, 20),
    duplicate_count: 0
  };
}

function buildIosInventory(zip, appRoot) {
  const files = zip.entries.filter((entry) => !entry.isDirectory);
  const inApp = files.filter((entry) => entry.name.startsWith(appRoot));
  const byExtension = (extensions) => files
    .filter((entry) => extensions.some((ext) => entry.name.toLowerCase().endsWith(ext)))
    .map((entry) => entry.name);

  return {
    assets: inApp.filter((entry) => /Assets\.car|\.bundle\//.test(entry.name)).map((entry) => entry.name),
    res: inApp.filter((entry) => /\.lproj\//.test(entry.name)).map((entry) => entry.name).slice(0, 200),
    lib: byExtension(['.dylib', '.a']),
    meta_inf: [],
    kotlin: [],
    okhttp: [],
    json: byExtension(['.json', '.jsbundle']),
    xml: byExtension(['.xml', '.plist', '.xcent', '.entitlements']),
    db: byExtension(['.db', '.sqlite', '.realm']),
    html: byExtension(['.html', '.htm']),
    js: byExtension(['.js', '.jsbundle']),
    css: byExtension(['.css']),
    fonts: byExtension(['.ttf', '.otf', '.ttc']),
    images: byExtension(['.png', '.jpg', '.jpeg', '.heic', '.pdf']).length,
    dex: [],
    so: [],
    top_files: [...files].sort((a, b) => b.size - a.size).slice(0, 20).map((entry) => ({
      name: entry.name,
      size: entry.size,
      size_human: formatBytes(entry.size)
    })),
    file_tree: buildFileTree(zip.entries.map((entry) => ({ path: entry.name, size: entry.size }))),
    entries: zip.entries.slice(0, MAX_ENTRY_LIST).map((entry) => ({
      name: entry.name,
      size: entry.size,
      compressed_size: entry.compressedSize,
      method: entry.methodName,
      crc32: entry.crc32_hex,
      is_directory: entry.isDirectory,
      encrypted: entry.isEncrypted,
      modified_at: entry.modifiedAt
    })),
    entries_truncated: zip.entries.length > MAX_ENTRY_LIST
  };
}

// ==================== 辅助 ====================

function normalizeUrlTypes(urlTypes) {
  if (!Array.isArray(urlTypes)) return [];
  return urlTypes.map((item) => ({
    name: plistString(item.CFBundleURLName),
    role: plistString(item.CFBundleTypeRole),
    schemes: plistStringArray(item.CFBundleURLSchemes)
  })).filter((item) => item.schemes.length);
}

function normalizeDeviceFamily(value) {
  const names = { 1: 'iPhone / iPod touch', 2: 'iPad', 3: 'Apple TV', 4: 'Apple Watch', 6: 'Mac', 7: 'Apple Vision' };
  return (Array.isArray(value) ? value : [value])
    .filter((item) => item != null)
    .map((item) => ({ code: Number(item), label: names[Number(item)] || `未知(${item})` }));
}

function safeReadText(zip, entry) {
  try {
    return zip.readEntryText(entry);
  } catch (_) {
    return '';
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMagicBytes(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);
    return buffer.toString('hex').replace(/(..)(?=.)/g, '$1 ');
  } catch (_) {
    return null;
  }
}

function countBy(list, key) {
  const result = {};
  for (const item of list) {
    const value = item[key] || '未知';
    result[value] = (result[value] || 0) + 1;
  }
  return result;
}

module.exports = {
  parseIosPackage,
  parseProvision,
  buildEntitlements,
  buildSigningInfo,
  buildFrameworks,
  buildIosResources,
  buildIosPermissions,
  buildIosPrivacy,
  resolveIosIcon,
  IOS_USAGE_DESCRIPTIONS,
  CAPABILITY_REQUIREMENTS,
  BACKGROUND_MODES
};
