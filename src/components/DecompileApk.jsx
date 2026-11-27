import React, { useEffect, useState } from 'react';
import PlainSecretField from './PlainSecretField';
import { cleanIpcError } from '../lib/errorText';

/** 按扩展名判断类型，用于切换文案与提示。 */
const kindOf = (filePath) => {
  const ext = String(filePath || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!ext) return null;
  if (ext[1] === 'apk' || ext[1] === 'aab') return 'android';
  if (ext[1] === 'ipa') return 'ios';
  return null;
};

/** 取路径所在目录，用于把输出目录默认成「与输入同目录」。 */
const dirOf = (filePath) => {
  const text = String(filePath || '');
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return index > 0 ? text.slice(0, index) : '';
};

const KIND_HINT = {
  android: '用 apktool 解包成可读目录（资源、清单、smali）',
  ios: '解包 IPA，并从主二进制提取 ObjC 类名 / 方法名 / Swift 反射串 / 符号表。'
    + '注意：这是元数据提取，不是反汇编成源码'
};

const REBUILD_HINT = {
  android: '选择带 apktool.yml 的反编译目录。回编译后会按下方签名配置做 zipalign + 签名。',
  ios: '选择解包后的 IPA 目录（含 Payload/*.app），重新打成 IPA。如需改签，请到「应用签名」。',
  unknown: '目录里要有 apktool.yml（Android）或 Payload/*.app（iOS）'
};

// 与 electron/apk-sign.js 的 SCHEME_PRESETS 对应
const SCHEME_PRESETS = [
  { id: 'v1', label: '仅 v1', v1: true, v2: false, v3: false },
  { id: 'v2', label: '仅 v2', v1: false, v2: true, v3: false },
  { id: 'v3', label: '仅 v3', v1: false, v2: false, v3: true },
  { id: 'v1v2', label: 'v1 + v2', v1: true, v2: true, v3: false },
  { id: 'v2v3', label: 'v2 + v3', v1: false, v2: true, v3: true },
  { id: 'all', label: 'v1 + v2 + v3', v1: true, v2: true, v3: true }
];

function DecompileApk({ config = {} }) {
  const [mode, setMode] = useState('decompile');
  const [inputs, setInputs] = useState([]);
  const [outputPath, setOutputPath] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [rebuildOutput, setRebuildOutput] = useState('');
  const [rebuildKind, setRebuildKind] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [dragging, setDragging] = useState(false);

  // 回编译签名：默认取「设置」里的全局配置，但允许本次单独修改，不影响全局
  const [keystorePath, setKeystorePath] = useState(config.keystorePath || '');
  const [alias, setAlias] = useState(config.alias || '');
  const [password, setPassword] = useState(config.password || '');
  const [v1, setV1] = useState(true);
  const [v2, setV2] = useState(true);
  const [v3, setV3] = useState(false);

  const singleTarget = inputs.length === 1 && kindOf(inputs[0]) ? inputs[0] : null;
  const singleKind = singleTarget ? kindOf(singleTarget) : null;
  const unknownInputs = inputs.filter((item) => !kindOf(item) && /\./.test(String(item).split(/[\\/]/).pop() || ''));

  useEffect(() => {
    setKeystorePath(config.keystorePath || '');
    setAlias(config.alias || '');
    setPassword(config.password || '');
  }, [config]);

  useEffect(() => {
    if (!window.electronAPI.onDecompileProgress) return undefined;
    return window.electronAPI.onDecompileProgress((info) => setProgress(info));
  }, []);

  const inspectProject = async (dir) => {
    if (!dir || !window.electronAPI.inspectRebuildProject) {
      setRebuildKind(null);
      return;
    }
    const info = await window.electronAPI.inspectRebuildProject(dir);
    setRebuildKind(info?.kind || null);
    if (info?.defaultOutput) setRebuildOutput(info.defaultOutput);
  };

  const addInputs = (paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!list.length) return;
    setInputs((current) => {
      const next = [...current];
      for (const item of list) {
        if (!next.includes(item)) next.push(item);
      }
      return next;
    });
    if (!outputPath) {
      const first = list.find((item) => dirOf(item));
      if (first) setOutputPath(dirOf(first));
    }
    setMessage(null);
    setResult(null);
  };

  const removeInput = (target) => {
    setInputs((current) => current.filter((item) => item !== target));
    setMessage(null);
    setResult(null);
  };

  const clearInputs = () => {
    setInputs([]);
    setMessage(null);
    setResult(null);
  };

  const selectFiles = async () => {
    try {
      const picked = await window.electronAPI.selectFiles({
        filters: [
          { name: 'APK / AAB / IPA', extensions: ['apk', 'aab', 'ipa'] },
          { name: 'Android APK', extensions: ['apk'] },
          { name: 'Android AAB', extensions: ['aab'] },
          { name: 'iOS IPA', extensions: ['ipa'] }
        ],
        properties: ['openFile', 'multiSelections']
      });
      const list = Array.isArray(picked) ? picked : (picked ? [picked] : []);
      if (list.length) addInputs(list);
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '选择文件失败') });
    }
  };

  const selectFolder = async () => {
    try {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) addInputs([dir]);
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '选择文件夹失败') });
    }
  };

  const selectOutput = async () => {
    const nextPath = await window.electronAPI.selectDirectory();
    if (nextPath) setOutputPath(nextPath);
  };

  const selectProject = async () => {
    const nextPath = await window.electronAPI.selectDirectory();
    if (!nextPath) return;
    setProjectDir(nextPath);
    setMessage(null);
    setResult(null);
    await inspectProject(nextPath);
  };

  const selectKeystore = async () => {
    const picker = window.electronAPI.selectKeystore
      ? window.electronAPI.selectKeystore()
      : window.electronAPI.selectFiles({ filters: [{ name: 'Keystore', extensions: ['jks', 'keystore', 'p12', 'pfx'] }] });
    const nextPath = await picker;
    if (nextPath) setKeystorePath(Array.isArray(nextPath) ? nextPath[0] : nextPath);
  };

  const selectRebuildOutput = async () => {
    const filters = rebuildKind === 'ios'
      ? [{ name: 'IPA', extensions: ['ipa'] }]
      : [{ name: 'APK', extensions: ['apk'] }];
    const nextPath = await window.electronAPI.saveFile({
      defaultPath: rebuildOutput || undefined,
      filters
    });
    if (nextPath) setRebuildOutput(nextPath);
  };

  const useDecompileResult = async (dir) => {
    if (!dir) return;
    setProjectDir(dir);
    setMode('rebuild');
    setMessage(null);
    setResult(null);
    await inspectProject(dir);
  };

  // ---------- 拖拽导入（文件 / 文件夹都可以） ----------
  const onDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
  };

  const onDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files || []);
    const paths = files.map((file) => file.path).filter(Boolean);
    if (!paths.length) {
      setMessage({ type: 'error', text: '无法获取拖入内容的路径，请改用「选择文件」/「选择文件夹」' });
      return;
    }
    addInputs(paths);
  };

  const decompile = async () => {
    if (!inputs.length) {
      setMessage({ type: 'error', text: '请先拖入或选择 APK / AAB / IPA 文件（也可以直接丢文件夹进来）' });
      return;
    }
    if (!outputPath) {
      setMessage({ type: 'error', text: '请选择输出目录' });
      return;
    }

    setLoading(true);
    setMessage(null);
    setResult(null);
    setProgress({ percent: 0, stage: '准备中' });

    try {
      if (singleTarget) {
        const res = await window.electronAPI.decompileApk(singleTarget, outputPath, { jobId: `decompile-${Date.now()}` });
        setResult(res);
        setMessage({ type: 'success', text: res.message });
        if (res.outputDir) {
          setProjectDir(res.outputDir);
          await inspectProject(res.outputDir);
        }
      } else {
        const res = await window.electronAPI.decompileApkBatch({
          inputs,
          outputDir: outputPath,
          jobId: `decompile-batch-${Date.now()}`
        });
        setResult(res);
        setMessage({ type: res.failed ? 'error' : 'success', text: res.message });
        const firstOk = res.results?.find((item) => item.ok && item.outputDir);
        if (firstOk) {
          setProjectDir(firstOk.outputDir);
          await inspectProject(firstOk.outputDir);
        }
      }
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '反编译失败') });
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const rebuild = async () => {
    if (!projectDir) {
      setMessage({ type: 'error', text: '请先选择反编译后的目录' });
      return;
    }
    if (!rebuildOutput) {
      setMessage({ type: 'error', text: '请选择回编译输出文件' });
      return;
    }
    if (rebuildKind !== 'ios' && !keystorePath) {
      setMessage({ type: 'error', text: '请填写签名文件（keystore），或在「设置」里配置全局签名' });
      return;
    }
    if (rebuildKind !== 'ios' && !v1 && !v2 && !v3) {
      setMessage({ type: 'error', text: '请至少选择一种签名方案（v1 / v2 / v3）' });
      return;
    }

    setLoading(true);
    setMessage(null);
    setResult(null);
    setProgress({ percent: 0, stage: '准备回编译' });

    try {
      const res = await window.electronAPI.rebuildPackage({
        projectDir,
        outputPath: rebuildOutput,
        jobId: `rebuild-${Date.now()}`,
        // iOS 不走 APK 签名；Android 用页面上这份（默认全局，可临时改）签名配置
        sign: rebuildKind === 'ios' ? undefined : { keystorePath, alias, password, v1, v2, v3 }
      });
      setResult(res);
      setMessage({ type: 'success', text: res.message });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error, '回编译失败') });
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const batch = result && Array.isArray(result.results) && result.results.length > 0;

  return (
    <div className="content-card">
      <h2>反编译 / 回编译 APK / IPA</h2>

      <div className="ia-mode-tabs">
        <button
          type="button"
          className={`ia-mode-tab${mode === 'decompile' ? ' is-active' : ''}`}
          onClick={() => { setMode('decompile'); setMessage(null); }}
          disabled={loading}
        >
          反编译
        </button>
        <button
          type="button"
          className={`ia-mode-tab${mode === 'rebuild' ? ' is-active' : ''}`}
          onClick={() => { setMode('rebuild'); setMessage(null); }}
          disabled={loading}
        >
          回编译
        </button>
      </div>

      {mode === 'decompile' ? (
        <>
          <div className="form-group">
            <label>
              选择 APK / AAB / IPA 文件或文件夹
              {inputs.length > 1 ? <span className="ia-count">共 {inputs.length} 项</span> : null}
            </label>
            <div
              className={`file-input-group ia-drop${dragging ? ' is-dragging' : ''}`}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              <input
                type="text"
                value={inputs.length === 1 ? inputs[0] : (inputs.length ? `已选 ${inputs.length} 项` : '')}
                readOnly
                placeholder="把 APK / AAB / IPA（或整个文件夹）拖进来，也可以点右侧按钮选择"
              />
              <button className="btn btn-secondary" onClick={selectFiles} disabled={loading}>选择文件</button>
              <button className="btn btn-secondary" onClick={selectFolder} disabled={loading}>选择文件夹</button>
            </div>
            {inputs.length > 0 ? (
              <div className="ia-drop--list">
                <ul className="ia-list">
                  {inputs.map((item) => (
                    <li className="ia-row" key={item}>
                      <span className="decompile-pick__path" title={item}>{item}</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={() => removeInput(item)}
                        disabled={loading}
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
                {inputs.length > 1 ? (
                  <div className="decompile-pick__foot">
                    <button type="button" className="btn btn-sm btn-outline" onClick={clearInputs} disabled={loading}>
                      清空
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {singleKind && <small className="decompile-hint">{KIND_HINT[singleKind]}</small>}
            {unknownInputs.length > 0 && (
              <small className="decompile-hint is-warn">
                有 {unknownInputs.length} 项扩展名无法识别，反编译时会自动跳过（仅支持 APK / AAB / IPA；文件夹会递归查找）
              </small>
            )}
            {!singleKind && inputs.length > 0 && (
              <small className="decompile-hint">文件夹会递归查找里面的 APK / AAB / IPA，找到几个就反编译几个</small>
            )}
          </div>

          <div className="form-group">
            <label>输出目录</label>
            <div className="file-input-group">
              <input
                type="text"
                value={outputPath}
                onChange={(event) => setOutputPath(event.target.value)}
                placeholder="默认为文件所在目录"
              />
              <button className="btn btn-secondary" onClick={selectOutput} disabled={loading}>浏览</button>
            </div>
            <small className="decompile-hint">如果存在同名文件夹将被删除</small>
          </div>

          <div className="action-buttons">
            <button
              className="btn btn-primary"
              onClick={decompile}
              disabled={loading || !inputs.length || !outputPath}
            >
              {loading ? '处理中…' : (singleTarget ? '开始反编译' : `批量反编译（${inputs.length} 项）`)}
            </button>
            {result?.outputDir && (
              <button className="btn btn-secondary" onClick={() => useDecompileResult(result.outputDir)} disabled={loading}>
                用此目录回编译
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="form-group">
            <label>反编译目录</label>
            <div className="file-input-group">
              <input type="text" value={projectDir} readOnly placeholder="选择 apktool 工程或解包后的 IPA 目录" />
              <button className="btn btn-secondary" onClick={selectProject} disabled={loading}>浏览</button>
            </div>
            <small className={`decompile-hint${projectDir && !rebuildKind ? ' is-warn' : ''}`}>
              {REBUILD_HINT[rebuildKind || (projectDir ? 'unknown' : 'android')]}
            </small>
          </div>

          <div className="form-group">
            <label>输出文件</label>
            <div className="file-input-group">
              <input
                type="text"
                value={rebuildOutput}
                onChange={(event) => setRebuildOutput(event.target.value)}
                placeholder={rebuildKind === 'ios' ? 'xxx-rebuilt.ipa' : 'xxx-rebuilt.apk'}
              />
              <button className="btn btn-secondary" onClick={selectRebuildOutput} disabled={loading}>浏览</button>
            </div>
          </div>

          {rebuildKind !== 'ios' && (
            <>
              <div className="form-group">
                <label>签名文件 (Keystore)</label>
                <div className="file-input-group">
                  <input
                    type="text"
                    value={keystorePath}
                    onChange={(event) => setKeystorePath(event.target.value)}
                    placeholder="默认填入全局配置，可在此单独修改"
                  />
                  <button className="btn btn-secondary" onClick={selectKeystore} disabled={loading}>浏览</button>
                </div>
                <small className="decompile-hint">默认取「设置」里的配置，这里改只影响本次回编译。</small>
              </div>

              <div className="form-group">
                <label>别名 (Alias)</label>
                <input
                  type="text"
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  placeholder="签名别名"
                />
              </div>

              <PlainSecretField
                id="decompile-keystore-secret"
                label="密码（始终明文显示）"
                value={password}
                onChange={setPassword}
                placeholder="签名密码"
              />

              <div className="form-group">
                <label>签名方案</label>
                <div className="sign-scheme-presets">
                  {SCHEME_PRESETS.map((preset) => {
                    const active = v1 === preset.v1 && v2 === preset.v2 && v3 === preset.v3;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`sign-scheme-chip${active ? ' is-active' : ''}`}
                        onClick={() => { setV1(preset.v1); setV2(preset.v2); setV3(preset.v3); }}
                        disabled={loading}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <div className="sign-scheme-checks">
                  <label>
                    <input type="checkbox" checked={v1} onChange={(event) => setV1(event.target.checked)} disabled={loading} />
                    v1（JAR，Android 4+）
                  </label>
                  <label>
                    <input type="checkbox" checked={v2} onChange={(event) => setV2(event.target.checked)} disabled={loading} />
                    v2（Android 7+）
                  </label>
                  <label>
                    <input type="checkbox" checked={v3} onChange={(event) => setV3(event.target.checked)} disabled={loading} />
                    v3（Android 9+）
                  </label>
                </div>
                <small className="decompile-hint">
                  回编译后先 zipalign -p 4 对齐，再按勾选方案调用 apksigner。默认 v1 + v2。
                </small>
              </div>
            </>
          )}

          <div className="action-buttons">
            <button
              className="btn btn-primary"
              onClick={rebuild}
              disabled={
                loading
                || !projectDir
                || !rebuildOutput
                || (rebuildKind !== 'ios' && (!keystorePath || (!v1 && !v2 && !v3)))
              }
            >
              {loading ? '处理中…' : rebuildKind === 'ios' ? '开始回编译' : '回编译并对齐签名'}
            </button>
          </div>
        </>
      )}

      {progress && (
        <div className="decompile-progress">
          <div className="decompile-progress__bar">
            <span style={{ width: `${progress.percent || 0}%` }} />
          </div>
          <div className="decompile-progress__text">
            {progress.total ? `[${progress.index || 1}/${progress.total}] ` : ''}
            {progress.file ? `${progress.file} · ` : ''}
            {progress.stage}
            {progress.detail ? ` · ${progress.detail}` : ''}
          </div>
        </div>
      )}

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      {batch && (
        <div className="decompile-batch">
          <div className="decompile-batch__head">
            批量结果：成功 <b>{result.succeeded}</b> 个
            {result.failed ? <> · 失败 <b>{result.failed}</b> 个</> : null}
          </div>
          <ul className="decompile-batch__list">
            {result.results.map((item) => (
              <li key={item.input} className={`decompile-batch__row${item.ok ? '' : ' is-fail'}`}>
                <span className="decompile-batch__name" title={item.input}>
                  {String(item.input).split(/[\\/]/).pop()}
                </span>
                <span className="decompile-batch__state">
                  {item.ok ? (item.outputDir || '完成') : item.error}
                </span>
                {item.ok && item.outputDir ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline"
                    onClick={() => useDecompileResult(item.outputDir)}
                    disabled={loading}
                  >
                    回编译
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.symbols && (
        <div className="decompile-symbols">
          <div className="decompile-symbols__head">
            从 <code>{result.symbols.binary}</code> 提取（{result.symbols.architectures} 个架构）
          </div>
          <div className="decompile-symbols__counts">
            <span>ObjC 类 <b>{result.symbols.counts.classes}</b></span>
            <span>方法 <b>{result.symbols.counts.methods}</b></span>
            <span>Swift 串 <b>{result.symbols.counts.swift}</b></span>
            <span>C 字符串 <b>{result.symbols.counts.strings}</b></span>
            <span>符号 <b>{result.symbols.counts.symbols}</b></span>
          </div>
          {result.symbols.samples.classes.length > 0 && (
            <div className="decompile-symbols__sample">
              <span className="decompile-symbols__label">类名示例</span>
              {result.symbols.samples.classes.map((name) => <code key={name}>{name}</code>)}
            </div>
          )}
          <div className="decompile-symbols__hint">
            完整清单在输出目录的 <code>_symbols/</code> 下（classes.txt / methods.txt / symbols.txt / strings.txt）
          </div>
        </div>
      )}
    </div>
  );
}

export default DecompileApk;
