import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  THEME_MODES,
  THEME_STORAGE_KEY,
  applyThemeMode,
  installThemeMode,
  nextThemeMode,
  normalizeThemeMode,
  readThemeMode,
  themeModeLabel,
  writeThemeMode,
} from '../src/theme-mode.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('主题取值归一化，未知输入回退跟随系统', () => {
  assert.deepEqual(THEME_MODES, ['system', 'light', 'dark']);
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode(' LIGHT '), 'light');
  assert.equal(normalizeThemeMode('sepia'), 'system');
  assert.equal(normalizeThemeMode(null), 'system');
  assert.equal(themeModeLabel('dark'), '深色');
  assert.equal(themeModeLabel('nope'), '跟随系统');
});

test('点一次换一档，三档循环', () => {
  assert.equal(nextThemeMode('system'), 'light');
  assert.equal(nextThemeMode('light'), 'dark');
  assert.equal(nextThemeMode('dark'), 'system');
  assert.equal(nextThemeMode('坏值'), 'light');
});

test('只有显式选择才写根节点，跟随系统时交回 prefers-color-scheme', () => {
  const root = { dataset: { theme: 'dark' } };
  assert.equal(applyThemeMode(root, 'light'), 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(applyThemeMode(root, 'system'), 'system');
  assert.equal('theme' in root.dataset, false);
  assert.equal(applyThemeMode(null, 'dark'), 'dark');
});

test('存储不可用时不抛错，读回跟随系统', () => {
  const broken = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(readThemeMode(broken), 'system');
  assert.equal(writeThemeMode(broken, 'dark'), 'dark');
  assert.equal(readThemeMode(undefined), 'system');
});

test('装上后按存储恢复，点击切换并持久化', () => {
  const values = new Map([[THEME_STORAGE_KEY, 'dark']]);
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const label = { textContent: '' };
  const listeners = {};
  const button = {
    dataset: {},
    title: '',
    setAttribute() {},
    querySelector: () => label,
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  const root = { dataset: {} };
  const controller = installThemeMode({ document: { documentElement: root }, storage, button });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(label.textContent, '深色');
  assert.equal(button.dataset.themeMode, 'dark');

  listeners.click();
  assert.equal(controller.current(), 'system');
  assert.equal('theme' in root.dataset, false);
  assert.equal(values.get(THEME_STORAGE_KEY), 'system');
  assert.equal(label.textContent, '跟随系统');
});

test('深色令牌只覆盖同名变量，且只作用于对话工作台', async () => {
  const css = await read('src/styles.css');
  assert.match(css, /:root \{[\s\S]*?--chat-ink: #1b2430;/);
  assert.match(css, /:root \{[\s\S]*?color-scheme: light;/);
  assert.match(
    css,
    /@media \(prefers-color-scheme: dark\) \{\s*html\[data-app-view="conversation"\]:not\(\[data-theme="light"\]\) \{/,
  );
  assert.match(css, /html\[data-app-view="conversation"\]\[data-theme="dark"\] \{/);
  // 令牌之外不该在深色块里写死具体控件样式
  const darkBlocks = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.doesNotMatch(darkBlocks, /\.conversation-message \{/);
  assert.match(css, /\.conversation-history-tool\[data-tool="claude"\] \{ color: var\(--tool-claude-ink\)/);
});

test('主题在样式表之前恢复，并接进应用外壳', async () => {
  const [html, main] = await Promise.all([read('src/index.html'), read('src/main.js')]);
  const preload = html.indexOf("localStorage.getItem('roster-theme')");
  const cssLink = html.indexOf('href="styles.css"');
  assert.ok(preload > 0 && preload < cssLink, '主题必须在样式表加载前恢复，避免首屏闪白');
  assert.match(html, /id="conversation-theme-switch"/);
  assert.match(main, /installThemeMode\(\{/);
});
