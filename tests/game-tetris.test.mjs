import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TETRIS_COLUMNS,
  TETRIS_ROWS,
  TETROMINO_TYPES,
  clearCompletedLines,
  createEmptyTetrisBoard,
  createSevenBag,
  dropIntervalForLevel,
  scoreForLines,
} from '../src/games/tetris-engine.js';
import { createTetrisEngine } from '../src/games/tetris-engine.js';
import { createTetrisGame } from '../src/games/game-tetris.js';

function createFakeDocument() {
  class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...values) { values.forEach(value => this.values.add(value)); }
    remove(...values) { values.forEach(value => this.values.delete(value)); }
    toggle(value, force) {
      const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
      if (enabled) this.values.add(value); else this.values.delete(value);
      return enabled;
    }
    contains(value) { return this.values.has(value); }
  }

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.classList = new FakeClassList();
      this.dataset = {};
      this.listeners = new Map();
      this.attributes = new Map();
      this.textContent = '';
      this.disabled = false;
      this.tabIndex = -1;
    }
    set className(value) {
      this.classList = new FakeClassList();
      String(value).split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name));
    }
    get className() { return [...this.classList.values].join(' '); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    dispatchEvent(event) {
      if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
      this.listeners.get(event.type)?.(event);
      return !event.defaultPrevented;
    }
    focus() { this.focused = true; }
  }

  return { createElement(tagName) { return new FakeElement(tagName); } };
}

function createControlledTimers() {
  const pending = new Map();
  const callbacks = new Map();
  let nextTimer = 0;
  return {
    pending,
    setTimeoutFn(callback, delay) {
      const id = ++nextTimer;
      const timer = { callback, delay };
      pending.set(id, timer);
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutFn(id) { pending.delete(id); },
    fire(id) { callbacks.get(id)?.(); },
  };
}

function findAll(root, predicate) {
  const matches = predicate(root) ? [root] : [];
  return root.children.reduce((result, child) => result.concat(findAll(child, predicate)), matches);
}

function findByClass(root, className) {
  return findAll(root, element => element.classList.contains(className))[0];
}

function dispatchKey(target, key) {
  const event = { type: 'keydown', key, defaultPrevented: false };
  target.dispatchEvent(event);
  return event;
}

function createDomGame(options = {}) {
  const documentRef = createFakeDocument();
  const host = documentRef.createElement('div');
  const timers = createControlledTimers();
  const game = createTetrisGame({
    documentRef,
    random: () => 0,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...options,
  });
  game.mount(host);
  return { documentRef, game, host, timers };
}

test('已清理的旧 timeout 回调不会推进状态或替换当前 timer', () => {
  const { game, host, timers } = createDomGame();
  game.resume();
  const [oldTimerId] = timers.pending.keys();
  dispatchKey(host, 'ArrowLeft');
  const [currentTimerId] = timers.pending.keys();
  const beforeLateCallback = game.getState();

  assert.notEqual(currentTimerId, oldTimerId);
  timers.fire(oldTimerId);

  assert.deepEqual(game.getState(), beforeLateCallback);
  assert.deepEqual([...timers.pending.keys()], [currentTimerId]);
});

test('当前有效 timeout 会下落一行并用新 timer 接续自动推进', () => {
  const { game, timers } = createDomGame();
  game.resume();
  const [currentTimerId, currentTimer] = timers.pending.entries().next().value;
  const initialRow = game.getState().current.row;
  assert.equal(currentTimer.delay, 800);

  timers.fire(currentTimerId);

  assert.equal(game.getState().current.row, initialRow + 1);
  assert.equal(timers.pending.size, 1);
  const [nextTimerId, nextTimer] = timers.pending.entries().next().value;
  assert.notEqual(nextTimerId, currentTimerId);
  assert.equal(timers.pending.has(currentTimerId), false);
  assert.equal(nextTimer.delay, 800);
});

test('mount 渲染 200 个可访问棋盘格、统计、下一块和暂停状态', () => {
  const storage = { getItem: () => '12', setItem() {} };
  const { host } = createDomGame({ storage });
  const cells = findAll(host, element => element.attributes.get('role') === 'gridcell');
  const stats = findByClass(host, 'game-tetris__stats');
  const statValues = stats.children.map(stat => stat.children[0].textContent);

  assert.equal(host.attributes.get('role'), 'application');
  assert.match(host.attributes.get('aria-label'), /方向键.*空格.*P 键/);
  assert.equal(cells.length, 200);
  assert.equal(findByClass(host, 'game-tetris__next').textContent, 'Z');
  assert.deepEqual(statValues, ['0', '12', '0', '1']);
  assert.equal(findByClass(host, 'game-tetris__status').textContent, '已暂停');
});

test('键盘方向键、空格和 P 仅在宿主上阻止默认行为并改变真实状态', () => {
  const { documentRef, game, host, timers } = createDomGame();
  const unrelated = documentRef.createElement('div');
  const initial = game.getState();
  const unrelatedEvent = dispatchKey(unrelated, 'ArrowLeft');
  assert.equal(unrelatedEvent.defaultPrevented, false);
  assert.deepEqual(game.getState(), initial);

  game.resume();
  const leftEvent = dispatchKey(host, 'ArrowLeft');
  assert.equal(leftEvent.defaultPrevented, true);
  assert.equal(game.getState().current.column, initial.current.column - 1);
  assert.equal(dispatchKey(host, 'ArrowUp').defaultPrevented, true);
  assert.deepEqual(game.getState().current.matrix, [[1], [1], [1], [1]]);
  assert.equal(dispatchKey(host, 'ArrowRight').defaultPrevented, true);
  assert.equal(game.getState().current.column, initial.current.column);
  assert.equal(dispatchKey(host, 'ArrowDown').defaultPrevented, true);
  assert.equal(game.getState().current.row, 1);
  assert.equal(game.getState().score, 1);
  assert.equal(dispatchKey(host, ' ').defaultPrevented, true);
  assert.equal(game.getState().current.serial, 2);

  assert.equal(dispatchKey(host, 'p').defaultPrevented, true);
  assert.equal(game.getState().paused, true);
  assert.equal(timers.pending.size, 0);
  assert.equal(dispatchKey(host, 'P').defaultPrevented, true);
  assert.equal(game.getState().paused, false);
  assert.equal(timers.pending.size, 1);
});

test('五个屏幕动作按钮具有完整名称并通过统一动作路径改变状态', () => {
  const { game, host, timers } = createDomGame();
  game.resume();
  const controls = findByClass(host, 'game-tetris__controls');
  const actionButtons = controls.children.slice(0, 5);
  assert.deepEqual(actionButtons.map(button => button.attributes.get('aria-label')), ['向左', '旋转', '向右', '软降', '硬降']);

  actionButtons[0].dispatchEvent({ type: 'click' });
  assert.equal(game.getState().current.column, 2);
  actionButtons[1].dispatchEvent({ type: 'click' });
  assert.deepEqual(game.getState().current.matrix, [[1], [1], [1], [1]]);
  actionButtons[2].dispatchEvent({ type: 'click' });
  assert.equal(game.getState().current.column, 3);
  actionButtons[3].dispatchEvent({ type: 'click' });
  assert.equal(game.getState().current.row, 1);
  assert.equal(game.getState().score, 1);
  actionButtons[4].dispatchEvent({ type: 'click' });
  assert.equal(game.getState().current.serial, 2);
  assert.equal(timers.pending.size, 1);
});

test('restart 保持外部暂停或运行状态且始终至多调度一个 timer', () => {
  const { game, host, timers } = createDomGame();
  game.pause();
  const pausedRestart = game.restart();
  assert.equal(pausedRestart.paused, true);
  assert.equal(timers.pending.size, 0);

  game.resume();
  const [oldTimerId] = timers.pending.keys();
  dispatchKey(host, 'ArrowLeft');
  game.restart();
  const [currentTimerId] = timers.pending.keys();
  const runningRestart = game.getState();
  assert.equal(runningRestart.paused, false);
  assert.equal(timers.pending.size, 1);
  assert.notEqual(currentTimerId, oldTimerId);

  timers.fire(oldTimerId);
  assert.deepEqual(game.getState(), runningRestart);
  assert.deepEqual([...timers.pending.keys()], [currentTimerId]);
});

test('暂停和销毁后的迟到 callback 不推进状态也不遗留资源', () => {
  const { game, host, timers } = createDomGame();
  game.resume();
  const [pausedTimerId] = timers.pending.keys();
  game.pause();
  const pausedState = game.getState();
  timers.fire(pausedTimerId);
  assert.deepEqual(game.getState(), pausedState);
  assert.equal(timers.pending.size, 0);

  game.resume();
  const [destroyedTimerId] = timers.pending.keys();
  game.destroy();
  const destroyedState = game.getState();
  timers.fire(destroyedTimerId);
  assert.deepEqual(game.getState(), destroyedState);
  assert.equal(timers.pending.size, 0);
  assert.equal(host.children.length, 0);
  assert.equal(host.listeners.size, 0);
});

test('键盘与按钮到达 game over 后释放 timer 且后续输入不推进', () => {
  const { game, host, timers } = createDomGame();
  game.resume();
  for (let lock = 0; lock < 10; lock += 1) {
    assert.equal(dispatchKey(host, ' ').defaultPrevented, true);
  }
  assert.equal(game.getState().gameOver, false);
  const dropButton = findAll(host, element => element.attributes.get('aria-label') === '硬降')[0];
  dropButton.dispatchEvent({ type: 'click' });
  const gameOverState = game.getState();
  assert.equal(gameOverState.gameOver, true);
  assert.equal(timers.pending.size, 0);

  dispatchKey(host, 'ArrowLeft');
  findAll(host, element => element.attributes.get('aria-label') === '软降')[0].dispatchEvent({ type: 'click' });
  assert.deepEqual(game.getState(), gameOverState);
  assert.equal(timers.pending.size, 0);
});

test('最高分存储读取写入和全局 getter 异常均安全降级', () => {
  const throwingStorage = {
    getItem() { throw new Error('read denied'); },
    setItem() { throw new Error('write denied'); },
  };
  const throwingGame = createDomGame({ storage: throwingStorage });
  throwingGame.game.resume();
  assert.doesNotThrow(() => dispatchKey(throwingGame.host, 'ArrowDown'));
  assert.equal(throwingGame.game.getState().bestScore, 1);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('getter denied'); } });
    assert.doesNotThrow(() => createDomGame());
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('最高分变化只写入调用方指定的独立 storage key', () => {
  const values = new Map([['tetris-a', '7'], ['other-game', '99']]);
  const storage = {
    getItem(key) { return values.get(key); },
    setItem(key, value) { values.set(key, value); },
  };
  const { game, host } = createDomGame({ storage, storageKey: 'tetris-a' });
  assert.equal(game.getState().bestScore, 7);
  game.resume();
  dispatchKey(host, ' ');
  assert.equal(values.get('tetris-a'), '38');
  assert.equal(values.get('other-game'), '99');
});

test('重复 mount 与 destroy 清理旧宿主、监听、timer 和迟到 callback', () => {
  const { documentRef, game, host: firstHost, timers } = createDomGame();
  game.resume();
  const [firstTimerId] = timers.pending.keys();
  const secondHost = documentRef.createElement('div');
  game.mount(secondHost);
  assert.equal(firstHost.children.length, 0);
  assert.equal(firstHost.listeners.size, 0);
  assert.equal(timers.pending.size, 0);

  game.resume();
  const [secondTimerId] = timers.pending.keys();
  game.destroy();
  game.destroy();
  const destroyedState = game.getState();
  timers.fire(firstTimerId);
  timers.fire(secondTimerId);
  assert.deepEqual(game.getState(), destroyedState);
  assert.equal(timers.pending.size, 0);
  assert.equal(secondHost.children.length, 0);
  assert.equal(secondHost.listeners.size, 0);
});

function placeWithTicks(engine, [type, rotations, targetColumn]) {
  assert.equal(engine.getState().current.type, type);
  for (let turn = 0; turn < rotations; turn += 1) assert.equal(engine.rotate(), true);

  const offset = targetColumn - engine.getState().current.column;
  for (let move = 0; move < Math.abs(offset); move += 1) {
    assert.equal(engine.moveHorizontal(Math.sign(offset)), true);
  }

  const serial = engine.getState().current.serial;
  for (let tick = 0; tick <= TETRIS_ROWS; tick += 1) {
    assert.equal(engine.tick(), true);
    if (engine.getState().current.serial !== serial) return;
  }
  assert.fail(`方块 ${type} 未在 ${TETRIS_ROWS + 1} 次 tick 内锁定`);
}

test('俄罗斯方块棋盘为 10×20 且各行独立', () => {
  const board = createEmptyTetrisBoard();
  assert.equal(board.length, TETRIS_ROWS);
  assert.equal(board[0].length, TETRIS_COLUMNS);
  board[0][0] = 'I';
  assert.equal(board[1][0], 0);
});

test('七袋算法规范化越界和非有限随机值', () => {
  for (const randomValue of [1, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bag = createSevenBag(() => randomValue);
    assert.equal(bag.length, 7);
    assert.deepEqual([...bag].sort(), [...TETROMINO_TYPES].sort());
  }
});

test('七袋算法使用随机值洗牌且连续两袋各含七种方块', () => {
  const lowBag = createSevenBag(() => 0);
  const highBag = createSevenBag(() => 1);
  assert.deepEqual(lowBag, ['J', 'L', 'O', 'S', 'T', 'Z', 'I']);
  assert.deepEqual(highBag, [...TETROMINO_TYPES]);

  for (const bag of [createSevenBag(() => 0.25), createSevenBag(() => 0.75)]) {
    assert.deepEqual([...bag].sort(), [...TETROMINO_TYPES].sort());
  }
});

test('引擎可连续消耗返回异常值的随机源', () => {
  for (const randomValue of [1, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const engine = createTetrisEngine({ random: () => randomValue });
    const types = [];
    for (let drawIndex = 0; drawIndex < 8; drawIndex += 1) {
      types.push(engine.getState().current.type);
      engine.hardDrop();
    }
    assert.equal(types.every(type => TETROMINO_TYPES.includes(type)), true);
  }
});

test('消除完整行并在顶部补空行', () => {
  const board = createEmptyTetrisBoard();
  board[19] = Array(TETRIS_COLUMNS).fill('T');
  board[18][0] = 'I';
  const result = clearCompletedLines(board);
  assert.equal(result.lines, 1);
  assert.deepEqual(result.board[0], Array(TETRIS_COLUMNS).fill(0));
  assert.equal(result.board[19][0], 'I');
});

test('分数随消行数和等级增加，速度具有下限', () => {
  assert.equal(scoreForLines(1, 0), 100);
  assert.equal(scoreForLines(4, 2), 2400);
  assert.equal(dropIntervalForLevel(0), 800);
  assert.equal(dropIntervalForLevel(99), 100);
});

test('引擎锁定方块后消行并同步计分、行数和等级', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  const placements = [
    ['I', 0, 0], ['Z', 0, 0], ['T', 0, 0], ['S', 0, 0],
    ['O', 0, 4], ['L', 0, 0], ['J', 0, 0],
  ];
  for (const placement of placements) placeWithTicks(engine, placement);

  const beforeClear = engine.getState();
  assert.deepEqual(beforeClear.board[19], ['I', 'I', 'I', 'I', 'O', 'O', 0, 0, 0, 0]);
  assert.equal(beforeClear.score, 0);
  assert.equal(beforeClear.lines, 0);
  assert.equal(beforeClear.level, 0);

  placeWithTicks(engine, ['I', 0, 6]);
  const afterClear = engine.getState();
  assert.deepEqual(afterClear.board[19], [0, 'Z', 'Z', 0, 'O', 'O', 0, 0, 0, 0]);
  assert.equal(afterClear.score, 100);
  assert.equal(afterClear.lines, 1);
  assert.equal(afterClear.level, 0);
  assert.equal(afterClear.current.serial, 9);
});

test('累计消除十行后等级精确升至一级', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  const placements = [
    ['I', 0, 0], ['Z', 0, 3], ['T', 0, 0], ['S', 1, 5], ['O', 0, 7],
    ['L', 3, 8], ['J', 0, 2], ['I', 1, 0], ['Z', 0, 5], ['T', 1, 1],
    ['S', 0, 3], ['O', 0, 7], ['L', 3, 8], ['J', 2, 4], ['I', 1, 3],
    ['Z', 1, 7], ['T', 3, 1], ['S', 0, 5], ['O', 0, 2], ['L', 3, 8],
    ['J', 3, 8], ['I', 1, 4], ['Z', 1, 0], ['T', 1, 5], ['S', 1, 6],
    ['O', 0, 0], ['L', 0, 2], ['J', 3, 7], ['I', 1, 5],
  ];
  for (const placement of placements) placeWithTicks(engine, placement);

  const state = engine.getState();
  assert.equal(state.lines, 10);
  assert.equal(state.level, 1);
  assert.equal(state.score, 1100);
  assert.equal(state.gameOver, false);
  assert.equal(state.current.serial, 30);
  assert.equal(state.current.type, 'Z');
  assert.deepEqual(state.board[19], [0, 'Z', 'O', 'O', 'I', 'T', 'T', 'S', 'L', 'L']);
});

test('水平移动拒绝越过左右边界和已锁定方块', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  for (let move = 0; move < 3; move += 1) assert.equal(engine.moveHorizontal(-1), true);
  assert.equal(engine.getState().current.column, 0);
  const leftEdge = engine.getState();
  assert.equal(engine.moveHorizontal(-1), false);
  assert.deepEqual(engine.getState(), leftEdge);

  for (let move = 0; move < 6; move += 1) assert.equal(engine.moveHorizontal(1), true);
  assert.equal(engine.getState().current.column, 6);
  const rightEdge = engine.getState();
  assert.equal(engine.moveHorizontal(1), false);
  assert.deepEqual(engine.getState(), rightEdge);

  const collisionEngine = createTetrisEngine({ random: () => 0 });
  for (let move = 0; move < 3; move += 1) collisionEngine.moveHorizontal(-1);
  assert.equal(collisionEngine.hardDrop(), 19);
  for (let row = 0; row < 18; row += 1) assert.equal(collisionEngine.tick(), true);
  const besideLockedPiece = collisionEngine.getState();
  assert.equal(besideLockedPiece.current.row, 18);
  assert.equal(collisionEngine.moveHorizontal(-1), false);
  assert.deepEqual(collisionEngine.getState(), besideLockedPiece);
});

test('旋转得到预期矩阵并按偏移顺序完成墙踢', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  assert.equal(engine.rotate(), true);
  assert.deepEqual(engine.getState().current.matrix, [[1], [1], [1], [1]]);
  for (let move = 0; move < 5; move += 1) assert.equal(engine.moveHorizontal(1), true);
  assert.equal(engine.getState().current.column, 8);
  assert.equal(engine.rotate(), true);
  assert.deepEqual(engine.getState().current.matrix, [[1, 1, 1, 1]]);
  assert.equal(engine.getState().current.column, 6);
});

test('没有可用墙踢位置时旋转失败且状态不变', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  engine.rotate();
  for (let move = 0; move < 6; move += 1) engine.moveHorizontal(1);
  assert.equal(engine.getState().current.column, 9);
  const before = engine.getState();
  assert.equal(engine.rotate(), false);
  assert.deepEqual(engine.getState(), before);
});

test('硬降精确计分并在底行锁定后递增序号', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  assert.equal(engine.getState().current.type, 'I');
  assert.equal(engine.hardDrop(), 19);
  const state = engine.getState();
  assert.equal(state.score, 38);
  assert.deepEqual(state.board[19], [0, 0, 0, 'I', 'I', 'I', 'I', 0, 0, 0]);
  assert.equal(state.current.type, 'Z');
  assert.equal(state.current.serial, 2);
});

test('软降成功时每格加一分，触底后锁定而不额外加分', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  for (let row = 1; row <= 19; row += 1) {
    assert.equal(engine.softDrop(), true);
    assert.equal(engine.getState().current.row, row);
    assert.equal(engine.getState().score, row);
  }
  assert.equal(engine.softDrop(), true);
  const state = engine.getState();
  assert.equal(state.score, 19);
  assert.equal(state.current.serial, 2);
  assert.deepEqual(state.board[19], [0, 0, 0, 'I', 'I', 'I', 'I', 0, 0, 0]);
});

test('tick 触底时锁定当前方块并生成下一块', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  for (let row = 1; row <= 19; row += 1) assert.equal(engine.tick(), true);
  assert.equal(engine.getState().current.row, 19);
  assert.equal(engine.tick(), true);
  const state = engine.getState();
  assert.equal(state.score, 0);
  assert.equal(state.current.serial, 2);
  assert.deepEqual(state.board[19], [0, 0, 0, 'I', 'I', 'I', 'I', 0, 0, 0]);
});

test('暂停阻止所有推进操作且恢复后继续 tick', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  const before = engine.getState();
  assert.equal(engine.pause(), true);
  assert.equal(engine.moveHorizontal(-1), false);
  assert.equal(engine.rotate(), false);
  assert.equal(engine.softDrop(), false);
  assert.equal(engine.hardDrop(), 0);
  assert.equal(engine.tick(), false);
  assert.deepEqual(engine.getState(), { ...before, paused: true });
  assert.equal(engine.resume(), true);
  assert.equal(engine.tick(), true);
  assert.equal(engine.getState().current.row, before.current.row + 1);
});

test('固定七袋在第十次锁定后存活，第十一次锁定后精确结束', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  for (let lock = 0; lock < 10; lock += 1) engine.hardDrop();
  assert.equal(engine.getState().gameOver, false);

  assert.equal(engine.hardDrop(), 0);
  const gameOverState = engine.getState();
  assert.equal(gameOverState.gameOver, true);
  assert.equal(gameOverState.current.type, 'O');
  assert.equal(gameOverState.current.serial, 12);
  assert.equal(gameOverState.current.row, 0);
  assert.equal(gameOverState.current.column, 4);
  assert.equal(gameOverState.nextType, 'L');
  assert.equal(gameOverState.score, 206);
  assert.equal(gameOverState.lines, 0);
  assert.equal(gameOverState.level, 0);
  assert.equal(engine.moveHorizontal(1), false);
  assert.equal(engine.rotate(), false);
  assert.equal(engine.softDrop(), false);
  assert.equal(engine.hardDrop(), 0);
  assert.equal(engine.tick(), false);
  assert.deepEqual(engine.getState(), gameOverState);
});

test('restart 清空局面和暂停状态并保留最高分', () => {
  const engine = createTetrisEngine({ random: () => 0, initialBestScore: 500 });
  engine.hardDrop();
  engine.pause();
  const previous = engine.getState();
  assert.equal(engine.restart(), true);
  const restarted = engine.getState();
  assert.deepEqual(restarted.board, createEmptyTetrisBoard());
  assert.equal(restarted.score, 0);
  assert.equal(restarted.lines, 0);
  assert.equal(restarted.level, 0);
  assert.equal(restarted.gameOver, false);
  assert.equal(restarted.paused, false);
  assert.equal(restarted.bestScore, 500);
  assert.equal(restarted.current.serial, 1);
  assert.notDeepEqual(restarted.current, previous.current);
});

test('restart 可从游戏结束局面生成全新可推进状态', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  for (let lock = 0; lock < 11; lock += 1) engine.hardDrop();
  assert.equal(engine.getState().gameOver, true, '第 11 次锁定后应达到游戏结束');
  const bestScore = engine.getState().bestScore;
  engine.restart();
  const restarted = engine.getState();
  assert.deepEqual(restarted.board, createEmptyTetrisBoard());
  assert.equal(restarted.gameOver, false);
  assert.equal(restarted.bestScore, bestScore);
  assert.equal(engine.tick(), true);
});

test('getState 返回棋盘、当前方块和矩阵的深拷贝', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  const first = engine.getState();
  const expected = engine.getState();
  first.board[0][0] = 'T';
  first.current.type = 'T';
  first.current.row = 99;
  first.current.matrix[0][0] = 0;
  assert.deepEqual(engine.getState(), expected);
});
