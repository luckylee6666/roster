import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USAGE_AGENTS,
  usageCommandForAgent,
  windowsFromUsagePayload,
  conversationUsageSummary,
  conversationUsageState,
  usageResetLabel,
} from '../src/usage-panel-utils.js';

test('用量面板只保留 Claude 与 Codex', () => {
  assert.deepEqual(USAGE_AGENTS, ['claude', 'codex']);
  assert.equal(usageCommandForAgent('claude'), 'oauth_usage');
  assert.equal(usageCommandForAgent('codex'), 'codex_usage');
});

test('Claude 载荷映射为 5h / 7d 窗口', () => {
  const windows = windowsFromUsagePayload('claude', {
    fiveHour: { utilization: 12, resetsAt: '2026-08-17T12:00:00Z' },
    sevenDay: { utilization: 40, resetsAt: '2026-08-20T12:00:00Z' },
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].label, '5 小时窗口');
  assert.equal(windows[0].utilization, 12);
  assert.equal(windows[1].label, '7 天窗口');
});

test('Codex 载荷直接使用后端窗口列表', () => {
  const payload = {
    windows: [{ label: '7 天窗口', utilization: 30, resetsAt: '2026-08-20T12:00:00Z' }],
  };
  assert.deepEqual(windowsFromUsagePayload('codex', payload), payload.windows);
  assert.deepEqual(windowsFromUsagePayload('codex', {}), []);
});

test('对话侧栏的用量只留窗口和百分比，查不到就给空串', () => {
  assert.equal(
    conversationUsageSummary('claude', {
      ok: true,
      fiveHour: { utilization: 32.4 },
      sevenDay: { utilization: 6.6 },
    }),
    '5 小时 32% · 7 天 7%',
  );
  assert.equal(
    conversationUsageSummary('codex', { ok: true, windows: [{ label: '5 小时窗口', utilization: 120 }] }),
    '5 小时 100%',
    '越界的百分比夹到 100',
  );
  assert.equal(conversationUsageSummary('claude', { ok: false }), '');
  assert.equal(conversationUsageSummary('claude', null), '');
  assert.equal(conversationUsageSummary('claude', { ok: true, fiveHour: {}, sevenDay: {} }), '');
});

test('额度等级按最紧的那个窗口算，重置时间只在拿得到时给', () => {
  const now = Date.UTC(2026, 7, 27, 10, 0, 0);
  const at = new Date(now + 80 * 60000).toISOString();

  const quiet = conversationUsageState('claude', {
    ok: true,
    fiveHour: { utilization: 12 },
    sevenDay: { utilization: 3 },
  }, now);
  assert.equal(quiet.level, 'ok');
  assert.equal(quiet.blocked, false);
  assert.equal(quiet.reset, '', '没给重置时间就不编一个');

  const warn = conversationUsageState('claude', {
    ok: true,
    fiveHour: { utilization: 72, resetsAt: at },
    sevenDay: { utilization: 5 },
  }, now);
  assert.equal(warn.level, 'warn');
  assert.equal(warn.window, '5 小时', '等级取最紧的那个窗口');

  const blocked = conversationUsageState('claude', {
    ok: true,
    fiveHour: { utilization: 100, resetsAt: at },
    sevenDay: { utilization: 40 },
  }, now);
  assert.equal(blocked.level, 'blocked');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reset, '约 1 小时 20 分后重置');

  assert.equal(conversationUsageState('claude', { ok: false }, now).level, 'ok');
  assert.equal(conversationUsageState('claude', null, now).text, '');
});

test('重置时间文案：过期或拿不到都给空串', () => {
  const now = Date.UTC(2026, 7, 27, 10, 0, 0);
  assert.equal(usageResetLabel(new Date(now + 25 * 60000).toISOString(), now), '约 25 分钟后重置');
  assert.equal(usageResetLabel(new Date(now + 120 * 60000).toISOString(), now), '约 2 小时后重置');
  assert.equal(usageResetLabel(new Date(now - 60000).toISOString(), now), '', '已经过去就不显示');
  assert.equal(usageResetLabel('', now), '');
  assert.equal(usageResetLabel('不是时间', now), '');
  // 周窗口离重置常有一百多小时，按小时读不出是多久。
  assert.equal(usageResetLabel(new Date(now + 47 * 3600000).toISOString(), now), '约 47 小时后重置');
  assert.equal(usageResetLabel(new Date(now + 48 * 3600000).toISOString(), now), '约 2 天后重置');
  assert.equal(usageResetLabel(new Date(now + 10080 * 60000).toISOString(), now), '约 7 天后重置');
});

test('Codex 顶栏只留账号级窗口，不把按模型报的分档也拼上去', () => {
  const now = Date.UTC(2026, 7, 27, 10, 0, 0);
  // 本机实测：账号总额度之外，Codex 还会按模型各报一份，标签带「模型名 ·」前缀。
  // 三段拼成一行会把顶栏那格挤成零宽，用户看到的就是"额度没显示"。
  const codex = {
    ok: true,
    windows: [
      { label: '7 天窗口', utilization: 16, resetsAt: new Date(now + 156 * 3600000).toISOString() },
      { label: 'GPT-5.3-Codex-Spark · 5 小时窗口', utilization: 0, resetsAt: new Date(now + 8 * 3600000).toISOString() },
      { label: 'GPT-5.3-Codex-Spark · 7 天窗口', utilization: 0, resetsAt: new Date(now + 167 * 3600000).toISOString() },
    ],
  };
  assert.equal(conversationUsageSummary('codex', codex), '7 天 16%');
  assert.equal(conversationUsageState('codex', codex, now).peak, 16, '峰值只看账号级的窗口');

  // 开发模式的详细面板还是要看到全部分档，共用的那个函数不能被改窄。
  assert.equal(windowsFromUsagePayload('codex', codex).length, 3);
});

test('Codex 只有周窗口时也能给出一行额度', () => {
  const now = Date.UTC(2026, 7, 27, 10, 0, 0);
  // 本机实测负载：secondary 为 null，只有 primary 的 10080 分钟窗口。
  const codex = {
    ok: true,
    plan: 'prolite',
    windows: [
      { label: '7 天窗口', utilization: 16, resetsAt: new Date(now + 156 * 3600000).toISOString() },
    ],
  };
  const state = conversationUsageState('codex', codex, now);
  assert.equal(state.text, '7 天 16%');
  assert.equal(state.level, 'ok');
  assert.equal(state.peak, 16);
  assert.equal(state.reset, '约 7 天后重置');
});
