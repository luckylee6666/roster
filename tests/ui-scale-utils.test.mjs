import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_UI_SCALE,
  UI_SCALE_STORAGE_KEY,
  UI_SCALES,
  applyUiScale,
  normalizeUiScale,
  readUiScale,
  writeUiScale,
} from '../src/ui-scale-utils.js';

test('界面字号只接受标准/偏大，其余回退偏大', () => {
  assert.equal(normalizeUiScale('standard'), UI_SCALES.STANDARD);
  assert.equal(normalizeUiScale('large'), UI_SCALES.LARGE);
  assert.equal(normalizeUiScale(''), DEFAULT_UI_SCALE);
  assert.equal(normalizeUiScale('huge'), DEFAULT_UI_SCALE);
  assert.equal(normalizeUiScale(null), DEFAULT_UI_SCALE);
  assert.equal(DEFAULT_UI_SCALE, UI_SCALES.LARGE);
});

test('读存储失败或空值回退偏大，合法值原样返回', () => {
  assert.equal(readUiScale({ getItem: () => 'standard' }), UI_SCALES.STANDARD);
  assert.equal(readUiScale({ getItem: () => 'nope' }), DEFAULT_UI_SCALE);
  assert.equal(readUiScale({
    getItem() { throw new Error('blocked'); },
  }), DEFAULT_UI_SCALE);
});

test('写入会规范化，存储抛错也不抛给调用方', () => {
  const store = new Map();
  assert.equal(writeUiScale('standard', {
    setItem(key, value) { store.set(key, value); },
  }), UI_SCALES.STANDARD);
  assert.equal(store.get(UI_SCALE_STORAGE_KEY), UI_SCALES.STANDARD);
  assert.equal(writeUiScale('nope', {
    setItem() { throw new Error('quota'); },
  }), DEFAULT_UI_SCALE);
});

test('apply 把规范化后的值写到 html dataset', () => {
  const root = { dataset: {} };
  assert.equal(applyUiScale('standard', root), UI_SCALES.STANDARD);
  assert.equal(root.dataset.uiScale, 'standard');
  applyUiScale('zzz', root);
  assert.equal(root.dataset.uiScale, DEFAULT_UI_SCALE);
});
