import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('项目卡片和终端坞提供协作会话入口', () => {
  assert.match(main, /function openOrchestraModal/);
  assert.match(main, /function startOrchestraFromModal/);
  assert.match(main, /openProjectKit\(project, \{ forceNew: true \}\)/);
  assert.match(main, /function sendOrchestra/);
  assert.match(main, /orchestraBrainPrompt/);
  assert.match(main, /orchestraWorkerPrompt/);
  assert.match(main, /class="action-btn orchestra-btn-card"/);
  assert.match(main, /开协作/);
  assert.match(page, /id="orchestra-overlay"/);
  assert.match(page, /id="orchestra-bar"/);
  assert.match(page, /发给大脑/);
  assert.match(page, /派活/);
  assert.match(styles, /\.orchestra-bar\.active/);
  assert.match(styles, /\.term-pane-role\[data-role="brain"\]/);
});

test('协作文件只写在项目 \.vibe/orchestra 且不进 Git', () => {
  assert.match(rust, /ensure_orchestra/);
  assert.match(rust, /write_orchestra_file/);
  assert.match(rust, /read_orchestra_file/);
  assert.match(ignore, /^\.vibe\/$/m);
});
