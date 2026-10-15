'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = '/Users/violet/Documents/other_dev/project_dev';
const html = fs.readFileSync(path.join(ROOT, 'preview', 'apk-info-preview.html'), 'utf8');

// 预览外壳会给每个面板补上 data-page-node-id，所以不能用精确字符串匹配
const panel = (id) => {
  const re = new RegExp(`<div class="pv-panel[^"]*" id="${id}"[^>]*>`);
  const match = re.exec(html);
  if (!match) return '';
  const start = match.index + match[0].length;
  const next = html.indexOf('<div class="pv-panel', start);
  return html.slice(start, next < 0 ? html.length : next);
};

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const single = panel('install-single');
const batch = panel('install-batch');
const running = panel('install-running');
const done = panel('install-done');

const countRows = (html) => (html.match(/class="ia-row[" ]/g) || []).length;
const countTabs = (html) => (html.match(/class="ia-mode-tab[" ]/g) || []).length;

check('4 个安装视图都已渲染', Boolean(single && batch && running && done));
check('模式切换标签（2 个）', countTabs(single) === 2, `实际 ${countTabs(single)}`);
check('单个安装：文件路径已预填', single.includes('示例应用') || /\.apk/.test(single));
check('单个安装：设备下拉已预填', single.includes('Pixel 7'));
check('单个安装：安装按钮文案', single.includes('安装到 Android 设备'));

check('批量（就绪）：列表 5 行', countRows(batch) === 5, `实际 ${countRows(batch)}`);
check('批量（就绪）：待安装状态', batch.includes('ia-status--idle'));
check('批量（就绪）：类型不符行高亮', batch.includes('is-mismatched'));
check('批量（就绪）：类型不符提示文案', batch.includes('与目标设备（Android）不符，将被跳过'));
check('批量（就绪）：不支持类型提示', batch.includes('不支持的文件类型'));
check('批量（就绪）：清理按钮', batch.includes('仅保留可安装的'));
check('批量（就绪）：按钮带可安装数量', /批量安装（\d+ 个）/.test(batch));
check('批量（就绪）：iOS 徽章', batch.includes('ia-badge--ios'));
check('批量（就绪）：未知类型徽章', batch.includes('ia-badge--unknown'));

check('批量（进行中）：进度条已渲染', running.includes('ui-progress'));
check('批量（进行中）：整批百分比 46%', /width: ?46%/.test(running), (running.match(/width: ?\d+%/) || []).slice(0, 3).join(' '));
check('批量（进行中）：阶段文案', running.includes('批量安装 2/5'));
check('批量（进行中）：取消按钮', running.includes('>取消<'));
check('批量（进行中）：行内进度条 45%', /ia-row__bar-fill[^>]*width: ?45%/.test(running));
check('批量（进行中）：已装完的行变绿', running.includes('ia-row--ok'));
check('批量（进行中）：正在装的行高亮', running.includes('ia-row--running'));
check('批量（进行中）：状态文案「已安装」', running.includes('已安装'));
check('批量（进行中）：状态文案「安装中 45%」', running.includes('安装中 45%'));

check('批量（完成）：进度条 100%', /width: ?100%/.test(done));
check('批量（完成）：汇总条', done.includes('ia-summary'));
check('批量（完成）：成功数', done.includes('成功 2'));
check('批量（完成）：失败数', done.includes('失败 1'));
check('批量（完成）：跳过数', done.includes('跳过 2'));
check('批量（完成）：失败明细', done.includes('INSTALL_FAILED_OLDER_SDK'));
check('批量（完成）：失败行标红', done.includes('ia-row--danger'));
check('批量（完成）：跳过行标黄', done.includes('ia-row--warn'));

// ---------- 签名状态：v1 失效时的展示 ----------
// 背景：v1 曾经只按「META-INF/*.RSA 在不在」判断，加固/重打包留下的失效签名
// 会被当成有效 v1。现在失效的 v1 不进签名方案，且必须讲清楚是「失效」而不是「未签名」。
const sigTile = (html) => {
  const re = /pi-tile (pi-tile--\w+)[^>]*>(?:(?!pi-tile ).)*?pi-tile-label"[^>]*>签名<\/span>(?:(?!pi-tile ).)*?pi-tile-value"[^>]*>([^<]*)<(?:(?!pi-tile ).)*?pi-tile-sub"[^>]*>([^<]*)</s;
  const m = re.exec(html);
  return m ? { tone: m[1].replace('pi-tile--', ''), value: m[2], sub: m[3] } : null;
};

const sigNormal = sigTile(panel('apk-sig-0'));
const sigStaleOnly = sigTile(panel('apk-sig-1'));
const sigStaleWithV2 = sigTile(panel('apk-sig-2'));

check('签名状态：正常包列出签名方案', Boolean(sigNormal) && sigNormal.value === 'v1 + v2', sigNormal && sigNormal.value);
check('签名状态：正常包配色为 ok', Boolean(sigNormal) && sigNormal.tone === 'ok', sigNormal && sigNormal.tone);

check('签名状态：v1 失效且无其他方案 → 说「签名无效」而非「未签名」',
  Boolean(sigStaleOnly) && /签名无效/.test(sigStaleOnly.value), sigStaleOnly && sigStaleOnly.value);
check('签名状态：v1 失效且无其他方案 → 红色告警',
  Boolean(sigStaleOnly) && sigStaleOnly.tone === 'danger', sigStaleOnly && sigStaleOnly.tone);
check('签名状态：v1 失效 → 给出失效原因',
  Boolean(sigStaleOnly) && /重打包|加固/.test(sigStaleOnly.sub), sigStaleOnly && sigStaleOnly.sub);

check('签名状态：v1 失效但 v2 有效 → 只列有效方案',
  Boolean(sigStaleWithV2) && sigStaleWithV2.value === 'v2', sigStaleWithV2 && sigStaleWithV2.value);
check('签名状态：v1 失效但 v2 有效 → 黄色提醒',
  Boolean(sigStaleWithV2) && sigStaleWithV2.tone === 'warn', sigStaleWithV2 && sigStaleWithV2.tone);

// 全局：条件类名拼接不应产生双空格
const doubleSpace = html.match(/class="[^"]*  [^"]*"/g) || [];
check('全局无「双空格」类名', doubleSpace.length === 0, doubleSpace.slice(0, 3).join(' | '));

// 全局：InstallApk 用到的类都必须在 CSS 里有定义
const css = fs.readFileSync(path.join(ROOT, 'src', 'App.css'), 'utf8');
const used = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  for (const cls of m[1].split(/\s+/)) if (cls.startsWith('ia-') || cls === 'install-lead') used.add(cls);
}
const missing = [...used].filter((cls) => !new RegExp(`\\.${cls.replace(/[-]/g, '\\-')}[\\s,{:]`).test(css));
check('安装视图用到的类都有样式', missing.length === 0, missing.join(', '));

// 计数
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `  → ${c.detail}`}`);
console.log(`\n${pass}/${checks.length} 项通过`);
process.exit(pass === checks.length ? 0 : 1);
