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

test('产品显示名为 Roster，bundle 与 crate 已切走旧名', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(config.productName, 'Roster');
  assert.equal(config.identifier, 'com.lucky.roster');
  assert.equal(config.app.windows[0].title, 'Roster');
  assert.match(html, /<title>Roster<\/title>/);
  assert.match(html, /<span>Roster<\/span>/);
  assert.match(cargo, /^name = "roster"$/m);
  assert.match(cargo, /^name = "roster_lib"$/m);
  assert.equal(pkg.name, 'roster');
  assert.doesNotMatch(html, /Vibe Coding/);
});

test('启动菜单包含 Grok，macOS 发版固定 adhoc 签名', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const workflow = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');

  const tools = await readFile(new URL('../src/cli-tools.js', import.meta.url), 'utf8');
  assert.match(html, /id="launch-search"/);
  assert.match(tools, /id: 'grok'/);
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.equal(config.bundle.macOS.entitlements, undefined);
  assert.doesNotMatch(workflow, /APPLE_CERTIFICATE/);
  assert.match(workflow, /ad-hoc 签名/);
});
