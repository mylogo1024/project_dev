import React, { useEffect, useMemo, useState } from 'react';
import './App.css';
import InstallApk from './components/InstallApk';
import DecompileApk from './components/DecompileApk';
import SignApk from './components/SignApk';
import ModifyHash from './components/ModifyHash';
import JsonTool from './components/JsonTool';
import MarkdownEditor from './components/MarkdownEditor';
import XmindViewer from './components/XmindViewer';
import Settings from './components/Settings';
import EnvironmentCheck from './components/EnvironmentCheck';
import FileManager from './components/FileManager';
import DeviceApps from './components/DeviceApps';
import LogViewer from './components/LogViewer';
import TextTools from './components/TextTools';
import QRCode from './components/QRCode';
import DeviceInfo from './components/DeviceInfo';
import PhoneDeviceInfo from './components/PhoneDeviceInfo';
import WebFileServer from './components/WebFileServer';
import WebDavServer from './components/WebDavServer';
import HttpClient from './components/HttpClient';
import DeviceControl from './components/DeviceControl';
import DeviceHub from './components/DeviceHub';
import BatchRename from './components/BatchRename';
import CodeSearch from './components/CodeSearch';
import PackageInfo from './components/PackageInfo';
import PlatformMatrix from './components/PlatformMatrix';
import CommandPalette from './components/common/CommandPalette';
import ErrorBoundary from './components/common/ErrorBoundary';
import ToastHost from './components/common/ToastHost';
import DexToolkit from './components/DexToolkit';
import {
  CATEGORIES,
  FILL_FUNCTIONS,
  FUNCTIONS,
  buildFavorites,
  findFunction,
  searchFunctions
} from './lib/functions';

const FAVORITE_KEY = 'toolbox:favorites';

/** localStorage 在部分环境下会抛（隐私模式 / 配额满），读写都要兜住。 */
const readStoredList = (key) => {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch (_) {
    return [];
  }
};

const writeStoredList = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* 存不下就算了，不影响使用 */
  }
};

function App() {
  const [selectedFunction, setSelectedFunction] = useState('');
  const [openedFunctions, setOpenedFunctions] = useState([]);
  const [instanceKeys, setInstanceKeys] = useState({});
  // 设备深链：从设备墙点进来时，带着 { device, target } 直接打开目标工具
  const [deviceLinks, setDeviceLinks] = useState({});
  const [favoriteIds, setFavoriteIds] = useState(() => readStoredList(FAVORITE_KEY));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState('');
  // 默认全空：签名相关的别名 / 密码只记录用户自己填的，不内置演示值
  const [config, setConfig] = useState({
    keystorePath: '',
    alias: '',
    password: ''
  });

  useEffect(() => { writeStoredList(FAVORITE_KEY, favoriteIds); }, [favoriteIds]);

  // ⌘K / Ctrl+K 打开命令面板；在输入框里按不劫持
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleFavorite = (id) => {
    setFavoriteIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const savedConfig = await window.electronAPI.loadConfig();
      if (savedConfig) {
        setConfig({
          keystorePath: savedConfig.keystorePath || '',
          alias: savedConfig.alias ?? '',
          password: savedConfig.password ?? ''
        });
      }
    } catch (error) {
      console.error('加载配置失败:', error);
    }
  };

  const saveConfig = async (newConfig) => {
    await window.electronAPI.saveConfig(newConfig);
    setConfig({
      keystorePath: newConfig.keystorePath || '',
      alias: newConfig.alias ?? '',
      password: newConfig.password ?? ''
    });
  };

  const openFunction = (id) => {
    setSelectedFunction(id);
    if (!id) return;
    setOpenedFunctions((current) => (current.includes(id) ? current : [...current, id]));
  };

  /**
   * 设备墙深链：带着设备直接进目标工具。
   * 每个功能记最近一次带入的设备 —— reload 换 instanceKey 时随新实例生效，
   * 已打开的功能再次点同一台设备也更新（组件按 deviceLinkId 判断变化）。
   */
  const openToolWithDevice = ({ device, target }) => {
    if (!target || !findFunction(target)) return;
    const linkId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDeviceLinks((current) => ({ ...current, [target]: { device, linkId } }));
    openFunction(target);
  };

  const goHome = () => setSelectedFunction('');

  const reloadCurrent = () => {
    if (!selectedFunction) return;
    setInstanceKeys((current) => ({
      ...current,
      [selectedFunction]: (current[selectedFunction] || 0) + 1
    }));
  };

  const getCurrentFunction = () => findFunction(selectedFunction);

  const favoriteFunctions = useMemo(() => buildFavorites(favoriteIds), [favoriteIds]);

  const sidebarFunctions = useMemo(() => {
    const keyword = sidebarQuery.trim();
    if (!keyword) return FUNCTIONS;
    return searchFunctions(keyword);
  }, [sidebarQuery]);

  const renderFunction = (id, instanceKey) => {
    // 设备墙带进来的设备：进哪个工具，哪台设备就绪（不用再选一次）
    const link = deviceLinks[id] || null;
    switch (id) {
      case 'install':
        return <InstallApk key={instanceKey} />;
      case 'decompile':
        return <DecompileApk key={instanceKey} config={config} />;
      case 'info':
        return <PackageInfo key={instanceKey} />;
      case 'code-search':
        return <CodeSearch key={instanceKey} />;
      case 'sign':
        return <SignApk key={instanceKey} config={config} />;
      case 'files':
        return <FileManager key={instanceKey} initialDevice={link?.device} />;
      case 'apps':
        return <DeviceApps key={instanceKey} initialDevice={link?.device} />;
      case 'phone-device':
        return <PhoneDeviceInfo key={instanceKey} initialDevice={link?.device} />;
      case 'scrcpy':
        return <DeviceControl key={instanceKey} initialDevice={link?.device} />;
      case 'logs':
        return <LogViewer key={instanceKey} initialDevice={link?.device} />;
      case 'hash':
        return <ModifyHash key={instanceKey} />;
      case 'rename':
        return <BatchRename key={instanceKey} />;
      case 'json':
        return <JsonTool key={instanceKey} />;
      case 'markdown':
        return <MarkdownEditor key={instanceKey} />;
      case 'xmind':
        return <XmindViewer key={instanceKey} />;
      case 'text':
        return <TextTools key={instanceKey} />;
      case 'http':
        return <HttpClient key={instanceKey} />;
      case 'qrcode':
        return <QRCode key={instanceKey} />;
      case 'web-file-server':
        return <WebFileServer key={instanceKey} />;
      case 'webdav-server':
        return <WebDavServer key={instanceKey} />;
      case 'device':
        return <DeviceInfo key={instanceKey} />;
      case 'settings':
        return <Settings key={instanceKey} config={config} onSave={saveConfig} />;
      case 'dex-toolkit':
        return <DexToolkit key={instanceKey} />;
      default:
        return null;
    }
  };

  const renderWelcome = () => (
    <div className="welcome">
      <div className="welcome-header">
        <div className="welcome-icon">🛠️</div>
        <h2>设备自动化工作台</h2>
        <p>扫描设备，从设备卡片直达投屏操控、实时日志、文件与应用管理 —— 录制操作，交给无人值守</p>
      </div>

      {/* 设备墙是工作台的正门：连设备 → 看到设备 → 点卡片进工具 */}
      <DeviceHub onOpenTool={openToolWithDevice} />

      <details className="welcome-platform" open={false}>
        <summary>🖥️ 平台支持矩阵（macOS / Windows / Linux 功能可用性）</summary>
        <PlatformMatrix />
      </details>

      <EnvironmentCheck />

      <details className="welcome-more" open={false}>
        <summary>🧰 全部工具（按分类）</summary>
        <div className="quick-access">
          {CATEGORIES.map((category) => (
            <div key={category.id} className="category">
              <h3>{category.name}</h3>
              <div className="category-items">
                {category.functions
                  .map((id) => findFunction(id))
                  .filter(Boolean)
                  .map((func) => (
                    <button key={func.id} className="quick-btn" onClick={() => openFunction(func.id)}>
                      <span className="quick-icon">{func.icon}</span>
                      <span>{func.name}</span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="logo" onClick={goHome} style={{ cursor: 'pointer' }}>
          <div className="logo-icon">🛠️</div>
          <h1>开发工具箱</h1>
        </div>
        <div className="sidebar-search">
          <span className="sidebar-search__icon">🔍</span>
          <input
            className="sidebar-search__input"
            value={sidebarQuery}
            onChange={(event) => setSidebarQuery(event.target.value)}
            placeholder="搜索功能"
            spellCheck={false}
          />
          {sidebarQuery ? (
            <button className="sidebar-search__clear" onClick={() => setSidebarQuery('')} title="清空">×</button>
          ) : (
            <button className="sidebar-search__kbd" onClick={() => setPaletteOpen(true)} title="打开命令面板">⌘K</button>
          )}
        </div>

        {!sidebarQuery && favoriteFunctions.length > 0 && (
          <div className="sidebar-quick">
            <div className="sidebar-group-title">收藏</div>
            {favoriteFunctions.map((func) => (
              <div
                key={`fav-${func.id}`}
                className={`function-item ${selectedFunction === func.id ? 'active' : ''}`}
                onClick={() => openFunction(func.id)}
              >
                <span className="icon">{func.icon}</span>
                <span className="name">{func.name}</span>
                <button
                  className="function-star is-on"
                  title="取消收藏"
                  onClick={(event) => { event.stopPropagation(); toggleFavorite(func.id); }}
                >
                  ★
                </button>
              </div>
            ))}
            <div className="sidebar-group-title">全部功能</div>
          </div>
        )}

        <div className="function-list">
          {sidebarFunctions.length === 0 && (
            <div className="sidebar-empty">没有匹配的功能</div>
          )}
          {sidebarFunctions.map(func => (
            <div
              key={func.id}
              className={`function-item ${selectedFunction === func.id ? 'active' : ''} ${openedFunctions.includes(func.id) && selectedFunction !== func.id ? 'kept' : ''}`}
              onClick={() => openFunction(func.id)}
            >
              <span className="icon">{func.icon}</span>
              <span className="name">{func.name}</span>
              <button
                className={`function-star ${favoriteIds.includes(func.id) ? 'is-on' : ''}`}
                title={favoriteIds.includes(func.id) ? '取消收藏' : '收藏'}
                onClick={(event) => { event.stopPropagation(); toggleFavorite(func.id); }}
              >
                {favoriteIds.includes(func.id) ? '★' : '☆'}
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className={`main-content ${FILL_FUNCTIONS.includes(selectedFunction) ? 'main-content--fill' : ''}`}>
        {selectedFunction && (
          <div className="top-nav">
            <button className="back-btn" onClick={goHome}>
              <span>⬅️</span>
              <span>返回首页</span>
            </button>
            <div className="breadcrumb">
              <span className="breadcrumb-home" onClick={goHome}>首页</span>
              <span className="breadcrumb-separator">/</span>
              <span className="breadcrumb-current">{getCurrentFunction()?.name}</span>
            </div>
            <button
              className="reload-btn"
              type="button"
              title="重新加载当前功能，丢弃本页状态并重新开始"
              onClick={reloadCurrent}
            >
              <span>🔄</span>
              <span>重新加载</span>
            </button>
          </div>
        )}
        {!selectedFunction && renderWelcome()}
        {openedFunctions.map((id) => (
          <div
            key={id}
            className={`workspace-panel ${selectedFunction === id ? 'is-active' : 'is-hidden'}`}
            aria-hidden={selectedFunction !== id}
          >
            {/* 每个功能单独兜底：一个工具渲染崩了，其它工具还能继续用 */}
            <ErrorBoundary
              title={`「${findFunction(id)?.name || id}」出错了`}
              resetKey={`${id}-${instanceKeys[id] || 0}`}
              onReset={() => {
                if (selectedFunction === id) reloadCurrent();
                else setInstanceKeys((current) => ({ ...current, [id]: (current[id] || 0) + 1 }));
              }}
            >
              {renderFunction(id, instanceKeys[id] || 0)}
            </ErrorBoundary>
          </div>
        ))}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(id) => { setPaletteOpen(false); openFunction(id); }}
        favoriteIds={favoriteIds}
      />

      {/* 全局提示条：替代散落各处的阻塞式 alert */}
      <ToastHost />
    </div>
  );
}

export default App;
