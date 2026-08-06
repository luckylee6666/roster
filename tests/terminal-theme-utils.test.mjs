import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  clearImageTerminalCellBackgrounds,
  scheduleImageTerminalCellBackgroundSync,
  syncImageTerminalCellBackgrounds,
  translucentTerminalBackground,
} from '../src/terminal-theme-utils.js';

const TRANSLUCENT_CLASS = 'terminal-cell-bg-translucent';
const EXPECTED_CELL_SELECTOR = [
  `span.${TRANSLUCENT_CLASS}`,
  'span[style*="background-color"]',
  'span[class*="xterm-bg-"]',
].join(',');

class FakeClassList {
  constructor(names = []) { this.names = new Set(names); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  [Symbol.iterator]() { return this.names[Symbol.iterator](); }
}

class FakeStyle {
  constructor(backgroundColor = '') {
    this.backgroundColor = backgroundColor;
    this.properties = new Map();
  }
  setProperty(name, value) { this.properties.set(name, value); }
  removeProperty(name) { this.properties.delete(name); }
  getPropertyValue(name) { return this.properties.get(name) || ''; }
}

class FakeCell {
  constructor({ backgroundColor = '', classes = [], computedBackground = 'rgba(0, 0, 0, 0)' } = {}) {
    this.classList = new FakeClassList(classes);
    this.style = new FakeStyle(backgroundColor);
    this.dataset = {};
    this.computedBackground = computedBackground;
  }
}

function isBackgroundCell(cell) {
  return cell.classList.contains(TRANSLUCENT_CLASS)
    || !!cell.style.backgroundColor
    || Array.from(cell.classList).some(name => name.startsWith('xterm-bg-'));
}

class FakeRow {
  constructor(cells) { this.cells = cells; this.queryCount = 0; }
  querySelectorAll(selector) {
    assert.equal(selector, EXPECTED_CELL_SELECTOR);
    this.queryCount++;
    return this.cells.filter(isBackgroundCell);
  }
}

class FakeRows extends FakeRow {
  constructor(rows) { super(rows.flatMap(row => row.cells)); this.children = rows; }
}

class FakeRoot {
  constructor(rows) { this.rows = new FakeRows(rows); }
  querySelector(selector) { return selector === '.xterm-rows' ? this.rows : null; }
  querySelectorAll(selector) {
    assert.equal(selector, `.${TRANSLUCENT_CLASS}`);
    return this.rows.cells.filter(cell => cell.classList.contains(TRANSLUCENT_CLASS));
  }
}

test('中性 TUI 背景使用较低透明度', () => {
  assert.equal(
    translucentTerminalBackground('rgb(28, 28, 28)'),
    'rgba(28, 28, 28, 0.18)',
  );
});

test('彩色 TUI 背景保留色相并限制透明度', () => {
  assert.equal(
    translucentTerminalBackground('rgb(0, 95, 0)'),
    'rgba(0, 95, 0, 0.3)',
  );
});

test('不会把原本更透明的背景改深', () => {
  assert.equal(
    translucentTerminalBackground('rgba(255, 0, 0, 0.12)'),
    'rgba(255, 0, 0, 0.12)',
  );
});

test('忽略透明或无法解析的颜色', () => {
  assert.equal(translucentTerminalBackground('rgba(0, 0, 0, 0)'), '');
  assert.equal(translucentTerminalBackground('transparent'), '');
  assert.equal(translucentTerminalBackground('rgb(1..2, 0, 0)'), '');
  assert.equal(translucentTerminalBackground('rgb(NaN, 0, 0)'), '');
});

test('支持空格语法并安全收窄越界值', () => {
  assert.equal(
    translucentTerminalBackground('rgb(300 -5 20 / .5)'),
    'rgba(255, 0, 20, 0.3)',
  );
});

test('只同步 xterm 本次重绘行，并兼容真彩色与 256 色背景', () => {
  const untouched = new FakeCell({ backgroundColor: 'rgb(28, 28, 28)', computedBackground: 'rgb(28, 28, 28)' });
  const trueColor = new FakeCell({ backgroundColor: 'rgb(28, 28, 28)', computedBackground: 'rgb(28, 28, 28)' });
  const indexed = new FakeCell({ classes: ['xterm-bg-22'], computedBackground: 'rgb(0, 95, 0)' });
  const rows = [new FakeRow([untouched]), new FakeRow([trueColor, indexed])];
  const root = new FakeRoot(rows);
  let styleReads = 0;
  const readStyle = element => { styleReads++; return { backgroundColor: element.computedBackground }; };

  syncImageTerminalCellBackgrounds(root, { start: 1, end: 1 }, readStyle);

  assert.equal(rows[0].queryCount, 0);
  assert.equal(rows[1].queryCount, 1);
  assert.equal(untouched.classList.contains(TRANSLUCENT_CLASS), false);
  assert.equal(trueColor.style.getPropertyValue('--terminal-cell-background'), 'rgba(28, 28, 28, 0.18)');
  assert.equal(indexed.style.getPropertyValue('--terminal-cell-background'), 'rgba(0, 95, 0, 0.3)');
  assert.equal(styleReads, 2);

  syncImageTerminalCellBackgrounds(root, { start: 1, end: 1 }, readStyle);
  assert.equal(styleReads, 2, '缓存命中时不应再次读取计算样式');
});

test('离开图片主题时清理覆盖并保留 xterm 原始背景', () => {
  const trueColor = new FakeCell({
    backgroundColor: 'rgb(28, 28, 28)',
    computedBackground: 'rgb(28, 28, 28)',
  });
  const indexed = new FakeCell({
    classes: ['xterm-bg-22'],
    computedBackground: 'rgb(0, 95, 0)',
  });
  const root = new FakeRoot([new FakeRow([trueColor, indexed])]);
  syncImageTerminalCellBackgrounds(root, null, element => ({ backgroundColor: element.computedBackground }));

  clearImageTerminalCellBackgrounds(root);

  assert.equal(trueColor.classList.contains(TRANSLUCENT_CLASS), false);
  assert.equal(trueColor.style.getPropertyValue('--terminal-cell-background'), '');
  assert.equal(trueColor.style.backgroundColor, 'rgb(28, 28, 28)');
  assert.deepEqual(trueColor.dataset, {});
  assert.equal(indexed.classList.contains(TRANSLUCENT_CLASS), false);
  assert.equal(indexed.classList.contains('xterm-bg-22'), true);
  assert.equal(indexed.style.getPropertyValue('--terminal-cell-background'), '');
  assert.deepEqual(indexed.dataset, {});
});

test('缺少 rows 或重绘范围无交集时安全跳过', () => {
  const cell = new FakeCell({ backgroundColor: 'rgb(28, 28, 28)' });
  const row = new FakeRow([cell]);
  const root = new FakeRoot([row]);

  syncImageTerminalCellBackgrounds({ querySelector: () => null });
  syncImageTerminalCellBackgrounds(root, { start: 4, end: 2 });

  assert.equal(row.queryCount, 0);
  assert.equal(cell.classList.contains(TRANSLUCENT_CLASS), false);
});

test('背景同步在同一帧 paint 前合并重绘范围', async () => {
  const state = {};
  const flushed = [];

  scheduleImageTerminalCellBackgroundSync(state, { start: 8, end: 10 }, range => flushed.push(range));
  scheduleImageTerminalCellBackgroundSync(state, { start: 3, end: 12 }, range => flushed.push(range));

  assert.deepEqual(flushed, [], '同步应先合并当前调用栈内的重绘事件');
  await Promise.resolve();
  assert.deepEqual(flushed, [{ start: 3, end: 12 }]);
  assert.equal(state.imageBgSyncPending, false);
});

test('全量背景同步覆盖同一轮内的局部重绘请求', async () => {
  const state = {};
  const flushed = [];

  scheduleImageTerminalCellBackgroundSync(state, { start: 2, end: 4 }, range => flushed.push(range));
  scheduleImageTerminalCellBackgroundSync(state, null, range => flushed.push(range));
  scheduleImageTerminalCellBackgroundSync(state, { start: 7, end: 9 }, range => flushed.push(range));

  await Promise.resolve();
  assert.deepEqual(flushed, [null]);
});

test('计算背景透明时不创建覆盖', () => {
  const cell = new FakeCell({
    classes: ['xterm-bg-0'],
    computedBackground: 'rgba(0, 0, 0, 0)',
  });
  const root = new FakeRoot([new FakeRow([cell])]);

  syncImageTerminalCellBackgrounds(root, null, element => ({ backgroundColor: element.computedBackground }));

  assert.equal(cell.classList.contains(TRANSLUCENT_CLASS), false);
  assert.equal(cell.style.getPropertyValue('--terminal-cell-background'), '');
  assert.deepEqual(cell.dataset, {});
});

test('半透明 CSS 只在图片主题门控下生效', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const overrideRules = Array.from(css.matchAll(/([^{}]+)\{\s*background-color:\s*var\(--terminal-cell-background\)\s*!important;\s*\}/g));

  assert.equal(overrideRules.length, 1);
  assert.match(overrideRules[0][1], /\.terminal-bodies\.has-bg\b/);
  assert.match(overrideRules[0][1], /\.terminal-cell-bg-translucent\b/);
});
