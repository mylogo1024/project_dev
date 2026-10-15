'use strict';

/**
 * 规则库：SDK / 框架识别、加固与混淆识别、权限元数据、风险规则引擎
 *
 * 全部为数据驱动，便于后续增删规则而不用改逻辑。
 */

// ==================== 权限元数据 ====================

/** 保护级别 */
const PROTECTION = { NORMAL: 'normal', DANGEROUS: 'dangerous', SIGNATURE: 'signature', SPECIAL: 'special' };

/**
 * 权限字典：名称 → { group, protectionLevel, dangerous, description }
 * 只收录静态分析常见且有意义的权限；未收录的按 normal 处理。
 */
const PERMISSION_INFO = {
  'android.permission.READ_CALENDAR': { group: 'CALENDAR', level: PROTECTION.DANGEROUS, description: '读取日历事件' },
  'android.permission.WRITE_CALENDAR': { group: 'CALENDAR', level: PROTECTION.DANGEROUS, description: '写入日历事件' },
  'android.permission.CAMERA': { group: 'CAMERA', level: PROTECTION.DANGEROUS, description: '使用相机拍摄' },
  'android.permission.READ_CONTACTS': { group: 'CONTACTS', level: PROTECTION.DANGEROUS, description: '读取通讯录' },
  'android.permission.WRITE_CONTACTS': { group: 'CONTACTS', level: PROTECTION.DANGEROUS, description: '修改通讯录' },
  'android.permission.GET_ACCOUNTS': { group: 'CONTACTS', level: PROTECTION.DANGEROUS, description: '读取设备账户列表' },
  'android.permission.ACCESS_FINE_LOCATION': { group: 'LOCATION', level: PROTECTION.DANGEROUS, description: '精确位置（GPS）' },
  'android.permission.ACCESS_COARSE_LOCATION': { group: 'LOCATION', level: PROTECTION.DANGEROUS, description: '粗略位置（基站/WiFi）' },
  'android.permission.ACCESS_BACKGROUND_LOCATION': { group: 'LOCATION', level: PROTECTION.DANGEROUS, description: '后台持续获取位置' },
  'android.permission.ACCESS_MEDIA_LOCATION': { group: 'LOCATION', level: PROTECTION.DANGEROUS, description: '读取照片中的位置信息' },
  'android.permission.RECORD_AUDIO': { group: 'MICROPHONE', level: PROTECTION.DANGEROUS, description: '录制音频' },
  'android.permission.READ_PHONE_STATE': { group: 'PHONE', level: PROTECTION.DANGEROUS, description: '读取手机状态与设备标识' },
  'android.permission.READ_PHONE_NUMBERS': { group: 'PHONE', level: PROTECTION.DANGEROUS, description: '读取本机号码' },
  'android.permission.CALL_PHONE': { group: 'PHONE', level: PROTECTION.DANGEROUS, description: '直接拨打电话' },
  'android.permission.READ_CALL_LOG': { group: 'CALL_LOG', level: PROTECTION.DANGEROUS, description: '读取通话记录' },
  'android.permission.WRITE_CALL_LOG': { group: 'CALL_LOG', level: PROTECTION.DANGEROUS, description: '写入通话记录' },
  'android.permission.ADD_VOICEMAIL': { group: 'CALL_LOG', level: PROTECTION.DANGEROUS, description: '添加语音信箱' },
  'android.permission.USE_SIP': { group: 'CALL_LOG', level: PROTECTION.DANGEROUS, description: '使用 SIP 通话' },
  'android.permission.PROCESS_OUTGOING_CALLS': { group: 'CALL_LOG', level: PROTECTION.DANGEROUS, description: '拦截/处理外拨电话' },
  'android.permission.ANSWER_PHONE_CALLS': { group: 'PHONE', level: PROTECTION.DANGEROUS, description: '接听来电' },
  'android.permission.BODY_SENSORS': { group: 'SENSORS', level: PROTECTION.DANGEROUS, description: '读取身体传感器数据' },
  'android.permission.SEND_SMS': { group: 'SMS', level: PROTECTION.DANGEROUS, description: '发送短信' },
  'android.permission.RECEIVE_SMS': { group: 'SMS', level: PROTECTION.DANGEROUS, description: '接收短信' },
  'android.permission.READ_SMS': { group: 'SMS', level: PROTECTION.DANGEROUS, description: '读取短信内容' },
  'android.permission.RECEIVE_WAP_PUSH': { group: 'SMS', level: PROTECTION.DANGEROUS, description: '接收 WAP Push' },
  'android.permission.RECEIVE_MMS': { group: 'SMS', level: PROTECTION.DANGEROUS, description: '接收彩信' },
  'android.permission.READ_EXTERNAL_STORAGE': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '读取外部存储' },
  'android.permission.WRITE_EXTERNAL_STORAGE': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '写入外部存储' },
  'android.permission.READ_MEDIA_IMAGES': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '读取图片媒体库' },
  'android.permission.READ_MEDIA_VIDEO': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '读取视频媒体库' },
  'android.permission.READ_MEDIA_AUDIO': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '读取音频媒体库' },
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '读取用户选择的媒体' },
  'android.permission.ACTIVITY_RECOGNITION': { group: 'ACTIVITY_RECOGNITION', level: PROTECTION.DANGEROUS, description: '识别身体活动状态' },
  'android.permission.NEARBY_WIFI_DEVICES': { group: 'NEARBY_DEVICES', level: PROTECTION.DANGEROUS, description: '发现附近 WiFi 设备' },
  'android.permission.BLUETOOTH_SCAN': { group: 'NEARBY_DEVICES', level: PROTECTION.DANGEROUS, description: '扫描蓝牙设备' },
  'android.permission.BLUETOOTH_CONNECT': { group: 'NEARBY_DEVICES', level: PROTECTION.DANGEROUS, description: '连接蓝牙设备' },
  'android.permission.BLUETOOTH_ADVERTISE': { group: 'NEARBY_DEVICES', level: PROTECTION.DANGEROUS, description: '蓝牙广播' },
  'android.permission.POST_NOTIFICATIONS': { group: 'NOTIFICATIONS', level: PROTECTION.DANGEROUS, description: '发送通知' },
  'android.permission.UWB_RANGING': { group: 'NEARBY_DEVICES', level: PROTECTION.DANGEROUS, description: 'UWB 测距' },

  'android.permission.SYSTEM_ALERT_WINDOW': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '悬浮窗（可覆盖其他应用界面）' },
  'android.permission.REQUEST_INSTALL_PACKAGES': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '请求安装其他应用' },
  'android.permission.QUERY_ALL_PACKAGES': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '查询设备上所有已安装应用' },
  'android.permission.PACKAGE_USAGE_STATS': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '读取应用使用统计' },
  'android.permission.MANAGE_EXTERNAL_STORAGE': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '管理全部文件（所有文件访问）' },
  'android.permission.READ_PRIVILEGED_PHONE_STATE': { group: 'PHONE', level: PROTECTION.SIGNATURE, description: '读取受保护的设备标识（系统签名）' },
  'android.permission.WRITE_SETTINGS': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '修改系统设置' },
  'android.permission.WRITE_SECURE_SETTINGS': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '修改安全系统设置' },
  'android.permission.MOUNT_UNMOUNT_FILESYSTEMS': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '挂载/卸载文件系统' },
  'android.permission.REBOOT': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '重启设备' },
  'android.permission.SHUTDOWN': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '关机' },
  'android.permission.GET_TASKS': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '读取当前运行任务' },
  'android.permission.REAL_GET_TASKS': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '读取真实运行任务' },
  'android.permission.INSTALL_PACKAGES': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '静默安装应用' },
  'android.permission.DELETE_PACKAGES': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '静默卸载应用' },
  'android.permission.CHANGE_CONFIGURATION': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '修改系统配置' },
  'android.permission.SET_TIME': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '设置系统时间' },
  'android.permission.SET_TIME_ZONE': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '设置时区' },
  'android.permission.BIND_ACCESSIBILITY_SERVICE': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '无障碍服务绑定（可读取全部界面内容）' },
  'android.permission.BIND_DEVICE_ADMIN': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '设备管理员' },
  'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: '通知读取服务（可读取全部通知）' },
  'android.permission.BIND_VPN_SERVICE': { group: 'SPECIAL', level: PROTECTION.SIGNATURE, description: 'VPN 服务（可接管全部流量）' },
  'android.permission.SYSTEM_ALERT_WINDOW.OVERLAY': { group: 'SPECIAL', level: PROTECTION.SPECIAL, description: '悬浮窗' },
  'android.permission.KILL_BACKGROUND_PROCESSES': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '结束后台进程' },
  'android.permission.FOREGROUND_SERVICE': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '前台服务' },
  'android.permission.FOREGROUND_SERVICE_LOCATION': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '定位类前台服务' },
  'android.permission.INTERNET': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '访问网络' },
  'android.permission.ACCESS_NETWORK_STATE': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '读取网络状态' },
  'android.permission.ACCESS_WIFI_STATE': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '读取 WiFi 状态' },
  'android.permission.CHANGE_WIFI_STATE': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '修改 WiFi 状态' },
  'android.permission.WAKE_LOCK': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '保持唤醒' },
  'android.permission.VIBRATE': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '振动' },
  'android.permission.RECEIVE_BOOT_COMPLETED': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '开机自启' },
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS': { group: 'NORMAL', level: PROTECTION.NORMAL, description: '请求忽略电池优化' },
  'android.permission.WRITE_EXTERNAL_STORAGE.LEGACY': { group: 'STORAGE', level: PROTECTION.DANGEROUS, description: '写入外部存储（旧版）' }
};

/** 组合权限：命中即视为高风险组合。 */
const PERMISSION_COMBOS = [
  {
    id: 'combo-sms-contacts',
    permissions: ['android.permission.READ_SMS', 'android.permission.READ_CONTACTS'],
    severity: 'high',
    message: '同时申请短信读取与通讯录读取权限，存在大规模隐私采集风险',
    cwe: 'CWE-359',
    remediation: '确认业务必要性；如非核心功能，移除其中一项或改为按需申请'
  },
  {
    id: 'combo-sms-send-read',
    permissions: ['android.permission.SEND_SMS', 'android.permission.READ_SMS'],
    severity: 'high',
    message: '同时具备短信读取与发送能力，可能被用于资费消耗或短信拦截',
    cwe: 'CWE-359',
    remediation: '移除短信发送权限，或改用系统短信应用跳转'
  },
  {
    id: 'combo-location-background',
    permissions: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_BACKGROUND_LOCATION'],
    severity: 'high',
    message: '精确位置 + 后台定位，可持续追踪用户行踪',
    cwe: 'CWE-359',
    remediation: '改为前台定位，或降级为粗略位置'
  },
  {
    id: 'combo-install-overlay',
    permissions: ['android.permission.REQUEST_INSTALL_PACKAGES', 'android.permission.SYSTEM_ALERT_WINDOW'],
    severity: 'critical',
    message: '悬浮窗 + 应用安装权限组合，典型「静默安装」/「界面劫持」特征',
    cwe: 'CWE-1021',
    remediation: '移除请求安装权限；确需升级请使用应用商店或系统安装器'
  },
  {
    id: 'combo-audio-contacts',
    permissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_CONTACTS'],
    severity: 'high',
    message: '录音 + 通讯录组合，可能用于通讯录回传与语音采集',
    cwe: 'CWE-359',
    remediation: '按最小必要原则拆分权限申请时机'
  }
];

// ==================== SDK / 框架签名库 ====================

/**
 * 每条签名：
 *  - name / category / vendor / country / website / license
 *  - markers: 命中任一即可（子串匹配，命中路径或 DEX 字符串）
 *  - risk / privacy 标记
 */
const SDK_SIGNATURES = [
  // ---------- 广告 ----------
  { name: '穿山甲（Pangle）', category: '广告', vendor: '字节跳动', country: '中国', website: 'https://www.pangle.cn', license: '商业',
    markers: ['com/bytedance/sdk/openadsdk', 'com/pangle', 'com/bykv/vk/openvk', 'libpanglearmor'] },
  { name: '优量汇（GDT）', category: '广告', vendor: '腾讯', country: '中国', website: 'https://e.qq.com', license: '商业',
    markers: ['com/qq/e/ads', 'com/qq/e/comm', 'com/tencent/gdt'] },
  { name: 'AdMob', category: '广告', vendor: 'Google', country: '美国', website: 'https://admob.google.com', license: '商业',
    markers: ['com/google/android/gms/ads', 'com/google/ads', 'com/google/android/ump'] },
  { name: 'Facebook Audience Network', category: '广告', vendor: 'Meta', country: '美国', website: 'https://developers.facebook.com', license: '商业',
    markers: ['com/facebook/ads', 'com/facebook/audience'] },
  { name: 'Unity Ads', category: '广告', vendor: 'Unity', country: '美国', website: 'https://unity.com', license: '商业',
    markers: ['com/unity3d/ads', 'com/unity3d/services'] },
  { name: 'AppLovin', category: '广告', vendor: 'AppLovin', country: '美国', website: 'https://www.applovin.com', license: '商业',
    markers: ['com/applovin', 'libapplovin'] },
  { name: 'ironSource', category: '广告', vendor: 'Unity', country: '以色列', website: 'https://www.is.com', license: '商业',
    markers: ['com/ironsource', 'com/unity3d/mediation'] },
  { name: 'Mintegral', category: '广告', vendor: '汇量科技', country: '中国', website: 'https://www.mintegral.com', license: '商业',
    markers: ['com/mintegral', 'com/mbridge'] },
  { name: 'TopOn', category: '广告', vendor: 'TopOn', country: '中国', website: 'https://www.toponad.com', license: '商业',
    markers: ['com/anythink', 'com/topon'] },
  { name: '百度联盟', category: '广告', vendor: '百度', country: '中国', website: 'https://union.baidu.com', license: '商业',
    markers: ['com/baidu/mobads', 'com/baidu/mobstat'] },
  { name: '快手广告', category: '广告', vendor: '快手', country: '中国', website: 'https://ad.kuaishou.com', license: '商业',
    markers: ['com/kwad', 'com/kuaishou/ad'] },
  { name: 'Sigmob', category: '广告', vendor: 'Sigmob', country: '中国', website: 'https://www.sigmob.com', license: '商业',
    markers: ['com/sigmob', 'com/czh/ad'] },

  // ---------- 统计 / 分析 ----------
  { name: '友盟统计', category: '统计', vendor: '阿里', country: '中国', website: 'https://www.umeng.com', license: '商业',
    markers: ['com/umeng/commonsdk', 'com/umeng/analytics', 'com/ta/utdid2', 'libumeng'] },
  { name: '友盟推送', category: '推送', vendor: '阿里', country: '中国', website: 'https://www.umeng.com', license: '商业',
    markers: ['com/umeng/message', 'com/ta/utdid2/push', 'com/umeng/push'] },
  { name: '腾讯 Bugly', category: '崩溃', vendor: '腾讯', country: '中国', website: 'https://bugly.qq.com', license: '商业',
    markers: ['com/tencent/bugly', 'com/tencent/bugly/crashreport'] },
  { name: '腾讯 MTA', category: '统计', vendor: '腾讯', country: '中国', website: 'https://mta.qq.com', license: '商业',
    markers: ['com/tencent/stat', 'com/qq/taf'] },
  { name: 'Firebase Analytics', category: '统计', vendor: 'Google', country: '美国', website: 'https://firebase.google.com', license: '免费',
    markers: ['com/google/firebase/analytics', 'com/google/android/gms/measurement'] },
  { name: 'Firebase Crashlytics', category: '崩溃', vendor: 'Google', country: '美国', website: 'https://firebase.google.com', license: '免费',
    markers: ['com/google/firebase/crashlytics', 'com/crashlytics'] },
  { name: 'Sentry', category: '崩溃', vendor: 'Sentry', country: '美国', website: 'https://sentry.io', license: '开源/商业',
    markers: ['io/sentry', 'io/sentry/android'] },
  { name: 'GrowingIO', category: '统计', vendor: 'GrowingIO', country: '中国', website: 'https://www.growingio.com', license: '商业',
    markers: ['com/growingio/android'] },
  { name: '神策数据', category: '统计', vendor: '神策', country: '中国', website: 'https://www.sensorsdata.cn', license: '商业',
    markers: ['com/sensorsdata/analytics'] },
  { name: 'Flurry', category: '统计', vendor: 'Yahoo', country: '美国', website: 'https://flurry.com', license: '商业',
    markers: ['com/flurry/android'] },
  { name: 'Adjust', category: '统计', vendor: 'Adjust', country: '德国', website: 'https://www.adjust.com', license: '商业',
    markers: ['com/adjust/sdk'] },
  { name: 'AppsFlyer', category: '统计', vendor: 'AppsFlyer', country: '以色列', website: 'https://www.appsflyer.com', license: '商业',
    markers: ['com/appsflyer'] },
  { name: 'TalkingData', category: '统计', vendor: 'TalkingData', country: '中国', website: 'https://www.talkingdata.com', license: '商业',
    markers: ['com/tendcloud'] },

  // ---------- 推送 ----------
  { name: '极光推送 JPush', category: '推送', vendor: '极光', country: '中国', website: 'https://www.jiguang.cn', license: '商业',
    markers: ['cn/jpush/android', 'cn/jiguang', 'com/jpush'] },
  { name: '个推', category: '推送', vendor: '每日互动', country: '中国', website: 'https://www.getui.com', license: '商业',
    markers: ['com/igexin', 'com/getui'] },
  { name: 'Firebase Cloud Messaging', category: '推送', vendor: 'Google', country: '美国', website: 'https://firebase.google.com', license: '免费',
    markers: ['com/google/firebase/messaging', 'com/google/android/gms/cloudmessaging'] },
  { name: '小米推送', category: '推送', vendor: '小米', country: '中国', website: 'https://dev.mi.com', license: '免费',
    markers: ['com/xiaomi/mipush', 'com/xiaomi/push'] },
  { name: '华为 HMS Push', category: '推送', vendor: '华为', country: '中国', website: 'https://developer.huawei.com', license: '免费',
    markers: ['com/huawei/hms/push', 'com/huawei/android/pushagent'] },
  { name: 'OPPO 推送', category: '推送', vendor: 'OPPO', country: '中国', website: 'https://push.oppo.com', license: '免费',
    markers: ['com/heytap/msp', 'com/coloros/mcssdk'] },
  { name: 'vivo 推送', category: '推送', vendor: 'vivo', country: '中国', website: 'https://dev.vivo.com.cn', license: '免费',
    markers: ['com/vivo/push', 'com/vivo/pushsdk'] },
  { name: '荣耀推送', category: '推送', vendor: '荣耀', country: '中国', website: 'https://developer.hihonor.com', license: '免费',
    markers: ['com/hihonor/push'] },
  { name: '魅族推送', category: '推送', vendor: '魅族', country: '中国', website: 'https://open.flyme.cn', license: '免费',
    markers: ['com/meizu/cloud/pushsdk'] },

  // ---------- 支付 ----------
  { name: '微信 SDK', category: '支付', vendor: '腾讯', country: '中国', website: 'https://open.weixin.qq.com', license: '免费',
    markers: ['com/tencent/mm/opensdk', 'com/tencent/wxop'] },
  { name: '支付宝 SDK', category: '支付', vendor: '蚂蚁集团', country: '中国', website: 'https://open.alipay.com', license: '免费',
    markers: ['com/alipay/sdk', 'com/alipay/android/app', 'com/alipay/security'] },
  { name: '银联支付', category: '支付', vendor: '中国银联', country: '中国', website: 'https://open.unionpay.com', license: '商业',
    markers: ['com/unionpay', 'com/uppay'] },
  { name: 'Google Play Billing', category: '支付', vendor: 'Google', country: '美国', website: 'https://developer.android.com', license: '免费',
    markers: ['com/android/billingclient', 'com/google/android/gms/actions'] },
  { name: 'Stripe', category: '支付', vendor: 'Stripe', country: '美国', website: 'https://stripe.com', license: '商业',
    markers: ['com/stripe/android'] },

  // ---------- 地图 / 定位 ----------
  { name: '高德地图', category: '地图', vendor: '高德', country: '中国', website: 'https://lbs.amap.com', license: '商业',
    markers: ['com/amap/api', 'com/autonavi', 'com/loc/b'] },
  { name: '百度地图', category: '地图', vendor: '百度', country: '中国', website: 'https://lbsyun.baidu.com', license: '商业',
    markers: ['com/baidu/mapapi', 'com/baidu/location', 'com/baidu/android/location'] },
  { name: '腾讯地图', category: '地图', vendor: '腾讯', country: '中国', website: 'https://lbs.qq.com', license: '商业',
    markers: ['com/tencent/map', 'com/tencent/lbs'] },
  { name: 'Google Maps', category: '地图', vendor: 'Google', country: '美国', website: 'https://developers.google.com/maps', license: '商业',
    markers: ['com/google/android/gms/maps'] },

  // ---------- 社交 / 登录 ----------
  { name: 'QQ 互联', category: '社交', vendor: '腾讯', country: '中国', website: 'https://open.tencent.com', license: '免费',
    markers: ['com/tencent/tauth', 'com/tencent/open'] },
  { name: '新浪微博 SDK', category: '社交', vendor: '微博', country: '中国', website: 'https://open.weibo.com', license: '免费',
    markers: ['com/sina/weibo/sdk'] },
  { name: 'Facebook Login', category: '社交', vendor: 'Meta', country: '美国', website: 'https://developers.facebook.com', license: '免费',
    markers: ['com/facebook/login', 'com/facebook/appevents'] },
  { name: 'Google Sign-In', category: '社交', vendor: 'Google', country: '美国', website: 'https://developers.google.com', license: '免费',
    markers: ['com/google/android/gms/auth'] },

  // ---------- 热更新 / 跨平台 ----------
  { name: 'Tinker 热更新', category: '热更新', vendor: '腾讯', country: '中国', website: 'https://github.com/Tencent/tinker', license: 'BSD-3',
    markers: ['com/tencent/tinker', 'tinker/patch'] },
  { name: 'Sophix / 阿里热修复', category: '热更新', vendor: '阿里', country: '中国', website: 'https://www.aliyun.com', license: '商业',
    markers: ['com/taobao/sophix', 'com/ali/ha/fulltrace'] },
  { name: 'Flutter', category: '跨平台', vendor: 'Google', country: '美国', website: 'https://flutter.dev', license: 'BSD-3',
    markers: ['io/flutter/embedding', 'io/flutter/plugin', 'libflutter.so', 'flutter_assets'] },
  { name: 'React Native', category: '跨平台', vendor: 'Meta', country: '美国', website: 'https://reactnative.dev', license: 'MIT',
    markers: ['com/facebook/react', 'libreactnativejni.so', 'libhermes.so'] },
  { name: 'Cordova', category: '跨平台', vendor: 'Apache', country: '美国', website: 'https://cordova.apache.org', license: 'Apache-2.0',
    markers: ['org/apache/cordova', 'cordova.js'] },
  { name: 'Ionic / Capacitor', category: '跨平台', vendor: 'Ionic', country: '美国', website: 'https://ionicframework.com', license: 'MIT',
    markers: ['com/getcapacitor', 'io/ionic', 'capacitor.config.json'] },
  { name: 'Unity', category: '跨平台', vendor: 'Unity', country: '美国', website: 'https://unity.com', license: '商业',
    markers: ['com/unity3d/player', 'libunity.so', 'libil2cpp.so', 'libmonobdwgc-2.0.so'] },
  { name: 'Cocos2d-x', category: '跨平台', vendor: '触控科技', country: '中国', website: 'https://www.cocos.com', license: 'MIT',
    markers: ['org/cocos2dx/lib', 'libcocos2djs.so', 'libcocos2d.so'] },
  { name: 'Xamarin / .NET MAUI', category: '跨平台', vendor: 'Microsoft', country: '美国', website: 'https://dotnet.microsoft.com', license: 'MIT',
    markers: ['mono/android', 'libmonodroid.so', 'libxamarin-app.so'] },
  { name: 'UniApp', category: '跨平台', vendor: 'DCloud', country: '中国', website: 'https://uniapp.dcloud.net.cn', license: '商业',
    markers: ['io/dcloud', 'libweexjsb.so', 'dcloud_control.xml', 'apps/__UNI__'] },

  // ---------- 网络 / 存储 / 图片 ----------
  { name: 'OkHttp', category: '网络', vendor: 'Square', country: '美国', website: 'https://square.github.io/okhttp/', license: 'Apache-2.0',
    markers: ['okhttp3/', 'okhttp/'] },
  { name: 'Retrofit', category: '网络', vendor: 'Square', country: '美国', website: 'https://square.github.io/retrofit/', license: 'Apache-2.0',
    markers: ['retrofit2/'] },
  { name: 'Volley', category: '网络', vendor: 'Google', country: '美国', website: 'https://developer.android.com', license: 'Apache-2.0',
    markers: ['com/android/volley'] },
  { name: 'Glide', category: '图片', vendor: 'Bumptech', country: '美国', website: 'https://github.com/bumptech/glide', license: 'Apache-2.0',
    markers: ['com/bumptech/glide'] },
  { name: 'Picasso', category: '图片', vendor: 'Square', country: '美国', website: 'https://square.github.io/picasso/', license: 'Apache-2.0',
    markers: ['com/squareup/picasso'] },
  { name: 'Fresco', category: '图片', vendor: 'Meta', country: '美国', website: 'https://frescolib.org', license: 'MIT',
    markers: ['com/facebook/imagepipeline', 'com/facebook/fresco'] },
  { name: 'Coil', category: '图片', vendor: 'Coil', country: '美国', website: 'https://coil-kt.github.io/coil/', license: 'Apache-2.0',
    markers: ['coil3/', 'coil/'] },
  { name: 'Room', category: '数据库', vendor: 'Google', country: '美国', website: 'https://developer.android.com', license: 'Apache-2.0',
    markers: ['androidx/room'] },
  { name: 'Realm', category: '数据库', vendor: 'MongoDB', country: '美国', website: 'https://realm.io', license: 'Apache-2.0',
    markers: ['io/realm', 'librealm-jni.so'] },
  { name: 'GreenDAO', category: '数据库', vendor: 'greenrobot', country: '德国', website: 'https://greenrobot.org', license: 'Apache-2.0',
    markers: ['org/greenrobot/greendao'] },
  { name: 'SQLCipher', category: '数据库', vendor: 'Zetetic', country: '美国', website: 'https://www.zetetic.net', license: 'BSD',
    markers: ['net/sqlcipher', 'libsqlcipher.so'] },

  // ---------- 安全 / 风控 ----------
  { name: '腾讯验证码', category: '安全', vendor: '腾讯', country: '中国', website: 'https://cloud.tencent.com', license: '商业',
    markers: ['com/tencent/captcha', 'com/tencentcloud/captcha'] },
  { name: '阿里云号码认证', category: '安全', vendor: '阿里', country: '中国', website: 'https://www.aliyun.com', license: '商业',
    markers: ['com/aliyun/api', 'com/mobile/auth'] },
  { name: '极验 Geetest', category: '安全', vendor: '极验', country: '中国', website: 'https://www.geetest.com', license: '商业',
    markers: ['com/geetest'] },
  { name: '顶象风控', category: '安全', vendor: '顶象', country: '中国', website: 'https://www.dingxiang-inc.com', license: '商业',
    markers: ['com/dingxiang', 'com/dx/mobile'] },
  { name: 'SafetyNet / Play Integrity', category: '安全', vendor: 'Google', country: '美国', website: 'https://developer.android.com', license: '免费',
    markers: ['com/google/android/gms/safetynet', 'com/google/android/play/core/integrity'] },

  // ---------- AI / 其他 ----------
  { name: '腾讯云 SDK', category: '其他', vendor: '腾讯', country: '中国', website: 'https://cloud.tencent.com', license: '商业',
    markers: ['com/tencentcloudapi', 'com/tencent/qcloud'] },
  { name: '阿里云 SDK', category: '其他', vendor: '阿里', country: '中国', website: 'https://www.aliyun.com', license: '商业',
    markers: ['com/alibaba/sdk', 'com/alibaba/mobileim'] },
  { name: 'AWS SDK', category: '其他', vendor: 'Amazon', country: '美国', website: 'https://aws.amazon.com', license: 'Apache-2.0',
    markers: ['com/amazonaws'] },
  { name: 'Plaid', category: '其他', vendor: 'Plaid', country: '美国', website: 'https://plaid.com', license: '商业',
    markers: ['com/plaid'] },
  { name: 'TensorFlow Lite', category: 'AI', vendor: 'Google', country: '美国', website: 'https://www.tensorflow.org', license: 'Apache-2.0',
    markers: ['org/tensorflow/lite', 'libtensorflowlite_jni.so', 'libtensorflowlite_gpu_jni.so'] },
  { name: 'PyTorch Mobile', category: 'AI', vendor: 'Meta', country: '美国', website: 'https://pytorch.org', license: 'BSD',
    markers: ['org/pytorch', 'libpytorch_jni.so'] },
  { name: 'OpenCV', category: 'AI', vendor: 'OpenCV', country: '美国', website: 'https://opencv.org', license: 'Apache-2.0',
    markers: ['org/opencv', 'libopencv_java4.so'] }
];

/** SDK 隐私敏感标记（命中即提示）。 */
const PRIVACY_SENSITIVE_CATEGORIES = new Set(['广告', '统计', '推送']);

/**
 * iOS 侧的补充特征。
 *
 * Android 靠 Java 包名/类名识别 SDK，iOS 侧同样的 SDK 表现为 Objective-C 类名、
 * framework 名或 bundle 名，因此单独维护一份映射，避免把 Java 风格标记硬塞进
 * iOS 包体里造成漏报。
 */
const IOS_SDK_MARKERS = {
  '穿山甲（Pangle）': ['BUAdSDK', 'PangleSDK', 'BUAdSDKManager', 'BUAdSDKConfiguration'],
  '优量汇（GDT）': ['GDTSDK', 'GDTAd', 'GDTRewardVideoAd'],
  AdMob: ['GoogleMobileAds', 'GADBannerView', 'GADInterstitialAd', 'GADRequest'],
  'Facebook Audience Network': ['FBAudienceNetwork', 'FBAdView', 'FBInterstitialAd'],
  'Unity Ads': ['UnityAds', 'UnityAdsManager'],
  AppLovin: ['AppLovinSDK', 'ALSdk'],
  ironSource: ['IronSource', 'ISRewardedVideo'],
  Mintegral: ['MintegralSDK', 'MTGAdManager'],
  '百度联盟': ['BaiduMobAdSDK', 'BaiduMobAdView'],
  '友盟统计': ['UMCommon', 'UMAnalytics', 'UMengAnalytics', 'UMConfigure'],
  '友盟推送': ['UMessage', 'UMPush'],
  '腾讯 Bugly': ['Bugly', 'BuglyConfig'],
  'Firebase Analytics': ['FIRAnalytics', 'FirebaseAnalytics', 'FIRApp'],
  'Firebase Crashlytics': ['FIRCrashlytics', 'Crashlytics'],
  Sentry: ['SentrySDK', 'SentryClient'],
  'GrowingIO': ['Growing', 'GrowingTracker'],
  '神策数据': ['SensorsAnalyticsSDK', 'SensorsAnalytics'],
  Flurry: ['Flurry', 'FlurryAnalytics'],
  Adjust: ['AdjustSdk', 'Adjust'],
  AppsFlyer: ['AppsFlyerLib', 'AppsFlyerTracker'],
  TalkingData: ['TalkingDataSDK', 'TalkingData'],
  '极光推送 JPush': ['JPUSHService', 'JIGUANG', 'JPush'],
  '个推': ['GeTuiSdk', 'GeTui'],
  'Firebase Cloud Messaging': ['FIRMessaging', 'FirebaseMessaging'],
  '小米推送': ['MiPushSDK', 'MiPush'],
  '华为 HMS Push': ['HMSAnalytics', 'HMSAgent'],
  '微信 SDK': ['WechatOpenSDK', 'WXApi', 'WXApiObject', 'libWeChatSDK'],
  '支付宝 SDK': ['AlipaySDK', 'APayOrderEngine', 'AliPaySDK', 'com.alipay'],
  '银联支付': ['UPPaymentControl', 'UnionPaySDK'],
  'Google Play Billing': ['StoreKit', 'SKPaymentQueue'],
  Stripe: ['Stripe', 'STPAPIClient'],
  '高德地图': ['AMapFoundation', 'MAMapKit', 'AMapSearch', 'AMapLocationKit'],
  '百度地图': ['BMKMapManager', 'BaiduMapAPI', 'BMKLocationManager'],
  '腾讯地图': ['QMapKit', 'QMapServices', 'TencentLBS'],
  'Google Maps': ['GoogleMaps', 'GMSMapView'],
  'QQ 互联': ['TencentOpenAPI', 'TencentOAuth', 'TencentApiInterface'],
  '新浪微博 SDK': ['WeiboSDK', 'WBHttpRequest'],
  'Facebook Login': ['FBSDKCoreKit', 'FBSDKLoginKit'],
  'Google Sign-In': ['GoogleSignIn', 'GIDSignIn'],
  Flutter: ['Flutter.framework', 'flutter_assets', 'FlutterViewController'],
  'React Native': ['React.framework', 'RCTBridge', 'hermes.framework', 'main.jsbundle'],
  Cordova: ['CDVViewController', 'Cordova.framework', 'cordova.js'],
  'Ionic / Capacitor': ['CAPBridgeViewController', 'Capacitor.framework'],
  Unity: ['UnityFramework', 'UnityAppController', 'il2cpp'],
  'Cocos2d-x': ['CCDirector', 'cocos2d', 'libcocos2d'],
  'Xamarin / .NET MAUI': ['Xamarin.iOS', 'mono.framework', 'libmonosgen'],
  UniApp: ['DCloud', 'io.dcloud', 'libweex'],
  OkHttp: [],
  Glide: [],
  'TensorFlow Lite': ['TensorFlowLite', 'TFLite', 'TFLInterpreter'],
  'PyTorch Mobile': ['LibTorch', 'torch'],
  OpenCV: ['opencv2', 'CVMat', 'libopencv'],
  '腾讯验证码': ['TencentCaptcha', 'TCaptcha'],
  '极验 Geetest': ['GT3Captcha', 'GT3CaptchaManager', 'Geetest'],
  '顶象风控': ['DXCaptcha', 'DXSDK'],
  'SafetyNet / Play Integrity': ['DeviceCheck', 'DCDevice'],
  'Plaid': ['PLKLinkKit', 'LinkKit'],
  '腾讯云 SDK': ['QCloud', 'TencentCloud'],
  '阿里云 SDK': ['Alicloud', 'Aliyun'],
  'AWS SDK': ['AWSCore', 'AWSS3', 'AWSMobileClient'],
  '腾讯 MTA': ['MTA', 'TACMTA']
};

// ==================== 加固 / 混淆签名库 ====================

const PACKER_SIGNATURES = [
  { name: '360 加固保', vendor: '奇虎 360', markers: ['libjiagu.so', 'libjiagu_art.so', 'libjiagu_ls.so', 'com/stub/StubApp', 'libprotectClass.so', 'libjgdtc.so'] },
  { name: '腾讯乐固（LegSec）', vendor: '腾讯', markers: ['libshella.so', 'libshellx.so', 'libshellso.so', 'com/tencent/StubShell', 'libtosprotection'] },
  { name: '腾讯御安全', vendor: '腾讯', markers: ['libtxmss.so', 'libtxsafe.so', 'com/tencent/kingkong'] },
  { name: '腾讯加固（Mixsdk）', vendor: '腾讯', markers: ['libmixsdk.so', 'com/tencent/mixsdk'] },
  { name: '梆梆安全（Bangcle）', vendor: '梆梆安全', markers: ['libDexHelper.so', 'libSecShell.so', 'com/secneo/apkwrapper', 'libsecexe.so', 'libsecmain.so'] },
  { name: '爱加密（ijiami）', vendor: '爱加密', markers: ['libijiami.so', 'libexec.so', 'libexecmain.so', 'com/secure/shell', 'signed_ijiami'] },
  { name: '娜迦（Nagain）', vendor: '娜迦', markers: ['libchaosvmp.so', 'libddog.so', 'libfdog.so', 'libedog.so', 'libnqshield.so'] },
  { name: '阿里加固（聚安全）', vendor: '阿里', markers: ['libmobisec.so', 'com/ali/mobisec', 'libsgmainso', 'com/taobao/wireless/security'] },
  { name: '顶象加固', vendor: '顶象', markers: ['libdxs.so', 'libdxx.so', 'com/dingxiang/security'] },
  { name: '网易易盾', vendor: '网易', markers: ['libnesec.so', 'libyidun.so', 'com/netease/nis'] },
  { name: '百度加固', vendor: '百度', markers: ['libbaiduprotect.so', 'com/baidu/protect', 'libbaiduprotect_x86.so'] },
  { name: '几维安全（KiwiVM）', vendor: '几维安全', markers: ['libkwscmm.so', 'libkiwivm.so', 'com/kiwisec'] },
  { name: '通付盾', vendor: '通付盾', markers: ['libtup.so', 'com/payegis'] },
  { name: '瑞星加固', vendor: '瑞星', markers: ['librising.so', 'com/rising/protect'] },
  { name: '网秦加固', vendor: '网秦', markers: ['libnetqin.so'] },
  { name: '海云安加固', vendor: '海云安', markers: ['libhyst.so'] },
  { name: '深信服加固', vendor: '深信服', markers: ['libsangfor.so'] },
  { name: 'Virbox Protector', vendor: '深思数盾', markers: ['libvirbox.so', 'senseshield'] },
  { name: '国泰新点加固', vendor: '国泰新点', markers: ['libepp.so'] },
  { name: '七星加固', vendor: '七星', markers: ['libqixing.so'] },
  { name: 'ProGuard / R8 混淆', vendor: 'Google', markers: ['mapping.txt'], soft: true },
  { name: 'Bangcle Excalibur', vendor: '梆梆安全', markers: ['libbangcle_arm.so', 'libencryptlib.so'] },
  { name: 'APKProtect', vendor: '未知', markers: ['libapkprotect.so'] },
  { name: 'Tencent 手游加固', vendor: '腾讯', markers: ['libtermmss.so', 'libtpsec.so'] },
  { name: 'JiaGu360 Pro', vendor: '奇虎 360', markers: ['libjiagu_pro.so', 'libjgdtc64.so'] }
];

/**
 * 反调试 / 反虚拟机 / 反 Root / 字符串加密 / 完整性校验特征。
 *
 * 注意：这里的标记必须足够「专有」。像裸的 `su`、`qemu`、`busybox` 这类短词
 * 在正常应用的字符串里也会出现，会造成大量误报，因此一律使用带上下文的长标记。
 */
const HARDENING_MARKERS = {
  anti_debug: [
    'libantidebug', 'TracerPid', 'ptrace(PTRACE_TRACEME', 'PTRACE_DETACH',
    'frida-gadget', 'libfrida', 're.frida.server', 'libsubstrate.so', 'com.saurik.substrate',
    'de.robv.android.xposed', 'XposedBridge', 'libxposed', 'libdptrace'
  ],
  anti_vm: [
    'libvbox', 'vbox86', 'genymotion', 'bluestacks', 'libnox',
    'qemu_pipe', 'goldfish_pipe', 'libc_malloc_debug_qemu', 'ro.kernel.qemu', 'ldplayer'
  ],
  anti_root: [
    'Superuser.apk', 'eu.chainfire.supersu', 'com.noshufou.android.su',
    'com.topjohnwu.magisk', 'magiskhide', 'librootcloak', 'ro.debuggable',
    '/system/xbin/su', '/system/bin/su', '/sbin/su', 'busybox'
  ],
  string_encryption: [
    'libmetasec', 'libmobisec', 'StringFog', 'libstringfog', 'libnativehelper_enc', 'libstringencrypt'
  ],
  integrity_check: [
    'SafetyNet', 'PlayIntegrity', 'checkSignature', 'verifySignature', 'libintegrity', 'AttestationResult'
  ]
};

// ==================== 框架识别（iOS） ====================

const IOS_FRAMEWORK_MARKERS = [
  { name: 'Flutter', markers: ['Flutter.framework', 'flutter_assets', 'App.framework'] },
  { name: 'React Native', markers: ['React.framework', 'ReactNative', 'hermes.framework', 'main.jsbundle'] },
  { name: 'Unity', markers: ['UnityFramework.framework', 'UnityFramework', 'Data/Managed', 'il2cpp'] },
  { name: 'Cocos2d-x', markers: ['libcocos2d', 'cocos2djs'] },
  { name: 'Cordova', markers: ['Cordova.framework', 'www/cordova.js', 'cordova_plugins.js'] },
  { name: 'Ionic / Capacitor', markers: ['Capacitor.framework', 'public/capacitor.config.json'] },
  { name: 'Xamarin', markers: ['Xamarin.iOS', 'mono.framework', 'libmonosgen'] },
  { name: 'Swift', markers: ['libswiftCore.dylib', 'Swift.framework', 'libswift_Concurrency.dylib'] },
  { name: 'Objective-C', markers: ['libobjc.A.dylib', 'Foundation.framework'] },
  { name: 'CocoaPods', markers: ['Pods_', 'Pods.xcodeproj', 'Pods-Dummy.m'] },
  { name: 'Swift Package Manager', markers: ['SourcePackages', '.swiftpm'] },
  { name: 'Adobe AIR', markers: ['Adobe AIR.framework'] },
  { name: 'Corona / Solar2D', markers: ['Corona.framework'] },
  { name: 'Weex', markers: ['WeexSDK.framework'] }
];

// ==================== 工具函数 ====================

/** 在文本/二进制证据中查找标记，返回命中的标记列表。 */
function findMarkers(markers, sources) {
  const hits = [];
  for (const marker of markers) {
    if (!marker) continue;
    for (const source of sources) {
      if (!source) continue;
      if (source.type === 'text') {
        if (source.value.includes(marker)) {
          hits.push({ marker, where: source.label });
          break;
        }
      } else if (source.value.includes(Buffer.from(marker, 'latin1'))) {
        hits.push({ marker, where: source.label });
        break;
      }
    }
  }
  return hits;
}

/**
 * 识别 SDK。
 * @param {Array<{type:'text'|'buffer', value:any, label:string}>} sources
 */
function detectSdks(sources) {
  const results = [];
  for (const signature of SDK_SIGNATURES) {
    const iosMarkers = IOS_SDK_MARKERS[signature.name] || [];
    const markers = [...signature.markers, ...iosMarkers].filter(Boolean);
    const hits = findMarkers(markers, sources);
    if (!hits.length) continue;
    const isIosHit = iosMarkers.includes(hits[0].marker);
    results.push({
      sdk_name: signature.name,
      sdk_version: extractVersionFromEvidence(sources, signature.name),
      sdk_category: signature.category,
      sdk_vendor: signature.vendor,
      sdk_country: signature.country,
      sdk_website: signature.website,
      sdk_license: signature.license,
      sdk_platform: isIosHit ? 'iOS' : 'Android',
      sdk_evidence: hits.map((hit) => `${hit.where}: ${hit.marker}`),
      sdk_risk: PRIVACY_SENSITIVE_CATEGORIES.has(signature.category) ? '隐私相关' : '一般',
      sdk_privacy: PRIVACY_SENSITIVE_CATEGORIES.has(signature.category) ? '可能采集设备标识与行为数据' : '未发现明显隐私采集'
    });
  }
  return results.sort((a, b) => a.sdk_category.localeCompare(b.sdk_category, 'zh') || a.sdk_name.localeCompare(b.sdk_name, 'zh'));
}

/**
 * 版本号提取的搜索半径（字符）。
 * 取 ±200 足够覆盖 `com/xxx/sdk/3.2.1` 这类上下文，又不会退化成全串扫描。
 */
const VERSION_SEARCH_WINDOW = 200;

/** 转义正则元字符。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 尽量从证据文本中提取版本号（形如 com/xxx/sdk/3.2.1）。
 *
 * **性能说明（重要）**：这里曾经对整段文本直接跑带回溯的正则
 * （`[\w/.]{0,60}名称[\w/.]{0,40}`），而它会被 `detectSdks` 对**每个命中的 SDK**
 * 调用一次。在 8.5MB 的 DEX 字符串上，20 个 SDK 实测耗时 **5924ms**，
 * 占整个包体解析耗时的 **94%**（24MB 的包因此比 200MB 的还慢）。
 *
 * 现在先用原生 `indexOf` 定位（比正则快几个数量级），只在命中位置附近开窗匹配：
 * 同样的输入实测 **20ms**，加速约 **296×**，且提取结果不变。
 */
function extractVersionFromEvidence(sources, sdkName) {
  const versionPattern = /(\d+\.\d+\.\d+(?:\.\d+)?)/;
  const namePattern = escapeRegExp(sdkName);

  for (const source of sources) {
    if (source.type !== 'text') continue;

    const at = source.value.indexOf(sdkName);
    if (at < 0) continue;

    const from = Math.max(0, at - VERSION_SEARCH_WINDOW);
    const to = Math.min(source.value.length, at + VERSION_SEARCH_WINDOW);
    const window = source.value.slice(from, to);

    const markerHit = new RegExp(`([\\w/.]{0,60}${namePattern}[\\w/.]{0,40})`).exec(window);
    if (!markerHit) continue;

    const versionMatch = markerHit[1].match(versionPattern);
    if (versionMatch) return versionMatch[1];
  }
  return null;
}

/** 识别加固。 */
function detectPacker(sources, dexInfo) {
  const matches = [];
  for (const packer of PACKER_SIGNATURES) {
    const hits = findMarkers(packer.markers, sources);
    if (!hits.length) continue;
    matches.push({
      packer_name: packer.name,
      packer_vendor: packer.vendor,
      soft: Boolean(packer.soft),
      packer_evidence: hits.map((hit) => `${hit.where}: ${hit.marker}`)
    });
  }

  const strong = matches.filter((item) => !item.soft);
  const best = strong[0] || matches[0] || null;

  return {
    is_packed: strong.length > 0,
    suspected: strong.length === 0 && matches.length > 0,
    packer_name: best ? best.packer_name : null,
    packer_vendor: best ? best.packer_vendor : null,
    packer_version: null,
    packer_evidence: best ? best.packer_evidence : [],
    matches,
    is_obfuscated: Boolean(dexInfo?.obfuscated),
    obfuscation_level: dexInfo
      ? (dexInfo.short_class_ratio >= 0.6 ? '高' : (dexInfo.short_class_ratio >= 0.3 ? '中' : '低'))
      : '未知',
    short_class_ratio: dexInfo ? dexInfo.short_class_ratio : null
  };
}

/** 识别加固对抗特征。 */
function detectHardening(sources) {
  const result = {};
  for (const [key, markers] of Object.entries(HARDENING_MARKERS)) {
    result[key] = findMarkers(markers, sources).length > 0;
  }
  return result;
}

/** 识别 iOS 框架。 */
function detectIosFrameworks(textSources) {
  const detected = [];
  for (const framework of IOS_FRAMEWORK_MARKERS) {
    const hits = framework.markers.filter((marker) => textSources.some((text) => text.includes(marker)));
    if (hits.length) detected.push({ name: framework.name, evidence: hits });
  }
  return detected;
}

// ==================== 风险规则引擎 ====================

/**
 * 严重级别权重。
 * 采用「首个满额 + 后续按 0.45 递减」，避免规则命中多就把分数直接顶到 100，
 * 让不同风险程度的包体在高分段仍能拉开差距。
 */
const SEVERITY_WEIGHT = { critical: 34, high: 13, medium: 6, low: 2, info: 0 };
const SEVERITY_DECAY = 0.45;

/**
 * 计算风险评分（0~100）与等级。
 */
function computeRiskScore(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;

  let score = 0;
  for (const [severity, weight] of Object.entries(SEVERITY_WEIGHT)) {
    const count = bySeverity[severity] || 0;
    if (!count) continue;
    let subtotal = 0;
    for (let i = 0; i < count; i += 1) subtotal += weight * Math.pow(SEVERITY_DECAY, i);
    score += subtotal;
  }
  score = Math.min(100, Math.round(score));

  let level = 'safe';
  if (score >= 85) level = 'critical';
  else if (score >= 62) level = 'high';
  else if (score >= 38) level = 'medium';
  else if (score >= 14) level = 'low';

  return { score, level, counts: bySeverity };
}

const LEVEL_LABELS = {
  safe: '安全',
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重'
};

function makeFinding(id, category, severity, message, options = {}) {
  return {
    id,
    category,
    severity,
    confidence: options.confidence || 'high',
    message,
    evidence: options.evidence || [],
    remediation: options.remediation || '',
    cwe: options.cwe || null,
    owasp: options.owasp || null
  };
}

/**
 * 通用风险规则评估。
 * @param {object} context 分析结果上下文（apk / ipa 的详细数据）
 */
function evaluateRisk(context) {
  const findings = [];
  const {
    platform,
    signature,
    manifest,
    permissions = [],
    components = {},
    dex,
    native,
    packer,
    hardening,
    privacy,
    sdks = [],
    abis = [],
    bundle
  } = context;

  // ---------- 签名 ----------
  if (!signature?.signed) {
    findings.push(makeFinding('sig-missing', '签名', 'critical',
      '应用包体未签名，可被任意篡改后重新分发',
      { remediation: '使用正式证书对包体签名后再分发', cwe: 'CWE-345' }));
  } else {
    if (signature.summary?.is_debug) {
      findings.push(makeFinding('sig-debug', '签名', 'high',
        '使用 Android Debug 调试证书签名，不具备发布资格，且私钥公开可获取',
        { evidence: [signature.summary.subject], remediation: '改用正式发布证书重新签名', cwe: 'CWE-321' }));
    }
    if (signature.summary?.is_expired) {
      findings.push(makeFinding('sig-expired', '签名', 'medium',
        '签名证书已过期',
        { evidence: signature.summary.expired_subjects, remediation: '使用有效期内的证书重新签名', cwe: 'CWE-298' }));
    }
    if (signature.summary?.is_weak_algorithm) {
      findings.push(makeFinding('sig-weak-alg', '签名', 'high',
        '签名算法强度不足（MD5/SHA1 或 RSA 密钥小于 2048 位）',
        { evidence: [signature.summary.signature_algorithm, signature.summary.public_key?.keySizeLabel], remediation: '升级为 SHA256withRSA 且密钥长度不低于 2048 位', cwe: 'CWE-327' }));
    }
    if (signature.summary?.is_self_signed) {
      findings.push(makeFinding('sig-self-signed', '签名', 'low',
        '证书为自签名，无法通过公共信任链校验',
        { remediation: '使用受信任 CA 签发的证书', cwe: 'CWE-295' }));
    }
    if (platform === 'android') {
      if (!signature.v2?.signed && !signature.v3?.signed && !signature.v3_1?.signed) {
        // v1 也失效的话，这个包实际上等于没有有效签名，别再说成「仅使用 v1」
        const onlyStaleV1 = Boolean(signature.v1?.stale);
        findings.push(makeFinding('sig-no-v2v3', '签名', onlyStaleV1 ? 'high' : 'medium',
          onlyStaleV1
            ? '没有任何有效的签名方案：v1 签名已失效，且缺少 v2/v3 签名'
            : '仅使用 v1（JAR）签名，缺少 v2/v3 签名方案，存在 Janus 类漏洞风险（CVE-2017-13156）',
          { remediation: '使用 apksigner 同时启用 v2/v3 签名', cwe: 'CWE-347' }));
      }
      if (!signature.v1?.signed && signature.v2?.signed) {
        findings.push(makeFinding('sig-no-v1', '签名', 'low',
          '缺少 v1 签名，Android 6.0 以下设备可能无法校验完整性',
          { remediation: '如仍需支持 Android 6.0 以下设备，请同时启用 v1 签名' }));
      }
      // v1 签名文件还在、摘要却对不上：典型的「签名后被重打包 / 加固」。
      // 这种包看着像有 v1 签名，其实对 Android 6.0 以下毫无保护作用。
      if (signature.v1?.stale) {
        findings.push(makeFinding('sig-v1-stale', '签名', 'medium',
          `v1 签名文件存在但已失效：${signature.v1.stale_reason || '摘要不匹配'}。` +
          'APK 很可能在 v1 签名后被重新打包或加固过',
          {
            remediation: '用当前包体重新执行 v1 签名，或确认加固流程是否会保留失效的 META-INF 签名文件',
            cwe: 'CWE-347'
          }));
      }
      if (signature.summary?.v2_v3_consistent === false) {
        findings.push(makeFinding('sig-v2v3-mismatch', '签名', 'high',
          'v2 与 v3 签名证书不一致，可能被用于降级攻击',
          { remediation: '统一使用同一证书重新签名', cwe: 'CWE-757' }));
      }
    }
  }

  // ---------- Manifest 级 ----------
  if (platform === 'android' && manifest) {
    if (manifest.application?.debuggable) {
      findings.push(makeFinding('mf-debuggable', '代码', 'critical',
        'application 开启了 debuggable，任意进程可附加调试器读取内存与私有数据',
        { evidence: ['android:debuggable="true"'], remediation: '发布版本移除 debuggable 属性', cwe: 'CWE-489' }));
    }
    if (manifest.application?.allowBackup) {
      findings.push(makeFinding('mf-allow-backup', '隐私', 'medium',
        'allowBackup 为 true，可通过 adb backup 导出应用私有数据',
        { evidence: ['android:allowBackup="true"'], remediation: '设置 android:allowBackup="false" 或配置 backup rules', cwe: 'CWE-538' }));
    }
    if (manifest.application?.usesCleartextTraffic) {
      findings.push(makeFinding('mf-cleartext', '网络', 'high',
        '全局允许明文 HTTP 流量（usesCleartextTraffic=true），存在中间人窃听风险',
        { evidence: ['android:usesCleartextTraffic="true"'], remediation: '关闭该属性并配置 networkSecurityConfig 白名单', cwe: 'CWE-319' }));
    }
    if (manifest.application?.testOnly) {
      findings.push(makeFinding('mf-test-only', '代码', 'low',
        '应用标记为 testOnly，仅用于测试分发',
        { remediation: '发布版本移除 android:testOnly' }));
    }
    if (manifest.minSdk != null && manifest.minSdk <= 21) {
      findings.push(makeFinding('mf-min-sdk-low', '代码', 'medium',
        `minSdkVersion 过低（${manifest.minSdk}），大量已知系统漏洞无法被平台修复覆盖`,
        { evidence: [`minSdkVersion=${manifest.minSdk}`], remediation: '提升 minSdkVersion 至 23 以上', cwe: 'CWE-1104' }));
    }
    if (manifest.targetSdk != null && manifest.targetSdk < 31) {
      findings.push(makeFinding('mf-target-sdk-low', '代码', 'high',
        `targetSdkVersion 过低（${manifest.targetSdk}），无法获得系统的隐私与安全强制约束`,
        { evidence: [`targetSdkVersion=${manifest.targetSdk}`], remediation: '提升 targetSdkVersion 至 33 以上', cwe: 'CWE-1104' }));
    }
    if (manifest.sharedUserId) {
      findings.push(makeFinding('mf-shared-user-id', '代码', 'medium',
        `声明了 sharedUserId（${manifest.sharedUserId}），与其他应用共享进程与数据目录`,
        { evidence: [manifest.sharedUserId], remediation: '移除 sharedUserId，改用 ContentProvider 受控共享', cwe: 'CWE-269' }));
    }
    if (manifest.application?.networkSecurityConfig) {
      const target = manifest.application.networkSecurityConfigPath
        || manifest.application.networkSecurityConfig;
      findings.push(makeFinding('mf-nsc', '网络', 'info',
        `配置了自定义 networkSecurityConfig（${target}），需人工确认是否放宽了证书校验`,
        { evidence: [target] }));
    }
  }

  // ---------- 组件导出 ----------
  if (platform === 'android' && components) {
    const exportedActivities = (components.activities || []).filter((item) => item.exported && !item.permission);
    const exportedServices = (components.services || []).filter((item) => item.exported && !item.permission);
    const exportedReceivers = (components.receivers || []).filter((item) => item.exported && !item.permission);
    const exportedProviders = (components.providers || []).filter((item) => item.exported && !item.permission && !item.readPermission && !item.writePermission);

    if (exportedActivities.length) {
      findings.push(makeFinding('cmp-exported-activity', '组件', 'high',
        `存在 ${exportedActivities.length} 个导出且未设置权限保护的 Activity，可被任意应用拉起`,
        { evidence: exportedActivities.slice(0, 8).map((item) => item.name), remediation: '为导出组件设置 android:permission，或改为 exported="false"', cwe: 'CWE-926' }));
    }
    if (exportedServices.length) {
      findings.push(makeFinding('cmp-exported-service', '组件', 'high',
        `存在 ${exportedServices.length} 个导出且未设置权限保护的 Service`,
        { evidence: exportedServices.slice(0, 8).map((item) => item.name), remediation: '为导出 Service 设置 android:permission', cwe: 'CWE-926' }));
    }
    if (exportedReceivers.length) {
      findings.push(makeFinding('cmp-exported-receiver', '组件', 'medium',
        `存在 ${exportedReceivers.length} 个导出且未设置权限保护的 BroadcastReceiver`,
        { evidence: exportedReceivers.slice(0, 8).map((item) => item.name), remediation: '为导出 Receiver 设置权限，或改为动态注册', cwe: 'CWE-926' }));
    }
    if (exportedProviders.length) {
      findings.push(makeFinding('cmp-exported-provider', '组件', 'critical',
        `存在 ${exportedProviders.length} 个导出且无读写权限保护的 ContentProvider，可能导致数据泄露或注入`,
        { evidence: exportedProviders.slice(0, 8).map((item) => item.name), remediation: '设置 readPermission/writePermission 或 exported="false"', cwe: 'CWE-926' }));
    }
    const grantUriProviders = (components.providers || []).filter((item) => item.grantUriPermissions);
    if (grantUriProviders.length) {
      findings.push(makeFinding('cmp-grant-uri', '组件', 'medium',
        `存在 ${grantUriProviders.length} 个开启 grantUriPermissions 的 Provider，需确认 URI 权限范围可控`,
        { evidence: grantUriProviders.slice(0, 8).map((item) => item.name), remediation: '为 <grant-uri-permission> 限定 pathPrefix/pathPattern', cwe: 'CWE-284' }));
    }
    const taskAffinityActivities = (components.activities || []).filter((item) => item.taskAffinity && item.exported);
    if (taskAffinityActivities.length) {
      findings.push(makeFinding('cmp-task-affinity', '组件', 'low',
        `存在 ${taskAffinityActivities.length} 个导出 Activity 自定义了 taskAffinity，存在界面劫持风险`,
        { evidence: taskAffinityActivities.slice(0, 8).map((item) => item.name), cwe: 'CWE-1021' }));
    }
    const customPermissions = (components.customPermissions || []).filter((item) => item.protectionLevel === 'normal' || item.protectionLevel == null);
    if (customPermissions.length) {
      findings.push(makeFinding('cmp-weak-custom-permission', '组件', 'medium',
        `存在 ${customPermissions.length} 个自定义权限保护级别为 normal，任何应用均可申请并获得授权`,
        { evidence: customPermissions.slice(0, 8).map((item) => item.name), remediation: '自定义权限使用 signature 保护级别', cwe: 'CWE-732' }));
    }
  }

  // ---------- 权限 ----------
  const dangerousPermissions = permissions.filter((item) => item.dangerous);
  if (dangerousPermissions.length) {
    findings.push(makeFinding('perm-dangerous', '权限', 'medium',
      `申请了 ${dangerousPermissions.length} 项危险权限，涉及用户敏感数据`,
      {
        confidence: 'high',
        evidence: dangerousPermissions.map((item) => item.name).slice(0, 20),
        remediation: '按最小必要原则裁剪权限，并改为使用时申请',
        cwe: 'CWE-250'
      }));
  }
  const specialPermissions = permissions.filter((item) => item.protectionLevel === 'special');
  if (specialPermissions.length) {
    findings.push(makeFinding('perm-special', '权限', 'high',
      `申请了 ${specialPermissions.length} 项特殊权限，需在系统设置中单独授权，滥用风险高`,
      { evidence: specialPermissions.map((item) => `${item.name}（${item.description}）`).slice(0, 12), cwe: 'CWE-250' }));
  }
  const signaturePermissions = permissions.filter((item) => item.protectionLevel === 'signature');
  if (signaturePermissions.length) {
    findings.push(makeFinding('perm-signature', '权限', 'high',
      `申请了 ${signaturePermissions.length} 项系统签名级权限，普通应用无法获得，属于异常申请`,
      { evidence: signaturePermissions.map((item) => item.name).slice(0, 12), cwe: 'CWE-250' }));
  }
  const permissionNames = new Set(permissions.map((item) => item.name));
  for (const combo of PERMISSION_COMBOS) {
    if (!combo.permissions.every((name) => permissionNames.has(name))) continue;
    findings.push(makeFinding(combo.id, '权限', combo.severity, combo.message, {
      evidence: combo.permissions,
      remediation: combo.remediation,
      cwe: combo.cwe
    }));
  }

  // ---------- 代码 / DEX ----------
  if (platform === 'android' && dex) {
    if (dex.multidex_required && !dex.multidex) {
      findings.push(makeFinding('dex-method-limit', '代码', 'medium',
        `方法数超过 65536（${dex.method_count}）但未启用 multidex，低版本设备可能崩溃`,
        { evidence: [`method_count=${dex.method_count}`], remediation: '启用 multidex 或进行代码裁剪' }));
    }
    if (dex.obfuscated === false) {
      findings.push(makeFinding('dex-not-obfuscated', '代码', 'low',
        '未检测到明显的代码混淆，类名可读，便于逆向分析',
        { evidence: [`短类名比例 ${(dex.short_class_ratio * 100).toFixed(1)}%`], remediation: '启用 R8/ProGuard 混淆并保留必要规则', cwe: 'CWE-656' }));
    }
  }

  // ---------- 加固 ----------
  if (packer) {
    if (packer.suspected) {
      findings.push(makeFinding('packer-suspected', '加固', 'info',
        `疑似使用了加固/保护方案（${packer.matches.map((item) => item.packer_name).join('、')}）`,
        { evidence: packer.matches.flatMap((item) => item.packer_evidence).slice(0, 8) }));
    } else if (packer.is_packed) {
      findings.push(makeFinding('packer-detected', '加固', 'info',
        `检测到加固方案：${packer.packer_name}`,
        { evidence: packer.packer_evidence.slice(0, 8), remediation: '加固为增强保护措施，但会阻碍安全审计，请确认合规性' }));
    }
  }
  if (hardening) {
    const enabled = Object.entries(hardening).filter(([, value]) => value).map(([key]) => key);
    if (enabled.length) {
      findings.push(makeFinding('hardening-features', '加固', 'info',
        `检测到 ${enabled.length} 项加固对抗特征：${enabled.join('、')}`,
        { evidence: enabled, confidence: 'medium' }));
    }
  }

  // ---------- Native ----------
  if (platform === 'android') {
    const missingArm64 = abis.length > 0 && !abis.some((abi) => abi.includes('arm64'));
    if (missingArm64) {
      findings.push(makeFinding('native-no-arm64', '代码', 'medium',
        `未提供 arm64-v8a 原生库（当前：${abis.join(', ')}），在 64 位设备上以兼容模式运行`,
        { evidence: abis, remediation: '补充 arm64-v8a 构建产物' }));
    }
    for (const library of native?.libraries || []) {
      if (library.security && library.security.nx === false) {
        findings.push(makeFinding(`native-nx-${library.name}`, '代码', 'high',
          `原生库 ${library.name} 可执行栈（NX 未启用），存在栈溢出利用风险`,
          { evidence: [library.name], cwe: 'CWE-121' }));
        break;
      }
    }
    for (const library of native?.libraries || []) {
      if (library.security && library.security.canary === false) {
        findings.push(makeFinding(`native-canary-${library.name}`, '代码', 'medium',
          `原生库 ${library.name} 未启用栈保护（Stack Canary）`,
          { evidence: [library.name], cwe: 'CWE-121' }));
        break;
      }
    }
    for (const library of native?.libraries || []) {
      if (library.rpath) {
        findings.push(makeFinding(`native-rpath-${library.name}`, '代码', 'medium',
          `原生库 ${library.name} 设置了 RPATH（${library.rpath}），可能被用于劫持加载`,
          { evidence: [library.name, library.rpath], cwe: 'CWE-427' }));
        break;
      }
    }
  }

  // ---------- 网络 ----------
  if (platform === 'android') {
    const urls = context.network?.cleartext_urls || [];
    if (urls.length) {
      findings.push(makeFinding('net-cleartext-url', '网络', 'high',
        `在包体中发现 ${urls.length} 个明文 HTTP 地址`,
        { evidence: urls.slice(0, 10), remediation: '全部改用 HTTPS', cwe: 'CWE-319' }));
    }
    if (context.network?.has_trust_all) {
      findings.push(makeFinding('net-trust-all', '网络', 'critical',
        '检测到「信任所有证书」的代码特征（TrustAllCerts / ALLOW_ALL_HOSTNAME_VERIFIER）',
        { evidence: context.network.trust_all_evidence?.slice(0, 6) || [], remediation: '移除自定义 TrustManager，使用系统默认证书校验', cwe: 'CWE-295', owasp: 'M3: Insecure Communication' }));
    }
  }
  if (platform === 'ios') {
    if (context.network?.ats_disabled) {
      findings.push(makeFinding('ios-ats-disabled', '网络', 'high',
        'Info.plist 中 NSAllowsArbitraryLoads 为 true，已全局关闭 App Transport Security',
        { evidence: ['NSAppTransportSecurity.NSAllowsArbitraryLoads = true'], remediation: '关闭该开关，改为按域名配置例外', cwe: 'CWE-319' }));
    }
    if (context.signature?.provision?.get_task_allow) {
      findings.push(makeFinding('ios-get-task-allow', '签名', 'high',
        '描述文件开启了 get-task-allow，允许调试器附加进程',
        { evidence: ['get-task-allow = true'], remediation: '使用发布（App Store / Ad Hoc）描述文件重新签名', cwe: 'CWE-489' }));
    }
    if (context.signature?.provision?.provisions_all_devices) {
      findings.push(makeFinding('ios-enterprise', '签名', 'medium',
        '使用企业（In-House）描述文件，不限制安装设备，存在被滥用分发的风险',
        { evidence: ['ProvisionsAllDevices = true'] }));
    }
    if (context.signature?.provision?.expired) {
      findings.push(makeFinding('ios-provision-expired', '签名', 'high',
        '描述文件已过期，应用无法安装或会被系统拒绝启动',
        { evidence: [String(context.signature.provision.expiration_date)], remediation: '使用有效期内的描述文件重新签名' }));
    }
    if (context.native?.binary?.encrypted) {
      findings.push(makeFinding('ios-fairplay', '代码', 'info',
        '主二进制启用了 FairPlay 加密（cryptid > 0），来自 App Store 下载的包体需要先解密才能静态分析',
        { evidence: [`cryptid=${context.native.binary.cryptid}`] }));
    } else if (context.native?.binary && context.signature?.provision?.signing_type === 'App Store') {
      findings.push(makeFinding('ios-decrypted', '代码', 'medium',
        '包体标记为 App Store 分发但二进制未加密，说明已被解密（脱壳）',
        { evidence: ['cryptid = 0'], confidence: 'medium' }));
    }
    if (context.native?.binary?.security?.pie === false) {
      findings.push(makeFinding('ios-no-pie', '代码', 'high',
        '主二进制未启用 PIE（ASLR），存在固定地址利用风险',
        { evidence: ['MH_PIE 未设置'], cwe: 'CWE-119' }));
    }
  }

  // ---------- 隐私 ----------
  if (platform === 'android' && privacy) {
    const trackers = privacy.device_identifiers || [];
    if (trackers.length) {
      findings.push(makeFinding('privacy-device-id', '隐私', 'high',
        `包体中出现 ${trackers.length} 类设备唯一标识采集特征`,
        { evidence: trackers, remediation: '改用 OAID/AAID 等可重置标识，并做好告知与同意', cwe: 'CWE-359' }));
    }
    if (privacy.privacy_policy_present === false) {
      findings.push(makeFinding('privacy-no-policy', '隐私', 'medium',
        '未在包体中发现隐私政策链接或声明',
        { remediation: '在应用内与商店页面提供隐私政策入口' }));
    }
    if (privacy.children_app) {
      findings.push(makeFinding('privacy-children', '隐私', 'critical',
        '疑似面向儿童的应用，但仍存在设备标识或行为数据采集特征',
        { remediation: '严格遵循儿童个人信息保护规定，禁止个性化推荐与标识采集', cwe: 'CWE-359' }));
    }
  }
  if (platform === 'ios' && privacy) {
    if (privacy.tracking && !privacy.att_description) {
      findings.push(makeFinding('ios-att-missing', '隐私', 'high',
        '存在跟踪行为但未提供 NSUserTrackingUsageDescription（ATT 说明）',
        { remediation: '补充 NSUserTrackingUsageDescription 并在采集前请求授权', cwe: 'CWE-359' }));
    }
    if (privacy.usage_descriptions_missing?.length) {
      findings.push(makeFinding('ios-usage-desc-missing', '隐私', 'medium',
        `${privacy.usage_descriptions_missing.length} 项敏感能力缺少用途说明文案`,
        { evidence: privacy.usage_descriptions_missing, remediation: '为每项权限补充对应的 NS*UsageDescription' }));
    }
    if (!privacy.privacy_manifest_present) {
      findings.push(makeFinding('ios-privacy-manifest-missing', '隐私', 'medium',
        '缺少 PrivacyInfo.xcprivacy 隐私清单，可能被 App Store 审核拒绝',
        { remediation: '添加 PrivacyInfo.xcprivacy 并声明 Required Reason API 与数据类型', cwe: 'CWE-1059' }));
    }
  }

  // ---------- SDK ----------
  const adSdks = sdks.filter((sdk) => sdk.sdk_category === '广告');
  if (adSdks.length) {
    findings.push(makeFinding('sdk-ad', 'SDK', 'medium',
      `集成 ${adSdks.length} 个广告 SDK，通常伴随设备标识与行为数据采集`,
      { evidence: adSdks.map((sdk) => sdk.sdk_name), remediation: '确认广告 SDK 已获用户同意，并提供关闭个性化广告入口', cwe: 'CWE-359' }));
  }
  const overseasSdks = sdks.filter((sdk) => sdk.sdk_country && sdk.sdk_country !== '中国');
  if (overseasSdks.length) {
    findings.push(makeFinding('sdk-overseas', 'SDK', 'low',
      `集成 ${overseasSdks.length} 个境外 SDK，存在数据出境合规风险`,
      { evidence: overseasSdks.map((sdk) => `${sdk.sdk_name}（${sdk.sdk_country}）`), remediation: '评估数据出境合规性，必要时完成安全评估与告知同意', cwe: 'CWE-359' }));
  }
  const trackerSdks = sdks.filter((sdk) => ['统计', '推送'].includes(sdk.sdk_category));
  if (trackerSdks.length >= 3) {
    findings.push(makeFinding('sdk-tracker-many', 'SDK', 'medium',
      `集成 ${trackerSdks.length} 个统计/推送类 SDK，数据采集面较广`,
      { evidence: trackerSdks.map((sdk) => sdk.sdk_name) }));
  }

  const risk = computeRiskScore(findings);
  const sorted = findings.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return order[a.severity] - order[b.severity];
  });

  return {
    findings: sorted,
    ...risk,
    level_label: LEVEL_LABELS[risk.level],
    top: sorted.filter((item) => item.severity !== 'info').slice(0, 3).map((item) => item.message)
  };
}

module.exports = {
  PROTECTION,
  PERMISSION_INFO,
  PERMISSION_COMBOS,
  SDK_SIGNATURES,
  IOS_SDK_MARKERS,
  PACKER_SIGNATURES,
  HARDENING_MARKERS,
  IOS_FRAMEWORK_MARKERS,
  PRIVACY_SENSITIVE_CATEGORIES,
  SEVERITY_WEIGHT,
  SEVERITY_DECAY,
  LEVEL_LABELS,
  findMarkers,
  detectSdks,
  extractVersionFromEvidence,
  detectPacker,
  detectHardening,
  detectIosFrameworks,
  computeRiskScore,
  evaluateRisk,
  makeFinding
};
