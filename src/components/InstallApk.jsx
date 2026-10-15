import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ProgressBar, ToastStack, useToasts, useElapsed } from './common/Feedback';
import { cleanIpcError } from '../lib/errorText';

/** 拼接类名，避免条件表达式留下多余空格。 */
const cx = (...parts) => parts.filter(Boolean).join(' ');

const detectPlatform = (filePath) => {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.ipa')) return 'ios';
  if (lower.endsWith('.apk')) return 'android';
  return '';
};

const PLATFORM_LABEL = { android: 'Android', ios: 'iOS' };

const normalizeDevice = (device) => {
  if (typeof device === 'string') return { id: device, label: device };
  const id = device?.id || device?.deviceId || device?.udid || '';
  return {
    ...device,
    id,
    label: device?.label || device?.name || device?.displayName || id
  };
};

/** 客户端侧的文件分类（与 electron/install-batch.js 的口径保持一致）。 */
const classifyFile = (filePath) => {
  const name = String(filePath).split(/[\\/]/).pop() || filePath;
  const match = name.match(/\.([^.]+)$/);
  const ext = match ? match[1].toLowerCase() : '';
  const platform = ext === 'apk' ? 'android' : (ext === 'ipa' ? 'ios' : '');
  return {
    path: filePath,
    name,
    ext: ext.toUpperCase(),
    platform,
    platform_label: PLATFORM_LABEL[platform] || '未知',
    supported: Boolean(platform),
    status: 'pending',
    reason: '',
    message: ''
  };
};

const STATUS_META = {
  pending: { label: '待安装', tone: 'idle' },
  running: { label: '安装中', tone: 'running' },
  success: { label: '已安装', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'warn' }
};

/** 把外部传入的文件列表规范成内部结构（供静态预览 / 测试预填）。 */
const buildInitialFiles = (files) => (Array.isArray(files) ? files : [])
  .map((entry) => {
    if (!entry) return null;
    if (typeof entry === 'string') return classifyFile(entry);
    if (!entry.path) return null;
    return { ...classifyFile(entry.path), ...entry };
  })
  .filter(Boolean);

/**
 * @param {object} [props] 生产环境不传任何 props；
 *   initialMode / initialPlatform / initialPackagePath / initialFiles /
 *   initialDevices / initialDevice / initialSummary / initialProgress /
 *   initialRunning / initialElapsedMs
 *   仅用于把真实数据静态渲染成 HTML 预览页（tools/make-preview.js）。
 */
function InstallApk({
  initialMode,
  initialPlatform,
  initialPackagePath,
  initialFiles,
  initialDevices,
  initialDevice,
  initialSummary,
  initialProgress,
  initialRunning,
  initialElapsedMs
} = {}) {
  const [mode, setMode] = useState(initialMode === 'batch' ? 'batch' : 'single');
  const [packagePath, setPackagePath] = useState(initialPackagePath || '');
  const [batchFiles, setBatchFiles] = useState(() => buildInitialFiles(initialFiles));
  const [platform, setPlatform] = useState(initialPlatform === 'ios' ? 'ios' : 'android');
  const [devices, setDevices] = useState(() => (
    Array.isArray(initialDevices) ? initialDevices.map(normalizeDevice).filter((device) => device.id) : []
  ));
  const [selectedDevice, setSelectedDevice] = useState(initialDevice || '');
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialRunning) && initialMode !== 'batch');
  const [progress, setProgress] = useState(() => {
    const value = Number(initialProgress?.percent);
    return Number.isFinite(value) ? value : 0;
  });
  const [progressStage, setProgressStage] = useState(initialProgress?.stage || '');
  const [batchRunning, setBatchRunning] = useState(Boolean(initialRunning));
  const [batchProgress, setBatchProgress] = useState(initialProgress || null);
  const [batchSummary, setBatchSummary] = useState(initialSummary || null);
  const [dragging, setDragging] = useState(false);

  const jobRef = useRef(null);
  // 预填了设备就说明是静态预览，不必再去探测一遍
  const skipAutoLoad = useRef(Array.isArray(initialDevices) && initialDevices.length > 0);
  const { toasts, push, dismiss } = useToasts();
  const busy = loading || batchRunning;
  const liveElapsed = useElapsed(busy);
  // 静态预览时计时器不会真的跑，用预置值把耗时展示出来
  const elapsed = busy ? liveElapsed : (Number(initialElapsedMs) || 0);

  const inferredPlatform = useMemo(() => detectPlatform(packagePath), [packagePath]);
  const activePlatform = inferredPlatform || platform;

  // 批量模式下，只有与目标设备类型一致的文件才会真正被安装
  const batchStats = useMemo(() => {
    const installable = batchFiles.filter((file) => file.supported && file.platform === activePlatform);
    const mismatched = batchFiles.filter((file) => file.supported && file.platform !== activePlatform);
    const unsupported = batchFiles.filter((file) => !file.supported);
    return {
      total: batchFiles.length,
      installable: installable.length,
      mismatched: mismatched.length,
      unsupported: unsupported.length
    };
  }, [batchFiles, activePlatform]);

  // ---------- 设备 ----------
  const loadDevices = async (targetPlatform = activePlatform) => {
    setDeviceLoading(true);
    try {
      const result = await window.electronAPI.getLogDevices(targetPlatform);
      const rawDevices = Array.isArray(result) ? result : result?.devices;
      const nextDevices = (Array.isArray(rawDevices) ? rawDevices : [])
        .map(normalizeDevice)
        .filter((device) => device.id);
      setDevices(nextDevices);
      setSelectedDevice((current) => (
        nextDevices.some((device) => device.id === current) ? current : (nextDevices[0]?.id || '')
      ));
      if (nextDevices.length === 0) {
        push({
          type: 'warning',
          text: targetPlatform === 'ios'
            ? '未检测到 iOS 设备。请解锁、连接 USB，并完成“信任此电脑”。'
            : '未检测到 Android 设备。请连接设备并开启 USB 调试。',
          timeout: 6000
        });
      }
    } catch (error) {
      setDevices([]);
      setSelectedDevice('');
      push({ type: 'error', text: '获取设备失败', detail: cleanIpcError(error) });
    } finally {
      setDeviceLoading(false);
    }
  };

  useEffect(() => {
    if (skipAutoLoad.current) return;
    loadDevices(activePlatform);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlatform]);

  // ---------- 单个安装进度 ----------
  useEffect(() => {
    if (!window.electronAPI.onInstallProgress) return undefined;
    return window.electronAPI.onInstallProgress((payload) => {
      const percent = Math.max(0, Math.min(100, Number(payload?.percent) || 0));
      setProgress(percent);
      if (payload?.stage) setProgressStage(payload.stage);
    });
  }, []);

  // ---------- 批量安装进度 ----------
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onInstallBatchProgress) return undefined;
    return api.onInstallBatchProgress((payload) => {
      if (!payload) return;
      if (jobRef.current && payload.jobId && payload.jobId !== jobRef.current) return;

      if (payload.phase === 'start') {
        setBatchFiles((payload.items || []).map((item) => ({ ...item })));
        setBatchProgress({ percent: 0, stage: payload.stage });
        return;
      }
      if (payload.phase === 'item') {
        setBatchFiles((list) => list.map((file, index) => (
          index === payload.index ? { ...payload.item } : file
        )));
        if (typeof payload.percent === 'number') {
          setBatchProgress((current) => ({ ...current, percent: payload.percent, stage: payload.stage }));
        }
        return;
      }
      if (payload.phase === 'progress') {
        setBatchProgress({ percent: payload.percent, stage: payload.stage, itemPercent: payload.item_percent });
        // 同步当前文件的内部进度，表格里那一行才有自己的进度条
        if (typeof payload.index === 'number') {
          setBatchFiles((list) => list.map((file, index) => (
            index === payload.index
              ? { ...file, status: 'running', itemPercent: payload.item_percent }
              : file
          )));
        }
        return;
      }
      if (payload.phase === 'done') {
        setBatchFiles((payload.items || []).map((item) => ({ ...item })));
        setBatchProgress({ percent: 100, stage: payload.stage });
        setBatchSummary(payload.summary);
      }
    });
  }, []);

  // ---------- 选择文件 ----------
  const selectPackage = async () => {
    const selector = window.electronAPI.selectAppPackage || window.electronAPI.selectApk;
    const nextPath = await selector();
    if (!nextPath) return;
    setPackagePath(nextPath);
    const nextPlatform = detectPlatform(nextPath) || platform;
    setPlatform(nextPlatform);
  };

  const addBatchFiles = (paths) => {
    const incoming = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!incoming.length) return;
    setBatchFiles((current) => {
      const known = new Set(current.map((file) => file.path));
      const added = [];
      let duplicates = 0;
      let unsupported = 0;
      for (const filePath of incoming) {
        if (known.has(filePath)) { duplicates += 1; continue; }
        known.add(filePath);
        const info = classifyFile(filePath);
        if (!info.supported) unsupported += 1;
        added.push(info);
      }
      if (duplicates) {
        push({ type: 'info', text: `已忽略 ${duplicates} 个重复文件`, timeout: 3000 });
      }
      if (unsupported) {
        push({ type: 'warning', text: `${unsupported} 个文件类型不受支持`, detail: '仅支持 .apk / .ipa', timeout: 5000 });
      }
      return [...current, ...added];
    });
    setBatchSummary(null);
  };

  const selectBatchFiles = async () => {
    const api = window.electronAPI;
    if (!api?.selectAppPackages) {
      push({ type: 'error', text: '当前版本不支持多选，请升级' });
      return;
    }
    const paths = await api.selectAppPackages();
    if (!paths?.length) return;
    addBatchFiles(paths);
  };

  const removeBatchFile = (filePath) => {
    setBatchFiles((current) => current.filter((file) => file.path !== filePath));
  };

  const clearBatchFiles = () => {
    setBatchFiles([]);
    setBatchSummary(null);
    setBatchProgress(null);
  };

  // ---------- 拖拽导入 ----------
  const onDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  };

  const onDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    const paths = files.map((file) => file.path).filter(Boolean);
    if (!paths.length) {
      push({ type: 'warning', text: '无法获取拖入文件的路径，请改用「浏览」按钮' });
      return;
    }
    if (mode === 'single') {
      setPackagePath(paths[0]);
      setPlatform(detectPlatform(paths[0]) || platform);
      if (paths.length > 1) {
        push({ type: 'info', text: `已载入第 1 个文件；批量安装请切换到「批量安装」`, timeout: 5000 });
      }
      return;
    }
    addBatchFiles(paths);
  };

  // ---------- 单个安装 ----------
  const installPackage = async () => {
    if (!packagePath) {
      push({ type: 'error', text: '请先选择 APK 或 IPA 安装包' });
      return;
    }
    if (!selectedDevice) {
      push({ type: 'error', text: '请选择目标设备' });
      return;
    }

    setLoading(true);
    setProgress(5);
    setProgressStage('准备安装');
    const startedAt = Date.now();
    try {
      const installer = window.electronAPI.installApp
        ? window.electronAPI.installApp(packagePath, selectedDevice, activePlatform)
        : window.electronAPI.installApk(packagePath, selectedDevice);
      const result = await installer;
      setProgress(100);
      setProgressStage('安装完成');
      push({
        type: 'success',
        text: result?.message || '安装成功',
        detail: `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
        timeout: 6000
      });
    } catch (error) {
      push({ type: 'error', text: '安装失败', detail: cleanIpcError(error), timeout: 0 });
    } finally {
      setLoading(false);
    }
  };

  // ---------- 批量安装 ----------
  const startBatchInstall = async () => {
    const api = window.electronAPI;
    if (!api?.installAppBatch) {
      push({ type: 'error', text: '当前版本不支持批量安装' });
      return;
    }
    if (!batchFiles.length) {
      push({ type: 'error', text: '请先添加要安装的应用包' });
      return;
    }
    if (!selectedDevice) {
      push({ type: 'error', text: '请选择目标设备' });
      return;
    }
    if (!batchStats.installable) {
      push({
        type: 'error',
        text: '没有可安装的包体',
        detail: `选中的文件都与目标设备类型（${PLATFORM_LABEL[activePlatform]}）不符`
      });
      return;
    }

    const jobId = `install-batch-ui-${Date.now()}`;
    jobRef.current = jobId;
    setBatchRunning(true);
    setBatchSummary(null);
    setBatchProgress({ percent: 0, stage: '准备批量安装' });
    setBatchFiles((current) => current.map((file) => ({ ...file, status: 'pending', reason: '', message: '' })));

    const startedAt = Date.now();
    try {
      const result = await api.installAppBatch({
        files: batchFiles.map((file) => file.path),
        deviceId: selectedDevice,
        platform: activePlatform,
        jobId
      });
      setBatchFiles((result?.items || []).map((item) => ({ ...item })));
      setBatchSummary(result?.summary);
      const summary = result?.summary || {};
      push({
        type: summary.failed ? 'warning' : (result?.cancelled ? 'info' : 'success'),
        text: result?.message || '批量安装完成',
        detail: `耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒${summary.failures?.length ? ` · 首个失败：${summary.failures[0].message}` : ''}`,
        timeout: summary.failed ? 0 : 7000
      });
    } catch (error) {
      push({ type: 'error', text: '批量安装失败', detail: cleanIpcError(error), timeout: 0 });
    } finally {
      setBatchRunning(false);
      setBatchProgress(null);
      jobRef.current = null;
    }
  };

  const cancelBatchInstall = async () => {
    if (!jobRef.current) return;
    try {
      await window.electronAPI.cancelInstallBatch?.(jobRef.current);
      push({ type: 'info', text: '已请求取消，正在终止当前安装', timeout: 3500 });
    } catch (_) {
      // 忽略
    }
  };

  // ---------- 渲染辅助 ----------
  const renderStatus = (file) => {
    const meta = STATUS_META[file.status] || STATUS_META.pending;
    const detail = file.status === 'failed' ? file.message
      : (file.status === 'skipped' ? file.reason : '');
    return (
      <span className={`ia-status ia-status--${meta.tone}`} title={detail || undefined}>
        {meta.label}
        {file.status === 'running' && file.itemPercent != null ? ` ${file.itemPercent}%` : ''}
      </span>
    );
  };

  const showDeviceRow = (
    <div className="form-group">
      <label>目标设备</label>
      <div className="file-input-group">
        <select
          value={selectedDevice}
          onChange={(event) => setSelectedDevice(event.target.value)}
          disabled={busy || deviceLoading || devices.length === 0}
        >
          {deviceLoading ? (
            <option value="">正在检测设备…</option>
          ) : devices.length === 0 ? (
            <option value="">未检测到设备</option>
          ) : (
            devices.map((device) => (
              <option key={device.id} value={device.id}>{device.label}</option>
            ))
          )}
        </select>
        <button className="btn btn-secondary" onClick={() => loadDevices(activePlatform)} disabled={busy}>
          刷新设备
        </button>
      </div>
    </div>
  );

  const showPlatformRow = (
    <div className="form-group">
      <label>设备类型</label>
      <div className="file-input-group">
        <select
          value={activePlatform}
          onChange={(event) => {
            setPlatform(event.target.value);
            if (inferredPlatform && event.target.value !== inferredPlatform) setPackagePath('');
          }}
          disabled={busy}
        >
          <option value="android">Android（.apk）</option>
          <option value="ios">iOS（.ipa）</option>
        </select>
      </div>
    </div>
  );

  return (
    <div className="content-card">
      <h2>安装应用到设备</h2>
      <p className="install-lead">
        选择本机的 Android APK 或 iOS IPA，安装到当前连接的目标设备；支持一次装一个，也支持一次装一批。
      </p>

      <div className="ia-mode-tabs">
        <button
          type="button"
          className={cx('ia-mode-tab', mode === 'single' && 'is-active')}
          onClick={() => setMode('single')}
          disabled={busy}
        >
          单个安装
        </button>
        <button
          type="button"
          className={cx('ia-mode-tab', mode === 'batch' && 'is-active')}
          onClick={() => setMode('batch')}
          disabled={busy}
        >
          批量安装
          {batchFiles.length ? <span className="ia-mode-tab__badge">{batchFiles.length}</span> : null}
        </button>
      </div>

      {showPlatformRow}

      {mode === 'single' ? (
        <div className="form-group">
          <label>安装包</label>
          <div
            className={cx('file-input-group', 'ia-drop', dragging && 'is-dragging')}
            onDragOver={onDragOver}
            onDragEnter={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <input
              type="text"
              value={packagePath}
              readOnly
              placeholder={activePlatform === 'ios' ? '请选择 IPA 文件（也可以拖进来）' : '请选择 APK 文件（也可以拖进来）'}
            />
            <button className="btn btn-secondary" onClick={selectPackage} disabled={busy}>浏览</button>
          </div>
        </div>
      ) : (
        <div className="form-group">
          <label>
            安装包列表
            {batchStats.total ? <span className="ia-count">共 {batchStats.total} 个</span> : null}
          </label>
          <div
            className={cx('ia-drop', 'ia-drop--list', dragging && 'is-dragging')}
            onDragOver={onDragOver}
            onDragEnter={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {batchFiles.length ? (
              <div className="ia-list">
                {batchFiles.map((file, index) => {
                  const mismatched = file.supported && file.platform !== activePlatform;
                  const meta = STATUS_META[file.status] || STATUS_META.pending;
                  const showItemPercent = file.status === 'running' && file.itemPercent != null;
                  return (
                    <div key={file.path} className={cx('ia-row', `ia-row--${meta.tone}`, mismatched && 'is-mismatched')}>
                      <span className="ia-row__index">{index + 1}</span>
                      <div className="ia-row__main">
                        <div className="ia-row__name" title={file.path}>{file.name}</div>
                        <div className="ia-row__meta">
                          <span className={`ia-badge ia-badge--${file.platform || 'unknown'}`}>
                            {file.platform_label}
                          </span>
                          {file.size_human ? <span>{file.size_human}</span> : null}
                          {mismatched ? (
                            <span className="ia-row__warn">与目标设备（{PLATFORM_LABEL[activePlatform]}）不符，将被跳过</span>
                          ) : null}
                          {!file.supported ? (
                            <span className="ia-row__warn">不支持的文件类型</span>
                          ) : null}
                          {file.status === 'failed' && file.message ? (
                            <span className="ia-row__error" title={file.message}>{file.message}</span>
                          ) : null}
                          {file.status === 'skipped' && file.reason ? (
                            <span className="ia-row__skip" title={file.reason}>{file.reason}</span>
                          ) : null}
                        </div>
                        {showItemPercent ? (
                          <div className="ia-row__bar">
                            <div className="ia-row__bar-fill" style={{ width: `${file.itemPercent}%` }} />
                          </div>
                        ) : null}
                      </div>
                      <span className="ia-row__status">{renderStatus(file)}</span>
                      <button
                        type="button"
                        className="ia-row__remove"
                        title="移除"
                        disabled={busy}
                        onClick={() => removeBatchFile(file.path)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="ia-empty">
                还没有添加安装包 —— 点下方「添加文件」多选，或把多个 APK / IPA 直接拖到这里
              </div>
            )}
          </div>

          <div className="ia-list-actions">
            <button className="btn btn-secondary" onClick={selectBatchFiles} disabled={busy}>添加文件</button>
            <button className="btn btn-secondary" onClick={clearBatchFiles} disabled={busy || !batchFiles.length}>
              清空列表
            </button>
            {batchStats.mismatched || batchStats.unsupported ? (
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => setBatchFiles((current) => current.filter((file) => (
                  file.supported && file.platform === activePlatform
                )))}
              >
                仅保留可安装的 {batchStats.installable} 个
              </button>
            ) : null}
          </div>
        </div>
      )}

      {showDeviceRow}

      <div className="action-buttons">
        {mode === 'single' ? (
          <button
            className="btn btn-primary"
            onClick={installPackage}
            disabled={busy || !packagePath || !selectedDevice}
          >
            {loading ? '安装中…' : `安装到${activePlatform === 'ios' ? ' iOS' : ' Android'} 设备`}
          </button>
        ) : (
          <>
            <button
              className="btn btn-primary"
              onClick={startBatchInstall}
              disabled={busy || !selectedDevice || !batchStats.installable}
            >
              {batchRunning ? '批量安装中…' : `批量安装（${batchStats.installable} 个）`}
            </button>
            {batchRunning ? (
              <button className="btn btn-secondary" type="button" onClick={cancelBatchInstall}>取消</button>
            ) : null}
          </>
        )}
      </div>

      {mode === 'single' && loading ? (
        <ProgressBar
          percent={progress}
          stage={progressStage || '安装中'}
          elapsedMs={elapsed}
        />
      ) : null}

      {mode === 'batch' && (batchRunning || batchProgress) ? (
        <ProgressBar
          percent={batchProgress?.percent}
          stage={batchProgress?.stage || '批量安装中'}
          elapsedMs={elapsed}
          onCancel={batchRunning ? cancelBatchInstall : undefined}
        />
      ) : null}

      {mode === 'batch' && batchSummary && !batchRunning ? (
        <div className="ia-summary">
          <span className="ia-summary__item ia-summary__item--ok">成功 {batchSummary.success}</span>
          {batchSummary.failed ? <span className="ia-summary__item ia-summary__item--danger">失败 {batchSummary.failed}</span> : null}
          {batchSummary.skipped ? <span className="ia-summary__item ia-summary__item--warn">跳过 {batchSummary.skipped}</span> : null}
          <span className="ia-summary__item">共 {batchSummary.total}</span>
        </div>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export default InstallApk;
