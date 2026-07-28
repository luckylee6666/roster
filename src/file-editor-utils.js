export function editorTextFromFile(content) {
  return String(content || '').replace(/\r\n?/g, '\n');
}

export function fileTextFromEditor(content, lineEnding) {
  const normalized = editorTextFromFile(content);
  if (lineEnding === 'crlf') return normalized.replace(/\n/g, '\r\n');
  if (lineEnding === 'cr') return normalized.replace(/\n/g, '\r');
  return normalized;
}

export function editorChangedDuringSave(editorValueAtSave, currentEditorValue) {
  return currentEditorValue !== editorValueAtSave;
}
