export const NATIVE_ESC_OVERLAY_SELECTORS = [
  '.modal-mask.active',
  '#launch-menu.active',
  '#snippet-menu.active',
  '#terminal-memory-menu.active',
  '#terminal-theme-menu.active',
  '#terminal-layout-menu.active',
  '#terminal-font-menu.active',
  '#workspace-mode-menu.active',
  '.term-diy.active',
  '.group-rename-input',
];

export function isXtermHelperTextarea(element) {
  return Boolean(element?.classList?.contains('xterm-helper-textarea'));
}

export function isNativeEscOverlayOpen(root) {
  const documentRef = root && typeof root.querySelector === 'function' ? root : null;
  if (!documentRef) return false;
  return NATIVE_ESC_OVERLAY_SELECTORS.some(selector => documentRef.querySelector(selector));
}

export function shouldWriteNativeEscapeToPty({
  dockActive = false,
  sessionStatus = '',
  overlayOpen = false,
  terminalFocused = false,
} = {}) {
  return Boolean(
    dockActive
    && sessionStatus === 'running'
    && !overlayOpen
    && terminalFocused,
  );
}
