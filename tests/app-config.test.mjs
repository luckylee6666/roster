import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('主窗口允许在放弃未保存修改后关闭窗口', async () => {
  const configUrl = new URL('../src-tauri/capabilities/default.json', import.meta.url);
  const capability = JSON.parse(await readFile(configUrl, 'utf8'));
  // Tauri v2 的 JS onCloseRequested 在窗口存在 JS 监听时由 Rust 阻止默认关闭，
  // handler 未 preventDefault 时由 JS wrapper 调 destroy() 真正销毁窗口；
  // close() 仅用于"放弃修改并退出"时再次触发 close-requested 流程。两者缺一不可。
  assert.ok(capability.permissions.includes('core:window:allow-close'));
  assert.ok(capability.permissions.includes('core:window:allow-destroy'));
});

test('系统退出始终回到前端本地状态确认，避免 dirty IPC 竞态', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const rust = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.doesNotMatch(main, /set_editor_dirty/);
  assert.match(
    main,
    /listen\('app-quit-requested'[\s\S]*?hasUnsavedFileChanges\(\)[\s\S]*?requestDiscardChangesAndExit\('app'\)[\s\S]*?confirm_app_exit/,
  );
  assert.match(
    main,
    /onCloseRequested[\s\S]*?hasUnsavedFileChanges\(\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?confirm_window_close/,
  );
  assert.match(
    rust,
    /RunEvent::ExitRequested[\s\S]*?!app_exit_is_confirmed\(app\)[\s\S]*?api\.prevent_exit\(\)[\s\S]*?request_app_quit_confirmation\(app\)/,
  );
});
