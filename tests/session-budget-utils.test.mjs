import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatSessionBytes,
  formatSessionTokens,
  normalizeSessionBudget,
  sessionBudgetBadge,
  sessionBudgetBlocks,
} from '../src/session-budget-utils.js';

test('体积按 KB/MB/GB 三档显示，拿不到就不编数字', () => {
  assert.equal(formatSessionBytes(0), '');
  assert.equal(formatSessionBytes(null), '');
  assert.equal(formatSessionBytes(Number.NaN), '');
  assert.equal(formatSessionBytes(512), '512B');
  assert.equal(formatSessionBytes(8 * 1024), '8KB');
  assert.equal(formatSessionBytes(4.02 * 1024 * 1024), '4.0MB');
  assert.equal(formatSessionBytes(2.5 * 1024 ** 3), '2.5GB');
});

test('token 估算值按 K/M 显示', () => {
  assert.equal(formatSessionTokens(0), '');
  assert.equal(formatSessionTokens(1500), '2K');
  assert.equal(formatSessionTokens(1_048_576), '1.05M');
  assert.equal(formatSessionTokens(650_000), '650K');
});

test('只有偏长与超窗才出徽标，正常会话保持安静', () => {
  assert.equal(sessionBudgetBadge({ band: 'ok', sizeBytes: 1024, estTokens: 100, window: 1000 }), null);
  assert.equal(sessionBudgetBadge({ band: 'unknown', sizeBytes: 1024 }), null);
  assert.equal(sessionBudgetBadge(null), null);
  assert.equal(sessionBudgetBadge(undefined), null);
  assert.equal(sessionBudgetBadge({ band: 'long' }), null, '没有体积就不显示空徽标');

  const long = sessionBudgetBadge({ band: 'long', sizeBytes: 4_219_398, estTokens: 703_233, window: 1_048_576 });
  assert.equal(long.level, 'long');
  assert.equal(long.text, '4.0MB');
  assert.match(long.title, /估算 ≈703K tokens/);
  assert.match(long.title, /1\.05M tokens/);

  const over = sessionBudgetBadge({
    band: 'over',
    blocks: true,
    sizeBytes: 7_500_196,
    estTokens: 1_250_033,
    window: 1_048_576,
  });
  assert.equal(over.level, 'over');
  assert.equal(over.text, '7.2MB');
  assert.match(over.title, /估算 ≈1\.25M tokens/, '徽标必须标明是估算');
  assert.match(over.title, /继续很可能直接失败/);
});

test('体积超窗但 CLI 自己会压缩的（blocks 为假）只提示，不标红也不拦', () => {
  const claude = sessionBudgetBadge({
    band: 'over',
    blocks: false,
    sizeBytes: 22_532_999,
    estTokens: 3_755_500,
    window: 1_000_000,
  });
  assert.equal(claude.level, 'long', '只提示的家不该标成红色危险');
  assert.equal(claude.text, '21.5MB');
  assert.match(claude.title, /自己会压缩上下文/);
  assert.doesNotMatch(claude.title, /继续很可能直接失败/);
});

test('拦截判据只认后端标的 blocks：体积超窗不等于拦', () => {
  assert.equal(sessionBudgetBlocks({ band: 'over', blocks: true }), true);
  assert.equal(sessionBudgetBlocks({ band: 'over' }), false, '缺 blocks 一律不拦');
  assert.equal(sessionBudgetBlocks({ band: 'over', blocks: false }), false);
  assert.equal(sessionBudgetBlocks({ band: 'long', blocks: true }), false, '没超窗也不会被标拦');
  assert.equal(sessionBudgetBlocks({}), false);
  assert.equal(sessionBudgetBlocks(null), false);
});

test('缺字段与脏字段一律归零，不抛错也不猜', () => {
  assert.deepEqual(
    normalizeSessionBudget(undefined),
    { sizeBytes: 0, estTokens: 0, window: 0, band: '', blocks: false },
  );
  assert.deepEqual(
    normalizeSessionBudget({ sizeBytes: -5, estTokens: 'x', window: null, band: 7, blocks: 'yes' }),
    { sizeBytes: 0, estTokens: 0, window: 0, band: '7', blocks: false },
  );
});
