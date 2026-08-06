import assert from 'node:assert/strict';
import test from 'node:test';

import { createGameCenter, createDefaultGameCatalog } from '../src/games/game-center.js';

class FakeElement {
  constructor() { this.children = []; this.dataset = {}; this.attributes = new Map(); this.className = ''; this.textContent = ''; this.parentNode = null; }
  append(...children) { children.forEach(child => { child.parentNode = this; this.children.push(child); }); }
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function createFakeDocument() { return { createElement: () => new FakeElement() }; }
function createFakeGame() {
  const state = { mounted: 0, paused: 0, resumed: 0, destroyed: 0 };
  return { state, mount() { state.mounted += 1; }, pause() { state.paused += 1; }, resume() { state.resumed += 1; }, destroy() { state.destroyed += 1; }, getState() { return { ...state }; } };
}

function catalogEntry(id, game, overrides = {}) {
  return { id, name: id, hint: `${id} hint`, factory: () => game, ...overrides };
}

test('游戏中心按需创建，切换时暂停旧游戏并恢复新游戏', () => {
  const documentRef = createFakeDocument();
  const host = documentRef.createElement('div');
  const tetris = createFakeGame();
  const game2048 = createFakeGame();
  const center = createGameCenter({ documentRef, catalog: [
    { id: 'tetris', name: '俄罗斯方块', hint: '方向键 / 空格', factory: () => tetris },
    { id: '2048', name: '2048', hint: '方向键 / 滑动', factory: () => game2048 },
  ] });

  center.mount(host);
  assert.equal(center.select('tetris'), 'tetris');
  center.resume();
  assert.equal(tetris.state.resumed, 1);
  assert.equal(center.select('2048'), '2048');
  assert.equal(tetris.state.paused, 1);
  assert.equal(game2048.state.resumed, 1);
  assert.equal(center.select('missing'), 'tetris');
  center.destroy();
  assert.equal(tetris.state.destroyed, 1);
  assert.equal(game2048.state.destroyed, 1);
});

test('游戏工厂失败会报告错误，且仍可选择其他游戏', () => {
  const documentRef = createFakeDocument();
  const errors = [];
  const working = createFakeGame();
  const center = createGameCenter({ documentRef, onError: (id, error) => errors.push([id, error.message]), catalog: [
    { id: 'tetris', name: '俄罗斯方块', hint: '', factory: () => { throw new Error('boom'); } },
    { id: '2048', name: '2048', hint: '', factory: () => working },
  ] });
  center.mount(documentRef.createElement('div'));
  assert.equal(center.select('tetris'), 'tetris');
  assert.deepEqual(errors, [['tetris', 'boom']]);
  assert.equal(center.select('2048'), '2048');
  center.resume();
  assert.equal(working.state.resumed, 1);
});

test('默认注册表先列出俄罗斯方块，再列出 2048', () => {
  assert.deepEqual(createDefaultGameCatalog().map(game => game.id), ['tetris', '2048']);
});

test('自定义目录不含俄罗斯方块时非法选择回退到目录首项', () => {
  const game2048 = createFakeGame();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('2048', game2048)],
  });
  center.mount(new FakeElement());

  assert.equal(center.select('missing'), '2048');
  assert.equal(center.getActiveId(), '2048');
  assert.equal(game2048.state.mounted, 1);
});

test('空目录安全返回 null 并允许完整生命周期调用', () => {
  const root = new FakeElement();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [] });
  center.mount(root);

  assert.equal(center.select('tetris'), null);
  assert.equal(center.getActiveId(), null);
  assert.equal(center.getGameState(), null);
  assert.doesNotThrow(() => center.pause());
  assert.doesNotThrow(() => center.resume());
  assert.doesNotThrow(() => center.destroy());
  assert.deepEqual(root.children, []);
});

test('mount 抛错会报告一次且不阻断正常游戏', () => {
  const errors = [];
  const broken = createFakeGame();
  broken.mount = () => { throw new Error('mount failed'); };
  const working = createFakeGame();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken), catalogEntry('working', working)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(new FakeElement());

  assert.equal(center.select('broken'), 'broken');
  assert.equal(center.select('working'), 'working');
  assert.equal(working.state.mounted, 1);
  assert.deepEqual(errors, [['broken', 'mount failed']]);
});

test('mount 分配资源后抛错会销毁实例并保留可见 alert 宿主', () => {
  const errors = [];
  const resource = { active: false };
  let destroyCalls = 0;
  const broken = {
    mount() { resource.active = true; throw new Error('mount allocated then failed'); },
    pause() { throw new Error('bad instance should not be paused'); },
    resume() { throw new Error('bad instance should not be resumed'); },
    destroy() { destroyCalls += 1; resource.active = false; },
    getState() { return { resourceActive: resource.active }; },
  };
  const working = createFakeGame();
  const root = new FakeElement();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken), catalogEntry('working', working)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(root);

  assert.equal(center.select('broken'), 'broken');
  const alertHost = center.getActiveHost();
  assert.equal(destroyCalls, 1);
  assert.equal(resource.active, false);
  assert.equal(center.getGameState(), null);
  assert.equal(alertHost.parentNode, root);
  assert.equal(alertHost.dataset.active, 'true');
  assert.equal(alertHost.attributes.get('role'), 'alert');
  assert.match(alertHost.textContent, /游戏加载失败.*mount allocated then failed/);

  center.pause();
  center.resume();
  assert.equal(destroyCalls, 1, '坏实例的后续生命周期不得重复调用');
  assert.equal(center.select('working'), 'working');
  assert.equal(working.state.mounted, 1);
  assert.equal(working.state.resumed, 1);
  assert.deepEqual(errors, [['broken', 'mount allocated then failed']]);
});

test('mount 失败后的 destroy 再抛错会单独报告且不重复销毁', () => {
  const errors = [];
  let destroyCalls = 0;
  const broken = {
    mount() { throw new Error('mount failed'); },
    pause() { throw new Error('must not pause'); },
    resume() { throw new Error('must not resume'); },
    destroy() { destroyCalls += 1; throw new Error('destroy after mount failed'); },
    getState() { return {}; },
  };
  const root = new FakeElement();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(root);
  center.select('broken');
  const alertHost = center.getActiveHost();

  center.pause();
  center.resume();
  assert.equal(center.getGameState(), null);
  assert.equal(alertHost.parentNode, root);
  assert.equal(alertHost.attributes.get('role'), 'alert');
  assert.equal(destroyCalls, 1);
  assert.deepEqual(errors, [
    ['broken', 'mount failed'],
    ['broken', 'destroy after mount failed'],
  ]);

  center.destroy();
  assert.equal(destroyCalls, 1);
});

test('pause 抛错不会阻断切换和新游戏恢复', () => {
  const errors = [];
  const broken = createFakeGame();
  broken.pause = () => { throw new Error('pause failed'); };
  const working = createFakeGame();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken), catalogEntry('working', working)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(new FakeElement());
  center.select('broken');
  center.resume();

  assert.equal(center.select('working'), 'working');
  assert.equal(broken.state.destroyed, 1);
  assert.equal(working.state.resumed, 1);
  assert.deepEqual(errors, [['broken', 'pause failed']]);
});

test('切换时 pause 失败会淘汰实例且再次选择会重新 factory', () => {
  const errors = [];
  let brokenFactories = 0;
  const brokenInstances = [];
  const working = createFakeGame();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [
      catalogEntry('broken', null, { factory: () => {
        brokenFactories += 1;
        const game = createFakeGame();
        game.pause = () => { throw new Error('pause leaked timer'); };
        brokenInstances.push(game);
        return game;
      } }),
      catalogEntry('working', working),
    ],
    onError: (id, error) => errors.push([id, error.message]),
  });
  const root = new FakeElement();
  center.mount(root);
  center.select('broken');
  const firstHost = center.getActiveHost();

  center.select('working');
  assert.equal(brokenInstances[0].state.destroyed, 1);
  assert.equal(firstHost.parentNode, null);
  assert.equal(center.select('broken'), 'broken');
  assert.equal(brokenFactories, 2);
  assert.deepEqual(errors, [['broken', 'pause leaked timer']]);
});

test('pause 失败后的 destroy 失败会分别报告且仍淘汰缓存', () => {
  const errors = [];
  let factories = 0;
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', null, { factory: () => {
      factories += 1;
      return {
        mount() {}, resume() {}, getState() { return {}; },
        pause() { throw new Error('pause failed'); },
        destroy() { throw new Error('destroy failed'); },
      };
    } }), catalogEntry('working', createFakeGame())],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(new FakeElement());
  center.select('broken');
  center.select('working');
  center.select('broken');

  assert.equal(factories, 2);
  assert.deepEqual(errors, [['broken', 'pause failed'], ['broken', 'destroy failed']]);
});

test('resume 抛错会报告错误且后续正常游戏仍可恢复', () => {
  const errors = [];
  const broken = createFakeGame();
  broken.resume = () => { throw new Error('resume failed'); };
  const working = createFakeGame();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken), catalogEntry('working', working)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(new FakeElement());
  center.select('broken');

  assert.doesNotThrow(() => center.resume());
  assert.equal(center.select('working'), 'working');
  assert.equal(working.state.resumed, 1);
  assert.deepEqual(errors, [['broken', 'resume failed']]);
});

test('center.resume 分配资源后抛错会销毁实例并保留 alert record', () => {
  const errors = [];
  const resource = { active: false };
  let destroyCalls = 0;
  const broken = {
    mount() {},
    pause() { throw new Error('bad instance should not be paused'); },
    resume() { resource.active = true; throw new Error('resume allocated then failed'); },
    destroy() { destroyCalls += 1; resource.active = false; },
    getState() { return { resourceActive: resource.active }; },
  };
  const working = createFakeGame();
  const root = new FakeElement();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken), catalogEntry('working', working)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(root);
  center.select('broken');

  center.resume();
  const alertHost = center.getActiveHost();
  assert.equal(destroyCalls, 1);
  assert.equal(resource.active, false);
  assert.equal(center.getGameState(), null);
  assert.equal(alertHost.parentNode, root);
  assert.equal(alertHost.dataset.active, 'true');
  assert.equal(alertHost.attributes.get('role'), 'alert');
  assert.match(alertHost.textContent, /游戏加载失败.*resume allocated then failed/);

  assert.equal(center.select('working'), 'working');
  assert.equal(working.state.mounted, 1);
  assert.equal(working.state.resumed, 1);
  assert.deepEqual(errors, [['broken', 'resume allocated then failed']]);
});

test('running 状态选择新游戏时 resume 失败也会释放资源并允许切回正常游戏', () => {
  const errors = [];
  const resource = { active: false };
  let destroyCalls = 0;
  const working = createFakeGame();
  const broken = {
    mount() {}, pause() {},
    resume() { resource.active = true; throw new Error('select resume failed'); },
    destroy() { destroyCalls += 1; resource.active = false; },
    getState() { return { resourceActive: resource.active }; },
  };
  const root = new FakeElement();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('working', working), catalogEntry('broken', broken)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(root);
  center.select('working');
  center.resume();

  assert.equal(center.select('broken'), 'broken');
  const alertHost = center.getActiveHost();
  assert.equal(destroyCalls, 1);
  assert.equal(resource.active, false);
  assert.equal(center.getGameState(), null);
  assert.equal(alertHost.parentNode, root);
  assert.equal(alertHost.attributes.get('role'), 'alert');

  assert.equal(center.select('working'), 'working');
  assert.equal(working.state.resumed, 2);
  assert.deepEqual(errors, [['broken', 'select resume failed']]);
});

test('destroy 抛错时仍清理全部实例、宿主和活动状态', () => {
  const errors = [];
  const broken = createFakeGame();
  broken.destroy = () => { broken.state.destroyed += 1; throw new Error('destroy failed'); };
  const working = createFakeGame();
  const root = new FakeElement();
  const center = createGameCenter({
    documentRef: createFakeDocument(),
    catalog: [catalogEntry('broken', broken), catalogEntry('working', working)],
    onError: (id, error) => errors.push([id, error.message]),
  });
  center.mount(root);
  center.select('broken');
  center.select('working');

  assert.doesNotThrow(() => center.destroy());
  assert.equal(broken.state.destroyed, 1);
  assert.equal(working.state.destroyed, 1);
  assert.equal(center.getActiveId(), null);
  assert.deepEqual(root.children, []);
  assert.deepEqual(errors, [['broken', 'destroy failed']]);
});

test('重复 mount 会销毁旧实例并清空旧根后绑定新根', () => {
  const game = createFakeGame();
  const oldRoot = new FakeElement();
  const nextRoot = new FakeElement();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [catalogEntry('tetris', game)] });
  center.mount(oldRoot);
  center.select('tetris');
  center.resume();

  center.mount(nextRoot);

  assert.equal(game.state.destroyed, 1);
  assert.deepEqual(oldRoot.children, []);
  assert.deepEqual(nextRoot.children, []);
  assert.equal(center.getActiveId(), null);
});

test('显式 pause 在一个实例抛错后仍暂停其他实例并淘汰失败项', () => {
  let brokenFactories = 0;
  const broken = createFakeGame();
  const originalBrokenPause = broken.pause;
  broken.pause = () => {
    if (broken.state.paused === 0) return originalBrokenPause();
    throw new Error('pause failed');
  };
  const working = createFakeGame();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [
    catalogEntry('broken', broken, { factory: () => { brokenFactories += 1; return brokenFactories === 1 ? broken : createFakeGame(); } }),
    catalogEntry('working', working),
  ] });
  center.mount(new FakeElement());
  center.select('broken');
  center.select('working');
  center.select('broken');

  center.pause();

  assert.equal(broken.state.destroyed, 1);
  assert.equal(working.state.paused, 2);
  center.select('broken');
  assert.equal(brokenFactories, 2);
});

test('重复 mount 的 cleanup 在 pause 抛错后仍销毁全部实例并清空旧根', () => {
  const broken = createFakeGame();
  broken.pause = () => { throw new Error('pause failed'); };
  const working = createFakeGame();
  const oldRoot = new FakeElement();
  const nextRoot = new FakeElement();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [catalogEntry('broken', broken), catalogEntry('working', working)] });
  center.mount(oldRoot);
  center.select('working');
  center.select('broken');

  center.mount(nextRoot);

  assert.equal(broken.state.destroyed, 1);
  assert.equal(working.state.destroyed, 1);
  assert.deepEqual(oldRoot.children, []);
  assert.equal(center.getActiveId(), null);
});

test('destroy 在 pause 抛错后仍销毁全部实例并清空根', () => {
  const broken = createFakeGame();
  broken.pause = () => { throw new Error('pause failed'); };
  const working = createFakeGame();
  const root = new FakeElement();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [catalogEntry('working', working), catalogEntry('broken', broken)] });
  center.mount(root);
  center.select('working');
  center.select('broken');

  center.destroy();

  assert.equal(broken.state.destroyed, 1);
  assert.equal(working.state.destroyed, 1);
  assert.deepEqual(root.children, []);
  assert.equal(center.getActiveId(), null);
});

test('切回已创建游戏复用同一实例并保留状态', () => {
  let tetrisFactories = 0;
  let game2048Factories = 0;
  const tetris = createFakeGame();
  tetris.state.marker = 'unfinished';
  const game2048 = createFakeGame();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [
    catalogEntry('tetris', tetris, { factory: () => { tetrisFactories += 1; return tetris; } }),
    catalogEntry('2048', game2048, { factory: () => { game2048Factories += 1; return game2048; } }),
  ] });
  const root = new FakeElement();
  center.mount(root);
  assert.equal(tetrisFactories, 0);
  assert.equal(game2048Factories, 0);
  center.select('tetris');
  const tetrisHost = center.getActiveHost();
  const content = new FakeElement();
  tetrisHost.append(content);
  assert.equal(tetrisFactories, 1);
  assert.equal(game2048Factories, 0);
  center.resume();
  center.select('2048');
  assert.equal(tetrisFactories, 1);
  assert.equal(game2048Factories, 1);

  assert.equal(center.select('tetris'), 'tetris');
  assert.equal(tetrisFactories, 1);
  assert.equal(game2048Factories, 1);
  assert.equal(tetris.state.marker, 'unfinished');
  assert.equal(tetris.state.mounted, 1);
  assert.equal(tetris.state.destroyed, 0);
  assert.equal(tetrisHost.children[0], content);
  assert.equal(center.getActiveHost(), tetrisHost);
});

test('重复选择当前游戏不会重复调用暂停或恢复', () => {
  const game = createFakeGame();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [catalogEntry('tetris', game)] });
  center.mount(new FakeElement());
  center.select('tetris');
  center.resume();

  assert.equal(center.select('tetris'), 'tetris');
  assert.equal(game.state.paused, 0);
  assert.equal(game.state.resumed, 1);
  assert.equal(game.state.mounted, 1);
  assert.equal(game.state.destroyed, 0);
});

test('running 状态下重复 resume 不会重复恢复当前游戏', () => {
  const game = createFakeGame();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [catalogEntry('tetris', game)] });
  center.mount(new FakeElement());
  center.select('tetris');

  center.resume();
  center.resume();

  assert.equal(game.state.resumed, 1);
});

test('显式 pause 暂停全部已创建游戏且 resume 只恢复当前游戏', () => {
  const tetris = createFakeGame();
  const game2048 = createFakeGame();
  const center = createGameCenter({ documentRef: createFakeDocument(), catalog: [catalogEntry('tetris', tetris), catalogEntry('2048', game2048)] });
  center.mount(new FakeElement());
  center.select('tetris');
  center.select('2048');
  center.pause();
  center.resume();

  assert.equal(tetris.state.paused, 2);
  assert.equal(game2048.state.paused, 1);
  assert.equal(tetris.state.resumed, 0);
  assert.equal(game2048.state.resumed, 1);
});
