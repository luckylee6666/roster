export const USAGE_AGENTS = ['claude', 'codex'];

export function usageCommandForAgent(agent) {
  return agent === 'codex' ? 'codex_usage' : 'oauth_usage';
}

export function windowsFromUsagePayload(agent, payload) {
  if (agent === 'codex') {
    return Array.isArray(payload?.windows) ? payload.windows : [];
  }
  return [
    { label: '5 小时窗口', utilization: payload?.fiveHour?.utilization, resetsAt: payload?.fiveHour?.resetsAt },
    { label: '7 天窗口', utilization: payload?.sevenDay?.utilization, resetsAt: payload?.sevenDay?.resetsAt },
  ];
}

/** 侧栏那一行只要「窗口 + 百分比」，去掉「窗口」二字免得挤。 */
export function conversationUsageSummary(agent, payload) {
  if (!payload || payload.ok === false) return '';
  const parts = windowsFromUsagePayload(agent, payload)
    .filter(entry => Number.isFinite(Number(entry?.utilization)))
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
  const rest = minutes % 60;
  return rest ? `约 ${hours} 小时 ${rest} 分后重置` : `约 ${hours} 小时后重置`;
}

/**
 * 平时只要一行安静的数字；接近上限才需要被看见，所以额外给出等级和重置时间。
 * level: ok / warn(≥70) / danger(≥90) / blocked(≥100)
 */
export function conversationUsageState(agent, payload, now = Date.now()) {
  const windows = (!payload || payload.ok === false)
    ? []
    : windowsFromUsagePayload(agent, payload)
      .filter(entry => Number.isFinite(Number(entry?.utilization)));
  if (!windows.length) return { text: '', level: 'ok', peak: 0, reset: '', blocked: false };
  const text = conversationUsageSummary(agent, payload);
  const peakWindow = windows.reduce(
    (worst, entry) => (Number(entry.utilization) > Number(worst.utilization) ? entry : worst),
    windows[0],
  );
  const peak = Math.max(0, Math.min(100, Math.round(Number(peakWindow.utilization))));
  const level = peak >= 100 ? 'blocked' : peak >= 90 ? 'danger' : peak >= 70 ? 'warn' : 'ok';
  const label = String(peakWindow.label || '').replace(/窗口$/, '').trim();
  return {
    text,
    level,
    peak,
    window: label,
    reset: usageResetLabel(peakWindow.resetsAt, now),
    blocked: level === 'blocked',
  };
}
