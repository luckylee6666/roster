import test from 'node:test';
import assert from 'node:assert/strict';
import { installConversationMode } from '../src/conversation-mode.js';
import { APP_VIEW_STORAGE_KEY } from '../src/app-shell-utils.js';

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.options = [];
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(node) {
    this.children.push(node);
    if (this.tagName === 'SELECT') this.options.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) {
    this.children = [...nodes];
    this.options = this.tagName === 'SELECT' ? [...nodes] : [];
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
}

function flush(times = 12) {
  return Promise.resolve().then(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

function preference(storage) {
  return JSON.parse(storage.getItem(APP_VIEW_STORAGE_KEY) || '{}');
}

function fixture({ history, composerValue = '' } = {}) {
  const byId = new Map();
  const ensure = id => {
    if (!byId.has(id)) byId.set(id, new FakeEl());
    return byId.get(id);
  };
  [
    'conversation-history-list',
    'conversation-history-state',
    'conversation-composer',
    'conversation-new-chat',
    'conversation-mode-select',
    'conversation-assistant-overlay',
    'conversation-assistant-list',
    'conversation-assistant-title',
    'conversation-assistant-hint',
  ].forEach(ensure);
  ensure('conversation-composer').value = composerValue;

  const previews = [];
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  const document = {
    getElementById: id => (byId.has(id) ? byId.get(id) : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
  };
  const controller = installConversationMode({
    document,
    storage,
    invoke: async (command, payload) => {
      if (command === 'preview_conversation_transcript') {
        previews.push(payload);
        return {
          messages: [
            { role: 'user', text: '上次的问题' },
            { role: 'assistant', text: '上次的回答', tool: payload.sourceTool },
          ],
        };
      }
      if (command === 'project_context') return { context: { branch: 'main' } };
      if (command === 'conversation_mode_list') return [];
      throw new Error(command);
    },
    loadHistory: async () => history,
  });

  controller.setInstalledCliIds(['claude', 'grok', 'codex']);

  return {
    controller,
    previews,
    storage,
    composer: ensure('conversation-composer'),
    newChat: ensure('conversation-new-chat'),
    assistantList: ensure('conversation-assistant-list'),
  };
}

const project = { id: 'p1', name: 'Roster', localPath: '/Users/lucky/git/roster' };
const mixedHistory = {
  groups: [
    {
      tool: 'codex',
      label: 'Codex',
      sessions: [{ id: 'codex-old', title: '旧 Codex', atMs: 100 }],
    },
    {
      tool: 'grok',
      label: 'Grok',
      sessions: [{ id: 'grok-new', title: '最近 Grok', atMs: 300 }],
    },
  ],
};

test('进入项目自动打开最近一条 CLI 历史，没有历史才保持空白新对话', async () => {
  const resumed = fixture({ history: mixedHistory });
  resumed.controller.setProjects([project]);
  await flush();
  assert.deepEqual(resumed.previews, [{
    projectId: project.id,
    sourceTool: 'grok',
    id: 'grok-new',
  }]);
  assert.equal(preference(resumed.storage).providerId, 'grok');
  assert.equal(resumed.newChat.hidden, false);
  resumed.controller.destroy();

  const empty = fixture({ history: { groups: [] } });
  empty.controller.setProjects([project]);
  await flush();
  assert.equal(empty.previews.length, 0);
  assert.equal(empty.newChat.hidden, true);
  empty.controller.destroy();
});

test('输入框已有草稿或点了新对话时，不会把自动续接盖上去', async () => {
  const drafted = fixture({ history: mixedHistory, composerValue: '继续刚才的思路' });
  drafted.controller.setProjects([project]);
  await flush();
  assert.equal(drafted.previews.length, 0);
  drafted.controller.destroy();

  const fresh = fixture({ history: mixedHistory });
  fresh.controller.setProjects([project]);
  await flush();
  assert.equal(fresh.previews.length, 1);
  // 新对话先问用哪个助手，选中之后才真的开一条空白对话。
  fresh.newChat.listeners.click();
  await flush();
  assert.ok(fresh.assistantList.children.length > 0, '应先弹出助手选择');
  assert.equal(fresh.newChat.hidden, false, '还没选之前不算开了新对话');
  fresh.assistantList.children[0].listeners.click();
  await flush();
  assert.equal(fresh.previews.length, 1);
  assert.equal(fresh.newChat.hidden, true);
  fresh.controller.destroy();
});
