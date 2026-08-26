import {
  normalizeAppView,
  readAppShellPreference,
  writeAppShellPreference,
} from './app-shell-utils.js';

function setSurfaceVisible(surface, visible) {
  if (!surface) return;
  surface.hidden = !visible;
  surface.inert = !visible;
  surface.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

export function installAppShell({
  document,
  storage,
  initialView,
  beforeConversation,
  beforeDeveloper,
  onViewChange,
  notify,
}) {
  const conversation = document.getElementById('conversation-surface');
  const developer = document.getElementById('development-surface');
  const developerOverlays = document.getElementById('development-overlays');
  const preference = readAppShellPreference(storage);
  let view = normalizeAppView(initialView || preference.appView);
  let changeTail = Promise.resolve();

  const sync = () => {
    const inConversation = view === 'conversation';
    document.documentElement.dataset.appView = view;
    setSurfaceVisible(conversation, inConversation);
    setSurfaceVisible(developer, !inConversation);
    setSurfaceVisible(developerOverlays, !inConversation);
    document.querySelectorAll('[data-app-view-target]').forEach(button => {
      const active = button.dataset.appViewTarget === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };

  const applyView = async (next, { focus = true, persist = true } = {}) => {
    if (next === view) return true;
    try {
      const allowed = next === 'conversation'
        ? await beforeConversation?.()
        : await beforeDeveloper?.();
      if (allowed === false) {
        notify?.('无法切换工作台，请稍后重试', 'error');
        return false;
      }
      view = next;
      sync();
      if (persist) {
        const current = readAppShellPreference(storage);
        writeAppShellPreference(storage, { ...current, appView: view });
      }
      onViewChange?.(view);
      if (focus) {
        requestAnimationFrame(() => {
          const target = view === 'conversation'
            ? conversation?.querySelector('[data-app-view-focus]')
            : developer?.querySelector('[data-app-view-focus]');
          target?.focus?.();
        });
      }
      return true;
    } catch (error) {
      notify?.(`无法切换工作台：${error?.message || error}`, 'error');
      return false;
    }
  };

  const setView = (next, options = {}) => {
    next = normalizeAppView(next);
    const task = changeTail
      .catch(() => false)
      .then(() => applyView(next, options));
    changeTail = task;
    return task;
  };

  document.querySelectorAll('[data-app-view-target]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      void setView(button.dataset.appViewTarget);
    });
  });
  sync();

  return {
    get view() { return view; },
    setView,
    sync,
  };
}
