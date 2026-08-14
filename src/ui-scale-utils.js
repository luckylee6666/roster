export const UI_SCALE_STORAGE_KEY = 'ui-scale';

export const UI_SCALES = Object.freeze({
  STANDARD: 'standard',
  LARGE: 'large',
});

export const DEFAULT_UI_SCALE = UI_SCALES.LARGE;

const ALLOWED = new Set(Object.values(UI_SCALES));

export function normalizeUiScale(value) {
  return ALLOWED.has(value) ? value : DEFAULT_UI_SCALE;
}

export function readUiScale(storage = globalThis.localStorage) {
  try {
    return normalizeUiScale(storage?.getItem?.(UI_SCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

export function writeUiScale(value, storage = globalThis.localStorage) {
  const scale = normalizeUiScale(value);
  try {
    storage?.setItem?.(UI_SCALE_STORAGE_KEY, scale);
  } catch {
    // 隐私模式或配额满时仍应用本次选择
  }
  return scale;
}

export function applyUiScale(value, root = globalThis.document?.documentElement) {
  const scale = normalizeUiScale(value);
  if (root?.dataset) root.dataset.uiScale = scale;
  return scale;
}
