const DEFAULT_SIZE = 4;
const DEFAULT_STORAGE_KEY = "roster:2048-best-score";
const LEGACY_STORAGE_KEY = "vibe-coding-manage:2048-best-score";

export const GAME_2048_SIZE = DEFAULT_SIZE;

export function createEmptyBoard(size = DEFAULT_SIZE) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

export function cloneBoard(board) {
  return board.map((row) => [...row]);
}

function boardsEqual(left, right) {
  return left.every((row, rowIndex) => row.every((cell, columnIndex) => cell === right[rowIndex][columnIndex]));
}

export function mergeLine(line) {
  const compact = line.filter(Boolean);
  const merged = [];
  let score = 0;

  for (let index = 0; index < compact.length; index += 1) {
    if (compact[index] === compact[index + 1]) {
      const value = compact[index] * 2;
      merged.push(value);
      score += value;
      index += 1;
    } else {
      merged.push(compact[index]);
    }
  }

  return {
    line: [...merged, ...Array(line.length - merged.length).fill(0)],
    score,
  };
}

export function moveBoard(board, direction) {
  const size = board.length;
  const next = createEmptyBoard(size);
  let score = 0;
  const horizontal = direction === "left" || direction === "right";
  const backwards = direction === "right" || direction === "down";

  if (!horizontal && direction !== "up" && direction !== "down") {
    throw new Error(`Unsupported 2048 direction: ${direction}`);
  }

  for (let lineIndex = 0; lineIndex < size; lineIndex += 1) {
    const source = horizontal
      ? [...board[lineIndex]]
      : board.map((row) => row[lineIndex]);
    if (backwards) source.reverse();
    const result = mergeLine(source);
    score += result.score;
    const line = backwards ? result.line.reverse() : result.line;

    for (let cellIndex = 0; cellIndex < size; cellIndex += 1) {
      if (horizontal) next[lineIndex][cellIndex] = line[cellIndex];
      else next[cellIndex][lineIndex] = line[cellIndex];
    }
  }

  return { board: next, moved: !boardsEqual(board, next), score };
}

export function spawnTile(board, random = Math.random) {
  const empty = [];
  board.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (!value) empty.push([rowIndex, columnIndex]);
  }));
  if (!empty.length) return { board: cloneBoard(board), spawned: null };

  const next = cloneBoard(board);
  const [row, column] = empty[Math.min(empty.length - 1, Math.floor(random() * empty.length))];
  const value = random() < 0.9 ? 2 : 4;
  next[row][column] = value;
  return { board: next, spawned: { row, column, value } };
}

export function canMove(board) {
  const size = board.length;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const value = board[row][column];
      if (!value) return true;
      if (column + 1 < size && value === board[row][column + 1]) return true;
      if (row + 1 < size && value === board[row + 1][column]) return true;
    }
  }
  return false;
}

function getStorage(storage) {
  if (storage) return storage;
  try { return window.localStorage; } catch { return null; }
}

function readBestScore(storage, key) {
  try { return Math.max(0, Number.parseInt(storage?.getItem(key) || "0", 10) || 0); } catch { return 0; }
}

function writeBestScore(storage, key, score) {
  try { storage?.setItem(key, String(score)); } catch { /* Storage may be disabled. */ }
}

export function create2048Game({ random = Math.random, storage, storageKey = DEFAULT_STORAGE_KEY } = {}) {
  const savedStorage = getStorage(storage);
  let board = createEmptyBoard();
  let score = 0;
  let bestScore = readBestScore(savedStorage, storageKey)
    || (storageKey === DEFAULT_STORAGE_KEY ? readBestScore(savedStorage, LEGACY_STORAGE_KEY) : 0);
  let paused = false;
  let gameOver = false;
  let container = null;
  let elements = null;
  let touchStart = null;

  const state = () => ({ board: cloneBoard(board), score, bestScore, paused, gameOver });

  function render() {
    if (!elements) return;
    elements.score.textContent = String(score);
    elements.best.textContent = String(bestScore);
    elements.grid.replaceChildren();
    board.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      const cell = document.createElement("div");
      cell.className = "game-2048__cell";
      if (value) {
        const tile = document.createElement("div");
        tile.className = `game-2048__tile game-2048__tile--${value}`;
        tile.textContent = String(value);
        tile.dataset.row = String(rowIndex);
        tile.dataset.column = String(columnIndex);
        cell.append(tile);
      }
      elements.grid.append(cell);
    }));
    container.classList.toggle("game-2048--paused", paused);
    container.classList.toggle("game-2048--over", gameOver);
    elements.status.textContent = paused ? "已暂停" : gameOver ? "游戏结束，按重新开始再来一局" : "使用方向键或滑动方块";
  }

  function restart() {
    board = createEmptyBoard();
    board = spawnTile(board, random).board;
    board = spawnTile(board, random).board;
    score = 0;
    paused = false;
    gameOver = false;
    render();
    return state();
  }

  function move(direction) {
    if (paused || gameOver) return state();
    const result = moveBoard(board, direction);
    if (!result.moved) return state();
    board = spawnTile(result.board, random).board;
    score += result.score;
    if (score > bestScore) {
      bestScore = score;
      writeBestScore(savedStorage, storageKey, bestScore);
    }
    gameOver = !canMove(board);
    render();
    return state();
  }

  const keyDirections = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  function onKeyDown(event) {
    const direction = keyDirections[event.key];
    if (!direction) return;
    event.preventDefault();
    move(direction);
  }
  function onTouchStart(event) {
    const touch = event.changedTouches[0];
    touchStart = touch && { x: touch.clientX, y: touch.clientY };
  }
  function onTouchEnd(event) {
    const touch = event.changedTouches[0];
    if (!touchStart || !touch || paused) return;
    const x = touch.clientX - touchStart.x;
    const y = touch.clientY - touchStart.y;
    touchStart = null;
    if (Math.max(Math.abs(x), Math.abs(y)) < 24) return;
    move(Math.abs(x) > Math.abs(y) ? (x > 0 ? "right" : "left") : (y > 0 ? "down" : "up"));
  }

  function mount(target) {
    if (!(target instanceof HTMLElement)) throw new TypeError("2048 mount target must be an HTMLElement");
    destroy();
    container = target;
    container.classList.add("game-2048");
    container.tabIndex = 0;
    container.setAttribute("role", "application");
    container.setAttribute("aria-label", "2048 游戏，使用方向键移动方块");
    container.replaceChildren();
    const header = document.createElement("div");
    header.className = "game-2048__header";
    header.innerHTML = '<div class="game-2048__brand">2048</div><div class="game-2048__scores"><div class="game-2048__score"><span>分数</span><strong data-game-score>0</strong></div><div class="game-2048__score"><span>最高</span><strong data-game-best>0</strong></div></div>';
    const actions = document.createElement("div");
    actions.className = "game-2048__actions";
    const restartButton = document.createElement("button");
    restartButton.type = "button";
    restartButton.className = "game-2048__restart";
    restartButton.textContent = "重新开始";
    restartButton.addEventListener("click", restart);
    actions.append(restartButton);
    const grid = document.createElement("div");
    grid.className = "game-2048__grid";
    const status = document.createElement("p");
    status.className = "game-2048__status";
    status.setAttribute("aria-live", "polite");
    container.append(header, actions, grid, status);
    elements = { grid, status, score: header.querySelector("[data-game-score]"), best: header.querySelector("[data-game-best]"), restartButton };
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    render();
    return api;
  }

  function pause() { paused = true; render(); return state(); }
  function resume() { paused = false; render(); return state(); }
  function destroy() {
    if (!container) return;
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchend", onTouchEnd);
    container.replaceChildren();
    container.classList.remove("game-2048", "game-2048--paused", "game-2048--over");
    container = null;
    elements = null;
  }

  const api = { mount, move, pause, resume, restart, destroy, getState: state };
  restart();
  return api;
}

export default create2048Game;
