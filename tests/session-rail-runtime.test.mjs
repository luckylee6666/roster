import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const pointer = readFileSync(new URL('../src/terminal-theme-pointer.js', import.meta.url), 'utf8');

test('文件树下方有可拖高度、可独立收起的会话条', () => {
  assert.match(page, /id="session-rail"/);
  assert.match(page, /id="session-rail-body"/);
  assert.match(page, /id="session-rail-splitter"/);
  assert.match(page, /id="session-rail-toggle"/);
  assert.match(main, /from '\.\/session-rail-utils\.js'/);
  assert.match(main, /function setupSessionRail\(/);
  assert.match(main, /function syncSessionRail\(/);
  assert.match(main, /SESSION_RAIL_HEIGHT_KEY/);
  assert.match(main, /SESSION_RAIL_HIDDEN_KEY/);
  assert.match(main, /is-session-rail-resizing/);
  assert.match(styles, /\.session-rail\b/);
  assert.match(styles, /\.session-rail-splitter\b/);
  assert.match(styles, /\.session-rail\.is-collapsed/);
  assert.match(styles, /\.terminal-tree\.is-rail-collapsed \.session-rail-splitter/);
  assert.match(pointer, /session-rail-splitter/);
  assert.match(pointer, /is-session-rail-resizing/);
});

test('会话条只做聚焦和续接，不复制卡片上的搜索预览删除', () => {
  assert.match(main, /buildSessionRailModel\(/);
  assert.match(main, /sessionRailAction\(/);
  assert.match(main, /function openRailSession\(/);
  assert.match(main, /activateSession\(action\.terminalId\)/);
  assert.match(main, /resumeCliCommand\(action\.tool, action\.sessionId\)/);
  assert.match(main, /projectTabName\(cwd, action\.tool\)/);
  assert.match(main, /list_project_sessions/);
  assert.match(main, /进行中/);
  assert.match(main, /最近/);
  assert.doesNotMatch(main, /session-rail[\s\S]{0,400}card-session-delete/);
  assert.doesNotMatch(page, /id="session-rail"[\s\S]*card-session-search/);
  assert.match(styles, /\.session-rail-item:hover/);
  assert.match(styles, /\.session-rail-item\.is-active/);
});

test('会话条在退出、加载中、删除和打开坞时按状态刷新', () => {
  assert.match(main, /s\.status = 'exited'[\s\S]{0,200}invalidateTerminalProjectSessionHistory\(s\)/);
  assert.match(main, /if \(historyCwd\) reloadVisibleProjectSessionHistory\(historyCwd\)/);
  assert.match(main, /sessionRailViewLoading\(cwd, history, sessionRailLoads\)/);
  assert.match(main, /if \(card && expandedProjectIds\.has\(project\.id\)\) await expandProjectSessions/);
  assert.match(main, /else if \(sameProjectCwd\(treeRoot, project\.localPath\)\) void syncSessionRail/);
  assert.match(main, /function invalidateProjectSessionHistory\([\s\S]*projectSessionCache\.delete\(project\.id\)/);
  assert.match(main, /const sessionRailLoads = projectSessionLoads/);
  assert.match(main, /function applySessionRailHeight\(/);
  assert.match(main, /function openDock\([\s\S]*?applySessionRailHeight\(\)/);
  // 高度只在拖拽松开时落盘，布局变化不回写，避免把用户选的高度夹小
  assert.doesNotMatch(main, /persist: true/);
});
