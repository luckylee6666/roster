import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/cli-tools.js', import.meta.url), 'utf8');

test('项目卡片底部列出本机已装 CLI，一点即开', () => {
  assert.match(main, /class="card-cli-row"/);
  assert.match(main, /打开 CLI/);
  assert.match(main, /function cardCliButtonsHtml/);
  assert.match(main, /function refreshInstalledClis/);
  assert.match(main, /invoke\('list_installed_clis'/);
  assert.match(main, /void openTerminal\(p, btn\.dataset\.cmd\)/);
  assert.doesNotMatch(main, /class="action-btn terminal-btn"/);
  assert.match(styles, /\.card-cli-row\b/);
  assert.match(styles, /\.card-cli-btn\b/);
  assert.match(styles, /\.card-cli-label\b/);
  const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const detect = readFileSync(new URL('../src-tauri/src/cli_detect.rs', import.meta.url), 'utf8');
  assert.match(rust, /async fn list_installed_clis/);
  assert.match(rust, /generate_handler!\[[\s\S]*?list_installed_clis,/);
  assert.match(detect, /fn is_safe_cli_name/);
  assert.match(detect, /-ilc/);
});

test('启动菜单从 CLI 登记表渲染，支持搜索和键盘选择', () => {
  assert.match(page, /id="launch-search"/);
  assert.match(page, /id="launch-list"/);
  assert.doesNotMatch(page, /data-cmd="claude"/);
  assert.match(tools, /id: 'grok'/);
  assert.match(main, /from '\.\/cli-tools\.js'/);
  assert.match(main, /function renderLaunchMenu/);
  assert.match(main, /function pickLaunchTool/);
  assert.match(main, /visibleCliTools\(launchMenuQuery/);
  assert.match(main, /stepCliToolId\(tools, launchMenuActiveId, delta\)/);
  assert.match(styles, /\.launch-search\b/);
  assert.match(styles, /grid-template-columns: 1fr 1fr/);
});
