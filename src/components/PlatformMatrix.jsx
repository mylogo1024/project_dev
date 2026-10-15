import React, { useEffect, useState } from 'react';
import { cleanIpcError } from '../lib/errorText';

const PLATFORM_CHIPS = [
  { id: 'darwin', label: 'macOS' },
  { id: 'win32', label: 'Windows' },
  { id: 'linux', label: 'Linux' }
];

const STATUS_MARK = {
  ready: '✓',
  'missing-tool': '!',
  unavailable: '—'
};

/** 拼接 class，自动丢掉空值，避免出现多余空格。 */
const cx = (...parts) => parts.filter(Boolean).join(' ');

/**
 * 平台能力矩阵。
 *
 * 逐个功能说明「在 macOS / Windows / Linux 上能不能跑、缺什么、怎么装」，
 * 直接回答「各个 mac、linux、window 是否可以运行」这个问题。
 *
 * @param {boolean} compact     隐藏右侧平台标签（用于窄容器）
 * @param {object} initialData  预置数据（静态预览用，传了就不发 IPC）
 */
function PlatformMatrix({ compact = false, initialData = null }) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState('');

  const load = async (probe = true) => {
    setLoading(true);
    setError('');
    try {
      const api = window.electronAPI;
      if (!api?.getPlatformCapabilities) {
        setError('当前版本不支持平台能力检测');
        return;
      }
      const result = await api.getPlatformCapabilities({ probe });
      setData(result);
    } catch (err) {
      setError(cleanIpcError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialData) return;
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !data) {
    return <div className="env-check"><div className="env-loading">正在检测平台能力…</div></div>;
  }

  if (error && !data) {
    return (
      <div className="env-check">
        <div className="env-error">
          <strong>平台能力检测失败</strong>
          <div>{error}</div>
          <button className="btn btn-secondary env-retry" onClick={() => load(true)}>重新检测</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const current = data.platform;
  const groups = [];
  for (const feature of data.features || []) {
    let group = groups.find((item) => item.name === feature.group);
    if (!group) {
      group = { name: feature.group, items: [] };
      groups.push(group);
    }
    group.items.push(feature);
  }

  const readyCount = data.summary?.ready || 0;
  const totalCount = data.summary?.total || 0;

  return (
    <div className="env-check pf-wrap">
      <div className="pf-head">
        <span className="pf-badge">当前系统 · {data.platform_label}</span>
        <span className="pf-meta">
          {data.arch}
          {data.versions?.electron ? ` · Electron ${data.versions.electron}` : ''}
          {data.cpus ? ` · ${data.cpus} 核` : ''}
          {data.memory_gb ? ` · ${data.memory_gb} GB 内存` : ''}
        </span>
        <button className="btn btn-secondary" onClick={() => load(true)} disabled={loading} style={{ marginLeft: 'auto' }}>
          {loading ? '检测中…' : '重新检测'}
        </button>
      </div>

      <div className="pf-summary">
        <div className="pi-stat">
          <span className="pi-stat__value">{readyCount}</span>
          <span className="pi-stat__label">可用功能</span>
        </div>
        <div className={`pi-stat ${totalCount - readyCount > 0 ? 'pi-stat--warn' : ''}`}>
          <span className="pi-stat__value">{totalCount - readyCount}</span>
          <span className="pi-stat__label">待补依赖</span>
        </div>
        <div className="pi-stat">
          <span className="pi-stat__value">{totalCount}</span>
          <span className="pi-stat__label">功能总数</span>
        </div>
      </div>

      {groups.map((group) => (
        <div className="pf-group" key={group.name}>
          <div className="pf-group__title">{group.name}</div>
          {group.items.map((feature) => (
            <div key={feature.id} className={cx('pf-item', `pf-item--${feature.status}`)}>
              <span className="pf-item__mark" aria-hidden="true">{STATUS_MARK[feature.status] || '?'}</span>
              <div className="pf-item__body">
                <div className="pf-item__name">{feature.name}</div>
                {feature.reason ? <div className="pf-item__reason">{feature.reason}</div> : null}
                {feature.tools?.length ? (
                  <div className="pf-item__tools">
                    {feature.tools.map((tool) => (
                      <span
                        key={tool.name}
                        className={cx('pf-tool', tool.installed ? 'pf-tool--ok' : 'pf-tool--missing')}
                        title={tool.path || tool.hint || ''}
                      >
                        {tool.installed ? '✓' : '✕'} {tool.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {!compact ? (
                <div className="pf-item__platforms">
                  {PLATFORM_CHIPS.map((chip) => {
                    const supported = feature.platforms?.includes(chip.id);
                    const isCurrent = chip.id === current;
                    return (
                      <span
                        key={chip.id}
                        className={cx('pf-chip', supported && 'is-supported', isCurrent && 'is-current')}
                        title={supported ? `${chip.label} 支持` : `${chip.label} 不支持`}
                      >
                        {chip.label}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}

      <div className="env-guide">
        <div className="env-guide-title">跨平台说明</div>
        <p>
          「读取应用信息」（含单个包体与批量扫描两种模式）是纯 JavaScript 实现，<strong>macOS / Windows / Linux 全部可用</strong>，
          不需要 aapt、keytool、plutil 等任何外部工具。
        </p>
        <p>
          依赖系统能力的功能会有平台限制：<strong>IPA 重签名</strong>与 <strong>iOS 实时投屏</strong>仅在 macOS 可用，
          因为它们依赖 codesign / AVFoundation。设备类功能（安装、文件、日志、投屏）三平台都能跑，
          但需要自行安装 adb / libimobiledevice 等工具。
        </p>
      </div>
    </div>
  );
}

export default PlatformMatrix;
