export const THEME_STORAGE_KEY = 'roster-theme';
export const THEME_MODES = ['system', 'light', 'dark'];

const LABELS = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export function normalizeThemeMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return THEME_MODES.includes(mode) ? mode : 'system';
}

export function nextThemeMode(value) {
  const index = THEME_MODES.indexOf(normalizeThemeMode(value));
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}

export function themeModeLabel(value) {
  return LABELS[normalizeThemeMode(value)];
}

export function readThemeMode(storage) {
  try {
    return normalizeThemeMode(storage?.getItem?.(THEME_STORAGE_KEY));
  } catch (_) {
    return 'system';
  }
}

export function writeThemeMode(storage, value) {
  const mode = normalizeThemeMode(value);
  try {
    storage?.setItem?.(THEME_STORAGE_KEY, mode);
  } catch (_) {
    // A blocked storage must not stop the theme from applying this session.
  }
  return mode;
}

/**
 * Only an explicit choice stamps the root; "system" leaves the attribute off so
 * the `prefers-color-scheme` rules stay in charge.
 */
export function applyThemeMode(root, value) {
  const mode = normalizeThemeMode(value);
  if (!root?.dataset) return mode;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  return mode;
}

export function installThemeMode({ document, storage, button }) {
  const root = document?.documentElement;
  let mode = readThemeMode(storage);
  applyThemeMode(root, mode);

  const render = () => {
    if (!button) return;
    const label = themeModeLabel(mode);
    button.dataset.themeMode = mode;
    button.title = `外观：${label}（点击切换）`;
    button.setAttribute('aria-label', `外观：${label}，点击切换`);
    const text = button.querySelector?.('.conversation-theme-label');
    if (text) text.textContent = label;
  };

  const cycle = () => {
    mode = writeThemeMode(storage, nextThemeMode(mode));
    applyThemeMode(root, mode);
    render();
  };

  button?.addEventListener?.('click', cycle);
  render();
  return { current: () => mode, cycle };
}
