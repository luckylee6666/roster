import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_VIEW_STORAGE_KEY,
  isDeveloperTerminalVisible,
  normalizeAppView,
  normalizeConversationProvider,
  readAppShellPreference,
  selectConversationProject,
  writeAppShellPreference,
} from '../src/app-shell-utils.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); },
  };
}

test('应用首次打开默认对话模式，且只接受两个应用视图', () => {
  assert.equal(normalizeAppView('conversation'), 'conversation');
  assert.equal(normalizeAppView('developer'), 'developer');
  assert.equal(normalizeAppView('normal'), 'conversation');
  assert.equal(normalizeConversationProvider(' MiMo '), 'mimo');
  assert.equal(normalizeConversationProvider('../../bin/sh'), 'codex');
  assert.deepEqual(readAppShellPreference(memoryStorage()), {
    version: 1,
    appView: 'conversation',
    projectId: '',
    providerId: 'codex',
  });
});

test('应用视图和选中项目以一个版本化记录原子保存', () => {
  const storage = memoryStorage();
  assert.equal(writeAppShellPreference(storage, {
    appView: 'developer',
    projectId: 'project-1',
    providerId: 'agy',
  }), true);
  assert.deepEqual(JSON.parse(storage.value(APP_VIEW_STORAGE_KEY)), {
    version: 1,
    appView: 'developer',
    projectId: 'project-1',
    providerId: 'agy',
  });
  assert.deepEqual(readAppShellPreference(storage), {
    version: 1,
    appView: 'developer',
    projectId: 'project-1',
    providerId: 'agy',
  });
});

test('损坏存储和读写异常安全回到对话模式', () => {
  assert.equal(readAppShellPreference(memoryStorage({ [APP_VIEW_STORAGE_KEY]: '{bad' })).appView, 'conversation');
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(readAppShellPreference(broken).appView, 'conversation');
  assert.equal(writeAppShellPreference(broken, { appView: 'developer' }), false);
});

test('对话项目按稳定 ID 保持选择，失效时回退首个有效目录', () => {
  const projects = [
    { id: 'bad', localPath: '' },
    { id: 'one', localPath: '/tmp/one' },
    { id: 'two', localPath: '/tmp/two' },
  ];
  assert.equal(selectConversationProject(projects, 'two').id, 'two');
  assert.equal(selectConversationProject(projects, 'gone').id, 'one');
  assert.equal(selectConversationProject([{ id: 'bad', localPath: '' }]), null);
});

test('隐藏开发工作台后终端不再被视为可交互', () => {
  assert.equal(isDeveloperTerminalVisible('developer', true), true);
  assert.equal(isDeveloperTerminalVisible('developer', false), false);
  assert.equal(isDeveloperTerminalVisible('conversation', true), false);
});
