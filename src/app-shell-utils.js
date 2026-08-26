export const APP_VIEW_STORAGE_KEY = 'roster-app-view-v1';
export const APP_VIEWS = Object.freeze(['conversation', 'developer']);

export function normalizeAppView(value) {
  return value === 'developer' ? 'developer' : 'conversation';
}

export function normalizeConversationProvider(value) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_-]{0,31}$/.test(provider) ? provider : 'codex';
}

function defaultPreference() {
  return { version: 1, appView: 'conversation', projectId: '', providerId: 'codex' };
}

export function readAppShellPreference(storage) {
  try {
    const raw = storage?.getItem(APP_VIEW_STORAGE_KEY);
    if (!raw) return defaultPreference();
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || typeof value !== 'object') {
      return defaultPreference();
    }
    return {
      version: 1,
      appView: normalizeAppView(value.appView),
      projectId: typeof value.projectId === 'string' ? value.projectId : '',
      providerId: normalizeConversationProvider(value.providerId),
    };
  } catch (_) {
    return defaultPreference();
  }
}

export function writeAppShellPreference(storage, preference) {
  const value = {
    version: 1,
    appView: normalizeAppView(preference?.appView),
    projectId: typeof preference?.projectId === 'string' ? preference.projectId : '',
    providerId: normalizeConversationProvider(preference?.providerId),
  };
  try {
    storage?.setItem(APP_VIEW_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

function runnableProject(project) {
  return !!project
    && typeof project.id === 'string'
    && project.id.length > 0
    && typeof project.localPath === 'string'
    && project.localPath.trim().length > 0;
}

export function selectConversationProject(projects, requestedId = '') {
  const runnable = Array.isArray(projects) ? projects.filter(runnableProject) : [];
  return runnable.find(project => project.id === requestedId) || runnable[0] || null;
}

export function isDeveloperTerminalVisible(appView, dockActive) {
  return normalizeAppView(appView) === 'developer' && !!dockActive;
}
