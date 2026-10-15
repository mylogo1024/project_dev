import React, { useState } from 'react';

function XmindViewer() {
  const [xmindFile, setXmindFile] = useState(null);
  const [mindmapData, setMindmapData] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  const selectXmindFile = async () => {
    try {
      const path = await window.electronAPI.selectXmindFile();
      if (path) {
        setXmindFile(path);
        setMessage(null);
        loadXmindFile(path);
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const loadXmindFile = async (path) => {
    setLoading(true);
    try {
      const data = await window.electronAPI.parseXmindFile(path);
      setMindmapData(data);
      setMessage({ type: 'success', text: 'XMind 文件加载成功' });
    } catch (error) {
      setMessage({ type: 'error', text: `加载失败: ${error.message}` });
      setMindmapData(null);
    } finally {
      setLoading(false);
    }
  };

  const renderNode = (node, level = 0) => {
    if (!node) return null;

    const indent = level * 30;
    const colors = ['#3498db', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6'];
    const color = colors[level % colors.length];

    return (
      <div key={node.id || Math.random()} style={{ marginLeft: `${indent}px`, marginTop: '10px' }}>
        <div
          style={{
            padding: '10px 15px',
            background: level === 0 ? color : '#f8f9fa',
            border: `2px solid ${color}`,
            borderRadius: '8px',
            display: 'inline-block',
            fontSize: level === 0 ? '18px' : '14px',
            fontWeight: level === 0 ? 'bold' : 'normal',
            color: level === 0 ? '#fff' : '#2c3e50',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            maxWidth: '600px',
            wordWrap: 'break-word'
          }}
        >
          {node.title || node.text || '(无标题)'}
        </div>
        {node.children && node.children.length > 0 && (
          <div style={{ marginTop: '10px' }}>
            {node.children.map((child, index) => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const exportAsText = async () => {
    if (!mindmapData) {
      setMessage({ type: 'error', text: '没有可导出的数据' });
      return;
    }

    try {
      const textContent = generateTextFromNode(mindmapData, 0);
      await window.electronAPI.exportMindmapText(textContent);
      setMessage({ type: 'success', text: '导出成功' });
    } catch (error) {
      setMessage({ type: 'error', text: `导出失败: ${error.message}` });
    }
  };

  const generateTextFromNode = (node, level) => {
    if (!node) return '';
    
    const indent = '  '.repeat(level);
    const prefix = level === 0 ? '# ' : '- ';
    let text = `${indent}${prefix}${node.title || node.text || '(无标题)'}\n`;
    
    if (node.children && node.children.length > 0) {
      node.children.forEach(child => {
        text += generateTextFromNode(child, level + 1);
      });
    }
    
    return text;
  };

  const createSampleMindmap = () => {
    const sample = {
      id: 'root',
      title: '日常开发工具箱',
      children: [
        {
          id: '1',
          title: 'APK 工具',
          children: [
            { id: '1-1', title: '安装 APK' },
            { id: '1-2', title: '反编译 APK' },
            { id: '1-3', title: '读取信息' },
            { id: '1-4', title: 'APK 签名' }
          ]
        },
        {
          id: '2',
          title: '文件工具',
          children: [
            { id: '2-1', title: '修改 Hash 值' },
            { id: '2-2', title: 'JSON 格式化' }
          ]
        },
        {
          id: '3',
          title: '编辑器',
          children: [
            { id: '3-1', title: 'Markdown 编辑器' },
            { id: '3-2', title: 'XMind 预览器' }
          ]
        }
      ]
    };
    
    setMindmapData(sample);
    setMessage({ type: 'info', text: '已加载示例思维导图' });
  };

  return (
    <div className="content-card">
      <h2>XMind 预览器</h2>

      <div className="form-group">
        <label>选择 XMind 文件</label>
        <div className="file-input-group">
          <input
            type="text"
            value={xmindFile || ''}
            readOnly
            placeholder="请选择 XMind 文件 (.xmind)"
          />
          <button className="btn btn-secondary" onClick={selectXmindFile}>
            浏览
          </button>
        </div>
      </div>

      <div className="action-buttons">
        <button className="btn btn-secondary" onClick={createSampleMindmap}>
          查看示例
        </button>
        {mindmapData && (
          <button className="btn btn-primary" onClick={exportAsText}>
            导出为文本
          </button>
        )}
      </div>

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      {loading && (
        <div className="loading">正在加载思维导图...</div>
      )}

      {mindmapData && !loading && (
        <div style={{
          marginTop: '20px',
          padding: '20px',
          background: '#fff',
          border: '1px solid #ddd',
          borderRadius: '8px',
          maxHeight: '600px',
          overflow: 'auto'
        }}>
          {renderNode(mindmapData)}
        </div>
      )}

      <div className="message info" style={{ marginTop: '20px' }}>
        <strong>功能说明：</strong>
        <ul style={{ marginTop: '8px', marginLeft: '20px' }}>
          <li>支持预览 XMind 思维导图文件</li>
          <li>树状展示思维导图节点结构</li>
          <li>支持导出为文本格式</li>
          <li>不同层级使用不同颜色标识</li>
          <li>点击 "查看示例" 体验功能</li>
        </ul>
      </div>

      <div className="message info" style={{ marginTop: '10px' }}>
        <strong>注意：</strong>
        XMind 文件解析需要额外的依赖库。当前版本提供基础的树状预览功能。
        完整的 XMind 解析功能需要安装 <code>jszip</code> 和 <code>xml2js</code> 库。
      </div>
    </div>
  );
}

export default XmindViewer;
