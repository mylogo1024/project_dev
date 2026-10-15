import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cleanIpcError } from '../lib/errorText';

const DEFAULT_LOG_LIMIT = 5000;
const MIN_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 50000;
const FLUSH_INTERVAL = 100;
// 渲染层安全阈值：超过该行数时只渲染尾部窗口，避免数万 DOM 节点拖垮渲染进程
const RENDER_SAFE_LIMIT = 2000;
// 渲染层接收队列上限：渲染卡顿时丢弃最旧日志，防止内存持续膨胀
const MAX_QUEUE_LOGS = 10000;
const TERMINAL_STATES = new Set(['stopped', 'error']);

const clampLogLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_LIMIT;
  return Math.min(MAX_LOG_LIMIT, Math.max(MIN_LOG_LIMIT, parsed));
};

const getInitialLogLimit = () => DEFAULT_LOG_LIMIT;

const getSessionId = (value) => {
  if (typeof value === 'string') return value;
  return value?.sessionId || value?.id || '';
};

const normalizeCaptureState = (value) => {
  const state = String(value || '').toLowerCase();
  if (['starting', 'start_pending'].includes(state)) return 'starting';
  if (['running', 'started', 'capturing'].includes(state)) return 'running';
  if (['stopping', 'stop_pending'].includes(state)) return 'stopping';
  if (['stopped', 'closed', 'exited', 'ended'].includes(state)) return 'stopped';
  if (['error', 'failed'].includes(state)) return 'error';
  return '';
};

const normalizeDevice = (device) => {
  if (typeof device === 'string') return { id: device, label: device };
  const id = device?.id || device?.deviceId || device?.udid || device?.value || '';
  return {
    ...device,
    id,
    label: device?.label || device?.name || device?.displayName || id
  };
};

function LogViewer({ initialDevice = null }) {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(initialDevice?.id || '');
  const [deviceType, setDeviceType] = useState(initialDevice?.platform === 'ios' ? 'ios' : 'android');
  const [deviceLoading, setDeviceLoading] = useState(true);
  const [deviceError, setDeviceError] = useState('');
  const [deviceReload, setDeviceReload] = useState(0);
  const [captureState, setCaptureState] = useState('idle');
  const [captureMessage, setCaptureMessage] = useState(null);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [logs, setLogs] = useState([]);
  const [droppedCount, setDroppedCount] = useState(0);
  const [logLimit, setLogLimit] = useState(getInitialLogLimit);
  const [logLimitInput, setLogLimitInput] = useState(() => String(getInitialLogLimit()));
  const [filterLevel, setFilterLevel] = useState('all');
  const [filterPackage, setFilterPackage] = useState('');
  const [packageNames, setPackageNames] = useState([]);
  const [pidMap, setPidMap] = useState(() => new Map());
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [packagesError, setPackagesError] = useState('');
  const [packageReload, setPackageReload] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const logContainerRef = useRef(null);
  const mountedRef = useRef(false);
  const deviceRequestRef = useRef(0);
  const activeSessionRef = useRef('');
  const pendingStartRef = useRef(null);
  const pendingSessionIdsRef = useRef(new Set());
  const startTokenRef = useRef(0);
  const latestStatusRef = useRef(null);
  const logQueueRef = useRef([]);
  const queuedDropCountRef = useRef(0);
  const logLimitRef = useRef(logLimit);
  const fallbackSequenceRef = useRef(0);
  const searchInputRef = useRef(null);

  const running = captureState === 'running';
  const transitioning = captureState === 'starting' || captureState === 'stopping';
  const captureActive = running || transitioning;

  useEffect(() => {
    mountedRef.current = true;
    const removeLogListener = window.electronAPI.onLogData((log) => {
      const eventSessionId = getSessionId(log);
      const currentSessionId = activeSessionRef.current;
      const pendingStart = pendingStartRef.current;
      const belongsToCurrent = currentSessionId && eventSessionId === currentSessionId;
      const belongsToPending = pendingStart && (
        !eventSessionId ||
        eventSessionId === pendingStart.sessionId ||
        pendingSessionIdsRef.current.has(eventSessionId)
      );
      if (!belongsToCurrent && !belongsToPending) return;

      fallbackSequenceRef.current += 1;
      logQueueRef.current.push({
        ...log,
        sessionId: eventSessionId || currentSessionId || pendingStart?.sessionId || 'pending',
        sequence: log?.sequence ?? log?.seq ?? fallbackSequenceRef.current
      });
      if (logQueueRef.current.length > MAX_QUEUE_LOGS) {
        const overflow = logQueueRef.current.length - MAX_QUEUE_LOGS;
        logQueueRef.current.splice(0, overflow);
        queuedDropCountRef.current += overflow;
      }
    });

    const removeStatusListener = window.electronAPI.onLogCaptureStatus((status) => {
      const state = normalizeCaptureState(status?.state || status?.status);
      if (!state) return;

      const eventSessionId = getSessionId(status);
      const currentSessionId = activeSessionRef.current;
      const pendingStart = pendingStartRef.current;
      const belongsToCurrent = currentSessionId && eventSessionId === currentSessionId;
      const belongsToPending = pendingStart && (
        !eventSessionId ||
        eventSessionId === pendingStart.sessionId ||
        pendingSessionIdsRef.current.has(eventSessionId)
      );
      if (!belongsToCurrent && !belongsToPending) return;

      latestStatusRef.current = { state, status, sessionId: eventSessionId };
      if (pendingStart && eventSessionId) pendingSessionIdsRef.current.add(eventSessionId);
      if (!mountedRef.current) return;
      if (eventSessionId && !currentSessionId) {
        activeSessionRef.current = eventSessionId;
        setActiveSessionId(eventSessionId);
      }
      setCaptureState(state);
      if (status?.message || state === 'error') {
        setCaptureMessage({
          type: state === 'error' ? 'error' : 'info',
          text: status?.message || status?.error || '日志捕获发生错误'
        });
      } else if (state === 'running') {
        setCaptureMessage({ type: 'success', text: '日志捕获已启动' });
      } else if (state === 'stopped') {
        setCaptureMessage({ type: 'info', text: '日志捕获已停止' });
      }
      if (TERMINAL_STATES.has(state)) {
        activeSessionRef.current = '';
        setActiveSessionId('');
      }
    });

    const flushTimer = window.setInterval(() => {
      if (!mountedRef.current || logQueueRef.current.length === 0) return;
      const batch = logQueueRef.current.splice(0);
      let overflow = 0;
      setLogs((previous) => {
        const combined = previous.concat(batch);
        const currentLimit = logLimitRef.current;
        if (combined.length <= currentLimit) return combined;
        overflow = combined.length - currentLimit;
        return combined.slice(overflow);
      });
      const queuedDropped = queuedDropCountRef.current;
      if (queuedDropped > 0) queuedDropCountRef.current = 0;
      const totalDropped = overflow + queuedDropped;
      if (totalDropped > 0) setDroppedCount((count) => count + totalDropped);
    }, FLUSH_INTERVAL);

    return () => {
      mountedRef.current = false;
      startTokenRef.current += 1;
      removeLogListener?.();
      removeStatusListener?.();
      window.clearInterval(flushTimer);
      logQueueRef.current = [];
      const sessionId = activeSessionRef.current;
      activeSessionRef.current = '';
      if (sessionId) window.electronAPI.stopLogCapture(sessionId).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const requestId = ++deviceRequestRef.current;
    let cancelled = false;
    setDevices([]);
    setSelectedDeviceId('');
    setDeviceError('');
    setDeviceLoading(true);

    window.electronAPI.getLogDevices(deviceType)
      .then((result) => {
        if (cancelled || requestId !== deviceRequestRef.current) return;
        const rawDevices = Array.isArray(result) ? result : result?.devices;
        const nextDevices = (Array.isArray(rawDevices) ? rawDevices : [])
          .map(normalizeDevice)
          .filter((device) => device.id);
        setDevices(nextDevices);
        setSelectedDeviceId(nextDevices[0]?.id || '');
      })
      .catch((error) => {
        if (!cancelled && requestId === deviceRequestRef.current) {
          setDeviceError(cleanIpcError(error, '获取设备失败'));
        }
      })
      .finally(() => {
        if (!cancelled && requestId === deviceRequestRef.current) setDeviceLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [deviceType, deviceReload]);

  // Android 设备选中后加载运行中的应用进程（PID→包名映射）
  useEffect(() => {
    if (deviceType !== 'android' || !selectedDeviceId) {
      setPackageNames([]);
      setPidMap(new Map());
      setFilterPackage('');
      setPackagesError('');
      return;
    }
    let cancelled = false;
    setPackagesLoading(true);
    setPackagesError('');
    window.electronAPI.getAndroidApps(selectedDeviceId)
      .then((result) => {
        if (cancelled) return;
        const procs = Array.isArray(result?.processes) ? result.processes : [];
        const uniqueNames = [];
        const seenBase = new Set();
        const map = new Map();
        for (const p of procs) {
          const rawName = String(p.packageName || '');
          if (!rawName) continue;
          const base = rawName.replace(/:.*/, '');
          if (!base) continue;
          map.set(String(p.pid), base);
          if (!seenBase.has(base)) {
            seenBase.add(base);
            uniqueNames.push(base);
          }
        }
        uniqueNames.sort((a, b) => a.localeCompare(b));
        setPackageNames(uniqueNames);
        setPidMap(map);
      })
      .catch((error) => {
        if (!cancelled) setPackagesError(cleanIpcError(error, '获取应用列表失败'));
      })
      .finally(() => {
        if (!cancelled) setPackagesLoading(false);
      });
    return () => { cancelled = true; };
  }, [deviceType, selectedDeviceId, packageReload]);

  // 切换设备时清空包名过滤
  useEffect(() => {
    setFilterPackage('');
  }, [selectedDeviceId, deviceType]);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = () => {
    logQueueRef.current = [];
    queuedDropCountRef.current = 0;
    setLogs([]);
    setDroppedCount(0);
  };

  const applyLogLimit = () => {
    const nextLimit = clampLogLimit(logLimitInput);
    logLimitRef.current = nextLimit;
    setLogLimit(nextLimit);
    setLogLimitInput(String(nextLimit));

    let overflow = 0;
    setLogs((previous) => {
      if (previous.length <= nextLimit) return previous;
      overflow = previous.length - nextLimit;
      return previous.slice(overflow);
    });
    if (overflow > 0) setDroppedCount((count) => count + overflow);
  };

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (filterLevel !== 'all' && log.level !== filterLevel) return false;
      if (filterPackage) {
        const logPkg = log.pid ? pidMap.get(String(log.pid)) : '';
        if (logPkg !== filterPackage) return false;
      }
      return true;
    });
  }, [logs, filterLevel, filterPackage, pidMap]);

  // 渲染窗口：超出安全阈值时只渲染尾部，DOM 数量恒定，防止渲染进程崩溃
  const { renderedLogs, hiddenCount } = useMemo(() => {
    if (filteredLogs.length <= RENDER_SAFE_LIMIT) {
      return { renderedLogs: filteredLogs, hiddenCount: 0 };
    }
    return {
      renderedLogs: filteredLogs.slice(filteredLogs.length - RENDER_SAFE_LIMIT),
      hiddenCount: filteredLogs.length - RENDER_SAFE_LIMIT
    };
  }, [filteredLogs]);

  const startLogs = async () => {
    if (!selectedDeviceId || deviceLoading) {
      setCaptureMessage({ type: 'warning', text: '请先选择可用设备' });
      return;
    }

    const startToken = ++startTokenRef.current;
    pendingStartRef.current = { token: startToken, sessionId: '' };
    pendingSessionIdsRef.current.clear();
    latestStatusRef.current = null;
    clearLogs();
    setCaptureState('starting');
    setCaptureMessage({ type: 'info', text: '正在启动日志捕获...' });

    try {
      const result = await window.electronAPI.startLogCapture(selectedDeviceId, deviceType);
      const sessionId = getSessionId(result);
      if (!sessionId) throw new Error('主进程未返回日志会话 ID');
      if (!mountedRef.current || pendingStartRef.current?.token !== startToken) {
        await window.electronAPI.stopLogCapture(sessionId).catch(() => {});
        return;
      }

      pendingStartRef.current.sessionId = sessionId;
      activeSessionRef.current = sessionId;
      setActiveSessionId(sessionId);
      const earlyStatus = latestStatusRef.current;
      const earlyStatusMatches = earlyStatus && (
        !earlyStatus.sessionId ||
        earlyStatus.sessionId === sessionId ||
        pendingSessionIdsRef.current.has(earlyStatus.sessionId)
      );
      if (earlyStatusMatches) {
        setCaptureState(earlyStatus.state);
        if (TERMINAL_STATES.has(earlyStatus.state)) {
          activeSessionRef.current = '';
          setActiveSessionId('');
        }
      } else {
        setCaptureState('running');
        setCaptureMessage({ type: 'success', text: '日志捕获已启动' });
      }
    } catch (error) {
      if (mountedRef.current && pendingStartRef.current?.token === startToken) {
        activeSessionRef.current = '';
        setActiveSessionId('');
        setCaptureState('error');
        setCaptureMessage({ type: 'error', text: cleanIpcError(error, '启动日志捕获失败') });
      }
    } finally {
      if (pendingStartRef.current?.token === startToken) pendingStartRef.current = null;
      pendingSessionIdsRef.current.clear();
    }
  };

  const stopLogs = async () => {
    const sessionId = activeSessionRef.current;
    if (!sessionId) {
      setCaptureMessage({ type: 'warning', text: '没有正在运行的日志会话' });
      return;
    }

    setCaptureState('stopping');
    setCaptureMessage({ type: 'info', text: '正在停止日志捕获...' });
    try {
      await window.electronAPI.stopLogCapture(sessionId);
      if (!mountedRef.current || activeSessionRef.current !== sessionId) return;
      if (latestStatusRef.current?.state !== 'error') {
        activeSessionRef.current = '';
        setActiveSessionId('');
        setCaptureState('stopped');
        setCaptureMessage({ type: 'info', text: '日志捕获已停止' });
      }
    } catch (error) {
      if (mountedRef.current && activeSessionRef.current === sessionId) {
        setCaptureState('error');
        setCaptureMessage({ type: 'error', text: cleanIpcError(error, '停止日志捕获失败') });
      }
    }
  };

  const saveLogs = async () => {
    try {
      const savePath = await window.electronAPI.saveFile({
        defaultPath: `log_${new Date().toISOString().replace(/:/g, '-')}.txt`,
        filters: [{ name: 'Text Files', extensions: ['txt'] }]
      });
      if (!savePath) return;
      const content = filteredLogs.map((log) =>
        `[${log.timestamp}] [${log.level}] ${log.tag ? `[${log.tag}] ` : ''}${log.message}`
      ).join('\n');
      await window.electronAPI.saveLogFile(savePath, content);
      setCaptureMessage({ type: 'success', text: '当前过滤后的日志已保存' });
    } catch (error) {
      setCaptureMessage({ type: 'error', text: `保存失败: ${cleanIpcError(error, '未知错误')}` });
    }
  };

  // Ctrl+F 打开搜索框
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 搜索导航：在 renderedLogs 中查找匹配项（用 index，随数据变化自动重算）
  const searchMatches = useMemo(() => {
    const kw = searchText.trim().toLowerCase();
    if (!kw || renderedLogs.length === 0) return [];
    const matches = [];
    for (let i = 0; i < renderedLogs.length; i++) {
      const log = renderedLogs[i];
      if (`${log.tag || ''} ${log.message || ''}`.toLowerCase().includes(kw)) {
        matches.push(i);
      }
    }
    return matches;
  }, [renderedLogs, searchText]);

  // 搜索关键字或过滤数据变化时，重置到第一条匹配
  useEffect(() => {
    setSearchIndex(0);
  }, [searchText, searchMatches]);

  const goToSearchMatch = (direction) => {
    const total = searchMatches.length;
    if (total === 0) return;
    const next = direction === 'next'
      ? (searchIndex + 1) % total
      : (searchIndex - 1 + total) % total;
    setSearchIndex(next);
    const matchIdx = searchMatches[next];
    if (matchIdx >= 0 && logContainerRef.current) {
      const lines = logContainerRef.current.querySelectorAll('.log-line');
      const target = lines[matchIdx];
      if (target) {
        // 临时关闭自动滚动，避免新日志把视口拉回底部
        if (autoScroll) setAutoScroll(false);
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  };

  const highlightText = (text, keyword, isActive) => {
    if (!keyword || !text) return text;
    const parts = String(text).split(new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === keyword.toLowerCase()
        ? <mark key={i} className={isActive ? 'search-highlight-active' : 'search-highlight'}>{part}</mark>
        : part
    );
  };

  const getLevelColor = (level) => ({
    V: '#9e9e9e', D: '#2196f3', I: '#4caf50', W: '#ff9800', E: '#f44336', F: '#9c27b0'
  }[level] || '#5f6368');

  const startDisabled = deviceLoading || !selectedDeviceId || captureActive;
  const stopDisabled = !activeSessionId || transitioning;
  const stateLabels = {
    idle: '空闲', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', error: '错误'
  };

  return (
    <div className="content-card log-page">
      <div className="log-toolbar">
        <div className="log-toolbar-row">
          <select
            className="log-select"
            value={deviceType}
            onChange={(event) => setDeviceType(event.target.value)}
            disabled={captureActive}
            aria-label="设备类型"
          >
            <option value="android">Android</option>
            <option value="ios">iOS</option>
          </select>

          <select
            className="log-select log-select-device"
            value={selectedDeviceId}
            onChange={(event) => setSelectedDeviceId(event.target.value)}
            disabled={captureActive || deviceLoading || devices.length === 0}
            aria-label="选择设备"
          >
            <option value="">{deviceLoading ? '正在加载设备…' : '请选择设备'}</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>{device.label}</option>
            ))}
          </select>

          {deviceType === 'android' && (
            <select
              className="log-select log-select-package"
              value={filterPackage}
              onChange={(event) => setFilterPackage(event.target.value)}
              aria-label="筛选应用包名"
              disabled={packagesLoading}
            >
              <option value="">
                {packagesLoading ? '加载应用列表…' : '全部应用'}
              </option>
              {packageNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}

          {deviceType === 'android' && (
            <button
              className="log-text-btn"
              onClick={() => setPackageReload((value) => value + 1)}
              disabled={packagesLoading || !selectedDeviceId}
              title="刷新应用列表"
            >
              {packagesLoading ? '加载中…' : '刷新应用'}
            </button>
          )}

          {deviceType === 'android' && packagesError && (
            <span className="log-inline-error">{packagesError}</span>
          )}

          <select
            className="log-select"
            value={filterLevel}
            onChange={(event) => setFilterLevel(event.target.value)}
            aria-label="日志级别"
          >
            <option value="all">全部级别</option>
            <option value="V">Verbose</option>
            <option value="D">Debug</option>
            <option value="I">Info</option>
            <option value="W">Warning</option>
            <option value="E">Error</option>
            <option value="F">Fatal</option>
          </select>

          {!running && captureState !== 'stopping' ? (
            <button className="btn btn-primary log-action" onClick={startLogs} disabled={startDisabled}>
              {captureState === 'starting' ? '启动中…' : '开始捕获'}
            </button>
          ) : (
            <button className="btn btn-secondary log-action" onClick={stopLogs} disabled={stopDisabled}>
              {captureState === 'stopping' ? '停止中…' : '停止'}
            </button>
          )}
          <button className="btn btn-secondary log-action" onClick={clearLogs}>清空</button>
          <button className="btn btn-secondary log-action" onClick={saveLogs} disabled={filteredLogs.length === 0}>保存</button>
        </div>

        <div className="log-toolbar-meta">
          <span className={`log-state is-${running ? 'running' : captureState === 'error' ? 'error' : 'idle'}`}>
            {stateLabels[captureState] || captureState}
          </span>
          <span>保留 {logs.length.toLocaleString()} / {logLimit.toLocaleString()}</span>
          <span>显示 {filteredLogs.length.toLocaleString()}</span>
          {droppedCount > 0 && <span>已丢弃 {droppedCount.toLocaleString()}</span>}
          <label className="log-autoscroll">
            <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
            自动滚动
          </label>
          <label className="log-limit-inline" htmlFor="log-retention-limit">
            上限
            <input
              id="log-retention-limit"
              type="number"
              min={MIN_LOG_LIMIT}
              max={MAX_LOG_LIMIT}
              step="100"
              value={logLimitInput}
              onChange={(event) => setLogLimitInput(event.target.value)}
              onBlur={applyLogLimit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  applyLogLimit();
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <button className="log-text-btn" onClick={() => setDeviceReload((value) => value + 1)} disabled={captureActive}>
            刷新设备
          </button>
          {deviceError && <span className="log-inline-error">{deviceError}</span>}
          {!deviceLoading && !deviceError && devices.length === 0 && (
            <span className="log-inline-warn">
              {deviceType === 'ios'
                ? '未检测到 iOS 设备，请解锁并完成信任。'
                : '未检测到 Android 设备，请开启 USB 调试。'}
            </span>
          )}
          {captureMessage && (
            <span className={`log-inline-msg is-${captureMessage.type}`}>{captureMessage.text}</span>
          )}
        </div>

        <div className="log-toolbar-search">
          <div className="log-search-box">
            <span className="log-search-icon" aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索关键字（Ctrl+F）"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  goToSearchMatch(event.shiftKey ? 'prev' : 'next');
                } else if (event.key === 'Escape') {
                  setSearchText('');
                  setSearchIndex(0);
                }
              }}
              className="log-search-input"
              aria-label="搜索关键字"
            />
            <button
              type="button"
              className="log-search-nav"
              onClick={() => goToSearchMatch('prev')}
              disabled={searchMatches.length === 0}
              title="上一个 (Shift+Enter)"
              aria-label="上一个匹配"
            >
              ↑
            </button>
            <span className="log-search-count">
              {searchText
                ? `${searchMatches.length === 0 ? 0 : searchIndex + 1} / ${searchMatches.length}`
                : '—'}
            </span>
            <button
              type="button"
              className="log-search-nav"
              onClick={() => goToSearchMatch('next')}
              disabled={searchMatches.length === 0}
              title="下一个 (Enter)"
              aria-label="下一个匹配"
            >
              ↓
            </button>
            {searchText && (
              <button
                type="button"
                className="log-search-nav"
                onClick={() => {
                  setSearchText('');
                  setSearchIndex(0);
                }}
                title="清除搜索"
                aria-label="清除搜索"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="log-container" ref={logContainerRef}>
        {filteredLogs.length === 0 ? (
          <div className="log-empty">{captureActive ? '等待日志输出…' : '选择设备后点击“开始捕获”'}</div>
        ) : (
          <>
            {hiddenCount > 0 && (
              <div className="log-window-note">
                已隐藏较早的 {hiddenCount.toLocaleString()} 条，仅渲染最近 {renderedLogs.length.toLocaleString()} 条。可提高过滤精度或降低上限后查看完整历史。
              </div>
            )}
            {renderedLogs.map((log, index) => {
              const isActiveMatch =
                searchMatches.length > 0 && searchMatches[searchIndex] === index;
              return (
                <div
                  key={`${log.sessionId || 'unknown'}-${log.sequence ?? index}`}
                  className={`log-line level-${(log.level || 'I').toLowerCase()}${isActiveMatch ? ' log-line--active-match' : ''}`}
                >
                  <span className="log-timestamp">{log.timestamp}</span>
                  <span className="log-level" style={{ color: getLevelColor(log.level) }}>{log.level || 'I'}</span>
                  <span className="log-pid">{log.pid || '—'}</span>
                  <span className="log-tag">{highlightText(log.tag || '—', searchText)}</span>
                  <span className="log-message">{highlightText(log.message, searchText, isActiveMatch)}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export default LogViewer;
