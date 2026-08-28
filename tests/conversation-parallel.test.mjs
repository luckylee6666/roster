import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changedFileLabel,
  conversationMarkdown,
  conversationSearchHits,
  inspectConversationMention,
  conversationHistoryTools,
  shouldCollapseMessage,
  conversationStarters,
  diffProjectChanges,
  installConversationMode,
  MAX_PARALLEL_CONVERSATION_RUNS,
  normalizeProjectChanges,
} from '../src/conversation-mode.js';

globalThis.window = globalThis.window || {};
globalThis.requestAnimationFrame = fn => { fn(); return 0; };

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.classNames = new Set();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.options = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    const self = this;
    this.classList = {
      add: (...names) => names.forEach(name => self.classNames.add(name)),
      remove: (...names) => names.forEach(name => self.classNames.delete(name)),
      contains: name => self.classNames.has(name),
      toggle(name, force) {
        const on = force === undefined ? !self.classNames.has(name) : Boolean(force);
        if (on) self.classNames.add(name);
        else self.classNames.delete(name);
        return on;
      },
    };
  }
  get className() { return [...this.classNames].join(' '); }
  set className(value) { this.classNames = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(node) {
    node.parentElement?.removeChild(node);
    this.childNodes.push(node);
    node.parentElement = this;
    if (this.tagName === 'SELECT') this.options = [...this.childNodes];
    return node;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  insertBefore(node, reference) {
    node.parentElement?.removeChild(node);
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    node.parentElement = this;
    if (this.tagName === 'SELECT') this.options = [...this.childNodes];
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentElement = null;
    if (this.tagName === 'SELECT') this.options = [...this.childNodes];
    return node;
  }
  replaceChildren(...nodes) {
    this.childNodes.forEach(node => { node.parentElement = null; });
    this.childNodes = [];
    this.options = [];
    nodes.forEach(node => this.appendChild(node));
  }
  set innerHTML(html) {
    // 极简解析：只认 <pre>…</pre>，够用来验证代码块复制按钮的接线
    this.replaceChildren();
    const text = String(html);
    const pattern = /<pre>([\s\S]*?)<\/pre>/g;
    let last = 0;
    let match = pattern.exec(text);
    while (match) {
      const before = text.slice(last, match.index).trim();
      if (before) {
        const paragraph = new FakeEl('p');
        paragraph.textContent = before;
        this.appendChild(paragraph);
      }
      const pre = new FakeEl('pre');
      pre.textContent = match[1];
      this.appendChild(pre);
      last = pattern.lastIndex;
      match = pattern.exec(text);
    }
    const tail = text.slice(last).trim();
    if (tail) {
      const paragraph = new FakeEl('p');
      paragraph.textContent = tail;
      this.appendChild(paragraph);
    }
  }
  get innerHTML() { return ''; }
  replaceWith(node) {
    const parent = this.parentElement;
    if (!parent) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  querySelector() { return null; }
  querySelectorAll(selector) {
    if (selector !== 'pre') return [];
    const found = [];
    const walk = node => node.childNodes.forEach(child => {
      if (child.tagName === 'PRE') found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }
  focus() {}
  closest() { return null; }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some(child => child.contains?.(node));
  }
}

const IDS = [
  'conversation-project-list',
  'conversation-history-list',
  'conversation-history-state',
  'conversation-empty',
  'conversation-starter-list',
  'conversation-new-chat',
  'conversation-project-name',
  'conversation-project-path',
  'conversation-assistant-badge',
  'conversation-assistant-name',
  'conversation-status',
  'conversation-messages',
  'conversation-empty',
  'conversation-starter-list',
  'conversation-composer',
  'conversation-attachments',
  'conversation-tuning-toggle',
  'conversation-tuning-summary',
  'conversation-tuning-panel',
  'conversation-handoff',
  'conversation-assistant-overlay',
  'conversation-assistant-list',
  'conversation-assistant-title',
  'conversation-assistant-hint',
  'conversation-send',
  'conversation-stop',
  'conversation-composer-hint',
  'conversation-handoff-note',
  'conversation-approval',
  'conversation-approval-badge',
  'conversation-approval-reason',
  'conversation-approval-command',
  'conversation-approval-allow',
  'conversation-approval-deny',
  'conversation-changes-list',
  'conversation-changes-count',
  'conversation-scroll-bottom',
  'conversation-attach-image',
  'conversation-export',
  'conversation-search-bar',
  'conversation-search-input',
  'conversation-search-count',
  'conversation-search-prev',
  'conversation-search-next',
  'conversation-search-close',
  'conversation-mention-menu',
  'conversation-usage',
  'conversation-snippet-select',
  'conversation-history-filter',
  'conversation-history-state',
  'conversation-project-search',
  'conversation-project-context',
  'conversation-activity-list',
  'conversation-plan-list',
];

function fire(node, event, payload) {
  (node?.listeners?.[event] || []).forEach(fn => fn(payload));
}

function flush(times = 24) {
  return Promise.resolve().then(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

function fixture({ projects, installed = ['claude'], focused = true, appView, history, t } = {}) {
  const byId = new Map(IDS.map(id => [id, new FakeEl(id.endsWith('-select') ? 'select' : 'div')]));
  const scroller = new FakeEl();
  scroller.appendChild(byId.get('conversation-messages'));

  const invokes = [];
  const toasts = [];
  let changedFiles = [{ status: 'M', path: 'src/a.js' }];
  let pickedImages = [];
  let slashLists = { models: [], efforts: [] };
  let oauthUsage = { ok: true, fiveHour: { utilization: 32 }, sevenDay: { utilization: 7 } };
  const sessionTitles = {};
  let projectFiles = [
    { path: 'README.md', name: 'README.md', depth: 0 },
    { path: 'src/main.js', name: 'main.js', depth: 1 },
    { path: 'src/mainframe.js', name: 'mainframe.js', depth: 1 },
  ];
  const tauriListeners = {};
  const chatEvents = [];
  const values = new Map();
  const document = {
    hidden: false,
    hasFocus: () => focused,
    documentElement: { dataset: { appView: appView || 'conversation' } },
    addEventListener: (name, fn) => { (docListeners[name] = docListeners[name] || []).push(fn); },
    removeEventListener: (name, fn) => {
      docListeners[name] = (docListeners[name] || []).filter(entry => entry !== fn);
    },
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
  };
  let emit = () => {};
  const docListeners = {};
  // 保证面板是"开着且停在第一层"：已经开着就先收起再打开（切换按钮每次点击
  // 都会把层级复位），否则可能停在某个选项列表里，找不到分节行。
  const ensureTuningOpen = () => {
    const panel = byId.get('conversation-tuning-panel');
    const toggle = byId.get('conversation-tuning-toggle');
    const click = () => (toggle.listeners.click || []).forEach(fn => fn());
    if (!panel.hidden) click();
    click();
  };
  const manageOpens = [];
  const controller = installConversationMode({
    document,
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    invoke: async (command, payload) => {
      invokes.push({ command, payload });
      if (command === 'project_context') {
        return { context: { exists: true, isRepo: true, filesMore: 0, files: changedFiles.map(file => ({ ...file })) } };
      }
      if (command === 'conversation_chat_start') return null;
      if (command === 'conversation_chat_cancel') return true;
      if (command === 'notify') return null;
      if (command === 'pick_attachment_images') return pickedImages;
      if (command === 'conversation_model_list') return { models: slashLists.models };
      if (command === 'conversation_effort_list') return { efforts: slashLists.efforts };
      if (command === 'conversation_mode_list') {
        if (payload.providerId === 'claude') {
          return [
            { id: 'plan', label: 'plan · 只读计划', hint: '不动文件', writes: false, unsandboxed: false },
            { id: 'acceptEdits', label: 'acceptEdits · 自动接受修改', hint: '改动直接生效', writes: true, unsandboxed: false },
          ];
        }
        if (payload.providerId === 'codex') {
          return [
            { id: 'read-only', label: '只读', hint: '写入被沙箱挡下', writes: false, unsandboxed: false },
            { id: 'approve-for-me', label: '帮我批准', hint: '可改工作区', writes: true, unsandboxed: false },
            { id: 'full-access', label: '完全访问权限', hint: '不开沙箱', writes: true, unsandboxed: true },
          ];
        }
        return [{ id: 'plan', label: 'plan · 只读计划', hint: '不动文件', writes: false, unsandboxed: false }];
      }
      if (command === 'list_conversation_session_titles') return { ...sessionTitles };
      if (command === 'set_conversation_session_title') {
        if (payload.title) sessionTitles[`${payload.tool}:${payload.id}`] = payload.title;
        else delete sessionTitles[`${payload.tool}:${payload.id}`];
        return { ...sessionTitles };
      }
      if (command === 'oauth_usage') return oauthUsage;
      if (command === 'conversation_project_files') {
        return projectFiles.filter(file => file.path.toLowerCase().includes(String(payload.query || '').toLowerCase()));
      }
      if (command === 'read_conversation_attachment_image') {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(payload.path)) throw new Error('只支持 PNG、JPEG、GIF、WebP 图片');
        return { kind: 'image', mimeType: 'image/png', dataUrl: `data:image/png;base64,AAAA${payload.path.length}` };
      }
      return null;
    },
    listen: async (name, handler) => {
      (tauriListeners[name] = tauriListeners[name] || []).push(handler);
      if (name === 'conversation-chat-event') emit = payload => handler({ payload });
      return () => {};
    },
    notify: (message, level) => toasts.push({ message, level }),
    loadHistory: async path => (
      (typeof history === 'function' ? history(path) : history) || { groups: [] }
    ),
    invalidateHistory: () => {},
    onManageSnippets: () => { manageOpens.push(Date.now()); },
  });
  controller.setProjects(projects);
  controller.setInstalledCliIds(installed);
  // Registered here so a failing assertion still clears the elapsed-time
  // interval; a leaked timer would hang the whole test run.
  t?.after(() => controller.destroy());

  return {
    controller,
    invokes,
    toasts,
    chatEvents,
    el: id => byId.get(id),
    emit: payload => emit(payload),
    setChanges: files => { changedFiles = files; },
    setPickedImages: paths => { pickedImages = paths; },
    setSlashLists: lists => { slashLists = { models: [], efforts: [], ...lists }; },
    setUsage: payload => { oauthUsage = payload; },
    sessionTitles,
    manageOpens,
    fireTauri: (name, payload) => (tauriListeners[name] || []).forEach(fn => fn({ payload })),
    tuningRows: () => {
      ensureTuningOpen();
      return byId.get('conversation-tuning-panel').childNodes
        .map(node => node.dataset.section)
        .filter(Boolean);
    },
    openTuning: section => {
      ensureTuningOpen();
      if (!section) return;
      const row = byId.get('conversation-tuning-panel').childNodes
        .find(node => node.dataset.section === section);
      if (!row) throw new Error(`面板里没有 ${section} 这一项`);
      (row.listeners.click || []).forEach(fn => fn());
    },
    tuningOptions: () => byId.get('conversation-tuning-panel').childNodes
      .filter(node => node.dataset.optionId !== undefined)
      .map(node => node.dataset.optionId),
    pickTuning: (section, optionId) => {
      ensureTuningOpen();
      const row = byId.get('conversation-tuning-panel').childNodes
        .find(node => node.dataset.section === section);
      if (!row) throw new Error(`面板里没有 ${section} 这一项`);
      (row.listeners.click || []).forEach(fn => fn());
      const option = byId.get('conversation-tuning-panel').childNodes
        .find(node => node.dataset.optionId === optionId);
      if (!option) throw new Error(`${section} 里没有 ${optionId}`);
      (option.listeners.click || []).forEach(fn => fn());
    },
    pickAssistant: id => {
      const badge = byId.get('conversation-assistant-badge');
      (badge.listeners.click || []).forEach(fn => fn());
      const row = byId.get('conversation-assistant-list').childNodes
        .find(node => node.dataset.tool === id);
      if (!row) throw new Error(`助手选择里没有 ${id}`);
      (row.listeners.click || []).forEach(fn => fn());
    },
    handoffTo: id => {
      const handoff = byId.get('conversation-handoff');
      (handoff.listeners.click || []).forEach(fn => fn());
      const row = byId.get('conversation-assistant-list').childNodes
        .find(node => node.dataset.tool === id);
      if (!row) throw new Error(`交接目标里没有 ${id}`);
      (row.listeners.click || []).forEach(fn => fn());
    },
    // 真实浏览器里点击会冒泡到 document；这里显式重放，用来守住
    // "点开分节后被自己的外部点击监听误收起"那个 bug。
    clickWithBubble: node => {
      let stopped = false;
      const event = { target: node, stopPropagation() { stopped = true; } };
      (node.listeners.click || []).forEach(fn => fn(event));
      if (stopped) return;
      (docListeners.click || []).forEach(fn => fn(event));
    },
    key: ({ appView: view, ...init }) => {
      const root = document.documentElement.dataset;
      const previous = root.appView;
      if (view) root.appView = view;
      (docListeners.keydown || []).forEach(fn => fn({ preventDefault() {}, ...init }));
      root.appView = previous;
    },
    startedRuns: () => invokes
      .filter(entry => entry.command === 'conversation_chat_start')
      .map(entry => entry.payload.request),
    clickProject: id => {
      const walk = node => {
        if (node.dataset?.projectId === id) return node;
        for (const child of node.childNodes) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      const button = walk(byId.get('conversation-project-list'));
      assert.ok(button, `找不到项目 ${id} 的入口`);
      fire(button, 'click');
    },
    projectButton: id => {
      const walk = node => {
        if (node.dataset?.projectId === id) return node;
        for (const child of node.childNodes) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(byId.get('conversation-project-list'));
    },
    async send(text) {
      byId.get('conversation-composer').value = text;
      fire(byId.get('conversation-send'), 'click');
      await flush();
    },
  };
}

const project = (id, name) => ({ id, name, localPath: `/tmp/${id}`, group: '' });
const conversationLabel = id => ({ claude: 'Claude', grok: 'Grok', codex: 'Codex' }[id] || id);

test('审批请求弹卡片，答复后回传决定，轮次结束自动收掉', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['codex'], t });
  await flush();
  await fx.send('帮我查点东西');
  const run = fx.startedRuns()[0];
  const card = fx.el('conversation-approval');
  assert.equal(card.hidden, true, '平时不该出现');

  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'approval',
    data: {
      approvalId: 'exec-1',
      kind: 'command',
      reason: '是否允许联网抓取 example.com？',
      command: 'curl -sS https://example.com',
    },
  });
  await flush();
  assert.equal(card.hidden, false);
  assert.equal(fx.el('conversation-approval-reason').textContent, '是否允许联网抓取 example.com？');
  assert.equal(fx.el('conversation-approval-command').textContent, 'curl -sS https://example.com');

  fire(fx.el('conversation-approval-allow'), 'click');
  await flush();
  const sent = fx.invokes.filter(item => item.command === 'conversation_chat_approve');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, {
    runId: run.runId,
    approvalId: 'exec-1',
    decision: 'accept',
  });

  // 迟到的、对不上号的答复事件不能把卡片抹掉。
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'approval_resolved', data: { approvalId: '别的' } });
  await flush();
  assert.equal(card.hidden, false, '只清正在等的那一条');

  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'approval_resolved', data: { approvalId: 'exec-1' } });
  await flush();
  assert.equal(card.hidden, true);

  // 轮次以任何方式结束，都不能留下一张点不动的卡。
  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'approval',
    data: { approvalId: 'exec-2', kind: 'fileChange', reason: '要写到项目外', command: '' },
  });
  await flush();
  assert.equal(card.hidden, false);
  assert.equal(fx.el('conversation-approval-command').hidden, true, '没有命令就不显示命令块');
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(card.hidden, true, '轮次结束必须收掉挂起的审批');
});

test('后台项目在等审批时要看得见，并且状态不再说"正在处理"', async t => {
  const fx = fixture({
    projects: [project('a', '项目 A'), project('b', '项目 B')],
    installed: ['codex'],
    t,
  });
  await flush();
  await fx.send('查点东西');
  const run = fx.startedRuns()[0];

  // 切到另一个项目，让刚才那轮退到后台
  fx.clickProject('b');
  await flush();
  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'approval',
    data: { approvalId: 'exec-1', kind: 'command', reason: '要联网', command: 'curl x' },
  });
  await flush();

  // 后台项目行要有明确的"等你批准"标记，而不是和"正在处理"混为一谈
  const rowA = fx.el('conversation-project-list').childNodes
    .find(node => node.dataset.projectId === 'a');
  const dots = rowA.childNodes.filter(node => node.className?.includes('await-dot'));
  assert.equal(dots.length, 1, '等审批要有独立标记');
  assert.equal(rowA.className.includes('is-awaiting'), true);
  assert.equal(rowA.className.includes('is-running'), false, '不能同时说它在跑');

  // 不在当前项目时要提示用户回来处理
  assert.equal(fx.toasts.some(item => /批准/.test(item.message)), true);

  // 回到那个项目，状态栏不能再说"正在处理"
  fx.clickProject('a');
  await flush();
  assert.equal(fx.el('conversation-status').textContent.includes('正在处理'), false);
  assert.match(fx.el('conversation-status').textContent, /批准/);
  assert.equal(fx.el('conversation-status').dataset.status, 'awaiting');
});

test('流式增量渲染复用未变化的消息节点', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('第一个问题');
  const stream = fx.el('conversation-messages');
  assert.equal(stream.childNodes.length, 2);
  const [userRow, assistantRow] = stream.childNodes;
  const userContent = userRow.childNodes[0].childNodes[1];
  const run = fx.startedRuns()[0];

  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_delta', data: { text: '先' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_delta', data: { text: '后' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_message', data: { text: '先后完整回答' } });

  assert.equal(stream.childNodes.length, 2);
  assert.equal(stream.childNodes[0], userRow, '用户消息节点必须复用');
  assert.equal(stream.childNodes[1], assistantRow, '助手消息节点必须复用');
  assert.equal(userRow.childNodes[0].childNodes[1], userContent, '未变化的消息不得重建正文');
  assert.equal(assistantRow.childNodes[0].childNodes[1].textContent, '先后完整回答');
});

test('一个项目在跑时可以切到别的项目，两边互不覆盖', async t => {
  const fx = fixture({ projects: [project('a', '项目 A'), project('b', '项目 B')], t });
  await flush();
  fx.clickProject('a');
  await flush();
  await fx.send('A 的问题');
  const run = fx.startedRuns()[0];
  assert.equal(run.projectId, 'a');

  fx.clickProject('b');
  await flush();
  assert.equal(fx.el('conversation-project-name').textContent, '项目 B');
  assert.equal(fx.el('conversation-messages').childNodes.length, 0, '切走后不显示别的项目的消息');
  assert.ok(fx.projectButton('a').classNames.has('is-running'), '后台运行的项目要有运行标记');

  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_message', data: { text: 'A 的回答' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(fx.el('conversation-messages').childNodes.length, 0, '后台完成不得写进当前项目');

  fx.clickProject('a');
  await flush();
  const texts = fx.el('conversation-messages').childNodes
    .map(row => row.childNodes[0].childNodes[1].textContent);
  assert.deepEqual(texts, ['A 的问题', 'A 的回答']);
  assert.ok(!fx.projectButton('a').classNames.has('is-running'));
});

test('后台项目跑完会发桌面通知，当前项目且窗口在前台时不打扰', async t => {
  const background = fixture({ projects: [project('a', '项目 A'), project('b', '项目 B')], t });
  await flush();
  background.clickProject('a');
  await flush();
  await background.send('A 的问题');
  const run = background.startedRuns()[0];
  background.clickProject('b');
  await flush();
  background.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  const notified = background.invokes.filter(entry => entry.command === 'notify');
  assert.equal(notified.length, 1);
  assert.match(notified[0].payload.title, /项目 A/);
  assert.ok(background.toasts.some(toast => /项目 A/.test(toast.message)));

  const foreground = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await foreground.send('问题');
  const active = foreground.startedRuns()[0];
  foreground.emit({ runId: active.runId, providerId: active.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(foreground.invokes.filter(entry => entry.command === 'notify').length, 0);
  assert.match(foreground.el('conversation-status').textContent, /已完成 · 用时/);

  const developer = fixture({ projects: [project('a', '项目 A')], appView: 'developer', t });
  await flush();
  await developer.send('问题');
  const hidden = developer.startedRuns()[0];
  developer.emit({ runId: hidden.runId, providerId: hidden.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(
    developer.invokes.filter(entry => entry.command === 'notify').length,
    1,
    '停在开发模式时看不到对话，必须发通知',
  );
});

test('同时最多四个项目在跑，第五个被挡下并提示', async t => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const fx = fixture({ projects: ids.map(id => project(id, `项目 ${id}`)), t });
  await flush();
  for (const id of ids) {
    fx.clickProject(id);
    await flush();
    await fx.send(`${id} 的问题`);
  }
  assert.equal(fx.startedRuns().length, MAX_PARALLEL_CONVERSATION_RUNS);
  assert.ok(fx.toasts.some(toast => toast.message.includes('最多同时处理')));
});

test('未发送的草稿按项目保存，切回来还在', async t => {
  const fx = fixture({ projects: [project('a', '项目 A'), project('b', '项目 B')], t });
  await flush();
  fx.clickProject('a');
  await flush();
  fx.el('conversation-composer').value = 'A 的草稿';
  fx.clickProject('b');
  await flush();
  fx.el('conversation-composer').value = 'B 的草稿';
  fx.clickProject('a');
  await flush();
  assert.equal(fx.el('conversation-composer').value, 'A 的草稿');
  fx.clickProject('b');
  await flush();
  assert.equal(fx.el('conversation-composer').value, 'B 的草稿');
});

test('迟到的取消事件仍能覆盖已经完成的同一轮', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('问题');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.match(fx.el('conversation-status').textContent, /已完成/);
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'cancelled', data: {} });
  await flush();
  assert.match(fx.el('conversation-status').textContent, /已停止/);
});

function useClipboard() {
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async value => { copied.push(value); } } },
    configurable: true,
    writable: true,
  });
  return copied;
}

test('每条消息可复制，用户消息还能放回输入框重新提问', async t => {
  const copied = useClipboard();
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('原始问题');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_message', data: { text: '助手的回答' } });
  await flush();

  const [userRow, assistantRow] = fx.el('conversation-messages').childNodes;
  const userTools = userRow.childNodes[1];
  const assistantTools = assistantRow.childNodes[1];
  assert.deepEqual(userTools.childNodes.map(node => node.textContent), ['复制', '重新提问']);
  assert.deepEqual(assistantTools.childNodes.map(node => node.textContent), ['复制']);

  fire(assistantTools.childNodes[0], 'click');
  await flush();
  assert.deepEqual(copied, ['助手的回答']);
  assert.equal(assistantTools.childNodes[0].textContent, '已复制');

  fx.el('conversation-composer').value = '已经写了一半';
  fire(userTools.childNodes[1], 'click');
  assert.equal(fx.el('conversation-composer').value, '已经写了一半\n\n原始问题', '重新提问要追加而不是覆盖草稿');
});

test('回答里的代码块有独立复制按钮，复制的是代码本身', async t => {
  const copied = useClipboard();
  globalThis.window.marked = { parse: source => source.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>') };
  globalThis.window.DOMPurify = { sanitize: html => html };
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('给我一段代码');
  const run = fx.startedRuns()[0];
  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'assistant_delta',
    data: { text: '看这里\n```\nconst a = 1;\n```' },
  });
  await flush();
  const content = () => fx.el('conversation-messages').childNodes[1].childNodes[0].childNodes[1];
  assert.equal(
    content().childNodes.filter(node => node.classNames.has('conversation-code-block')).length,
    0,
    '流式过程中不挂复制按钮',
  );

  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'assistant_message',
    data: { text: '看这里\n```\nconst a = 1;\n```' },
  });
  await flush();
  const wraps = content().childNodes.filter(node => node.classNames.has('conversation-code-block'));
  assert.equal(wraps.length, 1);
  assert.equal(wraps[0].childNodes[0].tagName, 'PRE');
  const button = wraps[0].childNodes[1];
  assert.equal(button.textContent, '复制');
  fire(button, 'click');
  await flush();
  assert.deepEqual(copied, ['\nconst a = 1;\n']);
  delete globalThis.window.marked;
  delete globalThis.window.DOMPurify;
});

test('左侧分组第一次出现时是折叠的，用户展开后保持展开', async t => {
  const fx = fixture({
    t,
    projects: [
      { id: 'a', name: '项目 A', localPath: '/tmp/a', group: '工作' },
      { id: 'b', name: '项目 B', localPath: '/tmp/b', group: '个人' },
    ],
  });
  await flush();
  const sections = () => fx.el('conversation-project-list').childNodes
    .filter(node => node.dataset.group);
  const personal = () => sections().find(node => node.dataset.group === '个人');
  assert.ok(personal().classNames.has('is-collapsed'), '没选中的分组默认折叠');
  fire(personal().childNodes[0], 'click');
  assert.ok(!personal().classNames.has('is-collapsed'), '点开之后要展开');
  fx.controller.setSnippets([]);
  assert.ok(!personal().classNames.has('is-collapsed'), '重绘后保持用户选择');
});

test('换助手时输入框上方说明会接手什么，并能一键改回', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();
  await fx.send('第一个问题');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'thread', data: { threadId: 'sess-1' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  const note = fx.el('conversation-handoff-note');
  assert.equal(note.hidden, true, '没换助手时不显示交接说明');

  const target = run.providerId === 'claude' ? 'grok' : 'claude';
  fx.handoffTo(target);
  await flush();
  assert.equal(note.hidden, false);
  assert.match(note.childNodes[0].textContent, /接手[\s\S]*这段对话/);
  assert.match(note.childNodes[0].textContent, /最近 24 条正文/);

  const undo = note.childNodes[1];
  assert.match(undo.textContent, /^改回 /);
  fire(undo, 'click');
  await flush();
  assert.equal(note.hidden, true, '改回来源助手后说明消失');
  assert.equal(fx.el('conversation-assistant-name').textContent, conversationLabel(run.providerId));
});

test('只统计磁盘上真的变了的文件，截断的快照标成部分', () => {
  const before = normalizeProjectChanges({
    isRepo: true,
    filesMore: 0,
    files: [{ status: 'M', path: 'src/a.js' }, { status: 'M', path: 'src/old.js' }],
  });
  const after = normalizeProjectChanges({
    isRepo: true,
    filesMore: 0,
    files: [
      { status: 'M', path: 'src/a.js' },
      { status: 'A', path: 'src/new.js' },
      { status: 'D', path: 'src/gone.js' },
    ],
  });
  const report = diffProjectChanges(before, after);
  assert.deepEqual(report.files, [
    { status: 'A', path: 'src/new.js' },
    { status: 'D', path: 'src/gone.js' },
    { status: 'gone', path: 'src/old.js' },
  ], '本来就改着的文件不算这一轮的');
  assert.equal(report.partial, false);

  assert.equal(normalizeProjectChanges({ isRepo: false }), null, '非 Git 项目不做改动统计');
  const truncated = diffProjectChanges(before, { ...after, more: 7 });
  assert.equal(truncated.partial, true);
  assert.equal(changedFileLabel('??'), '新文件');
  assert.equal(changedFileLabel('gone'), '已提交或还原');
  assert.equal(changedFileLabel('RM'), '重命名');
  assert.equal(changedFileLabel(''), '改动');
});

test('只有允许修改项目的那一轮才拍基线并出改动清单', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  const contextCalls = () => fx.invokes.filter(entry => entry.command === 'project_context').length;

  const readOnlyBefore = contextCalls();
  await fx.send('只读的一轮');
  assert.equal(contextCalls(), readOnlyBefore, '只读轮不额外拍基线');
  const readOnlyRun = fx.startedRuns()[0];
  assert.equal(readOnlyRun.mode, '', '没选过模式就交给后端用最保守的一档');
  fx.emit({ runId: readOnlyRun.runId, providerId: readOnlyRun.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(fx.el('conversation-changes-list').childNodes.length, 0);

  fx.pickTuning('mode', 'acceptEdits');
  const writeBefore = contextCalls();
  await fx.send('去改一下文件');
  assert.equal(contextCalls(), writeBefore + 1, '写入轮发送时先拍基线');
  fx.setChanges([{ status: 'M', path: 'src/a.js' }, { status: 'A', path: 'src/new.js' }]);
  const writeRun = fx.startedRuns()[1];
  assert.equal(writeRun.mode, 'acceptEdits', '把选中的模式原样传给后端');
  fx.emit({ runId: writeRun.runId, providerId: writeRun.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  const rows = fx.el('conversation-changes-list').childNodes;
  assert.ok(rows.length >= 1, '写入轮结束后要列出本轮改动');
  assert.equal(rows[0].childNodes[1].textContent, 'src/new.js');
  assert.match(fx.el('conversation-changes-count').textContent, /个文件/);
});

test('快捷句跟着项目现场变，永远保留梳理现状这条', () => {
  const plain = conversationStarters(null).map(item => item.label);
  assert.deepEqual(plain, ['梳理项目现状', '整理下一步计划']);

  const dirtyRepo = conversationStarters({
    exists: true,
    isRepo: true,
    dirty: true,
    claudeMd: '有说明',
    commits: [{ subject: '上一次提交' }],
  }).map(item => item.label);
  assert.equal(dirtyRepo[0], '梳理项目现状');
  assert.ok(dirtyRepo.includes('看看这些改动'));
  assert.equal(dirtyRepo.length, 3, '最多三条');

  const undocumented = conversationStarters({ exists: true, isRepo: false, claudeMd: '' })
    .map(item => item.label);
  assert.ok(undocumented.includes('写份项目说明'));
});

test('滚上去看历史会出现回到最新，点一下滚回底部', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('问题');
  const scroller = fx.el('conversation-messages').parentElement;
  const button = fx.el('conversation-scroll-bottom');
  assert.equal(button.hidden, true, '贴着底部时不显示');

  scroller.scrollHeight = 2000;
  scroller.clientHeight = 600;
  scroller.scrollTop = 100;
  fire(scroller, 'scroll');
  await flush();
  assert.equal(button.hidden, false, '滚上去后要出现');

  fire(button, 'click');
  assert.equal(scroller.scrollTop, scroller.scrollHeight);
  assert.equal(button.hidden, true, '滚回底部后收起');
});

test('⌘K 聚焦项目搜索，⌘⇧N 在当前项目开新对话', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  let focused = 0;
  fx.el('conversation-project-search').focus = () => { focused += 1; };
  fx.key({ key: 'k', metaKey: true });
  assert.equal(focused, 1);

  await fx.send('第一句');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.ok(fx.el('conversation-messages').childNodes.length > 0);
  fx.key({ key: 'n', metaKey: true, shiftKey: true });
  await flush();
  const picker = fx.el('conversation-assistant-list');
  assert.ok(picker.childNodes.length > 0, '先问用哪个助手');
  fire(picker.childNodes[0], 'click');
  await flush();
  assert.equal(fx.el('conversation-messages').childNodes.length, 0, '选完助手才开新对话');

  const before = focused;
  fx.key({ key: 'k', metaKey: true, appView: 'developer' });
  assert.equal(focused, before, '开发模式下不抢这两个快捷键');
});

test('可以选文件或拖进来加图片，非图片和超量都挡住', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  const thumbs = () => fx.el('conversation-attachments').childNodes.length;

  fx.setPickedImages(['/tmp/one.png', '/tmp/two.jpeg']);
  fire(fx.el('conversation-attach-image'), 'click');
  await flush();
  assert.equal(thumbs(), 2, '选中的两张都进了待发送区');

  fx.fireTauri('tauri://drag-drop', { paths: ['/tmp/notes.txt'] });
  await flush();
  assert.equal(thumbs(), 2, '非图片不进来');
  assert.ok(fx.toasts.some(toast => /只支持 PNG/.test(toast.message)));

  fx.fireTauri('tauri://drag-drop', { paths: ['/tmp/c.png', '/tmp/d.png', '/tmp/e.png'] });
  await flush();
  assert.equal(thumbs(), 4, '一条消息最多四张');
  assert.ok(fx.toasts.some(toast => /最多附带 4 张图片/.test(toast.message)));
});

test('拖放只在对话工作台响应，开发模式下不接管', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], appView: 'developer', t });
  await flush();
  fx.fireTauri('tauri://drag-drop', { paths: ['/tmp/one.png'] });
  await flush();
  assert.equal(fx.el('conversation-attachments').childNodes.length, 0);
});

test('导出的 Markdown 只有人看得懂的部分', () => {
  const text = conversationMarkdown({
    projectName: '杂项',
    now: Date.UTC(2026, 7, 27),
    messages: [
      { role: 'user', text: '第一个问题', tool: 'grok' },
      { role: 'assistant', text: '第一段回答', tool: 'Grok', pending: false },
      { role: 'assistant', text: '   ', tool: 'Grok' },
    ],
  });
  assert.match(text, /^# 杂项/);
  assert.match(text, /## 你\n\n第一个问题/);
  assert.match(text, /## Grok\n\n第一段回答/);
  assert.doesNotMatch(text, /pending|runId|dataUrl/, '不带内部字段');
  assert.equal((text.match(/## /g) || []).length, 2, '空消息不进导出');
});

test('停止之后给出接着继续的入口，点了只填输入框不自动发送', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('问题');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_delta', data: { text: '说了一半' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'cancelled', data: {} });
  await flush();

  const stream = fx.el('conversation-messages');
  const alert = stream.childNodes[stream.childNodes.length - 1];
  const resume = alert.childNodes.find(node => node.textContent === '接着刚才继续');
  assert.ok(resume, '停止后要有接着继续的按钮');
  fire(resume, 'click');
  assert.match(fx.el('conversation-composer').value, /接着刚才没说完/);
  assert.equal(fx.startedRuns().length, 1, '只填输入框，不自动发送');
});

test('导出按钮只在有内容时出现，并把 Markdown 交给后端保存', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  assert.equal(fx.el('conversation-export').hidden, true, '空对话不显示导出');
  await fx.send('问题');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(fx.el('conversation-export').hidden, false);
  fire(fx.el('conversation-export'), 'click');
  await flush();
  const call = fx.invokes.find(entry => entry.command === 'export_conversation_markdown');
  assert.ok(call, '要调用后端导出');
  assert.match(call.payload.suggestedName, /项目 A\.md$/);
  assert.match(call.payload.content, /## 你\n\n问题/);
});

test('对话内搜索按消息命中，空查询不算命中', () => {
  const messages = [
    { text: '帮我看看 Roster 的深色模式' },
    { text: '深色模式已经做完了' },
    { text: '换个话题' },
  ];
  assert.deepEqual(conversationSearchHits(messages, '深色'), [0, 1]);
  assert.deepEqual(conversationSearchHits(messages, 'ROSTER'), [0], '忽略大小写');
  assert.deepEqual(conversationSearchHits(messages, '   '), []);
  assert.deepEqual(conversationSearchHits(null, '深色'), []);
});

test('⌘F 打开对话内搜索，可上下跳并用 Esc 关掉', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('第一次说到深色');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'assistant_message', data: { text: '深色模式已经做完了' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();

  const bar = fx.el('conversation-search-bar');
  assert.equal(bar.hidden, true);
  fx.key({ key: 'f', metaKey: true });
  assert.equal(bar.hidden, false, '⌘F 打开搜索');

  const input = fx.el('conversation-search-input');
  input.value = '深色';
  fire(input, 'input');
  assert.equal(fx.el('conversation-search-count').textContent, '1/2');
  const [userRow, assistantRow] = fx.el('conversation-messages').childNodes;
  assert.ok(userRow.classNames.has('is-search-current'));
  assert.ok(assistantRow.classNames.has('is-search-hit'));
  assert.ok(!assistantRow.classNames.has('is-search-current'));

  fire(fx.el('conversation-search-next'), 'click');
  assert.equal(fx.el('conversation-search-count').textContent, '2/2');
  assert.ok(assistantRow.classNames.has('is-search-current'));
  fire(fx.el('conversation-search-next'), 'click');
  assert.equal(fx.el('conversation-search-count').textContent, '1/2', '到底了回到第一处');

  input.value = '压根没有的词';
  fire(input, 'input');
  assert.equal(fx.el('conversation-search-count').textContent, '没有匹配');
  assert.ok(!userRow.classNames.has('is-search-hit'), '不匹配时清掉高亮');

  fire(input, 'keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(bar.hidden, true, 'Esc 关掉搜索');
  assert.equal(input.value, '');
});

test('只有行首或空白后的 @token 才算引用文件', () => {
  assert.deepEqual(inspectConversationMention('@ma', 3), { active: true, query: 'ma', start: 0, end: 3 });
  assert.equal(inspectConversationMention('看看 @src/m', 8).active, true);
  assert.equal(inspectConversationMention('a@b.com', 7).active, false, '邮箱不算');
  assert.equal(inspectConversationMention('@ma in', 6).active, false, 'token 里不能有空格');
  assert.equal(inspectConversationMention('没有引用', 4).active, false);
  assert.equal(inspectConversationMention(`@${'x'.repeat(200)}`, 201).active, false);
});

test('@ 会列出项目文件，选中后把相对路径插进输入框', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  const composer = fx.el('conversation-composer');
  const menu = fx.el('conversation-mention-menu');

  composer.value = '看看 @main';
  composer.selectionStart = composer.value.length;
  fire(composer, 'input');
  await flush();
  assert.equal(menu.hidden, false, '有匹配就展开');
  assert.deepEqual(
    menu.childNodes.map(node => node.childNodes[1].textContent),
    ['src/main.js', 'src/mainframe.js'],
  );

  fire(menu.childNodes[1], 'click');
  assert.equal(composer.value, '看看 src/mainframe.js ', '插入相对路径并去掉 @');
  assert.equal(menu.hidden, true);

  composer.value = '普通的一句话';
  composer.selectionStart = composer.value.length;
  fire(composer, 'input');
  await flush();
  assert.equal(menu.hidden, true, '没有 @ 时不弹');
});

test('侧栏显示当前助手的限流用量，换到没有用量的助手就收起', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();
  const usage = fx.el('conversation-usage');

  fx.pickAssistant('claude');
  await flush();
  assert.equal(usage.hidden, false);
  assert.equal(usage.textContent, '5 小时 32% · 7 天 7%', '徽标就在旁边，不用再写一遍助手名');

  const beforeGrok = fx.invokes.filter(entry => entry.command === 'oauth_usage').length;
  fx.pickAssistant('grok');
  await flush();
  assert.equal(usage.hidden, true, 'Grok 没有限流接口，这行就不显示');
  assert.equal(
    fx.invokes.filter(entry => entry.command === 'oauth_usage').length,
    beforeGrok,
    '没有限流接口的助手不该发查询',
  );
});

test('失败后能一键把原消息和图片放回输入框，失败的空气泡不显示', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  fx.setPickedImages(['/tmp/one.png']);
  fire(fx.el('conversation-attach-image'), 'click');
  await flush();
  await fx.send('这条会失败');
  assert.equal(fx.el('conversation-attachments').childNodes.length, 0, '发出去后待发区清空');

  const run = fx.startedRuns()[0];
  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'error',
    data: { message: 'Grok 退出：未登录' },
  });
  await flush();

  const rows = fx.el('conversation-messages').childNodes;
  const labels = rows.map(row => row.childNodes[0]?.childNodes?.[0]?.textContent);
  assert.ok(!labels.includes('Grok'), '失败留下的空助手气泡不渲染');
  const alert = rows[rows.length - 1];
  const retry = alert.childNodes.find(node => node.textContent === '重试这条');
  assert.ok(retry, '失败后要有重试入口');

  fire(retry, 'click');
  assert.equal(fx.el('conversation-composer').value, '这条会失败');
  assert.equal(fx.el('conversation-attachments').childNodes.length, 1, '图片一起放回来');
  assert.equal(fx.startedRuns().length, 1, '只填输入框，不自动重发');
});

test('片段下拉自带管理入口，选它只开弹窗不插内容', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  fx.controller.setSnippets([{ id: 's1', title: '片段一', content: '内容一' }]);
  const select = fx.el('conversation-snippet-select');
  assert.deepEqual(
    select.childNodes.map(node => node.textContent),
    ['常用片段', '片段一', '管理片段…'],
  );
  select.value = '__manage__';
  fire(select, 'change');
  assert.equal(fx.el('conversation-composer').value, '', '管理项不插入正文');
  assert.equal(select.value, '');
  assert.equal(fx.manageOpens.length, 1, '打开的是片段管理弹窗');
});

test('超长回答默认收起，展开后保持展开', async t => {
  assert.equal(shouldCollapseMessage({ role: 'assistant', text: 'x'.repeat(3001) }), true);
  assert.equal(shouldCollapseMessage({ role: 'assistant', text: 'x'.repeat(2999) }), false);
  assert.equal(shouldCollapseMessage({ role: 'assistant', text: 'x'.repeat(9000), pending: true }), false, '还在流式时不折叠');
  assert.equal(shouldCollapseMessage({ role: 'user', text: 'x'.repeat(9000) }), false, '用户消息不折叠');

  const fx = fixture({ projects: [project('a', '项目 A')], t });
  await flush();
  await fx.send('给我一篇长的');
  const run = fx.startedRuns()[0];
  fx.emit({
    runId: run.runId,
    providerId: run.providerId,
    kind: 'assistant_message',
    data: { text: '很长的回答'.repeat(1000) },
  });
  await flush();

  const assistantRow = fx.el('conversation-messages').childNodes[1];
  const expand = assistantRow.childNodes[0].childNodes[2];
  assert.ok(assistantRow.classNames.has('is-collapsed'), '长回答默认收起');
  assert.equal(expand.hidden, false);
  assert.match(expand.textContent, /^展开全部/);

  fire(expand, 'click');
  assert.ok(!assistantRow.classNames.has('is-collapsed'));
  assert.equal(expand.textContent, '收起');

  fire(expand, 'click');
  assert.ok(assistantRow.classNames.has('is-collapsed'), '可以再收回去');
});

test('历史筛选只统计真出现过的 CLI，按条数排序', () => {
  const tools = conversationHistoryTools([
    { tool: 'claude', label: 'Claude' },
    { tool: 'codex', label: 'Codex' },
    { tool: 'claude', label: 'Claude' },
    { tool: '', label: '坏数据' },
  ]);
  assert.deepEqual(tools, [
    { tool: 'claude', label: 'Claude', count: 2 },
    { tool: 'codex', label: 'Codex', count: 1 },
  ]);
  assert.deepEqual(conversationHistoryTools(null), []);
});

test('历史列表按 CLI 筛选，只有一家时不显示筛选条', async t => {
  const mixed = {
    groups: [
      { tool: 'claude', label: 'Claude', sessions: [
        { id: 'c1', title: 'Claude 一', atMs: 300 },
        { id: 'c2', title: 'Claude 二', atMs: 200 },
      ] },
      { tool: 'codex', label: 'Codex', sessions: [{ id: 'x1', title: 'Codex 一', atMs: 100 }] },
    ],
  };
  const fx = fixture({ projects: [project('a', '项目 A')], history: mixed, t });
  await flush();
  const filter = fx.el('conversation-history-filter');
  const list = fx.el('conversation-history-list');
  assert.equal(filter.hidden, false);
  assert.deepEqual(
    filter.childNodes.map(chip => `${chip.childNodes[0].textContent}:${chip.childNodes[1].textContent}`),
    ['全部:3', 'Claude:2', 'Codex:1'],
  );
  assert.equal(list.childNodes.length, 3);

  fire(filter.childNodes[2], 'click');
  assert.equal(fx.el('conversation-history-list').childNodes.length, 1, '只留 Codex 的');
  fire(fx.el('conversation-history-filter').childNodes[2], 'click');
  assert.equal(fx.el('conversation-history-list').childNodes.length, 3, '再点一次取消筛选');
});

test('一个项目都没有时给三步引导，有项目后换成普通空状态', async t => {
  const fx = fixture({ projects: [], t });
  await flush();
  const empty = fx.el('conversation-empty');
  assert.equal(empty.dataset.mode, 'onboarding');
  assert.match(empty.childNodes[0].textContent, /先添加一个项目/);
  const steps = empty.childNodes.find(node => node.tagName === 'OL');
  assert.equal(steps.childNodes.length, 3);
  assert.match(steps.childNodes[2].textContent, /最保守的那一档/, '第一次就把只读边界说清楚');
  assert.ok(empty.childNodes.some(node => node.textContent === '新建项目'));
  assert.equal(fx.el('conversation-starter-list').hidden, true, '没项目时不给快捷句');

  fx.controller.setProjects([project('a', '项目 A')]);
  await flush();
  assert.equal(fx.el('conversation-empty').dataset.mode, 'ready');
  assert.match(fx.el('conversation-empty').childNodes[0].textContent, /今天想推进什么/);
  assert.equal(fx.el('conversation-starter-list').hidden, false);
});

test('历史会话可以改名，改回原名等于清掉别名', async t => {
  const history = {
    groups: [{ tool: 'claude', label: 'Claude', sessions: [{ id: 'c1', title: '原始标题', atMs: 300 }] }],
  };
  const fx = fixture({ projects: [project('a', '项目 A')], history, t });
  await flush();
  const rowOf = () => fx.el('conversation-history-list').childNodes[0];
  const titleOf = () => rowOf().childNodes[0].childNodes[1].childNodes[0].textContent;
  assert.equal(titleOf(), '原始标题');

  fire(rowOf().childNodes[1], 'click');
  const input = rowOf().childNodes[0];
  assert.equal(input.tagName, 'INPUT');
  assert.equal(input.value, '原始标题');
  input.value = '重要的那次排查';
  fire(input, 'keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(titleOf(), '重要的那次排查');
  assert.equal(fx.sessionTitles['claude:c1'], '重要的那次排查');

  fire(rowOf().childNodes[1], 'click');
  const again = rowOf().childNodes[0];
  again.value = '原始标题';
  fire(again, 'keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(titleOf(), '原始标题');
  assert.equal('claude:c1' in fx.sessionTitles, false, '改回原名就不再占一条别名');
});

test('模型和推理强度带助手归属，换助手时不会把上一家的列表挂过来', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();

  fx.setSlashLists({ models: [{ id: 'grok-4', label: 'grok-4' }], efforts: [] });
  fx.pickAssistant('grok');
  await flush();
  assert.deepEqual(fx.tuningRows(), ['model', 'mode'], 'Grok 这边有模型可选');

  // 换助手的一瞬间新列表还没回来，这个空档里绝不能列出 grok-4。
  fx.setSlashLists({ models: [], efforts: [] });
  fx.pickAssistant('claude');
  assert.equal(
    fx.tuningRows().includes('model'),
    false,
    '新助手的模型还没查回来时，宁可不列，也不能显示上一家的',
  );
  await flush();
  assert.deepEqual(fx.tuningRows(), ['mode'], 'Claude 这边确实没有模型列表');
});

test('Codex 的强度按所选模型过滤，换到不支持的模型就丢掉旧强度', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['codex'], t });
  await flush();
  // 本机 models_cache 的真实形状：各模型支持的强度并不一样。
  fx.setSlashLists({
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })),
  });
  fx.pickAssistant('codex');
  await flush();

  // 没选模型时不知道该按谁过滤，六档全给。
  const effortIds = () => { fx.openTuning('effort'); return fx.tuningOptions().filter(Boolean); };
  assert.equal(effortIds().length, 6);

  fx.pickTuning('model', 'gpt-5.6-sol');
  assert.equal(effortIds().includes('ultra'), true, 'Sol 支持 ultra');
  fx.pickTuning('effort', 'ultra');

  // gpt-5.5 没有 max / ultra：实测 Codex 会收下再悄悄降级，所以干脆别列。
  fx.pickTuning('model', 'gpt-5.5');
  assert.deepEqual(effortIds(), ['low', 'medium', 'high', 'xhigh']);
  const summary = fx.el('conversation-tuning-toggle').textContent;
  assert.equal(/ultra/.test(summary), false, '换了模型就不该还挂着 ultra');
});

test('Codex 的完全访问权限单独标出来，不和普通写入模式混为一谈', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['codex'], t });
  await flush();
  fx.pickAssistant('codex');
  await flush();

  const toggle = fx.el('conversation-tuning-toggle');
  assert.equal(toggle.dataset.unsandboxed, 'false', '默认只读，不该带无沙箱标记');

  fx.openTuning('mode');
  assert.deepEqual(fx.tuningOptions(), ['read-only', 'approve-for-me', 'full-access']);

  // 「帮我批准」会改文件，但仍在沙箱里——两者的视觉重量必须区分开。
  fx.pickTuning('mode', 'approve-for-me');
  assert.equal(toggle.dataset.writes, 'true');
  assert.equal(toggle.dataset.unsandboxed, 'false');

  fx.pickTuning('mode', 'full-access');
  assert.equal(toggle.dataset.writes, 'true');
  assert.equal(toggle.dataset.unsandboxed, 'true', '不开沙箱要看得出来');
});

test('模式只列当前助手有的档，选中后按 provider 记住', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();
  const toggle = fx.el('conversation-tuning-toggle');
  const composer = fx.el('conversation-composer');

  fx.pickAssistant('claude');
  await flush();
  fx.openTuning('mode');
  assert.deepEqual(
    fx.el('conversation-tuning-panel').childNodes
      .filter(node => node.dataset.optionId)
      .map(node => node.childNodes[0].childNodes[0].textContent),
    ['plan · 只读计划', 'acceptEdits · 自动接受修改'],
    'Claude 列自己的档位，标签用它自己的取值打头',
  );
  assert.equal(toggle.dataset.writes, 'false', '默认落在最保守的一档');

  fx.pickTuning('mode', 'acceptEdits');
  await flush();
  assert.equal(toggle.dataset.writes, 'true', '会改文件的档要有视觉重量');

  composer.value = '改点东西';
  fire(fx.el('conversation-send'), 'click');
  await flush();
  const run = fx.startedRuns().pop();
  assert.equal(run.mode, 'acceptEdits');
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();

  fx.handoffTo('grok');
  await flush();
  fx.openTuning('mode');
  assert.deepEqual(
    fx.el('conversation-tuning-panel').childNodes
      .filter(node => node.dataset.optionId)
      .map(node => node.childNodes[0].childNodes[0].textContent),
    ['plan · 只读计划'],
    '交接给 Grok 后只剩 Grok 有的档',
  );
});

test('换助手时旧的模式表立刻失效，不会把别家的档位发出去', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();
  const toggle = fx.el('conversation-tuning-toggle');

  fx.pickAssistant('claude');
  await flush();
  fx.pickTuning('mode', 'acceptEdits');
  await flush();
  assert.equal(toggle.dataset.writes, 'true');

  // 换到 Grok：异步请求还没回来时，旧表就必须已经不可选了
  fx.pickAssistant('grok');
  assert.equal(toggle.dataset.writes, 'false', '旧助手的写入档不得留在按钮上');
  assert.equal(fx.tuningRows().includes('mode'), false, '请求未回来时没有模式可选');

  await flush();
  fx.openTuning('mode');
  assert.deepEqual(fx.tuningOptions(), ['plan'], '只剩 Grok 有的档');
  fx.el('conversation-composer').value = '你好';
  fire(fx.el('conversation-send'), 'click');
  await flush();
  assert.equal(fx.startedRuns().pop().mode, '', '发出去的绝不能是别家的模式 ID');
});

test('对话一开始就锁定助手，要换人只能走交接', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();
  const badge = fx.el('conversation-assistant-badge');
  const handoff = fx.el('conversation-handoff');
  assert.equal(badge.disabled, false, '还没开始时可以挑助手');
  assert.equal(badge.dataset.locked, 'false');
  assert.equal(handoff.hidden, true, '没开始就没有交接可言');

  await fx.send('第一句');
  const run = fx.startedRuns()[0];
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'thread', data: { threadId: 'sess-1' } });
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();

  assert.equal(badge.disabled, true, '开启之后助手锁定');
  assert.equal(badge.dataset.locked, 'true');
  assert.match(badge.title, /开始后不再更换/);
  assert.equal(handoff.hidden, false, '这时才给交接入口');

  fire(handoff, 'click');
  const list = fx.el('conversation-assistant-list');
  const offered = list.childNodes.map(node => node.dataset.tool);
  assert.ok(!offered.includes(run.providerId), '交接目标里不该有自己');
  assert.match(fx.el('conversation-assistant-hint').textContent, /新开一条对话/);

  fire(list.childNodes[0], 'click');
  await flush();
  assert.equal(fx.el('conversation-handoff-note').hidden, false, '选完目标要出交接说明');
});

test('模型、推理强度、模式收在同一个入口，会话模式不用打命令', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude'], t });
  await flush();
  fx.setSlashLists({
    models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }],
    efforts: [{ id: 'high', label: 'high' }, { id: 'low', label: 'low' }],
  });
  fx.pickAssistant('claude');
  await flush();

  assert.deepEqual(fx.tuningRows(), ['model', 'effort', 'mode'], '三样都在同一个入口里');
  const summary = fx.el('conversation-tuning-summary');
  assert.equal(summary.textContent, '只读计划', '没选过的项不占位，不显示「默认」');

  fx.pickTuning('model', 'opus');
  await flush();
  assert.equal(summary.textContent, 'opus · 只读计划');

  fx.pickTuning('effort', 'high');
  await flush();
  assert.equal(summary.textContent, 'opus · high · 只读计划');

  fx.el('conversation-composer').value = '跑一下';
  fire(fx.el('conversation-send'), 'click');
  await flush();
  const run = fx.startedRuns().pop();
  assert.equal(run.model, 'opus', '选中的模型要真的带到下一轮');
  assert.equal(run.effort, 'high');
});

test('点开分节不会被"点外面收起"误关，点面板外才收起', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude'], t });
  await flush();
  fx.setSlashLists({ models: [{ id: 'opus', label: 'opus' }], efforts: [] });
  fx.pickAssistant('claude');
  await flush();

  const panel = fx.el('conversation-tuning-panel');
  fx.clickWithBubble(fx.el('conversation-tuning-toggle'));
  assert.equal(panel.hidden, false, '点按钮要打开');

  const modelRow = panel.childNodes.find(node => node.dataset.section === 'model');
  fx.clickWithBubble(modelRow);
  assert.equal(panel.hidden, false, '点分节后面板必须还开着');
  assert.deepEqual(
    panel.childNodes.filter(node => node.dataset.optionId !== undefined)
      .map(node => node.dataset.optionId),
    ['', 'opus'],
    '应展示该分节的取值',
  );

  // 点面板以外的地方才收起
  fx.clickWithBubble(fx.el('conversation-composer'));
  assert.equal(panel.hidden, true);
});

test('摘要不跟着异步列表变形状，只反映选过的值', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude'], t });
  await flush();
  const summary = fx.el('conversation-tuning-summary');

  // 模型/强度列表还没回来（空表）时的形状
  fx.setSlashLists({ models: [], efforts: [] });
  fx.pickAssistant('claude');
  await flush();
  const before = summary.textContent;
  assert.equal(before, '只读计划');
  assert.doesNotMatch(before, /默认/);

  // 列表回来了，但用户一个都没选——形状必须不变
  fx.setSlashLists({ models: [{ id: 'opus', label: 'opus' }], efforts: [{ id: 'high', label: 'high' }] });
  fx.pickAssistant('claude');
  await flush();
  assert.equal(summary.textContent, before, '列表到位不该改变摘要');
  assert.deepEqual(fx.tuningRows(), ['model', 'effort', 'mode'], '但面板里该有这三行');
});

test('额度接近上限才抢注意力，打满时发送前就说清楚', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude'], t });
  await flush();
  const usage = fx.el('conversation-usage');

  fx.pickAssistant('claude');
  await flush();
  assert.equal(usage.dataset.level, 'ok');
  assert.doesNotMatch(usage.textContent, /重置/, '平时不啰嗦重置时间');
  assert.doesNotMatch(fx.el('conversation-composer-hint').textContent, /额度/);

  // 打满：侧栏转红并带出重置时间，发送区提前说明
  fx.setUsage({
    ok: true,
    fiveHour: { utilization: 100, resetsAt: new Date(Date.now() + 40 * 60000).toISOString() },
    sevenDay: { utilization: 20 },
  });
  await fx.send('先跑一轮');
  const run = fx.startedRuns().pop();
  fx.emit({ runId: run.runId, providerId: run.providerId, kind: 'completed', data: { status: 'completed' } });
  await flush();
  assert.equal(usage.dataset.level, 'blocked');
  assert.match(usage.textContent, /后重置/);
  assert.match(
    fx.el('conversation-composer-hint').textContent,
    /5 小时额度已用满/,
    '按下发送之前就该看见',
  );
  assert.match(fx.el('conversation-assistant-badge').title, /额度：/, '额度挂在助手身上');

  // 刚查过就聚焦输入框不该再查一次：要新鲜，但不能变成轮询
  const queries = fx.invokes.filter(entry => entry.command === 'oauth_usage').length;
  fire(fx.el('conversation-composer'), 'focus');
  await flush();
  assert.equal(
    fx.invokes.filter(entry => entry.command === 'oauth_usage').length,
    queries,
    '一分钟内重复聚焦不重复查询',
  );
});

test('额度带助手归属，换到没有额度接口的助手立刻清掉', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'grok'], t });
  await flush();
  const usage = fx.el('conversation-usage');

  fx.pickAssistant('claude');
  await flush();
  assert.equal(usage.hidden, false);
  assert.equal(usage.textContent, '5 小时 32% · 7 天 7%');

  // Grok 没有额度接口：绝不能把 Claude 的数字留在它的徽标旁
  fx.pickAssistant('grok');
  await flush();
  assert.equal(usage.hidden, true, '换到没有额度接口的助手就该消失');
  assert.equal(usage.textContent, '');
  assert.doesNotMatch(fx.el('conversation-assistant-badge').title, /额度/);
});

test('切项目后自动续接换了助手，额度不能留着上一家的', async t => {
  // 只有项目 B 有历史，这样项目 A 那边可以先挑 Claude
  const history = path => (path.endsWith('/b')
    ? { groups: [{ tool: 'grok', label: 'Grok', sessions: [{ id: 'g1', title: 'Grok 的会话', atMs: 500 }] }] }
    : { groups: [] });
  const fx = fixture({
    projects: [project('a', '项目 A'), project('b', '项目 B')],
    installed: ['claude', 'grok'],
    history,
    t,
  });
  await flush();
  const usage = fx.el('conversation-usage');

  fx.pickAssistant('claude');
  await flush();
  assert.equal(usage.textContent, '5 小时 32% · 7 天 7%', 'Claude 有额度');

  // 切到另一个项目，最近一条历史是 Grok 的，会自动续接并换掉助手
  fx.clickProject('b');
  await flush();
  assert.equal(fx.el('conversation-assistant-name').textContent, 'Grok');
  assert.equal(usage.hidden, true, '换成 Grok 后不能还挂着 Claude 的数字');
  assert.equal(usage.textContent, '');
});

test('换助手的瞬间旧额度立刻消失，不等新请求回来', async t => {
  const fx = fixture({ projects: [project('a', '项目 A')], installed: ['claude', 'codex'], t });
  await flush();
  const usage = fx.el('conversation-usage');

  fx.pickAssistant('claude');
  await flush();
  assert.equal(usage.textContent, '5 小时 32% · 7 天 7%');

  // 故意不 flush：Codex 的额度请求还在路上，这一瞬间绝不能还挂着 Claude 的数字
  fx.pickAssistant('codex');
  assert.equal(usage.hidden, true, '请求未回来时就该清空，而不是留着上一家的');
  assert.equal(usage.textContent, '');
});
