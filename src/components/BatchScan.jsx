import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ProgressBar, ToastStack, useToasts, useElapsed } from './common/Feedback';
import { cleanIpcError } from '../lib/errorText';

/** 拼接 class，自动丢掉空值，避免出现多余空格。 */
const cx = (...parts) => parts.filter(Boolean).join(' ');

/** 表格列定义：key 与后端 BATCH_COLUMNS 对齐。 */
const COLUMNS = [
  { key: 'name', title: '文件名', width: 220, sticky: true },
  { key: 'type', title: '类型', width: 64 },
  { key: 'app_name', title: '应用名', width: 150 },
  { key: 'identifier', title: '包名 / Bundle ID', width: 230, mono: true },
  { key: 'version_name', title: '版本名称', width: 110 },
  { key: 'version_code', title: '版本号', width: 100, mono: true },
  { key: 'size_human', title: '体积', width: 92, align: 'right' },
  { key: 'min_os', title: '最低系统', width: 150 },
  { key: 'abis', title: '架构', width: 190 },
  { key: 'dex_count', title: 'DEX', width: 60, align: 'right' },
  { key: 'so_count', title: 'SO', width: 56, align: 'right' },
  { key: 'permission_count', title: '权限', width: 60, align: 'right' },
  { key: 'dangerous_permission_count', title: '危险权限', width: 82, align: 'right' },
  { key: 'component_count', title: '组件', width: 60, align: 'right' },
  { key: 'exported_component_count', title: '导出组件', width: 82, align: 'right' },
  { key: 'sdk_count', title: 'SDK', width: 60, align: 'right' },
  { key: 'sdk_names', title: '主要 SDK', width: 320 },
  { key: 'packed_by', title: '加固', width: 110 },
  { key: 'obfuscated', title: '混淆', width: 70 },
  { key: 'signature_type', title: '签名方式', width: 96 },
  { key: 'risk_score', title: '风险分', width: 80, align: 'right', risk: true },
  { key: 'risk_label', title: '风险等级', width: 92 },
  { key: 'error', title: '解析错误', width: 240 }
];

const RISK_LEVELS = [
  { id: 'all', label: '全部' },
  { id: 'critical', label: '严重' },
  { id: 'high', label: '高风险' },
  { id: 'medium', label: '中风险' },
  { id: 'low', label: '低风险' },
  { id: 'safe', label: '安全' }
];

const riskTone = (score) => {
  if (score >= 85) return 'critical';
  if (score >= 62) return 'high';
  if (score >= 38) return 'medium';
  if (score >= 14) return 'low';
  return 'safe';
};

const SORTABLE = new Set(['risk_score', 'size', 'permission_count', 'dangerous_permission_count', 'sdk_count', 'dex_count', 'so_count']);

/**
 * 批量扫描包体。
 *
 * @param {Array}  initialRows      预置结果行（静态预览用）
 * @param {string} initialDirectory 预置目录（静态预览用）
 * @param {object} initialResult    预置扫描摘要（静态预览用）
 * @param {boolean} embedded        嵌入「读取应用信息」页时去掉外层卡片与标题
 */
function BatchScan({ initialRows = null, initialDirectory = '', initialResult = null, embedded = false }) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [recursive, setRecursive] = useState(true);
  const [rows, setRows] = useState(initialRows || []);
  const [result, setResult] = useState(initialResult);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'risk_score', desc: true });
  const [expanded, setExpanded] = useState(null);
  const [dragging, setDragging] = useState(false);

  const jobRef = useRef(null);
  const { toasts, push, dismiss } = useToasts();
  const elapsed = useElapsed(scanning);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onBatchScanProgress) return undefined;
    const off = api.onBatchScanProgress((payload) => {
      if (!payload) return;
      if (jobRef.current && payload.jobId && payload.jobId !== jobRef.current) return;
      if (payload.partial && payload.row) {
        setRows((list) => [...list, payload.row]);
        return;
      }
      setProgress({
        percent: typeof payload.percent === 'number' ? payload.percent : null,
        stage: payload.stage || '扫描中',
        detail: payload.detail || '',
        index: payload.index,
        total: payload.total
      });
    });
    return off;
  }, []);

  const pickDirectory = async () => {
    const api = window.electronAPI;
    if (!api?.selectPackageDirectory) {
      push({ type: 'error', text: '当前版本不支持目录选择，请升级' });
      return;
    }
    const res = await api.selectPackageDirectory();
    if (res?.canceled || !res?.directory) return;
    setDirectory(res.directory);
    setRows([]);
    setResult(null);
  };

  const onDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file?.path) {
      push({ type: 'warning', text: '无法获取拖入路径，请改用「选择目录」' });
      return;
    }
    // 拖进来的是文件时，取其所在目录
    const target = /\.[a-z0-9]+$/i.test(file.path) ? file.path.replace(/[\\/][^\\/]*$/, '') : file.path;
    setDirectory(target);
    setRows([]);
    setResult(null);
  };

  const runScan = async () => {
    if (!directory) {
      push({ type: 'error', text: '请先选择要扫描的目录' });
      return;
    }
    const api = window.electronAPI;
    if (!api?.batchScanPackages) {
      push({ type: 'error', text: '当前版本不支持批量扫描' });
      return;
    }
    const jobId = `batch-ui-${Date.now()}`;
    jobRef.current = jobId;
    setScanning(true);
    setRows([]);
    setResult(null);
    setExpanded(null);
    setProgress({ percent: 0, stage: '正在收集包体文件', detail: '' });

    const startedAt = Date.now();
    try {
      const res = await api.batchScanPackages({ directory, recursive, jobId, limit: 500 });
      setResult(res);
      setRows(res?.rows || []);
      push({
        type: res?.failed ? 'warning' : 'success',
        text: `扫描完成：${res?.succeeded || 0} 个成功${res?.failed ? `，${res.failed} 个失败` : ''}`,
        detail: `共 ${res?.total || 0} 个包体 · 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`,
        timeout: 6000
      });
    } catch (error) {
      push({ type: 'error', text: '扫描失败', detail: cleanIpcError(error), timeout: 0 });
    } finally {
      setScanning(false);
      setProgress(null);
      jobRef.current = null;
    }
  };

  const stopScan = async () => {
    if (!jobRef.current) return;
    try {
      const res = await window.electronAPI.cancelBatchScan?.(jobRef.current);
      // 别无条件报「已请求停止」——扫描可能刚好自己结束了，这时请求不会生效
      if (res?.success) {
        push({ type: 'info', text: res.message || '已请求停止，当前包解析完成后停止', timeout: 3500 });
      } else {
        push({
          type: 'warning',
          text: res?.message || '停止请求未生效',
          detail: '扫描可能已经结束',
          timeout: 4000
        });
      }
    } catch (error) {
      push({ type: 'error', text: '停止扫描失败', detail: cleanIpcError(error) });
    }
  };

  const exportResult = async (format) => {
    if (!rows.length) {
      push({ type: 'error', text: '没有可导出的结果' });
      return;
    }
    try {
      const res = await window.electronAPI.exportBatchScanResult({ rows, format });
      if (res?.success) {
        push({ type: 'success', text: `已导出 ${res.count} 行（${format.toUpperCase()}）`, detail: res.filePath, timeout: 6000 });
      }
    } catch (error) {
      push({ type: 'error', text: '导出失败', detail: cleanIpcError(error) });
    }
  };

  const onSort = useCallback((key) => {
    if (!SORTABLE.has(key)) return;
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }));
  }, []);

  const visibleRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    let list = rows;

    if (level !== 'all') {
      list = list.filter((row) => riskTone(row.risk_score) === level);
    }
    if (keyword) {
      list = list.filter((row) => (
        String(row.name || '').toLowerCase().includes(keyword)
        || String(row.app_name || '').toLowerCase().includes(keyword)
        || String(row.identifier || '').toLowerCase().includes(keyword)
        || String(row.sdk_names || '').toLowerCase().includes(keyword)
      ));
    }
    if (SORTABLE.has(sort.key)) {
      const factor = sort.desc ? -1 : 1;
      list = [...list].sort((a, b) => (Number(a[sort.key] || 0) - Number(b[sort.key] || 0)) * factor);
    }
    return list;
  }, [rows, level, search, sort]);

  const stats = useMemo(() => {
    if (!rows.length) return null;
    const ok = rows.filter((row) => !row.error);
    const scores = ok.map((row) => Number(row.risk_score) || 0);
    const totalSize = ok.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
    return {
      total: rows.length,
      failed: rows.length - ok.length,
      avgRisk: ok.length ? Math.round(scores.reduce((a, b) => a + b, 0) / ok.length) : 0,
      maxRisk: scores.length ? Math.max(...scores) : 0,
      critical: ok.filter((row) => riskTone(row.risk_score) === 'critical').length,
      high: ok.filter((row) => riskTone(row.risk_score) === 'high').length,
      packed: ok.filter((row) => row.packed || row.packed_by).length,
      totalSize
    };
  }, [rows]);

  const humanSize = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  };

  return (
    <div className={embedded ? 'package-info-embed' : 'content-card'}>
      {embedded ? null : <h2>批量扫描包体</h2>}
      <p className="pi-hint">
        选中一个目录，自动扫描其中所有 APK / AAB / IPA，汇总版本、体积、权限、SDK 与风险分，可导出 CSV / JSON / Markdown。
      </p>

      <div className="form-group">
        <label>扫描目录</label>
        <div
          className={cx('file-input-group', 'pi-drop', dragging && 'is-dragging')}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
          onDrop={onDrop}
        >
          <input type="text" value={directory} readOnly placeholder="选择目录，或把文件夹拖到这里" />
          <button className="btn btn-secondary" onClick={pickDirectory} disabled={scanning}>选择目录</button>
        </div>
      </div>

      <div className="pi-options">
        <label className="pi-check">
          <input type="checkbox" checked={recursive} disabled={scanning} onChange={(e) => setRecursive(e.target.checked)} />
          包含子目录
        </label>
        <span className="pi-options__note">单次最多扫描 500 个包体</span>
      </div>

      <div className="action-buttons">
        <button className="btn btn-primary" onClick={runScan} disabled={scanning || !directory}>
          {scanning ? '扫描中…' : '开始扫描'}
        </button>
        {rows.length ? (
          <>
            <button className="btn btn-secondary" type="button" onClick={() => exportResult('csv')}>导出 CSV</button>
            <button className="btn btn-secondary" type="button" onClick={() => exportResult('json')}>导出 JSON</button>
            <button className="btn btn-secondary" type="button" onClick={() => exportResult('markdown')}>导出 Markdown</button>
          </>
        ) : null}
      </div>

      {scanning || progress ? (
        <ProgressBar
          percent={progress?.percent}
          stage={progress?.stage || '正在扫描'}
          detail={progress?.detail}
          elapsedMs={elapsed}
          onCancel={scanning ? stopScan : undefined}
        />
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {stats ? (
        <div className="pi-stats">
          <div className="pi-stat">
            <span className="pi-stat__value">{stats.total}</span>
            <span className="pi-stat__label">包体总数</span>
          </div>
          <div className={cx('pi-stat', stats.failed && 'pi-stat--warn')}>
            <span className="pi-stat__value">{stats.failed}</span>
            <span className="pi-stat__label">解析失败</span>
          </div>
          <div className="pi-stat">
            <span className="pi-stat__value">{stats.avgRisk}</span>
            <span className="pi-stat__label">平均风险分</span>
          </div>
          <div className={cx('pi-stat', stats.maxRisk >= 85 && 'pi-stat--danger')}>
            <span className="pi-stat__value">{stats.maxRisk}</span>
            <span className="pi-stat__label">最高风险分</span>
          </div>
          <div className="pi-stat">
            <span className="pi-stat__value">{stats.critical + stats.high}</span>
            <span className="pi-stat__label">高危包体</span>
          </div>
          <div className="pi-stat">
            <span className="pi-stat__value">{stats.packed}</span>
            <span className="pi-stat__label">已加固</span>
          </div>
          <div className="pi-stat">
            <span className="pi-stat__value">{humanSize(stats.totalSize)}</span>
            <span className="pi-stat__label">总体积</span>
          </div>
        </div>
      ) : null}

      {rows.length ? (
        <>
          <div className="pi-toolbar">
            <div className="pi-filter">
              {RISK_LEVELS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cx('pi-filter__btn', level === item.id && 'is-active')}
                  onClick={() => setLevel(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <input
              className="pi-search pi-search--inline"
              type="search"
              value={search}
              placeholder="搜索文件名 / 应用名 / 包名 / SDK"
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="pi-toolbar__count">{visibleRows.length} / {rows.length}</span>
          </div>

          <div className="pi-batch-table-wrap">
            <table className="pi-table pi-batch-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      style={{ width: column.width, minWidth: column.width }}
                      className={cx(
                        column.align === 'right' && 'is-right',
                        SORTABLE.has(column.key) && 'is-sortable',
                        sort.key === column.key && 'is-sorted'
                      )}
                      onClick={() => onSort(column.key)}
                      title={SORTABLE.has(column.key) ? '点击排序' : undefined}
                    >
                      {column.title}
                      {sort.key === column.key ? <span className="pi-sort-arrow">{sort.desc ? '↓' : '↑'}</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr
                    key={`${row.path}-${index}`}
                    className={row.error ? 'is-error' : ''}
                    onClick={() => setExpanded(expanded === index ? null : index)}
                  >
                    {COLUMNS.map((column) => {
                      const value = row[column.key];
                      if (column.risk) {
                        return (
                          <td key={column.key} className="is-right">
                            <span className={`pi-sev pi-sev--${riskTone(value)}`}>{value}</span>
                          </td>
                        );
                      }
                      if (column.key === 'obfuscated') {
                        return <td key={column.key} className="is-center">{value === true ? '是' : (value === false ? '否' : '—')}</td>;
                      }
                      return (
                        <td
                          key={column.key}
                          className={cx(column.align === 'right' && 'is-right', column.mono && 'pi-mono')}
                          title={typeof value === 'string' && value.length > 40 ? value : undefined}
                        >
                          {value === true ? '是' : (value === false ? '否' : (value === '' || value == null ? '—' : String(value)))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {expanded != null && visibleRows[expanded] ? (
            <div className="pi-row-detail">
              <div className="pi-row-detail__head">
                <strong>{visibleRows[expanded].name}</strong>
                <button type="button" className="pi-row-detail__close" onClick={() => setExpanded(null)}>收起</button>
              </div>
              <div className="pi-fields pi-fields--single">
                {Object.entries(visibleRows[expanded])
                  .filter(([, value]) => value !== '' && value != null && value !== false)
                  .map(([key, value]) => (
                    <div className="pi-field" key={key}>
                      <span className="pi-field__label">{key}</span>
                      <span className="pi-field__value pi-mono">{String(value)}</span>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {!rows.length && result ? (
        <div className="pi-empty">目录中没有找到 APK / AAB / IPA 文件</div>
      ) : null}
    </div>
  );
}

export default BatchScan;
