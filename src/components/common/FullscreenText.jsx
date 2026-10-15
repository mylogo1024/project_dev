import React, { useEffect, useState } from 'react';
import { copyTextWithToast } from '../../lib/clipboard';

/**
 * 把一段长文本铺满整个窗口显示。
 *
 * 用途：格式化后的 JSON / 返回体动辄几百行，塞在 200px 高的输入框里只能看到一小截，
 * 只能靠来回滚动，很容易漏看。这里直接盖住整个应用窗口，Esc 关闭。
 */
function FullscreenText({ open, title = '内容', value = '', onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => { setCopied(false); }, [open, value]);

  if (!open) return null;

  const text = String(value ?? '');
  const lineCount = text ? text.split('\n').length : 0;

  const copyAll = async () => {
    const result = await copyTextWithToast(text);
    setCopied(result.ok);
  };

  return (
    <div className="fullscreen-text" role="dialog" aria-modal="true" aria-label={title}>
      <div className="fullscreen-text__head">
        <strong className="fullscreen-text__title">{title}</strong>
        <span className="fullscreen-text__meta">{lineCount} 行 · {text.length} 字符</span>
        <div className="fullscreen-text__actions">
          <button className="btn btn-secondary" onClick={copyAll} disabled={!text}>
            {copied ? '已复制' : '复制全部'}
          </button>
          <button className="btn btn-primary" onClick={onClose}>关闭（Esc）</button>
        </div>
      </div>
      <pre className="fullscreen-text__body">{text || '（空）'}</pre>
    </div>
  );
}

export default FullscreenText;
