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

export function quoteCliArg(value) {
  const text = String(value || '');
  if (!text) return '';
  if (/^[A-Za-z0-9._:/-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function resumeCliCommand(tool, sessionId) {
  const name = String(tool || '').trim();
  const id = String(sessionId || '').trim();
  if (!name || !id) return '';
  if (name === 'claude') return `claude --resume ${quoteCliArg(id)}`;
  if (name === 'grok') return `grok --resume ${quoteCliArg(id)}`;
  if (name === 'codex') return `codex resume ${quoteCliArg(id)}`;
  if (name === 'opencode') return `opencode --session ${quoteCliArg(id)}`;
  if (name === 'agy') return `agy --conversation ${quoteCliArg(id)}`;
  if (name === 'qwen') return `qwen --resume ${quoteCliArg(id)}`;
  if (name === 'mimo') return `mimo --session ${quoteCliArg(id)}`;
  return '';
}

export function launchCliCommand(tool, sessionId) {
  const name = String(tool || '').trim();
  if (!name) return '';
  return resumeCliCommand(name, sessionId) || name;
}

function takeFlagValue(args, flags) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!flags.has(flag)) continue;
    if (eq !== -1) return arg.slice(eq + 1);
    const next = args[index + 1];
    if (!next || next.startsWith('-')) return '';
    return next;
  }
  return '';
}

export function extractResumedSessionId(command) {
  const words = shellWords(command);
  if (!words.length) return '';
  const tool = cliToolName(words[0]);
  const args = words.slice(1);
  if (tool === 'claude') return takeFlagValue(args, new Set(['--resume']));
  if (tool === 'grok') return takeFlagValue(args, new Set(['--resume', '-r']));
  if (tool === 'codex') {
    const resumeAt = args.indexOf('resume');
    if (resumeAt < 0) return '';
    const next = args[resumeAt + 1] || '';
    if (!next || next.startsWith('-') || next === '--last') return '';
    return next;
  }
  if (tool === 'opencode') return takeFlagValue(args, new Set(['--session', '-s']));
  if (tool === 'agy') return takeFlagValue(args, new Set(['--conversation']));
  if (tool === 'qwen') return takeFlagValue(args, new Set(['--resume', '-r']));
  if (tool === 'mimo') return takeFlagValue(args, new Set(['--session', '-s']));
  return '';
}

export function isGenericContinueCommand(command) {
  const words = shellWords(command);
  if (!words.length) return false;
  const tool = cliToolName(words[0]);
  const args = words.slice(1);
  if (tool === 'claude' || tool === 'grok' || tool === 'opencode' || tool === 'qwen' || tool === 'mimo') {
    return args.includes('--continue') || args.includes('-c');
  }
  if (tool === 'codex') {
    const resumeAt = args.indexOf('resume');
    return resumeAt >= 0 && args[resumeAt + 1] === '--last';
  }
  return false;
}

export function sessionTitlePreview(text, limit = 36) {
  const title = String(text || '').replace(/\s+/g, ' ').trim();
  if (!title) return '未命名会话';
  const max = Number.isFinite(limit) && limit > 8 ? limit : 36;
  return title.length > max ? `${title.slice(0, max)}…` : title;
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

  if (tool === 'opencode') {
    return /(^|\s)(--continue|-c|--session|-s)(\s|$)/.test(trimmed)
      ? trimmed
      : `${trimmed} --continue`;
  }

  if (tool === 'grok') {
    return /(^|\s)(--continue|--resume|-c|-r)(\s|$)/.test(trimmed)
      ? trimmed
      : `${trimmed} --continue`;
  }

  if (tool === 'qwen') {
    return /(^|\s)(--continue|--resume|-c|-r)(\s|$)/.test(trimmed)
      ? trimmed
      : `${trimmed} --continue`;
  }

  if (tool === 'mimo') {
    const hasRestoreArgument = /(^|\s)(--continue|-c)(\s|$)/.test(trimmed)
      || /(^|\s)(--session|-s)(=|\s|$)/.test(trimmed);
    return hasRestoreArgument ? trimmed : `${trimmed} --continue`;
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
