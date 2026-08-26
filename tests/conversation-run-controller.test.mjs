import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodexRunController,
  createConversationRunController,
} from '../src/conversation-run-controller.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

test('连接中取消会等 start 注册完成，并且只调用一次后端取消', async () => {
  const startGate = deferred();
  const calls = [];
  const invoke = (command, payload) => {
    calls.push({ command, payload });
    return command === 'conversation_chat_start' ? startGate.promise : Promise.resolve();
  };
  const controller = createConversationRunController({ invoke });
  const request = {
    projectId: 'project-1',
    providerId: 'grok',
    runId: 'chat-1',
    threadId: '',
    prompt: '开始',
    allowWrite: false,
  };

  const start = controller.start(request);
  await controller.cancel('chat-1', { backendReady: false });
  assert.deepEqual(calls, [{ command: 'conversation_chat_start', payload: { request } }]);

  startGate.resolve();
  await start;
  assert.deepEqual(calls.at(-1), {
    command: 'conversation_chat_cancel',
    payload: { runId: 'chat-1' },
  });
  assert.equal(calls.filter(call => call.command === 'conversation_chat_cancel').length, 1);

  await controller.cancel('chat-1');
  assert.equal(calls.filter(call => call.command === 'conversation_chat_cancel').length, 1);
});

test('start 失败会清掉排队取消，不向未注册运行发送 cancel', async () => {
  const startGate = deferred();
  const calls = [];
  const invoke = (command, payload) => {
    calls.push({ command, payload });
    return command === 'conversation_chat_start' ? startGate.promise : Promise.resolve();
  };
  const controller = createConversationRunController({ invoke });
  const request = {
    projectId: 'project-1',
    providerId: 'claude',
    runId: 'chat-failed',
    threadId: '',
    prompt: '开始',
    allowWrite: false,
  };

  const start = controller.start(request);
  await controller.cancel('chat-failed', { backendReady: false });
  startGate.reject(new Error('启动失败'));
  await assert.rejects(start, /启动失败/);
  assert.equal(calls.filter(call => call.command === 'conversation_chat_cancel').length, 0);
});

test('排队取消失败不应把已启动的对话误报为启动失败', async () => {
  const calls = [];
  const controller = createConversationRunController({
    invoke(command, payload) {
      calls.push({ command, payload });
      if (command === 'conversation_chat_cancel') return Promise.reject(new Error('取消通道不可用'));
      return Promise.resolve();
    },
  });
  const request = { projectId: 'project-1', providerId: 'codex', runId: 'chat-cancel-failed', prompt: '开始' };
  const start = controller.start(request);
  await controller.cancel(request.runId, { backendReady: false });
  await start;
  assert.equal(calls.filter(call => call.command === 'conversation_chat_start').length, 1);
  assert.equal(calls.filter(call => call.command === 'conversation_chat_cancel').length, 1);
});

test('旧 Codex 控制器导出保留为通用控制器别名', () => {
  assert.equal(createCodexRunController, createConversationRunController);
});
