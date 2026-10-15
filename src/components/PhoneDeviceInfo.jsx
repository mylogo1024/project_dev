import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copyTextWithToast } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

const normalizeDevice = (device) => {
  if (typeof device === 'string') return { id: device, label: device };
  const id = device?.id || device?.deviceId || device?.udid || '';
  return {
    ...device,
    id,
    label: device?.label || device?.name || device?.displayName || id
  };
};

const formatBytes = (bytes) => {
  if (bytes == null || bytes === '') return '';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const formatUptime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
};

// 统一走 lib/clipboard：空内容给警告、失败给错误，不再静默
const copyText = (text) => copyTextWithToast(text);

function InfoItem({ label, value, copyable = false }) {
  if (value == null || value === '') return null;
  const text = value === true ? '是' : value === false ? '否' : String(value);
  return (
    <div className="info-item">
      <strong>{label}</strong>
      <span>
        {text}
        {copyable && (
          <button
            className="btn btn-secondary"
            onClick={() => copyText(text)}
            style={{ marginLeft: 10, padding: '2px 8px', fontSize: 12 }}
          >
            复制
          </button>
        )}
      </span>
    </div>
  );
}

function buildExportText(info) {
  if (!info) return '';
  const lines = [`# ${info.platform === 'ios' ? 'iOS' : 'Android'} 设备信息`, ''];
  const walk = (title, object) => {
    lines.push(`## ${title}`);
    Object.entries(object || {}).forEach(([key, value]) => {
      if (value == null || value === '') return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          lines.push(`- ${key}[${index}]: ${typeof item === 'object' ? JSON.stringify(item) : item}`);
        });
        return;
      }
      if (typeof value === 'object') {
        lines.push(`- ${key}: ${JSON.stringify(value)}`);
        return;
      }
      lines.push(`- ${key}: ${value}`);
    });
    lines.push('');
  };
  walk('标识', info.identity);
  walk('系统', info.system);
  if (info.hardware) walk('CPU / GPU / 内存', info.hardware);
  if (info.display) walk('屏幕', info.display);
  if (info.battery) walk('电池', info.battery);
  if (info.memory) walk('内存', info.memory);
  if (info.disks) walk('存储', { disks: info.disks });
  if (info.storage) walk('存储', info.storage);
  if (info.network) walk('网络', info.network);
  if (info.radio) walk('基带', info.radio);
  if (info.uptime != null) lines.push(`## 运行时间\n- ${formatUptime(info.uptime)}`, '');
  lines.push(`生成时间: ${new Date().toLocaleString()}`);
  return lines.join('\n');
}

function PhoneDeviceInfo({ initialDevice = null }) {
  const [platform, setPlatform] = useState(initialDevice?.platform === 'ios' ? 'ios' : 'android');
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice?.id || '');
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState(null);
  const [message, setMessage] = useState('');
  const [actions, setActions] = useState([]);
  const [busyAction, setBusyAction] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const requestRef = useRef(0);
  const infoRequestRef = useRef(0);

  const loadDevices = async (targetPlatform = platform) => {
    const requestId = ++requestRef.current;
    setDeviceLoading(true);
    setMessage('');
    try {
      const result = await window.electronAPI.getLogDevices(targetPlatform);
      if (requestId !== requestRef.current) return;
      const nextDevices = (Array.isArray(result) ? result : result?.devices || [])
        .map(normalizeDevice)
        .filter((device) => device.id);
      setDevices(nextDevices);
      setSelectedDevice((current) => (
        nextDevices.some((device) => device.id === current) ? current : (nextDevices[0]?.id || '')
      ));
      if (nextDevices.length === 0) {
        setInfo(null);
        setMessage({
          type: 'warning',
          text: targetPlatform === 'ios'
            ? '未检测到 iOS 设备。请解锁、连接 USB，并完成“信任此电脑”。'
            : '未检测到 Android 设备。请连接设备并开启 USB 调试。'
        });
      }
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setDevices([]);
      setSelectedDevice('');
      setInfo(null);
      setMessage({ type: 'error', text: cleanIpcError(error, '获取设备失败') });
    } finally {
      if (requestId === requestRef.current) setDeviceLoading(false);
    }
  };

  const loadInfo = async (deviceId = selectedDevice, targetPlatform = platform) => {
    if (!deviceId) {
      setInfo(null);
      return;
    }
    const requestId = ++infoRequestRef.current;
    setLoading(true);
    setMessage('');
    try {
      const result = await window.electronAPI.getPhoneDeviceInfo({
        platform: targetPlatform,
        deviceId
      });
      if (requestId !== infoRequestRef.current) return;
      setInfo(result);
    } catch (error) {
      if (requestId !== infoRequestRef.current) return;
      setInfo(null);
      setMessage({ type: 'error', text: cleanIpcError(error, '读取设备信息失败') });
    } finally {
      if (requestId === infoRequestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadDevices(platform);
  }, [platform]);

  const loadActions = async (deviceId = selectedDevice, targetPlatform = platform) => {
    if (!deviceId || !window.electronAPI.listPhoneDeviceActions) {
      setActions([]);
      return;
    }
    try {
      const list = await window.electronAPI.listPhoneDeviceActions({
        platform: targetPlatform,
        deviceId
      });
      setActions(Array.isArray(list) ? list : []);
    } catch (_) {
      setActions([]);
    }
  };

  useEffect(() => {
    if (selectedDevice) loadInfo(selectedDevice, platform);
    else setInfo(null);
  }, [selectedDevice, platform]);

  useEffect(() => {
    setPendingAction('');
    if (selectedDevice) loadActions(selectedDevice, platform);
    else setActions([]);
  }, [selectedDevice, platform]);

  const switchPlatform = (next) => {
    if (next === platform) return;
    setPlatform(next);
    setSelectedDevice('');
    setDevices([]);
    setInfo(null);
    setMessage('');
  };

  const runAction = async (item) => {
    if (!selectedDevice || busyAction) return;
    if (item.danger && pendingAction !== item.id) {
      setPendingAction(item.id);
      setMessage({ type: 'warning', text: `再点一次确认「${item.label}」` });
      return;
    }
    setPendingAction('');
    setBusyAction(item.id);
    setMessage('');
    try {
      const result = await window.electronAPI.runPhoneDeviceAction({
        platform,
        deviceId: selectedDevice,
        action: item.id
      });
      if (result?.cancelled) {
        setMessage({ type: 'warning', text: '已取消保存' });
      } else {
        setMessage({ type: 'success', text: result?.message || `已执行：${item.label}` });
      }
      await loadActions();
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, `${item.label}失败`) });
      await loadActions();
    } finally {
      setBusyAction('');
    }
  };

  const exportInfo = async () => {
    if (!info) return;
    try {
      await window.electronAPI.exportDeviceInfo(buildExportText(info));
      setMessage({ type: 'success', text: '设备信息已导出' });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '导出失败') });
    }
  };

  const title = useMemo(() => {
    if (!info) return platform === 'ios' ? 'iOS 设备' : 'Android 设备';
    if (info.platform === 'ios') {
      return info.identity.marketingName || info.identity.name || 'iOS 设备';
    }
      return [info.identity.brand, info.identity.marketName || info.identity.model].filter(Boolean).join(' ') || 'Android 设备';
  }, [info, platform]);

  return (
    <div className="content-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>连接设备信息</h2>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={() => loadInfo()} disabled={!selectedDevice || loading}>
            刷新
          </button>
          <button className="btn btn-primary" onClick={exportInfo} disabled={!info}>
            导出报告
          </button>
        </div>
      </div>
      <p className="install-lead">读取当前 USB 连接的 Android 或 iOS 真机信息，并调用系统自带的按键 / 截图 / 诊断接口做快捷操作。数据只留在本机。</p>

      <div className="sign-platform-tabs">
        <button
          className={`text-tab ${platform === 'android' ? 'is-active' : ''}`}
          onClick={() => switchPlatform('android')}
        >
          Android
        </button>
        <button
          className={`text-tab ${platform === 'ios' ? 'is-active' : ''}`}
          onClick={() => switchPlatform('ios')}
        >
          iOS
        </button>
      </div>

      <div className="form-group">
        <label>选择设备</label>
        <div className="file-input-group">
          <select
            value={selectedDevice}
            onChange={(event) => setSelectedDevice(event.target.value)}
            disabled={deviceLoading || devices.length === 0}
          >
            {devices.length === 0 ? (
              <option value="">{deviceLoading ? '正在检测设备…' : '未检测到设备'}</option>
            ) : (
              devices.map((device) => (
                <option key={device.id} value={device.id}>{device.label}</option>
              ))
            )}
          </select>
          <button className="btn btn-secondary" onClick={() => loadDevices(platform)} disabled={deviceLoading}>
            {deviceLoading ? '检测中…' : '刷新设备'}
          </button>
        </div>
      </div>

      {selectedDevice && actions.length > 0 && (
        <div className="device-actions">
          <span className="device-actions__title">快捷操作</span>
          <div className="device-actions__row">
            {actions.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`device-actions__btn${item.danger ? ' is-danger' : ''}${pendingAction === item.id ? ' is-pending' : ''}`}
                disabled={Boolean(busyAction)}
                onClick={() => runAction(item)}
              >
                {busyAction === item.id
                  ? '执行中…'
                  : pendingAction === item.id
                    ? `确认${item.label}`
                    : item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {message && (
        <div className={`message ${message.type}`}>{message.text}</div>
      )}

      {loading && <div className="loading">正在读取设备信息…</div>}

      {!loading && info && (
        <div className="info-display">
          <div className="info-section">
            <h3>📱 {title}</h3>
            {info.platform === 'android' ? (
              <>
                <InfoItem label="设备型号" value={info.identity.marketName || info.hardware?.model || info.identity.model} />
                <InfoItem label="品牌" value={info.identity.brand} />
                <InfoItem label="厂商" value={info.identity.manufacturer} />
                <InfoItem label="系统型号" value={info.identity.model} />
                <InfoItem label="设备代号" value={info.identity.device} />
                <InfoItem label="序列号" value={info.identity.serial} copyable />
                <InfoItem label="Android ID" value={info.identity.androidId} copyable />
              </>
            ) : (
              <>
                <InfoItem label="设备型号" value={info.identity.marketingName || info.hardware?.model} />
                <InfoItem label="设备名称" value={info.identity.name} />
                <InfoItem label="产品型号" value={info.identity.productType} />
                <InfoItem label="设备类型" value={info.identity.deviceClass} />
                <InfoItem label="UDID" value={info.identity.udid} copyable />
                <InfoItem label="序列号" value={info.identity.serial} copyable />
                <InfoItem label="IMEI" value={info.identity.imei} copyable />
                <InfoItem label="Wi-Fi MAC" value={info.identity.wifiAddress} copyable />
                <InfoItem label="蓝牙 MAC" value={info.identity.bluetoothAddress} copyable />
              </>
            )}
          </div>

          <div className="info-section">
            <h3>🔧 CPU / GPU / 内存</h3>
            <InfoItem label="CPU" value={info.hardware?.cpu || info.system?.cpu} />
            <InfoItem label="核心" value={info.hardware?.coresLabel || (info.hardware?.cores ? `${info.hardware.cores} 核` : '')} />
            <InfoItem label="核心构成" value={info.platform === 'android' ? info.hardware?.cpuDetail : ''} />
            <InfoItem label="指令集" value={info.hardware?.architecture || info.hardware?.abi} />
            <InfoItem label="GPU" value={info.hardware?.gpu} />
            <InfoItem label="GPU 厂商" value={info.hardware?.gpuVendor} />
            <InfoItem label="图形 API" value={info.hardware?.gles} />
            <InfoItem
              label="内存大小"
              value={
                info.memory?.nominalGb
                  ? (info.memory.estimated
                    ? `${info.memory.nominalGb} GB（按型号标称）`
                    : `${info.memory.nominalGb} GB`)
                  : (info.memory?.total ? formatBytes(info.memory.total) : '')
              }
            />
            <InfoItem
              label="内存详情"
              value={
                info.memory?.total && !info.memory.estimated
                  ? `已用 ${formatBytes(info.memory.used)} / 共 ${formatBytes(info.memory.total)}（可用 ${formatBytes(info.memory.available)}）`
                  : ''
              }
            />
            {info.memory?.usagePercent != null && (
              <div style={{ marginTop: 10 }}>
                <div style={{ width: '100%', height: 20, background: '#ecf0f1', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.min(100, info.memory.usagePercent)}%`,
                    height: '100%',
                    background: info.memory.usagePercent > 80 ? '#e74c3c' : info.memory.usagePercent > 60 ? '#f39c12' : '#2ecc71'
                  }} />
                </div>
              </div>
            )}
            <InfoItem label="SoC" value={info.hardware?.soc} />
            <InfoItem label="ABI" value={info.hardware?.abiList && info.hardware.abiList !== info.hardware?.abi ? info.hardware.abiList : ''} />
            <InfoItem label="Board" value={info.hardware?.board} />
            <InfoItem label="分辨率" value={info.display?.size} />
            <InfoItem label="DPI" value={info.display?.density} />
          </div>

          <div className="info-section">
            <h3>💻 系统</h3>
            {info.platform === 'android' ? (
              <>
                <InfoItem label="Android 版本" value={info.system.release} />
                <InfoItem label="SDK" value={info.system.sdk} />
                <InfoItem label="安全补丁" value={info.system.securityPatch} />
                <InfoItem label="Build" value={info.system.buildId} />
                <InfoItem label="指纹" value={info.system.fingerprint} copyable />
                <InfoItem label="构建类型" value={info.system.type} />
                <InfoItem label="时区" value={info.system.timezone} />
                <InfoItem label="可调试" value={info.system.debuggable} />
                <InfoItem label="运行时间" value={formatUptime(info.uptime)} />
              </>
            ) : (
              <>
                <InfoItem label="iOS 版本" value={info.system.version} />
                <InfoItem label="Build" value={info.system.build} />
                <InfoItem label="硬件型号" value={info.system.hardwareModel} />
                <InfoItem label="激活状态" value={info.system.activationState} />
                <InfoItem label="密码锁定" value={info.system.passwordProtected} />
                <InfoItem label="颜色" value={info.system.deviceColor} />
                <InfoItem label="时区" value={info.system.timezone} />
              </>
            )}
          </div>

          {info.battery && (info.battery.level != null || info.battery.status) && (
            <div className="info-section">
              <h3>🔋 电池</h3>
              <InfoItem label="电量" value={info.battery.level != null ? `${info.battery.level}%` : ''} />
              <InfoItem label="状态" value={info.battery.status} />
              <InfoItem label="健康" value={info.battery.health} />
              <InfoItem label="充电" value={info.battery.charging} />
              <InfoItem
                label="温度"
                value={info.battery.temperatureC != null ? `${info.battery.temperatureC.toFixed(1)} °C` : ''}
              />
              <InfoItem
                label="电压"
                value={info.battery.voltageMv != null ? `${info.battery.voltageMv} mV` : ''}
              />
              <InfoItem label="外接电源" value={info.battery.externalConnected} />
            </div>
          )}

          {Array.isArray(info.disks) && info.disks.length > 0 && (
            <div className="info-section">
              <h3>🖴 存储</h3>
              {info.disks.map((disk) => (
                <div key={`${disk.mount}-${disk.filesystem}`} className="info-item">
                  <strong>{disk.mount}</strong>
                  <span>{disk.used} / {disk.size} · 剩余 {disk.available}（{disk.usePercent}）</span>
                </div>
              ))}
            </div>
          )}

          {info.storage && (info.storage.total || info.storage.dataAvailable) && (
            <div className="info-section">
              <h3>🖴 存储</h3>
              <InfoItem label="磁盘总量" value={formatBytes(info.storage.total)} />
              <InfoItem label="数据分区" value={formatBytes(info.storage.data)} />
              <InfoItem label="数据可用" value={formatBytes(info.storage.dataAvailable)} />
            </div>
          )}

          {info.network?.addresses?.length > 0 && (
            <div className="info-section">
              <h3>🌐 网络</h3>
              {info.network.addresses.map((item) => (
                <InfoItem
                  key={`${item.iface}-${item.address}`}
                  label={item.iface || 'IPv4'}
                  value={item.address}
                  copyable
                />
              ))}
            </div>
          )}

          {info.radio && (info.radio.baseband || info.radio.phoneNumber || info.radio.meid) && (
            <div className="info-section">
              <h3>📡 基带</h3>
              <InfoItem label="基带版本" value={info.radio.baseband} />
              <InfoItem label="号码" value={info.radio.phoneNumber} />
              <InfoItem label="MEID" value={info.radio.meid} copyable />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PhoneDeviceInfo;
