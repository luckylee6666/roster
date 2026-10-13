import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFileDropPoint } from '../src/native-file-drop.js';

for (const dpr of [1, 1.5, 2]) {
  test(`Windows 文件拖放坐标按 DPR ${dpr} 从物理像素转换`, () => {
    assert.deepEqual(
      nativeFileDropPoint({ x: 240 * dpr, y: 90 * dpr }, true, dpr),
      { x: 240, y: 90 },
    );
  });
}

for (const platform of ['macOS', 'Linux']) {
  test(`${platform} 文件拖放坐标保留逻辑坐标，不按视网膜 DPR 缩放`, () => {
    assert.deepEqual(
      nativeFileDropPoint({ x: 240, y: 90 }, false, 2),
      { x: 240, y: 90 },
    );
  });
}

test('缺失、非有限或非数字坐标安全返回 null', () => {
  for (const position of [
    undefined,
    null,
    {},
    { x: NaN, y: 1 },
    { x: 1, y: Infinity },
    { x: '240', y: 90 },
  ]) {
    assert.equal(nativeFileDropPoint(position, true, 2), null);
  }
});
