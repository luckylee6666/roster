import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('项目卡片可展开各家历史会话并续接指定 ID', () => {
  assert.match(html, /class="card-session-toggle"/);
  assert.match(html, /class="card-sessions"/);
  assert.match(html, /list_project_sessions/);
  assert.match(html, /resumeCliCommand\(session\.tool, session\.id\)/);
  assert.match(html, /createSession\(\{ cwd: project\.localPath, name: project\.name, autoCmd \}\)/);
  assert.match(html, /function openHistorySession/);
  assert.match(rust, /list_project_sessions/);
  assert.match(styles, /\.card-session-item:hover/);
});

test('历史会话支持搜索、预览、删除，并与运行中标签对齐', () => {
  assert.match(html, /filterHistoryGroups/);
  assert.match(html, /runningHistoryLookup/);
  assert.match(html, /preview_project_session/);
  assert.match(html, /delete_project_session/);
  assert.match(html, /运行中/);
  assert.match(html, /session\.runningId && sessions\.has\(session\.runningId\)/);
  assert.match(page, /id="session-preview-overlay"/);
  assert.match(rust, /preview_project_session/);
  assert.match(rust, /delete_project_session/);
  assert.match(styles, /\.card-session-item\.is-running/);
});

test('项目卡片可一键打开 Claude Codex Grok 主从套装', () => {
  assert.match(html, /function openProjectKit/);
  assert.match(html, /DEFAULT_PROJECT_KIT/);
  assert.match(html, /PROJECT_KIT_LAYOUT/);
  assert.match(html, /class="action-btn kit-btn"/);
  assert.match(html, /开一套/);
  assert.match(styles, /\.card-session-kit/);
});

test('打开任一 CLI 先聚焦运行中标签，否则续接最近会话，没有历史才新开', () => {
  assert.match(html, /function fetchProjectSessions/);
  assert.match(html, /launchCommandForProjectTool/);
  assert.match(html, /isRailCliTool\(tool\)/);
  assert.match(html, /findRunningProjectTool\(listLiveTerminals\(\), p\.localPath, tool\)/);
  assert.match(html, /name: p\.name/);
  assert.match(html, /forceNew \? \{ autoCmd: tool \} : launchCommandForProjectTool/);
  assert.match(html, /name: project\.name/);
});
