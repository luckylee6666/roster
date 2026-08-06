import assert from 'node:assert/strict';
import test from 'node:test';

class FakeClassList {
  constructor(owner, initial = '') {
    this.owner = owner;
    this.values = new Set(initial.split(/\s+/).filter(Boolean));
  }

  contains(value) {
    return this.values.has(value);
  }

  add(...values) {
    values.forEach(value => this.values.add(value));
  }

  remove(...values) {
    values.forEach(value => this.values.delete(value));
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : !!force;
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeStyle {
  setProperty(name, value) {
    this[name] = value;
  }

  removeProperty(name) {
    delete this[name];
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = new FakeStyle();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.offsetWidth = 1586;
    this.rect = { left: 0, top: 0, width: 1586, height: 992 };
  }

  set className(value) {
    this.classList = new FakeClassList(this, String(value));
  }

  get className() {
    return [...this.classList.values].join(' ');
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  querySelectorAll(selector) {
    const key = selector === '[data-feature]'
      ? 'feature'
      : selector === '[data-scene]'
        ? 'scene'
        : '';
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (key && child.dataset?.[key] !== undefined) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }
}

function createFakeTimers() {
  let now = 0;
  let sequence = 0;
  const scheduled = new Map();

  function setTimeout(callback, delay = 0) {
    const id = ++sequence;
    scheduled.set(id, { callback, due: now + Number(delay) });
    return id;
  }

  function clearTimeout(id) {
    scheduled.delete(id);
  }

  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      let nextId = 0;
      let nextTask = null;
      for (const [id, task] of scheduled) {
        if (task.due <= target && (!nextTask || task.due < nextTask.due)) {
          nextId = id;
          nextTask = task;
        }
      }
      if (!nextTask) break;
      now = nextTask.due;
      scheduled.delete(nextId);
      nextTask.callback();
    }
    now = target;
  }

  return { advance, clearTimeout, setTimeout };
}

async function withFakeBrowser({ failPattern = '', deferPattern = '' } = {}, run) {
  const original = new Map();
  for (const name of ['window', 'document', 'Image', 'ResizeObserver']) {
    original.set(name, globalThis[name]);
  }

  const timers = createFakeTimers();
  const deferredImageLoads = [];
  const resizeObservers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    hidden: false,
    createElement: tagName => new FakeElement(tagName),
    hasFocus: () => true,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: type => documentListeners.delete(type),
  };
  const mediaQuery = {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    ...timers,
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    removeEventListener: type => windowListeners.delete(type),
    matchMedia: () => mediaQuery,
    requestAnimationFrame: callback => timers.setTimeout(callback, 16),
    cancelAnimationFrame: id => timers.clearTimeout(id),
  };

  class FakeImage {
    set src(value) {
      const finish = () => {
        if (failPattern && value.includes(failPattern)) this.onerror?.();
        else this.onload?.();
      };
      if (deferPattern && value.includes(deferPattern)) deferredImageLoads.push(finish);
      else queueMicrotask(finish);
    }
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      resizeObservers.push(this);
    }

    observe() {}
    disconnect() {}
  }

  Object.assign(globalThis, { document, window, Image: FakeImage, ResizeObserver: FakeResizeObserver });
  try {
    await run({
      document,
      documentListeners,
      timers,
      windowListeners,
      triggerResize() {
        resizeObservers.forEach(observer => observer.callback());
      },
      releaseImages() {
        const pending = deferredImageLoads.splice(0);
        pending.forEach(finish => queueMicrotask(finish));
        return pending.length;
      },
    });
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

async function settleImagePreloads() {
  // FakeImage resolves from a microtask; drain the Image, Promise.all and
  // controller continuation queues at the next event-loop turn.
  await new Promise(resolve => setImmediate(resolve));
}

test('真实控制器会合并连续输出、保持待机原画像素锁定并在静默后结束坐姿 Coding', async () => {
  await withFakeBrowser({}, async ({ document, documentListeners, timers, triggerResize, windowListeners }) => {
    const { installTerminalCharacterTheme } = await import(
      `../src/terminal-theme-character.js?runtime=${Date.now()}`
    );
    const stage = new FakeElement();
    const dock = new FakeElement();
    dock.classList.add('active');
    const availability = [];
    const controller = installTerminalCharacterTheme(stage, dock, {
      onAvailabilityChange: ready => availability.push(ready),
    });

    assert.equal(controller.applyTheme('guofeng-beauty'), false);
    await settleImagePreloads();
    assert.equal(controller.isReady(), true);
    assert.deepEqual(availability, [true]);

    const scenes = stage.querySelectorAll('[data-scene]');
    const codingScene = scenes.find(layer => layer.dataset.scene === 'coding');
    const typingHands = stage.querySelectorAll('[data-feature]')
      .find(layer => layer.dataset.feature === 'typingHands');
    assert.equal(codingScene.style.backgroundSize, '100% 100%');
    assert.equal(typingHands.style.backgroundSize, '100% 100%');
    assert.notEqual(codingScene.style.width, typingHands.style.width);
    assert.notEqual(codingScene.style.height, typingHands.style.height);
    assert.ok(Number.parseFloat(codingScene.style.left) < Number.parseFloat(typingHands.style.left));
    assert.ok(Number.parseFloat(codingScene.style.top) < Number.parseFloat(typingHands.style.top));
    assert.equal(codingScene.style.backgroundImage, undefined);
    assert.equal(typingHands.style.backgroundImage, undefined);
    assert.equal(stage.dataset.characterState, 'idle');
    assert.equal(stage.querySelectorAll('[data-scene]').length, 1);

    const blink = stage.querySelectorAll('[data-feature]')
      .find(layer => layer.dataset.feature === 'blink');
    const initialBlinkLeft = Number.parseFloat(blink.style.left);
    stage.rect.width = 1040;
    dock.classList.add('has-companion');
    triggerResize();
    assert.ok(Number.parseFloat(blink.style.left) < initialBlinkLeft);
    assert.equal(blink.style.backgroundSize, '100% 100%');
    assert.ok(
      Math.abs(
        Number.parseFloat(codingScene.style.left)
        + Number.parseFloat(codingScene.style.width)
        - stage.rect.width,
      ) < 0.02,
      '分屏 Coding 贴片应锚定左侧 Coding 区的右边缘',
    );

    timers.advance(900);
    assert.equal(stage.classList.contains('is-blinking'), true);
    timers.advance(190);
    assert.equal(stage.classList.contains('is-blinking'), false);

    controller.handleTerminalEvent('output');
    assert.equal(stage.dataset.characterState, 'thinking');
    await settleImagePreloads();
    assert.match(codingScene.style.backgroundImage, /coding-a-right-patch-retina\.png/);
    assert.match(typingHands.style.backgroundImage, /coding-b-hands-patch-retina\.png/);
    const firstRevision = stage.dataset.stateRevision;
    timers.advance(2000);
    controller.handleTerminalEvent('output');
    assert.equal(stage.dataset.stateRevision, firstRevision);
    timers.advance(4199);
    assert.equal(stage.dataset.characterState, 'thinking');
    timers.advance(1);
    assert.equal(stage.dataset.characterState, 'idle');

    controller.setDockOpen(false);
    assert.equal(stage.classList.contains('is-animation-paused'), true);
    controller.setDockOpen(true);
    assert.equal(stage.classList.contains('is-animation-paused'), false);

    controller.handleTerminalEvent('output');
    controller.handleTerminalEvent('exit');
    assert.equal(stage.dataset.characterState, 'rest');
    timers.advance(4200);
    assert.equal(stage.dataset.characterState, 'rest');

    for (const state of ['success', 'error', 'greeting']) {
      controller.setState(state, 0);
      assert.equal(stage.dataset.characterState, state);
    }
    controller.setState('rest', 0);

    controller.setState('idle', 0);
    dock.listeners.get('pointerdown')({
      clientX: 1400,
      clientY: 300,
      target: { closest: selector => selector.includes('.companion-panel') ? {} : null },
    });
    assert.equal(stage.dataset.characterState, 'idle');

    windowListeners.get('blur')();
    assert.equal(stage.classList.contains('is-animation-paused'), true);
    windowListeners.get('focus')();
    assert.equal(stage.classList.contains('is-animation-paused'), false);
    document.hidden = true;
    documentListeners.get('visibilitychange')();
    assert.equal(stage.classList.contains('is-animation-paused'), true);
    document.hidden = false;
    documentListeners.get('visibilitychange')();
    assert.equal(stage.classList.contains('is-animation-paused'), false);

    controller.destroy();
    assert.equal(stage.children.length, 0);
    assert.equal(windowListeners.has('blur'), false);
    assert.equal(windowListeners.has('focus'), false);
    assert.equal(documentListeners.has('visibilitychange'), false);
  });
});

test('主题在素材预载完成前关闭时不会挂载过期人物场景', async () => {
  await withFakeBrowser({}, async () => {
    const { installTerminalCharacterTheme } = await import(
      `../src/terminal-theme-character.js?stale-load=${Date.now()}`
    );
    const stage = new FakeElement();
    const dock = new FakeElement();
    dock.classList.add('active');
    const controller = installTerminalCharacterTheme(stage, dock);

    controller.applyTheme('guofeng-beauty');
    controller.applyTheme('');
    await settleImagePreloads();
    assert.equal(controller.isReady(), false);
    assert.equal(stage.dataset.renderState, 'off');
    assert.equal(stage.children.length, 0);
    controller.destroy();
  });
});

test('终端输出早于待机素材挂载时仍会在挂载后懒加载 Coding 场景', async () => {
  await withFakeBrowser({}, async () => {
    const { installTerminalCharacterTheme } = await import(
      `../src/terminal-theme-character.js?early-output=${Date.now()}`
    );
    const stage = new FakeElement();
    const dock = new FakeElement();
    dock.classList.add('active');
    const controller = installTerminalCharacterTheme(stage, dock);

    controller.applyTheme('guofeng-beauty');
    controller.handleTerminalEvent('output');
    assert.equal(stage.dataset.characterState, 'thinking');
    await settleImagePreloads();

    assert.equal(controller.isReady(), true);
    assert.equal(stage.dataset.characterState, 'thinking');
    const codingScene = stage.querySelectorAll('[data-scene]')
      .find(layer => layer.dataset.scene === 'coding');
    assert.match(codingScene.style.backgroundImage, /coding-a-right-patch-retina\.png/);
    controller.destroy();
  });
});

test('Coding 素材加载中切走并切回主题时只允许当前场景接收结果', async () => {
  await withFakeBrowser(
    { deferPattern: 'term-bg-guofeng-beauty-coding-' },
    async ({ releaseImages }) => {
      const { installTerminalCharacterTheme } = await import(
        `../src/terminal-theme-character.js?coding-race=${Date.now()}`
      );
      const stage = new FakeElement();
      const dock = new FakeElement();
      dock.classList.add('active');
      const errors = [];
      const controller = installTerminalCharacterTheme(stage, dock, {
        onError: error => errors.push(error.message),
      });

      controller.applyTheme('guofeng-beauty');
      await settleImagePreloads();
      assert.equal(controller.isReady(), true, '首次主题素材应完成挂载');
      controller.handleTerminalEvent('output');
      controller.applyTheme('');
      controller.applyTheme('guofeng-beauty');
      await settleImagePreloads();
      assert.equal(
        controller.isReady(),
        true,
        `重新启用主题后应就绪：${JSON.stringify(stage.dataset)}`,
      );
      controller.handleTerminalEvent('output');
      assert.equal(stage.dataset.codingAssets, 'loading');

      assert.equal(releaseImages(), 2);
      await settleImagePreloads();
      assert.equal(controller.isReady(), true);
      assert.deepEqual(errors, []);
      assert.equal(stage.dataset.codingAssets, 'ready');
      const codingScene = stage.querySelectorAll('[data-scene]')
        .find(layer => layer.dataset.scene === 'coding');
      assert.match(codingScene.style.backgroundImage, /coding-a-right-patch-retina\.png/);
      controller.destroy();
    },
  );
});

test('任一 Coding 素材预载失败时控制器保留静态主题回退', async () => {
  await withFakeBrowser({ failPattern: 'coding-b-hands-patch-retina.png' }, async () => {
    const { installTerminalCharacterTheme } = await import(
      `../src/terminal-theme-character.js?fallback=${Date.now()}`
    );
    const stage = new FakeElement();
    const dock = new FakeElement();
    dock.classList.add('active');
    const errors = [];
    const controller = installTerminalCharacterTheme(stage, dock, {
      onError: error => errors.push(error.message),
    });

    controller.applyTheme('guofeng-beauty');
    await settleImagePreloads();
    assert.equal(controller.isReady(), true);
    controller.handleTerminalEvent('output');
    await settleImagePreloads();
    assert.equal(controller.isReady(), false);
    assert.equal(stage.dataset.renderState, 'fallback');
    assert.equal(dock.classList.contains('character-theme-fallback'), true);
    assert.match(errors[0], /键盘敲击素材加载失败/);
    controller.destroy();
  });
});
