import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  cliToolName,
  extractResumedSessionId,
  isGenericContinueCommand,
  restoreSessionLayout,
  restoredCliCommand,
  launchCliCommand,
  resumeCliCommand,
  sessionLayoutEntries,
  sessionTitlePreview,
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

test('历史会话按工具生成指定 ID 的续接命令', () => {
  assert.equal(resumeCliCommand('claude', 'abc-1'), 'claude --resume abc-1');
  assert.equal(resumeCliCommand('grok', '019ff9ad'), 'grok --resume 019ff9ad');
  assert.equal(resumeCliCommand('codex', 'abc-1'), 'codex resume abc-1');
  assert.equal(resumeCliCommand('opencode', 'ses_1'), 'opencode --session ses_1');
  assert.equal(
    resumeCliCommand('gemini', '/tmp/session-1.json'),
    'gemini --session-file /tmp/session-1.json',
  );
  assert.equal(resumeCliCommand('agy', 'conv-1'), 'agy --conversation conv-1');
  assert.match(resumeCliCommand('gemini', "/tmp/it's.json"), /session-file '/);
  assert.equal(resumeCliCommand('claude', ''), '');
  assert.equal(launchCliCommand('grok', '019ff9ad'), 'grok --resume 019ff9ad');
  assert.equal(launchCliCommand('claude', 'abc-1'), 'claude --resume abc-1');
  assert.equal(launchCliCommand('codex', 'x-1'), 'codex resume x-1');
  assert.equal(launchCliCommand('opencode', 'ses_1'), 'opencode --session ses_1');
  assert.equal(launchCliCommand('gemini', '/tmp/session-1.json'), 'gemini --session-file /tmp/session-1.json');
  assert.equal(launchCliCommand('agy', 'conv-1'), 'agy --conversation conv-1');
  assert.equal(launchCliCommand('grok', ''), 'grok');
  assert.equal(launchCliCommand('codex', ''), 'codex');
  assert.equal(launchCliCommand('', 'abc'), '');
  assert.equal(extractResumedSessionId('claude --resume abc-1'), 'abc-1');
  assert.equal(extractResumedSessionId('codex resume --last'), '');
  assert.equal(sessionTitlePreview('  修好   分屏空窗格  '), '修好 分屏空窗格');
  assert.equal(sessionTitlePreview('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'), '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六…');
});

test('Claude 延续旧行为，其他终端命令保持不变', () => {
  assert.equal(restoredCliCommand('claude'), 'claude --continue');
  assert.equal(restoredCliCommand('claude --continue'), 'claude --continue');
  assert.equal(restoredCliCommand('gemini'), 'gemini');
  assert.equal(restoredCliCommand(''), '');
});

test('重启恢复 Grok 标签时用 --continue 续接最近会话', () => {
  assert.equal(restoredCliCommand('grok'), 'grok --continue');
  assert.equal(restoredCliCommand('grok --ask-for-approval'), 'grok --ask-for-approval --continue');
  assert.equal(restoredCliCommand('/usr/local/bin/grok'), '/usr/local/bin/grok --continue');
});

test('已是 Grok 恢复命令时不会重复追加参数', () => {
  assert.equal(restoredCliCommand('grok --continue'), 'grok --continue');
  assert.equal(restoredCliCommand('grok -c'), 'grok -c');
  assert.equal(restoredCliCommand('grok --resume'), 'grok --resume');
  assert.equal(restoredCliCommand('grok -r last-title'), 'grok -r last-title');
});

test('重启恢复 OpenCode 标签时用 --continue 续接最近会话', () => {
  assert.equal(restoredCliCommand('opencode'), 'opencode --continue');
  assert.equal(restoredCliCommand('opencode -m anthropic/claude-opus-4-1'), 'opencode -m anthropic/claude-opus-4-1 --continue');
  assert.equal(restoredCliCommand('/usr/local/bin/opencode'), '/usr/local/bin/opencode --continue');
});

test('已是 OpenCode 恢复命令时不会重复追加参数', () => {
  assert.equal(restoredCliCommand('opencode --continue'), 'opencode --continue');
  assert.equal(restoredCliCommand('opencode -c'), 'opencode -c');
  assert.equal(restoredCliCommand('opencode --session ses_123'), 'opencode --session ses_123');
  assert.equal(restoredCliCommand('opencode -s ses_123'), 'opencode -s ses_123');
  assert.equal(restoredCliCommand('opencode run -c "继续"'), 'opencode run -c "继续"');
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
    { cwd: '/projects/four', name: 'OpenCode', autoCmd: 'opencode' },
    { cwd: '/projects/five', name: 'Grok', autoCmd: 'grok' },
  ], async options => {
    calls.push(options);
    if (options.cwd === '/projects/one') throw new Error('missing directory');
  });

  assert.deepEqual(calls, [
    { cwd: '/projects/one', name: 'Codex 1', autoCmd: 'codex resume --last' },
    { cwd: '/projects/two', name: 'Codex 2', autoCmd: 'codex resume session-2' },
    { cwd: '/projects/three', name: 'Claude', autoCmd: 'claude --continue' },
    { cwd: '/projects/four', name: 'OpenCode', autoCmd: 'opencode --continue' },
    { cwd: '/projects/five', name: 'Grok', autoCmd: 'grok --continue' },
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
  assert.match(main, /await restoreSessionLayout\(layout, options => createSession/);
  assert.match(main, /projectTabName\(options\.cwd, options\.name\)/);
  assert.match(main, /Codex 标签会按项目目录续接最近一次对话/);
  assert.match(main, /Grok 标签会用 --continue 接上次对话/);
});

test('Qwen 续接：--resume 指定会话，--continue 视为通用续接', () => {
  assert.equal(resumeCliCommand('qwen', 's-1'), 'qwen --resume s-1');
  assert.equal(launchCliCommand('qwen', ''), 'qwen');
  assert.equal(extractResumedSessionId('qwen --resume s-1'), 's-1');
  assert.equal(extractResumedSessionId('qwen --resume'), '');
  assert.equal(isGenericContinueCommand('qwen --continue'), true);
  assert.equal(isGenericContinueCommand('qwen --resume s-1'), false);
  assert.equal(restoredCliCommand('qwen'), 'qwen --continue');
  assert.equal(restoredCliCommand('qwen --resume s-1'), 'qwen --resume s-1');
});

test('MiMo Code 续接：--session 指定会话，--continue 续最近会话', () => {
  assert.equal(resumeCliCommand('mimo', 's-1'), 'mimo --session s-1');
  assert.equal(launchCliCommand('mimo', ''), 'mimo');
  assert.equal(extractResumedSessionId('mimo --session s-1'), 's-1');
  assert.equal(extractResumedSessionId('mimo -s s-2'), 's-2');
  assert.equal(extractResumedSessionId('mimo --session'), '');
  assert.equal(isGenericContinueCommand('mimo --continue'), true);
  assert.equal(isGenericContinueCommand('mimo -c'), true);
  assert.equal(isGenericContinueCommand('mimo --session s-1'), false);
  assert.equal(restoredCliCommand('mimo'), 'mimo --continue');
  assert.equal(restoredCliCommand('mimo --session s-1'), 'mimo --session s-1');
  assert.equal(restoredCliCommand('mimo --session=s-1'), 'mimo --session=s-1');
});
