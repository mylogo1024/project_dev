import React, { useMemo, useState } from 'react';
import SplitPane from './SplitPane';
import {
  applyLineOp,
  convertRadix,
  decodeJwt,
  generateRandom,
  hexDecode,
  hexEncode,
  htmlDecode,
  htmlEncode,
  jsonEscape,
  jsonToQuery,
  jsonUnescape,
  queryToJson,
  reverseEachLine,
  unicodeEscape,
  unicodeUnescape
} from '../lib/textTransforms';
import { copyTextWithToast } from '../lib/clipboard';

const TOOLS = [
  { id: 'base64encode', name: 'Base64 编码' },
  { id: 'base64decode', name: 'Base64 解码' },
  { id: 'urlencode', name: 'URL 编码' },
  { id: 'urldecode', name: 'URL 解码' },
  { id: 'htmlencode', name: 'HTML 实体编码' },
  { id: 'htmldecode', name: 'HTML 实体解码' },
  { id: 'unicodeescape', name: 'Unicode 转义' },
  { id: 'unicodeunescape', name: 'Unicode 反转义' },
  { id: 'hexencode', name: '十六进制编码' },
  { id: 'hexdecode', name: '十六进制解码' },
  { id: 'jsonescape', name: 'JSON 转义' },
  { id: 'jsonunescape', name: 'JSON 反转义' },
  { id: 'md5', name: 'MD5' },
  { id: 'sha1', name: 'SHA1' },
  { id: 'sha256', name: 'SHA256' },
  { id: 'jwt', name: 'JWT 解码' },
  { id: 'query', name: 'URL 参数' },
  { id: 'timestamp', name: '时间戳' },
  { id: 'uuid', name: 'UUID' },
  { id: 'generate', name: '随机生成' },
  { id: 'radix', name: '进制转换' },
  { id: 'case', name: '大小写转换' },
  { id: 'sort', name: '多行排序' },
  { id: 'dedup', name: '去重' },
  { id: 'lineops', name: '行处理' },
  { id: 'revtext', name: '反转文本' },
  { id: 'find', name: '查找' },
  { id: 'replace', name: '替换' },
  { id: 'linecount', name: '行数统计' },
  { id: 'wordcount', name: '字数统计' },
  { id: 'diff', name: '对比差异' }
];

const CASE_MODES = [
  { id: 'upper', name: '全部大写' },
  { id: 'lower', name: '全部小写' },
  { id: 'title', name: '词首大写' },
  { id: 'camel', name: '驼峰' },
  { id: 'snake', name: '下划线' },
  { id: 'kebab', name: '中划线' }
];

const SORT_MODES = [
  { id: 'asc', name: 'A → Z' },
  { id: 'desc', name: 'Z → A' },
  { id: 'reverse', name: '倒序' },
  { id: 'unique', name: '去重（保序）' },
  { id: 'trim-empty', name: '去掉空行' }
];

const LINE_OPS = [
  { id: 'number', name: '加行号' },
  { id: 'unnumber', name: '去掉行号' },
  { id: 'shuffle', name: '随机打乱行序' },
  { id: 'reverse', name: '反转行序' },
  { id: 'trim', name: '去掉每行首尾空白' },
  { id: 'collapse', name: '合并连续空格' },
  { id: 'blank', name: '去掉空行' },
  { id: 'dedent', name: '取消缩进' },
  { id: 'indent', name: '加两个空格缩进' }
];

const GENERATE_MODES = [
  { id: 'uuid', name: 'UUID v4' },
  { id: 'password', name: '强密码' },
  { id: 'string', name: '随机字符串' },
  { id: 'hex', name: '随机十六进制' }
];

const RADIX_MODES = [
  { id: 'dec2hex', name: '十进制 → 十六进制' },
  { id: 'hex2dec', name: '十六进制 → 十进制' },
  { id: 'dec2bin', name: '十进制 → 二进制' },
  { id: 'bin2dec', name: '二进制 → 十进制' },
  { id: 'dec2oct', name: '十进制 → 八进制' },
  { id: 'oct2dec', name: '八进制 → 十进制' }
];

const QUERY_MODES = [
  { id: 'toJson', name: 'Query → JSON' },
  { id: 'toQuery', name: 'JSON → Query' }
];

/** 带子模式下拉的工具 → 选项表 + 默认值。 */
const SUB_MODES = {
  case: { options: CASE_MODES, initial: 'upper' },
  sort: { options: SORT_MODES, initial: 'asc' },
  lineops: { options: LINE_OPS, initial: 'number' },
  generate: { options: GENERATE_MODES, initial: 'uuid' },
  radix: { options: RADIX_MODES, initial: 'dec2hex' },
  query: { options: QUERY_MODES, initial: 'toJson' }
};

const LIVE_TOOLS = new Set([
  'case', 'sort', 'dedup',
  'base64encode', 'base64decode', 'urlencode', 'urldecode',
  'htmlencode', 'htmldecode', 'unicodeescape', 'unicodeunescape',
  'hexencode', 'hexdecode', 'jsonescape', 'jsonunescape',
  'revtext'
]);
const HASH_TOOLS = new Set(['md5', 'sha1', 'sha256']);
const SEARCH_TOOLS = new Set(['find', 'replace']);
// 每次点按钮才生成的（不能即时算，否则输入一个字符就重新生成一次）
const GENERATE_TOOLS = new Set(['uuid', 'generate']);

const toCamelCase = (str) => str.replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase());
const toSnakeCase = (str) => str.replace(/\s+/g, '_').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_+/, '');
const toKebabCase = (str) => str.replace(/\s+/g, '-').replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-+/, '');
const toTitleCase = (str) => str.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

function convertCase(text, mode) {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  if (mode === 'title') return toTitleCase(text);
  if (mode === 'camel') return toCamelCase(text);
  if (mode === 'snake') return toSnakeCase(text);
  return toKebabCase(text);
}

function sortLines(text, mode) {
  const lines = text.split(/\r?\n/);
  const compare = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
  if (mode === 'asc') return [...lines].sort(compare).join('\n');
  if (mode === 'desc') return [...lines].sort((a, b) => compare(b, a)).join('\n');
  if (mode === 'reverse') return [...lines].reverse().join('\n');
  if (mode === 'unique') {
    const seen = new Set();
    return lines.filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    }).join('\n');
  }
  if (mode === 'trim-empty') return lines.filter((line) => line.trim() !== '').join('\n');
  return text;
}

function dedupLines(text) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  return lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  }).join('\n');
}

function computeLineDiff(leftText, rightText) {
  const a = leftText.split(/\r?\n/);
  const b = rightText.split(/\r?\n/);
  const maxCells = 250000;
  if (a.length * b.length > maxCells) {
    const max = Math.max(a.length, b.length);
    const rows = [];
    for (let i = 0; i < max; i += 1) {
      const left = a[i];
      const right = b[i];
      if (left === right) rows.push({ type: 'same', left: left ?? '', right: right ?? '' });
      else if (left == null) rows.push({ type: 'add', left: '', right });
      else if (right == null) rows.push({ type: 'del', left, right: '' });
      else rows.push({ type: 'change', left, right });
    }
    return rows;
  }

  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', left: a[i], right: b[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', left: a[i], right: '' });
      i += 1;
    } else {
      rows.push({ type: 'add', left: '', right: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ type: 'del', left: a[i], right: '' });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ type: 'add', left: '', right: b[j] });
    j += 1;
  }
  return rows;
}

function computeStats(text) {
  const lines = text.split(/\r?\n/);
  const allChars = text.length;
  const noSpaceChars = text.replace(/\s/g, '').length;
  const cnChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const bytes = new TextEncoder().encode(text).length;
  const emptyLines = lines.filter((l) => l.trim() === '').length;
  const nonEmpty = lines.length - emptyLines;
  const lengths = lines.map((l) => l.length);
  const maxLine = lengths.length ? Math.max(...lengths) : 0;
  const minLine = lengths.length ? Math.min(...lengths) : 0;
  const avgLine = lengths.length ? (lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1) : '0';
  const numbers = (text.match(/\d+/g) || []).length;
  return {
    lines: lines.length,
    emptyLines,
    nonEmpty,
    maxLine,
    minLine,
    avgLine,
    allChars,
    noSpaceChars,
    cnChars,
    words,
    numbers,
    bytes
  };
}

function lineCountReport(text) {
  const s = computeStats(text);
  return [
    `总行数：${s.lines}`,
    `空行：${s.emptyLines}`,
    `非空行：${s.nonEmpty}`,
    `最长行：${s.maxLine} 字符`,
    `最短行：${s.minLine} 字符`,
    `平均行长：${s.avgLine} 字符`
  ].join('\n');
}

function wordCountReport(text) {
  const s = computeStats(text);
  return [
    `字符数（含空格）：${s.allChars}`,
    `字符数（不含空格）：${s.noSpaceChars}`,
    `中文字数：${s.cnChars}`,
    `英文单词：${s.words}`,
    `数字串：${s.numbers}`,
    `换行符：${s.lines - 1}`,
    `字节数（UTF-8）：${s.bytes}`
  ].join('\n');
}

function buildSearchRegex(pattern, { caseSensitive, regex, wholeWord }) {
  if (!pattern) return null;
  let source = pattern;
  if (!regex) source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `\\b${source}\\b`;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function findMatches(text, pattern, opts) {
  const re = buildSearchRegex(pattern, opts);
  if (!re) return [];
  const lines = text.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    re.lastIndex = 0;
    const m = re.exec(lines[i]);
    if (m) matches.push({ lineNo: i + 1, text: lines[i], match: m[0], index: m.index });
  }
  return matches;
}

function replaceAll(text, pattern, replacement, opts) {
  const re = buildSearchRegex(pattern, opts);
  if (!re) return text;
  return text.replace(re, replacement);
}

function convertSync(tool, input, modes = {}) {
  switch (tool) {
    case 'base64encode':
      return btoa(unescape(encodeURIComponent(input)));
    case 'base64decode':
      return decodeURIComponent(escape(atob(input)));
    case 'urlencode':
      return encodeURIComponent(input);
    case 'urldecode':
      return decodeURIComponent(input);
    case 'htmlencode':
      return htmlEncode(input);
    case 'htmldecode':
      return htmlDecode(input);
    case 'unicodeescape':
      return unicodeEscape(input);
    case 'unicodeunescape':
      return unicodeUnescape(input);
    case 'hexencode':
      return hexEncode(input);
    case 'hexdecode':
      return hexDecode(input);
    case 'jsonescape':
      return jsonEscape(input);
    case 'jsonunescape':
      return jsonUnescape(input);
    case 'jwt':
      return decodeJwt(input);
    case 'query':
      return (modes.query || 'toJson') === 'toQuery' ? jsonToQuery(input) : queryToJson(input);
    case 'radix':
      return convertRadix(input, modes.radix || 'dec2hex');
    case 'timestamp': {
      if (!input.trim()) {
        const now = Date.now();
        return `当前时间戳：${now}\n当前时间：${new Date().toLocaleString('zh-CN')}`;
      }
      const num = Number.parseInt(input.trim(), 10);
      if (Number.isNaN(num)) return '无效的时间戳';
      const timestamp = String(num).length === 10 ? num * 1000 : num;
      const date = new Date(timestamp);
      return `时间戳：${num}\n北京时间：${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\nUTC 时间：${date.toUTCString()}\nISO 格式：${date.toISOString()}`;
    }
    case 'uuid':
    case 'generate':
      return generateRandom(input, tool === 'uuid' ? 'uuid' : (modes.generate || 'uuid'));
    case 'case':
      return convertCase(input, modes.case || 'upper');
    case 'sort':
      return sortLines(input, modes.sort || 'asc');
    case 'dedup':
      return dedupLines(input);
    case 'lineops':
      return applyLineOp(input, modes.lineops || 'number');
    case 'revtext':
      return reverseEachLine(input);
    case 'linecount':
      return lineCountReport(input);
    case 'wordcount':
      return wordCountReport(input);
    default:
      return '';
  }
}

function StatsBar({ text }) {
  const s = useMemo(() => computeStats(text), [text]);
  return (
    <div className="text-stats-bar">
      <span className="text-stats-item">行 {s.lines}</span>
      <span className="text-stats-sep">|</span>
      <span className="text-stats-item">字符 {s.allChars}</span>
      <span className="text-stats-sep">|</span>
      <span className="text-stats-item">中文 {s.cnChars}</span>
      <span className="text-stats-sep">|</span>
      <span className="text-stats-item">单词 {s.words}</span>
      <span className="text-stats-sep">|</span>
      <span className="text-stats-item">字节 {s.bytes}</span>
    </div>
  );
}

function TextPane({ title, value, onChange, placeholder, extra, readOnly = false, showStats = false }) {
  return (
    <div className="text-pane">
      <div className="text-pane-head">
        <span>{title}</span>
        <div className="text-pane-actions">
          {extra}
          <button className="text-mini-btn" onClick={() => copyTextWithToast(value)} disabled={!value}>复制</button>
        </div>
      </div>
      <textarea
        className="text-area"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      {showStats && <StatsBar text={value} />}
    </div>
  );
}

function SearchBar({
  findText, onFindChange,
  replaceText, onReplaceChange,
  caseSensitive, onCaseSensitive,
  regex, onRegex,
  wholeWord, onWholeWord,
  isReplace
}) {
  return (
    <div className="text-search-bar">
      <div className="text-search-row">
        <label className="text-search-label">查找</label>
        <input
          className="text-search-input"
          type="text"
          value={findText}
          onChange={(e) => onFindChange(e.target.value)}
          placeholder="输入要查找的内容"
        />
      </div>
      {isReplace && (
        <div className="text-search-row">
          <label className="text-search-label">替换为</label>
          <input
            className="text-search-input"
            type="text"
            value={replaceText}
            onChange={(e) => onReplaceChange(e.target.value)}
            placeholder="输入替换后的内容"
          />
        </div>
      )}
      <div className="text-search-options">
        <label className="text-search-opt">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => onCaseSensitive(e.target.checked)} />
          区分大小写
        </label>
        <label className="text-search-opt">
          <input type="checkbox" checked={regex} onChange={(e) => onRegex(e.target.checked)} />
          正则表达式
        </label>
        <label className="text-search-opt">
          <input type="checkbox" checked={wholeWord} onChange={(e) => onWholeWord(e.target.checked)} />
          全词匹配
        </label>
      </div>
    </div>
  );
}

function FindResult({ matches, pattern }) {
  if (!pattern) return <div className="text-empty">输入查找内容后点击「转换」</div>;
  if (matches.length === 0) return <div className="text-empty">未找到匹配</div>;
  return (
    <div className="text-match-list">
      <div className="text-match-head">共 {matches.length} 处匹配</div>
          {matches.map((m) => (
            <div key={`${m.lineNo}-${m.index}-${m.match}`} className="text-match-row">
          <span className="text-match-lineNo">{m.lineNo}</span>
          <span className="text-match-text">
            {m.text.slice(0, m.index)}
            <mark className="text-match-highlight">{m.match}</mark>
            {m.text.slice(m.index + m.match.length)}
          </span>
        </div>
      ))}
    </div>
  );
}

function TextTools({
  initialTool = 'case',
  initialInput = '',
  initialRightInput = '',
  initialOutput = '',
  initialFindText = '',
  initialReplaceText = '',
  initialCaseSensitive = false,
  initialRegex = false,
  initialWholeWord = false
}) {
  const [selectedTool, setSelectedTool] = useState(initialTool);
  const [input, setInput] = useState(initialInput);
  const [rightInput, setRightInput] = useState(initialRightInput);
  const [output, setOutput] = useState(initialOutput);
  const [subModes, setSubModes] = useState(() => Object.fromEntries(
    Object.entries(SUB_MODES).map(([id, config]) => [id, config.initial])
  ));
  const [error, setError] = useState('');

  // 查找/替换状态
  const [findText, setFindText] = useState(initialFindText);
  const [replaceText, setReplaceText] = useState(initialReplaceText);
  const [caseSensitive, setCaseSensitive] = useState(initialCaseSensitive);
  const [useRegex, setUseRegex] = useState(initialRegex);
  const [wholeWord, setWholeWord] = useState(initialWholeWord);
  const [findMatchesResult, setFindMatchesResult] = useState([]);

  const isDiff = selectedTool === 'diff';
  const isLive = LIVE_TOOLS.has(selectedTool);
  const isSearch = SEARCH_TOOLS.has(selectedTool);
  const isReplace = selectedTool === 'replace';
  const subModeConfig = SUB_MODES[selectedTool] || null;
  const subMode = subModeConfig ? subModes[selectedTool] : '';
  const setSubMode = (value) => setSubModes((current) => ({ ...current, [selectedTool]: value }));

  const liveOutput = useMemo(() => {
    if (!isLive) return output;
    try {
      return convertSync(selectedTool, input, subModes);
    } catch (liveError) {
      return `转换失败: ${liveError.message}`;
    }
  }, [isLive, selectedTool, input, subModes, output]);

  const diffRows = useMemo(
    () => (isDiff ? computeLineDiff(input, rightInput) : []),
    [isDiff, input, rightInput]
  );

  const handleConvert = async () => {
    setError('');
    try {
      if (HASH_TOOLS.has(selectedTool)) {
        setOutput(await window.electronAPI.calculateHash(input, selectedTool));
        return;
      }
      if (selectedTool === 'find') {
        const matches = findMatches(input, findText, { caseSensitive, regex: useRegex, wholeWord });
        setFindMatchesResult(matches);
        setOutput(matches.length ? `共 ${matches.length} 处匹配` : '未找到匹配');
        return;
      }
      if (selectedTool === 'replace') {
        const result = replaceAll(input, findText, replaceText, { caseSensitive, regex: useRegex, wholeWord });
        setOutput(result);
        return;
      }
      setOutput(convertSync(selectedTool, input, subModes));
    } catch (convertError) {
      setError(convertError.message);
      setOutput(`转换失败: ${convertError.message}`);
    }
  };

  const displayedOutput = isLive ? liveOutput : output;
  const needsConvert = !isDiff && !isLive;

  // 查找/替换的输出面板标题
  const outputTitle = isReplace ? '替换结果' : (selectedTool === 'find' ? '查找结果' : (isLive ? '输出（即时）' : '输出'));

  const MULTILINE_TOOLS = new Set(['sort', 'dedup', 'lineops', 'radix']);
  const inputTitle = MULTILINE_TOOLS.has(selectedTool) ? '原始多行文本' : '输入';
  const inputPlaceholders = {
    timestamp: '输入时间戳，留空则取当前时间',
    generate: '输入长度，留空用默认（密码 20 位 / 随机串 24 位 / 十六进制 16 字节）',
    jwt: '粘贴 JWT（header.payload.signature），可带 Bearer 前缀',
    query: subMode === 'toQuery' ? '粘贴 JSON 对象，例如 {"a":1,"b":"x"}' : '粘贴 query 串或整条 URL',
    radix: '每行一个数字，无效的行会原样标出'
  };
  const inputPlaceholder = inputPlaceholders[selectedTool] || '在此输入文本';

  return (
    <div className="content-card text-page">
      <div className="text-toolbar">
        <div className="text-tool-tabs">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              className={`text-tab ${selectedTool === tool.id ? 'is-active' : ''}`}
              onClick={() => {
                setSelectedTool(tool.id);
                setError('');
              }}
            >
              {tool.name}
            </button>
          ))}
        </div>
        <div className="text-toolbar-actions">
          {subModeConfig && (
            <select value={subMode} onChange={(event) => setSubMode(event.target.value)} className="text-select">
              {subModeConfig.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          )}
          {needsConvert && (
            <button className="btn btn-primary" onClick={handleConvert}>
              {GENERATE_TOOLS.has(selectedTool) ? '生成' : '转换'}
            </button>
          )}
          <button
            className="btn btn-secondary"
            onClick={() => {
              setInput('');
              setRightInput('');
              setOutput('');
              setError('');
              setFindText('');
              setReplaceText('');
              setFindMatchesResult([]);
            }}
          >
            清空
          </button>
        </div>
      </div>

      {isSearch && (
        <SearchBar
          findText={findText} onFindChange={setFindText}
          replaceText={replaceText} onReplaceChange={setReplaceText}
          caseSensitive={caseSensitive} onCaseSensitive={setCaseSensitive}
          regex={useRegex} onRegex={setUseRegex}
          wholeWord={wholeWord} onWholeWord={setWholeWord}
          isReplace={isReplace}
        />
      )}

      {error && <div className="message error">{error}</div>}

      <div className="text-workspace">
        {isDiff ? (
          <SplitPane direction="vertical" initial={42}>
            <SplitPane direction="horizontal" initial={50}>
              <TextPane title="左侧原文" value={input} onChange={setInput} placeholder="粘贴第一段文本" />
              <TextPane title="右侧对比" value={rightInput} onChange={setRightInput} placeholder="粘贴第二段文本" />
            </SplitPane>
            <div className="text-pane text-diff-pane">
              <div className="text-pane-head">
                <span>差异结果（绿=新增，红=删除）</span>
                <span>{diffRows.filter((row) => row.type !== 'same').length} 处不同</span>
              </div>
              <div className="text-diff-view">
                {diffRows.length === 0 ? (
                  <div className="text-empty">两侧都为空</div>
                ) : diffRows.map((row, index) => (
                  <div key={`${row.type}-${index}`} className={`text-diff-row is-${row.type}`}>
                    <span className="text-diff-mark">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : row.type === 'change' ? '~' : ' '}</span>
                    <span className="text-diff-line">{row.type === 'add' ? row.right : row.type === 'change' ? `${row.left}  →  ${row.right}` : row.left}</span>
                  </div>
                ))}
              </div>
            </div>
          </SplitPane>
        ) : (
          <SplitPane direction="horizontal" initial={50}>
            <TextPane
              title={inputTitle}
              value={input}
              onChange={setInput}
              placeholder={inputPlaceholder}
              showStats
            />
            {selectedTool === 'find' ? (
              <div className="text-pane">
                <div className="text-pane-head">
                  <span>{outputTitle}</span>
                  <div className="text-pane-actions">
                    <button className="text-mini-btn" onClick={handleConvert}>查找</button>
                    <button className="text-mini-btn" onClick={() => copyTextWithToast(output)} disabled={!output}>复制</button>
                  </div>
                </div>
                <div className="text-area text-area--readonly">
                  <FindResult matches={findMatchesResult} pattern={findText} />
                </div>
              </div>
            ) : (
              <TextPane
                title={outputTitle}
                value={displayedOutput}
                onChange={setOutput}
                placeholder="转换结果会显示在这里"
                readOnly={!isLive}
              />
            )}
          </SplitPane>
        )}
      </div>
    </div>
  );
}

export default TextTools;
