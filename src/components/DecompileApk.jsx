import React, { useEffect, useState } from 'react';
import { cleanIpcError } from '../lib/errorText';

/** 按扩展名判断类型，用于切换文案与提示。 */
const kindOf = (filePath) => {
  const ext = String(filePath || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!ext) return null;
  if (ext[1] === 'apk' || ext[1] === 'aab') return 'android';
  if (ext[1] === 'ipa') return 'ios';
  return null;
};

const KIND_HINT = {
  android: '用 apktool 解包成可读目录（资源、清单、smali）',
  ios: '解包 IPA，并从主二进制提取 ObjC 类名 / 方法名 / Swift 反射串 / 符号表。'
    + '注意：这是元数据提取，不是反汇编成源码'
};

const REBUILD_HINT = {
  android: '选择带 apktool.yml 的反编译目录。回编译后会按设置里的签名文件做 zipalign + v1+v2 签名。',
  ios: '选择解包后的 IPA 目录（含 Payload/*.app），重新打成 IPA。如需改签，请到「应用签名」。',
  unknown: '目录里要有 apktool.yml（Android）或 Payload/*.app（iOS）'
};

function DecompileApk({ config = {} }) {
  const [mode, setMode] = useState('decompile');
  const [packagePath, setPackagePath] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [rebuildOutput, setRebuildOutput] = useState('');
  const [rebuildKind, setRebuildKind] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const kind = kindOf(packagePath);

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

  const selectPackage = async () => {
    const picker = window.electronAPI.selectAppPackage || window.electronAPI.selectApk;
    const nextPath = await picker();
    if (!nextPath) return;

    setPackagePath(nextPath);
    const lastSlash = Math.max(nextPath.lastIndexOf('/'), nextPath.lastIndexOf('\\'));
    setOutputPath(lastSlash > 0 ? nextPath.slice(0, lastSlash) : '');
    setMessage(null);
    setResult(null);
    setProgress(null);
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

  const decompile = async () => {
    if (!packagePath) {
      setMessage({ type: 'error', text: '请先选择 APK / AAB / IPA 文件' });
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
      const payload = { jobId: `decompile-${Date.now()}` };
      const res = await window.electronAPI.decompileApk(packagePath, outputPath, payload);
      setResult(res);
      setMessage({ type: 'success', text: res.message });
      if (res.outputDir) {
        setProjectDir(res.outputDir);
        await inspectProject(res.outputDir);
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

    setLoading(true);
    setMessage(null);
    setResult(null);
    setProgress({ percent: 0, stage: '准备回编译' });

    try {
      const res = await window.electronAPI.rebuildPackage({
        projectDir,
        outputPath: rebuildOutput,
        jobId: `rebuild-${Date.now()}`
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
            <label>选择 APK / AAB / IPA 文件</label>
            <div className="file-input-group">
              <input type="text" value={packagePath} readOnly placeholder="请选择 APK、AAB 或 IPA 文件" />
              <button className="btn btn-secondary" onClick={selectPackage} disabled={loading}>浏览</button>
            </div>
            {kind && <small className="decompile-hint">{KIND_HINT[kind]}</small>}
            {packagePath && !kind && (
              <small className="decompile-hint is-warn">
                无法识别的扩展名，仅支持 APK / AAB / IPA
              </small>
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
              disabled={loading || !packagePath || !kind}
            >
              {loading ? '处理中…' : '开始反编译'}
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
            <div className="form-group">
              <label>签名（全局配置，默认 v1 + v2）</label>
              <div className="secret-preview">
                {config.keystorePath
                  ? `${config.keystorePath} · 别名 ${config.alias || '（未配置）'} · 先 zipalign 再签`
                  : '还没有配置签名文件，请先到「设置」里选 keystore'}
              </div>
              <small className="decompile-hint">
                回编译会直接对齐并签名，不必再去「应用签名」走一遍。
              </small>
            </div>
          )}

          <div className="action-buttons">
            <button
              className="btn btn-primary"
              onClick={rebuild}
              disabled={
                loading
                || !projectDir
                || !rebuildOutput
                || (rebuildKind !== 'ios' && !config.keystorePath)
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
            {progress.stage}
            {progress.detail ? ` · ${progress.detail}` : ''}
          </div>
        </div>
      )}

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

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
