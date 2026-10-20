import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressBar, useElapsed } from './common/Feedback';
import { cleanIpcError } from '../lib/errorText';
import { copyTextWithToast } from '../lib/clipboard.js';

// 值与主进程 electron/dex-toolkit.js 的 ACTIONS 键一一对应，不要改动
const OPERATIONS = [
  { value: 'jar2dex', label: 'JAR → DEX', hint: 'jar 打包成 dex' },
  { value: 'dex2jar', label: 'DEX → JAR', hint: 'dex 还原成 jar' },
  { value: 'jar-decompile', label: '反编译 JAR', hint: 'jar / class → java 源码' },
  { value: 'jar-recompile', label: '回编译 JAR', hint: 'java 源码 → jar' },
  { value: 'dex-decompile', label: '反编译 DEX', hint: 'dex → smali' },
  { value: 'dex-recompile', label: '回编译 DEX', hint: 'smali → dex' },
  { value: 'odex-decompile', label: '反编译 ODEX', hint: 'odex / vdex → 提取 dex → smali' }
];

export default function DexToolkit() {
  const [status, setStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inputs, setInputs] = useState([]); // 选中的文件 / 目录路径
  const [outputDir, setOutputDir] = useState('');
  const [action, setAction] = useState('jar2dex');
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState(null);
  const [download, setDownload] = useState(null); // { toolId, percent, stage, detail }
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [revealPath, setRevealPath] = useState('');
  // 查壳 / 启动命令：两者都从同一个 APK 读取
  const [apkPath, setApkPath] = useState('');
  const [packerResult, setPackerResult] = useState(null);
  const [packerBusy, setPackerBusy] = useState(false);
  const [launchResult, setLaunchResult] = useState(null);
  const [launchBusy, setLaunchBusy] = useState(false);
  // 当前任务 id：进度事件按它过滤，避免上一个任务的进度串到界面上
  const jobIdRef = useRef(null);

  const running = Boolean(jobId);
  const elapsedText = useElapsed(running);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const res = await window.electronAPI.dexToolkitStatus();
      setStatus(res);
    } catch (e) {
      setError(cleanIpcError(e, '获取 Dex 工具集状态失败'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // 进度订阅：下载任务（dex-dl-*）单独走 download 状态，其余按当前 jobId 过滤
  useEffect(() => {
    const off = window.electronAPI.onDexToolkitProgress((payload) => {
      if (!payload) return;
      const jid = typeof payload.jobId === 'string' ? payload.jobId : '';
      if (jid.startsWith('dex-dl-')) {
        setDownload({
          toolId: jid.slice('dex-dl-'.length),
          percent: payload.percent,
          stage: payload.stage,
          detail: payload.detail
        });
        return;
      }
      if (jid && jid !== jobIdRef.current) return;
      setProgress(payload);
    });
    return off;
  }, []);

  const selectFiles = async () => {
    try {
      const files = await window.electronAPI.selectFiles({
        filters: [
          { name: '所有文件', extensions: ['*'] },
          { name: 'JAR', extensions: ['jar'] },
          { name: 'DEX', extensions: ['dex'] },
          { name: 'CLASS', extensions: ['class'] }
        ],
        properties: ['openFile', 'openDirectory', 'multiSelections']
      });
      const list = Array.isArray(files) ? files : (files ? [files] : []);
      if (list.length > 0) {
        setInputs(list);
        setError('');
        // 输出目录默认与输入同目录：输入是目录取目录本身，是文件取所在文件夹
        const res = await window.electronAPI.dexToolkitDefaultOutput({ inputs: list });
        if (res?.ok && res.outputDir) setOutputDir(res.outputDir);
      }
    } catch (e) {
      setError(cleanIpcError(e, '选择文件失败'));
    }
  };

  const selectOutput = async () => {
    try {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setOutputDir(dir);
        setError('');
      }
    } catch (e) {
      setError(cleanIpcError(e, '选择输出目录失败'));
    }
  };

  const downloadTool = async (toolId) => {
    setError('');
    setDownload({ toolId, percent: 0, stage: '准备下载…' });
    try {
      const res = await window.electronAPI.dexToolkitDownload({ toolId });
      if (!res?.ok) setError(res?.error || '下载失败');
      else await refreshStatus();
    } catch (e) {
      setError(cleanIpcError(e, '下载失败'));
    } finally {
      setDownload(null);
    }
  };

  const selectToolDir = async (toolId) => {
    try {
      const dir = await window.electronAPI.selectDirectory();
      if (!dir) return;
      const res = await window.electronAPI.dexToolkitSetToolDir({ toolId, dir });
      if (!res?.ok) setError(res?.error || '设置工具目录失败');
      else await refreshStatus();
    } catch (e) {
      setError(cleanIpcError(e, '设置工具目录失败'));
    }
  };

  const clearToolDir = async (toolId) => {
    try {
      const res = await window.electronAPI.dexToolkitSetToolDir({ toolId, dir: '' });
      if (!res?.ok) setError(res?.error || '恢复默认目录失败');
      else await refreshStatus();
    } catch (e) {
      setError(cleanIpcError(e, '恢复默认目录失败'));
    }
  };

  const runAction = async () => {
    if (!Array.isArray(inputs) || !inputs.length) {
      setError('请先选择输入文件或目录');
      return;
    }
    // 所有操作都会写目录后缀 / 中间产物，统一要求用户选一个输出目录
    if (!outputDir) {
      setError('请选择输出目录');
      return;
    }
    setError('');
    setResult(null);
    setProgress(null);
    setRevealPath('');
    // setState 是异步的，直接读 jobId 会拿到旧值，这里用局部变量生成
    const runId = `dex-${Date.now()}`;
    jobIdRef.current = runId;
    setJobId(runId);
    try {
      const res = await window.electronAPI.dexToolkitRun({
        action,
        inputs,
        outputDir,
        jobId: runId
      });
      if (!res?.ok) {
        setError(res?.error || '执行失败');
      } else {
        setResult(res);
        setRevealPath(res.outputDir || outputDir);
      }
    } catch (e) {
      setError(cleanIpcError(e, '执行出错'));
    } finally {
      jobIdRef.current = null;
      setJobId(null);
    }
  };

  const reveal = async () => {
    if (!revealPath) return;
    try {
      await window.electronAPI.dexToolkitReveal(revealPath);
    } catch (e) {
      setError(cleanIpcError(e, '打开文件夹失败'));
    }
  };

  const selectApkFile = async () => {
    try {
      const file = await window.electronAPI.selectApk();
      if (file) {
        setApkPath(file);
        setPackerResult(null);
        setLaunchResult(null);
        setError('');
      }
    } catch (e) {
      setError(cleanIpcError(e, '选择 APK 失败'));
    }
  };

  const runCheckPacker = async () => {
    if (!apkPath) {
      setError('请先选择 APK 文件');
      return;
    }
    setError('');
    setPackerResult(null);
    setPackerBusy(true);
    try {
      const res = await window.electronAPI.dexToolkitCheckPacker({ filePath: apkPath });
      if (!res?.ok) setError(res?.error || '查壳失败');
      else setPackerResult(res);
    } catch (e) {
      setError(cleanIpcError(e, '查壳失败'));
    } finally {
      setPackerBusy(false);
    }
  };

  const runLaunchCommand = async () => {
    if (!apkPath) {
      setError('请先选择 APK 文件');
      return;
    }
    setError('');
    setLaunchResult(null);
    setLaunchBusy(true);
    try {
      const res = await window.electronAPI.dexToolkitLaunchCommand({ filePath: apkPath });
      if (!res?.ok) setError(res?.error || '生成启动命令失败');
      else setLaunchResult(res);
    } catch (e) {
      setError(cleanIpcError(e, '生成启动命令失败'));
    } finally {
      setLaunchBusy(false);
    }
  };

  const copyCommand = async (text) => {
    await copyTextWithToast(text, { successText: '命令已复制' });
  };

  if (refreshing && !status) {
    return <div className="content-card dex-toolkit"><div className="dex-empty">正在检测工具状态…</div></div>;
  }

  const tools = status?.tools ?? [];
  const installedCount = tools.filter((tool) => tool.installed).length;
  const busy = Boolean(download);

  return (
    <div className="content-card dex-toolkit">
      <header className="dex-header">
        <div className="dex-header__main">
          <h2>Dex 工具集</h2>
          <p>JAR / DEX 的双向转换与反编译，工具可下载或指定本地目录。</p>
        </div>
        <div className="dex-header__side">
          <span className={`dex-badge ${installedCount === tools.length && tools.length ? 'is-success' : 'is-warning'}`}>
            已就绪 {installedCount}/{tools.length}
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={refreshStatus} disabled={refreshing}>
            {refreshing ? '刷新中…' : '刷新状态'}
          </button>
        </div>
      </header>

      <div className="dex-body">
        <div className="dex-main">
          <section className="dex-panel">
            <div className="dex-panel__head">
              <h3>转换操作</h3>
              <span className="dex-panel__hint">选择一种转换方式</span>
            </div>
            <div className="dex-ops">
              {OPERATIONS.map((op) => (
                <button
                  key={op.value}
                  type="button"
                  className={`dex-op ${action === op.value ? 'is-active' : ''}`}
                  onClick={() => setAction(op.value)}
                  disabled={running}
                  title={op.hint}
                >
                  <span className="dex-op__label">{op.label}</span>
                  <span className="dex-op__hint">{op.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="dex-panel">
            <div className="dex-panel__head">
              <h3>执行</h3>
            </div>
            <div className="dex-fields">
              <div className="dex-field">
                <div className="dex-field__label">输入</div>
                <div className="dex-field__control">
                  <button type="button" className="btn btn-sm" onClick={selectFiles} disabled={running}>
                    选择文件 / 目录
                  </button>
                  <span className="dex-field__meta">
                    {inputs.length ? `已选 ${inputs.length} 项` : '未选择'}
                  </span>
                </div>
              </div>
              <div className="dex-field">
                <div className="dex-field__label">输出目录</div>
                <div className="dex-field__control">
                  <button type="button" className="btn btn-sm" onClick={selectOutput} disabled={running}>
                    选择目录
                  </button>
                  <span className="dex-field__meta dex-field__meta--path" title={outputDir}>
                    {outputDir || '未选择'}
                  </span>
                </div>
              </div>
            </div>

            {Array.isArray(inputs) && inputs.length ? (
              <ul className="dex-inputs">
                {inputs.slice(0, 8).map((item) => (
                  <li key={item} title={item}>{item}</li>
                ))}
                {inputs.length > 8 ? <li className="dex-inputs__more">…还有 {inputs.length - 8} 项</li> : null}
              </ul>
            ) : null}

            <div className="dex-run">
              <button type="button" className="btn btn-primary" onClick={runAction} disabled={running || !inputs.length}>
                {running ? '执行中…' : '开始执行'}
              </button>
              <button type="button" className="btn btn-outline" onClick={reveal} disabled={!revealPath}>
                打开输出目录
              </button>
            </div>
          </section>

          {running && progress ? (
            <ProgressBar
              percent={progress.percent}
              stage={progress.stage}
              detail={progress.detail}
              elapsedMs={elapsedText}
            />
          ) : null}

          {error ? <div className="message error">{error}</div> : null}

          {result ? (
            <div className="message success">
              执行完成{result.jobId ? `（ID: ${result.jobId}）` : ''}
              {result.outputDir ? `，输出目录：${result.outputDir}` : ''}
              {Array.isArray(result.failures) && result.failures.length ? (
                <div>
                  <strong>{result.failures.length} 项失败：</strong>
                  {result.failures.slice(0, 5).map((f, i) => {
                    const label = f.input ? String(f.input).split(/[\\/]/).pop() : f.error ? '(未知文件)' : '(未知)';
                    return (
                      <div key={i} style={{ opacity: 0.85, fontSize: '0.9em' }}>
                        · {label}（{f.error}）
                      </div>
                    );
                  })}
                  {result.failures.length > 5 ? <div style={{ opacity: 0.7 }}>…等 {result.failures.length - 5} 项</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <section className="dex-panel">
            <div className="dex-panel__head">
              <h3>查壳 / 启动命令</h3>
              <span className="dex-panel__hint">从 APK 直接解析，无需安装到设备</span>
            </div>
            <div className="dex-fields">
              <div className="dex-field">
                <div className="dex-field__label">APK 文件</div>
                <div className="dex-field__control">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={selectApkFile}
                    disabled={packerBusy || launchBusy}
                  >
                    选择 APK
                  </button>
                  <span className="dex-field__meta dex-field__meta--path" title={apkPath}>
                    {apkPath || '未选择'}
                  </span>
                </div>
              </div>
            </div>

            <div className="dex-run">
              <button
                type="button"
                className="btn btn-primary"
                onClick={runCheckPacker}
                disabled={!apkPath || packerBusy || launchBusy}
              >
                {packerBusy ? '查壳中…' : '查壳'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={runLaunchCommand}
                disabled={!apkPath || packerBusy || launchBusy}
              >
                {launchBusy ? '解析中…' : '生成启动命令'}
              </button>
            </div>

            {packerResult ? (
              <div className="dex-report">
                <div className="dex-report__row">
                  <span className="dex-report__label">加固结论</span>
                  <span
                    className={`dex-badge ${
                      packerResult.packed ? 'is-danger' : (packerResult.suspected ? 'is-warning' : 'is-success')
                    }`}
                  >
                    {packerResult.packed ? '已加固' : (packerResult.suspected ? '疑似加固' : '未发现加固')}
                  </span>
                </div>
                {packerResult.packer_name ? (
                  <div className="dex-report__row">
                    <span className="dex-report__label">加固方案</span>
                    <span>
                      {packerResult.packer_name}
                      {packerResult.packer_vendor ? ` · ${packerResult.packer_vendor}` : ''}
                    </span>
                  </div>
                ) : null}
                {Array.isArray(packerResult.packer_evidence) && packerResult.packer_evidence.length ? (
                  <div className="dex-report__row">
                    <span className="dex-report__label">特征依据</span>
                    <ul className="dex-evidence">
                      {packerResult.packer_evidence.slice(0, 6).map((item) => (
                        <li key={String(item)}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {Array.isArray(packerResult.matches) && packerResult.matches.length > 1 ? (
                  <div className="dex-report__row">
                    <span className="dex-report__label">其它命中</span>
                    <span>{packerResult.matches.slice(1).map((item) => item.packer_name).join('、')}</span>
                  </div>
                ) : null}
                <div className="dex-report__row">
                  <span className="dex-report__label">混淆程度</span>
                  <span>
                    {packerResult.obfuscated
                      ? `${packerResult.obfuscation_level}（短类名占比 ${(packerResult.short_class_ratio * 100).toFixed(0)}%）`
                      : '未发现明显混淆'}
                  </span>
                </div>
                {packerResult.hardening_enabled ? (
                  <div className="dex-report__row">
                    <span className="dex-report__label">对抗特征</span>
                    <span className="dex-tags">
                      {packerResult.hardening?.anti_debug ? <span className="dex-tag">反调试</span> : null}
                      {packerResult.hardening?.anti_vm ? <span className="dex-tag">反虚拟机</span> : null}
                      {packerResult.hardening?.anti_root ? <span className="dex-tag">反 Root</span> : null}
                      {packerResult.hardening?.string_encryption ? <span className="dex-tag">字符串加密</span> : null}
                      {packerResult.hardening?.integrity_check ? <span className="dex-tag">完整性校验</span> : null}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            {launchResult ? (
              <div className="dex-report">
                <div className="dex-report__row">
                  <span className="dex-report__label">包名</span>
                  <span><code>{launchResult.packageName}</code></span>
                </div>
                <div className="dex-report__row">
                  <span className="dex-report__label">入口 Activity</span>
                  <span><code>{launchResult.activity || '未找到'}</code></span>
                </div>
                <div className="dex-cmd">
                  <code>{launchResult.debugCommand}</code>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={() => copyCommand(launchResult.debugCommand)}
                  >
                    复制
                  </button>
                </div>
                <div className="dex-cmd">
                  <code>{launchResult.normalCommand}</code>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={() => copyCommand(launchResult.normalCommand)}
                  >
                    复制
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>

        <section className="dex-panel dex-side">
          <div className="dex-panel__head">
            <h3>依赖工具</h3>
            <span className="dex-panel__hint">
              {status?.windowsAutoInstall ? '支持一键安装' : '可下载或选目录'}
            </span>
          </div>
          <div className="dex-tools">
            {tools.map((tool) => {
              const isDownloading = download?.toolId === tool.id;
              return (
                <div key={tool.id} className={`dex-tool ${tool.installed ? 'is-installed' : 'is-missing'}`}>
                  <div className="dex-tool__head">
                    <span className="dex-tool__name">{tool.name}</span>
                    {tool.customDir ? <span className="dex-tag">自定义</span> : null}
                    <span className={`dex-badge ${tool.installed ? 'is-success' : 'is-warning'}`}>
                      {tool.installed ? '已安装' : '未安装'}
                    </span>
                  </div>
                  <div className="dex-tool__note">{tool.note}</div>
                  <div className="dex-tool__path" title={tool.locatedDir || ''}>
                    <span className="dex-tool__path-label">所在目录</span>
                    <code>{tool.locatedDir || '未找到'}</code>
                  </div>
                  {isDownloading ? (
                    <ProgressBar
                      compact
                      percent={download.percent}
                      stage={download.stage || '下载中…'}
                      detail={download.detail}
                    />
                  ) : null}
                  <div className="dex-tool__btns">
                    {tool.downloadable ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => downloadTool(tool.id)}
                        disabled={busy}
                      >
                        {isDownloading
                          ? '下载中…'
                          : tool.installed
                            ? '重新下载'
                            : status?.windowsAutoInstall
                              ? '一键安装'
                              : '下载'}
                      </button>
                    ) : null}
                    {tool.downloadable ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={() => selectToolDir(tool.id)}
                        disabled={busy}
                      >
                        选择目录
                      </button>
                    ) : null}
                    {tool.customDir ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={() => clearToolDir(tool.id)}
                        disabled={busy}
                      >
                        恢复默认
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
