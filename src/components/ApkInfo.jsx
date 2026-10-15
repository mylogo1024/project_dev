import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ProgressBar, ToastStack, useToasts, useElapsed } from './common/Feedback';
import { copyTextWithToast } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

/** 拼接 class，自动丢掉空值，避免出现多余空格。 */
const cx = (...parts) => parts.filter(Boolean).join(' ');

// ==================== 最近打开记录 ====================
const RECENT_KEY = 'pi-recent-packages';
const RECENT_LIMIT = 8;

/** 读取最近打开过的包体列表（本地持久化，不上传）。 */
function readRecentFiles() {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item) => item && item.path).slice(0, RECENT_LIMIT) : [];
  } catch (_) {
    return [];
  }
}

/** 记录一次打开（去重后置顶）。 */
function rememberRecentFile(filePath) {
  if (!filePath) return;
  try {
    const name = String(filePath).split(/[\\/]/).pop() || filePath;
    const list = readRecentFiles().filter((item) => item.path !== filePath);
    list.unshift({ path: filePath, name, at: Date.now() });
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
  } catch (_) {
    // localStorage 不可用时静默降级
  }
}

// ==================== 字段中文标签 ====================
// 覆盖文档 2.1~2.19 中出现的主要字段；未覆盖的自动按 key 美化
const FIELD_LABELS = {
  // 文件
  file_path: '文件路径', file_name: '文件名', file_ext: '扩展名', file_size_bytes: '大小（字节）',
  file_size_human: '文件大小', mime_type: 'MIME 类型', created_at: '创建时间', modified_at: '修改时间',
  accessed_at: '访问时间', sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5', entropy: '信息熵',
  magic_bytes: '魔数', zip_comment: 'ZIP 注释', zip_entries: 'ZIP 条目数', zip64: 'ZIP64',
  encrypted: '加密', split: '分卷',
  // 结构
  entry_count: '条目总数', top_level_directories: '顶层目录', dex_files: 'DEX 文件',
  so_files: '原生库', assets: 'assets 资源', assets_count: 'assets 数量', res_dirs: 'res 目录',
  meta_inf: 'META-INF', signature_files: '签名文件', file_types: '文件类型统计',
  app_root: 'App 根目录', app_bundle_name: 'App Bundle 名', executable: '可执行文件',
  frameworks: 'Frameworks', dylibs: '动态库', extensions: '扩展', watch_apps: 'Watch App',
  app_clips: 'App Clips',
  // 体积
  total_size: '总大小', total_size_human: '总大小', total_compressed: '压缩后',
  total_compressed_human: '压缩后', overall_ratio: '整体压缩率', file_count: '文件数',
  directory_count: '目录数', by_category: '按分类', by_extension: '按扩展名',
  by_directory: '按目录', top_10_largest: '最大的 10 个文件', compressible: '可压缩性',
  // 标识
  packageName: '包名', versionName: '版本名称', versionCode: '版本号',
  versionCodeMajor: '主版本号', minSdkVersion: '最小 SDK', targetSdkVersion: '目标 SDK',
  maxSdkVersion: '最大 SDK', compileSdkVersion: '编译 SDK',
  compileSdkVersionCodename: '编译 SDK 代号', platformBuildVersionCode: '平台构建版本号',
  platformBuildVersionName: '平台构建版本名', buildToolsVersion: '构建工具版本',
  installLocation: '安装位置', sharedUserId: '共享 UID', sharedUserLabel: '共享 UID 标签',
  revisionCode: '修订号', isSplitRequired: '需要拆分安装', isFeatureSplit: '功能拆分',
  requiredFeature: '必需特性', optionalFeature: '可选特性', requiredLibrary: '必需库',
  optionalLibrary: '可选库', nativeLibrary: '原生库声明', supportsScreens: '支持屏幕',
  compatibleScreens: '兼容屏幕', queriesPackages: '查询的包', application: 'application 节点',
  compile_sdk: '编译 SDK', platform_build_version: '平台构建版本',
  CFBundleIdentifier: 'Bundle ID', CFBundleName: 'Bundle 名称', CFBundleDisplayName: '显示名称',
  CFBundleExecutable: '可执行文件', CFBundleVersion: 'Build 号',
  CFBundleShortVersionString: '版本名称', CFBundlePackageType: '包类型',
  CFBundleSignature: '包签名', CFBundleInfoDictionaryVersion: 'Info.plist 版本',
  CFBundleDevelopmentRegion: '开发区域', CFBundleIconFiles: '图标文件',
  CFBundleIconName: '图标名称', CFBundleURLTypes: 'URL Scheme',
  MinimumOSVersion: '最低 iOS 版本', Platform: '平台', SupportedPlatforms: '支持的平台',
  UIDeviceFamily: '设备类型', LSRequiresIPhoneOS: '仅 iPhone OS', UIRequiredDeviceCapabilities: '必需设备能力',
  UIUserInterfaceStyle: '界面风格', UILaunchStoryboardName: '启动页',
  UISupportedInterfaceOrientations: '支持方向', UISupportedInterfaceOrientationsForIpad: 'iPad 支持方向',
  DTPlatformName: 'DT 平台名', DTSDKName: 'DT SDK', DTXcode: 'Xcode 版本',
  DTXcodeBuild: 'Xcode Build', DTCompiler: '编译器', DTPlatformVersion: 'DT 平台版本',
  DTAppStoreToolsBuild: 'App Store 工具版本', BuildMachineOSBuild: '构建机系统版本',
  ITSAppUsesNonExemptEncryption: '使用非豁免加密', LSApplicationCategoryType: '应用分类',
  LSMinimumSystemVersion: '最低系统版本', UIRequiresFullScreen: '需要全屏',
  UIStatusBarHidden: '隐藏状态栏', UIFileSharingEnabled: '启用文件共享',
  LSSupportsOpeningDocumentsInPlace: '原地打开文档', UIApplicationSupportsIndirectInputEvents: '支持间接输入',
  CADisableMinimumFrameDurationOnPhone: '禁用最小帧时长', raw_keys: '原始键数量',
  // 元数据
  label: '应用名称', label_by_locale: '多语言名称', label_locale_count: '语言数',
  icon: '图标', round_icon: '圆形图标', banner: 'Banner', logo: 'Logo', theme: '主题',
  description: '描述', app_category: '应用分类', privacy_policy_url: '隐私政策',
  privacy_policy_urls: '隐私政策链接', support_url: '支持链接', market_url: '市场链接',
  update_url: '更新链接', url_schemes: 'URL Scheme', associated_domains: '关联域名',
  resource_id: '资源 ID', resource_name: '资源名', path: '路径', variants: '变体', note: '说明',
  // 签名
  signed: '已签名', signing_type: '签名类型', signing_type_note: '签名类型说明',
  v1_signed: 'v1 签名', v2_signed: 'v2 签名', v3_signed: 'v3 签名', v3_1_signed: 'v3.1 签名',
  v1_present: 'v1 签名文件', v1_stale: 'v1 已失效', v1_note: 'v1 失效原因',
  v4_signed: 'v4 签名', v4_note: 'v4 说明', signing_block: 'APK Signing Block',
  is_debug: '调试签名', is_expired: '已过期', is_self_signed: '自签名', is_weak_alg: '弱算法',
  v2_v3_consistent: 'v2/v3 一致', cert_chain: '证书链', signers: '签名者',
  v1_detail: 'v1 详情', v2_signers: 'v2 签名者', v3_signers: 'v3 签名者',
  build_info: '构建信息', subject: '主题', subject_cn: '主题 CN', subject_org: '主题组织',
  subject_ou: '主题 OU', subject_country: '主题国家', issuer: '颁发者', issuer_cn: '颁发者 CN',
  issuer_org: '颁发者组织', serial: '序列号', serial_hex: '序列号（HEX）',
  not_before: '生效时间', not_after: '失效时间', signature_algorithm: '签名算法',
  public_key: '公钥', version: '版本', scheme: '签名方案', der_length: 'DER 长度',
  team_identifier: 'Team ID', application_identifier: 'App Identifier',
  bundle_identifier_from_entitlement: 'Bundle ID（entitlement）', entitlements: '授权项',
  provisioned_devices: '已授权设备', provisioned_device_count: '设备数量',
  provisions_all_devices: '授权全部设备', expiration_date: '过期时间', creation_date: '创建时间',
  provision_name: '描述文件名', provision_team_name: '团队名称', provision_uuid: '描述文件 UUID',
  provision_platform: '描述文件平台', certificate_chain: '证书链', code_resources: 'CodeResources',
  get_task_allow: '允许调试（get-task-allow）', aps_environment: '推送环境', icloud: 'iCloud',
  keychain_groups: 'Keychain 分组', binary: '二进制', code_signature: '代码签名',
  identifier: '标识', blob_count: 'Blob 数量', flags: '标志', flag_names: '标志名称',
  hash_type: '哈希类型', page_size: '页大小', code_slots: '代码槽', special_slots: '特殊槽',
  cms_length: 'CMS 长度', key_size_label: '密钥长度', key_size: '密钥长度',
  algorithm: '算法', curve: '曲线', is_expired_cert: '证书过期',
  // 权限
  requested: '申请权限', granted: '已授权', custom: '自定义权限', requested_count: '申请数量',
  dangerous_count: '危险权限数', special_count: '特殊权限数', signature_count: '签名级权限数',
  normal_count: '普通权限数', by_group: '按分组', usage_descriptions: '用途说明',
  usage_description_count: '用途说明数量', by_key: '按键', background_modes: '后台模式',
  privacy_manifest: '隐私清单', sensitive_capabilities: '敏感能力',
  missing_usage_descriptions: '缺少用途说明', group: '分组', count: '数量', dangerous: '危险',
  names: '权限列表', protectionLevel: '保护级别',
  usesPermissionFlags: '权限标志', permissionGroup: '权限组', known: '已知权限',
  kind: '类型', key: '键', present: '存在', value: '值',
  // 组件
  activities: 'Activity', activity_aliases: 'Activity Alias', services: 'Service',
  receivers: 'BroadcastReceiver', providers: 'ContentProvider', custom_permissions: '自定义权限',
  total: '总计', exported: '导出', unprotected_exported: '导出且无保护',
  with_intent_filter: '含 Intent Filter', deep_links: 'Deep Link', app_links: 'App Link',
  schemes: 'Scheme', intentFilters: 'Intent Filter', metaData: 'meta-data',
  hasIntentFilter: '含 Intent Filter', launchMode: '启动模式', screenOrientation: '屏幕方向',
  configChanges: '配置变更', taskAffinity: '任务栈', excludeFromRecents: '排除最近任务',
  clearTaskOnLaunch: '启动时清空任务', noHistory: '不留历史', stateNotNeeded: '无需保存状态',
  alwaysRetainTaskState: '始终保留任务', finishOnTaskLaunch: '启动时结束',
  directBootAware: '直接启动感知', isAlias: '别名', foregroundServiceType: '前台服务类型',
  isolatedProcess: '独立进程', process: '进程', permission: '权限', enabled: '启用',
  framework_count: '框架数量', dylib_count: '动态库数量', swift_version: 'Swift 版本',
  cocoapods: 'CocoaPods', spm: 'SPM', flutter: 'Flutter', react_native: 'React Native',
  unity: 'Unity', cordova: 'Cordova', ionic: 'Ionic', capacitor: 'Capacitor',
  xamarin: 'Xamarin', cocos2d: 'Cocos2d', detected_frameworks: '识别的框架',
  app_extension: 'App Extension', extension_count: '扩展数量', watch_app: 'Watch App',
  linked_libraries: '链接的系统库',
  // DEX / 原生
  dex_count: 'DEX 数量', multidex: '多 DEX', main_dex: '主 DEX', method_count: '方法数',
  class_count: '类数', field_count: '字段数', string_count: '字符串数', type_count: '类型数',
  proto_count: '原型数', method_limit_usage: '方法数上限占用', multidex_required: '需要多 DEX',
  short_class_ratio: '短类名占比', obfuscated: '已混淆', sample_class_names: '类名样本',
  class_name_sample_size: '类名样本量', data_size: '数据区大小', checksum: '校验和',
  signature_sha1: '签名 SHA-1',
  abis: 'ABI', abi_count: 'ABI 数量', so_count: '原生库数量', so_total_size: '原生库总大小',
  so_total_size_human: '原生库总大小', libraries: '原生库', parsed_count: '已解析数量',
  has_native_code: '含原生代码', elf_bits: '位数', elf_endian: '字节序', elf_arch: '架构',
  arch: '架构', bits: '位数', endian: '字节序', type: '类型', os_abi: 'OS ABI',
  dependencies: '依赖库', dependency_count: '依赖数量', soname: 'SONAME', rpath: 'RPATH',
  stripped: '已剥离符号', symbol_count: '符号数', section_count: '节区数', security: '安全特性',
  pie: 'PIE', nx: 'NX', canary: '栈保护（Canary）', relro: 'RELRO', relro_full: '完整 RELRO',
  bind_now: '立即绑定', no_heap_execution: '禁止堆执行', two_level_namespace: '两级命名空间',
  code_signed: '已代码签名', binary_path: '二进制路径', architectures: '架构切片',
  fat: 'Fat 二进制', slice_count: '切片数量', macho: 'Mach-O 头', cryptid: '加密标识',
  bitcode: 'Bitcode', linked_library_count: '链接库数量', embedded_dylibs: '内嵌动态库',
  cputype: 'CPU 类型', cpusubtype: 'CPU 子类型', uuid: 'UUID', file_type: '文件类型',
  platform: '平台', min_os_version: '最低系统版本', sdk_version: 'SDK 版本',
  source_version: '源码版本', load_command_count: '加载命令数', segments: '段',
  load_commands: '加载命令', min_os: '最低系统',
  // 资源
  available: '可解析', locales: '语言', locale_count: '语言数量', densities: '密度',
  resource_count: '资源条目数', type_stats: '资源类型统计', counts: '数量统计',
  arsc_version: 'resources.arsc 版本', arsc_size: 'resources.arsc 大小',
  arsc_size_human: 'resources.arsc 大小', global_string_count: '全局字符串数',
  package_count: '包数量', packages: '资源包', res_file_count: 'res 文件数',
  res_total_size: 'res 总大小', by_type: '按类型', asset_catalogs: 'Asset Catalog',
  storyboards: 'Storyboard', launch_images: '启动图', icon_sets: '图标集',
  strings_files: 'strings 文件', strings_count: '字符串数', assets_car_present: 'Assets.car',
  strings: '字符串', colors: '颜色', dimens: '尺寸', styles: '样式', themes: '主题',
  drawables: 'Drawable', mipmaps: 'Mipmap', layouts: '布局', anims: '动画', xml: 'XML',
  raw: 'raw', arrays: '数组', entry_count_res: '条目数', config_count: '配置数',
  id: 'ID', name: '名称', extension: '扩展名', size: '大小', size_human: '大小',
  // 文件清单
  res: 'res', lib: 'lib', kotlin: 'Kotlin 元数据', okhttp: 'OkHttp 缓存', json: 'JSON',
  db: '数据库', html: 'HTML', js: 'JS', css: 'CSS', fonts: '字体', images: '图片',
  dex: 'DEX', so: 'SO', top_files: '最大的文件', file_tree: '文件树', entries: '文件条目',
  entries_truncated: '条目已截断', compressed_size: '压缩后大小', method: '压缩方式',
  crc32: 'CRC32', is_directory: '目录',
  // SDK
  sdks: 'SDK 列表', sdk_count: 'SDK 数量', categories: '分类统计', vendors: '厂商统计',
  countries: '国家统计', sdk_name: 'SDK 名称', sdk_category: '分类',
  sdk_vendor: '厂商', sdk_country: '国家', sdk_website: '官网', sdk_license: '授权',
  sdk_platform: '平台', sdk_evidence: '识别依据', sdk_risk: '风险', sdk_privacy: '隐私说明',
  // 风险
  risk_score: '风险分', risk_level: '风险等级', risk_level_label: '风险等级',
  findings: '风险项', top: 'Top 风险', severity: '级别',
  confidence: '置信度', message: '问题描述', evidence: '依据', remediation: '修复建议',
  cwe: 'CWE', owasp: 'OWASP', critical: '严重', high: '高', medium: '中', low: '低', info: '提示',
  score: '风险分', level: '等级', level_label: '等级', packed: '已加固', packed_by: '加固厂商',
  // 隐私
  privacy_policy_present: '存在隐私政策', data_collected: '采集的数据', data_shared: '共享的数据',
  data_encrypted: '数据加密', cleartext_endpoint_count: '明文端点数量', data_deletion: '数据删除',
  tracking: '追踪', idfa: 'IDFA', att: 'ATT', att_description: 'ATT 说明',
  skadnetwork: 'SKAdNetwork', skadnetwork_items: 'SKAdNetwork 条目', imei: 'IMEI', imsi: 'IMSI',
  mac: 'MAC 地址', oaid: 'OAID', android_id: 'Android ID', gaid: 'GAID', iccid: 'ICCID',
  clipboard: '剪贴板', installed_apps: '已安装应用列表', children_app: '儿童应用',
  children: '儿童应用', age_rating: '年龄分级', gdpr: 'GDPR', ccpa: 'CCPA', pipl: 'PIPL',
  data_localization: '数据本地化', cross_border: '数据出境', identifier_evidence: '标识采集依据',
  network: '网络', cleartext_urls: '明文 URL', cleartext_hosts: '明文主机',
  https_url_count: 'HTTPS URL 数量', has_trust_all: '信任所有证书',
  trust_all_evidence: '信任所有证书依据', app_transport_security: 'ATS 配置',
  allows_arbitrary_loads: '允许任意加载', allows_arbitrary_loads_in_web_content: 'Web 内容允许任意加载',
  allows_arbitrary_loads_for_media: '媒体允许任意加载', allows_local_networking: '允许本地网络',
  exception_domains: '例外域名', privacy_manifest_present: '存在隐私清单',
  usage_descriptions_missing: '缺少用途说明',
  // 加固
  is_packed: '已加固', suspected: '疑似加固', packer_name: '加固方案', packer_vendor: '加固厂商',
  packer_version: '加固版本', packer_evidence: '加固依据', matches: '匹配特征',
  is_obfuscated: '已混淆', obfuscation_level: '混淆程度', hardening: '加固特性',
  hardening_enabled: '已启用的加固特性', anti_debug: '反调试', anti_vm: '反虚拟机',
  anti_root: '反 Root', string_encryption: '字符串加密', integrity_check: '完整性校验',
  // 原始数据
  manifest_raw_available: 'Manifest 可读', manifest_format: 'Manifest 格式',
  manifest_size: 'Manifest 大小', manifest_xml: 'Manifest XML', manifest_sha256: 'Manifest SHA-256',
  arsc_raw: 'resources.arsc', certificates_raw: '证书原始信息', dex_headers: 'DEX 头',
  zip_entries_full: 'ZIP 条目数', info_plist_raw_size: 'Info.plist 大小',
  info_plist_json: 'Info.plist JSON', entitlements_raw: 'Entitlements 原始',
  provision_raw: '描述文件原始', provision_keys: '描述文件键', macho_headers: 'Mach-O 头',
  privacy_manifest_raw: '隐私清单原始'
};

const prettify = (key) => String(key)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const labelOf = (key) => FIELD_LABELS[key] || prettify(key);

// ==================== 通用工具 ====================
const isNil = (v) => v === null || v === undefined;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const fmtScalar = (v) => {
  if (isNil(v) || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return String(v);
};

const SEVERITY = {
  critical: { label: '严重', cls: 'pi-sev--critical' },
  high: { label: '高', cls: 'pi-sev--high' },
  medium: { label: '中', cls: 'pi-sev--medium' },
  low: { label: '低', cls: 'pi-sev--low' },
  info: { label: '提示', cls: 'pi-sev--info' }
};
const sevMeta = (s) => SEVERITY[s] || SEVERITY.info;

const RISK_TONE = {
  critical: '#d93025', high: '#e8710a', medium: '#f9ab00', low: '#1e8e3e', none: '#5f6368'
};

// ==================== 通用展示组件 ====================

/** 键值网格 */
function FieldGrid({ data, keys, exclude }) {
  const list = useMemo(() => {
    if (!isObj(data)) return [];
    const ks = keys || Object.keys(data);
    return ks
      .filter((k) => !exclude || !exclude.includes(k))
      .filter((k) => {
        const v = data[k];
        return !Array.isArray(v) && !isObj(v);
      })
      .map((k) => [k, data[k]]);
  }, [data, keys, exclude]);

  if (!list.length) return null;
  return (
    <div className="pi-fields">
      {list.map(([k, v]) => (
        <div className="pi-field" key={k}>
          <div className="pi-field-label">{labelOf(k)}</div>
          <div className={`pi-field-value ${typeof v === 'string' && v.length > 60 ? 'pi-mono' : ''}`}>
            {fmtScalar(v)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 对象数组 → 键值（用于嵌套对象） */
function SubObject({ title, data, exclude }) {
  if (!isObj(data)) return null;
  const scalarKeys = Object.keys(data).filter((k) => !Array.isArray(data[k]) && !isObj(data[k]));
  const arrayKeys = Object.keys(data).filter((k) => Array.isArray(data[k]) && data[k].length);
  const objKeys = Object.keys(data).filter((k) => isObj(data[k]));
  if (!scalarKeys.length && !arrayKeys.length && !objKeys.length) return null;

  return (
    <div className="pi-sub">
      {title ? <div className="pi-sub-title">{title}</div> : null}
      <FieldGrid data={data} keys={scalarKeys} exclude={exclude} />
      {arrayKeys.map((k) => (
        <div className="pi-sub-block" key={k}>
          <div className="pi-sub-label">{labelOf(k)}</div>
          <Chips items={data[k]} />
        </div>
      ))}
      {objKeys.map((k) => (
        <SubObject key={k} title={labelOf(k)} data={data[k]} exclude={exclude} />
      ))}
    </div>
  );
}

/** 标签块 */
function Chips({ items, tone }) {
  const list = (items || []).filter((x) => !isNil(x) && x !== '');
  if (!list.length) return <span className="pi-empty-inline">无</span>;
  return (
    <div className="pi-chips">
      {list.map((item, i) => (
        <span className={`pi-chip ${tone ? `pi-chip--${tone}` : ''}`} key={`${String(item).slice(0, 40)}-${i}`}>
          {typeof item === 'object' ? fmtScalar(item.name ?? item.label ?? JSON.stringify(item)) : fmtScalar(item)}
        </span>
      ))}
    </div>
  );
}

/**
 * 通用表格
 * columns: [{ k, t, w, r }]  r: sev | bool | num | mono | list | risk | icon
 */
function DataTable({ rows, columns, empty = '暂无数据', limit = 80, dense }) {
  const [expanded, setExpanded] = useState(false);
  const list = rows || [];
  if (!list.length) return <div className="pi-empty">{empty}</div>;
  const shown = expanded ? list : list.slice(0, limit);

  const renderCell = (row, col) => {
    const v = row[col.k];
    switch (col.r) {
      case 'sev': {
        const m = sevMeta(v);
        return <span className={`pi-sev ${m.cls}`}>{m.label}</span>;
      }
      case 'bool':
        return isNil(v) ? '—' : (v ? <span className="pi-yes">是</span> : <span className="pi-no">否</span>);
      case 'risk': {
        if (!v || v === '一般' || v === '低') return <span className="pi-sev pi-sev--info">{v || '—'}</span>;
        return <span className="pi-sev pi-sev--medium">{v}</span>;
      }
      case 'num':
        return isNil(v) ? '—' : Number(v).toLocaleString('en-US');
      case 'mono':
        return isNil(v) || v === '' ? '—' : <span className="pi-mono" title={String(v)}>{String(v)}</span>;
      case 'list': {
        const arr = Array.isArray(v) ? v : (isNil(v) || v === '' ? [] : [v]);
        if (!arr.length) return '—';
        return <span className="pi-cell-list" title={arr.join('\n')}>{arr.slice(0, 3).join('、')}{arr.length > 3 ? ` +${arr.length - 3}` : ''}</span>;
      }
      default:
        return isNil(v) || v === '' ? '—' : <span title={String(v)}>{String(v)}</span>;
    }
  };

  return (
    <>
      <div className="pi-table-wrap">
        <table className={`pi-table ${dense ? 'pi-table--dense' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.k} style={c.w ? { width: c.w } : undefined}>{c.t || labelOf(c.k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={row.id || row.name || row.sdk_name || row.path || i}>
                {columns.map((c) => (
                  <td key={c.k}>{renderCell(row, c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > limit ? (
        <button className="pi-more" type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `展开其余 ${list.length - limit} 条（共 ${list.length} 条）`}
        </button>
      ) : null}
    </>
  );
}

/** 横向条形图 */
function BarList({ items, nameKey = 'name', humanKey = 'size_human', valueKey = 'size', max }) {
  const list = items || [];
  if (!list.length) return <div className="pi-empty">暂无数据</div>;
  const peak = max || Math.max(...list.map((x) => Number(x[valueKey]) || 0), 1);
  return (
    <div className="pi-bars">
      {list.map((item, i) => {
        const v = Number(item[valueKey]) || 0;
        const pct = Math.max((v / peak) * 100, 1.5);
        return (
          <div className="pi-bar-row" key={`${item[nameKey]}-${i}`}>
            <div className="pi-bar-name" title={String(item[nameKey])}>{String(item[nameKey])}</div>
            <div className="pi-bar-track">
              <div className="pi-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="pi-bar-val">{item[humanKey] ?? v}</div>
          </div>
        );
      })}
    </div>
  );
}

/** 布尔特性网格 */
function BoolGrid({ data, labels }) {
  if (!isObj(data)) return null;
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <div className="pi-bool-grid">
      {entries.map(([k, v]) => (
        <div className={`pi-bool ${v ? 'pi-bool--on' : 'pi-bool--off'}`} key={k}>
          <span className="pi-bool-dot" />
          <span className="pi-bool-label">{labels?.[k] || labelOf(k)}</span>
          <span className="pi-bool-val">{v ? '启用' : '未启用'}</span>
        </div>
      ))}
    </div>
  );
}

/** 文件树 */
function Tree({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  if (!node) return null;
  const children = node.children || [];
  const hasChildren = children.length > 0;
  return (
    <div className="pi-tree-node" style={{ paddingLeft: depth ? 14 : 0 }}>
      <div className="pi-tree-label">
        {hasChildren ? (
          <button className="pi-tree-toggle" type="button" onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="pi-tree-toggle pi-tree-toggle--leaf">·</span>
        )}
        <span className="pi-tree-name" title={node.path}>{node.name || '(根)'}</span>
        <span className="pi-tree-size">{node.size != null ? `${(node.size / 1024).toFixed(1)} KB` : ''}</span>
      </div>
      {open && hasChildren
        ? children.map((child, i) => <Tree key={child.path || `${child.name}-${i}`} node={child} depth={depth + 1} />)
        : null}
    </div>
  );
}

/** 折叠面板 */
function Collapse({ title, count, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`pi-collapse ${open ? 'is-open' : ''}`}>
      <button className="pi-collapse-head" type="button" onClick={() => setOpen(!open)}>
        <span className="pi-collapse-arrow">{open ? '▾' : '▸'}</span>
        <span className="pi-collapse-title">{title}</span>
        {count != null ? <span className="pi-collapse-count">{count}</span> : null}
      </button>
      {open ? <div className="pi-collapse-body">{children}</div> : null}
    </div>
  );
}

/** JSON / 代码块 */
function CodeBlock({ value, maxHeight = 420 }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    // 复制失败时不再假装成功（原来是 try/catch 静默吞掉）
    const result = await copyTextWithToast(text);
    if (!result.ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="pi-code-wrap">
      <button className="pi-copy-btn" type="button" onClick={copy}>{copied ? '已复制' : '复制'}</button>
      <pre className="pi-code" style={{ maxHeight }}>{text}</pre>
    </div>
  );
}

/** 风险环 */
function RiskRing({ score, level }) {
  const size = 132;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const safe = Math.max(0, Math.min(100, Number(score) || 0));
  const color = RISK_TONE[level] || '#5f6368';
  return (
    <svg className="pi-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef0f4" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(safe / 100) * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="47%" textAnchor="middle" className="pi-ring-score" fill={color}>{safe}</text>
      <text x="50%" y="66%" textAnchor="middle" className="pi-ring-label">风险分</text>
    </svg>
  );
}

// ==================== 各分类渲染配置 ====================

const A = (k, t, extra = {}) => ({ k, t, ...extra });

const SECTION_TABLES = {
  '2.5': [
    { key: 'cert_chain', title: '证书链', cols: [A('subject', '主题'), A('issuer', '颁发者'), A('signature_algorithm', '算法'), A('not_after', '失效时间'), A('sha256', 'SHA-256', { r: 'mono', w: 150 })] },
    { key: 'signers', title: '签名者', cols: [A('subject', '主题'), A('scheme', '方案'), A('signature_algorithm', '算法'), A('sha256', 'SHA-256', { r: 'mono', w: 150 })] },
    { key: 'v2_signers', title: 'v2 签名者', cols: [A('subject', '主题'), A('signature_algorithm', '算法'), A('sha256', 'SHA-256', { r: 'mono' })] },
    { key: 'v3_signers', title: 'v3 签名者', cols: [A('subject', '主题'), A('signature_algorithm', '算法'), A('sha256', 'SHA-256', { r: 'mono' })] },
    { key: 'certificate_chain', title: '证书链', cols: [A('subject', '主题'), A('issuer', '颁发者'), A('key_size_label', '密钥'), A('not_after', '失效时间'), A('sha256', 'SHA-256', { r: 'mono', w: 150 })] }
  ],
  '2.6': [
    { key: 'requested', title: '申请的权限', cols: [A('name', '权限名', { r: 'mono' }), A('group', '分组', { w: 90 }), A('protectionLevel', '保护级别', { w: 110 }), A('dangerous', '危险', { r: 'bool', w: 60 }), A('description', '说明')] },
    { key: 'by_group', title: '按分组统计', cols: [A('group', '分组', { w: 110 }), A('count', '数量', { r: 'num', w: 70 }), A('dangerous', '危险数', { r: 'num', w: 70 }), A('names', '权限', { r: 'list' })] }
  ],
  '2.7': [
    { key: 'usage_descriptions', title: '用途说明', cols: [A('key', '键', { r: 'mono', w: 240 }), A('label', '能力', { w: 110 }), A('value', '说明')] }
  ],
  '2.8': [
    { key: 'activities', title: 'Activity', cols: [A('name', '名称', { r: 'mono' }), A('exported', '导出', { r: 'bool', w: 60 }), A('permission', '权限', { r: 'mono', w: 150 }), A('hasIntentFilter', 'Intent', { r: 'bool', w: 60 }), A('deepLinks', 'Deep Link', { r: 'list', w: 150 })] },
    { key: 'activity_aliases', title: 'Activity Alias', cols: [A('name', '名称', { r: 'mono' }), A('exported', '导出', { r: 'bool', w: 60 }), A('targetActivity', '目标 Activity', { r: 'mono' })] },
    { key: 'services', title: 'Service', cols: [A('name', '名称', { r: 'mono' }), A('exported', '导出', { r: 'bool', w: 60 }), A('permission', '权限', { r: 'mono', w: 150 }), A('foregroundServiceType', '前台类型', { w: 110 })] },
    { key: 'receivers', title: 'BroadcastReceiver', cols: [A('name', '名称', { r: 'mono' }), A('exported', '导出', { r: 'bool', w: 60 }), A('permission', '权限', { r: 'mono', w: 150 })] },
    { key: 'providers', title: 'ContentProvider', cols: [A('name', '名称', { r: 'mono' }), A('exported', '导出', { r: 'bool', w: 60 }), A('authorities', 'authorities', { r: 'list' }), A('permission', '权限', { r: 'mono', w: 130 })] },
    { key: 'custom_permissions', title: '自定义权限', cols: [A('name', '名称', { r: 'mono' }), A('protectionLevel', '保护级别', { w: 110 })] },
    { key: 'deep_links', title: 'Deep Link', cols: [A('scheme', 'Scheme', { w: 100 }), A('host', 'Host'), A('path', 'Path'), A('component', '组件', { r: 'mono' })] },
    { key: 'app_links', title: 'App Link', cols: [A('scheme', 'Scheme', { w: 100 }), A('host', 'Host'), A('component', '组件', { r: 'mono' })] }
  ],
  '2.9': [
    { key: 'frameworks', title: '内嵌框架', cols: [A('name', '名称', { r: 'mono' }), A('file_count', '文件数', { r: 'num', w: 80 }), A('size_human', '大小', { w: 100 }), A('path', '路径', { r: 'mono' })] },
    { key: 'dylibs', title: '动态库', cols: [A('name', '名称', { r: 'mono' }), A('size_human', '大小', { w: 100 })] },
    { key: 'detected_frameworks', title: '识别的框架', cols: [A('name', '名称'), A('version', '版本', { w: 110 })] },
    { key: 'app_extension', title: 'App Extension', cols: [A('name', '名称', { r: 'mono' }), A('bundle_id', 'Bundle ID', { r: 'mono' })] }
  ],
  '2.10': [
    { key: 'dex_files', title: 'DEX 文件', cols: [A('name', '文件', { r: 'mono', w: 120 }), A('size_human', '大小', { w: 90 }), A('version', '版本', { w: 70 }), A('method_count', '方法数', { r: 'num' }), A('class_count', '类数', { r: 'num' }), A('field_count', '字段数', { r: 'num' }), A('string_count', '字符串数', { r: 'num' }), A('signature_sha1', '签名 SHA-1', { r: 'mono', w: 140 })] }
  ],
  '2.11': [
    { key: 'libraries', title: '原生库（已解析）', cols: [A('name', '库名', { r: 'mono' }), A('abi', 'ABI', { w: 100 }), A('size_human', '大小', { w: 90 }), A('arch', '架构', { w: 90 }), A('bits', '位数', { w: 60 }), A('stripped', '已剥离', { r: 'bool', w: 70 }), A('dependency_count', '依赖数', { r: 'num', w: 70 })] },
    { key: 'so_files', title: '原生库清单', cols: [A('name', '库名', { r: 'mono' }), A('abi', 'ABI', { w: 110 }), A('size_human', '大小', { w: 100 })] },
    { key: 'architectures', title: '架构切片', cols: [A('arch', '架构', { w: 110 }), A('cputype', 'CPU 类型', { r: 'num' }), A('cpusubtype', 'CPU 子类型', { r: 'num' }), A('size_human', '大小', { w: 100 })] }
  ],
  '2.12': [
    { key: 'type_stats', title: '资源类型统计', cols: [A('name', '类型', { r: 'mono', w: 160 }), A('entry_count', '条目数', { r: 'num' }), A('config_count', '配置数', { r: 'num' })] },
    { key: 'packages', title: '资源包', cols: [A('id', 'ID', { w: 70 }), A('name', '包名', { r: 'mono' }), A('type_count', '类型数', { r: 'num', w: 80 })] },
    { key: 'densities', title: '屏幕密度', cols: [A('name', '密度', { w: 120 }), A('dpi', 'DPI', { r: 'num', w: 80 }), A('entry_count', '条目数', { r: 'num' })] },
    { key: 'by_type', title: '按类型统计', cols: [A('extension', '类型', { r: 'mono' }), A('count', '数量', { r: 'num', w: 80 }), A('size_human', '大小', { w: 100 })] }
  ],
  '2.13': [
    { key: 'top_files', title: '最大的文件', cols: [A('name', '路径', { r: 'mono' }), A('size_human', '大小', { w: 110 })] },
    { key: 'entries', title: '文件条目', cols: [A('name', '路径', { r: 'mono' }), A('size', '大小', { r: 'num', w: 100 }), A('compressed_size', '压缩后', { r: 'num', w: 100 }), A('method', '压缩方式', { w: 90 }), A('crc32', 'CRC32', { r: 'mono', w: 100 })] }
  ],
  '2.14': [
    { key: 'sdks', title: '识别到的 SDK', cols: [A('sdk_name', 'SDK', { w: 170 }), A('sdk_category', '分类', { w: 90 }), A('sdk_vendor', '厂商', { w: 130 }), A('sdk_country', '国家', { w: 80 }), A('sdk_platform', '平台', { w: 80 }), A('sdk_risk', '风险', { r: 'risk', w: 90 }), A('sdk_evidence', '识别依据', { r: 'list' })] }
  ],
  '2.17': [
    { key: 'matches', title: '匹配到的加固特征', cols: [A('name', '特征', { r: 'mono' }), A('marker', '标记', { r: 'mono' }), A('source', '来源', { w: 120 })] }
  ],
  '2.19': [
    { key: 'certificates_raw', title: '证书原始信息', cols: [A('subject', '主题'), A('sha256', 'SHA-256', { r: 'mono' }), A('der_length', 'DER 长度', { r: 'num', w: 100 })] },
    { key: 'dex_headers', title: 'DEX 头', cols: [A('name', '文件', { r: 'mono' }), A('version', '版本', { w: 80 }), A('checksum', '校验和', { r: 'num' }), A('signature_sha1', '签名 SHA-1', { r: 'mono' })] },
    { key: 'macho_headers', title: 'Mach-O 头', cols: [A('path', '路径', { r: 'mono' }), A('arch', '架构', { w: 90 }), A('file_type', '类型', { w: 110 }), A('uuid', 'UUID', { r: 'mono' }), A('segments', '段数', { r: 'num', w: 70 })] }
  ]
};

/** 各分类中需要以「子对象」形式展示的字段 */
const SECTION_SUBOBJECTS = {
  '2.1': ['file', 'structure', 'size_analysis'],
  '2.2': ['application'],
  '2.4': ['icon', 'round_icon', 'banner', 'logo'],
  '2.5': ['signing_block', 'v1_detail', 'build_info', 'binary', 'code_signature'],
  '2.9': [],
  '2.11': ['macho', 'security'],
  '2.12': ['counts'],
  '2.15': [],
  '2.16': ['network', 'app_transport_security', 'privacy_manifest', 'identifier_evidence'],
  '2.17': ['hardening'],
  '2.19': ['arsc_raw', 'provision_raw', 'info_plist_json', 'entitlements_raw', 'privacy_manifest_raw']
};

/** 各分类中需要以「标签块」形式展示的数组字段 */
const SECTION_CHIPS = {
  '2.1': ['top_level_directories', 'dex_files', 'so_files', 'res_dirs', 'meta_inf', 'signature_files'],
  '2.2': ['requiredFeature', 'optionalFeature', 'requiredLibrary', 'optionalLibrary', 'nativeLibrary', 'queriesPackages'],
  '2.3': ['SupportedPlatforms', 'UIRequiredDeviceCapabilities', 'UISupportedInterfaceOrientations'],
  '2.4': ['privacy_policy_urls', 'url_schemes'],
  '2.6': [],
  '2.7': ['background_modes', 'sensitive_capabilities', 'missing_usage_descriptions'],
  '2.8': ['schemes'],
  '2.9': ['linked_libraries'],
  '2.10': ['sample_class_names'],
  '2.11': ['abis'],
  '2.12': ['locales', 'launch_images', 'icon_sets', 'strings_files', 'asset_catalogs'],
  '2.13': ['assets', 'res', 'lib', 'meta_inf', 'kotlin', 'okhttp', 'json', 'xml', 'db', 'html', 'js', 'css', 'fonts', 'dex', 'so'],
  '2.14': [],
  '2.15': [],
  '2.16': ['data_collected', 'data_shared'],
  '2.17': ['packer_evidence', 'hardening_enabled'],
  '2.19': ['provision_keys']
};

/** 体积分析专用渲染 */
function SizeAnalysis({ data }) {
  if (!isObj(data)) return null;
  return (
    <>
      <FieldGrid data={data} exclude={['by_category', 'by_extension', 'by_directory', 'top_10_largest', 'compressible']} />
      {data.compressible ? (
        <div className="pi-sub-block">
          <div className="pi-sub-label">可压缩性</div>
          <FieldGrid data={data.compressible} />
        </div>
      ) : null}
      {Array.isArray(data.by_category) && data.by_category.length ? (
        <div className="pi-sub-block">
          <div className="pi-sub-label">按分类体积</div>
          <BarList items={data.by_category} nameKey="name" humanKey="size_human" valueKey="size" />
        </div>
      ) : null}
      {Array.isArray(data.by_extension) && data.by_extension.length ? (
        <div className="pi-sub-block">
          <div className="pi-sub-label">按扩展名体积</div>
          <BarList items={data.by_extension} nameKey="name" humanKey="size_human" valueKey="size" />
        </div>
      ) : null}
      {Array.isArray(data.top_10_largest) && data.top_10_largest.length ? (
        <div className="pi-sub-block">
          <div className="pi-sub-label">最大的 10 个文件</div>
          <DataTable rows={data.top_10_largest} columns={[A('name', '路径', { r: 'mono' }), A('size_human', '大小', { w: 110 })]} limit={10} />
        </div>
      ) : null}
    </>
  );
}

/** 隐私布尔项 */
function PrivacyFlags({ data }) {
  const keys = ['tracking', 'idfa', 'att', 'skadnetwork', 'imei', 'imsi', 'mac', 'oaid', 'android_id', 'gaid', 'iccid', 'serial', 'clipboard', 'installed_apps', 'children_app', 'children', 'data_encrypted'];
  const present = keys.filter((k) => k in data);
  if (!present.length) return null;
  return <BoolGrid data={Object.fromEntries(present.map((k) => [k, data[k]]))} />;
}

/** 分类主体 */
function SectionBody({ sectionId, data }) {
  if (!isObj(data)) return <div className="pi-empty">该分类暂无数据</div>;

  const tables = SECTION_TABLES[sectionId] || [];
  const tableKeys = new Set(tables.map((t) => t.key));
  const subKeys = SECTION_SUBOBJECTS[sectionId] || [];
  const chipKeys = SECTION_CHIPS[sectionId] || [];
  const handled = new Set([...tableKeys, ...subKeys, ...chipKeys]);

  // 未显式处理的标量字段
  const scalarKeys = Object.keys(data).filter(
    (k) => k !== 'title' && !handled.has(k) && !Array.isArray(data[k]) && !isObj(data[k])
  );
  // 未显式处理的其它对象 / 数组
  const otherObjects = Object.keys(data).filter(
    (k) => k !== 'title' && !handled.has(k) && isObj(data[k])
  );
  const otherArrays = Object.keys(data).filter(
    (k) => k !== 'title' && !handled.has(k) && Array.isArray(data[k]) && data[k].length
  );

  return (
    <div className="pi-section-body">
      {/* 风险分类：先展示概览 */}
      {sectionId === '2.15' ? <RiskOverview data={data} /> : null}
      {sectionId === '2.16' ? <PrivacyFlags data={data} /> : null}
      {sectionId === '2.17' ? <BoolGrid data={data.hardening} /> : null}

      {scalarKeys.length ? <FieldGrid data={data} keys={scalarKeys} /> : null}

      {/* 特殊：体积分析 */}
      {sectionId === '2.1' && isObj(data.size_analysis) ? (
        <Collapse title="体积分析" defaultOpen>
          <SizeAnalysis data={data.size_analysis} />
        </Collapse>
      ) : null}

      {/* 子对象 */}
      {subKeys.filter((k) => k !== 'size_analysis').map((k) => {
        if (!isObj(data[k])) return null;
        return (
          <Collapse key={k} title={labelOf(k)} defaultOpen={sectionId === '2.1' && k === 'file'}>
            <SubObject data={data[k]} />
          </Collapse>
        );
      })}

      {/* 标签块 */}
      {chipKeys.map((k) => {
        const v = data[k];
        if (!Array.isArray(v) || !v.length) return null;
        return (
          <div className="pi-sub-block" key={k}>
            <div className="pi-sub-label">{labelOf(k)} <span className="pi-sub-count">{v.length}</span></div>
            <Chips items={v} />
          </div>
        );
      })}

      {/* 表格 */}
      {tables.map((t) => {
        const rows = data[t.key];
        if (!Array.isArray(rows) || !rows.length) return null;
        return (
          <div className="pi-sub-block" key={t.key}>
            <div className="pi-sub-label">{t.title} <span className="pi-sub-count">{rows.length}</span></div>
            <DataTable rows={rows} columns={t.cols} />
          </div>
        );
      })}

      {/* 未处理的对象 */}
      {otherObjects.map((k) => (
        <Collapse key={k} title={labelOf(k)}>
          <SubObject data={data[k]} />
        </Collapse>
      ))}

      {/* 未处理的数组 */}
      {otherArrays.map((k) => {
        const v = data[k];
        const isObjArray = v.length && isObj(v[0]);
        if (isObjArray) {
          const cols = Object.keys(v[0]).slice(0, 8).map((ck) => A(ck, labelOf(ck)));
          return (
            <div className="pi-sub-block" key={k}>
              <div className="pi-sub-label">{labelOf(k)} <span className="pi-sub-count">{v.length}</span></div>
              <DataTable rows={v} columns={cols} />
            </div>
          );
        }
        return (
          <div className="pi-sub-block" key={k}>
            <div className="pi-sub-label">{labelOf(k)} <span className="pi-sub-count">{v.length}</span></div>
            <Chips items={v} />
          </div>
        );
      })}

      {/* 原始数据特殊展示 */}
      {sectionId === '2.19' ? <RawSection data={data} /> : null}

      {!scalarKeys.length && !tables.some((t) => Array.isArray(data[t.key]) && data[t.key].length)
        && !subKeys.some((k) => isObj(data[k])) && !chipKeys.some((k) => Array.isArray(data[k]) && data[k].length)
        && !otherObjects.length && !otherArrays.length && sectionId !== '2.15'
        ? <div className="pi-empty">该分类暂无数据</div>
        : null}
    </div>
  );
}

/** 风险概览 */
function RiskOverview({ data }) {
  const counts = data.counts || {};
  const findings = data.findings || [];
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  return (
    <div className="pi-risk-overview">
      <div className="pi-risk-head">
        <RiskRing score={data.risk_score} level={data.risk_level} />
        <div className="pi-risk-side">
          <div className="pi-risk-level" style={{ color: RISK_TONE[data.risk_level] || '#5f6368' }}>
            {data.risk_level_label || '—'}
          </div>
          <div className="pi-risk-counts">
            {order.map((k) => (
              <div className="pi-risk-count" key={k}>
                <span className={`pi-sev ${sevMeta(k).cls}`}>{sevMeta(k).label}</span>
                <strong>{counts[k] ?? 0}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
      {findings.length ? (
        <div className="pi-findings">
          {findings.map((f) => (
            <div className={`pi-finding pi-finding--${f.severity}`} key={f.id}>
              <div className="pi-finding-head">
                <span className={`pi-sev ${sevMeta(f.severity).cls}`}>{sevMeta(f.severity).label}</span>
                <span className="pi-finding-cat">{f.category}</span>
                {f.confidence ? <span className="pi-finding-conf">置信度 {f.confidence}</span> : null}
                {f.cwe ? <span className="pi-finding-cwe">{f.cwe}</span> : null}
              </div>
              <div className="pi-finding-msg">{f.message}</div>
              {Array.isArray(f.evidence) && f.evidence.length ? (
                <div className="pi-finding-evidence">
                  {/* code-review-allow quality/no-index-key —— 解析结果的只读字符串数组，整体重算、无逐项状态 */}
                  {f.evidence.map((e, i) => <code key={i}>{e}</code>)}
                </div>
              ) : null}
              {f.remediation ? <div className="pi-finding-fix">建议：{f.remediation}</div> : null}
            </div>
          ))}
        </div>
      ) : <div className="pi-empty">未发现风险项</div>}
    </div>
  );
}

/** 原始数据 */
function RawSection({ data }) {
  const { manifest_xml, info_plist_json, provision_raw, entitlements_raw, privacy_manifest_raw, arsc_raw } = data;
  const hasAny = manifest_xml || info_plist_json || provision_raw || entitlements_raw || arsc_raw;
  if (!hasAny) return null;
  return (
    <div className="pi-raw">
      {manifest_xml ? (
        <Collapse title="AndroidManifest.xml（解码后）" count={`${manifest_xml.length} 字符`}>
          <CodeBlock value={manifest_xml} />
        </Collapse>
      ) : null}
      {info_plist_json ? (
        <Collapse title="Info.plist" count={`${Object.keys(info_plist_json).length} 键`}>
          <CodeBlock value={info_plist_json} />
        </Collapse>
      ) : null}
      {entitlements_raw ? (
        <Collapse title="Entitlements" count={`${Object.keys(entitlements_raw).length} 键`}>
          <CodeBlock value={entitlements_raw} />
        </Collapse>
      ) : null}
      {provision_raw ? (
        <Collapse title="描述文件原始数据">
          <CodeBlock value={provision_raw} />
        </Collapse>
      ) : null}
      {privacy_manifest_raw ? (
        <Collapse title="PrivacyInfo.xcprivacy">
          <CodeBlock value={privacy_manifest_raw} />
        </Collapse>
      ) : null}
      {arsc_raw ? (
        <Collapse title="resources.arsc 概要">
          <CodeBlock value={arsc_raw} />
        </Collapse>
      ) : null}
    </div>
  );
}

// ==================== 概览页（文档 6.1） ====================
function BasicView({ info, onOpenDetail }) {
  const { basic } = info;
  const app = basic.app || {};
  const file = basic.file || {};
  const sig = basic.signature || {};
  const st = basic.structure || {};
  const risk = basic.risk || {};
  const isIos = info.platform === 'ios';

  // v1 签名文件在、摘要却对不上：包看着像有 v1 签名，其实已经失效。
  // 这时候不能只说「未签名」—— 得讲清楚是「签名失效」，否则用户会以为工具看错了。
  const sigStale = Boolean(sig.v1_stale);
  const sigValue = sig.signed
    ? (sig.type || '已签名')
    : (sigStale ? (sig.type || '签名无效') : '未签名');
  const sigSub = sigStale
    ? (sig.v1_stale_note || 'v1 签名文件已失效')
    : (sig.key_size
      ? `${sig.algorithm || ''} · ${sig.key_size}`
      : (sig.signed ? '' : '未检测到签名'));
  const sigTone = sigStale
    ? (sig.signed ? 'warn' : 'danger')
    : (!sig.signed ? 'danger' : (sig.debug || sig.expired || sig.weak ? 'warn' : 'ok'));

  const tiles = [
    {
      icon: '✍️', label: '签名',
      value: sigValue,
      sub: sigSub,
      tone: sigTone
    },
    {
      icon: '🔑', label: '权限',
      value: st.permission_count != null ? `${st.permission_count}` : '—',
      sub: st.dangerous_permission_count ? `其中危险 ${st.dangerous_permission_count} 个` : '无危险权限',
      tone: st.dangerous_permission_count > 5 ? 'danger' : (st.dangerous_permission_count ? 'warn' : 'ok')
    },
    {
      icon: '🧩', label: '组件',
      value: st.component_count != null ? `${st.component_count}` : '—',
      sub: st.exported_component_count ? `导出 ${st.exported_component_count} 个` : '无导出组件',
      tone: st.exported_component_count > 3 ? 'warn' : 'ok'
    },
    {
      icon: '🧿', label: '加固与混淆',
      value: st.packed ? (st.packed_by || '已加固') : '未加固',
      sub: st.obfuscated ? '代码已混淆' : '代码未混淆',
      tone: st.packed ? 'warn' : 'ok'
    }
  ];

  const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];

  return (
    <div className="pi-basic">
      {/* 头部 */}
      <div className="pi-hero">
        <div className="pi-hero-icon">
          {app.icon
            ? <img src={app.icon} alt="icon" />
            : <span className="pi-hero-icon-fallback">{isIos ? '🍎' : '🤖'}</span>}
        </div>
        <div className="pi-hero-main">
          <div className="pi-hero-title">
            <h3>{app.name || file.name || '未知应用'}</h3>
            <span className={`pi-badge pi-badge--${info.container || 'apk'}`}>{file.type || 'APK'}</span>
            {sig.debug ? <span className="pi-badge pi-badge--debug">调试版</span> : null}
          </div>
          <div className="pi-hero-id">{app.identifier || '—'}</div>
          <div className="pi-hero-meta">
            <span>版本名称 <b>{app.version_name || '—'}</b></span>
            <span>版本号 <b>{(isIos ? 'Build ' : '')}{(app.version_code && app.version_code !== '未知') ? app.version_code : '—'}</b></span>
            <span>{isIos ? '最低 iOS' : '最低 SDK'} <b>{app.min_os || '—'}</b></span>
            {app.target_os ? <span>目标 <b>{app.target_os}</b></span> : null}
            <span>大小 <b>{file.size_human || '—'}</b></span>
          </div>
          {Array.isArray(app.abis) && app.abis.length ? (
            <div className="pi-hero-abis">{app.abis.map((a) => <span className="pi-chip" key={a}>{a}</span>)}</div>
          ) : null}
        </div>
      </div>

      {/* 四宫格 */}
      <div className="pi-tiles">
        {tiles.map((t) => (
          <div className={`pi-tile pi-tile--${t.tone}`} key={t.label}>
            <div className="pi-tile-top">
              <span className="pi-tile-icon">{t.icon}</span>
              <span className="pi-tile-label">{t.label}</span>
            </div>
            <div className="pi-tile-value" title={String(t.value)}>{t.value}</div>
            <div className="pi-tile-sub">{t.sub || '\u00a0'}</div>
          </div>
        ))}
      </div>

      {/* 风险 + Top 3 */}
      <div className="pi-risk-row">
        <div className="pi-risk-card">
          <RiskRing score={risk.score} level={risk.level} />
          <div className="pi-risk-card-side">
            <div className="pi-risk-card-level" style={{ color: RISK_TONE[risk.level] || '#5f6368' }}>
              {risk.level_label || '—'}
            </div>
            <div className="pi-risk-legend">
              {sevOrder.map((k) => (
                <div className="pi-risk-legend-item" key={k}>
                  <span className={`pi-sev ${sevMeta(k).cls}`}>{sevMeta(k).label}</span>
                  <strong>{risk[k] ?? 0}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pi-top-risks">
          <div className="pi-top-risks-title">Top 风险</div>
          {Array.isArray(risk.top) && risk.top.length ? (
            risk.top.map((t, i) => (
              /* code-review-allow quality/no-index-key —— 风险项是解析结果的只读数组，整体重算 */
              <div className="pi-top-risk" key={i}>
                <span className="pi-top-risk-idx">{i + 1}</span>
                <span className="pi-top-risk-text">{t}</span>
              </div>
            ))
          ) : <div className="pi-empty">未发现明显风险</div>}
        </div>
      </div>

      {/* 文件指纹 */}
      <div className="pi-file-card">
        <div className="pi-sub-label">文件信息</div>
        <div className="pi-file-grid">
          <div className="pi-file-item"><span>文件</span><b title={file.path}>{file.name}</b></div>
          <div className="pi-file-item"><span>容器</span><b>{file.container || file.type}</b></div>
          <div className="pi-file-item"><span>大小</span><b>{file.size_human}</b></div>
          <div className="pi-file-item"><span>条目数</span><b>{file.zip_entries}</b></div>
          <div className="pi-file-item"><span>信息熵</span><b>{file.entropy}</b></div>
          <div className="pi-file-item"><span>修改时间</span><b>{file.modified_at || '—'}</b></div>
          <div className="pi-file-item pi-file-item--wide"><span>SHA-256</span><b className="pi-mono">{file.sha256}</b></div>
          <div className="pi-file-item pi-file-item--wide"><span>SHA-1</span><b className="pi-mono">{file.sha1}</b></div>
          <div className="pi-file-item pi-file-item--wide"><span>MD5</span><b className="pi-mono">{file.md5}</b></div>
        </div>
      </div>

      <div className="pi-basic-actions">
        <button className="btn btn-secondary" type="button" onClick={onOpenDetail}>
          查看详细信息（{info.sections?.length || 0} 个分类）
        </button>
      </div>

      {Array.isArray(info.warnings) && info.warnings.length ? (
        <div className="pi-warnings">
          {/* code-review-allow quality/no-index-key —— 解析告警的只读数组，整体重算、无逐项状态 */}
          {info.warnings.map((w, i) => <div className="pi-warning" key={i}>⚠️ {w}</div>)}
        </div>
      ) : null}
    </div>
  );
}

// ==================== 详情页（文档 6.2） ====================
function DetailView({ info, initialSection }) {
  const sections = info.sections || [];
  const [active, setActive] = useState(initialSection || sections[0]?.id || '2.1');
  const [search, setSearch] = useState('');

  const counts = useMemo(() => {
    const map = {};
    for (const s of sections) {
      const d = info.detailed?.[s.id];
      if (!isObj(d)) { map[s.id] = 0; continue; }
      let n = 0;
      for (const [, v] of Object.entries(d)) {
        if (Array.isArray(v)) n += v.length;
        else if (isObj(v)) n += Object.keys(v).length;
        else n += 1;
      }
      map[s.id] = n;
    }
    return map;
  }, [sections, info]);

  const data = info.detailed?.[active] || {};

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !isObj(data)) return data;
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === 'title') continue;
      if (Array.isArray(v)) {
        const hit = v.filter((row) => isObj(row)
          ? Object.values(row).some((x) => String(x).toLowerCase().includes(q))
          : String(row).toLowerCase().includes(q));
        if (hit.length) out[k] = hit;
      } else if (isObj(v)) {
        const hitKeys = Object.keys(v).filter((ck) => ck.toLowerCase().includes(q)
          || String(v[ck]).toLowerCase().includes(q));
        if (hitKeys.length) out[k] = Object.fromEntries(hitKeys.map((ck) => [ck, v[ck]]));
      } else if (String(v).toLowerCase().includes(q) || labelOf(k).toLowerCase().includes(q)) {
        out[k] = v;
      }
    }
    return out;
  }, [data, search]);

  const copyAll = useCallback(async () => {
    await copyTextWithToast(JSON.stringify(info.detailed, null, 2), { successText: '全部明细已复制' });
  }, [info]);

  const activeMeta = sections.find((s) => s.id === active);

  return (
    <div className="pi-detail">
      <aside className="pi-detail-nav">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`pi-nav-item ${active === s.id ? 'is-active' : ''}`}
            onClick={() => { setActive(s.id); setSearch(''); }}
          >
            <span className="pi-nav-icon">{s.icon}</span>
            <span className="pi-nav-title">{s.title}</span>
            <span className="pi-nav-count">{counts[s.id] ?? 0}</span>
          </button>
        ))}
      </aside>

      <div className="pi-detail-body">
        <div className="pi-section-head">
          <div>
            <div className="pi-section-title">{activeMeta?.icon} {activeMeta?.title}</div>
            <div className="pi-section-sub">章节 {active} · {info.file_path?.split(/[/\\]/).pop()}</div>
          </div>
          <div className="pi-section-tools">
            <input
              className="pi-search"
              type="search"
              placeholder="搜索当前分类的字段或取值…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="pi-mini-btn" type="button" onClick={copyAll}>复制本分类 JSON</button>
          </div>
        </div>

        {search ? <div className="pi-search-hint">已按「{search}」过滤</div> : null}

        <SectionBody sectionId={active} data={filtered} />

        {active === '2.13' && isObj(data.file_tree) ? (
          <Collapse title="文件树" count={`${data.file_tree.children?.length || 0} 个顶层节点`}>
            <div className="pi-tree"><Tree node={data.file_tree} /></div>
          </Collapse>
        ) : null}

        <Collapse title="原始 JSON（该分类）">
          <CodeBlock value={data} maxHeight={520} />
        </Collapse>
      </div>
    </div>
  );
}

// ==================== 版本对比 ====================
function DiffView({ diff, before, after, onClose }) {
  if (!diff) return null;
  const rows = [
    ['版本', diff.version_old, diff.version_new],
    ['版本号', diff.version_code_old, diff.version_code_new],
    ['文件大小', diff.size_old_human, `${diff.size_new_human}（${diff.size_delta_human}）`],
    ['风险分', `${diff.risk_old} ${diff.risk_level_old || ''}`, `${diff.risk_new} ${diff.risk_level_new || ''}`],
    ['签名 SHA-256', diff.signature_old, diff.signature_new]
  ];

  const listBlock = (title, items, tone) => (
    <div className="pi-diff-block" key={title}>
      <div className="pi-sub-label">{title} <span className="pi-sub-count">{(items || []).length}</span></div>
      {items && items.length
        /* code-review-allow quality/no-index-key —— 变更项是只读字符串数组，且内容可能重复，下标是这里最稳的 key */
        ? <div className="pi-chips">{items.map((x, i) => <span className={`pi-chip ${tone ? `pi-chip--${tone}` : ''}`} key={i}>{x}</span>)}</div>
        : <div className="pi-empty-inline">无变化</div>}
    </div>
  );

  return (
    <div className="pi-diff">
      <div className="pi-section-head">
        <div>
          <div className="pi-section-title">📊 版本对比</div>
          <div className="pi-section-sub">
            {before?.basic?.file?.name} → {after?.basic?.file?.name}
          </div>
        </div>
        <button className="pi-mini-btn" type="button" onClick={onClose}>关闭对比</button>
      </div>

      <table className="pi-table pi-table--diff">
        <thead><tr><th style={{ width: 130 }}>项目</th><th>旧版本</th><th>新版本</th></tr></thead>
        <tbody>
          {rows.map(([label, a, b]) => (
            <tr key={label}>
              <td className="pi-diff-label">{label}</td>
              <td className="pi-mono">{fmtScalar(a)}</td>
              <td className="pi-mono">{fmtScalar(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pi-diff-grid">
        {listBlock('新增权限', diff.permission_added, 'warn')}
        {listBlock('移除权限', diff.permission_removed)}
        {listBlock('新增组件', diff.component_added, 'warn')}
        {listBlock('移除组件', diff.component_removed)}
        {listBlock('新增 SDK', diff.sdk_added, 'warn')}
        {listBlock('移除 SDK', diff.sdk_removed)}
        {listBlock('新增风险项', diff.risk_added, 'danger')}
        {listBlock('已修复风险项', diff.risk_fixed, 'ok')}
      </div>

      <div className="pi-diff-counts">
        <span>新增文件 <b>{diff.file_added_count}</b></span>
        <span>移除文件 <b>{diff.file_removed_count}</b></span>
      </div>

      {Array.isArray(diff.identity_changes) && diff.identity_changes.length ? (
        <div className="pi-sub-block">
          <div className="pi-sub-label">标识变化</div>
          <DataTable
            rows={diff.identity_changes.map((c, i) => ({ ...c, id: `${c.field}-${i}` }))}
            columns={[A('field', '字段'), A('before', '旧值'), A('after', '新值')]}
          />
        </div>
      ) : null}
    </div>
  );
}

// ==================== 主组件 ====================
function ApkInfo({ embedded = false }) {
  const [packagePath, setPackagePath] = useState('');
  const [info, setInfo] = useState(null);
  const [view, setView] = useState('basic');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [stageLog, setStageLog] = useState([]);
  const [comparePath, setComparePath] = useState('');
  const [diffResult, setDiffResult] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recent, setRecent] = useState(() => readRecentFiles());

  const jobRef = useRef(null);
  const { toasts, push, dismiss } = useToasts();
  const elapsed = useElapsed(loading || comparing);

  // 订阅主进程的分阶段进度。只认当前 jobId，避免上一次任务的尾巴污染新任务。
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onPackageInfoProgress) return undefined;
    const off = api.onPackageInfoProgress((payload) => {
      if (!payload) return;
      if (jobRef.current && payload.jobId && payload.jobId !== jobRef.current) return;
      setProgress({
        percent: typeof payload.percent === 'number' ? payload.percent : null,
        stage: payload.stage || '处理中',
        detail: payload.detail || '',
        elapsed_ms: payload.elapsed_ms
      });
      if (payload.stage) {
        setStageLog((list) => (
          list[list.length - 1] === payload.stage ? list : [...list, payload.stage]
        ));
      }
    });
    return off;
  }, []);

  const resetOutput = () => {
    setInfo(null);
    setDiffResult(null);
    setView('basic');
    setProgress(null);
    setStageLog([]);
  };

  const acceptPath = useCallback((nextPath) => {
    if (!nextPath) return;
    setPackagePath(nextPath);
    resetOutput();
  }, []);

  const selectPackage = async () => {
    const selector = window.electronAPI.selectAppPackage || window.electronAPI.selectApk;
    const nextPath = await selector();
    if (!nextPath) return;
    acceptPath(nextPath);
    rememberRecentFile(nextPath);
    setRecent(readRecentFiles());
  };

  // ---------- 拖拽导入 ----------
  const onDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  };

  const onDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    // Electron 会给 File 对象附加真实路径；取不到时提示改用「浏览」
    const filePath = file.path;
    if (!filePath) {
      push({ type: 'warning', text: '无法获取拖入文件的路径，请改用「浏览」按钮选择' });
      return;
    }
    const ext = String(file.name).toLowerCase().split('.').pop();
    if (!['apk', 'aab', 'ipa'].includes(ext)) {
      push({ type: 'warning', text: `不支持的文件类型：.${ext}`, detail: '仅支持 APK / AAB / IPA' });
      return;
    }
    acceptPath(filePath);
    rememberRecentFile(filePath);
    setRecent(readRecentFiles());
    push({ type: 'success', text: `已载入 ${file.name}`, detail: '点击「读取信息」开始解析', timeout: 3000 });
  };

  // ---------- 读取 ----------
  const readInfo = async () => {
    if (!packagePath) {
      push({ type: 'error', text: '请先选择 APK / AAB / IPA 文件' });
      return;
    }
    const api = window.electronAPI;
    const reader = api.readPackageStaticInfo
      || api.getPackageStaticInfo
      || api.getPackageInfo
      || api.getApkInfo;

    const jobId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobRef.current = jobId;
    setLoading(true);
    resetOutput();
    setProgress({ percent: 0, stage: '准备解析', detail: '' });

    const startedAt = Date.now();
    try {
      const result = await reader({ filePath: packagePath, jobId });
      setInfo(result);
      setView('basic');
      rememberRecentFile(packagePath);
      setRecent(readRecentFiles());
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      push({
        type: 'success',
        text: `${result?.basic?.app?.name || '解析完成'}`,
        detail: `${result?.basic?.file?.size_human || ''} · 耗时 ${seconds} 秒${result?.warnings?.length ? ` · ${result.warnings.length} 条提示` : ''}`,
        timeout: 5000
      });
      if (result?.warnings?.length) {
        push({ type: 'warning', text: `${result.warnings.length} 个字段解析失败`, detail: result.warnings[0], timeout: 8000 });
      }
    } catch (error) {
      const text = cleanIpcError(error);
      push({ type: 'error', text: '解析失败', detail: text, timeout: 0 });
    } finally {
      setLoading(false);
      setProgress(null);
      jobRef.current = null;
    }
  };

  const cancelRead = async () => {
    if (!jobRef.current) return;
    try {
      await window.electronAPI.cancelPackageInfo?.(jobRef.current);
      push({ type: 'info', text: '已取消解析', timeout: 2500 });
    } catch (_) {
      // 取消失败不阻断 UI
    }
  };

  const exportJson = async () => {
    if (!info) return;
    try {
      const res = await window.electronAPI.exportPackageInfo({
        filePath: info.file_path,
        content: JSON.stringify(info, null, 2)
      });
      if (res?.success) {
        push({ type: 'success', text: '已导出 JSON', detail: res.filePath, timeout: 6000 });
      }
    } catch (error) {
      push({ type: 'error', text: '导出失败', detail: cleanIpcError(error) });
    }
  };

  const pickCompare = async () => {
    const selector = window.electronAPI.selectAppPackage || window.electronAPI.selectApk;
    const nextPath = await selector();
    if (nextPath) setComparePath(nextPath);
  };

  const runCompare = async () => {
    if (!packagePath || !comparePath) {
      push({ type: 'error', text: '请先选择用于对比的两个包体' });
      return;
    }
    const jobId = `cmp-ui-${Date.now()}`;
    jobRef.current = jobId;
    setComparing(true);
    setProgress({ percent: 0, stage: '准备对比', detail: '' });
    try {
      const res = await window.electronAPI.comparePackageInfo({
        beforePath: packagePath,
        afterPath: comparePath,
        jobId
      });
      setDiffResult(res);
      setView('diff');
      const diff = res?.diff || {};
      push({
        type: 'success',
        text: `对比完成：${diff.version_old} → ${diff.version_new}`,
        detail: `体积 ${diff.size_delta_human || '—'} · 风险 ${diff.risk_delta > 0 ? '+' : ''}${diff.risk_delta ?? 0}`,
        timeout: 6000
      });
    } catch (error) {
      push({ type: 'error', text: '对比失败', detail: cleanIpcError(error) });
    } finally {
      setComparing(false);
      setProgress(null);
      jobRef.current = null;
    }
  };

  const busy = loading || comparing;
  const steps = stageLog.map((label, index) => ({
    label,
    done: index < stageLog.length - 1,
    active: index === stageLog.length - 1
  }));

  return (
    <div className={embedded ? 'package-info-embed' : 'content-card'}>
      {embedded ? null : <h2>读取应用信息</h2>}

      <div className="form-group">
        <label>选择 APK / AAB / IPA 文件</label>
        <div
          className={cx('file-input-group', 'pi-drop', dragging && 'is-dragging')}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <input type="text" value={packagePath} readOnly placeholder="请选择 APK、AAB 或 IPA 文件（也可以直接把文件拖到这里）" />
          <button className="btn btn-secondary" onClick={selectPackage} disabled={busy}>浏览</button>
        </div>
        {recent.length ? (
          <div className="pi-recent">
            <span className="pi-recent__label">最近打开</span>
            {recent.slice(0, 5).map((item) => (
              <button
                key={item.path}
                type="button"
                className="pi-recent__item"
                title={item.path}
                disabled={busy}
                onClick={() => acceptPath(item.path)}
              >
                {item.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="action-buttons">
        <button className="btn btn-primary" onClick={readInfo} disabled={busy || !packagePath}>
          {loading ? '解析中…' : '读取信息'}
        </button>
        {info ? (
          <>
            <button className="btn btn-secondary" type="button" onClick={exportJson}>导出 JSON</button>
            <button
              className={`btn ${view === 'detail' ? 'btn-primary' : 'btn-secondary'}`}
              type="button"
              onClick={() => setView(view === 'detail' ? 'basic' : 'detail')}
            >
              {view === 'detail' ? '返回概览' : '详细信息'}
            </button>
          </>
        ) : null}
      </div>

      {/* 进度反馈 */}
      {busy || progress ? (
        <ProgressBar
          percent={progress?.percent}
          stage={progress?.stage || (comparing ? '正在对比两个包体' : '正在解析包体静态信息')}
          detail={progress?.detail}
          elapsedMs={elapsed}
          onCancel={busy ? cancelRead : undefined}
          steps={steps.length > 1 ? steps : undefined}
        />
      ) : null}

      {/* 对比区 */}
      {info ? (
        <div className="pi-compare-bar">
          <span className="pi-compare-label">版本对比</span>
          <input type="text" readOnly value={comparePath} placeholder="选择另一个版本用于对比" />
          <button className="btn btn-secondary" type="button" onClick={pickCompare} disabled={busy}>选择</button>
          <button className="btn btn-secondary" type="button" onClick={runCompare} disabled={busy || !comparePath}>
            {comparing ? '对比中…' : '开始对比'}
          </button>
        </div>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {info && view === 'basic' ? (
        <BasicView info={info} onOpenDetail={() => setView('detail')} />
      ) : null}

      {info && view === 'detail' ? <DetailView info={info} /> : null}

      {info && view === 'diff' ? (
        <DiffView
          diff={diffResult?.diff}
          before={diffResult?.before}
          after={diffResult?.after}
          onClose={() => setView('basic')}
        />
      ) : null}
    </div>
  );
}

export default ApkInfo;

// 具名导出：便于单元测试与静态预览直接渲染各视图
export { BasicView, DetailView, DiffView, SectionBody, DataTable, FieldGrid, RiskRing, FIELD_LABELS };
