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

export function textLineCount(content) {
  const text = String(content ?? '');
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      count++;
    } else if (text[i] === '\r') {
      count++;
      if (text[i + 1] === '\n') i++;
    }
  }
  return count;
}

export function createLineNumberText(lineCount) {
  const count = Math.max(1, Math.trunc(Number(lineCount)) || 1);
  const numbers = new Array(count);
  for (let i = 0; i < count; i++) numbers[i] = String(i + 1);
  return numbers.join('\n');
}
