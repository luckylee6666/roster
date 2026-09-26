import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CLI_TOOLS } from '../src/cli-tools.js';
import { cliCommandName, normalizeCliToolName } from '../src/session-restore-utils.js';
import { handoffLaunchPrompt, validateSessionHandoffContent } from '../src/session-handoff-utils.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('async function startSessionHandoff()'), main.indexOf('let orchestraProject = null'));

function harness(targetTool = 'opencode', failure = '') {
  const project = { id: 'project', localPath: '/project', name: '项目' };
  const context = { project, sourceSessionId: 'source-terminal', sourceTool: 'codex', preview: { messages: [] } };
  const original = { status: 'running', tool: 'codex', cwd: project.localPath };
  const sessions = new Map([['source-terminal', original]]);
  const calls = [], messages = [], rollbacks = [];
  let released = false, api;
  const deps = {
    context, CLI_TOOLS, cliCommandName, normalizeCliToolName, handoffLaunchPrompt, validateSessionHandoffContent,
    activeSessionHandoffContext: () => ({ id: context.sourceSessionId, sourceTool: 'codex', project }),
    selectedSessionHandoffTarget: () => targetTool,
    el: { sessionHandoffContent: { value: '已完成任务一，接下来修复任务二。' } },
    sessionHandoffTargets: () => CLI_TOOLS.filter(tool => tool.id !== 'codex'),
    beginProjectToolOpening: () => 'opening', releaseProjectToolOpening: () => { released = true; },
    captureTerminalPaneState: () => 'previous-layout', setSessionHandoffBusy: () => {},
    closeSessionHandoff: () => {}, activateSession: () => {},
    invalidateProjectSessionHistory: () => {}, reloadVisibleProjectSessionHistory: () => {},
    sameProjectCwd: (a, b) => a === b, sessions,
    msg: (text, level) => messages.push({ text, level }),
    invoke: async (method, args) => {
      assert.equal(method, 'write_session_handoff');
      calls.push({ method, args });
      if (failure === 'write') throw new Error('写入失败');
      if (failure === 'invalidated') api.invalidate();
      return { relativePath: '.vibe/handoff/test.md' };
    },
    createProjectToolSession: async (p, command, options) => {
      assert.equal(p, project);
      calls.push({ method: 'create', command, options });
      sessions.set('new-terminal', { cwd: p.localPath, tool: command, status: failure === 'create' ? 'failed' : 'running', restorable: failure !== 'create' });
      return 'new-terminal';
    },
    injectToSession: async (id, prompt) => { calls.push({ method: 'inject', id, prompt }); return failure !== 'inject'; },
    rollbackCreatedSessions: async (ids, layout) => {
      assert.equal(layout, 'previous-layout'); rollbacks.push(ids); ids.forEach(id => sessions.delete(id));
    },
  };
  api = new Function(...Object.keys(deps), `let sessionHandoffContext = context, sessionHandoffBusy = false, sessionHandoffOperation = null;
    ${source}
    return { run: startSessionHandoff, invalidate: () => { sessionHandoffOperation = null; } };`)(...Object.values(deps));
  return { ...api, calls, messages, sessions, original, rollbacks, released: () => released };
}

for (const target of ['opencode', 'mimo', 'cmd']) {
  test(`Codex → ${target} 普通交接以原生初始参数携带文件提示，不延时盲打`, async () => {
    const h = harness(target);
    await h.run();
    const created = h.calls.find(call => call.method === 'create');
    assert.equal(created.command, cliCommandName(target));
    assert.match(created.options?.initialPrompt || '', /Codex/);
    assert.match(created.options.initialPrompt, /\.vibe\/handoff\/test\.md/);
    assert.equal(h.calls.some(call => call.method === 'inject'), false);
    assert.equal(h.messages.at(-1).level, 'info', '不能把请求启动当作目标已处理交接');
    assert.equal(h.sessions.get('source-terminal'), h.original);
    assert.equal(h.released(), true);
  });
}

for (const failure of ['write', 'create', 'invalidated']) {
  test(`Codex → OpenCode 的 ${failure} 失败不关闭来源、不回退盲打`, async () => {
    const h = harness('opencode', failure);
    await h.run();
    assert.equal(h.sessions.get('source-terminal'), h.original);
    assert.equal(h.sessions.has('new-terminal'), false);
    assert.equal(h.calls.some(call => call.method === 'inject'), false);
    assert.deepEqual(h.rollbacks, failure === 'create' ? [['new-terminal']] : []);
    assert.match(h.messages.at(-1).text, /交接失败/);
    assert.equal(h.released(), true);
  });
}

test('其他 CLI 保留原交接协议，注入失败仍只回滚新终端', async () => {
  const h = harness('claude', 'inject');
  await h.run();
  assert.equal(h.calls.filter(call => call.method === 'inject').length, 1);
  assert.equal(h.calls.find(call => call.method === 'create').options?.initialPrompt, undefined);
  assert.equal(h.sessions.get('source-terminal'), h.original);
  assert.deepEqual(h.rollbacks, [['new-terminal']]);
});
