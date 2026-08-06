import { normalizeGameId } from './games/game-ids.js';

export const WORKSPACE_MODES = Object.freeze({
  NORMAL: 'normal',
  RELAX: 'relax',
  ENTERTAINMENT: 'entertainment',
});

export const DEFAULT_WORKSPACE_MODE = WORKSPACE_MODES.NORMAL;
export const DEFAULT_COMPANION_WIDTH = 42;
export const COMPANION_WIDTH_MIN = 28;
export const COMPANION_WIDTH_MAX = 55;

export const WORKSPACE_MODE_STORAGE_KEYS = Object.freeze({
  state: 'workspace-mode-settings-v2',
  legacyState: 'workspace-mode-settings-v1',
  mode: 'workspace-mode',
  sites: 'workspace-companion-sites',
  companionWidth: 'workspace-companion-width',
  activeSite: 'workspace-companion-active-site',
});

const MODE_VALUES = new Set(Object.values(WORKSPACE_MODES));
const SITE_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
const MAX_SITE_NAME_LENGTH = 64;
const MAX_SITE_ID_GENERATION_ATTEMPTS = 32;
const LEGACY_DOUYIN_SITE = Object.freeze({
  id: 'douyin',
  url: 'https://www.douyin.com/',
});

export const DEFAULT_COMPANION_SITES = Object.freeze([
  Object.freeze({ id: 'douyin', name: '抖音', url: 'https://www.douyin.com/' }),
]);

export function normalizeWorkspaceMode(value) {
  return MODE_VALUES.has(value) ? value : DEFAULT_WORKSPACE_MODE;
}

export function clampCompanionWidth(value, fallback = DEFAULT_COMPANION_WIDTH) {
  const numeric = typeof value === 'number' ? value : Number(value);
  const safeFallback = Number.isFinite(Number(fallback))
    ? Math.min(COMPANION_WIDTH_MAX, Math.max(COMPANION_WIDTH_MIN, Number(fallback)))
    : DEFAULT_COMPANION_WIDTH;
  if (!Number.isFinite(numeric)) return safeFallback;
  return Math.min(COMPANION_WIDTH_MAX, Math.max(COMPANION_WIDTH_MIN, Math.round(numeric)));
}

function cryptoProvider(cryptoRef = globalThis.crypto) {
  if (!cryptoRef || (typeof cryptoRef.randomUUID !== 'function'
    && typeof cryptoRef.getRandomValues !== 'function')) {
    throw new Error('当前环境不支持安全随机数，无法创建网站标识。');
  }
  return cryptoRef;
}

export function createCompanionSiteId(cryptoRef = globalThis.crypto) {
  const crypto = cryptoProvider(cryptoRef);
  if (typeof crypto.randomUUID === 'function') return `site-${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `site-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeSiteName(value, fallback) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  return (normalized || fallback).slice(0, MAX_SITE_NAME_LENGTH);
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host === '::1' || host === '[::1]' || host === '127.0.0.1';
}

/**
 * Remote content is intentionally limited to HTTPS. HTTP is retained only for
 * the common local development endpoints, never for a public remote host.
 */
export function normalizeCompanionUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return '';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

export function isAllowedCompanionUrl(value) {
  return Boolean(normalizeCompanionUrl(value));
}

function validSiteId(value) {
  return typeof value === 'string' && SITE_ID_PATTERN.test(value);
}

export function normalizeCompanionSite(value, { idFactory = createCompanionSiteId } = {}) {
  if (!value || typeof value !== 'object') return null;
  const url = normalizeCompanionUrl(value.url);
  if (!url) return null;
  const hostname = new URL(url).hostname.replace(/^www\./i, '');
  let id = value.id;
  if (!validSiteId(id)) {
    try {
      id = idFactory();
    } catch (_) {
      return null;
    }
  }
  return {
    id,
    name: normalizeSiteName(value.name, hostname),
    url,
  };
}

export function createDefaultCompanionSites() {
  return DEFAULT_COMPANION_SITES.map(site => ({ ...site }));
}

function withoutLegacyBuiltinSite(sites) {
  return (Array.isArray(sites) ? sites : []).filter(site => !(
    site?.id === LEGACY_DOUYIN_SITE.id
    && normalizeCompanionUrl(site?.url) === LEGACY_DOUYIN_SITE.url
  ));
}

export function normalizeCompanionSites(value, {
  idFactory = createCompanionSiteId,
} = {}) {
  const candidates = Array.isArray(value) ? value : [];
  const normalized = [];
  const usedIds = new Set();
  const sitesById = new Map();

  for (const candidate of candidates) {
    const site = normalizeCompanionSite(candidate, { idFactory });
    if (!site) continue;
    const existing = sitesById.get(site.id);
    if (existing && existing.name === site.name && existing.url === site.url) continue;
    if (usedIds.has(site.id)) {
      let replacementId = null;
      for (let attempt = 0; attempt < MAX_SITE_ID_GENERATION_ATTEMPTS; attempt += 1) {
        let generatedId;
        try {
          generatedId = idFactory();
        } catch (_) {
          break;
        }
        if (!usedIds.has(generatedId)) {
          replacementId = generatedId;
          break;
        }
      }
      if (!replacementId) continue;
      site.id = replacementId;
    }
    usedIds.add(site.id);
    sitesById.set(site.id, site);
    normalized.push(site);
  }
  return normalized;
}

function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') return storage;
  if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  return null;
}

export function safeStorageGet(key, fallback = null, storage) {
  try {
    const value = resolveStorage(storage)?.getItem(key);
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

export function safeStorageSet(key, value, storage) {
  try {
    const target = resolveStorage(storage);
    if (!target) return false;
    target.setItem(key, String(value));
    return true;
  } catch (_) {
    return false;
  }
}

export function safeStorageReadJson(key, fallback, storage) {
  const raw = safeStorageGet(key, null, storage);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

export function safeStorageWriteJson(key, value, storage) {
  try {
    return safeStorageSet(key, JSON.stringify(value), storage);
  } catch (_) {
    return false;
  }
}

export function loadWorkspaceModeSettings(storage) {
  const v2State = safeStorageReadJson(WORKSPACE_MODE_STORAGE_KEYS.state, null, storage);
  const hasV2State = v2State && typeof v2State === 'object' && !Array.isArray(v2State);
  const v1State = hasV2State
    ? null
    : safeStorageReadJson(WORKSPACE_MODE_STORAGE_KEYS.legacyState, null, storage);
  const hasV1State = v1State && typeof v1State === 'object' && !Array.isArray(v1State);
  const source = hasV2State ? v2State : (hasV1State ? v1State : {
    mode: safeStorageGet(WORKSPACE_MODE_STORAGE_KEYS.mode, DEFAULT_WORKSPACE_MODE, storage),
    companionWidth: safeStorageGet(WORKSPACE_MODE_STORAGE_KEYS.companionWidth, DEFAULT_COMPANION_WIDTH, storage),
    sites: safeStorageReadJson(WORKSPACE_MODE_STORAGE_KEYS.sites, [], storage),
    activeSiteId: safeStorageGet(WORKSPACE_MODE_STORAGE_KEYS.activeSite, '', storage),
  });
  const sites = normalizeCompanionSites(hasV2State ? source.sites : withoutLegacyBuiltinSite(source.sites));
  const savedActiveSite = source.activeSiteId;
  const activeSiteId = sites.some(site => site.id === savedActiveSite)
    ? savedActiveSite
    : sites[0]?.id ?? null;
  return {
    mode: normalizeWorkspaceMode(source.mode),
    companionWidth: clampCompanionWidth(source.companionWidth),
    sites,
    activeSiteId,
    activeGameId: normalizeGameId(source.activeGameId),
  };
}

export function saveWorkspaceModeSettings(settings, storage) {
  const normalized = {
    mode: normalizeWorkspaceMode(settings?.mode),
    companionWidth: clampCompanionWidth(settings?.companionWidth),
    sites: normalizeCompanionSites(settings?.sites),
    activeGameId: normalizeGameId(settings?.activeGameId),
  };
  normalized.activeSiteId = normalized.sites.some(site => site.id === settings?.activeSiteId)
    ? settings.activeSiteId
    : normalized.sites[0]?.id ?? null;
  return {
    settings: normalized,
    // One versioned JSON value prevents a quota/error halfway through four writes
    // from leaving mode, sites and active selection out of sync.
    saved: safeStorageWriteJson(WORKSPACE_MODE_STORAGE_KEYS.state, normalized, storage),
  };
}
