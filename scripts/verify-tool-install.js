/**
 * 端到端验证：真实下载 adb（Google 源）→ 解压 → 摊平 → runTool 能否找到。
 *
 * 不进 test/ 是因为它会真的联网下 12MB，CI 上不稳定；
 * 只在需要确认「整条链路真的通」时手动跑：
 *   DAILY_DEV_TOOLBOX_TOOLS_DIR=/tmp/xxx node scripts/verify-tool-install.js
 */
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'verify-tools-'));
process.env.DAILY_DEV_TOOLBOX_TOOLS_DIR = SANDBOX;

const installer = require('../electron/tool-installer');
const { createToolContext, createToolRunner } = require('../electron/tool-env');

(async () => {
  console.log('工具目录:', SANDBOX);

  const result = await installer.installTool('adb', {
    onProgress: (p) => {
      const bar = p.percent === null ? '?' : String(p.percent).padStart(3);
      console.log(`  [${bar}%] ${p.stage} — ${p.detail || ''}`);
    }
  });

  console.log('\n安装结果:', JSON.stringify(result, null, 2));

  const tool = installer.TOOL_DEFS.find((item) => item.id === 'adb');
  const dir = installer.installDirFor(tool);
  const marker = path.join(dir, installer.markerName(tool));

  console.log('binDirectories:', installer.binDirectories());
  console.log('落盘文件:', fs.readdirSync(dir).join(', '));

  assert(fs.existsSync(marker), `未找到 ${installer.markerName(tool)}`);
  assert(installer.binDirectories().includes(dir), '安装目录未注册进搜索路径');
  assert(fs.statSync(marker).size > 0, 'adb.exe 是空文件');

  // 在 mac 开发机上不做「能被 resolveTool 找到」的断言：
  // tool-env 的 executableCandidates 在非 Windows 上只找无扩展名的 `adb`（不会找 adb.exe），
  // 这是刻意的——mac 不该去执行 Windows 二进制。Windows 上靠 PATHEXT 补 .exe，能正常命中。
  // 所以这里只验证「下载物完整 + 目录已注册」，真机行为交给 Windows 验证。
  const { directories } = createToolRunner(createToolContext());
  assert(
    directories.includes(dir),
    `安装目录没有进入搜索列表：${dir}\n实际有：${directories.join(', ')}`
  );
  console.log('已注册进工具搜索目录 ✅');

  console.log('\n✅ 全链路通过：下载 → 解压 → 摊平外壳 → 注册进工具搜索目录');
  console.log('（Windows 上还需人工确认 adb --version 能跑起来）');
  console.log('清理:', SANDBOX);
})().catch(async (error) => {
  console.error('\n❌ 失败:', error.message);
  process.exitCode = 1;
});
