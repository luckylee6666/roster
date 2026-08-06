# 娱乐游戏中心与轻松模式自定义网址 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将娱乐模式升级为可选择并记忆状态的本地俄罗斯方块与 2048 游戏中心，同时让轻松模式从空网址列表开始并完全由用户管理网页。

**Architecture:** 将俄罗斯方块拆成纯规则引擎和 DOM 适配器，再由独立游戏中心统一管理两个游戏的宿主、选择与生命周期。工作区设置升级到 v2，迁移时只移除旧版精确匹配的内置抖音项，并让空站点状态不创建原生 WebView。

**Tech Stack:** Tauri v2、Vanilla HTML/CSS/JavaScript ES modules、Node.js `node:test`、浏览器 LocalStorage。

## Global Constraints

- 保留 2048；首次默认俄罗斯方块，并记住上次选择。
- 游戏全部本地运行，不添加第三方依赖、联网游戏、排行榜或代理能力。
- 轻松模式不提供预设网页；远程地址仅允许 HTTPS，本地开发地址额外允许 localhost、127.0.0.1 和 ::1 的 HTTP。
- 旧版精确匹配 `id: "douyin"` 且 URL 为 `https://www.douyin.com/` 的内置项被移除，其他用户网址必须保留。
- 复用当前右侧工作区的视觉体系、响应式布局和可访问性模式，不调用 Stitch。
- 所有 Git commit message 必须使用中文。
- 当前工作区包含用户尚未提交且与工作区模式有关的文件；执行时保留所有现有内容，不自动暂存或提交这些文件。每个任务以测试和 `git diff --check` 作为检查点，只有用户明确授权后才提交组合改动。

---

## File Map

- Create `src/games/game-ids.js`: 游戏 ID、默认游戏和合法值归一化。
- Create `src/games/tetris-engine.js`: 无 DOM 的俄罗斯方块棋盘、方块、碰撞、消行、计分和状态机。
- Create `src/games/game-tetris.js`: 俄罗斯方块 DOM、输入、计时器、最高分存储和统一生命周期接口。
- Create `src/games/game-center.js`: 游戏注册表、按需挂载、选择、暂停、恢复和错误隔离。
- Modify `src/workspace-mode-utils.js`: v2 设置、旧设置迁移、空网址和 `activeGameId`。
- Modify `src/workspace-mode.js`: 接入游戏中心、游戏选择器、站点空状态和无站点 WebView 生命周期。
- Modify `src/index.html`: 游戏选择器和轻松模式空状态按钮。
- Modify `src/styles.css`: 游戏选择器、俄罗斯方块、屏幕控制按钮和网页空状态。
- Create `tests/game-tetris.test.mjs`: 俄罗斯方块规则和生命周期测试。
- Create `tests/game-center.test.mjs`: 多游戏切换和错误隔离测试。
- Modify `tests/workspace-mode-utils.test.mjs`: v2 设置与迁移测试。
- Modify `tests/workspace-mode-behavior.test.mjs`: 游戏选择及空站点行为测试。
- Modify `tests/workspace-mode-runtime.test.mjs`: HTML/CSS/模块接线静态测试。
- Modify `README.md` and `README.zh-CN.md`: 更新工作区模式说明。

---

### Task 1: v2 设置、游戏 ID 与旧抖音迁移

**Files:**
- Create: `src/games/game-ids.js`
- Modify: `src/workspace-mode-utils.js:1-211`
- Modify: `tests/workspace-mode-utils.test.mjs:1-129`

**Interfaces:**
- Produces: `DEFAULT_GAME_ID: "tetris"`, `GAME_IDS: readonly ["tetris", "2048"]`, `normalizeGameId(value): "tetris" | "2048"`。
- Produces: `loadWorkspaceModeSettings(storage)` 和 `saveWorkspaceModeSettings(settings, storage)` 都返回 `{ mode, companionWidth, sites, activeSiteId, activeGameId }`。
- Consumes: 现有 `normalizeCompanionSite`、安全 LocalStorage 读写函数。

- [ ] **Step 1: 写游戏 ID 和设置迁移的失败测试**

在 `tests/workspace-mode-utils.test.mjs` 增加对 `DEFAULT_GAME_ID`、`normalizeGameId` 的导入，并加入：

```js
test('游戏选择仅接受注册 ID，首次回退到俄罗斯方块', () => {
  assert.equal(DEFAULT_GAME_ID, 'tetris');
  assert.equal(normalizeGameId('2048'), '2048');
  assert.equal(normalizeGameId('snake'), 'tetris');
  assert.equal(normalizeGameId(null), 'tetris');
});

test('v1 设置迁移会移除旧内置抖音并保留用户网址', () => {
  const storage = memoryStorage({
    'workspace-mode-settings-v1': JSON.stringify({
      mode: 'relax',
      companionWidth: 44,
      sites: [
        { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' },
        { id: 'news', name: '新闻', url: 'https://example.com/' },
      ],
      activeSiteId: 'douyin',
    }),
  });
  const loaded = loadWorkspaceModeSettings(storage);
  assert.deepEqual(loaded.sites, [{ id: 'news', name: '新闻', url: 'https://example.com/' }]);
  assert.equal(loaded.activeSiteId, 'news');
  assert.equal(loaded.activeGameId, 'tetris');
});

test('v2 设置支持空网址并保存最后选择的游戏', () => {
  const storage = memoryStorage();
  const saved = saveWorkspaceModeSettings({
    mode: 'entertainment',
    companionWidth: 46,
    sites: [],
    activeSiteId: 'missing',
    activeGameId: '2048',
  }, storage);
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.settings.sites, []);
  assert.equal(saved.settings.activeSiteId, null);
  assert.equal(saved.settings.activeGameId, '2048');
  assert.ok(storage.getItem('workspace-mode-settings-v2'));
});
```

- [ ] **Step 2: 运行设置测试并确认因新接口缺失而失败**

Run: `node --test tests/workspace-mode-utils.test.mjs`

Expected: FAIL，错误指向 `src/games/game-ids.js` 不存在或 `activeGameId`/空站点行为与断言不符。

- [ ] **Step 3: 实现游戏 ID 与 v2 迁移**

创建 `src/games/game-ids.js`：

```js
export const DEFAULT_GAME_ID = 'tetris';
export const GAME_IDS = Object.freeze(['tetris', '2048']);

const GAME_ID_SET = new Set(GAME_IDS);

export function normalizeGameId(value) {
  return GAME_ID_SET.has(value) ? value : DEFAULT_GAME_ID;
}
```

在 `src/workspace-mode-utils.js` 中导入 `normalizeGameId`，将键定义改为：

```js
export const WORKSPACE_MODE_STORAGE_KEYS = Object.freeze({
  state: 'workspace-mode-settings-v2',
  legacyState: 'workspace-mode-settings-v1',
  mode: 'workspace-mode',
  sites: 'workspace-companion-sites',
  companionWidth: 'workspace-companion-width',
  activeSite: 'workspace-companion-active-site',
});

const LEGACY_DOUYIN_SITE = Object.freeze({
  id: 'douyin',
  url: 'https://www.douyin.com/',
});

function withoutLegacyBuiltinSite(sites) {
  return (Array.isArray(sites) ? sites : []).filter(site => !(
    site?.id === LEGACY_DOUYIN_SITE.id
    && normalizeCompanionUrl(site?.url) === LEGACY_DOUYIN_SITE.url
  ));
}
```

将 `normalizeCompanionSites` 改为只规范化传入项，不再注入默认项；重复 ID 使用 `idFactory()` 重建。加载时优先读取 v2，缺失时读取 v1 或旧独立键，并只对旧来源调用 `withoutLegacyBuiltinSite`。返回值与保存值使用：

```js
const activeSiteId = sites.some(site => site.id === savedActiveSite)
  ? savedActiveSite
  : sites[0]?.id ?? null;

return {
  mode: normalizeWorkspaceMode(source.mode),
  companionWidth: clampCompanionWidth(source.companionWidth),
  sites,
  activeSiteId,
  activeGameId: normalizeGameId(source.activeGameId),
};
```

`saveWorkspaceModeSettings` 必须一次写入 v2 键，并用同一规则得到 `activeSiteId` 和 `activeGameId`。

- [ ] **Step 4: 运行设置测试并确认通过**

Run: `node --test tests/workspace-mode-utils.test.mjs`

Expected: PASS；旧的“始终包含 douyin”断言已更新为“只保留用户站点”。

- [ ] **Step 5: 检查本任务变更**

Run: `git diff --check -- src/games/game-ids.js src/workspace-mode-utils.js tests/workspace-mode-utils.test.mjs`

Expected: exit 0；不暂存用户现有文件。

---

### Task 2: 无 DOM 的俄罗斯方块规则引擎

**Files:**
- Create: `src/games/tetris-engine.js`
- Create: `tests/game-tetris.test.mjs`

**Interfaces:**
- Produces: `TETRIS_ROWS = 20`, `TETRIS_COLUMNS = 10`, `TETROMINO_TYPES`。
- Produces: `createEmptyTetrisBoard()`, `createSevenBag(random)`, `clearCompletedLines(board)`, `scoreForLines(lines, level)`, `dropIntervalForLevel(level)`。
- Produces: `createTetrisEngine({ random, initialBestScore })`，返回 `moveHorizontal`, `rotate`, `softDrop`, `hardDrop`, `tick`, `pause`, `resume`, `restart`, `getState`。
- Consumes: 无 DOM、无计时器、无存储。

- [ ] **Step 1: 写棋盘、七袋、消行和计分失败测试**

创建 `tests/game-tetris.test.mjs`：

```js
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

test('俄罗斯方块棋盘为 10×20 且各行独立', () => {
  const board = createEmptyTetrisBoard();
  assert.equal(board.length, TETRIS_ROWS);
  assert.equal(board[0].length, TETRIS_COLUMNS);
  board[0][0] = 'I';
  assert.equal(board[1][0], 0);
});

test('七袋算法每袋恰好包含七种方块', () => {
  const bag = createSevenBag(() => 0.25);
  assert.equal(bag.length, 7);
  assert.deepEqual([...bag].sort(), [...TETROMINO_TYPES].sort());
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
```

- [ ] **Step 2: 运行规则测试并确认模块缺失失败**

Run: `node --test tests/game-tetris.test.mjs`

Expected: FAIL，错误为 `src/games/tetris-engine.js` 不存在。

- [ ] **Step 3: 实现基本数据结构和纯函数**

在 `src/games/tetris-engine.js` 定义：

```js
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
    const swapIndex = Math.floor(random() * (index + 1));
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
```

矩阵旋转使用转置后反转行；`O` 旋转后保持等价。碰撞检查逐个遍历矩阵中的非零单元，列越界、落到棋盘底部或命中已锁定单元都返回 false，棋盘上方的负行允许存在。

- [ ] **Step 4: 写状态机移动、旋转、硬降、锁定和结束失败测试**

继续在 `tests/game-tetris.test.mjs` 加入：

```js
import { createTetrisEngine } from '../src/games/tetris-engine.js';

test('状态机可移动旋转，硬降后锁定并生成下一块', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  const before = engine.getState();
  assert.equal(engine.moveHorizontal(-1), true);
  assert.equal(engine.rotate(), true);
  const distance = engine.hardDrop();
  const after = engine.getState();
  assert.ok(distance > 0);
  assert.notEqual(after.current.serial, before.current.serial);
  assert.ok(after.board.some(row => row.some(Boolean)));
  assert.ok(after.score >= distance * 2);
});

test('暂停时 tick 不推进，恢复后继续', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  const row = engine.getState().current.row;
  engine.pause();
  assert.equal(engine.tick(), false);
  assert.equal(engine.getState().current.row, row);
  engine.resume();
  assert.equal(engine.tick(), true);
  assert.equal(engine.getState().current.row, row + 1);
});

test('堆叠到出生位置时标记游戏结束', () => {
  const engine = createTetrisEngine({ random: () => 0 });
  for (let iteration = 0; iteration < 80 && !engine.getState().gameOver; iteration += 1) {
    engine.hardDrop();
  }
  assert.equal(engine.getState().gameOver, true);
  assert.equal(engine.moveHorizontal(1), false);
});
```

- [ ] **Step 5: 实现规则状态机**

`createTetrisEngine` 使用私有 `board/current/nextType/bag/score/bestScore/lines/level/paused/gameOver/serial`。核心锁定路径按以下顺序执行：

```js
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

function tick() {
  if (paused || gameOver) return false;
  const moved = translatedPiece(current, 1, 0);
  if (canPlacePiece(board, moved)) {
    current = moved;
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
```

`rotate()` 依次尝试列偏移 `[0, -1, 1, -2, 2]`；`moveHorizontal(delta)` 只接受 -1 或 1；`softDrop()` 成功向下时加 1 分，无法移动时调用 `lockCurrent()`。所有公开操作返回是否发生变化或硬降距离，`getState()` 返回棋盘、当前方块和基础矩阵的深拷贝。

- [ ] **Step 6: 运行俄罗斯方块规则测试**

Run: `node --test tests/game-tetris.test.mjs`

Expected: PASS，且测试进程退出，说明纯引擎没有遗留计时器。

- [ ] **Step 7: 检查本任务变更**

Run: `git diff --check -- src/games/tetris-engine.js tests/game-tetris.test.mjs`

Expected: exit 0。

---

### Task 3: 俄罗斯方块 DOM 适配器与计时生命周期

**Files:**
- Create: `src/games/game-tetris.js`
- Modify: `tests/game-tetris.test.mjs`
- Modify: `src/styles.css:2074-2221`

**Interfaces:**
- Consumes: `createTetrisEngine`, `dropIntervalForLevel`。
- Produces: `createTetrisGame({ random, storage, storageKey, documentRef, setTimeoutFn, clearTimeoutFn })`。
- Produces: 与 2048 相同的 `mount/pause/resume/restart/destroy/getState` 生命周期接口。

- [ ] **Step 1: 写计时器与销毁的失败测试**

在 `tests/game-tetris.test.mjs` 增加最小 Fake DOM 和可控计时器，并断言：

```js
test('DOM 游戏暂停会清理计时器，恢复会重新调度，销毁不遗留监听', () => {
  const timers = new Map();
  let nextTimer = 0;
  const documentRef = createFakeDocument();
  const host = documentRef.createElement('div');
  const game = createTetrisGame({
    documentRef,
    random: () => 0,
    setTimeoutFn(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
  });

  game.mount(host);
  game.resume();
  assert.equal(timers.size, 1);
  game.pause();
  assert.equal(timers.size, 0);
  game.resume();
  const [{ callback }] = timers.values();
  callback();
  assert.equal(game.getState().current.row > 0, true);
  game.destroy();
  assert.equal(timers.size, 0);
  assert.equal(host.children.length, 0);
});
```

Fake DOM 必须实现本模块实际使用的 `createElement`, `append`, `replaceChildren`, `addEventListener`, `removeEventListener`, `classList.toggle`, `setAttribute`, `dataset`, `textContent`, `disabled`, `focus`；测试断言真实状态变化，不断言模拟函数调用次数代替行为。

- [ ] **Step 2: 运行测试并确认缺少 DOM 适配器而失败**

Run: `node --test tests/game-tetris.test.mjs`

Expected: FAIL，错误为 `game-tetris.js` 缺失或 `createTetrisGame` 未导出。

- [ ] **Step 3: 实现 DOM、输入和计时器**

`src/games/game-tetris.js` 必须：

```js
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

export function createTetrisGame({
  random = Math.random,
  storage,
  storageKey = DEFAULT_STORAGE_KEY,
  documentRef = document,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const savedStorage = storage ?? globalThis.localStorage;
  let savedBest = 0;
  try { savedBest = Math.max(0, Number.parseInt(savedStorage?.getItem(storageKey) || '0', 10) || 0); } catch {}
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
    try { savedStorage?.setItem(storageKey, String(engine.getState().bestScore)); } catch {}
  }

  function schedule() {
    clearTimer();
    const state = engine.getState();
    if (!active || state.paused || state.gameOver) return;
    timer = setTimeoutFn(() => {
      timer = null;
      engine.tick();
      render();
      schedule();
    }, dropIntervalForLevel(state.level));
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

  function destroy() {
    pause();
    host?.removeEventListener('keydown', onKeyDown);
    host?.replaceChildren();
    host?.classList.remove('game-tetris', 'game-tetris--paused', 'game-tetris--over');
    host = null;
    elements = null;
  }
}
```

DOM 使用明确的类名：`.game-tetris`, `__header`, `__stats`, `__next`, `__board`, `__cell`, `__controls`, `__status`。棋盘渲染时先合成锁定棋盘与当前方块，再生成 200 个 `role="gridcell"` 单元；占用格增加 `game-tetris__cell--I` 等类型类。按钮 action 顺序为 `left`, `rotate`, `right`, `down`, `drop`，中文 `aria-label` 分别为“向左”“旋转”“向右”“软降”“硬降”。

`mount()` 设置 `role="application"` 和俄罗斯方块键盘说明；`pause()` 清除计时器；`resume()` 只在未结束时调度；`restart()` 重置引擎并保持当前外部暂停状态；每次最高分变化时安全写入 LocalStorage。

- [ ] **Step 4: 添加俄罗斯方块样式**

在 `src/styles.css` 的本地游戏区域加入 `.game-tetris` 样式：棋盘宽高比为 `1 / 2`，最大高度适配右侧面板；七种方块颜色具备足够区分度；控制按钮具有 hover、active、focus-visible；暂停和结束使用棋盘遮罩。`@media (max-height: 680px)` 缩小间距，`prefers-reduced-motion` 禁用新方块动效。

- [ ] **Step 5: 运行俄罗斯方块全部测试**

Run: `node --test tests/game-tetris.test.mjs`

Expected: PASS，测试进程正常退出，销毁后 `timers.size === 0`。

- [ ] **Step 6: 检查本任务变更**

Run: `git diff --check -- src/games/game-tetris.js src/styles.css tests/game-tetris.test.mjs`

Expected: exit 0。

---

### Task 4: 游戏注册表、选择器与工作区生命周期

**Files:**
- Create: `src/games/game-center.js`
- Create: `tests/game-center.test.mjs`
- Modify: `src/workspace-mode.js:1-12,46-109,301-320,630-764`
- Modify: `src/index.html:495-498`
- Modify: `src/styles.css:1947-2021,2074-2088`
- Modify: `tests/workspace-mode-behavior.test.mjs:1-525`
- Modify: `tests/workspace-mode-runtime.test.mjs:11-40`

**Interfaces:**
- Consumes: `createTetrisGame`, `create2048Game`, `normalizeGameId`。
- Produces: `createDefaultGameCatalog()` 返回 `[{ id, name, hint, factory }]`，顺序为俄罗斯方块、2048。
- Produces: `createGameCenter({ documentRef, catalog, onError })`，返回 `mount`, `select`, `pause`, `resume`, `destroy`, `getActiveId`, `getGameState`。
- `installWorkspaceMode` 新注入项：`gameCatalog = createDefaultGameCatalog()`、`gameCenterFactory = createGameCenter`。

- [ ] **Step 1: 写游戏中心切换失败测试**

创建 `tests/game-center.test.mjs`，用两个记录真实生命周期状态的 fake game：

```js
test('游戏中心按需创建，切换时暂停旧游戏并恢复新游戏', () => {
  const documentRef = createFakeDocument();
  const host = documentRef.createElement('div');
  const tetris = createFakeGame();
  const game2048 = createFakeGame();
  const center = createGameCenter({
    documentRef,
    catalog: [
      { id: 'tetris', name: '俄罗斯方块', hint: '方向键 / 空格', factory: () => tetris },
      { id: '2048', name: '2048', hint: '方向键 / 滑动', factory: () => game2048 },
    ],
  });
  center.mount(host);
  assert.equal(center.select('tetris'), 'tetris');
  center.resume();
  assert.equal(tetris.state.resumed, true);
  assert.equal(center.select('2048'), '2048');
  assert.equal(tetris.state.paused, true);
  assert.equal(game2048.state.resumed, true);
  assert.equal(center.select('missing'), 'tetris');
  center.destroy();
  assert.equal(tetris.state.destroyed, true);
  assert.equal(game2048.state.destroyed, true);
});
```

再增加一个 factory 抛错的用例，断言 `onError` 收到游戏 ID 和错误，随后仍能切换到正常游戏。

- [ ] **Step 2: 运行游戏中心测试并确认模块缺失失败**

Run: `node --test tests/game-center.test.mjs`

Expected: FAIL，错误为 `src/games/game-center.js` 不存在。

- [ ] **Step 3: 实现注册表和游戏中心**

`src/games/game-center.js` 的默认注册表固定为：

```js
export function createDefaultGameCatalog() {
  return [
    { id: 'tetris', name: '俄罗斯方块', hint: '方向键移动 · 空格硬降', factory: createTetrisGame },
    { id: '2048', name: '2048', hint: '方向键 / 滑动', factory: create2048Game },
  ];
}
```

中心内部维护 `Map<id, { game, host }>`。`select(id)` 先归一化 ID，暂停并隐藏当前宿主，按需创建目标宿主和实例；如果创建失败，宿主显示 `role="alert"` 错误信息并调用 `onError(id, error)`，中心仍可继续选择其他 ID。中心的 `resume()` 只恢复当前实例，`pause()` 暂停所有已创建实例，`destroy()` 销毁所有实例并清空根宿主。

- [ ] **Step 4: 写工作区选择与持久化失败测试**

更新 `tests/workspace-mode-behavior.test.mjs` 的 `REQUIRED_IDS`，加入 `companion-game-select` 和 `companion-game-hint`；把单一 `gameFactory` 改为注入 fake `gameCenterFactory`，并增加：

测试夹具的默认存储同时从旧 v1 抖音数据改为 v2 用户站点：

```js
const stored = new Map([[
  'workspace-mode-settings-v2',
  JSON.stringify({
    mode: 'relax',
    companionWidth: 42,
    sites: [{ id: 'example', name: '示例', url: 'https://example.com/' }],
    activeSiteId: 'example',
    activeGameId: 'tetris',
  }),
]]);
```

这样原有 WebView 生命周期测试继续覆盖“存在用户网址”的路径；Task 5 再通过可配置初始存储增加空列表路径。

```js
test('娱乐模式首次选择俄罗斯方块并持久化后续选择', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle }) => {
    await controller.applyMode('entertainment');
    await settle();
    const select = document.getElementById('companion-game-select');
    assert.equal(select.value, 'tetris');
    select.value = '2048';
    select.dispatch('change');
    await settle();
    assert.equal(controller.settings.activeGameId, '2048');
  });
});
```

在 `tests/workspace-mode-runtime.test.mjs` 断言 HTML 含 `id="companion-game-select"` 和两种游戏接线，样式含 `.game-tetris__board`。

- [ ] **Step 5: 运行工作区测试并确认选择器尚未接线而失败**

Run: `node --test tests/game-center.test.mjs tests/workspace-mode-behavior.test.mjs tests/workspace-mode-runtime.test.mjs`

Expected: FAIL，指向缺少选择器或控制器仍只支持 `gameFactory`。

- [ ] **Step 6: 接入选择器和游戏中心**

在 `src/index.html` 将固定 2048 标签替换为：

```html
<select class="companion-game-select" id="companion-game-select" aria-label="选择游戏"></select>
<span class="companion-game-hint" id="companion-game-hint"></span>
```

`installWorkspaceMode` 初始化时创建并挂载一个 game center。`renderGames()` 从 catalog 生成 option、恢复 `settings.activeGameId`、更新 hint，并调用 `gameCenter.select(activeId)`。选择器 change 时更新设置、持久化、切换游戏并在下一帧聚焦当前游戏宿主。所有现有 `game?.pause/resume/destroy` 调用改为 `gameCenter.pause/resume/destroy`，窗口、页面、Dock、浮层的暂停条件保持不变。

为 `.companion-game-select` 添加与 `.companion-site-select` 一致的 27px 高度、深色背景和可见 focus；游戏宿主通过 `[data-active="true"]` 显示，非当前宿主 `display: none`。

- [ ] **Step 7: 运行游戏中心与工作区测试**

Run: `node --test tests/game-center.test.mjs tests/workspace-mode-behavior.test.mjs tests/workspace-mode-runtime.test.mjs`

Expected: PASS。

- [ ] **Step 8: 检查本任务变更**

Run: `git diff --check -- src/games/game-center.js src/workspace-mode.js src/index.html src/styles.css tests/game-center.test.mjs tests/workspace-mode-behavior.test.mjs tests/workspace-mode-runtime.test.mjs`

Expected: exit 0。

---

### Task 5: 轻松模式空状态和完全自定义网址

**Files:**
- Modify: `src/index.html:509-516`
- Modify: `src/workspace-mode.js:121-162,252-299,421-478,630-658`
- Modify: `src/styles.css:1947-2072`
- Modify: `tests/workspace-mode-behavior.test.mjs:180-525`
- Modify: `tests/workspace-mode-runtime.test.mjs:11-40`

**Interfaces:**
- Consumes: Task 1 的空 `sites` / `activeSiteId: null`。
- Produces: 无站点时 `selectedSite(): null`，不调用 `webview.create`。
- Produces: `companion-empty-add-site` 与工具栏添加按钮共用 `openSiteModal()`。

- [ ] **Step 1: 写空站点和删除最后站点失败测试**

让 `withWorkspaceHarness` 可传入初始存储，增加：

```js
test('轻松模式无网址时显示空状态且不创建 WebView', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    await controller.applyMode('relax');
    await settle();
    assert.equal(controller.settings.sites.length, 0);
    assert.equal(countCalls(webview, 'create'), 0);
    assert.equal(document.getElementById('companion-web-status').textContent, '还没有网页');
    assert.equal(document.getElementById('companion-refresh').disabled, true);
    assert.equal(document.getElementById('companion-open-browser').disabled, true);
  }, { storedState: { mode: 'normal', sites: [], activeSiteId: null } });
});

test('删除最后一个用户网址会关闭 WebView并回到空状态', async () => {
  await withWorkspaceHarness(async ({ controller, document, settle, webview }) => {
    document.getElementById('companion-remove-site').dispatch('click');
    await settle();
    assert.equal(controller.settings.activeSiteId, null);
    assert.equal(controller.settings.sites.length, 0);
    assert.equal(countCalls(webview, 'close'), 1);
    assert.equal(document.getElementById('companion-web-status').textContent, '还没有网页');
  });
});
```

在 runtime 测试中断言 `id="companion-empty-add-site"` 存在。

- [ ] **Step 2: 运行行为测试并确认空数组假设导致失败**

Run: `node --test tests/workspace-mode-behavior.test.mjs tests/workspace-mode-runtime.test.mjs`

Expected: FAIL；现有 `selectedSite().id` 或 `settings.sites[0].id` 对空数组报错，或仍创建默认抖音 WebView。

- [ ] **Step 3: 实现空状态和网址删除**

在 `src/index.html` 的 placeholder 中加入：

```html
<button class="companion-empty-add-site" id="companion-empty-add-site" type="button">
  添加网页
</button>
```

`src/workspace-mode.js` 使用：

```js
function selectedSite() {
  return settings.sites.find(site => site.id === settings.activeSiteId)
    || settings.sites[0]
    || null;
}

function renderSites() {
  const site = selectedSite();
  ui.siteSelect.replaceChildren();
  settings.sites.forEach(item => {
    const option = documentRef.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    option.title = item.url;
    ui.siteSelect.append(option);
  });
  settings.activeSiteId = site?.id ?? null;
  ui.siteSelect.value = site?.id ?? '';
  ui.siteSelect.disabled = !site;
  ui.removeSite.disabled = !site;
  ui.refresh.disabled = !site;
  ui.openBrowser.disabled = !site;
  ui.webPlaceholder.classList.toggle('web-empty', !site);
  if (!site) setWebStatus('还没有网页', 'empty');
}
```

`openActiveSite()` 在 site 为 null 时设置空状态并调用 `closeWebview()`，不进入 `nextFrame` 和 `webview.create`。`removeCurrentSite()` 删除后把 activeSiteId 设置为 `settings.sites[0]?.id ?? null`；列表为空时关闭 WebView，否则强制打开下一项。空状态按钮与工具栏按钮都绑定 `openSiteModal()`。

CSS 在 `.web-empty` 时隐藏 loader，显示 `.companion-empty-add-site`；其他状态隐藏该按钮。按钮具备 hover 和 focus-visible。

- [ ] **Step 4: 运行轻松模式行为测试**

Run: `node --test tests/workspace-mode-utils.test.mjs tests/workspace-mode-behavior.test.mjs tests/workspace-mode-runtime.test.mjs`

Expected: PASS；无站点用例中 `create` 调用数为 0。

- [ ] **Step 5: 检查本任务变更**

Run: `git diff --check -- src/index.html src/workspace-mode.js src/styles.css tests/workspace-mode-behavior.test.mjs tests/workspace-mode-runtime.test.mjs`

Expected: exit 0。

---

### Task 6: 文档、完整回归与桌面验收

**Files:**
- Modify: `README.zh-CN.md:46-50`
- Modify: `README.md:46-50`
- Verify: all changed source and tests

**Interfaces:**
- Consumes: Tasks 1-5 的最终用户行为。
- Produces: 双语工作区模式文档和完整验证证据。

- [ ] **Step 1: 更新双语文档**

中文改为：

```md
- **轻松模式**：在右侧添加并管理自己的网页，仅允许 HTTPS 地址或 localhost 的 HTTP 地址；没有预设网址，不会自动加载第三方网站
- **娱乐模式**：在右侧选择俄罗斯方块或 2048；首次默认俄罗斯方块并记住上次选择，点右侧栏的「终端」可返回 Coding 区
```

英文表达同样的信息，不再写“built-in 2048”或默认抖音。

- [ ] **Step 2: 运行全部前端测试**

Run: `pnpm test`

Expected: exit 0，所有 Node 测试通过，无失败与未处理异步错误。

- [ ] **Step 3: 运行 Rust 回归测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`

Expected: exit 0，所有 Rust 测试通过。

- [ ] **Step 4: 运行 Clippy 严格检查**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`

Expected: exit 0，无 warning。

- [ ] **Step 5: 检查差异格式与范围**

Run: `git diff --check`

Expected: exit 0。随后运行 `git status --short`，确认没有自动暂存或覆盖原有用户改动。

- [ ] **Step 6: 在当前 Tauri Debug 应用中手工验收**

Run: `pnpm tauri dev`

Expected:

- 首次/迁移后的轻松模式显示“还没有网页”，进入时没有抖音网络加载。
- 添加 HTTPS 网址后可以加载、切换、刷新、外部打开和删除；删除最后一项回到空状态。
- 娱乐模式首次为俄罗斯方块，切到 2048 再返回时两局状态都保留。
- 俄罗斯方块方向键、空格、P 键和屏幕按钮工作；消行、分数、等级、下一块、暂停、重开和结束状态正确。
- 切换模式、收起 Dock、打开浮层和窗口失焦时游戏暂停，恢复时只有当前游戏继续。
- 窄面板无横向溢出，键盘焦点清晰，减少动态效果时不播放装饰动画。

- [ ] **Step 7: 汇总交付，不自动提交用户文件**

列出新增/修改文件、测试结果、手工验收结果以及现有未提交改动状态。如果用户随后要求提交，先审阅 `git diff` 和未跟踪文件范围，再使用中文提交信息，例如：

```bash
git commit -m "功能：新增娱乐游戏中心与自定义轻松模式"
```
