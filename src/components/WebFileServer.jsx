import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toastInfo } from '../lib/toastStore';
import { copyText } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';

const EMPTY_STATUS = {
  state: 'stopped',
  rootPath: '',
  port: null,
  urls: [],
  tokenRequired: false,
  lastPort: null,
  lastAddress: null,
  recentRequests: []
};

const STATE_TEXT = {
  stopped: '已停止',
  starting: '正在启动',
  running: '运行中',
  stopping: '正在停止',
  error: '异常'
};

/**
 * 复制文本统一走 `lib/clipboard`：那里已经内置了
 * 「异步剪贴板 API → execCommand 兜底」两条路（这段经验就是从这里抽出去的），
 * 并且会如实返回成功/失败，不再由每个调用点自己实现一遍。
 */
const getApi = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

const getRootPath = (value) => {
  if (typeof value === 'string') return value;
  return value?.selectedRoot || value?.rootPath || value?.directory || value?.path || '';
};

const getUrls = (status) => {
  const rawUrls = status?.urls || status?.lanUrls || status?.addresses || [];
  const values = Array.isArray(rawUrls) ? rawUrls : Object.values(rawUrls || {});
  return [...new Set(values.map((item) => {
    if (typeof item === 'string') return item;
    return item?.url || item?.tokenizedUrl || item?.address || '';
  }).filter(Boolean))];
};

const normalizeStatus = (value, previous = EMPTY_STATUS) => {
  if (!value || typeof value !== 'object') return previous;
  const state = value.state || value.status || (value.running ? 'running' : 'stopped');
  return {
    ...previous,
    ...value,
    state,
    rootPath: getRootPath(value) || previous.rootPath || '',
    port: value.port ?? value.actualPort ?? previous.port ?? null,
    urls: getUrls(value)
  };
};

function WebFileServer() {
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [selectedUrl, setSelectedUrl] = useState('');
  const [qrCodeData, setQrCodeData] = useState('');
  const mountedRef = useRef(true);

  const applyStatus = useCallback((nextStatus) => {
    if (!mountedRef.current) return;
    setStatus((current) => normalizeStatus(nextStatus, current));
  }, []);

  const refreshStatus = useCallback(async ({ quiet = false } = {}) => {
    const api = getApi();
    if (typeof api?.getWebFileServerStatus !== 'function') {
      setLoading(false);
      setMessage({ type: 'error', text: '当前版本未提供局域网文件服务接口，请更新应用后重试。' });
      return;
    }

    if (!quiet) setLoading(true);
    try {
      const nextStatus = await api.getWebFileServerStatus();
      applyStatus(nextStatus);
      if (!quiet) setMessage(null);
    } catch (error) {
      if (mountedRef.current) {
        setMessage({ type: 'error', text: cleanIpcError(error, '刷新服务状态失败') });
      }
    } finally {
      if (mountedRef.current && !quiet) setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => {
    mountedRef.current = true;
    refreshStatus();

    const api = getApi();
    let unsubscribe;
    if (typeof api?.onWebFileServerStatus === 'function') {
      try {
        unsubscribe = api.onWebFileServerStatus((nextStatus) => applyStatus(nextStatus));
      } catch (error) {
        setMessage({ type: 'error', text: cleanIpcError(error, '监听服务状态失败') });
      }
    }

    return () => {
      mountedRef.current = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [applyStatus, refreshStatus]);

  const urls = useMemo(() => getUrls(status), [status]);
  const preferredUrl = useMemo(() => {
    if (status.primaryAddress) {
      const matched = urls.find((url) => url.includes(status.primaryAddress));
      if (matched) return matched;
    }
    return urls[0] || '';
  }, [status.primaryAddress, urls]);
  const currentUrl = urls.includes(selectedUrl) ? selectedUrl : preferredUrl;
  const state = String(status.state || 'stopped').toLowerCase();
  const transitioning = busy || state === 'starting' || state === 'stopping';
  const running = state === 'running';
  const tokenRequired = status.tokenRequired === true;
  const lastAddress = status.lastAddress && status.lastPort
    ? `http://${status.lastAddress}:${status.lastPort}/`
    : '';
  const recentRequests = Array.isArray(status.recentRequests) ? status.recentRequests : [];
  const addressKinds = status.addressKinds || {};
  // 同一台电脑常常同时有 Wi-Fi 和 USB 直连两条路，标出来才知道手机该用哪条
  const kindOf = (url) => {
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      return addressKinds[host] || '';
    } catch (_) {
      return '';
    }
  };

  useEffect(() => {
    if (currentUrl !== selectedUrl) setSelectedUrl(currentUrl);
  }, [currentUrl, selectedUrl]);

  useEffect(() => {
    let cancelled = false;
    const generate = async () => {
      setQrCodeData('');
      if (!currentUrl) return;
      const api = getApi();
      if (typeof api?.generateQRCode !== 'function') return;
      try {
        const result = await api.generateQRCode(currentUrl, 256, 'M');
        if (!cancelled && mountedRef.current) setQrCodeData(result || '');
      } catch (error) {
        if (!cancelled && mountedRef.current) {
          setMessage({ type: 'error', text: cleanIpcError(error, '生成访问二维码失败') });
        }
      }
    };
    generate();
    return () => { cancelled = true; };
  }, [currentUrl]);

  const selectDirectory = async () => {
    const api = getApi();
    if (typeof api?.selectWebFileServerDirectory !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持选择共享目录。' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.selectWebFileServerDirectory();
      const rootPath = getRootPath(result);
      if (result && rootPath) {
        applyStatus(result);
        await refreshStatus({ quiet: true });
      }
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '选择共享目录失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const startServer = async () => {
    const api = getApi();
    if (!status.rootPath) {
      setMessage({ type: 'warning', text: '请先选择要共享的根目录。' });
      return;
    }
    if (typeof api?.startWebFileServer !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持启动局域网文件服务。' });
      return;
    }
    setBusy(true);
    setMessage({ type: 'info', text: '正在启动局域网文件服务…' });
    try {
      const result = await api.startWebFileServer();
      applyStatus(result);
      await refreshStatus({ quiet: true });
      const notice = result?.changeNotice;
      if (notice && (notice.portChanged || notice.addressChanged)) {
        toastInfo(notice.message);
        if (mountedRef.current) {
          setMessage({ type: 'warning', text: notice.message });
        }
      } else if (mountedRef.current) {
        setMessage({ type: 'success', text: '局域网文件服务已启动。' });
      }
    } catch (error) {
      if (mountedRef.current) setMessage({ type: 'error', text: cleanIpcError(error, '启动服务失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const stopServer = async () => {
    const api = getApi();
    if (typeof api?.stopWebFileServer !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持停止局域网文件服务。' });
      return;
    }
    setBusy(true);
    setMessage({ type: 'info', text: '正在停止局域网文件服务…' });
    try {
      const result = await api.stopWebFileServer();
      applyStatus(result);
      await refreshStatus({ quiet: true });
      if (mountedRef.current) setMessage({ type: 'success', text: '局域网文件服务已停止。' });
    } catch (error) {
      if (mountedRef.current) setMessage({ type: 'error', text: cleanIpcError(error, '停止服务失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!currentUrl) return;
    // 统一走 lib/clipboard：它会把「成功/失败」如实返回，不再靠抛异常表达
    const result = await copyText(currentUrl);
    if (result.ok) {
      setMessage({ type: 'success', text: '访问地址已复制到剪贴板。' });
    } else {
      setMessage({ type: 'error', text: '复制访问地址失败，请手动选中后复制。' });
    }
  };

  const toggleToken = async (next) => {
    const api = getApi();
    if (typeof api?.setWebFileServerToken !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持修改访问令牌设置。' });
      return;
    }
    setBusy(true);
    try {
      const result = await api.setWebFileServerToken({ requireToken: next });
      applyStatus(result);
      await refreshStatus({ quiet: true });
      if (mountedRef.current) {
        setMessage({
          type: next ? 'info' : 'success',
          text: next
            ? '已启用访问令牌。下次启动的地址会带 token，且 token 固定不变。'
            : '已关闭访问令牌。地址固定为 http://地址:端口/，重启后不变。'
        });
      }
    } catch (error) {
      if (mountedRef.current) setMessage({ type: 'error', text: cleanIpcError(error, '修改访问令牌设置失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className="content-card web-file-server">
      <div className="web-file-server__header">
        <div>
          <h2>🌐 局域网文件服务</h2>
          <p>让同一局域网内的手机或电脑通过浏览器访问、下载和上传文件。</p>
        </div>
        <button className="btn btn-secondary" onClick={() => refreshStatus()} disabled={transitioning || loading}>
          {loading ? '刷新中…' : '🔄 刷新状态'}
        </button>
      </div>

      {message && <div className={`message ${message.type}`} role="status">{message.text}</div>}

      <section className="web-file-server__panel">
        <div className="web-file-server__status-row">
          <div>
            <span className="web-file-server__label">服务状态</span>
            <span className={`web-file-server__badge web-file-server__badge--${state}`}>
              <span className="web-file-server__dot" />{STATE_TEXT[state] || status.state || '未知'}
            </span>
          </div>
          <div>
            <span className="web-file-server__label">实际端口</span>
            <strong>{status.port ?? '—'}</strong>
          </div>
          <div>
            <span className="web-file-server__label">优先地址</span>
            <strong>{status.primaryAddress || '—'}</strong>
          </div>
        </div>

        <div className="web-file-server__token-row">
          <div>
            <span className="web-file-server__label">访问令牌</span>
            <strong>{tokenRequired ? '已启用 · 地址带 token' : '已关闭 · 地址固定不变'}</strong>
            {!running && lastAddress && (
              <small className="web-file-server__token-hint">
                上次地址 {lastAddress}
                {tokenRequired ? '（含固定 token）' : ''}，下次启动仍是同一个
              </small>
            )}
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => toggleToken(!tokenRequired)}
            disabled={transitioning || running}
            title={running ? '请先停止服务再修改' : undefined}
          >
            {tokenRequired ? '关闭令牌' : '启用令牌'}
          </button>
        </div>

        <div className="web-file-server__directory">
          <span className="web-file-server__label">共享根目录</span>
          <div className="web-file-server__directory-row">
            <code title={status.rootPath || ''}>{status.rootPath || '尚未选择目录'}</code>
            <button className="btn btn-secondary" onClick={selectDirectory} disabled={transitioning || running}>
              📁 {status.rootPath ? '更换目录' : '选择目录'}
            </button>
          </div>
          {running && <small>服务运行时不可更换目录，请先停止服务。</small>}
        </div>

        <div className="action-buttons web-file-server__actions">
          {!running ? (
            <button className="btn btn-primary" onClick={startServer} disabled={transitioning || !status.rootPath}>
              {state === 'starting' || busy ? '正在启动…' : '▶ 启动服务'}
            </button>
          ) : (
            <button className="btn web-file-server__stop" onClick={stopServer} disabled={transitioning}>
              {state === 'stopping' || busy ? '正在停止…' : '■ 停止服务'}
            </button>
          )}
        </div>
      </section>

      {!status.rootPath && (
        <div className="message warning">
          <strong>尚未选择共享目录</strong><br />请选择一个根目录后再启动服务；局域网客户端只能访问该目录及其子目录。
        </div>
      )}

      {running && urls.length === 0 && (
        <div className="message warning">
          <strong>暂未发现可用的局域网地址</strong><br />请确认电脑已连接 Wi-Fi 或有线局域网，然后刷新状态。VPN、虚拟网卡或未联网也可能导致没有地址。
        </div>
      )}

      {urls.length > 0 && (
        <section className="web-file-server__access">
          <div className="web-file-server__access-info">
            <h3>局域网访问地址</h3>
            <p>
              可选择当前网络对应的地址，并在同一局域网设备的浏览器中打开。
              手机该用哪条取决于它自己接在哪：连 Wi-Fi 用「局域网」，USB 直连（如 iPhone USB 网络）用「USB 直连」。
            </p>
            <div className="web-file-server__url-list" role="radiogroup" aria-label="局域网访问地址">
              {urls.map((url) => (
                <label key={url} className={`web-file-server__url-option ${currentUrl === url ? 'selected' : ''}`}>
                  <input type="radio" name="web-file-server-url" value={url} checked={currentUrl === url} onChange={() => setSelectedUrl(url)} />
                  <span className="web-file-server__url-text">
                    {url}
                    {kindOf(url) ? <em className="web-file-server__url-kind">{kindOf(url)}</em> : null}
                  </span>
                </label>
              ))}
            </div>
            <div className="web-file-server__selected-url">
              <input aria-label="当前访问地址" type="text" value={currentUrl} readOnly onFocus={(event) => event.target.select()} />
              <button className="btn btn-primary" onClick={copyUrl}>📋 复制地址</button>
            </div>
          </div>
          <div className="web-file-server__qr">
            <h3>扫码访问</h3>
            <div className="web-file-server__qr-frame">
              {qrCodeData ? <img src={qrCodeData} alt="当前局域网访问地址二维码" /> : <span>二维码生成中…</span>}
            </div>
            <small>二维码对应当前选中的完整访问地址。</small>
          </div>
        </section>
      )}

      <div className="web-file-server__guidance">
        <details className="web-file-server__recent">
          <summary>最近访问（{recentRequests.length}）· 手机连不上时先看这里</summary>
          {recentRequests.length ? (
            <ul>
              {recentRequests.slice(0, 12).map((item, index) => (
                <li key={`${item.at}-${index}`}>
                  <code className="web-file-server__recent-ip">{item.ip}</code>
                  <span className="web-file-server__recent-path">{item.method} {item.path}</span>
                  <span className={`web-file-server__recent-status ${item.status >= 400 ? 'is-bad' : 'is-ok'}`}>
                    {item.status}
                  </span>
                  <span className="web-file-server__recent-time">
                    {new Date(item.at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="web-file-server__recent-empty">
              还没有任何设备访问过。点上面的「刷新状态」可以拉取最新记录。
            </p>
          )}
          <p className="web-file-server__recent-hint">
            在某台手机浏览器里打开访问地址，然后回到这里点「刷新状态」：
            <br />
            · <b>列表里出现该手机的 IP</b> → 请求到了电脑，问题在服务端（看状态码：4xx 是地址/来源校验没过）
            <br />
            · <b>列表里始终没有</b> → 请求根本没到电脑，是网络问题：两台设备不在同一局域网、
              路由器开了「AP 隔离 / 客户端隔离」、手机走了 VPN / 蜂窝数据，或被系统防火墙拦了
          </p>
        </details>

        <div className="message warning">
          <strong>安全提示</strong>
          <ul>
            {tokenRequired ? (
              <li>服务使用 HTTP，令牌链接相当于访问凭证，仅应在可信局域网内使用，请勿转发或暴露到公网。</li>
            ) : (
              <li>
                当前<b>未启用访问令牌</b>，同一局域网内任何人只要知道地址就能浏览、下载和上传共享目录里的文件。
                地址固定为 <code>http://地址:端口/</code>，如需限制访问请点上方「启用令牌」。
              </li>
            )}
            <li>上传同名文件时不会覆盖现有文件，服务会保留原文件并为新文件使用安全的新名称。</li>
            <li>离开当前页面不会停止服务；需要结束共享时请返回本页点击“停止服务”。</li>
          </ul>
        </div>
        <div className="message info">
          <strong>连接排查</strong>
          <ul>
            <li>客户端与本机必须连接同一个局域网；访客网络或路由器的“客户端隔离/AP 隔离”会阻止设备互访。</li>
            <li>若地址无法打开，请允许应用通过系统防火墙，并检查当前实际端口是否被安全软件拦截。</li>
            <li>端口与地址会被记住，服务停止再启动仍使用同一个地址；只有被占用时才会顺延端口。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default WebFileServer;
