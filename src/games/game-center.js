import create2048Game from './game-2048.js';
import createTetrisGame from './game-tetris.js';
import { normalizeGameId } from './game-ids.js';

export function createDefaultGameCatalog() {
  return [
    { id: 'tetris', name: '俄罗斯方块', hint: '方向键移动 · 空格硬降', factory: createTetrisGame },
    { id: '2048', name: '2048', hint: '方向键 / 滑动', factory: create2048Game },
  ];
}

export function createGameCenter({ documentRef = document, catalog = createDefaultGameCatalog(), onError = () => {} } = {}) {
  const games = new Map();
  const orderedEntries = Array.isArray(catalog) ? catalog : [];
  const entries = new Map(orderedEntries.map(entry => [entry.id, entry]));
  let root = null;
  let activeId = null;
  let running = false;

  function reportError(id, error) {
    try { onError(id, error); } catch (_) { /* Error reporting must not break game cleanup. */ }
  }
  function callLifecycle(id, game, method, ...args) {
    if (!game || typeof game[method] !== 'function') return { ok: true, value: undefined };
    try {
      return { ok: true, value: game[method](...args) };
    } catch (error) {
      reportError(id, error);
      return { ok: false, error };
    }
  }
  function idFor(value) {
    if (entries.has(value)) return value;
    const normalized = normalizeGameId(value);
    if (entries.has(normalized)) return normalized;
    return orderedEntries[0]?.id ?? null;
  }
  function setVisible(record, visible) { record.host.dataset.active = visible ? 'true' : 'false'; }
  function markRecordFailed(record, error) {
    try { record.host.replaceChildren(); } catch (_) { /* Keep the host available for the error message. */ }
    record.host.setAttribute('role', 'alert');
    record.host.textContent = `游戏加载失败：${error?.message || String(error)}`;
  }
  function failRecord(id, record, error) {
    const failedGame = record.game;
    record.game = null;
    if (failedGame) callLifecycle(id, failedGame, 'destroy');
    markRecordFailed(record, error);
  }
  function removeHost(record) {
    try { record.host.replaceChildren(); } catch (_) { /* Continue evicting the game record. */ }
    try { record.host.remove?.(); } catch (_) { /* A detached host is safe to abandon. */ }
  }
  function destroyRecord(id, record) {
    callLifecycle(id, record.game, 'destroy');
    games.delete(id);
    if (activeId === id) activeId = null;
    removeHost(record);
  }
  function pauseRecord(id, record) {
    const result = callLifecycle(id, record.game, 'pause');
    if (!result.ok) destroyRecord(id, record);
    return result.ok;
  }
  function create(id) {
    if (games.has(id)) return games.get(id);
    const entry = entries.get(id);
    if (!entry) return null;
    const host = documentRef.createElement('div');
    host.className = 'companion-game-host';
    host.dataset.gameId = id;
    setVisible({ host }, false);
    root?.append(host);
    const record = { host, game: null };
    try {
      record.game = entry.factory();
    } catch (error) {
      reportError(id, error);
      markRecordFailed(record, error);
    }
    if (record.game) {
      const mounted = callLifecycle(id, record.game, 'mount', host);
      if (!mounted.ok) failRecord(id, record, mounted.error);
    }
    games.set(id, record);
    return record;
  }

  function mount(target) {
    if (root || games.size) cleanup();
    root = target;
    root.replaceChildren();
    return api;
  }
  function select(value) {
    const id = idFor(value);
    if (id === null) {
      activeId = null;
      return null;
    }
    const previous = activeId && games.get(activeId);
    if (previous && activeId === id) {
      setVisible(previous, true);
      return id;
    }
    if (previous && activeId !== id) {
      const previousId = activeId;
      if (pauseRecord(previousId, previous)) setVisible(previous, false);
    }
    const next = create(id);
    if (!next) return null;
    activeId = id;
    setVisible(next, true);
    if (running) {
      const resumed = callLifecycle(id, next.game, 'resume');
      if (!resumed.ok) failRecord(id, next, resumed.error);
    }
    return id;
  }
  function pause() {
    running = false;
    Array.from(games).forEach(([id, record]) => pauseRecord(id, record));
  }
  function resume() {
    if (running) return;
    running = true;
    if (activeId) {
      const record = games.get(activeId);
      const resumed = callLifecycle(activeId, record?.game, 'resume');
      if (record && !resumed.ok) failRecord(activeId, record, resumed.error);
    }
  }
  function cleanup() {
    running = false;
    Array.from(games).forEach(([id, record]) => pauseRecord(id, record));
    Array.from(games).forEach(([id, record]) => destroyRecord(id, record));
    games.clear();
    root?.replaceChildren();
    root = null;
    activeId = null;
  }
  function destroy() { cleanup(); }
  function getGameState() { return activeId ? games.get(activeId)?.game?.getState?.() ?? null : null; }
  function getActiveHost() { return activeId ? games.get(activeId)?.host ?? null : null; }

  const api = { mount, select, pause, resume, destroy, getActiveId: () => activeId, getGameState, getActiveHost };
  return api;
}
