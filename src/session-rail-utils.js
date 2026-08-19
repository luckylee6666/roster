import { CLI_TOOL_IDS, isKnownCliTool } from './cli-tools.js';
import { normalizeProjectMemoryCwd } from './project-memory-utils.js';
import { cliToolName } from './session-restore-utils.js';
import {
  isLiveTerminalSession,
  runningHistoryLookup,
  runningTerminalIdForHistory,
  sameProjectCwd,
} from './project-history-utils.js';

export const SESSION_RAIL_HISTORY_LIMIT = 8;
export const SESSION_RAIL_DEFAULT_HEIGHT = 168;
export const SESSION_RAIL_MIN_HEIGHT = 96;
export const SESSION_RAIL_MAX_HEIGHT = 320;
export const SESSION_RAIL_MIN_TREE_BODY = 72;
export const SESSION_RAIL_HEIGHT_KEY = 'term-session-rail-height';
export const SESSION_RAIL_HIDDEN_KEY = 'term-session-rail-hidden';

export const RAIL_CLI_TOOLS = CLI_TOOL_IDS;

export function isRailCliTool(commandOrName) {
  return isKnownCliTool(commandOrName);
}

export function sessionRailHiddenFromStorage(raw) {
  return raw === '1' || raw === true;
}

export function sessionRailViewLoading(cwd, history, pendingKeys) {
  const key = normalizeProjectMemoryCwd(cwd);
  return Boolean(key && !history && pendingKeys && typeof pendingKeys.has === 'function' && pendingKeys.has(key));
}

export function clampSessionRailHeight(height, treeHeight = 0) {
  const parsed = typeof height === 'number' ? height : parseInt(height, 10);
  const fallback = SESSION_RAIL_DEFAULT_HEIGHT;
  const value = Number.isFinite(parsed) ? parsed : fallback;
  const treeCap = Number(treeHeight) >= SESSION_RAIL_MIN_TREE_BODY + SESSION_RAIL_MIN_HEIGHT
    ? Number(treeHeight) - SESSION_RAIL_MIN_TREE_BODY
    : SESSION_RAIL_MAX_HEIGHT;
  return Math.min(SESSION_RAIL_MAX_HEIGHT, treeCap, Math.max(SESSION_RAIL_MIN_HEIGHT, Math.round(value)));
}

export function formatRailRelativeTime(atMs, nowMs = Date.now()) {
  const ts = Number(atMs);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return '';
  const minutes = Math.floor((now - ts) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function railLiveTitle(session) {
  const tool = cliToolName(session?.tool);
  const name = String(session?.name || '').trim();
  if (!name || name === tool) return tool || '会话';
  const prefix = tool ? `${tool} · ` : '';
  if (prefix && name.startsWith(prefix)) return name.slice(prefix.length).trim() || tool;
  return name;
}

export function sessionRailAction(item) {
  if (!item || typeof item !== 'object') return { type: 'none' };
  if (item.terminalId) return { type: 'focus', terminalId: item.terminalId };
  if (item.tool && item.sessionId) {
    return {
      type: 'resume',
      tool: item.tool,
      sessionId: item.sessionId,
      title: item.title || '',
    };
  }
  return { type: 'none' };
}

export function buildSessionRailModel({
  cwd,
  runningSessions = [],
  historyGroups = [],
  historyLimit = SESSION_RAIL_HISTORY_LIMIT,
} = {}) {
  const projectCwd = normalizeProjectMemoryCwd(cwd);
  if (!projectCwd) return { cwd: '', live: [], history: [] };

  const liveSessions = (Array.isArray(runningSessions) ? runningSessions : []).filter(session => (
    isLiveTerminalSession(session)
    && sameProjectCwd(session.cwd, projectCwd)
    && isRailCliTool(session.tool)
  ));
  const lookup = runningHistoryLookup(liveSessions, historyGroups, projectCwd);
  const live = liveSessions.map(session => ({
    key: `live:${session.id}`,
    kind: 'live',
    tool: cliToolName(session.tool),
    title: railLiveTitle(session),
    terminalId: session.id,
    sessionId: '',
    running: true,
    atMs: Number(session.startedAt) || 0,
  }));

  const historyItems = [];
  for (const group of Array.isArray(historyGroups) ? historyGroups : []) {
    const tool = String(group?.tool || '').trim();
    if (!isRailCliTool(tool)) continue;
    for (const session of Array.isArray(group?.sessions) ? group.sessions : []) {
      if (!session?.id) continue;
      if (runningTerminalIdForHistory(lookup, tool, session.id)) continue;
      historyItems.push({
        key: `history:${tool}:${session.id}`,
        kind: 'history',
        tool,
        title: String(session.title || '').trim() || '未命名会话',
        terminalId: '',
        sessionId: session.id,
        running: false,
        atMs: Number(session.atMs) || 0,
      });
    }
  }
  historyItems.sort((left, right) => (right.atMs || 0) - (left.atMs || 0));
  const limit = Number.isFinite(historyLimit) && historyLimit > 0
    ? Math.floor(historyLimit)
    : SESSION_RAIL_HISTORY_LIMIT;
  return { cwd: projectCwd, live, history: historyItems.slice(0, limit) };
}
