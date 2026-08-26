const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:+/\[\]-]{0,79}$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const COMMAND_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_.\/-]{0,63}$/;

function validCommandId(value) {
  return COMMAND_PATTERN.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

function cmd(id, title, options = {}) {
  return Object.freeze({
    id,
    title,
    aliases: Object.freeze(Array.isArray(options.aliases) ? options.aliases : []),
    hint: options.hint || `/${id}`,
    takesArgs: Boolean(options.takesArgs),
    action: options.action || 'skill',
    source: options.source || 'roster',
  });
}

/** Roster 自己会处理的命令，不冒充各家 CLI 的完整斜杠表。 */
export const ROSTER_SLASH_ACTIONS = Object.freeze([
  cmd('model', '选择当前 CLI 的模型', {
    aliases: ['m'],
    hint: '/model',
    takesArgs: true,
    action: 'model',
  }),
  cmd('new', '开始新对话', { aliases: ['clear'], action: 'new-chat' }),
  cmd('help', '显示当前可用命令', { aliases: ['h', '?'], action: 'help' }),
]);

export const ROSTER_EFFORT_ACTION = cmd('effort', '选择推理强度', {
  aliases: ['e'],
  hint: '/effort',
  takesArgs: true,
  action: 'effort',
});

function namesOf(command) {
  return [command.id, ...(command.aliases || [])];
}

export function normalizeDiscoveredSlashCommand(raw) {
  const id = String(raw?.id || '').trim();
  if (!validCommandId(id)) return null;
  const title = String(raw?.title || raw?.description || id).trim().slice(0, 80) || id;
  const hint = String(raw?.hint || `/${id}`).trim().slice(0, 80) || `/${id}`;
  const aliases = (Array.isArray(raw?.aliases) ? raw.aliases : [])
    .map(value => String(value || '').trim())
    .filter(value => validCommandId(value) && value !== id);
  return Object.freeze({
    id,
    title,
    aliases: Object.freeze(aliases),
    hint,
    takesArgs: raw?.takesArgs !== false,
    action: String(raw?.action || 'skill'),
    source: String(raw?.source || 'cli').slice(0, 32),
  });
}

export function mergeConversationSlashCommands(discovered, extras = {}) {
  const local = ROSTER_SLASH_ACTIONS.filter(command => (
    extras.includeModel !== false || command.action !== 'model'
  ));
  if (extras.includeEffort) {
    local.splice(1, 0, ROSTER_EFFORT_ACTION);
  }
  const seen = new Set(local.flatMap(namesOf));
  for (const raw of Array.isArray(discovered) ? discovered : []) {
    const command = normalizeDiscoveredSlashCommand(raw);
    if (!command || seen.has(command.id)) continue;
    seen.add(command.id);
    command.aliases.forEach(alias => seen.add(alias));
    local.push(command);
  }
  return local;
}

export function completeConversationSlash(command) {
  if (!command?.id) return '';
  return command.takesArgs ? `/${command.id} ` : `/${command.id}`;
}

export function conversationSlashHelpText(commands, providerLabel = '当前 CLI') {
  const items = (Array.isArray(commands) ? commands : [])
    .filter(command => command?.id)
    .map(command => `${command.hint || `/${command.id}`} — ${command.title || command.id}`);
  const label = String(providerLabel || '').trim() || '当前 CLI';
  return items.length
    ? `${label} 当前可用命令：\n${items.join('\n')}`
    : `${label} 暂未发现可用命令`;
}

export function validateConversationModel(value) {
  const model = String(value || '').trim();
  if (!model) return { ok: false, model: '', error: '请输入模型名称' };
  if (!MODEL_PATTERN.test(model) || model.startsWith('-')) {
    return { ok: false, model: '', error: '模型名称不合法' };
  }
  return { ok: true, model, error: '' };
}

export function validateConversationEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return { ok: false, effort: '', error: '请选择推理强度' };
  if (!EFFORT_PATTERN.test(effort) || effort.startsWith('-')) {
    return { ok: false, effort: '', error: '推理强度不合法' };
  }
  return { ok: true, effort, error: '' };
}

export function filterConversationSlash(commands, query) {
  const needle = String(query || '').trim().toLowerCase();
  const source = Array.isArray(commands) ? commands : [];
  if (!needle) return source.slice();
  const prefix = [];
  const rest = [];
  for (const command of source) {
    const names = namesOf(command).map(name => name.toLowerCase());
    if (names.some(name => name.startsWith(needle))) prefix.push(command);
    else if (names.some(name => name.includes(needle))) rest.push(command);
  }
  return prefix.concat(rest);
}

export function modelPickerItems(models, query = '', currentId = '') {
  const needle = String(query || '').trim().toLowerCase();
  const current = String(currentId || '').trim();
  return (Array.isArray(models) ? models : [])
    .filter(model => {
      const id = String(model?.id || '').trim();
      if (!MODEL_PATTERN.test(id)) return false;
      if (!needle) return true;
      const label = String(model?.label || '').toLowerCase();
      return id.toLowerCase().includes(needle) || label.includes(needle);
    })
    .map(model => {
      const id = String(model.id).trim();
      const isDefault = Boolean(model.current);
      const selected = current ? id === current : isDefault;
      const extra = String(model.label || '').trim();
      let title = '';
      if (selected) title = '当前';
      else if (isDefault) title = '默认';
      else if (extra && extra !== id) title = extra;
      return Object.freeze({
        id,
        title,
        aliases: Object.freeze([]),
        hint: id,
        takesArgs: false,
        action: 'set-model-pick',
        source: 'models',
        current: selected,
      });
    });
}

export function effortPickerItems(efforts, query = '', currentId = '') {
  const needle = String(query || '').trim().toLowerCase();
  const current = String(currentId || '').trim().toLowerCase();
  return (Array.isArray(efforts) ? efforts : [])
    .filter(item => {
      const id = String(item?.id || '').trim().toLowerCase();
      if (!EFFORT_PATTERN.test(id)) return false;
      if (!needle) return true;
      const label = String(item?.label || '').toLowerCase();
      return id.includes(needle) || label.includes(needle);
    })
    .map(item => {
      const id = String(item.id).trim().toLowerCase();
      const selected = current ? id === current : Boolean(item.current);
      const extra = String(item.label || '').trim();
      return Object.freeze({
        id,
        title: selected ? '当前' : extra,
        aliases: Object.freeze([]),
        hint: id,
        takesArgs: false,
        action: 'set-effort-pick',
        source: 'efforts',
        current: selected,
      });
    });
}

export function inspectConversationSlash(value, commands, models = [], currentModel = '', efforts = [], currentEffort = '') {
  const source = String(value ?? '');
  const inactive = {
    active: false,
    query: '',
    argument: '',
    matches: [],
    exact: null,
    mode: 'commands',
  };
  if (!source || source.startsWith(' ') || source.includes('\n') || source[0] !== '/') {
    return inactive;
  }
  const body = source.slice(1);
  const space = body.search(/\s/);
  const query = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const argument = space === -1 ? '' : body.slice(space).trim();
  const matches = filterConversationSlash(commands, query);
  const exact = matches.find(command => namesOf(command).map(name => name.toLowerCase()).includes(query))
    || null;
  if (exact?.action === 'model') {
    return {
      active: true,
      query,
      argument,
      matches: modelPickerItems(models, argument, currentModel),
      exact,
      mode: 'models',
    };
  }
  if (exact?.action === 'effort') {
    return {
      active: true,
      query,
      argument,
      matches: effortPickerItems(efforts, argument, currentEffort),
      exact,
      mode: 'efforts',
    };
  }
  return { active: true, query, argument, matches, exact, mode: 'commands' };
}

export function planConversationSlash(value, commands, selectedIndex = 0, models = [], currentModel = '', efforts = [], currentEffort = '') {
  const parsed = inspectConversationSlash(value, commands, models, currentModel, efforts, currentEffort);
  if (!parsed.active) return { type: 'prompt', prompt: String(value ?? '').trim(), parsed };

  const selected = parsed.matches[Math.max(0, selectedIndex)] || parsed.exact;
  if (!selected) return { type: 'prompt', prompt: String(value ?? '').trim(), parsed };

  if (selected.action === 'help') return { type: 'help', command: selected, parsed };
  if (selected.action === 'set-model-pick') {
    const model = validateConversationModel(selected.id);
    if (!model.ok) return { type: 'error', error: model.error, command: selected, parsed };
    return { type: 'set-model', model: model.model, command: selected, parsed };
  }
  if (selected.action === 'set-effort-pick') {
    const effort = validateConversationEffort(selected.id);
    if (!effort.ok) return { type: 'error', error: effort.error, command: selected, parsed };
    return { type: 'set-effort', effort: effort.effort, command: selected, parsed };
  }
  if (selected.action === 'new-chat') {
    if (parsed.exact === selected || !parsed.query) return { type: 'new-chat', command: selected, parsed };
    return { type: 'complete', text: completeConversationSlash(selected), command: selected, parsed };
  }
  if (selected.action === 'model') {
    if (parsed.exact !== selected && parsed.query) {
      return { type: 'complete', text: completeConversationSlash(selected), command: selected, parsed };
    }
    if (!parsed.argument) {
      return { type: 'complete', text: completeConversationSlash(selected), command: selected, parsed };
    }
    const model = validateConversationModel(parsed.argument);
    if (!model.ok) return { type: 'error', error: model.error, command: selected, parsed };
    return { type: 'set-model', model: model.model, command: selected, parsed };
  }
  if (selected.action === 'effort') {
    if (parsed.exact !== selected && parsed.query) {
      return { type: 'complete', text: completeConversationSlash(selected), command: selected, parsed };
    }
    if (!parsed.argument) {
      return { type: 'complete', text: completeConversationSlash(selected), command: selected, parsed };
    }
    const effort = validateConversationEffort(parsed.argument);
    if (!effort.ok) return { type: 'error', error: effort.error, command: selected, parsed };
    return { type: 'set-effort', effort: effort.effort, command: selected, parsed };
  }
  if (parsed.exact !== selected) {
    return { type: 'complete', text: completeConversationSlash(selected), command: selected, parsed };
  }
  return { type: 'prompt', prompt: String(value ?? '').trim(), command: selected, parsed };
}
