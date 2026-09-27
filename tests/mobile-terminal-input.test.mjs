import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripMouseReports } from '../src-tauri/mobile/terminal.js';

test('手机终端镜像不把鼠标上报发给电脑，包括 xterm 合成的 NaN 坐标', () => {
  // 手机上滑时 xterm 6 beta 合成的坏滚轮上报：以前会在 CLI 输入框里留下「aN;NaNM」。
  assert.equal(stripMouseReports('\x1b[<64;NaN;NaNM'.repeat(6)), '');
  assert.equal(stripMouseReports('ls\x1b[<0;10;5Mabc\x1b[<0;10;5m'), 'lsabc');
  assert.equal(stripMouseReports('\x1b[<65;-Infinity;3M提交'), '提交');
  assert.equal(stripMouseReports('\x1b[M ¡€x'), 'x');
  assert.equal(stripMouseReports('\x1b[32;10;5Mok'), 'ok');
});

test('键盘输入和方向键原样发给电脑', () => {
  for (const keys of ['\x1b[A', '\x1b[1;5C', '\x1b[3~', '\x1b', '中文\r', '\x03', 'git status\r']) {
    assert.equal(stripMouseReports(keys), keys);
  }
});

test('触摸只在手机本地滚动，捕获阶段拦下不交给 xterm 的手势层', async () => {
  const source = await readFile(new URL('../src-tauri/mobile/terminal.js', import.meta.url), 'utf8');
  const touch = source.slice(source.indexOf('function setupTouchScroll'), source.indexOf('function ensureTerm'));
  assert.match(touch, /capture: true/);
  for (const name of ['touchstart', 'touchmove']) {
    assert.match(touch, new RegExp(`'${name}', event => \\{\\n\\s+event\\.stopPropagation\\(\\);`));
  }
  assert.match(touch, /const clear = event => \{\n\s+event\.stopPropagation\(\);/);
  assert.match(source, /const clean = stripMouseReports\(data\);\n\s+if \(clean\) sendInput\(clean\);/);
});
