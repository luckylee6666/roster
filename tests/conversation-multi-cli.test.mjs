import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('最近对话汇总各家 CLI，并把真实来源工具传给历史预览', async () => {
  const conversation = await read('src/conversation-mode.js');

  assert.doesNotMatch(
    conversation,
    /history\?\.groups\?\.find\(group\s*=>\s*group\.tool\s*===\s*['"]codex['"]\)/,
    '最近对话不能再只读取 Codex 分组',
  );
  assert.match(
    conversation,
    /class(?:Name)?[^\n]*conversation-history-tool|['"]conversation-history-tool['"]/,
    '每条最近对话都应渲染 CLI 色标',
  );
  assert.match(
    conversation,
    /sourceTool:\s*[A-Za-z_$][\w$]*\.tool/,
    '打开历史时必须传入该条会话自己的 tool，不能固定为 Codex',
  );
});

test('对话模式提供多 CLI 选择和常用项目操作', async () => {
  const html = await read('src/index.html');
  for (const id of [
    'conversation-provider-select',
    'conversation-project-context',
    'conversation-handoff',
    'conversation-open-folder',
    'conversation-refresh-project',
  ]) {
    assert.equal(
      (html.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length,
      1,
      `${id} 应在对话工作台中唯一存在`,
    );
  }
});

test('对话运行使用通用 IPC、通用事件并携带 providerId', async () => {
  const [conversation, controller, rust] = await Promise.all([
    read('src/conversation-mode.js'),
    read('src/conversation-run-controller.js'),
    read('src-tauri/src/lib.rs'),
  ]);

  assert.match(controller, /invoke\(['"]conversation_chat_start['"],\s*\{\s*request\s*\}\)/);
  assert.match(controller, /invoke\(['"]conversation_chat_cancel['"],\s*\{\s*runId\s*\}\)/);
  assert.match(conversation, /listen\(['"]conversation-chat-event['"]/);
  assert.match(
    conversation,
    /runController\.start\(\{[\s\S]*?providerId\s*:/,
    '每轮请求必须明确记录所选 CLI',
  );
  assert.match(rust, /conversation_chat_start/);
  assert.match(rust, /conversation_chat_cancel/);
});

test('对话状态和历史消息保留工具来源，切换 CLI 后不会冒充 Codex', async () => {
  const state = await read('src/conversation-state.js');

  assert.match(
    state,
    /createConversationState\(\{[\s\S]*?(?:providerId|tool)\s*=/,
    '对话状态必须保存当前 CLI',
  );
  assert.match(
    state,
    /startConversationTurn\([^\n]*\{[^}]*?(?:providerId|tool)/,
    '新一轮应把 CLI 写入消息状态',
  );
  assert.match(
    state,
    /role:\s*['"]assistant['"][\s\S]{0,180}tool\s*:/,
    'assistant 草稿消息必须保留生成它的 CLI',
  );
  assert.match(
    state,
    /loadConversationTranscript\([^\n]*\{[^}]*?(?:sourceTool|providerId|tool)/,
    '加载历史时必须保留来源 CLI',
  );
});
