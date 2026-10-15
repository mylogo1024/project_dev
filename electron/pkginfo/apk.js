'use strict';

/**
 * Android 包体（APK / AAB）静态信息组装
 *
 * 输出与《AppReader 包体静态信息文档》一致的 two-layer 结构：
 *   { basic: {...}, detailed: {...} }
 *
 * 全部依赖纯 JS 解析，不需要 aapt / keytool / apksigner 等外部工具。
 */

const fs = require('fs');
const path = require('path');

const { openZip } = require('./zip');
const axml = require('./axml');
const { parseArsc } = require('./arsc');
const { parseApkSignature } = require('./apksig');
const { parseElf, analyzeDexFiles, parseDexHeader, readDexStrings, parseProtobuf } = require('./binary');
const {
  PERMISSION_INFO,
  PROTECTION,
  detectSdks,
  detectPacker,
  detectHardening,
  evaluateRisk
} = require('./rules');
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

const CONTAINER_LAYOUTS = {
  apk: {
    kind: 'apk',
    label: 'APK',
    manifestPath: 'AndroidManifest.xml',
    arscPath: 'resources.arsc',
    dexPattern: /^classes\d*\.dex$/,
    libPattern: /^lib\/([^/]+)\/(.+\.so)$/,
    assetPrefix: 'assets/',
    resPrefix: 'res/',
    metaPrefix: 'META-INF/'
  },
  aab: {
    kind: 'aab',
    label: 'AAB',
    manifestPath: 'base/manifest/AndroidManifest.xml',
    arscPath: null,
    dexPattern: /^base\/dex\/classes\d*\.dex$/,
    libPattern: /^base\/lib\/([^/]+)\/(.+\.so)$/,
    assetPrefix: 'base/assets/',
    resPrefix: 'base/res/',
    metaPrefix: 'META-INF/'
  }
};

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86_64', 'x86', 'mips', 'mips64', 'riscv64'];

const MAX_ENTRY_LIST = 20000;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_STRING_TEXT = 24 * 1024 * 1024;
const MAX_LIBRARIES_PARSED = 6;

const MIME_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', xml: 'application/xml',
  json: 'application/json', js: 'application/javascript', css: 'text/css',
  html: 'text/html', htm: 'text/html', txt: 'text/plain', so: 'application/x-sharedlib',
  dex: 'application/x-dex', arsc: 'application/x-android-resources', ttf: 'font/ttf',
  otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg',
  mp4: 'video/mp4', db: 'application/x-sqlite3', sqlite: 'application/x-sqlite3',
  zip: 'application/zip', pak: 'application/octet-stream', bin: 'application/octet-stream'
};

function mimeOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || 'application/octet-stream';
}

// ==================== Manifest 建模 ====================

function parseManifestNode(zip, layout) {
  const buffer = zip.readEntry(layout.manifestPath);
  const { format, root } = axml.parseXml(buffer);
  return { buffer, format, root };
}

function buildAppIdentity(root) {
  const usesSdk = axml.findChild(root, 'uses-sdk');
  const application = axml.findChild(root, 'application');

  return {
    packageName: axml.attr(root, 'package') || '',
    versionName: axml.attr(root, 'versionName') || '',
    versionCode: axml.attr(root, 'versionCode') ?? '',
    versionCodeMajor: axml.attr(root, 'versionCodeMajor') ?? '',
    minSdkVersion: axml.attr(usesSdk, 'minSdkVersion') ?? '',
    targetSdkVersion: axml.attr(usesSdk, 'targetSdkVersion') ?? '',
    maxSdkVersion: axml.attr(usesSdk, 'maxSdkVersion') ?? '',
    compileSdkVersion: axml.attr(root, 'compileSdkVersion') ?? '',
    compileSdkVersionCodename: axml.attr(root, 'compileSdkVersionCodename') || '',
    platformBuildVersionCode: axml.attr(root, 'platformBuildVersionCode') ?? '',
    platformBuildVersionName: axml.attr(root, 'platformBuildVersionName') || '',
    buildToolsVersion: '',
    installLocation: axml.attr(root, 'installLocation') || '',
    sharedUserId: axml.attr(root, 'sharedUserId') || '',
    sharedUserLabel: axml.attr(root, 'sharedUserLabel') || '',
    revisionCode: axml.attr(root, 'revisionCode') ?? '',
    isSplitRequired: axml.boolAttr(root, 'isSplitRequired'),
    isFeatureSplit: axml.boolAttr(root, 'isFeatureSplit'),
    requiredFeature: axml.childElements(root, 'uses-feature')
      .filter((node) => axml.boolAttr(node, 'required', true) !== false)
      .map((node) => axml.attr(node, 'name'))
      .filter(Boolean),
    optionalFeature: axml.childElements(root, 'uses-feature')
      .filter((node) => axml.boolAttr(node, 'required', true) === false)
      .map((node) => axml.attr(node, 'name'))
      .filter(Boolean),
    requiredLibrary: axml.childElements(root, 'uses-library')
      .filter((node) => axml.boolAttr(node, 'required', true) !== false)
      .map((node) => axml.attr(node, 'name'))
      .filter(Boolean),
    optionalLibrary: axml.childElements(root, 'uses-library')
      .filter((node) => axml.boolAttr(node, 'required', true) === false)
      .map((node) => axml.attr(node, 'name'))
      .filter(Boolean),
    nativeLibrary: unique(axml.childElements(root, 'uses-native-library').map((node) => axml.attr(node, 'name'))),
    supportsScreens: axml.attributesToObject(axml.findChild(root, 'supports-screens')),
    compatibleScreens: axml.childElements(root, 'compatible-screens').length,
    queriesPackages: axml.childElements(root, 'queries').flatMap((node) => axml.childElements(node, 'package').map((child) => axml.attr(child, 'name'))),
    application: application ? {
      name: axml.attr(application, 'name') || '',
      label: axml.attr(application, 'label') || '',
      labelResId: axml.referenceAttr(application, 'label'),
      icon: axml.attr(application, 'icon') || '',
      iconResId: axml.referenceAttr(application, 'icon'),
      roundIcon: axml.attr(application, 'roundIcon') || '',
      roundIconResId: axml.referenceAttr(application, 'roundIcon'),
      banner: axml.attr(application, 'banner') || '',
      logo: axml.attr(application, 'logo') || '',
      theme: axml.attr(application, 'theme') || '',
      description: axml.attr(application, 'description') || '',
      debuggable: axml.boolAttr(application, 'debuggable', false),
      allowBackup: axml.boolAttr(application, 'allowBackup', true),
      testOnly: axml.boolAttr(application, 'testOnly', false),
      usesCleartextTraffic: axml.boolAttr(application, 'usesCleartextTraffic', null),
      networkSecurityConfig: axml.attr(application, 'networkSecurityConfig') || '',
      networkSecurityConfigResId: axml.referenceAttr(application, 'networkSecurityConfig'),
      networkSecurityConfigPath: null,
      extractNativeLibs: axml.boolAttr(application, 'extractNativeLibs', null),
      requestLegacyExternalStorage: axml.boolAttr(application, 'requestLegacyExternalStorage', false),
      preserveLegacyExternalStorage: axml.boolAttr(application, 'preserveLegacyExternalStorage', false),
      hardwareAccelerated: axml.boolAttr(application, 'hardwareAccelerated', null),
      largeHeap: axml.boolAttr(application, 'largeHeap', false),
      supportsRtl: axml.boolAttr(application, 'supportsRtl', null),
      resizeableActivity: axml.boolAttr(application, 'resizeableActivity', null),
      appComponentFactory: axml.attr(application, 'appComponentFactory') || '',
      backupAgent: axml.attr(application, 'backupAgent') || '',
      fullBackupContent: axml.attr(application, 'fullBackupContent') || '',
      dataExtractionRules: axml.attr(application, 'dataExtractionRules') || '',
      vmSafeMode: axml.boolAttr(application, 'vmSafeMode', false),
      multiArch: axml.boolAttr(application, 'multiArch', false),
      killAfterRestore: axml.boolAttr(application, 'killAfterRestore', null),
      allowClearUserData: axml.boolAttr(application, 'allowClearUserData', null),
      usesNonSdkApi: axml.boolAttr(application, 'usesNonSdkApi', null),
      enableOnBackInvokedCallback: axml.boolAttr(application, 'enableOnBackInvokedCallback', null),
      isolatedProcess: axml.boolAttr(application, 'isolatedProcess', null),
      process: axml.attr(application, 'process') || '',
      taskAffinity: axml.attr(application, 'taskAffinity') || ''
    } : null
  };
}

function buildPermissions(root) {
  const permissions = [];
  for (const node of axml.childElements(root, 'uses-permission')) {
    permissions.push({ node, kind: 'requested' });
  }
  for (const node of axml.childElements(root, 'uses-permission-sdk-23')) {
    permissions.push({ node, kind: 'requested-sdk23' });
  }
  for (const node of axml.childElements(root, 'permission')) {
    permissions.push({ node, kind: 'defined' });
  }

  const list = permissions.map(({ node, kind }) => {
    const name = axml.attr(node, 'name') || '';
    const info = PERMISSION_INFO[name] || null;
    const protectionLevel = axml.attr(node, 'protectionLevel') || (info ? info.level : null);
    return {
      name,
      kind,
      protectionLevel: protectionLevel || 'normal',
      group: info ? info.group : guessPermissionGroup(name),
      dangerous: protectionLevel === PROTECTION.DANGEROUS
        || (protectionLevel == null && Boolean(info && info.level === PROTECTION.DANGEROUS)),
      maxSdkVersion: axml.attr(node, 'maxSdkVersion') ?? null,
      usesPermissionFlags: axml.attr(node, 'usesPermissionFlags') || null,
      description: info ? info.description : '',
      label: axml.attr(node, 'label') || '',
      permissionGroup: axml.attr(node, 'permissionGroup') || '',
      known: Boolean(info)
    };
  });

  const requested = list.filter((item) => item.kind !== 'defined');
  const defined = list.filter((item) => item.kind === 'defined');

  return {
    requested,
    granted: [],
    custom: defined,
    all: list,
    requested_count: requested.length,
    dangerous_count: requested.filter((item) => item.dangerous).length,
    special_count: requested.filter((item) => item.protectionLevel === PROTECTION.SPECIAL).length,
    signature_count: requested.filter((item) => item.protectionLevel === PROTECTION.SIGNATURE).length,
    normal_count: requested.filter((item) => item.protectionLevel === PROTECTION.NORMAL).length,
    names: requested.map((item) => item.name)
  };
}

function guessPermissionGroup(name) {
  const tail = String(name).split('.').pop() || '';
  if (/LOCATION/i.test(tail)) return 'LOCATION';
  if (/CAMERA/i.test(tail)) return 'CAMERA';
  if (/AUDIO|MICROPHONE/i.test(tail)) return 'MICROPHONE';
  if (/CONTACT|ACCOUNT/i.test(tail)) return 'CONTACTS';
  if (/SMS|MMS|WAP/i.test(tail)) return 'SMS';
  if (/PHONE|CALL/i.test(tail)) return 'PHONE';
  if (/CALENDAR/i.test(tail)) return 'CALENDAR';
  if (/STORAGE|MEDIA/i.test(tail)) return 'STORAGE';
  if (/BLUETOOTH|WIFI|NFC|UWB/i.test(tail)) return 'NEARBY_DEVICES';
  return 'OTHER';
}

// ==================== 组件建模 ====================

function buildIntentFilter(node) {
  const dataNodes = axml.childElements(node, 'data');
  const actions = axml.childElements(node, 'action').map((item) => axml.attr(item, 'name')).filter(Boolean);
  const categories = axml.childElements(node, 'category').map((item) => axml.attr(item, 'name')).filter(Boolean);

  const data = dataNodes.map((item) => ({
    scheme: axml.attr(item, 'scheme') || null,
    host: axml.attr(item, 'host') || null,
    port: axml.attr(item, 'port') || null,
    path: axml.attr(item, 'path') || null,
    pathPrefix: axml.attr(item, 'pathPrefix') || null,
    pathPattern: axml.attr(item, 'pathPattern') || null,
    pathAdvancedPattern: axml.attr(item, 'pathAdvancedPattern') || null,
    mimeType: axml.attr(item, 'mimeType') || null
  }));

  const deepLinks = [];
  const appLinks = [];
  for (const item of data) {
    if (!item.scheme && !item.host) continue;
    const uri = `${item.scheme || ''}://${item.host || ''}${item.path || item.pathPrefix || item.pathPattern || ''}`;
    if (item.scheme === 'http' || item.scheme === 'https') {
      const isAppLink = categories.includes('android.intent.category.BROWSABLE')
        && axml.boolAttr(node, 'autoVerify', false) === true;
      (isAppLink ? appLinks : deepLinks).push(uri);
    } else {
      deepLinks.push(uri);
    }
  }

  return {
    actions,
    categories,
    data,
    priority: axml.intAttr(node, 'priority', 0),
    autoVerify: axml.boolAttr(node, 'autoVerify', false),
    deepLinks,
    appLinks,
    mimeTypes: unique(data.map((item) => item.mimeType)),
    schemes: unique(data.map((item) => item.scheme))
  };
}

function componentMetaData(node) {
  return axml.childElements(node, 'meta-data').map((item) => ({
    name: axml.attr(item, 'name') || '',
    value: axml.attr(item, 'value') ?? null,
    resource: axml.attr(item, 'resource') || null
  }));
}

function componentBase(node, type) {
  const intentFilters = axml.childElements(node, 'intent-filter').map(buildIntentFilter);
  return {
    type,
    name: axml.attr(node, 'name') || '',
    exported: axml.boolAttr(node, 'exported', null),
    enabled: axml.boolAttr(node, 'enabled', true),
    permission: axml.attr(node, 'permission') || '',
    process: axml.attr(node, 'process') || '',
    intentFilters,
    metaData: componentMetaData(node),
    deepLinks: unique(intentFilters.flatMap((item) => item.deepLinks)),
    appLinks: unique(intentFilters.flatMap((item) => item.appLinks)),
    hasIntentFilter: intentFilters.length > 0
  };
}

function buildComponents(root) {
  const application = axml.findChild(root, 'application');
  const empty = { activities: [], services: [], receivers: [], providers: [], customPermissions: [], total: 0 };
  if (!application) return empty;

  const activities = axml.childElements(application, 'activity').map((node) => {
    const base = componentBase(node, 'activity');
    return {
      ...base,
      launchMode: axml.attr(node, 'launchMode') || 'standard',
      screenOrientation: axml.attr(node, 'screenOrientation') || '',
      configChanges: axml.attr(node, 'configChanges') || '',
      taskAffinity: axml.attr(node, 'taskAffinity') || '',
      theme: axml.attr(node, 'theme') || '',
      excludeFromRecents: axml.boolAttr(node, 'excludeFromRecents', false),
      clearTaskOnLaunch: axml.boolAttr(node, 'clearTaskOnLaunch', false),
      noHistory: axml.boolAttr(node, 'noHistory', false),
      stateNotNeeded: axml.boolAttr(node, 'stateNotNeeded', false),
      alwaysRetainTaskState: axml.boolAttr(node, 'alwaysRetainTaskState', false),
      finishOnTaskLaunch: axml.boolAttr(node, 'finishOnTaskLaunch', false),
      directBootAware: axml.boolAttr(node, 'directBootAware', false),
      isAlias: false,
      label: axml.attr(node, 'label') || '',
      icon: axml.attr(node, 'icon') || ''
    };
  });

  const aliases = axml.childElements(application, 'activity-alias').map((node) => {
    const base = componentBase(node, 'activity-alias');
    return { ...base, targetActivity: axml.attr(node, 'targetActivity') || '', isAlias: true };
  });

  const services = axml.childElements(application, 'service').map((node) => ({
    ...componentBase(node, 'service'),
    foregroundServiceType: axml.attr(node, 'foregroundServiceType') || '',
    isolatedProcess: axml.boolAttr(node, 'isolatedProcess', false),
    directBootAware: axml.boolAttr(node, 'directBootAware', false)
  }));

  const receivers = axml.childElements(application, 'receiver').map((node) => ({
    ...componentBase(node, 'receiver'),
    directBootAware: axml.boolAttr(node, 'directBootAware', false)
  }));

  const providers = axml.childElements(application, 'provider').map((node) => ({
    ...componentBase(node, 'provider'),
    authorities: axml.attr(node, 'authorities') || '',
    readPermission: axml.attr(node, 'readPermission') || '',
    writePermission: axml.attr(node, 'writePermission') || '',
    grantUriPermissions: axml.boolAttr(node, 'grantUriPermissions', false),
    multiprocess: axml.boolAttr(node, 'multiprocess', false),
    initOrder: axml.intAttr(node, 'initOrder', 0),
    syncable: axml.boolAttr(node, 'syncable', false),
    directBootAware: axml.boolAttr(node, 'directBootAware', false),
    paths: axml.childElements(node, 'grant-uri-permission').map((item) => ({
      path: axml.attr(item, 'path') || null,
      pathPrefix: axml.attr(item, 'pathPrefix') || null,
      pathPattern: axml.attr(item, 'pathPattern') || null
    })),
    uriPermissionPatterns: axml.childElements(node, 'path-permission').map((item) => ({
      path: axml.attr(item, 'path') || null,
      pathPrefix: axml.attr(item, 'pathPrefix') || null,
      permission: axml.attr(item, 'permission') || null,
      readPermission: axml.attr(item, 'readPermission') || null,
      writePermission: axml.attr(item, 'writePermission') || null
    }))
  }));

  const customPermissions = axml.childElements(root, 'permission').map((node) => ({
    name: axml.attr(node, 'name') || '',
    protectionLevel: axml.attr(node, 'protectionLevel') || null,
    permissionGroup: axml.attr(node, 'permissionGroup') || '',
    label: axml.attr(node, 'label') || '',
    description: axml.attr(node, 'description') || ''
  }));

  const all = [...activities, ...aliases, ...services, ...receivers, ...providers];
  return {
    activities,
    activityAliases: aliases,
    services,
    receivers,
    providers,
    customPermissions,
    total: all.length,
    exported: all.filter((item) => item.exported === true).length,
    withIntentFilter: all.filter((item) => item.hasIntentFilter).length,
    unprotectedExported: all.filter((item) => item.exported === true && !item.permission).length
  };
}

// ==================== 资源建模 ====================

function buildResources(zip, layout, arsc) {
  if (!arsc) {
    return {
      available: false,
      note: 'AAB 使用 base/resources.pb（protobuf）承载资源，本工具暂不解析该格式',
      locales: [], densities: [], resource_count: 0, type_stats: [], arsc_version: null, arsc_size: 0
    };
  }
  const typeStats = arsc.typeStats;
  const byName = (name) => typeStats.find((item) => item.name === name)?.entryCount || 0;

  const resEntries = zip.entries.filter((entry) => !entry.isDirectory && entry.name.startsWith(layout.resPrefix));

  return {
    available: true,
    locales: arsc.locales,
    locale_count: arsc.locales.length,
    densities: arsc.densities,
    resource_count: arsc.resourceCount,
    type_stats: typeStats.map((item) => ({ name: item.name, entry_count: item.entryCount, config_count: item.configCount })),
    counts: {
      strings: byName('string'),
      colors: byName('color'),
      dimens: byName('dimen'),
      styles: byName('style'),
      themes: byName('style'),
      drawables: byName('drawable'),
      mipmaps: byName('mipmap'),
      layouts: byName('layout'),
      anims: byName('anim') + byName('animator'),
      xml: byName('xml'),
      raw: byName('raw'),
      arrays: byName('array'),
      integers: byName('integer'),
      bools: byName('bool'),
      attrs: byName('attr'),
      ids: byName('id')
    },
    arsc_version: arsc.versionLabel,
    arsc_size: arsc.buffer.length,
    arsc_size_human: formatBytes(arsc.buffer.length),
    global_string_count: arsc.globalStrings.stringCount,
    package_count: arsc.packages.length,
    packages: arsc.packages.map((pkg) => ({ id: pkg.idHex, name: pkg.name, type_count: pkg.typeChunks.length })),
    res_file_count: resEntries.length,
    res_total_size: resEntries.reduce((sum, entry) => sum + entry.size, 0)
  };
}

function resolveIcon(zip, arsc, identity) {
  const result = {
    resource_id: identity.application?.iconResId?.hex || null,
    path: null,
    variants: [],
    data_url: null,
    mime_type: null,
    size: 0,
    size_human: null,
    sha256: null,
    note: ''
  };
  if (!arsc) {
    result.note = 'AAB 资源未解析，无法定位图标';
    return result;
  }

  let targetResId = identity.application?.iconResId?.resId || null;
  let resourceName = null;

  if (targetResId) {
    const resolved = arsc.resolve(targetResId, { followReference: true });
    resourceName = resolved?.entryKey || null;
    const variants = collectIconVariants(arsc, targetResId);
    result.variants = variants;
    const best = pickBestIconVariant(variants);
    if (best && best.path) {
      const candidate = best.path;
      if (zip.find(candidate)) {
        result.path = candidate;
      } else {
        const found = zip.entries.find((entry) => entry.name.endsWith(`/${path.basename(candidate)}`) && entry.name.startsWith('res/'));
        if (found) result.path = found.name;
      }
    }
    result.resource_name = resourceName;
  }

  if (!result.path && identity.application?.icon && !identity.application.icon.startsWith('@')) {
    if (zip.find(identity.application.icon)) result.path = identity.application.icon;
  }

  if (!result.path) {
    const fallback = zip.match(/^res\/(?:mipmap|drawable)[^/]*\/[^/]*(?:ic_launcher|app_icon|icon)[^/]*\.(?:png|webp|jpg)$/i);
    if (fallback.length) {
      const sorted = fallback.sort((a, b) => b.size - a.size);
      result.path = sorted[0].name;
      result.note = '未从清单解析到图标资源，按名称启发式匹配';
    }
  }

  if (result.path) {
    const entry = zip.find(result.path);
    result.size = entry ? entry.size : 0;
    result.size_human = formatBytes(result.size);
    result.mime_type = mimeOf(result.path);
    if (entry && entry.size > 0 && entry.size <= MAX_ICON_BYTES && /^image\//.test(result.mime_type)) {
      try {
        const buffer = zip.readEntry(entry);
        result.data_url = `data:${result.mime_type};base64,${buffer.toString('base64')}`;
        result.sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
      } catch (error) {
        result.note = `图标读取失败: ${error.message}`;
      }
    }
  }

  return result;
}

function collectIconVariants(arsc, resId) {
  const { splitResourceId } = require('./res-chunk');
  const { packageId, typeId, entryId } = splitResourceId(resId);
  const raw = arsc.collectVariants(typeId, entryId, packageId || null);
  const results = [];
  for (const variant of raw) {
    if (!variant.valueText) continue;
    results.push({
      config: variant.config,
      density: variant.density,
      density_label: variant.densityLabel,
      path: variant.valueText
    });
    // 值为 @ref 时再追一层，取真实文件路径
    if (variant.valueType === 0x01) {
      const match = String(variant.valueText).match(/0x([0-9a-fA-F]{1,8})/);
      if (match) {
        const nested = arsc.resolve(Number.parseInt(match[1], 16));
        if (nested?.valueText && !results.some((item) => item.path === nested.valueText)) {
          results.push({
            config: variant.config,
            density: variant.density,
            density_label: variant.densityLabel,
            path: nested.valueText
          });
        }
      }
    }
  }
  return results;
}

function pickBestIconVariant(variants) {
  if (!variants.length) return null;
  const withDensity = variants.filter((item) => item.density && item.density < 0xfffe);
  const pool = withDensity.length ? withDensity : variants;
  return pool.reduce((best, item) => (item.density > best.density ? item : best), pool[0]);
}

// ==================== 体积 / 清单 ====================

function buildSizeAnalysis(entries) {
  const files = entries.filter((entry) => !entry.isDirectory);
  const totalSize = files.reduce((sum, entry) => sum + entry.size, 0);
  const totalCompressed = files.reduce((sum, entry) => sum + entry.compressedSize, 0);
  const byCategory = sizeByCategory(entries);
  const byExtension = sizeByExtension(entries).slice(0, 40);
  const byDirectory = sizeByTopDirectory(entries).slice(0, 30);
  const top10 = [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((entry) => ({
    name: entry.name,
    size: entry.size,
    size_human: formatBytes(entry.size),
    compressed: entry.compressedSize,
    ratio: Number((entry.ratio * 100).toFixed(2))
  }));
  const duplicates = findDuplicateFiles(entries, 20);

  return {
    total_size: totalSize,
    total_size_human: formatBytes(totalSize),
    total_compressed: totalCompressed,
    total_compressed_human: formatBytes(totalCompressed),
    overall_ratio: totalSize > 0 ? Number(((1 - totalCompressed / totalSize) * 100).toFixed(2)) : 0,
    file_count: files.length,
    directory_count: entries.filter((entry) => entry.isDirectory).length,
    by_category: byCategory,
    by_extension: byExtension,
    by_directory: byDirectory,
    top_10_largest: top10,
    compressible: {
      stored_count: files.filter((entry) => entry.method === 0).length,
      deflated_count: files.filter((entry) => entry.method === 8).length,
      stored_size: files.filter((entry) => entry.method === 0).reduce((sum, entry) => sum + entry.size, 0)
    },
    duplicate_files: duplicates,
    duplicate_count: duplicates.length
  };
}

function buildFileInventory(zip, layout) {
  const files = zip.entries.filter((entry) => !entry.isDirectory);
  const byPrefix = (prefix) => files.filter((entry) => entry.name.startsWith(prefix)).map((entry) => entry.name);
  const byExtension = (extensions) => files
    .filter((entry) => extensions.some((ext) => entry.name.toLowerCase().endsWith(ext)))
    .map((entry) => entry.name);

  const topFiles = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)
    .map((entry) => ({ name: entry.name, size: entry.size, size_human: formatBytes(entry.size) }));

  return {
    assets: byPrefix(layout.assetPrefix),
    res: byPrefix(layout.resPrefix),
    lib: files.filter((entry) => layout.libPattern.test(entry.name)).map((entry) => entry.name),
    meta_inf: byPrefix(layout.metaPrefix),
    kotlin: byPrefix('kotlin/').concat(byPrefix('META-INF/kotlin')).concat(files.filter((entry) => entry.name.includes('kotlin_module')).map((entry) => entry.name)),
    okhttp: byPrefix('META-INF/okhttp').concat(files.filter((entry) => /okhttp3\/internal\/.+\/(cache|publicsuffixes)/.test(entry.name)).map((entry) => entry.name)),
    json: byExtension(['.json']),
    xml: byExtension(['.xml']),
    db: byExtension(['.db', '.sqlite', '.sqlite3', '.realm']),
    html: byExtension(['.html', '.htm']),
    js: byExtension(['.js', '.mjs', '.cjs']),
    css: byExtension(['.css']),
    fonts: byExtension(['.ttf', '.otf', '.woff', '.woff2', '.ttc']),
    images: byExtension(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']).length,
    dex: files.filter((entry) => layout.dexPattern.test(entry.name)).map((entry) => entry.name),
    so: files.filter((entry) => entry.name.endsWith('.so')).map((entry) => entry.name),
    top_files: topFiles,
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

// ==================== Native ====================

function buildNative(zip, layout) {
  const soEntries = zip.entries.filter((entry) => !entry.isDirectory && layout.libPattern.test(entry.name));
  const abis = unique(soEntries.map((entry) => layout.libPattern.exec(entry.name)?.[1]).filter(Boolean));
  const sortedAbis = ABIS.filter((abi) => abis.includes(abi)).concat(abis.filter((abi) => !ABIS.includes(abi)));

  const libraries = [];
  const parseTargets = [...soEntries].sort((a, b) => {
    const aArm = /arm64-v8a/.test(a.name) ? 0 : 1;
    const bArm = /arm64-v8a/.test(b.name) ? 0 : 1;
    return aArm - bArm || b.size - a.size;
  }).slice(0, MAX_LIBRARIES_PARSED);

  for (const entry of parseTargets) {
    try {
      const buffer = zip.readEntry(entry);
      const elf = parseElf(buffer);
      if (!elf) continue;
      libraries.push({
        name: path.basename(entry.name),
        path: entry.name,
        abi: layout.libPattern.exec(entry.name)?.[1] || '',
        size: entry.size,
        size_human: formatBytes(entry.size),
        arch: elf.arch,
        bits: elf.bits,
        endian: elf.endian,
        type: elf.type,
        os_abi: elf.os_abi,
        dependencies: elf.dependencies,
        dependency_count: elf.dependency_count,
        soname: elf.soname,
        rpath: elf.rpath,
        stripped: elf.stripped,
        symbol_count: elf.symbol_count,
        section_count: elf.section_count,
        security: elf.security
      });
    } catch (error) {
      libraries.push({
        name: path.basename(entry.name),
        path: entry.name,
        abi: layout.libPattern.exec(entry.name)?.[1] || '',
        size: entry.size,
        size_human: formatBytes(entry.size),
        error: error.message
      });
    }
  }

  const totalSize = soEntries.reduce((sum, entry) => sum + entry.size, 0);

  return {
    abis: sortedAbis,
    abi_count: sortedAbis.length,
    so_files: soEntries.map((entry) => ({
      name: entry.name,
      abi: layout.libPattern.exec(entry.name)?.[1] || '',
      size: entry.size,
      size_human: formatBytes(entry.size)
    })),
    so_count: soEntries.length,
    so_total_size: totalSize,
    so_total_size_human: formatBytes(totalSize),
    libraries,
    parsed_count: libraries.length,
    has_native_code: soEntries.length > 0,
    note: soEntries.length > MAX_LIBRARIES_PARSED
      ? `共 ${soEntries.length} 个原生库，已解析体积最大的 ${MAX_LIBRARIES_PARSED} 个（优先 arm64-v8a）`
      : ''
  };
}

// ==================== 代码扫描（网络 / 隐私） ====================

const CLEARTEXT_URL_PATTERN = /http:\/\/[A-Za-z0-9][A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]{3,180}/g;
const TRUST_ALL_MARKERS = [
  'TrustAllCerts', 'ALLOW_ALL_HOSTNAME_VERIFIER', 'AllowAllHostnameVerifier',
  'NullHostnameVerifier', 'checkClientTrusted', 'checkServerTrusted',
  'X509TrustManager', 'setHostnameVerifier', 'InsecureTrustManager',
  'NoopHostnameVerifier', 'trustAllCerts', 'ALLOW_ALL_HOSTNAME'
];
const DEVICE_ID_MARKERS = [
  { label: 'IMEI', markers: ['getImei', 'getDeviceId', 'imei', 'getImeiOrMeid'] },
  { label: 'IMSI', markers: ['getSubscriberId', 'imsi', 'getSimOperator'] },
  { label: 'MAC 地址', markers: ['getMacAddress', 'getHardwareAddress', 'wifiMac', 'macAddress'] },
  { label: 'Android ID', markers: ['getAndroidId', 'android_id', 'ANDROID_ID', 'Settings$Secure'] },
  { label: '序列号', markers: ['Build.getSerial', 'getSerial', 'ro.serialno'] },
  { label: 'OAID', markers: ['oaid', 'OAID', 'getOAID', 'msa.OaidClient'] },
  { label: 'GAID/AAID', markers: ['getAdvertisingId', 'AdvertisingIdClient', 'gaid'] },
  { label: 'ICCID', markers: ['getSimSerialNumber', 'iccid'] },
  { label: '剪贴板', markers: ['getPrimaryClip', 'ClipboardManager', 'setPrimaryClip'] },
  { label: '应用列表', markers: ['getInstalledPackages', 'getInstalledApplications', 'queryIntentActivities'] },
  { label: '位置', markers: ['getLastKnownLocation', 'requestLocationUpdates', 'getLatitude'] },
  { label: '通讯录', markers: ['ContactsContract', 'content://com.android.contacts'] },
  { label: '短信', markers: ['content://sms', 'SmsMessage', 'Telephony.Sms'] }
];

function scanCodeStrings(text) {
  const cleartextUrls = [];
  if (text) {
    const seen = new Set();
    let match = CLEARTEXT_URL_PATTERN.exec(text);
    while (match) {
      const url = match[0].replace(/[.,;)'"]+$/, '');
      const host = url.replace(/^https?:\/\//, '').split(/[/:?#]/)[0];
      if (host && !seen.has(host) && !/^(schemas\.android\.com|www\.w3\.org|example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2)/.test(host)) {
        seen.add(host);
        cleartextUrls.push(url);
      }
      if (cleartextUrls.length >= 60) break;
      match = CLEARTEXT_URL_PATTERN.exec(text);
    }
    CLEARTEXT_URL_PATTERN.lastIndex = 0;
  }

  const trustAllEvidence = text ? TRUST_ALL_MARKERS.filter((marker) => text.includes(marker)) : [];
  const deviceIdentifiers = [];
  const identifierEvidence = {};
  if (text) {
    for (const item of DEVICE_ID_MARKERS) {
      const hits = item.markers.filter((marker) => text.includes(marker));
      if (hits.length) {
        deviceIdentifiers.push(item.label);
        identifierEvidence[item.label] = hits;
      }
    }
  }

  const privacyPolicyUrls = text
    ? unique((text.match(/https?:\/\/[^\s"'<>\\)\]}]*?(?:privacy|privacy-policy|隐私)[^\s"'<>\\)\]}]*/gi) || []).slice(0, 10))
    : [];

  const httpHosts = unique(cleartextUrls.map((url) => url.replace(/^https?:\/\//, '').split(/[/:?#]/)[0]));

  return {
    cleartext_urls: cleartextUrls,
    cleartext_host_count: httpHosts.length,
    cleartext_hosts: httpHosts.slice(0, 30),
    has_trust_all: trustAllEvidence.length > 0,
    trust_all_evidence: trustAllEvidence,
    device_identifiers: deviceIdentifiers,
    identifier_evidence: identifierEvidence,
    privacy_policy_urls: privacyPolicyUrls,
    https_url_count: text ? (text.match(/https:\/\//g) || []).length : 0
  };
}

// ==================== 主流程 ====================

function detectContainerKind(zip) {
  if (zip.find('AndroidManifest.xml')) return 'apk';
  if (zip.find('base/manifest/AndroidManifest.xml')) return 'aab';
  if (zip.match(/^Payload\/[^/]+\.app\/Info\.plist$/).length) return 'ipa';
  // 退化判断：有 classes.dex 视为 APK
  if (zip.match(/^classes\d*\.dex$/).length) return 'apk';
  return null;
}

/**
 * 解析 Android 包体（APK / AAB）。
 * @param {string} filePath
 * @param {{kind?: 'apk'|'aab'}} [options]
 */
function parseAndroidPackage(filePath, options = {}) {
  const startedAt = Date.now();
  const report = makeProgressReporter(options.onProgress);
  report(2, '打开包体容器');
  const stat = fs.statSync(filePath);
  const zip = openZip(filePath);
  const warnings = [];

  try {
    const kind = options.kind || detectContainerKind(zip) || 'apk';
    const layout = CONTAINER_LAYOUTS[kind] || CONTAINER_LAYOUTS.apk;
    report(8, `识别容器类型：${layout.label}`, `${zip.entries.length} 个条目`);
    const digests = computeFileDigests(filePath);
    report(16, '计算文件摘要（SHA-256 / SHA-1 / MD5）');

    // ---------- Manifest ----------
    let manifestResult = null;
    let identity = null;
    let components = null;
    let permissions = null;
    report(24, '解析 AndroidManifest.xml');
    try {
      manifestResult = parseManifestNode(zip, layout);
      identity = buildAppIdentity(manifestResult.root);
      components = buildComponents(manifestResult.root);
      permissions = buildPermissions(manifestResult.root);
    } catch (error) {
      warnings.push(`Manifest 解析失败: ${error.message}`);
    }

    // ---------- 资源 ----------
    let arsc = null;
    report(34, '解析资源表 resources.arsc');
    if (layout.arscPath && zip.find(layout.arscPath)) {
      try {
        arsc = parseArsc(zip.readEntry(layout.arscPath));
      } catch (error) {
        warnings.push(`resources.arsc 解析失败: ${error.message}`);
      }
    }

    // ---------- 应用名 ----------
    report(40, '解析应用名称与多语言标签');
    let appLabel = identity?.application?.label || '';
    let labelByLocale = {};
    if (appLabel.startsWith('@') || !appLabel) {
      const resId = identity?.application?.labelResId?.resId;
      if (resId && arsc) {
        const resolved = arsc.resolve(resId);
        if (resolved?.valueText) appLabel = resolved.valueText;
        labelByLocale = collectLabelLocales(arsc, resId);
      }
    }
    if (!appLabel && identity?.application?.name) appLabel = identity.application.name;

    // 把 @ref 形式的 networkSecurityConfig 还原成实际 XML 路径
    if (arsc && identity?.application?.networkSecurityConfigResId) {
      const resolved = arsc.resolve(identity.application.networkSecurityConfigResId.resId);
      if (resolved?.valueText) identity.application.networkSecurityConfigPath = resolved.valueText;
    }

    const icon = identity ? resolveIcon(zip, arsc, identity) : null;

    // ---------- 签名 ----------
    report(46, '解析签名信息（v1 / v2 / v3）');
    let signature = null;
    try {
      signature = parseApkSignature(zip);
    } catch (error) {
      warnings.push(`签名解析失败: ${error.message}`);
    }

    // ---------- DEX ----------
    report(56, '解析 DEX 字节码');
    const dexEntries = zip.entries.filter((entry) => !entry.isDirectory && layout.dexPattern.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    const dexBuffers = [];
    const stringChunks = [];
    let dexIndex = 0;
    for (const entry of dexEntries) {
      dexIndex += 1;
      report(56 + Math.round((dexIndex / Math.max(dexEntries.length, 1)) * 10), `解析 DEX 字节码（${dexIndex}/${dexEntries.length}）`, entry.name);
      try {
        const buffer = zip.readEntry(entry);
        dexBuffers.push({ name: entry.name, buffer });
        if (stringChunks.join('\n').length < MAX_STRING_TEXT) {
          stringChunks.push(readDexStrings(buffer, 200000).join('\n'));
        }
      } catch (error) {
        warnings.push(`读取 ${entry.name} 失败: ${error.message}`);
      }
    }
    const dexInfo = dexBuffers.length ? analyzeDexFiles(dexBuffers) : null;

    // ---------- 原生库 ----------
    report(70, '解析原生库（.so）');
    const native = buildNative(zip, layout);

    // ---------- 代码扫描 ----------
    report(78, '扫描代码特征（URL / 密钥 / 域名）');
    const codeText = stringChunks.join('\n').slice(0, MAX_STRING_TEXT);
    const network = scanCodeStrings(codeText);

    // ---------- SDK / 加固 ----------
    report(85, '识别第三方 SDK 与加固方案');
    const sources = [
      { type: 'text', value: zip.entries.map((entry) => entry.name).join('\n'), label: '包内路径' },
      { type: 'text', value: codeText, label: 'DEX 字符串' },
      { type: 'text', value: native.so_files.map((item) => item.name).join('\n'), label: '原生库' }
    ];
    const sdks = detectSdks(sources);
    const packer = detectPacker(sources, dexInfo);
    const hardening = detectHardening(sources);

    // ---------- 隐私 ----------
    report(89, '分析隐私与合规项');
    const privacy = buildPrivacy(identity, permissions, network, sdks);

    // ---------- 体积 / 清单 ----------
    report(92, '统计体积分布与文件清单');
    const sizeAnalysis = buildSizeAnalysis(zip.entries);
    const inventory = buildFileInventory(zip, layout);

    // ---------- 风险 ----------
    report(96, '评估安全风险评分');
    const risk = evaluateRisk({
      platform: 'android',
      signature,
      manifest: identity,
      permissions: permissions ? permissions.all : [],
      components,
      dex: dexInfo,
      native,
      packer,
      hardening,
      privacy,
      sdks,
      abis: native.abis,
      network
    });

    // ---------- 基本信息 ----------
    const basic = {
      file: {
        name: path.basename(filePath),
        path: filePath,
        type: layout.label,
        container: `${layout.label}（ZIP 容器）`,
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
        name: appLabel || '未知',
        identifier: identity?.packageName || '未知',
        version_name: identity?.versionName || '未知',
        version_code: identity?.versionCode ?? '未知',
        version_display: identity ? `${identity.versionName || '?'} (${identity.versionCode || '?'})` : '未知',
        min_os: identity?.minSdkVersion !== '' && identity?.minSdkVersion != null
          ? `Android ${sdkToAndroidVersion(identity.minSdkVersion)} (API ${identity.minSdkVersion})`
          : '未知',
        target_os: identity?.targetSdkVersion !== '' && identity?.targetSdkVersion != null
          ? `API ${identity.targetSdkVersion}`
          : '未知',
        min_sdk: identity?.minSdkVersion ?? null,
        target_sdk: identity?.targetSdkVersion ?? null,
        abis: native.abis,
        icon: icon ? icon.data_url : null,
        icon_path: icon ? icon.path : null
      },
      signature: {
        signed: Boolean(signature?.signed),
        type: signature?.scheme_label || '未签名',
        schemes: signature?.signed_schemes || [],
        v1_present: signature?.v1?.present ?? false,
        v1_stale: signature?.v1?.stale ?? false,
        v1_stale_note: signature?.v1?.stale ? (signature.v1.stale_reason || '') : '',
        debug: signature?.summary?.is_debug ?? null,
        subject: signature?.summary?.subject || '',
        issuer: signature?.summary?.issuer || '',
        sha256: signature?.summary?.sha256 || '',
        algorithm: signature?.summary?.signature_algorithm || '',
        key_size: signature?.summary?.public_key?.keySizeLabel || '',
        not_before: signature?.summary?.not_before || null,
        not_after: signature?.summary?.not_after || null,
        expired: signature?.summary?.is_expired ?? null,
        weak: signature?.summary?.is_weak_algorithm ?? null,
        certificate_count: signature?.summary?.certificate_count || 0
      },
      structure: {
        dex_count: dexInfo ? dexInfo.dex_count : 0,
        dex_method_count: dexInfo ? dexInfo.method_count : 0,
        so_count: native.so_count,
        abis: native.abis,
        permission_count: permissions ? permissions.requested_count : 0,
        dangerous_permission_count: permissions ? permissions.dangerous_count : 0,
        component_count: components ? components.total : 0,
        exported_component_count: components ? components.exported : 0,
        activity_count: components ? components.activities.length : 0,
        service_count: components ? components.services.length : 0,
        receiver_count: components ? components.receivers.length : 0,
        provider_count: components ? components.providers.length : 0,
        locale_count: arsc ? arsc.locales.length : 0,
        resource_count: arsc ? arsc.resourceCount : 0,
        sdk_count: sdks.length,
        packed: packer.is_packed,
        packed_by: packer.packer_name,
        obfuscated: dexInfo ? dexInfo.obfuscated : null
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
          file_ext: path.extname(filePath).toLowerCase(),
          file_size_bytes: digests.size,
          file_size_human: formatBytes(digests.size),
          mime_type: 'application/vnd.android.package-archive',
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
          entry_count: zip.entries.length,
          top_level_directories: unique(zip.entries.map((entry) => entry.name.split('/')[0])).sort(),
          dex_files: inventory.dex,
          so_files: inventory.so.map((name) => name.split('/').pop()),
          assets: inventory.assets.slice(0, 200),
          assets_count: inventory.assets.length,
          res_dirs: unique(zip.entries.filter((entry) => entry.name.startsWith(layout.resPrefix)).map((entry) => entry.name.split('/').slice(0, 2).join('/'))).slice(0, 60),
          meta_inf: inventory.meta_inf,
          signature_files: zip.match(/^META-INF\/[^/]+\.(RSA|DSA|EC|SF)$/i).map((entry) => entry.name),
          file_types: sizeByExtension(zip.entries).slice(0, 30)
        },
        size_analysis: sizeAnalysis
      },
      '2.2': {
        title: '应用标识（Android）',
        ...(identity || {}),
        application: identity?.application || null,
        compile_sdk: identity?.compileSdkVersion ?? null,
        platform_build_version: identity ? `${identity.platformBuildVersionName || '?'} (${identity.platformBuildVersionCode ?? '?'})` : null
      },
      '2.4': {
        title: '应用元数据',
        label: appLabel,
        label_by_locale: labelByLocale,
        label_locale_count: Object.keys(labelByLocale).length,
        icon: icon ? {
          resource_id: icon.resource_id,
          resource_name: icon.resource_name || null,
          path: icon.path,
          mime_type: icon.mime_type,
          size: icon.size,
          size_human: icon.size_human,
          sha256: icon.sha256,
          variants: icon.variants,
          note: icon.note
        } : null,
        round_icon: identity?.application?.roundIcon || null,
        banner: identity?.application?.banner || null,
        logo: identity?.application?.logo || null,
        theme: identity?.application?.theme || null,
        description: identity?.application?.description || null,
        app_category: null,
        privacy_policy_url: privacy.privacy_policy_urls[0] || null,
        privacy_policy_urls: privacy.privacy_policy_urls,
        support_url: null,
        market_url: identity?.packageName ? `https://play.google.com/store/apps/details?id=${identity.packageName}` : null,
        update_url: null
      },
      '2.5': {
        title: '构建与签名信息',
        signing_type: signature?.scheme_label || '未签名',
        signed: Boolean(signature?.signed),
        v1_signed: signature?.v1?.signed ?? false,
        v1_present: signature?.v1?.present ?? false,
        v1_stale: signature?.v1?.stale ?? false,
        v1_note: signature?.v1?.stale ? (signature.v1.stale_reason || '') : '',
        v2_signed: signature?.v2?.signed ?? false,
        v3_signed: signature?.v3?.signed ?? false,
        v3_1_signed: signature?.v3_1?.signed ?? false,
        v4_signed: signature?.v4?.signed ?? false,
        v4_note: signature?.v4?.note || '',
        signing_block: signature?.signing_block || null,
        is_debug: signature?.summary?.is_debug ?? null,
        is_expired: signature?.summary?.is_expired ?? null,
        is_self_signed: signature?.summary?.is_self_signed ?? null,
        is_weak_alg: signature?.summary?.is_weak_algorithm ?? null,
        v2_v3_consistent: signature?.summary?.v2_v3_consistent ?? null,
        cert_chain: signature?.certificate_chain || [],
        signers: signature?.certificates || [],
        v1_detail: signature?.v1 || null,
        v2_signers: signature?.v2?.signers || [],
        v3_signers: signature?.v3?.signers || [],
        build_info: {
          build_tools_version: identity?.buildToolsVersion || null,
          compile_sdk_version: identity?.compileSdkVersion || null,
          platform_build_version_name: identity?.platformBuildVersionName || null,
          platform_build_version_code: identity?.platformBuildVersionCode ?? null,
          aab_bundletool: options.bundleConfig || null
        }
      },
      '2.6': {
        title: '权限（Android）',
        requested: permissions?.requested || [],
        granted: [],
        custom: permissions?.custom || [],
        requested_count: permissions?.requested_count || 0,
        dangerous_count: permissions?.dangerous_count || 0,
        special_count: permissions?.special_count || 0,
        signature_count: permissions?.signature_count || 0,
        normal_count: permissions?.normal_count || 0,
        by_group: groupPermissions(permissions?.requested || [])
      },
      '2.8': {
        title: '组件（Android）',
        activities: components?.activities || [],
        activity_aliases: components?.activityAliases || [],
        services: components?.services || [],
        receivers: components?.receivers || [],
        providers: components?.providers || [],
        custom_permissions: components?.customPermissions || [],
        total: components?.total || 0,
        exported: components?.exported || 0,
        unprotected_exported: components?.unprotectedExported || 0,
        with_intent_filter: components?.withIntentFilter || 0,
        deep_links: unique([...(components?.activities || []), ...(components?.services || []), ...(components?.receivers || [])].flatMap((item) => item.deepLinks)),
        app_links: unique([...(components?.activities || [])].flatMap((item) => item.appLinks)),
        schemes: unique((components?.activities || []).flatMap((item) => item.intentFilters.flatMap((filter) => filter.schemes)))
      },
      '2.10': {
        title: 'DEX / 字节码',
        ...(dexInfo || { dex_count: 0, dex_files: [], note: '未发现 DEX 文件' })
      },
      '2.11': {
        title: 'Native / SO',
        ...native,
        elf_bits: native.libraries[0]?.bits ?? null,
        elf_endian: native.libraries[0]?.endian ?? null,
        elf_arch: native.libraries[0]?.arch ?? null
      },
      '2.12': {
        title: '资源',
        ...buildResources(zip, layout, arsc)
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
        countries: countBy(sdks, 'sdk_country')
      },
      '2.15': {
        title: '安全与风险',
        risk_score: risk.score,
        risk_level: risk.level,
        risk_level_label: risk.level_label,
        counts: risk.counts,
        findings: risk.findings.map((finding) => ({ ...finding, evidence: finding.evidence })),
        by_category: countBy(risk.findings, 'category'),
        top: risk.top
      },
      '2.16': {
        title: '隐私与合规',
        ...privacy
      },
      '2.17': {
        title: '加固与混淆',
        ...packer,
        hardening,
        hardening_enabled: Object.entries(hardening).filter(([, value]) => value).map(([key]) => key)
      },
      '2.19': {
        title: '原始数据（供高级用户）',
        manifest_raw_available: Boolean(manifestResult),
        manifest_format: manifestResult ? (manifestResult.format === 'binary' ? '二进制 XML（AXML）' : '文本 XML') : null,
        manifest_size: manifestResult ? manifestResult.buffer.length : 0,
        manifest_xml: manifestResult ? axml.serializeXml(manifestResult.root) : null,
        manifest_sha256: manifestResult
          ? require('crypto').createHash('sha256').update(manifestResult.buffer).digest('hex')
          : null,
        arsc_raw: arsc ? {
          version: arsc.versionLabel,
          size: arsc.buffer.length,
          package_count: arsc.packages.length,
          global_string_count: arsc.globalStrings.stringCount
        } : null,
        certificates_raw: (signature?.certificates || []).map((cert) => ({
          subject: cert.subject,
          sha256: cert.sha256,
          sha1: cert.sha1,
          md5: cert.md5,
          der_length: cert.der_length
        })),
        dex_headers: dexInfo ? dexInfo.dex_files.map((file) => ({
          name: file.name,
          version: file.version,
          checksum: file.checksum,
          signature_sha1: file.signature_sha1
        })) : [],
        zip_entries_full: inventory.entries.length
      }
    };

    report(99, '整理输出结构');
    return {
      platform: 'android',
      container: layout.kind,
      basic,
      detailed,
      warnings,
      elapsed_ms: Date.now() - startedAt
    };
  } finally {
    zip.close();
  }
}

// ==================== 辅助 ====================

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

function groupPermissions(permissions) {
  const groups = {};
  for (const item of permissions) {
    const key = item.group || 'OTHER';
    const bucket = groups[key] || { group: key, count: 0, dangerous: 0, names: [] };
    bucket.count += 1;
    if (item.dangerous) bucket.dangerous += 1;
    bucket.names.push(item.name);
    groups[key] = bucket;
  }
  return Object.values(groups).sort((a, b) => b.count - a.count);
}

function collectLabelLocales(arsc, resId) {
  const { splitResourceId } = require('./res-chunk');
  const { packageId, typeId, entryId } = splitResourceId(resId);
  const variants = arsc.collectVariants(typeId, entryId, packageId || null);
  const result = {};
  for (const variant of variants) {
    if (!variant.locale || !variant.valueText) continue;
    result[variant.locale] = variant.valueText;
  }
  return result;
}

const ANDROID_VERSIONS = {
  1: '1.0', 2: '1.1', 3: '1.5', 4: '1.6', 5: '2.0', 6: '2.0.1', 7: '2.1', 8: '2.2',
  9: '2.3', 10: '2.3.3', 11: '3.0', 12: '3.1', 13: '3.2', 14: '4.0', 15: '4.0.3',
  16: '4.1', 17: '4.2', 18: '4.3', 19: '4.4', 20: '4.4W', 21: '5.0', 22: '5.1',
  23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10',
  30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16'
};

function sdkToAndroidVersion(sdk) {
  const level = Number(sdk);
  if (!Number.isFinite(level)) return String(sdk);
  return ANDROID_VERSIONS[level] || `API ${level}`;
}

function buildPrivacy(identity, permissions, network, sdks) {
  const label = identity?.application?.label || '';
  const childrenKeywords = /儿童|宝宝|幼儿|小学|亲子|kids|child/i;
  const labelText = String(label);

  return {
    privacy_policy_url: network.privacy_policy_urls[0] || null,
    privacy_policy_urls: network.privacy_policy_urls,
    privacy_policy_present: network.privacy_policy_urls.length > 0,
    data_collected: network.device_identifiers,
    data_shared: sdks.filter((sdk) => sdk.sdk_category === '广告' || sdk.sdk_category === '统计').map((sdk) => sdk.sdk_name),
    data_encrypted: network.cleartext_urls.length === 0,
    cleartext_endpoint_count: network.cleartext_urls.length,
    data_deletion: null,
    tracking: sdks.some((sdk) => ['广告', '统计'].includes(sdk.sdk_category)),
    idfa: null,
    att: null,
    skadnetwork: null,
    imei: (network.identifier_evidence.IMEI || []).length > 0,
    imsi: (network.identifier_evidence.IMSI || []).length > 0,
    mac: (network.identifier_evidence['MAC 地址'] || []).length > 0,
    oaid: (network.identifier_evidence.OAID || []).length > 0,
    android_id: (network.identifier_evidence['Android ID'] || []).length > 0,
    gaid: (network.identifier_evidence['GAID/AAID'] || []).length > 0,
    iccid: (network.identifier_evidence.ICCID || []).length > 0,
    serial: (network.identifier_evidence['序列号'] || []).length > 0,
    clipboard: (network.identifier_evidence['剪贴板'] || []).length > 0,
    installed_apps: (network.identifier_evidence['应用列表'] || []).length > 0,
    children_app: childrenKeywords.test(labelText),
    age_rating: null,
    gdpr: null,
    ccpa: null,
    pipl: null,
    data_localization: null,
    cross_border: sdks.some((sdk) => sdk.sdk_country && sdk.sdk_country !== '中国') ? '存在境外 SDK，需评估数据出境' : '未发现境外 SDK',
    identifier_evidence: network.identifier_evidence,
    network: {
      cleartext_urls: network.cleartext_urls,
      cleartext_hosts: network.cleartext_hosts,
      https_url_count: network.https_url_count,
      has_trust_all: network.has_trust_all,
      trust_all_evidence: network.trust_all_evidence
    }
  };
}

/** 解析 AAB 的 BundleConfig.pb，取出 bundletool 版本等信息。 */
function parseAabBundleConfig(zip) {
  const entry = zip.find('BundleConfig.pb');
  if (!entry) return null;
  try {
    const parsed = parseProtobuf(zip.readEntry(entry));
    const bundletool = parsed[1] && parsed[1][0] && typeof parsed[1][0] === 'object' ? parsed[1][0] : null;
    return {
      bundletool_version: bundletool && bundletool[1] ? String(bundletool[1][0]) : null,
      bundle_version: parsed[2] ? String(parsed[2][0]) : null,
      compression_algorithm: parsed[3] ? String(parsed[3][0]) : null,
      raw_field_count: Object.keys(parsed).length
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  parseAndroidPackage,
  parseAabBundleConfig,
  detectContainerKind,
  CONTAINER_LAYOUTS,
  buildAppIdentity,
  buildComponents,
  buildPermissions,
  scanCodeStrings,
  sdkToAndroidVersion,
  ANDROID_VERSIONS
};
