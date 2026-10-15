import React, { useEffect, useRef, useState } from 'react';

function SplitPane({
  direction = 'horizontal',
  initial = 50,
  min = 18,
  children
}) {
  const [ratio, setRatio] = useState(initial);
  const paneRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const update = (clientX, clientY) => {
      const node = paneRef.current;
      if (!draggingRef.current || !node) return;
      const rect = node.getBoundingClientRect();
      const next = direction === 'horizontal'
        ? ((clientX - rect.left) / rect.width) * 100
        : ((clientY - rect.top) / rect.height) * 100;
      setRatio(Math.min(100 - min, Math.max(min, next)));
    };

    const onMove = (event) => update(event.clientX, event.clientY);
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [direction, min]);

  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length < 2) return items[0] || null;

  const startDrag = () => {
    draggingRef.current = true;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className={`split-pane is-${direction}`} ref={paneRef}>
      <div className="split-pane-item" style={{ flexGrow: ratio, flexShrink: 1, flexBasis: 0 }}>
        {items[0]}
      </div>
      <div
        className="split-pane-handle"
        role="separator"
        aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
        onMouseDown={startDrag}
      />
      <div className="split-pane-item" style={{ flexGrow: 100 - ratio, flexShrink: 1, flexBasis: 0 }}>
        {items[1]}
      </div>
    </div>
  );
}

export default SplitPane;
