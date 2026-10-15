'use strict';

/**
 * 功能注册表 + 搜索排序。
 *
 * 从 App.jsx 抽出来是为了：
 * 1. 侧边栏、首页分类、命令面板共用同一份定义 —— 不会再出现「加了功能忘了加进某个列表」
 * 2. 搜索排序是纯函数，可以单测
 *
 * `keywords` 是给人用的：用户不会记得功能叫「读取应用信息」，
 * 他会搜 apk / 包名 / 权限 / 加固。**关键词决定这个工具能不能被找到。**
 */
export const FUNCTIONS = [
  {
    id: 'install',
    name: '安装应用',
    icon: '📦',
    keywords: ['apk', 'adb', 'install', '批量安装', '重装', '覆盖安装', '安装包']
  },
  {
    id: 'decompile',
    name: '反编译 / 回编译 APK / IPA',
    icon: '🔧',
    keywords: ['jadx', 'apktool', 'dex', '反编译', '回编译', '重打包', 'rebuild', '解包', '源码', 'smali', 'ipa', 'ios', 'mach-o', 'objc', '类名', '符号']
  },
  {
    id: 'info',
    name: '读取应用信息',
    icon: '📄',
    keywords: ['apk', 'aab', 'ipa', '包名', '版本号', '权限', '加固', '解析', '图标', '隐私清单', '渠道', 'sdk']
  },
  {
    id: 'sign',
    name: '应用签名',
    icon: '✍️',
    keywords: ['apk', 'ipa', 'keystore', '签名', '证书', '重签名', 'resign', 'v1', 'v2', 'v3', 'zipalign', '对齐', 'jks', '打包']
  },
  {
    id: 'code-search',
    name: 'DEX 代码检索',
    icon: '🔎',
    keywords: ['dex', '类名', '字符串', '搜索', '检索', '逆向', '反编译', 'apk', 'aab', '硬编码', '密钥', 'api key', 'url', 'jadx', '包结构', '混淆']
  },
  {
    id: 'text',
    name: '文本工具',
    icon: '🔤',
    keywords: ['base64', 'url', 'json', '编码', '解码', '哈希', 'md5', 'sha', '时间戳', 'uuid', 'jwt', '正则', '大小写', '排序', '去重', '转义', 'unicode']
  },
  {
    id: 'http',
    name: 'HTTP 请求',
    icon: '📡',
    keywords: ['api', '接口', '调试', 'get', 'post', 'curl', 'postman', '请求', '报文']
  },
  {
    id: 'files',
    name: '设备文件管理',
    icon: '📂',
    keywords: ['adb', '手机文件', '上传', '下载', '推送', 'pull', 'push', '沙盒', '文件']
  },
  {
    id: 'apps',
    name: '设备应用管理',
    icon: '📱',
    keywords: ['adb', '已安装应用', '卸载', '导出 apk', '应用列表', '包名']
  },
  {
    id: 'phone-device',
    name: '连接设备信息',
    icon: '📲',
    keywords: ['adb', '设备信息', '手机', '型号', '序列号', 'imei', '电池', '系统版本', '内存', 'cpu', '存储', '分辨率', '关机', '重启', '截图', '录屏', '音量', '息屏', '亮屏', '主界面']
  },
  {
    id: 'scrcpy',
    name: '设备投屏控制',
    icon: '🖥️',
    keywords: ['投屏', '镜像', 'mirror', 'scrcpy', 'adb', 'iphone', 'ios', '实时画面', '录屏', '远程控制']
  },
  {
    id: 'logs',
    name: '实时日志查看',
    icon: '📋',
    keywords: ['logcat', '日志', 'crash', '崩溃', '报错', 'anr', '堆栈']
  },
  {
    id: 'hash',
    name: '修改文件Hash',
    icon: '🔐',
    keywords: ['hash', 'md5', 'sha', '校验', '指纹', '改哈希', '文件指纹']
  },
  {
    id: 'rename',
    name: '文件批量命名',
    icon: '✏️',
    keywords: ['重命名', 'rename', '批量', '随机名', '序号', '改名']
  },
  {
    id: 'json',
    name: 'JSON 工具',
    icon: '🧾',
    keywords: ['json', '格式化', '美化', '压缩', 'dict', '字典', 'unicode', '转义', 'query', '参数']
  },
  {
    id: 'markdown',
    name: 'Markdown 编辑器',
    icon: '📝',
    keywords: ['md', 'markdown', '预览', '导出 html', '文档']
  },
  {
    id: 'xmind',
    name: 'XMind 预览',
    icon: '🗺️',
    keywords: ['思维导图', 'mindmap', 'xmind', '脑图']
  },
  {
    id: 'qrcode',
    name: '二维码工具',
    icon: '🔳',
    keywords: ['qr', '二维码', '扫码', '生成', '识别']
  },
  {
    id: 'web-file-server',
    name: '局域网文件服务',
    icon: '🌐',
    keywords: ['局域网', 'wifi', '手机访问', '传文件', 'http 服务', '共享']
  },
  {
    id: 'webdav-server',
    name: 'WebDAV 文件服务',
    icon: '🗄️',
    keywords: ['webdav', '网络磁盘', '挂载', '网盘', 'finder', '映射网络驱动器', '连接服务器', 'nfs', 'smb']
  },
  {
    id: 'device',
    name: '本机信息',
    icon: '💻',
    keywords: ['本机', '电脑', '系统', '硬件', 'mac', '环境', 'cpu', '内存', '磁盘']
  },
  {
    id: 'settings',
    name: '全局配置',
    icon: '⚙️',
    keywords: ['设置', '配置', '默认值', '偏好']
  }
];

/** 首页分类。顺序就是展示顺序；每个功能都必须出现在某个分类里（有测试守着）。 */
export const CATEGORIES = [
  {
    id: 'package',
    name: '安装与包体分析',
    functions: ['install', 'info', 'decompile', 'code-search', 'sign']
  },
  { id: 'text', name: '文本工具', functions: ['text', 'http', 'json', 'markdown', 'xmind'] },
  {
    id: 'dev',
    name: '开发工具',
    functions: ['files', 'apps', 'phone-device', 'scrcpy', 'logs', 'qrcode', 'web-file-server', 'webdav-server', 'hash', 'rename']
  },
  { id: 'system', name: '本机与设置', functions: ['device', 'settings'] }
];

/** 需要撑满窗口高度（页面自身滚动）的功能。 */
export const FILL_FUNCTIONS = ['logs', 'text', 'http', 'apps', 'rename', 'scrcpy', 'json', 'code-search'];

export const FAVORITE_LIMIT = 8;

export const findFunction = (id, list = FUNCTIONS) => list.find((item) => item.id === id) || null;

const normalize = (value) => String(value ?? '').trim().toLowerCase();

/**
 * 子序列模糊匹配：`jtn` 能命中「JSON 工具」。
 * 返回 0 表示不匹配；否则「越紧凑、起始位置越靠前」分数越高。
 */
function subsequenceScore(text, query) {
  let index = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length && index < query.length; i += 1) {
    if (text[i] === query[index]) {
      if (first < 0) first = i;
      last = i;
      index += 1;
    }
  }
  if (index < query.length) return 0;
  const span = last - first + 1;
  return Math.max(1, 12 - (span - query.length)) + Math.max(0, 4 - first);
}

/**
 * 给一个功能对查询串打分，分数越高越靠前，0 表示不匹配。
 *
 * 刻意把「名称精确/前缀」排在「关键词命中」之前：搜 "json" 时
 * 「JSON 工具」应该在「文本工具」（关键词里也有 json）前面。
 */
export function scoreFunction(item, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return 1;
  if (!item) return 0;

  const name = normalize(item.name);
  const id = normalize(item.id);
  const keywords = (item.keywords || []).map(normalize);

  if (name === query) return 1000;
  if (id === query) return 900;
  if (name.startsWith(query)) return 800 - name.length;
  if (keywords.includes(query)) return 700;
  if (name.includes(query)) return 600 - name.indexOf(query);
  if (id.includes(query)) return 500 - id.indexOf(query);

  const keywordHit = keywords.findIndex((keyword) => keyword.includes(query));
  if (keywordHit >= 0) return 400 - keywordHit * 5;

  const fuzzyName = subsequenceScore(name, query);
  if (fuzzyName) return 200 + fuzzyName;

  const fuzzyId = subsequenceScore(id, query);
  if (fuzzyId) return 100 + fuzzyId;

  return 0;
}

/** 按相关度返回匹配的功能；空查询返回全部（保持原顺序）。 */
export function searchFunctions(rawQuery, list = FUNCTIONS) {
  const query = normalize(rawQuery);
  if (!query) return list.slice();

  return list
    .map((item) => ({ item, score: scoreFunction(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name), 'zh-CN'))
    .map((entry) => entry.item);
}

/**
 * 把收藏列表解析成侧边栏顶部的常用区（按收藏顺序，去重、跳过已删除的功能）。
 *
 * 注：曾经还有一个「最近使用」区。它和收藏区一起把「全部功能」挤到了侧边栏下方，
 * 而侧边栏搜索已经能解决「找不到」的问题，所以去掉了。
 */
export function buildFavorites(ids, list = FUNCTIONS) {
  const seen = new Set();
  const result = [];
  for (const id of ids || []) {
    if (seen.has(id)) continue;
    const item = findFunction(id, list);
    if (!item) continue;
    seen.add(id);
    result.push(item);
    if (result.length >= FAVORITE_LIMIT) break;
  }
  return result;
}
