import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_GAME_ID, normalizeGameId } from '../src/games/game-ids.js';
import {
  COMPANION_WIDTH_MAX,
  COMPANION_WIDTH_MIN,
  DEFAULT_COMPANION_WIDTH,
  DEFAULT_WORKSPACE_MODE,
  WORKSPACE_MODES,
  WORKSPACE_MODE_STORAGE_KEYS,
  clampCompanionWidth,
  createCompanionSiteId,
  loadWorkspaceModeSettings,
  normalizeCompanionSite,
  normalizeCompanionSites,
  normalizeCompanionUrl,
  normalizeWorkspaceMode,
  safeStorageGet,
  safeStorageReadJson,
  safeStorageSet,
  safeStorageWriteJson,
  saveWorkspaceModeSettings,
} from '../src/workspace-mode-utils.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('模式只接受三个已定义值，其他输入回退普通模式', () => {
  assert.equal(normalizeWorkspaceMode(WORKSPACE_MODES.RELAX), 'relax');
  assert.equal(normalizeWorkspaceMode(WORKSPACE_MODES.ENTERTAINMENT), 'entertainment');
  assert.equal(normalizeWorkspaceMode('admin'), DEFAULT_WORKSPACE_MODE);
  assert.equal(normalizeWorkspaceMode(null), DEFAULT_WORKSPACE_MODE);
});

test('右栏宽度按百分比约束，并对无效值使用默认值', () => {
  assert.equal(clampCompanionWidth(1), COMPANION_WIDTH_MIN);
  assert.equal(clampCompanionWidth(99), COMPANION_WIDTH_MAX);
  assert.equal(clampCompanionWidth('41.8'), 42);
  assert.equal(clampCompanionWidth('bad'), DEFAULT_COMPANION_WIDTH);
});

test('网页 URL 只允许 HTTPS，或 localhost 的 HTTP 开发地址', () => {
  assert.equal(normalizeCompanionUrl(' https://www.douyin.com '), 'https://www.douyin.com/');
  assert.equal(normalizeCompanionUrl('http://localhost:5173/game'), 'http://localhost:5173/game');
  assert.equal(normalizeCompanionUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(normalizeCompanionUrl('http://[::1]:3000'), 'http://[::1]:3000/');
  assert.equal(normalizeCompanionUrl('http://example.com'), '');
  assert.equal(normalizeCompanionUrl('javascript:alert(1)'), '');
  assert.equal(normalizeCompanionUrl('https://user:secret@example.com'), '');
});

test('站点名称、URL 与 ID 均被规范化，非法站点被丢弃', () => {
  const ids = ['site-generated'];
  const idFactory = () => ids.shift();
  assert.deepEqual(normalizeCompanionSite({ name: '  我的   网站 ', url: 'https://example.com/a' }, { idFactory }), {
    id: 'site-generated', name: '我的 网站', url: 'https://example.com/a',
  });
  assert.equal(normalizeCompanionSite({ name: '危险', url: 'file:///tmp/a' }, { idFactory }), null);
});

test('站点列表只规范化传入项，并为重复 ID 重新生成标识', () => {
  let sequence = 0;
  const sites = normalizeCompanionSites([
    { id: 'news', name: '新闻', url: 'https://example.com' },
    { id: 'news', name: '第二个', url: 'https://example.org' },
  ], { idFactory: () => `site-${++sequence}` });
  assert.deepEqual(sites.map(site => site.id), ['news', 'site-1']);
});

test('重复 ID 持续碰撞时会有限重试并安全跳过站点', () => {
  let calls = 0;
  const sites = normalizeCompanionSites([
    { id: 'news', name: '新闻', url: 'https://example.com' },
    { id: 'news', name: '第二个', url: 'https://example.org' },
  ], {
    idFactory: () => {
      calls += 1;
      if (calls > 100) throw new Error('重复 ID 重试没有上限');
      return 'news';
    },
  });

  assert.deepEqual(sites, [{ id: 'news', name: '新闻', url: 'https://example.com/' }]);
  assert.equal(calls <= 100, true);
});

test('非法 ID 首次生成失败时跳过该站点并保留其他有效项', () => {
  let sites;
  assert.doesNotThrow(() => {
    sites = normalizeCompanionSites([
      { id: 'news', name: '新闻', url: 'https://example.com' },
      { id: '!', name: '无法修复', url: 'https://invalid-id.example.com' },
      { id: 'docs', name: '文档', url: 'https://docs.example.com' },
    ], { idFactory: () => { throw new Error('安全随机数不可用'); } });
  });

  assert.deepEqual(sites, [
    { id: 'news', name: '新闻', url: 'https://example.com/' },
    { id: 'docs', name: '文档', url: 'https://docs.example.com/' },
  ]);
});

test('重复合法 ID 重建失败时跳过冲突项并保留其他有效项', () => {
  let sites;
  assert.doesNotThrow(() => {
    sites = normalizeCompanionSites([
      { id: 'news', name: '新闻', url: 'https://example.com' },
      { id: 'news', name: '冲突新闻', url: 'https://duplicate.example.com' },
      { id: 'docs', name: '文档', url: 'https://docs.example.com' },
    ], { idFactory: () => { throw new Error('安全随机数不可用'); } });
  });

  assert.deepEqual(sites, [
    { id: 'news', name: '新闻', url: 'https://example.com/' },
    { id: 'docs', name: '文档', url: 'https://docs.example.com/' },
  ]);
});

test('站点标识使用 Web Crypto，不会依赖 Math.random', () => {
  const id = createCompanionSiteId({ randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef' });
  assert.equal(id, 'site-01234567-89ab-cdef-0123-456789abcdef');
  assert.throws(() => createCompanionSiteId({}), /安全随机数/);
});

test('存储读写失败或 JSON 损坏时不抛错，并回退为安全默认值', () => {
  const broken = { getItem: () => '{bad', setItem: () => { throw new Error('quota'); } };
  assert.equal(safeStorageGet('x', 'fallback', broken), '{bad');
  assert.deepEqual(safeStorageReadJson('x', [], broken), []);
  assert.equal(safeStorageSet('x', 'y', broken), false);
  assert.equal(safeStorageWriteJson('x', { y: 1 }, broken), false);
});

test('模式设置读取与保存会完整规范化，并保持用户独立站点', () => {
  const storage = memoryStorage({
    'workspace-mode': 'not-a-mode',
    'workspace-companion-width': '100',
    'workspace-companion-active-site': 'news',
    'workspace-companion-sites': JSON.stringify([{ id: 'news', name: '新闻', url: 'https://example.com' }]),
  });
  const loaded = loadWorkspaceModeSettings(storage);
  assert.equal(loaded.mode, 'normal');
  assert.equal(loaded.companionWidth, COMPANION_WIDTH_MAX);
  assert.deepEqual(loaded.sites.map(site => site.id), ['news']);
  assert.equal(loaded.activeSiteId, 'news');

  const result = saveWorkspaceModeSettings({
    mode: 'relax', companionWidth: 30, sites: loaded.sites, activeSiteId: loaded.activeSiteId,
  }, storage);
  assert.equal(result.saved, true);
  const reloaded = loadWorkspaceModeSettings(storage);
  assert.equal(reloaded.mode, 'relax');
  assert.equal(reloaded.companionWidth, 30);
  assert.deepEqual(reloaded.sites.map(site => site.id), ['news']);
  assert.equal(reloaded.activeSiteId, 'news');
  assert.ok(storage.getItem(WORKSPACE_MODE_STORAGE_KEYS.state));
});

test('游戏选择仅接受注册 ID，首次回退到俄罗斯方块', () => {
  assert.equal(DEFAULT_GAME_ID, 'tetris');
  assert.equal(normalizeGameId('2048'), '2048');
  assert.equal(normalizeGameId('snake'), 'tetris');
  assert.equal(normalizeGameId(null), 'tetris');
});

test('v1 设置迁移会移除旧内置抖音并保留用户网址', () => {
  const storage = memoryStorage({
    'workspace-mode-settings-v1': JSON.stringify({
      mode: 'relax',
      companionWidth: 44,
      sites: [
        { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' },
        { id: 'news', name: '新闻', url: 'https://example.com/' },
      ],
      activeSiteId: 'douyin',
    }),
  });
  const loaded = loadWorkspaceModeSettings(storage);
  assert.deepEqual(loaded.sites, [{ id: 'news', name: '新闻', url: 'https://example.com/' }]);
  assert.equal(loaded.activeSiteId, 'news');
  assert.equal(loaded.activeGameId, 'tetris');
});

test('v2 与 v1 同时存在时只使用 v2 设置', () => {
  const storage = memoryStorage({
    'workspace-mode-settings-v2': JSON.stringify({
      mode: 'entertainment',
      companionWidth: 46,
      sites: [{ id: 'video', name: '视频', url: 'https://video.example.com/' }],
      activeSiteId: 'video',
      activeGameId: '2048',
    }),
    'workspace-mode-settings-v1': JSON.stringify({
      mode: 'relax',
      companionWidth: 31,
      sites: [{ id: 'news', name: '新闻', url: 'https://news.example.com/' }],
      activeSiteId: 'news',
    }),
  });

  assert.deepEqual(loadWorkspaceModeSettings(storage), {
    mode: 'entertainment',
    companionWidth: 46,
    sites: [{ id: 'video', name: '视频', url: 'https://video.example.com/' }],
    activeSiteId: 'video',
    activeGameId: '2048',
  });
});

test('损坏 v2 会安全回退有效 v1 或旧独立键', () => {
  const fromV1 = loadWorkspaceModeSettings(memoryStorage({
    'workspace-mode-settings-v2': '{bad',
    'workspace-mode-settings-v1': JSON.stringify({
      mode: 'relax',
      companionWidth: 44,
      sites: [{ id: 'news', name: '新闻', url: 'https://example.com/' }],
      activeSiteId: 'news',
    }),
  }));
  assert.deepEqual(fromV1.sites, [{ id: 'news', name: '新闻', url: 'https://example.com/' }]);
  assert.equal(fromV1.activeSiteId, 'news');

  const fromIndependentKeys = loadWorkspaceModeSettings(memoryStorage({
    'workspace-mode-settings-v2': '{bad',
    'workspace-mode': 'relax',
    'workspace-companion-width': '43',
    'workspace-companion-sites': JSON.stringify([
      { id: 'news', name: '新闻', url: 'https://example.org/' },
    ]),
    'workspace-companion-active-site': 'news',
  }));
  assert.equal(fromIndependentKeys.mode, 'relax');
  assert.equal(fromIndependentKeys.companionWidth, 43);
  assert.deepEqual(fromIndependentKeys.sites, [{ id: 'news', name: '新闻', url: 'https://example.org/' }]);
  assert.equal(fromIndependentKeys.activeSiteId, 'news');
});

test('旧独立键迁移只移除精确旧内置抖音', () => {
  const storage = memoryStorage({
    'workspace-companion-sites': JSON.stringify([
      { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' },
      { id: 'news', name: '新闻', url: 'https://example.com/' },
    ]),
    'workspace-companion-active-site': 'douyin',
  });
  const loaded = loadWorkspaceModeSettings(storage);

  assert.deepEqual(loaded.sites, [{ id: 'news', name: '新闻', url: 'https://example.com/' }]);
  assert.equal(loaded.activeSiteId, 'news');
});

test('旧设置保留使用 douyin ID 的不同 HTTPS 网站', () => {
  const storage = memoryStorage({
    'workspace-mode-settings-v1': JSON.stringify({
      sites: [{ id: 'douyin', name: '自建视频', url: 'https://video.example.com/' }],
      activeSiteId: 'douyin',
    }),
  });

  const loaded = loadWorkspaceModeSettings(storage);
  assert.deepEqual(loaded.sites, [{ id: 'douyin', name: '自建视频', url: 'https://video.example.com/' }]);
  assert.equal(loaded.activeSiteId, 'douyin');
});

test('有效 v2 设置保留精确抖音对象', () => {
  const storage = memoryStorage({
    'workspace-mode-settings-v2': JSON.stringify({
      sites: [{ id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' }],
      activeSiteId: 'douyin',
    }),
  });

  const loaded = loadWorkspaceModeSettings(storage);
  assert.deepEqual(loaded.sites, [{ id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' }]);
  assert.equal(loaded.activeSiteId, 'douyin');
});

test('v2 设置支持空网址并保存最后选择的游戏', () => {
  const storage = memoryStorage();
  const saved = saveWorkspaceModeSettings({
    mode: 'entertainment',
    companionWidth: 46,
    sites: [],
    activeSiteId: 'missing',
    activeGameId: '2048',
  }, storage);
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.settings.sites, []);
  assert.equal(saved.settings.activeSiteId, null);
  assert.equal(saved.settings.activeGameId, '2048');
  assert.ok(storage.getItem('workspace-mode-settings-v2'));

  const loaded = loadWorkspaceModeSettings(storage);
  assert.deepEqual(loaded.sites, []);
  assert.equal(loaded.activeSiteId, null);
  assert.equal(loaded.activeGameId, '2048');
});

test('模式设置以单一版本化记录保存，避免多键部分写入', () => {
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem: (key, value) => writes.push([key, value]),
  };
  const result = saveWorkspaceModeSettings({
    mode: 'entertainment', companionWidth: 46, sites: [], activeSiteId: 'douyin',
  }, storage);

  assert.equal(result.saved, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], WORKSPACE_MODE_STORAGE_KEYS.state);
  assert.equal(JSON.parse(writes[0][1]).mode, 'entertainment');
});
