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

// Must stay identical to NATIVE_PROVIDER_CONFIG in src-tauri/src/codex_chat.rs.
// Conversation-mode Codex persists this process-local alias onto the thread;
// developer-mode TUI resume has to define it or Codex refuses to load the session.
export const CODEX_NATIVE_PROVIDER_ID = 'roster_openai_native';
export const CODEX_NATIVE_PROVIDER_CONFIG = 'model_providers.roster_openai_native={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=true,stream_max_retries=1,supports_standalone_web_search=true,env_http_headers={OpenAI-Organization="OPENAI_ORGANIZATION",OpenAI-Project="OPENAI_PROJECT"}}';

export function withCodexNativeProvider(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes(CODEX_NATIVE_PROVIDER_ID)) return trimmed;
  const executableEnd = trimmed.search(/\s/);
  const executable = executableEnd === -1 ? trimmed : trimmed.slice(0, executableEnd);
  if (cliToolName(executable) !== 'codex') return trimmed;
  const rest = executableEnd === -1 ? '' : trimmed.slice(executableEnd);
  return `${executable} -c ${quoteCliArg(CODEX_NATIVE_PROVIDER_CONFIG)}${rest}`;
}

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

/** 同一家的其它命令名（旧布局、用户手敲、Windows 短名）都归到登记 id。 */
const CLI_TOOL_ALIASES = Object.freeze({ 'command-code': 'cmd', commandcode: 'cmd', cmdc: 'cmd' });

/** Windows 上 `cmd` 被系统 shell 占用，Command Code 官方短名是 `cmdc`；其余同名。 */
const WINDOWS_COMMAND_NAMES = Object.freeze({ cmd: 'cmdc' });

function hostIsWindows() {
  try {
    return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');
  } catch (_) {
    return false;
  }
}

/** 把命令/名字规范化成登记 id（先剥路径与参数，再查别名表）。 */
export function normalizeCliToolName(commandOrName) {
  const name = cliToolName(commandOrName);
  return CLI_TOOL_ALIASES[name] || name;
}

/** 终端里真正要执行的命令名：登记 id 与命令名可能不同（Windows 上的 `cmd` → `cmdc`）。 */
export function cliCommandName(tool, isWindows = hostIsWindows()) {
  const name = normalizeCliToolName(tool);
  const mapped = isWindows ? WINDOWS_COMMAND_NAMES[name] : '';
  return mapped || name;
}

/**
 * 这家的 `--continue` 覆盖不了 Roster 自己造出来的会话，恢复标签时要拿磁盘上的
 * 精确会话 ID 续：Command Code 的 `--continue` 只认交互会话，对话工作台跑出来的
 * `-p` 会话不在里面，扑空后 CLI 会直接退出（标签变成死 shell）。
 */
export function prefersExactResume(tool) {
  return normalizeCliToolName(tool) === 'cmd';
}

export function resumeCliCommand(tool, sessionId) {
  const name = normalizeCliToolName(tool);
  const id = String(sessionId || '').trim();
  // 以 - 开头的 ID 会被 CLI 当成选项解析（会话文件名可被本地伪造），拒绝续接。
  if (!name || !id || id.startsWith('-')) return '';
  const exe = cliCommandName(name);
  if (name === 'claude') return `${exe} --resume ${quoteCliArg(id)}`;
  if (name === 'grok') return `${exe} --resume ${quoteCliArg(id)}`;
  if (name === 'codex') return withCodexNativeProvider(`codex resume ${quoteCliArg(id)}`);
  if (name === 'opencode') return `${exe} --session ${quoteCliArg(id)}`;
  if (name === 'agy') return `${exe} --conversation ${quoteCliArg(id)}`;
  if (name === 'qwen') return `${exe} --resume ${quoteCliArg(id)}`;
  if (name === 'mimo') return `${exe} --session ${quoteCliArg(id)}`;
  if (name === 'cmd') return `${exe} --session ${quoteCliArg(id)}`;
  return '';
}

export function launchCliCommand(tool, sessionId) {
  const name = normalizeCliToolName(tool);
  if (!name) return '';
  return resumeCliCommand(name, sessionId) || cliCommandName(name);
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
  const tool = normalizeCliToolName(words[0]);
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
  if (tool === 'cmd') {
    return takeFlagValue(args, new Set(['--session', '--resume', '-r']));
  }
  return '';
}

export function isGenericContinueCommand(command) {
  const words = shellWords(command);
  if (!words.length) return false;
  const tool = normalizeCliToolName(words[0]);
  const args = words.slice(1);
  if (tool === 'claude' || tool === 'grok' || tool === 'opencode' || tool === 'qwen' || tool === 'mimo' || tool === 'cmd') {
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

  const tool = normalizeCliToolName(trimmed);
  if (tool === 'claude') {
    return /(^|\s)(--continue|--resume|-c)(\s|$)/.test(trimmed)
      ? trimmed
      : `${trimmed} --continue`;
  }

  if (tool === 'codex') {
    const executableEnd = trimmed.search(/\s/);
    const argumentsText = executableEnd === -1 ? '' : trimmed.slice(executableEnd).trimStart();
    if (hasCodexResumeSubcommand(argumentsText)) return withCodexNativeProvider(trimmed);
    return withCodexNativeProvider(executableEnd === -1
      ? `${trimmed} resume --last`
      : `${trimmed.slice(0, executableEnd)} resume --last${trimmed.slice(executableEnd)}`);
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

  // Command Code 不在这里补 `--continue`：它只认交互会话，对话工作台跑出来的
  // `-p` 会话不在里面，扑空就会退出、把标签留成一个死 shell。恢复路径会先查
  // 磁盘历史（`prefersExactResume`），拿精确 ID 续，实在没有才开新会话。
  if (tool === 'cmd') return trimmed;

  return trimmed;
}

export function normalizeSessionLayout(layout) {
  return (Array.isArray(layout) ? layout : []).filter(item => item && typeof item === 'object'
    && typeof item.cwd === 'string' && typeof item.name === 'string'
    && typeof item.autoCmd === 'string');
}

export function sessionLayoutEntries(sessions, pending = [], restoreOrder = pending) {
  const layout = [];
  const restored = new Map();
  sessions.forEach(session => {
    if (!session?.restorable) return;
    // Until the restore transaction acknowledges success, retain its original
    // entry exactly once, even if createSession persists during startup.
    if (pending.includes(session.restoreEntry)) return;
    const entry = {
      cwd: session.cwd || '',
      name: session.name || '',
      autoCmd: session.tool || '',
    };
    if (restoreOrder.includes(session.restoreEntry)) restored.set(session.restoreEntry, entry);
    else layout.push(entry);
  });
  return [
    ...restoreOrder.flatMap(entry => pending.includes(entry) ? [entry] : restored.has(entry) ? [restored.get(entry)] : []),
    ...layout,
  ];
}

export async function restoreSessionLayout(layout, createSession, onProgress = () => {}) {
  const result = { succeeded: 0, failed: 0, cancelled: 0 };
  for (const [index, item] of layout.entries()) {
    if (!item || typeof item !== 'object') continue;
    onProgress({ phase: 'start', item, index });
    try {
      const autoCmd = restoredCliCommand(typeof item.autoCmd === 'string' ? item.autoCmd : '');
      const outcome = await createSession({ cwd: item.cwd, name: item.name, autoCmd }, item);
      if (outcome === 'cancelled') {
        result.cancelled++;
        onProgress({ phase: 'cancelled', item, index });
        continue;
      }
      if (outcome === false) {
        throw new Error('终端未就绪');
      }
      result.succeeded++;
      onProgress({ phase: 'success', item, index });
    } catch (error) {
      result.failed++;
      onProgress({ phase: 'failure', item, index, error });
    }
  }
  return result;
}
