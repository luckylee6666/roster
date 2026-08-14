import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('顶栏标题与面包屑禁止折行，窄宽度收成图标以免挤成竖排', () => {
  assert.match(styles, /\.header-title h1[\s\S]*?white-space:\s*nowrap/);
  assert.match(styles, /\.breadcrumb[\s\S]*?white-space:\s*nowrap/);
  assert.match(styles, /container-type:\s*inline-size/);
  assert.match(styles, /container-name:\s*app-header/);
  assert.match(styles, /@container app-header \(max-width: 860px\)/);
  assert.match(styles, /\.header-actions \.btn-label:not\(\.btn-label-keep\)/);

  assert.match(page, /class="breadcrumb"[^>]*>工作台 \/ 项目管理/);
  assert.match(page, /id="proxy-settings-entry"[\s\S]*?<span class="btn-label">代理<\/span>/);
  assert.match(page, /id="server-manage-entry"[\s\S]*?<span class="btn-label">服务器管理<\/span>/);
  assert.match(page, /id="add-btn"[\s\S]*?<span class="btn-label btn-label-keep">新建项目<\/span>/);
  assert.match(page, /id="scan-btn"[\s\S]*?<span class="btn-label">扫描导入<\/span>/);
});
