import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLI_TOOL_IDS,
  CLI_TOOLS,
  CONVERSATION_CLI_TOOL_IDS,
  HISTORY_CLI_TOOL_IDS,
  filterCliTools,
  installedCliTools,
  isKnownCliTool,
  normalizeInstalledCliIds,
  orderCliTools,
  stepCliToolId,
  visibleCliTools,
} from '../src/cli-tools.js';

test('登记表覆盖现有 CLI，并按 id / 别名过滤', () => {
  assert.deepEqual(CLI_TOOL_IDS, ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo', 'commandcode']);
  assert.equal(CLI_TOOLS.length, CLI_TOOL_IDS.length);
  assert.equal(isKnownCliTool('grok --resume abc'), true);
  assert.equal(isKnownCliTool('mimo --continue'), true);
  assert.equal(isKnownCliTool('commandcode -c'), true);
  assert.equal(isKnownCliTool('bash'), false);
  assert.deepEqual(filterCliTools('g').map(tool => tool.id), ['grok']);
  assert.deepEqual(filterCliTools('xai').map(tool => tool.id), ['grok']);
  assert.deepEqual(filterCliTools('tongyi').map(tool => tool.id), ['qwen']);
  assert.deepEqual(filterCliTools('xiaomi').map(tool => tool.id), ['mimo']);
  assert.deepEqual(filterCliTools('mimocode').map(tool => tool.id), ['mimo']);
  assert.deepEqual(filterCliTools('command-code').map(tool => tool.id), ['commandcode']);
  assert.deepEqual(filterCliTools('cmdc').map(tool => tool.id), ['commandcode']);
  assert.ok(filterCliTools('code').map(tool => tool.id).includes('codex'));
  assert.deepEqual(filterCliTools('没有这个'), []);
  assert.equal(filterCliTools('  ').length, CLI_TOOLS.length);
});

test('能力标记把未接入的 CLI 挡在对话与历史之外', () => {
  // Command Code 目前只有开发模式登记：对话协议（P2）与磁盘历史（P1）未接入，
  // 不能出现在对话 Provider 选项、卡片历史或交接来源里。
  assert.deepEqual(CONVERSATION_CLI_TOOL_IDS, ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo']);
  assert.deepEqual(HISTORY_CLI_TOOL_IDS, ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo']);
  assert.equal(CONVERSATION_CLI_TOOL_IDS.includes('commandcode'), false);
  assert.equal(HISTORY_CLI_TOOL_IDS.includes('commandcode'), false);
});

test('卡片只展示本机已安装且已登记的 CLI', () => {
  assert.deepEqual(normalizeInstalledCliIds(['grok', 'nope', 'grok', 'claude']), ['claude', 'grok']);
  assert.deepEqual(normalizeInstalledCliIds(null), []);
  assert.deepEqual(
    installedCliTools(['codex', 'agy', 'mimo', 'bash']).map(tool => tool.id),
    ['codex', 'agy', 'mimo'],
  );
  assert.deepEqual(installedCliTools([]), []);
});

test('最近用过的 CLI 排到最前，方向键在可见列表里循环', () => {
  const ordered = orderCliTools(CLI_TOOLS, 'codex resume x-1');
  assert.equal(ordered[0].id, 'codex');
  assert.deepEqual(ordered.slice(1).map(tool => tool.id), ['claude', 'grok', 'opencode', 'agy', 'qwen', 'mimo', 'commandcode']);
  const visible = visibleCliTools('c', 'codex');
  assert.deepEqual(visible.map(tool => tool.id), ['codex', 'claude', 'commandcode']);
  assert.equal(stepCliToolId(visible, 'codex', 1), 'claude');
  assert.equal(stepCliToolId(visible, 'claude', 1), 'commandcode');
  assert.equal(stepCliToolId(visible, 'commandcode', 1), 'codex');
  assert.equal(stepCliToolId(visible, '', 1), 'codex');
  assert.equal(stepCliToolId([], 'grok', 1), '');
});
