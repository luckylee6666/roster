import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_RAIL_DEFAULT_HEIGHT,
  SESSION_RAIL_HISTORY_LIMIT,
  SESSION_RAIL_MAX_HEIGHT,
  SESSION_RAIL_MIN_HEIGHT,
  buildSessionRailModel,
  clampSessionRailHeight,
  formatRailRelativeTime,
  isRailCliTool,
  railLiveTitle,
  sessionRailAction,
  sessionRailHiddenFromStorage,
  sessionRailViewLoading,
} from '../src/session-rail-utils.js';

const cwd = '/Users/lucky/git/app';
const groups = [
  {
    tool: 'claude',
    sessions: [
      { id: 'c-new', title: '修好分屏空窗格', atMs: 3_000 },
      { id: 'c-old', title: '记忆统一', atMs: 1_000 },
    ],
  },
  {
    tool: 'codex',
    sessions: [{ id: 'x-1', title: '打tag吧', atMs: 2_000 }],
  },
];

test('会话条只认已知 AI CLI，空白终端不进列表', () => {
  assert.equal(isRailCliTool('claude --resume abc'), true);
  assert.equal(isRailCliTool('codex resume --last'), true);
  assert.equal(isRailCliTool(''), false);
  assert.equal(isRailCliTool('bash'), false);
});

test('进行中的标签排在前面；已对齐的历史行不再重复', () => {
  const model = buildSessionRailModel({
    cwd,
    runningSessions: [
      { id: 'term-claude', cwd, tool: 'claude --resume c-new', status: 'running', name: 'claude · 修好分屏空窗格' },
      { id: 'term-blank', cwd, tool: '', status: 'running', name: '终端 3' },
      { id: 'term-other', cwd: '/tmp/other', tool: 'codex', status: 'running', name: 'codex' },
      { id: 'term-dead', cwd, tool: 'claude --resume c-old', status: 'exited', name: 'claude · 记忆统一' },
    ],
    historyGroups: groups,
  });
  assert.deepEqual(model.live.map(item => item.terminalId), ['term-claude']);
  assert.equal(model.live[0].title, '修好分屏空窗格');
  assert.deepEqual(model.history.map(item => item.sessionId), ['x-1', 'c-old']);
  assert.equal(sessionRailAction(model.live[0]).type, 'focus');
  assert.deepEqual(sessionRailAction(model.history[0]), {
    type: 'resume',
    tool: 'codex',
    sessionId: 'x-1',
    title: '打tag吧',
  });
});

test('开一套的裸命令不绑最新历史，历史行仍可续接', () => {
  const model = buildSessionRailModel({
    cwd,
    runningSessions: [
      { id: 'term-kit', cwd, tool: 'claude', status: 'running', name: 'claude' },
    ],
    historyGroups: groups,
  });
  assert.equal(model.live[0].terminalId, 'term-kit');
  assert.equal(model.live[0].title, 'claude');
  assert.equal(model.history.some(item => item.sessionId === 'c-new'), true);
  assert.equal(sessionRailAction(model.history.find(item => item.sessionId === 'c-new')).type, 'resume');
});

test('最近会话按时间倒序并截断，无目录时两边都空', () => {
  const many = {
    tool: 'grok',
    sessions: Array.from({ length: 12 }, (_, index) => ({
      id: `g-${index}`,
      title: `话题 ${index}`,
      atMs: index + 10,
    })),
  };
  const model = buildSessionRailModel({
    cwd,
    historyGroups: [many],
    historyLimit: SESSION_RAIL_HISTORY_LIMIT,
  });
  assert.equal(model.history.length, 8);
  assert.equal(model.history[0].sessionId, 'g-11');
  assert.deepEqual(buildSessionRailModel({ cwd: '' }), { cwd: '', live: [], history: [] });
});

test('相对时间和高度收起有稳定回退', () => {
  assert.equal(formatRailRelativeTime(1_000, 1_000), '刚刚');
  assert.equal(formatRailRelativeTime(1_000, 1_000 + 3 * 60_000), '3 分钟前');
  assert.equal(formatRailRelativeTime(1_000, 1_000 + 3 * 60 * 60_000), '3 小时前');
  assert.equal(formatRailRelativeTime(1_000, 1_000 + 3 * 24 * 60 * 60_000), '3 天前');
  assert.equal(formatRailRelativeTime(0), '');
  assert.equal(clampSessionRailHeight('180'), 180);
  assert.equal(clampSessionRailHeight(10), SESSION_RAIL_MIN_HEIGHT);
  assert.equal(clampSessionRailHeight(999), SESSION_RAIL_MAX_HEIGHT);
  assert.equal(clampSessionRailHeight(200, 168), SESSION_RAIL_MIN_HEIGHT);
  assert.equal(clampSessionRailHeight('nope'), SESSION_RAIL_DEFAULT_HEIGHT);
  assert.equal(SESSION_RAIL_DEFAULT_HEIGHT, SESSION_RAIL_MAX_HEIGHT);
  assert.equal(sessionRailHiddenFromStorage('1'), true);
  assert.equal(sessionRailHiddenFromStorage('0'), false);
  assert.equal(railLiveTitle({ tool: 'codex resume x', name: 'codex' }), 'codex');
  assert.equal(sessionRailAction(null).type, 'none');
});

test('会话条在历史请求未完成时保持加载态，有缓存则不再转圈', () => {
  const pending = new Set(['/Users/lucky/git/app']);
  assert.equal(sessionRailViewLoading('/Users/lucky/git/app/', null, pending), true);
  assert.equal(sessionRailViewLoading('/Users/lucky/git/app', { groups: [] }, pending), false);
  assert.equal(sessionRailViewLoading('/Users/lucky/git/app', null, new Set()), false);
  assert.equal(sessionRailViewLoading('', null, pending), false);
});
