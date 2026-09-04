export const USAGE_AGENTS = ['claude', 'codex', 'grok'];
export const GROK_USAGE_FRESH_MS = 60 * 1000;

export function usageAgentsForInstalledClis(installedIds, supportedIds = USAGE_AGENTS) {
  const installed = new Set((Array.isArray(installedIds) ? installedIds : []).map(String));
  const supported = new Set((Array.isArray(supportedIds) ? supportedIds : []).map(String));
  return USAGE_AGENTS.filter(agent => installed.has(agent) && supported.has(agent));
}

export function selectUsageAgent(availableAgents, requestedAgent) {
  const available = Array.isArray(availableAgents) ? availableAgents : [];
  return available.includes(requestedAgent) ? requestedAgent : (available[0] || '');
}

export function shouldApplyUsageResult({
  requestRevision,
  currentRevision,
  overlayOpen,
  agent,
  currentAgent,
  installedIds,
  supportedIds,
} = {}) {
  return requestRevision === currentRevision
    && Boolean(overlayOpen)
    && agent === currentAgent
    && usageAgentsForInstalledClis(installedIds, supportedIds).includes(agent);
}

export function usageRefreshMaxAge(agent, requestedMaxAge) {
  const maxAge = Number(requestedMaxAge);
  const normalized = Number.isFinite(maxAge) && maxAge >= 0 ? maxAge : 0;
  return agent === 'grok' ? Math.min(normalized, GROK_USAGE_FRESH_MS) : normalized;
}

export function grokUsageFreshRemainingMs(payload) {
  if (payload?.stale) return 0;
  const exactAgeMs = Number(payload?.ageMs);
  if (Number.isFinite(exactAgeMs) && exactAgeMs >= 0) {
    return Math.max(0, GROK_USAGE_FRESH_MS - exactAgeMs);
  }
  const ageSecs = Number(payload?.ageSecs);
  // 旧后端只有向下取整的整数秒；保守补足下一秒，避免 59.999s 被当成
  // 还剩整整 1s 的新鲜数据。完全没给年龄时才从 0 开始计。
  const ageMs = Number.isFinite(ageSecs) && ageSecs >= 0
    ? (Math.floor(ageSecs) + 1) * 1000
    : 0;
  return Math.max(0, GROK_USAGE_FRESH_MS - ageMs);
}

export function usageCommandForAgent(agent) {
  if (agent === 'claude') return 'oauth_usage';
  if (agent === 'codex') return 'codex_usage';
  if (agent === 'grok') return 'grok_usage';
  return '';
}

export function windowsFromUsagePayload(agent, payload) {
  if (agent === 'codex' || agent === 'grok') {
    return Array.isArray(payload?.windows) ? payload.windows : [];
  }
  return agent === 'claude'
    ? [
        { label: '5 小时窗口', utilization: payload?.fiveHour?.utilization, resetsAt: payload?.fiveHour?.resetsAt },
        { label: '7 天窗口', utilization: payload?.sevenDay?.utilization, resetsAt: payload?.sevenDay?.resetsAt },
      ]
    : [];
}

/**
 * 顶栏只有一行的位置。Codex 除了账号总额度，还会按模型各报一份 5 小时和 7 天，
 * 三段拼起来那一行会被挤成零宽——看起来就是"额度没显示"。所以这里只留账号级的
 * 窗口（按模型报的那几份标签带「模型名 ·」前缀），详细分档留给开发模式的用量面板。
 */
export function conversationUsageWindows(agent, payload) {
  const windows = (!payload || payload.ok === false)
    ? []
    : windowsFromUsagePayload(agent, payload)
      .filter(entry => Number.isFinite(Number(entry?.utilization)));
  if (agent !== 'codex') return windows;
  const account = windows.filter(entry => !String(entry?.label || '').includes('·'));
  return account.length ? account : windows;
}

/** 侧栏那一行只要「窗口 + 百分比」，去掉「窗口」二字免得挤。 */
export function conversationUsageSummary(agent, payload) {
  if (!payload || payload.ok === false) return '';
  const parts = conversationUsageWindows(agent, payload)
    .map(entry => {
      const label = String(entry.label || '').replace(/窗口$/, '').trim();
      const percent = Math.max(0, Math.min(100, Math.round(Number(entry.utilization))));
      return label ? `${label} ${percent}%` : `${percent}%`;
    });
  return parts.join(' · ');
}

/** 「约 1 小时 20 分后重置」；拿不到或已过期就给空串。 */
export function usageResetLabel(resetsAt, now = Date.now()) {
  const at = Date.parse(String(resetsAt || ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - now) / 60000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `约 ${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  // 周窗口离重置还有好几天，换算成「156 小时 51 分」没人读得出是多久。
  if (hours >= 48) return `约 ${Math.round(hours / 24)} 天后重置`;
  const rest = minutes % 60;
  return rest ? `约 ${hours} 小时 ${rest} 分后重置` : `约 ${hours} 小时后重置`;
}

/**
 * 平时只要一行安静的数字；接近上限才需要被看见，所以额外给出等级和重置时间。
 * level: ok / warn(≥70) / danger(≥90) / blocked(≥100)
 */
export function conversationUsageState(agent, payload, now = Date.now()) {
  const windows = conversationUsageWindows(agent, payload);
  if (!windows.length) return { text: '', level: 'ok', peak: 0, reset: '', blocked: false, stale: false };
  const text = conversationUsageSummary(agent, payload);
  const peakWindow = windows.reduce(
    (worst, entry) => (Number(entry.utilization) > Number(worst.utilization) ? entry : worst),
    windows[0],
  );
  const peak = Math.max(0, Math.min(100, Math.round(Number(peakWindow.utilization))));
  const stale = Boolean(payload?.stale);
  const level = stale ? 'ok' : peak >= 100 ? 'blocked' : peak >= 90 ? 'danger' : peak >= 70 ? 'warn' : 'ok';
  const label = String(peakWindow.label || '').replace(/窗口$/, '').trim();
  return {
    text,
    level,
    peak,
    window: label,
    reset: usageResetLabel(peakWindow.resetsAt, now),
    blocked: level === 'blocked',
    stale,
  };
}
