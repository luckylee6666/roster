import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('三种工作区模式完整接入终端布局与主流程', async () => {
  const [html, main, styles, controller] = await Promise.all([
    source('src/index.html'),
    source('src/main.js'),
    source('src/styles.css'),
    source('src/workspace-mode.js'),
  ]);

  for (const mode of ['normal', 'relax', 'entertainment']) {
    assert.match(html, new RegExp(`data-mode="${mode}"`));
  }
  assert.match(html, /id="companion-webview-slot"/);
  assert.match(html, /id="companion-empty-add-site"/);
  const statusTag = html.match(/<strong\b[^>]*\bid="companion-web-status"[^>]*>/)?.[0];
  assert.ok(statusTag);
  assert.match(statusTag, /\brole="status"/);
  assert.match(statusTag, /\baria-live="polite"/);
  assert.match(statusTag, /\baria-atomic="true"/);
  const siteModalTag = html.match(/<div\b[^>]*\bid="companion-site-modal"[^>]*>/)?.[0];
  assert.ok(siteModalTag);
  assert.match(siteModalTag, /\brole="dialog"/);
  assert.match(siteModalTag, /\baria-modal="true"/);
  assert.match(siteModalTag, /\baria-labelledby="companion-site-modal-title"/);
  assert.match(html, /id="companion-site-modal-title"/);
  assert.match(html, /id="companion-site-submit"/);
  assert.match(html, /id="companion-game-surface"/);
  assert.match(html, /id="companion-game-select"/);
  assert.match(controller, /createDefaultGameCatalog/);
  assert.match(controller, /gameCenter\.select/);
  assert.match(html, /id="companion-site-url" type="text" inputmode="url"/);
  assert.match(html, /id="companion-add-site"[^>]+aria-label="添加网页"/);
  assert.match(main, /installWorkspaceMode/);
  assert.match(main, /workspaceController\?\.setDockOpen\(true\)/);
  assert.match(main, /workspaceController\?\.setDockOpen\(false\)/);
  assert.match(main, /setFloatingUiOpen\('terminal-theme-menu', true\)/);
  assert.match(main, /setFloatingUiOpen\('snippet-menu', true\)/);
  assert.match(main, /openSnippetMenu\(anchorEl\)[\s\S]*?const webviewHidden = await workspaceController\?\.setFloatingUiOpen\('snippet-menu', true\);[\s\S]*?if \(webviewHidden === false\) \{\s*snippetMenuOpening = false;\s*return;\s*\}/);
  assert.match(main, /openThemeMenu\(\)[\s\S]*?const webviewHidden = await workspaceController\?\.setFloatingUiOpen\('terminal-theme-menu', true\);[\s\S]*?if \(webviewHidden === false\) \{\s*themeMenuOpening = false;\s*return;\s*\}/);
  assert.match(main, /function collapseDock\(\)\s*\{[\s\S]*?closeThemeMenu\(\);[\s\S]*?closeSnippetMenu\(\);[\s\S]*?setDockOpen\(false\)/);
  assert.match(main, /onModeChange:\s*\(\)\s*=>\s*\{[\s\S]*?characterTheme\.setDockOpen\(termEl\.dock\.classList\.contains\('active'\)\)/);
  assert.doesNotMatch(main, /mode === 'normal'\s*&&\s*termEl\.dock\.classList\.contains\('active'\)/);
  assert.match(controller, /onLayoutChange\(\)/);
  assert.match(styles, /\.terminal-dock\.has-companion \.companion-panel/);
  assert.match(styles, /\.terminal-dock\.has-companion \.terminal-theme-backdrop,\s*\.terminal-dock\.has-companion \.terminal-character-stage/);
  assert.match(styles, /right:\s*calc\(var\(--companion-panel-size\) \+ 6px\)/);
  assert.match(styles, /\.game-tetris__board/);
});

test('远程网页能力只授予本地主 WebView', async () => {
  const [capabilityText, cargo, rust] = await Promise.all([
    source('src-tauri/capabilities/default.json'),
    source('src-tauri/Cargo.toml'),
    source('src-tauri/src/lib.rs'),
  ]);
  const capability = JSON.parse(capabilityText);

  assert.deepEqual(capability.webviews, ['main']);
  assert.equal(Object.hasOwn(capability, 'windows'), false);
  assert.ok(capability.permissions.includes('core:webview:allow-create-webview'));
  assert.ok(capability.permissions.includes('core:webview:allow-webview-close'));
  assert.match(cargo, /features\s*=\s*\[[^\]]*"unstable"/s);
  assert.match(rust, /companion_navigation_policy/);
  assert.match(rust, /webview\.label\(\) != COMPANION_WEBVIEW_LABEL/);
  assert.match(rust, /url\.scheme\(\) == "https"/);
});

test('轻松模式使用原生 child WebView 并在弹窗与拖拽时隐藏', async () => {
  const [webview, controller] = await Promise.all([
    source('src/companion-webview.js'),
    source('src/workspace-mode.js'),
  ]);

  assert.match(webview, /new Webview\(parent, this\.label, options\)/);
  assert.match(webview, /focus:\s*false/);
  assert.match(controller, /overlayOpen/);
  assert.match(controller, /is-companion-resizing/);
  assert.match(controller, /queueWebTask\(\(\) => webview\.hide\(\)\)/);
  assert.match(controller, /pendingBounds = slotBounds\(\)/);
  assert.match(controller, /onFocusChanged/);
  assert.match(controller, /aria-valuetext/);
  assert.match(controller, /floatingUiReasons\.size === 0/);
  assert.match(controller, /await queueWebTask\(\(\) => webview\.hide\(\)\)/);
  assert.match(controller, /closeModeMenu\(\{ restore: false \}\)/);
});
