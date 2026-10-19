import React, { useCallback, useEffect, useState } from 'react';
import { ProgressBar } from './common/Feedback';
import { cleanIpcError } from '../lib/errorText';

export default function DexToolkit() {
  const [status, setStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inputs, setInputs] = useState([]); // array of file paths
  const [outputDir, setOutputDir] = useState('');
  const [action, setAction] = useState('jar2dex');
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [revealEnabled, setRevealEnabled] = useState(false);
  const [revealPath, setRevealPath] = useState('');

  const operations = [
    { value: 'jar2dex', label: 'JAR → DEX' },
    { value: 'dex2jar', label: 'DEX → JAR' },
    { value: 'decompile-jar', label: '反编译 JAR' },
    { value: 'recompile-jar', label: '回编译 JAR' },
    { value: 'decompile-dex', label: '反编译 DEX' },
    { value: 'recompile-dex', label: '回编译 DEX' },
  ];

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

  // 进度订阅
  useEffect(() => {
    const off = window.electronAPI.onDexToolkitProgress((payload) => {
      setProgress(payload);
    });
    return off;
  }, []);

  const selectFiles = async () => {
    try {
      const files = await window.electronAPI.selectFiles({
        // 允许多种文件类型，后端会根据 action 过滤
        filters: [
          { name: '所有文件', extensions: ['*'] },
          { name: 'JAR', extensions: ['jar'] },
          { name: 'DEX', extensions: ['dex'] },
          { name: 'CLASS', extensions: ['class'] },
          { name: '目录', extensions: [] } // 目录无扩展名，特殊处理
        ],
        properties: ['openFile', 'openDirectory', 'multiSelection']
      });
      if (files && files.length > 0) {
        setInputs(files);
        setError('');
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

  const runAction = async () => {
    if (!inputs.length) {
      setError('请先选择输入文件或目录');
      return;
    }
    // 根据 action 检查必要的输出目录
    const needsOutput = ['decompile-jar', 'recompile-jar', 'decompile-dex', 'recompile-dex'].includes(action);
    if (needsOutput && !outputDir) {
      setError('请选择输出目录');
      return;
    }
    setError('');
    setResult(null);
    setRevealEnabled(false);
    setJobId(`dex-${Date.now()}`);
    try {
      const res = await window.electronAPI.dexToolkitRun({
        action,
        inputs,
        outputDir: needsOutput ? outputDir : undefined,
        jobId: jobId
      });
      if (!res?.ok) {
        setError(res?.error || '执行失败');
      } else {
        setResult(res);
        setRevealEnabled(true);
        setRevealPath(needsOutput ? outputDir : (res.outputDir || ''));
      }
    } catch (e) {
      setError(cleanIpcError(e, '执行出错'));
    } finally {
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

  if (refreshing && !status) return null;

  const tools = status?.tools ?? [];
  const dexTools = status?.dexTools ?? false;
  const d8 = status?.d8 ?? false;
  const javac = status?.javac ?? false;

  return (
    <div className="dex-toolkit">
      <div className="dex-toolkit__header">
        <h2>Dex 工具集</h2>
        <div className="dex-toolkit__status">
          <button onClick={refreshStatus} disabled={refreshing}>
            {refreshing ? '刷新中…' : '刷新状态'}
          </button>
          <span className="dex-toolkit__divider">|</span>
          <span>
            平台：{status?.platform ?? '未知'} {status?.windowsAutoInstall ? '(Windows 自动安装)' : ''}
          </span>
        </div>
      </div>

      <div className="dex-toolkit__tools">
        {tools.map((tool) => (
          <div key={tool.id} className={`dex-toolkit__tool ${tool.installed ? 'is-installed' : ''}`}>
            <div className="dex-toolkit__tool-main">
              <div className="dex-toolkit__tool-name">{tool.name}</div>
              <div className="dex-toolkit__tool-note">{tool.note}</div>
              {(!tool.installed && !status?.windowsAutoInstall) && (
                <button
                  className="btn btn-sm"
                  onClick={() => window.electronAPI.dexToolkitDownload({ toolId: tool.id })}
                  disabled={false}
                >
                  在线下载
                </button>
              )}
            </div>
            <div className="dex-toolkit__tool-status">
              {tool.installed ? (
                <span className="status success">已安装</span>
              ) : (
                <>
                  <span className="status warning">未安装</span>
                  {(status?.windowsAutoInstall && process.platform === 'win32') && (
                    <button
                      className="btn btn-sm btn-outline"
                      onClick={() => window.electronAPI.dexToolkitDownload({ toolId: tool.id })}
                    >
                      一键安装
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        <div className="dex-toolkit__tool">
          <div className="dex-toolkit__tool-main">
            <div className="dex-toolkit__tool-name">dex-tools (d2j-dex2jar)</div>
            <div className="dex-toolkit__tool-note">DEX → JAR（含 .class）</div>
          </div>
          <div className="dex-toolkit__tool-status">
            {dexTools ? (
              <span className="status success">已安装</span>
            ) : (
              <span className="status warning">未安装</span>
            )}
          </div>
        </div>
        <div className="dex-toolkit__tool">
          <div className="dex-toolkit__tool-main">
            <div className="dex-toolkit__tool-name">d8</div>
            <div className="dex-toolkit__tool-note">DEX → DEX（优化）+ 桥梁</div>
          </div>
          <div className="dex-toolkit__tool-status">
            {d8 ? (
              <span className="status success">已安装</span>
            ) : (
              <span className="status warning">未安装</span>
            )}
          </div>
        </div>
        <div className="dex-toolkit__tool">
          <div className="dex-toolkit__tool-main">
            <div className="dex-toolkit__tool-name">javac/jar</div>
            <div className="dex-toolkit__tool-note">Java 编译 / 打包</div>
          </div>
          <div className="dex-toolkit__tool-status">
            {javac ? (
              <span className="status success">已安装</span>
            ) : (
              <span className="status warning">未安装</span>
            )}
          </div>
        </div>
      </div>

      <div className="dex-toolkit__section">
        <div className="dex-toolkit__row">
          <label>
            操作：
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              disabled={Boolean(jobId)}
            >
              {operations.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            输入：
            <button
              type="button"
              className="btn"
              onClick={selectFiles}
              disabled={Boolean(jobId)}
            >
              选择文件/目录
            </button>
            {inputs.length > 0 && (
              <span className="dex-toolkit__selected">
                已选 {inputs.length} 项
              </span>
            )}
          </label>
          {['decompile-jar', 'recompile-jar', 'decompile-dex', 'recompile-dex'].includes(action) && (
            <label>
              输出目录：
              <button
                type="button"
                className="btn"
                onClick={selectOutput}
                disabled={Boolean(jobId)}
              >
                选择目录
              </button>
              {outputDir && (
                <span className="dex-toolkit__selected">
                  {outputDir}
                </span>
              )}
            </label>
          )}
        </div>
        <div className="dex-toolkit__actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={runAction}
            disabled={Boolean(jobId) || !inputs.length}
          >
            {jobId ? '执行中…' : '开始执行'}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={reveal}
            disabled={!revealEnabled}
          >
            打开输出目录
          </button>
        </div>
      </div>

      {jobId && progress && (
        <ProgressBar
          percent={progress.percent}
          stage={progress.stage}
          detail={progress.detail}
          elapsedMs={0} // 可后续加入 useElapsed
          onCancel={() => {
            // TODO: 取消操作需要在主进程支持
          }}
        />
      )}

      {error && <div className="message error">{error}</div>}

      {result && (
        <div className="message success">
          执行完成{(jobId ? ` (ID: ${jobId})` : '')}{result.outputDir ? `，输出目录：${result.outputDir}` : ''}
        </div>
      )}
    </div>
  );
}