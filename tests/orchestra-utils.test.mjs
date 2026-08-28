import assert from 'node:assert/strict';
import test from 'node:test';

import { CLI_TOOL_IDS } from '../src/cli-tools.js';
import {
  DEFAULT_ORCHESTRA_BRAIN,
  DEFAULT_ORCHESTRA_WORKERS,
  ORCHESTRA_KIT,
  orchestraBrainPrompt,
  orchestraBroadcastPrompt,
  orchestraInboxFile,
  orchestraRoleForTool,
  orchestraRoleLabel,
  orchestraToolLabel,
  orchestraWorkerPrompt,
  orchestraWorkers,
  isAllowedOrchestraFile,
  normalizeOrchestraConfig,
} from '../src/orchestra-utils.js';

test('协作默认 Claude 做大脑，另外两个干活', () => {
  assert.equal(DEFAULT_ORCHESTRA_BRAIN, 'claude');
  assert.deepEqual(DEFAULT_ORCHESTRA_WORKERS, ['codex', 'grok']);
  assert.deepEqual(ORCHESTRA_KIT, [
    'claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo',
  ]);
  assert.deepEqual(orchestraWorkers('claude'), ['codex', 'grok']);
  assert.deepEqual(orchestraWorkers('codex'), ['claude', 'grok']);
  assert.deepEqual(normalizeOrchestraConfig({ brain: 'grok' }), {
    brain: 'grok',
    workers: ['claude', 'codex'],
    kit: ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo'],
  });
  assert.equal(orchestraRoleForTool({ brain: 'claude', workers: ['codex', 'grok'] }, 'claude'), 'brain');
  assert.equal(orchestraRoleForTool({ brain: 'claude', workers: ['codex', 'grok'] }, 'codex'), 'worker');
  assert.equal(orchestraRoleLabel('brain'), '大脑');
});

test('协作配置支持登记表里的任意大脑和多个干活终端', () => {
  assert.deepEqual(normalizeOrchestraConfig({
    brain: 'mimo',
    workers: ['qwen', 'agy', 'qwen', 'mimo', 'unknown', '', 'opencode --continue'],
  }), {
    brain: 'mimo',
    workers: ['qwen', 'agy', 'opencode'],
    kit: ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo'],
  });
  assert.equal(orchestraToolLabel('mimo'), 'MiMo Code');
  assert.equal(orchestraToolLabel('opencode --continue'), 'OpenCode');
  assert.equal(orchestraToolLabel('qwen'), 'Qwen');
});

test('非法、重复或空角色选择会归一化，只有未指定 workers 才使用旧默认', () => {
  assert.deepEqual(normalizeOrchestraConfig({
    brain: 'not-a-cli',
    workers: ['claude', 'claude', 'not-a-cli'],
    kit: ['claude', 'codex', 'grok', 'codex', '', 'not-a-cli'],
  }), {
    brain: 'claude',
    workers: [],
    kit: ['claude', 'codex', 'grok'],
  });
  assert.deepEqual(normalizeOrchestraConfig({ brain: 'qwen' }).workers, ['codex', 'grok']);
  assert.deepEqual(normalizeOrchestraConfig({ brain: 'qwen', workers: [] }).workers, []);
  assert.deepEqual(normalizeOrchestraConfig({ brain: 'qwen', workers: null }).workers, []);
  assert.deepEqual(normalizeOrchestraConfig({
    brain: 'mimo',
    workers: ['mimo', 'invalid'],
    kit: ['mimo', 'qwen'],
  }), {
    brain: 'mimo',
    workers: [],
    kit: ['mimo', 'qwen'],
  });
  assert.deepEqual(normalizeOrchestraConfig({
    brain: 'mimo',
    workers: [],
    kit: [],
  }), {
    brain: 'claude',
    workers: [],
    kit: [],
  });
});

test('大脑提示要求写入计划文件且不要改业务代码', () => {
  const prompt = orchestraBrainPrompt({
    goal: '修好协作会话',
    workers: ['codex', 'grok'],
  });
  assert.match(prompt, /修好协作会话/);
  assert.match(prompt, /\.vibe\/orchestra\/plan\.md/);
  assert.match(prompt, /## Codex/);
  assert.match(prompt, /## Grok/);
  assert.match(prompt, /不要亲自改业务代码/);
});

test('干活提示只认自己的章节并回写 inbox', () => {
  const prompt = orchestraWorkerPrompt({
    tool: 'codex',
    brain: 'claude',
    goal: '修好协作会话',
    plan: '## Codex\n- 改 Rust\n\n## Grok\n- 补测试\n',
    inboxFile: '.vibe/orchestra/inbox/codex.md',
  });
  assert.match(prompt, /动手的 Codex/);
  assert.match(prompt, /大脑是 Claude/);
  assert.match(prompt, /## Codex/);
  assert.match(prompt, /inbox\/codex\.md/);
  assert.equal(orchestraInboxFile('grok'), 'inbox/grok.md');
});

test('新增 CLI 的提示词使用登记名称且允许各自 inbox', () => {
  const prompt = orchestraWorkerPrompt({
    tool: 'mimo',
    brain: 'qwen',
    plan: '## MiMo Code\n- 修复缓存\n',
  });
  assert.match(prompt, /动手的 MiMo Code/);
  assert.match(prompt, /大脑是 Qwen/);
  assert.match(prompt, /## MiMo Code/);
  assert.equal(orchestraInboxFile('qwen'), 'inbox/qwen.md');
  assert.equal(orchestraInboxFile('mimo'), 'inbox/mimo.md');
});

test('登记表里的每个 CLI 都动态映射到安全 inbox，非法名称不能穿越目录', () => {
  for (const tool of CLI_TOOL_IDS) {
    assert.match(tool, /^[a-z][a-z0-9_-]{0,31}$/, `${tool} 必须符合后端 inbox id 规则`);
    const inbox = `inbox/${tool}.md`;
    assert.equal(orchestraInboxFile(tool), inbox);
    assert.equal(isAllowedOrchestraFile(inbox), true);
  }

  for (const tool of [
    '',
    'unknown',
    'qwen/../../secret',
    'qwen.md',
  ]) {
    assert.equal(orchestraInboxFile(tool), '', `应拒绝 ${JSON.stringify(tool)}`);
  }

  for (const tool of ['../qwen', 'qwen\nsecret', '../../mimo --continue']) {
    const inbox = orchestraInboxFile(tool);
    assert.ok(inbox === '' || CLI_TOOL_IDS.some(id => inbox === `inbox/${id}.md`));
    assert.doesNotMatch(inbox, /(?:^|[/\\])\.\.(?:[/\\]|$)/);
  }

  for (const file of [
    'inbox/../goal.md',
    'inbox/qwen/../../secret.md',
    'inbox//qwen.md',
    'inbox/qwen.txt',
    '/inbox/qwen.md',
  ]) {
    assert.equal(isAllowedOrchestraFile(file), false, `应拒绝 ${JSON.stringify(file)}`);
  }
});

test('广播提示按角色改写，非法协作文件名直接拒绝', () => {
  assert.match(orchestraBroadcastPrompt({ role: 'brain', text: '补一层验收' }), /补充给大脑/);
  assert.match(orchestraBroadcastPrompt({ role: 'worker', tool: 'grok', text: '补测试' }), /Grok/);
  assert.equal(isAllowedOrchestraFile('goal.md'), true);
  assert.equal(isAllowedOrchestraFile('../secret.md'), false);
  assert.equal(isAllowedOrchestraFile('inbox/../goal.md'), false);
});
