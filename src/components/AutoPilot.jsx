import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cleanIpcError } from '../lib/errorText';

/**
 * 13 天无人值守面板。
 *
 * **为什么独立组件**：脚本编辑器、轮询、状态卡片、按钮组足够大，塞回 IosMirror
 * 会让那个本来就有几百行的组件更糟。IosMirror 用 `<AutoPilot embedded />` 嵌入。
 *
 * **状态模型**：单点真相来自主进程 `autopilot:status`（snapshot），
 * UI 拿到 snapshot 后映射成三个状态：未运行 / 运行中-白班 / 运行中-夜间锁屏。
 *
 * **不做的事**：
 *   - 不解析/高亮脚本（用户应该用编辑器外的 JSON 编辑器写脚本），
 *     这里只显示「校验结果 + 步数」
 *   - 不订阅 ipcRenderer 推送（snapshot 轮询已经够简单够轻）
 */

const DEFAULT_SCRIPT = JSON.stringify({
  name: 'smoke-test',
  deviceId: '',
  steps: [
    { op: 'unlock' },
    { op: 'pressHome' },
    { op: 'launchApp', bundleId: 'com.apple.mobilesafari' },
    { op: 'wait', ms: 1500 },
    { op: 'screenshot', label: 'safari-home' }
  ]
}, null, 2);

/** 主进程只接受对象，不要在前端先 JSON.parse。返 null = 没改过。 */
function tryParseScript(text) {
  if (!text.trim()) return { ok: false, error: '脚本不能为空' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error.message}` };
  }
}

function describeSnapshot(snapshot) {
  if (!snapshot) return { tone: 'idle', label: '尚未启动' };
  if (!snapshot.running) return { tone: 'idle', label: '尚未启动' };
  if (snapshot.nightLocked) return { tone: 'night', label: '夜间锁屏休眠中' };
  return { tone: 'active', label: '白班运行中' };
}

function StatCard({ label, value }) {
  return (
    <div className="autopilot-stat">
      <div className="autopilot-stat__label">{label}</div>
      <div className="autopilot-stat__value">{value}</div>
    </div>
  );
}

function AutoPilot({ embedded = false, recorder = null }) {
  const [scriptText, setScriptText] = useState(DEFAULT_SCRIPT);
  const [parseResult, setParseResult] = useState({ ok: true, value: null });
  const [validateMessage, setValidateMessage] = useState(null);
  const [validateOk, setValidateOk] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);
  const [actionError, setActionError] = useState(null);
  const intervalRef = useRef(null);

  // 脚本改动 → 重新 parse（用于本地校验显示 + 启动按钮 enable/disable）
  useEffect(() => {
    const result = tryParseScript(scriptText);
    setParseResult(result);
    // 改了脚本，旧的「已通过校验」提示失效
    setValidateMessage(null);
    setValidateOk(null);
  }, [scriptText]);

  // 轮询 status：运行中才需要频繁查，停了就不必一直问
  useEffect(() => {
    function tick() {
      window.electronAPI.autopilotStatus?.()
        .then((res) => { if (res?.ok) setSnapshot(res.snapshot); })
        .catch(() => { /* 主进程还没起、或者命令未注册都不算错误 */ });
    }
    tick();
    intervalRef.current = setInterval(tick, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const parsedScript = parseResult.ok ? parseResult.value : null;
  const stepCount = parsedScript?.steps?.length ?? 0;
  const deviceIdOk = Boolean(parsedScript?.deviceId?.trim?.());
  const canStart = parseResult.ok && deviceIdOk && stepCount > 0 && !busy && !snapshot?.running;

  // ---------- 录制导入（差异化能力：真实操作 → 脚本） ----------
  const importRecorded = () => {
    const recorded = recorder?.buildScript?.();
    if (!recorded) {
      setActionError('录制里还没有任何操作：先在投屏画面上做几个动作（点、滑、按键）。');
      return;
    }
    if (recorded.steps.length === 0) {
      setActionError('录制里还没有任何操作。');
      return;
    }
    setScriptText(JSON.stringify(recorded, null, 2));
    setActionMessage(`已导入录制（${recorded.steps.length} 步），点「校验脚本」确认后即可启动调度。`);
  };

  const recorderNode = recorder ? (
    <div className="autopilot-recorder">
      <div className="autopilot-recorder__head">
        <span className={`autopilot-recorder__title ${recorder.recording ? 'is-recording' : ''}`}>
          {recorder.recording ? '● 录制中' : '操作录制'}
        </span>
        <span className="autopilot-recorder__count">
          {recorder.recording ? `已记 ${recorder.recordedCount} 步` : '未开始'}
        </span>
      </div>
      <p className="autopilot-recorder__lead">
        开启后在投屏画面上正常操作（点、滑、按键、启动 App、缩放），
        每一步连同动作间隔一起记下来，转成无人值守脚本 —— 不用手写坐标。
      </p>
      <div className="autopilot-actions">
        <button
          className={`btn btn-sm ${recorder.recording ? 'btn-danger' : 'btn-primary'}`}
          onClick={recorder.onToggle}
        >
          {recorder.recording ? '停止录制' : '开始录制'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={importRecorded}
          disabled={recorder.recording}
          title={recorder.recording ? '先停止录制再导入' : '把已录制的操作填进脚本编辑器'}
        >
          导入为脚本
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={recorder.onClear}
          disabled={recorder.recording || recorder.recordedCount === 0}
        >
          清空
        </button>
      </div>
    </div>
  ) : null;

  async function handleValidate() {
    if (!parsedScript) {
      setValidateOk(false);
      setValidateMessage(parseResult.error || '脚本无法解析');
      return;
    }
    setBusy(true);
    setValidateMessage(null);
    setValidateOk(null);
    try {
      const res = await window.electronAPI.autopilotValidate?.(parsedScript);
      if (res?.ok) {
        setValidateOk(true);
        setValidateMessage(`校验通过：${res.name}（${res.stepCount} 步）`);
      } else {
        setValidateOk(false);
        setValidateMessage(res?.error || '校验失败');
      }
    } catch (error) {
      setValidateOk(false);
      setValidateMessage(cleanIpcError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    if (!parsedScript) return;
    setBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const res = await window.electronAPI.autopilotStart?.(parsedScript);
      if (res?.ok) {
        setActionMessage(`已启动：${res.scriptName}（${res.stepCount} 步）`);
      } else {
        setActionError(res?.error || '启动失败');
      }
    } catch (error) {
      setActionError(cleanIpcError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const res = await window.electronAPI.autopilotStop?.();
      if (res?.ok) {
        setActionMessage(res.already ? '本来就没在运行' : '已请求停止（当前 step 跑完后退出）');
      } else {
        setActionError(res?.error || '停止失败');
      }
    } catch (error) {
      setActionError(cleanIpcError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRunOnce() {
    if (!parsedScript) return;
    setBusy(true);
    setActionMessage(null);
    setActionError(null);
    try {
      const res = await window.electronAPI.autopilotRunOnce?.(parsedScript);
      if (res?.ok) {
        setActionMessage('已提交到后台执行，状态请看下方卡片');
      } else {
        setActionError(res?.error || '提交失败');
      }
    } catch (error) {
      setActionError(cleanIpcError(error));
    } finally {
      setBusy(false);
    }
  }

  const statusInfo = useMemo(() => describeSnapshot(snapshot), [snapshot]);

  return (
    <div className={embedded ? 'autopilot-embed' : 'content-card autopilot-page'}>
      {!embedded && <h2>无人值守 AutoPilot</h2>}
      <p className="autopilot-lead">
        写一份声明式脚本（设备 ID + 步骤列表），按「白班跑 / 夜间锁屏 / 异常自愈」自动执行 13 天。
        执行过程中每步留快照，崩溃断连会重启会话并写 ALERTS.md。
      </p>

      <div className="autopilot-grid">
        {recorderNode}
        <section className="autopilot-pane">
          <div className="autopilot-pane__head">
            <span>脚本</span>
            <span className="autopilot-pane__hint">
              {!parseResult.ok && parseResult.error}
              {parseResult.ok && !deviceIdOk && '脚本缺少 deviceId'}
              {parseResult.ok && deviceIdOk && stepCount === 0 && '脚本缺少 steps'}
              {parseResult.ok && deviceIdOk && stepCount > 0 && `${stepCount} 步，已就绪`}
            </span>
          </div>
          <textarea
            className="autopilot-editor"
            value={scriptText}
            onChange={(event) => setScriptText(event.target.value)}
            spellCheck={false}
            rows={14}
          />
          <div className="autopilot-actions">
            <button className="btn btn-secondary btn-sm" onClick={handleValidate} disabled={busy}>
              校验脚本
            </button>
            <button className="btn btn-primary btn-sm" onClick={handleStart} disabled={!canStart}>
              启动调度
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleRunOnce} disabled={busy || !parseResult.ok}>
              单次试跑
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={handleStop}
              disabled={busy || !snapshot?.running}
            >
              停止
            </button>
          </div>
          {validateMessage && (
            <div className={`autopilot-feedback ${validateOk ? 'is-ok' : 'is-error'}`}>
              {validateMessage}
            </div>
          )}
          {actionMessage && <div className="autopilot-feedback is-ok">{actionMessage}</div>}
          {actionError && <div className="autopilot-feedback is-error">{actionError}</div>}
        </section>

        <section className="autopilot-pane">
          <div className="autopilot-pane__head">
            <span>运行状态</span>
            <span className={`autopilot-status autopilot-status--${statusInfo.tone}`}>{statusInfo.label}</span>
          </div>
          <div className="autopilot-stats">
            <StatCard label="脚本名" value={snapshot?.scriptName || '—'} />
            <StatCard label="设备" value={snapshot?.deviceId || '—'} />
            <StatCard label="总步数" value={snapshot?.stepCount ?? 0} />
            <StatCard label="当前步" value={snapshot?.currentStepIndex >= 0 ? (snapshot.currentStepIndex + 1) : '—'} />
            <StatCard label="已跑轮数" value={snapshot?.stats?.runs ?? 0} />
            <StatCard label="失败步数" value={snapshot?.stats?.failedSteps ?? 0} />
            <StatCard label="告警次数" value={snapshot?.stats?.alerts ?? 0} />
            <StatCard label="归档目录" value={snapshot?.archiveDir || '—'} />
          </div>
          {snapshot?.lastRunSummary && (
            <div className="autopilot-lastrun">
              <div className="autopilot-lastrun__title">上一轮</div>
              <div className="autopilot-lastrun__line">
                {snapshot.lastRunSummary.ok} 通过 / {snapshot.lastRunSummary.failed} 失败
                （共 {snapshot.lastRunSummary.total} 步）
              </div>
              <div className="autopilot-lastrun__line">
                {new Date(snapshot.lastRunSummary.startedAt).toLocaleString()}
              </div>
            </div>
          )}
          <p className="autopilot-archive-hint">
            归档目录里每轮一个 <code>summary.json</code>，screenshot 步骤存 PNG。
            <code>ALERTS.md</code> 里是异常时间线，回到机器第一件事看它。
          </p>
        </section>
      </div>

      <style>{`
        .autopilot-page { display: flex; flex-direction: column; gap: 12px; }
        .autopilot-embed { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
        .autopilot-page h2 { margin: 0 0 6px; padding: 0; border: 0; font-size: 22px; }
        .autopilot-lead { margin: 0 0 8px; color: #5f6368; line-height: 1.55; font-size: 13px; }
        .autopilot-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 16px;
        }
        @media (max-width: 900px) {
          .autopilot-grid { grid-template-columns: 1fr; }
        }
        .autopilot-recorder {
          grid-column: 1 / -1;
          display: flex;
          flex-direction: column;
          gap: 8px;
          border: 1px solid #e1e4e8;
          border-radius: 8px;
          padding: 12px;
          background: #fafbfc;
        }
        .autopilot-recorder__head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 13px;
          font-weight: 600;
        }
        .autopilot-recorder__title.is-recording { color: #c5221f; }
        .autopilot-recorder__count { font-weight: 400; color: #5f6368; font-size: 12px; }
        .autopilot-recorder__lead { margin: 0; color: #5f6368; font-size: 12.5px; line-height: 1.55; }
        .autopilot-pane {
          display: flex;
          flex-direction: column;
          gap: 10px;
          border: 1px solid #e1e4e8;
          border-radius: 8px;
          padding: 12px;
          background: #fafbfc;
        }
        .autopilot-pane__head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: 600;
          font-size: 13px;
          color: #202124;
        }
        .autopilot-pane__hint { font-weight: 400; color: #5f6368; font-size: 12px; }
        .autopilot-editor {
          width: 100%;
          min-height: 240px;
          resize: vertical;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12.5px;
          line-height: 1.55;
          padding: 10px 12px;
          border: 1px solid #d1d5da;
          border-radius: 6px;
          background: #fff;
          color: #202124;
        }
        .autopilot-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .autopilot-feedback {
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12.5px;
        }
        .autopilot-feedback.is-ok { background: #e6f4ea; color: #1e8e3e; }
        .autopilot-feedback.is-error { background: #fce8e6; color: #c5221f; }
        .autopilot-status {
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }
        .autopilot-status--idle { background: #f1f3f4; color: #5f6368; }
        .autopilot-status--active { background: #e6f4ea; color: #1e8e3e; }
        .autopilot-status--night { background: #fce8e6; color: #c5221f; }
        .autopilot-stats {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .autopilot-stat {
          background: #fff;
          border: 1px solid #e8eaed;
          border-radius: 6px;
          padding: 8px 10px;
        }
        .autopilot-stat__label { font-size: 11px; color: #5f6368; }
        .autopilot-stat__value { font-size: 14px; color: #202124; font-weight: 600; margin-top: 2px; word-break: break-all; }
        .autopilot-lastrun {
          border-top: 1px dashed #e1e4e8;
          padding-top: 8px;
          font-size: 12.5px;
          color: #3c4043;
        }
        .autopilot-lastrun__title { font-weight: 600; margin-bottom: 4px; }
        .autopilot-lastrun__line { line-height: 1.55; }
        .autopilot-archive-hint { margin: 0; font-size: 12px; color: #5f6368; line-height: 1.55; }
        .autopilot-archive-hint code {
          background: #f1f3f4;
          padding: 0 4px;
          border-radius: 3px;
          font-size: 11.5px;
        }
      `}</style>
    </div>
  );
}

export default AutoPilot;