import React, { useEffect, useState } from 'react';
import { ToastStack } from './Feedback';
import { dismissToast, getToasts, subscribeToasts } from '../../lib/toastStore';

/**
 * 全局提示条的挂载点。
 *
 * 挂在 App 最外层，任何组件（含 await 之后的回调）都能通过
 * `lib/toastStore` 的 pushToast 弹出提示，不需要逐层传 props。
 */
function ToastHost() {
  const [toasts, setToasts] = useState(getToasts);

  useEffect(() => subscribeToasts(setToasts), []);

  return <ToastStack toasts={toasts} onDismiss={dismissToast} />;
}

export default ToastHost;
