import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toastInfo } from '../lib/toastStore';
import { copyText } from '../lib/clipboard';
import { cleanIpcError } from '../lib/errorText';
import PlainSecretField from './PlainSecretField';

const EMPTY_STATUS = {
  state: 'stopped',
  rootPath: '',
  port: null,
  primaryAddress: null,
  urls: [],
  username: 'admin',
  authRequired: false,
  hasPassword: false,
  recentRequests: [],
  changeNotice: null,
  error: null
};

const STATE_TEXT = {
  stopped: '已停止',
  starting: '正在启动',
  running: '运行中',
  stopping: '正在停止',
  error: '异常'
};

const getApi = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

const getRootPath = (value) => {
  if (typeof value === 'string') return value;
  return value?.rootPath || value?.selectedRoot || value?.directory || value?.path || '';
};

const getUrls = (status) => {
  const rawUrls = status?.urls || [];
  return [...new Set((Array.isArray(rawUrls) ? rawUrls : Object.values(rawUrls))
    .map((item) => (typeof item === 'string' ? item : item?.url || ''))
    .filter(Boolean))];
};

const normalizeStatus = (value, previous = EMPTY_STATUS) => {
  if (!value || typeof value !== 'object') return previous;
  return {
    ...previous,
    ...value,
    state: value.state || 'stopped',
    rootPath: getRootPath(value) || previous.rootPath || '',
    urls: getUrls(value)
  };
};

/**
 * WebDAV 服务面板：把选定的目录挂载成「网络磁盘」。
 * 与「局域网文件服务」的区别：那个只能浏览器访问；这个可以被
 * Finder、Windows 资源管理器、手机文件 App 当成网盘直接读写。
 */
function WebDavServer() {
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [selectedUrl, setSelectedUrl] = useState('');
  const [qrCodeData, setQrCodeData] = useState('');
  // 账号/密码编辑区（服务停止时可改，点「保存」才生效）
  const [usernameDraft, setUsernameDraft] = useState('admin');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  // 第三方中转站地址（frp / tailscale / 内网穿透等，由用户自己填）
  const [relayUrl, setRelayUrl] = useState('');
  const mountedRef = useRef(true);

  const applyStatus = useCallback((nextStatus) => {
    if (!mountedRef.current) return;
    setStatus((current) => normalizeStatus(nextStatus, current));
  }, []);

  const refreshStatus = useCallback(async ({ quiet = false } = {}) => {
    const api = getApi();
    if (typeof api?.getWebDavServerStatus !== 'function') {
      setLoading(false);
      setMessage({ type: 'error', text: '当前版本未提供 WebDAV 服务接口，请更新应用后重试。' });
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const nextStatus = await api.getWebDavServerStatus();
      applyStatus(nextStatus);
      // 账号编辑区只在首次回填（主进程不回传密码明文，密码框永远留空让用户重设）
      if (mountedRef.current && !credentialsLoaded) {
        setUsernameDraft(nextStatus.username || nextStatus.persistedUsername || 'admin');
        setCredentialsLoaded(true);
      }
      if (!quiet) setMessage(null);
    } catch (error) {
      if (mountedRef.current) {
        setMessage({ type: 'error', text: cleanIpcError(error, '刷新服务状态失败') });
      }
    } finally {
      if (mountedRef.current && !quiet) setLoading(false);
    }
  }, [applyStatus, credentialsLoaded]);

  useEffect(() => {
    mountedRef.current = true;
    refreshStatus();

    const api = getApi();
    let unsubscribe;
    if (typeof api?.onWebDavServerStatus === 'function') {
      try {
        unsubscribe = api.onWebDavServerStatus((nextStatus) => applyStatus(nextStatus));
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
  const editable = !running && !transitioning;
  const lastAddress = status.lastAddress && status.lastPort
    ? `http://${status.lastAddress}:${status.lastPort}/`
    : '';
  const recentRequests = Array.isArray(status.recentRequests) ? status.recentRequests : [];
  const addressKinds = status.addressKinds || {};
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

  // 中转站地址校验：必须是合法 http(s) URL 才允许接管二维码/复制提示，
  // 否则用户扫码会得到一个打不开的地址还以为中转挂了
  const relayUrlError = useMemo(() => {
    const value = relayUrl.trim();
    if (!value) return '';
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '地址必须以 http:// 或 https:// 开头';
      }
      if (!parsed.hostname) return '地址缺少域名或 IP';
    } catch (_) {
      return '地址格式不正确，例如 http://relay.example.com:18766/';
    }
    return '';
  }, [relayUrl]);
  const relayUrlValid = Boolean(relayUrl.trim()) && !relayUrlError;

  // 二维码：有中转站地址时优先给中转站的（异地访问才是扫码场景）
  const qrTarget = relayUrlValid ? relayUrl.trim() : currentUrl;
  useEffect(() => {
    let cancelled = false;
    const generate = async () => {
      setQrCodeData('');
      if (!qrTarget) return;
      const api = getApi();
      if (typeof api?.generateQRCode !== 'function') return;
      try {
        const result = await api.generateQRCode(qrTarget, 256, 'M');
        if (!cancelled && mountedRef.current) setQrCodeData(result || '');
      } catch (error) {
        if (!cancelled && mountedRef.current) {
          setMessage({ type: 'error', text: cleanIpcError(error, '生成访问二维码失败') });
        }
      }
    };
    generate();
    return () => { cancelled = true; };
  }, [qrTarget]);

  const selectDirectory = async () => {
    const api = getApi();
    if (typeof api?.selectWebDavServerDirectory !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持选择存储路径。' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.selectWebDavServerDirectory();
      const rootPath = getRootPath(result);
      if (result && rootPath) {
        applyStatus(result);
        await refreshStatus({ quiet: true });
      }
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '选择存储路径失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveCredentials = async () => {
    const api = getApi();
    if (typeof api?.setWebDavServerCredentials !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持修改账号密码。' });
      return;
    }
    const username = usernameDraft.trim() || 'admin';
    // 已设密码却要清空：这是高危操作（局域网内任何设备都能免密读写），必须显式确认
    const hadPassword = Boolean(status.hasPassword ?? status.persistedHasPassword);
    if (hadPassword && !passwordDraft) {
      const confirmed = window.confirm('清空密码后，同一局域网内任何设备都可以免密读写共享目录。确定要关闭鉴权吗？');
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const result = await api.setWebDavServerCredentials({ username, password: passwordDraft });
      applyStatus(result);
      await refreshStatus({ quiet: true });
      if (mountedRef.current) {
        setMessage({
          type: passwordDraft ? 'success' : 'info',
          text: passwordDraft
            ? `已保存。挂载时使用账号 ${username} 和刚才设置的密码。`
            : '密码已清空：局域网内任何设备都可免密挂载（信任模式）。'
        });
      }
    } catch (error) {
      if (mountedRef.current) setMessage({ type: 'error', text: cleanIpcError(error, '保存账号密码失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const startServer = async () => {
    const api = getApi();
    if (!status.rootPath) {
      setMessage({ type: 'warning', text: '请先选择要共享的存储路径。' });
      return;
    }
    if (typeof api?.startWebDavServer !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持启动 WebDAV 服务。' });
      return;
    }
    setBusy(true);
    setMessage({ type: 'info', text: '正在启动 WebDAV 服务…' });
    try {
      const result = await api.startWebDavServer();
      applyStatus(result);
      await refreshStatus({ quiet: true });
      const notice = result?.changeNotice;
      if (notice && (notice.portChanged || notice.addressChanged)) {
        toastInfo(notice.message);
        if (mountedRef.current) setMessage({ type: 'warning', text: notice.message });
      } else if (mountedRef.current) {
        setMessage({ type: 'success', text: 'WebDAV 服务已启动。' });
      }
    } catch (error) {
      if (mountedRef.current) setMessage({ type: 'error', text: cleanIpcError(error, '启动服务失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const stopServer = async () => {
    const api = getApi();
    if (typeof api?.stopWebDavServer !== 'function') {
      setMessage({ type: 'error', text: '当前版本不支持停止 WebDAV 服务。' });
      return;
    }
    setBusy(true);
    setMessage({ type: 'info', text: '正在停止 WebDAV 服务…' });
    try {
      const result = await api.stopWebDavServer();
      applyStatus(result);
      await refreshStatus({ quiet: true });
      if (mountedRef.current) setMessage({ type: 'success', text: 'WebDAV 服务已停止。' });
    } catch (error) {
      if (mountedRef.current) setMessage({ type: 'error', text: cleanIpcError(error, '停止服务失败') });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const copyUrl = async (value) => {
    if (!value) return;
    const result = await copyText(value);
    if (result.ok) {
      setMessage({ type: 'success', text: '地址已复制到剪贴板。' });
    } else {
      setMessage({ type: 'error', text: '复制失败，请手动选中后复制。' });
    }
  };

  return (
    <div className="content-card web-file-server webdav-server">
      <div className="web-file-server__header">
        <div>
          <h2>🗄️ WebDAV 文件服务</h2>
          <p>把选定目录挂载成网络磁盘：手机文件 App、Finder、Windows 资源管理器都能直接读写。</p>
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
            <span className="web-file-server__label">挂载鉴权</span>
            <strong>
              {(status.authRequired || status.hasPassword || status.persistedHasPassword)
                ? `已启用 · 账号 ${status.username || status.persistedUsername || 'admin'}`
                : '未设密码 · 局域网信任模式'}
            </strong>
            {!running && lastAddress && (
              <small className="web-file-server__token-hint">
                上次地址 {lastAddress}，下次启动仍是同一个
              </small>
            )}
          </div>
        </div>

        <div className="web-file-server__directory">
          <span className="web-file-server__label">存储路径</span>
          <div className="web-file-server__directory-row">
            <code title={status.rootPath || ''}>{status.rootPath || '尚未选择目录'}</code>
            <button className="btn btn-secondary" onClick={selectDirectory} disabled={transitioning || running}>
              📁 {status.rootPath ? '更换目录' : '选择目录'}
            </button>
          </div>
          {running && <small>服务运行时不可更换目录，请先停止服务。</small>}
        </div>

        <div className="webdav-server__credentials">
          <span className="web-file-server__label">挂载账号（服务停止时可修改）</span>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="webdav-username">账号（留空 = 固定 admin）</label>
              <input
                id="webdav-username"
                type="text"
                value={usernameDraft}
                onChange={(event) => setUsernameDraft(event.target.value)}
                placeholder="admin"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={!editable}
              />
            </div>
            <PlainSecretField
              id="webdav-password"
              label="密码（留空 = 免密挂载）"
              value={passwordDraft}
              onChange={setPasswordDraft}
              placeholder={
                status.hasPassword || status.persistedHasPassword
                  ? '已设置密码；输入新密码可替换'
                  : '设置后挂载时需要输入'
              }
            />
          </div>
          {editable && (status.hasPassword || status.persistedHasPassword) && !passwordDraft && (
            <small className="webdav-server__password-hint">
              当前已设置密码。留空保存会清空密码（关闭鉴权），保存前会再次确认。
            </small>
          )}
          <button className="btn btn-secondary" onClick={saveCredentials} disabled={!editable || busy}>
            💾 保存账号密码
          </button>
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
          <strong>尚未选择存储路径</strong><br />请选择一个根目录后再启动服务；挂载方只能访问该目录及其子目录。
        </div>
      )}

      {running && urls.length === 0 && (
        <div className="message warning">
          <strong>暂未发现可用的局域网地址</strong><br />请确认电脑已连接 Wi-Fi 或有线局域网，然后刷新状态。
        </div>
      )}

      {urls.length > 0 && (
        <section className="web-file-server__access">
          <div className="web-file-server__access-info">
            <h3>本机地址（同一局域网使用）</h3>
            <p>
              手机连 Wi-Fi 用「局域网」条目；USB 直连（如 iPhone USB 网络）用「USB 直连」条目。
              在客户端里填的地址就是这些。
            </p>
            <div className="web-file-server__url-list" role="radiogroup" aria-label="WebDAV 本机访问地址">
              {urls.map((url) => (
                <label key={url} className={`web-file-server__url-option ${currentUrl === url ? 'selected' : ''}`}>
                  <input type="radio" name="webdav-server-url" value={url} checked={currentUrl === url} onChange={() => setSelectedUrl(url)} />
                  <span className="web-file-server__url-text">
                    {url}
                    {kindOf(url) ? <em className="web-file-server__url-kind">{kindOf(url)}</em> : null}
                  </span>
                </label>
              ))}
            </div>
            <div className="web-file-server__selected-url">
              <input aria-label="当前 WebDAV 地址" type="text" value={currentUrl} readOnly onFocus={(event) => event.target.select()} />
              <button className="btn btn-primary" onClick={() => copyUrl(currentUrl)}>📋 复制地址</button>
            </div>
          </div>
          <div className="web-file-server__qr">
            <h3>扫码挂载</h3>
            <div className="web-file-server__qr-frame">
              {qrCodeData ? <img src={qrCodeData} alt="WebDAV 地址二维码" /> : <span>二维码生成中…</span>}
            </div>
            <small>二维码对应当前选中地址{relayUrlValid ? '或中转站地址' : ''}。</small>
          </div>
        </section>
      )}

      <section className="webdav-server__relay">
        <h3>🛰️ 第三方中转站（异地访问）</h3>
        <p>
          手机和电脑不在同一局域网时，本机地址不可达。可用 frp、Tailscale、ZeroTier 等工具把本机端口
          转发出去，再把转发后的完整地址填在这里（例如 <code>http://relay.example.com:18766/</code>）。
          填写后二维码会切到中转站地址。
        </p>
        <div className="web-file-server__selected-url">
          <input
            aria-label="第三方中转站地址"
            aria-invalid={Boolean(relayUrlError)}
            type="text"
            value={relayUrl}
            onChange={(event) => setRelayUrl(event.target.value.trim())}
            placeholder="http://中转域名或IP:端口/"
            spellCheck={false}
            className={relayUrlError ? 'webdav-server__relay-input is-invalid' : undefined}
          />
          <button
            className="btn btn-secondary"
            onClick={() => copyUrl(relayUrl)}
            disabled={!relayUrlValid}
          >
            📋 复制
          </button>
        </div>
        {relayUrlError ? (
          <small className="webdav-server__relay-error" role="alert">
            {relayUrlError}
          </small>
        ) : relayUrl ? (
          <small className="webdav-server__relay-hint">
            当前二维码指向中转站地址：{relayUrl}
          </small>
        ) : null}
      </section>

      <div className="web-file-server__guidance">
        <details className="web-file-server__recent">
          <summary>最近访问（{recentRequests.length}）· 挂载不上时先看这里</summary>
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
            在客户端尝试挂载，然后回到这里点「刷新状态」：
            <br />
            · <b>列表里出现该设备的 IP</b> → 请求到了电脑，问题在服务端（401 是账号密码不对）
            <br />
            · <b>列表里始终没有</b> → 请求根本没到电脑，是网络问题：不在同一局域网、
              路由器开了「AP 隔离」、走了 VPN，或被系统防火墙拦了
          </p>
        </details>

        <div className="message info">
          <strong>怎么挂载</strong>
          <ul>
            <li><b>iPhone / iPad</b>：文件 App → 右上角「···」→「连接服务器」→ 输入地址与账号密码。</li>
            <li><b>macOS</b>：Finder → 前往 → 连接服务器（⌘K）→ 输入地址。</li>
            <li><b>Windows</b>：资源管理器 → 映射网络驱动器 → 输入地址。</li>
            <li><b>Android</b>：文件管理器（如 CX 文件管理器、Solid Explorer）添加 WebDAV 云端。</li>
          </ul>
        </div>

        <div className="message warning">
          <strong>安全提示</strong>
          <ul>
            {(status.authRequired || status.hasPassword || status.persistedHasPassword) ? (
              <li>已设置密码：挂载需要账号 {status.username || status.persistedUsername || 'admin'} 和密码。WebDAV 走 HTTP，密码仅建议在可信局域网 / 自有中转链路内使用。</li>
            ) : (
              <li>
                当前<b>未设置密码</b>，同一局域网内任何人知道地址就能读写共享目录里的文件。
                需要限制访问请在上方设置密码。
              </li>
            )}
            <li>上传采用「临时文件 + 原子替换」：中途断开不会损坏原文件，但会覆盖同名旧文件。</li>
            <li>离开当前页面不会停止服务；需要结束时请返回本页点击「停止服务」。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default WebDavServer;
