import React, { useState } from 'react';
import ApkInfo from './ApkInfo';
import BatchScan from './BatchScan';

/**
 * 包体信息统一入口。
 *
 * 「读取应用信息」与「批量扫描包体」底层是同一个纯 JS 解析器
 * （electron/pkginfo/ + get-package-static-info / batch-scan-packages），
 * 只是入口一个是单文件、一个是整个目录，所以合并成一页两个模式，避免侧边栏出现两个雷同入口。
 *
 * 两个子视图**同时挂载**、只用 CSS 切换显示：
 * 切走再切回来不会丢掉已经扫出来的结果（批量扫 500 个包要跑一会儿，不能白扫）。
 */
const MODES = [
  {
    id: 'single',
    label: '单个包体',
    hint: '选一个 APK / AAB / IPA，看完整静态信息，并可与另一个版本对比'
  },
  {
    id: 'batch',
    label: '批量扫描',
    hint: '选一个目录，逐个体检并汇总成可排序、可筛选、可导出的表格'
  }
];

function PackageInfo({
  initialMode = 'single',
  initialRows = null,
  initialDirectory = '',
  initialResult = null
}) {
  const [mode, setMode] = useState(initialMode);
  const active = MODES.find((item) => item.id === mode) || MODES[0];

  return (
    <div className="content-card">
      <h2>读取应用信息</h2>
      <p className="pi-hint">
        解析 APK / AAB / IPA 的包体结构，全部由内置纯 JavaScript 完成，不依赖 aapt、keytool 或 plutil。
      </p>

      <div className="sign-platform-tabs">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`text-tab ${mode === item.id ? 'is-active' : ''}`}
            onClick={() => setMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className="pi-hint package-info-hint">{active.hint}</p>

      <div className={`package-info-view ${mode === 'single' ? 'is-active' : 'is-hidden'}`}>
        <ApkInfo embedded />
      </div>
      <div className={`package-info-view ${mode === 'batch' ? 'is-active' : 'is-hidden'}`}>
        <BatchScan
          embedded
          initialRows={initialRows}
          initialDirectory={initialDirectory}
          initialResult={initialResult}
        />
      </div>
    </div>
  );
}

export default PackageInfo;
