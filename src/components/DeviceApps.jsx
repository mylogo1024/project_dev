import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copyTextWithToast } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

const PRIVILEGE_TEXT = {
  root: '当前：root（已通过 su，可单独清缓存）',
  shell: '当前：普通权限（无 su，清缓存请用「清除数据」）',
  afc: '当前：AFC（未越狱 iOS 只能卸载，不能清缓存/数据）'
};

const normalizeDevice = (device) => {
  if (typeof device === 'string') return { id: device, label: device };
  const id = device?.id || device?.deviceId || device?.udid || '';
  return {
    ...device,
    id,
    label: device?.label || device?.name || device?.displayName || id
  };
};

const formatSize = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 100 || index === 0 ? Math.round(amount) : amount.toFixed(2)} ${units[index]}`;
};

const formatTime = (value) => String(value || '').replace('T', ' ').replace(/\.\d+Z$/, '') || '-';

const bitnessLabel = (value) => (value === 32 || value === 64 ? `${value} 位` : '-');

// 统一走 lib/clipboard：空内容给警告、失败给错误，不再静默
const copyText = (text) => copyTextWithToast(text);

const COLUMNS = [
  { key: 'app', label: '应用', width: 160 },
  { key: 'package', label: '包名', width: 180 },
  { key: 'version', label: '版本', width: 110 },
  { key: 'apkSize', label: 'APK 大小', width: 90 },
  { key: 'cache', label: '缓存', width: 80 },
  { key: 'soArch', label: 'SO 架构', width: 120 },
  { key: 'targetSdk', label: 'targetSdk', width: 90 },
  { key: 'actions', label: '操作', width: 148 },
  { key: 'firstInstall', label: '首次安装', width: 150 },
  { key: 'updated', label: '更新时间', width: 150 },
  { key: 'apkPath', label: 'APK 路径', width: 220 },
  { key: 'sha1', label: '签名 SHA1', width: 180 },
  { key: 'md5', label: '签名 MD5', width: 200 }
];

const MIN_COL_WIDTH = 64;
const MIN_ROW_HEIGHT = 40;

function safeExportName(app, ext) {
  const base = [app.label || app.packageName, app.versionName]
    .filter(Boolean)
    .join('-')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .trim() || 'app';
  return `${base}.${ext}`;
}

function DeviceApps({ initialDevice = null }) {
  const [platform, setPlatform] = useState(initialDevice?.platform === 'ios' ? 'ios' : 'android');
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice?.id || '');
  const [apps, setApps] = useState([]);
  const [androidId, setAndroidId] = useState('');
  const [privilege, setPrivilege] = useState('');
  const [deviceKindLabel, setDeviceKindLabel] = useState('');
  const [deviceBitness, setDeviceBitness] = useState(null);
  const [deviceAbi, setDeviceAbi] = useState('');
  const [filter, setFilter] = useState('user');
  const [keyword, setKeyword] = useState('');
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyPackage, setBusyPackage] = useState('');
  const [message, setMessage] = useState('');
  const [colWidths, setColWidths] = useState(() => COLUMNS.map((column) => column.width));
  const [rowHeights, setRowHeights] = useState({});
  const requestRef = useRef(0);
  const listRequestRef = useRef(0);
  const iconRequestRef = useRef(0);

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
        setApps([]);
        setAndroidId('');
        setPrivilege('');
        setDeviceKindLabel('');
        setDeviceBitness(null);
        setDeviceAbi('');
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
      setApps([]);
      setMessage({ type: 'error', text: cleanIpcError(error, '获取设备失败') });
    } finally {
      if (requestId === requestRef.current) setDeviceLoading(false);
    }
  };

  const loadIcons = async (deviceId, targetPlatform, nextApps) => {
    if (targetPlatform !== 'android' || !deviceId) return;
    const requestId = ++iconRequestRef.current;
    const targets = nextApps.filter((app) => app.isUser && app.apkPath);
    for (const app of targets) {
      if (requestId !== iconRequestRef.current) return;
      try {
        const detail = await window.electronAPI.getDeviceAppIcon({
          platform: targetPlatform,
          deviceId,
          packageName: app.packageName,
          apkPath: app.apkPath
        });
        if (requestId !== iconRequestRef.current) return;
        setApps((current) => current.map((item) => {
          if (item.packageName !== app.packageName) return item;
          return {
            ...item,
            label: detail.label || item.label,
            iconDataUrl: detail.iconDataUrl || item.iconDataUrl,
            soArch: detail.soArch || item.soArch,
            appBitness: detail.appBitness || item.appBitness,
            targetSdk: detail.targetSdk || item.targetSdk,
            sha1: detail.sha1 || item.sha1,
            md5: detail.md5 || item.md5
          };
        }));
      } catch (_) {
        // 单个 APK 拉图标失败不影响列表
      }
    }
  };

  const loadApps = async () => {
    if (!selectedDevice) return;
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setMessage('');
    try {
      const result = await window.electronAPI.listDeviceApps({
        platform,
        deviceId: selectedDevice
      });
      if (requestId !== listRequestRef.current) return;
      const nextApps = Array.isArray(result?.apps) ? result.apps : [];
      setApps(nextApps);
      setAndroidId(result?.androidId || '');
      setPrivilege(result?.privilege || '');
      setDeviceKindLabel(result?.deviceKindLabel || '');
      setDeviceBitness(result?.deviceBitness || null);
      setDeviceAbi(result?.deviceAbi || '');
      loadIcons(selectedDevice, platform, nextApps);
    } catch (error) {
      if (requestId !== listRequestRef.current) return;
      setApps([]);
      setAndroidId('');
      setPrivilege('');
      setMessage({ type: 'error', text: cleanIpcError(error, '读取应用列表失败') });
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadDevices(platform);
  }, [platform]);

  useEffect(() => {
    iconRequestRef.current += 1;
    if (selectedDevice) {
      loadApps();
    } else {
      setApps([]);
      setAndroidId('');
      setPrivilege('');
      setDeviceKindLabel('');
      setDeviceBitness(null);
      setDeviceAbi('');
    }
  }, [selectedDevice, platform]);

  const visibleApps = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return apps.filter((app) => {
      if (filter === 'user' && !app.isUser) return false;
      if (filter === 'system' && app.isUser) return false;
      if (!text) return true;
      return `${app.label || ''} ${app.packageName || ''}`.toLowerCase().includes(text);
    });
  }, [apps, filter, keyword]);

  const switchPlatform = (next) => {
    if (next === platform) return;
    setPlatform(next);
    setFilter(next === 'ios' ? 'user' : 'user');
    setKeyword('');
    setApps([]);
    setMessage('');
  };

  const startColResize = (index, event) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = colWidths[index];
    const onMove = (moveEvent) => {
      const next = Math.max(MIN_COL_WIDTH, startWidth + (moveEvent.clientX - startX));
      setColWidths((current) => current.map((width, itemIndex) => (itemIndex === index ? next : width)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startRowResize = (packageName, event) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = rowHeights[packageName]
      || event.currentTarget.closest('tr')?.getBoundingClientRect().height
      || 120;
    const onMove = (moveEvent) => {
      const next = Math.max(MIN_ROW_HEIGHT, startHeight + (moveEvent.clientY - startY));
      setRowHeights((current) => ({ ...current, [packageName]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const runAction = async (app, action, confirmText) => {
    if (!confirm(confirmText)) return;
    setBusyPackage(app.packageName);
    setMessage('');
    try {
      if (action === 'uninstall') {
        await window.electronAPI.uninstallDeviceApp({
          platform,
          deviceId: selectedDevice,
          packageName: app.packageName
        });
        setMessage({ type: 'success', text: `已卸载 ${app.label || app.packageName}` });
        await loadApps();
        return;
      }
      if (action === 'cache') {
        await window.electronAPI.clearDeviceAppCache({
          platform,
          deviceId: selectedDevice,
          packageName: app.packageName
        });
        setMessage({ type: 'success', text: `已清除 ${app.label || app.packageName} 缓存` });
      } else {
        await window.electronAPI.clearDeviceAppData({
          platform,
          deviceId: selectedDevice,
          packageName: app.packageName
        });
        setMessage({ type: 'success', text: `已清除 ${app.label || app.packageName} 数据` });
      }
      await loadApps();
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '操作失败') });
    } finally {
      setBusyPackage('');
    }
  };

  const exportApp = async (app) => {
    if (platform === 'ios') {
      setMessage({ type: 'error', text: '未越狱 iOS 无法从设备导出 IPA。' });
      return;
    }
    if (!app.apkPath) {
      setMessage({ type: 'error', text: '没有 APK 路径，无法导出' });
      return;
    }
    const localPath = await window.electronAPI.saveFile({
      defaultPath: safeExportName(app, 'apk'),
      filters: [{ name: 'APK', extensions: ['apk'] }]
    });
    if (!localPath) return;
    setBusyPackage(app.packageName);
    setMessage('');
    try {
      await window.electronAPI.exportDeviceApp({
        platform,
        deviceId: selectedDevice,
        packageName: app.packageName,
        apkPath: app.apkPath,
        localPath
      });
      setMessage({ type: 'success', text: `已导出 ${app.label || app.packageName} 到 ${localPath}` });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '导出失败') });
    } finally {
      setBusyPackage('');
    }
  };

  return (
    <div className="content-card device-apps-page">
      <h2>📱 设备应用管理</h2>
      <p className="install-lead">
        {platform === 'ios'
          ? '列出 iOS 已安装应用。未越狱只能卸载，不能清除缓存或数据。可拖动表头右侧调节列宽，拖动行底调节行高。'
          : '列出 Android 已安装应用，并读取 APK 路径、SO 架构、targetSdk 和签名摘要。清缓存需要 root。可拖动表头右侧调节列宽，拖动行底调节行高。'}
      </p>

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
          <button className="btn btn-primary" onClick={loadApps} disabled={!selectedDevice || loading}>
            {loading ? '读取中…' : '刷新应用'}
          </button>
        </div>
      </div>

      {(privilege || androidId || deviceKindLabel) && (
        <div className="device-apps-meta">
          {privilege && (
            <div className={`file-privilege file-privilege-${privilege}`}>
              {PRIVILEGE_TEXT[privilege] || privilege}
            </div>
          )}
          <div className="device-apps-chips">
            {platform === 'android' && androidId && (
              <button className="device-apps-chip" onClick={() => copyText(androidId)} title="点击复制">
                Android ID：{androidId}
              </button>
            )}
            {deviceKindLabel && (
              <span className="device-apps-chip">{deviceKindLabel}</span>
            )}
            {deviceBitness && (
              <span className="device-apps-chip">设备 {bitnessLabel(deviceBitness)}</span>
            )}
            {deviceAbi && (
              <span className="device-apps-chip">ABI {deviceAbi}</span>
            )}
            <span className="device-apps-chip">共 {apps.length} 个应用</span>
          </div>
        </div>
      )}

      <div className="device-apps-toolbar">
        <div className="file-shortcuts">
          <button className={`text-tab ${filter === 'user' ? 'is-active' : ''}`} onClick={() => setFilter('user')}>
            用户应用
          </button>
          <button className={`text-tab ${filter === 'all' ? 'is-active' : ''}`} onClick={() => setFilter('all')}>
            全部
          </button>
          {platform === 'android' && (
            <button className={`text-tab ${filter === 'system' ? 'is-active' : ''}`} onClick={() => setFilter('system')}>
              系统应用
            </button>
          )}
        </div>
        <input
          type="text"
          className="path-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索应用名或包名"
        />
      </div>

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      {!selectedDevice && !deviceLoading ? (
        <div className="message warning">
          <strong>⚠️ 未检测到{platform === 'ios' ? ' iOS' : ' Android'}设备</strong>
          <p>请确保设备已连接 USB，并完成调试授权或“信任此电脑”。</p>
        </div>
      ) : loading ? (
        <div className="loading">⏳ 正在读取已安装应用...</div>
      ) : (
        <div className="file-list device-apps-table-wrap">
          <table className="file-table device-apps-table">
            <colgroup>
              {colWidths.map((width, index) => (
                <col key={COLUMNS[index].key} style={{ width: `${width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((column, index) => (
                  <th key={column.key} style={{ width: colWidths[index] }}>
                    {column.label}
                    <span
                      className="col-resizer"
                      onMouseDown={(event) => startColResize(index, event)}
                      title="拖动调节列宽"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleApps.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} style={{ textAlign: 'center', color: '#5f6368' }}>
                    {apps.length === 0 ? '没有已安装应用' : '没有匹配的应用'}
                  </td>
                </tr>
              ) : (
                visibleApps.map((app) => (
                  <tr
                    key={app.packageName}
                    className="resizable-row"
                    style={rowHeights[app.packageName] ? { height: rowHeights[app.packageName] } : undefined}
                  >
                    <td className="cell-wrap">
                      <div className="file-name">
                        {app.iconDataUrl ? (
                          <img className="app-icon" src={app.iconDataUrl} alt="" />
                        ) : (
                          <span className="file-icon">📦</span>
                        )}
                        <span>{app.label || app.packageName}</span>
                      </div>
                      <span
                        className="row-resizer"
                        onMouseDown={(event) => startRowResize(app.packageName, event)}
                        title="拖动调节行高"
                      />
                    </td>
                    <td className="cell-wrap">
                      <button
                        className="pkg-copy"
                        onClick={() => copyText(app.packageName)}
                        title="点击复制包名"
                      >
                        {app.packageName}
                      </button>
                    </td>
                    <td className="cell-wrap">{app.versionName ? `${app.versionName}${app.versionCode ? ` (${app.versionCode})` : ''}` : '-'}</td>
                    <td>{formatSize(app.apkSize)}</td>
                    <td>{formatSize(app.cacheSize)}</td>
                    <td className="cell-wrap">{app.soArch || '-'}</td>
                    <td>{app.targetSdk || '-'}</td>
                    <td className="cell-actions">
                      <div className="file-actions">
                        <button
                          className="btn-icon"
                          disabled={busyPackage === app.packageName || platform === 'ios' || !app.apkPath}
                          onClick={() => exportApp(app)}
                          title={platform === 'ios' ? '未越狱无法导出 IPA' : (app.apkPath ? '导出 APK 到本机' : '没有 APK 路径')}
                        >
                          导出
                        </button>
                        <button
                          className="btn-icon btn-danger"
                          disabled={busyPackage === app.packageName || !app.canUninstall}
                          onClick={() => runAction(app, 'uninstall', `确定卸载 ${app.label || app.packageName} 吗？`)}
                          title={app.canUninstall ? '卸载' : '系统应用不能卸载'}
                        >
                          卸载
                        </button>
                        <button
                          className="btn-icon"
                          disabled={busyPackage === app.packageName || !app.canClearCache}
                          onClick={() => runAction(app, 'cache', `确定清除 ${app.label || app.packageName} 的缓存吗？`)}
                          title={app.canClearCache ? '删除缓存' : '当前权限不能清缓存'}
                        >
                          清缓存
                        </button>
                        <button
                          className="btn-icon"
                          disabled={busyPackage === app.packageName || !app.canClearData}
                          onClick={() => runAction(app, 'data', `确定清除 ${app.label || app.packageName} 的全部数据吗？应用会恢复到刚安装的状态。`)}
                          title={app.canClearData ? '删除数据' : '当前权限不能清数据'}
                        >
                          清数据
                        </button>
                      </div>
                    </td>
                    <td className="cell-wrap">{formatTime(app.firstInstallTime)}</td>
                    <td className="cell-wrap">{formatTime(app.lastUpdateTime)}</td>
                    <td className="cell-wrap"><code className="path-cell">{app.apkPath || '-'}</code></td>
                    <td className="cell-wrap"><code className="digest-cell">{app.sha1 || '-'}</code></td>
                    <td className="cell-wrap"><code className="digest-cell">{app.md5 || '-'}</code></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <style jsx>{`
        .device-apps-meta {
          margin: 0 0 12px;
        }

        .file-privilege {
          margin: 0 0 10px;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 13px;
          background: #f7f8fc;
          color: #3c4043;
        }

        .file-privilege-root {
          background: #e8f5e9;
          color: #1b5e20;
        }

        .file-privilege-shell,
        .file-privilege-afc {
          background: #fff8e1;
          color: #8d6e00;
        }

        .device-apps-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 8px;
        }

        .device-apps-chip {
          border: 1px solid #e8eaed;
          background: #f7f8fc;
          color: #3c4043;
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 12px;
        }

        button.device-apps-chip {
          cursor: pointer;
        }

        .device-apps-toolbar {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: 16px;
        }

        .file-shortcuts {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .path-input {
          flex: 1;
          min-width: 200px;
          padding: 10px 14px;
          border: 2px solid #e8eaed;
          border-radius: 8px;
          font-size: 14px;
        }

        .device-apps-table-wrap {
          max-height: calc(100vh - 360px);
          overflow: auto;
          border: 1px solid #e8eaed;
          border-radius: 8px;
        }

        .device-apps-table {
          width: max-content;
          min-width: 100%;
          table-layout: fixed;
          border-collapse: separate;
          border-spacing: 0;
        }

        .device-apps-table thead th {
          position: sticky;
          top: 0;
          z-index: 8;
          background: #f7f8fc;
          box-shadow: inset 0 -2px 0 #e8eaed;
        }

        .file-table th,
        .file-table td {
          position: relative;
          padding: 10px 12px;
          text-align: left;
          border-bottom: 1px solid #f0f2f5;
          font-size: 13px;
          white-space: nowrap;
          vertical-align: top;
          overflow: hidden;
        }

        .file-table th {
          font-weight: 600;
          color: #5f6368;
          white-space: nowrap;
        }

        .file-table tbody td {
          z-index: 0;
          background: #fff;
        }

        .file-table td.cell-wrap {
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.45;
        }

        .resizable-row td {
          height: inherit;
          max-height: inherit;
        }

        .col-resizer,
        .row-resizer {
          user-select: none;
        }

        .col-resizer {
          position: absolute;
          top: 0;
          right: -3px;
          z-index: 3;
          width: 8px;
          height: 100%;
          cursor: col-resize;
        }

        .row-resizer {
          position: absolute;
          left: 0;
          bottom: -3px;
          z-index: 3;
          width: 100%;
          height: 8px;
          cursor: row-resize;
        }

        .col-resizer:hover,
        .row-resizer:hover {
          background: rgba(102, 126, 234, 0.35);
        }

        .file-table tbody tr:hover td {
          background: #f7f8fc;
        }

        .file-name {
          display: flex;
          align-items: flex-start;
          gap: 8px;
        }

        .file-name span {
          min-width: 0;
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .app-icon {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          object-fit: cover;
          background: #eef0f5;
          flex-shrink: 0;
        }

        .file-icon {
          font-size: 20px;
          flex-shrink: 0;
        }

        .pkg-copy {
          background: none;
          border: 0;
          padding: 0;
          color: #3c4043;
          cursor: pointer;
          font-family: 'Monaco', 'Consolas', monospace;
          font-size: 12px;
          text-align: left;
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.45;
        }

        .path-cell,
        .digest-cell {
          display: block;
          max-width: 100%;
          font-size: 11px;
          font-family: 'Monaco', 'Consolas', monospace;
          background: #f7f8fc;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.45;
        }

        .file-table td.cell-actions {
          overflow: visible;
          white-space: normal;
          vertical-align: top;
        }

        .file-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          min-width: 128px;
        }

        .device-apps-page .btn-icon {
          background: #fff;
          border: 1px solid #dadce0;
          padding: 4px 6px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          line-height: 1.3;
          color: #202124;
          white-space: nowrap;
        }

        .device-apps-page .btn-icon:hover:not(:disabled) {
          border-color: #667eea;
          color: #667eea;
        }

        .device-apps-page .btn-icon:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .device-apps-page .btn-icon.btn-danger {
          color: #c62828;
          background: #fff;
          border-color: #ef9a9a;
        }

        .device-apps-page .btn-icon.btn-danger:hover:not(:disabled) {
          background: #ffebee;
          color: #b71c1c;
        }
      `}</style>
    </div>
  );
}

export default DeviceApps;
