import React, { useCallback, useEffect, useState } from 'react';
import { cleanIpcError } from '../lib/errorText';
import {
  PLATFORM_LABELS,
  mergeDevices,
  describeDevice,
  quickActionsFor,
  pickQuickAction
} from '../lib/deviceHub';

/**
 * 设备墙 —— 工作台的首页。
 *
 * 一次扫描两个平台（Android + iOS），把设备列成卡片墙；
 * 每张卡上是这台设备能直达的工具（投屏操控 / 日志 / 文件 / 应用 / 信息）。
 * 点卡片上的动作 = 直接带着这台设备进对应工具，跳过「再选一次设备」。
 *
 * 这就是整个「设备自动化工作台」的链路入口：
 * 连上设备 → 看到设备 → 点一下就进操控 → 录制 → 无人值守。
 */
function DeviceHub({ onOpenTool }) {
  const [devices, setDevices] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [errors, setErrors] = useState([]);
  const [scanned, setScanned] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setErrors([]);
    // 双平台并行扫；一边失败不拖垮另一边（比如 Windows 上没有 idevice 工具）
    const results = await Promise.allSettled([
      window.electronAPI.getLogDevices('android'),
      window.electronAPI.getLogDevices('ios')
    ]);
    const nextErrors = [];
    const [androidPart, iosPart] = results.map((result) => {
      if (result.status === 'fulfilled') {
        const raw = result.value;
        const list = Array.isArray(raw) ? raw : raw?.devices;
        return Array.isArray(list) ? list : [];
      }
      nextErrors.push(cleanIpcError(result.reason, '设备扫描失败'));
      return [];
    });
    setErrors(nextErrors);
    setDevices(mergeDevices(androidPart, iosPart));
    setScanned(true);
    setScanning(false);
  }, []);

  useEffect(() => { scan(); }, [scan]);

  const openTool = (device, target) => {
    onOpenTool?.({ device, target });
  };

  const grouped = devices.reduce((acc, device) => {
    (acc[device.platform] = acc[device.platform] || []).push(device);
    return acc;
  }, {});

  return (
    <div className="device-hub">
      <div className="device-hub-head">
        <div>
          <h2 className="device-hub-title">设备工作台</h2>
          <p className="device-hub-sub">
            连上手机（Android 开 USB 调试 / iPhone 解锁并信任），扫描后点设备卡片直达操控、日志、文件、应用管理
          </p>
        </div>
        <button className="btn btn-primary device-hub-refresh" onClick={scan} disabled={scanning}>
          {scanning ? '扫描中…' : '重新扫描'}
        </button>
      </div>

      {errors.length > 0 && (
        <div className="device-hub-errors">
          {errors.map((text, index) => (
            <div key={index} className="device-hub-error-item">⚠️ {text}</div>
          ))}
        </div>
      )}

      {scanning && devices.length === 0 && (
        <div className="device-hub-empty">
          <div className="device-hub-empty-icon">📡</div>
          <p>正在扫描已连接的设备…</p>
        </div>
      )}

      {!scanning && scanned && devices.length === 0 && (
        <div className="device-hub-empty">
          <div className="device-hub-empty-icon">🔌</div>
          <p>没有发现设备</p>
          <p className="device-hub-empty-hint">
            Android：连接 USB 并开启「USB 调试」；iPhone：解锁后连接并在手机上点「信任此电脑」。
          </p>
          <p className="device-hub-empty-hint">也可以检查 <a className="device-hub-link" onClick={() => openTool(null, 'device')}>本机环境</a> 看 ADB / libimobiledevice 是否就绪。</p>
        </div>
      )}

      {Object.entries(grouped).map(([platform, list]) => (
        <div key={platform} className="device-hub-group">
          <div className="device-hub-group-title">
            {PLATFORM_LABELS[platform] || platform}
            <span className="device-hub-group-count">{list.length}</span>
          </div>
          <div className="device-hub-cards">
            {list.map((device) => {
              const actions = quickActionsFor(device);
              const primary = pickQuickAction(device);
              return (
                <div key={`${platform}-${device.id}`} className="device-card">
                  <div className="device-card-head">
                    <span className={`device-card-badge device-card-badge--${platform}`}>
                      {platform === 'ios' ? '🍎' : '🤖'}
                    </span>
                    <div className="device-card-name" title={device.id}>{device.name}</div>
                    <button
                      className="device-card-open"
                      onClick={() => openTool(device, primary?.target)}
                      title={primary ? `${primary.label}（默认）` : ''}
                    >
                      {primary?.icon} 进入
                    </button>
                  </div>
                  <div className="device-card-sub">{describeDevice(device)}</div>
                  <div className="device-card-actions">
                    {actions.map((action) => (
                      <button
                        key={action.key}
                        className="device-card-action"
                        onClick={() => openTool(device, action.target)}
                        title={`用${action.label}打开这台设备`}
                      >
                        <span>{action.icon}</span>
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default DeviceHub;
