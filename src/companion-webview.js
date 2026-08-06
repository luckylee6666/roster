/**
 * Small, dependency-free wrapper around Tauri's child Webview API.
 *
 * A companion is deliberately a separate native webview instead of an iframe:
 * third-party sites commonly reject framing.  This module never imports Tauri
 * at module evaluation time so the UI and its tests can still run in a browser.
 */

import { normalizeCompanionUrl } from './workspace-mode-utils.js';

export { normalizeCompanionUrl } from './workspace-mode-utils.js';

export const COMPANION_WEBVIEW_LABEL = 'companion-webview';

export function isAllowedCompanionUrl(value) {
  return Boolean(normalizeCompanionUrl(value));
}

export function normalizeCompanionBounds(bounds = {}) {
  const number = (value, fallback, minimum = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.round(parsed)) : fallback;
  };

  return {
    x: number(bounds.x, 0),
    y: number(bounds.y, 0),
    width: number(bounds.width, 1, 1),
    height: number(bounds.height, 1, 1),
  };
}

export function getTauriWebviewApi(globalObject = globalThis) {
  const tauri = globalObject?.__TAURI__;
  const Webview = tauri?.webview?.Webview;
  const getCurrentWindow = tauri?.window?.getCurrentWindow;
  return typeof Webview === 'function' && typeof getCurrentWindow === 'function'
    ? { Webview, tauri, getCurrentWindow }
    : null;
}

function logicalPosition(tauri, x, y) {
  const LogicalPosition = tauri?.dpi?.LogicalPosition;
  return typeof LogicalPosition === 'function' ? new LogicalPosition(x, y) : { x, y };
}

function logicalSize(tauri, width, height) {
  const LogicalSize = tauri?.dpi?.LogicalSize;
  return typeof LogicalSize === 'function' ? new LogicalSize(width, height) : { width, height };
}

async function waitForCreation(view, globalObject, timeoutMs = 10000) {
  if (!view || typeof view.once !== 'function') return;
  const setTimer = globalObject?.setTimeout?.bind(globalObject) || setTimeout;
  const clearTimer = globalObject?.clearTimeout?.bind(globalObject) || clearTimeout;
  await new Promise((resolve, reject) => {
    let settled = false;
    const unlisteners = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      unlisteners.splice(0).forEach(unlisten => { try { unlisten(); } catch (_) {} });
      callback(value);
    };
    const timer = setTimer(() => finish(reject, new Error('创建网页区域超时')), timeoutMs);
    const rememberUnlisten = unlisten => {
      if (typeof unlisten !== 'function') return;
      if (settled) unlisten();
      else unlisteners.push(unlisten);
    };
    Promise.resolve(view.once('tauri://created', () => finish(resolve)))
      .then(rememberUnlisten)
      .catch(error => finish(reject, error));
    Promise.resolve(view.once('tauri://error', event => {
      const detail = event?.payload || event?.message || '未知错误';
      finish(reject, new Error(`创建网页区域失败：${detail}`));
    }))
      .then(rememberUnlisten)
      .catch(error => finish(reject, error));
  });
}

/**
 * Owns one remote child Webview.  There is no stable JS navigate method on
 * Tauri's Webview handle, therefore navigate is intentionally implemented as
 * a close-and-recreate operation.  The app keeps the URL separately, while
 * the native webview remains isolated from the application's IPC capability.
 */
export class CompanionWebview {
  constructor({ label = COMPANION_WEBVIEW_LABEL, globalObject = globalThis } = {}) {
    this.label = label;
    this.globalObject = globalObject;
    this.webview = null;
    this.url = null;
    this.bounds = null;
  }

  get available() {
    return getTauriWebviewApi(this.globalObject) !== null;
  }

  get created() {
    return this.webview !== null;
  }

  async create(url, bounds) {
    const safeUrl = normalizeCompanionUrl(url);
    if (!safeUrl) throw new TypeError('Companion webview only accepts HTTPS URLs (or localhost HTTP).');
    if (!this.available) return null;

    if (this.webview) await this.close();

    const { Webview, getCurrentWindow } = getTauriWebviewApi(this.globalObject);
    const normalizedBounds = normalizeCompanionBounds(bounds);
    const parent = getCurrentWindow();
    const options = {
      url: safeUrl,
      ...normalizedBounds,
      focus: false,
      dragDropEnabled: false,
      devtools: false,
    };

    const view = new Webview(parent, this.label, options);
    this.webview = view;
    this.url = safeUrl;
    this.bounds = normalizedBounds;
    try {
      await waitForCreation(view, this.globalObject);
    } catch (error) {
      if (this.webview === view) {
        this.webview = null;
        this.url = null;
        this.bounds = null;
      }
      try { await view.close?.(); } catch (_) {}
      throw error;
    }
    return view;
  }

  async navigate(url, bounds = this.bounds) {
    return this.create(url, bounds || {});
  }

  async show() {
    return this.#call('show');
  }

  async hide() {
    return this.#call('hide');
  }

  async focus() {
    return this.#call('setFocus');
  }

  async setPosition(position) {
    const next = normalizeCompanionBounds({ ...this.bounds, ...position });
    const tauri = getTauriWebviewApi(this.globalObject)?.tauri;
    const result = await this.#call('setPosition', logicalPosition(tauri, next.x, next.y));
    if (result) this.bounds = { ...next };
    return result;
  }

  async setSize(size) {
    const next = normalizeCompanionBounds({ ...this.bounds, ...size });
    const tauri = getTauriWebviewApi(this.globalObject)?.tauri;
    const result = await this.#call('setSize', logicalSize(tauri, next.width, next.height));
    if (result) this.bounds = { ...next };
    return result;
  }

  async close() {
    const view = this.webview;
    if (!view || typeof view.close !== 'function') return false;
    await view.close();
    // Only forget the native handle after Tauri confirms it was closed. If the
    // call rejects, retaining the handle lets callers retry instead of creating
    // a second child WebView with the same label while the first may still live.
    if (this.webview === view) {
      this.webview = null;
      this.url = null;
      this.bounds = null;
    }
    return true;
  }

  async #call(method, ...args) {
    const view = this.webview;
    if (!view || typeof view[method] !== 'function') return false;
    await view[method](...args);
    return true;
  }
}
