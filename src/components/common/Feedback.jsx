import React, { useEffect, useRef, useState } from 'react';

/** 拼接 class，自动丢掉空值，避免出现多余空格。 */
const cx = (...parts) => parts.filter(Boolean).join(' ');

/** 毫秒 → 人类可读耗时（1.2 秒 / 2 分 05 秒）。 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total} 毫秒`;
  const seconds = total / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
}

/**
 * 计时 Hook：running 为 true 时每 100ms 刷新一次已耗时。
 * 用于「解析中… 已用 3.4 秒」这类实时反馈，避免用户以为程序卡死。
 */
export function useElapsed(running) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return undefined;
    }
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 100);
    return () => clearInterval(timer);
  }, [running]);

  return elapsed;
}

const TONE_BY_PERCENT = (percent) => {
  if (percent == null) return 'accent';
  if (percent >= 100) return 'success';
  return 'accent';
};

/**
 * 通用进度条。
 *
 * @param {number|null} percent 0~100；传 null 表示「不确定进度」（无限循环动画）
 * @param {string} stage        当前阶段文案，例如「解析 DEX 字节码」
 * @param {string} detail       次要说明，例如正在处理的文件名
 * @param {number} elapsedMs    已耗时（毫秒）
 * @param {Function} onCancel   传了才显示取消按钮
 * @param {string} tone         accent | success | danger | warn
 * @param {boolean} compact     紧凑模式（用于列表行内）
 * @param {Array<{label: string, done: boolean}>} steps 可选阶段清单
 */
export function ProgressBar({
  percent,
  stage,
  detail,
  elapsedMs,
  onCancel,
  tone,
  compact = false,
  steps
}) {
  const indeterminate = percent == null;
  const clamped = indeterminate ? 0 : Math.max(0, Math.min(100, Math.round(percent)));
  const finalTone = tone || TONE_BY_PERCENT(indeterminate ? null : clamped);

  return (
    <div className={cx('ui-progress', compact && 'ui-progress--compact')}>
      <div className="ui-progress__head">
        <span className="ui-progress__stage">{stage || '处理中'}</span>
        <span className="ui-progress__meta">
          {elapsedMs != null ? <span className="ui-progress__elapsed">已用 {formatElapsed(elapsedMs)}</span> : null}
          {!indeterminate ? <span className="ui-progress__percent">{clamped}%</span> : null}
          {onCancel ? (
            <button type="button" className="ui-progress__cancel" onClick={onCancel}>取消</button>
          ) : null}
        </span>
      </div>

      <div
        className="ui-progress__track"
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={stage || undefined}
      >
        <div
          className={cx('ui-progress__fill', `ui-progress__fill--${finalTone}`, indeterminate && 'is-indeterminate')}
          style={indeterminate ? undefined : { width: `${clamped}%` }}
        />
      </div>

      {steps?.length ? (
        <div className="ui-progress__steps">
          {steps.map((step) => (
            <span key={step.label} className={cx('ui-progress__step', step.done && 'is-done', step.active && 'is-active')}>
              <i aria-hidden="true" />
              {step.label}
            </span>
          ))}
        </div>
      ) : null}

      {detail ? <div className="ui-progress__detail" title={detail}>{detail}</div> : null}
    </div>
  );
}

const TOAST_ICONS = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i'
};

/**
 * 单条提示条。
 * @param {'success'|'error'|'warning'|'info'} type
 */
export function Toast({ type = 'info', text, detail, onClose, action }) {
  return (
    <div className={cx('ui-toast', `ui-toast--${type}`)} role={type === 'error' ? 'alert' : 'status'}>
      <span className="ui-toast__icon" aria-hidden="true">{TOAST_ICONS[type] || 'i'}</span>
      <div className="ui-toast__body">
        <div className="ui-toast__text">{text}</div>
        {detail ? <div className="ui-toast__detail">{detail}</div> : null}
      </div>
      {action ? (
        <button type="button" className="ui-toast__action" onClick={action.onClick}>{action.label}</button>
      ) : null}
      {onClose ? (
        <button type="button" className="ui-toast__close" onClick={onClose} aria-label="关闭">×</button>
      ) : null}
    </div>
  );
}

/**
 * 提示条堆叠容器。
 * @param {Array<{id: string|number, type: string, text: string, detail?: string}>} toasts
 */
export function ToastStack({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="ui-toast-stack">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          type={toast.type}
          text={toast.text}
          detail={toast.detail}
          onClose={() => onDismiss?.(toast.id)}
        />
      ))}
    </div>
  );
}

/**
 * Toast 管理 Hook。
 * push({ type, text, detail, timeout }) 返回该 toast 的 id。
 */
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const dismiss = (id) => setToasts((list) => list.filter((item) => item.id !== id));

  const push = (toast) => {
    counter.current += 1;
    const id = `t-${counter.current}`;
    const entry = { id, type: 'info', timeout: toast.timeout ?? 4000, ...toast };
    setToasts((list) => [...list.slice(-4), entry]);
    if (entry.timeout > 0) {
      setTimeout(() => dismiss(id), entry.timeout);
    }
    return id;
  };

  return { toasts, push, dismiss };
}
