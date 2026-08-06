import assert from 'node:assert/strict';
import test from 'node:test';

import { installWorkspaceMode } from '../src/workspace-mode.js';

class FakeClassList {
  constructor(owner, initial = '') {
    this.owner = owner;
    this.values = new Set(String(initial).split(/\s+/).filter(Boolean));
  }

  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeStyle {
  setProperty(name, value) { this[name] = value; }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    const payload = {
      button: 0,
      preventDefault() {},
      stopPropagation() {},
      target: this,
      ...event,
    };
    return Array.from(this.listeners.get(type) || [], listener => listener(payload));
  }
}

class FakeElement extends FakeEventTarget {
  constructor(id = '', className = '') {
    super();
    this.id = id;
    this.nodeType = 1;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this, className);
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.disabled = false;
    this.focusCount = 0;
    this.resetCount = 0;
  }

  set className(value) { this.classList = new FakeClassList(this, value); }
  get className() { return [...this.classList.values].join(' '); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() {
    this.focusCount += 1;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  reset() { this.resetCount += 1; }
  matches(selector) { return selector === '.term-diy' && this.classList.contains('term-diy'); }
  closest(selector) { return selector.includes(`.${this.className}`) ? this : null; }
  getBoundingClientRect() { return { left: 600, top: 100, width: 500, height: 600 }; }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.body = new FakeElement('body');
    this.body.ownerDocument = this;
    this.activeElement = this.body;
    this.elements = new Map();
    this.modeOptions = ['normal', 'relax', 'entertainment'].map(mode => {
      const option = new FakeElement('', 'workspace-mode-option');
      option.ownerDocument = this;
      option.dataset.mode = mode;
      return option;
    });
  }

  add(id, className = '') {
    const element = new FakeElement(id, className);
    element.ownerDocument = this;
    this.elements.set(id, element);
    return element;
  }

  getElementById(id) { return this.elements.get(id) || null; }
  createElement() {
    const element = new FakeElement();
    element.ownerDocument = this;
    return element;
  }

  querySelectorAll(selector) {
    if (selector === '.workspace-mode-option') return this.modeOptions;
    if (selector === '.modal-mask, .term-diy') {
      return [...this.elements.values()].filter(element => element.classList.contains('modal-mask'));
    }
    return [];
  }
}

class FakeObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeWebview {
  static instances = [];

  constructor() {
    this.available = true;
    this.created = false;
    this.url = null;
    this.calls = [];
    this.nextHide = null;
    this.nextCloseError = null;
    FakeWebview.instances.push(this);
  }

  deferNextHide() {
    this.nextHide = deferred();
    return this.nextHide;
  }

  async create(url, bounds) {
    this.calls.push(['create', url, bounds]);
    this.created = true;
    this.url = url;
  }

  async setPosition(position) { this.calls.push(['setPosition', position]); }
  async setSize(size) { this.calls.push(['setSize', size]); }
  async show() { this.calls.push(['show']); }

  async hide() {
    this.calls.push(['hide']);
    const pending = this.nextHide;
    this.nextHide = null;
    if (pending) await pending.promise;
  }

  async close() {
    this.calls.push(['close']);
    if (this.nextCloseError) {
      const error = this.nextCloseError;
      this.nextCloseError = null;
      throw error;
    }
    this.created = false;
    this.url = null;
  }
}

const REQUIRED_IDS = [
  'workspace-mode-btn',
  'workspace-mode-label',
  'workspace-mode-menu',
  'companion-splitter',
  'companion-panel',
  'companion-game-select',
  'companion-game-hint',
  'companion-site-select',
  'companion-add-site',
  'companion-remove-site',
  'companion-refresh',
  'companion-open-browser',
  'companion-return-terminal',
  'companion-close',
  'companion-webview-slot',
  'companion-web-placeholder',
  'companion-web-status',
  'companion-empty-add-site',
  'companion-game-surface',
  'companion-site-modal',
  'companion-site-modal-close',
  'companion-site-cancel',
  'companion-site-form',
  'companion-site-name',
  'companion-site-url',
  'companion-site-submit',
];

async function withWorkspaceHarness(run, {
  initialSettings = {
    mode: 'relax',
    companionWidth: 42,
    sites: [{ id: 'example', name: '示例', url: 'https://example.com/' }],
    activeSiteId: 'example',
    activeGameId: 'tetris',
  },
  storedState,
  stored: providedStored,
  gameCatalog: providedGameCatalog,
} = {}) {
  const originalMutationObserver = globalThis.MutationObserver;
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.MutationObserver = FakeObserver;
  globalThis.ResizeObserver = FakeObserver;
  FakeWebview.instances = [];

  const document = new FakeDocument();
  REQUIRED_IDS.forEach(id => document.add(id, id === 'companion-site-modal' ? 'modal-mask' : ''));
  const dock = new FakeElement('terminal-dock');
  dock.classList.add('active');
  const terminalMain = new FakeElement('terminal-main');
  const frames = new Map();
  let nextFrameId = 0;
  let nativeFocusHandler = null;
  const stored = providedStored || new Map();
  if (storedState !== undefined) {
    stored.set('workspace-mode-settings-v2', JSON.stringify(storedState));
  } else if (!stored.has('workspace-mode-settings-v2')) {
    stored.set('workspace-mode-settings-v2', JSON.stringify(initialSettings));
  }
  const window = new FakeEventTarget();
  Object.assign(window, {
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    __TAURI__: {
      window: {
        getCurrentWindow: () => ({
          onFocusChanged(callback) {
            nativeFocusHandler = callback;
            return () => { nativeFocusHandler = null; };
          },
        }),
      },
    },
  });

  const createWorkspaceGame = () => {
    const state = { mounted: 0, paused: 0, resumed: 0, destroyed: 0, host: null };
    return {
      state,
      mount(host) { state.mounted += 1; state.host = host; },
      pause() { state.paused += 1; },
      resume() { state.resumed += 1; },
      destroy() { state.destroyed += 1; },
      getState() { return { ...state }; },
    };
  };
  const games = { tetris: createWorkspaceGame(), '2048': createWorkspaceGame() };
  const gameCatalog = providedGameCatalog || [
    { id: 'tetris', name: '俄罗斯方块', hint: '方向键 / 空格', factory: () => games.tetris },
    { id: '2048', name: '2048', hint: '方向键 / 滑动', factory: () => games['2048'] },
  ];
  const controller = installWorkspaceMode({
    documentRef: document,
    windowRef: window,
    dock,
    terminalMain,
    WebviewClass: FakeWebview,
    gameCatalog,
  });
  const webview = FakeWebview.instances[0];

  async function settle() {
    for (let pass = 0; pass < 8; pass += 1) {
      await Promise.resolve();
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback());
    }
    await new Promise(resolve => setImmediate(resolve));
  }

  try {
    await settle();
    await run({
      controller,
      document,
      dock,
      games,
      emitNativeFocus(focused) { nativeFocusHandler?.({ payload: focused }); },
      settle,
      stored,
      webview,
    });
  } finally {
    controller.destroy();
    await settle();
    if (originalMutationObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = originalMutationObserver;
    if (originalResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = originalResizeObserver;
  }
}

function countCalls(webview, method) {
  return webview.calls.filter(([name]) => name === method).length;
}

test('普通与轻松模式初始化只渲染游戏选择状态，首次进入娱乐模式才创建游戏', async () => {
  for (const initialMode of ['normal', 'relax']) {
    await withWorkspaceHarness(async ({ controller, document, games, settle }) => {
      const select = document.getElementById('companion-game-select');
      assert.equal(games.tetris.state.mounted, 0, `${initialMode} 初始化不得创建俄罗斯方块`);
      assert.equal(games['2048'].state.mounted, 0, `${initialMode} 初始化不得创建 2048`);
      assert.deepEqual(select.children.map(option => option.value), ['tetris', '2048']);
      assert.equal(select.value, 'tetris');
      assert.equal(document.getElementById('companion-game-hint').textContent, '方向键 / 空格');
      assert.equal(controller.settings.activeGameId, 'tetris');

      await controller.applyMode('entertainment');
      await settle();
      assert.equal(games.tetris.state.mounted, 1);
      assert.equal(games.tetris.state.resumed, 1);
      assert.equal(games['2048'].state.mounted, 0);

      await controller.applyMode('normal');
      await controller.applyMode('entertainment');
      await settle();
      assert.equal(games.tetris.state.mounted, 1, '重复进入不得重新 mount');
      assert.equal(games['2048'].state.mounted, 0);
    }, {
      initialSettings: {
        mode: initialMode,
        companionWidth: 42,
        sites: [{ id: 'example', name: '示例', url: 'https://example.com/' }],
        activeSiteId: 'example',
        activeGameId: 'tetris',
      },
    });
  }
});

test('娱乐模式首次选择俄罗斯方块并持久化后续选择', async () => {
  const stored = new Map();
  await withWorkspaceHarness(async ({ controller, document, settle }) => {
    await controller.applyMode('entertainment');
    await settle();
    const select = document.getElementById('companion-game-select');
    assert.equal(select.value, 'tetris');
    select.value = '2048';
    select.dispatch('change');
    await settle();
    assert.equal(controller.settings.activeGameId, '2048');
    assert.equal(JSON.parse(stored.get('workspace-mode-settings-v2')).activeGameId, '2048');
  }, { stored });

  await withWorkspaceHarness(async ({ controller, document }) => {
    assert.equal(controller.settings.activeGameId, '2048');
    assert.equal(document.getElementById('companion-game-select').value, '2048');
    assert.equal(document.getElementById('companion-game-hint').textContent, '方向键 / 滑动');
  }, { stored });
});

test('游戏选择器按目录顺序渲染、更新提示并聚焦独立的当前宿主', async () => {
  await withWorkspaceHarness(async ({ document, games, settle }) => {
    const select = document.getElementById('companion-game-select');
    assert.deepEqual(select.children.map(option => [option.value, option.textContent]), [
      ['tetris', '俄罗斯方块'],
      ['2048', '2048'],
    ]);
    assert.equal(document.getElementById('companion-game-hint').textContent, '方向键 / 空格');
    assert.notEqual(games.tetris, games['2048']);
    assert.equal(games.tetris.state.mounted, 0);
    assert.equal(games['2048'].state.mounted, 0);

    select.value = '2048';
    select.dispatch('change');
    await settle();

    assert.equal(document.getElementById('companion-game-hint').textContent, '方向键 / 滑动');
    assert.equal(games['2048'].state.host.focusCount, 1);
    assert.equal(games.tetris.state.host, null);
    assert.equal(games.tetris.state.mounted, 0);
    assert.equal(games['2048'].state.host.dataset.active, 'true');
    assert.equal(games['2048'].state.mounted, 1);
    assert.equal(games['2048'].state.resumed, 0, '轻松模式切换选择不得恢复游戏');
  });
});

test('娱乐模式切换游戏只恢复新游戏一次', async () => {
  await withWorkspaceHarness(async ({ controller, document, games, settle }) => {
    await controller.applyMode('entertainment');
    await settle();
    assert.equal(games.tetris.state.resumed, 1);

    const select = document.getElementById('companion-game-select');
    select.value = '2048';
    select.dispatch('change');
    await settle();

    assert.equal(games['2048'].state.resumed, 1);
  });
});

test('非法或缺失游戏设置回退到默认目录首项', async () => {
  for (const activeGameId of ['missing', undefined]) {
    await withWorkspaceHarness(async ({ controller, document }) => {
      assert.equal(controller.settings.activeGameId, 'tetris');
      assert.equal(document.getElementById('companion-game-select').value, 'tetris');
      assert.equal(document.getElementById('companion-game-hint').textContent, '方向键 / 空格');
    }, {
      initialSettings: {
        mode: 'relax', companionWidth: 42,
        sites: [{ id: 'example', name: '示例', url: 'https://example.com/' }],
        activeSiteId: 'example', activeGameId,
      },
    });
  }
});

test('自定义目录只有 2048 时非法设置回退到实际首项', async () => {
  const game2048 = { mount() {}, pause() {}, resume() {}, destroy() {}, getState() { return {}; } };
  await withWorkspaceHarness(async ({ controller, document }) => {
    const select = document.getElementById('companion-game-select');
    assert.equal(controller.settings.activeGameId, '2048');
    assert.equal(select.value, '2048');
    assert.deepEqual(select.children.map(option => option.value), ['2048']);
    assert.equal(document.getElementById('companion-game-hint').textContent, '方向键 / 滑动');
  }, {
    initialSettings: { mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'missing' },
    gameCatalog: [{ id: '2048', name: '2048', hint: '方向键 / 滑动', factory: () => game2048 }],
  });
});

test('工作区忽略未知游戏 ID 并按传入顺序去重已知游戏', async () => {
  const makeGame = () => ({ mount() {}, pause() {}, resume() {}, destroy() {}, getState() { return {}; } });
  await withWorkspaceHarness(async ({ controller, document }) => {
    const select = document.getElementById('companion-game-select');
    assert.deepEqual(select.children.map(option => option.value), ['2048', 'tetris']);
    assert.equal(select.value, '2048');
    assert.equal(controller.settings.activeGameId, '2048');
    assert.equal(document.getElementById('companion-game-hint').textContent, 'known 2048');
  }, {
    initialSettings: { mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: '2048' },
    gameCatalog: [
      { id: 'snake', name: 'Snake', hint: 'unknown', factory: makeGame },
      { id: '2048', name: '2048', hint: 'known 2048', factory: makeGame },
      { id: 'pong', name: 'Pong', hint: 'unknown', factory: makeGame },
      { id: 'tetris', name: '俄罗斯方块', hint: 'known tetris', factory: makeGame },
      { id: '2048', name: '重复 2048', hint: 'duplicate', factory: makeGame },
    ],
  });
});

test('空游戏目录保持选择器、设置和提示一致且生命周期安全', async () => {
  await withWorkspaceHarness(async ({ controller, document }) => {
    const select = document.getElementById('companion-game-select');
    assert.equal(controller.settings.activeGameId, null);
    assert.equal(select.value, '');
    assert.equal(select.disabled, true);
    assert.deepEqual(select.children, []);
    assert.equal(document.getElementById('companion-game-hint').textContent, '');
    await controller.applyMode('entertainment');
    controller.setDockOpen(false);
    controller.setDockOpen(true);
  }, {
    initialSettings: { mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'missing' },
    gameCatalog: [],
  });
});

test('空站点可安全初始化轻松模式且不会创建 WebView', async () => {
  await withWorkspaceHarness(async ({ controller, document, webview }) => {
    assert.deepEqual(controller.settings.sites, []);
    assert.equal(controller.settings.activeSiteId, null);
    assert.equal(countCalls(webview, 'create'), 0);
    assert.equal(document.getElementById('companion-site-select').disabled, true);
    assert.equal(document.getElementById('companion-remove-site').disabled, true);
    assert.equal(document.getElementById('companion-refresh').disabled, true);
    assert.equal(document.getElementById('companion-open-browser').disabled, true);
    assert.equal(document.getElementById('companion-web-status').textContent, '还没有网页');
  }, {
    initialSettings: {
      mode: 'relax',
      companionWidth: 42,
      sites: [],
      activeSiteId: null,
      activeGameId: 'tetris',
    },
  });
});

test('轻松模式无网址时显示可添加的空状态且不创建 WebView', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    await controller.applyMode('relax');
    await settle();

    assert.equal(controller.settings.sites.length, 0);
    assert.equal(countCalls(webview, 'create'), 0);
    assert.equal(document.getElementById('companion-web-status').textContent, '还没有网页');
    assert.equal(document.getElementById('companion-site-select').disabled, true);
    assert.equal(document.getElementById('companion-remove-site').disabled, true);
    assert.equal(document.getElementById('companion-refresh').disabled, true);
    assert.equal(document.getElementById('companion-open-browser').disabled, true);
    assert.equal(document.getElementById('companion-empty-add-site').disabled, false);
  }, {
    storedState: {
      mode: 'normal', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'tetris',
    },
  });
});

test('空状态入口添加首个 HTTPS 网址后创建 WebView，无效提交不离开空状态', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    const emptyAdd = document.getElementById('companion-empty-add-site');
    emptyAdd.dispatch('click');
    await settle();
    assert.equal(document.getElementById('companion-site-modal').classList.contains('active'), true);

    document.getElementById('companion-site-url').value = 'http://example.com';
    document.getElementById('companion-site-form').dispatch('submit');
    await settle();
    assert.deepEqual(controller.settings.sites, []);
    assert.equal(countCalls(webview, 'create'), 0);
    assert.equal(document.getElementById('companion-site-modal').classList.contains('active'), true);

    document.getElementById('companion-site-url').value = 'https://example.com';
    document.getElementById('companion-site-form').dispatch('submit');
    await settle();
    assert.equal(controller.settings.sites.length, 1);
    assert.equal(controller.settings.activeSiteId, controller.settings.sites[0].id);
    assert.equal(document.getElementById('companion-site-select').disabled, false);
    assert.equal(countCalls(webview, 'create'), 1);
  }, {
    storedState: {
      mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'tetris',
    },
  });
});

test('删除最后一个用户网址会关闭 WebView、持久化空数组并回到空状态', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, stored, webview }) => {
    document.getElementById('companion-remove-site').dispatch('click');
    await settle();

    assert.equal(controller.settings.activeSiteId, null);
    assert.deepEqual(controller.settings.sites, []);
    assert.deepEqual(JSON.parse(stored.get('workspace-mode-settings-v2')).sites, []);
    assert.equal(countCalls(webview, 'close'), 1);
    assert.equal(document.getElementById('companion-web-status').textContent, '还没有网页');
    assert.equal(document.getElementById('companion-empty-add-site').disabled, false);
  });
});

test('删除当前网址后切换到剩余网址并只保留一个正确 WebView', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    document.getElementById('companion-site-select').value = 'first';
    document.getElementById('companion-site-select').dispatch('change');
    await settle();
    document.getElementById('companion-remove-site').dispatch('click');
    await settle();

    assert.deepEqual(controller.settings.sites.map(site => site.id), ['second']);
    assert.equal(controller.settings.activeSiteId, 'second');
    assert.equal(webview.url, 'https://second.example/');
    assert.equal(webview.created, true);
  }, {
    storedState: {
      mode: 'relax',
      companionWidth: 42,
      sites: [
        { id: 'first', name: '第一个', url: 'https://first.example/' },
        { id: 'second', name: '第二个', url: 'https://second.example/' },
      ],
      activeSiteId: 'second',
      activeGameId: 'tetris',
    },
  });
});

test('删除中间网址选择后一项并持久化，同时关闭旧 WebView 后打开新网址', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, stored, webview }) => {
    document.getElementById('companion-remove-site').dispatch('click');
    await settle();

    assert.deepEqual(controller.settings.sites.map(site => site.id), ['aaa', 'ccc']);
    assert.equal(controller.settings.activeSiteId, 'ccc');
    assert.equal(document.getElementById('companion-site-select').value, 'ccc');
    assert.equal(JSON.parse(stored.get('workspace-mode-settings-v2')).activeSiteId, 'ccc');
    assert.equal(countCalls(webview, 'close'), 1);
    assert.equal(countCalls(webview, 'create'), 2);
    assert.equal(webview.url, 'https://c.example/');
  }, {
    storedState: {
      mode: 'relax', companionWidth: 42,
      sites: [
        { id: 'aaa', name: 'A', url: 'https://a.example/' },
        { id: 'bbb', name: 'B', url: 'https://b.example/' },
        { id: 'ccc', name: 'C', url: 'https://c.example/' },
      ],
      activeSiteId: 'bbb', activeGameId: 'tetris',
    },
  });
});

test('删除列表最后一个网址时选择前一项', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, stored, webview }) => {
    document.getElementById('companion-remove-site').dispatch('click');
    await settle();

    assert.deepEqual(controller.settings.sites.map(site => site.id), ['aaa', 'bbb']);
    assert.equal(controller.settings.activeSiteId, 'bbb');
    assert.equal(document.getElementById('companion-site-select').value, 'bbb');
    assert.equal(JSON.parse(stored.get('workspace-mode-settings-v2')).activeSiteId, 'bbb');
    assert.equal(countCalls(webview, 'close'), 1);
    assert.equal(webview.url, 'https://b.example/');
  }, {
    storedState: {
      mode: 'relax', companionWidth: 42,
      sites: [
        { id: 'aaa', name: 'A', url: 'https://a.example/' },
        { id: 'bbb', name: 'B', url: 'https://b.example/' },
        { id: 'ccc', name: 'C', url: 'https://c.example/' },
      ],
      activeSiteId: 'ccc', activeGameId: 'tetris',
    },
  });
});

test('添加网页弹窗取消后分别恢复工具栏和空态触发按钮焦点', async () => {
  for (const { triggerId, storedState } of [
    {
      triggerId: 'companion-add-site',
      storedState: {
        mode: 'relax', companionWidth: 42,
        sites: [{ id: 'aaa', name: 'A', url: 'https://a.example/' }],
        activeSiteId: 'aaa', activeGameId: 'tetris',
      },
    },
    {
      triggerId: 'companion-empty-add-site',
      storedState: {
        mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'tetris',
      },
    },
  ]) {
    await withWorkspaceHarness(async ({ document, settle }) => {
      const trigger = document.getElementById(triggerId);
      trigger.focus();
      trigger.dispatch('click');
      await settle();
      assert.equal(document.activeElement, document.getElementById('companion-site-name'));

      document.getElementById('companion-site-cancel').dispatch('click');
      await settle();
      assert.equal(document.activeElement, trigger);
    }, { storedState });
  }
});

test('从空态成功添加网页后把焦点移到已启用的站点选择器', async () => {
  await withWorkspaceHarness(async ({ document, settle }) => {
    const emptyAdd = document.getElementById('companion-empty-add-site');
    emptyAdd.focus();
    emptyAdd.dispatch('click');
    await settle();

    document.getElementById('companion-site-url').value = 'https://example.com';
    document.getElementById('companion-site-form').dispatch('submit');
    await settle();

    const siteSelect = document.getElementById('companion-site-select');
    assert.equal(siteSelect.disabled, false);
    assert.equal(document.activeElement, siteSelect);
    assert.equal(document.getElementById('companion-site-modal').classList.contains('active'), false);
  }, {
    storedState: {
      mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'tetris',
    },
  });
});

test('添加网页弹窗按 Escape 关闭并分别恢复工具栏和空态触发点', async () => {
  for (const { triggerId, storedState } of [
    {
      triggerId: 'companion-add-site',
      storedState: {
        mode: 'relax', companionWidth: 42,
        sites: [{ id: 'aaa', name: 'A', url: 'https://a.example/' }],
        activeSiteId: 'aaa', activeGameId: 'tetris',
      },
    },
    {
      triggerId: 'companion-empty-add-site',
      storedState: {
        mode: 'relax', companionWidth: 42, sites: [], activeSiteId: null, activeGameId: 'tetris',
      },
    },
  ]) {
    await withWorkspaceHarness(async ({ document, settle }) => {
      const trigger = document.getElementById(triggerId);
      trigger.focus();
      trigger.dispatch('click');
      await settle();

      let prevented = false;
      document.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
      await settle();

      assert.equal(prevented, true);
      assert.equal(document.getElementById('companion-site-modal').classList.contains('active'), false);
      assert.equal(document.activeElement, trigger);
    }, { storedState });
  }
});

test('添加网页弹窗用 Tab 环绕焦点并把意外的外部焦点带回弹窗', async () => {
  await withWorkspaceHarness(async ({ document, settle }) => {
    const close = document.getElementById('companion-site-modal-close');
    const name = document.getElementById('companion-site-name');
    const url = document.getElementById('companion-site-url');
    const submit = document.getElementById('companion-site-submit');

    document.getElementById('companion-add-site').dispatch('click');
    await settle();
    assert.equal(document.activeElement, name);

    submit.focus();
    let tabPrevented = false;
    document.dispatch('keydown', { key: 'Tab', preventDefault() { tabPrevented = true; } });
    assert.equal(tabPrevented, true);
    assert.equal(document.activeElement, close);

    let shiftTabPrevented = false;
    document.dispatch('keydown', {
      key: 'Tab', shiftKey: true, preventDefault() { shiftTabPrevented = true; },
    });
    assert.equal(shiftTabPrevented, true);
    assert.equal(document.activeElement, submit);

    document.body.focus();
    let outsidePrevented = false;
    document.dispatch('keydown', { key: 'Tab', preventDefault() { outsidePrevented = true; } });
    assert.equal(outsidePrevented, true);
    assert.equal(document.activeElement, close);

    url.focus();
    let internalPrevented = false;
    document.dispatch('keydown', { key: 'Tab', preventDefault() { internalPrevented = true; } });
    assert.equal(internalPrevented, false);
    assert.equal(document.activeElement, url, 'fake DOM 不模拟浏览器默认 Tab，但控制器不得拦截');
  });
});

test('添加网页弹窗未激活时不拦截 Escape 或 Tab', async () => {
  await withWorkspaceHarness(async ({ document }) => {
    document.body.focus();
    let escapePrevented = false;
    document.dispatch('keydown', { key: 'Escape', preventDefault() { escapePrevented = true; } });
    let tabPrevented = false;
    document.dispatch('keydown', { key: 'Tab', preventDefault() { tabPrevented = true; } });

    assert.equal(escapePrevented, false);
    assert.equal(tabPrevented, false);
    assert.equal(document.activeElement, document.body);
  });
});

test('页面隐藏与原生窗口失焦只隐藏 WebView，恢复时复用同一实例', async () => {
  await withWorkspaceHarness(async ({ controller, document, emitNativeFocus, settle, webview }) => {
    assert.equal(countCalls(webview, 'create'), 1);
    assert.equal(webview.created, true);

    document.hidden = true;
    document.dispatch('visibilitychange');
    await settle();
    assert.equal(countCalls(webview, 'hide') >= 1, true);
    assert.equal(countCalls(webview, 'close'), 0);
    assert.equal(webview.created, true);

    document.hidden = false;
    document.dispatch('visibilitychange');
    await settle();
    assert.equal(countCalls(webview, 'create'), 1);
    assert.equal(countCalls(webview, 'show') >= 2, true);

    const hidesBeforeBlur = countCalls(webview, 'hide');
    emitNativeFocus(false);
    await settle();
    assert.equal(countCalls(webview, 'hide'), hidesBeforeBlur + 1);
    assert.equal(countCalls(webview, 'close'), 0);

    emitNativeFocus(true);
    await settle();
    assert.equal(countCalls(webview, 'create'), 1);
    assert.equal(webview.created, true);

    controller.setDockOpen(false);
    await settle();
    assert.equal(countCalls(webview, 'close'), 1);
  });
});

test('原生关闭失败时会隐藏并保留 WebView，重新进入轻松模式可继续复用', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    const createsBefore = countCalls(webview, 'create');
    webview.nextCloseError = new Error('native close failed');
    await controller.applyMode('normal');
    await settle();

    assert.equal(webview.created, true, '关闭失败后应保留原生句柄');
    assert.equal(countCalls(webview, 'hide') >= 1, true, '关闭失败后必须隐藏残留 WebView');
    assert.match(document.getElementById('companion-web-status').textContent, /关闭失败/);

    await controller.applyMode('relax');
    await settle();
    assert.equal(countCalls(webview, 'create'), createsBefore, '返回轻松模式应复用原实例');
    assert.equal(webview.created, true);
  });
});

test('添加网页弹窗等待原生 WebView 隐藏，并忽略快速关闭后的旧打开任务', async () => {
  await withWorkspaceHarness(async ({ document, settle, webview }) => {
    const modal = document.getElementById('companion-site-modal');
    const addButton = document.getElementById('companion-add-site');
    const cancelButton = document.getElementById('companion-site-cancel');

    const firstHide = webview.deferNextHide();
    addButton.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(countCalls(webview, 'hide') >= 1, true);
    assert.equal(modal.classList.contains('active'), false, 'hide 完成前不能显示 DOM 弹窗');

    firstHide.resolve();
    await settle();
    assert.equal(modal.classList.contains('active'), true);

    cancelButton.dispatch('click');
    await settle();
    assert.equal(modal.classList.contains('active'), false);

    const secondHide = webview.deferNextHide();
    addButton.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    cancelButton.dispatch('click');
    secondHide.resolve();
    await settle();
    assert.equal(modal.classList.contains('active'), false, '旧 revision 不得重新打开已关闭弹窗');
    assert.equal(countCalls(webview, 'create'), 1);
  });
});

test('受控 overlay 的打开 Promise 在 WebView 隐藏后才完成，快速关闭会使旧 revision 失效', async () => {
  await withWorkspaceHarness(async ({ controller, settle, webview }) => {
    const firstHide = webview.deferNextHide();
    let opened = false;
    const opening = controller.setOverlayOpen(true).then(result => {
      opened = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(opened, false);

    firstHide.resolve();
    assert.equal(await opening, true);
    await controller.setOverlayOpen(false);
    await settle();

    const secondHide = webview.deferNextHide();
    const staleOpening = controller.setOverlayOpen(true);
    const closing = controller.setOverlayOpen(false);
    secondHide.resolve();
    assert.equal(await staleOpening, false);
    assert.equal(await closing, true);
    await settle();
    assert.equal(countCalls(webview, 'create'), 1);
    assert.equal(webview.created, true);
  });
});

test('延迟排队的网页刷新会在执行前重新检查浮层状态', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    const refresh = document.getElementById('companion-refresh');
    const createsBefore = countCalls(webview, 'create');

    refresh.dispatch('click');
    assert.equal(await controller.setOverlayOpen(true), true);
    await settle();
    assert.equal(countCalls(webview, 'create'), createsBefore, '受控 overlay 打开后不得重建 WebView');
    await controller.setOverlayOpen(false);
    await settle();

    refresh.dispatch('click');
    assert.equal(await controller.setFloatingUiOpen('test-floating-menu', true), true);
    await settle();
    assert.equal(countCalls(webview, 'create'), createsBefore, '浮层菜单打开后不得重建 WebView');
    await controller.setFloatingUiOpen('test-floating-menu', false);
    await settle();
  });
});

test('添加网页弹窗异步打开期间切换模式、收起 Dock 或销毁均会使任务失效', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    const modal = document.getElementById('companion-site-modal');
    const addButton = document.getElementById('companion-add-site');

    const modeHide = webview.deferNextHide();
    addButton.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    await controller.applyMode('normal');
    modeHide.resolve();
    await settle();
    assert.equal(modal.classList.contains('active'), false, '切出轻松模式后旧任务不得显示弹窗');

    await controller.applyMode('relax');
    await settle();
    const dockHide = webview.deferNextHide();
    addButton.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    controller.setDockOpen(false);
    dockHide.resolve();
    await settle();
    assert.equal(modal.classList.contains('active'), false, 'Dock 收起后旧任务不得显示弹窗');

    controller.setDockOpen(true);
    await settle();
    const destroyHide = webview.deferNextHide();
    addButton.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    controller.destroy();
    destroyHide.resolve();
    await settle();
    assert.equal(modal.classList.contains('active'), false, '销毁后旧任务不得显示弹窗');
  });
});

test('分隔条仅在隐藏成功后进入拖拽，并安全处理失败与快速取消', async () => {
  await withWorkspaceHarness(async ({ document, dock, settle, webview }) => {
    const splitter = document.getElementById('companion-splitter');

    const delayedHide = webview.deferNextHide();
    splitter.dispatch('mousedown', { clientX: 700 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(dock.classList.contains('is-companion-resizing'), false);
    assert.notEqual(document.body.style.userSelect, 'none');
    delayedHide.resolve();
    await settle();
    assert.equal(dock.classList.contains('is-companion-resizing'), true);
    assert.equal(document.body.style.userSelect, 'none');
    document.dispatch('mouseup');
    await settle();
    assert.equal(dock.classList.contains('is-companion-resizing'), false);

    const failedHide = webview.deferNextHide();
    splitter.dispatch('mousedown', { clientX: 710 });
    await Promise.resolve();
    await Promise.resolve();
    failedHide.reject(new Error('hide failed'));
    await settle();
    assert.equal(dock.classList.contains('is-companion-resizing'), false, 'hide 失败不得进入拖拽');
    assert.match(document.getElementById('companion-web-status').textContent, /无法隐藏/);

    const staleHide = webview.deferNextHide();
    splitter.dispatch('mousedown', { clientX: 720 });
    await Promise.resolve();
    await Promise.resolve();
    document.dispatch('pointercancel');
    const currentHide = webview.deferNextHide();
    splitter.dispatch('mousedown', { clientX: 730 });
    await Promise.resolve();
    await Promise.resolve();
    staleHide.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(dock.classList.contains('is-companion-resizing'), false, '旧 revision 完成时不得启动新拖拽');
    currentHide.resolve();
    await settle();
    assert.equal(dock.classList.contains('is-companion-resizing'), true, '当前 revision 隐藏成功后应进入拖拽');
    document.dispatch('mouseup');
    await settle();
    assert.equal(dock.classList.contains('is-companion-resizing'), false);
  });
});
