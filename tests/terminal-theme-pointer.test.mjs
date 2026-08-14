import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installThemePointer,
  normalizeThemePointer,
} from '../src/terminal-theme-pointer.js';

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { names.forEach(name => this.names.add(name)); }
  remove(...names) { names.forEach(name => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
}

class FakeStyle {
  constructor() { this.properties = new Map(); }
  setProperty(name, value) { this.properties.set(name, value); }
  getPropertyValue(name) { return this.properties.get(name) || ''; }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = {}) {
    this.listeners.get(type)?.forEach(listener => listener(event));
  }
}

class FakeElement extends FakeEventTarget {
  constructor() {
    super();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = new FakeStyle();
    this.children = [];
    this.removed = false;
    this.innerHTML = '';
    this.className = '';
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(name, value) { this[name] = value; }
  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.body = new FakeElement();
  }
  createElement() { return new FakeElement(); }
}

class FakeWindow extends FakeEventTarget {
  constructor(reducedMotion = false) {
    super();
    this.reducedMotion = reducedMotion;
  }
  requestAnimationFrame(callback) { callback(); return 1; }
  matchMedia() { return { matches: this.reducedMotion }; }
}

const normalTarget = { closest: () => null };
const resizeTarget = { closest: selector => selector.includes('.terminal-resize') ? {} : null };
const companionTarget = { closest: selector => selector.includes('.companion-panel') ? {} : null };
const sessionRailTarget = { closest: selector => selector.includes('.session-rail-splitter') ? {} : null };

test('动态鼠标仅接受内置主题白名单', () => {
  assert.equal(normalizeThemePointer('sakura'), 'sakura');
  assert.equal(normalizeThemePointer('neon-rain'), 'neon-rain');
  assert.equal(normalizeThemePointer('guofeng'), 'guofeng');
  assert.equal(normalizeThemePointer('custom-html'), '');
  assert.equal(normalizeThemePointer(''), '');
});

test('国风鼠标按帧定位、生成主题轨迹并为 resize 恢复系统光标', () => {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const dock = new FakeElement();
  let time = 100;
  const controller = installThemePointer(dock, {
    document,
    window,
    now: () => time,
    random: () => 0.5,
    setTimeout: () => {},
  });
  const pointer = document.body.children[0];

  controller.applyTheme({ cursor: 'guofeng', clickFx: true, effect: 'guofeng' });
  assert.equal(dock.dataset.cursorFx, 'guofeng');
  assert.equal(pointer.dataset.theme, 'guofeng');

  dock.dispatch('pointermove', {
    pointerType: 'mouse', clientX: 120, clientY: 88, target: normalTarget,
  });
  assert.equal(dock.classList.contains('is-theme-pointer-active'), true);
  assert.equal(pointer.classList.contains('is-visible'), true);
  assert.equal(pointer.style.getPropertyValue('--theme-pointer-x'), '120px');
  assert.equal(pointer.style.getPropertyValue('--theme-pointer-y'), '88px');
  assert.equal(document.body.children[1].className, 'theme-pointer-trail theme-pointer-trail-guofeng');

  dock.dispatch('pointermove', {
    pointerType: 'mouse', clientX: 130, clientY: 90, target: resizeTarget,
  });
  assert.equal(dock.classList.contains('is-theme-pointer-active'), false);
  assert.equal(pointer.classList.contains('is-visible'), false);

  dock.dispatch('pointermove', {
    pointerType: 'pen', clientX: 132, clientY: 92, target: normalTarget,
  });
  assert.equal(dock.classList.contains('is-theme-pointer-active'), false);
  assert.equal(pointer.classList.contains('is-visible'), false);

  const beforeCompanion = document.body.children.length;
  dock.dispatch('pointermove', {
    pointerType: 'mouse', clientX: 600, clientY: 92, target: companionTarget,
  });
  dock.dispatch('pointerdown', {
    pointerType: 'mouse', button: 0, clientX: 600, clientY: 92, target: companionTarget,
  });
  assert.equal(dock.classList.contains('is-theme-pointer-active'), false);
  assert.equal(pointer.classList.contains('is-visible'), false);
  assert.equal(document.body.children.length, beforeCompanion);

  const beforeClick = document.body.children.length;
  dock.dispatch('pointerdown', {
    pointerType: 'mouse', button: 0, clientX: 130, clientY: 90, target: normalTarget,
  });
  assert.equal(document.body.children.length, beforeClick + 5);
  assert.match(document.body.children.at(-1).className, /term-fx-guofeng/);

  time += 100;
  controller.applyTheme({ cursor: 'unknown', clickFx: false });
  assert.equal(dock.dataset.cursorFx, undefined);
  assert.equal(pointer.dataset.theme, undefined);

  controller.destroy();
  assert.equal(dock.dataset.cursorFx, undefined);
  assert.equal(dock.classList.contains('is-theme-pointer-active'), false);
  assert.equal(pointer.removed, true);
});

test('减少动态效果时保留静态指针但不生成轨迹和点击粒子', () => {
  const document = new FakeDocument();
  const window = new FakeWindow(true);
  const dock = new FakeElement();
  const controller = installThemePointer(dock, {
    document,
    window,
    now: () => 100,
    random: () => 0.5,
    setTimeout: () => {},
  });

  controller.applyTheme({ cursor: 'sakura', clickFx: true, effect: 'sakura' });
  dock.dispatch('pointermove', {
    pointerType: 'mouse', clientX: 20, clientY: 30, target: normalTarget,
  });
  dock.dispatch('pointerdown', {
    pointerType: 'mouse', button: 0, clientX: 20, clientY: 30, target: normalTarget,
  });

  assert.equal(document.body.children.length, 1);
  assert.equal(document.body.children[0].classList.contains('is-visible'), true);
  controller.destroy();
});

test('拖会话条高度时恢复系统光标', () => {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const dock = new FakeElement();
  const controller = installThemePointer(dock, {
    document,
    window,
    now: () => 100,
    random: () => 0.5,
    setTimeout: () => {},
  });
  controller.applyTheme({ cursor: 'sakura', clickFx: false, effect: 'sakura' });
  dock.dispatch('pointermove', {
    pointerType: 'mouse', clientX: 40, clientY: 80, target: sessionRailTarget,
  });
  assert.equal(dock.classList.contains('is-theme-pointer-active'), false);
  assert.equal(document.body.children[0].classList.contains('is-visible'), false);
  dock.classList.add('is-session-rail-resizing');
  dock.dispatch('pointermove', {
    pointerType: 'mouse', clientX: 42, clientY: 90, target: normalTarget,
  });
  assert.equal(dock.classList.contains('is-theme-pointer-active'), false);
  controller.destroy();
});
