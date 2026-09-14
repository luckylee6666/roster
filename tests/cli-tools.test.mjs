import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLI_TOOL_IDS,
  CLI_TOOLS,
  filterCliTools,
  installedCliTools,
  isKnownCliTool,
  normalizeInstalledCliIds,
  orderCliTools,
  stepCliToolId,
  visibleCliTools,
} from '../src/cli-tools.js';

test('登记表覆盖现有 CLI，并按 id / 别名过滤', () => {
  assert.deepEqual(CLI_TOOL_IDS, ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo']);
  assert.equal(CLI_TOOLS.length, CLI_TOOL_IDS.length);
  assert.equal(isKnownCliTool('grok --resume abc'), true);
  assert.equal(isKnownCliTool('mimo --continue'), true);
  assert.equal(isKnownCliTool('bash'), false);
  assert.deepEqual(filterCliTools('g').map(tool => tool.id), ['grok']);
  assert.deepEqual(filterCliTools('xai').map(tool => tool.id), ['grok']);
  assert.deepEqual(filterCliTools('tongyi').map(tool => tool.id), ['qwen']);
  assert.deepEqual(filterCliTools('xiaomi').map(tool => tool.id), ['mimo']);
  assert.deepEqual(filterCliTools('mimocode').map(tool => tool.id), ['mimo']);
  assert.ok(filterCliTools('code').map(tool => tool.id).includes('codex'));
  assert.deepEqual(filterCliTools('没有这个'), []);
  assert.equal(filterCliTools('  ').length, CLI_TOOLS.length);
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
  assert.deepEqual(ordered.slice(1).map(tool => tool.id), ['claude', 'grok', 'opencode', 'agy', 'qwen', 'mimo']);
  const visible = visibleCliTools('c', 'codex');
  assert.deepEqual(visible.map(tool => tool.id), ['codex', 'claude']);
  assert.equal(stepCliToolId(visible, 'codex', 1), 'claude');
  assert.equal(stepCliToolId(visible, 'claude', 1), 'codex');
  assert.equal(stepCliToolId(visible, '', 1), 'codex');
  assert.equal(stepCliToolId([], 'grok', 1), '');
});
