import {
  readAppShellPreference,
  selectConversationProject,
  writeAppShellPreference,
} from './app-shell-utils.js';
import {
  applyConversationChatEvent,
  conversationHasOpenSession,
  conversationRunContext,
  createConversationState,
  loadConversationTranscript,
  selectConversationProvider,
  startConversationTurn,
} from './conversation-state.js';
import { createConversationRunController } from './conversation-run-controller.js';
import { conversationUsageState, usageCommandForAgent, USAGE_AGENTS } from './usage-panel-utils.js';
import {
  conversationSlashHelpText,
  inspectConversationSlash,
  mergeConversationSlashCommands,
  planConversationSlash,
  validateConversationEffort,
  validateConversationModel,
} from './conversation-slash.js';
import {
  CONVERSATION_ATTACHMENT_LIMITS,
  conversationHistoryKey,
  conversationProvider,
  conversationProviderOptions,
  dataUrlBase64,
  flattenConversationHistory,
  inspectPastedImage,
  latestConversationSession,
} from './conversation-tools.js';

export const CONVERSATION_PROMPT_MAX_BYTES = 64 * 1024;
const STOPPING_WATCHDOG_MS = 10_000;
// Mirrors codex_chat.rs MAX_ACTIVE_RUNS: the backend refuses a fifth turn.
export const MAX_PARALLEL_CONVERSATION_RUNS = 4;

const utf8Encoder = typeof globalThis.TextEncoder === 'function'
  ? new globalThis.TextEncoder()
  : null;

export function utf8ByteLength(value) {
  const source = String(value ?? '');
  if (utf8Encoder) return utf8Encoder.encode(source).byteLength;

  let bytes = 0;
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function inspectConversationPrompt(value) {
  const prompt = String(value ?? '').trim();
  const byteLength = utf8ByteLength(prompt);
  return {
    prompt,
    byteLength,
    tooLong: byteLength > CONVERSATION_PROMPT_MAX_BYTES,
  };
}

const MANAGE_SNIPPETS_VALUE = '__manage__';
const COLLAPSE_MESSAGE_CHARS = 3000;

/** 历史里实际出现过的 CLI，按条数从多到少，用来生成筛选。 */
export function conversationHistoryTools(sessions) {
  const counts = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const tool = String(session?.tool || '').trim();
    if (!tool) continue;
    const seen = counts.get(tool) || { tool, label: session.label || tool, count: 0 };
    seen.count += 1;
    counts.set(tool, seen);
  }
  return [...counts.values()].sort((left, right) => (
    right.count - left.count || left.tool.localeCompare(right.tool)
  ));
}

/** 长回答默认收起。按字数判定，避免每帧去量高度触发重排。 */
export function shouldCollapseMessage(message) {
  return Boolean(
    message
    && message.role === 'assistant'
    && !message.pending
    && String(message.text || '').length > COLLAPSE_MESSAGE_CHARS,
  );
}

const BASE_CONVERSATION_STARTERS = [
  { label: '梳理项目现状', prompt: '帮我看看这个项目目前做到哪里了，并给出下一步建议' },
  { label: '整理下一步计划', prompt: '阅读这个项目，帮我把接下来要做的事情整理成清晰计划' },
];

/** 空状态的快捷句跟着项目现场走，别永远是同样三句。 */
export function conversationStarters(context) {
  const suggestions = [BASE_CONVERSATION_STARTERS[0]];
  if (context?.isRepo && context.dirty) {
    suggestions.push({
      label: '看看这些改动',
      prompt: '看看当前未提交的改动都改了什么，指出可能的问题和影响',
    });
  }
  if (context?.exists && !context.claudeMd) {
    suggestions.push({
      label: '写份项目说明',
      prompt: '阅读这个项目，帮我写一份给新人看的简明项目说明',
    });
  }
  if (context?.isRepo && Array.isArray(context.commits) && context.commits.length) {
    suggestions.push({
      label: '说说最近提交',
      prompt: '总结这个项目最近几次提交分别做了什么',
    });
  }
  suggestions.push(BASE_CONVERSATION_STARTERS[1]);
  return suggestions.slice(0, 3);
}

/**
 * 光标处正在写的 `@xxx`。只有紧跟空白或行首的 `@` 才算，token 里不允许空格，
 * 免得把邮箱、装饰符号和普通文本都当成引用。
 */
export function inspectConversationMention(value, caret) {
  const text = String(value ?? '');
  const position = Number.isInteger(caret)
    ? Math.max(0, Math.min(caret, text.length))
    : text.length;
  const head = text.slice(0, position);
  const at = head.lastIndexOf('@');
  const idle = { active: false, query: '', start: position, end: position };
  if (at < 0) return idle;
  const before = at === 0 ? '' : head[at - 1];
  if (before && !/\s/.test(before)) return idle;
  const query = head.slice(at + 1);
  if (/\s/.test(query) || query.length > 120) return idle;
  return { active: true, query, start: at, end: position };
}

/** 命中的是消息序号，交给渲染层去定位节点。 */
export function conversationSearchHits(messages, query) {
  const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!needle) return [];
  return (Array.isArray(messages) ? messages : []).flatMap((message, index) => (
    String(message?.text || '').toLocaleLowerCase('zh-CN').includes(needle) ? [index] : []
  ));
}

/** 把当前对话拼成一份能直接读的 Markdown，不带任何内部字段。 */
export function conversationMarkdown({ projectName = '', messages = [], now = Date.now() } = {}) {
  const head = [
    `# ${String(projectName || '对话记录').trim() || '对话记录'}`,
    '',
    `导出时间：${new Date(now).toLocaleString('zh-CN')}`,
    '',
  ];
  const body = (Array.isArray(messages) ? messages : []).flatMap(message => {
    const text = String(message?.text || '').trim();
    if (!text) return [];
    const who = message.role === 'user' ? '你' : String(message.tool || '助手');
    return [`## ${who}`, '', text, ''];
  });
  return [...head, ...body].join('\n');
}

const CHANGED_FILE_LABELS = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '??': '新文件',
  gone: '已提交或还原',
};

export function changedFileLabel(status) {
  const key = String(status || '').trim().toUpperCase();
  if (key === 'GONE') return CHANGED_FILE_LABELS.gone;
  return CHANGED_FILE_LABELS[key] || CHANGED_FILE_LABELS[key.slice(0, 1)] || '改动';
}

export function normalizeProjectChanges(context) {
  if (!context || !context.isRepo) return null;
  const files = Array.isArray(context.files) ? context.files : [];
  return {
    files: files
      .filter(file => file && typeof file.path === 'string' && file.path)
      .map(file => ({ status: String(file.status || 'M'), path: file.path })),
    more: Math.max(0, Number(context.filesMore) || 0),
  };
}

/**
 * What this turn changed on disk, not what the CLI said it did. Git's status is
 * capped at 20 entries, so a truncated snapshot can only be reported as partial.
 */
export function diffProjectChanges(before, after) {
  if (!before || !after) return { files: [], more: 0, partial: false };
  const beforeStatus = new Map(before.files.map(file => [file.path, file.status]));
  const afterPaths = new Set(after.files.map(file => file.path));
  const touched = after.files.filter(file => beforeStatus.get(file.path) !== file.status);
  const settled = before.files
    .filter(file => !afterPaths.has(file.path))
    .map(file => ({ status: 'gone', path: file.path }));
  return {
    files: [...touched, ...settled].slice(0, 20),
    more: after.more,
    partial: before.more > 0 || after.more > 0,
  };
}

const DEFERRED_CONVERSATION_EVENT_KINDS = new Set([
  'assistant_delta',
  'activity',
  'plan',
  'thread',
  'notice',
]);

// Streaming metadata can arrive in bursts. Keep terminal events immediate so
// their final state is never held behind a queued visual update.
export function conversationEventRenderMode(previousState, nextState, event) {
  if (nextState === previousState) return 'none';
  return DEFERRED_CONVERSATION_EVENT_KINDS.has(event?.kind) ? 'deferred' : 'immediate';
}

export async function confirmConversationDeletion(confirm, notify, message, unavailableMessage) {
  if (typeof confirm !== 'function') {
    notify?.(unavailableMessage, 'error');
    return false;
  }
  return Boolean(await confirm({
    title: '确认删除',
    message,
    confirmText: '删除',
    danger: true,
  }));
}

function promptTooLongMessage(byteLength) {
  return `消息过长：当前 ${byteLength.toLocaleString('zh-CN')} 字节，最多 64 KiB，请删减后再发送`;
}

function element(document, tag, className, text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function relativeTime(value, now = Date.now()) {
  const stamp = Number(value || 0);
  const diff = Math.max(0, now - stamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(stamp).toLocaleDateString('zh-CN');
}

function conversationMediaFallback(document, node, label = '媒体文件暂时无法显示') {
  const fallback = element(document, 'span', 'conversation-media-fallback', label);
  fallback.setAttribute('role', 'status');
  if (typeof node?.replaceWith === 'function') node.replaceWith(fallback);
  else node?.parentElement?.replaceChild?.(fallback, node);
}

function isLocalConversationMediaSource(source) {
  const value = String(source || '').trim();
  if (!value || value.length > 4096 || /[\0-\x1f\x7f]/.test(value)) return false;
  if (/^(?:data|blob|https?):/i.test(value)) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('file://');
}

function renderConversationAttachments(document, target, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return;
  const group = element(document, 'div', 'conversation-message-attachments');
  attachments.forEach(attachment => {
    if (attachment?.kind !== 'image' || !String(attachment.dataUrl || '').startsWith('data:image/')) {
      return;
    }
    const image = element(document, 'img', 'conversation-message-attachment');
    image.alt = String(attachment.alt || '会话图片');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.addEventListener('error', () => conversationMediaFallback(document, image, '这张历史图片无法显示'));
    image.addEventListener('click', () => openImagePreview(attachment.dataUrl));
    image.src = attachment.dataUrl;
    group.appendChild(image);
  });
  if (group.children.length) target.appendChild(group);
}

function openImagePreview(source) {
  const mask = document.getElementById('conversation-image-preview');
  const image = document.getElementById('conversation-image-preview-img');
  if (!mask || !image || !String(source || '').startsWith('data:image/')) return;
  image.src = source;
  mask.hidden = false;
  mask.focus?.();
}

function closeImagePreview() {
  const mask = document.getElementById('conversation-image-preview');
  const image = document.getElementById('conversation-image-preview-img');
  if (!mask || mask.hidden) return;
  mask.hidden = true;
  if (image) image.src = '';
}

function renderMarkdown(document, target, text, loadLocalMedia) {
  const source = String(text || '');
  if (!window.marked || !window.DOMPurify) {
    target.textContent = source;
    return;
  }
  const raw = window.marked.parse(source, { gfm: true, breaks: true });
  target.innerHTML = window.DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  target.querySelectorAll('a[href]').forEach(link => {
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('target', '_blank');
  });
  target.querySelectorAll('img[src]').forEach(image => {
    const source = image.getAttribute('src') || '';
    image.alt = image.alt || '对话媒体';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.removeAttribute('src');
    if (!isLocalConversationMediaSource(source) || typeof loadLocalMedia !== 'function') {
      conversationMediaFallback(document, image);
      return;
    }
    image.classList.add('is-loading');
    image.setAttribute('aria-busy', 'true');
    void loadLocalMedia(image, source);
  });
}

function newRunId() {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `chat-${token}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 90);
}

export const CONVERSATION_UNGROUPED_LABEL = '未分组';

export function conversationProjectGroupName(project) {
  const name = String(project?.group || '').trim();
  return name || CONVERSATION_UNGROUPED_LABEL;
}

export function conversationProjectMatchesQuery(project, query) {
  const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!needle) return true;
  const haystack = `${project?.name || ''} ${project?.localPath || ''} ${project?.group || ''}`
    .toLocaleLowerCase('zh-CN');
  return haystack.includes(needle);
}

export function shouldAutoResumeLatestConversation({
  requested = false,
  running = false,
  hasOpenSession = false,
  composerDraft = '',
  session = null,
} = {}) {
  return Boolean(
    requested
    && !running
    && !hasOpenSession
    && !String(composerDraft || '').trim()
    && typeof session?.id === 'string'
    && session.id
  );
}

export function groupConversationProjects(projects) {
  const buckets = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    const name = conversationProjectGroupName(project);
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(project);
  }
  return [...buckets.keys()]
    .sort((left, right) => {
      if (left === CONVERSATION_UNGROUPED_LABEL) return 1;
      if (right === CONVERSATION_UNGROUPED_LABEL) return -1;
      return left.localeCompare(right, 'zh-CN');
    })
    .map(name => ({ name, projects: buckets.get(name) }));
}

export function installConversationMode({
  document,
  storage,
  invoke,
  listen,
  notify,
  loadHistory,
  invalidateHistory,
  onProjectPreference,
  onOpenFolder,
  onRefreshProject,
  onManageSnippets,
  onReloadProjects,
  confirm,
}) {
  const dom = {
    projectSearch: document.getElementById('conversation-project-search'),
    projectList: document.getElementById('conversation-project-list'),
    historyList: document.getElementById('conversation-history-list'),
    historyFilter: document.getElementById('conversation-history-filter'),
    historyState: document.getElementById('conversation-history-state'),
    newChat: document.getElementById('conversation-new-chat'),
    exportChat: document.getElementById('conversation-export'),
    projectName: document.getElementById('conversation-project-name'),
    projectPath: document.getElementById('conversation-project-path'),
    assistantBadge: document.getElementById('conversation-assistant-badge'),
    assistantName: document.getElementById('conversation-assistant-name'),
    providerState: document.getElementById('conversation-provider-state'),
    status: document.getElementById('conversation-status'),
    stream: document.getElementById('conversation-messages'),
    empty: document.getElementById('conversation-empty'),
    starters: document.getElementById('conversation-starter-list'),
    scrollBottom: document.getElementById('conversation-scroll-bottom'),
    usage: document.getElementById('conversation-usage'),
    searchBar: document.getElementById('conversation-search-bar'),
    searchInput: document.getElementById('conversation-search-input'),
    searchCount: document.getElementById('conversation-search-count'),
    searchPrev: document.getElementById('conversation-search-prev'),
    searchNext: document.getElementById('conversation-search-next'),
    searchClose: document.getElementById('conversation-search-close'),
    composer: document.getElementById('conversation-composer'),
    attachments: document.getElementById('conversation-attachments'),
    attachImage: document.getElementById('conversation-attach-image'),
    composerBox: document.querySelector('.conversation-composer-box'),
    imagePreview: document.getElementById('conversation-image-preview'),
    addProject: document.getElementById('conversation-add-project'),
    createOverlay: document.getElementById('conversation-create-overlay'),
    createClose: document.getElementById('conversation-create-close'),
    createFolder: document.getElementById('conversation-create-folder'),
    createFolderPath: document.getElementById('conversation-create-folder-path'),
    createName: document.getElementById('conversation-create-name'),
    createGroup: document.getElementById('conversation-create-group'),
    createGroupList: document.getElementById('conversation-create-group-list'),
    createCancel: document.getElementById('conversation-create-cancel'),
    createSave: document.getElementById('conversation-create-save'),
    slashMenu: document.getElementById('conversation-slash-menu'),
    mentionMenu: document.getElementById('conversation-mention-menu'),
    snippetSelect: document.getElementById('conversation-snippet-select'),
    handoffNote: document.getElementById('conversation-handoff-note'),
    tuningToggle: document.getElementById('conversation-tuning-toggle'),
    tuningSummary: document.getElementById('conversation-tuning-summary'),
    tuningPanel: document.getElementById('conversation-tuning-panel'),
    handoff: document.getElementById('conversation-handoff'),
    assistantOverlay: document.getElementById('conversation-assistant-overlay'),
    assistantTitle: document.getElementById('conversation-assistant-title'),
    assistantHint: document.getElementById('conversation-assistant-hint'),
    assistantList: document.getElementById('conversation-assistant-list'),
    assistantClose: document.getElementById('conversation-assistant-close'),
    assistantCancel: document.getElementById('conversation-assistant-cancel'),
    safetyNote: document.getElementById('conversation-safety-note'),
    send: document.getElementById('conversation-send'),
    stop: document.getElementById('conversation-stop'),
    composerHint: document.getElementById('conversation-composer-hint'),
    changesSection: document.querySelector('.conversation-changes-section'),
    changesList: document.getElementById('conversation-changes-list'),
    changesCount: document.getElementById('conversation-changes-count'),
    activityList: document.getElementById('conversation-activity-list'),
    planList: document.getElementById('conversation-plan-list'),
    planSection: document.querySelector('.conversation-plan-section'),
    activitySection: document.querySelector('.conversation-activity-section'),
    projectContext: document.getElementById('conversation-project-context'),
    openFolder: document.getElementById('conversation-open-folder'),
    refreshProject: document.getElementById('conversation-refresh-project'),
  };

  const initialPreference = readAppShellPreference(storage);
  let projects = [];
  let snippets = [];
  let installedCliIds = null;
  let selectedProject = null;
  let pendingAttachments = [];
  let createFolderValue = '';
  let state = createConversationState({ providerId: initialPreference.providerId });
  let projectContext = null;
  let projectContextError = '';
  let contextLoading = false;
  let historyRevision = 0;
  let transcriptRevision = 0;
  let contextRevision = 0;
  let destroyed = false;
  let unlisten = null;
  const dragUnlisteners = [];
  let listenerReady = false;
  let listenerError = '';
  let renderTimer = null;
  let elapsedTimer = null;
  let inlineAlert = null;
  let inlineResume = null;
  let inlineRetry = null;
  let searchOpen = false;
  let searchIndex = 0;
  let mentionFiles = [];
  let mentionIndex = 0;
  let mentionRevision = 0;
  let mentionDismissed = false;
  let historyToolFilter = '';
  let sessionTitles = {};
  let renamingKey = '';
  let usageText = '';
  let usage = { text: '', level: 'ok', peak: 0, reset: '', blocked: false };
  let usageFetchedAt = 0;
  let usageRevision = 0;
  let deletingHistory = null;
  let resumeLatestOnHistory = false;
  // Each project keeps its own transcript, draft and run, so a turn started in
  // one project keeps streaming while the user reads or types in another.
  const conversationStates = new Map();
  const conversationDrafts = new Map();
  const activeRuns = new Map();
  const settledRuns = new Map();
  const stoppingWatchdogs = new Map();
  const deleteAfterRun = new Map();
  const lastRunSummary = new Map();
  const changeReports = new Map();
  const collapsedProjectGroups = new Set();
  const seenProjectGroups = new Set();
  const projectMediaCache = new Map();
  const messageNodes = new Map();
  const expandedMessages = new Set();
  const runController = createConversationRunController({ invoke });

  function cachedProjectMedia(projectId, source) {
    const key = `${projectId}\0${source}`;
    if (projectMediaCache.has(key)) return projectMediaCache.get(key);
    while (projectMediaCache.size >= 8) {
      projectMediaCache.delete(projectMediaCache.keys().next().value);
    }
    const pending = invoke('read_conversation_project_media', { projectId, source });
    projectMediaCache.set(key, pending);
    pending.catch(() => projectMediaCache.delete(key));
    return pending;
  }

  async function hydrateLocalMedia(node, source) {
    const projectId = selectedProject?.id;
    if (!projectId) {
      conversationMediaFallback(document, node);
      return;
    }
    try {
      const media = await cachedProjectMedia(projectId, source);
      if (destroyed || selectedProject?.id !== projectId || node?.isConnected === false) return;
      if (!media?.dataUrl || (media.kind !== 'image' && media.kind !== 'video')) {
        conversationMediaFallback(document, node);
        return;
      }
      if (media.kind === 'video') {
        const video = element(document, 'video', 'conversation-message-media');
        video.controls = true;
        video.preload = 'metadata';
        video.playsInline = true;
        video.setAttribute('aria-label', node.alt || '对话视频');
        video.src = media.dataUrl;
        video.addEventListener('error', () => conversationMediaFallback(document, video, '这个视频无法播放'));
        node.replaceWith(video);
        return;
      }
      node.classList.remove('is-loading');
      node.removeAttribute('aria-busy');
      node.addEventListener('error', () => conversationMediaFallback(document, node));
      node.src = media.dataUrl;
    } catch (_) {
      if (destroyed || selectedProject?.id !== projectId || node?.isConnected === false) return;
      conversationMediaFallback(document, node);
    }
  }

  const conversationRunning = value => ['starting', 'running', 'stopping'].includes(value?.status);
  const isActiveProject = projectId => Boolean(projectId) && selectedProject?.id === projectId;
  const isRunning = () => conversationRunning(state);
  const isDeletingHistory = () => Boolean(deletingHistory && isActiveProject(deletingHistory.projectId));
  const selectedProjectExists = () => Boolean(selectedProject
    && projects.some(project => project.id === selectedProject.id));
  const projectIsRunning = projectId => [...activeRuns.values()]
    .some(entry => entry.projectId === projectId);

  function stateForProject(projectId) {
    if (isActiveProject(projectId)) return state;
    return conversationStates.get(projectId) || null;
  }

  // Writing through this keeps the visible project in `state` and every other
  // project in its own slot, so background turns never touch the open view.
  function commitState(projectId, next) {
    if (isActiveProject(projectId)) {
      state = next;
      return true;
    }
    conversationStates.set(projectId, next);
    return false;
  }

  function clearStoppingWatchdog(runId) {
    if (!runId) {
      stoppingWatchdogs.forEach(timer => clearTimeout(timer));
      stoppingWatchdogs.clear();
      return;
    }
    const timer = stoppingWatchdogs.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    stoppingWatchdogs.delete(runId);
  }

  function armStoppingWatchdog(runId, projectId) {
    clearStoppingWatchdog(runId);
    stoppingWatchdogs.set(runId, setTimeout(() => {
      stoppingWatchdogs.delete(runId);
      if (destroyed) return;
      const current = stateForProject(projectId);
      if (!current || current.runId !== runId || current.status !== 'stopping') return;
      const active = commitState(projectId, {
        ...current,
        status: 'running',
        notice: '停止请求尚未确认；你可以再次停止，或继续等待结果',
      });
      if (active) renderState();
      else renderProjects();
    }, STOPPING_WATCHDOG_MS));
  }
  const installedSet = () => new Set(Array.isArray(installedCliIds) ? installedCliIds : []);
  const providerReady = providerId => {
    const provider = conversationProvider(providerId);
    return provider.runnable && installedSet().has(provider.id);
  };
  const currentProvider = () => conversationProvider(state.providerId);

  function runnableProviders() {
    return conversationProviderOptions(installedCliIds || []);
  }

  function providerForNewChat() {
    if (providerReady(state.providerId)) return state.providerId;
    return runnableProviders()[0]?.id || state.providerId || 'codex';
  }

  const MODEL_STORAGE_KEY = 'roster-conversation-models-v1';
  const EFFORT_STORAGE_KEY = 'roster-conversation-efforts-v1';
  const MODE_STORAGE_KEY = 'roster-conversation-modes-v1';
  let providerModels = {};
  let providerEfforts = {};
  let providerModes = {};
  // 模式表必须带上它属于哪个助手：换助手时异步请求还没回来，旧表绝不能
  // 被当成新助手的表渲染，更不能让用户在这个空档里选中别家的档位。
  let modeOptions = { providerId: '', entries: [] };
  let modeRevision = 0;
  let tuningOpen = false;
  let tuningSection = '';
  try {
    const storedModels = JSON.parse(storage?.getItem(MODEL_STORAGE_KEY) || 'null');
    if (storedModels?.version === 1 && storedModels.models && typeof storedModels.models === 'object') {
      providerModels = { ...storedModels.models };
    }
  } catch (_) {}
  try {
    const storedEfforts = JSON.parse(storage?.getItem(EFFORT_STORAGE_KEY) || 'null');
    if (storedEfforts?.version === 1 && storedEfforts.efforts && typeof storedEfforts.efforts === 'object') {
      providerEfforts = { ...storedEfforts.efforts };
    }
  } catch (_) {}
  try {
    const storedModes = JSON.parse(storage?.getItem(MODE_STORAGE_KEY) || 'null');
    if (storedModes?.version === 1 && storedModes.modes && typeof storedModes.modes === 'object') {
      providerModes = { ...storedModes.modes };
    }
  } catch (_) {}
  let slashIndex = 0;
  let slashQuery = '';
  let slashDismissed = false;
  let slashCommands = mergeConversationSlashCommands([]);
  let slashModels = [];
  let slashEfforts = [];
  let slashModelsLoading = false;
  let slashRevision = 0;

  async function refreshSlashCommands() {
    const revision = ++slashRevision;
    const project = selectedProject;
    const provider = currentProvider();
    if (!project || !providerReady(provider.id)) {
      slashCommands = mergeConversationSlashCommands([]);
      slashModels = [];
      slashEfforts = [];
      slashModelsLoading = false;
      renderSlashMenu();
      return;
    }
    const includeModel = provider.supportsModel;
    const includeEffort = provider.supportsEffort;
    slashModels = [];
    slashEfforts = [];
    slashModelsLoading = true;
    slashCommands = mergeConversationSlashCommands([], { includeModel, includeEffort });
    renderSlashMenu();
    try {
      const [commandsResult, modelsResult, effortsResult] = await Promise.allSettled([
        invoke('conversation_slash_list', {
          projectId: project.id,
          providerId: provider.id,
        }),
        invoke('conversation_model_list', {
          projectId: project.id,
          providerId: provider.id,
        }),
        invoke('conversation_effort_list', {
          projectId: project.id,
          providerId: provider.id,
        }),
      ]);
      if (destroyed || revision !== slashRevision || selectedProject?.id !== project.id) {
        if (revision === slashRevision) slashModelsLoading = false;
        return;
      }
      slashCommands = mergeConversationSlashCommands(
        commandsResult.status === 'fulfilled' ? commandsResult.value?.commands : [],
        { includeModel, includeEffort },
      );
      slashModels = modelsResult.status === 'fulfilled' && Array.isArray(modelsResult.value?.models)
        ? modelsResult.value.models
        : [];
      slashEfforts = effortsResult.status === 'fulfilled' && Array.isArray(effortsResult.value?.efforts)
        ? effortsResult.value.efforts
        : [];
    } catch (_) {
      if (destroyed || revision !== slashRevision) {
        if (revision === slashRevision) slashModelsLoading = false;
        return;
      }
      slashCommands = mergeConversationSlashCommands([], { includeModel, includeEffort });
      slashModels = [];
      slashEfforts = [];
    }
    slashModelsLoading = false;
    renderSlashMenu();
    renderControls();
  }

  function persistProviderModes() {
    try {
      storage?.setItem(MODE_STORAGE_KEY, JSON.stringify({ version: 1, modes: providerModes }));
    } catch (_) {}
  }

  const currentModeEntries = () => (
    modeOptions.providerId === currentProvider().id ? modeOptions.entries : []
  );

  /** 存着的档位必须是当前助手真有的，否则当作没选过。 */
  const currentMode = () => {
    const stored = String(providerModes[currentProvider().id] || '').trim();
    return currentModeEntries().some(entry => entry.id === stored) ? stored : '';
  };

  const currentModeEntry = () => {
    const entries = currentModeEntries();
    const stored = currentMode();
    return entries.find(entry => entry.id === stored) || entries[0] || null;
  };

  const currentModeWrites = () => Boolean(currentModeEntry()?.writes);

  // 模式表由后端给，界面不自己维护一份，免得和真正的白名单漂移。
  async function refreshModeOptions() {
    const provider = currentProvider().id;
    const revision = ++modeRevision;
    // 先清空并改挂到新助手名下，旧表立刻失效，不留可选的空档。
    modeOptions = { providerId: provider, entries: [] };
    renderModePicker();
    renderControls();
    try {
      const options = await invoke('conversation_mode_list', { providerId: provider });
      if (destroyed || revision !== modeRevision) return;
      modeOptions = { providerId: provider, entries: Array.isArray(options) ? options : [] };
    } catch (_) {
      if (revision !== modeRevision) return;
      modeOptions = { providerId: provider, entries: [] };
    }
    // 存着的档位这家没有（换过 CLI、升级过版本）就丢掉，别留个用不了的值。
    const stored = String(providerModes[provider] || '').trim();
    if (stored && !modeOptions.entries.some(entry => entry.id === stored)) {
      delete providerModes[provider];
      persistProviderModes();
    }
    renderModePicker();
    renderControls();
  }

  /** 模型、推理强度、模式：都是"这一轮怎么跑"的设置，收进同一个入口。 */
  function tuningSections() {
    const sections = [];
    if (slashModels.length) {
      sections.push({
        key: 'model',
        label: '模型',
        value: currentModel() || '默认',
        options: slashModels.map(item => ({ id: item.id, label: item.label || item.id })),
        current: currentModel(),
        apply: id => {
          if (id) providerModels[currentProvider().id] = id;
          else delete providerModels[currentProvider().id];
          persistProviderModels();
        },
      });
    }
    if (slashEfforts.length) {
      sections.push({
        key: 'effort',
        label: '推理强度',
        value: currentEffort() || '默认',
        options: slashEfforts.map(item => ({ id: item.id, label: item.label || item.id })),
        current: currentEffort(),
        apply: id => {
          if (id) providerEfforts[currentProvider().id] = id;
          else delete providerEfforts[currentProvider().id];
          persistProviderEfforts();
        },
      });
    }
    const modes = currentModeEntries();
    if (modes.length) {
      const active = currentModeEntry();
      sections.push({
        key: 'mode',
        label: '模式',
        value: active ? active.label.split(' · ').pop() : '默认',
        options: modes.map(entry => ({ id: entry.id, label: entry.label, hint: entry.hint })),
        current: active?.id || '',
        writes: Boolean(active?.writes),
        apply: id => {
          if (id) providerModes[currentProvider().id] = id;
          else delete providerModes[currentProvider().id];
          persistProviderModes();
        },
      });
    }
    return sections;
  }

  function closeTuning() {
    tuningOpen = false;
    tuningSection = '';
    if (dom.tuningPanel) dom.tuningPanel.hidden = true;
    dom.tuningToggle?.setAttribute?.('aria-expanded', 'false');
  }

  function renderTuning() {
    const toggle = dom.tuningToggle;
    const panel = dom.tuningPanel;
    if (!toggle || !panel) return;
    const sections = tuningSections();
    const busy = isRunning();
    toggle.disabled = !sections.length || busy || !selectedProjectExists();
    if (toggle.disabled && tuningOpen) closeTuning();
    const modeSection = sections.find(section => section.key === 'mode');
    toggle.dataset.writes = modeSection?.writes ? 'true' : 'false';
    if (dom.tuningSummary) {
      // 摘要只反映"你真正选过的值"，不跟着异步列表到没到而变形状；
      // 没选过的项不占位——一个「默认」字样什么也没告诉人。
      const parts = [currentModel(), currentEffort()].filter(Boolean);
      const activeMode = currentModeEntry();
      if (activeMode) parts.push(activeMode.label.split(' · ').pop());
      dom.tuningSummary.textContent = parts.length ? parts.join(' · ') : '默认';
    }
    toggle.title = sections.length
      ? sections.map(section => `${section.label}：${section.value}`).join('\n')
      : '这个助手没有可调的选项';
    toggle.setAttribute('aria-expanded', tuningOpen ? 'true' : 'false');
    panel.hidden = !tuningOpen;
    if (!tuningOpen) {
      panel.replaceChildren();
      return;
    }
    panel.replaceChildren();
    const section = sections.find(item => item.key === tuningSection);
    if (!section) {
      tuningSection = '';
      sections.forEach(item => {
        const row = element(document, 'button', 'conversation-tuning-row');
        row.type = 'button';
        row.dataset.section = item.key;
        row.append(
          element(document, 'span', 'conversation-tuning-row-label', item.label),
          element(document, 'span', 'conversation-tuning-row-value', item.value),
          element(document, 'span', 'conversation-tuning-row-arrow', '›'),
        );
        row.addEventListener('click', event => {
          // 这一下会把面板内容整个换掉，被点的节点随即离开 DOM；若让它继续
          // 冒泡，document 上那个"点外面收起"的判断会因为 contains 落空而误收。
          event?.stopPropagation?.();
          tuningSection = item.key;
          renderTuning();
        });
        panel.appendChild(row);
      });
      return;
    }
    const back = element(document, 'button', 'conversation-tuning-back');
    back.type = 'button';
    back.append(
      element(document, 'span', 'conversation-tuning-row-arrow', '‹'),
      element(document, 'span', '', section.label),
    );
    back.addEventListener('click', event => {
      event?.stopPropagation?.();
      tuningSection = '';
      renderTuning();
    });
    panel.appendChild(back);
    [{ id: '', label: '默认', hint: '不指定，交给这家 CLI 自己决定' }, ...section.options]
      .filter(option => option.id !== '' || section.key !== 'mode')
      .forEach(option => {
        const item = element(document, 'button', 'conversation-tuning-option');
        item.type = 'button';
        item.dataset.optionId = option.id;
        item.dataset.active = option.id === section.current ? 'true' : 'false';
        const copy = element(document, 'span', 'conversation-tuning-option-copy');
        copy.appendChild(element(document, 'strong', '', option.label));
        if (option.hint) copy.appendChild(element(document, 'small', '', option.hint));
        item.append(copy, element(document, 'span', 'conversation-tuning-check', option.id === section.current ? '✓' : ''));
        item.addEventListener('click', event => {
          event?.stopPropagation?.();
          section.apply(option.id);
          closeTuning();
          renderState();
          dom.composer?.focus();
        });
        panel.appendChild(item);
      });
  }

  function renderModePicker() {
    renderTuning();
  }

  function persistProviderModels() {
    try {
      storage?.setItem(MODEL_STORAGE_KEY, JSON.stringify({ version: 1, models: providerModels }));
    } catch (_) {}
  }

  function persistProviderEfforts() {
    try {
      storage?.setItem(EFFORT_STORAGE_KEY, JSON.stringify({ version: 1, efforts: providerEfforts }));
    } catch (_) {}
  }

  function currentModel() {
    const model = String(providerModels[currentProvider().id] || '').trim();
    return validateConversationModel(model).ok ? model : '';
  }

  function currentEffort() {
    const effort = String(providerEfforts[currentProvider().id] || '').trim();
    return validateConversationEffort(effort).ok ? effort : '';
  }

  function slashInspect(value = dom.composer?.value) {
    return inspectConversationSlash(
      value,
      slashCommands,
      slashModels,
      currentModel(),
      slashEfforts,
      currentEffort(),
    );
  }

  function slashPlan(value, index) {
    return planConversationSlash(
      value,
      slashCommands,
      index,
      slashModels,
      currentModel(),
      slashEfforts,
      currentEffort(),
    );
  }

  function applySlashPlan(plan) {
    if (plan?.type === 'new-chat') {
      if (dom.composer) dom.composer.value = '';
      newChat();
      return true;
    }
    if (plan?.type === 'help') {
      if (dom.composer) dom.composer.value = '';
      slashDismissed = true;
      state = {
        ...state,
        notice: conversationSlashHelpText(slashCommands, currentProvider().label),
        error: '',
      };
      syncComposer();
      renderState();
      dom.composer?.focus();
      return true;
    }
    if (plan?.type === 'complete') {
      if (dom.composer) {
        dom.composer.value = plan.text;
        slashDismissed = false;
        syncComposer();
        dom.composer.focus();
      }
      return true;
    }
    if (plan?.type === 'set-model') {
      providerModels[currentProvider().id] = plan.model;
      persistProviderModels();
      if (dom.composer) dom.composer.value = '';
      slashDismissed = true;
      syncComposer();
      notify?.(`已为 ${currentProvider().label} 指定模型 ${plan.model}`, 'success');
      renderHeader();
      renderControls();
      return true;
    }
    if (plan?.type === 'set-effort') {
      providerEfforts[currentProvider().id] = plan.effort;
      persistProviderEfforts();
      if (dom.composer) dom.composer.value = '';
      slashDismissed = true;
      syncComposer();
      notify?.(`已为 ${currentProvider().label} 指定推理强度 ${plan.effort}`, 'success');
      renderHeader();
      renderControls();
      return true;
    }
    if (plan?.type === 'error') {
      notify?.(plan.error, 'error');
      return true;
    }
    if (plan?.type === 'terminal-only') {
      notify?.(`${plan.command?.hint || `/${plan.command?.id}`} 需要在开发模式的终端里使用`, 'info');
      return true;
    }
    return false;
  }

  function renderSlashMenu() {
    if (!dom.slashMenu) return;
    const parsed = slashInspect();
    const slashKey = `${parsed.query}\0${parsed.mode}\0${parsed.argument}\0${slashModelsLoading}`;
    if (slashKey !== slashQuery) {
      slashQuery = slashKey;
      slashIndex = 0;
    }
    const waitingPicker = (parsed.mode === 'models' || parsed.mode === 'efforts') && !parsed.matches.length;
    const show = Boolean(
      parsed.active
      && (parsed.matches.length || waitingPicker)
      && !slashDismissed
      && !isRunning()
      && selectedProject
    );
    dom.slashMenu.hidden = !show;
    dom.slashMenu.setAttribute(
      'aria-label',
      parsed.mode === 'models' ? '选择模型' : parsed.mode === 'efforts' ? '选择推理强度' : '斜杠命令',
    );
    if (!show) {
      dom.slashMenu.replaceChildren();
      return;
    }
    dom.slashMenu.replaceChildren();
    if (waitingPicker) {
      const note = element(document, 'div', 'conversation-slash-note');
      const kind = parsed.mode === 'efforts' ? '推理强度' : '模型';
      const command = parsed.mode === 'efforts' ? '/effort' : '/model';
      note.textContent = slashModelsLoading
        ? `正在读取 ${currentProvider().label} 的${kind}…`
        : `${currentProvider().label} 没有返回${kind}列表，可继续输入 ${command} 名称`;
      dom.slashMenu.appendChild(note);
      return;
    }
    slashIndex = Math.min(Math.max(0, slashIndex), parsed.matches.length - 1);
    parsed.matches.forEach((command, index) => {
      const button = element(document, 'button', 'conversation-slash-item');
      button.type = 'button';
      button.id = `conversation-slash-${command.id}`;
      button.dataset.kind = parsed.mode;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === slashIndex ? 'true' : 'false');
      const name = parsed.mode === 'models' || parsed.mode === 'efforts' ? command.id : `/${command.id}`;
      const title = element(document, 'span', command.current ? 'is-current' : '', command.title);
      button.append(
        element(document, 'strong', '', name),
        title,
      );
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        applySlashPlan(slashPlan(dom.composer?.value, index));
      });
      dom.slashMenu.appendChild(button);
    });
    const selected = dom.slashMenu.children[slashIndex];
    selected?.scrollIntoView?.({ block: 'nearest' });
  }

  function persistSelection() {
    const current = readAppShellPreference(storage);
    writeAppShellPreference(storage, {
      ...current,
      projectId: selectedProject?.id || '',
      providerId: state.providerId,
    });
    onProjectPreference?.(selectedProject?.id || '');
  }

  function projectPathLabel(project) {
    const parts = String(project?.localPath || '').split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || project.group || '本地项目';
  }

  function renderProjectButton(project, { subtitle } = {}) {
    const button = element(document, 'button', 'conversation-project-item');
    button.type = 'button';
    button.dataset.projectId = project.id;
    button.classList.toggle('active', selectedProject?.id === project.id);
    button.setAttribute('aria-current', selectedProject?.id === project.id ? 'true' : 'false');
    const copy = element(document, 'span', 'conversation-project-copy');
    copy.append(
      element(document, 'strong', '', project.name || '未命名项目'),
      element(document, 'small', '', subtitle || projectPathLabel(project)),
    );
    button.append(copy);
    if (projectIsRunning(project.id)) {
      button.classList.add('is-running');
      const dot = element(document, 'span', 'conversation-project-run-dot');
      dot.setAttribute('title', '正在处理');
      dot.setAttribute('aria-label', '正在处理');
      button.append(dot);
    }
    button.addEventListener('click', () => selectProject(project.id));
    return button;
  }

  function renderProjects() {
    if (!dom.projectList) return;
    dom.projectList.replaceChildren();
    const query = String(dom.projectSearch?.value || '').trim();
    const visible = projects.filter(project => conversationProjectMatchesQuery(project, query));
    if (!visible.length) {
      dom.projectList.appendChild(element(document, 'p', 'conversation-list-empty', query ? '没有匹配的项目' : '还没有项目'));
      if (!query) {
        const create = element(document, 'button', 'conversation-create-project', '新建项目');
        create.type = 'button';
        create.addEventListener('click', () => openCreateProject());
        dom.projectList.appendChild(create);
      }
      return;
    }

    if (query) {
      visible.forEach(project => {
        const group = conversationProjectGroupName(project);
        const subtitle = group === CONVERSATION_UNGROUPED_LABEL ? projectPathLabel(project) : group;
        dom.projectList.appendChild(renderProjectButton(project, { subtitle }));
      });
      return;
    }

    const groups = groupConversationProjects(visible);
    // A group starts folded the first time it appears; later renders keep
    // whatever the user opened or closed in this session.
    groups.forEach(group => {
      if (seenProjectGroups.has(group.name)) return;
      seenProjectGroups.add(group.name);
      collapsedProjectGroups.add(group.name);
    });
    const onlyUngrouped = groups.length === 1 && groups[0].name === CONVERSATION_UNGROUPED_LABEL;
    if (onlyUngrouped) {
      groups[0].projects.forEach(project => {
        dom.projectList.appendChild(renderProjectButton(project));
      });
      return;
    }

    groups.forEach(group => {
      const containsSelected = group.projects.some(project => project.id === selectedProject?.id);
      const collapsed = collapsedProjectGroups.has(group.name) && !containsSelected;
      const section = element(document, 'div', 'conversation-project-group');
      section.dataset.group = group.name;
      section.classList.toggle('is-collapsed', collapsed);
      const toggle = element(document, 'button', 'conversation-project-group-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('fill', 'none');
      chevron.setAttribute('stroke', 'currentColor');
      chevron.setAttribute('stroke-width', '2');
      chevron.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 10l4 4 4-4');
      chevron.appendChild(path);
      toggle.append(
        chevron,
        element(document, 'span', 'conversation-project-group-name', group.name),
        element(document, 'span', 'conversation-project-group-count', String(group.projects.length)),
      );
      toggle.addEventListener('click', () => {
        if (collapsedProjectGroups.has(group.name)) collapsedProjectGroups.delete(group.name);
        else collapsedProjectGroups.add(group.name);
        renderProjects();
      });
      const items = element(document, 'div', 'conversation-project-group-items');
      group.projects.forEach(project => items.appendChild(renderProjectButton(project)));
      section.append(toggle, items);
      dom.projectList.appendChild(section);
    });
  }

  function renderAssistantBadge() {
    const provider = currentProvider();
    const started = conversationHasOpenSession(state);
    if (dom.assistantName) {
      dom.assistantName.textContent = installedCliIds === null && !selectedProject
        ? '选择助手'
        : provider.label;
    }
    if (!dom.assistantBadge) return;
    const options = runnableProviders();
    // 开始之后助手就定了，这时它只是个标识；没开始才让点。
    const changeable = Boolean(selectedProject) && !started && !isRunning() && options.length > 0;
    dom.assistantBadge.disabled = !changeable;
    dom.assistantBadge.dataset.locked = started ? 'true' : 'false';
    const base = started
      ? `这条对话由 ${provider.label} 负责，开始后不再更换；要换人请用「交接」`
      : changeable
        ? `当前用 ${provider.label}，点击可换一个助手`
        : provider.label;
    // 额度是这家助手的属性，挂在它身上就不会有"谁的额度"的歧义。
    dom.assistantBadge.title = usage.text
      ? `${base}\n额度：${usage.text}${usage.reset ? ` · ${usage.reset}` : ''}`
      : base;
  }

  function providerConnectionLabel() {
    const provider = currentProvider();
    if (installedCliIds === null) return '正在检查本机 CLI';
    if (!provider.runnable) return provider.unavailableReason;
    if (!providerReady(provider.id)) return `本机未安装 ${provider.label}`;
    if (state.sourceTool && state.sourceSessionId && state.sourceTool !== provider.id) {
      return `将从 ${conversationProvider(state.sourceTool).label} 交接给 ${provider.label}`;
    }
    return `${provider.label} 已连接`;
  }

  // How long this turn has been running is the only progress signal a headless
  // CLI gives us, so it ticks once a second without rebuilding the header.
  function renderRunStatus() {
    if (!dom.status) return;
    const provider = currentProvider();
    const labels = {
      idle: '等待你的消息',
      starting: `正在连接 ${provider.label}`,
      running: `${provider.label} 正在处理`,
      stopping: '正在停止',
      completed: '已完成',
      failed: '处理失败',
      cancelled: '已停止',
    };
    const running = activeRuns.get(state.runId);
    const summary = lastRunSummary.get(selectedProject?.id || '');
    const base = labels[state.status] || labels.idle;
    const suffix = running && conversationRunning(state)
      ? ` · ${elapsedLabel(running.startedAt)}`
      : summary && ['completed', 'failed', 'cancelled'].includes(state.status)
        ? ` · 用时 ${summary.elapsed}`
        : '';
    dom.status.textContent = `${base}${suffix}`;
    dom.status.dataset.status = state.status;
  }

  function syncElapsedTimer() {
    const ticking = conversationRunning(state) && activeRuns.has(state.runId);
    if (ticking && elapsedTimer === null) {
      elapsedTimer = setInterval(() => {
        if (destroyed || !conversationRunning(state) || !activeRuns.has(state.runId)) {
          syncElapsedTimer();
          return;
        }
        renderRunStatus();
      }, 1000);
    } else if (!ticking && elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function renderHeader() {
    const provider = currentProvider();
    const ready = providerReady(provider.id);
    if (dom.projectName) dom.projectName.textContent = selectedProject?.name || '选择一个项目';
    if (dom.projectPath) dom.projectPath.textContent = selectedProject?.localPath || '先在开发模式中添加项目';
    renderAssistantBadge();
    if (dom.providerState) {
      const label = providerConnectionLabel();
      dom.providerState.dataset.state = installedCliIds === null
        ? 'loading'
        : ready ? 'ready' : provider.historyOnly ? 'history' : 'missing';
      dom.providerState.title = label;
      const labelNode = dom.providerState.querySelector('.visually-hidden');
      if (labelNode) labelNode.textContent = label;
    }
    renderRunStatus();
    if (dom.safetyNote) {
      const active = currentModeEntry();
      dom.safetyNote.textContent = active
        ? `当前用 ${provider.label} 自己的「${active.label}」模式（${active.id}）：${active.hint}。模式由该 CLI 自己执行，Roster 不额外提供系统级隔离。`
        : `${provider.label} 由其自身的默认策略执行，Roster 不额外提供系统级隔离。`;
    }
  }

  // Reuse the DOM node of every message whose own content did not change.
  // Streaming only rewrites the trailing assistant message, so rebuilding the
  // whole transcript each frame re-parsed every Markdown body and recreated
  // every <img>/<video> — long sessions stuttered and local media flickered.
  function messageNodeFor(message) {
    const key = `${state.projectId || ''}\u0000${String(message.id || '')}`;
    const provider = conversationProvider(message.tool || state.providerId);
    let entry = messageNodes.get(key);
    if (!entry) {
      const row = element(document, 'article', `conversation-message is-${message.role}`);
      const body = element(document, 'div', 'conversation-message-body');
      const label = element(document, 'div', 'conversation-message-label');
      const content = element(document, 'div', 'conversation-message-content');
      const expand = element(document, 'button', 'conversation-message-expand');
      expand.type = 'button';
      expand.hidden = true;
      expand.addEventListener('click', () => {
        if (expandedMessages.has(key)) expandedMessages.delete(key);
        else expandedMessages.add(key);
        renderMessages();
      });
      body.append(label, content, expand);
      row.append(body, messageToolsNode(message, () => entry.text || ''));
      entry = {
        row,
        label,
        content,
        expand,
        labelText: '',
        tool: '',
        text: null,
        pending: null,
        streaming: null,
        attachments: null,
      };
      messageNodes.set(key, entry);
    }
    if (message.role === 'assistant' && entry.tool !== provider.id) {
      entry.tool = provider.id;
      entry.row.dataset.tool = provider.id;
    }
    const labelText = message.role === 'user' ? '你' : provider.label;
    if (entry.labelText !== labelText) {
      entry.labelText = labelText;
      entry.label.textContent = labelText;
    }
    const text = String(message.text || '');
    const attachments = message.attachments || null;
    const streaming = Boolean(message.pending);
    const thinking = streaming && !text;
    if (entry.text !== text
      || entry.pending !== thinking
      || entry.streaming !== streaming
      || entry.attachments !== attachments) {
      entry.text = text;
      entry.pending = thinking;
      entry.streaming = streaming;
      entry.attachments = attachments;
      entry.content.replaceChildren();
      if (message.role === 'assistant') {
        renderMarkdown(document, entry.content, text, hydrateLocalMedia);
        // Only a finished reply gets copy buttons; a streaming one rebuilds
        // its body on every frame.
        if (!streaming) decorateCodeBlocks(entry.content);
      } else entry.content.textContent = text;
      renderConversationAttachments(document, entry.content, attachments);
      if (thinking) {
        const dots = element(document, 'span', 'conversation-thinking');
        dots.setAttribute('aria-label', `${provider.label} 正在思考`);
        dots.append(element(document, 'i'), element(document, 'i'), element(document, 'i'));
        entry.content.appendChild(dots);
      }
    }
    const collapsible = shouldCollapseMessage(message);
    const collapsed = collapsible && !expandedMessages.has(key);
    entry.row.classList?.toggle('is-collapsed', collapsed);
    if (entry.expand) {
      entry.expand.hidden = !collapsible;
      const label = collapsed
        ? `展开全部（约 ${Math.round(text.length / 100) / 10} 千字）`
        : '收起';
      if (entry.expand.textContent !== label) entry.expand.textContent = label;
    }
    return entry.row;
  }

  async function copyConversationText(text, button) {
    const value = String(text || '');
    if (!value.trim()) return;
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
      await clipboard.writeText(value);
    } catch (_) {
      notify?.('复制失败，请手动选择这段文字', 'error');
      return;
    }
    if (!button) return;
    const original = button.textContent;
    button.textContent = '已复制';
    button.classList.add('is-done');
    setTimeout(() => {
      if (destroyed) return;
      button.textContent = original;
      button.classList.remove('is-done');
    }, 1400);
  }

  function reuseConversationText(text) {
    const value = String(text || '').trim();
    if (!dom.composer || !value) return;
    dom.composer.value = [dom.composer.value.trim(), value].filter(Boolean).join('\n\n');
    dom.composer.focus();
    syncComposer();
  }

  // The copy button lives inside <pre>, so the code text has to be read before
  // it is appended or the label ends up in the clipboard.
  function decorateCodeBlocks(container) {
    const blocks = container.querySelectorAll?.('pre') || [];
    blocks.forEach(block => {
      const code = block.textContent || '';
      if (!code.trim()) return;
      const button = element(document, 'button', 'conversation-code-copy', '复制');
      button.type = 'button';
      button.title = '复制这段代码';
      button.addEventListener('click', event => {
        event?.stopPropagation?.();
        void copyConversationText(code, button);
      });
      // The button anchors to a wrapper instead of <pre>, which scrolls
      // horizontally and would carry the button out of view with it.
      const parent = block.parentElement;
      if (!parent?.insertBefore) return;
      const wrap = element(document, 'div', 'conversation-code-block');
      parent.insertBefore(wrap, block);
      wrap.appendChild(block);
      wrap.appendChild(button);
    });
  }

  function messageToolsNode(message, readText) {
    const tools = element(document, 'div', 'conversation-message-tools');
    const copy = element(document, 'button', 'conversation-message-tool', '复制');
    copy.type = 'button';
    copy.title = '复制这条内容';
    copy.addEventListener('click', () => void copyConversationText(readText(), copy));
    tools.appendChild(copy);
    if (message.role === 'user') {
      const again = element(document, 'button', 'conversation-message-tool', '重新提问');
      again.type = 'button';
      again.title = '把这条内容放回输入框';
      again.addEventListener('click', () => reuseConversationText(readText()));
      tools.appendChild(again);
    }
    return tools;
  }

  function restoreFailedPrompt() {
    const failed = [...state.messages].reverse().find(message => message.role === 'user');
    if (!dom.composer || !failed) return;
    dom.composer.value = String(failed.text || '');
    const images = (Array.isArray(failed.attachments) ? failed.attachments : [])
      .filter(item => item?.kind === 'image' && String(item.dataUrl || '').startsWith('data:image/'))
      .slice(0, CONVERSATION_ATTACHMENT_LIMITS.maxCount)
      .map((item, index) => ({
        id: `retry-${Date.now()}-${index}`,
        mime: String(item.mime || item.mimeType || '').toLowerCase(),
        dataUrl: item.dataUrl,
      }));
    pendingAttachments = images;
    renderPendingAttachments();
    dom.composer.focus();
    syncComposer();
  }

  function inlineAlertNode() {
    const text = state.error || state.notice;
    if (!text) {
      inlineAlert = null;
      return null;
    }
    if (!inlineAlert) {
      inlineAlert = element(document, 'div', 'conversation-inline-alert');
      inlineAlert.setAttribute('role', 'status');
    }
    inlineAlert.className = `conversation-inline-alert${state.error ? ' is-error' : ''}`;
    if (inlineAlert.dataset.text !== text) {
      inlineAlert.dataset.text = text;
      inlineAlert.replaceChildren(element(document, 'span', 'conversation-inline-alert-text', text));
    }
    // 停止不会让已产出的内容作废，所以给一条明确的接着聊的路。
    const resumable = state.status === 'cancelled'
      && state.messages.some(message => message.role === 'assistant' && message.text);
    // 失败最常见的原因是没登录或参数不对，修好之后不该让人重打一遍消息。
    const retryable = state.status === 'failed'
      && state.messages.some(message => message.role === 'user' && String(message.text || '').trim());
    if (retryable) {
      if (!inlineRetry) {
        inlineRetry = element(document, 'button', 'conversation-inline-resume', '重试这条');
        inlineRetry.type = 'button';
        inlineRetry.title = '把刚才那条消息和图片放回输入框，由你确认后重发';
        inlineRetry.addEventListener('click', () => restoreFailedPrompt());
      }
      if (inlineRetry.parentElement !== inlineAlert) inlineAlert.appendChild(inlineRetry);
    } else if (inlineRetry?.parentElement === inlineAlert) {
      inlineAlert.removeChild(inlineRetry);
    }
    if (resumable) {
      if (!inlineResume) {
        inlineResume = element(document, 'button', 'conversation-inline-resume', '接着刚才继续');
        inlineResume.type = 'button';
        inlineResume.title = '把「接着刚才没说完的继续」放进输入框，由你确认后发送';
        inlineResume.addEventListener('click', () => {
          reuseConversationText('接着刚才没说完的部分继续，不用重复已经说过的内容');
        });
      }
      if (inlineResume.parentElement !== inlineAlert) inlineAlert.appendChild(inlineResume);
    } else if (inlineResume?.parentElement === inlineAlert) {
      inlineAlert.removeChild(inlineResume);
    }
    return inlineAlert;
  }

  // Moving a node out of the document pauses <video> and restarts CSS
  // animations, so only touch positions that actually differ.
  function reconcileStream(parent, nodes) {
    const existing = parent.childNodes;
    for (let index = 0; index < nodes.length; index += 1) {
      const desired = nodes[index];
      if (existing[index] === desired) continue;
      parent.insertBefore(desired, existing[index] || null);
    }
    while (existing.length > nodes.length) parent.removeChild(parent.lastChild);
  }

  function renderMessages() {
    if (!dom.stream || !dom.empty) return;
    const scrollParent = dom.stream.parentElement;
    const shouldFollow = !scrollParent
      || scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight < 120;
    const empty = state.messages.length === 0 && !state.notice && !state.error;
    dom.empty.hidden = !empty;
    // 失败的一轮会留下一个没有正文的助手气泡，只显示一个名字，属于噪音。
    const visible = state.messages.filter(message => (
      message.role !== 'assistant'
      || message.pending
      || String(message.text || '').trim()
      || message.attachments?.length
    ));
    const live = new Set();
    const nodes = visible.map(message => {
      live.add(`${state.projectId || ''}\u0000${String(message.id || '')}`);
      return messageNodeFor(message);
    });
    messageNodes.forEach((_, key) => { if (!live.has(key)) messageNodes.delete(key); });
    const alert = inlineAlertNode();
    if (alert) nodes.push(alert);
    reconcileStream(dom.stream, nodes);
    if (shouldFollow) {
      requestAnimationFrame(() => {
        if (scrollParent) scrollParent.scrollTop = scrollParent.scrollHeight;
        updateScrollAffordance();
      });
    } else {
      updateScrollAffordance();
    }
  }

  // 第一次打开时项目列表是空的，「今天想推进什么」这句话没有落点，
  // 不如直接把这三步说清楚。
  function renderEmptyState() {
    if (!dom.empty) return;
    const signature = projects.length === 0
      ? 'onboarding'
      : selectedProject ? 'ready' : 'pick';
    if (dom.empty.dataset.mode === signature) return;
    dom.empty.dataset.mode = signature;
    dom.empty.replaceChildren();
    if (signature === 'ready') {
      dom.empty.append(
        element(document, 'h2', '', '今天想推进什么？'),
        element(document, 'p', '', '用日常语言说明目标，Roster 会在当前项目里处理。'),
      );
      return;
    }
    if (signature === 'pick') {
      dom.empty.append(
        element(document, 'h2', '', '先选一个项目'),
        element(document, 'p', '', '在左边点一个项目，就能和它的最近一次对话接着聊。'),
      );
      return;
    }
    dom.empty.append(
      element(document, 'h2', '', '先添加一个项目'),
      element(document, 'p', '', 'Roster 把本机已安装的 AI 命令行工具接进对话，只在你指定的项目目录里干活。'),
    );
    const steps = element(document, 'ol', 'conversation-onboarding');
    [
      '选一个本机的项目文件夹，Roster 只在这个目录里工作。',
      '用日常语言说你想做什么，再挑一个已安装的助手。',
      '默认走这家 CLI 最保守的那一档；要让它改文件，在输入框旁把「模式」换成会写入的档。',
    ].forEach(text => steps.appendChild(element(document, 'li', '', text)));
    const create = element(document, 'button', 'conversation-create-project', '新建项目');
    create.type = 'button';
    create.addEventListener('click', () => openCreateProject());
    dom.empty.append(steps, create);
  }

  function renderStarters() {
    if (!dom.starters) return;
    const wanted = conversationStarters(projectContext);
    const signature = wanted.map(item => item.label).join('\u0000');
    if (dom.starters.dataset.signature !== signature) {
      dom.starters.dataset.signature = signature;
      dom.starters.replaceChildren();
      wanted.forEach(item => {
        const button = element(document, 'button', '', item.label);
        button.type = 'button';
        button.title = item.prompt;
        button.addEventListener('click', () => {
          if (button.disabled || !dom.composer || dom.composer.disabled || isRunning()) return;
          dom.composer.value = item.prompt;
          dom.composer.focus();
          syncComposer();
        });
        dom.starters.appendChild(button);
      });
    }
    dom.starters.hidden = state.messages.length > 0 || !selectedProject;
  }

  const mentionInspect = () => inspectConversationMention(
    dom.composer?.value,
    dom.composer?.selectionStart,
  );

  const mentionOpen = () => Boolean(
    !mentionDismissed
    && mentionFiles.length
    && mentionInspect().active
    && selectedProject,
  );

  function renderMentionMenu() {
    const menu = dom.mentionMenu;
    if (!menu) return;
    const open = mentionOpen();
    menu.hidden = !open;
    if (!open) {
      menu.replaceChildren();
      return;
    }
    mentionIndex = Math.max(0, Math.min(mentionIndex, mentionFiles.length - 1));
    menu.replaceChildren();
    mentionFiles.forEach((file, index) => {
      const item = element(document, 'button', 'conversation-slash-item');
      item.type = 'button';
      item.dataset.active = index === mentionIndex ? 'true' : 'false';
      item.append(
        element(document, 'strong', '', file.name || file.path),
        element(document, 'span', '', file.path),
      );
      item.addEventListener('mousedown', event => event.preventDefault?.());
      item.addEventListener('click', () => applyMention(index));
      menu.appendChild(item);
    });
  }

  async function refreshMentionFiles() {
    const parsed = mentionInspect();
    const project = selectedProject;
    if (!parsed.active || !project) {
      mentionFiles = [];
      renderMentionMenu();
      return;
    }
    const revision = ++mentionRevision;
    try {
      const files = await invoke('conversation_project_files', {
        projectId: project.id,
        query: parsed.query,
      });
      if (destroyed || revision !== mentionRevision || selectedProject?.id !== project.id) return;
      mentionFiles = Array.isArray(files) ? files : [];
      mentionIndex = 0;
    } catch (_) {
      if (revision !== mentionRevision) return;
      mentionFiles = [];
    }
    renderMentionMenu();
  }

  function applyMention(index) {
    const parsed = mentionInspect();
    const file = mentionFiles[index];
    if (!parsed.active || !file || !dom.composer) return;
    const text = String(dom.composer.value || '');
    const inserted = `${file.path} `;
    dom.composer.value = `${text.slice(0, parsed.start)}${inserted}${text.slice(parsed.end)}`;
    const caret = parsed.start + inserted.length;
    dom.composer.setSelectionRange?.(caret, caret);
    mentionFiles = [];
    mentionDismissed = false;
    renderMentionMenu();
    dom.composer.focus();
    syncComposer();
  }

  const USAGE_MIN_INTERVAL_MS = 3 * 60 * 1000;
  // 要在按下发送之前就知道额度，三分钟前的数据不够新，聚焦输入框时用更短的窗口。
  const USAGE_FRESH_INTERVAL_MS = 60 * 1000;

  function renderUsage() {
    if (!dom.usage) return;
    dom.usage.hidden = !usageText;
    if (!usageText) return;
    // 平时安静；接近上限才需要被看见，这时补上重置时间。
    dom.usage.dataset.level = usage.level;
    dom.usage.textContent = usage.reset && (usage.level === 'danger' || usage.blocked)
      ? `${usageText} · ${usage.reset}`
      : usageText;
  }

  // 只查当前助手自己的限流，且最快三分钟一次；查不到就安静地不显示。
  async function refreshUsage({ force = false, maxAge = USAGE_MIN_INTERVAL_MS } = {}) {
    const agent = currentProvider().id;
    if (!USAGE_AGENTS.includes(agent)) {
      usage = { text: '', level: 'ok', peak: 0, reset: '', blocked: false };
      usageText = '';
      renderUsage();
      return;
    }
    if (!force && Date.now() - usageFetchedAt < maxAge) return;
    const revision = ++usageRevision;
    usageFetchedAt = Date.now();
    try {
      const payload = await invoke(usageCommandForAgent(agent));
      if (destroyed || revision !== usageRevision) return;
      usage = conversationUsageState(agent, payload);
      usageText = usage.text ? `${currentProvider().label} · ${usage.text}` : '';
    } catch (_) {
      if (revision !== usageRevision) return;
      usage = { text: '', level: 'ok', peak: 0, reset: '', blocked: false };
      usageText = '';
    }
    renderUsage();
    // 额度还决定输入区那句提示和助手徽标的悬停说明，一并刷新。
    renderControls();
    renderAssistantBadge();
  }

  function messageRowAt(index) {
    const message = state.messages[index];
    if (!message) return null;
    return messageNodes.get(`${state.projectId || ''}\u0000${String(message.id || '')}`)?.row || null;
  }

  function clearSearchMarks() {
    messageNodes.forEach(entry => {
      entry.row.classList?.remove('is-search-hit');
      entry.row.classList?.remove('is-search-current');
    });
  }

  function renderSearch({ reveal = false } = {}) {
    if (!dom.searchBar) return;
    dom.searchBar.hidden = !searchOpen;
    clearSearchMarks();
    if (!searchOpen) {
      if (dom.searchCount) dom.searchCount.textContent = '';
      return;
    }
    const hits = conversationSearchHits(state.messages, dom.searchInput?.value);
    if (!hits.length) {
      searchIndex = 0;
      if (dom.searchCount) {
        dom.searchCount.textContent = String(dom.searchInput?.value || '').trim() ? '没有匹配' : '';
      }
      if (dom.searchPrev) dom.searchPrev.disabled = true;
      if (dom.searchNext) dom.searchNext.disabled = true;
      return;
    }
    searchIndex = ((searchIndex % hits.length) + hits.length) % hits.length;
    if (dom.searchCount) dom.searchCount.textContent = `${searchIndex + 1}/${hits.length}`;
    if (dom.searchPrev) dom.searchPrev.disabled = hits.length < 2;
    if (dom.searchNext) dom.searchNext.disabled = hits.length < 2;
    hits.forEach((messageIndex, order) => {
      const row = messageRowAt(messageIndex);
      if (!row) return;
      row.classList?.add('is-search-hit');
      if (order === searchIndex) row.classList?.add('is-search-current');
    });
    if (!reveal) return;
    messageRowAt(hits[searchIndex])?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  function stepSearch(delta) {
    const hits = conversationSearchHits(state.messages, dom.searchInput?.value);
    if (!hits.length) return;
    searchIndex += delta;
    renderSearch({ reveal: true });
  }

  function toggleSearch(open) {
    searchOpen = open;
    if (open) {
      searchIndex = 0;
      renderSearch({ reveal: false });
      dom.searchInput?.focus?.();
      dom.searchInput?.select?.();
      return;
    }
    if (dom.searchInput) dom.searchInput.value = '';
    renderSearch({ reveal: false });
    dom.composer?.focus?.();
  }

  // 滚上去看历史时，新回复会滚出视野；给一个明确的回去入口。
  function updateScrollAffordance() {
    const scroller = dom.stream?.parentElement;
    if (!dom.scrollBottom || !scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    dom.scrollBottom.hidden = !(distance > 160 && state.messages.length > 0);
  }

  function scrollToLatest() {
    const scroller = dom.stream?.parentElement;
    if (!scroller) return;
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    updateScrollAffordance();
  }

  function renderPlan() {
    if (!dom.planList) return;
    const show = state.plan.length > 0;
    if (dom.planSection) dom.planSection.hidden = !show;
    if (!show) return;
    dom.planList.replaceChildren();
    state.plan.forEach((item, index) => {
      const row = element(document, 'div', 'conversation-plan-item');
      row.dataset.status = item.status || 'pending';
      row.append(
        element(document, 'span', 'conversation-plan-index', String(index + 1)),
        element(document, 'span', 'conversation-plan-text', String(item.step || '处理任务')),
      );
      dom.planList.appendChild(row);
    });
  }

  function renderActivities() {
    if (!dom.activityList) return;
    const show = state.activities.length > 0;
    if (dom.activitySection) dom.activitySection.hidden = !show;
    if (!show) return;
    dom.activityList.replaceChildren();
    state.activities.slice(-12).reverse().forEach(item => {
      const card = element(document, 'div', 'conversation-activity-item');
      card.dataset.status = item.status || 'inProgress';
      const icon = element(
        document,
        'span',
        'conversation-activity-icon',
        item.type === 'file' ? '文' : item.type === 'search' ? '搜' : '做',
      );
      const copy = element(document, 'span', 'conversation-activity-copy');
      copy.appendChild(element(document, 'strong', '', String(item.title || '处理项目')));
      if (item.detail) copy.appendChild(element(document, 'small', '', String(item.detail)));
      if (Array.isArray(item.files)) {
        item.files.slice(0, 5).forEach(file => {
          copy.appendChild(element(document, 'small', 'conversation-activity-file', String(file.path || '')));
        });
      }
      card.append(icon, copy);
      dom.activityList.appendChild(card);
    });
  }

  function renderChangeReport() {
    if (!dom.changesList) return;
    const report = changeReports.get(selectedProject?.id || '');
    const show = Boolean(report && (report.files.length || report.partial));
    if (dom.changesSection) dom.changesSection.hidden = !show;
    if (!show) return;
    if (dom.changesCount) {
      dom.changesCount.textContent = report.partial
        ? `${report.files.length}+ 个文件`
        : `${report.files.length} 个文件`;
    }
    dom.changesList.replaceChildren();
    report.files.forEach(file => {
      const row = element(document, 'div', 'conversation-change-item');
      row.dataset.status = String(file.status || '').toLowerCase();
      row.append(
        element(document, 'span', 'conversation-change-tag', changedFileLabel(file.status)),
        element(document, 'span', 'conversation-change-path', file.path),
      );
      row.title = `${changedFileLabel(file.status)} · ${file.path}`;
      dom.changesList.appendChild(row);
    });
    if (report.partial) {
      dom.changesList.appendChild(element(
        document,
        'p',
        'conversation-rail-empty',
        '改动文件较多，这里只列出 Git 返回的前 20 个',
      ));
    }
  }

  function renderProjectContext() {
    if (!dom.projectContext) return;
    dom.projectContext.replaceChildren();
    if (!selectedProject) {
      dom.projectContext.dataset.state = 'empty';
      dom.projectContext.appendChild(element(document, 'p', 'conversation-rail-empty', '选择项目后，这里会显示分支、改动和最近提交'));
      return;
    }
    if (contextLoading) {
      dom.projectContext.dataset.state = 'loading';
      dom.projectContext.appendChild(element(document, 'p', 'conversation-rail-empty', '正在读取项目现场'));
      return;
    }
    if (projectContextError) {
      dom.projectContext.dataset.state = 'error';
      dom.projectContext.appendChild(element(document, 'p', 'conversation-rail-empty', projectContextError));
      return;
    }
    if (!projectContext?.exists) {
      dom.projectContext.dataset.state = 'error';
      dom.projectContext.appendChild(element(document, 'p', 'conversation-rail-empty', '项目目录不存在，请检查项目设置'));
      return;
    }

    dom.projectContext.dataset.state = 'ready';
    const summary = element(document, 'div', 'conversation-context-summary');
    const branch = projectContext.isRepo
      ? projectContext.branch || 'Git 仓库'
      : '普通项目文件夹';
    const changed = Number(projectContext.changed || 0);
    const untracked = Number(projectContext.untracked || 0);
    const statusText = projectContext.isRepo
      ? projectContext.dirty
        ? `${changed} 项改动 · ${untracked} 个未跟踪`
        : '工作区干净'
      : projectContext.claudeMd ? '已读取项目说明' : '未检测到 Git';
    const branchNode = element(document, 'span', 'conversation-context-branch', branch);
    const statusNode = element(document, 'span', 'conversation-context-status', statusText);
    statusNode.dataset.dirty = projectContext.dirty ? 'true' : 'false';
    summary.append(branchNode, statusNode);
    dom.projectContext.appendChild(summary);

    const list = element(document, 'div', 'conversation-context-list');
    const files = Array.isArray(projectContext.files) ? projectContext.files.slice(0, 4) : [];
    const commits = Array.isArray(projectContext.commits) ? projectContext.commits.slice(0, 2) : [];
    files.forEach(file => {
      const row = element(document, 'div', 'conversation-context-item');
      row.append(
        element(document, 'span', '', String(file.status || '改')),
        element(document, 'span', '', String(file.path || '')),
      );
      list.appendChild(row);
    });
    if (!files.length) {
      commits.forEach(commit => {
        const row = element(document, 'div', 'conversation-context-item');
        row.title = `${commit.hash || ''} ${commit.rel || ''}`.trim();
        row.append(
          element(document, 'span', '', '提'),
          element(document, 'span', '', String(commit.subject || '最近提交')),
        );
        list.appendChild(row);
      });
    }
    if (files.length || commits.length) dom.projectContext.appendChild(list);
  }

  function renderSnippets() {
    if (!dom.snippetSelect) return;
    dom.snippetSelect.replaceChildren();
    const placeholder = element(document, 'option', '', snippets.length ? '常用片段' : '暂无片段');
    placeholder.value = '';
    dom.snippetSelect.appendChild(placeholder);
    snippets.forEach(snippet => {
      const option = element(document, 'option', '', String(snippet.title || '未命名片段'));
      option.value = String(snippet.id || '');
      dom.snippetSelect.appendChild(option);
    });
    if (onManageSnippets) {
      const manage = element(document, 'option', '', '管理片段…');
      manage.value = MANAGE_SNIPPETS_VALUE;
      dom.snippetSelect.appendChild(manage);
    }
    dom.snippetSelect.value = '';
  }

  // Switching the assistant while a session is open is what actually hands the
  // conversation over, so the consequence is spelled out where it happens
  // instead of hiding behind a separate button.
  function renderHandoffNote() {
    const note = dom.handoffNote;
    if (!note) return;
    const context = conversationRunContext(state);
    const show = Boolean(context.handoffProviderId && context.handoffSessionId);
    note.hidden = !show;
    note.replaceChildren();
    if (!show) return;
    const source = conversationProvider(context.handoffProviderId);
    const target = conversationProvider(context.providerId);
    note.appendChild(element(
      document,
      'span',
      'conversation-handoff-text',
      `发送后由 ${target.label} 接手 ${source.label} 的这段对话：只带最近 24 条正文，${source.label} 的会话保持不动。`,
    ));
    const back = element(document, 'button', 'conversation-handoff-undo', `改回 ${source.label}`);
    back.type = 'button';
    back.disabled = isRunning() || !providerReady(source.id);
    back.addEventListener('click', () => selectProvider(source.id));
    note.appendChild(back);
  }

  function renderControls() {
    const provider = currentProvider();
    const unavailable = !selectedProjectExists() || !providerReady(provider.id) || !listenerReady;
    const busy = isRunning();
    const deleting = isDeletingHistory();
    const promptState = inspectConversationPrompt(dom.composer?.value);
    const hasPrompt = !!promptState.prompt;
    if (dom.send) {
      dom.send.hidden = busy;
      dom.send.disabled = unavailable || deleting || !hasPrompt || promptState.tooLong;
    }
    if (dom.stop) {
      dom.stop.hidden = !busy;
      dom.stop.disabled = false;
      dom.stop.textContent = state.status === 'starting' ? '取消连接' : '停止';
    }
    if (dom.composer) dom.composer.disabled = unavailable;
    renderTuning();
    if (dom.handoff) {
      const started = conversationHasOpenSession(state);
      dom.handoff.hidden = !started;
      dom.handoff.disabled = busy || deleting || runnableProviders().length < 2;
    }
    if (dom.snippetSelect) {
      dom.snippetSelect.disabled = busy || deleting || !selectedProject
        || (snippets.length === 0 && !onManageSnippets);
    }
    if (dom.attachImage) dom.attachImage.disabled = unavailable || busy || deleting;
    if (dom.newChat) {
      const showNewChat = Boolean(selectedProject && conversationHasOpenSession(state));
      dom.newChat.hidden = !showNewChat;
      dom.newChat.disabled = busy || !showNewChat;
    }
    if (dom.exportChat) {
      const exportable = state.messages.some(message => String(message.text || '').trim());
      dom.exportChat.hidden = !exportable;
      dom.exportChat.disabled = busy || !exportable;
    }
    renderAssistantBadge();
    if (dom.openFolder) dom.openFolder.disabled = !selectedProject;
    if (dom.refreshProject) dom.refreshProject.disabled = !selectedProject || contextLoading;
    dom.starters?.childNodes?.forEach?.(button => { button.disabled = unavailable || busy || deleting; });
    if (dom.composerHint) {
      dom.composerHint.textContent = !selectedProjectExists()
        ? '先选择一个项目'
        : usage.blocked && !busy
          // 额度打满时先说清楚，免得发出去才被 CLI 拒
          ? `${currentProvider().label} 的${usage.window || '用量'}额度已用满${usage.reset ? `，${usage.reset}` : ''}`
          : listenerError
          ? listenerError
          : installedCliIds === null
            ? '正在检查本机 CLI'
            : !provider.runnable
              ? `${provider.label} 目前只支持历史查看，请选择另一个助手接手`
              : !providerReady(provider.id)
                ? `本机未安装 ${provider.label}，请选择已安装的助手`
                : !listenerReady
                  ? '正在连接对话服务'
                  : slashInspect().active
                    && !slashDismissed
                  ? '↑↓ 选择，Tab 补全，Enter 执行'
                  : deleting
                    ? '正在删除历史对话，暂时不能发送'
                    : busy
                    ? `${provider.label} 正在处理；可继续输入，完成后再发送`
                    : promptState.tooLong
                      ? promptTooLongMessage(promptState.byteLength)
                      : 'Enter 发送，Shift + Enter 换行';
    }
  }

  function renderState() {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderHeader();
    renderMessages();
    renderPlan();
    renderActivities();
    renderProjectContext();
    renderChangeReport();
    renderEmptyState();
    renderStarters();
    renderSearch();
    renderSnippets();
    renderSlashMenu();
    renderMentionMenu();
    renderHandoffNote();
    renderUsage();
    renderModePicker();
    renderControls();
    syncElapsedTimer();
  }

  function scheduleRender() {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderState();
    }, 48);
  }

  function syncComposer() {
    if (dom.composer) {
      dom.composer.style.height = 'auto';
      dom.composer.style.height = `${Math.min(180, Math.max(52, dom.composer.scrollHeight))}px`;
    }
    renderSlashMenu();
    renderMentionMenu();
    renderControls();
  }

  function activeHistoryKey() {
    if (state.threadId && state.threadTool) {
      return conversationHistoryKey(state.threadTool, state.threadId);
    }
    if (state.sourceTool && state.sourceSessionId) {
      return conversationHistoryKey(state.sourceTool, state.sourceSessionId);
    }
    return '';
  }

  function renderHistoryFilter(sessions, onPick) {
    const bar = dom.historyFilter;
    if (!bar) return;
    const tools = conversationHistoryTools(sessions);
    // 只有一家的时候筛选没有意义，别占地方。
    const show = tools.length > 1;
    bar.hidden = !show;
    bar.replaceChildren();
    if (!show) return;
    [{ tool: '', label: '全部', count: sessions.length }, ...tools].forEach(entry => {
      const chip = element(document, 'button', 'conversation-history-chip');
      chip.type = 'button';
      chip.dataset.tool = entry.tool;
      chip.dataset.active = entry.tool === historyToolFilter ? 'true' : 'false';
      chip.append(
        element(document, 'span', '', entry.label),
        element(document, 'small', '', String(entry.count)),
      );
      chip.addEventListener('click', () => onPick(entry.tool));
      bar.appendChild(chip);
    });
  }

  function renderHistory(history, project) {
    if (!dom.historyList || !dom.historyState || selectedProject?.id !== project?.id) return;
    dom.historyList.replaceChildren();
    const all = flattenConversationHistory(history, { limit: 30 });
    if (historyToolFilter && !all.some(session => session.tool === historyToolFilter)) {
      historyToolFilter = '';
    }
    renderHistoryFilter(all, tool => {
      historyToolFilter = historyToolFilter === tool ? '' : tool;
      renderHistory(history, project);
    });
    const sessions = historyToolFilter
      ? all.filter(session => session.tool === historyToolFilter)
      : all;
    dom.historyState.textContent = all.length ? '' : '这个项目还没有历史对话';
    const activeKey = activeHistoryKey();
    sessions.forEach(session => {
      const row = element(document, 'div', 'conversation-history-row');
      row.dataset.sessionKey = session.key;
      row.classList.toggle('active', session.key === activeKey);
      const button = element(document, 'button', 'conversation-history-item');
      button.type = 'button';
      button.dataset.sessionId = session.id;
      button.dataset.tool = session.tool;
      button.classList.toggle('active', session.key === activeKey);
      const badge = element(document, 'span', 'conversation-history-tool', session.label);
      badge.dataset.tool = session.tool;
      const copy = element(document, 'span', 'conversation-history-copy');
      const alias = String(sessionTitles[session.key] || '').trim();
      copy.append(
        element(document, 'strong', '', alias || session.title),
        element(document, 'span', '', session.tool === 'agy'
          ? `${relativeTime(session.atMs)} · 仅含用户记录`
          : relativeTime(session.atMs)),
      );
      button.append(badge, copy);
      button.addEventListener('click', () => void openHistory(session));
      if (renamingKey === session.key) {
        const input = element(document, 'input', 'conversation-history-rename');
        input.type = 'text';
        input.value = alias || session.title;
        input.maxLength = 80;
        input.setAttribute('aria-label', '重命名这条会话');
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void renameHistory(session, input.value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            renamingKey = '';
            renderHistory(history, project);
          }
        });
        input.addEventListener('blur', () => {
          if (renamingKey !== session.key) return;
          renamingKey = '';
          renderHistory(history, project);
        });
        row.append(input);
        dom.historyList.appendChild(row);
        input.focus?.();
        input.select?.();
        return;
      }
      const rename = element(document, 'button', 'conversation-history-rename-action', '改名');
      rename.type = 'button';
      rename.title = alias ? `重命名（现在是「${alias}」）` : '给这条会话起个名字';
      rename.setAttribute('aria-label', `重命名 ${alias || session.title}`);
      rename.addEventListener('click', () => {
        renamingKey = session.key;
        renderHistory(history, project);
      });
      const remove = element(document, 'button', 'conversation-history-delete', '×');
      remove.type = 'button';
      remove.title = `删除 ${session.label} 历史对话`;
      remove.setAttribute('aria-label', `删除 ${session.title}`);
      remove.addEventListener('click', () => void deleteHistory(session, row));
      row.append(button, rename, remove);
      dom.historyList.appendChild(row);
    });
  }

  async function refreshHistory(historyOverride = null) {
    const revision = ++historyRevision;
    const project = selectedProject;
    if (!dom.historyList || !dom.historyState) return;
    dom.historyList.replaceChildren();
    if (!project) {
      dom.historyState.textContent = '选择项目后显示历史对话';
      return;
    }
    dom.historyState.textContent = '正在读取最近对话';
    try {
      const history = historyOverride || await loadHistory(project.localPath);
      if (destroyed || revision !== historyRevision || selectedProject?.id !== project.id) return;
      renderHistory(history, project);
      if (resumeLatestOnHistory) {
        resumeLatestOnHistory = false;
        const latest = latestConversationSession(history);
        if (shouldAutoResumeLatestConversation({
          requested: true,
          running: isRunning(),
          hasOpenSession: conversationHasOpenSession(state),
          composerDraft: dom.composer?.value,
          session: latest,
        })) {
          void openHistory(latest, { auto: true });
        }
      }
    } catch (error) {
      if (revision !== historyRevision) return;
      dom.historyState.textContent = `历史对话读取失败：${error?.message || error}`;
    }
  }

  async function openHistory(session, { auto = false } = {}) {
    if (!selectedProject || isRunning()) return;
    const revision = ++transcriptRevision;
    const project = selectedProject;
    if (dom.historyState) dom.historyState.textContent = '正在打开对话';
    try {
      const preview = await invoke('preview_conversation_transcript', {
        projectId: project.id,
        sourceTool: session.tool,
        id: session.id,
      });
      if (destroyed || revision !== transcriptRevision || selectedProject?.id !== project.id) return;
      if (isRunning()) return;
      if (auto && (conversationHasOpenSession(state) || String(dom.composer?.value || '').trim())) return;
      state = loadConversationTranscript({
        projectId: project.id,
        providerId: session.tool,
        sourceTool: session.tool,
        threadId: session.id,
        messages: preview?.messages,
      });
        persistSelection();
      if (dom.historyState) dom.historyState.textContent = preview?.truncated
        ? '这条对话非常长，已展示最近一段内容（最多 500 条）'
        : '';
      renderState();
      renderProjects();
      void refreshSlashCommands();
      await refreshHistory();
    } catch (error) {
      if (revision !== transcriptRevision) return;
      notify?.(`打开对话失败：${error?.message || error}`, 'error');
      if (dom.historyState) dom.historyState.textContent = '无法打开这条历史对话';
    }
  }

  async function renameHistory(session, title) {
    renamingKey = '';
    const next = String(title || '').trim();
    const current = String(sessionTitles[session.key] || '').trim();
    // 改回 CLI 自己的标题就是清掉别名。
    const value = next === session.title ? '' : next;
    if (value === current) {
      await refreshHistory();
      return;
    }
    try {
      sessionTitles = await invoke('set_conversation_session_title', {
        tool: session.tool,
        id: session.id,
        title: value,
      }) || {};
    } catch (error) {
      notify?.(`重命名失败：${error?.message || error}`, 'error');
    }
    await refreshHistory();
  }

  async function deleteHistory(session, row) {
    if (!selectedProject || isDeletingHistory() || row?.dataset.status === 'deleting') return;
    deletingHistory = { projectId: selectedProject.id, key: session.key };
    renderControls();
    const approved = await confirmConversationDeletion(
      confirm,
      notify,
      `确定删除这条 ${session.label} 历史对话吗？`,
      '确认功能不可用，未删除历史对话',
    );
    if (!approved || !selectedProject || row?.dataset.status === 'deleting') {
      deletingHistory = null;
      renderControls();
      return;
    }
    const project = selectedProject;
    row.dataset.status = 'deleting';
    row.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await invoke('delete_conversation_project_session', {
        projectId: project.id,
        tool: session.tool,
        id: session.id,
      });
      invalidateHistory?.(project.localPath);
      const selectedKey = activeHistoryKey();
      if (selectedKey === session.key && isRunning()) deleteAfterRun.set(project.id, session.key);
      else if (selectedKey === session.key) resetChat();
      else await refreshHistory();
      notify?.('历史对话已删除', 'success');
    } catch (error) {
      row.dataset.status = 'failed';
      row.querySelectorAll('button').forEach(button => { button.disabled = false; });
      notify?.(`删除历史对话失败：${error?.message || error}`, 'error');
    } finally {
      deletingHistory = null;
      renderControls();
    }
  }

  async function refreshProjectContext({ force = false } = {}) {
    const revision = ++contextRevision;
    const project = selectedProject;
    projectContext = null;
    projectContextError = '';
    if (!project) {
      contextLoading = false;
      renderProjectContext();
      return;
    }
    contextLoading = true;
    renderProjectContext();
    renderControls();
    try {
      const result = force && onRefreshProject
        ? await onRefreshProject({ projectId: project.id })
        : await invoke('project_context', { path: project.localPath });
      if (destroyed || revision !== contextRevision || selectedProject?.id !== project.id) return;
      projectContext = result?.context || result;
      contextLoading = false;
      renderProjectContext();
      if (result?.history) await refreshHistory(result.history);
      renderControls();
    } catch (error) {
      if (revision !== contextRevision) return;
      contextLoading = false;
      projectContextError = `读取项目现场失败：${error?.message || error}`;
      renderProjectContext();
      renderControls();
    }
  }

  function stashActiveConversation() {
    const projectId = selectedProject?.id || '';
    if (!projectId) return;
    conversationStates.set(projectId, state);
    conversationDrafts.set(projectId, {
      text: String(dom.composer?.value || ''),
      attachments: pendingAttachments,
    });
  }

  // Only a project the user has already typed in owns a draft; the others keep
  // whatever is in the composer, exactly as a single-project switch used to.
  function restoreDraft(projectId) {
    if (!conversationDrafts.has(projectId)) return;
    const draft = conversationDrafts.get(projectId) || {};
    if (dom.composer) dom.composer.value = String(draft.text || '');
    pendingAttachments = Array.isArray(draft.attachments) ? draft.attachments : [];
    renderPendingAttachments();
  }

  function activateProject(next) {
    stashActiveConversation();
    historyToolFilter = '';
    selectedProject = next;
    transcriptRevision += 1;
    contextRevision += 1;
    projectContext = null;
    projectContextError = '';
    contextLoading = false;
    const restored = next ? conversationStates.get(next.id) : null;
    state = restored || createConversationState({
      projectId: next?.id || '',
      providerId: providerForNewChat(),
    });
    if (next) conversationStates.set(next.id, state);
    restoreDraft(next?.id || '');
    resumeLatestOnHistory = Boolean(next) && !conversationHasOpenSession(state);
  }

  function selectProject(projectId) {
    const next = selectConversationProject(projects, projectId);
    if (next?.id === selectedProject?.id) {
      dom.composer?.focus();
      return true;
    }
    activateProject(next);
    persistSelection();
    renderProjects();
    renderState();
    syncComposer();
    void refreshHistory();
    void refreshProjectContext();
    void refreshSlashCommands();
    void refreshUsage();
    void refreshModeOptions();
    dom.composer?.focus();
    return true;
  }

  // 一条对话属于哪家 CLI，是它的会话 ID、沙箱绑定和历史文件共同决定的。
  // 所以助手只在对话尚未开启时可选；开启之后要换人只能走交接（另开一条）。
  function openAssistantPicker({ title, hint, exclude = '', onPick }) {
    const overlay = dom.assistantOverlay;
    if (!overlay || !dom.assistantList) return;
    const options = runnableProviders().filter(provider => provider.id !== exclude);
    if (!options.length) {
      notify?.('本机没有其他可用的助手', 'info');
      return;
    }
    if (dom.assistantTitle) dom.assistantTitle.textContent = title;
    if (dom.assistantHint) dom.assistantHint.textContent = hint;
    dom.assistantList.replaceChildren();
    options.forEach(provider => {
      const row = element(document, 'button', 'conversation-assistant-item');
      row.type = 'button';
      row.dataset.tool = provider.id;
      const badge = element(document, 'span', 'conversation-history-tool', provider.label);
      badge.dataset.tool = provider.id;
      const copy = element(document, 'span', 'conversation-assistant-copy');
      copy.append(
        element(document, 'strong', '', provider.label),
        element(document, 'small', '', [providerModels[provider.id], providerEfforts[provider.id]]
          .filter(Boolean)
          .join(' · ') || '本机已安装'),
      );
      row.append(badge, copy);
      row.addEventListener('click', () => {
        closeAssistantPicker();
        onPick(provider.id);
      });
      dom.assistantList.appendChild(row);
    });
    overlay.classList.add('active');
    dom.assistantList.querySelector?.('button')?.focus?.();
  }

  function closeAssistantPicker() {
    dom.assistantOverlay?.classList.remove('active');
  }

  function startChatWith(providerId) {
    if (!selectedProject || isRunning()) return;
    changeReports.delete(selectedProject.id);
    resumeLatestOnHistory = false;
    transcriptRevision += 1;
    state = createConversationState({
      projectId: selectedProject.id,
      providerId: providerId || providerForNewChat(),
    });
    conversationStates.set(selectedProject.id, state);
    usageText = '';
    persistSelection();
    renderState();
    void refreshHistory();
    void refreshSlashCommands();
    void refreshModeOptions();
    void refreshUsage({ force: true });
    dom.composer?.focus();
  }

  function newChat() {
    if (!selectedProject || isRunning()) return;
    openAssistantPicker({
      title: '新对话用哪个助手？',
      hint: '一条对话固定由一个助手负责；开始之后要换人得走交接，会另开一条。',
      onPick: startChatWith,
    });
    return;
  }

  /** 程序内部触发的重置：沿用当前助手，不打断用户弹窗。 */
  function resetChat() {
    if (!selectedProject || isRunning()) return;
    changeReports.delete(selectedProject.id);
    resumeLatestOnHistory = false;
    transcriptRevision += 1;
    state = createConversationState({
      projectId: selectedProject.id,
      providerId: providerForNewChat(),
    });
    conversationStates.set(selectedProject.id, state);
    persistSelection();
    renderState();
    void refreshHistory();
    dom.composer?.focus();
  }

  function selectProvider(providerId) {
    if (isRunning() || !providerReady(providerId)) return;
    usageText = '';
    const next = selectConversationProvider(state, providerId);
    if (next === state) return;
    state = next;
    persistSelection();
    renderState();
    void refreshHistory();
    void refreshSlashCommands();
    void refreshUsage({ force: true });
    void refreshModeOptions();
    dom.composer?.focus();
  }

  function renderPendingAttachments() {
    const target = dom.attachments;
    if (!target) return;
    target.replaceChildren();
    target.hidden = pendingAttachments.length === 0;
    pendingAttachments.forEach(attachment => {
      const thumb = element(document, 'div', 'conversation-attachment-thumb');
      const image = element(document, 'img');
      image.src = attachment.dataUrl;
      image.alt = '待发送图片';
      image.title = '点击放大预览';
      image.addEventListener('click', () => openImagePreview(attachment.dataUrl));
      const remove = element(document, 'button', 'conversation-attachment-remove', '×');
      remove.type = 'button';
      remove.title = '移除这张图片';
      remove.setAttribute('aria-label', '移除这张图片');
      remove.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter(item => item.id !== attachment.id);
        renderPendingAttachments();
        dom.composer?.focus();
      });
      thumb.append(image, remove);
      target.append(thumb);
    });
  }

  const IMAGE_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;

  const attachmentDropAllowed = () => Boolean(
    document.documentElement?.dataset?.appView !== 'developer'
    && selectedProject
    && !isRunning()
    && !dom.composer?.disabled,
  );

  // 拖进来和选进来的都是本机路径，读取与校验都放在后端；这里只管数量上限。
  async function addAttachmentPaths(paths) {
    const candidates = (Array.isArray(paths) ? paths : [])
      .filter(path => typeof path === 'string' && IMAGE_PATH_PATTERN.test(path.trim()))
      .slice(0, CONVERSATION_ATTACHMENT_LIMITS.maxCount);
    if (!candidates.length) {
      if (Array.isArray(paths) && paths.length) notify?.('只支持 PNG、JPEG、GIF、WebP 图片', 'error');
      return;
    }
    for (const path of candidates) {
      if (pendingAttachments.length >= CONVERSATION_ATTACHMENT_LIMITS.maxCount) {
        notify?.(`一条消息最多附带 ${CONVERSATION_ATTACHMENT_LIMITS.maxCount} 张图片`, 'error');
        break;
      }
      try {
        const media = await invoke('read_conversation_attachment_image', { path });
        if (destroyed) return;
        const dataUrl = String(media?.dataUrl || '');
        if (!dataUrl.startsWith('data:image/')) continue;
        pendingAttachments = [...pendingAttachments, {
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          mime: String(media.mimeType || '').trim().toLowerCase(),
          dataUrl,
        }];
        renderPendingAttachments();
      } catch (error) {
        notify?.(`添加图片失败：${error?.message || error}`, 'error');
      }
    }
    renderControls();
  }

  function addPastedImages(files) {
    const accepted = [];
    for (const file of files) {
      const checked = inspectPastedImage(file, pendingAttachments.length + accepted.length);
      if (!checked.ok) {
        notify?.(checked.reason, 'error');
        continue;
      }
      accepted.push(file);
    }
    accepted.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl.startsWith('data:image/')) return;
        pendingAttachments = [...pendingAttachments, {
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          mime: String(file.type || '').trim().toLowerCase(),
          dataUrl,
        }];
        renderPendingAttachments();
      };
      reader.readAsDataURL(file);
    });
  }

  function openCreateProject() {
    if (!dom.createOverlay) return;
    createFolderValue = '';
    if (dom.createFolderPath) dom.createFolderPath.textContent = '未选择';
    if (dom.createName) dom.createName.value = '';
    if (dom.createGroup) dom.createGroup.value = '';
    if (dom.createGroupList) {
      dom.createGroupList.replaceChildren();
      const names = Array.from(new Set(
        projects.map(project => String(project.group || '').trim()).filter(Boolean),
      )).sort((left, right) => left.localeCompare(right, 'zh-CN'));
      names.forEach(name => {
        const option = element(document, 'option');
        option.value = name;
        dom.createGroupList.appendChild(option);
      });
    }
    dom.createOverlay.classList.add('active');
    dom.createFolder?.focus();
  }

  function closeCreateProject() {
    dom.createOverlay?.classList.remove('active');
  }

  async function chooseCreateFolder() {
    try {
      const folder = String(await invoke('open_folder_dialog') || '').trim();
      if (!folder) return;
      createFolderValue = folder;
      if (dom.createFolderPath) dom.createFolderPath.textContent = folder;
      if (dom.createName && !dom.createName.value.trim()) {
        const parts = folder.split(/[\\/]/).filter(Boolean);
        dom.createName.value = parts[parts.length - 1] || '';
      }
    } catch (error) {
      notify?.(`选择文件夹失败：${error?.message || error}`, 'error');
    }
  }

  async function saveCreatedProject() {
    if (!createFolderValue) {
      notify?.('请先选择项目文件夹', 'error');
      return;
    }
    if (dom.createSave) dom.createSave.disabled = true;
    try {
      const parts = createFolderValue.split(/[\\/]/).filter(Boolean);
      const created = await invoke('add_project', {
        name: (dom.createName?.value || '').trim() || parts[parts.length - 1] || '本地项目',
        localPath: createFolderValue,
        remoteUrl: '',
        description: '',
        machine: 'local',
        serverId: '',
        group: (dom.createGroup?.value || '').trim(),
      });
      closeCreateProject();
      notify?.('项目已添加', 'success');
      await onReloadProjects?.();
      if (created?.id) selectProject(created.id);
      dom.composer?.focus();
    } catch (error) {
      notify?.(`添加项目失败：${error?.message || error}`, 'error');
    } finally {
      if (dom.createSave) dom.createSave.disabled = false;
    }
  }

  async function send() {
    const project = selectedProject;
    const provider = currentProvider();
    const planned = slashPlan(dom.composer?.value, slashIndex);
    if (planned.type !== 'prompt') {
      applySlashPlan(planned);
      return;
    }
    const promptState = inspectConversationPrompt(planned.prompt);
    const prompt = promptState.prompt
      || (pendingAttachments.length ? '请查看我粘贴的图片，结合图片回答。' : '');
    if (!project || !selectedProjectExists() || !prompt || isRunning() || isDeletingHistory() || !providerReady(provider.id) || !listenerReady) return;
    if (promptState.tooLong) {
      syncComposer();
      dom.composer?.focus();
      notify?.(promptTooLongMessage(promptState.byteLength), 'error');
      return;
    }
    if (activeRuns.size >= MAX_PARALLEL_CONVERSATION_RUNS) {
      notify?.(`最多同时处理 ${MAX_PARALLEL_CONVERSATION_RUNS} 个项目，请先等其中一个完成`, 'info');
      return;
    }
    resumeLatestOnHistory = false;
    transcriptRevision += 1;
    const runId = newRunId();
    const runContext = conversationRunContext(state);
    const allowWrite = currentModeWrites();
    const runEntry = { runId, projectId: project.id, project: { ...project }, startedAt: Date.now() };
    if (allowWrite) {
      // 本轮到底改了什么以磁盘为准，所以先拍一张 Git 现状作基线。
      runEntry.baseline = invoke('project_context', { path: project.localPath })
        .then(result => normalizeProjectChanges(result?.context || result))
        .catch(() => null);
      changeReports.delete(project.id);
    }
    activeRuns.set(runId, runEntry);
    const sentAttachments = pendingAttachments;
    state = startConversationTurn(state, {
      runId,
      projectId: project.id,
      providerId: runContext.providerId,
      prompt,
      attachments: sentAttachments.map(item => ({ kind: 'image', id: item.id, mime: item.mime, dataUrl: item.dataUrl })),
    });
    dom.composer.value = '';
    pendingAttachments = [];
    renderPendingAttachments();
    syncComposer();
    renderState();
    try {
      await runController.start({
        projectId: project.id,
        providerId: runContext.providerId,
        runId,
        threadId: runContext.threadId,
        prompt,
        mode: currentMode(),
        handoffProviderId: runContext.handoffProviderId,
        handoffSessionId: runContext.handoffSessionId,
        model: currentModel(),
        effort: currentEffort(),
        attachments: sentAttachments.map(item => ({
          id: item.id,
          mime: item.mime,
          dataBase64: dataUrlBase64(item.dataUrl),
        })),
      });
      if (state.runId === runId && state.status === 'starting') {
        state = { ...state, status: 'running' };
        renderState();
      }
    } catch (error) {
      state = applyConversationChatEvent(state, {
        runId,
        providerId: runContext.providerId,
        kind: 'error',
        data: { message: error?.message || String(error) },
      });
      activeRuns.delete(runId);
      runController.clear(runId);
        renderState();
      renderProjects();
    }
  }

  async function cancelAcceptedRun(runId, projectId) {
    try {
      await runController.cancel(runId);
    } catch (error) {
      const current = stateForProject(projectId);
      if (!current || current.runId !== runId || !conversationRunning(current)) return;
      clearStoppingWatchdog(runId);
      const active = commitState(projectId, {
        ...current,
        status: 'running',
        notice: `停止请求失败：${error?.message || error}。仍在处理中，可重试。`,
      });
      if (active) renderState();
      else renderProjects();
    }
  }

  async function stop() {
    if (!state.runId || !['starting', 'running'].includes(state.status)) return;
    const runId = state.runId;
    const projectId = state.projectId || selectedProject?.id || '';
    const awaitingStart = state.status === 'starting';
    state = { ...state, status: 'stopping' };
    armStoppingWatchdog(runId, projectId);
    renderState();
    if (awaitingStart) await runController.cancel(runId, { backendReady: false });
    else await cancelAcceptedRun(runId, projectId);
  }

  function elapsedLabel(startedAt) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(startedAt || 0)) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  }

  const windowFocused = () => {
    if (document?.hidden) return false;
    return typeof document?.hasFocus === 'function' ? document.hasFocus() : true;
  };

  // The transcript update is only a reply the user can see while the
  // conversation workspace itself is on screen.
  const conversationVisible = () => {
    const view = document?.documentElement?.dataset?.appView;
    return view === undefined || view === 'conversation';
  };

  // A turn can finish while the user reads another project or another app, so
  // the result has to reach them without stealing the view they are using.
  function announceFinishedRun(entry, finalState) {
    const provider = conversationProvider(finalState.runProviderId || finalState.providerId);
    const projectName = entry.project?.name || '项目';
    const elapsed = lastRunSummary.get(entry.projectId)?.elapsed || elapsedLabel(entry.startedAt);
    const outcome = finalState.status === 'completed'
      ? '已完成'
      : finalState.status === 'cancelled' ? '已停止' : '处理失败';
    const active = isActiveProject(entry.projectId);
    if (!active) {
      notify?.(
        `${projectName} · ${provider.label}${outcome}（用时 ${elapsed}）`,
        finalState.status === 'failed' ? 'error' : 'info',
      );
    }
    if (finalState.status === 'cancelled') return;
    if (active && windowFocused() && conversationVisible()) return;
    invoke('notify', {
      title: `${projectName} · ${provider.label}${outcome}`,
      body: finalState.status === 'failed'
        ? finalState.error || '这一轮没有正常结束，回到 Roster 查看原因'
        : `用时 ${elapsed}，回到 Roster 查看回复`,
    }).catch(() => {});
  }

  async function buildChangeReport(entry) {
    let after = null;
    try {
      const before = await entry.baseline;
      if (!before) return;
      const result = await invoke('project_context', { path: entry.project.localPath });
      after = normalizeProjectChanges(result?.context || result);
      if (destroyed || !after) return;
      const report = diffProjectChanges(before, after);
      if (!report.files.length && !report.partial) changeReports.delete(entry.projectId);
      else changeReports.set(entry.projectId, report);
    } catch (_) {
      return;
    }
    if (isActiveProject(entry.projectId)) renderChangeReport();
  }

  function rememberSettledRun(entry) {
    settledRuns.set(entry.runId, entry);
    while (settledRuns.size > 8) settledRuns.delete(settledRuns.keys().next().value);
  }

  function finishRun(entry, finalState) {
    lastRunSummary.set(entry.projectId, {
      status: finalState.status,
      elapsed: elapsedLabel(entry.startedAt),
    });
    clearStoppingWatchdog(entry.runId);
    runController.clear(entry.runId);
    activeRuns.delete(entry.runId);
    rememberSettledRun(entry);
    if (entry.project?.localPath) invalidateHistory?.(entry.project.localPath);
    if (entry.baseline) void buildChangeReport(entry);
    const latest = projects.find(project => project.id === entry.projectId) || null;
    if (!isActiveProject(entry.projectId)) {
      if (deleteAfterRun.delete(entry.projectId)) {
        conversationStates.set(entry.projectId, createConversationState({
          projectId: entry.projectId,
          providerId: finalState.providerId,
        }));
      }
      renderProjects();
      announceFinishedRun(entry, finalState);
      return;
    }
    renderRunStatus();
    if (latest) {
      selectedProject = latest;
      persistSelection();
      renderProjects();
      setTimeout(() => {
        void refreshHistory();
        void refreshProjectContext();
      }, 450);
    } else {
      notify?.('当前项目已被删除；本轮对话保留在屏幕上，无法再刷新项目数据', 'info');
      renderState();
      renderProjects();
    }
    if (deleteAfterRun.delete(entry.projectId)) resetChat();
    void refreshUsage({ force: true });
    announceFinishedRun(entry, finalState);
  }

  function handleEvent(envelope) {
    if (!envelope?.runId) return;
    // A settled run still accepts its own late cancellation, which the reducer
    // lets win over a completion that raced it.
    const entry = activeRuns.get(envelope.runId)
      || (envelope.kind === 'cancelled' ? settledRuns.get(envelope.runId) : null);
    if (!entry) return;
    const previousState = stateForProject(entry.projectId);
    if (!previousState || previousState.runId !== envelope.runId) return;
    const wasRunning = conversationRunning(previousState);
    const nextState = applyConversationChatEvent(previousState, envelope);
    const stillRunning = conversationRunning(nextState);
    const active = commitState(entry.projectId, nextState);
    if (active) {
      const renderMode = conversationEventRenderMode(previousState, nextState, envelope);
      if (renderMode === 'deferred' && stillRunning) scheduleRender();
      else if (renderMode === 'immediate') renderState();
    }
    if (wasRunning && !stillRunning) finishRun(entry, nextState);
  }

  async function openProjectFolder() {
    if (!selectedProject) return;
    try {
      if (onOpenFolder) await onOpenFolder({ projectId: selectedProject.id });
      else await invoke('open_folder', { path: selectedProject.localPath });
    } catch (error) {
      notify?.(`打开项目文件夹失败：${error?.message || error}`, 'error');
    }
  }

  const messageScroller = dom.stream?.parentElement;
  let scrollTick = false;
  messageScroller?.addEventListener?.('scroll', () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      updateScrollAffordance();
    });
  });
  dom.scrollBottom?.addEventListener('click', () => scrollToLatest());

  // 只在对话工作台生效，且避开系统菜单已占用的组合键。
  const onWorkspaceKeydown = event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (document.documentElement?.dataset?.appView === 'developer') return;
    if (document.querySelector?.('.modal-mask.active')) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'f' && !event.shiftKey) {
      event.preventDefault();
      toggleSearch(true);
      return;
    }
    if (key === 'k' && !event.shiftKey) {
      event.preventDefault();
      dom.projectSearch?.focus?.();
      dom.projectSearch?.select?.();
      return;
    }
    if (key === 'n' && event.shiftKey) {
      event.preventDefault();
      if (selectedProject && !isRunning()) newChat();
    }
  };
  document.addEventListener?.('keydown', onWorkspaceKeydown);

  dom.projectSearch?.addEventListener('input', renderProjects);
  dom.searchInput?.addEventListener('input', () => {
    searchIndex = 0;
    renderSearch({ reveal: true });
  });
  dom.searchInput?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      toggleSearch(false);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    stepSearch(event.shiftKey ? -1 : 1);
  });
  dom.searchPrev?.addEventListener('click', () => stepSearch(-1));
  dom.searchNext?.addEventListener('click', () => stepSearch(1));
  dom.searchClose?.addEventListener('click', () => toggleSearch(false));
  dom.newChat?.addEventListener('click', newChat);
  dom.exportChat?.addEventListener('click', async () => {
    if (dom.exportChat.disabled) return;
    const content = conversationMarkdown({
      projectName: selectedProject?.name || '',
      messages: state.messages,
    });
    try {
      const saved = await invoke('export_conversation_markdown', {
        suggestedName: `${selectedProject?.name || '对话记录'}.md`,
        content,
      });
      notify?.(`已导出到 ${saved}`, 'success');
    } catch (error) {
      const reason = error?.message || String(error);
      if (!/未选择保存位置/.test(reason)) notify?.(`导出失败：${reason}`, 'error');
    }
  });
  dom.assistantBadge?.addEventListener('click', () => {
    if (dom.assistantBadge.disabled) return;
    openAssistantPicker({
      title: '这条对话用哪个助手？',
      hint: '还没开始的对话可以随便换；发出第一条消息之后就定下来了。',
      onPick: startChatWith,
    });
  });
  dom.handoff?.addEventListener('click', () => {
    if (dom.handoff.disabled) return;
    const source = currentProvider();
    openAssistantPicker({
      title: '让谁接手这段对话？',
      hint: `会在目标助手那边新开一条对话，带上最近 24 条正文；${source.label} 的会话保持不动。`,
      exclude: source.id,
      onPick: selectProvider,
    });
  });
  dom.assistantClose?.addEventListener('click', closeAssistantPicker);
  dom.assistantCancel?.addEventListener('click', closeAssistantPicker);
  dom.assistantOverlay?.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAssistantPicker();
  });
  dom.tuningToggle?.addEventListener('click', () => {
    if (dom.tuningToggle.disabled) return;
    tuningOpen = !tuningOpen;
    tuningSection = '';
    renderTuning();
  });
  // 点面板以外的地方就收起，避免它一直悬在输入框上。
  document.addEventListener?.('click', event => {
    if (!tuningOpen) return;
    const target = event?.target;
    if (target && (dom.tuningPanel?.contains?.(target) || dom.tuningToggle?.contains?.(target))) return;
    closeTuning();
    renderTuning();
  });
  dom.snippetSelect?.addEventListener('change', () => {
    if (dom.snippetSelect.value === MANAGE_SNIPPETS_VALUE) {
      dom.snippetSelect.value = '';
      onManageSnippets?.();
      return;
    }
    const snippet = snippets.find(item => String(item.id || '') === dom.snippetSelect.value);
    dom.snippetSelect.value = '';
    if (!snippet || !dom.composer || isRunning()) return;
    dom.composer.value = [dom.composer.value.trim(), String(snippet.content || '').trim()]
      .filter(Boolean)
      .join('\n\n');
    dom.composer.focus();
    syncComposer();
  });
  dom.attachImage?.addEventListener('click', async () => {
    if (dom.attachImage.disabled) return;
    try {
      await addAttachmentPaths(await invoke('pick_attachment_images'));
    } catch (error) {
      notify?.(`选择图片失败：${error?.message || error}`, 'error');
    }
  });
  dom.composer?.addEventListener('focus', () => {
    void refreshUsage({ maxAge: USAGE_FRESH_INTERVAL_MS });
  });
  dom.composer?.addEventListener('input', () => {
    slashDismissed = false;
    mentionDismissed = false;
    void refreshMentionFiles();
    syncComposer();
  });
  dom.composer?.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files || [])
      .filter(file => String(file.type || '').startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    addPastedImages(files);
  });
  dom.imagePreview?.addEventListener('click', () => closeImagePreview());
  dom.imagePreview?.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeImagePreview();
  });
  dom.addProject?.addEventListener('click', () => openCreateProject());
  dom.createFolder?.addEventListener('click', () => void chooseCreateFolder());
  dom.createCancel?.addEventListener('click', () => closeCreateProject());
  dom.createClose?.addEventListener('click', () => closeCreateProject());
  dom.createSave?.addEventListener('click', () => void saveCreatedProject());
  dom.createOverlay?.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeCreateProject();
  });
  dom.composer?.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (mentionOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        mentionIndex = (mentionIndex + step + mentionFiles.length) % mentionFiles.length;
        renderMentionMenu();
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        applyMention(mentionIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        mentionDismissed = true;
        renderMentionMenu();
        return;
      }
    }
    const parsed = slashInspect();
    const slashOpen = parsed.active && parsed.matches.length > 0 && !slashDismissed;
    if (slashOpen && event.key === 'ArrowDown') {
      event.preventDefault();
      slashIndex = (slashIndex + 1) % parsed.matches.length;
      renderSlashMenu();
      return;
    }
    if (slashOpen && event.key === 'ArrowUp') {
      event.preventDefault();
      slashIndex = (slashIndex - 1 + parsed.matches.length) % parsed.matches.length;
      renderSlashMenu();
      return;
    }
    if (slashOpen && event.key === 'Tab') {
      event.preventDefault();
      applySlashPlan(slashPlan(dom.composer?.value, slashIndex));
      return;
    }
    if (slashOpen && event.key === 'Escape') {
      event.preventDefault();
      slashDismissed = true;
      renderSlashMenu();
      renderControls();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send();
  });
  dom.send?.addEventListener('click', () => void send());
  dom.stop?.addEventListener('click', () => void stop());
  dom.openFolder?.addEventListener('click', () => void openProjectFolder());
  dom.refreshProject?.addEventListener('click', () => void refreshProjectContext({ force: true }));
  dom.stream?.addEventListener('click', event => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    const url = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(url)) {
      invoke('open_url', { url }).catch(error => {
        notify?.(`打开链接失败：${error?.message || error}`, 'error');
      });
    }
  });

  // Tauri 的原生拖放会吞掉 DOM drop 事件，所以走 tauri:// 这组事件；
  // 开发模式的终端拖放监听在对话视图下命中不到目标，两边不会打架。
  void invoke('list_conversation_session_titles')
    .then(titles => {
      if (destroyed) return;
      sessionTitles = titles && typeof titles === 'object' ? titles : {};
      void refreshHistory();
    })
    .catch(() => {});

  if (typeof listen === 'function') {
    const markDropTarget = on => {
      dom.composerBox?.classList?.[on ? 'add' : 'remove']('is-drop-target');
    };
    ['tauri://drag-enter', 'tauri://drag-over'].forEach(name => {
      void listen(name, () => markDropTarget(attachmentDropAllowed()))
        .then(stop => { if (destroyed) stop?.(); else dragUnlisteners.push(stop); })
        .catch(() => {});
    });
    void listen('tauri://drag-leave', () => markDropTarget(false))
      .then(stop => { if (destroyed) stop?.(); else dragUnlisteners.push(stop); })
      .catch(() => {});
    void listen('tauri://drag-drop', event => {
      markDropTarget(false);
      if (!attachmentDropAllowed()) return;
      void addAttachmentPaths(event?.payload?.paths);
    })
      .then(stop => { if (destroyed) stop?.(); else dragUnlisteners.push(stop); })
      .catch(() => {});
  }

  if (typeof listen === 'function') {
    void listen('conversation-chat-event', event => handleEvent(event?.payload)).then(stopListening => {
      if (destroyed) stopListening?.();
      else {
        unlisten = stopListening;
        listenerReady = true;
        listenerError = '';
        renderState();
      }
    }).catch(error => {
      listenerError = `对话服务连接失败：${error?.message || error}`;
      renderState();
      notify?.(listenerError, 'error');
    });
  } else {
    listenerError = '当前环境无法连接对话服务';
  }

  return {
    setProjects(nextProjects) {
      projects = Array.isArray(nextProjects) ? nextProjects : [];
      const known = new Set(projects.map(project => project.id));
      [...conversationStates.keys()].forEach(projectId => {
        if (known.has(projectId)
          || projectIsRunning(projectId)
          || projectId === selectedProject?.id) return;
        conversationStates.delete(projectId);
        conversationDrafts.delete(projectId);
        lastRunSummary.delete(projectId);
        changeReports.delete(projectId);
      });
      if (isRunning()) {
        const current = projects.find(project => project.id === selectedProject?.id);
        if (current) selectedProject = current;
        renderProjects();
        renderState();
        return;
      }
      const preferred = selectedProject?.id || readAppShellPreference(storage).projectId;
      const next = selectConversationProject(projects, preferred);
      const changed = next?.id !== selectedProject?.id;
      if (changed) activateProject(next);
      else selectedProject = next;
      persistSelection();
      renderProjects();
      renderState();
      if (changed) {
        void refreshHistory();
        void refreshProjectContext();
        void refreshSlashCommands();
      }
    },
    setInstalledCliIds(ids) {
      installedCliIds = Array.isArray(ids) ? [...ids] : null;
      const hasConversation = conversationHasOpenSession(state);
      if (!hasConversation && installedCliIds !== null && !providerReady(state.providerId)) {
        const fallback = runnableProviders()[0]?.id;
        if (fallback) state = selectConversationProvider(state, fallback);
      }
      persistSelection();
      renderState();
      void refreshSlashCommands();
      void refreshUsage({ force: true });
      void refreshModeOptions();
    },
    setSnippets(nextSnippets) {
      snippets = Array.isArray(nextSnippets) ? nextSnippets : [];
      renderSnippets();
      renderControls();
    },
    refreshHistory,
    refreshProjectContext,
    focusComposer() { dom.composer?.focus(); },
    isRunning,
    destroy() {
      destroyed = true;
      historyRevision += 1;
      transcriptRevision += 1;
      contextRevision += 1;
      slashRevision += 1;
      document.removeEventListener?.('keydown', onWorkspaceKeydown);
      dragUnlisteners.splice(0).forEach(stop => stop?.());
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (elapsedTimer !== null) clearInterval(elapsedTimer);
      elapsedTimer = null;
      clearStoppingWatchdog();
      unlisten?.();
    },
  };
}

export { relativeTime, renderMarkdown };
