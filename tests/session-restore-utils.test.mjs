import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  cliToolName,
  restoredCliCommand,
  restoreSessionLayout,
  sessionLayoutEntries,
} from '../src/session-restore-utils.js';

test('重启恢复 Codex 标签时按当前项目目录续接最近会话', () => {
  assert.equal(restoredCliCommand('codex'), 'codex resume --last');
  assert.equal(restoredCliCommand('codex --search'), 'codex resume --last --search');
  assert.equal(
    restoredCliCommand('/usr/local/bin/codex -m gpt-5'),
    '/usr/local/bin/codex resume --last -m gpt-5',
  );
});

test('已是 Codex 恢复命令时不会重复追加参数', () => {
  assert.equal(restoredCliCommand('codex resume --last'), 'codex resume --last');
  assert.equal(restoredCliCommand('codex resume session-id'), 'codex resume session-id');
  assert.equal(
    restoredCliCommand('codex --profile resume'),
    'codex resume --last --profile resume',
  );
  assert.equal(restoredCliCommand('codex -m resume'), 'codex resume --last -m resume');
  assert.equal(restoredCliCommand('codex --search resume --last'), 'codex --search resume --last');
  assert.equal(
    restoredCliCommand('codex --profile work resume session-id'),
    'codex --profile work resume session-id',
  );
});

test('Claude 延续旧行为，其他终端命令保持不变', () => {
  assert.equal(restoredCliCommand('claude'), 'claude --continue');
  assert.equal(restoredCliCommand('claude --continue'), 'claude --continue');
  assert.equal(restoredCliCommand('opencode'), 'opencode');
  assert.equal(restoredCliCommand(''), '');
});

test('工具识别兼容绝对路径命令', () => {
  assert.equal(cliToolName('/opt/homebrew/bin/codex --search'), 'codex');
  assert.equal(cliToolName('claude'), 'claude');
});

test('恢复编排把续接命令与原项目目录交给终端创建，并隔离单个标签失败', async () => {
  const calls = [];
  await restoreSessionLayout([
    { cwd: '/projects/one', name: 'Codex 1', autoCmd: 'codex' },
    null,
    { cwd: '/projects/two', name: 'Codex 2', autoCmd: 'codex resume session-2' },
    { cwd: '/projects/three', name: 'Claude', autoCmd: 'claude' },
  ], async options => {
    calls.push(options);
    if (options.cwd === '/projects/one') throw new Error('missing directory');
  });

  assert.deepEqual(calls, [
    { cwd: '/projects/one', name: 'Codex 1', autoCmd: 'codex resume --last' },
    { cwd: '/projects/two', name: 'Codex 2', autoCmd: 'codex resume session-2' },
    { cwd: '/projects/three', name: 'Claude', autoCmd: 'claude --continue' },
  ]);
});

test('只持久化后端创建成功、可在下次恢复的终端标签', () => {
  const sessions = new Map([
    ['ready', { cwd: '/projects/ready', name: 'Codex', tool: 'codex', restorable: true }],
    ['failed', { cwd: '/projects/missing', name: '失败终端', tool: 'codex', restorable: false }],
  ]);
  assert.deepEqual(sessionLayoutEntries(sessions), [
    { cwd: '/projects/ready', name: 'Codex', autoCmd: 'codex' },
  ]);
});

test('主流程调用可测试的恢复编排', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /await restoreSessionLayout\(layout, createSession\)/);
  assert.match(main, /Codex 标签会按项目目录续接最近一次对话/);
});
