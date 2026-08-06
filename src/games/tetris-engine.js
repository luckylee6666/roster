export const TETRIS_ROWS = 20;
export const TETRIS_COLUMNS = 10;
export const TETROMINO_TYPES = Object.freeze(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);

const BASE_MATRICES = Object.freeze({
  I: [[1, 1, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]],
  O: [[1, 1], [1, 1]],
  S: [[0, 1, 1], [1, 1, 0]],
  T: [[0, 1, 0], [1, 1, 1]],
  Z: [[1, 1, 0], [0, 1, 1]],
});

export function createEmptyTetrisBoard(rows = TETRIS_ROWS, columns = TETRIS_COLUMNS) {
  return Array.from({ length: rows }, () => Array(columns).fill(0));
}

export function createSevenBag(random = Math.random) {
  const bag = [...TETROMINO_TYPES];
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const randomValue = Number(random());
    const normalized = Number.isFinite(randomValue)
      ? Math.min(1 - Number.EPSILON, Math.max(0, randomValue))
      : 0;
    const swapIndex = Math.floor(normalized * (index + 1));
    [bag[index], bag[swapIndex]] = [bag[swapIndex], bag[index]];
  }
  return bag;
}

export function clearCompletedLines(board) {
  const remaining = board.filter(row => row.some(cell => !cell)).map(row => [...row]);
  const lines = board.length - remaining.length;
  return {
    board: [...createEmptyTetrisBoard(lines, board[0].length), ...remaining],
    lines,
  };
}

export function scoreForLines(lines, level) {
  return ([0, 100, 300, 500, 800][lines] || 0) * (level + 1);
}

export function dropIntervalForLevel(level) {
  return Math.max(100, 800 - Math.max(0, level) * 60);
}

function cloneMatrix(matrix) {
  return matrix.map(row => [...row]);
}

function clonePiece(piece) {
  return { ...piece, matrix: cloneMatrix(piece.matrix) };
}

function rotateMatrix(matrix) {
  return matrix[0].map((_, column) => matrix.map(row => row[column]).reverse());
}

function translatedPiece(piece, rowOffset, columnOffset) {
  return { ...piece, row: piece.row + rowOffset, column: piece.column + columnOffset };
}

function canPlacePiece(board, piece) {
  return piece.matrix.every((matrixRow, matrixRowIndex) => matrixRow.every((cell, matrixColumnIndex) => {
    if (!cell) return true;
    const row = piece.row + matrixRowIndex;
    const column = piece.column + matrixColumnIndex;
    if (column < 0 || column >= board[0].length || row >= board.length) return false;
    return row < 0 || !board[row][column];
  }));
}

function mergePiece(board, piece) {
  const next = board.map(row => [...row]);
  piece.matrix.forEach((matrixRow, matrixRowIndex) => matrixRow.forEach((cell, matrixColumnIndex) => {
    const row = piece.row + matrixRowIndex;
    const column = piece.column + matrixColumnIndex;
    if (cell && row >= 0 && row < next.length && column >= 0 && column < next[0].length) {
      next[row][column] = piece.type;
    }
  }));
  return next;
}

function spawnPiece(type, serial) {
  const matrix = cloneMatrix(BASE_MATRICES[type]);
  return {
    type,
    matrix,
    row: 0,
    column: Math.floor((TETRIS_COLUMNS - matrix[0].length) / 2),
    serial,
  };
}

export function createTetrisEngine({ random = Math.random, initialBestScore = 0 } = {}) {
  let board;
  let current;
  let nextType;
  let bag;
  let score;
  let bestScore = Math.max(0, Number(initialBestScore) || 0);
  let lines;
  let level;
  let paused;
  let gameOver;
  let serial;

  function drawType() {
    if (!bag.length) bag = createSevenBag(random);
    return bag.pop();
  }

  function getState() {
    return {
      board: board.map(row => [...row]),
      current: clonePiece(current),
      nextType,
      score,
      bestScore,
      lines,
      level,
      paused,
      gameOver,
    };
  }

  function lockCurrent() {
    board = mergePiece(board, current);
    const cleared = clearCompletedLines(board);
    board = cleared.board;
    score += scoreForLines(cleared.lines, level);
    lines += cleared.lines;
    level = Math.floor(lines / 10);
    bestScore = Math.max(bestScore, score);
    current = spawnPiece(nextType, ++serial);
    nextType = drawType();
    if (!canPlacePiece(board, current)) gameOver = true;
  }

  function moveHorizontal(delta) {
    if (paused || gameOver || (delta !== -1 && delta !== 1)) return false;
    const moved = translatedPiece(current, 0, delta);
    if (!canPlacePiece(board, moved)) return false;
    current = moved;
    return true;
  }

  function rotate() {
    if (paused || gameOver) return false;
    const rotated = { ...current, matrix: rotateMatrix(current.matrix) };
    for (const offset of [0, -1, 1, -2, 2]) {
      const candidate = translatedPiece(rotated, 0, offset);
      if (canPlacePiece(board, candidate)) {
        current = candidate;
        return true;
      }
    }
    return false;
  }

  function tick() {
    if (paused || gameOver) return false;
    const moved = translatedPiece(current, 1, 0);
    if (canPlacePiece(board, moved)) current = moved;
    else lockCurrent();
    return true;
  }

  function softDrop() {
    if (paused || gameOver) return false;
    const moved = translatedPiece(current, 1, 0);
    if (canPlacePiece(board, moved)) {
      current = moved;
      score += 1;
      bestScore = Math.max(bestScore, score);
      return true;
    }
    lockCurrent();
    return true;
  }

  function hardDrop() {
    if (paused || gameOver) return 0;
    let distance = 0;
    while (canPlacePiece(board, translatedPiece(current, 1, 0))) {
      current = translatedPiece(current, 1, 0);
      distance += 1;
    }
    score += distance * 2;
    lockCurrent();
    return distance;
  }

  function pause() {
    if (paused || gameOver) return false;
    paused = true;
    return true;
  }

  function resume() {
    if (!paused || gameOver) return false;
    paused = false;
    return true;
  }

  function restart() {
    board = createEmptyTetrisBoard();
    bag = [];
    score = 0;
    lines = 0;
    level = 0;
    paused = false;
    gameOver = false;
    serial = 1;
    current = spawnPiece(drawType(), serial);
    nextType = drawType();
    return true;
  }

  restart();
  return { moveHorizontal, rotate, softDrop, hardDrop, tick, pause, resume, restart, getState };
}
