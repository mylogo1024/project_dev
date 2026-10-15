import React, { useCallback, useEffect, useMemo, useState } from 'react';
import IosMirror from './IosMirror';
import { cleanIpcError } from '../lib/errorText';

const DEFAULT_OPTIONS = {
  maxSize: '1024',
  maxFps: '',
  bitRate: '',
  stayAwake: true,
  turnScreenOff: false,
  alwaysOnTop: false,
  fullscreen: false,
  noAudio: true,
  noControl: false,
  showTouches: false,
  powerOffOnClose: false,
  uhidKeyboard: false,
  recordPath: ''
};

const FLAGS = [
  { key: 'stayAwake', label: '保持唤醒' },
  { key: 'turnScreenOff', label: '关闭手机屏幕' },
  { key: 'alwaysOnTop', label: '窗口置顶' },
  { key: 'fullscreen', label: '全屏投屏' },
  { key: 'noAudio', label: '不要音频' },
  { key: 'noControl', label: '只看不控' },
  { key: 'showTouches', label: '显示触摸点' },
  { key: 'powerOffOnClose', label: '关闭窗口时锁屏' },
  { key: 'uhidKeyboard', label: 'UHID 物理键盘' }
];

const STATE_TEXT = {
  starting: '正在启动',
  running: '投屏中',
  stopping: '正在停止',
  stopped: '已停止',
  error: '失败'
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

const sessionForDevice = (status, deviceId) => {
  const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
  return sessions.find((item) => item.deviceId === deviceId) || null;
};

function DeviceControl({ initialDevice = null }) {
  const [platform, setPlatform] = useState(initialDevice?.platform === 'ios' ? 'ios' : 'android');
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(initialDevice?.id || '');
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [tool, setTool] = useState({ installed: false, path: '' });
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [status, setStatus] = useState({ sessions: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const session = useMemo(
    () => sessionForDevice(status, selectedDevice),
    [status, selectedDevice]
  );
  const state = session?.state || 'stopped';
  const running = state === 'starting' || state === 'running' || state === 'stopping';

  const loadDevices = useCallback(async () => {
    setDeviceLoading(true);
    try {
      const result = await window.electronAPI.getLogDevices('android');
      const rawDevices = Array.isArray(result) ? result : result?.devices;
      const nextDevices = (Array.isArray(rawDevices) ? rawDevices : [])
        .map(normalizeDevice)
        .filter((device) => device.id);
      setDevices(nextDevices);
      setSelectedDevice((current) => (
        nextDevices.some((device) => device.id === current) ? current : (nextDevices[0]?.id || '')
      ));
      if (nextDevices.length === 0) {
        setMessage({ type: 'warning', text: '未检测到 Android 设备。请连接 USB 并开启调试。' });
      } else {
        setMessage(null);
      }
    } catch (error) {
      setDevices([]);
      setSelectedDevice('');
      setMessage({ type: 'error', text: cleanIpcError(error, '获取设备失败') });
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  const loadTool = useCallback(async () => {
    try {
      const detected = await window.electronAPI.detectScrcpy();
      setTool({
        installed: Boolean(detected?.installed),
        path: detected?.path || ''
      });
    } catch (_) {
      setTool({ installed: false, path: '' });
    }
  }, []);

  useEffect(() => {
    loadDevices();
    loadTool();
    window.electronAPI.getScrcpyStatus?.().then((next) => {
      if (next) setStatus(next);
    }).catch(() => {});
    const unsubscribe = window.electronAPI.onScrcpyStatus?.((next) => {
      if (next) setStatus(next);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [loadDevices, loadTool]);

  const patchOption = (key, value) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const start = async () => {
    if (!selectedDevice) {
      setMessage({ type: 'error', text: '请先选择 Android 设备' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await window.electronAPI.startScrcpy({
        ...options,
        deviceId: selectedDevice
      });
      setMessage({ type: 'success', text: '已启动投屏，控制窗口会单独弹出。' });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '启动 scrcpy 失败') });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await window.electronAPI.stopScrcpy(selectedDevice);
      setMessage({ type: 'info', text: '已停止投屏' });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '停止失败') });
    } finally {
      setBusy(false);
    }
  };

  const chooseRecordPath = async () => {
    const filePath = await window.electronAPI.saveFile({
      defaultPath: `scrcpy-${Date.now()}.mp4`,
      filters: [{ name: '视频', extensions: ['mp4', 'mkv'] }]
    });
    if (filePath) patchOption('recordPath', filePath);
  };

  return (
    <div className={`content-card device-control-page ${platform === 'ios' ? 'ios-mirror-page' : ''}`}>
      <div className="device-control-head">
        <h2>🖥️ 设备投屏控制</h2>
        <div className="sign-platform-tabs">
          <button
            type="button"
            className={`text-tab ${platform === 'android' ? 'is-active' : ''}`}
            onClick={() => setPlatform('android')}
          >
            Android
          </button>
          <button
            type="button"
            className={`text-tab ${platform === 'ios' ? 'is-active' : ''}`}
            onClick={() => setPlatform('ios')}
          >
            iOS
          </button>
        </div>
      </div>
      <style>{`
        .device-control-page { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
        .device-control-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          flex-shrink: 0;
          margin-bottom: 14px;
        }
        .device-control-head h2 { margin: 0; padding: 0; border: 0; font-size: 22px; }
        .device-control-head .sign-platform-tabs { margin: 0; }
      `}</style>
      {platform === 'ios' ? <IosMirror embedded initialDevice={initialDevice} /> : (
      <>
      <p className="install-lead">
        使用 scrcpy 镜像并控制已连接的 Android 设备。画面在独立窗口中打开，可用电脑鼠标和键盘操作手机。
        不需要 root，也不用在手机上装 App。
      </p>

      <div className={`scrcpy-tool ${tool.installed ? 'is-ready' : 'is-missing'}`}>
        {tool.installed
          ? `当前 scrcpy：${tool.path}`
          : '未找到 scrcpy。请执行 brew install scrcpy，或把本地编译产物放到 PATH 后完全退出再打开本应用。'}
      </div>

      <div className="form-group">
        <label>选择 Android 设备</label>
        <div className="file-input-group">
          <select
            value={selectedDevice}
            onChange={(event) => setSelectedDevice(event.target.value)}
            disabled={deviceLoading || devices.length === 0 || running}
          >
            {devices.length === 0 ? (
              <option value="">{deviceLoading ? '正在检测设备…' : '未检测到设备'}</option>
            ) : (
              devices.map((device) => (
                <option key={device.id} value={device.id}>{device.label}</option>
              ))
            )}
          </select>
          <button className="btn btn-secondary" onClick={loadDevices} disabled={deviceLoading || running}>
            {deviceLoading ? '检测中…' : '刷新设备'}
          </button>
        </div>
      </div>

      <div className="scrcpy-grid">
        <div className="form-group">
          <label>最大边长（越小越流畅）</label>
          <select value={options.maxSize} onChange={(event) => patchOption('maxSize', event.target.value)} disabled={running}>
            <option value="">不限制</option>
            <option value="800">800</option>
            <option value="1024">1024（推荐）</option>
            <option value="1280">1280</option>
            <option value="1920">1920</option>
          </select>
        </div>
        <div className="form-group">
          <label>帧率上限</label>
          <select value={options.maxFps} onChange={(event) => patchOption('maxFps', event.target.value)} disabled={running}>
            <option value="">默认</option>
            <option value="30">30</option>
            <option value="60">60</option>
            <option value="120">120</option>
          </select>
        </div>
        <div className="form-group">
          <label>视频码率</label>
          <select value={options.bitRate} onChange={(event) => patchOption('bitRate', event.target.value)} disabled={running}>
            <option value="">默认 8M</option>
            <option value="2M">2M</option>
            <option value="4M">4M</option>
            <option value="8M">8M</option>
            <option value="16M">16M</option>
          </select>
        </div>
      </div>

      <div className="scrcpy-flags">
        {FLAGS.map((flag) => (
          <label key={flag.key} className="scrcpy-flag">
            <input
              type="checkbox"
              checked={Boolean(options[flag.key])}
              disabled={running}
              onChange={(event) => patchOption(flag.key, event.target.checked)}
            />
            <span>{flag.label}</span>
          </label>
        ))}
      </div>

      <div className="form-group">
        <label>录制到文件（可选）</label>
        <div className="file-input-group">
          <input type="text" readOnly value={options.recordPath} placeholder="不录制" />
          <button className="btn btn-secondary" onClick={chooseRecordPath} disabled={running}>选择</button>
          {options.recordPath ? (
            <button className="btn btn-secondary" onClick={() => patchOption('recordPath', '')} disabled={running}>清除</button>
          ) : null}
        </div>
      </div>

      {message && (
        <div className={`message ${message.type}`}>{message.text}</div>
      )}

      <div className="action-buttons">
        {running ? (
          <button className="btn btn-danger" onClick={stop} disabled={busy || state === 'stopping'}>
            {state === 'stopping' ? '正在停止…' : '停止投屏'}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={start} disabled={busy || !selectedDevice || !tool.installed}>
            {busy ? '启动中…' : '开始投屏控制'}
          </button>
        )}
      </div>

      {session && (
        <div className="scrcpy-status">
          <div className="scrcpy-status-row">
            <strong>状态</strong>
            <span>{STATE_TEXT[state] || state}{session.pid ? ` · PID ${session.pid}` : ''}</span>
          </div>
          {session.message && (
            <div className="scrcpy-status-row">
              <strong>说明</strong>
              <span>{session.message}</span>
            </div>
          )}
          {session.log ? <pre className="scrcpy-log">{session.log.trim()}</pre> : null}
        </div>
      )}

      <div className="scrcpy-tips">
        <h3>操作提示</h3>
        <ul>
          <li>右键 = 返回，中键 = Home，Alt+F = 全屏。</li>
          <li>投屏窗口关掉后，这里的状态会变成已停止。</li>
          <li>切到其他功能页不会打断投屏；要重来请点「停止投屏」或顶栏「重新加载」。</li>
          <li>小米等机型若无法点击，请在开发者选项打开「USB 调试（安全设置）」后重启手机。</li>
        </ul>
      </div>

      <style>{`
        .scrcpy-tool {
          margin: 0 0 16px;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 13px;
          word-break: break-all;
        }
        .scrcpy-tool.is-ready {
          background: #e8f5e9;
          color: #1b5e20;
        }
        .scrcpy-tool.is-missing {
          background: #fff8e1;
          color: #8d6e00;
        }
        .scrcpy-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px 16px;
        }
        .scrcpy-flags {
          display: flex;
          flex-wrap: wrap;
          gap: 10px 16px;
          margin: 8px 0 18px;
        }
        .scrcpy-flag {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 14px;
          color: #3c4043;
          cursor: pointer;
        }
        .device-control-page .btn-danger {
          background: #c62828;
          color: #fff;
          border: none;
        }
        .scrcpy-status {
          margin-top: 20px;
          padding: 14px 16px;
          background: #f7f8fc;
          border-radius: 10px;
        }
        .scrcpy-status-row {
          display: flex;
          gap: 12px;
          margin-bottom: 8px;
          font-size: 14px;
        }
        .scrcpy-status-row strong {
          width: 48px;
          color: #5f6368;
          flex-shrink: 0;
        }
        .scrcpy-log {
          margin: 8px 0 0;
          max-height: 180px;
          overflow: auto;
          background: #202124;
          color: #e8eaed;
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 12px;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        .scrcpy-tips {
          margin-top: 24px;
        }
        .scrcpy-tips ul {
          margin: 0;
          padding-left: 18px;
          color: #5f6368;
          line-height: 1.7;
        }
        @media (max-width: 900px) {
          .scrcpy-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      </>
      )}
    </div>
  );
}

export default DeviceControl;
