import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimOrphanProjectIdea,
  commitProjectIdeaSnapshot,
  createProjectIdea,
  createProjectIdeaMutationGate,
  findProjectIdea,
  ideaConversationText,
  orphanProjectIdeas,
  planProjectIdeaPaste,
  projectIdeasFor,
  removeProjectIdea,
  updateProjectIdea,
} from '../src/project-ideas-utils.js';

const NOW = '2026-08-20T12:00:00.000Z';

function idea(overrides = {}) {
  return {
    id: 'idea-a',
    title: '第一个想法',
    note: '',
    archived: false,
    projectId: 'project-a',
    createdAt: '2026-08-18T12:00:00.000Z',
    updatedAt: '2026-08-18T12:00:00.000Z',
    lastPlacedAt: '',
    lastPlacedTool: '',
    lastPlacedSessionId: '',
    ...overrides,
  };
}

test('想法变更门禁在保存完成前拒绝第二次操作', () => {
  const gate = createProjectIdeaMutationGate();

  assert.equal(gate.pending, false);
  assert.equal(gate.begin(), true);
  assert.equal(gate.pending, true);
  assert.equal(gate.begin(), false);
  gate.finish();
  assert.equal(gate.pending, false);
  assert.equal(gate.begin(), true);
});

test('想法快照保存失败会精确回滚，连续成败不会污染已落盘状态', async () => {
  const original = [idea({ title: '原始状态' })];
  let current = original;
  const write = value => { current = value; };

  const failed = [idea({ title: '不会留下' })];
  assert.equal(await commitProjectIdeaSnapshot({
    previous: original,
    next: failed,
    persist: async () => { throw new Error('disk full'); },
    getCurrent: () => current,
    setCurrent: write,
  }), false);
  assert.equal(current, original);

  const saved = [idea({ title: '已经保存' })];
  assert.equal(await commitProjectIdeaSnapshot({
    previous: original,
    next: saved,
    persist: async snapshot => assert.notEqual(snapshot, saved),
    getCurrent: () => current,
    setCurrent: write,
  }), true);
  assert.equal(current, saved);

  const secondFailure = [idea({ title: '第二次失败' })];
  assert.equal(await commitProjectIdeaSnapshot({
    previous: saved,
    next: secondFailure,
    persist: async () => { throw new Error('still full'); },
    getCurrent: () => current,
    setCurrent: write,
  }), false);
  assert.equal(current, saved);
});

test('迟到的保存失败不会覆盖期间出现的更新状态', async () => {
  const previous = [idea({ title: '旧状态' })];
  const pending = [idea({ title: '保存中' })];
  const newer = [idea({ title: '更新状态' })];
  let current = previous;
  let rejectPersist;

  const result = commitProjectIdeaSnapshot({
    previous,
    next: pending,
    persist: () => new Promise((_, reject) => { rejectPersist = reject; }),
    getCurrent: () => current,
    setCurrent: value => { current = value; },
  });
  assert.equal(current, pending);
  current = newer;
  rejectPersist(new Error('late failure'));

  assert.equal(await result, false);
  assert.equal(current, newer);
});

test('创建项目想法会当场分配独立 ID，并把多行速记拆成标题和详情', () => {
  let sequence = 0;
  const options = {
    idFactory: () => `idea-${++sequence}`,
    now: () => NOW,
  };
  const first = createProjectIdea('  发布失败自动重试\r\n考虑幂等\r最多三次  ', ' project-a ', options);
  const second = createProjectIdea('发布失败自动重试', 'project-a', options);

  assert.deepEqual(first, {
    id: 'idea-1',
    title: '发布失败自动重试',
    note: '考虑幂等\n最多三次',
    archived: false,
    projectId: 'project-a',
    createdAt: NOW,
    updatedAt: NOW,
    lastPlacedAt: '',
    lastPlacedTool: '',
    lastPlacedSessionId: '',
  });
  assert.equal(second.id, 'idea-2');
  assert.notEqual(first.id, second.id, '同标题的多条想法也必须能同时存在');
  assert.equal(createProjectIdea('   ', 'project-a', options), null);
  assert.equal(createProjectIdea('有内容', '   ', options), null);
});

test('想法按项目精确隔离、按最近更新排序并可显式查看归档', () => {
  const olderA = idea({ id: 'older-a', updatedAt: '2026-08-19T10:00:00Z' });
  const activeA = idea({ id: 'active-a', updatedAt: '2026-08-20T10:00:00Z' });
  const archivedA = idea({ id: 'archived-a', archived: true, updatedAt: '2026-08-21T10:00:00Z' });
  const projectB = idea({ id: 'idea-b', projectId: 'project-b', updatedAt: '2026-08-22T10:00:00Z' });
  const orphan = idea({ id: 'orphan', projectId: '', updatedAt: '2026-08-23T10:00:00Z' });
  const stored = [olderA, archivedA, projectB, activeA, orphan];

  assert.deepEqual(projectIdeasFor(stored, 'project-a').map(row => row.id), ['active-a', 'older-a']);
  assert.deepEqual(
    projectIdeasFor(stored, 'project-a', { includeArchived: true }).map(row => row.id),
    ['archived-a', 'active-a', 'older-a'],
  );
  assert.deepEqual(
    projectIdeasFor(stored, 'project-a', { archivedOnly: true }).map(row => row.id),
    ['archived-a'],
  );
  assert.deepEqual(projectIdeasFor(stored, 'project-b').map(row => row.id), ['idea-b']);
  assert.deepEqual(projectIdeasFor(stored, ''), []);
  assert.equal(stored.length, 5);
});

test('无项目和已删项目的异常数据只进入孤立集合，不泄漏到任何项目', () => {
  const stored = [
    idea({ id: 'known', projectId: 'project-a', updatedAt: '2026-08-18T00:00:00Z' }),
    idea({ id: 'blank', projectId: '', updatedAt: '2026-08-20T00:00:00Z' }),
    idea({ id: 'deleted-project', projectId: 'project-deleted', updatedAt: '2026-08-19T00:00:00Z' }),
  ];

  assert.deepEqual(
    orphanProjectIdeas(stored, ['project-a', 'project-b']).map(row => row.id),
    ['blank', 'deleted-project'],
  );
  assert.deepEqual(projectIdeasFor(stored, 'project-a').map(row => row.id), ['known']);
  assert.deepEqual(projectIdeasFor(stored, 'project-b'), []);
});

test('多条想法的查找和编辑同时校验 id 与项目，不覆盖其他条目', () => {
  const a = idea({ id: 'same-id', projectId: 'project-a', title: 'A' });
  const b = idea({ id: 'same-id', projectId: 'project-b', title: 'B' });
  const sibling = idea({ id: 'sibling', projectId: 'project-a', title: '另一条' });
  const stored = [a, b, sibling];

  assert.equal(findProjectIdea(stored, 'same-id', 'project-a'), a);
  assert.equal(findProjectIdea(stored, 'same-id', 'project-b'), b);
  assert.equal(findProjectIdea(stored, 'same-id', 'project-c'), null);

  const updated = updateProjectIdea(stored, {
    id: 'same-id',
    projectId: 'project-a',
    title: 'A 已完善',
    note: '只修改 A',
    updatedAt: NOW,
    lastPlacedAt: NOW,
    lastPlacedTool: 'mimo',
    lastPlacedSessionId: 'term-a',
  });
  assert.notEqual(updated, stored);
  assert.equal(updated[0].title, 'A 已完善');
  assert.equal(updated[0].note, '只修改 A');
  assert.equal(updated[0].projectId, 'project-a');
  assert.equal(updated[0].createdAt, a.createdAt);
  assert.equal(updated[0].lastPlacedAt, NOW);
  assert.equal(updated[0].lastPlacedTool, 'mimo');
  assert.equal(updated[0].lastPlacedSessionId, 'term-a');
  assert.equal(updated[1], b);
  assert.equal(updated[2], sibling);
  assert.equal(updateProjectIdea(stored, {
    id: 'same-id', projectId: 'project-c', title: '不得生效',
  }), stored);
  assert.equal(updateProjectIdea(stored, {
    id: 'same-id', projectId: 'project-a', title: '   ',
  }), stored);
});

test('删除和归档只作用于当前项目的指定想法', () => {
  const a = idea({ id: 'same-id', projectId: 'project-a' });
  const b = idea({ id: 'same-id', projectId: 'project-b' });
  const stored = [a, b];

  const archived = updateProjectIdea(stored, {
    id: 'same-id', projectId: 'project-a', archived: true, updatedAt: NOW,
  });
  assert.equal(archived[0].archived, true);
  assert.equal(archived[1].archived, false);

  assert.deepEqual(removeProjectIdea(stored, 'same-id', 'project-a'), [b]);
  assert.equal(removeProjectIdea(stored, 'same-id', 'project-c'), stored);
});

test('孤立想法只能经显式操作迁入已知项目', () => {
  const orphan = idea({ id: 'orphan', projectId: '', createdAt: '2026-08-01T00:00:00Z' });
  const stale = idea({ id: 'stale', projectId: 'deleted-project' });
  const linked = idea({ id: 'linked', projectId: 'project-a' });
  const stored = [orphan, stale, linked];
  const knownProjectIds = ['project-a', 'project-b'];

  const claimed = claimOrphanProjectIdea(stored, {
    id: 'orphan',
    projectId: 'project-b',
    knownProjectIds,
    now: () => NOW,
  });
  assert.equal(claimed[0].projectId, 'project-b');
  assert.equal(claimed[0].updatedAt, NOW);
  assert.equal(claimed[0].createdAt, orphan.createdAt);
  assert.equal(stored[0].projectId, '', '迁入应为不修改原数组的显式操作');
  assert.equal(claimed[1], stale);
  assert.equal(claimed[2], linked);

  assert.equal(claimOrphanProjectIdea(stored, {
    id: 'linked', projectId: 'project-b', knownProjectIds, now: NOW,
  }), stored, '已关联想法不得借迁入功能跨项目改属');
  assert.equal(claimOrphanProjectIdea(stored, {
    id: 'orphan', projectId: 'unknown-project', knownProjectIds, now: NOW,
  }), stored, '不得把孤立想法迁入不存在的项目');
});

test('放入对话的文本会折叠换行且不追加回车', () => {
  const text = ideaConversationText(idea({
    title: '  部署失败后重试  ',
    note: '先检查幂等\r\n再限制   次数\n\n<script>alert(1)</script>\u001b',
  }));

  assert.equal(text, '部署失败后重试 先检查幂等 再限制 次数 <script>alert(1)</script>');
  assert.doesNotMatch(text, /[\r\n]/);
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(text.endsWith('\r'), false);
});

test('粘贴计划只指向当前项目的运行中终端', () => {
  const current = idea({ title: '整理发布流程', note: '补上回滚验证' });
  const plan = planProjectIdeaPaste({
    idea: current,
    projectId: 'project-a',
    projectCwd: '/Users/lucky/git/project-a/',
    sessionId: 'term-a',
    sessionStatus: 'running',
    sessionCwd: '/Users/lucky/git/project-a',
  });

  assert.deepEqual(plan, {
    sessionId: 'term-a',
    text: '整理发布流程 补上回滚验证',
  });
  assert.doesNotMatch(plan.text, /\r$/);

  const base = {
    idea: current,
    projectId: 'project-a',
    projectCwd: '/repo/a',
    sessionId: 'term-a',
    sessionStatus: 'running',
    sessionCwd: '/repo/a',
  };
  for (const invalid of [
    { ...base, projectId: 'project-b' },
    { ...base, sessionCwd: '/repo/b' },
    { ...base, sessionStatus: 'exited' },
    { ...base, sessionStatus: 'failed' },
    { ...base, sessionId: '' },
    { ...base, projectCwd: '' },
  ]) {
    assert.equal(planProjectIdeaPaste(invalid), null);
  }
});
