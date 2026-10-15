import React, { useState, useEffect } from 'react';
import { renderMarkdown } from '../lib/markdownHtml';
import { toastSuccess, toastError } from '../lib/toastStore';

function MarkdownEditor() {
  const [markdown, setMarkdown] = useState('');
  const [html, setHtml] = useState('');
  const [viewMode, setViewMode] = useState('split'); // 'edit', 'preview', 'split'

  useEffect(() => {
    // 渲染逻辑在 lib/markdownHtml 里（会先转义原文，见那里的安全说明）
    setHtml(renderMarkdown(markdown));
  }, [markdown]);

  const loadSample = () => {
    const sample = `# Markdown 编辑器示例

## 功能特性

这是一个**功能强大**的 Markdown 编辑器，支持：

- 实时预览
- 多种视图模式
- 文件导入导出
- *斜体* 和 **粗体**

## 代码示例

行内代码：\`console.log('Hello')\`

代码块：
\`\`\`
function hello() {
  return "Hello World";
}
\`\`\`

## 链接和图片

访问 [GitHub](https://github.com) 了解更多。

> 这是一个引用块

---

### 列表示例

1. 第一项
2. 第二项
3. 第三项

* 无序列表项 1
* 无序列表项 2
`;
    setMarkdown(sample);
  };

  const saveFile = async () => {
    try {
      const result = await window.electronAPI.saveMarkdown(markdown);
      if (result.success) {
        toastSuccess('已保存');
      }
    } catch (error) {
      toastError('保存失败: ' + error.message);
    }
  };

  const loadFile = async () => {
    try {
      const content = await window.electronAPI.loadMarkdown();
      if (content) {
        setMarkdown(content);
      }
    } catch (error) {
      toastError('加载失败: ' + error.message);
    }
  };

  const exportHtml = async () => {
    try {
      const result = await window.electronAPI.exportHtml(html);
      if (result.success) {
        toastSuccess('已导出 HTML');
      }
    } catch (error) {
      toastError('导出失败: ' + error.message);
    }
  };

  const clearAll = () => {
    if (confirm('确定要清空内容吗？')) {
      setMarkdown('');
    }
  };

  return (
    <div className="content-card" style={{ height: 'calc(100vh - 60px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>Markdown 编辑器</h2>
        
        <div style={{ display: 'flex', gap: '10px' }}>
          <select
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #ddd' }}
          >
            <option value="edit">仅编辑</option>
            <option value="preview">仅预览</option>
            <option value="split">分屏</option>
          </select>

          <button className="btn btn-secondary" onClick={loadSample}>
            示例
          </button>
          <button className="btn btn-secondary" onClick={loadFile}>
            打开
          </button>
          <button className="btn btn-primary" onClick={saveFile}>
            保存
          </button>
          <button className="btn btn-secondary" onClick={exportHtml}>
            导出HTML
          </button>
          <button className="btn btn-secondary" onClick={clearAll}>
            清空
          </button>
        </div>
      </div>

      <div style={{ 
        display: 'flex', 
        gap: '16px', 
        height: 'calc(100% - 60px)',
        overflow: 'hidden'
      }}>
        {(viewMode === 'edit' || viewMode === 'split') && (
          <div style={{ 
            flex: viewMode === 'split' ? 1 : 'auto', 
            display: 'flex', 
            flexDirection: 'column',
            minWidth: viewMode === 'split' ? 0 : '100%'
          }}>
            <div style={{ 
              marginBottom: '8px', 
              color: '#7f8c8d', 
              fontSize: '14px',
              fontWeight: '500'
            }}>
              编辑区
            </div>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder="输入 Markdown 文本..."
              style={{
                flex: 1,
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                fontFamily: 'monospace',
                fontSize: '14px',
                resize: 'none',
                lineHeight: '1.6'
              }}
            />
          </div>
        )}

        {(viewMode === 'preview' || viewMode === 'split') && (
          <div style={{ 
            flex: viewMode === 'split' ? 1 : 'auto',
            display: 'flex',
            flexDirection: 'column',
            minWidth: viewMode === 'split' ? 0 : '100%'
          }}>
            <div style={{ 
              marginBottom: '8px', 
              color: '#7f8c8d', 
              fontSize: '14px',
              fontWeight: '500'
            }}>
              预览区
            </div>
            <div
              style={{
                flex: 1,
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                background: '#fff',
                overflow: 'auto',
                lineHeight: '1.6'
              }}
              /* code-review-allow sec/no-innerhtml
                 html 由 lib/markdownHtml 的 renderMarkdown 生成：先转义原文再插入自有标签，
                 链接/图片地址走协议白名单（拦 javascript: / data:）。此处插入是安全的。 */
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
      </div>

      <div className="message info" style={{ marginTop: '16px' }}>
        <strong>快捷语法：</strong>
        # 标题1 | ## 标题2 | **粗体** | *斜体* | `代码` | [链接](url) | ![图片](url) | - 列表 | &gt; 引用
      </div>
    </div>
  );
}

export default MarkdownEditor;
