export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
export const PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]);

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:']);

export function normalizeProxyUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (/[\s<>]/.test(text) || text.includes('\\')) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol) || !parsed.hostname) return '';
  if (parsed.username || parsed.password) {
    if (/[\r\n]/.test(parsed.username) || /[\r\n]/.test(parsed.password)) return '';
  }
  const href = parsed.href.replace(/\/$/, '');
  return href || '';
}

export function isValidProxyUrl(raw) {
  return Boolean(normalizeProxyUrl(raw));
}

export function redactProxyUrl(raw) {
  const url = normalizeProxyUrl(raw);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    return `${parsed.protocol}//***@${parsed.host}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function isSocksProxy(url) {
  return /^(socks4|socks5h?|socks):/i.test(String(url || '').trim());
}

export function normalizeNoProxy(raw) {
  const text = String(raw || '').split(',').map(part => part.trim()).filter(Boolean).join(',');
  return text || DEFAULT_NO_PROXY;
}

export function normalizeProxySettings(raw = {}) {
  const enabled = Boolean(raw?.enabled);
  const url = normalizeProxyUrl(raw?.url);
  const noProxy = normalizeNoProxy(raw?.noProxy);
  return {
    enabled: enabled && Boolean(url),
    url: enabled ? url : (url || String(raw?.url || '').trim()),
    noProxy,
  };
}

export function proxyEnvAssignments(settings = {}) {
  const normalized = normalizeProxySettings(settings);
  if (!normalized.enabled || !normalized.url) return {};
  const socks = isSocksProxy(normalized.url);
  const env = {};
  for (const key of PROXY_ENV_KEYS) {
    const upper = key.toUpperCase();
    if (upper === 'NO_PROXY') {
      env[key] = normalized.noProxy;
      continue;
    }
    if (socks && (upper === 'HTTP_PROXY' || upper === 'HTTPS_PROXY')) continue;
    env[key] = normalized.url;
  }
  return env;
}
