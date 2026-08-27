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
