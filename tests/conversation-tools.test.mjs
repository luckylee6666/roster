import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_PROVIDER_CAPABILITIES,
  CONVERSATION_PROVIDERS,
  conversationHistoryKey,
  conversationProvider,
  conversationProviderOptions,
  flattenConversationHistory,
  latestConversationSession,
} from '../src/conversation-tools.js';

test('对话 Provider 基于统一 CLI 登记并为未知工具提供只读回退', () => {
  assert.deepEqual(
    CONVERSATION_PROVIDERS.map(provider => provider.id),
    ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo'],
  );
  assert.deepEqual(
    CONVERSATION_PROVIDERS.filter(provider => provider.runnable).map(provider => provider.id),
    ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo'],
  );
  const unknown = conversationProvider(' FutureCLI ', '未来模型');
  assert.deepEqual(
    { id: unknown.id, label: unknown.label, mark: unknown.mark, runnable: unknown.runnable, known: unknown.known },
    { id: 'futurecli', label: '未来模型', mark: '未来', runnable: false, known: false },
  );
  assert.match(unknown.unavailableReason, /查看历史会话/);
});

test('八家已安装 CLI 都可进入对话模式，模型与推理强度按能力映射', () => {
  const options = conversationProviderOptions(['qwen', 'codex', 'claude', 'mimo', 'unknown']);
  assert.deepEqual(options.map(provider => provider.id), ['claude', 'codex', 'qwen', 'mimo']);
  const opencode = conversationProvider('opencode');
  const mimo = conversationProvider('mimo');
  const qwen = conversationProvider('qwen');
  assert.equal(opencode.runnable, true);
  assert.equal(mimo.runnable, true);
  assert.equal(qwen.runnable, true);
  assert.equal(opencode.supportsModel, true);
  assert.equal(qwen.supportsModel, true);
  assert.equal(mimo.supportsModel, true);
  assert.equal(opencode.supportsEffort, true);
  assert.equal(qwen.supportsEffort, false);
  assert.equal(mimo.supportsEffort, true);
  assert.equal(CONVERSATION_PROVIDER_CAPABILITIES.codex.effort, true);
  assert.equal(CONVERSATION_PROVIDER_CAPABILITIES.gemini, undefined, 'Gemini 已整体移除');
});

test('历史键同时包含工具和 id，相同会话 id 不会跨 CLI 冲突', () => {
  assert.notEqual(
    conversationHistoryKey('claude', 'same-id'),
    conversationHistoryKey('grok', 'same-id'),
  );
  assert.notEqual(
    conversationHistoryKey('a:b', 'c'),
    conversationHistoryKey('a', 'b:c'),
  );
});

test('全部 CLI 历史展平成倒序时间线，未安装和未知工具仍然保留', () => {
  const history = {
    groups: [
      {
        tool: 'claude',
        label: 'Claude',
        sessions: [
          { id: 'same-id', title: 'Claude 对话', preview: '先修复', atMs: 100 },
          { id: 'tie-first', title: '同时间第一条', atMs: 300 },
        ],
      },
      {
        tool: 'qwen',
        label: 'Qwen',
        sessions: [{ id: 'same-id', title: 'Qwen 对话', preview: '继续处理', atMs: 400 }],
      },
      {
        tool: 'future',
        label: '未来 CLI',
        sessions: [{ id: 'tie-second', title: '', preview: '仍应展示', atMs: 300 }],
      },
    ],
  };

  const rows = flattenConversationHistory(history, { limit: 20 });
  assert.deepEqual(rows.map(row => `${row.tool}:${row.id}`), [
    'qwen:same-id',
    'claude:tie-first',
    'future:tie-second',
    'claude:same-id',
  ]);
  assert.equal(rows[0].label, 'Qwen');
  assert.equal(rows[0].runnable, true);
  assert.equal(rows[2].label, '未来 CLI');
  assert.equal(rows[2].title, '未命名会话');
  assert.equal(rows[2].preview, '仍应展示');
  assert.notEqual(rows[0].key, rows[3].key);
});

test('历史时间线默认最多 12 条，也支持显式关闭或放宽上限', () => {
  const groups = [{
    tool: 'grok',
    label: 'Grok',
    sessions: Array.from({ length: 14 }, (_, index) => ({
      id: `g-${index}`,
      title: `会话 ${index}`,
      atMs: index,
    })),
  }];
  assert.equal(flattenConversationHistory(groups).length, 12);
  assert.equal(flattenConversationHistory(groups, { limit: 0 }).length, 0);
  assert.equal(flattenConversationHistory(groups, { limit: Infinity }).length, 14);
  assert.equal(flattenConversationHistory(null).length, 0);
});

test('进入项目时取时间线最近一条历史，没有有效会话才视为可新开', () => {
  const history = {
    groups: [
      {
        tool: 'codex',
        label: 'Codex',
        sessions: [{ id: 'old-codex', title: '旧 Codex', atMs: 100 }],
      },
      {
        tool: 'grok',
        label: 'Grok',
        sessions: [
          { id: '', title: '无效', atMs: 400 },
          { id: 'latest-grok', title: '最近 Grok', atMs: 300 },
        ],
      },
    ],
  };
  assert.deepEqual(
    { tool: latestConversationSession(history).tool, id: latestConversationSession(history).id },
    { tool: 'grok', id: 'latest-grok' },
  );
  assert.equal(latestConversationSession({ groups: [] }), null);
  assert.equal(latestConversationSession(null), null);
});

test('粘贴图片预检只放行白名单格式、大小与数量', async () => {
  const { inspectPastedImage, CONVERSATION_ATTACHMENT_LIMITS } = await import('../src/conversation-tools.js');
  assert.equal(inspectPastedImage({ type: 'image/png', size: 1024 }).ok, true);
  assert.equal(inspectPastedImage({ type: 'image/webp', size: 1024 }).ok, true);
  assert.match(inspectPastedImage({ type: 'text/plain', size: 1024 }).reason, /只支持/);
  assert.match(inspectPastedImage({ type: 'image/png', size: 0 }).reason, /8MB/);
  assert.match(
    inspectPastedImage({ type: 'image/png', size: CONVERSATION_ATTACHMENT_LIMITS.maxBytes + 1 }).reason,
    /8MB/,
  );
  assert.equal(inspectPastedImage({ type: 'image/png', size: 10 }, 3).ok, true);
  assert.match(inspectPastedImage({ type: 'image/png', size: 10 }, 4).reason, /最多附带/);
});

test('dataUrlBase64 只接受 base64 图片 dataURL', async () => {
  const { dataUrlBase64 } = await import('../src/conversation-tools.js');
  assert.equal(dataUrlBase64('data:image/png;base64,aGVsbG8='), 'aGVsbG8=');
  assert.equal(dataUrlBase64('data:image/png,aGVsbG8='), '');
  assert.equal(dataUrlBase64('data:text/plain;base64,aGVsbG8='), '');
  assert.equal(dataUrlBase64(''), '');
});
