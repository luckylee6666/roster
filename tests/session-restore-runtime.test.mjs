import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as restore from '../src/session-restore-utils.js';
import { cliDisplayLabel } from '../src/cli-tools.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const imports = main.match(/import \{([^}]+)\} from '\.\/session-restore-utils\.js'/)[1]
  .split(',').map(value => value.trim()).filter(Boolean);
// Execute the real wiring with only its ACTUAL imports, so a missing import
// (the original cause of silently lost restored tabs) is a runtime failure.
const source = main.slice(main.indexOf('let pendingSessionLayout ='), main.indexOf('// ===== Prompt/Snippet 库'));

function harness(layout, { failAt = [], throwAt = [], closeAt = [] } = {}) {
  let saved = JSON.stringify(layout);
  let prompt;
  const calls = [], logs = [], messages = [], snapshots = [];
  const sessions = new Map();
  let api;
  const deps = {
    ...Object.fromEntries(imports.map(key => [key, restore[key]])),
    cliDisplayLabel, sessions, setTimeout, clearTimeout,
    localStorage: { getItem: () => saved, setItem: (_, value) => { saved = value; snapshots.push(JSON.parse(value)); } },
    showConfirm: options => { prompt = options; },
    appLog: (level, text) => logs.push({ level, text }),
    msg: text => messages.push(text),
    projectTabName: (_, name) => name,
    cliLaunchVariants: () => [{ args: '--yolo' }],
    loadProjectSessionHistory: async () => ({ groups: [] }),
    latestResumableHistorySession: () => ({ id: 'native-session' }),
    latestHistorySession: () => null,
    createSession: async options => {
      const index = calls.length;
      calls.push(options);
      if (throwAt.includes(index)) throw new Error('模拟创建失败');
      const id = `tab-${index}`;
      sessions.set(id, { ...options, tool: options.autoCmd, restorable: !failAt.includes(index) });
      api.persistSessionLayout(); // createSession writes before onProgress fires.
      if (closeAt.includes(index)) {
        api.forgetPendingSessionRestore(sessions.get(id));
        sessions.delete(id);
        api.persistSessionLayout();
      }
      return id;
    },
  };
  api = new Function(...Object.keys(deps), `${source}\nreturn { maybeRestoreSessions, persistSessionLayout, restoreSessions, forgetPendingSessionRestore };`)(...Object.values(deps));
  return { api, sessions, calls, logs, messages, snapshots, saved: () => JSON.parse(saved), prompt: () => prompt };
}

const layout = ['cmd --yolo', 'codex', 'claude', 'opencode', 'cmd'].map((autoCmd, index) => ({ cwd: `/project/${index}`, name: `项目${index}`, autoCmd }));

test('真实主流程恢复五条布局：命令生成导入齐全，每条都成功且启动中不丢未处理条目', async () => {
  const h = harness(layout);
  h.api.maybeRestoreSessions();
  assert.deepEqual(h.saved(), layout, '弹窗出现不能删除布局');
  await h.prompt().onConfirm();
  assert.equal(h.calls.length, 5);
  assert.match(h.calls[0].autoCmd, /cmd --session native-session --yolo/);
  assert.match(h.calls[1].autoCmd, /codex .* resume --last/);
  assert.equal(h.calls[2].autoCmd, 'claude --continue');
  assert.ok(h.snapshots.every(snapshot => snapshot.length === 5), '处理中不重复、不遗失');
  assert.equal(h.logs.filter(log => log.text.includes('成功')).length, 5);
  assert.match(h.messages.at(-1), /成功 5 个，失败 0 个/);
});

test('显式失败和抛错都保留原条目，后续标签继续恢复并记录结果', async () => {
  const h = harness(layout, { failAt: [1], throwAt: [3] });
  h.api.maybeRestoreSessions();
  await h.prompt().onConfirm();
  assert.equal(h.calls.length, 5);
  assert.deepEqual([h.saved()[1], h.saved()[3]], [layout[1], layout[3]]);
  assert.deepEqual(h.saved().map(entry => entry.cwd), layout.map(entry => entry.cwd), '失败后成功不应改变布局顺序');
  assert.equal(h.saved().length, 5);
  assert.equal(h.logs.filter(log => log.text.includes('失败')).length, 2);
  assert.match(h.messages.at(-1), /成功 3 个，失败 2 个/);
  // Closing all successful tabs must not erase the failed originals.
  h.sessions.clear();
  h.api.persistSessionLayout();
  assert.deepEqual(h.saved(), [layout[1], layout[3]]);
  const retry = harness(h.saved());
  retry.api.maybeRestoreSessions();
  await retry.prompt().onConfirm();
  assert.equal(retry.calls.length, 2);
  assert.match(retry.messages.at(-1), /失败 0 个/);
});

test('取消/替换恢复弹窗并打开新终端，不覆盖尚未恢复的布局', () => {
  const h = harness(layout);
  h.api.maybeRestoreSessions();
  h.prompt().onCancel?.();
  h.sessions.set('new', { cwd: '/new', name: '新终端', tool: '', restorable: true });
  h.api.persistSessionLayout();
  assert.equal(h.saved().length, 6);
  assert.deepEqual(h.saved().slice(0, 5), layout);
});

test('相同目录、命令的两个原标签不能被误去重', async () => {
  const h = harness([layout[0], { ...layout[0] }]);
  h.api.maybeRestoreSessions();
  await h.prompt().onConfirm();
  assert.equal(h.calls.length, 2);
  assert.equal(h.saved().length, 2);
});

test('恢复过程中主动关闭标签，不在下次复活且不计为失败', async () => {
  const h = harness(layout, { closeAt: [1] });
  h.api.maybeRestoreSessions();
  await h.prompt().onConfirm();
  assert.deepEqual(h.saved().map(entry => entry.cwd), layout.filter((_, i) => i !== 1).map(entry => entry.cwd));
  assert.match(h.messages.at(-1), /成功 4 个，失败 0 个，已取消 1 个/);
  const finalize = main.slice(main.indexOf('function finalizeSessionClose('), main.indexOf('async function closeSession('));
  assert.match(finalize, /forgetPendingSessionRestore\(session\)/);
});

test('损坏布局项被过滤，合法空目录终端保留', () => {
  assert.deepEqual(restore.normalizeSessionLayout(null), []);
  assert.deepEqual(restore.normalizeSessionLayout({}), []);
  assert.deepEqual(restore.normalizeSessionLayout([null, {}, { cwd: 123, name: 'x', autoCmd: '' }, { cwd: '', name: '', autoCmd: '' }]), [{ cwd: '', name: '', autoCmd: '' }]);
});

test('关闭弹窗仅显示登记名称，未知命令不泄露参数；未保存警告保留', () => {
  const command = restore.withCodexNativeProvider('codex resume abc');
  let prompt;
  const session = { name: 'Codex重置', tool: command, status: 'running' };
  const source = main.slice(main.indexOf('function confirmCloseSession('), main.indexOf('function setSessionClosingState('));
  const deps = { sessions: new Map([['id', session]]), sessionCloseCoordinator: { isClosing: () => false },
    activeSession: 'id', fileEditorSaving: false, isFileEditorDirty: () => true,
    cliDisplayLabel, showConfirm: options => { prompt = options; }, closeSession: () => {}, msg: () => {} };
  const close = new Function(...Object.keys(deps), `${source}; return confirmCloseSession;`)(...Object.values(deps));
  close('id');
  assert.match(prompt.message, /Codex「更新记忆」/);
  assert.match(prompt.message, /未保存的修改/);
  assert.doesNotMatch(prompt.message, /roster_openai_native|wire_api|--|OpenAI/);
  session.tool = 'custom --api-key sensitive-test-placeholder';
  close('id');
  assert.doesNotMatch(prompt.message, /custom|sensitive-test-placeholder|更新记忆/);
  assert.equal(cliDisplayLabel('/usr/local/bin/codex --model example'), 'Codex');
  assert.equal(cliDisplayLabel('cmdc --yolo'), 'cmd');
});

test('确认弹窗支持长项目名称和无空格文本折行', async () => {
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.confirm-msg p \{([^}]+)\}/)[1];
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});
