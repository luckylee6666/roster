import { TETRIS_COLUMNS, TETRIS_ROWS, createTetrisEngine, dropIntervalForLevel } from './tetris-engine.js';

const DEFAULT_STORAGE_KEY = 'vibe-coding-manage:tetris-best-score';
const KEY_ACTIONS = Object.freeze({
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowDown: 'down',
  ArrowUp: 'rotate',
  ' ': 'drop',
  p: 'pause',
  P: 'pause',
});

function displayedBoard(state) {
  const board = state.board.map(row => [...row]);
  state.current.matrix.forEach((matrixRow, matrixRowIndex) => matrixRow.forEach((cell, matrixColumnIndex) => {
    const row = state.current.row + matrixRowIndex;
    const column = state.current.column + matrixColumnIndex;
    if (cell && row >= 0 && row < TETRIS_ROWS && column >= 0 && column < TETRIS_COLUMNS) board[row][column] = state.current.type;
  }));
  return board;
}

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage; } catch { return null; }
}

export function createTetrisGame({
  random = Math.random,
  storage,
  storageKey = DEFAULT_STORAGE_KEY,
  documentRef = document,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const savedStorage = getStorage(storage);
  let savedBest = 0;
  try { savedBest = Math.max(0, Number.parseInt(savedStorage?.getItem(storageKey) || '0', 10) || 0); } catch { /* Storage can be unavailable. */ }
  const engine = createTetrisEngine({ random, initialBestScore: savedBest });
  let timer = null;
  let active = false;
  let host = null;
  let elements = null;

  function clearTimer() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }

  function saveBestScore() {
    try { savedStorage?.setItem(storageKey, String(engine.getState().bestScore)); } catch { /* Storage can be unavailable. */ }
  }

  function render() {
    if (!elements || !host) return;
    const state = engine.getState();
    elements.score.textContent = String(state.score);
    elements.best.textContent = String(state.bestScore);
    elements.lines.textContent = String(state.lines);
    elements.level.textContent = String(state.level + 1);
    elements.next.textContent = state.nextType;
    elements.board.replaceChildren();
    displayedBoard(state).forEach((row, rowIndex) => row.forEach((type, columnIndex) => {
      const cell = documentRef.createElement('div');
      cell.className = `game-tetris__cell${type ? ` game-tetris__cell--${type}` : ''}`;
      cell.dataset.row = String(rowIndex);
      cell.dataset.column = String(columnIndex);
      cell.setAttribute('role', 'gridcell');
      elements.board.append(cell);
    }));
    host.classList.toggle('game-tetris--paused', state.paused || !active);
    host.classList.toggle('game-tetris--over', state.gameOver);
    elements.pause.disabled = state.gameOver;
    elements.pause.textContent = state.paused || !active ? '继续' : '暂停';
    elements.status.textContent = state.gameOver ? '游戏结束，按重新开始再来一局' : (state.paused || !active ? '已暂停' : '方向键控制方块，P 键暂停');
  }

  function schedule() {
    clearTimer();
    const state = engine.getState();
    if (!active || state.paused || state.gameOver) return;
    const timerId = setTimeoutFn(() => {
      if (timer !== timerId || !active) return;
      timer = null;
      clearTimeoutFn(timerId);
      const previousBest = engine.getState().bestScore;
      engine.tick();
      if (engine.getState().bestScore !== previousBest) saveBestScore();
      render();
      schedule();
    }, dropIntervalForLevel(state.level));
    timer = timerId;
  }

  function applyAction(action) {
    const previousBest = engine.getState().bestScore;
    if (action === 'left') engine.moveHorizontal(-1);
    if (action === 'right') engine.moveHorizontal(1);
    if (action === 'down') engine.softDrop();
    if (action === 'rotate') engine.rotate();
    if (action === 'drop') engine.hardDrop();
    if (engine.getState().bestScore !== previousBest) saveBestScore();
    render();
    schedule();
    return engine.getState();
  }

  function pause() {
    active = false;
    engine.pause();
    clearTimer();
    render();
    return engine.getState();
  }

  function resume() {
    active = true;
    engine.resume();
    render();
    schedule();
    return engine.getState();
  }

  function restart() {
    const wasActive = active;
    clearTimer();
    engine.restart();
    if (!wasActive) engine.pause();
    render();
    schedule();
    return engine.getState();
  }

  function onKeyDown(event) {
    const action = KEY_ACTIONS[event.key];
    if (!action) return;
    event.preventDefault();
    if (action === 'pause') {
      if (active) pause(); else resume();
      return;
    }
    applyAction(action);
  }

  function mount(target) {
    if (!target || typeof target.append !== 'function') throw new TypeError('俄罗斯方块 mount target 必须是元素');
    destroy();
    host = target;
    host.classList.add('game-tetris');
    host.tabIndex = 0;
    host.setAttribute('role', 'application');
    host.setAttribute('aria-label', '俄罗斯方块游戏，使用方向键移动，上方向键旋转，空格硬降，P 键暂停');
    host.replaceChildren();

    const header = documentRef.createElement('div');
    header.className = 'game-tetris__header';
    const brand = documentRef.createElement('strong');
    brand.textContent = '俄罗斯方块';
    const stats = documentRef.createElement('div');
    stats.className = 'game-tetris__stats';
    const makeStat = label => {
      const stat = documentRef.createElement('span');
      stat.textContent = `${label} `;
      const value = documentRef.createElement('strong');
      stat.append(value);
      stats.append(stat);
      return value;
    };
    const score = makeStat('分数');
    const best = makeStat('最高');
    const lines = makeStat('消行');
    const level = makeStat('等级');
    header.append(brand, stats);

    const next = documentRef.createElement('div');
    next.className = 'game-tetris__next';
    next.setAttribute('aria-label', '下一个方块');
    const board = documentRef.createElement('div');
    board.className = 'game-tetris__board';
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-label', '俄罗斯方块棋盘');
    const controls = documentRef.createElement('div');
    controls.className = 'game-tetris__controls';
    const controlDefinitions = [['left', '←', '向左'], ['rotate', '↻', '旋转'], ['right', '→', '向右'], ['down', '↓', '软降'], ['drop', '⇩', '硬降']];
    controlDefinitions.forEach(([action, text, label]) => {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => applyAction(action));
      controls.append(button);
    });
    const pauseButton = documentRef.createElement('button');
    pauseButton.type = 'button';
    pauseButton.className = 'game-tetris__pause';
    pauseButton.addEventListener('click', () => { if (active) pause(); else resume(); });
    const restartButton = documentRef.createElement('button');
    restartButton.type = 'button';
    restartButton.className = 'game-tetris__restart';
    restartButton.textContent = '重新开始';
    restartButton.addEventListener('click', restart);
    controls.append(pauseButton, restartButton);
    const status = documentRef.createElement('p');
    status.className = 'game-tetris__status';
    status.setAttribute('aria-live', 'polite');
    host.append(header, next, board, controls, status);
    elements = { score, best, lines, level, next, board, pause: pauseButton, status };
    host.addEventListener('keydown', onKeyDown);
    render();
    return api;
  }

  function destroy() {
    pause();
    host?.removeEventListener('keydown', onKeyDown);
    host?.replaceChildren();
    host?.classList.remove('game-tetris', 'game-tetris--paused', 'game-tetris--over');
    host = null;
    elements = null;
  }

  const api = { mount, pause, resume, restart, destroy, getState: engine.getState };
  return api;
}

export default createTetrisGame;
