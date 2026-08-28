import { normalizeProjectMemoryCwd } from './project-memory-utils.js';
import { cliToolName, extractResumedSessionId, isGenericContinueCommand, launchCliCommand } from './session-restore-utils.js';

export const DEFAULT_PROJECT_KIT = Object.freeze(['claude', 'codex', 'grok']);
export const PROJECT_KIT_LAYOUT = 'main';

export function createProjectSessionHistoryLoader(loadHistory) {
  if (typeof loadHistory !== 'function') throw new TypeError('loadHistory must be a function');
  const pending = new Map();
  const revisions = new Map();

  const revisionFor = key => revisions.get(key) || 0;

  function invalidate(cwd) {
    const key = normalizeProjectMemoryCwd(cwd);
    if (!key) return '';
    revisions.set(key, revisionFor(key) + 1);
    return key;
  }

  function load(cwd) {
    const key = normalizeProjectMemoryCwd(cwd);
    if (!key) return Promise.resolve({ groups: [] });
    const revision = revisionFor(key);
    const current = pending.get(key);
    if (current?.revision === revision) return current.promise;

    const entry = { revision, promise: null };
    entry.promise = Promise.resolve()
      .then(() => loadHistory(cwd))
      .then(
        history => (revision === revisionFor(key) ? history : load(cwd)),
        error => {
          if (revision !== revisionFor(key)) return load(cwd);
          throw error;
        },
      )
      .finally(() => {
        // 旧请求失效后可能已有新请求在跑，不能由旧请求的 finally 把它删掉。
        if (pending.get(key) === entry) pending.delete(key);
      });
    pending.set(key, entry);
    return entry.promise;
  }

  return { invalidate, load, pending };
}

export function sameProjectCwd(left, right) {
  const a = normalizeProjectMemoryCwd(left);
  const b = normalizeProjectMemoryCwd(right);
  return Boolean(a && b && a === b);
}

export function isLiveTerminalSession(session) {
  const status = String(session?.status || '');
  return Boolean(session && status && status !== 'exited' && status !== 'failed');
}

/**
 * 会话 ID 是否指同一条。以前 Gemini 用文件路径当 ID、需要按文件名兜底比较，
 * Gemini 已整体移除，剩下各家的 ID 都是直接可比的字符串。
 */
export function sameHistorySessionId(tool, left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  return a === b;
}

export function filterHistoryGroups(groups, query) {
  const source = Array.isArray(groups) ? groups : [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return source.map(group => ({
    ...group,
    sessions: Array.isArray(group?.sessions) ? group.sessions : [],
  })).filter(group => group.sessions.length);
  return source.map(group => ({
    ...group,
    sessions: (Array.isArray(group?.sessions) ? group.sessions : []).filter(session => {
      const haystack = [
        session?.title,
        session?.preview,
        session?.id,
        group?.tool,
        group?.label,
      ].map(value => String(value || '').toLowerCase()).join('\n');
      return haystack.includes(needle);
    }),
  })).filter(group => group.sessions.length);
}

export function historySessionKey(tool, id) {
  return `${String(tool || '').trim()}\0${normalizeProjectMemoryCwd(id) || String(id || '').trim()}`;
}

export function runningHistoryLookup(runningSessions, groups, projectCwd) {
  const lookup = new Map();
  const newestByTool = {};
  for (const group of Array.isArray(groups) ? groups : []) {
    const first = group?.sessions?.[0];
    if (group?.tool && first?.id) newestByTool[group.tool] = first.id;
  }
  for (const running of Array.isArray(runningSessions) ? runningSessions : []) {
    if (!isLiveTerminalSession(running) || !sameProjectCwd(running.cwd, projectCwd)) continue;
    const tool = cliToolName(running.tool);
    if (!tool) continue;
    const resumed = extractResumedSessionId(running.tool);
    let targetId = '';
    if (resumed) {
      const group = (groups || []).find(item => item?.tool === tool);
      const matched = group?.sessions?.find(session => sameHistorySessionId(tool, session.id, resumed));
      targetId = matched?.id || resumed;
    } else if (isGenericContinueCommand(running.tool)) {
      targetId = newestByTool[tool] || '';
    }
    if (!targetId) continue;
    const key = historySessionKey(tool, targetId);
    if (!lookup.has(key)) lookup.set(key, running.id);
  }
  return lookup;
}

export function runningTerminalIdForHistory(lookup, tool, id) {
  if (!lookup || typeof lookup.get !== 'function') return '';
  return lookup.get(historySessionKey(tool, id)) || '';
}

export function findRunningProjectTool(runningSessions, projectCwd, tool) {
  const name = String(tool || '').trim();
  if (!name) return null;
  for (const running of Array.isArray(runningSessions) ? runningSessions : []) {
    if (!isLiveTerminalSession(running) || !sameProjectCwd(running.cwd, projectCwd)) continue;
    if (cliToolName(running.tool) === name) return running;
  }
  return null;
}

export function latestHistorySession(groups, tool) {
  const name = String(tool || '').trim();
  if (!name) return null;
  const group = (Array.isArray(groups) ? groups : []).find(item => item?.tool === name);
  const session = group?.sessions?.[0];
  return session?.id ? session : null;
}

export function launchCommandForProjectTool(tool, historyGroups) {
  const last = latestHistorySession(historyGroups, tool);
  return {
    last,
    autoCmd: launchCliCommand(tool, last?.id),
  };
}

export function projectKitSessionIds(runningSessions, projectCwd, createdByTool = {}, kit = DEFAULT_PROJECT_KIT) {
  return kit.map(tool => {
    const created = createdByTool?.[tool];
    if (created) return created;
    return findRunningProjectTool(runningSessions, projectCwd, tool)?.id || '';
  }).filter(Boolean);
}
