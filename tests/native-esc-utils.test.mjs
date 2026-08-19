import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isNativeEscOverlayOpen,
  isXtermHelperTextarea,
  shouldWriteNativeEscapeToPty,
} from '../src/native-esc-utils.js';

function fakeRoot(matches = []) {
  return {
    querySelector(selector) {
      return matches.includes(selector) ? {} : null;
    },
  };
}

test('只有终端坞打开、会话在跑、无浮层且焦点在 xterm 时才把 ESC 写入 PTY', () => {
  assert.equal(shouldWriteNativeEscapeToPty({
    dockActive: true,
    sessionStatus: 'running',
    overlayOpen: false,
    terminalFocused: true,
  }), true);
  assert.equal(shouldWriteNativeEscapeToPty({
    dockActive: true,
    sessionStatus: 'exited',
    overlayOpen: false,
    terminalFocused: true,
  }), false);
  assert.equal(shouldWriteNativeEscapeToPty({
    dockActive: true,
    sessionStatus: 'running',
    overlayOpen: true,
    terminalFocused: true,
  }), false);
  assert.equal(shouldWriteNativeEscapeToPty({
    dockActive: false,
    sessionStatus: 'running',
    overlayOpen: false,
    terminalFocused: true,
  }), false);
  assert.equal(shouldWriteNativeEscapeToPty({
    dockActive: true,
    sessionStatus: 'running',
    overlayOpen: false,
    terminalFocused: false,
  }), false);
});

test('浮层选择器覆盖弹窗、片段菜单、主题/分屏/字号菜单和分组重命名', () => {
  assert.equal(isNativeEscOverlayOpen(fakeRoot()), false);
  assert.equal(isNativeEscOverlayOpen(fakeRoot(['#snippet-menu.active'])), true);
  assert.equal(isNativeEscOverlayOpen(fakeRoot(['#terminal-font-menu.active'])), true);
  assert.equal(isNativeEscOverlayOpen(fakeRoot(['.group-rename-input'])), true);
  assert.equal(isNativeEscOverlayOpen(null), false);
});

test('只把 xterm 隐藏输入框当成终端焦点', () => {
  assert.equal(isXtermHelperTextarea({ classList: { contains: name => name === 'xterm-helper-textarea' } }), true);
  assert.equal(isXtermHelperTextarea({ classList: { contains: () => false } }), false);
  assert.equal(isXtermHelperTextarea(null), false);
});

test('主流程监听 native-esc 并按判定结果写入 ESC', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const rust = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const native = await readFile(new URL('../src-tauri/src/native_esc.rs', import.meta.url), 'utf8');

  assert.match(rust, /mod native_esc;/);
  assert.match(rust, /native_esc::install_native_esc_monitor/);
  assert.match(native, /emit\("native-esc"/);
  assert.match(main, /listen\('native-esc'/);
  assert.match(main, /shouldWriteNativeEscapeToPty/);
  assert.match(main, /data: '\\x1b'/);
});
