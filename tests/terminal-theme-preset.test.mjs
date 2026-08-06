import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { seedThemePresets } from '../src/terminal-theme-presets.js';

async function pngSize(url) {
  const data = await readFile(url);
  assert.deepEqual(Array.from(data.subarray(1, 4)), [80, 78, 71]);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test('黛月华裳背景与图标满足主题资产规格', async () => {
  const background = await pngSize(new URL('../src/assets/term-bg-guofeng-beauty-retina.png', import.meta.url));
  const icon = await pngSize(new URL('../src/assets/theme-icon-guofeng-beauty.png', import.meta.url));

  assert.equal(background.width, 3584);
  assert.equal(background.height, 2240);
  assert.ok(background.width / background.height > 1.58);
  assert.ok(background.width / background.height < 1.62);
  assert.equal(icon.width, icon.height);
  assert.ok(icon.width >= 56 && icon.width <= 128);
});

test('国风预装主题完整接入 base、种子、DIY 和专属界面', async () => {
  const [main, css] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(main, /'guofeng'\s*:\s*\{/);
  assert.match(main, /id:\s*'guofeng-beauty-default'/);
  assert.match(main, /'term-guofeng-beauty-seeded'/);
  assert.match(main, /\['guofeng',\s*'黛月华裳'\]/);
  assert.match(main, /`builtin:\$\{GUOFENG_BACKGROUND\}`/);
  assert.match(main, /GUOFENG_BACKGROUND\s*=\s*'assets\/term-bg-guofeng-beauty-retina\.png'/);
  assert.match(main, /LEGACY_GUOFENG_BACKGROUND\s*=\s*'assets\/term-bg-guofeng-beauty\.png'/);
  assert.match(main, /t\.image\s*===\s*`builtin:\$\{LEGACY_GUOFENG_BACKGROUND\}`[\s\S]*?t\.image\s*=\s*GUOFENG_PRESET\.image/);
  assert.match(main, /cursorFx:\s*'guofeng'/);
  assert.match(main, /cursorBlink:\s*false/);
  assert.match(main, /cursorBlink:\s*base\.cursorBlink\s*!==\s*false/);
  assert.match(main, /s\.term\.options\.cursorBlink\s*=\s*def\.cursorBlink\s*!==\s*false/);
  assert.match(css, /\[data-theme-ui="guofeng"\]/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.tree-splitter\s*\{\s*cursor:\s*ew-resize\s*!important;/);
});

test('预装主题首次保存成功后才写入一次性标记', async () => {
  const marked = [];
  let saved = null;
  const preset = { id: 'guofeng-beauty-default', name: '黛月华裳' };
  const result = await seedThemePresets({
    themes: [],
    entries: [['term-guofeng-beauty-seeded', preset]],
    hasMarker: () => false,
    markMarker: marker => marked.push(marker),
    saveThemes: async themes => { saved = themes; return themes; },
  });

  assert.equal(result.saved, true);
  assert.deepEqual(saved, [preset]);
  assert.deepEqual(marked, ['term-guofeng-beauty-seeded']);
});

test('预装主题保存失败时不写标记并保留下次重试条件', async () => {
  const marked = [];
  const result = await seedThemePresets({
    themes: [],
    entries: [['term-guofeng-beauty-seeded', { id: 'guofeng-beauty-default' }]],
    hasMarker: () => false,
    markMarker: marker => marked.push(marker),
    saveThemes: async () => { throw new Error('disk full'); },
  });

  assert.equal(result.saved, false);
  assert.match(result.error.message, /disk full/);
  assert.deepEqual(marked, []);
  assert.equal(result.themes[0].id, 'guofeng-beauty-default');
});

test('同 ID 用户主题不被覆盖，用户删除后的预装主题不复活', async () => {
  const existing = { id: 'guofeng-beauty-default', name: '我的国风', dim: 0.5 };
  let saveCalls = 0;
  const preserved = await seedThemePresets({
    themes: [existing],
    entries: [['term-guofeng-beauty-seeded', { id: existing.id, name: '默认国风' }]],
    hasMarker: () => false,
    markMarker: () => {},
    saveThemes: async themes => { saveCalls++; return themes; },
  });
  assert.deepEqual(preserved.themes, [existing]);

  const deleted = await seedThemePresets({
    themes: [],
    entries: [['term-guofeng-beauty-seeded', { id: existing.id }]],
    hasMarker: () => true,
    markMarker: () => {},
    saveThemes: async themes => { saveCalls++; return themes; },
  });
  assert.deepEqual(deleted.themes, []);
  assert.equal(saveCalls, 0);
});
