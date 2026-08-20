import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PROJECT_KIT,
  PROJECT_KIT_LAYOUT,
  createProjectSessionHistoryLoader,
  filterHistoryGroups,
  findRunningProjectTool,
  latestHistorySession,
  launchCommandForProjectTool,
  projectKitSessionIds,
  runningHistoryLookup,
  runningTerminalIdForHistory,
  sameHistorySessionId,
  sameProjectCwd,
} from '../src/project-history-utils.js';
import { extractResumedSessionId, isGenericContinueCommand, resumeCliCommand } from '../src/session-restore-utils.js';

const groups = [
  {
    tool: 'claude',
    label: 'Claude',
    sessions: [
      { id: 'c-new', title: '修好分屏空窗格', preview: '修好分屏空窗格并收拢空位' },
      { id: 'c-old', title: '记忆统一', preview: '把记忆指到 Claude' },
    ],
  },
  {
    tool: 'codex',
    label: 'Codex',
    sessions: [{ id: 'x-1', title: '打tag吧', preview: '给当前版本打 tag' }],
  },
  {
    tool: 'gemini',
    label: 'Gemini',
    sessions: [{ id: '/Users/lucky/.gemini/tmp/app/chats/session-1.json', title: '你是哪个模型' }],
  },
];

test('历史会话按标题、预览和工具名过滤，并丢掉空组', () => {
  const filtered = filterHistoryGroups(groups, '分屏');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sessions.length, 1);
  assert.equal(filtered[0].sessions[0].id, 'c-new');
  assert.equal(filterHistoryGroups(groups, 'codex')[0].tool, 'codex');
  assert.equal(filterHistoryGroups(groups, '没有这个').length, 0);
  assert.equal(filterHistoryGroups(groups, '  ').length, 3);
});

test('从运行中的续接命令解析指定会话 ID', () => {
  assert.equal(extractResumedSessionId('claude --resume abc-1'), 'abc-1');
  assert.equal(extractResumedSessionId('grok -r 019ff9ad'), '019ff9ad');
  assert.equal(extractResumedSessionId('codex resume session-2'), 'session-2');
  assert.equal(extractResumedSessionId('codex resume --last'), '');
  assert.equal(extractResumedSessionId('opencode --session ses_1'), 'ses_1');
  assert.equal(extractResumedSessionId(resumeCliCommand('gemini', "/tmp/it's.json")), "/tmp/it's.json");
  assert.equal(extractResumedSessionId('agy --conversation conv-1'), 'conv-1');
  assert.equal(extractResumedSessionId('claude --continue'), '');
});

test('运行中标签按续接 ID 对齐历史行，泛化续接只标该工具最新一条', () => {
  assert.equal(isGenericContinueCommand('claude --continue'), true);
  assert.equal(isGenericContinueCommand('codex resume --last'), true);
  assert.equal(isGenericContinueCommand('claude'), false);
  assert.equal(isGenericContinueCommand('codex'), false);
  const lookup = runningHistoryLookup([
    { id: 'term-claude', cwd: '/Users/lucky/git/app/', tool: 'claude --continue', status: 'running' },
    { id: 'term-codex', cwd: '/Users/lucky/git/app', tool: 'codex resume x-1', status: 'running' },
    { id: 'term-kit', cwd: '/Users/lucky/git/app', tool: 'claude', status: 'running' },
    { id: 'term-dead', cwd: '/Users/lucky/git/app', tool: 'claude --resume c-old', status: 'exited' },
    { id: 'term-other', cwd: '/tmp/other', tool: 'claude --resume c-new', status: 'running' },
  ], groups, '/Users/lucky/git/app');
  assert.equal(runningTerminalIdForHistory(lookup, 'claude', 'c-new'), 'term-claude');
  assert.equal(runningTerminalIdForHistory(lookup, 'claude', 'c-old'), '');
  assert.equal(runningTerminalIdForHistory(lookup, 'codex', 'x-1'), 'term-codex');
  const kitOnly = runningHistoryLookup([
    { id: 'term-kit', cwd: '/Users/lucky/git/app', tool: 'claude', status: 'running' },
  ], groups, '/Users/lucky/git/app');
  assert.equal(runningTerminalIdForHistory(kitOnly, 'claude', 'c-new'), '');
});

test('Gemini 历史 ID 可用完整路径或文件名对齐', () => {
  assert.equal(
    sameHistorySessionId('gemini', '/Users/lucky/.gemini/tmp/app/chats/session-1.json', 'session-1.json'),
    true,
  );
  assert.equal(sameProjectCwd('/Users/lucky/git/app/', '/Users/lucky/git/app'), true);
});

test('打开 CLI 用该工具最近一条历史续接，没有历史才新开', () => {
  const lastGrok = latestHistorySession([
    {
      tool: 'grok',
      sessions: [
        { id: 'g-new', title: '下架整改：下线小程序', atMs: 200 },
        { id: 'g-old', title: '更早的会话', atMs: 100 },
      ],
    },
    { tool: 'claude', sessions: [{ id: 'c-new', title: '修好分屏' }] },
  ], 'grok');
  assert.equal(lastGrok.id, 'g-new');
  assert.deepEqual(launchCommandForProjectTool('grok', [
    { tool: 'grok', sessions: [{ id: 'g-new', title: '下架整改：下线小程序' }] },
  ]), {
    last: { id: 'g-new', title: '下架整改：下线小程序' },
    autoCmd: 'grok --resume g-new',
  });
  assert.deepEqual(launchCommandForProjectTool('codex', groups), {
    last: { id: 'x-1', title: '打tag吧', preview: '给当前版本打 tag' },
    autoCmd: 'codex resume x-1',
  });
  assert.deepEqual(launchCommandForProjectTool('mimo', [
    { tool: 'mimo', sessions: [{ id: 'ses-new', title: 'MiMo 最新会话', atMs: 300 }] },
  ]), {
    last: { id: 'ses-new', title: 'MiMo 最新会话', atMs: 300 },
    autoCmd: 'mimo --session ses-new',
  });
  assert.deepEqual(launchCommandForProjectTool('agy', groups), {
    last: null,
    autoCmd: 'agy',
  });
  assert.equal(latestHistorySession(groups, 'opencode'), null);
  assert.equal(latestHistorySession([], 'claude'), null);
});

test('一键套装复用同项目仍在跑的 Claude/Codex/Grok', () => {
  assert.deepEqual(DEFAULT_PROJECT_KIT, ['claude', 'codex', 'grok']);
  assert.equal(PROJECT_KIT_LAYOUT, 'main');
  const running = [
    { id: 'term-claude', cwd: '/proj', tool: 'claude', status: 'running' },
    { id: 'term-grok', cwd: '/proj', tool: 'grok --resume abc', status: 'running' },
  ];
  assert.equal(findRunningProjectTool(running, '/proj', 'claude').id, 'term-claude');
  assert.deepEqual(
    projectKitSessionIds(running, '/proj', { codex: 'term-codex' }),
    ['term-claude', 'term-codex', 'term-grok'],
  );
});

test('历史加载按项目合并请求，失效中的旧请求不能覆盖或删除新请求', async () => {
  const requests = [];
  const loader = createProjectSessionHistoryLoader(cwd => new Promise((resolve, reject) => {
    requests.push({ cwd, resolve, reject });
  }));

  const first = loader.load('/Users/lucky/git/app/');
  const duplicate = loader.load('/Users/lucky/git/app');
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(loader.pending.has('/Users/lucky/git/app'), true);

  loader.invalidate('/Users/lucky/git/app');
  const fresh = loader.load('/Users/lucky/git/app');
  const freshDuplicate = loader.load('/Users/lucky/git/app/');
  await Promise.resolve();
  assert.equal(requests.length, 2);

  requests[0].resolve({ groups: [{ tool: 'mimo', sessions: [{ id: 'old' }] }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loader.pending.has('/Users/lucky/git/app'), true);

  const expected = { groups: [{ tool: 'mimo', sessions: [{ id: 'new' }] }] };
  requests[1].resolve(expected);
  assert.deepEqual(await first, expected);
  assert.deepEqual(await duplicate, expected);
  assert.deepEqual(await fresh, expected);
  assert.deepEqual(await freshDuplicate, expected);
  assert.equal(loader.pending.has('/Users/lucky/git/app'), false);
});
