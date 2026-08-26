import test from 'node:test';
import assert from 'node:assert/strict';
import { installAppShell } from '../src/app-shell.js';
import { APP_VIEW_STORAGE_KEY } from '../src/app-shell-utils.js';

class FakeClassList {
  values = new Set();
  toggle(name, active) {
    if (active) this.values.add(name);
    else this.values.delete(name);
  }
}

class FakeElement {
  constructor(focusTarget = null) {
    this.hidden = false;
    this.inert = false;
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.focusTarget = focusTarget;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelector(selector) {
    return selector === '[data-app-view-focus]' ? this.focusTarget : null;
  }
}

function fixture() {
  const conversationFocus = { calls: 0, focus() { this.calls += 1; } };
  const developerFocus = { calls: 0, focus() { this.calls += 1; } };
  const conversation = new FakeElement(conversationFocus);
  const developer = new FakeElement(developerFocus);
  const overlays = new FakeElement();
  const toConversation = new FakeElement();
  toConversation.dataset.appViewTarget = 'conversation';
  const toDeveloper = new FakeElement();
  toDeveloper.dataset.appViewTarget = 'developer';
  const byId = new Map([
    ['conversation-surface', conversation],
    ['development-surface', developer],
    ['development-overlays', overlays],
  ]);
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll(selector) {
      return selector === '[data-app-view-target]' ? [toConversation, toDeveloper] : [];
    },
  };
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  return {
    conversation,
    conversationFocus,
    developer,
    developerFocus,
    document,
    overlays,
    storage,
    values,
  };
}

test('应用壳初始只暴露当前工作台，并同步 hidden、inert 与 aria-hidden', () => {
  const ui = fixture();
  const shell = installAppShell({
    document: ui.document,
    storage: ui.storage,
    initialView: 'conversation',
  });
  assert.equal(shell.view, 'conversation');
  assert.equal(ui.conversation.hidden, false);
  assert.equal(ui.conversation.inert, false);
  assert.equal(ui.conversation.attributes.get('aria-hidden'), 'false');
  assert.equal(ui.developer.hidden, true);
  assert.equal(ui.developer.inert, true);
  assert.equal(ui.overlays.hidden, true);
});

test('切换前置钩子拒绝时不改变视图，也不写入偏好', async () => {
  const ui = fixture();
  const notices = [];
  const shell = installAppShell({
    document: ui.document,
    storage: ui.storage,
    initialView: 'conversation',
    beforeDeveloper: async () => false,
    notify: message => notices.push(message),
  });
  assert.equal(await shell.setView('developer'), false);
  assert.equal(shell.view, 'conversation');
  assert.equal(ui.values.has(APP_VIEW_STORAGE_KEY), false);
  assert.equal(ui.developer.hidden, true);
  assert.equal(notices.length, 1);
});

test('双向切换保存偏好，并把焦点放到已经显示的工作台', async () => {
  const ui = fixture();
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => callback();
  try {
    const shell = installAppShell({
      document: ui.document,
      storage: ui.storage,
      initialView: 'conversation',
      beforeDeveloper: async () => true,
      beforeConversation: async () => true,
    });
    assert.equal(await shell.setView('developer'), true);
    assert.equal(ui.developer.hidden, false);
    assert.equal(ui.developerFocus.calls, 1);
    assert.equal(JSON.parse(ui.values.get(APP_VIEW_STORAGE_KEY)).appView, 'developer');

    assert.equal(await shell.setView('conversation'), true);
    assert.equal(ui.conversation.hidden, false);
    assert.equal(ui.conversationFocus.calls, 1);
    assert.equal(JSON.parse(ui.values.get(APP_VIEW_STORAGE_KEY)).appView, 'conversation');
  } finally {
    globalThis.requestAnimationFrame = previousFrame;
  }
});

test('快速连续切换会按顺序完成，并以用户最后选择的工作台为准', async () => {
  const ui = fixture();
  let releaseDeveloper;
  const developerReady = new Promise(resolve => { releaseDeveloper = resolve; });
  const calls = [];
  const shell = installAppShell({
    document: ui.document,
    storage: ui.storage,
    initialView: 'conversation',
    beforeDeveloper: async () => {
      calls.push('show-developer');
      await developerReady;
      return true;
    },
    beforeConversation: async () => {
      calls.push('show-conversation');
      return true;
    },
  });

  const toDeveloper = shell.setView('developer', { focus: false });
  const backToConversation = shell.setView('conversation', { focus: false });
  await Promise.resolve();
  releaseDeveloper();

  assert.equal(await toDeveloper, true);
  assert.equal(await backToConversation, true);
  assert.equal(shell.view, 'conversation');
  assert.deepEqual(calls, ['show-developer', 'show-conversation']);
  assert.equal(ui.conversation.hidden, false);
  assert.equal(ui.developer.hidden, true);
});
