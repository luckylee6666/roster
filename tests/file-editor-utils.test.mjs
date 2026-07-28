import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editorChangedDuringSave,
  editorTextFromFile,
  fileTextFromEditor,
} from '../src/file-editor-utils.js';

test('编辑器统一显示换行，但保存时恢复原换行风格', () => {
  assert.equal(editorTextFromFile('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(fileTextFromEditor('a\nb\n', 'lf'), 'a\nb\n');
  assert.equal(fileTextFromEditor('a\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(fileTextFromEditor('a\nb\n', 'cr'), 'a\rb\r');
});

test('保存期间产生的新输入会被识别并保留为未保存状态', () => {
  const submitted = 'name = "first"\n';
  assert.equal(editorChangedDuringSave(submitted, submitted), false);
  assert.equal(editorChangedDuringSave(submitted, `${submitted}debug = true\n`), true);
});
