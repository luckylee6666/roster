import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('顶栏提供代理开关，保存后新终端才带上代理环境', () => {
  assert.match(page, /id="proxy-settings-entry"/);
  assert.match(page, /id="proxy-enabled"/);
  assert.match(page, /启用代理/);
  assert.match(main, /get_proxy_settings/);
  assert.match(main, /save_proxy_settings/);
  assert.match(main, /get_proxy_shell_hook/);
  assert.match(main, /redactProxyUrl/);
  assert.match(main, /新启动的 CLI 会走代理/);
  assert.match(rust, /apply_to_command/);
  assert.match(rust, /get_proxy_shell_hook/);
  assert.match(rust, /get_proxy_settings/);
  assert.match(rust, /save_proxy_settings/);
  assert.match(rust, /proxy-settings\.json/);
  assert.match(styles, /\.proxy-switch-row input:checked/);
});
