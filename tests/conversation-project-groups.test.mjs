import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONVERSATION_UNGROUPED_LABEL,
  conversationProjectGroupName,
  conversationProjectMatchesQuery,
  groupConversationProjects,
  shouldAutoResumeLatestConversation,
} from '../src/conversation-mode.js';

test('对话项目按组分段，未分组始终在最后', () => {
  assert.equal(conversationProjectGroupName({ group: ' toyota ' }), 'toyota');
  assert.equal(conversationProjectGroupName({ group: '' }), CONVERSATION_UNGROUPED_LABEL);
  assert.equal(conversationProjectGroupName({}), CONVERSATION_UNGROUPED_LABEL);

  const grouped = groupConversationProjects([
    { id: '2', name: 'GetMoney', group: 'bytefluxai' },
    { id: '3', name: '验收照', group: 'siyuhudong' },
    { id: '1', name: 'Roster', group: '' },
    { id: '4', name: '防火墙', group: 'siyuhudong' },
  ]);
  assert.deepEqual(grouped.map(item => item.name), ['bytefluxai', 'siyuhudong', CONVERSATION_UNGROUPED_LABEL]);
  assert.deepEqual(grouped[1].projects.map(item => item.id), ['3', '4']);
  assert.equal(groupConversationProjects([]).length, 0);
});

test('对话项目搜索打平所有组，也能按组名命中', () => {
  const project = { name: '验收照', localPath: '/git/siyuhudong/yanshou', group: 'siyuhudong' };
  assert.equal(conversationProjectMatchesQuery(project, ''), true);
  assert.equal(conversationProjectMatchesQuery(project, '验收'), true);
  assert.equal(conversationProjectMatchesQuery(project, 'SIYU'), true);
  assert.equal(conversationProjectMatchesQuery(project, '没有这个'), false);
});

test('只有进入项目且当前仍是空白对话时才自动续接最近历史', () => {
  const session = { id: 's1', tool: 'grok' };
  assert.equal(shouldAutoResumeLatestConversation({ requested: true, session }), true);
  assert.equal(shouldAutoResumeLatestConversation({ requested: false, session }), false);
  assert.equal(shouldAutoResumeLatestConversation({ requested: true, running: true, session }), false);
  assert.equal(shouldAutoResumeLatestConversation({
    requested: true,
    hasOpenSession: true,
    session,
  }), false);
  assert.equal(shouldAutoResumeLatestConversation({
    requested: true,
    composerDraft: '先写一句',
    session,
  }), false);
  assert.equal(shouldAutoResumeLatestConversation({ requested: true, session: { id: '' } }), false);
  assert.equal(shouldAutoResumeLatestConversation({ requested: true }), false);
});

test('对话侧栏用可折叠分组渲染项目，搜索时不显示分组标题', async () => {
  const conversation = await readFile(new URL('../src/conversation-mode.js', import.meta.url), 'utf8');
  assert.match(conversation, /conversation-project-group-toggle/);
  assert.match(conversation, /collapsedProjectGroups/);
  assert.match(conversation, /if \(query\)/);
  assert.doesNotMatch(conversation, /rename_group|startRenameGroup/);
});
