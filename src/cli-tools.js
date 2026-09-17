import { cliToolName, normalizeCliToolName } from './session-restore-utils.js';

/** 新 CLI 加一条即可接入卡片按钮、启动菜单、会话条和续接门控。色标另加 `.term-tab-tool.tool-<id>`。 */
export const CLI_TOOLS = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude', keywords: Object.freeze(['anthropic']) }),
  Object.freeze({ id: 'grok', label: 'Grok', keywords: Object.freeze(['xai']) }),
  Object.freeze({ id: 'codex', label: 'Codex', keywords: Object.freeze(['openai']) }),
  Object.freeze({ id: 'opencode', label: 'OpenCode', keywords: Object.freeze(['sst']) }),
  Object.freeze({ id: 'agy', label: 'agy', keywords: Object.freeze(['antigravity']) }),
  Object.freeze({ id: 'qwen', label: 'Qwen', keywords: Object.freeze(['alibaba', 'qianwen', 'tongyi']) }),
  Object.freeze({ id: 'mimo', label: 'MiMo Code', keywords: Object.freeze(['mimocode', 'xiaomi']) }),
  // 命令名与显示名都用 `cmd`（CLI 自己的帮助写的是 `Usage: cmd <command>`）：
  // 用户明确要求菜单里跟命令行一致，别拿产品名 "Command Code" 显示回去。
  // `launchVariants`：卡片上右键这个色标可以选"用哪一档启动"。默认永远是不带
  // 任何绕过参数的裸命令；`--yolo` 是用户点名要的完全访问档，只能手动选。
  Object.freeze({
    id: 'cmd',
    label: 'cmd',
    keywords: Object.freeze(['command-code', 'commandcode', 'cmdc']),
    launchVariants: Object.freeze([
      Object.freeze({ label: '完全访问（--yolo）', args: '--yolo', danger: true }),
    ]),
  }),
]);

export const CLI_TOOL_IDS = Object.freeze(CLI_TOOLS.map(tool => tool.id));

/** 同一家的其它命令名（历史布局、用户手敲）都归到登记 id；别名表在 session-restore-utils。 */
export function isKnownCliTool(commandOrName) {
  return CLI_TOOL_IDS.includes(normalizeCliToolName(commandOrName));
}

export function normalizeInstalledCliIds(raw, allowed = CLI_TOOL_IDS) {
  const allow = new Set(Array.isArray(allowed) ? allowed : []);
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const id = normalizeCliToolName(value);
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
