import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FUNCTIONS, buildFavorites, searchFunctions } from '../../lib/functions';

/**
 * 全局命令面板（⌘K / Ctrl+K）。
 *
 * 功能多起来之后，「在侧边栏 20 个条目里找那个功能」本身就是成本。
 * 面板把「收藏 → 全部」按组铺开，并支持关键词搜索
 * （搜 apk / 抓包 / 正则 都能命中，不必记得功能叫什么）。
 */
function CommandPalette({ open, onClose, onPick, favoriteIds = [] }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const favorites = useMemo(() => buildFavorites(favoriteIds), [favoriteIds]);

  const sections = useMemo(() => {
    const keyword = query.trim();
    if (keyword) {
      return [{ id: 'match', title: `匹配「${keyword}」`, items: searchFunctions(keyword) }];
    }
    const groups = [];
    if (favorites.length) groups.push({ id: 'favorite', title: '收藏', items: favorites });
    groups.push({ id: 'all', title: '全部功能', items: FUNCTIONS });
    return groups;
  }, [query, favorites]);

  // 拍平成一个连续索引，键盘上下键才能跨分组移动
  const rendered = useMemo(() => {
    let cursor = 0;
    return sections.map((section) => ({
      ...section,
      entries: section.items.map((item) => ({ item, index: cursor++ }))
    }));
  }, [sections]);

  const total = rendered.reduce((sum, section) => sum + section.entries.length, 0);

  useEffect(() => { setActiveIndex(0); }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return undefined;
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open]);

  // 键盘移动时把选中项滚进可视区
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('.command-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, total]);

  if (!open) return null;

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (total ? (current + 1) % total : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (total ? (current - 1 + total) % total : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = rendered
        .flatMap((section) => section.entries)
        .find((entry) => entry.index === activeIndex);
      if (picked) onPick?.(picked.item.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
    }
  };

  return (
    <div className="command-mask" onMouseDown={onClose}>
      <div
        className="command-panel"
        role="dialog"
        aria-modal="true"
        aria-label="功能搜索"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-input-row">
          <span className="command-input-icon">🔍</span>
          <input
            ref={inputRef}
            className="command-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索功能：试试 apk / 签名 / 正则 / 投屏 / json"
            spellCheck={false}
          />
          <kbd className="command-kbd">Esc</kbd>
        </div>

        <div className="command-list" ref={listRef}>
          {total === 0 && <div className="command-empty">没有匹配的功能，换个关键词试试</div>}
          {rendered.map((section) => (
            <div key={section.id} className="command-group">
              <div className="command-group__title">{section.title}</div>
              {section.entries.map(({ item, index }) => (
                <button
                  key={`${section.id}-${item.id}`}
                  type="button"
                  className={`command-item ${index === activeIndex ? 'is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onPick?.(item.id)}
                >
                  <span className="command-item__icon">{item.icon}</span>
                  <span className="command-item__name">{item.name}</span>
                  {favoriteIds.includes(item.id) && <span className="command-item__star" title="已收藏">★</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="command-foot">
          <span className="command-foot__hint"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span className="command-foot__hint"><kbd>Enter</kbd> 打开</span>
          <span className="command-foot__hint"><kbd>Esc</kbd> 关闭</span>
          <span className="command-foot__count">{total} 项</span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
