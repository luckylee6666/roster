const CODEX_OPTIONS_WITH_VALUE = new Set([
  '-a', '--ask-for-approval',
  '-c', '--config',
  '-C', '--cd',
  '-i', '--image',
  '-m', '--model',
  '-p', '--profile',
  '-s', '--sandbox',
  '--add-dir', '--disable', '--enable', '--local-provider', '--remote', '--remote-auth-token-env',
]);

function shellWords(text) {
  const words = [];
  let word = '';
  let quote = '';
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) { words.push(word); word = ''; }
    } else {
      word += character;
    }
  }
  if (escaped) word += '\\';
  if (word) words.push(word);
  return words;
}

function hasCodexResumeSubcommand(argumentsText) {
  const words = shellWords(argumentsText);
  for (let index = 0; index < words.length;) {
    const word = words[index];
    if (word === 'resume') return true;
    if (word === '--' || !word.startsWith('-')) return false;
    const option = word.split('=', 1)[0];
    index += CODEX_OPTIONS_WITH_VALUE.has(option) && !word.includes('=') ? 2 : 1;
  }
  return false;
}

export function cliToolName(command) {
  const executable = String(command || '').trim().split(/\s+/)[0] || '';
  return executable.split(/[\\/]/).pop() || '';
}

export function restoredCliCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return '';

  const tool = cliToolName(trimmed);
  if (tool === 'claude') {
    return /(^|\s)(--continue|--resume|-c)(\s|$)/.test(trimmed)
      ? trimmed
      : `${trimmed} --continue`;
  }

  if (tool === 'codex') {
    const executableEnd = trimmed.search(/\s/);
    const argumentsText = executableEnd === -1 ? '' : trimmed.slice(executableEnd).trimStart();
    if (hasCodexResumeSubcommand(argumentsText)) return trimmed;
    return executableEnd === -1
      ? `${trimmed} resume --last`
      : `${trimmed.slice(0, executableEnd)} resume --last${trimmed.slice(executableEnd)}`;
  }

  return trimmed;
}

export function sessionLayoutEntries(sessions) {
  const layout = [];
  sessions.forEach(session => {
    if (!session?.restorable) return;
    layout.push({
      cwd: session.cwd || '',
      name: session.name || '',
      autoCmd: session.tool || '',
    });
  });
  return layout;
}

export async function restoreSessionLayout(layout, createSession) {
  for (const item of layout) {
    if (!item || typeof item !== 'object') continue;
    const autoCmd = restoredCliCommand(typeof item.autoCmd === 'string' ? item.autoCmd : '');
    try {
      await createSession({ cwd: item.cwd, name: item.name, autoCmd });
    } catch (_) {
      // 单个标签失败不能阻断其余标签恢复；createSession 会在对应终端显示错误。
    }
  }
}
