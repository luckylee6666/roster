export function isShellScriptEntry(entry) {
  return !!entry && !entry.isDir && /\.sh$/i.test(String(entry.name || ''));
}

export function shellQuotePath(path, isWindows = false) {
  const value = String(path || '');
  if (isWindows) {
    // Windows 终端固定使用 PowerShell。双引号会展开 $()、$var 和反引号，
    // 因此始终使用单引号字面量，并按 PowerShell 规则把内部单引号写成两个。
    return "'" + value.replace(/'/g, "''") + "'";
  }
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function createShellScriptCommand(path, isWindows = false) {
  return `bash -- ${shellQuotePath(path, isWindows)} `;
}

export function shouldCloseShellScriptPreview({
  sessionId,
  activeSessionId,
  previewSeqAtStart,
  currentPreviewSeq,
  previewOpen,
  hasUnsavedChanges,
} = {}) {
  return !!sessionId
    && sessionId === activeSessionId
    && previewSeqAtStart === currentPreviewSeq
    && previewOpen === true
    && hasUnsavedChanges === false;
}
