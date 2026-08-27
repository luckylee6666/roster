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
import {
  conversationSlashHelpText,
  inspectConversationSlash,
  mergeConversationSlashCommands,
  planConversationSlash,
  validateConversationEffort,
  validateConversationModel,
} from './conversation-slash.js';
import {
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
    historyState: document.getElementById('conversation-history-state'),
    newChat: document.getElementById('conversation-new-chat'),
    projectName: document.getElementById('conversation-project-name'),
    projectPath: document.getElementById('conversation-project-path'),
    providerSelect: document.getElementById('conversation-provider-select'),
    providerState: document.getElementById('conversation-provider-state'),
    status: document.getElementById('conversation-status'),
    stream: document.getElementById('conversation-messages'),
    empty: document.getElementById('conversation-empty'),
    starters: document.getElementById('conversation-starter-list'),
    composer: document.getElementById('conversation-composer'),
    attachments: document.getElementById('conversation-attachments'),
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
    snippetSelect: document.getElementById('conversation-snippet-select'),
    manageSnippets: document.getElementById('conversation-manage-snippets'),
    handoff: document.getElementById('conversation-handoff'),
    writeAccess: document.getElementById('conversation-write-access'),
    safetyNote: document.getElementById('conversation-safety-note'),
    send: document.getElementById('conversation-send'),
    stop: document.getElementById('conversation-stop'),
    composerHint: document.getElementById('conversation-composer-hint'),
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
  let listenerReady = false;
  let listenerError = '';
  let renderTimer = null;
  let elapsedTimer = null;
  let inlineAlert = null;
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
  const collapsedProjectGroups = new Set();
  const projectMediaCache = new Map();
  const messageNodes = new Map();
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
  let providerModels = {};
  let providerEfforts = {};
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

  function renderProviderPicker() {
    if (!dom.providerSelect) return;
    dom.providerSelect.replaceChildren();
    if (installedCliIds === null) {
      const option = element(document, 'option', '', '正在检查本机 CLI');
      option.value = '';
      dom.providerSelect.appendChild(option);
      dom.providerSelect.disabled = true;
      return;
    }

    const options = runnableProviders();
    const current = currentProvider();
    if (!options.some(provider => provider.id === current.id)) {
      const option = element(
        document,
        'option',
        '',
        `${current.label}${current.historyOnly ? '（仅历史）' : '（未安装）'}`,
      );
      option.value = current.id;
      option.disabled = true;
      dom.providerSelect.appendChild(option);
    }
    options.forEach(provider => {
      const model = String(providerModels[provider.id] || '').trim();
      const effort = String(providerEfforts[provider.id] || '').trim();
      const details = [model, effort].filter(Boolean).join(' · ');
      const option = element(
        document,
        'option',
        '',
        details ? `${provider.label} · ${details}` : provider.label,
      );
      option.value = provider.id;
      dom.providerSelect.appendChild(option);
    });
    if (!options.length && !dom.providerSelect.options.length) {
      const option = element(document, 'option', '', '没有可用的 CLI');
      option.value = '';
      dom.providerSelect.appendChild(option);
    }
    dom.providerSelect.value = current.id;
    dom.providerSelect.disabled = isRunning() || options.length === 0;
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
    renderProviderPicker();
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
      dom.safetyNote.textContent = `默认使用 ${provider.label} 的只读/计划策略。打开“允许修改项目”后才切换到写入模式；第三方 CLI 的本机配置仍由其自身控制。`;
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
      body.append(label, content);
      row.append(body);
      entry = { row, label, content, labelText: '', tool: '', text: null, pending: null, attachments: null };
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
    const thinking = Boolean(message.pending) && !text;
    if (entry.text !== text || entry.pending !== thinking || entry.attachments !== attachments) {
      entry.text = text;
      entry.pending = thinking;
      entry.attachments = attachments;
      entry.content.replaceChildren();
      if (message.role === 'assistant') renderMarkdown(document, entry.content, text, hydrateLocalMedia);
      else entry.content.textContent = text;
      renderConversationAttachments(document, entry.content, attachments);
      if (thinking) {
        const dots = element(document, 'span', 'conversation-thinking');
        dots.setAttribute('aria-label', `${provider.label} 正在思考`);
        dots.append(element(document, 'i'), element(document, 'i'), element(document, 'i'));
        entry.content.appendChild(dots);
      }
    }
    return entry.row;
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
    if (inlineAlert.textContent !== text) inlineAlert.textContent = text;
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
    if (dom.starters) dom.starters.hidden = state.messages.length > 0;
    const live = new Set();
    const nodes = state.messages.map(message => {
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
      });
    }
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
    dom.snippetSelect.value = '';
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
    if (dom.writeAccess) dom.writeAccess.disabled = unavailable || busy;
    if (dom.snippetSelect) dom.snippetSelect.disabled = busy || deleting || !selectedProject || snippets.length === 0;
    if (dom.manageSnippets) dom.manageSnippets.disabled = busy || !onManageSnippets;
    if (dom.handoff) dom.handoff.disabled = busy
      || !conversationHasOpenSession(state)
      || runnableProviders().length < 2;
    if (dom.newChat) {
      const showNewChat = Boolean(selectedProject && conversationHasOpenSession(state));
      dom.newChat.hidden = !showNewChat;
      dom.newChat.disabled = busy || !showNewChat;
    }
    if (dom.providerSelect) dom.providerSelect.disabled = busy || installedCliIds === null || runnableProviders().length === 0;
    if (dom.openFolder) dom.openFolder.disabled = !selectedProject;
    if (dom.refreshProject) dom.refreshProject.disabled = !selectedProject || contextLoading;
    dom.starters?.querySelectorAll('button').forEach(button => { button.disabled = unavailable || busy || deleting; });
    if (dom.composerHint) {
      dom.composerHint.textContent = !selectedProjectExists()
        ? '先选择一个项目'
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
                      : state.sourceTool && state.sourceTool !== provider.id
                        ? `发送后由 ${provider.label} 接手 ${conversationProvider(state.sourceTool).label} 的上下文`
                        : [currentModel(), currentEffort()].filter(Boolean).length
                      ? `Enter 发送，Shift + Enter 换行 · ${[currentModel(), currentEffort()].filter(Boolean).join(' · ')}`
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
    renderSnippets();
    renderSlashMenu();
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

  function renderHistory(history, project) {
    if (!dom.historyList || !dom.historyState || selectedProject?.id !== project?.id) return;
    dom.historyList.replaceChildren();
    const sessions = flattenConversationHistory(history, { limit: 30 });
    dom.historyState.textContent = sessions.length ? '' : '这个项目还没有历史对话';
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
      copy.append(
        element(document, 'strong', '', session.title),
        element(document, 'span', '', session.tool === 'agy'
          ? `${relativeTime(session.atMs)} · 仅含用户记录`
          : relativeTime(session.atMs)),
      );
      button.append(badge, copy);
      button.addEventListener('click', () => void openHistory(session));
      const remove = element(document, 'button', 'conversation-history-delete', '×');
      remove.type = 'button';
      remove.title = `删除 ${session.label} 历史对话`;
      remove.setAttribute('aria-label', `删除 ${session.title}`);
      remove.addEventListener('click', () => void deleteHistory(session, row));
      row.append(button, remove);
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
      if (dom.writeAccess) dom.writeAccess.checked = false;
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
      else if (selectedKey === session.key) newChat();
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
      allowWrite: Boolean(dom.writeAccess?.checked),
    });
  }

  // Only a project the user has already typed in owns a draft; the others keep
  // whatever is in the composer, exactly as a single-project switch used to.
  function restoreDraft(projectId) {
    if (!conversationDrafts.has(projectId)) {
      if (dom.writeAccess) dom.writeAccess.checked = false;
      return;
    }
    const draft = conversationDrafts.get(projectId) || {};
    if (dom.composer) dom.composer.value = String(draft.text || '');
    pendingAttachments = Array.isArray(draft.attachments) ? draft.attachments : [];
    if (dom.writeAccess) dom.writeAccess.checked = Boolean(draft.allowWrite);
    renderPendingAttachments();
  }

  function activateProject(next) {
    stashActiveConversation();
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
    dom.composer?.focus();
    return true;
  }

  function newChat() {
    if (!selectedProject || isRunning()) return;
    resumeLatestOnHistory = false;
    transcriptRevision += 1;
    state = createConversationState({
      projectId: selectedProject.id,
      providerId: providerForNewChat(),
    });
    conversationStates.set(selectedProject.id, state);
    if (dom.writeAccess) dom.writeAccess.checked = false;
    persistSelection();
    renderState();
    void refreshHistory();
    dom.composer?.focus();
  }

  function selectProvider(providerId) {
    if (isRunning() || !providerReady(providerId)) return;
    const next = selectConversationProvider(state, providerId);
    if (next === state) return;
    state = next;
    if (dom.writeAccess) dom.writeAccess.checked = false;
    persistSelection();
    renderState();
    void refreshHistory();
    void refreshSlashCommands();
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
    const allowWrite = !!dom.writeAccess?.checked;
    activeRuns.set(runId, { runId, projectId: project.id, project: { ...project }, startedAt: Date.now() });
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
        allowWrite,
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
      if (dom.writeAccess) dom.writeAccess.checked = false;
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
    const latest = projects.find(project => project.id === entry.projectId) || null;
    if (!isActiveProject(entry.projectId)) {
      const draft = conversationDrafts.get(entry.projectId);
      if (draft) conversationDrafts.set(entry.projectId, { ...draft, allowWrite: false });
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
    if (dom.writeAccess) dom.writeAccess.checked = false;
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
    if (deleteAfterRun.delete(entry.projectId)) newChat();
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

  dom.projectSearch?.addEventListener('input', renderProjects);
  dom.newChat?.addEventListener('click', newChat);
  dom.providerSelect?.addEventListener('change', () => selectProvider(dom.providerSelect.value));
  dom.snippetSelect?.addEventListener('change', () => {
    const snippet = snippets.find(item => String(item.id || '') === dom.snippetSelect.value);
    dom.snippetSelect.value = '';
    if (!snippet || !dom.composer || isRunning()) return;
    dom.composer.value = [dom.composer.value.trim(), String(snippet.content || '').trim()]
      .filter(Boolean)
      .join('\n\n');
    dom.composer.focus();
    syncComposer();
  });
  dom.manageSnippets?.addEventListener('click', () => onManageSnippets?.());
  dom.handoff?.addEventListener('click', () => {
    if (dom.handoff.disabled) return;
    dom.providerSelect?.focus();
    notify?.('请选择接手当前对话的助手；下一条消息会带上交接上下文', 'info');
    try {
      if (typeof dom.providerSelect?.showPicker === 'function') dom.providerSelect.showPicker();
      else dom.providerSelect?.click?.();
    } catch (_) {
      dom.providerSelect?.click?.();
    }
  });
  dom.composer?.addEventListener('input', () => {
    slashDismissed = false;
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
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (elapsedTimer !== null) clearInterval(elapsedTimer);
      elapsedTimer = null;
      clearStoppingWatchdog();
      unlisten?.();
    },
  };
}

export { relativeTime, renderMarkdown };
