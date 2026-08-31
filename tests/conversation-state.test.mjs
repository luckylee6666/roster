import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyConversationChatEvent,
  applyCodexChatEvent,
  conversationHasOpenSession,
  conversationRunContext,
  createConversationState,
  loadConversationTranscript,
  MAX_CONVERSATION_ACTIVITIES,
  selectConversationProvider,
  startConversationTurn,
} from '../src/conversation-state.js';

test('结构化消息保留中文和 shell 特殊字符，不拼接命令', () => {
  const prompt = '检查“首页”\n然后说明 ; $() && 为什么没有风险';
  const state = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-1',
    projectId: 'p1',
    prompt,
  });
  assert.equal(state.messages[0].text, prompt);
  assert.equal(state.messages[0].role, 'user');
  assert.equal(state.status, 'starting');
});

test('通用 CLI delta 合并到当前回答，并保留回答来源', () => {
  let state = startConversationTurn(createConversationState({
    projectId: 'p1', providerId: 'grok',
  }), {
    runId: 'chat-1', projectId: 'p1', providerId: 'grok', prompt: '开始',
  });
  state = applyConversationChatEvent(state, {
    runId: 'chat-1', providerId: 'grok', kind: 'assistant_delta', data: { text: '正在' },
  });
  state = applyConversationChatEvent(state, {
    runId: 'chat-1', providerId: 'grok', kind: 'assistant_delta', data: { text: '处理' },
  });
  assert.equal(state.messages.at(-1).text, '正在处理');
  assert.equal(state.messages.at(-1).tool, 'grok');
  state = applyConversationChatEvent(state, {
    runId: 'chat-1', providerId: 'grok', kind: 'assistant_message', data: { text: '处理完成。' },
  });
  assert.equal(state.messages.at(-1).text, '处理完成。');
  assert.equal(state.messages.at(-1).pending, false);
});

test('旧运行事件不能污染当前对话，未知事件安全忽略', () => {
  const state = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-new', projectId: 'p1', prompt: '开始',
  });
  assert.equal(applyCodexChatEvent(state, {
    runId: 'chat-old', kind: 'assistant_delta', data: { text: '污染' },
  }), state);
  assert.equal(applyCodexChatEvent(state, {
    runId: 'chat-new', kind: 'future-event', data: {},
  }), state);
});

test('终态拒绝迟到的增量，避免完成后又被旧事件污染', () => {
  let state = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-1', projectId: 'p1', prompt: '开始',
  });
  state = applyCodexChatEvent(state, {
    runId: 'chat-1', kind: 'completed', data: { status: 'completed' },
  });
  const completed = state;
  state = applyCodexChatEvent(state, {
    runId: 'chat-1', kind: 'assistant_delta', data: { text: '迟到内容' },
  });
  assert.equal(state, completed);
  assert.equal(state.messages.at(-1).text, '');
});

test('取消请求与完成事件撞车时，迟到的取消终态仍然优先', () => {
  let state = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-cancel-race', projectId: 'p1', prompt: '开始',
  });
  state = applyCodexChatEvent(state, {
    runId: 'chat-cancel-race', kind: 'completed', data: { status: 'completed' },
  });
  state = applyCodexChatEvent(state, {
    runId: 'chat-cancel-race', kind: 'cancelled', data: {},
  });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.notice, '已停止这次处理');
});

test('活动按 item ID 更新，完成和停止都形成确定终态', () => {
  let state = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-1', projectId: 'p1', prompt: '开始',
  });
  state = applyCodexChatEvent(state, {
    runId: 'chat-1', kind: 'activity', data: { id: 'item-1', title: '更新项目', status: 'inProgress' },
  });
  state = applyCodexChatEvent(state, {
    runId: 'chat-1', kind: 'activity', data: { id: 'item-1', status: 'completed' },
  });
  assert.equal(state.activities.length, 1);
  assert.equal(state.activities[0].status, 'completed');
  state = applyCodexChatEvent(state, {
    runId: 'chat-1', kind: 'completed', data: { status: 'completed' },
  });
  assert.equal(state.status, 'completed');
  assert.equal(state.messages.at(-1).pending, false);

  let stopped = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-2', projectId: 'p1', prompt: '再来',
  });
  stopped = applyCodexChatEvent(stopped, { runId: 'chat-2', kind: 'cancelled', data: {} });
  assert.equal(stopped.status, 'cancelled');
});

test('项目活动只保留最近的有界记录', () => {
  let state = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-activity-bound', projectId: 'p1', prompt: '检查项目',
  });
  for (let index = 0; index < MAX_CONVERSATION_ACTIVITIES + 8; index += 1) {
    state = applyCodexChatEvent(state, {
      runId: 'chat-activity-bound',
      kind: 'activity',
      data: { id: `activity-${index}`, title: `活动 ${index}` },
    });
  }
  assert.equal(state.activities.length, MAX_CONVERSATION_ACTIVITIES);
  assert.equal(state.activities[0].id, 'activity-8');
  assert.equal(state.activities.at(-1).id, `activity-${MAX_CONVERSATION_ACTIVITIES + 7}`);
});

test('历史预览只接收 user 和 assistant 消息', () => {
  const state = loadConversationTranscript({
    projectId: 'p1',
    threadId: 'thread-1',
    sourceTool: 'claude',
    messages: [
      { role: 'user', text: '问题' },
      { role: 'tool', text: '私有工具输出' },
      { role: 'assistant', text: '回答' },
    ],
  });
  assert.equal(state.threadId, 'thread-1');
  assert.equal(state.threadTool, 'claude');
  assert.equal(state.sourceTool, 'claude');
  assert.equal(state.sourceSessionId, 'thread-1');
  assert.equal(state.messages.at(-1).tool, 'claude');
  assert.deepEqual(state.messages.map(message => message.text), ['问题', '回答']);
});

test('同一项目两条历史会话的消息 id 不同，展开状态不串台', () => {
  const load = threadId => loadConversationTranscript({
    projectId: 'p1',
    threadId,
    sourceTool: 'grok',
    messages: [
      { role: 'user', text: '问题' },
      { role: 'assistant', text: '回答' },
    ],
  });
  const first = load('session-a');
  const second = load('session-b');
  assert.equal(first.messages.length, second.messages.length);
  first.messages.forEach((message, index) => {
    assert.notEqual(
      message.id,
      second.messages[index].id,
      `同项目不同会话的第 ${index} 条消息 id 必须不同`,
    );
  });
  const again = load('session-a');
  assert.deepEqual(
    again.messages.map(message => message.id),
    first.messages.map(message => message.id),
    '同一条会话重新打开时 id 保持稳定，DOM 复用不失效',
  );
});

test('历史对话保留后端验证过的图片附件并拒绝外部地址', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const state = loadConversationTranscript({
    projectId: 'p1',
    threadId: 'thread-image',
    sourceTool: 'grok',
    messages: [{
      role: 'user',
      text: '这是设置页吗',
      attachments: [
        { kind: 'image', mimeType: 'image/png', dataUrl, alt: '设置截图' },
        { kind: 'image', mimeType: 'image/png', dataUrl: 'https://example.com/a.png' },
      ],
    }],
  });
  assert.deepEqual(state.messages[0].attachments, [{
    kind: 'image',
    mimeType: 'image/png',
    dataUrl,
    alt: '设置截图',
  }]);
});

test('切换 CLI 把当前线程变成交接来源，不会把跨 CLI ID 当成续接 ID', () => {
  const original = loadConversationTranscript({
    projectId: 'p1',
    providerId: 'claude',
    sourceTool: 'claude',
    threadId: 'claude-thread',
    messages: [{ role: 'assistant', text: 'Claude 已完成第一步' }],
  });
  const switched = selectConversationProvider(original, 'grok');
  assert.equal(switched.providerId, 'grok');
  assert.equal(switched.threadId, '');
  assert.equal(switched.threadTool, '');
  assert.deepEqual(conversationRunContext(switched), {
    providerId: 'grok',
    threadId: '',
    handoffProviderId: 'claude',
    handoffSessionId: 'claude-thread',
  });

  const restored = selectConversationProvider(switched, 'claude');
  assert.equal(restored.threadId, 'claude-thread');
  assert.equal(restored.threadTool, 'claude');
  assert.equal(restored.sourceTool, '');
});

test('新 CLI 建立线程后接管后续会话，并清除旧交接来源', () => {
  let state = selectConversationProvider(loadConversationTranscript({
    projectId: 'p1',
    sourceTool: 'claude',
    threadId: 'claude-thread',
    messages: [],
  }), 'grok');
  state = startConversationTurn(state, {
    runId: 'chat-grok', projectId: 'p1', providerId: 'grok', prompt: '继续完成',
  });
  assert.equal(state.messages.at(-1).tool, 'grok');
  assert.equal(selectConversationProvider(state, 'agy'), state, '运行中禁止切换 CLI');

  const wrongProvider = applyConversationChatEvent(state, {
    runId: 'chat-grok', providerId: 'claude', kind: 'assistant_delta', data: { text: '污染' },
  });
  assert.equal(wrongProvider, state);

  state = applyConversationChatEvent(state, {
    runId: 'chat-grok', providerId: 'grok', kind: 'thread', data: { threadId: 'grok-thread' },
  });
  assert.equal(state.threadId, 'grok-thread');
  assert.equal(state.threadTool, 'grok');
  assert.equal(state.sourceTool, '');
  assert.equal(state.sourceSessionId, '');
  assert.deepEqual(conversationRunContext(state), {
    providerId: 'grok',
    threadId: 'grok-thread',
    handoffProviderId: '',
    handoffSessionId: '',
  });
});

test('旧 Codex 事件导出保留为通用实现别名', () => {
  assert.equal(applyCodexChatEvent, applyConversationChatEvent);
});

test('空白新对话不算已打开会话，有消息、线程或交接来源才需要新对话入口', () => {
  assert.equal(conversationHasOpenSession(createConversationState({ projectId: 'p1' })), false);
  assert.equal(conversationHasOpenSession(createConversationState({
    projectId: 'p1',
    threadId: 'thread-1',
    threadTool: 'codex',
  })), true);
  assert.equal(conversationHasOpenSession(createConversationState({
    projectId: 'p1',
    sourceTool: 'claude',
    sourceSessionId: 'claude-1',
  })), true);
  const withMessages = startConversationTurn(createConversationState({ projectId: 'p1' }), {
    runId: 'chat-1',
    projectId: 'p1',
    prompt: '开始',
  });
  assert.equal(conversationHasOpenSession(withMessages), true);
});
