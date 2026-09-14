import { cliToolName } from './session-restore-utils.js';

/** 新 CLI 加一条即可接入卡片按钮、启动菜单、会话条和续接门控。色标另加 `.term-tab-tool.tool-<id>`。 */
export const CLI_TOOLS = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude', keywords: Object.freeze(['anthropic']) }),
  Object.freeze({ id: 'grok', label: 'Grok', keywords: Object.freeze(['xai']) }),
  Object.freeze({ id: 'codex', label: 'Codex', keywords: Object.freeze(['openai']) }),
  Object.freeze({ id: 'opencode', label: 'OpenCode', keywords: Object.freeze(['sst']) }),
  Object.freeze({ id: 'agy', label: 'agy', keywords: Object.freeze(['antigravity']) }),
  Object.freeze({ id: 'qwen', label: 'Qwen', keywords: Object.freeze(['alibaba', 'qianwen', 'tongyi']) }),
  Object.freeze({ id: 'mimo', label: 'MiMo Code', keywords: Object.freeze(['mimocode', 'xiaomi']) }),
  // Command Code：开发模式已登记；磁盘历史（P1）与对话协议（P2）未接入前，
  // 用能力标记把它挡在对话工作台、卡片历史和交接来源之外。
  Object.freeze({
    id: 'commandcode',
    label: 'Command Code',
    keywords: Object.freeze(['command-code', 'commandcode', 'cmd', 'cmdc']),
    conversation: false,
    history: false,
  }),
]);

export const CLI_TOOL_IDS = Object.freeze(CLI_TOOLS.map(tool => tool.id));

/** 已接入结构化对话协议的 CLI（conversation 未标记即视为已接入）。 */
export const CONVERSATION_CLI_TOOL_IDS = Object.freeze(
  CLI_TOOLS.filter(tool => tool.conversation !== false).map(tool => tool.id),
);

/** 已接入磁盘历史读取的 CLI（卡片历史 / 会话条最近 / 交接来源）。 */
export const HISTORY_CLI_TOOL_IDS = Object.freeze(
  CLI_TOOLS.filter(tool => tool.history !== false).map(tool => tool.id),
);

export function isKnownCliTool(commandOrName) {
  return CLI_TOOL_IDS.includes(cliToolName(commandOrName));
}

export function normalizeInstalledCliIds(raw, allowed = CLI_TOOL_IDS) {
  const allow = new Set(Array.isArray(allowed) ? allowed : []);
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const id = cliToolName(value);
    if (!allow.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return allowed.filter(id => seen.has(id));
}

export function installedCliTools(installedIds, tools = CLI_TOOLS) {
  const allow = new Set(normalizeInstalledCliIds(installedIds));
  return (Array.isArray(tools) ? tools : []).filter(tool => allow.has(tool.id));
}

export function filterCliTools(query, tools = CLI_TOOLS) {
  const source = Array.isArray(tools) ? tools : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return source.slice();
  return source.filter(tool => {
    const id = String(tool?.id || '').toLowerCase();
    const label = String(tool?.label || '').toLowerCase();
    const keywords = (Array.isArray(tool?.keywords) ? tool.keywords : [])
      .map(value => String(value || '').toLowerCase());
    if (needle.length < 2) {
      return id.startsWith(needle) || label.startsWith(needle);
    }
    return id.includes(needle) || label.includes(needle) || keywords.some(word => word.includes(needle));
  });
}

export function orderCliTools(tools, lastUsed) {
  const source = Array.isArray(tools) ? tools.slice() : [];
  const last = cliToolName(lastUsed);
  if (!last) return source;
  const index = source.findIndex(tool => tool?.id === last);
  if (index <= 0) return source;
  const [hit] = source.splice(index, 1);
  return [hit, ...source];
}

export function visibleCliTools(query, lastUsed, tools = CLI_TOOLS) {
  return orderCliTools(filterCliTools(query, tools), lastUsed);
}

export function stepCliToolId(tools, currentId, delta) {
  const source = Array.isArray(tools) ? tools.filter(tool => tool?.id) : [];
  if (!source.length) return '';
  const current = source.findIndex(tool => tool.id === currentId);
  const from = current >= 0 ? current : (delta > 0 ? -1 : 0);
  const next = (from + delta + source.length * 8) % source.length;
  return source[next].id;
}
