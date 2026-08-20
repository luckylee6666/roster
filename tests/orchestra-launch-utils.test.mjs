import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitOrchestraFilesTransaction,
  createLatestRequestGate,
  restoreOrchestraFileSnapshot,
  runOrchestraLaunchTransaction,
} from '../src/orchestra-launch-utils.js';

test('异步弹窗请求只允许最后一次结果生效，关闭后旧请求也会失效', () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test('目标写入后计划提交失败会恢复两份旧文件，并保留原始错误', async () => {
  const files = new Map([
    ['goal.md', '# 旧目标\n'],
    ['plan.md', '## 旧计划\n'],
  ]);
  const planWriteError = new Error('写 plan.md 失败');
  let firstPlanWrite = true;
  let caught = null;

  try {
    await commitOrchestraFilesTransaction({
      read: async file => files.get(file),
      write: async (file, content) => {
        if (file === 'plan.md' && firstPlanWrite) {
          firstPlanWrite = false;
          throw planWriteError;
        }
        files.set(file, content);
      },
      goalContent: '# 新目标\n',
    });
  } catch (error) {
    caught = error;
  }

  assert.strictEqual(caught, planWriteError);
  assert.equal(caught.restoreError, undefined);
  assert.deepEqual(Object.fromEntries(files), {
    'goal.md': '# 旧目标\n',
    'plan.md': '## 旧计划\n',
  });
});

test('提交失败后的恢复也失败时，把恢复错误挂到原始错误上', async () => {
  const files = new Map([
    ['goal.md', '旧目标'],
    ['plan.md', '旧计划'],
  ]);
  const planWriteError = new Error('清空计划失败');
  const restoreGoalError = new Error('恢复旧目标失败');
  let planWriteCount = 0;
  let caught = null;

  try {
    await commitOrchestraFilesTransaction({
      read: async file => files.get(file),
      write: async (file, content) => {
        if (file === 'plan.md' && planWriteCount++ === 0) throw planWriteError;
        if (file === 'goal.md' && content === '旧目标') throw restoreGoalError;
        files.set(file, content);
      },
      goalContent: '新目标',
    });
  } catch (error) {
    caught = error;
  }

  assert.strictEqual(caught, planWriteError);
  assert.match(caught.restoreError?.message || '', /恢复原协作文件失败/);
  assert.deepEqual(caught.restoreError?.causes, [restoreGoalError]);
  assert.equal(files.get('goal.md'), '新目标');
  assert.equal(files.get('plan.md'), '旧计划');
});

test('成功提交返回旧快照，显式恢复可完整还原两份文件', async () => {
  const files = new Map([
    ['goal.md', '旧目标'],
    ['plan.md', '旧计划'],
  ]);
  const read = async file => files.get(file);
  const write = async (file, content) => { files.set(file, content); };

  const snapshot = await commitOrchestraFilesTransaction({
    read,
    write,
    goalContent: '新目标',
  });
  assert.deepEqual(snapshot, { goal: '旧目标', plan: '旧计划' });
  assert.deepEqual(Object.fromEntries(files), {
    'goal.md': '新目标',
    'plan.md': '',
  });

  await restoreOrchestraFileSnapshot({ snapshot, write });
  assert.deepEqual(Object.fromEntries(files), {
    'goal.md': '旧目标',
    'plan.md': '旧计划',
  });
});

test('启动事务先创建并验收终端，再提交共享文件', async () => {
  const calls = [];
  const result = await runOrchestraLaunchTransaction({
    brain: 'claude',
    workers: ['codex', 'grok'],
    participants: ['claude', 'codex', 'grok', 'codex'],
    create: async (tool) => {
      calls.push(`create:${tool}`);
      return `${tool}-session`;
    },
    isReady: async (id, tool) => {
      calls.push(`ready:${tool}`);
      return id !== 'grok-session';
    },
    commit: async (outcome) => {
      calls.push(`commit:${outcome.readyWorkers.join(',')}`);
    },
    rollback: async () => assert.fail('成功事务不应回滚'),
  });

  assert.deepEqual(calls, [
    'create:claude',
    'ready:claude',
    'create:codex',
    'ready:codex',
    'create:grok',
    'ready:grok',
    'commit:codex',
  ]);
  assert.deepEqual(result, {
    createdIds: ['claude-session', 'codex-session', 'grok-session'],
    readyIds: ['claude-session', 'codex-session'],
    failedIds: ['grok-session'],
    sessionIds: {
      claude: 'claude-session',
      codex: 'codex-session',
    },
    readyWorkers: ['codex'],
  });
});

for (const scenario of [
  {
    name: '大脑失败',
    code: 'brain_not_ready',
    ready: new Set(['codex']),
  },
  {
    name: 'worker 全失败',
    code: 'workers_not_ready',
    ready: new Set(['claude']),
  },
]) {
  test(`${scenario.name}时不提交文件、不切换旧协作，并精确回滚本轮终端`, async () => {
    const previousActive = { id: 'old-orchestra' };
    let active = previousActive;
    let committed = false;
    let rolledBack = null;

    await assert.rejects(async () => {
      const outcome = await runOrchestraLaunchTransaction({
        brain: 'claude',
        workers: ['codex'],
        create: async tool => `${tool}-new`,
        isReady: async (_id, tool) => scenario.ready.has(tool),
        commit: async () => { committed = true; },
        rollback: async ids => { rolledBack = ids; },
      });
      active = outcome;
    }, error => error?.code === scenario.code);

    assert.equal(committed, false);
    assert.strictEqual(active, previousActive);
    assert.deepEqual(rolledBack, ['claude-new', 'codex-new']);
  });
}

test('提交共享文件失败会回滚终端，并保留原始错误', async () => {
  const commitError = new Error('写 plan.md 失败');
  const previousActive = { id: 'old-orchestra' };
  let active = previousActive;
  let rolledBack = null;
  let caught = null;

  try {
    active = await runOrchestraLaunchTransaction({
      brain: 'claude',
      workers: ['codex'],
      create: async tool => `${tool}-new`,
      isReady: async () => true,
      commit: async () => { throw commitError; },
      rollback: async ids => { rolledBack = ids; },
    });
  } catch (error) {
    caught = error;
  }

  assert.strictEqual(caught, commitError);
  assert.strictEqual(active, previousActive);
  assert.deepEqual(rolledBack, ['claude-new', 'codex-new']);
});

test('回滚本身失败不能掩盖启动事务的原始错误', async () => {
  const originalError = new Error('创建 Codex 失败');
  const rollbackError = new Error('清理 PTY 失败');
  let caught = null;

  try {
    await runOrchestraLaunchTransaction({
      brain: 'claude',
      workers: ['codex'],
      create: async (tool) => {
        if (tool === 'codex') throw originalError;
        return 'claude-new';
      },
      isReady: async () => true,
      rollback: async () => { throw rollbackError; },
    });
  } catch (error) {
    caught = error;
  }

  assert.strictEqual(caught, originalError);
  assert.strictEqual(caught.rollbackError, rollbackError);
});
