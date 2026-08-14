import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('终端工具栏提供字号菜单，默认偏大且只放大工作台', () => {
  assert.match(page, /data-ui-scale="large"/);
  assert.match(page, /id="terminal-font-btn"/);
  assert.match(page, /id="terminal-font-menu"/);
  assert.match(page, /终端字号/);
  assert.match(page, /界面字号/);
  assert.match(page, /data-ui-scale="standard">标准/);
  assert.match(page, /data-ui-scale="large">偏大/);
  assert.doesNotMatch(page, /class="sider-foot"/);
  assert.match(page, /localStorage\.getItem\('ui-scale'\)/);
  assert.match(main, /from '\.\/ui-scale-utils\.js'/);
  assert.match(main, /installUiScale\(/);
  assert.match(main, /openFontMenu\(/);
  assert.match(main, /setTermFontSize\(currentFontSize \+ 1\)/);
  assert.match(main, /writeUiScale\(/);
  assert.match(styles, /--fs-body:\s*16px/);
  assert.doesNotMatch(styles, /--fs-crumb/);
  assert.match(styles, /html\[data-ui-scale="standard"\]/);
  assert.match(styles, /\.term-font-menu\.active/);
  assert.match(styles, /\.sider-logo[\s\S]*?font-size:\s*var\(--fs-logo\)/);
  assert.match(styles, /\.menu-child-item[\s\S]*?font-size:\s*var\(--fs-meta\)/);
  assert.match(styles, /\.card-group[\s\S]*?font-size:\s*var\(--fs-tiny\)/);
  assert.match(styles, /\.confirm-msg p[\s\S]*?font-size:\s*var\(--fs-body\)/);
  assert.match(styles, /\.message[\s\S]*?font-size:\s*var\(--fs-body\)/);
});
