import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressBar } from './common/Feedback';
import { cleanIpcError } from '../lib/errorText';

/**
 * Windows 缺失工具一键安装。
 *
 * 只在 Windows 渲染：mac 有 brew、Linux 有包管理器，一条命令的事，
 * 没必要在应用里再实现一套下载逻辑（Electron 包体也得为此变大）。
 *
 * 安装位置是 %APPDATA%\日常开发工具箱\tools\，不动系统 PATH、不写注册表，
 * 所以不需要管理员权限；装完主进程会刷新工具搜索目录，立即生效，不用重启应用。
 */

// 与主进程 installTool 里 emit 的 stage 一致；「重试」是换镜像时的中间态
const STAGE_LABELS = ['准备', '下载', '解压', '安装', '完成', '重试'];

function useElapsed(active) {
  const [ms, setMs] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!active) return undefined;
    startRef.current = Date.now();
    setMs(0);
    const timer = setInterval(() => setMs(Date.now() - startRef.current), 200);
    return () => clearInterval(timer);
  }, [active]);
  return ms;
}

export default function ToolInstaller({ onInstalled }) {
  const [state, setState] = useState({ supported: false, tools: [], root: '' });
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.toolInstallerList();
      setState({
        supported: Boolean(result?.supported),
        tools: result?.tools || [],
        root: result?.root || ''
      });
    } catch (listError) {
      setError(cleanIpcError(listError, '读取可安装工具失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 进度事件带 toolId，只收当前正在装的那一个，避免并发时串台
  useEffect(() => {
    const off = window.electronAPI.onToolInstallProgress((payload) => {
      if (!payload || payload.toolId !== job) return;
      setProgress(payload);
    });
    return off;
  }, [job]);

  const elapsedMs = useElapsed(Boolean(job));

  const install = async (toolId) => {
    setError('');
    setProgress(null);
    setJob(toolId);
    try {
      const result = await window.electronAPI.toolInstallerInstall(toolId);
      if (!result?.ok) {
        setError(result?.error || '安装失败');
      } else if (result.skipped !== true) {
        onInstalled?.();
      }
      await refresh();
    } catch (installError) {
      setError(cleanIpcError(installError, '安装失败'));
    } finally {
      setJob(null);
      setProgress(null);
    }
  };

  const cancel = () => {
    if (job) window.electronAPI.toolInstallerCancel(job);
    setJob(null);
    setProgress(null);
  };

  const uninstall = async (toolId) => {
    setError('');
    try {
      await window.electronAPI.toolInstallerUninstall(toolId);
      await refresh();
      onInstalled?.();
    } catch (removeError) {
      setError(cleanIpcError(removeError, '清理失败'));
    }
  };

  if (loading || !state.supported) return null;

  const busy = Boolean(job);
  const steps = STAGE_LABELS.map((label, index) => {
    const currentIndex = progress ? STAGE_LABELS.indexOf(progress.stage) : -1;
    return { label, done: currentIndex > index || progress?.percent === 100, active: currentIndex === index };
  });

  return (
    <div className="tool-installer">
      <div className="tool-installer__head">
        <div>
          <div className="tool-installer__title">一键安装缺失工具</div>
          <div className="tool-installer__hint">
            下载到 <code>{state.root}</code>，不改动系统 PATH，无需管理员权限；装完立即生效。
            GitHub 源较慢时会自动尝试国内镜像。
          </div>
        </div>
      </div>

      <div className="tool-installer__list">
        {state.tools.map((tool) => (
          <div key={tool.id} className={`tool-installer__item ${tool.installed ? 'is-installed' : ''}`}>
            <div className="tool-installer__main">
              <div className="tool-installer__name">{tool.name}</div>
              <div className="tool-installer__note">{tool.providesNote}</div>
              <div className="tool-installer__meta">
                {tool.installed ? (
                  <span title={tool.dir || ''}>已安装 · v{tool.version}</span>
                ) : (
                  <span>约 {(tool.approxBytes / 1024 / 1024).toFixed(0)} MB</span>
                )}
              </div>
            </div>
            <div className="tool-installer__actions">
              {tool.installed ? (
                <>
                  <span className="tool-installer__badge">已安装</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => uninstall(tool.id)}
                    disabled={busy}
                  >
                    清理
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => install(tool.id)}
                  disabled={busy}
                >
                  {job === tool.id ? '安装中…' : '安装'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {busy && progress && (
        <ProgressBar
          percent={progress.percent}
          stage={progress.stage}
          detail={progress.detail}
          elapsedMs={elapsedMs}
          onCancel={cancel}
          steps={steps}
        />
      )}

      {busy && !progress && (
        <ProgressBar percent={null} stage="准备" detail="正在连接下载地址…" elapsedMs={elapsedMs} onCancel={cancel} />
      )}

      {error && <div className="message error">{error}</div>}
    </div>
  );
}
