import test from 'node:test';
import assert from 'node:assert/strict';
import { installConversationMode, MAX_PARALLEL_CONVERSATION_RUNS } from '../src/conversation-mode.js';

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
}

const IDS = [
  'conversation-project-list',
  'conversation-history-list',
  'conversation-history-state',
  'conversation-new-chat',
  'conversation-project-name',
  'conversation-project-path',
  'conversation-provider-select',
  'conversation-status',
  'conversation-messages',
  'conversation-empty',
  'conversation-starter-list',
  'conversation-composer',
  'conversation-attachments',
  'conversation-write-access',
  'conversation-send',
  'conversation-stop',
  'conversation-composer-hint',
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

function fixture({ projects, installed = ['claude'], focused = true, appView, t } = {}) {
  const byId = new Map(IDS.map(id => [id, new FakeEl(id === 'conversation-provider-select' ? 'select' : 'div')]));
  const scroller = new FakeEl();
  scroller.appendChild(byId.get('conversation-messages'));

  const invokes = [];
  const toasts = [];
  const chatEvents = [];
  const values = new Map();
  const document = {
    hidden: false,
    hasFocus: () => focused,
    ...(appView ? { documentElement: { dataset: { appView } } } : {}),
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
  };
  let emit = () => {};
  const controller = installConversationMode({
    document,
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    invoke: async (command, payload) => {
      invokes.push({ command, payload });
      if (command === 'project_context') return { context: { exists: true, isRepo: false } };
      if (command === 'conversation_chat_start') return null;
      if (command === 'conversation_chat_cancel') return true;
      if (command === 'notify') return null;
      return null;
    },
    listen: async (_name, handler) => {
      emit = payload => handler({ payload });
      return () => {};
    },
    notify: (message, level) => toasts.push({ message, level }),
    loadHistory: async () => ({ groups: [] }),
    invalidateHistory: () => {},
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
