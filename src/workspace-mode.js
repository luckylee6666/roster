import { CompanionWebview } from './companion-webview.js';
import { createDefaultGameCatalog, createGameCenter } from './games/game-center.js';
import { GAME_IDS } from './games/game-ids.js';
import {
  WORKSPACE_MODES,
  clampCompanionWidth,
  createCompanionSiteId,
  loadWorkspaceModeSettings,
  normalizeCompanionSite,
  normalizeWorkspaceMode,
  saveWorkspaceModeSettings,
} from './workspace-mode-utils.js';

const MODE_PRESENTATION = Object.freeze({
  [WORKSPACE_MODES.NORMAL]: { short: '普通', title: '普通模式' },
  [WORKSPACE_MODES.RELAX]: { short: '轻松', title: '轻松模式' },
  [WORKSPACE_MODES.ENTERTAINMENT]: { short: '娱乐', title: '娱乐模式' },
});
const WORKSPACE_GAME_IDS = new Set(GAME_IDS);

function nextFrame(windowRef) {
  return new Promise(resolve => windowRef.requestAnimationFrame(() => resolve()));
}

function requireElement(documentRef, id) {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`工作区模式缺少界面元素 #${id}`);
  return element;
}

function errorMessage(error) {
  if (!error) return '未知错误';
  return error.message || String(error);
}

function urlWithDefaultScheme(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Install the shared right-side workspace used by Relax and Entertainment.
 * The controller owns presentation state only; terminal/PTTY sessions remain
 * under main.js and are never recreated when a mode changes.
 */
export function installWorkspaceMode({
  documentRef = document,
  windowRef = window,
  dock,
  terminalMain,
  onExpandedChange = () => {},
  onLayoutChange = () => {},
  onFocusTerminal = () => {},
  openExternal = async () => {},
  notify = () => {},
  onModeChange = () => {},
  initialAppVisible = true,
  WebviewClass = CompanionWebview,
  gameCatalog = createDefaultGameCatalog(),
  gameCenterFactory = createGameCenter,
} = {}) {
  if (!dock || !terminalMain) throw new Error('工作区模式需要终端 dock 和 terminal-main');
  const seenGameIds = new Set();
  const workspaceGameCatalog = (Array.isArray(gameCatalog) ? gameCatalog : []).filter(game => {
    if (!WORKSPACE_GAME_IDS.has(game?.id) || seenGameIds.has(game.id)) return false;
    seenGameIds.add(game.id);
    return true;
  });

  const ui = {
    modeButton: requireElement(documentRef, 'workspace-mode-btn'),
    modeLabel: requireElement(documentRef, 'workspace-mode-label'),
    modeMenu: requireElement(documentRef, 'workspace-mode-menu'),
    modeOptions: Array.from(documentRef.querySelectorAll('.workspace-mode-option')),
    splitter: requireElement(documentRef, 'companion-splitter'),
    panel: requireElement(documentRef, 'companion-panel'),
    siteSelect: requireElement(documentRef, 'companion-site-select'),
    addSite: requireElement(documentRef, 'companion-add-site'),
    removeSite: requireElement(documentRef, 'companion-remove-site'),
    refresh: requireElement(documentRef, 'companion-refresh'),
    openBrowser: requireElement(documentRef, 'companion-open-browser'),
    returnTerminal: requireElement(documentRef, 'companion-return-terminal'),
    close: requireElement(documentRef, 'companion-close'),
    webSlot: requireElement(documentRef, 'companion-webview-slot'),
    webPlaceholder: requireElement(documentRef, 'companion-web-placeholder'),
    webStatus: requireElement(documentRef, 'companion-web-status'),
    emptyAddSite: requireElement(documentRef, 'companion-empty-add-site'),
    gameSurface: requireElement(documentRef, 'companion-game-surface'),
    gameSelect: requireElement(documentRef, 'companion-game-select'),
    gameHint: requireElement(documentRef, 'companion-game-hint'),
    siteModal: requireElement(documentRef, 'companion-site-modal'),
    siteModalClose: requireElement(documentRef, 'companion-site-modal-close'),
    siteCancel: requireElement(documentRef, 'companion-site-cancel'),
    siteForm: requireElement(documentRef, 'companion-site-form'),
    siteName: requireElement(documentRef, 'companion-site-name'),
    siteUrl: requireElement(documentRef, 'companion-site-url'),
    siteSubmit: requireElement(documentRef, 'companion-site-submit'),
  };

  let settings = loadWorkspaceModeSettings(windowRef.localStorage);
  let mode = normalizeWorkspaceMode(settings.mode);
  let dockOpen = dock.classList.contains('active');
  let overlayOpen = false;
  let resizing = false;
  let destroyed = false;
  let appVisible = Boolean(initialAppVisible);
  let appVisibilityRevision = 0;
  let appVisibilityPending = null;
  let nativeWindowFocused = true;
  let syncFrame = 0;
  let pendingBounds = null;
  let boundsSyncRunning = false;
  let modeMenuOpening = false;
  let modeMenuRevision = 0;
  let siteModalRevision = 0;
  let siteModalTrigger = null;
  let overlayRevision = 0;
  let webRevision = 0;
  let webQueue = Promise.resolve();
  const gameCenter = gameCenterFactory({ documentRef, catalog: workspaceGameCatalog, onError: (id, error) => notify(`无法加载 ${id}：${errorMessage(error)}`, 'error') });
  let cancelSplitterInteraction = () => {};
  gameCenter.mount(ui.gameSurface);
  const webview = new WebviewClass({ globalObject: windowRef });
  const disposers = [];
  const overlayNodes = new Set();
  const controlledOverlayReasons = new Set();
  const floatingUiReasons = new Set();
  let overlayHidePromise = Promise.resolve(true);

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  }

  function selectedSite() {
    return settings.sites.find(site => site.id === settings.activeSiteId) || settings.sites[0] || null;
  }

  function persist() {
    const result = saveWorkspaceModeSettings({ ...settings, mode }, windowRef.localStorage);
    settings = result.settings;
    settings.activeGameId = normalizedWorkspaceGameId(settings.activeGameId);
    if (!result.saved) notify('模式设置未能保存到本地', 'error');
  }

  function normalizedWorkspaceGameId(value) {
    return workspaceGameCatalog.some(game => game.id === value)
      ? value
      : workspaceGameCatalog[0]?.id ?? null;
  }

  function renderMode() {
    const presentation = MODE_PRESENTATION[mode];
    dock.dataset.workspaceMode = mode;
    dock.classList.toggle('has-companion', mode !== WORKSPACE_MODES.NORMAL);
    ui.modeLabel.textContent = presentation.short;
    ui.modeButton.title = `工作区模式：${presentation.title}`;
    ui.modeOptions.forEach(option => {
      const active = option.dataset.mode === mode;
      option.classList.toggle('active', active);
      option.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  function renderSites() {
    ui.siteSelect.replaceChildren();
    settings.sites.forEach(site => {
      const option = documentRef.createElement('option');
      option.value = site.id;
      option.textContent = site.name;
      option.title = site.url;
      ui.siteSelect.append(option);
    });
    const site = selectedSite();
    ui.siteSelect.value = site?.id ?? '';
    settings.activeSiteId = site?.id ?? null;
    ui.siteSelect.disabled = !site;
    ui.removeSite.disabled = !site;
    ui.refresh.disabled = !site;
    ui.openBrowser.disabled = !site;
    ui.webPlaceholder.classList.toggle('web-empty', !site);
    if (!site) setWebStatus('还没有网页', 'empty');
  }

  function renderGames() {
    ui.gameSelect.replaceChildren();
    workspaceGameCatalog.forEach(game => {
      const option = documentRef.createElement('option');
      option.value = game.id;
      option.textContent = game.name;
      ui.gameSelect.append(option);
    });
    settings.activeGameId = normalizedWorkspaceGameId(settings.activeGameId);
    ui.gameSelect.value = settings.activeGameId ?? '';
    ui.gameSelect.disabled = settings.activeGameId === null;
    ui.gameHint.textContent = workspaceGameCatalog.find(game => game.id === settings.activeGameId)?.hint || '';
  }

  function setWebStatus(message, state = 'loading') {
    ui.webStatus.textContent = message;
    ui.webPlaceholder.classList.toggle('web-error', state === 'error');
    ui.webPlaceholder.classList.toggle('web-ready', state === 'ready');
  }

  function slotBounds() {
    const rect = ui.webSlot.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  function shouldShowWebview() {
    return !destroyed
      && appVisible
      && mode === WORKSPACE_MODES.RELAX
      && dockOpen
      && !overlayOpen
      && !resizing
      && floatingUiReasons.size === 0
      && nativeWindowFocused
      && !documentRef.hidden;
  }

  function queueWebTask(task) {
    webQueue = webQueue.catch(() => {}).then(task);
    return webQueue;
  }

  function closeWebview() {
    webRevision += 1;
    return queueWebTask(async () => {
      if (!webview.created) return true;
      try {
        await webview.close();
        return true;
      } catch (error) {
        // CompanionWebview deliberately retains its handle when native close
        // fails. Hide that retained instance so it cannot cover normal/game UI,
        // then let a later mode switch reuse it or retry closing it.
        try { await webview.hide(); } catch (_) {}
        if (!destroyed) {
          setWebStatus(`网页区域关闭失败：${errorMessage(error)}`, 'error');
        }
        return false;
      }
    });
  }

  function hideWebviewAfterLifecycleChange() {
    if (!webview.created) return Promise.resolve(true);
    return queueWebTask(() => webview.hide())
      .then(() => true)
      .catch(error => {
        if (!destroyed) {
          setWebStatus(`网页区域暂时无法隐藏：${errorMessage(error)}`, 'error');
        }
        return false;
      });
  }

  function flushLatestBounds() {
    if (boundsSyncRunning || !pendingBounds || destroyed || !appVisible) return;
    const bounds = pendingBounds;
    pendingBounds = null;
    boundsSyncRunning = true;
    void queueWebTask(async () => {
      if (!webview.created || !appVisible || mode !== WORKSPACE_MODES.RELAX || !dockOpen) return;
      try {
        await webview.setPosition({ x: bounds.x, y: bounds.y });
        await webview.setSize({ width: bounds.width, height: bounds.height });
        if (shouldShowWebview()) await webview.show();
        else await webview.hide();
      } catch (error) {
        setWebStatus(`网页区域调整失败：${errorMessage(error)}`, 'error');
      }
    }).finally(() => {
      boundsSyncRunning = false;
      if (pendingBounds) flushLatestBounds();
    });
  }

  function scheduleBoundsSync() {
    if (syncFrame || destroyed || !appVisible || resizing) return;
    syncFrame = windowRef.requestAnimationFrame(() => {
      syncFrame = 0;
      if (!webview.created || !appVisible || mode !== WORKSPACE_MODES.RELAX || !dockOpen) return;
      // Keep only the latest geometry while native IPC is still in flight. This
      // prevents resize drags from building a stale setPosition/setSize backlog.
      pendingBounds = slotBounds();
      flushLatestBounds();
    });
  }

  async function openActiveSite({ force = false } = {}) {
    const site = selectedSite();
    if (!site) {
      setWebStatus('还没有网页', 'empty');
      return closeWebview();
    }
    if (mode !== WORKSPACE_MODES.RELAX
      || !appVisible
      || !dockOpen
      || overlayOpen
      || floatingUiReasons.size > 0
      || destroyed) return;
    const revision = ++webRevision;
    setWebStatus(`正在打开 ${site.name}…`, 'loading');
    await nextFrame(windowRef);
    const bounds = slotBounds();

    return queueWebTask(async () => {
      // The task may have waited behind native IPC. Re-check every state that
      // can open DOM above the child WebView before creating or moving it.
      if (revision !== webRevision
        || !appVisible
        || mode !== WORKSPACE_MODES.RELAX
        || !dockOpen
        || overlayOpen
        || floatingUiReasons.size > 0
        || destroyed) return;
      if (!webview.available) {
        setWebStatus('当前环境不支持内嵌网页，请在系统浏览器中打开', 'error');
        return;
      }
      try {
        if (force || !webview.created || webview.url !== site.url) {
          await webview.create(site.url, bounds);
        } else {
          await webview.setPosition({ x: bounds.x, y: bounds.y });
          await webview.setSize({ width: bounds.width, height: bounds.height });
        }
        if (revision !== webRevision || !shouldShowWebview()) {
          if (webview.created) await webview.hide();
          return;
        }
        await webview.show();
        setWebStatus(site.name, 'ready');
      } catch (error) {
        setWebStatus(`网页加载失败：${errorMessage(error)}`, 'error');
        notify(`无法打开 ${site.name}`, 'error');
      }
    });
  }

  function ensureGame() {
    if (!appVisible) {
      gameCenter.pause();
      return;
    }
    gameCenter.select(settings.activeGameId);
    if (mode === WORKSPACE_MODES.ENTERTAINMENT
      && dockOpen
      && !overlayOpen
      && floatingUiReasons.size === 0
      && nativeWindowFocused
      && !documentRef.hidden) gameCenter.resume();
    else gameCenter.pause();
  }

  async function setFloatingUiOpen(reason, open, { restore = true } = {}) {
    const key = String(reason || 'floating-ui');
    if (open) {
      floatingUiReasons.add(key);
      gameCenter.pause();
      if (webview.created) {
        try {
          await queueWebTask(() => webview.hide());
        } catch (error) {
          // Closing would discard playback and scroll state. Keep the child
          // WebView alive and report the failure to the caller instead.
          setWebStatus(`网页区域暂时无法隐藏：${errorMessage(error)}`, 'error');
          floatingUiReasons.delete(key);
          return false;
        }
      }
      return true;
    }

    floatingUiReasons.delete(key);
    if (!restore
      || floatingUiReasons.size > 0
      || destroyed
      || !appVisible
      || overlayOpen
      || !dockOpen) return true;
    if (mode === WORKSPACE_MODES.RELAX) {
      if (webview.created) scheduleBoundsSync();
      else void openActiveSite();
    } else if (mode === WORKSPACE_MODES.ENTERTAINMENT) {
      ensureGame();
    }
    return true;
  }

  function closeModeMenu({ restore = true } = {}) {
    const wasOpen = modeMenuOpening
      || ui.modeMenu.classList.contains('active')
      || floatingUiReasons.has('workspace-mode-menu');
    modeMenuRevision += 1;
    modeMenuOpening = false;
    ui.modeMenu.classList.remove('active');
    ui.modeButton.setAttribute('aria-expanded', 'false');
    if (wasOpen) void setFloatingUiOpen('workspace-mode-menu', false, { restore });
  }

  async function openModeMenu() {
    if (!appVisible) return;
    const revision = ++modeMenuRevision;
    modeMenuOpening = true;
    const hidden = await setFloatingUiOpen('workspace-mode-menu', true);
    if (!hidden) {
      modeMenuOpening = false;
      return;
    }
    if (destroyed || revision !== modeMenuRevision) return;
    modeMenuOpening = false;
    ui.modeMenu.classList.add('active');
    ui.modeButton.setAttribute('aria-expanded', 'true');
  }

  function toggleModeMenu() {
    if (modeMenuOpening || ui.modeMenu.classList.contains('active')) closeModeMenu();
    else void openModeMenu();
  }

  async function applyMode(nextMode, { persist: shouldPersist = true } = {}) {
    const normalized = normalizeWorkspaceMode(nextMode);
    const previous = mode;
    mode = normalized;
    settings.mode = mode;
    cancelSplitterInteraction();
    closeModeMenu({ restore: false });
    if (mode !== WORKSPACE_MODES.RELAX) closeSiteModal({ restoreFocus: false });
    renderMode();
    if (shouldPersist) persist();

    if (mode === WORKSPACE_MODES.NORMAL) {
      gameCenter.pause();
      void closeWebview();
      if (appVisible) onExpandedChange(false, previous);
    } else {
      if (appVisible) onExpandedChange(true, previous);
      dockOpen = dock.classList.contains('active');
      if (mode === WORKSPACE_MODES.RELAX) {
        gameCenter.pause();
        void openActiveSite();
      } else {
        void closeWebview();
        ensureGame();
      }
    }

    onModeChange(mode, previous);
    windowRef.requestAnimationFrame(() => {
      onLayoutChange();
      scheduleBoundsSync();
    });
  }

  async function suspendAppPresentation(revision) {
    cancelSplitterInteraction();
    closeModeMenu({ restore: false });
    closeSiteModal({ restoreFocus: false });
    gameCenter.pause();
    if (syncFrame) {
      windowRef.cancelAnimationFrame(syncFrame);
      syncFrame = 0;
    }
    pendingBounds = null;

    try {
      // Queue the final hide even when the handle does not exist yet. A create
      // that was already in flight must settle before application navigation
      // is allowed to reveal another surface above this native child WebView.
      await queueWebTask(async () => {
        if (webview.created) await webview.hide();
      });
    } catch (error) {
      if (revision === appVisibilityRevision && !destroyed && !appVisible) {
        appVisible = true;
        webRevision += 1;
        setWebStatus(`网页区域暂时无法隐藏：${errorMessage(error)}`, 'error');
        if (mode === WORKSPACE_MODES.RELAX && webview.created) scheduleBoundsSync();
        else if (mode === WORKSPACE_MODES.ENTERTAINMENT) ensureGame();
      }
      return false;
    }
    return !destroyed && revision === appVisibilityRevision && !appVisible;
  }

  async function resumeAppPresentation(revision) {
    if (destroyed || revision !== appVisibilityRevision || !appVisible) return false;
    onExpandedChange(mode !== WORKSPACE_MODES.NORMAL, mode);
    dockOpen = dock.classList.contains('active');

    if (mode === WORKSPACE_MODES.RELAX) {
      await openActiveSite();
    } else {
      // A quick resume can overtake the Promise returned by suspend. Wait for
      // its final native hide before resuming a game or completing the switch.
      await webQueue.catch(() => {});
      if (mode === WORKSPACE_MODES.ENTERTAINMENT) ensureGame();
      else gameCenter.pause();
    }
    if (destroyed || revision !== appVisibilityRevision || !appVisible) return false;

    windowRef.requestAnimationFrame(() => {
      if (destroyed || revision !== appVisibilityRevision || !appVisible) return;
      onLayoutChange();
      scheduleBoundsSync();
    });
    return true;
  }

  /**
   * Gate the native companion presentation while the application shows a
   * different top-level surface. This never changes or persists the selected
   * normal/relax/entertainment mode.
   */
  function setAppVisible(visible) {
    const nextVisible = Boolean(visible);
    if (destroyed) return Promise.resolve(false);
    if (appVisibilityPending?.target === nextVisible) return appVisibilityPending.promise;
    if (nextVisible === appVisible && !appVisibilityPending) return Promise.resolve(true);

    const revision = ++appVisibilityRevision;
    appVisible = nextVisible;
    webRevision += 1;
    const promise = nextVisible
      ? resumeAppPresentation(revision)
      : suspendAppPresentation(revision);
    const pending = { target: nextVisible, promise };
    appVisibilityPending = pending;
    void promise.finally(() => {
      if (appVisibilityPending === pending) appVisibilityPending = null;
    });
    return promise;
  }

  function setWidth(value, { save = false } = {}) {
    settings.companionWidth = clampCompanionWidth(value);
    dock.style.setProperty('--companion-width', `${settings.companionWidth}%`);
    ui.splitter.setAttribute('aria-valuenow', String(settings.companionWidth));
    ui.splitter.setAttribute('aria-valuetext', `右侧区域宽度 ${settings.companionWidth}%`);
    ui.splitter.setAttribute('aria-valuemin', '28');
    ui.splitter.setAttribute('aria-valuemax', '55');
    if (save) persist();
    onLayoutChange();
    scheduleBoundsSync();
  }

  async function openSiteModal(trigger = documentRef.activeElement) {
    if (!appVisible) return;
    const revision = ++siteModalRevision;
    siteModalTrigger = trigger && typeof trigger.focus === 'function' ? trigger : null;
    closeModeMenu({ restore: false });
    ui.siteName.value = '';
    ui.siteUrl.value = '';
    const hidden = await setControlledOverlayOpen('companion-site-modal', true);
    if (!hidden || destroyed || revision !== siteModalRevision) {
      if (revision === siteModalRevision) {
        void setControlledOverlayOpen('companion-site-modal', false);
        const returnTarget = siteModalTrigger;
        siteModalTrigger = null;
        if (!destroyed && returnTarget && !returnTarget.disabled) returnTarget.focus();
      }
      return;
    }
    ui.siteModal.classList.add('active');
    windowRef.requestAnimationFrame(() => {
      if (!destroyed && revision === siteModalRevision && ui.siteModal.classList.contains('active')) {
        ui.siteName.focus();
      }
    });
  }

  function closeSiteModal({ restoreFocus = true, focusTarget = null } = {}) {
    const returnTarget = focusTarget || siteModalTrigger;
    siteModalTrigger = null;
    siteModalRevision += 1;
    ui.siteModal.classList.remove('active');
    ui.siteForm.reset();
    void setControlledOverlayOpen('companion-site-modal', false);
    if (restoreFocus && !destroyed && returnTarget && !returnTarget.disabled) returnTarget.focus();
  }

  function siteModalFocusables() {
    return [ui.siteModalClose, ui.siteName, ui.siteUrl, ui.siteCancel, ui.siteSubmit]
      .filter(element => !element.disabled
        && !element.hidden
        && element.getAttribute?.('aria-hidden') !== 'true');
  }

  function handleDocumentKeydown(event) {
    if (ui.siteModal.classList.contains('active')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSiteModal();
        return;
      }
      if (event.key === 'Tab') {
        const focusables = siteModalFocusables();
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeIndex = focusables.indexOf(documentRef.activeElement);
        const shouldWrap = activeIndex === -1
          || (!event.shiftKey && documentRef.activeElement === last)
          || (event.shiftKey && documentRef.activeElement === first);
        if (first && shouldWrap) {
          event.preventDefault();
          (event.shiftKey && activeIndex !== -1 ? last : first).focus();
        }
        return;
      }
    }
    if (event.key === 'Escape') closeModeMenu();
  }

  function addSite(event) {
    event.preventDefault();
    const candidate = normalizeCompanionSite({
      id: createCompanionSiteId(windowRef.crypto),
      name: ui.siteName.value,
      url: urlWithDefaultScheme(ui.siteUrl.value),
    });
    if (!candidate) {
      notify('请输入有效的 HTTPS 网页地址', 'error');
      ui.siteUrl.focus();
      return;
    }
    settings.sites = [...settings.sites, candidate];
    settings.activeSiteId = candidate.id;
    persist();
    renderSites();
    const focusTarget = siteModalTrigger === ui.emptyAddSite ? ui.siteSelect : siteModalTrigger;
    closeSiteModal({ focusTarget });
    notify(`已添加 ${candidate.name}`, 'success');
    void openActiveSite({ force: true });
  }

  function removeCurrentSite() {
    const site = selectedSite();
    if (!site) return;
    const currentIndex = settings.sites.findIndex(item => item.id === site.id);
    settings.sites = settings.sites.filter(item => item.id !== site.id);
    const nextSite = settings.sites[Math.min(currentIndex, settings.sites.length - 1)] || null;
    settings.activeSiteId = nextSite?.id ?? null;
    persist();
    renderSites();
    notify(`已移除 ${site.name}`, 'success');
    void closeWebview().then(() => {
      if (nextSite && settings.activeSiteId === nextSite.id) void openActiveSite({ force: true });
    });
  }

  function hasVisibleOverlay() {
    return controlledOverlayReasons.size > 0
      || Array.from(overlayNodes).some(node => node.classList.contains('active'));
  }

  async function syncOverlayState() {
    const next = hasVisibleOverlay();
    if (next === overlayOpen) {
      if (!next) return true;
      try {
        await overlayHidePromise;
        return overlayOpen;
      } catch (_) {
        return false;
      }
    }

    const revision = ++overlayRevision;
    overlayOpen = next;
    if (overlayOpen) {
      gameCenter.pause();
      overlayHidePromise = webview.created
        ? queueWebTask(() => webview.hide()).then(() => true)
        : Promise.resolve(true);
      try {
        await overlayHidePromise;
      } catch (error) {
        if (revision === overlayRevision) {
          setWebStatus(`网页区域暂时无法隐藏：${errorMessage(error)}`, 'error');
        }
        return false;
      }
      return !destroyed && revision === overlayRevision && overlayOpen;
    }

    if (appVisible && mode === WORKSPACE_MODES.RELAX && dockOpen) {
      if (webview.created) scheduleBoundsSync();
      else void openActiveSite();
    } else if (appVisible && mode === WORKSPACE_MODES.ENTERTAINMENT && dockOpen) {
      ensureGame();
    }
    return !destroyed && revision === overlayRevision && !overlayOpen;
  }

  function setControlledOverlayOpen(reason, open) {
    const key = String(reason || 'controlled-overlay');
    if (open) controlledOverlayReasons.add(key);
    else controlledOverlayReasons.delete(key);
    return syncOverlayState();
  }

  function observeOverlay(node, observer) {
    if (!node || overlayNodes.has(node)) return;
    overlayNodes.add(node);
    observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }

  function bindOverlayVisibility() {
    const observer = new MutationObserver(() => { void syncOverlayState(); });
    documentRef.querySelectorAll('.modal-mask, .term-diy').forEach(node => observeOverlay(node, observer));
    const childObserver = new MutationObserver(records => {
      records.forEach(record => record.addedNodes.forEach(node => {
        if (node.nodeType === 1 && node.matches?.('.term-diy')) observeOverlay(node, observer);
      }));
    });
    childObserver.observe(dock, { childList: true });
    disposers.push(() => observer.disconnect(), () => childObserver.disconnect());
  }

  function bindSplitter() {
    let startX = 0;
    let startWidth = 0;
    let mainWidth = 1;
    let opening = false;
    let revision = 0;

    const detachListeners = () => {
      documentRef.removeEventListener('mousemove', move);
      documentRef.removeEventListener('mouseup', finish);
      documentRef.removeEventListener('pointercancel', finish);
      windowRef.removeEventListener('blur', finish);
    };

    const finish = () => {
      if (!resizing && !opening) return;
      const wasResizing = resizing;
      const wasOpening = opening;
      revision += 1;
      opening = false;
      resizing = false;
      dock.classList.remove('is-companion-resizing');
      documentRef.body.style.userSelect = '';
      detachListeners();
      if (wasResizing) persist();
      if ((wasResizing || wasOpening) && mode === WORKSPACE_MODES.RELAX && webview.created) {
        scheduleBoundsSync();
      }
    };

    const move = event => {
      const nextPixels = startWidth - (event.clientX - startX);
      setWidth((nextPixels / mainWidth) * 100);
    };

    const begin = async event => {
      if (event.button !== 0 || resizing || opening) return;
      const currentRevision = ++revision;
      const rect = terminalMain.getBoundingClientRect();
      startX = event.clientX;
      startWidth = ui.panel.getBoundingClientRect().width;
      mainWidth = Math.max(1, rect.width);
      opening = true;
      documentRef.addEventListener('mouseup', finish);
      documentRef.addEventListener('pointercancel', finish);
      windowRef.addEventListener('blur', finish, { once: true });

      if (webview.created) {
        try {
          await queueWebTask(() => webview.hide());
        } catch (error) {
          if (currentRevision === revision) {
            setWebStatus(`网页区域暂时无法隐藏：${errorMessage(error)}`, 'error');
            finish();
          }
          return;
        }
      }

      if (currentRevision !== revision) return;
      if (destroyed
        || !appVisible
        || !dockOpen
        || overlayOpen
        || floatingUiReasons.size > 0
        || mode === WORKSPACE_MODES.NORMAL) {
        finish();
        return;
      }

      opening = false;
      resizing = true;
      dock.classList.add('is-companion-resizing');
      documentRef.body.style.userSelect = 'none';
      documentRef.addEventListener('mousemove', move);
    };

    cancelSplitterInteraction = finish;
    listen(ui.splitter, 'mousedown', event => { void begin(event); });

    listen(ui.splitter, 'keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setWidth(settings.companionWidth + (event.key === 'ArrowLeft' ? 1 : -1), { save: true });
    });
  }

  listen(ui.modeButton, 'click', event => { event.stopPropagation(); toggleModeMenu(); });
  ui.modeOptions.forEach(option => listen(option, 'click', () => { void applyMode(option.dataset.mode); }));
  listen(documentRef, 'click', event => {
    if (!event.target.closest('.workspace-mode-wrap')) closeModeMenu();
  });
  listen(documentRef, 'keydown', handleDocumentKeydown);
  listen(ui.siteSelect, 'change', () => {
    settings.activeSiteId = ui.siteSelect.value;
    persist();
    renderSites();
    void openActiveSite({ force: true });
  });
  listen(ui.addSite, 'click', () => { void openSiteModal(ui.addSite); });
  listen(ui.emptyAddSite, 'click', () => { void openSiteModal(ui.emptyAddSite); });
  listen(ui.removeSite, 'click', removeCurrentSite);
  listen(ui.refresh, 'click', () => { void openActiveSite({ force: true }); });
  listen(ui.openBrowser, 'click', () => { const site = selectedSite(); if (site) void openExternal(site.url); });
  listen(ui.returnTerminal, 'click', onFocusTerminal);
  listen(ui.close, 'click', () => { void applyMode(WORKSPACE_MODES.NORMAL); });
  listen(ui.siteModalClose, 'click', () => closeSiteModal());
  listen(ui.siteCancel, 'click', () => closeSiteModal());
  listen(ui.siteModal, 'click', event => { if (event.target === ui.siteModal) closeSiteModal(); });
  listen(ui.siteForm, 'submit', addSite);
  listen(ui.gameSelect, 'change', () => {
    settings.activeGameId = gameCenter.select(ui.gameSelect.value);
    persist();
    renderGames();
    ensureGame();
    windowRef.requestAnimationFrame(() => gameCenter.getActiveHost?.()?.focus());
  });
  listen(ui.gameSurface, 'pointerdown', () => windowRef.requestAnimationFrame(() => gameCenter.getActiveHost?.()?.focus()));
  listen(documentRef, 'visibilitychange', () => {
    if (documentRef.hidden) {
      gameCenter.pause();
      void hideWebviewAfterLifecycleChange();
    } else if (appVisible && mode === WORKSPACE_MODES.RELAX && dockOpen) {
      if (webview.created) scheduleBoundsSync();
      else void openActiveSite();
    } else if (appVisible && mode === WORKSPACE_MODES.ENTERTAINMENT && dockOpen) {
      ensureGame();
    }
  });
  listen(windowRef, 'focus', () => {
    nativeWindowFocused = true;
    if (!appVisible || overlayOpen || floatingUiReasons.size > 0 || !dockOpen) return;
    if (mode === WORKSPACE_MODES.ENTERTAINMENT) ensureGame();
    else if (mode === WORKSPACE_MODES.RELAX) {
      if (webview.created) scheduleBoundsSync();
      else void openActiveSite();
    }
  });

  function setNativeWindowFocus(focused) {
    nativeWindowFocused = Boolean(focused);
    if (!nativeWindowFocused) {
      gameCenter.pause();
      void hideWebviewAfterLifecycleChange();
      return;
    }
    if (!appVisible
      || overlayOpen
      || floatingUiReasons.size > 0
      || !dockOpen
      || documentRef.hidden) return;
    if (mode === WORKSPACE_MODES.RELAX) {
      if (webview.created) scheduleBoundsSync();
      else void openActiveSite();
    } else if (mode === WORKSPACE_MODES.ENTERTAINMENT) {
      ensureGame();
    }
  }

  function bindNativeWindowFocus() {
    const currentWindow = windowRef.__TAURI__?.window?.getCurrentWindow?.();
    if (!currentWindow || typeof currentWindow.onFocusChanged !== 'function') return;
    let disposed = false;
    let unlisten = null;
    Promise.resolve(currentWindow.onFocusChanged(event => setNativeWindowFocus(event?.payload)))
      .then(callback => {
        if (disposed) callback?.();
        else unlisten = callback;
      })
      .catch(() => {});
    disposers.push(() => {
      disposed = true;
      unlisten?.();
    });
  }

  bindSplitter();
  bindOverlayVisibility();
  bindNativeWindowFocus();
  const resizeObserver = new ResizeObserver(() => {
    onLayoutChange();
    scheduleBoundsSync();
  });
  resizeObserver.observe(ui.webSlot);
  disposers.push(() => resizeObserver.disconnect());

  setWidth(settings.companionWidth);
  renderSites();
  renderGames();
  renderMode();

  const controller = {
    get mode() { return mode; },
    get appVisible() { return appVisible; },
    get settings() { return { ...settings, sites: settings.sites.map(site => ({ ...site })) }; },
    applyMode,
    scheduleBoundsSync,
    setAppVisible,
    setFloatingUiOpen,
    setDockOpen(open) {
      dockOpen = Boolean(open);
      if (!dockOpen) {
        cancelSplitterInteraction();
        closeModeMenu({ restore: false });
        closeSiteModal({ restoreFocus: false });
        gameCenter.pause();
        void closeWebview();
      } else if (mode === WORKSPACE_MODES.RELAX) {
        void openActiveSite();
      } else if (mode === WORKSPACE_MODES.ENTERTAINMENT) {
        ensureGame();
      }
    },
    setOverlayOpen(open) {
      return setControlledOverlayOpen('controller-overlay', open);
    },
    destroy() {
      destroyed = true;
      appVisible = false;
      appVisibilityRevision += 1;
      webRevision += 1;
      cancelSplitterInteraction();
      closeSiteModal({ restoreFocus: false });
      if (syncFrame) windowRef.cancelAnimationFrame(syncFrame);
      pendingBounds = null;
      disposers.splice(0).forEach(dispose => dispose());
      gameCenter.destroy();
      void closeWebview();
    },
  };

  // Restore the saved mode after all listeners and observers are ready.
  void applyMode(mode, { persist: false });
  return controller;
}

export default installWorkspaceMode;
