import React, { useState } from 'react';

function ModifyHash() {
  const [files, setFiles] = useState([]);
  const [mode, setMode] = useState('single'); // 'single' or 'batch'
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  const selectFiles = async () => {
    if (mode === 'single') {
      const path = await window.electronAPI.selectFile();
      if (path) {
        setFiles([path]);
        setMessage(null);
        setResults([]);
      }
    } else {
      const paths = await window.electronAPI.selectMultipleFiles();
      if (paths && paths.length > 0) {
        setFiles(paths);
        setMessage(null);
        setResults([]);
      }
    }
  };

  const selectDirectory = async () => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setLoading(true);
      try {
        const fileList = await window.electronAPI.getFilesInDirectory(path);
        setFiles(fileList);
        setMessage({ type: 'info', text: `找到 ${fileList.length} 个文件` });
        setResults([]);
      } catch (error) {
        setMessage({ type: 'error', text: error.message });
      } finally {
        setLoading(false);
      }
    }
  };

  const removeFile = (index) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const modifyHash = async () => {
    if (files.length === 0) {
      setMessage({ type: 'error', text: '请先选择文件' });
      return;
    }

    setLoading(true);
    setMessage(null);
    setResults([]);

    try {
      const results = await window.electronAPI.modifyFileHash(files);
      setResults(results);
      
      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;
      
      if (failCount === 0) {
        setMessage({ 
          type: 'success', 
          text: `成功修改 ${successCount} 个文件的 Hash 值` 
        });
      } else {
        setMessage({ 
          type: 'error', 
          text: `成功 ${successCount} 个，失败 ${failCount} 个` 
        });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const getHashInfo = async () => {
    if (files.length === 0) {
      setMessage({ type: 'error', text: '请先选择文件' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const results = await window.electronAPI.getFileHash(files);
      setResults(results);
      setMessage({ type: 'success', text: `已获取 ${results.length} 个文件的 Hash 信息` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="content-card">
      <h2>修改文件 Hash 值</h2>

      <div className="form-group">
        <label>操作模式</label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <input
              type="radio"
              value="single"
              checked={mode === 'single'}
              onChange={(e) => {
                setMode(e.target.value);
                setFiles([]);
                setResults([]);
              }}
            />
            单个文件
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <input
              type="radio"
              value="batch"
              checked={mode === 'batch'}
              onChange={(e) => {
                setMode(e.target.value);
                setFiles([]);
                setResults([]);
              }}
            />
            批量文件
          </label>
        </div>
      </div>

      <div className="form-group">
        <label>选择文件</label>
        <div className="file-input-group">
          <button className="btn btn-secondary" onClick={selectFiles}>
            {mode === 'single' ? '选择文件' : '选择多个文件'}
          </button>
          {mode === 'batch' && (
            <button className="btn btn-secondary" onClick={selectDirectory}>
              选择文件夹
            </button>
          )}
        </div>
        {files.length > 0 && (
          <div style={{ marginTop: '10px', fontSize: '14px', color: '#7f8c8d' }}>
            已选择 {files.length} 个文件
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="form-group">
          <label>文件列表</label>
          <div style={{ 
            maxHeight: '200px', 
            overflow: 'auto', 
            border: '1px solid #ddd', 
            borderRadius: '6px',
            padding: '10px'
          }}>
            {files.map((file, index) => (
              <div key={file} style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '8px',
                borderBottom: index < files.length - 1 ? '1px solid #eee' : 'none'
              }}>
                <span style={{ fontSize: '13px', wordBreak: 'break-all', flex: 1 }}>
                  {file}
                </span>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => removeFile(index)}
                  style={{ padding: '4px 10px', fontSize: '12px', marginLeft: '10px' }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="action-buttons">
        <button
          className="btn btn-primary"
          onClick={modifyHash}
          disabled={loading || files.length === 0}
        >
          {loading ? '修改中...' : '修改 Hash 值'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={getHashInfo}
          disabled={loading || files.length === 0}
        >
          {loading ? '获取中...' : '查看当前 Hash'}
        </button>
      </div>

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      {results.length > 0 && (
        <div className="info-display">
          <div className="info-section">
            <h3>处理结果</h3>
            {results.map((result, index) => (
              <div key={result.filename ?? index} style={{ 
                marginBottom: '15px', 
                padding: '10px',
                background: result.success ? '#d4edda' : '#f8d7da',
                borderRadius: '4px'
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '5px', fontSize: '13px' }}>
                  {result.filename}
                </div>
                {result.success ? (
                  <>
                    {result.oldMd5 && (
                      <div style={{ fontSize: '12px', marginBottom: '3px' }}>
                        <strong>原 MD5:</strong> {result.oldMd5}
                      </div>
                    )}
                    {result.newMd5 && (
                      <div style={{ fontSize: '12px', marginBottom: '3px' }}>
                        <strong>新 MD5:</strong> {result.newMd5}
                      </div>
                    )}
                    {result.md5 && (
                      <div style={{ fontSize: '12px', marginBottom: '3px' }}>
                        <strong>MD5:</strong> {result.md5}
                      </div>
                    )}
                    {result.sha1 && (
                      <div style={{ fontSize: '12px', marginBottom: '3px' }}>
                        <strong>SHA1:</strong> {result.sha1}
                      </div>
                    )}
                    {result.sha256 && (
                      <div style={{ fontSize: '12px' }}>
                        <strong>SHA256:</strong> {result.sha256}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: '12px', color: '#721c24' }}>
                    错误: {result.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="message info" style={{ marginTop: '20px' }}>
        <strong>功能说明：</strong>
        <ul style={{ marginTop: '8px', marginLeft: '20px' }}>
          <li>修改 Hash 值：在文件末尾添加随机字节，改变文件的 MD5/SHA1/SHA256 值</li>
          <li>查看当前 Hash：显示文件的 MD5、SHA1、SHA256 值</li>
          <li>单个文件：选择一个文件进行操作</li>
          <li>批量文件：选择多个文件或整个文件夹批量操作</li>
          <li>注意：修改后文件内容会发生变化，请提前备份</li>
        </ul>
      </div>
    </div>
  );
}

export default ModifyHash;
