import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalInputBuffer } from '../src/terminal-input-buffer.js';

test('启动命令失败不能被随后成功的缓存输入掩盖', async () => {
  const buffer = createTerminalInputBuffer({ send: async data => {
    if (data === 'codex\r') throw new Error('写入失败');
  } });
  buffer.write('queued');
  assert.equal(await buffer.markReady('codex\r'), false);
});

test('PTY 就绪前的输入会在启动命令后按顺序发送', async () => {
  const sent = [];
  const buffer = createTerminalInputBuffer({
    send: async data => sent.push(data),
  });
  buffer.write('first');
  buffer.write(' second');
  await buffer.markReady('codex\r');
  buffer.write(' third');
  await buffer.markReady();
  assert.deepEqual(sent, ['codex\r', 'first second', ' third']);
});

test('PTY 创建失败会丢弃缓存且不再发送', async () => {
  const sent = [];
  const buffer = createTerminalInputBuffer({ send: async data => sent.push(data) });
  buffer.write('queued');
  buffer.markFailed();
  await buffer.markReady();
  buffer.write('late');
  assert.deepEqual(sent, []);
});

test('启动阶段缓存有上限并只报告一次溢出', async () => {
  const sent = [];
  let overflows = 0;
  const buffer = createTerminalInputBuffer({
    send: async data => sent.push(data),
    maxBufferedLength: 5,
    onOverflow: () => { overflows += 1; },
  });
  buffer.write('1234');
  buffer.write('567');
  buffer.write('89');
  await buffer.markReady();
  assert.deepEqual(sent, ['12345']);
  assert.equal(overflows, 1);
});

test('write 与 flush 会报告真实发送结果，而不是恒真', async () => {
  const failures = [];
  const sent = [];
  let failNext = false;
  const buffer = createTerminalInputBuffer({
    send: async data => {
      if (failNext) throw new Error('pty 写入失败');
      sent.push(data);
    },
    onError: error => failures.push(error.message),
  });
  assert.equal(buffer.write('queued'), true);
  assert.equal(buffer.write(''), false);
  await buffer.markReady();
  assert.deepEqual(sent, ['queued']);
  assert.equal(buffer.write('ok'), true);
  assert.equal(await buffer.flush(), true);
  failNext = true;
  assert.equal(buffer.write('boom'), true);
  assert.equal(await buffer.flush(), false, '发送失败必须让注入方知道');
  assert.deepEqual(failures, ['pty 写入失败']);
  failNext = false;
  buffer.write('again');
  assert.equal(await buffer.flush(), true);
  assert.deepEqual(sent, ['queued', 'ok', 'again']);
});

test('溢出截断或已失败时 write 返回 false，flush 也报 false', async () => {
  const overflowing = createTerminalInputBuffer({ send: async () => {}, maxBufferedLength: 3 });
  assert.equal(overflowing.write('abcd'), false);
  const failed = createTerminalInputBuffer({ send: async () => {} });
  failed.markFailed();
  assert.equal(failed.write('x'), false);
  assert.equal(await failed.flush(), false);
});
