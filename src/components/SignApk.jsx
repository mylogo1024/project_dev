import React, { useEffect, useState } from 'react';
import PlainSecretField from './PlainSecretField';
import { cleanIpcError } from '../lib/errorText';
import { copyTextWithToast } from '../lib/clipboard';

/**
 * 把「描述文件覆盖不覆盖当前设备」说成**一句事实**。
 *
 * 为什么强调「事实」：这里原先是一句写死的断言（大意是「原包的描述文件一般不含你
 * 的设备」）。但用户选的描述文件很可能**是**含他设备的，于是那句断言自相矛盾。
 * 现在只陈述从包内实际读到的东西，不再替用户下结论。
 */
function describeDeviceCoverage(signature) {
  if (!signature?.available) return '读不出';
  if (!signature.hasDeviceList) return '未列出设备（企业/App Store 描述文件，任意设备可装）';
  if (signature.deviceIncluded === true) return `${signature.deviceCount} 台设备，包含当前设备`;
  if (signature.deviceIncluded === false) return `${signature.deviceCount} 台设备，不含当前设备`;
  return `${signature.deviceCount} 台设备（未连接设备，无法比对）`;
}

function SignApk({ config }) {
  const [platform, setPlatform] = useState('android');
  const [apkPath, setApkPath] = useState('');
  const [keystorePath, setKeystorePath] = useState(config.keystorePath || '');
  const [alias, setAlias] = useState(config.alias || 'csgame');
  const [password, setPassword] = useState(config.password || '123');
  const [ipaPath, setIpaPath] = useState('');
  const [provisionPath, setProvisionPath] = useState('');
  const [provisionInfo, setProvisionInfo] = useState(null);
  const [identities, setIdentities] = useState([]);
  const [identity, setIdentity] = useState('');
  const [p12Path, setP12Path] = useState('');
  const [p12Password, setP12Password] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [appName, setAppName] = useState('');
  const [v1, setV1] = useState(true);
  const [v2, setV2] = useState(true);
  const [v3, setV3] = useState(true);
  const [message, setMessage] = useState(null);
  // 重签名产物的路径。**必须显式展示出来** —— 实测用户装了原包导致
  // 「签名校验未通过」，而原包与产物在同一个目录、文件名只差一个 -resigned。
  const [resignOutput, setResignOutput] = useState(null);
  const [resignProgress, setResignProgress] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setKeystorePath(config.keystorePath || '');
    setAlias(config.alias || 'csgame');
    setPassword(config.password || '123');
  }, [config]);

  // 订阅重签名进度。重签名要解压几百 MB、签上百个目标、再重新打包 ——
  // 没有进度的话界面会长时间一动不动，用户会以为卡死。
  useEffect(() => {
    const unsubscribe = window.electronAPI.onResignProgress?.((payload) => {
      setResignProgress(payload);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (platform !== 'ios') return undefined;
    let cancelled = false;
    const loadIdentities = async () => {
      try {
        const list = await window.electronAPI.listCodeSignIdentities();
        if (cancelled) return;
        setIdentities(Array.isArray(list) ? list : []);
        setIdentity((current) => {
          if (current && list.some((item) => item.hash === current || item.name === current)) return current;
          return list[0]?.hash || '';
        });
      } catch (error) {
        if (!cancelled) setMessage({ type: 'error', text: cleanIpcError(error) });
      }
    };
    loadIdentities();
    return () => { cancelled = true; };
  }, [platform]);

  const selectApk = async () => {
    const nextPath = await window.electronAPI.selectApk();
    if (nextPath) {
      setApkPath(nextPath);
      setMessage(null);
    }
  };

  const selectKeystore = async () => {
    const nextPath = await window.electronAPI.selectKeystore();
    if (nextPath) setKeystorePath(nextPath);
  };

  const selectIpa = async () => {
    const selector = window.electronAPI.selectFiles || window.electronAPI.selectAppPackage;
    const nextPath = await selector({
      filters: [{ name: 'iOS IPA', extensions: ['ipa'] }]
    });
    if (!nextPath) return;
    setIpaPath(nextPath);
    setMessage(null);
    try {
      const info = await (window.electronAPI.getPackageInfo || window.electronAPI.getApkInfo)(nextPath);
      if (info?.basic?.packageName) setBundleId(info.basic.packageName);
      if (info?.basic?.appName) setAppName(info.basic.appName);
    } catch (_) { /* 读不到包信息就不预填，用户仍可手输 */ }
  };

  const selectProvision = async () => {
    const nextPath = await window.electronAPI.selectFiles({
      filters: [{ name: 'Provisioning Profile', extensions: ['mobileprovision'] }]
    });
    if (!nextPath) return;
    setProvisionPath(nextPath);
    try {
      const info = await window.electronAPI.inspectProvision(nextPath);
      setProvisionInfo(info);
      if (info?.bundleId) setBundleId(info.bundleId);
    } catch (error) {
      setProvisionInfo(null);
      setMessage({ type: 'error', text: cleanIpcError(error) });
    }
  };

  const selectP12 = async () => {
    const nextPath = await window.electronAPI.selectFiles({
      filters: [{ name: 'PKCS12 证书', extensions: ['p12', 'pfx'] }]
    });
    if (nextPath) setP12Path(nextPath);
  };

  const signAndroid = async () => {
    if (!apkPath) {
      setMessage({ type: 'error', text: '请先选择 APK 文件' });
      return;
    }
    if (!keystorePath) {
      setMessage({ type: 'error', text: '请选择签名文件' });
      return;
    }
    if (!alias) {
      setMessage({ type: 'error', text: '请输入别名' });
      return;
    }
    if (!password) {
      setMessage({ type: 'error', text: '请输入密码' });
      return;
    }
    if (!v1 && !v2 && !v3) {
      setMessage({ type: 'error', text: '请至少勾选一种签名方案（v1 / v2 / v3）' });
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.signApk({
        apkPath,
        keystorePath,
        alias,
        password,
        v1,
        v2,
        v3
      });
      setMessage({ type: 'success', text: result.message });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error) });
    } finally {
      setLoading(false);
    }
  };

  const signIos = async () => {
    if (!ipaPath) {
      setMessage({ type: 'error', text: '请先选择 IPA 文件' });
      return;
    }
    if (!provisionPath) {
      setMessage({ type: 'error', text: '请选择配置文件' });
      return;
    }
    if (!p12Path && !identity) {
      setMessage({ type: 'error', text: '请选择证书，或导入 p12' });
      return;
    }
    if (!bundleId.trim()) {
      setMessage({ type: 'error', text: '请填写包名' });
      return;
    }
    // APP 名称不校验：留空即沿用包内已有名称

    setLoading(true);
    setMessage(null);
    setResignOutput(null);
    setResignProgress({ percent: 0, stage: '准备重签名', detail: '' });
    try {
      const result = await window.electronAPI.resignIpa({
        ipaPath,
        provisionPath,
        identity,
        p12Path,
        p12Password,
        bundleId: bundleId.trim(),
        appName: appName.trim()
      });
      setMessage({ type: 'success', text: result.message });

      // 不写死「原包不含你的设备」这种断言 —— 去读两个包里的描述文件，按事实说话。
      // 用户选的那个描述文件很可能**是**含他的设备的，写死的断言会自相矛盾。
      let sourceSignature = null;
      let outputSignature = null;
      try {
        const [src, out] = await Promise.all([
          window.electronAPI.inspectIpaSignature({ ipaPath }),
          window.electronAPI.inspectIpaSignature({ ipaPath: result.outputPath })
        ]);
        sourceSignature = src?.available ? src : null;
        outputSignature = out?.available ? out : null;
      } catch (_) {
        // 读不出签名事实就不展示这一段，不影响签名结果本身
      }

      setResignOutput({
        outputPath: result.outputPath || '',
        sourcePath: ipaPath,
        bundleId: result.bundleId || bundleId.trim(),
        appName: result.appName || '',
        appNameReused: result.appNameReused === true,
        sourceSignature,
        outputSignature
      });
    } catch (error) {
      setMessage({ type: 'error', text: cleanIpcError(error) });
    } finally {
      setLoading(false);
      setResignProgress(null);
    }
  };

  return (
    <div className="content-card">
      <h2>应用签名</h2>
      <div className="sign-platform-tabs">
        <button
          className={`text-tab ${platform === 'android' ? 'is-active' : ''}`}
          onClick={() => { setPlatform('android'); setMessage(null); }}
        >
          Android
        </button>
        <button
          className={`text-tab ${platform === 'ios' ? 'is-active' : ''}`}
          onClick={() => { setPlatform('ios'); setMessage(null); }}
        >
          iOS 重签名
        </button>
      </div>

      {platform === 'android' ? (
        <>
          <div className="form-group">
            <label>选择 APK 文件</label>
            <div className="file-input-group">
              <input type="text" value={apkPath} readOnly placeholder="请选择 APK 文件" />
              <button className="btn btn-secondary" onClick={selectApk}>浏览</button>
            </div>
          </div>

          <div className="form-group">
            <label>签名文件 (Keystore)</label>
            <div className="file-input-group">
              <input
                type="text"
                value={keystorePath}
                onChange={(e) => setKeystorePath(e.target.value)}
                placeholder="请选择签名文件"
              />
              <button className="btn btn-secondary" onClick={selectKeystore}>浏览</button>
            </div>
          </div>

          <div className="form-group">
            <label>别名 (Alias)</label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="csgame"
            />
          </div>

          <PlainSecretField
            id="sign-keystore-secret"
            label="密码（始终明文显示）"
            value={password}
            onChange={setPassword}
            placeholder="123"
          />

          <div className="form-group">
            <label>签名方案（可多选，任意组合）</label>
            <div className="sign-scheme-presets">
              {[
                { id: 'v1', label: '仅 v1', next: { v1: true, v2: false, v3: false } },
                { id: 'v2', label: '仅 v2', next: { v1: false, v2: true, v3: false } },
                { id: 'v3', label: '仅 v3', next: { v1: false, v2: false, v3: true } },
                { id: 'v1v2', label: 'v1 + v2', next: { v1: true, v2: true, v3: false } },
                { id: 'v2v3', label: 'v2 + v3', next: { v1: false, v2: true, v3: true } },
                { id: 'all', label: 'v1 + v2 + v3', next: { v1: true, v2: true, v3: true } }
              ].map((preset) => {
                const active = v1 === preset.next.v1 && v2 === preset.next.v2 && v3 === preset.next.v3;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`sign-scheme-chip${active ? ' is-active' : ''}`}
                    onClick={() => {
                      setV1(preset.next.v1);
                      setV2(preset.next.v2);
                      setV3(preset.next.v3);
                    }}
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
              签名前会先 zipalign -p 4 对齐，再按勾选方案调用 apksigner。需要 v2/v3 时不会退回 jarsigner。
            </small>
          </div>

          <div className="action-buttons">
            <button className="btn btn-primary" onClick={signAndroid} disabled={loading || !apkPath || (!v1 && !v2 && !v3)}>
              {loading ? '签名中...' : '开始签名'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-group">
            <label>选择 IPA 文件</label>
            <div className="file-input-group">
              <input type="text" value={ipaPath} readOnly placeholder="请选择 IPA 文件" />
              <button className="btn btn-secondary" onClick={selectIpa}>浏览</button>
            </div>
          </div>

          <div className="form-group">
            <label>配置文件（.mobileprovision）</label>
            <div className="file-input-group">
              <input type="text" value={provisionPath} readOnly placeholder="请选择描述文件" />
              <button className="btn btn-secondary" onClick={selectProvision}>浏览</button>
            </div>
            {provisionInfo && (
              <div className="secret-preview">
                {provisionInfo.name || '未命名配置'} · {provisionInfo.teamName || provisionInfo.teamId || '未知团队'}
                {provisionInfo.expiration ? ` · 过期 ${provisionInfo.expiration}` : ''}
              </div>
            )}
          </div>

          <div className="form-group">
            <label>证书（本机钥匙串）</label>
            <div className="file-input-group">
              <select value={identity} onChange={(event) => setIdentity(event.target.value)}>
                {identities.length === 0 ? (
                  <option value="">未找到代码签名证书</option>
                ) : identities.map((item) => (
                  <option key={item.hash} value={item.hash}>{item.name}</option>
                ))}
              </select>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  const list = await window.electronAPI.listCodeSignIdentities();
                  setIdentities(Array.isArray(list) ? list : []);
                }}
              >
                刷新
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>或导入 p12 证书（可选）</label>
            <div className="file-input-group">
              <input type="text" value={p12Path} readOnly placeholder="不选则使用上面的钥匙串证书" />
              <button className="btn btn-secondary" onClick={selectP12}>浏览</button>
            </div>
          </div>

          {p12Path ? (
            <PlainSecretField
              id="sign-p12-secret"
              label="p12 密码（始终明文显示）"
              value={p12Password}
              onChange={setP12Password}
              placeholder="如有密码请填写"
            />
          ) : null}

          <div className="form-group">
            <label>包名（Bundle ID）</label>
            <input
              type="text"
              value={bundleId}
              onChange={(event) => setBundleId(event.target.value)}
              placeholder="com.example.app"
            />
          </div>

          <div className="form-group">
            <label>APP 名称（可选）</label>
            <input
              type="text"
              value={appName}
              onChange={(event) => setAppName(event.target.value)}
              placeholder="留空则沿用包内已有的名称"
            />
          </div>

          <div className="action-buttons">
            <button className="btn btn-primary" onClick={signIos} disabled={loading || !ipaPath}>
              {loading ? '重签名中...' : '开始重签名'}
            </button>
          </div>

          {/* 重签名要解压几百 MB、签上百个目标、再重新打包，必须给进度 */}
          {loading && resignProgress && (
            <div className="sign-progress">
              <div className="sign-progress__head">
                <span>{resignProgress.stage}</span>
                <span className="sign-progress__percent">{resignProgress.percent}%</span>
              </div>
              <div className="sign-progress__bar">
                <div className="sign-progress__fill" style={{ width: `${resignProgress.percent}%` }} />
              </div>
              {resignProgress.detail && (
                <div className="sign-progress__detail">{resignProgress.detail}</div>
              )}
            </div>
          )}
        </>
      )}

      {message && (
        <div className={`message ${message.type}`}>
          {message.text}
        </div>
      )}

      {/*
        重签名成功后必须把「装哪个文件」说清楚。
        实测踩过：原包与产物在同一目录、文件名只差一个 -resigned，装原包会失败。
        但**不能写死「原包不含你的设备」这种断言** —— 那是按事实读出来的结论，
        不同包结论不同。所以这里展示从两个包里实际读到的描述文件信息。
      */}
      {resignOutput?.outputPath && (
        <div className="resign-output">
          <div className="resign-output__title">请安装这个文件（不是原包）</div>
          <div className="resign-output__row">
            <code className="resign-output__path">{resignOutput.outputPath}</code>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => copyTextWithToast(resignOutput.outputPath, { successText: '产物路径已复制' })}
            >
              复制路径
            </button>
          </div>

          <dl className="resign-output__facts">
            <div className="resign-output__fact">
              <dt>产物用的描述文件</dt>
              <dd>
                {resignOutput.outputSignature
                  ? `${resignOutput.outputSignature.profileName} · ${describeDeviceCoverage(resignOutput.outputSignature)}`
                  : '（读不出）'}
              </dd>
            </div>
            <div className="resign-output__fact">
              <dt>原包的描述文件</dt>
              <dd>
                {resignOutput.sourceSignature
                  ? `${resignOutput.sourceSignature.profileName} · ${describeDeviceCoverage(resignOutput.sourceSignature)}`
                  : '（读不出）'}
              </dd>
            </div>
            <div className="resign-output__fact">
              <dt>包名</dt>
              <dd>{resignOutput.bundleId}</dd>
            </div>
            {resignOutput.appName && (
              <div className="resign-output__fact">
                <dt>APP 名称</dt>
                <dd>
                  {resignOutput.appName}
                  {resignOutput.appNameReused && ' （沿用包内已有名称）'}
                </dd>
              </div>
            )}
          </dl>

          {resignOutput.outputSignature?.deviceIncluded === false && (
            <div className="resign-output__warn">
              你选的描述文件不含当前连接的这台设备 —— 装上去会被拒。
              请在 Apple 开发者后台把这台设备加进描述文件，重新下载后再签。
            </div>
          )}
          {resignOutput.outputSignature?.deviceIncluded === true
            && resignOutput.sourceSignature?.deviceIncluded === false && (
            <div className="resign-output__note">
              两个包的描述文件不同：原包的描述文件不含这台设备（所以装原包会失败），
              产物用的是你选的、含这台设备的描述文件。安装时请选上面这个产物。
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SignApk;
