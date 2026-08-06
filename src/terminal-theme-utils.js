const TRANSLUCENT_CELL_CLASS = 'terminal-cell-bg-translucent';
const SOURCE_DATA_KEY = 'terminalBgSource';
const CSS_NUMBER = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const COMMA_RGB_RE = new RegExp(
  `^rgba?\\(\\s*(${CSS_NUMBER})\\s*,\\s*(${CSS_NUMBER})\\s*,\\s*(${CSS_NUMBER})(?:\\s*,\\s*(${CSS_NUMBER}))?\\s*\\)$`,
  'i',
);
const SPACE_RGB_RE = new RegExp(
  `^rgba?\\(\\s*(${CSS_NUMBER})\\s+(${CSS_NUMBER})\\s+(${CSS_NUMBER})(?:\\s*\\/\\s*(${CSS_NUMBER}))?\\s*\\)$`,
  'i',
);
const CELL_BACKGROUND_SELECTOR = [
  `span.${TRANSLUCENT_CELL_CLASS}`,
  'span[style*="background-color"]',
  'span[class*="xterm-bg-"]',
].join(',');

// 中性色块（如 Codex 输入框）更淡；绿/红/蓝等状态色稍浓，保留 diff 与审批状态语义。
const NEUTRAL_BACKGROUND_ALPHA = 0.18;
const COLORED_BACKGROUND_ALPHA = 0.30;

function parseCssRgb(color) {
  const match = COMMA_RGB_RE.exec(color || '') || SPACE_RGB_RE.exec(color || '');
  if (!match) return null;
  const values = match.slice(1, 5).map(value => value == null ? null : Number(value));
  if (values.some(value => value != null && !Number.isFinite(value))) return null;
  return {
    r: Math.max(0, Math.min(255, values[0])),
    g: Math.max(0, Math.min(255, values[1])),
    b: Math.max(0, Math.min(255, values[2])),
    a: values[3] == null ? 1 : Math.max(0, Math.min(1, values[3])),
  };
}

export function translucentTerminalBackground(color) {
  const rgb = parseCssRgb(color);
  if (!rgb || rgb.a === 0) return '';
  const chroma = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
  const maxAlpha = chroma < 24 ? NEUTRAL_BACKGROUND_ALPHA : COLORED_BACKGROUND_ALPHA;
  const alpha = Math.min(rgb.a, maxAlpha);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function resetCell(element) {
  element.classList.remove(TRANSLUCENT_CELL_CLASS);
  element.style.removeProperty('--terminal-cell-background');
  delete element.dataset[SOURCE_DATA_KEY];
}

export function clearImageTerminalCellBackgrounds(root) {
  if (!root) return;
  root.querySelectorAll(`.${TRANSLUCENT_CELL_CLASS}`).forEach(resetCell);
}

function syncCells(container, readStyle) {
  container.querySelectorAll(CELL_BACKGROUND_SELECTOR).forEach(element => {
    let paletteClass = '';
    for (const name of element.classList) {
      if (name.startsWith('xterm-bg-')) { paletteClass = name; break; }
    }
    const inlineBackground = element.style.backgroundColor || '';
    if (!paletteClass && !inlineBackground) {
      resetCell(element);
      return;
    }

    const sourceKey = `${paletteClass}|${inlineBackground}`;
    if (element.dataset[SOURCE_DATA_KEY] === sourceKey && element.classList.contains(TRANSLUCENT_CELL_CLASS)) return;

    // 先撤掉旧覆盖，再读取 xterm 原始的 palette / true-color 背景。
    element.classList.remove(TRANSLUCENT_CELL_CLASS);
    const translucent = translucentTerminalBackground(readStyle(element).backgroundColor);
    if (!translucent) {
      resetCell(element);
      return;
    }

    element.style.setProperty('--terminal-cell-background', translucent);
    element.dataset[SOURCE_DATA_KEY] = sourceKey;
    element.classList.add(TRANSLUCENT_CELL_CLASS);
  });
}

// xterm 的真彩色背景写在 inline style，256 色背景写成 xterm-bg-N class。
// 图片主题下把二者转成带透明度的 CSS 变量；renderRange 存在时只扫描本次重绘行。
export function syncImageTerminalCellBackgrounds(
  root,
  renderRange = null,
  readStyle = element => getComputedStyle(element),
) {
  if (!root) return;
  const rows = root.querySelector('.xterm-rows');
  if (!rows) return;

  const hasRange = Number.isInteger(renderRange?.start) && Number.isInteger(renderRange?.end);
  if (!hasRange) {
    syncCells(rows, readStyle);
    return;
  }

  const start = Math.max(0, renderRange.start);
  const end = Math.min(rows.children.length - 1, renderRange.end);
  for (let row = start; row <= end; row++) syncCells(rows.children[row], readStyle);
}

// xterm 的 DOM renderer 自身在 requestAnimationFrame 中替换整行节点。如果再把
// 半透明背景同步延后一帧，ANSI 红/绿色块会先以不透明状态被绘制一次，光标闪烁等
// 高频重绘便会表现成整块持续闪动。用 microtask 合并同一轮事件，仍能避免重复扫描，
// 同时保证覆盖在浏览器本帧真正 paint 之前恢复。
export function scheduleImageTerminalCellBackgroundSync(
  state,
  renderRange,
  flush,
  enqueue = queueMicrotask,
) {
  if (!state || typeof flush !== 'function') return;
  const hasRange = Number.isInteger(renderRange?.start) && Number.isInteger(renderRange?.end);
  if (hasRange && !state.imageBgFullSync) {
    state.imageBgStart = state.imageBgStart == null
      ? renderRange.start
      : Math.min(state.imageBgStart, renderRange.start);
    state.imageBgEnd = state.imageBgEnd == null
      ? renderRange.end
      : Math.max(state.imageBgEnd, renderRange.end);
  } else if (!hasRange) {
    state.imageBgFullSync = true;
  }

  if (state.imageBgSyncPending) return;
  state.imageBgSyncPending = true;
  enqueue(() => {
    const range = state.imageBgFullSync
      ? null
      : { start: state.imageBgStart, end: state.imageBgEnd };
    state.imageBgSyncPending = false;
    state.imageBgFullSync = false;
    state.imageBgStart = null;
    state.imageBgEnd = null;
    flush(range);
  });
}
