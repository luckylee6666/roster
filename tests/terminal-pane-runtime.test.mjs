import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('终端工具栏提供默认单窗和最多四窗格布局', () => {
  assert.match(html, /id="terminal-layout-btn"/);
  assert.match(html, /id="terminal-bodies"[^>]*data-layout="single"/);
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*data-layout="(single|columns|rows|grid)"/g)].map(match => match[1]),
    ['single', 'columns', 'rows', 'grid'],
  );
  assert.match(html, /更多会话继续在标签栏后台运行/);
});

test('每个可见会话使用独立终端宿主并通过布局状态机选择窗格', () => {
  assert.match(main, /terminalHostEl\.className = 'term-pane-terminal'/);
  assert.match(main, /term\.open\(terminalHostEl\)/);
  assert.match(main, /class="term-tab-pane"/);
  assert.match(main, /selectTerminalPaneSession\(\{[\s\S]*?activeSessionId:\s*activeSession,[\s\S]*?layout:\s*terminalPaneLayout/);
  assert.match(styles, /\.term-body\.pane-visible\s*\{\s*display:\s*flex/);
  assert.match(styles, /\.terminal-bodies\[data-layout="grid"\][^{]*\{[^}]*grid-template-columns:[^}]*grid-template-rows:/);
});

test('移出分屏不会关闭 PTY，只有关闭标签才结束会话', () => {
  const removeStart = main.indexOf('function removeSessionFromPane');
  const confirmStart = main.indexOf('function confirmCloseSession', removeStart);
  assert.ok(removeStart >= 0 && confirmStart > removeStart);
  assert.doesNotMatch(main.slice(removeStart, confirmStart), /terminal_close/);
  assert.match(main, /closeBackend:\s*id\s*=>\s*invoke\('terminal_close',\s*\{ id \}\)/);
  assert.match(main, /createTerminalSessionCloseCoordinator/);
  assert.match(main.slice(removeStart, confirmStart), /会话仍在后台运行/);
});

test('文件拖放命中具体窗格，分隔线拖动采用限频并在松手后强制同步', () => {
  assert.match(main, /terminalSessionAtViewportPoint\(x, y\)/);
  assert.match(main, /setTerminalPaneDragTarget\(targetAtNativePosition/);
  assert.match(styles, /\.term-body\.drag-target-pane::before/);
  assert.match(main, /const TERMINAL_RESIZE_INTERVAL_MS = 100/);
  assert.match(main, /function queueTerminalResize/);
  assert.match(main, /function setupTerminalPaneSplitters\([\s\S]*?const onUp[\s\S]*?scheduleFitVisibleSessions\(true\)/);
});

test('分屏文件预览只覆盖当前活动窗格', () => {
  assert.match(styles, /\.terminal-bodies:not\(\[data-layout="single"\]\)\.preview-obscured\s*\{\s*visibility:\s*visible/);
  assert.match(styles, /\.terminal-bodies:not\(\[data-layout="single"\]\)\.preview-obscured \.term-body\.active\s*\{\s*visibility:\s*hidden/);
  assert.match(main, /function positionFilePreview\(\)[\s\S]*?session\.bodyEl\.getBoundingClientRect\(\)/);
});
