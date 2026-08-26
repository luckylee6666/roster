import { CLI_TOOLS, normalizeInstalledCliIds } from './cli-tools.js';

const RUNNABLE_PROVIDER_IDS = new Set(CLI_TOOLS.map(tool => tool.id));

/**
 * 对话工作台负责把选择结果作为安全参数交给后端；并不把 CLI 原生 `/...`
 * 命令伪装成统一能力。模型可在当前八家对话入口中指定；推理强度只给已有
 * 明确后端映射的 CLI 展示。OpenCode 与 MiMo Code 使用 `--variant`，Qwen
 * 与 Gemini 没有对应的稳定推理强度参数。
 */
export const CONVERSATION_PROVIDER_CAPABILITIES = Object.freeze({
  claude: Object.freeze({ model: true, effort: true }),
  grok: Object.freeze({ model: true, effort: true }),
  codex: Object.freeze({ model: true, effort: true }),
  opencode: Object.freeze({ model: true, effort: true }),
  gemini: Object.freeze({ model: true, effort: false }),
  agy: Object.freeze({ model: true, effort: true }),
  qwen: Object.freeze({ model: true, effort: false }),
  mimo: Object.freeze({ model: true, effort: true }),
});

const PROVIDER_MARKS = Object.freeze({
  claude: 'Cl',
  grok: 'Gr',
  codex: 'Cx',
  opencode: 'OC',
  gemini: 'Ge',
  agy: 'Ag',
  qwen: 'Qw',
  mimo: 'Mi',
});

function providerRecord(tool) {
  const runnable = RUNNABLE_PROVIDER_IDS.has(tool.id);
  const capabilities = CONVERSATION_PROVIDER_CAPABILITIES[tool.id]
    || Object.freeze({ model: false, effort: false });
  return Object.freeze({
    id: tool.id,
    label: tool.label,
    mark: PROVIDER_MARKS[tool.id] || tool.label.slice(0, 2),
    runnable,
    historyOnly: !runnable,
    unavailableReason: '',
    supportsModel: capabilities.model,
    supportsEffort: capabilities.effort,
    known: true,
  });
}

/** 对话模式沿用统一 CLI 登记；是否可运行由这里显式收口。 */
export const CONVERSATION_PROVIDERS = Object.freeze(CLI_TOOLS.map(providerRecord));

const PROVIDER_BY_ID = new Map(CONVERSATION_PROVIDERS.map(provider => [provider.id, provider]));

function normalizeToolId(value) {
  return String(value || '').trim().toLowerCase();
}

function fallbackMark(label, id) {
  const source = String(label || id || '?').trim();
  return Array.from(source).slice(0, 2).join('') || '?';
}

/**
 * 返回工具的对话元数据。历史里出现未来版本的工具时仍给出可展示的安全回退，
 * 但不会把未知工具误判为可运行。
 */
export function conversationProvider(toolId, fallbackLabel = '') {
  const id = normalizeToolId(toolId);
  const known = PROVIDER_BY_ID.get(id);
  if (known) return known;
  const label = String(fallbackLabel || id || '未知 CLI').trim() || '未知 CLI';
  return Object.freeze({
    id,
    label,
    mark: fallbackMark(label, id),
    runnable: false,
    historyOnly: true,
    unavailableReason: '该 CLI 当前只能查看历史会话或作为交接来源，请在开发模式直接运行。',
    supportsModel: false,
    supportsEffort: false,
    known: false,
  });
}

/** 只返回本机已安装、且已经接入对话协议的 CLI，顺序与 CLI_TOOLS 一致。 */
export function conversationProviderOptions(installedIds) {
  const installed = new Set(normalizeInstalledCliIds(installedIds));
  return CONVERSATION_PROVIDERS
    .filter(provider => provider.runnable && installed.has(provider.id))
    .map(provider => Object.freeze({ ...provider, installed: true }));
}

/** tool 与 session id 共同组成键，避免不同 CLI 使用同一个 id 时互相覆盖。 */
export function conversationHistoryKey(tool, id) {
  return `${encodeURIComponent(normalizeToolId(tool))}:${encodeURIComponent(String(id || '').trim())}`;
}

function historyGroups(historyOrGroups) {
  if (Array.isArray(historyOrGroups)) return historyOrGroups;
  return Array.isArray(historyOrGroups?.groups) ? historyOrGroups.groups : [];
}

function historyLimit(value) {
  if (value === Infinity) return Infinity;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 12;
}

/**
 * 将 list_project_sessions 的分组结果合成对话侧栏需要的一条时间线。
 * 同一时间戳按后端原始组序和组内顺序稳定排列；历史不按安装状态过滤。
 */
export function flattenConversationHistory(historyOrGroups, { limit = 12 } = {}) {
  const rows = [];
  let sourceOrder = 0;
  for (const group of historyGroups(historyOrGroups)) {
    const groupTool = normalizeToolId(group?.tool);
    const groupLabel = String(group?.label || '').trim();
    for (const session of Array.isArray(group?.sessions) ? group.sessions : []) {
      const tool = normalizeToolId(session?.tool) || groupTool;
      const provider = conversationProvider(tool, groupLabel);
      const id = String(session?.id || '').trim();
      const stamp = Number(session?.atMs);
      rows.push({
        key: conversationHistoryKey(tool, id),
        tool,
        label: groupLabel || provider.label,
        mark: provider.mark,
        id,
        title: String(session?.title || '').trim() || '未命名会话',
        atMs: Number.isFinite(stamp) && stamp >= 0 ? stamp : 0,
        preview: String(session?.preview || ''),
        runnable: provider.runnable,
        unavailableReason: provider.unavailableReason,
        sourceOrder,
      });
      sourceOrder += 1;
    }
  }

  rows.sort((left, right) => (right.atMs - left.atMs) || (left.sourceOrder - right.sourceOrder));
  return rows.slice(0, historyLimit(limit)).map(({ sourceOrder: _sourceOrder, ...row }) => row);
}

/** 当前项目最近一条历史。没有有效会话时返回 null，由调用方决定是否空白新开。 */
export function latestConversationSession(historyOrGroups) {
  return flattenConversationHistory(historyOrGroups, { limit: 30 }).find(session => session.id) || null;
}

export const CONVERSATION_ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 4,
  maxBytes: 8 * 1024 * 1024,
  mimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
});

/** 粘贴图片的前端预检；最终校验仍由后端 prepare_attachments 负责。 */
export function inspectPastedImage(file, existingCount = 0) {
  const mime = String(file?.type || '').trim().toLowerCase();
  if (!CONVERSATION_ATTACHMENT_LIMITS.mimeTypes.includes(mime)) {
    return { ok: false, reason: '只支持 PNG、JPEG、GIF、WebP 图片' };
  }
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size <= 0 || size > CONVERSATION_ATTACHMENT_LIMITS.maxBytes) {
    return { ok: false, reason: '单张图片不能超过 8MB' };
  }
  if (existingCount >= CONVERSATION_ATTACHMENT_LIMITS.maxCount) {
    return { ok: false, reason: `一条消息最多附带 ${CONVERSATION_ATTACHMENT_LIMITS.maxCount} 张图片` };
  }
  return { ok: true, reason: '' };
}

/** 从 dataURL 取 Base64 负载；非 base64 dataURL 返回空串由后端拒绝。 */
export function dataUrlBase64(dataUrl = '') {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (comma < 0 || !text.startsWith('data:image/') || !text.slice(0, comma).includes(';base64')) {
    return '';
  }
  return text.slice(comma + 1);
}
