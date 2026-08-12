import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalSessionCloseCoordinator } from '../src/terminal-session-close.js';

test('同一会话的并发关闭只调用一次后端和一次清理', async () => {
  let releaseBackend;
  let backendCalls = 0;
  let cleanupCalls = 0;
  const backend = new Promise(resolve => { releaseBackend = resolve; });
  const coordinator = createTerminalSessionCloseCoordinator({
    closeBackend: async () => { backendCalls++; await backend; },
    onClosed: () => { cleanupCalls++; },
  });

  const first = coordinator.close('session-a');
  assert.equal(coordinator.isClosing('session-a'), true);
  assert.equal(await coordinator.close('session-a'), false);
  releaseBackend();
  assert.equal(await first, true);
  assert.equal(coordinator.isClosing('session-a'), false);
  assert.equal(backendCalls, 1);
  assert.equal(cleanupCalls, 1);
});

test('后端关闭失败后解除锁定并允许重试', async () => {
  let attempts = 0;
  const errors = [];
  const coordinator = createTerminalSessionCloseCoordinator({
    closeBackend: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary');
    },
    onClosed: () => {},
    onError: error => errors.push(error.message),
  });

  assert.equal(await coordinator.close('session-a'), false);
  assert.equal(coordinator.isClosing('session-a'), false);
  assert.equal(await coordinator.close('session-a'), true);
  assert.deepEqual(errors, ['temporary']);
  assert.equal(attempts, 2);
});
