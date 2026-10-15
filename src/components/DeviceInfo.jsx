import React, { useState, useEffect } from 'react';
import { toastSuccess, toastError } from '../lib/toastStore';
import { copyTextWithToast } from '../lib/clipboard';

function DeviceInfo() {
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDeviceInfo();
  }, []);

  const loadDeviceInfo = async () => {
    setLoading(true);
    try {
      const info = await window.electronAPI.getDeviceInfo();
      setDeviceInfo(info);
    } catch (error) {
      console.error('获取设备信息失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
  };

  const formatUptime = (seconds) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
  };

  // 原来是「不 await 不 catch + 无条件提示成功」—— 权限被拒时会假成功
  const copyToClipboard = (text) => copyTextWithToast(text);

  const exportInfo = async () => {
    if (!deviceInfo) return;
    
    const text = `# 设备信息报告

## 系统信息
- 操作系统: ${deviceInfo.system.platform} ${deviceInfo.system.release}
- 架构: ${deviceInfo.system.arch}
- 主机名: ${deviceInfo.system.hostname}
- 用户名: ${deviceInfo.system.username}
- 系统类型: ${deviceInfo.system.type}
- 运行时间: ${formatUptime(deviceInfo.system.uptime)}

## CPU 信息
- 型号: ${deviceInfo.cpu.model}
- 核心数: ${deviceInfo.cpu.cores}
- 物理核心: ${deviceInfo.cpu.physicalCores || 'N/A'}
- 速度: ${deviceInfo.cpu.speed} MHz

## 内存信息
- 总内存: ${formatBytes(deviceInfo.memory.total)}
- 已用内存: ${formatBytes(deviceInfo.memory.used)}
- 可用内存: ${formatBytes(deviceInfo.memory.free)}
- 使用率: ${deviceInfo.memory.usagePercent}%

## 网络信息
${Object.entries(deviceInfo.network).map(([iface, info]) => `
### ${iface}
${info.map(addr => `- ${addr.family}: ${addr.address} ${addr.internal ? '(内部)' : ''}`).join('\n')}
`).join('\n')}

## Node.js 信息
- Node 版本: ${deviceInfo.node.version}
- V8 版本: ${deviceInfo.node.v8}
- 进程 PID: ${deviceInfo.node.pid}
- 进程内存: ${formatBytes(deviceInfo.node.memoryUsage.heapUsed)} / ${formatBytes(deviceInfo.node.memoryUsage.heapTotal)}

## 环境变量
- HOME: ${deviceInfo.env.HOME || deviceInfo.env.USERPROFILE || 'N/A'}
- PATH: ${deviceInfo.env.PATH?.substring(0, 100)}...
- SHELL: ${deviceInfo.env.SHELL || deviceInfo.env.ComSpec || 'N/A'}

---
生成时间: ${new Date().toLocaleString()}
`;

    try {
      await window.electronAPI.exportDeviceInfo(text);
      toastSuccess('设备信息已导出');
    } catch (error) {
      toastError('导出失败: ' + error.message);
    }
  };

  if (loading) {
    return (
      <div className="content-card">
        <h2>本机信息</h2>
        <div className="loading">正在加载本机信息...</div>
      </div>
    );
  }

  if (!deviceInfo) {
    return (
      <div className="content-card">
        <h2>本机信息</h2>
        <div className="message error">无法获取本机信息</div>
      </div>
    );
  }

  return (
    <div className="content-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ margin: 0 }}>本机信息</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-secondary" onClick={loadDeviceInfo}>
            刷新
          </button>
          <button className="btn btn-primary" onClick={exportInfo}>
            导出报告
          </button>
        </div>
      </div>

      <div className="info-display">
        {/* 系统信息 */}
        <div className="info-section">
          <h3>💻 系统信息</h3>
          <div className="info-item">
            <strong>系统名称:</strong>
            <span>{deviceInfo.system.prettyName || `${deviceInfo.system.platform} ${deviceInfo.system.release}`}</span>
          </div>
          <div className="info-item">
            <strong>操作系统:</strong>
            <span>{deviceInfo.system.platform} {deviceInfo.system.release}</span>
          </div>
          <div className="info-item">
            <strong>系统版本:</strong>
            <span>{deviceInfo.system.version || deviceInfo.system.type}</span>
          </div>
          <div className="info-item">
            <strong>架构 / 机型:</strong>
            <span>{deviceInfo.system.arch}{deviceInfo.system.machine ? ` · ${deviceInfo.system.machine}` : ''}</span>
          </div>
          <div className="info-item">
            <strong>主机名:</strong>
            <span>{deviceInfo.system.hostname}</span>
          </div>
          <div className="info-item">
            <strong>用户名:</strong>
            <span>{deviceInfo.system.username}</span>
          </div>
          <div className="info-item">
            <strong>用户目录:</strong>
            <span>{deviceInfo.system.homedir || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>语言 / 时区:</strong>
            <span>{deviceInfo.system.locale || 'N/A'} · {deviceInfo.system.timeZone || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>系统运行时间:</strong>
            <span>{formatUptime(deviceInfo.system.uptime)}</span>
          </div>
          {Array.isArray(deviceInfo.system.loadavg) && (
            <div className="info-item">
              <strong>负载:</strong>
              <span>{deviceInfo.system.loadavg.map((value) => Number(value).toFixed(2)).join(' / ')}</span>
            </div>
          )}
        </div>

        {/* CPU 信息 */}
        <div className="info-section">
          <h3>🔧 CPU 信息</h3>
          <div className="info-item">
            <strong>型号:</strong>
            <span>{deviceInfo.cpu.model}</span>
          </div>
          <div className="info-item">
            <strong>核心数:</strong>
            <span>{deviceInfo.cpu.cores} 个逻辑核心</span>
          </div>
          {deviceInfo.cpu.physicalCores && (
            <div className="info-item">
              <strong>物理核心:</strong>
              <span>{deviceInfo.cpu.physicalCores} 个</span>
            </div>
          )}
          <div className="info-item">
            <strong>速度:</strong>
            <span>{deviceInfo.cpu.speed} MHz</span>
          </div>
        </div>

        {/* 内存信息 */}
        <div className="info-section">
          <h3>💾 内存信息</h3>
          <div className="info-item">
            <strong>总内存:</strong>
            <span>{formatBytes(deviceInfo.memory.total)}</span>
          </div>
          <div className="info-item">
            <strong>已用内存:</strong>
            <span>{formatBytes(deviceInfo.memory.used)}</span>
          </div>
          <div className="info-item">
            <strong>可用内存:</strong>
            <span>{formatBytes(deviceInfo.memory.free)}</span>
          </div>
          <div className="info-item">
            <strong>使用率:</strong>
            <span style={{ 
              color: deviceInfo.memory.usagePercent > 80 ? '#e74c3c' : 
                     deviceInfo.memory.usagePercent > 60 ? '#f39c12' : '#2ecc71',
              fontWeight: 'bold'
            }}>
              {deviceInfo.memory.usagePercent}%
            </span>
          </div>
          <div style={{ marginTop: '10px' }}>
            <div style={{ 
              width: '100%', 
              height: '20px', 
              background: '#ecf0f1', 
              borderRadius: '10px',
              overflow: 'hidden'
            }}>
              <div style={{ 
                width: `${deviceInfo.memory.usagePercent}%`, 
                height: '100%',
                background: deviceInfo.memory.usagePercent > 80 ? '#e74c3c' : 
                           deviceInfo.memory.usagePercent > 60 ? '#f39c12' : '#2ecc71',
                transition: 'width 0.3s'
              }} />
            </div>
          </div>
        </div>

        {/* 网络信息 */}
        <div className="info-section">
          <h3>🌐 网络信息</h3>
          {Object.entries(deviceInfo.network).map(([iface, addresses]) => (
            <div key={iface} style={{ marginBottom: '12px' }}>
              <div style={{ fontWeight: 'bold', color: '#495057', marginBottom: '4px' }}>
                {iface}
              </div>
              {addresses.map((addr, idx) => (
                <div key={idx} className="info-item" style={{ paddingLeft: '20px' }}>
                  <strong>{addr.family}:</strong>
                  <span>
                    {addr.address}
                    {addr.cidr ? ` / ${addr.cidr}` : ''}
                    {addr.netmask ? ` · 掩码 ${addr.netmask}` : ''}
                    {addr.mac ? ` · MAC ${addr.mac}` : ''}
                    {addr.internal && <span style={{ color: '#7f8c8d', marginLeft: '8px' }}>(内部)</span>}
                    <button
                      className="btn btn-secondary"
                      onClick={() => copyToClipboard(addr.address)}
                      style={{ marginLeft: '10px', padding: '2px 8px', fontSize: '12px' }}
                    >
                      复制
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {(deviceInfo.route || (deviceInfo.dns || []).length > 0) && (
          <div className="info-section">
            <h3>🛣️ 路由与 DNS</h3>
            <div className="info-item">
              <strong>默认网关:</strong>
              <span>{deviceInfo.route?.gateway || '未知'}</span>
            </div>
            <div className="info-item">
              <strong>默认网卡:</strong>
              <span>{deviceInfo.route?.interface || '未知'}</span>
            </div>
            <div className="info-item">
              <strong>DNS:</strong>
              <span>{(deviceInfo.dns || []).join(', ') || '未知'}</span>
            </div>
          </div>
        )}

        {Array.isArray(deviceInfo.disks) && deviceInfo.disks.length > 0 && (
          <div className="info-section">
            <h3>🖴 磁盘</h3>
            {deviceInfo.disks.map((disk) => (
              <div key={`${disk.mount}-${disk.filesystem}`} className="info-item">
                <strong>{disk.mount}</strong>
                <span>
                  {formatBytes(disk.used)} / {formatBytes(disk.total)} 已用（可用 {formatBytes(disk.available)}，{disk.usagePercent}）
                  {disk.filesystem ? ` · ${disk.filesystem}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {Array.isArray(deviceInfo.displays) && deviceInfo.displays.length > 0 && (
          <div className="info-section">
            <h3>🖥️ 显示器</h3>
            {deviceInfo.displays.map((display) => (
              <div key={display.id} className="info-item">
                <strong>{display.label}</strong>
                <span>
                  {display.size} · 缩放 {display.scaleFactor}x
                  {display.internal ? ' · 内置' : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Node.js 信息 */}
        <div className="info-section">
          <h3>🟢 Node.js 信息</h3>
          <div className="info-item">
            <strong>Node 版本:</strong>
            <span>{deviceInfo.node.version}</span>
          </div>
          <div className="info-item">
            <strong>V8 引擎版本:</strong>
            <span>{deviceInfo.node.v8}</span>
          </div>
          <div className="info-item">
            <strong>Electron:</strong>
            <span>{deviceInfo.node.electron || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>Chrome:</strong>
            <span>{deviceInfo.node.chrome || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>可执行文件:</strong>
            <span style={{ fontSize: '12px', wordBreak: 'break-all' }}>{deviceInfo.node.execPath || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>进程内存使用:</strong>
            <span>
              {formatBytes(deviceInfo.node.memoryUsage.heapUsed)} / {formatBytes(deviceInfo.node.memoryUsage.heapTotal)}
            </span>
          </div>
          <div className="info-item">
            <strong>外部内存:</strong>
            <span>{formatBytes(deviceInfo.node.memoryUsage.external)}</span>
          </div>
        </div>

        {/* 环境信息 */}
        <div className="info-section">
          <h3>🔧 环境信息</h3>
          <div className="info-item">
            <strong>HOME 目录:</strong>
            <span>{deviceInfo.env.HOME || deviceInfo.env.USERPROFILE || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>临时目录:</strong>
            <span>{deviceInfo.env.TMPDIR || deviceInfo.env.TEMP || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>Shell:</strong>
            <span>{deviceInfo.env.SHELL || deviceInfo.env.ComSpec || 'N/A'}</span>
          </div>
          <div className="info-item">
            <strong>PATH:</strong>
            <span style={{ fontSize: '12px', wordBreak: 'break-all' }}>
              {deviceInfo.env.PATH || 'N/A'}
            </span>
          </div>
          <div className="info-item">
            <strong>JAVA_HOME:</strong>
            <span>{deviceInfo.env.JAVA_HOME || '未设置'}</span>
          </div>
          <div className="info-item">
            <strong>ANDROID_HOME:</strong>
            <span>{deviceInfo.env.ANDROID_HOME || '未设置'}</span>
          </div>
        </div>
      </div>

      <div className="message info" style={{ marginTop: '20px' }}>
        <strong>提示：</strong>
        本机信息完全在本地读取，不会上传到任何服务器。点击"导出报告"可保存为文本文件。
      </div>
    </div>
  );
}

export default DeviceInfo;
