import React, { useEffect, useState } from 'react';
import PlainSecretField from './PlainSecretField';
import { cleanIpcError } from '../lib/errorText';

function Settings({ config, onSave }) {
  const [keystorePath, setKeystorePath] = useState(config.keystorePath || '');
  const [alias, setAlias] = useState(config.alias ?? 'csgame');
  const [password, setPassword] = useState(config.password ?? '123');
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setKeystorePath(config.keystorePath || '');
    setAlias(config.alias ?? 'csgame');
    setPassword(config.password ?? '123');
  }, [config.keystorePath, config.alias, config.password]);

  const selectKeystore = async () => {
    const nextPath = await window.electronAPI.selectKeystore();
    if (nextPath) setKeystorePath(nextPath);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await onSave({
        keystorePath,
        alias: alias.trim() || 'csgame',
        password
      });
      setMessage({ type: 'success', text: '配置保存成功' });
    } catch (error) {
      setMessage({ type: 'error', text: `配置保存失败: ${cleanIpcError(error)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="content-card">
      <h2>全局配置</h2>

      <div className="form-group">
        <label>默认签名文件</label>
        <div className="file-input-group">
          <input
            type="text"
            value={keystorePath}
            onChange={(e) => setKeystorePath(e.target.value)}
            placeholder="请选择默认签名文件"
          />
          <button type="button" className="btn btn-secondary" onClick={selectKeystore}>浏览</button>
        </div>
      </div>

      <div className="form-group">
        <label>默认别名</label>
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="csgame"
        />
      </div>

      <PlainSecretField
        id="settings-keystore-secret"
        label="默认密码（明文，可直接修改）"
        value={password}
        onChange={setPassword}
        placeholder="请输入密码"
      />

      <div className="action-buttons">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}

export default Settings;
