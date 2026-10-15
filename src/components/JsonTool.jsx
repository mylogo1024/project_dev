import React, { useMemo, useState } from 'react';
import SplitPane from './SplitPane';
import FullscreenText from './common/FullscreenText';
import {
  dictToJson,
  jsonEscape,
  jsonToDict,
  jsonToQuery,
  jsonUnescape,
  unicodeEscape,
  unicodeUnescape
} from '../lib/textTransforms';
import { copyTextWithToast } from '../lib/clipboard';

const OPERATIONS = [
  { id: 'format', name: '格式化', verb: '格式化' },
  { id: 'minify', name: '压缩', verb: '压缩' },
  { id: 'validate', name: '验证', verb: '验证' },
  { id: 'toDict', name: 'JSON → Dict', verb: '转换' },
  { id: 'toJson', name: 'Dict → JSON', verb: '转换' },
  { id: 'zh2unicode', name: '中文 → Unicode', verb: '转换' },
  { id: 'unicode2zh', name: 'Unicode → 中文', verb: '转换' },
  { id: 'escape', name: '添加转义', verb: '转义' },
  { id: 'unescape', name: '去除转义', verb: '反转义' },
  { id: 'toQuery', name: '转 Get 参数', verb: '转换' }
];

const PLACEHOLDERS = {
  toJson: "粘贴 Python dict 或 JS 对象，例如 {'a': 1, 'b': True}",
  toDict: '粘贴 JSON，会转成单引号 + True/False/None 的字典写法',
  toQuery: '粘贴 JSON 对象，例如 {"a":1,"b":"x"}',
  unicode2zh: '粘贴含 \\uXXXX 的文本',
  validate: '粘贴要校验的 JSON'
};

/** 校验失败时给几条最常见的排查方向。 */
function getFixSuggestions(text, message) {
  const suggestions = [];
  if (/Unexpected token/i.test(message)) {
    suggestions.push('检查是否有多余的逗号，或括号没有配对');
  }
  if (text.includes("'")) suggestions.push('JSON 字符串必须用双引号（可试试「Dict → JSON」自动转换）');
  if (text.includes('//') || text.includes('/*')) suggestions.push('JSON 不支持注释，需要先删掉');
  if (/,\s*[}\]]/.test(text)) suggestions.push('最后一个元素后面多了逗号');
  if (/\b(True|False|None)\b/.test(text)) suggestions.push('布尔值与空值应写作 true / false / null');
  if (/[{,]\s*[A-Za-z_$][\w$]*\s*:/.test(text)) suggestions.push('对象的键必须用双引号包起来');
  return suggestions;
}

function runOperation(operation, text) {
  switch (operation) {
    case 'format':
      return JSON.stringify(JSON.parse(text), null, 2);
    case 'minify':
      return JSON.stringify(JSON.parse(text));
    case 'validate':
      JSON.parse(text);
      return '✅ JSON 格式正确';
    case 'toDict':
      return jsonToDict(text);
    case 'toJson':
      return dictToJson(text);
    case 'zh2unicode':
      return unicodeEscape(text);
    case 'unicode2zh':
      return unicodeUnescape(text);
    case 'escape':
      return jsonEscape(text);
    case 'unescape':
      return jsonUnescape(text);
    case 'toQuery':
      return jsonToQuery(text);
    default:
      return '';
  }
}

const SAMPLE = `{
  "name": "张三",
  "age": 30,
  "vip": true,
  "tags": ["编程", "阅读"],
  "address": { "city": "北京", "zip": "100000" }
}`;

function StatsLine({ text }) {
  const stats = useMemo(() => {
    const value = String(text || '');
    return {
      lines: value ? value.split('\n').length : 0,
      chars: value.length,
      bytes: new TextEncoder().encode(value).length
    };
  }, [text]);

  return (
    <div className="text-stats-bar">
      <span className="text-stats-item">行 {stats.lines}</span>
      <span className="text-stats-sep">|</span>
      <span className="text-stats-item">字符 {stats.chars}</span>
      <span className="text-stats-sep">|</span>
      <span className="text-stats-item">字节 {stats.bytes}</span>
    </div>
  );
}

function JsonTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [operation, setOperation] = useState('format');
  const [fullscreen, setFullscreen] = useState(false);

  const active = OPERATIONS.find((item) => item.id === operation) || OPERATIONS[0];

  const handleRun = () => {
    setError('');
    const text = input.trim();
    if (!text) {
      setError('请先输入内容');
      setOutput('');
      return;
    }

    try {
      setOutput(runOperation(operation, input));
    } catch (runError) {
      // 格式化/压缩失败时，多半是把 dict 或带注释的内容当成 JSON 了，救一次再报错
      if (operation === 'format' || operation === 'minify') {
        try {
          const fixed = dictToJson(input);
          setOutput(operation === 'minify' ? JSON.stringify(JSON.parse(fixed)) : fixed);
          setError(`原内容不是严格 JSON（${runError.message}），已按字典语法修复后处理`);
          return;
        } catch (_) {
          /* 救不回来，走下面的常规报错 */
        }
      }
      setOutput('');
      const suggestions = operation === 'validate' ? getFixSuggestions(input, runError.message) : [];
      setError([
        `${active.verb}失败：${runError.message}`,
        ...(suggestions.length ? ['', '可能的修复方向：', ...suggestions.map((item) => `· ${item}`)] : [])
      ].join('\n'));
    }
  };

  const copyOutput = async () => {
    setError('');
    await copyTextWithToast(output, { successText: '结果已复制' });
  };

  const clearAll = () => {
    setInput('');
    setOutput('');
    setError('');
  };

  return (
    <div className="content-card json-page">
      <div className="text-toolbar">
        <div className="text-tool-tabs">
          {OPERATIONS.map((item) => (
            <button
              key={item.id}
              className={`text-tab ${operation === item.id ? 'is-active' : ''}`}
              onClick={() => { setOperation(item.id); setError(''); }}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="text-toolbar-actions">
          <button className="btn btn-primary" onClick={handleRun}>{active.verb}</button>
          <button className="btn btn-secondary" onClick={() => setInput(SAMPLE)}>示例</button>
          <button className="btn btn-secondary" onClick={clearAll}>清空</button>
        </div>
      </div>

      {error && <div className="message error json-message">{error}</div>}

      <div className="text-workspace">
        <SplitPane direction="horizontal" initial={50}>
          <div className="text-pane">
            <div className="text-pane-head">
              <span>输入</span>
              <div className="text-pane-actions">
                <button className="text-mini-btn" onClick={() => setInput('')} disabled={!input}>清空</button>
              </div>
            </div>
            <textarea
              className="text-area"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={PLACEHOLDERS[operation] || '粘贴或输入 JSON 文本'}
              spellCheck={false}
            />
            <StatsLine text={input} />
          </div>

          <div className="text-pane">
            <div className="text-pane-head">
              <span>输出</span>
              <div className="text-pane-actions">
                <button className="text-mini-btn" onClick={() => setFullscreen(true)} disabled={!output}>全屏</button>
                <button className="text-mini-btn" onClick={copyOutput} disabled={!output}>复制</button>
              </div>
            </div>
            <textarea
              className="text-area"
              value={output}
              readOnly
              placeholder="结果会显示在这里；行数多时点「全屏」整屏查看"
              spellCheck={false}
            />
            <StatsLine text={output} />
          </div>
        </SplitPane>
      </div>

      <FullscreenText
        open={fullscreen}
        title={`${active.name} · 输出`}
        value={output}
        onClose={() => setFullscreen(false)}
      />
    </div>
  );
}

export default JsonTool;
