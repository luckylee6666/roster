import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { terminalSessionIdAtPoint, visibleTerminalSessionIds } from '../src/terminal-pane-layout.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const code = main.slice(main.indexOf('let treeDrag = null;'), main.indexOf('// ===== 文件树右键菜单'));

function fixture() {
  const nodes = [], targets = [], drops = [], docEvents = new Map(), winEvents = new Map(), timers = new Map();
  let seq = 0, visible = true;
  const classes = () => ({ toggle: (name, on) => targets.push({ name, on }) });
  const document = {
    hidden: false,
    body: { style: { userSelect: 'text' }, appendChild: node => nodes.push(node) },
    querySelectorAll: selector => selector === '.tree-drag-ghost' ? nodes.filter(node => !node.removed) : [],
    createElement: () => ({ style: {}, remove() { this.removed = true; } }),
    addEventListener: (name, fn) => { if (!docEvents.has(name)) docEvents.set(name, []); docEvents.get(name).push(fn); },
  };
  const window = { addEventListener: (name, fn) => { if (!winEvents.has(name)) winEvents.set(name, []); winEvents.get(name).push(fn); } };
  const bodyEl = { classList: classes(), getBoundingClientRect: () => ({ left: 100, right: 300, top: 0, bottom: 300 }) };
  const deps = {
    document, window, developerTerminalVisible: () => visible,
    sessions: new Map([['terminal', { bodyEl }]]), termEl: { dock: { classList: classes() } }, terminalPaneAssignments: ['terminal'],
    visibleTerminalSessionIds, terminalSessionIdAtPoint,
    activateSession: (_id, _force, callback) => callback(), insertPathToTerminal: (path, id) => drops.push({ path, id }),
    setTimeout: fn => { const id = ++seq; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  };
  const api = new Function(...Object.keys(deps), `${code}; return { startTreeDragWatch, cleanupTreeDrag, setupTreeDrag,
    consumeClick: () => { const value = treeDragSuppressClick; treeDragSuppressClick = false; return value; } };`)(...Object.values(deps));
  api.setupTreeDrag();
  const emit = (map, name, event = {}) => (map.get(name) || []).forEach(fn => fn(event));
  const start = (name = 'desk-pet') => api.startTreeDragWatch({ name, path: `/project/${name}` }, { button: 0, clientX: 0, clientY: 0 });
  return { ...api, document, nodes, targets, drops, timers, start,
    ghosts: () => nodes.filter(node => !node.removed), visible: value => { visible = value; },
    doc: (name, event) => emit(docEvents, name, event), win: (name, event) => emit(winEvents, name, event),
    move: (buttons = 1) => emit(docEvents, 'mousemove', { buttons, clientX: 150, clientY: 30 }),
  };
}

test('正常拖文件夹到终端只插入一次，结束后无标签/禁选/高亮残留', () => {
  const f = fixture(); f.start(); f.move();
  assert.equal(f.ghosts()[0].textContent, 'desk-pet');
  assert.equal(f.document.body.style.userSelect, 'none');
  const up = { clientX: 150, clientY: 30 };
  f.win('mouseup', up); f.doc('mouseup', up);
  f.win('focus');
  assert.deepEqual(f.drops, [{ path: '/project/desk-pet', id: 'terminal' }]);
  assert.equal(f.ghosts().length, 0);
  assert.equal(f.document.body.style.userSelect, 'text');
  assert.equal(f.timers.size, 0);
  assert.equal(f.consumeClick(), true);
  assert.equal(f.consumeClick(), false);
  f.start(); f.doc('mouseup', { clientX: 0, clientY: 0 });
  assert.equal(f.consumeClick(), false, '下一次普通点击不能受旧拖动影响');
});

test('新mousedown先移除旧ghost，抬起事件丢失后buttons=0也能取消且不插入', () => {
  const f = fixture(); f.start(); f.move();
  f.start('second');
  assert.equal(f.ghosts().length, 0, '不能在覆盖引用后遗留旧标签');
  f.move(); assert.equal(f.ghosts().length, 1);
  f.move(0);
  assert.equal(f.ghosts().length, 0);
  assert.deepEqual(f.drops, []);
  assert.equal(f.document.body.style.userSelect, 'text');
  assert.equal(f.consumeClick(), false);
});

for (const trigger of ['escape', 'blur', 'focus', 'pagehide', 'pointercancel', 'contextmenu', 'hidden', 'mouseleave', 'view-change', 'inactivity']) {
  test(`${trigger} 中止拖动并清理所有状态`, () => {
    const f = fixture(); f.start(); f.move();
    if (trigger === 'escape') f.doc('keydown', { key: 'Escape' });
    else if (['blur', 'focus', 'pagehide'].includes(trigger)) f.win(trigger);
    else if (trigger === 'hidden') { f.document.hidden = true; f.doc('visibilitychange'); }
    else if (trigger === 'view-change') { f.visible(false); f.move(); }
    else if (trigger === 'inactivity') [...f.timers.values()].forEach(fn => fn());
    else f.doc(trigger, {});
    assert.equal(f.ghosts().length, 0);
    assert.equal(f.document.body.style.userSelect, 'text');
    assert.equal(f.targets.at(-1).on, false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.consumeClick(), false);
    assert.deepEqual(f.drops, []);
  });
}

test('未达到拖拽阈值的普通点击不被抑制，孤立标签也可重复清除', () => {
  const f = fixture(); f.start(); f.doc('mouseup', { clientX: 0, clientY: 0 });
  assert.equal(f.consumeClick(), false);
  const ghost = f.document.createElement(); f.document.body.appendChild(ghost);
  f.cleanupTreeDrag(); f.cleanupTreeDrag();
  assert.equal(f.ghosts().length, 0);
});

test('树刷新/隐藏、终端折叠/关闭会中止自绘拖拽', () => {
  for (const name of ['renderTree(cwd)', 'toggleTree()', 'collapseDock()', 'closeSession(id)']) {
    const at = main.indexOf(`function ${name}`);
    assert.ok(at >= 0);
    assert.match(main.slice(at, at + 110), /cleanupTreeDrag\(\)/, name);
  }
});
