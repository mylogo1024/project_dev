import React, { useCallback, useState } from 'react';
import { copyTextWithToast } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

const SCOPES = [
  { id: 'all', name: '类名 + 字符串' },
  { id: 'class', name: '仅类名' },
  { id: 'string', name: '仅字符串' }
];

/**
 * DEX 代码检索：在 APK / AAB 的 DEX 里搜类名与字符串。
 *
 * 逆向时最高频的两个问题是「这个功能在哪个类」和「这个密钥 / URL 硬编码在哪」。
 * 前者靠类名搜索，后者靠字符串搜索 —— 现有分析只把类名用来算混淆率，答不了这两个问题。
 */
function CodeSearch() {
  const [packagePath, setPackagePath] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pickPackage = async () => {
    setError('');
    try {
      const filePath = await window.electronAPI.selectFiles({
        filters: [{ name: '安装包', extensions: ['apk', 'aab'] }]
      });
      if (!filePath) return;
      setPackagePath(filePath);
      setResult(null);
    } catch (pickError) {
      setError(cleanIpcError(pickError, '选择文件失败'));
    }
  };

  const runSearch = useCallback(async (nextQuery, nextScope) => {
    if (!packagePath) {
      setError('先选一个 APK / AAB');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await window.electronAPI.searchPackageSymbols({
        path: packagePath,
        query: nextQuery ?? query,
        scope: nextScope ?? scope
      });
      setResult(data);
    } catch (searchError) {
      setResult(null);
      setError(cleanIpcError(searchError, '检索失败'));
    } finally {
      setBusy(false);
    }
  }, [packagePath, query, scope]);

  const browsePackages = () => {
    setQuery('');
    runSearch('', 'class');
  };

  const summary = result
    ? `${result.totals.dex_files} 个 DEX · ${result.totals.classes.toLocaleString('zh-CN')} 个类 · ${result.totals.strings.toLocaleString('zh-CN')} 个字符串`
    : '';

  return (
    <div className="content-card code-search-page">
      <div className="code-search-bar">
        <button className="btn btn-secondary" onClick={pickPackage}>选择包体</button>
        <span className={`code-search-path ${packagePath ? '' : 'is-empty'}`} title={packagePath}>
          {packagePath || '未选择（支持 APK / AAB，IPA 不含 DEX）'}
        </span>
      </div>

      <div className="code-search-bar">
        <input
          className="code-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') runSearch(); }}
          placeholder="搜类名（如 Login、okhttp3）或字符串（如 https://、api_key、AES）"
          spellCheck={false}
        />
        <select className="code-search-select" value={scope} onChange={(event) => setScope(event.target.value)}>
          {SCOPES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="btn btn-primary" onClick={() => runSearch()} disabled={busy || !packagePath}>
          {busy ? '检索中…' : '搜索'}
        </button>
        <button className="btn btn-secondary" onClick={browsePackages} disabled={busy || !packagePath}>
          看包结构
        </button>
      </div>

      {error && <div className="message error code-search-message">{error}</div>}

      {!result && !error && (
        <div className="code-search-empty">
          <p>选一个 APK / AAB，然后搜类名或字符串。</p>
          <p className="code-search-empty__sub">
            首次检索需要解压并遍历所有 DEX，会慢几秒；之后同一个包会走缓存，秒回。
          </p>
        </div>
      )}

      {result && (
        <div className="code-search-body">
          <div className="code-search-summary">
            <span>{summary}</span>
            {result.browsing && <span className="code-search-hint">未输入关键词，下面是包结构概览</span>}
          </div>

          {result.browsing && result.packages.length > 0 && (
            <div className="code-search-panel">
              <div className="code-search-panel__head">
                包结构（点一行可继续搜该包）
              </div>
              <div className="code-search-list">
                {result.packages.map((item) => (
                  <button
                    key={item.name}
                    className="code-search-row code-search-row--package"
                    onClick={() => { setQuery(item.name); runSearch(item.name, scope); }}
                  >
                    <span className="code-search-row__main">{item.name}</span>
                    <span className="code-search-row__meta">{item.count} 个类</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!result.browsing && (
            <div className="code-search-panel">
              <div className="code-search-panel__head">
                类名
                <span className="code-search-panel__count">
                  {result.classes_total === 0 ? '无匹配' : `${result.classes.length} / ${result.classes_total}`}
                  {result.classes_truncated ? '（已截断，缩小关键词更精确）' : ''}
                </span>
              </div>
              <div className="code-search-list">
                {result.classes.length === 0 && <div className="code-search-none">没有匹配的类</div>}
                {result.classes.map((item) => (
                  <div key={`${item.dex}-${item.descriptor || item.name}`} className="code-search-row">
                    <span className="code-search-row__main">{item.name}</span>
                    <span className="code-search-row__meta">{item.dex}</span>
                    <button
                      className="text-mini-btn"
                      onClick={() => copyTextWithToast(item.name, { successText: '类名已复制' })}
                      title="复制类名"
                    >
                      复制
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!result.browsing && result.strings && (
            <div className="code-search-panel">
              <div className="code-search-panel__head">
                字符串
                <span className="code-search-panel__count">
                  {result.strings_total === 0 ? '无匹配' : `${result.strings.length} / ${result.strings_total}`}
                  {result.strings_truncated ? '（已截断）' : ''}
                </span>
              </div>
              <div className="code-search-list">
                {result.strings.length === 0 && <div className="code-search-none">没有匹配的字符串</div>}
                {result.strings.map((item, index) => (
                  <div key={`${item.dex}-${index}-${item.value.slice(0, 24)}`} className="code-search-row">
                    <span className="code-search-row__main code-search-row__main--mono">{item.value}</span>
                    <span className="code-search-row__meta">{item.dex}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CodeSearch;
