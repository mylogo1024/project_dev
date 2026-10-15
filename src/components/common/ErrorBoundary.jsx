import React from 'react';
import { formatRenderError, shouldResetError } from '../../lib/renderError';
import { copyTextWithToast } from '../../lib/clipboard';

/**
 * 渲染层错误边界。
 *
 * React 在渲染期抛错时会**卸载整棵树** —— 用户看到的就是一片白屏，只能重启应用。
 * 主进程的 uncaughtException 兜底管不到渲染层，两边要各管一半。
 *
 * 用法：把每个功能面板单独包一层，一个工具炸了不会连累其它工具；
 * 最外层再包一层，兜住 App 自身的渲染错误。
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: '' };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ componentStack: info?.componentStack || '' });
    // 控制台留一份完整堆栈，方便开发时定位
    console.error('[渲染错误]', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // 「重新加载此功能」会改 resetKey —— 用它把错误状态清掉，否则永远停在错误页
    if (shouldResetError(Boolean(this.state.error), prevProps.resetKey, this.props.resetKey)) {
      this.setState({ error: null, componentStack: '' });
    }
  }

  detailText() {
    return formatRenderError(this.state.error, this.state.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.title || '这个功能出错了';
    return (
      <div className="error-boundary">
        <div className="error-boundary__icon">⚠️</div>
        <h3 className="error-boundary__title">{title}</h3>
        <p className="error-boundary__hint">
          其它功能不受影响，可以切换过去继续用。下面是完整的错误信息，可直接复制反馈。
        </p>
        <pre className="error-boundary__stack">{this.detailText()}</pre>
        <div className="error-boundary__actions">
          {this.props.onReset && (
            <button className="btn btn-primary" onClick={this.props.onReset}>重新加载此功能</button>
          )}
          <button
            className="btn btn-secondary"
            onClick={() => copyTextWithToast(this.detailText(), { successText: '错误信息已复制' })}
          >
            复制错误信息
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
