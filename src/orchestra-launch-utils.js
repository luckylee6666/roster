function orchestraLaunchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedError(caught) {
  return caught instanceof Error ? caught : new Error(String(caught));
}

function normalizedParticipants(participants) {
  const seen = new Set();
  const tools = [];
  for (const value of Array.isArray(participants) ? participants : []) {
    const tool = String(value || '').trim();
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    tools.push(tool);
  }
  return tools;
}

/** 只允许最后一次异步打开请求更新弹窗。 */
export function createLatestRequestGate() {
  let revision = 0;
  return {
    begin() {
      revision += 1;
      return revision;
    },
    isCurrent(candidate) {
      return candidate === revision;
    },
    invalidate() {
      revision += 1;
    },
  };
}

export async function restoreOrchestraFileSnapshot({
  snapshot,
  write,
  goalFile = 'goal.md',
  planFile = 'plan.md',
} = {}) {
  if (!snapshot || typeof write !== 'function') {
    throw new TypeError('snapshot 和 write 必须提供');
  }
  const restored = await Promise.allSettled([
    Promise.resolve().then(() => write(goalFile, String(snapshot.goal ?? ''))),
    Promise.resolve().then(() => write(planFile, String(snapshot.plan ?? ''))),
  ]);
  const failures = restored
    .filter(result => result.status === 'rejected')
    .map(result => normalizedError(result.reason));
  if (failures.length) {
    const error = new Error(`恢复原协作文件失败：${failures.map(item => item.message).join('；')}`);
    error.causes = failures;
    throw error;
  }
}

/** 备份两份共享文件，顺序提交新目标与空计划；部分写入失败时恢复旧快照。 */
export async function commitOrchestraFilesTransaction({
  read,
  write,
  goalContent,
  goalFile = 'goal.md',
  planFile = 'plan.md',
} = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') {
    throw new TypeError('read 和 write 必须是函数');
  }
  const [goal, plan] = await Promise.all([read(goalFile), read(planFile)]);
  const snapshot = { goal: String(goal ?? ''), plan: String(plan ?? '') };
  try {
    await write(goalFile, String(goalContent ?? ''));
    await write(planFile, '');
  } catch (caught) {
    const error = normalizedError(caught);
    try {
      await restoreOrchestraFileSnapshot({ snapshot, write, goalFile, planFile });
    } catch (restoreError) {
      error.restoreError = restoreError;
    }
    throw error;
  }
  return snapshot;
}

/**
 * 新协作的启动事务：全部终端先创建并验收，随后才提交共享文件。
 * 任一步失败都只回滚本轮已经创建的终端，并保留最初的失败原因。
 */
export async function runOrchestraLaunchTransaction({
  brain,
  workers = [],
  participants,
  create,
  isReady,
  commit,
  rollback,
} = {}) {
  if (typeof create !== 'function' || typeof isReady !== 'function') {
    throw new TypeError('create 和 isReady 必须是函数');
  }

  const lead = String(brain || '').trim();
  const workerTools = normalizedParticipants(workers).filter(tool => tool !== lead);
  const tools = normalizedParticipants(
    participants === undefined ? [lead, ...workerTools] : participants,
  );
  const createdIds = [];
  const readyIds = [];
  const sessionIds = {};

  try {
    for (const tool of tools) {
      const id = await create(tool);
      if (!id) continue;
      createdIds.push(id);
      if (await isReady(id, tool)) {
        readyIds.push(id);
        sessionIds[tool] = id;
      }
    }

    if (!lead || !sessionIds[lead]) {
      throw orchestraLaunchError('brain_not_ready', '大脑终端启动失败');
    }
    const readyWorkers = workerTools.filter(tool => sessionIds[tool]);
    if (!readyWorkers.length) {
      throw orchestraLaunchError('workers_not_ready', '干活终端都没有启动成功');
    }

    const result = {
      createdIds: [...createdIds],
      readyIds: [...readyIds],
      failedIds: createdIds.filter(id => !readyIds.includes(id)),
      sessionIds: { ...sessionIds },
      readyWorkers,
    };
    if (typeof commit === 'function') await commit(result);
    return result;
  } catch (caught) {
    const error = normalizedError(caught);
    if (createdIds.length && typeof rollback === 'function') {
      try {
        await rollback([...createdIds], error);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
}
