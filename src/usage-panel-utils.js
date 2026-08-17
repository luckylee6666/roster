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
