import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/common/ErrorBoundary';
import './index.css';

// Electron 默认行为：把文件拖到窗口任意位置会直接导航到 file://，整个应用变成白屏。
// 这里在 window 上统一兜底拦截；各拖拽区自己再处理具体逻辑。
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
});

// 渲染层未处理的 Promise 拒绝不会崩界面，但会静默丢失信息。
// 这里至少留一条记录，方便排查「点了没反应」这类问题。
window.addEventListener('unhandledrejection', (event) => {
  console.error('[未处理的 Promise 拒绝]', event.reason);
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* 最外层兜底：App 自身渲染抛错时也不至于白屏 */}
    <ErrorBoundary title="应用启动出错" onReset={() => window.location.reload()}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
