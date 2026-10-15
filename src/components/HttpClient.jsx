import React, { useMemo, useState } from 'react';
import SplitPane from './SplitPane';
import { buildFullUrl, parseQueryString, splitUrlQuery, tidyParamRows } from '../lib/httpUrl';
import { copyTextWithToast } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const BODY_TYPES = [
  { id: 'none', name: '无 Body' },
  { id: 'json', name: 'JSON' },
  { id: 'form', name: 'x-www-form-urlencoded' },
  { id: 'raw', name: 'Raw' }
];

const newRow = () => ({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, enabled: true, key: '', value: '' });

function rowsToObject(rows) {
  const result = {};
  for (const row of rows) {
    if (!row.enabled || !row.key.trim()) continue;
    result[row.key.trim()] = row.value;
  }
  return result;
}

function KeyValueEditor({ rows, onChange, keyPlaceholder, valuePlaceholder }) {
  const updateRow = (id, patch) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div className="http-kv">
      {rows.map((row) => (
        <div key={row.id} className="http-kv-row">
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(event) => updateRow(row.id, { enabled: event.target.checked })}
          />
          <input
            type="text"
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(event) => updateRow(row.id, { key: event.target.value })}
          />
          <input
            type="text"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(event) => updateRow(row.id, { value: event.target.value })}
          />
          <button className="text-mini-btn" onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>删除</button>
        </div>
      ))}
      <button className="btn btn-secondary http-add-row" onClick={() => onChange([...rows, newRow()])}>添加一行</button>
    </div>
  );
}

function HttpClient() {
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('https://httpbin.org/get');
  const [tab, setTab] = useState('params');
  const [params, setParams] = useState([newRow()]);
  const [headers, setHeaders] = useState([
    { ...newRow(), key: 'Content-Type', value: 'application/json' }
  ]);
  const [bodyType, setBodyType] = useState('json');
  const [rawBody, setRawBody] = useState('{\n  "ok": true\n}');
  const [formRows, setFormRows] = useState([newRow()]);
  const [paramPaste, setParamPaste] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [response, setResponse] = useState(null);
  const [responseBody, setResponseBody] = useState('');

  const canSendBody = method !== 'GET' && method !== 'HEAD';

  // 后端是把 params 追加到 URL 的 query 上的，这里用同一套逻辑算出最终地址，
  // 让用户在发出去之前就能看到到底请求的是什么
  const finalUrl = useMemo(() => buildFullUrl(url, params), [url, params]);

  /** 把一段 query / 整条 URL 拆成参数行，追加到已有参数后面。 */
  const appendParams = (text) => {
    const parsed = parseQueryString(text);
    if (!parsed.length) return 0;
    setParams((rows) => [
      ...rows.filter((row) => row.key.trim()),
      ...parsed.map((pair) => ({ ...newRow(), ...pair }))
    ]);
    return parsed.length;
  };

  /**
   * URL 里带了 `?a=1` 时自动把它拆到参数表里，URL 只留 base。
   * 这样最终地址不变（发送时会拼回去），但参数可以逐行改、逐行禁用。
   * 用 splitUrlQuery 已经拆好的结果，别拿整条 URL 再解析一遍（会把 fragment 当成参数值）。
   */
  const absorbUrlQuery = (rawUrl) => {
    const { base, params: parsed, hasQuery } = splitUrlQuery(rawUrl);
    if (!hasQuery || !parsed.length) return false;
    setUrl(base);
    setParams((rows) => [
      ...rows.filter((row) => row.key.trim()),
      ...parsed.map((pair) => ({ ...newRow(), ...pair }))
    ]);
    setTab('params');
    return true;
  };

  const applyPastedParams = () => {
    const count = appendParams(paramPaste);
    if (!count) {
      setError('没解析出参数，检查一下格式（应形如 a=1&b=2）');
      return;
    }
    setError('');
    setParamPaste('');
  };

  const requestBody = useMemo(() => {
    if (!canSendBody || bodyType === 'none') return '';
    if (bodyType === 'form') {
      const search = new URLSearchParams();
      Object.entries(rowsToObject(formRows)).forEach(([key, value]) => search.append(key, value));
      return search.toString();
    }
    return rawBody;
  }, [bodyType, canSendBody, formRows, rawBody]);

  const sendRequest = async () => {
    setLoading(true);
    setError('');
    try {
      const headerRows = headers.map((row) => ({ ...row }));
      if (canSendBody && bodyType === 'json') {
        const hasContentType = headerRows.some((row) => row.enabled && row.key.toLowerCase() === 'content-type');
        if (!hasContentType) {
          headerRows.push({ ...newRow(), key: 'Content-Type', value: 'application/json' });
        }
      }
      if (canSendBody && bodyType === 'form') {
        const index = headerRows.findIndex((row) => row.key.toLowerCase() === 'content-type');
        const formHeader = { ...newRow(), key: 'Content-Type', value: 'application/x-www-form-urlencoded' };
        if (index >= 0) headerRows[index] = { ...headerRows[index], ...formHeader, enabled: true };
        else headerRows.push(formHeader);
      }

      const result = await window.electronAPI.httpRequest({
        method,
        url,
        params,
        headers: headerRows,
        body: requestBody,
        timeout: 30000
      });
      setResponse(result);
      let pretty = result.body || '';
      try {
        pretty = JSON.stringify(JSON.parse(pretty), null, 2);
      } catch (_) { /* 响应体不是 JSON（纯文本 / HTML），保持原样展示 */ }
      setResponseBody(pretty);
    } catch (requestError) {
      setResponse(null);
      setResponseBody('');
      setError(cleanIpcError(requestError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="content-card http-page">
      <div className="http-urlbar">
        <select value={method} onChange={(event) => setMethod(event.target.value)} className={`http-method is-${method.toLowerCase()}`}>
          {METHODS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <input
          className="http-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/api"
          spellCheck={false}
          onPaste={(event) => {
            const pasted = event.clipboardData?.getData('text') || '';
            if (!pasted.includes('?')) return;
            // 整条带参数的 URL 粘进来时，直接把参数拆到表里
            event.preventDefault();
            setUrl(pasted.trim());
            absorbUrlQuery(pasted.trim());
          }}
          onBlur={() => absorbUrlQuery(url)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && url.trim() && !loading) sendRequest();
          }}
        />
        <button className="btn btn-primary" onClick={sendRequest} disabled={loading || !url.trim()}>
          {loading ? '发送中…' : '发送'}
        </button>
      </div>

      <div className="http-body">
        <SplitPane direction="vertical" initial={42}>
        <section className="http-request">
          <div className="http-tabs">
            {[
              ['params', 'Query 参数'],
              ['headers', '请求头'],
              ['body', '请求体']
            ].map(([id, label]) => (
              <button
                key={id}
                className={`text-tab ${tab === id ? 'is-active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="http-editor">
            {tab === 'params' && (
              <>
                <div className="http-params-tools">
                  <input
                    className="http-params-paste"
                    value={paramPaste}
                    onChange={(event) => setParamPaste(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applyPastedParams();
                      }
                    }}
                    placeholder="粘贴 a=1&b=2 或整条 URL，回车拆成下面的行"
                    spellCheck={false}
                  />
                  <button className="text-mini-btn" onClick={applyPastedParams} disabled={!paramPaste.trim()}>解析</button>
                  <button
                    className="text-mini-btn"
                    onClick={() => setParams((rows) => tidyParamRows(rows))}
                    disabled={!params.some((row) => row.key.trim())}
                  >
                    整理
                  </button>
                  <button
                    className="text-mini-btn"
                    onClick={() => setParams((rows) => tidyParamRows(rows, { sort: true }))}
                    disabled={!params.some((row) => row.key.trim())}
                  >
                    按 key 排序
                  </button>
                </div>
                <KeyValueEditor rows={params} onChange={setParams} keyPlaceholder="参数名" valuePlaceholder="参数值" />
                <div className="http-params-preview">
                  <span className="http-params-preview__label">最终请求 URL</span>
                  <code>{finalUrl || '填写 URL 后显示'}</code>
                </div>
              </>
            )}
            {tab === 'headers' && (
              <KeyValueEditor rows={headers} onChange={setHeaders} keyPlaceholder="Header" valuePlaceholder="Value" />
            )}
            {tab === 'body' && (
              <div className="http-body-editor">
                <div className="http-body-types">
                  {BODY_TYPES.map((item) => (
                    <label key={item.id}>
                      <input
                        type="radio"
                        name="body-type"
                        checked={bodyType === item.id}
                        onChange={() => setBodyType(item.id)}
                        disabled={!canSendBody && item.id !== 'none'}
                      />
                      {item.name}
                    </label>
                  ))}
                </div>
                {!canSendBody && <div className="http-hint">GET / HEAD 不发送 Body，参数请写在 Query 中。</div>}
                {canSendBody && bodyType === 'form' && (
                  <KeyValueEditor rows={formRows} onChange={setFormRows} keyPlaceholder="字段名" valuePlaceholder="字段值" />
                )}
                {canSendBody && (bodyType === 'json' || bodyType === 'raw') && (
                  <textarea
                    className="text-area"
                    value={rawBody}
                    onChange={(event) => setRawBody(event.target.value)}
                    spellCheck={false}
                    placeholder={bodyType === 'json' ? '{ "key": "value" }' : '原始请求体'}
                  />
                )}
              </div>
            )}
          </div>
        </section>

        <section className="http-response">
          <div className="http-response-head">
            <strong>返回内容（可直接编辑）</strong>
            {response && (
              <span className={`http-status is-${response.ok ? 'ok' : 'bad'}`}>
                {response.status} {response.statusText} · {response.durationMs}ms
              </span>
            )}
            <button className="text-mini-btn" onClick={() => copyTextWithToast(responseBody, { successText: '返回内容已复制' })} disabled={!responseBody}>
              复制
            </button>
          </div>
          {error && <div className="message error">{error}</div>}
          {response && (
            <details className="http-response-headers">
              <summary>响应头</summary>
              <pre>{Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}</pre>
            </details>
          )}
          <textarea
            className="text-area http-response-body"
            value={responseBody}
            onChange={(event) => setResponseBody(event.target.value)}
            placeholder="发送请求后，返回内容会显示在这里，可直接编辑"
            spellCheck={false}
          />
        </section>
        </SplitPane>
      </div>
    </div>
  );
}

export default HttpClient;
