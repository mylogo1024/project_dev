import React, { useEffect, useRef, useState } from 'react';
import { cleanIpcError } from '../lib/errorText';

const DEFAULT_PATH = {
  android: '/sdcard/',
  ios: '/'
};

const SHORTCUTS = {
  android: [
    { path: '/sdcard/', label: '内部存储' },
    { path: '/sdcard/Download', label: 'Download' },
    { path: '/sdcard/DCIM', label: 'DCIM' },
    { path: '/data/local/tmp', label: '/data/local/tmp' },
    { path: '/', label: '根目录' }
  ],
  ios: [
    { path: '/', label: '媒体分区' },
    { path: '/DCIM', label: 'DCIM' },
    { path: '/Downloads', label: 'Downloads' },
    { path: '/apps', label: '应用文档' }
  ]
};

const PRIVILEGE_TEXT = {
  root: '当前：root（已通过 su）',
  shell: '当前：普通权限（无 su）',
  afc: '当前：AFC 媒体分区（未越狱不能浏览整机）',
  documents: '当前：应用 Documents / 容器',
  apps: '当前：已安装应用列表，点进应用可尝试打开 Documents'
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

const joinPath = (base, name) => `${base}/${name}`.replace(/\/+/g, '/') || '/';

const parentPath = (currentPath) => {
  const trimmed = String(currentPath || '/').replace(/\/+$/, '') || '/';
  if (trimmed === '/') return '/';
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
};

function FileManager({ initialDevice = null }) {
  const [platform, setPlatform] = useState(initialDevice?.platform === 'ios' ? 'ios' : 'android');
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice?.id || '');
  const [currentPath, setCurrentPath] = useState(initialDevice?.platform === 'ios' ? DEFAULT_PATH.ios : DEFAULT_PATH.android);
  const [pathInput, setPathInput] = useState(initialDevice?.platform === 'ios' ? DEFAULT_PATH.ios : DEFAULT_PATH.android);
  const [files, setFiles] = useState([]);
  const [privilege, setPrivilege] = useState('');
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const requestRef = useRef(0);
  const listRequestRef = useRef(0);

  const fileRequest = (extra = {}) => ({
    deviceId: selectedDevice,
    platform,
    ...extra
  });

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
        setFiles([]);
        setPrivilege('');
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
      setFiles([]);
      setPrivilege('');
      setMessage({ type: 'error', text: cleanIpcError(error, '获取设备失败') });
    } finally {
      if (requestId === requestRef.current) setDeviceLoading(false);
    }
  };

  useEffect(() => {
    loadDevices(platform);
  }, [platform]);

  useEffect(() => {
    if (selectedDevice) {
      listFiles(currentPath);
    } else {
      setFiles([]);
      setPrivilege('');
    }
  }, [selectedDevice, currentPath, platform]);

  const listFiles = async (path, { refreshPrivilege = false } = {}) => {
    if (!selectedDevice) return;
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setMessage('');
    try {
      const result = await window.electronAPI.listDeviceFiles({
        ...fileRequest({ path, refreshPrivilege })
      });
      if (requestId !== listRequestRef.current) return;
      const fileList = Array.isArray(result) ? result : (result?.files || []);
      setFiles(fileList);
      setPrivilege(Array.isArray(result) ? '' : (result?.privilege || ''));
    } catch (error) {
      if (requestId !== listRequestRef.current) return;
      const detail = cleanIpcError(error, '读取文件列表失败');
      setFiles([]);
      setMessage({
        type: 'error',
        text: detail.includes('读取文件列表失败') ? detail : `读取文件列表失败: ${detail}`
      });
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  };

  const switchPlatform = (nextPlatform) => {
    if (nextPlatform === platform) return;
    setPlatform(nextPlatform);
    setSelectedDevice('');
    setDevices([]);
    setFiles([]);
    setPrivilege('');
    setMessage('');
    const nextPath = DEFAULT_PATH[nextPlatform];
    setCurrentPath(nextPath);
    setPathInput(nextPath);
  };

  const navigateToPath = (path) => {
    const next = path || DEFAULT_PATH[platform];
    setPathInput(next);
    setCurrentPath(next);
  };

  const commitPathInput = () => {
    const next = pathInput.trim() || DEFAULT_PATH[platform];
    setPathInput(next);
    setCurrentPath(next);
  };

  const downloadFile = async (file) => {
    const remotePath = joinPath(currentPath, file.name);
    try {
      const savePath = await window.electronAPI.saveFile({
        defaultPath: file.name,
        filters: [{ name: 'All Files', extensions: ['*'] }]
      });
      if (!savePath) return;
      setMessage({ type: 'info', text: '正在下载...' });
      await window.electronAPI.pullFile({
        ...fileRequest({ remotePath, localPath: savePath })
      });
      setMessage({ type: 'success', text: `文件已下载到: ${savePath}` });
    } catch (error) {
      setMessage({ type: 'error', text: `下载失败: ${cleanIpcError(error, '下载失败')}` });
    }
  };

  const uploadFile = async () => {
    if (privilege === 'apps') {
      setMessage({ type: 'warning', text: '请先进入具体应用，再上传到 Documents' });
      return;
    }
    try {
      const filePath = await window.electronAPI.selectFile({
        properties: ['openFile'],
        filters: [{ name: 'All Files', extensions: ['*'] }]
      });
      if (!filePath) return;
      const fileName = filePath.split('/').pop();
      const remotePath = joinPath(currentPath, fileName);
      setMessage({ type: 'info', text: '正在上传...' });
      await window.electronAPI.pushFile({
        ...fileRequest({ localPath: filePath, remotePath })
      });
      setMessage({ type: 'success', text: '文件上传成功！' });
      listFiles(currentPath);
    } catch (error) {
      setMessage({ type: 'error', text: `上传失败: ${cleanIpcError(error, '上传失败')}` });
    }
  };

  const deleteFile = async (file) => {
    if (privilege === 'apps') {
      setMessage({ type: 'warning', text: '文件管理里不能卸载应用' });
      return;
    }
    if (!confirm(`确定要删除 ${file.name} 吗？`)) return;
    const remotePath = joinPath(currentPath, file.name);
    try {
      await window.electronAPI.deleteDeviceFile(fileRequest({ remotePath }));
      setMessage({ type: 'success', text: '文件已删除！' });
      listFiles(currentPath);
    } catch (error) {
      setMessage({ type: 'error', text: `删除失败: ${cleanIpcError(error, '删除失败')}` });
    }
  };

  const getFileIcon = (file) => {
    if (file.isDirectory) return '📁';
    const ext = file.name.split('.').pop().toLowerCase();
    const iconMap = {
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', heic: '🖼️',
      mp4: '🎬', avi: '🎬', mov: '🎬',
      mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵',
      txt: '📄', log: '📄', plist: '📄',
      apk: '📦', ipa: '📦',
      zip: '🗜️', rar: '🗜️', '7z': '🗜️'
    };
    return iconMap[ext] || '📄';
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
  };

  const canMutate = privilege !== 'apps';
  const atRoot = currentPath === '/';

  return (
    <div className="content-card">
      <h2>📂 设备文件管理</h2>
      <p className="install-lead">
        {platform === 'ios'
          ? 'iOS 未越狱只能访问媒体分区，以及开启了文件共享的应用 Documents。'
          : 'Android 会先尝试 adb shell su；拿到 root 后用最高权限浏览，没有 su 则退回普通权限。'}
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
        </div>
      </div>

      {privilege && (
        <div className={`file-privilege file-privilege-${privilege}`}>
          {PRIVILEGE_TEXT[privilege] || privilege}
        </div>
      )}

      <div className="file-shortcuts">
        {SHORTCUTS[platform].map((item) => (
          <button
            key={item.path}
            className={`text-tab ${currentPath === item.path ? 'is-active' : ''}`}
            onClick={() => navigateToPath(item.path)}
            disabled={!selectedDevice}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="file-nav">
        <button className="btn btn-secondary" onClick={() => navigateToPath(parentPath(currentPath))} disabled={atRoot || !selectedDevice}>
          ⬆️ 上级目录
        </button>
        <input
          type="text"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && commitPathInput()}
          className="path-input"
          placeholder={platform === 'ios' ? '/ 或 /apps/包名' : '/sdcard/'}
        />
        <button
          className="btn btn-primary"
          onClick={() => {
            const next = pathInput.trim() || DEFAULT_PATH[platform];
            setPathInput(next);
            if (next !== currentPath) setCurrentPath(next);
            else listFiles(currentPath, { refreshPrivilege: true });
          }}
          disabled={!selectedDevice}
        >
          🔄 刷新
        </button>
        <button className="btn btn-primary" onClick={uploadFile} disabled={!selectedDevice || !canMutate}>
          ⬆️ 上传文件
        </button>
      </div>

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      {!selectedDevice && !deviceLoading ? (
        <div className="message warning">
          <strong>⚠️ 未检测到{platform === 'ios' ? ' iOS' : ' Android'}设备</strong>
          <p>请确保：</p>
          <ul>
            {platform === 'ios' ? (
              <>
                <li>设备已通过 USB 连接并解锁</li>
                <li>已点击「信任此电脑」</li>
                <li>已安装 libimobiledevice（含 afcclient）</li>
              </>
            ) : (
              <>
                <li>设备已通过 USB 连接到电脑</li>
                <li>设备已开启 USB 调试</li>
                <li>已安装 ADB 工具</li>
              </>
            )}
          </ul>
        </div>
      ) : loading ? (
        <div className="loading">⏳ 加载中...</div>
      ) : (
        <div className="file-list">
          <table className="file-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>大小</th>
                <th>权限</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 ? (
                <tr>
                  <td colSpan="4" style={{ textAlign: 'center', color: '#5f6368' }}>
                    目录为空
                  </td>
                </tr>
              ) : (
                files.map((file) => (
                  <tr key={`${file.name}-${file.permissions}`}>
                    <td>
                      <div
                        className="file-name"
                        onClick={() => file.isDirectory && navigateToPath(joinPath(currentPath, file.name))}
                      >
                        <span className="file-icon">{getFileIcon(file)}</span>
                        <span style={{ cursor: file.isDirectory ? 'pointer' : 'default' }}>
                          {file.label || file.name}
                        </span>
                      </div>
                    </td>
                    <td>{file.isDirectory ? '-' : formatSize(file.size)}</td>
                    <td><code>{file.permissions || '-'}</code></td>
                    <td>
                      <div className="file-actions">
                        {privilege !== 'apps' && !file.isDirectory && (
                          <button
                            className="btn-icon"
                            onClick={() => downloadFile(file)}
                            title="下载"
                          >
                            ⬇️
                          </button>
                        )}
                        {canMutate && (
                          <button
                            className="btn-icon btn-danger"
                            onClick={() => deleteFile(file)}
                            title="删除"
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <style jsx>{`
        .file-nav {
          display: flex;
          gap: 12px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }

        .file-shortcuts {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: 0 0 14px;
        }

        .file-privilege {
          margin: 0 0 12px;
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
        .file-privilege-afc,
        .file-privilege-documents,
        .file-privilege-apps {
          background: #fff8e1;
          color: #8d6e00;
        }

        .file-privilege-root + .file-shortcuts {
          margin-top: 0;
        }

        .path-input {
          flex: 1;
          min-width: 200px;
          padding: 10px 14px;
          border: 2px solid #e8eaed;
          border-radius: 8px;
          font-size: 14px;
          font-family: 'Monaco', 'Consolas', monospace;
        }

        .file-list {
          max-height: 500px;
          overflow-y: auto;
          border: 1px solid #e8eaed;
          border-radius: 8px;
        }

        .file-table {
          width: 100%;
          border-collapse: collapse;
        }

        .file-table thead {
          background: #f7f8fc;
          position: sticky;
          top: 0;
          z-index: 1;
        }

        .file-table th {
          padding: 12px 16px;
          text-align: left;
          font-weight: 600;
          color: #5f6368;
          font-size: 13px;
          border-bottom: 2px solid #e8eaed;
        }

        .file-table td {
          padding: 12px 16px;
          border-bottom: 1px solid #f0f2f5;
          font-size: 14px;
        }

        .file-table tbody tr:hover {
          background: #f7f8fc;
        }

        .file-name {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .file-icon {
          font-size: 20px;
        }

        .file-actions {
          display: flex;
          gap: 8px;
        }

        .btn-icon {
          background: #f7f8fc;
          border: 1px solid #e8eaed;
          padding: 6px 10px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 16px;
          transition: all 0.2s;
        }

        .btn-icon:hover {
          background: #e8eaed;
          transform: scale(1.1);
        }

        .btn-icon.btn-danger:hover {
          background: #ffebee;
          border-color: #f44336;
        }

        code {
          background: #f7f8fc;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
          font-family: 'Monaco', 'Consolas', monospace;
        }
      `}</style>
    </div>
  );
}

export default FileManager;
