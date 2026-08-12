import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { setFilePreviewLayerOpen } from '../src/file-preview-layer.js';

function fakeElement() {
  const classes = new Set();
  return {
    classes,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

test('文件预览打开时隐藏 WebGL 终端层，关闭时同步恢复', () => {
  const preview = fakeElement();
  const terminalBodies = fakeElement();

  setFilePreviewLayerOpen(preview, terminalBodies, true);
  assert.ok(preview.classes.has('active'));
  assert.ok(terminalBodies.classes.has('preview-obscured'));

  setFilePreviewLayerOpen(preview, terminalBodies, false);
  assert.ok(!preview.classes.has('active'));
  assert.ok(!terminalBodies.classes.has('preview-obscured'));
});

test('预览遮挡类从渲染树隐藏终端，主流程关闭后刷新终端', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

  assert.match(styles, /\.terminal-bodies\.preview-obscured\s*\{\s*visibility:\s*hidden/);
  assert.match(main, /setFilePreviewLayerOpen\(termEl\.preview, termEl\.bodies, true\)/);
  assert.match(main, /setFilePreviewLayerOpen\(termEl\.preview, termEl\.bodies, false\)[\s\S]*?session\.term\.refresh/);
});

test('源码预览和编辑态都提供独立行号栏', async () => {
  const [html, styles, main] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="file-preview-line-numbers"[^>]*aria-hidden="true"/);
  assert.match(html, /id="file-editor-line-numbers"[^>]*aria-hidden="true"/);
  assert.match(styles, /\.file-preview-line-numbers[\s\S]*?position:\s*sticky/);
  assert.match(main, /previewLineNumbers\.textContent\s*=\s*createLineNumberText/);
  assert.match(main, /editorLineNumbers\.scrollTop\s*=\s*termEl\.editorInput\.scrollTop/);
});
