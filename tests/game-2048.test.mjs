import assert from "node:assert/strict";
import test from "node:test";
import { canMove, createEmptyBoard, mergeLine, moveBoard, spawnTile } from "../src/games/game-2048.js";

test("mergeLine 每个方块每次只能合并一次", () => {
  assert.deepEqual(mergeLine([2, 2, 2, 2]).line, [4, 4, 0, 0]);
  assert.equal(mergeLine([2, 2, 2, 2]).score, 8);
  assert.deepEqual(mergeLine([2, 2, 2, 0]).line, [4, 2, 0, 0]);
});

test("moveBoard 支持四个方向且不修改输入棋盘", () => {
  const board = [[2, 0, 2, 4], [0, 0, 0, 0], [2, 0, 2, 2], [0, 0, 0, 0]];
  const result = moveBoard(board, "left");
  assert.deepEqual(result.board, [[4, 4, 0, 0], [0, 0, 0, 0], [4, 2, 0, 0], [0, 0, 0, 0]]);
  assert.equal(result.score, 8);
  assert.equal(result.moved, true);
  assert.deepEqual(board[0], [2, 0, 2, 4]);
  assert.deepEqual(moveBoard([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], "right").board[0], [0, 0, 0, 4]);
});

test("spawnTile 只生成在空位，并使用随机数决定位置和数值", () => {
  const board = [[2, 0], [0, 4]];
  const spawned = spawnTile(board, () => 0.99);
  assert.deepEqual(spawned.spawned, { row: 1, column: 0, value: 4 });
  assert.deepEqual(spawned.board, [[2, 0], [4, 4]]);
  assert.deepEqual(board, [[2, 0], [0, 4]]);
  assert.equal(spawnTile([[2]], () => 0).spawned, null);
});

test("canMove 能识别空位、相邻合并与结束局面", () => {
  assert.equal(canMove(createEmptyBoard()), true);
  assert.equal(canMove([[2, 4], [8, 8]]), true);
  assert.equal(canMove([[2, 4], [8, 16]]), false);
});
