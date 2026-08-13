import { normalizeProjectMemoryCwd } from './project-memory-utils.js';
import { cliToolName, extractResumedSessionId, isGenericContinueCommand } from './session-restore-utils.js';

export const DEFAULT_PROJECT_KIT = Object.freeze(['claude', 'codex', 'grok']);
export const PROJECT_KIT_LAYOUT = 'main';

export function sameProjectCwd(left, right) {
  const a = normalizeProjectMemoryCwd(left);
  const b = normalizeProjectMemoryCwd(right);
  return Boolean(a && b && a === b);
}

export function isLiveTerminalSession(session) {
  const status = String(session?.status || '');
  return Boolean(session && status && status !== 'exited' && status !== 'failed');
}

export function sameHistorySessionId(tool, left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  if (tool !== 'gemini') return false;
  const na = normalizeProjectMemoryCwd(a);
  const nb = normalizeProjectMemoryCwd(b);
  if (na === nb) return true;
  const fileA = na.split(/[\\/]/).pop();
  const fileB = nb.split(/[\\/]/).pop();
  return Boolean(fileA && fileA === fileB && fileA.startsWith('session-'));
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

export function projectKitSessionIds(runningSessions, projectCwd, createdByTool = {}, kit = DEFAULT_PROJECT_KIT) {
  return kit.map(tool => {
    const created = createdByTool?.[tool];
    if (created) return created;
    return findRunningProjectTool(runningSessions, projectCwd, tool)?.id || '';
  }).filter(Boolean);
}
