export const TERMINAL_PANE_LAYOUTS = Object.freeze({
  single: 1,
  columns: 2,
  rows: 2,
  main: 3,
  grid: 4,
});

export function normalizeTerminalPaneLayout(layout) {
  return Object.hasOwn(TERMINAL_PANE_LAYOUTS, layout) ? layout : 'single';
}

export function terminalPaneCapacity(layout) {
  return TERMINAL_PANE_LAYOUTS[normalizeTerminalPaneLayout(layout)];
}

export function terminalPaneArrangement(layout, visibleCount = 0) {
  const normalized = normalizeTerminalPaneLayout(layout);
  const count = Math.max(0, Math.min(Number(visibleCount) || 0, terminalPaneCapacity(normalized)));
  if (count <= 1) return 'single';
  if (normalized === 'rows') return 'rows';
  if (normalized === 'columns') return 'columns';
  if (normalized === 'main') return count === 2 ? 'columns' : 'main';
  if (count === 2) return 'columns';
  if (count === 3) return 'main';
  return 'grid';
}

function emptyAssignments(capacity) {
  return Array.from({ length: capacity }, () => null);
}

export function reconcileTerminalPanes({
  assignments = [],
  sessionIds = [],
  activeSessionId = null,
  layout = 'single',
  fill = true,
} = {}) {
  const capacity = terminalPaneCapacity(layout);
  const available = new Set(sessionIds.filter(Boolean));
  const result = emptyAssignments(capacity);
  const used = new Set();

  for (let i = 0; i < Math.min(assignments.length, capacity); i++) {
    const id = assignments[i];
    if (!id || !available.has(id) || used.has(id)) continue;
    result[i] = id;
    used.add(id);
  }

  if (activeSessionId && available.has(activeSessionId) && !used.has(activeSessionId)) {
    const emptyIndex = result.indexOf(null);
    const targetIndex = emptyIndex >= 0 ? emptyIndex : 0;
    if (result[targetIndex]) used.delete(result[targetIndex]);
    result[targetIndex] = activeSessionId;
    used.add(activeSessionId);
  }

  if (fill) {
    for (const id of sessionIds) {
      if (!id || used.has(id)) continue;
      const emptyIndex = result.indexOf(null);
      if (emptyIndex < 0) break;
      result[emptyIndex] = id;
      used.add(id);
    }
  }

  return result;
}

export function assignSessionToTerminalPane(assignments, sessionId, focusedSessionId, layout) {
  const capacity = terminalPaneCapacity(layout);
  const result = emptyAssignments(capacity);
  for (let i = 0; i < Math.min(assignments.length, capacity); i++) {
    result[i] = assignments[i] || null;
  }
  const existingIndex = result.indexOf(sessionId);
  if (existingIndex >= 0) return result;

  const emptyIndex = result.indexOf(null);
  const focusedIndex = result.indexOf(focusedSessionId);
  const targetIndex = emptyIndex >= 0 ? emptyIndex : (focusedIndex >= 0 ? focusedIndex : 0);
  result[targetIndex] = sessionId;
  return result;
}

export function removeSessionFromTerminalPanes(assignments, sessionId, layout) {
  const capacity = terminalPaneCapacity(layout);
  const result = emptyAssignments(capacity);
  for (let i = 0; i < Math.min(assignments.length, capacity); i++) {
    result[i] = assignments[i] === sessionId ? null : (assignments[i] || null);
  }
  return result;
}

export function visibleTerminalSessionIds(assignments) {
  return assignments.filter(Boolean);
}

export function selectTerminalPaneSession({
  assignments = [],
  activeSessionId = null,
  layout = 'single',
} = {}, sessionId) {
  if (!sessionId) return { assignments: [...assignments], activeSessionId };
  return {
    assignments: assignSessionToTerminalPane(assignments, sessionId, activeSessionId, layout),
    activeSessionId: sessionId,
  };
}

export function removeTerminalPaneSession({
  assignments = [],
  activeSessionId = null,
  layout = 'single',
} = {}, sessionId) {
  const nextAssignments = removeSessionFromTerminalPanes(assignments, sessionId, layout);
  return {
    assignments: nextAssignments,
    activeSessionId: activeSessionId === sessionId
      ? (visibleTerminalSessionIds(nextAssignments)[0] || null)
      : activeSessionId,
  };
}

export function closeTerminalPaneSession({
  assignments = [],
  activeSessionId = null,
  layout = 'single',
  remainingSessionIds = [],
} = {}, sessionId) {
  const removed = removeTerminalPaneSession({ assignments, activeSessionId, layout }, sessionId);
  const remaining = new Set(remainingSessionIds.filter(Boolean));
  const nextActiveSessionId = remaining.has(removed.activeSessionId)
    ? removed.activeSessionId
    : null;
  const nextAssignments = reconcileTerminalPanes({
    assignments: removed.assignments,
    sessionIds: remainingSessionIds,
    activeSessionId: nextActiveSessionId,
    layout,
    fill: true,
  });
  return {
    assignments: nextAssignments,
    activeSessionId: nextActiveSessionId || visibleTerminalSessionIds(nextAssignments)[0] || null,
  };
}

export function terminalSessionIdAtPoint(panes, x, y) {
  for (const pane of panes || []) {
    if (!pane?.id) continue;
    if (x >= pane.left && x <= pane.right && y >= pane.top && y <= pane.bottom) {
      return pane.id;
    }
  }
  return null;
}
