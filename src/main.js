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
let requirements = [];
let currentEditId = null;
let pendingConfirm = null;
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
  launchMenu: $('launch-menu'),
  treeCtxMenu: $('tree-context-menu'),
};

async function init() {
  await load();
  bind();
  await initTermTheme(); // 自定义主题表 + 恢复上次主题（可能是 custom:*），先于会话还原
  bindUsageEvents();
  maybeRestoreSessions();
}

// 用量后台：探测 npx 是否可用 + 安装引导（与终端是否打开无关，启动即跑）
async function bindUsageEvents() {
  // 后台探一次 npx 是否可用（决定花费/Codex/OpenCode 是否降级），结果缓存
  invoke('has_npx').then(v => { npxAvailable = v; }).catch(() => {});
  // 「去安装 Node.js」按钮（降级块里，事件委托）
  document.addEventListener('click', e => {
    if (e.target.closest('.usage-install-node')) {
      invoke('open_url', { url: 'https://nodejs.org/' }).catch(() => {});
    }
  });
}

async function load() {
  try {
    projects = await invoke('get_projects');
    servers = await invoke('get_servers');
    try { snippets = await invoke('get_snippets'); } catch (_) { snippets = []; }
    try { requirements = await invoke('get_requirements'); } catch (_) { requirements = []; }
    renderGroups();
    render(projects);
    el.countAll.textContent = projects.length;
    updateReqBadge();
    renderSnippetQuick();
    startScheduler();
  } catch (e) {
    console.error('加载失败:', e);
    appLog('error', '初始数据加载失败：' + (e.message || e));
    msg('加载失败: ' + (e.message || e), 'error');
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
            ${esc(p.name)}
            ${p.group ? `<span class="card-group">${esc(p.group)}</span>` : ''}
          </div>
          <div class="card-info">
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/></svg>
              <span title="${escAttr(p.localPath)}">${esc(short(p.localPath))}</span>
            </div>
            ${p.remoteUrl ? `<div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/></svg>
              <a class="card-remote-link" href="${escAttr(p.remoteUrl)}" rel="noopener noreferrer">${esc(repo(p.remoteUrl))}</a>
            </div>` : ''}
          </div>
          ${p.description ? `<div class="card-desc">${esc(p.description)}</div>` : ''}
          <div class="card-tags">
            <span class="tag ${tagCls(p.machine)}">${tagLabel(p.machine)}</span>
            ${p.machine === 'server' && p.serverId ? `<span class="tag tag-server">${esc(getServerName(p.serverId))}</span>` : ''}
            <span class="card-git" data-git-id="${p.id}"></span>
          </div>
        </div>
        <div class="card-actions">
          <button class="action-btn context-btn" title="恢复现场（git/改动/CLAUDE.md）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>
          </button>
          <button class="action-btn terminal-btn" title="打开终端">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M3.375 3h17.25c.621 0 1.125.504 1.125 1.125v15.75c0 .621-.504 1.125-1.125 1.125H3.375c-.621 0-1.125-.504-1.125-1.125V4.125C2.25 3.504 2.754 3 3.375 3z"/></svg>
          </button>
          <button class="action-btn edit-btn" title="编辑">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/></svg>
          </button>
          <button class="action-btn danger del-btn" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
          </button>
        </div>
      </div>
    </div>
  `).join('');

  el.list.querySelectorAll('.project-card').forEach(card => {
    const id = card.dataset.id;
    const p = projects.find(x => x.id === id);
    if (!p) return;
    card.querySelector('.context-btn').onclick = (ev) => {
      ev.stopPropagation();
      openContextModal(p);
    };
    card.querySelector('.terminal-btn').onclick = (ev) => {
      ev.stopPropagation();
      openLaunchMenu(p, ev.currentTarget);
    };
    card.querySelector('.edit-btn').onclick = () => openModal(p);
    card.querySelector('.del-btn').onclick = () => del(p.id, p.name);
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

function bind() {
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
  el.search.oninput = () => filterAndRender();

  document.querySelector('[data-group="all"]').onclick = (e) => {
    e.preventDefault();
    activeGroup = 'all';
    document.querySelectorAll('.sider .menu-item').forEach(i => i.classList.remove('active'));
    e.currentTarget.classList.add('active');
    filterAndRender();
  };

  // 需求清单
  $('req-entry').onclick = (e) => { e.preventDefault(); openReqModal(); };
  $('req-modal-close').onclick = closeReqModal;
  $('req-modal-overlay').onclick = e => { if (e.target === $('req-modal-overlay')) closeReqModal(); };
  $('req-add-btn').onclick = addRequirement;
  $('req-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRequirement(); } });
  $('req-tabs').querySelectorAll('.req-tab').forEach(tab => {
    tab.onclick = () => {
      reqFilter = tab.dataset.filter;
      $('req-tabs').querySelectorAll('.req-tab').forEach(t => t.classList.toggle('active', t === tab));
      renderReqList();
    };
  });

  document.onkeydown = e => { if (e.key === 'Escape') { closeModal(); closeDel(); closeServerModal(); closeServerList(); closeReqModal(); } };

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

  // 「打开终端」AI CLI 选择菜单
  el.launchMenu.querySelectorAll('.launch-item').forEach(item => {
    item.onclick = () => {
      const cmd = item.dataset.cmd;
      const p = launchMenuProject;
      closeLaunchMenu();
      if (p) openTerminal(p, cmd);
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#launch-menu') && !e.target.closest('.terminal-btn')) closeLaunchMenu();
  });
  window.addEventListener('resize', closeLaunchMenu);
  document.addEventListener('scroll', closeLaunchMenu, true);

  // 内置终端
  termEl.fab.onclick = () => { sessions.size ? openDock() : createSession({}); };
  termEl.collapseBtn.onclick = collapseDock;
  termEl.maximizeBtn.onclick = toggleDockMaximize;
  termEl.newBtn.onclick = () => createSession({});
  termEl.bellBtn.onclick = toggleNotify;
  applyBellState();
  // Prompt 片段库
  termEl.snippetBtn.onclick = (ev) => { ev.stopPropagation(); toggleSnippetMenu(ev.currentTarget); };
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
  });
  window.addEventListener('resize', closeSnippetMenu);
  // 恢复现场 Modal
  $('context-modal-close').onclick = closeContextModal;
  $('context-modal-overlay').onclick = e => { if (e.target === $('context-modal-overlay')) closeContextModal(); };
  $('context-open-terminal').onclick = () => { const p = contextProject; if (p) { closeContextModal(); openTerminal(p, ''); } };
  $('context-open-claude').onclick = () => { const p = contextProject; if (p) { closeContextModal(); openTerminal(p, 'claude'); } };
  // 窗口重新获得焦点时，正在看的会话就别再亮"需要关注"了 + 刷新 git 状态
  let gitFocusTimer = null;
  window.addEventListener('focus', () => {
    if (activeSession && termEl.dock.classList.contains('active')) clearAttention(activeSession);
    clearTimeout(gitFocusTimer);
    gitFocusTimer = setTimeout(refreshGitStatus, 400); // 防抖：回到窗口稍候再扫
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
    termEl.themeMenu.classList.contains('active') ? closeThemeMenu() : openThemeMenu();
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.term-theme-wrap')) closeThemeMenu();
  });
  // 终端字号快捷键：⌘/Ctrl + 加号放大、减号缩小、0 复位（capture 阶段抢在 xterm 之前）
  document.addEventListener('keydown', (e) => {
    if (!termEl.dock.classList.contains('active')) return;
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
  // 文件树 + 内容预览
  termEl.treeBtn.onclick = toggleTree;
  termEl.treeRefreshBtn.onclick = () => renderTree(treeRoot);
  termEl.previewInsert.onclick = () => insertPathToTerminal(termEl.previewInsert.dataset.path || '');
  termEl.previewToggle.onclick = togglePreviewMode;
  termEl.previewClose.onclick = closePreview;
  // 渲染视图里的链接走系统浏览器，别让主 webview 导航走
  termEl.previewRich.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) invoke('open_folder', { path: href }).catch(() => {});
  });
  setupTreeSplitter();
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
      } else if (action === 'copy') {
        navigator.clipboard?.writeText(ctx.entry.path).then(
          () => msg('路径已复制', 'success'),
          () => msg('复制失败', 'error'),
        );
      } else if (action === 'trash') {
        askConfirm(ctx.entry.isDir ? '文件夹' : '文件', ctx.entry.name, async () => {
          try {
            await invoke('trash_path', { path: ctx.entry.path });
            if (ctx.row === treeActiveRow) closePreview();
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
    if (activeSession) fitSession(activeSession);
  });
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
function showConfirm({ title = '确认', message, confirmText = '确认', danger = true, onConfirm }) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmDelete.textContent = confirmText;
  el.confirmDelete.classList.toggle('btn-danger', danger);
  el.confirmDelete.classList.toggle('btn-primary', !danger);
  pendingConfirm = onConfirm;
  el.confirm.classList.add('active');
}

// 删除类确认的便捷封装
function askConfirm(kind, name, onConfirm) {
  showConfirm({ title: '确认删除', message: `确定要删除${kind} ${name} 吗？`, confirmText: '删除', danger: true, onConfirm });
}

function del(id, name) {
  askConfirm('项目', name, async () => {
    await invoke('delete_project', { id });
    msg('删除成功', 'success');
    await load();
  });
}

function closeDel() {
  el.confirm.classList.remove('active');
  pendingConfirm = null;
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
    recordProjectActivity(p.id, cmd);
    await createSession({ cwd: p.localPath, name: p.name, autoCmd: cmd });
  } catch (e) {
    console.error('打开终端失败:', e);
    msg('打开终端失败: ' + (e.message || e), 'error');
  }
}

// 「打开终端」AI CLI 选择菜单（固定定位，锚到点击的按钮）
let launchMenuProject = null;
function openLaunchMenu(p, anchorEl) {
  launchMenuProject = p;
  const menu = el.launchMenu;
  menu.classList.add('active'); // 先显示以测量尺寸
  const r = anchorEl.getBoundingClientRect();
  let left = Math.max(8, r.right - menu.offsetWidth);
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
function closeLaunchMenu() {
  el.launchMenu.classList.remove('active');
  launchMenuProject = null;
}

let submitting = false;
async function submit(e) {
  e.preventDefault();
  if (!el.form.checkValidity()) {
    el.form.reportValidity();
    return;
  }
  if (submitting) return; // 防止 invoke 在途时重复点「确定」产生重复项目
  submitting = true;

  const data = {
    name: el.name.value.trim(),
    localPath: el.path.value.trim(),
    remoteUrl: el.url.value.trim(),
    machine: el.machine.value,
    serverId: el.machine.value === 'server' ? el.serverSelect.value : '',
    group: el.group.value.trim(),
    description: el.desc.value.trim(),
  };
  if (currentEditId) data.id = currentEditId;

  if (data.machine === 'server' && !data.serverId) {
    msg('请选择服务器', 'error');
    return;
  }

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
let usageAgent = 'claude';      // 当前用量 tab：claude / codex / opencode
let npxAvailable = null;        // null=未知 / true / false：花费统计(ccusage)是否可用
const usageWeeklyInflight = new Set(); // 查询在途的 agent：防连点/快速切 tab 并发起 ccusage

// 没有 npx 时花费/Codex/OpenCode 的友好降级块（限流用量不受影响）
function nodeNeededHTML(what) {
  return `<div class="usage-node-needed">` +
    `<div class="usage-node-title">${esc(what)}需要 Node.js</div>` +
    `<div class="usage-node-sub">限流用量无需 Node、已正常显示。花费/多 CLI 统计经 <code>ccusage</code>（随 <code>npx</code> 自动下载）读取本地日志，需先装 Node.js。</div>` +
    `<button class="btn btn-primary btn-sm usage-install-node">去安装 Node.js</button>` +
    `</div>`;
}

const MODEL_NAMES = {
  'claude-opus-4-8': 'Opus 4.8', 'claude-opus-4-7': 'Opus 4.7', 'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6', 'claude-haiku-4-5': 'Haiku 4.5', 'claude-fable-5': 'Fable 5',
};
function shortModel(m) {
  if (MODEL_NAMES[m]) return MODEL_NAMES[m];
  return String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
const pad2 = (n) => String(n).padStart(2, '0');

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
  try {
    if (agent === 'claude') {
      // Claude tab 只展示 OAuth 限流用量（5h / 7d 使用率 + 重置倒计时）：和 /usage 同源，
      // 零依赖秒出、不需要 Node。花费/燃烧速率/token/周用量等 ccusage 明细已按需求移除。
      body.innerHTML = '<div id="usage-oauth"><div class="usage-loading">查询限流用量…</div></div>';
      invoke('oauth_usage').then(o => {
        if (usageAgent === 'claude') renderOAuth(o);
      }).catch(() => {});
    } else {
      if (npxAvailable === false) {
        body.innerHTML = nodeNeededHTML(agent === 'codex' ? 'Codex 用量' : 'OpenCode 用量');
        return;
      }
      // 每单 agent_weekly 都是一棵吃内存的 ccusage/node 进程树（后端另有全局单飞锁兜底），
      // 该 tab 已有一单在途就不再叠加
      if (usageWeeklyInflight.has(agent)) return;
      usageWeeklyInflight.add(agent);
      body.innerHTML = '<div class="usage-loading">查询中…（首次走 npx 拉 ccusage，稍等）</div>';
      try {
        const w = await invoke('agent_weekly', { agent });
        if (usageAgent !== agent) return;
        body.innerHTML = renderAgentHTML(w, agent);
      } finally {
        usageWeeklyInflight.delete(agent);
      }
    }
  } catch (e) {
    body.innerHTML = `<div class="usage-error">查询失败：${esc(String(e))}</div>`;
  }
}

// OAuth 限流用量（Claude 专属，和 /usage 同源）：5h / 7d 使用百分比 + 重置倒计时。
function renderOAuth(o) {
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
  el.innerHTML =
    `<div class="usage-oauth-head">限流用量${plan}${age}</div>` +
    staleWarn +
    oauthRow('5 小时窗口', o.fiveHour) +
    oauthRow('7 天窗口', o.sevenDay);
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

// Codex / OpenCode tab：只有周用量（这两个没有 5h 窗口概念）。
function renderAgentHTML(w, agent) {
  const name = agent === 'codex' ? 'Codex' : 'OpenCode';
  if (!w || !w.ok) {
    return `<div class="usage-error">${esc((w && w.error) || '查询失败')}<br><br>` +
      `需本机装有 Node/npx 且用过 ${esc(name)}：经 <code>ccusage ${esc(agent)}</code> 读取本地日志统计，不上传任何数据。</div>`;
  }
  return renderWeeklyHTML(w, name + ' 周用量');
}

// 周用量区块：标题 + 累计 + 逐周条形。w 为 AgentWeekly。
function renderWeeklyHTML(w, title) {
  if (!w || !w.ok) {
    return `<div class="usage-weekly" id="usage-weekly-sec"><div class="usage-weekly-head"><span>${esc(title)}</span></div>` +
      `<div class="usage-weekly-empty">${esc((w && w.error) || '暂无数据')}</div></div>`;
  }
  if (!w.weeks || !w.weeks.length) {
    return `<div class="usage-weekly" id="usage-weekly-sec"><div class="usage-weekly-head"><span>${esc(title)}</span></div>` +
      `<div class="usage-weekly-empty">暂无周用量数据</div></div>`;
  }
  const max = Math.max(...w.weeks.map(x => x.costUsd || 0), 0.0001);
  const rows = w.weeks.map(x => {
    const pct = Math.max(3, (x.costUsd || 0) / max * 100);
    const models = (x.models && x.models.length) ? x.models.map(shortModel).join('、') : '';
    return `<div class="usage-week-row">` +
      `<span class="usage-week-date">${esc(weekLabel(x.period))}</span>` +
      `<div class="usage-week-barwrap"><div class="usage-week-bar" style="width:${pct.toFixed(0)}%"></div>` +
        `<span class="usage-week-tok">${fmtTokens(x.totalTokens)}${models ? ' · ' + esc(models) : ''}</span></div>` +
      `<span class="usage-week-cost">$${(x.costUsd || 0).toFixed(2)}</span>` +
      `</div>`;
  }).join('');
  return `<div class="usage-weekly" id="usage-weekly-sec">` +
    `<div class="usage-weekly-head"><span>${esc(title)}</span>` +
      `<span class="usage-weekly-total">累计 $${(w.totalCost || 0).toFixed(2)} · ${fmtTokens(w.totalTokens)}</span></div>` +
    rows + `</div>`;
}

// 周一日期 → "MM/DD 当周"
function weekLabel(period) {
  const d = new Date(period + 'T00:00:00');
  if (isNaN(d.getTime())) return period || '—';
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} 当周`;
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

function tagCls(m) {
  if (m === 'local') return 'tag-local';
  if (m === 'server') return 'tag-ssh';
  return 'tag-other';
}

function tagLabel(m) {
  return { local: '本地电脑', server: '服务器' }[m] || m || '未知';
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
  tabs: $('terminal-tabs'),
  bodies: $('terminal-bodies'),
  resize: $('terminal-resize'),
  newBtn: $('terminal-new-btn'),
  treeBtn: $('terminal-tree-btn'),
  usageBtn: $('terminal-usage-btn'),
  bellBtn: $('terminal-bell-btn'),
  snippetBtn: $('terminal-snippet-btn'),
  themeBtn: $('terminal-theme-btn'),
  themeMenu: $('terminal-theme-menu'),
  maximizeBtn: $('terminal-maximize-btn'),
  collapseBtn: $('terminal-collapse-btn'),
  fab: $('terminal-fab'),
  fabBadge: $('terminal-fab-badge'),
  tree: $('terminal-tree'),
  treeBody: $('tree-body'),
  treeRootName: $('tree-root-name'),
  treeRefreshBtn: $('tree-refresh-btn'),
  treeSplitter: $('tree-splitter'),
  preview: $('file-preview'),
  previewName: $('file-preview-name'),
  previewCode: $('file-preview-code'),
  previewPre: $('file-preview-pre'),
  previewImage: $('file-preview-image'),
  previewImg: $('file-preview-img'),
  previewRich: $('file-preview-rich'),
  previewPdf: $('file-preview-pdf'),
  previewToggle: $('file-preview-toggle'),
  previewBody: $('file-preview-body'),
  previewInsert: $('file-preview-insert'),
  previewClose: $('file-preview-close'),
};

// 标签一屏放不下时横向滚动查看；触控板本来能横滑，这里让鼠标竖向滚轮也能滚
termEl.tabs.addEventListener('wheel', (ev) => {
  if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
  if (termEl.tabs.scrollWidth <= termEl.tabs.clientWidth) return;
  ev.preventDefault();
  termEl.tabs.scrollLeft += ev.deltaY;
}, { passive: false });

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
  // 卡哇伊·樱花：仅作 DIY 的粉彩 base 调色板保留（hidden：不在主题菜单单列，
  // 招牌樱花改由 initTermTheme 预装成「可删的自定义主题」，见 SAKURA_PRESET）。
  'sakura': {
    name: '🌸 樱花',
    icon: 'assets/theme-icon-sakura.png',
    hidden: true,
    theme: {
      // 底色全透明：带图主题靠 DOM 渲染 + CSS 强制透明，让立绘透上来；文字对比靠 .terminal-bodies 暗化
      background: 'rgba(40, 24, 44, 0)', foreground: '#ffe6f2', cursor: '#ff8fc4',
      cursorAccent: '#2b1b2e', selectionBackground: 'rgba(255, 143, 196, 0.40)',
      black: '#4a3442', red: '#ff8093', green: '#9be3c0', yellow: '#ffd9a0',
      blue: '#b4a6ff', magenta: '#ff9ecf', cyan: '#a0e6e6', white: '#f4d9e6',
      brightBlack: '#6b4f5f', brightRed: '#ff9db0', brightGreen: '#b6f0d6', brightYellow: '#ffe8c4',
      brightBlue: '#cfc4ff', brightMagenta: '#ffbfe0', brightCyan: '#c4f0f0', brightWhite: '#fff2f9',
    },
    bg: { image: 'assets/term-bg-kawaii.png', dim: 0.30, tint: '120, 45, 95', base: '#3a2338' },
    clickFx: true, // 点击迸出爱心/花瓣
  },
};
let currentTheme = localStorage.getItem('term-theme') || 'classic';

// 应用终端背景（含卡哇伊立绘）：有 bg.image 铺图 + 暗化遮罩，否则纯色底。
// 图铺在 .terminal-bodies 上，term-body/xterm 透明，靠 allowTransparency + 半透明主题底透上来。
function applyTermBackground(def) {
  const dock = termEl.dock, b = termEl.bodies;
  if (!dock || !b) return;
  if (def && def.bg && def.bg.image) {
    const dim = def.bg.dim != null ? def.bg.dim : 0.3;
    const tint = def.bg.tint || '20, 12, 20'; // 遮罩色调：卡哇伊用玫瑰粉而非深黑，避免发暗发灰
    // 立绘铺满整个 dock（头栏+侧栏+终端共享一张连续背景）；头/侧栏做半透明面板浮其上
    dock.style.backgroundColor = def.bg.base || '#1b1420';
    dock.style.backgroundImage =
      `linear-gradient(rgba(${tint}, ${dim}), rgba(${tint}, ${dim})), url("${def.bg.image}")`;
    dock.style.backgroundSize = 'cover';
    dock.style.backgroundPosition = 'center';
    dock.style.backgroundRepeat = 'no-repeat';
    dock.classList.add('has-bg');
    b.classList.add('has-bg');       // 触发 CSS 强制 xterm 各层透明，让 dock 立绘透上来
    b.style.background = 'transparent';
    b.style.backgroundImage = 'none';
  } else {
    dock.classList.remove('has-bg');
    b.classList.remove('has-bg');
    dock.style.backgroundImage = 'none';
    dock.style.backgroundColor = '';   // 还原到 CSS 的 #1b1f27
    b.style.backgroundImage = 'none';
    b.style.background = def.theme.background;
  }
}
if (!TERM_THEMES[currentTheme] && !String(currentTheme).startsWith('custom:')) currentTheme = 'classic';

// ===== DIY 自定义主题：换背景图 / 遮罩调节 / 多套保存（term-themes.json）+ 点击特效 =====
let termCustomThemes = [];       // 自定义主题表（get_term_themes 拉取）
let currentThemeDef = TERM_THEMES[currentTheme] || TERM_THEMES.classic; // custom:* 启动先兜底，initTermTheme 精确应用
let clickFxEnabled = !!currentThemeDef.clickFx;
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
  const def = { name: t.name, theme: { ...base.theme }, clickFx: !!t.clickFx };
  const url = await resolveThemeImage(t.image);
  if (url) {
    def.theme.background = 'rgba(0, 0, 0, 0)'; // 带图必须全透底，立绘才透得上来
    def.bg = { image: url, dim: t.dim != null ? t.dim : 0.3, tint: t.tint || '120, 45, 95', base: '#3a2338' };
  } else {
    def.theme.background = base.theme.background; // 无图还原基础底色（樱花底本身是透明的）
    if (t.base === 'sakura') def.theme.background = '#2b1b2e';
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
  clickFxEnabled = !!def.clickFx;
  const hasBg = !!def.bg;
  sessions.forEach(s => {
    s.term.options.theme = def.theme;
    // 带图主题必须 DOM 渲染：拆掉 WebGL；切回无图主题再装回（恢复防 ghosting）
    if (hasBg && s.webgl) { try { s.webgl.dispose(); } catch (_) {} s.webgl = null; }
    else if (!hasBg && !s.webgl) { s.webgl = attachWebgl(s.term); }
    clearTermAtlas(s.term);
  });
  applyTermBackground(def);
}

// 预装「樱花」主题：招牌卡哇伊立绘,降级成可编辑可删除的自定义主题(不再硬编码内置)。
// base 仍指向 TERM_THEMES.sakura 的粉彩调色板(hidden 保留),icon 用专属花朵图。
const SAKURA_PRESET = {
  id: 'sakura-default', name: '🌸 樱花', base: 'sakura',
  image: 'builtin:assets/term-bg-kawaii.png', dim: 0.30, tint: '120, 45, 95',
  clickFx: true, icon: 'assets/theme-icon-sakura.png', createdAt: '',
};

// 启动：拉自定义主题表 + 恢复上次主题（可能是 custom:*）
async function initTermTheme() {
  try { termCustomThemes = await invoke('get_term_themes'); } catch (_) { termCustomThemes = []; }
  // 首次运行预装樱花(可删)。用持久标记判断而非"表为空"——否则用户删掉后每次启动又被种回来。
  if (!localStorage.getItem('term-sakura-seeded')) {
    localStorage.setItem('term-sakura-seeded', '1');
    if (!termCustomThemes.some(t => t.id === SAKURA_PRESET.id)) {
      termCustomThemes.push({ ...SAKURA_PRESET });
      try { termCustomThemes = await invoke('save_term_themes', { themes: termCustomThemes }); } catch (_) {}
    }
    // 老用户此前选中的是内置樱花(已降级)——迁移到预装的自定义樱花,避免菜单里选中项消失
    if (currentTheme === 'sakura') {
      currentTheme = 'custom:' + SAKURA_PRESET.id;
      localStorage.setItem('term-theme', currentTheme);
    }
  }
  try { applyThemeDef(await resolveThemeDef(currentTheme)); } catch (_) {}
}

// —— 点击特效：迸出爱心/花瓣/星星（主题可开关，仅终端 dock 内触发）——
const FX_SHAPES = [
  '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.9-9.8-9.2C.7 8.9 2.2 5.5 5.3 5c2-.3 3.6.7 4.7 2.2C11.1 5.7 12.7 4.7 14.7 5c3.1.5 4.6 3.9 3.1 6.8C15.5 16.1 12 21 12 21z" fill="#ff8fbf"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M12 2.5c3 3.6 3 7.4 0 11-3-3.6-3-7.4 0-11z" fill="#ffc0de" transform="rotate(35 12 12)"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" fill="#fff0f8"/></svg>',
];
function spawnClickFx(x, y) {
  for (let i = 0; i < 5; i++) {
    const el = document.createElement('span');
    el.className = 'term-fx';
    el.innerHTML = FX_SHAPES[(Math.random() * FX_SHAPES.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const d = 24 + Math.random() * 36;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = el.style.height = (10 + Math.random() * 8) + 'px';
    el.style.setProperty('--dx', (Math.cos(a) * d) + 'px');
    el.style.setProperty('--dy', (Math.sin(a) * d - 22) + 'px');
    el.style.setProperty('--rot', (Math.random() * 140 - 70) + 'deg');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 800);
  }
}
termEl.dock.addEventListener('pointerdown', (e) => { if (clickFxEnabled) spawnClickFx(e.clientX, e.clientY); });

// —— DIY 面板：所有控件改动实时预览，保存整表回写 term-themes.json ——
const DIY_BASES = [['sakura', '樱花粉彩'], ['classic', '默认深色']];
const DIY_TINTS = [
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
    `<div class="term-diy-row"><label>特效</label><label class="term-diy-fx"><input type="checkbox" id="diy-fx"> 点击迸出爱心花瓣</label></div>` +
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
  // 背景图：无图 / 内置立绘 / 选本地图片（拷入 appdata，agy 出的图从这里换上）
  const imgBox = diyEl.querySelector('#diy-img');
  imgBox.innerHTML = '';
  const isFile = (diyEditing.image || '').startsWith('file:');
  [['', '无图'], ['builtin:assets/term-bg-kawaii.png', '内置立绘']].forEach(([v, name]) => {
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
    : { id: '', name: '', base: 'sakura', image: 'builtin:assets/term-bg-kawaii.png', dim: 0.30, tint: '120, 45, 95', clickFx: true, createdAt: '' };
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
  const i = termCustomThemes.findIndex(t => t.id === diyEditing.id);
  if (i >= 0) termCustomThemes[i] = { ...diyEditing };
  else termCustomThemes.push({ ...diyEditing });
  try {
    termCustomThemes = await invoke('save_term_themes', { themes: termCustomThemes });
  } catch (e) { msg('保存失败：' + e, 'error'); return; }
  const key = 'custom:' + diyEditing.id;
  diyEl.classList.remove('active');
  diyEditing = null;
  await setTermTheme(key);
  msg('主题已保存', 'success');
}

async function diyDelete() {
  if (!diyEditing || !diyEditing.id) return;
  const deletedKey = 'custom:' + diyEditing.id;
  termCustomThemes = termCustomThemes.filter(t => t.id !== diyEditing.id);
  try {
    termCustomThemes = await invoke('save_term_themes', { themes: termCustomThemes });
  } catch (e) { msg('删除失败：' + e, 'error'); return; }
  diyEl.classList.remove('active');
  diyEditing = null;
  await setTermTheme(diyPrevKey === deletedKey ? 'sakura' : diyPrevKey);
  msg('主题已删除', 'success');
}

// 终端字号（⌘+ / ⌘- / ⌘0 调整，⌘+滚轮缩放，持久化）
const TERM_FONT_MIN = 8, TERM_FONT_MAX = 32, TERM_FONT_DEFAULT = 13;
let currentFontSize = parseInt(localStorage.getItem('term-fontsize'), 10) || TERM_FONT_DEFAULT;
if (currentFontSize < TERM_FONT_MIN || currentFontSize > TERM_FONT_MAX) currentFontSize = TERM_FONT_DEFAULT;

const sessions = new Map(); // id -> { term, fit, tabEl, bodyEl, name, status, attention }
let activeSession = null;
let termSeq = 0;
let termEventsBound = false;

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
    && termEl.dock.classList.contains('active')
    && activeSession === id;
  return !focusedOnIt;
}
function markAttention(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.attention = true;
  s.tabEl.classList.add('attention');
  updateFabBadge();
}
function clearAttention(id) {
  const s = sessions.get(id);
  if (!s || !s.attention) return;
  s.attention = false;
  s.tabEl.classList.remove('attention');
  updateFabBadge();
}

// ===== 会话恢复：记住上次的终端标签布局，重开应用一键还原 =====
// PTY 进程随应用退出无法真正续命，恢复的是"布局"——同目录、同 CLI 重新拉起；
// Claude 标签用 --continue 接上次对话。
function persistSessionLayout() {
  const layout = [];
  sessions.forEach(s => layout.push({ cwd: s.cwd || '', name: s.name || '', autoCmd: s.tool || '' }));
  try { localStorage.setItem('term-session-layout', JSON.stringify(layout)); } catch (_) {}
}
function maybeRestoreSessions() {
  let layout;
  try { layout = JSON.parse(localStorage.getItem('term-session-layout') || '[]'); } catch (_) { layout = []; }
  if (!Array.isArray(layout) || !layout.length) return;
  // 问一次就把记录清掉：恢复会重新落盘最新布局，取消则不再纠缠
  localStorage.removeItem('term-session-layout');
  const cmds = layout.filter(it => it && typeof it.autoCmd === 'string' && it.autoCmd)
    .map(it => it.autoCmd.trim().split(/\s+/)[0]);
  const hasClaude = cmds.includes('claude');
  showConfirm({
    title: '恢复终端会话',
    message: `上次有 ${layout.length} 个终端会话，要恢复吗？\n同目录重新拉起对应 CLI。${hasClaude ? '\nClaude 标签会用 --continue 接上次对话。' : ''}`,
    confirmText: '恢复',
    danger: false,
    onConfirm: () => restoreSessions(layout),
  });
}
async function restoreSessions(layout) {
  for (const it of layout) {
    if (!it || typeof it !== 'object') continue;
    let cmd = (typeof it.autoCmd === 'string' ? it.autoCmd : '').trim();
    const first = cmd.split(/\s+/)[0];
    // claude 接上次对话；已带 continue/resume 就不重复加
    if (first === 'claude' && !/(^|\s)(--continue|--resume|-c)(\s|$)/.test(cmd)) {
      cmd = cmd + ' --continue';
    }
    try { await createSession({ cwd: it.cwd, name: it.name, autoCmd: cmd }); } catch (_) {}
  }
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

function toggleSnippetMenu(anchorEl) {
  const menu = $('snippet-menu');
  if (menu.classList.contains('active')) { closeSnippetMenu(); return; }
  renderSnippetMenu();
  menu.classList.add('active'); // 先显示以测量尺寸
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, r.right - menu.offsetWidth);
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 6;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
function closeSnippetMenu() { $('snippet-menu').classList.remove('active'); }

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
// 串行化保存（同 persistRequirements），避免快速增改时整表快照乱序覆盖。
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

// ===== 需求清单：碎片需求收集箱 =====
let reqFilter = 'all';
let reqEditId = null; // 正在行内编辑的需求 id

const REQ_STATUS = {
  todo:  { label: '待办',   next: 'doing' },
  doing: { label: '进行中', next: 'done'  },
  done:  { label: '已完成', next: 'todo'  },
};
const REQ_PRIORITY = { high: '重要', normal: '普通', low: '次要' };

// 侧栏角标：未完成需求数
function updateReqBadge() {
  const badge = $('req-count');
  if (!badge) return;
  const n = requirements.filter(r => r.status !== 'done').length;
  badge.textContent = n;
  badge.style.display = n > 0 ? '' : 'none';
}

function reqProjectName(id) {
  if (!id) return '';
  const p = projects.find(x => x.id === id);
  return p ? p.name : '';
}

function fillReqProjectSelect(sel, selectedId) {
  if (!sel) return;
  sel.innerHTML = ['<option value="">不关联项目</option>']
    .concat(projects.map(p => `<option value="${escAttr(p.id)}">${esc(p.name)}</option>`))
    .join('');
  sel.value = selectedId || '';
}

function openReqModal() {
  reqEditId = null;
  fillReqProjectSelect($('req-project'), '');
  $('req-input').value = '';
  $('req-priority').value = 'normal';
  renderReqList();
  $('req-modal-overlay').classList.add('active');
  setTimeout(() => $('req-input').focus(), 50);
}
function closeReqModal() { $('req-modal-overlay')?.classList.remove('active'); }

// 串行化保存：连续快速增改时，避免两次保存的整表快照乱序覆盖、把刚记的项挤掉。
// 同 persistSnippets：不整体替换数组（否则丢在途新增/删除），只按序回填后端 id/时间戳；
// 失败时上抛，调用方据此不弹假成功。
let reqSaveChain = Promise.resolve();
function persistRequirements() {
  const run = reqSaveChain.then(async () => {
    const snapshot = requirements.slice();
    const saved = await invoke('save_requirements', { requirements: snapshot });
    backfillMeta(snapshot, saved, ['id', 'createdAt', 'updatedAt']);
    updateReqBadge();
  }).catch(e => { msg('保存失败: ' + (e.message || e), 'error'); throw e; });
  reqSaveChain = run.catch(() => {});
  return run;
}

async function addRequirement() {
  const input = $('req-input');
  const title = input.value.trim();
  if (!title) { input.focus(); return; }
  requirements.unshift({
    id: '', title, note: '',
    status: 'todo',
    priority: $('req-priority').value || 'normal',
    projectId: $('req-project').value || '',
    createdAt: '', updatedAt: '',
  });
  input.value = '';
  try { await persistRequirements(); } catch (_) { return; }
  renderReqList();
  input.focus();
}

async function cycleReqStatus(r) {
  const prev = r.status;
  r.status = REQ_STATUS[r.status]?.next || 'todo';
  try { await persistRequirements(); } catch (_) { r.status = prev; renderReqList(); return; }
  renderReqList();
}

function reqCounts() {
  const c = { all: requirements.length, todo: 0, doing: 0, done: 0 };
  requirements.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  return c;
}

function reqRowHtml(r) {
  const st = REQ_STATUS[r.status] || REQ_STATUS.todo;
  const pname = reqProjectName(r.projectId);
  const time = (r.createdAt || '').slice(5, 16); // MM-DD HH:MM
  return `
  <div class="req-row${r.status === 'done' ? ' req-done' : ''}" data-id="${escAttr(r.id)}">
    <button class="req-status req-status-${r.status}" title="点击切换：待办 → 进行中 → 已完成" data-act="cycle">
      <span class="req-status-dot"></span><span class="req-status-label">${esc(st.label)}</span>
    </button>
    <div class="req-main">
      <div class="req-title">${esc(r.title)}</div>
      ${r.note ? `<div class="req-note">${esc(r.note)}</div>` : ''}
      <div class="req-meta">
        <span class="req-pri req-pri-${r.priority}">${esc(REQ_PRIORITY[r.priority] || '普通')}</span>
        ${pname ? `<span class="req-tag" title="关联项目">${esc(pname)}</span>` : ''}
        ${time ? `<span class="req-time">${esc(time)}</span>` : ''}
      </div>
    </div>
    <div class="req-actions">
      <button class="action-btn" data-act="edit" title="编辑">${SNIPPET_ICONS.edit}</button>
      <button class="action-btn danger" data-act="del" title="删除">${SNIPPET_ICONS.del}</button>
    </div>
  </div>`;
}

function reqEditRowHtml(r) {
  return `
  <div class="req-row req-row-editing" data-id="${escAttr(r.id)}">
    <div class="req-edit">
      <input class="form-input" type="text" id="req-edit-title" value="${escAttr(r.title)}" maxlength="200" placeholder="需求标题" />
      <textarea class="form-input" id="req-edit-note" rows="2" placeholder="补充说明（可空）">${esc(r.note || '')}</textarea>
      <div class="req-edit-row">
        <select class="form-select" id="req-edit-priority">
          <option value="normal">普通</option>
          <option value="high">重要</option>
          <option value="low">次要</option>
        </select>
        <select class="form-select" id="req-edit-project"></select>
        <span class="req-edit-spacer"></span>
        <button class="btn btn-default btn-sm" data-act="cancel">取消</button>
        <button class="btn btn-primary btn-sm" data-act="save">保存</button>
      </div>
    </div>
  </div>`;
}

function renderReqList() {
  const c = reqCounts();
  $('req-c-all').textContent = c.all;
  $('req-c-todo').textContent = c.todo;
  $('req-c-doing').textContent = c.doing;
  $('req-c-done').textContent = c.done;

  const list = $('req-list');
  const empty = $('req-empty');
  const items = reqFilter === 'all' ? requirements : requirements.filter(r => r.status === reqFilter);

  if (!items.length) {
    list.style.display = 'none';
    empty.style.display = '';
    empty.textContent = requirements.length ? '该分类下暂无需求' : '还没有需求，在上方随手记一条吧';
    return;
  }
  empty.style.display = 'none';
  list.style.display = '';
  list.innerHTML = items.map(r => reqEditId === r.id ? reqEditRowHtml(r) : reqRowHtml(r)).join('');

  list.querySelectorAll('.req-row').forEach(row => {
    const r = requirements.find(x => x.id === row.dataset.id);
    if (!r) return;

    if (reqEditId === r.id) {
      $('req-edit-priority').value = r.priority || 'normal';
      fillReqProjectSelect($('req-edit-project'), r.projectId);
      const close = () => { reqEditId = null; renderReqList(); };
      row.querySelector('[data-act="cancel"]').onclick = close;
      row.querySelector('[data-act="save"]').onclick = async () => {
        const t = $('req-edit-title').value.trim();
        if (!t) { msg('标题不能为空', 'error'); $('req-edit-title').focus(); return; }
        r.title = t;
        r.note = $('req-edit-note').value.trim();
        r.priority = $('req-edit-priority').value;
        r.projectId = $('req-edit-project').value;
        reqEditId = null;
        try { await persistRequirements(); } catch (_) { renderReqList(); return; }
        renderReqList();
      };
      $('req-edit-title').addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) row.querySelector('[data-act="save"]').click();
      });
      return;
    }

    row.querySelectorAll('[data-act]').forEach(elm => {
      elm.onclick = (ev) => {
        ev.stopPropagation();
        const act = elm.dataset.act;
        if (act === 'cycle') return cycleReqStatus(r);
        if (act === 'edit') {
          reqEditId = r.id;
          renderReqList();
          setTimeout(() => $('req-edit-title')?.focus(), 30);
          return;
        }
        if (act === 'del') {
          askConfirm('需求', r.title, async () => {
            requirements = requirements.filter(x => x.id !== r.id);
            try { await persistRequirements(); } catch (_) { return; }
            renderReqList();
            msg('已删除', 'success');
          });
        }
      };
    });
  });
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
    }
  });
  await listen('terminal-exit', e => {
    const s = sessions.get(e.payload);
    if (s) {
      s.status = 'exited';
      s.tabEl.classList.add('exited');
      s.term.write('\r\n\x1b[90m[会话已结束]\x1b[0m\r\n');
      if (shouldNotify(e.payload)) {
        beep();
        invoke('notify', { title: `${s.name || '终端'} 已结束`, body: '终端会话已退出' }).catch(() => {});
      }
    }
  });
  // 会话状态感知：某会话活跃后静默 → AI 可能跑完/在等你输入
  await listen('terminal-attention', e => {
    const { id, name, tool } = e.payload || {};
    const s = sessions.get(id);
    if (!s || s.status === 'exited') return;
    markAttention(id);
    if (shouldNotify(id)) {
      beep();
      const label = name || s.name || '终端';
      const what = tool ? `${tool} 可能跑完了，或在等你输入` : '命令已结束，或在等你输入';
      invoke('notify', { title: `${label} 需要关注`, body: what }).catch(() => {});
    }
  });

  // 拖拽文件/文件夹到终端面板 → 把路径写入当前会话（同 macOS 终端）
  const overDock = (pos) => {
    if (!pos || !termEl.dock.classList.contains('active')) return false;
    const dpr = window.devicePixelRatio || 1;
    const x = pos.x / dpr, y = pos.y / dpr;
    const r = termEl.dock.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  await listen('tauri://drag-over', e => {
    termEl.dock.classList.toggle('drag-target', overDock(e.payload && e.payload.position));
  });
  await listen('tauri://drag-leave', () => {
    termEl.dock.classList.remove('drag-target');
  });
  await listen('tauri://drag-drop', e => {
    termEl.dock.classList.remove('drag-target');
    const p = e.payload || {};
    if (!overDock(p.position) || !activeSession) return;
    const paths = (p.paths || []).filter(Boolean);
    if (!paths.length) return;
    const data = paths.map(shellQuotePath).join(' ') + ' ';
    invoke('terminal_write', { id: activeSession, data }).catch(() => {});
    sessions.get(activeSession)?.term.focus();
  });
}

const IS_WINDOWS = navigator.userAgent.includes('Windows');

// shell 路径转义。Windows(PowerShell/cmd)用双引号；Unix(bash/zsh)用单引号
function shellQuotePath(p) {
  if (IS_WINDOWS) {
    // 含空格或 shell 元字符时双引号包裹（Windows 路径几乎不含 " / $ / 反引号）
    return /[\s&()^%!,;'`$]/.test(p) ? `"${p}"` : p;
  }
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(p)) return p;
  return "'" + p.replace(/'/g, "'\\''") + "'";
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

function openThemeMenu() { renderThemeMenu(); termEl.themeMenu.classList.add('active'); }
function closeThemeMenu() { termEl.themeMenu.classList.remove('active'); }

// 调整终端字号：更新所有会话 + 重新 fit（行列数随字号变），并持久化
function setTermFontSize(size) {
  size = Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, size));
  if (size === currentFontSize) return;
  currentFontSize = size;
  localStorage.setItem('term-fontsize', String(size));
  sessions.forEach((s, id) => { s.term.options.fontSize = size; clearTermAtlas(s.term); fitSession(id); });
}

// DPR 变化（窗口在不同缩放的显示器间移动）会让 WebGL 图集坐标错位 → 花屏。
// 监听并清图集 + 重新 fit。matchMedia 一次性触发，回调里重新挂监听。
function watchDprChange() {
  const dpr = window.devicePixelRatio || 1;
  const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
  const onChange = () => {
    sessions.forEach((s, id) => { clearTermAtlas(s.term); fitSession(id); });
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
  lua: 'lua', sql: 'sql', html: 'xml', xml: 'xml', vue: 'xml', css: 'css',
  scss: 'scss', less: 'less', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', conf: 'ini', md: 'markdown', markdown: 'markdown',
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
  if (/^(js|mjs|cjs|ts|tsx|jsx|vue|go|rs|py|rb|java|kt|c|h|hpp|cpp|cc|cs|php|swift|sh|bash|zsh|lua|sql|html|css|scss)$/.test(ext)) return 'code';
  if (/^(json|ya?ml|toml|ini|env|conf|cfg|lock|xml|gradle|properties)$/.test(ext)) return 'config';
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
        if (treeActiveRow) treeActiveRow.classList.remove('active');
        treeActiveRow = row;
        row.classList.add('active');
        openPreview(entry.path, entry.name);
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

function insertPathToTerminal(path) {
  if (!activeSession) return;
  invoke('terminal_write', { id: activeSession, data: shellQuotePath(path) + ' ' }).catch(() => {});
  sessions.get(activeSession)?.term.focus();
}

function isImageFile(name) { return /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i.test(name); }
function isPdfFile(name) { return /\.pdf$/i.test(name); }
function isMarkdownFile(name) { return /\.(md|markdown)$/i.test(name); }
function isCsvFile(name) { return /\.(csv|tsv)$/i.test(name); }

let previewPdfUrl = null;            // 当前 PDF 的 object URL（需手动 revoke）
let previewRichState = null;         // { kind:'md'|'csv', content, name } 供源码/渲染切换

// 在四个视图(pre/image/rich/pdf)间切换显示
function showPreviewView(which) {
  termEl.previewPre.style.display = which === 'text' ? '' : 'none';
  termEl.previewImage.classList.toggle('active', which === 'image');
  termEl.previewRich.classList.toggle('active', which === 'rich');
  termEl.previewPdf.classList.toggle('active', which === 'pdf');
}

function revokePreviewPdf() {
  if (previewPdfUrl) { URL.revokeObjectURL(previewPdfUrl); previewPdfUrl = null; }
  termEl.previewPdf.removeAttribute('src');
}

function renderTextPreview(content, name, truncatedNote) {
  showPreviewView('text');
  termEl.previewCode.className = 'hljs';
  termEl.previewCode.removeAttribute('data-highlighted');
  termEl.previewCode.textContent = content;
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

async function openPreview(path, name) {
  termEl.preview.querySelector('.file-preview-truncated')?.remove();
  termEl.previewName.textContent = name;
  termEl.previewName.title = path;
  termEl.previewInsert.dataset.path = path;
  termEl.preview.classList.add('active');
  revokePreviewPdf();
  previewRichState = null;
  termEl.previewToggle.style.display = 'none';
  termEl.previewToggle.classList.remove('active');

  // 图片
  if (isImageFile(name)) {
    showPreviewView('image');
    termEl.previewImg.removeAttribute('src');
    termEl.previewImg.alt = '加载中…';
    try {
      termEl.previewImg.src = await invoke('read_image', { path });
      termEl.previewImg.alt = name;
    } catch (e) { renderTextPreview(String(e), name); }
    return;
  }

  // PDF
  if (isPdfFile(name)) {
    showPreviewView('pdf');
    try {
      const b64 = await invoke('read_binary_base64', { path });
      const blob = new Blob([b64ToBytes(b64)], { type: 'application/pdf' });
      previewPdfUrl = URL.createObjectURL(blob);
      termEl.previewPdf.src = previewPdfUrl;
    } catch (e) { renderTextPreview(String(e), name); }
    return;
  }

  // Markdown / CSV：默认渲染，提供源码/渲染切换
  if (isMarkdownFile(name) || isCsvFile(name)) {
    try {
      const res = await invoke('read_file', { path });
      previewRichState = { kind: isMarkdownFile(name) ? 'md' : 'csv', content: res.content, name };
      termEl.previewToggle.style.display = '';
      termEl.previewToggle.classList.add('active'); // active=渲染态
      renderRich();
      return;
    } catch (e) { renderTextPreview(String(e), name); return; }
  }

  // 普通文本
  try {
    const res = await invoke('read_file', { path });
    renderTextPreview(
      res.content, name,
      res.truncated ? `文件超过 1MB，仅显示前 1MB（共 ${(res.size / 1048576).toFixed(1)} MB）` : null,
    );
  } catch (e) { renderTextPreview(String(e), name); }
}

// 源码 / 渲染切换（仅 md/csv）
function togglePreviewMode() {
  if (!previewRichState) return;
  const toRich = !termEl.previewToggle.classList.contains('active');
  termEl.previewToggle.classList.toggle('active', toRich);
  if (toRich) renderRich();
  else renderTextPreview(previewRichState.content, previewRichState.name, null);
}

function closePreview() {
  termEl.preview.classList.remove('active');
  revokePreviewPdf();
  previewRichState = null;
  if (treeActiveRow) { treeActiveRow.classList.remove('active'); treeActiveRow = null; }
}

function toggleTree() {
  const hidden = termEl.tree.classList.toggle('hidden');
  termEl.treeBtn.classList.toggle('active', !hidden);
  localStorage.setItem('term-tree-hidden', hidden ? '1' : '0');
  if (!hidden && treeRoot === null && activeSession) renderTree(sessions.get(activeSession).cwd);
  if (activeSession) requestAnimationFrame(() => fitSession(activeSession));
}

function setupTreeSplitter() {
  let startX = 0, startW = 0;
  const onMove = (e) => {
    const w = Math.min(Math.max(startW + (e.clientX - startX), 140), 480);
    termEl.tree.style.width = w + 'px';
    if (activeSession) fitSession(activeSession);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    localStorage.setItem('term-tree-width', String(termEl.tree.offsetWidth));
  };
  termEl.treeSplitter.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = termEl.tree.offsetWidth;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ===== 树项拖入终端（自实现鼠标拖拽，绕开 Tauri 原生 drag-drop 对 HTML5 DnD 的干扰）=====
let treeDrag = null;
let treeDragSuppressClick = false;

function isOverTerminalArea(x, y) {
  if (!termEl.dock.classList.contains('active')) return false;
  const r = termEl.bodies.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
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
  termEl.dock.classList.remove('drag-target');
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
    termEl.dock.classList.toggle('drag-target', isOverTerminalArea(e.clientX, e.clientY));
  });
  document.addEventListener('mouseup', (e) => {
    if (!treeDrag) return;
    const d = treeDrag;
    const started = d.started;
    cleanupTreeDrag();
    if (started) {
      treeDragSuppressClick = true; // 抑制随后的 click（预览/展开）
      if (isOverTerminalArea(e.clientX, e.clientY) && activeSession) {
        insertPathToTerminal(d.entry.path);
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
  const menu = el.treeCtxMenu;
  menu.classList.add('active');
  menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
}
function closeTreeCtx() {
  el.treeCtxMenu.classList.remove('active');
  treeCtx = null;
}

function openDock() {
  termEl.dock.classList.add('active');
  termEl.fab.classList.add('hidden');
  if (activeSession) requestAnimationFrame(() => fitSession(activeSession));
}

function collapseDock() {
  termEl.dock.classList.remove('active');
  termEl.fab.classList.remove('hidden');
}

// 最大化/还原终端抽屉，最大化时占满整个窗口高度、不留顶部白边
let dockPrevHeight = null;
function toggleDockMaximize() {
  const maxed = termEl.dock.classList.toggle('maximized');
  if (maxed) {
    dockPrevHeight = termEl.dock.offsetHeight;
    termEl.dock.style.height = window.innerHeight + 'px';
    termEl.maximizeBtn.title = '还原';
  } else {
    termEl.dock.style.height = (dockPrevHeight || 340) + 'px';
    termEl.maximizeBtn.title = '最大化';
  }
  if (activeSession) requestAnimationFrame(() => fitSession(activeSession));
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
    if (!s.cwd) { el.style.display = 'none'; continue; }
    try {
      const b = await invoke('git_branch', { path: s.cwd });
      if (b) {
        el.innerHTML = TAB_BRANCH_SVG + `<span>${esc(b)}</span>`;
        el.title = `git 分支：${b}`;
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    } catch (_) { el.style.display = 'none'; }
  }
}

function fitSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.fit.fit();
    invoke('terminal_resize', { id, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
  } catch (e) {}
}

function activateSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const rootChanged = s.cwd !== treeRoot;
  activeSession = id;
  sessions.forEach((other, oid) => {
    const on = oid === id;
    other.tabEl.classList.toggle('active', on);
    other.bodyEl.classList.toggle('active', on);
  });
  closePreview();
  if (rootChanged) renderTree(s.cwd);
  // 标签栏可横向滚动：激活的标签可能在可视区外，滚进来
  s.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  fitSession(id);
  s.term.focus();
  clearAttention(id);
  updateBranchBadges(); // 切到该标签时刷新分支（catch 终端里的 git checkout）
}

// 关闭终端前确认（提醒先让 AI 更新记忆）
function confirmCloseSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const running = s.status !== 'exited';
  const aiHint = s.tool
    ? `\n如果刚跟 ${s.tool} 聊过，建议先让它「更新记忆」再关，否则上下文会丢。`
    : '';
  showConfirm({
    title: '关闭终端',
    message: `确定关闭「${s.name}」吗？${running ? '\n关闭后该会话立即结束。' : ''}${aiHint}`,
    confirmText: '关闭',
    danger: true,
    onConfirm: () => closeSession(id),
  });
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { await invoke('terminal_close', { id }); } catch (e) {}
  s.term.dispose();
  s.tabEl.remove();
  s.bodyEl.remove();
  sessions.delete(id);
  if (activeSession === id) {
    activeSession = null;
    const next = sessions.keys().next().value;
    if (next) activateSession(next);
    else collapseDock();
  }
  updateFabBadge();
  persistSessionLayout();
}

async function createSession({ cwd = '', name = '', autoCmd = '' }) {
  await bindTermEvents();
  const id = `term-${Date.now()}-${++termSeq}`;
  const label = name || `终端 ${termSeq}`;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'term-body';
  bodyEl.dataset.id = id;
  termEl.bodies.appendChild(bodyEl);

  const tabEl = document.createElement('div');
  tabEl.className = 'term-tab';
  tabEl.dataset.id = id;
  // 徽标只显示工具名（命令首词），不显示参数——否则恢复会话的 "claude --continue" 会整条塞进徽标
  const toolName = (autoCmd || '').trim().split(/\s+/)[0] || '';
  const toolBadge = toolName
    ? `<span class="term-tab-tool tool-${esc(toolName)}">${esc(toolName)}</span>`
    : '';
  tabEl.innerHTML =
    `<span class="term-tab-dot"></span>` +
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

  const term = new window.Terminal({
    fontSize: currentFontSize,
    fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true, // 让半透明主题底透出背景立绘（卡哇伊主题）
    theme: (currentThemeDef || TERM_THEMES.classic).theme,
    // 默认 4.5：会为对比度再生成一批变体字形，配上彩色中文把 WebGL 纹理图集塞爆
    // → 字形错位/残影。设 1 关掉对比度调整，大幅降低图集条目数（修中文花屏的关键）。
    minimumContrastRatio: 1,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(bodyEl);
  // WebGL 渲染器：默认 DOM 渲染器在触控板滚动时选区会糊成一大块（ghosting），
  // 改用 GPU 渲染正确重绘选区/滚动。WebGL 不可用或上下文丢失时安全降级回默认渲染器。
  // 但带背景立绘的主题（卡哇伊）必须走 DOM 渲染——WebGL 画布是像素级不透明，立绘透不上来。
  let webgl = null;
  if (!(currentThemeDef && currentThemeDef.bg)) {
    webgl = attachWebgl(term);
  }
  term.onData(d => invoke('terminal_write', { id, data: d }).catch(() => {}));

  sessions.set(id, { term, fit, tabEl, bodyEl, webgl, name: label, status: 'running', cwd, tool: autoCmd, startedAt: Date.now() });

  openDock();
  activateSession(id);
  requestAnimationFrame(() => fitSession(id));
  updateFabBadge();
  persistSessionLayout();
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
    fitSession(id);
    if (autoCmd) {
      setTimeout(() => invoke('terminal_write', { id, data: autoCmd + '\r' }).catch(() => {}), 400);
    }
  } catch (e) {
    term.write(`\r\n\x1b[31m启动失败: ${e}\x1b[0m\r\n`);
  }

  return id;
}

function setupTermResize() {
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    const h = Math.min(Math.max(startH + (startY - e.clientY), 160), window.innerHeight);
    termEl.dock.style.height = h + 'px';
    if (activeSession) fitSession(activeSession);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
  };
  termEl.resize.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = termEl.dock.offsetHeight;
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

init();
