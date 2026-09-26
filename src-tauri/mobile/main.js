// Roster 手机远程：像 Codex 手机端那样遥控电脑上的对话工作台。
//
// 电脑是唯一的执行者，手机只是第二块屏：发出去的一轮由电脑上的对话工作台照常执行，
// 手机和电脑看到的是同一份事件。事件归并直接复用桌面的 conversation-state.js，
// 两边对同一串事件得出同一个结果，不在手机上另写一套状态机。

import {
  applyConversationChatEvent,
  conversationRunContext,
  createConversationState,
  loadConversationTranscript,
  startConversationTurn,
} from '/lib/conversation-state.js';
import { createTerminalPanel } from '/app/terminal.js';

const $ = id => document.getElementById(id);
// 在安卓外壳（mobile-android）里打开时才有：可以回到连接页换一台电脑。
const shell = window.RosterApp && typeof window.RosterApp.openConnect === 'function' ? window.RosterApp : null;
const PIN_KEY = 'vibe-remote-pin';
const MODE_KEY = 'roster-remote-modes-v1';
const ACTIVE = new Set(['starting', 'running', 'stopping']);
const TERMINAL_EVENTS = new Set(['completed', 'error', 'cancelled']);
// 电脑收下请求后会先登记这一轮；超过这个时间都没有任何回音，多半是电脑端窗口不在了。
const ACK_TIMEOUT_MS = 25_000;
const PROMPT_MAX_BYTES = 64 * 1024;
const PROVIDERS = {
  claude: { label: 'Claude', mark: 'Cl' },
  codex: { label: 'Codex', mark: 'Cx' },
  grok: { label: 'Grok', mark: 'Gr' },
  opencode: { label: 'OpenCode', mark: 'OC' },
  agy: { label: 'agy', mark: 'Ag' },
  qwen: { label: 'Qwen', mark: 'Qw' },
  mimo: { label: 'MiMo Code', mark: 'Mi' },
  cmd: { label: 'cmd', mark: 'Cc' },
};
const ICON = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M13 15h3.5"/></svg>',
};

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
  remove(key) { try { localStorage.removeItem(key); } catch (_) {} },
};

function readModes() {
  try {
    const parsed = JSON.parse(storage.get(MODE_KEY) || 'null');
    return parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.modes ? { ...parsed.modes } : {};
  } catch (_) {
    return {};
  }
}

let pin = storage.get(PIN_KEY) || '';
// 扫码进入：URL 带 ?k=PIN 自动登录，并立刻从地址栏抹掉明文 PIN。
const urlPin = new URLSearchParams(location.search).get('k');
if (urlPin) {
  pin = urlPin;
  storage.set(PIN_KEY, pin);
  try { history.replaceState(null, '', location.pathname); } catch (_) {}
}

const app = {
  view: 'login',
  projects: [],
  providers: [],
  liveRuns: new Map(),
  seenRuns: new Set(),
  helloSeq: 0,
  project: null,
  sessions: [],
  sessionsState: 'idle',
  sessionsError: '',
  terminals: [],
  terminalsState: 'idle',
  thread: null,
  modes: readModes(),
  chatConn: 'off',
  termConn: 'off',
};

// ===== 小工具 =====

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function providerInfo(id) {
  return PROVIDERS[id] || { label: id || '助手', mark: String(id || '?').slice(0, 2) };
}

function toolClass(id) {
  return PROVIDERS[id] ? `p-${id}` : '';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(ms);
  const now = new Date();
  const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= dayStart) return `今天 ${hm}`;
  if (ms >= dayStart - 86_400_000) return `昨天 ${hm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function elapsed(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

// 手机页是局域网 HTTP（非安全上下文），crypto.randomUUID 不可用，getRandomValues 可用。
function newRunId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `chat-m${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function lastIndexWhere(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) if (predicate(list[index])) return index;
  return -1;
}

let toastTimer = null;
function toast(text, ms = 2800) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

// ===== 接口 =====

async function api(path, params = {}) {
  const query = new URLSearchParams({ token: pin, ...params });
  let response;
  try {
    response = await fetch(`${path}?${query}`, { cache: 'no-store' });
  } catch (_) {
    throw new Error('连不上电脑，请确认手机和电脑在同一网络');
  }
  if (response.status === 401) {
    const error = new Error('PIN 错误或已失效');
    error.auth = true;
    throw error;
  }
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body;
}

async function loadBootstrap() {
  const data = await api('/api/chat/bootstrap');
  app.projects = Array.isArray(data?.projects) ? data.projects : [];
  app.providers = Array.isArray(data?.providers) ? data.providers : [];
  if (app.project) app.project = app.projects.find(project => project.id === app.project.id) || app.project;
}

// ===== 对话通道 =====

let ws = null;
let wsWanted = false;
let wsTimer = null;
let wsBackoff = 1000;
let pingTimer = null;

function connectChat() {
  wsWanted = true;
  clearTimeout(wsTimer);
  if (ws && ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/chat/ws?token=${encodeURIComponent(pin)}`);
  ws = socket;
  setConn('chat', 'connecting');
  socket.onopen = () => {
    if (ws !== socket) return;
    wsBackoff = 1000;
    setConn('chat', 'on');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sendFrame({ t: 'ping' }), 25_000);
    renderComposer();
  };
  socket.onmessage = event => {
    if (ws !== socket) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch (_) { return; }
    onFrame(frame);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    clearInterval(pingTimer);
    setConn('chat', 'off');
    renderComposer();
    if (wsWanted) scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(wsTimer);
  wsTimer = setTimeout(reconnect, wsBackoff);
  wsBackoff = Math.min(wsBackoff * 2, 10_000);
}

// WS 握手失败拿不到状态码，先用一次普通请求确认 PIN 还有效：失效就回登录页，
// 不拿旧 PIN 反复撞门（电脑端会按失败次数锁定）。
async function reconnect() {
  if (!wsWanted || (ws && ws.readyState <= 1)) return;
  setConn('chat', 'connecting');
  try {
    await loadBootstrap();
    connectChat();
    renderCurrent();
  } catch (error) {
    if (error.auth) logout('PIN 已失效：电脑上可能停止过手机远程，请重新扫码');
    else {
      setConn('chat', 'off');
      scheduleReconnect();
    }
  }
}

function sendFrame(frame) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

function stale(frame) {
  return Number(frame.seq) > 0 && Number(frame.seq) <= app.helloSeq;
}

function onFrame(frame) {
  switch (frame?.t) {
    case 'hello': onHello(frame); break;
    case 'run':
      if (stale(frame) || !frame.run?.runId) return;
      app.liveRuns.set(frame.run.runId, { ...frame.run });
      rememberRun(frame.run.runId);
      attachLiveRun(app.liveRuns.get(frame.run.runId));
      renderLists();
      break;
    case 'ev':
      if (stale(frame)) return;
      onEvent(frame);
      break;
    case 'reject': onReject(frame); break;
    default: break;
  }
}

function rememberRun(runId) {
  app.seenRuns.add(runId);
  if (app.seenRuns.size > 64) app.seenRuns.delete(app.seenRuns.values().next().value);
}

function onHello(frame) {
  app.helloSeq = Number(frame.seq) || 0;
  const runs = Array.isArray(frame.runs) ? frame.runs : [];
  app.liveRuns = new Map(runs.map(run => [run.runId, { ...run }]));
  runs.forEach(run => rememberRun(run.runId));
  const thread = app.thread;
  if (thread && ACTIVE.has(thread.state.status) && thread.state.runId) {
    const snapshot = app.liveRuns.get(thread.state.runId);
    if (snapshot) {
      thread.state = withSnapshot(thread.state, snapshot);
    } else if (app.seenRuns.has(thread.state.runId)) {
      // 断线期间这一轮已经结束：结果以磁盘历史为准，重新读一遍。
      thread.state = settleLocally(thread.state);
      if (threadSessionId(thread)) void loadTranscript(thread);
    }
  } else if (thread) {
    runs.forEach(run => attachLiveRun(app.liveRuns.get(run.runId)));
  }
  renderLists();
  scheduleThreadRender();
}

function settleLocally(state) {
  const messages = state.messages.map(message => (message.pending ? { ...message, pending: false } : message));
  return { ...state, messages, status: 'completed', approval: null };
}

function onEvent(frame) {
  const run = app.liveRuns.get(frame.runId);
  rememberRun(frame.runId);
  if (TERMINAL_EVENTS.has(frame.kind)) app.liveRuns.delete(frame.runId);
  else if (run && frame.kind === 'thread' && frame.data?.threadId) run.threadId = frame.data.threadId;
  else if (run && frame.kind === 'turn') run.status = 'running';

  const thread = app.thread;
  if (thread && thread.state.runId === frame.runId) {
    const before = thread.state;
    thread.state = applyConversationChatEvent(before, {
      runId: frame.runId,
      providerId: frame.providerId,
      kind: frame.kind,
      data: frame.data,
    });
    if (thread.state !== before) scheduleThreadRender();
    if (ACTIVE.has(before.status) && !ACTIVE.has(thread.state.status)) onThreadSettled(thread);
  }
  if (TERMINAL_EVENTS.has(frame.kind) || frame.kind === 'thread') {
    renderLists();
    if (app.view === 'sessions' && run && app.project?.id === run.projectId) void loadSessions({ quiet: true });
  }
}

function onReject(frame) {
  const thread = app.thread;
  const message = String(frame.message || '电脑端没有接受这次请求');
  if (thread && frame.runId && thread.state.runId === frame.runId && ACTIVE.has(thread.state.status)) {
    thread.state = applyConversationChatEvent(thread.state, {
      runId: frame.runId,
      providerId: thread.state.runProviderId || thread.providerId,
      kind: 'error',
      data: { message },
    });
    onThreadSettled(thread);
    scheduleThreadRender();
    return;
  }
  toast(message);
}

// ===== 视图与导航 =====

const VIEWS = ['login', 'projects', 'sessions', 'thread', 'terminals', 'terminal'];
const DRILL = new Set(['sessions', 'thread', 'terminal']);
const TABBED = new Set(['projects', 'sessions', 'terminals']);

function show(view) {
  const leaving = app.view;
  if (leaving === 'terminal' && view !== 'terminal') terminalPanel.close();
  if (leaving === 'thread' && view !== 'thread') leaveThread();
  app.view = view;
  VIEWS.forEach(name => $(`${name}View`).classList.toggle('active', name === view));
  $('backBtn').hidden = !DRILL.has(view);
  const tabs = $('tabs');
  tabs.hidden = !TABBED.has(view);
  $('app').classList.toggle('has-tabs', !tabs.hidden);
  const tab = view === 'terminals' || view === 'terminal' ? 'terminal' : 'chat';
  tabs.querySelectorAll('.tab').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  renderConn();
  renderCurrent();
}

function navigate(view) {
  try { history.pushState({ view }, ''); } catch (_) {}
  show(view);
}

function goBack() {
  if (app.view === 'thread') return show('sessions');
  if (app.view === 'sessions') return show('projects');
  if (app.view === 'terminal') return show('terminals');
  return undefined;
}

window.addEventListener('popstate', () => {
  if (DRILL.has(app.view)) goBack();
});

$('backBtn').addEventListener('click', () => {
  if (history.state?.view === app.view) history.back();
  else goBack();
});

$('barAction').addEventListener('click', () => {
  if (app.view === 'projects') void refreshProjects();
  else if (app.view === 'sessions') void loadSessions();
  else if (app.view === 'terminals') void loadTerminals();
  else if (app.view === 'thread' && app.thread && !ACTIVE.has(app.thread.state.status) && threadSessionId(app.thread)) {
    void loadTranscript(app.thread);
  }
});

$('tabs').addEventListener('click', event => {
  const tab = event.target.closest('.tab')?.dataset.tab;
  if (!tab) return;
  const target = tab === 'terminal' ? 'terminals' : 'projects';
  if (app.view === target) return;
  try { history.replaceState({ view: target }, ''); } catch (_) {}
  show(target);
  if (target === 'terminals') void loadTerminals();
});

function setConn(channel, state) {
  if (channel === 'chat') app.chatConn = state;
  else app.termConn = state;
  renderConn();
}

function renderConn() {
  const conn = $('conn');
  conn.hidden = app.view === 'login';
  const state = app.view === 'terminal' ? app.termConn : app.chatConn;
  conn.dataset.state = state;
  $('connText').textContent = state === 'on' ? '已连接' : state === 'connecting' ? '连接中' : '未连接';
}

function setBar(title, sub = '', { action = false } = {}) {
  $('barTitle').textContent = title;
  const subNode = $('barSub');
  if (typeof sub === 'string') subNode.textContent = sub;
  else subNode.replaceChildren(...sub);
  $('barAction').hidden = !action;
}

function renderCurrent() {
  switch (app.view) {
    case 'login': setBar('Roster'); break;
    case 'projects': renderProjects(); break;
    case 'sessions': renderSessions(); break;
    case 'thread': renderThread({ follow: true }); break;
    case 'terminals': renderTerminals(); break;
    case 'terminal': break;
    default: break;
  }
}

function renderLists() {
  if (app.view === 'projects') renderProjects();
  else if (app.view === 'sessions') renderSessions();
  else if (app.view === 'thread') renderComposer();
}

// ===== 登录 =====

async function login() {
  const value = $('pinInput').value.trim();
  if (!/^\d{4,12}$/.test(value)) {
    $('loginErr').textContent = '请输入电脑上显示的 6 位 PIN';
    return;
  }
  pin = value;
  $('pinBtn').disabled = true;
  $('loginErr').textContent = '';
  try {
    await loadBootstrap();
    enterApp();
  } catch (error) {
    $('loginErr').textContent = error.auth ? 'PIN 不对，或电脑上已经停止了手机远程' : error.message;
  } finally {
    $('pinBtn').disabled = false;
  }
}

function enterApp() {
  storage.set(PIN_KEY, pin);
  connectChat();
  try { history.replaceState({ view: 'projects' }, ''); } catch (_) {}
  show('projects');
}

function logout(message = '') {
  wsWanted = false;
  clearTimeout(wsTimer);
  clearInterval(pingTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  terminalPanel.close();
  storage.remove(PIN_KEY);
  pin = '';
  app.thread = null;
  $('pinInput').value = '';
  $('loginErr').textContent = message;
  show('login');
}

$('pinBtn').addEventListener('click', login);
if (shell) {
  $('switchHostBtn').hidden = false;
  $('switchHostBtn').addEventListener('click', () => shell.openConnect());
}
$('pinInput').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });

// ===== 项目 =====

async function refreshProjects() {
  try {
    await loadBootstrap();
    renderProjects();
  } catch (error) {
    if (error.auth) logout('PIN 已失效，请在电脑上重新打开「手机远程」');
    else toast(error.message);
  }
}

function liveRunForProject(projectId) {
  for (const run of app.liveRuns.values()) if (run.projectId === projectId) return run;
  return null;
}

function renderProjects() {
  setBar('项目', app.projects.length ? `${app.projects.length} 个项目` : '', { action: true });
  const body = $('projectsBody');
  const parts = [];
  if (!app.providers.length) {
    parts.push('<p class="notice warn">电脑上没有检测到可用的助手（Claude、Codex 等），只能查看历史对话和终端。</p>');
  }
  const live = [...app.liveRuns.values()].filter(run => app.projects.some(project => project.id === run.projectId));
  if (live.length) {
    parts.push('<div class="section-title">正在进行</div>');
    live.forEach(run => {
      const project = app.projects.find(item => item.id === run.projectId);
      parts.push(`<button class="live-banner" type="button" data-live-run="${esc(run.runId)}">
        <span class="spinner" aria-hidden="true"></span>
        <span class="live-text"><strong>${esc(project?.name || '项目')} · ${esc(providerInfo(run.providerId).label)}</strong><span class="live-sub">${esc(run.prompt)}</span></span>
        ${ICON.chev}</button>`);
    });
  }
  if (!app.projects.length) {
    parts.push(`<div class="empty">${ICON.folder}电脑上还没有项目。<br/>先在电脑上的 Roster 里添加一个项目。</div>`);
  } else {
    const groups = new Map();
    app.projects.forEach(project => {
      const name = String(project.group || '').trim() || '未分组';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(project);
    });
    const names = [...groups.keys()].sort((a, b) => (a === '未分组') - (b === '未分组') || a.localeCompare(b, 'zh-CN'));
    names.forEach(name => {
      parts.push(`<div class="section-title">${esc(name)}</div><div class="group">`);
      groups.get(name).forEach(project => {
        const run = liveRunForProject(project.id);
        const badge = run ? `<span class="chip live"><i></i>${esc(providerInfo(run.providerId).label)} 处理中</span>` : '';
        parts.push(`<button class="row" type="button" data-project="${esc(project.id)}">
          <span class="project-icon">${ICON.folder}</span>
          <span class="row-main"><span class="row-title"><span class="name">${esc(project.name)}</span></span></span>
          ${badge}${ICON.chev}</button>`);
      });
      parts.push('</div>');
    });
  }
  if (shell) parts.push('<button class="link-btn" type="button" data-action="switch-host">切换到另一台电脑</button>');
  body.innerHTML = parts.join('');
}

$('projectsBody').addEventListener('click', event => {
  if (event.target.closest('[data-action="switch-host"]')) {
    shell?.openConnect();
    return;
  }
  const liveButton = event.target.closest('[data-live-run]');
  if (liveButton) {
    const run = app.liveRuns.get(liveButton.dataset.liveRun);
    if (run) openLiveRun(run);
    return;
  }
  const row = event.target.closest('[data-project]');
  if (!row) return;
  const project = app.projects.find(item => item.id === row.dataset.project);
  if (project) openProject(project);
});

function openProject(project) {
  if (app.project?.id !== project.id) {
    app.sessions = [];
    app.sessionsState = 'idle';
  }
  app.project = project;
  navigate('sessions');
  void loadSessions();
}

// ===== 会话列表 =====

let sessionsRevision = 0;
async function loadSessions({ quiet = false } = {}) {
  const project = app.project;
  if (!project) return;
  const revision = ++sessionsRevision;
  if (!quiet) {
    app.sessionsState = 'loading';
    renderSessions();
  }
  try {
    const data = await api('/api/chat/history', { project: project.id });
    if (revision !== sessionsRevision || app.project?.id !== project.id) return;
    app.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    app.sessionsState = 'ready';
  } catch (error) {
    if (revision !== sessionsRevision) return;
    if (error.auth) return logout('PIN 已失效，请在电脑上重新打开「手机远程」');
    app.sessionsState = 'error';
    app.sessionsError = error.message;
  }
  if (app.view === 'sessions') renderSessions();
}

function budgetChip(session) {
  if (session.band === 'over') {
    return session.blocks
      ? '<span class="chip danger" title="已超出上下文窗口，续接会失败">超窗</span>'
      : '<span class="chip warn" title="已超出登记窗口（估算），CLI 会自行压缩">较大</span>';
  }
  if (session.band === 'long') return '<span class="chip warn" title="已用掉窗口的六成以上（估算）">较长</span>';
  return '';
}

function renderSessions() {
  const project = app.project;
  if (!project) return;
  setBar(project.name, String(project.group || '').trim() || '项目', { action: true });
  const parts = [];
  const run = liveRunForProject(project.id);
  if (run) {
    parts.push(`<button class="live-banner" type="button" data-live-run="${esc(run.runId)}">
      <span class="spinner" aria-hidden="true"></span>
      <span class="live-text"><strong>${esc(providerInfo(run.providerId).label)} 正在处理</strong><span class="live-sub">${esc(run.prompt)}</span></span>
      ${ICON.chev}</button>`);
  }
  parts.push(`<button class="btn-primary" type="button" id="newChatBtn" style="margin-top:0"${app.providers.length ? '' : ' disabled'}>${ICON.plus}新对话</button>`);
  parts.push('<div class="section-title">最近对话</div>');
  if (app.sessionsState === 'loading' && !app.sessions.length) {
    parts.push('<div class="empty"><span class="spinner" style="margin:0 auto 10px;display:block"></span>正在读取历史对话…</div>');
  } else if (app.sessionsState === 'error') {
    parts.push(`<p class="notice danger">${esc(app.sessionsError)}</p>`);
  } else if (!app.sessions.length) {
    parts.push(`<div class="empty">${ICON.chat}这个项目还没有对话记录。</div>`);
  } else {
    parts.push('<div class="group">');
    app.sessions.forEach((session, index) => {
      const info = providerInfo(session.tool);
      parts.push(`<button class="row" type="button" data-session="${index}">
        <span class="tool-mark tool ${toolClass(session.tool)}">${esc(info.mark)}</span>
        <span class="row-main">
          <span class="row-title"><span class="name">${esc(session.title || '未命名会话')}</span></span>
          <span class="row-sub">${esc(session.label || info.label)} · ${esc(relTime(session.atMs))}${session.preview ? ` · ${esc(session.preview)}` : ''}</span>
        </span>
        ${budgetChip(session)}</button>`);
    });
    parts.push('</div>');
    parts.push('<p class="muted-note">列表合并了这个项目在各家助手里的对话，最多显示最近 80 条。</p>');
  }
  $('sessionsBody').innerHTML = parts.join('');
}

$('sessionsBody').addEventListener('click', event => {
  const liveButton = event.target.closest('[data-live-run]');
  if (liveButton) {
    const run = app.liveRuns.get(liveButton.dataset.liveRun);
    if (run) openLiveRun(run);
    return;
  }
  if (event.target.closest('#newChatBtn')) {
    openProviderSheet();
    return;
  }
  const row = event.target.closest('[data-session]');
  if (!row) return;
  const session = app.sessions[Number(row.dataset.session)];
  if (session) openSession(session);
});

// ===== 对话 =====

function newThread({ projectId, providerId, title, session = null }) {
  return {
    projectId,
    providerId,
    title,
    session,
    state: createConversationState({ projectId, providerId }),
    loading: false,
    error: '',
    truncated: false,
    blocked: Boolean(session?.blocks),
    boundRunId: '',
    startedAt: new Map(),
    ackTimers: new Map(),
    // 每一轮的结局（失败原因 / 已停止）留在那一轮的回复里，下一轮开始后也看得到。
    outcomes: new Map(),
    nodes: new Map(),
  };
}

function threadSessionId(thread) {
  return thread.state.threadId || thread.session?.id || '';
}

function openSession(session) {
  const thread = newThread({
    projectId: app.project.id,
    providerId: session.tool,
    title: session.title || '未命名会话',
    session,
  });
  app.thread = thread;
  navigate('thread');
  void loadTranscript(thread);
}

function openNewChat(providerId) {
  app.thread = newThread({ projectId: app.project.id, providerId, title: '新对话' });
  navigate('thread');
  setTimeout(() => $('composer').focus(), 60);
}

function openLiveRun(run) {
  const project = app.projects.find(item => item.id === run.projectId);
  if (!project) return;
  if (app.view !== 'sessions' || app.project?.id !== project.id) openProject(project);
  if (run.threadId) {
    openSession({ id: run.threadId, tool: run.providerId, title: run.prompt.slice(0, 40) || '进行中的对话' });
    return;
  }
  const thread = newThread({ projectId: run.projectId, providerId: run.providerId, title: '进行中的对话' });
  thread.boundRunId = run.runId;
  app.thread = thread;
  navigate('thread');
  attachLiveRun(run);
}

function transcriptText(message) {
  const images = Number(message.images) || 0;
  const note = images ? `［${images} 张图片，请在电脑上查看］` : '';
  if (!message.text) return note;
  return note ? `${message.text}\n\n${note}` : message.text;
}

async function loadTranscript(thread) {
  const sessionId = threadSessionId(thread);
  if (!sessionId) return;
  thread.loading = true;
  thread.error = '';
  renderThread();
  try {
    const data = await api('/api/chat/transcript', { project: thread.projectId, tool: thread.providerId, id: sessionId });
    if (app.thread !== thread || ACTIVE.has(thread.state.status)) return;
    thread.state = loadConversationTranscript({
      projectId: thread.projectId,
      providerId: thread.providerId,
      sourceTool: thread.providerId,
      threadId: sessionId,
      messages: (Array.isArray(data?.messages) ? data.messages : [])
        .map(message => ({ role: message.role, text: transcriptText(message) })),
    });
    thread.truncated = Boolean(data?.truncated);
    if (data?.title && thread.title === '新对话') thread.title = data.title;
  } catch (error) {
    if (app.thread !== thread) return;
    if (error.auth) return logout('PIN 已失效，请在电脑上重新打开「手机远程」');
    thread.error = `读取对话失败：${error.message}`;
  } finally {
    if (app.thread === thread) {
      thread.loading = false;
      app.liveRuns.forEach(run => attachLiveRun(run));
      renderThread({ follow: true });
    }
  }
}

function runMatchesThread(run, thread) {
  if (!run || !thread || run.projectId !== thread.projectId) return false;
  if (thread.state.runId === run.runId || thread.boundRunId === run.runId) return true;
  if (run.providerId !== thread.providerId) return false;
  const sessionId = threadSessionId(thread);
  return Boolean(sessionId && run.threadId === sessionId);
}

function snapshotEvent(run, kind, data) {
  return { runId: run.runId, providerId: run.providerId, kind, data };
}

/** 用电脑端快照补齐这一轮已经输出的内容（中途连上或断线重连时）。 */
function withSnapshot(state, run) {
  let next = state;
  if (run.threadId && !next.threadId) next = applyConversationChatEvent(next, snapshotEvent(run, 'thread', { threadId: run.threadId }));
  if (run.status === 'running') next = applyConversationChatEvent(next, snapshotEvent(run, 'turn', {}));
  const messages = [...next.messages];
  const index = lastIndexWhere(messages, message => message.role === 'assistant');
  if (index >= 0) {
    const tail = run.textTruncated ? '\n\n…（回复太长，完整内容稍后在历史对话里查看）' : '';
    messages[index] = { ...messages[index], text: `${run.text || ''}${tail}`, pending: true };
  }
  next = { ...next, messages, notice: run.notice || '' };
  if (run.approval) next = applyConversationChatEvent(next, snapshotEvent(run, 'approval', run.approval));
  return next;
}

/** 电脑端（或另一台手机）发起、正好属于当前这条对话的一轮：接上它的事件流。 */
function attachLiveRun(run) {
  const thread = app.thread;
  if (!thread || thread.loading || !runMatchesThread(run, thread)) return;
  if (thread.state.runId === run.runId) {
    if (ACTIVE.has(thread.state.status)) thread.state = withSnapshot(thread.state, run);
    scheduleThreadRender();
    return;
  }
  if (ACTIVE.has(thread.state.status)) return;
  let base = thread.state;
  // CLI 边跑边写历史：磁盘转录里可能已经有这一轮的提问，去掉免得显示两遍。
  const prompt = String(run.prompt || '').trim();
  const index = lastIndexWhere(base.messages, message => message.role === 'user' && message.text.trim() === prompt);
  if (prompt && index >= 0 && index >= base.messages.length - 8) base = { ...base, messages: base.messages.slice(0, index) };
  const next = startConversationTurn(base, {
    runId: run.runId,
    projectId: run.projectId,
    providerId: run.providerId,
    prompt: prompt || '（在电脑上发起）',
  });
  if (next === base) return;
  thread.state = withSnapshot(next, run);
  thread.boundRunId = run.runId;
  thread.startedAt.set(run.runId, Number(run.startedAtMs) || Date.now());
  scheduleThreadRender({ follow: true });
}

function onThreadSettled(thread) {
  thread.ackTimers.forEach(timer => clearTimeout(timer));
  thread.ackTimers.clear();
  const { runId, status, error } = thread.state;
  if (runId && (status === 'failed' || status === 'cancelled')) thread.outcomes.set(runId, { status, error });
  if (thread.state.threadId && !thread.session) {
    thread.session = { id: thread.state.threadId, tool: thread.providerId, title: thread.title };
  }
  if (thread.title === '新对话' || thread.title === '进行中的对话') {
    const firstUser = thread.state.messages.find(message => message.role === 'user');
    if (firstUser?.text) thread.title = firstUser.text.replace(/\s+/g, ' ').slice(0, 40);
  }
  if (thread.state.status === 'completed' && document.hidden) {
    try { navigator.vibrate?.(40); } catch (_) {}
  }
  if (app.project?.id === thread.projectId) void loadSessions({ quiet: true });
}

function leaveThread() {
  const thread = app.thread;
  if (!thread) return;
  thread.ackTimers.forEach(timer => clearTimeout(timer));
  thread.ackTimers.clear();
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  app.thread = null;
}

// ----- 渲染 -----

function renderMarkdown(target, text) {
  if (!window.marked || !window.DOMPurify) {
    target.textContent = text;
    return;
  }
  const fragment = window.DOMPurify.sanitize(window.marked.parse(String(text), { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'picture'],
    FORBID_ATTR: ['style', 'id', 'name', 'srcset'],
    RETURN_DOM_FRAGMENT: true,
  });
  // 图片与本机文件链接在手机上打不开，也不该让手机去请求：换成文字占位。
  fragment.querySelectorAll('img').forEach(image => {
    const span = document.createElement('span');
    span.className = 'media-placeholder';
    span.textContent = `［图片${image.getAttribute('alt') ? `：${image.getAttribute('alt')}` : ''}］`;
    image.replaceWith(span);
  });
  fragment.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('target', '_blank');
    } else {
      const span = document.createElement('span');
      span.textContent = link.textContent;
      link.replaceWith(span);
    }
  });
  target.replaceChildren(fragment);
}

function messageNode(message) {
  const node = document.createElement('div');
  if (message.role === 'user') {
    node.className = 'msg user';
    node.innerHTML = '<div class="bubble"></div>';
  } else {
    const tool = message.tool || app.thread?.providerId || '';
    node.className = `msg assistant ${toolClass(tool)}`;
    node.innerHTML = `<div class="msg-head"><i class="dot"></i><span>${esc(providerInfo(tool).label)}</span></div><div class="md"></div>`;
  }
  return node;
}

function outcomeNote(outcome) {
  const note = document.createElement('p');
  note.className = `turn-note ${outcome.status === 'failed' ? 'danger' : ''}`;
  note.textContent = outcome.status === 'failed'
    ? `没有完成：${outcome.error || '这一轮没有正常结束'}`
    : '已停止这次处理';
  return note;
}

function fillMessage(node, message, thread) {
  if (message.role === 'user') {
    node.querySelector('.bubble').textContent = message.text;
    return;
  }
  const target = node.querySelector('.md');
  if (!message.text && message.pending) {
    target.innerHTML = '<span class="typing" aria-label="正在回复"><i></i><i></i><i></i></span>';
    return;
  }
  const outcome = message.pending ? null : thread?.outcomes.get(String(message.id).replace(/-assistant$/, ''));
  if (message.text) renderMarkdown(target, message.text);
  else if (outcome) target.replaceChildren();
  else target.textContent = '（没有文字回复）';
  if (outcome) target.appendChild(outcomeNote(outcome));
}

function noticeHtml(thread) {
  const notes = [];
  if (thread.loading) notes.push(['', '正在读取对话…']);
  if (thread.error) notes.push(['danger', thread.error]);
  if (thread.truncated) notes.push(['', '这条对话很长，手机上只显示最近一段。']);
  if (thread.blocked) {
    notes.push(['warn', '这条会话已经超出上下文窗口，续接只会报错。请在电脑上打开它，改用新会话继续；这里仍可阅读。']);
  }
  if (!thread.state.messages.length && !thread.loading && !thread.error) {
    const label = providerInfo(thread.providerId).label;
    notes.push(['', `新对话 · ${label}。消息会交给电脑上的 ${label}，在「${app.project?.name || '项目'}」目录里按下方的权限档位执行。`]);
  }
  return notes.map(([cls, text]) => `<p class="notice ${cls}">${esc(text)}</p>`).join('');
}

function approvalNode(thread) {
  const approval = thread.state.approval;
  if (!approval) return null;
  const node = document.createElement('div');
  node.className = 'approval';
  node.innerHTML = `<strong>${approval.kind === 'fileChange' ? '助手请求修改文件' : '助手请求执行命令'}</strong>
    ${approval.reason ? `<p>${esc(approval.reason)}</p>` : ''}
    ${approval.command ? `<code>${esc(approval.command)}</code>` : ''}
    <small>请在电脑上批准或拒绝；手机端审批下一阶段加入。</small>`;
  return node;
}

let renderTimer = null;
let pendingFollow = false;
function scheduleThreadRender({ follow = false } = {}) {
  pendingFollow = pendingFollow || follow;
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const shouldFollow = pendingFollow;
    pendingFollow = false;
    renderThread({ follow: shouldFollow });
  }, 60);
}

function threadBarSub(thread) {
  const info = providerInfo(thread.providerId);
  const chip = document.createElement('span');
  chip.className = `chip tool ${toolClass(thread.providerId)}`;
  chip.textContent = info.label;
  const project = document.createElement('span');
  project.textContent = app.project?.name || '';
  return [chip, project];
}

function renderThread({ follow = false } = {}) {
  const thread = app.thread;
  if (!thread || app.view !== 'thread') return;
  setBar(thread.title || '对话', threadBarSub(thread), {
    action: Boolean(threadSessionId(thread)) && !ACTIVE.has(thread.state.status),
  });
  const scroller = $('threadScroll');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  const body = $('threadBody');
  if (!thread.noticeEl) thread.noticeEl = document.createElement('div');
  thread.noticeEl.innerHTML = noticeHtml(thread);
  const wanted = [thread.noticeEl];
  const live = new Set();
  thread.state.messages.forEach(message => {
    let entry = thread.nodes.get(message.id);
    if (!entry) {
      entry = { node: messageNode(message), text: null, pending: null };
      thread.nodes.set(message.id, entry);
    }
    if (entry.text !== message.text || entry.pending !== message.pending) {
      fillMessage(entry.node, message, thread);
      entry.text = message.text;
      entry.pending = message.pending;
    }
    live.add(message.id);
    wanted.push(entry.node);
  });
  thread.nodes.forEach((_, id) => { if (!live.has(id)) thread.nodes.delete(id); });
  const approval = approvalNode(thread);
  if (approval) wanted.push(approval);
  let cursor = body.firstChild;
  wanted.forEach(node => {
    if (node === cursor) cursor = cursor.nextSibling;
    else body.insertBefore(node, cursor);
  });
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  if (follow || nearBottom) scroller.scrollTop = scroller.scrollHeight;
  renderComposer();
}

// ----- 输入区 -----

let elapsedTimer = null;

function modesFor(providerId) {
  return app.providers.find(provider => provider.id === providerId)?.modes || [];
}

function selectedMode(providerId) {
  const entries = modesFor(providerId);
  return entries.find(entry => entry.id === app.modes[providerId]) || entries[0] || null;
}

function modeLevel(entry) {
  if (entry?.unsandboxed) return 'danger';
  return entry?.writes ? 'write' : 'read';
}

function providerAvailable(providerId) {
  return app.providers.some(provider => provider.id === providerId);
}

function composeBlocker(thread) {
  if (thread.loading) return '正在读取对话…';
  if (thread.blocked) return '这条会话超出上下文窗口，无法在手机上续接';
  if (!providerAvailable(thread.providerId)) return `电脑上的 ${providerInfo(thread.providerId).label} 当前不可用，只能阅读`;
  const other = liveRunForProject(thread.projectId);
  if (other && other.runId !== thread.state.runId) return '这个项目正在处理另一轮对话，等它结束再发';
  if (!ws || ws.readyState !== 1) return '正在连接电脑…';
  return '';
}

function statusLine(thread) {
  const state = thread.state;
  const spinner = '<span class="spinner" aria-hidden="true"></span>';
  if (state.status === 'starting') {
    const registered = app.seenRuns.has(state.runId);
    return { html: `${spinner}${registered ? '电脑已接收，正在启动助手…' : '正在发给电脑…'}`, cls: '' };
  }
  if (state.status === 'running') {
    const started = thread.startedAt.get(state.runId);
    const notice = state.notice ? ` · ${esc(state.notice)}` : '';
    return { html: `${spinner}处理中${started ? ` · ${elapsed(started)}` : ''}${notice}`, cls: '' };
  }
  if (state.status === 'stopping') return { html: `${spinner}正在停止…`, cls: '' };
  if (state.status === 'failed') return { html: esc(state.error || '这一轮没有正常结束'), cls: 'failed' };
  if (state.status === 'cancelled') return { html: '已停止这次处理', cls: '' };
  return { html: '', cls: '' };
}

function renderComposer() {
  const thread = app.thread;
  if (!thread || app.view !== 'thread') return;
  const running = ACTIVE.has(thread.state.status);
  const blocker = composeBlocker(thread);
  const composer = $('composer');
  composer.disabled = thread.blocked || thread.loading;
  const status = statusLine(thread);
  const line = $('threadStatus');
  line.className = `status-line ${status.cls}`;
  line.innerHTML = status.html;
  const button = $('sendBtn');
  if (running) {
    button.classList.add('stop');
    button.innerHTML = ICON.stop;
    button.setAttribute('aria-label', '停止');
    button.disabled = thread.state.status === 'stopping' || !ws || ws.readyState !== 1;
  } else {
    button.classList.remove('stop');
    button.innerHTML = ICON.send;
    button.setAttribute('aria-label', '发送');
    button.disabled = Boolean(blocker) || !composer.value.trim();
  }
  $('composeHint').textContent = running ? '' : blocker;
  const mode = selectedMode(thread.providerId);
  const chip = $('modeChip');
  chip.dataset.level = modeLevel(mode);
  chip.hidden = !mode;
  $('modeLabel').textContent = mode?.label || '';
  if (running && !elapsedTimer) {
    elapsedTimer = setInterval(() => {
      if (!app.thread || !ACTIVE.has(app.thread.state.status)) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
      renderComposer();
    }, 1000);
  }
}

function autosize() {
  const composer = $('composer');
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, window.innerHeight * 0.38)}px`;
}

function submit() {
  const thread = app.thread;
  if (!thread) return;
  if (ACTIVE.has(thread.state.status)) {
    stopRun(thread);
    return;
  }
  const composer = $('composer');
  const prompt = composer.value.trim();
  if (!prompt || composeBlocker(thread)) return;
  if (utf8Bytes(prompt) > PROMPT_MAX_BYTES) {
    toast('消息太长了，请控制在 64KB 以内');
    return;
  }
  const runId = newRunId();
  const context = conversationRunContext(thread.state);
  const mode = selectedMode(thread.providerId);
  const next = startConversationTurn(thread.state, {
    runId,
    projectId: thread.projectId,
    providerId: thread.providerId,
    prompt,
  });
  if (next === thread.state) return;
  const sent = sendFrame({
    t: 'send',
    runId,
    projectId: thread.projectId,
    providerId: thread.providerId,
    threadId: context.threadId,
    prompt,
    mode: mode?.id || '',
  });
  if (!sent) {
    toast('还没连上电脑，稍等自动重连');
    return;
  }
  thread.state = next;
  thread.boundRunId = runId;
  thread.startedAt.set(runId, Date.now());
  thread.ackTimers.set(runId, setTimeout(() => {
    thread.ackTimers.delete(runId);
    if (thread.state.runId !== runId || thread.state.status !== 'starting' || app.seenRuns.has(runId)) return;
    thread.state = applyConversationChatEvent(thread.state, {
      runId,
      providerId: thread.providerId,
      kind: 'error',
      data: { message: '电脑端没有响应：请确认电脑上的 Roster 还开着，且没有停止手机远程' },
    });
    scheduleThreadRender();
  }, ACK_TIMEOUT_MS));
  composer.value = '';
  autosize();
  renderThread({ follow: true });
}

function stopRun(thread) {
  const runId = thread.state.runId;
  if (!runId || !['starting', 'running'].includes(thread.state.status)) return;
  if (!sendFrame({ t: 'cancel', runId })) {
    toast('还没连上电脑，暂时无法停止');
    return;
  }
  thread.state = { ...thread.state, status: 'stopping' };
  renderComposer();
}

$('composer').addEventListener('input', () => {
  autosize();
  renderComposer();
});
$('composer').addEventListener('keydown', event => {
  // 手机上回车是换行；外接键盘可用 ⌘/Ctrl + 回车发送。
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
$('sendBtn').addEventListener('click', submit);
$('modeChip').addEventListener('click', openModeSheet);

// ===== 底部面板 =====

function closeSheet() {
  $('sheetMask').hidden = true;
  $('sheet').replaceChildren();
}

function openSheet({ title, description = '', options, onPick }) {
  const sheet = $('sheet');
  sheet.innerHTML = `<div class="sheet-grip"></div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}`;
  options.forEach(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `option ${option.level || ''}`;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(Boolean(option.checked)));
    button.innerHTML = `${option.lead || ''}<span style="flex:1;min-width:0"><strong>${esc(option.title)}</strong>${option.hint ? `<span class="hint">${esc(option.hint)}</span>` : ''}</span>${ICON.check}`;
    button.addEventListener('click', () => {
      closeSheet();
      onPick(option.value);
    });
    sheet.appendChild(button);
  });
  $('sheetMask').hidden = false;
}

$('sheetMask').addEventListener('click', event => {
  if (event.target === $('sheetMask')) closeSheet();
});

function openProviderSheet() {
  if (!app.project) return;
  openSheet({
    title: '用哪位助手开始？',
    description: '一条对话固定属于一位助手。消息会在电脑上的这个项目里执行。',
    options: app.providers.map(provider => ({
      value: provider.id,
      title: provider.label,
      hint: selectedMode(provider.id)?.label ? `权限：${selectedMode(provider.id).label}` : '',
      lead: `<span class="tool-mark tool ${toolClass(provider.id)}">${esc(providerInfo(provider.id).mark)}</span>`,
    })),
    onPick: openNewChat,
  });
}

function persistModes() {
  storage.set(MODE_KEY, JSON.stringify({ version: 1, modes: app.modes }));
}

function openModeSheet() {
  const thread = app.thread;
  if (!thread) return;
  const entries = modesFor(thread.providerId);
  if (!entries.length) return;
  const current = selectedMode(thread.providerId);
  const label = providerInfo(thread.providerId).label;
  openSheet({
    title: `${label} 的权限档位`,
    description: '只影响从手机发出的消息，电脑上的选择不变。第一档始终只读。',
    options: entries.map(entry => ({
      value: entry.id,
      title: entry.label,
      hint: entry.unsandboxed ? `${entry.hint}（不开沙箱）` : entry.hint,
      level: modeLevel(entry) === 'read' ? '' : modeLevel(entry),
      checked: entry.id === current?.id,
    })),
    onPick: id => {
      const entry = entries.find(item => item.id === id);
      if (!entry) return;
      const apply = () => {
        app.modes[thread.providerId] = entry.id;
        persistModes();
        renderComposer();
      };
      if (!entry.unsandboxed) {
        apply();
        return;
      }
      openSheet({
        title: `确认使用「${entry.label}」？`,
        description: `这一档不开沙箱：${label} 可以读写项目以外的文件、也能联网。只在你确定需要时选择。`,
        options: [
          { value: 'yes', title: `使用「${entry.label}」`, level: 'danger' },
          { value: 'no', title: '取消，保持原档位' },
        ],
        onPick: answer => { if (answer === 'yes') apply(); },
      });
    },
  });
}

// ===== 终端 =====

const terminalPanel = createTerminalPanel({
  getPin: () => pin,
  setConn: state => setConn('terminal', state),
  onAuthError: () => logout('PIN 已失效，请在电脑上重新打开「手机远程」'),
});

async function loadTerminals() {
  app.terminalsState = 'loading';
  renderTerminals();
  try {
    app.terminals = await terminalPanel.list();
    app.terminalsState = 'ready';
  } catch (error) {
    app.terminalsState = 'error';
    app.terminalsError = error.message;
  }
  if (app.view === 'terminals') renderTerminals();
}

function renderTerminals() {
  setBar('终端', '镜像电脑上已打开的终端', { action: true });
  const parts = [];
  if (app.terminalsState === 'loading' && !app.terminals.length) {
    parts.push('<div class="empty"><span class="spinner" style="margin:0 auto 10px;display:block"></span>正在读取终端…</div>');
  } else if (app.terminalsState === 'error') {
    parts.push(`<p class="notice danger">${esc(app.terminalsError)}</p>`);
  } else if (!app.terminals.length) {
    parts.push(`<div class="empty">${ICON.terminal}电脑上还没有打开的终端。<br/>在电脑的开发模式里打开一个终端或 CLI 会话。</div>`);
  } else {
    parts.push('<div class="group">');
    app.terminals.forEach((session, index) => {
      const tool = String(session.tool || '').toLowerCase();
      parts.push(`<button class="row" type="button" data-terminal="${index}">
        <span class="tool-mark tool ${toolClass(tool)}">${esc(PROVIDERS[tool]?.mark || '>_')}</span>
        <span class="row-main"><span class="row-title"><span class="name">${esc(session.name || session.id)}</span></span>
        <span class="row-sub">${esc(PROVIDERS[tool]?.label || tool || '终端会话')}</span></span>
        ${ICON.chev}</button>`);
    });
    parts.push('</div>');
    parts.push('<p class="muted-note">终端尺寸由电脑决定，手机按列宽缩放显示；在这里输入会直接写进电脑上的终端。</p>');
  }
  $('terminalsBody').innerHTML = parts.join('');
}

$('terminalsBody').addEventListener('click', event => {
  const row = event.target.closest('[data-terminal]');
  if (!row) return;
  const session = app.terminals[Number(row.dataset.terminal)];
  if (!session) return;
  navigate('terminal');
  setBar(session.name || session.id, PROVIDERS[String(session.tool || '').toLowerCase()]?.label || '终端');
  terminalPanel.open(session.id).catch(error => toast(error.message));
});

// ===== 键盘与可见性 =====

// iOS 弹出键盘时只缩小 visual viewport：跟着它调整应用高度，输入框才不会被键盘盖住。
if (window.visualViewport) {
  const root = $('app');
  const viewport = window.visualViewport;
  const fit = () => {
    root.style.bottom = 'auto';
    root.style.height = `${viewport.height}px`;
    root.style.transform = `translateY(${viewport.offsetTop}px)`;
  };
  viewport.addEventListener('resize', fit);
  viewport.addEventListener('scroll', fit);
  fit();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !wsWanted) return;
  if (!ws || ws.readyState > 1) {
    clearTimeout(wsTimer);
    wsBackoff = 1000;
    void reconnect();
  }
});

// ===== 启动 =====

async function boot() {
  if (!pin) {
    show('login');
    return;
  }
  $('pinInput').value = pin;
  try {
    await loadBootstrap();
    enterApp();
  } catch (error) {
    show('login');
    $('loginErr').textContent = error.auth ? 'PIN 已失效，请重新扫码或输入新 PIN' : error.message;
    if (error.auth) {
      storage.remove(PIN_KEY);
      $('pinInput').value = '';
    }
  }
}

void boot();
