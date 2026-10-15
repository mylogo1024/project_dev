import React, { useState } from 'react';
import { toastWarning, toastError, toastSuccess } from '../lib/toastStore';
import { copyTextWithToast } from '../lib/clipboard.js';

function QRCode() {
  const [text, setText] = useState('');
  const [qrCodeData, setQrCodeData] = useState('');
  const [size, setSize] = useState(256);
  const [errorLevel, setErrorLevel] = useState('M');
  const [shareInfo, setShareInfo] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const generateQRCode = async (content = text) => {
    const payload = String(content ?? '').trim();
    if (!payload) {
      toastWarning('请输入要生成二维码的内容');
      return;
    }

    try {
      const result = await window.electronAPI.generateQRCode(payload, size, errorLevel);
      setQrCodeData(result);
    } catch (error) {
      toastError('生成二维码失败: ' + error.message);
    }
  };

  const downloadQRCode = async () => {
    if (!qrCodeData) {
      toastWarning('请先生成二维码');
      return;
    }

    try {
      await window.electronAPI.downloadQRCode(qrCodeData);
      toastSuccess('二维码已保存');
    } catch (error) {
      toastError('保存失败: ' + error.message);
    }
  };

  const parseQRCode = async () => {
    try {
      const result = await window.electronAPI.parseQRCode();
      if (result) {
        setText(result);
        setShareInfo(null);
        toastSuccess('二维码解析成功');
      }
    } catch (error) {
      toastError('解析失败: ' + error.message);
    }
  };

  const shareFile = async (filePath) => {
    if (!filePath || sharing) return;
    setSharing(true);
    try {
      const result = await window.electronAPI.shareQrLanFile(filePath);
      setText(result.url);
      setShareInfo(result);
      await generateQRCode(result.url);
      toastSuccess(`已生成下载二维码：${result.fileName}`);
    } catch (error) {
      toastError('生成下载二维码失败', error.message);
    } finally {
      setSharing(false);
    }
  };

  const pickShareFile = async () => {
    const filePath = await window.electronAPI.selectFile();
    if (filePath) await shareFile(filePath);
  };

  const onDragOver = (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer?.files || []);
    const filePath = files.map((file) => file.path).find(Boolean);
    if (!filePath) {
      toastWarning('请拖入一个本机文件');
      return;
    }
    shareFile(filePath);
  };

  const quickFill = (template) => {
    const templates = {
      url: 'https://github.com',
      wifi: 'WIFI:T:WPA;S:网络名称;P:密码;;',
      phone: 'tel:13800138000',
      email: 'mailto:example@example.com',
      sms: 'smsto:13800138000:短信内容',
      vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:张三\nTEL:13800138000\nEMAIL:zhangsan@example.com\nEND:VCARD'
    };
    setShareInfo(null);
    setText(templates[template] || '');
  };

  return (
    <div className="content-card">
      <h2>二维码工具</h2>

      <div
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{
          marginBottom: '20px',
          padding: '18px 16px',
          borderRadius: '10px',
          border: `1.5px dashed ${dragOver ? '#667eea' : '#c5cde0'}`,
          background: dragOver ? 'rgba(102, 126, 234, 0.08)' : '#f8f9fc',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap'
        }}
      >
        <div>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {sharing ? '正在生成下载二维码…' : '拖入文件，生成内网下载二维码'}
          </div>
          <div style={{ fontSize: '13px', color: '#636e72' }}>
            同一局域网内扫码即可直接下载，不必再拷到手机
          </div>
        </div>
        <button className="btn btn-secondary" onClick={pickShareFile} disabled={sharing}>
          选择文件
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
        {/* 生成二维码 */}
        <div>
          <h3 style={{ marginBottom: '16px', fontSize: '16px' }}>生成二维码</h3>
          
          <div className="form-group">
            <label>输入内容：</label>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setShareInfo(null);
              }}
              placeholder="请输入文本、URL、WiFi 信息等，或把文件拖到上方…"
              style={{
                width: '100%',
                height: '120px',
                padding: '10px',
                border: '1px solid #dfe6e9',
                borderRadius: '6px',
                fontSize: '14px',
                resize: 'vertical'
              }}
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>
              快速填充：
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => quickFill('url')} style={{ padding: '6px 12px', fontSize: '13px' }}>
                网址
              </button>
              <button className="btn btn-secondary" onClick={() => quickFill('wifi')} style={{ padding: '6px 12px', fontSize: '13px' }}>
                WiFi
              </button>
              <button className="btn btn-secondary" onClick={() => quickFill('phone')} style={{ padding: '6px 12px', fontSize: '13px' }}>
                电话
              </button>
              <button className="btn btn-secondary" onClick={() => quickFill('email')} style={{ padding: '6px 12px', fontSize: '13px' }}>
                邮箱
              </button>
              <button className="btn btn-secondary" onClick={() => quickFill('sms')} style={{ padding: '6px 12px', fontSize: '13px' }}>
                短信
              </button>
              <button className="btn btn-secondary" onClick={() => quickFill('vcard')} style={{ padding: '6px 12px', fontSize: '13px' }}>
                名片
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>尺寸：{size}px</label>
            <input
              type="range"
              min="128"
              max="512"
              step="64"
              value={size}
              onChange={(e) => setSize(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>

          <div className="form-group">
            <label>纠错级别：</label>
            <select value={errorLevel} onChange={(e) => setErrorLevel(e.target.value)}>
              <option value="L">L (低 7%)</option>
              <option value="M">M (中 15%)</option>
              <option value="Q">Q (较高 25%)</option>
              <option value="H">H (高 30%)</option>
            </select>
          </div>

          <div className="action-buttons">
            <button className="btn btn-primary" onClick={() => generateQRCode()}>
              生成二维码
            </button>
          </div>
        </div>

        {/* 二维码预览 */}
        <div>
          <h3 style={{ marginBottom: '16px', fontSize: '16px' }}>二维码预览</h3>
          
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '300px',
            background: '#f8f9fa',
            borderRadius: '8px',
            padding: '20px'
          }}>
            {qrCodeData ? (
              <img src={qrCodeData} alt="QR Code" style={{ maxWidth: '100%' }} />
            ) : (
              <div style={{ textAlign: 'center', color: '#7f8c8d' }}>
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>📱</div>
                <div>请输入内容并生成二维码</div>
              </div>
            )}
          </div>

          {shareInfo ? (
            <div style={{
              marginTop: '16px',
              padding: '12px 14px',
              background: '#f0f4ff',
              borderRadius: '8px',
              fontSize: '13px',
              lineHeight: 1.5
            }}>
              <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                内网下载：{shareInfo.fileName}
              </div>
              {(shareInfo.urls || [shareInfo.url]).filter(Boolean).map((item) => (
                <div key={item} style={{ wordBreak: 'break-all', color: '#2d3436', marginBottom: '8px' }}>
                  {item}
                </div>
              ))}
              <button
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '13px' }}
                onClick={() => copyTextWithToast(shareInfo.url, { successText: '下载地址已复制' })}
              >
                复制下载地址
              </button>
            </div>
          ) : null}

          <div className="action-buttons" style={{ marginTop: '16px' }}>
            <button className="btn btn-primary" onClick={downloadQRCode} disabled={!qrCodeData}>
              保存二维码
            </button>
            <button className="btn btn-secondary" onClick={parseQRCode}>
              解析二维码图片
            </button>
          </div>
        </div>
      </div>

      <div className="message info" style={{ marginTop: '20px' }}>
        <strong>使用说明：</strong>
        <ul style={{ marginTop: '8px', paddingLeft: '20px' }}>
          <li><strong>内网下载：</strong>把文件拖到上方区域，或点「选择文件」，会自动启动局域网文件服务并生成下载二维码。手机连同一 Wi‑Fi 后扫码即可下载</li>
          <li><strong>生成：</strong>输入文本后点击"生成二维码"，支持 URL、文本、WiFi、电话、邮箱等</li>
          <li><strong>纠错级别：</strong>级别越高，容错能力越强，但二维码越复杂</li>
          <li><strong>解析：</strong>点击"解析二维码图片"选择图片文件进行识别</li>
          <li><strong>WiFi 格式：</strong>WIFI:T:WPA;S:网络名;P:密码;;</li>
        </ul>
      </div>
    </div>
  );
}

export default QRCode;
