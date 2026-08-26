import {
  createLineNumberText,
  editorChangedDuringSave,
  editorTextFromFile,
  fileTextFromEditor,
  textLineCount,
} from './file-editor-utils.js';
import {
  clearImageTerminalCellBackgrounds,
  scheduleImageTerminalCellBackgroundSync as scheduleCellBackgroundSync,
  syncImageTerminalCellBackgrounds,
} from './terminal-theme-utils.js';
import { installThemePointer } from './terminal-theme-pointer.js';
import { installTerminalCharacterTheme } from './terminal-theme-character.js';
import { normalizeProjectMachine, projectMachineTag } from './project-form-utils.js';
import { seedThemePresets } from './terminal-theme-presets.js';
import { CLI_TOOLS, CLI_TOOL_IDS, installedCliTools, normalizeInstalledCliIds } from './cli-tools.js';
import {
  cliToolName,
  restoreSessionLayout,
  resumeCliCommand,
  sessionLayoutEntries,
} from './session-restore-utils.js';
import {
  DEFAULT_PROJECT_KIT,
  PROJECT_KIT_LAYOUT,
  createProjectSessionHistoryLoader,
  filterHistoryGroups,
  findRunningProjectTool,
  launchCommandForProjectTool,
  runningHistoryLookup,
  runningTerminalIdForHistory,
  sameProjectCwd,
} from './project-history-utils.js';
import {
  buildSessionHandoffMarkdown,
  handoffLaunchPrompt,
  handoffTargetTools,
  latestHandoffSession,
  SESSION_HANDOFF_FILE_MAX_BYTES,
  sessionHandoffAvailability,
  validateSessionHandoffContent,
} from './session-handoff-utils.js';
import {
  SESSION_RAIL_HEIGHT_KEY,
  SESSION_RAIL_HIDDEN_KEY,
  buildSessionRailModel,
  clampSessionRailHeight,
  formatRailRelativeTime,
  isRailCliTool,
  sessionRailAction,
  sessionRailHiddenFromStorage,
  sessionRailViewLoading,
} from './session-rail-utils.js';
import { usageCommandForAgent, windowsFromUsagePayload } from './usage-panel-utils.js';
import {
  DEFAULT_ORCHESTRA_BRAIN,
  ORCHESTRA_GOAL_FILE,
  ORCHESTRA_PLAN_FILE,
  orchestraBrainPrompt,
  orchestraBroadcastPrompt,
  orchestraInboxFile,
  orchestraRoleForTool,
  orchestraRoleLabel,
  orchestraToolLabel,
  orchestraWorkerPrompt,
  normalizeOrchestraConfig,
} from './orchestra-utils.js';
import {
  commitOrchestraFilesTransaction,
  createLatestRequestGate,
  restoreOrchestraFileSnapshot,
  runOrchestraLaunchTransaction,
} from './orchestra-launch-utils.js';
import {
  isNativeEscOverlayOpen,
  isXtermHelperTextarea,
  shouldWriteNativeEscapeToPty,
} from './native-esc-utils.js';
import { setFilePreviewLayerOpen } from './file-preview-layer.js';
import { createTerminalInputBuffer } from './terminal-input-buffer.js';
import { installWorkspaceMode } from './workspace-mode.js';
import { installAppShell } from './app-shell.js';
import {
  isDeveloperTerminalVisible,
  normalizeAppView,
  readAppShellPreference,
} from './app-shell-utils.js';
import { installConversationMode } from './conversation-mode.js';
import {
  createShellScriptCommand,
  isShellScriptEntry,
  shellQuotePath as quoteShellPath,
  shouldCloseShellScriptPreview,
} from './shell-script-utils.js';
import {
  closeTerminalPaneSession,
  normalizeTerminalPaneLayout,
  reconcileTerminalPanes,
  removeTerminalPaneSession,
  selectTerminalPaneSession,
  terminalPaneArrangement,
  terminalSessionIdAtPoint,
  visibleTerminalSessionIds,
} from './terminal-pane-layout.js';
import {
  PROJECT_MEMORY_UNIFY_STORAGE_KEY,
  isProjectMemoryUnifyEnabled,
  loadProjectMemoryUnifyPaths,
  memoryBannerText,
  normalizeProjectMemoryCwd,
  setProjectMemoryUnifyEnabled,
  shouldAutoMountProjectMemory,
  shouldMountProjectMemory,
} from './project-memory-utils.js';
import {
  claimOrphanProjectIdea,
  commitProjectIdeaSnapshot,
  createProjectIdea,
  createProjectIdeaMutationGate,
  findProjectIdea,
  orphanProjectIdeas,
  planProjectIdeaPaste,
  projectIdeasFor,
  removeProjectIdea,
  updateProjectIdea,
} from './project-ideas-utils.js';
import { createTerminalSessionCloseCoordinator } from './terminal-session-close.js';
import {
  applyUiScale,
  readUiScale,
  writeUiScale,
} from './ui-scale-utils.js';
import {
  DEFAULT_NO_PROXY,
  isValidProxyUrl,
  normalizeProxySettings,
  redactProxyUrl,
} from './proxy-settings-utils.js';

let invoke;
try {
  invoke = window.__TAURI__.core.invoke;
} catch (e) {
  document.body.innerHTML = '<div style="padding:40px;color:red;font-size:16px;">Tauri API 未加载，请用 <code>pnpm tauri dev</code> 启动</div>';
  throw e;
}

// 把前端日志/未捕获异常转发到后端统一的 app.log（排查问题用）。
function appLog(level, msg) {
  // .catch 兜底：app_log 自身若被拒，绝不能再冒泡成 unhandledrejection（否则会自我放大成日志风暴）
  try { invoke('app_log', { level, msg: String(msg) }).catch(() => {}); } catch (_) {}
}
window.addEventListener('error', e => {
  // 跳过资源加载错误（img/script 404 等，message 为空），只记真正的脚本错误
  if (!e.message) return;
  appLog('error', `JS 错误：${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  let detail;
  if (r && r.message) detail = r.message;
  else if (typeof r === 'string') detail = r;
  else { try { detail = JSON.stringify(r); } catch (_) { detail = String(r); } }
  appLog('error', `未处理的 Promise 拒绝：${detail}`);
});

let projects = [];
let servers = [];
let snippets = [];
let projectIdeas = [];
let currentEditId = null;
let pendingConfirm = null;
let pendingConfirmCancel = null;
let activeGroup = 'all';
let currentServerEditId = null;

const $ = id => document.getElementById(id);

const el = {
  list: $('project-list'),
  empty: $('empty-state'),
  countAll: $('count-all'),
  search: $('search-input'),
  addBtn: $('add-btn'),
  exportBtn: $('export-btn'),
  modal: $('modal-overlay'),
  modalTitle: $('modal-title'),
  modalClose: $('modal-close'),
  form: $('project-form'),
  id: $('project-id'),
  name: $('project-name'),
  path: $('project-path'),
  url: $('project-url'),
  machine: $('project-machine'),
  serverSelectWrap: $('server-select-wrap'),
  serverSelect: $('project-server'),
  manageServerBtn: $('manage-server-btn'),
  group: $('project-group'),
  groupList: $('group-list'),
  groupSuggestions: $('group-suggestions'),
  desc: $('project-desc'),
  browse: $('browse-btn'),
  cancel: $('cancel-btn'),
  submit: $('submit-btn'),
  confirm: $('confirm-overlay'),
  confirmClose: $('confirm-close'),
  confirmTitle: $('confirm-title'),
  confirmMessage: $('confirm-message'),
  confirmCancel: $('confirm-cancel'),
  confirmDelete: $('confirm-delete'),
  sessionPreview: $('session-preview-overlay'),
  sessionPreviewTitle: $('session-preview-title'),
  sessionPreviewMeta: $('session-preview-meta'),
  sessionPreviewBody: $('session-preview-body'),
  sessionPreviewClose: $('session-preview-close'),
  sessionPreviewCancel: $('session-preview-cancel'),
  sessionPreviewOpen: $('session-preview-open'),
  sessionHandoff: $('session-handoff-overlay'),
  sessionHandoffSource: $('session-handoff-source'),
  sessionHandoffTargets: $('session-handoff-targets'),
  sessionHandoffStatus: $('session-handoff-status'),
  sessionHandoffContent: $('session-handoff-content'),
  sessionHandoffClose: $('session-handoff-close'),
  sessionHandoffCancel: $('session-handoff-cancel'),
  sessionHandoffStart: $('session-handoff-start'),
  orchestra: $('orchestra-overlay'),
  orchestraGoal: $('orchestra-goal'),
  orchestraBrainPicks: $('orchestra-brain-picks'),
  orchestraWorkerPicks: $('orchestra-worker-picks'),
  orchestraWorkersHint: $('orchestra-workers-hint'),
  orchestraModalClose: $('orchestra-modal-close'),
  orchestraModalCancel: $('orchestra-modal-cancel'),
  orchestraModalStart: $('orchestra-modal-start'),
  proxyEntry: $('proxy-settings-entry'),
  proxyDot: $('proxy-switch-dot'),
  proxyOverlay: $('proxy-overlay'),
  proxyEnabled: $('proxy-enabled'),
  proxyUrl: $('proxy-url'),
  proxyNoProxy: $('proxy-noproxy'),
  proxyClose: $('proxy-modal-close'),
  proxyCancel: $('proxy-modal-cancel'),
  proxySave: $('proxy-modal-save'),
  toasts: $('toast-container'),
  serverModal: $('server-modal-overlay'),
  serverModalTitle: $('server-modal-title'),
  serverModalClose: $('server-modal-close'),
  serverForm: $('server-form'),
  serverId: $('server-id'),
  serverName: $('server-name'),
  serverHost: $('server-host'),
  serverPort: $('server-port'),
  serverUser: $('server-user'),
  serverAuthType: $('server-auth-type'),
  serverNote: $('server-note'),
  serverCancelBtn: $('server-cancel-btn'),
  serverSubmitBtn: $('server-submit-btn'),
  serverListOverlay: $('server-list-overlay'),
  serverListClose: $('server-list-close'),
  addServerBtn: $('add-server-btn'),
  serverList: $('server-list'),
  serverEmpty: $('server-empty'),
  scanBtn: $('scan-btn'),
  scanModal: $('scan-modal-overlay'),
  scanModalTitle: $('scan-modal-title'),
  scanModalClose: $('scan-modal-close'),
  scanStatus: $('scan-status'),
  scanList: $('scan-list'),
  scanEmpty: $('scan-empty'),
  scanCancelBtn: $('scan-cancel-btn'),
  scanImportBtn: $('scan-import-btn'),
  treeCtxMenu: $('tree-context-menu'),
};

const initialAppView = normalizeAppView(document.documentElement.dataset.appView);
let appViewController = null;
let conversationController = null;
let terminalRestoreOffered = false;

function currentAppView() {
  return appViewController?.view || initialAppView;
}

function developerTerminalVisible() {
  return isDeveloperTerminalVisible(
    currentAppView(),
    !!termEl?.dock?.classList.contains('active'),
  );
}

async function init() {
  await load();
  bind();
  installApplicationSurfaces();
  void refreshInstalledClis();
  void refreshProxyIndicator();
  try {
    await setupEditorExitGuard();
  } catch (e) {
    appLog('error', `注册未保存退出保护失败：${e.message || e}`);
  }
  await initTermTheme(); // 自定义主题表 + 恢复上次主题（可能是 custom:*），先于会话还原
  await bindNativeEscListener();
  if (currentAppView() === 'developer') offerTerminalSessionRestore();
}

function offerTerminalSessionRestore() {
  if (terminalRestoreOffered) return;
  terminalRestoreOffered = true;
  maybeRestoreSessions();
}

function installApplicationSurfaces() {
  if (appViewController || conversationController) return;
  conversationController = installConversationMode({
    document,
    storage: localStorage,
    invoke,
    listen: window.__TAURI__?.event?.listen,
    notify: msg,
    loadHistory: loadProjectSessionHistory,
    invalidateHistory: invalidateProjectSessionHistory,
    onCreateIdea: createConversationProjectIdea,
    onUpdateIdea: updateConversationProjectIdea,
    onDeleteIdea: deleteConversationProjectIdea,
    onOpenFolder: openConversationProjectFolder,
    onRefreshProject: refreshConversationProject,
    onManageSnippets: openSnippetModal,
    onCreateProject: async () => {
      if (await appViewController?.setView('developer')) openModal();
    },
    confirm: requestConfirm,
  });
  conversationController.setProjects(projects);
  conversationController.setIdeas(projectIdeas);
  conversationController.setSnippets(snippets);
  if (installedCliIds !== null) conversationController.setInstalledCliIds(installedCliIds);

  appViewController = installAppShell({
    document,
    storage: localStorage,
    initialView: initialAppView,
    beforeConversation: async () => {
      const hidden = await workspaceController?.setAppVisible(false);
      if (hidden === false) return false;
      cleanupTreeDrag();
      setTerminalPaneDragTarget(null);
      characterTheme?.setDockOpen(false);
      return true;
    },
    beforeDeveloper: async () => {
      const visible = await workspaceController?.setAppVisible(true);
      if (visible === false) return false;
      offerTerminalSessionRestore();
      requestAnimationFrame(() => {
        characterTheme?.setDockOpen(termEl.dock.classList.contains('active'));
        scheduleFitVisibleSessions(true);
      });
      return true;
    },
    onViewChange: view => {
      if (view === 'conversation') conversationController?.focusComposer();
    },
    notify: msg,
  });

  document.querySelectorAll('[data-conversation-starter]').forEach(button => {
    button.addEventListener('click', () => {
      const composer = $('conversation-composer');
      if (!composer || composer.disabled || conversationController?.isRunning()) return;
      composer.value = button.dataset.conversationStarter || '';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.focus();
    });
  });
}

let nativeEscBound = false;
async function bindNativeEscListener() {
  if (nativeEscBound) return;
  nativeEscBound = true;
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== 'function') return;
  await listen('native-esc', () => {
    if (!developerTerminalVisible()) return;
    const renameInput = document.querySelector('.group-rename-input');
    if (renameInput) {
      renameInput.blur();
      return;
    }
    if (isNativeEscOverlayOpen(document)) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    const session = activeSession ? sessions.get(activeSession) : null;
    if (!shouldWriteNativeEscapeToPty({
      dockActive: termEl.dock.classList.contains('active'),
      sessionStatus: session?.status || '',
      overlayOpen: false,
      terminalFocused: isXtermHelperTextarea(document.activeElement),
    })) return;
    invoke('terminal_write', { id: activeSession, data: '\x1b' }).catch(() => {});
  });
}



async function load() {
  try {
    projects = await invoke('get_projects');
    servers = await invoke('get_servers');
    try { snippets = await invoke('get_snippets'); } catch (_) { snippets = []; }
    try { projectIdeas = await invoke('get_project_ideas'); } catch (_) { projectIdeas = []; }
    renderGroups();
    render(projects);
    el.countAll.textContent = projects.length;
    syncProjectIdeasContext();
    conversationController?.setProjects(projects);
    conversationController?.setIdeas(projectIdeas);
    renderSnippetQuick();
    startScheduler();
  } catch (e) {
    console.error('加载失败:', e);
    appLog('error', '初始数据加载失败：' + (e.message || e));
    msg('加载失败: ' + (e.message || e), 'error');
    conversationController?.setProjects([]);
  }
}

function getGroups() {
  const groups = {};
  projects.forEach(p => {
    const g = p.group || '未分组';
    groups[g] = (groups[g] || 0) + 1;
  });
  const sorted = {};
  Object.keys(groups)
    .sort((a, b) => a === '未分组' ? 1 : b === '未分组' ? -1 : a.localeCompare(b))
    .forEach(k => sorted[k] = groups[k]);
  return sorted;
}

function renderGroups() {
  const groups = getGroups();
  const entries = Object.entries(groups);
  
  el.groupList.innerHTML = entries.map(([name, count]) => {
    const isActive = activeGroup === name;
    const groupProjects = projects.filter(p => (p.group || '未分组') === name);
    return `
    <div class="menu-group-item ${isActive ? 'expanded' : ''}" data-group="${escAttr(name)}">
      <a class="menu-item ${isActive ? 'active' : ''}" href="#" data-group="${escAttr(name)}">
        <svg class="group-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18l6-6-6-6"/>
        </svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"/>
        </svg>
        <span class="group-name">${esc(name)}</span>
        ${name !== '未分组' ? `<span class="group-rename-btn" title="重命名分组"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16.5 4.5l3 3M4 20l1-4L16.5 4.5l3 3L8 19l-4 1z"/></svg></span>` : ''}
        <span class="menu-badge">${count}</span>
      </a>
      <div class="group-children">
        ${groupProjects.map(p => `
          <a class="menu-child-item" href="#" data-id="${p.id}">
            <span>${esc(p.name)}</span>
          </a>
        `).join('')}
      </div>
    </div>
    `;
  }).join('');

  el.groupSuggestions.innerHTML = Object.keys(groups)
    .filter(g => g !== '未分组')
    .map(g => `<option value="${escAttr(g)}">`)
    .join('');

  el.groupList.querySelectorAll('.menu-group-item > .menu-item').forEach(item => {
    item.onclick = (e) => {
      e.preventDefault();
      const groupName = item.dataset.group;
      const groupEl = item.parentElement;
      if (activeGroup === groupName) {
        groupEl.classList.toggle('expanded');
      } else {
        activeGroup = groupName;
        document.querySelectorAll('.sider .menu-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.sider .menu-group-item').forEach(g => g.classList.remove('expanded'));
        item.classList.add('active');
        groupEl.classList.add('expanded');
        filterAndRender();
      }
    };
  });

  el.groupList.querySelectorAll('.menu-child-item').forEach(child => {
    child.onclick = (e) => {
      e.preventDefault();
      const id = child.dataset.id;
      const card = document.querySelector(`.project-card[data-id="${id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('highlight');
        setTimeout(() => card.classList.remove('highlight'), 1500);
      }
    };
  });

  el.groupList.querySelectorAll('.group-rename-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = btn.closest('.menu-group-item');
      startRenameGroup(item, item.dataset.group);
    };
  });
}

// 分组就地重命名：把名字 span 换成输入框，回车提交 / 点击外部或 Esc 取消（WKWebView 无原生 prompt）。
// 注意：macOS WKWebView 会在系统层吞掉 Esc，JS 永远收不到，所以不能把它当唯一取消路径——
// 失焦（点击外部）也必须走取消，否则用户在 Esc 失效的平台上根本没法放弃一次误改。
function startRenameGroup(groupItemEl, oldName) {
  const nameSpan = groupItemEl.querySelector(':scope > .menu-item > .group-name');
  if (!nameSpan) return;
  const input = document.createElement('input');
  input.className = 'group-rename-input';
  input.value = oldName;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    const newName = input.value.trim();
    if (save && newName && newName !== oldName) {
      try {
        await invoke('rename_group', { old: oldName, new: newName });
        if (activeGroup === oldName) activeGroup = newName;
        await load(); // 内部会重渲染分组
        return;
      } catch (e) {
        msg('重命名失败: ' + (e.message || e), 'error');
      }
    }
    renderGroups();
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(false);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
  input.addEventListener('click', e => e.stopPropagation());
}

function filterAndRender() {
  const q = el.search.value.toLowerCase();
  let filtered = projects;

  if (activeGroup !== 'all') {
    filtered = filtered.filter(p => (p.group || '未分组') === activeGroup);
  }

  if (q) {
    filtered = filtered.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      (p.localPath || '').toLowerCase().includes(q) ||
      (p.remoteUrl || '').toLowerCase().includes(q)
    );
  }

  render(filtered);
}

function getServerName(serverId) {
  const s = servers.find(x => x.id === serverId);
  return s ? s.name : '';
}

function machineTagHtml(machine) {
  const tag = projectMachineTag(machine);
  return tag ? `<span class="tag ${tag.className}">${tag.label}</span>` : '';
}

let installedCliIds = null;
let installedCliAt = 0;
let installedCliProbeRevision = 0;
let installedCliProbeRetries = 0;
let installedCliRetryTimer = null;
const INSTALLED_CLI_TTL_MS = 60_000;
const INSTALLED_CLI_MAX_RETRIES = 2;

function scheduleInstalledCliRetry() {
  clearTimeout(installedCliRetryTimer);
  installedCliRetryTimer = setTimeout(() => {
    installedCliRetryTimer = null;
    void refreshInstalledClis({ force: true });
  }, 500 * installedCliProbeRetries);
}

function cardCliButtonsHtml(project) {
  const last = cliToolName(getProjectActivity(project?.id)?.cli);
  return installedCliTools(installedCliIds).map(tool => {
    const recent = tool.id === last;
    return `<button type="button" class="card-cli-btn${recent ? ' is-recent' : ''}" data-cmd="${escAttr(tool.id)}" title="打开 ${escAttr(tool.label)}，续上一次会话">`
      + `<span class="term-tab-tool tool-${esc(tool.id)}">${esc(tool.id)}</span>`
      + `</button>`;
  }).join('');
}

function paintCardCliRows() {
  document.querySelectorAll('.card-cli-row[data-cli-id]').forEach(row => {
    const project = projects.find(item => item.id === row.dataset.cliId);
    if (!project) return;
    row.innerHTML = cardCliButtonsHtml(project);
    row.querySelectorAll('.card-cli-btn').forEach(btn => {
      btn.onclick = event => {
        event.stopPropagation();
        void openTerminal(project, btn.dataset.cmd);
      };
    });
  });
}

async function refreshInstalledClis({ force = false } = {}) {
  if (!force && installedCliIds && Date.now() - installedCliAt < INSTALLED_CLI_TTL_MS) {
    paintCardCliRows();
    syncSessionHandoffButton();
    conversationController?.setInstalledCliIds(installedCliIds);
    return;
  }
  // A pending retry is an older probe. If it fires while this forced request is
  // in flight it would advance the revision and discard this newer result,
  // briefly turning an installed CLI into “not installed”.
  if (force && installedCliRetryTimer !== null) {
    clearTimeout(installedCliRetryTimer);
    installedCliRetryTimer = null;
  }
  const revision = ++installedCliProbeRevision;
  try {
    const found = await invoke('list_installed_clis', { names: [...CLI_TOOL_IDS] });
    if (revision !== installedCliProbeRevision) return;
    const detected = normalizeInstalledCliIds(found);
    // Login-shell startup can fail transiently while the app itself is still
    // opening. Do not turn one empty probe into a false “not installed” state.
    if (!detected.length && installedCliProbeRetries < INSTALLED_CLI_MAX_RETRIES) {
      installedCliProbeRetries += 1;
      installedCliAt = 0;
      conversationController?.setInstalledCliIds(installedCliIds);
      scheduleInstalledCliRetry();
      return;
    }
    installedCliIds = detected;
  } catch (_) {
    if (revision !== installedCliProbeRevision) return;
    // 探测失败不能谎报“全部已安装”；保留上一次成功结果，
    // 首次启动则先有界重试，多次失败后才安全显示为空。
    if (installedCliProbeRetries < INSTALLED_CLI_MAX_RETRIES) {
      installedCliProbeRetries += 1;
      installedCliAt = 0;
      conversationController?.setInstalledCliIds(installedCliIds);
      scheduleInstalledCliRetry();
      return;
    }
    installedCliIds ??= [];
    installedCliAt = 0;
    paintCardCliRows();
    syncSessionHandoffButton();
    conversationController?.setInstalledCliIds(installedCliIds);
    return;
  }
  clearTimeout(installedCliRetryTimer);
  installedCliRetryTimer = null;
  installedCliProbeRetries = 0;
  installedCliAt = Date.now();
  paintCardCliRows();
  syncSessionHandoffButton();
  conversationController?.setInstalledCliIds(installedCliIds);
}

function render(list) {
  if (!list.length) {
    el.empty.style.display = 'flex';
    el.list.style.display = 'none';
    return;
  }
  el.empty.style.display = 'none';
  el.list.style.display = 'flex';

  el.list.innerHTML = list.map(p => `
    <div class="project-card" data-id="${p.id}">
      <div class="card-row">
        <div class="card-main">
          <div class="card-title">
            <button class="card-session-toggle" type="button" aria-expanded="false" title="展开历史会话">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
            </button>
            ${esc(p.name)}
            ${p.group ? `<span class="card-group">${esc(p.group)}</span>` : ''}
            <span class="card-git" data-git-id="${p.id}"></span>
          </div>
          <div class="card-info">
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/></svg>
              <span class="path-clip" title="${escAttr(p.localPath)}"><span class="path-text">${esc(p.localPath)}</span></span>
            </div>
            ${p.remoteUrl ? `<div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/></svg>
              <a class="card-remote-link" href="${escAttr(p.remoteUrl)}" rel="noopener noreferrer">${esc(repo(p.remoteUrl))}</a>
            </div>` : ''}
          </div>
          ${p.description ? `<div class="card-desc">${esc(p.description)}</div>` : ''}
          <div class="card-tags">
            ${machineTagHtml(p.machine)}
            ${p.machine === 'server' && p.serverId ? `<span class="tag tag-server">${esc(getServerName(p.serverId))}</span>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="action-btn context-btn" title="恢复现场（git/改动/CLAUDE.md）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>
          </button>
          <button class="action-btn kit-btn" title="开一套（Claude + Codex + Grok 主从）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.2" y="4.2" width="10.2" height="15.6" rx="1.4"/><rect x="10.6" y="7.2" width="10.2" height="6.2" rx="1.2"/><rect x="10.6" y="14.4" width="10.2" height="5.4" rx="1.2"/></svg>
          </button>
          <button class="action-btn orchestra-btn-card" title="开协作（一个大脑拆活，多个终端动手）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="8" r="2.2"/><circle cx="17" cy="8" r="2.2"/><circle cx="12" cy="16.2" r="2.2"/><path d="M8.8 9.4l2.4 5.2M15.2 9.4l-2.4 5.2"/></svg>
          </button>
          <button class="action-btn edit-btn" title="编辑">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>
          </button>
          <button class="action-btn danger del-btn" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
          </button>
        </div>
      </div>
      <div class="card-foot">
        <span class="card-cli-row" data-cli-id="${p.id}">${cardCliButtonsHtml(p)}</span>
      </div>
      <div class="card-sessions" hidden></div>
    </div>
  `).join('');

  el.list.querySelectorAll('.project-card').forEach(card => {
    const id = card.dataset.id;
    const p = projects.find(x => x.id === id);
    if (!p) return;
    const toggle = card.querySelector('.card-session-toggle');
    toggle.onclick = (ev) => {
      ev.stopPropagation();
      toggleProjectSessions(p, card);
    };
    if (expandedProjectIds.has(id)) {
      void expandProjectSessions(p, card);
    }
    card.querySelector('.context-btn').onclick = (ev) => {
      ev.stopPropagation();
      openContextModal(p);
    };
    card.querySelector('.kit-btn').onclick = (ev) => {
      ev.stopPropagation();
      void openProjectKit(p);
    };
    card.querySelector('.orchestra-btn-card').onclick = (ev) => {
      ev.stopPropagation();
      void openOrchestraModal(p);
    };
    card.querySelector('.edit-btn').onclick = () => openModal(p);
    card.querySelector('.del-btn').onclick = () => del(p.id, p.name);
    card.querySelectorAll('.card-cli-btn').forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        void openTerminal(p, btn.dataset.cmd);
      };
    });
    const remoteLink = card.querySelector('.card-remote-link');
    if (remoteLink) remoteLink.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // 只放行 http(s) 并交给系统浏览器打开——绝不让注入的 javascript: 或异常 scheme
      // 在 webview 里执行，也不让主 webview 被导航离开应用。
      const u = p.remoteUrl || '';
      if (/^https?:\/\//i.test(u)) invoke('open_url', { url: u }).catch(() => {});
    };
  });

  refreshGitStatus();
}

const expandedProjectIds = new Set();
const projectSessionCache = new Map();
const projectSessionHistoryLoader = createProjectSessionHistoryLoader(
  path => invoke('list_project_sessions', { path }),
);
const projectSessionLoads = projectSessionHistoryLoader.pending;
const projectSessionQueries = new Map();
const sessionRailHistoryByCwd = new Map();
// 卡片与左侧会话条共用一次磁盘读取；同 cwd 不各发一遍 IPC。
const sessionRailLoads = projectSessionLoads;
let sessionRailRevision = 0;
let sessionRailModel = null;
let sessionPreviewContext = null;
let projectKitOpening = null;
const sessionHandoffGate = createLatestRequestGate();
let sessionHandoffContext = null;
let sessionHandoffBusy = false;
let sessionHandoffContentDirty = false;
let sessionHandoffOperation = null;

function listLiveTerminals() {
  return [...sessions.entries()].map(([id, session]) => ({
    id,
    cwd: session.cwd,
    tool: session.tool,
    status: session.status,
    name: session.name,
    startedAt: session.startedAt,
  }));
}

function findProjectByCwd(cwd) {
  return projects.find(project => sameProjectCwd(project.localPath, cwd)) || null;
}

function cacheProjectSessionHistory(cwd, history) {
  const key = normalizeProjectMemoryCwd(cwd);
  if (!key) return;
  sessionRailHistoryByCwd.set(key, history);
  const project = findProjectByCwd(key);
  if (project) projectSessionCache.set(project.id, history);
}

async function loadProjectSessionHistory(cwd) {
  const history = await projectSessionHistoryLoader.load(cwd);
  cacheProjectSessionHistory(cwd, history);
  return history;
}

function invalidateProjectSessionHistory(cwd) {
  const key = projectSessionHistoryLoader.invalidate(cwd);
  if (!key) return '';
  sessionRailHistoryByCwd.delete(key);
  const project = findProjectByCwd(key);
  if (project) projectSessionCache.delete(project.id);
  return key;
}

function invalidateTerminalProjectSessionHistory(session) {
  if (!session || session.historyCacheInvalidated || session.status === 'failed') return '';
  const tool = cliToolName(session.tool);
  if (!tool || !isRailCliTool(tool) || !normalizeProjectMemoryCwd(session.cwd)) return '';
  session.historyCacheInvalidated = true;
  return invalidateProjectSessionHistory(session.cwd);
}

function reloadVisibleProjectSessionHistory(cwd) {
  const key = normalizeProjectMemoryCwd(cwd);
  if (!key) return;
  const project = findProjectByCwd(key);
  if (project && expandedProjectIds.has(project.id)) {
    const card = el.list?.querySelector(`.project-card[data-id="${project.id}"]`);
    if (card) void expandProjectSessions(project, card);
  }
  const visibleCwd = (activeSession && sessions.get(activeSession)?.cwd) || treeRoot || '';
  if (sameProjectCwd(visibleCwd, key)) void syncSessionRail(key);
}

function projectTabName(cwd, fallback = '') {
  return String(findProjectByCwd(cwd)?.name || fallback || '').trim();
}

function historySessionPayload(row) {
  return {
    tool: row?.dataset?.tool || '',
    id: row?.dataset?.sessionId || '',
    title: row?.querySelector('.card-session-title')?.textContent || '会话',
    runningId: row?.dataset?.runningId || '',
  };
}

function historySessionHtml(session, runningId) {
  const when = session.atMs ? relTimeFromMs(session.atMs) : '';
  const preview = String(session.preview || '').trim();
  const showPreview = preview && preview !== session.title;
  return `<div class="card-session-item${runningId ? ' is-running' : ''}" data-tool="${escAttr(session.tool)}" data-session-id="${escAttr(session.id)}"${runningId ? ` data-running-id="${escAttr(runningId)}"` : ''}>`
    + `<button class="card-session-open" type="button" title="${escAttr(session.title)}">`
    + `<span class="card-session-title-row">`
    + `<span class="card-session-title">${esc(session.title)}</span>`
    + (runningId ? '<span class="card-session-running">运行中</span>' : '')
    + (when ? `<span class="card-session-time">${esc(when)}</span>` : '')
    + `</span>`
    + (showPreview ? `<span class="card-session-preview-text">${esc(preview)}</span>` : '')
    + `</button>`
    + `<span class="card-session-actions">`
    + `<button class="card-session-icon card-session-preview-btn" type="button" title="预览" aria-label="预览">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`
    + `</button>`
    + `<button class="card-session-icon is-danger card-session-delete" type="button" title="删除" aria-label="删除">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 7h14M9.5 7V5.6A1.6 1.6 0 0111.1 4h1.8A1.6 1.6 0 0114.5 5.6V7m-6 0l.5 11.2A1.6 1.6 0 0010.6 20h2.8a1.6 1.6 0 001.6-1.8L15.5 7"/></svg>`
    + `</button>`
    + `</span>`
    + `</div>`;
}

function sessionToolbarHtml(query) {
  return `<div class="card-session-toolbar">`
    + `<label class="card-session-search-wrap">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 21l-5.2-5.2m0 0A7.2 7.2 0 105.2 5.2a7.2 7.2 0 0010.6 10.6z"/></svg>`
    + `<input class="card-session-search" type="search" placeholder="搜索标题、预览、工具" value="${escAttr(query)}" />`
    + `</label>`
    + `<button class="card-session-kit" type="button" title="同时打开 Claude、Codex、Grok 主从三窗">开一套</button>`
    + `<button class="card-session-orchestra" type="button" title="一个大脑拆活，多个终端动手">开协作</button>`
    + `</div>`;
}

function renderProjectSessions(card, history) {
  const root = card.querySelector('.card-sessions');
  if (!root) return;
  const projectId = card.dataset.id;
  const project = projects.find(item => item.id === projectId);
  const query = projectSessionQueries.get(projectId) || '';
  const searchEl = root.querySelector('.card-session-search');
  const keepFocus = document.activeElement === searchEl;
  const cursor = searchEl?.selectionStart ?? query.length;
  const groups = filterHistoryGroups(history?.groups, query);
  const lookup = runningHistoryLookup(listLiveTerminals(), history?.groups || [], project?.localPath || '');
  const emptyText = (history?.groups || []).length
    ? '没有匹配的会话'
    : '这个项目还没有历史会话';
  const body = groups.length
    ? groups.map(group => (
      `<div class="card-session-group">`
      + `<div class="card-session-group-head"><span class="term-tab-tool tool-${esc(group.tool)}">${esc(group.label)}</span><span class="card-session-count">${group.sessions.length}</span></div>`
      + group.sessions.map(session => historySessionHtml(session, runningTerminalIdForHistory(lookup, session.tool, session.id))).join('')
      + `</div>`
    )).join('')
    : `<div class="card-sessions-empty">${emptyText}</div>`;
  root.innerHTML = sessionToolbarHtml(query) + body;
  const nextSearch = root.querySelector('.card-session-search');
  if (keepFocus && nextSearch) {
    nextSearch.focus();
    const pos = Math.min(cursor, nextSearch.value.length);
    nextSearch.setSelectionRange(pos, pos);
  }
  nextSearch.oninput = () => {
    projectSessionQueries.set(projectId, nextSearch.value);
    renderProjectSessions(card, history);
  };
  root.querySelector('.card-session-kit').onclick = (event) => {
    event.stopPropagation();
    if (project) void openProjectKit(project);
  };
  root.querySelector('.card-session-orchestra').onclick = (event) => {
    event.stopPropagation();
    if (project) void openOrchestraModal(project);
  };
  root.querySelectorAll('.card-session-item').forEach(row => {
    const session = historySessionPayload(row);
    row.querySelector('.card-session-open').onclick = (event) => {
      event.stopPropagation();
      if (project) openHistorySession(project, session);
    };
    row.querySelector('.card-session-preview-btn').onclick = (event) => {
      event.stopPropagation();
      if (project) void previewHistorySession(project, session);
    };
    row.querySelector('.card-session-delete').onclick = (event) => {
      event.stopPropagation();
      if (project) deleteHistorySession(project, session);
    };
  });
}

async function expandProjectSessions(project, card) {
  const toggle = card.querySelector('.card-session-toggle');
  const panel = card.querySelector('.card-sessions');
  if (!toggle || !panel) return;
  expandedProjectIds.add(project.id);
  card.classList.add('is-expanded');
  toggle.setAttribute('aria-expanded', 'true');
  panel.hidden = false;
  const cached = projectSessionCache.get(project.id);
  if (cached) {
    renderProjectSessions(card, cached);
    return;
  }
  panel.innerHTML = sessionToolbarHtml(projectSessionQueries.get(project.id) || '')
    + '<div class="card-sessions-empty">加载历史会话…</div>';
  panel.querySelector('.card-session-kit').onclick = (event) => {
    event.stopPropagation();
    void openProjectKit(project);
  };
  panel.querySelector('.card-session-orchestra').onclick = (event) => {
    event.stopPropagation();
    void openOrchestraModal(project);
  };
  if (!project.localPath) {
    renderProjectSessions(card, { groups: [] });
    return;
  }
  try {
    const history = await loadProjectSessionHistory(project.localPath);
    if (sameProjectCwd(treeRoot, project.localPath)) refreshSessionRailView();
    if (!expandedProjectIds.has(project.id) || card.dataset.id !== project.id) return;
    renderProjectSessions(card, history);
  } catch (error) {
    if (!expandedProjectIds.has(project.id)) return;
    panel.innerHTML = sessionToolbarHtml(projectSessionQueries.get(project.id) || '')
      + `<div class="card-sessions-empty">加载失败：${esc(error?.message || error)}</div>`;
    panel.querySelector('.card-session-kit').onclick = (event) => {
      event.stopPropagation();
      void openProjectKit(project);
    };
    panel.querySelector('.card-session-orchestra').onclick = (event) => {
      event.stopPropagation();
      void openOrchestraModal(project);
    };
  }
}

function collapseProjectSessions(project, card) {
  expandedProjectIds.delete(project.id);
  card.classList.remove('is-expanded');
  const toggle = card.querySelector('.card-session-toggle');
  const panel = card.querySelector('.card-sessions');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (panel) panel.hidden = true;
}

function toggleProjectSessions(project, card) {
  if (expandedProjectIds.has(project.id)) collapseProjectSessions(project, card);
  else void expandProjectSessions(project, card);
}

function openHistorySession(project, session) {
  if (session.runningId && sessions.has(session.runningId)) {
    activateSession(session.runningId);
    return;
  }
  const autoCmd = resumeCliCommand(session.tool, session.id);
  if (!autoCmd) {
    msg('还不支持续接这个工具的历史会话', 'info');
    return;
  }
  recordProjectActivity(project.id, autoCmd);
  void createSession({ cwd: project.localPath, name: project.name, autoCmd });
}

function closeSessionPreview() {
  sessionPreviewContext = null;
  el.sessionPreview?.classList.remove('active');
}

function resumePreviewedSession() {
  const context = sessionPreviewContext;
  closeSessionPreview();
  if (context?.project && context.session) openHistorySession(context.project, context.session);
}

async function previewHistorySession(project, session) {
  if (!project.localPath) {
    msg('这个项目没有本地路径', 'info');
    return;
  }
  try {
    const preview = await invoke('preview_project_session', {
      path: project.localPath,
      tool: session.tool,
      id: session.id,
    });
    sessionPreviewContext = { project, session: { ...session, title: preview.title || session.title } };
    el.sessionPreviewTitle.textContent = preview.title || session.title || '会话预览';
    const when = preview.atMs ? relTimeFromMs(preview.atMs) : '';
    el.sessionPreviewMeta.innerHTML = `<span class="term-tab-tool tool-${esc(session.tool)}">${esc(session.tool)}</span>`
      + (when ? `<span>${esc(when)}</span>` : '');
    el.sessionPreviewBody.textContent = preview.body || preview.title || '这条会话没有可预览的正文';
    el.sessionPreviewOpen.textContent = session.runningId ? '回到终端' : '续接';
    el.sessionPreview.classList.add('active');
  } catch (error) {
    msg('预览失败：' + (error?.message || error), 'error');
  }
}

function deleteHistorySession(project, session) {
  const runningHint = session.runningId
    ? '\n对应终端仍在运行，删的是磁盘记录，不会关掉终端。'
    : '';
  showConfirm({
    title: '删除历史会话',
    message: `确定删除 ${session.tool} 的「${session.title}」吗？这会从该工具的本地记录里移除，不可恢复。${runningHint}`,
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      try {
        await invoke('delete_project_session', {
          path: project.localPath,
          tool: session.tool,
          id: session.id,
        });
        invalidateProjectSessionHistory(project.localPath);
        const card = el.list.querySelector(`.project-card[data-id="${project.id}"]`);
        if (card && expandedProjectIds.has(project.id)) await expandProjectSessions(project, card);
        else if (sameProjectCwd(treeRoot, project.localPath)) void syncSessionRail(project.localPath);
        msg('已删除历史会话', 'success');
      } catch (error) {
        msg('删除失败：' + (error?.message || error), 'error');
      }
    },
  });
}

function refreshExpandedHistoryCards() {
  el.list?.querySelectorAll('.project-card.is-expanded').forEach(card => {
    const cached = projectSessionCache.get(card.dataset.id);
    if (cached) renderProjectSessions(card, cached);
  });
  refreshSessionRailView();
}

function applyProjectKitLayout(sessionIds) {
  const ids = sessionIds.filter(id => sessions.has(id));
  if (!ids.length) return;
  const layout = ids.length >= 4 ? 'grid' : PROJECT_KIT_LAYOUT;
  terminalPaneLayout = layout;
  terminalPaneAssignments = reconcileTerminalPanes({
    assignments: ids,
    sessionIds: [...sessions.keys()],
    activeSessionId: ids[0],
    layout,
    fill: false,
  });
  activeSession = ids[0];
  const active = sessions.get(activeSession);
  if (active && active.cwd !== treeRoot) renderTree(active.cwd);
  renderTerminalPaneLayout();
  persistSessionLayout();
  if (active) {
    requestAnimationFrame(() => {
      fitSession(activeSession);
      active.term.focus();
    });
  }
}

async function fetchProjectSessions(project) {
  if (!project?.localPath) return { groups: [] };
  const cached = projectSessionCache.get(project.id) || getSessionRailHistory(project.localPath);
  if (cached) {
    projectSessionCache.set(project.id, cached);
    return cached;
  }
  const history = await loadProjectSessionHistory(project.localPath);
  if (sameProjectCwd(treeRoot, project.localPath)) refreshSessionRailView();
  return history;
}

function normalizeProjectTools(tools) {
  const allowed = new Set(CLI_TOOL_IDS);
  const seen = new Set();
  const normalized = [];
  for (const value of Array.isArray(tools) ? tools : []) {
    const tool = cliToolName(value);
    if (!allowed.has(tool) || seen.has(tool)) continue;
    seen.add(tool);
    normalized.push(tool);
  }
  return normalized;
}

function beginProjectToolOpening() {
  if (projectKitOpening) return null;
  const token = Symbol('project-tool-opening');
  projectKitOpening = token;
  return token;
}

function releaseProjectToolOpening(token) {
  if (projectKitOpening === token) projectKitOpening = null;
}

async function launchProjectTools(project, selectedTools, { forceNew = false, createdIds = [] } = {}) {
  let history = { groups: [] };
  if (!forceNew) {
    try {
      history = await fetchProjectSessions(project);
    } catch (_) {
      history = { groups: [] };
    }
  }
  const readyIds = [];
  for (const tool of selectedTools) {
    if (!forceNew) {
      const existing = findRunningProjectTool(listLiveTerminals(), project.localPath, tool);
      if (existing) {
        readyIds.push(existing.id);
        continue;
      }
    }
    const launch = forceNew ? { autoCmd: tool } : launchCommandForProjectTool(tool, history.groups);
    const autoCmd = launch.autoCmd || tool;
    const id = await createProjectToolSession(project, autoCmd);
    createdIds.push(id);
    const created = sessions.get(id);
    if (created && created.status !== 'failed' && created.status !== 'exited') readyIds.push(id);
  }
  return readyIds;
}

async function createProjectToolSession(project, autoCmd) {
  recordProjectActivity(project.id, autoCmd);
  return createSession({ cwd: project.localPath, name: project.name, autoCmd });
}

async function openProjectTools(project, tools, { forceNew = false } = {}) {
  if (!project?.localPath) {
    msg('这个项目没有本地路径', 'info');
    return [];
  }
  const selectedTools = normalizeProjectTools(tools);
  if (!selectedTools.length) {
    msg('没有可打开的终端', 'error');
    return [];
  }
  const openingToken = beginProjectToolOpening();
  if (!openingToken) return [];
  try {
    const ids = await launchProjectTools(project, selectedTools, { forceNew });
    applyProjectKitLayout(ids);
    refreshExpandedHistoryCards();
    if (!ids.length) msg('没有成功打开的终端', 'error');
    return ids;
  } catch (error) {
    msg('打开终端失败：' + (error?.message || error), 'error');
    return [];
  } finally {
    releaseProjectToolOpening(openingToken);
  }
}

async function openProjectKit(project, { forceNew = false } = {}) {
  const ids = await openProjectTools(project, DEFAULT_PROJECT_KIT, { forceNew });
  if (ids.length && !forceNew) msg('已打开 Claude + Codex + Grok 主从三窗', 'success');
  return ids;
}

function activeSessionHandoffContext() {
  const id = activeSession;
  const session = id ? sessions.get(id) : null;
  const running = session?.status === 'running'
    && !sessionCloseCoordinator.isClosing(id);
  const sourceTool = running ? cliToolName(session.tool) : '';
  const project = running ? findProjectByCwd(session.cwd) : null;
  return { id, session, running, sourceTool, project };
}

function sessionHandoffTargets(sourceTool) {
  return handoffTargetTools(installedCliIds, sourceTool);
}

function syncSessionHandoffButton() {
  if (!termEl?.handoffBtn) return;
  const current = activeSessionHandoffContext();
  const availability = sessionHandoffAvailability({
    running: current.running,
    sourceTool: current.sourceTool,
    hasProject: Boolean(current.project),
    busy: sessionHandoffBusy,
  });
  termEl.handoffBtn.disabled = !availability.enabled;
  termEl.handoffBtn.classList.toggle('is-ready', availability.enabled);
  termEl.handoffBtn.title = availability.title;
  if (el.sessionHandoff?.classList.contains('active')) {
    const sameSource = sessionHandoffContext
      && sessionHandoffContext.sourceSessionId === current.id
      && sessionHandoffContext.sourceTool === current.sourceTool
      && sessionHandoffContext.project.id === current.project?.id;
    if (!sameSource && !sessionHandoffBusy) closeSessionHandoff(false);
  }
}

function selectedSessionHandoffTarget() {
  return el.sessionHandoffTargets
    ?.querySelector('input[name="session-handoff-target"]:checked')?.value || '';
}

function setSessionHandoffBusy(busy) {
  sessionHandoffBusy = Boolean(busy);
  if (el.sessionHandoffContent) el.sessionHandoffContent.disabled = sessionHandoffBusy;
  if (el.sessionHandoffClose) el.sessionHandoffClose.disabled = sessionHandoffBusy;
  if (el.sessionHandoffCancel) el.sessionHandoffCancel.disabled = sessionHandoffBusy;
  el.sessionHandoffTargets?.querySelectorAll('input').forEach(input => {
    input.disabled = sessionHandoffBusy;
  });
  if (el.sessionHandoffStart) {
    el.sessionHandoffStart.disabled = sessionHandoffBusy
      || !sessionHandoffContext?.preview
      || !el.sessionHandoffContent.value.trim();
    if (sessionHandoffBusy) {
      el.sessionHandoffStart.textContent = '正在交接…';
    } else if (sessionHandoffContext) {
      const target = sessionHandoffContext.targetTool;
      const label = CLI_TOOLS.find(tool => tool.id === target)?.label || target;
      el.sessionHandoffStart.textContent = `交给 ${label}`;
      syncSessionHandoffDraftState();
    }
  }
  syncSessionHandoffButton();
}

function syncSessionHandoffDraftState() {
  const validation = validateSessionHandoffContent(el.sessionHandoffContent?.value || '');
  const count = sessionHandoffContext?.preview?.messages?.length || 0;
  if (el.sessionHandoffStatus) {
    el.sessionHandoffStatus.textContent = validation.error
      || `${count} 条最近对话 · ${validation.bytes}/${SESSION_HANDOFF_FILE_MAX_BYTES} 字节`;
    el.sessionHandoffStatus.classList.toggle('is-error', !validation.valid);
  }
  if (!sessionHandoffBusy && el.sessionHandoffStart) {
    el.sessionHandoffStart.disabled = !sessionHandoffContext?.preview || !validation.valid;
  }
  return validation;
}

function sessionHandoffTargetPickHtml(tool, selected) {
  return `<label class="orchestra-pick">`
    + `<input type="radio" name="session-handoff-target" value="${escAttr(tool.id)}"${tool.id === selected ? ' checked' : ''} />`
    + `<span class="term-tab-tool tool-${escAttr(tool.id)}">${esc(tool.id)}</span>`
    + `<span>${esc(tool.label)}</span>`
    + `</label>`;
}

function rebuildSessionHandoffContent() {
  if (!sessionHandoffContext?.preview || !sessionHandoffContext?.workspace) return;
  const targetTool = sessionHandoffContext.targetTool;
  const previousTarget = sessionHandoffContext.previousTargetTool;
  if (sessionHandoffContentDirty && previousTarget && previousTarget !== targetTool) {
    const previousLabel = CLI_TOOLS.find(tool => tool.id === previousTarget)?.label || previousTarget;
    const nextLabel = CLI_TOOLS.find(tool => tool.id === targetTool)?.label || targetTool;
    el.sessionHandoffContent.value = el.sessionHandoffContent.value.replace(
      new RegExp(`^- 接手：${previousLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `- 接手：${nextLabel}`,
    );
  } else {
    el.sessionHandoffContent.value = buildSessionHandoffMarkdown({
      project: sessionHandoffContext.project,
      sourceTool: sessionHandoffContext.sourceTool,
      targetTool,
      preview: sessionHandoffContext.preview,
      context: sessionHandoffContext.workspace,
    });
    sessionHandoffContentDirty = false;
  }
  sessionHandoffContext.previousTargetTool = targetTool;
  const targetLabel = CLI_TOOLS.find(tool => tool.id === targetTool)?.label || targetTool;
  el.sessionHandoffStart.textContent = `交给 ${targetLabel}`;
  syncSessionHandoffDraftState();
}

function renderSessionHandoffTargets(targets, selected) {
  el.sessionHandoffTargets.innerHTML = targets
    .map(tool => sessionHandoffTargetPickHtml(tool, selected))
    .join('');
  el.sessionHandoffTargets.querySelectorAll('input').forEach(input => {
    input.onchange = () => {
      if (!input.checked || !sessionHandoffContext) return;
      sessionHandoffContext.targetTool = input.value;
      rebuildSessionHandoffContent();
    };
  });
}

function closeSessionHandoff(restoreButtonFocus = true, { force = false } = {}) {
  if (sessionHandoffBusy && !force) return false;
  const wasOpen = el.sessionHandoff?.classList.contains('active');
  sessionHandoffGate.invalidate();
  setSessionHandoffBusy(false);
  sessionHandoffOperation = null;
  sessionHandoffContext = null;
  sessionHandoffBusy = false;
  sessionHandoffContentDirty = false;
  el.sessionHandoff?.classList.remove('active');
  termEl?.handoffBtn?.classList.remove('active');
  termEl?.handoffBtn?.setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreButtonFocus) requestAnimationFrame(() => termEl.handoffBtn?.focus());
  syncSessionHandoffButton();
  return true;
}

async function openSessionHandoff() {
  const initial = activeSessionHandoffContext();
  if (!initial.project || !CLI_TOOL_IDS.includes(initial.sourceTool)) {
    msg('请先切到已登记项目的运行中 CLI 终端', 'info');
    return;
  }
  const request = sessionHandoffGate.begin();
  closeProjectIdeas(false);
  closeSnippetMenu();
  closeMemoryMenu();
  closeThemeMenu();
  closeTerminalLayoutMenu();
  closeFontMenu();
  await refreshInstalledClis({ force: true });
  if (!sessionHandoffGate.isCurrent(request)) return;
  const current = activeSessionHandoffContext();
  if (current.id !== initial.id
    || current.sourceTool !== initial.sourceTool
    || current.project?.id !== initial.project.id) return;
  const targets = sessionHandoffTargets(current.sourceTool);
  if (!targets.length) {
    msg('没有检测到可接手的其他 CLI', 'info');
    return;
  }
  const targetTool = targets[0].id;
  sessionHandoffContext = {
    sourceSessionId: current.id,
    sourceTool: current.sourceTool,
    project: current.project,
    targetTool,
    previousTargetTool: targetTool,
    preview: null,
    workspace: null,
  };
  sessionHandoffContentDirty = false;
  renderSessionHandoffTargets(targets, targetTool);
  const sourceLabel = CLI_TOOLS.find(tool => tool.id === current.sourceTool)?.label || current.sourceTool;
  el.sessionHandoffSource.textContent = `正在读取 ${sourceLabel} 最新会话…`;
  el.sessionHandoffSource.classList.remove('is-error');
  el.sessionHandoffStatus.textContent = '准备中';
  el.sessionHandoffStatus.classList.remove('is-error');
  el.sessionHandoffContent.value = '';
  el.sessionHandoffContent.disabled = true;
  el.sessionHandoffStart.disabled = true;
  el.sessionHandoffStart.textContent = `交给 ${CLI_TOOLS.find(tool => tool.id === targetTool)?.label || targetTool}`;
  el.sessionHandoff.classList.add('active');
  termEl.handoffBtn.classList.add('active');
  termEl.handoffBtn.setAttribute('aria-expanded', 'true');

  try {
    invalidateProjectSessionHistory(current.project.localPath);
    const [history, workspace] = await Promise.all([
      loadProjectSessionHistory(current.project.localPath),
      invoke('project_context', { path: current.project.localPath }),
    ]);
    if (!sessionHandoffGate.isCurrent(request)) return;
    const latest = latestHandoffSession(history.groups, current.sourceTool);
    if (!latest) throw new Error(`没有找到这个项目的 ${sourceLabel} 历史会话`);
    const preview = await invoke('preview_session_handoff', {
      path: current.project.localPath,
      sourceTool: current.sourceTool,
      id: latest.id,
    });
    if (!sessionHandoffGate.isCurrent(request)) return;
    sessionHandoffContext.preview = preview;
    sessionHandoffContext.workspace = workspace;
    const at = preview.sourceAtMs ? new Date(preview.sourceAtMs).toLocaleString('zh-CN', { hour12: false }) : '';
    el.sessionHandoffSource.textContent = `${sourceLabel} 最新磁盘会话 · ${preview.sourceTitle || latest.title}${at ? ` · ${at}` : ''}`;
    el.sessionHandoffStatus.textContent = `${preview.messages?.length || 0} 条最近对话，可编辑`;
    el.sessionHandoffStatus.classList.remove('is-error');
    el.sessionHandoffContent.disabled = false;
    rebuildSessionHandoffContent();
    el.sessionHandoffContent.focus();
    el.sessionHandoffContent.setSelectionRange(0, 0);
  } catch (error) {
    if (!sessionHandoffGate.isCurrent(request)) return;
    el.sessionHandoffSource.textContent = error?.message || String(error);
    el.sessionHandoffSource.classList.add('is-error');
    el.sessionHandoffStatus.textContent = '读取失败';
    el.sessionHandoffStart.disabled = true;
  }
}

async function startSessionHandoff() {
  const context = sessionHandoffContext;
  const current = activeSessionHandoffContext();
  const targetTool = selectedSessionHandoffTarget();
  const content = el.sessionHandoffContent.value.trim();
  if (!context || sessionHandoffBusy || !context.preview) return;
  if (current.id !== context.sourceSessionId
    || current.sourceTool !== context.sourceTool
    || current.project?.id !== context.project.id) {
    msg('来源终端已变化，请重新打开交接', 'error');
    closeSessionHandoff();
    return;
  }
  if (!sessionHandoffTargets(context.sourceTool).some(tool => tool.id === targetTool)) {
    msg('目标 CLI 当前不可用', 'error');
    return;
  }
  const validation = validateSessionHandoffContent(content);
  if (!validation.valid) {
    msg(validation.error, 'info');
    syncSessionHandoffDraftState();
    el.sessionHandoffContent.focus();
    return;
  }
  const openingToken = beginProjectToolOpening();
  if (!openingToken) {
    msg('正在打开另一组终端，请稍后再试', 'info');
    return;
  }
  const operation = Object.freeze({ context, openingToken });
  sessionHandoffOperation = operation;
  setSessionHandoffBusy(true);
  const terminalState = captureTerminalPaneState();
  let createdId = '';
  try {
    const handoff = await invoke('write_session_handoff', {
      path: context.project.localPath,
      content,
    });
    if (sessionHandoffOperation !== operation) throw new Error('交接任务已失效');
    createdId = await createProjectToolSession(context.project, targetTool);
    if (sessionHandoffOperation !== operation) throw new Error('交接任务已失效');
    const created = sessions.get(createdId);
    if (!created
      || created.status === 'failed'
      || created.status === 'exited'
      || cliToolName(created.tool) !== targetTool
      || !sameProjectCwd(created.cwd, context.project.localPath)) {
      throw new Error('目标终端启动失败');
    }
    const prompt = handoffLaunchPrompt(
      handoff.relativePath,
      context.sourceTool,
      targetTool,
    );
    if (!await injectToSession(createdId, prompt)) throw new Error('交接提示写入失败');
    const targetLabel = CLI_TOOLS.find(tool => tool.id === targetTool)?.label || targetTool;
    closeSessionHandoff(false, { force: true });
    activateSession(createdId);
    invalidateProjectSessionHistory(context.project.localPath);
    reloadVisibleProjectSessionHistory(context.project.localPath);
    const sourceLabel = CLI_TOOLS.find(tool => tool.id === context.sourceTool)?.label || context.sourceTool;
    msg(`已交给 ${targetLabel}，${sourceLabel} 原会话仍保留`, 'success');
  } catch (error) {
    let rollbackError = '';
    if (createdId) {
      try {
        await rollbackCreatedSessions([createdId], terminalState);
      } catch (rollback) {
        rollbackError = `；终端清理失败：${rollback?.message || rollback}`;
      }
    }
    msg(`交接失败：${error?.message || error}${rollbackError}`, 'error');
  } finally {
    releaseProjectToolOpening(openingToken);
    if (sessionHandoffOperation === operation) {
      sessionHandoffOperation = null;
      if (sessionHandoffContext === context) setSessionHandoffBusy(false);
    }
  }
}

let orchestraProject = null;
let activeOrchestra = null;
let orchestraSending = false;
let orchestraDraftConfig = null;
const orchestraModalGate = createLatestRequestGate();
const ORCHESTRA_CONFIG_STORAGE_KEY = 'orchestra-config-v1';

function orchestraInstalledKit() {
  return installedCliTools(installedCliIds).map(tool => tool.id);
}

function readOrchestraConfig(kit) {
  if (!kit.length) return { brain: '', workers: [], kit: [] };
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(ORCHESTRA_CONFIG_STORAGE_KEY) || 'null');
  } catch (_) {}
  const savedWorkers = Array.isArray(saved?.workers) ? saved.workers : undefined;
  const normalized = normalizeOrchestraConfig({
    brain: saved?.brain,
    workers: savedWorkers,
    kit,
  });
  return savedWorkers?.length && !normalized.workers.length
    ? normalizeOrchestraConfig({ brain: normalized.brain, kit })
    : normalized;
}

function saveOrchestraConfig(config) {
  try {
    localStorage.setItem(ORCHESTRA_CONFIG_STORAGE_KEY, JSON.stringify({
      version: 1,
      brain: config.brain,
      workers: config.workers,
    }));
  } catch (_) {}
}

function selectedOrchestraBrain() {
  return document.querySelector('input[name="orchestra-brain"]:checked')?.value || DEFAULT_ORCHESTRA_BRAIN;
}

function selectedOrchestraWorkers() {
  return [...document.querySelectorAll('input[name="orchestra-worker"]:checked')]
    .map(input => input.value);
}

function syncOrchestraWorkersHint(config = orchestraDraftConfig) {
  if (!el.orchestraWorkersHint) return;
  const workers = config?.workers || [];
  el.orchestraWorkersHint.classList.toggle('is-empty', workers.length === 0);
  el.orchestraWorkersHint.textContent = workers.length
    ? `已选 ${workers.length} 个：${workers.map(orchestraToolLabel).join(' · ')}`
    : '至少选择 1 个终端';
}

function orchestraPickHtml(tool, role, config) {
  const isBrain = tool.id === config.brain;
  const disabled = role === 'worker' && isBrain;
  const checked = role === 'brain' ? isBrain : config.workers.includes(tool.id);
  const name = role === 'brain' ? 'orchestra-brain' : 'orchestra-worker';
  const type = role === 'brain' ? 'radio' : 'checkbox';
  const reason = isBrain && role === 'worker' ? '已选为大脑' : '';
  return `<label class="orchestra-pick${disabled ? ' is-disabled' : ''}"${reason ? ` title="${escAttr(reason)}"` : ''}>`
    + `<input type="${type}" name="${name}" value="${escAttr(tool.id)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''} />`
    + `<span>${esc(tool.label)}</span>`
    + `</label>`;
}

function renderOrchestraPicks(config) {
  orchestraDraftConfig = config;
  const availableTools = installedCliTools(config.kit);
  const empty = '<span class="orchestra-tools-empty">未检测到已安装的 CLI</span>';
  if (el.orchestraBrainPicks) {
    el.orchestraBrainPicks.innerHTML = availableTools.length
      ? availableTools.map(tool => orchestraPickHtml(tool, 'brain', config)).join('')
      : empty;
    el.orchestraBrainPicks.querySelectorAll('input:not(:disabled)').forEach(input => {
      input.onchange = () => {
        const previousBrain = orchestraDraftConfig.brain;
        const nextBrain = input.value;
        const selected = new Set(orchestraDraftConfig.workers);
        selected.delete(nextBrain);
        if (previousBrain && previousBrain !== nextBrain && orchestraDraftConfig.kit.includes(previousBrain)) {
          selected.add(previousBrain);
        }
        renderOrchestraPicks(normalizeOrchestraConfig({
          brain: nextBrain,
          workers: orchestraDraftConfig.kit.filter(tool => selected.has(tool)),
          kit: orchestraDraftConfig.kit,
        }));
      };
    });
  }
  if (el.orchestraWorkerPicks) {
    el.orchestraWorkerPicks.innerHTML = availableTools.length
      ? availableTools.map(tool => orchestraPickHtml(tool, 'worker', config)).join('')
      : empty;
    el.orchestraWorkerPicks.querySelectorAll('input:not(:disabled)').forEach(input => {
      input.onchange = () => {
        orchestraDraftConfig = normalizeOrchestraConfig({
          brain: selectedOrchestraBrain(),
          workers: selectedOrchestraWorkers(),
          kit: orchestraDraftConfig.kit,
        });
        syncOrchestraWorkersHint();
      };
    });
  }
  syncOrchestraWorkersHint(config);
}

async function openOrchestraModal(project) {
  const request = orchestraModalGate.begin();
  orchestraProject = null;
  el.orchestra?.classList.remove('active');
  if (!project?.localPath) {
    msg('这个项目没有本地路径', 'info');
    return;
  }
  await refreshInstalledClis({ force: true });
  if (!orchestraModalGate.isCurrent(request)) return;
  orchestraProject = project;
  if (el.orchestraGoal && !el.orchestraGoal.value.trim()) el.orchestraGoal.value = '';
  renderOrchestraPicks(readOrchestraConfig(orchestraInstalledKit()));
  el.orchestra.classList.add('active');
  el.orchestraGoal?.focus();
}

function closeOrchestraModal() {
  orchestraModalGate.invalidate();
  orchestraProject = null;
  el.orchestra?.classList.remove('active');
}

let currentProxySettings = { enabled: false, url: '', noProxy: DEFAULT_NO_PROXY };

function paintProxyIndicator(settings) {
  currentProxySettings = normalizeProxySettings(settings);
  if (el.proxyDot) el.proxyDot.dataset.on = currentProxySettings.enabled ? '1' : '0';
  if (el.proxyEntry) {
    el.proxyEntry.title = currentProxySettings.enabled
      ? `代理已开：新启动的 CLI 走 ${redactProxyUrl(currentProxySettings.url)}`
      : '代理已关：新启动的 CLI 不走应用代理';
  }
}

async function refreshProxyIndicator() {
  try {
    paintProxyIndicator(await invoke('get_proxy_settings'));
  } catch (_) {
    paintProxyIndicator({ enabled: false, url: '', noProxy: DEFAULT_NO_PROXY });
  }
}

async function openProxyModal() {
  await refreshProxyIndicator();
  el.proxyEnabled.checked = currentProxySettings.enabled;
  el.proxyUrl.value = currentProxySettings.url || '';
  el.proxyNoProxy.value = currentProxySettings.noProxy || DEFAULT_NO_PROXY;
  el.proxyOverlay.classList.add('active');
  el.proxyUrl.focus();
}

function closeProxyModal() {
  el.proxyOverlay?.classList.remove('active');
}

async function saveProxyModal() {
  const enabled = Boolean(el.proxyEnabled.checked);
  const url = String(el.proxyUrl.value || '').trim();
  if (enabled && !isValidProxyUrl(url)) {
    msg('代理地址不对，例如 127.0.0.1:7890 或 socks5://127.0.0.1:7891', 'error');
    el.proxyUrl.focus();
    return;
  }
  try {
    const saved = await invoke('save_proxy_settings', {
      settings: {
        enabled,
        url,
        noProxy: el.proxyNoProxy.value,
      },
    });
    paintProxyIndicator(saved);
    closeProxyModal();
    msg(saved.enabled ? '代理已开，新启动的 CLI 会走代理' : '代理已关', 'success');
  } catch (error) {
    msg('保存代理失败：' + (error?.message || error), 'error');
  }
}

function syncOrchestraChrome() {
  const bar = termEl.orchestraBar;
  if (!bar) return;
  const active = Boolean(activeOrchestra);
  bar.hidden = !active;
  bar.classList.toggle('active', active);
  sessions.forEach((session, id) => {
    const tool = cliToolName(session.tool);
    const isBoundSession = active && tool && activeOrchestra.sessionIds?.[tool] === id;
    const role = isBoundSession ? orchestraRoleForTool(activeOrchestra, tool) : '';
    let badge = session.paneHeadEl?.querySelector('.term-pane-role');
    if (!role) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'term-pane-role';
      session.paneHeadEl?.querySelector('.term-pane-name')?.after(badge);
    }
    badge.dataset.role = role;
    badge.textContent = orchestraRoleLabel(role);
  });
  if (!active || !termEl.orchestraRoles) return;
  const chips = [
    { tool: activeOrchestra.brain, role: 'brain' },
    ...activeOrchestra.workers.map(tool => ({ tool, role: 'worker' })),
  ];
  termEl.orchestraRoles.innerHTML = chips.map(item => (
    `<span class="orchestra-chip" data-role="${escAttr(item.role)}">`
    + `<small>${esc(orchestraRoleLabel(item.role))}</small>${esc(orchestraToolLabel(item.tool))}`
    + `</span>`
  )).join('');
}

function closeOrchestra() {
  activeOrchestra = null;
  syncOrchestraChrome();
}

function detachOrchestraSession(id, session) {
  if (!activeOrchestra) return;
  const tool = cliToolName(session?.tool);
  if (!tool || activeOrchestra.sessionIds?.[tool] !== id) return;
  delete activeOrchestra.sessionIds[tool];
  if (tool === activeOrchestra.brain) {
    closeOrchestra();
    return;
  }
  activeOrchestra.workers = activeOrchestra.workers.filter(worker => worker !== tool);
  if (!activeOrchestra.workers.length) closeOrchestra();
  else syncOrchestraChrome();
}

async function waitForCliPrompt(session) {
  const elapsed = Date.now() - (session?.startedAt || 0);
  const wait = Math.max(0, 3200 - elapsed);
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
}

async function injectToSession(id, text, send = true) {
  const session = sessions.get(id);
  if (!session || session.status === 'failed' || session.status === 'exited') return false;
  const data = send ? String(text || '').replace(/[\r\n]+$/, '') + '\r' : String(text || '');
  if (!data.trim()) return false;
  await waitForCliPrompt(session);
  if (sessions.get(id) !== session || session.status === 'failed' || session.status === 'exited') return false;
  if (session.inputBuffer) session.inputBuffer.write(data);
  else await invoke('terminal_write', { id, data });
  return true;
}

function orchestraSessionId(tool) {
  const id = activeOrchestra?.sessionIds?.[tool] || '';
  const session = id ? sessions.get(id) : null;
  return session && session.status !== 'failed' && session.status !== 'exited' ? id : '';
}

async function sendOrchestra(target) {
  if (!activeOrchestra || orchestraSending) return;
  const text = termEl.orchestraInput?.value || '';
  const goal = activeOrchestra.goal || text;
  orchestraSending = true;
  try {
    if (target === 'brain' || target === 'broadcast') {
      const id = orchestraSessionId(activeOrchestra.brain);
      const prompt = target === 'broadcast' && text.trim()
        ? orchestraBroadcastPrompt({ role: 'brain', tool: activeOrchestra.brain, text })
        : orchestraBrainPrompt({ goal: text.trim() || goal, workers: activeOrchestra.workers });
      if (!id || !(await injectToSession(id, prompt))) {
        msg('大脑那个终端还没准备好', 'error');
        return;
      }
      activateSession(id);
    }
    if (target === 'workers' || target === 'broadcast') {
      let plan = '';
      try {
        plan = await invoke('read_orchestra_file', {
          path: activeOrchestra.projectPath,
          name: ORCHESTRA_PLAN_FILE,
        });
      } catch (_) {}
      let sent = 0;
      for (const tool of activeOrchestra.workers) {
        const id = orchestraSessionId(tool);
        const prompt = text.trim() && target === 'broadcast'
          ? orchestraBroadcastPrompt({ role: 'worker', tool, text })
          : orchestraWorkerPrompt({
            tool,
            brain: activeOrchestra.brain,
            goal: text.trim() || goal,
            plan,
            extra: text.trim(),
            inboxFile: `.vibe/orchestra/${orchestraInboxFile(tool)}`,
          });
        if (id && await injectToSession(id, prompt)) sent += 1;
      }
      if (!sent) {
        msg('干活的终端还没准备好', 'error');
        return;
      }
    }
    if (termEl.orchestraInput) termEl.orchestraInput.value = '';
    msg(
      target === 'brain'
        ? '已发给大脑'
        : target === 'workers'
          ? '已派给干活的人'
          : `已广播到 ${activeOrchestra.workers.length + 1} 个协作终端`,
      'success',
    );
  } catch (error) {
    msg('发送失败：' + (error?.message || error), 'error');
  } finally {
    orchestraSending = false;
  }
}

function captureTerminalPaneState() {
  return {
    layout: terminalPaneLayout,
    assignments: [...terminalPaneAssignments],
    activeSessionId: activeSession,
  };
}

function restoreTerminalPaneState(snapshot) {
  if (!snapshot) return;
  terminalPaneLayout = snapshot.layout;
  terminalPaneAssignments = snapshot.assignments.map(id => (id && sessions.has(id) ? id : null));
  activeSession = snapshot.activeSessionId && sessions.has(snapshot.activeSessionId)
    ? snapshot.activeSessionId
    : (visibleTerminalSessionIds(terminalPaneAssignments)[0] || null);
  const active = activeSession ? sessions.get(activeSession) : null;
  if (active && active.cwd !== treeRoot) renderTree(active.cwd);
  else refreshSessionRailView();
  renderTerminalPaneLayout();
  persistSessionLayout();
  if (active) requestAnimationFrame(() => active.term.focus());
}

async function closeCreatedSessions(createdIds) {
  const ids = [...new Set(createdIds)].filter(id => sessions.has(id));
  const outcomes = await Promise.allSettled(ids.map(async id => ({ id, closed: await closeSession(id) })));
  const remaining = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'rejected') return sessions.has(ids[index]) ? [ids[index]] : [];
    return !outcome.value.closed && sessions.has(outcome.value.id) ? [outcome.value.id] : [];
  });
  if (remaining.length) throw new Error(`部分终端清理失败：${remaining.join('、')}`);
}

async function rollbackCreatedSessions(createdIds, terminalState) {
  try {
    await closeCreatedSessions(createdIds);
  } finally {
    restoreTerminalPaneState(terminalState);
  }
}

async function restoreOrchestraFiles(projectPath, previous) {
  return restoreOrchestraFileSnapshot({
    snapshot: previous,
    goalFile: ORCHESTRA_GOAL_FILE,
    planFile: ORCHESTRA_PLAN_FILE,
    write: (name, content) => invoke('write_orchestra_file', {
      path: projectPath,
      name,
      content,
    }),
  });
}

async function commitOrchestraFiles(projectPath, goal) {
  return commitOrchestraFilesTransaction({
    goalFile: ORCHESTRA_GOAL_FILE,
    planFile: ORCHESTRA_PLAN_FILE,
    goalContent: `# 目标\n\n${goal}\n`,
    read: name => invoke('read_orchestra_file', { path: projectPath, name }),
    write: (name, content) => invoke('write_orchestra_file', {
      path: projectPath,
      name,
      content,
    }),
  });
}

function isReadyOrchestraSession(id, tool, projectPath) {
  const session = sessions.get(id);
  return Boolean(
    session
    && session.status !== 'failed'
    && session.status !== 'exited'
    && cliToolName(session.tool) === tool
    && sameProjectCwd(session.cwd, projectPath),
  );
}

async function startOrchestraFromModal() {
  const project = orchestraProject;
  if (!project?.localPath) return;
  const goal = el.orchestraGoal?.value.trim() || '';
  if (!goal) {
    msg('先写这次要做什么', 'info');
    el.orchestraGoal?.focus();
    return;
  }
  const kit = orchestraInstalledKit();
  const config = normalizeOrchestraConfig({
    brain: selectedOrchestraBrain(),
    workers: selectedOrchestraWorkers(),
    kit,
  });
  if (kit.length < 2) {
    msg('至少安装两个 CLI 才能开始协作', 'info');
    el.orchestraBrainPicks?.querySelector('input:not(:disabled)')?.focus();
    return;
  }
  if (!config.workers.length) {
    msg('至少选择一个干活的终端', 'info');
    el.orchestraWorkerPicks?.querySelector('input:not(:disabled)')?.focus();
    syncOrchestraWorkersHint(config);
    return;
  }
  const openingToken = beginProjectToolOpening();
  if (!openingToken) {
    msg('正在打开另一组终端，请稍后再试', 'info');
    return;
  }
  orchestraDraftConfig = config;
  const terminalState = captureTerminalPaneState();
  const participants = [config.brain, ...config.workers];
  closeOrchestraModal();
  try {
    let previousFiles = null;
    const result = await runOrchestraLaunchTransaction({
      brain: config.brain,
      workers: config.workers,
      participants,
      create: tool => createProjectToolSession(project, tool),
      isReady: (id, tool) => isReadyOrchestraSession(id, tool, project.localPath),
      commit: async launch => {
        if (!isReadyOrchestraSession(
          launch.sessionIds[config.brain],
          config.brain,
          project.localPath,
        )) {
          throw new Error(`${orchestraToolLabel(config.brain)} 大脑终端启动失败`);
        }
        const hasReadyWorker = launch.readyWorkers.some(tool => isReadyOrchestraSession(
          launch.sessionIds[tool],
          tool,
          project.localPath,
        ));
        if (!hasReadyWorker) throw new Error('干活终端都没有启动成功');
        previousFiles = await commitOrchestraFiles(project.localPath, goal);
      },
      rollback: createdIds => rollbackCreatedSessions(createdIds, terminalState),
    });
    let failedCleanupError = null;
    if (result.failedIds.length) {
      try {
        await closeCreatedSessions(result.failedIds);
      } catch (error) {
        failedCleanupError = error;
      }
    }
    const brainReady = isReadyOrchestraSession(
      result.sessionIds[config.brain],
      config.brain,
      project.localPath,
    );
    const readyWorkers = result.readyWorkers.filter(tool => isReadyOrchestraSession(
      result.sessionIds[tool],
      tool,
      project.localPath,
    ));
    if (!brainReady || !readyWorkers.length) {
      const recoveryErrors = [];
      try {
        await restoreOrchestraFiles(project.localPath, previousFiles);
      } catch (error) {
        recoveryErrors.push(`恢复原协作文件失败：${error?.message || error}`);
      }
      try {
        await rollbackCreatedSessions(result.createdIds, terminalState);
      } catch (error) {
        recoveryErrors.push(error?.message || error);
      }
      const reason = brainReady
        ? '干活终端在启动期间已退出'
        : `${orchestraToolLabel(config.brain)} 大脑终端在启动期间已退出`;
      throw new Error([reason, ...recoveryErrors].join('；'));
    }
    activeOrchestra = {
      ...config,
      sessionIds: result.sessionIds,
      workers: readyWorkers,
      projectId: project.id,
      projectPath: project.localPath,
      goal,
    };
    saveOrchestraConfig(activeOrchestra);
    applyProjectKitLayout([
      result.sessionIds[config.brain],
      ...readyWorkers.map(tool => result.sessionIds[tool]),
    ]);
    if (termEl.orchestraInput) termEl.orchestraInput.value = goal;
    syncOrchestraChrome();
    const failedCount = config.workers.length - readyWorkers.length;
    const failedSuffix = failedCount ? `；另有 ${failedCount} 个干活终端启动失败` : '';
    const cleanupSuffix = failedCleanupError ? `；${failedCleanupError.message}` : '';
    msg(
      `协作已就位：${readyWorkers.length + 1} 个终端，等输入框出现后点「发给大脑」${failedSuffix}${cleanupSuffix}`,
      failedCount || failedCleanupError ? 'info' : 'success',
    );
  } catch (error) {
    const detail = error?.code === 'brain_not_ready'
      ? `${orchestraToolLabel(config.brain)} 大脑终端启动失败`
      : (error?.message || error);
    const rollbackHint = error?.rollbackError
      ? `；关闭本次终端失败：${error.rollbackError?.message || error.rollbackError}`
      : '';
    const restoreHint = error?.restoreError
      ? `；${error.restoreError?.message || error.restoreError}`
      : '';
    msg(`开协作失败：${detail}${rollbackHint}${restoreHint}`, 'error');
  } finally {
    releaseProjectToolOpening(openingToken);
  }
}

// ===== 项目卡片 Git 状态徽标 =====
function gitBadgeHtml(r) {
  if (!r || !r.isRepo || r.error) return '';
  const branchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="7.5" r="2.2"/><path d="M6 8.2v7.6M18 9.7c0 4-3.5 3.3-6 5.3"/></svg>';
  let metrics = '';
  if (r.changed) metrics += `<span class="git-m git-changed" title="已改动（含暂存）文件">●${r.changed}</span>`;
  if (r.untracked) metrics += `<span class="git-m git-untracked" title="未追踪文件">+${r.untracked}</span>`;
  if (r.ahead) metrics += `<span class="git-m git-ahead" title="领先上游提交">↑${r.ahead}</span>`;
  if (r.behind) metrics += `<span class="git-m git-behind" title="落后上游提交">↓${r.behind}</span>`;
  if (!r.dirty && !r.ahead && !r.behind) metrics = '<span class="git-m git-ok" title="干净，与上游同步">✓</span>';
  return `<span class="git-badge ${r.dirty ? 'is-dirty' : 'is-clean'}">`
    + `<span class="git-branch" title="当前分支：${escAttr(r.branch)}">${branchIcon}${esc(r.branch || '?')}</span>`
    + metrics + '</span>';
}

let gitRefreshing = false;
async function refreshGitStatus() {
  if (gitRefreshing) return;
  const spans = [...document.querySelectorAll('.card-git[data-git-id]')];
  const items = spans.map(s => {
    const p = projects.find(x => x.id === s.dataset.gitId);
    return p && p.localPath && p.machine !== 'server' ? { span: s, path: p.localPath } : null;
  }).filter(Boolean);
  if (!items.length) return;
  gitRefreshing = true;
  try {
    const results = await invoke('git_status_batch', { paths: items.map(i => i.path) });
    const byPath = new Map(results.map(r => [r.path, r]));
    items.forEach(i => { i.span.innerHTML = gitBadgeHtml(byPath.get(i.path)); });
  } catch (e) {
    /* git 不可用就不显示徽标 */
  } finally {
    gitRefreshing = false;
  }
}

function installUiScale() {
  const scale = applyUiScale(readUiScale());
  const root = document.querySelector('.ui-scale-picks');
  if (!root) return;
  const sync = (current) => {
    root.querySelectorAll('[data-ui-scale]').forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.uiScale === current ? 'true' : 'false');
    });
  };
  root.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-ui-scale]');
    if (!btn) return;
    sync(applyUiScale(writeUiScale(btn.dataset.uiScale)));
  });
  sync(scale);
}

function bind() {
  installUiScale();
  el.addBtn.onclick = () => openModal();
  el.exportBtn.onclick = exportExcel;
  el.modalClose.onclick = closeModal;
  el.cancel.onclick = closeModal;
  el.modal.onclick = e => { if (e.target === el.modal) closeModal(); };
  el.form.onsubmit = submit;
  el.submit.type = 'button';
  el.submit.onclick = () => submit(new Event('submit'));
  el.browse.onclick = browse;
  el.confirmClose.onclick = closeDel;
  el.confirmCancel.onclick = closeDel;
  el.confirm.onclick = e => { if (e.target === el.confirm) closeDel(); };
  el.confirmDelete.onclick = doDelete;
  el.sessionPreviewClose.onclick = closeSessionPreview;
  el.sessionPreviewCancel.onclick = closeSessionPreview;
  el.sessionPreview.onclick = e => { if (e.target === el.sessionPreview) closeSessionPreview(); };
  el.sessionPreviewOpen.onclick = resumePreviewedSession;
  el.sessionHandoffClose.onclick = () => closeSessionHandoff();
  el.sessionHandoffCancel.onclick = () => closeSessionHandoff();
  el.sessionHandoff.onclick = e => { if (e.target === el.sessionHandoff) closeSessionHandoff(); };
  el.sessionHandoffStart.onclick = () => void startSessionHandoff();
  el.sessionHandoffContent.addEventListener('input', () => {
    sessionHandoffContentDirty = true;
    syncSessionHandoffDraftState();
  });
  el.orchestraModalClose.onclick = closeOrchestraModal;
  el.orchestraModalCancel.onclick = closeOrchestraModal;
  el.orchestra.onclick = e => { if (e.target === el.orchestra) closeOrchestraModal(); };
  el.orchestraModalStart.onclick = () => void startOrchestraFromModal();
  termEl.orchestraToBrain.onclick = () => void sendOrchestra('brain');
  termEl.orchestraToWorkers.onclick = () => void sendOrchestra('workers');
  termEl.orchestraBroadcast.onclick = () => void sendOrchestra('broadcast');
  termEl.orchestraClose.onclick = closeOrchestra;
  termEl.orchestraInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendOrchestra('brain');
    }
  });
  el.search.oninput = () => filterAndRender();

  document.querySelector('[data-group="all"]').onclick = (e) => {
    e.preventDefault();
    activeGroup = 'all';
    document.querySelectorAll('.sider .menu-item').forEach(i => i.classList.remove('active'));
    e.currentTarget.classList.add('active');
    filterAndRender();
  };

  document.onkeydown = e => {
    if (e.key !== 'Escape') return;
    closeModal();
    closeDel();
    closeServerModal();
    closeServerList();
    closeProjectIdeas();
    closeThemeMenu();
    closeSnippetMenu();
    closeMemoryMenu();
    closeTerminalLayoutMenu();
    closeFontMenu();
    closeSessionPreview();
    closeSessionHandoff();
    closeOrchestraModal();
    closeProxyModal();
  };

  // 运行环境切换时显示/隐藏服务器选择
  el.machine.onchange = () => {
    el.serverSelectWrap.style.display = el.machine.value === 'server' ? '' : 'none';
    if (el.machine.value === 'server') renderServerOptions();
  };

  // 服务器管理按钮
  el.manageServerBtn.onclick = () => openServerList();

  // 服务器弹窗事件
  el.serverModalClose.onclick = closeServerModal;
  el.serverCancelBtn.onclick = closeServerModal;
  el.serverModal.onclick = e => { if (e.target === el.serverModal) closeServerModal(); };
  el.serverForm.onsubmit = submitServer;
  el.serverSubmitBtn.type = 'button';
  el.serverSubmitBtn.onclick = () => submitServer(new Event('submit'));

  // 服务器列表弹窗事件
  el.serverListClose.onclick = closeServerList;
  el.serverListOverlay.onclick = e => { if (e.target === el.serverListOverlay) closeServerList(); };
  el.addServerBtn.onclick = () => { closeServerList(); openServerModal(); };

  el.proxyEntry.onclick = () => void openProxyModal();
  el.proxyClose.onclick = closeProxyModal;
  el.proxyCancel.onclick = closeProxyModal;
  el.proxyOverlay.onclick = e => { if (e.target === el.proxyOverlay) closeProxyModal(); };
  el.proxySave.onclick = () => void saveProxyModal();

  // 侧边栏服务器管理入口
  $('server-manage-entry').onclick = (e) => {
    e.preventDefault();
    openServerList();
  };

  // 手机远程入口
  $('remote-entry').onclick = openRemote;
  $('remote-close').onclick = closeRemote;
  $('remote-ok').onclick = closeRemote;
  $('remote-overlay').onclick = e => { if (e.target === $('remote-overlay')) closeRemote(); };
  $('remote-copy-pin').onclick = () => copyText($('remote-pin').textContent);

  // 扫描导入
  el.scanBtn.onclick = startScan;
  el.scanModalClose.onclick = closeScanModal;
  el.scanCancelBtn.onclick = closeScanModal;
  el.scanModal.onclick = e => { if (e.target === el.scanModal) closeScanModal(); };
  el.scanImportBtn.onclick = importScanned;

  // 内置终端
  termEl.fab.onclick = () => { sessions.size ? openDock() : createSession({}); };
  termEl.collapseBtn.onclick = collapseDock;
  termEl.maximizeBtn.onclick = toggleDockMaximize;
  termEl.newBtn.onclick = () => createSession({});
  termEl.bellBtn.onclick = toggleNotify;
  applyBellState();
  termEl.ideasBtn.onclick = (event) => {
    event.stopPropagation();
    if (termEl.ideasDrawer.classList.contains('active')) closeProjectIdeas();
    else void openProjectIdeas();
  };
  termEl.handoffBtn.onclick = event => {
    event.stopPropagation();
    if (el.sessionHandoff.classList.contains('active')) closeSessionHandoff();
    else void openSessionHandoff();
  };
  termEl.ideasClose.onclick = () => closeProjectIdeas();
  termEl.ideasScrim.onclick = () => closeProjectIdeas();
  termEl.ideaAdd.onclick = () => void addProjectIdea();
  termEl.ideaInput.addEventListener('input', () => {
    if (ideaPanelProjectId) ideaCaptureDrafts.set(ideaPanelProjectId, termEl.ideaInput.value);
  });
  termEl.ideaInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void addProjectIdea();
    }
  });
  termEl.ideasArchiveToggle.onclick = () => {
    ideaPanelShowArchived = !ideaPanelShowArchived;
    renderProjectIdeas();
  };
  // Prompt 片段库
  termEl.snippetBtn.onclick = (ev) => {
    ev.stopPropagation();
    closeProjectIdeas(false);
    closeTerminalLayoutMenu();
    closeFontMenu();
    closeMemoryMenu();
    toggleSnippetMenu(ev.currentTarget);
  };
  termEl.memoryBtn.onclick = (ev) => {
    ev.stopPropagation();
    closeProjectIdeas(false);
    closeTerminalLayoutMenu();
    closeFontMenu();
    closeSnippetMenu();
    toggleMemoryMenu(ev.currentTarget);
  };
  // 片段快捷浮层：展开/收起（记忆状态）
  $('snippet-quick-fab').onclick = () => { localStorage.setItem('snippet-quick-collapsed', '0'); $('snippet-quick').classList.remove('collapsed'); };
  $('snippet-quick-collapse').onclick = () => { localStorage.setItem('snippet-quick-collapsed', '1'); $('snippet-quick').classList.add('collapsed'); };
  $('snippet-modal-close').onclick = closeSnippetModal;
  $('snippet-modal-overlay').onclick = e => { if (e.target === $('snippet-modal-overlay')) closeSnippetModal(); };
  $('snippet-save-btn').onclick = saveSnippetFromEditor;
  $('snippet-clear-btn').onclick = clearSnippetEditor;
  $('snippet-sched-mode').onchange = updateSnippetSchedFields;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#snippet-menu') && !e.target.closest('#terminal-snippet-btn')) closeSnippetMenu();
    if (!e.target.closest('#terminal-memory-menu') && !e.target.closest('#terminal-memory-btn')) closeMemoryMenu();
  });
  window.addEventListener('resize', () => {
    closeSnippetMenu();
    closeMemoryMenu();
    closeProjectIdeas(false);
  });
  // 恢复现场 Modal
  $('context-modal-close').onclick = closeContextModal;
  $('context-modal-overlay').onclick = e => { if (e.target === $('context-modal-overlay')) closeContextModal(); };
  $('context-open-terminal').onclick = () => { const p = contextProject; if (p) { closeContextModal(); openTerminal(p, ''); } };
  $('context-open-claude').onclick = () => { const p = contextProject; if (p) { closeContextModal(); openTerminal(p, 'claude'); } };
  // WebKit 偶尔会在应用切出再切回后留下“看似聚焦、实际不收键盘”的 xterm textarea。
  // 只在切出前焦点确实位于当前终端时恢复，避免抢走表单、弹窗和文件编辑器的焦点。
  let restoreTerminalFocus = false;
  window.addEventListener('blur', () => {
    if (currentAppView() !== 'developer') {
      restoreTerminalFocus = false;
      return;
    }
    const session = activeSession ? sessions.get(activeSession) : null;
    restoreTerminalFocus = !!(session && session.bodyEl.contains(document.activeElement));
  });
  // 窗口重新获得焦点时，正在看的会话就别再亮"需要关注"了 + 刷新 git 状态
  let gitFocusTimer = null;
  window.addEventListener('focus', () => {
    if (activeSession && developerTerminalVisible()) clearAttention(activeSession);
    if (restoreTerminalFocus && activeSession && developerTerminalVisible()) {
      requestAnimationFrame(() => sessions.get(activeSession)?.term.focus());
    }
    restoreTerminalFocus = false;
    clearTimeout(gitFocusTimer);
    gitFocusTimer = setTimeout(() => {
      refreshGitStatus();
      void refreshInstalledClis({ force: true });
    }, 400); // 防抖：回到窗口稍候再扫
  });
  termEl.usageBtn.onclick = openUsage;
  $('usage-close').onclick = closeUsage;
  $('usage-ok').onclick = closeUsage;
  $('usage-refresh').onclick = () => loadUsage();
  document.querySelectorAll('.usage-tab').forEach(tab => {
    tab.onclick = () => {
      if (tab.classList.contains('active')) return;
      switchUsageTab(tab.dataset.agent);
      loadUsage();
    };
  });
  $('usage-overlay').onclick = e => { if (e.target === $('usage-overlay')) closeUsage(); };
  termEl.themeBtn.onclick = (e) => {
    e.stopPropagation();
    closeProjectIdeas(false);
    (themeMenuOpening || termEl.themeMenu.classList.contains('active')) ? closeThemeMenu() : void openThemeMenu();
  };
  termEl.layoutBtn.onclick = (e) => {
    e.stopPropagation();
    closeProjectIdeas(false);
    (terminalLayoutMenuOpening || termEl.layoutMenu.classList.contains('active'))
      ? closeTerminalLayoutMenu()
      : void openTerminalLayoutMenu();
  };
  termEl.fontBtn.onclick = (e) => {
    e.stopPropagation();
    closeProjectIdeas(false);
    (fontMenuOpening || termEl.fontMenu.classList.contains('active'))
      ? closeFontMenu()
      : void openFontMenu();
  };
  $('term-font-dec').onclick = (e) => {
    e.stopPropagation();
    setTermFontSize(currentFontSize - 1);
  };
  $('term-font-inc').onclick = (e) => {
    e.stopPropagation();
    setTermFontSize(currentFontSize + 1);
  };
  $('term-font-reset').onclick = (e) => {
    e.stopPropagation();
    setTermFontSize(TERM_FONT_DEFAULT);
  };
  termEl.layoutMenu.querySelectorAll('[data-layout]').forEach(option => {
    option.onclick = () => setTerminalPaneLayout(option.dataset.layout);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.term-theme-wrap')) closeThemeMenu();
    if (!e.target.closest('.terminal-layout-wrap')) closeTerminalLayoutMenu();
    if (!e.target.closest('.term-font-wrap')) closeFontMenu();
  });
  // 终端字号快捷键：⌘/Ctrl + 加号放大、减号缩小、0 复位（capture 阶段抢在 xterm 之前）
  document.addEventListener('keydown', (e) => {
    if (!developerTerminalVisible()) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setTermFontSize(currentFontSize + 1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setTermFontSize(currentFontSize - 1); }
    else if (e.key === '0') { e.preventDefault(); setTermFontSize(TERM_FONT_DEFAULT); }
  }, true);
  // ⌘/Ctrl + 滚轮缩放字号
  termEl.bodies.addEventListener('wheel', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    setTermFontSize(currentFontSize + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  applyTermBackground(currentThemeDef || TERM_THEMES.classic); // custom:* 由 initTermTheme 异步精确应用
  setupTermResize();
  setupTerminalPaneSplitters();
  setupWorkspaceMode();
  // 文件树 + 内容预览
  termEl.treeBtn.onclick = toggleTree;
  termEl.treeRefreshBtn.onclick = () => {
    const key = normalizeProjectMemoryCwd(treeRoot);
    if (key) invalidateProjectSessionHistory(key);
    renderTree(treeRoot);
  };
  termEl.previewInsert.onclick = () => insertPathToTerminal(termEl.previewInsert.dataset.path || '');
  termEl.previewToggle.onclick = togglePreviewMode;
  termEl.previewEdit.onclick = beginFileEdit;
  termEl.previewSave.onclick = saveFileEdit;
  termEl.previewCancel.onclick = requestCancelFileEdit;
  termEl.previewClose.onclick = () => closePreview();
  setupFileEditor();
  // 渲染视图里的链接走系统浏览器，别让主 webview 导航走
  termEl.previewRich.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) invoke('open_folder', { path: href }).catch(() => {});
  });
  setupTreeSplitter();
  setupSessionRail();
  setupTreeDrag();
  // 文件树右键菜单
  el.treeCtxMenu.querySelectorAll('.ctx-item').forEach(item => {
    item.onclick = () => {
      const action = item.dataset.action;
      const ctx = treeCtx;
      closeTreeCtx();
      if (!ctx) return;
      if (action === 'open') {
        const target = ctx.entry.isDir ? ctx.entry.path : parentDir(ctx.entry.path);
        invoke('open_folder', { path: target }).catch(e => msg('打开失败: ' + e, 'error'));
      } else if (action === 'insert') {
        insertPathToTerminal(ctx.entry.path);
      } else if (action === 'run-script') {
        insertShellScriptCommand(ctx.entry);
      } else if (action === 'copy') {
        navigator.clipboard?.writeText(ctx.entry.path).then(
          () => msg('路径已复制', 'success'),
          () => msg('复制失败', 'error'),
        );
      } else if (action === 'trash') {
        askConfirm(ctx.entry.isDir ? '文件夹' : '文件', ctx.entry.name, async () => {
          try {
            await invoke('trash_path', { path: ctx.entry.path });
            if (ctx.row === treeActiveRow) closePreview(true);
            const next = ctx.row.nextElementSibling;
            if (next && next.classList.contains('tree-children')) next.remove();
            ctx.row.remove();
            msg('已移到废纸篓', 'success');
          } catch (e) {
            msg('删除失败: ' + e, 'error');
          }
        });
      }
    };
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#tree-context-menu')) closeTreeCtx(); });
  document.addEventListener('scroll', closeTreeCtx, true);
  const savedTreeW = parseInt(localStorage.getItem('term-tree-width'), 10);
  if (savedTreeW >= 140 && savedTreeW <= 480) termEl.tree.style.width = savedTreeW + 'px';
  const treeHidden = localStorage.getItem('term-tree-hidden') === '1';
  termEl.tree.classList.toggle('hidden', treeHidden);
  termEl.treeBtn.classList.toggle('active', !treeHidden);
  window.addEventListener('resize', () => {
    if (termEl.dock.classList.contains('maximized')) termEl.dock.style.height = window.innerHeight + 'px';
    closeTerminalLayoutMenu();
    closeFontMenu();
    applySessionRailHeight();
    scheduleFitVisibleSessions();
  });
  renderTerminalPaneLayout();
}

function openModal(p = null) {
  currentEditId = p ? p.id : null;
  el.modalTitle.textContent = p ? '编辑项目' : '新建项目';
  if (p) {
    el.id.value = p.id;
    el.name.value = p.name;
    el.path.value = p.localPath;
    el.url.value = p.remoteUrl;
    el.machine.value = p.machine;
    el.group.value = p.group || '';
    el.desc.value = p.description;
    if (p.machine === 'server' && p.serverId) {
      el.serverSelectWrap.style.display = '';
      renderServerOptions();
      el.serverSelect.value = p.serverId;
    } else {
      el.serverSelectWrap.style.display = 'none';
    }
  } else {
    el.form.reset();
    el.id.value = '';
    el.serverSelectWrap.style.display = 'none';
  }
  el.modal.classList.add('active');
  el.name.focus();
}

function closeModal() {
  el.modal.classList.remove('active');
  currentEditId = null;
}

// 通用确认弹窗（WKWebView 不支持原生 confirm，统一走应用内弹窗）
function showConfirm({ title = '确认', message, confirmText = '确认', danger = true, onConfirm, onCancel }) {
  // A later application-level prompt supersedes the visible one. Resolve the
  // previous Promise-backed request as cancelled instead of leaving its caller
  // suspended forever behind callbacks that are about to be replaced.
  const supersededCancel = pendingConfirmCancel;
  pendingConfirm = null;
  pendingConfirmCancel = null;
  supersededCancel?.();
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmDelete.textContent = confirmText;
  el.confirmDelete.classList.toggle('btn-danger', danger);
  el.confirmDelete.classList.toggle('btn-primary', !danger);
  pendingConfirm = onConfirm;
  pendingConfirmCancel = onCancel;
  el.confirm.classList.add('active');
}

// Promise adapter for feature modules. It deliberately reuses the one app-wide
// dialog because WKWebView does not provide reliable native confirm dialogs.
function requestConfirm(options) {
  if (!el.confirm || !el.confirmTitle || !el.confirmMessage || !el.confirmDelete) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    showConfirm({
      ...options,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

// 删除类确认的便捷封装
function askConfirm(kind, name, onConfirm) {
  showConfirm({ title: '确认删除', message: `确定要删除${kind} ${name} 吗？`, confirmText: '删除', danger: true, onConfirm });
}

function del(id, name) {
  askConfirm('项目', name, async () => {
    if (projectIdeaMutationGate.pending && ideaPanelProjectId === id) {
      msg('项目想法正在保存，请稍候再删除项目', 'info');
      return;
    }
    if (ideaPanelProjectId === id) closeProjectIdeas(false);
    await invoke('delete_project', { id });
    msg('删除成功', 'success');
    await load();
  });
}

function closeDel() {
  el.confirm.classList.remove('active');
  pendingConfirm = null;
  const onCancel = pendingConfirmCancel;
  pendingConfirmCancel = null;
  onCancel?.();
  exitPromptPending = false;
}

async function browse() {
  try {
    const r = await invoke('open_folder_dialog');
    if (r) el.path.value = r;
  } catch (e) {
    console.error('选择文件夹失败:', e);
  }
}

async function openTerminal(p, cmd) {
  try {
    const tool = cliToolName(cmd);
    if (tool && isRailCliTool(tool)) {
      const existing = findRunningProjectTool(listLiveTerminals(), p.localPath, tool);
      if (existing) {
        openDock();
        activateSession(existing.id);
        return;
      }
      let history = { groups: [] };
      try {
        history = await fetchProjectSessions(p);
      } catch (_) {
        history = { groups: [] };
      }
      const launch = launchCommandForProjectTool(tool, history.groups);
      const autoCmd = launch.autoCmd || tool;
      recordProjectActivity(p.id, autoCmd);
      await createSession({
        cwd: p.localPath,
        name: p.name,
        autoCmd,
      });
      return;
    }
    recordProjectActivity(p.id, cmd);
    await createSession({ cwd: p.localPath, name: p.name, autoCmd: cmd });
  } catch (e) {
    console.error('打开终端失败:', e);
    msg('打开终端失败: ' + (e.message || e), 'error');
  }
}

let submitting = false;
async function submit(e) {
  e.preventDefault();
  if (!el.form.checkValidity()) {
    el.form.reportValidity();
    return;
  }

  const projectMachine = normalizeProjectMachine(el.machine.value, el.serverSelect.value);
  const data = {
    name: el.name.value.trim(),
    localPath: el.path.value.trim(),
    remoteUrl: el.url.value.trim(),
    machine: projectMachine.machine,
    serverId: projectMachine.serverId,
    group: el.group.value.trim(),
    description: el.desc.value.trim(),
  };
  if (currentEditId) data.id = currentEditId;

  if (data.machine === 'server' && !data.serverId) {
    msg('请选择服务器', 'error');
    return;
  }
  if (submitting) return; // 防止 invoke 在途时重复点「确定」产生重复项目
  submitting = true;

  try {
    if (currentEditId) {
      await invoke('update_project', data);
      msg('更新成功', 'success');
    } else {
      await invoke('add_project', data);
      msg('创建成功', 'success');
    }
    closeModal();
    await load();
  } catch (e) {
    console.error('操作失败:', e);
    msg('操作失败: ' + (e.message || e), 'error');
  } finally {
    submitting = false;
  }
}

async function doDelete() {
  if (!pendingConfirm) return;
  const fn = pendingConfirm;
  pendingConfirm = null;
  pendingConfirmCancel = null;
  try {
    await fn();
  } catch (e) {
    msg(typeof e === 'string' ? e : (e.message || '删除失败'), 'error');
  } finally {
    closeDel();
  }
}

async function exportExcel() {
  try {
    await invoke('export_excel');
    msg('导出成功', 'success');
  } catch (e) {
    if (e !== '未选择保存位置') msg('导出失败', 'error');
  }
}

// ========== 服务器管理 ==========

function renderServerOptions() {
  el.serverSelect.innerHTML = '<option value="">请选择服务器</option>' +
    servers.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.host)})</option>`).join('');
}

function openServerModal(s = null) {
  currentServerEditId = s ? s.id : null;
  el.serverModalTitle.textContent = s ? '编辑服务器' : '添加服务器';
  if (s) {
    el.serverId.value = s.id;
    el.serverName.value = s.name;
    el.serverHost.value = s.host;
    el.serverPort.value = s.port || 22;
    el.serverUser.value = s.user;
    el.serverAuthType.value = s.authType || 'password';
    el.serverNote.value = s.note || '';
  } else {
    el.serverForm.reset();
    el.serverId.value = '';
    el.serverPort.value = '22';
    el.serverAuthType.value = 'password';
  }
  el.serverModal.classList.add('active');
  el.serverName.focus();
}

function closeServerModal() {
  el.serverModal.classList.remove('active');
  currentServerEditId = null;
}

let submittingServer = false;
async function submitServer(e) {
  e.preventDefault();
  if (!el.serverForm.checkValidity()) {
    el.serverForm.reportValidity();
    return;
  }
  if (submittingServer) return; // 防重复点击产生重复服务器
  submittingServer = true;

  const data = {
    name: el.serverName.value.trim(),
    host: el.serverHost.value.trim(),
    port: parseInt(el.serverPort.value) || 22,
    user: el.serverUser.value.trim(),
    authType: el.serverAuthType.value,
    note: el.serverNote.value.trim(),
  };
  if (currentServerEditId) data.id = currentServerEditId;

  try {
    if (currentServerEditId) {
      await invoke('update_server', data);
      msg('服务器更新成功', 'success');
    } else {
      await invoke('add_server', data);
      msg('服务器添加成功', 'success');
    }
    closeServerModal();
    await load();
    // 刷新服务器列表并重新打开，确保新数据可见
    openServerList();
    // 同步刷新项目表单中的服务器下拉（运行环境为服务器时）
    if (el.machine.value === 'server') renderServerOptions();
  } catch (e) {
    console.error('服务器操作失败:', e);
    msg('操作失败: ' + (e.message || e), 'error');
  } finally {
    submittingServer = false;
  }
}

function openServerList() {
  renderServerList();
  el.serverListOverlay.classList.add('active');
}

function closeServerList() {
  el.serverListOverlay.classList.remove('active');
}

// ===== 手机远程 =====
async function openRemote() {
  $('remote-overlay').classList.add('active');
  const box = $('remote-addrs');
  box.innerHTML = '<div class="remote-loading">获取地址中…</div>';
  try {
    const info = await invoke('terminal_remote_info');
    $('remote-pin').textContent = info.pin;
    const addrs = info.addrs || [];
    if (!addrs.length) {
      box.innerHTML = '<div class="remote-loading">未找到局域网地址，请检查是否已连接 WiFi / 网线。</div>';
      return;
    }
    box.innerHTML = '';
    addrs.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'remote-card';
      card.innerHTML =
        `<div class="remote-qr">${a.qr || ''}</div>` +
        `<div class="remote-card-info">` +
          `<span class="remote-kind kind-${a.kind === '局域网' ? 'lan' : 'other'}">${esc(a.kind)}</span>` +
          `<code class="remote-card-url">${esc(a.url)}</code>` +
          `<button class="btn btn-default btn-xs">复制地址</button>` +
        `</div>`;
      card.querySelector('button').onclick = () => copyText(a.url);
      box.appendChild(card);
    });
  } catch (e) {
    box.innerHTML = '<div class="remote-loading">获取失败</div>';
    $('remote-pin').textContent = '——————';
    msg('获取远程信息失败: ' + e, 'error');
  }
}

function closeRemote() {
  $('remote-overlay').classList.remove('active');
  // 真正停掉手机远程服务（清空 PIN、断开已连接的手机、停止监听），
  // 不只是隐藏这个面板——不然 PIN 和监听会一直有效到应用退出。
  invoke('terminal_remote_stop').catch(() => {});
}

// ===== 用量统计 =====
let usageAgent = 'claude';      // 当前用量 tab：claude / codex
const usageInflight = new Set();

async function openUsage() {
  $('usage-overlay').classList.add('active');
  switchUsageTab('claude');
  loadUsage();
}
function closeUsage() {
  $('usage-overlay').classList.remove('active');
}

// 切 tab（不触发加载，仅改激活态）。
function switchUsageTab(agent) {
  usageAgent = agent;
  document.querySelectorAll('.usage-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.agent === agent));
}

async function loadUsage() {
  const agent = usageAgent;
  const body = $('usage-body');
  if (usageInflight.has(agent)) return;
  usageInflight.add(agent);
  body.innerHTML = '<div id="usage-oauth"><div class="usage-loading">查询限流用量…</div></div>';
  try {
    const o = await invoke(usageCommandForAgent(agent));
    if (usageAgent !== agent) return;
    renderLimitUsage(o, windowsFromUsagePayload(agent, o));
  } catch (e) {
    if (usageAgent !== agent) return;
    const el = document.getElementById('usage-oauth');
    const msg = `查询失败：${String(e)}`;
    if (el) el.innerHTML = `<div class="usage-error">${esc(msg)}</div>`;
    else body.innerHTML = `<div class="usage-error">${esc(msg)}</div>`;
  } finally {
    usageInflight.delete(agent);
  }
}

function renderLimitUsage(o, windows) {
  const el = document.getElementById('usage-oauth');
  if (!el) return;
  if (!o || !o.ok) {
    el.innerHTML = `<div class="usage-error">${esc((o && o.error) || '限流用量查询失败')}</div>`;
    return;
  }
  const plan = o.plan ? ` · ${esc(o.plan)}` : '';
  const age = `<span class="usage-age">${esc(fmtUsageAge(o.ageSecs))}</span>`;
  const staleWarn = o.stale
    ? `<div class="usage-stale-warn">⚠ 实时刷新失败，下面是旧数据${o.error ? '：' + esc(o.error) : ''}</div>`
    : '';
  const rows = (windows || []).map(w => oauthRow(w.label, w)).join('');
  el.innerHTML =
    `<div class="usage-oauth-head">限流用量${plan}${age}</div>` +
    staleWarn +
    (rows || '<div class="usage-weekly-empty">暂无限流窗口</div>');
}
// 数据年龄文案（OAuth 限流用量底部"X 分钟前更新"）。
function fmtUsageAge(secs) {
  secs = Number(secs) || 0;
  if (secs < 5) return '刚刚更新';
  if (secs < 60) return `${secs} 秒前更新`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} 分钟前更新`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} 小时${rm ? ' ' + rm + ' 分' : ''}前更新`;
}
function oauthRow(label, w) {
  w = w || {};
  const pct = Math.max(0, Math.min(100, Math.round(w.utilization || 0)));
  const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  const reset = w.resetsAt ? oauthResetLabel(w.resetsAt) : '';
  return `<div class="usage-oauth-row">` +
    `<div class="usage-oauth-row-top"><span class="usage-oauth-label">${esc(label)}</span>` +
      `<span class="usage-oauth-pct ${cls}">${pct}%</span></div>` +
    `<div class="usage-bar"><div class="usage-bar-fill ${cls}" style="width:${pct}%"></div></div>` +
    (reset ? `<div class="usage-oauth-reset">${esc(reset)}</div>` : '') +
    `</div>`;
}
function oauthResetLabel(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const d = t - Date.now();
  if (d <= 0) return '即将重置';
  const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时后重置`;
  if (h >= 1) return `${h} 小时 ${m} 分后重置`;
  return `${m} 分后重置`;
}

function copyText(text) {
  // 去掉占位符（单个或多个破折号，如获取失败时的「——————」）后为空则不复制
  if (!text || !text.replace(/[—-]/g, '').trim()) return;
  navigator.clipboard.writeText(text).then(
    () => msg('已复制', 'success'),
    () => msg('复制失败', 'error')
  );
}

function renderServerList() {
  if (!servers.length) {
    el.serverList.style.display = 'none';
    el.serverEmpty.style.display = '';
    return;
  }
  el.serverEmpty.style.display = 'none';
  el.serverList.style.display = '';

  el.serverList.innerHTML = servers.map(s => `
    <div class="server-card" data-id="${s.id}">
      <div class="server-card-main">
        <div class="server-card-name">${esc(s.name)}</div>
        <div class="server-card-info">
          <span>${esc(s.user)}@${esc(s.host)}:${s.port}</span>
          <span class="tag ${s.authType === 'key' ? 'tag-local' : 'tag-ssh'}">${s.authType === 'key' ? '秘钥' : '密码'}</span>
        </div>
        ${s.note ? `<div class="server-card-note">${esc(s.note)}</div>` : ''}
      </div>
      <div class="server-card-actions">
        <button class="action-btn edit-server-btn" title="编辑">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>
        </button>
        <button class="action-btn danger del-server-btn" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  el.serverList.querySelectorAll('.server-card').forEach(card => {
    const id = card.dataset.id;
    const s = servers.find(x => x.id === id);
    if (!s) return;
    card.querySelector('.edit-server-btn').onclick = () => { closeServerList(); openServerModal(s); };
    card.querySelector('.del-server-btn').onclick = () => {
      askConfirm('服务器', s.name, async () => {
        await invoke('delete_server', { id: s.id });
        msg('删除成功', 'success');
        await load();
        renderServerList();
      });
    };
  });
}

// ========== 工具函数 ==========

function msg(text, type = 'info') {
  const icon = type === 'success'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>';
  const d = document.createElement('div');
  d.className = `message ${type}`;
  d.innerHTML = icon; // icon 是固定的内置 SVG 字符串，不含用户数据
  const span = document.createElement('span');
  span.textContent = text; // text 可能来自用户数据（如片段标题），必须转义
  d.appendChild(span);
  el.toasts.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// 用于 HTML 属性值（如 title="..."）：在 esc 基础上再转义引号，防内容里的 " 截断属性
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

// 整表保存后，把后端生成的 id/时间戳按发送顺序回填到原对象引用（不整体替换数组）。
// 只回填 fields 指定的后端元字段，绝不覆盖标题/内容等用户可编辑字段——
// 否则会把「保存在途期间的并发编辑」一并冲掉。
function backfillMeta(snapshot, saved, fields) {
  if (!Array.isArray(saved)) return;
  saved.forEach((row, i) => {
    const obj = snapshot[i];
    if (!obj || !row) return;
    fields.forEach(f => { if (row[f] != null) obj[f] = row[f]; });
  });
}

function short(p) {
  if (!p || p.length <= 30) return p || '';
  const parts = p.split(/[/\\]/);
  return parts.length <= 3 ? p : `${parts[0]}/…/${parts.at(-1)}`;
}

function repo(url) {
  if (!url) return '';
  try { return url.split('/').pop().replace('.git', ''); } catch { return url; }
}

// ========== 扫描导入 ==========

let scannedProjects = [];

async function startScan() {
  try {
    const dir = await invoke('open_pick_directory');
    if (!dir) return;
    el.scanStatus.textContent = '扫描中...';
    el.scanList.innerHTML = '';
    el.scanEmpty.style.display = 'none';
    el.scanModal.classList.add('active');

    scannedProjects = await invoke('scan_directory', { path: dir });

    el.scanStatus.textContent = `在 ${dir} 中发现 ${scannedProjects.length} 个项目`;

    if (!scannedProjects.length) {
      el.scanEmpty.style.display = '';
      return;
    }

    el.scanList.innerHTML = scannedProjects.map((p, i) => `
      <label class="scan-item" data-index="${i}">
        <input type="checkbox" checked class="scan-checkbox" />
        <div class="scan-item-info">
          <div class="scan-item-name">${esc(p.name)}</div>
          <div class="scan-item-path">${esc(p.path)}</div>
          ${p.remoteUrl ? `<div class="scan-item-url">${esc(p.remoteUrl)}</div>` : ''}
        </div>
      </label>
    `).join('');
  } catch (e) {
    console.error('扫描失败:', e);
    msg('扫描失败: ' + (e.message || e), 'error');
  }
}

function closeScanModal() {
  el.scanModal.classList.remove('active');
  scannedProjects = [];
}

async function importScanned() {
  const checkboxes = el.scanList.querySelectorAll('.scan-checkbox');
  const toImport = [];
  checkboxes.forEach((cb, i) => {
    if (cb.checked && scannedProjects[i]) {
      toImport.push(scannedProjects[i]);
    }
  });

  if (!toImport.length) {
    msg('请至少选择一个项目', 'error');
    return;
  }

  // 按本地路径去重，跳过已存在的项目，避免重复扫描导入产生重复条目
  const existingPaths = new Set(projects.map(p => p.localPath));

  let success = 0;
  let fail = 0;
  let skipped = 0;
  for (const p of toImport) {
    if (existingPaths.has(p.path)) {
      skipped++;
      continue;
    }
    try {
      await invoke('add_project', {
        name: p.name,
        localPath: p.path,
        remoteUrl: p.remoteUrl || '',
        machine: 'local',
        serverId: '',
        group: p.group || '',
        description: '',
      });
      existingPaths.add(p.path);
      success++;
    } catch (e) {
      console.error('导入失败:', p.name, e);
      fail++;
    }
  }

  closeScanModal();
  await load();

  const parts = [`${success} 个成功`];
  if (skipped) parts.push(`${skipped} 个已存在跳过`);
  if (fail) parts.push(`${fail} 个失败`);
  msg(`导入完成：${parts.join('，')}`, fail ? 'error' : 'success');
}

// ========== 内置终端 ==========

const termEl = {
  dock: $('terminal-dock'),
  backdrop: $('terminal-theme-backdrop'),
  tabs: $('terminal-tabs'),
  bodies: $('terminal-bodies'),
  characterStage: $('terminal-character-stage'),
  resize: $('terminal-resize'),
  newBtn: $('terminal-new-btn'),
  treeBtn: $('terminal-tree-btn'),
  usageBtn: $('terminal-usage-btn'),
  bellBtn: $('terminal-bell-btn'),
  snippetBtn: $('terminal-snippet-btn'),
  ideasBtn: $('terminal-ideas-btn'),
  ideasCount: $('terminal-ideas-count'),
  handoffBtn: $('terminal-handoff-btn'),
  ideasScrim: $('project-ideas-scrim'),
  ideasDrawer: $('project-ideas-drawer'),
  ideasTitle: $('project-ideas-title'),
  ideasProject: $('project-ideas-project'),
  ideaInput: $('project-idea-input'),
  ideaAdd: $('project-idea-add'),
  ideasSummary: $('project-ideas-summary'),
  ideasArchiveToggle: $('project-ideas-archive-toggle'),
  ideasList: $('project-ideas-list'),
  ideasEmpty: $('project-ideas-empty'),
  ideasOrphans: $('project-ideas-orphans'),
  ideasOrphansCount: $('project-ideas-orphans-count'),
  ideasOrphanList: $('project-ideas-orphans-list'),
  ideasClose: $('project-ideas-close'),
  memoryBtn: $('terminal-memory-btn'),
  memoryMenu: $('terminal-memory-menu'),
  layoutBtn: $('terminal-layout-btn'),
  layoutMenu: $('terminal-layout-menu'),
  fontBtn: $('terminal-font-btn'),
  fontMenu: $('terminal-font-menu'),
  fontValue: $('term-font-value'),
  themeBtn: $('terminal-theme-btn'),
  themeMenu: $('terminal-theme-menu'),
  maximizeBtn: $('terminal-maximize-btn'),
  collapseBtn: $('terminal-collapse-btn'),
  orchestraBar: $('orchestra-bar'),
  orchestraRoles: $('orchestra-roles'),
  orchestraInput: $('orchestra-input'),
  orchestraToBrain: $('orchestra-to-brain'),
  orchestraToWorkers: $('orchestra-to-workers'),
  orchestraBroadcast: $('orchestra-broadcast'),
  orchestraClose: $('orchestra-close'),
  fab: $('terminal-fab'),
  fabBadge: $('terminal-fab-badge'),
  tree: $('terminal-tree'),
  treeBody: $('tree-body'),
  treeRootName: $('tree-root-name'),
  treeRefreshBtn: $('tree-refresh-btn'),
  treeSplitter: $('tree-splitter'),
  sessionRail: $('session-rail'),
  sessionRailBody: $('session-rail-body'),
  sessionRailToggle: $('session-rail-toggle'),
  sessionRailSplitter: $('session-rail-splitter'),
  paneSplitterVertical: $('terminal-pane-splitter-vertical'),
  paneSplitterHorizontal: $('terminal-pane-splitter-horizontal'),
  main: document.querySelector('.terminal-main'),
  preview: $('file-preview'),
  previewName: $('file-preview-name'),
  previewText: $('file-preview-text'),
  previewLineNumbers: $('file-preview-line-numbers'),
  previewCode: $('file-preview-code'),
  previewImage: $('file-preview-image'),
  previewImg: $('file-preview-img'),
  previewRich: $('file-preview-rich'),
  previewPdf: $('file-preview-pdf'),
  previewToggle: $('file-preview-toggle'),
  previewEdit: $('file-preview-edit'),
  previewSave: $('file-preview-save'),
  previewCancel: $('file-preview-cancel'),
  previewStatus: $('file-preview-status'),
  previewBody: $('file-preview-body'),
  previewInsert: $('file-preview-insert'),
  previewClose: $('file-preview-close'),
  editor: $('file-editor'),
  editorLineNumbers: $('file-editor-line-numbers'),
  editorInput: $('file-editor-input'),
  editorMeta: $('file-editor-meta'),
  editorPosition: $('file-editor-position'),
};
const themePointer = installThemePointer(termEl.dock);
const characterTheme = installTerminalCharacterTheme(termEl.characterStage, termEl.dock, {
  onAvailabilityChange: () => {
    if (currentThemeDef && currentThemeDef.characterScene) applyTermBackground(currentThemeDef);
  },
  onError: error => appLog('warn', `国风分层人物已降级到静态原画：${error?.message || error}`),
});
let workspaceController = null;
let workspaceAutoMaximized = false;

// 标签一屏放不下时横向滚动查看；触控板本来能横滑，这里让鼠标竖向滚轮也能滚
termEl.tabs.addEventListener('wheel', (ev) => {
  if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
  if (termEl.tabs.scrollWidth <= termEl.tabs.clientWidth) return;
  ev.preventDefault();
  termEl.tabs.scrollLeft += ev.deltaY;
}, { passive: false });

// 主题资源路径集中定义，预设、DIY 和旧数据迁移共用，避免路径更新遗漏。
const SAKURA_BACKGROUND = 'assets/term-bg-sakura-v2.png';
const SAKURA_ICON = 'assets/theme-icon-sakura-v2.png';
const NEON_RAIN_BACKGROUND = 'assets/term-bg-neon-rain.png';
const NEON_RAIN_ICON = 'assets/theme-icon-neon-rain.png';
const GUOFENG_BACKGROUND = 'assets/term-bg-guofeng-beauty-retina.png';
const GUOFENG_ICON = 'assets/theme-icon-guofeng-beauty.png';
const LEGACY_SAKURA_BACKGROUND = 'assets/term-bg-kawaii.png';
const LEGACY_SAKURA_ICON = 'assets/theme-icon-sakura.png';
const LEGACY_GUOFENG_BACKGROUND = 'assets/term-bg-guofeng-beauty.png';

// 终端配色方案
const TERM_THEMES = {
  // 上一版原色（深蓝灰底）
  'classic': {
    name: '默认深色',
    icon: 'assets/theme-icon-classic.png',
    theme: { background: '#14171e', foreground: '#e6eaf2', cursor: '#1677ff' },
  },
  // macOS 终端 Homebrew 描述文件：黑底绿字 + 标准 ANSI 调色板
  'homebrew': {
    name: 'Homebrew',
    icon: 'assets/theme-icon-homebrew.png',
    theme: {
      background: '#000000', foreground: '#00ff00', cursor: '#23ff18', selectionBackground: '#0860a8',
      black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900',
      blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
      brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900', brightYellow: '#e5e500',
      brightBlue: '#0000ff', brightMagenta: '#e500e5', brightCyan: '#00e5e5', brightWhite: '#e5e5e5',
    },
  },
  // 樱花暮色：仅作 DIY 的深梅紫 base 调色板保留（hidden：不在主题菜单单列，
  // 招牌樱花主题由 initTermTheme 预装成「可删的自定义主题」，见 SAKURA_PRESET）。
  'sakura': {
    name: '🌸 樱花暮色',
    hidden: true,
    ui: 'sakura',
    solidBackground: '#2b1833',
    theme: {
      // 底色全透明：带图主题靠 DOM 渲染 + CSS 强制透明，让立绘透上来；文字对比靠 .terminal-bodies 暗化
      background: 'rgba(43, 24, 51, 0)', foreground: '#f7e7ef', cursor: '#f0a5c8',
      cursorAccent: '#2b1833', selectionBackground: 'rgba(234, 162, 197, 0.34)',
      black: '#34243d', red: '#f27f9d', green: '#99d6b9', yellow: '#e8c98c',
      blue: '#9f9ae8', magenta: '#df8fc2', cyan: '#95d7d4', white: '#e7d8e3',
      brightBlack: '#705a78', brightRed: '#f6a0b7', brightGreen: '#b4e4ca', brightYellow: '#f2dba8',
      brightBlue: '#bbb5f2', brightMagenta: '#edaad2', brightCyan: '#b5e7e4', brightWhite: '#fff4f8',
    },
    bg: { image: SAKURA_BACKGROUND, dim: 0.22, tint: '71, 31, 68', base: '#2b1833' },
    cursorFx: 'sakura',
    clickFx: true, // 点击迸出爱心/花瓣
  },
  // Image 2 生成的「霓虹雨夜」：和樱花一样只作为可编辑预装主题的配色 base，
  // hidden 避免菜单同时出现一份不可编辑内置项和一份可编辑预装项。
  'neon-rain': {
    name: '🌧️ 霓虹雨夜',
    hidden: true,
    ui: 'neon-rain',
    solidBackground: '#07111f',
    theme: {
      background: 'rgba(7, 17, 31, 0)', foreground: '#d7f5ff', cursor: '#40e0ff',
      cursorAccent: '#07111f', selectionBackground: 'rgba(64, 224, 255, 0.26)',
      black: '#07111f', red: '#ff6b8a', green: '#55e6b2', yellow: '#e8cf78',
      blue: '#66a8ff', magenta: '#b18cff', cyan: '#40e0ff', white: '#c8d9ec',
      brightBlack: '#53657d', brightRed: '#ff8ca2', brightGreen: '#79f2c5', brightYellow: '#f4df93',
      brightBlue: '#8bc0ff', brightMagenta: '#c6a8ff', brightCyan: '#83efff', brightWhite: '#f0f8ff',
    },
    bg: { image: NEON_RAIN_BACKGROUND, dim: 0.18, tint: '7, 17, 31', base: '#07111f' },
    cursorFx: 'neon-rain',
    clickFx: false,
  },
  // 黛月华裳：青黛、玉色与鎏金组成的国风配色；人物右置，左侧保留代码阅读区。
  'guofeng': {
    name: '🪷 黛月华裳',
    hidden: true,
    ui: 'guofeng',
    cursorFx: 'guofeng',
    // 图片主题的半透明输入区会放大块状光标的明暗切换；保持光标常亮，
    // 避免看起来像整条输入框随 1s 光标动画闪动。
    cursorBlink: false,
    solidBackground: '#0e1a1c',
    theme: {
      background: 'rgba(14, 26, 28, 0)', foreground: '#e8e0cf', cursor: '#d8aa53',
      cursorAccent: '#0e1a1c', selectionBackground: 'rgba(190, 70, 58, 0.32)',
      black: '#152326', red: '#cf665b', green: '#7fab86', yellow: '#d4b36a',
      blue: '#739ab3', magenta: '#ae7f98', cyan: '#72b3aa', white: '#d8d2c2',
      brightBlack: '#657578', brightRed: '#eb897d', brightGreen: '#a4c5a8', brightYellow: '#e6cb85',
      brightBlue: '#98b8cd', brightMagenta: '#c9a3b6', brightCyan: '#9fd1ca', brightWhite: '#fff7e6',
    },
    bg: {
      image: GUOFENG_BACKGROUND,
      dim: 0.22,
      tint: '14, 27, 29',
      base: '#0e1a1c',
      position: 'center 14%',
    },
    characterScene: { id: 'guofeng-beauty' },
    clickFx: true,
  },
};
let currentTheme = localStorage.getItem('term-theme') || 'classic';

// 应用终端图片背景：有 bg.image 时在独立背景层铺图并叠加遮罩，否则使用纯色底。
// 普通模式铺满 dock；并排模式由 CSS 收进左侧 Coding 区，xterm 保持透明。
function applyTermBackground(def) {
  const dock = termEl.dock, backdrop = termEl.backdrop, b = termEl.bodies;
  if (!dock || !backdrop || !b) return;
  if (def && def.bg && def.bg.image) {
    const dim = def.bg.dim != null ? def.bg.dim : 0.3;
    const tint = def.bg.tint || '20, 12, 20';
    // 背景层在普通模式覆盖整个 dock；并排模式由 CSS 将它收进左侧 Coding 区，
    // 使右置人物不会被网页/游戏面板盖住。头栏、侧栏和终端仍共享连续画面。
    dock.style.backgroundColor = def.bg.base || '#1b1420';
    dock.style.backgroundImage = 'none';
    backdrop.style.backgroundImage =
      `linear-gradient(rgba(${tint}, ${dim}), rgba(${tint}, ${dim})), url("${def.bg.image}")`;
    backdrop.style.backgroundSize = 'cover';
    backdrop.style.backgroundPosition = def.bg.position || 'center';
    backdrop.style.backgroundRepeat = 'no-repeat';
    dock.classList.add('has-bg');
    b.classList.add('has-bg');       // 触发 CSS 强制 xterm 各层透明，让 dock 背景透上来
    b.style.background = 'transparent';
    b.style.backgroundImage = 'none';
  } else {
    dock.classList.remove('has-bg');
    b.classList.remove('has-bg');
    dock.style.backgroundImage = 'none';
    dock.style.backgroundColor = '';   // 还原到 CSS 的 #1b1f27
    backdrop.style.backgroundImage = 'none';
    backdrop.style.backgroundSize = '';
    backdrop.style.backgroundPosition = '';
    backdrop.style.backgroundRepeat = '';
    b.style.backgroundImage = 'none';
    b.style.background = def.theme.background;
  }
}
if (!TERM_THEMES[currentTheme] && !String(currentTheme).startsWith('custom:')) currentTheme = 'classic';

// ===== DIY 自定义主题：换背景图 / 遮罩调节 / 多套保存（term-themes.json）+ 点击特效 =====
let termCustomThemes = [];       // 自定义主题表（get_term_themes 拉取）
let currentThemeDef = TERM_THEMES[currentTheme] || TERM_THEMES.classic; // custom:* 启动先兜底，initTermTheme 精确应用
const themeImageCache = new Map(); // 'file:<name>' → data URL，避免重复 IPC 读图

// 主题 key（内置 key 或 'custom:<id>'）→ 可应用的 def {name, theme, bg?, clickFx}
async function resolveThemeDef(key) {
  if (TERM_THEMES[key]) return TERM_THEMES[key];
  if (String(key).startsWith('custom:')) {
    const t = termCustomThemes.find(x => x.id === key.slice(7));
    if (t) return buildCustomDef(t);
  }
  return TERM_THEMES.classic;
}

async function buildCustomDef(t) {
  const base = TERM_THEMES[t.base] || TERM_THEMES.classic;
  const def = {
    name: t.name,
    theme: { ...base.theme },
    clickFx: !!t.clickFx,
    ui: base.ui || '',
    cursorFx: base.cursorFx || '',
    cursorBlink: base.cursorBlink !== false,
    characterScene: base.characterScene && t.image === `builtin:${base.bg?.image}`
      ? { ...base.characterScene }
      : null,
  };
  const url = await resolveThemeImage(t.image);
  if (url) {
    def.theme.background = 'rgba(0, 0, 0, 0)'; // 带图必须全透底，立绘才透得上来
    def.bg = {
      image: url,
      dim: t.dim != null ? t.dim : 0.3,
      tint: t.tint || '120, 45, 95',
      base: (base.bg && base.bg.base) || base.solidBackground || '#1b1420',
      position: base.bg && t.image === `builtin:${base.bg.image}` ? base.bg.position : 'center',
    };
  } else {
    // 带图 base 的调色板背景本身是透明的；用户切到「无图」时必须补回实色。
    def.theme.background = base.solidBackground || base.theme.background;
  }
  return def;
}

// 背景图引用 → 可用 URL："builtin:<path>" 直接用；"file:<name>" 走后端读成 data URL 并缓存
async function resolveThemeImage(image) {
  if (!image) return '';
  if (image.startsWith('builtin:')) return image.slice(8);
  if (image.startsWith('file:')) {
    if (themeImageCache.has(image)) return themeImageCache.get(image);
    try {
      const url = await invoke('load_theme_image', { name: image.slice(5) });
      themeImageCache.set(image, url);
      return url;
    } catch (e) { appLog('error', '加载主题背景图失败：' + e); return ''; }
  }
  return image;
}

// 把解析好的 def 应用到所有会话与 dock（DIY 面板实时预览也走这里，不落盘）
function applyThemeDef(def) {
  currentThemeDef = def;
  termEl.dock.dataset.themeUi = def.ui || '';
  const hasBg = !!def.bg;
  themePointer.applyTheme({
    cursor: hasBg ? def.cursorFx : '',
    clickFx: !!def.clickFx,
    effect: def.cursorFx,
  });
  sessions.forEach(s => {
    clearImageTerminalCellBackgrounds(s.bodyEl);
    s.term.options.theme = def.theme;
    // 仅明确关闭的主题使用常亮光标；切回其他主题时同步恢复闪烁。
    s.term.options.cursorBlink = def.cursorBlink !== false;
    // 带图主题必须 DOM 渲染：拆掉 WebGL；切回无图主题再装回（恢复防 ghosting）
    if (hasBg && s.webgl) { try { s.webgl.dispose(); } catch (_) {} s.webgl = null; }
    else if (!hasBg && !s.webgl) { s.webgl = attachWebgl(s.term); }
    clearTermAtlas(s.term);
    if (hasBg) scheduleImageCellBackgroundSync(s);
  });
  characterTheme.applyTheme(def.characterScene?.id || '');
  applyTermBackground(def);
}

// 预装「樱花暮色」主题：Image 2 立绘作为可编辑可删除的自定义主题。
// base 仍指向 TERM_THEMES.sakura 的深梅紫调色板(hidden 保留),icon 用专属花朵图。
const SAKURA_PRESET = {
  id: 'sakura-default', name: '🌸 樱花暮色', base: 'sakura',
  image: `builtin:${SAKURA_BACKGROUND}`, dim: 0.22, tint: '71, 31, 68',
  clickFx: true, icon: SAKURA_ICON, createdAt: '',
};
const NEON_RAIN_PRESET = {
  id: 'neon-rain-default', name: '🌧️ 霓虹雨夜', base: 'neon-rain',
  image: `builtin:${NEON_RAIN_BACKGROUND}`, dim: 0.18, tint: '7, 17, 31',
  clickFx: false, icon: NEON_RAIN_ICON, createdAt: '',
};
const GUOFENG_PRESET = {
  id: 'guofeng-beauty-default', name: '🪷 黛月华裳', base: 'guofeng',
  image: `builtin:${GUOFENG_BACKGROUND}`, dim: 0.22, tint: '14, 27, 29',
  clickFx: true, icon: GUOFENG_ICON, createdAt: '',
};

// 启动：拉自定义主题表 + 恢复上次主题（可能是 custom:*）
async function initTermTheme() {
  try { termCustomThemes = await invoke('get_term_themes'); } catch (_) { termCustomThemes = []; }
  // 旧资源已从安装包移除：所有仍引用旧内置图的主题都换到 v2，避免自定义主题断图。
  // 名称、遮罩和浓度只迁移默认樱花项，其他用户设置保持不动。
  let themesDirty = false;
  termCustomThemes.forEach(t => {
    let migrated = false;
    if (t.image === `builtin:${LEGACY_SAKURA_BACKGROUND}`) {
      t.image = SAKURA_PRESET.image;
      migrated = true;
    }
    if (t.icon === LEGACY_SAKURA_ICON) {
      t.icon = SAKURA_PRESET.icon;
      migrated = true;
    }
    if (t.image === `builtin:${LEGACY_GUOFENG_BACKGROUND}`) {
      t.image = GUOFENG_PRESET.image;
      migrated = true;
    }
    if (t.id === SAKURA_PRESET.id && t.base === 'sakura') {
      if (t.name === '🌸 樱花') { t.name = SAKURA_PRESET.name; migrated = true; }
      if (t.dim === 0.30) { t.dim = SAKURA_PRESET.dim; migrated = true; }
      if (t.tint === '120, 45, 95') { t.tint = SAKURA_PRESET.tint; migrated = true; }
    }
    themesDirty ||= migrated;
  });

  // 每个预装主题各有一次性标记：用户删掉后不复活；首次保存失败则不写标记，下次启动重试。
  const themeSeeds = [
    ['term-sakura-seeded', SAKURA_PRESET],
    ['term-neon-rain-seeded', NEON_RAIN_PRESET],
    ['term-guofeng-beauty-seeded', GUOFENG_PRESET],
  ];
  const seedResult = await seedThemePresets({
    themes: termCustomThemes,
    entries: themeSeeds,
    hasMarker: marker => !!localStorage.getItem(marker),
    markMarker: marker => localStorage.setItem(marker, '1'),
    saveThemes: themes => invoke('save_term_themes', { themes }),
    dirty: themesDirty,
  });
  termCustomThemes = seedResult.themes;
  if (seedResult.error) appLog('error', '保存预装终端主题失败：' + seedResult.error);

  // 老用户此前选中的是已降级的内置樱花时，迁移到可编辑预装项。
  if (currentTheme === 'sakura') {
    currentTheme = termCustomThemes.some(t => t.id === SAKURA_PRESET.id)
      ? 'custom:' + SAKURA_PRESET.id
      : 'classic';
    localStorage.setItem('term-theme', currentTheme);
  } else if (
    String(currentTheme).startsWith('custom:') &&
    !termCustomThemes.some(t => t.id === currentTheme.slice(7))
  ) {
    // JSON 被恢复/手动修改后，不能让 localStorage 永久指向不存在的主题。
    currentTheme = 'classic';
    localStorage.setItem('term-theme', currentTheme);
  }
  try { applyThemeDef(await resolveThemeDef(currentTheme)); } catch (_) {}
}

// —— DIY 面板：所有控件改动实时预览，保存整表回写 term-themes.json ——
const DIY_BASES = [
  ['guofeng', '黛月华裳'],
  ['sakura', '樱花暮色'],
  ['neon-rain', '霓虹雨夜'],
  ['classic', '默认深色'],
];
const DIY_TINTS = [
  { name: '青黛', v: '14, 27, 29' },
  { name: '玫瑰粉', v: '120, 45, 95' },
  { name: '薰衣草', v: '96, 64, 160' },
  { name: '薄荷', v: '30, 90, 75' },
  { name: '天蓝', v: '40, 70, 140' },
  { name: '暗夜', v: '20, 12, 20' },
];
let diyEl = null, diyEditing = null, diyPrevKey = null;

function ensureDiyPanel() {
  if (diyEl) return;
  diyEl = document.createElement('div');
  diyEl.className = 'term-diy';
  diyEl.innerHTML =
    `<div class="term-diy-head"><span>DIY 主题</span>` +
    `<span class="term-diy-x" title="取消并关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg></span></div>` +
    `<div class="term-diy-row"><label>名称</label><input class="term-diy-input" id="diy-name" placeholder="我的主题" maxlength="12"></div>` +
    `<div class="term-diy-row"><label>配色</label><div class="term-diy-chips" id="diy-base"></div></div>` +
    `<div class="term-diy-row"><label>背景</label><div class="term-diy-chips" id="diy-img"></div></div>` +
    `<div class="term-diy-row"><label>遮罩</label><div class="term-diy-swatches" id="diy-tint"></div></div>` +
    `<div class="term-diy-row"><label>浓度</label><input type="range" id="diy-dim" min="0" max="0.7" step="0.02"><span class="term-diy-dimval" id="diy-dim-val"></span></div>` +
    `<div class="term-diy-row"><label>特效</label><label class="term-diy-fx"><input type="checkbox" id="diy-fx"> 点击主题粒子</label></div>` +
    `<div class="term-diy-btns">` +
    `<button class="btn btn-danger btn-sm" id="diy-del" style="display:none;">删除</button>` +
    `<span class="term-diy-spacer"></span>` +
    `<button class="btn btn-default btn-sm" id="diy-cancel">取消</button>` +
    `<button class="btn btn-primary btn-sm" id="diy-save">保存</button></div>`;
  termEl.dock.appendChild(diyEl);
  diyEl.querySelector('.term-diy-x').onclick = diyCancel;
  diyEl.querySelector('#diy-cancel').onclick = diyCancel;
  diyEl.querySelector('#diy-save').onclick = diySave;
  diyEl.querySelector('#diy-del').onclick = diyDelete;
  diyEl.querySelector('#diy-name').oninput = (e) => { diyEditing.name = e.target.value; };
  diyEl.querySelector('#diy-dim').oninput = (e) => {
    diyEditing.dim = parseFloat(e.target.value);
    diyEl.querySelector('#diy-dim-val').textContent = Math.round(diyEditing.dim * 100) + '%';
    diyPreview();
  };
  diyEl.querySelector('#diy-fx').onchange = (e) => { diyEditing.clickFx = e.target.checked; diyPreview(); };
}

function fillDiyForm() {
  diyEl.querySelector('#diy-name').value = diyEditing.name || '';
  diyEl.querySelector('#diy-dim').value = diyEditing.dim;
  diyEl.querySelector('#diy-dim-val').textContent = Math.round(diyEditing.dim * 100) + '%';
  diyEl.querySelector('#diy-fx').checked = !!diyEditing.clickFx;
  diyEl.querySelector('#diy-del').style.display =
    diyEditing.id && termCustomThemes.some(t => t.id === diyEditing.id) ? '' : 'none';
  // 基础配色
  const baseBox = diyEl.querySelector('#diy-base');
  baseBox.innerHTML = '';
  DIY_BASES.forEach(([key, name]) => {
    const c = document.createElement('span');
    c.className = 'term-diy-chip' + (diyEditing.base === key ? ' on' : '');
    c.textContent = name;
    c.onclick = () => { diyEditing.base = key; fillDiyForm(); diyPreview(); };
    baseBox.appendChild(c);
  });
  // 背景图：无图 / 预装背景 / 选本地图片（拷入 appdata，生成的新图从这里换上）
  const imgBox = diyEl.querySelector('#diy-img');
  imgBox.innerHTML = '';
  const isFile = (diyEditing.image || '').startsWith('file:');
  [
    ['', '无图'],
    [`builtin:${GUOFENG_BACKGROUND}`, '黛月华裳'],
    [`builtin:${SAKURA_BACKGROUND}`, '樱花暮色'],
    [`builtin:${NEON_RAIN_BACKGROUND}`, '霓虹雨夜'],
  ].forEach(([v, name]) => {
    const c = document.createElement('span');
    c.className = 'term-diy-chip' + (diyEditing.image === v ? ' on' : '');
    c.textContent = name;
    c.onclick = () => { diyEditing.image = v; fillDiyForm(); diyPreview(); };
    imgBox.appendChild(c);
  });
  const pick = document.createElement('span');
  pick.className = 'term-diy-chip' + (isFile ? ' on' : '');
  pick.textContent = isFile ? '已选图片 · 重选…' : '选择图片…';
  pick.onclick = async () => {
    try {
      const name = await invoke('pick_theme_image');
      if (name) { diyEditing.image = 'file:' + name; fillDiyForm(); diyPreview(); }
    } catch (e) { msg('选图失败：' + e, 'error'); }
  };
  imgBox.appendChild(pick);
  // 遮罩色
  const tintBox = diyEl.querySelector('#diy-tint');
  tintBox.innerHTML = '';
  DIY_TINTS.forEach(t => {
    const s = document.createElement('span');
    s.className = 'term-diy-swatch' + (diyEditing.tint === t.v ? ' on' : '');
    s.title = t.name;
    s.style.background = `rgb(${t.v})`;
    s.onclick = () => { diyEditing.tint = t.v; fillDiyForm(); diyPreview(); };
    tintBox.appendChild(s);
  });
}

function openDiyPanel(theme) {
  ensureDiyPanel();
  diyPrevKey = currentTheme;
  diyEditing = theme
    ? { ...theme }
    : {
        id: '', name: '', base: 'sakura', image: SAKURA_PRESET.image,
        dim: SAKURA_PRESET.dim, tint: SAKURA_PRESET.tint, clickFx: true, createdAt: '',
      };
  fillDiyForm();
  diyEl.classList.add('active');
  diyPreview();
}

async function diyPreview() {
  try { applyThemeDef(await buildCustomDef(diyEditing)); } catch (_) {}
}

async function diyCancel() {
  diyEl.classList.remove('active');
  diyEditing = null;
  try { applyThemeDef(await resolveThemeDef(diyPrevKey)); } catch (_) {}
  renderThemeMenu();
}

async function diySave() {
  if (!diyEditing) return;
  if (!diyEditing.name.trim()) diyEditing.name = '我的主题';
  if (!diyEditing.id) diyEditing.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nextThemes = termCustomThemes.map(t => ({ ...t }));
  const i = termCustomThemes.findIndex(t => t.id === diyEditing.id);
  if (i >= 0) nextThemes[i] = { ...diyEditing };
  else nextThemes.push({ ...diyEditing });
  try {
    termCustomThemes = await invoke('save_term_themes', { themes: nextThemes });
  } catch (e) { msg('保存失败：' + e, 'error'); return; }
  const key = 'custom:' + diyEditing.id;
  diyEl.classList.remove('active');
  diyEditing = null;
  await setTermTheme(key);
  msg('主题已保存', 'success');
}

function diyDelete() {
  if (!diyEditing || !diyEditing.id) return;
  const deletedId = diyEditing.id;
  const deletedKey = 'custom:' + deletedId;
  const deletedName = diyEditing.name || '未命名主题';
  askConfirm('主题', deletedName, async () => {
    const nextThemes = termCustomThemes.filter(t => t.id !== deletedId);
    termCustomThemes = await invoke('save_term_themes', { themes: nextThemes });
    diyEl.classList.remove('active');
    diyEditing = null;
    await setTermTheme(diyPrevKey === deletedKey ? 'classic' : diyPrevKey);
    msg('主题已删除', 'success');
  });
}

// 终端字号（⌘+ / ⌘- / ⌘0 调整，⌘+滚轮缩放，持久化）
const TERM_FONT_MIN = 8, TERM_FONT_MAX = 32, TERM_FONT_DEFAULT = 13;
let currentFontSize = parseInt(localStorage.getItem('term-fontsize'), 10) || TERM_FONT_DEFAULT;
if (currentFontSize < TERM_FONT_MIN || currentFontSize > TERM_FONT_MAX) currentFontSize = TERM_FONT_DEFAULT;

const sessions = new Map(); // id -> { term, fit, tabEl, bodyEl, name, status, attention }
let activeSession = null;
let termSeq = 0;
let termEventsBound = false;
let terminalPaneLayout = 'single';
let terminalPaneAssignments = [null];
let terminalFitFrame = 0;
let terminalFitTimer = null;
let terminalFitLastRunAt = 0;
let terminalFitForceResize = false;
const TERMINAL_RESIZE_INTERVAL_MS = 100;

const TERMINAL_LAYOUT_LABELS = {
  single: '单窗',
  columns: '左右分屏',
  rows: '上下分屏',
  main: '主从分屏',
  grid: '四宫格',
};

const sessionCloseCoordinator = createTerminalSessionCloseCoordinator({
  closeBackend: id => invoke('terminal_close', { id }),
  onClosed: finalizeSessionClose,
  onError: error => msg('关闭终端失败: ' + (error?.message || error), 'error'),
});

function scheduleImageCellBackgroundSync(session, renderRange = null) {
  if (!session || !(currentThemeDef && currentThemeDef.bg)) return;
  scheduleCellBackgroundSync(session, renderRange, range => {
    if (!session.bodyEl.isConnected || !(currentThemeDef && currentThemeDef.bg)) return;
    syncImageTerminalCellBackgrounds(session.bodyEl, range);
  });
}

// ===== 会话状态感知：AI 跑完/在等你时提醒 =====
let notifyEnabled = localStorage.getItem('term-notify') !== '0'; // 默认开
function applyBellState() {
  termEl.bellBtn.classList.toggle('active', notifyEnabled);
  termEl.bellBtn.title = notifyEnabled
    ? '会话提醒：开（AI 跑完/在等你时通知，点击关闭）'
    : '会话提醒：关（点击开启）';
}
function toggleNotify() {
  notifyEnabled = !notifyEnabled;
  localStorage.setItem('term-notify', notifyEnabled ? '1' : '0');
  applyBellState();
  msg(notifyEnabled ? '会话提醒已开启' : '会话提醒已关闭', notifyEnabled ? 'success' : 'info');
}
// 提示音（Web Audio，无需权限）
let audioCtx = null;
function beep() {
  try {
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    audioCtx = audioCtx || new AC();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine'; o.frequency.setValueAtTime(880, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.start(t); o.stop(t + 0.32);
  } catch (_) {}
}
// 是否该弹系统通知：开关开 且 用户没在盯着这个会话看（在看就别打扰）
function shouldNotify(id) {
  if (!notifyEnabled) return false;
  const focusedOnIt = document.hasFocus()
    && developerTerminalVisible()
    && activeSession === id;
  return !focusedOnIt;
}
function markAttention(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.attention = true;
  s.tabEl.classList.add('attention');
  updateTerminalPaneStatus(s);
  updateFabBadge();
}
function clearAttention(id) {
  const s = sessions.get(id);
  if (!s || !s.attention) return;
  s.attention = false;
  s.tabEl.classList.remove('attention');
  updateTerminalPaneStatus(s);
  updateFabBadge();
}

// ===== 会话恢复：记住上次的终端标签布局，重开应用一键还原 =====
// PTY 进程随应用退出无法真正续命，恢复的是"布局"——同目录、同 CLI 重新拉起；
// Claude/OpenCode/Grok 用 --continue，Codex 用 resume --last 接回该项目目录最近的对话。
function persistSessionLayout() {
  const layout = sessionLayoutEntries(sessions);
  try { localStorage.setItem('term-session-layout', JSON.stringify(layout)); } catch (_) {}
}
function maybeRestoreSessions() {
  let layout;
  try { layout = JSON.parse(localStorage.getItem('term-session-layout') || '[]'); } catch (_) { layout = []; }
  if (!Array.isArray(layout) || !layout.length) return;
  // 问一次就把记录清掉：恢复会重新落盘最新布局，取消则不再纠缠
  localStorage.removeItem('term-session-layout');
  const cmds = layout.filter(it => it && typeof it.autoCmd === 'string' && it.autoCmd)
    .map(it => cliToolName(it.autoCmd));
  const hasClaude = cmds.includes('claude');
  const hasCodex = cmds.includes('codex');
  const hasOpencode = cmds.includes('opencode');
  const hasGrok = cmds.includes('grok');
  const resumeNotes = [];
  if (hasClaude) resumeNotes.push('Claude 标签会用 --continue 接上次对话。');
  if (hasCodex) resumeNotes.push('Codex 标签会按项目目录续接最近一次对话。');
  if (hasOpencode) resumeNotes.push('OpenCode 标签会用 --continue 接上次对话。');
  if (hasGrok) resumeNotes.push('Grok 标签会用 --continue 接上次对话。');
  showConfirm({
    title: '恢复终端会话',
    message: `上次有 ${layout.length} 个终端会话，要恢复吗？\n同目录重新拉起对应 CLI。${resumeNotes.length ? '\n' + resumeNotes.join('\n') : ''}`,
    confirmText: '恢复',
    danger: false,
    onConfirm: () => restoreSessions(layout),
  });
}
async function restoreSessions(layout) {
  await restoreSessionLayout(layout, options => createSession({
    ...options,
    name: projectTabName(options.cwd, options.name),
  }));
}

// ===== Prompt/Snippet 库：常用指令一键注入当前终端 =====
const SNIPPET_ICONS = {
  inject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5 5 5-5M12 14V3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166M18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
function snippetPreview(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > 44 ? t.slice(0, 44) + '…' : t;
}

let snippetMenuRevision = 0;
let snippetMenuOpening = false;

async function openSnippetMenu(anchorEl) {
  const revision = ++snippetMenuRevision;
  snippetMenuOpening = true;
  closeMemoryMenu();
  const webviewHidden = await workspaceController?.setFloatingUiOpen('snippet-menu', true);
  if (revision !== snippetMenuRevision) return;
  if (webviewHidden === false) {
    snippetMenuOpening = false;
    return;
  }
  snippetMenuOpening = false;
  const menu = $('snippet-menu');
  renderSnippetMenu();
  menu.classList.add('active'); // 先显示以测量尺寸
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, r.right - menu.offsetWidth);
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 6;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function toggleSnippetMenu(anchorEl) {
  const menu = $('snippet-menu');
  if (snippetMenuOpening || menu.classList.contains('active')) closeSnippetMenu();
  else void openSnippetMenu(anchorEl);
}

function closeSnippetMenu() {
  const menu = $('snippet-menu');
  const wasOpen = snippetMenuOpening || menu.classList.contains('active');
  snippetMenuRevision += 1;
  snippetMenuOpening = false;
  menu.classList.remove('active');
  if (wasOpen) void workspaceController?.setFloatingUiOpen('snippet-menu', false);
}

let memoryMenuRevision = 0;
let memoryMenuOpening = false;
let memoryMenuState = null;
let memoryUnifyOp = 0;

function shortHomePath(path) {
  const value = String(path || '');
  return value.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function readMemoryUnifyPaths() {
  try {
    return loadProjectMemoryUnifyPaths(localStorage.getItem(PROJECT_MEMORY_UNIFY_STORAGE_KEY));
  } catch {
    return [];
  }
}

function persistMemoryUnifyPaths(paths) {
  try {
    localStorage.setItem(PROJECT_MEMORY_UNIFY_STORAGE_KEY, JSON.stringify({ paths }));
  } catch (_) {}
}

function renderMemoryMenu(state, cwd) {
  const menu = termEl.memoryMenu;
  if (!cwd) {
    menu.innerHTML = '<div class="memory-menu-empty">当前终端没有项目目录</div>';
    return;
  }
  const unifyOn = isProjectMemoryUnifyEnabled(cwd, readMemoryUnifyPaths());
  if (unifyOn && !state) {
    menu.innerHTML = '<div class="memory-menu-empty">正在挂载项目记忆…</div>';
    return;
  }
  const statusClass = unifyOn
    ? (state?.mounted ? '' : (state?.warning ? 'is-warn' : 'is-empty'))
    : 'is-empty';
  const statusText = unifyOn ? (state?.mounted ? '已挂载' : (state?.warning ? '异常' : '未挂载')) : '未开启';
  const topics = Array.isArray(state?.topics) ? state.topics : [];
  const topicHtml = unifyOn
    ? (topics.length
      ? `<div class="memory-menu-label">索引</div><div class="memory-menu-topics">${
        topics.map(topic => `<div class="memory-menu-topic" title="${escAttr(topic.file || '')}">${esc(topic.title)}</div>`).join('')
      }</div>`
      : '<div class="memory-menu-label">索引</div><div class="memory-menu-path">还没有专题。说「更新记忆」后会出现在这里。</div>')
    : '<p class="memory-menu-path">默认不强制。打开后，从这个目录启动的 Claude / Codex / Grok / OpenCode 才会共用 Claude 那份记忆。</p>';
  const inbox = unifyOn && Number(state?.inboxCount) > 0
    ? `<div class="memory-menu-path">inbox ${esc(String(state.inboxCount))} 条待合并</div>`
    : '';
  const warning = unifyOn && state?.warning ? `<p class="memory-menu-note">${esc(state.warning)}</p>` : '';
  menu.innerHTML =
    `<div class="memory-menu-head"><span class="memory-menu-title">项目记忆</span><span class="memory-menu-status ${statusClass}">${statusText}</span></div>` +
    `<label class="memory-menu-switch"><input type="checkbox" id="memory-unify-toggle"${unifyOn ? ' checked' : ''}>统一记忆到 Claude</label>` +
    (unifyOn
      ? `<p class="memory-menu-path" title="${escAttr(state?.memoryPath || cwd)}">${esc(shortHomePath(state?.memoryPath || cwd))}</p>`
      : '') +
    warning +
    topicHtml +
    inbox +
    (unifyOn
      ? `<div class="memory-menu-actions">` +
          `<button class="btn btn-default" type="button" data-memory-act="open"${state?.memoryPath ? '' : ' disabled'}>打开目录</button>` +
          `<button class="btn btn-primary" type="button" data-memory-act="remount">重新挂载</button>` +
        `</div>`
      : '');
  const toggle = menu.querySelector('#memory-unify-toggle');
  if (toggle) {
    toggle.onchange = async () => {
      const wanted = toggle.checked;
      const revision = memoryMenuRevision;
      const op = ++memoryUnifyOp;
      toggle.disabled = true;
      const session = activeSession ? sessions.get(activeSession) : null;
      try {
        if (wanted) {
          const next = await mountProjectMemory(cwd, session);
          if (revision !== memoryMenuRevision || op !== memoryUnifyOp) return;
          if (next?.mounted) {
            persistMemoryUnifyPaths(setProjectMemoryUnifyEnabled(cwd, true, readMemoryUnifyPaths()));
          } else if (next?.warning) {
            msg(next.warning, 'error');
          }
          memoryMenuState = next;
          renderMemoryMenu(next, cwd);
          return;
        }
        await invoke('detach_project_memory', { path: cwd });
        if (revision !== memoryMenuRevision || op !== memoryUnifyOp) return;
        persistMemoryUnifyPaths(setProjectMemoryUnifyEnabled(cwd, false, readMemoryUnifyPaths()));
        if (session) session.memory = null;
        memoryMenuState = null;
        renderMemoryMenu(null, cwd);
      } catch (error) {
        if (revision !== memoryMenuRevision || op !== memoryUnifyOp) return;
        msg((wanted ? '挂载' : '关闭') + '统一记忆失败: ' + (error?.message || error), 'error');
        renderMemoryMenu(session?.memory || null, cwd);
      }
    };
  }
  menu.querySelectorAll('[data-memory-act]').forEach(button => {
    button.onclick = async () => {
      if (button.dataset.memoryAct === 'open' && state?.memoryPath) {
        try { await invoke('open_folder', { path: state.memoryPath }); }
        catch (error) { msg('打开记忆目录失败: ' + (error?.message || error), 'error'); }
        return;
      }
      if (button.dataset.memoryAct === 'remount') {
        const next = await mountProjectMemory(cwd);
        memoryMenuState = next;
        renderMemoryMenu(next, cwd);
      }
    };
  });
}

async function mountProjectMemory(cwd, session = null) {
  if (!shouldMountProjectMemory(cwd)) return null;
  try {
    const state = await invoke('ensure_project_memory', { path: cwd });
    if (session) session.memory = state;
    return state;
  } catch (error) {
    const warning = error?.message || String(error);
    const failed = { mounted: false, skipped: false, warning, topics: [], inboxCount: 0, memoryPath: '' };
    if (session) session.memory = failed;
    return failed;
  }
}

function writeMemoryBanner(term, state) {
  const line = memoryBannerText(state);
  if (!term || !line) return;
  term.write(`\r\n\x1b[90m${line}\x1b[0m\r\n`);
}

async function openMemoryMenu(anchorEl) {
  const revision = ++memoryMenuRevision;
  memoryMenuOpening = true;
  const webviewHidden = await workspaceController?.setFloatingUiOpen('memory-menu', true);
  if (revision !== memoryMenuRevision) return;
  if (webviewHidden === false) {
    memoryMenuOpening = false;
    return;
  }
  memoryMenuOpening = false;
  const session = activeSession ? sessions.get(activeSession) : null;
  const cwd = session?.cwd || '';
  termEl.memoryMenu.classList.add('active');
  termEl.memoryBtn.setAttribute('aria-expanded', 'true');
  renderMemoryMenu(session?.memory || null, cwd);
  if (cwd && isProjectMemoryUnifyEnabled(cwd, readMemoryUnifyPaths())) {
    const state = await mountProjectMemory(cwd, session);
    if (revision !== memoryMenuRevision) return;
    memoryMenuState = state;
    renderMemoryMenu(state, cwd);
  }
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, r.right - termEl.memoryMenu.offsetWidth);
  let top = r.bottom + 6;
  if (top + termEl.memoryMenu.offsetHeight > window.innerHeight - 8) {
    top = r.top - termEl.memoryMenu.offsetHeight - 6;
  }
  termEl.memoryMenu.style.left = left + 'px';
  termEl.memoryMenu.style.top = top + 'px';
}

function toggleMemoryMenu(anchorEl) {
  if (memoryMenuOpening || termEl.memoryMenu.classList.contains('active')) closeMemoryMenu();
  else void openMemoryMenu(anchorEl);
}

function closeMemoryMenu() {
  const wasOpen = memoryMenuOpening || termEl.memoryMenu.classList.contains('active');
  memoryMenuRevision += 1;
  memoryMenuOpening = false;
  termEl.memoryMenu.classList.remove('active');
  termEl.memoryBtn.setAttribute('aria-expanded', 'false');
  if (wasOpen) void workspaceController?.setFloatingUiOpen('memory-menu', false);
}

function renderSnippetMenu() {
  const menu = $('snippet-menu');
  const items = snippets.length
    ? snippets.map(s => `
        <div class="snippet-item" data-id="${s.id}" title="${escAttr(s.content)}">
          <span class="snippet-item-title">${esc(s.title)}</span>
          <span class="snippet-item-preview">${esc(snippetPreview(s.content))}</span>
        </div>`).join('')
    : '<div class="snippet-menu-empty">暂无片段，点下方「管理」添加</div>';
  menu.innerHTML = items
    + '<div class="snippet-menu-sep"></div>'
    + `<div class="snippet-item snippet-item-manage" data-manage="1">${SNIPPET_ICONS.edit}<span>管理片段…</span></div>`;
  menu.querySelectorAll('.snippet-item').forEach(it => {
    it.onclick = () => {
      if (it.dataset.manage) { closeSnippetMenu(); openSnippetModal(); return; }
      const s = snippets.find(x => x.id === it.dataset.id);
      closeSnippetMenu();
      if (s) injectSnippet(s.content);
    };
  });
}

async function injectSnippet(content, send = false) {
  if (!content) return;
  let id = activeSession;
  if (!id || !sessions.has(id)) {
    id = await createSession({}); // 没有活动终端就先开一个空白的
  }
  openDock();
  // send=true：注入后追加回车（\r）直接发送；先去掉结尾换行，避免多发空行
  const data = send ? content.replace(/[\r\n]+$/, '') + '\r' : content;
  try { await invoke('terminal_write', { id, data }); }
  catch (e) { msg('注入失败: ' + (e.message || e), 'error'); return; }
  sessions.get(id)?.term.focus();
}

// ---- 片段管理 Modal ----
let snippetEditId = null;
function openSnippetModal() {
  clearSnippetEditor();
  renderSnippetList();
  $('snippet-modal-overlay').classList.add('active');
}
function closeSnippetModal() { $('snippet-modal-overlay').classList.remove('active'); }
function clearSnippetEditor() {
  snippetEditId = null;
  $('snippet-title').value = '';
  $('snippet-content').value = '';
  $('snippet-edit-hint').textContent = '';
  $('snippet-save-btn').textContent = '保存片段';
  setSnippetSchedUI(null);
}
function loadSnippetIntoEditor(s) {
  snippetEditId = s.id;
  $('snippet-title').value = s.title;
  $('snippet-content').value = s.content;
  $('snippet-edit-hint').textContent = '编辑中：' + s.title;
  $('snippet-save-btn').textContent = '更新片段';
  setSnippetSchedUI(s.schedule);
  $('snippet-title').focus();
}
async function saveSnippetFromEditor() {
  const title = $('snippet-title').value.trim();
  const content = $('snippet-content').value;
  if (!title) { msg('请填写标题', 'error'); $('snippet-title').focus(); return; }
  if (!content.trim()) { msg('请填写内容', 'error'); $('snippet-content').focus(); return; }
  const schedule = readSnippetSchedUI();
  if (snippetEditId) {
    const s = snippets.find(x => x.id === snippetEditId);
    if (s) {
      // 模式没变就保留原有启用/暂停状态——改标题/内容不应悄悄重新启用已暂停的定时
      if (schedule && s.schedule && s.schedule.mode === schedule.mode) {
        schedule.enabled = s.schedule.enabled;
      }
      s.title = title; s.content = content; s.schedule = schedule;
    }
    schedRuntime.delete(snippetEditId); // 配置变了，重置该片段的定时运行态
  } else {
    snippets.push({ id: '', title, content, createdAt: '', schedule });
  }
  try { await persistSnippets(); } catch (_) { return; } // 保存失败已弹错，别再弹「已保存」
  clearSnippetEditor();
  renderSnippetList();
  msg('已保存', 'success');
}
// 串行化保存，避免快速增改时整表快照乱序覆盖。
// 关键：不再用后端返回值整体替换数组——那会把「保存在途期间新增/删除的条目」一并覆盖丢掉。
// 改为按发送顺序把后端补的 id/时间戳回填到原对象引用上（后端保持顺序、只补空字段）。
// 保存失败时上抛（且弹错），让调用方据此不再弹「已保存」等假成功提示。
let snippetSaveChain = Promise.resolve();
function persistSnippets() {
  const run = snippetSaveChain.then(async () => {
    const snapshot = snippets.slice(); // 定格本次发送的成员引用
    const saved = await invoke('save_snippets', { snippets: snapshot });
    backfillMeta(snapshot, saved, ['id', 'createdAt']);
    renderSnippetQuick();
  }).catch(e => { msg('保存失败: ' + (e.message || e), 'error'); throw e; });
  snippetSaveChain = run.catch(() => {}); // 链子始终保持 resolved，避免一次失败后续保存全被跳过
  return run;
}

// 终端右下角片段快捷浮层：列出片段卡片，单击即注入并回车。无片段时整体隐藏。
function renderSnippetQuick() {
  conversationController?.setSnippets(snippets);
  const root = $('snippet-quick');
  if (!root) return;
  if (!snippets.length) { root.style.display = 'none'; return; }
  root.style.display = '';
  root.classList.toggle('collapsed', localStorage.getItem('snippet-quick-collapsed') === '1');
  const cards = $('snippet-quick-cards');
  cards.innerHTML = snippets.map(s =>
    `<button class="snippet-quick-card" data-id="${escAttr(s.id)}" title="${escAttr(s.content)}">${esc(s.title)}</button>`
  ).join('');
  cards.querySelectorAll('.snippet-quick-card').forEach(btn => {
    btn.onclick = () => {
      const s = snippets.find(x => x.id === btn.dataset.id);
      if (s) injectSnippet(s.content, true); // true = 注入并回车
    };
  });
}
function renderSnippetList() {
  const list = $('snippet-list');
  const empty = $('snippet-empty');
  if (!snippets.length) { list.style.display = 'none'; empty.style.display = ''; return; }
  empty.style.display = 'none';
  list.style.display = '';
  list.innerHTML = snippets.map(s => {
    const sc = s.schedule;
    const badge = (sc && sc.mode)
      ? `<span class="snippet-sched-badge${sc.enabled ? '' : ' off'}">🕐 ${esc(schedLabel(sc))}${sc.enabled ? '' : '（已停）'}</span>`
      : '';
    const toggle = (sc && sc.mode)
      ? `<button class="action-btn snippet-sched-toggle${sc.enabled ? ' on' : ''}" title="${sc.enabled ? '暂停定时' : '启用定时'}">${SNIPPET_ICONS.clock}</button>`
      : '';
    return `
    <div class="snippet-row" data-id="${s.id}">
      <div class="snippet-row-main">
        <div class="snippet-row-title">${esc(s.title)}${badge}</div>
        <div class="snippet-row-preview">${esc(snippetPreview(s.content))}</div>
      </div>
      <div class="snippet-row-actions">
        ${toggle}
        <button class="action-btn snippet-inject-btn" title="注入当前终端">${SNIPPET_ICONS.inject}</button>
        <button class="action-btn snippet-edit-btn" title="编辑">${SNIPPET_ICONS.edit}</button>
        <button class="action-btn danger snippet-del-btn" title="删除">${SNIPPET_ICONS.del}</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.snippet-row').forEach(row => {
    const s = snippets.find(x => x.id === row.dataset.id);
    if (!s) return;
    const tgl = row.querySelector('.snippet-sched-toggle');
    if (tgl) tgl.onclick = async () => {
      s.schedule.enabled = !s.schedule.enabled;
      schedRuntime.delete(s.id);
      try { await persistSnippets(); }
      catch (_) { s.schedule.enabled = !s.schedule.enabled; renderSnippetList(); return; } // 失败回滚
      renderSnippetList();
      msg(s.schedule.enabled ? '已启用定时' : '已暂停定时', 'info');
    };
    row.querySelector('.snippet-inject-btn').onclick = () => { closeSnippetModal(); injectSnippet(s.content); };
    row.querySelector('.snippet-edit-btn').onclick = () => loadSnippetIntoEditor(s);
    row.querySelector('.snippet-del-btn').onclick = () => {
      askConfirm('片段', s.title, async () => {
        snippets = snippets.filter(x => x.id !== s.id);
        try { await persistSnippets(); } catch (_) { return; }
        renderSnippetList();
        msg('已删除', 'success');
      });
    };
  });
}

// ---- 片段定时发送：编辑器控件读写 ----
function setSnippetSchedUI(sc) {
  $('snippet-sched-mode').value = (sc && sc.mode) || '';
  $('snippet-sched-min').value = (sc && sc.intervalMin) || 30;
  $('snippet-sched-time').value = (sc && sc.time) || '09:00';
  updateSnippetSchedFields();
}
function updateSnippetSchedFields() {
  const mode = $('snippet-sched-mode').value;
  $('snippet-sched-interval').style.display = mode === 'interval' ? '' : 'none';
  $('snippet-sched-daily').style.display = mode === 'daily' ? '' : 'none';
  $('snippet-sched-hint').style.display = mode ? '' : 'none';
}
function readSnippetSchedUI() {
  const mode = $('snippet-sched-mode').value;
  if (!mode) return null;
  if (mode === 'interval') {
    const m = Math.max(1, parseInt($('snippet-sched-min').value, 10) || 30);
    return { mode, intervalMin: m, time: '', enabled: true };
  }
  return { mode: 'daily', intervalMin: 0, time: $('snippet-sched-time').value || '09:00', enabled: true };
}

// ===== 片段定时发送引擎：间隔重复 / 每天定时，应用打开时运行 =====
// 配置存进片段(snippets.json)；运行态(下次/上次)仅内存，关应用即清、重开按配置重挂。
const schedRuntime = new Map(); // snippetId -> { lastSentMs? | lastFiredDate? }
let schedTimer = null;

function schedLabel(sc) {
  if (!sc || !sc.mode) return '';
  if (sc.mode === 'interval') return `每 ${sc.intervalMin} 分钟`;
  if (sc.mode === 'daily') return `每天 ${sc.time}`;
  return '';
}
function schedDateKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function dailyDue(sc, now) {
  const [hh, mm] = String(sc.time || '').split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return false;
  return now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
}
function checkSchedules() {
  const now = new Date();
  const nowMs = now.getTime();
  const today = schedDateKey(now);
  snippets.forEach(s => {
    const sc = s.schedule;
    if (!sc || !sc.mode || !sc.enabled) return;
    let rt = schedRuntime.get(s.id);
    if (!rt) {
      // 首次见到：武装运行态，不立刻发（interval 从现在起算；daily 已过点则今天不补发）
      rt = sc.mode === 'interval'
        ? { lastSentMs: nowMs }
        : { lastFiredDate: dailyDue(sc, now) ? today : null };
      schedRuntime.set(s.id, rt);
      return;
    }
    if (sc.mode === 'interval') {
      const ms = (Number(sc.intervalMin) || 0) * 60000;
      if (ms > 0 && nowMs - rt.lastSentMs >= ms) { rt.lastSentMs = nowMs; fireSchedule(s); }
    } else if (dailyDue(sc, now) && rt.lastFiredDate !== today) {
      rt.lastFiredDate = today;
      fireSchedule(s);
    }
  });
}
function fireSchedule(s) {
  // 没有活动终端就不发（不擅自开新终端），记一条日志
  if (!activeSession || !sessions.has(activeSession)) {
    appLog('warn', `定时片段「${s.title}」到点但无活动终端，已跳过`);
    return;
  }
  appLog('info', `定时发送片段「${s.title}」`);
  msg(`已定时发送：${s.title}`, 'info');
  injectSnippet(s.content, true); // 注入 + 回车
}
function startScheduler() {
  if (schedTimer) return;
  schedTimer = setInterval(checkSchedules, 30000); // 30s 一跳
  checkSchedules(); // 立即武装运行态（不会立刻发）
}

// ===== 项目想法：只属于活动终端所在项目，整理好后再放入当前对话 =====
let ideaPanelProjectId = '';
let ideaPanelProjectCwd = '';
let ideaPanelEditId = null;
let ideaPanelShowArchived = false;
let ideaPanelOpening = false;
let ideaPanelRevision = 0;
const projectIdeaMutationGate = createProjectIdeaMutationGate();
const ideaCaptureDrafts = new Map();

function activeProjectIdeaContext() {
  const session = activeSession ? sessions.get(activeSession) : null;
  const available = session?.status === 'running'
    && !sessionCloseCoordinator.isClosing(activeSession);
  const project = available ? findProjectByCwd(session.cwd) : null;
  return { session, project };
}

function syncProjectIdeasButton() {
  if (!termEl.ideasBtn) return;
  const { project } = activeProjectIdeaContext();
  const count = project ? projectIdeasFor(projectIdeas, project.id).length : 0;
  termEl.ideasBtn.disabled = !project || projectIdeaMutationGate.pending;
  termEl.ideasBtn.title = project ? `${project.name}的项目想法` : '当前终端未关联已登记项目';
  termEl.ideasCount.textContent = String(count);
  termEl.ideasCount.hidden = count === 0;
}

function syncProjectIdeasContext() {
  syncProjectIdeasButton();
  syncSessionHandoffButton();
  if (!termEl.ideasDrawer?.classList.contains('active')) return;
  const { project } = activeProjectIdeaContext();
  if (!project || project.id !== ideaPanelProjectId) {
    closeProjectIdeas(false);
    return;
  }
  renderProjectIdeas();
}

async function openProjectIdeas() {
  const { project } = activeProjectIdeaContext();
  if (!project) {
    msg('当前终端未关联已登记项目', 'error');
    return;
  }
  const revision = ++ideaPanelRevision;
  ideaPanelOpening = true;
  closeSnippetMenu();
  closeMemoryMenu();
  closeThemeMenu();
  closeTerminalLayoutMenu();
  closeFontMenu();
  const webviewHidden = await workspaceController?.setFloatingUiOpen('project-ideas', true);
  if (revision !== ideaPanelRevision) return;
  ideaPanelOpening = false;
  if (webviewHidden === false) return;
  const current = activeProjectIdeaContext();
  if (!current.project || current.project.id !== project.id) {
    void workspaceController?.setFloatingUiOpen('project-ideas', false);
    return;
  }
  ideaPanelProjectId = project.id;
  ideaPanelProjectCwd = project.localPath;
  ideaPanelEditId = null;
  ideaPanelShowArchived = false;
  termEl.ideaInput.value = ideaCaptureDrafts.get(project.id) || '';
  renderProjectIdeas();
  termEl.ideasScrim.classList.add('active');
  termEl.ideasDrawer.classList.add('active');
  termEl.ideasDrawer.setAttribute('aria-hidden', 'false');
  termEl.ideasBtn.classList.add('active');
  termEl.ideasBtn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => termEl.ideaInput.focus());
}

function closeProjectIdeas(restoreButtonFocus = true) {
  const wasOpen = ideaPanelOpening || termEl.ideasDrawer?.classList.contains('active');
  ideaPanelRevision += 1;
  ideaPanelOpening = false;
  termEl.ideasScrim?.classList.remove('active');
  termEl.ideasDrawer?.classList.remove('active');
  termEl.ideasDrawer?.setAttribute('aria-hidden', 'true');
  termEl.ideasBtn?.classList.remove('active');
  termEl.ideasBtn?.setAttribute('aria-expanded', 'false');
  ideaPanelEditId = null;
  if (wasOpen) void workspaceController?.setFloatingUiOpen('project-ideas', false);
  if (wasOpen && restoreButtonFocus) {
    requestAnimationFrame(() => termEl.ideasBtn?.focus());
  }
}

async function persistProjectIdeas(snapshot = projectIdeas.slice()) {
  try {
    const saved = await invoke('save_project_ideas', { ideas: snapshot });
    backfillMeta(snapshot, saved, ['id', 'createdAt', 'updatedAt']);
  } catch (error) {
    msg('保存想法失败: ' + (error?.message || error), 'error');
    throw error;
  }
}

function refreshProjectIdeasUi() {
  syncProjectIdeasButton();
  if (termEl.ideasDrawer?.classList.contains('active')) renderProjectIdeas();
  conversationController?.setIdeas(projectIdeas);
}

function beginProjectIdeaMutation() {
  if (!projectIdeaMutationGate.begin()) {
    msg('上一条想法正在保存，请稍候', 'info');
    return false;
  }
  refreshProjectIdeasUi();
  return true;
}

function finishProjectIdeaMutation() {
  projectIdeaMutationGate.finish();
  refreshProjectIdeasUi();
}

async function commitProjectIdeasMutation(previous, next) {
  try {
    return await commitProjectIdeaSnapshot({
      previous,
      next,
      persist: persistProjectIdeas,
      getCurrent: () => projectIdeas,
      setCurrent: (value) => {
        projectIdeas = value;
        refreshProjectIdeasUi();
      },
    });
  } finally {
    finishProjectIdeaMutation();
  }
}

function conversationProject(projectId) {
  const id = String(projectId || '').trim();
  return id ? projects.find(project => project.id === id) || null : null;
}

async function createConversationProjectIdea({ projectId, text } = {}) {
  const project = conversationProject(projectId);
  if (!project) throw new Error('当前项目已不存在');
  const created = createProjectIdea(text, project.id);
  if (!created || !beginProjectIdeaMutation()) return null;
  const previous = projectIdeas;
  const next = [created, ...projectIdeas];
  if (!await commitProjectIdeasMutation(previous, next)) return null;
  msg('想法已记下', 'success');
  return findProjectIdea(projectIdeas, created.id, project.id);
}

async function updateConversationProjectIdea({
  projectId,
  id,
  title,
  note,
  archived,
} = {}) {
  const project = conversationProject(projectId);
  if (!project) throw new Error('当前项目已不存在');
  const current = findProjectIdea(projectIdeas, id, project.id);
  if (!current || !beginProjectIdeaMutation()) return null;
  const previous = projectIdeas;
  const next = updateProjectIdea(projectIdeas, {
    id: current.id,
    projectId: project.id,
    title,
    note,
    archived,
  });
  if (next === projectIdeas) {
    finishProjectIdeaMutation();
    return null;
  }
  if (!await commitProjectIdeasMutation(previous, next)) return null;
  msg('想法已更新', 'success');
  return findProjectIdea(projectIdeas, current.id, project.id);
}

async function deleteConversationProjectIdea({ projectId, id } = {}) {
  const project = conversationProject(projectId);
  if (!project) throw new Error('当前项目已不存在');
  const current = findProjectIdea(projectIdeas, id, project.id);
  if (!current || !beginProjectIdeaMutation()) return false;
  const previous = projectIdeas;
  const next = removeProjectIdea(projectIdeas, current.id, project.id);
  if (!await commitProjectIdeasMutation(previous, next)) return false;
  msg('想法已删除', 'success');
  return true;
}

async function openConversationProjectFolder({ projectId } = {}) {
  const project = conversationProject(projectId);
  if (!project) throw new Error('当前项目已不存在');
  await invoke('open_folder', { path: project.localPath });
  return true;
}

async function refreshConversationProject({ projectId } = {}) {
  const project = conversationProject(projectId);
  if (!project) throw new Error('当前项目已不存在');
  invalidateProjectSessionHistory(project.localPath);
  const [history, context] = await Promise.all([
    loadProjectSessionHistory(project.localPath),
    invoke('project_context', { path: project.localPath }),
  ]);
  reloadVisibleProjectSessionHistory(project.localPath);
  void refreshGitStatus();
  return { project, history, context };
}

async function addProjectIdea() {
  const project = projects.find(item => item.id === ideaPanelProjectId);
  if (!project) {
    closeProjectIdeas(false);
    msg('当前项目已不存在', 'error');
    return;
  }
  const text = termEl.ideaInput.value;
  const created = createProjectIdea(text, project.id);
  if (!created) {
    termEl.ideaInput.focus();
    return;
  }
  if (!beginProjectIdeaMutation()) return;
  const previous = projectIdeas;
  const next = [created, ...projectIdeas];
  termEl.ideaInput.value = '';
  ideaCaptureDrafts.delete(project.id);
  if (await commitProjectIdeasMutation(previous, next)) {
    msg('想法已记下', 'success');
  } else {
    termEl.ideaInput.value = text;
    ideaCaptureDrafts.set(project.id, text);
    return;
  }
  termEl.ideaInput.focus();
}

function projectIdeaTime(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function canPlaceProjectIdea(project) {
  const { session, project: activeProject } = activeProjectIdeaContext();
  return Boolean(
    session
    && activeProject?.id === project.id
    && session.status === 'running'
    && !sessionCloseCoordinator.isClosing(activeSession),
  );
}

function projectIdeaCardHtml(idea, project, canPlace) {
  if (ideaPanelEditId === idea.id) {
    return `
      <article class="project-idea-card" data-id="${escAttr(idea.id)}">
        <div class="project-idea-edit">
          <input type="text" data-field="title" maxlength="200" value="${escAttr(idea.title)}" aria-label="想法标题" />
          <textarea data-field="note" maxlength="10000" rows="4" aria-label="想法详情" placeholder="补充背景、边界或下一步">${esc(idea.note || '')}</textarea>
          <div class="project-idea-edit-actions">
            <button type="button" data-action="cancel">取消</button>
            <button type="button" data-action="save">保存</button>
          </div>
        </div>
      </article>`;
  }
  const updated = projectIdeaTime(idea.updatedAt || idea.createdAt);
  const placed = idea.lastPlacedAt
    ? `<span class="is-placed">已放入 ${esc(idea.lastPlacedTool || '终端')} ${esc(projectIdeaTime(idea.lastPlacedAt))}</span>`
    : '';
  return `
    <article class="project-idea-card${idea.archived ? ' is-archived' : ''}" data-id="${escAttr(idea.id)}">
      <div class="project-idea-title">${esc(idea.title)}</div>
      ${idea.note ? `<div class="project-idea-note">${esc(idea.note)}</div>` : ''}
      <div class="project-idea-meta">${updated ? `<span>更新 ${esc(updated)}</span>` : ''}${placed}</div>
      <div class="project-idea-actions">
        <button class="project-idea-action primary" type="button" data-action="place"${canPlace ? '' : ' disabled'}>放入当前对话</button>
        <button class="project-idea-action" type="button" data-action="edit">完善</button>
        <button class="project-idea-action" type="button" data-action="archive">${idea.archived ? '恢复' : '归档'}</button>
        <button class="project-idea-action danger" type="button" data-action="delete">删除</button>
      </div>
    </article>`;
}

function renderProjectIdeas() {
  const project = projects.find(item => item.id === ideaPanelProjectId);
  if (!project || !termEl.ideasList) return;
  const activeIdeas = projectIdeasFor(projectIdeas, project.id);
  const archivedIdeas = projectIdeasFor(projectIdeas, project.id, { archivedOnly: true });
  const shown = ideaPanelShowArchived ? archivedIdeas : activeIdeas;
  termEl.ideasTitle.textContent = `${project.name} · 想法`;
  termEl.ideasProject.textContent = project.localPath;
  termEl.ideasSummary.textContent = ideaPanelShowArchived
    ? `${archivedIdeas.length} 条已归档`
    : `${activeIdeas.length} 条想法`;
  termEl.ideasArchiveToggle.textContent = ideaPanelShowArchived ? '返回想法' : `查看归档 ${archivedIdeas.length || ''}`.trim();
  termEl.ideasArchiveToggle.classList.toggle('active', ideaPanelShowArchived);
  termEl.ideaInput.disabled = projectIdeaMutationGate.pending;
  termEl.ideaAdd.disabled = projectIdeaMutationGate.pending;
  termEl.ideasArchiveToggle.disabled = projectIdeaMutationGate.pending;
  termEl.ideasList.innerHTML = shown.map(idea => projectIdeaCardHtml(idea, project, canPlaceProjectIdea(project))).join('');
  termEl.ideasEmpty.style.display = shown.length ? 'none' : '';
  termEl.ideasEmpty.textContent = ideaPanelShowArchived
    ? '还没有归档的想法'
    : '先记下一条，不需要现在就想完整。';

  termEl.ideasList.querySelectorAll('.project-idea-card').forEach(card => {
    const idea = findProjectIdea(projectIdeas, card.dataset.id, project.id);
    if (!idea) return;
    if (ideaPanelEditId === idea.id) {
      card.querySelector('[data-action="cancel"]').onclick = () => {
        ideaPanelEditId = null;
        renderProjectIdeas();
      };
      card.querySelector('[data-action="save"]').onclick = () => void saveProjectIdeaEdit(card, idea, project);
      card.querySelector('[data-field="title"]').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          card.querySelector('[data-action="save"]').click();
        }
      });
      return;
    }
    card.querySelector('[data-action="place"]').onclick = () => void placeProjectIdea(idea, project);
    card.querySelector('[data-action="edit"]').onclick = () => {
      ideaPanelEditId = idea.id;
      renderProjectIdeas();
      requestAnimationFrame(() => termEl.ideasList.querySelector('[data-field="title"]')?.focus());
    };
    card.querySelector('[data-action="archive"]').onclick = () => void archiveProjectIdea(idea, project);
    card.querySelector('[data-action="delete"]').onclick = () => deleteProjectIdea(idea, project);
  });

  const knownProjectIds = new Set(projects.map(item => item.id));
  const orphans = orphanProjectIdeas(projectIdeas, knownProjectIds);
  termEl.ideasOrphans.hidden = orphans.length === 0;
  termEl.ideasOrphansCount.textContent = String(orphans.length);
  termEl.ideasOrphanList.innerHTML = orphans.map(idea => `
    <div class="project-idea-orphan" data-id="${escAttr(idea.id)}">
      <span title="${escAttr(idea.title)}">${esc(idea.title)}</span>
      <button type="button">归入当前项目</button>
    </div>`).join('');
  termEl.ideasOrphanList.querySelectorAll('.project-idea-orphan').forEach(row => {
    row.querySelector('button').onclick = () => void claimProjectIdea(row.dataset.id, project, knownProjectIds);
  });
  if (projectIdeaMutationGate.pending) {
    termEl.ideasList.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = true; });
    termEl.ideasOrphanList.querySelectorAll('button').forEach(control => { control.disabled = true; });
  }
}

async function saveProjectIdeaEdit(card, idea, project) {
  const title = card.querySelector('[data-field="title"]').value.trim();
  const note = card.querySelector('[data-field="note"]').value.trim();
  if (!title) {
    msg('标题不能为空', 'error');
    card.querySelector('[data-field="title"]').focus();
    return;
  }
  if (!beginProjectIdeaMutation()) return;
  const previous = projectIdeas;
  const next = updateProjectIdea(projectIdeas, {
    id: idea.id, projectId: project.id, title, note,
  });
  if (next === projectIdeas) {
    finishProjectIdeaMutation();
    return;
  }
  ideaPanelEditId = null;
  if (!await commitProjectIdeasMutation(previous, next)) {
    ideaPanelEditId = idea.id;
    refreshProjectIdeasUi();
    return;
  }
  msg('想法已更新', 'success');
}

async function archiveProjectIdea(idea, project) {
  if (!beginProjectIdeaMutation()) return;
  const previous = projectIdeas;
  const next = updateProjectIdea(projectIdeas, {
    id: idea.id, projectId: project.id, archived: !idea.archived,
  });
  await commitProjectIdeasMutation(previous, next);
}

function deleteProjectIdea(idea, project) {
  askConfirm('想法', idea.title, async () => {
    if (!beginProjectIdeaMutation()) return;
    const previous = projectIdeas;
    const next = removeProjectIdea(projectIdeas, idea.id, project.id);
    if (!await commitProjectIdeasMutation(previous, next)) {
      return;
    }
    msg('想法已删除', 'success');
  });
}

async function claimProjectIdea(id, project, knownProjectIds) {
  if (!beginProjectIdeaMutation()) return;
  const previous = projectIdeas;
  const next = claimOrphanProjectIdea(projectIdeas, {
    id, projectId: project.id, knownProjectIds,
  });
  if (next === projectIdeas) {
    finishProjectIdeaMutation();
    return;
  }
  await commitProjectIdeasMutation(previous, next);
}

async function placeProjectIdea(idea, project) {
  const sessionId = activeSession;
  const session = sessionId ? sessions.get(sessionId) : null;
  const activeProject = session ? findProjectByCwd(session.cwd) : null;
  const plan = planProjectIdeaPaste({
    idea,
    projectId: activeProject?.id,
    projectCwd: ideaPanelProjectCwd,
    sessionId,
    sessionStatus: session?.status,
    sessionCwd: session?.cwd,
  });
  if (!plan || !session || sessionCloseCoordinator.isClosing(sessionId)) {
    msg('请先切回这个项目的运行中终端', 'error');
    syncProjectIdeasContext();
    return;
  }
  if (!beginProjectIdeaMutation()) return;
  try {
    session.term.paste(plan.text);
    session.term.focus();
  } catch (error) {
    finishProjectIdeaMutation();
    msg('放入对话失败: ' + (error?.message || error), 'error');
    return;
  }
  const toolId = cliToolName(session.tool || '');
  const toolLabel = CLI_TOOLS.find(tool => tool.id === toolId)?.label || session.name || '终端';
  const previous = projectIdeas;
  const next = updateProjectIdea(projectIdeas, {
    id: idea.id,
    projectId: project.id,
    lastPlacedAt: new Date().toISOString(),
    lastPlacedTool: toolLabel,
    lastPlacedSessionId: sessionId,
  });
  closeProjectIdeas(false);
  if (!await commitProjectIdeasMutation(previous, next)) {
    msg('内容已放入，但投放记录保存失败', 'error');
    return;
  }
  msg('已放入当前对话，请确认后发送', 'success');
}

// ===== 项目"恢复现场"：git 概览 + 最近提交 + 改动文件 + CLAUDE.md 摘要 =====
let contextProject = null;

// 记录某项目最近一次启动了哪个 CLI（恢复现场里显示"上次：claude · 2 小时前"）
function recordProjectActivity(projectId, cmd) {
  if (!projectId) return;
  try {
    const log = JSON.parse(localStorage.getItem('project-activity') || '{}');
    log[projectId] = { cli: (cmd || '').trim().split(/\s+/)[0] || '', at: Date.now() };
    localStorage.setItem('project-activity', JSON.stringify(log));
  } catch (_) {}
}
function getProjectActivity(projectId) {
  try {
    const log = JSON.parse(localStorage.getItem('project-activity') || '{}');
    return log[projectId] || null;
  } catch (_) { return null; }
}
function relTimeFromMs(ms) {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}
function ctxStatusLabel(code) {
  if (code === '??') return { t: '?', cls: 'untracked', name: '未追踪' };
  if (code.includes('A')) return { t: 'A', cls: 'added', name: '新增' };
  if (code.includes('D')) return { t: 'D', cls: 'deleted', name: '删除' };
  if (code.includes('R')) return { t: 'R', cls: 'renamed', name: '重命名' };
  if (code.includes('M')) return { t: 'M', cls: 'modified', name: '修改' };
  return { t: code || '·', cls: 'modified', name: code };
}

async function openContextModal(p) {
  contextProject = p;
  $('context-modal-title').textContent = p.name + ' · 恢复现场';
  $('context-loading').style.display = '';
  $('context-loading').textContent = '加载中…';
  $('context-content').style.display = 'none';
  $('context-content').innerHTML = '';
  $('context-footer').style.display = 'none';
  $('context-modal-overlay').classList.add('active');
  let ctx;
  try {
    ctx = await invoke('project_context', { path: p.localPath });
  } catch (e) {
    $('context-loading').textContent = '加载失败: ' + (e.message || e);
    return;
  }
  if (contextProject !== p) return; // 期间切了别的项目，丢弃这次结果
  renderContext(p, ctx);
}
function closeContextModal() {
  $('context-modal-overlay').classList.remove('active');
  contextProject = null;
}

function renderContext(p, ctx) {
  $('context-loading').style.display = 'none';
  const content = $('context-content');
  content.style.display = '';
  const act = getProjectActivity(p.id);
  let html = '';

  // 概览
  html += '<div class="ctx-section"><div class="ctx-section-title">概览</div><div class="ctx-overview">';
  html += `<span class="ctx-path" title="${escAttr(p.localPath)}">${esc(short(p.localPath))}</span>`;
  if (!ctx.exists) {
    html += '<span class="ctx-warn">⚠ 目录不存在</span>';
  } else if (ctx.isRepo) {
    html += `<span class="git-badge ${ctx.dirty ? 'is-dirty' : 'is-clean'}"><span class="git-branch">${esc(ctx.branch || '?')}</span>`;
    if (ctx.changed) html += `<span class="git-m git-changed">●${ctx.changed}</span>`;
    if (ctx.untracked) html += `<span class="git-m git-untracked">+${ctx.untracked}</span>`;
    if (ctx.ahead) html += `<span class="git-m git-ahead">↑${ctx.ahead}</span>`;
    if (ctx.behind) html += `<span class="git-m git-behind">↓${ctx.behind}</span>`;
    if (!ctx.dirty && !ctx.ahead && !ctx.behind) html += '<span class="git-m git-ok">✓</span>';
    html += '</span>';
  } else {
    html += '<span class="ctx-muted">非 git 仓库</span>';
  }
  if (act) html += `<span class="ctx-muted">上次：${act.cli ? esc(act.cli) + ' · ' : ''}${relTimeFromMs(act.at)}</span>`;
  html += '</div></div>';

  // 最近提交
  if (ctx.commits && ctx.commits.length) {
    html += '<div class="ctx-section"><div class="ctx-section-title">最近提交</div><div class="ctx-commits">';
    ctx.commits.forEach(c => {
      html += `<div class="ctx-commit"><span class="ctx-hash">${esc(c.hash)}</span><span class="ctx-subject" title="${escAttr(c.subject)}">${esc(c.subject)}</span><span class="ctx-rel">${esc(c.rel)}</span></div>`;
    });
    html += '</div></div>';
  }

  // 改动文件
  if (ctx.files && ctx.files.length) {
    html += `<div class="ctx-section"><div class="ctx-section-title">改动文件 ${ctx.changed + ctx.untracked}</div><div class="ctx-files">`;
    ctx.files.forEach(f => {
      const s = ctxStatusLabel(f.status);
      html += `<div class="ctx-file"><span class="ctx-fstatus ctx-${s.cls}" title="${esc(s.name)}">${esc(s.t)}</span><span class="ctx-fpath" title="${escAttr(f.path)}">${esc(f.path)}</span></div>`;
    });
    if (ctx.filesMore) html += `<div class="ctx-files-more">还有 ${ctx.filesMore} 个未列出…</div>`;
    html += '</div></div>';
  } else if (ctx.isRepo && ctx.exists) {
    html += '<div class="ctx-section"><div class="ctx-clean-note">工作区干净，无改动 ✓</div></div>';
  }

  html += '<div class="ctx-section"><div class="ctx-section-title">项目记忆</div>';
  html += '<div class="ctx-overview"><span class="ctx-muted">默认识记不强制。可在终端「项目记忆」里打开「统一记忆到 Claude」。</span></div></div>';

  // CLAUDE.md 摘要
  if (ctx.claudeMd) {
    html += '<div class="ctx-section"><div class="ctx-section-title">CLAUDE.md</div>';
    html += `<pre class="ctx-claude">${esc(ctx.claudeMd)}</pre></div>`;
  }

  content.innerHTML = html;
  $('context-footer').style.display = ctx.exists ? '' : 'none';
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function bindTermEvents() {
  if (termEventsBound) return;
  termEventsBound = true;
  const listen = window.__TAURI__.event.listen;
  await listen('terminal-output', e => {
    const s = sessions.get(e.payload.id);
    if (s) {
      s.term.write(b64ToBytes(e.payload.data));
      if (s.attention) clearAttention(e.payload.id); // 又有新输出 = 重新在干活，撤掉提醒
      if (s.status !== 'exited' && activeSession === e.payload.id && developerTerminalVisible()) {
        characterTheme.handleTerminalEvent('output');
      }
    }
  });
  await listen('terminal-exit', e => {
    const s = sessions.get(e.payload);
    if (s) {
      s.status = 'exited';
      const historyCwd = invalidateTerminalProjectSessionHistory(s);
      s.tabEl.classList.add('exited');
      updateTerminalPaneStatus(s);
      s.term.write('\r\n\x1b[90m[会话已结束]\x1b[0m\r\n');
      if (activeSession === e.payload && currentAppView() === 'developer') characterTheme.handleTerminalEvent('exit');
      if (shouldNotify(e.payload)) {
        beep();
        invoke('notify', { title: `${s.name || '终端'} 已结束`, body: '终端会话已退出' }).catch(() => {});
      }
      if (historyCwd) reloadVisibleProjectSessionHistory(historyCwd);
      refreshExpandedHistoryCards();
      detachOrchestraSession(e.payload, s);
      if (activeSession === e.payload) syncProjectIdeasContext();
    }
  });
  // 会话状态感知：某会话活跃后静默 → AI 可能跑完/在等你输入
  await listen('terminal-attention', e => {
    const { id, name, tool } = e.payload || {};
    const s = sessions.get(id);
    if (!s || s.status === 'exited') return;
    markAttention(id);
    if (activeSession === id && currentAppView() === 'developer') characterTheme.handleTerminalEvent('attention');
    if (shouldNotify(id)) {
      beep();
      const label = name || s.name || '终端';
      const what = tool ? `${tool} 可能跑完了，或在等你输入` : '命令已结束，或在等你输入';
      invoke('notify', { title: `${label} 需要关注`, body: what }).catch(() => {});
    }
  });

  // 拖拽文件/文件夹到终端窗格 → 写入鼠标命中的会话（同 macOS 终端）。
  const targetAtNativePosition = (pos) => {
    if (!pos || !developerTerminalVisible()) return null;
    const dpr = window.devicePixelRatio || 1;
    const x = pos.x / dpr, y = pos.y / dpr;
    return terminalSessionAtViewportPoint(x, y);
  };
  await listen('tauri://drag-over', e => {
    setTerminalPaneDragTarget(targetAtNativePosition(e.payload && e.payload.position));
  });
  await listen('tauri://drag-leave', () => {
    setTerminalPaneDragTarget(null);
  });
  await listen('tauri://drag-drop', e => {
    const p = e.payload || {};
    const targetSessionId = targetAtNativePosition(p.position);
    setTerminalPaneDragTarget(null);
    if (!targetSessionId) return;
    const paths = (p.paths || []).filter(Boolean);
    if (!paths.length) return;
    activateSession(targetSessionId, false, () => {
      const data = paths.map(shellQuotePath).join(' ') + ' ';
      invoke('terminal_write', { id: targetSessionId, data }).catch(() => {});
      sessions.get(targetSessionId)?.term.focus();
    });
  });
}

const IS_WINDOWS = navigator.userAgent.includes('Windows');
let bashAvailabilityPromise = null;

// shell 路径转义。Windows 终端是 PowerShell；Unix 终端是用户登录 shell。
function shellQuotePath(p) {
  return quoteShellPath(p, IS_WINDOWS);
}

async function ensureBashAvailable() {
  bashAvailabilityPromise ||= invoke('has_bash').catch(() => false);
  const available = await bashAvailabilityPromise;
  if (!available) {
    bashAvailabilityPromise = null; // 安装 Bash 后无需重启应用即可重试。
    msg(IS_WINDOWS
      ? '未检测到 Bash，请先安装 Git Bash 或配置可用的 bash 命令'
      : '未检测到 Bash，无法运行 .sh 文件', 'error');
  }
  return available;
}

// 应用配色方案：更新所有已开会话 + 终端面板背景，并持久化
// 清空 WebGL 字形纹理图集：主题/字号/DPR 变化后，旧条目（旧色、旧字号）会残留成重影，
// 主动清一次让渲染器按新状态重建。core 无此 API（DOM 渲染器）时静默跳过。
function clearTermAtlas(term) {
  try { term.clearTextureAtlas && term.clearTextureAtlas(); } catch (_) {}
}

// 挂 WebGL 渲染器（防选区 ghosting）；无 WebGL 环境安全降级回 DOM 渲染器。返回 addon 或 null。
function attachWebgl(term) {
  try {
    const w = new window.WebglAddon.WebglAddon();
    w.onContextLoss(() => w.dispose());
    term.loadAddon(w);
    return w;
  } catch (_) {
    return null;
  }
}

async function setTermTheme(key, persist = true) {
  const def = await resolveThemeDef(key); // 内置 key 或 custom:<id>
  if (!def) return;
  currentTheme = key;
  if (persist) localStorage.setItem('term-theme', key);
  applyThemeDef(def);
  renderThemeMenu();
}

const DIY_ICON = 'assets/theme-icon-diy.png'; // 自定义主题无背景图时的兜底图标 + DIY 新建行图标

function renderThemeMenu() {
  termEl.themeMenu.innerHTML = '';
  // icon: 图标路径（内置主题固定图；自定义主题优先用其背景图缩略图，异步替换）
  const addOpt = (key, name, icon, custom) => {
    const opt = document.createElement('div');
    opt.className = 'term-theme-opt' + (key === currentTheme ? ' active' : '');
    const img = document.createElement('img');
    img.className = 'term-theme-icon';
    img.src = icon || DIY_ICON;
    img.alt = '';
    const label = document.createElement('span');
    label.className = 'term-theme-label';
    label.textContent = name;
    opt.append(img, label);
    if (custom) {
      const edit = document.createElement('span');
      edit.className = 'term-theme-edit';
      edit.title = '编辑此主题';
      edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16.9 4.5l2.6 2.6L8 18.6l-3.6 1 1-3.6z"/></svg>';
      opt.appendChild(edit);
    }
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'term-theme-check');
    check.setAttribute('viewBox', '0 0 24 24');
    check.innerHTML = '<path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3"/>';
    opt.appendChild(check);
    opt.onclick = (e) => {
      if (custom && e.target.closest('.term-theme-edit')) { closeThemeMenu(); openDiyPanel(custom); return; }
      setTermTheme(key); closeThemeMenu();
    };
    termEl.themeMenu.appendChild(opt);
    // 自定义主题缩略图：显式 icon（预装樱花的花朵图）优先；否则异步用背景图缩略图；
    // 都没有则保留 DIY 兜底图标。
    if (custom && !custom.icon && custom.image) {
      resolveThemeImage(custom.image).then(url => { if (url) img.src = url; }).catch(() => {});
    }
  };
  // hidden 的内置项（如 sakura）只作 DIY base 调色板，不在菜单单列
  Object.entries(TERM_THEMES).forEach(([key, def]) => { if (!def.hidden) addOpt(key, def.name, def.icon, null); });
  termCustomThemes.forEach(t => addOpt('custom:' + t.id, t.name, t.icon || DIY_ICON, t));
  // ＋ 新建 DIY 主题
  const add = document.createElement('div');
  add.className = 'term-theme-opt term-theme-add';
  const plus = document.createElement('span');
  plus.className = 'term-theme-plus';
  plus.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m7-7H5"/></svg>';
  const addLabel = document.createElement('span');
  addLabel.className = 'term-theme-label';
  addLabel.textContent = 'DIY 自定义主题…';
  add.append(plus, addLabel);
  add.onclick = () => { closeThemeMenu(); openDiyPanel(null); };
  termEl.themeMenu.appendChild(add);
}

let themeMenuRevision = 0;
let themeMenuOpening = false;
let terminalLayoutMenuRevision = 0;
let terminalLayoutMenuOpening = false;
let fontMenuRevision = 0;
let fontMenuOpening = false;

function syncTermFontMenu() {
  if (termEl.fontValue) termEl.fontValue.textContent = String(currentFontSize);
}

async function openFontMenu() {
  const revision = ++fontMenuRevision;
  fontMenuOpening = true;
  closeThemeMenu();
  closeTerminalLayoutMenu();
  closeSnippetMenu();
  closeMemoryMenu();
  const webviewHidden = await workspaceController?.setFloatingUiOpen('terminal-font-menu', true);
  if (revision !== fontMenuRevision) return;
  if (webviewHidden === false) {
    fontMenuOpening = false;
    return;
  }
  fontMenuOpening = false;
  syncTermFontMenu();
  termEl.fontMenu.classList.add('active');
  termEl.fontBtn.classList.add('active');
  termEl.fontBtn.setAttribute('aria-expanded', 'true');
}

function closeFontMenu() {
  const wasOpen = fontMenuOpening || termEl.fontMenu.classList.contains('active');
  fontMenuRevision += 1;
  fontMenuOpening = false;
  termEl.fontMenu.classList.remove('active');
  termEl.fontBtn.classList.remove('active');
  termEl.fontBtn.setAttribute('aria-expanded', 'false');
  if (wasOpen) void workspaceController?.setFloatingUiOpen('terminal-font-menu', false);
}

async function openTerminalLayoutMenu() {
  const revision = ++terminalLayoutMenuRevision;
  terminalLayoutMenuOpening = true;
  closeThemeMenu();
  closeFontMenu();
  closeSnippetMenu();
  closeMemoryMenu();
  const webviewHidden = await workspaceController?.setFloatingUiOpen('terminal-layout-menu', true);
  if (revision !== terminalLayoutMenuRevision) return;
  if (webviewHidden === false) {
    terminalLayoutMenuOpening = false;
    return;
  }
  terminalLayoutMenuOpening = false;
  termEl.layoutMenu.classList.add('active');
  termEl.layoutBtn.setAttribute('aria-expanded', 'true');
}

function closeTerminalLayoutMenu() {
  const wasOpen = terminalLayoutMenuOpening || termEl.layoutMenu.classList.contains('active');
  terminalLayoutMenuRevision += 1;
  terminalLayoutMenuOpening = false;
  termEl.layoutMenu.classList.remove('active');
  termEl.layoutBtn.setAttribute('aria-expanded', 'false');
  if (wasOpen) void workspaceController?.setFloatingUiOpen('terminal-layout-menu', false);
}

async function openThemeMenu() {
  const revision = ++themeMenuRevision;
  themeMenuOpening = true;
  closeTerminalLayoutMenu();
  closeFontMenu();
  closeMemoryMenu();
  const webviewHidden = await workspaceController?.setFloatingUiOpen('terminal-theme-menu', true);
  if (revision !== themeMenuRevision) return;
  if (webviewHidden === false) {
    themeMenuOpening = false;
    return;
  }
  themeMenuOpening = false;
  renderThemeMenu();
  termEl.themeMenu.classList.add('active');
}

function closeThemeMenu() {
  const wasOpen = themeMenuOpening || termEl.themeMenu.classList.contains('active');
  themeMenuRevision += 1;
  themeMenuOpening = false;
  termEl.themeMenu.classList.remove('active');
  if (wasOpen) void workspaceController?.setFloatingUiOpen('terminal-theme-menu', false);
}

// 调整终端字号：更新所有会话 + 重新 fit（行列数随字号变），并持久化
function setTermFontSize(size) {
  size = Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, size));
  if (size !== currentFontSize) {
    currentFontSize = size;
    localStorage.setItem('term-fontsize', String(size));
    sessions.forEach(s => { s.term.options.fontSize = size; clearTermAtlas(s.term); });
    scheduleFitVisibleSessions();
  }
  syncTermFontMenu();
}

// DPR 变化（窗口在不同缩放的显示器间移动）会让 WebGL 图集坐标错位 → 花屏。
// 监听并清图集 + 重新 fit。matchMedia 一次性触发，回调里重新挂监听。
function watchDprChange() {
  const dpr = window.devicePixelRatio || 1;
  const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
  const onChange = () => {
    sessions.forEach(s => clearTermAtlas(s.term));
    scheduleFitVisibleSessions();
    watchDprChange();
  };
  mq.addEventListener('change', onChange, { once: true });
}
watchDprChange();

// ===== 文件树 + 内容预览 =====

let treeRoot = null;      // 当前树根（活动会话的 cwd）
let treeActiveRow = null; // 当前选中的文件行

const TREE_ICONS = {
  folder: '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="#7aa2cf" stroke-width="1.8"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  code: '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="#98c379" stroke-width="1.9"><path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13 7l-2 10"/></svg>',
  config: '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="#e5c07b" stroke-width="1.8"><path d="M4 7h8M17 7h3M4 17h3M12 17h8"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  doc: '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="#61afef" stroke-width="1.7"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 16h6"/></svg>',
  image: '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="#c678dd" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 19l5-5 4 4 2-2 3 3"/></svg>',
  file: '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="#8b94a4" stroke-width="1.7"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
};

// 扩展名 → highlight.js 语言；返回 null 走自动识别。仅在该语言已注册时才用。
const HLJS_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', go: 'go', rs: 'rust', py: 'python',
  rb: 'ruby', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash',
  fish: 'shell', ps1: 'powershell', bat: 'dos', cmd: 'dos', lua: 'lua', sql: 'sql',
  dart: 'dart', r: 'r', scala: 'scala', groovy: 'groovy', gradle: 'gradle',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', vue: 'xml', css: 'css',
  scss: 'scss', less: 'less', json: 'json', yaml: 'yaml', yml: 'yaml',
  jsonc: 'json', json5: 'json', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  properties: 'properties', env: 'bash', md: 'markdown', markdown: 'markdown',
  dockerfile: 'dockerfile', makefile: 'makefile',
};
function hljsLangFor(name) {
  const lower = name.toLowerCase();
  let lang = HLJS_EXT[lower] || HLJS_EXT[lower.split('.').pop() || ''];
  if (lang && window.hljs && window.hljs.getLanguage(lang)) return lang;
  return null;
}

function fileIconKey(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (/^(js|mjs|cjs|ts|tsx|jsx|vue|go|rs|py|rb|java|kt|c|h|hpp|cpp|cc|cs|php|swift|sh|bash|zsh|fish|ps1|bat|cmd|lua|sql|dart|r|scala|groovy|proto|graphql|gql|html?|css|scss|less)$/.test(ext)) return 'code';
  if (/^(json5?|jsonc|ya?ml|toml|ini|env|conf|cfg|lock|xml|plist|gradle|properties)$/.test(ext)) return 'config';
  if (/^(md|markdown|txt|rst|adoc|log|pdf|csv|tsv)$/.test(ext)) return 'doc';
  if (/^(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/.test(ext)) return 'image';
  return 'file';
}

function makeTreeRow(entry, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (8 + depth * 14) + 'px';
  const chevron = `<svg class="tree-chevron${entry.isDir ? '' : ' leaf'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M9 6l6 6-6 6"/></svg>`;
  const icon = entry.isDir ? TREE_ICONS.folder : TREE_ICONS[fileIconKey(entry.name)];
  row.innerHTML = chevron + icon + `<span class="tree-name">${esc(entry.name)}</span>`;

  // 拖入终端 + 右键菜单（文件/文件夹通用）
  row.addEventListener('mousedown', (e) => startTreeDragWatch(entry, e));
  row.addEventListener('contextmenu', (e) => openTreeCtx(entry, row, e));

  if (!entry.isDir) {
    let clickTimer = null;
    // 单击=预览，双击=插入路径。延时去抖：双击时取消单击的预览
    row.onclick = () => {
      if (treeDragSuppressClick) { treeDragSuppressClick = false; return; }
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        requestOpenPreview(entry.path, entry.name, row);
      }, 220);
    };
    row.ondblclick = () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      insertPathToTerminal(entry.path);
    };
    return [row];
  }

  const childWrap = document.createElement('div');
  childWrap.className = 'tree-children';
  childWrap.style.display = 'none';
  let loaded = false;
  row.onclick = async () => {
    if (treeDragSuppressClick) { treeDragSuppressClick = false; return; }
    const expanded = row.classList.toggle('expanded');
    childWrap.style.display = expanded ? '' : 'none';
    if (expanded && !loaded) {
      loaded = true;
      childWrap.innerHTML = '<div class="tree-loading">…</div>';
      try {
        const items = await invoke('list_dir', { path: entry.path });
        childWrap.innerHTML = '';
        if (!items.length) childWrap.innerHTML = '<div class="tree-empty">空目录</div>';
        else items.forEach(it => makeTreeRow(it, depth + 1).forEach(n => childWrap.appendChild(n)));
      } catch (e) {
        childWrap.innerHTML = `<div class="tree-empty">${esc(String(e))}</div>`;
        loaded = false;
      }
    }
  };
  return [row, childWrap];
}

async function renderTree(cwd) {
  treeRoot = cwd || null;
  treeActiveRow = null;
  void syncSessionRail(cwd);
  if (!cwd) {
    termEl.treeRootName.textContent = '无目录';
    termEl.treeRootName.title = '';
    termEl.treeBody.innerHTML = '<div class="tree-empty">此会话无项目根目录</div>';
    return;
  }
  termEl.treeRootName.textContent = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || cwd;
  termEl.treeRootName.title = cwd;
  termEl.treeBody.innerHTML = '<div class="tree-loading">加载中…</div>';
  try {
    const items = await invoke('list_dir', { path: cwd });
    termEl.treeBody.innerHTML = '';
    if (!items.length) { termEl.treeBody.innerHTML = '<div class="tree-empty">空目录</div>'; return; }
    items.forEach(it => makeTreeRow(it, 0).forEach(n => termEl.treeBody.appendChild(n)));
  } catch (e) {
    termEl.treeBody.innerHTML = `<div class="tree-empty">${esc(String(e))}</div>`;
  }
}

function insertPathToTerminal(path, sessionId = activeSession) {
  if (!sessionId || !sessions.has(sessionId)) return;
  invoke('terminal_write', { id: sessionId, data: shellQuotePath(path) + ' ' }).catch(() => {});
  sessions.get(sessionId)?.term.focus();
}

async function insertShellScriptCommand(entry) {
  if (!isShellScriptEntry(entry) || !activeSession) return;
  if (fileEditorSaving) {
    msg('文件正在保存，请稍候再填入运行命令', 'info');
    return;
  }
  if (isFileEditorDirty()) {
    msg('当前文件有未保存修改，请先保存', 'info');
    return;
  }
  const sessionId = activeSession;
  const previewSeqAtStart = previewLoadSeq;
  if (!await ensureBashAvailable() || !sessions.has(sessionId)) return;
  try {
    await invoke('terminal_write', {
      id: sessionId,
      data: createShellScriptCommand(entry.path, IS_WINDOWS),
    });
  } catch (e) {
    msg('填入命令失败: ' + (e.message || e), 'error');
    return;
  }
  if (shouldCloseShellScriptPreview({
    sessionId,
    activeSessionId: activeSession,
    previewSeqAtStart,
    currentPreviewSeq: previewLoadSeq,
    previewOpen: termEl.preview.classList.contains('active'),
    hasUnsavedChanges: hasUnsavedFileChanges(),
  })) closePreview();
  requestAnimationFrame(() => {
    if (activeSession === sessionId) sessions.get(sessionId)?.term.focus();
  });
  msg('运行命令已填入，请检查并按回车执行', 'info');
}

function isImageFile(name) { return /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i.test(name); }
function isPdfFile(name) { return /\.pdf$/i.test(name); }
function isMarkdownFile(name) { return /\.(md|markdown)$/i.test(name); }
function isCsvFile(name) { return /\.(csv|tsv)$/i.test(name); }

let previewPdfUrl = null;            // 当前 PDF 的 object URL（需手动 revoke）
let previewRichState = null;         // { kind:'md'|'csv', content, name } 供源码/渲染切换
let previewTextState = null;         // 当前可作为文本查看/编辑的文件状态
let previewLoadSeq = 0;              // 连点不同文件时忽略过期的异步读取结果
let fileEditorSaving = false;
let fileEditorLineCount = 0;
let currentAppWindow = null;
let allowWindowClose = false;
let exitPromptPending = false;
let appExitResolutionPending = false;

function hasUnsavedFileChanges() {
  return fileEditorSaving || isFileEditorDirty();
}

async function discardChangesAndExit(kind) {
  try {
    if (kind === 'window') {
      await invoke('confirm_window_close');
      allowWindowClose = true;
      await currentAppWindow?.close();
    } else {
      appExitResolutionPending = true;
      await invoke('confirm_app_exit');
    }
  } catch (e) {
    allowWindowClose = false;
    appExitResolutionPending = false;
    msg('退出失败: ' + (e.message || e), 'error');
  }
}

function requestDiscardChangesAndExit(kind) {
  if (exitPromptPending || el.confirm.classList.contains('active')) return;
  exitPromptPending = true;
  showConfirm({
    title: '文件修改尚未保存',
    message: fileEditorSaving
      ? '文件仍在保存中。现在退出可能丢失本次修改，确定退出吗？'
      : `对 ${previewTextState?.name || '当前文件'} 的修改尚未保存，确定退出吗？`,
    confirmText: '放弃修改并退出',
    danger: true,
    onConfirm: () => discardChangesAndExit(kind),
  });
}

async function setupEditorExitGuard() {
  const tauri = window.__TAURI__;
  currentAppWindow = tauri.window.getCurrentWindow();
  await currentAppWindow.onCloseRequested(async event => {
    if (allowWindowClose) return;
    if (hasUnsavedFileChanges()) {
      event.preventDefault();
      requestDiscardChangesAndExit('window');
      return;
    }
    try {
      await invoke('confirm_window_close');
      allowWindowClose = true;
    } catch (e) {
      event.preventDefault();
      msg('退出失败: ' + (e.message || e), 'error');
    }
  });
  await tauri.event.listen('app-quit-requested', async () => {
    if (hasUnsavedFileChanges()) {
      requestDiscardChangesAndExit('app');
      return;
    }
    if (appExitResolutionPending) return;
    appExitResolutionPending = true;
    try {
      await invoke('confirm_app_exit');
    } catch (e) {
      appExitResolutionPending = false;
      msg('退出失败: ' + (e.message || e), 'error');
    }
  });
}

// 在五个视图(pre/image/rich/pdf/editor)间切换显示
function showPreviewView(which) {
  termEl.previewText.classList.toggle('active', which === 'text');
  termEl.previewImage.classList.toggle('active', which === 'image');
  termEl.previewRich.classList.toggle('active', which === 'rich');
  termEl.previewPdf.classList.toggle('active', which === 'pdf');
  termEl.editor.classList.toggle('active', which === 'editor');
  termEl.previewBody.classList.toggle('editor-active', which === 'editor');
}

function revokePreviewPdf() {
  if (previewPdfUrl) { URL.revokeObjectURL(previewPdfUrl); previewPdfUrl = null; }
  termEl.previewPdf.removeAttribute('src');
}

function renderTextPreview(content, name, truncatedNote) {
  termEl.preview.querySelector('.file-preview-truncated')?.remove();
  showPreviewView('text');
  termEl.previewCode.className = 'hljs';
  termEl.previewCode.removeAttribute('data-highlighted');
  termEl.previewCode.textContent = content;
  termEl.previewLineNumbers.textContent = createLineNumberText(textLineCount(content));
  const lang = hljsLangFor(name);
  termEl.previewCode.className = lang ? `hljs language-${lang}` : 'hljs';
  try { window.hljs.highlightElement(termEl.previewCode); } catch (e) {}
  if (truncatedNote) {
    const note = document.createElement('div');
    note.className = 'file-preview-truncated';
    note.textContent = truncatedNote;
    termEl.preview.appendChild(note);
  }
}

function isFileEditorOpen() {
  return termEl.editor.classList.contains('active') && !!previewTextState;
}

function isFileEditorDirty() {
  return isFileEditorOpen()
    && termEl.editorInput.value !== editorTextFromFile(previewTextState.content);
}

function lineEndingLabel(lineEnding) {
  if (lineEnding === 'crlf') return 'CRLF';
  if (lineEnding === 'cr') return 'CR';
  if (lineEnding === 'mixed') return 'MIXED';
  return 'LF';
}

function updateFileEditorPosition() {
  if (!isFileEditorOpen()) return;
  const value = termEl.editorInput.value;
  const before = value.slice(0, termEl.editorInput.selectionStart);
  const line = textLineCount(before);
  const lastBreak = before.lastIndexOf('\n');
  const column = before.length - lastBreak;
  const lines = textLineCount(value);
  if (fileEditorLineCount !== lines) {
    fileEditorLineCount = lines;
    termEl.editorLineNumbers.textContent = createLineNumberText(lines);
    termEl.editorLineNumbers.scrollTop = termEl.editorInput.scrollTop;
  }
  const encoding = previewTextState.utf8Bom ? 'UTF-8 BOM' : 'UTF-8';
  termEl.editorMeta.textContent =
    `${encoding} · ${lineEndingLabel(previewTextState.lineEnding)} · ${lines} 行`;
  termEl.editorPosition.textContent = `第 ${line} 行，第 ${column} 列`;
}

function updateFileEditorActions() {
  const editing = isFileEditorOpen();
  const hasText = !!previewTextState;
  termEl.previewEdit.style.display = hasText && !editing ? '' : 'none';
  termEl.previewEdit.disabled = hasText && !previewTextState.editable;
  termEl.previewEdit.title = hasText && !previewTextState.editable
    ? (previewTextState.editReason || '此文件只能预览')
    : '编辑文件';
  termEl.previewSave.style.display = editing ? '' : 'none';
  termEl.previewCancel.style.display = editing ? '' : 'none';
  termEl.previewCancel.disabled = fileEditorSaving;
  termEl.previewToggle.style.display = !editing && previewRichState ? '' : 'none';

  termEl.previewStatus.classList.toggle('active', editing || (hasText && !previewTextState.editable));
  if (editing) {
    const dirty = isFileEditorDirty();
    termEl.previewStatus.textContent = fileEditorSaving ? '保存中…' : (dirty ? '未保存' : '编辑中');
    termEl.previewStatus.title = dirty ? '当前修改尚未保存' : '';
    termEl.previewSave.disabled = fileEditorSaving || !dirty;
  } else if (hasText && !previewTextState.editable) {
    termEl.previewStatus.textContent = '只读';
    termEl.previewStatus.title = previewTextState.editReason || '';
  } else {
    termEl.previewStatus.textContent = '';
    termEl.previewStatus.title = '';
  }
  updateFileEditorPosition();
}

// CSV/TSV 解析（处理引号包裹的字段）
function parseCSV(text, delim) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function renderCsvRich(content, name) {
  const rows = parseCSV(content, /\.tsv$/i.test(name) ? '\t' : ',');
  const MAXROW = 1000;
  const shown = rows.slice(0, MAXROW);
  let html = '<table class="csv-table">';
  shown.forEach((r, i) => {
    const tag = i === 0 ? 'th' : 'td';
    html += '<tr>' + r.map(c => `<${tag}>${esc(c)}</${tag}>`).join('') + '</tr>';
  });
  html += '</table>';
  if (rows.length > MAXROW) html += `<div class="csv-note">仅显示前 ${MAXROW} 行(共 ${rows.length} 行)</div>`;
  termEl.previewRich.innerHTML = html;
  showPreviewView('rich');
}

function renderRich() {
  if (!previewRichState) return;
  const { kind, content, name } = previewRichState;
  if (kind === 'md') {
    termEl.previewRich.className = 'file-preview-rich markdown-body';
    // marked 默认透传原始 HTML 且不净化 → 必须 DOMPurify 过滤，防止恶意 .md 在应用内执行脚本
    const raw = window.marked ? window.marked.parse(content) : esc(content);
    termEl.previewRich.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(raw) : esc(content);
    showPreviewView('rich');
  } else {
    termEl.previewRich.className = 'file-preview-rich';
    renderCsvRich(content, name);
  }
}

function positionFilePreview() {
  if (!termEl.preview.classList.contains('active')) return;
  if (currentTerminalPaneArrangement() === 'single') {
    termEl.preview.style.inset = '0';
    termEl.preview.style.width = '';
    termEl.preview.style.height = '';
    return;
  }
  const session = activeSession ? sessions.get(activeSession) : null;
  const content = termEl.preview.parentElement;
  if (!session || !content) return;
  const paneRect = session.bodyEl.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  termEl.preview.style.inset = 'auto';
  termEl.preview.style.left = `${Math.round(paneRect.left - contentRect.left)}px`;
  termEl.preview.style.top = `${Math.round(paneRect.top - contentRect.top)}px`;
  termEl.preview.style.width = `${Math.round(paneRect.width)}px`;
  termEl.preview.style.height = `${Math.round(paneRect.height)}px`;
}

async function openPreview(path, name) {
  const loadSeq = ++previewLoadSeq;
  termEl.preview.querySelector('.file-preview-truncated')?.remove();
  termEl.previewName.textContent = name;
  termEl.previewName.title = path;
  termEl.previewInsert.dataset.path = path;
  setFilePreviewLayerOpen(termEl.preview, termEl.bodies, true);
  positionFilePreview();
  revokePreviewPdf();
  previewRichState = null;
  previewTextState = null;
  termEl.previewToggle.style.display = 'none';
  termEl.previewToggle.classList.remove('active');
  showPreviewView('text');
  updateFileEditorActions();

  // 图片
  if (isImageFile(name)) {
    showPreviewView('image');
    termEl.previewImg.removeAttribute('src');
    termEl.previewImg.alt = '加载中…';
    try {
      const src = await invoke('read_image', { path });
      if (loadSeq !== previewLoadSeq) return;
      termEl.previewImg.src = src;
      termEl.previewImg.alt = name;
    } catch (e) {
      if (loadSeq === previewLoadSeq) renderTextPreview(String(e), name);
    }
    return;
  }

  // PDF
  if (isPdfFile(name)) {
    showPreviewView('pdf');
    try {
      const b64 = await invoke('read_binary_base64', { path });
      if (loadSeq !== previewLoadSeq) return;
      const blob = new Blob([b64ToBytes(b64)], { type: 'application/pdf' });
      previewPdfUrl = URL.createObjectURL(blob);
      termEl.previewPdf.src = previewPdfUrl;
    } catch (e) {
      if (loadSeq === previewLoadSeq) renderTextPreview(String(e), name);
    }
    return;
  }

  // Markdown / CSV：默认渲染，提供源码/渲染切换
  if (isMarkdownFile(name) || isCsvFile(name)) {
    try {
      const res = await invoke('read_file', { path });
      if (loadSeq !== previewLoadSeq) return;
      previewTextState = { path, name, ...res };
      previewRichState = { kind: isMarkdownFile(name) ? 'md' : 'csv', content: res.content, name };
      termEl.previewToggle.classList.add('active'); // active=渲染态
      renderRich();
      updateFileEditorActions();
      return;
    } catch (e) {
      if (loadSeq === previewLoadSeq) renderTextPreview(String(e), name);
      return;
    }
  }

  // 普通文本
  try {
    const res = await invoke('read_file', { path });
    if (loadSeq !== previewLoadSeq) return;
    previewTextState = { path, name, ...res };
    renderTextPreview(
      res.content, name,
      res.truncated ? `文件超过 1MB，仅显示前 1MB（共 ${(res.size / 1048576).toFixed(1)} MB）` : null,
    );
    updateFileEditorActions();
  } catch (e) {
    if (loadSeq === previewLoadSeq) renderTextPreview(String(e), name);
  }
}

// 源码 / 渲染切换（仅 md/csv）
function togglePreviewMode() {
  if (!previewRichState || isFileEditorOpen()) return;
  const toRich = !termEl.previewToggle.classList.contains('active');
  termEl.previewToggle.classList.toggle('active', toRich);
  if (toRich) renderRich();
  else renderTextPreview(previewRichState.content, previewRichState.name, null);
}

function renderCurrentTextFile() {
  if (!previewTextState) return;
  if (previewRichState) {
    termEl.previewToggle.classList.add('active');
    renderRich();
  } else {
    renderTextPreview(
      previewTextState.content,
      previewTextState.name,
      previewTextState.truncated
        ? `文件超过 1MB，仅显示前 1MB（共 ${(previewTextState.size / 1048576).toFixed(1)} MB）`
        : null,
    );
  }
  updateFileEditorActions();
}

function beginFileEdit() {
  if (!previewTextState) return;
  if (!previewTextState.editable) {
    msg(previewTextState.editReason || '此文件只能预览，不能编辑', 'error');
    return;
  }
  termEl.editorInput.value = editorTextFromFile(previewTextState.content);
  termEl.editorInput.scrollTop = 0;
  termEl.editorInput.scrollLeft = 0;
  termEl.editorLineNumbers.scrollTop = 0;
  fileEditorLineCount = 0;
  showPreviewView('editor');
  updateFileEditorActions();
  termEl.editorInput.focus();
}

function finishFileEdit() {
  fileEditorSaving = false;
  renderCurrentTextFile();
}

function requestCancelFileEdit() {
  if (!isFileEditorOpen()) return;
  if (fileEditorSaving) {
    msg('文件正在保存，请稍候', 'info');
    return;
  }
  if (!isFileEditorDirty()) {
    finishFileEdit();
    return;
  }
  showConfirm({
    title: '放弃未保存修改？',
    message: `对 ${previewTextState.name} 的修改尚未保存，确定放弃吗？`,
    confirmText: '放弃修改',
    danger: true,
    onConfirm: finishFileEdit,
  });
}

async function saveFileEdit() {
  if (!isFileEditorOpen() || fileEditorSaving || !isFileEditorDirty()) return;
  const editorValueAtSave = termEl.editorInput.value;
  fileEditorSaving = true;
  updateFileEditorActions();
  const stateAtSave = previewTextState;
  const content = fileTextFromEditor(editorValueAtSave, stateAtSave.lineEnding);
  try {
    const res = await invoke('write_file', {
      path: stateAtSave.path,
      content,
      expectedContent: stateAtSave.content,
      utf8Bom: !!stateAtSave.utf8Bom,
    });
    if (previewTextState !== stateAtSave) {
      fileEditorSaving = false;
      updateFileEditorActions();
      return;
    }
    previewTextState = { path: stateAtSave.path, name: stateAtSave.name, ...res };
    if (previewRichState) {
      previewRichState.content = res.content;
      previewRichState.name = stateAtSave.name;
    }
    if (!editorChangedDuringSave(editorValueAtSave, termEl.editorInput.value)) {
      finishFileEdit();
      msg(`${stateAtSave.name} 已保存`, 'success');
    } else {
      fileEditorSaving = false;
      updateFileEditorActions();
      msg('已保存提交时的内容；保存期间的新修改仍未保存', 'info');
    }
  } catch (e) {
    fileEditorSaving = false;
    updateFileEditorActions();
    msg('保存失败: ' + (e.message || e), 'error');
  }
}

function detectEditorIndent() {
  const lines = editorTextFromFile(previewTextState?.content || '').split('\n');
  for (const line of lines) {
    const leading = line.match(/^(\t+| +)\S/);
    if (!leading) continue;
    if (leading[1][0] === '\t') return '\t';
    return ' '.repeat(leading[1].length >= 4 ? 4 : 2);
  }
  return '  ';
}

function handleEditorTab(e) {
  e.preventDefault();
  const input = termEl.editorInput;
  const indent = detectEditorIndent();
  const value = input.value;
  const start = input.selectionStart;
  const end = input.selectionEnd;

  if (start === end) {
    if (!e.shiftKey) {
      input.setRangeText(indent, start, end, 'end');
    } else {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const prefix = value.slice(lineStart, start);
      const removable = prefix.match(new RegExp(`^(?:\\t| {1,${indent.length}})`))?.[0] || '';
      if (removable) {
        input.setRangeText('', lineStart, lineStart + removable.length, 'end');
        input.setSelectionRange(start - removable.length, start - removable.length);
      }
    }
  } else {
    const blockStart = value.lastIndexOf('\n', start - 1) + 1;
    const nextBreak = value.indexOf('\n', end);
    const blockEnd = nextBreak < 0 ? value.length : nextBreak;
    const block = value.slice(blockStart, blockEnd);
    const changed = e.shiftKey
      ? block.replace(new RegExp(`^(?:\\t| {1,${indent.length}})`, 'gm'), '')
      : block.replace(/^/gm, indent);
    input.setRangeText(changed, blockStart, blockEnd, 'select');
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setupFileEditor() {
  termEl.editorInput.addEventListener('input', updateFileEditorActions);
  termEl.editorInput.addEventListener('scroll', () => {
    termEl.editorLineNumbers.scrollTop = termEl.editorInput.scrollTop;
  });
  ['click', 'keyup', 'select'].forEach(type => {
    termEl.editorInput.addEventListener(type, updateFileEditorPosition);
  });
  termEl.editorInput.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveFileEdit();
    } else if (e.key === 'Tab') {
      handleEditorTab(e);
    }
  });
}

function requestOpenPreview(path, name, row) {
  if (fileEditorSaving) {
    msg('文件正在保存，请稍候', 'info');
    return;
  }
  const open = () => {
    if (treeActiveRow) treeActiveRow.classList.remove('active');
    treeActiveRow = row;
    row.classList.add('active');
    openPreview(path, name);
  };
  if (previewTextState?.path === path && isFileEditorOpen()) return;
  if (!isFileEditorDirty()) {
    open();
    return;
  }
  showConfirm({
    title: '放弃未保存修改？',
    message: `对 ${previewTextState.name} 的修改尚未保存，打开其他文件会丢失这些修改。`,
    confirmText: '放弃并打开',
    danger: true,
    onConfirm: open,
  });
}

function closePreview(force = false) {
  if (!force && fileEditorSaving) {
    msg('文件正在保存，请稍候', 'info');
    return false;
  }
  if (!force && isFileEditorDirty()) {
    showConfirm({
      title: '放弃未保存修改？',
      message: `对 ${previewTextState.name} 的修改尚未保存，确定关闭吗？`,
      confirmText: '放弃并关闭',
      danger: true,
      onConfirm: () => closePreview(true),
    });
    return false;
  }
  previewLoadSeq++;
  setFilePreviewLayerOpen(termEl.preview, termEl.bodies, false);
  revokePreviewPdf();
  previewRichState = null;
  previewTextState = null;
  fileEditorSaving = false;
  showPreviewView('text');
  updateFileEditorActions();
  if (treeActiveRow) { treeActiveRow.classList.remove('active'); treeActiveRow = null; }
  const restoredSessionId = activeSession;
  if (restoredSessionId) {
    requestAnimationFrame(() => {
      if (activeSession !== restoredSessionId) return;
      const session = sessions.get(restoredSessionId);
      if (!session) return;
      fitSession(restoredSessionId);
      try { session.term.refresh(0, Math.max(0, session.term.rows - 1)); } catch (_) {}
    });
  }
  return true;
}

function toggleTree() {
  const hidden = termEl.tree.classList.toggle('hidden');
  termEl.treeBtn.classList.toggle('active', !hidden);
  localStorage.setItem('term-tree-hidden', hidden ? '1' : '0');
  if (!hidden && treeRoot === null && activeSession) renderTree(sessions.get(activeSession).cwd);
  else if (!hidden) void syncSessionRail(treeRoot);
  if (!hidden) requestAnimationFrame(() => applySessionRailHeight());
  scheduleFitVisibleSessions();
}

function setupTreeSplitter() {
  let startX = 0, startW = 0;
  const onMove = (e) => {
    const w = Math.min(Math.max(startW + (e.clientX - startX), 140), 480);
    termEl.tree.style.width = w + 'px';
    scheduleFitVisibleSessions();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    document.body.style.userSelect = '';
    termEl.dock.classList.remove('is-tree-resizing');
    localStorage.setItem('term-tree-width', String(termEl.tree.offsetWidth));
    scheduleFitVisibleSessions(true);
  };
  termEl.treeSplitter.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = termEl.tree.offsetWidth;
    document.body.style.userSelect = 'none';
    termEl.dock.classList.add('is-tree-resizing');
    themePointer.hide();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp, { once: true });
  });
}

function getSessionRailHistory(cwd) {
  const key = normalizeProjectMemoryCwd(cwd);
  if (!key) return null;
  if (sessionRailHistoryByCwd.has(key)) return sessionRailHistoryByCwd.get(key);
  const project = findProjectByCwd(key);
  if (project && projectSessionCache.has(project.id)) {
    const history = projectSessionCache.get(project.id);
    sessionRailHistoryByCwd.set(key, history);
    return history;
  }
  return null;
}

function sessionRailItemHtml(item, activeId) {
  const active = item.terminalId && item.terminalId === activeId;
  const meta = item.running ? '运行中' : formatRailRelativeTime(item.atMs);
  return `<button type="button" class="session-rail-item${active ? ' is-active' : ''}${item.running ? ' is-running' : ''}" data-rail-key="${escAttr(item.key)}" title="${escAttr(item.title)}">`
    + `<span class="term-tab-tool tool-${esc(item.tool)}">${esc(item.tool)}</span>`
    + `<span class="session-rail-name">${esc(item.title)}</span>`
    + (meta ? `<span class="session-rail-meta">${esc(meta)}</span>` : '')
    + `</button>`;
}

function renderSessionRail(cwd, history, { loading = false, error = '' } = {}) {
  if (!termEl.sessionRailBody) return;
  const model = buildSessionRailModel({
    cwd,
    runningSessions: listLiveTerminals(),
    historyGroups: history?.groups || [],
  });
  sessionRailModel = model;
  if (!normalizeProjectMemoryCwd(cwd)) {
    termEl.sessionRailBody.innerHTML = '<div class="session-rail-empty">当前终端没有项目目录</div>';
    return;
  }
  const parts = [];
  if (model.live.length) {
    parts.push('<div class="session-rail-label">进行中</div>');
    parts.push(model.live.map(item => sessionRailItemHtml(item, activeSession)).join(''));
  }
  if (model.history.length) {
    parts.push('<div class="session-rail-label">最近</div>');
    parts.push(model.history.map(item => sessionRailItemHtml(item, activeSession)).join(''));
  }
  if (loading && !model.history.length) {
    parts.push('<div class="session-rail-empty">加载历史会话…</div>');
  } else if (error && !model.history.length) {
    parts.push(`<div class="session-rail-empty">${esc(error)}</div>`);
  } else if (!model.live.length && !model.history.length && !loading) {
    parts.push('<div class="session-rail-empty">这个项目还没有 AI 会话</div>');
  }
  termEl.sessionRailBody.innerHTML = parts.join('');
  termEl.sessionRailBody.querySelectorAll('.session-rail-item').forEach(button => {
    button.onclick = () => openRailSession(button.dataset.railKey);
  });
}

function refreshSessionRailView() {
  const cwd = (activeSession && sessions.get(activeSession)?.cwd) || treeRoot || '';
  const history = getSessionRailHistory(cwd);
  renderSessionRail(cwd, history, {
    loading: sessionRailViewLoading(cwd, history, sessionRailLoads),
  });
}

async function syncSessionRail(cwd, { reload = false } = {}) {
  const revision = ++sessionRailRevision;
  const key = normalizeProjectMemoryCwd(cwd);
  if (reload && key) invalidateProjectSessionHistory(key);
  const cached = reload ? null : getSessionRailHistory(cwd);
  renderSessionRail(cwd, cached, { loading: Boolean(key && !cached) });
  if (!key || cached) return;
  try {
    const history = await loadProjectSessionHistory(cwd);
    if (revision !== sessionRailRevision) return;
    const project = findProjectByCwd(cwd);
    if (project) {
      if (expandedProjectIds.has(project.id)) {
        const card = el.list.querySelector(`.project-card[data-id="${project.id}"]`);
        if (card) renderProjectSessions(card, history);
      }
    }
    renderSessionRail(cwd, history);
  } catch (error) {
    if (revision !== sessionRailRevision) return;
    renderSessionRail(cwd, null, { error: error?.message || String(error) });
  }
}

function openRailSession(key) {
  const item = [...(sessionRailModel?.live || []), ...(sessionRailModel?.history || [])]
    .find(entry => entry.key === key);
  const action = sessionRailAction(item);
  if (action.type === 'focus') {
    activateSession(action.terminalId);
    return;
  }
  if (action.type !== 'resume') return;
  const cwd = sessionRailModel?.cwd || '';
  const autoCmd = resumeCliCommand(action.tool, action.sessionId);
  if (!autoCmd) {
    msg('还不支持续接这个工具的历史会话', 'info');
    return;
  }
  const project = findProjectByCwd(cwd);
  if (project) recordProjectActivity(project.id, autoCmd);
  void createSession({ cwd, name: projectTabName(cwd, action.tool), autoCmd });
}

function applySessionRailCollapsed(hidden) {
  if (!termEl.sessionRail) return;
  termEl.tree.classList.toggle('is-rail-collapsed', hidden);
  termEl.sessionRail.classList.toggle('is-collapsed', hidden);
  termEl.sessionRailToggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  termEl.sessionRailToggle.title = hidden ? '展开会话' : '收起会话';
  try { localStorage.setItem(SESSION_RAIL_HIDDEN_KEY, hidden ? '1' : '0'); } catch (_) {}
}

// 高度只在拖拽mouseup时落盘；布局变化只做视觉夹取，避免把用户选的高度回写成夹小的值
function applySessionRailHeight() {
  if (!termEl.tree || !termEl.sessionRail) return;
  const laidOut = termEl.dock.classList.contains('active') && !termEl.tree.classList.contains('hidden');
  const treeHeight = laidOut ? termEl.tree.clientHeight : 0;
  const height = clampSessionRailHeight(localStorage.getItem(SESSION_RAIL_HEIGHT_KEY), treeHeight);
  termEl.tree.style.setProperty('--session-rail-height', `${height}px`);
}

function setupSessionRailSplitter() {
  let startY = 0;
  let startH = 0;
  const onMove = (event) => {
    const next = clampSessionRailHeight(startH - (event.clientY - startY), termEl.tree.clientHeight);
    termEl.tree.style.setProperty('--session-rail-height', `${next}px`);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    document.body.style.userSelect = '';
    termEl.dock.classList.remove('is-session-rail-resizing');
    try { localStorage.setItem(SESSION_RAIL_HEIGHT_KEY, String(termEl.sessionRail.offsetHeight)); } catch (_) {}
  };
  termEl.sessionRailSplitter.addEventListener('mousedown', (event) => {
    if (termEl.sessionRail.classList.contains('is-collapsed')) return;
    event.preventDefault();
    startY = event.clientY;
    startH = termEl.sessionRail.offsetHeight;
    document.body.style.userSelect = 'none';
    termEl.dock.classList.add('is-session-rail-resizing');
    themePointer.hide();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp, { once: true });
  });
}

function setupSessionRail() {
  if (!termEl.sessionRail) return;
  applySessionRailCollapsed(sessionRailHiddenFromStorage(localStorage.getItem(SESSION_RAIL_HIDDEN_KEY)));
  applySessionRailHeight();
  termEl.sessionRailToggle.onclick = () => {
    applySessionRailCollapsed(!termEl.sessionRail.classList.contains('is-collapsed'));
  };
  setupSessionRailSplitter();
}

// ===== 树项拖入终端（自实现鼠标拖拽，绕开 Tauri 原生 drag-drop 对 HTML5 DnD 的干扰）=====
let treeDrag = null;
let treeDragSuppressClick = false;

function terminalSessionAtViewportPoint(x, y) {
  if (!developerTerminalVisible()) return null;
  const panes = visibleTerminalSessionIds(terminalPaneAssignments).map(id => {
    const rect = sessions.get(id)?.bodyEl.getBoundingClientRect();
    return rect ? { id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
  }).filter(Boolean);
  return terminalSessionIdAtPoint(panes, x, y);
}

function setTerminalPaneDragTarget(sessionId) {
  termEl.dock.classList.toggle('drag-target', !!sessionId);
  sessions.forEach((session, id) => {
    session.bodyEl.classList.toggle('drag-target-pane', id === sessionId);
  });
}

function startTreeDragWatch(entry, e) {
  if (e.button !== 0) return; // 仅左键
  treeDragSuppressClick = false;
  treeDrag = { entry, x: e.clientX, y: e.clientY, started: false, ghost: null };
}

// 兜底清理：无论拖拽如何结束（含离开窗口/失焦），都移除残留 ghost
function cleanupTreeDrag() {
  if (!treeDrag) return;
  if (treeDrag.ghost) treeDrag.ghost.remove();
  treeDrag = null;
  document.body.style.userSelect = '';
  setTerminalPaneDragTarget(null);
}

function setupTreeDrag() {
  document.addEventListener('mousemove', (e) => {
    if (!treeDrag) return;
    if (!treeDrag.started) {
      if (Math.hypot(e.clientX - treeDrag.x, e.clientY - treeDrag.y) < 5) return; // 阈值，区分点击
      treeDrag.started = true;
      const g = document.createElement('div');
      g.className = 'tree-drag-ghost';
      g.textContent = treeDrag.entry.name;
      document.body.appendChild(g);
      treeDrag.ghost = g;
      document.body.style.userSelect = 'none';
    }
    treeDrag.ghost.style.left = (e.clientX + 12) + 'px';
    treeDrag.ghost.style.top = (e.clientY + 14) + 'px';
    setTerminalPaneDragTarget(terminalSessionAtViewportPoint(e.clientX, e.clientY));
  });
  document.addEventListener('mouseup', (e) => {
    if (!treeDrag) return;
    const d = treeDrag;
    const started = d.started;
    cleanupTreeDrag();
    if (started) {
      treeDragSuppressClick = true; // 抑制随后的 click（预览/展开）
      const targetSessionId = terminalSessionAtViewportPoint(e.clientX, e.clientY);
      if (targetSessionId) {
        activateSession(targetSessionId, false, () => insertPathToTerminal(d.entry.path, targetSessionId));
      }
    }
  });
  // 鼠标移出窗口 / 应用失焦时 mouseup 收不到，ghost 会卡住——兜底清理
  document.addEventListener('mouseleave', (e) => {
    if (treeDrag && (!e.relatedTarget && !e.toElement)) cleanupTreeDrag();
  });
  window.addEventListener('blur', cleanupTreeDrag);
}

// ===== 文件树右键菜单：插入路径 / 复制路径 / 移到废纸篓 =====
let treeCtx = null;
function parentDir(p) {
  const norm = p.replace(/[/\\]+$/, '');
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return idx > 0 ? norm.slice(0, idx) : norm;
}

function openTreeCtx(entry, row, e) {
  e.preventDefault();
  treeCtx = { entry, row };
  $('ctx-open-label').textContent = entry.isDir ? '打开文件夹' : '打开所在文件夹';
  $('ctx-run-script').style.display = isShellScriptEntry(entry) ? '' : 'none';
  const menu = el.treeCtxMenu;
  menu.classList.add('active');
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}
function closeTreeCtx() {
  el.treeCtxMenu.classList.remove('active');
  treeCtx = null;
}

function focusActiveTerminal() {
  if (!activeSession) return;
  if (termEl.preview.classList.contains('active') && !closePreview()) return;
  const session = sessions.get(activeSession);
  if (!session) return;
  requestAnimationFrame(() => session.term.focus());
}

function setupWorkspaceMode() {
  if (workspaceController) return;
  workspaceController = installWorkspaceMode({
    dock: termEl.dock,
    terminalMain: termEl.main,
    initialAppVisible: initialAppView === 'developer',
    onExpandedChange: expanded => {
      if (expanded) {
        openDock();
        if (!termEl.dock.classList.contains('maximized')) {
          workspaceAutoMaximized = true;
          setDockMaximized(true);
        }
      } else if (workspaceAutoMaximized) {
        workspaceAutoMaximized = false;
        setDockMaximized(false);
      }
    },
    onLayoutChange: () => {
      scheduleFitVisibleSessions();
    },
    onFocusTerminal: focusActiveTerminal,
    openExternal: url => invoke('open_url', { url }).catch(error => {
      msg('打开浏览器失败: ' + (error?.message || error), 'error');
    }),
    notify: msg,
    onModeChange: () => {
      // Workspace mode controls layout; the selected terminal theme remains
      // active in the Coding area in normal, relax and entertainment modes.
      characterTheme.setDockOpen(termEl.dock.classList.contains('active'));
      if (activeSession) requestAnimationFrame(() => sessions.get(activeSession)?.term.focus());
    },
  });
}

function openDock() {
  termEl.dock.classList.add('active');
  termEl.fab.classList.add('hidden');
  characterTheme.setDockOpen(true);
  workspaceController?.setDockOpen(true);
  requestAnimationFrame(() => applySessionRailHeight());
  scheduleFitVisibleSessions();
}

function collapseDock() {
  // Native companion WebViews are hidden while a header dropdown is open.
  // Close those dropdowns before docking so no stale hide reason survives reopen.
  closeThemeMenu();
  closeSnippetMenu();
  closeMemoryMenu();
  closeTerminalLayoutMenu();
  closeFontMenu();
  closeProjectIdeas(false);
  closeSessionHandoff(false);
  termEl.dock.classList.remove('active');
  termEl.fab.classList.remove('hidden');
  characterTheme.setDockOpen(false);
  workspaceController?.setDockOpen(false);
  themePointer.hide();
}

// 最大化/还原终端抽屉，最大化时占满整个窗口高度、不留顶部白边
let dockPrevHeight = null;
function setDockMaximized(maxed) {
  const wasMaxed = termEl.dock.classList.contains('maximized');
  if (maxed === wasMaxed) {
    if (maxed) {
      termEl.dock.style.height = window.innerHeight + 'px';
      requestAnimationFrame(() => applySessionRailHeight());
    }
    return;
  }
  termEl.dock.classList.toggle('maximized', maxed);
  if (maxed) {
    dockPrevHeight = termEl.dock.offsetHeight;
    termEl.dock.style.height = window.innerHeight + 'px';
    termEl.maximizeBtn.title = '还原';
  } else {
    termEl.dock.style.height = (dockPrevHeight || 340) + 'px';
    termEl.maximizeBtn.title = '最大化';
  }
  workspaceController?.scheduleBoundsSync();
  requestAnimationFrame(() => applySessionRailHeight());
  scheduleFitVisibleSessions();
}

function toggleDockMaximize() {
  workspaceAutoMaximized = false;
  setDockMaximized(!termEl.dock.classList.contains('maximized'));
}

function updateFabBadge() {
  const n = sessions.size;
  termEl.fabBadge.style.display = n ? '' : 'none';
  termEl.fabBadge.textContent = n;
  let att = 0;
  sessions.forEach(s => { if (s.attention) att++; });
  termEl.fab.classList.toggle('attention', att > 0);
}

// 终端标签上下文用量：claude 会话读自己项目的 transcript 估算当前上下文占比
let ctxPollTimer = null;
async function updateContextBadges() {
  for (const [id, s] of sessions) {
    const tool = (s.tool || '').trim().split(/\s+/)[0];
    const ctxEl = s.tabEl && s.tabEl.querySelector('.term-tab-ctx');
    if (!ctxEl) continue;
    if (tool !== 'claude' || !s.cwd) { ctxEl.style.display = 'none'; continue; }
    try {
      const c = await invoke('context_usage', { id, cwd: s.cwd, startedAt: s.startedAt || 0 });
      if (c && c.ok) {
        ctxEl.textContent = `${c.percent}%`;
        ctxEl.title = `上下文 ${c.percent}%（${c.tokens.toLocaleString()} / ${c.limit.toLocaleString()} tokens）`;
        ctxEl.className = 'term-tab-ctx' + (c.percent >= 90 ? ' danger' : c.percent >= 70 ? ' warn' : '');
        ctxEl.style.display = '';
      } else {
        ctxEl.style.display = 'none';
      }
    } catch (_) { ctxEl.style.display = 'none'; }
  }
}
function ensureCtxPoll() {
  if (ctxPollTimer) return;
  ctxPollTimer = setInterval(() => { updateContextBadges(); updateBranchBadges(); }, 20000);
}

// 终端标签 git 分支：显示每个会话工作目录的当前分支（有 git 才显示），随 checkout 在轮询/切换时刷新。
const TAB_BRANCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="7.5" r="2.2"/><path d="M6 8.2v7.6M8.2 6.2c5.6.4 7.6 1.7 7.6 5.3"/></svg>';
async function updateBranchBadges() {
  for (const s of sessions.values()) {
    const el = s.tabEl && s.tabEl.querySelector('.term-tab-branch');
    if (!el) continue;
    if (!s.cwd) {
      el.style.display = 'none';
      continue;
    }
    try {
      const b = await invoke('git_branch', { path: s.cwd });
      if (b) {
        el.innerHTML = TAB_BRANCH_SVG + `<span>${esc(b)}</span>`;
        el.title = `git 分支：${b}`;
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    } catch (_) {
      el.style.display = 'none';
    }
  }
}

function flushTerminalResize(id, session) {
  if (session.resizeTimer) {
    clearTimeout(session.resizeTimer);
    session.resizeTimer = null;
  }
  const pending = session.pendingResize;
  if (!pending || sessions.get(id) !== session) return;
  session.pendingResize = null;
  session.lastResizeKey = pending.key;
  session.lastResizeSentAt = Date.now();
  invoke('terminal_resize', { id, cols: pending.cols, rows: pending.rows }).catch(() => {
    if (sessions.get(id) === session && session.lastResizeKey === pending.key) {
      session.lastResizeKey = '';
    }
  });
}

function queueTerminalResize(id, session, forceResize = false) {
  const cols = session.term.cols;
  const rows = session.term.rows;
  const key = `${cols}x${rows}`;
  if (key === session.lastResizeKey && !session.pendingResize) return;
  session.pendingResize = { cols, rows, key };

  const elapsed = Date.now() - session.lastResizeSentAt;
  if (forceResize || elapsed >= TERMINAL_RESIZE_INTERVAL_MS) {
    flushTerminalResize(id, session);
  } else if (!session.resizeTimer) {
    session.resizeTimer = setTimeout(
      () => flushTerminalResize(id, session),
      TERMINAL_RESIZE_INTERVAL_MS - elapsed,
    );
  }
}

function scheduleFitVisibleSessions(forceResize = false) {
  terminalFitForceResize ||= forceResize;
  if (terminalFitFrame) return;
  const elapsed = Date.now() - terminalFitLastRunAt;
  if (!terminalFitForceResize && elapsed < TERMINAL_RESIZE_INTERVAL_MS) {
    terminalFitTimer ||= setTimeout(() => {
      terminalFitTimer = null;
      scheduleFitVisibleSessions();
    }, TERMINAL_RESIZE_INTERVAL_MS - elapsed);
    return;
  }
  if (terminalFitTimer) {
    clearTimeout(terminalFitTimer);
    terminalFitTimer = null;
  }
  terminalFitFrame = requestAnimationFrame(() => {
    const shouldForceResize = terminalFitForceResize;
    terminalFitFrame = 0;
    terminalFitLastRunAt = Date.now();
    terminalFitForceResize = false;
    visibleTerminalSessionIds(terminalPaneAssignments).forEach(id => {
      fitSession(id, { forceResize: shouldForceResize });
    });
    positionFilePreview();
  });
}

function updateTerminalPaneStatus(session) {
  if (!session) return;
  session.bodyEl.classList.toggle('attention', !!session.attention);
  session.bodyEl.classList.toggle('failed', session.status === 'failed');
  session.bodyEl.classList.toggle('exited', session.status === 'exited');
  if (!session.paneStatusEl) return;
  let label = '运行中';
  if (session.status === 'failed') label = '启动失败';
  else if (session.status === 'exited') label = '已结束';
  else if (session.attention) label = '等待处理';
  session.paneStatusEl.title = label;
  session.paneStatusEl.setAttribute('aria-label', label);
}

function currentTerminalPaneArrangement() {
  return terminalPaneArrangement(
    terminalPaneLayout,
    visibleTerminalSessionIds(terminalPaneAssignments).length,
  );
}

function renderTerminalPaneLayout() {
  const sessionIds = [...sessions.keys()];
  terminalPaneLayout = normalizeTerminalPaneLayout(terminalPaneLayout);
  terminalPaneAssignments = reconcileTerminalPanes({
    assignments: terminalPaneAssignments,
    sessionIds,
    activeSessionId: activeSession,
    layout: terminalPaneLayout,
    fill: false,
  });
  const visibleIds = visibleTerminalSessionIds(terminalPaneAssignments);
  const arrangement = terminalPaneArrangement(terminalPaneLayout, visibleIds.length);
  termEl.bodies.dataset.layout = terminalPaneLayout;
  termEl.bodies.dataset.arrangement = arrangement;
  termEl.bodies.querySelectorAll('.term-pane-empty').forEach(node => node.remove());

  sessions.forEach((session, id) => {
    const visualIndex = visibleIds.indexOf(id);
    const visible = visualIndex >= 0;
    session.bodyEl.classList.toggle('pane-visible', visible);
    session.bodyEl.classList.toggle('active', id === activeSession && visible);
    session.tabEl.classList.toggle('active', id === activeSession);
    session.tabEl.classList.toggle('pane-visible', visible);
    session.bodyEl.style.order = visible ? String(visualIndex) : '';
    if (visible) session.bodyEl.dataset.paneSlot = String(visualIndex);
    else delete session.bodyEl.dataset.paneSlot;
    session.paneIndexEl.textContent = visible ? String(visualIndex + 1) : '';
    session.tabPaneEl.textContent = visible ? String(visualIndex + 1) : '';
    session.tabPaneEl.title = visible ? `当前显示在窗格 ${visualIndex + 1}` : '';
    updateTerminalPaneStatus(session);
  });
  syncOrchestraChrome();

  const label = TERMINAL_LAYOUT_LABELS[terminalPaneLayout];
  termEl.layoutBtn.classList.toggle('active', terminalPaneLayout !== 'single');
  termEl.layoutBtn.title = `终端布局：${label}`;
  termEl.layoutBtn.setAttribute('aria-label', `终端布局：${label}`);
  termEl.layoutMenu.querySelectorAll('[data-layout]').forEach(option => {
    const selected = option.dataset.layout === terminalPaneLayout;
    option.classList.toggle('active', selected);
    option.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
  scheduleFitVisibleSessions();
}

function setTerminalPaneLayout(layout) {
  terminalPaneLayout = normalizeTerminalPaneLayout(layout);
  terminalPaneAssignments = reconcileTerminalPanes({
    assignments: terminalPaneAssignments,
    sessionIds: [...sessions.keys()],
    activeSessionId: activeSession,
    layout: terminalPaneLayout,
    fill: true,
  });
  if (!activeSession || !terminalPaneAssignments.includes(activeSession)) {
    activeSession = visibleTerminalSessionIds(terminalPaneAssignments)[0] || null;
  }
  const active = activeSession ? sessions.get(activeSession) : null;
  if (active && active.cwd !== treeRoot) renderTree(active.cwd);
  closeTerminalLayoutMenu();
  renderTerminalPaneLayout();
  syncProjectIdeasContext();
  if (active) active.term.focus();
}

function fitSession(id, { forceResize = false } = {}) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.fit.fit();
    queueTerminalResize(id, s, forceResize);
  } catch (e) {}
}

function activateSession(id, force = false, onActivated = null) {
  const s = sessions.get(id);
  if (!s || sessionCloseCoordinator.isClosing(id)) return false;
  if (!force && fileEditorSaving) {
    msg('文件正在保存，请稍候', 'info');
    return false;
  }
  if (!force && isFileEditorDirty()) {
    showConfirm({
      title: '放弃未保存修改？',
      message: `对 ${previewTextState.name} 的修改尚未保存，返回终端会丢失这些修改。`,
      confirmText: '放弃并切换',
      danger: true,
      onConfirm: () => activateSession(id, true, onActivated),
    });
    return false;
  }
  const rootChanged = s.cwd !== treeRoot;
  const selected = selectTerminalPaneSession({
    assignments: terminalPaneAssignments,
    activeSessionId: activeSession,
    layout: terminalPaneLayout,
  }, id);
  terminalPaneAssignments = selected.assignments;
  activeSession = selected.activeSessionId;
  closePreview(true);
  if (rootChanged) renderTree(s.cwd);
  else refreshSessionRailView();
  renderTerminalPaneLayout();
  syncProjectIdeasContext();
  // 标签栏可横向滚动：激活的标签可能在可视区外，滚进来
  s.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  requestAnimationFrame(() => {
    fitSession(id);
    s.term.focus();
  });
  clearAttention(id);
  characterTheme.setState(s.status === 'exited' ? 'rest' : 'idle');
  updateBranchBadges(); // 切到该标签时刷新分支（catch 终端里的 git checkout）
  if (typeof onActivated === 'function') onActivated();
  return true;
}

function removeSessionFromPane(id, force = false) {
  const session = sessions.get(id);
  if (!session || sessionCloseCoordinator.isClosing(id) || !terminalPaneAssignments.includes(id)) return;
  if (!force && activeSession === id && fileEditorSaving) {
    msg('文件正在保存，请稍候', 'info');
    return;
  }
  if (!force && activeSession === id && isFileEditorDirty()) {
    showConfirm({
      title: '移出分屏？',
      message: `对 ${previewTextState.name} 的修改尚未保存，移出「${session.name}」会关闭文件预览，但终端会话仍在后台运行。`,
      confirmText: '放弃修改并移出',
      danger: true,
      onConfirm: () => removeSessionFromPane(id, true),
    });
    return;
  }
  if (activeSession === id) closePreview(true);
  const removed = removeTerminalPaneSession({
    assignments: terminalPaneAssignments,
    activeSessionId: activeSession,
    layout: terminalPaneLayout,
  }, id);
  terminalPaneAssignments = removed.assignments;
  if (activeSession === id) {
    activeSession = removed.activeSessionId;
    const next = activeSession ? sessions.get(activeSession) : null;
    if (next) renderTree(next.cwd);
    else {
      treeRoot = null;
      termEl.treeRootName.textContent = '文件树';
      termEl.treeRootName.title = '';
      termEl.treeBody.innerHTML = '<div class="tree-empty">选择上方标签以显示会话</div>';
      void syncSessionRail('');
    }
  }
  renderTerminalPaneLayout();
  syncProjectIdeasContext();
  if (activeSession) requestAnimationFrame(() => sessions.get(activeSession)?.term.focus());
  msg(`「${session.name}」已移出分屏，会话仍在后台运行`, 'info');
}

// 关闭终端前确认（提醒先让 AI 更新记忆）
function confirmCloseSession(id) {
  const s = sessions.get(id);
  if (!s || sessionCloseCoordinator.isClosing(id)) return;
  if (activeSession === id && fileEditorSaving) {
    msg('文件正在保存，请稍候再关闭终端', 'info');
    return;
  }
  const running = s.status !== 'exited';
  const aiHint = s.tool
    ? `\n如果刚跟 ${s.tool} 聊过，建议先让它「更新记忆」（写入 .memory）再关。平时结论可丢进 .memory/inbox。`
    : '';
  showConfirm({
    title: '关闭终端',
    message: `确定关闭「${s.name}」吗？${running ? '\n关闭后该会话立即结束。' : ''}${activeSession === id && isFileEditorDirty() ? '\n当前文件中未保存的修改也会丢失。' : ''}${aiHint}`,
    confirmText: '关闭',
    danger: true,
    onConfirm: () => closeSession(id),
  });
}

function setSessionClosingState(session, closing) {
  session.tabEl.classList.toggle('closing', closing);
  session.bodyEl.classList.toggle('closing', closing);
  session.tabEl.setAttribute('aria-busy', closing ? 'true' : 'false');
  const tabClose = session.tabEl.querySelector('.term-tab-close');
  if (tabClose) tabClose.setAttribute('aria-disabled', closing ? 'true' : 'false');
  const paneClose = session.paneHeadEl?.querySelector('.term-pane-close');
  if (paneClose) paneClose.disabled = closing;
}

function finalizeSessionClose(id) {
  const session = sessions.get(id);
  if (!session) return;
  const historyCwd = invalidateTerminalProjectSessionHistory(session);
  if (activeSession === id) closePreview(true);
  if (session.resizeTimer) clearTimeout(session.resizeTimer);
  try { session.term.dispose(); } catch (_) {}
  session.tabEl.remove();
  session.bodyEl.remove();
  sessions.delete(id);

  const nextState = closeTerminalPaneSession({
    assignments: terminalPaneAssignments,
    activeSessionId: activeSession,
    layout: terminalPaneLayout,
    remainingSessionIds: [...sessions.keys()],
  }, id);
  terminalPaneAssignments = nextState.assignments;
  activeSession = nextState.activeSessionId;

  if (activeSession) {
    const next = sessions.get(activeSession);
    if (next && next.cwd !== treeRoot) renderTree(next.cwd);
    else refreshSessionRailView();
    renderTerminalPaneLayout();
    requestAnimationFrame(() => next?.term.focus());
  } else if (!sessions.size) {
    renderTerminalPaneLayout();
    void syncSessionRail('');
    collapseDock();
  } else {
    renderTerminalPaneLayout();
    refreshSessionRailView();
  }
  syncProjectIdeasContext();
  updateFabBadge();
  persistSessionLayout();
  if (historyCwd) reloadVisibleProjectSessionHistory(historyCwd);
  refreshExpandedHistoryCards();
  detachOrchestraSession(id, session);
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session || sessionCloseCoordinator.isClosing(id)) return false;
  if (activeSession === id) closePreview(true);
  setSessionClosingState(session, true);
  const closed = await sessionCloseCoordinator.close(id);
  if (!closed && sessions.get(id) === session) setSessionClosingState(session, false);
  return closed;
}

async function createSession({ cwd = '', name = '', autoCmd = '' }) {
  await bindTermEvents();
  const id = `term-${Date.now()}-${++termSeq}`;
  const label = name || `终端 ${termSeq}`;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'term-body';
  bodyEl.dataset.id = id;
  const toolName = (autoCmd || '').trim().split(/\s+/)[0] || '';
  const paneHeadEl = document.createElement('div');
  paneHeadEl.className = 'term-pane-head';
  paneHeadEl.innerHTML =
    '<span class="term-pane-index"></span>' +
    '<span class="term-pane-status" role="status" aria-label="运行中"></span>' +
    `<span class="term-pane-name" title="${escAttr(label)}">${esc(label)}</span>` +
    '<span class="term-pane-spacer"></span>' +
    '<button class="term-pane-close" type="button" title="移出分屏（会话继续运行）" aria-label="移出分屏">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5.5" width="11" height="13" rx="1.2"/><path d="M14 12h6.5M17.5 9l3 3-3 3"/></svg>' +
    '</button>';
  const terminalHostEl = document.createElement('div');
  terminalHostEl.className = 'term-pane-terminal';
  bodyEl.append(paneHeadEl, terminalHostEl);
  termEl.bodies.appendChild(bodyEl);

  const tabEl = document.createElement('div');
  tabEl.className = 'term-tab';
  tabEl.dataset.id = id;
  // 徽标只显示工具名（命令首词），不显示参数——否则恢复命令会整条塞进徽标
  const toolBadge = toolName
    ? `<span class="term-tab-tool tool-${esc(toolName)}">${esc(toolName)}</span>`
    : '';
  tabEl.innerHTML =
    `<span class="term-tab-dot"></span>` +
    `<span class="term-tab-pane"></span>` +
    `<span class="term-tab-name" title="${esc(label)}">${esc(label)}</span>` +
    toolBadge +
    `<span class="term-tab-branch" style="display:none;"></span>` +
    `<span class="term-tab-ctx" style="display:none;" title="上下文用量"></span>` +
    `<span class="term-tab-close" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg></span>`;
  termEl.tabs.appendChild(tabEl);
  tabEl.onclick = (ev) => {
    if (ev.target.closest('.term-tab-close')) { confirmCloseSession(id); return; }
    activateSession(id);
  };
  bodyEl.addEventListener('mousedown', (event) => {
    if (event.target.closest('.term-pane-close') || activeSession === id) return;
    activateSession(id);
  });
  paneHeadEl.querySelector('.term-pane-close').onclick = (event) => {
    event.stopPropagation();
    removeSessionFromPane(id);
  };

  const term = new window.Terminal({
    fontSize: currentFontSize,
    fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
    cursorBlink: (currentThemeDef || TERM_THEMES.classic).cursorBlink !== false,
    scrollback: 5000,
    allowTransparency: true, // 让半透明终端底透出图片主题背景
    theme: (currentThemeDef || TERM_THEMES.classic).theme,
    // 默认 4.5：会为对比度再生成一批变体字形，配上彩色中文把 WebGL 纹理图集塞爆
    // → 字形错位/残影。设 1 关掉对比度调整，大幅降低图集条目数（修中文花屏的关键）。
    minimumContrastRatio: 1,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(terminalHostEl);
  // WebGL 渲染器：默认 DOM 渲染器在触控板滚动时选区会糊成一大块（ghosting），
  // 改用 GPU 渲染正确重绘选区/滚动。WebGL 不可用或上下文丢失时安全降级回默认渲染器。
  // 图片主题的 xterm 必须走 DOM 渲染——xterm WebGL 画布是像素级不透明，背景透不上来。
  let webgl = null;
  if (!(currentThemeDef && currentThemeDef.bg)) {
    webgl = attachWebgl(term);
  }
  const inputBuffer = createTerminalInputBuffer({
    send: data => invoke('terminal_write', { id, data }),
    onError: error => appLog('warn', `终端输入写入失败（${id}）：${error}`),
    onOverflow: () => term.write('\r\n\x1b[33m启动期间输入过多，仅保留前 1MB\x1b[0m\r\n'),
  });
  term.onData(data => inputBuffer.write(data));

  const session = {
    term, fit, tabEl, bodyEl, webgl, name: label, status: 'running', cwd, tool: autoCmd,
    inputBuffer,
    paneHeadEl,
    paneIndexEl: paneHeadEl.querySelector('.term-pane-index'),
    paneStatusEl: paneHeadEl.querySelector('.term-pane-status'),
    tabPaneEl: tabEl.querySelector('.term-tab-pane'),
    terminalHostEl,
    lastResizeKey: '', lastResizeSentAt: 0, pendingResize: null, resizeTimer: null,
    startedAt: Date.now(), restorable: false,
  };
  sessions.set(id, session);
  term.onRender(renderRange => scheduleImageCellBackgroundSync(session, renderRange));

  openDock();
  activateSession(id);
  requestAnimationFrame(() => fitSession(id));
  updateFabBadge();
  ensureCtxPoll();
  updateBranchBadges(); // 立即显示该会话的分支徽标
  // claude 会话起来后稍等再首刷一次上下文徽标（等它写出 transcript）
  if ((autoCmd || '').trim().split(/\s+/)[0] === 'claude') {
    setTimeout(updateContextBadges, 6000);
  }

  try {
    // tool 只传工具名（命令首词，如 claude），不传整条命令——手机端用作标签/图标
    const tool = (autoCmd || '').trim().split(/\s+/)[0] || '';
    await invoke('terminal_create', { id, cwd, cols: term.cols || 80, rows: term.rows || 24, name: label, tool });
    session.restorable = true;
    characterTheme.setState('idle');
    persistSessionLayout();
    fitSession(id);
    if (shouldAutoMountProjectMemory(cwd, '', readMemoryUnifyPaths())) {
      const memory = await mountProjectMemory(cwd, session);
      writeMemoryBanner(term, memory);
    }
    let proxyHook = '';
    try {
      const hook = await invoke('get_proxy_shell_hook');
      proxyHook = String(hook?.command || '').trim();
    } catch (_) {}
    if (autoCmd || proxyHook) {
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    const startup = (proxyHook ? `${proxyHook}\r` : '') + (autoCmd ? `${autoCmd}\r` : '');
    await inputBuffer.markReady(startup);
  } catch (e) {
    inputBuffer.markFailed();
    session.status = 'failed';
    session.restorable = false;
    tabEl.classList.add('failed');
    updateTerminalPaneStatus(session);
    characterTheme.handleTerminalEvent('failure');
    persistSessionLayout();
    term.write(`\r\n\x1b[31m启动失败: ${e}\x1b[0m\r\n`);
  }

  refreshExpandedHistoryCards();
  syncProjectIdeasContext();
  return id;
}

function setupTermResize() {
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    const h = Math.min(Math.max(startH + (startY - e.clientY), 160), window.innerHeight);
    termEl.dock.style.height = h + 'px';
    scheduleFitVisibleSessions();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    document.body.style.userSelect = '';
    termEl.dock.classList.remove('is-resizing');
    applySessionRailHeight();
    scheduleFitVisibleSessions(true);
  };
  termEl.resize.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = termEl.dock.offsetHeight;
    document.body.style.userSelect = 'none';
    termEl.dock.classList.add('is-resizing');
    themePointer.hide();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp, { once: true });
  });
}

function setupTerminalPaneSplitters() {
  let drag = null;

  const onMove = (event) => {
    if (!drag) return;
    const rect = termEl.bodies.getBoundingClientRect();
    const raw = drag.axis === 'vertical'
      ? ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100
      : ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
    const percent = Math.max(20, Math.min(80, raw));
    const property = drag.axis === 'vertical' ? '--terminal-split-column' : '--terminal-split-row';
    termEl.bodies.style.setProperty(property, `${percent}%`);
    scheduleFitVisibleSessions();
  };

  const onUp = () => {
    if (!drag) return;
    drag.splitter.classList.remove('is-dragging');
    drag = null;
    termEl.bodies.classList.remove('is-pane-resizing');
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    window.removeEventListener('blur', onUp);
    scheduleFitVisibleSessions(true);
  };

  const start = (axis, splitter, event) => {
    const arrangement = currentTerminalPaneArrangement();
    const allowed = axis === 'vertical'
      ? arrangement === 'columns' || arrangement === 'main' || arrangement === 'grid'
      : arrangement === 'rows' || arrangement === 'main' || arrangement === 'grid';
    if (!allowed) return;
    event.preventDefault();
    drag = { axis, splitter };
    splitter.classList.add('is-dragging');
    termEl.bodies.classList.add('is-pane-resizing');
    document.body.style.userSelect = 'none';
    themePointer.hide();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp, { once: true });
  };

  termEl.paneSplitterVertical.addEventListener('mousedown', event => {
    start('vertical', termEl.paneSplitterVertical, event);
  });
  termEl.paneSplitterHorizontal.addEventListener('mousedown', event => {
    start('horizontal', termEl.paneSplitterHorizontal, event);
  });
}

init();
