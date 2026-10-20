// electron-builder afterPack 钩子：对 macOS 产物做 ad-hoc 签名。
//
// 背景：mac 配置里 identity 为 null 表示跳过 Developer ID 签名。未签名的 .app
// 从 GitHub 下载后会被系统打上 com.apple.quarantine 隔离标记，Gatekeeper 无法
// 校验签名，直接报「已损坏，应移到废纸篓」。
//
// ad-hoc 签名（codesign -s -）不是 Developer ID，无法做到下载即开箱可用，但能让
// 签名变为有效，系统提示从「已损坏」降级为「无法验证开发者」，用户可在
// 「系统设置 → 隐私与安全性 → 仍要打开」一键放行。
//
// 该钩子在打包后、生成 dmg/zip 之前执行，因此产物内是已签名版本。
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[after-pack] ad-hoc 签名完成: ${appPath}`);
};
