import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ORCHESTRA_BRAIN,
  orchestraBrainPrompt,
  orchestraBroadcastPrompt,
  orchestraInboxFile,
  orchestraRoleForTool,
  orchestraRoleLabel,
  orchestraWorkerPrompt,
  orchestraWorkers,
  isAllowedOrchestraFile,
  normalizeOrchestraConfig,
} from '../src/orchestra-utils.js';

test('协作默认 Claude 做大脑，另外两个干活', () => {
  assert.equal(DEFAULT_ORCHESTRA_BRAIN, 'claude');
  assert.deepEqual(orchestraWorkers('claude'), ['codex', 'grok']);
  assert.deepEqual(orchestraWorkers('codex'), ['claude', 'grok']);
  assert.deepEqual(normalizeOrchestraConfig({ brain: 'grok' }), {
    brain: 'grok',
    workers: ['claude', 'codex'],
    kit: ['claude', 'codex', 'grok'],
  });
  assert.equal(orchestraRoleForTool({ brain: 'claude', workers: ['codex', 'grok'] }, 'claude'), 'brain');
  assert.equal(orchestraRoleForTool({ brain: 'claude', workers: ['codex', 'grok'] }, 'codex'), 'worker');
  assert.equal(orchestraRoleLabel('brain'), '大脑');
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

test('广播提示按角色改写，非法协作文件名直接拒绝', () => {
  assert.match(orchestraBroadcastPrompt({ role: 'brain', text: '补一层验收' }), /补充给大脑/);
  assert.match(orchestraBroadcastPrompt({ role: 'worker', tool: 'grok', text: '补测试' }), /Grok/);
  assert.equal(isAllowedOrchestraFile('goal.md'), true);
  assert.equal(isAllowedOrchestraFile('../secret.md'), false);
  assert.equal(isAllowedOrchestraFile('inbox/../goal.md'), false);
});
