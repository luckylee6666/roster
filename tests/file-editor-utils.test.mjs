import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLineNumberText,
  editorChangedDuringSave,
  editorTextFromFile,
  fileTextFromEditor,
  textLineCount,
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

test('行号覆盖空文件及各种换行格式', () => {
  assert.equal(textLineCount(''), 1);
  assert.equal(textLineCount('a\nb\n'), 3);
  assert.equal(textLineCount('a\r\nb\rc'), 3);
  assert.equal(createLineNumberText(3), '1\n2\n3');
  assert.equal(createLineNumberText(0), '1');
});
