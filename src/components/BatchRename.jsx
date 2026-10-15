import React, { useMemo, useState } from 'react';
import { applyRules, ensureUniqueTargets } from '../lib/batchRenameEngine';
import { cleanIpcError } from '../lib/errorText';

const TABS = [
  { id: 'start', label: '开始' },
  { id: 'sort', label: '排序' },
  { id: 'extension', label: '扩展名' },
  { id: 'case', label: '大小写' },
  { id: 'sequence', label: '顺序' },
  { id: 'replace', label: '替换' },
  { id: 'insert', label: '插入' },
  { id: 'truncate', label: '截取' },
  { id: 'reorganize', label: '重组' },
  { id: 'segment', label: '片段' },
  { id: 'random', label: '随机' },
  { id: 'remove', label: '移除' },
  { id: 'delete', label: '删除' },
  { id: 'list', label: '列表' },
  { id: 'custom', label: '自定义' },
  { id: 'regex', label: '正则' },
  { id: 'batch', label: '批处理' }
];

const RULE_TYPES = TABS.filter((tab) => !['start', 'sort', 'batch'].includes(tab.id)).map((tab) => tab.id);

const defaultRules = () => ({
  extension: { type: 'extension', enabled: false, mode: 'set', value: '', case: 'none' },
  case: { type: 'case', enabled: false, mode: 'lower' },
  sequence: { type: 'sequence', enabled: false, start: 1, step: 1, pad: 3, position: 'prefix', separator: '_', letters: false, datePrefix: false, index: 0 },
  replace: { type: 'replace', enabled: false, find: '', replace: '', caseSensitive: false, all: true },
  insert: { type: 'insert', enabled: false, text: '', position: 'prefix', index: 0, includeParent: false, includeDate: false },
  truncate: { type: 'truncate', enabled: false, mode: 'keep-start', n: 8, from: 1, to: 8 },
  reorganize: { type: 'reorganize', enabled: false, separator: '-', order: '2,1', joinWith: '-' },
  segment: { type: 'segment', enabled: false, mode: 'delim', separator: '-', index: 1, pattern: '', from: 1, to: 4, variable: '1', replaceStem: false },
  random: {
    type: 'random', enabled: false, mode: 'chars',
    length: 8, alphabet: 'alnum', prefix: '', suffix: '',
    words: 1, separator: '-', min: 1000, max: 9999
  },
  remove: { type: 'remove', enabled: false, mode: 'spaces', text: '' },
  delete: { type: 'delete', enabled: false, mode: 'trim', value: '' },
  list: { type: 'list', enabled: false, namesText: '' },
  custom: { type: 'custom', enabled: false, template: '%name%_%n%', start: 1, pad: 2 },
  regex: { type: 'regex', enabled: false, pattern: '', replace: '', flags: 'g' }
});

function Field({ label, children }) {
  return (
    <label className="rename-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Enable({ checked, onChange }) {
  return (
    <label className="rename-enable">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      启用此规则
    </label>
  );
}

function BatchRename() {
  const [tab, setTab] = useState('start');
  const [files, setFiles] = useState([]);
  const [rules, setRules] = useState(defaultRules);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [conflict, setConflict] = useState('suffix');
  const [recursive, setRecursive] = useState(true);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastOps, setLastOps] = useState([]);
  const [order, setOrder] = useState(RULE_TYPES);

  const patchRule = (type, patch) => {
    setRules((current) => ({ ...current, [type]: { ...current[type], ...patch } }));
  };

  const enabledRules = useMemo(() => {
    return order.map((type) => {
      const rule = rules[type];
      if (!rule) return null;
      if (type === 'list') {
        return { ...rule, names: String(rule.namesText || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean) };
      }
      return rule;
    }).filter(Boolean);
  }, [order, rules]);

  const previewRows = useMemo(
    () => applyRules(files, enabledRules, { sort }),
    [files, enabledRules, sort]
  );

  const changedCount = previewRows.filter((item) => item.changed && item.status !== 'conflict').length;
  const conflictCount = previewRows.filter((item) => item.status === 'conflict').length;

  const mergeFiles = (incoming) => {
    setFiles((current) => {
      const map = new Map(current.map((item) => [item.path, item]));
      for (const item of incoming || []) {
        if (item?.path) map.set(item.path, item);
      }
      return [...map.values()];
    });
  };

  const addFiles = async () => {
    const paths = await window.electronAPI.selectMultipleFiles();
    if (!paths?.length) return;
    const collected = await window.electronAPI.collectRenameFiles(paths, { recursive: false, filter });
    mergeFiles(collected);
    setMessage({ type: 'info', text: `已添加 ${collected.length} 个文件` });
  };

  const addFolders = async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (!dir) return;
    const collected = await window.electronAPI.collectRenameFiles([dir], { recursive, filter });
    mergeFiles(collected);
    setMessage({ type: 'info', text: `已从文件夹加入 ${collected.length} 个文件` });
  };

  const onDrop = async (event) => {
    event.preventDefault();
    const paths = [...(event.dataTransfer?.files || [])].map((file) => file.path).filter(Boolean);
    if (!paths.length) return;
    const collected = await window.electronAPI.collectRenameFiles(paths, { recursive, filter });
    mergeFiles(collected);
    setMessage({ type: 'info', text: `已拖入 ${collected.length} 个文件` });
  };

  /** 真正执行一批重命名（执行前的二次确认也在这里）。 */
  const runRename = async (ops) => {
    if (!window.confirm(`将重命名 ${ops.length} 个文件，此操作可撤销。继续？`)) return;
    setBusy(true);
    try {
      const results = await window.electronAPI.applyRenameFiles(ops, { conflict });
      const renamed = results.filter((item) => item.status === 'renamed');
      setLastOps(renamed);
      const next = await window.electronAPI.collectRenameFiles(results.map((item) => (item.status === 'renamed' ? item.to : item.from)), { recursive: false });
      setFiles(next);
      const failed = results.filter((item) => item.status === 'error' || item.status === 'skipped');
      setMessage({
        type: failed.length ? 'error' : 'success',
        text: `完成 ${renamed.length} 个${failed.length ? `，${failed.length} 个未处理` : ''}`
      });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '重命名失败') });
    } finally {
      setBusy(false);
    }
  };

  const applyRename = async () => {
    const ops = previewRows.filter((item) => item.changed && item.status !== 'conflict').map((item) => ({ from: item.path, to: item.target }));
    if (!ops.length) {
      setMessage({ type: 'warning', text: '没有可执行的重命名（可能全部未变化或存在冲突）' });
      return;
    }
    await runRename(ops);
  };

  /**
   * 一键「全部随机命名」：不用先配规则，直接给整批文件换成随机名。
   *
   * 用 safe 字符集（不含 0O1lI，随机名经常要口头念或手输）+ 12 位，
   * 再用 ensureUniqueTargets 兜底，保证整批目标两两不同、也不会撞到已有文件。
   */
  const randomizeAll = async () => {
    if (!files.length) {
      setMessage({ type: 'warning', text: '先添加要重命名的文件' });
      return;
    }
    const rule = {
      ...rules.random,
      type: 'random',
      id: 'random-all',
      enabled: true,
      mode: 'chars',
      alphabet: 'safe',
      length: 12,
      prefix: '',
      suffix: ''
    };
    // 其余已启用规则照旧生效，只把随机规则替换成这次的配置
    const active = [...enabledRules.filter((item) => item.type !== 'random'), rule];
    const rows = ensureUniqueTargets(applyRules(files, active, { sort }));
    const ops = rows
      .filter((item) => item.changed && item.status !== 'conflict')
      .map((item) => ({ from: item.path, to: item.target }));

    if (!ops.length) {
      setMessage({ type: 'warning', text: '没有可重命名的文件' });
      return;
    }
    patchRule('random', rule);
    setMessage({ type: 'info', text: `已生成 ${ops.length} 个随机文件名，确认后执行` });
    await runRename(ops);
  };

  const undoRename = async () => {
    if (!lastOps.length) return;
    setBusy(true);
    try {
      const results = await window.electronAPI.undoRenameFiles(lastOps);
      const restored = results.filter((item) => item.status === 'renamed').map((item) => item.to);
      const next = await window.electronAPI.collectRenameFiles(restored.length ? restored : lastOps.map((item) => item.from), { recursive: false });
      setFiles(next);
      setLastOps([]);
      setMessage({ type: 'success', text: `已撤销 ${results.filter((item) => item.status === 'renamed').length} 个重命名` });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '撤销失败') });
    } finally {
      setBusy(false);
    }
  };

  const saveRules = async () => {
    const filePath = await window.electronAPI.saveFile({
      defaultPath: 'rename-rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (!filePath) return;
    await window.electronAPI.writeTextFile(filePath, JSON.stringify({ sort, conflict, recursive, filter, order, rules }, null, 2));
    setMessage({ type: 'success', text: '规则已保存' });
  };

  const loadRules = async () => {
    const filePath = await window.electronAPI.selectFiles({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!filePath) return;
    const text = await window.electronAPI.readTextFile(filePath);
    const data = JSON.parse(text);
    if (data.rules) setRules({ ...defaultRules(), ...data.rules });
    if (data.sort) setSort(data.sort);
    if (data.conflict) setConflict(data.conflict);
    if (Array.isArray(data.order)) setOrder(data.order);
    if (typeof data.filter === 'string') setFilter(data.filter);
    setMessage({ type: 'success', text: '规则已加载' });
  };

  const renderPanel = () => {
    if (tab === 'start') {
      return (
        <div className="rename-panel">
          <Field label="后缀过滤">
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="jpg, png, mp4，留空表示全部" />
          </Field>
          <label className="rename-enable">
            <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
            添加文件夹时包含子目录
          </label>
          <Field label="重名冲突">
            <select value={conflict} onChange={(event) => setConflict(event.target.value)}>
              <option value="suffix">自动加 (1)(2)</option>
              <option value="skip">跳过</option>
              <option value="overwrite">覆盖</option>
            </select>
          </Field>
          <button
            className="btn btn-secondary rename-random-all"
            onClick={randomizeAll}
            disabled={!files.length || busy}
          >
            🎲 全部随机命名
          </button>
          <p className="rename-hint">
            一键把整批文件名换成 12 位随机串（保留扩展名，用不含 0O1lI 的字符集），
            批内保证不重名。点完会有一次确认，执行后仍可撤销。
          </p>
          <p className="rename-hint">可拖拽文件/文件夹到本页。规则按顶部菜单从左到右叠加，左侧实时预览。</p>
        </div>
      );
    }
    if (tab === 'sort') {
      return (
        <div className="rename-panel">
          <Field label="排序字段">
            <select value={sort.key} onChange={(event) => setSort((current) => ({ ...current, key: event.target.value }))}>
              <option value="name">名称</option>
              <option value="ext">扩展名</option>
              <option value="size">大小</option>
              <option value="mtime">修改日期</option>
              <option value="ctime">创建日期</option>
              <option value="random">随机打乱</option>
            </select>
          </Field>
          <Field label="方向">
            <select value={sort.dir} onChange={(event) => setSort((current) => ({ ...current, dir: event.target.value }))}>
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </Field>
        </div>
      );
    }
    if (tab === 'batch') {
      return (
        <div className="rename-panel">
          <p className="rename-hint">上下调整规则执行顺序。只有勾选启用的规则会生效。</p>
          {order.map((type, index) => {
            const meta = TABS.find((item) => item.id === type);
            const rule = rules[type];
            return (
              <div key={type} className="rename-batch-row">
                <input
                  type="checkbox"
                  checked={Boolean(rule?.enabled)}
                  onChange={(event) => patchRule(type, { enabled: event.target.checked })}
                />
                <span>{meta?.label || type}</span>
                <button className="text-mini-btn" disabled={index === 0} onClick={() => setOrder((current) => {
                  const next = [...current];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  return next;
                })}>上移</button>
                <button className="text-mini-btn" disabled={index === order.length - 1} onClick={() => setOrder((current) => {
                  const next = [...current];
                  [next[index + 1], next[index]] = [next[index], next[index + 1]];
                  return next;
                })}>下移</button>
              </div>
            );
          })}
        </div>
      );
    }

    const rule = rules[tab] || {};
    const enable = <Enable checked={Boolean(rule.enabled)} onChange={(enabled) => patchRule(tab, { enabled })} />;

    if (tab === 'extension') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="方式">
            <select value={rule.mode} onChange={(event) => patchRule('extension', { mode: event.target.value, enabled: true })}>
              <option value="set">统一修改</option>
              <option value="keep">保留原扩展名</option>
              <option value="strip">去除扩展名</option>
            </select>
          </Field>
          <Field label="新扩展名">
            <input value={rule.value} onChange={(event) => patchRule('extension', { value: event.target.value, enabled: true })} placeholder="jpg" />
          </Field>
          <Field label="大小写">
            <select value={rule.case} onChange={(event) => patchRule('extension', { case: event.target.value, enabled: true })}>
              <option value="none">不变</option>
              <option value="lower">小写</option>
              <option value="upper">大写</option>
            </select>
          </Field>
        </div>
      );
    }
    if (tab === 'case') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="方式">
            <select value={rule.mode} onChange={(event) => patchRule('case', { mode: event.target.value, enabled: true })}>
              <option value="upper">全部大写</option>
              <option value="lower">全部小写</option>
              <option value="title">首字母大写</option>
              <option value="sentence">句首大写</option>
              <option value="camel">驼峰</option>
            </select>
          </Field>
        </div>
      );
    }
    if (tab === 'sequence') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="起始"><input type="number" value={rule.start} onChange={(event) => patchRule('sequence', { start: Number(event.target.value), enabled: true })} /></Field>
          <Field label="步长"><input type="number" value={rule.step} onChange={(event) => patchRule('sequence', { step: Number(event.target.value), enabled: true })} /></Field>
          <Field label="位数"><input type="number" value={rule.pad} onChange={(event) => patchRule('sequence', { pad: Number(event.target.value), enabled: true })} /></Field>
          <Field label="位置">
            <select value={rule.position} onChange={(event) => patchRule('sequence', { position: event.target.value, enabled: true })}>
              <option value="prefix">前缀</option>
              <option value="suffix">后缀</option>
              <option value="at">指定位置</option>
            </select>
          </Field>
          <label className="rename-enable"><input type="checkbox" checked={rule.letters} onChange={(event) => patchRule('sequence', { letters: event.target.checked, enabled: true })} />字母序列 A-Z</label>
          <label className="rename-enable"><input type="checkbox" checked={rule.datePrefix} onChange={(event) => patchRule('sequence', { datePrefix: event.target.checked, enabled: true })} />前面加日期</label>
        </div>
      );
    }
    if (tab === 'replace') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="查找"><input value={rule.find} onChange={(event) => patchRule('replace', { find: event.target.value, enabled: true })} /></Field>
          <Field label="替换为"><input value={rule.replace} onChange={(event) => patchRule('replace', { replace: event.target.value, enabled: true })} placeholder="留空表示删除" /></Field>
          <label className="rename-enable"><input type="checkbox" checked={rule.caseSensitive} onChange={(event) => patchRule('replace', { caseSensitive: event.target.checked })} />区分大小写</label>
          <label className="rename-enable"><input type="checkbox" checked={rule.all} onChange={(event) => patchRule('replace', { all: event.target.checked })} />替换全部匹配</label>
        </div>
      );
    }
    if (tab === 'insert') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="插入内容"><input value={rule.text} onChange={(event) => patchRule('insert', { text: event.target.value, enabled: true })} /></Field>
          <Field label="位置">
            <select value={rule.position} onChange={(event) => patchRule('insert', { position: event.target.value, enabled: true })}>
              <option value="prefix">开头</option>
              <option value="suffix">结尾</option>
              <option value="at">指定字符位置</option>
            </select>
          </Field>
          <label className="rename-enable"><input type="checkbox" checked={rule.includeParent} onChange={(event) => patchRule('insert', { includeParent: event.target.checked, enabled: true })} />插入父文件夹名</label>
          <label className="rename-enable"><input type="checkbox" checked={rule.includeDate} onChange={(event) => patchRule('insert', { includeDate: event.target.checked, enabled: true })} />插入修改日期</label>
        </div>
      );
    }
    if (tab === 'truncate') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="方式">
            <select value={rule.mode} onChange={(event) => patchRule('truncate', { mode: event.target.value, enabled: true })}>
              <option value="keep-start">保留前 N 个字符</option>
              <option value="keep-end">保留后 N 个字符</option>
              <option value="drop-start">删除前 N 个字符</option>
              <option value="drop-end">删除后 N 个字符</option>
              <option value="range">指定区间</option>
            </select>
          </Field>
          <Field label="N"><input type="number" value={rule.n} onChange={(event) => patchRule('truncate', { n: Number(event.target.value), enabled: true })} /></Field>
          <Field label="从"><input type="number" value={rule.from} onChange={(event) => patchRule('truncate', { from: Number(event.target.value), enabled: true })} /></Field>
          <Field label="到"><input type="number" value={rule.to} onChange={(event) => patchRule('truncate', { to: Number(event.target.value), enabled: true })} /></Field>
        </div>
      );
    }
    if (tab === 'reorganize') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="分隔符"><input value={rule.separator} onChange={(event) => patchRule('reorganize', { separator: event.target.value, enabled: true })} /></Field>
          <Field label="新顺序"><input value={rule.order} onChange={(event) => patchRule('reorganize', { order: event.target.value, enabled: true })} placeholder="2,1" /></Field>
          <p className="rename-hint">例如 `艺术家 - 歌曲` 填分隔符 `-`、顺序 `2,1` 得到 `歌曲-艺术家`。</p>
        </div>
      );
    }
    if (tab === 'segment') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="提取方式">
            <select value={rule.mode} onChange={(event) => patchRule('segment', { mode: event.target.value, enabled: true })}>
              <option value="delim">按分隔符第 N 段</option>
              <option value="regex">正则捕获组</option>
              <option value="range">字符区间</option>
            </select>
          </Field>
          <Field label="分隔符/正则"><input value={rule.mode === 'regex' ? rule.pattern : rule.separator} onChange={(event) => patchRule('segment', rule.mode === 'regex' ? { pattern: event.target.value, enabled: true } : { separator: event.target.value, enabled: true })} /></Field>
          <Field label="第几段"><input type="number" value={rule.index} onChange={(event) => patchRule('segment', { index: Number(event.target.value), enabled: true })} /></Field>
          <label className="rename-enable"><input type="checkbox" checked={rule.replaceStem} onChange={(event) => patchRule('segment', { replaceStem: event.target.checked, enabled: true })} />用提取结果替换文件名</label>
        </div>
      );
    }
    if (tab === 'random') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="方式">
            <select value={rule.mode} onChange={(event) => patchRule('random', { mode: event.target.value, enabled: true })}>
              <option value="chars">随机字符</option>
              <option value="uuid">UUID</option>
              <option value="word">随机词库</option>
              <option value="number">随机数字范围</option>
              <option value="shuffle">打乱现有文件名</option>
            </select>
          </Field>

          {rule.mode === 'chars' && (
            <>
              <Field label="字符集">
                <select value={rule.alphabet || 'alnum'} onChange={(event) => patchRule('random', { alphabet: event.target.value, enabled: true })}>
                  <option value="alnum">大小写字母 + 数字</option>
                  <option value="lower">仅小写字母</option>
                  <option value="upper">仅大写字母</option>
                  <option value="digits">仅数字</option>
                  <option value="hex">十六进制 0-9a-f</option>
                  <option value="safe">不含易混字符（无 0O1lI）</option>
                </select>
              </Field>
              <Field label="长度">
                <input
                  type="number" min="1" max="128"
                  value={rule.length}
                  onChange={(event) => patchRule('random', { length: Number(event.target.value), enabled: true })}
                />
              </Field>
            </>
          )}

          {rule.mode === 'word' && (
            <>
              <Field label="词数">
                <input
                  type="number" min="1" max="5"
                  value={rule.words || 1}
                  onChange={(event) => patchRule('random', { words: Number(event.target.value), enabled: true })}
                />
              </Field>
              <Field label="连接符">
                <input
                  value={rule.separator ?? '-'}
                  onChange={(event) => patchRule('random', { separator: event.target.value, enabled: true })}
                  placeholder="-"
                />
              </Field>
            </>
          )}

          {rule.mode === 'number' && (
            <>
              <Field label="最小">
                <input type="number" value={rule.min} onChange={(event) => patchRule('random', { min: Number(event.target.value), enabled: true })} />
              </Field>
              <Field label="最大">
                <input type="number" value={rule.max} onChange={(event) => patchRule('random', { max: Number(event.target.value), enabled: true })} />
              </Field>
            </>
          )}

          <Field label="前缀">
            <input
              value={rule.prefix || ''}
              onChange={(event) => patchRule('random', { prefix: event.target.value, enabled: true })}
              placeholder="例如 IMG_"
            />
          </Field>
          <Field label="后缀">
            <input
              value={rule.suffix || ''}
              onChange={(event) => patchRule('random', { suffix: event.target.value, enabled: true })}
              placeholder="例如 _final"
            />
          </Field>

          <p className="rename-hint">
            {rule.mode === 'shuffle'
              ? '只打乱原文件名的字符顺序，不改长度。'
              : '整段替换原文件名，扩展名保持不变。'}
            同一个文件每次生成的名字都相同，所以预览和真正执行的结果一致。
          </p>
        </div>
      );
    }
    if (tab === 'remove') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="移除">
            <select value={rule.mode} onChange={(event) => patchRule('remove', { mode: event.target.value, enabled: true })}>
              <option value="text">指定文本</option>
              <option value="digits">数字</option>
              <option value="letters">字母</option>
              <option value="punct">标点</option>
              <option value="spaces">空格</option>
              <option value="parens">括号及内容</option>
            </select>
          </Field>
          <Field label="文本"><input value={rule.text} onChange={(event) => patchRule('remove', { text: event.target.value, enabled: true })} /></Field>
        </div>
      );
    }
    if (tab === 'delete') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="删除">
            <select value={rule.mode} onChange={(event) => patchRule('delete', { mode: event.target.value, enabled: true })}>
              <option value="trim">首尾空白</option>
              <option value="dupes">连续重复字符</option>
              <option value="prefix">指定前缀</option>
              <option value="suffix">指定后缀</option>
            </select>
          </Field>
          <Field label="前缀/后缀"><input value={rule.value} onChange={(event) => patchRule('delete', { value: event.target.value, enabled: true })} /></Field>
        </div>
      );
    }
    if (tab === 'list') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="新文件名列表">
            <textarea value={rule.namesText} onChange={(event) => patchRule('list', { namesText: event.target.value, enabled: true })} placeholder={'一行一个新文件名\nphoto-a.jpg'} />
          </Field>
        </div>
      );
    }
    if (tab === 'custom') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="模板">
            <input value={rule.template} onChange={(event) => patchRule('custom', { template: event.target.value, enabled: true })} />
          </Field>
          <p className="rename-hint">
            变量：<code>%name%</code> <code>%ext%</code> <code>%n%</code> <code>%date%</code> <code>%parent%</code>
            {' '}<code>%random%</code>（6 位随机）<code>%random12%</code>（指定位数）<code>%uuid%</code>
            {' '}<code>%word%</code>（随机词）<code>%words3%</code>（3 个随机词）<code>%randdate%</code>（近一年内随机日期），
            以及片段 / 正则捕获组 <code>$1</code> <code>$2</code>
          </p>
        </div>
      );
    }
    if (tab === 'regex') {
      return (
        <div className="rename-panel">
          {enable}
          <Field label="匹配"><input value={rule.pattern} onChange={(event) => patchRule('regex', { pattern: event.target.value, enabled: true })} placeholder="(\d+)" /></Field>
          <Field label="替换"><input value={rule.replace} onChange={(event) => patchRule('regex', { replace: event.target.value, enabled: true })} placeholder="$1" /></Field>
          <Field label="flags"><input value={rule.flags} onChange={(event) => patchRule('regex', { flags: event.target.value, enabled: true })} /></Field>
        </div>
      );
    }
    return null;
  };

  return (
    <div
      className="content-card rename-page"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="rename-head">
        <h2>文件批量命名</h2>
        <span>已选 {files.length} · 将改名 {changedCount}{conflictCount ? ` · 冲突 ${conflictCount}` : ''}</span>
      </div>

      <div className="rename-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`rename-tab ${tab === item.id ? 'is-active' : ''} ${item.id !== 'start' && item.id !== 'sort' && item.id !== 'batch' && rules[item.id]?.enabled ? 'is-on' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {renderPanel()}

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      <div className="rename-toolbar">
        <button className="btn btn-secondary" onClick={addFiles}>添加文件</button>
        <button className="btn btn-secondary" onClick={addFolders}>添加文件夹</button>
        <button className="btn btn-secondary" onClick={() => setFiles([])}>清空列表</button>
        <button className="btn btn-secondary" onClick={saveRules}>保存规则</button>
        <button className="btn btn-secondary" onClick={loadRules}>加载规则</button>
        <button className="btn btn-secondary" onClick={undoRename} disabled={!lastOps.length || busy}>撤销</button>
        <button className="btn btn-primary" onClick={applyRename} disabled={!changedCount || busy}>{busy ? '处理中…' : '开始重命名'}</button>
      </div>

      <div className="rename-table-wrap">
        <table className="rename-table">
          <thead>
            <tr>
              <th style={{ width: 48 }}>#</th>
              <th>原文件名</th>
              <th>预览</th>
              <th>路径</th>
              <th style={{ width: 80 }}>状态</th>
              <th style={{ width: 56 }}></th>
            </tr>
          </thead>
          <tbody>
            {previewRows.length === 0 ? (
              <tr><td colSpan="6" className="rename-empty">添加文件、多个文件或文件夹，规则改动会立刻预览新文件名</td></tr>
            ) : previewRows.slice(0, 2000).map((file, index) => (
              <tr key={file.path}>
                <td>{index + 1}</td>
                <td>{file.name}</td>
                <td className={file.status === 'conflict' ? 'is-conflict' : file.changed ? 'is-changed' : ''}>{file.preview}</td>
                <td className="rename-path" title={file.dir}>{file.dir}</td>
                <td>{file.status === 'conflict' ? '冲突' : file.changed ? '将改名' : '不变'}</td>
                <td>
                  <button className="text-mini-btn" onClick={() => setFiles((current) => current.filter((item) => item.path !== file.path))}>移除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {previewRows.length > 2000 && <p className="rename-hint">仅显示前 2000 条预览，执行时仍处理全部 {previewRows.length} 个文件。</p>}
      </div>

      <style>{`
        .rename-page { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
        .rename-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .rename-head h2 { margin: 0; padding: 0; border: 0; font-size: 22px; }
        .rename-head span { color: #5f6368; font-size: 13px; }
        .rename-tabs {
          display: flex;
          flex-wrap: nowrap;
          overflow-x: auto;
          gap: 2px;
          padding: 6px 8px;
          background: #f3f4f6;
          border-radius: 8px;
          margin-bottom: 12px;
        }
        .rename-tab {
          border: 0;
          background: transparent;
          color: #4b5563;
          padding: 8px 12px;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
          border-radius: 6px;
        }
        .rename-tab.is-active { color: #2563eb; font-weight: 700; background: #fff; }
        .rename-tab.is-on:not(.is-active) { color: #0f766e; }
        .rename-panel {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px 16px;
          margin-bottom: 12px;
        }
        .rename-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5f6368; }
        .rename-field input, .rename-field select, .rename-field textarea {
          padding: 8px 10px;
          border: 1px solid #e8eaed;
          border-radius: 6px;
          font-size: 13px;
        }
        .rename-field textarea { min-height: 90px; grid-column: 1 / -1; }
        .rename-enable { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #3c4043; }
        .rename-hint { grid-column: 1 / -1; margin: 0; font-size: 12px; color: #5f6368; }
        .rename-toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
        .rename-table-wrap { flex: 1; min-height: 220px; overflow: auto; border: 1px solid #e8eaed; border-radius: 8px; }
        .rename-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .rename-table th, .rename-table td { padding: 8px 10px; border-bottom: 1px solid #f0f2f5; text-align: left; vertical-align: top; }
        .rename-table th { position: sticky; top: 0; background: #f7f8fc; z-index: 1; }
        .rename-path { color: #80868b; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .is-changed { color: #0b57d0; font-weight: 600; }
        .is-conflict { color: #c62828; font-weight: 600; }
        .rename-empty { text-align: center; color: #80868b; padding: 28px 12px !important; }
        .rename-batch-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      `}</style>
    </div>
  );
}

export default BatchRename;
