import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/cli-tools.js', import.meta.url), 'utf8');

test('项目卡片底部列出本机已装 CLI，一点即开', () => {
  assert.match(main, /class="card-foot"/);
  assert.match(main, /class="card-cli-row"/);
  assert.match(main, /function cardCliButtonsHtml/);
  assert.match(main, /function refreshInstalledClis/);
  assert.match(main, /invoke\('list_installed_clis'/);
  assert.match(main, /installedCliIds \?\?= \[\]/);
  assert.doesNotMatch(main, /installedCliIds = \[\.\.\.CLI_TOOL_IDS\]/);
  assert.match(main, /window\.addEventListener\('focus'[\s\S]*?refreshInstalledClis\(\{ force: true \}\)/);
  assert.match(main, /void openTerminal\(p, btn\.dataset\.cmd\)/);
  assert.doesNotMatch(main, /class="action-btn terminal-btn"/);
  // 按钮只保留工具色标，去掉重复文字、前缀标签和外层盒
  assert.doesNotMatch(main, /card-cli-label/);
  assert.doesNotMatch(main, /card-cli-name/);
  assert.match(styles, /\.card-foot\b/);
  assert.match(styles, /\.card-cli-row\b/);
  assert.match(styles, /\.card-cli-btn\b/);
  assert.match(styles, /\.term-tab-tool\.tool-mimo\b/);
  assert.doesNotMatch(styles, /\.card-cli-label\b/);
  const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const detect = readFileSync(new URL('../src-tauri/src/cli_detect.rs', import.meta.url), 'utf8');
  assert.match(rust, /async fn list_installed_clis/);
  assert.match(rust, /generate_handler!\[[\s\S]*?list_installed_clis,/);
  assert.match(detect, /fn is_safe_cli_name/);
  assert.match(detect, /-ilc/);
});

test('搜索式启动菜单已移除，卡片色标是唯一 CLI 入口', () => {
  assert.doesNotMatch(page, /id="launch-menu"/);
  assert.doesNotMatch(page, /id="launch-search"/);
  assert.doesNotMatch(main, /openLaunchMenu/);
  assert.doesNotMatch(main, /renderLaunchMenu/);
  assert.doesNotMatch(styles, /\.launch-menu\b/);
  assert.match(tools, /id: 'grok'/);
  assert.match(main, /from '\.\/cli-tools\.js'/);
});
