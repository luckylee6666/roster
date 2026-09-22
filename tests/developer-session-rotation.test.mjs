import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CLI_TOOL_IDS } from '../src/cli-tools.js';
import { cliCommandName, normalizeCliToolName } from '../src/session-restore-utils.js';
import { buildSessionHandoffMarkdown, handoffLaunchPrompt, validateSessionHandoffContent } from '../src/session-handoff-utils.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const implementation = main.slice(main.indexOf('async function openFreshSessionForTool('), main.indexOf('function closeSessionPreview('));
const project = { id: 'project', localPath: '/projects/one', name: '项目' };
const source = { id: 'old-native-id', tool: 'cmd', title: '旧会话' };

function harness(failure = '') {
  const calls = [], messages = [], rollbacks = [];
  let released = 0;
  const original = { status: 'running', cwd: project.localPath, tool: 'cmd --session old-native-id' };
  const sessions = new Map([['old-terminal', original]]);
  const deps = {
    CLI_TOOL_IDS, cliCommandName, normalizeCliToolName, buildSessionHandoffMarkdown, handoffLaunchPrompt, validateSessionHandoffContent,
    historyOpenGate: { allow: () => true }, historyActionKey: () => 'key', beginProjectToolOpening: () => 'token',
    releaseProjectToolOpening: token => { assert.equal(token, 'token'); released++; },
    captureTerminalPaneState: () => ({ old: true }), sessions,
    sameProjectCwd: (a, b) => a === b, msg: text => messages.push(text), appLog: () => {}, activateSession: () => {},
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === failure) throw new Error('模拟失败');
      if (method === 'preview_session_handoff') return { sourceId: source.id, messages: [{ role: 'user', text: '继续测试任务' }] };
      if (method === 'project_context') return { exists: true, isRepo: false };
      if (method === 'write_session_handoff') return { relativePath: '.vibe/handoff/test.md' };
      assert.fail(`Unexpected IPC: ${method}`);
    },
    createProjectToolSession: async (p, command) => {
      calls.push({ method: 'create', command });
      assert.equal(p, project);
      sessions.set('new-terminal', { restorable: failure !== 'create', status: failure === 'create' ? 'failed' : 'running', tool: command, cwd: p.localPath });
      return 'new-terminal';
    },
    injectToSession: async (id, prompt) => { calls.push({ method: 'inject', id, prompt }); return failure !== 'inject'; },
    rollbackCreatedSessions: async (ids, state) => { rollbacks.push(ids); assert.deepEqual(state, { old: true }); ids.forEach(id => sessions.delete(id)); },
  };
  const run = new Function(...Object.keys(deps), `${implementation}; return openFreshSessionForTool;`)(...Object.values(deps));
  return { run: () => run(project, source), calls, messages, sessions, original, rollbacks, released: () => released };
}

test('开发模式同家轮换读取精确来源，以裸 CLI 新开并注入有界摘要，不改旧会话', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.calls.find(c => c.method === 'preview_session_handoff').args.id, source.id);
  assert.equal(h.calls.find(c => c.method === 'create').command, 'cmd');
  const draft = h.calls.find(c => c.method === 'write_session_handoff').args.content;
  assert.match(draft, /继续测试任务/);
  assert.ok(new TextEncoder().encode(draft).length <= 48 * 1024);
  const injection = h.calls.find(c => c.method === 'inject');
  assert.equal(injection.id, 'new-terminal');
  assert.match(injection.prompt, /当前是新会话/);
  assert.match(injection.prompt, /不要恢复、修改或删除旧会话记录/);
  assert.equal(h.sessions.get('old-terminal'), h.original);
  assert.equal(h.rollbacks.length, 0);
  assert.equal(h.released(), 1);
});

for (const failure of ['preview_session_handoff', 'write_session_handoff', 'create', 'inject']) {
  test(`同家轮换 ${failure} 失败只回滚本次新终端`, async () => {
    const h = harness(failure);
    await h.run();
    assert.equal(h.sessions.get('old-terminal'), h.original);
    assert.equal(h.sessions.has('new-terminal'), false);
    assert.deepEqual(h.rollbacks, ['create', 'inject'].includes(failure) ? [['new-terminal']] : []);
    assert.equal(h.released(), 1);
    assert.match(h.messages.at(-1), /轮换失败/);
  });
}
