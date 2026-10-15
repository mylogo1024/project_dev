'use strict';

(() => {
  const breadcrumbs = document.getElementById('breadcrumbs');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  const fileList = document.getElementById('file-list');
  const fileCount = document.getElementById('file-count');
  const message = document.getElementById('message');
  const queue = document.getElementById('upload-queue');
  const refresh = document.getElementById('refresh');
  let currentPath = '';
  let loading = false;
  const pageToken = new URLSearchParams(window.location.search).get('token') || '';

  function joinPath(base, name) {
    return base ? `${base}/${name}` : name;
  }

  function apiUrl(route, targetPath) {
    const params = new URLSearchParams();
    if (targetPath) params.set('path', targetPath);
    if (pageToken) params.set('token', pageToken);
    const query = params.toString();
    return query ? `${route}?${query}` : route;
  }

  function formatBytes(value) {
    if (value === null || value === undefined) return '';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = value;
    let unit = -1;
    do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  if (!breadcrumbs || !fileInput || !fileList || !fileCount || !message || !queue || !refresh) return;

  function looksLikeCode(text) {
    const value = String(text || '');
    if (value.length > 160) return true;
    return /fileInput|uploadSequentially|loadDirectory|uploadOne|function |is not valid JSON|Unexpected token|try \{|=> \{/i.test(value);
  }

  function humanizeError(error, fallback) {
    const text = String(error && error.message || error || '');
    if (/UNAUTHORIZED|Authentication required/i.test(text)) {
      return '请使用页面上的完整令牌地址或二维码打开。';
    }
    if (/INVALID_HOST|Host header/i.test(text)) {
      return '访问地址与当前网络不匹配，请回到应用刷新二维码。';
    }
    if (/ROOT_REQUIRED/i.test(text)) return '还没有选择共享目录。';
    if (!text || looksLikeCode(text)) return fallback;
    return text;
  }

  function setMessage(text, kind = '') {
    message.textContent = text;
    message.className = `message ${kind}`.trim();
  }

  async function readJson(response) {
    const type = String(response.headers.get('content-type') || '');
    if (!type.includes('application/json')) {
      throw new Error('无法读取服务器响应，请使用完整令牌地址重新打开页面。');
    }
    return response.json();
  }

  async function readError(response) {
    try {
      const body = await readJson(response);
      return body.error && body.error.message ? body.error.message : `请求失败 (${response.status})`;
    } catch (error) {
      return humanizeError(error, `请求失败 (${response.status})`);
    }
  }

  function renderBreadcrumbs() {
    breadcrumbs.replaceChildren();
    const parts = currentPath.split('/').filter(Boolean);
    const entries = [{ label: '根目录', path: '' }];
    parts.forEach((part, index) => entries.push({ label: part, path: parts.slice(0, index + 1).join('/') }));
    entries.forEach((entry, index) => {
      if (index) {
        const separator = document.createElement('span');
        separator.textContent = '/';
        separator.setAttribute('aria-hidden', 'true');
        breadcrumbs.append(separator);
      }
      if (index === entries.length - 1) {
        const current = document.createElement('span');
        current.textContent = entry.label;
        current.setAttribute('aria-current', 'page');
        breadcrumbs.append(current);
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.label;
        button.addEventListener('click', () => loadDirectory(entry.path));
        breadcrumbs.append(button);
      }
    });
  }

  async function downloadFile(itemPath, filename) {
    try {
      const response = await fetch(apiUrl('/api/download', itemPath), { cache: 'no-store' });
      if (!response.ok) throw new Error(await readError(response));
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename || 'download';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    } catch (error) {
      setMessage(humanizeError(error, '下载失败。'), 'error');
    }
  }

  function renderFiles(files) {
    fileList.replaceChildren();
    fileCount.textContent = `${files.length} 项`;
    if (!files.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '这个文件夹是空的。';
      fileList.append(empty);
      return;
    }
    files.forEach(file => {
      const item = document.createElement('li');
      const main = document.createElement(file.type === 'directory' ? 'button' : 'div');
      const icon = document.createElement('span');
      const details = document.createElement('span');
      const name = document.createElement('strong');
      const metadata = document.createElement('small');
      const itemPath = joinPath(currentPath, file.name);
      item.className = `file-item ${file.type}`;
      main.className = 'file-link';
      icon.className = 'file-icon';
      icon.textContent = file.type === 'directory' ? '目录' : '文件';
      name.textContent = file.name;
      metadata.textContent = file.type === 'directory'
        ? '文件夹'
        : `${formatBytes(file.size)} · ${new Date(file.modifiedAt).toLocaleString('zh-CN')}`;
      details.append(name, metadata);
      main.append(icon, details);
      if (file.type === 'directory') {
        main.type = 'button';
        main.addEventListener('click', () => loadDirectory(itemPath));
        item.append(main);
      } else {
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'download-btn';
        download.textContent = '下载';
        download.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          downloadFile(itemPath, file.name);
        });
        item.append(main, download);
      }
      fileList.append(item);
    });
  }

  async function loadDirectory(targetPath) {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    setMessage('正在加载…');
    try {
      const response = await fetch(apiUrl('/api/files', targetPath), { cache: 'no-store' });
      if (!response.ok) throw new Error(await readError(response));
      const data = await readJson(response);
      currentPath = data.path || '';
      renderBreadcrumbs();
      renderFiles(Array.isArray(data.files) ? data.files : []);
      setMessage('');
    } catch (error) {
      setMessage(humanizeError(error, '无法打开这个文件夹。请使用页面上的完整令牌地址访问。'), 'error');
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  }

  function uploadOne(file, targetPath, relativeDir) {
    return new Promise((resolve, reject) => {
      const row = document.createElement('div');
      const label = document.createElement('span');
      const progress = document.createElement('progress');
      const status = document.createElement('span');
      row.className = 'upload-row';
      const displayName = relativeDir ? `${relativeDir}/${file.name}` : file.name;
      label.textContent = displayName;
      progress.max = 100;
      progress.value = 0;
      status.textContent = '等待中';
      row.append(label, progress, status);
      queue.append(row);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl('/api/upload', targetPath));
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      if (relativeDir) xhr.setRequestHeader('X-File-Path', encodeURIComponent(relativeDir));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.addEventListener('progress', event => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        progress.value = percent;
        status.textContent = `${percent}%`;
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          progress.value = 100;
          status.textContent = '完成';
          row.classList.add('success');
          resolve();
          return;
        }
        let text = `上传失败 (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body.error && body.error.message) text = humanizeError(body.error.message, text);
        } catch (_) { /* 错误体不是 JSON，退回原始文本即可 */ }
        status.textContent = text;
        row.classList.add('failed');
        reject(new Error(`${displayName}: ${text}`));
      });
      xhr.addEventListener('error', () => {
        status.textContent = '网络错误';
        row.classList.add('failed');
        reject(new Error(`${displayName}: 网络错误`));
      });
      xhr.addEventListener('abort', () => reject(new Error(`${displayName}: 已取消`)));
      status.textContent = '上传中';
      xhr.send(file);
    });
  }

  async function uploadSequentially(files, fromFolderInput) {
    const targetPath = currentPath;
    fileInput.disabled = true;
    if (folderInput) folderInput.disabled = true;
    let failures = 0;
    for (const file of files) {
      // 文件夹上传时，file.webkitRelativePath 形如 "myfolder/sub/file.txt"
      // 取其目录部分（去掉文件名），作为相对子目录传给服务端
      let relativeDir = '';
      if (fromFolderInput && file.webkitRelativePath) {
        const parts = file.webkitRelativePath.split('/');
        if (parts.length > 1) {
          // 去掉最后一段（文件名），保留目录结构
          relativeDir = parts.slice(0, -1).join('/');
        }
      }
      try {
        await uploadOne(file, targetPath, relativeDir);
      } catch (error) {
        failures += 1;
        setMessage(humanizeError(error, '上传失败。'), 'error');
      }
    }
    fileInput.disabled = false;
    fileInput.value = '';
    if (folderInput) {
      folderInput.disabled = false;
      folderInput.value = '';
    }
    if (!failures) setMessage(`已上传 ${files.length} 个文件。`, 'success');
    await loadDirectory(targetPath);
  }

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    if (files.length) uploadSequentially(files, false);
  });
  if (folderInput) {
    folderInput.addEventListener('change', () => {
      const files = Array.from(folderInput.files || []);
      if (files.length) uploadSequentially(files, true);
    });
  }
  refresh.addEventListener('click', () => loadDirectory(currentPath));
  loadDirectory('');
})();
