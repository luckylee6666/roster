import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('顶栏不再放页面标题，窄宽度把次要按钮收成图标', () => {
  assert.doesNotMatch(page, /class="header-title"/);
  assert.doesNotMatch(page, /工作台 \/ 项目管理/);
  assert.match(styles, /container-type:\s*inline-size/);
  assert.match(styles, /container-name:\s*app-header/);
  assert.match(styles, /@container app-header \(max-width: 860px\)/);
  assert.match(styles, /\.header-actions \.btn-label:not\(\.btn-label-keep\)/);
  assert.match(styles, /\.search-wrap[\s\S]*?margin-right:\s*auto/);
  assert.match(styles, /\.search-wrap[\s\S]*?height:\s*32px/);

  assert.match(page, /id="proxy-settings-entry"[\s\S]*?<span class="btn-label">代理<\/span>/);
  assert.match(page, /id="server-manage-entry"[\s\S]*?<span class="btn-label">服务器管理<\/span>/);
  assert.match(page, /id="add-btn"[\s\S]*?<span class="btn-label btn-label-keep">新建项目<\/span>/);
  assert.match(page, /id="scan-btn"[\s\S]*?<span class="btn-label">扫描导入<\/span>/);
});
