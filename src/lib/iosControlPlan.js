'use strict';

/**
 * iOS「能不能操作设备」的决策逻辑。
 *
 * 调研结论（见 COMPETITIVE_ANALYSIS.md）：三条技术路线各有硬性前置条件，
 * 失败原因差别很大 —— 有的是系统版本不够，有的是工具没装，有的是「装了但没跑起来」。
 *
 * 把这些判断集中成纯函数，界面只负责展示结论与引导；
 * 否则这些分支会散落到各个组件里，最后没人说得清「为什么这台设备不能点」。
 */

/** 可用的控制后端。`bundleable` 指许可证是否允许随闭源产品分发。 */
export const IOS_CONTROL_BACKENDS = {
  wda: {
    id: 'wda',
    name: 'WebDriverAgent',
    license: 'Apache-2.0',
    bundleable: true,
    minIosMajor: 12,
    summary: '走 HTTP 控制，兼容面最广，无需隧道'
  },
  'go-ios': {
    id: 'go-ios',
    name: 'go-ios（CoreDevice HID）',
    license: 'MIT',
    bundleable: true,
    minIosMajor: 27,
    summary: '原生触摸注入，延迟最低，但需要 iOS 27+ 且依赖隧道与开发者镜像'
  },
  pymobiledevice3: {
    id: 'pymobiledevice3',
    name: 'pymobiledevice3',
    license: 'GPL-3.0',
    bundleable: false,
    minIosMajor: 17,
    summary: '能力最全，但许可证不允许随产品分发，只能调用用户自行安装的版本'
  }
};

/** `17.4.1` / `17.4` / `17` → `{ major, minor, patch }`；解析不出来返回 null。 */
export function parseIosVersion(input) {
  const text = String(input ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0)
  };
}

/** 版本号比较：a 是否 >= b（b 用 major 数字表示）。 */
export function isAtLeastIos(version, major) {
  const parsed = typeof version === 'string' ? parseIosVersion(version) : version;
  if (!parsed) return false;
  return parsed.major >= Number(major);
}

/**
 * 汇总「能操作」的结论。
 *
 * @param {object} input
 * @param {string} input.iosVersion      设备系统版本，如 '18.2'
 * @param {string} [input.platform]      process.platform
 * @param {object} [input.tools]         { 'go-ios': bool, pymobiledevice3: bool, tidevice: bool, wda: bool }
 * @param {object} [input.state]         { tunnelUp, ddiMounted, streamRunning, wdaRunning }
 */
export function resolveIosControlPlan(input = {}) {
  const version = parseIosVersion(input.iosVersion);
  const platform = input.platform || 'darwin';
  const tools = input.tools || {};
  const state = input.state || {};

  const blockers = [];
  const alternatives = [];

  if (!version) {
    // 区分「没连设备」和「连上了但读不到版本」——
    // 两者的处置完全不同，用同一句提示会把用户引到错误的方向。
    return {
      canControl: false,
      backend: null,
      versionKnown: false,
      blockers: [input.deviceConnected
        ? {
          code: 'version-unreadable',
          message: '已连接设备，但读不到系统版本',
          action: '系统版本来自 ideviceinfo 的 ProductVersion。请确认已安装 libimobiledevice '
            + '并在这台电脑上「信任」过该设备；装好后完全退出本应用再打开重试'
        }
        : {
          code: 'no-device',
          message: '还没选择设备',
          action: '先在上方选择一台 iPhone，再回来判断该走哪条控制路线'
        }],
      alternatives: [],
      summary: input.deviceConnected ? '读不到设备系统版本' : '未选择设备'
    };
  }

  // ---------- 路线 1：go-ios（iOS 27+，体验最好） ----------
  const goIosReady = tools['go-ios'] && isAtLeastIos(version, 27)
    && state.tunnelUp && state.ddiMounted && state.streamRunning;
  if (goIosReady) {
    return {
      canControl: true,
      backend: 'go-ios',
      versionKnown: true,
      blockers: [],
      alternatives,
      summary: `走 go-ios 原生 HID 控制（iOS ${input.iosVersion}）`
    };
  }

  // ---------- 路线 2：WebDriverAgent（兼容面最广） ----------
  if (state.wdaRunning) {
    return {
      canControl: true,
      backend: 'wda',
      versionKnown: true,
      blockers: [],
      alternatives,
      summary: `走 WebDriverAgent 控制（iOS ${input.iosVersion}）`
    };
  }

  // ---------- 路线 3：pymobiledevice3（仅调用用户自装的） ----------
  if (tools.pymobiledevice3 && isAtLeastIos(version, 17)) {
    return {
      canControl: true,
      backend: 'pymobiledevice3',
      versionKnown: true,
      blockers: [],
      alternatives,
      summary: `走 pymobiledevice3 控制（iOS ${input.iosVersion}）`
    };
  }

  // ---------- 都不通：给出「最可能走通的那条」缺什么 ----------
  if (isAtLeastIos(version, 27)) {
    // 新系统优先引导 go-ios
    if (!tools['go-ios']) {
      blockers.push({
        code: 'go-ios-missing',
        message: '未检测到 go-ios',
        action: '安装 go-ios 后可获得原生触摸注入（MIT 许可，可随产品分发）'
      });
    } else {
      if (!state.tunnelUp) {
        blockers.push({
          code: 'tunnel-down',
          message: '内核隧道未建立',
          action: 'iOS 17+ 的开发者服务必须走隧道；Windows / Linux 上这一步最容易失败'
        });
      }
      if (!state.ddiMounted) {
        blockers.push({
          code: 'ddi-not-mounted',
          message: '开发者磁盘镜像（DDI）未挂载',
          action: '触摸注入依赖 DDI 里的 dtuhidd；注意镜像「显示挂载成功」不等于真的挂上了'
        });
      }
      if (!state.streamRunning) {
        blockers.push({
          code: 'stream-not-running',
          message: '屏幕媒体流未运行',
          action: '触摸事件需要媒体流做认证，否则设备会「返回成功但丢弃事件」—— 表现为点了没反应'
        });
      }
    }
    alternatives.push({
      backend: 'wda',
      message: '也可以启动 WebDriverAgent 直接控制，不依赖隧道与 DDI'
    });
  } else {
    // 老系统：go-ios 的 HID 不可用，只能走 WDA
    blockers.push({
      code: 'ios-too-old-for-go-ios',
      message: `iOS ${input.iosVersion} 不支持 CoreDevice HID（需要 iOS 27+）`,
      action: '改用 WebDriverAgent 控制，它从 iOS 12 起就可用'
    });
    if (!state.wdaRunning) {
      // 「能由应用一键启动」和「必须先去装一次」是完全不同的两件事 ——
      // 前者给按钮就有用，后者给按钮只会让人反复点。所以文案必须分开。
      blockers.push(tools.tidevice
        ? {
          code: 'wda-not-running',
          message: 'WebDriverAgent 未运行（已装在这台设备上）',
          action: '点「启动 WebDriverAgent」即可 —— 应用会用 tidevice 把它拉起来，不需要 Xcode'
        }
        : {
          code: 'wda-not-running',
          message: 'WebDriverAgent 未运行，且本机没有 tidevice',
          action: '先装 tidevice（pipx install tidevice）就能由应用一键启动；'
            + '或者用 Xcode 手动把 WDA 跑起来'
        });
    }
    if (!tools.pymobiledevice3) {
      alternatives.push({
        backend: 'pymobiledevice3',
        message: '若已安装 pymobiledevice3（iOS 17+），也可作为控制后端'
      });
    }
  }

  if (platform !== 'darwin') {
    blockers.push({
      code: 'non-macos-note',
      message: `${platform === 'win32' ? 'Windows' : 'Linux'} 上 iOS 控制链路更容易断`,
      action: '隧道与设备发现依赖 libimobiledevice / usbmuxd，建议先跑一次环境自检'
    });
  }

  return {
    canControl: false,
    backend: null,
    versionKnown: true,
    blockers,
    alternatives,
    summary: `iOS ${input.iosVersion} 暂时无法操作设备`
  };
}

/**
 * 画面来源决策。与「操作」分开 —— 能看和能点是两件事，
 * 很多场景只需要看（比如截图留证）。
 */
export function resolveIosStreamPlan(input = {}) {
  const version = parseIosVersion(input.iosVersion);
  const platform = input.platform || 'darwin';
  const tools = input.tools || {};
  const state = input.state || {};

  if (tools['go-ios'] && version && version.major >= 27 && state.tunnelUp && state.ddiMounted) {
    return { method: 'go-ios-dvt', live: true, summary: 'go-ios 媒体流（延迟最低）' };
  }
  if (tools.pymobiledevice3 && version && version.major >= 17) {
    return { method: 'pymobiledevice3-dvt', live: true, summary: 'pymobiledevice3 DVT 投屏' };
  }
  if (platform === 'darwin') {
    return {
      method: 'avfoundation',
      live: true,
      summary: 'macOS 系统投屏接口（需先在系统里打开设备投屏）'
    };
  }
  return {
    method: 'screenshot-poll',
    live: false,
    summary: '截图轮询（非实时画面，仅用于留证）'
  };
}
