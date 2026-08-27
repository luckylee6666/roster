import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USAGE_AGENTS,
  usageCommandForAgent,
  windowsFromUsagePayload,
  conversationUsageSummary,
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
